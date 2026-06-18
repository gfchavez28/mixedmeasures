"""Statistical tests service: Cronbach's alpha, independent t-test, one-way ANOVA.

Provides compute functions for supplementary statistical tests that produce
structured text annotations displayed alongside charts/metrics.
"""

import json
import logging
import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest
from ..models.analysis_domain import AnalysisDomain
from ..models.dataset import DatasetColumn, DatasetRow, Dataset
from .grouping import order_value_labels
from .metrics import (
    resolve_dataset_column,
    resolve_dataset_domain,
    _parse_json,
    STATS_PRECISION,
    MISSING_ITEM_THRESHOLD,
)

logger = logging.getLogger(__name__)

# ── Effect size and interpretation thresholds ─────────────────────────────────

COHENS_D_THRESHOLDS = {"small": 0.2, "medium": 0.5, "large": 0.8}
ETA_SQUARED_THRESHOLDS = {"small": 0.01, "medium": 0.06, "large": 0.14}
ALPHA_THRESHOLDS = {"poor": 0.5, "questionable": 0.6, "acceptable": 0.7, "good": 0.8, "excellent": 0.9}


def _classify_effect_cohens_d(d: float) -> str:
    d = abs(d)
    if d >= COHENS_D_THRESHOLDS["large"]:
        return "large"
    if d >= COHENS_D_THRESHOLDS["medium"]:
        return "medium"
    if d >= COHENS_D_THRESHOLDS["small"]:
        return "small"
    return "negligible"


def _classify_effect_eta_squared(eta2: float) -> str:
    if eta2 >= ETA_SQUARED_THRESHOLDS["large"]:
        return "large"
    if eta2 >= ETA_SQUARED_THRESHOLDS["medium"]:
        return "medium"
    if eta2 >= ETA_SQUARED_THRESHOLDS["small"]:
        return "small"
    return "negligible"


def _interpret_alpha(alpha: float) -> str:
    if alpha >= ALPHA_THRESHOLDS["excellent"]:
        return "excellent"
    if alpha >= ALPHA_THRESHOLDS["good"]:
        return "good"
    if alpha >= ALPHA_THRESHOLDS["acceptable"]:
        return "acceptable"
    if alpha >= ALPHA_THRESHOLDS["questionable"]:
        return "questionable"
    if alpha >= ALPHA_THRESHOLDS["poor"]:
        return "poor"
    return "unacceptable"


# ── Resolver proxy ────────────────────────────────────────────────────────────


@dataclass
class _ResolverProxy:
    """Lightweight proxy that looks like a MetricDefinition for resolver functions."""
    input_source_id: int
    input_source_type: str
    grouping_column_id: int | None = None
    grouping_column_id_2: int | None = None
    grouping_mode: str | None = None
    exclude_values: str | None = None
    project_id: int | None = None
    config: str | None = None


# ── Record-item matrix builder ───────────────────────────────────────────────


@dataclass
class RecordItemRow:
    numeric: float | None
    text: str | None
    excluded: bool


def build_row_item_matrix(
    db: Session,
    domain_id: int,
    exclude_values: str | None = None,
    grouping_column_id: int | None = None,
    grouping_column_id_2: int | None = None,
) -> tuple[dict[int, dict[int, RecordItemRow]], dict[int, str | None], list[int], dict[int, int]]:
    """Build a record × item matrix from a domain's columns.

    Returns:
        matrix: {row_id: {col_id: RecordItemRow}}
        grouping_map: {row_id: group_value} (empty dict if no grouping)
        column_ids: list of all column IDs in the domain
        col_to_equiv: {col_id: equiv_group_id} for columns in equivalence groups
    """
    proxy = _ResolverProxy(
        input_source_id=domain_id,
        input_source_type="dataset_domain",
        grouping_column_id=grouping_column_id,
        grouping_column_id_2=grouping_column_id_2,
        exclude_values=exclude_values,
    )
    # resolve_dataset_domain returns {col_id: {group_value: [ResolvedRow]}}
    domain_data = resolve_dataset_domain(proxy, db)

    if not domain_data:
        return {}, {}, [], {}

    column_ids = sorted(domain_data.keys())

    # Build col_id → equivalence_group_id map
    col_to_equiv: dict[int, int] = {}
    col_eq_rows = (
        db.query(DatasetColumn.id, DatasetColumn.equivalence_group_id)
        .filter(
            DatasetColumn.id.in_(column_ids),
            DatasetColumn.equivalence_group_id.isnot(None),
        )
        .all()
    )
    for cid, eg_id in col_eq_rows:
        col_to_equiv[cid] = eg_id

    # Pivot: column-oriented → record-oriented
    matrix: dict[int, dict[int, RecordItemRow]] = {}
    grouping_map: dict[int, str | None] = {}

    for col_id, group_map in domain_data.items():
        for group_val, rows in group_map.items():
            for row in rows:
                if row.row_id not in matrix:
                    matrix[row.row_id] = {}
                matrix[row.row_id][col_id] = RecordItemRow(
                    numeric=row.value_numeric,
                    text=row.value_text,
                    excluded=row.excluded,
                )
                # Track grouping
                if grouping_column_id is not None and group_val is not None:
                    grouping_map[row.row_id] = group_val

    return matrix, grouping_map, column_ids, col_to_equiv


# ── Compute functions ─────────────────────────────────────────────────────────


def compute_cronbachs_alpha(db: Session, test: StatisticalTest) -> dict:
    """Compute Cronbach's alpha for an analysis domain.

    Requires target_type == "analysis_domain".
    Uses listwise deletion (records must have all k items valid).

    Equivalence-aware: columns in the same equivalence group are collapsed
    into a single item per record (using whichever column they answered).
    This is only well-defined under the 1:1-column-per-dataset invariant on
    equivalence groups — see the baseline migration and #289. A
    row only ever has one value for a given (equivalence_group,
    dataset) pair, so the "valid value takes precedence" collapse below is
    unambiguous.
    """
    config = _parse_json(test.config) or {}
    exclude_values = json.dumps(config.get("exclude_values", [])) if config.get("exclude_values") else None

    matrix, _, column_ids, col_to_equiv = build_row_item_matrix(
        db, test.target_id, exclude_values=exclude_values,
    )

    # Collapse equivalent columns into logical items.
    # item_keys: ordered list of unique item identifiers
    #   - For columns in an equivalence group: ("equiv", group_id)
    #   - For standalone columns: ("col", col_id)
    item_keys: list[tuple[str, int]] = []
    item_key_set: set[tuple[str, int]] = set()
    for col_id in column_ids:
        eg_id = col_to_equiv.get(col_id)
        if eg_id is not None:
            key = ("equiv", eg_id)
        else:
            key = ("col", col_id)
        if key not in item_key_set:
            item_key_set.add(key)
            item_keys.append(key)

    # Map each col_id to its item_key
    col_to_item_key: dict[int, tuple[str, int]] = {}
    for col_id in column_ids:
        eg_id = col_to_equiv.get(col_id)
        if eg_id is not None:
            col_to_item_key[col_id] = ("equiv", eg_id)
        else:
            col_to_item_key[col_id] = ("col", col_id)

    k = len(item_keys)
    if k < 2:
        raise ValueError(f"Cronbach's alpha requires at least 2 items, domain has {k}")

    # Build collapsed record matrix: {row_id: {item_key: numeric_value}}
    # For equivalence groups, a record's value comes from whichever
    # equivalent column they answered.
    collapsed: dict[int, dict[tuple[str, int], float | None]] = {}
    for row_id, items in matrix.items():
        row_vals: dict[tuple[str, int], float | None] = {}
        for col_id, item in items.items():
            item_key = col_to_item_key.get(col_id)
            if item_key is None:
                continue
            if item.excluded or item.numeric is None:
                # Only set None if no valid value already present for this item
                if item_key not in row_vals:
                    row_vals[item_key] = None
            else:
                # Valid value takes precedence
                row_vals[item_key] = item.numeric
        collapsed[row_id] = row_vals

    # Listwise deletion: keep records with all k items valid
    complete_rows: list[list[float]] = []
    n_excluded_listwise = 0

    for row_id, row_vals in collapsed.items():
        values = []
        complete = True
        for item_key in item_keys:
            val = row_vals.get(item_key)
            if val is None:
                complete = False
                break
            values.append(val)
        if complete:
            complete_rows.append(values)
        else:
            n_excluded_listwise += 1

    n = len(complete_rows)
    if n < 3:
        raise ValueError(f"Cronbach's alpha requires at least 3 complete records, got {n}")

    # Compute item variances and total variance
    item_variances = []
    for i in range(k):
        item_values = [row[i] for row in complete_rows]
        item_variances.append(statistics.variance(item_values))

    # Total variance: variance of row totals
    row_totals = [sum(row) for row in complete_rows]
    total_variance = statistics.variance(row_totals)

    # Alpha formula
    if total_variance == 0:
        alpha = 0.0
    else:
        alpha = (k / (k - 1)) * (1 - sum(item_variances) / total_variance)

    alpha = round(alpha, STATS_PRECISION)

    return {
        "alpha": alpha,
        "k": k,
        "n": n,
        "n_excluded_listwise": n_excluded_listwise,
        "item_variances": [round(v, STATS_PRECISION) for v in item_variances],
        "total_variance": round(total_variance, STATS_PRECISION),
        "interpretation": _interpret_alpha(alpha),
        "interpretation_thresholds": ALPHA_THRESHOLDS,
    }


def compute_independent_t_test(db: Session, test: StatisticalTest) -> dict:
    """Compute independent samples t-test (Welch's) for a grouped metric.

    Requires target_type == "metric_definition" with a grouping column or
    dataset grouping. Validates exactly 2 groups.
    """
    from scipy.stats import ttest_ind

    metric = db.query(MetricDefinition).filter(MetricDefinition.id == test.target_id).first()
    if not metric:
        raise ValueError(f"Metric definition {test.target_id} not found")
    if not metric.grouping_column_id and not metric.grouping_column_id_2 and metric.grouping_mode != "dataset":
        raise ValueError("T-test requires a metric with a grouping column or dataset grouping")

    config = _parse_json(test.config) or {}

    # Resolve data based on metric's input source type
    group_values = _resolve_grouped_values(db, metric, config)

    # Filter out None group keys
    group_values = {k: v for k, v in group_values.items() if k is not None}

    if len(group_values) != 2:
        raise ValueError(
            f"Independent t-test requires exactly 2 groups, got {len(group_values)} "
            f"({', '.join(sorted(str(k) for k in group_values.keys()))}). "
            f"Use one-way ANOVA for 3+ groups."
        )

    groups = order_value_labels(group_values.keys())  # #406
    g1_label, g2_label = groups[0], groups[1]
    g1_values, g2_values = group_values[g1_label], group_values[g2_label]

    if len(g1_values) < 2:
        raise ValueError(f"Group '{g1_label}' has fewer than 2 observations ({len(g1_values)})")
    if len(g2_values) < 2:
        raise ValueError(f"Group '{g2_label}' has fewer than 2 observations ({len(g2_values)})")

    # Welch's t-test
    t_stat, p_value = ttest_ind(g1_values, g2_values, equal_var=False)

    n1, n2 = len(g1_values), len(g2_values)
    m1, m2 = statistics.mean(g1_values), statistics.mean(g2_values)
    s1, s2 = statistics.stdev(g1_values), statistics.stdev(g2_values)

    # Welch-Satterthwaite degrees of freedom
    se1_sq = s1 ** 2 / n1
    se2_sq = s2 ** 2 / n2
    if se1_sq + se2_sq > 0:
        denom = se1_sq ** 2 / (n1 - 1) + se2_sq ** 2 / (n2 - 1)
        df = (se1_sq + se2_sq) ** 2 / denom if denom > 0 else n1 + n2 - 2
    else:
        df = n1 + n2 - 2
    # Guard against NaN/Inf from edge cases
    if not math.isfinite(df):
        df = n1 + n2 - 2

    # Cohen's d (pooled SD)
    pooled_var = ((n1 - 1) * s1 ** 2 + (n2 - 1) * s2 ** 2) / (n1 + n2 - 2)
    pooled_sd = math.sqrt(pooled_var) if pooled_var > 0 else 0
    cohens_d = (m1 - m2) / pooled_sd if pooled_sd > 0 else 0.0

    return {
        "t_statistic": round(float(t_stat), STATS_PRECISION),
        "df": round(float(df), STATS_PRECISION),
        "p_value": round(float(p_value), STATS_PRECISION),
        "cohens_d": round(float(cohens_d), STATS_PRECISION),
        "effect_size_label": _classify_effect_cohens_d(cohens_d),
        "group1_label": g1_label,
        "group1_mean": round(m1, STATS_PRECISION),
        "group1_sd": round(s1, STATS_PRECISION),
        "group1_n": n1,
        "group2_label": g2_label,
        "group2_mean": round(m2, STATS_PRECISION),
        "group2_sd": round(s2, STATS_PRECISION),
        "group2_n": n2,
        "significant": float(p_value) < 0.05,
    }


def compute_one_way_anova(db: Session, test: StatisticalTest) -> dict:
    """Compute one-way ANOVA for a grouped metric.

    Requires target_type == "metric_definition" with a grouping column or
    dataset grouping. Validates 3+ groups.
    """
    from scipy.stats import f_oneway

    metric = db.query(MetricDefinition).filter(MetricDefinition.id == test.target_id).first()
    if not metric:
        raise ValueError(f"Metric definition {test.target_id} not found")
    if not metric.grouping_column_id and not metric.grouping_column_id_2 and metric.grouping_mode != "dataset":
        raise ValueError("ANOVA requires a metric with a grouping column or dataset grouping")

    config = _parse_json(test.config) or {}

    group_values = _resolve_grouped_values(db, metric, config)
    group_values = {k: v for k, v in group_values.items() if k is not None}

    if len(group_values) < 3:
        raise ValueError(
            f"One-way ANOVA requires at least 3 groups, got {len(group_values)} "
            f"({', '.join(sorted(str(k) for k in group_values.keys()))}). "
            f"Use independent t-test for 2 groups."
        )

    # Validate each group has n >= 2
    for label, values in group_values.items():
        if len(values) < 2:
            raise ValueError(f"Group '{label}' has fewer than 2 observations ({len(values)})")

    sorted_labels = order_value_labels(group_values.keys())  # #406
    group_arrays = [group_values[label] for label in sorted_labels]

    f_stat, p_value = f_oneway(*group_arrays)

    # Compute eta-squared
    grand_mean = statistics.mean([v for arr in group_arrays for v in arr])
    ss_between = sum(
        len(arr) * (statistics.mean(arr) - grand_mean) ** 2
        for arr in group_arrays
    )
    ss_total = sum(
        (v - grand_mean) ** 2
        for arr in group_arrays
        for v in arr
    )
    eta_squared = ss_between / ss_total if ss_total > 0 else 0.0

    total_n = sum(len(arr) for arr in group_arrays)
    k = len(group_arrays)
    df_between = k - 1
    df_within = total_n - k

    # Omega-squared (less biased than eta-squared)
    ss_within = ss_total - ss_between
    ms_within = ss_within / df_within if df_within > 0 else 0
    omega_sq = max((ss_between - df_between * ms_within) / (ss_total + ms_within), 0.0)

    groups_info = []
    for label in sorted_labels:
        vals = group_values[label]
        groups_info.append({
            "label": label,
            "mean": round(statistics.mean(vals), STATS_PRECISION),
            "sd": round(statistics.stdev(vals), STATS_PRECISION),
            "n": len(vals),
        })

    return {
        "f_statistic": round(float(f_stat), STATS_PRECISION),
        "df_between": df_between,
        "df_within": df_within,
        "p_value": round(float(p_value), STATS_PRECISION),
        "eta_squared": round(eta_squared, STATS_PRECISION),
        "omega_squared": round(omega_sq, STATS_PRECISION),
        "effect_size_label": _classify_effect_eta_squared(eta_squared),
        "groups": groups_info,
        "significant": float(p_value) < 0.05,
    }


def _resolve_grouped_values(
    db: Session, metric: MetricDefinition, config: dict,
) -> dict[str, list[float]]:
    """Resolve numeric values split by grouping column for t-test/ANOVA.

    Returns {group_label: [float_values]}.
    """
    if metric.input_source_type == "dataset_column":
        grouped_rows = resolve_dataset_column(metric, db)
        result: dict[str, list[float]] = {}
        for group_val, rows in grouped_rows.items():
            valid = [
                r.value_numeric for r in rows
                if not r.excluded and r.value_numeric is not None
            ]
            if valid:
                result[group_val] = valid
        return result

    elif metric.input_source_type == "dataset_domain":
        # Compute per-record domain scores, then split by group
        matrix, grouping_map, column_ids, _ = build_row_item_matrix(
            db,
            metric.input_source_id,
            exclude_values=metric.exclude_values,
            grouping_column_id=metric.grouping_column_id,
            grouping_column_id_2=metric.grouping_column_id_2,
        )

        # Build dataset grouping map if needed
        dataset_grouping_map: dict[int, str] = {}
        if metric.grouping_mode == "dataset" and matrix:
            # Map row_id (DatasetRow.id) → Dataset.name
            row_ids = list(matrix.keys())
            row_dataset_rows = (
                db.query(DatasetRow.id, Dataset.name)
                .join(Dataset, DatasetRow.dataset_id == Dataset.id)
                .filter(DatasetRow.id.in_(row_ids))
                .all()
            )
            dataset_grouping_map = {rid: dname for rid, dname in row_dataset_rows}

        result: dict[str, list[float]] = {}
        for row_id, items in matrix.items():
            # Compute record domain score = mean of valid numerics
            valid_nums = []
            for col_id in column_ids:
                item = items.get(col_id)
                if item and not item.excluded and item.numeric is not None:
                    valid_nums.append(item.numeric)
            total_items = len(column_ids)
            if not valid_nums or (total_items > 0 and len(valid_nums) / total_items < MISSING_ITEM_THRESHOLD):
                continue

            score = statistics.mean(valid_nums)

            if metric.grouping_mode == "dataset":
                group_val = dataset_grouping_map.get(row_id)
            else:
                group_val = grouping_map.get(row_id)

            if group_val not in result:
                result[group_val] = []
            result[group_val].append(score)

        return result

    else:
        raise ValueError(f"Unsupported input_source_type: {metric.input_source_type}")


def compute_split_half(db: Session, test: StatisticalTest) -> dict:
    """Compute split-half reliability for an analysis domain.

    Requires target_type == "analysis_domain".
    Splits items into odd-indexed (0,2,4...) and even-indexed (1,3,5...) halves,
    computes Pearson r between half-scores, then applies Spearman-Brown correction.
    """
    import numpy as np

    config = _parse_json(test.config) or {}
    exclude_values = json.dumps(config.get("exclude_values", [])) if config.get("exclude_values") else None

    matrix, _, column_ids, col_to_equiv = build_row_item_matrix(
        db, test.target_id, exclude_values=exclude_values,
    )

    # Collapse equivalent columns into logical items (same as Cronbach's alpha)
    item_keys: list[tuple[str, int]] = []
    item_key_set: set[tuple[str, int]] = set()
    for col_id in column_ids:
        eg_id = col_to_equiv.get(col_id)
        key = ("equiv", eg_id) if eg_id is not None else ("col", col_id)
        if key not in item_key_set:
            item_key_set.add(key)
            item_keys.append(key)

    col_to_item_key: dict[int, tuple[str, int]] = {}
    for col_id in column_ids:
        eg_id = col_to_equiv.get(col_id)
        col_to_item_key[col_id] = ("equiv", eg_id) if eg_id is not None else ("col", col_id)

    k = len(item_keys)
    if k < 4:
        raise ValueError(
            f"Split-half reliability requires at least 4 items for balanced "
            f"halves, domain has {k}"
        )

    # Build collapsed record matrix
    collapsed: dict[int, dict[tuple[str, int], float | None]] = {}
    for row_id, items in matrix.items():
        row_vals: dict[tuple[str, int], float | None] = {}
        for col_id, item in items.items():
            item_key = col_to_item_key.get(col_id)
            if item_key is None:
                continue
            if item.excluded or item.numeric is None:
                if item_key not in row_vals:
                    row_vals[item_key] = None
            else:
                row_vals[item_key] = item.numeric
        collapsed[row_id] = row_vals

    # Split items: odd-indexed vs even-indexed
    half1_keys = [item_keys[i] for i in range(0, k, 2)]
    half2_keys = [item_keys[i] for i in range(1, k, 2)]

    # Listwise deletion: records must have all k items valid
    half1_scores: list[float] = []
    half2_scores: list[float] = []
    n_excluded_listwise = 0

    for row_vals in collapsed.values():
        all_valid = True
        h1_sum = 0.0
        h2_sum = 0.0
        for ik in item_keys:
            val = row_vals.get(ik)
            if val is None:
                all_valid = False
                break
        if not all_valid:
            n_excluded_listwise += 1
            continue
        for ik in half1_keys:
            h1_sum += row_vals[ik]  # type: ignore[operator]
        for ik in half2_keys:
            h2_sum += row_vals[ik]  # type: ignore[operator]
        half1_scores.append(h1_sum)
        half2_scores.append(h2_sum)

    n = len(half1_scores)
    if n < 3:
        raise ValueError(f"Split-half reliability requires at least 3 complete records, got {n}")

    # Pearson r between half-scores
    h1 = np.array(half1_scores)
    h2 = np.array(half2_scores)
    corr_matrix = np.corrcoef(h1, h2)
    r = float(corr_matrix[0, 1])

    if math.isnan(r):
        raise ValueError("Split-half correlation undefined (constant values in one or both halves)")

    # Spearman-Brown correction (guard division by zero when r == -1)
    raw_sb = (2 * r) / (1 + r) if abs(1 + r) > 1e-10 else 0.0
    # Negative r yields nonsensical negative SB; clamp to 0
    negative_half_correlation = r < 0
    spearman_brown = max(raw_sb, 0.0)

    return {
        "split_half_r": round(r, STATS_PRECISION),
        "spearman_brown": round(spearman_brown, STATS_PRECISION),
        "interpretation": _interpret_alpha(spearman_brown),
        "negative_half_correlation": negative_half_correlation,
        "k": k,
        "k_half1": len(half1_keys),
        "k_half2": len(half2_keys),
        "n": n,
        "n_excluded_listwise": n_excluded_listwise,
    }


# ── Dispatcher ────────────────────────────────────────────────────────────────


def compute_statistical_test(db: Session, test: StatisticalTest) -> dict:
    """Compute a single statistical test and update the model in place.

    Returns the result_data dict.
    """
    if test.test_type == "cronbachs_alpha":
        result = compute_cronbachs_alpha(db, test)
        valid_n = result.get("n")
    elif test.test_type == "independent_t_test":
        result = compute_independent_t_test(db, test)
        valid_n = result.get("group1_n", 0) + result.get("group2_n", 0)
    elif test.test_type == "one_way_anova":
        result = compute_one_way_anova(db, test)
        valid_n = sum(g.get("n", 0) for g in result.get("groups", []))
    elif test.test_type == "split_half":
        result = compute_split_half(db, test)
        valid_n = result.get("n")
    else:
        raise ValueError(f"Unknown test_type: {test.test_type}")

    test.result_data = json.dumps(result)
    test.valid_n = valid_n
    test.stale = False
    test.computed_at = datetime.now(timezone.utc)
    db.flush()

    return result


def compute_all_tests_for_project(
    db: Session, project_id: int, stale_only: bool = False,
) -> dict:
    """Compute all statistical tests for a project. Returns summary dict."""
    query = db.query(StatisticalTest).filter(
        StatisticalTest.project_id == project_id,
    )
    if stale_only:
        query = query.filter(StatisticalTest.stale == True)  # noqa: E712

    tests = query.all()

    computed = 0
    errors: list[dict] = []

    for test in tests:
        try:
            compute_statistical_test(db, test)
            computed += 1
        except Exception as e:
            errors.append({
                "test_id": test.id,
                "test_type": test.test_type,
                "error": str(e),
            })

    db.commit()
    return {"computed": computed, "errors": errors}


# ── Target label resolution ──────────────────────────────────────────────────


def resolve_target_labels(
    db: Session, tests: list[StatisticalTest],
) -> dict[tuple[str, int], str]:
    """Batch-resolve target labels for a list of tests.

    Returns dict mapping (target_type, target_id) to label string.
    """
    if not tests:
        return {}

    domain_ids: set[int] = set()
    metric_ids: set[int] = set()

    for t in tests:
        if t.target_type == "analysis_domain":
            domain_ids.add(t.target_id)
        elif t.target_type == "metric_definition":
            metric_ids.add(t.target_id)

    label_map: dict[tuple[str, int], str] = {}

    if domain_ids:
        domains = (
            db.query(AnalysisDomain.id, AnalysisDomain.name)
            .filter(AnalysisDomain.id.in_(domain_ids))
            .all()
        )
        for dom_id, dom_name in domains:
            label_map[("analysis_domain", dom_id)] = dom_name

    if metric_ids:
        metrics = (
            db.query(MetricDefinition.id, MetricDefinition.name)
            .filter(MetricDefinition.id.in_(metric_ids))
            .all()
        )
        for met_id, met_name in metrics:
            label_map[("metric_definition", met_id)] = met_name

    return label_map
