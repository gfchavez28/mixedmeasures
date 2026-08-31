"""The batched import must round-trip FAITHFULLY across batch boundaries (#847, Batch 2).

**What changed and why this file exists.** `import_project` used to `db.add()` + `db.flush()`
once per entity, because it needs `obj.id` back to populate `remap` before children can
re-point at it. Measured on the real GSS corpus that is ~3.7 million round trips — linear at
0.376–0.433 s per 1,000 values, so **~26 minutes**, against a client that gave up at five.
Rows now flush per batch and values go in via a Core `executemany`, with the remap rebuilt
afterwards from `(row_id, column_id)` — which is UNIQUE.

🔴 **THE RISK THIS GUARDS IS SILENT MIS-ATTRIBUTION, NOT A CRASH.** If the read-back maps a
`(row, column)` pair to the wrong id, then a coding, note or quote lands on a DIFFERENT
answer than the one the researcher coded. Every count still reconciles, the import reports
success, and nothing looks wrong. So the assertions below check WHICH VALUE each child
points at, by its text — never just how many arrived.

🔴 **THE FIXTURE MUST CROSS BOTH BATCH BOUNDARIES.** `dataset_import.py` records the same
lesson from #796b: *"a fixture smaller than ROW_BATCH cannot see that it doesn't"*. A
one-batch fixture exercises none of the drain logic, so it passes identically against an
implementation that drains only once, drops the tail, or rebuilds the remap from the last
partition alone. The sizes below are derived from the constants, not hard-coded, so a change
to either constant moves the fixture with it.

⚠️ **This is a CORRECTNESS guard, not a scale one.** No unit test can carry a 3.6 M-value
corpus. Real-corpus verification is `backend/scripts/measure_portability.py`, run by hand
against `dev.db`; the numbers it produced are in ROADMAP's Batch 2 note.
"""
from __future__ import annotations

import zipfile

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.note import Note
from app.models.project import Project
from app.services import project_portability as pp


#: Derived from the implementation's own batch sizes so the fixture cannot fall behind them.
#: `_ROW_FLUSH_BATCH` (2,000) and `_VALUE_INSERT_BATCH` (10,000) are locals inside
#: `import_project`, so they are mirrored here with an assertion that the fixture clears
#: both — if either constant grows past this fixture, the test says so rather than quietly
#: becoming single-batch again.
ROW_BATCH_MIRROR = 2_000
VALUE_BATCH_MIRROR = 10_000

N_ROWS = ROW_BATCH_MIRROR + 137        # crosses the row flush boundary, unaligned
N_COLS = 7                             # N_ROWS * N_COLS crosses the value batch boundary


@pytest.fixture
def multi_batch_archive(db_session, tmp_path):
    """A project whose rows and values BOTH span several batches, with children on values
    drawn from the first, a middle and the last batch."""
    project = Project(name="Batched", user_id=1)
    db_session.add(project)
    db_session.flush()

    ds = Dataset(project_id=project.id, name="D")
    db_session.add(ds)
    db_session.flush()

    columns = []
    for c in range(N_COLS):
        col = DatasetColumn(
            dataset_id=ds.id, column_name=f"q{c}", column_text=f"Question {c}",
            column_type=ColumnType.OPEN_TEXT if c == 0 else ColumnType.NUMERIC,
            sequence_order=c, display_order=c,
        )
        db_session.add(col)
        columns.append(col)
    db_session.flush()

    rows = [DatasetRow(dataset_id=ds.id, row_identifier=f"R{i:05d}") for i in range(N_ROWS)]
    db_session.add_all(rows)
    db_session.flush()

    # Every value's text encodes its own coordinates, so a mis-mapped child is detectable
    # by READING it rather than by counting.
    values: dict[tuple[int, int], DatasetValue] = {}
    for r, row in enumerate(rows):
        for c, col in enumerate(columns):
            dv = DatasetValue(row_id=row.id, column_id=col.id, value_text=f"r{r}c{c}")
            db_session.add(dv)
            values[(r, c)] = dv
    db_session.flush()

    code = Code(project_id=project.id, name="Theme", numeric_id=1)
    db_session.add(code)
    db_session.flush()

    # Children on values from the FIRST, a MIDDLE and the LAST batch. A read-back that
    # only covers the final partition passes a first-batch-only fixture.
    probe_coords = [(0, 0), (N_ROWS // 2, 3), (N_ROWS - 1, N_COLS - 1)]
    for r, c in probe_coords:
        db_session.add(CodeApplication(
            code_id=code.id, dataset_value_id=values[(r, c)].id, origin="human"))
        db_session.add(Note(
            dataset_value_id=values[(r, c)].id, content=f"note-r{r}c{c}", sequence_number=1))
    db_session.commit()

    buf = pp.export_project(db_session, project.id, tmp_path, tmp_path, include_media=False)
    archive = tmp_path / "batched.mmproject"
    archive.write_bytes(buf.getvalue())
    return archive, probe_coords


def test_the_fixture_actually_crosses_both_batch_boundaries(multi_batch_archive):
    """PRECONDITION — and it is the whole point of the fixture.

    A single-batch fixture exercises none of the drain logic and would pass against an
    implementation that drains once and drops the tail. Assert the sizes rather than trust
    the constants above to still be right.
    """
    archive, _ = multi_batch_archive
    import json
    with zipfile.ZipFile(archive) as zf:
        data = json.loads(zf.read("project.json"))
    assert len(data["dataset_rows"]) > ROW_BATCH_MIRROR, (
        f"fixture has {len(data['dataset_rows'])} rows, which does not cross the "
        f"{ROW_BATCH_MIRROR}-row flush batch — the drain logic is untested"
    )
    assert len(data["dataset_values"]) > VALUE_BATCH_MIRROR, (
        f"fixture has {len(data['dataset_values'])} values, which does not cross the "
        f"{VALUE_BATCH_MIRROR}-value insert batch"
    )


def test_every_row_and_value_survives_a_multi_batch_import(db_session, multi_batch_archive,
                                                           tmp_path):
    """Counts first — the cheap arm. A dropped tail batch shows up here."""
    archive, _ = multi_batch_archive
    new_id, _ = pp.import_project(db_session, archive, tmp_path, tmp_path, user_id=1)

    landed_rows = (
        db_session.query(DatasetRow)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(Dataset.project_id == new_id).count()
    )
    landed_values = (
        db_session.query(DatasetValue)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(Dataset.project_id == new_id).count()
    )
    assert landed_rows == N_ROWS
    assert landed_values == N_ROWS * N_COLS


def test_children_point_at_the_value_they_were_coded_on(db_session, multi_batch_archive,
                                                        tmp_path):
    """🔴 THE ONE THAT MATTERS: the remap read-back must not mis-attribute.

    The batched path rebuilds `remap["dataset_values"]` from a single read-back keyed on
    `(row_id, column_id)`. If that mapping is off — a stale key, a partition boundary, a
    join that picks up another dataset's rows — a coding silently moves to a different
    answer. Counts still reconcile; only the TEXT reveals it.
    """
    archive, probe_coords = multi_batch_archive
    new_id, _ = pp.import_project(db_session, archive, tmp_path, tmp_path, user_id=1)

    codings = (
        db_session.query(CodeApplication, DatasetValue)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(Dataset.project_id == new_id).all()
    )
    assert len(codings) == len(probe_coords), (
        f"expected {len(probe_coords)} imported codings, got {len(codings)}"
    )
    landed_texts = sorted(dv.value_text for _, dv in codings)
    expected_texts = sorted(f"r{r}c{c}" for r, c in probe_coords)
    assert landed_texts == expected_texts, (
        "a coding landed on the WRONG dataset value — the (row, column) read-back "
        "mis-mapped. This is silent corruption: the counts above still reconcile.\n"
        f"  expected: {expected_texts}\n  actual:   {landed_texts}"
    )

    notes = (
        db_session.query(Note, DatasetValue)
        .join(DatasetValue, Note.dataset_value_id == DatasetValue.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(Dataset.project_id == new_id).all()
    )
    assert sorted(n.content for n, _ in notes) == sorted(
        f"note-r{r}c{c}" for r, c in probe_coords)
    for note, dv in notes:
        assert note.content == f"note-{dv.value_text}", (
            f"note {note.content!r} is attached to value {dv.value_text!r} — the remap "
            f"crossed two values over"
        )


def test_the_import_does_not_flush_once_per_value(db_session, multi_batch_archive, tmp_path,
                                                  monkeypatch):
    """STRUCTURAL: prove the batching is actually in effect, not merely intended.

    Every assertion above passes just as well against the old per-entity-flush code — it was
    correct, only slow — so nothing else in this file can tell the two apart. Count the
    INSERT statements the import issues and require far fewer than one per value.
    ⚠️ Counting STATEMENTS, not flushes: a Core `executemany` is one statement carrying
    thousands of rows, which is exactly the property being pinned.
    """
    from sqlalchemy import event

    archive, _ = multi_batch_archive
    engine = db_session.get_bind()
    value_inserts = 0

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        nonlocal value_inserts
        if statement.lstrip().upper().startswith("INSERT INTO DATASET_VALUES"):
            value_inserts += 1

    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    try:
        pp.import_project(db_session, archive, tmp_path, tmp_path, user_id=1)
    finally:
        event.remove(engine, "before_cursor_execute", before_cursor_execute)

    n_values = N_ROWS * N_COLS
    # Generous: the batched path issues ceil(n / 10_000) statements. Anything near `n_values`
    # means the per-entity flush is back.
    assert value_inserts < n_values / 50, (
        f"{value_inserts} INSERT statements for {n_values} values — the per-entity flush "
        f"is back (#847). Expected roughly {-(-n_values // VALUE_BATCH_MIRROR)}."
    )
    assert value_inserts > 0, "no dataset_values INSERT seen — the listener never fired"
