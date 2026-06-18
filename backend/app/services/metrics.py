"""Metrics computation service: resolvers, computers, and orchestration.

Concurrent compute for the same metric is NOT supported. The caller must
ensure that only one compute_metric() call runs at a time per metric_definition.
"""

import json
import logging
import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.metric import MetricDefinition, ComputedResult
from ..models.row_score import RowScore
# #381: recognized N/A strings (e.g. "N/A", "Don't know") are preserved as
# value_text but mean "missing" — exclude them from value_text-keyed computes
# (frequency, proportion) so they match the Data Quality tab's missing handling.
from .dataset_import import _is_na
# #384: shared grouping-value loader (excludes recognized N/A from group keys).
from .grouping import load_grouping_values, order_value_labels

# ── Rounding precision constants ─────────────────────────────────────────────
PERCENTAGE_PRECISION = 2   # round(x, 2) for percentage values (e.g. 85.71%)
STATS_PRECISION = 4        # round(x, 4) for proportions, means, and descriptive stats

# ── t-distribution critical values (two-tailed 95% CI, α=0.025 each tail) ────
# Precomputed t.ppf(0.975, df) for df 1..200 + ∞ (z=1.96).
# Avoids scipy dependency; uses linear interpolation for df > 200.
_T_CRIT_975: dict[int, float] = {
    1: 12.7062, 2: 4.3027, 3: 3.1824, 4: 2.7764, 5: 2.5706,
    6: 2.4469, 7: 2.3646, 8: 2.3060, 9: 2.2622, 10: 2.2281,
    11: 2.2010, 12: 2.1788, 13: 2.1604, 14: 2.1448, 15: 2.1314,
    16: 2.1199, 17: 2.1098, 18: 2.1009, 19: 2.0930, 20: 2.0860,
    25: 2.0595, 30: 2.0423, 35: 2.0301, 40: 2.0211, 45: 2.0141,
    50: 2.0086, 60: 2.0003, 70: 1.9944, 80: 1.9901, 90: 1.9867,
    100: 1.9840, 120: 1.9799, 150: 1.9759, 200: 1.9719,
}

_T_CRIT_SORTED_DFS = sorted(_T_CRIT_975.keys())
_Z_975 = 1.96  # Normal approximation for df → ∞


def _t_critical(df: int) -> float:
    """Return t-critical value for 95% CI (two-tailed) at given degrees of freedom.

    Uses lookup table with linear interpolation.  For df > 200, returns 1.96 (z).
    """
    if df <= 0:
        return float('inf')
    if df in _T_CRIT_975:
        return _T_CRIT_975[df]
    if df > 200:
        return _Z_975
    # Interpolate between two surrounding tabulated values
    lo = 1
    hi = 200
    for d in _T_CRIT_SORTED_DFS:
        if d <= df:
            lo = d
        if d >= df:
            hi = d
            break
    if lo == hi:
        return _T_CRIT_975[lo]
    frac = (df - lo) / (hi - lo)
    return _T_CRIT_975[lo] + frac * (_T_CRIT_975[hi] - _T_CRIT_975[lo])


def _ci_mean(mean_val: float, std_dev: float, n: int) -> dict | None:
    """Compute 95% CI for a mean using t-distribution. Returns None if n < 3."""
    if n < 3 or std_dev is None:
        return None
    se = std_dev / math.sqrt(n)
    t_crit = _t_critical(n - 1)
    margin = t_crit * se
    return {
        "ci_lower": round(mean_val - margin, STATS_PRECISION),
        "ci_upper": round(mean_val + margin, STATS_PRECISION),
        "ci_level": 0.95,
        "ci_method": "t_interval",
    }


def _ci_wilson(proportion: float, n: int) -> dict | None:
    """Compute 95% CI for a proportion using Wilson score interval.

    Returns bounds on the percentage scale (0-100). Returns None if n < 2.
    """
    if n < 2 or proportion is None:
        return None
    z = _Z_975
    p = proportion  # 0-1 scale
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    # Guard against negative radicand from floating point
    radicand = p * (1 - p) / n + z2 / (4 * n * n)
    if radicand < 0:
        radicand = 0.0
    margin = z * math.sqrt(radicand) / denom
    ci_lower = max(0.0, centre - margin) * 100
    ci_upper = min(1.0, centre + margin) * 100
    return {
        "ci_lower": round(ci_lower, PERCENTAGE_PRECISION),
        "ci_upper": round(ci_upper, PERCENTAGE_PRECISION),
        "ci_level": 0.95,
        "ci_method": "wilson",
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class ResolvedRow:
    row_id: int
    value_numeric: float | None
    value_text: str | None
    excluded: bool = False


def _parse_json(text: str | None) -> Any:
    """Safely parse a JSON text field, returning None on failure."""
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning("Failed to parse JSON field: %s — %s", text[:100], exc)
        return None


def _parse_exclude_values(metric_def: MetricDefinition) -> set[str]:
    """Parse exclude_values JSON into a lowercase set."""
    raw = _parse_json(metric_def.exclude_values)
    if not raw or not isinstance(raw, list):
        return set()
    return {str(v).lower() for v in raw}


COMPOSITE_SEPARATOR = " · "


def _build_composite_group_value(val1: str | None, val2: str | None) -> str | None:
    """Build composite group value from two dimension values.
    Uses COMPOSITE_SEPARATOR (' · ') between values, e.g. 'Male · Board Member'.
    Returns None if either dimension is None, excluding that record from
    composite groups (listwise deletion)."""
    if val1 is None or val2 is None:
        return None
    return f"{val1}{COMPOSITE_SEPARATOR}{val2}"


def _compare(value: float, operator: str, threshold: float) -> bool:
    """Evaluate a numeric comparison."""
    if operator == ">":
        return value > threshold
    elif operator == ">=":
        return value >= threshold
    elif operator == "<":
        return value < threshold
    elif operator == "<=":
        return value <= threshold
    elif operator in ("==", "="):
        return value == threshold
    return False


# ═══════════════════════════════════════════════════════════════════════════════
# Config validation (internal Pydantic models)
# ═══════════════════════════════════════════════════════════════════════════════

VALID_OPERATORS = {">", ">=", "<", "<=", "==", "="}
VALID_CHILD_METRIC_TYPES = {"proportion", "mean"}
VALID_AGGREGATIONS = {"mean"}


class _ProportionConfig(BaseModel):
    mode: str  # "values" or "numeric"
    threshold_values: list[str] | None = None
    operator: str | None = None
    threshold_numeric: float | None = None

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v: str) -> str:
        if v not in ("values", "numeric"):
            raise ValueError("mode must be 'values' or 'numeric'")
        return v


class _DomainAggregateConfig(BaseModel):
    child_metric_type: str
    child_config: dict
    aggregation: str = "mean"

    @field_validator("child_metric_type")
    @classmethod
    def validate_child_type(cls, v: str) -> str:
        if v not in VALID_CHILD_METRIC_TYPES:
            raise ValueError(f"child_metric_type must be one of {sorted(VALID_CHILD_METRIC_TYPES)}")
        return v

    @field_validator("aggregation")
    @classmethod
    def validate_aggregation(cls, v: str) -> str:
        if v not in VALID_AGGREGATIONS:
            raise ValueError(f"aggregation must be one of {sorted(VALID_AGGREGATIONS)}")
        return v


def validate_metric_config(metric_type: str, config: dict) -> list[str]:
    """Validate metric config, returning a list of error strings (empty = valid)."""
    errors: list[str] = []

    if metric_type == "frequency_distribution":
        # No config fields required
        pass

    elif metric_type == "proportion":
        try:
            pc = _ProportionConfig(**config)
        except (TypeError, ValueError) as e:
            return [str(e)]

        if pc.mode == "values":
            if not pc.threshold_values or len(pc.threshold_values) == 0:
                errors.append("Select at least one response to count")
        elif pc.mode == "numeric":
            if pc.operator is None:
                errors.append("operator is required for mode='numeric'")
            elif pc.operator not in VALID_OPERATORS:
                errors.append(f"operator must be one of {sorted(VALID_OPERATORS)}")
            if pc.threshold_numeric is None:
                errors.append("threshold_numeric is required for mode='numeric'")

    elif metric_type == "mean":
        # No config fields required
        pass

    elif metric_type == "domain_aggregate":
        try:
            da = _DomainAggregateConfig(**config)
        except (TypeError, ValueError) as e:
            return [str(e)]

        # Recursively validate child config
        child_errors = validate_metric_config(da.child_metric_type, da.child_config)
        for err in child_errors:
            errors.append(f"child_config: {err}")

    else:
        errors.append(f"Unknown metric_type: {metric_type}")

    return errors


# ═══════════════════════════════════════════════════════════════════════════════
# Source existence check
# ═══════════════════════════════════════════════════════════════════════════════


def _normalize_metric_key(
    metric_type: str,
    input_source_type: str,
    input_source_id: int,
    grouping_column_id: int | None,
    exclude_values: list[str] | None,
    config: dict,
    grouping_mode: str | None = None,
    grouping_column_id_2: int | None = None,
) -> tuple:
    """Produce a canonical tuple for metric identity comparison."""
    norm_config = json.dumps(config, sort_keys=True) if config else "{}"
    norm_exclude = tuple(sorted(str(v).lower() for v in (exclude_values or [])))
    return (
        metric_type,
        input_source_type,
        input_source_id,
        grouping_column_id,
        norm_exclude,
        norm_config,
        grouping_mode or "column",
        grouping_column_id_2,
    )


def find_or_create_metric(
    db: Session,
    project_id: int,
    source_type: str,
    source_id: int,
    metric_type: str,
    config: dict,
    grouping_column_id: int | None = None,
    grouping_column_id_2: int | None = None,
    exclude_values: list[str] | None = None,
    grouping_mode: str | None = None,
) -> tuple[MetricDefinition, bool]:
    """Find an existing MetricDefinition or create a new one.

    Returns (metric, is_new).
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    target_key = _normalize_metric_key(
        metric_type, source_type, source_id,
        grouping_column_id, exclude_values, config,
        grouping_mode, grouping_column_id_2,
    )

    # Query candidates by indexed columns
    candidates = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.metric_type == metric_type,
            MetricDefinition.input_source_type == source_type,
            MetricDefinition.input_source_id == source_id,
        )
        .all()
    )

    for candidate in candidates:
        cand_config = _parse_json(candidate.config) or {}
        cand_exclude = _parse_json(candidate.exclude_values) or []
        cand_key = _normalize_metric_key(
            candidate.metric_type,
            candidate.input_source_type,
            candidate.input_source_id,
            candidate.grouping_column_id,
            cand_exclude,
            cand_config,
            candidate.grouping_mode,
            candidate.grouping_column_id_2,
        )
        if cand_key == target_key:
            candidate.last_accessed_at = now
            return candidate, False

    # Not found — create
    config_json = json.dumps(config)
    exclude_json = json.dumps(exclude_values) if exclude_values else None

    # Auto-name from source
    name = _auto_name_metric(db, source_type, source_id, metric_type)

    # Auto-assign sequence_order
    from sqlalchemy import func as sa_func
    max_order = (
        db.query(sa_func.max(MetricDefinition.sequence_order))
        .filter(MetricDefinition.project_id == project_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    metric = MetricDefinition(
        project_id=project_id,
        name=name,
        metric_type=metric_type,
        config=config_json,
        input_source_type=source_type,
        input_source_id=source_id,
        grouping_column_id=grouping_column_id,
        grouping_column_id_2=grouping_column_id_2,
        grouping_mode=grouping_mode,
        exclude_values=exclude_json,
        sequence_order=next_order,
        origin="auto",
        origin_context="quick-compute",
        last_accessed_at=now,
    )
    db.add(metric)
    db.flush()
    return metric, True


def _auto_name_metric(
    db: Session, source_type: str, source_id: int, metric_type: str,
) -> str:
    """Generate a name for an auto-created metric."""
    type_label = {
        "frequency_distribution": "Freq. Dist.",
        "proportion": "Proportion",
        "mean": "Mean",
        "domain_aggregate": "Domain Agg.",
    }.get(metric_type, metric_type)

    if source_type == "dataset_column":
        col = db.query(DatasetColumn).filter(DatasetColumn.id == source_id).first()
        if col:
            source_label = col.column_name or col.column_text or f"Column {source_id}"
            # Truncate to keep name reasonable
            if len(source_label) > 60:
                source_label = source_label[:57] + "..."
            return f"{type_label}: {source_label}"
    elif source_type == "dataset_domain":
        domain = db.query(AnalysisDomain).filter(AnalysisDomain.id == source_id).first()
        if domain:
            return f"{type_label}: {domain.name}"

    return f"{type_label}: Source {source_id}"


def _check_source_exists(
    db: Session, project_id: int, source_type: str, source_id: int,
) -> str | None:
    """Check that the referenced source exists. Returns error string or None."""
    if source_type == "dataset_column":
        col = (
            db.query(DatasetColumn.id)
            .join(Dataset)
            .filter(
                DatasetColumn.id == source_id,
                Dataset.project_id == project_id,
            )
            .first()
        )
        if not col:
            return f"Dataset column {source_id} not found in project"

    elif source_type == "dataset_domain":
        domain = (
            db.query(AnalysisDomain.id)
            .filter(
                AnalysisDomain.id == source_id,
                AnalysisDomain.project_id == project_id,
            )
            .first()
        )
        if not domain:
            return f"Analysis domain {source_id} not found in project"

    else:
        return f"Unknown input_source_type: {source_type}"

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Resolvers — load raw data from the database
# ═══════════════════════════════════════════════════════════════════════════════


def resolve_dataset_column(
    metric_def: MetricDefinition, db: Session,
) -> dict[str | None, list[ResolvedRow]]:
    """Resolve values for a single dataset column, optionally grouped.

    Returns dict mapping group_value (None for ungrouped) to list of ResolvedRow.
    """
    excludes = _parse_exclude_values(metric_def)
    column_id = metric_def.input_source_id

    # Load all values for this column
    values = (
        db.query(
            DatasetValue.row_id,
            DatasetValue.value_numeric,
            DatasetValue.value_text,
        )
        .filter(DatasetValue.column_id == column_id)
        .all()
    )

    # Build row_id -> row mapping
    rows_by_response: dict[int, ResolvedRow] = {}
    for row_id, val_num, val_text in values:
        excluded = bool(val_text and val_text.strip().lower() in excludes)
        rows_by_response[row_id] = ResolvedRow(
            row_id=row_id,
            value_numeric=val_num,
            value_text=val_text,
            excluded=excluded,
        )

    # If no grouping, return single group
    if metric_def.grouping_column_id is None:
        return {None: list(rows_by_response.values())}

    if not rows_by_response:
        return {}

    # Load grouping column values (#384: recognized N/A excluded → those rows
    # fold into the None/listwise-deletion group, same as a truly-missing value).
    row_ids = list(rows_by_response.keys())
    response_to_group1 = load_grouping_values(db, metric_def.grouping_column_id, row_ids)

    # If composite grouping, load second dimension
    if metric_def.grouping_column_id_2 is not None:
        response_to_group2 = load_grouping_values(db, metric_def.grouping_column_id_2, row_ids)

        # Build composite group map — records missing a value in either
        # dimension get group_value=None (listwise deletion from composite groups)
        response_to_group = {}
        for r_id in rows_by_response:
            val1 = response_to_group1.get(r_id)
            val2 = response_to_group2.get(r_id)
            response_to_group[r_id] = _build_composite_group_value(val1, val2)
    else:
        response_to_group = response_to_group1

    group_map: dict[str | None, list[ResolvedRow]] = {}
    for row_id, row in rows_by_response.items():
        group_val = response_to_group.get(row_id)
        if group_val not in group_map:
            group_map[group_val] = []
        group_map[group_val].append(row)

    return group_map


def _resolve_grouping_siblings(
    db: Session,
    anchor_column_id: int,
    domain_column_ids: list[int],
    _cache: dict | None = None,
) -> list[int]:
    """Find matching demographic columns across datasets in a domain.

    Given an anchor grouping column and the domain's member column IDs,
    finds sibling demographic columns in other datasets using 3-tier matching:
      1. Same equivalence_group_id (explicitly linked by user)
      2. Same demographic_subtype (e.g., both "role")
      3. Same column_name case-insensitive (e.g., both "Role")

    Each dataset gets at most one match (first tier wins).
    Returns list of all column IDs (anchor + siblings).

    Optional _cache dict avoids repeated DB queries for the same
    anchor + domain combination within a compute_all_for_project batch.
    """
    if _cache is not None:
        cache_key = (anchor_column_id, tuple(sorted(domain_column_ids)))
        if cache_key in _cache:
            return _cache[cache_key]

    from ..models.dataset import ColumnType

    # Load anchor column metadata
    anchor = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id == anchor_column_id)
        .first()
    )
    if not anchor:
        return [anchor_column_id]

    # Find all dataset IDs that own the domain's columns
    domain_dataset_rows = (
        db.query(DatasetColumn.dataset_id)
        .filter(DatasetColumn.id.in_(domain_column_ids))
        .distinct()
        .all()
    )
    domain_dataset_ids = {row[0] for row in domain_dataset_rows}

    # Remove anchor's own dataset — we already have it
    domain_dataset_ids.discard(anchor.dataset_id)
    if not domain_dataset_ids:
        return [anchor_column_id]

    # Load all demographic columns from the other datasets in this domain
    other_demographics = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id.in_(domain_dataset_ids),
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
        )
        .all()
    )

    if not other_demographics:
        return [anchor_column_id]

    # Match: one column per dataset, first tier wins
    matched: dict[int, int] = {}  # dataset_id -> column_id

    # Tier 1: Same equivalence_group_id.
    # Assumes 1:1 column-per-dataset within an equivalence group — enforced
    # at the schema level (a partial unique index in the baseline migration) and validated at the
    # router layer. Under the 1:1 invariant the `not in matched` guard is
    # always true for same-group siblings; it remains as belt-and-suspenders
    # against a hypothetical schema bypass.
    if anchor.equivalence_group_id is not None:
        for col in other_demographics:
            if col.dataset_id not in matched and col.equivalence_group_id == anchor.equivalence_group_id:
                matched[col.dataset_id] = col.id

    # Tier 2: Same demographic_subtype
    if anchor.demographic_subtype:
        anchor_subtype = anchor.demographic_subtype.lower()
        for col in other_demographics:
            if col.dataset_id not in matched and col.demographic_subtype and col.demographic_subtype.lower() == anchor_subtype:
                matched[col.dataset_id] = col.id

    # Tier 3: Same column_name case-insensitive
    anchor_name = (anchor.column_name or "").strip().lower()
    if anchor_name:
        for col in other_demographics:
            if col.dataset_id not in matched and col.column_name and col.column_name.strip().lower() == anchor_name:
                matched[col.dataset_id] = col.id

    result = [anchor_column_id] + list(matched.values())
    if _cache is not None:
        _cache[cache_key] = result
    return result


@dataclass
class DecomposeResult:
    """One sub-source from decomposing a domain into equivalence groups."""
    column_ids: list[int]
    label: str
    domain_id: int


def decompose_domain_sources(
    db: Session, domain_id: int,
) -> list[DecomposeResult]:
    """Decompose a domain into sub-sources grouped by equivalence group.

    Columns sharing the same non-null equivalence_group_id form one group.
    Columns with no equivalence group become individual groups.
    Returns sorted by label.
    """
    members = (
        db.query(AnalysisDomainMember)
        .filter(
            AnalysisDomainMember.domain_id == domain_id,
            AnalysisDomainMember.member_type == "column",
        )
        .all()
    )
    if not members:
        return []

    member_col_ids = [m.member_id for m in members]

    # Load column metadata + dataset name
    col_rows = (
        db.query(
            DatasetColumn.id,
            DatasetColumn.equivalence_group_id,
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.name,
        )
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id.in_(member_col_ids))
        .order_by(Dataset.name, DatasetColumn.id)
        .all()
    )

    # Group by equivalence_group_id
    equiv_groups: dict[int, list] = {}  # equiv_group_id -> [(col_id, col_name, col_text, ds_name)]
    unlinked: list[tuple] = []  # [(col_id, col_name, col_text, ds_name)]

    for col_id, equiv_id, col_name, col_text, ds_name in col_rows:
        entry = (col_id, col_name, col_text, ds_name)
        if equiv_id is not None:
            equiv_groups.setdefault(equiv_id, []).append(entry)
        else:
            unlinked.append(entry)

    results: list[DecomposeResult] = []

    for _equiv_id, entries in equiv_groups.items():
        column_ids = [e[0] for e in entries]
        # Use column_name of first entry (ordered by dataset name), fallback to column_text
        label = entries[0][1] or entries[0][2] or f"Column {entries[0][0]}"
        results.append(DecomposeResult(
            column_ids=column_ids,
            label=label,
            domain_id=domain_id,
        ))

    for col_id, col_name, col_text, ds_name in unlinked:
        label = col_name or col_text or f"Column {col_id}"
        results.append(DecomposeResult(
            column_ids=[col_id],
            label=label,
            domain_id=domain_id,
        ))

    results.sort(key=lambda r: r.label.lower())
    return results


def _assert_eg_one_column_per_dataset(
    db: Session, domain_id: int, member_col_ids: list[int]
) -> None:
    """Runtime defense-in-depth for #289 (1:1 per dataset within EG).

    The 1:1-per-dataset rule is enforced at three layers: (1) the partial
    unique index `ix_equivalence_unique_column_per_dataset` in the baseline
    migration, (2) router-layer validators in `routers/equivalence.py`,
    (3) UI hard-disable on the crosswalk move-members and Suggest accept paths.

    This is the runtime safety net (#294): if all three router layers and
    the schema index are bypassed (direct ORM edits in a future refactor,
    a migration that temporarily violates, or a raw-SQL fix that doesn't
    enable PRAGMA foreign_keys), this catch fires when the metric tries
    to compute. Mirrors the `_assert_domain_members_paired` pattern for
    #290.

    If this ever fires, an upstream layer was bypassed — the error message
    surfaces the offending EG and the dataset whose duplicate columns
    triggered it so root cause is findable.
    """
    if not member_col_ids:
        return
    cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id.in_(member_col_ids))
        .all()
    )
    # eg_id → dataset_id → list of column IDs
    eg_to_ds_cols: dict[int, dict[int, list[int]]] = {}
    for c in cols:
        if c.equivalence_group_id is None:
            continue
        eg_to_ds_cols.setdefault(c.equivalence_group_id, {}).setdefault(
            c.dataset_id, []
        ).append(c.id)
    bad: list[dict] = []
    for eg_id, ds_map in eg_to_ds_cols.items():
        for ds_id, col_ids in ds_map.items():
            if len(col_ids) > 1:
                bad.append({
                    "equivalence_group_id": eg_id,
                    "dataset_id": ds_id,
                    "column_ids": col_ids,
                })
    if bad:
        raise ValueError(
            f"AnalysisDomain {domain_id} contains an equivalence group with "
            f"multiple columns from the same dataset (#289). "
            f"Violations: {bad}. This should have been blocked at the schema "
            f"layer (partial unique index `ix_equivalence_unique_column_per_dataset`) "
            f"or by router validators. If you see this, an upstream layer was "
            f"bypassed — investigate before ignoring."
        )


def _assert_domain_members_paired(
    db: Session, domain_id: int, member_col_ids: list[int]
) -> None:
    """Runtime defense-in-depth for #290.

    Refuse to compute on a cross-dataset AnalysisDomain whose members
    aren't fully linked via equivalence groups. Placed in the single
    entry point for domain resolution (resolve_dataset_domain) so it
    covers metric computation AND statistical tests (which resolve
    through the same function via `_ResolverProxy` in statistical_tests.py).

    If this ever fires, a router-layer validator was bypassed — either
    via direct ORM edit, a future refactor that drops the validator, or
    a migration that temporarily violates the invariant. The error
    message should make the bypass visible so root cause can be found.
    """
    if not member_col_ids:
        return
    cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id.in_(member_col_ids))
        .all()
    )
    datasets = {c.dataset_id for c in cols}
    if len(datasets) < 2:
        return
    eg_to_datasets: dict[int, set[int]] = {}
    for c in cols:
        if c.equivalence_group_id is not None:
            eg_to_datasets.setdefault(c.equivalence_group_id, set()).add(c.dataset_id)
    bad: list[int] = []
    for c in cols:
        if c.equivalence_group_id is None:
            bad.append(c.id)
            continue
        if not (eg_to_datasets.get(c.equivalence_group_id, set()) - {c.dataset_id}):
            bad.append(c.id)
    if bad:
        raise ValueError(
            f"AnalysisDomain {domain_id} violates the cross-dataset pairing "
            f"invariant (#290). Unpaired cross-dataset members: {bad}. "
            f"This should have been blocked at the router layer. If you see "
            f"this, a validator was bypassed — investigate before ignoring."
        )


def _assert_domain_members_numeric_eligible(
    db: Session, domain_id: int, member_col_ids: list[int]
) -> None:
    """Runtime defense-in-depth for #350.

    Refuse to compute a `domain_aggregate` metric on an AnalysisDomain whose
    members are ALL of a non-numeric column type. Without this guard, the
    aggregate silently produces `valid_n=0` across every row (see #350 repro).

    Router-layer `assert_domain_members_numeric_eligible` in
    `services/equivalence_validators.py` blocks this at create time for all
    known create paths (`create_score_metric`, `create_metric`,
    `bulk_create_metrics`, `quick_compute`). This runtime check fires only if
    a path bypassed pre-validation — a future refactor, raw SQL edit, or
    `.mmproject` import of a legacy file produced by a pre-fix version.

    Empty list: silent pass. Mixed (≥1 numeric-eligible) members: silent
    pass — the aggregate drops non-numeric rows at compute time, which is
    the intended fallback.

    Numeric-eligible types: see SCALE_SCORE_ELIGIBLE_TYPES (ORDINAL, NUMERIC,
    PERCENTAGE) — the single source of truth in models/dataset.py (#399).
    """
    from ..models.dataset import SCALE_SCORE_ELIGIBLE_TYPES

    if not member_col_ids:
        return
    cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id.in_(member_col_ids))
        .all()
    )
    if not cols:
        return
    has_numeric = any(
        c.column_type in SCALE_SCORE_ELIGIBLE_TYPES
        for c in cols
    )
    if has_numeric:
        return
    type_summary = sorted({
        (c.column_type.value if hasattr(c.column_type, "value") else str(c.column_type))
        for c in cols
    })
    raise ValueError(
        f"AnalysisDomain {domain_id} cannot produce a scale-score aggregate: "
        f"all {len(cols)} members are of non-numeric types ({', '.join(type_summary)}). "
        f"This should have been blocked at the router layer (#350). "
        f"If you see this, a validator was bypassed — investigate before ignoring."
    )


def resolve_dataset_domain(
    metric_def: MetricDefinition, db: Session,
    _sibling_cache: dict | None = None,
) -> dict[int, dict[str | None, list[ResolvedRow]]]:
    """Resolve values for all columns in an analysis domain.

    Uses batch 5-query approach for efficiency.
    Returns dict mapping column_id to grouped ResolvedRows.
    """
    excludes = _parse_exclude_values(metric_def)
    domain_id = metric_def.input_source_id

    # Query 1: Load domain members
    members = (
        db.query(AnalysisDomainMember)
        .filter(AnalysisDomainMember.domain_id == domain_id)
        .all()
    )

    if not members:
        return {}

    # Expand members to column IDs (all members are now column type)
    direct_column_ids: set[int] = set()

    for m in members:
        if m.member_type == "column":
            direct_column_ids.add(m.member_id)

    all_column_ids = list(direct_column_ids)
    if not all_column_ids:
        return {}

    # Runtime enforcement of the #290 cross-dataset pairing invariant.
    # Validator bypass → ValueError with a descriptive message.
    _assert_domain_members_paired(db, domain_id, all_column_ids)

    # Runtime enforcement of the #289 1:1-per-dataset invariant (#294).
    # Defense-in-depth for the partial unique index — fires if a future
    # refactor or direct DB edit bypasses the schema-level constraint.
    _assert_eg_one_column_per_dataset(db, domain_id, all_column_ids)

    # Runtime defense-in-depth for #350. Refuse to compute domain_aggregate
    # over a domain whose members are all non-numeric (nominal/binary/text/
    # demographic), which would silently produce `valid_n=0`. Router-layer
    # `assert_domain_members_numeric_eligible` blocks this at create time;
    # this fires only if a future refactor, raw SQL edit, or import path
    # bypasses pre-creation validation. Scope: only for `MetricDefinition`
    # callers with `metric_type == 'domain_aggregate'`. The
    # `statistical_tests._ResolverProxy` caller (Cronbach's alpha, split-half)
    # has no `metric_type` field — it gets `None` via getattr and is skipped.
    # `mean`/`frequency` metrics on the same domain are also skipped (those
    # metric types silently drop non-numeric rows by design, which is the
    # correct fallback for them).
    if getattr(metric_def, "metric_type", None) == "domain_aggregate":
        _assert_domain_members_numeric_eligible(db, domain_id, all_column_ids)

    # If decompose_column_ids is set in config, filter to that subset
    config = _parse_json(metric_def.config) or {}
    decompose_col_ids = config.get("decompose_column_ids")
    if decompose_col_ids:
        allowed = set(decompose_col_ids)
        all_column_ids = [cid for cid in all_column_ids if cid in allowed]
        if not all_column_ids:
            return {}

    # Query 3: Load ALL DatasetValues for all columns at once
    all_values = (
        db.query(
            DatasetValue.column_id,
            DatasetValue.row_id,
            DatasetValue.value_numeric,
            DatasetValue.value_text,
        )
        .filter(DatasetValue.column_id.in_(all_column_ids))
        .all()
    )

    # Query 4: Load ALL primary RecodeDefinitions for exclude_values
    # (we don't actually need recode defs for the metric's own exclude_values —
    #  the metric's exclude_values field is already parsed above)

    # Query 5: Load grouping values
    grouping_response_map: dict[int, str | None] = {}
    col_to_dataset_name: dict[int, str] = {}

    if metric_def.grouping_mode == "dataset":
        # Group by dataset: map each column to its parent dataset name
        col_dataset_rows = (
            db.query(DatasetColumn.id, Dataset.name)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(DatasetColumn.id.in_(all_column_ids))
            .all()
        )
        col_to_dataset_name = {cid: dname for cid, dname in col_dataset_rows}
    elif metric_def.grouping_column_id is not None:
        # Group by demographic column — resolve sibling columns across datasets
        grouping_col_ids = _resolve_grouping_siblings(
            db, metric_def.grouping_column_id, all_column_ids,
            _cache=_sibling_cache,
        )
        all_row_ids = list({v[1] for v in all_values})
        if all_row_ids:
            grouping_values = (
                db.query(DatasetValue.row_id, DatasetValue.value_text)
                .filter(
                    DatasetValue.column_id.in_(grouping_col_ids),
                    DatasetValue.row_id.in_(all_row_ids),
                )
                .all()
            )
            grouping_response_map_1 = {r_id: val for r_id, val in grouping_values}

            if metric_def.grouping_column_id_2 is not None:
                # Composite grouping: resolve second dimension siblings
                grouping_col_ids_2 = _resolve_grouping_siblings(
                    db, metric_def.grouping_column_id_2, all_column_ids,
                    _cache=_sibling_cache,
                )
                grouping_values_2 = (
                    db.query(DatasetValue.row_id, DatasetValue.value_text)
                    .filter(
                        DatasetValue.column_id.in_(grouping_col_ids_2),
                        DatasetValue.row_id.in_(all_row_ids),
                    )
                    .all()
                )
                grouping_response_map_2 = {r_id: val for r_id, val in grouping_values_2}

                # Build composite map
                for r_id in all_row_ids:
                    val1 = grouping_response_map_1.get(r_id)
                    val2 = grouping_response_map_2.get(r_id)
                    composite = _build_composite_group_value(val1, val2)
                    if composite is not None:
                        grouping_response_map[r_id] = composite
            else:
                grouping_response_map = grouping_response_map_1

    # Partition in Python: column_id -> group_value -> list[ResolvedRow]
    result: dict[int, dict[str | None, list[ResolvedRow]]] = {}

    for col_id, row_id, val_num, val_text in all_values:
        excluded = bool(val_text and val_text.strip().lower() in excludes)
        row = ResolvedRow(
            row_id=row_id,
            value_numeric=val_num,
            value_text=val_text,
            excluded=excluded,
        )

        if col_id not in result:
            result[col_id] = {}

        if metric_def.grouping_mode == "dataset":
            group_val = col_to_dataset_name.get(col_id)
        elif metric_def.grouping_column_id is None:
            group_val = None
        else:
            group_val = grouping_response_map.get(row_id)

        if group_val not in result[col_id]:
            result[col_id][group_val] = []
        result[col_id][group_val].append(row)

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Computers — produce result_data dicts
# ═══════════════════════════════════════════════════════════════════════════════


def compute_frequency_distribution(
    rows: list[ResolvedRow],
    scale_labels: list[str] | None = None,
) -> tuple[dict, int, int]:
    """Compute frequency distribution.

    Returns (result_data, valid_n, total_n).
    result_data: {counts: {label: n}, percentages: {label: float}, scale_order: [...]}
    """
    total_n = len(rows)
    # #381: exclude recognized N/A value_text (is-not-None short-circuits before _is_na)
    valid_rows = [
        r for r in rows
        if not r.excluded and r.value_text is not None and not _is_na(r.value_text)
    ]
    valid_n = len(valid_rows)

    counts: dict[str, int] = {}
    for r in valid_rows:
        key = r.value_text.strip() if r.value_text else ""
        counts[key] = counts.get(key, 0) + 1

    # Determine sort order (#406: numeric labels order numerically, via the
    # shared order_value_labels — scale_labels, when present, still win)
    if scale_labels:
        order = list(scale_labels)
        # Add any values not in scale_labels
        for key in order_value_labels(counts.keys()):
            if key not in order:
                order.append(key)
    else:
        order = order_value_labels(counts.keys())

    # Compute percentages
    percentages: dict[str, float | None] = {}
    for key in order:
        c = counts.get(key, 0)
        percentages[key] = round(c / valid_n * 100, PERCENTAGE_PRECISION) if valid_n > 0 else None

    # Ensure all order keys appear in counts
    for key in order:
        if key not in counts:
            counts[key] = 0

    result_data = {
        "counts": counts,
        "percentages": percentages,
        "scale_order": order,
    }
    return result_data, valid_n, total_n


def compute_proportion(
    rows: list[ResolvedRow], config: dict,
) -> tuple[dict, int, int]:
    """Compute proportion of values meeting criteria.

    Returns (result_data, valid_n, total_n).
    result_data: {count_meeting: int, proportion: float|null, percentage: float|null}
    """
    total_n = len(rows)
    valid_rows = [r for r in rows if not r.excluded]
    mode = config.get("mode", "values")

    if mode == "values":
        threshold_values = {v.lower() for v in (config.get("threshold_values") or [])}
        # Filter to rows with non-null text for valid count.
        # #381: exclude recognized N/A so it doesn't inflate the denominator.
        countable = [
            r for r in valid_rows
            if r.value_text is not None and not _is_na(r.value_text)
        ]
        valid_n = len(countable)
        count_meeting = sum(
            1 for r in countable
            if r.value_text.strip().lower() in threshold_values
        )
    else:  # numeric
        operator = config.get("operator", ">=")
        threshold_numeric = config.get("threshold_numeric", 0)
        # Filter to rows with non-null numeric values
        countable = [r for r in valid_rows if r.value_numeric is not None]
        valid_n = len(countable)
        count_meeting = sum(
            1 for r in countable
            if _compare(r.value_numeric, operator, threshold_numeric)
        )

    if valid_n == 0:
        proportion = None
        percentage = None
    else:
        proportion = round(count_meeting / valid_n, STATS_PRECISION)
        percentage = round(proportion * 100, PERCENTAGE_PRECISION)

    # Confidence interval (Wilson score)
    ci = _ci_wilson(proportion, valid_n) if proportion is not None else None

    result_data = {
        "count_meeting": count_meeting,
        "proportion": proportion,
        "percentage": percentage,
    }
    if ci:
        result_data.update(ci)
    else:
        result_data.update({"ci_lower": None, "ci_upper": None, "ci_level": 0.95, "ci_method": "wilson"})

    return result_data, valid_n, total_n


def compute_mean(rows: list[ResolvedRow]) -> tuple[dict, int, int]:
    """Compute descriptive statistics (mean, median, std_dev, min, max).

    Returns (result_data, valid_n, total_n).
    """
    total_n = len(rows)
    valid_rows = [r for r in rows if not r.excluded and r.value_numeric is not None]
    valid_n = len(valid_rows)

    if valid_n == 0:
        result_data = {
            "mean": None,
            "median": None,
            "std_dev": None,
            "min": None,
            "max": None,
        }
        return result_data, valid_n, total_n

    values = [r.value_numeric for r in valid_rows]
    mean_val = round(statistics.mean(values), STATS_PRECISION)
    median_val = round(statistics.median(values), STATS_PRECISION)
    min_val = round(min(values), STATS_PRECISION)
    max_val = round(max(values), STATS_PRECISION)

    # n=1: std_dev is undefined (statistics.stdev raises StatisticsError)
    if valid_n >= 2:
        std_dev_val = round(statistics.stdev(values), STATS_PRECISION)
    else:
        std_dev_val = None

    result_data = {
        "mean": mean_val,
        "median": median_val,
        "std_dev": std_dev_val,
        "min": min_val,
        "max": max_val,
    }

    # Confidence interval
    ci = _ci_mean(mean_val, std_dev_val, valid_n) if std_dev_val is not None else None
    if ci:
        result_data.update(ci)
    else:
        result_data.update({"ci_lower": None, "ci_upper": None, "ci_level": 0.95, "ci_method": "t_interval"})

    return result_data, valid_n, total_n


def compute_domain_aggregate(
    column_groups: dict[int, dict[str | None, list[ResolvedRow]]],
    config: dict,
) -> tuple[dict, int, int]:
    """Compute domain aggregate across multiple columns.

    Returns (result_data, valid_n, total_n).
    result_data: {aggregate_value: float|null, child_results: {col_id: {...}}, column_count: int, aggregation: str}
    """
    child_metric_type = config.get("child_metric_type", "mean")
    child_config = config.get("child_config", {})
    aggregation = config.get("aggregation", "mean")

    child_results: dict[str, dict] = {}
    scalars: list[float] = []
    total_valid = 0
    total_total = 0

    for col_id, group_map in column_groups.items():
        # For domain aggregate, we use the ungrouped data (None key)
        rows = group_map.get(None, [])
        if not rows:
            continue

        if child_metric_type == "proportion":
            result_data, valid_n, total_n = compute_proportion(rows, child_config)
            scalar = result_data.get("percentage")
        elif child_metric_type == "mean":
            result_data, valid_n, total_n = compute_mean(rows)
            scalar = result_data.get("mean")
        else:
            continue

        child_results[str(col_id)] = {
            **result_data,
            "valid_n": valid_n,
            "total_n": total_n,
        }
        if scalar is not None:
            scalars.append(scalar)
        total_valid += valid_n
        total_total += total_n

    # Aggregate
    if scalars:
        aggregate_value = round(statistics.mean(scalars), STATS_PRECISION)
    else:
        aggregate_value = None

    # CI for the aggregate: treat k column-level scalars as a sample (item-level t)
    ci_data: dict = {"ci_lower": None, "ci_upper": None, "ci_level": 0.95, "ci_method": "item_level_t"}
    k = len(scalars)
    if k >= 3 and aggregate_value is not None:
        item_sd = statistics.stdev(scalars)
        ci = _ci_mean(aggregate_value, item_sd, k)
        if ci:
            ci_data = ci

    result_data = {
        "aggregate_value": aggregate_value,
        "child_results": child_results,
        "column_count": len(column_groups),
        "aggregation": aggregation,
        **ci_data,
    }
    return result_data, total_valid, total_total


# ═══════════════════════════════════════════════════════════════════════════════
# Per-record scoring
# ═══════════════════════════════════════════════════════════════════════════════

MISSING_ITEM_THRESHOLD = 0.5  # record must have ≥50% valid items


def _score_single_row(
    metric_type: str, row: ResolvedRow, config: dict,
) -> float | None:
    """Compute a single record's score for a column-level metric.

    Returns None if the record is excluded or has missing data.
    """
    if row.excluded:
        return None

    if metric_type == "mean":
        return row.value_numeric  # None if null

    if metric_type == "proportion":
        mode = config.get("mode", "values")
        if mode == "values":
            if row.value_text is None:
                return None
            threshold_values = {v.lower() for v in (config.get("threshold_values") or [])}
            return 1.0 if row.value_text.strip().lower() in threshold_values else 0.0
        else:  # numeric
            if row.value_numeric is None:
                return None
            operator = config.get("operator", ">=")
            threshold_numeric = config.get("threshold_numeric", 0)
            return 1.0 if _compare(row.value_numeric, operator, threshold_numeric) else 0.0

    return None


def _score_domain_row(
    child_metric_type: str,
    child_config: dict,
    items: list[ResolvedRow],
    total_columns: int,
    missing_threshold: float = MISSING_ITEM_THRESHOLD,
) -> float | None:
    """Compute a domain-level score for one record.

    items: list of ResolvedRow for this record across domain columns.
    total_columns: total columns in domain (for threshold check).
    Returns None if too many items are missing.
    """
    valid_scores: list[float] = []
    for row in items:
        s = _score_single_row(child_metric_type, row, child_config)
        if s is not None:
            valid_scores.append(s)

    if total_columns == 0 or len(valid_scores) / total_columns < missing_threshold:
        return None

    return round(statistics.mean(valid_scores), STATS_PRECISION)


def _compute_row_scores(
    db: Session,
    metric_def: MetricDefinition,
    grouped_rows: dict[str | None, list[ResolvedRow]] | None = None,
    column_groups: dict[int, dict[str | None, list[ResolvedRow]]] | None = None,
) -> None:
    """Compute and store per-record scores for a metric.

    For column-level metrics (mean/proportion): one score per record.
    For domain_aggregate: mean of item-level scores per record.
    Frequency distributions produce no record scores.
    """
    if metric_def.metric_type == "frequency_distribution":
        return

    config = _parse_json(metric_def.config) or {}
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # Delete old scores
    db.query(RowScore).filter(
        RowScore.metric_definition_id == metric_def.id,
    ).delete(synchronize_session="fetch")

    score_dicts: list[dict] = []

    if metric_def.metric_type in ("mean", "proportion") and grouped_rows is not None:
        # Column-level: iterate all rows, deduplicate by row_id
        seen: set[int] = set()
        for rows in grouped_rows.values():
            for row in rows:
                if row.row_id in seen:
                    continue
                seen.add(row.row_id)
                s = _score_single_row(metric_def.metric_type, row, config)
                score_dicts.append({
                    "metric_definition_id": metric_def.id,
                    "dataset_row_id": row.row_id,
                    "score": s,
                    "computed_at": now,
                })

    elif metric_def.metric_type == "domain_aggregate" and column_groups is not None:
        da_config = config
        child_metric_type = da_config.get("child_metric_type", "mean")
        child_config = da_config.get("child_config", {})
        total_columns = len(column_groups)

        # Pivot: row_id -> list of ResolvedRow across columns
        # Use ungrouped data (None key) matching compute_domain_aggregate behavior
        record_items: dict[int, list[ResolvedRow]] = {}
        for col_id, group_map in column_groups.items():
            rows = group_map.get(None, [])
            for row in rows:
                record_items.setdefault(row.row_id, []).append(row)

        for row_id, items in record_items.items():
            s = _score_domain_row(
                child_metric_type, child_config, items, total_columns,
            )
            score_dicts.append({
                "metric_definition_id": metric_def.id,
                "dataset_row_id": row_id,
                "score": s,
                "computed_at": now,
            })

    elif metric_def.metric_type in ("mean", "proportion") and column_groups is not None:
        # Non-aggregate domain metrics (pooled): average each record's
        # scores across all columns in the domain.
        total_columns = len(column_groups)
        record_items: dict[int, list[ResolvedRow]] = {}
        for col_id, group_map in column_groups.items():
            # Collect one row per record per column (deduplicate within
            # column since a record may appear in multiple group buckets)
            seen_in_col: set[int] = set()
            for rows in group_map.values():
                for row in rows:
                    if row.row_id not in seen_in_col:
                        seen_in_col.add(row.row_id)
                        record_items.setdefault(row.row_id, []).append(row)

        for row_id, items in record_items.items():
            s = _score_domain_row(
                metric_def.metric_type, config, items, total_columns,
            )
            score_dicts.append({
                "metric_definition_id": metric_def.id,
                "dataset_row_id": row_id,
                "score": s,
                "computed_at": now,
            })

    if score_dicts:
        db.execute(RowScore.__table__.insert(), score_dicts)


# ═══════════════════════════════════════════════════════════════════════════════
# Main entry points
# ═══════════════════════════════════════════════════════════════════════════════


def compute_metric(
    db: Session, metric_def: MetricDefinition,
    _sibling_cache: dict | None = None,
) -> list[ComputedResult]:
    """Compute (or recompute) a single metric definition.

    Deletes existing results and creates fresh ones.
    Returns the list of created ComputedResult objects.
    """
    # Defensive source check
    source_err = _check_source_exists(
        db, metric_def.project_id,
        metric_def.input_source_type, metric_def.input_source_id,
    )
    if source_err:
        raise ValueError(source_err)

    config = _parse_json(metric_def.config) or {}
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # Touch last_accessed_at so auto-metrics aren't cleaned up while in use
    metric_def.last_accessed_at = now

    # Delete old results
    db.query(ComputedResult).filter(
        ComputedResult.metric_definition_id == metric_def.id,
    ).delete(synchronize_session="fetch")

    # Load scale_labels for frequency_distribution
    scale_labels = None
    if metric_def.metric_type == "frequency_distribution" and metric_def.input_source_type == "dataset_column":
        col = db.query(DatasetColumn).filter(DatasetColumn.id == metric_def.input_source_id).first()
        if col and col.scale_labels:
            scale_labels = _parse_json(col.scale_labels)

    created_results: list[ComputedResult] = []
    column_groups = None  # populated for domain-level metrics
    grouped_rows = None   # populated for column-level metrics

    if metric_def.input_source_type == "dataset_domain":
        # Domain-level metrics: resolve all columns, then dispatch
        column_groups = resolve_dataset_domain(metric_def, db, _sibling_cache=_sibling_cache)

        if metric_def.metric_type == "domain_aggregate":
            result_data, valid_n, total_n = compute_domain_aggregate(column_groups, config)
            result = ComputedResult(
                metric_definition_id=metric_def.id,
                group_value=None,
                result_data=json.dumps(result_data),
                valid_n=valid_n,
                total_n=total_n,
                computed_at=now,
            )
            db.add(result)
            created_results.append(result)

        else:
            # Non-aggregate domain metrics (frequency_distribution, proportion, mean):
            # pool all column values into one flat list per group
            if metric_def.metric_type == "frequency_distribution":
                # Batch-load scale_labels from domain columns (single query)
                domain_col_ids = list(column_groups.keys())
                if domain_col_ids:
                    domain_cols = (
                        db.query(DatasetColumn.id, DatasetColumn.scale_labels)
                        .filter(DatasetColumn.id.in_(domain_col_ids))
                        .all()
                    )
                    for _cid, sl in domain_cols:
                        if sl:
                            scale_labels = _parse_json(sl)
                            break

            pooled: dict[str | None, list[ResolvedRow]] = {}
            for _col_id, group_map in column_groups.items():
                for group_value, rows in group_map.items():
                    pooled.setdefault(group_value, []).extend(rows)

            for group_value, rows in pooled.items():
                if metric_def.metric_type == "frequency_distribution":
                    result_data, valid_n, total_n = compute_frequency_distribution(rows, scale_labels)
                elif metric_def.metric_type == "proportion":
                    result_data, valid_n, total_n = compute_proportion(rows, config)
                elif metric_def.metric_type == "mean":
                    result_data, valid_n, total_n = compute_mean(rows)
                else:
                    continue

                result = ComputedResult(
                    metric_definition_id=metric_def.id,
                    group_value=group_value,
                    result_data=json.dumps(result_data),
                    valid_n=valid_n,
                    total_n=total_n,
                    computed_at=now,
                )
                db.add(result)
                created_results.append(result)

    else:
        # Column-level metrics: resolve single column
        grouped_rows = resolve_dataset_column(metric_def, db)

        for group_value, rows in grouped_rows.items():
            if metric_def.metric_type == "frequency_distribution":
                result_data, valid_n, total_n = compute_frequency_distribution(rows, scale_labels)
            elif metric_def.metric_type == "proportion":
                result_data, valid_n, total_n = compute_proportion(rows, config)
            elif metric_def.metric_type == "mean":
                result_data, valid_n, total_n = compute_mean(rows)
            else:
                continue

            result = ComputedResult(
                metric_definition_id=metric_def.id,
                group_value=group_value,
                result_data=json.dumps(result_data),
                valid_n=valid_n,
                total_n=total_n,
                computed_at=now,
            )
            db.add(result)
            created_results.append(result)

    # Compute per-record scores (error-isolated: failures don't break main results)
    try:
        _compute_row_scores(
            db, metric_def,
            grouped_rows=grouped_rows,
            column_groups=column_groups,
        )
    except Exception:
        logger.error(
            "Failed to compute record scores for metric %d (%s)",
            metric_def.id, metric_def.name, exc_info=True,
        )

    # Clear stale flag
    metric_def.stale = False
    db.flush()

    return created_results


def compute_all_for_project(
    db: Session, project_id: int, stale_only: bool = False,
) -> dict:
    """Compute all metrics for a project. Returns summary dict."""
    query = db.query(MetricDefinition).filter(
        MetricDefinition.project_id == project_id,
    )
    if stale_only:
        query = query.filter(MetricDefinition.stale == True)

    metrics = query.order_by(MetricDefinition.sequence_order).all()

    computed = 0
    errors: list[dict] = []

    sibling_cache: dict = {}

    for metric_def in metrics:
        try:
            compute_metric(db, metric_def, _sibling_cache=sibling_cache)
            computed += 1
        except Exception as e:
            errors.append({
                "metric_id": metric_def.id,
                "name": metric_def.name,
                "error": str(e),
            })

    db.commit()
    return {"computed": computed, "errors": errors}


# ═══════════════════════════════════════════════════════════════════════════════
# Tier 3 crosswalk — scale-score metric auto-creation (Task 1.4 / GAP 3.1)
# ═══════════════════════════════════════════════════════════════════════════════


def create_scale_score_metric(
    db: Session, domain: AnalysisDomain,
) -> tuple[MetricDefinition, bool]:
    """Create (or return existing) ungrouped scale-score metric for a variable group.

    Called by the Tier 3 crosswalk's `POST /analysis-domains/{id}/create-score-metric`
    endpoint AND by the portability import backfill in Task 1.9 (for legacy
    `.mmproject` files that predate the crosswalk).

    **Does NOT pre-validate cross-dataset pairing** — callers must do so. Router
    callers should call `assert_cross_dataset_members_are_paired` from
    `services/equivalence_validators.py` beforehand for a clean structured 409.
    Portability callers should catch any `ValueError` from this function
    (which propagates from `compute_metric`'s internal validator) and skip the
    domain with a warning. See directive Revision 5 for why pre-validation
    lives outside this service function.

    Returns (metric, computed) where:
    - metric: the persisted `MetricDefinition` (new or existing)
    - computed: True if the metric has fresh scores, False if compute failed

    **Locked field values** (see foot-gun and §2 item 43):
    - `origin="human"` — NOT `"auto"`. Setting `"auto"` would subject the metric
      to `services/metric_cleanup.py` auto-deletion after 7 days AND exclude it
      from R exports at `routers/export_r.py:1912`.
    - `origin_context="crosswalk_auto"` — UI filter key for AnalysisView's
      `(auto)` label + "Scale scores" collapsible group (§2 item 43).
    - `stale=True` on insert — cleared by `compute_metric` on success. If
      compute fails, the metric remains stale and the idempotency-on-stale
      recompute path fires correctly on retry.
    - `config` payload locked to `{"child_metric_type": "mean", "child_config": {},
      "aggregation": "mean"}` per directive GAP 3.1.
    """
    from sqlalchemy import func as sa_func

    # Idempotency: BOTH grouping fields must be NULL to identify the ungrouped
    # scale score. A metric with grouping_column_id_2 set is a grouped variant
    # (e.g., "Leadership by Department × Tenure") and must NOT be matched here.
    existing = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == domain.project_id,
            MetricDefinition.metric_type == "domain_aggregate",
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id == domain.id,
            MetricDefinition.grouping_column_id.is_(None),
            MetricDefinition.grouping_column_id_2.is_(None),
        )
        .first()
    )

    if existing is not None:
        if not existing.stale:
            return (existing, True)  # fresh, no-op
        # Stale existing: retry compute so the retry path from Phase 3.5's
        # "Create scale score manually" toast doesn't leave the researcher
        # in a degraded state (Revision 3 idempotency correction).
        try:
            compute_metric(db, existing)
            return (existing, True)
        except Exception as exc:
            logger.warning(
                "compute_metric failed for stale scale-score metric %d (%s): %s",
                existing.id, existing.name, exc,
            )
            return (existing, False)

    # Insert new. `config` is a Text column, not JSON — must json.dumps().
    # See foot-gun. Match pattern at backend/app/routers/metrics.py:335-348.
    config_json = json.dumps({
        "child_metric_type": "mean",
        "child_config": {},
        "aggregation": "mean",
    })

    max_order = (
        db.query(sa_func.max(MetricDefinition.sequence_order))
        .filter(MetricDefinition.project_id == domain.project_id)
        .scalar()
    ) or 0

    metric = MetricDefinition(
        project_id=domain.project_id,
        name=f"{domain.name} Score",
        metric_type="domain_aggregate",
        config=config_json,
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        grouping_column_id=None,
        grouping_column_id_2=None,
        sequence_order=max_order + 1,
        origin="human",                    # NOT "auto" — see foot-gun
        origin_context="crosswalk_auto",   # UI filter key, see §2 item 43
        stale=True,                        # compute_metric clears on success
    )
    db.add(metric)
    db.flush()

    try:
        compute_metric(db, metric)
        # compute_metric sets metric.stale = False on success (metrics.py:1434)
        return (metric, True)
    except Exception as exc:
        logger.warning(
            "compute_metric failed for new scale-score metric %d (%s): %s",
            metric.id, metric.name, exc,
        )
        # Metric remains in session with stale=True. Caller commits both the
        # insert and the stale=True state. Idempotency retry picks it up.
        return (metric, False)


# ═══════════════════════════════════════════════════════════════════════════════
# Label resolution
# ═══════════════════════════════════════════════════════════════════════════════


def resolve_input_source_labels(
    db: Session, metrics: list[MetricDefinition],
) -> dict[tuple[str, int], str]:
    """Batch-resolve input_source_label for a list of metrics.

    Returns dict mapping (source_type, source_id) to label string.
    """
    if not metrics:
        return {}

    # Collect distinct (type, id) pairs
    column_ids: set[int] = set()
    domain_ids: set[int] = set()

    for m in metrics:
        if m.input_source_type == "dataset_column":
            column_ids.add(m.input_source_id)
        elif m.input_source_type == "dataset_domain":
            domain_ids.add(m.input_source_id)

    label_map: dict[tuple[str, int], str] = {}

    # Batch load column labels
    if column_ids:
        columns = (
            db.query(DatasetColumn.id, DatasetColumn.column_text, Dataset.name)
            .join(Dataset)
            .filter(DatasetColumn.id.in_(column_ids))
            .all()
        )
        for col_id, col_text, ds_name in columns:
            label_map[("dataset_column", col_id)] = f"{ds_name}: {col_text}"

    # Batch load domain labels
    if domain_ids:
        domains = (
            db.query(AnalysisDomain.id, AnalysisDomain.name)
            .filter(AnalysisDomain.id.in_(domain_ids))
            .all()
        )
        for dom_id, dom_name in domains:
            label_map[("dataset_domain", dom_id)] = dom_name

    return label_map
