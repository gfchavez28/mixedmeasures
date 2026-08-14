"""#736 — every excerpt SOURCE resolves to a name, for every parent there is.

**Why this is an arity pin and not "a document quote shows its name."**
`ExcerptResponse` enumerated parents — `conversation_name`, then
`observation_name` added for clips in slab 5c — and a DOCUMENT quote matched
neither, so `excerptAttributionLine` fell through to `''`. That blank reached
the canvas Materials drawer, the embed's `sourceContext`, and therefore all
four export renderers: a document quote exported as an unattributed blockquote.
Documents had shipped long before observations; the arm was simply never added.

A third per-parent test would set up a fourth instance (the #515 → #676 lesson,
`backend/tests/the internal design notes). So the parent set is derived from
`ck_segment_exactly_one_parent` — the constraint a new `Segment` parent MUST be
added to — and every declared parent must produce a non-empty source. Nobody
has to remember this file exists.

The FOURTH excerpt kind, a `DatasetValue` comment, has no `Segment` and so no
CHECK to derive from; it is asserted alongside because `excerpt_source_pair`
owns it too and it is the reason the helper is excerpt-scoped rather than a
call into `segment_source_pair`.
"""
import re

import pytest
from sqlalchemy import CheckConstraint

from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.excerpt import Excerpt, excerpt_source_pair
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment

PID = 7360

# Each declared Segment parent → (the fixture's source name, the kind emitted).
PARENT_TO_SOURCE = {
    "conversation_id": ("Interview A", "conversation"),
    "document_id": ("Field Notes B", "document"),
    "observation_id": ("Playground C", "observation"),
}


def _declared_segment_parents() -> set[str]:
    """Parent FK names, read from the exactly-one CHECK rather than hardcoded."""
    for c in Segment.__table__.constraints:
        if isinstance(c, CheckConstraint) and c.name == "ck_segment_exactly_one_parent":
            return set(re.findall(r"(\w+_id)\s+IS NOT NULL", str(c.sqltext)))
    raise AssertionError(
        "ck_segment_exactly_one_parent is gone — the arity pin cannot work"
    )


def test_every_segment_parent_has_a_source_mapping():
    parents = _declared_segment_parents()
    assert parents, "no parents parsed from the CHECK — the regex or the constraint changed"

    unmapped = parents - set(PARENT_TO_SOURCE)
    assert not unmapped, (
        f"Segment gained parent(s) {sorted(unmapped)} with no excerpt source arm. "
        "A quote on that parent will resolve to an EMPTY name, which reaches the "
        "canvas Materials drawer, the embed's sourceContext and all four export "
        "renderers as a blank attribution (#736). Add the branch to "
        "models/excerpt.py::excerpt_source_pair and a row here, together."
    )
    stale = set(PARENT_TO_SOURCE) - parents
    assert not stale, (
        f"PARENT_TO_SOURCE names {sorted(stale)}, which the CHECK no longer declares"
    )


@pytest.fixture
def every_parent_project(db_session):
    """One quoted segment per declared parent, plus the dataset-value shape."""
    db = db_session
    db.add_all([
        Project(id=PID, name="Every parent", user_id=1),
        Conversation(id=PID, project_id=PID, name="Interview A"),
        Document(id=PID, project_id=PID, name="Field Notes B",
                 source_filename="notes.docx", source_format="docx"),
        Observation(id=PID, project_id=PID, name="Playground C"),
        Dataset(id=PID, project_id=PID, name="Survey"),
    ])
    db.flush()
    db.add_all([
        DatasetColumn(id=PID, dataset_id=PID, column_code="Q1",
                      column_name="Comments", column_text="Any comments?",
                      column_type="open_text", sequence_order=0, display_order=0),
        DatasetRow(id=PID, dataset_id=PID),
    ])
    db.flush()
    db.add(DatasetValue(id=PID, row_id=PID, column_id=PID, value_text="a comment"))
    db.add_all([
        Segment(id=73601, conversation_id=PID, sequence_order=0, text="turn text"),
        Segment(id=73602, document_id=PID, sequence_order=0, text="paragraph text"),
        Segment(id=73603, observation_id=PID, sequence_order=0, text="clip label",
                start_time=10.0, end_time=20.0),
    ])
    db.flush()
    db.add_all([
        Excerpt(id=73601, project_id=PID, segment_id=73601),
        Excerpt(id=73602, project_id=PID, segment_id=73602),
        Excerpt(id=73603, project_id=PID, segment_id=73603),
        Excerpt(id=73604, project_id=PID, dataset_value_id=PID),
    ])
    db.flush()
    return db


@pytest.mark.parametrize("parent_fk", sorted(PARENT_TO_SOURCE))
def test_each_parent_resolves_to_its_name(every_parent_project, parent_fk):
    """The behavioural half — parametrized over the SAME map the arity pin
    checks against the CHECK, so a new parent cannot be mapped without being
    exercised."""
    db = every_parent_project
    expected_name, expected_kind = PARENT_TO_SOURCE[parent_fk]

    seg = db.query(Segment).filter(
        getattr(Segment, parent_fk) == PID, Segment.text.isnot(None),
    ).one()
    exc = db.query(Excerpt).filter(Excerpt.segment_id == seg.id).one()

    kind, name = excerpt_source_pair(exc)
    assert (kind, name) == (expected_kind, expected_name), (
        f"a quote on a {parent_fk[:-3]} resolved to {(kind, name)!r} — an empty "
        "name here is the #736 defect: a blank attribution on the canvas and in "
        "every export."
    )
    assert name, "the source name must never be empty for a real parent"


def test_a_dataset_value_quote_resolves_too(every_parent_project):
    """The fourth kind, which has no Segment and so no CHECK to derive from —
    and which is why the helper is excerpt-scoped rather than delegating to
    `segment_source_pair`, whose domain is segments only."""
    db = every_parent_project
    exc = db.query(Excerpt).filter(Excerpt.dataset_value_id == PID).one()

    kind, name = excerpt_source_pair(exc)
    assert kind == "text"
    assert name == "Survey › Comments"


def test_the_response_carries_the_resolved_source(every_parent_project):
    """The wire half. `_excerpt_to_response` is where the enumeration lived, so
    the pin belongs on the response and not only on the helper."""
    from app.routers.excerpts import _excerpt_to_response

    db = every_parent_project
    doc_seg = db.query(Segment).filter(Segment.document_id == PID).one()
    exc = db.query(Excerpt).filter(Excerpt.segment_id == doc_seg.id).one()

    resp = _excerpt_to_response(exc)
    assert (resp.source_kind, resp.source_name) == ("document", "Field Notes B"), (
        "the document arm is the one that was missing — a blank here is #736 "
        "reintroduced"
    )
