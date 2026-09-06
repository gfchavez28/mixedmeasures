"""The general detector for #855's fourteenth: a key the service emits that the
schema does not declare is a FAILURE in tests, not a silent drop.

`tests/conftest.py::_forbid_undeclared_keys_on_every_schema` flips every class in
`app.schemas` to `extra='forbid'` for the test session. This file is its
POPULATION assertion and its PREDICATE falsifier (#729/#730): a flip that reached
no class would leave the suite exactly as green as one that reached them all.

**Why this is the general form and not a fifth per-field pin.** The class has cost
five separate defects, each fixed by declaring the field and leaving a comment
that the schema had to declare it: `scale_values` (#586), `missing_values`
(#592), `derived_via` (Decision B), `observation_count` (#639),
`magnitude_conflicts` (#855's fourteenth). `test_column_schema_siblings.py` pins
one class pair; `TestMergeReport` pins one report dict. Both catch the NEXT field
on THEIR class and nothing on any other. Flipping the default catches it on all
~500 at once, in whichever test constructs the model — the whole suite is the
guard, and no test has to be written for a field nobody has thought of yet.

**MEASURED, not assumed (2026-09-04, whole suite under the flip):** 13 failures,
which classified into THREE real drops and ONE deliberate projection:

  * `ContextSegment` / `CodedSegmentWithContext` lacked `speaker_color` — the
    service emitted a speaker's custom colour at six sites and the analysis
    surfaces could never receive it. Declared.
  * `ProjectSummary` lacked `canvas_count` / `canvas_theme_count` — written by
    every export since the canvas shipped; the exporter's own comment said
    "declare them if that changes". Declared.
  * `DatasetDataColumnResponse` is a deliberate NARROWING of its sibling
    (`DATA_PAYLOAD_OMITS`); the router now projects explicitly instead of relying
    on the drop — the same three names, as a decision rather than an accident.

⚠️ **What the flip cannot see, stated so nobody reads more into a green suite:** a
router that RETURNS a bare dict under `response_model=`, when the test calls the
function directly. FastAPI's serialisation — where that dict meets the schema —
runs only under `TestClient`. A test of such an endpoint that wants this detector
must drive it through the client.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from tests.conftest import SCHEMA_CLASSES_UNDER_FORBID

from app.schemas.dataset import DATA_PAYLOAD_OMITS, DatasetColumnResponse, DatasetDataColumnResponse
from app.schemas.project_portability import MergeReport, ProjectSummary


def test_the_flip_reached_the_schema_population():
    """POPULATION (#730): ~500 classes on 2026-09-04; the floor detects a walk that
    found a handful, not growth."""
    assert len(SCHEMA_CLASSES_UNDER_FORBID) >= 300, len(SCHEMA_CLASSES_UNDER_FORBID)
    for headliner in (MergeReport, ProjectSummary, DatasetDataColumnResponse):
        assert headliner in SCHEMA_CLASSES_UNDER_FORBID
        assert headliner.model_config.get("extra") == "forbid"


def test_an_undeclared_key_is_refused_not_dropped():
    """PREDICATE falsifier, on the exact class the fourteenth instance hid in."""
    with pytest.raises(ValidationError) as exc:
        MergeReport(magnitude_conflicts=0, this_key_does_not_exist=1)
    # `MergeReport` also has REQUIRED fields this call omits, so the error list
    # carries `missing` entries too; the one this test is about is the extra.
    extras = [e for e in exc.value.errors() if e["type"] == "extra_forbidden"]
    assert [e["loc"] for e in extras] == [("this_key_does_not_exist",)], exc.value.errors()


def test_the_refusal_reaches_a_nested_model():
    """A dict handed to a NESTED field is validated under forbid too — the
    `ProjectImportResult(merge_report=report)` shape the fourteenth took."""
    from app.schemas.project_portability import ProjectImportResult

    # ⚠️ The first draft of this test passed `success=True` — a field the result
    # schema does not have — and the detector refused THAT before the nested key.
    # Left here as the record: the flip catches a fabricated field in a test
    # exactly as it catches one in a router.
    with pytest.raises(ValidationError) as exc:
        ProjectImportResult(
            project_id=1, project_name="p",
            merge_report={"applications_added": 1, "undeclared": 2},
        )
    extras = [e["loc"] for e in exc.value.errors() if e["type"] == "extra_forbidden"]
    assert extras == [("merge_report", "undeclared")], exc.value.errors()


def test_attribute_inputs_are_not_affected():
    """`from_attributes` reads declared fields off an object and never sees an
    'extra' — forbid must not break ORM-backed responses (measured before wiring)."""

    class OrmLike:
        conversation_count = 1
        dataset_count = 2
        document_count = 3
        code_count = 4
        category_count = 5
        memo_count = 6
        participant_count = 7
        excerpt_count = 8
        something_the_schema_never_declared = 99

    summary = ProjectSummary.model_validate(OrmLike(), from_attributes=True)
    assert summary.excerpt_count == 8


def test_the_data_payload_projection_is_explicit():
    """The one deliberate narrowing: every field the full column response carries
    reaches the data payload unless `DATA_PAYLOAD_OMITS` names it — and under
    forbid the router's explicit `exclude` is what keeps that construction legal."""
    assert set(DatasetColumnResponse.model_fields) - set(DatasetDataColumnResponse.model_fields) == set(DATA_PAYLOAD_OMITS)
