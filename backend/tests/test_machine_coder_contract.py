"""The machine-coder vocabulary crosses two languages by HAND (queue row 49).

`services/machine_coder.py` decides how a model was reached; `lib/machine-coder.ts`
renders it. Nothing connects them but this file — the stated-basis family's
contract shape, applied to a vocabulary that is not itself a stated basis.

🔴 **Why it needs the same three halves.** An access kind the server accepts and
the client cannot label renders as a bare token on the ONE surface whose job is
to say how the model was reached; and a kind the CLIENT offers that the server
refuses is a picker option whose save 400s (#806). Both directions are checked.

🔴 **The human-vs-machine COPY is pinned here too.** Those sentences are the
third of three mechanisms discharging STRATEGY's commitment (the exclusion,
never pooling, and saying so), and an edit that quietly turns a description into
a validation claim is the failure this project would least like to ship.
"""
import re
from pathlib import Path

import pytest

from app.schemas.auth import CoderResponse
from app.schemas.code_analysis import MachineAgreementResponse, MachinePairAgreementResponse
from app.services import machine_agreement as ma
from app.services import machine_coder as mc

REPO = Path(__file__).resolve().parents[2]
TS_MIRROR = REPO / "frontend" / "src" / "lib" / "machine-coder.ts"
TS_COPY = REPO / "frontend" / "src" / "lib" / "machine-agreement-copy.ts"


def _ts(path: Path) -> str:
    assert path.exists(), f"the TS mirror moved: {path}"
    return path.read_text(encoding="utf-8")


class TestTheAccessVocabulary:
    def test_the_kinds_are_enumerated_and_ordered(self):
        assert mc.MACHINE_ACCESS_KINDS == ("api", "web", "local", "other")

    @pytest.mark.parametrize("kind", mc.MACHINE_ACCESS_KINDS)
    def test_every_python_kind_appears_in_the_mirror(self, kind):
        assert f"'{kind}'" in _ts(TS_MIRROR), (
            f"{kind!r} has no mirror in lib/machine-coder.ts — an unlabelled kind "
            "renders as a bare token on the surface that exists to name it"
        )

    def test_the_mirror_declares_no_kind_python_will_refuse(self):
        """The other direction: a TS-only value is a picker option whose save
        400s — the #806 shape."""
        union = re.search(
            r"export type MachineAccess =\s*(.+?)\n\n", _ts(TS_MIRROR), re.S,
        )
        assert union, "the MachineAccess union moved"
        declared = set(re.findall(r"'([a-z]+)'", union.group(1)))
        assert declared == set(mc.MACHINE_ACCESS_KINDS)

    def test_a_new_kind_would_be_a_COMPILE_error_not_a_fallthrough(self):
        source = _ts(TS_MIRROR)
        assert "satisfies Record<MachineAccess, string>" in source, (
            "the label table must be exhaustive by TYPE, or a fifth kind falls "
            "through to whichever branch happens to be the else (#941)"
        )

    def test_the_OTHER_kind_exists_on_purpose(self):
        """A vocabulary with no escape hatch collects lies: a real deployment
        that fits none of the three would be recorded as one that does."""
        assert "other" in mc.MACHINE_ACCESS_KINDS


class TestTheProvenanceReachesTheWire:
    def test_the_roster_declares_both_fields(self):
        """`/auth/coders` declares `response_model=list[CoderResponse]`, so a
        field the builder returns without a schema entry is dropped silently —
        the half-landed-wire class (#855)."""
        assert "machine_provenance" in CoderResponse.model_fields
        assert "provenance_locked" in CoderResponse.model_fields

    def test_the_lock_is_a_SERVER_fact_and_the_client_says_so(self):
        """A client that re-derived it would offer an editor the server 409s."""
        source = _ts(TS_MIRROR)
        assert "provenance_locked" in source
        assert "never re-derived on the client" in source or "must not re-derive" in source


class TestTheAgreementCopy:
    def test_the_unavailable_vocabulary_agrees_across_the_languages(self):
        declared = set(re.findall(
            r"^  (no_[a-z_]+):$", _ts(TS_COPY), re.M,
        ))
        assert declared == set(ma.UNAVAILABLE_REASONS)

    def test_a_fourth_reason_would_be_a_COMPILE_error(self):
        assert "satisfies Record<MachineAgreementUnavailable, string>" in _ts(TS_COPY)

    def test_the_explainer_REFUSES_the_two_claims_it_exists_to_refuse(self):
        """🔴 Identity-pinned. A κ between a person and a model describes the
        MODEL: it is evidence for none of Krippendorff's validity types and it is
        not an inter-rater figure. An edit that drops either denial ships the
        claim STRATEGY committed never to make."""
        source = _ts(TS_COPY)
        assert "not inter-rater reliability" in source
        assert "not evidence that the coding is correct" in source
        assert "Nothing here enters" in source

    def test_the_payload_carries_no_pooled_figure(self):
        """One coefficient per (person × machine × code) — the grain the claim is
        about. A pooled number would be read as "our agreement"."""
        assert set(MachineAgreementResponse.model_fields) == {
            "available", "unavailable_reason", "pairs",
        }
        pair = set(MachinePairAgreementResponse.model_fields)
        assert not {f for f in pair if "overall" in f or f in {"alpha", "kappa"}}

    def test_the_coverage_counts_are_declared_on_every_row(self):
        """They ARE the disclosure — see `machine_agreement.py`'s refused
        alternative (a narrower unit set for this table alone)."""
        from app.schemas.code_analysis import MachineCodeAgreement

        for field in ("human_applied", "machine_applied", "both_applied", "n_units"):
            assert field in MachineCodeAgreement.model_fields
