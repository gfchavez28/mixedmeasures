"""Observation clip CRUD + the freeze/unfreeze consensus lifecycle (slab 3a).

Endpoints are async and called directly via asyncio.run (the _run pattern);
ownership is structurally guaranteed by test_ownership_gate_sweep.py — these
tests exercise behavior: the D22 frozen refusals, the manual-create MAX_CLIPS
cap, range validation, the (start_time, end_time, id) resequence rule, the
delete cascades, and the #615 freeze/unfreeze consensus lifecycle (two-sided:
freeze marks + the sweep materializes; unfreeze drops the derived layer while
every human coding and every conversation consensus row survives).
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.note import Note
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.observations import (
    create_clip,
    delete_clip,
    freeze_segmentation,
    list_observation_segments,
    unfreeze_segmentation,
    update_clip,
)
from app.schemas.observation import ClipCreate, ClipUpdate
from app.services.consensus_staleness import sweep_stale_consensus
from app.services.observation_segmentation import resequence_observation_clips


def _run(coro):
    return asyncio.run(coro)


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


def _coder(db, uid, name):
    u = User(id=uid, username=name, password_hash=None, coder_type="human")
    db.add(u)
    db.flush()
    return u


def _obs_project(db, pid=730):
    db.add(Project(id=pid, name="P", user_id=1))
    db.add(Observation(id=pid, project_id=pid, name="Obs"))
    db.flush()
    return pid


def _code(db, cid, pid, numeric_id=1, universal=False):
    db.add(Code(id=cid, project_id=pid, name=f"Code{cid}", numeric_id=numeric_id,
                is_active=True, is_universal=universal))
    db.flush()


def _apply(db, code_id, user_id, segment_id):
    db.add(CodeApplication(code_id=code_id, user_id=user_id, segment_id=segment_id))
    db.flush()


def _clip(db, u, pid, start, end, text=""):
    return _run(create_clip(pid, pid, ClipCreate(start_time=start, end_time=end, text=text),
                            user=u, db=db))


def _obs_consensus_rows(db, pid):
    return (
        db.query(CodeApplication)
        .filter(
            CodeApplication.origin == "consensus",
            CodeApplication.segment_id.in_(
                db.query(Segment.id).filter(Segment.observation_id == pid)
            ),
        )
        .all()
    )


# ── Create ───────────────────────────────────────────────────────────────────


class TestClipCreate:
    def test_create_and_list_in_start_time_order(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        # Created out of temporal order — sequence_order must be re-derived.
        _clip(db, u, pid, 10.0, 20.0, "later")
        _clip(db, u, pid, 0.0, 5.0, "earlier")
        listed = _run(list_observation_segments(pid, pid, user=u, db=db))
        assert [(c.text, c.sequence_order) for c in listed] == [
            ("earlier", 0), ("later", 1)
        ]

    def test_point_event_is_legal(self, db_session):
        db = db_session
        pid = _obs_project(db)
        clip = _clip(db, _user(db), pid, 8.25, 8.25, "bell")
        assert clip.start_time == clip.end_time == 8.25

    @pytest.mark.parametrize("start,end", [
        (-1.0, 5.0),          # negative start
        (5.0, 1.0),           # reversed
        (float("inf"), 6.0),  # non-finite
        (0.0, float("nan")),  # non-finite
    ])
    def test_invalid_range_400(self, db_session, start, end):
        db = db_session
        pid = _obs_project(db)
        with pytest.raises(HTTPException) as ei:
            _clip(db, _user(db), pid, start, end)
        assert ei.value.status_code == 400

    def test_frozen_409(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        _clip(db, u, pid, 0.0, 5.0)
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _clip(db, u, pid, 6.0, 7.0)
        assert ei.value.status_code == 409

    def test_manual_create_hits_the_clip_cap(self, db_session, monkeypatch):
        import app.routers.observations as obs_router
        monkeypatch.setattr(obs_router, "MAX_CLIPS", 2)
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        _clip(db, u, pid, 0.0, 1.0)
        _clip(db, u, pid, 1.0, 2.0)
        with pytest.raises(HTTPException) as ei:
            _clip(db, u, pid, 2.0, 3.0)
        assert ei.value.status_code == 400
        assert "limit" in ei.value.detail


# ── Update ───────────────────────────────────────────────────────────────────


class TestClipUpdate:
    def test_boundary_edit_resequences_by_start_time(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0, "a")
        _clip(db, u, pid, 2.0, 3.0, "b")
        _clip(db, u, pid, 4.0, 5.0, "c")
        _run(update_clip(pid, pid, a.id, ClipUpdate(start_time=10.0, end_time=11.0),
                         user=u, db=db))
        listed = _run(list_observation_segments(pid, pid, user=u, db=db))
        assert [(c.text, c.sequence_order) for c in listed] == [
            ("b", 0), ("c", 1), ("a", 2)
        ]

    def test_combined_range_validated(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 5.0, 10.0)
        # Patching only start above the KEPT end must still 400.
        with pytest.raises(HTTPException) as ei:
            _run(update_clip(pid, pid, clip.id, ClipUpdate(start_time=12.0),
                             user=u, db=db))
        assert ei.value.status_code == 400

    def test_frozen_time_edit_409_but_label_edit_legal(self, db_session):
        """D22 two-sided: a boundary IS the cut (409); a label is annotation."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 5.0, "old label")
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _run(update_clip(pid, pid, clip.id, ClipUpdate(end_time=6.0), user=u, db=db))
        assert ei.value.status_code == 409
        updated = _run(update_clip(pid, pid, clip.id, ClipUpdate(text="new label"),
                                   user=u, db=db))
        assert updated.text == "new label"

    def test_noop_patch_returns_clip(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 5.0, "kept")
        got = _run(update_clip(pid, pid, clip.id, ClipUpdate(), user=u, db=db))
        assert (got.start_time, got.end_time, got.text) == (0.0, 5.0, "kept")

    def test_soft_deleted_clip_404s(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        a = _clip(db, u, pid, 0.0, 1.0)
        b = _clip(db, u, pid, 2.0, 3.0)
        db.query(Segment).filter(Segment.id == a.id).update(
            {Segment.merged_into_id: b.id}
        )
        db.flush()
        listed = _run(list_observation_segments(pid, pid, user=u, db=db))
        assert [c.id for c in listed] == [b.id]
        with pytest.raises(HTTPException) as ei:
            _run(update_clip(pid, pid, a.id, ClipUpdate(text="x"), user=u, db=db))
        assert ei.value.status_code == 404


# ── Delete ───────────────────────────────────────────────────────────────────


class TestClipDelete:
    def test_cascades_codes_and_detaches_notes(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 5.0)
        keeper = _clip(db, u, pid, 6.0, 7.0)
        _code(db, 1, pid)
        _apply(db, 1, 1, clip.id)
        note = Note(observation_id=pid, segment_id=clip.id, content="watch this",
                    sequence_number=1)
        db.add(note)
        db.flush()

        _run(delete_clip(pid, pid, clip.id, user=u, db=db))

        assert db.query(Segment).filter(Segment.id == clip.id).count() == 0
        assert db.query(CodeApplication).filter(
            CodeApplication.segment_id == clip.id
        ).count() == 0
        # The note SURVIVES, detached to the observation (segment link SET NULL).
        db.refresh(note)
        assert note.segment_id is None and note.observation_id == pid
        # The survivor resequenced to the front.
        listed = _run(list_observation_segments(pid, pid, user=u, db=db))
        assert [(c.id, c.sequence_order) for c in listed] == [(keeper.id, 0)]

    def test_frozen_409(self, db_session):
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 5.0)
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        with pytest.raises(HTTPException) as ei:
            _run(delete_clip(pid, pid, clip.id, user=u, db=db))
        assert ei.value.status_code == 409

    def test_missing_404(self, db_session):
        db = db_session
        pid = _obs_project(db)
        with pytest.raises(HTTPException) as ei:
            _run(delete_clip(pid, pid, 9999, user=_user(db), db=db))
        assert ei.value.status_code == 404


# ── Resequence rule (service-level) ─────────────────────────────────────────


class TestResequenceRule:
    def test_orders_by_start_end_id_and_skips_hidden(self, db_session):
        db = db_session
        pid = _obs_project(db)
        # Shuffled sequence_orders; two identical ranges (id tiebreak); one
        # soft-deleted row whose stale order must be left alone.
        segs = [
            Segment(id=9101, observation_id=pid, sequence_order=7, start_time=5.0,
                    end_time=6.0, text=""),
            Segment(id=9102, observation_id=pid, sequence_order=3, start_time=1.0,
                    end_time=9.0, text=""),
            Segment(id=9103, observation_id=pid, sequence_order=5, start_time=1.0,
                    end_time=2.0, text=""),
            Segment(id=9104, observation_id=pid, sequence_order=9, start_time=1.0,
                    end_time=9.0, text=""),  # ties 9102 on (start, end) → id breaks
            Segment(id=9105, observation_id=pid, sequence_order=99, start_time=0.0,
                    end_time=1.0, text="", merged_into_id=9101),
        ]
        db.add_all(segs)
        db.flush()

        resequence_observation_clips(db, pid)

        orders = {s.id: s.sequence_order for s in db.query(Segment).filter(
            Segment.observation_id == pid
        )}
        assert orders[9103] == 0   # (1.0, 2.0)
        assert orders[9102] == 1   # (1.0, 9.0, id 9102)
        assert orders[9104] == 2   # (1.0, 9.0, id 9104)
        assert orders[9101] == 3   # (5.0, 6.0)
        assert orders[9105] == 99  # hidden — untouched


# ── #615 — the freeze/unfreeze consensus lifecycle ──────────────────────────


class TestFreezeLifecycle:
    def test_freeze_refuses_zero_clips(self, db_session):
        db = db_session
        pid = _obs_project(db)
        with pytest.raises(HTTPException) as ei:
            _run(freeze_segmentation(pid, pid, user=_user(db), db=db))
        assert ei.value.status_code == 400

    def _frozen_coded_obs(self, db, pid=731):
        """Observation + clip coded UNANIMOUSLY by two roster coders, then frozen."""
        pid = _obs_project(db, pid)
        u = _user(db)
        _coder(db, 2, "K")  # second roster coder → consensus_enabled
        clip = _clip(db, u, pid, 0.0, 5.0)
        _code(db, 1, pid)
        _apply(db, 1, 1, clip.id)
        _apply(db, 1, 2, clip.id)
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        return pid, clip

    def test_freeze_marks_coded_clips_and_sweep_materializes(self, db_session):
        db = db_session
        pid, clip = self._frozen_coded_obs(db)
        # The marker landed (the load-bearing flush: without it the eligibility
        # subquery reads the UNFROZEN state and filters the id back out).
        assert db.query(ConsensusStaleTarget).filter(
            ConsensusStaleTarget.segment_id == clip.id
        ).count() == 1
        sweep_stale_consensus(db, project_id=pid)
        rows = _obs_consensus_rows(db, pid)
        assert len(rows) == 1 and rows[0].code_id == 1

    def test_freeze_without_second_coder_marks_nothing(self, db_session):
        """The marking is gated on consensus_enabled — a single-coder install
        does zero consensus work at freeze time."""
        db = db_session
        pid = _obs_project(db)
        u = _user(db)
        clip = _clip(db, u, pid, 0.0, 5.0)
        _code(db, 1, pid)
        _apply(db, 1, 1, clip.id)
        _run(freeze_segmentation(pid, pid, user=u, db=db))
        assert db.query(ConsensusStaleTarget).count() == 0

    def test_unfreeze_drops_derived_layer_keeps_human_coding(self, db_session):
        db = db_session
        pid, clip = self._frozen_coded_obs(db)
        sweep_stale_consensus(db, project_id=pid)
        assert len(_obs_consensus_rows(db, pid)) == 1

        obs = _run(unfreeze_segmentation(pid, pid, user=_user(db), db=db))

        assert obs.segmentation_frozen_at is None
        assert _obs_consensus_rows(db, pid) == []
        human = db.query(CodeApplication).filter(
            CodeApplication.segment_id == clip.id,
            CodeApplication.origin != "consensus",
        ).count()
        assert human == 2

    def test_unfreeze_leaves_conversation_consensus_untouched(self, db_session):
        """The #570 same-word-two-consequences guard: dropping an observation's
        derived layer must not touch a conversation's."""
        db = db_session
        pid, _clip_ = self._frozen_coded_obs(db)
        # A coded conversation segment in the same project, consensus materialized.
        db.add_all([
            Conversation(id=7311, project_id=pid, name="C"),
            Segment(id=73110, conversation_id=7311, sequence_order=0, text="hi"),
        ])
        db.flush()
        _apply(db, 1, 1, 73110)
        _apply(db, 1, 2, 73110)
        from app.services.consensus import recompute_consensus_for_target
        recompute_consensus_for_target(db, pid, segment_id=73110)
        assert db.query(CodeApplication).filter(
            CodeApplication.origin == "consensus",
            CodeApplication.segment_id == 73110,
        ).count() == 1

        _run(unfreeze_segmentation(pid, pid, user=_user(db), db=db))

        assert db.query(CodeApplication).filter(
            CodeApplication.origin == "consensus",
            CodeApplication.segment_id == 73110,
        ).count() == 1
