"""#1079 (b) — a retype re-derives what the column's cells STORED under the old type.

A cell's `value_numeric` (and `word_count`) is computed from its text by the
column's type when the cell is written. Both retype doors — `bulk_type_update`
(the Variables view's type select and the Data view's header, every column) and
`update_manual_column` (*Variable details…*, a hand-made column) — changed the
type and re-derived nothing. MEASURED in the pre-implementation review: a column
of 5 / 10 / 12 typed nominal and retyped numeric kept NULL in every cell through
BOTH doors, so every reader of the stored number saw an empty column. The
retype also moves which cells are MISSING (#1048), and `update_manual_column`
marked nothing stale — the audit's P3: a computed column and a metric on a
nominal → open_text retype both stayed `stale = False`.
"""
import json

import pytest

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import update_manual_column
from app.routers.recode import bulk_type_update
from app.schemas.dataset import ManualColumnUpdate
from app.schemas.recode import BulkTypeUpdateRequest
from app.services import column_retype
from app.services.dataset_import import import_dataset_csv


def _project(db, pid):
    db.add(Project(id=pid, name="p", user_id=1))
    db.add(Dataset(id=pid, project_id=pid, name="d"))
    db.flush()


def _column(db, pid, cid, ctype, source, texts, **extra):
    db.add(DatasetColumn(id=cid, dataset_id=pid, column_code=f"c{cid}", column_text=f"c{cid}",
                         column_type=ctype, source=source, sequence_order=cid, display_order=cid,
                         **extra))
    db.flush()
    for i, text in enumerate(texts, 1):
        row_id = pid * 1000 + i
        if db.get(DatasetRow, row_id) is None:
            db.add(DatasetRow(id=row_id, dataset_id=pid, row_identifier=f"R{i}"))
            db.flush()
        db.add(DatasetValue(row_id=row_id, column_id=cid, value_text=text, value_numeric=None))
    db.flush()
    return cid


def _stored(db, cid):
    return sorted(
        (v.value_text, v.value_numeric, v.word_count)
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == cid)
    )


def _bulk(db, pid, cids, new_type, dataset_id=None):
    result = bulk_type_update(
        project_id=pid, dataset_id=pid if dataset_id is None else dataset_id,
        data=BulkTypeUpdateRequest(column_ids=cids, column_type=new_type),
        user=db.get(User, 1), db=db,
    )
    # The door reports what it found; a wrong dataset id finds nothing silently.
    assert result["updated"] == len(cids)
    return result


class TestBothDoorsReDerive:
    TEXTS = ["5", "10", "12", "N/A"]
    NUMBERS = [("10", 10.0, None), ("12", 12.0, None), ("5", 5.0, None), ("N/A", None, None)]

    def test_the_BULK_door_imported_column(self, db_session):
        db = db_session
        _project(db, 7910)
        cid = _column(db, 7910, 79101, ColumnType.NOMINAL, "imported", self.TEXTS)
        _bulk(db, 7910, [cid], "numeric")
        assert _stored(db, cid) == self.NUMBERS

    def test_the_BULK_door_reaches_a_hand_made_column_too(self, db_session):
        """The Variables view's type select calls the BULK door for every column,
        hand-made ones included — the door #1079's entry never named."""
        db = db_session
        _project(db, 7911)
        cid = _column(db, 7911, 79111, ColumnType.NOMINAL, "manual", self.TEXTS)
        _bulk(db, 7911, [cid], "numeric")
        assert _stored(db, cid) == self.NUMBERS

    def test_the_DETAILS_door(self, db_session):
        db = db_session
        _project(db, 7912)
        cid = _column(db, 7912, 79121, ColumnType.NOMINAL, "manual", self.TEXTS)
        update_manual_column(project_id=7912, dataset_id=7912, column_id=cid,
                             req=ManualColumnUpdate(column_type="numeric"),
                             user=db.get(User, 1), db=db)
        assert _stored(db, cid) == self.NUMBERS

    def test_new_SCALE_LABELS_re_derive_an_ordinal_column(self, db_session):
        """The labels decide an ordinal cell's number as much as the type does."""
        db = db_session
        _project(db, 7913)
        cid = _column(db, 7913, 79131, ColumnType.ORDINAL, "manual", ["Low", "High"],
                      scale_labels=json.dumps(["Low", "Med", "High"]), scale_points=3)
        db.query(DatasetValue).filter(DatasetValue.value_text == "High").update({"value_numeric": 3.0})
        db.flush()
        update_manual_column(project_id=7913, dataset_id=7913, column_id=cid,
                             req=ManualColumnUpdate(scale_labels=["Low", "High"]),
                             user=db.get(User, 1), db=db)
        assert dict((t, n) for t, n, _ in _stored(db, cid)) == {"Low": 1.0, "High": 2.0}


class TestTheDetailsDoorMarksWhatReadsTheColumnStale:
    def test_the_audits_P3_a_computed_column_and_a_metric(self, db_session):
        """nominal → open_text moves which rows are missing (the prefix rule gives
        way to whole answers), so what reads the column must be marked."""
        db = db_session
        _project(db, 7914)
        cid = _column(db, 7914, 79141, ColumnType.NOMINAL, "manual",
                      ["Not enough time", "fine", "N/A"])
        db.add(DatasetColumn(id=79142, dataset_id=7914, column_code="c", column_text="c",
                             column_type=ColumnType.NUMERIC, source="computed",
                             expression='IF([c79141] == "fine", 1, 0)', sequence_order=9,
                             display_order=9, depends_on_column_ids=json.dumps([cid]), stale=False))
        db.add(MetricDefinition(id=79143, project_id=7914, name="f", metric_type="frequency_distribution",
                                config="{}", input_source_type="dataset_column", input_source_id=cid,
                                stale=False))
        db.flush()
        update_manual_column(project_id=7914, dataset_id=7914, column_id=cid,
                             req=ManualColumnUpdate(column_type="open_text"),
                             user=db.get(User, 1), db=db)
        assert db.get(DatasetColumn, 79142).stale is True
        assert db.get(MetricDefinition, 79143).stale is True

    def test_a_RENAME_marks_nothing(self, db_session):
        """Positive control for the gate: only a retype or new labels re-derive."""
        db = db_session
        _project(db, 7915)
        cid = _column(db, 7915, 79151, ColumnType.NOMINAL, "manual", ["a"])
        db.add(MetricDefinition(id=79153, project_id=7915, name="f", metric_type="frequency_distribution",
                                config="{}", input_source_type="dataset_column", input_source_id=cid,
                                stale=False))
        db.flush()
        update_manual_column(project_id=7915, dataset_id=7915, column_id=cid,
                             req=ManualColumnUpdate(column_text="Renamed"),
                             user=db.get(User, 1), db=db)
        assert db.get(MetricDefinition, 79153).stale is False


class TestTheRoundTripIsTheImport:
    """The re-derivation must reproduce EXACTLY what an import of the new type
    stores — number and word count — or it is a third owner of one number (#28).
    Retyping away and back is the test: it must land on the import's own cells."""

    @pytest.mark.parametrize("ctype,away", [("numeric", "nominal"), ("open_text", "nominal"),
                                            ("binary", "open_text")])
    def test_away_and_back(self, db_session, ctype, away):
        db = db_session
        db.add(Project(id=7916, name="p", user_id=1))
        db.flush()
        text = "q\n12\nyes\nNot enough time to answer\n5.5\nN/A\nno\n"
        result = import_dataset_csv(db=db, project_id=7916, name="d", file_contents=text,
                                    column_configs=[{"column_index": 0, "column_type": ctype,
                                                     "column_text": "q"}])
        db.flush()
        did = result["dataset_id"]
        cid = db.query(DatasetColumn).filter(DatasetColumn.dataset_id == did).one().id
        imported = _stored(db, cid)
        _bulk(db, 7916, [cid], away, dataset_id=did)
        assert _stored(db, cid) != imported   # the away leg really moved something
        _bulk(db, 7916, [cid], ctype, dataset_id=did)
        assert _stored(db, cid) == imported


class TestWhatIsNeverReDerived:
    def test_a_DERIVED_variable_keeps_its_rules_output(self, db_session):
        """Decision B: a derived column's numbers are the rule's, a snapshot. An
        unmapped source value is carried through as text with NO number — the
        re-derivation would parse "7" and invent one."""
        db = db_session
        _project(db, 7917)
        cid = _column(db, 7917, 79171, ColumnType.NUMERIC, "manual", ["7"],
                      derived_via="Reverse q1")
        _bulk(db, 7917, [cid], "numeric")
        assert _stored(db, cid) == [("7", None, None)]

    @pytest.mark.parametrize("source,expression", [("computed", "1 + 2"), ("managed", None)])
    def test_a_COMPUTED_or_MANAGED_column_keeps_its_numbers(self, db_session, source, expression):
        """Their numbers are the formula's and the rollup's. Retyped (in memory, as
        the bulk door does before it plans) to a type whose rule stores NO number,
        a re-derivation would wipe them — so the fixture's two answers differ."""
        db = db_session
        _project(db, 7918)
        cid = _column(db, 7918, 79181, ColumnType.NUMERIC, source, ["3"], expression=expression)
        db.query(DatasetValue).filter(DatasetValue.column_id == cid).update({"value_numeric": 3.0})
        db.flush()
        column = db.get(DatasetColumn, cid)
        column.column_type = ColumnType.NOMINAL
        assert column_retype.plan_rederived_cells(db, column) == []

    def test_a_column_with_a_PRIMARY_recode_keeps_the_primarys_numbers(self, db_session):
        """The primary owns `value_numeric` (a label edit is not refused while one
        exists): re-deriving from the type would overwrite its mapping."""
        from app.models.recode import OutputType, RecodeDefinition, RecodeType
        db = db_session
        _project(db, 7920)
        cid = _column(db, 7920, 79201, ColumnType.ORDINAL, "manual", ["Low", "High"],
                      scale_labels=json.dumps(["Low", "High"]), scale_points=2)
        db.add(RecodeDefinition(column_id=cid, name="Codes", recode_type=RecodeType.SCALE_MAP,
                                output_type=OutputType.NUMERIC, mapping=json.dumps({"Low": 10, "High": 20}),
                                is_primary=True))
        db.query(DatasetValue).filter(DatasetValue.value_text == "Low").update({"value_numeric": 10.0})
        db.query(DatasetValue).filter(DatasetValue.value_text == "High").update({"value_numeric": 20.0})
        db.flush()
        assert column_retype.plan_rederived_cells(db, db.get(DatasetColumn, cid)) == []

    def test_a_cell_EDITED_after_the_plan_is_not_overwritten(self, db_session):
        """The plan is read with no lock held. A cell whose text changed since must
        keep the number its own edit wrote, never one computed from the old text."""
        db = db_session
        _project(db, 7919)
        cid = _column(db, 7919, 79191, ColumnType.NOMINAL, "manual", ["5", "6"])
        column = db.get(DatasetColumn, cid)
        column.column_type = ColumnType.NUMERIC
        plan = column_retype.plan_rederived_cells(db, column)
        assert len(plan) == 2
        edited = db.query(DatasetValue).filter(DatasetValue.value_text == "6").one()
        edited.value_text, edited.value_numeric = "9", 9.0
        db.flush()
        column_retype.write_rederived_cells(db, plan)
        db.expire_all()
        assert _stored(db, cid) == [("5", 5.0, None), ("9", 9.0, None)]
