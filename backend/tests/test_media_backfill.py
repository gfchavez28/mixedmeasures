"""#574 — the startup backfill of `media_duration_seconds`.

Called directly with a session (the `repair_reverse_recode_mappings` pattern)
rather than by booting the app, so the arms stay readable.
"""

import struct

import pytest

from app.models.conversation import Conversation
from app.models.observation import Observation
from app.models.project import Project
from app.services import media_storage
from app.services.media_backfill import backfill_media_durations

from tests.test_media import _ftyp, _moov_with_duration, _webm_bytes


@pytest.fixture
def backfill_ctx(db_session, tmp_path, monkeypatch):
    """A project plus a media dir the storage helper actually resolves to."""
    monkeypatch.setattr(media_storage, "get_media_dir", lambda: tmp_path)
    project = Project(name="Backfill", user_id=1)
    db_session.add(project)
    db_session.flush()
    return db_session, project, tmp_path


def _write_media(tmp_path, project_id, kind, owner_id, fmt, payload):
    directory = media_storage.media_owner_dir(project_id, kind, owner_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"original.{fmt}"
    path.write_bytes(payload)
    return path


def _conversation(db, project, fmt, duration=None):
    conv = Conversation(
        project_id=project.id,
        name="C",
        media_filename=f"c.{fmt}",
        media_format=fmt,
        media_type="video",
        media_duration_seconds=duration,
    )
    db.add(conv)
    db.flush()
    return conv


def _observation(db, project, fmt, duration=None):
    obs = Observation(
        project_id=project.id,
        name="O",
        media_filename=f"o.{fmt}",
        media_format=fmt,
        media_type="video",
        media_duration_seconds=duration,
    )
    db.add(obs)
    db.flush()
    return obs


class TestMediaDurationBackfill:
    def test_fills_a_null_mov_duration(self, backfill_ctx):
        """The population #574 exists for: .mov attached before `4f61ac0`."""
        db, project, tmp_path = backfill_ctx
        conv = _conversation(db, project, "mov")
        _write_media(
            tmp_path, project.id, "conversation", conv.id, "mov",
            _ftyp(b"qt  ") + _moov_with_duration(600, 9000),
        )

        counts = backfill_media_durations(db)

        assert conv.media_duration_seconds == pytest.approx(15.0)
        assert counts["filled"] == 1

    def test_fills_a_null_webm_duration(self, backfill_ctx):
        """Only reachable because #573 landed first — before it, the probe
        returned None for webm without even opening the file, so the backfill
        could not have repaired a single one."""
        db, project, tmp_path = backfill_ctx
        obs = _observation(db, project, "webm")
        _write_media(
            tmp_path, project.id, "observation", obs.id, "webm",
            _webm_bytes(duration=12000.0),
        )

        backfill_media_durations(db)

        assert obs.media_duration_seconds == pytest.approx(12.0)

    def test_covers_both_owner_kinds_in_one_pass(self, backfill_ctx):
        db, project, tmp_path = backfill_ctx
        conv = _conversation(db, project, "mov")
        obs = _observation(db, project, "mov")
        payload = _ftyp(b"qt  ") + _moov_with_duration(1000, 30000)
        _write_media(tmp_path, project.id, "conversation", conv.id, "mov", payload)
        _write_media(tmp_path, project.id, "observation", obs.id, "mov", payload)

        counts = backfill_media_durations(db)

        assert counts["filled"] == 2
        assert conv.media_duration_seconds == pytest.approx(30.0)
        assert obs.media_duration_seconds == pytest.approx(30.0)

    def test_never_overwrites_an_existing_duration(self, backfill_ctx):
        """D40. There is NO provenance marker on this column, so a stored value
        may be a browser measurement — often better than a container probe. The
        file here declares 15s while the row says 42s; the row must win.
        """
        db, project, tmp_path = backfill_ctx
        conv = _conversation(db, project, "mov", duration=42.0)
        _write_media(
            tmp_path, project.id, "conversation", conv.id, "mov",
            _ftyp(b"qt  ") + _moov_with_duration(600, 9000),
        )

        counts = backfill_media_durations(db)

        assert conv.media_duration_seconds == pytest.approx(42.0)
        assert counts["filled"] == 0

    def test_skips_a_row_whose_file_is_gone(self, backfill_ctx):
        """A normal state (#551), not an error: media-excluded backups make it."""
        db, project, tmp_path = backfill_ctx
        conv = _conversation(db, project, "mov")

        counts = backfill_media_durations(db)

        assert conv.media_duration_seconds is None
        assert counts["missing_file"] == 1

    def test_skips_a_container_that_carries_no_duration(self, backfill_ctx):
        """The live-muxed WebM shape — re-probed every boot, deliberately."""
        db, project, tmp_path = backfill_ctx
        obs = _observation(db, project, "webm")
        _write_media(
            tmp_path, project.id, "observation", obs.id, "webm",
            _webm_bytes(duration=None),
        )

        counts = backfill_media_durations(db)

        assert obs.media_duration_seconds is None
        assert counts["unreadable"] == 1

    def test_leaves_rows_without_media_alone(self, backfill_ctx):
        db, project, tmp_path = backfill_ctx
        conv = Conversation(project_id=project.id, name="No media")
        db.add(conv)
        db.flush()

        counts = backfill_media_durations(db)

        assert counts == {"filled": 0, "missing_file": 0, "unreadable": 0}

    def test_is_idempotent(self, backfill_ctx):
        """Runs on EVERY boot, so a second pass must find nothing to do."""
        db, project, tmp_path = backfill_ctx
        conv = _conversation(db, project, "mov")
        _write_media(
            tmp_path, project.id, "conversation", conv.id, "mov",
            _ftyp(b"qt  ") + _moov_with_duration(600, 9000),
        )

        first = backfill_media_durations(db)
        second = backfill_media_durations(db)

        assert first["filled"] == 1
        assert second["filled"] == 0
        assert conv.media_duration_seconds == pytest.approx(15.0)

    def test_a_corrupt_file_never_raises(self, backfill_ctx):
        db, project, tmp_path = backfill_ctx
        obs = _observation(db, project, "webm")
        _write_media(
            tmp_path, project.id, "observation", obs.id, "webm",
            b"\x1a\x45\xdf\xa3" + b"\xff" * 64,
        )

        counts = backfill_media_durations(db)

        assert obs.media_duration_seconds is None
        assert counts["unreadable"] == 1

    def test_a_non_finite_duration_is_never_written(self, backfill_ctx):
        """The backfill inherits `sane_duration`, so the D39 hazard cannot enter
        the DB through this path either — inf would otherwise pass `cut_clips`'
        `<= 0` guard and 500 the JSON response.
        """
        db, project, tmp_path = backfill_ctx
        obs = _observation(db, project, "webm")
        _write_media(
            tmp_path, project.id, "observation", obs.id, "webm",
            _webm_bytes(duration=float("inf")),
        )

        backfill_media_durations(db)

        assert obs.media_duration_seconds is None
