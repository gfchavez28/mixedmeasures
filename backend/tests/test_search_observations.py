"""Observations track — slab 4b: search grows the third source kind, honestly (#569).

Wire pins for the new response fields (the #569 rider):

  * a CLIP hit carries ``source_kind="observation"`` + ``source_id`` and NO
    conversation-id lie (``conversation_id=None`` — a new kind never repeats the
    overload), with ``start_time`` riding for the client's timecode subtitle;
  * a DOC hit keeps the overloaded ``conversation_id`` populated for exactly one
    release (the deprecation beat) while ALSO carrying the honest pair —
    pinned so dropping the overload is a deliberate act, not a drift;
  * observation NAMES are a fourth name block; observation NOTES ride the notes
    block; a memo on an observation resolves ``entity_name``.
"""
import asyncio

from app.models import (
    Project, Observation, Conversation, Document, Segment, Note, Memo, Excerpt, User,
)
from app.routers.search import search_study


def _run(coro):
    return asyncio.run(coro)


def _search(db, pid, q, types, quoted=None):
    user = db.get(User, 1)
    return _run(search_study(pid, q=q, types=types, limit=10, full_type=None,
                             quoted=quoted, user=user, db=db))


def _seed(db, pid=900):
    """One project with all three parents; each carries a 'bell' text hit."""
    db.add(Project(id=pid, name="P", user_id=1))
    db.flush()
    db.add_all([
        Conversation(id=pid, project_id=pid, name="Interview A"),
        Document(id=pid, project_id=pid, name="Field notes", source_filename="f.txt", source_format="txt"),
        Observation(id=pid, project_id=pid, name="Classroom morning", media_filename="rec.mp4"),
    ])
    db.flush()
    db.add_all([
        Segment(id=pid * 10 + 1, conversation_id=pid, sequence_order=0, text="the bell rang"),
        Segment(id=pid * 10 + 2, document_id=pid, conversation_id=None, sequence_order=0, text="a bell interrupts"),
        Segment(id=pid * 10 + 3, observation_id=pid, conversation_id=None, sequence_order=0,
                start_time=65.0, end_time=80.0, text="Bell interruption"),
    ])
    db.flush()
    return pid


class TestSegmentSourceKind:
    def test_clip_hit_is_honest_no_conversation_id_lie(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        clip = next(i for i in resp.segments.items if i.source_kind == "observation")
        assert clip.conversation_id is None, "a NEW kind never repeats the #569 overload"
        assert clip.source_id == pid
        assert clip.source_type == "observation"
        assert clip.conversation_name == "Classroom morning"
        assert clip.start_time == 65.0, "clip start rides for the timecode subtitle"

    def test_doc_hit_keeps_the_deprecation_beat_and_gains_the_pair(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        doc = next(i for i in resp.segments.items if i.source_kind == "document")
        # The beat: the overloaded conversation_id stays populated ONE release.
        # This pin makes dropping it a deliberate act next cut, not a drift.
        assert doc.conversation_id == pid
        assert doc.source_id == pid

    def test_conversation_hit_pair_matches_legacy_field(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        conv = next(i for i in resp.segments.items if i.source_kind == "conversation")
        assert conv.conversation_id == pid and conv.source_id == pid

    def test_all_three_kinds_found(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        assert {i.source_kind for i in resp.segments.items} == {"conversation", "document", "observation"}

    def test_quoted_filter_reaches_clips(self, db_session):
        pid = _seed(db_session)
        db_session.add(Excerpt(project_id=pid, segment_id=pid * 10 + 3))
        db_session.flush()
        resp = _search(db_session, pid, "bell", "segments", quoted=True)
        kinds = {i.source_kind for i in resp.segments.items}
        assert kinds == {"observation"}, "only the excerpted clip survives quoted=True"
        assert resp.segments.items[0].is_quoted is True

    def test_foreign_project_clip_not_returned(self, db_session):
        pid = _seed(db_session)
        db_session.add_all([
            Project(id=901, name="Q", user_id=1),
            Observation(id=901, project_id=901, name="Theirs"),
        ])
        db_session.flush()
        db_session.add(Segment(id=9099, observation_id=901, conversation_id=None,
                               sequence_order=0, start_time=0.0, end_time=1.0, text="bell too"))
        db_session.flush()
        resp = _search(db_session, pid, "bell", "segments")
        assert 9099 not in [i.id for i in resp.segments.items]


class TestObservationNameBlock:
    def test_name_hit_with_clip_count_and_media(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "classroom", "observations")
        assert resp.observations is not None and resp.observations.count == 1
        hit = resp.observations.items[0]
        assert hit.id == pid and hit.name == "Classroom morning"
        assert hit.segment_count == 1  # the one visible clip
        assert hit.has_media is True

    def test_not_searched_unless_requested(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "classroom", "segments,codes")
        assert resp.observations is None


class TestObservationNotes:
    def test_observation_note_hit_is_honest(self, db_session):
        pid = _seed(db_session)
        db_session.add(Note(observation_id=pid, segment_id=pid * 10 + 3,
                            content="watch the bell moment again", sequence_number=0))
        db_session.flush()
        resp = _search(db_session, pid, "bell moment", "notes")
        assert resp.notes.count == 1
        n = resp.notes.items[0]
        assert n.source_kind == "observation" and n.source_type == "observation"
        assert n.conversation_id is None, "no #569 overload for the new kind"
        assert n.source_id == pid
        assert n.conversation_name == "Classroom morning"
        assert n.segment_text_preview == "Bell interruption"

    def test_conv_and_doc_notes_unchanged(self, db_session):
        pid = _seed(db_session)
        db_session.add_all([
            Note(conversation_id=pid, content="conv note bell", sequence_number=1),
            Note(document_id=pid, content="doc note bell", sequence_number=0),
        ])
        db_session.flush()
        resp = _search(db_session, pid, "note bell", "notes")
        by_kind = {n.source_kind: n for n in resp.notes.items}
        assert by_kind["conversation"].conversation_id == pid
        assert by_kind["conversation"].source_id == pid
        # The doc beat: overloaded conversation_id still populated one release.
        assert by_kind["document"].conversation_id == pid
        assert by_kind["document"].source_id == pid


class TestMemoEntityName:
    def test_observation_memo_resolves_entity_name(self, db_session):
        pid = _seed(db_session)
        db_session.add(Memo(project_id=pid, numeric_id=1, entity_type="observation",
                            entity_id=pid, title="Setting", content="morning light, bell schedule"))
        db_session.flush()
        resp = _search(db_session, pid, "bell schedule", "memos")
        assert resp.memos.count == 1
        assert resp.memos.items[0].entity_name == "Classroom morning"
