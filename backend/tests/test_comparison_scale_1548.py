"""#1548 (a) + (b) — the code-by-group comparison at scale.

Measured on the D12 corpus (1.2M turns, 225,000 linked participants, 3.6M codings) at
`59a4fe25`: 31.8 s plaintext, 41.0 s ENCRYPTED, past the client's 30 s abort. Three
causes, each pinned here by what the code DOES, never by a clock:

- (b) both source scopes reach a segment through its parent but used the default
  visibility test, so SQLite started at `ix_segments_merged_into_id` — every visible
  segment on the INSTALL — and probed each for the parent (#1463 D62's trap, missed in
  a new call site). The work must not grow with ANOTHER project's turns.
- (a) the gather read one row per PASSAGE (600,300 turns, 900,000 answers, 1,800,900
  turn-codes) and folded them in Python. It now reads one row per person and source,
  and per person and code; the rows fetched must not grow with a person's turns.
- (a) the group map bound every linked row's id into one `IN (…)` — 225,001
  parameters on D12, 25,000 short of SQLite's ceiling (#960's class). It must work
  under a lowered limit, as `test_sql_variable_ceiling.py` proves its sites.

Every test is written as the WANTED behaviour, so each fails on `59a4fe25`; the
answers are literals, so a cheaper gather that counted differently fails too.
"""
import sqlite3

import pytest
from sqlalchemy import insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Query

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.services.code_analysis import get_demographic_comparison

PID, BIG = 1548, 15480
ROLE, TEXT = 15481, 15482
X, Y = 15490, 15491
CONV, DOC = 15481, 15481


def _project(db, people=4):
    """Two groups of two (Board, Staff); one conversation; codes X and Y; a second
    coder; one open-text column; a document linked to the first Board member."""
    db.add(Project(id=PID, name="P1548", user_id=1))
    db.add(User(id=2, username="second coder", password_hash=""))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="Roster"))
    db.flush()
    db.add_all([
        DatasetColumn(id=ROLE, dataset_id=PID, column_code="Role", column_name="Role",
                      column_text="Role", column_type=ColumnType.DEMOGRAPHIC,
                      sequence_order=0, display_order=0),
        DatasetColumn(id=TEXT, dataset_id=PID, column_code="Q", column_name="Q",
                      column_text="Q", column_type=ColumnType.OPEN_TEXT,
                      sequence_order=1, display_order=1),
        Conversation(id=CONV, project_id=PID, name="Focus group"),
        Code(id=X, project_id=PID, numeric_id=1, name="X", is_universal=False, is_active=True),
        Code(id=Y, project_id=PID, numeric_id=2, name="Y", is_universal=False, is_active=True),
    ])
    db.flush()
    for i in range(people):
        p = PID * 10 + i
        db.add(Participant(id=p, project_id=PID, identifier=f"P{i}"))
        db.flush()
        db.add(DatasetRow(id=p, dataset_id=PID, row_identifier=f"P{i}", participant_id=p))
        db.add(Speaker(id=p, project_id=PID, name=f"S{i}", is_facilitator=0, color_index=0,
                       participant_id=p))
        db.flush()
        db.add(DatasetValue(row_id=p, column_id=ROLE, value_text="Board" if i < 2 else "Staff"))
        db.add(DatasetValue(row_id=p, column_id=TEXT, value_text="an answer", word_count=2))
    db.add(Document(id=DOC, project_id=PID, name="Diary", source_filename="d.txt",
                    source_format="txt", participant_id=PID * 10))
    db.flush()
    db.add(Segment(id=PID * 1000, document_id=DOC, sequence_order=0, text="para", word_count=1))
    db.add(CodeApplication(segment_id=PID * 1000, code_id=Y, user_id=1))
    db.flush()


_next_turn = [PID * 2000]


def _turns(db, per_person, people=4):
    """Each person speaks ``per_person`` more turns, each coded X by BOTH coders (one
    passage, two applications) and every other one also coded Y by coder 1."""
    for i in range(people):
        p = PID * 10 + i
        for k in range(per_person):
            _next_turn[0] += 1
            s = _next_turn[0]
            db.add(Segment(id=s, conversation_id=CONV, sequence_order=s, text="t",
                           word_count=3, speaker_id=p))
            db.flush()
            db.add(CodeApplication(segment_id=s, code_id=X, user_id=1))
            db.add(CodeApplication(segment_id=s, code_id=X, user_id=2))
            if k % 2 == 0:
                db.add(CodeApplication(segment_id=s, code_id=Y, user_id=1))
            db.flush()


def _cmp(db, **kw):
    return get_demographic_comparison(db, PID, group_by_subtype="Role", **kw)


def _cells(r, name):
    e = next(e for e in r["codes"] if e["code_name"] == name)
    return {g: (c["count"], c["passages"]) for g, c in e["by_group"].items()}


# ── The answers, as literals ────────────────────────────────────────────────────

def test_a_passage_two_people_coded_is_one_passage(db_session):
    """Per person and code, the passages are DISTINCT — X is on every turn twice."""
    db = db_session
    _project(db)
    _turns(db, 6)
    r = _cmp(db)
    assert r["groups"] == ["Board", "Staff"]
    # Board: 2 people x 6 turns + Board's document paragraph + 2 answers.
    assert {g: (t["participants"], t["total_segments"], t["total_word_count"])
            for g, t in r["group_totals"].items()} == {"Board": (2, 15, 41), "Staff": (2, 14, 40)}
    assert _cells(r, "X") == {"Board": (2, 12), "Staff": (2, 12)}
    # Y on 3 of each person's 6 turns, plus the Board document's paragraph.
    assert _cells(r, "Y") == {"Board": (2, 7), "Staff": (2, 6)}
    assert r["scope"] == {"conversations": 1, "documents": 1, "text_columns": 1,
                          "observations_left_out": 0, "unassigned_passages": 0,
                          "participants_without_group": 0,
                          "no_coding_scope": "every"}  # #1626 (D244): no coder scope asked


def test_the_participant_filter_and_a_passage_with_no_person(db_session):
    """Folding per person keeps both rules the per-passage fold had: an unlinked
    speaker's turns are unassigned, and a participant filter makes that moot."""
    db = db_session
    _project(db)
    _turns(db, 2)
    db.add(Speaker(id=PID * 10 + 9, project_id=PID, name="Visitor", is_facilitator=0,
                   color_index=0, participant_id=None))
    db.flush()
    for k in range(3):
        db.add(Segment(id=PID * 3000 + k, conversation_id=CONV, sequence_order=PID * 3000 + k,
                       text="t", word_count=1, speaker_id=PID * 10 + 9))
    db.flush()
    r = _cmp(db)
    assert r["scope"]["unassigned_passages"] == 3
    # One Board member without the document, one Staff member.
    only = _cmp(db, participant_ids=[PID * 10 + 1, PID * 10 + 2])
    assert only["scope"]["unassigned_passages"] == 0
    assert {g: t["participants"] for g, t in only["group_totals"].items()} == {
        "Board": 1, "Staff": 1}
    assert _cells(only, "X") == {"Board": (1, 2), "Staff": (1, 2)}
    assert _cells(only, "Y") == {"Board": (1, 1), "Staff": (1, 1)}


# ── (a) the rows fetched follow the people, not their passages ──────────────────

def _rows_fetched(db, fn):
    """Every row the comparison's ORM reads hand back. A population check rides it:
    the comparison reads through `Query.all`, so a counter that saw no call is blind."""
    seen = {"calls": 0, "rows": 0}
    original = Query.all

    def counting(self):
        rows = original(self)
        seen["calls"] += 1
        seen["rows"] += len(rows)
        return rows

    Query.all = counting
    try:
        answer = fn()
    finally:
        Query.all = original
    assert seen["calls"] >= 6, seen   # group map, three unit arms, three code arms, codes
    return seen["rows"], answer


def test_the_rows_fetched_do_not_grow_with_a_persons_turns(db_session):
    db = db_session
    _project(db)
    _turns(db, 5)
    small, before = _rows_fetched(db, lambda: _cmp(db))
    _turns(db, 45)
    large, after = _rows_fetched(db, lambda: _cmp(db))
    assert _cells(before, "X") == {"Board": (2, 10), "Staff": (2, 10)}
    assert _cells(after, "X") == {"Board": (2, 100), "Staff": (2, 100)}
    # One row per person and source, and per person and code: the same people.
    assert large == small, (small, large)


# ── (b) the work does not grow with another project's turns ──────────────────────

def _install(db, first, n):
    if first == 0:
        db.add(Project(id=BIG, name="Another study", user_id=1))
        db.flush()
        db.add(Conversation(id=BIG, project_id=BIG, name="Long interview"))
        db.flush()
    db.execute(insert(Segment.__table__), [
        {"id": 5_000_000 + first + i, "conversation_id": BIG,
         "sequence_order": first + i, "text": "t"} for i in range(n)
    ])
    db.flush()


def _work(db, fn):
    conn = db.connection().connection.driver_connection
    ticks = [0]

    def tick():
        ticks[0] += 1
        return 0

    conn.set_progress_handler(tick, 100)
    try:
        answer = fn()
    finally:
        conn.set_progress_handler(None, 100)
    return ticks[0], answer


def test_the_work_does_not_grow_with_another_projects_turns(db_session):
    """As `test_summary_parent_counts.py` pins D62: SQLite's own work, so a machine's
    speed cannot pass or fail it. 2,000 → 20,000 turns elsewhere on the install."""
    db = db_session
    _project(db)
    _turns(db, 3)
    _install(db, 0, 2_000)
    small, before = _work(db, lambda: _cmp(db))
    _install(db, 2_000, 18_000)
    large, after = _work(db, lambda: _cmp(db))
    assert after == before
    assert large < 2 * max(small, 1), (small, large)


def test_the_two_scopes_take_the_parent_form(db_session):
    """The plan property lives in the clause's shape (D62): one `coalesce(…) IS NULL`
    in both scopes' SQL, never two bare `IS NULL` terms. Read from the statements the
    comparison sends, so a scope written either way is seen."""
    from sqlalchemy import event
    db = db_session
    _project(db)
    _turns(db, 1)
    sent = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        sent.append(" ".join(statement.split()))

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", capture)
    try:
        _cmp(db)
    finally:
        event.remove(bind, "before_cursor_execute", capture)
    segment_reads = [s for s in sent if "JOIN conversations" in s or "JOIN documents" in s]
    assert len(segment_reads) == 4, segment_reads   # units + codes, per parent kind
    for s in segment_reads:
        assert "coalesce(segments.merged_into_id, segments.split_into_id) IS NULL" in s, s
        assert "segments.split_into_id IS NULL" not in s, s


# ── (a) the group map under SQLite's parameter ceiling ──────────────────────────

LIMIT = 40


def test_the_group_map_survives_the_parameter_ceiling(db_session):
    """60 linked people under a 40-parameter limit — the shape D12 sat 25,000 short
    of (225,001 bound ids against 250,000), as `sql-id-sets.md` §5 lowers it."""
    db = db_session
    _project(db, people=60)
    _turns(db, 1, people=60)
    raw = db.connection().connection.dbapi_connection
    raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, LIMIT)
    try:
        r = _cmp(db)
        assert {g: t["participants"] for g, t in r["group_totals"].items()} == {
            "Board": 2, "Staff": 58}
    finally:
        raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 250_000)


def test_the_lowered_limit_really_refuses_a_bound_list(db_session):
    """Discrimination (#707a): under the same limit a plain `.in_()` over the
    fixture's linked rows RAISES — else a limit that failed to apply would leave the
    test above green."""
    db = db_session
    _project(db, people=60)
    ids = [r.id for r in db.query(DatasetRow.id).filter(DatasetRow.dataset_id == PID)]
    assert len(ids) == 60
    raw = db.connection().connection.dbapi_connection
    raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, LIMIT)
    try:
        with pytest.raises(OperationalError, match="too many SQL variables"):
            db.query(DatasetValue.id).filter(DatasetValue.row_id.in_(ids)).all()
    finally:
        raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 250_000)
