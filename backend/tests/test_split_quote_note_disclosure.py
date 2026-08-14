"""#712 — a split discloses how many quote notes stayed with the original.

The gap: #695 carries char-range quotes onto the split's children as NEW rows, but
a quote's one-to-one `Note` is deliberately not carried (`ix_notes_excerpt_unique`
allows exactly one, so a divided quote could not keep it on both pieces). The note
is not lost — it sits on the soft-deleted original and returns on unsplit — but
until then it is invisible, and a researcher who splits and sees the note gone has
no way to know that.

⚠️ **Why the disclosure is at SPLIT TIME rather than beside the quote**, which is
what the 2026-08-11 design sitting first called for: afterwards the link cannot be
recovered. `Excerpt` has no provenance column; `_add_carried_excerpts` clips
offsets and dedups on `(start, end)`, so child→source is many-to-one; and the
child→original edge is `_find_split_siblings`' contiguity heuristic. A per-quote
caveat rendered later could only be GUESSED — and a guess prints a false statement
on the researcher's own data. The count here is exact because the service still
holds the source excerpts.
"""
import asyncio
import os

import pytest

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models.conversation import Conversation
from app.models.excerpt import Excerpt
from app.models.note import Note
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.segments import split_segments_endpoint
from app.schemas.segment import SegmentSplitRequest


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def db_session():
    from app.database import Base, engine, SessionLocal
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    db.add(User(id=1, username="testuser", password_hash="x", is_admin=True))
    db.flush()
    try:
        yield db
    finally:
        db.rollback(); db.close(); Base.metadata.drop_all(bind=engine)


@pytest.fixture
def scene(db_session):
    """One conversation, one segment long enough to split, no quotes yet."""
    db = db_session
    p = Project(name="P", user_id=1); db.add(p); db.flush()
    conv = Conversation(project_id=p.id, name="C"); db.add(conv); db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=1,
                  text="alpha beta gamma delta epsilon zeta")
    db.add(seg); db.flush()
    return db, p, conv, seg


def _quote(db, project_id, segment_id, start, end, *, with_note: bool):
    ex = Excerpt(project_id=project_id, segment_id=segment_id,
                 start_offset=start, end_offset=end)
    db.add(ex); db.flush()
    if with_note:
        n = Note(conversation_id=None, segment_id=segment_id, excerpt_id=ex.id,
                 content="why this matters", sequence_number=1)
        # a quote note hangs off the conversation via its segment
        n.conversation_id = db.query(Segment).get(segment_id).conversation_id
        db.add(n); db.flush()
    return ex


def _split(db, conv, user, at: int):
    """Split the first visible segment at a char offset, through the endpoint."""
    seg = db.query(Segment).filter(
        Segment.conversation_id == conv.id,
        Segment.split_into_id.is_(None),
        Segment.merged_into_id.is_(None),
    ).order_by(Segment.sequence_order).first()
    req = SegmentSplitRequest(ranges=[{
        "segment_id": seg.id, "start_offset": at, "end_offset": at + 5,
    }])
    return _run(split_segments_endpoint(conv.id, req, user=user, db=db))


class TestQuoteNoteDisclosure:

    def test_a_split_reports_the_notes_it_leaves_behind(self, scene):
        db, p, conv, seg = scene
        user = db.query(User).get(1)
        _quote(db, p.id, seg.id, 0, 5, with_note=True)     # "alpha", noted
        _quote(db, p.id, seg.id, 6, 10, with_note=False)   # "beta", no note
        db.flush()

        resp = _split(db, conv, user, at=12)
        assert resp.quote_notes_stayed == 1, (
            "exactly the carried quote that had a note should be counted"
        )

    def test_a_split_with_no_quote_notes_reports_zero(self, scene):
        db, p, conv, seg = scene
        user = db.query(User).get(1)
        _quote(db, p.id, seg.id, 0, 5, with_note=False)
        db.flush()

        resp = _split(db, conv, user, at=12)
        assert resp.quote_notes_stayed == 0, (
            "a real zero must be reported as zero — the client suppresses the "
            "disclosure on 0, so a false positive would nag on every split"
        )

    def test_a_divided_quote_is_counted_once(self, scene):
        """The plan lists one tuple per (excerpt, destination part).

        A quote spanning the cut produces TWO carried rows from ONE source, so a
        naive len() over the plan would double-count and tell the researcher two
        notes stayed when one did.
        """
        db, p, conv, seg = scene
        user = db.query(User).get(1)
        _quote(db, p.id, seg.id, 0, 20, with_note=True)    # spans the cut at 12
        db.flush()

        resp = _split(db, conv, user, at=12)
        assert resp.quote_notes_stayed == 1
