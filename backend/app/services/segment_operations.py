"""Shared segment split/merge operations for both conversations and documents,
plus the observation-clip TIME operations (slab 3b) and the text edit's quote
rebase (#1319)."""

import difflib
import math
import re
import unicodedata

from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import func

from fastapi import HTTPException

from ..models.segment import Segment
from ..models.speaker import Speaker
from ..models.code_application import CodeApplication
from ..models.note import Note
from ..models.excerpt import Excerpt
from .audit import log_action
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

    #35 / #869 (a): the RATING and the merge disagreement flag are part of the
    layer too. Both are that coder's own judgement on that (target, code), and
    before this carried them every merge / split / unmerge / unsplit and both clip
    ops re-created the application UNRATED — silent data loss on an ordinary
    editing gesture. ⚠️ Enumerate the fields by what the model declares as
    per-application STATE, not by the five this used to list.
    """
    return {
        "code_id": ca.code_id,
        "user_id": ca.user_id,
        "attribution": ca.attribution,
        "origin": ca.origin,
        "origin_context": ca.origin_context,
        "magnitude": ca.magnitude,
        "magnitude_conflict": ca.magnitude_conflict,
    }


def _dedup_carried_layers(rows: list[dict]) -> list[dict]:
    """Collapse carried application layers onto the per-coder key, first wins.

    Shared by the two MERGES (text segments and clips). The widened unique index
    permits ONE row per ``(target, code, user_id)``, so when two originals carry
    the same coder's same code only the first survives — and its attribution
    note, origin context and RATING are the ones kept.

    #35: **a dropped duplicate's DIFFERING rating is recorded as the kept row's
    ``magnitude_conflict``**, the same shape the project merge uses (the rules
    file's §6d — keep ours, record the other number, never block). The coder's
    two ratings of one code are being collapsed into one row; silently keeping
    the first would lose a judgement they made, and the reconciliation grid
    already knows how to say "your other copy rated this N". Rating the merged
    segment again clears it, exactly like every other conflict. A duplicate
    with NO rating, or an EQUAL one, has nothing to say and leaves whatever flag
    the kept row already carried alone (that flag names a DIFFERENT other copy).
    ⚠️ ``is not None`` — a duplicate rated ZERO is a real disagreement against a
    rated first row, and against an UNRATED first row it is flagged while the
    kept ``magnitude`` stays NULL (a merge never promotes a rating the coder did
    not give to that row).
    """
    kept: dict[tuple[int, int | None], dict] = {}
    for row in rows:
        key = (row["code_id"], row["user_id"])
        first = kept.get(key)
        if first is None:
            kept[key] = dict(row)
            continue
        other = row.get("magnitude")
        if other is not None and other != first.get("magnitude"):
            first["magnitude_conflict"] = other
    return list(kept.values())


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
    # distinct (code, coder, attribution, origin, origin_context, rating) tuples
    # — NOT a bare code_id union re-stamped to the operator. Dedup on the
    # per-coder key (code_id, user_id); first occurrence wins when two originals
    # carry the same coder's same code (their attribution notes may differ —
    # only one row fits the widened unique index), and a dropped duplicate's
    # differing RATING lands in the kept row's `magnitude_conflict` (#35).
    carried = _dedup_carried_layers([
        _carried_app_fields(ca) for seg in segments for ca in seg.code_applications
    ])
    for app in carried:
        db.add(CodeApplication(segment_id=merged_segment.id, **app))

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
# No mark_metrics_stale here, nor on the text ops (#1149 b): a metric reads only
# dataset columns and variable groups (`ck_metric_definition_source_type`), never a
# segment, so a segment op has no metric to mark.


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


# ── Text edits (#1319) ───────────────────────────────────────────────────────
#
# Editing a turn's or paragraph's text is a SEGMENT OPERATION: every char-range
# quote on it is an offset pair into that text, so an edit that leaves the offsets
# alone silently moves every later quote onto other words (#1319 measured 'not
# helpful' → ' it was not' and, on a shortened turn, ''). Both edit doors
# (`routers/segments.py::update_segment`, `routers/documents.py::
# update_document_segment`) go through `apply_text_edit`, which is the ONE writer
# of `Segment.text` for a text edit; a fail-closed AST scan
# (`tests/test_text_edit_quote_rebase.py`) refuses any other.
#
# ⚠️ It shares the split carry's COORDINATE model (code points, one run of source
# text landing at a known place) and deliberately NOT its decision: the split
# DIVIDES a quote across the regions it overlaps, which for an edit would turn the
# unchanged stretches either side of a typo into two quotes. An edit keeps ONE
# quote per quote, and asks before moving an edge it cannot place.

# Word-plus-trailing-space tokens. Separate whitespace tokens repeat thousands of
# times in a long paragraph and make an autojunk-free SequenceMatcher quadratic in
# practice (measured: 3.3 s at 20k characters of a small vocabulary; 0.2 s with
# these tokens).
_EDIT_TOKEN = re.compile(r"\S+\s*|\s+")

# Above this many tokens on either side of the changed middle, the middle is ONE
# change rather than a diff. Measured on real transcript text (a Supreme Court
# argument): 1,751 tokens in 14 ms, 3,526 in 28 ms, 10,661 in 418 ms; a small-
# vocabulary worst case ~100 ms at this cap. Both doors are `async def`, so this
# work runs on the event loop and the cap is what bounds the freeze. Over it,
# quotes inside the middle are offered for confirmation instead of being
# followed — never moved silently.
TEXT_EDIT_TOKEN_CAP = 2_000

REBASE_SILENT = "silent"
REBASE_EDGE = "edge"
REBASE_STRADDLE = "straddle"
REBASE_GONE = "gone"
# The outcomes D5 shows before saving: a change touches the quote's edge from
# inside, crosses an edge, or leaves none of its words.
REBASE_NEEDS_CONFIRM = frozenset({REBASE_EDGE, REBASE_STRADDLE, REBASE_GONE})


class _EditRun(NamedTuple):
    """One changed stretch: OLD text [old_start, old_end) became NEW text
    [new_start, new_end). Absolute code-point positions in each string."""
    old_start: int
    old_end: int
    new_start: int
    new_end: int


class QuoteRebase(NamedTuple):
    """What a text edit does to one char-range quote (#1319)."""
    excerpt_id: int
    outcome: str            # REBASE_SILENT / _EDGE / _STRADDLE / _GONE
    old_start: int
    old_end: int
    new_start: int | None   # None when the outcome is GONE
    new_end: int | None


class RebasePlan(NamedTuple):
    quotes: list[QuoteRebase]
    capped: bool            # the changed middle exceeded TEXT_EDIT_TOKEN_CAP


def _is_word(text: str, i: int) -> bool:
    """A non-space character at ``i`` — the token model's notion of 'inside a word'."""
    return 0 <= i < len(text) and not text[i].isspace()


def _is_word_char(ch: str) -> bool:
    """A character that makes a word LONGER when glued onto one (#1477): anything but
    whitespace and punctuation — letters, digits, marks (a decomposed accent, an Indic
    vowel sign) and symbols (an emoji, its skin tone). Unicode categories, so CJK and
    Thai count with no list of scripts."""
    return not ch.isspace() and not unicodedata.category(ch).startswith("P")


def _glued_word_reach(text: str, start: int, end: int, step: int) -> int | None:
    """Within ``text[start:end]`` — a change's NEW text, read outward from the quote's
    edge (``step`` +1 after the end, -1 before the start) up to its first whitespace —
    the position of the farthest word character, or None when only punctuation is
    glued there: "no" -> "nothing" glues a word, "help" -> "help." does not, and
    "can" -> "can't" does (the apostrophe is crossed, the 't' is reached)."""
    reach = None
    i = start if step > 0 else end - 1
    while start <= i < end and not text[i].isspace():
        if _is_word_char(text[i]):
            reach = i
        i += step
    return reach


def _text_edit_runs(old: str, new: str) -> tuple[list[_EditRun], bool]:
    """The changed stretches between ``old`` and ``new``, in CODE POINTS.

    1. Trim the common prefix and suffix (linear) — a typo fix touches a few
       characters of a long turn, and everything outside them is unchanged by
       definition.
    2. Widen that window to whitespace boundaries when it would start or end
       MID-WORD, so a run never begins inside a word the edit changed. Character
       alignment is the trap here: "was not" → "wasn't" would otherwise keep the
       'n' and turn the quote 'not helpful' into "n't helpful" silently.
    3. Diff the middle by word-plus-trailing-space tokens with ``autojunk=False``
       (the default junks any token past 1% of a 200+-token middle, so common
       words stop anchoring the alignment), capped at TEXT_EDIT_TOKEN_CAP.
    4. Refine each changed run: ONE word replaced by ONE word shrinks to its
       minimal character change (so 'helpfull' → 'helpful' is the deletion of an
       'l', not a change to the whole word); any other run sheds only the
       whitespace and punctuation both sides share, so a word's trailing space or
       full stop never makes a run cross a quote that ends at the word — and a
       letter is never shed, so a run never starts or ends mid-word.
    """
    n = min(len(old), len(new))
    p = 0
    while p < n and old[p] == new[p]:
        p += 1
    s = 0
    while s < n - p and old[-1 - s] == new[-1 - s]:
        s += 1
    if p == len(old) and p == len(new):
        return [], False

    if _is_word(old, p - 1) and (_is_word(old, p) or _is_word(new, p)):
        while _is_word(old, p - 1):
            p -= 1
    if _is_word(old, len(old) - s) and (
        _is_word(old, len(old) - s - 1) or _is_word(new, len(new) - s - 1)
    ):
        while s > 0 and _is_word(old, len(old) - s):
            s -= 1

    a_end, b_end = len(old) - s, len(new) - s
    ta = [(m.start() + p, m.end() + p) for m in _EDIT_TOKEN.finditer(old[p:a_end])]
    tb = [(m.start() + p, m.end() + p) for m in _EDIT_TOKEN.finditer(new[p:b_end])]
    if len(ta) > TEXT_EDIT_TOKEN_CAP or len(tb) > TEXT_EDIT_TOKEN_CAP:
        return [_EditRun(p, a_end, p, b_end)], True

    matcher = difflib.SequenceMatcher(
        None,
        [old[x:y] for x, y in ta],
        [new[x:y] for x, y in tb],
        autojunk=False,
    )
    runs: list[_EditRun] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        o1 = ta[i1][0] if i1 < len(ta) else a_end
        o2 = ta[i2 - 1][1] if i2 > i1 else o1
        n1 = tb[j1][0] if j1 < len(tb) else b_end
        n2 = tb[j2 - 1][1] if j2 > j1 else n1
        one_word = (i2 - i1 == 1 and j2 - j1 == 1)
        while o1 < o2 and n1 < n2 and old[o1] == new[n1] and (one_word or not old[o1].isalnum()):
            o1 += 1
            n1 += 1
        while o2 > o1 and n2 > n1 and old[o2 - 1] == new[n2 - 1] and (
            one_word or not old[o2 - 1].isalnum()
        ):
            o2 -= 1
            n2 -= 1
        runs.append(_EditRun(o1, o2, n1, n2))
    return runs, False


def _rebase_one_quote(
    runs: list[_EditRun], excerpt_id: int, s: int, e: int, old: str, new: str,
) -> QuoteRebase:
    """One quote's outcome — the four cases D5 names, decided on the runs (and, for
    a change abutting an edge, the characters it glues on).

    - **silent** — both ends sit in unchanged text. A change wholly INSIDE the quote
      is absorbed (the quote keeps its words, with the change), and a change exactly
      AT an edge stays OUTSIDE it when whitespace or only punctuation separates it
      from the quote's edge character: text typed before a quote's first word is
      not something the researcher marked.
    - **edge** — a change touches an edge from inside (a typo in the quote's last
      word), or — #1477 — abuts it from outside and GLUES a word character onto the
      edge's word ("no" -> "nothing", "able" -> "unable", "cat" -> "cats"), which
      would leave the quote marking part of a new word. Proposed span: the quote
      with that change (for a glued word, the quote over the whole new word).
    - **straddle** — a change crosses an edge. Proposed span: WIDENED to cover the
      change, so no marked word is dropped (a deletion crossing an edge narrows it to
      what survives, by the same rule).
    - **gone** — none of the quote's words survive: its span is deleted, or every
      character was replaced as part of a larger change. No span is proposed.
    """
    start_shift = end_shift = 0
    crossed_start: int | None = None
    crossed_end: int | None = None
    touches_edge = False
    covered = 0
    covered_by_wider_change = False
    for r in runs:
        delta = (r.new_end - r.new_start) - (r.old_end - r.old_start)
        if r.old_end <= s:
            # Wholly before — a pure insertion AT s included, so it stays outside
            # (unless it glues a word onto the quote's first word: #1477, below).
            start_shift += delta
        if r.old_end <= e and r.old_start < e:
            # Every run before the end moves it — except a pure insertion AT e.
            end_shift += delta
        if r.old_start < s < r.old_end:
            crossed_start = r.new_start
        if r.old_start < e < r.old_end:
            crossed_end = r.new_end
        if (
            s <= r.old_start and r.old_end <= e and r.old_start < r.old_end
            and (r.old_start == s or r.old_end == e)
        ):
            touches_edge = True
        lo, hi = max(r.old_start, s), min(r.old_end, e)
        if hi > lo:
            covered += hi - lo
            if r.old_start < s or r.old_end > e:
                covered_by_wider_change = True

    new_start = crossed_start if crossed_start is not None else s + start_shift
    new_end = crossed_end if crossed_end is not None else e + end_shift
    if new_end <= new_start or (covered == e - s and covered_by_wider_change):
        return QuoteRebase(excerpt_id, REBASE_GONE, s, e, None, None)

    # #1477: a change abutting an edge from OUTSIDE leaves both ends in unchanged
    # text, so on the runs alone it is silent — while "said no" kept over "said
    # nothing" marks part of a word that now says the opposite. When it glues a word
    # character onto a word-character edge, with no whitespace between, it touches
    # the edge: ask, and propose the quote over the whole new word. The run's new
    # text begins exactly at the quote's new end (or ends at its new start), because
    # runs never overlap — which is also why no run here can cross that edge (a
    # `crossed_end is None` guard was mutation-proven redundant).
    for r in runs:
        if r.old_start == e and _is_word_char(old[e - 1]):
            reach = _glued_word_reach(new, r.new_start, r.new_end, 1)
            if reach is not None:
                new_end = reach + 1
                touches_edge = True
        if r.old_end == s and _is_word_char(old[s]):
            reach = _glued_word_reach(new, r.new_start, r.new_end, -1)
            if reach is not None:
                new_start = reach
                touches_edge = True
    if crossed_start is not None or crossed_end is not None:
        outcome = REBASE_STRADDLE
    elif touches_edge:
        outcome = REBASE_EDGE
    else:
        outcome = REBASE_SILENT
    return QuoteRebase(excerpt_id, outcome, s, e, new_start, new_end)


def plan_text_edit_rebase(
    old: str, new: str, quotes: list[tuple[int, int, int]],
) -> RebasePlan:
    """Decide where each char-range quote goes when ``old`` is edited into ``new``.

    ``quotes`` is ``(excerpt_id, start_offset, end_offset)`` in code points (#687).
    Pure: no session, no writes — the preview and the apply share it, which is
    what makes the preview a promise about the apply.

    ⚠️ A quote whose offsets do not fit the OLD text (past damage, #1319 out of
    scope) is left exactly where it is, as SILENT: this edit neither repairs it
    nor deletes it.
    """
    runs, capped = _text_edit_runs(old, new)
    out: list[QuoteRebase] = []
    for excerpt_id, s, e in quotes:
        if not (0 <= s < e <= len(old)):
            out.append(QuoteRebase(excerpt_id, REBASE_SILENT, s, e, s, e))
            continue
        out.append(_rebase_one_quote(runs, excerpt_id, s, e, old, new))
    return RebasePlan(out, capped)


def _span_collisions(spans: dict[int, tuple[int, int]]) -> list[list[int]]:
    """Groups of excerpt ids that would share one span — `ix_excerpt_segment_range`
    is unique per segment, so this is a refusal, never an IntegrityError."""
    by_span: dict[tuple[int, int], list[int]] = {}
    for excerpt_id, span in spans.items():
        by_span.setdefault(span, []).append(excerpt_id)
    return [sorted(ids) for ids in by_span.values() if len(ids) > 1]


def _char_quotes(segment: Segment) -> list[Excerpt]:
    return sorted(
        (ex for ex in segment.excerpts if ex.start_offset is not None and ex.end_offset is not None),
        key=lambda ex: ex.id,
    )


def _has_live_note(ex: Excerpt) -> bool:
    return ex.note is not None and not ex.note.is_archived


def _plan_item(
    q: QuoteRebase, ex: Excerpt, old: str, new: str, *,
    new_span: tuple[int, int] | None, removed: bool = False, explicit: bool = False,
) -> dict:
    """One quote's line in the report the client shows (and keeps for undo)."""
    return {
        "excerpt_id": q.excerpt_id,
        "outcome": q.outcome,
        "old_start": q.old_start,
        "old_end": q.old_end,
        "new_start": new_span[0] if new_span else None,
        "new_end": new_span[1] if new_span else None,
        "old_text": old[q.old_start:q.old_end],
        "new_text": new[new_span[0]:new_span[1]] if new_span else None,
        "has_note": _has_live_note(ex),
        "removed": removed,
        "explicit": explicit,
    }


def preview_text_edit(segment: Segment, new_text: str) -> dict:
    """The plan for editing ``segment``'s text to ``new_text`` — READ-ONLY.

    The #1054 plan-then-apply shape: the client shows the quotes this edit would
    move before anything is written, because `useHistory.execute` swallows a failed
    act and an apply refusal alone would leave the researcher guessing.
    ``collisions`` are the groups that would share a span if every flagged quote
    were KEPT as proposed; removing them is always possible.
    """
    old = segment.text or ""
    by_id = {ex.id: ex for ex in _char_quotes(segment)}
    plan = plan_text_edit_rebase(
        old, new_text, [(ex.id, ex.start_offset, ex.end_offset) for ex in by_id.values()],
    )
    items = []
    kept: dict[int, tuple[int, int]] = {}
    for q in plan.quotes:
        span = (q.new_start, q.new_end) if q.new_start is not None else None
        if span is not None:
            kept[q.excerpt_id] = span
        items.append(_plan_item(q, by_id[q.excerpt_id], old, new_text, new_span=span))
    return {
        "text": new_text,
        "quotes": items,
        "needs_confirmation": any(q.outcome in REBASE_NEEDS_CONFIRM for q in plan.quotes),
        "collisions": _span_collisions(kept),
        "capped": plan.capped,
    }


def _refuse(status: int, error: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": error, "message": message, **extra})


def apply_text_edit(
    db: Session,
    segment: Segment,
    new_text: str,
    *,
    remove_excerpt_ids: list[int] | None = None,
    excerpt_offsets: list[tuple[int, int, int]] | None = None,
) -> tuple[dict, dict]:
    """Write a text edit and carry every char-range quote with it (#1319).

    THE writer of `Segment.text` for a text edit. Returns ``(plan, audit)``: the
    per-quote report for the response, and the same report WITHOUT WORDS for the
    audit row (D6 — a document edit's audit row carries lengths and the rebase,
    never text: the old text would outlive a withdrawal).

    - ``excerpt_offsets`` — ``(excerpt_id, start, end)`` placed EXACTLY, in the new
      text's code points. It is how an undo restores every quote to its pre-edit
      offsets (the #1023 shape: captured at the act, never re-derived), and how
      "keep as shown" keeps a flagged quote at the span the researcher was shown.
      An id that is no longer on this segment is ignored: there is nothing to put
      back (a quote deleted since, or re-created under a new id by an undo).
    - ``remove_excerpt_ids`` — the quotes this edit deletes. It must EQUAL the
      plan's unplaceable set — the flagged quotes (edge / straddle / gone) that
      ``excerpt_offsets`` does not place — or the edit is refused with a 409: the
      server never deletes a quote the client did not name, and never moves a
      flagged quote the client was not shown.
    - Two quotes landing on one span is a 409 (``ix_excerpt_segment_range``), not
      an IntegrityError.
    """
    old = segment.text or ""
    quotes = _char_quotes(segment)
    by_id = {ex.id: ex for ex in quotes}
    remove = set(remove_excerpt_ids or [])
    explicit: dict[int, tuple[int, int]] = {}
    for excerpt_id, start, end in excerpt_offsets or []:
        if excerpt_id not in by_id:
            continue
        if not (0 <= start < end <= len(new_text)):
            raise _refuse(
                400, "excerpt_offsets_invalid",
                "A quote's position falls outside the edited text.",
                excerpt_ids=[excerpt_id],
            )
        explicit[excerpt_id] = (start, end)
    both = sorted(remove & set(explicit))
    if both:
        raise _refuse(
            400, "excerpt_offsets_invalid",
            "A quote cannot be both kept at a position and removed.",
            excerpt_ids=both,
        )

    plan = plan_text_edit_rebase(
        old, new_text, [(ex.id, ex.start_offset, ex.end_offset) for ex in quotes],
    )
    unplaceable = {
        q.excerpt_id for q in plan.quotes
        if q.outcome in REBASE_NEEDS_CONFIRM and q.excerpt_id not in explicit
    }
    if remove != unplaceable:
        raise _refuse(
            409, "quotes_need_confirmation",
            "This change would alter the words of a quote on this passage without "
            "saying what should happen to it, so nothing was changed.",
            unplaceable_excerpt_ids=sorted(unplaceable),
        )

    final: dict[int, tuple[int, int]] = {}
    for q in plan.quotes:
        if q.excerpt_id in remove:
            continue
        final[q.excerpt_id] = explicit.get(q.excerpt_id, (q.new_start, q.new_end))
    collisions = _span_collisions(final)
    if collisions:
        raise _refuse(
            409, "quotes_collide",
            "Two quotes would mark the same words after this change, so nothing was "
            "changed. Remove one of them first.",
            collisions=collisions,
        )

    items: list[dict] = []
    audit_quotes: list[dict] = []
    for q in plan.quotes:
        ex = by_id[q.excerpt_id]
        removed = q.excerpt_id in remove
        span = None if removed else final[q.excerpt_id]
        items.append(_plan_item(
            q, ex, old, new_text, new_span=span,
            removed=removed, explicit=q.excerpt_id in explicit,
        ))
        audit_quotes.append({
            "excerpt_id": q.excerpt_id,
            "outcome": q.outcome,
            "old": [q.old_start, q.old_end],
            "new": list(span) if span else None,
            "removed": removed,
            "explicit": q.excerpt_id in explicit,
        })

    # Removals first: a removed quote's span may be another quote's destination.
    # The note survives with its link cleared, exactly as the excerpt DELETE door does.
    if remove:
        db.query(Note).filter(Note.excerpt_id.in_(sorted(remove))).update(
            {Note.excerpt_id: None}, synchronize_session=False,
        )
        for excerpt_id in sorted(remove):
            db.delete(by_id[excerpt_id])
        db.flush()

    # Two phases: SQLite checks `ix_excerpt_segment_range` per UPDATE, so moving A
    # onto B's OLD span before B leaves it collides transiently even when the final
    # state is unique. Park every mover beyond both texts first.
    movers = [
        excerpt_id for excerpt_id, span in final.items()
        if span != (by_id[excerpt_id].start_offset, by_id[excerpt_id].end_offset)
    ]
    if movers:
        park = max(
            [len(old), len(new_text)]
            + [ex.end_offset for ex in quotes if ex.id not in remove]
        ) + 1
        for k, excerpt_id in enumerate(movers):
            by_id[excerpt_id].start_offset = park + 2 * k
            by_id[excerpt_id].end_offset = park + 2 * k + 1
        db.flush()
        for excerpt_id in movers:
            by_id[excerpt_id].start_offset, by_id[excerpt_id].end_offset = final[excerpt_id]

    segment.text = new_text
    segment.word_count = len(new_text.split())
    db.flush()

    report = {
        "text": new_text,
        "quotes": items,
        "needs_confirmation": False,
        "collisions": [],
        "capped": plan.capped,
    }
    audit = {
        "old_length": len(old),
        "new_length": len(new_text),
        "quote_rebase": audit_quotes,
    }
    return report, audit


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

    # (code, coder) dedup, first wins, a dropped duplicate's differing rating
    # recorded on the kept row — the same rule as the text merge (#35).
    for app in _dedup_carried_layers([
        app for seg in segments for app in _human_app_fields(seg)
    ]):
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
