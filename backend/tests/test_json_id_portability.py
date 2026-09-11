"""#922 / #948 — entity ids buried in a JSON column, across `.mmproject`.

`_build_entity` copies any column the import does not explicitly override, and the
relational pass remaps FK COLUMNS. Neither can see an id inside a JSON text
column, so such an id arrives naming a row of the SOURCE project. #387 named the
class in April 2026 for the canvas; these are the third and fourth carriers to
acquire a remap, and the two the 2026-09-09/10 audits found with none.

🔴 **Both tests enter at `import_project`, not at the helper.** A post-pass that
is correct and unwired is the #747/#714/#757 shape — `renumber_imported_notes` was
called ~50 lines before the rows it renumbers were inserted, and 14 of 16 guards
stayed green under the mutant because each called the service directly.

🔴 **The fixture is non-degenerate on the axis that matters: the imported project's
ids DIFFER from the source's.** Import-as-new inserts fresh rows, so the new code
and the new columns get higher autoincrement ids — and a test whose old and new
ids coincided would pass with no remap at all. `test_the_fixture_ids_really_move`
asserts that rather than trusting it.
"""

import json
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetValue
from app.models.metric import MetricDefinition
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.services.magnitude_rollup import MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
from app.services.participant_dataset import (
    MANAGED_COLUMN_SOURCE,
    MANAGED_KIND_PARTICIPANTS,
    create_participant_dataset,
)
from app.services.participant_scores import (
    MANAGED_SPEC_KIND_RATED_TARGETS,
    MANAGED_SPEC_KIND_SCORE,
    parse_managed_spec,
    refresh_participant_dataset,
)
from app.services.project_portability import export_project, import_project

DECOMPOSE_LABEL = "Wave 1 items"


@pytest.fixture
def source(db_session):
    """A project carrying BOTH JSON-id artifacts: a participant table with score
    columns (`managed_spec.code_id`) and a decomposed-domain metric
    (`config.decompose_column_ids`).

    One fixture for both because they ride the same file and the same import, and
    a second copy of this scaffolding would drift from it.
    """
    db = db_session
    db.add(Project(id=1, name="PD audit", user_id=1))
    db.flush()

    person = Participant(project_id=1, identifier="E-01")
    db.add(person)
    db.flush()

    conv = Conversation(project_id=1, name="Interviews")
    db.add(conv)
    db.flush()
    speaker = Speaker(project_id=1, name="E-01", participant_id=person.id)
    db.add(speaker)
    db.flush()

    code = Code(project_id=1, numeric_id=10, name="Supervisor support",
                magnitude_min=-2.0, magnitude_max=2.0, magnitude_step=1.0)
    db.add(code)
    db.flush()

    seg = Segment(conversation_id=conv.id, speaker_id=speaker.id,
                  sequence_order=1, text="turn 1")
    db.add(seg)
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1,
                           magnitude=2.0))
    db.flush()

    table = create_participant_dataset(db, 1)
    refresh_participant_dataset(db, 1)

    # An ordinary dataset, a domain over two of its columns, and a metric that
    # names those columns INSIDE its config (what `routers/metrics.py` writes when
    # a domain metric is created with `decompose=True`).
    survey = Dataset(project_id=1, name="Wave 1")
    db.add(survey)
    db.flush()
    cols = []
    for i, text in enumerate(("Item A", "Item B")):
        col = DatasetColumn(dataset_id=survey.id, column_text=text,
                            column_type=ColumnType.ORDINAL,
                            sequence_order=i, display_order=i, source="imported")
        db.add(col)
        db.flush()
        cols.append(col)

    domain = AnalysisDomain(project_id=1, name="Psychological safety")
    db.add(domain)
    db.flush()
    for i, col in enumerate(cols):
        db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                    member_id=col.id, sequence_order=i))
    db.flush()

    db.add(MetricDefinition(
        project_id=1, name="Safety (decomposed)", metric_type="domain_aggregate",
        input_source_type="dataset_domain", input_source_id=domain.id,
        config=json.dumps({
            "child_metric_type": "mean",
            "child_config": {},
            "aggregation": "mean",
            "decompose_column_ids": sorted(c.id for c in cols),
            "decompose_label": DECOMPOSE_LABEL,
        }),
    ))
    db.flush()
    db.commit()

    return {"db": db, "code": code, "table": table, "columns": cols}


def _export(db, tmp_path: Path) -> Path:
    out = tmp_path / "export.mmproject"
    docs = tmp_path / "docs"
    docs.mkdir(exist_ok=True)
    out.write_bytes(export_project(db, 1, docs).getvalue())
    return out


def _rewrite(src: Path, dest: Path, mutate) -> Path:
    """Re-zip an export with `project.json` edited by `mutate(data)`."""
    zin = zipfile.ZipFile(src)
    data = json.loads(zin.read("project.json"))
    mutate(data)
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        for name in zin.namelist():
            zout.writestr(
                name, json.dumps(data) if name == "project.json" else zin.read(name),
            )
    dest.write_bytes(buf.getvalue())
    return dest


def _import_as_new(db, path: Path, tmp_path: Path) -> int:
    new_pid, _name = import_project(
        db, path, tmp_path / "imported_docs", media_dir=None, user_id=1,
        import_mode="new",
    )
    db.flush()
    return new_pid


def _managed(db, project_id: int) -> list[DatasetColumn]:
    table = (
        db.query(Dataset)
        .filter(Dataset.project_id == project_id,
                Dataset.managed_kind == MANAGED_KIND_PARTICIPANTS)
        .one()
    )
    return (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == table.id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )


class TestScoreColumnProvenanceSurvivesImport:
    """#922 — `DatasetColumn.managed_spec` holds the id of the code it scores."""

    def test_the_fixture_ids_really_move(self, source, tmp_path):
        """DISCRIMINATION guard. Every assertion below is vacuous if the imported
        project happens to reuse the source's ids."""
        db = source["db"]
        new_pid = _import_as_new(db, _export(db, tmp_path), tmp_path)

        new_code = db.query(Code).filter(Code.project_id == new_pid).one()
        assert new_code.id != source["code"].id
        old_cols = {c.id for c in source["columns"]}
        new_cols = {
            c.id for c in db.query(DatasetColumn)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == new_pid, Dataset.name == "Wave 1")
        }
        assert new_cols and not (new_cols & old_cols)

    def test_the_spec_names_a_code_of_the_IMPORTED_project(self, source, tmp_path):
        db = source["db"]
        new_pid = _import_as_new(db, _export(db, tmp_path), tmp_path)

        new_code = db.query(Code).filter(Code.project_id == new_pid).one()
        specs = [
            parse_managed_spec(c.managed_spec)
            for c in _managed(db, new_pid)
            if c.managed_spec
        ]
        assert len(specs) == 2, "the score column and its n"
        assert {s["code_id"] for s in specs} == {new_code.id}
        assert {s["kind"] for s in specs} == {
            MANAGED_SPEC_KIND_SCORE, MANAGED_SPEC_KIND_RATED_TARGETS,
        }

    def test_the_stated_basis_survives_the_remap(self, source, tmp_path):
        """The spec is rebuilt through `build_managed_spec`, so the eleventh
        stated-basis member must come out the other side — a remap that dropped it
        would make the score column stop saying what it is."""
        db = source["db"]
        new_pid = _import_as_new(db, _export(db, tmp_path), tmp_path)

        by_kind = {
            parse_managed_spec(c.managed_spec)["kind"]: parse_managed_spec(c.managed_spec)
            for c in _managed(db, new_pid) if c.managed_spec
        }
        assert by_kind[MANAGED_SPEC_KIND_SCORE]["basis"] == (
            MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
        )
        # The *n* column carries no basis on purpose: a count has no basis to
        # state, and inventing one for symmetry would make the vocabulary
        # describe two different kinds of claim.
        assert "basis" not in by_kind[MANAGED_SPEC_KIND_RATED_TARGETS]

    def test_the_first_refresh_keeps_the_imported_columns(self, source, tmp_path):
        """The user-visible consequence, and the sharpest assertion in this file.

        With a stale `code_id` the imported columns name no live code, so the very
        first refresh REAPS all of them and builds replacements — `columns_removed
        == 2, columns_added == 2` — which since #923 also deletes any metric built
        on them. With the remap the refresh is a no-op on the column set.
        """
        db = source["db"]
        new_pid = _import_as_new(db, _export(db, tmp_path), tmp_path)

        report = refresh_participant_dataset(db, new_pid)

        assert (report.columns_removed, report.columns_added) == (0, 0)
        assert report.metrics_removed == 0

    def test_a_score_column_whose_code_is_ABSENT_is_not_imported(self, source, tmp_path):
        """The degradation path, and why it is a SKIP rather than a dropped key.

        `sync_score_columns` ignores any column whose spec does not parse, and
        `source="managed"` makes it read-only through five `routers/recode.py`
        doors and `delete_manual_column`'s refusal — so importing it spec-less
        would strand a column the researcher can neither fix nor delete.
        """
        db = source["db"]
        src = _export(db, tmp_path)

        def drop_the_code(data):
            gone = {c["_original_id"] for c in data["codes"]}
            data["codes"] = []
            data["code_applications"] = [
                a for a in data["code_applications"]
                if a.get("code_id") not in gone
            ]

        edited = _rewrite(src, tmp_path / "codeless.mmproject", drop_the_code)
        new_pid = _import_as_new(db, edited, tmp_path)

        columns = _managed(db, new_pid)
        assert [c.column_type for c in columns] == [ColumnType.IDENTIFIER], (
            "only the identifier column should survive"
        )
        # The identifier column is MANAGED and deliberately has no spec: the skip
        # must key on an UNRESOLVABLE spec, never on `source == "managed"`.
        assert columns[0].source == MANAGED_COLUMN_SOURCE
        assert columns[0].managed_spec is None

        # Its cells went with it (`skipped_column_ids` is read by the value loops).
        orphan_cells = (
            db.query(DatasetValue)
            .filter(~DatasetValue.column_id.in_([c.id for c in columns]))
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == new_pid,
                    Dataset.managed_kind == MANAGED_KIND_PARTICIPANTS)
            .count()
        )
        assert orphan_cells == 0

    def test_a_spec_that_does_not_PARSE_is_kept_verbatim(self, source, tmp_path):
        """Unreadable metadata is not a licence to delete the researcher's column.
        It was already inert in the source; the import must not make a decision the
        source never made."""
        db = source["db"]
        src = _export(db, tmp_path)

        def corrupt_one_spec(data):
            for c in data["dataset_columns"]:
                if c.get("managed_spec"):
                    c["managed_spec"] = "{not json"
                    break

        edited = _rewrite(src, tmp_path / "corrupt.mmproject", corrupt_one_spec)
        new_pid = _import_as_new(db, edited, tmp_path)

        raw = [c.managed_spec for c in _managed(db, new_pid) if c.managed_spec]
        assert "{not json" in raw


class TestDecomposedMetricColumnIds:
    """#948 — `MetricDefinition.config.decompose_column_ids`."""

    def test_the_ids_name_columns_of_the_IMPORTED_project(self, source, tmp_path):
        db = source["db"]
        new_pid = _import_as_new(db, _export(db, tmp_path), tmp_path)

        metric = (
            db.query(MetricDefinition)
            .filter(MetricDefinition.project_id == new_pid)
            .one()
        )
        config = json.loads(metric.config)
        new_cols = sorted(
            c.id for c in db.query(DatasetColumn)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == new_pid, Dataset.name == "Wave 1")
        )
        assert config["decompose_column_ids"] == new_cols
        assert config["decompose_column_ids"] != sorted(
            c.id for c in source["columns"]
        )

    def test_the_rest_of_the_config_is_untouched(self, source, tmp_path):
        """A remap that rewrote the blob rather than the one key would be a silent
        way to lose `decompose_label`, which is what the chart is titled with."""
        db = source["db"]
        new_pid = _import_as_new(db, _export(db, tmp_path), tmp_path)

        config = json.loads(
            db.query(MetricDefinition)
            .filter(MetricDefinition.project_id == new_pid).one().config
        )
        assert config["decompose_label"] == DECOMPOSE_LABEL
        assert config["child_metric_type"] == "mean"
        assert config["aggregation"] == "mean"


class TestTheSkipIsNarrowedToTheToolsOwnColumns:
    """POSITIVE CONTROL for the destructive branch.

    Everything the skip rests on is an argument about a `source="managed"`
    column: derived cells, rebuilt by the next refresh, read-only until then. An
    ORDINARY column carrying a stray spec holds the researcher's OWN data, and a
    predicate wide enough to take it would destroy real data to prevent a
    hypothetical loss — the `!= "manual"` shape #926 records one seam over.
    """

    def test_an_ordinary_column_with_a_stray_spec_keeps_its_cells(
        self, source, tmp_path,
    ):
        db = source["db"]
        src = _export(db, tmp_path)

        def plant(data):
            # A hand-edited database is the only way to reach this state, and it
            # is reachable.
            for c in data["dataset_columns"]:
                if c.get("column_text") == "Item A":
                    c["managed_spec"] = json.dumps(
                        {"kind": MANAGED_SPEC_KIND_SCORE, "code_id": 99_999},
                    )
            data["codes"] = []
            data["code_applications"] = []

        edited = _rewrite(src, tmp_path / "stray.mmproject", plant)
        new_pid = _import_as_new(db, edited, tmp_path)

        survivor = (
            db.query(DatasetColumn)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == new_pid,
                    DatasetColumn.column_text == "Item A")
            .one()
        )
        assert survivor.source == "imported"
        # The dead spec goes; the column does not.
        assert survivor.managed_spec is None
