"""#921 — merging two copies that each hold a MANAGED dataset.

Two collaborators each press *Add participant table* on their own copy. The
tables mean the same thing and carry different uuids, so the merge used to try
to INSERT the incoming one and die on `uq_datasets_project_managed_kind` — an
`IntegrityError` that is neither `MergeDivergenceError` nor `ValueError`, so the
researcher got a bare 500 naming nothing.

🔴 **The fix is THREE coordinated changes and each one is only visible once the
one before it works.** Matching the dataset moves the collision down to
`ix_dataset_columns_dataset_sequence_unique`; fixing that moves it down again to
`uq_dataset_rows_dataset_participant`. Every test below that merges at all is
therefore a regression test for all three at once — the per-part assertions are
what say WHICH one broke.
"""

import json
import os
import uuid as _uuid
import zipfile
from io import BytesIO
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.services.participant_dataset import (
    MANAGED_COLUMN_SOURCE,
    MANAGED_KIND_PARTICIPANTS,
    create_participant_dataset,
)
from app.services.project_portability import export_project, import_project


@pytest.fixture
def db_session():
    from app.database import Base, engine, SessionLocal
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    db.add(User(id=1, username="testuser", password_hash="x", is_admin=True))
    db.flush()
    try:
        yield db
    finally:
        db.rollback()
        db.close()
        Base.metadata.drop_all(bind=engine)


def _seed(db: Session, *, own_column: str | None, cell: str = "North") -> tuple[Project, Dataset]:
    """A project with two participants, its participant table, and optionally one
    column the RESEARCHER made with a cell in it.

    `own_column` is the axis the whole file turns on: whether the TARGET already
    holds a hand-made column decides whether the incoming one collides.
    """
    p = Project(name="Team", status="active", user_id=1, project_uuid=str(_uuid.uuid4()))
    db.add(p)
    db.flush()
    for ident in ("P-01", "P-02"):
        db.add(Participant(project_id=p.id, identifier=ident))
    db.flush()

    dataset = create_participant_dataset(db, p.id)
    if own_column is not None:
        column = DatasetColumn(
            dataset_id=dataset.id,
            column_text=own_column,
            column_type=ColumnType.NOMINAL,
            sequence_order=1,
            display_order=1,
            source="manual",
        )
        db.add(column)
        db.flush()
        row = db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).first()
        db.add(DatasetValue(row_id=row.id, column_id=column.id, value_text=cell))
        db.flush()
    return p, dataset


def _colleagues_copy(
    db: Session,
    project: Project,
    tmp_path: Path,
    *,
    rename: tuple[str, str] | None = None,
    recell: str | None = None,
) -> Path:
    """Export the project, then re-stamp the managed table's uuids so the file
    reads as a copy where the colleague built their OWN participant table.

    ⚠️ `project_uuid` is globally unique and a merge is keyed on it, so the two
    copies cannot both exist in one test database. Re-stamping the ENTITY uuids
    inside the file is what makes the colleague's table distinguishable from the
    target's while the project still matches. `rename` additionally turns the
    exported hand-made column into a DIFFERENT one, which is what a colleague who
    added their own variable actually produces.
    """
    src = tmp_path / "export.mmproject"
    docs = tmp_path / "docs"
    docs.mkdir(exist_ok=True)
    src.write_bytes(export_project(db, project.id, docs).getvalue())

    zin = zipfile.ZipFile(src)
    data = json.loads(zin.read("project.json"))
    managed_ids = {d["_original_id"] for d in data["datasets"] if d.get("managed_kind")}
    assert managed_ids, "fixture is degenerate: the export carries no managed dataset"

    for d in data["datasets"]:
        if d["_original_id"] in managed_ids:
            d["uuid"] = f"colleague-ds-{d['_original_id']}"
    for i, c in enumerate(data["dataset_columns"]):
        if c.get("dataset_id") in managed_ids:
            c["uuid"] = f"colleague-col-{i}"
            if rename is not None and c.get("column_text") == rename[0]:
                c["column_text"] = rename[1]
    for i, r in enumerate(data["dataset_rows"]):
        if r.get("dataset_id") in managed_ids:
            r["uuid"] = f"colleague-row-{i}"
    if recell is not None:
        for v in data["dataset_values"]:
            if v.get("value_text") is not None and v["value_text"] not in ("P-01", "P-02"):
                v["value_text"] = recell

    dest = tmp_path / "colleague.mmproject"
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        for name in zin.namelist():
            zout.writestr(name, json.dumps(data) if name == "project.json" else zin.read(name))
    dest.write_bytes(buf.getvalue())
    return dest


def _merge(db: Session, project: Project, merge_file: Path, tmp_path: Path) -> None:
    import_project(
        db, merge_file, tmp_path / "docs", media_dir=None, user_id=1,
        import_mode="merge", target_project_id=project.id,
    )
    db.flush()


def _columns(db: Session, dataset_id: int) -> list[DatasetColumn]:
    return (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset_id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )


class TestTwoParticipantTablesMerge:

    def test_the_merge_no_longer_raises(self, db_session, tmp_path):
        """#921 itself. Before the fix this was
        `IntegrityError: UNIQUE constraint failed: datasets.project_id, datasets.managed_kind`
        surfacing as HTTP 500."""
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"), recell="South")

        _merge(db, p, merge_file, tmp_path)  # the assertion IS that this returns

        assert db.query(Dataset).filter(
            Dataset.project_id == p.id,
            Dataset.managed_kind == MANAGED_KIND_PARTICIPANTS,
        ).count() == 1

    def test_the_fixture_really_carries_two_different_tables(self, db_session, tmp_path):
        """DISCRIMINATION guard. Every test here would pass vacuously if the
        re-stamp were a no-op and the file's table simply matched by uuid — which
        is the state the fix is NOT about. Assert the uuids actually diverge."""
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"))

        with zipfile.ZipFile(merge_file) as zf:
            data = json.loads(zf.read("project.json"))
        incoming = {d["uuid"] for d in data["datasets"] if d.get("managed_kind")}
        assert incoming, "no managed dataset in the file"
        assert dataset.uuid not in incoming
        assert {c["column_text"] for c in data["dataset_columns"]} >= {"Site"}

    def test_the_colleagues_hand_made_column_and_its_cell_survive(self, db_session, tmp_path):
        """🔴 REFUTES #921's filed objection to this fix.

        The entry warned that matching the table "silently discards the
        colleague's hand-made columns". It does not, and the mechanism is why:
        `DatasetColumn` is on the uuid spine, so a column they made has no local
        match and is INSERTED — and `DatasetValue` transitive-matches on
        `(row_id, column_id)`, so its cells land on the matched row.
        """
        db = db_session
        p, dataset = _seed(db, own_column="Cohort", cell="North")
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"), recell="South")

        _merge(db, p, merge_file, tmp_path)

        headings = [c.column_text for c in _columns(db, dataset.id)]
        assert "Cohort" in headings, "the target lost its own column"
        assert "Site" in headings, "the colleague's column was discarded"

        site = next(c for c in _columns(db, dataset.id) if c.column_text == "Site")
        cells = db.query(DatasetValue).filter(DatasetValue.column_id == site.id).all()
        assert [v.value_text for v in cells if v.value_text is not None] == ["South"], (
            "the colleague's cell was discarded"
        )
        # ⚠️ The OTHER row's cell is empty rather than absent, and that is #897
        # doing its job: `materialise_manual_cells` runs at the end of the import,
        # so every row gets a writable cell for the arriving manual column. Without
        # it the second participant's cell could never be typed into.
        assert len(cells) == 2

    def test_the_colleagues_column_is_appended_rather_than_colliding(self, db_session, tmp_path):
        """Part 2 of 3. Both researchers' own column sits at `sequence_order` 1 in
        its own copy, and that index is UNIQUE per dataset — so the incoming one
        must be appended, not honoured.

        ⚠️ This fixture is the one that kills a mutant deleting the re-sequencing:
        the target already holds a column at 1, so the file's 1 collides.
        """
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"))

        _merge(db, p, merge_file, tmp_path)

        orders = [c.sequence_order for c in _columns(db, dataset.id)]
        assert len(orders) == len(set(orders)), f"duplicate sequence_order: {orders}"
        site = next(c for c in _columns(db, dataset.id) if c.column_text == "Site")
        assert site.sequence_order == 2

    def test_it_appends_correctly_when_the_largest_order_is_zero(self, db_session, tmp_path):
        """Part 2 of 3, the OTHER arm — and it exists because the first fixture
        cannot see it.

        A participant table with only its identifier column has
        `max(sequence_order) == 0`, and `0` is falsy: `(max or -1) + 1` wraps back
        to **0** and collides with the identifier column. That is the exact bug
        J3-2b hit on `Code.numeric_id`. With `max == 1` (the fixture above) both
        the correct and the buggy reduction return 2, so only this one discriminates.
        """
        db = db_session
        p, dataset = _seed(db, own_column=None)
        # The colleague added a variable; the target never did.
        colleague_db_column = DatasetColumn(
            dataset_id=dataset.id, column_text="Site", column_type=ColumnType.NOMINAL,
            sequence_order=1, display_order=1, source="manual",
        )
        db.add(colleague_db_column)
        db.flush()
        merge_file = _colleagues_copy(db, p, tmp_path)
        db.delete(colleague_db_column)
        db.flush()

        identifier = _columns(db, dataset.id)
        assert [c.sequence_order for c in identifier] == [0], "fixture must leave max == 0"

        _merge(db, p, merge_file, tmp_path)

        orders = [c.sequence_order for c in _columns(db, dataset.id)]
        assert len(orders) == len(set(orders)), f"duplicate sequence_order: {orders}"
        site = next(c for c in _columns(db, dataset.id) if c.column_text == "Site")
        assert site.sequence_order == 1

    def test_the_tools_own_columns_are_not_duplicated(self, db_session, tmp_path):
        """Part 2 of 3. A `source="managed"` column is DERIVED — the refresh
        rebuilds it — so the incoming copies are skipped. Without the skip the
        table ends up with two identifier columns, both read-only through the #926
        gates, and `sync_score_columns`' last-wins reconcile strands the earlier."""
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"))

        _merge(db, p, merge_file, tmp_path)

        managed = [c for c in _columns(db, dataset.id) if c.source == MANAGED_COLUMN_SOURCE]
        assert len(managed) == 1, [c.column_text for c in managed]
        assert managed[0].column_type == ColumnType.IDENTIFIER

    def test_rows_match_on_their_participant(self, db_session, tmp_path):
        """Part 3 of 3. Both copies hold a row per participant and the merge
        matches `Participant` by uuid, so the incoming rows resolve to the same
        people — `uq_dataset_rows_dataset_participant` refuses a second one."""
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        before = db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).count()
        assert before == 2
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"))

        _merge(db, p, merge_file, tmp_path)

        rows = db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).all()
        assert len(rows) == 2, "the colleague's rows were duplicated onto the same people"
        assert len({r.participant_id for r in rows}) == 2

    def test_a_participant_only_the_colleague_has_gets_a_row(self, db_session, tmp_path):
        """The insert arm of part 3. A person the colleague recruited arrives with
        the merge, and their row has nothing local to match — so it is inserted."""
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        newcomer = Participant(project_id=p.id, identifier="P-03")
        db.add(newcomer)
        db.flush()
        from app.services.participant_dataset import sync_rows
        sync_rows(db, dataset)
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"))

        # The target never met P-03: remove them, so the file reintroduces them.
        db.query(DatasetRow).filter(DatasetRow.participant_id == newcomer.id).delete()
        db.delete(newcomer)
        db.flush()
        assert db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).count() == 2

        _merge(db, p, merge_file, tmp_path)

        rows = db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).all()
        assert len(rows) == 3
        identifiers = {
            db.query(Participant).filter(Participant.id == r.participant_id).first().identifier
            for r in rows
        }
        assert identifiers == {"P-01", "P-02", "P-03"}

    def test_the_merge_is_idempotent(self, db_session, tmp_path):
        """A researcher who merges the same file twice must not grow the table.
        The second pass matches everything the first inserted, including the
        colleague's column (now local, by uuid)."""
        db = db_session
        p, dataset = _seed(db, own_column="Cohort")
        merge_file = _colleagues_copy(db, p, tmp_path, rename=("Cohort", "Site"))

        _merge(db, p, merge_file, tmp_path)
        first = ([c.column_text for c in _columns(db, dataset.id)],
                 db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).count())

        _merge(db, p, merge_file, tmp_path)
        second = ([c.column_text for c in _columns(db, dataset.id)],
                  db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).count())

        assert first == second


class TestAnOrdinaryDatasetIsUnaffected:
    """POPULATION control. The match keys on a non-null `managed_kind`, so an
    ordinary dataset must still match by uuid alone — otherwise the fix would
    silently start merging unrelated tables together."""

    def test_an_ordinary_dataset_with_a_new_uuid_is_inserted(self, db_session, tmp_path):
        db = db_session
        p, _ = _seed(db, own_column=None)
        ordinary = Dataset(project_id=p.id, name="Survey wave 1")
        db.add(ordinary)
        db.flush()
        db.add(DatasetColumn(
            dataset_id=ordinary.id, column_text="Q1", column_type=ColumnType.ORDINAL,
            sequence_order=0, display_order=0, source="imported",
        ))
        db.flush()

        src = tmp_path / "export.mmproject"
        docs = tmp_path / "docs"
        docs.mkdir(exist_ok=True)
        src.write_bytes(export_project(db, p.id, docs).getvalue())
        zin = zipfile.ZipFile(src)
        data = json.loads(zin.read("project.json"))
        target_ids = {
            d["_original_id"] for d in data["datasets"] if not d.get("managed_kind")
        }
        for d in data["datasets"]:
            if d["_original_id"] in target_ids:
                d["uuid"] = f"colleague-ordinary-{d['_original_id']}"
        for i, c in enumerate(data["dataset_columns"]):
            if c.get("dataset_id") in target_ids:
                c["uuid"] = f"colleague-ordinary-col-{i}"
        dest = tmp_path / "colleague.mmproject"
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as zout:
            for name in zin.namelist():
                zout.writestr(name, json.dumps(data) if name == "project.json" else zin.read(name))
        dest.write_bytes(buf.getvalue())

        _merge(db, p, dest, tmp_path)

        ordinary_datasets = db.query(Dataset).filter(
            Dataset.project_id == p.id, Dataset.managed_kind.is_(None),
        ).all()
        assert len(ordinary_datasets) == 2, "an unmatched ordinary dataset must be inserted"
