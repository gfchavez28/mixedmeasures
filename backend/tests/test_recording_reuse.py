"""Re-using a recording across source types without a re-upload (D17, slab 2a).

The escape hatch for the one choice this tool cannot undo: a Conversation codes
what was SAID, an Observation codes what HAPPENED, and there is no conversion
between them. Discovering that after uploading 4 GB is a failure we can remove.

Two things these pin, both of which would be silent disasters:
  * it COPIES the file, never shares the path — deleting either source rmtrees
    its own media dir, so a shared file would vanish from under the survivor;
  * it carries the FILE, never the coding.
"""
import asyncio
import shutil
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models import (
    Code, CodeApplication, Conversation, Observation, Project, Segment, User,
)
from app.routers.media import reuse_observation_recording
from app.routers.observations import reuse_conversation_recording
from app.services import media_storage


def _run(coro):
    return asyncio.run(coro)


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


@pytest.fixture
def media_root(tmp_path, monkeypatch):
    """Point media storage at a tmp dir (ONE binding — media_storage owns the path)."""
    root = tmp_path / "media"
    monkeypatch.setattr(media_storage, "get_media_dir", lambda: root)
    return root


def _project(db, pid=900):
    if not db.query(Project).filter(Project.id == pid).first():
        db.add(Project(id=pid, name="P", user_id=1))
        db.flush()
    return pid


def _conversation(db, pid, *, with_media=True):
    conv = Conversation(project_id=pid, name="Session 1")
    if with_media:
        conv.media_filename = "session.mp4"
        conv.media_format = "mp4"
        conv.media_type = "video"
        conv.media_duration_seconds = 90.5
        conv.media_is_vbr = False
        conv.media_offset_seconds = 12.0  # a transcript alignment offset
    db.add(conv)
    db.flush()
    return conv


def _observation(db, pid, *, frozen_at=None):
    obs = Observation(project_id=pid, name="Obs 1", segmentation_frozen_at=frozen_at)
    db.add(obs)
    db.flush()
    return obs


def _write_recording(root: Path, pid: int, kind: str, owner_id: int, payload: bytes):
    d = root / str(pid) / media_storage.media_owner_segment(kind, owner_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "original.mp4").write_bytes(payload)
    return d


class TestConversationToObservation:
    def test_copies_the_file_and_the_media_columns(self, db_session, media_root):
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)
        obs = _observation(db, pid)
        _write_recording(media_root, pid, media_storage.CONVERSATION, conv.id, b"VIDEOBYTES")

        _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))

        dest = (
            media_root / str(pid)
            / media_storage.media_owner_segment(media_storage.OBSERVATION, obs.id)
            / "original.mp4"
        )
        assert dest.read_bytes() == b"VIDEOBYTES"
        assert obs.media_filename == "session.mp4"
        assert obs.media_format == "mp4"
        assert obs.media_duration_seconds == 90.5

    def test_the_offset_is_never_inherited(self, db_session, media_root):
        """A conversation's offset aligns its TRANSCRIPT. On a timeline it would
        shear every clip against the recording."""
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)
        obs = _observation(db, pid)
        _write_recording(media_root, pid, media_storage.CONVERSATION, conv.id, b"X")

        _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))
        assert conv.media_offset_seconds == 12.0
        assert obs.media_offset_seconds == 0.0

    def test_it_is_a_real_second_file_not_a_shared_path(self, db_session, media_root):
        """THE trap: delete_* rmtrees the owner's dir. A shared path would delete
        the recording out from under the surviving source."""
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)
        obs = _observation(db, pid)
        conv_dir = _write_recording(
            media_root, pid, media_storage.CONVERSATION, conv.id, b"VIDEOBYTES"
        )

        _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))

        # The conversation is deleted — its media dir goes with it.
        shutil.rmtree(conv_dir)

        obs_file = (
            media_root / str(pid)
            / media_storage.media_owner_segment(media_storage.OBSERVATION, obs.id)
            / "original.mp4"
        )
        assert obs_file.exists(), "the observation's recording must survive"
        assert obs_file.read_bytes() == b"VIDEOBYTES"

    def test_carries_no_codes(self, db_session, media_root):
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)
        obs = _observation(db, pid)
        _write_recording(media_root, pid, media_storage.CONVERSATION, conv.id, b"X")

        code = Code(project_id=pid, name="Turn-taking", numeric_id=1)
        db.add(code)
        seg = Segment(conversation_id=conv.id, sequence_order=0, text="hello")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1))
        db.flush()

        _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))

        clips = db.query(Segment).filter(Segment.observation_id == obs.id).count()
        assert clips == 0, "the hatch re-uses the FILE, never the coding"

    def test_source_without_a_recording_is_a_409(self, db_session, media_root):
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid, with_media=False)
        obs = _observation(db, pid)
        with pytest.raises(HTTPException) as e:
            _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))
        assert e.value.status_code == 409

    def test_missing_file_on_disk_is_a_409_not_a_crash(self, db_session, media_root):
        """The row claims a recording the disk doesn't have (#551)."""
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)  # media columns set, no file written
        obs = _observation(db, pid)
        with pytest.raises(HTTPException) as e:
            _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))
        assert e.value.status_code == 409
        assert "missing from disk" in e.value.detail

    def test_refuses_while_the_clips_are_frozen(self, db_session, media_root):
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)
        obs = _observation(db, pid, frozen_at=datetime(2026, 7, 12))
        _write_recording(media_root, pid, media_storage.CONVERSATION, conv.id, b"X")
        with pytest.raises(HTTPException) as e:
            _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))
        assert e.value.status_code == 409

    def test_out_of_disk_surfaces_as_507(self, db_session, media_root):
        db = db_session
        pid = _project(db)
        conv = _conversation(db, pid)
        obs = _observation(db, pid)
        _write_recording(media_root, pid, media_storage.CONVERSATION, conv.id, b"X")

        import errno as _errno

        def _boom(*a, **k):
            raise OSError(_errno.ENOSPC, "No space left on device")

        with patch("app.routers.media.shutil.copyfileobj", _boom):
            with pytest.raises(HTTPException) as e:
                _run(reuse_conversation_recording(pid, obs.id, conv.id, user=_user(db), db=db))
        assert e.value.status_code == 507

        # And no truncated original.* is left behind to stat as a real recording.
        obs_dir = (
            media_root / str(pid)
            / media_storage.media_owner_segment(media_storage.OBSERVATION, obs.id)
        )
        assert not list(obs_dir.glob("original.*"))
        assert not list(obs_dir.glob(".copy-*"))


class TestCrossTenantGate:
    def test_cannot_name_a_conversation_from_another_project(self, db_session, media_root):
        """The gate the AST sweep structurally CANNOT catch.

        The sweep passes an endpoint the moment it sees any gate token, so gating
        only the project would have let a caller name a conversation living
        somewhere else and copy its recording into a project they own — where the
        stream endpoint would then serve it straight back to them.
        """
        db = db_session
        mine = _project(db, pid=901)
        theirs = _project(db, pid=902)
        their_conv = _conversation(db, theirs)
        _write_recording(
            media_root, theirs, media_storage.CONVERSATION, their_conv.id, b"THEIRVIDEO"
        )
        my_obs = _observation(db, mine)

        with pytest.raises(HTTPException) as e:
            _run(reuse_conversation_recording(
                mine, my_obs.id, their_conv.id, user=_user(db), db=db,
            ))
        assert e.value.status_code == 404
        assert my_obs.media_filename is None


class TestObservationToConversation:
    def test_reverse_direction_attaches_without_reupload(self, db_session, media_root):
        db = db_session
        pid = _project(db)
        obs = _observation(db, pid)
        obs.media_filename = "obs.mp4"
        obs.media_format = "mp4"
        obs.media_type = "video"
        obs.media_duration_seconds = 42.0
        db.flush()
        _write_recording(media_root, pid, media_storage.OBSERVATION, obs.id, b"OBSVIDEO")

        conv = _conversation(db, pid, with_media=False)
        _run(reuse_observation_recording(pid, conv.id, obs.id, user=_user(db), db=db))

        dest = (
            media_root / str(pid)
            / media_storage.media_owner_segment(media_storage.CONVERSATION, conv.id)
            / "original.mp4"
        )
        assert dest.read_bytes() == b"OBSVIDEO"
        assert conv.media_filename == "obs.mp4"
        assert conv.media_duration_seconds == 42.0
