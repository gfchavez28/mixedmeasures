import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

from app.services.csv_import import (
    detect_columns, preview_csv, parse_csv_streaming, import_csv_to_segments
)


# ── Test data ─────────────────────────────────────────────────────────────────

CSV_BASIC = (
    b"Speaker,Text,Start,End\n"
    b"Alice,Hello,00:01:00,00:01:30\n"
    b"Bob,Hi there,00:01:35,00:02:00\n"
)

CSV_NO_TIMESTAMPS = (
    b"Speaker,Text\n"
    b"Alice,Hello world\n"
    b"Bob,Goodbye world\n"
)

CSV_EMPTY_ROW = (
    b"Speaker,Text\n"
    b"Alice,Hello\n"
    b"Bob,\n"
    b"Carol,Goodbye\n"
)


# ── detect_columns ────────────────────────────────────────────────────────────


def test_detect_standard_headers():
    detected = detect_columns(["Speaker", "Text", "Start", "End"])
    assert detected["speaker"] == "Speaker"
    assert detected["text"] == "Text"
    assert detected["start_time"] == "Start"
    assert detected["end_time"] == "End"


def test_detect_variant_names():
    detected = detect_columns(["Participant", "Transcript", "Timestamp", "Finish"])
    assert detected["speaker"] == "Participant"
    assert detected["text"] == "Transcript"
    assert detected["start_time"] == "Timestamp"
    assert detected["end_time"] == "Finish"


def test_detect_missing_columns():
    detected = detect_columns(["Column_A", "Column_B"])
    assert "speaker" not in detected
    assert "text" not in detected


def test_detect_preserves_original_case():
    detected = detect_columns(["SPEAKER", "TEXT"])
    assert detected["speaker"] == "SPEAKER"
    assert detected["text"] == "TEXT"


# ── preview_csv ───────────────────────────────────────────────────────────────


def test_preview_basic():
    result = preview_csv(CSV_BASIC)
    assert result.headers == ["Speaker", "Text", "Start", "End"]
    assert result.total_rows == 2
    assert len(result.sample_rows) == 2
    assert result.sample_rows[0]["Text"] == "Hello"


def test_preview_speaker_detection():
    result = preview_csv(CSV_BASIC)
    assert sorted(result.unique_speakers) == ["Alice", "Bob"]


def test_preview_sample_size_limit():
    many_rows = b"Speaker,Text\n" + b"".join(
        f"S{i},Line {i}\n".encode() for i in range(20)
    )
    result = preview_csv(many_rows, sample_size=5)
    assert len(result.sample_rows) == 5
    assert result.total_rows == 20


def test_preview_unique_values_by_column():
    result = preview_csv(CSV_BASIC)
    assert "Alice" in result.unique_values_by_column["Speaker"]
    assert "Bob" in result.unique_values_by_column["Speaker"]


# ── parse_csv_streaming ──────────────────────────────────────────────────────


def test_parse_basic():
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    segments = list(parse_csv_streaming(CSV_BASIC, mapping, {}))
    assert len(segments) == 2
    assert segments[0].speaker_label == "Alice"
    assert segments[0].text == "Hello"
    assert segments[0].start_time == 60.0
    assert segments[1].start_time == 95.0


def test_parse_speaker_mapping():
    mapping = {"speaker": "Speaker", "text": "Text"}
    speaker_map = {"Alice": "Interviewer", "Bob": "Participant 1"}
    segments = list(parse_csv_streaming(CSV_BASIC, mapping, speaker_map))
    assert segments[0].speaker_label == "Interviewer"
    assert segments[1].speaker_label == "Participant 1"


def test_parse_empty_text_rows_skipped():
    mapping = {"speaker": "Speaker", "text": "Text"}
    segments = list(parse_csv_streaming(CSV_EMPTY_ROW, mapping, {}))
    assert len(segments) == 2
    assert segments[0].text == "Hello"
    assert segments[1].text == "Goodbye"


def test_parse_missing_text_column_raises():
    mapping = {"speaker": "Speaker"}
    try:
        list(parse_csv_streaming(CSV_BASIC, mapping, {}))
        assert False, "Should have raised ValueError"
    except ValueError as e:
        assert "Text column" in str(e)


# ── import_csv_to_segments (full import with timestamp normalization) ─────────


def test_import_normalizes_timestamps():
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    segments, warnings = import_csv_to_segments(CSV_BASIC, mapping, {}, normalize_times=True)
    # First segment's start_time should be shifted to 0
    assert segments[0].start_time == 0.0
    assert segments[0].end_time == 30.0
    assert segments[1].start_time == 35.0
    # Monotonic input → no warnings
    assert warnings == []


def test_import_without_normalization():
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    segments, warnings = import_csv_to_segments(CSV_BASIC, mapping, {}, normalize_times=False)
    # Timestamps remain as parsed, not shifted
    assert segments[0].start_time == 60.0
    assert segments[0].end_time == 90.0
    assert warnings == []


# ═══════════════════════════════════════════════════════════════════════════════
# #356 — backward-timestamp warnings
# ═══════════════════════════════════════════════════════════════════════════════


def _ts_csv(rows: list[tuple[str, str, str, str]]) -> bytes:
    """Build a CSV from (Speaker, Text, Start, End) rows."""
    lines = ["Speaker,Text,Start,End"]
    for sp, tx, st, en in rows:
        lines.append(f'"{sp}","{tx}","{st}","{en}"')
    return ("\n".join(lines)).encode()


def test_import_warns_on_backward_timestamp():
    """Scenario 2 Lincoln case: row 13 starts at 00:07:26, earlier than
    row 12 ends 00:09:26. After fix, this surfaces as an import warning."""
    csv = _ts_csv([
        ("A", "Hello", "00:00:00", "00:05:00"),
        ("B", "World", "00:05:00", "00:09:26"),
        ("C", "Backward",  "00:07:26", "00:10:00"),  # backward
    ])
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    segments, warnings = import_csv_to_segments(csv, mapping, {}, normalize_times=False)
    assert len(segments) == 3
    assert len(warnings) == 1
    assert "Row 3" in warnings[0]
    assert "00:07:26" in warnings[0]
    assert "00:09:26" in warnings[0]


def test_import_caps_warnings_at_five_with_summary():
    """If many backward pairs exist, cap detailed messages at 5 and append a
    summary line. Mirrors DocumentImport warning style."""
    rows = [("A", "x", "00:00:00", "00:01:00")]
    # 10 more rows each starting before the previous ends (all backward)
    for i in range(10):
        rows.append(("B", "y", "00:00:00", "00:01:00"))
    csv = _ts_csv(rows)
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    segments, warnings = import_csv_to_segments(csv, mapping, {}, normalize_times=False)
    # 5 detailed entries + 1 summary
    assert len(warnings) == 6
    assert "5 more" in warnings[-1] or "and 5 more" in warnings[-1]


def test_import_no_warning_on_null_timestamps():
    """Segments without start/end times aren't 'backward' — they're absent.
    Skip them rather than flagging."""
    # Build a CSV without Start/End columns at all — segments parse with None timestamps
    csv = b'Speaker,Text\n"A","Hello"\n"B","World"\n'
    mapping = {"speaker": "Speaker", "text": "Text"}
    segments, warnings = import_csv_to_segments(csv, mapping, {}, normalize_times=False)
    assert len(segments) == 2
    assert warnings == []


def test_import_no_warning_on_strictly_monotonic():
    csv = _ts_csv([
        ("A", "a", "00:00:00", "00:01:00"),
        ("B", "b", "00:01:00", "00:02:00"),
        ("C", "c", "00:02:00", "00:03:00"),
    ])
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    _segments, warnings = import_csv_to_segments(csv, mapping, {}, normalize_times=False)
    assert warnings == []


def test_import_no_warning_on_single_segment():
    csv = _ts_csv([("A", "lone", "00:00:00", "00:01:00")])
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    _segments, warnings = import_csv_to_segments(csv, mapping, {}, normalize_times=False)
    assert warnings == []


def test_import_skips_pairs_with_missing_endpoint():
    """If row[i-1].end_time is None but row[i].start_time is set, can't
    judge backward — skip the comparison."""
    # Build manually since CSV blank-cell behavior varies
    csv = b'Speaker,Text,Start,End\n"A","x","00:00:00",""\n"B","y","00:00:30","00:01:00"\n'
    mapping = {"speaker": "Speaker", "text": "Text", "start_time": "Start", "end_time": "End"}
    _segments, warnings = import_csv_to_segments(csv, mapping, {}, normalize_times=False)
    assert warnings == []
