"""#592 slab 1 — the declared-missing model + predicate.

``DatasetColumn.missing_values`` (nullable JSON) + ``services/missing_values``
(parse/predicate pair). NULL = no declaration = the recognized-N/A ``_is_na``
defaults (which MOVED into the predicate module; ``dataset_import`` re-exports
them). A non-null declaration REPLACES the defaults (§I.7). Rules carry labels
(§I.2), the predicate keys on value_text only (§I.4), ranges evaluate in
Python — never SQL CAST (§I.8) — and discrete string values are legal
(.sav #541b).
"""
import json

import pytest

from app.models.dataset import Dataset, DatasetColumn, ColumnType
from app.models.project import Project
from app.services.missing_values import (
    _validate_rule,
    column_missing_rules,
    is_declared_missing,
    is_missing,
    is_missing_for_column,
    parse_missing_rules,
)


class TestParseMissingRules:
    def test_null_and_empty_mean_no_declaration(self):
        assert parse_missing_rules(None) is None
        assert parse_missing_rules("") is None

    def test_empty_list_is_a_real_declaration(self):
        """A stored "[]" declares that NOTHING is missing — distinct from
        None (= the defaults apply)."""
        assert parse_missing_rules("[]") == []

    def test_discrete_and_range_rules_parse(self):
        raw = json.dumps([
            {"value": "99", "label": "Refused"},
            {"value": "X"},
            {"lo": -99, "hi": -1},
            {"lo": None, "hi": 0, "label": "Sentinel"},
        ])
        assert parse_missing_rules(raw) == [
            {"value": "99", "label": "Refused"},
            {"value": "X"},
            {"lo": -99, "hi": -1},
            {"lo": None, "hi": 0, "label": "Sentinel"},
        ]

    def test_numeric_discrete_value_normalized_to_string(self):
        assert parse_missing_rules(json.dumps([{"value": 99}])) == [{"value": "99"}]

    def test_malformed_json_falls_back_to_defaults(self):
        assert parse_missing_rules("{not json") is None
        assert parse_missing_rules('{"value": "99"}') is None  # not a list

    @pytest.mark.parametrize("bad", [
        [{"value": ""}],                       # blank discrete value
        [{"value": "   "}],
        [{}],                                  # neither form
        [{"lo": None, "hi": None}],            # bound-less range
        [{"value": "99", "lo": 0, "hi": 5}],   # both forms at once
        [{"lo": "a", "hi": 5}],                # non-numeric bound
        [{"lo": True, "hi": 5}],               # bool bound (JSON true)
        [{"lo": 5, "hi": 1}],                  # inverted range
        [{"value": "99", "label": "   "}],     # blank label
        [{"value": "99", "label": 7}],         # non-string label
        ["99"],                                # rule is not a dict
        [{"value": "99"}, {"value": ""}],      # ONE bad entry poisons the lot
    ])
    def test_invalid_rule_ignores_whole_declaration(self, bad):
        """Whole-or-nothing: a partially-applied rule set silently changes
        statistics (the fail-open-aggregation trap) — invalid input falls all
        the way back to the defaults."""
        assert parse_missing_rules(json.dumps(bad)) is None


class TestIsDeclaredMissing:
    def test_discrete_code_match_stripped_exact(self):
        rules = [{"value": "99"}]
        assert is_declared_missing("99", rules)
        assert is_declared_missing(" 99 ", rules)
        assert not is_declared_missing("999", rules)

    def test_numeric_equality_bridges_formatting(self):
        assert is_declared_missing("99.0", [{"value": "99"}])
        assert is_declared_missing("99", [{"value": "99.0"}])

    def test_label_channel_reaches_substituted_cells(self):
        """§I.2/§I.3: a labelled-missing cell holds the LABEL in value_text
        after substitution — the rule carrying the label is what keeps such
        cells reachable."""
        rules = [{"value": "99", "label": "Refused"}]
        assert is_declared_missing("Refused", rules)
        assert is_declared_missing("99", rules)
        # Exact match, not case-insensitive — cells and declarations come from
        # the same pipeline; pinned as intent.
        assert not is_declared_missing("refused", rules)

    def test_string_discrete_value(self):
        """.sav string user-missing (#541b) — discrete strings are legal."""
        assert is_declared_missing("X", [{"value": "X"}])
        assert not is_declared_missing("Y", [{"value": "X"}])

    def test_range_hits_and_misses(self):
        rules = [{"lo": -99, "hi": -1}]
        assert is_declared_missing("-99", rules)
        assert is_declared_missing("-1", rules)
        assert is_declared_missing("-50.5", rules)
        assert not is_declared_missing("0", rules)
        assert not is_declared_missing("-100", rules)

    def test_unbounded_ranges(self):
        assert is_declared_missing("-500", [{"lo": None, "hi": -1}])
        assert is_declared_missing("1000", [{"lo": 900, "hi": None}])
        assert not is_declared_missing("899", [{"lo": 900, "hi": None}])

    def test_text_never_falls_in_a_numeric_range(self):
        """§I.8 — the SQL-CAST trap, pinned: CAST(value_text AS REAL) coerces
        non-numeric text to 0.0, so any range containing 0 would swallow every
        text cell. The Python evaluation must not reproduce that."""
        rules = [{"lo": -1, "hi": 1}]  # contains 0
        assert not is_declared_missing("Strongly agree", rules)
        assert is_declared_missing("0", rules)

    def test_range_label_is_display_only(self):
        """A range's label is metadata — labels substitute per-code, a range
        covers many codes, so the label channel is discrete-only."""
        assert not is_declared_missing(
            "Sentinel", [{"lo": -99, "hi": -1, "label": "Sentinel"}])

    def test_none_and_blank_are_not_declared_missing(self):
        rules = [{"value": "99"}]
        assert not is_declared_missing(None, rules)
        assert not is_declared_missing("", rules)
        assert not is_declared_missing("   ", rules)


class TestIsMissing:
    def test_no_declaration_uses_the_is_na_defaults(self):
        """The English-label lottery, pinned as the DEFAULT behavior: this
        asymmetry ("Prefer not" missing, "Refused" not) is exactly what #592
        exists to let researchers replace with a declaration."""
        assert is_missing("Prefer not to say", None)
        assert is_missing("N/A", None)
        assert not is_missing("Refused", None)
        assert not is_missing("99", None)

    def test_declaration_replaces_the_defaults(self):
        """§I.7 REPLACE semantics: a column declaring only 99 makes "Prefer
        not to say" a substantive answer on that column."""
        rules = [{"value": "99"}]
        assert is_missing("99", rules)
        assert not is_missing("Prefer not to say", rules)
        assert not is_missing("N/A", rules)

    def test_empty_declaration_means_nothing_is_missing(self):
        assert not is_missing("N/A", [])
        assert not is_missing("Prefer not to say", [])

    def test_none_text_is_never_missing_by_declaration(self):
        """NULL text is the separate "empty/absent" concept, not declared
        missing — the value pipeline owns it."""
        assert not is_missing(None, None)
        assert not is_missing(None, [{"value": "99"}])


class TestColumnAwareEntry:
    def _column(self, missing_values=None):
        return DatasetColumn(
            dataset_id=1, column_code="Q7", column_text="Q7",
            column_type=ColumnType.NUMERIC, sequence_order=0,
            missing_values=missing_values,
        )

    def test_null_column_declaration_uses_defaults(self):
        col = self._column(None)
        assert column_missing_rules(col) is None
        assert is_missing_for_column(col, "Prefer not to say")
        assert not is_missing_for_column(col, "99")

    def test_declared_column_uses_its_rules(self):
        col = self._column(json.dumps([
            {"value": "99", "label": "Refused"},
            {"lo": -99, "hi": -1},
        ]))
        assert is_missing_for_column(col, "99")
        assert is_missing_for_column(col, "Refused")
        assert is_missing_for_column(col, "-45")
        assert not is_missing_for_column(col, "Prefer not to say")  # REPLACE
        assert not is_missing_for_column(col, "3")


class TestReExportAndWire:
    def test_dataset_import_reexports_the_same_function(self):
        """Slab 1 moved _is_na into the predicate module; the re-export keeps
        every existing importer unchanged AND pointing at the ONE
        implementation (no fork)."""
        from app.services import dataset_import, missing_values
        assert dataset_import._is_na is missing_values._is_na
        assert dataset_import._NA_PREFIXES is missing_values._NA_PREFIXES

    def test_data_response_carries_missing_values(self):
        """The #586 shape: the /data sibling is splat-constructed and silently
        drops undeclared fields — missing_values must be declared on BOTH
        column schemas (slab 4's dialog reads /data)."""
        from app.schemas.dataset import (
            DatasetColumnResponse, DatasetDataColumnResponse,
        )
        base = DatasetColumnResponse(
            id=1, column_text="Q1", column_type="numeric", sequence_order=0,
            missing_values=[{"value": "99", "label": "Refused"}],
        )
        out = DatasetDataColumnResponse(**base.model_dump(), recode_definitions=[])
        assert out.missing_values == [{"value": "99", "label": "Refused"}]
        assert "missing_values" in out.model_dump()

    def test_column_to_response_parses_the_declaration(self, db_session):
        """The wire carries the PARSED rules — same whole-or-nothing semantics
        as the predicate, so client and backend can never read one declaration
        two ways."""
        from app.routers.dataset import _column_to_response
        db_session.add(Project(id=1, name="P", user_id=1))
        db_session.flush()
        db_session.add(Dataset(id=1, project_id=1, name="S"))
        db_session.flush()
        col = DatasetColumn(
            id=1, dataset_id=1, column_code="Q7", column_text="Q7",
            column_type=ColumnType.NUMERIC, sequence_order=0,
            missing_values=json.dumps([{"value": "99"}]),
        )
        db_session.add(col)
        db_session.flush()
        resp = _column_to_response(col)
        assert resp.missing_values == [{"value": "99"}]

    def test_column_to_response_null_declaration_is_none(self, db_session):
        from app.routers.dataset import _column_to_response
        db_session.add(Project(id=1, name="P", user_id=1))
        db_session.flush()
        db_session.add(Dataset(id=1, project_id=1, name="S"))
        db_session.flush()
        col = DatasetColumn(
            id=1, dataset_id=1, column_code="Q7", column_text="Q7",
            column_type=ColumnType.NUMERIC, sequence_order=0,
        )
        db_session.add(col)
        db_session.flush()
        assert _column_to_response(col).missing_values is None


class TestNonFiniteBoundsAreRefused:
    """#592 slab 5: NaN and ±inf are floats, so they slip past a bare type check.

    pyreadstat emits ±inf for SPSS's `LOWEST THRU x` / `x THRU HIGHEST` — the
    .sav adapter normalizes those to None (unbounded, the shape's own spelling)
    before they ever reach here. This is the fail-closed half, for a
    hand-authored payload or a future adapter that forgets.

    An inf bound is worse than an invalid one: it validates, it persists, the
    predicate honors it — and then `json.dumps` writes a bare `Infinity`, which
    starlette's allow_nan=False JSONResponse refuses, 500-ing `GET /data` for the
    WHOLE dataset. NaN is quieter and no better: `nan >= x` is always False, so
    the rule looks declared and matches nothing.
    """

    @pytest.mark.parametrize("rule", [
        {"lo": float("inf"), "hi": 5},
        {"lo": -5, "hi": float("inf")},
        {"lo": float("-inf"), "hi": 0},
        {"lo": float("nan"), "hi": 0},
        {"lo": 0, "hi": float("nan")},
    ])
    def test_non_finite_bound_is_invalid(self, rule):
        assert _validate_rule(rule) is None

    def test_a_non_finite_bound_discards_the_whole_declaration(self):
        """Whole-or-nothing: one bad rule must not leave a partial rule set —
        a half-applied missing declaration is silently wrong statistics."""
        raw = json.dumps([{"value": "99"}, {"lo": 0, "hi": float("inf")}])
        assert parse_missing_rules(raw) is None

    def test_finite_bounds_including_zero_are_accepted(self):
        """The other side — 0 and negative bounds are ordinary and must pass
        (a `-99 to -1` sentinel block is the flagship case). A degenerate
        lo == hi normalizes to DISCRETE (#612, see its own class below)."""
        assert _validate_rule({"lo": -99, "hi": -1}) == {"lo": -99, "hi": -1}
        assert _validate_rule({"lo": 0, "hi": 0}) == {"value": "0"}
        assert _validate_rule({"lo": None, "hi": 0}) == {"lo": None, "hi": 0}

    def test_a_stored_declaration_is_json_serializable(self):
        """The wire contract this guard exists for: whatever validates must
        survive allow_nan=False, which is what serves every /data response."""
        rules = parse_missing_rules(json.dumps([{"value": "99", "label": "Refused"},
                                                {"lo": -99, "hi": -1}]))
        json.dumps(rules, allow_nan=False)  # raises if a non-finite slipped in


class TestDegenerateRangeNormalization:
    """#612 — a degenerate range (lo == hi) IS a discrete value. As a range
    its label was dead metadata (ranges never label-match, so an authored
    {lo:99, hi:99, label:"Refused"} silently never substituted and never
    reverted); normalizing at _validate_rule covers BOTH write schemas AND —
    via parse_missing_rules — legacy on-disk declarations, with no migration."""

    def test_labelled_degenerate_range_becomes_a_labelled_discrete_rule(self):
        assert _validate_rule({"lo": 99, "hi": 99, "label": "Refused"}) == \
            {"value": "99", "label": "Refused"}

    def test_float_bounds_format_integer_aware(self):
        """⚠️ str(99.0) would land "99.0" in value_text on un-declare revert,
        corrupting cells that say "99" — the code must render as the data does."""
        assert _validate_rule({"lo": 99.0, "hi": 99.0}) == {"value": "99"}

    def test_non_integer_degenerate_keeps_its_precision(self):
        assert _validate_rule({"lo": 99.5, "hi": 99.5}) == {"value": "99.5"}

    def test_read_path_normalizes_a_legacy_stored_range(self):
        """A pre-normalization on-disk declaration surfaces as discrete — the
        wire, the predicate's label channel, and un-declare recovery all see
        the corrected shape without any migration."""
        raw = json.dumps([{"lo": 99, "hi": 99, "label": "Refused"}])
        assert parse_missing_rules(raw) == [{"value": "99", "label": "Refused"}]

    def test_normalized_rule_label_channel_is_live(self):
        """The point of the normalization: the label now matches cells (both
        the raw code and the substituted label), which a range never did."""
        rules = parse_missing_rules(json.dumps([{"lo": 99, "hi": 99, "label": "Refused"}]))
        assert is_missing("99", rules) is True
        assert is_missing("Refused", rules) is True


class TestNormalizeRulesPayload:
    """#612/#614 — the shared WRITE-path payload validator, consumed by BOTH
    MissingValuesUpdate (PUT endpoint) and DatasetColumnConfig (import config)
    so the payload-internal #606 arms cannot be bypassed by the import path."""

    def test_valid_mixed_payload_passes(self):
        from app.services.missing_values import normalize_missing_rules_payload
        out = normalize_missing_rules_payload([
            {"value": "99", "label": "Refused"},
            {"value": "98"},
            {"lo": -99, "hi": -1},
        ])
        assert len(out) == 3

    def test_exact_duplicate_rules_are_dropped_silently(self):
        from app.services.missing_values import normalize_missing_rules_payload
        out = normalize_missing_rules_payload([{"value": "99"}, {"value": "99"}])
        assert out == [{"value": "99"}]

    def test_same_value_in_two_shapes_is_refused(self):
        """"99" and "99.0" are ONE value to the predicate (numeric match), so
        two rules for it — e.g. with different labels — would make
        substitution and recovery ambiguous."""
        from app.services.missing_values import normalize_missing_rules_payload
        with pytest.raises(ValueError, match="more than once"):
            normalize_missing_rules_payload(
                [{"value": "99", "label": "A"}, {"value": "99.0", "label": "B"}])

    def test_duplicate_labels_are_refused(self):
        from app.services.missing_values import normalize_missing_rules_payload
        with pytest.raises(ValueError, match="share the label"):
            normalize_missing_rules_payload(
                [{"value": "98", "label": "Refused"},
                 {"value": "99", "label": "Refused"}])

    def test_label_equal_to_another_rules_value_is_refused(self):
        from app.services.missing_values import normalize_missing_rules_payload
        with pytest.raises(ValueError, match="itself declared"):
            normalize_missing_rules_payload(
                [{"value": "98", "label": "99"}, {"value": "99"}])

    def test_rule_cap(self):
        from app.services.missing_values import (
            MAX_MISSING_RULES,
            normalize_missing_rules_payload,
        )
        rules = [{"value": str(i)} for i in range(MAX_MISSING_RULES + 1)]
        with pytest.raises(ValueError, match="Too many"):
            normalize_missing_rules_payload(rules)

    def test_import_config_runs_the_same_checks(self):
        """#614 — the import config was a second write path that bypassed the
        collision arms entirely: a config rule whose label collides persisted
        unguarded and classified real responses missing AT IMPORT."""
        from pydantic import ValidationError
        from app.schemas.dataset import DatasetColumnConfig
        with pytest.raises(ValidationError, match="share the label"):
            DatasetColumnConfig(
                column_index=0, skip=False, column_type="numeric",
                column_text="Q", column_code=None, column_name=None,
                group_code=None, group_label=None, scale_labels=None,
                missing_values=[
                    {"value": "98", "label": "Refused"},
                    {"value": "99", "label": "Refused"},
                ],
            )

    def test_endpoint_schema_runs_the_same_checks(self):
        from pydantic import ValidationError
        from app.schemas.recode import MissingValuesUpdate
        with pytest.raises(ValidationError, match="more than once"):
            MissingValuesUpdate(rules=[{"value": "99"}, {"value": "99.0", "label": "X"}])
