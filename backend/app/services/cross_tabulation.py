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


def _axis_values(
    ordered: list[str] | None, observed: set[str], rules,
) -> list[str]:
    """One axis's display values: the DECLARED scale, then the undeclared tail.

    #591: a declared level nobody chose is a STRUCTURAL ZERO and belongs on the
    axis — that is what a declared scale exists to express, and the frequency
    computer already zero-fills it (#577). Filtering the declared order down to
    what was observed made the same declaration answer two different ways on two
    surfaces: a 0 bar in a frequency chart, and silently absent from a cross-tab.

    ⚠️ **The declared order is filtered through the column's missing rules first.**
    `_get_ordered_values` reads a primary `scale_map`'s mapping keys, and a
    hand-authored mapping may name a value the column treats as missing (`{"N/A":
    99}`). `apply_value_labels` and `write_back_scale_metadata` strip such pairs
    on the write side (C4), but this path reads the mapping directly — so without
    the filter, zero-filling would resurrect a missing level as a visible
    category and undo #384/#592 on exactly this surface.
    """
    declared = [v for v in (ordered or []) if not is_missing(v, rules)]
    seen = set(declared)
    return declared + [v for v in order_value_labels(observed) if v not in seen]


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

    # Axis values: the DECLARED scale first (including levels nobody chose —
    # #591), then any observed value the declaration never named. #406:
    # numeric-aware ordering for the undeclared tail.
    observed_rows = {rv for rv, _ in joint_counts.keys()}
    observed_cols = {cv for _, cv in joint_counts.keys()}
    all_row_vals = _axis_values(row_ordered, observed_rows, row_rules)
    all_col_vals = _axis_values(col_ordered, observed_cols, col_rules)

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

    # Chi-square test — on the OBSERVED submatrix only (#591).
    #
    # A declared-but-unchosen level is a legitimate ROW of the table and an
    # illegitimate row of the TEST: scipy raises outright on it —
    #   ValueError: The internally computed table of expected frequencies has a
    #   zero element at (2, 0)
    # — so displaying structural zeros without splitting the two would make the
    # chi-square block silently vanish (it is inside a `try`) on every cross-tab
    # that has one, or 500 if that `try` were ever narrowed. Measured, not
    # reasoned. Same shape as #506: a phantom group is fine to show and must not
    # enter the statistic.
    chi_rows = [i for i, t in enumerate(row_totals) if t > 0]
    chi_cols = [j for j, t in enumerate(col_totals) if t > 0]
    omitted_levels = (len(all_row_vals) - len(chi_rows)) + (len(all_col_vals) - len(chi_cols))

    chi_result = None
    if include_chi_square and len(chi_rows) >= 2 and len(chi_cols) >= 2:
        try:
            import numpy as np
            from scipy.stats import chi2_contingency
            observed = np.array([
                [joint_counts.get((all_row_vals[i], all_col_vals[j]), 0) for j in chi_cols]
                for i in chi_rows
            ])
            chi2, p, df, expected = chi2_contingency(observed)
            # #709: the expected table was computed and thrown away. Chi-square
            # is a large-sample approximation and it degrades when expected
            # counts are small — the conventional rule is >20% of cells below 5,
            # or any cell below 1. Both figures ride the payload rather than a
            # bare boolean, because "3 of 12 cells" is what a reader needs to
            # judge it, and a threshold with no number behind it is the kind of
            # warning people learn to dismiss.
            #
            # ⚠️ Computed on the SUBMATRIX, like the statistic itself (#591). A
            # structurally-empty level is not a sparse cell — it is a level
            # nobody was offered the chance to fill — so counting it here would
            # fire the warning on tables that are perfectly well-powered.
            n_cells = int(expected.size)
            cells_lt_5 = int((expected < 5).sum())
            min_expected = float(expected.min())
            low_expected_warning = (cells_lt_5 / n_cells > 0.2) or min_expected < 1
            # V's denominator must come from the SUBMATRIX too, or an empty
            # level inflates the table's dimensions and shrinks the effect size.
            min_dim = min(len(chi_rows), len(chi_cols)) - 1
            # #689: a degenerate table (a single effective row or column) gives
            # `min_dim == 0`, and V was reported as a measured 0 — "no
            # association" for a table that cannot express association at all.
            cramers_v = (
                finite_or_none(np.sqrt(chi2 / (n_shared * min_dim)), 3)
                if n_shared > 0 and min_dim > 0 else None
            )
            # Fisher's exact, 2x2 only — offered whenever the shape allows it,
            # not only when the warning fires, so the researcher can compare the
            # two p-values rather than being handed a replacement.
            fisher_p = None
            if len(chi_rows) == 2 and len(chi_cols) == 2:
                from scipy.stats import fisher_exact
                fisher_p = finite_or_none(fisher_exact(observed)[1], 4)
            chi_result = {
                "statistic": finite_or_none(chi2, 3),
                "p_value": finite_or_none(p, 4),
                "df": int(df),
                "cramers_v": cramers_v,
                "undefined_reason": None if cramers_v is not None else DEGENERATE,
                # #591: how many displayed levels the test could NOT use. The
                # table and the statistic now legitimately disagree about their
                # dimensions, so the payload says so rather than leaving the
                # researcher to infer it from df.
                "omitted_levels": omitted_levels,
                # #709: the sparsity disclosure. `cells_below_5` / `cell_count`
                # are the figures; `low_expected_warning` is the conventional
                # rule applied to them, sent so the client does not re-implement
                # a threshold the server already knows.
                "low_expected_warning": low_expected_warning,
                "cells_below_5": cells_lt_5,
                "cell_count": n_cells,
                "min_expected": round(min_expected, 2),
                # #709: Fisher's exact needs no large-sample assumption, so on
                # the table where it is defined it is not a caveat but an
                # answer. scipy implements it for 2x2 ONLY — an r x c version
                # would be a different (and much more expensive) computation, so
                # this is deliberately absent rather than approximated.
                "fisher_exact_p": fisher_p,
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
