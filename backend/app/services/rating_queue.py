"""The rating sweep's work queue — what THIS coder applied and has not rated
(#35 variant B, queue row 45 (ii)).

Variant A rates at the moment of applying. Variant B is the second pass: the
same `MagnitudeStrip` on its own surface, over a queue of applications that
carry a declared scale and no rating yet. The two share one control and one
instrument renderer, which is why A was built standalone from day one.

## What is IN the queue, and every clause is a refusal the server would issue

Five filters, mirroring `lib/rating-targets.ts::ratableCodes` (three of them)
plus the two scoping chokepoints every application aggregate owes:

1. 🔴 **This coder's OWN applications.** `set_code_magnitude` filters
   `user_id == user.id` because a rating is one coder's judgement and
   overwriting a colleague's would fabricate agreement. **This also settles the
   blind question** (developer, 2026-09-12): the sweep is own-only and shows no
   colleague's rating, because seeing one before giving yours destroys the
   independence a reliability coefficient needs — the rule already recorded for
   negotiated agreement, reached from the rating side.
   ⚠️ **`user_id` is NULLABLE** — merged legacy data carries an "Unattributed"
   bucket that no coder can rate through any door. `== user_id` excludes it,
   where a naive "unrated applications" query would list rows whose every
   commit 403s (the #806 shape).
2. **A declared scale**, both bounds (`magnitude.has_scale`'s rule inlined as a
   clause). No instrument, no rating.
3. **Active codes only** — `validate_value` refuses `inactive`.
4. **Non-universal** — `scale_refusal` refuses a scale on the 0/1 artifact row,
   so one cannot legitimately exist; the clause keeps a hand-edited database
   from putting an unratable row in a work list.
5. **Visible segments** (`visible_segment_filter`) and **non-consensus rows**
   (`non_consensus_filter`), never hand-rolled. A merged-away original is
   UI-unreachable (#500) and a consensus row's median is derived, not given.

## 🔴 The grain is the RATING ACT, not the application row

`routers/coding.py::_fan_out_rating` writes a rating across every visible
sibling of a segment GROUP for that coder and code, because a group is coded as
one unit and therefore rated as one. Grouped siblings hold their own
`CodeApplication` rows, so a per-application queue would list one judgement
several times, show the siblings as unrated after they had been rated, and drop
its remaining count by more than one per act. **Buckets are keyed
`(code_id, group_id)` for a grouped segment and `(code_id, segment_id)` for a
lone one**, collapsed in SQL so the COUNT is right at any size. `n_targets`
rides each entry so the surface can say what one rating will cover.

⚠️ **The two bucket keys are separate GROUP BY columns, never one concatenated
key.** `group_id` and `segment_id` are different id spaces; a `COALESCE` over
them silently merges group 7 with segment 7.

## 🔴 There is no OFFSET, and that is a correctness decision

Entries LEAVE this list as they are rated. Offset paging over a shrinking list
skips items — the coder would rate page one, ask for page two, and never be
shown the entries that shifted up. So the queue always returns its FIRST
`limit` entries plus a `total` at the collapsed grain; working the queue down
and refetching is what advances it. `total` is what a progress indicator reads,
and `truncated` says the list is a window rather than the whole of it.

⚠️ **Two arms, concatenated in a stated order** — segments (transcripts,
documents, clips) then dataset cells — because they commit through DIFFERENT
endpoints and a researcher reads them as different material. The order within
each arm is by source then position, so a coder works through one source at a
time, which is what makes successive ratings comparable.

⚠️ **Labels and text are batched for the RETURNED page only** (`source_labels`),
never per row and never project-wide.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.segment import Segment
from ..routers.helpers import visible_segment_filter
from .coding_layers import non_consensus_filter
from .magnitude import read_scale
from .source_labels import label_sources

#: How many entries one request returns. A work queue is worked down, not paged
#: through, so this bounds the payload rather than addressing into it.
DEFAULT_QUEUE_LIMIT = 50
MAX_QUEUE_LIMIT = 200

#: How much of a passage rides an entry. The strip needs enough to judge the
#: code against; the whole transcript is the workbench's job.
TEXT_PREVIEW_CHARS = 400

_SOURCE_TAG_FOR_TYPE = {
    "conversation": "conv", "document": "doc",
    "observation": "obs", "column": "col",
}

def _segment_parent_columns():
    """The three segment parents, as `((tag, column), …)`.

    🔴 ONE declaration feeds the sort rank, the tag lookup and the id coalesce,
    so a fourth `Segment` parent cannot acquire a rank without a tag or a tag
    without an id — the arity lesson (#515 → #676) in a three-member set. The
    order is the order sources are PRESENTED to the coder.
    """
    return (
        ("conv", Segment.conversation_id),
        ("doc", Segment.document_id),
        ("obs", Segment.observation_id),
    )


_TAG_BY_RANK = {i: tag for i, (tag, _c) in enumerate(_segment_parent_columns())}

#: 0 for a conversation, 1 for a document, 2 for an observation. A row that
#: matched none would rank past the end and raise in `_segment_source_key`;
#: `ck_segment_exactly_one_parent` makes that unreachable.
_SEGMENT_SOURCE_RANK = case(
    *[(col.isnot(None), i) for i, (_t, col) in enumerate(_segment_parent_columns())],
    else_=len(_TAG_BY_RANK),
)

#: The parent's own id. Coalescing three id spaces is safe HERE and only here:
#: it is read inside a single rank, where exactly one of the three is non-null.
_SEGMENT_SOURCE_ID = func.coalesce(
    *[col for _t, col in _segment_parent_columns()]
)


@dataclass(frozen=True)
class RatingQueueEntry:
    """One rating act waiting to be made."""

    code_id: int
    code_name: str
    code_color: str | None
    scale: dict
    #: "segment" | "dataset_value" — which endpoint commits it.
    target_kind: str
    #: The commit target. For a grouped segment, ANY member works: the fan-out
    #: writes the rating across the whole group, so the representative is the
    #: lowest id purely for determinism.
    segment_id: int | None
    dataset_value_id: int | None
    source_type: str
    source_id: int
    source_label: str
    text: str
    start_time: float | None
    end_time: float | None
    record_identifier: str | None
    #: How many segments this ONE rating will cover (>1 only for a group).
    n_targets: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "code_id": self.code_id,
            "code_name": self.code_name,
            "code_color": self.code_color,
            "scale": self.scale,
            "target_kind": self.target_kind,
            "segment_id": self.segment_id,
            "dataset_value_id": self.dataset_value_id,
            "source_type": self.source_type,
            "source_id": self.source_id,
            "source_label": self.source_label,
            "text": self.text,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "record_identifier": self.record_identifier,
            "n_targets": self.n_targets,
        }


@dataclass(frozen=True)
class RatingQueueCodeCount:
    """One code's outstanding count, NAMED.

    🔴 **The name rides the count and is not looked up from `entries`.** The
    counts span the whole queue while `entries` is one batch, so a code with
    nothing in the current window has no entry to take a name from — a client
    deriving names that way labels those chips with a bare id, and does so
    exactly when the queue is long enough for the filter to matter.
    """

    code_id: int
    code_name: str
    outstanding: int


@dataclass(frozen=True)
class RatingQueue:
    entries: tuple[RatingQueueEntry, ...] = ()
    #: Rating acts outstanding at the collapsed grain, across BOTH arms.
    total: int = 0
    #: True when `entries` is a window onto a longer queue.
    truncated: bool = False
    #: Per-code coverage — the number a researcher needs, because thin ratings
    #: on ONE code are what make its agreement figure misleading and a single
    #: global percentage hides that. Ordered most-outstanding first.
    #:
    #: 🔴 **Spans the WHOLE queue even when `code_id` narrows `entries` and
    #: `total` (#979).** It is the picker: narrowed to its own selection it
    #: offers no other code to switch to, and once the selected code is worked
    #: to zero it empties and takes the way out with it. It is also the only
    #: unfiltered quantity on the payload, so **`sum(outstanding)` is the
    #: all-codes total** — which is why no separate field carries it.
    per_code: tuple[RatingQueueCodeCount, ...] = ()


def _scaled_code_clauses():
    """Filters 2–4: the code may carry, and still carries, an instrument.

    Kept together because they are one question — *is this code ratable?* — and
    splitting them across call sites is how a fourth door forgets one.
    """
    return (
        Code.magnitude_min.isnot(None),
        Code.magnitude_max.isnot(None),
        Code.is_active == True,  # noqa: E712
        Code.is_universal == False,  # noqa: E712
    )


def _unrated_clauses(user_id: int):
    """Filters 1 and 5, minus the segment-only visibility clause."""
    return (
        CodeApplication.user_id == user_id,
        CodeApplication.magnitude.is_(None),
        non_consensus_filter(),
    )


def _segment_buckets(db: Session, project_id: int, user_id: int, code_id: int | None):
    """The grouped-by-rating-act query for the three segment parents.

    ⚠️ `group_id` and the ungrouped `segment_id` are SEPARATE grouping columns
    (see the module docstring) — exactly one is non-null per bucket.
    """
    solo_id = case((Segment.group_id.is_(None), Segment.id), else_=None)
    query = (
        db.query(
            CodeApplication.code_id.label("code_id"),
            Segment.group_id.label("group_id"),
            solo_id.label("solo_id"),
            # 🔴 The parent is a GROUPING column, not `func.min` over one.
            # Ordering by `MIN(conversation_id)` sorts NULL-parent rows FIRST
            # in SQLite, so documents and clips would come before
            # conversations while the ordering read as source-major. Grouping
            # by them is free: a segment has exactly one parent
            # (`ck_segment_exactly_one_parent`) and a group is
            # conversation-scoped, so neither column can vary inside a bucket.
            _SEGMENT_SOURCE_RANK.label("source_rank"),
            _SEGMENT_SOURCE_ID.label("source_id"),
            func.min(Segment.id).label("segment_id"),
            func.count(func.distinct(Segment.id)).label("n_targets"),
            func.min(Segment.sequence_order).label("sequence_order"),
        )
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(
            Code.project_id == project_id,
            *_unrated_clauses(user_id),
            *_scaled_code_clauses(),
            *visible_segment_filter(),
        )
        .group_by(
            CodeApplication.code_id, Segment.group_id, solo_id,
            _SEGMENT_SOURCE_RANK, _SEGMENT_SOURCE_ID,
        )
    )
    if code_id is not None:
        query = query.filter(CodeApplication.code_id == code_id)
    return query


def _value_buckets(db: Session, project_id: int, user_id: int, code_id: int | None):
    """The dataset-cell arm. No groups exist here — nothing merges a cell."""
    query = (
        db.query(
            CodeApplication.code_id.label("code_id"),
            CodeApplication.dataset_value_id.label("dataset_value_id"),
            DatasetValue.column_id.label("column_id"),
            DatasetValue.row_id.label("row_id"),
        )
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(
            Dataset.project_id == project_id,
            *_unrated_clauses(user_id),
            *_scaled_code_clauses(),
        )
    )
    if code_id is not None:
        query = query.filter(CodeApplication.code_id == code_id)
    return query


def _count(db: Session, query) -> int:
    """Rows a (possibly grouped) query would return, without materialising them."""
    return db.query(func.count()).select_from(query.order_by(None).subquery()).scalar() or 0


def _per_code_counts(db: Session, query) -> dict[int, int]:
    """`{code_id: buckets}` over the same grain, in one round trip."""
    sub = query.order_by(None).subquery()
    rows = db.query(sub.c.code_id, func.count()).group_by(sub.c.code_id).all()
    return {code_id: n for code_id, n in rows}


def _name_code_counts(db: Session, counts: dict[int, int]) -> tuple[RatingQueueCodeCount, ...]:
    """Attach each code's name, most-outstanding first.

    ⚠️ Bounded by the CODEBOOK (one `IN` over the codes that have outstanding
    work), never by rows — the `.in_()` bind ceiling #842 documents applies to
    row-scaled lists, and a project's scaled codes are a handful.

    ⚠️ Ties break on NAME so the chip order is stable between two requests that
    return the same numbers; dict order would otherwise leak query order into
    the interface.
    """
    if not counts:
        return ()
    names = dict(
        db.query(Code.id, Code.name).filter(Code.id.in_(list(counts))).all()
    )
    out = [
        RatingQueueCodeCount(
            code_id=cid, code_name=names.get(cid, ""), outstanding=n,
        )
        for cid, n in counts.items()
    ]
    out.sort(key=lambda c: (-c.outstanding, c.code_name, c.code_id))
    return tuple(out)


def build_rating_queue(
    db: Session,
    project_id: int,
    user_id: int,
    *,
    code_id: int | None = None,
    limit: int = DEFAULT_QUEUE_LIMIT,
) -> RatingQueue:
    """This coder's outstanding rating acts, first `limit` of them.

    See the module docstring for the five filters, the group collapse and why
    there is deliberately no offset.
    """
    limit = max(1, min(limit, MAX_QUEUE_LIMIT))

    seg_q = _segment_buckets(db, project_id, user_id, code_id)
    val_q = _value_buckets(db, project_id, user_id, code_id)

    seg_total = _count(db, seg_q)
    val_total = _count(db, val_q)
    total = seg_total + val_total

    # 🔴 `per_code` spans the WHOLE queue, never the filter — it IS the picker,
    # and a picker narrowed to its own selection cannot be used to leave one
    # (#979). It is also what this module promises: the counts exist so a
    # researcher can see which code's coverage is thin, which is a statement
    # about the queue rather than about the current selection.
    # ⚠️ The unfiltered queries are built ONLY when a filter is active; with no
    # filter they are the same two queries, so the common path costs nothing.
    if code_id is None:
        counts_seg_q, counts_val_q = seg_q, val_q
    else:
        counts_seg_q = _segment_buckets(db, project_id, user_id, None)
        counts_val_q = _value_buckets(db, project_id, user_id, None)

    counts = _per_code_counts(db, counts_seg_q)
    for cid, n in _per_code_counts(db, counts_val_q).items():
        counts[cid] = counts.get(cid, 0) + n
    per_code = _name_code_counts(db, counts)

    # Segments first, then cells — a stated order, not an accident of query
    # sequence. The two arms commit through different endpoints and read as
    # different material.
    seg_rows = (
        seg_q.order_by(
            _SEGMENT_SOURCE_RANK,
            _SEGMENT_SOURCE_ID,
            func.min(Segment.sequence_order),
            CodeApplication.code_id,
        )
        .limit(limit)
        .all()
    )
    val_rows = []
    if len(seg_rows) < limit:
        val_rows = (
            val_q.order_by(
                DatasetValue.column_id,
                DatasetValue.row_id,
                CodeApplication.code_id,
            )
            .limit(limit - len(seg_rows))
            .all()
        )

    entries = _hydrate(db, project_id, seg_rows, val_rows)
    return RatingQueue(
        entries=entries,
        total=total,
        truncated=total > len(entries),
        per_code=per_code,
    )


def _hydrate(db: Session, project_id: int, seg_rows, val_rows) -> tuple[RatingQueueEntry, ...]:
    """Attach code, text and source label to the page's buckets.

    Batched per page: one code query, one segment-text query, one value query
    and at most four label queries, whatever the page holds.
    """
    if not seg_rows and not val_rows:
        return ()

    code_ids = {r.code_id for r in seg_rows} | {r.code_id for r in val_rows}
    codes = {
        c.id: c for c in db.query(Code).filter(Code.id.in_(code_ids)).all()
    }
    # ⚠️ `read_scale` re-checks the stored SHAPE, so a hand-edited row cannot
    # reach the renderers as a half-declared instrument. Cached per code
    # because a page is many entries over few codes.
    scales = {cid: read_scale(c) for cid, c in codes.items()}

    seg_ids = [r.segment_id for r in seg_rows]
    seg_text: dict[int, tuple[str, float | None, float | None]] = {}
    if seg_ids:
        for sid, text, start, end in db.query(
            Segment.id, Segment.text, Segment.start_time, Segment.end_time
        ).filter(Segment.id.in_(seg_ids)).all():
            seg_text[sid] = (text or "", start, end)

    val_ids = [r.dataset_value_id for r in val_rows]
    val_info: dict[int, tuple[str, str | None]] = {}
    if val_ids:
        for vid, text, identifier in (
            db.query(DatasetValue.id, DatasetValue.value_text, DatasetRow.row_identifier)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetValue.id.in_(val_ids))
            .all()
        ):
            val_info[vid] = (text or "", identifier)

    keys: set[tuple[str, int]] = set()
    for r in seg_rows:
        keys.add(_segment_source_key(r))
    for r in val_rows:
        keys.add(("col", r.column_id))
    labels = label_sources(db, keys)

    out: list[RatingQueueEntry] = []
    for r in seg_rows:
        tag, source_id = _segment_source_key(r)
        text, start, end = seg_text.get(r.segment_id, ("", None, None))
        code = codes.get(r.code_id)
        if code is None or scales.get(r.code_id) is None:
            continue
        out.append(RatingQueueEntry(
            code_id=r.code_id,
            code_name=code.name,
            code_color=code.color,
            scale=scales[r.code_id],
            target_kind="segment",
            segment_id=r.segment_id,
            dataset_value_id=None,
            source_type=_TYPE_FOR_TAG[tag],
            source_id=source_id,
            source_label=labels.get((tag, source_id), ""),
            text=text[:TEXT_PREVIEW_CHARS],
            start_time=start,
            end_time=end,
            record_identifier=None,
            n_targets=r.n_targets,
        ))
    for r in val_rows:
        text, identifier = val_info.get(r.dataset_value_id, ("", None))
        code = codes.get(r.code_id)
        if code is None or scales.get(r.code_id) is None:
            continue
        out.append(RatingQueueEntry(
            code_id=r.code_id,
            code_name=code.name,
            code_color=code.color,
            scale=scales[r.code_id],
            target_kind="dataset_value",
            segment_id=None,
            dataset_value_id=r.dataset_value_id,
            source_type="column",
            source_id=r.column_id,
            source_label=labels.get(("col", r.column_id), ""),
            text=text[:TEXT_PREVIEW_CHARS],
            start_time=None,
            end_time=None,
            record_identifier=identifier,
            n_targets=1,
        ))
    return tuple(out)


_TYPE_FOR_TAG = {v: k for k, v in _SOURCE_TAG_FOR_TYPE.items()}


def _segment_source_key(row) -> tuple[str, int]:
    """Which source a segment bucket belongs to, from its computed rank.

    🔴 An unranked row RAISES rather than defaulting. `ck_segment_exactly_one_parent`
    makes an unparented segment impossible, so reaching this means the CHECK is
    gone — worth a 500 rather than a silently blank source name, which is the
    fall-through defect `source_labels.py` records from the other side.
    """
    tag = _TAG_BY_RANK.get(row.source_rank)
    if tag is None or row.source_id is None:
        raise ValueError(f"segment bucket {row.segment_id} has no parent")
    return (tag, row.source_id)
