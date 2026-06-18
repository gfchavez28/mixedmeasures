import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import json
import pytest
from app.models.project import Project
from app.models.canvas import (
    Canvas, CanvasTheme, CanvasThemeRelationship,
    CanvasPendingItem, CanvasSnapshot,
)
from app.services.canvas import (
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
    create_theme_relationship,
    update_theme_relationship,
    delete_theme_relationship,
    walk_tiptap_nodes,
    extract_theme_searchable_text,
    extract_referenced_source_ids,
    update_theme_content,
    build_theme_response,
    add_pending_item,
    remove_pending_item,
    list_pending_items,
    refresh_theme_content,
    create_snapshot,
    list_snapshots,
    restore_snapshot,
    delete_snapshot,
)
from app.services.audit import get_audit_trail, log_action


# ── Helpers ─────────────────────────────────────────────────────────────────


def _create_project(db, name="Test Project"):
    p = Project(name=name, user_id=1)
    db.add(p)
    db.flush()
    return p


def _create_canvas(db, project_id, name="Test Canvas"):
    return create_canvas(db, project_id, name)


def _create_theme(db, canvas_id, name="Theme A"):
    return create_theme(db, canvas_id, name)


# ── Canvas CRUD ─────────────────────────────────────────────────────────────


def test_create_canvas_default_name(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    assert c.name == "Untitled canvas"
    assert c.introduction is None
    assert c.display_order == 1


def test_create_canvas_custom_name(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id, name="My Canvas")
    assert c.name == "My Canvas"


def test_create_canvas_auto_increment_order(db_session):
    p = _create_project(db_session)
    c1 = create_canvas(db_session, p.id, "First")
    c2 = create_canvas(db_session, p.id, "Second")
    assert c2.display_order == c1.display_order + 1


def test_list_canvases_empty(db_session):
    p = _create_project(db_session)
    result = list_canvases(db_session, p.id)
    assert result == []


def test_list_canvases_with_counts(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    _create_theme(db_session, c.id, "T1")
    _create_theme(db_session, c.id, "T2")
    db_session.flush()

    result = list_canvases(db_session, p.id)
    assert len(result) == 1
    assert result[0]["theme_count"] == 2


def test_list_canvases_ordering(db_session):
    p = _create_project(db_session)
    c1 = create_canvas(db_session, p.id, "A")
    c2 = create_canvas(db_session, p.id, "B")
    result = list_canvases(db_session, p.id)
    assert result[0]["name"] == "A"
    assert result[1]["name"] == "B"


def test_get_canvas_full_nested(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = _create_theme(db_session, c.id, "Theme")
    db_session.flush()

    full = get_canvas_full(db_session, p.id, c.id)
    assert full is not None
    assert len(full.themes) == 1
    assert full.themes[0].name == "Theme"


def test_get_canvas_full_not_found(db_session):
    p = _create_project(db_session)
    assert get_canvas_full(db_session, p.id, 9999) is None


def test_update_canvas_name_and_introduction(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    update_canvas(db_session, c, name="Renamed", introduction='{"type":"doc"}')
    assert c.name == "Renamed"
    assert c.introduction == '{"type":"doc"}'


def test_delete_canvas_cascades(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = _create_theme(db_session, c.id, "T")
    canvas_id = c.id

    delete_canvas(db_session, c)
    db_session.flush()

    assert db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == canvas_id).count() == 0


def test_duplicate_canvas_deep_copy(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id, "Original")
    t1 = _create_theme(db_session, c.id, "Theme 1")
    t2 = _create_theme(db_session, c.id, "Theme 2")

    # Add a theme relationship
    rel = CanvasThemeRelationship(
        canvas_id=c.id, source_theme_id=t1.id, target_theme_id=t2.id,
        relationship_type="confirms", label="test",
    )
    db_session.add(rel)
    db_session.flush()

    dup = duplicate_canvas(db_session, p.id, c)
    db_session.flush()

    assert dup.name == "Copy of Original"
    assert dup.id != c.id

    # Themes copied with new IDs
    dup_themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == dup.id).all()
    assert len(dup_themes) == 2
    dup_theme_ids = {t.id for t in dup_themes}
    assert dup_theme_ids.isdisjoint({t1.id, t2.id})

    # Relationships copied
    dup_rels = (
        db_session.query(CanvasThemeRelationship)
        .filter(CanvasThemeRelationship.canvas_id == dup.id)
        .all()
    )
    assert len(dup_rels) == 1
    assert dup_rels[0].source_theme_id in dup_theme_ids
    assert dup_rels[0].target_theme_id in dup_theme_ids
    assert dup_rels[0].relationship_type == "confirms"


# ── Validation ──────────────────────────────────────────────────────────────


def test_empty_canvas_name_rejected(db_session):
    from app.schemas.canvas import CanvasCreate
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        CanvasCreate(name="")


def test_empty_theme_name_rejected(db_session):
    from app.schemas.canvas import ThemeCreate
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ThemeCreate(name="")


# ── Theme CRUD ──────────────────────────────────────────────────────────────


def test_create_theme_gapped_ordering(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = _create_theme(db_session, c.id, "First")
    t2 = _create_theme(db_session, c.id, "Second")
    assert t1.doc_order == 100
    assert t2.doc_order == 200
    assert t1.table_column_order == 100
    assert t2.table_column_order == 200


def test_create_theme_with_color(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "Colored", color="#4f46e5")
    assert t.color == "#4f46e5"


def test_update_theme_name_and_description(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = _create_theme(db_session, c.id, "Original")
    update_theme(db_session, t, {"name": "Updated", "description": "A description"})
    assert t.name == "Updated"
    assert t.description == "A description"


def test_update_theme_clear_description(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T", description="Has desc")
    update_theme(db_session, t, {"description": None})
    assert t.description is None


def test_reorder_themes_updates_doc_order(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = _create_theme(db_session, c.id, "First")
    t2 = _create_theme(db_session, c.id, "Second")

    # Reverse order
    reorder_themes(db_session, c.id, [t2.id, t1.id])
    db_session.flush()

    db_session.refresh(t1)
    db_session.refresh(t2)
    assert t2.doc_order < t1.doc_order
    assert t2.table_column_order < t1.table_column_order


def test_reorder_themes_invalid_ids_rejected(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    _create_theme(db_session, c.id, "T")

    with pytest.raises(ValueError, match="must contain exactly all themes"):
        reorder_themes(db_session, c.id, [9999])


# ── Cascade/FK ──────────────────────────────────────────────────────────────


def test_project_delete_cascades_canvases(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    canvas_id = c.id
    db_session.flush()

    db_session.delete(p)
    db_session.flush()

    assert db_session.query(Canvas).filter(Canvas.id == canvas_id).first() is None


def test_canvas_delete_cascades_relationships(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = _create_theme(db_session, c.id, "A")
    t2 = _create_theme(db_session, c.id, "B")
    rel = CanvasThemeRelationship(
        canvas_id=c.id, source_theme_id=t1.id, target_theme_id=t2.id,
        relationship_type="extends",
    )
    db_session.add(rel)
    db_session.flush()
    rel_id = rel.id

    delete_canvas(db_session, c)
    db_session.flush()

    assert db_session.query(CanvasThemeRelationship).filter(CanvasThemeRelationship.id == rel_id).first() is None


def test_theme_parent_set_null_on_delete(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    parent = _create_theme(db_session, c.id, "Parent")
    child = CanvasTheme(
        canvas_id=c.id, name="Child",
        doc_order=200, table_column_order=200,
        parent_theme_id=parent.id,
    )
    db_session.add(child)
    db_session.flush()
    child_id = child.id

    db_session.delete(parent)
    db_session.flush()

    child_after = db_session.query(CanvasTheme).filter(CanvasTheme.id == child_id).first()
    assert child_after is not None
    assert child_after.parent_theme_id is None


def test_update_theme_set_parent(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    parent = _create_theme(db_session, c.id, "Parent")
    child = _create_theme(db_session, c.id, "Child")
    update_theme(db_session, child, {"parent_theme_id": parent.id})
    assert child.parent_theme_id == parent.id
    resp = build_theme_response(child)
    assert resp["parent_theme_id"] == parent.id


def test_update_theme_clear_parent(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    parent = _create_theme(db_session, c.id, "Parent")
    child = _create_theme(db_session, c.id, "Child")
    update_theme(db_session, child, {"parent_theme_id": parent.id})
    assert child.parent_theme_id == parent.id
    update_theme(db_session, child, {"parent_theme_id": None})
    assert child.parent_theme_id is None


def test_build_theme_response_includes_parent(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    theme = _create_theme(db_session, c.id, "Theme")
    resp = build_theme_response(theme)
    assert "parent_theme_id" in resp
    assert resp["parent_theme_id"] is None


def test_update_theme_self_reference_rejected(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    theme = _create_theme(db_session, c.id, "Theme")
    with pytest.raises(ValueError, match="its own parent"):
        update_theme(db_session, theme, {"parent_theme_id": theme.id})


def test_update_theme_cross_canvas_parent_rejected(db_session):
    p = _create_project(db_session)
    c1 = _create_canvas(db_session, p.id)
    c2 = create_canvas(db_session, p.id, "Canvas 2")
    t1 = _create_theme(db_session, c1.id, "Theme in C1")
    t2 = _create_theme(db_session, c2.id, "Theme in C2")
    with pytest.raises(ValueError, match="not found in this canvas"):
        update_theme(db_session, t1, {"parent_theme_id": t2.id})


def test_update_theme_circular_nesting_rejected(db_session):
    """A→B nesting, then trying B→A should fail — B is already nested (one-level check)."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    a = _create_theme(db_session, c.id, "A")
    b = _create_theme(db_session, c.id, "B")
    update_theme(db_session, b, {"parent_theme_id": a.id})
    assert b.parent_theme_id == a.id
    # B already has a parent, so nesting A under B would require two levels
    with pytest.raises(ValueError, match="one level"):
        update_theme(db_session, a, {"parent_theme_id": b.id})


# ── Audit ───────────────────────────────────────────────────────────────────


def test_canvas_create_audit(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id, "Audited")
    log_action(
        db_session, action="canvas_create", entity_type="canvas",
        entity_id=c.id, project_id=p.id, details={"name": c.name},
    )
    db_session.flush()

    trail = get_audit_trail(db_session, project_id=p.id)
    assert len(trail) >= 1
    assert trail[0].action == "canvas_create"
    assert trail[0].entity_type == "canvas"


def test_theme_delete_audit(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = _create_theme(db_session, c.id, "T")
    theme_id = t.id

    delete_theme(db_session, t)
    log_action(
        db_session, action="canvas_theme_delete", entity_type="canvas_theme",
        entity_id=theme_id, project_id=p.id,
    )
    db_session.flush()

    trail = get_audit_trail(db_session, project_id=p.id)
    assert any(e.action == "canvas_theme_delete" for e in trail)


# ── Theme Relationships ─────────────────────────────────────────────────────


def test_create_theme_relationship(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = _create_theme(db_session, c.id, "T1")
    t2 = _create_theme(db_session, c.id, "T2")

    rel = create_theme_relationship(db_session, c.id, t1.id, t2.id, "confirms", label="Strong link")
    assert rel.source_theme_id == t1.id
    assert rel.target_theme_id == t2.id
    assert rel.relationship_type == "confirms"
    assert rel.label == "Strong link"


def test_update_theme_relationship(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = _create_theme(db_session, c.id, "T1")
    t2 = _create_theme(db_session, c.id, "T2")
    rel = create_theme_relationship(db_session, c.id, t1.id, t2.id, "confirms")

    update_theme_relationship(db_session, rel, {"relationship_type": "contradicts", "weight": 3})
    assert rel.relationship_type == "contradicts"
    assert rel.weight == 3


def test_delete_theme_relationship(db_session):
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = _create_theme(db_session, c.id, "T1")
    t2 = _create_theme(db_session, c.id, "T2")
    rel = create_theme_relationship(db_session, c.id, t1.id, t2.id, "extends")
    rel_id = rel.id

    delete_theme_relationship(db_session, rel)
    db_session.flush()

    assert db_session.query(CanvasThemeRelationship).filter(CanvasThemeRelationship.id == rel_id).first() is None


def test_self_reference_rejected(db_session):
    """A theme cannot have a relationship with itself."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t = _create_theme(db_session, c.id, "T")

    with pytest.raises(ValueError, match="cannot have a relationship with itself"):
        create_theme_relationship(db_session, c.id, t.id, t.id, "confirms")


# ── Memo entity_type ────────────────────────────────────────────────────────


def test_memo_canvas_entity_type_accepted(db_session):
    """The memo schema should accept 'canvas' as an entity_type."""
    from app.schemas.memo import MemoCreate
    memo = MemoCreate(entity_type="canvas", entity_id=1, content="Test")
    assert memo.entity_type == "canvas"


def test_memo_schema_validates_entity_type(db_session):
    """Invalid entity_type should be rejected."""
    from app.schemas.memo import MemoCreate
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MemoCreate(entity_type="invalid_type", entity_id=1)


# ── Project Portability ─────────────────────────────────────────────────────


def test_canvas_in_export(db_session):
    """Canvas entities should be included in project export data."""
    from app.services.project_portability import _serialize_all, _get_columns

    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id, "Export Canvas")
    t = _create_theme(db_session, c.id, "Theme")
    db_session.flush()

    # Verify serialization works
    canvas_cols = _get_columns(Canvas)
    canvas_data = _serialize_all([c], canvas_cols)
    assert len(canvas_data) == 1
    assert canvas_data[0]["name"] == "Export Canvas"

    theme_cols = _get_columns(CanvasTheme)
    theme_data = _serialize_all([t], theme_cols)
    assert len(theme_data) == 1


def test_canvas_import_with_id_remapping(db_session):
    """Canvas import should remap all IDs correctly."""
    from app.services.project_portability import _build_entity, _remap_id

    p = _create_project(db_session)
    remap = {
        "canvases": {100: None},
        "canvas_themes": {},
        "canvas_blocks": {},
        "materials": {},
        "excerpts": {},
        "memos": {},
        "notes": {},
        "codes": {},
        "code_categories": {},
        "metric_definitions": {},
    }

    # Create a canvas and track its remap
    new_canvas = Canvas(project_id=p.id, name="Imported", display_order=1)
    db_session.add(new_canvas)
    db_session.flush()
    remap["canvases"][100] = new_canvas.id

    # Create theme with remapped canvas_id
    new_theme = CanvasTheme(
        canvas_id=remap["canvases"][100], name="Imported Theme",
        doc_order=100, table_column_order=100,
    )
    db_session.add(new_theme)
    db_session.flush()
    remap["canvas_themes"][200] = new_theme.id

    # Verify the remap
    assert remap["canvases"][100] == new_canvas.id
    assert remap["canvas_themes"][200] == new_theme.id

    # Verify theme is linked to canvas
    themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == new_canvas.id).all()
    assert len(themes) == 1
    assert themes[0].name == "Imported Theme"


def test_canvas_memo_portability(db_session):
    """Canvas memos should be exported and importable via MEMO_ENTITY_REMAP."""
    from app.services.project_portability import MEMO_ENTITY_REMAP

    assert "canvas" in MEMO_ENTITY_REMAP
    assert MEMO_ENTITY_REMAP["canvas"] == "canvases"


# ── Schema Validation ───────────────────────────────────────────────────────


def test_theme_relationship_create_schema(db_session):
    from app.schemas.canvas import ThemeRelationshipCreate
    rc = ThemeRelationshipCreate(
        source_theme_id=1, target_theme_id=2,
        relationship_type="confirms", label="Test",
    )
    assert rc.weight == 1
    assert rc.is_bidirectional is False


# ── All Elements Endpoint ──────────────────────────────────────────────────


def test_all_materials_endpoint(db_session):
    """The all-materials helper returns materials across collections."""
    from app.models.materials import MaterialCollection, Material

    p = _create_project(db_session)

    col1 = MaterialCollection(project_id=p.id, name="Col 1", display_order=1)
    col2 = MaterialCollection(project_id=p.id, name="Col 2", display_order=2)
    db_session.add_all([col1, col2])
    db_session.flush()

    e1 = Material(collection_id=col1.id, material_type="chart", config='{}', auto_name="E1", display_order=1, source_tab="quantitative")
    e2 = Material(collection_id=col1.id, material_type="chart", config='{}', auto_name="E2", display_order=2, source_tab="quantitative")
    e3 = Material(collection_id=col2.id, material_type="chart", config='{}', auto_name="E3", display_order=1, source_tab="qualitative")
    db_session.add_all([e1, e2, e3])
    db_session.commit()

    # Query via the same pattern as the endpoint
    elements = (
        db_session.query(Material)
        .join(MaterialCollection, Material.collection_id == MaterialCollection.id)
        .filter(MaterialCollection.project_id == p.id)
        .order_by(MaterialCollection.display_order.asc(), Material.display_order.asc())
        .all()
    )

    assert len(elements) == 3
    assert elements[0].auto_name == "E1"
    assert elements[1].auto_name == "E2"
    assert elements[2].auto_name == "E3"


# ── Canvas rebuild tests ────────���──────────────────────────────────────────


def test_canvas_introduction_crud(db_session):
    """Introduction field: create, update, read."""
    from app.services.canvas import create_canvas, update_canvas, get_canvas_full

    p = _create_project(db_session)

    c = create_canvas(db_session, p.id)
    assert c.introduction is None

    tiptap_json = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hello world"}]}]}
    update_canvas(db_session, c, introduction=json.dumps(tiptap_json))
    db_session.flush()

    assert c.introduction is not None
    parsed = json.loads(c.introduction)
    assert parsed["type"] == "doc"
    assert parsed["content"][0]["content"][0]["text"] == "Hello world"


def test_canvas_introduction_duplicate(db_session):
    """Duplicate copies introduction."""
    from app.services.canvas import create_canvas, update_canvas, duplicate_canvas

    p = _create_project(db_session)

    c = create_canvas(db_session, p.id, "Original")
    update_canvas(db_session, c, introduction=json.dumps({"type": "doc", "content": []}))
    db_session.flush()

    dup = duplicate_canvas(db_session, p.id, c)
    assert dup.introduction is not None
    assert json.loads(dup.introduction)["type"] == "doc"


def test_theme_viz_xy(db_session):
    """Theme spatial positioning fields."""
    from app.services.canvas import create_canvas, create_theme, update_theme

    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)

    theme = create_theme(db_session, c.id, "Test", viz_x=100.5, viz_y=200.0)
    assert theme.viz_x == 100.5
    assert theme.viz_y == 200.0

    update_theme(db_session, theme, {"viz_x": 300.0, "viz_y": None})
    assert theme.viz_x == 300.0
    assert theme.viz_y is None


def test_theme_color_auto_assignment(db_session):
    """Themes get sequential auto-colors from THEME_AUTO_COLORS."""
    from app.services.canvas import create_canvas, create_theme, THEME_AUTO_COLORS

    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)

    t1 = create_theme(db_session, c.id, "T1")
    t2 = create_theme(db_session, c.id, "T2")
    t3 = create_theme(db_session, c.id, "T3")

    assert t1.color == THEME_AUTO_COLORS[0]
    assert t2.color == THEME_AUTO_COLORS[1]
    assert t3.color == THEME_AUTO_COLORS[2]

    # Explicit color overrides auto-assignment
    t4 = create_theme(db_session, c.id, "T4", color="#aabbcc")
    assert t4.color == "#aabbcc"


def test_relationship_line_style_color(db_session):
    """Relationship line_style and line_color fields."""
    from app.services.canvas import (
        create_canvas, create_theme, create_theme_relationship,
        update_theme_relationship,
    )

    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t1 = create_theme(db_session, c.id, "A")
    t2 = create_theme(db_session, c.id, "B")

    rel = create_theme_relationship(
        db_session, c.id, t1.id, t2.id, "confirms",
        line_style="dashed", line_color="#ef4444",
    )
    assert rel.line_style == "dashed"
    assert rel.line_color == "#ef4444"

    update_theme_relationship(db_session, rel, {"line_style": "dotted", "line_color": "#22c55e"})
    assert rel.line_style == "dotted"
    assert rel.line_color == "#22c55e"


def test_duplicate_canvas_copies_spatial_and_parent(db_session):
    """Duplicate copies viz_x, viz_y, parent_theme_id, line_style, line_color."""
    from app.services.canvas import (
        create_canvas, create_theme, create_theme_relationship,
        duplicate_canvas,
    )

    p = _create_project(db_session)
    c = create_canvas(db_session, p.id, "Orig")

    parent = create_theme(db_session, c.id, "Parent", viz_x=10.0, viz_y=20.0)
    child = create_theme(db_session, c.id, "Child", viz_x=30.0, viz_y=40.0)
    child.parent_theme_id = parent.id
    db_session.flush()

    rel = create_theme_relationship(
        db_session, c.id, parent.id, child.id, "contains",
        line_style="solid", line_color="#3b82f6",
    )

    dup = duplicate_canvas(db_session, p.id, c)

    dup_themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == dup.id).order_by(CanvasTheme.doc_order).all()
    assert len(dup_themes) == 2
    assert dup_themes[0].viz_x == 10.0
    assert dup_themes[0].viz_y == 20.0
    assert dup_themes[1].viz_x == 30.0
    assert dup_themes[1].parent_theme_id == dup_themes[0].id  # remapped

    dup_rels = db_session.query(CanvasThemeRelationship).filter(CanvasThemeRelationship.canvas_id == dup.id).all()
    assert len(dup_rels) == 1
    assert dup_rels[0].line_style == "solid"
    assert dup_rels[0].line_color == "#3b82f6"


# ══════════════════════════════════════════════════════════════════════════════
# Prose Content (Batch A) — Tiptap utilities, theme content, pending items
# ══════════════════════════════════════════════════════════════════════════════


# ── walk_tiptap_nodes ──────────────────────────────────────────────────────


def test_walk_tiptap_nodes_finds_matching_types(db_session):
    doc = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "hello"}]},
            {"type": "excerpt-embed", "attrs": {"excerptId": 1}},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "world"},
                {"type": "memo-embed", "attrs": {"memoId": 5}},
            ]},
        ],
    }
    found = []
    walk_tiptap_nodes(doc, {"excerpt-embed", "memo-embed"}, lambda n: found.append(n["type"]))
    assert found == ["excerpt-embed", "memo-embed"]


def test_walk_tiptap_nodes_handles_none(db_session):
    """None input does not crash."""
    walk_tiptap_nodes(None, {"excerpt-embed"}, lambda n: None)


# ── extract_theme_searchable_text ──────────────────────────────────────────


def test_extract_theme_searchable_text_mixed_content(db_session):
    doc = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Introduction paragraph"}]},
            {"type": "excerpt-embed", "attrs": {"excerptId": 1, "displayText": "participant said X"}},
            {"type": "chart-embed", "attrs": {"materialId": 2, "title": "Response Rates"}},
            {"type": "memo-embed", "attrs": {"memoId": 3, "title": "Reflective note", "preview": "I noticed..."}},
            {"type": "callout-stat", "attrs": {"value": "85%", "label": "completion rate"}},
        ],
    }
    text = extract_theme_searchable_text(doc)
    assert "Introduction paragraph" in text
    assert "participant said X" in text
    assert "Response Rates" in text
    assert "Reflective note" in text
    assert "I noticed" in text
    assert "85%" in text
    assert "completion rate" in text


def test_extract_theme_searchable_text_empty_doc(db_session):
    assert extract_theme_searchable_text(None) is None
    assert extract_theme_searchable_text({}) is None


# ── extract_referenced_source_ids ──────────────────────────────────────────


def test_extract_referenced_source_ids_collects_all_types(db_session):
    doc = {
        "type": "doc",
        "content": [
            {"type": "excerpt-embed", "attrs": {"excerptId": 10}},
            {"type": "chart-embed", "attrs": {"materialId": 20}},
            {"type": "memo-embed", "attrs": {"memoId": 30}},
            {"type": "paragraph", "content": [{"type": "text", "text": "prose"}]},
        ],
    }
    refs = extract_referenced_source_ids(doc)
    assert refs == [
        {"type": "excerpt", "id": 10},
        {"type": "material", "id": 20},
        {"type": "memo", "id": 30},
    ]


def test_extract_referenced_source_ids_empty_doc(db_session):
    assert extract_referenced_source_ids(None) is None
    assert extract_referenced_source_ids({"type": "doc", "content": []}) is None


# ── update_theme_content ───────────────────────────────────────────────────


def test_update_theme_content_stores_tiptap_json(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")

    tiptap_doc = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hello world"}]}],
    }
    update_theme_content(db_session, t, tiptap_doc)

    assert t.content is not None
    parsed = json.loads(t.content)
    assert parsed["type"] == "doc"
    assert t.searchable_text == "hello world"


def test_update_theme_content_rebuilds_referenced_source_ids(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")

    tiptap_doc = {
        "type": "doc",
        "content": [
            {"type": "excerpt-embed", "attrs": {"excerptId": 10, "displayText": "q"}},
            {"type": "chart-embed", "attrs": {"materialId": 20, "title": "c"}},
        ],
    }
    update_theme_content(db_session, t, tiptap_doc)

    refs = json.loads(t.referenced_source_ids)
    assert refs == [{"type": "excerpt", "id": 10}, {"type": "material", "id": 20}]


def test_update_theme_content_null_clears_fields(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")

    # First set content
    update_theme_content(db_session, t, {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x"}]}]})
    assert t.content is not None
    assert t.searchable_text is not None

    # Then clear
    update_theme_content(db_session, t, None)
    assert t.content is None
    assert t.searchable_text is None
    assert t.referenced_source_ids is None


def test_theme_update_with_content_field(db_session):
    """update_theme() with content in update_data saves Tiptap JSON."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")

    tiptap_doc = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "via update"}]}]}
    update_theme(db_session, t, {"content": tiptap_doc})

    assert t.searchable_text == "via update"


# ── build_theme_response ───────────────────────────────────────────────────


def test_build_theme_response_includes_content(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")

    tiptap_doc = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}]}
    update_theme_content(db_session, t, tiptap_doc)

    resp = build_theme_response(t)
    assert resp["content"] is not None
    assert resp["content"]["type"] == "doc"
    assert resp["searchable_text"] == "hi"


def test_build_theme_response_handles_null_content(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")

    resp = build_theme_response(t)
    assert resp["content"] is None
    assert resp["searchable_text"] is None
    assert resp["referenced_source_ids"] is None


# ── Pending Items ──────────────────────────────────────────────────────────


def test_add_pending_item_creates_row(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)

    item = add_pending_item(db_session, c.id, "excerpt", 42)
    assert item.id is not None
    assert item.canvas_id == c.id
    assert item.item_type == "excerpt"
    assert item.source_id == 42
    assert item.created_at is not None


def test_remove_pending_item_deletes_row(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)

    item = add_pending_item(db_session, c.id, "memo", 7)
    item_id = item.id
    remove_pending_item(db_session, item)

    assert db_session.get(CanvasPendingItem, item_id) is None


def test_list_pending_items_returns_ordered_by_created_at(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)

    i1 = add_pending_item(db_session, c.id, "excerpt", 1)
    i2 = add_pending_item(db_session, c.id, "material", 2)
    i3 = add_pending_item(db_session, c.id, "memo", 3)

    items = list_pending_items(db_session, c.id)
    assert [i.id for i in items] == [i1.id, i2.id, i3.id]


def test_pending_item_cascade_on_canvas_delete(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    add_pending_item(db_session, c.id, "excerpt", 1)
    add_pending_item(db_session, c.id, "memo", 2)

    delete_canvas(db_session, c)
    assert db_session.query(CanvasPendingItem).count() == 0


def test_canvas_detail_includes_pending_items(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    add_pending_item(db_session, c.id, "excerpt", 99)

    full = get_canvas_full(db_session, p.id, c.id)
    assert full is not None
    assert len(full.pending_items) == 1
    assert full.pending_items[0].source_id == 99


# ── create_theme with after_theme_id ───────────────────────────────────────


def test_create_theme_after_theme_id_midpoint(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t1 = create_theme(db_session, c.id, "A")  # doc_order 100
    t2 = create_theme(db_session, c.id, "B")  # doc_order 200

    t3 = create_theme(db_session, c.id, "C", after_theme_id=t1.id)
    assert t3.doc_order == 150  # midpoint of 100 and 200


def test_create_theme_after_last_theme(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t1 = create_theme(db_session, c.id, "A")  # doc_order 100

    t2 = create_theme(db_session, c.id, "B", after_theme_id=t1.id)
    # No next theme, so B = A + 200 = 300, midpoint = (100 + 300) // 2 = 200
    assert t2.doc_order == 200


def test_create_theme_after_invalid_theme_id(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)

    with pytest.raises(ValueError, match="not found"):
        create_theme(db_session, c.id, "X", after_theme_id=9999)


def test_create_theme_after_theme_id_gap_too_small(db_session):
    """When gap < 2, recompute_theme_doc_orders is called to re-gap."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t1 = create_theme(db_session, c.id, "A")
    t2 = create_theme(db_session, c.id, "B")

    # Manually set adjacent doc_orders with gap=1
    t1.doc_order = 100
    t2.doc_order = 101
    db_session.flush()

    t3 = create_theme(db_session, c.id, "C", after_theme_id=t1.id)
    # After re-gap, all three themes get clean 100-spacing
    db_session.refresh(t1)
    db_session.refresh(t2)
    db_session.refresh(t3)
    orders = sorted([t1.doc_order, t2.doc_order, t3.doc_order])
    # Should be nicely spaced (100, 200, 300)
    assert orders == [100, 200, 300]


# ── Duplication with prose content + pending items ─────────────────────────


def test_duplicate_canvas_copies_theme_content(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "T1")
    tiptap_doc = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "prose"}]}]}
    update_theme_content(db_session, t, tiptap_doc)

    dup = duplicate_canvas(db_session, p.id, c)
    dup_themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == dup.id).all()
    assert len(dup_themes) == 1
    assert dup_themes[0].content is not None
    parsed = json.loads(dup_themes[0].content)
    assert parsed["type"] == "doc"
    assert dup_themes[0].searchable_text == "prose"


def test_duplicate_canvas_copies_pending_items(db_session):
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    add_pending_item(db_session, c.id, "excerpt", 10)
    add_pending_item(db_session, c.id, "memo", 20)

    dup = duplicate_canvas(db_session, p.id, c)
    dup_items = db_session.query(CanvasPendingItem).filter(CanvasPendingItem.canvas_id == dup.id).all()
    assert len(dup_items) == 2
    types = {i.item_type for i in dup_items}
    assert types == {"excerpt", "memo"}


# ══════════════════════════════════════════════════════════════════════════════
# Prose Sections (section_type)
# ══════════════════════════════════════════════════════════════════════════════


def test_create_prose_section(db_session):
    """Prose sections are created with section_type='prose' and no auto-color."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "Introduction", section_type="prose")
    assert t.section_type == "prose"
    assert t.color is None  # No auto-color for prose sections


def test_create_theme_default_section_type(db_session):
    """Themes default to section_type='theme' with auto-color."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "Theme A")
    assert t.section_type == "theme"
    assert t.color is not None


def test_prose_section_in_build_response(db_session):
    """build_theme_response includes section_type."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    t = create_theme(db_session, c.id, "Refs", section_type="prose")
    resp = build_theme_response(t)
    assert resp["section_type"] == "prose"
    assert resp["color"] is None


def test_duplicate_canvas_copies_section_type(db_session):
    """Duplicate canvas preserves section_type on themes."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    create_theme(db_session, c.id, "Intro", section_type="prose")
    create_theme(db_session, c.id, "Theme A")

    dup = duplicate_canvas(db_session, p.id, c)
    dup_themes = (
        db_session.query(CanvasTheme)
        .filter(CanvasTheme.canvas_id == dup.id)
        .order_by(CanvasTheme.doc_order)
        .all()
    )
    assert len(dup_themes) == 2
    assert dup_themes[0].section_type == "prose"
    assert dup_themes[1].section_type == "theme"


def test_convert_prose_to_theme(db_session):
    """Converting prose → theme auto-assigns color."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    section = create_theme(db_session, c.id, "Intro", section_type="prose")
    assert section.color is None
    assert section.section_type == "prose"

    updated = update_theme(db_session, section, {"section_type": "theme"})
    assert updated.section_type == "theme"
    assert updated.color is not None  # auto-color assigned


def test_convert_theme_to_prose(db_session):
    """Converting theme → prose strips color."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    theme = create_theme(db_session, c.id, "Finding A")
    assert theme.color is not None

    updated = update_theme(db_session, theme, {"section_type": "prose"})
    assert updated.section_type == "prose"
    assert updated.color is None


def test_convert_noop_same_type(db_session):
    """Converting to same type is a no-op (no color change)."""
    p = _create_project(db_session)
    c = create_canvas(db_session, p.id)
    theme = create_theme(db_session, c.id, "Finding A")
    original_color = theme.color

    updated = update_theme(db_session, theme, {"section_type": "theme"})
    assert updated.color == original_color


# ── Archiving ──────────────────────────────────────────────────────────────


def test_archive_canvas(db_session):
    """Archiving sets is_archived; list_canvases hides archived by default."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id, "Archive Me")
    assert c.is_archived is False

    # Archive via update
    update_canvas(db_session, c, is_archived=True)
    assert c.is_archived is True

    # Default list excludes archived
    items = list_canvases(db_session, p.id)
    assert len(items) == 0

    # Include archived
    items = list_canvases(db_session, p.id, include_archived=True)
    assert len(items) == 1
    assert items[0]["is_archived"] is True


def test_unarchive_canvas(db_session):
    """Un-archiving restores canvas to default list."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    update_canvas(db_session, c, is_archived=True)
    assert list_canvases(db_session, p.id) == []

    update_canvas(db_session, c, is_archived=False)
    items = list_canvases(db_session, p.id)
    assert len(items) == 1
    assert items[0]["is_archived"] is False


def test_permanent_delete_canvas(db_session):
    """Permanent delete removes canvas from DB entirely."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    canvas_id = c.id
    delete_canvas(db_session, c)
    assert db_session.query(Canvas).filter(Canvas.id == canvas_id).first() is None


def test_archive_preserves_children(db_session):
    """Archiving canvas preserves themes and relationships (no cascade delete)."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = create_theme(db_session, c.id, "T1")
    t2 = create_theme(db_session, c.id, "T2")
    create_theme_relationship(db_session, c.id, t1.id, t2.id, "confirms")

    update_canvas(db_session, c, is_archived=True)
    db_session.flush()

    # Children still exist
    themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == c.id).all()
    assert len(themes) == 2
    rels = db_session.query(CanvasThemeRelationship).filter(
        CanvasThemeRelationship.canvas_id == c.id
    ).all()
    assert len(rels) == 1


# ── Snapshots ──────────────────────────────────────────────────────────────


def test_create_snapshot(db_session):
    """Snapshot serializes themes, relationships, and introduction."""
    import json
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    c.introduction = '{"type":"doc","content":[]}'
    db_session.flush()
    t1 = create_theme(db_session, c.id, "T1")
    t2 = create_theme(db_session, c.id, "T2")
    create_theme_relationship(db_session, c.id, t1.id, t2.id, "confirms")

    snap = create_snapshot(db_session, c.id, "v1")
    assert snap.name == "v1"
    assert snap.theme_count == 2
    data = json.loads(snap.snapshot_data)
    assert data["format_version"] == 1
    assert data["introduction"] == '{"type":"doc","content":[]}'
    assert len(data["themes"]) == 2
    assert len(data["relationships"]) == 1
    assert data["relationships"][0]["relationship_type"] == "confirms"


def test_list_snapshots(db_session):
    """Snapshots are listed newest-first."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    s1 = create_snapshot(db_session, c.id, "first")
    s2 = create_snapshot(db_session, c.id, "second")

    result = list_snapshots(db_session, c.id)
    assert len(result) == 2
    assert result[0].name == "second"
    assert result[1].name == "first"


def test_restore_snapshot(db_session):
    """Restoring a snapshot recreates original themes and relationships."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    t1 = create_theme(db_session, c.id, "Original A")
    t2 = create_theme(db_session, c.id, "Original B")
    create_theme_relationship(db_session, c.id, t1.id, t2.id, "extends")

    snap = create_snapshot(db_session, c.id, "before changes")

    # Modify canvas
    delete_theme(db_session, t1)
    delete_theme(db_session, t2)
    create_theme(db_session, c.id, "New Theme")
    db_session.flush()

    # Verify modified state
    themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == c.id).all()
    assert len(themes) == 1
    assert themes[0].name == "New Theme"

    # Restore
    restore_snapshot(db_session, c, snap)

    # Verify restored state (new IDs, same data)
    themes = db_session.query(CanvasTheme).filter(CanvasTheme.canvas_id == c.id).all()
    assert len(themes) == 2
    names = {t.name for t in themes}
    assert names == {"Original A", "Original B"}

    rels = db_session.query(CanvasThemeRelationship).filter(
        CanvasThemeRelationship.canvas_id == c.id
    ).all()
    assert len(rels) == 1
    assert rels[0].relationship_type == "extends"


def test_restore_creates_pre_restore(db_session):
    """Restoring auto-creates a pre-restore snapshot."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)
    create_theme(db_session, c.id, "T")

    snap = create_snapshot(db_session, c.id, "v1")
    restore_snapshot(db_session, c, snap)

    snapshots = list_snapshots(db_session, c.id)
    pre_restore = [s for s in snapshots if s.name.startswith("Pre-restore")]
    assert len(pre_restore) == 1


def test_snapshot_rotation(db_session):
    """Only 10 snapshots are kept; oldest is deleted when limit exceeded."""
    p = _create_project(db_session)
    c = _create_canvas(db_session, p.id)

    for i in range(11):
        create_snapshot(db_session, c.id, f"snap-{i}")

    snapshots = list_snapshots(db_session, c.id)
    assert len(snapshots) == 10
    names = [s.name for s in snapshots]
    assert "snap-0" not in names  # oldest was rotated out
    assert "snap-10" in names
