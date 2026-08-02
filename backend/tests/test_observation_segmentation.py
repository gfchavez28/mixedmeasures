"""Cutting an observation's timeline into clips (slab 2a).

The invariant these pin: preview and cut are the SAME function reading the SAME
persisted duration, so the clip count the wizard promised is the clip count that
lands. And a mode the user actively CHOSE never silently yields zero clips —
"you asked for intervals and got nothing" is the failure we refuse to ship.
"""
import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

from app.models import Observation, Project, Segment, User
from app.routers.observations import cut_segmentation, preview_segmentation
from app.services.observation_segmentation import (
    MAX_CLIPS,
    ClipSpec,
    SegmentationError,
    _order_clips,
    cut_clips,
    looks_like_a_transcript,
)
from app.services.subtitle_import import DEFAULT_SPEAKER, parse_cue_bytes


def _run(coro):
    return asyncio.run(coro)


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


def _observation(db, *, duration=None, frozen_at=None, pid=800):
    if not db.query(Project).filter(Project.id == pid).first():
        db.add(Project(id=pid, name="P", user_id=1))
        db.flush()
    obs = Observation(
        project_id=pid,
        name="Classroom Obs",
        media_filename="v.mp4",
        media_format="mp4",
        media_type="video",
        media_duration_seconds=duration,
        segmentation_frozen_at=frozen_at,
    )
    db.add(obs)
    db.flush()
    return obs


def _cue_upload(text: str, name: str = "cues.vtt") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(text.encode("utf-8")))


VTT = """WEBVTT

00:00:00.000 --> 00:00:10.000
Children enter

00:00:12.000 --> 00:00:20.000
Circle time begins
"""


# ── The pure cutter ────────────────────────────────────────────────────────


class TestFixedInterval:
    def test_keeps_the_partial_tail(self):
        r = cut_clips("fixed_interval", duration_seconds=100, interval_seconds=30)
        assert [(c.start_time, c.end_time) for c in r.clips] == [
            (0, 30), (30, 60), (60, 90), (90, 100),
        ]

    def test_exact_division_leaves_no_zero_width_sliver(self):
        r = cut_clips("fixed_interval", duration_seconds=120, interval_seconds=30)
        assert r.total == 4
        assert all(c.end_time > c.start_time for c in r.clips)

    def test_boundaries_do_not_drift(self):
        """Multiply, never accumulate — `t += interval` drifts over 1000s of steps."""
        r = cut_clips("fixed_interval", duration_seconds=1000, interval_seconds=0.1 * 10)
        assert r.clips[-1].end_time == pytest.approx(1000.0)
        assert r.clips[500].start_time == pytest.approx(500.0)

    def test_unknown_duration_refuses_instead_of_cutting_nothing(self):
        with pytest.raises(SegmentationError, match="couldn't read how long"):
            cut_clips("fixed_interval", duration_seconds=None, interval_seconds=30)

    def test_zero_interval_refuses_rather_than_looping_forever(self):
        with pytest.raises(SegmentationError, match="at least"):
            cut_clips("fixed_interval", duration_seconds=100, interval_seconds=0)

    def test_clip_cap(self):
        # 3 hours at 1s = 10,800 clips.
        with pytest.raises(SegmentationError, match="over the"):
            cut_clips("fixed_interval", duration_seconds=3 * 60 * 60, interval_seconds=1)

    def test_just_under_the_cap_is_allowed(self):
        r = cut_clips("fixed_interval", duration_seconds=MAX_CLIPS, interval_seconds=1)
        assert r.total == MAX_CLIPS


class TestCueList:
    def test_cue_in_out_becomes_a_clip_and_text_becomes_the_label(self):
        cues = parse_cue_bytes(VTT.encode("utf-8"))
        r = cut_clips("cue_list", duration_seconds=60, cues=cues)
        assert [(c.start_time, c.end_time, c.label) for c in r.clips] == [
            (0.0, 10.0, "Children enter"),
            (12.0, 20.0, "Circle time begins"),
        ]

    def test_reversed_cue_is_skipped_with_a_warning(self):
        cues = [
            {"speaker": DEFAULT_SPEAKER, "text": "backwards", "start": 10.0, "end": 5.0},
            {"speaker": DEFAULT_SPEAKER, "text": "fine", "start": 0.0, "end": 5.0},
        ]
        r = cut_clips("cue_list", duration_seconds=60, cues=cues)
        assert r.total == 1
        assert any("end time came before" in w for w in r.warnings)

    def test_cue_past_the_recording_is_kept_and_reported_never_clamped(self):
        """The cue file and the recording are independent artifacts."""
        cues = [{"speaker": DEFAULT_SPEAKER, "text": "late", "start": 90.0, "end": 95.0}]
        r = cut_clips("cue_list", duration_seconds=60, cues=cues)
        assert r.total == 1
        assert r.clips[0].end_time == 95.0  # not clamped to 60
        assert any("after the recording ends" in w for w in r.warnings)

    def test_empty_cue_file_refuses(self):
        with pytest.raises(SegmentationError, match="No cues"):
            cut_clips("cue_list", duration_seconds=60, cues=[])

    def test_cue_list_works_with_no_duration(self):
        """Unlike intervals, cues carry their own times — no duration needed."""
        cues = parse_cue_bytes(VTT.encode("utf-8"))
        r = cut_clips("cue_list", duration_seconds=None, cues=cues)
        assert r.total == 2

    def test_transcript_detection(self):
        dialogue = [{"speaker": "Ms. Rivera", "text": "Good morning", "start": 0, "end": 2}]
        plain = [{"speaker": DEFAULT_SPEAKER, "text": "bell rings", "start": 0, "end": 2}]
        assert looks_like_a_transcript(dialogue, DEFAULT_SPEAKER) is True
        assert looks_like_a_transcript(plain, DEFAULT_SPEAKER) is False


class TestOrdering:
    def test_overlapping_clips_get_a_deterministic_order(self):
        """Overlap has no natural total order — (start, end, index) pins one."""
        clips = [
            ClipSpec(10.0, 20.0, "b"),
            ClipSpec(5.0, 30.0, "a"),
            ClipSpec(10.0, 15.0, "c"),
        ]
        ordered = _order_clips(clips)
        assert [c.label for c in ordered] == ["a", "c", "b"]

    def test_identical_ranges_keep_source_order(self):
        clips = [ClipSpec(1.0, 2.0, "first"), ClipSpec(1.0, 2.0, "second")]
        assert [c.label for c in _order_clips(clips)] == ["first", "second"]


class TestModes:
    def test_none_writes_nothing(self):
        assert cut_clips("none").total == 0

    def test_unknown_mode(self):
        with pytest.raises(SegmentationError, match="Unknown segmentation mode"):
            cut_clips("interpretive_dance")


# ── The endpoints ──────────────────────────────────────────────────────────


class TestCutEndpoint:
    def test_cut_writes_clips_and_preview_agrees(self, db_session):
        db = db_session
        obs = _observation(db, duration=100)
        u = _user(db)

        preview = _run(preview_segmentation(
            obs.project_id, obs.id, mode="fixed_interval", interval_seconds=30,
            cue_file=None, user=u, db=db,
        ))
        result = _run(cut_segmentation(
            obs.project_id, obs.id, mode="fixed_interval", interval_seconds=30,
            cue_file=None, user=u, db=db,
        ))

        # The promise: what you saw is what you got.
        assert preview.total_segments == result.created == 4

        rows = db.query(Segment).filter(Segment.observation_id == obs.id).order_by(
            Segment.sequence_order
        ).all()
        assert [(r.start_time, r.end_time) for r in rows] == [
            (0, 30), (30, 60), (60, 90), (90, 100),
        ]
        assert [r.sequence_order for r in rows] == [0, 1, 2, 3]
        # NOT NULL; '' is the legal unlabelled clip.
        assert all(r.text == "" for r in rows)
        # Exactly one parent.
        assert all(r.conversation_id is None and r.document_id is None for r in rows)

    def test_preview_truncates_but_reports_the_true_total(self, db_session):
        db = db_session
        obs = _observation(db, duration=1000)
        preview = _run(preview_segmentation(
            obs.project_id, obs.id, mode="fixed_interval", interval_seconds=1,
            cue_file=None, user=_user(db), db=db,
        ))
        assert preview.total_segments == 1000
        assert len(preview.segments) == 20

    def test_cut_refuses_to_duplicate_an_existing_clip_set(self, db_session):
        """A network retry must not silently double the clips."""
        db = db_session
        obs = _observation(db, duration=100)
        u = _user(db)
        _run(cut_segmentation(
            obs.project_id, obs.id, mode="fixed_interval", interval_seconds=30,
            cue_file=None, user=u, db=db,
        ))
        with pytest.raises(HTTPException) as e:
            _run(cut_segmentation(
                obs.project_id, obs.id, mode="fixed_interval", interval_seconds=30,
                cue_file=None, user=u, db=db,
            ))
        assert e.value.status_code == 409
        assert db.query(Segment).filter(Segment.observation_id == obs.id).count() == 4

    def test_cut_refuses_while_frozen(self, db_session):
        from datetime import datetime
        db = db_session
        obs = _observation(db, duration=100, frozen_at=datetime(2026, 7, 12))
        with pytest.raises(HTTPException) as e:
            _run(cut_segmentation(
                obs.project_id, obs.id, mode="fixed_interval", interval_seconds=30,
                cue_file=None, user=_user(db), db=db,
            ))
        assert e.value.status_code == 409
        assert "frozen" in e.value.detail

    def test_interval_on_a_duration_less_recording_is_an_honest_400(self, db_session):
        db = db_session
        obs = _observation(db, duration=None)  # the WebM case
        with pytest.raises(HTTPException) as e:
            _run(cut_segmentation(
                obs.project_id, obs.id, mode="fixed_interval", interval_seconds=30,
                cue_file=None, user=_user(db), db=db,
            ))
        assert e.value.status_code == 400
        assert "Start empty" in e.value.detail
        assert db.query(Segment).filter(Segment.observation_id == obs.id).count() == 0

    def test_cue_list_cut_labels_the_clips(self, db_session):
        db = db_session
        obs = _observation(db, duration=60)
        result = _run(cut_segmentation(
            obs.project_id, obs.id, mode="cue_list", interval_seconds=None,
            cue_file=_cue_upload(VTT), user=_user(db), db=db,
        ))
        assert result.created == 2
        rows = db.query(Segment).filter(Segment.observation_id == obs.id).order_by(
            Segment.sequence_order
        ).all()
        assert [r.text for r in rows] == ["Children enter", "Circle time begins"]

    def test_dialogue_cue_file_warns_it_belongs_in_a_conversation(self, db_session):
        db = db_session
        obs = _observation(db, duration=60)
        # The real Zoom/Teams shape: "Firstname Lastname: text". (The parser's
        # name regex excludes '.', so an honorific like "Ms. Rivera:" is NOT read
        # as a speaker — a pre-existing limitation, deliberately not fixed here.)
        dialogue = "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nElena Rivera: Good morning\n"
        preview = _run(preview_segmentation(
            obs.project_id, obs.id, mode="cue_list", interval_seconds=None,
            cue_file=_cue_upload(dialogue), user=_user(db), db=db,
        ))
        assert any("import it as a Conversation" in w for w in preview.warnings)

    def test_cue_mode_without_a_file_is_a_400(self, db_session):
        db = db_session
        obs = _observation(db, duration=60)
        with pytest.raises(HTTPException) as e:
            _run(preview_segmentation(
                obs.project_id, obs.id, mode="cue_list", interval_seconds=None,
                cue_file=None, user=_user(db), db=db,
            ))
        assert e.value.status_code == 400

    def test_none_mode_leaves_the_observation_empty(self, db_session):
        """The primary path: an observation with a recording and no clips is legal."""
        db = db_session
        obs = _observation(db, duration=100)
        result = _run(cut_segmentation(
            obs.project_id, obs.id, mode="none", interval_seconds=None,
            cue_file=None, user=_user(db), db=db,
        ))
        assert result.created == 0
        assert db.query(Segment).filter(Segment.observation_id == obs.id).count() == 0
