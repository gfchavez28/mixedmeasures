"""Observations track — slab 1 spine.

The third Segment parent (Conversation | Document | Observation) and its
deliberate EXCLUSION from consensus (D2): per-target majority voting is
meaningless when coders create their own time-range units, so media-parent
segments never carry a consensus layer (unitizing-α is the reliability
statistic instead, wired in slab 6b). See
the internal design notes.
"""
import json
from datetime import datetime

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import (
    Observation, Conversation, Segment, Note, Project, User, Code, CodeApplication,
)
from app.services.consensus import (
    recompute_consensus_for_target, materialize_consensus_for_project,
)
from app.services.consensus_staleness import mark_consensus_stale
from app.services.coding_counts import coded_segment_count_for_project
from app.services.coding_coverage import source_coder_coverage


def _obs_project(db, pid=800):
    """Project + one observation. id=1 'testuser' exists from the fixture."""
    db.add(Project(id=pid, name="P", user_id=1))
    db.add(Observation(id=pid, project_id=pid, name="Obs"))
    db.flush()
    return pid


class TestThirdParentCheck:
    def test_observation_segment_is_valid(self, db_session):
        pid = _obs_project(db_session)
        seg = Segment(observation_id=pid, sequence_order=0, text="", start_time=1.0, end_time=5.0)
        db_session.add(seg)
        db_session.flush()
        assert seg.id is not None and seg.observation_id == pid

    def test_two_parents_rejected(self, db_session):
        pid = _obs_project(db_session)
        db_session.add(Conversation(id=pid, project_id=pid, name="C"))
        db_session.flush()
        db_session.add(Segment(conversation_id=pid, observation_id=pid, sequence_order=0, text=""))
        with pytest.raises(IntegrityError):
            db_session.flush()

    def test_observation_note_is_valid(self, db_session):
        pid = _obs_project(db_session)
        note = Note(observation_id=pid, content="clip note", sequence_number=0)
        db_session.add(note)
        db_session.flush()
        assert note.id is not None and note.observation_id == pid

    def test_cascade_delete_observation_removes_its_segments(self, db_session):
        pid = _obs_project(db_session)
        db_session.add(Segment(observation_id=pid, sequence_order=0, text=""))
        db_session.flush()
        db_session.delete(db_session.get(Observation, pid))
        db_session.flush()
        assert db_session.query(Segment).filter(Segment.observation_id == pid).count() == 0


class TestConsensusExcludesObservations:
    """D2: no consensus row is ever written for a media-parent segment, and no
    stale marker is enqueued for one — the two halves of the write-side gate."""

    def _two_coders_code_a_segment(self, db, seg_id, code_id=901, pid=800):
        db.add(User(id=2, username="B", password_hash=None, coder_type="human"))
        db.flush()
        db.add(Code(id=code_id, project_id=pid, name="T", numeric_id=1,
                    is_active=True, is_universal=False))
        db.flush()
        db.add(CodeApplication(code_id=code_id, user_id=1, segment_id=seg_id))
        db.add(CodeApplication(code_id=code_id, user_id=2, segment_id=seg_id))
        db.flush()

    def test_recompute_writes_nothing_for_media_segment(self, db_session):
        db = db_session
        pid = _obs_project(db)
        seg = Segment(observation_id=pid, sequence_order=0, text="", start_time=0.0, end_time=3.0)
        db.add(seg)
        db.flush()
        self._two_coders_code_a_segment(db, seg.id, pid=pid)

        written = recompute_consensus_for_target(db, pid, segment_id=seg.id)
        assert written == 0
        assert db.query(CodeApplication).filter(
            CodeApplication.origin == "consensus", CodeApplication.segment_id == seg.id
        ).count() == 0

        # The project-wide materializer excludes it too.
        materialize_consensus_for_project(db, pid)
        assert db.query(CodeApplication).filter(
            CodeApplication.origin == "consensus", CodeApplication.segment_id == seg.id
        ).count() == 0

    def test_recompute_control_conversation_segment_does_write(self, db_session):
        """Control: the SAME two-coder agreement on a CONVERSATION segment DOES
        produce a consensus row — proving the exclusion is media-specific."""
        db = db_session
        pid = _obs_project(db)
        db.add(Conversation(id=pid, project_id=pid, name="C"))
        db.flush()
        seg = Segment(conversation_id=pid, sequence_order=0, text="hi")
        db.add(seg)
        db.flush()
        self._two_coders_code_a_segment(db, seg.id, pid=pid)

        written = recompute_consensus_for_target(db, pid, segment_id=seg.id)
        assert written == 1

    def test_mark_consensus_stale_skips_media_but_marks_conversation(self, db_session):
        db = db_session
        pid = _obs_project(db)
        obs_seg = Segment(observation_id=pid, sequence_order=0, text="")
        db.add(obs_seg)
        db.flush()
        # media segment → skipped (no marker)
        assert mark_consensus_stale(db, pid, segment_ids=[obs_seg.id]) == 0

        # conversation segment → marked (control)
        db.add(Conversation(id=pid, project_id=pid, name="C"))
        db.flush()
        conv_seg = Segment(conversation_id=pid, sequence_order=1, text="hi")
        db.add(conv_seg)
        db.flush()
        assert mark_consensus_stale(db, pid, segment_ids=[conv_seg.id]) == 1

    def test_mark_consensus_stale_code_cascade_skips_media(self, db_session):
        """The code_ids cascade path (discovers segments from CodeApplications)
        must ALSO skip media segments — the second half of §0.3."""
        db = db_session
        pid = _obs_project(db)
        obs_seg = Segment(observation_id=pid, sequence_order=0, text="")
        db.add(obs_seg)
        db.flush()
        db.add(Code(id=901, project_id=pid, name="T", numeric_id=1, is_active=True, is_universal=False))
        db.flush()
        db.add(CodeApplication(code_id=901, user_id=1, segment_id=obs_seg.id))
        db.flush()
        # Marking by code_id would discover obs_seg via its application; it must
        # still be skipped because obs_seg is media-parented.
        assert mark_consensus_stale(db, pid, code_ids=[901]) == 0


class TestCountsCoverageWiring:
    """Observation coded clips count in the project total and in per-source
    coder coverage (slab-1 spine wiring)."""

    def test_coded_segment_count_for_project_observation(self, db_session):
        db = db_session
        pid = _obs_project(db)
        seg = Segment(observation_id=pid, sequence_order=0, text="")
        db.add(seg)
        db.flush()
        db.add(Code(id=901, project_id=pid, name="T", numeric_id=1, is_active=True, is_universal=False))
        db.flush()
        db.add(CodeApplication(code_id=901, user_id=1, segment_id=seg.id))
        db.flush()
        assert coded_segment_count_for_project(db, pid, source="observation") == 1

        # A universal-only clip does NOT count (invariant J-A).
        seg2 = Segment(observation_id=pid, sequence_order=1, text="")
        db.add(seg2)
        db.flush()
        db.add(Code(id=902, project_id=pid, name="U", numeric_id=2, is_active=True, is_universal=True))
        db.flush()
        db.add(CodeApplication(code_id=902, user_id=1, segment_id=seg2.id))
        db.flush()
        assert coded_segment_count_for_project(db, pid, source="observation") == 1

    def test_source_coder_coverage_observation(self, db_session):
        db = db_session
        pid = _obs_project(db)
        seg = Segment(observation_id=pid, sequence_order=0, text="")
        db.add(seg)
        db.flush()
        db.add(Code(id=901, project_id=pid, name="T", numeric_id=1, is_active=True, is_universal=False))
        db.flush()
        db.add(CodeApplication(code_id=901, user_id=1, segment_id=seg.id))
        db.flush()
        coverage = source_coder_coverage(db, pid, observation_id=pid)
        assert [c.user_id for c in coverage] == [1]


class TestSegmentOwnershipGate:
    """`_verify_segment_ownership` must FAIL CLOSED on every Segment parent.

    It branched `if conversation_id … elif document_id …` and then fell through to
    an unconditional `return segment` — so the moment a third parent existed, a clip
    was handed back to ANY caller with no ownership check at all. It was masked only
    by accident: `_get_segment_project_id` returned None for a clip, and the two
    callers turned that into a 400. That masking is now gone (the helper knows all
    three parents), so this gate is the only thing standing between a foreign user
    and another project's clip.
    """

    def _foreign_clip(self, db):
        """A clip inside a project owned by someone OTHER than user 1."""
        stranger = User(username="stranger", password_hash="x", is_admin=False)
        db.add(stranger)
        db.flush()
        db.add(Project(id=810, name="Stranger's project", user_id=stranger.id))
        db.add(Observation(id=810, project_id=810, name="Their obs"))
        db.flush()
        seg = Segment(observation_id=810, sequence_order=0, text="clip",
                      start_time=0.0, end_time=5.0)
        db.add(seg)
        db.flush()
        return seg

    def test_foreign_observation_clip_is_404d_under_multiuser(self, db_session):
        from fastapi import HTTPException
        from app.config import get_settings
        from app.routers.helpers import _verify_segment_ownership

        db = db_session
        seg = self._foreign_clip(db)

        settings = get_settings()
        original = settings.mm_multiuser_auth_enabled
        settings.mm_multiuser_auth_enabled = True
        try:
            with pytest.raises(HTTPException) as exc:
                _verify_segment_ownership(db, seg.id, user_id=1)
            assert exc.value.status_code == 404
        finally:
            settings.mm_multiuser_auth_enabled = original

    def test_owner_reaches_their_own_clip(self, db_session):
        from app.routers.helpers import _verify_segment_ownership

        db = db_session
        pid = _obs_project(db)
        seg = Segment(observation_id=pid, sequence_order=0, text="clip",
                      start_time=0.0, end_time=5.0)
        db.add(seg)
        db.flush()

        got = _verify_segment_ownership(db, seg.id, user_id=1)
        assert got.id == seg.id

    def test_clip_resolves_its_project(self, db_session):
        """`_get_segment_project_id` must not lie about a clip's project — it
        returned None, which the callers read as 'not the same project' (400)."""
        from app.routers.coding import _get_segment_project_id

        db = db_session
        pid = _obs_project(db)
        seg = Segment(observation_id=pid, sequence_order=0, text="clip",
                      start_time=0.0, end_time=5.0)
        db.add(seg)
        db.flush()

        assert _get_segment_project_id(db, seg) == pid


class TestSegmentationFreezeD18:
    """D18: consensus eligibility keys on UNIT PROVENANCE, not parent type.

    The whole point: if a team AGREES the clips (freezes the segmentation), every
    coder codes the SAME clips, so per-target voting is meaningful and the existing
    consensus / reconciliation / kappa engines work on video UNCHANGED. D2's
    blanket "Observations never get consensus" was right only for OPEN cuts, and it
    foreclosed the one workflow no observational tool on the market ships.
    """

    def _two_coders(self, db):
        second = User(username="coder2", password_hash="x", is_admin=False)
        db.add(second)
        db.flush()
        return second

    def _clip_coded_by(self, db, pid, obs_id, coders, code_id):
        """One clip, coded with the same code by each of `coders`."""
        seg = Segment(observation_id=obs_id, sequence_order=0, text="clip",
                      start_time=0.0, end_time=5.0)
        db.add(seg)
        db.flush()
        for uid in coders:
            db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=seg.id))
        db.flush()
        return seg

    def _setup(self, db):
        pid = _obs_project(db)
        second = self._two_coders(db)
        db.add(Code(id=950, project_id=pid, name="Study habits",
                    numeric_id=1, is_active=True, is_universal=False))
        db.flush()
        return pid, second

    def _consensus_rows(self, db, seg_id):
        return (
            db.query(CodeApplication)
            .filter(
                CodeApplication.segment_id == seg_id,
                CodeApplication.origin == "consensus",
            )
            .all()
        )

    def test_open_observation_gets_no_consensus(self, db_session):
        """Unfrozen = each coder cuts their own clips => not consensus-eligible."""
        db = db_session
        pid, second = self._setup(db)
        seg = self._clip_coded_by(db, pid, pid, [1, second.id], 950)

        materialize_consensus_for_project(db, pid)
        assert self._consensus_rows(db, seg.id) == []

    def test_frozen_observation_DOES_get_consensus(self, db_session):
        """THE D18 test. Freeze the cuts and the existing engine just works — the
        same clip, the same two coders, the same code, and now it reaches consensus
        exactly as a transcript turn would."""
        db = db_session
        pid, second = self._setup(db)
        seg = self._clip_coded_by(db, pid, pid, [1, second.id], 950)

        obs = db.query(Observation).filter(Observation.id == pid).one()
        obs.segmentation_frozen_at = datetime(2026, 7, 12, 12, 0, 0)
        db.flush()

        materialize_consensus_for_project(db, pid)
        rows = self._consensus_rows(db, seg.id)
        assert len(rows) == 1
        assert rows[0].code_id == 950
        assert json.loads(rows[0].origin_context)["rule"] == "unanimous"

    def test_unfreezing_lets_the_rebuild_reclaim_the_consensus_layer(self, db_session):
        """The orphan trap D2 was avoiding, closed properly.

        A consensus row must never outlive its eligibility. Because the exists-gate,
        the voter gather and the rebuild DELETE all share ONE scope definition,
        re-opening the cuts makes the next rebuild both stop producing the row AND
        able to SEE the old one in order to delete it. A rebuild that could write a
        row it can't later scope to would leave a permanent invisible orphan.
        """
        db = db_session
        pid, second = self._setup(db)
        seg = self._clip_coded_by(db, pid, pid, [1, second.id], 950)
        obs = db.query(Observation).filter(Observation.id == pid).one()

        obs.segmentation_frozen_at = datetime(2026, 7, 12, 12, 0, 0)
        db.flush()
        materialize_consensus_for_project(db, pid)
        assert len(self._consensus_rows(db, seg.id)) == 1

        obs.segmentation_frozen_at = None
        db.flush()
        materialize_consensus_for_project(db, pid)
        assert self._consensus_rows(db, seg.id) == [], (
            "re-opening the cuts must let the rebuild RECLAIM the now-ineligible "
            "consensus row — not strand it forever"
        )

    def test_mark_stale_enqueues_frozen_clips_and_skips_open_ones(self, db_session):
        db = db_session
        pid, second = self._setup(db)
        seg = self._clip_coded_by(db, pid, pid, [1, second.id], 950)

        # Open → the marker is not worth enqueueing (one voter per clip).
        assert mark_consensus_stale(db, pid, segment_ids=[seg.id]) == 0

        obs = db.query(Observation).filter(Observation.id == pid).one()
        obs.segmentation_frozen_at = datetime(2026, 7, 12, 12, 0, 0)
        db.flush()
        assert mark_consensus_stale(db, pid, segment_ids=[seg.id]) == 1

    def test_conversation_segments_are_unaffected(self, db_session):
        """Regression: widening the scope to a third parent must not change the
        conv/doc path — every shipped project depends on it."""
        db = db_session
        pid, second = self._setup(db)
        conv = Conversation(project_id=pid, name="Interview")
        db.add(conv)
        db.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=0, text="turn")
        db.add(seg)
        db.flush()
        for uid in (1, second.id):
            db.add(CodeApplication(code_id=950, user_id=uid, segment_id=seg.id))
        db.flush()

        materialize_consensus_for_project(db, pid)
        assert len(self._consensus_rows(db, seg.id)) == 1
