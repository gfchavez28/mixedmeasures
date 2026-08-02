"""Media (audio/video) file management for conversations — upload, stream, delete, offset."""

import errno
import logging
import os
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.conversation import Conversation, VIDEO_FORMATS
from ..models.user import User
from ..schemas.conversation import MediaOffsetUpdate, MediaUploadResponse
from ..services import media_storage
from ..services.audit import log_action
from ..services.media_duration import (  # noqa: F401 — re-exported, see __all__
    _EBML_DEFAULT_TIMECODE_SCALE,
    _EBML_DURATION,
    _EBML_INFO,
    _EBML_MAX_ELEMENTS,
    _EBML_SEGMENT,
    _EBML_TIMECODE_SCALE,
    _ebml_find,
    _ebml_read_id,
    _ebml_read_size,
    _ebml_vint_len,
    _extract_duration,
    _mp4_duration,
    _mp4_find_box,
    _webm_duration,
    MAX_MEDIA_DURATION_SECONDS,
    sane_duration,
    sanitize_duration_hint,
)
from .helpers import _get_observation_or_404, _get_project_or_404
from .conversations import conversation_to_response

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_MEDIA_SIZE = 4 * 1024 * 1024 * 1024  # 4 GB (raised from 500 MB for video; streaming path is bounded-memory so the cap is policy)
UPLOAD_CHUNK = 1024 * 1024  # 1 MiB — stream granularity (never buffer whole file)

# VIDEO_FORMATS is hosted in models/conversation.py (services consume it too);
# re-exported here because this router is the format seam's home. The duration
# probes moved to services/media_duration.py for the same reason (#574's startup
# backfill is not an HTTP caller and must not import a router) and are
# re-exported here unchanged — the #578 pattern, so callsites stay put.
__all__ = ["VIDEO_FORMATS", "MAX_MEDIA_SIZE"]


# The on-disk path convention lives in ONE place — services/media_storage.py —
# and is shared by the conversation layout ({id}/) and the observation layout
# (obs-{id}/), by the response stat block, and by .mmproject export/import. This
# module deliberately has no local copy of it.


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


MEDIA_MIME = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "wav": "audio/wav",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "webm": "video/webm",
}


# ── Owner-agnostic recording handlers (Observations track, slab 1) ──────────
#
# A recording hangs off a Conversation (an aid beside the transcript) or an
# Observation (the material itself). NOTHING about attaching, streaming or
# detaching one differs between them: the format sniff, the mp4-family refine,
# the chunked spool, the ENOSPC guard, the atomic replace, the stale-format
# sweep and the six media columns are identical. Only three things differ, and
# they are the three arguments below:
#
#   owner       — the ALREADY-RESOLVED ORM row  ⚠️ see the authz note
#   owner_kind  — media_storage.CONVERSATION | OBSERVATION. Doubles as the
#                 on-disk dir segment AND the audit entity_type (same word).
#   (response)  — built by the CALLER, since each owner has its own schema.
#
# ⚠️ AUTHZ: these handlers do NO ownership checking. They take an owner that the
# ROUTER already gated (`_get_conversation` / `_get_observation_or_404`). That is
# deliberate: it keeps the gate call inside each endpoint, by name, where the
# fail-closed AST sweep (tests/test_ownership_gate_sweep.py) can SEE it. An
# injected owner-resolver would have hidden the gate behind a parameter and
# forced a GATE_TOKENS/allowlist entry — i.e. it would have bought DRY at the
# cost of the guarantee that exists because ownership rotted in six routers at
# once (#553). Never call these from anywhere that hasn't gated the owner.


async def attach_recording(
    db: Session, *, project_id: int, owner, owner_kind: str,
    file: UploadFile, user_id: int, duration_hint: float | None = None,
) -> None:
    """Attach a recording to a media owner. Sets the six media columns + commits.

    `duration_hint` is a client-measured length used ONLY when the server cannot
    read one itself (WebM, or an unparsable header). It is what keeps an
    Observation's timeline from being NULL-length on those files.
    """
    media_path = media_storage.media_owner_dir(project_id, owner_kind, owner.id)

    # Stream to a temp file (bounded memory). The old recording is left untouched
    # until the new file is fully written and validated.
    fmt, tmp = await _stream_upload_to_temp(file, media_path, MAX_MEDIA_SIZE)

    # Atomically swap the new file into place, then drop any stale original of a
    # *different* prior format. os.replace is atomic within the dir, so a crash
    # here can't leave a half-written original.
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

    # Server probe first; the client's measurement is a FALLBACK, never an
    # override — we prefer the bytes on disk to anything the caller asserts.
    duration = _extract_duration(dest, fmt)
    if duration is None:
        duration = sanitize_duration_hint(duration_hint)
    is_vbr = _detect_vbr(dest, fmt)

    owner.media_filename = file.filename or f"media.{fmt}"
    owner.media_format = fmt
    owner.media_type = "video" if fmt in VIDEO_FORMATS else "audio"
    owner.media_duration_seconds = duration
    # Reset on every new upload. For an Observation this is definitionally 0 (the
    # recording IS the timeline) and no endpoint can change it — there is no
    # /offset mount for observations.
    owner.media_offset_seconds = 0.0
    owner.media_is_vbr = is_vbr

    log_action(
        db,
        action="media_upload",
        entity_type=owner_kind,
        entity_id=owner.id,
        user_id=user_id,
        project_id=project_id,
        details={
            "filename": owner.media_filename,
            "format": fmt,
            "duration_seconds": duration,
            "is_vbr": is_vbr,
        },
    )
    db.commit()
    db.refresh(owner)


def _copy_file_chunked(src: Path, dest_dir: Path, fmt: str) -> Path:
    """Copy a recording into `dest_dir` as original.{fmt}. Blocking — call in a threadpool.

    Same shape as the upload path: stage to a temp file IN THE TARGET DIR, then
    os.replace it into place (atomic within a dir), so a crash or a full disk can
    never leave a truncated `original.*` that stats as a real, playable file.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".copy-", suffix=".part", dir=str(dest_dir))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
            # Chunked: a 4 GB recording must never be buffered whole (#567).
            shutil.copyfileobj(inp, out, UPLOAD_CHUNK)
        dest = dest_dir / f"original.{fmt}"
        os.replace(str(tmp), str(dest))
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        if exc.errno == errno.ENOSPC:
            raise HTTPException(
                507, "Not enough disk space to copy the recording."
            ) from exc
        raise
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

    # Drop any stale original of a *different* prior format (an id can be reused
    # after a delete, so the target dir is not guaranteed to be empty).
    for stale in dest_dir.glob("original.*"):
        if stale != dest:
            try:
                stale.unlink()
            except OSError:
                logger.warning("Could not remove stale media file %s", stale)
    return dest


async def copy_recording(
    db: Session, *, project_id: int,
    source_owner, source_kind: str,
    target_owner, target_kind: str,
    user_id: int,
) -> None:
    """Re-use an existing recording on another source, without a re-upload.

    This is the escape hatch (D17). It COPIES the file — it never shares the path.
    Both `delete_conversation` and `delete_observation` rmtree their owner's media
    dir, so a shared file would be deleted out from under the surviving source.
    The disk cost is real and the UI states it.

    It carries the FILE, never the coding: the new source starts with no codes.
    That is why this is "also code this as an Observation", not "convert" —
    nothing moves.
    """
    if not source_owner.media_filename or not source_owner.media_format:
        raise HTTPException(409, "That source has no recording to re-use.")

    src = (
        media_storage.media_owner_dir(project_id, source_kind, source_owner.id)
        / f"original.{source_owner.media_format}"
    )
    if not src.exists():
        # The row claims a recording the disk doesn't have (#551).
        raise HTTPException(409, "That source's recording file is missing from disk.")

    fmt = source_owner.media_format
    dest_dir = media_storage.media_owner_dir(project_id, target_kind, target_owner.id)

    # A same-disk copy of a multi-GB file takes tens of seconds — off the event
    # loop, or it stalls every other request (and Electron's /health probe).
    await run_in_threadpool(_copy_file_chunked, src, dest_dir, fmt)

    target_owner.media_filename = source_owner.media_filename
    target_owner.media_format = fmt
    target_owner.media_type = source_owner.media_type
    target_owner.media_duration_seconds = source_owner.media_duration_seconds
    target_owner.media_is_vbr = source_owner.media_is_vbr
    # Never copied: a conversation's offset aligns its TRANSCRIPT to the recording.
    # On an observation the recording IS the timeline, so an inherited offset would
    # shear every clip against it. A fresh attach resets it either way.
    target_owner.media_offset_seconds = 0.0

    log_action(
        db,
        action="media_copy",
        entity_type=target_kind,
        entity_id=target_owner.id,
        user_id=user_id,
        project_id=project_id,
        details={
            "filename": target_owner.media_filename,
            "format": fmt,
            "source_kind": source_kind,
            "source_id": source_owner.id,
        },
    )
    db.commit()
    db.refresh(target_owner)


def stream_recording(project_id: int, owner, owner_kind: str) -> FileResponse:
    """Stream an owner's recording with HTTP Range support for seeking."""
    if not owner.media_filename:
        raise HTTPException(404, "No media file attached")

    media_path = (
        media_storage.media_owner_dir(project_id, owner_kind, owner.id)
        / f"original.{owner.media_format}"
    )
    if not media_path.is_file():
        raise HTTPException(404, "Media file not found on disk")

    return FileResponse(
        path=str(media_path),
        media_type=MEDIA_MIME.get(owner.media_format, "application/octet-stream"),
        filename=owner.media_filename,
        headers={
            # no-cache (revalidate, not no-store): a replaced recording must
            # never serve stale bytes for up to a day (#549). NOTE Starlette's
            # FileResponse sets an ETag but does NOT answer If-None-Match with
            # 304, so revalidation is a refetch — negligible on the loopback
            # deployment. The client additionally cache-busts via the
            # media_version query param, so app-driven fetches never rely on
            # revalidation at all. Revisit with real 304 support if a
            # networked (VPS) deployment ships.
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-cache",
        },
    )


def detach_recording(
    db: Session, *, project_id: int, owner, owner_kind: str, user_id: int,
) -> None:
    """Remove an owner's recording from disk and clear its six media columns."""
    if not owner.media_filename:
        raise HTTPException(404, "No media file attached")

    media_path = media_storage.media_owner_dir(project_id, owner_kind, owner.id)
    try:
        if media_path.is_dir():
            shutil.rmtree(str(media_path))
    except Exception:
        logger.warning("Failed to clean up media files at %s", media_path)

    old_filename = owner.media_filename
    owner.media_filename = None
    owner.media_format = None
    owner.media_type = None
    owner.media_duration_seconds = None
    owner.media_offset_seconds = 0.0
    owner.media_is_vbr = None

    log_action(
        db,
        action="media_delete",
        entity_type=owner_kind,
        entity_id=owner.id,
        user_id=user_id,
        project_id=project_id,
        details={"filename": old_filename},
    )
    db.commit()
    db.refresh(owner)


def media_upload_response(owner) -> MediaUploadResponse:
    """The shared upload payload — the six media columns, same for every owner."""
    return MediaUploadResponse(
        media_filename=owner.media_filename,
        media_format=owner.media_format,
        media_type=owner.media_type,
        media_duration_seconds=owner.media_duration_seconds,
        media_offset_seconds=owner.media_offset_seconds,
        media_is_vbr=owner.media_is_vbr,
    )


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
    duration_seconds: float | None = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload an audio or video file for a conversation.

    `duration_seconds` is the browser's own measurement, used only if the server
    cannot read the length from the file (WebM has no reader here).
    """
    conversation = _get_conversation(db, project_id, conversation_id, user.id)
    await attach_recording(
        db, project_id=project_id, owner=conversation,
        owner_kind=media_storage.CONVERSATION, file=file, user_id=user.id,
        duration_hint=duration_seconds,
    )
    return media_upload_response(conversation)


@router.post("/from-observation/{observation_id}", response_model=MediaUploadResponse)
async def reuse_observation_recording(
    project_id: int,
    conversation_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Re-use an observation's recording on this conversation (D17, reverse).

    The mirror of the observation-side hatch: someone who coded a session's
    timeline and now wants to code what was SAID imports the transcript as usual
    and then attaches the recording they already uploaded, instead of sending the
    same gigabytes twice.

    Deliberately shaped as an ATTACH, not a "create a Conversation from this
    observation". There is no bare conversation-create endpoint — a Conversation
    is born from a transcript and cannot exist without segments — so a "create"
    form of this would have to manufacture a transcript-less conversation, which
    is precisely the dead-end state the importer already refuses to make.
    """
    conversation = _get_conversation(db, project_id, conversation_id, user.id)
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)

    await copy_recording(
        db, project_id=project_id,
        source_owner=observation, source_kind=media_storage.OBSERVATION,
        target_owner=conversation, target_kind=media_storage.CONVERSATION,
        user_id=user.id,
    )
    return media_upload_response(conversation)


@router.get("/stream")
async def stream_media(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Stream the media file with HTTP Range support for seeking."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)
    return stream_recording(project_id, conversation, media_storage.CONVERSATION)


@router.delete("")
async def delete_media(
    project_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove the media file from a conversation."""
    conversation = _get_conversation(db, project_id, conversation_id, user.id)
    detach_recording(
        db, project_id=project_id, owner=conversation,
        owner_kind=media_storage.CONVERSATION, user_id=user.id,
    )
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
