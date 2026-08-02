"""Media duration probing — container-level length extraction.

Lives in a service, not in `routers/media.py`, so that non-HTTP callers (the
startup backfill in `media_backfill.py`) can read a recording's length without
importing a router module. Same move as #578's `recompute_primary_value_numeric`:
the router re-exports these names unchanged, so every existing callsite and test
keeps working.

Every function here is best-effort and never raises on a malformed upload.
"""

import logging
import math
import struct
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


# A recording longer than this is almost certainly a bad number rather than a
# real session, whoever produced it. Bounds EVERY duration source, not just the
# client hint it was originally written for — see `sane_duration`.
MAX_MEDIA_DURATION_SECONDS = 24 * 60 * 60

# How far a recording may be shifted against its transcript. Lives here, beside
# the duration bound, because TWO places must agree on it: `MediaOffsetUpdate`
# (the API's own constraint) and the `.mmproject` import's sanitizer — an import
# must not accept what the API refuses (#625). A literal in each was the drift.
MAX_MEDIA_OFFSET_SECONDS = 300.0


def sane_duration(value: float | None) -> float | None:
    """The one bound every duration passes through before it nears the DB.

    Non-finite is the arm that matters, and it is newly reachable: WebM's
    `Duration` is an IEEE float read verbatim from an untrusted upload, so inf
    and NaN are directly representable in the file's bytes. Every earlier source
    was finite by construction (`_mp4_duration` divides integers; the client hint
    was already filtered here), which is why nothing downstream guards for it —
    `cut_clips` tests `duration is None or <= 0`, and **inf passes that (inf > 0)
    while NaN passes it too (NaN <= 0 is False)**, reaching `math.ceil` as an
    OverflowError/ValueError. A non-finite value also serializes as a bare
    `Infinity`, which is not JSON-compliant and 500s the response.
    """
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0 or value > MAX_MEDIA_DURATION_SECONDS:
        return None
    return value


def sanitize_duration_hint(hint: float | None) -> float | None:
    """Validate a client-measured duration before it is allowed near the DB.

    The browser's `HTMLMediaElement.duration` is the length source we fall back to
    when a container carries no answer, and it is often better than a container
    probe. But it is client-supplied, so it is bounded like any other: a
    live/headerless WebM reports Infinity, which `sane_duration` drops.
    """
    return sane_duration(hint)


def _mp4_find_box(f, start: int, end: int, target: bytes) -> tuple[int, int] | None:
    """Return the (payload_start, payload_end) of the first `target` box in [start, end).

    Header-seek only: an mdat of gigabytes is skipped by one seek, never read.
    Malformed sizes abort the walk rather than raise.
    """
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
        elif size == 0:  # box extends to the end of the enclosing scope
            size = end - pos
        if size < header_len:  # malformed
            break
        if box_type == target:
            return pos + header_len, min(pos + size, end)
        pos += size
    return None


# mvhd's duration/timescale are the movie header's, i.e. the whole recording's.
# 32-bit all-ones (v0) / 64-bit all-ones (v1) is the spec's "duration unknown"
# sentinel used by fragmented MP4 — treat it as no answer, not as 2^32 ticks.
_MVHD_UNKNOWN = (0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF)


def _mp4_duration(filepath: Path) -> float | None:
    """Read a recording's length from its MP4-family `moov/mvhd` box.

    Covers mp4 AND mov: the box layout is identical, only the ftyp brand differs.

    We parse this ourselves because **tinytag cannot read `.mov` or `.webm` at
    all** — it dispatches on extension/brand, and neither appears in its
    SUPPORTED_FILE_EXTENSIONS (verified against tinytag 2.2.1), so both formats
    silently yielded `media_duration_seconds = None`. For a Conversation that was
    harmless (the recording is a playback aid and the browser reports its own
    duration), which is why it went unnoticed. For an Observation the recording
    IS the timeline: the server cuts clips against this number and slab 3 draws
    the ruler from it, so a NULL means zero clips and no timeline.
    """
    try:
        file_size = filepath.stat().st_size
        with open(filepath, "rb") as f:
            moov = _mp4_find_box(f, 0, file_size, b"moov")
            if moov is None:
                return None
            mvhd = _mp4_find_box(f, moov[0], moov[1], b"mvhd")
            if mvhd is None:
                return None
            f.seek(mvhd[0])
            version_flags = f.read(4)
            if len(version_flags) < 4:
                return None
            if version_flags[0] == 1:
                # creation(8) + modification(8) + timescale(4) + duration(8)
                payload = f.read(28)
                if len(payload) < 28:
                    return None
                timescale = int.from_bytes(payload[16:20], "big")
                ticks = int.from_bytes(payload[20:28], "big")
            else:
                # creation(4) + modification(4) + timescale(4) + duration(4)
                payload = f.read(16)
                if len(payload) < 16:
                    return None
                timescale = int.from_bytes(payload[8:12], "big")
                ticks = int.from_bytes(payload[12:16], "big")
    except OSError as e:
        logger.warning("MP4 duration probe failed for %s: %s", filepath, e)
        return None

    if timescale <= 0 or ticks in _MVHD_UNKNOWN:
        return None
    seconds = ticks / timescale
    return seconds if seconds > 0 else None


# --- WebM / Matroska (EBML) -------------------------------------------------
#
# Element ids are held as their ENCODED byte sequences, deliberately. An EBML id
# carries its length-marker bit as part of its identity (`Segment` IS the four
# bytes 18 53 80 67), whereas a size VINT strips the marker to yield a value.
# The two conventions look alike and are not: mixing them puts every subsequent
# offset off by a nibble, and the walk then reads plausible garbage rather than
# failing loudly.
_EBML_SEGMENT = b"\x18\x53\x80\x67"
_EBML_INFO = b"\x15\x49\xa9\x66"
_EBML_TIMECODE_SCALE = b"\x2a\xd7\xb1"
_EBML_DURATION = b"\x44\x89"

# Matroska's default when the element is absent: nanoseconds per tick.
_EBML_DEFAULT_TIMECODE_SCALE = 1_000_000
# A bound, not a limit any real header approaches — Info sits within the first
# handful of elements. Stops a malformed file from walking forever.
_EBML_MAX_ELEMENTS = 4096


def _ebml_vint_len(first: int) -> int:
    """Byte length of a VINT from its first byte. 0 means undecodable.

    Unlike MP4's fixed-width big-endian sizes — where a corrupt byte is merely a
    wrong number — an EBML length is self-describing, so a leading 0x00 has no
    valid length at all and must abort the walk rather than be interpreted.
    """
    if first == 0:
        return 0
    return 8 - first.bit_length() + 1


def _ebml_read_id(f) -> bytes | None:
    """Read an element id, returned as its raw encoded bytes (marker included)."""
    first = f.read(1)
    if not first:
        return None
    length = _ebml_vint_len(first[0])
    if length == 0 or length > 4:  # ids are at most 4 bytes
        return None
    rest = f.read(length - 1)
    if len(rest) < length - 1:
        return None
    return first + rest


def _ebml_read_size(f) -> tuple[int | None, bool]:
    """Read a size VINT. Returns (value, ok); value is None for "unknown size".

    "Unknown size" (every value bit set) is what a live/streamed muxer writes —
    Chrome's `MediaRecorder.start(timeslice)` emits it on `Segment` itself. As an
    integer it is 2**56-1, so it is kept OUT of arithmetic and signalled as None.

    Note the walker also clamps every payload end to the enclosing bound, which
    independently defuses this value — so the explicit None arm is deliberate
    redundancy, not a load-bearing guard (mutation-verified: replacing it with
    clamped arithmetic changes no observable behavior). It is kept because it
    states the trap at the point a reader meets it, and because the clamp could
    later be refactored away by someone who reads it as pointless.
    """
    first = f.read(1)
    if not first:
        return None, False
    length = _ebml_vint_len(first[0])
    if length == 0 or length > 8:
        return None, False
    rest = f.read(length - 1)
    if len(rest) < length - 1:
        return None, False
    value = first[0] & ((1 << (8 - length)) - 1)
    for byte in rest:
        value = (value << 8) | byte
    if value == (1 << (7 * length)) - 1:
        return None, True
    return value, True


def _ebml_find(f, start: int, end: int, target: bytes) -> tuple[int, int] | None:
    """Return the (payload_start, payload_end) of the first `target` in [start, end).

    Header-seek only, exactly like `_mp4_find_box`: payloads are skipped by seek,
    never read. Malformed input aborts the walk rather than raising.
    """
    pos = start
    seen = 0
    while pos < end and seen < _EBML_MAX_ELEMENTS:
        seen += 1
        f.seek(pos)
        element_id = _ebml_read_id(f)
        if element_id is None:
            break
        size, ok = _ebml_read_size(f)
        if not ok:
            break
        payload_start = f.tell()
        # An unknown-size element runs to the end of its enclosing scope.
        # An unknown-size element runs to the end of its enclosing scope.
        payload_end = end if size is None else min(payload_start + size, end)
        if element_id == target:
            return payload_start, payload_end
        if size is None:
            break  # cannot seek past an element whose length is undeclared
        if payload_end <= pos:
            break  # no forward progress: malformed
        pos = payload_end
    return None


def _webm_duration(filepath: Path) -> float | None:
    """Read a recording's length from its WebM/Matroska `Segment > Info`.

    `Duration` is in timecode ticks and `TimecodeScale` gives nanoseconds per
    tick, so seconds = Duration * TimecodeScale / 1e9.

    Returns None whenever the container does not carry an answer — which is a
    real population, not a corner case: a live-muxed WebM (`MediaRecorder` with a
    timeslice) has an unknown-size Segment, no Duration, unknown-size Clusters
    and no Cues, so its length is only recoverable by scanning every block. That
    would abandon the header-seek-only property that keeps this safe on 4 GB
    inputs, so we decline it and let the client hint answer instead. Files a user
    picks off disk — any normal muxer, and even buffered MediaRecorder output —
    carry the element and read correctly.
    """
    try:
        file_size = filepath.stat().st_size
        with open(filepath, "rb") as f:
            segment = _ebml_find(f, 0, file_size, _EBML_SEGMENT)
            if segment is None:
                return None
            info = _ebml_find(f, segment[0], segment[1], _EBML_INFO)
            if info is None:
                return None

            timecode_scale = _EBML_DEFAULT_TIMECODE_SCALE
            scale_span = _ebml_find(f, info[0], info[1], _EBML_TIMECODE_SCALE)
            if scale_span is not None:
                f.seek(scale_span[0])
                raw_scale = f.read(scale_span[1] - scale_span[0])
                if raw_scale:
                    timecode_scale = int.from_bytes(raw_scale, "big")

            duration_span = _ebml_find(f, info[0], info[1], _EBML_DURATION)
            if duration_span is None:
                return None
            f.seek(duration_span[0])
            raw_duration = f.read(duration_span[1] - duration_span[0])
    except OSError as e:
        logger.warning("WebM duration probe failed for %s: %s", filepath, e)
        return None

    # BOTH float widths occur in the wild: Chrome's MediaRecorder writes 4 bytes,
    # other muxers write 8. A float64-only reader passes a synthetic fixture and
    # then mis-reads real browser output.
    if len(raw_duration) == 4:
        ticks = struct.unpack(">f", raw_duration)[0]
    elif len(raw_duration) == 8:
        ticks = struct.unpack(">d", raw_duration)[0]
    else:
        return None
    if timecode_scale <= 0:
        return None
    return sane_duration(ticks * timecode_scale / 1_000_000_000)


def _extract_duration(filepath: Path, fmt: str) -> float | None:
    """Extract a recording's duration in seconds, bounded (#625).

    THE single exit for every container probe: whatever branch answers, its
    number passes `sane_duration` exactly once, here. That is what makes
    "`sane_duration` is the ONE bound every source passes" a structural fact
    rather than a claim maintained by hand — `_probe_duration` has five separate
    `return` statements, so wrapping them individually would leave five places to
    forget, and #625 was precisely the two that had been.

    What this catches that the per-branch guards do not: a corrupt or hostile
    `mvhd` (timescale 1, a huge tick count) produces an absurd but perfectly
    FINITE duration that every existing check waves through — `_mp4_duration`
    only rejects `<= 0`. The tinytag branch is looser still: `tag.duration` is a
    float tinytag COMPUTES (bitrate/filesize arithmetic on a VBR mp3), not
    integer/frame arithmetic we control, so ruling out non-finite there was
    never ours to assert.

    `_webm_duration` still bounds internally and is now bounded twice; the
    function is idempotent, and the inner call stays because it guards the one
    branch where inf/NaN are directly representable in the file's bytes.
    """
    return sane_duration(_probe_duration(filepath, fmt))


def _probe_duration(filepath: Path, fmt: str) -> float | None:
    """Read the container's own answer — unbounded; callers use `_extract_duration`.

    MP4 family (mp4/mov/m4a) is read from `moov/mvhd` directly — exact, and the
    only way to get `.mov` at all (see `_mp4_duration`). WebM is walked as EBML
    (see `_webm_duration`), which answers whenever the container carries a
    `Duration`; when it does not, the caller falls back to a client-measured
    duration hint. MP3 falls to tinytag; WAV to the wave stdlib.

    Best-effort: never raises on a malformed/uploaded file — returns None.
    (tinytag replaced mutagen, which is GPLv2+ and incompatible with the
    project's Apache-2.0 license; 2026-06-01.)
    """
    try:
        if fmt == "webm":
            return _webm_duration(filepath)
        if fmt in ("mp4", "mov", "m4a"):
            duration = _mp4_duration(filepath)
            if duration is not None:
                return duration
            # m4a can still be read by tinytag; mp4/mov cannot, so they end here.
            if fmt != "m4a":
                return None
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
