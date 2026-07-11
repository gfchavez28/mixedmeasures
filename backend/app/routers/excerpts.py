import csv
import io
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, contains_eager, joinedload
from sqlalchemy import and_, or_, exists

from ..database import get_db
from ..models.user import User
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.speaker import Speaker
from ..models.excerpt import Excerpt
from ..models.note import Note
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.participant import Participant
from ..schemas.excerpt import (
    ExcerptCreate,
    ExcerptBulkCreate,
    ExcerptResponse,
    ExcerptDetailResponse,
    ExcerptListResponse,
    QuotedExcerptItem,
    QuotedExcerptCode,
    QuotedExcerptsResponse,
)
from ..auth import get_current_user
from ..services.audit import log_action
from .helpers import _get_project_or_404, parse_int_list, TEXT_TYPES, visible_segment_filter as _visible_segment_filter
from .export_helpers import csv_safe
from ..schemas.common import utc_wire

router = APIRouter(prefix="/api/projects/{project_id}/excerpts", tags=["excerpts"])


def _excerpt_to_response(excerpt: Excerpt) -> ExcerptResponse:
    """Convert Excerpt model to response. Assumes eager-loaded relationships."""
    excerpt_text = ""
    conversation_id = None
    conversation_name = None
    speaker_name = None
    segment_timestamp = None

    if excerpt.segment:
        seg = excerpt.segment
        if excerpt.start_offset is not None and excerpt.end_offset is not None:
            excerpt_text = seg.text[excerpt.start_offset:excerpt.end_offset]
        else:
            excerpt_text = seg.text

        conversation_id = seg.conversation_id
        if seg.conversation:
            conversation_name = seg.conversation.name
        if seg.speaker:
            speaker_name = seg.speaker.name
        segment_timestamp = seg.start_time
    elif excerpt.dataset_value:
        dv = excerpt.dataset_value
        excerpt_text = dv.value_text or ""

    note_info = None
    if excerpt.note and not excerpt.note.is_archived:
        from ..schemas.excerpt import ExcerptNoteInfo
        note_info = ExcerptNoteInfo(
            id=excerpt.note.id,
            content=excerpt.note.content,
            created_at=excerpt.note.created_at,
        )

    return ExcerptResponse(
        id=excerpt.id,
        segment_id=excerpt.segment_id,
        dataset_value_id=excerpt.dataset_value_id,
        start_offset=excerpt.start_offset,
        end_offset=excerpt.end_offset,
        excerpt_text=excerpt_text,
        conversation_id=conversation_id,
        conversation_name=conversation_name,
        speaker_name=speaker_name,
        segment_timestamp=segment_timestamp,
        note=note_info,
        has_note=note_info is not None,
        created_at=excerpt.created_at,
    )


def _base_excerpt_query(db: Session, project_id: int):
    """Base query for excerpts with eager loading."""
    return db.query(Excerpt).filter(
        Excerpt.project_id == project_id
    ).options(
        joinedload(Excerpt.segment).joinedload(Segment.conversation),
        joinedload(Excerpt.segment).joinedload(Segment.document),
        joinedload(Excerpt.segment).joinedload(Segment.speaker),
        joinedload(Excerpt.note),
        joinedload(Excerpt.dataset_value).joinedload(DatasetValue.column).joinedload(DatasetColumn.dataset),
        joinedload(Excerpt.dataset_value).joinedload(DatasetValue.row),
    )


@router.get("", response_model=ExcerptListResponse)
async def list_excerpts(
    project_id: int,
    conversation_id: int | None = None,
    has_note: bool | None = None,
    search: str | None = None,
    speaker: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all excerpts for a project with optional filters."""
    _get_project_or_404(db, project_id, user.id)

    query = _base_excerpt_query(db, project_id)

    # Filter: only show excerpts for visible (non-soft-deleted) segments
    # Use outerjoin so comment-based excerpts (segment_id IS NULL) are included
    query = query.outerjoin(Segment, Excerpt.segment_id == Segment.id).filter(
        or_(
            Excerpt.segment_id.is_(None),
            and_(Segment.merged_into_id == None, Segment.split_into_id == None)
        )
    )

    if conversation_id is not None:
        query = query.filter(
            Excerpt.segment_id.isnot(None),
            Segment.conversation_id == conversation_id,
        )

    if speaker is not None:
        query = query.join(Speaker, Segment.speaker_id == Speaker.id).filter(
            Excerpt.segment_id.isnot(None),
            Speaker.name == speaker,
        )

    excerpts = query.order_by(Excerpt.created_at.desc()).all()

    # Apply Python-side filters that require relationship data
    results = []
    for exc in excerpts:
        resp = _excerpt_to_response(exc)

        if has_note is not None:
            if has_note and not resp.has_note:
                continue
            if not has_note and resp.has_note:
                continue

        if search:
            search_lower = search.lower()
            if search_lower not in resp.excerpt_text.lower():
                # Also check note content
                if not (resp.note and search_lower in resp.note.content.lower()):
                    continue

        results.append(resp)

    return ExcerptListResponse(excerpts=results, total=len(results))


@router.post("", response_model=ExcerptResponse, status_code=201)
async def create_excerpt(
    project_id: int,
    data: ExcerptCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a single excerpt (segment or comment)."""
    _get_project_or_404(db, project_id, user.id)

    if data.segment_id is not None:
        # Validate segment belongs to project (via conversation or document)
        segment = (
            db.query(Segment)
            .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Document, Segment.document_id == Document.id)
            .filter(
                Segment.id == data.segment_id,
                or_(
                    Conversation.project_id == project_id,
                    Document.project_id == project_id,
                ),
            )
            .first()
        )
        if not segment:
            raise HTTPException(status_code=404, detail="Segment not found in this project")

        # Validate offsets against segment text
        if data.start_offset is not None:
            if data.start_offset < 0:
                raise HTTPException(status_code=400, detail="start_offset must be non-negative")
            if data.end_offset > len(segment.text):
                raise HTTPException(status_code=400, detail="end_offset exceeds segment text length")

        # Check for duplicate
        dup_filters = [Excerpt.segment_id == data.segment_id]
        if data.start_offset is not None:
            dup_filters.extend([
                Excerpt.start_offset == data.start_offset,
                Excerpt.end_offset == data.end_offset,
            ])
        else:
            dup_filters.append(Excerpt.start_offset == None)

        existing = db.query(Excerpt).filter(and_(*dup_filters)).first()
        if existing:
            raise HTTPException(status_code=409, detail="Excerpt already exists")

    else:
        # Comment excerpt: validate dataset_value belongs to a comment column in this project
        dv = (
            db.query(DatasetValue)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                DatasetValue.id == data.dataset_value_id,
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_(TEXT_TYPES),
            )
            .first()
        )
        if not dv:
            raise HTTPException(status_code=400, detail="DatasetValue not found or not a text column in this project")

        # Check for duplicate
        existing = db.query(Excerpt).filter(
            Excerpt.dataset_value_id == data.dataset_value_id,
            Excerpt.start_offset == None,
        ).first()
        if existing:
            raise HTTPException(status_code=409, detail="Excerpt already exists")

    excerpt = Excerpt(
        project_id=project_id,
        segment_id=data.segment_id,
        dataset_value_id=data.dataset_value_id,
        start_offset=data.start_offset,
        end_offset=data.end_offset,
    )
    db.add(excerpt)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="excerpt",
        entity_id=excerpt.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "segment_id": data.segment_id,
            "dataset_value_id": data.dataset_value_id,
            "start_offset": data.start_offset,
            "end_offset": data.end_offset,
        },
    )
    db.commit()

    # Re-fetch with eager loading
    excerpt = _base_excerpt_query(db, project_id).filter(Excerpt.id == excerpt.id).first()
    return _excerpt_to_response(excerpt)


@router.post("/bulk", status_code=201)
async def bulk_create_excerpts(
    project_id: int,
    data: ExcerptBulkCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create multiple excerpts (segment or comment), skipping duplicates."""
    if len(data.items) > 500:
        raise HTTPException(status_code=400, detail="Batch too large (max 500 items)")
    _get_project_or_404(db, project_id, user.id)

    # Separate segment items from comment items
    segment_items = [item for item in data.items if item.segment_id is not None]
    comment_items = [item for item in data.items if item.dataset_value_id is not None]

    created_count = 0
    skipped_count = 0

    # ── Segment items ──
    if segment_items:
        segment_ids = list({item.segment_id for item in segment_items})
        segments = (
            db.query(Segment)
            .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Document, Segment.document_id == Document.id)
            .filter(
                Segment.id.in_(segment_ids),
                or_(
                    Conversation.project_id == project_id,
                    Document.project_id == project_id,
                ),
            )
            .all()
        )
        valid_segment_ids = {s.id for s in segments}

        for item in segment_items:
            if item.segment_id not in valid_segment_ids:
                skipped_count += 1
                continue

            dup_filters = [Excerpt.segment_id == item.segment_id]
            if item.start_offset is not None:
                dup_filters.extend([
                    Excerpt.start_offset == item.start_offset,
                    Excerpt.end_offset == item.end_offset,
                ])
            else:
                dup_filters.append(Excerpt.start_offset == None)

            existing = db.query(Excerpt).filter(and_(*dup_filters)).first()
            if existing:
                skipped_count += 1
                continue

            db.add(Excerpt(
                project_id=project_id,
                segment_id=item.segment_id,
                start_offset=item.start_offset,
                end_offset=item.end_offset,
            ))
            created_count += 1

    # ── Comment items ──
    if comment_items:
        dv_ids = list({item.dataset_value_id for item in comment_items})
        valid_dvs = (
            db.query(DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                DatasetValue.id.in_(dv_ids),
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_(TEXT_TYPES),
            )
            .all()
        )
        valid_dv_ids = {dv_id for (dv_id,) in valid_dvs}

        for item in comment_items:
            if item.dataset_value_id not in valid_dv_ids:
                skipped_count += 1
                continue

            existing = db.query(Excerpt).filter(
                Excerpt.dataset_value_id == item.dataset_value_id,
                Excerpt.start_offset == None,
            ).first()
            if existing:
                skipped_count += 1
                continue

            db.add(Excerpt(
                project_id=project_id,
                dataset_value_id=item.dataset_value_id,
            ))
            created_count += 1

    db.commit()

    return {"created_count": created_count, "skipped_count": skipped_count}


@router.delete("/{excerpt_id}")
async def delete_excerpt(
    project_id: int,
    excerpt_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an excerpt. Associated note gets excerpt_id SET NULL."""
    _get_project_or_404(db, project_id, user.id)
    excerpt = db.query(Excerpt).filter(
        Excerpt.id == excerpt_id,
        Excerpt.project_id == project_id,
    ).first()
    if not excerpt:
        raise HTTPException(status_code=404, detail="Excerpt not found")

    # Clear excerpt_id on any associated note before deleting
    db.query(Note).filter(Note.excerpt_id == excerpt_id).update(
        {Note.excerpt_id: None}, synchronize_session=False
    )

    log_action(
        db,
        action="deleted",
        entity_type="excerpt",
        entity_id=excerpt_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "segment_id": excerpt.segment_id,
            "start_offset": excerpt.start_offset,
            "end_offset": excerpt.end_offset,
        },
    )

    db.delete(excerpt)
    db.commit()

    return {"status": "ok", "excerpt_id": excerpt_id}


@router.get("/export")
async def export_excerpts_csv(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export all excerpts as CSV."""
    _get_project_or_404(db, project_id, user.id)

    # Use outerjoin so comment-based excerpts (segment_id IS NULL) are included
    excerpts = _base_excerpt_query(db, project_id).outerjoin(
        Segment, Excerpt.segment_id == Segment.id
    ).filter(
        or_(
            Excerpt.segment_id.is_(None),
            and_(Segment.merged_into_id == None, Segment.split_into_id == None)
        )
    ).order_by(Excerpt.created_at.desc()).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Excerpt ID", "Source", "Conversation", "Speaker", "Timestamp",
        "Excerpt Text", "Type", "Note", "Created At",
    ])

    for exc in excerpts:
        resp = _excerpt_to_response(exc)
        if exc.segment_id is not None:
            excerpt_type = "sub-segment" if exc.start_offset is not None else "whole-segment"
            source = "conversation"
        else:
            excerpt_type = "text"
            source = "text"
        note_text = resp.note.content if resp.note else ""
        writer.writerow([
            exc.id,
            source,
            csv_safe(resp.conversation_name or ""),
            csv_safe(resp.speaker_name or ""),
            resp.segment_timestamp or "",
            csv_safe(resp.excerpt_text),
            excerpt_type,
            csv_safe(note_text),
            utc_wire(resp.created_at),
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=excerpts.csv"},
    )


@router.get("/starred", response_model=QuotedExcerptsResponse)
async def list_quoted_excerpts(
    project_id: int,
    source: str = Query("all", description="Source filter: all, conversations, or text (legacy 'comments' is coerced to 'text')"),
    code_ids: str | None = Query(None, description="Comma-separated code IDs"),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
    text_column_ids: str | None = Query(None, description="Comma-separated text column IDs"),
    exclude_facilitator: bool = Query(False),
    participant_ids: str | None = Query(None, description="Comma-separated participant IDs"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all quoted excerpts (segments + text values) with enriched data."""
    _get_project_or_404(db, project_id, user.id)

    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    parsed_code_ids = parse_int_list(code_ids)
    parsed_conversation_ids = parse_int_list(conversation_ids)
    parsed_document_ids = parse_int_list(document_ids)
    parsed_text_column_ids = parse_int_list(text_column_ids)
    parsed_participant_ids = parse_int_list(participant_ids)

    # Pre-load codes with categories for enrichment
    all_codes = db.query(Code).filter(Code.project_id == project_id).options(
        joinedload(Code.category)
    ).all()
    code_map = {c.id: c for c in all_codes}

    results: list[QuotedExcerptItem] = []

    # ── Segment excerpts (conversations + documents) ──
    if source in ("all", "conversations"):
        seg_query = (
            db.query(Excerpt)
            .filter(
                Excerpt.project_id == project_id,
                Excerpt.segment_id.isnot(None),
            )
            .join(Segment, Excerpt.segment_id == Segment.id)
            .filter(*_visible_segment_filter())
            .outerjoin(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Document, Segment.document_id == Document.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .options(
                contains_eager(Excerpt.segment).contains_eager(Segment.conversation),
                contains_eager(Excerpt.segment).contains_eager(Segment.document),
                contains_eager(Excerpt.segment).contains_eager(Segment.speaker).joinedload(Speaker.participant),
                contains_eager(Excerpt.segment).selectinload(Segment.code_applications),
                joinedload(Excerpt.note),
            )
        )

        # Source filters: conversation_ids and document_ids use OR logic
        source_filters = []
        if parsed_conversation_ids:
            source_filters.append(Segment.conversation_id.in_(parsed_conversation_ids))
        if parsed_document_ids:
            source_filters.append(Segment.document_id.in_(parsed_document_ids))
        if source_filters:
            seg_query = seg_query.filter(or_(*source_filters))

        if exclude_facilitator:
            seg_query = seg_query.filter(
                (Speaker.is_facilitator == 0) | (Segment.speaker_id == None)
            )

        if parsed_participant_ids:
            seg_query = seg_query.filter(Speaker.participant_id.in_(parsed_participant_ids))

        if parsed_code_ids:
            seg_query = seg_query.filter(
                exists().where(
                    and_(
                        CodeApplication.segment_id == Segment.id,
                        CodeApplication.code_id.in_(parsed_code_ids),
                    )
                )
            )

        seg_excerpts = seg_query.all()

        # Batch-fetch preceding segments for context_before
        # Keys: ('conv', conversation_id, seq-1) or ('doc', document_id, seq-1)
        conv_preceding_keys: set[tuple[int, int]] = set()
        doc_preceding_keys: set[tuple[int, int]] = set()
        for exc in seg_excerpts:
            seg = exc.segment
            if seg and seg.sequence_order is not None and seg.sequence_order > 0:
                if seg.conversation_id:
                    conv_preceding_keys.add((seg.conversation_id, seg.sequence_order - 1))
                elif seg.document_id:
                    doc_preceding_keys.add((seg.document_id, seg.sequence_order - 1))

        preceding_map: dict[tuple[str, int, int], Segment] = {}
        prev_filter_clauses = []
        for conv_id, seq in conv_preceding_keys:
            prev_filter_clauses.append(
                and_(Segment.conversation_id == conv_id, Segment.sequence_order == seq)
            )
        for doc_id, seq in doc_preceding_keys:
            prev_filter_clauses.append(
                and_(Segment.document_id == doc_id, Segment.sequence_order == seq)
            )
        if prev_filter_clauses:
            prev_segments = (
                db.query(Segment)
                .filter(or_(*prev_filter_clauses), *_visible_segment_filter())
                .options(joinedload(Segment.speaker))
                .all()
            )
            for ps in prev_segments:
                if ps.conversation_id:
                    preceding_map[('conv', ps.conversation_id, ps.sequence_order)] = ps
                elif ps.document_id:
                    preceding_map[('doc', ps.document_id, ps.sequence_order)] = ps

        for exc in seg_excerpts:
            seg = exc.segment
            if not seg:
                continue

            is_sub = exc.start_offset is not None and exc.end_offset is not None
            text = seg.text[exc.start_offset:exc.end_offset] if is_sub else seg.text
            full_text = seg.text

            speaker = seg.speaker
            speaker_name = speaker.name if speaker else None
            speaker_is_fac = bool(speaker.is_facilitator) if speaker else False
            part_id = speaker.participant_id if speaker else None
            part = speaker.participant if speaker and speaker.participant_id else None
            part_name = (part.display_name or part.identifier) if part else None

            conv = seg.conversation
            doc = seg.document
            if conv:
                source_name = conv.name
            elif doc:
                source_name = doc.name
            else:
                source_name = ""

            # Preceding segment context
            ctx_before = None
            ctx_before_speaker = None
            if seg.sequence_order is not None and seg.sequence_order > 0:
                if seg.conversation_id:
                    prev_seg = preceding_map.get(('conv', seg.conversation_id, seg.sequence_order - 1))
                elif seg.document_id:
                    prev_seg = preceding_map.get(('doc', seg.document_id, seg.sequence_order - 1))
                else:
                    prev_seg = None
                if prev_seg:
                    ctx_before = prev_seg.text
                    ctx_before_speaker = prev_seg.speaker.name if prev_seg.speaker else None

            # Code applications
            ca_ids = [ca.code_id for ca in seg.code_applications]
            codes_detail = []
            for cid in ca_ids:
                c = code_map.get(cid)
                if c:
                    codes_detail.append(QuotedExcerptCode(
                        id=c.id, name=c.name, color=c.color,
                        category_id=c.category_id,
                        category_name=c.category.name if c.category else None,
                        category_color=c.category.color if c.category else None,
                    ))

            note_content = None
            if exc.note and not exc.note.is_archived:
                note_content = exc.note.content

            results.append(QuotedExcerptItem(
                excerpt_id=exc.id,
                source_type="segment",
                segment_id=seg.id,
                text=text,
                full_segment_text=full_text,
                is_sub_segment=is_sub,
                start_offset=exc.start_offset,
                end_offset=exc.end_offset,
                speaker_name=speaker_name,
                speaker_is_facilitator=speaker_is_fac,
                participant_id=part_id,
                participant_name=part_name,
                source_name=source_name,
                sequence_order=seg.sequence_order,
                conversation_id=conv.id if conv else None,
                conversation_date=conv.conversation_date if conv else None,
                conversation_sort_key=conv.id if conv else None,
                document_id=doc.id if doc else None,
                document_name=doc.name if doc else None,
                applied_code_ids=ca_ids,
                applied_codes=codes_detail,
                excerpt_note=note_content,
                context_before=ctx_before,
                context_before_speaker=ctx_before_speaker,
                created_at=exc.created_at,
            ))

    # ── Comment excerpts ──
    if source in ("all", "text"):
        cmt_query = (
            db.query(Excerpt)
            .filter(
                Excerpt.project_id == project_id,
                Excerpt.dataset_value_id.isnot(None),
            )
            .join(DatasetValue, Excerpt.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
            .options(
                contains_eager(Excerpt.dataset_value).joinedload(DatasetValue.column).joinedload(DatasetColumn.dataset),
                contains_eager(Excerpt.dataset_value).joinedload(DatasetValue.row).joinedload(DatasetRow.participant),
                contains_eager(Excerpt.dataset_value).selectinload(DatasetValue.code_applications),
                joinedload(Excerpt.note),
            )
        )

        if parsed_text_column_ids:
            cmt_query = cmt_query.filter(DatasetColumn.id.in_(parsed_text_column_ids))

        if parsed_participant_ids:
            cmt_query = cmt_query.filter(DatasetRow.participant_id.in_(parsed_participant_ids))

        if parsed_code_ids:
            cmt_query = cmt_query.filter(
                exists().where(
                    and_(
                        CodeApplication.dataset_value_id == DatasetValue.id,
                        CodeApplication.code_id.in_(parsed_code_ids),
                    )
                )
            )

        cmt_excerpts = cmt_query.all()

        for exc in cmt_excerpts:
            dv = exc.dataset_value
            if not dv:
                continue

            text = dv.value_text or ""
            col = dv.column
            ds = col.dataset if col else None
            row = dv.row
            part = row.participant if row and row.participant_id else None

            col_name = col.column_name or (col.column_text[:50] if col and col.column_text else "")
            ds_name = ds.name if ds else ""
            source_name = f"{ds_name} › {col_name}"

            ca_ids = [ca.code_id for ca in dv.code_applications]
            codes_detail = []
            for cid in ca_ids:
                c = code_map.get(cid)
                if c:
                    codes_detail.append(QuotedExcerptCode(
                        id=c.id, name=c.name, color=c.color,
                        category_id=c.category_id,
                        category_name=c.category.name if c.category else None,
                        category_color=c.category.color if c.category else None,
                    ))

            note_content = None
            if exc.note and not exc.note.is_archived:
                note_content = exc.note.content

            results.append(QuotedExcerptItem(
                excerpt_id=exc.id,
                source_type="text",
                dataset_value_id=dv.id,
                text=text,
                full_segment_text=text,
                is_sub_segment=False,
                speaker_name=None,
                speaker_is_facilitator=False,
                participant_id=part.id if part else None,
                participant_name=(part.display_name or part.identifier) if part else None,
                source_name=source_name,
                dataset_id=ds.id if ds else None,
                dataset_name=ds_name,
                column_id=col.id if col else None,
                column_name=col_name,
                applied_code_ids=ca_ids,
                applied_codes=codes_detail,
                excerpt_note=note_content,
                created_at=exc.created_at,
            ))

    conv_count = sum(1 for r in results if r.source_type == "segment" and r.conversation_id is not None)
    doc_count = sum(1 for r in results if r.source_type == "segment" and r.document_id is not None)
    cmt_count = sum(1 for r in results if r.source_type == "text")

    return QuotedExcerptsResponse(
        excerpts=results,
        total_excerpts=len(results),
        total_conversation_excerpts=conv_count,
        total_comment_excerpts=cmt_count,
        total_document_excerpts=doc_count,
    )


@router.get("/{excerpt_id}", response_model=ExcerptDetailResponse)
async def get_excerpt(
    project_id: int,
    excerpt_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a single excerpt with surrounding context."""
    _get_project_or_404(db, project_id, user.id)
    excerpt = _base_excerpt_query(db, project_id).filter(
        Excerpt.id == excerpt_id,
        Excerpt.project_id == project_id,
    ).first()
    if not excerpt:
        raise HTTPException(status_code=404, detail="Excerpt not found")

    base = _excerpt_to_response(excerpt)

    # Get context segments (one before, one after)
    context_before = None
    context_after = None
    segment_text = None

    if excerpt.segment:
        seg = excerpt.segment
        segment_text = seg.text

        prev_seg = db.query(Segment).filter(
            Segment.conversation_id == seg.conversation_id,
            Segment.sequence_order < seg.sequence_order,
            *_visible_segment_filter(),
        ).order_by(Segment.sequence_order.desc()).first()
        if prev_seg:
            context_before = prev_seg.text

        next_seg = db.query(Segment).filter(
            Segment.conversation_id == seg.conversation_id,
            Segment.sequence_order > seg.sequence_order,
            *_visible_segment_filter(),
        ).order_by(Segment.sequence_order.asc()).first()
        if next_seg:
            context_after = next_seg.text

    return ExcerptDetailResponse(
        **base.model_dump(),
        context_before=context_before,
        context_after=context_after,
        segment_text=segment_text,
    )
