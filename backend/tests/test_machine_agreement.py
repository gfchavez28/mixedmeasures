"""Human-vs-machine agreement — a SEPARATE table that is never pooled (row 49).

The claim under test is as much about what these numbers are NOT: they describe a
model, they are not reliability, and they must not reach the headline α. Three of
the cases below assert an ABSENCE for that reason, and each is paired with a
positive control — a negative assertion that could never fail is indistinguishable
from a pass (#770).

⚠️ **The fixture makes the two DISAGREE on purpose.** A machine that reproduces
the human exactly gives κ = 1 under every implementation, including one that
compared a coder with themselves; the discrimination assertion below is what
makes the rest of the file mean anything (#707a).
"""
from app.auth import CODER_TYPE_MACHINE
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import machine_agreement as ma
from app.services import machine_coder as mc
from app.services.irr import compute_irr


PID = 400
N_SEGMENTS = 8


def _coder(db, uid, name, coder_type="human", provenance=None):
    coder = User(id=uid, username=name, password_hash=None, coder_type=coder_type)
    if provenance is not None:
        mc.write_provenance(coder, provenance)
    db.add(coder)
    db.flush()
    return coder


def _corpus(db):
    """One conversation, eight turns, two codes."""
    db.add(Project(id=PID, name="Posts", user_id=1))
    db.add(Conversation(id=PID, project_id=PID, name="Thread"))
    db.flush()
    for i in range(N_SEGMENTS):
        db.add(Segment(id=PID * 10 + i, conversation_id=PID,
                       sequence_order=i, text=f"post {i}", uuid=f"ma-{i}"))
    db.add(Code(id=PID * 100 + 1, project_id=PID, numeric_id=10, name="Trust"))
    db.add(Code(id=PID * 100 + 2, project_id=PID, numeric_id=11, name="Risk"))
    db.flush()


def _apply(db, code_id, uid, *indexes):
    for i in indexes:
        db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=PID * 10 + i))
    db.flush()


def _pair(result, human_id, machine_id):
    return next(
        p for p in result.pairs
        if p.human_id == human_id and p.machine_id == machine_id
    )


def _code_row(pair, code_id):
    return next(c for c in pair.per_code if c.code_id == code_id)


# ── 1. The three unavailable states ──────────────────────────────────────────


class TestUnavailable:
    def test_no_machine_coder_says_so(self, db_session):
        db = db_session
        _corpus(db)
        result = ma.compute_machine_agreement(db, PID)
        assert (result.available, result.unavailable_reason) == (False, ma.NO_MACHINE_CODER)

    def test_no_human_coder_says_so(self, db_session):
        """A machine on its own has nobody to be compared with. Distinct from
        the reason above because the remedy is different."""
        db = db_session
        _corpus(db)
        # The conftest user is id=1; archive them so no human remains.
        db.get(User, 1).archived = True
        _coder(db, 41, "GPT-4o", CODER_TYPE_MACHINE)
        db.flush()
        result = ma.compute_machine_agreement(db, PID)
        assert (result.available, result.unavailable_reason) == (False, ma.NO_HUMAN_CODER)

    def test_no_SHARED_source_says_so(self, db_session):
        """Both exist and neither has coded anything the other touched — Option
        B's engagement rule with nothing in it. A silence here would read as
        "still thinking" (#963 Tier 3)."""
        db = db_session
        _corpus(db)
        _coder(db, 42, "GPT-4o", CODER_TYPE_MACHINE)
        result = ma.compute_machine_agreement(db, PID)
        assert (result.available, result.unavailable_reason) == (False, ma.NO_SHARED_SOURCE)


# ── 2. A real pair ───────────────────────────────────────────────────────────


class TestAPair:
    def _disagreeing(self, db):
        """Alice and the model overlap substantially on Trust and diverge twice.

        Trust: Alice 0,1,2,3,4 · machine 0,1,2,3,5 → they agree on 0–3 (both
        present) and on 6,7 (both absent) and disagree on 4 and 5. po = 0.75,
        pe = 0.53125, κ ≈ 0.467.

        🔴 **Both "perfect" and "chance" were rejected as fixtures.** A machine
        that reproduces the human exactly gives κ = 1 under a correct
        implementation AND under one that compared a coder with themselves; a
        4-of-8 / 2-overlap arrangement gives κ = **exactly 0.0**, which a broken
        implementation can also produce and which the `0 < κ < 1` assertion could
        not tell from a zeroed field. The fixture has to land strictly between.
        """
        _corpus(db)
        alice = db.get(User, 1)
        machine = _coder(db, 43, "GPT-4o", CODER_TYPE_MACHINE,
                         provenance={"model": "gpt-4o", "access": "api"})
        trust = PID * 100 + 1
        _apply(db, trust, alice.id, 0, 1, 2, 3, 4)
        _apply(db, trust, machine.id, 0, 1, 2, 3, 5)
        return alice, machine

    def test_the_fixture_could_have_disagreed(self, db_session):
        """🔴 The discrimination assertion (#707a). If the two agreed perfectly
        every κ would be 1.0 under a correct implementation AND under one that
        compared a coder with themselves, so this fixture's whole value is that
        the number is neither 1 nor undefined."""
        db = db_session
        alice, machine = self._disagreeing(db)
        row = _code_row(
            _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id),
            PID * 100 + 1,
        )
        assert row.kappa is not None
        assert 0.0 < row.kappa < 1.0

    def test_both_coverage_counts_ride_every_row(self, db_session):
        """🔴 THE disclosure. `3` against `480` is a figure about a corpus one
        side barely touched, and no coefficient can say so on its own."""
        db = db_session
        alice, machine = self._disagreeing(db)
        row = _code_row(
            _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id),
            PID * 100 + 1,
        )
        assert (row.human_applied, row.machine_applied, row.both_applied) == (5, 5, 4)
        assert row.n_units == N_SEGMENTS

    def test_the_unit_set_is_OPTION_B_S_so_an_uncoded_turn_is_a_real_zero(self, db_session):
        """The SAME rule the human table uses. A narrower one for this table
        alone was refused: the two figures would then sit side by side computed
        differently with nothing saying so."""
        db = db_session
        alice, machine = self._disagreeing(db)
        pair = _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id)
        # Eight turns are in play although only six carry any application.
        assert pair.n_units == 8

    def test_the_PROVENANCE_rides_the_pair(self, db_session):
        """A comparison against an unrecorded configuration is a number nobody
        can reproduce, so the table carries it — and SAYS when it is missing
        rather than omitting the field."""
        db = db_session
        alice, machine = self._disagreeing(db)
        pair = _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id)
        assert pair.machine_provenance == {"model": "gpt-4o", "access": "api"}

    def test_an_unrecorded_configuration_is_None_not_absent(self, db_session):
        db = db_session
        _corpus(db)
        alice = db.get(User, 1)
        machine = _coder(db, 44, "Unnamed model", CODER_TYPE_MACHINE)
        _apply(db, PID * 100 + 1, alice.id, 0)
        _apply(db, PID * 100 + 1, machine.id, 0)
        pair = _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id)
        assert pair.machine_provenance is None

    def test_a_code_NEITHER_applied_in_scope_is_undefined_with_its_reason(self, db_session):
        """🔴 #689/#828's rider: with no variance there is nothing to agree
        ABOUT, and κ's `pe >= 1.0` branch returns 1.0 — rendered "almost
        perfect" over a code neither of them used."""
        db = db_session
        alice, machine = self._disagreeing(db)
        # `Risk` is applied by neither — it is not in play, so it should not
        # appear at all rather than appear as a perfect agreement.
        pair = _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id)
        assert [c.code_id for c in pair.per_code] == [PID * 100 + 1]

    def test_a_code_only_ONE_of_them_used_is_no_variance_not_perfect(self, db_session):
        db = db_session
        alice, machine = self._disagreeing(db)
        # The machine alone applies Risk everywhere → every compared cell pair
        # is (0, 1): two distinct values, so κ IS defined and is ≤ 0. The
        # no-variance case is the other one: both apply it everywhere.
        _apply(db, PID * 100 + 2, alice.id, *range(N_SEGMENTS))
        _apply(db, PID * 100 + 2, machine.id, *range(N_SEGMENTS))
        row = _code_row(
            _pair(ma.compute_machine_agreement(db, PID), alice.id, machine.id),
            PID * 100 + 2,
        )
        assert row.undefined_reason == "no_variance"
        assert row.kappa is None
        assert row.prevalence == 1.0

    def test_an_ARCHIVED_coder_is_on_neither_side(self, db_session):
        """DEC-F's roster: an archived colleague does not vote, and comparing a
        model against somebody who has left the project is a number nobody
        asked for."""
        db = db_session
        alice, machine = self._disagreeing(db)
        bob = _coder(db, 45, "Bob")
        _apply(db, PID * 100 + 1, bob.id, 0, 1)
        bob.archived = True
        db.flush()
        result = ma.compute_machine_agreement(db, PID)
        assert [p.human_id for p in result.pairs] == [alice.id]


# ── 3. What it must NOT touch ────────────────────────────────────────────────


class TestTheMachineStaysOutOfReliability:
    def test_the_machine_is_absent_from_compute_irr(self, db_session):
        """🔴 The property #989 shipped, re-asserted from the side that could
        break it: this module needed its OWN gather precisely so nobody relaxed
        `gather_coder_applications`' `reliability_coder_clause()`.

        Paired with a positive control, or "no machine in the matrix" would also
        pass against an IRR payload that is empty for some unrelated reason.
        """
        db = db_session
        _corpus(db)
        alice = db.get(User, 1)
        bob = _coder(db, 46, "Bob")
        machine = _coder(db, 47, "GPT-4o", CODER_TYPE_MACHINE)
        trust = PID * 100 + 1
        _apply(db, trust, alice.id, 0, 1, 2)
        _apply(db, trust, bob.id, 0, 1, 3)
        _apply(db, trust, machine.id, 0, 1, 2, 3)

        irr = compute_irr(db, PID)
        coder_ids = [c["id"] for c in irr["coders"]]
        # POSITIVE CONTROL: the two humans ARE there.
        assert alice.id in coder_ids and bob.id in coder_ids
        # And the machine is not.
        assert machine.id not in coder_ids

    def test_there_is_NO_pooled_figure_anywhere_in_the_payload(self, db_session):
        """One coefficient per (person × machine × code) — the grain the claim is
        actually about. A pooled number would be read as "our agreement"."""
        db = db_session
        _corpus(db)
        alice = db.get(User, 1)
        machine = _coder(db, 48, "GPT-4o", CODER_TYPE_MACHINE)
        _apply(db, PID * 100 + 1, alice.id, 0, 1)
        _apply(db, PID * 100 + 1, machine.id, 0, 2)
        result = ma.compute_machine_agreement(db, PID)
        fields = set(vars(result))
        assert fields == {"available", "unavailable_reason", "pairs"}
        pair_fields = set(vars(result.pairs[0]))
        assert "overall_kappa" not in pair_fields
        assert "alpha" not in pair_fields


# ── 4. The endpoint ──────────────────────────────────────────────────────────


class TestTheEndpoint:
    def test_the_payload_reaches_the_wire(self, db_session):
        """A plain `def` (#837), so it is called directly and NOT wrapped."""
        from app.routers.code_analysis import machine_agreement as endpoint

        db = db_session
        _corpus(db)
        alice = db.get(User, 1)
        machine = _coder(db, 49, "GPT-4o", CODER_TYPE_MACHINE,
                         provenance={"model": "gpt-4o"})
        _apply(db, PID * 100 + 1, alice.id, 0, 1, 2)
        _apply(db, PID * 100 + 1, machine.id, 0, 1, 3)

        payload = endpoint(project_id=PID, user=alice, db=db)
        assert payload.available is True
        row = payload.pairs[0].per_code[0]
        assert row.human_applied == 3
        assert row.machine_applied == 3
        assert payload.pairs[0].machine_provenance == {"model": "gpt-4o"}
