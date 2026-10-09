"""#1074 — archiving or unarchiving a coder changes who VOTES, so it marks the
stored consensus layer stale wherever their vote counted.

DEC-F keeps an archived coder out of the consensus voters (`consensus.py`
filters `User.archived == False`), so an archive moves every consensus row the
coder took part in and an unarchive can create ones that were missing. None of
the four doors that do it marked anything: the stored layer read as current while
the live reconciliation said otherwise. The audit's instance, executed: Carol
archived, Carol and Alice both coded seg0 (so no consensus row, Carol not voting),
an import brings Carol back — and nothing marked seg0, while a rebuild wrote the
unanimous row the stored layer was missing.

One test per door, each WATCHING A PROJECT THE ACT DID NOT OTHERWISE TOUCH
(#1063's lesson: a door whose own writes mark its own project hides a missing
mark), and the service's scope pinned beside them.
"""
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.consensus import materialize_consensus_for_project
from app.services.consensus_staleness import (
    drain_stale_consensus,
    mark_consensus_stale_for_coder,
)

ALICE, CAROL, MODEL = 1, 2, 3


def _coders(db):
    """Alice is the fixture's user 1 (human). Carol votes; the model never does."""
    db.add(User(id=CAROL, username="Carol", password_hash=None, coder_type="human"))
    db.add(User(id=MODEL, username="GPT", password_hash=None, coder_type="ai"))
    db.flush()


def _project(db, pid, *, uuid_prefix=None):
    """A conversation of four segments, a code, and a universal code."""
    db.add(Project(id=pid, name=f"Project {pid}", user_id=1))
    db.add(Conversation(id=pid, project_id=pid, name="Interview"))
    db.flush()
    for i in range(4):
        db.add(Segment(
            id=pid * 10 + i, conversation_id=pid, sequence_order=i, text=f"turn {i}",
            uuid=f"{uuid_prefix or pid}-seg-{i}",
        ))
    db.add(Code(id=pid * 10 + 1, project_id=pid, numeric_id=1, name="Theme"))
    db.add(Code(id=pid * 10 + 2, project_id=pid, numeric_id=2, name="Unclear", is_universal=True))
    db.flush()
    return pid


def _apply(db, code_id, user_id, segment_id=None, value_id=None):
    db.add(CodeApplication(code_id=code_id, user_id=user_id,
                           segment_id=segment_id, dataset_value_id=value_id))
    db.flush()


def _marked(db, pid=None):
    q = db.query(ConsensusStaleTarget)
    if pid is not None:
        q = q.filter(ConsensusStaleTarget.project_id == pid)
    return sorted((m.segment_id, m.dataset_value_id) for m in q.all())


def _consensus_codes(db, segment_id):
    return {
        r.code_id for r in db.query(CodeApplication).filter(
            CodeApplication.origin == "consensus", CodeApplication.segment_id == segment_id,
        ).all()
    }


# ── The service: which passages one coder's vote can move ────────────────────


class TestWhichPassagesAreMarked:
    def test_only_the_passages_the_coder_SHARED_with_someone(self, db_session):
        """A passage only Carol touched holds no consensus row with or without
        her, so marking it queues a recompute that writes nothing — and a bulk
        import nobody else coded would queue every row of it."""
        db = db_session
        _coders(db)
        pid = _project(db, 700)
        theme, unclear = pid * 10 + 1, pid * 10 + 2
        _apply(db, theme, ALICE, pid * 10 + 0)
        _apply(db, theme, CAROL, pid * 10 + 0)   # shared → marked
        _apply(db, theme, CAROL, pid * 10 + 1)   # Carol alone → not marked
        _apply(db, theme, ALICE, pid * 10 + 2)   # Alice alone → not Carol's to mark
        _apply(db, theme, ALICE, pid * 10 + 3)
        _apply(db, unclear, CAROL, pid * 10 + 3)  # Carol's only row there is UNIVERSAL
        assert mark_consensus_stale_for_coder(db, CAROL) == 1
        assert _marked(db) == [(pid * 10 + 0, None)]

    def test_a_STALE_consensus_row_counts_as_someone_else(self, db_session):
        """A row a past archive left behind is exactly what may now be wrong, so
        a passage holding one is marked even when Carol is its only coder."""
        db = db_session
        _coders(db)
        pid = _project(db, 701)
        from app.auth import get_or_create_consensus_user
        consensus = get_or_create_consensus_user(db)
        _apply(db, pid * 10 + 1, CAROL, pid * 10 + 1)
        db.add(CodeApplication(code_id=pid * 10 + 1, user_id=consensus.id,
                               segment_id=pid * 10 + 1, origin="consensus"))
        db.flush()
        assert mark_consensus_stale_for_coder(db, CAROL) == 1
        assert _marked(db) == [(pid * 10 + 1, None)]

    def test_a_MACHINE_coder_marks_nothing(self, db_session):
        """A machine never votes (#989), so its archive moves no consensus."""
        db = db_session
        _coders(db)
        pid = _project(db, 702)
        _apply(db, pid * 10 + 1, ALICE, pid * 10)
        _apply(db, pid * 10 + 1, MODEL, pid * 10)
        assert mark_consensus_stale_for_coder(db, MODEL) == 0
        assert _marked(db) == []

    def test_a_DATASET_cell_is_marked_too(self, db_session):
        db = db_session
        _coders(db)
        pid = _project(db, 703)
        db.add(Dataset(id=pid, project_id=pid, name="Survey"))
        db.flush()
        db.add(DatasetColumn(id=pid, dataset_id=pid, column_name="Comment",
                             column_text="Comment", column_type="open_text", sequence_order=0))
        db.add(DatasetRow(id=pid, dataset_id=pid))
        db.flush()
        db.add(DatasetValue(id=pid, row_id=pid, column_id=pid, value_text="It was fine"))
        db.flush()
        _apply(db, pid * 10 + 1, ALICE, value_id=pid)
        _apply(db, pid * 10 + 1, CAROL, value_id=pid)
        assert mark_consensus_stale_for_coder(db, CAROL) == 1
        assert _marked(db) == [(None, pid)]

    def test_EVERY_project_and_ONE_marker_per_passage(self, db_session):
        """A coder spans projects (a `User` is install-wide), and three codes on
        one passage are still one marker — the partial unique index would raise."""
        db = db_session
        _coders(db)
        a, b = _project(db, 704), _project(db, 705)
        db.add(Code(id=a * 10 + 3, project_id=a, numeric_id=3, name="Second"))
        db.flush()
        for pid in (a, b):
            _apply(db, pid * 10 + 1, ALICE, pid * 10)
            _apply(db, pid * 10 + 1, CAROL, pid * 10)
        _apply(db, a * 10 + 3, CAROL, a * 10)
        assert mark_consensus_stale_for_coder(db, CAROL) == 2
        assert _marked(db, a) == [(a * 10, None)] and _marked(db, b) == [(b * 10, None)]
        assert mark_consensus_stale_for_coder(db, CAROL) == 0, "idempotent"

    def test_a_project_the_caller_REBUILDS_can_be_left_out(self, db_session):
        db = db_session
        _coders(db)
        a, b = _project(db, 706), _project(db, 707)
        for pid in (a, b):
            _apply(db, pid * 10 + 1, ALICE, pid * 10)
            _apply(db, pid * 10 + 1, CAROL, pid * 10)
        mark_consensus_stale_for_coder(db, CAROL, except_project_id=a)
        assert _marked(db, a) == [] and _marked(db, b) == [(b * 10, None)]


# ── The four doors ────────────────────────────────────────────────────────────


def _shared_passage(db, pid):
    """Alice and Carol both applied Theme on seg0 — a unanimous consensus while
    both vote."""
    _project(db, pid)
    _apply(db, pid * 10 + 1, ALICE, pid * 10)
    _apply(db, pid * 10 + 1, CAROL, pid * 10)
    return pid * 10


class TestTheArchiveEndpoints:
    def test_ARCHIVING_a_coder_marks_and_the_sweep_removes_their_consensus(self, db_session):
        """End to end: Carol archived leaves one voter, so the unanimous row must
        go. ⚠️ Archiving her also turns `consensus_enabled` off (one person left),
        which is WHY the marking is ungated — the recompute is what clears it."""
        from app.routers.auth import archive_coder

        db = db_session
        _coders(db)
        seg = _shared_passage(db, 710)
        materialize_consensus_for_project(db, 710)
        db.commit()
        assert _consensus_codes(db, seg) == {7101}

        archive_coder(coder_id=CAROL, user=db.get(User, ALICE), db=db)   # `def`: no asyncio.run
        assert _marked(db, 710) == [(seg, None)]
        drain_stale_consensus(db, limit=500)
        assert _consensus_codes(db, seg) == set(), "Carol no longer votes: one voter, no row"

    def test_UNARCHIVING_a_coder_marks_and_the_sweep_writes_the_missing_row(self, db_session):
        from app.routers.auth import unarchive_coder

        db = db_session
        _coders(db)
        db.get(User, CAROL).archived = True
        seg = _shared_passage(db, 711)
        materialize_consensus_for_project(db, 711)
        db.commit()
        assert _consensus_codes(db, seg) == set(), "archived Carol does not vote"

        unarchive_coder(coder_id=CAROL, user=db.get(User, ALICE), db=db)
        assert _marked(db, 711) == [(seg, None)]
        drain_stale_consensus(db, limit=500)
        assert _consensus_codes(db, seg) == {7111}


class TestTheCodingImportsUnarchive:
    def test_it_marks_a_project_the_import_never_touched(self, db_session):
        """The audit's own instance. `_mark_staleness` marks the targets the FILE
        wrote; Carol's earlier coding in another project votes again too."""
        from app.services import coding_import as ci

        db = db_session
        _coders(db)
        db.get(User, CAROL).archived = True
        seg_elsewhere = _shared_passage(db, 712)
        into = _project(db, 713)
        rows = ci.parse_rows(f"unit_id,coder,code\n{into}-seg-0,Carol,Theme\n")
        plan = ci.build_plan(db, into, rows, target_kind=ci.TARGET_SEGMENTS)
        ci.apply_plan(db, into, plan, {"Carol": ci.CoderDecision("match", CAROL, unarchive=True)})
        assert db.get(User, CAROL).archived is False
        assert _marked(db, 712) == [(seg_elsewhere, None)]


class TestTheMergesUnarchive:
    def test_it_marks_OTHER_projects_and_rebuilds_its_own(self, db_session, tmp_path):
        """The merge rebuilds its TARGET's layer in a post-pass and nothing else.
        Its own project is left out of the marking: a marker there would make the
        fresh rebuild read as stale until the sweep reached it."""
        from app.services.project_portability import import_project
        from tests.test_trackj_j3_roundtrip import _two_coder_file

        db = db_session
        # Dana (3 in the merge test's numbering) is archived and coded elsewhere.
        db.add(User(id=4, username="Dana", password_hash=None, coder_type="human", archived=True))
        db.flush()
        _project(db, 714)
        _apply(db, 7141, ALICE, 7140)
        _apply(db, 7141, 4, 7140)
        db.commit()

        p, _conv, seg, code, f = _two_coder_file(db, tmp_path)
        # ⚠️ Dana ALSO coded this project before she was archived: without that,
        # the merge's own project holds nothing of hers to mark, and leaving it
        # out of the marking could not be told from marking it (a surviving mutant).
        _apply(db, code.id, 4, seg.id)
        db.commit()
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id,
            coder_mapping={"2": {"action": "match", "target_user_id": 4, "unarchive": True}},
        )
        db.flush()
        assert db.get(User, 4).archived is False
        assert _marked(db, 714) == [(7140, None)]
        assert _marked(db, p.id) == [], "the target project is rebuilt, not marked"
        assert _consensus_codes(db, seg.id) == {code.id}, "…and its rebuild counts Dana"


# ── The population: every door that flips a coder's archived flag ─────────────

import ast  # noqa: E402

from tests.guard_support import app_files  # noqa: E402

MARKER = "mark_consensus_stale_for_coder"


def _doors(source: str, name: str) -> list[tuple[str, int, bool]]:
    """``(function, line, marks)`` for each function assigning ``<x>.archived``."""
    out = []
    for fn in ast.walk(ast.parse(source, filename=name)):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        assigns = [
            node.lineno for node in ast.walk(fn)
            if isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Attribute) and t.attr == "archived" for t in node.targets)
        ]
        if not assigns:
            continue
        marks = any(
            isinstance(node, ast.Call)
            and getattr(node.func, "id", getattr(node.func, "attr", None)) == MARKER
            for node in ast.walk(fn)
        )
        out.append((fn.name, assigns[0], marks))
    return out


def test_EVERY_door_that_archives_or_unarchives_a_coder_marks_consensus():
    """#1063 enumerated these doors for the participant-score mark and did not
    ask about consensus; #1074 found the gap the same way. So the doors are found
    by what they DO — assign an ``archived`` flag — and a fifth one fails here
    until it marks (or is listed with a reason why it changes no vote)."""
    doors = []
    for path in app_files(floor=150):
        for fn, line, marks in _doors(path.read_text(encoding="utf-8"), str(path)):
            doors.append((path.name, fn, line, marks))
    # Population: the four known doors (a walk that found none passes vacuously).
    assert {(f, fn) for f, fn, _l, _m in doors} >= {
        ("auth.py", "archive_coder"), ("auth.py", "unarchive_coder"),
        ("coding_import.py", "resolve_coders"), ("project_portability.py", "import_project"),
    }, doors
    unmarked = [(f, fn, line) for f, fn, line, marks in doors if not marks]
    assert unmarked == [], (
        f"these functions change who votes (an `archived` flag) without "
        f"{MARKER}: {unmarked} — DEC-F keeps archived coders out of consensus, so "
        "the stored layer goes stale wherever their vote counted (#1074)"
    )


def test_the_door_scan_FIRES_on_an_unmarked_door():
    """Predicate falsifier: the scan must flag a door that does not mark."""
    snippet = "def sneak(db, c):\n    c.archived = True\n    db.commit()\n"
    assert _doors(snippet, "x.py") == [("sneak", 2, False)]
    marked = "def ok(db, c):\n    c.archived = False\n    mark_consensus_stale_for_coder(db, c.id)\n"
    assert _doors(marked, "x.py") == [("ok", 2, True)]
