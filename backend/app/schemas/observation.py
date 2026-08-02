from pydantic import BaseModel, ConfigDict, Field

from .common import AppliedCodeDetail, UTCTimestamp
from .segment import SegmentNoteInfo


class ObservationCreate(BaseModel):
    name: str
    description: str | None = None


class ObservationNoteCreate(BaseModel):
    """A note on an observation, optionally anchored to a clip.

    ``segment_id`` is OPTIONAL — an observation-level note (no clip) is valid, and
    a clip note keeps ``observation_id`` set so it SURVIVES the clip's deletion as
    an observation-level note (``ck_note_at_least_one_parent`` has no segment arm;
    the parent is always the observation).
    """

    segment_id: int | None = None
    content: str = Field(..., min_length=1)


class ClipCreate(BaseModel):
    """A manually-marked clip (workbench I/O marks, drag, or point event).

    ``start_time == end_time`` is a legal POINT EVENT (D7). No upper clamp
    against the recording's duration — clips past its end are legal (the cue
    posture: the timeline and the recording are independent lengths). Range
    sanity (finite, ordered, non-negative) is checked in the router so the
    frozen 409 can take precedence.
    """

    start_time: float
    end_time: float
    text: str = ""


class ClipUpdate(BaseModel):
    """Boundary and/or label edit. Omitted fields keep their value.

    D22: while the segmentation is FROZEN the time fields 409, but ``text``
    stays editable — a label is annotation, not segmentation.
    """

    start_time: float | None = None
    end_time: float | None = None
    text: str | None = None


class ClipSplitRequest(BaseModel):
    """Split a clip at a timeline time (strictly inside its range)."""

    time: float


class ClipMergeRequest(BaseModel):
    """Merge ≥2 clips of one observation. No adjacency requirement — the
    merged range spans any gaps between them."""

    segment_ids: list[int]


class ClipUnsplitRequest(BaseModel):
    """Rejoin a time-split. Carries BOTH half ids (the split response returned
    them; the undo entry captured them) — sibling discovery by contiguous
    sequence is unsound for time-ordered clips, so the caller must name the
    pair."""

    segment_ids: list[int]


class ObservationSegmentResponse(BaseModel):
    """One clip — the THIRD segment response schema (per plan §0b.6).

    Deliberately the modern ``applied_code_details`` shape (one entry per
    (code, coder) application — the ``lib/coding-progress.ts`` chip chokepoints
    consume it directly in slab 4), NOT ``DocumentSegmentResponse``'s older
    ``codes[]``+``user_id`` shape. ``applied_codes`` stays a bare ``int[]`` for
    the optimistic-patch path (the #441 rule). ``text`` is the clip's label
    (``''`` = unlabelled). Excerpt fields arrive with slab 5's time excerpts.
    """

    id: int
    sequence_order: int
    start_time: float
    end_time: float
    text: str
    applied_codes: list[int] = []
    applied_code_details: list[AppliedCodeDetail] = []
    attached_notes: list[SegmentNoteInfo] = []
    created_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class ClipPreview(BaseModel):
    """One proposed clip, as shown in the wizard before anything is written."""

    sequence_order: int
    start_time: float
    end_time: float
    label: str = ""


class SegmentationPreviewResponse(BaseModel):
    """What cutting WOULD produce. The list is truncated; `total_segments` is not.

    Mirrors the document preview's shape: a long clip list is not worth a
    megabyte of JSON the wizard would only render the head of.
    """

    total_segments: int = 0
    segments: list[ClipPreview] = []
    warnings: list[str] = []


class SegmentationCutResponse(BaseModel):
    observation: "ObservationResponse"
    created: int = 0
    warnings: list[str] = []


class ObservationUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ObservationResponse(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    # D18 — unit provenance. NULL = OPEN (each coder marks their own clips =>
    # unitizing-alpha, no consensus). A timestamp = FROZEN (the team agreed the
    # clips => ordinary kappa + consensus + reconciliation, via the engines that
    # already ship). Drives which reliability surface the UI offers.
    segmentation_frozen_at: UTCTimestamp | None = None
    # Coding-spine counts (clips = time-range segments). Named for the spine;
    # the UI labels them "clips" (D9).
    segment_count: int = 0
    coded_segment_count: int = 0
    code_count: int = 0
    # Timeline coverage (6a) — seconds covered by >=1 non-universal code, with
    # OVERLAP UNIONED (clips point at a timeline, they do not partition it), and
    # the D34 denominator. ALL-CODER scope, deliberately: lists and Overview show
    # every coder's coverage while the blind workbench gauge shows only what is
    # visible to you (#517), and the list row labels that scope.
    # coverage_extent_seconds is None only when there is nothing to measure
    # against — no readable duration AND no clips — so a client can distinguish
    # "0% covered" from "no denominator".
    covered_seconds: float = 0.0
    coverage_extent_seconds: float | None = None
    # Media fields — mirror ConversationResponse. media_offset_seconds is always
    # 0 for an observation (the media IS the timeline) and is not user-editable.
    media_filename: str | None = None
    media_format: str | None = None
    media_type: str | None = None
    media_duration_seconds: float | None = None
    media_offset_seconds: float = 0.0
    media_is_vbr: bool | None = None
    # Derived: a media file is attached (drives management affordances). The
    # player gate is media_type (audio OR video), single-sourced client-side.
    has_media: bool = False
    # On-disk size of the attached recording; None when absent or stat fails.
    media_size_bytes: int | None = None
    # Opaque cache token (#549): mtime_ns + size, changes on every replace so
    # the client can cache-bust the stream URL.
    media_version: str | None = None

    model_config = ConfigDict(from_attributes=True)


SegmentationCutResponse.model_rebuild()
