"""Shared schema field types."""
from datetime import datetime, timezone
from typing import Annotated

from pydantic import PlainSerializer


def utc_wire(dt: datetime) -> str:
    """Serialize a stored naive-UTC datetime as ISO-8601 with an explicit +00:00 offset."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


# Wire type for timestamp fields (#408). ORM DateTime columns store naive UTC;
# serialized offset-less, `new Date()` parses the UTC clock time as LOCAL time,
# so every rendered date is the UTC calendar day (wrong for any UTC-negative
# user after ~19:00 local). `when_used="json"` keeps Python-mode model_dump()
# returning datetime objects — only the JSON boundary changes.
#
# Calendar-date fields (conversation_date) must stay plain `datetime`: they
# carry no time-of-day meaning, and shifting them to the viewer's timezone
# would move user-entered dates across midnight.
UTCTimestamp = Annotated[
    datetime,
    PlainSerializer(utc_wire, return_type=str, when_used="json"),
]
