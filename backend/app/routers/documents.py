import json
import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import func

from ..config import get_documents_dir
from ..database import get_db
from ..models.user import User
from ..models.document import Document, SegmentationMode
from ..models.segment import Segment
from ..models.code_application import CodeApplication
from ..models.note import Note
from ..schemas.document import (
    DocumentListItem,
    DocumentDetailResponse,
    DocumentSegmentResponse,
    SegmentCodeResponse,
    ExcerptInfo,
    DocumentUpdateRequest,
    DocumentImportResultItem,
    DocumentNoteCreateRequest,
    DocumentMergeRequest,
    DocumentMergeResponse,
    DocumentUnmergeResponse,
    DocumentSplitRequest,
    DocumentSplitResponse,
    DocumentUnsplitResponse,
    SegmentationPreviewResponse,
    SegmentationPreviewSegment,
    ImagePositionUpdateRequest,
    DocumentSegmentUpdateRequest,
)
from ..schemas.segment import SegmentNoteInfo
from ..schemas.common import utc_wire
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.document_import import (
    extract_document,
    segment_document,
    preview_segmentation,
)
from ..services.coding_counts import coded_segment_count, coded_segment_counts
from .helpers import (
    _get_project_or_404,
    read_upload_with_limit,
    sanitize_content_disposition,
    visible_segment_filter,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/projects/{project_id}/documents",
    tags=["documents"],
)

ALLOWED_EXTENSIONS = {".docx", ".pdf", ".txt"}


def _get_document_or_404(db: Session, project_id: int, document_id: int) -> Document:
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.project_id == project_id,
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


def _document_dir(project_id: int, document_id: int) -> Path:
    return get_documents_dir() / str(project_id) / str(document_id)


def _format_from_filename(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".docx":
        return "docx"
    elif ext == ".pdf":
        return "pdf"
    elif ext == ".txt":
        return "txt"
    else:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file format: {ext}. Allowed: .docx, .pdf, .txt",
        )


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

@router.post("/upload-preview", response_model=SegmentationPreviewResponse)
async def upload_preview(
    project_id: int,
    file: UploadFile = File(...),
    segmentation_mode: str = Form("paragraph"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Preview segmentation for a single file without persisting."""
    _get_project_or_404(db, project_id, user.id)

    try:
        mode = SegmentationMode(segmentation_mode)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid segmentation mode: {segmentation_mode}")

    source_format = _format_from_filename(file.filename or "unknown.txt")
    file_bytes = await read_upload_with_limit(file)

    try:
        # Off the event loop: extraction is CPU-bound pure Python on untrusted
        # input — run inline it would stall every other request (including the
        # Electron health check) for the duration of a slow parse (an internal audit).
        extracted = await run_in_threadpool(extract_document, file_bytes, source_format)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    preview = preview_segmentation(extracted, mode)

    return SegmentationPreviewResponse(
        total_segments=preview.total_segments,
        segments=[
            SegmentationPreviewSegment(
                sequence_order=s.sequence_order,
                text=s.text,
                page_number=s.page_number,
                heading_level=s.heading_level,
                word_count=s.word_count,
            )
            for s in preview.segments
        ],
        warnings=preview.warnings,
    )


# ---------------------------------------------------------------------------
# Import (single file per request)
# ---------------------------------------------------------------------------

@router.post("/import", response_model=DocumentImportResultItem)
async def import_document(
    project_id: int,
    file: UploadFile = File(...),
    segmentation_mode: str = Form("paragraph"),
    name: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Import a single document file."""
    project = _get_project_or_404(db, project_id, user.id)

    try:
        mode = SegmentationMode(segmentation_mode)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid segmentation mode: {segmentation_mode}")

    filename = file.filename or "unknown.txt"
    source_format = _format_from_filename(filename)
    file_bytes = await read_upload_with_limit(file)

    # Extract (threadpooled — see upload_preview)
    try:
        extracted = await run_in_threadpool(extract_document, file_bytes, source_format)
    except ValueError as e:
        return DocumentImportResultItem(name=name or filename, error=str(e))

    # Segment
    segments_data, warnings = segment_document(extracted, mode)

    if not segments_data:
        return DocumentImportResultItem(
            name=name or filename,
            error="No text content could be extracted from this file.",
            warnings=warnings,
        )

    # Create Document
    doc_name = name or os.path.splitext(filename)[0]
    document = Document(
        project_id=project_id,
        name=doc_name,
        source_filename=filename,
        source_format=source_format,
        segmentation_mode=mode,
        page_count=extracted.page_count,
    )
    db.add(document)
    db.flush()  # get document.id

    # Create Segments
    for seg_data in segments_data:
        segment = Segment(
            document_id=document.id,
            conversation_id=None,
            sequence_order=seg_data.sequence_order,
            text=seg_data.text,
            word_count=seg_data.word_count,
            page_number=seg_data.page_number,
            heading_level=seg_data.heading_level,
        )
        db.add(segment)

    # Store original file and images on disk
    doc_dir = _document_dir(project_id, document.id)
    doc_dir.mkdir(parents=True, exist_ok=True)

    original_path = doc_dir / f"original.{source_format}"
    original_path.write_bytes(file_bytes)

    if extracted.images:
        images_dir = doc_dir / "images"
        images_dir.mkdir(exist_ok=True)

        # Build paragraph-index → sequence_order mapping.
        # Extraction filters empty paragraphs, so paragraph list indices
        # are sequential within the non-empty set.  Segmentation modes may
        # combine paragraphs (heading/page) or split them (sentence), so we
        # approximate: an image after paragraph P goes after the last segment
        # whose source paragraph index <= P.
        # In paragraph mode (most common) this is exact.
        para_count = len(extracted.paragraphs)
        seg_count = len(segments_data)
        positions = []

        for idx, img in enumerate(extracted.images):
            img_path = images_dir / f"{idx}.{img.format}"
            img_path.write_bytes(img.data)

            # Map paragraph position → segment sequence_order
            if para_count > 0 and seg_count > 0:
                # Scale paragraph index into segment index space
                after_seq = min(
                    int(img.position_after_paragraph / para_count * seg_count),
                    seg_count - 1,
                )
            else:
                after_seq = 0
            positions.append({"index": idx, "after_sequence_order": after_seq})

        # Persist mapping so the detail endpoint can serve it
        (images_dir / "positions.json").write_text(json.dumps(positions))

    log_action(
        db,
        action="imported",
        entity_type="document",
        entity_id=document.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": doc_name, "format": source_format, "segments": len(segments_data)},
    )

    db.commit()

    return DocumentImportResultItem(
        document_id=document.id,
        name=doc_name,
        segment_count=len(segments_data),
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# List / Detail
# ---------------------------------------------------------------------------

@router.get("", response_model=list[DocumentListItem])
async def list_documents(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all documents in a project."""
    _get_project_or_404(db, project_id, user.id)

    documents = db.query(Document).filter(
        Document.project_id == project_id
    ).order_by(Document.updated_at.desc()).all()

    if not documents:
        return []

    doc_ids = [d.id for d in documents]

    # Batch segment counts (visible only)
    seg_counts = dict(
        db.query(Segment.document_id, func.count(Segment.id))
        .filter(
            Segment.document_id.in_(doc_ids),
            *visible_segment_filter(),
        )
        .group_by(Segment.document_id)
        .all()
    )

    # Batch coded segment counts via the shared source of truth (invariant J-A).
    # Documents have no speaker, so participant_only=False (the participant
    # dimension is a no-op); the universal-code exclusion (#398) now applies here
    # too, matching the conversation surfaces.
    coded_counts = coded_segment_counts(
        db, Segment.document_id, doc_ids, participant_only=False
    )

    return [
        DocumentListItem(
            id=d.id,
            name=d.name,
            description=d.description,
            source_format=d.source_format,
            segmentation_mode=d.segmentation_mode.value if hasattr(d.segmentation_mode, 'value') else d.segmentation_mode,
            segment_count=seg_counts.get(d.id, 0),
            coded_segment_count=coded_counts.get(d.id, 0),
            page_count=d.page_count,
            created_at=d.created_at,
            updated_at=d.updated_at,
        )
        for d in documents
    ]


@router.get("/{document_id}", response_model=DocumentDetailResponse)
async def get_document(
    project_id: int,
    document_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get document detail with all segments."""
    document = _get_document_or_404(db, project_id, document_id)

    # Load segments with eager loading
    segments = (
        db.query(Segment)
        .filter(
            Segment.document_id == document_id,
            *visible_segment_filter(),
        )
        .options(
            selectinload(Segment.code_applications).joinedload(CodeApplication.code),
            selectinload(Segment.attached_notes),
            selectinload(Segment.excerpts),
        )
        .order_by(Segment.sequence_order)
        .all()
    )

    # Total counts for the list-item fields. coded_segments routes through the
    # shared source of truth (invariant J-A) so the universal-code exclusion
    # (#398) matches every other surface; total is just the visible count.
    total_segments = len(segments)
    coded_segments = coded_segment_count(
        db, Segment.document_id, document_id, participant_only=False
    )

    segment_responses = []
    for seg in segments:
        codes = [
            SegmentCodeResponse(
                id=ca.code.id,
                name=ca.code.name,
                color=ca.code.color,
                is_universal=ca.code.is_universal,
            )
            for ca in seg.code_applications
            if ca.code and ca.code.is_active
        ]

        active_notes = sorted(
            [n for n in seg.attached_notes if not n.is_archived],
            key=lambda n: n.id
        )
        attached_notes = [
            SegmentNoteInfo(id=n.id, sequence_number=idx + 1)
            for idx, n in enumerate(active_notes)
        ]
        has_note = len(active_notes) > 0

        # Excerpt info
        excerpt_info = None
        if seg.excerpts:
            has_whole = any(e.start_offset is None for e in seg.excerpts)
            sub_count = sum(1 for e in seg.excerpts if e.start_offset is not None)
            excerpt_info = ExcerptInfo(has_whole_segment=has_whole, sub_segment_count=sub_count)

        segment_responses.append(DocumentSegmentResponse(
            id=seg.id,
            sequence_order=seg.sequence_order,
            text=seg.text,
            word_count=seg.word_count,
            page_number=seg.page_number,
            heading_level=seg.heading_level,
            codes=codes,
            has_note=has_note,
            attached_notes=attached_notes,
            excerpt_info=excerpt_info,
            merged_into_id=seg.merged_into_id,
            is_merge_result=seg.is_merge_result,
            split_into_id=seg.split_into_id,
            is_split_result=seg.is_split_result,
        ))

    # Load image positions (if images were extracted during import)
    image_positions = []
    positions_path = _document_dir(project_id, document_id) / "images" / "positions.json"
    if positions_path.is_file():
        try:
            image_positions = json.loads(positions_path.read_text())
        except (json.JSONDecodeError, FileNotFoundError, OSError) as e:
            logger.warning("Failed to parse image positions JSON for document %s: %s", document_id, e)

    return DocumentDetailResponse(
        id=document.id,
        name=document.name,
        description=document.description,
        source_format=document.source_format,
        segmentation_mode=document.segmentation_mode.value if hasattr(document.segmentation_mode, 'value') else document.segmentation_mode,
        segment_count=total_segments,
        coded_segment_count=coded_segments,
        page_count=document.page_count,
        created_at=document.created_at,
        updated_at=document.updated_at,
        segments=segment_responses,
        image_positions=image_positions,
    )


# ---------------------------------------------------------------------------
# Original file
# ---------------------------------------------------------------------------

_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain; charset=utf-8",
}


@router.get("/{document_id}/original")
async def get_original_file(
    project_id: int,
    document_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Serve the original uploaded document file."""
    document = _get_document_or_404(db, project_id, document_id)

    doc_dir = _document_dir(project_id, document_id)
    original_path = doc_dir / f"original.{document.source_format}"

    if not original_path.is_file():
        raise HTTPException(status_code=404, detail="Original file not found")

    content_type = _CONTENT_TYPES.get(document.source_format, "application/octet-stream")

    safe_name = sanitize_content_disposition(document.source_filename)
    return FileResponse(
        path=str(original_path),
        media_type=content_type,
        filename=document.source_filename,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=3600",
        },
    )


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

@router.get("/{document_id}/images/{image_index}")
async def get_document_image(
    project_id: int,
    document_id: int,
    image_index: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Serve an extracted image from a document."""
    _get_document_or_404(db, project_id, document_id)

    if image_index < 0:
        raise HTTPException(status_code=400, detail="Invalid image index")

    images_dir = _document_dir(project_id, document_id) / "images"
    if not images_dir.is_dir():
        raise HTTPException(status_code=404, detail="No images available")

    # Find matching file by index (don't trust user-supplied format)
    found_path = None
    for ext in ("png", "jpeg"):
        candidate = images_dir / f"{image_index}.{ext}"
        if candidate.is_file() and not candidate.is_symlink():
            found_path = candidate
            break

    if not found_path:
        raise HTTPException(status_code=404, detail="Image not found")

    content_type = "image/png" if found_path.suffix == ".png" else "image/jpeg"

    return FileResponse(
        path=str(found_path),
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=86400",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'",
        },
    )


@router.delete("/{document_id}/images/{image_index}")
async def delete_document_image(
    project_id: int,
    document_id: int,
    image_index: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an extracted image from a document."""
    _get_document_or_404(db, project_id, document_id)

    if image_index < 0:
        raise HTTPException(status_code=400, detail="Invalid image index")

    images_dir = _document_dir(project_id, document_id) / "images"
    if not images_dir.is_dir():
        raise HTTPException(status_code=404, detail="No images available")

    # Delete the image file
    deleted_file = False
    for ext in ("png", "jpeg"):
        candidate = images_dir / f"{image_index}.{ext}"
        if candidate.is_file() and not candidate.is_symlink():
            candidate.unlink()
            deleted_file = True
            break

    if not deleted_file:
        raise HTTPException(status_code=404, detail="Image not found")

    # Remove from positions.json
    positions_path = images_dir / "positions.json"
    if positions_path.is_file():
        try:
            positions = json.loads(positions_path.read_text())
            positions = [p for p in positions if p.get("index") != image_index]
            positions_path.write_text(json.dumps(positions))
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to update image positions JSON for document %s: %s", document_id, e)

    return {"status": "ok", "deleted_index": image_index}


@router.patch("/{document_id}/images/{image_index}")
async def update_image_position(
    project_id: int,
    document_id: int,
    image_index: int,
    data: ImagePositionUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update the position of an extracted image."""
    _get_document_or_404(db, project_id, document_id)

    if image_index < 0:
        raise HTTPException(status_code=400, detail="Invalid image index")

    # Validate after_sequence_order is within bounds
    max_seq = (
        db.query(func.max(Segment.sequence_order))
        .filter(Segment.document_id == document_id, *visible_segment_filter())
        .scalar()
    ) or 0
    if data.after_sequence_order > max_seq:
        raise HTTPException(
            status_code=400,
            detail=f"after_sequence_order exceeds max segment order ({max_seq})",
        )

    images_dir = _document_dir(project_id, document_id) / "images"
    positions_path = images_dir / "positions.json"
    if not positions_path.is_file():
        raise HTTPException(status_code=404, detail="No image positions available")

    try:
        positions = json.loads(positions_path.read_text())
    except (json.JSONDecodeError, FileNotFoundError, OSError):
        raise HTTPException(status_code=500, detail="Failed to read positions")

    found = False
    for entry in positions:
        if entry.get("index") == image_index:
            entry["after_sequence_order"] = data.after_sequence_order
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail="Image not found in positions")

    positions_path.write_text(json.dumps(positions))

    return {"status": "ok", "image_positions": positions}


# ---------------------------------------------------------------------------
# Update / Delete
# ---------------------------------------------------------------------------

@router.patch("/{document_id}", response_model=DocumentListItem)
async def update_document(
    project_id: int,
    document_id: int,
    data: DocumentUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update document name or description."""
    document = _get_document_or_404(db, project_id, document_id)

    update_fields = data.model_dump(exclude_unset=True)
    for field_name, value in update_fields.items():
        setattr(document, field_name, value)

    log_action(
        db,
        action="updated",
        entity_type="document",
        entity_id=document.id,
        user_id=user.id,
        project_id=project_id,
        details=update_fields,
    )

    db.commit()
    db.refresh(document)

    # Compute counts for response
    seg_count = db.query(func.count(Segment.id)).filter(
        Segment.document_id == document_id,
        *visible_segment_filter(),
    ).scalar() or 0

    coded_count = coded_segment_count(
        db, Segment.document_id, document_id, participant_only=False
    )

    return DocumentListItem(
        id=document.id,
        name=document.name,
        description=document.description,
        source_format=document.source_format,
        segmentation_mode=document.segmentation_mode.value if hasattr(document.segmentation_mode, 'value') else document.segmentation_mode,
        segment_count=seg_count,
        coded_segment_count=coded_count,
        page_count=document.page_count,
        created_at=document.created_at,
        updated_at=document.updated_at,
    )


@router.delete("/{document_id}")
async def delete_document(
    project_id: int,
    document_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a document and all associated data + files."""
    document = _get_document_or_404(db, project_id, document_id)
    doc_name = document.name

    log_action(
        db,
        action="deleted",
        entity_type="document",
        entity_id=document.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": doc_name},
    )

    db.delete(document)
    db.commit()

    # Clean up filesystem
    doc_dir = _document_dir(project_id, document_id)
    try:
        if doc_dir.is_dir():
            shutil.rmtree(doc_dir)
    except Exception:
        logger.warning("Failed to clean up document files at %s", doc_dir)

    return {"status": "ok", "deleted_id": document_id}


# ---------------------------------------------------------------------------
# Segment text edit
# ---------------------------------------------------------------------------

@router.patch("/{document_id}/segments/{segment_id}")
async def update_document_segment(
    project_id: int,
    document_id: int,
    segment_id: int,
    data: DocumentSegmentUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a document segment's text."""
    _get_document_or_404(db, project_id, document_id)

    segment = db.query(Segment).filter(
        Segment.id == segment_id,
        Segment.document_id == document_id,
    ).first()
    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found in this document")

    text = data.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Segment text cannot be empty or whitespace-only")
    segment.text = text
    segment.word_count = len(text.split())

    db.commit()
    db.refresh(segment)

    return {"id": segment.id, "text": segment.text, "word_count": segment.word_count}


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------

@router.post("/{document_id}/notes")
async def create_document_note(
    project_id: int,
    document_id: int,
    data: DocumentNoteCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a note on a document segment."""
    document = _get_document_or_404(db, project_id, document_id)

    # Validate segment belongs to this document
    segment = db.query(Segment).filter(
        Segment.id == data.segment_id,
        Segment.document_id == document_id,
    ).first()
    if not segment:
        raise HTTPException(status_code=404, detail="Segment not found in this document")

    note = Note(
        document_id=document_id,
        segment_id=data.segment_id,
        conversation_id=None,
        dataset_value_id=None,
        content=data.content,
        sequence_number=0,
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    return {
        "id": note.id,
        "document_id": note.document_id,
        "segment_id": note.segment_id,
        "content": note.content,
        "created_at": utc_wire(note.created_at),
        "updated_at": utc_wire(note.updated_at),
    }


@router.get("/{document_id}/notes")
async def list_document_notes(
    project_id: int,
    document_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all notes for a document."""
    _get_document_or_404(db, project_id, document_id)

    notes = (
        db.query(Note)
        .filter(
            Note.document_id == document_id,
            Note.is_archived == False,
        )
        .options(joinedload(Note.segment))
        .order_by(Note.id)
        .all()
    )

    return [
        {
            "id": n.id,
            "document_id": n.document_id,
            "segment_id": n.segment_id,
            "content": n.content,
            "segment_sequence_order": n.segment.sequence_order if n.segment else None,
            "segment_text_snippet": (n.segment.text[:100] + "...") if n.segment and len(n.segment.text) > 100 else (n.segment.text if n.segment else None),
            "created_at": utc_wire(n.created_at),
            "updated_at": utc_wire(n.updated_at),
        }
        for n in notes
    ]


# ---------------------------------------------------------------------------
# Segment split/merge
# ---------------------------------------------------------------------------

def _segment_to_doc_response(seg: Segment) -> DocumentSegmentResponse:
    """Convert an eagerly-loaded Segment model to DocumentSegmentResponse."""
    codes = [
        SegmentCodeResponse(id=ca.code.id, name=ca.code.name, color=ca.code.color, is_universal=ca.code.is_universal)
        for ca in seg.code_applications
        if ca.code and ca.code.is_active
    ]
    active_notes = sorted(
        [n for n in seg.attached_notes if not n.is_archived],
        key=lambda n: n.id
    )
    attached_notes = [
        SegmentNoteInfo(id=n.id, sequence_number=idx + 1)
        for idx, n in enumerate(active_notes)
    ]
    has_note = len(active_notes) > 0
    excerpt_info = None
    if seg.excerpts:
        has_whole = any(e.start_offset is None for e in seg.excerpts)
        sub_count = sum(1 for e in seg.excerpts if e.start_offset is not None)
        excerpt_info = ExcerptInfo(has_whole_segment=has_whole, sub_segment_count=sub_count)
    return DocumentSegmentResponse(
        id=seg.id,
        sequence_order=seg.sequence_order,
        text=seg.text,
        word_count=seg.word_count,
        page_number=seg.page_number,
        heading_level=seg.heading_level,
        codes=codes,
        has_note=has_note,
        attached_notes=attached_notes,
        excerpt_info=excerpt_info,
        merged_into_id=seg.merged_into_id,
        is_merge_result=seg.is_merge_result,
        split_into_id=seg.split_into_id,
        is_split_result=seg.is_split_result,
    )


@router.post("/{document_id}/segments/merge", response_model=DocumentMergeResponse)
async def merge_document_segments(
    project_id: int,
    document_id: int,
    data: DocumentMergeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merge adjacent document segments."""
    from ..services.segment_operations import merge_segments

    document = _get_document_or_404(db, project_id, document_id)
    merged_segment, deleted_count = merge_segments(
        db, data.segment_ids, 'document', document_id,
        document.project_id, user.id,
    )
    return DocumentMergeResponse(
        merged_segment=_segment_to_doc_response(merged_segment),
        deleted_count=deleted_count,
    )


@router.post("/{document_id}/segments/{segment_id}/unmerge", response_model=DocumentUnmergeResponse)
async def unmerge_document_segment(
    project_id: int,
    document_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Unmerge a previously merged document segment."""
    from ..services.segment_operations import unmerge_segment

    document = _get_document_or_404(db, project_id, document_id)
    restored, restored_count = unmerge_segment(
        db, segment_id, 'document', document_id,
        document.project_id, user.id,
    )
    return DocumentUnmergeResponse(
        restored_segments=[_segment_to_doc_response(s) for s in restored],
        restored_count=restored_count,
    )


@router.post("/{document_id}/segments/split", response_model=DocumentSplitResponse)
async def split_document_segments(
    project_id: int,
    document_id: int,
    data: DocumentSplitRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Split document segment(s) by text selection."""
    from ..services.segment_operations import split_segment

    document = _get_document_or_404(db, project_id, document_id)
    new_segments, deleted_ids = split_segment(
        db, data.ranges, 'document', document_id,
        document.project_id, user.id,
    )
    return DocumentSplitResponse(
        new_segments=[_segment_to_doc_response(s) for s in new_segments],
        deleted_segment_ids=deleted_ids,
    )


@router.post("/{document_id}/segments/{segment_id}/unsplit", response_model=DocumentUnsplitResponse)
async def unsplit_document_segment(
    project_id: int,
    document_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Unsplit/rejoin a previously split document segment."""
    from ..services.segment_operations import unsplit_segment

    document = _get_document_or_404(db, project_id, document_id)
    restored, deleted_count = unsplit_segment(
        db, segment_id, 'document', document_id,
        document.project_id, user.id,
    )
    return DocumentUnsplitResponse(
        restored_segment=_segment_to_doc_response(restored),
        deleted_count=deleted_count,
    )
