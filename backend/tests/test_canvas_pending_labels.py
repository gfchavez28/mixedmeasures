"""#823(j) — the canvas inbox names what it holds, instead of printing a row id.

The Writing view's Unsorted section rendered `"Chart #5"` — a type word and a
raw primary key — while the Materials drawer two panels away showed the real
name. That is what made the inbox read as broken rather than unimplemented.

The client cannot derive this: `source_id` is polymorphic across three
different entities, so a client-side lookup needs three queries all loaded and
still shows the id until they land. Same argument as #749's `participant_count`
— the server states what the payload's consumer cannot compute.
"""
import re
from pathlib import Path

from sqlalchemy import event

from app.models.project import Project
from app.models.canvas import Canvas, CanvasPendingItem
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.materials import Material, MaterialCollection
from app.models.memo import Memo
from app.models.observation import Observation
from app.models.segment import Segment
from app.models.user import User
from app.routers.canvas import (
    _build_pending_items_list, _pending_item_labels, get_canvas_endpoint,
)

#: The client's pending-item vocabulary — the one place it is written down
#: (`item_type` is a free string on the server).
WRITING_CANVAS = (
    Path(__file__).resolve().parents[2] / "frontend/src/components/canvas/WritingCanvas.tsx"
)


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


# ── #1316: a quote in the inbox ──────────────────────────────────────────────
# The labeller queried `Excerpt.excerpt_text`, a response-schema field, not a
# column, so a canvas holding a quote in its inbox 500'd on open, save,
# duplicate and snapshot restore — and no test here held an excerpt.

def _seed_quotes(db):
    """One excerpt of each shape the inbox can hold."""
    canvas, _coll = _seed(db)
    db.add_all([
        Conversation(id=870, project_id=870, name="Interview"),
        Observation(id=870, project_id=870, name="Playground"),
        Dataset(id=870, project_id=870, name="Survey"),
    ])
    db.flush()
    db.add_all([
        DatasetColumn(id=870, dataset_id=870, column_code="Q1", column_name="Comments",
                      column_text="Any comments?", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=870, dataset_id=870),
    ])
    db.flush()
    db.add(DatasetValue(id=870, row_id=870, column_id=870, value_text="  the bus was late  "))
    db.add_all([
        Segment(id=87001, conversation_id=870, sequence_order=0,
                text="It was not helpful at all."),
        Segment(id=87002, conversation_id=870, sequence_order=1, text="x" * 100),
        Segment(id=87003, observation_id=870, sequence_order=0, text="",
                start_time=1.0, end_time=2.0),
    ])
    db.flush()
    db.add_all([
        Excerpt(id=87001, project_id=870, segment_id=87001, start_offset=7, end_offset=18),
        Excerpt(id=87002, project_id=870, segment_id=87001),
        Excerpt(id=87003, project_id=870, segment_id=87002),
        Excerpt(id=87004, project_id=870, segment_id=87003, start_time=1.2, end_time=1.8),
        Excerpt(id=87005, project_id=870, dataset_value_id=870),
    ])
    db.flush()
    return canvas


def test_each_excerpt_shape_is_named_by_the_text_it_quotes(db_session):
    _seed_quotes(db_session)
    labels = _pending_item_labels(
        db_session, [_item("excerpt", i) for i in range(87001, 87006)]
    )
    assert labels[("excerpt", 87001)] == "not helpful"  # a char range: its slice
    assert labels[("excerpt", 87002)] == "It was not helpful at all."  # whole turn
    assert labels[("excerpt", 87003)] == "x" * 80 + "…"  # cut at 80
    assert ("excerpt", 87004) not in labels  # an unlabelled clip: the client's id fallback
    assert labels[("excerpt", 87005)] == "the bus was late"  # a comment


def test_the_inbox_and_the_excerpt_api_quote_the_same_text(db_session):
    """Both read `models/excerpt.py::excerpt_text_from` — the inbox from selected
    columns, the API from the ORM row. Pin that they AGREE for every shape, so a
    caller passing the wrong parts is caught, not only a broken helper."""
    from sqlalchemy.orm import joinedload
    from app.routers.excerpts import _excerpt_to_response

    _seed_quotes(db_session)
    ids = list(range(87001, 87006))
    labels = _pending_item_labels(db_session, [_item("excerpt", i) for i in ids])
    excerpts = (
        db_session.query(Excerpt)
        .options(joinedload(Excerpt.segment), joinedload(Excerpt.dataset_value))
        .filter(Excerpt.id.in_(ids))
        .all()
    )
    assert len(excerpts) == len(ids)
    for excerpt in excerpts:
        api_text = _excerpt_to_response(excerpt).excerpt_text.strip()
        label = labels.get(("excerpt", excerpt.id))
        if label is None:
            assert api_text == ""  # only an empty quote goes unlabelled
        else:
            assert label == (api_text[:80] + ("…" if len(api_text) > 80 else ""))


def test_excerpts_are_labelled_with_one_grouped_query(db_session):
    _seed_quotes(db_session)
    seen: list[str] = []
    engine = db_session.get_bind()

    def _count(conn, cursor, statement, params, context, executemany):
        if re.search(r"\bFROM excerpt\b", statement):  # the table is singular
            seen.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        labels = _pending_item_labels(
            db_session, [_item("excerpt", i) for i in range(87001, 87006)]
        )
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    assert len(labels) == 4
    assert len(seen) == 1, f"expected one grouped query, got {len(seen)}"


def test_a_canvas_with_a_quote_in_its_inbox_opens(db_session):
    """The reported failure, at the endpoint: this answered 500."""
    canvas = _seed_quotes(db_session)
    db_session.add(_item("excerpt", 87001)); db_session.flush()
    db_session.expire_all()

    response = get_canvas_endpoint(
        project_id=870, canvas_id=canvas.id, user=db_session.get(User, 1), db=db_session,
    )
    labels = [item.source_label for item in _awaited(response).pending_items]
    assert labels == ["not helpful"]


def _awaited(maybe_coroutine):
    """The endpoint is `async def`; run it to completion without an event loop
    fixture (it awaits nothing)."""
    import asyncio
    if asyncio.iscoroutine(maybe_coroutine):
        return asyncio.run(maybe_coroutine)
    return maybe_coroutine


def test_every_type_the_client_can_hold_gets_a_label_from_a_real_row(db_session):
    """Pin the ARITY, not the excerpt (`backend/tests/the internal design notes).

    `item_type` is a free string on the server, so the vocabulary lives only in
    the client's `PENDING_LABELS`. A type added there without a label path here
    would have no row-backed label at best and, as #1316 showed, a crash at worst.
    """
    block = re.search(
        r"const PENDING_LABELS[^{]*\{([^}]*)\}", WRITING_CANVAS.read_text(encoding="utf-8")
    )
    assert block, "PENDING_LABELS not found in WritingCanvas.tsx — re-point this test"
    client_types = set(re.findall(r"^\s*(\w+)\s*:", block.group(1), re.MULTILINE))
    assert len(client_types) >= 3, f"population check: read {sorted(client_types)}"

    canvas, coll = _seed(db_session)
    material = Material(collection_id=coll.id, material_type="histogram", config="{}",
                        auto_name="Chart", custom_name=None)
    memo = Memo(project_id=870, numeric_id=1, entity_type="project", entity_id=870,
                title="A memo", content="…")
    db_session.add_all([material, memo]); db_session.flush()
    _seed_quotes_rows_only(db_session)
    rows = {"excerpt": 87001, "material": material.id, "memo": memo.id}

    missing = client_types - set(rows)
    assert not missing, (
        f"The client can hold {sorted(missing)} with no seeded row here. Give "
        "routers/canvas.py::_pending_item_labels a label path for it, then a row here."
    )
    labels = _pending_item_labels(db_session, [_item(t, rows[t]) for t in client_types])
    assert {t for t, _ in labels} == client_types


def _seed_quotes_rows_only(db):
    """`_seed_quotes` without re-seeding the project and canvas."""
    db.add(Conversation(id=871, project_id=870, name="Interview 2")); db.flush()
    db.add(Segment(id=87001, conversation_id=871, sequence_order=0,
                   text="It was not helpful at all."))
    db.flush()
    db.add(Excerpt(id=87001, project_id=870, segment_id=87001, start_offset=7, end_offset=18))
    db.flush()
