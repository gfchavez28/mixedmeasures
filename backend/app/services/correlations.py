"""Correlation computation service.

Provides functions for computing correlation matrices, scatter data, and
scatter matrix data for pairs of dataset columns or analysis domains.
"""

import math

from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, DatasetValue, Dataset
from ..models.analysis_domain import AnalysisDomain
from ..models.row_score import RowScore
from ..models.metric import MetricDefinition
from .grouping import load_grouping_values


# ── Data loading helpers ─────────────────────────────────────────────────────


def _load_column_vectors(
    db: Session,
    column_ids: list[int],
    project_id: int,
) -> tuple[dict[int, dict[int, float]], list[tuple[int, str, str]]]:
    """Load numeric values for multiple columns, keyed by (column_id, row_id).

    Returns:
        values: {column_id: {row_id: value_numeric}}
        column_info: [(id, short_label, full_label), ...]
    """
    # Get column metadata — validate project ownership
    columns = (
        db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id.in_(column_ids), Dataset.project_id == project_id)
        .all()
    )
    col_map = {c.id: c for c in columns}

    # Preserve requested order
    column_info = []
    for cid in column_ids:
        c = col_map.get(cid)
        if c:
            label = c.column_name or c.column_text
            full = c.column_text
            column_info.append((c.id, label, full))

    valid_ids = [ci[0] for ci in column_info]
    if not valid_ids:
        return {}, []

    # Bulk load all numeric values
    rows = (
        db.query(
            DatasetValue.column_id,
            DatasetValue.row_id,
            DatasetValue.value_numeric,
        )
        .filter(
            DatasetValue.column_id.in_(valid_ids),
            DatasetValue.value_numeric.isnot(None),
        )
        .all()
    )

    values: dict[int, dict[int, float]] = {cid: {} for cid in valid_ids}
    for col_id, row_id, val in rows:
        values[col_id][row_id] = val

    return values, column_info


def _load_domain_vectors(
    db: Session,
    domain_ids: list[int],
    project_id: int,
) -> tuple[dict[int, dict[int, float]], list[tuple[int, str, str]]]:
    """Load per-row domain scores for multiple domains.

    Uses pre-computed RowScore records (via domain_aggregate metrics).

    Returns:
        values: {domain_id: {row_id: score}}
        domain_info: [(id, short_label, full_label), ...]
    """
    # Get domain metadata
    domains = (
        db.query(AnalysisDomain.id, AnalysisDomain.name)
        .filter(
            AnalysisDomain.id.in_(domain_ids),
            AnalysisDomain.project_id == project_id,
        )
        .all()
    )
    dom_map = {d.id: d for d in domains}

    domain_info = []
    for did in domain_ids:
        d = dom_map.get(did)
        if d:
            domain_info.append((d.id, d.name, d.name))

    valid_ids = [di[0] for di in domain_info]
    if not valid_ids:
        return {}, []

    # Find domain_aggregate metrics for these domains (ungrouped only)
    metrics = (
        db.query(MetricDefinition.id, MetricDefinition.input_source_id)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.metric_type == "domain_aggregate",
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(valid_ids),
            MetricDefinition.grouping_column_id.is_(None),
        )
        .all()
    )

    metric_to_domain = {m.id: m.input_source_id for m in metrics}
    if not metric_to_domain:
        return {}, domain_info

    # Bulk load row scores
    scores = (
        db.query(
            RowScore.metric_definition_id,
            RowScore.dataset_row_id,
            RowScore.score,
        )
        .filter(
            RowScore.metric_definition_id.in_(list(metric_to_domain.keys())),
            RowScore.score.isnot(None),
        )
        .all()
    )

    values: dict[int, dict[int, float]] = {did: {} for did in valid_ids}
    for metric_id, row_id, score in scores:
        domain_id = metric_to_domain[metric_id]
        values[domain_id][row_id] = score

    return values, domain_info


def _load_grouping_values(
    db: Session,
    group_column_id: int,
    row_ids: list[int],
    project_id: int | None = None,
) -> dict[int, str]:
    """Load group labels for rows from a demographic column.

    #384: delegates to the shared loader, which excludes recognized N/A values
    so they don't form a spurious color-group (missing rows fall to the default
    no-group color, as before).
    """
    return load_grouping_values(db, group_column_id, row_ids, project_id=project_id)


# ── Correlation matrix ───────────────────────────────────────────────────────


def compute_correlation_matrix(
    db: Session,
    project_id: int,
    column_ids: list[int],
    domain_ids: list[int],
    correlation_type: str,
    bonferroni: bool,
) -> dict:
    """Compute a full correlation matrix for selected columns or domains.

    Uses numpy for Pearson, scipy for Spearman. Handles pairwise deletion.
    """
    import numpy as np

    # Load data vectors
    if column_ids:
        values, var_info = _load_column_vectors(db, column_ids, project_id)
    elif domain_ids:
        values, var_info = _load_domain_vectors(db, domain_ids, project_id)
    else:
        return {"labels": [], "full_labels": [], "matrix": [], "adjusted_alpha": None, "num_comparisons": 0}

    if len(var_info) < 2:
        return {"labels": [], "full_labels": [], "matrix": [], "adjusted_alpha": None, "num_comparisons": 0}

    var_ids = [v[0] for v in var_info]
    labels = [v[1] for v in var_info]
    full_labels = [v[2] for v in var_info]
    k = len(var_ids)
    num_comparisons = k * (k - 1) // 2

    # Build pairwise correlation matrix
    matrix = [[None] * k for _ in range(k)]

    for i in range(k):
        # Diagonal
        n_diag = len(values.get(var_ids[i], {}))
        matrix[i][i] = {"r": 1.0, "p": 0.0, "n": n_diag}

        for j in range(i + 1, k):
            vi = values.get(var_ids[i], {})
            vj = values.get(var_ids[j], {})

            # Pairwise: rows where both have values
            common_ids = set(vi.keys()) & set(vj.keys())
            n = len(common_ids)

            if n < 3:
                cell = {"r": 0.0, "p": 1.0, "n": n}
                matrix[i][j] = cell
                matrix[j][i] = cell
                continue

            x = np.array([vi[rid] for rid in common_ids])
            y = np.array([vj[rid] for rid in common_ids])

            if correlation_type == "spearman":
                from scipy.stats import spearmanr
                r_val, p_val = spearmanr(x, y)
            else:
                # Pearson
                r_val = float(np.corrcoef(x, y)[0, 1])
                # Compute p-value from t-distribution
                if abs(r_val) >= 1.0:
                    p_val = 0.0
                else:
                    from scipy.stats import t as t_dist
                    t_stat = r_val * math.sqrt((n - 2) / (1 - r_val ** 2))
                    p_val = float(2 * t_dist.sf(abs(t_stat), df=n - 2))

            if math.isnan(r_val) or (isinstance(p_val, float) and math.isnan(p_val)):
                cell = {"r": 0.0, "p": 1.0, "n": n}
                matrix[i][j] = cell
                matrix[j][i] = cell
                continue

            r_val = round(float(r_val), 4)
            p_val = round(float(p_val), 6)

            if bonferroni:
                p_val = min(p_val * num_comparisons, 1.0)

            cell = {"r": r_val, "p": p_val, "n": n}
            matrix[i][j] = cell
            matrix[j][i] = cell

    adjusted_alpha = None
    if bonferroni and num_comparisons > 0:
        adjusted_alpha = round(0.05 / num_comparisons, 6)

    return {
        "labels": labels,
        "full_labels": full_labels,
        "matrix": matrix,
        "adjusted_alpha": adjusted_alpha,
        "num_comparisons": num_comparisons,
    }


# ── Scatter data (single pair) ──────────────────────────────────────────────


def compute_scatter_data(
    db: Session,
    project_id: int,
    x_id: int,
    y_id: int,
    id_type: str,
    group_column_id: int | None,
) -> dict:
    """Compute scatter data for a single pair of variables."""
    if id_type == "column":
        values, var_info = _load_column_vectors(db, [x_id, y_id], project_id)
    else:
        values, var_info = _load_domain_vectors(db, [x_id, y_id], project_id)

    if len(var_info) < 2:
        return {"x_label": "", "y_label": "", "x": [], "y": [], "record_ids": [],
                "groups": None, "n": 0, "regression": _empty_regression(), "group_regressions": None}

    x_label = var_info[0][2]  # full label
    y_label = var_info[1][2]

    vx = values.get(var_info[0][0], {})
    vy = values.get(var_info[1][0], {})

    common_ids = sorted(set(vx.keys()) & set(vy.keys()))
    n = len(common_ids)

    x_vals = [vx[rid] for rid in common_ids]
    y_vals = [vy[rid] for rid in common_ids]

    # Group labels
    groups = None
    group_regressions = None
    if group_column_id and common_ids:
        group_map = _load_grouping_values(db, group_column_id, common_ids, project_id)
        groups = [group_map.get(rid, "") for rid in common_ids]

        # Per-group regressions
        group_data: dict[str, tuple[list[float], list[float]]] = {}
        for i, rid in enumerate(common_ids):
            g = group_map.get(rid, "")
            if g not in group_data:
                group_data[g] = ([], [])
            group_data[g][0].append(x_vals[i])
            group_data[g][1].append(y_vals[i])

        group_regressions = {}
        for g, (gx, gy) in group_data.items():
            if len(gx) >= 3:
                group_regressions[g] = _compute_regression(gx, gy)

    regression = _compute_regression(x_vals, y_vals) if n >= 3 else _empty_regression()

    return {
        "x_label": x_label,
        "y_label": y_label,
        "x": x_vals,
        "y": y_vals,
        "record_ids": common_ids,
        "groups": groups,
        "n": n,
        "regression": regression,
        "group_regressions": group_regressions if group_regressions else None,
    }


# ── Scatter matrix (all pairs) ──────────────────────────────────────────────


def compute_scatter_matrix(
    db: Session,
    project_id: int,
    column_ids: list[int],
    domain_ids: list[int],
    id_type: str,
    group_column_id: int | None,
    max_variables: int,
) -> dict:
    """Compute scatter data for all lower-triangle pairs."""
    source_ids = column_ids if id_type == "column" else domain_ids
    truncated = len(source_ids) > max_variables
    source_ids = source_ids[:max_variables]

    if id_type == "column":
        values, var_info = _load_column_vectors(db, source_ids, project_id)
    else:
        values, var_info = _load_domain_vectors(db, source_ids, project_id)

    if len(var_info) < 2:
        return {"labels": [], "full_labels": [], "pairs": [], "truncated": truncated}

    var_ids = [v[0] for v in var_info]
    labels = [v[1] for v in var_info]
    full_labels = [v[2] for v in var_info]

    # Collect all row_ids across all variables for group loading
    all_row_ids: set[int] = set()
    for vid in var_ids:
        all_row_ids.update(values.get(vid, {}).keys())

    group_map: dict[int, str] = {}
    if group_column_id and all_row_ids:
        group_map = _load_grouping_values(db, group_column_id, list(all_row_ids), project_id)

    pairs = []
    for i in range(len(var_ids)):
        for j in range(i + 1, len(var_ids)):
            vi = values.get(var_ids[i], {})
            vj = values.get(var_ids[j], {})
            common_ids = sorted(set(vi.keys()) & set(vj.keys()))
            n = len(common_ids)

            x_vals = [vi[rid] for rid in common_ids]
            y_vals = [vj[rid] for rid in common_ids]

            groups = None
            if group_column_id:
                groups = [group_map.get(rid, "") for rid in common_ids]

            regression = _compute_regression(x_vals, y_vals) if n >= 3 else _empty_regression()

            pairs.append({
                "x_index": i,
                "y_index": j,
                "x_label": full_labels[i],
                "y_label": full_labels[j],
                "x": x_vals,
                "y": y_vals,
                "record_ids": common_ids,
                "groups": groups,
                "n": n,
                "regression": regression,
            })

    return {
        "labels": labels,
        "full_labels": full_labels,
        "pairs": pairs,
        "truncated": truncated,
    }


# ── Regression helper ────────────────────────────────────────────────────────


def _compute_regression(x: list[float], y: list[float]) -> dict:
    """Compute linear regression via scipy.stats.linregress."""
    from scipy.stats import linregress

    result = linregress(x, y)
    return {
        "slope": round(float(result.slope), 4),
        "intercept": round(float(result.intercept), 4),
        "r_squared": round(float(result.rvalue ** 2), 4),
        "r": round(float(result.rvalue), 4),
        "p": round(float(result.pvalue), 6),
    }


def _empty_regression() -> dict:
    return {"slope": 0.0, "intercept": 0.0, "r_squared": 0.0, "r": 0.0, "p": 1.0}
