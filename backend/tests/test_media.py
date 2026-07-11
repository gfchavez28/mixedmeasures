"""Tests for media (audio/video) upload, stream, delete, offset, and
integration with backup/portability. Uses in-memory SQLite (conftest safety
guard) with tmp_path for file storage.
"""

import asyncio
import errno
import io
import os
import shutil
import struct
import wave
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.database import Base
from app.models.conversation import Conversation, ConversationStatus
from app.models.project import Project
from app.models.user import User
from app.routers.media import (
    MAX_MEDIA_SIZE,
    VIDEO_FORMATS,
    _detect_format,
    _detect_vbr,
    _extract_duration,
    _media_dir,
    _refine_mp4_family,
    _stream_upload_to_temp,
)
from app.services.backup import create_backup, restore_from_backup


REFERENCE_DIR = Path(__file__).parent / "reference_data"


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def audio_session(tmp_path):
    """Per-test session with a project and conversation ready for audio tests."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)
    db = TestSession()

    test_user = User(id=1, username="testuser", password_hash="x", is_admin=True)
    db.add(test_user)
    db.flush()

    project = Project(name="Audio Test Project", user_id=1)
    db.add(project)
    db.flush()

    conversation = Conversation(
        project_id=project.id,
        name="Interview 1",
        status=ConversationStatus.IMPORTED,
    )
    db.add(conversation)
    db.flush()

    yield db, project, conversation, tmp_path

    db.rollback()
    db.close()


def _make_wav(path: Path, duration_sec: float = 0.1, sample_rate: int = 44100) -> Path:
    """Generate a tiny WAV file with silence."""
    n_frames = int(sample_rate * duration_sec)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_frames)
    return path


def _read_fixture(name: str) -> bytes:
    return (REFERENCE_DIR / name).read_bytes()


# ── Format detection ─────────────────────────────────────────────────────


class TestFormatDetection:
    def test_detect_mp3_id3(self):
        header = b"ID3" + b"\x00" * 9
        assert _detect_format(header) == "mp3"

    def test_detect_mp3_sync_word(self):
        header = bytes([0xFF, 0xFB, 0x90, 0x04]) + b"\x00" * 8
        assert _detect_format(header) == "mp3"

    def test_detect_m4a(self):
        header = b"\x00\x00\x00\x20ftyp" + b"M4A "
        assert _detect_format(header) == "m4a"

    def test_detect_wav(self):
        header = b"RIFF" + b"\x00\x00\x00\x00" + b"WAVE"
        assert _detect_format(header) == "wav"

    def test_detect_unsupported(self):
        header = b"unsupported!" * 2
        assert _detect_format(header[:12]) is None

    def test_detect_too_short(self):
        assert _detect_format(b"abc") is None

    def test_content_based_not_extension(self):
        """MP3 file with .wav extension detected as mp3 by content."""
        mp3_bytes = _read_fixture("test_audio.mp3")
        assert _detect_format(mp3_bytes[:12]) == "mp3"


# ── Duration extraction ──────────────────────────────────────────────────


class TestDurationExtraction:
    def test_mp3_duration(self):
        path = REFERENCE_DIR / "test_audio.mp3"
        duration = _extract_duration(path, "mp3")
        assert duration is not None
        assert duration > 0

    def test_m4a_duration(self):
        path = REFERENCE_DIR / "test_audio.m4a"
        duration = _extract_duration(path, "m4a")
        assert duration is not None
        assert duration > 0

    def test_wav_duration(self, tmp_path):
        wav_path = _make_wav(tmp_path / "test.wav", duration_sec=0.5)
        duration = _extract_duration(wav_path, "wav")
        assert duration is not None
        assert abs(duration - 0.5) < 0.01

    def test_duration_extraction_failure(self, tmp_path):
        """Corrupted file returns None duration."""
        bad = tmp_path / "bad.mp3"
        bad.write_bytes(b"\xff\xfb\x90\x04" + b"\x00" * 10)
        duration = _extract_duration(bad, "mp3")
        # May return None or a value — just shouldn't raise
        # (mutagen may parse even a partial frame)


# ── VBR detection ─────────────────────────────────────────────────────────


class TestVBRDetection:
    def test_non_mp3_returns_none(self, tmp_path):
        wav_path = _make_wav(tmp_path / "test.wav")
        assert _detect_vbr(wav_path, "wav") is None

    def test_mp3_vbr_detection(self):
        path = REFERENCE_DIR / "test_audio.mp3"
        result = _detect_vbr(path, "mp3")
        # Our fixture is CBR, so should be False
        assert result is not None
        assert isinstance(result, bool)


# ── Upload / delete / offset (service-level) ─────────────────────────────


class TestAudioCRUD:
    def test_upload_mp3(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        mp3_bytes = _read_fixture("test_audio.mp3")

        # Simulate upload
        fmt = _detect_format(mp3_bytes[:12])
        assert fmt == "mp3"

        media_path = tmp_path / "media" / str(project.id) / str(conv.id)
        media_path.mkdir(parents=True)
        dest = media_path / f"original.{fmt}"
        dest.write_bytes(mp3_bytes)

        duration = _extract_duration(dest, fmt)
        is_vbr = _detect_vbr(dest, fmt)

        conv.media_filename = "interview.mp3"
        conv.media_format = fmt
        conv.media_type = "audio"
        conv.media_duration_seconds = duration
        conv.media_offset_seconds = 0.0
        conv.media_is_vbr = is_vbr
        db.flush()

        assert conv.media_type == "audio"
        assert conv.media_format == "mp3"
        assert conv.media_duration_seconds is not None
        assert conv.media_duration_seconds > 0
        assert dest.exists()

    def test_upload_m4a(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        m4a_bytes = _read_fixture("test_audio.m4a")

        fmt = _detect_format(m4a_bytes[:12])
        assert fmt == "m4a"

        media_path = tmp_path / "media" / str(project.id) / str(conv.id)
        media_path.mkdir(parents=True)
        dest = media_path / f"original.{fmt}"
        dest.write_bytes(m4a_bytes)

        duration = _extract_duration(dest, fmt)
        conv.media_filename = "interview.m4a"
        conv.media_format = fmt
        conv.media_type = "audio"
        conv.media_duration_seconds = duration
        db.flush()

        assert conv.media_format == "m4a"
        assert conv.media_duration_seconds is not None

    def test_upload_wav(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        media_path = tmp_path / "media" / str(project.id) / str(conv.id)
        media_path.mkdir(parents=True)
        wav_path = _make_wav(media_path / "original.wav", duration_sec=0.2)

        duration = _extract_duration(wav_path, "wav")
        conv.media_filename = "interview.wav"
        conv.media_format = "wav"
        conv.media_type = "audio"
        conv.media_duration_seconds = duration
        db.flush()

        assert conv.media_format == "wav"
        assert abs(conv.media_duration_seconds - 0.2) < 0.01

    def test_upload_invalid_format(self):
        """Non-audio file should not be detected as valid format."""
        txt_bytes = b"This is a text file, not audio." + b"\x00" * 12
        fmt = _detect_format(txt_bytes[:12])
        assert fmt is None

    def test_disk_full_returns_507(self, tmp_path, monkeypatch):
        """A write that ENOSPCs mid-upload surfaces as 507 (not a generic 500)
        and cleans up its temp file."""
        from app.routers import media as media_module

        # Minimal async UploadFile stand-in — _stream_upload_to_temp only reads.
        class _FakeUpload:
            def __init__(self, data):
                self._data, self._pos = data, 0

            async def read(self, n=-1):
                if self._pos >= len(self._data):
                    return b""
                chunk = self._data[self._pos:self._pos + n] if n and n > 0 else self._data[self._pos:]
                self._pos += len(chunk)
                return chunk

        # Valid ftyp header → format detection passes; then the write fails.
        upload = _FakeUpload(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)

        class _NoSpaceFile:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def write(self, _data):
                raise OSError(errno.ENOSPC, "No space left on device")

        def fake_fdopen(fd, _mode):
            os.close(fd)  # release the real fd from mkstemp
            return _NoSpaceFile()

        monkeypatch.setattr(media_module.os, "fdopen", fake_fdopen)

        parent = tmp_path / "media"
        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(_stream_upload_to_temp(upload, parent, MAX_MEDIA_SIZE))
        assert excinfo.value.status_code == 507
        assert "disk space" in excinfo.value.detail.lower()
        # temp file removed on failure
        assert not list(parent.glob(".upload-*.part"))

    def test_replace_existing_audio(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        media_path = tmp_path / "media" / str(project.id) / str(conv.id)
        media_path.mkdir(parents=True)

        # Upload first file (MP3)
        mp3_bytes = _read_fixture("test_audio.mp3")
        (media_path / "original.mp3").write_bytes(mp3_bytes)
        conv.media_filename = "first.mp3"
        conv.media_format = "mp3"
        conv.media_type = "audio"
        db.flush()

        assert (media_path / "original.mp3").exists()

        # Replace with WAV
        shutil.rmtree(str(media_path))
        media_path.mkdir(parents=True)
        _make_wav(media_path / "original.wav")
        conv.media_filename = "second.wav"
        conv.media_format = "wav"
        db.flush()

        assert not (media_path / "original.mp3").exists()
        assert (media_path / "original.wav").exists()
        assert conv.media_filename == "second.wav"

    def test_delete_audio(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        media_path = tmp_path / "media" / str(project.id) / str(conv.id)
        media_path.mkdir(parents=True)
        (media_path / "original.mp3").write_bytes(_read_fixture("test_audio.mp3"))

        conv.media_filename = "interview.mp3"
        conv.media_format = "mp3"
        conv.media_type = "audio"
        conv.media_duration_seconds = 0.13
        conv.media_offset_seconds = 2.5
        conv.media_is_vbr = False
        db.flush()

        # Delete
        shutil.rmtree(str(media_path))
        conv.media_filename = None
        conv.media_format = None
        conv.media_type = None
        conv.media_duration_seconds = None
        conv.media_offset_seconds = 0.0
        conv.media_is_vbr = None
        db.flush()

        assert not media_path.exists()
        assert conv.media_filename is None
        assert conv.media_offset_seconds == 0.0

    def test_update_offset(self, audio_session):
        db, project, conv, _ = audio_session

        conv.media_filename = "interview.mp3"
        conv.media_format = "mp3"
        conv.media_type = "audio"
        conv.media_offset_seconds = 0.0
        db.flush()

        conv.media_offset_seconds = 3.5
        db.flush()
        assert conv.media_offset_seconds == 3.5

        conv.media_offset_seconds = -2.1
        db.flush()
        assert conv.media_offset_seconds == -2.1

    def test_offset_bounds_schema(self):
        """MediaOffsetUpdate validates ±300 bounds."""
        from app.schemas.conversation import MediaOffsetUpdate
        from pydantic import ValidationError

        MediaOffsetUpdate(offset_seconds=300.0)
        MediaOffsetUpdate(offset_seconds=-300.0)
        MediaOffsetUpdate(offset_seconds=0.0)

        with pytest.raises(ValidationError):
            MediaOffsetUpdate(offset_seconds=301.0)
        with pytest.raises(ValidationError):
            MediaOffsetUpdate(offset_seconds=-301.0)


# ── Cleanup on delete ────────────────────────────────────────────────────


class TestCleanup:
    def test_conversation_delete_cleans_media(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        media_path = tmp_path / "media" / str(project.id) / str(conv.id)
        media_path.mkdir(parents=True)
        (media_path / "original.mp3").write_bytes(_read_fixture("test_audio.mp3"))

        assert media_path.exists()

        # Simulate conversation delete cleanup
        shutil.rmtree(str(media_path))
        db.delete(conv)
        db.flush()

        assert not media_path.exists()

    def test_project_delete_cleans_media(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        project_media_dir = tmp_path / "media" / str(project.id)
        conv_media_dir = project_media_dir / str(conv.id)
        conv_media_dir.mkdir(parents=True)
        (conv_media_dir / "original.mp3").write_bytes(_read_fixture("test_audio.mp3"))

        assert project_media_dir.exists()

        # Simulate project delete cleanup
        shutil.rmtree(str(project_media_dir))
        assert not project_media_dir.exists()


# ── Backup integration ───────────────────────────────────────────────────


class TestBackupWithMedia:
    def test_backup_includes_media(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        # Set up file structure
        db_path = tmp_path / "database.db"
        docs_dir = tmp_path / "documents"
        media_dir = tmp_path / "media"
        backup_dir = tmp_path / "backups"
        docs_dir.mkdir()
        backup_dir.mkdir()

        # Create a real SQLite DB file for backup
        from sqlalchemy import create_engine as ce
        eng = ce(f"sqlite:///{db_path}")
        Base.metadata.create_all(eng)
        eng.dispose()

        # Create media file
        conv_media = media_dir / str(project.id) / str(conv.id)
        conv_media.mkdir(parents=True)
        mp3_bytes = _read_fixture("test_audio.mp3")
        (conv_media / "original.mp3").write_bytes(mp3_bytes)

        info = create_backup(db_path, docs_dir, media_dir, backup_dir, "manual")
        backup_path = backup_dir / info.filename

        with zipfile.ZipFile(str(backup_path), "r") as zf:
            names = zf.namelist()
            media_entries = [n for n in names if n.startswith("media/")]
            assert len(media_entries) > 0
            entry = next(n for n in media_entries if n.endswith("original.mp3"))
            # Byte-equality, not just presence — a truncated/corrupt media
            # file in the backup must fail this test (audit #5).
            assert zf.read(entry) == mp3_bytes

    def test_restore_preserves_media(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        db_path = tmp_path / "database.db"
        docs_dir = tmp_path / "documents"
        media_dir = tmp_path / "media"
        backup_dir = tmp_path / "backups"
        docs_dir.mkdir()
        backup_dir.mkdir()

        from sqlalchemy import create_engine as ce
        eng = ce(f"sqlite:///{db_path}")
        Base.metadata.create_all(eng)
        eng.dispose()

        # Create media file
        conv_media = media_dir / "1" / "1"
        conv_media.mkdir(parents=True)
        mp3_data = _read_fixture("test_audio.mp3")
        (conv_media / "original.mp3").write_bytes(mp3_data)

        # Create backup
        info = create_backup(db_path, docs_dir, media_dir, backup_dir, "manual")
        backup_path = backup_dir / info.filename

        # Clear media
        shutil.rmtree(str(media_dir))
        assert not media_dir.exists()

        # Restore
        restore_from_backup(backup_path, db_path, docs_dir, media_dir, backup_dir)

        # Verify media restored
        assert media_dir.exists()
        restored = media_dir / "1" / "1" / "original.mp3"
        assert restored.exists()
        assert restored.read_bytes() == mp3_data


# ── Project portability integration ──────────────────────────────────────


class TestPortabilityWithMedia:
    def test_export_includes_media(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        docs_dir = tmp_path / "documents"
        media_dir = tmp_path / "media"
        docs_dir.mkdir()

        # Create media file
        conv_media = media_dir / str(project.id) / str(conv.id)
        conv_media.mkdir(parents=True)
        (conv_media / "original.mp3").write_bytes(_read_fixture("test_audio.mp3"))

        from app.services.project_portability import export_project
        buf = export_project(db, project.id, docs_dir, media_dir)

        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            media_entries = [n for n in names if n.startswith("media/")]
            assert len(media_entries) > 0

    def test_import_remaps_media(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session

        # Set up media for export
        docs_dir = tmp_path / "documents"
        media_dir = tmp_path / "media"
        docs_dir.mkdir()
        conv_media = media_dir / str(project.id) / str(conv.id)
        conv_media.mkdir(parents=True)
        mp3_data = _read_fixture("test_audio.mp3")
        (conv_media / "original.mp3").write_bytes(mp3_data)

        from app.services.project_portability import export_project, import_project

        buf = export_project(db, project.id, docs_dir, media_dir)

        # Write export to temp file for import
        export_path = tmp_path / "export.mmproject"
        export_path.write_bytes(buf.getvalue())

        # Import into a fresh media dir
        import_media_dir = tmp_path / "import_media"

        new_id, name = import_project(db, export_path, docs_dir, import_media_dir, user_id=1)
        assert new_id != project.id  # New ID assigned

        # Verify media files exist under new project/conversation IDs
        if import_media_dir.exists():
            all_mp3s = list(import_media_dir.rglob("original.mp3"))
            assert len(all_mp3s) > 0
            assert all_mp3s[0].read_bytes() == mp3_data

    def test_video_conversation_round_trips(self, audio_session, tmp_path):
        """#551 rider: a VIDEO conversation's media metadata + bytes survive
        the .mmproject round trip. The class was audio-only, so a video-shaped
        regression (metadata columns dropped, remap missing the mp4) would
        have passed silently."""
        db, project, conv, _ = audio_session
        conv.media_filename = "clinic_visit.mp4"
        conv.media_format = "mp4"
        conv.media_type = "video"
        conv.media_duration_seconds = 12.5
        db.flush()

        docs_dir = tmp_path / "documents"
        docs_dir.mkdir()
        media_dir = tmp_path / "media"
        conv_media = media_dir / str(project.id) / str(conv.id)
        conv_media.mkdir(parents=True)
        video_bytes = _ftyp(b"isom") + _moov(b"vide")
        (conv_media / "original.mp4").write_bytes(video_bytes)

        from app.services.project_portability import export_project, import_project

        buf = export_project(db, project.id, docs_dir, media_dir)
        export_path = tmp_path / "export.mmproject"
        export_path.write_bytes(buf.getvalue())
        import_media_dir = tmp_path / "import_media"

        new_id, _name = import_project(db, export_path, docs_dir, import_media_dir, user_id=1)

        imported = db.query(Conversation).filter(Conversation.project_id == new_id).one()
        assert imported.media_type == "video"
        assert imported.media_format == "mp4"
        assert imported.media_filename == "clinic_visit.mp4"
        assert imported.media_duration_seconds == 12.5
        imported_file = (
            import_media_dir / str(new_id) / str(imported.id) / "original.mp4"
        )
        assert imported_file.read_bytes() == video_bytes


# ── Storage policy (V1 slab 5) ────────────────────────────────────────────


class TestSlab5StoragePolicy:
    """include_media exports (+ ZIP_STORED + canvas-always + import-side
    metadata clearing), video-less auto backups (+ restore preservation),
    and the project storage endpoint."""

    def _media_setup(self, project_id: int, conv_id: int, tmp_path, with_video=False):
        docs_dir = tmp_path / "documents"
        media_dir = tmp_path / "media"
        docs_dir.mkdir(exist_ok=True)
        conv_media = media_dir / str(project_id) / str(conv_id)
        conv_media.mkdir(parents=True)
        (conv_media / "original.mp3").write_bytes(_read_fixture("test_audio.mp3"))
        if with_video:
            (conv_media / "original.mp4").write_bytes(_ftyp(b"isom") + _moov(b"vide"))
        canvas_dir = media_dir / str(project_id) / "canvas"
        canvas_dir.mkdir(parents=True)
        (canvas_dir / "img.png").write_bytes(b"\x89PNG\r\n\x1a\nfakepng")
        return docs_dir, media_dir

    def test_export_media_less_skips_recordings_keeps_canvas(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path)

        from app.services.project_portability import export_project
        buf = export_project(db, project.id, docs_dir, media_dir, include_media=False)

        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            assert not any(n.startswith(f"media/{conv.id}/") for n in names), (
                "media-less export must skip conversation recordings"
            )
            assert "media/canvas/img.png" in names, (
                "canvas images are canvas CONTENT and must always travel"
            )

    def test_export_media_entries_are_stored_not_deflated(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path)

        from app.services.project_portability import export_project
        buf = export_project(db, project.id, docs_dir, media_dir)

        with zipfile.ZipFile(buf, "r") as zf:
            info = zf.getinfo(f"media/{conv.id}/original.mp3")
            assert info.compress_type == zipfile.ZIP_STORED, (
                "recordings are already-compressed containers — deflate wastes CPU"
            )

    def test_import_media_less_clears_orphaned_media_metadata(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path)

        conv.media_filename = "interview.mp3"
        conv.media_format = "mp3"
        conv.media_type = "audio"
        conv.media_duration_seconds = 12.5
        conv.media_offset_seconds = 3.0
        db.flush()

        from app.models.conversation import Conversation as Conv
        from app.services.project_portability import export_project, import_project

        buf = export_project(db, project.id, docs_dir, media_dir, include_media=False)
        export_path = tmp_path / "media_less.mmproject"
        export_path.write_bytes(buf.getvalue())

        import_media_dir = tmp_path / "import_media"
        new_id, _name = import_project(db, export_path, docs_dir, import_media_dir, user_id=1)

        imported = db.query(Conv).filter(Conv.project_id == new_id).first()
        # The recording did not travel → metadata must clear so the workbench
        # offers a clean "Attach Recording" state, not a dead player (§8 iii).
        assert imported.media_filename is None
        assert imported.media_format is None
        assert imported.media_type is None
        assert imported.media_duration_seconds is None
        assert imported.media_offset_seconds == 0.0

    def test_import_with_media_keeps_metadata(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path)

        conv.media_filename = "interview.mp3"
        conv.media_format = "mp3"
        conv.media_type = "audio"
        db.flush()

        from app.models.conversation import Conversation as Conv
        from app.services.project_portability import export_project, import_project

        buf = export_project(db, project.id, docs_dir, media_dir)  # media included
        export_path = tmp_path / "full.mmproject"
        export_path.write_bytes(buf.getvalue())

        import_media_dir = tmp_path / "import_media"
        new_id, _name = import_project(db, export_path, docs_dir, import_media_dir, user_id=1)

        imported = db.query(Conv).filter(Conv.project_id == new_id).first()
        assert imported.media_filename == "interview.mp3"
        assert imported.media_type == "audio"

    def test_backup_exclude_video_skips_video_keeps_audio(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path, with_video=True)
        db_path = tmp_path / "database.db"
        backup_dir = tmp_path / "backups"
        backup_dir.mkdir()
        from sqlalchemy import create_engine as ce
        eng = ce(f"sqlite:///{db_path}")
        Base.metadata.create_all(eng)
        eng.dispose()

        info = create_backup(db_path, docs_dir, media_dir, backup_dir, "auto", include_video=False)
        backup_path = backup_dir / info.filename

        with zipfile.ZipFile(str(backup_path), "r") as zf:
            names = zf.namelist()
            assert any(n.endswith("original.mp3") for n in names)
            assert not any(n.endswith("original.mp4") for n in names)
            mp3_entry = next(n for n in names if n.endswith("original.mp3"))
            assert zf.getinfo(mp3_entry).compress_type == zipfile.ZIP_STORED
            import json as _json
            manifest = _json.loads(zf.read("manifest.json"))
            assert manifest["video_excluded"] is True
            assert manifest["video_files_excluded"] == 1

    def test_restore_preserves_local_video_missing_from_backup(self, audio_session, tmp_path):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path, with_video=True)
        db_path = tmp_path / "database.db"
        backup_dir = tmp_path / "backups"
        backup_dir.mkdir()
        from sqlalchemy import create_engine as ce
        eng = ce(f"sqlite:///{db_path}")
        Base.metadata.create_all(eng)
        eng.dispose()

        video_path = media_dir / str(project.id) / str(conv.id) / "original.mp4"
        video_bytes = video_path.read_bytes()

        # Video-less backup, then restore over a media dir that HAS the video:
        # restore must never delete video bytes the backup deliberately excluded.
        info = create_backup(db_path, docs_dir, media_dir, backup_dir, "auto", include_video=False)
        restore_from_backup(backup_dir / info.filename, db_path, docs_dir, media_dir, backup_dir)

        assert video_path.read_bytes() == video_bytes
        assert (media_dir / str(project.id) / str(conv.id) / "original.mp3").exists()

    def test_project_storage_reports_media_and_video_bytes(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, _ = audio_session
        docs_dir, media_dir = self._media_setup(project.id, conv.id, tmp_path, with_video=True)

        from app.routers import projects as projects_router
        monkeypatch.setattr(projects_router, "get_media_dir", lambda: media_dir)
        monkeypatch.setattr(projects_router, "get_documents_dir", lambda: docs_dir)

        user = db.query(UserModel).first()
        resp = _run(projects_router.get_project_storage(
            project_id=project.id, user=user, db=db,
        ))
        mp3_size = len(_read_fixture("test_audio.mp3"))
        video_size = (media_dir / str(project.id) / str(conv.id) / "original.mp4").stat().st_size
        assert resp.video_bytes == video_size
        assert resp.media_bytes >= mp3_size + video_size  # + canvas png
        assert resp.documents_bytes == 0


# ── No-timestamps edge case ──────────────────────────────────────────────


class TestNoTimestampsWithAudio:
    def test_audio_without_timestamps(self, audio_session, tmp_path):
        """Conversation without timestamps can still have audio attached."""
        db, project, conv, _ = audio_session

        # Conversation has no segments with timestamps — just set media fields
        conv.media_filename = "interview.mp3"
        conv.media_format = "mp3"
        conv.media_type = "audio"
        conv.media_duration_seconds = 60.0
        conv.media_offset_seconds = 0.0
        db.flush()

        assert conv.media_type == "audio"
        assert conv.media_duration_seconds == 60.0


class TestMediaRouteSlash:
    """Regression: media upload/delete must be registered at the exact
    no-trailing-slash path the frontend POSTs to. A `@router.post("/")` on a
    slash-less prefix registers `.../media/` and makes the frontend's
    `.../media` request 307-redirect to an absolute cross-origin URL, which
    silently breaks the multipart upload in the browser (the dev-server
    origin differs from the API origin). See routers/media.py.
    """

    def _media_methods(self):
        from app.main import app

        found: dict[str, set[str]] = {}
        for route in app.routes:
            path = getattr(route, "path", "")
            if path.endswith("/media") or path.endswith("/media/"):
                methods = getattr(route, "methods", set()) or set()
                for m in ("POST", "DELETE"):
                    if m in methods:
                        found.setdefault(m, set()).add(path)
        return found

    def test_upload_and_delete_have_no_trailing_slash(self):
        found = self._media_methods()
        assert "POST" in found and "DELETE" in found, (
            f"media POST/DELETE routes not found: {found}"
        )
        for method, paths in found.items():
            for p in paths:
                assert not p.endswith("/media/"), (
                    f"{method} {p} has a trailing slash — the frontend POSTs "
                    f"to '.../media' and this would 307-redirect cross-origin, "
                    f"breaking multipart upload. Declare the route with "
                    f'@router.{method.lower()}("") not ("/").'
                )
                assert p.endswith("/media"), f"unexpected media route path: {p}"


# ── Streaming upload + atomic replace (audit #2 / #3) ────────────────────

import asyncio  # noqa: E402
from io import BytesIO  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from starlette.datastructures import Headers, UploadFile as StarletteUploadFile  # noqa: E402

from app.models.user import User as UserModel  # noqa: E402
from app.routers import media as media_router  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def _upload_file(data: bytes, filename: str) -> StarletteUploadFile:
    return StarletteUploadFile(
        file=BytesIO(data),
        filename=filename,
        headers=Headers({"content-type": "application/octet-stream"}),
    )


class TestStreamingUpload:
    """upload_media streams to a temp file (bounded memory) then atomically
    swaps it in; old audio survives a failed/invalid replace (audit #2/#3)."""

    def _ctx(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, _ = audio_session
        media_root = tmp_path / "media"
        monkeypatch.setattr(media_router, "get_media_dir", lambda: media_root)
        user = db.query(UserModel).first()
        media_dir = media_root / str(project.id) / str(conv.id)
        return db, project, conv, user, media_dir

    def test_multichunk_roundtrip_and_atomic(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        # > UPLOAD_CHUNK (1 MiB) so the streaming loop runs multiple iterations
        big_wav = _make_wav(tmp_path / "big.wav", duration_sec=15.0)
        data = big_wav.read_bytes()
        assert len(data) > media_router.UPLOAD_CHUNK

        resp = _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(data, "big.wav"), user=user, db=db,
        ))
        assert resp.media_format == "wav"
        assert resp.media_duration_seconds and resp.media_duration_seconds > 14
        dest = media_dir / "original.wav"
        assert dest.read_bytes() == data            # exact multichunk round-trip
        assert list(media_dir.glob(".upload-*")) == []   # temp cleaned

    def test_size_cap_streamed_and_cleaned(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        monkeypatch.setattr(media_router, "MAX_MEDIA_SIZE", 1024)  # 1 KiB cap
        mp3 = _read_fixture("test_audio.mp3")
        assert len(mp3) > 1024
        with pytest.raises(HTTPException) as ei:
            _run(media_router.upload_media(
                project_id=project.id, conversation_id=conv.id,
                file=_upload_file(mp3, "x.mp3"), user=user, db=db,
            ))
        assert ei.value.status_code == 413
        # nothing left behind: no original.*, no temp part
        assert not media_dir.exists() or list(media_dir.glob("original.*")) == []
        assert not media_dir.exists() or list(media_dir.glob(".upload-*")) == []

    def test_failed_replace_preserves_old_audio(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        good = _read_fixture("test_audio.mp3")
        _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(good, "good.mp3"), user=user, db=db,
        ))
        assert (media_dir / "original.mp3").read_bytes() == good
        prev_fmt = conv.media_format

        # Second upload is not audio -> 400; old audio must be untouched
        with pytest.raises(HTTPException) as ei:
            _run(media_router.upload_media(
                project_id=project.id, conversation_id=conv.id,
                file=_upload_file(b"this is not audio at all, no magic bytes", "bad.txt"),
                user=user, db=db,
            ))
        assert ei.value.status_code == 400
        assert (media_dir / "original.mp3").read_bytes() == good  # preserved
        assert conv.media_format == prev_fmt
        assert list(media_dir.glob(".upload-*")) == []

    def test_format_switch_drops_stale_original(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(_read_fixture("test_audio.mp3"), "a.mp3"), user=user, db=db,
        ))
        assert (media_dir / "original.mp3").exists()
        wav = _make_wav(tmp_path / "s.wav", duration_sec=0.2).read_bytes()
        _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(wav, "a.wav"), user=user, db=db,
        ))
        assert (media_dir / "original.wav").exists()
        assert not (media_dir / "original.mp3").exists()  # stale prior format gone
        assert conv.media_format == "wav"


# ── Video detection (V1 slab 1: mp4-family refine + WebM) ────────────────
#
# No ffmpeg in this environment, so detection tests use synthetic-but-valid
# MP4 box structures built in-test — detection is purely structural, so these
# exercise exactly what the walker reads. Real-media playback verification is
# a later slab (workbench video pane).


def _box(box_type: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", 8 + len(payload)) + box_type + payload


def _ftyp(brand: bytes) -> bytes:
    return _box(b"ftyp", brand + b"\x00\x00\x02\x00" + brand)


def _hdlr(handler: bytes) -> bytes:
    # version/flags(4) + pre_defined(4) + handler_type(4) + reserved(12) + name
    return _box(b"hdlr", b"\x00" * 8 + handler + b"\x00" * 13)


def _trak(handler: bytes) -> bytes:
    return _box(b"trak", _box(b"mdia", _hdlr(handler)))


def _moov(*handlers: bytes) -> bytes:
    return _box(b"moov", b"".join(_trak(h) for h in handlers))


class TestVideoDetection:
    def test_webm_magic(self):
        assert _detect_format(b"\x1a\x45\xdf\xa3" + b"\x00" * 8) == "webm"

    def test_ftyp_first_chunk_still_preliminary_m4a(self):
        # First-chunk contract unchanged: any ftyp sniffs as m4a; the
        # video-vs-audio decision happens post-upload via _refine_mp4_family.
        assert _detect_format(b"\x00\x00\x00\x20ftypisom") == "m4a"

    def test_video_formats_constant(self):
        assert VIDEO_FORMATS == {"mp4", "mov", "webm"}

    def test_refine_video_mp4(self, tmp_path):
        p = tmp_path / "v.mp4"
        p.write_bytes(_ftyp(b"isom") + _moov(b"vide", b"soun") + _box(b"mdat", b"\x00" * 64))
        assert _refine_mp4_family(p) == "mp4"

    def test_refine_moov_after_mdat(self, tmp_path):
        # The Zoom / non-faststart layout: moov at END of file — the reason
        # refinement can't happen on the first streamed chunk.
        p = tmp_path / "v.mp4"
        p.write_bytes(_ftyp(b"mp42") + _box(b"mdat", b"\x00" * 5000) + _moov(b"vide"))
        assert _refine_mp4_family(p) == "mp4"

    def test_refine_largesize_mdat_skipped(self, tmp_path):
        # size==1 → 64-bit largesize header; the walker must skip it by seek.
        payload = b"\x00" * 128
        largesize_mdat = struct.pack(">I", 1) + b"mdat" + struct.pack(">Q", 16 + len(payload)) + payload
        p = tmp_path / "v.mp4"
        p.write_bytes(_ftyp(b"isom") + largesize_mdat + _moov(b"vide"))
        assert _refine_mp4_family(p) == "mp4"

    def test_refine_m4a_brand_short_circuits(self, tmp_path):
        # 'M4A ' major brand is authoritative audio — no moov walk needed
        # (and a vide handler after it must not flip the verdict).
        p = tmp_path / "a.m4a"
        p.write_bytes(_ftyp(b"M4A ") + _moov(b"vide"))
        assert _refine_mp4_family(p) == "m4a"

    def test_refine_soun_only_stays_m4a(self, tmp_path):
        p = tmp_path / "a.m4a"
        p.write_bytes(_ftyp(b"isom") + _moov(b"soun") + _box(b"mdat", b"\x00" * 64))
        assert _refine_mp4_family(p) == "m4a"

    def test_refine_qt_brand_is_mov(self, tmp_path):
        p = tmp_path / "v.mov"
        p.write_bytes(_ftyp(b"qt  ") + _moov(b"vide", b"soun"))
        assert _refine_mp4_family(p) == "mov"

    def test_refine_malformed_falls_back_m4a(self, tmp_path):
        # A box claiming size 4 (< header) aborts the walk → inconclusive → m4a.
        p = tmp_path / "junk.m4a"
        p.write_bytes(_ftyp(b"isom") + struct.pack(">I", 4) + b"xxxx")
        assert _refine_mp4_family(p) == "m4a"

    def test_refine_real_m4a_reference(self):
        # Real-world m4a (ALAC reference file): its meta/hdlr 'mdir' (iTunes
        # metadata handler) must NOT count as a media track — only trak/mdia
        # hdlr boxes are consulted.
        assert _refine_mp4_family(REFERENCE_DIR / "test_audio.m4a") == "m4a"


class TestVideoUpload:
    """upload_media classifies video uploads: media_type='video', stored as
    original.<video-fmt>, streamed with a video MIME type."""

    def _ctx(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, _ = audio_session
        media_root = tmp_path / "media"
        monkeypatch.setattr(media_router, "get_media_dir", lambda: media_root)
        user = db.query(UserModel).first()
        media_dir = media_root / str(project.id) / str(conv.id)
        return db, project, conv, user, media_dir

    def test_upload_video_mp4(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        data = _ftyp(b"isom") + _box(b"mdat", b"\x00" * 64) + _moov(b"vide", b"soun")
        resp = _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(data, "interview.mp4"), user=user, db=db,
        ))
        assert resp.media_format == "mp4"
        assert resp.media_type == "video"
        assert (media_dir / "original.mp4").read_bytes() == data
        assert conv.media_type == "video"

    def test_upload_webm(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        data = b"\x1a\x45\xdf\xa3" + b"\x00" * 256
        resp = _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(data, "clip.webm"), user=user, db=db,
        ))
        assert resp.media_format == "webm"
        assert resp.media_type == "video"
        assert (media_dir / "original.webm").exists()

    def test_upload_real_m4a_still_audio(self, audio_session, tmp_path, monkeypatch):
        # Regression for the pre-V1 trap in reverse: genuine m4a audio must
        # NOT be reclassified by the video branch.
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        resp = _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(_read_fixture("test_audio.m4a"), "memo.m4a"), user=user, db=db,
        ))
        assert resp.media_format == "m4a"
        assert resp.media_type == "audio"
        assert (media_dir / "original.m4a").exists()

    def test_video_then_audio_swap_drops_stale(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        video = _ftyp(b"isom") + _moov(b"vide")
        _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(video, "v.mp4"), user=user, db=db,
        ))
        assert (media_dir / "original.mp4").exists()
        _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(_read_fixture("test_audio.mp3"), "a.mp3"), user=user, db=db,
        ))
        assert (media_dir / "original.mp3").exists()
        assert not (media_dir / "original.mp4").exists()
        assert conv.media_type == "audio"

    def test_stream_mime_for_video(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, _ = self._ctx(audio_session, tmp_path, monkeypatch)
        video = _ftyp(b"isom") + _moov(b"vide")
        _run(media_router.upload_media(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(video, "v.mp4"), user=user, db=db,
        ))
        resp = _run(media_router.stream_media(
            project_id=project.id, conversation_id=conv.id, user=user, db=db,
        ))
        assert resp.media_type == "video/mp4"
        assert resp.headers.get("accept-ranges") == "bytes"


# ── Wire format (V1 slab 2): /media paths + has_media on the wire ─────────

from starlette.testclient import TestClient  # noqa: E402

from app.database import SessionLocal, engine as shared_engine  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402


@pytest.fixture()
def wire_client(tmp_path, monkeypatch):
    """TestClient over the shared StaticPool :memory: engine (conftest pins
    MM_DATABASE_PATH); media writes are redirected into tmp_path. Mirrors the
    test_datetime_wire_format.py response-layer pattern: wire-format changes
    need HTTP-layer coverage — a direct-call test can pass while the wire
    still emits the old shape.
    """
    monkeypatch.setattr(media_router, "get_media_dir", lambda: tmp_path / "media")
    # conversation_to_response stats the media file for media_size_bytes —
    # its module-level import needs the same redirect.
    from app.routers import conversations as conversations_router
    monkeypatch.setattr(conversations_router, "get_media_dir", lambda: tmp_path / "media")
    Base.metadata.create_all(bind=shared_engine)
    with TestClient(fastapi_app, raise_server_exceptions=False) as c:
        yield c
    Base.metadata.drop_all(bind=shared_engine)


def _wire_bootstrap(client) -> tuple[int, int, dict]:
    """Auto-provision the local coder, create a project + conversation over
    the shared engine; return (project_id, conversation_id, csrf headers)."""
    status = client.get("/api/auth/status")
    assert status.status_code == 200
    headers = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
    resp = client.post("/api/projects", json={"name": "Media wire"}, headers=headers)
    assert resp.status_code in (200, 201), resp.text
    pid = resp.json()["id"]
    db = SessionLocal()
    try:
        conv = Conversation(
            project_id=pid, name="Interview", status=ConversationStatus.IMPORTED
        )
        db.add(conv)
        db.commit()
        cid = conv.id
    finally:
        db.close()
    return pid, cid, headers


class TestMediaWireFormat:
    """Response-layer coverage for the slab-2 wire generalization: the router
    lives at .../media, and conversation responses carry `has_media` (a file
    is attached, any type — drives management affordances; the player gates
    on `media_type`) and no longer emit `has_audio`."""

    def test_media_crud_over_http_and_has_media_flag(self, wire_client):
        pid, cid, headers = _wire_bootstrap(wire_client)
        base = f"/api/projects/{pid}/conversations/{cid}"

        # Before upload: has_media False; has_audio gone from the wire.
        detail = wire_client.get(base).json()
        assert detail["has_media"] is False
        assert "has_audio" not in detail

        up = wire_client.post(
            f"{base}/media",
            files={"file": ("interview.mp3", _read_fixture("test_audio.mp3"), "audio/mpeg")},
            headers=headers,
        )
        assert up.status_code == 200, up.text
        body = up.json()
        assert body["media_format"] == "mp3"
        assert body["media_type"] == "audio"

        detail = wire_client.get(base).json()
        assert detail["has_media"] is True
        assert detail["media_type"] == "audio"
        # slab 5 storage visibility: the on-disk size rides the wire
        assert detail["media_size_bytes"] == len(_read_fixture("test_audio.mp3"))
        listing = wire_client.get(f"/api/projects/{pid}/conversations").json()
        assert listing["conversations"][0]["has_media"] is True
        assert "has_audio" not in listing["conversations"][0]

        stream = wire_client.get(f"{base}/media/stream")
        assert stream.status_code == 200
        assert stream.headers.get("accept-ranges") == "bytes"

        off = wire_client.patch(
            f"{base}/media/offset", json={"offset_seconds": 12.5}, headers=headers
        )
        assert off.status_code == 200, off.text
        assert off.json()["media_offset_seconds"] == 12.5

        deleted = wire_client.delete(f"{base}/media", headers=headers)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["has_media"] is False

    def test_media_version_cache_token_and_stream_no_cache(self, wire_client):
        """#549: conversation responses carry an opaque media_version
        (mtime_ns+size) that changes on EVERY replace — including a same-name,
        same-bytes re-upload, which media_filename cannot detect — and the
        stream response is `no-cache` so a replaced recording is never served
        from a day-old browser cache. (Starlette's FileResponse does NOT
        answer If-None-Match with 304, so `max-age` here would pin stale
        bytes with no revalidation escape hatch.)"""
        import time

        pid, cid, headers = _wire_bootstrap(wire_client)
        base = f"/api/projects/{pid}/conversations/{cid}"

        # No media attached: no version token.
        assert wire_client.get(base).json()["media_version"] is None

        mp3 = _read_fixture("test_audio.mp3")
        up1 = wire_client.post(
            f"{base}/media",
            files={"file": ("interview.mp3", mp3, "audio/mpeg")},
            headers=headers,
        )
        assert up1.status_code == 200, up1.text
        v1 = wire_client.get(base).json()["media_version"]
        assert v1

        # Same-name, same-bytes replace — the hardest corner: filename AND
        # size are unchanged, only mtime moves. (Sleep clears coarse-mtime
        # filesystems' granularity.)
        time.sleep(0.02)
        up2 = wire_client.post(
            f"{base}/media",
            files={"file": ("interview.mp3", mp3, "audio/mpeg")},
            headers=headers,
        )
        assert up2.status_code == 200, up2.text
        detail = wire_client.get(base).json()
        assert detail["media_filename"] == "interview.mp3"
        assert detail["media_version"] != v1

        # The stream must revalidate instead of trusting a stale cache entry.
        stream = wire_client.get(f"{base}/media/stream")
        assert stream.status_code == 200
        assert stream.headers.get("cache-control") == "private, no-cache"

    def test_old_audio_path_is_gone(self, wire_client):
        pid, cid, headers = _wire_bootstrap(wire_client)
        base = f"/api/projects/{pid}/conversations/{cid}"
        resp = wire_client.post(
            f"{base}/audio",
            files={"file": ("a.mp3", _read_fixture("test_audio.mp3"), "audio/mpeg")},
            headers=headers,
        )
        # 404 when no SPA catch-all is mounted; 405 when frontend/dist exists
        # (the GET-only catch-all matches the path). Either way: no API route.
        assert resp.status_code in (404, 405)


class TestAppLevelEnospcHandler:
    """#544(a): Starlette spools the multipart body to the OS temp dir BEFORE
    the media endpoint runs, so a disk-full there raises a raw OSError that
    the router's own 507 guard never sees. The app-level OSError handler in
    main.py must map that shape to the same 507. Simulated by raising the raw
    OSError from inside the endpoint (the handler doesn't care which phase
    raised it — this exercises the full middleware path over HTTP)."""

    def test_escaped_enospc_maps_to_507(self, wire_client, monkeypatch):
        pid, cid, headers = _wire_bootstrap(wire_client)

        async def spool_enospc(*_a, **_k):
            raise OSError(errno.ENOSPC, "No space left on device")

        monkeypatch.setattr(media_router, "_stream_upload_to_temp", spool_enospc)
        resp = wire_client.post(
            f"/api/projects/{pid}/conversations/{cid}/media",
            files={"file": ("a.mp3", _read_fixture("test_audio.mp3"), "audio/mpeg")},
            headers=headers,
        )
        assert resp.status_code == 507, resp.text
        assert "disk space" in resp.json()["detail"].lower()

    def test_non_enospc_oserror_keeps_500(self, wire_client, monkeypatch):
        """The handler is strictly errno-gated — any other OSError re-raises
        into the normal 500 path instead of masquerading as disk-full."""
        pid, cid, headers = _wire_bootstrap(wire_client)

        async def spool_eacces(*_a, **_k):
            raise OSError(errno.EACCES, "Permission denied")

        monkeypatch.setattr(media_router, "_stream_upload_to_temp", spool_eacces)
        resp = wire_client.post(
            f"/api/projects/{pid}/conversations/{cid}/media",
            files={"file": ("a.mp3", _read_fixture("test_audio.mp3"), "audio/mpeg")},
            headers=headers,
        )
        assert resp.status_code == 500


class TestMediaConstantsMirror:
    """#544(c): frontend `lib/media-constants.ts` mirrors these values
    (MAX_MEDIA_SIZE, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS). Each side pins the
    same literals — changing one without the other fails that side's suite.
    Sister test: media-constants.test.ts 'backend mirror agreement'."""

    def test_max_media_size_pinned_to_frontend_mirror(self):
        assert MAX_MEDIA_SIZE == 4 * 1024**3

    def test_video_formats_pinned_to_frontend_mirror(self):
        assert VIDEO_FORMATS == {"mp4", "mov", "webm"}
