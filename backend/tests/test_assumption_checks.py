"""#525 — assumption checks beside the tests that assume them.

⚠️ Every degenerate expectation here was MEASURED against the pinned scipy
(1.18.0) rather than reasoned from the docs. The two that matter:
`shapiro([1, 2])` and `shapiro([4] * 5)` return **nan without raising**, and
`levene(one_group)` **raises** where the others return nan. A `nan` on the wire
is a 500 at response time (#689), so the point of these tests is that no path
returns one.
"""
import json
import math

import pytest

from app.services.assumption_checks import (
    LEVENE_CENTER_MEDIAN,
    MIN_SHAPIRO_N,
    normality_check,
    variance_homogeneity_check,
)
from app.services.undefined_stats import (
    EMPTY_GROUP,
    INSUFFICIENT_N,
    NO_VARIANCE,
)


class TestNormality:
    def test_computes_for_an_ordinary_group(self):
        r = normality_check([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        assert r["statistic"] is not None and r["p"] is not None
        assert r["undefined_reason"] is None

    def test_empty_group_is_refused_with_a_reason(self):
        assert normality_check([])["undefined_reason"] == EMPTY_GROUP

    @pytest.mark.parametrize("vals", [[1.0], [1.0, 2.0]])
    def test_below_the_minimum_n_is_refused_not_nan(self, vals):
        # scipy returns nan here WITHOUT raising — the quiet failure.
        r = normality_check(vals)
        assert r["undefined_reason"] == INSUFFICIENT_N
        assert r["statistic"] is None and r["p"] is None

    def test_a_constant_group_is_refused_as_no_variance(self):
        r = normality_check([4.0] * 30)
        assert r["undefined_reason"] == NO_VARIANCE

    def test_the_minimum_n_actually_computes(self):
        # Pins MIN_SHAPIRO_N against scipy rather than against itself.
        assert normality_check([1.0, 2.0, 3.0][:MIN_SHAPIRO_N])["p"] is not None


class TestVarianceHomogeneity:
    def test_computes_across_two_ordinary_groups(self):
        r = variance_homogeneity_check([[1, 2, 3, 4, 5], [2, 4, 6, 8, 20]])
        assert r["statistic"] is not None and r["p"] is not None
        assert r["center"] == LEVENE_CENTER_MEDIAN

    def test_fewer_than_two_non_empty_groups_is_refused_not_a_raise(self):
        # scipy RAISES ValueError here; the service must not propagate it.
        assert variance_homogeneity_check([[1, 2, 3]])["undefined_reason"] == INSUFFICIENT_N
        assert variance_homogeneity_check([[1, 2, 3], []])["undefined_reason"] == INSUFFICIENT_N

    def test_all_groups_constant_is_refused_as_no_variance(self):
        assert variance_homogeneity_check([[5.0] * 10, [7.0] * 10])["undefined_reason"] == NO_VARIANCE

    def test_ONE_constant_group_among_varied_ones_still_computes(self):
        # This is a real variance difference, not a degenerate case — refusing
        # it would hide exactly the finding the test exists to surface.
        r = variance_homogeneity_check([[5.0] * 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]])
        assert r["undefined_reason"] is None
        assert r["p"] is not None

    def test_states_its_centre_because_the_mean_gives_a_different_number(self):
        r = variance_homogeneity_check([[1, 2, 3], [4, 5, 9]])
        assert r["center"] == LEVENE_CENTER_MEDIAN


class TestGroupsInTheComparisonButNotInTheTest:
    """#525b — a group can be shown and not tested, and that used to be silent.

    Same rule as the normality line, which already names what Shapiro-Wilk could
    not test: a count that quietly shrinks reads as a complete one.
    """

    def test_an_empty_group_is_NAMED_as_excluded(self):
        r = variance_homogeneity_check(
            [[1, 2, 3, 4], [2, 4, 6, 9], []], names=["North", "South", "East"]
        )
        assert r["excluded_groups"] == ["East"]
        assert r["undefined_reason"] is None

    def test_a_SINGLETON_group_is_named_because_its_deviation_is_zero_by_construction(self):
        # MEASURED: levene([1.0], [1,2,3,4], center="median") returns a
        # confident-looking p = 0.219 resting entirely on that structural zero.
        r = variance_homogeneity_check([[1.0], [1, 2, 3, 4]], names=["Solo", "Rest"])
        assert r["singleton_groups"] == ["Solo"]
        assert r["p"] is not None, "it still computes — naming is not refusing"

    def test_the_two_cases_are_DISTINCT_not_one_bucket(self):
        # A fixture carrying only one of them cannot tell the arms apart, so a
        # reader keyed on the wrong list would still look right (#709's rule).
        r = variance_homogeneity_check(
            [[], [7.0], [1, 2, 3, 4]], names=["Empty", "Solo", "Rest"]
        )
        assert r["excluded_groups"] == ["Empty"]
        assert r["singleton_groups"] == ["Solo"]

    def test_a_refusal_still_carries_the_group_lists(self):
        # Every return path attaches them — the arity lesson at function scale.
        r = variance_homogeneity_check([[], []], names=["A", "B"])
        assert r["undefined_reason"] == INSUFFICIENT_N
        assert r["excluded_groups"] == ["A", "B"]

    def test_names_are_optional_so_the_function_stays_pure_statistics(self):
        r = variance_homogeneity_check([[1, 2, 3, 4], [2, 4, 6, 9]])
        assert r["excluded_groups"] == [] and r["singleton_groups"] == []

    def test_the_PRODUCTION_caller_passes_names(self):
        """Otherwise the lists are always empty and the feature is invisible.

        A service-level test of the naming proves the function can do it, never
        that the pipeline asks it to (the #747 → #757 rule).
        """
        import inspect

        from app.services import comparisons

        src = inspect.getsource(comparisons.compute_group_comparison)
        assert "names=unique_groups" in src


class TestNothingNonFiniteReachesTheWire:
    """The #689 rule: starlette renders with allow_nan=False, so a nan is a 500."""

    CASES = [
        [], [1.0], [1.0, 2.0], [4.0] * 5, [1, 2, 3], list(range(30)),
    ]

    def test_normality_is_always_serializable(self):
        for vals in self.CASES:
            r = normality_check(vals)
            json.dumps(r, allow_nan=False)
            for k in ("statistic", "p"):
                assert r[k] is None or math.isfinite(r[k])

    def test_variance_is_always_serializable(self):
        for a in self.CASES:
            for b in self.CASES:
                r = variance_homogeneity_check([a, b])
                json.dumps(r, allow_nan=False)
                for k in ("statistic", "p"):
                    assert r[k] is None or math.isfinite(r[k])


class TestCrossLanguageContract:
    """Constants hand-mirrored in TypeScript with no codegen (stated-basis family).

    The client's fallback for an unknown test name is to show it VERBATIM, which
    is right for an older payload and invisible for a newer one — so Python reads
    the `.ts`. TypeScript catches only the opposite direction.
    """

    def _ts(self, name: str) -> str:
        from pathlib import Path

        p = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / name
        assert p.exists(), f"the TS mirror moved: {p}"
        return p.read_text(encoding="utf-8")

    def test_test_names_and_centre_match(self):
        ts = self._ts("assumption-basis.ts")
        from app.services.assumption_checks import (
            NORMALITY_TEST_SHAPIRO,
            VARIANCE_TEST_LEVENE,
        )

        assert f"'{NORMALITY_TEST_SHAPIRO}'" in ts
        assert f"'{VARIANCE_TEST_LEVENE}'" in ts
        assert f"'{LEVENE_CENTER_MEDIAN}'" in ts

    def test_the_client_names_the_LEVENE_CENTRE_not_just_the_test(self):
        # A Levene figure without its centre is not reproducible: centring on
        # the mean gives a different number from the same data.
        ts = self._ts("assumption-basis.ts")
        assert "Brown" in ts and "Forsythe" in ts
        assert "${center}-centred" in ts  # the unknown-centre fallback

    def test_the_caveat_exists_in_BOTH_directions(self):
        # The decision: ship the number and the sentence together, or not at all.
        # Over-sensitivity at large n and no power at small n are different
        # failures and a researcher needs the one that applies to them.
        ts = self._ts("assumption-basis.ts")
        assert "SHAPIRO_OVERSENSITIVE_N" in ts
        assert "SHAPIRO_UNDERPOWERED_N" in ts
        assert "little power" in ts
        assert "too small" in ts
