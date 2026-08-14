"""#652 slab 3 — a QUALITATIVE material's references are existence-checked too.

Until slab 3, `_collect_material_refs` collected `column_ids` / `domain_ids` and
nothing else, so a qualitative config — which references codes and the four
source kinds — always yielded empty sets and `has_missing_refs` was
**structurally always False**. Live-confirmed on 2026-08-03: a material pointing
at a deleted conversation reported itself healthy.

That was inert while every qualitative material rendered "No data configured"
regardless. Slabs 1–2 made eight of the nine types draw, which turned it into a
chart silently missing a source with no banner.

⚠️ **Fixture discipline.** Every test here names a NON-column kind. A
column-only fixture passes under the old code and the new, which is exactly what
let this survive slab 0.
"""
import asyncio
import json

import pytest

from app.models.analysis_domain import AnalysisDomain
from app.models.code import Code
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn
from app.models.document import Document
from app.models.materials import MaterialCollection, Material
from app.models.observation import Observation
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.materials import (
    _build_existence_sets,
    _build_material_response,
    _collect_material_refs,
)

PID = 970


@pytest.fixture
def qual_project(db_session):
    db = db_session
    db.add_all([
        Project(id=PID, name="Qual refs", user_id=1),
        Conversation(id=9701, project_id=PID, name="Kept conversation"),
        Document(id=9702, project_id=PID, name="Kept doc",
                 source_filename="d.docx", source_format="docx"),
        Observation(id=9703, project_id=PID, name="Kept observation"),
        Code(id=9704, project_id=PID, name="Kept code", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
        Participant(id=9705, project_id=PID, identifier="P-001", display_name="P1"),
        MaterialCollection(id=9706, project_id=PID, name="Materials", display_order=0),
    ])
    db.commit()
    return db


def _material(db, config: dict) -> Material:
    m = Material(
        collection_id=9706,
        material_type="chart",
        config=json.dumps(config),
        auto_name="Qual chart",
        display_order=0,
        source_tab="descriptives",
    )
    db.add(m)
    db.commit()
    return m


def test_collect_gathers_every_qualitative_kind():
    refs = _collect_material_refs({
        "code_mode": "codes",
        "code_ids": [11],
        "conversation_ids": [21],
        "document_ids": [31],
        "observation_ids": [41],
        "participant_ids": [51],
        "text_column_ids": [61],
        "chart_type": "bar",       # not a ref
        "exclude_facilitator": True,  # bool must not become id 1
    })
    assert refs["code"] == {11}
    assert refs["conversation"] == {21}
    assert refs["document"] == {31}
    assert refs["observation"] == {41}
    assert refs["participant"] == {51}
    # text columns are DatasetColumn ids — same kind, same existence query.
    assert refs["column"] == {61}


def test_a_deleted_conversation_is_reported_missing(qual_project):
    """The live-confirmed #652 case: material saved, source deleted, banner owed."""
    db = qual_project
    m = _material(db, {"code_mode": "codes", "code_ids": [9704], "conversation_ids": [9701]})

    healthy = _build_material_response(m, _build_existence_sets(db, PID, [m]))
    assert healthy.has_missing_refs is False, "nothing deleted yet"

    db.delete(db.query(Conversation).filter(Conversation.id == 9701).first())
    db.commit()

    stale = _build_material_response(m, _build_existence_sets(db, PID, [m]))
    assert stale.has_missing_refs is True
    assert stale.missing_refs == [{"type": "conversation", "id": 9701}]


@pytest.mark.parametrize("kind,key,model,ref_id", [
    ("code", "code_ids", Code, 9704),
    ("document", "document_ids", Document, 9702),
    ("observation", "observation_ids", Observation, 9703),
    ("participant", "participant_ids", Participant, 9705),
])
def test_each_qualitative_kind_is_checked(qual_project, kind, key, model, ref_id):
    db = qual_project
    m = _material(db, {"code_mode": "codes", key: [ref_id]})
    assert _build_material_response(m, _build_existence_sets(db, PID, [m])).has_missing_refs is False

    db.delete(db.query(model).filter(model.id == ref_id).first())
    db.commit()

    res = _build_material_response(m, _build_existence_sets(db, PID, [m]))
    assert res.missing_refs == [{"type": kind, "id": ref_id}], f"{kind} not existence-checked"


def test_a_foreign_projects_source_reads_as_missing(qual_project):
    """#390's rule, extended to the qualitative kinds: an id that exists but
    belongs to ANOTHER project must not register as 'source available'."""
    db = qual_project
    db.add(Project(id=PID + 1, name="Other", user_id=1))
    db.flush()
    db.add(Conversation(id=9799, project_id=PID + 1, name="Foreign"))
    db.commit()

    m = _material(db, {"code_mode": "codes", "conversation_ids": [9799]})
    res = _build_material_response(m, _build_existence_sets(db, PID, [m]))
    assert res.missing_refs == [{"type": "conversation", "id": 9799}]


def test_a_quantitative_material_is_unaffected(qual_project):
    """Two-sided: the pre-slab-3 behaviour still holds for column/domain refs."""
    db = qual_project
    ds = Dataset(id=9710, project_id=PID, name="DS")
    db.add(ds)
    db.flush()
    db.add_all([
        DatasetColumn(id=9711, dataset_id=9710, column_name="age", column_text="Age",
                      column_type="numeric", sequence_order=0, display_order=0),
        AnalysisDomain(id=9712, project_id=PID, name="Domain"),
    ])
    db.commit()

    m = _material(db, {"column_ids": [9711], "domain_ids": [9712], "metric_type": "mean"})
    assert _build_material_response(m, _build_existence_sets(db, PID, [m])).has_missing_refs is False

    db.delete(db.query(AnalysisDomain).filter(AnalysisDomain.id == 9712).first())
    db.commit()
    res = _build_material_response(m, _build_existence_sets(db, PID, [m]))
    assert res.missing_refs == [{"type": "domain", "id": 9712}]


def test_write_paths_still_skip_the_check(qual_project):
    """`_build_material_response` with no existence sets = a create/update
    response, where refs are valid by construction. It must not report."""
    db = qual_project
    m = _material(db, {"code_mode": "codes", "conversation_ids": [999999]})
    assert _build_material_response(m).has_missing_refs is False
