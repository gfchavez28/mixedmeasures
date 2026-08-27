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

from ..models.dataset import Dataset, DatasetColumn, VALUE_NUMERIC_TYPES
from ..models.metric import MetricDefinition
from .correlations import _load_column_vectors, _load_domain_vectors
from .grouping import MISSING_GROUP_LABEL, load_grouping_values, order_value_labels
from .metrics import _Z_975, _t_critical
from .statistical_tests import (
    _classify_effect_cohens_d,
    _classify_effect_eta_squared,
    pooled_cohens_d,
)
from .assumption_checks import normality_check, variance_homogeneity_check
from .qq_plot import qq_summary
from .undefined_stats import (
    DEGENERATE,
    DOMAIN_SCORES_MISSING,
    DOMAIN_SCORES_NOT_COMPUTED,
    EMPTY_GROUP,
    INSUFFICIENT_GROUPS,
    INSUFFICIENT_N,
    NO_GROUP_VALUES,
    NO_VARIABLES,
    NO_VARIANCE,
    NOT_NUMERIC,
    finite_or_none,
)

logger = logging.getLogger(__name__)

# ── Effect size thresholds ──────────────────────────────────────────────────

# The 95% normal quantile for Cohen's d SE (Hedges & Olkin). Imported, never
# re-declared: this file used to hold its own `1.96` while `metrics.py` held
# another, so two CI computations in one app could drift apart on the same
# constant (#768, the #733 copies class). `_t_critical` already comes from the
# same module, so there is no new import edge.
_Z_CRIT_975 = _Z_975

RANK_BISERIAL_THRESHOLDS = {"small": 0.1, "medium": 0.3, "large": 0.5}


# ── Box-plot five-number summary (#522b) ───────────────────────────────────────

#: The quartile definition, STATED because several exist and they disagree on
#: small samples. Type 7 is R's `quantile()` default, and numpy's and pandas'.
#: VERIFIED against R's reference values rather than assumed:
#: `quantile(1:10, type=7)` gives 3.25 / 5.5 / 7.75, which is exactly what
#: `statistics.quantiles(method="inclusive")` returns.
QUARTILE_METHOD_TYPE7 = "type7_linear"

#: Whisker rule: Tukey's — each whisker reaches the most extreme observation
#: still within 1.5 x IQR of its hinge, and anything beyond is drawn as a point.
WHISKER_RULE_TUKEY = "tukey_1_5_iqr"

#: A pathological group (thousands of outliers) must not put thousands of points
#: on the wire or on the canvas. Past this the count is reported instead.
MAX_OUTLIERS_PER_GROUP = 50


def box_summary(values: list[float]) -> dict | None:
    """Five-number summary + Tukey whiskers + outliers for one group.

    ⚠️ The quartile METHOD and the whisker RULE ride the payload rather than
    being assumed by the client (the stated-basis family): a box plot is only
    interpretable if you know which convention drew it, and readers of a figure
    in a paper need to be told.

    ⚠️ **The trap to remember if this surface ever gains an R export**: R's
    `boxplot()` does NOT use `quantile(type=7)` — it uses `fivenum()`, i.e.
    Tukey HINGES, which differ on some sample sizes. Emitting a bare
    `boxplot(...)` alongside these numbers would put the tool and its own script
    in disagreement while each half looked right. Build the box from
    `quantile(x, type = 7)` instead. Today the comparisons panel is screen-only
    (no CSV, no Excel, and `export_r` emits saved StatisticalTest rows, not this
    panel), so nothing round-trips yet.
    """
    n = len(values)
    if n == 0:
        return None
    ordered = sorted(values)
    if n == 1:
        v = finite_or_none(ordered[0], 4)
        if v is None:
            return None
        return {
            "min": v, "q1": v, "median": v, "q3": v, "max": v,
            "whisker_low": v, "whisker_high": v, "outliers": [],
            "outliers_omitted": 0,
            "quartile_method": QUARTILE_METHOD_TYPE7,
            "whisker_rule": WHISKER_RULE_TUKEY,
        }

    q1_raw, med_raw, q3_raw = statistics.quantiles(ordered, n=4, method="inclusive")
    q1 = finite_or_none(q1_raw, 4)
    med = finite_or_none(med_raw, 4)
    q3 = finite_or_none(q3_raw, 4)
    if q1 is None or med is None or q3 is None:
        return None

    iqr = q3 - q1
    fence_lo = q1 - 1.5 * iqr
    fence_hi = q3 + 1.5 * iqr
    inside = [v for v in ordered if fence_lo <= v <= fence_hi]
    # `inside` is non-empty whenever iqr >= 0, because q1 and q3 are themselves
    # within the fences — but guard rather than reason, since a NaN input would
    # make every comparison False.
    whisker_low = finite_or_none(inside[0] if inside else ordered[0], 4)
    whisker_high = finite_or_none(inside[-1] if inside else ordered[-1], 4)

    out = [v for v in ordered if v < fence_lo or v > fence_hi]
    shown = [finite_or_none(v, 4) for v in out[:MAX_OUTLIERS_PER_GROUP]]
    shown = [v for v in shown if v is not None]
    return {
        "min": finite_or_none(ordered[0], 4),
        "q1": q1, "median": med, "q3": q3,
        "max": finite_or_none(ordered[-1], 4),
        "whisker_low": whisker_low,
        "whisker_high": whisker_high,
        "outliers": shown,
        "outliers_omitted": max(0, len(out) - len(shown)),
        "quartile_method": QUARTILE_METHOD_TYPE7,
        "whisker_rule": WHISKER_RULE_TUKEY,
    }


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

    Uses the normal quantile, which is standard for effect size CIs (the
    textbook writes it 1.96; `_Z_975` carries the exact value — #768).
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


def _no_comparison(
    reason: str,
    group_column_label: str = "",
    groups: list[str] | None = None,
) -> dict:
    """An empty comparison that says why (#823c · #827 · #830b family).

    Every early return from `compute_group_comparison` used to be the same
    shapeless `rows: []`, so the client had nothing to render but a guess — and
    the guess it made ("The selected demographic may have fewer than 2 groups")
    is right for exactly ONE of the ways this happens. The reason is computable
    at each of them, and it is the only thing the researcher needs.
    """
    return {
        "groups": groups or [],
        "group_column_label": group_column_label,
        "rows": [],
        "bonferroni_warning": False,
        "bonferroni_threshold": None,
        "unavailable_reason": reason,
    }


def _diagnose_no_rows(db: Session, project_id: int, domain_ids: list[int]) -> str:
    """Why a variable GROUP produced no per-row scores (#823c).

    Two states with different remedies: no scale-score metric exists at all
    (create one), or one exists and has never been computed (compute it). The
    researcher's undiscoverable fix for the second was to open Variable Groups
    and click a chip — nothing on the comparison screen said so.

    ⚠️ **Runs only on the failure path**, so the happy path pays nothing for it.
    ⚠️ **It must NOT compute the scores itself.** A GET that writes is the
    recompute-on-read hazard this codebase already decided against (DEC-C:
    SQLite lock races against the write-side sweep); the honest move is to name
    the action, and the client offers a button that calls the existing
    idempotent create-or-recompute endpoint.
    """
    if not domain_ids:
        return NO_VARIABLES
    metric_ids = [
        m.id for m in db.query(MetricDefinition.id)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.metric_type == "domain_aggregate",
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(domain_ids),
            MetricDefinition.grouping_column_id.is_(None),
        )
        .all()
    ]
    if not metric_ids:
        return DOMAIN_SCORES_MISSING
    return DOMAIN_SCORES_NOT_COMPUTED


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
    include_qq: bool = False,
) -> dict:
    """Compute group comparisons for all selected variables.

    Loads all data in batch, groups by demographic column in-memory,
    then runs t-test/ANOVA per variable.

    ⚠️ ``include_qq`` is OPT-IN, unlike every other diagnostic here, and the
    asymmetry is deliberate: `box_summary` and `normality_check` are O(1) in the
    group's size — about ten numbers each — while a QQ plot is O(n) points. On a
    2800-row dataset across five variables the unconditional version would build
    and serialize tens of thousands of pairs for the four chart types that never
    draw them. It is requested by the one panel that shows it.
    """
    # Determine source type
    if column_ids:
        values, var_info = _load_column_vectors(db, column_ids, project_id)
        source_type = "column"
    elif domain_ids:
        values, var_info = _load_domain_vectors(db, domain_ids, project_id)
        source_type = "domain"
    else:
        return _no_comparison(NO_VARIABLES)

    if not var_info:
        return _no_comparison(NO_VARIABLES)

    # Get grouping column label. #390: join Dataset.project_id so a foreign
    # column id can't resolve a label (defense-in-depth; matches correlations).
    group_col = (
        db.query(DatasetColumn.column_name, DatasetColumn.column_text)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id == grouping_column_id, Dataset.project_id == project_id)
        .first()
    )
    group_column_label = (group_col.column_name or group_col.column_text) if group_col else ""

    # #830(b): which of these variables can hold a number at all.
    #
    # A nominal column is a legitimate metric input (#371 — a frequency chart on
    # `School` is exactly right) and is offered in the same picker, so it reaches
    # this comparison from an ordinary selection. `_load_column_vectors` reads
    # `value_numeric`, which a nominal column has none of, so every group came
    # back n=0 — reported as `empty_group`, i.e. *"No values in this group, after
    # missing data was excluded"*, blaming the grouping and the missing data for
    # a type mismatch, once per group. The type is the reason and the type is
    # known here. ⚠️ Read `VALUE_NUMERIC_TYPES` (#399), never a hand-rolled list.
    non_numeric_ids: set[int] = set()
    if source_type == "column":
        non_numeric_ids = {
            cid for (cid, ctype) in db.query(DatasetColumn.id, DatasetColumn.column_type)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(DatasetColumn.id.in_([v[0] for v in var_info]),
                    Dataset.project_id == project_id)
            .all()
            if ctype not in VALUE_NUMERIC_TYPES
        }

    # Collect all row IDs across all variables
    all_row_ids: set[int] = set()
    for vid, _, _ in var_info:
        all_row_ids.update(values.get(vid, {}).keys())

    if not all_row_ids:
        # 🔴 #823(c). The grouping column has not been looked at yet, so any
        # sentence about its group count is a guess — and the one the client
        # used to print ("fewer than 2 groups") was exactly that. The variables
        # produced no rows; for a variable GROUP the reason is recoverable and
        # actionable, so recover it.
        return _no_comparison(
            _diagnose_no_rows(db, project_id, domain_ids) if source_type == "domain"
            else NO_VARIABLES,
            group_column_label,
        )

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
        # 🔴 #827. "Fewer than 2 groups" is true here only when the grouping
        # column HAS values on these rows. When it has none, the cause is that
        # the analysis and the grouping column do not share rows at all — the
        # cross-dataset case — and telling a researcher their 3-group variable
        # has fewer than 2 groups sends them to inspect data that is fine.
        return _no_comparison(
            INSUFFICIENT_GROUPS if group_map else NO_GROUP_VALUES,
            group_column_label,
            unique_groups,
        )

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
                # #689: nobody in this group has a usable value. A mean of 0.0
                # with a zero-width CI is a measurement claim about people who
                # are not there — and `"median": None` already sat in this very
                # dict literal, so the module knew the convention and applied it
                # to one field out of five.
                group_stats.append({
                    "group": g, "n": 0, "mean": None, "sd": None,
                    "median": None, "ci_lower": None, "ci_upper": None,
                    "undefined_reason": NOT_NUMERIC if var_id in non_numeric_ids else EMPTY_GROUP,
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
                # #522b — the box plot's five-number summary. Computed here
                # because the client never receives the raw values: it gets this
                # summary, so quartiles cannot be derived downstream.
                "box": box_summary(gvals),
                # #525 — the panel offers "use the non-parametric test" and never
                # said whether the data needs one. Computed regardless of the
                # toggle: that is the whole point of showing it.
                "normality": normality_check(gvals),
            })

        # Run statistical test. #566: when it does not run, the row carries WHY
        # — a blank delta/p/d with no explanation is indistinguishable from a
        # broken tool, and this is the single most common honest refusal
        # (a group left with fewer than 2 values after missing-data exclusion).
        test_result, test_omitted_reason = _run_test(
            grouped, unique_groups, effective_test, include_effect_size_ci,
            nonparametric=nonparametric,
        )
        # The row's own refusal follows the same rule: `_run_test` can only see
        # empty lists and reports EMPTY_GROUP, which is a claim about the data.
        if test_result is None and var_id in non_numeric_ids:
            test_omitted_reason = NOT_NUMERIC

        rows.append({
            "label": label,
            "full_label": full_label,
            "source_id": var_id,
            "source_type": source_type,
            "group_stats": group_stats,
            "test": test_result,
            "test_omitted_reason": test_omitted_reason,
            # #525 — equal variances is a property of the COMPARISON, not of any
            # one group, so it rides the row rather than the group stats.
            "variance_homogeneity": variance_homogeneity_check(
                [grouped[g] for g in unique_groups], names=unique_groups
            ),
            # #525b — the QQ diagnostic is per-ROW for the same reason Levene is:
            # normality is a property of the model's residuals, not of any one
            # group. Opt-in because it is the only O(n) field in this payload.
            "qq": qq_summary({g: grouped[g] for g in unique_groups}) if include_qq else None,
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
        # Present on EVERY response, `None` when rows were produced — the client
        # branches on rows, and a field that only sometimes exists invites a
        # consumer to infer its absence means something.
        "unavailable_reason": None,
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
            # The RESIDUAL: a row with a primary group and no secondary value.
            # It used to be labelled with the bare primary name (#823l), which
            # in a crossed table sits directly beside `X · Under 45` and
            # `X · 45 and over` and reads as their MARGINAL TOTAL --
            # measured on GSS, `Associate/junior college` (n = 26) beside a true
            # marginal of 2,444. The rows are real and must not be dropped; what
            # was wrong is that nothing said which cell this was.
            #
            # The word comes from MISSING_GROUP_LABEL, never a literal: the
            # Excel export has labelled its own missing bucket since #506, and
            # two spellings of one concept is how an exported table and a
            # rendered one start disagreeing.
            composite[rid] = f"{p} · {MISSING_GROUP_LABEL}"
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
) -> tuple[dict | None, str | None]:
    """Run a statistical test, returning ``(result, omitted_reason)``.

    Exactly one of the two is set. A bare ``None`` used to be the whole answer,
    which is #566: the row rendered blank delta/p/d cells and the researcher had
    no way to tell "refused to compute, honestly" from "broken". The reason now
    travels with the omission.

    **Why the reason is per-TEST rather than per-value.** Measured, not assumed:
    whenever an effect size is undefined here the statistic is non-finite too
    (both groups constant ⇒ Welch t = ±inf or nan, ANOVA F likewise), so there
    is no case where a test is half-defined. One reason per omitted test covers
    every case, and the row-level field is what the screen and the CSV read.
    """
    # Non-parametric tests only need ≥1 per group; parametric need ≥2
    min_per_group = 1 if nonparametric else 2
    arrays = [grouped[g] for g in group_names]
    if len([a for a in arrays if a]) < 2:
        return None, EMPTY_GROUP
    if len([a for a in arrays if len(a) >= min_per_group]) < 2:
        return None, INSUFFICIENT_N

    if test_type == "independent_t_test":
        result = _run_t_test(grouped, group_names, include_ci)
    elif test_type == "one_way_anova":
        result = _run_anova(grouped, group_names, include_ci)
    elif test_type == "mann_whitney_u":
        result = _run_mann_whitney(grouped, group_names)
    elif test_type == "kruskal_wallis":
        result = _run_kruskal_wallis(grouped, group_names)
    else:
        return None, DEGENERATE

    if result is None:
        return None, NO_VARIANCE

    # ── The finiteness chokepoint ────────────────────────────────────────────
    # ONE check for all four runners rather than four copies, and it covers a
    # runner added later. Measured, all on real scipy calls:
    #   Welch t   constant groups, different means -> -inf ; same mean -> nan
    #   ANOVA F   internally-constant groups       ->  inf ; all equal  -> nan
    #   Kruskal H all values identical             ->  nan  (the NON-parametric
    #             path, i.e. the robust alternative a researcher switches to
    #             after the first failure, fails the same way)
    #   Mann-Whitney U is safe by construction (U is a rank count; its effect
    #             size divides by n1*n2, both ≥ 1) — deliberately not special-cased.
    # A non-finite number here is not a bad value, it is a 500: starlette's
    # JSONResponse renders with allow_nan=False and raises at RESPONSE time.
    for key in ("statistic", "p", "df", "df2", "effect_size"):
        value = result.get(key)
        if value is not None and finite_or_none(value) is None:
            logger.warning(
                "Non-finite %s from %s; reporting the test as undefined", key, test_type,
            )
            return None, NO_VARIANCE

    return result, None


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

    # Cohen's d (pooled SD) — single-sourced with the saved-test path, which
    # carried a byte-identical copy of this block (#733: a copy propagates a
    # defect verbatim, it does not merely drift). Unreachable-by-construction
    # here now that a non-finite t has already returned, but the helper is the
    # thing both callers share.
    cohens_d = pooled_cohens_d(m1, s1, n1, m2, s2, n2)
    if cohens_d is None:
        return None

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
    # ⚠️ `ss_total == 0` means every value in every group is identical. The old
    # `if ss_total > 0 else 0.0` guarded eta-squared only, and the omega term
    # below divides by `(ss_total + ms_within)` — which is 0 + 0 — so this case
    # raised ZeroDivisionError, an unhandled 500, NOT the "eta = 0.0" the issue
    # described. The finiteness guard above already returned for it; this stays
    # as the explicit statement of the invariant the omega line depends on.
    if ss_total <= 0:
        return None
    eta_squared = ss_between / ss_total

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
        # #742: omega-squared gets its OWN label. Both comparison surfaces
        # DISPLAY omega and were printing the eta-derived word beside it — and
        # omega <= eta always, so any pair straddling a threshold read e.g.
        # "omega^2 = 0.14 (large)" when 0.14 is the boundary eta cleared and
        # omega did not. Same classifier because both are the proportion of
        # variance explained on one scale, so Cohen's benchmarks apply to each.
        "omega_squared_label": _classify_effect_eta_squared(omega_sq),
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
