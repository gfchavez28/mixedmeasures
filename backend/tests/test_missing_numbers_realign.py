"""#1069 — a stored number on a cell its column now calls missing.

#1048 widened the recognized-N/A defaults at READ time (typographic apostrophes,
runs of spaces, a trailing ``.``/``!``/``?``). Numbers STORED under the old rule
stayed, so the readers of ``value_numeric`` (correlations, comparisons, both
exports) disagreed with every text surface about the same column.

The fixtures sit where the two rules DISAGREE — ``test_the_fixture_could_have_disagreed``
asserts it against the v1.5.4 rule, copied verbatim — because an ASCII
"Don't know" is missing under both and would pass against the defect.
"""
import json

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.recode import OutputType, RecodeDefinition, RecodeType
from app.services import missing_values as mv
from app.services.correlations import _load_column_vectors
from app.services.missing_declaration import realign_undeclared_numbers

CURLY = "Don’t know"  # U+2019: missing since #1048, NOT missing in v1.5.4


def _v154_is_na(value: str) -> bool:
    """The recognized-N/A rule as v1.5.4 shipped it (`56232e11`), verbatim —
    the OLD writer this fix exists for, kept here as the discrimination oracle."""
    lower = value.strip().lower()
    if not lower:
        return False
    if lower in ("na", "n/a"):
        return True
    return any(lower.startswith(p) for p in mv._NA_PREFIXES)


def _project(db, pid: int) -> Dataset:
    db.add(Project(id=pid, name=f"p{pid}", user_id=1))
    db.flush()
    ds = Dataset(id=pid, project_id=pid, name="survey")
    db.add(ds)
    db.flush()
    return ds


def _column(db, ds, cid, *, labels=None, codes=None, ctype=ColumnType.ORDINAL,
            missing_values=None, seq=0):
    col = DatasetColumn(
        id=cid, dataset_id=ds.id, column_code=f"c{cid}", column_name=f"c{cid}",
        column_text=f"c{cid}", column_type=ctype,
        scale_labels=json.dumps(labels) if labels else None,
        scale_values=json.dumps(codes) if codes else None,
        scale_points=len(labels) if labels else None,
        missing_values=missing_values, sequence_order=seq, display_order=seq,
        source="imported",
    )
    db.add(col)
    db.flush()
    return col


def _cells(db, ds, col, cells, *, row_base):
    """Store cells EXACTLY as an older build would have: (text, number)."""
    for i, (text, number) in enumerate(cells, 1):
        row = db.get(DatasetRow, row_base + i)
        if row is None:
            row = DatasetRow(id=row_base + i, dataset_id=ds.id, row_identifier=f"R{i}")
            db.add(row)
            db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=text, value_numeric=number))
    db.flush()


def _stored(db, col) -> dict[str, set]:
    out: dict[str, set] = {}
    for text, number in db.query(DatasetValue.value_text, DatasetValue.value_numeric).filter(
        DatasetValue.column_id == col.id,
    ):
        out.setdefault(text, set()).add(number)
    return out


class TestTheFixture:
    @pytest.mark.parametrize("text", [CURLY, "Don't  know", "Na.", "na!"])
    def test_the_fixture_could_have_disagreed(self, text):
        # Each widening arm of #1048: missing now, NOT missing in v1.5.4.
        assert mv.is_missing(text, None)
        assert not _v154_is_na(text)


class TestAnUndeclaredColumnIsRealigned:
    def test_a_newly_missing_label_loses_its_stored_number(self, db_session):
        db = db_session
        ds = _project(db, 6101)
        labels = ["Disagree", "Neutral", "Agree", CURLY]
        q1 = _column(db, ds, 61011, labels=labels, codes=[1, 2, 3, 8])
        _cells(db, ds, q1, [("Agree", 3.0), ("Disagree", 1.0), (CURLY, 8.0),
                            ("Neutral", 2.0), ("Agree", 3.0)], row_base=61010)

        changed = realign_undeclared_numbers(db)

        assert changed == {6101: [q1.id]}
        stored = _stored(db, q1)
        assert stored[CURLY] == {None}
        assert stored["Agree"] == {3.0} and stored["Disagree"] == {1.0}
        # The reader #1069 named now agrees with the text rule.
        vectors, _ = _load_column_vectors(db, [q1.id], 6101)
        assert sorted(vectors[q1.id].values()) == [1.0, 2.0, 3.0, 3.0]

    @pytest.mark.parametrize("text", ["Don't  know", "Na.", "na!"])
    def test_every_widening_arm(self, db_session, text):
        db = db_session
        ds = _project(db, 6102)
        col = _column(db, ds, 61021, labels=["Low", "High", text], codes=[1, 2, 9])
        _cells(db, ds, col, [("Low", 1.0), (text, 9.0)], row_base=61020)
        assert realign_undeclared_numbers(db) == {6102: [col.id]}
        assert _stored(db, col)[text] == {None}

    def test_a_value_label_dictionary_on_a_numeric_column(self, db_session):
        """Declared value labels keep the code in `value_numeric` through a primary
        scale_map — the other writer of a number beside a label (#576)."""
        db = db_session
        ds = _project(db, 6103)
        col = _column(db, ds, 61031, ctype=ColumnType.NUMERIC,
                      labels=["Never", "Always", CURLY], codes=[1, 5, 8])
        db.add(RecodeDefinition(
            column_id=col.id, name="labels", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps({"Never": 1, "Always": 5, CURLY: 8}),
            is_primary=True, is_auto_detected=True, sequence_order=0,
        ))
        _cells(db, ds, col, [("Never", 1.0), (CURLY, 8.0), ("Always", 5.0)], row_base=61030)
        db.flush()

        assert realign_undeclared_numbers(db) == {6103: [col.id]}
        stored = _stored(db, col)
        assert stored[CURLY] == {None}
        assert stored["Never"] == {1.0} and stored["Always"] == {5.0}

    def test_a_reverse_primary_is_re_reflected_about_its_real_scale(self, db_session):
        """The rule change also moved the REFLECTION: a key that became missing no
        longer defines the scale (#600), so every stored score shifts — not only
        the missing cell's own."""
        db = db_session
        ds = _project(db, 6104)
        col = _column(db, ds, 61041, labels=["SD", "D", "A", "SA", CURLY], codes=[1, 2, 3, 4, 8])
        mapping = {"SD": 1, "D": 2, "A": 3, "SA": 4, CURLY: 8}
        db.add(RecodeDefinition(
            column_id=col.id, name="reversed", recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        ))
        # Reflected under v1.5.4's rule: CURLY was a scale point, so the offset
        # was 1 + 8 = 9 and "SD" scored 8.
        _cells(db, ds, col, [("SD", 8.0), ("SA", 5.0), (CURLY, 1.0)], row_base=61040)
        db.flush()

        assert realign_undeclared_numbers(db) == {6104: [col.id]}
        stored = _stored(db, col)
        # Offset 1 + 4 = 5 now: SD → 4, SA → 1, and the non-answer is missing.
        assert stored == {"SD": {4.0}, "SA": {1.0}, CURLY: {None}}

    def test_a_recode_rules_mapping_key_alone_makes_a_column_suspect(self, db_session):
        """A researcher's own scale_map on a column with no scale labels: the only
        place the non-answer appears is the rule's mapping."""
        db = db_session
        ds = _project(db, 6106)
        col = _column(db, ds, 61061, ctype=ColumnType.NOMINAL)
        db.add(RecodeDefinition(
            column_id=col.id, name="yes/no", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"Yes": 1, "No": 0, CURLY: 9}),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        ))
        _cells(db, ds, col, [("Yes", 1.0), (CURLY, 9.0), ("No", 0.0)], row_base=61060)
        db.flush()
        assert realign_undeclared_numbers(db) == {6106: [col.id]}
        stored = _stored(db, col)
        assert stored[CURLY] == {None} and stored["No"] == {0.0}

    def test_a_reverse_primary_drifts_even_where_no_cell_says_the_non_answer(self, db_session):
        """The reflection moved for EVERY cell, so the re-apply cannot wait for a
        cell holding the non-answer — here there is none."""
        db = db_session
        ds = _project(db, 6107)
        col = _column(db, ds, 61071, labels=["SD", "SA", CURLY], codes=[1, 4, 8])
        db.add(RecodeDefinition(
            column_id=col.id, name="reversed", recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"SD": 1, "SA": 4, CURLY: 8}),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        ))
        _cells(db, ds, col, [("SD", 8.0), ("SA", 5.0)], row_base=61070)  # offset 9, old rule
        db.flush()
        assert realign_undeclared_numbers(db) == {6107: [col.id]}
        assert _stored(db, col) == {"SD": {4.0}, "SA": {1.0}}

    def test_metrics_on_the_column_are_marked_stale_and_no_others(self, db_session):
        db = db_session
        ds = _project(db, 6105)
        q1 = _column(db, ds, 61051, labels=["Low", "High", CURLY], codes=[1, 2, 8])
        q2 = _column(db, ds, 61052, ctype=ColumnType.NUMERIC, seq=1)
        _cells(db, ds, q1, [("Low", 1.0), (CURLY, 8.0)], row_base=61050)
        _cells(db, ds, q2, [("3", 3.0), ("4", 4.0)], row_base=61050)
        on_q1 = MetricDefinition(project_id=6105, name="q1", metric_type="mean", config="{}",
                                 input_source_type="dataset_column", input_source_id=q1.id, stale=False)
        on_q2 = MetricDefinition(project_id=6105, name="q2", metric_type="mean", config="{}",
                                 input_source_type="dataset_column", input_source_id=q2.id, stale=False)
        db.add_all([on_q1, on_q2])
        db.flush()

        realign_undeclared_numbers(db)
        db.refresh(on_q1)
        db.refresh(on_q2)
        assert on_q1.stale is True
        assert on_q2.stale is False


class TestWhatItLeavesAlone:
    def test_a_declared_column_is_the_declarations_business(self, db_session):
        """A declaration REPLACES the defaults (#592 §I.7) and its matching did not
        change with #1048 — `[]` says nothing is missing, so the 8 is data."""
        db = db_session
        ds = _project(db, 6111)
        col = _column(db, ds, 61111, labels=["Low", "High", CURLY], codes=[1, 2, 8],
                      missing_values="[]")
        _cells(db, ds, col, [("Low", 1.0), (CURLY, 8.0)], row_base=61110)
        assert realign_undeclared_numbers(db) == {}
        assert _stored(db, col)[CURLY] == {8.0}

    def test_a_declared_column_costs_no_read(self, db_session):
        """A labelled missing declaration (the ordinary state after a `.sav`
        import) must not make a column "suspect" at every boot."""
        db = db_session
        ds = _project(db, 6115)
        col = _column(db, ds, 61151, labels=["Low", "High"], codes=[1, 2],
                      missing_values=json.dumps([{"value": "8", "label": CURLY}]))
        _cells(db, ds, col, [("Low", 1.0), (CURLY, None)], row_base=61150)
        db.add(RecodeDefinition(
            column_id=col.id, name="labels", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"Low": 1, "High": 2, CURLY: 8}),
            is_primary=True, is_auto_detected=True, sequence_order=0,
        ))
        db.flush()
        statements: list[str] = []
        engine = db.get_bind()

        def _record(conn, cursor, statement, params, context, executemany):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", _record)
        try:
            assert realign_undeclared_numbers(db) == {}
        finally:
            event.remove(engine, "before_cursor_execute", _record)
        assert not [s for s in statements if "dataset_values" in s]

    def test_an_already_consistent_column_is_not_written(self, db_session):
        """ASCII "Don't know" was missing under BOTH rules, so its cell is already
        NULL: the column is examined (its label is missing) and nothing changes."""
        db = db_session
        ds = _project(db, 6112)
        col = _column(db, ds, 61121, labels=["Low", "High", "Don't know"], codes=[1, 2, 8])
        _cells(db, ds, col, [("Low", 1.0), ("Don't know", None)], row_base=61120)
        assert realign_undeclared_numbers(db) == {}

    def test_it_is_idempotent(self, db_session):
        db = db_session
        ds = _project(db, 6113)
        col = _column(db, ds, 61131, labels=["Low", CURLY], codes=[1, 8])
        _cells(db, ds, col, [("Low", 1.0), (CURLY, 8.0)], row_base=61130)
        assert realign_undeclared_numbers(db) == {6113: [col.id]}
        assert realign_undeclared_numbers(db) == {}

    def test_a_settled_install_reads_no_cell(self, db_session):
        """Startup waits for this repair, so a column whose labels and mapping keys
        hold no non-answer must cost NO read of `dataset_values` — the gate is the
        whole of the performance argument (4 s per boot un-gated on the test corpus).
        """
        db = db_session
        ds = _project(db, 6114)
        col = _column(db, ds, 61141, labels=["Low", "Mid", "High"], codes=[1, 2, 3])
        _cells(db, ds, col, [("Low", 1.0), ("High", 3.0)], row_base=61140)

        statements: list[str] = []
        engine = db.get_bind()

        def _record(conn, cursor, statement, params, context, executemany):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", _record)
        try:
            assert realign_undeclared_numbers(db) == {}
        finally:
            event.remove(engine, "before_cursor_execute", _record)
        assert statements, "the probe saw no statement at all — it is not measuring"
        assert not [s for s in statements if "dataset_values" in s]


class TestItRunsWhereADatabaseIsOpened:
    def test_the_startup_and_restore_repair_list_runs_it(self, db_session):
        """Entered at `run_data_repairs` — the ONE list the lifespan and a restore
        both call — never at the service (#747's rule for a pipeline call)."""
        from app.services.data_repairs import run_data_repairs

        db = db_session
        ds = _project(db, 6121)
        col = _column(db, ds, 61211, labels=["Low", CURLY], codes=[1, 8])
        _cells(db, ds, col, [("Low", 1.0), (CURLY, 8.0)], row_base=61210)
        db.commit()

        run_data_repairs(lambda: Session(bind=db.get_bind()))

        db.expire_all()
        assert _stored(db, col)[CURLY] == {None}


class TestAnImportedFileIsRealigned:
    def test_a_file_written_by_an_older_build(self, db_session, tmp_path):
        """Entered at `import_project`: the archive carries the old build's number,
        and the import copies `value_numeric` verbatim before the post-pass."""
        from app.services.project_portability import export_project, import_project

        db = db_session
        ds = _project(db, 6131)
        col = _column(db, ds, 61311, labels=["Low", "High", CURLY], codes=[1, 2, 8])
        _cells(db, ds, col, [("Low", 1.0), (CURLY, 8.0), ("High", 2.0)], row_base=61310)
        db.commit()

        docs = tmp_path / "docs"
        docs.mkdir()
        archive = tmp_path / "old.mmproject"
        archive.write_bytes(export_project(db, 6131, docs).getvalue())

        new_pid, _ = import_project(db, archive, tmp_path / "idocs", media_dir=None,
                                    user_id=1, import_mode="new")
        db.flush()
        new_col = (
            db.query(DatasetColumn).join(Dataset)
            .filter(Dataset.project_id == new_pid).one()
        )
        stored = _stored(db, new_col)
        assert stored[CURLY] == {None}
        assert stored["Low"] == {1.0} and stored["High"] == {2.0}
