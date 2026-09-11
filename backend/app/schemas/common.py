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


def strip_required_text(field: str):
    """Build an after-validator that trims a required text field and refuses a
    whitespace-only value (#556a, generalised for #925).

    🔴 **The ordering trap this exists for: `min_length=1` is a CONSTRAINT,
    evaluated on the RAW input BEFORE any after-validator runs** — so `"   "`
    satisfies it and arrives here. The empty-after-strip check below is what
    actually rejects it, and a field declared with `min_length=1` and no validator
    stores whatever the constraint let through.

    `field` is required rather than derived so the message names the field the way
    `ParticipantCreate`'s did before this was shared; the field name is already in
    Pydantic's `loc`, but the sentence is what a researcher sees.

    Two live instances of the gap this closes, both reached by API or script
    rather than by the UI (which trims and disables its submit button):
    `DatasetCreate` stored `""` because the router stripped AFTER validation, and
    `DatasetUpdate` stored the padding verbatim because nothing stripped at all.
    """
    def _strip(value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError(f"{field} cannot be blank or whitespace-only")
        return stripped

    return _strip


def strip_optional_text(value: str | None) -> str | None:
    """Trim a nullable text field; blank-after-strip normalizes to None.

    A field whose absence and whose emptiness mean the same thing should not have
    two representations — every reader then needs `or None` and one of them
    forgets. Shared with `ParticipantCreate.display_name` / `.role`, where the
    value also propagates into speaker names.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


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
    # #35 — this coder's rating on the code's declared scale, or None for UNRATED.
    #
    # Rides the detail rather than a parallel array for the same reason `user_id`
    # does: a detail IS the (code, coder) pair, which is exactly the grain a rating
    # lives at. ⚠️ None means unrated and NEVER zero — a real 0 is a legal rating on
    # any scale whose range includes it, so no consumer may coerce one to the other.
    magnitude: float | None = None
    # #35 — the rating a MERGED copy of this same application carried when it
    # differed from ours (the merge kept ours, flagged the difference). None =
    # no unresolved conflict. The coder clears it by rating again.
    magnitude_conflict: float | None = None
