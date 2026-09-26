"""A merge decides cell by cell whether the target already holds a dataset value (#1015).

`import_project(import_mode="merge")` used to build a `(row, column) -> id` map of every
value in the target's datasets — ~412 MB of a no-op merge's 1.1 GB peak on a 2.95M-value
target — and to record every matched id in the remap, where nothing read it. It now keeps
one bitmask per row ("which columns hold a cell") and resolves an id only for a value
something REFERENCES, through the same (row, column) read-back that inserted values use.

What these pin, each against a fixture where getting it wrong is visible:

- a colleague's NEW coding on a cell the target already holds lands on the TARGET's cell,
  and no second value is written (`TestAReferencedCellResolvesToTheTargets`);
- a cell the target left BLANK (no stored value — the importer stores none for a blank) is
  inserted from the file, beside cells that match, in the same row
  (`TestTheBitmaskIsPerColumn`), with several columns so a bit-position slip shows;
- the remap stays PARTIAL on a merge: an unreferenced matched value is not recorded (#994's
  rule, which the match branch did not follow before).
"""
from __future__ import annotations

import uuid as _uuid
from pathlib import Path

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.user import User
from app.services import project_portability as pp
from app.services.project_portability import export_project, import_project


@pytest.fixture
def db_session():
    """Per-test empty database session with User id=1 (the merge suite's fixture)."""
    from app.database import Base, SessionLocal, engine
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    db.add(User(id=1, username="testuser", password_hash="x", is_admin=True))
    db.add(User(id=2, username="Bob", password_hash="x", is_admin=False, coder_type="human"))
    db.flush()
    try:
        yield db
    finally:
        db.rollback()
        db.close()
        Base.metadata.drop_all(bind=engine)


def _survey(db, n_cols: int = 4):
    """A project with one dataset: three rows × `n_cols` columns, every cell filled."""
    p = Project(name="Survey", status="active", user_id=1, project_uuid=str(_uuid.uuid4()))
    db.add(p)
    db.flush()
    code = Code(project_id=p.id, numeric_id=0, name="Alpha", is_active=True)
    ds = Dataset(project_id=p.id, name="Wave 1")
    db.add_all([code, ds])
    db.flush()
    cols = []
    for i in range(n_cols):
        c = DatasetColumn(dataset_id=ds.id, column_name=f"Q{i}", column_text=f"Q{i}",
                          column_type="open_text", sequence_order=i, display_order=i)
        db.add(c)
        cols.append(c)
    db.flush()
    rows = []
    for r in range(3):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{r + 1}")
        db.add(row)
        rows.append(row)
    db.flush()
    cells = {}
    for row in rows:
        for c in cols:
            v = DatasetValue(row_id=row.id, column_id=c.id, value_text=f"{row.row_identifier}-{c.column_name}")
            db.add(v)
            cells[(row.id, c.id)] = v
    db.flush()
    return p, code, rows, cols, cells


def _export(db, pid, tmp_path: Path) -> Path:
    dest = tmp_path / "copy.mmproject"
    dest.write_bytes(export_project(db, pid, tmp_path / "docs").getvalue())
    return dest


def _merge(db, p, f, tmp_path):
    report: dict = {}
    import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                   target_project_id=p.id, report=report)
    db.flush()
    db.expire_all()
    return report


def _values_in(db, ds_id) -> int:
    return (
        db.query(DatasetValue).join(DatasetRow)
        .filter(DatasetRow.dataset_id == ds_id).count()
    )


class TestAReferencedCellResolvesToTheTargets:
    def test_a_colleagues_new_coding_lands_on_the_existing_cell(self, db_session, tmp_path):
        db = db_session
        p, code, rows, cols, cells = _survey(db)
        target_cell = cells[(rows[1].id, cols[2].id)]
        # The colleague's copy carries a coding on that cell; the target does not.
        app = CodeApplication(dataset_value_id=target_cell.id, code_id=code.id,
                              user_id=2, origin="human")
        db.add(app)
        db.flush()
        f = _export(db, p.id, tmp_path)
        db.delete(app)
        db.flush()
        ds_id = rows[0].dataset_id
        before = _values_in(db, ds_id)

        report = _merge(db, p, f, tmp_path)

        landed = db.query(CodeApplication).filter(CodeApplication.user_id == 2).all()
        assert len(landed) == 1 and report["applications_added"] == 1
        assert landed[0].dataset_value_id == target_cell.id, (
            "the colleague's coding must sit on the target's own cell, not a copy of it"
        )
        assert _values_in(db, ds_id) == before, "a matched cell must not be written twice"


class TestTheBitmaskIsPerColumn:
    def test_a_blank_cell_in_the_target_is_filled_while_its_neighbours_match(
        self, db_session, tmp_path
    ):
        db = db_session
        p, code, rows, cols, cells = _survey(db, n_cols=5)
        f = _export(db, p.id, tmp_path)
        # The target has since lost two cells in DIFFERENT columns of different rows
        # (a blank stores no row), so matching must be per (row, column), not per row.
        for key in ((rows[0].id, cols[3].id), (rows[2].id, cols[0].id)):
            db.delete(cells[key])
        db.flush()
        ds_id = rows[0].dataset_id

        _merge(db, p, f, tmp_path)

        assert _values_in(db, ds_id) == 15, "exactly the two missing cells come back"
        restored = {
            (v.row_id, v.column_id): v.value_text
            for v in db.query(DatasetValue).join(DatasetRow)
            .filter(DatasetRow.dataset_id == ds_id)
        }
        assert restored[(rows[0].id, cols[3].id)] == "R1-Q3"
        assert restored[(rows[2].id, cols[0].id)] == "R3-Q0"


class TestTheRemapStaysPartialOnAMerge:
    def test_an_unreferenced_matched_value_is_not_recorded(self, db_session, tmp_path, monkeypatch):
        """#994's rule on the match branch: nothing asks about these ids, so none are kept."""
        db = db_session
        p, code, rows, cols, cells = _survey(db)
        coded = cells[(rows[0].id, cols[0].id)]
        db.add(CodeApplication(dataset_value_id=coded.id, code_id=code.id, user_id=1,
                               origin="human"))
        db.flush()
        f = _export(db, p.id, tmp_path)

        seen: dict = {}
        real = pp._remap_id

        def spy(remap, key, old_id):
            if key == "dataset_values" and not seen:
                seen.update(remap["dataset_values"])
            return real(remap, key, old_id)

        monkeypatch.setattr(pp, "_remap_id", spy)
        report = _merge(db, p, f, tmp_path)

        assert report["duplicates_skipped"] == 1, "the coded cell's application matched"
        assert len(seen) == 1, (
            f"the remap must hold only the ONE referenced value, not all 12: {seen}"
        )
        assert list(seen.values()) == [coded.id]
