"""Group comparison computation service.

Provides batch computation of group comparisons (t-test, ANOVA,
Mann-Whitney U, Kruskal-Wallis) for multiple variables against
a grouping demographic column.
"""

import logging
import math
import statistics

import numpy as np
from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetColumn
from .correlations import _load_column_vectors, _load_domain_vectors
from .grouping import load_grouping_values, order_value_labels
from .metrics import _t_critical
from .statistical_tests import (
    _classify_effect_cohens_d,
    _classify_effect_eta_squared,
)

logger = logging.getLogger(__name__)

# ── Effect size thresholds ──────────────────────────────────────────────────

_Z_CRIT_975 = 1.96  # z-approximation for 95% CI on Cohen's d SE (Hedges & Olkin)

RANK_BISERIAL_THRESHOLDS = {"small": 0.1, "medium": 0.3, "large": 0.5}


def _classify_effect_rank_biserial(r: float) -> str:
    r = abs(r)
    if r >= RANK_BISERIAL_THRESHOLDS["large"]:
        return "large"
    if r >= RANK_BISERIAL_THRESHOLDS["medium"]:
        return "medium"
    if r >= RANK_BISERIAL_THRESHOLDS["small"]:
        return "small"
    return "negligible"


def _classify_effect_epsilon_squared(eps2: float) -> str:
    """Classify epsilon-squared (ε²) — uses same thresholds as eta-squared."""
    return _classify_effect_eta_squared(eps2)


def _cohens_d_ci(d: float, n1: int, n2: int) -> tuple[float, float]:
    """Compute 95% CI for Cohen's d using Hedges & Olkin formula.

    Uses z = 1.96 approximation, which is standard for effect size CIs.
    """
    se = math.sqrt((n1 + n2) / (n1 * n2) + d ** 2 / (2 * (n1 + n2 - 2)))
    return (round(d - _Z_CRIT_975 * se, 4), round(d + _Z_CRIT_975 * se, 4))


def _mean_ci(values: list[float]) -> tuple[float, float]:
    """Compute 95% CI for the mean using t-distribution."""
    n = len(values)
    if n < 2:
        m = values[0] if values else 0.0
        return (m, m)
    m = statistics.mean(values)
    se = statistics.stdev(values) / math.sqrt(n)
    t_crit = _t_critical(n - 1)
    return (round(m - t_crit * se, 4), round(m + t_crit * se, 4))


# ── Main computation ────────────────────────────────────────────────────────


def compute_group_comparison(
    db: Session,
    project_id: int,
    column_ids: list[int],
    domain_ids: list[int],
    grouping_column_id: int,
    grouping_column_id_2: int | None,
    test_type: str,
    include_effect_size_ci: bool,
    exclude_groups: list[str] | None = None,
    nonparametric: bool = False,
) -> dict:
    """Compute group comparisons for all selected variables.

    Loads all data in batch, groups by demographic column in-memory,
    then runs t-test/ANOVA per variable.
    """
    # Determine source type
    if column_ids:
        values, var_info = _load_column_vectors(db, column_ids, project_id)
        source_type = "column"
    elif domain_ids:
        values, var_info = _load_domain_vectors(db, domain_ids, project_id)
        source_type = "domain"
    else:
        return {
            "groups": [], "group_column_label": "", "rows": [],
            "bonferroni_warning": False, "bonferroni_threshold": None,
        }

    if not var_info:
        return {
            "groups": [], "group_column_label": "", "rows": [],
            "bonferroni_warning": False, "bonferroni_threshold": None,
        }

    # Get grouping column label. #390: join Dataset.project_id so a foreign
    # column id can't resolve a label (defense-in-depth; matches correlations).
    group_col = (
        db.query(DatasetColumn.column_name, DatasetColumn.column_text)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id == grouping_column_id, Dataset.project_id == project_id)
        .first()
    )
    group_column_label = (group_col.column_name or group_col.column_text) if group_col else ""

    # Collect all row IDs across all variables
    all_row_ids: set[int] = set()
    for vid, _, _ in var_info:
        all_row_ids.update(values.get(vid, {}).keys())

    if not all_row_ids:
        return {
            "groups": [], "group_column_label": group_column_label, "rows": [],
            "bonferroni_warning": False, "bonferroni_threshold": None,
        }

    # Load grouping values for all rows
    group_map = _load_grouping_map(
        db, grouping_column_id, grouping_column_id_2, list(all_row_ids), project_id,
    )

    # Determine unique groups (#406: numeric group labels order numerically)
    unique_groups = order_value_labels(set(g for g in group_map.values() if g))

    # Filter out excluded groups
    if exclude_groups:
        excluded = set(exclude_groups)
        unique_groups = [g for g in unique_groups if g not in excluded]

    if len(unique_groups) < 2:
        return {
            "groups": unique_groups,
            "group_column_label": group_column_label,
            "rows": [],
            "bonferroni_warning": False,
            "bonferroni_threshold": None,
        }

    # Determine effective test type
    num_groups = len(unique_groups)
    effective_test = _resolve_test_type(test_type, num_groups, nonparametric=nonparametric)

    # Build comparison rows
    rows = []
    for var_id, label, full_label in var_info:
        var_values = values.get(var_id, {})

        # Split values by group
        grouped: dict[str, list[float]] = {g: [] for g in unique_groups}
        for row_id, val in var_values.items():
            g = group_map.get(row_id)
            if g and g in grouped:
                grouped[g].append(val)

        # Compute group stats
        group_stats = []
        for g in unique_groups:
            gvals = grouped[g]
            n = len(gvals)
            if n == 0:
                group_stats.append({
                    "group": g, "n": 0, "mean": 0.0, "sd": 0.0,
                    "median": None, "ci_lower": 0.0, "ci_upper": 0.0,
                })
                continue
            m = statistics.mean(gvals)
            sd = statistics.stdev(gvals) if n >= 2 else 0.0
            mdn = statistics.median(gvals)
            if nonparametric:
                ci_lower, ci_upper = None, None
            else:
                ci_lower, ci_upper = _mean_ci(gvals)
            group_stats.append({
                "group": g, "n": n,
                "mean": round(m, 4), "sd": round(sd, 4),
                "median": round(mdn, 4),
                "ci_lower": ci_lower, "ci_upper": ci_upper,
            })

        # Run statistical test
        test_result = _run_test(
            grouped, unique_groups, effective_test, include_effect_size_ci,
            nonparametric=nonparametric,
        )

        rows.append({
            "label": label,
            "full_label": full_label,
            "source_id": var_id,
            "source_type": source_type,
            "group_stats": group_stats,
            "test": test_result,
        })

    # Bonferroni warning
    num_comparisons = len(rows)
    bonferroni_warning = num_comparisons >= 5
    bonferroni_threshold = round(0.05 / num_comparisons, 6) if num_comparisons > 0 else None

    return {
        "groups": unique_groups,
        "group_column_label": group_column_label,
        "rows": rows,
        "bonferroni_warning": bonferroni_warning,
        "bonferroni_threshold": bonferroni_threshold,
    }


# ── Helpers ─────────────────────────────────────────────────────────────────


def _load_grouping_map(
    db: Session,
    grouping_column_id: int,
    grouping_column_id_2: int | None,
    row_ids: list[int],
    project_id: int | None = None,
) -> dict[int, str]:
    """Load group labels for rows, optionally compositing two columns.

    #384: recognized N/A values are excluded (via load_grouping_values) so they
    don't form a spurious comparison group; rows missing a primary group are
    dropped by the `if g` filter in the caller, as truly-missing values already are.
    #390: ``project_id`` threads an ownership join through load_grouping_values
    (defense-in-depth — matches the correlations path).
    """
    primary = load_grouping_values(db, grouping_column_id, row_ids, project_id=project_id)

    if not grouping_column_id_2:
        return primary

    # Secondary grouping — composite labels with " · " separator
    secondary = load_grouping_values(db, grouping_column_id_2, row_ids, project_id=project_id)

    composite: dict[int, str] = {}
    for rid in set(primary.keys()) | set(secondary.keys()):
        p = primary.get(rid)
        s = secondary.get(rid)
        if p and s:
            composite[rid] = f"{p} \u00b7 {s}"
        elif p:
            composite[rid] = p
        # If only secondary, skip — primary grouping is required

    return composite


def _resolve_test_type(test_type: str, num_groups: int, nonparametric: bool = False) -> str:
    """Resolve the effective test type based on group count and parametric preference."""
    if nonparametric:
        return "mann_whitney_u" if num_groups == 2 else "kruskal_wallis"
    if test_type == "auto":
        return "independent_t_test" if num_groups == 2 else "one_way_anova"
    if test_type == "t_test":
        return "independent_t_test"
    if test_type == "anova":
        return "one_way_anova"
    return "independent_t_test"


def _run_test(
    grouped: dict[str, list[float]],
    group_names: list[str],
    test_type: str,
    include_ci: bool,
    nonparametric: bool = False,
) -> dict | None:
    """Run a statistical test on grouped values."""
    # Non-parametric tests only need ≥1 per group; parametric need ≥2
    min_per_group = 1 if nonparametric else 2
    arrays = [grouped[g] for g in group_names]
    valid_arrays = [a for a in arrays if len(a) >= min_per_group]
    if len(valid_arrays) < 2:
        return None

    if test_type == "independent_t_test":
        return _run_t_test(grouped, group_names, include_ci)
    elif test_type == "one_way_anova":
        return _run_anova(grouped, group_names, include_ci)
    elif test_type == "mann_whitney_u":
        return _run_mann_whitney(grouped, group_names)
    elif test_type == "kruskal_wallis":
        return _run_kruskal_wallis(grouped, group_names)
    return None


def _run_t_test(
    grouped: dict[str, list[float]],
    group_names: list[str],
    include_ci: bool,
) -> dict | None:
    """Run Welch's t-test for 2-group comparison."""
    from scipy.stats import ttest_ind

    # For t-test, use first two groups
    if len(group_names) < 2:
        return None

    g1, g2 = group_names[0], group_names[1]
    v1, v2 = grouped[g1], grouped[g2]

    if len(v1) < 2 or len(v2) < 2:
        return None

    t_stat, p_value = ttest_ind(v1, v2, equal_var=False)

    n1, n2 = len(v1), len(v2)
    m1, m2 = statistics.mean(v1), statistics.mean(v2)
    s1, s2 = statistics.stdev(v1), statistics.stdev(v2)

    # Welch-Satterthwaite degrees of freedom
    se1_sq = s1 ** 2 / n1
    se2_sq = s2 ** 2 / n2
    if se1_sq + se2_sq > 0:
        denom = se1_sq ** 2 / (n1 - 1) + se2_sq ** 2 / (n2 - 1)
        df = (se1_sq + se2_sq) ** 2 / denom if denom > 0 else n1 + n2 - 2
    else:
        df = n1 + n2 - 2
    if not math.isfinite(df):
        df = n1 + n2 - 2

    # Cohen's d (pooled SD)
    pooled_var = ((n1 - 1) * s1 ** 2 + (n2 - 1) * s2 ** 2) / (n1 + n2 - 2)
    pooled_sd = math.sqrt(pooled_var) if pooled_var > 0 else 0
    cohens_d = (m1 - m2) / pooled_sd if pooled_sd > 0 else 0.0

    ci_lower, ci_upper = None, None
    if include_ci:
        ci_lower, ci_upper = _cohens_d_ci(cohens_d, n1, n2)

    return {
        "test_type": "independent_t_test",
        "statistic": round(float(t_stat), 4),
        "df": round(float(df), 4),
        "p": round(float(p_value), 6),
        "effect_size": round(cohens_d, 4),
        "effect_size_type": "cohens_d",
        "effect_size_label": _classify_effect_cohens_d(cohens_d),
        "effect_size_ci_lower": ci_lower,
        "effect_size_ci_upper": ci_upper,
    }


def _run_anova(
    grouped: dict[str, list[float]],
    group_names: list[str],
    include_ci: bool,
) -> dict | None:
    """Run one-way ANOVA for 3+ group comparison."""
    from scipy.stats import f_oneway

    arrays = [grouped[g] for g in group_names if len(grouped[g]) >= 2]
    if len(arrays) < 2:
        return None

    f_stat, p_value = f_oneway(*arrays)

    # Compute eta-squared
    all_vals = [v for arr in arrays for v in arr]
    grand_mean = statistics.mean(all_vals)
    ss_between = sum(
        len(arr) * (statistics.mean(arr) - grand_mean) ** 2
        for arr in arrays
    )
    ss_total = sum((v - grand_mean) ** 2 for v in all_vals)
    eta_squared = ss_between / ss_total if ss_total > 0 else 0.0

    total_n = sum(len(arr) for arr in arrays)
    k = len(arrays)
    df_between = k - 1
    df_within = total_n - k

    # Omega-squared (less biased than eta-squared)
    ss_within = ss_total - ss_between
    ms_within = ss_within / df_within if df_within > 0 else 0
    omega_sq = max((ss_between - df_between * ms_within) / (ss_total + ms_within), 0.0)

    # Post-hoc pairwise comparisons (Tukey HSD)
    post_hoc = None
    post_hoc_error = False
    try:
        post_hoc = _run_post_hoc(grouped, group_names)
    except Exception:
        logger.warning("Post-hoc computation failed for ANOVA", exc_info=True)
        post_hoc_error = True

    result = {
        "test_type": "one_way_anova",
        "statistic": round(float(f_stat), 4),
        "df": float(df_between),
        "df2": float(df_within),
        "p": round(float(p_value), 6),
        "effect_size": round(eta_squared, 4),
        "effect_size_type": "eta_squared",
        "effect_size_label": _classify_effect_eta_squared(eta_squared),
        "omega_squared": round(omega_sq, 4),
        "post_hoc": post_hoc,
        "effect_size_ci_lower": None,
        "effect_size_ci_upper": None,
    }
    if post_hoc_error:
        result["post_hoc_error"] = True
    return result


def _run_post_hoc(
    grouped: dict[str, list[float]],
    group_names: list[str],
) -> dict | None:
    """Run Tukey HSD post-hoc pairwise comparisons."""
    from statsmodels.stats.multicomp import pairwise_tukeyhsd

    values_array = []
    labels_array = []
    for g in group_names:
        for v in grouped[g]:
            values_array.append(v)
            labels_array.append(g)

    if len(values_array) < 3:
        return None

    result = pairwise_tukeyhsd(
        np.array(values_array), np.array(labels_array),
    )

    k = len(result.groupsunique)
    expected_pairs = k * (k - 1) // 2
    if len(result.meandiffs) != expected_pairs:
        logger.warning(
            "Post-hoc result length mismatch: expected %d pairs for %d groups, got %d",
            expected_pairs, k, len(result.meandiffs),
        )
        return None

    comparisons = []
    for i in range(len(result.groupsunique)):
        for j in range(i + 1, len(result.groupsunique)):
            idx = i * len(result.groupsunique) - i * (i + 1) // 2 + (j - i - 1)
            comparisons.append({
                "group_a": str(result.groupsunique[i]),
                "group_b": str(result.groupsunique[j]),
                "mean_diff": round(float(result.meandiffs[idx]), 4),
                "p": round(float(result.pvalues[idx]), 4),
                "ci_lower": round(float(result.confint[idx, 0]), 4),
                "ci_upper": round(float(result.confint[idx, 1]), 4),
            })

    return {
        "post_hoc_method": "tukey_hsd",
        "comparisons": comparisons,
    }


def _run_mann_whitney(
    grouped: dict[str, list[float]],
    group_names: list[str],
) -> dict | None:
    """Run Mann-Whitney U test for 2-group non-parametric comparison."""
    from scipy.stats import mannwhitneyu

    if len(group_names) < 2:
        return None

    g1, g2 = group_names[0], group_names[1]
    v1, v2 = grouped[g1], grouped[g2]

    if len(v1) < 1 or len(v2) < 1:
        return None

    u_stat, p_value = mannwhitneyu(v1, v2, alternative='two-sided')

    n1, n2 = len(v1), len(v2)
    # Rank-biserial correlation as effect size
    r = float(1 - (2 * u_stat) / (n1 * n2))

    return {
        "test_type": "mann_whitney_u",
        "statistic": round(float(u_stat), 4),
        "df": float(n1 + n2 - 2),
        "p": round(float(p_value), 6),
        "effect_size": round(r, 4),
        "effect_size_type": "rank_biserial_r",
        "effect_size_label": _classify_effect_rank_biserial(r),
        "effect_size_ci_lower": None,
        "effect_size_ci_upper": None,
    }


def _run_kruskal_wallis(
    grouped: dict[str, list[float]],
    group_names: list[str],
) -> dict | None:
    """Run Kruskal-Wallis H test for 3+ group non-parametric comparison."""
    from scipy.stats import kruskal

    arrays = [grouped[g] for g in group_names if len(grouped[g]) >= 1]
    if len(arrays) < 2:
        return None

    h_stat, p_value = kruskal(*arrays)

    k = len(arrays)
    n = sum(len(a) for a in arrays)
    # Epsilon-squared (ε²) as effect size — Tomczak & Tomczak (2014)
    eps2 = float(max((h_stat - k + 1) / (n - 1), 0.0)) if n > 1 else 0.0

    return {
        "test_type": "kruskal_wallis",
        "statistic": round(float(h_stat), 4),
        "df": float(k - 1),
        "p": round(float(p_value), 6),
        "effect_size": round(eps2, 4),
        "effect_size_type": "epsilon_squared",
        "effect_size_label": _classify_effect_epsilon_squared(eps2),
        "effect_size_ci_lower": None,
        "effect_size_ci_upper": None,
    }
