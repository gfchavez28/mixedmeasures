"""Missing data diagnostics service.

Provides functions for computing missing data summaries, patterns,
and Little's MCAR test for dataset columns.
"""

import logging
import math

from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetValue, DatasetRow, Dataset, VALUE_NUMERIC_TYPES
from ..services.dataset_import import _is_na

logger = logging.getLogger(__name__)


# ── Missingness classification ───────────────────────────────────────────────


def _classify_value(value_text: str | None) -> str:
    """Classify a value as 'empty', 'na', or 'valid'."""
    if value_text is None or value_text.strip() == "":
        return "empty"
    if _is_na(value_text):
        return "na"
    return "valid"


def _is_missing(classification: str, include_na: bool, include_empty: bool) -> bool:
    """Check if a classified value counts as missing given toggle settings."""
    if classification == "empty":
        return include_empty
    if classification == "na":
        return include_na
    return False


# ── Data loading ─────────────────────────────────────────────────────────────


def _load_raw_values(
    db: Session,
    column_ids: list[int],
    project_id: int,
) -> tuple[
    dict[int, dict[int, tuple[str | None, float | None]]],
    list[dict],
    dict[int, set[int]],
]:
    """Load all values (including NULL) for multiple columns.

    Returns:
        values: {col_id: {row_id: (value_text, value_numeric)}}
        column_meta: [{'id', 'column_name', 'column_text', 'dataset_id',
                       'dataset_name', 'question_type'}, ...]
        dataset_rows: {dataset_id: set(row_ids)} — all rows per dataset
    """
    # Column metadata with project ownership validation
    columns = (
        db.query(
            DatasetColumn.id,
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            DatasetColumn.dataset_id,
            DatasetColumn.column_type,
            Dataset.name.label("dataset_name"),
        )
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id.in_(column_ids), Dataset.project_id == project_id)
        .all()
    )
    col_map = {c.id: c for c in columns}

    # Preserve requested order
    column_meta = []
    valid_ids = []
    dataset_ids_needed: set[int] = set()
    for cid in column_ids:
        c = col_map.get(cid)
        if c:
            column_meta.append({
                "id": c.id,
                "column_name": c.column_name or c.column_text,
                "column_text": c.column_text,
                "dataset_id": c.dataset_id,
                "dataset_name": c.dataset_name,
                "column_type": c.column_type,
            })
            valid_ids.append(c.id)
            dataset_ids_needed.add(c.dataset_id)

    if not valid_ids:
        return {}, [], {}

    # Load all DatasetValues for these columns (including NULLs)
    rows = (
        db.query(
            DatasetValue.column_id,
            DatasetValue.row_id,
            DatasetValue.value_text,
            DatasetValue.value_numeric,
        )
        .filter(DatasetValue.column_id.in_(valid_ids))
        .all()
    )

    values: dict[int, dict[int, tuple[str | None, float | None]]] = {
        cid: {} for cid in valid_ids
    }
    for col_id, row_id, val_text, val_num in rows:
        values[col_id][row_id] = (val_text, val_num)

    # Load all dataset row IDs per dataset
    dataset_rows: dict[int, set[int]] = {}
    if dataset_ids_needed:
        dr_rows = (
            db.query(DatasetRow.id, DatasetRow.dataset_id)
            .filter(DatasetRow.dataset_id.in_(list(dataset_ids_needed)))
            .all()
        )
        for row_id, ds_id in dr_rows:
            dataset_rows.setdefault(ds_id, set()).add(row_id)

    return values, column_meta, dataset_rows


# ── Missing summary ─────────────────────────────────────────────────────────


def compute_missing_summary(
    db: Session,
    project_id: int,
    column_ids: list[int],
    include_na: bool = True,
    include_empty: bool = True,
) -> dict:
    """Compute per-variable missing data statistics."""
    values, column_meta, dataset_rows = _load_raw_values(db, column_ids, project_id)

    if not column_meta:
        return {
            "variables": [],
            "total_rows": 0,
            "total_cells": 0,
            "total_missing": 0,
            "overall_pct_missing": 0.0,
        }

    variables = []
    total_cells = 0
    total_missing = 0
    all_row_ids: set[int] = set()

    for col in column_meta:
        cid = col["id"]
        ds_id = col["dataset_id"]
        all_rows = dataset_rows.get(ds_id, set())
        col_values = values.get(cid, {})
        all_row_ids |= all_rows

        n_total = len(all_rows)
        n_empty = 0
        n_na = 0
        n_missing = 0

        for row_id in all_rows:
            val = col_values.get(row_id)
            if val is None:
                # Row exists but no DatasetValue — treat as empty
                cls = "empty"
            else:
                cls = _classify_value(val[0])

            if cls == "empty":
                n_empty += 1
            elif cls == "na":
                n_na += 1

            if _is_missing(cls, include_na, include_empty):
                n_missing += 1

        n_valid = n_total - n_missing
        pct = round(n_missing / n_total * 100, 1) if n_total > 0 else 0.0

        variables.append({
            "column_id": cid,
            "variable_name": col["column_name"],
            "full_label": col["column_text"],
            "dataset_id": ds_id,
            "dataset_name": col["dataset_name"],
            "column_type": col["column_type"],
            "n_total": n_total,
            "n_valid": n_valid,
            "n_missing": n_missing,
            "pct_missing": pct,
            "n_empty": n_empty,
            "n_na": n_na,
        })

        total_cells += n_total
        total_missing += n_missing

    overall_pct = round(total_missing / total_cells * 100, 1) if total_cells > 0 else 0.0

    return {
        "variables": variables,
        "total_rows": len(all_row_ids),
        "total_cells": total_cells,
        "total_missing": total_missing,
        "overall_pct_missing": overall_pct,
    }


# ── Missing patterns ────────────────────────────────────────────────────────


def compute_missing_patterns(
    db: Session,
    project_id: int,
    column_ids: list[int],
    include_na: bool = True,
    include_empty: bool = True,
    max_patterns: int = 50,
) -> dict:
    """Compute missing data patterns (requires single dataset)."""
    values, column_meta, dataset_rows = _load_raw_values(db, column_ids, project_id)

    if not column_meta:
        return {
            "column_ids": [],
            "column_labels": [],
            "patterns": [],
            "total_rows": 0,
            "n_unique_patterns": 0,
            "truncated": False,
        }

    # Validate single dataset
    ds_ids = {col["dataset_id"] for col in column_meta}
    if len(ds_ids) > 1:
        raise ValueError(
            f"Pattern analysis requires variables from a single dataset. "
            f"Selected columns span {len(ds_ids)} datasets."
        )

    ds_id = next(iter(ds_ids))
    all_rows = dataset_rows.get(ds_id, set())
    ordered_col_ids = [col["id"] for col in column_meta]

    # Build binary matrix
    pattern_counts: dict[tuple[bool, ...], int] = {}
    for row_id in all_rows:
        pattern = []
        for cid in ordered_col_ids:
            val = values.get(cid, {}).get(row_id)
            if val is None:
                cls = "empty"
            else:
                cls = _classify_value(val[0])
            pattern.append(_is_missing(cls, include_na, include_empty))
        key = tuple(pattern)
        pattern_counts[key] = pattern_counts.get(key, 0) + 1

    n_records = len(all_rows)
    n_unique = len(pattern_counts)

    # Sort by count desc
    sorted_patterns = sorted(pattern_counts.items(), key=lambda x: -x[1])
    truncated = len(sorted_patterns) > max_patterns
    sorted_patterns = sorted_patterns[:max_patterns]

    patterns = []
    for pat, count in sorted_patterns:
        pct = round(count / n_records * 100, 1) if n_records > 0 else 0.0
        patterns.append({
            "pattern": list(pat),
            "count": count,
            "pct": pct,
        })

    return {
        "column_ids": ordered_col_ids,
        "column_labels": [col["column_name"] for col in column_meta],
        "patterns": patterns,
        "total_rows": n_records,
        "n_unique_patterns": n_unique,
        "truncated": truncated,
    }


# ── Little's MCAR test ──────────────────────────────────────────────────────


def compute_littles_mcar(
    db: Session,
    project_id: int,
    column_ids: list[int],
    include_na: bool = True,
    include_empty: bool = True,
) -> dict:
    """Compute Little's MCAR test for selected variables."""
    import numpy as np

    values, column_meta, dataset_rows = _load_raw_values(db, column_ids, project_id)

    # ── Eligibility checks ───────────────────────────────────────────────

    def _ineligible(reason: str) -> dict:
        return {"eligibility": {"eligible": False, "reason": reason}, "result": None}

    if not column_meta:
        return _ineligible("No valid columns found.")

    # Both toggles off
    if not include_na and not include_empty:
        return _ineligible("No missingness definitions enabled.")

    # Single dataset check
    ds_ids = {col["dataset_id"] for col in column_meta}
    if len(ds_ids) > 1:
        return _ineligible("MCAR test requires variables from a single dataset.")

    # Filter to numeric-operand columns (ordinal, numeric, percentage, binary).
    # MCAR needs reliably-populated value_numeric, so this is VALUE_NUMERIC_TYPES
    # (the operand concept, incl. binary) — NOT the scale-score concept. #399.
    eligible_cols = [c for c in column_meta if c["column_type"] in VALUE_NUMERIC_TYPES]
    removed_cols = len(column_meta) - len(eligible_cols)

    if len(eligible_cols) == 0:
        return _ineligible("No ordinal or numeric variables in selection.")
    if len(eligible_cols) < 2:
        return _ineligible("MCAR test requires at least 2 ordinal or numeric variables.")

    ds_id = next(iter(ds_ids))
    all_rows = sorted(dataset_rows.get(ds_id, set()))
    n = len(all_rows)
    if n == 0:
        return _ineligible("No records found.")

    ordered_col_ids = [c["id"] for c in eligible_cols]
    p = len(ordered_col_ids)

    # Build numeric matrix (n × p) with np.nan for missing
    row_idx = {rid: i for i, rid in enumerate(all_rows)}
    data_matrix = np.full((n, p), np.nan)

    for j, cid in enumerate(ordered_col_ids):
        col_vals = values.get(cid, {})
        for row_id in all_rows:
            val = col_vals.get(row_id)
            if val is None:
                cls = "empty"
            else:
                cls = _classify_value(val[0])

            if _is_missing(cls, include_na, include_empty):
                continue  # stays np.nan

            # Use value_numeric if available, else try parsing value_text
            if val is not None and val[1] is not None:
                data_matrix[row_idx[row_id], j] = val[1]
            elif val is not None and val[0] is not None:
                try:
                    data_matrix[row_idx[row_id], j] = float(val[0])
                except (ValueError, TypeError):
                    pass  # stays np.nan (non-numeric text)

    # Remove columns that are 100% missing
    col_missing_pct = np.isnan(data_matrix).mean(axis=0)
    fully_missing = col_missing_pct >= 1.0
    if fully_missing.any():
        keep = ~fully_missing
        data_matrix = data_matrix[:, keep]
        ordered_col_ids = [ordered_col_ids[i] for i in range(p) if keep[i]]
        removed_cols += int(fully_missing.sum())
        p = data_matrix.shape[1]
        if p < 2:
            return _ineligible("After removing fully-missing variables, fewer than 2 remain.")

    # Check for any missing data
    indicator = np.isnan(data_matrix)
    if not indicator.any():
        return _ineligible("No missing data detected — MCAR test is not applicable.")

    # Identify unique patterns
    pattern_strs = ["".join(str(int(x)) for x in row) for row in indicator]
    unique_patterns: dict[str, list[int]] = {}
    for i, ps in enumerate(pattern_strs):
        unique_patterns.setdefault(ps, []).append(i)

    if len(unique_patterns) < 2:
        return _ineligible("Only one missingness pattern — no variation to test.")

    # Check for at least one complete pattern
    complete_key = "0" * p
    if complete_key not in unique_patterns:
        return _ineligible(
            "No complete cases found. MCAR test requires at least some cases "
            "with no missing data for covariance estimation."
        )

    # ── Warning checks ───────────────────────────────────────────────────
    warning = None
    warnings_list = []

    if removed_cols > 0:
        warnings_list.append(
            f"{removed_cols} non-numeric or fully-missing variable(s) excluded."
        )

    if n < 50:
        warnings_list.append(
            f"Low statistical power: only {n} cases. "
            f"Results may be unreliable (recommend ≥50)."
        )

    # ── Algorithm ────────────────────────────────────────────────────────

    # Grand means: per-variable mean of observed values
    grand_means = np.nanmean(data_matrix, axis=0)

    # Pooled pairwise covariance matrix
    cov_matrix = np.zeros((p, p))
    cov_counts = np.zeros((p, p))
    for i in range(p):
        for j in range(i, p):
            mask = ~np.isnan(data_matrix[:, i]) & ~np.isnan(data_matrix[:, j])
            cnt = mask.sum()
            if cnt > 1:
                xi = data_matrix[mask, i] - grand_means[i]
                xj = data_matrix[mask, j] - grand_means[j]
                cov_val = np.dot(xi, xj) / (cnt - 1)
                cov_matrix[i, j] = cov_val
                cov_matrix[j, i] = cov_val
                cov_counts[i, j] = cnt
                cov_counts[j, i] = cnt

    # Replace undefined covariances (never co-observed) with 0
    cov_matrix[cov_counts == 0] = 0.0

    chi2 = 0.0
    df_total = 0
    pinv_used = 0

    for pat_key, row_indices in unique_patterns.items():
        n_j = len(row_indices)
        if n_j < 2:
            continue

        # Observed variable indices for this pattern
        obs_vars = [j for j, c in enumerate(pat_key) if c == "0"]
        if len(obs_vars) == 0:
            continue

        d = len(obs_vars)
        df_total += d

        # Subgroup means on observed variables
        sub_data = data_matrix[np.ix_(row_indices, obs_vars)]
        sub_means = np.nanmean(sub_data, axis=0)
        grand_sub = grand_means[obs_vars]

        diff = sub_means - grand_sub

        # Extract covariance submatrix
        cov_sub = cov_matrix[np.ix_(obs_vars, obs_vars)]

        # Invert
        try:
            cov_inv = np.linalg.inv(cov_sub)
        except np.linalg.LinAlgError:
            cov_inv = np.linalg.pinv(cov_sub)
            pinv_used += 1

        # Add to chi-square
        chi2 += float(n_j * diff @ cov_inv @ diff)

    if pinv_used > 0:
        warnings_list.append(
            f"Pseudo-inverse used for {pinv_used} pattern(s) "
            f"due to singular covariance submatrix."
        )

    # Degrees of freedom
    df = df_total - p
    if df <= 0:
        return _ineligible(
            "Insufficient data for MCAR test with the current "
            "missing data pattern (non-positive degrees of freedom)."
        )

    # Validate chi2 before computing p-value
    if not math.isfinite(chi2):
        return _ineligible(
            "Computation produced invalid results (likely due to "
            "insufficient variation or collinear variables)."
        )

    # p-value
    from scipy.stats import chi2 as chi2_dist

    p_val = float(chi2_dist.sf(chi2, df))
    if not math.isfinite(p_val):
        return _ineligible(
            "Computation produced an invalid p-value (likely due to "
            "insufficient variation or very sparse data)."
        )

    # Format p-value for APA \u2014 fmt_p carries its own operator so the template
    # never produces a bare "p .415" (#429): "< .001" or "= .415".
    if p_val < 0.001:
        fmt_p = "< .001"
    else:
        raw = f"{p_val:.3f}"
        fmt_p = "= " + (raw[1:] if raw.startswith("0") else raw)

    apa = f"\u03C7\u00B2({df}) = {chi2:.2f}, p {fmt_p}"
    interpretation = (
        "MCAR hypothesis rejected (p < .05)"
        if p_val < 0.05
        else "MCAR hypothesis not rejected (p \u2265 .05)"
    )

    if warnings_list:
        warning = " ".join(warnings_list)

    return {
        "eligibility": {
            "eligible": True,
            "reason": None,
            "warning": warning,
        },
        "result": {
            "chi2": round(chi2, 4),
            "df": df,
            "p": round(p_val, 6),
            "n": n,
            "n_patterns": len(unique_patterns),
            "n_variables": p,
            "apa_string": apa,
            "interpretation": interpretation,
        },
    }
