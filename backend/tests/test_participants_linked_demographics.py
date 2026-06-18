"""Tests for #353 — widen `_build_linked_demographics` to include
all non-text linked-row columns (not just `column_type == DEMOGRAPHIC`),
gated by the new per-column `show_in_participant_profile` opt-out.

Before the fix, `_build_linked_demographics` filtered strictly by
`DatasetColumn.column_type == ColumnType.DEMOGRAPHIC`. Auto-detect rarely
picks the demographic type for non-survey datasets (it uses keyword
heuristics for age/gender/race/etc.). So linking Principal Thomas to
School Profiles R001 (Maple Ridge — Enrollment=520, Pct_FRL=28,
Principal_Tenure=8, etc.) surfaced the link but no actual values from
the row — defeating the participant-linking promise.

After the fix:
1. Include ORDINAL, NOMINAL, BINARY, MULTI_SELECT, NUMERIC, PERCENTAGE,
   DEMOGRAPHIC. Exclude OPEN_TEXT, SKIP.
2. Respect `show_in_participant_profile` boolean opt-out (default True).
3. Add `column_type` to response so frontend can format by-type.
"""
import pytest

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.participant import Participant
from app.routers.participants import _build_linked_demographics


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture: project with diverse column types + linked participant
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def project_with_linked_participant(db_session):
    """Maple Ridge-style fixture: a School Profiles dataset with varied
    column types, a participant linked to row R001.

    Layout (project 950):
    - Dataset 9500 "School Profiles": cols
      - 95001 School (nominal) — "Maple Ridge"
      - 95002 Enrollment (numeric) — "520"
      - 95003 Pct_FRL (percentage) — "28"
      - 95004 Principal_Tenure (numeric) — "8"
      - 95005 Notes (open_text) — "Strong leadership" ← excluded by type
      - 95006 Region (nominal) — "Suburb"
      - 95007 PrincipalLastName (demographic) — "Thomas"
      - 95008 Hidden_Sensitive (numeric, opt-out) — "999" ← excluded by flag
    - Participant 9700 "Principal Thomas" linked to row 9600
    """
    db = db_session
    db.add(Project(id=950, name="#353 fixture", user_id=1))
    db.add(Dataset(id=9500, project_id=950, name="School Profiles"))
    db.flush()

    cols = [
        DatasetColumn(id=95001, dataset_id=9500, column_text="School",
                      column_type="nominal", sequence_order=0),
        DatasetColumn(id=95002, dataset_id=9500, column_text="Enrollment",
                      column_type="numeric", sequence_order=1),
        DatasetColumn(id=95003, dataset_id=9500, column_text="Pct_FRL",
                      column_type="percentage", sequence_order=2),
        DatasetColumn(id=95004, dataset_id=9500, column_text="Principal_Tenure",
                      column_type="numeric", sequence_order=3),
        DatasetColumn(id=95005, dataset_id=9500, column_text="Notes",
                      column_type="open_text", sequence_order=4),
        DatasetColumn(id=95006, dataset_id=9500, column_text="Region",
                      column_type="nominal", sequence_order=5),
        DatasetColumn(id=95007, dataset_id=9500, column_text="PrincipalLastName",
                      column_type="demographic", sequence_order=6,
                      demographic_subtype="role"),
        # #353: explicit opt-out — should NOT appear in response
        DatasetColumn(id=95008, dataset_id=9500, column_text="Hidden_Sensitive",
                      column_type="numeric", sequence_order=7,
                      show_in_participant_profile=False),
    ]
    db.add_all(cols)
    db.flush()

    # Row 9600 = R001 Maple Ridge
    db.add(DatasetRow(id=9600, dataset_id=9500, row_identifier="R001"))
    db.flush()

    db.add_all([
        DatasetValue(row_id=9600, column_id=95001, value_text="Maple Ridge"),
        DatasetValue(row_id=9600, column_id=95002, value_text="520", value_numeric=520),
        DatasetValue(row_id=9600, column_id=95003, value_text="28", value_numeric=28),
        DatasetValue(row_id=9600, column_id=95004, value_text="8", value_numeric=8),
        DatasetValue(row_id=9600, column_id=95005, value_text="Strong leadership"),
        DatasetValue(row_id=9600, column_id=95006, value_text="Suburb"),
        DatasetValue(row_id=9600, column_id=95007, value_text="Thomas"),
        DatasetValue(row_id=9600, column_id=95008, value_text="999", value_numeric=999),
    ])

    # Participant "Principal Thomas" linked to R001
    participant = Participant(
        id=9700, project_id=950, identifier="Principal Thomas",
        display_name="Principal Thomas",
    )
    db.add(participant)
    db.flush()
    # Link: set the row's participant_id
    row = db.query(DatasetRow).filter(DatasetRow.id == 9600).one()
    row.participant_id = 9700
    db.flush()

    # Refresh participant so .dataset_rows is populated
    db.refresh(participant)
    return participant


# ═══════════════════════════════════════════════════════════════════════════════
# Tests
# ═══════════════════════════════════════════════════════════════════════════════


def test_includes_nominal_columns(project_with_linked_participant, db_session):
    """The scenario 2 fix: nominal School column now surfaces (pre-fix it
    was filtered out because only demographic columns were included)."""
    result = _build_linked_demographics(project_with_linked_participant, db_session)
    nominal_cols = [r for r in result if r.column_type == "nominal"]
    assert len(nominal_cols) == 2  # School + Region
    school = next((r for r in result if r.column_text == "School"), None)
    assert school is not None
    assert school.value == "Maple Ridge"


def test_includes_numeric_and_percentage(project_with_linked_participant, db_session):
    """Numeric + percentage columns now appear in the participant profile."""
    result = _build_linked_demographics(project_with_linked_participant, db_session)
    by_text = {r.column_text: r for r in result}
    assert by_text["Enrollment"].value == "520"
    assert by_text["Enrollment"].column_type == "numeric"
    assert by_text["Pct_FRL"].value == "28"
    assert by_text["Pct_FRL"].column_type == "percentage"
    assert by_text["Principal_Tenure"].value == "8"


def test_includes_demographic_unchanged(project_with_linked_participant, db_session):
    """Demographic columns still surface (backwards-compat — they did before)."""
    result = _build_linked_demographics(project_with_linked_participant, db_session)
    demo = next((r for r in result if r.column_type == "demographic"), None)
    assert demo is not None
    assert demo.column_text == "PrincipalLastName"
    assert demo.value == "Thomas"


def test_excludes_open_text(project_with_linked_participant, db_session):
    """OPEN_TEXT columns are excluded — verbatim comments would clutter the panel."""
    result = _build_linked_demographics(project_with_linked_participant, db_session)
    text_cols = [r for r in result if r.column_type == "open_text"]
    assert text_cols == []


def test_excludes_hidden_columns(project_with_linked_participant, db_session):
    """Columns with `show_in_participant_profile=False` are excluded entirely
    from the response (not included with a hidden flag). Cleaner payload + no
    accidental leak of opt-out columns to the frontend."""
    result = _build_linked_demographics(project_with_linked_participant, db_session)
    hidden = [r for r in result if r.column_text == "Hidden_Sensitive"]
    assert hidden == []


def test_response_includes_column_type_field(project_with_linked_participant, db_session):
    """#353: schema gets a `column_type` field so frontend can format by-type
    (right-align numerics, label ordinals, etc.). Verify present + accurate."""
    result = _build_linked_demographics(project_with_linked_participant, db_session)
    for r in result:
        assert r.column_type is not None
        # All included types should be in the canonical set
        assert r.column_type in (
            "ordinal", "nominal", "binary", "multi_select",
            "numeric", "percentage", "demographic",
        )


def test_no_linked_rows_returns_empty(db_session):
    """Participant with no linked rows → empty list (not error)."""
    db = db_session
    db.add(Project(id=951, name="empty", user_id=1))
    p = Participant(id=9701, project_id=951, identifier="Lonely Participant")
    db.add(p)
    db.flush()
    db.refresh(p)
    result = _build_linked_demographics(p, db)
    assert result == []


def test_existing_columns_default_to_show_true(db_session):
    """Migration regression: columns created before the new field exists
    default to True via server_default='1' (set in the model + migration).
    A column created with NO explicit show_in_participant_profile value gets True."""
    db = db_session
    db.add(Project(id=952, name="default test", user_id=1))
    db.add(Dataset(id=9502, project_id=952, name="d"))
    db.flush()
    # Create column without specifying show_in_participant_profile
    col = DatasetColumn(
        id=95201, dataset_id=9502, column_text="Auto",
        column_type="numeric", sequence_order=0,
    )
    db.add(col)
    db.flush()
    db.refresh(col)
    assert col.show_in_participant_profile is True


def test_multi_dataset_participant_groups_values_correctly(db_session):
    """When a participant is linked to rows in multiple datasets, values
    are correctly attributed to their source dataset (no cross-contamination)."""
    db = db_session
    db.add(Project(id=953, name="multi", user_id=1))
    db.add_all([
        Dataset(id=9503, project_id=953, name="A"),
        Dataset(id=9504, project_id=953, name="B"),
    ])
    db.flush()
    db.add_all([
        DatasetColumn(id=95301, dataset_id=9503, column_text="ColA",
                      column_type="numeric", sequence_order=0),
        DatasetColumn(id=95401, dataset_id=9504, column_text="ColB",
                      column_type="numeric", sequence_order=0),
    ])
    db.flush()
    db.add(DatasetRow(id=9601, dataset_id=9503, row_identifier="A1"))
    db.add(DatasetRow(id=9602, dataset_id=9504, row_identifier="B1"))
    db.flush()
    db.add_all([
        DatasetValue(row_id=9601, column_id=95301, value_text="A-val"),
        DatasetValue(row_id=9602, column_id=95401, value_text="B-val"),
    ])
    p = Participant(id=9702, project_id=953, identifier="Multi")
    db.add(p)
    db.flush()
    db.query(DatasetRow).filter(DatasetRow.id == 9601).update({"participant_id": 9702})
    db.query(DatasetRow).filter(DatasetRow.id == 9602).update({"participant_id": 9702})
    db.flush()
    db.refresh(p)

    result = _build_linked_demographics(p, db)
    by_text = {r.column_text: r for r in result}
    # Each value attributed to its own dataset
    assert by_text["ColA"].dataset_name == "A"
    assert by_text["ColA"].value == "A-val"
    assert by_text["ColB"].dataset_name == "B"
    assert by_text["ColB"].value == "B-val"
