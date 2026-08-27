"""#522b — the box plot's five-number summary.

The quartile method is VERIFIED against R's published reference values rather
than asserted from the docstring: `quantile(1:10, type = 7)` gives
3.25 / 5.5 / 7.75, and `quantile(c(1,2,3,4), type = 7)` gives 1.75 / 2.5 / 3.25.
If Python's `method="inclusive"` ever stops matching type 7, these fail.
"""
import math

from app.services.comparisons import (
    MAX_OUTLIERS_PER_GROUP,
    QUARTILE_METHOD_TYPE7,
    WHISKER_RULE_TUKEY,
    box_summary,
)


class TestQuartileMethod:
    def test_matches_r_type7_reference_values(self):
        b = box_summary([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        assert (b["q1"], b["median"], b["q3"]) == (3.25, 5.5, 7.75)

    def test_matches_r_type7_on_the_four_point_case(self):
        b = box_summary([1, 2, 3, 4])
        assert (b["q1"], b["median"], b["q3"]) == (1.75, 2.5, 3.25)

    def test_states_its_own_conventions(self):
        b = box_summary([1, 2, 3, 4])
        assert b["quartile_method"] == QUARTILE_METHOD_TYPE7
        assert b["whisker_rule"] == WHISKER_RULE_TUKEY


class TestWhiskersAndOutliers:
    def test_tukey_whiskers_stop_at_the_last_point_inside_the_fence(self):
        # 1..9 plus a far outlier. IQR over the full set still fences out 100.
        b = box_summary([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])
        assert 100 in b["outliers"]
        assert b["whisker_high"] <= 9
        # The whisker is an OBSERVATION, never the fence itself.
        assert b["whisker_high"] in (9, 9.0)

    def test_no_outliers_means_whiskers_reach_the_extremes(self):
        b = box_summary([10, 11, 12, 13, 14])
        assert b["outliers"] == []
        assert b["whisker_low"] == 10
        assert b["whisker_high"] == 14

    def test_outliers_are_capped_and_the_remainder_is_REPORTED(self):
        # A silent truncation would read as "these are all the outliers".
        # ⚠️ The outliers must stay under 25% of n, or Q3 lands INSIDE them,
        # the IQR swallows the fence and nothing is an outlier at all — which is
        # what the first version of this fixture did (0 outliers, not 50).
        extra = MAX_OUTLIERS_PER_GROUP + 20
        vals = [50] * 300 + list(range(1000, 1000 + extra))
        b = box_summary(vals)
        assert len(b["outliers"]) == MAX_OUTLIERS_PER_GROUP
        assert b["outliers_omitted"] == 20


class TestDegenerate:
    def test_empty_group_has_no_box_at_all(self):
        assert box_summary([]) is None

    def test_single_observation_collapses_to_a_line_rather_than_failing(self):
        b = box_summary([7])
        assert b["q1"] == b["median"] == b["q3"] == 7
        assert b["outliers"] == []

    def test_zero_variance_gives_a_zero_width_box_and_no_outliers(self):
        # Every fence collapses onto the value; nothing can lie beyond it.
        b = box_summary([4] * 30)
        assert b["q1"] == b["q3"] == 4
        assert b["outliers"] == []
        assert b["whisker_low"] == b["whisker_high"] == 4

    def test_every_emitted_number_is_JSON_SERIALIZABLE(self):
        # The #689 rule: a non-finite float cannot be serialized, and starlette
        # renders with allow_nan=False, so one that reaches the wire is a 500 on
        # a request that computed fine.
        import json

        for vals in ([1], [1, 2], [4] * 5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]):
            b = box_summary(vals)
            json.dumps(b, allow_nan=False)
            for k in ("min", "q1", "median", "q3", "max", "whisker_low", "whisker_high"):
                assert b[k] is None or math.isfinite(b[k])


class TestCrossLanguageContract:
    """The constants are hand-mirrored in TypeScript with NO codegen.

    Required of every member of the stated-basis family (the internal design notes): the
    client's fallback for an unknown basis is to report it verbatim, which is
    correct for an older payload and INVISIBLE for a value a newer server sends.
    TypeScript catches only the opposite direction, so Python reads the `.ts`.
    """

    def _ts(self) -> str:
        from pathlib import Path

        p = (
            Path(__file__).resolve().parents[2]
            / "frontend" / "src" / "lib" / "box-plot-basis.ts"
        )
        assert p.exists(), f"the TS mirror moved: {p}"
        return p.read_text(encoding="utf-8")

    def test_quartile_method_constant_matches(self):
        assert f"'{QUARTILE_METHOD_TYPE7}'" in self._ts()

    def test_whisker_rule_constant_matches(self):
        assert f"'{WHISKER_RULE_TUKEY}'" in self._ts()

    def test_the_client_reports_an_unknown_convention_rather_than_relabelling(self):
        # The fallback arms must exist, or a newer server's method is silently
        # described as type 7 — the failure mode this family exists to prevent.
        ts = self._ts()
        assert "Quartiles: ${b.quartile_method}" in ts
        assert "whiskers: ${b.whisker_rule}" in ts
