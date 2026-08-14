"""Cross-tabulation computation service.

Computes joint frequency matrices with row/column/total percentages
and optional chi-square test with Cramér's V.
"""

import json
import logging
from collections import Counter

from sqlalchemy import and_
from sqlalchemy.orm import Session, aliased

from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.recode import RecodeDefinition
# #384: exclude recognized N/A values from cross-tab categories (different query
# shape from the shared grouping loader — a paired two-column join — so filter inline).
from .missing_values import column_missing_rules, is_missing
from .grouping import order_value_labels
from .undefined_stats import DEGENERATE, finite_or_none

logger = logging.getLogger(__name__)


def _parse_json(text: str | None):
    """Parse a JSON string, returning None on failure."""
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _get_ordered_values(db: Session, column: DatasetColumn) -> list[str] | None:
    """Return ordered values from primary recode or scale_labels, or None for alphabetical."""
    primary_recode = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == column.id,
            RecodeDefinition.is_primary == True,  # noqa: E712
            RecodeDefinition.recode_type == "scale_map",
        )
        .first()
    )
    if primary_recode:
        mapping = _parse_json(primary_recode.mapping) or {}
        sorted_labels = sorted(
            mapping.keys(),
            key=lambda k: float(mapping[k]) if mapping[k] is not None else 999,
        )
        return sorted_labels

    if column.scale_labels:
        labels = _parse_json(column.scale_labels) if isinstance(column.scale_labels, str) else column.scale_labels
        if isinstance(labels, list) and len(labels) > 0:
            return labels

    return None


def compute_cross_tabulation(
    db: Session,
    project_id: int,
    row_column_id: int,
    col_column_id: int,
    include_chi_square: bool = True,
) -> dict:
    """Cross-tabulate two columns and optionally compute chi-square + Cramér's V.

    Returns:
        {
            "row_values": list[str],
            "col_values": list[str],
            "matrix": list[list[dict]],
            "row_totals": list[int],
            "col_totals": list[int],
            "n_shared": int,
            "row_column_label": str,
            "col_column_label": str,
            "chi_square": {...} | None,
        }
    """
    # Validate both columns exist and belong to the same dataset in this project
    row_col = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(DatasetColumn.id == row_column_id, Dataset.project_id == project_id)
        .first()
    )
    col_col = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(DatasetColumn.id == col_column_id, Dataset.project_id == project_id)
        .first()
    )

    if not row_col:
        raise ValueError(f"Row column {row_column_id} not found in project")
    if not col_col:
        raise ValueError(f"Column {col_column_id} not found in project")
    if row_col.dataset_id != col_col.dataset_id:
        raise ValueError("Cross-tabulation requires both columns to be in the same dataset")

    row_ordered = _get_ordered_values(db, row_col)
    col_ordered = _get_ordered_values(db, col_col)

    # Query joint values
    RowVal = aliased(DatasetValue, name="row_val")
    ColVal = aliased(DatasetValue, name="col_val")

    pairs = (
        db.query(RowVal.value_text, ColVal.value_text)
        .join(ColVal, and_(
            RowVal.row_id == ColVal.row_id,
            ColVal.column_id == col_column_id,
        ))
        .filter(
            RowVal.column_id == row_column_id,
            RowVal.value_text.isnot(None),
            RowVal.value_text != "",
            ColVal.value_text.isnot(None),
            ColVal.value_text != "",
        )
        .all()
    )

    row_label = row_col.column_name or row_col.column_text or f"Column {row_col.id}"
    col_label = col_col.column_name or col_col.column_text or f"Column {col_col.id}"

    if not pairs:
        return {
            "row_values": [],
            "col_values": [],
            "matrix": [],
            "row_totals": [],
            "col_totals": [],
            "n_shared": 0,
            "row_column_label": row_label,
            "col_column_label": col_label,
            "chi_square": None,
        }

    # Count joint frequencies (#384: skip pairs where either value is missing
    # — those rows are missing, not a real cross-tab category). #592: the
    # decision is column-aware — each axis is judged by ITS column's declared
    # rules (REPLACE semantics), defaults when undeclared.
    row_rules = column_missing_rules(row_col)
    col_rules = column_missing_rules(col_col)
    joint_counts: Counter[tuple[str, str]] = Counter()
    for row_val, col_val in pairs:
        if is_missing(row_val, row_rules) or is_missing(col_val, col_rules):
            continue
        joint_counts[(row_val, col_val)] += 1

    # Determine value sets (#406: numeric-aware ordering; explicit
    # recode/scale_labels orders below still override)
    all_row_vals = order_value_labels({rv for rv, _ in joint_counts.keys()})
    all_col_vals = order_value_labels({cv for _, cv in joint_counts.keys()})

    # Apply ordered values if available (only keep values that actually appear)
    if row_ordered:
        ordered_set = set(row_ordered)
        remaining = [v for v in all_row_vals if v not in ordered_set]
        all_row_vals = [v for v in row_ordered if v in {rv for rv, _ in joint_counts.keys()}] + remaining

    if col_ordered:
        ordered_set = set(col_ordered)
        remaining = [v for v in all_col_vals if v not in ordered_set]
        all_col_vals = [v for v in col_ordered if v in {cv for _, cv in joint_counts.keys()}] + remaining

    n_shared = sum(joint_counts.values())
    row_totals = [sum(joint_counts.get((rv, cv), 0) for cv in all_col_vals) for rv in all_row_vals]
    col_totals = [sum(joint_counts.get((rv, cv), 0) for rv in all_row_vals) for cv in all_col_vals]

    # Build matrix
    matrix: list[list[dict]] = []
    for ri, rv in enumerate(all_row_vals):
        row_cells: list[dict] = []
        for ci, cv in enumerate(all_col_vals):
            count = joint_counts.get((rv, cv), 0)
            row_cells.append({
                "count": count,
                "row_pct": round(count / row_totals[ri] * 100, 1) if row_totals[ri] > 0 else 0,
                "col_pct": round(count / col_totals[ci] * 100, 1) if col_totals[ci] > 0 else 0,
                "total_pct": round(count / n_shared * 100, 1) if n_shared > 0 else 0,
            })
        matrix.append(row_cells)

    # Chi-square test
    chi_result = None
    if include_chi_square and len(all_row_vals) >= 2 and len(all_col_vals) >= 2:
        try:
            import numpy as np
            from scipy.stats import chi2_contingency
            observed = np.array([
                [joint_counts.get((rv, cv), 0) for cv in all_col_vals]
                for rv in all_row_vals
            ])
            chi2, p, df, _ = chi2_contingency(observed)
            min_dim = min(len(all_row_vals), len(all_col_vals)) - 1
            # #689: a degenerate table (a single effective row or column) gives
            # `min_dim == 0`, and V was reported as a measured 0 — "no
            # association" for a table that cannot express association at all.
            cramers_v = (
                finite_or_none(np.sqrt(chi2 / (n_shared * min_dim)), 3)
                if n_shared > 0 and min_dim > 0 else None
            )
            chi_result = {
                "statistic": finite_or_none(chi2, 3),
                "p_value": finite_or_none(p, 4),
                "df": int(df),
                "cramers_v": cramers_v,
                "undefined_reason": None if cramers_v is not None else DEGENERATE,
            }
        except (ZeroDivisionError, ValueError, TypeError) as exc:
            logger.warning("Chi-square computation failed: %s", exc)

    return {
        "row_values": all_row_vals,
        "col_values": all_col_vals,
        "matrix": matrix,
        "row_totals": row_totals,
        "col_totals": col_totals,
        "n_shared": n_shared,
        "row_column_label": row_label,
        "col_column_label": col_label,
        "chi_square": chi_result,
    }
