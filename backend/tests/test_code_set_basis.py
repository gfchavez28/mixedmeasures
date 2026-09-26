"""Row 48 — a code set's α states its UNIT SET (the twelfth stated-basis member).

Three halves, the same three every member of the family needs:

1. **The basis reaches the WIRE.** `/irr` declares `response_model=IrrResponse`,
   so a field the service returns without a schema entry is silently dropped —
   the half-landed-wire class this project has hit repeatedly.
2. **The hand-mirrored TypeScript has not drifted.** No codegen connects
   `services/code_sets.py` to `lib/code-set-basis.ts`; this file does.
3. **An unknown variant is a COMPILE error on the client**, and the absent case
   is SILENCE rather than an invented label.
"""
from pathlib import Path

import pytest

from app.schemas.code_analysis import IrrResponse, IrrSetResult
from app.services import code_sets as cs

REPO = Path(__file__).resolve().parents[2]
TS_MIRROR = REPO / "frontend" / "src" / "lib" / "code-set-basis.ts"


def _ts() -> str:
    assert TS_MIRROR.exists(), f"the TS mirror moved: {TS_MIRROR}"
    return TS_MIRROR.read_text(encoding="utf-8")


class TestTheVocabulary:
    def test_the_two_bases_are_distinct_and_enumerated(self):
        assert cs.SET_BASIS_EXHAUSTIVE_WITH_MISSING != cs.SET_BASIS_INCLUSIVE_WITH_NONE
        assert cs.SET_BASES == {
            cs.SET_BASIS_EXHAUSTIVE_WITH_MISSING,
            cs.SET_BASIS_INCLUSIVE_WITH_NONE,
        }

    def test_the_flag_maps_to_the_vocabulary_in_one_place(self):
        assert cs.set_basis(True) == cs.SET_BASIS_EXHAUSTIVE_WITH_MISSING
        assert cs.set_basis(False) == cs.SET_BASIS_INCLUSIVE_WITH_NONE

    def test_every_basis_is_reachable_from_the_flag(self):
        """A vocabulary member no input produces is a claim nothing can make."""
        produced = {cs.set_basis(flag) for flag in (True, False)}
        assert produced == cs.SET_BASES


class TestTheBasisReachesTheWire:
    def test_the_response_schema_declares_the_set_table_and_its_basis(self):
        assert "set_agreement" in IrrResponse.model_fields
        assert "set_basis" in IrrSetResult.model_fields

    def test_the_axis_and_its_labels_are_declared_together(self):
        """An axis of ids with no names renders a table of primary keys."""
        assert "axis" in IrrSetResult.model_fields
        assert "value_names" in IrrSetResult.model_fields

    def test_the_contradiction_count_is_declared(self):
        """`n_multiple_selection` is the disclosure that makes dropping a
        contradictory cell honest rather than silent."""
        assert "n_multiple_selection" in IrrSetResult.model_fields


class TestCrossLanguageContract:
    """Python reads the `.ts`. TypeScript catches only the other direction."""

    @pytest.mark.parametrize("constant", [
        cs.SET_BASIS_EXHAUSTIVE_WITH_MISSING,
        cs.SET_BASIS_INCLUSIVE_WITH_NONE,
    ])
    def test_every_python_basis_appears_in_the_mirror(self, constant):
        assert f"'{constant}'" in _ts(), (
            f"{constant!r} has no mirror in lib/code-set-basis.ts — the client's "
            "fallback for an unknown basis is SILENCE, so the drift is invisible"
        )

    def test_the_sentinel_agrees_across_the_languages(self):
        """A mismatch here renders "none of these" as a bare number, or worse
        matches a real code id."""
        assert f"export const SET_NONE = {cs.SET_NONE}" in _ts()

    def test_the_mirror_declares_no_basis_python_does_not(self):
        """The other direction: a TS-only value would be a label the server can
        never send, which is a promise the payload cannot keep."""
        import re

        declared = set(re.findall(r"^export const SET_BASIS_\w+ = '([^']+)'", _ts(), re.M))
        assert declared == cs.SET_BASES

    def test_a_new_variant_would_be_a_compile_error_not_a_silent_fallthrough(self):
        """`satisfies Record<SetBasis, string>` is what makes an unlabelled
        variant fail the BUILD. A ternary or an `else` branch would render the
        wrong words instead — the `ci-label.ts` defect this family records."""
        source = _ts()
        assert source.count("satisfies Record<SetBasis, string>") == 2, (
            "both lookup tables must be exhaustive by TYPE"
        )
