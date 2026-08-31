"""The project's non-response vocabulary is normalized on write — #816.

## Why this exists

`treat_as_empty` decides which text cells count as a response, and therefore
every denominator in the qualitative stack (#519): the coding gauge, the
text-analysis surfaces, and the export. It was fully built on the backend and
reachable from no UI, so nothing had ever written a value a researcher typed.

Building the UI makes the write path live, and it arrives with a defect already
diagnosed one seam over. `is_empty_text` strips the CELL:

    return value_text.strip() in treat_as_empty

so a declared value carrying its own whitespace can never match anything. That
is exactly #823(a) — a rule accepted with the same success message as one that
reclassifies thousands of cells, and invisible on screen because HTML collapses
the difference.
"""

import json

import pytest
from pydantic import ValidationError

from app.models.text_coding_config import (
    DEFAULT_TREAT_AS_EMPTY,
    MAX_TREAT_AS_EMPTY,
    is_empty_text,
    normalize_treat_as_empty,
    parse_treat_as_empty,
)
from app.schemas.text_coding import TextCodingConfigUpdate


class TestNormalization:
    def test_a_padded_entry_is_stripped_so_it_can_actually_fire(self):
        """🔴 The defect this whole module exists for.

        Mutation note: with the strip removed, `is_empty_text` below returns
        False and the declaration is inert — which is precisely the state that
        reads as success.
        """
        cleaned = normalize_treat_as_empty(["  Not applicable  "])

        assert cleaned == ["Not applicable"]
        assert is_empty_text("Not applicable", cleaned) is True

    def test_the_unstripped_form_really_would_have_failed_to_match(self):
        """The discrimination assertion — proof the fixture could have passed.

        Without this, `test_a_padded_entry_is_stripped…` is just as green under
        an implementation that never strips anything, because the cell text and
        the declared text would both be padded in a fixture that reused one
        string.
        """
        assert is_empty_text("Not applicable", ["  Not applicable  "]) is False

    def test_duplicates_collapse_and_order_survives(self):
        assert normalize_treat_as_empty(
            ["No response", "N/A", " No response ", "-"]
        ) == ["No response", "N/A", "-"]

    def test_blank_entries_are_dropped_not_refused(self):
        """A trailing empty row in an editor is not an error to explain."""
        assert normalize_treat_as_empty(["N/A", "", "   "]) == ["N/A"]

    def test_an_all_blank_list_normalizes_to_the_empty_declaration(self):
        """⚠️ And `[]` is a REAL state — "only a blank cell is empty".

        It must not round-trip back to the defaults, which is what the falsy
        check in `parse_treat_as_empty` would do to a stored NULL.
        """
        assert normalize_treat_as_empty(["  "]) == []

    def test_the_cap_refuses_a_paste(self):
        with pytest.raises(ValueError, match="At most"):
            normalize_treat_as_empty([f"v{i}" for i in range(MAX_TREAT_AS_EMPTY + 1)])

    def test_the_cap_counts_what_SURVIVES_normalization(self):
        """Duplicates and blanks must not push a legitimate list over the line."""
        values = [f"v{i}" for i in range(MAX_TREAT_AS_EMPTY)] + ["v0", "  ", "v1"]

        assert len(normalize_treat_as_empty(values)) == MAX_TREAT_AS_EMPTY

    def test_a_non_string_entry_is_refused(self):
        with pytest.raises(ValueError, match="only strings"):
            normalize_treat_as_empty(["N/A", 99])


class TestTheWriteSchema:
    def test_the_update_schema_normalizes(self):
        payload = TextCodingConfigUpdate(treat_as_empty=[" N/A ", "N/A"])

        assert payload.treat_as_empty == ["N/A"]

    def test_none_passes_through_as_the_reset_state(self):
        """🔴 `None` is "use the defaults", NOT an empty declaration.

        Normalizing it to `[]` would turn the reset control into a silent
        "nothing counts as a non-response" — the opposite instruction.
        """
        payload = TextCodingConfigUpdate(treat_as_empty=None)

        assert payload.treat_as_empty is None
        assert "treat_as_empty" in payload.model_fields_set

    def test_an_omitted_field_is_distinguishable_from_an_explicit_null(self):
        """The router keys on `model_fields_set`, so this distinction is the one
        that stops the debounced six-field config save from wiping a declaration.
        """
        assert "treat_as_empty" not in TextCodingConfigUpdate(hide_empty=True).model_fields_set

    def test_the_cap_surfaces_as_a_422_not_a_500(self):
        with pytest.raises(ValidationError):
            TextCodingConfigUpdate(
                treat_as_empty=[f"v{i}" for i in range(MAX_TREAT_AS_EMPTY + 1)]
            )


class TestReadPathShape:
    """`parse_treat_as_empty` is the READ side of the same field."""

    def test_null_means_the_defaults(self):
        assert parse_treat_as_empty(None) == DEFAULT_TREAT_AS_EMPTY

    def test_an_explicit_empty_list_is_not_the_defaults(self):
        """⚠️ `"[]"` is a truthy string — the falsy check must not swallow it."""
        assert parse_treat_as_empty(json.dumps([])) == []

    def test_a_stored_non_list_falls_back_instead_of_500ing_every_text_surface(self):
        """A stored scalar would reach `in` and raise TypeError project-wide.

        Unreachable through the API now that the write path validates, which is
        exactly why it is worth pinning: nothing else would catch it coming back.
        """
        assert parse_treat_as_empty(json.dumps(5)) == DEFAULT_TREAT_AS_EMPTY
        assert is_empty_text("anything", parse_treat_as_empty(json.dumps(5))) is False

    def test_non_string_members_are_dropped_on_read(self):
        assert parse_treat_as_empty(json.dumps(["N/A", 7])) == ["N/A"]


class TestTheResponseStatesItsBasis:
    """🔴 The effective list cannot say where it came from — so the wire does.

    A project that declares exactly the seven default values is byte-identical
    on the wire to one that has declared nothing. The UI needs the difference:
    "reset to the standard list" is a no-op in the first case and a real change
    in the second, and a client-side comparison against a mirrored copy of
    `DEFAULT_TREAT_AS_EMPTY` would answer wrongly for BOTH of them the moment
    the defaults change.
    """

    def test_the_two_states_are_distinguishable_on_the_wire(self):
        from app.schemas.text_coding import TextCodingConfigResponse

        def _response(stored: str | None) -> TextCodingConfigResponse:
            return TextCodingConfigResponse(
                view_mode="by_text", focal_column_ids=[], dataset_filter_ids=None,
                random_seed=None, context_visibility={}, hide_empty=True,
                starred_value_ids=[],
                treat_as_empty=parse_treat_as_empty(stored),
                treat_as_empty_is_default=stored is None,
            )

        undeclared = _response(None)
        declared_the_same = _response(json.dumps(DEFAULT_TREAT_AS_EMPTY))

        # The discrimination assertion: the payloads AGREE on the list, which is
        # precisely why the flag has to exist.
        assert undeclared.treat_as_empty == declared_the_same.treat_as_empty
        assert undeclared.treat_as_empty_is_default is True
        assert declared_the_same.treat_as_empty_is_default is False
