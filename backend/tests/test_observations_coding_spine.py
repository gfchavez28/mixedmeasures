"""Observations track — slab 4a (the coding + annotation spine).

Direct async endpoint calls via ``asyncio.run`` (the _run pattern; ownership is
structurally guaranteed by test_ownership_gate_sweep.py). Covers:

  * bulk_code across all THREE parents (D23) — a multi-clip apply lands, an audit
    row is written, and conversations stay byte-identical.
  * whole-clip excerpts (D24) + the #617 parent-aware context fix (two-sided: a
    document excerpt's context comes from ITS document, never a cross-project
    null-conversation segment).
  * observation notes create/list + the segment-belongs-to-THIS-observation
    cross-tenant guard (the AST sweep is blind to a second entity id) + the
    _validate_note_parent fix that un-404s an imported observation note.
  * the memo observation validation arm (two-sided).
  * coder-coverage scoped to an observation (two-sided).
  * wire pins for the new QuotedExcerptItem / QuotedExcerptsResponse fields.
"""
import asyncio
import json

import pytest
from fastapi import HTTPException

from app.models import (
    Project, Observation, Conversation, Document, Segment, Code, CodeApplication,
    Note, AuditEntry, User,
)
from app.routers.coding import bulk_code
from app.routers.excerpts import (
    create_excerpt, bulk_create_excerpts, get_excerpt, list_quoted_excerpts,
)
from app.routers.observations import create_observation_note, list_observation_notes
from app.routers.notes import get_note
from app.routers.memos import create_memo
from app.routers.code_analysis import coder_coverage
from app.schemas.coding import BulkCodeRequest
from app.schemas.excerpt import ExcerptCreate, ExcerptBulkCreate
from app.schemas.observation import ObservationNoteCreate
from app.schemas.memo import MemoCreate


def _run(coro):
    return asyncio.run(coro)


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


def _clip(oid, sid, seq, start, end, text=""):
    return Segment(
        id=sid, observation_id=oid, conversation_id=None, document_id=None,
        sequence_order=seq, start_time=start, end_time=end, text=text,
    )


# ── D23: bulk_code spans all three parents ─────────────────────────────────

class TestBulkCodeThreeParent:
    def test_multi_clip_apply_lands_and_audits(self, db_session):
        db = db_session
        db.add_all([
            Project(id=100, name="P", user_id=1),
            Observation(id=100, project_id=100, name="Obs"),
            Code(id=1000, project_id=100, name="C", numeric_id=1, is_active=True, is_universal=False),
        ])
        db.flush()
        db.add_all([
            _clip(100, 1001, 0, 0.0, 10.0, "a"),
            _clip(100, 1002, 1, 10.0, 20.0, "b"),
            _clip(100, 1003, 2, 20.0, 30.0, "c"),
        ])
        db.flush()

        resp = _run(bulk_code(
            BulkCodeRequest(segment_ids=[1001, 1002, 1003], code_id=1000, action="apply"),
            user=_user(db), db=db,
        ))
        # Every clip comes back applied — the old 2-parent map dropped them into
        # applied=False inside a 200 (the D23 bug).
        assert resp.success_count == 3 and resp.error_count == 0
        assert all(r.applied for r in resp.results)
        apps = db.query(CodeApplication).filter(
            CodeApplication.code_id == 1000, CodeApplication.segment_id.in_([1001, 1002, 1003])
        ).all()
        assert {a.segment_id for a in apps} == {1001, 1002, 1003}

        # The bulk path now writes an audit row (the single paths always did).
        audit = db.query(AuditEntry).filter(
            AuditEntry.action == "code_applied",
            AuditEntry.entity_type == "code_application",
        ).all()
        assert len(audit) == 1
        details = json.loads(audit[0].details)  # AuditEntry.details is a JSON string
        assert details.get("bulk") is True
        assert sorted(details.get("segment_ids")) == [1001, 1002, 1003]

    def test_conversation_still_works(self, db_session):
        db = db_session
        db.add_all([
            Project(id=101, name="P", user_id=1),
            Conversation(id=101, project_id=101, name="C"),
            Code(id=1010, project_id=101, name="C", numeric_id=1, is_active=True, is_universal=False),
            Segment(id=1011, conversation_id=101, sequence_order=0, text="one"),
            Segment(id=1012, conversation_id=101, sequence_order=1, text="two"),
        ])
        db.flush()
        resp = _run(bulk_code(
            BulkCodeRequest(segment_ids=[1011, 1012], code_id=1010, action="apply"),
            user=_user(db), db=db,
        ))
        assert resp.success_count == 2 and all(r.applied for r in resp.results)

    def test_foreign_project_clip_is_dropped(self, db_session):
        """A clip in ANOTHER project must not be codable by this project's code."""
        db = db_session
        db.add_all([
            Project(id=102, name="P", user_id=1),
            Project(id=103, name="Q", user_id=1),
            Observation(id=102, project_id=102, name="Mine"),
            Observation(id=103, project_id=103, name="Theirs"),
            Code(id=1020, project_id=102, name="C", numeric_id=1, is_active=True, is_universal=False),
        ])
        db.flush()
        db.add_all([_clip(102, 1021, 0, 0.0, 5.0), _clip(103, 1031, 0, 0.0, 5.0)])
        db.flush()
        resp = _run(bulk_code(
            BulkCodeRequest(segment_ids=[1021, 1031], code_id=1020, action="apply"),
            user=_user(db), db=db,
        ))
        # Mine lands; theirs is an error row (not in this project's scope).
        assert resp.success_count == 1 and resp.error_count == 1
        got = {r.segment_id: r.applied for r in resp.results}
        assert got[1021] is True and got[1031] is False


# ── D24: whole-clip excerpts + honest quote-board labels ───────────────────

class TestClipExcerpts:
    def _obs_with_clip(self, db, pid=200, oid=200, sid=2001, name="Classroom", start=65.0):
        db.add_all([
            Project(id=pid, name="P", user_id=1),
            Observation(id=oid, project_id=pid, name=name),
        ])
        db.flush()
        db.add(_clip(oid, sid, 0, start, start + 30.0, "arrival"))
        db.flush()
        return pid, oid, sid

    def test_create_whole_clip_excerpt(self, db_session):
        db = db_session
        pid, oid, sid = self._obs_with_clip(db)
        resp = _run(create_excerpt(pid, ExcerptCreate(segment_id=sid), user=_user(db), db=db))
        assert resp.segment_id == sid
        assert resp.excerpt_text == "arrival"

    def test_bulk_create_clip_excerpt(self, db_session):
        db = db_session
        pid, oid, sid = self._obs_with_clip(db)
        out = _run(bulk_create_excerpts(
            pid, ExcerptBulkCreate(items=[ExcerptCreate(segment_id=sid)]),
            user=_user(db), db=db,
        ))
        assert out["created_count"] == 1 and out["skipped_count"] == 0

    def test_quoted_excerpt_clip_has_honest_source(self, db_session):
        db = db_session
        pid, oid, sid = self._obs_with_clip(db, start=65.0)  # 65s -> 01:05
        _run(create_excerpt(pid, ExcerptCreate(segment_id=sid), user=_user(db), db=db))
        # All Query-defaulted params passed explicitly — a Query() default leaks
        # its sentinel object into direct calls (backend/tests/the internal design notes).
        resp = _run(list_quoted_excerpts(
            pid, source="all", code_ids=None, conversation_ids=None,
            document_ids=None, text_column_ids=None, exclude_facilitator=False,
            participant_ids=None, user=_user(db), db=db,
        ))
        assert resp.total_observation_excerpts == 1
        assert len(resp.excerpts) == 1
        item = resp.excerpts[0]
        assert item.source_type == "segment"
        assert item.observation_id == oid
        assert item.observation_name == "Classroom"
        # The BARE observation name since slab 5c. The interim ` · {timecode}`
        # suffix gave a clip excerpt identity before the card could render one,
        # but it made source_name unique per clip and so shattered the
        # group-by-source view into one bucket per clip. The timecode is real
        # data on the wire now (asserted just below), and grouping keys
        # observation_id.
        assert item.source_name == "Classroom"
        assert item.observation_id is not None
        # The CLIP's own span rides the wire, which is what makes the bare name
        # safe: a whole-clip quote has no range of its own (`start_time` is the
        # EXCERPT's and is None here), so without these the card would have no
        # timecode to show and every clip of one observation would read alike.
        assert item.segment_start_time == 65.0
        assert item.start_time is None


# ── #617: excerpt context is parent-aware (no cross-project bleed) ──────────

class TestExcerptContext617:
    def test_document_excerpt_context_from_its_document(self, db_session):
        db = db_session
        db.add_all([
            Project(id=300, name="P", user_id=1),
            Document(id=300, project_id=300, name="Doc", source_filename="d.txt", source_format="txt"),
        ])
        db.flush()
        db.add_all([
            Segment(id=3000, document_id=300, conversation_id=None, sequence_order=0, text="d0"),
            Segment(id=3001, document_id=300, conversation_id=None, sequence_order=1, text="d1"),
            Segment(id=3002, document_id=300, conversation_id=None, sequence_order=2, text="d2"),
        ])
        db.flush()
        exc = _run(create_excerpt(300, ExcerptCreate(segment_id=3001), user=_user(db), db=db))
        detail = _run(get_excerpt(300, exc.id, user=_user(db), db=db))
        assert detail.context_before == "d0"
        assert detail.context_after == "d2"

    def test_document_excerpt_context_does_not_bleed_across_projects(self, db_session):
        """The mutation-sensitive #617 fixture: OLD (`conversation_id IS NULL`)
        and NEW (parent-scoped) DISAGREE. Document D has NO same-document
        neighbor, but a foreign observation clip in ANOTHER project sits at an
        adjacent sequence_order with conversation_id NULL. The buggy query would
        pull that clip's text as context; the fix returns None. Non-vacuous: the
        foreign clips exist and would be selected by the bug."""
        db = db_session
        db.add_all([
            Project(id=310, name="Mine", user_id=1),
            Project(id=311, name="Theirs", user_id=1),
            Document(id=310, project_id=310, name="Lonely", source_filename="d.txt", source_format="txt"),
            Observation(id=311, project_id=311, name="Foreign"),
        ])
        db.flush()
        db.add_all([
            Segment(id=3100, document_id=310, conversation_id=None, sequence_order=5, text="lonely para"),
            # Foreign, null-conversation, adjacent sequence_orders — what the bug picks.
            _clip(311, 3110, 4, 0.0, 5.0, "FOREIGN BEFORE"),
            _clip(311, 3111, 6, 5.0, 10.0, "FOREIGN AFTER"),
        ])
        db.flush()
        exc = _run(create_excerpt(310, ExcerptCreate(segment_id=3100), user=_user(db), db=db))
        detail = _run(get_excerpt(310, exc.id, user=_user(db), db=db))
        assert detail.context_before is None
        assert detail.context_after is None
        # Non-vacuous escape assertion: the foreign clips really exist.
        assert db.query(Segment).filter(Segment.id.in_([3110, 3111])).count() == 2


# ── Observation notes: create / list / cross-tenant guard / 404 fix ────────

class TestObservationNotes:
    def _obs(self, db, pid=400, oid=400, sid=4000):
        db.add_all([
            Project(id=pid, name="P", user_id=1),
            Observation(id=oid, project_id=pid, name="Obs"),
        ])
        db.flush()
        db.add(_clip(oid, sid, 0, 0.0, 10.0, "clip label"))
        db.flush()
        return pid, oid, sid

    def test_create_observation_level_note(self, db_session):
        db = db_session
        pid, oid, _ = self._obs(db)
        out = _run(create_observation_note(
            pid, oid, ObservationNoteCreate(content="a thought"), user=_user(db), db=db))
        assert out["observation_id"] == oid and out["segment_id"] is None
        note = db.query(Note).filter(Note.id == out["id"]).one()
        assert note.observation_id == oid and note.conversation_id is None

    def test_create_clip_anchored_note(self, db_session):
        db = db_session
        pid, oid, sid = self._obs(db)
        out = _run(create_observation_note(
            pid, oid, ObservationNoteCreate(segment_id=sid, content="on this clip"),
            user=_user(db), db=db))
        assert out["segment_id"] == sid and out["observation_id"] == oid

    def test_clip_from_another_observation_is_refused(self, db_session):
        """Behavioral cross-tenant test — the ownership AST sweep is BLIND to the
        second id (segment_id), so the guard is checked by hand. Obs B's clip must
        not attach to a note on Obs A even within the SAME project."""
        db = db_session
        pid, oid_a, _ = self._obs(db, pid=401, oid=401, sid=4010)
        db.add(Observation(id=402, project_id=401, name="Obs B"))
        db.flush()
        db.add(_clip(402, 4020, 0, 0.0, 5.0, "b clip"))
        db.flush()
        with pytest.raises(HTTPException) as ei:
            _run(create_observation_note(
                pid, oid_a, ObservationNoteCreate(segment_id=4020, content="x"),
                user=_user(db), db=db))
        assert ei.value.status_code == 404

    def test_list_notes(self, db_session):
        db = db_session
        pid, oid, sid = self._obs(db)
        _run(create_observation_note(pid, oid, ObservationNoteCreate(content="one"), user=_user(db), db=db))
        _run(create_observation_note(pid, oid, ObservationNoteCreate(segment_id=sid, content="two"), user=_user(db), db=db))
        listed = _run(list_observation_notes(pid, oid, user=_user(db), db=db))
        assert [n["content"] for n in listed] == ["one", "two"]

    def test_imported_observation_note_resolves_via_get_note(self, db_session):
        """The _validate_note_parent observation branch un-404s a note that only
        arrived via import (observation_id set, no create endpoint ran)."""
        db = db_session
        pid, oid, _ = self._obs(db, pid=403, oid=403, sid=4030)
        note = Note(observation_id=oid, content="imported", sequence_number=0)
        db.add(note)
        db.commit()
        got = _run(get_note(pid, note.id, user=_user(db), db=db))
        assert got.id == note.id and got.content == "imported"


# ── Memo observation validation arm (two-sided) ────────────────────────────

class TestMemoObservationArm:
    def test_observation_memo_created(self, db_session):
        db = db_session
        db.add_all([
            Project(id=500, name="P", user_id=1),
            Observation(id=500, project_id=500, name="Obs"),
        ])
        db.flush()
        memo = _run(create_memo(500, MemoCreate(entity_type="observation", entity_id=500, content="note"),
                                user=_user(db), db=db))
        assert memo.entity_type == "observation" and memo.entity_id == 500

    def test_observation_memo_in_another_project_refused(self, db_session):
        db = db_session
        db.add_all([
            Project(id=501, name="P", user_id=1),
            Project(id=502, name="Q", user_id=1),
            Observation(id=502, project_id=502, name="Theirs"),
        ])
        db.flush()
        with pytest.raises(HTTPException) as ei:
            _run(create_memo(501, MemoCreate(entity_type="observation", entity_id=502, content="x"),
                             user=_user(db), db=db))
        assert ei.value.status_code == 400

    def test_observation_memo_nonexistent_refused(self, db_session):
        db = db_session
        db.add(Project(id=503, name="P", user_id=1))
        db.flush()
        with pytest.raises(HTTPException) as ei:
            _run(create_memo(503, MemoCreate(entity_type="observation", entity_id=99999, content="x"),
                             user=_user(db), db=db))
        assert ei.value.status_code == 400


# ── Coder coverage scoped to an observation (two-sided) ────────────────────

class TestCoderCoverageObservation:
    def test_coverage_scopes_to_the_observation(self, db_session):
        db = db_session
        db.add_all([
            Project(id=600, name="P", user_id=1),
            Observation(id=600, project_id=600, name="Coded"),
            Observation(id=601, project_id=600, name="Uncoded"),
            Code(id=6000, project_id=600, name="C", numeric_id=1, is_active=True, is_universal=False),
        ])
        db.flush()
        db.add_all([_clip(600, 6001, 0, 0.0, 5.0), _clip(601, 6011, 0, 0.0, 5.0)])
        db.flush()
        db.add(CodeApplication(code_id=6000, user_id=1, segment_id=6001))
        db.flush()

        coded = _run(coder_coverage(600, observation_id=600, user=_user(db), db=db))
        assert 1 in [c.user_id for c in coded.coders]

        uncoded = _run(coder_coverage(600, observation_id=601, user=_user(db), db=db))
        assert uncoded.count == 0
