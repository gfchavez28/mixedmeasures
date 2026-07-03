"""Shared schema field types."""
from datetime import datetime, timezone
from typing import Annotated

from pydantic import BaseModel, PlainSerializer


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


class AppliedCodeDetail(BaseModel):
    """Per-application coder attribution for a coded segment/value (Track J · J1).

    Sibling to the bare ``applied_codes`` / ``applied_code_ids`` ID arrays: carries
    *who* applied each code so the frontend can render attribution badges and run
    the per-coder visibility filter. ``is_universal`` lets the same payload drive
    the coder-scoped ``isSegmentCoded`` predicate (invariant J-A) without a second
    lookup. Deliberately ADDITIVE — the ID arrays stay, so the conversation
    optimistic-patch path (which treats ``applied_codes`` as ``number[]``) is
    untouched. The document workbench enriches its existing ``SegmentCodeResponse``
    objects with ``user_id`` instead of carrying a parallel list.
    """
    code_id: int
    user_id: int | None = None
    attribution: str | None = None
    is_universal: bool = False
