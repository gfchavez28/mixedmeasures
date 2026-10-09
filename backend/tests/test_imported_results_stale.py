"""#1039 (a) and (d): a saved test's result says what it is, and a project file cannot
forge the consensus layer.

**(a) — "metric stale ⇒ its tests stale" had ONE door that kept it.** `mark_metrics_stale`
cascades to the tests that read a metric; three doors did not: the `.mmproject` import
(which marks every imported metric stale and copied each test's `stale: false` from the
file), an edit to a metric's definition, and every recompute but the single-metric
button. So an imported α — computed by whichever build wrote the file, perhaps before
#767's Cronbach fix — arrived reading as current, and the analysis page's quick compute,
which refreshes the stale METRIC before answering, never touched the test.

**(d) — `normalize_coder_type` accepts the system kinds**, so a hand-edited file could
carry a coder of the `consensus` kind: minted on an install that has none (and then
adopted by `get_or_create_consensus_user` as THE layer), or name-matched onto the real
one with the file's codings written into it. No export writes one.
"""
from __future__ import annotations

import asyncio
import json
import uuid as uuid_module

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.segment import Segment
from app.models.statistical_test import StatisticalTest
from app.models.user import User
from app.services import project_portability as pp
from app.services.metrics import compute_metric
from tests.archive_support import archive_extras, archive_payload, write_archive


def _run(coro):
    return asyncio.run(coro)


def _project(db, *, metric_stale=False, tests_stale=False, commit=True) -> dict:
    """A scale with a column metric, a t-test on the metric and an α on the domain.

    ``commit=False`` for a test that calls the import ENDPOINT: it hands the Session to a
    worker thread, and the in-memory test engine gives that thread a fresh connection
    after a commit (the existing endpoint tests flush for the same reason)."""
    project = Project(name="Tested", user_id=1, project_uuid=str(uuid_module.uuid4()))
    db.add(project)
    db.flush()
    ds = Dataset(project_id=project.id, name="D")
    db.add(ds)
    db.flush()
    cols = []
    for i in range(2):
        col = DatasetColumn(
            dataset_id=ds.id, column_name=f"q{i}", column_text=f"Q{i}",
            column_type=ColumnType.NUMERIC, sequence_order=i, display_order=i,
        )
        db.add(col)
        cols.append(col)
    db.flush()
    for r in range(6):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{r}")
        db.add(row)
        db.flush()
        for i, col in enumerate(cols):
            v = float((r + i) % 5 + 1)
            db.add(DatasetValue(row_id=row.id, column_id=col.id,
                                value_text=str(int(v)), value_numeric=v))
    domain = AnalysisDomain(project_id=project.id, name="Scale", sequence_order=0)
    db.add(domain)
    db.flush()
    for i, col in enumerate(cols):
        db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                    member_id=col.id, sequence_order=i))
    metric = MetricDefinition(
        project_id=project.id, name="Q0 mean", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=cols[0].id,
        sequence_order=0, stale=metric_stale,
    )
    db.add(metric)
    db.flush()
    t_test = StatisticalTest(
        project_id=project.id, test_type="independent_t_test", config="{}",
        target_type="metric_definition", target_id=metric.id,
        result_data=json.dumps({"t": 1.0, "p": 0.3}), stale=tests_stale,
    )
    alpha = StatisticalTest(
        project_id=project.id, test_type="cronbachs_alpha", config="{}",
        target_type="analysis_domain", target_id=domain.id,
        result_data=json.dumps({"alpha": 0.71}), stale=tests_stale,
    )
    db.add_all([t_test, alpha])
    db.commit() if commit else db.flush()
    return {"project": project, "metric": metric, "t_test": t_test, "alpha": alpha,
            "domain": domain, "column": cols[0]}


def _export(db, project, tmp_path, name="out.mmproject"):
    out = tmp_path / name
    out.write_bytes(
        pp.export_project(db, project.id, tmp_path / "docs", include_media=False).getvalue()
    )
    return out


def _tests_of(db, pid):
    return db.query(StatisticalTest).filter(StatisticalTest.project_id == pid).all()


class TestAnImportedTestArrivesStale:
    def test_every_imported_test_is_marked_and_counted(self, db_session, tmp_path):
        made = _project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        report: dict = {}
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d1", user_id=1,
                                   import_report=report)
        db_session.flush()
        imported = _tests_of(db_session, pid)
        assert len(imported) == 2, "vacuous: the tests did not travel"
        # The α targets a variable group — no metric recompute could ever reach it.
        assert {t.test_type for t in imported if t.stale} == {
            "independent_t_test", "cronbachs_alpha",
        }
        assert report["tests_marked_stale"] == 2

    def test_a_test_that_ARRIVED_stale_is_not_counted_again(self, db_session, tmp_path):
        """The count is what the import CHANGED — the file's own stale flag was true."""
        made = _project(db_session, tests_stale=True)
        archive = _export(db_session, made["project"], tmp_path)
        report: dict = {}
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d2", user_id=1,
                                   import_report=report)
        db_session.flush()
        assert all(t.stale for t in _tests_of(db_session, pid))
        assert report["tests_marked_stale"] == 0

    def test_the_source_projects_own_tests_are_untouched(self, db_session, tmp_path):
        made = _project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        pp.import_project(db_session, archive, tmp_path / "d3", user_id=1)
        db_session.flush()
        assert [t.stale for t in _tests_of(db_session, made["project"].id)] == [False, False]

    def test_a_merge_imports_none_and_marks_none(self, db_session, tmp_path):
        made = _project(db_session)
        target = made["project"]
        archive = _export(db_session, target, tmp_path)
        report: dict = {}
        pp.import_project(
            db_session, archive, tmp_path / "d4", user_id=1, import_mode="merge",
            target_project_id=target.id, report={}, import_report=report,
        )
        db_session.flush()
        assert report["tests_marked_stale"] == 0
        assert [t.stale for t in _tests_of(db_session, target.id)] == [False, False]

    def test_the_ENDPOINT_carries_the_count(self, db_session, tmp_path, monkeypatch):
        """The wire: a key the service fills and the schema drops reaches no toast
        (#1123's lesson) — and `extra='forbid'` makes a dropped key raise here.

        ⚠️ The endpoint hands the Session to a worker thread, and the test engine's
        connection belongs to the thread that opened it, so the worker is run INLINE
        here. What is under test is the response, not the threading (#847 has its own)."""
        from fastapi import UploadFile
        from app.routers import project_portability as router_module
        from app.routers.project_portability import import_project_endpoint

        async def _inline(fn, *args, **kwargs):
            return fn(*args, **kwargs)

        monkeypatch.setattr(router_module, "run_in_threadpool", _inline)
        made = _project(db_session, commit=False)
        archive = _export(db_session, made["project"], tmp_path)
        # Every Form default passed by hand: a direct call would otherwise receive
        # the `Form(...)` sentinel objects (`backend/tests/the internal design notes).
        with open(archive, "rb") as fh:
            result = _run(import_project_endpoint(
                file=UploadFile(filename="t.mmproject", file=fh),
                import_mode="new", target_project_id=None, coder_mapping=None,
                code_mapping=None, user=db_session.get(User, 1), db=db_session,
            ))
        assert result.tests_marked_stale == 2


class TestRecomputingAStaleMetricTakesItsTests:
    """The rule at the RECOMPUTE: every door that recomputes a stale metric reaches
    `compute_metric`, so a test computed against the old numbers is marked there."""

    def test_a_STALE_metric_recomputed_marks_its_tests(self, db_session):
        made = _project(db_session, metric_stale=True)
        compute_metric(db_session, made["metric"])
        db_session.flush()
        db_session.refresh(made["t_test"])
        db_session.refresh(made["alpha"])
        assert made["t_test"].stale is True
        # Only the tests that READ this metric: the α targets the variable group.
        assert made["alpha"].stale is False

    def test_a_CURRENT_metric_recomputed_marks_nothing(self, db_session):
        """The discrimination half: no number moved, so a marker here would be the
        one that teaches a researcher to ignore it."""
        made = _project(db_session, metric_stale=False)
        compute_metric(db_session, made["metric"])
        db_session.flush()
        db_session.refresh(made["t_test"])
        assert made["t_test"].stale is False

    def test_the_analysis_pages_QUICK_COMPUTE_reaches_it(self, db_session):
        """The door the issue named: it recomputes a stale metric before answering,
        so nothing downstream could see the flag."""
        from app.routers.metrics import quick_compute
        from app.schemas.metric import QuickComputeRequest, QuickComputeSource

        made = _project(db_session)
        request = QuickComputeRequest(
            sources=[QuickComputeSource(source_type="dataset_column",
                                        source_id=made["column"].id)],
            metric_type="mean",
        )
        first = _run(quick_compute(project_id=made["project"].id, data=request,
                                   user=db_session.get(User, 1), db=db_session))
        metric = db_session.get(MetricDefinition, first.metrics[0].id)
        test = StatisticalTest(
            project_id=made["project"].id, test_type="independent_t_test", config="{}",
            target_type="metric_definition", target_id=metric.id,
            result_data="{}", stale=False,
        )
        db_session.add(test)
        metric.stale = True
        db_session.commit()

        second = _run(quick_compute(project_id=made["project"].id, data=request,
                                    user=db_session.get(User, 1), db=db_session))
        assert second.computed_count == 1
        db_session.refresh(test)
        assert test.stale is True


class TestEditingAMetricTakesItsTests:
    def _update(self, db, made, **fields):
        from app.routers.metrics import update_metric
        from app.schemas.metric import MetricDefinitionUpdate

        return _run(update_metric(
            project_id=made["project"].id, metric_id=made["metric"].id,
            data=MetricDefinitionUpdate(**fields), user=db.get(User, 1), db=db,
        ))

    def test_a_definition_edit_marks_the_metric_AND_its_tests(self, db_session):
        made = _project(db_session)
        self._update(db_session, made, exclude_values=["5"])
        db_session.refresh(made["t_test"])
        db_session.refresh(made["metric"])
        assert made["metric"].stale is True
        assert made["t_test"].stale is True

    def test_a_RENAME_marks_neither(self, db_session):
        """The control: only the fields that change a computation stale anything."""
        made = _project(db_session)
        self._update(db_session, made, name="Renamed")
        db_session.refresh(made["t_test"])
        assert made["t_test"].stale is False


# ── (d) A file cannot forge the consensus layer ──────────────────────────────


def _coded_project(db):
    project = Project(name="Coded", user_id=1, project_uuid=str(uuid_module.uuid4()))
    db.add(project)
    db.flush()
    conv = Conversation(project_id=project.id, name="Interview")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="a turn")
    code = Code(project_id=project.id, numeric_id=1, name="Theme")
    coder = User(username="Dana", password_hash=None, coder_type="human")
    db.add_all([seg, code, coder])
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=coder.id))
    db.commit()
    return project


def _doctored(db, tmp_path, coder_type: str):
    project = _coded_project(db)
    source = _export(db, project, tmp_path, name="clean.mmproject")
    import zipfile
    with zipfile.ZipFile(source) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        payload = archive_payload(zf)
        extras = archive_extras(zf)
    assert [c["username"] for c in payload["coders"]] == ["Dana"], "vacuous fixture"
    payload["coders"][0]["coder_type"] = coder_type
    return write_archive(tmp_path / f"{coder_type}.mmproject", manifest, payload, extras)


class TestAConsensusCoderInAFileIsRefused:
    def test_a_CONSENSUS_coder_refuses_the_import_and_says_why(self, db_session, tmp_path):
        archive = _doctored(db_session, tmp_path, "consensus")
        before = db_session.query(User).count()
        with pytest.raises(ValueError, match="as the consensus layer.*edited by hand"):
            pp.import_project(db_session, archive, tmp_path / "e1", user_id=1)
        db_session.rollback()
        assert db_session.query(User).count() == before
        assert db_session.query(User).filter(User.coder_type == "consensus").count() == 0

    def test_an_UNATTRIBUTED_coder_still_imports(self, db_session, tmp_path):
        """The control: the export carries `unattributed` legitimately, so the refusal
        is consensus ONLY."""
        archive = _doctored(db_session, tmp_path, "unattributed")
        pid, _ = pp.import_project(db_session, archive, tmp_path / "e2", user_id=1)
        assert pid

    def test_a_clean_export_never_carries_one(self, db_session, tmp_path):
        """The premise the refusal rests on, held by the exporter's own filter."""
        from app.auth import get_or_create_consensus_user

        project = _coded_project(db_session)
        consensus = get_or_create_consensus_user(db_session)
        seg = db_session.query(Segment).join(Conversation).filter(
            Conversation.project_id == project.id).one()
        code = db_session.query(Code).filter(Code.project_id == project.id).one()
        db_session.add(CodeApplication(segment_id=seg.id, code_id=code.id,
                                       user_id=consensus.id, origin="consensus"))
        db_session.commit()
        payload = archive_payload(_export(db_session, project, tmp_path))
        assert all(c.get("coder_type") != "consensus" for c in payload["coders"])
