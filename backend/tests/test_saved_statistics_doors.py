"""The saved-statistics batch (#1168, #1172, #1173, #1145, #1149): every door that
moves a saved metric's input leaves that metric marked out of date.

🔴 **Why this matters.** Quick compute serves a stored result whenever its metric
is not `stale` (`routers/metrics.py`), so a door that moves cells, rows or a
group's grouping columns without a marker leaves a number on screen that the
data no longer gives — with no warning. Each test here reproduces one door on the
code before the batch (run against a pristine worktree, 2026-10-10) and pins the
fix.

The DERIVED half — every writer of cells or rows must reach a marker — is
`test_metric_staleness_doors.py`. This file is the behaviour, door by door.
"""
from __future__ import annotations

import asyncio
import json
import threading

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import ComputedResult, MetricDefinition
from app.models.project import Project
from app.models.statistical_test import StatisticalTest
from app.models.user import User


def _run(coro):
    return asyncio.run(coro)


# ── The quick-compute-versus-writer race (plan §2c) ──────────────────────────


@pytest.fixture
def file_engine(tmp_path):
    """A FILE database in WAL mode, built the way `database.get_engine` builds the
    plaintext engine — the race needs two real connections, which the suite's
    `:memory:` StaticPool cannot give."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'race.db'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def test_a_writer_that_commits_during_a_compute_leaves_the_metric_stale(
    file_engine, monkeypatch,
):
    """🔴 The plan REASONED this safe (the late write would fail under WAL); it is
    safe for a different reason, measured here.

    pysqlite opens a transaction only before the first write, so a compute's
    SELECTs do NOT share one snapshot and the WAL argument does not apply. What
    closes the race is ORDER: `compute_metric` deletes the old results BEFORE it
    reads a cell, so it holds the write lock for the whole read; a writer that
    arrives in that window waits, then commits its cells AND its mark after the
    compute has cleared the flag — so the mark survives.

    The scenario: the metric is already stale (an earlier edit), so the writer's
    own mark would be a no-op if it landed BEFORE the compute's commit. The hook
    runs inside the compute, after it has read the column's cells, and gives the
    writer one second to commit. Under the shipped order the writer is still
    waiting when the compute commits.
    """
    from app.services import metrics as metrics_service
    from app.services.staleness import mark_metrics_stale

    Session = sessionmaker(bind=file_engine, autoflush=False)
    with Session() as setup:
        setup.add(User(id=1, username="u", password_hash="x"))
        setup.add(Project(id=1, name="Race", user_id=1))
        setup.add(Dataset(id=1, project_id=1, name="Survey"))
        setup.add(DatasetColumn(
            id=1, dataset_id=1, column_code="Q", column_text="Q",
            column_type=ColumnType.NUMERIC, sequence_order=0, display_order=0,
        ))
        for i, v in enumerate([1.0, 2.0, 3.0], start=1):
            setup.add(DatasetRow(id=i, dataset_id=1))
            setup.add(DatasetValue(row_id=i, column_id=1, value_text=str(int(v)), value_numeric=v))
        setup.add(MetricDefinition(
            id=1, project_id=1, name="Mean Q", metric_type="mean", config="{}",
            input_source_type="dataset_column", input_source_id=1, stale=True, origin="auto",
        ))
        setup.commit()

    writer_outcome: dict = {}

    def writer():
        try:
            with Session() as w:
                w.query(DatasetValue).filter(DatasetValue.row_id == 3).update(
                    {"value_text": "30", "value_numeric": 30.0}, synchronize_session=False,
                )
                mark_metrics_stale(w, 1, column_ids=[1])
                w.commit()
                writer_outcome["committed"] = True
        except OperationalError as exc:  # pragma: no cover — reported, not hidden
            writer_outcome["error"] = str(exc)

    real_resolve = metrics_service.resolve_dataset_column
    thread = threading.Thread(target=writer)

    def resolve_then_let_the_writer_in(metric_def, db):
        grouped = real_resolve(metric_def, db)  # the OLD cells are now in hand
        thread.start()
        thread.join(timeout=1.0)
        writer_outcome["finished_inside_the_compute"] = not thread.is_alive()
        return grouped

    monkeypatch.setattr(metrics_service, "resolve_dataset_column", resolve_then_let_the_writer_in)

    with Session() as compute:
        metric = compute.get(MetricDefinition, 1)
        metrics_service.compute_metric(compute, metric)
        compute.commit()
    thread.join(timeout=15)

    assert writer_outcome.get("committed"), writer_outcome
    assert writer_outcome["finished_inside_the_compute"] is False, (
        "the writer committed while the compute was reading — nothing held the "
        "write lock, so the compute's stale=False can overwrite the writer's mark"
    )
    with Session() as check:
        metric = check.get(MetricDefinition, 1)
        stored = json.loads(check.query(ComputedResult).filter_by(metric_definition_id=1).one().result_data)
        assert stored["mean"] == pytest.approx(2.0)  # computed from the OLD cells …
        assert metric.stale is True                   # … and marked out of date


# ── The shared world ─────────────────────────────────────────────────────────


def _user(db):
    return db.get(User, 1)


def _world(db):
    """Two waves of one survey, as a researcher builds them.

    wave 1 (dataset 1): A (11, numeric, manual), B (12, numeric, manual),
        Role (13, demographic, manual), C (14, computed = A * 2), D (15, numeric)
    wave 2 (dataset 2): A (21, numeric, paired with 11), Role (22, demographic —
        wave 1 Role's sibling by name), E (23, numeric)

    groups: Wellbeing (1) = {11, 21}, cross-dataset, paired by EG 1
            Local (2) = {11, 12}
            Lonely (3) = {15}
    metrics: 1 mean B · 2 Wellbeing by Role (grouped, sibling 22) · 3 Local scale
             score (origin human) · 4 mean A by Role · 5 mean C · 6 Lonely scale
             score · 7 Wellbeing by wave (grouping_mode="dataset")
    tests: 1 t-test on metric 3 · 2 α on Local · 3 α on Lonely · 4 t-test on 4
    """
    from app.models.equivalence_group import EquivalenceGroup

    db.add(Project(id=1, name="Survey", user_id=1))
    db.add_all([Dataset(id=1, project_id=1, name="Wave 1"),
                Dataset(id=2, project_id=1, name="Wave 2")])
    db.add(EquivalenceGroup(id=1, project_id=1, label="A"))
    db.flush()

    def col(cid, ds, code, ctype, order, *, name=None, eg=None, source="manual", **kw):
        return DatasetColumn(
            id=cid, dataset_id=ds, column_code=code, column_text=code,
            column_name=name or code, column_type=ctype, equivalence_group_id=eg,
            source=source, sequence_order=order, display_order=order, **kw,
        )

    db.add_all([
        col(11, 1, "A", ColumnType.NUMERIC, 0, eg=1),
        col(12, 1, "B", ColumnType.NUMERIC, 1),
        col(13, 1, "ROLE", ColumnType.DEMOGRAPHIC, 2, name="Role"),
        col(14, 1, "C", ColumnType.NUMERIC, 3, source="computed",
            expression="[A] * 2", depends_on_column_ids="[11]"),
        col(15, 1, "D", ColumnType.NUMERIC, 4),
        col(21, 2, "A", ColumnType.NUMERIC, 0, eg=1),
        col(22, 2, "ROLE", ColumnType.DEMOGRAPHIC, 1, name="Role"),
        col(23, 2, "E", ColumnType.NUMERIC, 2),
    ])
    db.flush()
    cells = {
        1: {11: "1", 12: "4", 13: "Staff", 15: "2"},
        2: {11: "2", 12: "5", 13: "Staff", 15: "3"},
        3: {11: "3", 12: "6", 13: "Lead", 15: "4"},
        4: {21: "4", 22: "Staff", 23: "1"},
        5: {21: "5", 22: "Lead", 23: "2"},
        6: {21: "6", 22: "Lead", 23: "3"},
    }
    for row_id, row_cells in cells.items():
        db.add(DatasetRow(id=row_id, dataset_id=1 if row_id <= 3 else 2))
        db.flush()
        for column_id, text in row_cells.items():
            number = None if column_id in (13, 22) else float(text)
            db.add(DatasetValue(row_id=row_id, column_id=column_id,
                                value_text=text, value_numeric=number))
    for row_id, a in ((1, 1.0), (2, 2.0), (3, 3.0)):
        db.add(DatasetValue(row_id=row_id, column_id=14, value_text=str(a * 2), value_numeric=a * 2))
    db.add_all([AnalysisDomain(id=1, project_id=1, name="Wellbeing"),
                AnalysisDomain(id=2, project_id=1, name="Local"),
                AnalysisDomain(id=3, project_id=1, name="Lonely")])
    db.flush()
    for domain_id, cols in ((1, (11, 21)), (2, (11, 12)), (3, (15,))):
        for i, cid in enumerate(cols):
            db.add(AnalysisDomainMember(domain_id=domain_id, member_type="column",
                                        member_id=cid, sequence_order=i))

    def metric(mid, mtype, stype, sid, origin="auto", **kw):
        return MetricDefinition(id=mid, project_id=1, name=f"Metric {mid}", metric_type=mtype,
                                config="{}", input_source_type=stype, input_source_id=sid,
                                stale=False, origin=origin, **kw)

    db.add_all([
        metric(1, "mean", "dataset_column", 12),
        metric(2, "domain_aggregate", "dataset_domain", 1, grouping_column_id=13),
        metric(3, "domain_aggregate", "dataset_domain", 2, origin="human"),
        metric(4, "mean", "dataset_column", 11, grouping_column_id=13),
        metric(5, "mean", "dataset_column", 14),
        metric(6, "domain_aggregate", "dataset_domain", 3, origin="human"),
        metric(7, "domain_aggregate", "dataset_domain", 1, grouping_mode="dataset"),
    ])
    db.add_all([
        StatisticalTest(id=1, project_id=1, test_type="independent_t_test",
                        target_type="metric_definition", target_id=3, stale=False),
        StatisticalTest(id=2, project_id=1, test_type="cronbachs_alpha",
                        target_type="analysis_domain", target_id=2, stale=False),
        StatisticalTest(id=3, project_id=1, test_type="cronbachs_alpha",
                        target_type="analysis_domain", target_id=3, stale=False),
        StatisticalTest(id=4, project_id=1, test_type="independent_t_test",
                        target_type="metric_definition", target_id=4, stale=False),
    ])
    db.flush()


def _stale(db, model, ident):
    obj = db.get(model, ident)
    db.refresh(obj)
    return obj.stale


def _fresh_all(db):
    db.query(MetricDefinition).update({"stale": False})
    db.query(StatisticalTest).update({"stale": False})
    db.query(DatasetColumn).update({"stale": False})
    db.flush()
    db.expire_all()


# ── Door 1: recomputing a computed variable ──────────────────────────────────


def test_door1_recomputing_a_computed_variable_marks_its_metrics(db_session):
    from app.routers.dataset import recompute_column

    _world(db_session)
    _run(recompute_column(1, 1, 14, user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 5) is True
    assert _stale(db_session, MetricDefinition, 1) is False  # over-mark falsifier


# ── Doors 2–3: deleting a variable or a dataset ──────────────────────────────


def test_door2_a_variable_delete_marks_the_surviving_group(db_session):
    """(i) Local keeps A after B is deleted; its scale score kept pooling B."""
    from app.routers.dataset import delete_manual_column

    _world(db_session)
    _run(delete_manual_column(1, 1, 12, user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 3) is True
    assert _stale(db_session, StatisticalTest, 2) is True   # Local's α
    assert _stale(db_session, StatisticalTest, 1) is True   # the t-test on its score
    assert db_session.get(MetricDefinition, 1) is None       # B's own metric goes


def test_door2_a_grouping_variable_delete_removes_the_grouped_metric(db_session):
    """(ii) `grouping_column_id` is ON DELETE SET NULL and part of the identity
    key, so the grouped chart used to BECOME the ungrouped chart of A — with its
    per-group results, unmarked."""
    from app.routers.dataset import delete_manual_column
    from app.services.metrics import compute_metric, find_or_create_metric

    _world(db_session)
    compute_metric(db_session, db_session.get(MetricDefinition, 4))
    db_session.flush()

    _run(delete_manual_column(1, 1, 13, user=_user(db_session), db=db_session))
    db_session.expire_all()

    assert db_session.get(MetricDefinition, 4) is None
    assert db_session.get(StatisticalTest, 4) is None
    ungrouped, is_new = find_or_create_metric(db_session, 1, "dataset_column", 11, "mean", {})
    assert is_new, (
        f"quick compute for the UNGROUPED mean of A was handed metric {ungrouped.id}, "
        "the formerly-grouped chart, with its per-group results"
    )


def test_door2_a_variable_delete_that_empties_a_group_takes_its_statistics(db_session):
    """(iii) The group was deleted and its metrics and tests orphaned."""
    from app.routers.dataset import delete_manual_column

    _world(db_session)
    _run(delete_manual_column(1, 1, 15, user=_user(db_session), db=db_session))
    assert db_session.get(AnalysisDomain, 3) is None
    assert db_session.get(MetricDefinition, 6) is None
    assert db_session.get(StatisticalTest, 3) is None


def test_door2_a_sibling_grouping_variable_delete_marks_the_grouped_group(db_session):
    """Wave 2's Role groups wave 2's rows in metric 2; it is no member of any group."""
    from app.routers.dataset import delete_manual_column

    _world(db_session)
    _run(delete_manual_column(1, 2, 22, user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 2) is True
    assert _stale(db_session, MetricDefinition, 3) is False  # over-mark falsifier


def test_1173_a_variable_delete_dissolves_its_own_equivalence_group(db_session):
    from app.models.equivalence_group import EquivalenceGroup
    from app.routers.dataset import delete_manual_column

    _world(db_session)
    db_session.add(EquivalenceGroup(id=2, project_id=1, label="D alone"))
    db_session.flush()
    db_session.get(DatasetColumn, 23).equivalence_group_id = 2
    db_session.flush()

    _run(delete_manual_column(1, 2, 23, user=_user(db_session), db=db_session))
    assert db_session.get(EquivalenceGroup, 2) is None


def test_door3_a_dataset_delete_marks_the_surviving_group(db_session):
    """Wellbeing keeps wave 1's A when wave 2 goes: its grouped score moved."""
    from app.routers.dataset import delete_dataset

    _world(db_session)
    _run(delete_dataset(1, 2, user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 2) is True
    assert _stale(db_session, MetricDefinition, 1) is False  # over-mark falsifier


def test_the_removal_plan_names_what_the_delete_removes(db_session):
    """#1175 — the confirmation reads the plan the delete executes."""
    from app.routers.dataset import delete_manual_column, get_column_removal_plan

    _world(db_session)
    db_session.get(MetricDefinition, 4).origin = "human"
    db_session.get(MetricDefinition, 4).name = "A by role"
    db_session.flush()
    plan = get_column_removal_plan(1, 1, 13, user=_user(db_session), db=db_session)
    # metric 4 (saved, named) and metric 2 (quick compute's, counted) are grouped
    # by Role; the t-test on metric 4 goes with it.
    assert plan.saved_metrics_removed == ["A by role"]
    assert plan.tests_removed == 1
    assert plan.groups_recalculated == [] and plan.groups_removed == []
    assert plan.refusal is None and plan.blocked_by == []

    _run(delete_manual_column(1, 1, 13, user=_user(db_session), db=db_session))
    assert db_session.get(MetricDefinition, 4) is None
    assert db_session.get(MetricDefinition, 2) is None
    assert db_session.get(StatisticalTest, 4) is None


def test_the_removal_plan_says_the_refusal_before_the_click(db_session):
    """Wellbeing also holds wave 1's B and wave 2's E, paired with each other.
    Deleting E leaves B in a two-dataset group with nothing to pair with — the
    #298 refusal, which used to arrive only as a 409 after the click."""
    from fastapi import HTTPException
    from app.models.equivalence_group import EquivalenceGroup
    from app.routers.dataset import delete_manual_column, get_column_removal_plan

    _world(db_session)
    db_session.add(EquivalenceGroup(id=3, project_id=1, label="B/E"))
    db_session.flush()
    for cid in (12, 23):
        db_session.get(DatasetColumn, cid).equivalence_group_id = 3
        db_session.add(AnalysisDomainMember(domain_id=1, member_type="column",
                                            member_id=cid, sequence_order=cid))
    db_session.flush()
    plan = get_column_removal_plan(1, 2, 23, user=_user(db_session), db=db_session)
    assert plan.refusal and "Wellbeing" in plan.refusal

    with pytest.raises(HTTPException) as exc:
        _run(delete_manual_column(1, 2, 23, user=_user(db_session), db=db_session))
    assert exc.value.status_code == 409
    assert exc.value.detail["message"] == plan.refusal
    assert db_session.get(DatasetColumn, 23).equivalence_group_id == 3, (
        "a refused delete must change nothing — it refuses before it writes"
    )


def test_the_column_plan_names_the_computed_variables_that_block_it(db_session):
    from app.routers.dataset import get_column_removal_plan

    _world(db_session)
    plan = get_column_removal_plan(1, 1, 11, user=_user(db_session), db=db_session)
    assert plan.blocked_by == ["C"]


# ── Door 7: the startup repair ───────────────────────────────────────────────


def test_door7_the_reverse_recode_repair_marks_what_it_reapplied(db_session):
    from app.models.recode import OutputType, RecodeDefinition, RecodeType
    from app.services.recode import repair_reverse_recode_mappings

    _world(db_session)
    col = db_session.get(DatasetColumn, 12)
    col.column_type = ColumnType.ORDINAL
    db_session.add(RecodeDefinition(
        id=1, column_id=12, name="scale", recode_type=RecodeType.SCALE_MAP,
        output_type=OutputType.NUMERIC, mapping=json.dumps({"4": 4, "5": 5, "6": 6}),
        sequence_order=1,
    ))
    db_session.add(RecodeDefinition(   # the #578 double-flip: stored FLIPPED
        id=2, column_id=12, name="reversed", recode_type=RecodeType.REVERSE,
        output_type=OutputType.NUMERIC, mapping=json.dumps({"4": 6, "5": 5, "6": 4}),
        source_definition_id=1, is_primary=True, sequence_order=2,
    ))
    db_session.flush()

    assert repair_reverse_recode_mappings(db_session) == 1
    assert _stale(db_session, MetricDefinition, 1) is True
    assert _stale(db_session, MetricDefinition, 5) is False  # over-mark falsifier


# ── Door 8: what changes who is a sibling ────────────────────────────────────


def test_door8_a_subtype_edit_that_changes_the_match_marks_the_grouped_group(db_session):
    from app.routers.dataset import _SubtypeUpdateRequest, update_column_subtype

    _world(db_session)
    db_session.get(DatasetColumn, 22).column_name = "Job"   # no longer a name match
    db_session.flush()
    for cid in (13, 22):
        _run(update_column_subtype(1, 1 if cid == 13 else 2, cid,
                                   _SubtypeUpdateRequest(demographic_subtype="role"),
                                   user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 2) is True
    assert _stale(db_session, MetricDefinition, 4) is False  # A by Role: no siblings


def test_door8_a_short_name_edit_that_breaks_the_match_marks_it(db_session):
    from app.routers.dataset import update_column_header
    from app.schemas.dataset import ColumnHeaderUpdate

    _world(db_session)
    _run(update_column_header(1, 2, 22, ColumnHeaderUpdate(column_name="Job"),
                              user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 2) is True


def test_door8_a_short_name_edit_on_an_unrelated_variable_marks_nothing(db_session):
    from app.routers.dataset import update_column_header
    from app.schemas.dataset import ColumnHeaderUpdate

    _world(db_session)
    _run(update_column_header(1, 2, 23, ColumnHeaderUpdate(column_name="Extra"),
                              user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 2) is False


def test_door8_unpairing_a_group_member_marks_its_reliability_test(db_session):
    """α collapses paired columns into one item; removing A's pairing re-shapes
    Local's item matrix? Local is single-dataset — Wellbeing is the paired one."""
    from app.routers.equivalence import remove_columns
    from app.schemas.equivalence import EquivalenceGroupRemoveColumns
    from tests.conftest import mock_request

    _world(db_session)
    db_session.add(StatisticalTest(id=5, project_id=1, test_type="cronbachs_alpha",
                                   target_type="analysis_domain", target_id=1, stale=False))
    db_session.delete(db_session.query(AnalysisDomainMember).filter_by(domain_id=1, member_id=21).one())
    db_session.flush()
    _run(remove_columns(mock_request(), 1, 1, EquivalenceGroupRemoveColumns(column_ids=[11]),
                        user=_user(db_session), db=db_session))
    assert _stale(db_session, StatisticalTest, 5) is True
    assert _stale(db_session, StatisticalTest, 2) is True   # Local holds 11 too
    assert _stale(db_session, MetricDefinition, 3) is False  # a scale score reads no pairing


# ── #1172: the crosswalk move ────────────────────────────────────────────────


def test_1172_moving_a_variable_marks_the_group_it_left(db_session):
    from app.routers.crosswalk import move_members
    from app.schemas.crosswalk import MoveMembersRequest
    from tests.conftest import mock_request

    _world(db_session)
    _run(move_members(
        mock_request(), 1,
        MoveMembersRequest(column_ids=[12], source_domain_id=2, target_domain_id=3,
                           target_mode="strip"),
        user=_user(db_session), db=db_session,
    ))
    assert _stale(db_session, StatisticalTest, 2) is True   # Local's α (the source)
    assert _stale(db_session, StatisticalTest, 1) is True   # t-test on Local's score
    assert _stale(db_session, MetricDefinition, 1) is False  # B's own mean: no cell moved


# ── #1228: reordering a variable group's items ───────────────────────────────


def _split_half_world(db):
    """One four-item group (9) — and a second group (8) over the SAME four
    columns, to show the mark stays with the group that was reordered.

    The data are the audit probe's: items A and B agree, C and D agree, and the
    two pairs disagree, so the split A,C | B,D gives r = 1.0 and A,B | C,D gives
    a negative r. A fixture on which every split agrees could not show the
    number moving.
    """
    from app.services.metrics import compute_metric
    from app.services.statistical_tests import compute_statistical_test

    db.add(Project(id=1, name="Scale", user_id=1))
    db.add(Dataset(id=1, project_id=1, name="Survey"))
    db.flush()
    data = {31: [1, 2, 3, 4, 5, 4, 3, 2], 32: [1, 2, 3, 4, 5, 4, 3, 2],
            33: [5, 1, 4, 2, 3, 5, 1, 4], 34: [5, 1, 4, 2, 3, 5, 1, 4]}
    for i, (cid, code) in enumerate(zip(data, "ABCD")):
        db.add(DatasetColumn(id=cid, dataset_id=1, column_code=code, column_text=code,
                             column_name=code, column_type=ColumnType.ORDINAL,
                             sequence_order=i, display_order=i))
    db.add_all([AnalysisDomain(id=9, project_id=1, name="Scale"),
                AnalysisDomain(id=8, project_id=1, name="Same items")])
    db.flush()
    for domain_id in (9, 8):
        for i, cid in enumerate(data):
            db.add(AnalysisDomainMember(domain_id=domain_id, member_type="column",
                                        member_id=cid, sequence_order=i))
    for r in range(8):
        db.add(DatasetRow(id=100 + r, dataset_id=1))
        db.flush()
        for cid, values in data.items():
            db.add(DatasetValue(row_id=100 + r, column_id=cid,
                                value_text=str(values[r]), value_numeric=float(values[r])))
    db.add(MetricDefinition(id=9, project_id=1, name="Scale score", metric_type="domain_aggregate",
                            config="{}", input_source_type="dataset_domain", input_source_id=9,
                            stale=False, origin="human"))
    db.add_all([
        StatisticalTest(id=11, project_id=1, test_type="split_half",
                        target_type="analysis_domain", target_id=9, config="{}"),
        StatisticalTest(id=12, project_id=1, test_type="cronbachs_alpha",
                        target_type="analysis_domain", target_id=9, config="{}"),
        StatisticalTest(id=13, project_id=1, test_type="split_half",
                        target_type="analysis_domain", target_id=8, config="{}"),
    ])
    db.flush()
    compute_metric(db, db.get(MetricDefinition, 9))
    for test_id in (11, 12, 13):
        compute_statistical_test(db, db.get(StatisticalTest, test_id))
    db.commit()


def _member_ids(db, domain_id):
    return [m.id for m in db.query(AnalysisDomainMember)
            .filter_by(domain_id=domain_id).order_by(AnalysisDomainMember.sequence_order)]


def test_1228_reordering_a_groups_items_marks_its_split_half_test(db_session):
    """Reproduced 2026-10-15 (audit probe 1): the reorder committed with no
    marker, so the saved r = 1.0 read as current while its items gave −0.13."""
    from app.routers.analysis_domains import reorder_members
    from app.schemas.analysis_domain import DomainMemberReorderRequest
    from app.services.statistical_tests import compute_statistical_test

    _split_half_world(db_session)
    before = json.loads(db_session.get(StatisticalTest, 11).result_data)
    a, b, c, d = _member_ids(db_session, 9)
    _run(reorder_members(1, 9, DomainMemberReorderRequest(member_ids=[a, c, b, d]),
                         user=_user(db_session), db=db_session))

    assert _stale(db_session, StatisticalTest, 11) is True
    # α and the scale score cannot move with the order (#1149) …
    assert _stale(db_session, StatisticalTest, 12) is False
    assert _stale(db_session, MetricDefinition, 9) is False
    # … nor can another group's split, though it holds the same columns.
    assert _stale(db_session, StatisticalTest, 13) is False
    # The discrimination: the number really moved, so the mark is not decoration.
    after = compute_statistical_test(db_session, db_session.get(StatisticalTest, 11))
    assert before["split_half_r"] == 1.0
    assert after["split_half_r"] < 0


def test_1228_a_reorder_that_keeps_the_order_marks_nothing(db_session):
    from app.routers.analysis_domains import reorder_members
    from app.schemas.analysis_domain import DomainMemberReorderRequest

    _split_half_world(db_session)
    _run(reorder_members(1, 9, DomainMemberReorderRequest(member_ids=_member_ids(db_session, 9)),
                         user=_user(db_session), db=db_session))
    assert _stale(db_session, StatisticalTest, 11) is False


# ── Decision 5: a dataset rename ─────────────────────────────────────────────


def test_a_dataset_rename_marks_dataset_grouped_group_metrics(db_session):
    from app.routers.dataset import update_dataset
    from app.schemas.dataset import DatasetUpdate

    _world(db_session)
    _run(update_dataset(1, 2, DatasetUpdate(name="Wave 2 (2026)"),
                        user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 7) is True
    assert _stale(db_session, MetricDefinition, 2) is False


def test_a_dataset_description_edit_marks_nothing(db_session):
    from app.routers.dataset import update_dataset
    from app.schemas.dataset import DatasetUpdate

    _world(db_session)
    _run(update_dataset(1, 2, DatasetUpdate(description="Spring"),
                        user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 7) is False


# ── #1145: the bulk retype (and door 6, its mark) ────────────────────────────


def _retype_world(file_engine):
    """`_world` on a FILE database, with B (12) and D (15) typed NOMINAL — their
    cells hold text and no number, as the import leaves a nominal column."""
    Session = sessionmaker(bind=file_engine, autoflush=False)
    with Session() as setup:
        setup.add(User(id=1, username="u", password_hash="x"))
        setup.flush()
        _world(setup)
        for cid in (12, 15):
            setup.get(DatasetColumn, cid).column_type = ColumnType.NOMINAL
            setup.query(DatasetValue).filter(DatasetValue.column_id == cid).update(
                {"value_numeric": None}, synchronize_session=False,
            )
        setup.commit()
    return Session


def _bulk_retype(Session, monkeypatch, *, before_plan=None, after_plan=None, before_write=None):
    """Run the real endpoint, with hooks around the real plan and write calls."""
    from app.routers import recode as recode_router
    from app.schemas.recode import BulkTypeUpdateRequest

    calls: list[tuple[str, int]] = []
    real_plan, real_write = recode_router.plan_rederived_cells, recode_router.write_rederived_cells

    def plan(db, column):
        if before_plan:
            before_plan(column.id)
        calls.append(("plan", column.id))
        changes = real_plan(db, column)
        if after_plan:
            after_plan(column.id)
        return changes

    def write(db, changes):
        column_id = (
            db.get(DatasetValue, changes[0]["b_id"]).column_id if changes else None
        )
        if before_write:
            before_write(column_id)
        calls.append(("write", column_id))
        return real_write(db, changes)

    monkeypatch.setattr(recode_router, "plan_rederived_cells", plan)
    monkeypatch.setattr(recode_router, "write_rederived_cells", write)
    with Session() as db:
        recode_router.bulk_type_update(
            1, 1, BulkTypeUpdateRequest(column_ids=[12, 15], column_type="numeric"),
            user=db.get(User, 1), db=db,
        )
    return calls


def test_1145_each_column_is_written_before_the_next_is_planned(file_engine, monkeypatch):
    """One plan in memory at a time — asserted on the ORDER of the calls, never on
    a memory number (plan §4 step 5)."""
    Session = _retype_world(file_engine)
    calls = _bulk_retype(Session, monkeypatch)
    assert calls == [("plan", 12), ("write", 12), ("plan", 15), ("write", 15)]


def test_1145b_a_cell_edited_while_a_column_is_planned_keeps_its_new_types_number(
    file_engine, monkeypatch,
):
    """A researcher types "42" into B while the retype holds B's plan. Their edit
    derives its number from the type COMMITTED at that moment — the old type,
    when the plan was built before the type commit, so the cell kept no number
    (and the write skips an edited cell)."""
    from app.routers.dataset import update_value
    from app.schemas.dataset import ValueUpdate

    Session = _retype_world(file_engine)

    def researcher_edits(column_id):
        if column_id != 12:
            return
        with Session() as other:
            value_id = other.query(DatasetValue.id).filter_by(row_id=1, column_id=12).scalar()
            _run(update_value(1, 1, value_id, ValueUpdate(value_text="42"),
                              user=other.get(User, 1), db=other))

    _bulk_retype(Session, monkeypatch, after_plan=researcher_edits)
    with Session() as check:
        cell = check.query(DatasetValue).filter_by(row_id=1, column_id=12).one()
        assert (cell.value_text, cell.value_numeric) == ("42", 42.0)


def test_1145c_a_compute_between_the_type_commit_and_the_cells_ends_stale(
    file_engine, monkeypatch,
):
    """A chart opened after the types commit computes on the OLD numbers and
    clears the flag; the cells then move. The mark must come after them."""
    from app.services.metrics import compute_metric

    Session = _retype_world(file_engine)

    def chart_opened(column_id):
        if column_id != 12:
            return
        with Session() as other:
            compute_metric(other, other.get(MetricDefinition, 1))
            other.commit()
            assert other.get(MetricDefinition, 1).stale is False  # precondition

    _bulk_retype(Session, monkeypatch, before_write=chart_opened)
    with Session() as check:
        assert check.get(MetricDefinition, 1).stale is True


# ── Door 5: a project-file MERGE that carries rows and cells ────────────────


def _merge_world(db, tmp_path):
    import uuid as _uuid
    from app.services.project_portability import export_project

    _world(db)
    db.get(Project, 1).project_uuid = str(_uuid.uuid4())
    db.flush()
    archive = tmp_path / "copy.mmproject"
    archive.write_bytes(export_project(db, 1, tmp_path / "docs").getvalue())
    return archive


def _merge(db, archive, tmp_path):
    from app.services.project_portability import import_project

    import_project(db, archive, tmp_path / "docs", user_id=1, import_mode="merge",
                   target_project_id=1, report={})
    db.flush()
    db.expire_all()


def test_door5_a_merged_cell_marks_the_metrics_on_its_column(db_session, tmp_path):
    archive = _merge_world(db_session, tmp_path)
    db_session.delete(db_session.query(DatasetValue).filter_by(row_id=1, column_id=12).one())
    _fresh_all(db_session)

    _merge(db_session, archive, tmp_path)

    assert db_session.query(DatasetValue).filter_by(row_id=1, column_id=12).count() == 1
    assert db_session.get(MetricDefinition, 1).stale is True
    assert db_session.get(MetricDefinition, 5).stale is False  # over-mark falsifier


def test_door5_a_merged_row_marks_the_columns_its_cells_land_in(db_session, tmp_path):
    """A merged record moves a metric through the cells it brings (every reader
    starts from a column's cells) — here C's, a computed column nobody edited."""
    archive = _merge_world(db_session, tmp_path)
    db_session.delete(db_session.get(DatasetRow, 3))
    _fresh_all(db_session)

    _merge(db_session, archive, tmp_path)

    assert db_session.query(DatasetRow).filter_by(dataset_id=1).count() == 3
    assert db_session.get(MetricDefinition, 5).stale is True   # C gained a cell


def test_a_noop_merge_marks_nothing(db_session, tmp_path):
    """Over-mark falsifier: the #714 rule — a merge that wrote no cell and no row
    must not touch the target's metrics."""
    archive = _merge_world(db_session, tmp_path)
    _fresh_all(db_session)

    _merge(db_session, archive, tmp_path)

    assert not any(m.stale for m in db_session.query(MetricDefinition).all())


# ── Door 8: a pairing created through the equivalence endpoints ──────────────


def test_door8_pairing_two_variables_marks_the_groups_holding_them(db_session):
    from app.routers.equivalence import create_group
    from app.schemas.equivalence import EquivalenceGroupCreate

    _world(db_session)
    _run(create_group(1, EquivalenceGroupCreate(label="B/E", column_ids=[12, 23]),
                      user=_user(db_session), db=db_session))
    assert _stale(db_session, StatisticalTest, 2) is True    # Local holds B
    assert _stale(db_session, StatisticalTest, 3) is False   # Lonely holds neither
    assert _stale(db_session, MetricDefinition, 1) is False  # B's own mean


def test_door8_retyping_a_sibling_away_from_demographic_marks_the_grouped_group(
    file_engine, monkeypatch,
):
    """The bulk retype changes who is a sibling: wave 2's Role retyped nominal is
    no longer matched, so metric 2's wave-2 groups are gone."""
    from app.routers import recode as recode_router
    from app.schemas.recode import BulkTypeUpdateRequest

    Session = _retype_world(file_engine)
    with Session() as db:
        recode_router.bulk_type_update(
            1, 2, BulkTypeUpdateRequest(column_ids=[22], column_type="nominal"),
            user=db.get(User, 1), db=db,
        )
    with Session() as check:
        assert check.get(MetricDefinition, 2).stale is True
        assert check.get(MetricDefinition, 4).stale is False


# ── R7 (plan step 8): Correlations / Comparisons read stored scale scores ────


def test_r7_an_out_of_date_scale_score_is_served_and_now_said_to_be(db_session):
    """Reproduced 2026-10-10: after a member's cell moves, Correlations keeps
    serving the scores computed before the edit (no recompute inside a GET,
    DEC-C), and the payload said nothing. It still serves them — that is the
    design — but it now names the group, so the tab can say so."""
    from app.routers.dataset import update_value
    from app.schemas.dataset import ValueUpdate
    from app.services.comparisons import compute_group_comparison
    from app.services.correlations import compute_correlation_matrix
    from app.services.metrics import compute_metric

    _world(db_session)
    for metric_id in (3, 6):       # Local {A, B} and Lonely {D}
        compute_metric(db_session, db_session.get(MetricDefinition, metric_id))
    db_session.flush()

    def matrix():
        return compute_correlation_matrix(db_session, 1, [], [2, 3], "pearson", False)

    before = matrix()
    assert before["stale_domain_ids"] == []
    r_before = before["matrix"][0][1]["r"]

    value_id = db_session.query(DatasetValue.id).filter_by(row_id=3, column_id=12).scalar()
    _run(update_value(1, 1, value_id, ValueUpdate(value_text="60"), user=_user(db_session), db=db_session))
    assert _stale(db_session, MetricDefinition, 3) is True

    served = matrix()
    assert served["matrix"][0][1]["r"] == r_before, "precondition: the old scores are still served"
    assert served["stale_domain_ids"] == [2]
    comparison = compute_group_comparison(db_session, 1, [], [2], 13, None, "auto", False)
    assert comparison["stale_domain_ids"] == [2]

    compute_metric(db_session, db_session.get(MetricDefinition, 3))
    db_session.flush()
    fresh = matrix()
    assert fresh["stale_domain_ids"] == []
    assert fresh["matrix"][0][1]["r"] != r_before


# ── #1229: the two score readers #1176 did not reach ─────────────────────────


async def _collect_bytes(response) -> bytes:
    parts = [c async for c in response.body_iterator]
    return b"".join(p if isinstance(p, bytes) else p.encode() for p in parts)


async def _collect(response) -> str:
    return (await _collect_bytes(response)).decode("utf-8")


def _r_export_members(db) -> dict[str, str]:
    import io
    import zipfile

    from app.routers.export_r import export_r_data

    raw = _run(_collect_bytes(export_r_data(project_id=1, user=_user(db), db=db)))
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        return {n: zf.read(n).decode("utf-8") for n in zf.namelist()}


def _edit_local_member(db):
    """A member cell edit through the real door — it marks Local's score (3) stale."""
    from app.routers.dataset import update_value
    from app.schemas.dataset import ValueUpdate

    value_id = db.query(DatasetValue.id).filter_by(row_id=3, column_id=12).scalar()
    _run(update_value(1, 1, value_id, ValueUpdate(value_text="60"), user=_user(db), db=db))
    assert _stale(db, MetricDefinition, 3) is True


def test_1229_the_r_export_names_an_out_of_date_score_column(db_session):
    """Reproduced 2026-10-15 (audit probe 4): after a member's cell moved, the
    export's score column still held the old scores and the script said nothing."""
    from app.services.metrics import compute_metric

    _world(db_session)
    compute_metric(db_session, db_session.get(MetricDefinition, 3))   # Local: scored
    db_session.flush()

    def script():
        return next(t for n, t in _r_export_members(db_session).items() if n.endswith(".R"))

    assert "are out of date" not in script()          # control: a current score is not named
    _edit_local_member(db_session)
    # Lonely (6) is out of date AND was never computed: the NA note names it, this one must not.
    db_session.get(MetricDefinition, 6).stale = True
    db_session.flush()

    text = script()
    notes = [line for line in text.splitlines() if "are out of date" in line]
    assert len(notes) == 1, "the script must name the out-of-date score column"
    assert notes[0].endswith(": local_score")
    na_note = next(line for line in text.splitlines() if "entirely NA" in line)
    assert "lonely_score" in na_note


def test_1229_the_record_matrix_marks_an_out_of_date_column(db_session):
    """The matrix reaches the researcher only as a CSV (`metricsApi.rowMatrix(…,
    'csv')` at both call sites), so the file's heading is where it must say so."""
    from app.routers.metrics import get_row_matrix, get_row_matrix_csv
    from app.services.metrics import compute_metric

    _world(db_session)
    for metric_id in (3, 6):
        compute_metric(db_session, db_session.get(MetricDefinition, metric_id))
    db_session.flush()
    _edit_local_member(db_session)

    columns = {c.metric_id: c for c in get_row_matrix(1, None, _user(db_session), db_session).columns}
    assert getattr(columns[3], "stale", None) is True
    assert getattr(columns[6], "stale", None) is False

    def header():
        csv_text = _run(_collect(get_row_matrix_csv(1, None, _user(db_session), db_session)))
        return csv_text.splitlines()[0].split(",")

    assert header()[2:] == ["Local (out of date)", "Lonely"]
    # The marked heading is still defanged: a group name is the researcher's text.
    db_session.get(AnalysisDomain, 2).name = "=Local"
    db_session.flush()
    assert header()[2] == "'=Local (out of date)"


# ── The fold: `delete_dataset` on the shared service changes only what it meant to ──


def _old_inline_dataset_cascade(db, project_id, dataset_id):
    """`routers/dataset.py::delete_dataset`'s inline cascade AS IT WAS before the
    saved-statistics batch (commit 66e10f2c), kept verbatim as the differential
    test's reference — the plan's risk row: the fold must change nothing but the
    intended differences."""
    from sqlalchemy import func
    from app.models.equivalence_group import EquivalenceGroup
    from app.services.equivalence_validators import assert_domains_intact_for_domain_ids

    db.query(DatasetColumn).filter(
        DatasetColumn.dataset_id == dataset_id,
        DatasetColumn.equivalence_group_id.isnot(None),
    ).update({DatasetColumn.equivalence_group_id: None}, synchronize_session="fetch")
    column_ids = [r[0] for r in db.query(DatasetColumn.id).filter(DatasetColumn.dataset_id == dataset_id).all()]
    affected_domain_ids = [
        r[0] for r in db.query(AnalysisDomainMember.domain_id).filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(column_ids),
        ).distinct().all()
    ] if column_ids else []
    if column_ids:
        db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(column_ids),
        ).delete(synchronize_session="fetch")
        col_metric_ids = [r[0] for r in db.query(MetricDefinition.id).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id.in_(column_ids),
        ).all()]
        if col_metric_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.target_type == "metric_definition",
                StatisticalTest.target_id.in_(col_metric_ids),
            ).delete(synchronize_session="fetch")
        db.query(MetricDefinition).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id.in_(column_ids),
        ).delete(synchronize_session="fetch")
    empty_group_ids = [
        g.id for g in db.query(EquivalenceGroup)
        .outerjoin(DatasetColumn, DatasetColumn.equivalence_group_id == EquivalenceGroup.id)
        .filter(EquivalenceGroup.project_id == project_id)
        .group_by(EquivalenceGroup.id).having(func.count(DatasetColumn.id) == 0).all()
    ]
    if empty_group_ids:
        db.query(EquivalenceGroup).filter(EquivalenceGroup.id.in_(empty_group_ids)).delete(synchronize_session="fetch")
    db.flush()
    assert_domains_intact_for_domain_ids(db, affected_domain_ids)
    empty_domain_ids = [
        d.id for d in db.query(AnalysisDomain).outerjoin(AnalysisDomainMember)
        .filter(AnalysisDomain.project_id == project_id)
        .group_by(AnalysisDomain.id).having(func.count(AnalysisDomainMember.id) == 0).all()
    ]
    if empty_domain_ids:
        db.query(StatisticalTest).filter(
            StatisticalTest.target_type == "analysis_domain",
            StatisticalTest.target_id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")
        domain_metric_ids = [r[0] for r in db.query(MetricDefinition.id).filter(
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(empty_domain_ids),
        ).all()]
        if domain_metric_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.target_type == "metric_definition",
                StatisticalTest.target_id.in_(domain_metric_ids),
            ).delete(synchronize_session="fetch")
        db.query(MetricDefinition).filter(
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")
        db.query(AnalysisDomain).filter(AnalysisDomain.id.in_(empty_domain_ids)).delete(synchronize_session="fetch")
    db.flush()


def _end_state(db):
    from app.models.equivalence_group import EquivalenceGroup

    return {
        "metrics": sorted((m.id, m.grouping_column_id) for m in db.query(MetricDefinition)),
        "stale": sorted(m.id for m in db.query(MetricDefinition).filter_by(stale=True)),
        "tests": sorted(t.id for t in db.query(StatisticalTest)),
        "domains": sorted(d.id for d in db.query(AnalysisDomain)),
        "members": sorted((m.domain_id, m.member_id) for m in db.query(AnalysisDomainMember)),
        "groups": sorted(g.id for g in db.query(EquivalenceGroup)),
        "links": sorted((c.id, c.equivalence_group_id) for c in db.query(DatasetColumn)),
    }


@pytest.mark.parametrize("dataset_id", [1, 2])
def test_the_fold_changes_delete_dataset_only_as_intended(tmp_path, dataset_id):
    """Old inline cascade vs the shared service, each on its own identical file
    database. The ONLY differences allowed: a metric GROUPED by a removed column
    is removed (with its tests), and the metrics of a surviving group are marked
    stale. Everything else — memberships, groups, links, every other metric and
    test — must come out the same."""
    from app.services.column_cleanup import delete_column_references

    states = {}
    for label in ("old", "new"):
        engine = create_engine(f"sqlite:///{tmp_path / f'{label}.db'}")

        @event.listens_for(engine, "connect")
        def _fk(dbapi_connection, _record):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(engine)
        with sessionmaker(bind=engine, autoflush=False)() as db:
            db.add(User(id=1, username="u", password_hash="x"))
            db.flush()
            _world(db)
            db.commit()
            if label == "old":
                _old_inline_dataset_cascade(db, 1, dataset_id)
            else:
                ids = [r[0] for r in db.query(DatasetColumn.id).filter_by(dataset_id=dataset_id)]
                delete_column_references(db, 1, ids, validate_domains=True)
            db.delete(db.get(Dataset, dataset_id))
            db.commit()
            states[label] = _end_state(db)
        engine.dispose()

    old, new = states["old"], states["new"]
    # Wave 1 holds Role (13), metric 2's grouping column; Wellbeing survives on
    # wave 2's A. The old cascade let SET NULL make metric 2 "ungrouped".
    grouped_by_removed = {2} if dataset_id == 1 else set()
    if grouped_by_removed:
        assert (2, None) in old["metrics"], "precondition: SET NULL kept it, ungrouped"
    assert [m for m in old["metrics"] if m[0] not in grouped_by_removed] == new["metrics"]
    for key in ("tests", "domains", "members", "groups", "links"):
        assert old[key] == new[key], key
    assert old["stale"] == [], "the old cascade marked nothing"
    # The surviving group is Wellbeing either way: its metrics are marked.
    assert new["stale"] == ([7] if dataset_id == 1 else [2, 7])
