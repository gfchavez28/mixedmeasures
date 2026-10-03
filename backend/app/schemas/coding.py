from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from .common import UTCTimestamp


class ApplyCodeRequest(BaseModel):
    attribution: str | None = None
    # #35 — rate at the moment of applying (variant A's one-round-trip form).
    #
    # ⚠️ OMITTED and `null` mean different things and the endpoint tells them
    # apart with `model_fields_set`: omitted leaves any existing rating alone,
    # explicit `null` clears it. Collapsing the two would make every ordinary
    # apply-without-a-rating silently unrate an already-rated application.
    magnitude: float | None = None


class MagnitudeValueUpdate(BaseModel):
    """Set or clear one coder's rating on one already-applied code (#35).

    `magnitude: null` is an explicit *unrate* — the value an Esc-skip stores, and
    never the same as a rating of zero.
    """
    magnitude: float | None = None


class BulkCodeRequest(BaseModel):
    # Bounded to match the text-coding sibling (BulkCodeRequest there has carried
    # min/max since it shipped). Unbounded, a single post could ask the server to
    # walk an arbitrary id list and emit a result row per entry.
    segment_ids: list[int] = Field(..., min_length=1, max_length=5000)
    code_id: int
    action: str = "apply"
    attribution: str | None = None

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        if v not in ("apply", "remove"):
            raise ValueError("action must be 'apply' or 'remove'")
        return v


class ReplacedOnTarget(BaseModel):
    """#1070 — the values one apply removed from ONE segment of a group."""
    segment_id: int
    replaced_code_ids: list[int]


class CodeApplicationResponse(BaseModel):
    segment_id: int | None = None
    dataset_value_id: int | None = None
    code_id: int
    applied: bool
    created_at: UTCTimestamp | None = None
    # #35 — this coder's rating, or None for UNRATED. Never coerce a None here to
    # 0 for the wire: the client renders the two differently on purpose, and a
    # zero is a legal rating on any scale whose range includes it.
    magnitude: float | None = None
    # #1028 — the codes this apply REMOVED because the applied code is a value of
    # a code set and this coder held another value of it here (a passage takes
    # one). Empty for every ordinary code. On a single apply it covers the whole
    # segment group; in a bulk result it is THIS segment's. A client says what
    # was replaced, and an undo re-applies exactly these.
    replaced_code_ids: list[int] = []
    # #1070 — the same report PER SEGMENT, on a single apply that fanned out to a
    # segment group. The siblings of a group routinely differ (grouping does not
    # unify their codings), so the merged list above cannot say which passage lost
    # which value — and an undo that put the union back everywhere gave a sibling
    # a value it never had. Empty wherever nothing was replaced.
    replaced_by_target: list[ReplacedOnTarget] = []


class BulkCodeResponse(BaseModel):
    results: list[CodeApplicationResponse]
    success_count: int
    error_count: int
    # #678: WHICH ids the server could not act on — not just how many.
    #
    # `results[].applied` cannot answer this, because it means different things
    # per action: on an APPLY it is True for success, but on a REMOVE it is False
    # for *success* ("the code is now not applied"), which is the same value a
    # skipped id carries. A client reconciling on `applied` alone would treat
    # every successful bulk-remove as a total failure. Keep this list explicit and
    # leave `applied` untouched — it is load-bearing at the single-apply/remove
    # call sites, so redefining it is a separate and riskier change.
    failed_segment_ids: list[int] = []


class CodingProgressResponse(BaseModel):
    conversation_id: int
    total_segments: int
    coded_segments: int
    participant_segments: int
    participant_coded: int
    progress_percent: float


class RatingQueueEntryResponse(BaseModel):
    """One outstanding rating act on the sweep surface (#35 variant B).

    ⚠️ `scale` is REQUIRED, not optional. An entry only reaches the queue
    because its code declares an instrument, and a nullable field here would
    invite a client branch for a state the query cannot produce — the shape
    that lets a "not rated" render over a rating nobody can see.
    """

    code_id: int
    code_name: str
    code_color: str | None = None
    scale: dict

    #: Which endpoint commits this one: "segment" or "dataset_value".
    target_kind: str
    #: Exactly one of these is set, matching the CodeApplication target CHECK.
    segment_id: int | None = None
    dataset_value_id: int | None = None

    source_type: str
    source_id: int
    source_label: str
    text: str
    start_time: float | None = None
    end_time: float | None = None
    record_identifier: str | None = None

    #: Segments this ONE rating covers. >1 only for a coded segment GROUP,
    #: which is rated as one unit because it is coded as one.
    n_targets: int


class RatingQueueCodeCountResponse(BaseModel):
    """One code's outstanding rating count, named."""

    code_id: int
    code_name: str
    outstanding: int


class RatingQueueResponse(BaseModel):
    """The queue window plus what it is a window ONTO.

    ⚠️ There is no offset (see `services/rating_queue.py`): entries leave the
    list as they are rated, so paging into it by index skips work. `total` is
    what a progress indicator reads; `truncated` says more remain than were
    returned.
    """

    entries: list[RatingQueueEntryResponse]
    total: int
    truncated: bool
    #: Per-code coverage, because thin ratings on ONE code are what make that
    #: code's agreement figure misleading and a single global percentage hides
    #: it. ⚠️ Each entry carries its NAME: the counts span the whole queue
    #: while `entries` is one batch, so a client naming these from `entries`
    #: labels a chip with a bare id exactly when the queue is long enough for
    #: the filter to be worth having.
    per_code: list[RatingQueueCodeCountResponse]
