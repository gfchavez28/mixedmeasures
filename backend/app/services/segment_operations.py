"""Shared segment split/merge operations for both conversations and documents."""

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


def _parent_filter(parent_type: str, parent_id: int):
    """Return SQLAlchemy filter clause for segment parent."""
    if parent_type == 'conversation':
        return Segment.conversation_id == parent_id
    return Segment.document_id == parent_id


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
        selectinload(Segment.code_applications),
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
    """Build dict of fields for a new segment with correct parent FK set."""
    fields = {
        'conversation_id': parent_id if parent_type == 'conversation' else None,
        'document_id': parent_id if parent_type == 'document' else None,
    }
    fields.update(kwargs)
    return fields


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
    if len(segment_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 segments required for merging")

    segments = db.query(Segment).filter(
        Segment.id.in_(segment_ids),
        _parent_filter(parent_type, parent_id),
        *_visible(),
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
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

    # Union all codes
    all_code_ids: set[int] = set()
    for seg in segments:
        for ca in seg.code_applications:
            all_code_ids.add(ca.code_id)
    for code_id in all_code_ids:
        db.add(CodeApplication(segment_id=merged_segment.id, code_id=code_id, user_id=user_id))

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
    ).order_by(Segment.sequence_order).all()

    if not originals:
        raise HTTPException(status_code=400, detail="No original segments found to restore")

    merged_order = segment.sequence_order

    # Restore originals
    for orig in originals:
        orig.merged_into_id = None

    # Delete merged segment's codes/notes, then the segment itself
    db.query(CodeApplication).filter(CodeApplication.segment_id == segment_id).delete()
    db.query(Note).filter(Note.segment_id == segment_id).delete()
    db.delete(segment)

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

    log_action(
        db, action="unmerged", entity_type="segment", entity_id=segment_id,
        user_id=user_id, project_id=project_id,
        details={"restored_segment_ids": original_ids, "restored_count": num_originals},
    )
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
) -> tuple[list[Segment], list[int]]:
    """Split segment(s). Returns (new_segments, deleted_segment_ids)."""
    if len(ranges) == 1:
        return _split_single(db, ranges[0], parent_type, parent_id, project_id, user_id)
    return _split_multi(db, ranges, parent_type, parent_id, project_id, user_id)


def _split_single(db, r, parent_type, parent_id, project_id, user_id):
    """Split a single segment into up to 3 parts."""
    segment = db.query(Segment).filter(
        Segment.id == r.segment_id,
        _parent_filter(parent_type, parent_id),
        *_visible(),
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
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

    # Save properties from original before mutations
    original_code_ids = [ca.code_id for ca in segment.code_applications]
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

    # Build parts
    parts = []
    if before_text:
        parts.append(('before', before_text))
    parts.append(('selected', selected_text))
    if after_text:
        parts.append(('after', after_text))

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

        for code_id in original_code_ids:
            db.add(CodeApplication(segment_id=new_seg.id, code_id=code_id, user_id=user_id))

        if part_type == 'selected' and had_whole_excerpt:
            db.add(Excerpt(project_id=project_id, segment_id=new_seg.id))

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
    mark_metrics_stale(db, project_id)
    db.commit()

    result = db.query(Segment).filter(
        Segment.id.in_([s.id for s in new_segments]),
    ).options(*_eager_load_options()).order_by(Segment.sequence_order).all()

    return result, [original_id]


def _split_multi(db, ranges, parent_type, parent_id, project_id, user_id):
    """Split across multiple adjacent segments."""
    segment_ids = [r.segment_id for r in ranges]
    segments = db.query(Segment).filter(
        Segment.id.in_(segment_ids),
        _parent_filter(parent_type, parent_id),
        *_visible(),
    ).options(
        joinedload(Segment.speaker),
        selectinload(Segment.code_applications),
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

    # Collect codes and notes
    all_code_ids: set[int] = set()
    all_note_ids: list[int] = []
    for seg in segments:
        for ca in seg.code_applications:
            all_code_ids.add(ca.code_id)
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
    if before_text:
        parts.append(('before', before_text, first_speaker_id))
    parts.append(('selected', selected_text, merged_speaker_id))
    if after_text:
        parts.append(('after', after_text, last_speaker_id))

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

        for code_id in all_code_ids:
            db.add(CodeApplication(segment_id=new_seg.id, code_id=code_id, user_id=user_id))

        if part_type == 'selected' and had_whole_excerpt:
            db.add(Excerpt(project_id=project_id, segment_id=new_seg.id))

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

    # Delete code applications on split segments
    db.query(CodeApplication).filter(
        CodeApplication.segment_id.in_(split_ids),
    ).delete(synchronize_session='fetch')

    # Delete split-result segments
    for seg in split_segments:
        db.delete(seg)

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
    mark_metrics_stale(db, project_id)
    db.commit()

    restored = db.query(Segment).filter(
        Segment.id == original.id,
    ).options(*_eager_load_options()).first()

    return restored, num_split
