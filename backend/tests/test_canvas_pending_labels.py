"""#823(j) — the canvas inbox names what it holds, instead of printing a row id.

The Writing view's Unsorted section rendered `"Chart #5"` — a type word and a
raw primary key — while the Materials drawer two panels away showed the real
name. That is what made the inbox read as broken rather than unimplemented.

The client cannot derive this: `source_id` is polymorphic across three
different entities, so a client-side lookup needs three queries all loaded and
still shows the id until they land. Same argument as #749's `participant_count`
— the server states what the payload's consumer cannot compute.
"""
from app.models.project import Project
from app.models.canvas import Canvas, CanvasPendingItem
from app.models.materials import Material, MaterialCollection
from app.models.memo import Memo
from app.routers.canvas import _build_pending_items_list, _pending_item_labels


def _seed(db):
    p = Project(id=870, name="P", user_id=1); db.add(p); db.flush()
    canvas = Canvas(id=870, project_id=870, name="C"); db.add(canvas); db.flush()
    coll = MaterialCollection(id=870, project_id=870, name="Coll"); db.add(coll); db.flush()
    return canvas, coll


def _item(item_type, source_id):
    return CanvasPendingItem(canvas_id=870, item_type=item_type, source_id=source_id)


def test_a_material_is_named_by_its_custom_name(db_session):
    _canvas, coll = _seed(db_session)
    m = Material(
        collection_id=coll.id, material_type="histogram", config="{}",
        auto_name="Freq Dist · GSS", custom_name="Trust by education",
    )
    db_session.add(m); db_session.flush()

    labels = _pending_item_labels(db_session, [_item("material", m.id)])
    # The drawer's own precedence — custom over auto — or the inbox and the
    # drawer would name the same material two different things.
    assert labels[("material", m.id)] == "Trust by education"


def test_a_material_falls_back_to_its_auto_name(db_session):
    _canvas, coll = _seed(db_session)
    m = Material(
        collection_id=coll.id, material_type="histogram", config="{}",
        auto_name="Freq Dist · GSS", custom_name=None,
    )
    db_session.add(m); db_session.flush()
    labels = _pending_item_labels(db_session, [_item("material", m.id)])
    assert labels[("material", m.id)] == "Freq Dist · GSS"


def test_a_memo_is_named_by_its_title(db_session):
    _seed(db_session)
    memo = Memo(project_id=870, numeric_id=1, entity_type="project", entity_id=870,
                title="Why fidelity varies", content="…")
    db_session.add(memo); db_session.flush()
    labels = _pending_item_labels(db_session, [_item("memo", memo.id)])
    assert labels[("memo", memo.id)] == "Why fidelity varies"


def test_a_missing_source_row_yields_no_label_rather_than_a_wrong_one(db_session):
    """The id fallback on the client is for exactly this."""
    _seed(db_session)
    labels = _pending_item_labels(db_session, [_item("material", 999999)])
    assert ("material", 999999) not in labels


def test_one_query_per_TYPE_not_one_per_item(db_session):
    """An inbox of N items must not become N queries on the canvas's own load."""
    _canvas, coll = _seed(db_session)
    made = []
    for i in range(5):
        m = Material(collection_id=coll.id, material_type="histogram", config="{}",
                     auto_name=f"Chart {i}", custom_name=None)
        db_session.add(m); made.append(m)
    db_session.flush()

    seen: list[str] = []
    from sqlalchemy import event
    engine = db_session.get_bind()

    def _count(conn, cursor, statement, params, context, executemany):
        if "FROM materials" in statement:
            seen.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        labels = _pending_item_labels(db_session, [_item("material", m.id) for m in made])
    finally:
        event.remove(engine, "before_cursor_execute", _count)

    assert len(labels) == 5
    # Assert the ARITY, not merely that it worked — a per-item loop returns the
    # same five labels.
    assert len(seen) == 1, f"expected one grouped query, got {len(seen)}"


def test_the_label_actually_REACHES_the_payload(db_session):
    """🔴 The WIRING test, and it is the one that bites.

    Every test above calls `_pending_item_labels` directly, so all five stayed
    green when `_build_pending_items_list` was mutated to ignore it entirely —
    the resolver worked and nothing consumed it. That is the #747/#714/#757
    shape: *a fix that inserts a call into a pipeline needs a test that enters
    at the pipeline's MOUTH.* Mutation-verified in both directions.
    """
    canvas, coll = _seed(db_session)
    m = Material(collection_id=coll.id, material_type="histogram", config="{}",
                 auto_name="Freq Dist · GSS", custom_name="Trust by education")
    db_session.add(m); db_session.flush()
    db_session.add(_item("material", m.id)); db_session.flush()
    db_session.refresh(canvas)

    items = _build_pending_items_list(canvas, db_session)
    assert len(items) == 1
    assert items[0].source_label == "Trust by education"


def test_the_payload_degrades_rather_than_raising_without_a_session(db_session):
    """`db=None` is the pre-existing call shape; it must still build a list."""
    canvas, coll = _seed(db_session)
    m = Material(collection_id=coll.id, material_type="histogram", config="{}",
                 auto_name="A", custom_name=None)
    db_session.add(m); db_session.flush()
    db_session.add(_item("material", m.id)); db_session.flush()
    db_session.refresh(canvas)

    items = _build_pending_items_list(canvas)
    assert items[0].source_label is None
