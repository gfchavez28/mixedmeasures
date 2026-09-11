"""Row 45 (i) — a participant SCORE states how it was made.

The ELEVENTH member of the stated-basis family, and the one the step-2 module
deliberately left owing: the vocabulary landed in Python first because *a mirror
nothing imports is the #855 "built but never consumed" shape*, and there was no
client for the payload until step 4.

Three halves, the same three every member of the family needs:

1. **The basis reaches the WIRE.** The score column carries it in
   `managed_spec`, projected through `DatasetColumnResponse` — and that schema
   is splat-constructed onto the `/data` sibling, where Pydantic's
   `extra='ignore'` drops anything undeclared, silently (#586). Both are checked.
2. **The hand-mirrored TypeScript has not drifted.** No codegen connects
   `services/magnitude_rollup.py` + `services/participant_scores.py` to
   `lib/magnitude-rollup-basis.ts`; this file does.
3. **The client cannot go SILENT on a value it does not know.** The family's
   standing failure is that an unrecognised basis renders as nothing — right for
   a payload predating the field, invisible for one a newer server sends.
"""
from pathlib import Path

from app.schemas.dataset import DatasetColumnResponse, DatasetDataColumnResponse
from app.services import magnitude_rollup as mr
from app.services import participant_scores as ps

REPO = Path(__file__).resolve().parents[2]
TS_MIRROR = REPO / "frontend" / "src" / "lib" / "magnitude-rollup-basis.ts"


def _ts() -> str:
    assert TS_MIRROR.exists(), f"the TS mirror moved: {TS_MIRROR}"
    return TS_MIRROR.read_text(encoding="utf-8")


class TestCrossLanguageContract:
    """Python reads the `.ts`. TypeScript catches only the other direction."""

    def test_every_basis_is_in_the_client_union(self):
        ts = _ts()
        assert mr.MAGNITUDE_ROLLUP_BASES, "the vocabulary went empty — the scan is blind"
        for basis in mr.MAGNITUDE_ROLLUP_BASES:
            assert f"'{basis}'" in ts, f"MagnitudeRollupBasis union lacks {basis!r}"

    def test_every_managed_kind_is_in_the_client_union(self):
        ts = _ts()
        assert ps.MANAGED_SPEC_KINDS, "the vocabulary went empty — the scan is blind"
        for kind in ps.MANAGED_SPEC_KINDS:
            assert f"'{kind}'" in ts, f"ManagedSpecKind union lacks {kind!r}"

    def test_the_client_keeps_both_exhaustiveness_guards(self):
        # Property (b): a variant added to a union without words must be a
        # COMPILE error, not silence.
        ts = _ts()
        assert "satisfies Record<MagnitudeRollupBasis, string>" in ts
        assert "satisfies Record<ManagedSpecKind, string>" in ts

    def test_the_client_reports_an_unknown_basis_rather_than_dropping_it(self):
        ts = _ts()
        assert "`computed as ${basis}`" in ts

    # 🔴 **"the mirror must never render 'up to date'" is NOT guarded here, and
    # that is a decision rather than a gap.** Two drafts of a source scan for the
    # phrase failed on this module's OWN prose — first on its JSDoc, then on the
    # markdown code spans inside it — which is #772's phantom class twice in one
    # sitting, inside a guard written to prevent a drift. #888 already refuted
    # this move for accessible names: a copy rule needs an exemption per
    # legitimate mention, and the exemptions are where it goes blind.
    #
    # The property lives in what `describeFreshness` RETURNS, so it is asserted
    # in the channel it lives in — `lib/magnitude-rollup-basis.test.ts`, which
    # CALLS the function. See `backend/tests/the internal design notes on querying the right
    # channel (#770).

class TestTheBasisReachesTheWire:
    def test_the_column_schema_declares_managed_spec(self):
        assert "managed_spec" in DatasetColumnResponse.model_fields

    def test_the_data_payload_sibling_declares_it_too(self):
        """#586 — `DatasetDataColumnResponse` is built by splatting the full
        column response's `model_dump()`, and `extra='ignore'` drops any field it
        does not declare. The Data view's grid renders the marker from THIS
        payload, so omitting it is a silent no-op with no type error.
        """
        assert "managed_spec" in DatasetDataColumnResponse.model_fields

    def test_a_score_column_spec_carries_the_basis(self):
        spec = ps.parse_managed_spec(ps.build_managed_spec(
            ps.MANAGED_SPEC_KIND_SCORE, 7,
            basis=mr.MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
        ))
        assert spec == {
            "kind": ps.MANAGED_SPEC_KIND_SCORE,
            "code_id": 7,
            "basis": mr.MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
        }

    def test_the_n_column_states_no_basis(self):
        """A count is not an aggregate: it has no basis to state, and inventing
        one for symmetry would make the vocabulary describe two kinds of claim."""
        spec = ps.parse_managed_spec(ps.build_managed_spec(
            ps.MANAGED_SPEC_KIND_RATED_TARGETS, 7,
        ))
        assert spec is not None
        assert "basis" not in spec


class TestTheSpecParserFailsSafe:
    """Strict IN, tolerant OUT — a malformed spec must degrade to 'not a managed
    column' rather than 500 every request that touches the dataset."""

    def test_an_unknown_kind_is_refused_on_the_way_in(self):
        try:
            ps.build_managed_spec("magnitude_vibes", 1)
        except ValueError as exc:
            assert "magnitude_vibes" in str(exc)
        else:
            raise AssertionError("build_managed_spec accepted an unknown kind")

    def test_garbage_reads_as_not_managed(self):
        for raw in (None, "", "not json", "[]", '{"kind": "nope", "code_id": 1}',
                    '{"kind": "magnitude_score"}',
                    '{"kind": "magnitude_score", "code_id": "seven"}'):
            assert ps.parse_managed_spec(raw) is None, raw
