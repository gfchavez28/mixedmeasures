"""Service layer for cross-conversation qualitative code analysis.

Supports three source modes:
- "conversations" (default): segment-based code applications (conversations + documents)
- "comments": only dataset-value-based code applications (comment coding)
- "all": merged results from all sources
"""

from collections import defaultdict
from itertools import combinations
from sqlalchemy.orm import Session, contains_eager, joinedload
from sqlalchemy import func, literal, case as sa_case

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.code_category import CodeCategory
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.speaker import Speaker
from ..models.participant import Participant
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.excerpt import Excerpt

# ── Rounding precision constants ─────────────────────────────────────────────
DISPLAY_PERCENTAGE_PRECISION = 1  # round(x, 1) for display percentages (e.g. 42.9%)


def _get_universal_code_ids(db: Session, project_id: int) -> set[int]:
    return set(
        cid for (cid,) in db.query(Code.id).filter(
            Code.project_id == project_id, Code.is_universal == True,
        ).all()
    )


# ── Internal: conversation-based frequencies ─────────────────────────────────

def _get_conversation_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
) -> dict:
    """Compute code frequency stats from conversation segments only."""
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.segment_id)).label("seg_count"),
            func.count(func.distinct(Segment.conversation_id)).label("conv_count"),
            func.count(func.distinct(Speaker.participant_id)).label("part_count"),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if exclude_facilitator:
        base = base.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conversation_ids:
        base = base.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        base = base.filter(Speaker.participant_id.in_(participant_ids))
    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2], row[3]) for row in freq_rows}

    # Totals
    universal_ids = _get_universal_code_ids(db, project_id)

    coded_seg_query = (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        coded_seg_query = coded_seg_query.filter(~CodeApplication.code_id.in_(universal_ids))
    if exclude_facilitator:
        coded_seg_query = coded_seg_query.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        coded_seg_query = coded_seg_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        coded_seg_query = coded_seg_query.filter(Speaker.participant_id.in_(participant_ids))
    total_coded_segments = coded_seg_query.scalar() or 0

    total_conv_query = (
        db.query(func.count(func.distinct(Segment.conversation_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        total_conv_query = total_conv_query.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        total_conv_query = total_conv_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        total_conv_query = total_conv_query.filter(Speaker.participant_id.in_(participant_ids))
    total_conversations = total_conv_query.scalar() or 0

    part_query = (
        db.query(func.count(func.distinct(Speaker.participant_id)))
        .join(Segment, Segment.speaker_id == Speaker.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .filter(
            Conversation.project_id == project_id,
            Speaker.participant_id != None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conversation_ids:
        part_query = part_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        part_query = part_query.filter(Speaker.participant_id.in_(participant_ids))
    total_participants = part_query.scalar() or 0

    unlinked_query = (
        db.query(func.count(func.distinct(Speaker.id)))
        .join(Segment, Segment.speaker_id == Speaker.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Conversation.project_id == project_id,
            Speaker.participant_id == None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conversation_ids:
        unlinked_query = unlinked_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        unlinked_speaker_count = 0
    else:
        unlinked_speaker_count = unlinked_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_segments": total_coded_segments,
        "total_conversations": total_conversations,
        "total_participants": total_participants,
        "unlinked_speaker_count": unlinked_speaker_count,
    }


# ── Internal: comment-based frequencies ──────────────────────────────────────

def _get_comment_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
) -> dict:
    """Compute code frequency stats from comment coding only."""
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.dataset_value_id)).label("text_count"),
            func.count(func.distinct(DatasetValue.row_id)).label("row_count"),
        )
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if participant_ids:
        base = base.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        base = base.filter(DatasetRow.participant_id.in_(participant_ids))

    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2]) for row in freq_rows}

    # Totals (must apply same participant filter as per-code queries)
    total_comment_query = (
        db.query(func.count(func.distinct(CodeApplication.dataset_value_id)))
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if participant_ids:
        total_comment_query = (
            total_comment_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    total_coded_texts = total_comment_query.scalar() or 0

    total_records_query = (
        db.query(func.count(func.distinct(DatasetValue.row_id)))
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            CodeApplication.dataset_value_id.isnot(None),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if participant_ids:
        total_records_query = (
            total_records_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    total_records = total_records_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_texts": total_coded_texts,
        "total_rows": total_records,
    }


# ── Internal: document-based frequencies ──────────────────────────────────

def _get_document_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
) -> dict:
    """Compute code frequency stats from document segments only."""
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.segment_id)).label("seg_count"),
            func.count(func.distinct(Segment.document_id)).label("doc_count"),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if document_ids:
        base = base.filter(Segment.document_id.in_(document_ids))
    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2]) for row in freq_rows}

    # Totals
    universal_ids = _get_universal_code_ids(db, project_id)

    coded_seg_query = (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        coded_seg_query = coded_seg_query.filter(~CodeApplication.code_id.in_(universal_ids))
    if document_ids:
        coded_seg_query = coded_seg_query.filter(Segment.document_id.in_(document_ids))
    total_coded_doc_segments = coded_seg_query.scalar() or 0

    total_doc_query = (
        db.query(func.count(func.distinct(Segment.document_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if document_ids:
        total_doc_query = total_doc_query.filter(Segment.document_id.in_(document_ids))
    total_documents = total_doc_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_doc_segments": total_coded_doc_segments,
        "total_documents": total_documents,
    }


# ── Public: get_code_frequencies ─────────────────────────────────────────────

def get_code_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "conversations",
    document_ids: list[int] | None = None,
) -> dict:
    """Compute code frequency statistics.

    source: "conversations" | "text" | "all" (legacy "comments" coerced to "text")
    When source is "conversations" or "all", document segments are included.
    """
    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    # Load code metadata
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids:
        all_codes = [c for c in all_codes if c.id in set(code_ids)]

    conv_data = None
    comment_data = None
    doc_data = None

    if source in ("conversations", "all"):
        conv_data = _get_conversation_frequencies(
            db, project_id,
            code_ids=code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=conversation_ids,
            participant_ids=participant_ids,
        )
        doc_data = _get_document_frequencies(
            db, project_id,
            code_ids=code_ids,
            document_ids=document_ids,
        )

    if source in ("text", "all"):
        comment_data = _get_comment_frequencies(
            db, project_id,
            code_ids=code_ids,
            participant_ids=participant_ids,
        )

    # Build frequencies
    total_coded_segments = (conv_data["total_coded_segments"] if conv_data else 0) + (doc_data["total_coded_doc_segments"] if doc_data else 0)
    total_conversations = conv_data["total_conversations"] if conv_data else 0
    total_documents = doc_data["total_documents"] if doc_data else 0
    total_participants = conv_data["total_participants"] if conv_data else 0
    unlinked_speaker_count = conv_data["unlinked_speaker_count"] if conv_data else 0
    total_coded_texts = comment_data["total_coded_texts"] if comment_data else 0
    total_records = comment_data["total_rows"] if comment_data else 0

    frequencies = []
    for code in all_codes:
        entry = {
            "code_id": code.id,
            "code_name": code.name,
            "code_color": code.color,
            "is_universal": code.is_universal,
            "category_id": code.category_id,
            "category_name": code.category.name if code.category else None,
            "category_color": code.category.color if code.category else None,
        }

        if conv_data:
            seg_c, conv_c, part_c = conv_data["freq_map"].get(code.id, (0, 0, 0))
            doc_seg_c, doc_c = doc_data["freq_map"].get(code.id, (0, 0)) if doc_data else (0, 0)
            combined_seg = seg_c + doc_seg_c
            entry["segment_count"] = combined_seg
            entry["segment_percentage"] = round(combined_seg / total_coded_segments * 100, DISPLAY_PERCENTAGE_PRECISION) if total_coded_segments else 0.0
            entry["conversation_count"] = conv_c
            entry["conversation_percentage"] = round(conv_c / total_conversations * 100, DISPLAY_PERCENTAGE_PRECISION) if total_conversations else 0.0
            entry["document_count"] = doc_c
            entry["document_percentage"] = round(doc_c / total_documents * 100, DISPLAY_PERCENTAGE_PRECISION) if total_documents else 0.0
            entry["participant_count"] = part_c
            entry["participant_percentage"] = round(part_c / total_participants * 100, DISPLAY_PERCENTAGE_PRECISION) if total_participants else 0.0
        else:
            entry["segment_count"] = 0
            entry["segment_percentage"] = 0.0
            entry["conversation_count"] = 0
            entry["conversation_percentage"] = 0.0
            entry["document_count"] = 0
            entry["document_percentage"] = 0.0
            entry["participant_count"] = 0
            entry["participant_percentage"] = 0.0

        if comment_data:
            comment_c, row_c = comment_data["freq_map"].get(code.id, (0, 0))
            entry["text_count"] = comment_c
            entry["text_percentage"] = round(comment_c / total_coded_texts * 100, DISPLAY_PERCENTAGE_PRECISION) if total_coded_texts else 0.0
            entry["row_count"] = row_c
            entry["row_percentage"] = round(row_c / total_records * 100, DISPLAY_PERCENTAGE_PRECISION) if total_records else 0.0
        else:
            entry["text_count"] = 0
            entry["text_percentage"] = 0.0
            entry["row_count"] = 0
            entry["row_percentage"] = 0.0

        frequencies.append(entry)

    result = {
        "frequencies": frequencies,
        "total_coded_segments": total_coded_segments,
        "total_conversations": total_conversations,
        "total_documents": total_documents,
        "total_participants": total_participants,
        "total_codes_active": len(frequencies),
        "unlinked_speaker_count": unlinked_speaker_count,
        "total_coded_texts": total_coded_texts,
        "total_rows": total_records,
        "source": source,
    }

    return result


def get_segments_with_context(
    db: Session,
    project_id: int,
    code_id: int,
    context_size: int = 1,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    limit: int = 200,
    offset: int = 0,
    document_ids: list[int] | None = None,
) -> dict:
    """Get coded segments with surrounding context, grouped by conversation and document.

    Returns focal segments (those with the given code applied) plus
    preceding/following context segments from the same conversation/document.
    """
    code = (
        db.query(Code)
        .options(joinedload(Code.category))
        .filter(Code.id == code_id, Code.project_id == project_id)
        .first()
    )
    if not code:
        return None

    app_query = (
        db.query(CodeApplication.segment_id, Segment.conversation_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            CodeApplication.code_id == code_id,
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if exclude_facilitator:
        app_query = app_query.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conversation_ids:
        app_query = app_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        app_query = app_query.filter(Speaker.participant_id.in_(participant_ids))

    app_query = app_query.order_by(Segment.conversation_id, Segment.sequence_order)
    all_apps = app_query.all()

    total_segments = len(all_apps)
    paged_apps = all_apps[offset:offset + limit]
    has_more = (offset + limit) < total_segments

    if not paged_apps:
        return {
            "code_id": code.id,
            "code_name": code.name,
            "code_color": code.color,
            "category_name": code.category.name if code.category else None,
            "total_segments": total_segments,
            "has_more": has_more,
            "conversations": [],
        }

    focal_by_conv: dict[int, list[int]] = defaultdict(list)
    focal_seg_ids = set()
    conv_ids_needed = set()
    for seg_id, conv_id in paged_apps:
        focal_by_conv[conv_id].append(seg_id)
        focal_seg_ids.add(seg_id)
        conv_ids_needed.add(conv_id)

    all_segments = (
        db.query(Segment)
        .filter(
            Segment.conversation_id.in_(conv_ids_needed),
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
        .order_by(Segment.conversation_id, Segment.sequence_order)
        .all()
    )

    segs_by_conv: dict[int, list] = defaultdict(list)
    seg_lookup: dict[int, object] = {}
    for seg in all_segments:
        segs_by_conv[seg.conversation_id].append(seg)
        seg_lookup[seg.id] = seg

    speaker_ids = set(seg.speaker_id for seg in all_segments if seg.speaker_id)
    speakers = {}
    if speaker_ids:
        speaker_rows = db.query(Speaker).filter(Speaker.id.in_(speaker_ids)).all()
        speakers = {s.id: s for s in speaker_rows}

    speaker_participant_ids = set(s.participant_id for s in speakers.values() if s.participant_id)
    participants = {}
    if speaker_participant_ids:
        part_rows = db.query(Participant).filter(Participant.id.in_(speaker_participant_ids)).all()
        participants = {p.id: p for p in part_rows}

    focal_codes = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.in_(focal_seg_ids))
        .all()
    )
    codes_by_seg: dict[int, list[int]] = defaultdict(list)
    for seg_id, cid in focal_codes:
        codes_by_seg[seg_id].append(cid)

    # Look up whole-segment excerpts (whole-segment excerpt lookup)
    quoted_seg_ids = set(
        eid for (eid,) in db.query(Excerpt.segment_id).filter(
            Excerpt.segment_id.in_(focal_seg_ids),
            Excerpt.start_offset.is_(None),
        ).all()
    )

    conv_rows = db.query(Conversation.id, Conversation.name).filter(
        Conversation.id.in_(conv_ids_needed)
    ).all()
    conv_names = {cid: cname for cid, cname in conv_rows}

    def seg_to_context(seg) -> dict:
        speaker = speakers.get(seg.speaker_id)
        return {
            "id": seg.id,
            "sequence_order": seg.sequence_order,
            "speaker_name": speaker.name if speaker else None,
            "speaker_color_index": speaker.color_index if speaker else 0,
            "speaker_color": speaker.color if speaker else None,
            "is_facilitator": bool(speaker.is_facilitator) if speaker else False,
            "text": seg.text,
            "start_time": seg.start_time,
        }

    def seg_to_focal(seg) -> dict:
        speaker = speakers.get(seg.speaker_id)
        participant = None
        if speaker and speaker.participant_id:
            participant = participants.get(speaker.participant_id)
        return {
            "id": seg.id,
            "sequence_order": seg.sequence_order,
            "speaker_name": speaker.name if speaker else None,
            "speaker_color_index": speaker.color_index if speaker else 0,
            "speaker_color": speaker.color if speaker else None,
            "is_facilitator": bool(speaker.is_facilitator) if speaker else False,
            "text": seg.text,
            "start_time": seg.start_time,
            "is_quoted": seg.id in quoted_seg_ids,
            "applied_code_ids": codes_by_seg.get(seg.id, []),
            "participant_id": participant.id if participant else None,
            "participant_name": (participant.display_name or participant.identifier) if participant else None,
        }

    conversations = []
    for conv_id in focal_by_conv:
        conv_segs = segs_by_conv.get(conv_id, [])
        seq_index = {seg.id: idx for idx, seg in enumerate(conv_segs)}

        focal_ids_in_conv = set(focal_by_conv[conv_id])
        context_indices = set()
        focal_indices = set()

        for seg_id in focal_ids_in_conv:
            idx = seq_index.get(seg_id)
            if idx is not None:
                focal_indices.add(idx)
                for ci in range(max(0, idx - context_size), idx):
                    context_indices.add(ci)
                for ci in range(idx + 1, min(len(conv_segs), idx + context_size + 1)):
                    context_indices.add(ci)

        context_indices -= focal_indices

        segments_out = []
        for seg_id in focal_by_conv[conv_id]:
            idx = seq_index.get(seg_id)
            if idx is None:
                continue
            seg = conv_segs[idx]

            preceding = []
            for ci in range(max(0, idx - context_size), idx):
                preceding.append(seg_to_context(conv_segs[ci]))

            following = []
            for ci in range(idx + 1, min(len(conv_segs), idx + context_size + 1)):
                following.append(seg_to_context(conv_segs[ci]))

            focal = seg_to_focal(seg)
            focal["preceding_context"] = preceding
            focal["following_context"] = following
            segments_out.append(focal)

        conversations.append({
            "conversation_id": conv_id,
            "conversation_name": conv_names.get(conv_id, "Unknown"),
            "segment_count": len(segments_out),
            "segments": segments_out,
        })

    # ── Document segments ──
    doc_app_query = (
        db.query(CodeApplication.segment_id, Segment.document_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            CodeApplication.code_id == code_id,
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if document_ids:
        doc_app_query = doc_app_query.filter(Segment.document_id.in_(document_ids))
    doc_app_query = doc_app_query.order_by(Segment.document_id, Segment.sequence_order)
    all_doc_apps = doc_app_query.all()

    doc_total_segments = len(all_doc_apps)
    # Apply offset/limit across all sources — document segments come after conversation segments
    # For simplicity, we'll return document results as a separate list without shared pagination
    doc_paged_apps = all_doc_apps[:limit]

    doc_focal_by_doc: dict[int, list[int]] = defaultdict(list)
    doc_focal_seg_ids = set()
    doc_ids_needed = set()
    for seg_id, did in doc_paged_apps:
        doc_focal_by_doc[did].append(seg_id)
        doc_focal_seg_ids.add(seg_id)
        doc_ids_needed.add(did)

    doc_results = []
    if doc_ids_needed:
        doc_all_segments = (
            db.query(Segment)
            .filter(
                Segment.document_id.in_(doc_ids_needed),
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
            .order_by(Segment.document_id, Segment.sequence_order)
            .all()
        )

        doc_segs_by_doc: dict[int, list] = defaultdict(list)
        for seg in doc_all_segments:
            doc_segs_by_doc[seg.document_id].append(seg)

        doc_focal_codes = (
            db.query(CodeApplication.segment_id, CodeApplication.code_id)
            .filter(CodeApplication.segment_id.in_(doc_focal_seg_ids))
            .all()
        )
        doc_codes_by_seg: dict[int, list[int]] = defaultdict(list)
        for seg_id, cid in doc_focal_codes:
            doc_codes_by_seg[seg_id].append(cid)

        doc_quoted_seg_ids = set(
            eid for (eid,) in db.query(Excerpt.segment_id).filter(
                Excerpt.segment_id.in_(doc_focal_seg_ids),
                Excerpt.start_offset.is_(None),
            ).all()
        ) if doc_focal_seg_ids else set()

        doc_name_rows = db.query(Document.id, Document.name).filter(
            Document.id.in_(doc_ids_needed)
        ).all()
        doc_names = {did: dname for did, dname in doc_name_rows}

        def doc_seg_to_context(seg) -> dict:
            return {
                "id": seg.id,
                "sequence_order": seg.sequence_order,
                "speaker_name": None,
                "speaker_color_index": 0,
                "speaker_color": None,
                "is_facilitator": False,
                "text": seg.text,
                "start_time": None,
            }

        def doc_seg_to_focal(seg) -> dict:
            return {
                "id": seg.id,
                "sequence_order": seg.sequence_order,
                "speaker_name": None,
                "speaker_color_index": 0,
                "speaker_color": None,
                "is_facilitator": False,
                "text": seg.text,
                "start_time": None,
                "is_quoted": seg.id in doc_quoted_seg_ids,
                "applied_code_ids": doc_codes_by_seg.get(seg.id, []),
                "participant_id": None,
                "participant_name": None,
            }

        for did in doc_focal_by_doc:
            d_segs = doc_segs_by_doc.get(did, [])
            seq_index = {seg.id: idx for idx, seg in enumerate(d_segs)}

            segments_out = []
            for seg_id in doc_focal_by_doc[did]:
                idx = seq_index.get(seg_id)
                if idx is None:
                    continue
                seg = d_segs[idx]

                preceding = []
                for ci in range(max(0, idx - context_size), idx):
                    preceding.append(doc_seg_to_context(d_segs[ci]))

                following = []
                for ci in range(idx + 1, min(len(d_segs), idx + context_size + 1)):
                    following.append(doc_seg_to_context(d_segs[ci]))

                focal = doc_seg_to_focal(seg)
                focal["preceding_context"] = preceding
                focal["following_context"] = following
                segments_out.append(focal)

            doc_results.append({
                "document_id": did,
                "document_name": doc_names.get(did, "Unknown"),
                "segment_count": len(segments_out),
                "segments": segments_out,
            })

    return {
        "code_id": code.id,
        "code_name": code.name,
        "code_color": code.color,
        "category_name": code.category.name if code.category else None,
        "total_segments": total_segments + doc_total_segments,
        "has_more": has_more,
        "conversations": conversations,
        "documents": doc_results,
    }


def get_demographic_filter_options(
    db: Session,
    project_id: int,
) -> dict:
    """Get available demographic filter options for a project.

    Returns demographic columns grouped by subtype, with distinct values
    and which participant IDs match each value. Also returns conversation list.
    """
    demo_cols = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
        )
        .all()
    )

    if not demo_cols:
        convs = (
            db.query(Conversation.id, Conversation.name)
            .filter(Conversation.project_id == project_id)
            .order_by(Conversation.name)
            .all()
        )
        return {
            "filters": [],
            "conversations": [{"id": c_id, "name": c_name} for c_id, c_name in convs],
        }

    linked_rows = (
        db.query(DatasetRow.id, DatasetRow.participant_id, DatasetRow.dataset_id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetRow.participant_id != None,
        )
        .all()
    )

    row_participant = {r.id: r.participant_id for r in linked_rows}
    row_dataset = {r.id: r.dataset_id for r in linked_rows}
    linked_row_ids = [r.id for r in linked_rows]

    demo_col_ids = [c.id for c in demo_cols]
    values = []
    if linked_row_ids and demo_col_ids:
        values = (
            db.query(
                DatasetValue.row_id,
                DatasetValue.column_id,
                DatasetValue.value_text,
            )
            .filter(
                DatasetValue.row_id.in_(linked_row_ids),
                DatasetValue.column_id.in_(demo_col_ids),
            )
            .all()
        )

    subtype_map: dict[str, dict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
    col_subtype = {c.id: (c.demographic_subtype or c.column_text) for c in demo_cols}
    col_dataset = {c.id: c.dataset_id for c in demo_cols}

    for row_id, col_id, val_text in values:
        if not val_text or not val_text.strip():
            continue
        subtype = col_subtype.get(col_id, "other")
        pid = row_participant.get(row_id)
        if pid is None:
            continue
        if col_dataset.get(col_id) != row_dataset.get(row_id):
            continue
        subtype_map[subtype][val_text.strip()].add(pid)

    participants_with_role = (
        db.query(Participant.id, Participant.role)
        .filter(
            Participant.project_id == project_id,
            Participant.role != None,
            Participant.role != "",
        )
        .all()
    )
    if participants_with_role:
        for pid, role in participants_with_role:
            subtype_map["role"][role].add(pid)

    filters = []
    subtype_order = sorted(subtype_map.keys(), key=lambda s: (0 if s == "role" else 1, s))
    for subtype in subtype_order:
        value_map = subtype_map[subtype]
        values_list = []
        for val in sorted(value_map.keys()):
            pids = sorted(value_map[val])
            values_list.append({
                "value": val,
                "participant_ids": pids,
                "count": len(pids),
            })
        filters.append({
            "subtype": subtype,
            "label": subtype.replace("_", " ").title(),
            "values": values_list,
        })

    convs = (
        db.query(Conversation.id, Conversation.name)
        .filter(Conversation.project_id == project_id)
        .order_by(Conversation.name)
        .all()
    )

    return {
        "filters": filters,
        "conversations": [{"id": c_id, "name": c_name} for c_id, c_name in convs],
    }


# ── Internal: conversation-based co-occurrence ───────────────────────────────

def _build_conversation_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from conversation segments."""
    query = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if exclude_facilitator:
        query = query.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        query = query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        query = query.filter(Speaker.participant_id.in_(participant_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))

    apps = query.all()

    segment_codes = defaultdict(set)
    for seg_id, code_id in apps:
        segment_codes[seg_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in segment_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(segment_codes)


def _build_comment_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from coded comments."""
    query = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if text_column_ids:
        query = query.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        query = query.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        query = query.filter(DatasetRow.participant_id.in_(participant_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))

    apps = query.all()

    value_codes = defaultdict(set)
    for dv_id, code_id in apps:
        value_codes[dv_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in value_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(value_codes)


def _build_document_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from document segments."""
    query = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if document_ids:
        query = query.filter(Segment.document_id.in_(document_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))

    apps = query.all()

    segment_codes = defaultdict(set)
    for seg_id, code_id in apps:
        segment_codes[seg_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in segment_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(segment_codes)


def build_code_cooccurrence_matrix(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "conversations",
    text_column_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
) -> tuple[dict, int, int, int, int]:
    """Returns (cooccur_dict, total_units, conv_total, text_total, doc_total).

    cooccur_dict: (code_id_a, code_id_b) -> count
    total_units: combined total across sources
    conv_total: conversation segment count (0 if source != conversations/all)
    text_total: text-column count (0 if source != text/all)
    doc_total: document segment count (0 if source != conversations/all)
    """
    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    if source == "conversations":
        cooccur, conv_total = _build_conversation_cooccurrence(
            db, project_id, code_ids=code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=conversation_ids,
            participant_ids=participant_ids,
        )
        doc_cooccur, doc_total = _build_document_cooccurrence(
            db, project_id, code_ids=code_ids,
            document_ids=document_ids,
        )
        # Merge conversation + document
        merged = defaultdict(int)
        for k, v in cooccur.items():
            merged[k] += v
        for k, v in doc_cooccur.items():
            merged[k] += v
        return merged, conv_total + doc_total, conv_total, 0, doc_total
    elif source == "text":
        cooccur, total = _build_comment_cooccurrence(
            db, project_id, code_ids=code_ids,
            participant_ids=participant_ids,
            text_column_ids=text_column_ids,
        )
        return cooccur, total, 0, total, 0
    else:  # "all"
        conv_cooccur, conv_total = _build_conversation_cooccurrence(
            db, project_id, code_ids=code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=conversation_ids,
            participant_ids=participant_ids,
        )
        comment_cooccur, comment_total = _build_comment_cooccurrence(
            db, project_id, code_ids=code_ids,
            participant_ids=participant_ids,
            text_column_ids=text_column_ids,
        )
        doc_cooccur, doc_total = _build_document_cooccurrence(
            db, project_id, code_ids=code_ids,
            document_ids=document_ids,
        )
        # Merge
        merged = defaultdict(int)
        for k, v in conv_cooccur.items():
            merged[k] += v
        for k, v in comment_cooccur.items():
            merged[k] += v
        for k, v in doc_cooccur.items():
            merged[k] += v
        return merged, conv_total + comment_total + doc_total, conv_total, comment_total, doc_total


def get_coded_comments_with_context(
    db: Session,
    project_id: int,
    code_id: int,
    participant_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict | None:
    """Get coded texts for a specific code, grouped by dataset.

    Returns texts (DatasetValues) that have CodeApplications for the given code,
    including record info, dataset/column names, and all applied code IDs.
    """
    code = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.id == code_id, Code.project_id == project_id)
        .first()
    )
    if not code:
        return None

    # Find all dataset_value_ids with this code applied
    app_query = (
        db.query(CodeApplication.dataset_value_id)
        .filter(
            CodeApplication.dataset_value_id.isnot(None),
            CodeApplication.code_id == code_id,
        )
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if text_column_ids:
        app_query = app_query.filter(DatasetValue.column_id.in_(text_column_ids))

    if participant_ids:
        app_query = (
            app_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )

    all_dv_ids = [row[0] for row in app_query.order_by(CodeApplication.dataset_value_id).all()]
    total_texts = len(all_dv_ids)
    paged_dv_ids = all_dv_ids[offset:offset + limit]
    has_more = (offset + limit) < total_texts

    if not paged_dv_ids:
        return {
            "code_id": code.id,
            "code_name": code.name,
            "code_color": code.color,
            "category_name": code.category.name if code.category else None,
            "total_texts": total_texts,
            "has_more": has_more,
            "datasets": [],
        }

    # Load full DatasetValue + joins for paged IDs
    values = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetValue.row_id,
            DatasetColumn.id.label("col_id"),
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetValue.id.in_(paged_dv_ids))
        .all()
    )

    # Get row identifiers via DatasetRow → Participant
    row_ids = list({v.row_id for v in values if v.row_id})
    row_map: dict[int, str | None] = {}
    if row_ids:
        rows = (
            db.query(DatasetRow.id, DatasetRow.row_identifier, Participant.identifier, Participant.display_name)
            .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
            .filter(DatasetRow.id.in_(row_ids))
            .all()
        )
        for r_id, row_ident, p_ident, dname in rows:
            row_map[r_id] = dname or p_ident or row_ident

    # Get all code applications for these dataset_values
    all_apps = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(
            CodeApplication.dataset_value_id.in_(paged_dv_ids),
        )
        .all()
    )
    codes_by_dv: dict[int, list[int]] = defaultdict(list)
    for dv_id, cid in all_apps:
        codes_by_dv[dv_id].append(cid)

    # Group by dataset
    ds_groups: dict[int, dict] = {}
    for v in values:
        text = v.value_text or ""
        word_count = len(text.split()) if text.strip() else 0
        col_display = v.column_name or v.column_text or f"Column {v.col_id}"

        if v.ds_id not in ds_groups:
            ds_groups[v.ds_id] = {
                "dataset_id": v.ds_id,
                "dataset_name": v.ds_name,
                "texts": [],
            }

        ds_groups[v.ds_id]["texts"].append({
            "dataset_value_id": v.id,
            "value_text": text,
            "word_count": word_count,
            "row_identifier": row_map.get(v.row_id),
            "dataset_name": v.ds_name,
            "column_name": col_display,
            "applied_code_ids": codes_by_dv.get(v.id, []),
        })

    datasets = []
    for ds in ds_groups.values():
        ds["text_count"] = len(ds["texts"])
        datasets.append(ds)

    return {
        "code_id": code.id,
        "code_name": code.name,
        "code_color": code.color,
        "category_name": code.category.name if code.category else None,
        "total_texts": total_texts,
        "has_more": has_more,
        "datasets": datasets,
    }


def _get_ordered_codes(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
) -> list:
    """Get active codes ordered by universal → numeric_id, optionally filtered."""
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids:
        code_id_set = set(code_ids)
        all_codes = [c for c in all_codes if c.id in code_id_set]
    return all_codes


def _build_cooccurrence_response(
    cooccur: dict,
    all_codes: list,
    total_coded_segments: int,
    total_coded_texts: int,
    source: str,
) -> dict:
    """Build the structured co-occurrence response from raw cooccurrence data and code list."""
    codes_info = []
    for c in all_codes:
        codes_info.append({
            "id": c.id,
            "name": c.name,
            "color": c.color,
            "category_name": c.category.name if c.category else None,
            "category_color": c.category.color if c.category else None,
            "is_universal": c.is_universal,
        })

    matrix = []
    max_cooccurrence = 0
    for i, row_code in enumerate(all_codes):
        row = []
        for j, col_code in enumerate(all_codes):
            count = cooccur.get((row_code.id, col_code.id), 0)
            row.append(count)
            if i != j and count > max_cooccurrence:
                max_cooccurrence = count
        matrix.append(row)

    return {
        "codes": codes_info,
        "matrix": matrix,
        "max_cooccurrence": max_cooccurrence,
        "total_coded_segments": total_coded_segments,
        "total_coded_texts": total_coded_texts,
        "source": source,
    }


def get_code_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "conversations",
    document_ids: list[int] | None = None,
) -> dict:
    """Build a structured co-occurrence matrix with code metadata."""
    cooccur, _total, total_coded_segments, total_coded_texts, _doc_total = build_code_cooccurrence_matrix(
        db, project_id,
        code_ids=code_ids,
        exclude_facilitator=exclude_facilitator,
        conversation_ids=conversation_ids,
        participant_ids=participant_ids,
        source=source,
        document_ids=document_ids,
    )

    all_codes = _get_ordered_codes(db, project_id, code_ids)

    return _build_cooccurrence_response(
        cooccur, all_codes, total_coded_segments, total_coded_texts, source,
    )


# ── Participant → demographic group mapping ───────────────────────────────

def _build_participant_group_map(
    db: Session,
    project_id: int,
    subtype: str,
) -> dict[int, str]:
    """Map participant_id → demographic group value for the given subtype.

    Reuses the same linkage logic as get_demographic_filter_options().
    """
    # Check participant.role first if subtype == "role"
    mapping: dict[int, str] = {}
    if subtype == "role":
        rows = (
            db.query(Participant.id, Participant.role)
            .filter(
                Participant.project_id == project_id,
                Participant.role != None,
                Participant.role != "",
            )
            .all()
        )
        for pid, role in rows:
            mapping[pid] = role

    # Overlay dataset-based demographics
    demo_cols = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
        )
        .all()
    )
    target_cols = [
        c for c in demo_cols
        if (c.demographic_subtype or c.column_text) == subtype
    ]
    if not target_cols:
        return mapping

    target_col_ids = [c.id for c in target_cols]
    col_dataset = {c.id: c.dataset_id for c in target_cols}

    linked_rows = (
        db.query(DatasetRow.id, DatasetRow.participant_id, DatasetRow.dataset_id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetRow.participant_id != None,
        )
        .all()
    )
    row_participant = {r.id: r.participant_id for r in linked_rows}
    row_dataset = {r.id: r.dataset_id for r in linked_rows}
    linked_row_ids = [r.id for r in linked_rows]

    if linked_row_ids and target_col_ids:
        values = (
            db.query(DatasetValue.row_id, DatasetValue.column_id, DatasetValue.value_text)
            .filter(
                DatasetValue.row_id.in_(linked_row_ids),
                DatasetValue.column_id.in_(target_col_ids),
            )
            .all()
        )
        for row_id, col_id, val_text in values:
            if not val_text or not val_text.strip():
                continue
            pid = row_participant.get(row_id)
            if pid is None:
                continue
            if col_dataset.get(col_id) != row_dataset.get(row_id):
                continue
            mapping[pid] = val_text.strip()

    return mapping


# ── Source Frequencies ────────────────────────────────────────────────────

def get_source_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    conversation_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    participant_ids: list[int] | None = None,
    group_by_subtype: str | None = None,
    aggregation: str = "code",
    document_ids: list[int] | None = None,
) -> dict:
    """Compute per-source, per-code frequencies with word counts."""

    # Load code metadata
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids is not None:
        code_id_set = set(code_ids)
        all_codes = [c for c in all_codes if c.id in code_id_set]

    # Build participant→group mapping if grouping requested
    part_group_map: dict[int, str] | None = None
    if group_by_subtype:
        part_group_map = _build_participant_group_map(db, project_id, group_by_subtype)

    # ── Conversations ──
    conversations = (
        db.query(Conversation.id, Conversation.name, Conversation.created_at)
        .filter(Conversation.project_id == project_id)
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
        .all()
    )
    conv_map = {c.id: (c.name, idx) for idx, c in enumerate(conversations)}
    conv_ids_filter = set(conversation_ids) if conversation_ids is not None else None

    # Per-conversation totals (visible segments)
    conv_totals_q = (
        db.query(
            Segment.conversation_id,
            func.count(Segment.id),
            func.coalesce(func.sum(Segment.word_count), 0),
        )
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        conv_totals_q = conv_totals_q.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conv_ids_filter is not None:
        conv_totals_q = conv_totals_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        conv_totals_q = conv_totals_q.filter(Speaker.participant_id.in_(participant_ids))
    conv_totals_q = conv_totals_q.group_by(Segment.conversation_id)
    conv_totals = {r[0]: (r[1], int(r[2])) for r in conv_totals_q.all()}

    # Per-conversation coded segment count (excluding universal codes)
    universal_ids = _get_universal_code_ids(db, project_id)

    conv_coded_q = (
        db.query(
            Segment.conversation_id,
            func.count(func.distinct(CodeApplication.segment_id)),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        conv_coded_q = conv_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if exclude_facilitator:
        conv_coded_q = conv_coded_q.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conv_ids_filter is not None:
        conv_coded_q = conv_coded_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        conv_coded_q = conv_coded_q.filter(Speaker.participant_id.in_(participant_ids))
    conv_coded_q = conv_coded_q.group_by(Segment.conversation_id)
    conv_coded = {r[0]: r[1] for r in conv_coded_q.all()}

    # ── Per-code or per-category count queries ──
    if aggregation == "category":
        # Group codes by category; uncategorized codes become pseudo-categories
        cat_groups: dict[int, list[int]] = defaultdict(list)
        cat_meta: dict[int, dict] = {}
        for c in all_codes:
            eff_cat_id = c.category_id if c.category_id else -c.id
            cat_groups[eff_cat_id].append(c.id)
            if eff_cat_id not in cat_meta:
                if c.category_id and c.category:
                    cat_meta[eff_cat_id] = {"name": c.category.name, "color": c.category.color or c.color}
                else:
                    cat_meta[eff_cat_id] = {"name": c.name, "color": c.color}

        codes_info = [
            {
                "id": cat_id,
                "name": meta["name"],
                "color": meta["color"],
                "category_id": cat_id if cat_id > 0 else None,
                "category_name": meta["name"] if cat_id > 0 else None,
                "category_color": None,
                "is_universal": False,
                "numeric_id": idx,
            }
            for idx, (cat_id, meta) in enumerate(cat_meta.items())
        ]

        # Effective category ID expression for SQL
        effective_cat_id = sa_case(
            (Code.category_id.isnot(None), Code.category_id),
            else_=(-1 * Code.id),
        )

        # Conversation category counts: DISTINCT segments per category per conversation
        conv_cat_subq = (
            db.query(
                Segment.conversation_id.label("conv_id"),
                effective_cat_id.label("eff_cat_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            conv_cat_subq = conv_cat_subq.filter(
                (Speaker.is_facilitator == 0) | (Speaker.id == None)
            )
        if conv_ids_filter is not None:
            conv_cat_subq = conv_cat_subq.filter(Segment.conversation_id.in_(conv_ids_filter))
        if participant_ids:
            conv_cat_subq = conv_cat_subq.filter(Speaker.participant_id.in_(participant_ids))
        if code_ids is not None:
            conv_cat_subq = conv_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        conv_cat_subq = conv_cat_subq.distinct().subquery()

        conv_cat_agg = (
            db.query(
                conv_cat_subq.c.conv_id,
                conv_cat_subq.c.eff_cat_id,
                func.count(conv_cat_subq.c.seg_id),
                func.coalesce(func.sum(conv_cat_subq.c.wc), 0),
            )
            .group_by(conv_cat_subq.c.conv_id, conv_cat_subq.c.eff_cat_id)
            .all()
        )

        conv_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for conv_id, cat_id, cnt, wc in conv_cat_agg:
            conv_code_counts[conv_id][cat_id] = (cnt, int(wc))

        # Comment column category counts: DISTINCT responses per category per column
        col_cat_subq = (
            db.query(
                DatasetValue.column_id.label("col_id"),
                effective_cat_id.label("eff_cat_id"),
                DatasetValue.id.label("dv_id"),
                DatasetValue.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if text_column_ids is not None:
            col_cat_subq = col_cat_subq.filter(DatasetValue.column_id.in_(text_column_ids))
        if participant_ids:
            col_cat_subq = col_cat_subq.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            col_cat_subq = col_cat_subq.filter(DatasetRow.participant_id.in_(participant_ids))
        if code_ids is not None:
            col_cat_subq = col_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        col_cat_subq = col_cat_subq.distinct().subquery()

        col_cat_agg = (
            db.query(
                col_cat_subq.c.col_id,
                col_cat_subq.c.eff_cat_id,
                func.count(col_cat_subq.c.dv_id),
                func.coalesce(func.sum(col_cat_subq.c.wc), 0),
            )
            .group_by(col_cat_subq.c.col_id, col_cat_subq.c.eff_cat_id)
            .all()
        )

        col_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for col_id, cat_id, cnt, wc in col_cat_agg:
            col_code_counts[col_id][cat_id] = (cnt, int(wc))

    else:
        # Default: per-code aggregation
        codes_info = [
            {
                "id": c.id,
                "name": c.name,
                "color": c.color,
                "category_id": c.category_id,
                "category_name": c.category.name if c.category else None,
                "category_color": c.category.color if c.category else None,
                "is_universal": c.is_universal,
                "numeric_id": c.numeric_id,
            }
            for c in all_codes
        ]

        # Per-conversation, per-code counts + word_count
        conv_code_q = (
            db.query(
                Segment.conversation_id,
                CodeApplication.code_id,
                func.count(CodeApplication.id),
                func.coalesce(func.sum(Segment.word_count), 0),
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            conv_code_q = conv_code_q.filter(
                (Speaker.is_facilitator == 0) | (Speaker.id == None)
            )
        if conv_ids_filter is not None:
            conv_code_q = conv_code_q.filter(Segment.conversation_id.in_(conv_ids_filter))
        if participant_ids:
            conv_code_q = conv_code_q.filter(Speaker.participant_id.in_(participant_ids))
        if code_ids is not None:
            conv_code_q = conv_code_q.filter(CodeApplication.code_id.in_(code_ids))
        conv_code_q = conv_code_q.group_by(Segment.conversation_id, CodeApplication.code_id)
        conv_code_rows = conv_code_q.all()

        conv_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for conv_id, code_id, cnt, wc in conv_code_rows:
            conv_code_counts[conv_id][code_id] = (cnt, int(wc))

        # Per-column, per-code counts
        col_code_q = (
            db.query(
                DatasetValue.column_id,
                CodeApplication.code_id,
                func.count(CodeApplication.id),
                func.coalesce(func.sum(DatasetValue.word_count), 0),
            )
            .filter(CodeApplication.dataset_value_id.isnot(None))
            .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if text_column_ids is not None:
            col_code_q = col_code_q.filter(DatasetValue.column_id.in_(text_column_ids))
        if participant_ids:
            col_code_q = col_code_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            col_code_q = col_code_q.filter(DatasetRow.participant_id.in_(participant_ids))
        if code_ids is not None:
            col_code_q = col_code_q.filter(CodeApplication.code_id.in_(code_ids))
        col_code_q = col_code_q.group_by(DatasetValue.column_id, CodeApplication.code_id)
        col_code_rows = col_code_q.all()

        col_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for col_id, code_id, cnt, wc in col_code_rows:
            col_code_counts[col_id][code_id] = (cnt, int(wc))

    # ── Documents ──
    documents = (
        db.query(Document.id, Document.name, Document.created_at)
        .filter(Document.project_id == project_id)
        .order_by(Document.created_at.asc(), Document.id.asc())
        .all()
    )
    doc_map = {d.id: (d.name, idx) for idx, d in enumerate(documents)}
    doc_ids_filter = set(document_ids) if document_ids is not None else None

    # Per-document totals (visible segments)
    doc_totals_q = (
        db.query(
            Segment.document_id,
            func.count(Segment.id),
            func.coalesce(func.sum(Segment.word_count), 0),
        )
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Segment.document_id.isnot(None),
        )
    )
    if doc_ids_filter is not None:
        doc_totals_q = doc_totals_q.filter(Segment.document_id.in_(doc_ids_filter))
    doc_totals_q = doc_totals_q.group_by(Segment.document_id)
    doc_totals = {r[0]: (r[1], int(r[2])) for r in doc_totals_q.all()}

    # Per-document coded segment count
    doc_coded_q = (
        db.query(
            Segment.document_id,
            func.count(func.distinct(CodeApplication.segment_id)),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        doc_coded_q = doc_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if doc_ids_filter is not None:
        doc_coded_q = doc_coded_q.filter(Segment.document_id.in_(doc_ids_filter))
    doc_coded_q = doc_coded_q.group_by(Segment.document_id)
    doc_coded = {r[0]: r[1] for r in doc_coded_q.all()}

    # Per-document, per-code counts
    if aggregation == "category":
        doc_cat_subq = (
            db.query(
                Segment.document_id.label("doc_id"),
                effective_cat_id.label("eff_cat_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if doc_ids_filter is not None:
            doc_cat_subq = doc_cat_subq.filter(Segment.document_id.in_(doc_ids_filter))
        if code_ids is not None:
            doc_cat_subq = doc_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        doc_cat_subq = doc_cat_subq.distinct().subquery()

        doc_cat_agg = (
            db.query(
                doc_cat_subq.c.doc_id,
                doc_cat_subq.c.eff_cat_id,
                func.count(doc_cat_subq.c.seg_id),
                func.coalesce(func.sum(doc_cat_subq.c.wc), 0),
            )
            .group_by(doc_cat_subq.c.doc_id, doc_cat_subq.c.eff_cat_id)
            .all()
        )

        doc_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for doc_id, cat_id, cnt, wc in doc_cat_agg:
            doc_code_counts[doc_id][cat_id] = (cnt, int(wc))
    else:
        doc_code_q = (
            db.query(
                Segment.document_id,
                CodeApplication.code_id,
                func.count(CodeApplication.id),
                func.coalesce(func.sum(Segment.word_count), 0),
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if doc_ids_filter is not None:
            doc_code_q = doc_code_q.filter(Segment.document_id.in_(doc_ids_filter))
        if code_ids is not None:
            doc_code_q = doc_code_q.filter(CodeApplication.code_id.in_(code_ids))
        doc_code_q = doc_code_q.group_by(Segment.document_id, CodeApplication.code_id)
        doc_code_rows = doc_code_q.all()

        doc_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for doc_id, code_id, cnt, wc in doc_code_rows:
            doc_code_counts[doc_id][code_id] = (cnt, int(wc))

    # Per-column totals
    col_totals_q = (
        db.query(
            DatasetValue.column_id,
            func.count(DatasetValue.id),
            func.coalesce(func.sum(DatasetValue.word_count), 0),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            DatasetValue.value_text != None,
            DatasetValue.value_text != "",
        )
    )
    if text_column_ids is not None:
        col_totals_q = col_totals_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        col_totals_q = col_totals_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        col_totals_q = col_totals_q.filter(DatasetRow.participant_id.in_(participant_ids))
    col_totals_q = col_totals_q.group_by(DatasetValue.column_id)
    col_totals = {r[0]: (r[1], int(r[2])) for r in col_totals_q.all()}

    # Per-column coded count
    col_coded_q = (
        db.query(
            DatasetValue.column_id,
            func.count(func.distinct(CodeApplication.dataset_value_id)),
        )
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if universal_ids:
        col_coded_q = col_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if text_column_ids is not None:
        col_coded_q = col_coded_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        col_coded_q = col_coded_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        col_coded_q = col_coded_q.filter(DatasetRow.participant_id.in_(participant_ids))
    col_coded_q = col_coded_q.group_by(DatasetValue.column_id)
    col_coded = {r[0]: r[1] for r in col_coded_q.all()}

    # Column metadata
    comment_cols = (
        db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text, Dataset.id.label("ds_id"), Dataset.name.label("ds_name"))
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
        .all()
    )
    col_meta = {c.id: c for c in comment_cols}

    # ── Assemble sources ──
    sources = []
    total_segs = 0
    total_wc = 0
    total_coded = 0
    conv_count = 0
    doc_count = 0
    col_count = 0

    for conv_id, (conv_name, import_order) in conv_map.items():
        if conv_ids_filter is not None and conv_id not in conv_ids_filter:
            continue
        t_segs, t_wc = conv_totals.get(conv_id, (0, 0))
        coded = conv_coded.get(conv_id, 0)
        code_map = conv_code_counts.get(conv_id, {})

        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "conversation",
            "source_id": conv_id,
            "source_label": conv_name,
            "dataset_id": None,
            "dataset_name": None,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": import_order,
            "code_counts": cc if not group_by_subtype else None,
            "groups": None,
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        conv_count += 1

    for d_id, (doc_name, import_order) in doc_map.items():
        if doc_ids_filter is not None and d_id not in doc_ids_filter:
            continue
        t_segs, t_wc = doc_totals.get(d_id, (0, 0))
        coded = doc_coded.get(d_id, 0)
        code_map = doc_code_counts.get(d_id, {})

        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "document",
            "source_id": d_id,
            "source_label": doc_name,
            "dataset_id": None,
            "dataset_name": None,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": import_order,
            "code_counts": cc if not group_by_subtype else None,
            "groups": None,
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        doc_count += 1

    for col_id, meta in col_meta.items():
        if text_column_ids is not None and col_id not in text_column_ids:
            continue
        t_segs, t_wc = col_totals.get(col_id, (0, 0))
        coded = col_coded.get(col_id, 0)
        code_map = col_code_counts.get(col_id, {})

        label = meta.ds_name + " › " + (meta.column_name or meta.column_text[:60])
        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "text_column",
            "source_id": col_id,
            "source_label": label,
            "dataset_id": meta.ds_id,
            "dataset_name": meta.ds_name,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": None,
            "code_counts": cc if not group_by_subtype else None,
            "groups": None,
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        col_count += 1

    return {
        "codes": codes_info,
        "sources": sources,
        "totals": {
            "total_segments": total_segs,
            "total_word_count": total_wc,
            "coded_segments": total_coded,
            "total_sources": conv_count + doc_count + col_count,
            "total_conversations": conv_count,
            "total_documents": doc_count,
            "total_text_columns": col_count,
        },
        "group_by": group_by_subtype,
    }


# ── Source-Level Co-occurrence ────────────────────────────────────────────

def get_source_level_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "all",
    document_ids: list[int] | None = None,
) -> tuple[dict, int]:
    """Build binary co-occurrence at source level (conversation, document, or column).

    Each source contributes at most 1 to each code pair.
    """
    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    source_codes: dict[str, set[int]] = defaultdict(set)

    # Conversations
    if source in ("conversations", "all"):
        conv_q = (
            db.query(
                literal("conv").label("stype"),
                Segment.conversation_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            conv_q = conv_q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conversation_ids:
            conv_q = conv_q.filter(Segment.conversation_id.in_(conversation_ids))
        if participant_ids:
            conv_q = conv_q.filter(Speaker.participant_id.in_(participant_ids))
        if code_ids:
            conv_q = conv_q.filter(CodeApplication.code_id.in_(code_ids))
        for _, sid, cid in conv_q.all():
            source_codes[f"conv_{sid}"].add(cid)

        # Documents (segment-based, same source mode as conversations)
        doc_q = (
            db.query(
                literal("doc").label("stype"),
                Segment.document_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if document_ids:
            doc_q = doc_q.filter(Segment.document_id.in_(document_ids))
        if code_ids:
            doc_q = doc_q.filter(CodeApplication.code_id.in_(code_ids))
        for _, sid, cid in doc_q.all():
            source_codes[f"doc_{sid}"].add(cid)

    # Text columns
    if source in ("text", "all"):
        col_q = (
            db.query(
                literal("col").label("stype"),
                DatasetValue.column_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.dataset_value_id.isnot(None))
            .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if text_column_ids:
            col_q = col_q.filter(DatasetValue.column_id.in_(text_column_ids))
        if participant_ids:
            col_q = col_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            col_q = col_q.filter(DatasetRow.participant_id.in_(participant_ids))
        if code_ids:
            col_q = col_q.filter(CodeApplication.code_id.in_(code_ids))
        for _, sid, cid in col_q.all():
            source_codes[f"col_{sid}"].add(cid)

    cooccur: dict[tuple[int, int], int] = defaultdict(int)
    for codes in source_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(source_codes)


# ── Demographic Comparison ────────────────────────────────────────────────

def get_demographic_comparison(
    db: Session,
    project_id: int,
    group_by_subtype: str,
    code_ids: list[int] | None = None,
    conversation_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    participant_ids: list[int] | None = None,
) -> dict:
    """Compare code frequencies across demographic groups."""

    part_group = _build_participant_group_map(db, project_id, group_by_subtype)
    if not part_group:
        return {"groups": [], "group_totals": {}, "codes": []}

    # Filter to requested participants
    if participant_ids:
        part_group = {pid: g for pid, g in part_group.items() if pid in set(participant_ids)}

    groups = sorted(set(part_group.values()))
    if len(groups) < 2:
        return {"groups": groups, "group_totals": {g: {"total_segments": 0, "total_word_count": 0} for g in groups}, "codes": []}

    # Group → participant IDs
    group_pids: dict[str, set[int]] = defaultdict(set)
    for pid, g in part_group.items():
        group_pids[g].add(pid)

    # Totals per group (conversation segments)
    group_seg_totals: dict[str, int] = defaultdict(int)
    group_wc_totals: dict[str, int] = defaultdict(int)

    for group, pids in group_pids.items():
        pid_list = list(pids)
        q = (
            db.query(
                func.count(Segment.id),
                func.coalesce(func.sum(Segment.word_count), 0),
            )
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
                Speaker.participant_id.in_(pid_list),
            )
        )
        if exclude_facilitator:
            q = q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conversation_ids:
            q = q.filter(Segment.conversation_id.in_(conversation_ids))
        result = q.first()
        group_seg_totals[group] = result[0] if result else 0
        group_wc_totals[group] = int(result[1]) if result else 0

    # Per-group, per-code counts
    group_code_counts: dict[str, dict[int, int]] = {g: defaultdict(int) for g in groups}

    for group, pids in group_pids.items():
        pid_list = list(pids)
        q = (
            db.query(CodeApplication.code_id, func.count(CodeApplication.id))
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
                Speaker.participant_id.in_(pid_list),
            )
        )
        if exclude_facilitator:
            q = q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conversation_ids:
            q = q.filter(Segment.conversation_id.in_(conversation_ids))
        if code_ids:
            q = q.filter(CodeApplication.code_id.in_(code_ids))
        q = q.group_by(CodeApplication.code_id)

        for cid, cnt in q.all():
            group_code_counts[group][cid] = cnt

    # Load codes
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids:
        code_id_set = set(code_ids)
        all_codes = [c for c in all_codes if c.id in code_id_set]

    # Build comparison entries with statistical tests
    entries = []
    for code in all_codes:
        by_group = {}
        for g in groups:
            count = group_code_counts[g].get(code.id, 0)
            total = group_seg_totals[g]
            proportion = count / total if total > 0 else 0.0
            by_group[g] = {"count": count, "proportion": round(proportion, 4)}

        # Statistical test
        delta = None
        test_result = None

        if len(groups) == 2:
            g1, g2 = groups
            delta = round(by_group[g1]["proportion"] - by_group[g2]["proportion"], 4)
            # Fisher's exact test on 2x2 table
            a = by_group[g1]["count"]
            b = group_seg_totals[g1] - a
            c = by_group[g2]["count"]
            d = group_seg_totals[g2] - c
            if group_seg_totals[g1] > 0 and group_seg_totals[g2] > 0:
                try:
                    from scipy.stats import fisher_exact
                    _, p = fisher_exact([[a, b], [c, d]])
                    test_result = {
                        "method": "fisher_exact",
                        "statistic": None,
                        "p_value": round(p, 6),
                        "significant": p < 0.05,
                    }
                    # Odds ratio effect size
                    if b * c > 0:
                        odds_ratio = (a * d) / (b * c)
                        test_result["effect_size"] = round(odds_ratio, 4)
                        test_result["effect_size_label"] = "odds_ratio"
                except (ZeroDivisionError, ValueError, TypeError) as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "Fisher's exact test failed for code %s: %s", code.id, exc
                    )
        elif len(groups) >= 3:
            # Chi-square on kx2 table
            observed = []
            for g in groups:
                count = by_group[g]["count"]
                total = group_seg_totals[g]
                observed.append([count, total - count])
            # Check if any column totals are zero
            col_sums = [sum(row[i] for row in observed) for i in range(2)]
            if all(s > 0 for s in col_sums) and all(group_seg_totals[g] > 0 for g in groups):
                try:
                    from scipy.stats import chi2_contingency
                    import math
                    chi2, p, _, expected = chi2_contingency(observed)
                    # Check for small expected cells
                    method = "chi2"
                    if any(cell < 5 for row in expected for cell in row):
                        method = "chi2_small_expected"
                    test_result = {
                        "method": method,
                        "statistic": round(chi2, 4),
                        "p_value": round(p, 6),
                        "significant": p < 0.05,
                    }
                    # Cramér's V effect size (kx2 table: min dimension is 2, so k-1 = 1)
                    n_total = sum(group_seg_totals[g] for g in groups)
                    min_dim = min(len(observed), 2)  # rows=groups, cols=2 (coded/not)
                    if n_total > 0 and min_dim > 1:
                        cramers_v = math.sqrt(chi2 / (n_total * (min_dim - 1)))
                        test_result["effect_size"] = round(cramers_v, 4)
                        test_result["effect_size_label"] = "cramers_v"
                except (ZeroDivisionError, ValueError, TypeError) as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "Chi-square test failed for code %s: %s", code.id, exc
                    )

        entries.append({
            "code_id": code.id,
            "code_name": code.name,
            "category_name": code.category.name if code.category else None,
            "by_group": by_group,
            "delta_proportion": delta,
            "test": test_result,
        })

    # Sort: by abs(delta) desc for 2 groups, by p-value asc for 3+
    if len(groups) == 2:
        entries.sort(key=lambda e: abs(e["delta_proportion"] or 0), reverse=True)
    else:
        entries.sort(key=lambda e: (e["test"]["p_value"] if e["test"] else 1.0))

    return {
        "groups": groups,
        "group_totals": {
            g: {"total_segments": group_seg_totals[g], "total_word_count": group_wc_totals[g]}
            for g in groups
        },
        "codes": entries,
    }


# ── Saturation ────────────────────────────────────────────────────────────

def get_saturation_data(
    db: Session,
    project_id: int,
    exclude_facilitator: bool = True,
    category_level: bool = False,
    conversation_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
) -> dict:
    """Compute code saturation curve across conversations and documents in chronological order."""

    # Get conversations in chronological order
    conversations = (
        db.query(Conversation.id, Conversation.name, Conversation.created_at)
        .filter(Conversation.project_id == project_id)
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
        .all()
    )

    # Get documents in chronological order
    documents = (
        db.query(Document.id, Document.name, Document.created_at)
        .filter(Document.project_id == project_id)
        .order_by(Document.created_at.asc(), Document.id.asc())
        .all()
    )

    # Get all (conversation_id, code_id) pairs
    conv_q = (
        db.query(Segment.conversation_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        conv_q = conv_q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        conv_q = conv_q.filter(Segment.conversation_id.in_(conversation_ids))
    conv_code_pairs = conv_q.all()

    # Get all (document_id, code_id) pairs
    doc_q = (
        db.query(Segment.document_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if document_ids:
        doc_q = doc_q.filter(Segment.document_id.in_(document_ids))
    doc_code_pairs = doc_q.all()

    # Build source → set of code_ids (or category_ids)
    source_items: dict[str, set] = defaultdict(set)

    if category_level:
        code_cats = dict(
            db.query(Code.id, Code.category_id)
            .filter(Code.project_id == project_id)
            .all()
        )
        cat_names = dict(
            db.query(CodeCategory.id, CodeCategory.name)
            .filter(CodeCategory.project_id == project_id)
            .all()
        )
        cat_names[-1] = "Uncategorized"

        for conv_id, code_id in conv_code_pairs:
            cat_id = code_cats.get(code_id) or -1
            source_items[f"conv_{conv_id}"].add(cat_id)
        for doc_id, code_id in doc_code_pairs:
            cat_id = code_cats.get(code_id) or -1
            source_items[f"doc_{doc_id}"].add(cat_id)

        item_names = cat_names
    else:
        code_names = dict(
            db.query(Code.id, Code.name)
            .filter(Code.project_id == project_id, Code.is_active == True)
            .all()
        )
        for conv_id, code_id in conv_code_pairs:
            source_items[f"conv_{conv_id}"].add(code_id)
        for doc_id, code_id in doc_code_pairs:
            source_items[f"doc_{doc_id}"].add(code_id)
        item_names = code_names

    # Interleave conversations and documents chronologically
    all_sources = []
    for c in conversations:
        if conversation_ids and c.id not in conversation_ids:
            continue
        all_sources.append(("conversation", c.id, c.name, c.created_at))
    for d in documents:
        if document_ids and d.id not in document_ids:
            continue
        all_sources.append(("document", d.id, d.name, d.created_at))
    all_sources.sort(key=lambda x: (x[3], x[0], x[1]))

    # Build cumulative saturation curve
    seen: set = set()
    points = []
    for idx, (stype, sid, sname, _) in enumerate(all_sources):
        key = f"conv_{sid}" if stype == "conversation" else f"doc_{sid}"
        items = source_items.get(key, set())
        new_items = items - seen
        seen.update(new_items)
        new_names = [item_names.get(item_id, f"Unknown ({item_id})") for item_id in sorted(new_items)]

        points.append({
            "source_index": idx,
            "source_label": sname,
            "source_type": stype,
            "cumulative_unique_codes": len(seen),
            "new_codes_this_source": len(new_items),
            "new_code_names": new_names,
        })

    return {
        "points": points,
        "total_unique_codes": len(seen),
        "total_sources": len(all_sources),
        "category_level": category_level,
    }


# ── Comment Columns with Coding ──────────────────────────────────────────

def get_text_columns_with_coding(
    db: Session,
    project_id: int,
) -> list[dict]:
    """Get open-ended columns with their coded value counts (including 0)."""

    # Subquery: count distinct code applications per column
    coded_sub = (
        db.query(
            DatasetValue.column_id,
            func.count(func.distinct(CodeApplication.id)).label("coded_count"),
        )
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .group_by(DatasetValue.column_id)
        .subquery()
    )

    results = (
        db.query(
            DatasetColumn.id.label("column_id"),
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.id.label("dataset_id"),
            Dataset.name.label("dataset_name"),
            func.coalesce(coded_sub.c.coded_count, 0).label("coded_count"),
        )
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .outerjoin(coded_sub, coded_sub.c.column_id == DatasetColumn.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
        .order_by(Dataset.name, DatasetColumn.display_order)
        .all()
    )

    return [
        {
            "column_id": r.column_id,
            "column_name": r.column_name,
            "column_text": r.column_text,
            "dataset_id": r.dataset_id,
            "dataset_name": r.dataset_name,
            "coded_count": r.coded_count,
        }
        for r in results
    ]
