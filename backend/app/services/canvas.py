"""Canvas business logic: canvas CRUD, theme CRUD,
relationships, refresh, stale indicators, duplication."""

import json
import logging

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session, selectinload

from ..models.canvas import (
    Canvas, CanvasTheme, CanvasThemeRelationship,
    CanvasPendingItem, CanvasSnapshot,
)

logger = logging.getLogger(__name__)

# Colors from CATEGORY_COLORS[0..7] for theme auto-assignment
THEME_AUTO_COLORS = [
    "#3b82f6", "#8b5cf6", "#ec4899", "#f97316",
    "#14b8a6", "#eab308", "#ef4444", "#22c55e",
]


# ── Tiptap Utilities (prose content) ────────────────────────────────────────

EMBED_NODE_TYPES = {"excerpt-embed", "chart-embed", "memo-embed"}

# Maps node type → (source_type for referenced_source_ids, attr key holding source ID)
EMBED_TYPE_MAP: dict[str, tuple[str, str]] = {
    "excerpt-embed": ("excerpt", "excerptId"),
    "chart-embed": ("material", "materialId"),
    "memo-embed": ("memo", "memoId"),
}


def walk_tiptap_nodes(doc: dict | None, node_types: set[str],
                      callback) -> None:
    """Recursively walk a Tiptap JSON document, calling callback(node) for
    each node whose ``type`` is in *node_types*. The callback may mutate the
    node's ``attrs`` dict in place."""
    if not isinstance(doc, dict):
        return
    if doc.get("type") in node_types:
        callback(doc)
    for child in doc.get("content", []):
        walk_tiptap_nodes(child, node_types, callback)


def extract_theme_searchable_text(content_json: dict | None) -> str | None:
    """Extract all plain text from a theme's Tiptap JSON (prose + evidence
    node display text) for full-text search indexing."""
    if not content_json:
        return None
    parts: list[str] = []

    def _collect(node: dict) -> None:
        if not isinstance(node, dict):
            return
        node_type = node.get("type", "")
        # Regular text nodes
        if node_type == "text":
            t = node.get("text", "")
            if t:
                parts.append(t)
        # Evidence node display text
        attrs = node.get("attrs") or {}
        if node_type == "excerpt-embed":
            dt = attrs.get("displayText", "")
            if dt:
                parts.append(dt)
        elif node_type == "chart-embed":
            t = attrs.get("title", "")
            if t:
                parts.append(t)
        elif node_type == "memo-embed":
            for key in ("title", "preview"):
                v = attrs.get(key, "")
                if v:
                    parts.append(v)
        elif node_type == "image-embed":
            alt = attrs.get("alt", "")
            if alt:
                parts.append(alt)
        elif node_type == "callout-stat":
            for key in ("value", "label"):
                v = attrs.get(key, "")
                if v:
                    parts.append(str(v))
        for child in node.get("content", []):
            _collect(child)

    _collect(content_json)
    return " ".join(parts) or None


def extract_referenced_source_ids(content_json: dict | None) -> list[dict] | None:
    """Walk a Tiptap JSON document and collect ``[{"type": "excerpt", "id": N}, ...]``
    for all embed nodes."""
    if not content_json:
        return None
    refs: list[dict] = []

    def _collect(node: dict) -> None:
        attrs = node.get("attrs") or {}
        source_type, id_key = EMBED_TYPE_MAP[node["type"]]
        source_id = attrs.get(id_key)
        if source_id is not None:
            refs.append({"type": source_type, "id": source_id})

    walk_tiptap_nodes(content_json, EMBED_NODE_TYPES, _collect)
    return refs or None


def update_theme_content(db: Session, theme: CanvasTheme,
                         content_json: dict | None) -> CanvasTheme:
    """Save Tiptap JSON to a theme, rebuilding searchable_text and
    referenced_source_ids from the document."""
    theme.content = json.dumps(content_json) if content_json else None
    theme.searchable_text = extract_theme_searchable_text(content_json)
    refs = extract_referenced_source_ids(content_json)
    theme.referenced_source_ids = json.dumps(refs) if refs else None
    db.flush()
    return theme


# ── Pending Items ──────────────────────────────────────────────────────────


def add_pending_item(db: Session, canvas_id: int, item_type: str,
                     source_id: int) -> CanvasPendingItem:
    item = CanvasPendingItem(
        canvas_id=canvas_id, item_type=item_type, source_id=source_id,
    )
    db.add(item)
    db.flush()
    return item


def remove_pending_item(db: Session, item: CanvasPendingItem) -> None:
    db.delete(item)
    db.flush()


def list_pending_items(db: Session, canvas_id: int) -> list[CanvasPendingItem]:
    return (
        db.query(CanvasPendingItem)
        .filter(CanvasPendingItem.canvas_id == canvas_id)
        .order_by(CanvasPendingItem.created_at)
        .all()
    )


# ── Canvas CRUD ─────────────────────────────────────────────────────────────


def list_canvases(db: Session, project_id: int,
                  include_archived: bool = False) -> list[dict]:
    query = (
        db.query(Canvas)
        .filter(Canvas.project_id == project_id)
    )
    if not include_archived:
        query = query.filter(Canvas.is_archived == False)  # noqa: E712
    canvases = query.order_by(Canvas.display_order.asc(), Canvas.id.asc()).all()
    if not canvases:
        return []

    canvas_ids = [c.id for c in canvases]

    theme_counts = dict(
        db.query(CanvasTheme.canvas_id, sa_func.count(CanvasTheme.id))
        .filter(CanvasTheme.canvas_id.in_(canvas_ids))
        .group_by(CanvasTheme.canvas_id)
        .all()
    )

    return [
        {
            "id": c.id,
            "name": c.name,
            "display_order": c.display_order,
            "theme_count": theme_counts.get(c.id, 0),
            "is_archived": c.is_archived,
            "updated_at": c.updated_at,
        }
        for c in canvases
    ]


def create_canvas(db: Session, project_id: int, name: str = "Untitled canvas") -> Canvas:
    max_order = (
        db.query(sa_func.max(Canvas.display_order))
        .filter(Canvas.project_id == project_id)
        .scalar()
    )
    canvas = Canvas(
        project_id=project_id,
        name=name,
        display_order=(max_order or 0) + 1,
    )
    db.add(canvas)
    db.flush()
    return canvas


def get_canvas_full(db: Session, project_id: int, canvas_id: int) -> Canvas | None:
    canvas = (
        db.query(Canvas)
        .options(
            selectinload(Canvas.themes).selectinload(CanvasTheme.relationships_out),
            selectinload(Canvas.themes).selectinload(CanvasTheme.relationships_in),
            selectinload(Canvas.pending_items),
        )
        .filter(Canvas.id == canvas_id, Canvas.project_id == project_id)
        .first()
    )
    return canvas


def update_canvas(db: Session, canvas: Canvas, name: str | None = None,
                  display_order: int | None = None,
                  introduction: str | None = None,
                  is_archived: bool | None = None) -> Canvas:
    if name is not None:
        canvas.name = name
    if display_order is not None:
        canvas.display_order = display_order
    if introduction is not None:
        canvas.introduction = introduction
    if is_archived is not None:
        canvas.is_archived = is_archived
    db.flush()
    return canvas


def delete_canvas(db: Session, canvas: Canvas) -> None:
    db.delete(canvas)
    db.flush()


def duplicate_canvas(db: Session, project_id: int, canvas: Canvas) -> Canvas:
    # Create new canvas
    max_order = (
        db.query(sa_func.max(Canvas.display_order))
        .filter(Canvas.project_id == project_id)
        .scalar()
    )
    new_canvas = Canvas(
        project_id=project_id,
        name=f"Copy of {canvas.name}",
        display_order=(max_order or 0) + 1,
        introduction=canvas.introduction,
    )
    db.add(new_canvas)
    db.flush()

    # Copy themes (two-pass for parent_theme_id self-refs)
    theme_id_map: dict[int, int] = {}
    old_themes = (
        db.query(CanvasTheme)
        .filter(CanvasTheme.canvas_id == canvas.id)
        .order_by(CanvasTheme.doc_order)
        .all()
    )
    # First pass: create all themes with parent_theme_id=None
    for t in old_themes:
        new_theme = CanvasTheme(
            canvas_id=new_canvas.id,
            name=t.name,
            section_type=t.section_type,
            description=t.description,
            color=t.color,
            doc_order=t.doc_order,
            table_column_order=t.table_column_order,
            viz_x=t.viz_x,
            viz_y=t.viz_y,
            content=t.content,
            searchable_text=t.searchable_text,
            referenced_source_ids=t.referenced_source_ids,
        )
        db.add(new_theme)
        db.flush()
        theme_id_map[t.id] = new_theme.id
    # Second pass: remap parent_theme_id
    for t in old_themes:
        if t.parent_theme_id and t.parent_theme_id in theme_id_map:
            new_id = theme_id_map[t.id]
            new_theme = db.get(CanvasTheme, new_id)
            if new_theme:
                new_theme.parent_theme_id = theme_id_map[t.parent_theme_id]
    if any(t.parent_theme_id for t in old_themes):
        db.flush()

    # Copy theme relationships
    old_rels = (
        db.query(CanvasThemeRelationship)
        .filter(CanvasThemeRelationship.canvas_id == canvas.id)
        .all()
    )
    for r in old_rels:
        new_rel = CanvasThemeRelationship(
            canvas_id=new_canvas.id,
            source_theme_id=theme_id_map[r.source_theme_id],
            target_theme_id=theme_id_map[r.target_theme_id],
            relationship_type=r.relationship_type,
            label=r.label,
            weight=r.weight,
            is_bidirectional=r.is_bidirectional,
            line_style=r.line_style,
            line_color=r.line_color,
        )
        db.add(new_rel)

    # Copy pending items
    old_pending = (
        db.query(CanvasPendingItem)
        .filter(CanvasPendingItem.canvas_id == canvas.id)
        .all()
    )
    for pi in old_pending:
        db.add(CanvasPendingItem(
            canvas_id=new_canvas.id,
            item_type=pi.item_type,
            source_id=pi.source_id,
        ))

    db.flush()
    return new_canvas


# ── Theme CRUD ──────────────────────────────────────────────────────────────


def create_theme(db: Session, canvas_id: int, name: str,
                 section_type: str = "theme",
                 description: str | None = None, color: str | None = None,
                 viz_x: float | None = None,
                 viz_y: float | None = None,
                 after_theme_id: int | None = None,
                 parent_theme_id: int | None = None) -> CanvasTheme:
    # Auto-assign color from CATEGORY_COLORS if not provided (themes only)
    if color is None and section_type == "theme":
        theme_count = (
            db.query(sa_func.count(CanvasTheme.id))
            .filter(CanvasTheme.canvas_id == canvas_id)
            .scalar()
        ) or 0
        color = THEME_AUTO_COLORS[theme_count % len(THEME_AUTO_COLORS)]

    # Compute doc_order: after a specific theme, or at the end
    if after_theme_id is not None:
        ref_theme = (
            db.query(CanvasTheme)
            .filter(CanvasTheme.id == after_theme_id,
                    CanvasTheme.canvas_id == canvas_id)
            .first()
        )
        if not ref_theme:
            raise ValueError(f"Theme {after_theme_id} not found in canvas {canvas_id}")
        a = ref_theme.doc_order
        # Find next theme after the reference
        next_theme = (
            db.query(CanvasTheme)
            .filter(CanvasTheme.canvas_id == canvas_id,
                    CanvasTheme.doc_order > a)
            .order_by(CanvasTheme.doc_order)
            .first()
        )
        b = next_theme.doc_order if next_theme else a + 200
        new_doc = (a + b) // 2
        new_col = new_doc  # keep in sync
    else:
        max_doc = (
            db.query(sa_func.max(CanvasTheme.doc_order))
            .filter(CanvasTheme.canvas_id == canvas_id)
            .scalar()
        ) or 0
        max_col = (
            db.query(sa_func.max(CanvasTheme.table_column_order))
            .filter(CanvasTheme.canvas_id == canvas_id)
            .scalar()
        ) or 0
        new_doc = max_doc + 100
        new_col = max_col + 100

    theme = CanvasTheme(
        canvas_id=canvas_id,
        name=name,
        section_type=section_type,
        description=description,
        color=color,
        doc_order=new_doc,
        table_column_order=new_col,
        viz_x=viz_x,
        viz_y=viz_y,
        parent_theme_id=parent_theme_id,
    )
    db.add(theme)
    db.flush()

    # Re-gap if the midpoint left no room
    if after_theme_id is not None:
        a = ref_theme.doc_order  # noqa: F821 — ref_theme set above
        b_val = next_theme.doc_order if next_theme else a + 200  # noqa: F821
        if b_val - a < 2:
            recompute_theme_doc_orders(db, canvas_id)

    return theme


def recompute_theme_doc_orders(db: Session, canvas_id: int) -> None:
    """Re-gap all themes in a canvas to multiples of 100."""
    themes = (
        db.query(CanvasTheme)
        .filter(CanvasTheme.canvas_id == canvas_id)
        .order_by(CanvasTheme.doc_order, CanvasTheme.id)
        .all()
    )
    for i, t in enumerate(themes):
        new_order = (i + 1) * 100
        t.doc_order = new_order
        t.table_column_order = new_order
    db.flush()


def update_theme(db: Session, theme: CanvasTheme,
                 update_data: dict) -> CanvasTheme:
    # Handle section_type conversion (before color so auto-color isn't overwritten)
    if "section_type" in update_data and update_data["section_type"] is not None:
        new_type = update_data["section_type"]
        if new_type != theme.section_type:
            theme.section_type = new_type
            if new_type == "theme" and theme.color is None:
                # Auto-assign color when converting prose → theme
                theme_count = (
                    db.query(sa_func.count(CanvasTheme.id))
                    .filter(CanvasTheme.canvas_id == theme.canvas_id)
                    .scalar()
                ) or 0
                theme.color = THEME_AUTO_COLORS[theme_count % len(THEME_AUTO_COLORS)]
            elif new_type == "prose":
                # Strip color when converting theme → prose
                theme.color = None
    if "name" in update_data and update_data["name"] is not None:
        theme.name = update_data["name"]
    if "description" in update_data:
        theme.description = update_data["description"]
    if "color" in update_data:
        theme.color = update_data["color"]
    if "viz_x" in update_data:
        theme.viz_x = update_data["viz_x"]
    if "viz_y" in update_data:
        theme.viz_y = update_data["viz_y"]
    if "parent_theme_id" in update_data:
        new_parent_id = update_data["parent_theme_id"]
        if new_parent_id is not None:
            if new_parent_id == theme.id:
                raise ValueError("Theme cannot be its own parent")
            parent = db.query(CanvasTheme).filter(
                CanvasTheme.id == new_parent_id,
                CanvasTheme.canvas_id == theme.canvas_id,
            ).first()
            if not parent:
                raise ValueError(f"Parent theme {new_parent_id} not found in this canvas")
            if parent.parent_theme_id is not None:
                raise ValueError("Only one level of nesting is supported")
            has_children = db.query(CanvasTheme).filter(
                CanvasTheme.parent_theme_id == theme.id
            ).first() is not None
            if has_children:
                raise ValueError("Cannot nest a theme that already has children")
        theme.parent_theme_id = new_parent_id
    if "content" in update_data:
        update_theme_content(db, theme, update_data["content"])
    db.flush()
    return theme


def delete_theme(db: Session, theme: CanvasTheme) -> None:
    db.delete(theme)
    db.flush()


def reorder_themes(db: Session, canvas_id: int, theme_ids: list[int]) -> None:
    existing = (
        db.query(CanvasTheme.id)
        .filter(CanvasTheme.canvas_id == canvas_id)
        .all()
    )
    existing_ids = {row[0] for row in existing}

    if set(theme_ids) != existing_ids:
        raise ValueError("theme_ids must contain exactly all themes for this canvas")

    for i, tid in enumerate(theme_ids):
        order_val = (i + 1) * 100
        db.query(CanvasTheme).filter(CanvasTheme.id == tid).update(
            {"doc_order": order_val, "table_column_order": order_val},
            synchronize_session="fetch",
        )

    db.flush()


# ── Theme Relationships ─────────────────────────────────────────────────────


def create_theme_relationship(db: Session, canvas_id: int,
                              source_theme_id: int, target_theme_id: int,
                              relationship_type: str, label: str | None = None,
                              weight: int = 1,
                              is_bidirectional: bool = False,
                              line_style: str | None = None,
                              line_color: str | None = None) -> CanvasThemeRelationship:
    if source_theme_id == target_theme_id:
        raise ValueError("A theme cannot have a relationship with itself")

    rel = CanvasThemeRelationship(
        canvas_id=canvas_id,
        source_theme_id=source_theme_id,
        target_theme_id=target_theme_id,
        relationship_type=relationship_type,
        label=label,
        weight=weight,
        is_bidirectional=is_bidirectional,
        line_style=line_style,
        line_color=line_color,
    )
    db.add(rel)
    db.flush()
    return rel


def update_theme_relationship(db: Session, rel: CanvasThemeRelationship,
                              update_data: dict) -> CanvasThemeRelationship:
    if "relationship_type" in update_data and update_data["relationship_type"] is not None:
        rel.relationship_type = update_data["relationship_type"]
    if "label" in update_data:
        rel.label = update_data["label"]
    if "weight" in update_data and update_data["weight"] is not None:
        rel.weight = update_data["weight"]
    if "is_bidirectional" in update_data and update_data["is_bidirectional"] is not None:
        rel.is_bidirectional = update_data["is_bidirectional"]
    if "line_style" in update_data:
        rel.line_style = update_data["line_style"]
    if "line_color" in update_data:
        rel.line_color = update_data["line_color"]
    db.flush()
    return rel


def delete_theme_relationship(db: Session, rel: CanvasThemeRelationship) -> None:
    db.delete(rel)
    db.flush()


# ── Refresh ─────────────────────────────────────────────────────────────────



def refresh_theme_content(db: Session, theme: CanvasTheme) -> dict:
    """Walk a theme's Tiptap JSON and re-fetch source data for all embed
    nodes, updating cached attrs in place. Returns ``{"refreshed": bool}``."""
    if not theme.content:
        return {"refreshed": False}

    content = json.loads(theme.content) if isinstance(theme.content, str) else theme.content
    updated = False

    def _refresh_node(node: dict) -> None:
        nonlocal updated
        node_type = node.get("type", "")
        attrs = node.get("attrs") or {}

        if node_type == "excerpt-embed":
            excerpt_id = attrs.get("excerptId")
            if excerpt_id is None:
                return
            from ..models.excerpt import Excerpt
            from ..models.segment import Segment
            exc = db.query(Excerpt).filter(Excerpt.id == excerpt_id).first()
            if not exc:
                return
            if exc.segment_id:
                seg = db.query(Segment).filter(Segment.id == exc.segment_id).first()
                if seg:
                    text = seg.text or ""
                    if exc.start_offset is not None and exc.end_offset is not None:
                        text = text[exc.start_offset:exc.end_offset]
                    if attrs.get("displayText") != text:
                        attrs["displayText"] = text
                        updated = True

        elif node_type == "chart-embed":
            pe_id = attrs.get("materialId")
            if pe_id is None:
                return
            from ..models.materials import Material
            pe = db.query(Material).filter(Material.id == pe_id).first()
            if not pe:
                return
            new_title = pe.custom_name or pe.auto_name
            if attrs.get("title") != new_title:
                attrs["title"] = new_title
                updated = True

        elif node_type == "memo-embed":
            memo_id = attrs.get("memoId")
            if memo_id is None:
                return
            from ..models.memo import Memo
            memo = db.query(Memo).filter(Memo.id == memo_id).first()
            if not memo:
                return
            if attrs.get("title") != memo.title:
                attrs["title"] = memo.title
                updated = True
            new_preview = (memo.content or "")[:200]
            if attrs.get("preview") != new_preview:
                attrs["preview"] = new_preview
                updated = True

    walk_tiptap_nodes(content, EMBED_NODE_TYPES, _refresh_node)

    if updated:
        update_theme_content(db, theme, content)

    return {"refreshed": updated}


# ── Response Builders ───────────────────────────────────────────────────────


def _build_relationship_dict(r: CanvasThemeRelationship) -> dict:
    return {
        "id": r.id,
        "source_theme_id": r.source_theme_id,
        "target_theme_id": r.target_theme_id,
        "relationship_type": r.relationship_type,
        "label": r.label,
        "weight": r.weight,
        "is_bidirectional": r.is_bidirectional,
        "line_style": r.line_style,
        "line_color": r.line_color,
    }


def build_theme_response(theme: CanvasTheme) -> dict:
    # Parse stored JSON strings for content and referenced_source_ids
    content = None
    if theme.content:
        try:
            content = json.loads(theme.content) if isinstance(theme.content, str) else theme.content
        except (json.JSONDecodeError, TypeError):
            content = None
    refs = None
    if theme.referenced_source_ids:
        try:
            refs = json.loads(theme.referenced_source_ids) if isinstance(theme.referenced_source_ids, str) else theme.referenced_source_ids
        except (json.JSONDecodeError, TypeError):
            refs = None

    return {
        "id": theme.id,
        "name": theme.name,
        "section_type": theme.section_type,
        "description": theme.description,
        "color": theme.color,
        "doc_order": theme.doc_order,
        "viz_x": theme.viz_x,
        "viz_y": theme.viz_y,
        "parent_theme_id": theme.parent_theme_id,
        "content": content,
        "searchable_text": theme.searchable_text,
        "referenced_source_ids": refs,
        "relationships_out": [
            _build_relationship_dict(r)
            for r in (theme.relationships_out if hasattr(theme, "relationships_out") and theme.relationships_out else [])
        ],
        "relationships_in": [
            _build_relationship_dict(r)
            for r in (theme.relationships_in if hasattr(theme, "relationships_in") and theme.relationships_in else [])
        ],
    }


# ── Snapshots ────────────────────────────────────────────────────────────────

SNAPSHOT_MAX = 10


def create_snapshot(db: Session, canvas_id: int, name: str) -> CanvasSnapshot:
    canvas_obj = db.query(Canvas).filter(Canvas.id == canvas_id).first()
    themes = (
        db.query(CanvasTheme)
        .filter(CanvasTheme.canvas_id == canvas_id)
        .order_by(CanvasTheme.doc_order)
        .all()
    )
    relationships = (
        db.query(CanvasThemeRelationship)
        .filter(CanvasThemeRelationship.canvas_id == canvas_id)
        .all()
    )
    pending = (
        db.query(CanvasPendingItem)
        .filter(CanvasPendingItem.canvas_id == canvas_id)
        .all()
    )

    data = {
        "format_version": 1,
        "introduction": canvas_obj.introduction if canvas_obj else None,
        "themes": [
            {
                "id": t.id, "name": t.name, "section_type": t.section_type,
                "description": t.description, "color": t.color,
                "doc_order": t.doc_order, "table_column_order": t.table_column_order,
                "viz_x": t.viz_x, "viz_y": t.viz_y,
                "content": t.content, "searchable_text": t.searchable_text,
                "referenced_source_ids": t.referenced_source_ids,
                "parent_theme_id": t.parent_theme_id,
            }
            for t in themes
        ],
        "relationships": [
            {
                "source_theme_id": r.source_theme_id,
                "target_theme_id": r.target_theme_id,
                "relationship_type": r.relationship_type, "label": r.label,
                "weight": r.weight, "is_bidirectional": r.is_bidirectional,
                "line_style": r.line_style, "line_color": r.line_color,
            }
            for r in relationships
        ],
        "pending_items": [
            {"item_type": p.item_type, "source_id": p.source_id}
            for p in pending
        ],
    }

    snapshot = CanvasSnapshot(
        canvas_id=canvas_id,
        name=name,
        snapshot_data=json.dumps(data),
        theme_count=len(themes),
    )
    db.add(snapshot)
    db.flush()

    # Enforce rotation limit
    all_snapshots = (
        db.query(CanvasSnapshot)
        .filter(CanvasSnapshot.canvas_id == canvas_id)
        .order_by(CanvasSnapshot.created_at.asc())
        .all()
    )
    if len(all_snapshots) > SNAPSHOT_MAX:
        for old in all_snapshots[: len(all_snapshots) - SNAPSHOT_MAX]:
            db.delete(old)
        db.flush()

    return snapshot


def list_snapshots(db: Session, canvas_id: int) -> list[CanvasSnapshot]:
    return (
        db.query(CanvasSnapshot)
        .filter(CanvasSnapshot.canvas_id == canvas_id)
        .order_by(CanvasSnapshot.created_at.desc(), CanvasSnapshot.id.desc())
        .all()
    )


def restore_snapshot(db: Session, canvas: Canvas,
                     snapshot: CanvasSnapshot) -> None:
    from datetime import datetime, timezone

    # Auto-create pre-restore snapshot
    now = datetime.now(timezone.utc)
    create_snapshot(db, canvas.id, f"Pre-restore \u2014 {now:%Y-%m-%d %H:%M}")

    # Delete all existing themes (CASCADE takes relationships + pending items)
    db.query(CanvasTheme).filter(CanvasTheme.canvas_id == canvas.id).delete()
    db.query(CanvasPendingItem).filter(
        CanvasPendingItem.canvas_id == canvas.id
    ).delete()
    db.flush()

    data = json.loads(snapshot.snapshot_data)

    # Restore introduction if present in snapshot
    if "introduction" in data:
        canvas.introduction = data["introduction"]
        db.flush()

    # Pass 1: create themes with parent_theme_id=None
    theme_id_map: dict[int, int] = {}
    self_refs: list[dict] = []
    for item in data.get("themes", []):
        old_id = item["id"]
        theme = CanvasTheme(
            canvas_id=canvas.id,
            name=item["name"],
            section_type=item.get("section_type", "theme"),
            description=item.get("description"),
            color=item.get("color"),
            doc_order=item.get("doc_order", 0),
            table_column_order=item.get("table_column_order", 0),
            viz_x=item.get("viz_x"),
            viz_y=item.get("viz_y"),
            content=item.get("content"),
            searchable_text=item.get("searchable_text"),
            referenced_source_ids=item.get("referenced_source_ids"),
            parent_theme_id=None,
        )
        db.add(theme)
        db.flush()
        theme_id_map[old_id] = theme.id
        if item.get("parent_theme_id") is not None:
            self_refs.append(item)

    # Pass 2: remap parent_theme_id
    for item in self_refs:
        new_id = theme_id_map[item["id"]]
        new_parent = theme_id_map.get(item["parent_theme_id"])
        if new_parent is not None:
            db.query(CanvasTheme).filter(CanvasTheme.id == new_id).update(
                {"parent_theme_id": new_parent}
            )
    if self_refs:
        db.flush()

    # Recreate relationships
    for item in data.get("relationships", []):
        src = theme_id_map.get(item["source_theme_id"])
        tgt = theme_id_map.get(item["target_theme_id"])
        if src is None or tgt is None:
            logger.warning("Snapshot restore: unmapped relationship %s→%s",
                           item["source_theme_id"], item["target_theme_id"])
            continue
        rel = CanvasThemeRelationship(
            canvas_id=canvas.id,
            source_theme_id=src,
            target_theme_id=tgt,
            relationship_type=item["relationship_type"],
            label=item.get("label"),
            weight=item.get("weight", 1),
            is_bidirectional=item.get("is_bidirectional", False),
            line_style=item.get("line_style"),
            line_color=item.get("line_color"),
        )
        db.add(rel)

    # Recreate pending items
    for item in data.get("pending_items", []):
        pi = CanvasPendingItem(
            canvas_id=canvas.id,
            item_type=item["item_type"],
            source_id=item["source_id"],
        )
        db.add(pi)

    db.flush()


def delete_snapshot(db: Session, snapshot: CanvasSnapshot) -> None:
    db.delete(snapshot)
    db.flush()
