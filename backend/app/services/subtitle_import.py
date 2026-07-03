"""VTT/SRT subtitle → conversation-CSV adapter (#524).

Zoom and Teams export meeting transcripts as WebVTT (.vtt); SubRip (.srt) is the
older sibling. This module converts either into the CSV shape the existing
conversation import pipeline consumes (``preview_csv`` / ``import_csv_to_segments``
run unchanged downstream) — the same adapter-at-the-boundary pattern as the .xlsx
dataset import (#523). Ported from the audio-sync fixture script
``transcript_to_csv.py`` (git-ignored), with Zoom-specific additions.

Speaker sources, in priority order:
- WebVTT voice tags: ``<v Alice Rivera>text</v>``
- Zoom-style name prefixes on the cue text: ``Alice Rivera: text`` (bounded
  heuristic so sentence colons aren't mistaken for names)
- Otherwise a single default speaker (SRT has no speaker concept).

Consecutive same-speaker cues are merged into one TURN (first cue's start, last
cue's end): subtitle cues are caption-length fragments, while the coding
workbench segments by conversational turn. Cue-level granularity, if ever
wanted, is available via split in the workbench.
"""

import csv
import io
import re

# Hours are optional (Zoom emits MM:SS.mmm for meetings under an hour).
_TS = r"(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})"
_TS_RE = re.compile(rf"{_TS}\s*-->\s*{_TS}")
_VOICE_RE = re.compile(r"<v\s+([^>]+)>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")

# Zoom-style "Name: text" prefix — bounded so sentence colons don't read as names:
# ≤ 40 chars before the colon, no sentence punctuation, at least 2 characters.
_NAME_PREFIX_RE = re.compile(r"^([^:.!?\n]{2,40}):\s+(.+)$", re.DOTALL)

DEFAULT_SPEAKER = "Speaker 1"

SUBTITLE_EXTENSIONS = (".vtt", ".srt")


class SubtitleImportError(ValueError):
    """User-facing subtitle parse failure (surfaced as HTTP 400)."""


def is_subtitle_upload(filename: str | None) -> bool:
    return bool(filename) and filename.lower().endswith(SUBTITLE_EXTENSIONS)


def _group_to_sec(h: str | None, m: str, s: str, ms: str) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / (10 ** len(ms))


def _fmt_ts(seconds: float) -> str:
    """Seconds → HH:MM:SS.mmm (what services/timestamp.parse_timestamp accepts)."""
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def parse_subtitle_cues(raw: str, default_speaker: str = DEFAULT_SPEAKER) -> list[dict]:
    """Parse VTT/SRT text into cue dicts: {speaker, text, start, end}.

    Cue-identifier lines (SRT indices, Zoom's UUID lines) are skipped by
    anchoring each block on its ``-->`` timestamp line.
    """
    cues: list[dict] = []
    blocks = re.split(r"\r?\n\r?\n+", raw.strip())
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        cue_line = next((ln for ln in lines if _TS_RE.search(ln)), None)
        if not cue_line:
            continue
        m = _TS_RE.search(cue_line)
        start = _group_to_sec(*m.group(1, 2, 3, 4))
        end = _group_to_sec(*m.group(5, 6, 7, 8))
        text = " ".join(lines[lines.index(cue_line) + 1:]).strip()
        if not text or text.upper() == "WEBVTT":
            continue

        speaker = default_speaker
        vm = _VOICE_RE.search(text)
        if vm:
            speaker = vm.group(1).strip()
            text = _TAG_RE.sub("", text).strip()
        else:
            text = _TAG_RE.sub("", text).strip()
            nm = _NAME_PREFIX_RE.match(text)
            if nm:
                speaker = nm.group(1).strip()
                text = nm.group(2).strip()
        if not text:
            continue
        cues.append({"speaker": speaker, "text": text, "start": start, "end": end})
    return cues


def merge_same_speaker_cues(cues: list[dict]) -> list[dict]:
    """Merge consecutive same-speaker cues into turns (see module docstring)."""
    turns: list[dict] = []
    for cue in cues:
        if turns and turns[-1]["speaker"] == cue["speaker"]:
            turns[-1]["text"] += " " + cue["text"]
            turns[-1]["end"] = cue["end"]
        else:
            turns.append(dict(cue))
    return turns


def subtitles_to_csv_bytes(content: bytes, encoding: str = "utf-8") -> bytes:
    """Convert a VTT/SRT upload into conversation-CSV bytes (UTF-8).

    Headers ``Speaker,Text,Start,End`` match the conversation wizard's column
    auto-detection keywords, so the mapping step arrives pre-mapped. The caller
    must treat the RESULT as UTF-8 regardless of the upload's encoding.
    """
    try:
        raw = content.decode(encoding)
    except (UnicodeDecodeError, LookupError) as e:
        raise SubtitleImportError(
            "Unable to decode the subtitle file. Ensure it uses UTF-8 or the specified encoding."
        ) from e

    turns = merge_same_speaker_cues(parse_subtitle_cues(raw))
    if not turns:
        raise SubtitleImportError(
            "No transcript cues found. Expected a WebVTT (.vtt) or SubRip (.srt) "
            "file with '-->' timestamp lines."
        )

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["Speaker", "Text", "Start", "End"])
    for t in turns:
        writer.writerow([t["speaker"], t["text"], _fmt_ts(t["start"]), _fmt_ts(t["end"])])
    return out.getvalue().encode("utf-8")
