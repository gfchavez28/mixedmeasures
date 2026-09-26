"""A project says how close it is to the limit that governs SHARING it (#974).

`assert_project_exportable` had exactly ONE caller, inside `export_project`, so
the only signal a researcher ever got was the refusal — at the moment they tried
to export, duplicate, or accept a colleague's merge. Measured 2026-09-20, the
developer's own GSS project sat at 3,633,552 of 4,000,000 (90.8%), four computed
variables from losing all three, with nothing on any screen saying so.

What these guard:

- **The disclosure and the refusal count the SAME thing**
  (`TestTheDisclosureAgreesWithTheGate`). A warning that predicts a refusal must
  be computed the way the refusal is, or the researcher is warned at one number
  and stopped at another. This is the assertion that would catch the two drifting
  apart after either is touched.
- The endpoint is owned and scoped (`TestTheEndpoint`).
- The count is the GATE's quantity, deliberately excluding `row_scores`
  (`test_row_scores_are_not_counted_because_the_gate_does_not_count_them`).
"""

import asyncio

import pytest

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
from app.models.user import User
from app.services import project_portability as pp


def _run(coro):
    """asyncio.run, never get_event_loop().run_until_complete — a loop another
    module's asyncio.run has closed makes that fail BY SUITE ORDER."""
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=1, name="Wave study", user_id=1))
    db.flush()
    return db


def _user(db):
    return db.query(User).filter(User.id == 1).one()


def _dataset_with_values(db, *, n_rows: int, n_cols: int) -> Dataset:
    ds = Dataset(project_id=1, name="Responses")
    db.add(ds)
    db.flush()
    cols = []
    for i in range(n_cols):
        c = DatasetColumn(
            dataset_id=ds.id, column_text=f"Q{i + 1}", column_type=ColumnType.NOMINAL,
            sequence_order=i, source="imported",
        )
        db.add(c)
        cols.append(c)
    db.flush()
    for r in range(n_rows):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{r + 1:04d}")
        db.add(row)
        db.flush()
        for c in cols:
            db.add(DatasetValue(row_id=row.id, column_id=c.id, value_text="x"))
    db.flush()
    db.commit()
    return ds


class TestTheDisclosureAgreesWithTheGate:
    """🔴 The load-bearing one. Two ways of counting "how big is this project for
    sharing" is how a researcher gets warned at one number and refused at
    another — so there is one function and both paths call it."""

    def test_the_counter_is_what_the_refusal_uses(self, project):
        db = project
        _dataset_with_values(db, n_rows=5, n_cols=3)
        assert pp.project_export_value_count(db, 1) == 15

    def test_the_gate_refuses_at_exactly_the_number_the_disclosure_reports(
        self, project, monkeypatch,
    ):
        """Drive both sides against one corpus at the boundary, rather than
        asserting each against its own expectation."""
        db = project
        _dataset_with_values(db, n_rows=5, n_cols=3)  # 15 values
        reported = pp.project_export_value_count(db, 1)

        monkeypatch.setattr(pp, "MAX_PROJECT_EXPORT_VALUES", reported)
        pp.assert_project_exportable(db, 1)  # at the limit: allowed

        monkeypatch.setattr(pp, "MAX_PROJECT_EXPORT_VALUES", reported - 1)
        with pytest.raises(pp.ProjectTooLargeError):
            pp.assert_project_exportable(db, 1)

    def test_row_scores_are_not_counted_because_the_gate_does_not_count_them(
        self, project,
    ):
        """⚠️ NOT an oversight being pinned as correct — the gate's own blind spot
        being MIRRORED on purpose. `row_scores` rides the archive (455,102 on the
        developer's install, 12.5% on top of GSS) and the gate ignores it, so a
        disclosure that counted them would predict a refusal that never comes.
        Whether the GATE should count them is #974's other half; if that changes,
        this test should fail and be updated with it."""
        db = project
        ds = _dataset_with_values(db, n_rows=2, n_cols=2)  # 4 values
        metric = MetricDefinition(
            project_id=1, name="Scale", metric_type="mean", config="{}",
            input_source_type="dataset_column",
            input_source_id=db.query(DatasetColumn.id).filter(
                DatasetColumn.dataset_id == ds.id).first()[0],
        )
        db.add(metric)
        db.flush()
        for row in db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id):
            db.add(RowScore(
                metric_definition_id=metric.id, dataset_row_id=row.id, score=1.0,
            ))
        db.flush()

        assert db.query(RowScore).count() == 2, "precondition: row scores exist"
        assert pp.project_export_value_count(db, 1) == 4

    def test_another_projects_values_are_not_counted(self, project):
        db = project
        _dataset_with_values(db, n_rows=3, n_cols=2)  # 6 in project 1
        db.add(Project(id=2, name="Other", user_id=1))
        db.flush()
        other = Dataset(project_id=2, name="Theirs")
        db.add(other)
        db.flush()
        col = DatasetColumn(
            dataset_id=other.id, column_text="Q", column_type=ColumnType.NOMINAL,
            sequence_order=0, source="imported",
        )
        db.add(col)
        row = DatasetRow(dataset_id=other.id, row_identifier="R0001")
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text="x"))
        db.flush()

        assert pp.project_export_value_count(db, 1) == 6
        assert pp.project_export_value_count(db, 2) == 1


class TestTheEndpoint:
    def test_it_reports_the_count_the_limit_and_the_threshold(self, project):
        from app.routers.projects import get_project_export_ceiling

        db = project
        _dataset_with_values(db, n_rows=4, n_cols=3)

        resp = _run(get_project_export_ceiling(project_id=1, user=_user(db), db=db))

        assert resp.dataset_values == 12
        assert resp.limit == pp.MAX_PROJECT_EXPORT_VALUES
        assert resp.warn_fraction == pp.PROJECT_EXPORT_WARN_FRACTION

    def test_the_limit_rides_the_payload_rather_than_being_a_client_constant(self):
        """The refusal message promises "A larger limit is planned", so a client
        copy would silently disagree the day it moves. The client renders a
        percentage OF this number, so it has to be sent."""
        from app.schemas.project import ProjectExportCeilingResponse

        assert "limit" in ProjectExportCeilingResponse.model_fields
        assert "warn_fraction" in ProjectExportCeilingResponse.model_fields

    def test_a_project_that_is_not_yours_is_a_404(self, project):
        from fastapi import HTTPException

        from app.routers.projects import get_project_export_ceiling

        db = project
        with pytest.raises(HTTPException) as exc:
            _run(get_project_export_ceiling(project_id=9999, user=_user(db), db=db))
        assert exc.value.status_code == 404

    def test_an_empty_project_reports_zero_rather_than_failing(self, project):
        from app.routers.projects import get_project_export_ceiling

        db = project
        resp = _run(get_project_export_ceiling(project_id=1, user=_user(db), db=db))
        assert resp.dataset_values == 0
