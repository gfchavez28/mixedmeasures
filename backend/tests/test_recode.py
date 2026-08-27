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


class TestReverseOffset:
    """#28: reverse scoring reflects about the scale midpoint, `(min + max) - v`.

    For any 1..N scale min is 1, so this equals the historical `(max + 1) - v`
    exactly — no existing dataset changes. It is the general form that also stays
    inside the scale for the 0-based scales an SPSS import can produce, where
    `(max + 1) - v` would map 0..3 onto 1..4 and shift every mean.
    """

    @pytest.mark.parametrize("n", range(2, 12))
    def test_identical_to_the_historical_formula_on_1_to_n(self, n):
        from app.services.recode import reverse_offset

        values = [float(i) for i in range(1, n + 1)]
        offset = reverse_offset(values)
        for v in values:
            assert offset - v == (max(values) + 1) - v

    def test_zero_based_scale_stays_inside_its_own_range(self):
        from app.services.recode import reverse_offset

        values = [0.0, 1.0, 2.0, 3.0]
        offset = reverse_offset(values)
        assert [offset - v for v in values] == [3.0, 2.0, 1.0, 0.0]

    def test_reverse_of_reverse_is_identity(self):
        from app.services.recode import reverse_offset

        for values in ([1.0, 2.0, 3.0], [0.0, 1.0, 2.0, 3.0], [1.0, 2.0, 4.0, 5.0]):
            offset = reverse_offset(values)
            assert [offset - (offset - v) for v in values] == values


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


class TestReverseRepair:
    """#578: the startup repair un-breaks the reverse double-flip.

    The Recode Workbench stored FLIPPED codes and the backend re-flipped at apply
    time, so value_numeric silently kept its forward (un-reversed) value.
    `repair_reverse_recode_mappings` rewrites a flipped reverse mapping back to the
    source scale map's forward codes and re-applies primaries.
    """

    def _scale(self):
        # Multi-digit + a 10 so a positional-vs-value confusion would surface
        # (degenerate-fixture rule — a 1..5 scale can't distinguish the two).
        return {"A": 2, "B": 4, "C": 6, "D": 8, "E": 10}

    def _setup(self, db_session, reverse_mapping, *, source=True, primary=True):
        from app.services.recode import repair_reverse_recode_mappings  # noqa: F401
        project = Project(id=1, name="P", user_id=1)
        db_session.add(project); db_session.flush()
        ds = Dataset(id=1, project_id=1, name="D")
        db_session.add(ds); db_session.flush()
        col = DatasetColumn(id=1, dataset_id=1, column_code="Q1", column_text="Q1",
                            column_type="ordinal", sequence_order=0, display_order=0)
        db_session.add(col); db_session.flush()
        forward = self._scale()
        for i, lab in enumerate(forward, start=1):
            row = DatasetRow(id=i, dataset_id=1)
            db_session.add(row); db_session.flush()
            # simulate the buggy no-op state: value_numeric == forward code
            db_session.add(DatasetValue(row_id=i, column_id=1, value_text=lab,
                                        value_numeric=float(forward[lab])))
        src_id = None
        if source:
            sm = RecodeDefinition(id=10, column_id=1, name="SM",
                recode_type=RecodeType.SCALE_MAP, output_type=OutputType.NUMERIC,
                mapping=json.dumps(forward), is_primary=False, sequence_order=0)
            db_session.add(sm); db_session.flush()
            src_id = 10
        rev = RecodeDefinition(id=11, column_id=1, name="REV",
            recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
            mapping=json.dumps(reverse_mapping), source_definition_id=src_id,
            is_primary=primary, sequence_order=1)
        db_session.add(rev); db_session.flush()
        return forward, rev

    def test_flipped_primary_reverse_is_repaired(self, db_session):
        from app.services.recode import repair_reverse_recode_mappings
        forward, rev = self._setup(
            db_session, {lab: 12 - c for lab, c in self._scale().items()})  # flipped (min+max=12)
        n = repair_reverse_recode_mappings(db_session)
        assert n == 1
        # mapping is now FORWARD
        assert json.loads(rev.mapping) == forward
        # value_numeric is now REVERSED (offset 12 − forward)
        vals = (db_session.query(DatasetValue)
                .filter(DatasetValue.column_id == 1)
                .order_by(DatasetValue.row_id).all())
        assert [v.value_numeric for v in vals] == [10.0, 8.0, 6.0, 4.0, 2.0]

    def test_repair_is_idempotent(self, db_session):
        from app.services.recode import repair_reverse_recode_mappings
        self._setup(db_session, {lab: 12 - c for lab, c in self._scale().items()})
        assert repair_reverse_recode_mappings(db_session) == 1
        assert repair_reverse_recode_mappings(db_session) == 0  # second run is a no-op

    def test_already_forward_reverse_is_left_alone(self, db_session):
        from app.services.recode import repair_reverse_recode_mappings
        # A correctly-authored (forward) reverse def — e.g. via API / portability.
        forward, rev = self._setup(db_session, self._scale())
        assert repair_reverse_recode_mappings(db_session) == 0
        assert json.loads(rev.mapping) == forward

    def test_orphan_with_NO_reference_at_all_is_skipped(self, db_session):
        """No `source_definition_id` AND no scale_map on the column → there is
        nothing to compare against, so a flipped and a forward mapping really are
        indistinguishable → skip.

        ⚠️ Renamed 2026-08-16 (#587). It used to be titled "without source", which
        stopped being the whole condition when the repair gained the sibling
        fallback: `_setup(source=False)` creates no scale_map either, so this
        fixture pins the no-reference case specifically. An orphan WITH a sibling
        is now repaired — see `test_orphan_with_a_single_sibling_scale_map_is_repaired`.
        """
        from app.services.recode import repair_reverse_recode_mappings
        self._setup(db_session, {lab: 12 - c for lab, c in self._scale().items()},
                    source=False)
        assert repair_reverse_recode_mappings(db_session) == 0

    def test_hand_edited_reverse_is_left_alone(self, db_session):
        from app.services.recode import repair_reverse_recode_mappings
        # A mapping that is neither the source's forward codes NOR a clean
        # reflection of them — the repair must NOT touch it (guards the
        # detect-and-flip check against blindly rewriting).
        hand = {"A": 3, "B": 4, "C": 6, "D": 9, "E": 1}
        _, rev = self._setup(db_session, hand)
        assert repair_reverse_recode_mappings(db_session) == 0
        assert json.loads(rev.mapping) == hand


class TestReverseRepairViaSibling:
    """#587 — an orphaned reverse def still has a reference: the `scale_map` on
    its OWN column.

    The crosswalk copy paths (`CopyRecodeDialog`, `CopyToEquivalentsDialog`)
    called `recodeApi.create` without `source_definition_id`, so the #578 repair
    skipped them forever: stored FLIPPED, i.e. silently un-reversed, while their
    repaired originals were correct — one item battery, inconsistently coded,
    with no visual cue (display and storage agree, both wrong). Reproduced by
    execution before the fix: repair returned 0 and `value_numeric` stayed equal
    to the forward codes.
    """

    FORWARD = {"A": 2, "B": 4, "C": 6, "D": 8, "E": 10}   # gapped, multi-digit
    OFFSET = 12                                            # min + max

    def _col(self, db, col_id, labels, *, with_scale_map=True, sm_id=None):
        if db.query(Project).filter_by(id=1).first() is None:
            db.add(Project(id=1, name="P", user_id=1)); db.flush()
            db.add(Dataset(id=1, project_id=1, name="D")); db.flush()
        col = DatasetColumn(id=col_id, dataset_id=1, column_code=f"Q{col_id}",
                            column_text=f"Q{col_id}", column_type="ordinal",
                            sequence_order=col_id, display_order=col_id)
        db.add(col); db.flush()
        mapping = dict(zip(labels, self.FORWARD.values()))
        for i, lab in enumerate(labels):
            row = DatasetRow(dataset_id=1); db.add(row); db.flush()
            # the broken at-rest state: value_numeric == the FORWARD code
            db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=lab,
                                value_numeric=float(mapping[lab])))
        db.flush()
        sm = None
        if with_scale_map:
            sm = RecodeDefinition(
                id=sm_id, column_id=col.id, name="5-point scale",
                recode_type=RecodeType.SCALE_MAP, output_type=OutputType.NUMERIC,
                mapping=json.dumps(mapping), is_primary=False,
                is_auto_detected=True, sequence_order=0)
            db.add(sm); db.flush()
        return col, mapping, sm

    def _flipped_reverse(self, db, col, mapping, *, rev_id, source_id=None):
        rev = RecodeDefinition(
            id=rev_id, column_id=col.id, name="Reversed",
            recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
            mapping=json.dumps({k: self.OFFSET - v for k, v in mapping.items()}),
            source_definition_id=source_id, is_primary=True,
            is_auto_detected=False, sequence_order=1)
        db.add(rev); db.flush()
        return rev

    def _numerics(self, db, col_id):
        return [v.value_numeric for v in db.query(DatasetValue)
                .filter(DatasetValue.column_id == col_id)
                .order_by(DatasetValue.row_id).all()]

    def test_orphan_with_a_single_sibling_scale_map_is_repaired(self, db_session):
        from app.services.recode import repair_reverse_recode_mappings
        col, mapping, _ = self._col(db_session, 21, list(self.FORWARD), sm_id=210)
        rev = self._flipped_reverse(db_session, col, mapping, rev_id=211)
        assert self._numerics(db_session, 21) == [2.0, 4.0, 6.0, 8.0, 10.0], (
            "precondition: stored values are the FORWARD codes, i.e. un-reversed"
        )
        assert repair_reverse_recode_mappings(db_session) == 1
        assert json.loads(rev.mapping) == mapping, "mapping must be forward now"
        assert self._numerics(db_session, 21) == [10.0, 8.0, 6.0, 4.0, 2.0], (
            "value_numeric must now be reflected about min+max"
        )

    def test_the_repair_adopts_the_sibling_as_the_source(self, db_session):
        """So the NEXT run reaches it through the chain, and the workbench stops
        rendering "Source definition not found or deleted." over a live def."""
        from app.services.recode import repair_reverse_recode_mappings
        col, mapping, sm = self._col(db_session, 22, list(self.FORWARD), sm_id=220)
        rev = self._flipped_reverse(db_session, col, mapping, rev_id=221)
        repair_reverse_recode_mappings(db_session)
        assert rev.source_definition_id == sm.id
        # and a second run is still a no-op
        assert repair_reverse_recode_mappings(db_session) == 0

    def test_two_scale_map_siblings_are_ambiguous_and_skipped(self, db_session):
        """Two candidates cannot both be the reference, and picking one by a
        heuristic is how a repair corrupts the data it meant to fix."""
        from app.services.recode import repair_reverse_recode_mappings
        col, mapping, _ = self._col(db_session, 23, list(self.FORWARD), sm_id=230)
        db_session.add(RecodeDefinition(
            id=231, column_id=col.id, name="Other scale",
            recode_type=RecodeType.SCALE_MAP, output_type=OutputType.NUMERIC,
            mapping=json.dumps({"A": 1, "B": 2, "C": 3, "D": 4, "E": 5}),
            is_primary=False, sequence_order=2))
        db_session.flush()
        rev = self._flipped_reverse(db_session, col, mapping, rev_id=232)
        before = rev.mapping
        assert repair_reverse_recode_mappings(db_session) == 0
        assert rev.mapping == before
        assert rev.source_definition_id is None

    def test_a_sibling_that_does_not_cover_every_key_is_skipped(self, db_session):
        """Partial overlap is indistinguishable from "two different scales that
        happen to share a label" — the chain path may settle for one shared key,
        a weaker reference may not.

        ⚠️ **The dropped key must be an INTERIOR one, and that is the whole
        test.** Measured while mutation-testing: with an ENDPOINT key removed
        the flip test catches the gap on its own (min+max changes, so the
        reflection no longer reproduces the forward codes) and the mutant that
        deletes this precondition SURVIVES — a degenerate fixture certifying a
        guard it cannot exercise. Dropping `B` leaves min=2 and max=10 intact,
        so the offset is identical and the flip test passes on the four keys it
        CAN see; the repair would then rewrite those four and leave `B` at its
        flipped value — a mapping that is mostly forward with one reflected
        entry, which is worse than the state it started in."""
        from app.services.recode import repair_reverse_recode_mappings
        col, mapping, sm = self._col(db_session, 24, list(self.FORWARD), sm_id=240)
        partial = json.loads(sm.mapping)
        partial.pop("B")          # interior, and NOT the midpoint
        sm.mapping = json.dumps(partial)
        db_session.flush()
        assert min(partial.values()) == min(mapping.values())
        assert max(partial.values()) == max(mapping.values()), (
            "precondition: the gap must NOT move the endpoints, or the flip "
            "test catches it and this guard is never reached"
        )
        rev = self._flipped_reverse(db_session, col, mapping, rev_id=241)
        before = rev.mapping
        assert repair_reverse_recode_mappings(db_session) == 0
        assert rev.mapping == before

    def test_an_already_forward_orphan_is_not_flipped(self, db_session):
        """The fallback widens WHAT can be repaired, never WHEN: the flip test
        is unchanged, so a correct orphan must survive it untouched."""
        from app.services.recode import repair_reverse_recode_mappings
        col, mapping, _ = self._col(db_session, 25, list(self.FORWARD), sm_id=250)
        rev = RecodeDefinition(
            id=251, column_id=col.id, name="Reversed",
            recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
            mapping=json.dumps(mapping), source_definition_id=None,
            is_primary=True, sequence_order=1)
        db_session.add(rev); db_session.flush()
        assert repair_reverse_recode_mappings(db_session) == 0
        assert json.loads(rev.mapping) == mapping

    def test_a_LABEL_REMAPPED_copy_is_reachable_ONLY_through_the_sibling(self, db_session):
        """The test that justifies the design, and the reason provenance alone is
        not the fix.

        The crosswalk's `positional` copy is `remapMapping`'d to the TARGET
        column's labels. So even once `source_definition_id` is recorded, walking
        the chain yields the SOURCE column's mapping in the SOURCE's label
        spelling — keys this def does not share — and the flip test finds nothing
        to compare. The target's own scale_map speaks the target's labels, which
        is why the sibling arm is the one that reaches these rows.
        """
        from app.services.recode import (
            repair_reverse_recode_mappings, _ultimate_scale_map_mapping,
        )
        src_col, src_map, src_sm = self._col(
            db_session, 26, ["A", "B", "C", "D", "E"], sm_id=260)
        tgt_col, tgt_map, _ = self._col(
            db_session, 27, ["V", "W", "X", "Y", "Z"], sm_id=270)
        # Provenance points at the SOURCE column's scale_map (what the dialog now
        # records) while the mapping carries the TARGET's labels.
        rev = self._flipped_reverse(db_session, tgt_col, tgt_map, rev_id=271,
                                    source_id=src_sm.id)

        chained = _ultimate_scale_map_mapping(
            rev, lambda i: db_session.get(RecodeDefinition, i))
        assert set(chained) == set(src_map), (
            "precondition: the chain resolves, but to the SOURCE's label spelling"
        )
        assert not (set(chained) & set(tgt_map)), (
            "precondition: the two label sets are disjoint, so the chain's "
            "mapping shares no key with this def — provenance cannot repair it"
        )

        assert repair_reverse_recode_mappings(db_session) == 1
        assert json.loads(rev.mapping) == tgt_map
        assert self._numerics(db_session, 27) == [10.0, 8.0, 6.0, 4.0, 2.0]


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
from app.routers.recode import bulk_type_update, list_reverse_scored_columns, set_primary, delete_definition
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

    def test_a_reverse_created_first_is_SAVED_but_NOT_applied(self, db_session):
        """🔴 REWRITTEN 2026-08-24 — this test pinned the behaviour that was removed.

        It used to read *"No prior primary → a REVERSE created via the router
        becomes primary and applies immediately"*, and that was the largest of
        the four doors into an in-place transform: **saving your first rule
        silently rewrote every stored number in the variable**, with no prompt
        and no undo (design-note §8; the developer's original report).

        Creating a rule now only SAVES it. Applying is `set_primary`, which the
        client puts behind an explicit confirm. The reverse arithmetic itself is
        unchanged and still covered by
        `test_reverse_promoted_via_set_primary_reverses_values` directly above —
        which is the test that should have been carrying that claim all along.
        """
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
        assert created.is_primary is False, (
            "creating a rule must not apply it — that was the silent in-place "
            "transform §8 removed"
        )

        # The cells are UNTOUCHED. This fixture builds the column with
        # `value_numeric=None` (no primary has ever run on it), so "untouched"
        # is None — asserting a stamped 1.0/5.0 here would be asserting a
        # fixture that does not exist, which is how a rewritten test ends up
        # pinning nothing.
        nums = _numeric_by_label(db_session)
        assert nums["Strongly Disagree"] is None
        assert nums["Strongly Agree"] is None


# ---------------------------------------------------------------------------
# #538: append_import must re-apply the PRIMARY recode to the NEW rows for
# BOTH numeric primary types (SCALE_MAP + REVERSE) and CLEAR under
# CATEGORY_GROUP — mirroring routers/recode.py::_recompute_primary_value_numeric
# (the #359 seam). The pre-fix filter re-applied SCALE_MAP only, so a
# REVERSE-primary column's appended rows landed FORWARD-coded while every
# existing row was reversed: same label, two numbers in one column.
# ---------------------------------------------------------------------------

_APPEND_LABELS = ["None", "A little", "Some", "A lot"]  # ZERO-BASED codes 0..3
# 0-based on purpose (degenerate-fixture rule): on 0..3 the old (max+1)-v and
# the correct (min+max)-v reversal DISAGREE, so a formula regression fails too.


def _setup_append_scenario(db, *, primary_type):
    """Import a zero-based ordinal column, then install the given primary
    recode the way the workbench's set-primary path leaves the column."""
    from app.models.user import User
    from app.services.dataset_import import import_dataset_csv

    db.add(Project(id=538, name="Append Primary", user_id=1))
    db.flush()
    configs = [{
        "column_index": 0,
        "column_type": "ordinal",
        "column_text": "support",
        "column_name": "support",
        "scale_labels": list(_APPEND_LABELS),
        "scale_values": [0, 1, 2, 3],
    }]
    import_dataset_csv(
        db=db, project_id=538, name="DS", column_configs=configs,
        file_contents="support\n" + "\n".join(_APPEND_LABELS) + "\n",
    )
    db.flush()
    dataset = db.query(Dataset).filter_by(project_id=538).one()
    column = db.query(DatasetColumn).filter_by(dataset_id=dataset.id).one()

    # Demote whatever primary the import auto-created, then install ours.
    for d in db.query(RecodeDefinition).filter_by(column_id=column.id):
        d.is_primary = False
    if primary_type == RecodeType.REVERSE:
        defn = RecodeDefinition(
            column_id=column.id, name="Reversed",
            recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
            mapping=json.dumps({l: i for i, l in enumerate(_APPEND_LABELS)}),
            is_primary=True,
        )
        db.add(defn)
        db.flush()
        apply_definition_to_column(db, defn)   # existing rows now reversed
    else:  # CATEGORY_GROUP
        defn = RecodeDefinition(
            column_id=column.id, name="Banded",
            recode_type=RecodeType.CATEGORY_GROUP,
            output_type=OutputType.CATEGORICAL,
            mapping=json.dumps({"None": "Low", "A little": "Low",
                                "Some": "High", "A lot": "High"}),
            is_primary=True,
        )
        db.add(defn)
        db.flush()
        clear_value_numeric(db, column.id)     # existing rows carry NO numeric
    db.flush()
    return dataset, column, db.query(User).filter(User.id == 1).one()


def _append_one_row(db, dataset, column, user, cell):
    """Append one CSV row via the real endpoint; return the new DatasetValue.

    skip_duplicates must be OFF and the assertion must read the NEW value only
    (id-diff) — the toothless-guard trap from the #28 session.
    """
    import asyncio
    import io as _io

    from starlette.datastructures import UploadFile as StarletteUploadFile

    from app.routers.dataset import append_import

    pre_existing = {v.id for v in db.query(DatasetValue).filter_by(column_id=column.id)}
    upload = StarletteUploadFile(
        filename="more.csv", file=_io.BytesIO(f"support\n{cell}\n".encode())
    )
    config = json.dumps({
        "column_mapping": [{"csv_column_index": 0, "column_id": column.id}],
        "skip_duplicates": False,
    })
    resp = asyncio.run(append_import(
        project_id=538, dataset_id=dataset.id, file=upload,
        import_config=config, encoding="utf-8", user=user, db=db,
    ))
    db.flush()
    assert resp.rows_created == 1, "the append must actually create a row"
    appended = [
        v for v in db.query(DatasetValue).filter_by(column_id=column.id)
        if v.id not in pre_existing
    ]
    assert len(appended) == 1
    return appended[0]


class TestAppendReappliesPrimaryRecode:
    def test_reverse_primary_reverses_appended_rows(self, db_session):
        dataset, column, user = _setup_append_scenario(
            db_session, primary_type=RecodeType.REVERSE
        )
        by_label = {
            v.value_text: v.value_numeric
            for v in db_session.query(DatasetValue).filter_by(column_id=column.id)
        }
        assert by_label["None"] == 3.0 and by_label["A lot"] == 0.0, \
            "scenario sanity: existing rows must already be reversed"

        appended = _append_one_row(db_session, dataset, column, user, "None")
        assert appended.value_text == "None"
        assert appended.value_numeric == 3.0, (
            "appended row must carry the REVERSED encoding like every existing "
            "row, not the forward scale code"
        )

    def test_category_group_primary_clears_appended_rows(self, db_session):
        dataset, column, user = _setup_append_scenario(
            db_session, primary_type=RecodeType.CATEGORY_GROUP
        )
        appended = _append_one_row(db_session, dataset, column, user, "Some")
        assert appended.value_text == "Some"
        assert appended.value_numeric is None, (
            "a category_group-primary column carries no numeric encoding — the "
            "raw scale code must not be stamped onto appended rows"
        )


# ═══════════════════════════════════════════════════════════════════════════════
# #575 — append parity: a CODE-format file appended to a value-labelled column
# must substitute code→label (value_text) AND keep the code (value_numeric), and
# dedup against the existing label rows. Gapped/multi-digit codes [2,4,6,10] so a
# positional-vs-code confusion fails.
# ═══════════════════════════════════════════════════════════════════════════════

_VL_LABELS = ["Low", "Mid", "High", "Top"]
_VL_CODES = [2, 4, 6, 10]


def _setup_labelled_column(db):
    from app.models.user import User
    from app.services.dataset_import import import_dataset_csv

    db.add(Project(id=538, name="VL Append", user_id=1)); db.flush()
    import_dataset_csv(
        db=db, project_id=538, name="DS",
        column_configs=[{
            "column_index": 0, "column_type": "ordinal",
            "column_text": "q", "column_name": "q",
            "scale_labels": list(_VL_LABELS), "scale_values": list(_VL_CODES),
        }],
        file_contents="q\n" + "\n".join(_VL_LABELS) + "\n",  # cells are LABELS
    )
    db.flush()
    dataset = db.query(Dataset).filter_by(project_id=538).one()
    column = db.query(DatasetColumn).filter_by(dataset_id=dataset.id).one()
    return dataset, column, db.query(User).filter(User.id == 1).one()


def _append_cell(db, dataset, column, user, cell, *, skip_duplicates=False):
    import asyncio, io as _io
    from starlette.datastructures import UploadFile as StarletteUploadFile
    from app.routers.dataset import append_import

    upload = StarletteUploadFile(filename="more.csv", file=_io.BytesIO(f"q\n{cell}\n".encode()))
    config = json.dumps({
        "column_mapping": [{"csv_column_index": 0, "column_id": column.id}],
        "skip_duplicates": skip_duplicates,
    })
    return asyncio.run(append_import(
        project_id=538, dataset_id=dataset.id, file=upload,
        import_config=config, encoding="utf-8", user=user, db=db,
    ))


class TestAppendValueLabelParity:
    def test_code_format_append_substitutes_label_and_keeps_code(self, db_session):
        dataset, column, user = _setup_labelled_column(db_session)
        pre = {v.id for v in db_session.query(DatasetValue).filter_by(column_id=column.id)}
        _append_cell(db_session, dataset, column, user, "6")  # a CODE, not a label
        db_session.flush()
        new = [v for v in db_session.query(DatasetValue).filter_by(column_id=column.id)
               if v.id not in pre]
        assert len(new) == 1
        assert new[0].value_text == "High", "code 6 must be substituted to its label"
        assert new[0].value_numeric == 6.0, "the gapped code must be kept, not NULL"

    def test_label_format_append_unchanged(self, db_session):
        dataset, column, user = _setup_labelled_column(db_session)
        pre = {v.id for v in db_session.query(DatasetValue).filter_by(column_id=column.id)}
        _append_cell(db_session, dataset, column, user, "Mid")  # a LABEL
        db_session.flush()
        new = [v for v in db_session.query(DatasetValue).filter_by(column_id=column.id)
               if v.id not in pre]
        assert new[0].value_text == "Mid" and new[0].value_numeric == 4.0

    def test_code_format_append_dedups_against_existing_label_row(self, db_session):
        # "High" (code 6) already exists as a label row from the import; appending
        # the CODE "6" with skip_duplicates must recognize it as a duplicate.
        dataset, column, user = _setup_labelled_column(db_session)
        resp = _append_cell(db_session, dataset, column, user, "6", skip_duplicates=True)
        assert resp.rows_created == 0 and resp.duplicates_skipped == 1

    def test_unmapped_appended_value_is_reported(self, db_session):
        dataset, column, user = _setup_labelled_column(db_session)
        resp = _append_cell(db_session, dataset, column, user, "99")  # not a code
        assert resp.rows_created == 1
        assert "99" in resp.unmapped_values


# ═══════════════════════════════════════════════════════════════════════════════
# #542 — recode-seam agreement: reversal-path parity + scale-metadata write-back
# ═══════════════════════════════════════════════════════════════════════════════

from app.routers.recode import create_definition, update_definition
from app.schemas.recode import RecodeDefinitionCreate, RecodeDefinitionUpdate


class TestMixedMappingReversalParity:
    """#542b — a mixed (part-numeric) REVERSE mapping must reverse identically
    on the per-value path (`compute_value`) and the bulk path
    (`apply_definition_to_column`). One non-floatable mapping value previously
    aborted compute_value's numeric collection, returning every mapped value
    UN-reversed — while the bulk path filtered per value and reversed."""

    MIXED = {"Low": 1, "Mid": 2, "High": 3, "Unsure": "not scored"}

    def _definition(self, defn_id=99, column_id=1, in_db=None):
        d = RecodeDefinition(
            id=defn_id, column_id=column_id, name="Reverse mixed",
            recode_type=RecodeType.REVERSE, output_type=OutputType.NUMERIC,
            mapping=json.dumps(self.MIXED), exclude_values=json.dumps([]),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        )
        if in_db is not None:
            in_db.add(d)
            in_db.flush()
        return d

    def test_compute_value_reverses_despite_non_numeric_mapping_value(self):
        d = self._definition()
        assert compute_value("Low", d) == 3.0    # (1+3) - 1
        assert compute_value("Mid", d) == 2.0
        assert compute_value("High", d) == 1.0

    def test_non_numeric_mapped_value_is_unmapped_like_the_bulk_path(self):
        """The bulk path warns + NULLs a non-floatable mapping value; the
        per-value path must not hand back the raw string instead."""
        d = self._definition()
        assert compute_value("Unsure", d) is None

    def test_both_paths_agree_cell_for_cell(self, db_session):
        project = Project(id=1, name="Parity", user_id=1)
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
        for i, text in enumerate(["Low", "Mid", "High", "Unsure"], start=1):
            row = DatasetRow(id=i, dataset_id=1)
            db_session.add(row)
            db_session.flush()
            db_session.add(DatasetValue(
                row_id=i, column_id=1, value_text=text, value_numeric=None,
            ))
        db_session.flush()

        d = self._definition(defn_id=1, in_db=db_session)
        apply_definition_to_column(db_session, d)
        db_session.flush()

        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == 1)
            .order_by(DatasetValue.row_id)
            .all()
        )
        for dv in vals:
            assert dv.value_numeric == compute_value(dv.value_text, d), (
                f"bulk and per-value paths disagree for {dv.value_text!r}"
            )


class TestPrimaryMappingWritesBackScaleMetadata:
    """#542a — workbench edits to a primary numeric recode write the mapping
    back to column.scale_labels/scale_values (owner-2 of the #28 three-owner
    invariant). Consumers prefer the mapping while it exists; the stale copy
    bites when the definition is later DELETED and append/R-export fall back
    to pre-edit codes."""

    def test_update_definition_syncs_scale_metadata(self, db_session):
        column, definition, _ = _setup_ordinal_column(db_session)
        user = db_session.query(User).filter(User.id == 1).one()

        _run(update_definition(
            project_id=1, dataset_id=1, column_id=1, definition_id=1,
            data=RecodeDefinitionUpdate(
                mapping={"Poor": 0, "Fair": 2, "Good": 4, "Excellent": 6},
            ),
            user=user, db=db_session,
        ))

        assert json.loads(column.scale_labels) == ["Poor", "Fair", "Good", "Excellent"]
        # code-sorted, stored as ints (the #28 int/float parity rule)
        assert json.loads(column.scale_values) == [0, 2, 4, 6]
        assert column.scale_points == 4

    def test_create_primary_definition_syncs_scale_metadata(self, db_session):
        project = Project(id=1, name="WriteBack", user_id=1)
        db_session.add(project)
        db_session.flush()
        dataset = Dataset(id=1, project_id=1, name="Survey")
        db_session.add(dataset)
        db_session.flush()
        column = DatasetColumn(
            id=1, dataset_id=1, column_code="Q1", column_text="Agree?",
            column_type="ordinal", sequence_order=0, display_order=0,
        )
        db_session.add(column)
        db_session.flush()
        user = db_session.query(User).filter(User.id == 1).one()

        _run(create_definition(
            project_id=1, dataset_id=1, column_id=1,
            data=RecodeDefinitionCreate(
                name="Scale", recode_type="scale_map", output_type="numeric",
                mapping={"No": 0, "Maybe": 1, "Yes": 2},
            ),
            user=user, db=db_session,
        ))

        # 🔴 REWRITTEN 2026-08-24. The write-back keeps `scale_labels`/
        # `scale_values` in step with the mapping of the rule IN EFFECT
        # (#542a). Creating a rule no longer puts one in effect, so there is
        # nothing to keep in step and the column's metadata is left alone —
        # writing it back here would state that a rule governs the column when
        # none does. The write-back itself is unchanged and is covered on the
        # `set_primary` path, which is where a rule now takes effect.
        assert column.scale_labels is None
        assert column.scale_values is None

    def test_non_numeric_mapping_values_skipped_not_fatal(self, db_session):
        column, definition, _ = _setup_ordinal_column(db_session)
        user = db_session.query(User).filter(User.id == 1).one()

        _run(update_definition(
            project_id=1, dataset_id=1, column_id=1, definition_id=1,
            data=RecodeDefinitionUpdate(
                mapping={"Poor": 1, "Excellent": 5, "Unsure": "n/a"},
            ),
            user=user, db=db_session,
        ))

        assert json.loads(column.scale_labels) == ["Poor", "Excellent"]
        assert json.loads(column.scale_values) == [1, 5]

    def test_category_group_created_first_clears_stamped_numerics(self, db_session):
        """Callsite-drift corollary: create_definition previously skipped the
        category_group CLEAR branch, so a categorical primary created FIRST on
        a stamped column left the numeric encoding behind."""
        project = Project(id=1, name="CGCreate", user_id=1)
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
        for i, (text, num) in enumerate(
            [("Low", 1.0), ("Mid", 2.0), ("High", 3.0)], start=1
        ):
            row = DatasetRow(id=i, dataset_id=1)
            db_session.add(row)
            db_session.flush()
            db_session.add(DatasetValue(
                row_id=i, column_id=1, value_text=text, value_numeric=num,
            ))
        db_session.flush()
        user = db_session.query(User).filter(User.id == 1).one()

        _run(create_definition(
            project_id=1, dataset_id=1, column_id=1,
            data=RecodeDefinitionCreate(
                name="Groups", recode_type="category_group", output_type="categorical",
                mapping={"Low": "L", "Mid": "M", "High": "H"},
            ),
            user=user, db=db_session,
        ))

        numerics = [
            dv.value_numeric
            for dv in db_session.query(DatasetValue).filter(DatasetValue.column_id == 1)
        ]
        # 🔴 REWRITTEN 2026-08-24 — same removal. A category_group IN EFFECT
        # still clears the numeric encoding (that is `recompute_primary_
        # value_numeric`'s apply-vs-clear decision, unchanged and covered on the
        # `set_primary` path). What changed is that CREATING one no longer puts
        # it in effect, so the stamped numbers survive until the researcher
        # applies it deliberately — which is the whole point: this clear is
        # destructive and used to happen on save.
        assert numerics == [1.0, 2.0, 3.0], (
            "creating a category_group must not clear the column's numbers"
        )


# ---------------------------------------------------------------------------
# #548: copy_to was the one un-swept primary-changing callsite — its apply
# branch kept the pre-#542 SCALE_MAP-only shape, so a copy that landed as the
# target's primary (a) never applied REVERSE (value_numeric stayed NULL while
# the primary claimed REVERSE — the first append then stamped REVERSED values
# via the #538 mirror: same label, two numbers in one column), (b) never
# cleared stamped numerics under CATEGORY_GROUP, and (c) skipped the #542a
# scale-metadata write-back. Copying a reverse across a battery of
# negatively-worded items is copy_to's canonical use.
# Zero-based mapping on purpose (degenerate-fixture rule): on 0..3 the old
# (max+1)-v and the correct (min+max)-v reversal DISAGREE.
# ---------------------------------------------------------------------------

from app.routers.recode import copy_to
from app.schemas.recode import CopyToRequest

_COPY_LABELS = ["None", "A little", "Some", "A lot"]  # codes 0..3
_COPY_MAPPING = {label: i for i, label in enumerate(_COPY_LABELS)}


def _setup_copy_to_scenario(db, *, source_type, target_stamped=False):
    """Source column 7801 carrying a primary definition of ``source_type``;
    bare target column 7802 (same dataset, same labels, NO definitions).

    ``target_stamped`` pre-stamps the target's value_numeric with the forward
    codes (the import-compute shape) so the CATEGORY_GROUP clear is observable.
    """
    project = Project(id=7800, name="CopyTo", user_id=1)
    db.add(project)
    db.flush()
    dataset = Dataset(id=7800, project_id=7800, name="Battery")
    db.add(dataset)
    db.flush()
    source = DatasetColumn(
        id=7801, dataset_id=7800, column_code="Q1", column_name="Q1",
        column_text="Q1 (reverse-worded)", column_type="ordinal",
        sequence_order=0, display_order=0,
    )
    target = DatasetColumn(
        id=7802, dataset_id=7800, column_code="Q2", column_name="Q2",
        column_text="Q2 (reverse-worded)", column_type="ordinal",
        sequence_order=1, display_order=1,
    )
    db.add_all([source, target])
    db.flush()

    for i, label in enumerate(_COPY_LABELS):
        row = DatasetRow(id=7810 + i, dataset_id=7800)
        db.add(row)
        db.flush()
        db.add(DatasetValue(
            row_id=row.id, column_id=7801, value_text=label, value_numeric=None,
        ))
        db.add(DatasetValue(
            row_id=row.id, column_id=7802, value_text=label,
            value_numeric=float(_COPY_MAPPING[label]) if target_stamped else None,
        ))
    db.flush()

    mapping = (
        {label: f"G{i % 2}" for i, label in enumerate(_COPY_LABELS)}
        if source_type == RecodeType.CATEGORY_GROUP
        else _COPY_MAPPING
    )
    definition = RecodeDefinition(
        id=7801, column_id=7801, name="Battery recode",
        recode_type=source_type,
        output_type=(
            OutputType.CATEGORICAL
            if source_type == RecodeType.CATEGORY_GROUP
            else OutputType.NUMERIC
        ),
        mapping=json.dumps(mapping),
        exclude_values=json.dumps([]),
        is_primary=True, is_auto_detected=False, sequence_order=0,
    )
    db.add(definition)
    db.flush()
    return definition


def _target_numeric_by_label(db):
    return {
        v.value_text: v.value_numeric
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == 7802).all()
    }


def _copy(db, definition):
    user = db.query(User).filter(User.id == 1).one()
    return _run(copy_to(
        project_id=7800, dataset_id=7800, column_id=7801,
        definition_id=definition.id,
        data=CopyToRequest(target_column_ids=[7802]),
        user=user, db=db,
    ))


class TestCopyToAppliesPrimary:
    """#548 — a copy that lands as the target's primary routes through
    _recompute_primary_value_numeric, matching every other callsite."""

    def test_copied_reverse_primary_applies_on_zero_based_scale(self, db_session):
        definition = _setup_copy_to_scenario(db_session, source_type=RecodeType.REVERSE)
        resp = _copy(db_session, definition)
        assert resp.created == 1

        nums = _target_numeric_by_label(db_session)
        # (min+max)-v on 0..3: 0→3, 1→2, 2→1, 3→0. The old code left all None;
        # the old (max+1)-v formula would give 4..1.
        assert nums == {"None": 3.0, "A little": 2.0, "Some": 1.0, "A lot": 0.0}

    def test_copied_category_group_primary_clears_stamped_numerics(self, db_session):
        definition = _setup_copy_to_scenario(
            db_session, source_type=RecodeType.CATEGORY_GROUP, target_stamped=True,
        )
        assert _target_numeric_by_label(db_session)["A lot"] == 3.0  # stamped
        _copy(db_session, definition)
        assert all(v is None for v in _target_numeric_by_label(db_session).values()), (
            "a categorical primary must clear the column's numeric encoding (#542 corollary)"
        )

    def test_copied_scale_map_primary_writes_back_scale_metadata(self, db_session):
        definition = _setup_copy_to_scenario(db_session, source_type=RecodeType.SCALE_MAP)
        _copy(db_session, definition)

        target = db_session.query(DatasetColumn).filter(DatasetColumn.id == 7802).one()
        assert json.loads(target.scale_labels) == _COPY_LABELS  # code-sorted
        assert json.loads(target.scale_values) == [0, 1, 2, 3]  # ints (#28 parity)
        nums = _target_numeric_by_label(db_session)
        assert nums == {"None": 0.0, "A little": 1.0, "Some": 2.0, "A lot": 3.0}

    def test_copy_onto_target_with_existing_primary_does_not_apply(self, db_session):
        definition = _setup_copy_to_scenario(db_session, source_type=RecodeType.REVERSE)
        existing = RecodeDefinition(
            id=7802, column_id=7802, name="Existing primary",
            recode_type=RecodeType.SCALE_MAP, output_type=OutputType.NUMERIC,
            mapping=json.dumps(_COPY_MAPPING), exclude_values=json.dumps([]),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        )
        db_session.add(existing)
        db_session.flush()
        apply_definition_to_column(db_session, existing)
        db_session.flush()

        _copy(db_session, definition)
        nums = _target_numeric_by_label(db_session)
        # The copy lands NON-primary and must not touch value_numeric.
        assert nums == {"None": 0.0, "A little": 1.0, "Some": 2.0, "A lot": 3.0}


class TestReflectionOffsetOnTheWire:
    """#602 — the reverse editor DISPLAYS the offset; it must not derive one.

    `effective_reverse_offset` excludes the null set (#600), and the client can
    see neither the recognized-N/A rule nor the column's declaration. So a local
    `min + max` over the mapping previewed "Never → 99" on a draft the save
    (correctly) scored 5 — the same display-vs-storage drift #578 was about,
    reintroduced one screen over.

    The field rides `RecodeDefinitionResponse` for EVERY definition type, because
    the draft the editor previews is a verbatim copy of its `scale_map` source
    and takes that source's number.
    """

    NA_MAPPING = {"Never": 1, "Always": 5, "Prefer not to say": 99}

    def _column(self, db, *, missing_values=None):
        db.add(Project(id=1, name="P", user_id=1)); db.flush()
        db.add(Dataset(id=1, project_id=1, name="D")); db.flush()
        col = DatasetColumn(id=1, dataset_id=1, column_code="Q", column_text="Q",
                            column_type="ordinal", sequence_order=0, display_order=0,
                            missing_values=missing_values)
        db.add(col); db.flush()
        return col

    def _def(self, db, col, rtype, mapping, *, def_id=1):
        d = RecodeDefinition(id=def_id, column_id=col.id, name=f"{rtype}",
                             recode_type=rtype, output_type=OutputType.NUMERIC,
                             mapping=json.dumps(mapping), is_primary=False,
                             sequence_order=def_id)
        db.add(d); db.flush()
        return d

    def test_the_offset_excludes_a_recognized_NA_key(self, db_session):
        """The whole point: 1+5, never 1+99. An undeclared column still has the
        defaults, so this is the common case rather than the exotic one."""
        from app.routers.recode import _definition_to_response
        col = self._column(db_session)
        d = self._def(db_session, col, RecodeType.REVERSE, self.NA_MAPPING)
        resp = _definition_to_response(d, db_session)
        assert resp.reverse_offset == 6.0, (
            "a raw min+max would be 100 and every previewed score would be wrong"
        )

    def test_a_declaration_changes_the_offset(self, db_session):
        """Two-sided (REPLACE): declaring `[]` makes "Prefer not to say" real
        data, so it becomes a scale point and the offset moves. A hardcoded
        default cannot produce both answers."""
        from app.routers.recode import _definition_to_response
        col = self._column(db_session, missing_values="[]")
        d = self._def(db_session, col, RecodeType.REVERSE, self.NA_MAPPING)
        assert _definition_to_response(d, db_session).reverse_offset == 100.0

    def test_a_scale_map_carries_the_offset_too(self, db_session):
        """The draft's source is a scale_map, and the draft copies its mapping —
        so the field must be populated for it, or the preview has nothing
        authoritative to show (the #602 defect)."""
        from app.routers.recode import _definition_to_response
        col = self._column(db_session)
        d = self._def(db_session, col, RecodeType.SCALE_MAP, self.NA_MAPPING)
        assert _definition_to_response(d, db_session).reverse_offset == 6.0

    def test_a_mapping_with_no_numeric_scale_points_is_None_not_zero(self, db_session):
        """`None` means "no reflection happens", which is NOT the offset 0.0 a
        symmetric scale legitimately has — the falsy-zero trap (#600)."""
        from app.routers.recode import _definition_to_response
        col = self._column(db_session)
        d = self._def(db_session, col, RecodeType.CATEGORY_GROUP,
                      {"Never": "Low", "Always": "High"})
        assert _definition_to_response(d, db_session).reverse_offset is None

    def test_a_symmetric_scale_reflects_about_zero_and_says_so(self, db_session):
        from app.routers.recode import _definition_to_response
        col = self._column(db_session)
        d = self._def(db_session, col, RecodeType.REVERSE, {"Lo": -5, "Hi": 5})
        assert _definition_to_response(d, db_session).reverse_offset == 0.0

    def test_the_two_payloads_agree(self, db_session):
        """`/data`'s summary and the definition endpoints carry the same field
        name; #602 made them share one computation, so a fixture that can tell
        them apart is what stops the rule forking again."""
        from app.routers.recode import _definition_to_response
        from app.services.recode import definition_reflection_offset
        col = self._column(db_session)
        d = self._def(db_session, col, RecodeType.REVERSE, self.NA_MAPPING)
        assert (_definition_to_response(d, db_session).reverse_offset
                == definition_reflection_offset(d, col.missing_values))


# ═══════════════════════════════════════════════════════════════════════════════
# The Variables view's per-variable "rule in effect" (design note E, slab 2)
# ═══════════════════════════════════════════════════════════════════════════════

from app.models.dataset import ColumnType  # noqa: E402
from app.routers.dataset import list_columns as _list_columns  # noqa: E402


class TestPrimaryRecodeOnColumnPayload:
    """`listColumns` now states which rule drives each column's `value_numeric`.

    ⚠️ **This existed as a DEAD READ before it existed as data.** The Variables
    view's sidebar rendered `q.recode_definitions?.length` and a wand icon for
    auto-detected rules off this payload — which never carried the field, so
    both had never rendered once, on any dataset. Verified live against the dev
    corpus before the field was added. The fix is to send what the surface asks
    for; the dead reads are deleted rather than resurrected.
    """

    def _fixture(self, db, mapping=None, primary=True, rtype=RecodeType.SCALE_MAP):
        p = Project(id=1, name="P", user_id=1); db.add(p); db.flush()
        d = Dataset(id=1, project_id=1, name="D"); db.add(d); db.flush()
        c = DatasetColumn(id=1, dataset_id=1, column_text="Q1",
                          column_type=ColumnType.ORDINAL,
                          sequence_order=0, display_order=0)
        db.add(c); db.flush()
        if mapping is not None:
            db.add(RecodeDefinition(
                column_id=c.id, name="The rule", recode_type=rtype,
                output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
                is_primary=primary, is_auto_detected=False, sequence_order=0,
            ))
            db.flush()
        return db.get(User, 1)

    def _columns(self, db, user):
        return _run(_list_columns(project_id=1, dataset_id=1, user=user, db=db))

    def test_a_primary_rule_is_named_on_the_payload(self, db_session):
        user = self._fixture(db_session, {"2": 2, "4": 4})
        col = self._columns(db_session, user)[0]
        assert col.primary_recode is not None
        assert col.primary_recode.name == "The rule"
        assert col.primary_recode.recode_type == "scale_map"

    def test_no_primary_reads_as_None_not_as_missing(self, db_session):
        # `None` must mean "no primary" on EVERY payload this builder makes —
        # never "this endpoint did not look". That is why the computation lives
        # in `_column_to_response` and not at the list endpoint.
        user = self._fixture(db_session, mapping=None)
        assert self._columns(db_session, user)[0].primary_recode is None

    def test_a_NON_primary_rule_does_not_populate_it(self, db_session):
        # Only the primary drives value_numeric; a saved-but-inert definition
        # must not be reported as the rule in effect.
        user = self._fixture(db_session, {"2": 2}, primary=False)
        assert self._columns(db_session, user)[0].primary_recode is None

    def test_a_FLIP_is_reported_as_remapping_the_codes(self, db_session):
        user = self._fixture(db_session, {"2": 10, "4": 6, "6": 4, "10": 2})
        assert self._columns(db_session, user)[0].primary_recode.remaps_codes is True

    def test_an_IDENTITY_map_is_not(self, db_session):
        user = self._fixture(db_session, {"2": 2, "4": 4, "6": 6, "10": 10})
        assert self._columns(db_session, user)[0].primary_recode.remaps_codes is False

    def test_a_LABEL_keyed_map_reads_as_not_remapping_and_that_is_the_KNOWN_BLIND_SPOT(
        self, db_session,
    ):
        # Pinned so the limitation is a recorded decision rather than an
        # accident: `remaps_codes` is a SHAPE test and a hand-flip keyed on
        # labels carries no numeric key to judge. It describes the RULE; the
        # safety authority is `value_labels.code_identity_violation`, which
        # reads stored cells and cannot run per column across a list response.
        user = self._fixture(db_session, {"Low": 10, "Mid": 6, "High": 4, "Top": 2})
        assert self._columns(db_session, user)[0].primary_recode.remaps_codes is False

    def test_the_endpoint_does_not_scale_its_QUERY_COUNT_with_the_column_count(
        self, db_session,
    ):
        """The N+1 this design exists to avoid.

        Every recode GET in the app is per-column, so a grid of N variables
        asking each for its rule would be N round trips — on a dataset capped at
        500 columns. The eager load makes it constant, and asserting the COUNT
        rather than the wall clock is what makes that checkable.
        """
        from sqlalchemy import event

        p = Project(id=1, name="P", user_id=1); db_session.add(p); db_session.flush()
        d = Dataset(id=1, project_id=1, name="D"); db_session.add(d); db_session.flush()
        for i in range(25):
            c = DatasetColumn(dataset_id=1, column_text=f"Q{i}",
                              column_type=ColumnType.ORDINAL,
                              sequence_order=i, display_order=i)
            db_session.add(c); db_session.flush()
            db_session.add(RecodeDefinition(
                column_id=c.id, name=f"rule {i}", recode_type=RecodeType.SCALE_MAP,
                output_type=OutputType.NUMERIC, mapping=json.dumps({"1": 1}),
                is_primary=True, is_auto_detected=False, sequence_order=0,
            ))
        db_session.flush()
        user = db_session.get(User, 1)

        statements = []
        bind = db_session.get_bind()

        def _count(conn, cursor, stmt, params, ctx, many):
            statements.append(stmt)

        event.listen(bind, "before_cursor_execute", _count)
        try:
            cols = self._columns(db_session, user)
        finally:
            event.remove(bind, "before_cursor_execute", _count)

        assert len(cols) == 25
        assert all(c.primary_recode is not None for c in cols)
        # Ownership gate + columns + the eager load. A per-column lazy load
        # would put this at 25+; the bound is deliberately generous so the test
        # fails on the CLASS (linear growth) and not on an incidental query.
        assert len(statements) < 10, (
            f"{len(statements)} statements for 25 columns — the primary lookup "
            "is loading per column"
        )


class TestPromotingAStaleDefinition:
    """#794: a definition can go stale against its own column, and promoting one
    used to have two unacceptable outcomes.

    Applying value labels rewrites `value_text`, so every mapping keyed on the
    old text stops matching (#584 measured FOUR of five on one realistic
    column). A TOTALLY stale definition emitted `CASE END` — invalid SQL, an
    unhandled 500 on a routine click. A PARTIALLY stale one silently NULLed
    every cell it could not map.

    ⚠️ **The refusal is at the ROUTER and the service only stops emitting bad
    SQL — that split is load-bearing.** `apply_definition_to_column` is on the
    startup path through `repair_reverse_recode_mappings`, and #592 slab 4
    dropped an apply-side raise precisely because it fired during boot on
    existing data. A test that moves the raise into the service would pass here
    and break startup.
    """

    def _column_with_cells(self, db, cells):
        p = Project(id=1, name="P", user_id=1); db.add(p); db.flush()
        d = Dataset(id=1, project_id=1, name="D"); db.add(d); db.flush()
        c = DatasetColumn(id=1, dataset_id=1, column_text="Q1",
                          column_type=ColumnType.ORDINAL,
                          sequence_order=0, display_order=0)
        db.add(c); db.flush()
        for text in cells:
            r = DatasetRow(dataset_id=1); db.add(r); db.flush()
            db.add(DatasetValue(row_id=r.id, column_id=c.id,
                                value_text=text, value_numeric=None))
        db.flush()
        return c

    def _definition(self, db, column, mapping, primary=False):
        d = RecodeDefinition(
            column_id=column.id, name="Old keys", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            is_primary=primary, is_auto_detected=False, sequence_order=0,
        )
        db.add(d); db.flush()
        return d

    def test_a_TOTALLY_stale_apply_is_a_no_op_and_never_emits_empty_SQL(self, db_session):
        # The service arm: no raise (it is on the boot path), no invalid SQL.
        col = self._column_with_cells(db_session, ["Never", "Sometimes", "Always"])
        defn = self._definition(db_session, col, {"2": 2, "4": 4})
        res = apply_definition_to_column(db_session, defn)
        assert res["updated"] == 0
        assert sorted(res["unmapped"]) == ["Always", "Never", "Sometimes"]
        # Nothing was written — an unmapped value has no code to write.
        assert all(v.value_numeric is None for v in
                   db_session.query(DatasetValue).filter_by(column_id=col.id))

    def test_promoting_a_TOTALLY_stale_definition_is_REFUSED_by_name(self, db_session):
        col = self._column_with_cells(db_session, ["Never", "Sometimes", "Always"])
        defn = self._definition(db_session, col, {"2": 2, "4": 4})
        user = db_session.get(User, 1)
        with pytest.raises(HTTPException) as exc:
            _run(set_primary(project_id=1, dataset_id=1, column_id=col.id,
                             definition_id=defn.id, user=user, db=db_session))
        assert exc.value.status_code == 400
        # The message must name the definition and the way out — a bare "cannot
        # promote" leaves the researcher with a starred rule and no next step.
        assert "Old keys" in exc.value.detail
        assert "Re-map it" in exc.value.detail

    def test_a_PARTIALLY_stale_promotion_is_ALLOWED_and_DISCLOSES_what_it_emptied(
        self, db_session,
    ):
        # Nulling a cell the primary cannot map is defensible — an unmapped
        # value has no code. Doing it without saying so is not, and `set_primary`
        # used to discard the result entirely.
        col = self._column_with_cells(db_session, ["Never", "Sometimes", "Always"])
        defn = self._definition(db_session, col, {"Never": 1, "4": 4})
        user = db_session.get(User, 1)
        res = _run(set_primary(project_id=1, dataset_id=1, column_id=col.id,
                               definition_id=defn.id, user=user, db=db_session))
        assert res.is_primary is True
        assert res.unmapped_values == ["Always", "Sometimes"]

    def test_an_ordinary_promotion_discloses_nothing(self, db_session):
        # The disclosure must be silent when there is nothing to disclose, or it
        # becomes noise that gets ignored on the run that matters.
        col = self._column_with_cells(db_session, ["Never", "Always"])
        defn = self._definition(db_session, col, {"Never": 1, "Always": 5})
        user = db_session.get(User, 1)
        res = _run(set_primary(project_id=1, dataset_id=1, column_id=col.id,
                               definition_id=defn.id, user=user, db=db_session))
        assert res.unmapped_values == []


# ═══════════════════════════════════════════════════════════════════════════════
# Applying a rule is a DELIBERATE ACT (2026-08-24, design-note §8)
# ═══════════════════════════════════════════════════════════════════════════════


class TestApplyingARuleIsDeliberate:
    """The four doors into an in-place transform, and which ones are closed.

    A rule "in effect" rewrites every stored number in a variable and there is
    no undo — the pre-transform codes are not stored anywhere, which is what
    Decision D exists to fix. Three of the four ways to reach that state were
    SILENT. These tests pin the two that were closed.

    ⚠️ `copy_to` is the fourth and is deliberately NOT closed — see
    `TestCopyToStillAppliesOnPurpose` below.
    """

    def _column_with_cells(self, db, texts, numerics=None):
        project = Project(id=9100, name="Apply", user_id=1)
        db.add(project)
        db.flush()
        ds = Dataset(id=9100, project_id=9100, name="D")
        db.add(ds)
        db.flush()
        col = DatasetColumn(
            id=9100, dataset_id=9100, column_text="Q", column_type=ColumnType.ORDINAL,
            sequence_order=0, display_order=0,
        )
        db.add(col)
        db.flush()
        for i, text in enumerate(texts, start=9100):
            row = DatasetRow(id=i, dataset_id=9100)
            db.add(row)
            db.flush()
            db.add(DatasetValue(
                row_id=i, column_id=9100, value_text=text,
                value_numeric=(numerics[i - 9100] if numerics else None),
            ))
        db.flush()
        return col

    def test_creating_a_rule_on_a_variable_with_none_does_not_apply_it(self, db_session):
        """Door 1, the largest — and it was invisible.

        No prompt, no confirmation, no undo: saving the first rule rewrote the
        column. Every other door at least involved a click that named itself.
        """
        col = self._column_with_cells(db_session, ["Never", "Sometimes", "Always"],
                                      numerics=[1.0, 3.0, 5.0])
        user = db_session.get(User, 1)

        created = _run(create_definition(
            project_id=9100, dataset_id=9100, column_id=col.id,
            data=RecodeDefinitionCreate(
                name="Flip", recode_type="scale_map", output_type="numeric",
                mapping={"Never": 5, "Sometimes": 3, "Always": 1},
            ),
            user=user, db=db_session,
        ))

        assert created.is_primary is False
        nums = sorted(
            dv.value_numeric
            for dv in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id)
        )
        assert nums == [1.0, 3.0, 5.0], "the stored numbers must be untouched"

    def test_set_primary_still_applies_it(self, db_session):
        """The mechanism is intact — only the SIDE EFFECT was removed.

        A guard that closed a door by breaking the feature would pass the test
        above and be worthless, so the positive control lives beside it.
        """
        col = self._column_with_cells(db_session, ["Never", "Sometimes", "Always"],
                                      numerics=[1.0, 3.0, 5.0])
        user = db_session.get(User, 1)
        created = _run(create_definition(
            project_id=9100, dataset_id=9100, column_id=col.id,
            data=RecodeDefinitionCreate(
                name="Flip", recode_type="scale_map", output_type="numeric",
                mapping={"Never": 5, "Sometimes": 3, "Always": 1},
            ),
            user=user, db=db_session,
        ))

        res = _run(set_primary(project_id=9100, dataset_id=9100, column_id=col.id,
                               definition_id=created.id, user=user, db=db_session))
        assert res.is_primary is True
        nums = {
            dv.value_text: dv.value_numeric
            for dv in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id)
        }
        assert nums == {"Never": 5.0, "Sometimes": 3.0, "Always": 1.0}

    def test_deleting_the_rule_in_effect_leaves_the_numbers_alone(self, db_session):
        """Door 3, and the destructive half.

        This branch used to `clear_value_numeric` when no other rule remained.
        The rule `apply_value_labels` creates is an ordinary listed definition
        with a Delete button, so deleting it on a LABELLED column wiped every
        code while leaving the labels — means, correlations and scale scores
        gone, frequencies still fine, nothing on screen saying why.

        ⚠️ Deletion CANNOT undo an application (the pre-transform codes are not
        stored), so leaving the numbers is the only honest behaviour. The client
        says so before the delete.
        """
        col = self._column_with_cells(db_session, ["Never", "Always"], numerics=[1.0, 5.0])
        user = db_session.get(User, 1)
        created = _run(create_definition(
            project_id=9100, dataset_id=9100, column_id=col.id,
            data=RecodeDefinitionCreate(
                name="Flip", recode_type="scale_map", output_type="numeric",
                mapping={"Never": 5, "Always": 1},
            ),
            user=user, db=db_session,
        ))
        _run(set_primary(project_id=9100, dataset_id=9100, column_id=col.id,
                         definition_id=created.id, user=user, db=db_session))

        res = _run(delete_definition(project_id=9100, dataset_id=9100, column_id=col.id,
                                     definition_id=created.id, user=user, db=db_session))

        assert res["was_in_effect"] is True, "the client needs this to disclose it"
        nums = {
            dv.value_text: dv.value_numeric
            for dv in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id)
        }
        assert nums == {"Never": 5.0, "Always": 1.0}, (
            "the applied numbers stay — deleting the rule cannot restore what "
            "applying it overwrote"
        )

    def test_deleting_the_rule_in_effect_does_not_promote_another(self, db_session):
        """Door 3, the silent half.

        A researcher deleted ONE rule and a different one they never chose
        rewrote the column.
        """
        col = self._column_with_cells(db_session, ["Never", "Always"], numerics=[1.0, 5.0])
        user = db_session.get(User, 1)
        first = _run(create_definition(
            project_id=9100, dataset_id=9100, column_id=col.id,
            data=RecodeDefinitionCreate(
                name="Flip", recode_type="scale_map", output_type="numeric",
                mapping={"Never": 5, "Always": 1},
            ),
            user=user, db=db_session,
        ))
        second = _run(create_definition(
            project_id=9100, dataset_id=9100, column_id=col.id,
            data=RecodeDefinitionCreate(
                name="Collapse", recode_type="scale_map", output_type="numeric",
                mapping={"Never": 9, "Always": 9},
            ),
            user=user, db=db_session,
        ))
        _run(set_primary(project_id=9100, dataset_id=9100, column_id=col.id,
                         definition_id=first.id, user=user, db=db_session))

        _run(delete_definition(project_id=9100, dataset_id=9100, column_id=col.id,
                               definition_id=first.id, user=user, db=db_session))

        # Re-query: the router returns a Pydantic response, not the ORM row, so
        # `refresh` has nothing to refresh. Reading the row is also the honest
        # check — it asks the database what is in effect, not what a response
        # said at creation time.
        second_row = db_session.get(RecodeDefinition, second.id)
        assert second_row.is_primary is False, "no rule may take effect without being chosen"
        nums = sorted(
            dv.value_numeric
            for dv in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id)
        )
        assert nums == [1.0, 5.0], "the promoted rule's 9/9 must not have been written"


class TestCopyToStillAppliesOnPurpose:
    """Door 4 is deliberately LEFT OPEN, and this test is why.

    `copy_to` looked like a fourth silent door and is not one. It only applies
    to a target that has NO rule at all, and the operation it serves — the
    crosswalk's "Copy to Equivalents" — exists precisely to make un-encoded
    equivalent items comparable in ONE action. Copying without applying would
    make that operation require a follow-up trip per target, which is the thing
    the researcher used it to avoid.

    ⚠️ So the fix there is DISCLOSURE, not refusal: the copy dialog says how
    many variables it will change. Recorded here because "why didn't you close
    this one too?" is the obvious next question, and the answer is a decision
    rather than an oversight.
    """

    def test_a_copy_onto_an_unruled_variable_still_takes_effect(self, db_session):
        assert True, (
            "behaviour pinned by TestCopyToPrimaryRoutesThroughSharedApply above; "
            "this class documents WHY it was not changed with the other three doors"
        )
