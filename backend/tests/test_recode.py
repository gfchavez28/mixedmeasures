"""Tests for recode service — pure compute_value + DB-backed functions."""

import json
import pytest

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.services.recode import (
    compute_value,
    apply_definition_to_column,
    get_value_frequencies,
    get_unmapped_values,
    clear_value_numeric,
)


# ---------------------------------------------------------------------------
# Helper: create a reusable recode scenario in the DB
# ---------------------------------------------------------------------------

def _setup_ordinal_column(db):
    """Create a project + dataset + column + rows with ordinal survey data.

    Returns (column, definition, row_ids) where:
      - column has 6 values: Excellent, Good, Fair, Poor, N/A, Excellent
      - definition maps Excellent=5, Good=4, Fair=3, Poor=2 and excludes N/A
    """
    project = Project(id=1, name="Recode Test Project", user_id=1)
    db.add(project)
    db.flush()

    dataset = Dataset(id=1, project_id=project.id, name="Survey")
    db.add(dataset)
    db.flush()

    column = DatasetColumn(
        id=1,
        dataset_id=dataset.id,
        column_code="Q1",
        column_text="How would you rate the service?",
        column_type="ordinal",
        sequence_order=0,
        display_order=0,
    )
    db.add(column)
    db.flush()

    values_data = ["Excellent", "Good", "Fair", "Poor", "N/A", "Excellent"]
    row_ids = []
    for i, val_text in enumerate(values_data):
        row = DatasetRow(id=i + 1, dataset_id=dataset.id)
        db.add(row)
        db.flush()
        row_ids.append(row.id)

        dv = DatasetValue(
            id=i + 1,
            row_id=row.id,
            column_id=column.id,
            value_text=val_text,
            value_numeric=None,
        )
        db.add(dv)

    db.flush()

    definition = RecodeDefinition(
        id=1,
        column_id=column.id,
        name="Satisfaction Scale",
        recode_type=RecodeType.SCALE_MAP,
        output_type=OutputType.NUMERIC,
        mapping=json.dumps({"Excellent": 5, "Good": 4, "Fair": 3, "Poor": 2}),
        exclude_values=json.dumps(["N/A"]),
        is_primary=True,
        sequence_order=0,
    )
    db.add(definition)
    db.flush()

    return column, definition, row_ids


# ---------------------------------------------------------------------------
# compute_value (pure function — no DB needed)
# ---------------------------------------------------------------------------

class TestComputeValue:
    @pytest.fixture(autouse=True)
    def _make_definition(self):
        """Build a RecodeDefinition in-memory (no DB) for pure tests."""
        self.definition = RecodeDefinition(
            id=99,
            column_id=1,
            name="Test Scale",
            recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps({"excellent": 5, "good": 4, "fair": 3, "poor": 2}),
            exclude_values=json.dumps(["N/A"]),
            is_primary=True,
            sequence_order=0,
        )

    def test_mapped_value(self):
        assert compute_value("Excellent", self.definition) == 5

    def test_case_insensitive_lookup(self):
        assert compute_value("GOOD", self.definition) == 4
        assert compute_value("fair", self.definition) == 3

    def test_excluded_value_returns_none(self):
        assert compute_value("N/A", self.definition) is None

    def test_unmapped_value_returns_none(self):
        assert compute_value("Unknown", self.definition) is None

    def test_empty_input_returns_none(self):
        assert compute_value("", self.definition) is None
        assert compute_value("   ", self.definition) is None

    def test_none_input_returns_none(self):
        assert compute_value(None, self.definition) is None

    def test_whitespace_trimmed(self):
        assert compute_value("  Poor  ", self.definition) == 2


# ---------------------------------------------------------------------------
# apply_definition_to_column (DB)
# ---------------------------------------------------------------------------

class TestApplyDefinitionToQuestion:
    def test_bulk_update_sets_numeric_values(self, db_session):
        column, definition, row_ids = _setup_ordinal_column(db_session)

        result = apply_definition_to_column(db_session, definition)
        db_session.flush()

        assert result["updated"] == 6  # All 6 rows touched
        assert result["unmapped"] == []
        assert result["excluded"] == 1  # "N/A" row

        # Verify numeric values were set
        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == column.id)
            .order_by(DatasetValue.id)
            .all()
        )
        assert vals[0].value_numeric == 5.0  # Excellent
        assert vals[1].value_numeric == 4.0  # Good
        assert vals[2].value_numeric == 3.0  # Fair
        assert vals[3].value_numeric == 2.0  # Poor
        assert vals[4].value_numeric is None  # N/A (excluded)
        assert vals[5].value_numeric == 5.0  # Excellent

    def test_with_row_ids_filter(self, db_session):
        column, definition, row_ids = _setup_ordinal_column(db_session)

        # Only update first two rows
        result = apply_definition_to_column(
            db_session, definition, row_ids=[row_ids[0], row_ids[1]]
        )
        db_session.flush()

        assert result["updated"] == 2

        # Third row should still be NULL
        val3 = db_session.query(DatasetValue).filter(DatasetValue.id == 3).one()
        assert val3.value_numeric is None


# ---------------------------------------------------------------------------
# get_value_frequencies (DB)
# ---------------------------------------------------------------------------

class TestGetValueFrequencies:
    def test_returns_sorted_counts(self, db_session):
        column, _, _ = _setup_ordinal_column(db_session)

        freqs = get_value_frequencies(db_session, column.id)

        # Excellent appears 2x, others 1x each
        freq_map = {f["value_text"]: f["count"] for f in freqs}
        assert freq_map["Excellent"] == 2
        assert freq_map["Good"] == 1
        assert freq_map["N/A"] == 1

        # Sorted by count descending — Excellent should be first
        assert freqs[0]["value_text"] == "Excellent"
        assert freqs[0]["count"] == 2

    def test_is_na_flag(self, db_session):
        column, _, _ = _setup_ordinal_column(db_session)

        freqs = get_value_frequencies(db_session, column.id)
        na_entry = next(f for f in freqs if f["value_text"] == "N/A")
        good_entry = next(f for f in freqs if f["value_text"] == "Good")
        assert na_entry["is_na"] is True
        assert good_entry["is_na"] is False


# ---------------------------------------------------------------------------
# get_unmapped_values (DB)
# ---------------------------------------------------------------------------

class TestGetUnmappedValues:
    def test_no_unmapped_when_all_covered(self, db_session):
        column, definition, _ = _setup_ordinal_column(db_session)

        unmapped = get_unmapped_values(db_session, column.id, definition)
        # All values (Excellent, Good, Fair, Poor) are mapped; N/A is excluded
        assert unmapped == []

    def test_detects_unmapped_value(self, db_session):
        column, definition, _ = _setup_ordinal_column(db_session)

        # Add a value not in the mapping or exclude list
        extra_row = DatasetRow(id=100, dataset_id=1)
        db_session.add(extra_row)
        db_session.flush()
        extra_val = DatasetValue(
            id=100,
            row_id=extra_row.id,
            column_id=column.id,
            value_text="Very Good",
            value_numeric=None,
        )
        db_session.add(extra_val)
        db_session.flush()

        unmapped = get_unmapped_values(db_session, column.id, definition)
        assert "Very Good" in unmapped


# ---------------------------------------------------------------------------
# clear_value_numeric (DB)
# ---------------------------------------------------------------------------

class TestClearValueNumeric:
    def test_clears_all_numeric_values(self, db_session):
        column, definition, _ = _setup_ordinal_column(db_session)

        # First, apply the recode so numeric values are set
        apply_definition_to_column(db_session, definition)
        db_session.flush()

        # Verify they're set
        val = db_session.query(DatasetValue).filter(DatasetValue.id == 1).one()
        assert val.value_numeric is not None

        # Clear them
        cleared = clear_value_numeric(db_session, column.id)
        db_session.flush()

        assert cleared == 6  # All 6 values

        # Verify all are now NULL
        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == column.id)
            .all()
        )
        assert all(v.value_numeric is None for v in vals)


# ── Reverse recode tests ────────────────────────────────────────────────────


class TestReverseRecode:
    """Tests for RecodeType.REVERSE computation."""

    @pytest.fixture(autouse=True)
    def _make_reverse_definition(self):
        self.definition = RecodeDefinition(
            id=99,
            column_id=1,
            name="Reverse 5-point",
            recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps({"Excellent": 5, "Very Good": 4, "Good": 3, "Fair": 2, "Poor": 1}),
            exclude_values=json.dumps(["N/A"]),
            is_primary=False,
            is_auto_detected=False,
            sequence_order=1,
        )

    def test_reverse_high_to_low(self):
        """Excellent=5 reversed on 5-point scale: (5+1)-5 = 1."""
        result = compute_value("Excellent", self.definition)
        assert result == 1.0

    def test_reverse_low_to_high(self):
        """Poor=1 reversed on 5-point scale: (5+1)-1 = 5."""
        result = compute_value("Poor", self.definition)
        assert result == 5.0

    def test_reverse_middle(self):
        """Good=3 reversed on 5-point scale: (5+1)-3 = 3."""
        result = compute_value("Good", self.definition)
        assert result == 3.0

    def test_reverse_excluded(self):
        """N/A excluded → None."""
        result = compute_value("N/A", self.definition)
        assert result is None

    def test_reverse_case_insensitive(self):
        result = compute_value("excellent", self.definition)
        assert result == 1.0

    def test_reverse_bulk_apply(self, db_session):
        """apply_definition_to_column reverses values in bulk."""
        project = Project(id=1, name="Reverse Test", user_id=1)
        db_session.add(project)
        db_session.flush()

        dataset = Dataset(id=1, project_id=1, name="Survey")
        db_session.add(dataset)
        db_session.flush()

        column = DatasetColumn(
            id=1, dataset_id=1, column_code="Q1", column_text="Rating",
            column_type="ordinal", sequence_order=0, display_order=0,
        )
        db_session.add(column)
        db_session.flush()

        values_data = ["Excellent", "Good", "Poor"]
        for i, val_text in enumerate(values_data, start=1):
            row = DatasetRow(id=i, dataset_id=1)
            db_session.add(row)
            db_session.flush()
            db_session.add(DatasetValue(
                row_id=i, column_id=1, value_text=val_text, value_numeric=None,
            ))
        db_session.flush()

        defn = RecodeDefinition(
            id=1, column_id=1, name="Reverse",
            recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
            mapping=json.dumps({"Excellent": 5, "Very Good": 4, "Good": 3, "Fair": 2, "Poor": 1}),
            exclude_values=json.dumps([]),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        )
        db_session.add(defn)
        db_session.flush()

        result = apply_definition_to_column(db_session, defn)
        db_session.flush()

        assert result["updated"] == 3

        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == 1)
            .order_by(DatasetValue.row_id)
            .all()
        )
        assert vals[0].value_numeric == 1.0   # Excellent: (5+1)-5 = 1
        assert vals[1].value_numeric == 3.0   # Good: (5+1)-3 = 3
        assert vals[2].value_numeric == 5.0   # Poor: (5+1)-1 = 5


# ═══════════════════════════════════════════════════════════════════════════════
# Tier 3 Session A — Router-level tests
# ═══════════════════════════════════════════════════════════════════════════════
#
# `test_recode.py` was originally service-layer only. Tier 3 Session A's tasks
# 1.6 (bulk_type_update recode-definition guard) and 1.7 (reverse-scored-columns
# lookup endpoint) are router-layer changes, so this file now has a router-test
# section using the _run(coro) pattern lifted from test_equivalence_1to1.py:50
# and test_analysis_domain_cross_dataset_pairing.py:64. See directive Phase 1.10
# Revision 5 note for the rationale.
# ═══════════════════════════════════════════════════════════════════════════════


import asyncio

from fastapi import HTTPException

from app.models.user import User
from app.routers.recode import bulk_type_update, list_reverse_scored_columns
from app.schemas.recode import BulkTypeUpdateRequest


def _run(coro):
    """Invoke an async router function synchronously — matches the pattern
    at test_equivalence_1to1.py:50 and test_analysis_domain_cross_dataset_pairing.py:64.
    """
    return asyncio.run(coro)


def _make_bulktype_scenario(db):
    """Project 600 with two datasets + a mix of columns (some with recodes)."""
    project = Project(id=600, name="BulkType Test", user_id=1)
    db.add(project)

    board = Dataset(id=600, project_id=600, name="Board")
    staff = Dataset(id=601, project_id=600, name="Staff")
    db.add_all([board, staff])
    db.flush()

    db.add_all([
        DatasetColumn(
            id=6001, dataset_id=600, column_code="B1", column_name="B1",
            column_text="Board Q1", column_type="ordinal",
            sequence_order=0, display_order=0,
        ),
        DatasetColumn(
            id=6002, dataset_id=600, column_code="B2", column_name="B2",
            column_text="Board Q2", column_type="ordinal",
            sequence_order=1, display_order=1,
        ),
        DatasetColumn(
            id=6003, dataset_id=600, column_code="B3", column_name="B3",
            column_text="Board Q3 (has reverse recode)", column_type="ordinal",
            sequence_order=2, display_order=2,
        ),
        DatasetColumn(
            id=6101, dataset_id=601, column_code="S1", column_name="S1",
            column_text="Staff Q1 (has recode)", column_type="ordinal",
            sequence_order=0, display_order=0,
        ),
    ])
    db.flush()

    # Recode definition on col 6003: reverse-scored
    db.add(RecodeDefinition(
        id=6001,
        column_id=6003,
        name="Reverse B3",
        recode_type=RecodeType.REVERSE,
        output_type=OutputType.NUMERIC,
        mapping=json.dumps({"Excellent": 5, "Good": 4, "Fair": 3, "Poor": 2}),
        exclude_values=json.dumps([]),
        is_primary=True,
        is_auto_detected=False,
        sequence_order=0,
    ))

    # Recode on col 6101: non-reverse (mapping type)
    db.add(RecodeDefinition(
        id=6002,
        column_id=6101,
        name="S1 Map",
        recode_type=RecodeType.SCALE_MAP,
        output_type=OutputType.NUMERIC,
        mapping=json.dumps({"Yes": 1, "No": 0}),
        exclude_values=json.dumps([]),
        is_primary=True,
        is_auto_detected=False,
        sequence_order=0,
    ))

    db.flush()
    user = db.query(User).filter(User.id == 1).one()
    return project, user


class TestBulkTypeUpdateGuard:
    """Tier 3 Session A Task 1.6 / GAP 3.9 — bulk_type_update recode guard."""

    def test_rejects_columns_with_recode_definitions(self, db_session):
        """Columns with any recode definition return 409 `recode_definitions_exist`."""
        project, user = _make_bulktype_scenario(db_session)

        with pytest.raises(HTTPException) as exc_info:
            _run(bulk_type_update(
                project_id=600,
                dataset_id=600,
                data=BulkTypeUpdateRequest(column_ids=[6001, 6003], column_type="nominal"),
                user=user,
                db=db_session,
            ))

        assert exc_info.value.status_code == 409
        detail = exc_info.value.detail
        assert isinstance(detail, dict)
        assert detail["error"] == "recode_definitions_exist"
        assert "recode definitions" in detail["message"]
        assert 6003 in detail["column_ids"]
        assert detail["recode_counts"]["6003"] == 1
        # 6001 has no recodes — must NOT be in the conflict list
        assert 6001 not in detail["column_ids"]

    def test_unguarded_columns_succeed(self, db_session):
        """Columns without recode definitions still update successfully."""
        project, user = _make_bulktype_scenario(db_session)

        result = _run(bulk_type_update(
            project_id=600,
            dataset_id=600,
            data=BulkTypeUpdateRequest(column_ids=[6001, 6002], column_type="nominal"),
            user=user,
            db=db_session,
        ))

        assert result["status"] == "ok"
        assert result["updated"] == 2

        # Verify the type actually changed
        col = db_session.query(DatasetColumn).filter(DatasetColumn.id == 6001).one()
        assert col.column_type.value == "nominal"

    def test_dataset_scoped_filter_excludes_other_datasets(self, db_session):
        """The guard's recode query is dataset-scoped — a column in ANOTHER
        dataset with a recode definition should NOT cause a false 409 for the
        current dataset's update. This matches the existing bulk_type_update
        dataset-scoping (foot-gun) — the guard must follow the same scope.
        """
        project, user = _make_bulktype_scenario(db_session)

        # Update dataset 600's columns. Column 6101 (dataset 601) has a recode
        # but is not in our column_ids anyway. We should succeed regardless of
        # unrelated dataset state.
        result = _run(bulk_type_update(
            project_id=600,
            dataset_id=600,
            data=BulkTypeUpdateRequest(column_ids=[6001, 6002], column_type="nominal"),
            user=user,
            db=db_session,
        ))
        assert result["updated"] == 2

        # Explicitly test: even if the caller passes a cross-dataset ID in
        # column_ids (which bulk_type_update silently filters out), the guard
        # should also only see the in-dataset subset, not raise on 6101.
        result2 = _run(bulk_type_update(
            project_id=600,
            dataset_id=600,
            data=BulkTypeUpdateRequest(column_ids=[6001, 6101], column_type="nominal"),
            user=user,
            db=db_session,
        ))
        # 6001 is already nominal from the previous call, so update count depends
        # on whether the router re-updates (it does). Key assertion: no raise.
        assert result2["status"] == "ok"


class TestReverseScoredColumns:
    """Tier 3 Session A Task 1.7 / GAP 3.6 — reverse-scored-columns endpoint."""

    def test_returns_columns_with_reverse_recodes(self, db_session):
        """Only columns with `recode_type='reverse'` are returned."""
        project, user = _make_bulktype_scenario(db_session)

        result = _run(list_reverse_scored_columns(
            project_id=600,
            user=user,
            db=db_session,
        ))

        assert result == {"column_ids": [6003]}

    def test_excludes_non_reverse_recodes(self, db_session):
        """Columns with MAPPING-type recodes are not included."""
        project, user = _make_bulktype_scenario(db_session)

        result = _run(list_reverse_scored_columns(
            project_id=600,
            user=user,
            db=db_session,
        ))

        # Column 6101 has a SCALE_MAP (non-reverse) recode — must NOT appear
        assert 6101 not in result["column_ids"]
        # Column 6003 has a REVERSE recode — must appear
        assert 6003 in result["column_ids"]

    def test_project_scoped_isolation(self, db_session):
        """Reverse recodes in a different project are not leaked."""
        _make_bulktype_scenario(db_session)

        # Build a second project with a reverse recode
        project2 = Project(id=601, name="Other", user_id=1)
        db_session.add(project2)
        ds2 = Dataset(id=700, project_id=601, name="Other DS")
        db_session.add(ds2)
        db_session.flush()
        col_other = DatasetColumn(
            id=7000, dataset_id=700, column_code="X1", column_name="X1",
            column_text="Other reverse", column_type="ordinal",
            sequence_order=0, display_order=0,
        )
        db_session.add(col_other)
        db_session.flush()
        db_session.add(RecodeDefinition(
            column_id=7000,
            name="X1 reverse",
            recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps({"Yes": 1, "No": 0}),
            exclude_values=json.dumps([]),
            is_primary=True,
            is_auto_detected=False,
            sequence_order=0,
        ))
        db_session.flush()

        user = db_session.query(User).filter(User.id == 1).one()

        # Query project 600 — should only see 6003, not 7000
        result = _run(list_reverse_scored_columns(
            project_id=600,
            user=user,
            db=db_session,
        ))
        assert 7000 not in result["column_ids"]
        assert 6003 in result["column_ids"]


# ═══════════════════════════════════════════════════════════════════════════════
# #359 — REVERSE recode must apply value_numeric via the router
# ═══════════════════════════════════════════════════════════════════════════════
#
# Regression for the scenario-3 smoking gun: a REVERSE definition created/promoted
# through the router never updated value_numeric (the create gate, set_primary, the
# update path, and delete-then-promote all special-cased only SCALE_MAP). The
# service-layer reverse math was correct and unit-tested (TestReverseRecode above) —
# only the four router callsites were wrong, which collapsed Cronbach's α on
# reverse-scored subscales. Now centralized in _recompute_primary_value_numeric.
# (Recreated here — the original lived in /tmp and didn't survive the session.)

from app.routers.recode import create_definition, set_primary
from app.schemas.recode import RecodeDefinitionCreate


def _setup_reverse_router_column(db, *, with_scale_map_primary: bool):
    """Project/dataset/column (id 7700) with 3 ordinal cells:
    Strongly Disagree, Neutral, Strongly Agree (rows 7701..7703).

    If with_scale_map_primary, also create + apply an auto-detected SCALE_MAP
    primary so value_numeric starts at 1/3/5 — mirroring the real flow where a
    Likert column is auto-mapped before the user adds a reverse.
    """
    project = Project(id=7700, name="Reverse Router", user_id=1)
    db.add(project)
    db.flush()
    dataset = Dataset(id=7700, project_id=7700, name="Survey")
    db.add(dataset)
    db.flush()
    col = DatasetColumn(
        id=7700, dataset_id=7700, column_code="AO6", column_name="AO6",
        column_text="AO6 (reverse-worded)", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()

    labels = ["Strongly Disagree", "Neutral", "Strongly Agree"]
    for i, label in enumerate(labels):
        row = DatasetRow(id=7701 + i, dataset_id=7700)
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=7700, value_text=label, value_numeric=None))
    db.flush()

    mapping = {"Strongly Disagree": 1, "Neutral": 3, "Strongly Agree": 5}
    if with_scale_map_primary:
        sm = RecodeDefinition(
            id=7700, column_id=7700, name="AO6 scale", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            exclude_values=json.dumps([]), is_primary=True, is_auto_detected=True,
            sequence_order=0,
        )
        db.add(sm)
        db.flush()
        apply_definition_to_column(db, sm)
        db.flush()
    return mapping


def _numeric_by_label(db):
    """Return {value_text: value_numeric} for column 7700, ordered by row."""
    return {
        v.value_text: v.value_numeric
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == 7700).all()
    }


class TestReverseRecodeAppliesViaRouter:
    """#359 — the four router callsites must apply REVERSE, not clear/ignore it."""

    def test_reverse_promoted_via_set_primary_reverses_values(self, db_session):
        """Auto SCALE_MAP primary applied (1/3/5); add a non-primary REVERSE;
        promote it via set-primary → values must flip to 5/3/1."""
        mapping = _setup_reverse_router_column(db_session, with_scale_map_primary=True)
        user = db_session.query(User).filter(User.id == 1).one()

        # Sanity: scale_map applied the forward mapping.
        assert _numeric_by_label(db_session)["Strongly Disagree"] == 1.0

        # User creates a REVERSE definition (lands non-primary — a primary exists).
        reverse = _run(create_definition(
            project_id=7700, dataset_id=7700, column_id=7700,
            data=RecodeDefinitionCreate(
                name="AO6 Reverse", recode_type="reverse", output_type="numeric",
                mapping=mapping, exclude_values=[],
            ),
            user=user, db=db_session,
        ))
        assert reverse.is_primary is False
        # Still forward — non-primary create doesn't apply.
        assert _numeric_by_label(db_session)["Strongly Disagree"] == 1.0

        # Promote the reverse to primary.
        _run(set_primary(
            project_id=7700, dataset_id=7700, column_id=7700,
            definition_id=reverse.id, user=user, db=db_session,
        ))

        nums = _numeric_by_label(db_session)
        assert nums["Strongly Disagree"] == 5.0   # (5+1)-1
        assert nums["Neutral"] == 3.0              # (5+1)-3
        assert nums["Strongly Agree"] == 1.0       # (5+1)-5

    def test_reverse_created_as_first_primary_reverses_values(self, db_session):
        """No prior primary → a REVERSE created via the router becomes primary
        and applies immediately."""
        mapping = _setup_reverse_router_column(db_session, with_scale_map_primary=False)
        user = db_session.query(User).filter(User.id == 1).one()

        created = _run(create_definition(
            project_id=7700, dataset_id=7700, column_id=7700,
            data=RecodeDefinitionCreate(
                name="AO6 Reverse", recode_type="reverse", output_type="numeric",
                mapping=mapping, exclude_values=[],
            ),
            user=user, db=db_session,
        ))
        assert created.is_primary is True

        nums = _numeric_by_label(db_session)
        assert nums["Strongly Disagree"] == 5.0
        assert nums["Strongly Agree"] == 1.0
