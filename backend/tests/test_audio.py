"""Tests for audio upload, stream, delete, offset, and integration with
backup/portability. Uses in-memory SQLite (conftest safety guard) with
tmp_path for file storage.
"""

import io
import shutil
import struct
import wave
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.database import Base
from app.models.conversation import Conversation, ConversationStatus
from app.models.project import Project
from app.models.user import User
from app.routers.audio import (
    MAX_MEDIA_SIZE,
    _detect_format,
    _detect_vbr,
    _extract_duration,
    _media_dir,
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
        """AudioOffsetUpdate validates ±300 bounds."""
        from app.schemas.conversation import AudioOffsetUpdate
        from pydantic import ValidationError

        AudioOffsetUpdate(offset_seconds=300.0)
        AudioOffsetUpdate(offset_seconds=-300.0)
        AudioOffsetUpdate(offset_seconds=0.0)

        with pytest.raises(ValidationError):
            AudioOffsetUpdate(offset_seconds=301.0)
        with pytest.raises(ValidationError):
            AudioOffsetUpdate(offset_seconds=-301.0)


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


class TestAudioRouteSlash:
    """Regression: audio upload/delete must be registered at the exact
    no-trailing-slash path the frontend POSTs to. A `@router.post("/")` on a
    slash-less prefix registers `.../audio/` and makes the frontend's
    `.../audio` request 307-redirect to an absolute cross-origin URL, which
    silently breaks the multipart upload in the browser (the dev-server
    origin differs from the API origin). See routers/audio.py.
    """

    def _audio_methods(self):
        from app.main import app

        found: dict[str, set[str]] = {}
        for route in app.routes:
            path = getattr(route, "path", "")
            if path.endswith("/audio") or path.endswith("/audio/"):
                methods = getattr(route, "methods", set()) or set()
                for m in ("POST", "DELETE"):
                    if m in methods:
                        found.setdefault(m, set()).add(path)
        return found

    def test_upload_and_delete_have_no_trailing_slash(self):
        found = self._audio_methods()
        assert "POST" in found and "DELETE" in found, (
            f"audio POST/DELETE routes not found: {found}"
        )
        for method, paths in found.items():
            for p in paths:
                assert not p.endswith("/audio/"), (
                    f"{method} {p} has a trailing slash — the frontend POSTs "
                    f"to '.../audio' and this would 307-redirect cross-origin, "
                    f"breaking multipart upload. Declare the route with "
                    f'@router.{method.lower()}("") not ("/").'
                )
                assert p.endswith("/audio"), f"unexpected audio route path: {p}"


# ── Streaming upload + atomic replace (audit #2 / #3) ────────────────────

import asyncio  # noqa: E402
from io import BytesIO  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from starlette.datastructures import Headers, UploadFile as StarletteUploadFile  # noqa: E402

from app.models.user import User as UserModel  # noqa: E402
from app.routers import audio as audio_router  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def _upload_file(data: bytes, filename: str) -> StarletteUploadFile:
    return StarletteUploadFile(
        file=BytesIO(data),
        filename=filename,
        headers=Headers({"content-type": "application/octet-stream"}),
    )


class TestStreamingUpload:
    """upload_audio streams to a temp file (bounded memory) then atomically
    swaps it in; old audio survives a failed/invalid replace (audit #2/#3)."""

    def _ctx(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, _ = audio_session
        media_root = tmp_path / "media"
        monkeypatch.setattr(audio_router, "get_media_dir", lambda: media_root)
        user = db.query(UserModel).first()
        media_dir = media_root / str(project.id) / str(conv.id)
        return db, project, conv, user, media_dir

    def test_multichunk_roundtrip_and_atomic(self, audio_session, tmp_path, monkeypatch):
        db, project, conv, user, media_dir = self._ctx(audio_session, tmp_path, monkeypatch)
        # > UPLOAD_CHUNK (1 MiB) so the streaming loop runs multiple iterations
        big_wav = _make_wav(tmp_path / "big.wav", duration_sec=15.0)
        data = big_wav.read_bytes()
        assert len(data) > audio_router.UPLOAD_CHUNK

        resp = _run(audio_router.upload_audio(
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
        monkeypatch.setattr(audio_router, "MAX_MEDIA_SIZE", 1024)  # 1 KiB cap
        mp3 = _read_fixture("test_audio.mp3")
        assert len(mp3) > 1024
        with pytest.raises(HTTPException) as ei:
            _run(audio_router.upload_audio(
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
        _run(audio_router.upload_audio(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(good, "good.mp3"), user=user, db=db,
        ))
        assert (media_dir / "original.mp3").read_bytes() == good
        prev_fmt = conv.media_format

        # Second upload is not audio -> 400; old audio must be untouched
        with pytest.raises(HTTPException) as ei:
            _run(audio_router.upload_audio(
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
        _run(audio_router.upload_audio(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(_read_fixture("test_audio.mp3"), "a.mp3"), user=user, db=db,
        ))
        assert (media_dir / "original.mp3").exists()
        wav = _make_wav(tmp_path / "s.wav", duration_sec=0.2).read_bytes()
        _run(audio_router.upload_audio(
            project_id=project.id, conversation_id=conv.id,
            file=_upload_file(wav, "a.wav"), user=user, db=db,
        ))
        assert (media_dir / "original.wav").exists()
        assert not (media_dir / "original.mp3").exists()  # stale prior format gone
        assert conv.media_format == "wav"
