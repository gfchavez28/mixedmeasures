"""Observations track — slab 4b: search grows the third source kind, honestly (#569).

Wire pins for the response fields (the #569 rider).

⚠️ **The deprecation beat ENDED 2026-08-09** (the cut after v1.3.0), and these tests
inverted with it. They used to pin that a DOC hit kept its overloaded
``conversation_id`` populated — "so dropping the overload is a deliberate act, not a
drift". This *is* that deliberate act, so the pins now assert the opposite:

  * every hit — conversation, document, clip — identifies its source through
    ``source_kind`` + ``source_id`` and nothing else, with ``start_time`` riding on
    clips for the client's timecode subtitle;
  * ``conversation_id`` and ``source_type`` are GONE from both response models, and
    that is asserted **off the Pydantic model's own field set** rather than per
    field. Per the arity rule in ``backend/tests/the internal design notes`: pin the relationship,
    not the instance — re-adding either name to either model fails immediately,
    without anyone needing to know this file exists.
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


class TestRetiredShimStaysRetired:
    """#569: the fields are gone from the MODELS, so they cannot return quietly.

    Derived from ``model_fields`` rather than written out per field — a re-added
    ``conversation_id`` on either model fails here even though nothing in the
    reintroducing change would think to look at this file.
    """

    RETIRED = {"conversation_id", "source_type"}

    def test_neither_response_model_carries_a_retired_field(self):
        from app.schemas.search import NoteSearchResult, SegmentSearchResult

        for model in (SegmentSearchResult, NoteSearchResult):
            leaked = self.RETIRED & set(model.model_fields)
            assert not leaked, (
                f"{model.__name__} re-introduced {sorted(leaked)}. These were the #569 "
                "deprecation pair, retired 2026-08-09: `conversation_id` meant the "
                "DOCUMENT id on doc hits, and `source_type` duplicated `source_kind`. "
                "Identify a source with source_kind + source_id."
            )

    def test_the_honest_pair_is_still_there(self):
        """Guard-for-the-guard: the assertion above passes vacuously on an empty model."""
        from app.schemas.search import NoteSearchResult, SegmentSearchResult

        for model in (SegmentSearchResult, NoteSearchResult):
            assert {"source_kind", "source_id"} <= set(model.model_fields)


class TestSegmentSourceKind:
    def test_clip_hit_identifies_its_observation(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        clip = next(i for i in resp.segments.items if i.source_kind == "observation")
        assert clip.source_id == pid
        assert clip.conversation_name == "Classroom morning"
        assert clip.start_time == 65.0, "clip start rides for the timecode subtitle"

    def test_doc_hit_source_id_is_the_DOCUMENT_id(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        doc = next(i for i in resp.segments.items if i.source_kind == "document")
        assert doc.source_id == pid
        assert doc.conversation_name == "Field notes", "the SOURCE display name"

    def test_conversation_hit_source_id_is_the_conversation_id(self, db_session):
        pid = _seed(db_session)
        resp = _search(db_session, pid, "bell", "segments")
        conv = next(i for i in resp.segments.items if i.source_kind == "conversation")
        assert conv.source_id == pid

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
        assert n.source_kind == "observation"
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
        assert by_kind["conversation"].source_id == pid
        # Post-#569 the doc note's source_id is the DOCUMENT id, reached through
        # source_kind — not smuggled through a conversation-shaped field.
        assert by_kind["document"].source_id == pid
        assert by_kind["document"].conversation_name == "Field notes"


class TestMemoEntityName:
    def test_observation_memo_resolves_entity_name(self, db_session):
        pid = _seed(db_session)
        db_session.add(Memo(project_id=pid, numeric_id=1, entity_type="observation",
                            entity_id=pid, title="Setting", content="morning light, bell schedule"))
        db_session.flush()
        resp = _search(db_session, pid, "bell schedule", "memos")
        assert resp.memos.count == 1
        assert resp.memos.items[0].entity_name == "Classroom morning"
