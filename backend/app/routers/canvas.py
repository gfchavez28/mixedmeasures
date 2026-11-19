"""Canvas CRUD + Theme CRUD + Relationship endpoints."""

import base64
import binascii
import json
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.audit import AuditEntry
from ..models.user import User
from ..models.canvas import Canvas, CanvasTheme, CanvasThemeRelationship, CanvasPendingItem, CanvasSnapshot
from ..schemas.canvas import (
    CanvasCreate,
    CanvasUpdate,
    CanvasExportDocxRequest,
    CanvasListItem,
    CanvasDetailResponse,
    CanvasThemeResponse,
    CanvasThemeRelationshipResponse,
    ThemeCreate,
    ThemeUpdate,
    ThemeReorderRequest,
    ThemeRestore,
    ThemeRestoreLost,
    ThemeRestoreResponse,
    ThemeRelationshipCreate,
    ThemeRelationshipUpdate,
    PendingItemCreate,
    PendingItemResponse,
    SnapshotCreate,
    SnapshotResponse,
    SnapshotDetailResponse,
)
from ..services.canvas import (
    list_canvases,
    create_canvas,
    get_canvas_full,
    update_canvas,
    delete_canvas,
    duplicate_canvas,
    create_theme,
    update_theme,
    delete_theme,
    reorder_themes,
    restore_theme,
    theme_restore_record,
    build_theme_response,
    create_theme_relationship,
    update_theme_relationship,
    delete_theme_relationship,
    add_pending_item,
    remove_pending_item,
    list_pending_items,
    refresh_theme_content,
    create_snapshot,
    list_snapshots,
    restore_snapshot,
    delete_snapshot,
)
from ..services.canvas_embed_scrub import holds_canvas_quotes
from ..services.canvas_export import ChartTable, DisplayAppendix, DisplayTable, export_canvas_docx
from ..services.audit import log_action
from ..config import get_media_dir
from .helpers import _get_project_or_404, sanitize_content_disposition

router = APIRouter()


def _parse_introduction(raw: str | None) -> dict | None:
    """Parse Canvas.introduction from stored JSON string to dict."""
    if not raw:
        return None
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None


def _build_detail_response(canvas, themes_list,
                           pending_items_list=None) -> CanvasDetailResponse:
    """Build CanvasDetailResponse with parsed introduction."""
    return CanvasDetailResponse(
        id=canvas.id,
        name=canvas.name,
        display_order=canvas.display_order,
        introduction=_parse_introduction(canvas.introduction),
        created_at=canvas.created_at,
        updated_at=canvas.updated_at,
        themes=themes_list,
        pending_items=pending_items_list or [],
    )


def _pending_item_labels(db: Session, items) -> dict[tuple[str, int], str]:
    """Resolve each pending item to the name the researcher gave it (#823j).

    `source_id` is polymorphic with no FK, so this is one grouped query per
    TYPE — never one per item, which on a busy inbox would be an N+1 on the
    canvas's own load.

    ⚠️ A material's display name is `custom_name or auto_name`, the same
    precedence the Materials drawer uses. The drawer showed the real name while
    the inbox two panels away showed `"Chart #5"`, which is what made the
    inbox look broken rather than unimplemented.
    """
    from ..models.materials import Material
    from ..models.memo import Memo
    from ..models.excerpt import Excerpt, excerpt_text_from
    from ..models.segment import Segment
    from ..models.dataset import DatasetValue

    by_type: dict[str, list[int]] = {}
    for pi in items:
        by_type.setdefault(pi.item_type, []).append(pi.source_id)

    labels: dict[tuple[str, int], str] = {}

    for mid, custom, auto in db.query(Material.id, Material.custom_name, Material.auto_name).filter(
        Material.id.in_(by_type.get("material", []))
    ).all() if by_type.get("material") else []:
        name = (custom or auto or "").strip()
        if name:
            labels[("material", mid)] = name

    for memo_id, title in db.query(Memo.id, Memo.title).filter(
        Memo.id.in_(by_type.get("memo", []))
    ).all() if by_type.get("memo") else []:
        if title and title.strip():
            labels[("memo", memo_id)] = title.strip()

    # #1316: an excerpt has no text COLUMN — its text is derived from its segment
    # (or its dataset value) by `excerpt_text_from`, the helper the excerpt API
    # uses too. This queried `Excerpt.excerpt_text`, a response-schema field, so
    # every canvas with a quote in its inbox 500'd on open, save, duplicate and
    # snapshot restore. Still ONE grouped query for the type.
    for exc_id, start, end, segment_text, value_text in db.query(
        Excerpt.id, Excerpt.start_offset, Excerpt.end_offset,
        Segment.text, DatasetValue.value_text,
    ).outerjoin(Segment, Excerpt.segment_id == Segment.id).outerjoin(
        DatasetValue, Excerpt.dataset_value_id == DatasetValue.id
    ).filter(
        Excerpt.id.in_(by_type.get("excerpt", []))
    ).all() if by_type.get("excerpt") else []:
        # An excerpt has no name — its TEXT is its identity, so a short prefix
        # is what tells two of them apart. A clip's text is often empty (its
        # label is the excerpt), which is why the empty case falls back to the
        # id rather than rendering a blank row.
        snippet = excerpt_text_from(segment_text, start, end, value_text).strip()
        if snippet:
            labels[("excerpt", exc_id)] = snippet[:80] + ("…" if len(snippet) > 80 else "")

    return labels


def _build_pending_items_list(canvas, db: Session | None = None) -> list[PendingItemResponse]:
    """Build pending items list from eager-loaded canvas."""
    if not hasattr(canvas, "pending_items") or not canvas.pending_items:
        return []
    labels = _pending_item_labels(db, canvas.pending_items) if db is not None else {}
    return [
        PendingItemResponse(
            id=pi.id, canvas_id=pi.canvas_id, item_type=pi.item_type,
            source_id=pi.source_id, created_at=pi.created_at,
            source_label=labels.get((pi.item_type, pi.source_id)),
        )
        for pi in canvas.pending_items
    ]


# ── Helpers ─────────────────────────────────────────────────────────────────


def _get_canvas_or_404(db: Session, project_id: int, canvas_id: int) -> Canvas:
    canvas = (
        db.query(Canvas)
        .filter(Canvas.id == canvas_id, Canvas.project_id == project_id)
        .first()
    )
    if not canvas:
        raise HTTPException(status_code=404, detail="Canvas not found")
    return canvas


def _get_theme_or_404(db: Session, canvas_id: int, theme_id: int) -> CanvasTheme:
    theme = (
        db.query(CanvasTheme)
        .filter(CanvasTheme.id == theme_id, CanvasTheme.canvas_id == canvas_id)
        .first()
    )
    if not theme:
        raise HTTPException(status_code=404, detail="Theme not found")
    return theme


def _get_relationship_or_404(db: Session, canvas_id: int, rel_id: int) -> CanvasThemeRelationship:
    rel = (
        db.query(CanvasThemeRelationship)
        .filter(CanvasThemeRelationship.id == rel_id, CanvasThemeRelationship.canvas_id == canvas_id)
        .first()
    )
    if not rel:
        raise HTTPException(status_code=404, detail="Theme relationship not found")
    return rel


# ── Canvas CRUD ─────────────────────────────────────────────────────────────


@router.get("", response_model=list[CanvasListItem])
async def list_canvases_endpoint(
    project_id: int,
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    return list_canvases(db, project_id, include_archived=include_archived)


@router.post("", response_model=CanvasDetailResponse, status_code=201)
async def create_canvas_endpoint(
    project_id: int,
    data: CanvasCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = create_canvas(db, project_id, data.name)
    if data.introduction is not None:
        canvas.introduction = json.dumps(data.introduction)
        db.flush()

    log_action(
        db, action="canvas_create", entity_type="canvas",
        entity_id=canvas.id, user_id=user.id, project_id=project_id,
        details={"name": canvas.name},
    )
    db.commit()
    db.refresh(canvas)

    return _build_detail_response(canvas, [])


@router.get("/{canvas_id}", response_model=CanvasDetailResponse)
async def get_canvas_endpoint(
    project_id: int,
    canvas_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = get_canvas_full(db, project_id, canvas_id)
    if not canvas:
        raise HTTPException(status_code=404, detail="Canvas not found")

    return _build_detail_response(
        canvas,
        [CanvasThemeResponse(**build_theme_response(t)) for t in canvas.themes],
        _build_pending_items_list(canvas, db),
    )


@router.patch("/{canvas_id}", response_model=CanvasDetailResponse)
async def update_canvas_endpoint(
    project_id: int,
    canvas_id: int,
    data: CanvasUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = _get_canvas_or_404(db, project_id, canvas_id)
    intro_str = json.dumps(data.introduction) if data.introduction is not None else None
    update_canvas(db, canvas, name=data.name, display_order=data.display_order,
                  introduction=intro_str, is_archived=data.is_archived)

    log_action(
        db, action="canvas_update", entity_type="canvas",
        entity_id=canvas.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id},
    )
    db.commit()

    full = get_canvas_full(db, project_id, canvas.id)
    return _build_detail_response(
        full,
        [CanvasThemeResponse(**build_theme_response(t)) for t in full.themes],
        _build_pending_items_list(full, db),
    )


@router.delete("/{canvas_id}")
async def delete_canvas_endpoint(
    project_id: int,
    canvas_id: int,
    permanent: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = _get_canvas_or_404(db, project_id, canvas_id)

    if permanent:
        log_action(
            db, action="canvas_delete", entity_type="canvas",
            entity_id=canvas.id, user_id=user.id, project_id=project_id,
            details={"name": canvas.name},
        )
        delete_canvas(db, canvas)
    else:
        canvas.is_archived = True
        log_action(
            db, action="canvas_archive", entity_type="canvas",
            entity_id=canvas.id, user_id=user.id, project_id=project_id,
            details={"name": canvas.name},
        )
        db.flush()
    db.commit()
    return {"status": "ok", "archived": not permanent, "canvas_id": canvas_id}


@router.post("/{canvas_id}/duplicate", response_model=CanvasDetailResponse, status_code=201)
async def duplicate_canvas_endpoint(
    project_id: int,
    canvas_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = _get_canvas_or_404(db, project_id, canvas_id)
    new_canvas = duplicate_canvas(db, project_id, canvas)

    log_action(
        db, action="canvas_duplicate", entity_type="canvas",
        entity_id=new_canvas.id, user_id=user.id, project_id=project_id,
        details={"source_id": canvas.id, "name": new_canvas.name},
    )
    db.commit()

    # Re-fetch with eager loading
    full = get_canvas_full(db, project_id, new_canvas.id)
    return _build_detail_response(
        full,
        [CanvasThemeResponse(**build_theme_response(t)) for t in full.themes],
        _build_pending_items_list(full, db),
    )


# ── Theme CRUD ──────────────────────────────────────────────────────────────


@router.post("/{canvas_id}/themes", response_model=CanvasThemeResponse, status_code=201)
async def create_theme_endpoint(
    project_id: int,
    canvas_id: int,
    data: ThemeCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    try:
        theme = create_theme(db, canvas_id, data.name,
                             section_type=data.section_type,
                             description=data.description, color=data.color,
                             viz_x=data.viz_x, viz_y=data.viz_y,
                             after_theme_id=data.after_theme_id,
                             parent_theme_id=data.parent_theme_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    log_action(
        db, action="canvas_theme_create", entity_type="canvas_theme",
        entity_id=theme.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id, "name": theme.name},
    )
    db.commit()
    db.refresh(theme)

    return CanvasThemeResponse(**build_theme_response(theme))


# IMPORTANT: reorder BEFORE /{theme_id} to avoid "reorder" being captured as path param
@router.patch("/{canvas_id}/themes/reorder")
async def reorder_themes_endpoint(
    project_id: int,
    canvas_id: int,
    data: ThemeReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)

    try:
        reorder_themes(db, canvas_id, data.theme_ids)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    log_action(
        db, action="canvas_theme_reorder", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"theme_ids": data.theme_ids},
    )
    db.commit()
    return {"status": "ok"}


@router.patch("/{canvas_id}/themes/{theme_id}", response_model=CanvasThemeResponse)
async def update_theme_endpoint(
    project_id: int,
    canvas_id: int,
    theme_id: int,
    data: ThemeUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    theme = _get_theme_or_404(db, canvas_id, theme_id)

    update_data = data.model_dump(exclude_unset=True)
    try:
        update_theme(db, theme, update_data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    log_action(
        db, action="canvas_theme_update", entity_type="canvas_theme",
        entity_id=theme.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id, "name": theme.name},
    )
    db.commit()
    db.refresh(theme)

    return CanvasThemeResponse(**build_theme_response(theme))


@router.delete("/{canvas_id}/themes/{theme_id}")
async def delete_theme_endpoint(
    project_id: int,
    canvas_id: int,
    theme_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    theme = _get_theme_or_404(db, canvas_id, theme_id)
    theme_name = theme.name
    # #1301: what this delete destroys, read before it, for the undo to send back.
    record = theme_restore_record(theme)

    delete_theme(db, theme)

    entry = log_action(
        db, action="canvas_theme_delete", entity_type="canvas_theme",
        entity_id=theme_id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id, "name": theme_name},
    )
    # #1301: THIS delete's own entry, for the restore's withdrawal gate — never "the newest
    # delete of this id", which after SQLite's id reuse can be a later theme's.
    db.flush()
    record["deleted_audit_id"] = entry.id
    db.commit()
    return {"status": "ok", "deleted_id": theme_id, "restore": record}


#: #1301 — the refusal when a withdrawal ran between a delete and its undo. Guidance, as every
#: refusal here is: `useHistory` shows it in these words and drops the step.
RESTORE_AFTER_WITHDRAWAL = (
    "This section can no longer be brought back: a participant was withdrawn after it was "
    "deleted, and it holds quotes that may be theirs."
)


def _withdrawn_since_delete(db: Session, project_id: int, theme_id: int | None,
                            deleted_audit_id: int | None) -> bool:
    """Whether a withdrawal was recorded in this project after THIS delete (#1301).

    Measured from the delete's OWN audit entry, which the delete put in the record — never
    the newest delete of the theme id: SQLite reuses the highest id, so a later theme given
    the same id, deleted after the withdrawal, would move "since" past it. Ordered by
    audit-entry id, never by time (SQLite's `now()` is second precision). Both entries survive
    a withdrawal: `withdrawn` is the one it never strips (D9), and it does not key on canvas
    entries. An absent entry, or one that is not this project's delete of this theme, reads
    as "yes" — fail closed.
    """
    if deleted_audit_id is None:
        return True
    is_this_delete = db.query(AuditEntry.id).filter(
        AuditEntry.id == deleted_audit_id,
        AuditEntry.project_id == project_id,
        AuditEntry.action == "canvas_theme_delete",
        AuditEntry.entity_type == "canvas_theme",
        AuditEntry.entity_id == theme_id,
    ).first() is not None
    if not is_this_delete:
        return True
    return db.query(AuditEntry.id).filter(
        AuditEntry.project_id == project_id,
        AuditEntry.action == "withdrawn",
        AuditEntry.id > deleted_audit_id,
    ).first() is not None


# Not a router root, and declared before nothing that could capture it: the only other
# `/themes/{theme_id}` routes are PATCH and DELETE.
@router.post("/{canvas_id}/themes/restore", response_model=ThemeRestoreResponse, status_code=201)
async def restore_theme_endpoint(
    project_id: int,
    canvas_id: int,
    data: ThemeRestore,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Undo a theme delete (#1301): put back everything the delete destroyed, in ONE
    transaction, and say what the canvas no longer allowed (`not_restored`)."""
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    # 🔴 A withdrawal rewrites every quote in the project's themes and snapshots
    # (`canvas_embed_scrub.py`) — but a deleted theme's record lives only in the page's undo
    # history, which no withdrawal reaches. Restoring it after one could bring a withdrawn
    # person's words back, so a record holding a quote is refused then.
    if holds_canvas_quotes(data.content) and _withdrawn_since_delete(
            db, project_id, data.id, data.deleted_audit_id):
        raise HTTPException(status_code=409, detail=RESTORE_AFTER_WITHDRAWAL)

    theme, lost = restore_theme(db, canvas_id, data.model_dump())

    log_action(
        db, action="canvas_theme_restore", entity_type="canvas_theme",
        entity_id=theme.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id, "name": theme.name, "deleted_id": data.id},
    )
    db.commit()
    db.refresh(theme)
    return ThemeRestoreResponse(
        theme=CanvasThemeResponse(**build_theme_response(theme)),
        not_restored=ThemeRestoreLost(**lost),
    )


# ── Theme Relationships ─────────────────────────────────────────────────────


@router.post("/{canvas_id}/theme-relationships", response_model=CanvasThemeRelationshipResponse, status_code=201)
async def create_relationship_endpoint(
    project_id: int,
    canvas_id: int,
    data: ThemeRelationshipCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    # Validate both themes exist in this canvas
    _get_theme_or_404(db, canvas_id, data.source_theme_id)
    _get_theme_or_404(db, canvas_id, data.target_theme_id)

    try:
        rel = create_theme_relationship(
            db, canvas_id, data.source_theme_id, data.target_theme_id,
            data.relationship_type, data.label, data.weight, data.is_bidirectional,
            line_style=data.line_style, line_color=data.line_color,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Relationship between these themes already exists")

    log_action(
        db, action="canvas_relationship_create", entity_type="canvas_theme_relationship",
        entity_id=rel.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id, "type": data.relationship_type},
    )
    db.commit()
    db.refresh(rel)

    return CanvasThemeRelationshipResponse(
        id=rel.id, source_theme_id=rel.source_theme_id, target_theme_id=rel.target_theme_id,
        relationship_type=rel.relationship_type, label=rel.label,
        weight=rel.weight, is_bidirectional=rel.is_bidirectional,
        line_style=rel.line_style, line_color=rel.line_color,
    )


@router.patch("/{canvas_id}/theme-relationships/{rel_id}", response_model=CanvasThemeRelationshipResponse)
async def update_relationship_endpoint(
    project_id: int,
    canvas_id: int,
    rel_id: int,
    data: ThemeRelationshipUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    rel = _get_relationship_or_404(db, canvas_id, rel_id)

    update_data = data.model_dump(exclude_unset=True)
    update_theme_relationship(db, rel, update_data)

    log_action(
        db, action="canvas_relationship_update", entity_type="canvas_theme_relationship",
        entity_id=rel.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id},
    )
    db.commit()
    db.refresh(rel)

    return CanvasThemeRelationshipResponse(
        id=rel.id, source_theme_id=rel.source_theme_id, target_theme_id=rel.target_theme_id,
        relationship_type=rel.relationship_type, label=rel.label,
        weight=rel.weight, is_bidirectional=rel.is_bidirectional,
        line_style=rel.line_style, line_color=rel.line_color,
    )


@router.delete("/{canvas_id}/theme-relationships/{rel_id}")
async def delete_relationship_endpoint(
    project_id: int,
    canvas_id: int,
    rel_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    rel = _get_relationship_or_404(db, canvas_id, rel_id)

    log_action(
        db, action="canvas_relationship_delete", entity_type="canvas_theme_relationship",
        entity_id=rel.id, user_id=user.id, project_id=project_id,
        details={"canvas_id": canvas_id},
    )
    delete_theme_relationship(db, rel)
    db.commit()
    return {"status": "ok", "deleted_id": rel_id}


# ── Pending Items ──────────────────────────────────────────────────────────


@router.get("/{canvas_id}/pending-items", response_model=list[PendingItemResponse])
async def list_pending_items_endpoint(
    project_id: int,
    canvas_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    items = list_pending_items(db, canvas_id)
    return [
        PendingItemResponse(
            id=i.id, canvas_id=i.canvas_id, item_type=i.item_type,
            source_id=i.source_id, created_at=i.created_at,
        )
        for i in items
    ]


@router.post("/{canvas_id}/pending-items", response_model=PendingItemResponse, status_code=201)
async def add_pending_item_endpoint(
    project_id: int,
    canvas_id: int,
    data: PendingItemCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    item = add_pending_item(db, canvas_id, data.item_type, data.source_id)
    log_action(
        db, action="canvas_pending_item_add", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"item_type": data.item_type, "source_id": data.source_id},
    )
    db.commit()
    db.refresh(item)
    return PendingItemResponse(
        id=item.id, canvas_id=item.canvas_id, item_type=item.item_type,
        source_id=item.source_id, created_at=item.created_at,
    )


@router.delete("/{canvas_id}/pending-items/{item_id}")
async def remove_pending_item_endpoint(
    project_id: int,
    canvas_id: int,
    item_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    item = (
        db.query(CanvasPendingItem)
        .filter(CanvasPendingItem.id == item_id, CanvasPendingItem.canvas_id == canvas_id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Pending item not found")
    log_action(
        db, action="canvas_pending_item_remove", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"item_id": item_id},
    )
    remove_pending_item(db, item)
    db.commit()
    return {"status": "ok", "deleted_id": item_id}


# ── Theme Content Refresh ──────────────────────────────────────────────────


@router.post("/{canvas_id}/themes/{theme_id}/refresh-content")
async def refresh_theme_content_endpoint(
    project_id: int,
    canvas_id: int,
    theme_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    theme = _get_theme_or_404(db, canvas_id, theme_id)
    result = refresh_theme_content(db, theme)
    db.commit()
    return result


# ── Snapshots ─────────────────────────────────────────────────────────────


def _get_snapshot_or_404(db: Session, canvas_id: int, snapshot_id: int) -> CanvasSnapshot:
    snap = (
        db.query(CanvasSnapshot)
        .filter(CanvasSnapshot.id == snapshot_id, CanvasSnapshot.canvas_id == canvas_id)
        .first()
    )
    if not snap:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return snap


@router.get("/{canvas_id}/snapshots", response_model=list[SnapshotResponse])
async def list_snapshots_endpoint(
    project_id: int,
    canvas_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    return list_snapshots(db, canvas_id)


@router.get("/{canvas_id}/snapshots/{snapshot_id}", response_model=SnapshotDetailResponse)
async def get_snapshot_endpoint(
    project_id: int,
    canvas_id: int,
    snapshot_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    snap = _get_snapshot_or_404(db, canvas_id, snapshot_id)
    return SnapshotDetailResponse(
        id=snap.id,
        name=snap.name,
        theme_count=snap.theme_count,
        snapshot_data=json.loads(snap.snapshot_data),
        created_at=snap.created_at,
    )


@router.post("/{canvas_id}/snapshots", response_model=SnapshotResponse, status_code=201)
async def create_snapshot_endpoint(
    project_id: int,
    canvas_id: int,
    data: SnapshotCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    snap = create_snapshot(db, canvas_id, data.name)
    log_action(
        db, action="snapshot_create", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"snapshot_name": data.name},
    )
    db.commit()
    return snap


@router.post("/{canvas_id}/snapshots/{snapshot_id}/restore", response_model=CanvasDetailResponse)
async def restore_snapshot_endpoint(
    project_id: int,
    canvas_id: int,
    snapshot_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = _get_canvas_or_404(db, project_id, canvas_id)
    snap = _get_snapshot_or_404(db, canvas_id, snapshot_id)
    restore_snapshot(db, canvas, snap)
    log_action(
        db, action="snapshot_restore", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"snapshot_name": snap.name},
    )
    db.commit()
    full = get_canvas_full(db, project_id, canvas_id)
    return _build_detail_response(
        full,
        [CanvasThemeResponse(**build_theme_response(t)) for t in full.themes],
        _build_pending_items_list(full, db),
    )


@router.delete("/{canvas_id}/snapshots/{snapshot_id}")
async def delete_snapshot_endpoint(
    project_id: int,
    canvas_id: int,
    snapshot_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_canvas_or_404(db, project_id, canvas_id)
    snap = _get_snapshot_or_404(db, canvas_id, snapshot_id)
    delete_snapshot(db, snap)
    log_action(
        db, action="snapshot_delete", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"snapshot_name": snap.name},
    )
    db.commit()
    return {"status": "ok", "deleted_id": snapshot_id}


# ── Export ────────────────────────────────────────────────────────────────────


# Chart-image limits — guards memory on the constrained VPS target.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_MAX_CHART_IMG_BYTES = 10 * 1024 * 1024      # per image
_MAX_CHART_TOTAL_BYTES = 60 * 1024 * 1024    # all images combined
_MAX_CHART_COUNT = 300


def _decode_chart_images(raw: dict[str, str]) -> dict[int, bytes]:
    """Decode + validate base64 PNG chart images. Silently drops anything that
    isn't a well-formed, in-bounds PNG (export then falls back to a table for
    that chart). Never raises on bad client input."""
    out: dict[int, bytes] = {}
    total = 0
    for key, value in list(raw.items())[:_MAX_CHART_COUNT]:
        try:
            material_id = int(key)
        except (ValueError, TypeError):
            continue
        if not isinstance(value, str) or not value:
            continue
        # Tolerate a data-URL prefix.
        if value.startswith("data:"):
            _, _, value = value.partition(",")
        try:
            data = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError):
            continue
        if not data.startswith(_PNG_MAGIC) or len(data) > _MAX_CHART_IMG_BYTES:
            continue
        total += len(data)
        if total > _MAX_CHART_TOTAL_BYTES:
            break
        out[material_id] = data
    return out


# Chart-table limits (#1406 D5). MEASURED (python-docx 1.2.0): ~0.1 ms per cell
# rendered, so the total bounds the document build at ~2 s on this event-loop
# endpoint. A table over a limit is never truncated — a truncated table would
# read as complete — it is replaced by a sentence saying why it is missing.
_MAX_TABLE_ROWS = 2000
_MAX_TABLE_COLS = 100
_MAX_TABLE_CELL_CHARS = 2000
_MAX_TABLE_TOTAL_CELLS = 20000
#: The sentence printed under a chart's table (`ExportTable.note`) — a joint display's note's cap.
_MAX_TABLE_NOTE_CHARS = 20_000


def _decode_chart_tables(raw: dict[str, Any]) -> dict[int, ChartTable]:
    """Validate the chart tables the client shaped (#1406 D5). Drops a malformed
    entry (that chart then reads "Chart data unavailable"), pads a short row with
    blanks as the Markdown table shows it, and marks a table over a size limit
    ``too_large``. Never raises on bad client input.

    A table's ``note`` — the sentence the Markdown and HTML exports print under it (a
    comparison's method note, the groups left out of its tests) — is validated as a joint
    display's is: absent reads as none, a non-string drops the entry, one over
    ``_MAX_TABLE_NOTE_CHARS`` marks it ``too_large``. Before, the server never read it, so
    Word printed the table without the words that qualify it."""
    out: dict[int, ChartTable] = {}
    total = 0
    for key, value in list(raw.items())[:_MAX_CHART_COUNT]:
        try:
            material_id = int(key)
        except (ValueError, TypeError):
            continue
        if not isinstance(value, dict):
            continue
        headers, rows, note = value.get("headers"), value.get("rows"), value.get("note", "")
        if not isinstance(headers, list) or not headers or not isinstance(rows, list) or not isinstance(note, str):
            continue
        width = len(headers)
        cells = width * (len(rows) + 1)
        if len(rows) > _MAX_TABLE_ROWS or width > _MAX_TABLE_COLS or total + cells > _MAX_TABLE_TOTAL_CELLS:
            out[material_id] = ChartTable(headers=[], rows=[], too_large=True)
            continue
        if not all(isinstance(h, str) for h in headers) or not all(
            isinstance(r, list) and len(r) <= width and all(isinstance(c, str) for c in r) for r in rows
        ):
            continue  # a non-string cell, or a value with no column to sit under
        if any(len(c) > _MAX_TABLE_CELL_CHARS for c in headers) or any(
            len(c) > _MAX_TABLE_CELL_CHARS for r in rows for c in r
        ) or len(note) > _MAX_TABLE_NOTE_CHARS:
            out[material_id] = ChartTable(headers=[], rows=[], too_large=True)
            continue
        total += cells
        out[material_id] = ChartTable(
            headers=list(headers), rows=[r + [""] * (width - len(r)) for r in rows], note=note,
        )
    return out


# A joint display's report (D174) carries the researcher's own writing — a meta-inference, a
# quote — so a cell may be longer than a chart's; the shared cell total still bounds the build.
_MAX_DISPLAY_KEY_CHARS = 64
_MAX_DISPLAY_CELL_CHARS = 10_000
_MAX_DISPLAY_NOTE_CHARS = 20_000
#: The Definitions' paragraphs (the notice rule, rewrite D): one per basis group, vocabulary,
#: citation and construct with cases that don't fit — a display holds at most 100 constructs.
_MAX_DISPLAY_DEFINITIONS = 200


def _str_grid(headers: Any, rows: Any) -> tuple[list[str], list[list[str]]] | None:
    """Headers and rows as strings, or None when either is malformed."""
    if not isinstance(headers, list) or not headers or not all(isinstance(h, str) for h in headers):
        return None
    if not isinstance(rows, list) or not all(
        isinstance(r, list) and all(isinstance(c, str) for c in r) for r in rows
    ):
        return None
    return list(headers), [list(r) for r in rows]


def _decode_display_tables(raw: dict[str, Any], cells_used: int) -> dict[str, DisplayTable]:
    """Validate the joint displays' report tables (D174), as `_decode_chart_tables` validates a
    chart's: a malformed entry is DROPPED (that display then reads "not available in this
    export"), a short row is padded, and a display over a size limit — the cell total shared with
    the chart tables already decoded (``cells_used``) — is marked ``too_large``, never truncated.
    Never raises on bad client input."""
    out: dict[str, DisplayTable] = {}
    total = cells_used
    for key, value in list(raw.items())[:_MAX_CHART_COUNT]:
        if not isinstance(key, str) or not key or len(key) > _MAX_DISPLAY_KEY_CHARS or not isinstance(value, dict):
            continue
        title, message, note = value.get("title"), value.get("message"), value.get("note", "")
        if not isinstance(title, str) or not isinstance(note, str) or not (message is None or isinstance(message, str)):
            continue
        if len(title) > _MAX_TABLE_CELL_CHARS or len(note) > _MAX_DISPLAY_NOTE_CHARS or (
            message is not None and len(message) > _MAX_TABLE_CELL_CHARS
        ):
            out[key] = DisplayTable(title=title[:_MAX_TABLE_CELL_CHARS], too_large=True)
            continue
        if message is not None:
            out[key] = DisplayTable(title=title, message=message)
            continue
        grid = _str_grid(value.get("headers"), value.get("rows"))
        spans, appendix_raw = value.get("span_rows", []), value.get("appendix", [])
        if grid is None or not isinstance(spans, list) or not isinstance(appendix_raw, list):
            continue
        headers, rows = grid
        width = len(headers)
        if not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(rows) and len(rows[i]) == 1 for i in spans):
            continue  # a span names a row that is not there, or one with more than its one cell
        span_rows = frozenset(spans)
        if any(len(r) > width for r in rows):
            continue  # a value with no column to sit under
        appendix: list[DisplayAppendix] = []
        for a in appendix_raw:
            a_grid = _str_grid(a.get("headers"), a.get("rows")) if isinstance(a, dict) else None
            a_title, a_note = (a.get("title"), a.get("note", "")) if isinstance(a, dict) else (None, None)
            if a_grid is None or not isinstance(a_title, str) or not isinstance(a_note, str) or any(
                len(r) > len(a_grid[0]) for r in a_grid[1]
            ):
                appendix = []
                grid = None
                break
            appendix.append(DisplayAppendix(
                title=a_title, headers=a_grid[0],
                rows=[r + [""] * (len(a_grid[0]) - len(r)) for r in a_grid[1]], note=a_note,
            ))
        if grid is None:
            continue
        # The notice rule (2026-11-18, rewrite D): the Definitions moved out of the note. Absent
        # (an older client) reads as none; malformed drops the entry, as every field here does.
        d_title, definitions = value.get("definitions_title", ""), value.get("definitions", [])
        if not isinstance(d_title, str) or not isinstance(definitions, list) or not all(
            isinstance(p, str) for p in definitions
        ):
            continue
        if (
            len(d_title) > _MAX_TABLE_CELL_CHARS or len(definitions) > _MAX_DISPLAY_DEFINITIONS
            or any(len(p) > _MAX_DISPLAY_NOTE_CHARS for p in definitions)
        ):
            out[key] = DisplayTable(title=title, too_large=True)
            continue
        cells = width * (len(rows) + 1) + sum(len(a.headers) * (len(a.rows) + 1) for a in appendix)
        strings = [*headers, *(c for r in rows for c in r)]
        appendix_strings = [s for a in appendix for s in (a.title, *a.headers, *(c for r in a.rows for c in r))]
        if (
            len(rows) > _MAX_TABLE_ROWS or width > _MAX_TABLE_COLS or total + cells > _MAX_TABLE_TOTAL_CELLS
            or any(len(s) > _MAX_DISPLAY_CELL_CHARS for s in strings)
            or any(len(s) > _MAX_TABLE_CELL_CHARS for s in appendix_strings)
            or any(len(a.note) > _MAX_DISPLAY_NOTE_CHARS for a in appendix)
        ):
            out[key] = DisplayTable(title=title, too_large=True)
            continue
        total += cells
        out[key] = DisplayTable(
            title=title,
            headers=headers,
            rows=[r if i in span_rows else r + [""] * (width - len(r)) for i, r in enumerate(rows)],
            span_rows=span_rows,
            note=note,
            appendix=appendix,
            definitions_title=d_title,
            definitions=list(definitions),
        )
    return out


def _chart_cells(tables: dict[int, ChartTable] | None) -> int:
    """The cells the decoded chart tables will render — the share of the document's total."""
    return sum(len(t.headers) * (len(t.rows) + 1) for t in (tables or {}).values() if not t.too_large)


@router.post("/{canvas_id}/export-docx")
async def export_canvas_docx_endpoint(
    project_id: int,
    canvas_id: int,
    body: CanvasExportDocxRequest | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    canvas = get_canvas_full(db, project_id, canvas_id)
    if not canvas:
        raise HTTPException(status_code=404, detail="Canvas not found")

    chart_images = _decode_chart_images(body.chart_images) if body else None
    chart_tables = _decode_chart_tables(body.chart_tables) if body else None
    display_tables = _decode_display_tables(body.display_tables, _chart_cells(chart_tables)) if body else None
    buf = export_canvas_docx(canvas, project_id, chart_images, chart_tables, display_tables)
    filename = sanitize_content_disposition(canvas.name) + ".docx"

    log_action(
        db, action="canvas_export_docx", entity_type="canvas",
        entity_id=canvas_id, user_id=user.id, project_id=project_id,
        details={"name": canvas.name},
    )
    db.commit()

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Canvas Images ─────────────────────────────────────────────────────────────

IMAGE_SAFE_PATTERN = re.compile(r'^[a-zA-Z0-9_-]+\.[a-z]+$')
MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MB

IMAGE_MIME_MAP = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
}

image_router = APIRouter()


def _detect_image_format(data: bytes) -> str | None:
    """Detect image format from file header bytes."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return "png"
    if data[:3] == b'\xff\xd8\xff':
        return "jpeg"
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return "gif"
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return "webp"
    if b'<svg' in data[:1000] or b'<?xml' in data[:100]:
        return "svg"
    return None


@image_router.post("")
async def upload_canvas_image(
    project_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    contents = await file.read()
    if len(contents) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="Image exceeds 10 MB limit")

    fmt = _detect_image_format(contents)
    if not fmt:
        raise HTTPException(status_code=400, detail="Unsupported image format. Supported: PNG, JPEG, GIF, WebP, SVG.")

    filename = f"{uuid.uuid4()}.{fmt}"
    canvas_media = get_media_dir() / str(project_id) / "canvas"
    canvas_media.mkdir(parents=True, exist_ok=True)
    (canvas_media / filename).write_bytes(contents)

    log_action(
        db, action="canvas_image_upload", entity_type="canvas",
        entity_id=0, user_id=user.id, project_id=project_id,
        details={"filename": filename, "size": len(contents)},
    )
    db.commit()
    return {"image_id": filename}


@image_router.get("/{image_id}")
async def serve_canvas_image(
    project_id: int,
    image_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    if not IMAGE_SAFE_PATTERN.match(image_id):
        raise HTTPException(status_code=400, detail="Invalid image ID")

    path = get_media_dir() / str(project_id) / "canvas" / image_id
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    ext = image_id.rsplit(".", 1)[-1] if "." in image_id else ""
    media_type = IMAGE_MIME_MAP.get(ext, "application/octet-stream")

    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=86400",
        },
    )

