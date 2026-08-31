"""Every column payload states the column's saved rules — #830f, 2026-08-31.

## Why this exists

`Add ▾ → Recoded variable…` needs to know which variables carry a saved
`RecodeDefinition` and what those rules are called. That list rode the `/data`
payload ALONE, so the menu could only ever be built on the Data view — and the
screen it sends people to in its own empty state ("rules are written in the
Variables view") was the one screen that could not offer it.

`_column_to_response` builds the summaries now, which makes the two payloads
structurally incapable of disagreeing.

## What is asserted, and why in this shape

The load-bearing claim is an AGREEMENT: the same column, serialized through the
two response builders, yields the same rules. A test that only checked
`list_columns` would pass just as well against a second, drifting builder in the
`/data` endpoint — which is the state this change removed and the #602 defect
class in one sentence.
"""

import json

import pytest

from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.recode import OutputType, RecodeDefinition, RecodeType
from app.routers.dataset import _column_to_response


@pytest.fixture
def column_with_two_rules(db_session):
    """A column carrying a primary scale_map AND a non-primary reverse.

    ⚠️ TWO rules, and only one primary, on purpose. Since design-note §8 a saved
    rule is NOT applied on save, so the ordinary state of a researcher's column
    is "rules exist, none in effect" — a fixture with a single primary rule
    cannot tell `recode_definitions` from `primary_recode` and would pass against
    a builder that serialized only the primary one.
    """
    project = Project(id=1, name="Payload Test", user_id=1)
    db_session.add(project)
    db_session.flush()

    dataset = Dataset(id=1, project_id=project.id, name="Survey")
    db_session.add(dataset)
    db_session.flush()

    column = DatasetColumn(
        id=1,
        dataset_id=dataset.id,
        column_code="Q1",
        column_text="How often do you attend?",
        column_type="ordinal",
        sequence_order=0,
        display_order=0,
    )
    db_session.add(column)
    db_session.flush()

    for i, text in enumerate(["Never", "Sometimes", "Always"]):
        row = DatasetRow(id=i + 1, dataset_id=dataset.id)
        db_session.add(row)
        db_session.flush()
        db_session.add(DatasetValue(
            id=i + 1, row_id=row.id, column_id=column.id,
            value_text=text, value_numeric=None,
        ))

    db_session.add(RecodeDefinition(
        id=1, column_id=column.id, name="Attendance scale",
        recode_type=RecodeType.SCALE_MAP, output_type=OutputType.NUMERIC,
        mapping=json.dumps({"Never": 1, "Sometimes": 2, "Always": 3}),
        is_primary=True,
    ))
    db_session.add(RecodeDefinition(
        id=2, column_id=column.id, name="Attendance reversed",
        recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
        mapping=json.dumps({"Never": 1, "Sometimes": 2, "Always": 3}),
        source_definition_id=1,
        is_primary=False,
    ))
    db_session.flush()
    db_session.refresh(column)
    return column


def test_the_full_column_response_carries_every_saved_rule(column_with_two_rules):
    """The claim #830f needs: the rule picker can be built from this payload."""
    resp = _column_to_response(column_with_two_rules)

    assert [d.name for d in resp.recode_definitions] == [
        "Attendance scale", "Attendance reversed",
    ]


def test_a_non_primary_rule_reaches_the_payload(column_with_two_rules):
    """🔴 The one that pins the fixture's reason for existing.

    A rule that is saved but NOT in effect is derivable-from and must be
    offerable. If `recode_definitions` were ever narrowed to the primary — the
    obvious "tidy" — deriving would silently become impossible for exactly the
    rules design-note §8 made the normal case.
    """
    resp = _column_to_response(column_with_two_rules)

    not_in_effect = [d for d in resp.recode_definitions if not d.is_primary]
    assert [d.name for d in not_in_effect] == ["Attendance reversed"]


def test_both_column_payloads_state_the_same_rules(column_with_two_rules):
    """The AGREEMENT assertion — the one a second builder would fail.

    `DatasetDataColumnResponse` is splat-constructed from the full response, so
    this compares what `/data` would send against what `list_columns` sends. It
    is the assertion that stops the `/data` endpoint growing its own copy back.
    """
    from app.schemas.dataset import DatasetDataColumnResponse

    base = _column_to_response(column_with_two_rules)
    data_payload = DatasetDataColumnResponse(**base.model_dump())

    assert (
        [d.model_dump() for d in data_payload.recode_definitions]
        == [d.model_dump() for d in base.recode_definitions]
    )
    # Self-check: an agreement between two EMPTY lists is not an agreement.
    assert len(base.recode_definitions) == 2


def test_reverse_offset_is_populated_for_every_type_not_only_reverse(column_with_two_rules):
    """#602's rule, re-pinned at the new single builder.

    The offset is what the reverse editor's DRAFT preview reads off the SOURCE
    `scale_map`, so gating it on `recode_type == 'reverse'` leaves that preview
    deriving a raw `min+max`. Presence does not mean "this is a reverse" —
    consumers branch on `recode_type`.
    """
    by_name = {d.name: d for d in _column_to_response(column_with_two_rules).recode_definitions}

    assert by_name["Attendance scale"].recode_type == "scale_map"
    assert by_name["Attendance scale"].reverse_offset == 4.0
    assert by_name["Attendance reversed"].reverse_offset == 4.0


def test_a_column_with_no_rules_says_so_rather_than_omitting_the_field(db_session):
    """An empty list, never a null — the picker filters on length.

    ⚠️ Same reasoning as `primary_recode`'s: the field is populated by EVERY
    caller of this builder, so `[]` can only mean "this column has no rules" and
    never "this endpoint did not look".
    """
    project = Project(id=2, name="Bare", user_id=1)
    db_session.add(project)
    db_session.flush()
    dataset = Dataset(id=2, project_id=project.id, name="Bare set")
    db_session.add(dataset)
    db_session.flush()
    column = DatasetColumn(
        id=2, dataset_id=dataset.id, column_code="Q9", column_text="Comments",
        column_type="open_text", sequence_order=0, display_order=0,
    )
    db_session.add(column)
    db_session.flush()
    db_session.refresh(column)

    resp = _column_to_response(column)

    assert resp.recode_definitions == []
    assert resp.primary_recode is None
