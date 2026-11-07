"""#1334 unit 3 session B (D35, D37) — the Reconciliation grid decides a segment GROUP once.

Session A (`2242e6e6`, `test_consensus_group_unit.py`) made the STORED consensus layer
decide a group once and write the decision on every visible member. The grid derives
consensus LIVE, and its promise is that the live column equals the stored layer —
so its unit moves to the group too (accepted 2026-11-01,
the internal design notes):

* D35 — a group is ONE row: ``unit_type: "group"``, its visible turns listed in
  transcript order, the first as the anchor the row's link and own-cell actions use;
* D37 — a coder who rated one code differently on two turns has NO rating on the
  group (D22), and the grid SAYS so as a fifth review fact.

Every behavioural fixture puts the coders' codings on DIFFERENT turns of the group —
the state a per-turn grid and a per-group grid disagree about. With the apply's
identical fan-out on every member, both readings agree and the fixture would certify
nothing (#707a).
"""
import json
import re
from pathlib import Path

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.speaker import Speaker
from app.models.user import User
from app.schemas.code_analysis import ReconciliationResponse
from app.services import reconciliation as recon
from app.services.code_sets import build_code_set_index
from app.services.coding_layers import build_effective_code_map
from app.services.consensus import decide_target, materialize_consensus_for_project
from app.services.reconciliation import build_reconciliation

PID = 1362
#: Two human coders beside the fixture's user 1 (who codes nothing).
A, B = 41, 42
X, Y, S = 13620, 13621, 13622       # plain, plain, scaled −1…+1 step 0.5 (ZERO interior)
#: The group's id is larger than every sequence_order, so a sort keyed on the
#: group id instead of its first turn puts the group LAST — the order would differ.
G = 13620
#: Turn ids run AGAINST transcript order inside the group (t1 has the largest id),
#: so an anchor taken as the lowest id instead of the first turn is a different turn.
T = {0: 136200, 1: 136239, 2: 136238, 3: 136237, 4: 136204}
GROUPED = (1, 2, 3)


def _world(db):
    db.add(Project(id=PID, name="Grid groups", user_id=1))
    db.add_all([
        User(id=A, username="Coder A", password_hash=None, coder_type="human"),
        User(id=B, username="Coder B", password_hash=None, coder_type="human"),
    ])
    db.flush()
    db.add(Conversation(id=PID, project_id=PID, name="Interview"))
    db.flush()
    interviewer = Speaker(project_id=PID, name="Interviewer", is_facilitator=1)
    respondent = Speaker(project_id=PID, name="Respondent")
    db.add_all([interviewer, respondent, SegmentGroup(id=G, conversation_id=PID)])
    db.flush()
    for i, sid in T.items():
        # t1 — the group's first turn — is the interviewer's: a group includes its
        # prompt (D16 / D31), and the grid lists facilitator turns.
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=f"t{i}",
                       speaker_id=(interviewer if i == 1 else respondent).id,
                       group_id=G if i in GROUPED else None))
    db.add_all([
        Code(id=X, project_id=PID, name="X", numeric_id=1, is_active=True, is_universal=False),
        Code(id=Y, project_id=PID, name="Y", numeric_id=2, is_active=True, is_universal=False),
        Code(id=S, project_id=PID, name="Strength", numeric_id=3, is_active=True,
             is_universal=False, magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5),
    ])
    db.flush()


def _apply(db, code_id, uid, i, magnitude=None, *, conflict=None):
    db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=T[i],
                           magnitude=magnitude, magnitude_conflict=conflict))
    db.flush()


def _grid(db, **kw):
    kw.setdefault("limit", 100)
    return build_reconciliation(db, PID, **kw)


def _group_row(grid):
    rows = [u for u in grid["units"] if u["unit_type"] == "group"]
    assert len(rows) == 1, [(u["unit_type"], u["unit_id"]) for u in grid["units"]]
    return rows[0]


def _turn_decisions(db, i):
    """What a PER-TURN decision says about one turn — the precondition each
    behavioural test shows, so its fixture could have told the two readings apart."""
    eff = build_effective_code_map(db, PID)
    per_coder: dict[int, set[int]] = {}
    for uid, code_id in db.query(CodeApplication.user_id, CodeApplication.code_id).filter(
        CodeApplication.segment_id == T[i], CodeApplication.origin != "consensus",
    ):
        per_coder.setdefault(uid, set()).add(eff.get(code_id, code_id))
    return [d.code_id for d in decide_target(per_coder, build_code_set_index(db, PID, eff))]


# ── D35 — one row per group ──────────────────────────────────────────────────


def test_a_group_is_one_row_in_transcript_order(db_session):
    db = db_session
    _world(db)
    _apply(db, X, A, 2)      # A coded X on t2 before the turns were grouped
    _apply(db, X, B, 3)      # B on t3
    _apply(db, Y, A, 0)
    _apply(db, Y, B, 0)
    _apply(db, Y, A, 4)
    assert _turn_decisions(db, 2) == [] and _turn_decisions(db, 3) == [], (
        "precondition: per turn, each member has one voter and decides nothing"
    )

    grid = _grid(db)
    assert [(u["unit_type"], u["unit_id"]) for u in grid["units"]] == [
        ("segment", T[0]), ("group", G), ("segment", T[4]),
    ], "the group sits where its FIRST turn sits, not where its id would sort"
    assert grid["total"] == 3
    g = _group_row(grid)
    assert g["member_segment_ids"] == [T[1], T[2], T[3]], "every visible turn, prompt included"
    assert g["anchor_segment_id"] == T[1], "the FIRST turn, not the lowest id"
    assert g["text"] == "t1\nt2\nt3"
    assert g["by_coder"] == {str(A): [X], str(B): [X]}, "a coder's codes = the union over turns"
    assert g["consensus"] == [X]
    assert g["consensus_context"][str(X)] == {"rule": "unanimous", "agree": 2, "voters": 2}
    assert g["has_disagreement"] is False

    t0 = grid["units"][0]
    assert t0["anchor_segment_id"] == T[0] and t0["member_segment_ids"] == []


def test_ungrouping_lists_every_turn_again(db_session):
    db = db_session
    _world(db)
    _apply(db, X, A, 2)
    _apply(db, X, B, 3)
    for i in GROUPED:
        db.get(Segment, T[i]).group_id = None
    db.flush()
    db.delete(db.get(SegmentGroup, G))
    db.flush()

    grid = _grid(db)
    # Every visible turn of a multi-coder source is a unit (Option B).
    assert [(u["unit_type"], u["unit_id"]) for u in grid["units"]] == [
        ("segment", T[i]) for i in range(5)
    ]
    assert all(u["consensus"] == [] for u in grid["units"]), "one voter per turn again"


def test_a_hidden_turn_is_neither_listed_nor_read(db_session):
    """A merge of grouped turns leaves the originals IN the group, hidden (fact 6).
    Their codings are UI-unreachable (#500): not listed, not a voter, and a
    rating or a merge flag on one does not put the group up for review."""
    db = db_session
    _world(db)
    hidden = 136250
    db.add(Segment(id=hidden, conversation_id=PID, sequence_order=5, text="gone",
                   group_id=G, merged_into_id=T[4]))
    db.flush()
    _apply(db, S, A, 2, magnitude=0.5)
    _apply(db, S, B, 3, magnitude=0.0)
    db.add(CodeApplication(code_id=S, user_id=B, segment_id=hidden, magnitude=1.0,
                           magnitude_conflict=-1.0))
    db.add(CodeApplication(code_id=Y, user_id=B, segment_id=hidden))
    db.flush()

    g = _group_row(_grid(db))
    assert hidden not in g["member_segment_ids"] and "gone" not in g["text"]
    assert g["by_coder"][str(B)] == [S], "the hidden turn's Y is no vote"
    assert g["has_group_rating_conflict"] is False, "0.0 and a HIDDEN 1.0 are not two ratings"
    assert g["has_merge_conflict"] is False, "a flag on a hidden turn reaches no one"
    assert g["ratings_by_coder"][str(B)] == {str(S): 0.0}


# ── The invariant session A left open: live = stored, on a group that DIVERGES ─


def _stored(db):
    """``{segment_id: sorted (code, rule, agree, voters, magnitude dict, median)}``
    for the STORED layer, in the grid's own vocabulary (the grid's context does
    not carry a code set's ``code_set`` key)."""
    out: dict[int, list] = {}
    for r in db.query(CodeApplication).filter(CodeApplication.origin == "consensus"):
        ctx = json.loads(r.origin_context)
        out.setdefault(r.segment_id, []).append((
            r.code_id, ctx["rule"], ctx["agree"], ctx["voters"],
            json.dumps(ctx.get("magnitude"), sort_keys=True), r.magnitude,
        ))
    return {sid: sorted(rows) for sid, rows in out.items()}


def _live(unit):
    rows = []
    for code_id in unit["consensus"]:
        ctx = unit["consensus_context"][str(code_id)]
        m = ctx.get("magnitude")
        rows.append((code_id, ctx["rule"], ctx["agree"], ctx["voters"],
                     json.dumps(m, sort_keys=True), m["median"] if m else None))
    return sorted(rows)


def test_the_grid_shows_what_was_stored_on_a_group_whose_turns_diverge(db_session):
    """`build_reconciliation`'s promise — its consensus column is the stored layer,
    derived live — on the state where a per-turn grid broke it: two coders whose
    codings sit on different turns, a coder whose two turns carry two ratings, and
    a minority code on one turn only. Ungrouped turns are held to it as well."""
    db = db_session
    _world(db)
    _apply(db, X, A, 1)                       # on the prompt
    _apply(db, X, B, 3)
    _apply(db, Y, A, 2)                       # a minority: 1 of 2, no consensus
    _apply(db, S, A, 2, magnitude=0.5)
    _apply(db, S, A, 3, magnitude=0.5)
    _apply(db, S, B, 2, magnitude=-0.5)       # B gave the group two ratings
    _apply(db, S, B, 3, magnitude=1.0)
    _apply(db, X, A, 0)
    _apply(db, X, B, 0)
    _apply(db, Y, A, 4, magnitude=None)
    _apply(db, X, B, 4)
    assert _turn_decisions(db, 1) == [], "precondition: per turn, the prompt decides nothing"

    materialize_consensus_for_project(db, PID)
    stored = _stored(db)
    grid = _grid(db)

    live_by_turn: dict[int, list] = {}
    for unit in grid["units"]:
        turns = unit["member_segment_ids"] or [unit["unit_id"]]
        for sid in turns:
            live_by_turn[sid] = _live(unit)
    for sid, rows in live_by_turn.items():
        assert stored.get(sid, []) == rows, f"turn {sid}: the grid and the stored layer disagree"
    assert set(stored) <= set(live_by_turn), "a stored row on a turn the grid does not list"

    g = _group_row(grid)
    assert g["consensus"] == [X, S]
    rating = g["consensus_context"][str(S)]["magnitude"]
    assert rating["n_rated"] == 1 and rating["median"] == 0.5, (
        "B's two ratings are no rating — the median is A's, and says it rests on one"
    )
    assert stored[T[1]] == stored[T[2]] == stored[T[3]], "one decision, on every turn"


# ── D37 — a coder's two ratings on one group are SAID ────────────────────────


def test_a_coders_two_ratings_on_a_group_are_a_review_fact_of_their_own(db_session):
    db = db_session
    _world(db)
    for i in GROUPED:
        _apply(db, S, A, i, magnitude=0.5)
    # A ZERO is a rating (§2). It is read FIRST whether the plan walks the turns by
    # id (t3's is the lower) or the codings by insertion — a fold that tested the
    # running rating by truthiness would drop it and miss the contradiction
    # (mutant B11 survived the first fixture, which put the zero second).
    _apply(db, S, B, 3, magnitude=0.0)
    _apply(db, S, B, 2, magnitude=1.0)

    grid = _grid(db, disagreements_only=True)
    g = _group_row(grid)
    assert g["has_group_rating_conflict"] is True
    assert g["group_rating_conflicts_by_coder"] == {str(B): {str(S): [0.0, 1.0]}}
    assert str(B) not in g["ratings_by_coder"], "no rating, never a number between the two"
    # It is the ONLY fact: the codes agree, A's lone rating differs from nobody's,
    # and nothing was merged — so without D37 the group would leave *Needs review*.
    assert g["has_disagreement"] is False
    assert g["has_rating_disagreement"] is False
    assert g["has_merge_conflict"] is False
    assert g["has_set_disagreement"] is False


def test_equal_or_partly_unrated_turns_are_one_rating(db_session):
    """CONTROL — `merge_unit_rating`'s other arms: an unrated turn adds nothing,
    and equal ratings (both ZERO, the falsy-zero fixture) are that rating."""
    db = db_session
    _world(db)
    _apply(db, S, A, 2, magnitude=0.0)
    _apply(db, S, A, 3, magnitude=None)
    _apply(db, S, B, 2, magnitude=0.0)
    _apply(db, S, B, 3, magnitude=0.0)

    g = _group_row(_grid(db))
    assert g["has_group_rating_conflict"] is False
    assert g["group_rating_conflicts_by_coder"] == {}
    assert g["ratings_by_coder"] == {str(A): {str(S): 0.0}, str(B): {str(S): 0.0}}


def test_only_a_voting_coders_split_ratings_are_said(db_session):
    """WHO counts is the gather's roster, applied through the engaged set: a
    MACHINE coder's two ratings on the group are not a coder's (#989), so they put
    nothing up for review — while a person's beside them still do (control)."""
    from app.auth import CODER_TYPE_MACHINE

    db = db_session
    _world(db)
    db.add(User(id=43, username="Model", password_hash=None, coder_type=CODER_TYPE_MACHINE))
    db.flush()
    _apply(db, S, A, 2, magnitude=0.5)
    _apply(db, S, 43, 2, magnitude=-1.0)
    _apply(db, S, 43, 3, magnitude=1.0)
    _apply(db, S, B, 2, magnitude=0.5)
    g = _group_row(_grid(db))
    assert g["group_rating_conflicts_by_coder"] == {} and g["has_group_rating_conflict"] is False

    _apply(db, S, B, 3, magnitude=-0.5)
    g = _group_row(_grid(db))
    assert g["group_rating_conflicts_by_coder"] == {str(B): {str(S): [-0.5, 0.5]}}


def test_an_ungrouped_turn_never_carries_the_group_fact(db_session):
    """One row per (turn, code, coder) — a turn cannot hold two ratings."""
    db = db_session
    _world(db)
    _apply(db, S, A, 0, magnitude=-1.0)
    _apply(db, S, B, 0, magnitude=1.0)

    t0 = next(u for u in _grid(db)["units"] if u["unit_id"] == T[0])
    assert t0["has_group_rating_conflict"] is False
    assert t0["group_rating_conflicts_by_coder"] == {}
    assert t0["has_rating_disagreement"] is True, "control: two coders' ratings are the OTHER fact"


def test_a_merge_flag_on_another_turn_flags_the_group(db_session):
    """`_merge_conflicts` is keyed by the grid's unit, so a flag on a turn other
    than the anchor reaches the group's row."""
    db = db_session
    _world(db)
    _apply(db, S, A, 2, magnitude=0.5)
    _apply(db, S, B, 3, magnitude=0.5, conflict=-0.5)

    g = _group_row(_grid(db, disagreements_only=True))
    assert g["has_merge_conflict"] is True
    assert g["rating_conflicts_by_coder"] == {str(B): {str(S): -0.5}}


# ── The wire ─────────────────────────────────────────────────────────────────


def test_the_group_fields_reach_the_wire(db_session):
    """Validated against the RESPONSE model — `extra='forbid'` under pytest, so an
    undeclared key fails here rather than being dropped in production (#855)."""
    db = db_session
    _world(db)
    _apply(db, S, A, 2, magnitude=0.0)
    _apply(db, S, B, 2, magnitude=-0.5)
    _apply(db, S, B, 3, magnitude=1.0)

    validated = ReconciliationResponse(**_grid(db))
    g = next(u for u in validated.units if u.unit_type == "group")
    assert g.unit_id == G and g.anchor_segment_id == T[1]
    assert g.member_segment_ids == [T[1], T[2], T[3]]
    assert g.has_group_rating_conflict is True
    assert g.group_rating_conflicts_by_coder == {str(B): {str(S): [-0.5, 1.0]}}


# ── The client's unit kinds are the server's ────────────────────────────────

REPO = Path(__file__).resolve().parents[2]
TS_API = REPO / "frontend" / "src" / "lib" / "api" / "code-analysis.ts"


def _ts_unit_kinds(source: str) -> set[str]:
    """The string literals of `unit_type` inside `interface ReconciliationUnit`."""
    block = re.search(r"export interface ReconciliationUnit \{(.*?)\n\}", source, re.S)
    assert block, "the interface moved or was renamed — this contract cannot see it"
    line = re.search(r"^\s*unit_type:\s*([^\n]+)$", block.group(1), re.M)
    assert line, "ReconciliationUnit has no unit_type line"
    return set(re.findall(r"'([^']+)'", line.group(1)))


def test_the_parser_reads_a_union():
    """Predicate falsifier: the parser returns exactly what a union says."""
    planted = "export interface ReconciliationUnit {\n  unit_type: 'a' | 'b'\n  unit_id: number\n}\n"
    assert _ts_unit_kinds(planted) == {"a", "b"}


def test_the_clients_unit_kinds_are_the_servers():
    """The backend field is a plain `str`, so a kind the client's union lacks
    arrives as a value TypeScript said could not exist, and fails SILENTLY in
    the browser (no 500, no compile error). Python reads the `.ts`."""
    assert TS_API.exists(), f"the client API module moved: {TS_API}"
    kinds = _ts_unit_kinds(TS_API.read_text(encoding="utf-8"))
    assert kinds, "population self-check: the union parsed to nothing"
    assert kinds == set(recon._UNIT_TYPE.values())
