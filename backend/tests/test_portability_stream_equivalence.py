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
`_core_row_serializer` reads a Core result row. They agree only because SQLAlchemy applies
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
from app.models.segment import Segment
from app.models.conversation import Conversation
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.services import project_portability as pp
# The v7 layout is described in ONE place for tests — see `tests/archive_support.py`.
from tests.archive_support import archive_payload


@pytest.fixture
def streamed_project(db_session, tmp_path):
    """A project whose streamed entities exercise every `_serialize_*` branch.

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

    # #958 — segments and code applications joined the streamed set, so the fixture has
    # to produce them or the differential above is vacuous (its own assertion says so).
    # ⚠️ Same rule as the rows above: the TYPE coverage is the point. A segment carries
    # long TEXT and a nullable speaker; an application carries a nullable Float
    # (`magnitude`), a nullable user, and `origin` — which must include a CONSENSUS row,
    # because the export's predicate excludes it and a fixture without one cannot tell a
    # working exclusion from a missing one.
    conv = Conversation(project_id=project.id, name="C")
    db_session.add(conv)
    db_session.flush()

    seg_texts = ["plain", "Ünïcøde ✓ — an em dash and a tick", "", "99", "-4"]
    segs = []
    for i, t in enumerate(seg_texts):
        seg = Segment(conversation_id=conv.id, sequence_order=i, text=t)
        db_session.add(seg)
        segs.append(seg)
    db_session.flush()

    code = Code(project_id=project.id, name="Cde", numeric_id=1,
                is_active=True, is_universal=False)
    db_session.add(code)
    db_session.flush()
    for i, seg in enumerate(segs):
        db_session.add(CodeApplication(
            code_id=code.id, segment_id=seg.id,
            user_id=None if i == 1 else 1,
            magnitude=None if i in (0, 2) else float(i) - 1.5,
            origin="consensus" if i == 4 else "human",
        ))
    db_session.commit()
    return project


#: The three entities that scale with the DATA rather than the project's structure.
#: ⚠️ Derived from the export itself below, not re-listed by hand — a fourth streamed entity
#: must not be able to appear without this suite noticing.
# ⚠️ A COUNT IN A NAME IS A CLAIM, so this set is the only place the population is
# written down and the test below is named for the PROPERTY, not the number — it read
# "…the_three_data_scaled_entities" until #958 made it five.
EXPECTED_STREAMED = {
    "dataset_rows", "dataset_values", "row_scores",   # #842/#847
    "segments", "code_applications",                  # #958
}


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
        # #958 — both carry `created_at`, so they exercise the datetime branch of
        # `_core_row_serializer` that `row_scores` already covers; `segments` adds the
        # long-TEXT case and `code_applications` the nullable-Float one (`magnitude`).
        "segments": (
            Segment,
            Segment.conversation_id.in_(
                select(Conversation.id).where(
                    Conversation.project_id == streamed_project.id)),
            Segment.id,
        ),
        "code_applications": (
            CodeApplication,
            CodeApplication.segment_id.in_(
                select(Segment.id).join(
                    Conversation, Segment.conversation_id == Conversation.id
                ).where(Conversation.project_id == streamed_project.id)),
            CodeApplication.id,
        ),
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
    carries the values that make the two branches of `_core_row_serializer` reachable.
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


def test_export_streams_exactly_the_data_scaled_entities(db_session, streamed_project,
                                                         tmp_path):
    """POPULATION check: which keys stream is derived, not asserted by hand.

    If another entity joins the streamed set — or one of these is quietly materialised
    again — this fails rather than silently changing the memory profile.
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


def test_a_streamed_key_is_ABSENT_from_project_json_and_present_as_an_entry(
    db_session, streamed_project, tmp_path
):
    """v7: the rows are in `{key}.jsonl`, and `project.json` does not mention the key.

    🔴 **ABSENT, not `[]`.** Writing an empty array here as well would give a reader two
    answers to one question, and whichever it read first would silently be the wrong one.
    The key's absence from this document is what makes the entry the only source — which
    is also why a v6 build must be REFUSED rather than allowed to read `[]`.

    This replaces the pre-v7 pin that asserted the streamed keys kept their ORIGINAL SLOT
    in `project.json`. That test existed so two exports of an unchanged project stayed
    byte-comparable; the property survives, and now lives in the entries, which are written
    in `JSONL_ENTITY_KEYS` order rather than dict order.
    """
    buf = pp.export_project(db_session, streamed_project.id, tmp_path, tmp_path,
                            include_media=False)
    with zipfile.ZipFile(buf) as zf:
        data = json.loads(zf.read("project.json"))
        names = zf.namelist()
        for name in EXPECTED_STREAMED:
            assert name not in data, (
                f"{name} is still inline in project.json — the whole-document parse this "
                "change removes is back"
            )
            entry = f"{name}.jsonl"
            assert entry in names, f"{entry} missing from the archive"
        # Every line is one complete row — that is what makes the import streamable.
        rows = [
            json.loads(line)
            for line in zf.read("dataset_values.jsonl").splitlines() if line.strip()
        ]
    assert rows and all("_original_id" in r for r in rows)
    assert rows == sorted(rows, key=lambda r: r["_original_id"]), (
        "the entry must stay id-ordered, or two exports of an unchanged project differ"
    )


def test_an_entity_with_no_rows_still_gets_its_empty_entry(db_session, tmp_path):
    """"We had nothing to write" must not look like "this member was lost".

    The reader REFUSES a v7 archive missing an entry, so an empty entity has to be an
    empty member rather than an absent one. #958's step 6 drops `row_scores` from the
    export; when it lands, this is the assertion that keeps it from becoming a silent
    refusal for everyone.

    Deliberately a BARE project rather than the shared fixture, which populates all five.
    """
    empty = Project(name="Empty", user_id=1)
    db_session.add(empty)
    db_session.commit()

    buf = pp.export_project(db_session, empty.id, tmp_path, tmp_path, include_media=False)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        for key in pp.JSONL_ENTITY_KEYS:
            entry = f"{key}.jsonl"
            assert entry in names, f"{entry} is absent, which a v7 reader refuses"
            assert zf.read(entry) == b""


def test_the_export_refuses_a_streamed_entity_nobody_registered(db_session,
                                                                streamed_project,
                                                                tmp_path, monkeypatch):
    """The writer and the reader share ONE declared set, and the export fails closed.

    A sixth streamed entity that nobody added to `JSONL_ENTITY_KEYS` would be written to
    an entry the importer never opens — silent loss of exactly the entity somebody had
    just decided was big enough to stream. Planting one must raise at export time.
    """
    monkeypatch.setattr(pp, "JSONL_ENTITY_KEYS", pp.JSONL_ENTITY_KEYS + ("nonesuch",))
    with pytest.raises(RuntimeError, match="JSONL_ENTITY_KEYS"):
        pp.export_project(db_session, streamed_project.id, tmp_path, tmp_path,
                          include_media=False)


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


def test_a_project_with_no_datasets_streams_empty_entries(db_session, tmp_path):
    """The `whereclause is None` arm: no datasets means no rows, not a crash.

    `_stream_core_rows` returns immediately on a null predicate rather than building a
    `WHERE id IN ()`. A qualitative-only project takes this path on every export.
    """
    project = Project(name="No datasets", user_id=1)
    db_session.add(project)
    db_session.commit()
    buf = pp.export_project(db_session, project.id, tmp_path, tmp_path, include_media=False)
    data = archive_payload(buf)
    for name in EXPECTED_STREAMED:
        assert data[name] == [], f"{name} should be empty, got {data[name]!r}"


class TestTheStreamedApplicationPredicate:
    """#958 — the code-application gather became ONE `or_` of two subqueries plus the
    consensus exclusion, replacing two concatenated queries. Three properties were
    carried by the old shape's STRUCTURE and are now carried by one expression, so each
    is asserted rather than assumed.

    ⚠️ These run against the EXPORT, not the predicate, because the predicate is a local
    in `export_project` — the wire is where a mistake would actually reach a researcher.
    """

    def _exported(self, db, project, tmp_path):
        return archive_payload(pp.export_project(db, project.id, tmp_path, tmp_path))

    def test_the_consensus_layer_is_still_excluded(self, db_session, streamed_project,
                                                   tmp_path):
        """The fixture plants one `origin='consensus'` row. It is a DERIVED layer —
        re-materialised on import — so exporting it would duplicate every consensus
        decision on the way back in."""
        data = self._exported(db_session, streamed_project, tmp_path)
        origins = {a["origin"] for a in data["code_applications"]}
        assert origins == {"human"}, (
            "a consensus application reached the archive; the `or_` lost its "
            "`origin != consensus` conjunct"
        )
        assert len(data["code_applications"]) == 4, "the four human rows must survive"

    def test_both_target_arms_are_present(self, db_session, streamed_project, tmp_path):
        """`ck_code_application_exactly_one_target` makes the two arms a partition, so a
        single `order_by(id)` must still emit BOTH kinds. A fixture with only segment
        applications cannot tell a working union from a dropped arm — so this seeds a
        dataset-value coding too, and asserts on the pair."""
        from app.models.code import Code
        from app.models.code_application import CodeApplication
        from app.models.dataset import DatasetValue

        code = db_session.query(Code).filter(
            Code.project_id == streamed_project.id).first()
        value = db_session.query(DatasetValue).join(
            DatasetRow, DatasetValue.row_id == DatasetRow.id
        ).join(Dataset, DatasetRow.dataset_id == Dataset.id).filter(
            Dataset.project_id == streamed_project.id).first()
        db_session.add(CodeApplication(
            code_id=code.id, dataset_value_id=value.id, user_id=1, origin="human"))
        db_session.commit()

        data = self._exported(db_session, streamed_project, tmp_path)
        apps = data["code_applications"]
        assert any(a["segment_id"] is not None for a in apps), "segment arm lost"
        assert any(a["dataset_value_id"] is not None for a in apps), "dataset arm lost"
        assert len(apps) == 5

    def test_the_coder_roster_is_derived_from_the_same_predicate(
            self, db_session, streamed_project, tmp_path):
        """`coder_ids` used to walk the materialised list; it is a DISTINCT query now.
        The roster must match the applications that actually shipped — including the
        consensus exclusion, or a merge would offer a coder who owns nothing."""
        data = self._exported(db_session, streamed_project, tmp_path)
        exported = {a["user_id"] for a in data["code_applications"]
                    if a["user_id"] is not None}
        roster = {c["_original_id"] for c in data["coders"]}
        assert exported, "vacuous: no attributed application in the fixture"
        assert exported <= roster, (
            f"applications reference coders the roster omits: {exported - roster}"
        )
