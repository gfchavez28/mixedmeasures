"""Range bands on a recode rule — #823(d), 2026-08-31.

Banding a continuous variable without typing a row per distinct value: 72 rows
for GSS `age`, 39 on a 48-row Ferncrest dataset (#830(j)).

## What these tests are really defending

**The ORDER of the three match channels**, which is not arbitrary and is not
recoverable by reading either matcher alone:

1. the null set (declared-missing / recognized-N/A / — on an UNDECLARED column
   only — the definition's own `exclude_values`)
2. an explicit `mapping` key
3. the first matching range

⚠️ **Channel 1's parenthesis is not a detail, and getting it wrong is #861.** A
column's declaration has SOLE authority (#592 REPLACE), so on a declared column
the per-definition exclude channel never reaches the null set — #818 made
`Exclude` work there by removing the key from `mapping` instead, which dropped
the value into `unmapped`. A band caught that fall-through and scored a response
the researcher had excluded. The gate now lives in `recode.py::_band_output`,
shared by both matchers.

and **the agreement between the two backend matchers**. `compute_value` (per
cell, reached from a grid edit) and `plan_definition_over_column` (per distinct
value, reached from apply and from derive) are two implementations of one rule,
and #542b is the standing record of what it costs when they disagree: one cell
got two different numbers depending on which path computed it.
"""

import json

import pytest

from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.project import Project
from app.models.recode import OutputType, RecodeDefinition, RecodeType
from app.services.recode import (
    apply_definition_to_column,
    compute_value,
    get_unmapped_values,
    plan_definition_over_column,
)
from app.services.recode_ranges import (
    MAX_RECODE_RANGES,
    RangeBandError,
    normalize_ranges,
    parse_ranges,
    resolve_range_output,
)

#: Two adjacent bands with an open top — the shape a researcher actually writes.
AGE_BANDS = [
    {"lo": 18, "hi": 29, "output": "Under 30"},
    {"lo": 30, "hi": 44, "output": "30 to 44"},
    {"lo": 45, "hi": None, "output": "45 and over"},
]


@pytest.fixture
def age_column(db_session):
    """A continuous `age` column with a declared sentinel.

    ⚠️ The sentinel is the fixture's whole point. `-99` is INSIDE no band here,
    so a naive fixture would pass whatever the channel order was; `999` is
    inside the open-topped band, which is what makes the null-set-first rule
    falsifiable. Both are declared missing.
    """
    return _age_column(db_session, declared=True)


@pytest.fixture
def age_column_undeclared(db_session):
    """The same column with NO `missing_values` declaration (#861).

    ⚠️ The pair is the point, and one of them alone proves nothing. On an
    UNDECLARED column `exclude_values` reaches the null set, so an excluded
    response NULLs there; on a DECLARED one it does not, and the band gate is
    the only thing that stops it being scored. A test that only had the declared
    fixture would pass against "delete the exclude channel from the null set".
    """
    return _age_column(db_session, declared=False)


def _age_column(db_session, *, declared: bool):
    project = Project(id=1, name="Bands", user_id=1)
    db_session.add(project)
    db_session.flush()
    dataset = Dataset(id=1, project_id=project.id, name="Survey")
    db_session.add(dataset)
    db_session.flush()
    column = DatasetColumn(
        id=1, dataset_id=dataset.id, column_code="age", column_text="Age",
        column_type=ColumnType.NUMERIC, sequence_order=0, display_order=0,
        missing_values=(
            json.dumps([{"value": "-99"}, {"value": "999"}]) if declared else None
        ),
    )
    db_session.add(column)
    db_session.flush()

    for i, text in enumerate(["22", "35", "67", "-99", "999", "not stated"]):
        row = DatasetRow(id=i + 1, dataset_id=dataset.id)
        db_session.add(row)
        db_session.flush()
        db_session.add(DatasetValue(
            id=i + 1, row_id=row.id, column_id=column.id, value_text=text, value_numeric=None,
        ))
    db_session.flush()
    return db_session, column


def _definition(db, column, *, ranges, mapping=None, rtype=RecodeType.CATEGORY_GROUP,
                exclude_values=None):
    defn = RecodeDefinition(
        id=1, column_id=column.id, name="Age bands",
        recode_type=rtype,
        output_type=OutputType.CATEGORICAL if rtype == RecodeType.CATEGORY_GROUP else OutputType.NUMERIC,
        mapping=json.dumps(mapping or {}),
        ranges=json.dumps(ranges) if ranges is not None else None,
        exclude_values=json.dumps(exclude_values) if exclude_values else None,
    )
    db.add(defn)
    db.flush()
    return defn


class TestTheMatcher:
    def test_inclusive_at_both_ends(self):
        """"18 to 29" includes 18 and 29 — what a researcher means by writing it."""
        assert resolve_range_output("18", AGE_BANDS) == "Under 30"
        assert resolve_range_output("29", AGE_BANDS) == "Under 30"
        assert resolve_range_output("30", AGE_BANDS) == "30 to 44"

    def test_an_open_end_is_unbounded(self):
        assert resolve_range_output("120", AGE_BANDS) == "45 and over"

    def test_a_value_below_every_band_does_not_match(self):
        assert resolve_range_output("4", AGE_BANDS) is None

    def test_a_non_numeric_cell_never_matches(self):
        """Not an error — a labelled column simply has nothing to compare."""
        assert resolve_range_output("Very happy", AGE_BANDS) is None

    def test_it_parses_through_the_shared_cell_rule(self):
        """`_strip_numeric`, never a local float() — so "1,200" agrees with every
        other surface that turns a cell into a number."""
        assert resolve_range_output("1,200", [{"lo": 1000, "hi": 2000, "output": "High"}]) == "High"

    def test_overlap_is_resolved_by_ORDER_so_a_special_case_can_lead(self):
        bands = [
            {"lo": 65, "hi": 65, "output": "Exactly 65"},
            {"lo": 18, "hi": None, "output": "Adult"},
        ]
        assert resolve_range_output("65", bands) == "Exactly 65"
        assert resolve_range_output("66", bands) == "Adult"


class TestChannelOrder:
    """🔴 The three channels, and the order that makes them a rule."""

    def test_a_declared_sentinel_INSIDE_a_band_still_nulls(self, age_column):
        """The reason a range could not just be "another mapping entry".

        `999` sits inside the open-topped band. If the band were consulted first
        it would be counted as a 45-and-over respondent — a sentinel silently
        becoming data, which is the whole class #592 exists to prevent.
        """
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS)

        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}

        assert by_value["999"].kind == "null_set"
        assert by_value["999"].output is None
        # And it is REPORTED as overridden, so the researcher can see the band
        # would otherwise have claimed it.
        assert by_value["999"].missing_overridden is True

    def test_the_sentinel_outside_every_band_also_nulls(self, age_column):
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS)
        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}
        assert by_value["-99"].kind == "null_set"
        # ⚠️ NOT flagged as overridden — no band and no mapping key wanted it, so
        # nothing was overridden. The two sentinels differ on this and a fixture
        # with only one of them cannot tell.
        assert by_value["-99"].missing_overridden is False

    def test_an_explicit_mapping_key_beats_a_band(self, age_column):
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, mapping={"35": "Exactly 35"})

        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}

        assert by_value["35"].output == "Exactly 35"
        assert by_value["22"].output == "Under 30"

    def test_a_value_matching_neither_is_unmapped_not_an_error(self, age_column):
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS)
        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}
        assert by_value["not stated"].kind == "unmapped"


class TestTheDefinitionsOwnExcludeChannel:
    """🔴 #861 — a response the RULE excludes is not eligible for a band.

    Not implied by the channel order, and that is the whole finding. A column's
    declaration has sole authority over the null set (#592 REPLACE), so on a
    declared column `exclude_values` never reaches it; #818 made `Exclude` work
    there by removing the key from `mapping`, dropping the value into `unmapped`
    — which the apply path NULLs and REPORTS. A covering band caught that
    fall-through and scored the response instead.

    MEASURED before the fix, against the live corpus: GSS `age` (declared, 6
    rules) with `exclude_values: ["25"]` and a band `18–44 → 1` planned `"25"` as
    `('mapped', 1.0)`.
    """

    def test_an_excluded_response_a_band_covers_is_NOT_scored(self, age_column):
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, exclude_values=["35"])

        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}

        assert by_value["35"].kind == "unmapped", (
            "a response the rule excludes was given the band's value — #861"
        )
        assert by_value["35"].output is None

    def test_a_NON_excluded_response_in_the_same_band_still_bands(self, age_column):
        """The positive control, and it is what keeps the fix per-VALUE.

        A guard that switched the range channel off whenever `exclude_values` is
        non-empty would pass the test above and delete the feature.
        """
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, exclude_values=["35"])

        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}

        # `22` and `35` are both inside a band; only one of them is excluded.
        assert by_value["22"].kind == "mapped"
        assert by_value["22"].output == "Under 30"

    def test_both_matchers_agree_about_the_excluded_response(self, age_column):
        """#542b. `compute_value` is reached from a grid edit, the plan from apply."""
        from app.services.missing_values import parse_missing_rules
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, exclude_values=["35"])

        plan = {d.value_text: d.output for d in plan_definition_over_column(db, defn)}
        per_cell = compute_value("35", defn, parse_missing_rules(column.missing_values))

        assert per_cell is None
        assert per_cell == plan["35"]

    def test_on_an_UNDECLARED_column_the_exclude_still_reaches_the_null_set(
        self, age_column_undeclared
    ):
        """The other side of the pair — #592's behaviour is unchanged.

        ⚠️ This path does not run the new gate at all (the value NULLs in the
        null-set branch above it). It is here because the two arms are one rule:
        without it, "delete the exclude channel from `_effective_null_set_hit`"
        passes every other test in this class.
        """
        db, column = age_column_undeclared
        defn = _definition(db, column, ranges=AGE_BANDS, exclude_values=["35"])

        by_value = {d.value_text: d for d in plan_definition_over_column(db, defn)}

        assert by_value["35"].kind == "null_set"
        assert by_value["35"].output is None

    def test_the_excluded_response_is_DISCLOSED_as_unmapped(self, age_column):
        """#818's channel survives: NULL, and said out loud.

        `set_primary` reports `unmapped_values` to the researcher, so the
        response does not just quietly vanish — which is the property that made
        removing the mapping key an honest fix in the first place.
        """
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, exclude_values=["35"])

        assert "35" in get_unmapped_values(db, column.id, defn)

    def test_the_apply_path_writes_no_number_for_it(self, age_column):
        """End to end, because the plan is a means and the stored cell is the point."""
        db, column = age_column
        defn = _definition(db, column, ranges=[{"lo": 18, "hi": 44, "output": 1}],
                           rtype=RecodeType.SCALE_MAP, exclude_values=["35"])

        result = apply_definition_to_column(db, defn)
        db.flush()

        stored = {
            v.value_text: v.value_numeric
            for v in db.query(DatasetValue).filter(DatasetValue.column_id == column.id).all()
        }
        assert stored["35"] is None
        assert stored["22"] == 1.0
        assert "35" in result["unmapped"]


class TestTheTwoMatchersAgree:
    """#542b: one cell, one number, whichever path computed it."""

    @pytest.mark.parametrize("cell", ["22", "35", "67", "-99", "999", "not stated"])
    def test_compute_value_matches_the_plan(self, age_column, cell):
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, mapping={"35": "Exactly 35"})

        plan = {d.value_text: d.output for d in plan_definition_over_column(db, defn)}
        from app.services.missing_values import parse_missing_rules
        per_cell = compute_value(cell, defn, parse_missing_rules(column.missing_values))

        assert per_cell == plan[cell], (
            f"the per-cell and bulk paths disagree about {cell!r} — #542b"
        )

    def test_a_reverse_definition_never_bands_on_either_path(self, age_column):
        """A REVERSE reflects its source; it has no mapping of its own.

        The write path refuses bands on one, so this pins the READ side: a row
        that somehow carries them (a hand-edited database, a future field) must
        not start banding.
        """
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS, mapping={"22": 1},
                           rtype=RecodeType.REVERSE)

        plan = {d.value_text: d for d in plan_definition_over_column(db, defn)}

        assert plan["67"].kind == "unmapped"
        assert compute_value("67", defn) is None


class TestApplyWritesTheBands:
    def test_a_numeric_banding_applies_to_value_numeric(self, age_column):
        """A scale_map's bands write codes, exactly as a mapping would."""
        db, column = age_column
        defn = _definition(
            db, column, rtype=RecodeType.SCALE_MAP,
            ranges=[{"lo": 18, "hi": 44, "output": 1}, {"lo": 45, "hi": None, "output": 2}],
        )

        result = apply_definition_to_column(db, defn)
        db.flush()

        stored = {
            v.value_text: v.value_numeric
            for v in db.query(DatasetValue).filter(DatasetValue.column_id == column.id)
        }
        assert stored["22"] == 1.0
        assert stored["35"] == 1.0
        assert stored["67"] == 2.0
        assert stored["-99"] is None
        assert stored["999"] is None
        assert result["updated"] > 0

    def test_a_pure_range_rule_is_not_the_number_794_guards(self, age_column):
        """#794: `whens` empty means nothing matched and the apply is a no-op.

        A rule made only of bands has an EMPTY `mapping`, so it is exactly the
        shape that would trip a guard keyed on the mapping being empty. It must
        apply normally.
        """
        db, column = age_column
        defn = _definition(db, column, rtype=RecodeType.SCALE_MAP,
                           ranges=[{"lo": 0, "hi": 200, "output": 7}])
        assert json.loads(defn.mapping) == {}

        result = apply_definition_to_column(db, defn)

        assert result["updated"] > 0


class TestNormalizationAtTheWritePath:
    def test_bounds_may_be_open_at_either_end(self):
        assert normalize_ranges([{"lo": 18, "hi": None, "output": "Adult"}])[0]["hi"] is None
        assert normalize_ranges([{"lo": None, "hi": 17, "output": "Child"}])[0]["lo"] is None

    def test_a_range_with_no_bound_at_all_is_refused(self):
        with pytest.raises(RangeBandError, match="low or a high"):
            normalize_ranges([{"lo": None, "hi": None, "output": "?"}])

    def test_a_backwards_range_is_refused(self):
        with pytest.raises(RangeBandError, match="backwards"):
            normalize_ranges([{"lo": 50, "hi": 20, "output": "?"}])

    def test_a_band_with_no_output_is_refused(self):
        """Where this diverges from a missing-values range: there the label is
        optional display metadata, here the output IS the result."""
        with pytest.raises(RangeBandError, match="needs a value"):
            normalize_ranges([{"lo": 1, "hi": 2}])

    def test_a_non_finite_bound_is_refused(self):
        """A bare Infinity is not JSON-compliant and would 500 the response that
        tried to return it (#689)."""
        with pytest.raises(RangeBandError, match="finite"):
            normalize_ranges([{"lo": float("inf"), "hi": None, "output": "x"}])

    def test_a_scale_map_refuses_a_TEXT_output(self):
        """A scale map writes `value_numeric`; a named band there would land in
        `unmapped` at apply time with nothing the researcher could act on."""
        with pytest.raises(RangeBandError, match="must map to numbers"):
            normalize_ranges([{"lo": 1, "hi": 2, "output": "Low"}], allow_output_text=False)

    def test_a_scale_map_accepts_a_NUMERIC_STRING_output(self):
        """The editor's inputs are strings; "3" is a number a researcher typed."""
        assert normalize_ranges(
            [{"lo": 1, "hi": 2, "output": "3"}], allow_output_text=False
        ) == [{"lo": 1.0, "hi": 2.0, "output": 3.0}]

    def test_the_cap_refuses_a_paste(self):
        with pytest.raises(RangeBandError, match="At most"):
            normalize_ranges([{"lo": i, "hi": i, "output": i} for i in range(MAX_RECODE_RANGES + 1)])


class TestTheReadPathDegrades:
    """🔴 `parse_ranges` must never raise — it is on the STARTUP path.

    `apply_definition_to_column` is reached from `repair_reverse_recode_mappings`
    on every boot (#794), so a malformed stored value must degrade to "no bands"
    rather than take the app down on existing data.
    """

    @pytest.mark.parametrize("stored", [
        None, "", "not json", json.dumps(5), json.dumps({"lo": 1}),
        json.dumps([{"lo": "eighteen", "hi": 29, "output": "x"}]),
        json.dumps([{"lo": 1, "hi": 2}]),
        json.dumps([{"lo": None, "hi": None, "output": "x"}]),
    ])
    def test_malformed_storage_yields_no_bands_and_does_not_raise(self, stored):
        assert parse_ranges(stored) == []

    def test_a_well_formed_list_survives_the_round_trip(self):
        assert parse_ranges(json.dumps(AGE_BANDS)) == AGE_BANDS


class TestTheCrossLanguageContract:
    """🔴 Both matchers execute the SAME table — `fixtures/recode_range_cases.json`.

    The client mirrors this rule so the Data view's display lens can resolve a
    banded cell (without it the grid renders unmapped text while `value_numeric`
    holds the band's code — the #578 drift). Two implementations of one rule is
    exactly the #542b shape, and a case table living separately in each suite
    would drift the first time somebody fixed one side.

    ⚠️ The TS suite reads this same file. If you add a case here, run both.
    """

    def _cases(self):
        import pathlib
        raw = json.loads(
            (pathlib.Path(__file__).parent / "fixtures" / "recode_range_cases.json").read_text()
        )
        return raw["cases"]

    def test_the_fixture_is_not_empty(self):
        """The population self-check: a table that fails to load passes by
        finding nothing to run (#730)."""
        assert len(self._cases()) >= 25

    def test_the_table_covers_the_cell_shapes_that_hid_862(self):
        """🔴 A floor notices truncation and nothing else.

        This names the PROPERTY that was missing. Until #862 the table carried
        no glyph-bearing and no radix cell, so both suites passed green while
        the two parsers disagreed on **16 of 39** measured inputs — every
        currency and percent value among them. Keep in step with the TS twin.
        """
        values = [c["value"] for c in self._cases()]
        assert any(any(g in v for g in "$€£¥%") for v in values), (
            "no currency/percent cell in the contract table — the #862 hole"
        )
        assert any(v[:2].lower() in ("0x", "0b", "0o") for v in values), (
            "no radix literal in the contract table — the direction where the "
            "CLIENT was wider than the server"
        )

    def test_every_case(self):
        for case in self._cases():
            got = resolve_range_output(case["value"], case["ranges"])
            assert got == case["expected"], (
                f'{case["name"]}: {case["value"]!r} -> {got!r}, expected '
                f'{case["expected"]!r}'
            )

    def test_the_table_discriminates(self):
        """🔴 And the table could FAIL — the discrimination assertion (#707a).

        A contract fixture whose every case returns the same thing certifies
        nothing. This asserts the table contains both matches and non-matches,
        so a matcher stubbed to `return None` (or to always return the first
        band) dies on it.
        """
        cases = self._cases()
        assert any(c["expected"] is not None for c in cases)
        assert any(c["expected"] is None for c in cases)


class TestUnmappedValuesKnowsAboutBands:
    """🔴 FOUND BY DRIVING, not by a test — #823(d)'s fourth consumer.

    `get_unmapped_values` re-derived coverage from `mapping` ∪ `exclude_values`,
    which made it a FOURTH implementation of "does this rule cover this value?"
    beside the two backend matchers and the client's display lens. Bands were
    invisible to it, so a banding rule told the researcher every banded response
    was unmapped — measured on GSS `age`: **75 values reported unmapped by a rule
    whose three bands cover all of them.**

    It routes through `plan_definition_over_column` now, which is what makes the
    answer agree with what the apply actually does.
    """

    def test_a_banded_value_is_not_reported_unmapped(self, age_column):
        from app.services.recode import get_unmapped_values
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS)

        unmapped = get_unmapped_values(db, column.id, defn)

        assert "22" not in unmapped
        assert "35" not in unmapped
        assert "67" not in unmapped

    def test_a_genuinely_uncovered_value_IS_still_reported(self, age_column):
        """The discrimination assertion — a function that returned `[]` always
        would pass the test above."""
        from app.services.recode import get_unmapped_values
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS)

        assert "not stated" in get_unmapped_values(db, column.id, defn)

    def test_a_declared_sentinel_is_no_longer_called_unmapped(self, age_column):
        """The behaviour CORRECTION that came with the collapse.

        A sentinel the column declares missing is not a response the rule failed
        to map — it is one the rule is right to leave alone. It used to be listed
        unless it happened to sit in the definition's own `exclude_values`.
        """
        from app.services.recode import get_unmapped_values
        db, column = age_column
        defn = _definition(db, column, ranges=AGE_BANDS)

        unmapped = get_unmapped_values(db, column.id, defn)

        assert "-99" not in unmapped
        assert "999" not in unmapped
