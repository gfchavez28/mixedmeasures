"""Audio file management for conversations — upload, stream, delete, offset."""

import logging
import os
import shutil
import tempfile
import wave
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import get_media_dir
from ..database import get_db
from ..models.conversation import Conversation
from ..models.user import User
from ..schemas.conversation import AudioOffsetUpdate, AudioUploadResponse
from ..services.audit import log_action
from .helpers import _get_project_or_404
from .conversations import conversation_to_response

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_MEDIA_SIZE = 500 * 1024 * 1024  # 500 MB
UPLOAD_CHUNK = 1024 * 1024  # 1 MiB — stream granularity (never buffer whole file)


def _media_dir(project_id: int, conversation_id: int) -> Path:
    return get_media_dir() / str(project_id) / str(conversation_id)


def _detect_format(header: bytes) -> str | None:
    """Detect audio format from file content (first 12 bytes)."""
    if len(header) < 12:
        return None
    # MP3: ID3v2 tag or MPEG sync word
    if header[:3] == b"ID3":
        return "mp3"
    if len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0:
        return "mp3"
    # M4A/AAC: bytes 4-8 are 'ftyp' (MP4 container)
    if header[4:8] == b"ftyp":
        return "m4a"
    # WAV: starts with 'RIFF' and bytes 8-12 are 'WAVE'
    if header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "wav"
    return None


def _extract_duration(filepath: Path, fmt: str) -> float | None:
    """Extract audio duration in seconds via tinytag (MP3/M4A) or wave stdlib (WAV).

    Best-effort: never raises on a malformed/uploaded file — returns None.
    (tinytag replaced mutagen, which is GPLv2+ and incompatible with the
    project's Apache-2.0 license; 2026-06-01.)
    """
    try:
        if fmt in ("mp3", "m4a"):
            from tinytag import TinyTag
            tag = TinyTag.get(str(filepath))
            return float(tag.duration) if tag.duration is not None else None
        elif fmt == "wav":
            with wave.open(str(filepath), "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                if rate > 0:
                    return frames / rate
            return None
    except Exception as e:
        # Broad by design: the input is an untrusted upload and the contract is
        # "best-effort, never raise". tinytag raises TinyTagException (and may
        # surface struct/value errors) on partial frames; wave raises wave.Error.
        logger.warning("Failed to extract duration from %s: %s", filepath, e)
    return None


def _mp3_is_vbr(filepath: Path) -> bool | None:
    """Best-effort VBR detection: scan the MP3's first audio frame for a
    Xing/VBRI (VBR) or Info (CBR) header.

    Returns True (VBR), False (CBR or no VBR header found), or None on read
    error. Replaces mutagen's BitrateMode (GPLv2+). A header-less MP3 reports
    False — matching mutagen's UNKNOWN→non-VBR result and the existing
    soft-warning semantics (the warning is about duration imprecision, so a
    false negative here is non-critical).
    """
    try:
        with open(filepath, "rb") as f:
            head = f.read(10)
            audio_start = 0
            # Skip an ID3v2 tag if present (4x syncsafe size at bytes 6-9), so
            # the scan window lands on the first real MPEG frame, not cover art.
            if len(head) == 10 and head[:3] == b"ID3":
                size = (
                    (head[6] & 0x7F) << 21
                    | (head[7] & 0x7F) << 14
                    | (head[8] & 0x7F) << 7
                    | (head[9] & 0x7F)
                )
                audio_start = 10 + size
            f.seek(audio_start)
            window = f.read(4096)  # Xing/Info/VBRI live within the first frame
    except OSError as e:
        logger.warning("Failed to read MP3 header for %s: %s", filepath, e)
        return None
    return b"Xing" in window or b"VBRI" in window


def _detect_vbr(filepath: Path, fmt: str) -> bool | None:
    """Detect VBR for MP3 files. Returns None for non-MP3."""
    if fmt != "mp3":
        return None
    return _mp3_is_vbr(filepath)


def _get_conversation(db: Session, project_id: int, conversation_id: int, user_id: int) -> Conversation:
    """Look up conversation, verifying it belongs to project and user owns project."""
    _get_project_or_404(db, project_id, user_id)
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.project_id == project_id,
    ).first()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    return conversation


async def _stream_upload_to_temp(
    file: UploadFile, parent: Path, max_size: int
) -> tuple[str, Path]:
    """Stream an UploadFile to a temp file inside `parent`, never holding the
    whole payload in memory.

    Detects format from the first chunk and enforces `max_size` incrementally.
    Returns (fmt, temp_path). Raises HTTPException (400 unsupported/empty,
    413 too large) and always removes the temp file on failure. The caller is
    responsible for atomically moving the returned temp file into place.
    """
    parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".upload-", suffix=".part", dir=str(parent))
    tmp = Path(tmp_name)
    total = 0
    fmt: str | None = None
    try:
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = await file.read(UPLOAD_CHUNK)
                if not chunk:
                    break
                if fmt is None:
                    fmt = _detect_format(chunk[:12])
                    if fmt is None:
                        raise HTTPException(
                            400,
                            "Unsupported audio format. Accepted formats: "
                            "MP3, M4A/AAC, WAV.",
                        )
                total += len(chunk)
                if total > max_size:
                    raise HTTPException(413, "Audio file exceeds 500MB limit")
                out.write(chunk)
        if fmt is None:
            raise HTTPException(400, "Empty or unreadable audio file.")
        return fmt, tmp
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


@router.post("", response_model=AudioUploadResponse)
async def upload_audio(
    project_id: int,
    conversation_id: int,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload an audio file for a conversation."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)
    media_path = _media_dir(project_id, conversation_id)

    # Stream to a temp file (bounded memory). Old audio is left untouched
    # until the new file is fully written and validated.
    fmt, tmp = await _stream_upload_to_temp(file, media_path, MAX_MEDIA_SIZE)

    # Atomically swap the new file into place, then drop any stale original
    # of a *different* prior format. os.replace is atomic within the dir, so
    # a crash here can't leave a half-written original.
    dest = media_path / f"original.{fmt}"
    try:
        os.replace(str(tmp), str(dest))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    for stale in media_path.glob("original.*"):
        if stale != dest:
            try:
                stale.unlink()
            except OSError:
                logger.warning("Could not remove stale media file %s", stale)

    # Extract metadata
    duration = _extract_duration(dest, fmt)
    is_vbr = _detect_vbr(dest, fmt)

    # Update conversation
    conversation.media_filename = file.filename or f"audio.{fmt}"
    conversation.media_format = fmt
    conversation.media_type = "audio"
    conversation.media_duration_seconds = duration
    conversation.media_offset_seconds = 0.0  # Reset on new upload
    conversation.media_is_vbr = is_vbr

    log_action(
        db,
        action="audio_upload",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "filename": conversation.media_filename,
            "format": fmt,
            "duration_seconds": duration,
            "is_vbr": is_vbr,
        },
    )
    db.commit()
    db.refresh(conversation)

    return AudioUploadResponse(
        media_filename=conversation.media_filename,
        media_format=conversation.media_format,
        media_type=conversation.media_type,
        media_duration_seconds=conversation.media_duration_seconds,
        media_offset_seconds=conversation.media_offset_seconds,
        media_is_vbr=conversation.media_is_vbr,
    )


@router.get("/stream")
async def stream_audio(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Stream the audio file with HTTP Range support for seeking."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if not conversation.media_filename:
        raise HTTPException(404, "No audio file attached to this conversation")

    media_path = _media_dir(project_id, conversation_id) / f"original.{conversation.media_format}"
    if not media_path.is_file():
        raise HTTPException(404, "Audio file not found on disk")

    media_types = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav"}

    return FileResponse(
        path=str(media_path),
        media_type=media_types.get(conversation.media_format, "application/octet-stream"),
        filename=conversation.media_filename,
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=86400",
        },
    )


@router.delete("")
async def delete_audio(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove the audio file from a conversation."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if not conversation.media_filename:
        raise HTTPException(404, "No audio file attached to this conversation")

    # Delete file from disk
    media_path = _media_dir(project_id, conversation_id)
    try:
        if media_path.is_dir():
            shutil.rmtree(str(media_path))
    except Exception:
        logger.warning("Failed to clean up media files at %s", media_path)

    # Clear conversation fields
    old_filename = conversation.media_filename
    conversation.media_filename = None
    conversation.media_format = None
    conversation.media_type = None
    conversation.media_duration_seconds = None
    conversation.media_offset_seconds = 0.0
    conversation.media_is_vbr = None

    log_action(
        db,
        action="audio_delete",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details={"filename": old_filename},
    )
    db.commit()
    db.refresh(conversation)

    return conversation_to_response(conversation, db)


@router.patch("/offset")
async def update_offset(
    project_id: int,
    conversation_id: int,
    data: AudioOffsetUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update the audio sync offset for a conversation."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if not conversation.media_filename:
        raise HTTPException(404, "No audio file attached to this conversation")

    conversation.media_offset_seconds = data.offset_seconds

    log_action(
        db,
        action="audio_offset_change",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details={"offset_seconds": data.offset_seconds},
    )
    db.commit()
    db.refresh(conversation)

    return conversation_to_response(conversation, db)
