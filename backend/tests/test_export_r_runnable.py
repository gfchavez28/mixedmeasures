"""#363 — the exported R script must be runnable in R.

Three defects, all fixed:
1. UTF-8 BOM on the .R made R fail to parse ("unexpected input").
2. install.packages() with no CRAN mirror failed under non-interactive R.
3. Ordinal columns become ordered factors, but cor()/cov()/psych::alpha()/
   colMeans()/rowMeans() over factor columns error — a .mm_num() helper now
   coerces factor columns to numeric at every such site.

Strategy: the most robust regression is a *negative* assertion that no numeric
op survives over a raw factor column subset (`<op>(data[`), which holds whether
or not a given section is emitted. We also seed a Cronbach test to guarantee the
alpha site is exercised, and (when Rscript is present) parse the script — which
catches the BOM and any syntax error in the helper/wrapping.
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import io
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.metric import MetricDefinition
from app.models.statistical_test import StatisticalTest
from app.models.materials import MaterialCollection, Material
from app.routers.export_r import export_r_data


async def _export_r_text(project_id, user, db) -> str:
    resp = await export_r_data(project_id=project_id, user=user, db=db)
    chunks = [chunk async for chunk in resp.body_iterator]
    raw = b"".join(chunks if isinstance(chunks[0], bytes) else [c.encode() for c in chunks])
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        rname = next(n for n in zf.namelist() if n.endswith(".R"))
        return zf.read(rname).decode("utf-8")


def _seed(db):
    db.add(Project(id=760, name="R Export Runnable", user_id=1)); db.flush()
    db.add(Dataset(id=760, project_id=760, name="Survey")); db.flush()
    labels = json.dumps(["Low", "Medium", "High"])
    for cid, code in [(7601, "Q1"), (7602, "Q2"), (7603, "Q3")]:
        db.add(DatasetColumn(
            id=cid, dataset_id=760, column_code=code, column_name=code,
            column_text=code, column_type="ordinal", scale_labels=labels,
            sequence_order=cid, display_order=cid,
        ))
    db.flush()
    # 4 rows of data (numeric codes 1..3 in the CSV; factored in the script)
    vals = [[1, 2, 3], [3, 2, 1], [2, 2, 2], [1, 1, 3]]
    for r, row_vals in enumerate(vals, start=1):
        db.add(DatasetRow(id=7600 + r, dataset_id=760)); db.flush()
        for cid, v in zip([7601, 7602, 7603], row_vals):
            db.add(DatasetValue(row_id=7600 + r, column_id=cid,
                                value_text=["Low", "Medium", "High"][v - 1], value_numeric=float(v)))
    db.flush()
    dom = AnalysisDomain(id=7600, project_id=760, name="Engagement", sequence_order=0)
    db.add(dom); db.flush()
    for i, cid in enumerate([7601, 7602, 7603]):
        db.add(AnalysisDomainMember(domain_id=7600, member_type="column", member_id=cid, sequence_order=i))
    # domain_aggregate metric → exercises the colMeans(domain) emission
    db.add(MetricDefinition(
        id=7600, project_id=760, name="Engagement Score", metric_type="domain_aggregate",
        input_source_type="dataset_domain", input_source_id=7600,
        config=json.dumps({"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}),
        origin="human", origin_context="crosswalk_auto", stale=False,
    ))
    # Cronbach test → exercises the psych::alpha emission path
    db.add(StatisticalTest(
        id=7600, project_id=760, test_type="cronbachs_alpha",
        target_type="analysis_domain", target_id=7600, config="{}",
    ))
    # Correlation material → deterministically emits cor(.mm_num(data[, cor_vars]))
    # over ordinal (factored) columns — the originally-reported cov/cor failure.
    coll = MaterialCollection(id=7600, project_id=760, name="Materials"); db.add(coll); db.flush()
    db.add(Material(
        id=7600, collection_id=7600, material_type="correlation",
        config=json.dumps({"column_ids": [7601, 7602, 7603], "corr_type": "pearson"}),
        auto_name="Item correlations", source_tab="correlations", display_order=0,
    ))
    db.flush()
    return db.query(User).filter(User.id == 1).one()


def _build(db):
    user = _seed(db)
    return asyncio.run(_export_r_text(760, user, db))


class TestExportRRunnable:
    def test_no_bom(self, db_session):
        r = _build(db_session)
        assert not r.startswith("﻿")          # #363 defect 1
        assert r.lstrip()[0] == "#"                  # starts with a comment header

    def test_sets_cran_mirror(self, db_session):
        assert "options(repos" in _build(db_session)  # #363 defect 2

    def test_defines_numeric_coercion_helper(self, db_session):
        assert ".mm_num <- function" in _build(db_session)  # #363 defect 3

    def test_no_unwrapped_numeric_ops_over_factor_columns(self, db_session):
        r = _build(db_session)
        # No numeric op may operate directly on a raw `data[` factor subset.
        for op in ("colMeans(data[", "psych::alpha(data[", "cor(data[",
                   "psych::corr.test(data[", "rowMeans(data["):
            assert op not in r, f"unwrapped numeric op survived: {op}"

    def test_emitted_numeric_op_is_wrapped(self, db_session):
        # The correlation material deterministically emits a cor() over ordinal
        # (factored) columns; it must be coerced via .mm_num (positive proof the
        # wrap is actually applied at an emission site, not just defined).
        r = _build(db_session)
        assert "cor(.mm_num(data[" in r

    def test_codebook_comment_labels_usage_counts(self, db_session):
        """#511: the codebook comment reports USAGE counts (facilitator
        applications and dataset-value/response targets count), which is NOT
        the Codebook view's facilitator-excluded segment count — label it
        "uses" per the #500 wording, never "seg"/"segments".
        """
        from app.models.conversation import Conversation
        from app.models.segment import Segment
        from app.models.code import Code
        from app.models.code_application import CodeApplication

        db = db_session
        user = _seed(db)
        db.add(Conversation(id=760, project_id=760, name="Conv")); db.flush()
        db.add(Segment(id=76001, conversation_id=760, sequence_order=0, text="hello"))
        db.add(Code(id=7600, project_id=760, numeric_id=2, name="Access barriers",
                    is_universal=False, is_active=True))
        db.flush()
        dv = db.query(DatasetValue).first()
        db.add(CodeApplication(segment_id=76001, code_id=7600, user_id=1))
        db.add(CodeApplication(dataset_value_id=dv.id, code_id=7600, user_id=1))
        db.flush()

        r = asyncio.run(_export_r_text(760, user, db))
        codebook = r[r.index("---- Codebook"):]
        # 1 segment + 1 response target = 2 uses
        assert "Access barriers (2 uses)" in codebook
        assert " seg)" not in codebook
        assert "segments)" not in codebook

    def test_script_parses_in_R(self, db_session):
        rscript = shutil.which("Rscript")
        if not rscript:
            import pytest
            pytest.skip("Rscript not available")
        r = _build(db_session)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "setup.R"
            path.write_text(r, encoding="utf-8")
            # parse-only: needs neither CRAN nor the data CSV; catches the BOM
            # (R errors "unexpected input") and any syntax error in the wrapping.
            proc = subprocess.run(
                [rscript, "-e", f'invisible(parse("{path.as_posix()}"))'],
                capture_output=True, text=True, timeout=60,
            )
            assert proc.returncode == 0, f"R failed to parse script:\n{proc.stderr}"
