"""A `.mmproject` carries no per-record scores, and an import says so (#958 §6).

**The two halves ship together or not at all.** Dropping `row_scores` from the archive
without marking the imported metrics stale swaps one silent-wrong state for a worse one:
results that still SAY they are current with nothing behind them. So this file asserts the
drop, the marking, and the places each could go wrong quietly.

⚠️ **What a fixture CANNOT see here, stated so nobody reads a green run as more than it
is:** the size and time claims (`row_scores.jsonl` was 2,783,905 B of a 32.14 MB GSS
archive; a full recompute is 22.29 s) come from `backend/scripts/measure_portability.py`
against the real corpora, never from these seven rows.
"""
from __future__ import annotations

import json
import os
import uuid as uuid_module
import zipfile
from pathlib import Path

import pytest

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.row_score import RowScore
from app.services import project_portability as pp
from tests.archive_support import (
    archive_extras,
    archive_payload,
    rewrite_as_v6,
    write_archive,
)


SCALE_CONFIG = '{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}'


def _scored_project(db, *, scale_metric_stale: bool = False) -> dict:
    """A project holding both kinds of metric, each with per-record scores behind it.

    The DOMAIN metric is the one the Tier 3 backfill reaches during an import, so
    `scale_metric_stale` is the switch that decides whether that backfill no-ops or
    recomputes — the axis §x.6's exclusion turns on, and the one a fixture with a single
    metric could not exercise at all.
    """
    project = Project(name="Scored", user_id=1, project_uuid=str(uuid_module.uuid4()))
    db.add(project)
    db.flush()

    ds = Dataset(project_id=project.id, name="D")
    db.add(ds)
    db.flush()
    col = DatasetColumn(
        dataset_id=ds.id, column_name="q1", column_text="Q1",
        column_type=ColumnType.ORDINAL, sequence_order=0, display_order=0,
    )
    db.add(col)
    db.flush()

    rows = []
    for i in range(4):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i}")
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=col.id,
                            value_text=str(i + 1), value_numeric=float(i + 1)))
        rows.append(row)
    db.flush()

    domain = AnalysisDomain(project_id=project.id, name="Leadership", sequence_order=0)
    db.add(domain)
    db.flush()
    db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                member_id=col.id, sequence_order=0))
    db.flush()

    column_metric = MetricDefinition(
        project_id=project.id, name="Q1 mean", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=col.id,
        sequence_order=0, stale=False,
    )
    scale_metric = MetricDefinition(
        project_id=project.id, name="Leadership Score", metric_type="domain_aggregate",
        config=SCALE_CONFIG,
        input_source_type="dataset_domain", input_source_id=domain.id,
        grouping_column_id=None, grouping_column_id_2=None,
        sequence_order=1, origin="human", origin_context="crosswalk_auto",
        stale=scale_metric_stale,
    )
    db.add_all([column_metric, scale_metric])
    db.flush()

    for metric in (column_metric, scale_metric):
        for i, row in enumerate(rows):
            db.add(RowScore(metric_definition_id=metric.id,
                            dataset_row_id=row.id, score=float(i)))
    db.commit()
    return {
        "project": project, "domain": domain, "dataset": ds,
        "column_metric": column_metric, "scale_metric": scale_metric,
        "rows": rows,
    }


def _export(db, project, tmp_path, name="out.mmproject") -> Path:
    out = tmp_path / name
    out.write_bytes(
        pp.export_project(db, project.id, tmp_path / "docs", include_media=False).getvalue()
    )
    return out


def _scores_for(db, pid: int) -> int:
    return (
        db.query(RowScore)
        .filter(RowScore.metric_definition_id.in_(
            db.query(MetricDefinition.id).filter(MetricDefinition.project_id == pid)
        ))
        .count()
    )


# ── The export ──────────────────────────────────────────────────────────────

class TestTheArchive:

    def test_the_member_is_written_and_empty(self, db_session, tmp_path):
        """🔴 Written, not omitted. A v7 reader REFUSES an archive missing an entity
        member, so "we deliberately carry none of these" has to look exactly like "this
        project has none" — which is what `_DroppedEntity` is for.
        """
        made = _scored_project(db_session)
        assert _scores_for(db_session, made["project"].id) == 8, "vacuous fixture"

        archive = _export(db_session, made["project"], tmp_path)
        with zipfile.ZipFile(archive) as zf:
            assert "row_scores.jsonl" in zf.namelist()
            assert zf.read("row_scores.jsonl") == b""

    def test_the_archive_still_carries_the_metrics_and_their_results(
        self, db_session, tmp_path,
    ):
        """⚠️ Only the DATA-SCALED half is dropped.

        `ComputedResult` is metric-scaled, it is what the charts read, and it travels with
        its own `computed_at` — so an imported project shows the numbers the colleague saw,
        marked out of date, rather than an empty screen. A change that dropped it too would
        pass every other assertion in this file.
        """
        made = _scored_project(db_session)
        payload = archive_payload(_export(db_session, made["project"], tmp_path))
        assert len(payload["metric_definitions"]) == 2
        assert payload["row_scores"] == []

    def test_a_v7_archive_is_still_importable_by_its_own_reader(self, db_session,
                                                                tmp_path):
        """The presence check runs on validate as well as on import (see #958 step 3)."""
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        result = pp.validate_project_file(archive)
        assert result["manifest"]["format_version"] == pp.CURRENT_FORMAT_VERSION


# ── The import ──────────────────────────────────────────────────────────────

class TestTheImport:

    def test_no_scores_land_from_a_v7_archive(self, db_session, tmp_path):
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d1", user_id=1)
        db_session.flush()
        assert _scores_for(db_session, pid) == 0

    def test_no_scores_land_from_a_v6_ARCHIVE_THAT_CARRIES_THEM(self, db_session,
                                                                 tmp_path):
        """🔴 The rule is about the KIND of row, not about which build wrote the file.

        Four years of v<=6 archives hold the full inline list, and a `.mmproject` is a
        backup as much as an exchange file. Importing those while a fresh export carries
        none would make one project behave two ways depending on the build that produced
        its file — and would land numbers of unknown provenance that §x.6 then has to
        declare stale anyway.

        ⚠️ **The fixture has to put the rows BACK.** `rewrite_as_v6` starts from this
        build's export, which no longer carries any, so a plain rewrite tests an empty list
        against an empty list and proves nothing — the degenerate-fixture trap, on the one
        arm where the old data actually exists.
        """
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        payload = archive_payload(archive)
        assert payload["row_scores"] == []

        # Re-create what a real v6 export of this project would have held.
        metric_ids = [m["_original_id"] for m in payload["metric_definitions"]]
        row_ids = [r["_original_id"] for r in payload["dataset_rows"]]
        payload["row_scores"] = [
            {"_original_id": 1000 + i, "metric_definition_id": metric_ids[0],
             "dataset_row_id": rid, "score": 1.5, "computed_at": "2026-01-01T00:00:00"}
            for i, rid in enumerate(row_ids)
        ]
        with zipfile.ZipFile(archive) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            extras = archive_extras(zf)
        manifest["format_version"] = 6
        old = write_archive(tmp_path / "v6.mmproject", manifest, payload, extras,
                            inline=True)
        assert len(archive_payload(old)["row_scores"]) == len(row_ids), (
            "the fixture failed to plant the old rows — every assertion below is vacuous"
        )

        pid, _ = pp.import_project(db_session, old, tmp_path / "d2", user_id=1)
        db_session.flush()
        assert _scores_for(db_session, pid) == 0

    def test_a_v6_archive_still_imports_everything_else(self, db_session, tmp_path):
        """The drop must not become a refusal for old files."""
        made = _scored_project(db_session)
        v6 = rewrite_as_v6(_export(db_session, made["project"], tmp_path),
                           tmp_path / "old.mmproject")
        pid, _ = pp.import_project(db_session, v6, tmp_path / "d3", user_id=1)
        db_session.flush()
        assert db_session.query(MetricDefinition).filter(
            MetricDefinition.project_id == pid).count() == 2
        assert db_session.query(Dataset).filter(Dataset.project_id == pid).count() == 1


# ── The other half: what the import SAYS ────────────────────────────────────

class TestTheStalenessMarking:

    def test_every_imported_metric_is_marked_out_of_date(self, db_session, tmp_path):
        """🔴 Without this the drop is strictly worse than carrying the rows: a result
        that still claims to be current, with nothing behind it.
        """
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        report: dict = {}
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d4", user_id=1,
                                   import_report=report)
        db_session.flush()

        imported = db_session.query(MetricDefinition).filter(
            MetricDefinition.project_id == pid).all()
        assert imported, "vacuous: nothing was imported"
        assert all(m.stale for m in imported), (
            "an imported metric still says it is current: "
            f"{[(m.name, m.stale) for m in imported]}"
        )
        assert report["metrics_marked_stale"] == 2

    def test_the_source_projects_own_metrics_are_untouched(self, db_session, tmp_path):
        """§x.6 acts on `inserted_ids`, so it can only reach rows this import WROTE."""
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        pp.import_project(db_session, archive, tmp_path / "d5", user_id=1)
        db_session.flush()
        db_session.refresh(made["column_metric"])
        db_session.refresh(made["scale_metric"])
        assert made["column_metric"].stale is False
        assert made["scale_metric"].stale is False

    def test_a_metric_the_backfill_RECOMPUTED_is_left_fresh(self, db_session, tmp_path):
        """The exclusion, exercised on the only axis that reaches it.

        A scale-score metric that arrives STALE is recomputed by the Tier 3 backfill from
        the rows that just landed — by this build, from this data — so it is the one kind
        of imported metric that is genuinely fresh, and marking it would be a marker
        crying wolf (#707b).
        """
        made = _scored_project(db_session, scale_metric_stale=True)
        archive = _export(db_session, made["project"], tmp_path)
        report: dict = {}
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d6", user_id=1,
                                   import_report=report)
        db_session.flush()

        scale = db_session.query(MetricDefinition).filter(
            MetricDefinition.project_id == pid,
            MetricDefinition.metric_type == "domain_aggregate",
        ).one()
        column = db_session.query(MetricDefinition).filter(
            MetricDefinition.project_id == pid,
            MetricDefinition.metric_type == "mean",
        ).one()
        assert scale.stale is False, (
            "the backfill recomputed this metric during the import and §x.6 then declared "
            "it out of date anyway"
        )
        assert column.stale is True, "the non-domain metric must still be marked"
        assert report["metrics_marked_stale"] == 1

    def test_a_metric_the_backfill_only_NO_OPPED_is_still_marked(self, db_session,
                                                                 tmp_path):
        """🔴 The defect this change's own first draft shipped, pinned.

        `create_scale_score_metric` returns `(existing, True)` for a metric that is already
        fresh — having computed NOTHING. Reading that return value as "it was computed
        here" excludes it from the marking, and after #958 §6 it has no `RowScore` rows at
        all: a scale score claiming to be current with an empty column behind it.
        """
        made = _scored_project(db_session, scale_metric_stale=False)
        archive = _export(db_session, made["project"], tmp_path)
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d7", user_id=1)
        db_session.flush()

        scale = db_session.query(MetricDefinition).filter(
            MetricDefinition.project_id == pid,
            MetricDefinition.metric_type == "domain_aggregate",
        ).one()
        assert _scores_for(db_session, pid) == 0, "vacuous: scores exist after all"
        assert scale.stale is True

    def test_the_import_does_not_recompute_anything(self, db_session, tmp_path):
        """🔴 The ORDERING hazard, asserted as behaviour rather than as a code comment.

        `create_scale_score_metric` retries a compute on a metric that says it is stale.
        Marking BEFORE the Tier 3 backfill therefore makes every import with a variable
        group recompute every scale score inside the import transaction — 22 s and 165 MB
        on the GSS corpus, unasked for, on a path that must not `commit()` half way. If the
        marking ever moves above §x.5, scores appear here.
        """
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d8", user_id=1)
        db_session.flush()
        assert _scores_for(db_session, pid) == 0

    def test_a_merge_marks_nothing(self, db_session, tmp_path):
        """A merge imports no metrics at all, so it must claim none.

        ⚠️ **MEASURED: this does NOT demonstrate the `inserted_ids` scoping, and saying so
        is the honest form of the claim.** A merge blanks `metric_definitions`, so
        `remap["metric_definitions"]` is empty there too — swapping §x.6's source to
        `remap` leaves all fourteen tests in this file green (mutation-run 2026-09-21).
        The scoping follows #714's rule, which exists because a merge remaps onto rows that
        already existed LOCALLY; what it buys is that this pass stays correct if the
        blanking list ever changes, which is a property no fixture can reach today.
        """
        made = _scored_project(db_session)
        target = made["project"]
        archive = _export(db_session, target, tmp_path)
        report: dict = {}
        merge_report: dict = {}
        pp.import_project(
            db_session, archive, tmp_path / "d9", user_id=1, import_mode="merge",
            target_project_id=target.id, report=merge_report, import_report=report,
        )
        db_session.flush()
        assert report["metrics_marked_stale"] == 0
        db_session.refresh(made["column_metric"])
        assert made["column_metric"].stale is False

    def test_the_count_is_reported_even_when_it_is_zero(self, db_session, tmp_path):
        """A caller must be able to gate on the VALUE, not on the key's presence."""
        bare = Project(name="Bare", user_id=1, project_uuid=str(uuid_module.uuid4()))
        db_session.add(bare)
        db_session.commit()
        archive = _export(db_session, bare, tmp_path, name="bare.mmproject")
        report: dict = {}
        pp.import_project(db_session, archive, tmp_path / "d10", user_id=1,
                          import_report=report)
        assert report["metrics_marked_stale"] == 0

    def test_it_is_optional(self, db_session, tmp_path):
        """Every direct caller in the suite omits it; none of them may break."""
        made = _scored_project(db_session)
        archive = _export(db_session, made["project"], tmp_path)
        pid, _ = pp.import_project(db_session, archive, tmp_path / "d11", user_id=1)
        assert pid
