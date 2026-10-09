"""Code sets — a mutually exclusive group of codes read as ONE variable (row 48).

Four layers: the membership refusals, the α matrix (what a cell holds and why),
the consensus decider, and the write path, plus the portability round trip.

⚠️ **The fixture is deliberately THREE-valued with multi-digit code ids.** A
two-valued set cannot tell a k-valued nominal α from the binary one it replaces —
with two categories the set matrix and a member's indicator matrix are the same
matrix relabelled, so every assertion about "the set's own coefficient" would
pass under an implementation that just read a member's. Three values is the
smallest fixture on which they diverge, and it is the axis this whole slab
generalises (`backend/tests/the internal design notes, the degenerate-fixture rule).
"""
import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.code_set import CodeSet
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.user import User
from app.services import code_sets as cs
from app.services.coding_layers import build_effective_code_map
from app.services.consensus import (
    _decide_set_selection,
    materialize_consensus_for_project,
    recompute_consensus_for_target,
    split_set_choices,
)
from app.services.irr import build_irr_matrices, compute_irr


# ── Fixture helpers ──────────────────────────────────────────────────────────


def _coder(db, uid, name):
    """Idempotent: coders are INSTANCE-global (the #444 trap in fixture form), so
    a test comparing two projects must not try to create them twice."""
    if db.get(User, uid) is None:
        db.add(User(id=uid, username=name, password_hash=None, coder_type="human"))
        db.flush()


def _project(db, pid, name="Stance study"):
    db.add(Project(id=pid, name=name, user_id=1))
    db.flush()


def _code(db, cid, pid, numeric, name, **kw):
    db.add(Code(id=cid, project_id=pid, numeric_id=numeric, name=name, **kw))
    db.flush()
    return db.get(Code, cid)


def _seg(db, sid, conv_id, order):
    db.add(Segment(id=sid, conversation_id=conv_id, sequence_order=order, text="x"))
    db.flush()


def _apply(db, code_id, uid, segment_id):
    db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=segment_id))
    db.flush()


def _index(db, pid):
    return cs.build_code_set_index(db, pid, build_effective_code_map(db, pid))


def _stance_project(db, pid, *, exhaustive=False, n_segments=6):
    """A project with two coders, one conversation and a 3-valued stance set.

    Member ids are multi-digit and non-contiguous on purpose: a set matrix holds
    CODE IDS, so a fixture whose ids are 1/2/3 cannot distinguish them from the
    0/1 of a binary indicator, and one whose ids are contiguous cannot reveal an
    implementation that indexes by position.
    """
    _project(db, pid)
    db.add(Conversation(id=pid, project_id=pid, name="Posts"))
    db.flush()
    for i in range(n_segments):
        _seg(db, pid * 100 + i, pid, i)
    code_set = CodeSet(
        id=pid, project_id=pid, label="Stance", exhaustive=exhaustive,
    )
    db.add(code_set)
    db.flush()
    positive = _code(db, pid * 10 + 1, pid, 10, "Positive", code_set_id=pid)
    negative = _code(db, pid * 10 + 3, pid, 12, "Negative", code_set_id=pid)
    neutral = _code(db, pid * 10 + 7, pid, 15, "Neutral", code_set_id=pid)
    return code_set, (positive, negative, neutral)


# ── 1. Membership refusals ───────────────────────────────────────────────────


class TestMembershipRefusals:
    def test_a_universal_code_is_refused_with_its_reason(self, db_session):
        db = db_session
        _project(db, 10)
        code_set = CodeSet(id=10, project_id=10, label="Stance")
        db.add(code_set)
        db.flush()
        universal = _code(db, 101, 10, 0, "Unsubstantive", is_universal=True)
        refusal = cs.membership_refusal(
            universal, code_set,
            effective_map={}, codes_by_id={101: universal},
        )
        assert refusal is not None
        reason, sentence = refusal
        assert reason == cs.REFUSAL_UNIVERSAL
        # The sentence is what reaches a screen, so it must name the code and say
        # WHY — a bare "not allowed" is the #806 shape.
        assert "Unsubstantive" in sentence and "universal" in sentence.lower()

    def test_an_inactive_code_cannot_JOIN_but_a_member_may_be_deactivated(self, db_session):
        """Deactivating removes a code from the picker, not from the record.

        An existing member must keep resolving to its set or a past round's α
        becomes uncomputable — so the refusal is on JOINING, and membership is
        untouched by `is_active`.
        """
        db = db_session
        code_set, (positive, negative, neutral) = _stance_project(db, 11)
        newcomer = _code(db, 1199, 11, 20, "Mixed", is_active=False)
        refusal = cs.membership_refusal(
            newcomer, code_set, effective_map={},
            codes_by_id={c.id: c for c in (positive, negative, neutral, newcomer)},
        )
        assert refusal is not None and refusal[0] == cs.REFUSAL_INACTIVE

        # …and an EXISTING member that is deactivated stays a value of the set.
        negative.is_active = False
        db.flush()
        resolved = _index(db, 11).by_id(code_set.id)
        assert negative.id in resolved.member_ids

    def test_a_code_in_another_set_is_refused_and_the_sentence_names_that_set(self, db_session):
        db = db_session
        code_set, (positive, _n, _u) = _stance_project(db, 12)
        other = CodeSet(id=1200, project_id=12, label="Topic")
        db.add(other)
        db.flush()
        refusal = cs.membership_refusal(
            positive, other, effective_map={}, codes_by_id={positive.id: positive},
        )
        assert refusal is not None and refusal[0] == cs.REFUSAL_OTHER_SET
        assert "Stance" in refusal[1]

    def test_a_code_grouped_with_an_OUTSIDE_code_is_refused(self, db_session):
        """The composition hole, closed at the door that can close it.

        Agreement is computed on the EFFECTIVE code, so if "Neg" resolves to
        "Negative" and "Negative" is not in the set, every use of "Neg" is
        recorded as a code the set does not contain — the selection silently
        disappears rather than failing.
        """
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 13)
        outside = _code(db, 1301, 13, 30, "Sentiment (raw)")
        neg_alias = _code(db, 1302, 13, 31, "Neg")
        group = CodeEquivalenceGroup(
            id=1300, project_id=13, label="Neg family", canonical_code_id=outside.id,
        )
        db.add(group)
        db.flush()
        outside.code_equivalence_group_id = group.id
        neg_alias.code_equivalence_group_id = group.id
        db.flush()

        effective_map = build_effective_code_map(db, 13)
        assert effective_map[neg_alias.id] == outside.id  # precondition
        refusal = cs.membership_refusal(
            neg_alias, code_set, effective_map=effective_map,
            codes_by_id={c.id: c for c in (positive, negative, outside, neg_alias)},
        )
        assert refusal is not None and refusal[0] == cs.REFUSAL_GROUPED_ELSEWHERE
        assert "Sentiment (raw)" in refusal[1]

    def test_both_halves_of_a_group_may_join_in_ONE_request(self, db_session):
        """`incoming_ids` is what makes a set buildable in one act.

        Judging each candidate against the DATABASE alone refuses the canonical
        code's own companion for a state the same request is creating.
        """
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 14)
        canonical = _code(db, 1401, 14, 30, "Negative (alt)")
        alias = _code(db, 1402, 14, 31, "Neg")
        group = CodeEquivalenceGroup(
            id=1400, project_id=14, label="Neg family", canonical_code_id=canonical.id,
        )
        db.add(group)
        db.flush()
        canonical.code_equivalence_group_id = group.id
        alias.code_equivalence_group_id = group.id
        db.flush()
        effective_map = build_effective_code_map(db, 14)
        codes_by_id = {c.id: c for c in (positive, negative, canonical, alias)}
        incoming = frozenset({canonical.id, alias.id})
        assert cs.membership_refusal(
            alias, code_set, effective_map=effective_map,
            codes_by_id=codes_by_id, incoming_ids=incoming,
        ) is None
        # …and WITHOUT the batch it is refused, which is what makes the
        # parameter load-bearing rather than decorative.
        assert cs.membership_refusal(
            alias, code_set, effective_map=effective_map, codes_by_id=codes_by_id,
        ) is not None

    def test_a_member_that_resolves_away_is_REPORTED_not_silently_dropped(self, db_session):
        """The equivalence-side route into the hole, which no set-door refusal
        can close. The state must SAY it exists rather than be discovered as a
        number that quietly stopped counting some coding."""
        db = db_session
        code_set, (positive, negative, neutral) = _stance_project(db, 15)
        outside = _code(db, 1501, 15, 30, "Sentiment (raw)")
        group = CodeEquivalenceGroup(
            id=1500, project_id=15, label="Neg family", canonical_code_id=outside.id,
        )
        db.add(group)
        db.flush()
        # The regrouping happens AFTER membership, which is the reachable route.
        outside.code_equivalence_group_id = group.id
        negative.code_equivalence_group_id = group.id
        db.flush()

        effective_map = build_effective_code_map(db, 15)
        warnings = cs.set_composition_warnings(
            [positive, negative, neutral],
            effective_map=effective_map,
            codes_by_id={c.id: c for c in (positive, negative, neutral, outside)},
        )
        assert len(warnings) == 1
        assert "Negative" in warnings[0] and "Sentiment (raw)" in warnings[0]
        # …and the resolved set no longer counts it as one of its values.
        resolved = _index(db, 15).by_id(code_set.id)
        assert negative.id not in resolved.member_ids
        # but the WRITE path still knows about it, or a swap would leave the
        # stale application standing.
        assert negative.id in resolved.raw_member_ids


# ── 2. The matrix cell ───────────────────────────────────────────────────────


class TestMatrixCell:
    def test_a_chosen_member_is_its_own_id(self, db_session):
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 20)
        resolved = _index(db, 20).by_id(code_set.id)
        assert cs.matrix_cell({positive.id}, resolved) == (positive.id, False)

    def test_nothing_chosen_is_the_SENTINEL_on_an_inclusive_set(self, db_session):
        db = db_session
        code_set, _members = _stance_project(db, 21, exhaustive=False)
        resolved = _index(db, 21).by_id(code_set.id)
        assert cs.matrix_cell(set(), resolved) == (cs.SET_NONE, False)

    def test_nothing_chosen_is_MISSING_on_an_exhaustive_set(self, db_session):
        """The one flag that changes the denominator. Same input, opposite cell."""
        db = db_session
        code_set, _members = _stance_project(db, 22, exhaustive=True)
        resolved = _index(db, 22).by_id(code_set.id)
        assert cs.matrix_cell(set(), resolved) == (None, False)

    def test_two_members_at_once_is_a_CONTRADICTION_counted_not_resolved(self, db_session):
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 23)
        resolved = _index(db, 23).by_id(code_set.id)
        cell, multiple = cs.matrix_cell({positive.id, negative.id}, resolved)
        assert cell is None and multiple is True
        # ⚠️ NOT the lowest id, NOT the most recent — picking either would
        # fabricate a judgement nobody made.
        assert cell != min(positive.id, negative.id)

    def test_the_sentinels_can_never_collide_with_a_code_id(self):
        """`codes.id` is a positive autoincrement, so a negative sentinel is
        unreachable as a member. Cheap, and the whole scheme rests on it."""
        assert cs.SET_NONE < 0 and cs.SET_MULTIPLE < 0
        assert cs.SET_NONE != cs.SET_MULTIPLE

    def test_an_ordered_metric_is_REFUSED_for_a_set(self):
        """The sentinels are negative, so ordinal/interval would sort "none of
        these" below every code id and score the distance between two categories
        as though the identifiers meant something."""
        cs.assert_nominal_metric("nominal")
        for metric in ("ordinal", "interval", "ratio"):
            with pytest.raises(ValueError, match="nominally"):
                cs.assert_nominal_metric(metric)


# ── 3. The α matrix end to end ───────────────────────────────────────────────


class TestSetAlpha:
    def _coded(self, db, pid, *, exhaustive=False):
        code_set, (positive, negative, neutral) = _stance_project(
            db, pid, exhaustive=exhaustive,
        )
        _coder(db, 2, "alice")
        _coder(db, 3, "bob")
        segs = [pid * 100 + i for i in range(6)]
        # Deliberately mixed: agreement on two values, one clean disagreement,
        # and one unit where both left it blank.
        _apply(db, positive.id, 2, segs[0]); _apply(db, positive.id, 3, segs[0])
        _apply(db, negative.id, 2, segs[1]); _apply(db, negative.id, 3, segs[1])
        _apply(db, neutral.id, 2, segs[2]); _apply(db, neutral.id, 3, segs[2])
        _apply(db, positive.id, 2, segs[3]); _apply(db, negative.id, 3, segs[3])
        _apply(db, neutral.id, 2, segs[4]); _apply(db, neutral.id, 3, segs[4])
        return code_set, (positive, negative, neutral), segs

    def test_the_set_gets_ONE_alpha_over_its_values(self, db_session):
        db = db_session
        code_set, (positive, negative, neutral), _segs = self._coded(db, 30)
        payload = compute_irr(db, 30)
        assert payload["available"] is True
        rows = payload["set_agreement"]
        assert len(rows) == 1
        row = rows[0]
        assert row["set_id"] == code_set.id
        assert row["n_values"] == 3
        assert row["krippendorff_alpha"] is not None
        assert row["alpha_metric"] == "nominal"
        assert row["undefined_reason"] is None

    def test_its_members_leave_the_per_code_table_but_STAY_in_the_matrices(self, db_session):
        """The display narrows; the R export's input does not.

        `per_code` has a second consumer (`export_r.py` emits a coder × unit
        matrix per code), so dropping members from `build_irr_matrices` would
        silently stop exporting codes that have always been exported.
        """
        db = db_session
        _cs, (positive, negative, neutral), _segs = self._coded(db, 31)
        payload = compute_irr(db, 31)
        shown = {r["code_id"] for r in payload["per_code"]}
        assert shown & {positive.id, negative.id, neutral.id} == set()

        _c, _n, per_code, _s, _sc, _m, sets = build_irr_matrices(db, 31)
        assert {positive.id, negative.id, neutral.id} <= set(per_code)
        # …and the breakdown reads the SAME matrices rather than recomputing.
        member_rows = sets[_cs.id]["member_rows"]
        assert member_rows[positive.id] is per_code[positive.id]

    def test_the_member_breakdown_carries_each_values_own_binary_alpha(self, db_session):
        db = db_session
        _cs, (positive, _n, _u), _segs = self._coded(db, 32)
        row = compute_irr(db, 32)["set_agreement"][0]
        by_code = {m["code_id"]: m for m in row["members"]}
        assert set(by_code) == {c.id for c in _cs.codes}
        assert by_code[positive.id]["prevalence"] is not None

    def test_the_sets_alpha_is_NOT_any_members_alpha(self, db_session):
        """The discrimination assertion (`backend/tests/the internal design notes): a fixture
        where the k-valued coefficient and every binary one agree would pass
        under an implementation that just read a member's."""
        db = db_session
        _cs, _members, _segs = self._coded(db, 33)
        row = compute_irr(db, 33)["set_agreement"][0]
        member_alphas = [
            m["krippendorff_alpha"] for m in row["members"]
            if m["krippendorff_alpha"] is not None
        ]
        assert member_alphas, "the fixture must produce at least one member alpha"
        for alpha in member_alphas:
            assert row["krippendorff_alpha"] != pytest.approx(alpha, abs=1e-9)

    def test_the_set_alpha_never_enters_the_headline(self, db_session):
        """Two instruments, one coefficient is dishonest — the #35 rule, reached
        from the third table."""
        db = db_session
        _cs, _members, _segs = self._coded(db, 34)
        payload = compute_irr(db, 34)
        # Every code in this project is a set member, so the per-code table is
        # empty and the headline has nothing to pool.
        assert payload["per_code"] == []
        assert payload["overall_alpha"] is None
        assert payload["set_agreement"][0]["krippendorff_alpha"] is not None

    def test_a_project_of_ONLY_set_members_is_still_AVAILABLE(self, db_session):
        """Availability asks both tables. Reading `per_code` alone would answer
        "needs at least 2 coders with coding on a shared source" over a screen
        that has one."""
        db = db_session
        self._coded(db, 35)
        assert compute_irr(db, 35)["available"] is True

    def test_exhaustiveness_changes_the_number(self, db_session):
        """The whole reason `set_basis` is a stated-basis member: the same coders
        on the same data produce different α under the two."""
        db = db_session
        self._coded(db, 36, exhaustive=False)
        self._coded(db, 37, exhaustive=True)
        inclusive = compute_irr(db, 36)["set_agreement"][0]
        exhaustive = compute_irr(db, 37)["set_agreement"][0]
        assert inclusive["set_basis"] == cs.SET_BASIS_INCLUSIVE_WITH_NONE
        assert exhaustive["set_basis"] == cs.SET_BASIS_EXHAUSTIVE_WITH_MISSING
        assert inclusive["n_units"] != exhaustive["n_units"]
        assert inclusive["krippendorff_alpha"] != pytest.approx(
            exhaustive["krippendorff_alpha"], abs=1e-9
        )
        # …and the sentinel is only ever an AXIS value on the inclusive one.
        assert cs.SET_NONE in inclusive["axis"]
        assert cs.SET_NONE not in exhaustive["axis"]

    def test_a_one_value_set_is_DEGENERATE_and_says_so(self, db_session):
        """One member is a binary code wearing a costume. The MODEL permits a
        half-built set — a researcher adds values one at a time — so the refusal
        belongs to the statistic."""
        db = db_session
        code_set, (positive, negative, neutral) = _stance_project(db, 38)
        negative.code_set_id = None
        neutral.code_set_id = None
        db.flush()
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        _apply(db, positive.id, 2, 3800); _apply(db, positive.id, 3, 3800)
        row = compute_irr(db, 38)["set_agreement"][0]
        assert row["n_values"] == 1
        assert row["undefined_reason"] == "degenerate"
        assert row["krippendorff_alpha"] is None

    def test_every_coder_choosing_the_same_value_is_NO_VARIANCE_not_perfect(self, db_session):
        """#829's rule through sets: nothing to agree about is not agreement."""
        db = db_session
        _cs, (positive, _n, _u) = _stance_project(db, 39, exhaustive=True)
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        for i in range(3):
            _apply(db, positive.id, 2, 3900 + i)
            _apply(db, positive.id, 3, 3900 + i)
        row = compute_irr(db, 39)["set_agreement"][0]
        assert row["undefined_reason"] == "no_variance"
        assert row["krippendorff_alpha"] is None

    def test_a_double_selection_is_counted_on_the_payload(self, db_session):
        db = db_session
        _cs, (positive, negative, _u), _segs = self._coded(db, 40)
        # Reachable through a merge, legacy data, or a set built over existing
        # coding — so the statistic must survive it and SAY it happened.
        _apply(db, negative.id, 2, 4000)
        row = compute_irr(db, 40)["set_agreement"][0]
        assert row["n_multiple_selection"] == 1

    def test_the_confusion_matrix_is_per_PAIR_and_squares_on_the_axis(self, db_session):
        db = db_session
        _cs, (positive, negative, neutral), _segs = self._coded(db, 41)
        row = compute_irr(db, 41)["set_agreement"][0]
        assert len(row["confusion"]) == 1  # one pair of coders
        counts = row["confusion"][0]["counts"]
        assert len(counts) == len(row["axis"])
        assert all(len(r) == len(row["axis"]) for r in counts)
        pos_i = row["axis"].index(positive.id)
        neg_i = row["axis"].index(negative.id)
        # The diagonal is agreement; the one off-diagonal cell names exactly
        # which confusion happened (alice Positive, bob Negative on seg 3).
        assert counts[pos_i][pos_i] == 1
        assert counts[pos_i][neg_i] == 1
        assert row["value_names"][str(neutral.id)] == "Neutral"
        assert row["value_names"][str(cs.SET_NONE)] == "None of these"

    def test_the_interval_is_built_from_the_SETS_rows(self, db_session):
        """The #35 lesson exactly: for one slab the bootstrap scored every
        resample nominally whatever the estimate used."""
        db = db_session
        _cs, _members, _segs = self._coded(db, 42)
        row = compute_irr(db, 42)["set_agreement"][0]
        assert row["alpha_ci"] is not None
        lower, upper = row["alpha_ci"]["lower"], row["alpha_ci"]["upper"]
        assert lower is not None and upper is not None and lower <= upper

    def test_every_alpha_bearing_row_of_every_table_states_its_metric(self, db_session):
        """The POPULATION claim the source-scan in `test_reliability_basis.py`
        cannot make (its count of result shapes rotted on this very slab)."""
        db = db_session
        self._coded(db, 43)
        payload = compute_irr(db, 43)
        rows = (
            payload["per_code"] + payload["magnitude_per_code"] + payload["set_agreement"]
        )
        assert rows, "the fixture must produce at least one alpha-bearing row"
        for row in rows:
            assert row.get("alpha_metric"), row


# ── 4. Consensus — the third decider ─────────────────────────────────────────


class TestSetConsensus:
    def test_a_strict_majority_wins_and_a_tie_writes_nothing(self):
        assert _decide_set_selection({2: 101, 3: 101, 4: 102}, False) == (
            101, "majority", 2, 3,
        )
        assert _decide_set_selection({2: 101, 3: 101}, False) == (101, "unanimous", 2, 2)
        # A tie is exactly the state reconciliation exists to resolve.
        assert _decide_set_selection({2: 101, 3: 102}, False) is None

    def test_none_of_these_can_WIN_and_still_writes_no_row(self):
        """The absence IS the consensus — there is no code to attach a row to."""
        assert _decide_set_selection({2: cs.SET_NONE, 3: cs.SET_NONE, 4: 101}, False) is None

    def test_an_exhaustive_set_drops_the_undecided_from_the_ELECTORATE(self):
        """The one place `exhaustive` changes a write rather than a display."""
        choices = {2: 101, 3: 101, 4: cs.SET_NONE}
        assert _decide_set_selection(choices, False) == (101, "majority", 2, 3)
        # …exhaustive: the blank is missing data, so 101 is UNANIMOUS among two.
        assert _decide_set_selection(choices, True) == (101, "unanimous", 2, 2)

    def test_below_two_voters_there_is_no_consensus(self):
        assert _decide_set_selection({2: 101}, False) is None
        assert _decide_set_selection({2: 101, 3: cs.SET_NONE}, True) is None

    def test_the_split_strips_members_from_what_the_OTHER_decider_tallies(self, db_session):
        """🔴 Both deciding the same code is two rows on one
        `(target, code, consensus_user)` key — the unique index raising mid-loop
        under `autoflush=False`."""
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 50)
        plain = _code(db, 5099, 50, 40, "Mentions policy")
        index = _index(db, 50)
        per_coder = {2: {positive.id, plain.id}, 3: {positive.id}}
        stripped, choices = split_set_choices(per_coder, index)
        assert stripped == {2: {plain.id}, 3: set()}
        assert choices[code_set.id] == {2: positive.id, 3: positive.id}

    def test_the_consensus_layer_writes_ONE_row_for_a_set_majority(self, db_session):
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 51)
        _coder(db, 2, "alice"); _coder(db, 3, "bob"); _coder(db, 4, "carol")
        _apply(db, positive.id, 2, 5100)
        _apply(db, positive.id, 3, 5100)
        _apply(db, negative.id, 4, 5100)
        recompute_consensus_for_target(db, 51, segment_id=5100)
        rows = db.query(CodeApplication).filter(
            CodeApplication.segment_id == 5100,
            CodeApplication.origin == "consensus",
        ).all()
        assert len(rows) == 1
        assert rows[0].code_id == positive.id
        import json
        context = json.loads(rows[0].origin_context)
        assert context["code_set"]["set_id"] == code_set.id
        assert context["code_set"]["agree"] == 2

    def test_an_unrelated_consensus_row_keeps_its_exact_shape(self, db_session):
        """The `magnitude` key's rule, reached from row 48: a row that is not a
        set selection is byte-identical to what it always was."""
        db = db_session
        _project(db, 52)
        db.add(Conversation(id=52, project_id=52, name="Posts"))
        db.flush()
        _seg(db, 5200, 52, 0)
        plain = _code(db, 5201, 52, 40, "Mentions policy")
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        _apply(db, plain.id, 2, 5200); _apply(db, plain.id, 3, 5200)
        recompute_consensus_for_target(db, 52, segment_id=5200)
        row = db.query(CodeApplication).filter(
            CodeApplication.segment_id == 5200,
            CodeApplication.origin == "consensus",
        ).one()
        import json
        assert set(json.loads(row.origin_context)) == {"rule", "agree", "voters"}

    def test_the_project_rebuild_agrees_with_the_per_target_recompute(self, db_session):
        """The `_consensus_row` rule: two writers, one shape. A field added to
        one and not the other is how the stored layer disagrees with itself."""
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 53)
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        _apply(db, positive.id, 2, 5300); _apply(db, positive.id, 3, 5300)
        recompute_consensus_for_target(db, 53, segment_id=5300)
        per_target = [
            (r.code_id, r.origin_context) for r in db.query(CodeApplication)
            .filter(CodeApplication.segment_id == 5300, CodeApplication.origin == "consensus")
            .order_by(CodeApplication.code_id).all()
        ]
        materialize_consensus_for_project(db, 53)
        rebuilt = [
            (r.code_id, r.origin_context) for r in db.query(CodeApplication)
            .filter(CodeApplication.segment_id == 5300, CodeApplication.origin == "consensus")
            .order_by(CodeApplication.code_id).all()
        ]
        assert per_target == rebuilt

    # ── #1017 — a coder holding two values is not a vote ──────────────────

    def test_comparable_choice_is_the_one_rule(self):
        """The α matrix, the decider and the grid all read this (#1017)."""
        M, N = cs.SET_MULTIPLE, cs.SET_NONE
        assert cs.comparable_choice(101, False) == 101
        assert cs.comparable_choice(101, True) == 101
        assert cs.comparable_choice(N, False) == N, "inclusive: 'none of these' is a value"
        assert cs.comparable_choice(N, True) is None, "exhaustive: a blank is missing"
        assert cs.comparable_choice(M, False) is None, "a contradiction is never a value"
        assert cs.comparable_choice(M, True) is None

    def test_a_coder_holding_two_values_is_not_a_VOTE(self):
        """#1017 (a) and (d). Before the fix a contradiction was tallied like a
        member id: holding the majority it WON (code id −2), and in the minority
        it inflated the electorate ("2 of 3" where α sees 2 of 2)."""
        M = cs.SET_MULTIPLE
        for exhaustive in (False, True):
            assert _decide_set_selection({2: M, 3: M}, exhaustive) is None
            assert _decide_set_selection({2: M, 3: M, 4: 101}, exhaustive) is None
            assert _decide_set_selection({2: 101, 3: 101, 4: M}, exhaustive) == (
                101, "unanimous", 2, 2,
            )

    def test_neither_writer_crashes_when_contradictions_hold_the_majority(self, db_session):
        """#1017 (a), through both WRITERS: two coders each holding Positive AND
        Negative made both raise `FOREIGN KEY constraint failed` on an insert
        of code id −2. The unrelated code on the same segment must still be
        decided — the contradiction voids the VARIABLE, not the target."""
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 54)
        plain = _code(db, 5499, 54, 40, "Mentions policy")
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        for uid in (2, 3):
            _apply(db, positive.id, uid, 5400)
            _apply(db, negative.id, uid, 5400)
            _apply(db, plain.id, uid, 5400)

        def _rows():
            return sorted(
                r.code_id for r in db.query(CodeApplication).filter(
                    CodeApplication.segment_id == 5400,
                    CodeApplication.origin == "consensus",
                )
            )

        recompute_consensus_for_target(db, 54, segment_id=5400)
        assert _rows() == [plain.id]
        materialize_consensus_for_project(db, 54)
        assert _rows() == [plain.id]


# ── #1018 — the four consumers decide a target alike ────────────────────────


class TestTheFourConsumersDecideAlike:
    def _exhaustive_rated_project(self, db, pid):
        """Four coders on one participant's segment: two chose Positive (an
        EXHAUSTIVE member with a 0–10 scale) and rated it 7 and 8; the other two
        applied unrelated codes. On the set's own electorate that is 2 of 2; on
        the unsplit rule it is 2 of 4 — the disagreement #1018 was."""
        from app.models.participant import Participant
        from app.models.speaker import Speaker

        code_set, (positive, _n, _u) = _stance_project(db, pid, exhaustive=True, n_segments=0)
        positive.magnitude_min, positive.magnitude_max, positive.magnitude_step = 0, 10, 1
        person = Participant(project_id=pid, identifier="P1")
        db.add(person)
        db.flush()
        speaker = Speaker(project_id=pid, name="Ana", participant_id=person.id)
        db.add(speaker)
        db.flush()
        seg = pid * 100
        db.add(Segment(id=seg, conversation_id=pid, sequence_order=0, text="x", speaker_id=speaker.id))
        other_a = _code(db, pid * 10 + 5, pid, 20, "Budget")
        other_b = _code(db, pid * 10 + 6, pid, 21, "Staffing")
        for uid in (2, 3, 4, 5):
            _coder(db, uid, f"coder{uid}")
        db.add(CodeApplication(code_id=positive.id, user_id=2, segment_id=seg, magnitude=7))
        db.add(CodeApplication(code_id=positive.id, user_id=3, segment_id=seg, magnitude=8))
        db.add(CodeApplication(code_id=other_a.id, user_id=4, segment_id=seg))
        db.add(CodeApplication(code_id=other_b.id, user_id=5, segment_id=seg))
        db.flush()
        return seg, positive, person

    def test_an_exhaustive_members_consensus_reaches_the_rollup_and_the_grid(self, db_session):
        import json

        from app.services.magnitude_rollup import compute_magnitude_rollup
        from app.services.reconciliation import build_reconciliation

        db = db_session
        seg, positive, person = self._exhaustive_rated_project(db, 55)

        # The stored layer — the reference the other two must agree with.
        materialize_consensus_for_project(db, 55)
        stored = db.query(CodeApplication).filter(
            CodeApplication.segment_id == seg, CodeApplication.origin == "consensus",
        ).one()
        assert stored.code_id == positive.id
        assert json.loads(stored.origin_context)["code_set"]["voters"] == 2
        assert stored.magnitude == 7.5

        # The grid's live column.
        grid = build_reconciliation(db, 55)
        unit = next(u for u in grid["units"] if u["unit_id"] == seg)
        assert unit["consensus"] == [positive.id]

        # The rollup — the consumer that had no split at all.
        rollup = compute_magnitude_rollup(db, 55)
        assert [(s.participant_id, s.code_id, s.mean) for s in rollup.scores] == [
            (person.id, positive.id, 7.5)
        ]
        assert "no_code_consensus" not in rollup.excluded_ratings


class TestTheGridFlagsAContradiction:
    def test_a_contradiction_every_coder_shares_still_needs_review(self, db_session):
        """`_set_selections` flags `SET_MULTIPLE` whatever the others chose. It is
        the ONLY flag when every coder holds the SAME two values: their code
        sets are identical, so `has_disagreement` is false, and after #1017 the
        comparable values are empty. Found by a surviving mutant — nothing
        pinned it before."""
        from app.services.reconciliation import build_reconciliation

        db = db_session
        _code_set, (positive, negative, _u) = _stance_project(db, 56)
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        for uid in (2, 3):
            _apply(db, positive.id, uid, 5600)
            _apply(db, negative.id, uid, 5600)
        unit = next(u for u in build_reconciliation(db, 56)["units"] if u["unit_id"] == 5600)
        assert unit["has_disagreement"] is False, "precondition: identical code sets"
        assert unit["has_set_disagreement"] is True
        assert unit["consensus"] == [], "and no consensus for a contradiction (#1017)"


class TestOneDecisionForATarget:
    """🔴 #1018's durable half. The split + set-decider loop was written out three
    times and a fourth consumer had none of it. The deciders may be CALLED only
    from `consensus.decide_target`, and `decide_target` has exactly the four
    consumers below — a fifth fails this until it is listed, a sixth copy of the
    loop fails it outright."""

    _DECIDERS = {"_decide_consensus", "_decide_set_selection", "split_set_choices"}
    _CONSUMERS = {
        ("services/consensus.py", "recompute_consensus_for_target"),
        ("services/consensus.py", "materialize_consensus_for_project"),
        ("services/reconciliation.py", "build_reconciliation"),
        ("services/magnitude_rollup.py", "compute_magnitude_rollup"),
    }

    @staticmethod
    def _calls(tree, names):
        """``(outermost enclosing function, callee)`` for each call to ``names``."""
        import ast

        found = []
        for top in tree.body:
            if not isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(top):
                if isinstance(node, ast.Call):
                    fn = node.func
                    name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
                    if name in names:
                        found.append((top.name, name))
        return found

    def _scan(self, names):
        import ast

        from tests.guard_support import APP_DIR, app_files

        out = set()
        for path in app_files(floor=100, sentinels=("services/consensus.py",)):
            rel = path.relative_to(APP_DIR).as_posix()
            for func, callee in self._calls(ast.parse(path.read_text()), names):
                out.add((rel, func, callee))
        return out

    def test_the_deciders_are_called_only_from_decide_target(self):
        calls = self._scan(self._DECIDERS)
        # Population: the three calls inside `decide_target` must be SEEN, or a
        # scan that walks nothing would pass the next assertion vacuously.
        assert {c for (_f, _fn, c) in calls} == self._DECIDERS
        stray = {c for c in calls if (c[0], c[1]) != ("services/consensus.py", "decide_target")}
        assert not stray, (
            f"{sorted(stray)} decide a target outside `consensus.decide_target`. Call it "
            "instead — a copy of the split + set loop is how #1018 happened."
        )

    def test_decide_target_has_exactly_the_four_consumers(self):
        consumers = {(f, fn) for (f, fn, _c) in self._scan({"decide_target"})}
        assert consumers == self._CONSUMERS, (
            "A consumer of `decide_target` was added or lost. If it was added on "
            "purpose, list it here AND in the internal design notes"
        )

    def test_the_scanner_sees_a_stray_call(self):
        """Predicate falsifier: the matcher fires on the shape it forbids."""
        import ast

        tree = ast.parse("def elsewhere(x):\n    return helpers._decide_consensus(x)\n")
        assert self._calls(tree, self._DECIDERS) == [("elsewhere", "_decide_consensus")]


# ── 5. The write path ────────────────────────────────────────────────────────


class TestApplySelection:
    def test_choosing_a_second_value_CLEARS_the_first_in_one_act(self, db_session):
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 60)
        _coder(db, 2, "alice")
        resolved = _index(db, 60).by_id(code_set.id)
        cs.apply_selection(db, resolved, user_id=2, code_id=positive.id, segment_ids=[6000])
        outcome = cs.apply_selection(
            db, resolved, user_id=2, code_id=negative.id, segment_ids=[6000],
        )
        assert outcome.code_id == negative.id and outcome.removed == 1
        # #1066 — what it WROTE rides the result, so a bulk caller can count it.
        assert (outcome.inserted, outcome.already_held) == (1, 0)
        held = {
            r.code_id for r in db.query(CodeApplication).filter(
                CodeApplication.segment_id == 6000, CodeApplication.user_id == 2,
            ).all()
        }
        assert held == {negative.id}

    def test_it_never_touches_a_COLLEAGUES_selection(self, db_session):
        """The per-coder layer rule. ⚠️ The caller is the HIGHER id on purpose:
        the unique index is keyed `(segment, code, user)`, so an unscoped
        `.first()` returns the LOWEST user's row and would pass by luck."""
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 61)
        _coder(db, 2, "alice"); _coder(db, 3, "bob")
        resolved = _index(db, 61).by_id(code_set.id)
        cs.apply_selection(db, resolved, user_id=2, code_id=positive.id, segment_ids=[6100])
        cs.apply_selection(db, resolved, user_id=3, code_id=negative.id, segment_ids=[6100])
        alice = db.query(CodeApplication).filter(
            CodeApplication.segment_id == 6100, CodeApplication.user_id == 2,
        ).one()
        assert alice.code_id == positive.id

    def test_a_null_selection_clears_and_writes_nothing(self, db_session):
        db = db_session
        code_set, (positive, _n, _u) = _stance_project(db, 62)
        _coder(db, 2, "alice")
        resolved = _index(db, 62).by_id(code_set.id)
        cs.apply_selection(db, resolved, user_id=2, code_id=positive.id, segment_ids=[6200])
        outcome = cs.apply_selection(
            db, resolved, user_id=2, code_id=None, segment_ids=[6200],
        )
        assert outcome.code_id is None and outcome.removed == 1
        assert (outcome.inserted, outcome.already_held) == (0, 0)
        assert db.query(CodeApplication).filter(
            CodeApplication.segment_id == 6200,
        ).count() == 0

    def test_a_code_outside_the_set_is_REFUSED_before_anything_is_removed(self, db_session):
        """Atomicity from the other side: a refusal must not have cleared the
        existing selection on its way to failing."""
        db = db_session
        code_set, (positive, _n, _u) = _stance_project(db, 63)
        outsider = _code(db, 6301, 63, 40, "Mentions policy")
        _coder(db, 2, "alice")
        resolved = _index(db, 63).by_id(code_set.id)
        cs.apply_selection(db, resolved, user_id=2, code_id=positive.id, segment_ids=[6300])
        with pytest.raises(cs.SetSelectionError):
            cs.apply_selection(db, resolved, user_id=2, code_id=outsider.id, segment_ids=[6300])
        assert db.query(CodeApplication).filter(
            CodeApplication.segment_id == 6300, CodeApplication.user_id == 2,
        ).one().code_id == positive.id

    def test_the_selection_reaches_every_sibling_of_a_segment_GROUP(self, db_session):
        """A group is coded as ONE unit, so a selection that differed across its
        members would be a distinction the interface never offered."""
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 64)
        db.add(SegmentGroup(id=6400, conversation_id=64))
        db.flush()
        for sid in (6400, 6401, 6402):
            seg = db.get(Segment, sid)
            seg.group_id = 6400
        db.flush()
        _coder(db, 2, "alice")
        resolved = _index(db, 64).by_id(code_set.id)
        cs.apply_selection(
            db, resolved, user_id=2, code_id=positive.id, segment_ids=[6400, 6401, 6402],
        )
        cs.apply_selection(
            db, resolved, user_id=2, code_id=negative.id, segment_ids=[6400, 6401, 6402],
        )
        held = db.query(CodeApplication).filter(
            CodeApplication.segment_id.in_([6400, 6401, 6402]),
            CodeApplication.user_id == 2,
        ).all()
        assert len(held) == 3
        assert {r.code_id for r in held} == {negative.id}

    def test_the_clear_is_keyed_on_RAW_member_ids(self, db_session):
        """A coder's row names the code they pressed. Clearing by EFFECTIVE id
        would leave a grouped sibling's application standing and the unit would
        still read as two selections."""
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 65)
        alias = _code(db, 6501, 65, 31, "Pos", code_set_id=code_set.id)
        group = CodeEquivalenceGroup(
            id=6500, project_id=65, label="Pos family", canonical_code_id=positive.id,
        )
        db.add(group)
        db.flush()
        positive.code_equivalence_group_id = group.id
        alias.code_equivalence_group_id = group.id
        db.flush()
        _coder(db, 2, "alice")
        resolved = _index(db, 65).by_id(code_set.id)
        assert alias.id in resolved.raw_member_ids
        assert alias.id not in resolved.member_ids  # it resolves to `positive`

        cs.apply_selection(db, resolved, user_id=2, code_id=alias.id, segment_ids=[6500])
        removed = cs.apply_selection(
            db, resolved, user_id=2, code_id=negative.id, segment_ids=[6500],
        ).removed
        assert removed == 1
        held = {
            r.code_id for r in db.query(CodeApplication).filter(
                CodeApplication.segment_id == 6500,
            ).all()
        }
        assert held == {negative.id}

    def test_re_choosing_the_same_value_is_idempotent(self, db_session):
        db = db_session
        code_set, (positive, _n, _u) = _stance_project(db, 66)
        _coder(db, 2, "alice")
        resolved = _index(db, 66).by_id(code_set.id)
        cs.apply_selection(db, resolved, user_id=2, code_id=positive.id, segment_ids=[6600])
        cs.apply_selection(db, resolved, user_id=2, code_id=positive.id, segment_ids=[6600])
        assert db.query(CodeApplication).filter(
            CodeApplication.segment_id == 6600,
        ).count() == 1

    def test_exactly_one_target_kind_is_required(self, db_session):
        db = db_session
        code_set, _members = _stance_project(db, 67)
        resolved = _index(db, 67).by_id(code_set.id)
        with pytest.raises(ValueError, match="exactly one"):
            cs.apply_selection(db, resolved, user_id=2, code_id=None)
        with pytest.raises(ValueError, match="exactly one"):
            cs.apply_selection(
                db, resolved, user_id=2, code_id=None,
                segment_ids=[6700], dataset_value_ids=[9],
            )


# ── 6. The ROUTERS — entering at the pipeline's mouth ────────────────────────
#
# 🔴 `backend/tests/the internal design notes: a fix that INSERTS A CALL into a pipeline needs a
# test that enters at the pipeline's MOUTH. Unit-testing the service proves the
# functions work and says NOTHING about whether the endpoints reach them — which
# is the shape that let `renumber_imported_notes` renumber nothing on every
# import while all three of its guards passed.
#
# ⚠️ Both selection endpoints are plain `def` (#837), so they are called
# DIRECTLY and never wrapped in `asyncio.run`.


class TestTheEndpoints:
    def _project_with_coder(self, db, pid):
        code_set, members = _stance_project(db, pid)
        _coder(db, 2, "alice")
        return code_set, members, db.get(User, 1)

    def test_the_whole_loop_reaches_the_statistic(self, db_session):
        """Create → add values → two coders select → the α is on the payload.

        The one test that would fail if any link in the chain were wired to
        nothing, which is what the service-level tests above cannot say.
        """
        from app.routers.code_sets import add_codes, create_code_set, list_code_sets
        from app.routers.coding import set_segment_code_set_selection
        from app.schemas.code_set import (
            CodeSetAddCodes, CodeSetCreate, CodeSetSelectionRequest,
        )

        db = db_session
        _project(db, 70)
        db.add(Conversation(id=70, project_id=70, name="Posts"))
        db.flush()
        for i in range(4):
            _seg(db, 7000 + i, 70, i)
        positive = _code(db, 7001, 70, 10, "Positive")
        negative = _code(db, 7003, 70, 12, "Negative")
        neutral = _code(db, 7007, 70, 15, "Neutral")
        owner = db.get(User, 1)
        _coder(db, 2, "alice")
        alice = db.get(User, 2)

        created = create_code_set(
            project_id=70,
            data=CodeSetCreate(label="Stance", exhaustive=False),
            user=owner, db=db,
        )
        assert created.set_basis == cs.SET_BASIS_INCLUSIVE_WITH_NONE

        add_codes(
            project_id=70, set_id=created.id,
            data=CodeSetAddCodes(code_ids=[positive.id, negative.id, neutral.id]),
            user=owner, db=db,
        )
        listed = list_code_sets(project_id=70, user=owner, db=db)
        assert [m.name for m in listed.sets[0].members] == ["Positive", "Negative", "Neutral"]

        # Two coders, agreeing on two units and differing on one.
        for uid, user in ((1, owner), (2, alice)):
            for seg, code in ((7000, positive), (7001, negative)):
                set_segment_code_set_selection(
                    segment_id=seg, set_id=created.id,
                    data=CodeSetSelectionRequest(code_id=code.id), user=user, db=db,
                )
        set_segment_code_set_selection(
            segment_id=7002, set_id=created.id,
            data=CodeSetSelectionRequest(code_id=positive.id), user=owner, db=db,
        )
        set_segment_code_set_selection(
            segment_id=7002, set_id=created.id,
            data=CodeSetSelectionRequest(code_id=neutral.id), user=alice, db=db,
        )

        payload = compute_irr(db, 70)
        assert payload["available"] is True
        row = payload["set_agreement"][0]
        assert row["label"] == "Stance"
        assert row["krippendorff_alpha"] is not None
        assert row["n_values"] == 3
        # …and the values are absent from the per-code table, which is the
        # display decision this slab makes.
        assert {r["code_id"] for r in payload["per_code"]} == set()

    def test_the_endpoint_SWAPS_rather_than_accumulating(self, db_session):
        from app.routers.coding import set_segment_code_set_selection
        from app.schemas.code_set import CodeSetSelectionRequest

        db = db_session
        code_set, (positive, negative, _u), owner = self._project_with_coder(db, 71)
        for code in (positive, negative):
            set_segment_code_set_selection(
                segment_id=7100, set_id=code_set.id,
                data=CodeSetSelectionRequest(code_id=code.id), user=owner, db=db,
            )
        held = db.query(CodeApplication).filter(
            CodeApplication.segment_id == 7100, CodeApplication.user_id == owner.id,
        ).all()
        assert [r.code_id for r in held] == [negative.id]

    def test_the_endpoint_REFUSES_an_inactive_value(self, db_session):
        """A value deactivated after joining stays a MEMBER and cannot be CHOSEN
        — the panel filters on the same rule, so the control is never offered."""
        from fastapi import HTTPException
        from app.routers.coding import set_segment_code_set_selection
        from app.schemas.code_set import CodeSetSelectionRequest

        db = db_session
        code_set, (positive, _n, _u), owner = self._project_with_coder(db, 72)
        positive.is_active = False
        db.flush()
        with pytest.raises(HTTPException) as exc:
            set_segment_code_set_selection(
                segment_id=7200, set_id=code_set.id,
                data=CodeSetSelectionRequest(code_id=positive.id), user=owner, db=db,
            )
        assert exc.value.status_code == 400

    def test_the_membership_door_REFUSES_a_universal_code_with_its_words(self, db_session):
        from fastapi import HTTPException
        from app.routers.code_sets import add_codes
        from app.schemas.code_set import CodeSetAddCodes

        db = db_session
        code_set, _members, owner = self._project_with_coder(db, 73)
        universal = _code(db, 7301, 73, 0, "Unsubstantive", is_universal=True)
        with pytest.raises(HTTPException) as exc:
            add_codes(
                project_id=73, set_id=code_set.id,
                data=CodeSetAddCodes(code_ids=[universal.id]),
                user=owner, db=db,
            )
        assert exc.value.status_code == 409
        # The SERVER's sentence reaches the client, named and explained (#871).
        assert "Unsubstantive" in exc.value.detail["message"]
        assert exc.value.detail["refusals"][0]["reason"] == cs.REFUSAL_UNIVERSAL

    def test_removing_the_last_value_DISSOLVES_the_set(self, db_session):
        from app.routers.code_sets import remove_codes
        from app.schemas.code_set import CodeSetRemoveCodes

        db = db_session
        code_set, (positive, negative, neutral), owner = self._project_with_coder(db, 74)
        result = remove_codes(
            project_id=74, set_id=code_set.id,
            data=CodeSetRemoveCodes(code_ids=[positive.id, negative.id, neutral.id]),
            user=owner, db=db,
        )
        assert result.dissolved is True
        assert db.query(CodeSet).filter(CodeSet.id == code_set.id).count() == 0
        # ⚠️ The CODES survive: removing a value from a variable does not
        # un-code the passages somebody judged with it.
        assert db.query(Code).filter(Code.id == positive.id).count() == 1

    def test_deleting_a_set_RELEASES_its_codes_and_keeps_their_codings(self, db_session):
        from app.routers.code_sets import delete_code_set

        db = db_session
        code_set, (positive, _n, _u), owner = self._project_with_coder(db, 75)
        _apply(db, positive.id, 1, 7500)
        result = delete_code_set(project_id=75, set_id=code_set.id, user=owner, db=db)
        assert result["released_codes"] == 3
        assert db.get(Code, positive.id).code_set_id is None
        assert db.query(CodeApplication).filter(
            CodeApplication.segment_id == 7500,
        ).count() == 1


# ── 6b. #1028 — a synonym grouped INTO a value is a CLAIMANT ─────────────────


def _group(db, gid, pid, canonical, *codes):
    """Group ``codes`` (canonical first) as one effective code."""
    db.add(CodeEquivalenceGroup(
        id=gid, project_id=pid, label=f"group {gid}", canonical_code_id=canonical.id,
    ))
    db.flush()
    for code in (canonical, *codes):
        code.code_equivalence_group_id = gid
    db.flush()


def _held(db, uid, segment_id):
    return {
        r.code_id for r in db.query(CodeApplication).filter(
            CodeApplication.segment_id == segment_id, CodeApplication.user_id == uid,
        ).all()
    }


class TestClaimants:
    """#1028(b): "Pos" is NOT in the set, yet grouped with the member "Positive"
    every consumer that reads the EFFECTIVE code records it as choosing
    "Positive". The write path cleared members only, so the swap left it
    standing — the unit read as two selections and nothing on the set said so.
    (Executed by the audit: `selection_for` = −2, `set_composition_warnings` = [].)
    """

    def _with_synonym(self, db, pid):
        code_set, (positive, negative, neutral) = _stance_project(db, pid)
        synonym = _code(db, pid * 10 + 9, pid, 40, "Pos")  # NOT a member
        _group(db, pid * 10, pid, positive, synonym)
        return code_set, (positive, negative, neutral), synonym

    def test_a_synonym_is_a_claimant_that_reads_as_its_value(self, db_session):
        db = db_session
        code_set, (positive, negative, _u), synonym = self._with_synonym(db, 80)
        resolved = _index(db, 80).by_id(code_set.id)
        assert synonym.id not in resolved.raw_member_ids  # it never joined
        assert resolved.claimants[synonym.id] == positive.id
        assert resolved.claimants[negative.id] == negative.id
        assert _index(db, 80).set_claimed_by(synonym.id).id == code_set.id

    def test_choosing_another_value_CLEARS_the_synonym(self, db_session):
        db = db_session
        code_set, (_p, negative, _u), synonym = self._with_synonym(db, 81)
        _coder(db, 2, "alice")
        _apply(db, synonym.id, 2, 8100)
        resolved = _index(db, 81).by_id(code_set.id)
        removed = cs.apply_selection(
            db, resolved, user_id=2, code_id=negative.id, segment_ids=[8100],
        ).removed
        assert removed == 1
        assert _held(db, 2, 8100) == {negative.id}
        effective = build_effective_code_map(db, 81)
        applied = {effective.get(c, c) for c in _held(db, 2, 8100)}
        assert cs.selection_for(applied, resolved) == negative.id

    def test_the_set_REPORTS_a_synonym_it_does_not_list(self, db_session):
        db = db_session
        _set, (positive, negative, neutral), synonym = self._with_synonym(db, 82)
        warnings = cs.set_composition_warnings(
            [positive, negative, neutral],
            effective_map=build_effective_code_map(db, 82),
            codes_by_id={c.id: c for c in (positive, negative, neutral, synonym)},
        )
        assert len(warnings) == 1
        assert "“Pos”" in warnings[0] and "“Positive”" in warnings[0]
        assert "choosing another value clears it" in warnings[0]

    def test_the_claimants_ride_the_list_payload(self, db_session):
        from app.routers.code_sets import list_code_sets

        db = db_session
        code_set, (positive, negative, neutral), synonym = self._with_synonym(db, 84)
        listed = list_code_sets(project_id=84, user=db.get(User, 1), db=db)
        claimants = {c.code_id: c.value_id for c in listed.sets[0].claimants}
        assert claimants == {
            positive.id: positive.id, negative.id: negative.id,
            neutral.id: neutral.id, synonym.id: positive.id,
        }


class TestADoubleClaimantCountsInOneSet:
    """#1081 (b): "Warm" is a member of "Tone" grouped into "Positive", a value of
    "Stance" — reachable from the equivalence side only (the set's door refuses
    it, `set_composition_warnings` reports it). It reads as "Positive" wherever
    the effective code is read, so it counts in STANCE and as nothing in Tone.

    The claimant list carried it in BOTH sets and `set_claimed_by` answered its
    own, so pressing it cleared "Cold" in Tone (where it does not count) and left
    Stance holding two values; pressing "Cold" removed it, which was the coder's
    Stance choice. Executed by the audit, both ways.
    """

    def _double(self, db, pid):
        stance, (positive, negative, neutral) = _stance_project(db, pid)
        tone = CodeSet(id=pid * 10 + 5, project_id=pid, label="Tone")
        db.add(tone)
        db.flush()
        warm = _code(db, pid * 10 + 8, pid, 50, "Warm", code_set_id=tone.id)
        cold = _code(db, pid * 10 + 9, pid, 51, "Cold", code_set_id=tone.id)
        _group(db, pid * 10, pid, positive, warm)
        return stance, tone, (positive, negative, neutral), warm, cold

    def test_it_claims_ONLY_the_set_it_counts_in(self, db_session):
        db = db_session
        stance, tone, (positive, _n, _u), warm, cold = self._double(db, 160)
        index = _index(db, 160)
        assert index.by_id(stance.id).claimants[warm.id] == positive.id
        assert warm.id not in index.by_id(tone.id).claimants
        assert index.by_id(tone.id).claimants[cold.id] == cold.id
        assert index.set_claimed_by(warm.id).id == stance.id

    def test_a_member_grouped_with_ANOTHER_MEMBER_still_counts_in_its_set(self, db_session):
        """The positive control for the narrowing: "Cool" grouped under "Cold" —
        both Tone members — reads as a Tone value and stays a claimant there."""
        db = db_session
        _stance, tone, _values, _warm, cold = self._double(db, 161)
        cool = _code(db, 1615, 161, 52, "Cool", code_set_id=tone.id)
        _group(db, 1611, 161, cold, cool)
        resolved = _index(db, 161).by_id(tone.id)
        assert resolved.claimants[cool.id] == cold.id
        cs.apply_selection(db, resolved, user_id=1, code_id=cool.id, segment_ids=[16100])
        assert _held(db, 1, 16100) == {cool.id}

    def test_pressing_it_swaps_in_the_set_it_COUNTS_in(self, db_session):
        db = db_session
        stance, _tone, (positive, negative, _u), warm, cold = self._double(db, 162)
        _coder(db, 2, "alice")
        _apply(db, negative.id, 2, 16200)
        _apply(db, cold.id, 2, 16200)
        response = _seg_apply(db, 2, 16200, warm.id)
        assert response.replaced_code_ids == [negative.id]
        assert _held(db, 2, 16200) == {warm.id, cold.id}, "Tone's Cold is untouched"
        effective = build_effective_code_map(db, 162)
        applied = {effective.get(c, c) for c in _held(db, 2, 16200)}
        assert cs.selection_for(applied, _index(db, 162).by_id(stance.id)) == positive.id

    def test_pressing_a_value_of_its_OWN_set_leaves_it_standing(self, db_session):
        db = db_session
        _stance, _tone, _values, warm, cold = self._double(db, 163)
        _coder(db, 2, "alice")
        _apply(db, warm.id, 2, 16300)
        response = _seg_apply(db, 2, 16300, cold.id)
        assert response.replaced_code_ids == []
        assert _held(db, 2, 16300) == {warm.id, cold.id}

    def test_its_OWN_sets_endpoint_refuses_it_and_says_why(self, db_session):
        """`schemas/code_set.py` has said since row 48 that such a member "cannot
        be chosen through this set"; nothing enforced it, and writing it there
        cleared Tone and counted in Stance. Entered at the ENDPOINT."""
        from fastapi import HTTPException
        from app.routers.coding import set_segment_code_set_selection
        from app.schemas.code_set import CodeSetSelectionRequest

        db = db_session
        _stance, tone, _values, warm, cold = self._double(db, 164)
        _apply(db, cold.id, 1, 16400)
        with pytest.raises(HTTPException) as exc:
            set_segment_code_set_selection(
                segment_id=16400, set_id=tone.id,
                data=CodeSetSelectionRequest(code_id=warm.id), user=db.get(User, 1), db=db,
            )
        assert exc.value.status_code == 400
        assert "“Warm”" in exc.value.detail and "“Tone”" in exc.value.detail
        assert _held(db, 1, 16400) == {cold.id}, "a refusal writes nothing"

    def test_the_list_payload_no_longer_offers_it_to_its_own_set(self, db_session):
        from app.routers.code_sets import list_code_sets

        db = db_session
        stance, tone, (positive, _n, _u), warm, _cold = self._double(db, 165)
        listed = {s.id: s for s in list_code_sets(project_id=165, user=db.get(User, 1), db=db).sets}
        assert warm.id not in {c.code_id for c in listed[tone.id].claimants}
        assert {c.code_id: c.value_id for c in listed[stance.id].claimants}[warm.id] == positive.id


def _merge(db, pid, source_id, target_id, uid=1):
    import asyncio
    from app.routers.codes import merge_codes

    return asyncio.run(merge_codes(
        pid, source_id, target_id, delete_source=False, user=db.get(User, uid), db=db,
    ))


class TestACodeMergeSaysWhatItContradicted:
    """#1081 (a): a code merge re-points one code's applications onto another and
    is the one coding write that does NOT go through the swap. A coder holding
    "Upbeat" (in no set) and "Negative" ends holding "Positive" AND "Negative"
    once "Upbeat" is merged into "Positive" — a contradiction the set's α counts
    and drops, made silently (executed by the audit: `selection_for` = −2, the
    response says nothing, and a merge has no undo). Counted and said, never
    resolved: which value the coder meant is theirs to choose."""

    def test_the_contradiction_it_MAKES_is_counted_and_named(self, db_session):
        db = db_session
        _stance, (positive, negative, _u) = _stance_project(db, 166)
        upbeat = _code(db, 1669, 166, 40, "Upbeat")   # in no set
        _coder(db, 2, "alice")
        _apply(db, upbeat.id, 2, 16600)
        _apply(db, negative.id, 2, 16600)
        _apply(db, upbeat.id, 2, 16601)                # no other value here: no contradiction
        result = _merge(db, 166, upbeat.id, positive.id)
        assert (result.set_contradictions, result.contradiction_set_label) == (1, "Stance")
        assert _held(db, 2, 16600) == {positive.id, negative.id}, "said, not resolved"

    def test_a_merge_into_a_code_in_NO_set_reports_nothing(self, db_session):
        """And costs no query — the target counts in no set."""
        db = db_session
        _stance_project(db, 167)
        upbeat = _code(db, 1678, 167, 40, "Upbeat")
        cheerful = _code(db, 1679, 167, 41, "Cheerful")
        _apply(db, upbeat.id, 1, 16700)
        result = _merge(db, 167, upbeat.id, cheerful.id)
        assert (result.set_contradictions, result.contradiction_set_label) == (0, None)

    def test_a_COLLEAGUE_holding_the_other_value_is_not_a_contradiction(self, db_session):
        """A contradiction is ONE coder holding two values; two coders differing is
        a disagreement, which is what the set's α exists to measure.

        ⚠️ The colleague ALSO moves a coding elsewhere (16801), so they are among
        the coders the count asks about: a count keyed on the passage alone would
        read their Negative on 16800 as Alice's contradiction."""
        db = db_session
        _stance, (positive, negative, _u) = _stance_project(db, 168)
        upbeat = _code(db, 1689, 168, 40, "Upbeat")
        _coder(db, 2, "alice")
        _apply(db, upbeat.id, 2, 16800)
        _apply(db, negative.id, 1, 16800)
        _apply(db, upbeat.id, 1, 16801)
        assert _merge(db, 168, upbeat.id, positive.id).set_contradictions == 0

    def test_a_SYNONYM_of_the_target_is_its_own_value_not_another(self, db_session):
        """"Pos" grouped into "Positive" is the same choice — holding it beside a
        merged-in "Positive" is no contradiction."""
        db = db_session
        _stance, (positive, _n, _u) = _stance_project(db, 169)
        upbeat = _code(db, 1698, 169, 40, "Upbeat")
        pos = _code(db, 1699, 169, 41, "Pos")
        _group(db, 1690, 169, positive, pos)
        _apply(db, upbeat.id, 1, 16900)
        _apply(db, pos.id, 1, 16900)
        assert _merge(db, 169, upbeat.id, positive.id).set_contradictions == 0

    def test_the_count_reaches_the_wire(self, db_session):
        """#855's lesson for the merge: a field the service fills and the schema
        does not declare is dropped with no error."""
        from app.schemas.code import MergeCodesResponse
        assert {"set_contradictions", "contradiction_set_label"} <= set(MergeCodesResponse.model_fields)


# ── 6c. #1028(a) — EVERY apply door is exclusive, not only the set's own ──────


def _seg_apply(db, uid, segment_id, code_id):
    import asyncio
    from app.routers.coding import apply_code

    return asyncio.run(apply_code(segment_id, code_id, None, user=db.get(User, uid), db=db))


def _seg_bulk(db, uid, segment_ids, code_id, action="apply"):
    import asyncio
    from app.routers.coding import bulk_code
    from app.schemas.coding import BulkCodeRequest

    return asyncio.run(bulk_code(
        BulkCodeRequest(segment_ids=segment_ids, code_id=code_id, action=action),
        user=db.get(User, uid), db=db,
    ))


class TestEveryApplyDoorIsExclusive:
    """#1028(a): only the strip swapped. A chord, a click in the code list, the
    context menu, *+ Add code* and a bulk apply all went through `apply_code` /
    `bulk_code`, which ADDED a second value — executed by the audit: the coder
    held both, `selection_for` = −2, `n_multiple_selection` = 1, and no consensus
    row was written on the unit. The rule now holds at the door they share.

    ⚠️ Every endpoint here is `async def` and awaits nothing, so it is wrapped in
    `asyncio.run` — unlike the two selection endpoints above, which are `def`.
    """

    def test_applying_a_value_REPLACES_the_coders_other_value(self, db_session):
        db = db_session
        code_set, (positive, negative, _u) = _stance_project(db, 90)
        _coder(db, 2, "alice")
        _seg_apply(db, 2, 9000, positive.id)
        response = _seg_apply(db, 2, 9000, negative.id)
        assert _held(db, 2, 9000) == {negative.id}
        assert response.replaced_code_ids == [positive.id]
        resolved = _index(db, 90).by_id(code_set.id)
        assert cs.selection_for(_held(db, 2, 9000), resolved) == negative.id

    def test_the_contradiction_no_longer_reaches_the_statistic(self, db_session):
        """The audit's own measurement, entered at the endpoint: before the fix
        this unit counted in `n_multiple_selection` and the coder dropped out."""
        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 91)
        _coder(db, 2, "alice")
        for seg in (9100, 9101):
            _seg_apply(db, 1, seg, positive.id)
            _seg_apply(db, 2, seg, positive.id)
        _seg_apply(db, 2, 9100, negative.id)
        row = compute_irr(db, 91)["set_agreement"][0]
        assert row["n_multiple_selection"] == 0

    def test_it_never_touches_a_COLLEAGUES_value(self, db_session):
        """⚠️ The caller is the HIGHER id: an unscoped delete keyed on the lowest
        user's row would pass by luck (magnitude-coding.md §4)."""
        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 92)
        _coder(db, 2, "alice")
        _apply(db, positive.id, 1, 9200)
        _apply(db, positive.id, 2, 9200)
        _seg_apply(db, 2, 9200, negative.id)
        assert _held(db, 1, 9200) == {positive.id}
        assert _held(db, 2, 9200) == {negative.id}

    def test_pressing_one_of_TWO_held_values_chooses_it(self, db_session):
        """A contradiction (a merge, legacy data) resolved by the coder pressing
        the value they mean — the one case where re-applying is not a no-op."""
        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 93)
        _coder(db, 2, "alice")
        _apply(db, positive.id, 2, 9300)
        _apply(db, negative.id, 2, 9300)
        response = _seg_apply(db, 2, 9300, positive.id)
        assert _held(db, 2, 9300) == {positive.id}
        assert response.replaced_code_ids == [negative.id]

    def test_a_replacement_on_the_ALREADY_APPLIED_path_marks_the_passage_stale(self, db_session):
        """That path returns early, and used to write only when a rating
        changed — a value removed there moves the consensus and the scores just
        the same, so it must say so to both markers (the every-mutation-site
        rule). Two roster coders, so consensus is enabled."""
        from app.models.consensus_stale_target import ConsensusStaleTarget
        from app.models.dataset import Dataset

        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 88)
        _coder(db, 2, "alice")
        table = Dataset(id=88, project_id=88, name="Participants", managed_kind="participants")
        db.add(table)
        db.flush()
        _apply(db, positive.id, 2, 8800)
        _apply(db, negative.id, 2, 8800)
        _seg_apply(db, 2, 8800, positive.id)
        assert db.query(ConsensusStaleTarget).filter(
            ConsensusStaleTarget.segment_id == 8800,
        ).count() == 1
        db.refresh(table)
        assert table.managed_stale is True

    def test_the_swap_covers_every_sibling_of_a_GROUP(self, db_session):
        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 94)
        db.add(SegmentGroup(id=9400, conversation_id=94))
        db.flush()
        for sid in (9400, 9401):
            db.get(Segment, sid).group_id = 9400
        db.flush()
        _coder(db, 2, "alice")
        _seg_apply(db, 2, 9400, positive.id)  # fans out to 9401
        _seg_apply(db, 2, 9401, negative.id)
        assert _held(db, 2, 9400) == {negative.id}
        assert _held(db, 2, 9401) == {negative.id}

    def test_a_SYNONYM_apply_replaces_the_other_value_too(self, db_session):
        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 95)
        synonym = _code(db, 959, 95, 40, "Pos")
        _group(db, 950, 95, positive, synonym)
        _coder(db, 2, "alice")
        _seg_apply(db, 2, 9500, negative.id)
        response = _seg_apply(db, 2, 9500, synonym.id)
        assert _held(db, 2, 9500) == {synonym.id}
        assert response.replaced_code_ids == [negative.id]

    def test_an_ORDINARY_code_costs_no_set_query(self, db_session, monkeypatch):
        """The hot path: a code in no set and no group can count in no set, so
        a chord on it must not build the index."""
        db = db_session
        _set, (positive, _n, _u) = _stance_project(db, 96)
        ordinary = _code(db, 969, 96, 40, "Mentions policy")
        _seg_apply(db, 1, 9600, positive.id)

        def boom(*_a, **_k):
            raise AssertionError("an ordinary code built the code-set index")

        monkeypatch.setattr(cs, "build_code_set_index", boom)
        response = _seg_apply(db, 1, 9600, ordinary.id)
        assert response.replaced_code_ids == []
        assert _held(db, 1, 9600) == {positive.id, ordinary.id}

    def test_the_audit_entry_names_what_the_apply_replaced(self, db_session):
        """Provenance (the third of the five questions): which of the coder's
        judgements a keypress overwrote is recorded, not only the new one."""
        import json
        from app.models.audit import AuditEntry

        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 97)
        _seg_apply(db, 1, 9700, positive.id)
        _seg_apply(db, 1, 9700, negative.id)
        details = [
            json.loads(e.details) for e in db.query(AuditEntry).filter(
                AuditEntry.action == "code_applied",
            ).all()
        ]
        assert details[-1]["replaced_code_ids"] == [positive.id]
        assert "replaced_code_ids" not in details[0]

    def test_a_BULK_apply_replaces_per_segment_and_says_which(self, db_session):
        db = db_session
        _set, (positive, negative, neutral) = _stance_project(db, 98)
        _coder(db, 2, "alice")
        _apply(db, positive.id, 2, 9800)
        _apply(db, negative.id, 2, 9802)  # already holds the value applied
        _apply(db, neutral.id, 2, 9803)
        response = _seg_bulk(db, 2, [9800, 9801, 9802, 9803], negative.id)
        by_seg = {r.segment_id: r.replaced_code_ids for r in response.results}
        assert by_seg == {9800: [positive.id], 9801: [], 9802: [], 9803: [neutral.id]}
        for seg in (9800, 9801, 9802, 9803):
            assert _held(db, 2, seg) == {negative.id}

    def test_a_bulk_REMOVE_replaces_nothing(self, db_session):
        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 99)
        _apply(db, positive.id, 1, 9900)
        _seg_bulk(db, 1, [9900], negative.id, action="remove")
        assert _held(db, 1, 9900) == {positive.id}


def _text_cell(db, pid, n=2):
    from app.models.dataset import (
        ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue,
    )

    db.add(Dataset(id=pid, project_id=pid, name="Survey"))
    db.flush()
    db.add(DatasetColumn(
        id=pid, dataset_id=pid, column_code="Q1", column_name="Q1", column_text="Open",
        column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0,
    ))
    db.flush()
    cells = []
    for i in range(n):
        db.add(DatasetRow(id=pid * 10 + i, dataset_id=pid, row_identifier=f"R{i}"))
        db.flush()
        db.add(DatasetValue(id=pid * 100 + i, row_id=pid * 10 + i, column_id=pid, value_text="a"))
        db.flush()
        cells.append(pid * 100 + i)
    return cells


def _text_held(db, uid, cell):
    return {
        r.code_id for r in db.query(CodeApplication).filter(
            CodeApplication.dataset_value_id == cell, CodeApplication.user_id == uid,
        ).all()
    }


class TestTheTextCodingDoorsAreExclusive:
    """The fourth surface's two apply doors, body-keyed on the cell."""

    def test_applying_a_value_REPLACES_the_coders_other_value(self, db_session):
        import asyncio
        from app.routers.text_coding import apply_code
        from app.schemas.text_coding import TextCodeRequest

        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 100)
        _coder(db, 2, "alice")
        (cell, _other) = _text_cell(db, 100)
        _apply_text = lambda code: asyncio.run(apply_code(  # noqa: E731
            100, TextCodeRequest(dataset_value_id=cell, code_id=code.id),
            user=db.get(User, 2), db=db,
        ))
        _apply_text(positive)
        response = _apply_text(negative)
        assert _text_held(db, 2, cell) == {negative.id}
        assert response.replaced_code_ids == [positive.id]

    def test_a_replacement_on_the_ALREADY_APPLIED_path_marks_the_response_stale(self, db_session):
        """The segment twin's rule on this door (found by a SURVIVING mutant:
        nothing pinned it here)."""
        import asyncio
        from app.models.consensus_stale_target import ConsensusStaleTarget
        from app.models.dataset import Dataset
        from app.routers.text_coding import apply_code
        from app.schemas.text_coding import TextCodeRequest

        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 102)
        _coder(db, 2, "alice")
        (cell, _other) = _text_cell(db, 102)
        table = Dataset(id=1029, project_id=102, name="Participants", managed_kind="participants")
        db.add(table)
        db.add(CodeApplication(code_id=positive.id, user_id=2, dataset_value_id=cell))
        db.add(CodeApplication(code_id=negative.id, user_id=2, dataset_value_id=cell))
        db.flush()
        response = asyncio.run(apply_code(
            102, TextCodeRequest(dataset_value_id=cell, code_id=positive.id),
            user=db.get(User, 2), db=db,
        ))
        assert response.replaced_code_ids == [negative.id]
        assert db.query(ConsensusStaleTarget).filter(
            ConsensusStaleTarget.dataset_value_id == cell,
        ).count() == 1
        db.refresh(table)
        assert table.managed_stale is True

    def test_a_BULK_apply_replaces_per_response(self, db_session):
        import asyncio
        from app.routers.text_coding import bulk_code
        from app.schemas.text_coding import BulkCodeRequest

        db = db_session
        _set, (positive, negative, _u) = _stance_project(db, 101)
        (a, b) = _text_cell(db, 101)
        db.add(CodeApplication(code_id=positive.id, user_id=1, dataset_value_id=a))
        db.flush()
        response = asyncio.run(bulk_code(
            101, BulkCodeRequest(dataset_value_ids=[a, b], code_id=negative.id),
            user=db.get(User, 1), db=db,
        ))
        by_cell = {r.dataset_value_id: r.replaced_code_ids for r in response.results}
        assert by_cell == {a: [positive.id], b: []}
        assert _text_held(db, 1, a) == {negative.id}


# ── 7. Portability — the two formats a set has to survive ────────────────────


class TestPortability:
    """🔴 `.mmproject` and `.mmcodebook` were CLAIMED to carry a set before they
    were tested to. `_build_entity` keeps only columns the model declares, so a
    set whose membership vanished is not a degraded set — it is N loose codes and
    a reliability figure that no longer exists."""

    def test_a_set_and_its_membership_survive_a_project_round_trip(self, db_session, tmp_path):
        import os
        import tempfile
        from pathlib import Path

        from app.services.project_portability import export_project, import_project

        db = db_session
        code_set, (positive, negative, neutral) = _stance_project(db, 80)
        code_set.exhaustive = True
        db.flush()

        buf = export_project(db, 80, Path("/nonexistent"))
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(buf.getvalue())
            tmp.close()
            new_id, _ = import_project(
                db, Path(tmp.name), tmp_path / "docs", user_id=1,
            )
            db.flush()
        finally:
            os.unlink(tmp.name)

        imported = db.query(CodeSet).filter(CodeSet.project_id == new_id).all()
        assert len(imported) == 1
        assert imported[0].label == "Stance"
        # ⚠️ `exhaustive` must travel: without it the set imports with the
        # DEFAULT, silently changing what every blank means and therefore the α.
        assert imported[0].exhaustive is True
        # 🔴 A fresh uuid on import-as-new, or a re-import collides on the
        # unique index.
        assert imported[0].uuid != code_set.uuid

        members = db.query(Code).filter(
            Code.project_id == new_id, Code.code_set_id == imported[0].id,
        ).all()
        assert sorted(c.name for c in members) == ["Negative", "Neutral", "Positive"]
        # 🔴 And the FK points into THIS project, never at the source's row.
        assert imported[0].id != code_set.id

    def test_a_MERGE_does_not_import_codebook_structure(self, db_session, tmp_path):
        """A merge imports CODINGS, not codebook structure — `code_sets` joins
        `code_equivalence_groups` in the blanked list. **That is why there is no
        fifth `MergeDivergenceKind`:** the scope document proposed one, and the
        established blanking rule makes it unnecessary."""
        import pathlib as _pathlib

        import app.services.project_portability as pp

        source = _pathlib.Path(pp.__file__).read_text(encoding="utf-8")
        # The blanked set is an inline tuple in `import_project`, not a named
        # constant, so this reads the block rather than importing one. ⚠️ The
        # self-check first: a scan whose anchor has moved passes by finding
        # nothing, which is the failure mode a guard must not have.
        assert 'if import_mode == "merge":' in source, "the merge block moved"
        block = source.split('if import_mode == "merge":', 1)[1].split(":\n", 1)[0]
        assert '"code_equivalence_groups"' in block, (
            "the anchor no longer covers the blanked keys — this scan is blind"
        )
        assert '"code_sets"' in block, (
            "a merge must blank `code_sets`, or a colleague's codebook STRUCTURE "
            "is imported as well as their coding"
        )

    @pytest.mark.parametrize("action", ["new", "link"])
    def test_a_DIVERGENT_set_member_arrives_in_NO_set_through_a_merge(self, db_session, tmp_path, action):
        """#1039 (j): the merge's `"code_set_id": None` on a divergent code's insert
        was pinned by the source scan above ALONE. Both reconcile actions that
        insert a code take it.

        ⚠️ **The fixture makes the file's set id COLLIDE with a set in the
        target** — the same project, exported and merged back — because without
        the override `_build_entity` copies the raw id, and a colliding one is a
        SILENT wrong membership. A dangling id would only be an IntegrityError,
        which any test notices; this is the case that hides."""
        from app.services.project_portability import import_project
        from tests.test_trackj_j3_roundtrip import _export_to_file, _seed_coded

        db = db_session
        p, _conv, seg = _seed_coded(db, f"Sets {action}")
        local_set = CodeSet(project_id=p.id, label="Stance")
        db.add(local_set)
        db.flush()
        twin = Code(project_id=p.id, numeric_id=1, name="Positive", is_active=True,
                    code_set_id=local_set.id)
        diverge = Code(project_id=p.id, numeric_id=2, name="Upbeat", is_active=True,
                       code_set_id=local_set.id)
        db.add_all([twin, diverge])
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=diverge.id, user_id=1, origin="human"))
        db.flush()
        diverge_uuid = diverge.uuid
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "sets.mmproject")
        db.delete(diverge)   # the file's copy is now a code the target does not have
        db.flush()

        decision = {"action": action}
        if action == "link":
            decision["target_code_id"] = twin.id
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id, code_mapping={diverge_uuid: decision},
        )
        db.flush()
        arrived = db.query(Code).filter(Code.project_id == p.id, Code.name == "Upbeat").one()
        assert arrived.code_set_id is None, "a merge imports codings, not set membership"
        assert db.get(Code, twin.id).code_set_id == local_set.id, "the target's own set is untouched"

    def test_a_set_survives_a_codebook_round_trip_by_LABEL(self, db_session):
        """Keyed on the LABEL, because a codebook crosses projects and an id
        names a row in the exporting one."""
        from app.services.codebook_exchange import (
            export_codebook_native, import_codebook_native,
        )

        db = db_session
        code_set, (positive, negative, neutral) = _stance_project(db, 81)
        code_set.exhaustive = True
        db.flush()
        payload = export_codebook_native(db, 81)
        assert payload["codes"][0]["code_set"]["label"] == "Stance"
        assert payload["codes"][0]["code_set"]["exhaustive"] is True

        _project(db, 82, name="Receiving")
        counts = import_codebook_native(db, 82, payload)
        assert counts["code_sets_created"] == 1

        imported = db.query(CodeSet).filter(CodeSet.project_id == 82).one()
        assert imported.label == "Stance" and imported.exhaustive is True
        members = db.query(Code).filter(
            Code.project_id == 82, Code.code_set_id == imported.id,
        ).all()
        assert len(members) == 3

    def test_importing_the_same_codebook_twice_REUSES_the_set(self, db_session):
        """This import creates, it does not edit — the same rule the duplicate-code
        skip follows, and it matters more here because `exhaustive` changes what
        every blank in the RECEIVING project already means."""
        from app.services.codebook_exchange import (
            export_codebook_native, import_codebook_native,
        )

        db = db_session
        _stance_project(db, 83)
        payload = export_codebook_native(db, 83)
        _project(db, 84, name="Receiving")
        import_codebook_native(db, 84, payload)
        second = import_codebook_native(db, 84, payload)
        assert second["code_sets_created"] == 0
        assert db.query(CodeSet).filter(CodeSet.project_id == 84).count() == 1
