import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

from app.services.timestamp import parse_timestamp, normalize_timestamps, format_timestamp


# ── parse_timestamp ───────────────────────────────────────────────────────────


def test_parse_hms():
    assert parse_timestamp("01:23:45") == 5025.0


def test_parse_hms_with_milliseconds():
    result = parse_timestamp("01:23:45.500")
    assert result == 5025.5


def test_parse_mmss():
    assert parse_timestamp("05:30") == 330.0


def test_parse_mmss_with_milliseconds():
    result = parse_timestamp("05:30.250")
    assert result == 330.25


def test_parse_seconds_string():
    """A large numeric string (>=10) is treated as raw seconds."""
    assert parse_timestamp("90") == 90.0


def test_parse_seconds_decimal_large():
    """A decimal >= 10 is treated as seconds, not a day fraction."""
    assert parse_timestamp("90.5") == 90.5


def test_parse_day_fraction():
    """A small decimal (<10 with '.') is treated as a day fraction."""
    result = parse_timestamp("0.5")
    assert result == 43200.0  # half a day


def test_parse_days_hms():
    result = parse_timestamp("1 days, 02:30:00")
    assert result == 86400 + 9000  # 1 day + 2.5 hours


def test_parse_none():
    assert parse_timestamp(None) is None


def test_parse_empty_string():
    assert parse_timestamp("") is None


def test_parse_invalid_string():
    assert parse_timestamp("not a timestamp") is None


def test_parse_whitespace_stripped():
    assert parse_timestamp("  01:00:00  ") == 3600.0


# ── normalize_timestamps ─────────────────────────────────────────────────────


def test_normalize_start_from_zero():
    segments = [
        {"start_time": "00:01:00", "end_time": "00:01:30"},
        {"start_time": "00:02:00", "end_time": "00:02:30"},
    ]
    result = normalize_timestamps(segments, start_from_zero=True)
    assert result[0]["start_time"] == 0.0
    assert result[0]["end_time"] == 30.0
    assert result[1]["start_time"] == 60.0
    assert result[1]["end_time"] == 90.0


def test_normalize_no_start_from_zero():
    segments = [
        {"start_time": "00:05:00", "end_time": "00:05:30"},
    ]
    result = normalize_timestamps(segments, start_from_zero=False)
    # Timestamps are parsed but not shifted
    assert result[0]["start_time"] == 300.0
    assert result[0]["end_time"] == 330.0


def test_normalize_empty_list():
    assert normalize_timestamps([]) == []


def test_normalize_missing_timestamps():
    """Segments without timestamps pass through safely."""
    segments = [{"text": "hello"}]
    result = normalize_timestamps(segments, start_from_zero=True)
    assert result == [{"text": "hello"}]


# ── format_timestamp ─────────────────────────────────────────────────────────


def test_format_with_hours():
    assert format_timestamp(3661.0) == "01:01:01"


def test_format_without_hours():
    assert format_timestamp(65.0) == "01:05"


def test_format_none():
    assert format_timestamp(None) == ""


def test_format_zero():
    assert format_timestamp(0.0) == "00:00"
