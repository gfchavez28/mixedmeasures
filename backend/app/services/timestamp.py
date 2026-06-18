import re


def parse_timestamp(timestamp_str: str) -> float | None:
    """
    Parse various timestamp formats and normalize to seconds.

    Supported formats:
    - HH:MM:SS (e.g., "01:23:45")
    - HH:MM:SS.mmm (e.g., "01:23:45.123")
    - N days, HH:MM:SS (e.g., "1 days, 02:30:00")
    - Decimal day fractions (e.g., "0.5" = 12 hours)
    - MM:SS (e.g., "05:30")
    - Seconds only (e.g., "90.5")

    Returns:
        Seconds from interview start, or None if parsing fails.
    """
    if not timestamp_str:
        return None

    timestamp_str = timestamp_str.strip()

    # Pattern: N days, HH:MM:SS
    days_pattern = re.match(r'^(\d+)\s*days?,?\s*(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$', timestamp_str, re.IGNORECASE)
    if days_pattern:
        days = int(days_pattern.group(1))
        hours = int(days_pattern.group(2))
        minutes = int(days_pattern.group(3))
        seconds = int(days_pattern.group(4))
        milliseconds = int(days_pattern.group(5) or 0)

        total_seconds = (
            days * 86400 +
            hours * 3600 +
            minutes * 60 +
            seconds +
            (milliseconds / (10 ** len(str(milliseconds))) if days_pattern.group(5) else 0)
        )
        return total_seconds

    # Pattern: HH:MM:SS or HH:MM:SS.mmm
    hms_pattern = re.match(r'^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$', timestamp_str)
    if hms_pattern:
        hours = int(hms_pattern.group(1))
        minutes = int(hms_pattern.group(2))
        seconds = int(hms_pattern.group(3))
        frac = hms_pattern.group(4)

        total_seconds = hours * 3600 + minutes * 60 + seconds
        if frac:
            total_seconds += int(frac) / (10 ** len(frac))
        return total_seconds

    # Pattern: MM:SS or MM:SS.mmm
    ms_pattern = re.match(r'^(\d{1,2}):(\d{2})(?:\.(\d+))?$', timestamp_str)
    if ms_pattern:
        minutes = int(ms_pattern.group(1))
        seconds = int(ms_pattern.group(2))
        frac = ms_pattern.group(3)

        total_seconds = minutes * 60 + seconds
        if frac:
            total_seconds += int(frac) / (10 ** len(frac))
        return total_seconds

    # Pattern: Decimal day fraction (e.g., 0.5 = 12 hours)
    try:
        value = float(timestamp_str)
        # If value is less than 10, assume it's a day fraction
        # If it's larger, assume it's already in seconds
        if value < 10 and '.' in timestamp_str:
            # Likely a day fraction
            return value * 86400
        else:
            # Assume seconds
            return value
    except ValueError:
        pass

    return None


def normalize_timestamps(segments: list[dict], start_from_zero: bool = True) -> list[dict]:
    """
    Normalize timestamps in segment data.

    Args:
        segments: List of segment dicts with 'start_time' and optionally 'end_time'
        start_from_zero: If True, subtract the first timestamp so interview starts at 0

    Returns:
        Updated segment list with normalized timestamps
    """
    if not segments:
        return segments

    # Parse all timestamps
    for segment in segments:
        if 'start_time' in segment and segment['start_time']:
            segment['start_time'] = parse_timestamp(str(segment['start_time']))
        if 'end_time' in segment and segment['end_time']:
            segment['end_time'] = parse_timestamp(str(segment['end_time']))

    # Find the minimum timestamp to normalize to 0
    if start_from_zero:
        min_time = None
        for segment in segments:
            if segment.get('start_time') is not None:
                if min_time is None or segment['start_time'] < min_time:
                    min_time = segment['start_time']

        if min_time is not None and min_time > 0:
            for segment in segments:
                if segment.get('start_time') is not None:
                    segment['start_time'] -= min_time
                if segment.get('end_time') is not None:
                    segment['end_time'] -= min_time

    return segments


def format_timestamp(seconds: float | None) -> str:
    """Format seconds as HH:MM:SS for display."""
    if seconds is None:
        return ""

    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    else:
        return f"{minutes:02d}:{secs:02d}"
