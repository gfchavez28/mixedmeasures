"""#1539 — the Quote Board answers however many quotes the selection holds.

`list_quoted_excerpts` fetched each quote's preceding turn with ONE `or_` of
`(parent_id == p AND sequence_order == s)` pairs, a term per quote. SQLite refuses
an expression tree deeper than `SQLITE_MAX_EXPR_DEPTH` = **1,000**, so a project
with ~995 quotes that have a preceding turn (50 interviews × 20 quotes) answered
500 on the whole board — far below the 250,000-parameter ceiling `sql-id-sets.md`
is about. The read is now one join per parent kind back to the quoted turns, the
quoted ids sent as one JSON array (`in_id_set`): no expression and no bind per row.

**The depth limit is LOWERED on the test connection, as `test_sql_variable_ceiling.py`
lowers the bind limit**, so a 60-quote fixture crosses it the way a real project
does. ⚠️ The DISCRIMINATION test is load-bearing: it proves the old `or_` shape
raises under the same lowered depth, so a limit that silently failed to apply
cannot leave the other tests green. One test also runs at the REAL limit (1,100
quotes in one interview), so the number in the entry is checked as stated, and it
counts every statement's bound parameters: the bind limit cannot be lowered the
same way here, because the endpoint's `selectinload` of each quote's codings binds
500 ids per batch by design (SQLAlchemy's chunking) — far under 250,000, and not
per quote across the board.

The preceding turn is asserted against an ORACLE read one quote at a time (the
visible segment of the same parent one position earlier), over a fixture with a
hidden predecessor, a quote at position 0, a facilitator's preceding turn, a
document, a clip and an answer — so the new read cannot pass by returning
something plausible.
"""
from __future__ import annotations

import sqlite3

import pytest
from sqlalchemy import and_, event, or_
from sqlalchemy.exc import OperationalError

from app.models import (
    Conversation, Dataset, DatasetColumn, DatasetRow, DatasetValue, Document, Project,
    Segment, User,
)
from app.models.dataset import ColumnType
from app.models.excerpt import Excerpt
from app.models.observation import Observation
from app.models.speaker import Speaker
from app.routers.excerpts import list_quoted_excerpts
from app.routers.helpers import visible_segment_filter

PID = 15390
DEPTH = 50          # expression-tree depth on the test connection (SQLite's own: 1,000)
SELECTIN_BATCH = 500  # SQLAlchemy's selectinload chunk — the most any statement here may bind
TURNS = 60          # conversation turns, every one quoted
PARAS = 30          # document paragraphs, every one quoted


def _raw(db):
    return db.connection().connection.dbapi_connection


def _lower_limits(db) -> None:
    _raw(db).setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, DEPTH)


def _board(db, **kw):
    return list_quoted_excerpts(
        project_id=PID, source=kw.get("source", "all"), code_ids=None,
        conversation_ids=kw.get("conversation_ids"), document_ids=None, text_column_ids=None,
        exclude_facilitator=False, participant_ids=None, coder_ids=None,
        user=db.get(User, 1), db=db,
    )


@pytest.fixture
def board(db_session):
    db = db_session
    db.add(Project(id=PID, name="Quote depth", user_id=1))
    db.flush()
    fac = Speaker(project_id=PID, name="Interviewer", is_facilitator=True)
    resp = Speaker(project_id=PID, name="Ana")
    db.add_all([fac, resp])
    db.flush()

    conv = Conversation(project_id=PID, name="Interview 1")
    doc = Document(project_id=PID, name="Policy", source_filename="policy.docx", source_format="docx")
    obs = Observation(project_id=PID, name="Classroom")
    db.add_all([conv, doc, obs])
    db.flush()

    turns = [
        Segment(conversation_id=conv.id, sequence_order=i, text=f"turn {i}",
                speaker_id=(fac if i % 2 == 0 else resp).id)
        for i in range(TURNS)
    ]
    paras = [Segment(document_id=doc.id, sequence_order=i, text=f"para {i}") for i in range(PARAS)]
    clip = Segment(observation_id=obs.id, sequence_order=1, text="clip label",
                   start_time=1.0, end_time=2.0)
    # A merge result elsewhere in the interview; turn 9 is hidden INTO it, so the
    # quote on turn 10 has no visible predecessor (the board shows no context).
    merged = Segment(conversation_id=conv.id, sequence_order=TURNS + 5, text="merged result",
                     speaker_id=resp.id)
    db.add_all(turns + paras + [clip, merged])
    db.flush()
    turns[9].merged_into_id = merged.id
    db.flush()

    quoted = [t for t in turns if t.merged_into_id is None] + paras + [clip]
    db.add_all([Excerpt(project_id=PID, segment_id=s.id) for s in quoted])

    ds = Dataset(project_id=PID, name="Survey")
    db.add(ds)
    db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_code="q1", column_name="Q1", column_text="Q1",
                        column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0)
    row = DatasetRow(dataset_id=ds.id)
    db.add_all([col, row])
    db.flush()
    val = DatasetValue(row_id=row.id, column_id=col.id, value_text="an answer")
    db.add(val)
    db.flush()
    db.add(Excerpt(project_id=PID, dataset_value_id=val.id))
    db.flush()
    return db


def _oracle(db, seg_id):
    """The preceding turn as the board means it, read for ONE quote: the visible segment
    of the same parent one position earlier, or nothing."""
    seg = db.get(Segment, seg_id)
    if seg.sequence_order is None or seg.sequence_order <= 0:
        return None
    if seg.conversation_id:
        parent = Segment.conversation_id == seg.conversation_id
    elif seg.document_id:
        parent = Segment.document_id == seg.document_id
    else:
        return None
    prev = (
        db.query(Segment)
        .filter(parent, Segment.sequence_order == seg.sequence_order - 1, *visible_segment_filter())
        .one_or_none()
    )
    return prev


def test_the_lowered_depth_really_refuses_the_old_or_form(board):
    """Discrimination: the old shape — one `or_` term per quote — RAISES under the lowered
    depth on this fixture, so the tests below cross the limit rather than pass beside it."""
    db = board
    _lower_limits(db)
    pairs = [(s.conversation_id, s.sequence_order) for s in db.query(Segment)
             .filter(Segment.conversation_id.isnot(None)).all()]
    assert len(pairs) > DEPTH
    with pytest.raises(OperationalError, match="Expression tree is too large"):
        db.query(Segment).filter(or_(*[
            and_(Segment.conversation_id == c, Segment.sequence_order == s) for c, s in pairs
        ])).all()


def test_the_board_answers_past_the_lowered_depth(board):
    db = board
    _lower_limits(db)
    resp = _board(db)
    # TURNS - 1 visible turns + PARAS paragraphs + 1 clip + 1 answer
    assert resp.total_excerpts == (TURNS - 1) + PARAS + 1 + 1
    assert resp.total_conversation_excerpts == TURNS - 1
    assert resp.total_document_excerpts == PARAS


def test_every_preceding_turn_is_the_oracles(board):
    db = board
    _lower_limits(db)
    resp = _board(db)
    seen = 0
    with_context = 0
    for item in resp.excerpts:
        if item.source_type != "segment":
            assert item.context_before is None
            continue
        seen += 1
        prev = _oracle(db, item.segment_id)
        assert item.context_before == (prev.text if prev else None), item.segment_id
        assert item.context_before_speaker == (
            prev.speaker.name if prev is not None and prev.speaker else None
        ), item.segment_id
        with_context += prev is not None
    # Population floors, so a read that found nothing cannot pass: every quote but the
    # first turn, the turn after the hidden one, the first paragraph and the clip.
    assert seen == (TURNS - 1) + PARAS + 1
    assert with_context == seen - 4
    by_text = {i.text: i for i in resp.excerpts}
    assert by_text["turn 10"].context_before is None            # turn 9 is hidden
    assert by_text["turn 0"].context_before is None             # nothing before position 0
    assert by_text["turn 1"].context_before_speaker == "Interviewer"
    assert by_text["para 1"].context_before == "para 0"
    assert by_text["clip label"].context_before is None


def test_a_selection_of_one_interview_reads_only_its_turns(board):
    db = board
    _lower_limits(db)
    conv_id = db.query(Conversation.id).filter(Conversation.project_id == PID).scalar()
    resp = _board(db, source="conversations", conversation_ids=str(conv_id))
    assert resp.total_excerpts == TURNS - 1
    assert all(i.conversation_id == conv_id for i in resp.excerpts)


def test_at_the_real_limit_and_no_bind_per_quote(db_session):
    """No lowered limit: 1,100 quotes, each with a preceding turn, in one interview —
    the old read refused from about 995 (measured, ISSUES #1539). And no statement binds
    a parameter per quote: the old read bound two per quote in ONE statement (2,200 here),
    so at 125,000 quotes it would have met the 250,000 ceiling next."""
    db = db_session
    db.add(Project(id=PID, name="Real depth", user_id=1))
    db.flush()
    conv = Conversation(project_id=PID, name="Long interview")
    db.add(conv)
    db.flush()
    segs = [Segment(conversation_id=conv.id, sequence_order=i, text=f"t{i}") for i in range(1101)]
    db.add_all(segs)
    db.flush()
    db.add_all([Excerpt(project_id=PID, segment_id=s.id) for s in segs[1:]])
    db.flush()
    binds: list[int] = []

    def _count(conn, cursor, statement, parameters, context, executemany):
        binds.append(len(parameters) if isinstance(parameters, (tuple, list)) else 0)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", _count)
    try:
        resp = _board(db)
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    assert binds, "the listener saw no statement"            # the counter is live
    assert max(binds) <= SELECTIN_BATCH, max(binds)
    assert resp.total_excerpts == 1100
    assert all(i.context_before == f"t{int(i.text[1:]) - 1}" for i in resp.excerpts)


def _work(db) -> int:
    """SQLite's own work for one board read, counted in VM steps — a machine's speed
    cannot pass or fail it (`test_participant_resolution.py::TestTheCellLookupSeeksByKey`)."""
    ticks = [0]

    def tick():
        ticks[0] += 1
        return 0

    raw = _raw(db)
    raw.set_progress_handler(tick, 100)
    try:
        resp = _board(db)
    finally:
        raw.set_progress_handler(None, 100)
    assert resp.total_excerpts > 0          # it did answer
    return ticks[0]


def test_the_preceding_read_does_not_walk_the_install(board):
    """The preceding-turn read is entered through the QUOTED ids and seeks the parent's
    `(…_id, sequence_order)` index. Written with `visible_segment_filter()`'s default form,
    SQLite starts from `ix_segments_merged_into_id` — every visible segment on the install —
    instead (#1463 D62's trap): measured on the D12 copy (1.2M turns), 199 s against 0.07 s
    for 20,000 quotes. So: the same board, in an install with 20,000 more segments in another
    project, must cost under twice as much."""
    db = board
    small = _work(db)
    other = Project(id=PID + 1, name="Someone else's study", user_id=1)
    db.add(other)
    db.flush()
    conv = Conversation(project_id=other.id, name="Unrelated")
    db.add(conv)
    db.flush()
    db.add_all([Segment(conversation_id=conv.id, sequence_order=i, text="x") for i in range(20_000)])
    db.flush()
    large = _work(db)
    assert small > 0
    assert large < 2 * small, (small, large)
