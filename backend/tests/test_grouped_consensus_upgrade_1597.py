"""#1597 — the update to 1.6.0 brings a saved consensus layer to the group rule.

1.6.0 decides a segment group's consensus once (#1334 unit 3); 1.5.8 decided each turn of a
group alone. The saved layer is recomputed only when a marker asks, and the update queued
none — so a 1.5.8 project kept its per-turn consensus on grouped turns while the
Reconciliation grid showed the new decision. Revision `d4e8a1c7b2f6` queues every turn of a
group two or more people coded; the sweep does the rest.

Every database here is built by the real chain to the revision BEFORE the fix
(`0a5c5d4ceb29`, whose schema is the models'), filled through the ORM in 1.5.8's shape, and
then upgraded by the real chain. The behavioural fixture puts the two coders' codings on
DIFFERENT turns of a group — the state the two rules disagree about: per turn there is one
voter (no consensus), per group there are two (consensus on every turn).
"""
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import get_or_create_consensus_user
from app.database import _script_only_alembic_config
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.speaker import Speaker
from app.models.user import User
from app.services.consensus_staleness import drain_stale_consensus

BEFORE = "0a5c5d4ceb29"   # 1.6.0's first migration; the fix's down_revision
FIX = "d4e8a1c7b2f6"

PID = 1597
OWNER, A, B = 1, 21, 22
X = 15970
G_SPLIT, G_ONE_CODER, G_STORED = 1, 2, 3
# t1/t2: group G_SPLIT, A coded X on t1 and B coded X on t2 — one voter per turn.
# t3/t4: group G_ONE_CODER, only A coded.
# t5:    ungrouped, A and B both coded X — the per-turn rule already decides it.
# t6/t7: group G_STORED, A and B both coded X on t6 (1.5.8 stored consensus X there),
#        nothing on t7 — the group rule writes X on t7 too.
T = {i: 15970 + i for i in range(1, 8)}
GROUP_OF = {1: G_SPLIT, 2: G_SPLIT, 3: G_ONE_CODER, 4: G_ONE_CODER, 6: G_STORED, 7: G_STORED}


def _upgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.upgrade(cfg, revision)


def _downgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.downgrade(cfg, revision)


def _session(db: Path):
    engine = create_engine(f"sqlite:///{db}")

    @event.listens_for(engine, "connect")
    def _fk(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    return sessionmaker(bind=engine, autoflush=False)(), engine


def _a_158_project(db: Path, *, coders=(A, B), stored_marker_on=None) -> Path:
    """A database at `BEFORE`, holding a project in 1.5.8's shape."""
    _upgrade(db, BEFORE)
    s, engine = _session(db)
    try:
        s.add(User(id=OWNER, username="Owner", password_hash=None, coder_type="human"))
        for uid in coders:
            s.add(User(id=uid, username=f"Coder {uid}", password_hash=None, coder_type="human"))
        s.flush()
        s.add(Project(id=PID, name="Groups", user_id=OWNER))
        s.flush()
        s.add(Conversation(id=PID, project_id=PID, name="Interview"))
        s.add(Code(id=X, project_id=PID, numeric_id=1, name="X"))
        s.flush()
        respondent = Speaker(project_id=PID, name="Respondent")
        s.add(respondent)
        s.add_all([SegmentGroup(id=g, conversation_id=PID) for g in (G_SPLIT, G_ONE_CODER, G_STORED)])
        s.flush()
        for i, sid in T.items():
            s.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=f"t{i}",
                          speaker_id=respondent.id, group_id=GROUP_OF.get(i)))
        s.flush()

        def code(uid, i):
            if uid in coders:
                s.add(CodeApplication(segment_id=T[i], code_id=X, user_id=uid, origin="human"))

        code(A, 1); code(B, 2)           # G_SPLIT: one voter per turn
        code(A, 3); code(A, 4)           # G_ONE_CODER
        code(A, 5); code(B, 5)           # ungrouped
        code(A, 6); code(B, 6)           # G_STORED: two voters on t6
        s.flush()
        if len(coders) >= 2:
            # 1.5.8's saved layer: per turn, two voters needed — only t5 and t6 had them.
            consensus = get_or_create_consensus_user(s)
            for i in (5, 6):
                s.add(CodeApplication(segment_id=T[i], code_id=X, user_id=consensus.id,
                                      origin="consensus"))
        if stored_marker_on is not None:
            s.add(ConsensusStaleTarget(project_id=PID, segment_id=T[stored_marker_on]))
        s.commit()
    finally:
        s.close()
        engine.dispose()
    return db


def _queued(db: Path) -> list[int]:
    s, engine = _session(db)
    try:
        return sorted(sid for (sid,) in s.query(ConsensusStaleTarget.segment_id))
    finally:
        s.close()
        engine.dispose()


def _consensus_turns(db: Path) -> list[int]:
    s, engine = _session(db)
    try:
        return sorted(
            sid for (sid,) in s.query(CodeApplication.segment_id)
            .filter(CodeApplication.origin == "consensus", CodeApplication.code_id == X)
        )
    finally:
        s.close()
        engine.dispose()


def _drain(db: Path) -> None:
    s, engine = _session(db)
    try:
        result = drain_stale_consensus(s, limit=500)
        assert result.failed_marker_ids == ()
    finally:
        s.close()
        engine.dispose()


def test_the_upgrade_queues_every_turn_of_a_group_two_people_coded(tmp_path):
    db = _a_158_project(tmp_path / "p.db")
    assert _queued(db) == []
    _upgrade(db, FIX)
    # G_SPLIT and G_STORED, every turn; not the one-coder group, not the ungrouped turn.
    assert _queued(db) == [T[1], T[2], T[6], T[7]]


def test_after_the_sweep_the_saved_layer_is_the_group_rule(tmp_path):
    db = _a_158_project(tmp_path / "p.db")
    # Discrimination: under 1.5.8's per-turn rule the saved layer had X on t5 and t6 only.
    assert _consensus_turns(db) == [T[5], T[6]]
    _upgrade(db, FIX)
    _drain(db)
    # The group rule: G_SPLIT's two coders agree on X across its turns, so X lands on both;
    # G_STORED's decision lands on t7 too; t5 is untouched; the one-coder group has none.
    assert _consensus_turns(db) == [T[1], T[2], T[5], T[6], T[7]]
    assert _queued(db) == []


def test_a_turn_already_queued_is_queued_once(tmp_path):
    db = _a_158_project(tmp_path / "p.db", stored_marker_on=1)
    _upgrade(db, FIX)   # the partial unique index would refuse a second marker on t1
    assert _queued(db) == [T[1], T[2], T[6], T[7]]


def test_a_single_coder_install_is_left_alone(tmp_path):
    db = _a_158_project(tmp_path / "p.db", coders=(A,))
    _upgrade(db, FIX)
    assert _queued(db) == []
    s, engine = _session(db)
    try:
        assert s.query(User).filter(User.coder_type == "consensus").count() == 0
    finally:
        s.close()
        engine.dispose()


def test_a_downgrade_queues_the_same_turns(tmp_path):
    db = _a_158_project(tmp_path / "p.db")
    _upgrade(db, FIX)
    _drain(db)
    assert _queued(db) == []
    _downgrade(db, BEFORE)
    assert _queued(db) == [T[1], T[2], T[6], T[7]]


def test_the_fix_is_in_the_chain_the_app_runs():
    """The revision this file tests follows `BEFORE` and is reached from the one head."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_script_only_alembic_config())
    assert len(script.get_heads()) == 1
    assert script.get_revision(FIX).down_revision == BEFORE
    assert FIX in {r.revision for r in script.walk_revisions()}
