"""#689 / #566 — an undefined statistic is `None` with a reason, never `0.0`.

**What the filed issue said, and what was actually there.** #689 described eight
sites collapsing an undefined quantity to a numeric zero — a correlation cell
reading `0.00` read as *no relationship*. That is real. But three of the four
degenerate inputs do not produce a wrong number at all; they produce a **500**:

    2 constant groups, different means   ->  Welch t = -inf, ANOVA F = inf
    2 constant groups, same mean         ->  t = nan, p = nan
    all values identical (ANOVA)         ->  ZeroDivisionError in the omega term
    constant x (scatter regression)      ->  scipy linregress RAISES ValueError
    all values identical (Kruskal)       ->  H = nan  — the NON-parametric path,
                                             i.e. the robust alternative a
                                             researcher switches to after the
                                             first failure, fails the same way

and starlette renders every response with ``allow_nan=False``, so an ``inf`` or
``nan`` that reaches the wire raises at *response* time. None of this is exotic
input: an item everyone answered identically, a derived flag that is all-1 after
a filter, a subgroup selection that removes the variation.

**The strict-JSON assertion below is the load-bearing one.** Asserting "the
service returns None" pins the convention; asserting the payload survives
``json.dumps(..., allow_nan=False)`` pins the thing that was actually broken,
and it keeps holding for a statistic added later.
"""
import json
import math

import pytest

from app.services.comparisons import _run_test, _run_anova, _run_t_test
from app.services.correlations import _compute_regression, _empty_regression
from app.services.statistical_tests import pooled_cohens_d
from app.services.undefined_stats import (
    DEGENERATE,
    EMPTY_GROUP,
    INSUFFICIENT_N,
    NO_VARIANCE,
    UNDEFINED_REASONS,
    finite_or_none,
)


# ── The formatter's own contract ─────────────────────────────────────────────


def test_finite_or_none_keeps_a_real_measured_zero():
    """The falsy-zero trap, pinned. `if not value` would blank a true 0.0 —
    a defect this project has already shipped twice."""
    assert finite_or_none(0.0) == 0.0
    assert finite_or_none(0) == 0.0
    assert finite_or_none(-0.5, 2) == -0.5


def test_finite_or_none_rejects_exactly_what_cannot_be_serialized():
    assert finite_or_none(float("inf")) is None
    assert finite_or_none(float("-inf")) is None
    assert finite_or_none(float("nan")) is None
    assert finite_or_none(None) is None


# ── Group comparison: every degenerate input declines, and says why ──────────

DEGENERATE_CASES = [
    # (name, grouped, test_type, nonparametric, expected reason)
    ("two constant groups, different means",
     {"a": [5.0] * 4, "b": [7.0] * 4}, "independent_t_test", False, NO_VARIANCE),
    ("two constant groups, same mean",
     {"a": [5.0] * 4, "b": [5.0] * 4}, "independent_t_test", False, NO_VARIANCE),
    ("ANOVA over internally-constant groups",
     {"a": [5.0] * 4, "b": [7.0] * 4}, "one_way_anova", False, NO_VARIANCE),
    ("ANOVA where every value is identical",
     {"a": [5.0] * 3, "b": [5.0] * 3, "c": [5.0] * 3}, "one_way_anova", False, NO_VARIANCE),
    ("Kruskal-Wallis where every value is identical",
     {"a": [5.0] * 3, "b": [5.0] * 3}, "kruskal_wallis", True, NO_VARIANCE),
    ("a group with no usable values",
     {"a": [1.0, 2.0, 3.0], "b": []}, "independent_t_test", False, EMPTY_GROUP),
    ("a group with a single value (#566's case)",
     {"a": [1.0, 2.0, 3.0], "b": [9.0]}, "independent_t_test", False, INSUFFICIENT_N),
]


@pytest.mark.parametrize(
    "name,grouped,test_type,nonparametric,expected",
    DEGENERATE_CASES,
    ids=[c[0] for c in DEGENERATE_CASES],
)
def test_degenerate_comparisons_decline_with_a_reason(
    name, grouped, test_type, nonparametric, expected,
):
    """Pre-#689 these raised or returned a non-finite statistic — a 500 either
    way — except the two size cases, which returned a bare `None` the UI could
    not explain (#566)."""
    result, reason = _run_test(
        grouped, list(grouped), test_type, include_ci=True, nonparametric=nonparametric,
    )
    assert result is None, f"{name}: a degenerate input produced a result"
    assert reason == expected
    assert reason in UNDEFINED_REASONS


@pytest.mark.parametrize(
    "name,grouped,test_type,nonparametric,expected",
    DEGENERATE_CASES,
    ids=[c[0] for c in DEGENERATE_CASES],
)
def test_degenerate_comparisons_never_reach_the_wire_unserializable(
    name, grouped, test_type, nonparametric, expected,
):
    """THE regression for the 500.

    ``allow_nan=False`` is starlette's default (`JSONResponse.render`), so a
    non-finite number in a payload raises while the response is being written —
    after the request has already succeeded. Serialize the way the framework
    does and the whole class is pinned, including for a statistic added later.
    """
    result, reason = _run_test(
        grouped, list(grouped), test_type, include_ci=True, nonparametric=nonparametric,
    )
    json.dumps({"test": result, "test_omitted_reason": reason}, allow_nan=False)


def test_a_healthy_comparison_is_untouched():
    """The fixture that proves the guards did not simply disable the feature."""
    result, reason = _run_test(
        {"a": [1.0, 2.0, 3.0], "b": [4.0, 5.0, 7.0]},
        ["a", "b"], "independent_t_test", include_ci=True,
    )
    assert reason is None
    assert result is not None
    assert math.isfinite(result["statistic"]) and math.isfinite(result["p"])
    assert result["effect_size"] < 0  # a is lower than b


def test_mann_whitney_still_reports_a_real_zero_effect():
    """Not every zero is undefined.

    Two groups drawn from the SAME varied distribution give U its expected value
    and a rank-biserial r of exactly 0.0 — a genuine measurement of no rank
    difference, on a test that is perfectly well defined. Blanking it would be the
    falsy-zero defect wearing the fix's clothes, and that is what this pins.

    ⚠️ The fixture used to be `[5.0] * 4` against `[5.0] * 4`, which measures
    something else entirely — see the test below. It passed only because scipy
    <1.18 returned p=1.0 there; the zero being protected was never the reason.
    """
    result, reason = _run_test(
        {"a": [1.0, 2.0, 3.0, 4.0], "b": [1.0, 2.0, 3.0, 4.0]}, ["a", "b"],
        "mann_whitney_u", include_ci=False, nonparametric=True,
    )
    assert reason is None
    assert result is not None and result["effect_size"] == 0.0


def test_mann_whitney_declines_when_every_value_is_identical():
    """All-tied input has no test to run, and scipy 1.18 says so.

    **This is a dependency-behaviour change, accepted deliberately rather than
    worked around.** `mannwhitneyu` on two all-identical groups returns:

        scipy 1.17  ->  p = 1.0     (finite, and misleading)
        scipy 1.18  ->  p = nan     (the honest answer)

    With every value tied there is no variance in the ranks, so there is nothing
    to test — 1.0 looked like a result and was not one. The chokepoint sees the
    non-finite p and declines the whole test, which is exactly the "a test is
    never half-defined" rule: the rank-biserial r is a real 0.0, but the test
    around it is not defined, so the pair goes together.

    ⚠️ This is why `scipy` is EXACT-pinned in `requirements.txt`. The divergence
    turned CI red for five consecutive pushes while every local run reported green,
    because the dev venv and the clean machine had resolved different versions of a
    ranged dependency. Do not restore the range to make a future version's
    behaviour "flexible" — flexibility is the defect here.

    ⚠️ It also retires a claim the internal design notes carried: *Mann-Whitney is safe by
    construction and is deliberately not special-cased.* Safe by construction was
    a property of scipy 1.17, not of the statistic.
    """
    result, reason = _run_test(
        {"a": [5.0] * 4, "b": [5.0] * 4}, ["a", "b"], "mann_whitney_u",
        include_ci=False, nonparametric=True,
    )
    assert reason == "no_variance"
    assert result is None


def test_anova_no_longer_divides_by_zero():
    """The omega term divided by `(ss_total + ms_within)` — `0 + 0` when every
    value is identical. The old `if ss_total > 0 else 0.0` guarded eta-squared
    only, which is why the issue recorded this as a wrong number rather than the
    unhandled ZeroDivisionError it was."""
    assert _run_anova({"a": [5.0] * 3, "b": [5.0] * 3}, ["a", "b"], include_ci=False) is None


def test_t_test_declines_rather_than_returning_an_unserializable_statistic():
    assert _run_t_test({"a": [5.0] * 4, "b": [7.0] * 4}, ["a", "b"], include_ci=True) is None


# ── Cohen's d: one implementation, two callers ───────────────────────────────


def test_pooled_cohens_d_is_none_without_a_scale_to_measure_on():
    assert pooled_cohens_d(5.0, 0.0, 4, 7.0, 0.0, 4) is None


def test_pooled_cohens_d_matches_the_hand_computation():
    # s1 = s2 = 1 -> pooled sd 1 -> d is the raw mean difference.
    assert pooled_cohens_d(6.0, 1.0, 5, 5.0, 1.0, 5) == pytest.approx(1.0, abs=1e-9)


def test_both_callers_share_one_cohens_d_implementation():
    """#733: a second copy does not merely drift — it propagates a defect
    verbatim, which is exactly what happened here (both copies collapsed an
    undefined d to 0.0 identically). Pinned by source, because two correct
    copies pass every behavioural test.
    """
    from pathlib import Path
    import app.services.comparisons as comparisons_mod
    import app.services.statistical_tests as stats_mod

    for module in (comparisons_mod, stats_mod):
        src = Path(module.__file__).read_text(encoding="utf-8")
        assert "pooled_cohens_d(" in src, f"{module.__name__} does not use the shared helper"
        assert "pooled_sd = math.sqrt" not in src, (
            f"{module.__name__} has re-inlined the pooled-SD block"
        )


# ── Scatter regression: two degenerate directions, two different failures ────


def test_regression_survives_a_constant_x_which_scipy_refuses_outright():
    """`linregress` RAISES on a constant x — this was an unhandled 500 on the
    scatter surface whenever the horizontal variable did not vary."""
    reg = _compute_regression([2.0] * 5, [1.0, 2.0, 3.0, 4.0, 5.0])
    assert reg["slope"] is None and reg["r"] is None
    assert reg["undefined_reason"] == NO_VARIANCE
    json.dumps(reg, allow_nan=False)


def test_regression_survives_a_constant_y_which_scipy_answers_with_nan():
    """The other direction fails differently: slope 0.0 with r = nan, p = nan.
    A fixture covering only the x case would pass while this one 500s."""
    reg = _compute_regression([1.0, 2.0, 3.0, 4.0, 5.0], [2.0] * 5)
    assert reg["r"] is None and reg["p"] is None
    assert reg["undefined_reason"] == NO_VARIANCE
    json.dumps(reg, allow_nan=False)


def test_a_real_regression_is_untouched():
    reg = _compute_regression([1.0, 2.0, 3.0, 4.0], [2.0, 4.0, 6.0, 8.0])
    assert reg["r"] == pytest.approx(1.0)
    assert reg["slope"] == pytest.approx(2.0)
    assert reg["undefined_reason"] is None


def test_empty_regression_reports_no_fitted_line():
    """Was all-zeros, which draws a flat line through the origin and reports
    `r = 0.00` — a fitted model where nothing was fitted."""
    reg = _empty_regression()
    assert set(("slope", "intercept", "r_squared", "r", "p")) <= set(reg)
    assert all(reg[k] is None for k in ("slope", "intercept", "r_squared", "r", "p"))
    assert reg["undefined_reason"] in UNDEFINED_REASONS


# ── The saved-test path refuses loudly, because it WRITES its result ─────────


def test_saved_tests_refuse_rather_than_storing_infinity(db_session, monkeypatch):
    """`compute_independent_t_test` json.dumps its result into `result_data`.
    An unguarded non-finite t writes a literal `Infinity` into the database —
    invalid JSON that then 500s every later read of that test. This path already
    refuses n < 2 with a readable ValueError, so it refuses this the same way.
    """
    from app.services import statistical_tests as st

    class _FakeTest:
        target_id = 1
        config = None

    # Drive the arithmetic directly: the guard sits between scipy and the
    # result dict, and reproducing it needs no metric/dataset scaffolding.
    monkeypatch.setattr(st, "_resolve_grouped_values", lambda *a, **k: {
        "A": [5.0] * 4, "B": [7.0] * 4,
    })

    class _Metric:
        grouping_column_id = 1
        grouping_column_id_2 = None
        grouping_mode = "column"

    monkeypatch.setattr(
        st, "_parse_json", lambda *_a, **_k: {},
    )

    class _Query:
        def filter(self, *_a, **_k):
            return self

        def first(self):
            return _Metric()

    monkeypatch.setattr(db_session, "query", lambda *_a, **_k: _Query())

    with pytest.raises(ValueError, match="no variation"):
        st.compute_independent_t_test(db_session, _FakeTest())


# ── The reason vocabulary is closed ──────────────────────────────────────────


def test_the_reason_vocabulary_is_small_and_mirrored_on_the_client():
    """Every reason needs a sentence in `lib/stat-format.ts`; a code with no
    sentence renders as nothing, so drift here is silent on screen."""
    from pathlib import Path

    client = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "stat-format.ts"
    text = client.read_text(encoding="utf-8")
    for reason in UNDEFINED_REASONS:
        assert f"{reason}:" in text, f"`{reason}` has no sentence in stat-format.ts"
    assert DEGENERATE in UNDEFINED_REASONS  # used by cross-tabulation
