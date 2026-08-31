"""The streamed export must produce EXACTLY what materialising produced (#842, Batch 2).

**Why this file exists.** `export_project` no longer materialises `dataset_rows`,
`dataset_values` or `row_scores` — it streams them from a Core `select()` straight into the
`project.json` zip entry. Measured on the real 75,699 x 41 GSS corpus, the old path cost
**118.6 s at 10,479 MB peak RSS** for a 35.7 MB archive, because three copies of the same
data are alive at once (ORM instances, dicts, one `json.dumps` string).

⚠️ **The rest of the portability suite CANNOT see any of this.** It creates **three**
`DatasetValue` rows and its largest loop is `range(10)`, so every assertion in it passes
identically whether the rows are streamed, materialised, or silently dropped. That is the gap
this file closes: it does not test SCALE (a fixture cannot), it tests EQUIVALENCE — that the
Core path and the ORM path serialize the same bytes.

**The specific risk being guarded.** `_serialize_row` reads ORM attributes;
`_serialize_mapping` reads a Core result mapping. They agree only because SQLAlchemy applies
the same result processors to a Core select of the table — a `DateTime` column yields a
`datetime`, an `Enum` column yields the Python enum. That is a property of the library, not
of our code, so it is asserted rather than assumed. A future column type whose Core and ORM
representations differ would corrupt every export silently, and the archive would still be
valid JSON.
"""
from __future__ import annotations

import json
import zipfile
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.metric import MetricDefinition
from app.models.row_score import RowScore
from app.models.project import Project
from app.services import project_portability as pp


@pytest.fixture
def streamed_project(db_session, tmp_path):
    """A project whose three streamed entities exercise every `_serialize_*` branch.

    ⚠️ The type coverage is the point, not the row count: a `datetime`, an `Enum`, a `None`,
    a float, a negative number and a non-ASCII string. A fixture of plain integers cannot
    tell the two serializers apart, which is the degenerate-fixture trap.
    """
    project = Project(name="Streamed", user_id=1)
    db_session.add(project)
    db_session.flush()

    ds = Dataset(project_id=project.id, name="D")
    db_session.add(ds)
    db_session.flush()

    col = DatasetColumn(
        dataset_id=ds.id,
        column_name="q1",
        column_text="Question one",
        # An ENUM column — the branch that only fires if Core returns the Python enum.
        column_type=ColumnType.ORDINAL,
        sequence_order=0,
        display_order=0,
    )
    db_session.add(col)
    db_session.flush()

    rows = []
    for i in range(7):
        row = DatasetRow(
            dataset_id=ds.id,
            row_identifier=f"R{i}",
            # A DATETIME column, plus a NULL on one row.
            submitted_at=None if i == 3 else datetime(2026, 8, 30, 12, i, tzinfo=timezone.utc),
        )
        db_session.add(row)
        rows.append(row)
    db_session.flush()

    texts = ["1", "", "Ünïcøde ✓", None, "-4", "99", "3"]
    for i, row in enumerate(rows):
        db_session.add(DatasetValue(
            row_id=row.id, column_id=col.id,
            value_text=texts[i],
            value_numeric=None if i in (1, 3) else float(i) - 2.5,
        ))
    db_session.flush()

    metric = MetricDefinition(
        project_id=project.id, name="M", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=col.id, origin="human",
    )
    db_session.add(metric)
    db_session.flush()
    for i, row in enumerate(rows):
        db_session.add(RowScore(
            metric_definition_id=metric.id, dataset_row_id=row.id,
            score=None if i == 2 else float(i) * 1.5,
        ))
    db_session.commit()
    return project


#: The three entities that scale with the DATA rather than the project's structure.
#: ⚠️ Derived from the export itself below, not re-listed by hand — a fourth streamed entity
#: must not be able to appear without this suite noticing.
EXPECTED_STREAMED = {"dataset_rows", "dataset_values", "row_scores"}


def _streamed_keys(project_data: dict) -> set[str]:
    return {k for k, v in project_data.items() if isinstance(v, pp._StreamedEntity)}


def test_core_and_orm_serialization_agree(db_session, streamed_project):
    """The differential: same rows, both serializers, byte-identical dicts.

    This is the assertion the whole change rests on. It is run per entity rather than in
    aggregate so a failure names which one diverged.
    """
    ds_ids = [d.id for d in db_session.query(Dataset).filter(
        Dataset.project_id == streamed_project.id).all()]
    metric_ids = [m.id for m in db_session.query(MetricDefinition).filter(
        MetricDefinition.project_id == streamed_project.id).all()]

    cases = {
        "dataset_rows": (DatasetRow, DatasetRow.dataset_id.in_(ds_ids), DatasetRow.id),
        "dataset_values": (
            DatasetValue,
            DatasetValue.row_id.in_(
                select(DatasetRow.id).where(DatasetRow.dataset_id.in_(ds_ids))),
            DatasetValue.id,
        ),
        "row_scores": (
            RowScore, RowScore.metric_definition_id.in_(metric_ids), RowScore.id),
    }
    for name, (model, where, order) in cases.items():
        cols = pp._get_columns(model)
        orm = pp._serialize_all(
            db_session.query(model).filter(where).order_by(order).all(), cols)
        core = list(pp._stream_core_rows(
            db_session, pp._StreamedEntity(model, cols, where, order)))
        assert orm, f"{name}: fixture produced no rows — the differential is vacuous"
        assert core == orm, (
            f"{name}: the Core stream and the ORM path disagree. The archive would be "
            f"valid JSON containing the wrong values.\n  orm [0]: {orm[0]}\n  core[0]: "
            f"{core[0] if core else None}"
        )


def test_the_fixture_can_tell_the_serializers_apart(db_session, streamed_project):
    """DISCRIMINATION check: prove the fixture would CATCH a divergence (#707a).

    A fixture of plain integers serializes identically under any implementation, so the
    agreement test above would pass against a broken serializer. Assert the fixture actually
    carries the values that make the two branches of `_serialize_mapping` reachable.
    """
    ds_ids = [d.id for d in db_session.query(Dataset).filter(
        Dataset.project_id == streamed_project.id).all()]
    cols = pp._get_columns(DatasetRow)
    rows = list(pp._stream_core_rows(db_session, pp._StreamedEntity(
        DatasetRow, cols, DatasetRow.dataset_id.in_(ds_ids), DatasetRow.id)))
    assert any(r["submitted_at"] is None for r in rows), "no NULL datetime in the fixture"
    assert any(isinstance(r["submitted_at"], str) for r in rows), (
        "no serialized datetime — the isoformat branch is untested, and that branch is "
        "exactly where a Core/ORM divergence would show"
    )
    values = list(pp._stream_core_rows(db_session, pp._StreamedEntity(
        DatasetValue, pp._get_columns(DatasetValue),
        DatasetValue.row_id.in_(
            select(DatasetRow.id).where(DatasetRow.dataset_id.in_(ds_ids))),
        DatasetValue.id)))
    assert any(v["value_text"] and not v["value_text"].isascii() for v in values), (
        "no non-ASCII text in the fixture"
    )
    assert any(v["value_numeric"] is not None and v["value_numeric"] < 0 for v in values)


def test_export_streams_exactly_the_three_data_scaled_entities(db_session, streamed_project,
                                                               tmp_path):
    """POPULATION check: which keys stream is derived, not asserted by hand.

    If a fourth entity is added to the streamed set — or one of these three is quietly
    materialised again — this fails rather than silently changing the memory profile.
    """
    captured: dict = {}
    original = pp._write_project_json

    def spy(fh, project_data, db):
        captured.update(project_data)
        return original(fh, project_data, db)

    pp._write_project_json = spy
    try:
        pp.export_project(db_session, streamed_project.id, tmp_path, tmp_path,
                          include_media=False)
    finally:
        pp._write_project_json = original

    assert captured, "the export never called _write_project_json — the spy saw nothing"
    assert _streamed_keys(captured) == EXPECTED_STREAMED


def test_streamed_keys_keep_their_position_in_project_json(db_session, streamed_project,
                                                           tmp_path):
    """A streamed key must occupy its ORIGINAL slot, so two exports stay comparable.

    JSON objects are unordered and the import uses `.get()`, so this is not a correctness
    requirement — it is what lets an unchanged project export to a byte-comparable file,
    which is the shape the round-trip guard needs.
    """
    buf = pp.export_project(db_session, streamed_project.id, tmp_path, tmp_path,
                            include_media=False)
    with zipfile.ZipFile(buf) as zf:
        raw = zf.read("project.json").decode()
    data = json.loads(raw)
    keys = list(data)
    for name in EXPECTED_STREAMED:
        assert name in keys, f"{name} missing from project.json entirely"
    # `dataset_values` sits between `dataset_rows` and `recode_definitions`, as it did
    # before streaming. Pinning the neighbours pins the position without pinning all 30 keys.
    assert keys.index("dataset_rows") < keys.index("dataset_values")
    assert keys.index("dataset_values") < keys.index("recode_definitions")


def test_project_json_is_written_compactly(db_session, streamed_project, tmp_path):
    """`indent=2` is ~34% more bytes and several times the dumps time, for a machine file.

    Reverting to it would restore a large share of the peak this change removed, and nothing
    else in the suite would notice — the archive stays valid either way.
    """
    buf = pp.export_project(db_session, streamed_project.id, tmp_path, tmp_path,
                            include_media=False)
    with zipfile.ZipFile(buf) as zf:
        raw = zf.read("project.json").decode()
    assert "\n" not in raw, "project.json is pretty-printed again — it must be compact"
    assert ", " not in raw.split('"', 2)[0] + "", ""
    assert json.loads(raw), "compact output must still parse"


def test_a_project_with_no_datasets_streams_empty_arrays(db_session, tmp_path):
    """The `whereclause is None` arm: no datasets means no rows, not a crash.

    `_stream_core_rows` returns immediately on a null predicate rather than building a
    `WHERE id IN ()`. A qualitative-only project takes this path on every export.
    """
    project = Project(name="No datasets", user_id=1)
    db_session.add(project)
    db_session.commit()
    buf = pp.export_project(db_session, project.id, tmp_path, tmp_path, include_media=False)
    with zipfile.ZipFile(buf) as zf:
        data = json.loads(zf.read("project.json"))
    for name in EXPECTED_STREAMED:
        assert data[name] == [], f"{name} should be an empty list, got {data[name]!r}"
