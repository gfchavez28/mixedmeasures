from collections.abc import Generator
from dataclasses import dataclass, field

from .dataset_import import CsvRecords, OverlongRecords
from .timestamp import parse_timestamp

# 🔴 **A transcript reads through `CsvRecords`, the dataset doors' reader (#1127).**
# It was a `csv.DictReader(io.StringIO(text))` of its own, and that reader had five
# defects the dataset side had already fixed, each reproduced before this change:
#   - a quotation mark that did not pair up merged the turns after it into one,
#     silently (lenient reading — the reader is now strict, with a sentence and a line);
#   - Excel's byte-order mark stayed in the first heading, so a batch mixing an Excel
#     "CSV UTF-8" transcript with a plain one blocked on two names that look identical;
#   - a short row padded with None, and the preview's `.strip()` answered 500 — so did
#     a line of spaces;
#   - a comma inside text that is not in quotation marks CUT the turn at the comma (the
#     rest went under DictReader's `None` key and was dropped) — now REPORTED, at the
#     preview and in the import's warnings, the dataset doors' #985 rule;
#   - a duplicated heading read the LAST column (#973 (b')'s defect) — now the first.
# Cells are POSITIONAL; a row is built from a heading → position map.


@dataclass
class CSVPreviewResult:
    """Result of previewing a CSV file."""
    headers: list[str]
    sample_rows: list[dict]
    total_rows: int
    unique_speakers: list[str]
    detected_columns: dict  # Maps column types to header names
    unique_values_by_column: dict  # Maps column names to list of unique values
    # #1127: rows with more values than headings — usually an unquoted comma in the
    # text, which cuts the turn there. The dataset doors' payload shape (#985).
    overlong_records: dict = field(default_factory=dict)


@dataclass
class ImportedSegment:
    """A segment parsed from CSV."""
    sequence_order: int
    speaker_label: str
    text: str
    start_time: float | None
    end_time: float | None


def detect_columns(headers: list[str]) -> dict:
    """
    Auto-detect column types based on common header names.

    Returns dict mapping column types to header names.
    """
    detected = {}

    speaker_keywords = ['speaker', 'name', 'participant', 'who', 'person']
    text_keywords = ['text', 'transcript', 'content', 'utterance', 'message', 'body']
    start_time_keywords = ['start', 'begin', 'time', 'timestamp']
    end_time_keywords = ['end', 'stop', 'finish']

    headers_lower = [h.lower() for h in headers]

    for i, header in enumerate(headers_lower):
        # Check for speaker
        if not detected.get('speaker'):
            for kw in speaker_keywords:
                if kw in header:
                    detected['speaker'] = headers[i]
                    break

        # Check for text
        if not detected.get('text'):
            for kw in text_keywords:
                if kw in header:
                    detected['text'] = headers[i]
                    break

        # Check for start time (but not end time)
        if not detected.get('start_time'):
            is_end = any(kw in header for kw in end_time_keywords)
            if not is_end:
                for kw in start_time_keywords:
                    if kw in header:
                        detected['start_time'] = headers[i]
                        break

        # Check for end time
        if not detected.get('end_time'):
            for kw in end_time_keywords:
                if kw in header:
                    detected['end_time'] = headers[i]
                    break

    return detected


def _heading_positions(headers: list[str]) -> dict[str, int]:
    """Heading → column position, the FIRST column winning a duplicated heading."""
    positions: dict[str, int] = {}
    for index, heading in enumerate(headers):
        positions.setdefault(heading, index)
    return positions


def _row(positions: dict[str, int], cells: list[str]) -> dict[str, str]:
    """One record as heading → value; a cell a short row left off reads as empty."""
    return {h: (cells[i] if i < len(cells) else "") for h, i in positions.items()}


def _records(file_content: bytes, encoding: str) -> CsvRecords:
    """The transcript's records — raises `CsvReadError` (a `csv.Error` AND a
    `ValueError`) naming the line, for a file the reader refuses."""
    return CsvRecords(file_content.decode(encoding))


def preview_csv(
    file_content: bytes,
    encoding: str = 'utf-8',
    sample_size: int = 10
) -> CSVPreviewResult:
    """
    Preview a CSV file without full import.

    Args:
        file_content: Raw file bytes
        encoding: File encoding
        sample_size: Number of rows to preview

    Returns:
        Preview result with headers, sample, and detected columns
    """
    records = _records(file_content, encoding)
    headers = records.header
    positions = _heading_positions(headers)
    detected_columns = detect_columns(headers)

    sample_rows = []
    total_rows = 0

    # Collect unique values for ALL columns (for speaker column remapping)
    unique_values_by_column: dict[str, set[str]] = {h: set() for h in positions}

    for cells in records:
        row = _row(positions, cells)
        total_rows += 1
        if len(sample_rows) < sample_size:
            sample_rows.append(row)

        # Collect unique values for each column
        for header, raw in row.items():
            value = raw.strip()
            if value:
                unique_values_by_column[header].add(value)

    # Convert sets to sorted lists
    unique_values_sorted = {h: sorted(values) for h, values in unique_values_by_column.items()}

    # For backwards compatibility, also return unique_speakers from detected column
    speaker_col = detected_columns.get('speaker')
    unique_speakers = unique_values_sorted.get(speaker_col, []) if speaker_col else []

    return CSVPreviewResult(
        headers=headers,
        sample_rows=sample_rows,
        total_rows=total_rows,
        unique_speakers=unique_speakers,
        detected_columns=detected_columns,
        unique_values_by_column=unique_values_sorted,
        overlong_records=records.overlong.as_payload(),
    )


def parse_csv_streaming(
    file_content: bytes,
    column_mapping: dict,
    speaker_mapping: dict,
    encoding: str = 'utf-8'
) -> Generator[ImportedSegment, None, None]:
    """
    Parse CSV file and yield segments.

    Args:
        file_content: Raw file bytes
        column_mapping: Maps 'speaker', 'text', 'start_time', 'end_time' to column names
        speaker_mapping: Maps original speaker labels to normalized names
        encoding: File encoding

    Yields:
        ImportedSegment objects
    """
    yield from _segments(_records(file_content, encoding), column_mapping, speaker_mapping)


def _segments(
    records: CsvRecords,
    column_mapping: dict,
    speaker_mapping: dict,
) -> Generator[ImportedSegment, None, None]:
    """The turns of an already-opened transcript. `sequence_order` is the record's
    index, a skipped empty turn included — the numbering `csv.DictReader` gave."""
    positions = _heading_positions(records.header)
    speaker_col = column_mapping.get('speaker')
    text_col = column_mapping.get('text')
    start_time_col = column_mapping.get('start_time')
    end_time_col = column_mapping.get('end_time')

    if not text_col:
        raise ValueError("Text column must be specified")

    for i, cells in enumerate(records):
        row = _row(positions, cells)
        # Get text
        text_content = row.get(text_col, '').strip()
        if not text_content:
            continue

        # Get speaker
        speaker_label = ''
        if speaker_col:
            original_speaker = row.get(speaker_col, '').strip()
            speaker_label = speaker_mapping.get(original_speaker, original_speaker)

        # Get timestamps
        start_time = None
        end_time = None

        if start_time_col and row.get(start_time_col):
            start_time = parse_timestamp(row[start_time_col])

        if end_time_col and row.get(end_time_col):
            end_time = parse_timestamp(row[end_time_col])

        yield ImportedSegment(
            sequence_order=i,
            speaker_label=speaker_label,
            text=text_content,
            start_time=start_time,
            end_time=end_time
        )


def _format_seconds_hhmmss(seconds: float) -> str:
    """Format seconds as HH:MM:SS (matches what the CSV would have shown).

    Used by `_check_backward_timestamps` so warning messages display
    timestamps in the same format the researcher wrote in their source CSV.
    """
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _check_backward_timestamps(segments: list[ImportedSegment]) -> list[str]:
    """#356: detect consecutive segments whose timestamps run backward in time.

    A backward jump (`seg[i].start_time < seg[i-1].end_time`) usually means
    a transcription error in the source CSV — segment 13 might claim to
    start before segment 12 ends. Mixed Measures preserves CSV row order
    (sequence_order), so the segments still display in the right order, but
    audio scrubbing and any downstream timeline analysis goes weird.

    Returns a list of human-readable warning strings, capped at 5 detailed
    entries plus a `… and N more` summary if more exist. Segments with
    `None` start/end times are skipped entirely (they're absent, not
    "backward"). Validation runs AFTER time normalization so timestamps in
    the warning text match what the researcher will see in the UI.
    """
    warnings: list[str] = []
    cap = 5

    backward_pairs: list[tuple[ImportedSegment, ImportedSegment]] = []
    for i in range(1, len(segments)):
        prev = segments[i - 1]
        cur = segments[i]
        if prev.end_time is None or cur.start_time is None:
            continue
        if cur.start_time < prev.end_time:
            backward_pairs.append((prev, cur))

    for prev, cur in backward_pairs[:cap]:
        warnings.append(
            f"Row {cur.sequence_order + 1}: starts at "
            f"{_format_seconds_hhmmss(cur.start_time)}, earlier than row "
            f"{prev.sequence_order + 1} ends ({_format_seconds_hhmmss(prev.end_time)}). "
            f"May indicate a transcription error in the source CSV."
        )
    extra = len(backward_pairs) - cap
    if extra > 0:
        warnings.append(f"… and {extra} more segment(s) with backward timestamps.")

    return warnings


def _overlong_warnings(overlong: OverlongRecords) -> list[str]:
    """#1127: the too-long rows, as import warnings. A comma inside text that is not
    in quotation marks splits the row there, so the text after it lands in the next
    column or, past the last heading, is not imported at all."""
    warnings = [
        f"Line {example['line']:,} has more values than the file has headings "
        f"({example['cells']} for {overlong.header_width}), so part of that row was not "
        "imported — usually a comma inside the text that is not in quotation marks."
        for example in overlong.examples
    ]
    extra = overlong.count - len(overlong.examples)
    if extra > 0:
        warnings.append(f"… and {extra:,} more row(s) like it.")
    return warnings


def import_csv_to_segments(
    file_content: bytes,
    column_mapping: dict,
    speaker_mapping: dict,
    encoding: str = 'utf-8',
    normalize_times: bool = True
) -> tuple[list[ImportedSegment], list[str]]:
    """
    Import CSV file to a list of segments + collect import-time warnings.

    Args:
        file_content: Raw file bytes
        column_mapping: Maps column types to header names
        speaker_mapping: Maps original speaker labels to normalized names
        encoding: File encoding
        normalize_times: Whether to normalize timestamps to start at 0

    Returns:
        Tuple of (list of ImportedSegment, list of warning strings).
        Warnings include backward-timestamp detection (#356).
    """
    records = _records(file_content, encoding)
    segments = list(_segments(records, column_mapping, speaker_mapping))

    if normalize_times and segments:
        # Find minimum start time
        min_time = None
        for seg in segments:
            if seg.start_time is not None:
                if min_time is None or seg.start_time < min_time:
                    min_time = seg.start_time

        # Normalize
        if min_time is not None and min_time > 0:
            for seg in segments:
                if seg.start_time is not None:
                    seg.start_time -= min_time
                if seg.end_time is not None:
                    seg.end_time -= min_time

    # #356: backward-timestamp warnings — run AFTER normalization so the
    # times shown in the warning match what the researcher sees in the UI.
    # #1127: the too-long rows first — they say text is MISSING, which outranks order.
    warnings = _overlong_warnings(records.overlong) + _check_backward_timestamps(segments)

    return segments, warnings
