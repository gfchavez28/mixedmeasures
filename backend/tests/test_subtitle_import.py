"""#524 — VTT/SRT subtitle → conversation-CSV adapter.

Covers the three speaker sources (voice tags, Zoom name prefixes, default),
hours-optional timestamps, same-speaker cue merging into turns, and the
end-to-end contract: the converted CSV must flow through the EXISTING
conversation preview (column auto-detection) and timestamp parser unchanged.
"""
import pytest

from app.services.csv_import import preview_csv
from app.services.subtitle_import import (
    SubtitleImportError,
    is_subtitle_upload,
    merge_same_speaker_cues,
    parse_subtitle_cues,
    subtitles_to_csv_bytes,
)
from app.services.timestamp import parse_timestamp

VTT_VOICE_TAGS = """WEBVTT

00:00:01.000 --> 00:00:04.000
<v Alice Rivera>Thanks everyone for joining.</v>

00:00:04.500 --> 00:00:07.000
<v Alice Rivera>Let's start with the fidelity data.</v>

00:00:07.500 --> 00:00:12.000
<v Ben Okafor>Sure — the May numbers are ready.</v>
"""

ZOOM_STYLE = """WEBVTT

1
00:00:01.000 --> 00:00:03.000
Alice Rivera: Thanks everyone for joining.

a3f8c2e1-0b7d-4c11-9a55-2f6f0e8d9b21
00:00:03.500 --> 00:00:06.000
Alice Rivera: We have a full agenda today.

3
00:05.500 --> 00:08.000
Ben Okafor: Happy to kick things off.
"""

SRT_NO_SPEAKER = """1
00:00:01,000 --> 00:00:04,000
Once upon a time there was a fable.

2
00:00:04,500 --> 00:00:08,000
It had no speakers at all.
"""


def test_voice_tags_extract_speakers_and_strip_markup():
    cues = parse_subtitle_cues(VTT_VOICE_TAGS)
    assert [c["speaker"] for c in cues] == ["Alice Rivera", "Alice Rivera", "Ben Okafor"]
    assert cues[0]["text"] == "Thanks everyone for joining."
    assert "<" not in cues[0]["text"]


def test_zoom_name_prefix_and_cue_id_lines():
    cues = parse_subtitle_cues(ZOOM_STYLE)
    # Numeric + UUID cue-identifier lines are skipped; names come from the prefix.
    assert [c["speaker"] for c in cues] == ["Alice Rivera", "Alice Rivera", "Ben Okafor"]
    assert cues[0]["text"] == "Thanks everyone for joining."
    # Hours-optional timestamp (Zoom under-an-hour form): 00:05.500 = 5.5s.
    assert cues[2]["start"] == pytest.approx(5.5)


def test_srt_defaults_to_single_speaker():
    cues = parse_subtitle_cues(SRT_NO_SPEAKER, default_speaker="Narrator")
    assert [c["speaker"] for c in cues] == ["Narrator", "Narrator"]
    assert cues[0]["start"] == pytest.approx(1.0)
    assert cues[1]["end"] == pytest.approx(8.0)


def test_same_speaker_cues_merge_into_turns():
    turns = merge_same_speaker_cues(parse_subtitle_cues(VTT_VOICE_TAGS))
    assert len(turns) == 2, "two Alice cues collapse into one turn"
    assert turns[0]["speaker"] == "Alice Rivera"
    assert turns[0]["text"] == "Thanks everyone for joining. Let's start with the fidelity data."
    assert turns[0]["start"] == pytest.approx(1.0)
    assert turns[0]["end"] == pytest.approx(7.0), "merged turn spans first start → last end"


def test_csv_bytes_flow_through_existing_preview_and_timestamp_parser():
    blob = subtitles_to_csv_bytes(VTT_VOICE_TAGS.encode("utf-8"))
    lines = blob.decode("utf-8").splitlines()
    assert lines[0] == "Speaker,Text,Start,End"
    # The emitted HH:MM:SS.mmm parses with the pipeline's own timestamp parser.
    first_start = lines[1].split(",")[2]
    assert parse_timestamp(first_start) == pytest.approx(1.0)

    result = preview_csv(blob, "utf-8")
    assert result.total_rows == 2
    assert set(result.unique_speakers) == {"Alice Rivera", "Ben Okafor"}
    # Column auto-detection maps the canonical headers without user remapping.
    assert result.detected_columns.get("speaker") == "Speaker"
    assert result.detected_columns.get("text") == "Text"
    assert result.detected_columns.get("start_time") == "Start"


def test_garbage_and_extension_gating():
    with pytest.raises(SubtitleImportError, match="No transcript cues"):
        subtitles_to_csv_bytes(b"just some prose with no cues at all")
    assert is_subtitle_upload("meeting.vtt")
    assert is_subtitle_upload("MEETING.SRT")
    assert not is_subtitle_upload("meeting.csv")
    assert not is_subtitle_upload(None)
