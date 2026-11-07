"""#1334 unit 3 (D30–D34, D36) — the CONSENSUS layer decides a segment group ONCE.

Units 1–2 made a group one unit in reliability, the Model comparison, the R
export and participant scores; the stored consensus layer still decided per
TURN. Accepted 2026-11-01 (the internal design notes):

* D30 — one decision per group, written as identical rows on EVERY visible member;
* D31 — the fold: every visible member (facilitator turns included), a coder's
  codes = the union, two different ratings from one coder = no rating;
* D32 — the writer's gather streams grouped turns as ONE ballot per group, with no
  per-turn ≥2-voter filter (two coders on two turns are one voter per turn);
* D33 — the sweep recomputes a grouped turn's whole group, once per batch;
* D34 — grouping, ungrouping and an archive mark consensus stale for the group;
* D36 — remove and rate on a grouped turn find the coder's row on ANY member.

Every behavioural fixture puts the coders' codings on DIFFERENT members of a group
— the state a per-turn rule and a per-group rule disagree about (a coding made
before grouping, `bulk_code`, a merged copy); with the fan-out's identical
members, both rules agree and the fixture would certify nothing.
"""
import asyncio
import json

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_set import CodeSet
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.speaker import Speaker
from app.models.user import User
from app.services import consensus_staleness as staleness
from app.services.code_sets import build_code_set_index
from app.services.coding_layers import build_effective_code_map
from app.services.consensus import (
    MIN_CONSENSUS_VOTERS,
    SEGMENT_SCOPE_CONSENSUS_ELIGIBLE,
    SEGMENT_SCOPE_PROJECT,
    TARGET_GROUP,
    TARGET_SEGMENT,
    decide_target,
    gather_target_votes,
    materialize_consensus_for_project,
    recompute_consensus_for_target,
)

PID = 1361
#: Two human coders beside the fixture's user 1. B is the HIGHER id on purpose:
#: an unscoped `.first()` returns the LOWEST user's row (magnitude-coding.md §4),
#: so a door that lost its coder filter would still pass with the lower id calling.
A, B = 31, 32
X, Y, S = 13610, 13611, 13612          # plain, plain, scaled 1–5 step 1
POS, NEG = 13613, 13614                # one inclusive code set's two values
G = 1361                               # the group: t0 (prompt), t1, t2, t3
T = {i: 136100 + i for i in range(6)}  # t4, t5 ungrouped


def _world(db):
    db.add(Project(id=PID, name="Groups", user_id=1))
    db.add_all([
        User(id=A, username="Coder A", password_hash=None, coder_type="human"),
        User(id=B, username="Coder B", password_hash=None, coder_type="human"),
    ])
    db.flush()
    db.add(Conversation(id=PID, project_id=PID, name="Interview"))
    db.flush()
    interviewer = Speaker(project_id=PID, name="Interviewer", is_facilitator=1)
    respondent = Speaker(project_id=PID, name="Respondent")
    db.add_all([interviewer, respondent, SegmentGroup(id=G, conversation_id=PID),
                CodeSet(id=PID, project_id=PID, label="Stance", exhaustive=False)])
    db.flush()
    for i, sid in T.items():
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=f"t{i}",
                       speaker_id=(interviewer if i == 0 else respondent).id,
                       group_id=G if i <= 3 else None))
    db.add_all([
        Code(id=X, project_id=PID, name="X", numeric_id=1, is_active=True, is_universal=False),
        Code(id=Y, project_id=PID, name="Y", numeric_id=2, is_active=True, is_universal=False),
        Code(id=S, project_id=PID, name="Strength", numeric_id=3, is_active=True,
             is_universal=False, magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0),
        Code(id=POS, project_id=PID, name="Positive", numeric_id=4, is_active=True,
             is_universal=False, code_set_id=PID),
        Code(id=NEG, project_id=PID, name="Negative", numeric_id=5, is_active=True,
             is_universal=False, code_set_id=PID),
    ])
    db.flush()


def _apply(db, code_id, uid, i, magnitude=None):
    db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=T[i], magnitude=magnitude))
    db.flush()


def _layer(db):
    """The stored consensus layer as comparable tuples."""
    return sorted(
        (r.segment_id, r.code_id,
         json.dumps(json.loads(r.origin_context), sort_keys=True), r.magnitude)
        for r in db.query(CodeApplication).filter(CodeApplication.origin == "consensus")
    )


def _rows_on(db, i):
    return sorted(
        r.code_id for r in db.query(CodeApplication).filter(
            CodeApplication.origin == "consensus", CodeApplication.segment_id == T[i],
        )
    )


def _turn_decisions(db, i):
    """What the OLD per-turn rule decided for one turn — the precondition every
    behavioural test shows, so its fixture could have disagreed (#707a)."""
    eff = build_effective_code_map(db, PID)
    per_coder: dict[int, set[int]] = {}
    for uid, code_id in db.query(CodeApplication.user_id, CodeApplication.code_id).filter(
        CodeApplication.segment_id == T[i], CodeApplication.origin != "consensus",
    ):
        per_coder.setdefault(uid, set()).add(eff.get(code_id, code_id))
    return [d.code_id for d in decide_target(per_coder, build_code_set_index(db, PID, eff))]


# ── D30 + D31 — one decision, written on every visible member ────────────────


def test_coders_on_different_turns_of_a_group_reach_consensus(db_session):
    db = db_session
    _world(db)
    _apply(db, X, A, 1)      # A coded X on t1 before the turns were grouped
    _apply(db, X, B, 2)      # B on t2
    assert _turn_decisions(db, 1) == [] and _turn_decisions(db, 2) == [], (
        "precondition: per turn, each has one voter and decides nothing"
    )
    materialize_consensus_for_project(db, PID)
    for i in (0, 1, 2, 3):
        assert _rows_on(db, i) == [X], f"t{i}: the group's decision lands on every member"
    assert _rows_on(db, 4) == [] and _rows_on(db, 5) == []
    ctx = json.loads(db.query(CodeApplication).filter(
        CodeApplication.origin == "consensus", CodeApplication.segment_id == T[3],
    ).first().origin_context)
    assert ctx == {"rule": "unanimous", "agree": 2, "voters": 2}


def test_a_facilitator_member_is_part_of_the_group(db_session):
    """D31 / D16 — the consensus layer covers prompts, so a coder whose coding of
    the group sits on its interviewer turn has coded the group."""
    db = db_session
    _world(db)
    _apply(db, Y, A, 0)      # on the prompt
    _apply(db, Y, B, 3)
    materialize_consensus_for_project(db, PID)
    assert _rows_on(db, 1) == [Y]


def test_a_coders_two_ratings_on_a_group_are_no_rating(db_session):
    """D22 in the layer: B rated the group 2 on one turn and 5 on another, so B
    gives the unit no rating; the consensus median rests on A's alone, and says so."""
    db = db_session
    _world(db)
    for i in (1, 2, 3):
        _apply(db, S, A, i, magnitude=4.0)
    _apply(db, S, B, 1, magnitude=2.0)
    _apply(db, S, B, 2, magnitude=5.0)
    materialize_consensus_for_project(db, PID)
    row = db.query(CodeApplication).filter(
        CodeApplication.origin == "consensus", CodeApplication.segment_id == T[2],
    ).one()
    rating = json.loads(row.origin_context)["magnitude"]
    assert rating["n_rated"] == 1 and rating["median"] == 4.0, rating
    assert row.magnitude == 4.0
    # The fixture could have disagreed: B's ratings, had they counted, move it.
    assert json.loads(row.origin_context)["voters"] == 2


def test_a_coder_holding_two_set_values_across_a_group_does_not_vote_on_the_set(db_session):
    """D31 — the union across members gives A both values of one set
    (`SET_MULTIPLE`, no vote); B's Positive is then a lone vote and decides
    nothing. Per turn, t1 would have been unanimous Positive."""
    db = db_session
    _world(db)
    _apply(db, POS, A, 1)
    _apply(db, NEG, A, 2)
    _apply(db, POS, B, 1)
    assert _turn_decisions(db, 1) == [POS], "precondition: per turn, t1 was unanimous"
    materialize_consensus_for_project(db, PID)
    assert _rows_on(db, 1) == []


def test_an_ungrouped_turn_is_unchanged(db_session):
    """CONTROL — no group, the row the turn always had."""
    db = db_session
    _world(db)
    _apply(db, X, A, 4)
    _apply(db, X, B, 4)
    _apply(db, Y, A, 5)
    materialize_consensus_for_project(db, PID)
    assert _rows_on(db, 4) == [X] and _rows_on(db, 5) == []
    assert all(_rows_on(db, i) == [] for i in (0, 1, 2, 3))


# ── D33 — the sweep's recompute is the rebuild's, for a whole group ──────────


def _mixed(db):
    """Every arm at once: a cross-turn group decision, a rating contradiction, a
    set contradiction, an ungrouped turn that decides and one that does not."""
    _apply(db, X, A, 1); _apply(db, X, B, 2)
    for i in (1, 2, 3):
        _apply(db, S, A, i, magnitude=3.0)
    _apply(db, S, B, 1, magnitude=1.0); _apply(db, S, B, 2, magnitude=5.0)
    _apply(db, POS, A, 1); _apply(db, NEG, A, 3); _apply(db, POS, B, 2)
    _apply(db, Y, A, 4); _apply(db, Y, B, 4)
    _apply(db, X, A, 5)


def test_the_sweeps_recompute_of_one_member_equals_the_rebuild(db_session):
    """An INDEPENDENT path to the same layer: the rebuild streams the group as one
    ballot; the recompute reads it from one member's marker. Any member will do."""
    db = db_session
    _world(db)
    _mixed(db)
    materialize_consensus_for_project(db, PID)
    rebuilt = _layer(db)
    assert len(rebuilt) == 4 * 2 + 1, "X and S on four members, Y on t4 — not vacuous"
    for via in (0, 3):
        db.query(CodeApplication).filter(CodeApplication.origin == "consensus").delete()
        db.flush()
        recompute_consensus_for_target(db, PID, segment_id=T[via])
        recompute_consensus_for_target(db, PID, segment_id=T[4])
        recompute_consensus_for_target(db, PID, segment_id=T[5])
        assert _layer(db) == rebuilt, f"via t{via}"


def test_a_hidden_member_loses_the_rows_the_group_wrote(db_session):
    """A merge of grouped turns leaves its originals in the group, hidden; the
    recompute deletes over EVERY member (the cleaner's superset) and writes on the
    visible ones."""
    db = db_session
    _world(db)
    _apply(db, X, A, 1); _apply(db, X, B, 2)
    materialize_consensus_for_project(db, PID)
    assert _rows_on(db, 3) == [X]
    db.get(Segment, T[3]).merged_into_id = T[5]
    db.flush()
    assert recompute_consensus_for_target(db, PID, segment_id=T[1]) == 3, "t0, t1, t2"
    assert _rows_on(db, 3) == []
    assert [_rows_on(db, i) for i in (0, 1, 2)] == [[X], [X], [X]]
    # The rebuild writes on VISIBLE members only, too.
    materialize_consensus_for_project(db, PID)
    assert _rows_on(db, 3) == [] and _rows_on(db, 2) == [X]


def test_the_sweep_recomputes_a_group_once_per_batch(db_session, monkeypatch):
    db = db_session
    _world(db)
    _apply(db, X, A, 1); _apply(db, X, B, 2)
    _apply(db, Y, A, 4); _apply(db, Y, B, 4)
    staleness.mark_consensus_stale(db, PID, segment_ids=[T[i] for i in (0, 1, 2, 3, 4)])
    calls: list[int] = []
    real = staleness.recompute_consensus_for_target

    def spy(db_, project_id, *, segment_id=None, dataset_value_id=None):
        calls.append(segment_id)
        return real(db_, project_id, segment_id=segment_id, dataset_value_id=dataset_value_id)

    monkeypatch.setattr(staleness, "recompute_consensus_for_target", spy)
    assert staleness.sweep_stale_consensus(db, project_id=PID) == 5, "every marker drained"
    assert len(calls) == 2, f"one group + one ungrouped turn, not five: {calls}"
    assert db.query(ConsensusStaleTarget).count() == 0
    assert all(_rows_on(db, i) == [X] for i in (0, 1, 2, 3)) and _rows_on(db, 4) == [Y]


# ── D32 — the gather: one ballot per group, voters counted on the fold ───────


def _keys(db, *, group_units, min_voters, scope=SEGMENT_SCOPE_CONSENSUS_ELIGIBLE):
    votes = gather_target_votes(db, PID, segment_scope=scope, min_voters=min_voters,
                                group_units=group_units)
    return [(b.kind, b.target_id) for b in votes.ballots()]


def test_the_writer_gets_one_ballot_per_group_and_the_rollup_every_turn(db_session):
    db = db_session
    _world(db)
    _apply(db, X, A, 1); _apply(db, X, B, 2); _apply(db, X, A, 4)
    assert _keys(db, group_units=True, min_voters=1) == [(TARGET_SEGMENT, T[4]), (TARGET_GROUP, G)]
    assert _keys(db, group_units=False, min_voters=1, scope=SEGMENT_SCOPE_PROJECT) == [
        (TARGET_SEGMENT, T[1]), (TARGET_SEGMENT, T[2]), (TARGET_SEGMENT, T[4]),
    ]


def test_the_group_arm_counts_voters_on_the_folded_ballot(db_session):
    """The per-turn ≥2-voter filter would drop both of a group's one-voter turns;
    the group arm counts on the fold — and still drops a group with one voter."""
    db = db_session
    _world(db)
    _apply(db, X, A, 1); _apply(db, X, B, 2)          # two voters, one per turn
    assert _keys(db, group_units=True, min_voters=MIN_CONSENSUS_VOTERS) == [(TARGET_GROUP, G)]
    db.query(CodeApplication).filter(CodeApplication.user_id == B).delete()
    _apply(db, X, A, 3)                                # one voter on two turns
    db.flush()
    assert _keys(db, group_units=True, min_voters=MIN_CONSENSUS_VOTERS) == []
    assert _keys(db, group_units=True, min_voters=1) == [(TARGET_GROUP, G)]


def test_a_group_ballot_has_no_single_target(db_session):
    """`target()` names one column; a group has none. A consumer that forgot
    groups exist must fail loudly, not write to a group id as a segment id."""
    db = db_session
    _world(db)
    _apply(db, X, A, 1); _apply(db, X, B, 2)
    votes = gather_target_votes(db, PID, segment_scope=SEGMENT_SCOPE_CONSENSUS_ELIGIBLE,
                                min_voters=1, group_units=True)
    (ballot,) = list(votes.ballots())
    assert ballot.per_coder == {A: {X}, B: {X}}
    with pytest.raises(KeyError):
        ballot.target()


def test_group_units_has_no_default_and_refuses_nonsense(db_session):
    import inspect

    param = inspect.signature(gather_target_votes).parameters["group_units"]
    assert param.default is inspect.Parameter.empty
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    for bad in (None, 1, 0, "yes"):
        with pytest.raises(ValueError, match="group_units"):
            gather_target_votes(db_session, 1, segment_scope="project", min_voters=1,
                                group_units=bad)


# ── D34 — the doors that change a group's consensus ──────────────────────────


def _markers(db):
    return sorted(m.segment_id for m in db.query(ConsensusStaleTarget).all())


def _user(db, uid=1):
    return db.get(User, uid)


def test_grouping_marks_the_new_members_and_the_turns_left_behind(db_session):
    from app.routers.segments import create_segment_group
    from app.schemas.segment import SegmentGroupRequest

    db = db_session
    _world(db)
    asyncio.run(create_segment_group(
        PID, SegmentGroupRequest(segment_ids=[T[3], T[4]]), user=_user(db), db=db,
    ))
    assert _markers(db) == [T[0], T[1], T[2], T[3], T[4]], (
        "t3 + t4 joined the new group; t0–t2 lost t3 from theirs"
    )


def test_ungrouping_marks_every_former_member(db_session):
    from app.routers.segments import ungroup_segments

    db = db_session
    _world(db)
    db.get(Segment, T[3]).merged_into_id = T[5]      # a hidden member too
    db.flush()
    asyncio.run(ungroup_segments(PID, G, user=_user(db), db=db))
    assert _markers(db) == [T[0], T[1], T[2], T[3]]


def test_a_single_coder_install_marks_no_consensus(db_session):
    """The gate is right for consensus (one voter decides nothing) — the score
    marker beside it is the ungated one (`test_reliability_units.py`)."""
    from app.routers.segments import create_segment_group, ungroup_segments
    from app.schemas.segment import SegmentGroupRequest

    db = db_session
    _world(db)
    for uid in (A, B):
        db.get(User, uid).archived = True
    db.flush()
    asyncio.run(create_segment_group(
        PID, SegmentGroupRequest(segment_ids=[T[4], T[5]]), user=_user(db), db=db,
    ))
    asyncio.run(ungroup_segments(PID, G, user=_user(db), db=db))
    assert _markers(db) == []


def test_grouping_then_ungrouping_moves_the_layer_end_to_end(db_session):
    """Through the doors and the sweep: grouping t4 + t5 joins two one-voter turns
    into a decision; ungrouping them takes it away again."""
    from app.routers.segments import create_segment_group, ungroup_segments
    from app.schemas.segment import SegmentGroupRequest

    db = db_session
    _world(db)
    _apply(db, Y, A, 4); _apply(db, Y, B, 5)
    materialize_consensus_for_project(db, PID)
    assert _rows_on(db, 4) == [] and _rows_on(db, 5) == []
    made = asyncio.run(create_segment_group(
        PID, SegmentGroupRequest(segment_ids=[T[4], T[5]]), user=_user(db), db=db,
    ))
    staleness.sweep_stale_consensus(db, project_id=PID)
    assert _rows_on(db, 4) == [Y] and _rows_on(db, 5) == [Y]
    asyncio.run(ungroup_segments(PID, made.id, user=_user(db), db=db))
    staleness.sweep_stale_consensus(db, project_id=PID)
    assert _rows_on(db, 4) == [] and _rows_on(db, 5) == []


def test_archiving_a_coder_marks_a_group_they_share_on_another_turn(db_session):
    db = db_session
    _world(db)
    _apply(db, X, A, 1); _apply(db, X, B, 2)      # a group decision, two turns
    # CONTROL: a second group A coded ALONE on both turns — A's own other turn is
    # not "someone else", so nothing there can hold a consensus row.
    db.add(SegmentGroup(id=G + 1, conversation_id=PID))
    db.flush()
    for i in (4, 5):
        db.get(Segment, T[i]).group_id = G + 1
        _apply(db, X, A, i)
    db.flush()
    assert staleness.mark_consensus_stale_for_coder(db, A) == 1
    assert _markers(db) == [T[1]], "A's shared group turn, never the group A coded alone"


# ── D36 — remove and rate a group's code through any member ──────────────────


def test_removing_a_group_code_held_on_another_member(db_session):
    from app.routers.coding import remove_code

    db = db_session
    _world(db)
    _apply(db, X, B, 2)                  # B's X sits on t2 only
    _apply(db, X, A, 1)                  # a colleague's X on the addressed turn
    out = asyncio.run(remove_code(T[1], X, user=_user(db, B), db=db))
    assert out.applied is False
    remaining = {(r.user_id, r.segment_id) for r in db.query(CodeApplication)}
    assert remaining == {(A, T[1])}, "B's row went; A's stayed"


def test_removing_an_ungrouped_code_not_applied_removes_nothing(db_session):
    """CONTROL — outside a group the door asks the addressed turn, as before."""
    from app.routers.coding import remove_code

    db = db_session
    _world(db)
    _apply(db, X, B, 5)
    asyncio.run(remove_code(T[4], X, user=_user(db, B), db=db))
    assert db.query(CodeApplication).count() == 1


def test_rating_a_group_code_held_on_another_member(db_session):
    from fastapi import HTTPException

    from app.routers.coding import set_code_magnitude
    from app.schemas.coding import MagnitudeValueUpdate

    db = db_session
    _world(db)
    _apply(db, S, B, 2)
    _apply(db, S, B, 3, magnitude=1.0)
    _apply(db, S, A, 1, magnitude=5.0)
    set_code_magnitude(T[1], S, MagnitudeValueUpdate(magnitude=4.0), user=_user(db, B), db=db)
    ratings = {(r.user_id, r.segment_id): r.magnitude for r in db.query(CodeApplication)}
    assert ratings == {(B, T[2]): 4.0, (B, T[3]): 4.0, (A, T[1]): 5.0}
    # CONTROL — an ungrouped turn the coder never coded is still a 404.
    with pytest.raises(HTTPException) as refused:
        set_code_magnitude(T[4], S, MagnitudeValueUpdate(magnitude=4.0), user=_user(db, B), db=db)
    assert refused.value.status_code == 404
