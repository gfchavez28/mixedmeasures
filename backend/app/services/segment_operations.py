"""Shared segment split/merge operations for both conversations and documents,
plus the observation-clip TIME operations (slab 3b)."""

import math

from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import func

from fastapi import HTTPException

from ..models.segment import Segment
from ..models.speaker import Speaker
from ..models.code_application import CodeApplication
from ..models.note import Note
from ..models.excerpt import Excerpt
from .audit import log_action
from .staleness import mark_metrics_stale
from .consensus import consensus_enabled
from .consensus_staleness import mark_consensus_stale
from .coding_layers import CONSENSUS_ORIGIN
from .observation_segmentation import resequence_observation_clips
from typing import NamedTuple


def _mark_consensus_stale_for_parent(db: Session, project_id: int, parent_type: str, parent_id: int) -> None:
    """Mark every coded segment of this conversation/document for consensus
    recompute after a structural change (merge/split/unmerge/unsplit).

    Such an operation changes which segments exist and which carry the
    forward-carried applications, so any coded segment's consensus may shift; the
    sweep clears soft-deleted segments (visibility guard) and rebuilds survivors.
    Marks only CODED segments (the join requires an application) — bounded, and a
    no-op for single-coder projects (Track J · J2-3, Slab 5b).
    """
    if not consensus_enabled(db):
        return
    # Flush first so this query sees the operation's just-written rows (the new
    # merged/split segments and their forward-carried applications) regardless of
    # the session's autoflush setting.
    db.flush()
    seg_ids = [
        r[0]
        for r in db.query(CodeApplication.segment_id)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .filter(_parent_filter(parent_type, parent_id))
        .distinct()
        .all()
        if r[0] is not None
    ]
    if seg_ids:
        mark_consensus_stale(db, project_id, segment_ids=seg_ids)


# The ONE place a segment's parent_type maps to its FK column — single-sourced
# so the parent-dispatch sites (this map, _make_segment_fields, and every
# _parent_filter caller incl. _mark_consensus_stale_for_parent) cannot drift.
#
# ⚠️ 'observation' joined in slab 3b for the TIME ops + the reused unmerge —
# which silently made the TEXT forward ops (merge_segments / split_segment)
# accept clips too. They must not: text-joining and char-offset splitting are
# nonsense on a time range, so both carry an explicit observation refusal
# (_refuse_text_op_on_observation). Removing that guard re-legalizes char-
# splitting a clip label without any test noticing the map entry did it.
_PARENT_FK: dict[str, str] = {
    'conversation': 'conversation_id',
    'document': 'document_id',
    'observation': 'observation_id',
}


def _refuse_text_op_on_observation(parent_type: str) -> None:
    """The symmetric fail-closed guard for the TEXT forward ops (slab 3b).

    parent_type comes from router literals, so an observation reaching a text
    op is a WIRING BUG (raise → 500, matching _require_parent_type's posture),
    not user input. The time ops (split_clip_at_time / merge_clips /
    unsplit_clip) are observation-keyed by construction and cannot mis-target;
    unmerge_segment is deliberately parent-generic (its merged_into_id
    discovery is structurally sound for clips).
    """
    if parent_type == 'observation':
        raise ValueError(
            "Text merge/split cannot operate on observation clips — use the "
            "time ops (split_clip_at_time / merge_clips)."
        )


def _require_parent_type(parent_type: str) -> None:
    """Fail closed on an unrecognized segment parent_type.

    parent_type is set by ROUTER code as a literal, never from user input, so an
    unknown value is a WIRING BUG (raise → 500), not bad input (not a 400). This
    replaces two fail-OPEN defaults that silently corrupted data for any value
    other than 'conversation'/'document': _parent_filter fell through to the
    DOCUMENT filter (querying the wrong parent), and _make_segment_fields left
    BOTH FKs NULL (→ ck_segment_exactly_one_parent violation at flush).
    """
    if parent_type not in _PARENT_FK:
        raise ValueError(f"Unknown segment parent_type: {parent_type!r}")


def _parent_filter(parent_type: str, parent_id: int):
    """Return the SQLAlchemy filter clause selecting a parent's segments."""
    _require_parent_type(parent_type)
    return getattr(Segment, _PARENT_FK[parent_type]) == parent_id


def _visible():
    """Segments not soft-deleted by merge or split."""
    return (
        Segment.merged_into_id == None,  # noqa: E711
        Segment.split_into_id == None,  # noqa: E711
    )


def _eager_load_options():
    """Standard eager loading for segment responses."""
    return [
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note),
    ]


def _build_combined_speaker(db: Session, segments: list[Segment], project_id: int) -> int | None:
    """For conversation merges with multiple speakers, create or find a combined speaker.

    Returns the speaker_id to use. Only relevant for conversation segments.
    """
    unique_speakers = {}
    for seg in segments:
        if seg.speaker_id and seg.speaker:
            unique_speakers[seg.speaker_id] = seg.speaker

    if len(unique_speakers) <= 1:
        return segments[0].speaker_id

    speaker_names = []
    seen_ids: set[int] = set()
    for seg in segments:
        if seg.speaker_id and seg.speaker and seg.speaker_id not in seen_ids:
            speaker_names.append(seg.speaker.name)
            seen_ids.add(seg.speaker_id)

    if len(speaker_names) == 2:
        combined_name = f"{speaker_names[0]} & {speaker_names[1]}"
    else:
        combined_name = ", ".join(speaker_names[:-1]) + f", & {speaker_names[-1]}"

    existing = db.query(Speaker).filter(
        Speaker.project_id == project_id,
        Speaker.name == combined_name,
    ).first()

    if existing:
        return existing.id

    max_color = db.query(func.max(Speaker.color_index)).filter(
        Speaker.project_id == project_id,
    ).scalar() or 0

    new_speaker = Speaker(
        project_id=project_id,
        name=combined_name,
        is_facilitator=0,
        color_index=max_color + 1,
    )
    db.add(new_speaker)
    db.flush()
    return new_speaker.id


def _make_segment_fields(parent_type: str, parent_id: int, **kwargs) -> dict:
    """Build dict of fields for a new segment with the correct parent FK set.

    Every parent FK the model knows about is set explicitly (the chosen one to
    parent_id, the rest to None) so exactly one is non-null — exhaustive by
    construction via _PARENT_FK, no fail-open path that leaves them all NULL.
    """
    _require_parent_type(parent_type)
    fields: dict = {col: None for col in _PARENT_FK.values()}
    fields[_PARENT_FK[parent_type]] = parent_id
    fields.update(kwargs)
    return fields


def _carried_app_fields(ca: CodeApplication) -> dict:
    """The fields that constitute a coder's code-application *layer*.

    Track J · J2-0: structural ops (merge/split, and their reversals) must
    carry these forward verbatim rather than re-stamping every application to
    the operator. Re-stamping collapses every coder into one and loses the
    attribution/provenance — benign under a single shared layer, data loss the
    instant per-coder layers exist (the widened ``(target, code, user_id)``
    index). The per-coder uniqueness key is ``(code_id, user_id)``.
    """
    return {
        "code_id": ca.code_id,
        "user_id": ca.user_id,
        "attribution": ca.attribution,
        "origin": ca.origin,
        "origin_context": ca.origin_context,
    }


def _carried_back_fields(
    db: Session, from_segment_ids: list[int], existing_keys: set
) -> list[dict]:
    """The J2-0 project-back recovery, shared by unmerge / unsplit / unsplit_clip.

    Capture — as plain data — the application layers on ``from_segment_ids``
    that are not already present in ``existing_keys`` ((code_id, user_id)
    tuples; mutated in place). Capture BEFORE deleting the source segments so
    the fresh inserts can't be swept by their delete-orphan cascade.
    """
    carried: list[dict] = []
    for ca in (
        db.query(CodeApplication)
        .filter(CodeApplication.segment_id.in_(from_segment_ids))
        .all()
    ):
        key = (ca.code_id, ca.user_id)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        carried.append(_carried_app_fields(ca))
    return carried


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def merge_segments(
    db: Session,
    segment_ids: list[int],
    parent_type: str,
    parent_id: int,
    project_id: int,
    user_id: int,
) -> tuple[Segment, int]:
    """Merge adjacent segments. Returns (merged_segment, deleted_count).

    The returned segment is eagerly loaded for response conversion.
    """
    _refuse_text_op_on_observation(parent_type)
    if len(segment_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 segments required for merging")

    segments = db.query(Segment).filter(
        Segment.id.in_(segment_ids),
        _parent_filter(parent_type, parent_id),
        *_visible(),
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
    ).order_by(Segment.sequence_order).all()

    if len(segments) != len(segment_ids):
        raise HTTPException(status_code=400, detail="Some segments not found or already merged")

    # Verify adjacency
    orders = [s.sequence_order for s in segments]
    for i in range(len(orders) - 1):
        if orders[i + 1] != orders[i] + 1:
            raise HTTPException(status_code=400, detail="Segments must be adjacent")

    first_segment = segments[0]
    last_segment = segments[-1]

    # Speaker handling (conversation only)
    merged_speaker_id = None
    if parent_type == 'conversation':
        merged_speaker_id = _build_combined_speaker(db, segments, project_id)

    # Create merged segment
    merged_text = ' '.join(s.text for s in segments)
    new_fields = _make_segment_fields(
        parent_type, parent_id,
        speaker_id=merged_speaker_id,
        sequence_order=first_segment.sequence_order,
        start_time=first_segment.start_time if parent_type == 'conversation' else None,
        end_time=last_segment.end_time if parent_type == 'conversation' else None,
        text=merged_text,
        word_count=len(merged_text.split()) if merged_text.strip() else 0,
        original_speaker_label=first_segment.original_speaker_label if parent_type == 'conversation' else None,
        is_merge_result=1,
    )
    # Document-specific: inherit from first segment
    if parent_type == 'document':
        new_fields['page_number'] = first_segment.page_number
        new_fields['heading_level'] = first_segment.heading_level

    merged_segment = Segment(**new_fields)
    db.add(merged_segment)
    db.flush()

    # Carry every coder's layer onto the merged segment (Track J · J2-0):
    # distinct (code, coder, attribution, origin, origin_context) tuples — NOT a
    # bare code_id union re-stamped to the operator. Dedup on the per-coder key
    # (code_id, user_id); first occurrence wins when two originals carry the same
    # coder's same code (their attribution notes may differ — only one row fits
    # the widened unique index).
    seen_apps: set[tuple[int, int | None]] = set()
    for seg in segments:
        for ca in seg.code_applications:
            key = (ca.code_id, ca.user_id)
            if key in seen_apps:
                continue
            seen_apps.add(key)
            db.add(CodeApplication(segment_id=merged_segment.id, **_carried_app_fields(ca)))

    # Soft-delete originals
    deleted_count = len(segments)
    for seg in segments:
        seg.merged_into_id = merged_segment.id

    # Resequence
    remaining = db.query(Segment).filter(
        _parent_filter(parent_type, parent_id),
        Segment.sequence_order > orders[-1],
        *_visible(),
    ).all()
    shift = deleted_count - 1
    for seg in remaining:
        seg.sequence_order -= shift

    log_action(
        db, action="merged", entity_type="segment", entity_id=merged_segment.id,
        user_id=user_id, project_id=project_id,
        details={"merged_segment_ids": segment_ids, "soft_deleted_count": deleted_count},
    )
    _mark_consensus_stale_for_parent(db, project_id, parent_type, parent_id)
    mark_metrics_stale(db, project_id)
    db.commit()

    # Reload with eager loading
    merged_segment = db.query(Segment).filter(
        Segment.id == merged_segment.id,
    ).options(*_eager_load_options()).first()

    return merged_segment, deleted_count


# ---------------------------------------------------------------------------
# Unmerge
# ---------------------------------------------------------------------------

def unmerge_segment(
    db: Session,
    segment_id: int,
    parent_type: str,
    parent_id: int,
    project_id: int,
    user_id: int,
) -> tuple[list[Segment], int]:
    """Unmerge a previously merged segment. Returns (restored_segments, restored_count)."""
    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        _parent_filter(parent_type, parent_id),
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")
    if not segment.is_merge_result:
        raise HTTPException(status_code=400, detail="This segment was not created by a merge")

    originals = db.query(Segment).filter(
        Segment.merged_into_id == segment_id,
    ).options(
        selectinload(Segment.code_applications),
    ).order_by(Segment.sequence_order).all()

    if not originals:
        raise HTTPException(status_code=400, detail="No original segments found to restore")

    merged_order = segment.sequence_order

    # Restore originals
    for orig in originals:
        orig.merged_into_id = None

    # Project-back recovery (Track J · J2-0): the merged segment may carry
    # applications added AFTER the merge (any coder's layer). The originals' own
    # pre-merge applications were never deleted and come back with them, so
    # re-home only the merged-segment-only tuples — onto the FIRST restored
    # original (it inherits the merged segment's position). Dedup against EVERY
    # original so a forward-carried copy isn't duplicated or mis-attributed to a
    # sibling that never had it. Capture as plain data BEFORE the cascade so the
    # fresh inserts (after the merged segment is gone) can't be swept by it.
    existing_keys: set[tuple[int, int | None]] = {
        (ca.code_id, ca.user_id) for orig in originals for ca in orig.code_applications
    }
    first_original = originals[0]
    carried_back = _carried_back_fields(db, [segment_id], existing_keys)

    # Delete the merged segment's notes, then the segment itself — its
    # code_applications (loaded above) go via the relationship's
    # delete-orphan cascade, so no explicit bulk delete is needed.
    db.query(Note).filter(Note.segment_id == segment_id).delete()
    db.delete(segment)
    db.flush()

    # Re-home the post-merge coding onto the first restored original (now that
    # the merged segment — and its cascade — is gone).
    for fields in carried_back:
        db.add(CodeApplication(segment_id=first_original.id, **fields))

    # Resequence
    num_originals = len(originals)
    shift = num_originals - 1
    original_ids = [o.id for o in originals]

    segments_after = db.query(Segment).filter(
        _parent_filter(parent_type, parent_id),
        Segment.sequence_order > merged_order,
        *_visible(),
        ~Segment.id.in_(original_ids),
    ).all()
    for seg in segments_after:
        seg.sequence_order += shift

    for i, orig in enumerate(originals):
        orig.sequence_order = merged_order + i

    if parent_type == 'observation':
        # Clips order by TIME, not by the shift arithmetic above (a time-merge
        # takes non-adjacent clips, so the restored originals' true positions
        # interleave with everything else) — re-derive (slab 3b). The arithmetic
        # still ran so conv/doc behavior is untouched.
        db.flush()
        resequence_observation_clips(db, parent_id)

    log_action(
        db, action="unmerged", entity_type="segment", entity_id=segment_id,
        user_id=user_id, project_id=project_id,
        details={"restored_segment_ids": original_ids, "restored_count": num_originals},
    )
    _mark_consensus_stale_for_parent(db, project_id, parent_type, parent_id)
    mark_metrics_stale(db, project_id)
    db.commit()

    restored = db.query(Segment).filter(
        Segment.id.in_(original_ids),
    ).options(*_eager_load_options()).order_by(Segment.sequence_order).all()

    return restored, num_originals


# ---------------------------------------------------------------------------
# Split
# ---------------------------------------------------------------------------

def split_segment(
    db: Session,
    ranges: list,
    parent_type: str,
    parent_id: int,
    project_id: int,
    user_id: int,
    report: dict | None = None,
) -> tuple[list[Segment], list[int]]:
    """Split segment(s). Returns (new_segments, deleted_segment_ids).

    `report` is an optional out-param (the `import_project` idiom) — the caller
    passes `{}` and reads `quote_notes_stayed` back: how many quote notes stayed
    with the original, per #712. Kept OUT of the return tuple so existing callers
    are unaffected.
    """
    _refuse_text_op_on_observation(parent_type)
    if len(ranges) == 1:
        return _split_single(db, ranges[0], parent_type, parent_id, project_id, user_id, report)
    return _split_multi(db, ranges, parent_type, parent_id, project_id, user_id, report)


def _split_single(db, r, parent_type, parent_id, project_id, user_id, report=None):
    """Split a single segment into up to 3 parts."""
    segment = db.query(Segment).filter(
        Segment.id == r.segment_id,
        _parent_filter(parent_type, parent_id),
        *_visible(),
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note),
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")
    if parent_type == 'conversation' and segment.group_id:
        raise HTTPException(status_code=400, detail="Cannot split a grouped segment")

    text = segment.text
    if r.start_offset < 0 or r.end_offset > len(text) or r.start_offset >= r.end_offset:
        raise HTTPException(status_code=400, detail="Invalid offset range")

    before_text = text[:r.start_offset].strip()
    selected_text = text[r.start_offset:r.end_offset].strip()
    after_text = text[r.end_offset:].strip()

    if not selected_text:
        raise HTTPException(status_code=400, detail="Selected text is empty")
    if not before_text and not after_text:
        raise HTTPException(status_code=400, detail="Selection covers entire segment text")

    # Save properties from original before mutations. Capture the full
    # per-coder application layers (Track J · J2-0), not just code_ids, so each
    # child inherits every coder's coding with attribution/provenance intact.
    original_apps = [_carried_app_fields(ca) for ca in segment.code_applications]
    original_order = segment.sequence_order
    original_id = segment.id
    had_whole_excerpt = any(e.start_offset is None for e in (segment.excerpts or []))
    original_note_ids = [n.id for n in segment.attached_notes if not n.is_archived]

    # Conversation-specific
    original_speaker_id = segment.speaker_id if parent_type == 'conversation' else None
    original_start_time = segment.start_time if parent_type == 'conversation' else None
    original_end_time = segment.end_time if parent_type == 'conversation' else None
    original_label = segment.original_speaker_label if parent_type == 'conversation' else None

    # Document-specific
    original_page_number = segment.page_number if parent_type == 'document' else None
    original_heading_level = segment.heading_level if parent_type == 'document' else None

    # Build parts. The spans are the STRIPPED extents inside the original text —
    # `_char_excerpt_carry_plan` rebases quotes against them, and a child's text is
    # the stripped slice, so the requested offsets alone would be off by the
    # discarded whitespace (#695).
    parts = []
    regions: list[_CarryRegion] = []
    def _region(lo: int, hi: int) -> None:
        span = _stripped_span(text, lo, hi)
        regions.append(_CarryRegion(original_id, span[0], span[1], len(parts) - 1, 0))

    if before_text:
        parts.append(('before', before_text))
        _region(0, r.start_offset)
    parts.append(('selected', selected_text))
    _region(r.start_offset, r.end_offset)
    if after_text:
        parts.append(('after', after_text))
        _region(r.end_offset, len(text))

    # #695: char-range quotes used to be left on the original, which the split
    # soft-deletes — so they vanished from the workbench and the Quote Board with no
    # notice. Carried per the plan, the text-shaped port of #621's clip rule.
    carry_plan = _char_excerpt_carry_plan(list(segment.excerpts or []), regions)
    if report is not None:
        report["quote_notes_stayed"] = _count_notes_left_behind(carry_plan)

    num_new = len(parts)

    # Shift subsequent segments
    shift = num_new - 1
    if shift > 0:
        segments_after = db.query(Segment).filter(
            _parent_filter(parent_type, parent_id),
            Segment.sequence_order > original_order,
            *_visible(),
        ).all()
        for seg in segments_after:
            seg.sequence_order += shift

    # Create new segments
    new_segments = []
    selected_segment = None
    for i, (part_type, part_text) in enumerate(parts):
        new_fields = _make_segment_fields(
            parent_type, parent_id,
            speaker_id=original_speaker_id,
            sequence_order=original_order + i,
            start_time=original_start_time if i == 0 else None,
            end_time=original_end_time if i == len(parts) - 1 else None,
            text=part_text,
            word_count=len(part_text.split()) if part_text.strip() else 0,
            original_speaker_label=original_label,
            is_split_result=1,
        )
        if parent_type == 'document':
            new_fields['page_number'] = original_page_number
            new_fields['heading_level'] = original_heading_level

        new_seg = Segment(**new_fields)
        db.add(new_seg)
        db.flush()

        for fields in original_apps:
            db.add(CodeApplication(segment_id=new_seg.id, **fields))

        if part_type == 'selected' and had_whole_excerpt:
            db.add(Excerpt(project_id=project_id, segment_id=new_seg.id))

        _add_carried_excerpts(db, carry_plan, i, new_seg.id)

        new_segments.append(new_seg)
        if part_type == 'selected':
            selected_segment = new_seg

    # Move notes to selected segment
    if selected_segment and original_note_ids:
        db.query(Note).filter(Note.id.in_(original_note_ids)).update(
            {Note.segment_id: selected_segment.id}, synchronize_session='fetch',
        )

    # Soft-delete original
    segment.split_into_id = new_segments[0].id

    log_action(
        db, action="split", entity_type="segment", entity_id=original_id,
        user_id=user_id, project_id=project_id,
        details={
            "original_segment_id": original_id,
            "new_segment_ids": [s.id for s in new_segments],
            "part_count": num_new,
        },
    )
    _mark_consensus_stale_for_parent(db, project_id, parent_type, parent_id)
    mark_metrics_stale(db, project_id)
    db.commit()

    result = db.query(Segment).filter(
        Segment.id.in_([s.id for s in new_segments]),
    ).options(*_eager_load_options()).order_by(Segment.sequence_order).all()

    return result, [original_id]


def _split_multi(db, ranges, parent_type, parent_id, project_id, user_id, report=None):
    """Split across multiple adjacent segments."""
    segment_ids = [r.segment_id for r in ranges]
    segments = db.query(Segment).filter(
        Segment.id.in_(segment_ids),
        _parent_filter(parent_type, parent_id),
        *_visible(),
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications).joinedload(CodeApplication.code),
        selectinload(Segment.attached_notes),
        selectinload(Segment.excerpts).joinedload(Excerpt.note),
    ).order_by(Segment.sequence_order).all()

    if len(segments) != len(segment_ids):
        raise HTTPException(status_code=400, detail="Some segments not found")
    if parent_type == 'conversation' and any(s.group_id for s in segments):
        raise HTTPException(status_code=400, detail="Cannot split grouped segments")

    # Verify adjacency
    orders = [s.sequence_order for s in segments]
    for i in range(len(orders) - 1):
        if orders[i + 1] != orders[i] + 1:
            raise HTTPException(status_code=400, detail="Segments must be adjacent")

    range_map = {r.segment_id: r for r in ranges}
    first_seg = segments[0]
    last_seg = segments[-1]
    first_range = range_map[first_seg.id]
    last_range = range_map[last_seg.id]

    # Validate offsets
    if first_range.start_offset < 0 or first_range.start_offset > len(first_seg.text):
        raise HTTPException(status_code=400, detail="Invalid start offset in first segment")
    if last_range.end_offset < 0 or last_range.end_offset > len(last_seg.text):
        raise HTTPException(status_code=400, detail="Invalid end offset in last segment")

    original_ids = [s.id for s in segments]
    base_order = first_seg.sequence_order
    had_whole_excerpt = any(
        e.start_offset is None for s in segments for e in (s.excerpts or [])
    )

    # Build text parts
    before_text = first_seg.text[:first_range.start_offset].strip()
    first_selected = first_seg.text[first_range.start_offset:].strip()
    middle_texts = [s.text for s in segments[1:-1]] if len(segments) > 2 else []
    last_selected = last_seg.text[:last_range.end_offset].strip()
    after_text = last_seg.text[last_range.end_offset:].strip()

    selected_parts = [first_selected] + middle_texts + [last_selected]
    selected_text = ' '.join(p for p in selected_parts if p)

    if not selected_text:
        raise HTTPException(status_code=400, detail="Selected text is empty")

    # Collect codes and notes. Carry full per-coder layers (Track J · J2-0),
    # deduped on (code_id, user_id) across all source segments.
    carried_apps: list[dict] = []
    seen_apps: set[tuple[int, int | None]] = set()
    all_note_ids: list[int] = []
    for seg in segments:
        for ca in seg.code_applications:
            key = (ca.code_id, ca.user_id)
            if key in seen_apps:
                continue
            seen_apps.add(key)
            carried_apps.append(_carried_app_fields(ca))
        for n in seg.attached_notes:
            if not n.is_archived:
                all_note_ids.append(n.id)

    # Speaker handling (conversation only)
    if parent_type == 'conversation':
        first_speaker_id = first_seg.speaker_id
        last_speaker_id = last_seg.speaker_id
        merged_speaker_id = _build_combined_speaker(db, segments, project_id)
        first_start_time = first_seg.start_time
        last_end_time = last_seg.end_time
        first_label = first_seg.original_speaker_label
    else:
        first_speaker_id = None
        last_speaker_id = None
        merged_speaker_id = None
        first_start_time = None
        last_end_time = None
        first_label = None

    # Document-specific from first segment
    first_page = first_seg.page_number if parent_type == 'document' else None
    first_heading = first_seg.heading_level if parent_type == 'document' else None

    parts = []
    regions: list[_CarryRegion] = []
    if before_text:
        parts.append(('before', before_text, first_speaker_id))
        b_lo, b_hi = _stripped_span(first_seg.text, 0, first_range.start_offset)
        regions.append(_CarryRegion(first_seg.id, b_lo, b_hi, len(parts) - 1, 0))

    parts.append(('selected', selected_text, merged_speaker_id))
    # #695: the selected child CONCATENATES runs from every source segment, so each
    # run needs its own destination offset — a plain rebase would be wrong for all
    # but the first. `_joined_regions` lays them out exactly as
    # `' '.join(p for p in selected_parts if p)` did, dropping empties BEFORE
    # counting a separator (counting one for a piece that was never emitted would
    # shift every later offset by one). Middles are deliberately UNstripped here,
    # matching `middle_texts = [s.text for s in segments[1:-1]]`.
    _pieces: list[tuple[int, int, int, str]] = []
    _pieces.append((first_seg.id, *_stripped_span(first_seg.text, first_range.start_offset, len(first_seg.text)), first_selected))
    for _mid in (segments[1:-1] if len(segments) > 2 else []):
        _pieces.append((_mid.id, 0, len(_mid.text), _mid.text))
    _pieces.append((last_seg.id, *_stripped_span(last_seg.text, 0, last_range.end_offset), last_selected))
    regions.extend(_joined_regions(_pieces, len(parts) - 1))

    if after_text:
        parts.append(('after', after_text, last_speaker_id))
        a_lo, a_hi = _stripped_span(last_seg.text, last_range.end_offset, len(last_seg.text))
        regions.append(_CarryRegion(last_seg.id, a_lo, a_hi, len(parts) - 1, 0))

    carry_plan = _char_excerpt_carry_plan(
        [e for seg in segments for e in (seg.excerpts or [])], regions,
    )
    if report is not None:
        report["quote_notes_stayed"] = _count_notes_left_behind(carry_plan)

    num_new = len(parts)
    num_originals = len(segments)
    shift = num_new - num_originals
    if shift != 0:
        segments_after = db.query(Segment).filter(
            _parent_filter(parent_type, parent_id),
            Segment.sequence_order > orders[-1],
            *_visible(),
        ).all()
        for seg in segments_after:
            seg.sequence_order += shift

    new_segments = []
    selected_segment = None
    for i, (part_type, part_text, speaker_id) in enumerate(parts):
        new_fields = _make_segment_fields(
            parent_type, parent_id,
            speaker_id=speaker_id,
            sequence_order=base_order + i,
            start_time=first_start_time if i == 0 else None,
            end_time=last_end_time if i == len(parts) - 1 else None,
            text=part_text,
            word_count=len(part_text.split()) if part_text.strip() else 0,
            original_speaker_label=first_label,
            is_split_result=1,
        )
        if parent_type == 'document':
            new_fields['page_number'] = first_page
            new_fields['heading_level'] = first_heading

        new_seg = Segment(**new_fields)
        db.add(new_seg)
        db.flush()

        for fields in carried_apps:
            db.add(CodeApplication(segment_id=new_seg.id, **fields))

        if part_type == 'selected' and had_whole_excerpt:
            db.add(Excerpt(project_id=project_id, segment_id=new_seg.id))

        _add_carried_excerpts(db, carry_plan, i, new_seg.id)

        new_segments.append(new_seg)
        if part_type == 'selected':
            selected_segment = new_seg

    # Move notes to selected
    if selected_segment and all_note_ids:
        db.query(Note).filter(Note.id.in_(all_note_ids)).update(
            {Note.segment_id: selected_segment.id}, synchronize_session='fetch',
        )

    # Soft-delete originals
    for seg in segments:
        seg.split_into_id = new_segments[0].id

    log_action(
        db, action="split", entity_type="segment", entity_id=original_ids[0],
        user_id=user_id, project_id=project_id,
        details={
            "original_segment_ids": original_ids,
            "new_segment_ids": [s.id for s in new_segments],
            "type": "multi",
        },
    )
    _mark_consensus_stale_for_parent(db, project_id, parent_type, parent_id)
    mark_metrics_stale(db, project_id)
    db.commit()

    result = db.query(Segment).filter(
        Segment.id.in_([s.id for s in new_segments]),
    ).options(*_eager_load_options()).order_by(Segment.sequence_order).all()

    return result, original_ids


# ---------------------------------------------------------------------------
# Unsplit
# ---------------------------------------------------------------------------

def _find_split_siblings(all_split_results: list[Segment], target_id: int) -> list[int]:
    """Find contiguous group of split-result segments containing target_id."""
    target_idx = None
    for i, seg in enumerate(all_split_results):
        if seg.id == target_id:
            target_idx = i
            break

    if target_idx is None:
        return [target_id]

    start = target_idx
    while start > 0:
        if all_split_results[start - 1].sequence_order == all_split_results[start].sequence_order - 1:
            start -= 1
        else:
            break

    end = target_idx
    while end < len(all_split_results) - 1:
        if all_split_results[end + 1].sequence_order == all_split_results[end].sequence_order + 1:
            end += 1
        else:
            break

    return [all_split_results[i].id for i in range(start, end + 1)]


def unsplit_segment(
    db: Session,
    segment_id: int,
    parent_type: str,
    parent_id: int,
    project_id: int,
    user_id: int,
) -> tuple[Segment, int]:
    """Unsplit/rejoin a split segment. Returns (restored_segment, deleted_count)."""
    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        _parent_filter(parent_type, parent_id),
    ).first()

    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found")
    if not segment.is_split_result:
        raise HTTPException(status_code=400, detail="This segment was not created by a split")

    # Find original — it has split_into_id pointing to one of the split-result segments
    original = db.query(Segment).filter(
        Segment.split_into_id == segment_id,
        _parent_filter(parent_type, parent_id),
    ).first()

    if not original:
        # The split_into_id might point to a different sibling; find via contiguous group
        all_split_results = db.query(Segment).filter(
            _parent_filter(parent_type, parent_id),
            Segment.is_split_result == 1,
            *_visible(),
        ).order_by(Segment.sequence_order).all()

        sibling_ids = _find_split_siblings(all_split_results, segment_id)

        original = db.query(Segment).filter(
            Segment.split_into_id.in_(sibling_ids),
            _parent_filter(parent_type, parent_id),
        ).first()

    if not original:
        raise HTTPException(status_code=400, detail="Original segment not found for unsplit")

    # Find ALL split-result siblings
    all_split_results = db.query(Segment).filter(
        _parent_filter(parent_type, parent_id),
        Segment.is_split_result == 1,
        *_visible(),
    ).order_by(Segment.sequence_order).all()

    sibling_ids = _find_split_siblings(all_split_results, segment_id)

    split_segments = db.query(Segment).filter(
        Segment.id.in_(sibling_ids),
    ).order_by(Segment.sequence_order).all()

    if not split_segments:
        raise HTTPException(status_code=400, detail="No split segments found to rejoin")

    restore_order = split_segments[0].sequence_order
    num_split = len(split_segments)

    # Restore original
    original.split_into_id = None
    original.sequence_order = restore_order

    # Move notes back to original
    split_ids = [s.id for s in split_segments]
    db.query(Note).filter(Note.segment_id.in_(split_ids)).update(
        {Note.segment_id: original.id}, synchronize_session='fetch',
    )

    # Project-back recovery (Track J · J2-0): re-home applications added to the
    # split children (any coder's layer) onto the restored original, deduping
    # against the original's own surviving applications so forward-carried copies
    # aren't duplicated (the widened (segment, code, user_id) index would reject
    # them). Capture as plain data BEFORE deleting the children so the fresh
    # inserts can't be swept by the children's delete-orphan cascade.
    existing_keys: set[tuple[int, int | None]] = {
        (ca.code_id, ca.user_id) for ca in original.code_applications
    }
    carried_back = _carried_back_fields(db, split_ids, existing_keys)

    # Delete the split children — their code_applications (loaded above) go via
    # the relationship's delete-orphan cascade, so no explicit bulk delete is
    # needed.
    for seg in split_segments:
        db.delete(seg)
    db.flush()

    # Re-home the post-split coding onto the restored original (now that the
    # children — and their cascade — are gone).
    for fields in carried_back:
        db.add(CodeApplication(segment_id=original.id, **fields))

    # Resequence
    shift = num_split - 1
    if shift > 0:
        segments_after = db.query(Segment).filter(
            _parent_filter(parent_type, parent_id),
            Segment.sequence_order > restore_order + num_split - 1,
            ~Segment.id.in_(split_ids),
            Segment.id != original.id,
            *_visible(),
        ).all()
        for seg in segments_after:
            seg.sequence_order -= shift

    log_action(
        db, action="unsplit", entity_type="segment", entity_id=original.id,
        user_id=user_id, project_id=project_id,
        details={"restored_segment_id": original.id, "deleted_split_ids": split_ids},
    )
    _mark_consensus_stale_for_parent(db, project_id, parent_type, parent_id)
    mark_metrics_stale(db, project_id)
    db.commit()

    restored = db.query(Segment).filter(
        Segment.id == original.id,
    ).options(*_eager_load_options()).first()

    return restored, num_split


# ---------------------------------------------------------------------------
# Time operations (Observations slab 3b)
# ---------------------------------------------------------------------------
#
# Clips are POINTERS at a timeline, not a partition of text, so their ops are a
# NEW pair rather than a parameterization of the text ops above: split is by a
# TIME inside the range (not a char offset), merge takes ANY set of clips (no
# adjacency — the merged range spans gaps), and every op ends with
# resequence_observation_clips (clips order by (start_time, end_time, id), and
# nothing else reconciles sequence_order against time). They mirror the text
# ops' soft-delete machinery exactly (merged_into_id / split_into_id +
# is_*_result) so visibility, portability, and the REUSED unmerge_segment work
# identically. Frozen-ness (D22) is enforced at the ROUTER (409), like the cut.
# No mark_metrics_stale here (deliberate): no metric reads clip structure — the
# text ops' call serves transcript-fed surfaces observations don't have.


def _clip_or_404(db: Session, observation_id: int, segment_id: int) -> Segment:
    segment = (
        db.query(Segment)
        .filter(
            Segment.id == segment_id,
            Segment.observation_id == observation_id,
            *_visible(),
        )
        .options(
            selectinload(Segment.code_applications),
            selectinload(Segment.attached_notes),
            # #621: the split reads the clip's quotes to place them.
            selectinload(Segment.excerpts),
        )
        .first()
    )
    if not segment:
        raise HTTPException(status_code=404, detail="Clip not found in this observation")
    return segment


def _human_app_fields(segment: Segment) -> list[dict]:
    """The layers a time op carries forward: every coder's HUMAN applications.

    origin='consensus' rows are deliberately NOT carried: time ops run only on
    UNFROZEN observations (D22), where clips are consensus-INELIGIBLE — a
    carried consensus row would be a stranded orphan no sweep revisits (the
    #615 shape). At rest there are none anyway (unfreeze drops the layer);
    this filter makes that true by construction.
    """
    return [
        _carried_app_fields(ca)
        for ca in segment.code_applications
        if ca.origin != CONSENSUS_ORIGIN
    ]


def _count_notes_left_behind(carry_plan: list[tuple["Excerpt", int, int, int]]) -> int:
    """#712 — how many quote notes this split is about to leave on the original.

    Counted from the carry plan, so it is exactly the set of SOURCE quotes that
    produce a carried copy AND carry a one-to-one `Note`. Distinct on the source
    excerpt: the plan lists one tuple per (excerpt, destination part), so a quote
    divided across two children would otherwise be counted twice.

    ⚠️ **This is computable HERE and nowhere later**, which is the whole reason the
    disclosure happens at split time (#712's amended design). Afterwards the link is
    gone: `Excerpt` has no provenance column, `_add_carried_excerpts` clips offsets
    and dedups on `(start, end)` so child→source is many-to-one, and the
    child→original edge is `_find_split_siblings`' contiguity heuristic. A per-quote
    caveat rendered later could only be guessed.
    """
    return len({id(ex) for ex, _idx, _s, _e in carry_plan if ex.note is not None})


def _add_carried_excerpts(
    db: Session, carry_plan: list[tuple["Excerpt", int, int, int]], part_index: int, segment_id: int,
) -> int:
    """Write this part's share of the carried char-range quotes (#695).

    A carried quote is a NEW row, never a re-pointed one — the same reasoning as
    `_copy_clip_excerpt`: the original keeps its own while soft-deleted, so
    `unsplit_segment` DELETES these children and their copies go with them via
    `Segment.excerpts`' delete-orphan cascade, restoring the original's quote with no
    explicit move-back. Re-pointing would be worse than merely awkward here — unsplit
    would DESTROY the only row, and the attached note's `excerpt_id`
    (``ondelete="SET NULL"``) would silently detach.

    ⚠️ Dedup on (start, end): `ix_excerpt_segment_range` is unique per segment, and
    two distinct quotes on the source can clip to the same span on one child. Without
    this that is an IntegrityError mid-split, not a duplicate row.

    ⚠️ Deliberately NOT carried, matching `_copy_clip_excerpt`: the excerpt's `uuid`
    (a distinct row IS a distinct entity for the J3-2 merge spine) and its one-to-one
    `note` (`ix_notes_excerpt_unique` allows exactly one, so a divided quote could not
    keep it on both pieces). The note stays with the original and an undo restores it.
    Unlike the clip case this IS reachable today — `onAddNoteToExcerpt` exists on the
    text workbenches — so it is a real, bounded gap rather than a documented
    impossibility, tracked separately rather than decided here.
    """
    seen: set[tuple[int, int]] = set()
    written = 0
    for ex, idx, new_start, new_end in carry_plan:
        if idx != part_index:
            continue
        if (new_start, new_end) in seen:
            continue
        seen.add((new_start, new_end))
        db.add(Excerpt(
            project_id=ex.project_id,
            segment_id=segment_id,
            start_offset=new_start,
            end_offset=new_end,
        ))
        written += 1
    return written


def _stripped_span(text: str, lo: int, hi: int) -> tuple[int, int]:
    """Where ``text[lo:hi].strip()`` actually sits inside ``text``.

    `split_segment` builds each child from a STRIPPED slice, so a child's text is not
    `text[lo:hi]` — leading and trailing whitespace is discarded and every offset
    inside it shifts. Re-anchoring a quote therefore needs the stripped span, not the
    requested one. This is the one thing the clip sibling (`_clip_excerpt_carry_plan`)
    does not have to reason about: times are absolute, so a clip split moves
    ownership without moving coordinates.

    A whitespace-only slice returns a zero-width span at `lo`; the caller drops
    quotes that fall in one, since no child segment is created for it either.
    """
    raw = text[lo:hi]
    lead = len(raw) - len(raw.lstrip())
    trail = len(raw) - len(raw.rstrip())
    start = lo + lead
    end = hi - trail
    return (start, end) if end > start else (start, start)


class _CarryRegion(NamedTuple):
    """One run of SOURCE text landing at a known place in ONE new segment.

    Both text splits are describable this way, which is what lets them share a plan:
    the single-segment split produces three regions from one source, and the
    multi-segment split produces regions from N sources — including several that
    concatenate into the same "selected" child.
    """
    src_segment_id: int
    src_start: int    # stripped span start, in the SOURCE segment's text
    src_end: int      # stripped span end (exclusive)
    part_index: int   # which new segment this run lands in
    dest_offset: int  # where this run's text begins inside that new segment


def _joined_regions(
    pieces: list[tuple[int, int, int, str]], part_index: int, joiner_len: int = 1,
) -> list[_CarryRegion]:
    """Lay out `' '.join(non-empty pieces)` and report where each piece landed.

    ``pieces`` is ``(src_segment_id, src_start, src_end, piece_text)``. Empty pieces
    are dropped BEFORE the joiner is counted — mirroring
    ``' '.join(p for p in parts if p)`` exactly, because counting a separator for a
    piece that was never emitted would shift every subsequent offset by one.
    """
    out: list[_CarryRegion] = []
    cursor = 0
    for seg_id, s, e, txt in pieces:
        if not txt:
            continue
        if cursor > 0:
            cursor += joiner_len
        out.append(_CarryRegion(seg_id, s, e, part_index, cursor))
        cursor += len(txt)
    return out


def _char_excerpt_carry_plan(
    excerpts: list[Excerpt],
    regions: list[_CarryRegion],
) -> list[tuple[Excerpt, int, int, int]]:
    """Decide where each char-range quote goes when text segments are split (#695).

    Returns ``(excerpt, part_index, new_start, new_end)`` — one row per destination,
    so a quote straddling a cut yields TWO.

    This is the text-shaped port of `_clip_excerpt_carry_plan`; the rules are the same
    claim in a different coordinate system:

    - **A quote contained in one region → that region's part**, rebased.
    - **A quote spanning a cut → DIVIDED**, one piece per region it overlaps.
      Dropping it or picking a side would silently discard part of a marked passage.
    - **A quote landing entirely in stripped whitespace → carried nowhere.** No child
      segment exists for that text, so there is no honest destination; it stays on
      the soft-deleted original and returns on unsplit, exactly as today.

    ⚠️ Two ways the text case is genuinely unlike the clip case, and neither is
    hand-waving:

    1. **Children are built from STRIPPED slices**, so offsets shift by the discarded
       whitespace — hence `_stripped_span` feeding `src_start`/`src_end`. A clip split
       moves ownership without moving coordinates, because times are absolute (D29).
    2. **The multi-segment split CONCATENATES** runs from several source segments into
       one child, so a destination offset is `dest_offset + (quote - src_start)`
       rather than a plain rebase.

    Whole-segment excerpts are NOT handled here — both splits already re-create those
    on the "selected" part via `had_whole_excerpt`, which is the text analogue of the
    clip rule's "both halves" (a text split has three parts and the selected one is
    the one the user pointed at). Changing that is out of scope for #695.
    """
    plan: list[tuple[Excerpt, int, int, int]] = []

    for ex in excerpts:
        if ex.start_offset is None:
            continue  # whole-segment; handled by had_whole_excerpt
        for reg in regions:
            if reg.src_segment_id != ex.segment_id:
                continue
            if reg.src_end <= reg.src_start:
                continue  # whitespace-only run — nothing was emitted for it
            lo = max(ex.start_offset, reg.src_start)
            hi = min(ex.end_offset, reg.src_end)
            if hi <= lo:
                continue  # no overlap with this run
            plan.append((
                ex,
                reg.part_index,
                reg.dest_offset + (lo - reg.src_start),
                reg.dest_offset + (hi - reg.src_start),
            ))

    return plan


def _clip_excerpt_carry_plan(
    excerpts: list[Excerpt], at_time: float,
) -> tuple[list[Excerpt], list[Excerpt], list[tuple[Excerpt, float, float]]]:
    """Decide where each of a clip's quotes goes when it is split at `at_time`.

    Returns (to_first, to_second, to_divide) where `to_divide` carries the
    explicit (excerpt, start, end) pieces for a quote that STRADDLES the cut —
    it becomes two quotes, one per half (#621).

    The rules, and why (all three shapes are handled; nothing is ever dropped):

    - **whole-clip quote → BOTH halves.** It asserts "this clip is notable",
      and both halves inherit that claim — the same reasoning that makes the
      LABEL copy to both. It is also what the text split already does
      (`had_whole_excerpt` re-creates the excerpt on the selected part).
    - **time-range quote → the half that CONTAINS it.** Its times are ABSOLUTE
      (D29), so the range itself never changes; only which clip owns it does.
    - **a time quote straddling the cut → DIVIDED at the cut.** Dropping it or
      picking a side would silently discard part of a marked moment.

    Two edges that look like corner cases and are not:

    1. **A point quote exactly AT the cut is contained by both halves** (the
       time CHECK allows `end_time >= start_time`, D7). The ordering below is
       the tie-break — `end <= at_time` wins first, so it lands on the FIRST
       half, matching where notes go.
    2. **A quote can legitimately sit OUTSIDE the clip's current range.** Times
       are absolute and a later boundary edit re-anchors nothing (D29), so
       create-time containment is not an at-rest invariant. The branches are
       therefore TOTAL: anything ending at-or-before the cut goes first,
       anything starting at-or-after goes second, and only a genuine straddle
       divides. A quote outside the clip is carried verbatim rather than
       clamped — editing a researcher's mark to fit our boundaries would be
       the bug, not the fix.
    """
    to_first: list[Excerpt] = []
    to_second: list[Excerpt] = []
    to_divide: list[tuple[Excerpt, float, float]] = []

    for ex in excerpts:
        if ex.start_time is None:
            # Whole-clip (char ranges cannot exist on a clip — the router
            # refuses that shape on an observation parent).
            to_first.append(ex)
            to_second.append(ex)
        elif ex.end_time <= at_time:
            to_first.append(ex)
        elif ex.start_time >= at_time:
            to_second.append(ex)
        else:
            to_divide.append((ex, ex.start_time, ex.end_time))

    return to_first, to_second, to_divide


def _copy_clip_excerpt(
    ex: Excerpt, segment_id: int, start: float | None = None, end: float | None = None,
) -> Excerpt:
    """A carried quote is a NEW row on the new clip, never a moved one.

    Copying (rather than re-pointing `segment_id`) is what makes the inverse
    ops free: the original keeps its own excerpt while it is soft-deleted, and
    unsplit/unmerge DELETE the new clips — whose copies go with them via
    `Segment.excerpts`' delete-orphan cascade — so the original's quote simply
    reappears. Re-pointing would need an explicit, order-sensitive move back.

    Deliberately NOT carried: the excerpt's `uuid` (a distinct row IS a
    distinct entity for the J3-2 merge spine) and its one-to-one `note`
    (`ix_notes_excerpt_unique` allows exactly one, so a quote copied to two
    halves could not keep it on both; the note stays with the original, which
    an undo restores). No clip surface can attach a note to a quote today —
    `notesApi.createForObservation` takes `segment_id` only — so this is a
    documented boundary rather than a live loss.
    """
    return Excerpt(
        project_id=ex.project_id,
        segment_id=segment_id,
        start_time=ex.start_time if start is None else start,
        end_time=ex.end_time if end is None else end,
    )


def _clip_reload(db: Session, segment_ids: list[int]) -> list[Segment]:
    return (
        db.query(Segment)
        .filter(Segment.id.in_(segment_ids))
        .options(
            selectinload(Segment.code_applications).joinedload(CodeApplication.code),
            selectinload(Segment.attached_notes),
        )
        .order_by(Segment.sequence_order)
        .all()
    )


def split_clip_at_time(
    db: Session,
    segment_id: int,
    at_time: float,
    observation_id: int,
    project_id: int,
    user_id: int,
) -> list[Segment]:
    """Split one clip into [start, t] + [t, end]. Returns the two new clips.

    t must fall STRICTLY inside the range — a point event (start == end) has no
    interior and is refused. The label copies to BOTH halves (there is no char
    offset to derive from; each half remains the thing the label named). Notes
    move to the FIRST (earlier) half — the deterministic analog of the text
    split's "selected part". **Quotes are carried per `_clip_excerpt_carry_plan`
    (#621)**: a whole-clip quote goes to BOTH halves, a time-range quote to the
    half containing it, and one straddling the cut is DIVIDED at the cut.
    """
    if not math.isfinite(at_time):
        raise HTTPException(status_code=400, detail="Split time must be a finite number of seconds.")
    segment = _clip_or_404(db, observation_id, segment_id)
    if not (segment.start_time < at_time < segment.end_time):
        raise HTTPException(
            status_code=400,
            detail="The split time must fall strictly inside the clip's range.",
        )

    original_apps = _human_app_fields(segment)
    original_note_ids = [n.id for n in segment.attached_notes if not n.is_archived]
    to_first, to_second, to_divide = _clip_excerpt_carry_plan(
        list(segment.excerpts), at_time,
    )
    carried_quotes = (to_first, to_second)

    halves: list[Segment] = []
    for i, (start, end) in enumerate(
        ((segment.start_time, at_time), (at_time, segment.end_time))
    ):
        half = Segment(**_make_segment_fields(
            'observation', observation_id,
            sequence_order=segment.sequence_order,  # provisional; resequenced below
            start_time=start,
            end_time=end,
            text=segment.text,
            is_split_result=1,
        ))
        db.add(half)
        db.flush()
        for app in original_apps:
            db.add(CodeApplication(segment_id=half.id, **app))
        for ex in carried_quotes[i]:
            db.add(_copy_clip_excerpt(ex, half.id))
        halves.append(half)

    # A straddling quote becomes two — the piece before the cut on the first
    # half, the piece after it on the second.
    for ex, ex_start, ex_end in to_divide:
        db.add(_copy_clip_excerpt(ex, halves[0].id, start=ex_start, end=at_time))
        db.add(_copy_clip_excerpt(ex, halves[1].id, start=at_time, end=ex_end))

    if original_note_ids:
        db.query(Note).filter(Note.id.in_(original_note_ids)).update(
            {Note.segment_id: halves[0].id}, synchronize_session='fetch',
        )

    segment.split_into_id = halves[0].id
    db.flush()
    resequence_observation_clips(db, observation_id)

    log_action(
        db, action="clip_split", entity_type="segment", entity_id=segment.id,
        user_id=user_id, project_id=project_id,
        details={"at_time": at_time, "new_segment_ids": [h.id for h in halves]},
    )
    _mark_consensus_stale_for_parent(db, project_id, 'observation', observation_id)
    db.commit()

    return _clip_reload(db, [h.id for h in halves])


def merge_clips(
    db: Session,
    segment_ids: list[int],
    observation_id: int,
    project_id: int,
    user_id: int,
) -> Segment:
    """Merge ≥2 clips into one spanning [min(start), max(end)]. Returns it.

    NO adjacency requirement (§0.7): clips overlap and gap freely, and merging
    non-overlapping clips SPANS the gap — documented behavior, undoable via the
    reused unmerge_segment (its merged_into_id discovery is parent-agnostic).
    Label = distinct non-empty labels in temporal order, joined " / ". Notes
    stay on the hidden originals (mirrors the text merge; unmerge restores
    them). Codes dedup on the per-coder key (code_id, user_id).

    **Quotes carry forward (#621), and BOTH shapes need deduplication** — not
    as tidiness but because the partial unique indexes make the naive version
    an IntegrityError:

    - N whole-clip quotes across the inputs COLLAPSE to one on the merged clip
      (`ix_excerpt_segment_whole` permits exactly one per segment).
    - time-range quotes carry verbatim — their times are absolute (D29) and the
      merged range spans every input, so containment survives by construction —
      but two inputs may hold the SAME range (overlapping clips quoting one
      moment), and `ix_excerpt_segment_time_range` is unique on
      (segment_id, start_time, end_time). Dedup on that pair.
    """
    distinct_ids = set(segment_ids)
    if len(distinct_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 clips are required for merging")

    segments = (
        db.query(Segment)
        .filter(
            Segment.id.in_(distinct_ids),
            Segment.observation_id == observation_id,
            *_visible(),
        )
        .options(
            selectinload(Segment.code_applications),
            # #621: without this the quote carry lazy-loads once PER input clip.
            selectinload(Segment.excerpts),
        )
        .order_by(Segment.start_time, Segment.end_time, Segment.id)
        .all()
    )
    if len(segments) != len(distinct_ids):
        raise HTTPException(status_code=400, detail="Some clips were not found or are already merged")

    labels: list[str] = []
    for seg in segments:
        label = seg.text.strip()
        if label and label not in labels:
            labels.append(label)

    merged = Segment(**_make_segment_fields(
        'observation', observation_id,
        sequence_order=segments[0].sequence_order,  # provisional; resequenced below
        start_time=segments[0].start_time,  # min — the list is time-ordered
        end_time=max(seg.end_time for seg in segments),
        text=" / ".join(labels),
        is_merge_result=1,
    ))
    db.add(merged)
    db.flush()

    seen: set[tuple[int, int | None]] = set()
    for seg in segments:
        for app in _human_app_fields(seg):
            key = (app["code_id"], app["user_id"])
            if key in seen:
                continue
            seen.add(key)
            db.add(CodeApplication(segment_id=merged.id, **app))

    # Quotes (#621) — deduped against the two partial unique indexes.
    seen_quotes: set[tuple[float, float] | None] = set()
    for seg in segments:
        for ex in seg.excerpts:
            key = None if ex.start_time is None else (ex.start_time, ex.end_time)
            if key in seen_quotes:
                continue
            seen_quotes.add(key)
            db.add(_copy_clip_excerpt(ex, merged.id))

    for seg in segments:
        seg.merged_into_id = merged.id

    db.flush()
    resequence_observation_clips(db, observation_id)

    log_action(
        db, action="clip_merge", entity_type="segment", entity_id=merged.id,
        user_id=user_id, project_id=project_id,
        details={"merged_segment_ids": [seg.id for seg in segments]},
    )
    _mark_consensus_stale_for_parent(db, project_id, 'observation', observation_id)
    db.commit()

    return _clip_reload(db, [merged.id])[0]


def unsplit_clip(
    db: Session,
    child_ids: list[int],
    observation_id: int,
    project_id: int,
    user_id: int,
) -> Segment:
    """Rejoin a time-split's two halves, restoring the original clip.

    Takes BOTH child ids EXPLICITLY (the split response / undo entry carries
    them) — deliberately NOT unsplit_segment, whose sibling discovery is the
    _find_split_siblings contiguous-sequence heuristic: sound for text (split
    children stay textually adjacent) and UNSOUND for clips, whose time-based
    resequencing can interleave different splits' children into one contiguous
    run (§0.7). Validates the pair TILES the original's range exactly — the
    floats were written verbatim at split time, so equality is exact; a
    boundary-edited half legitimately refuses (an undo whose target was edited
    since is not an undo).
    """
    if len(set(child_ids)) != 2:
        raise HTTPException(
            status_code=400, detail="Exactly the split's two clips are required to rejoin"
        )

    original = (
        db.query(Segment)
        .filter(
            Segment.split_into_id.in_(child_ids),
            Segment.observation_id == observation_id,
        )
        .options(selectinload(Segment.code_applications))
        .first()
    )
    if not original:
        raise HTTPException(status_code=400, detail="No split original found for these clips")

    children = (
        db.query(Segment)
        .filter(
            Segment.id.in_(child_ids),
            Segment.observation_id == observation_id,
            Segment.is_split_result == 1,
            *_visible(),
        )
        .order_by(Segment.start_time)
        .all()
    )
    if len(children) != 2:
        raise HTTPException(
            status_code=400, detail="Some clips were not found or are not split halves"
        )

    first, second = children
    tiles = (
        first.start_time == original.start_time
        and second.end_time == original.end_time
        and first.end_time == second.start_time
    )
    if not tiles:
        raise HTTPException(
            status_code=400,
            detail="These clips no longer tile the original's range — it can't be rejoined.",
        )

    child_id_list = [c.id for c in children]

    original.split_into_id = None

    # Notes on the halves move (back) to the restored original.
    db.query(Note).filter(Note.segment_id.in_(child_id_list)).update(
        {Note.segment_id: original.id}, synchronize_session='fetch',
    )

    # Project-back recovery (J2-0) via the shared helper.
    existing_keys: set[tuple[int, int | None]] = {
        (ca.code_id, ca.user_id) for ca in original.code_applications
    }
    carried_back = _carried_back_fields(db, child_id_list, existing_keys)

    for seg in children:
        db.delete(seg)
    db.flush()

    for fields in carried_back:
        db.add(CodeApplication(segment_id=original.id, **fields))

    db.flush()
    resequence_observation_clips(db, observation_id)

    log_action(
        db, action="clip_unsplit", entity_type="segment", entity_id=original.id,
        user_id=user_id, project_id=project_id,
        details={"restored_segment_id": original.id, "deleted_split_ids": child_id_list},
    )
    _mark_consensus_stale_for_parent(db, project_id, 'observation', observation_id)
    db.commit()

    return _clip_reload(db, [original.id])[0]
