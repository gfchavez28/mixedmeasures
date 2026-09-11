"""#897 — a row born without a cell is read-only in that column forever.

The claim under test is NOT "a `DatasetValue` row exists". It is **the researcher
can type into the cell**, so the central tests drive `update_value` — the only
endpoint that writes one, and the reason the absence is fatal rather than
cosmetic (it is addressed by an existing `DatasetValue.id`, so a missing cell has
no address and `EditableCell` discards the edit with no error).

Two live instances were measured before the fix:

  * `participant_dataset.sync_rows` — a participant who joins AFTER a variable
    was added gets a row and no cell for it;
  * `append_import` — appended rows get cells only for the columns the FILE was
    mapped to, so a manual variable the file knows nothing about gets none.

and a third path, `.mmproject` import/merge, builds rows by REFLECTION and is
structurally invisible to the AST scan below — it has its own test.
"""

import ast
import asyncio
import io

import pytest
from fastapi import UploadFile

from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import create_manual_column, update_value
from app.schemas.dataset import ManualColumnCreate, ValueUpdate
from app.services.dataset_rows import (
    EDITABLE_COLUMN_SOURCE,
    materialise_manual_cells,
)
from app.services.participant_dataset import (
    MANAGED_COLUMN_SOURCE,
    create_participant_dataset,
    sync_rows,
)
from tests.guard_support import app_files


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=1, name="PD audit", user_id=1))
    db.flush()
    for ident in ("E-01", "E-02", "E-03"):
        db.add(Participant(project_id=1, identifier=ident))
    db.flush()
    return db


def _user(db):
    return db.query(User).filter(User.id == 1).one()


def _add_manual_column(db, dataset_id, name="Site", column_type="nominal"):
    _run(create_manual_column(
        project_id=1,
        dataset_id=dataset_id,
        req=ManualColumnCreate(column_text=name, column_type=column_type),
        user=_user(db),
        db=db,
    ))
    return (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.column_text == name,
        )
        .one()
    )


def _cell(db, row_id, column_id):
    return (
        db.query(DatasetValue)
        .filter(DatasetValue.row_id == row_id, DatasetValue.column_id == column_id)
        .first()
    )


class TestTheParticipantTableInstance:
    """The measured one: add a variable, then add a participant."""

    def test_a_participant_who_joins_later_can_be_typed_about(self, project):
        db = project
        dataset = create_participant_dataset(db, 1)
        db.commit()
        column = _add_manual_column(db, dataset.id)

        db.add(Participant(project_id=1, identifier="E-04"))
        db.flush()
        sync_rows(db, dataset)
        db.commit()

        row = (
            db.query(DatasetRow)
            .filter(
                DatasetRow.dataset_id == dataset.id,
                DatasetRow.row_identifier == "E-04",
            )
            .one()
        )
        cell = _cell(db, row.id, column.id)
        assert cell is not None, (
            "the newly synced row has no cell for the researcher's own variable, "
            "so the grid cannot save an edit to it (#897)"
        )

        # 🔴 The claim, in the channel it lives in: the cell is WRITABLE.
        # Asserting only that a row exists would pass against a cell the server
        # then refuses.
        result = _run(update_value(
            project_id=1, dataset_id=dataset.id, value_id=cell.id,
            req=ValueUpdate(value_text="Northside"),
            user=_user(db), db=db,
        ))
        assert result.value_text == "Northside"

    def test_the_reconcile_repairs_a_table_that_already_has_the_gap(self, project):
        """The sync is dataset-wide on purpose — a participant table already in
        the wild carries rows with no cell, and a fix scoped to the rows it just
        added would leave every one of them permanently uneditable."""
        db = project
        dataset = create_participant_dataset(db, 1)
        db.commit()
        column = _add_manual_column(db, dataset.id)

        # Reproduce the historical state: a row with no cell for the column.
        orphan = db.query(DatasetRow).filter(
            DatasetRow.dataset_id == dataset.id).first()
        db.query(DatasetValue).filter(
            DatasetValue.row_id == orphan.id,
            DatasetValue.column_id == column.id,
        ).delete(synchronize_session=False)
        db.flush()
        assert _cell(db, orphan.id, column.id) is None  # precondition

        sync_rows(db, dataset)
        assert _cell(db, orphan.id, column.id) is not None

    def test_it_writes_nothing_on_a_second_run(self, project):
        db = project
        dataset = create_participant_dataset(db, 1)
        db.commit()
        _add_manual_column(db, dataset.id)

        before = db.query(DatasetValue).count()
        sync_rows(db, dataset)
        sync_rows(db, dataset)
        assert db.query(DatasetValue).count() == before


class TestWhichColumnsGetACell:
    """The set is exactly what `update_value` will write — not every column."""

    def _dataset_with_a_row(self, db):
        ds = Dataset(project_id=1, name="Survey")
        db.add(ds)
        db.flush()
        row = DatasetRow(dataset_id=ds.id, row_identifier="R0001")
        db.add(row)
        db.flush()
        return ds, row

    def test_an_imported_column_gets_no_cell(self, project):
        """Sparse BY DESIGN — the importer skips a blank cell, and `update_value`
        403s the column anyway, so a cell here is one row per blank on a
        3.1M-cell import to make editable something the server refuses."""
        db = project
        ds, row = self._dataset_with_a_row(db)
        col = DatasetColumn(
            dataset_id=ds.id, column_text="Q1", column_type=ColumnType.ORDINAL,
            sequence_order=0, source="imported",
        )
        db.add(col)
        db.flush()

        assert materialise_manual_cells(db, ds.id) == 0
        assert _cell(db, row.id, col.id) is None

    def test_a_computed_column_gets_no_cell(self, project):
        """It heals itself — `recompute_column_values` UPSERTS."""
        db = project
        ds, row = self._dataset_with_a_row(db)
        col = DatasetColumn(
            dataset_id=ds.id, column_text="Total", column_type=ColumnType.NUMERIC,
            sequence_order=0, source="computed", expression="1 + 1",
        )
        db.add(col)
        db.flush()

        assert materialise_manual_cells(db, ds.id) == 0
        assert _cell(db, row.id, col.id) is None

    def test_a_managed_column_gets_no_cell(self, project):
        """🔴 An absent cell MEANS something on a tool-maintained column (row 45:
        no usable rating ⇒ no cell, and NULL is never zero). A blank cell here
        would be a claim the rollup never made."""
        db = project
        ds, row = self._dataset_with_a_row(db)
        col = DatasetColumn(
            dataset_id=ds.id, column_text="Initiative (score)",
            column_type=ColumnType.NUMERIC, sequence_order=0,
            source=MANAGED_COLUMN_SOURCE,
        )
        db.add(col)
        db.flush()

        assert materialise_manual_cells(db, ds.id) == 0
        assert _cell(db, row.id, col.id) is None

    def test_a_manual_column_does(self, project):
        db = project
        ds, row = self._dataset_with_a_row(db)
        col = DatasetColumn(
            dataset_id=ds.id, column_text="Site", column_type=ColumnType.NOMINAL,
            sequence_order=0, source=EDITABLE_COLUMN_SOURCE,
        )
        db.add(col)
        db.flush()

        assert materialise_manual_cells(db, ds.id) == 1
        cell = _cell(db, row.id, col.id)
        assert cell is not None
        # An empty cell, not a zero or a blank string — the importer's own
        # treatment of "nothing was answered here".
        assert cell.value_text is None
        assert cell.value_numeric is None

    def test_a_partly_filled_row_gets_only_what_it_lacks(self, project):
        """Idempotent PER CELL, not per row: a row holding three of four cells
        gets the fourth, never a duplicate of the three (which the unique index
        `ix_dataset_values_row_column` would reject at commit)."""
        db = project
        ds, row = self._dataset_with_a_row(db)
        cols = []
        for i, name in enumerate(("A", "B")):
            col = DatasetColumn(
                dataset_id=ds.id, column_text=name,
                column_type=ColumnType.NOMINAL, sequence_order=i,
                source=EDITABLE_COLUMN_SOURCE,
            )
            db.add(col)
            cols.append(col)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=cols[0].id, value_text="kept"))
        db.flush()

        assert materialise_manual_cells(db, ds.id) == 1
        assert _cell(db, row.id, cols[0].id).value_text == "kept"
        assert _cell(db, row.id, cols[1].id) is not None
        db.commit()  # the unique index would fire here on a duplicate


class TestTheAppendInstance:
    """`append_import` writes cells only for the columns the FILE maps to."""

    def test_an_appended_row_can_be_typed_about(self, project):
        import json

        from app.routers.dataset import append_import

        db = project
        ds = Dataset(project_id=1, name="Survey")
        db.add(ds)
        db.flush()
        imported = DatasetColumn(
            dataset_id=ds.id, column_text="Q1", column_type=ColumnType.NOMINAL,
            sequence_order=0, source="imported",
        )
        db.add(imported)
        db.flush()
        db.commit()

        manual = _add_manual_column(db, ds.id, name="Site")

        upload = UploadFile(
            filename="more.csv", file=io.BytesIO(b"Q1\nyes\n"),
        )
        resp = _run(append_import(
            project_id=1,
            dataset_id=ds.id,
            file=upload,
            import_config=json.dumps({
                "column_mapping": [
                    {"csv_column_index": 0, "column_id": imported.id},
                ],
                "skip_duplicates": False,
            }),
            encoding="utf-8",
            user=_user(db),
            db=db,
        ))
        assert resp.rows_created == 1, "precondition: the append created a row"

        appended = (
            db.query(DatasetRow)
            .filter(DatasetRow.dataset_id == ds.id,
                    DatasetRow.import_batch.isnot(None))
            .all()
        )
        assert len(appended) == 1, "precondition: the append created a row"
        cell = _cell(db, appended[0].id, manual.id)
        assert cell is not None, (
            "the appended row has no cell for the manual variable, so the grid "
            "cannot save an edit to it (#897)"
        )
        result = _run(update_value(
            project_id=1, dataset_id=ds.id, value_id=cell.id,
            req=ValueUpdate(value_text="Northside"),
            user=_user(db), db=db,
        ))
        assert result.value_text == "Northside"


class TestEveryRowConstructorMaterialisesCells:
    """The fail-closed scan. A fourth `DatasetRow(` site must fail HERE rather
    than ship the fourth instance of this defect.

    Keyed on the CONSTRUCTOR — what a function does — rather than on a list of
    the three that exist (#515/#676: pin the relationship between the two sets,
    never the variant you just added).

    ⚠️ Structurally blind to `project_portability`, which builds rows by
    REFLECTION and contains no `DatasetRow(` at all — the same blindness
    `participant_dataset`'s docstring records for `Participant(`. That path has
    its own test below; this scan asserts its own blindness so the gap is
    recorded rather than assumed.
    """

    #: Constructor sites that legitimately do not call the materialiser. Each
    #: needs a reason, and `test_the_allowlist_has_no_stale_entries` fails when
    #: one stops being a constructor site.
    ALLOWLIST: dict[str, str] = {}

    @staticmethod
    def _constructs_a_row(node: ast.AST) -> bool:
        """A CALL to `DatasetRow(...)`, never a mere reference to the name.

        ⚠️ The first draft tested `"id='DatasetRow'" in ast.dump(node)` and
        reported **35 phantoms** — every `db.query(DatasetRow.id)` in the
        codebase, each pointing at a real line and looking exactly like the
        defect. #772's rule reached from the Python side: a scan that reads a
        reference as a construction is worse than one that finds nothing.
        """
        return any(
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == "DatasetRow"
            for n in ast.walk(node)
        )

    def _sites(self) -> dict[str, bool]:
        """``{qualified function name: does it call the materialiser}`` for every
        function in `app/` that constructs a `DatasetRow`."""
        found: dict[str, bool] = {}
        for path in app_files(floor=100, sentinels=("services/dataset_rows.py",)):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if not self._constructs_a_row(node):
                    continue
                key = f"{path.relative_to(path.parents[1])}::{node.name}"
                found[key] = "materialise_manual_cells" in ast.dump(node)
        return found

    def test_the_scan_finds_the_known_sites(self):
        """Population self-check (#729/#730): a walk that resolves to nothing
        passes an `all(...)` test by finding nothing."""
        found = self._sites()
        assert len(found) >= 3, (
            f"the constructor scan found {len(found)} site(s) — it has gone "
            "blind; three are known to exist (dataset_import, append_import, "
            "participant_dataset.sync_rows)"
        )

    def test_the_predicate_actually_discriminates(self):
        """Falsifier: prove the matcher can say NO. A predicate matching every
        function would pass the gate test trivially."""
        sites = self._sites()
        all_functions = 0
        for path in app_files(floor=100):
            tree = ast.parse(path.read_text())
            all_functions += sum(
                1 for n in ast.walk(tree)
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            )
        assert all_functions > len(sites) * 10, (
            "the matcher selected too much of the codebase to be discriminating"
        )

    def test_every_constructor_site_materialises_cells(self):
        offenders = sorted(
            name for name, calls in self._sites().items()
            if not calls and name not in self.ALLOWLIST
        )
        assert offenders == [], (
            f"{offenders} construct a DatasetRow without calling "
            "`services/dataset_rows.py::materialise_manual_cells`. A row created "
            "without a cell for a hand-editable column can NEVER be typed into "
            "— `PATCH …/values/{value_id}` is addressed by an existing cell and "
            "there is no create (#897). Call it after the rows are flushed, or "
            "add the site to ALLOWLIST with a reason."
        )

    def test_the_allowlist_has_no_stale_entries(self):
        sites = self._sites()
        stale = sorted(set(self.ALLOWLIST) - set(sites))
        assert stale == [], f"{stale} are no longer DatasetRow constructor sites"

    def test_the_scan_is_blind_to_reflection_and_says_so(self):
        """The recorded negative (#772's rule stated as its own assertion):
        `project_portability` creates rows and this scan cannot see it, so
        nobody may read a green result as covering that path."""
        sites = self._sites()
        assert not any("project_portability" in name for name in sites), (
            "project_portability now constructs a DatasetRow explicitly — this "
            "scan can see it, so remove this test and let the gate cover it"
        )


class TestTheMergeInstance:
    """The third path, and the one the AST scan cannot see.

    🔴 **Entered at the pipeline's MOUTH (`import_project`), never by calling the
    materialiser.** A unit test of the callee proves the function works and says
    nothing about whether the pipeline reaches it — which is exactly how
    `renumber_imported_notes` renumbered nothing on every import while all three
    of its guards passed (#747 → #714 → #757).
    """

    def test_a_row_a_merge_brings_back_can_be_typed_about(self, project, tmp_path):
        from app.services.project_portability import export_project, import_project

        db = project
        ds = Dataset(project_id=1, name="Survey")
        db.add(ds)
        db.flush()
        imported = DatasetColumn(
            dataset_id=ds.id, column_text="Q1", column_type=ColumnType.NOMINAL,
            sequence_order=0, source="imported",
        )
        db.add(imported)
        db.flush()
        kept = DatasetRow(dataset_id=ds.id, row_identifier="R0001")
        colleagues = DatasetRow(dataset_id=ds.id, row_identifier="R0002")
        db.add_all([kept, colleagues])
        db.flush()
        db.add(DatasetValue(row_id=colleagues.id, column_id=imported.id,
                            value_text="yes"))
        db.flush()
        db.commit()

        # The colleague's copy — taken while both records existed.
        archive = tmp_path / "colleague.mmproject"
        archive.write_bytes(export_project(db, 1, tmp_path / "docs").getvalue())

        # Locally: that record is not here, and a variable was added afterwards.
        # `create_manual_column` backfills the row that EXISTS, so the gap can
        # only arrive with the merge.
        db.delete(colleagues)
        db.flush()
        db.commit()
        manual = _add_manual_column(db, ds.id, name="Site")
        assert _cell(db, kept.id, manual.id) is not None  # precondition

        import_project(
            db, archive, tmp_path / "docs", user_id=1,
            import_mode="merge", target_project_id=1,
        )
        db.flush()

        returned = (
            db.query(DatasetRow)
            .filter(DatasetRow.dataset_id == ds.id,
                    DatasetRow.row_identifier == "R0002")
            .one()
        )
        assert _cell(db, returned.id, manual.id) is not None, (
            "the merged-in record has no cell for the local manual variable, so "
            "the grid cannot save an edit to it (#897)"
        )
        result = _run(update_value(
            project_id=1, dataset_id=ds.id,
            value_id=_cell(db, returned.id, manual.id).id,
            req=ValueUpdate(value_text="Northside"),
            user=_user(db), db=db,
        ))
        assert result.value_text == "Northside"


class TestItRepairsAndNotOnlyPrevents:
    """🔴 The call is DATASET-WIDE at every site, which is what makes it a
    repair. A version scoped to the rows it just created is correct for new
    damage and useless for old — and every install that has already appended to
    a dataset with a manual variable is carrying old damage."""

    def test_an_appended_row_from_BEFORE_the_fix_becomes_editable(self, project):
        import json

        from app.routers.dataset import append_import

        db = project
        ds = Dataset(project_id=1, name="Survey")
        db.add(ds)
        db.flush()
        imported = DatasetColumn(
            dataset_id=ds.id, column_text="Q1", column_type=ColumnType.NOMINAL,
            sequence_order=0, source="imported",
        )
        db.add(imported)
        db.flush()
        db.commit()
        manual = _add_manual_column(db, ds.id, name="Site")

        # The historical state: a row that arrived with no cell for `Site`,
        # exactly as every pre-fix append left one.
        stranded = DatasetRow(dataset_id=ds.id, row_identifier="R0099")
        db.add(stranded)
        db.flush()
        db.commit()
        assert _cell(db, stranded.id, manual.id) is None  # precondition

        # An ORDINARY later append repairs it, because the call is dataset-wide.
        upload = UploadFile(filename="more.csv", file=io.BytesIO(b"Q1\nyes\n"))
        _run(append_import(
            project_id=1, dataset_id=ds.id, file=upload,
            import_config=json.dumps({
                "column_mapping": [
                    {"csv_column_index": 0, "column_id": imported.id},
                ],
                "skip_duplicates": False,
            }),
            encoding="utf-8", user=_user(db), db=db,
        ))

        assert _cell(db, stranded.id, manual.id) is not None, (
            "the pre-existing stranded row was not repaired — the call is "
            "scoped to the new rows again (#897)"
        )
