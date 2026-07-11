"""Media (audio/video) file management for conversations — upload, stream, delete, offset."""

import errno
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
from ..models.conversation import Conversation, VIDEO_FORMATS
from ..models.user import User
from ..schemas.conversation import MediaOffsetUpdate, MediaUploadResponse
from ..services.audit import log_action
from .helpers import _get_project_or_404
from .conversations import conversation_to_response

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_MEDIA_SIZE = 4 * 1024 * 1024 * 1024  # 4 GB (raised from 500 MB for video; streaming path is bounded-memory so the cap is policy)
UPLOAD_CHUNK = 1024 * 1024  # 1 MiB — stream granularity (never buffer whole file)

# VIDEO_FORMATS is hosted in models/conversation.py (services consume it too);
# re-exported here because this router is the format seam's home.
__all__ = ["VIDEO_FORMATS", "MAX_MEDIA_SIZE"]


def _media_dir(project_id: int, conversation_id: int) -> Path:
    return get_media_dir() / str(project_id) / str(conversation_id)


def _detect_format(header: bytes) -> str | None:
    """Detect media container from file content (first 12 bytes).

    'ftyp' (MP4 family) is deliberately preliminary: video-vs-audio needs the
    'moov' box, which may sit at the END of the file — callers that have the
    whole file must refine via `_refine_mp4_family` (done in
    `_stream_upload_to_temp` once the upload is complete).
    """
    if len(header) < 12:
        return None
    # MP3: ID3v2 tag or MPEG sync word
    if header[:3] == b"ID3":
        return "mp3"
    if len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0:
        return "mp3"
    # MP4 family (m4a audio, mp4/mov video): bytes 4-8 are 'ftyp'
    if header[4:8] == b"ftyp":
        return "m4a"
    # WAV: starts with 'RIFF' and bytes 8-12 are 'WAVE'
    if header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "wav"
    # WebM/Matroska: EBML magic
    if header[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    return None


# Container boxes worth descending into on the way to trak→mdia→hdlr. 'meta'
# is deliberately NOT here: m4a files carry a meta/hdlr with handler 'mdir'
# (iTunes metadata) that must not count as a media track.
_MP4_CONTAINER_BOXES = frozenset({b"moov", b"trak", b"mdia"})


def _mp4_handler_types(f, start: int, end: int, depth: int = 0) -> set[bytes]:
    """Walk MP4 boxes in [start, end) collecting hdlr handler types.

    Header-seek walk: payloads are never read (an mdat of gigabytes is skipped
    by one seek), only container boxes are recursed. Malformed sizes abort the
    walk rather than raise — the caller treats an inconclusive walk as audio.
    """
    handlers: set[bytes] = set()
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        header = f.read(8)
        if len(header) < 8:
            break
        size = int.from_bytes(header[:4], "big")
        box_type = header[4:8]
        header_len = 8
        if size == 1:  # 64-bit largesize follows
            large = f.read(8)
            if len(large) < 8:
                break
            size = int.from_bytes(large, "big")
            header_len = 16
        elif size == 0:  # box extends to end of enclosing scope
            size = end - pos
        if size < header_len:  # malformed
            break
        if box_type == b"hdlr":
            payload = f.read(12)  # version/flags(4) + pre_defined(4) + handler_type(4)
            if len(payload) == 12:
                handlers.add(payload[8:12])
        elif box_type in _MP4_CONTAINER_BOXES and depth < 6:
            handlers |= _mp4_handler_types(
                f, pos + header_len, min(pos + size, end), depth + 1
            )
        pos += size
    return handlers


def _refine_mp4_family(filepath: Path) -> str:
    """Classify a completed 'ftyp' upload as video ('mp4'/'mov') or audio ('m4a').

    A 'vide' track handler is authoritative for video; an 'M4A ' major brand is
    authoritative for audio. Anything inconclusive (no moov, malformed boxes,
    read errors) falls back to 'm4a' — the pre-video behavior.
    """
    try:
        file_size = filepath.stat().st_size
        with open(filepath, "rb") as f:
            brand = b""
            header = f.read(12)
            if len(header) >= 12 and header[4:8] == b"ftyp":
                brand = header[8:12]
            if brand == b"M4A ":
                return "m4a"
            handlers = _mp4_handler_types(f, 0, file_size)
    except OSError as e:
        logger.warning("MP4-family probe failed for %s: %s", filepath, e)
        return "m4a"
    if b"vide" in handlers:
        return "mov" if brand == b"qt  " else "mp4"
    return "m4a"


def _extract_duration(filepath: Path, fmt: str) -> float | None:
    """Extract audio duration in seconds via tinytag (MP3/M4A) or wave stdlib (WAV).

    Best-effort: never raises on a malformed/uploaded file — returns None.
    (tinytag replaced mutagen, which is GPLv2+ and incompatible with the
    project's Apache-2.0 license; 2026-06-01.)
    """
    try:
        if fmt in ("mp3", "m4a", "mp4", "mov", "webm"):
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

    Spool caveat (#544): Starlette parses the multipart body into a spooled
    temp file in the OS temp dir BEFORE this function ever runs — so disk
    usage during an upload is transiently ~2x the file size, the 413 cap only
    fires after the full body has landed, and an ENOSPC in that spool phase
    never reaches the handler below. The app-level OSError handler in main.py
    maps that spool-phase ENOSPC to the same 507. A single-copy fix means
    reading `request.stream()` directly instead of taking an UploadFile —
    deliberately deferred (it bypasses FastAPI's multipart handling).
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
                            "Unsupported media format. Accepted formats: "
                            "MP3, M4A/AAC, WAV audio; MP4, MOV, WebM video.",
                        )
                total += len(chunk)
                if total > max_size:
                    raise HTTPException(413, "Media file exceeds 4GB limit")
                out.write(chunk)
        if fmt is None:
            raise HTTPException(400, "Empty or unreadable media file.")
        if fmt == "m4a":
            # First-chunk sniff can't see moov (may be at end of file) — now
            # that the whole file is on disk, resolve video-MP4 vs m4a audio.
            fmt = _refine_mp4_family(tmp)
        return fmt, tmp
    except OSError as exc:
        # A write that fills the disk (ENOSPC) is a common, actionable failure
        # for multi-GB video — surface it as 507 rather than a generic 500.
        tmp.unlink(missing_ok=True)
        if exc.errno == errno.ENOSPC:
            raise HTTPException(
                507, "Not enough disk space to save the recording."
            ) from exc
        raise
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


@router.post("", response_model=MediaUploadResponse)
async def upload_media(
    project_id: int,
    conversation_id: int,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload an audio or video file for a conversation."""
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
    conversation.media_filename = file.filename or f"media.{fmt}"
    conversation.media_format = fmt
    conversation.media_type = "video" if fmt in VIDEO_FORMATS else "audio"
    conversation.media_duration_seconds = duration
    conversation.media_offset_seconds = 0.0  # Reset on new upload
    conversation.media_is_vbr = is_vbr

    log_action(
        db,
        action="media_upload",
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

    return MediaUploadResponse(
        media_filename=conversation.media_filename,
        media_format=conversation.media_format,
        media_type=conversation.media_type,
        media_duration_seconds=conversation.media_duration_seconds,
        media_offset_seconds=conversation.media_offset_seconds,
        media_is_vbr=conversation.media_is_vbr,
    )


@router.get("/stream")
async def stream_media(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Stream the media file with HTTP Range support for seeking."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if not conversation.media_filename:
        raise HTTPException(404, "No media file attached to this conversation")

    media_path = _media_dir(project_id, conversation_id) / f"original.{conversation.media_format}"
    if not media_path.is_file():
        raise HTTPException(404, "Media file not found on disk")

    media_types = {
        "mp3": "audio/mpeg",
        "m4a": "audio/mp4",
        "wav": "audio/wav",
        "mp4": "video/mp4",
        "mov": "video/quicktime",
        "webm": "video/webm",
    }

    return FileResponse(
        path=str(media_path),
        media_type=media_types.get(conversation.media_format, "application/octet-stream"),
        filename=conversation.media_filename,
        headers={
            "Accept-Ranges": "bytes",
            # no-cache (revalidate, not no-store): a replaced recording must
            # never serve stale bytes for up to a day (#549). NOTE Starlette's
            # FileResponse sets an ETag but does NOT answer If-None-Match with
            # 304, so revalidation is a refetch — negligible on the loopback
            # deployment. The client additionally cache-busts via the
            # media_version query param, so app-driven fetches never rely on
            # revalidation at all. Revisit with real 304 support if a
            # networked (VPS) deployment ships.
            "Cache-Control": "private, no-cache",
        },
    )


@router.delete("")
async def delete_media(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove the media file from a conversation."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if not conversation.media_filename:
        raise HTTPException(404, "No media file attached to this conversation")

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
        action="media_delete",
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
    data: MediaOffsetUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update the media sync offset for a conversation."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if not conversation.media_filename:
        raise HTTPException(404, "No media file attached to this conversation")

    conversation.media_offset_seconds = data.offset_seconds

    log_action(
        db,
        action="media_offset_change",
        entity_type="conversation",
        entity_id=conversation.id,
        user_id=user.id,
        project_id=project_id,
        details={"offset_seconds": data.offset_seconds},
    )
    db.commit()
    db.refresh(conversation)

    return conversation_to_response(conversation, db)
