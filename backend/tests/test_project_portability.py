"""Tests for project portability (export/import) and codebook exchange."""

import io
import json
import os
import re
import tempfile
import uuid as uuid_module
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

# Safety guard: ensure in-memory DB
os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models import (
    AnalysisDomain,
    AnalysisDomainMember,
    Canvas,
    CanvasPendingItem,
    CanvasTheme,
    CanvasThemeRelationship,
    Code,
    CodeApplication,
    CodeCategory,
    TextCodingConfig,
    ComputedResult,
    Conversation,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
    Document,
    EquivalenceGroup,
    Excerpt,
    Material,
    MaterialCollection,
    Memo,
    MetricDefinition,
    Note,
    Observation,
    Participant,
    Project,
    QuoteBoardConfig,
    RecodeDefinition,
    RowScore,
    ScratchpadEntry,
    Segment,
    SegmentGroup,
    Speaker,
    StatisticalTest,
)
from app.services.project_portability import (
    MergeDivergenceError,
    _assert_merge_compatible,
    export_project,
    import_project,
    validate_project_file,
)
from app.services.codebook_exchange import (
    LEGACY_QDC_NAMESPACE,
    MAX_QDC_DEPTH,
    QDC_NAMESPACE,
    EmptyCodebookError,
    export_codebook_native,
    export_codebook_qdc,
    import_codebook_native,
    import_codebook_qdc,
)


@pytest.fixture
def db_session():
    """Per-test empty database session."""
    from app.database import Base, engine, SessionLocal
    from app.models.user import User
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    test_user = User(id=1, username="testuser", password_hash="x", is_admin=True)
    db.add(test_user)
    db.flush()
    try:
        yield db
    finally:
        db.rollback()
        db.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture
def populated_project(db_session: Session):
    """Create a project with all entity types populated for round-trip testing."""
    db = db_session

    # Project
    project = Project(name="Test Project", description="Test desc", status="active", user_id=1)
    db.add(project)
    db.flush()
    pid = project.id

    # Participant
    p1 = Participant(project_id=pid, identifier="P001", display_name="Alice", role="board")
    db.add(p1)
    db.flush()

    # Speaker
    s1 = Speaker(
        project_id=pid, name="Alice", is_facilitator=0,
        color_index=0, color="#ff0000", participant_id=p1.id,
    )
    db.add(s1)
    db.flush()

    # Conversation
    conv = Conversation(project_id=pid, name="Interview 1", status="completed")
    db.add(conv)
    db.flush()

    # Document
    doc = Document(
        project_id=pid, name="Report.pdf", source_filename="report.pdf",
        source_format="pdf", segmentation_mode="paragraph",
    )
    db.add(doc)
    db.flush()

    # Observation (Observations track — a recording coded on its own timeline)
    obs = Observation(
        project_id=pid, name="Classroom session 1",
        description="Period 3, small-group work",
        media_filename="session1.mp4", media_format="mp4", media_type="video",
        media_duration_seconds=600.0, media_offset_seconds=0.0, media_is_vbr=False,
    )
    db.add(obs)
    db.flush()

    # SegmentGroup
    sg = SegmentGroup(conversation_id=conv.id)
    db.add(sg)
    db.flush()

    # Segments (with self-refs for merge/split)
    seg1 = Segment(
        conversation_id=conv.id, speaker_id=s1.id, group_id=sg.id,
        sequence_order=0, text="Hello world", word_count=2,
    )
    seg2 = Segment(
        conversation_id=conv.id, speaker_id=s1.id,
        sequence_order=1, text="Merged segment", word_count=2,
        is_merge_result=1,
    )
    doc_seg = Segment(
        document_id=doc.id, sequence_order=0, text="Document text",
        word_count=2, page_number=1,
    )
    # Observation (the THIRD Segment parent) + a clip on its timeline. Deliberately
    # carries an attached recording so the media arcname (`media/obs-{id}/…`) and the
    # orphan-metadata clearing pass are exercised by the shared round-trip tests.
    obs_seg = Segment(
        observation_id=obs.id, sequence_order=0, text="Small-group transition",
        word_count=3, start_time=12.5, end_time=48.25,
    )
    db.add_all([seg1, seg2, doc_seg, obs_seg])
    db.flush()

    # Set self-ref: seg1 merged into seg2
    seg1.merged_into_id = seg2.id
    db.flush()

    # CodeCategory (nested)
    cat1 = CodeCategory(project_id=pid, name="Theme A", color="#3b82f6", display_order=0)
    db.add(cat1)
    db.flush()
    cat2 = CodeCategory(
        project_id=pid, name="Sub A", color="#6366f1",
        display_order=1, parent_id=cat1.id,
    )
    db.add(cat2)
    db.flush()

    # Codes
    code1 = Code(
        project_id=pid, numeric_id=0, name="Unsubstantive",
        color="#9ca3af", is_universal=True, is_active=True,
    )
    code2 = Code(
        project_id=pid, numeric_id=2, name="Leadership",
        color="#ef4444", category_id=cat2.id, category_order=0,
    )
    code3 = Code(
        project_id=pid, numeric_id=3, name="Inactive Code",
        color="#aaaaaa", is_active=False,
    )
    db.add_all([code1, code2, code3])
    db.flush()

    # CodeApplications
    ca1 = CodeApplication(segment_id=seg1.id, code_id=code2.id, user_id=None)
    # A code on an observation CLIP — this is the row that vanished from every
    # export before the segments gather learned the third parent.
    ca_obs = CodeApplication(segment_id=obs_seg.id, code_id=code2.id, user_id=None)
    db.add_all([ca1, ca_obs])
    db.flush()

    # Dataset
    ds = Dataset(project_id=pid, name="Survey", source="LimeSurvey")
    db.add(ds)
    db.flush()

    # EquivalenceGroup
    eg = EquivalenceGroup(project_id=pid, label="Q1 equiv", sequence_order=0)
    db.add(eg)
    db.flush()

    # DatasetColumn
    col1 = DatasetColumn(
        dataset_id=ds.id, column_name="Q1", column_text="Rate leadership",
        column_type="ordinal", sequence_order=0, display_order=0,
        equivalence_group_id=eg.id,
    )
    col2 = DatasetColumn(
        dataset_id=ds.id, column_name="Comments", column_text="Open response",
        column_type="open_text", sequence_order=1, display_order=1,
    )
    db.add_all([col1, col2])
    db.flush()

    # Computed column (depends on col1)
    col_comp = DatasetColumn(
        dataset_id=ds.id, column_name="C1", column_text="Doubled Q1",
        column_type="numeric", sequence_order=2, display_order=2,
        source="computed", expression="[Q1] * 2",
        depends_on_column_ids=json.dumps([col1.id]),
    )
    db.add(col_comp)
    db.flush()

    # DatasetRow
    row1 = DatasetRow(dataset_id=ds.id, participant_id=p1.id, row_identifier="R001")
    db.add(row1)
    db.flush()

    # DatasetValues
    val1 = DatasetValue(row_id=row1.id, column_id=col1.id, value_text="4", value_numeric=4.0)
    val2 = DatasetValue(row_id=row1.id, column_id=col2.id, value_text="Great leadership")
    val_comp = DatasetValue(row_id=row1.id, column_id=col_comp.id, value_text="8", value_numeric=8.0)
    db.add_all([val1, val2, val_comp])
    db.flush()

    # CodeApplication on comment
    ca2 = CodeApplication(dataset_value_id=val2.id, code_id=code2.id)
    db.add(ca2)
    db.flush()

    # RecodeDefinition
    recode = RecodeDefinition(
        column_id=col1.id, name="Scale Map",
        recode_type="scale_map", output_type="numeric",
        mapping='{"4": 4}', is_primary=True,
    )
    db.add(recode)
    db.flush()

    # Excerpt
    exc = Excerpt(project_id=pid, segment_id=seg1.id)
    db.add(exc)
    db.flush()

    # Time-range excerpt on the observation clip (slab 5, D29). POPULATED times
    # on purpose — the columns ride export/import by reflection, so a NULL→NULL
    # round-trip would certify nothing (the degenerate-fixture rule).
    time_exc = Excerpt(
        project_id=pid, segment_id=obs_seg.id, start_time=20.0, end_time=31.5,
    )
    db.add(time_exc)
    db.flush()

    # Note (on conversation, with excerpt)
    note1 = Note(
        conversation_id=conv.id, segment_id=seg1.id, excerpt_id=exc.id,
        content="Important quote", sequence_number=1,
    )
    # Note on document
    note2 = Note(
        document_id=doc.id, segment_id=doc_seg.id,
        content="Doc note", sequence_number=0,
    )
    # Note on comment
    note3 = Note(
        dataset_value_id=val2.id,
        content="Comment note", sequence_number=0,
    )
    # Note on an observation clip (Note's third parent FK)
    note4 = Note(
        observation_id=obs.id, segment_id=obs_seg.id,
        content="Teacher circulates here", sequence_number=0,
    )
    db.add_all([note1, note2, note3, note4])
    db.flush()

    # Memos across multiple entity types
    memo_project = Memo(
        project_id=pid, numeric_id=1, entity_type="project",
        entity_id=pid, title="Project Memo", content="Reflections",
    )
    memo_conv = Memo(
        project_id=pid, numeric_id=2, entity_type="conversation",
        entity_id=conv.id, title="Conv Memo", content="Insights",
    )
    memo_doc = Memo(
        project_id=pid, numeric_id=3, entity_type="document",
        entity_id=doc.id, title="Doc Memo", content="Analysis",
    )
    memo_code = Memo(
        project_id=pid, numeric_id=4, entity_type="code",
        entity_id=code2.id, title="Code Memo", content="Definition",
    )
    memo_cat = Memo(
        project_id=pid, numeric_id=5, entity_type="code_category",
        entity_id=cat1.id, title="Cat Memo", content="Theme notes",
    )
    memo_ds = Memo(
        project_id=pid, numeric_id=6, entity_type="dataset",
        entity_id=ds.id, title="DS Memo", content="Data notes",
    )
    # Memo on an observation. Memo.entity_id has NO ForeignKey, so an entity_type
    # missing from MEMO_ENTITY_REMAP is copied verbatim and silently points at a
    # foreign row — this memo is what makes that regression visible.
    memo_obs = Memo(
        project_id=pid, numeric_id=9, entity_type="observation",
        entity_id=obs.id, title="Obs Memo", content="Session context",
    )
    db.add_all([memo_project, memo_conv, memo_doc, memo_code, memo_cat, memo_ds, memo_obs])
    db.flush()

    # AnalysisDomain
    domain = AnalysisDomain(project_id=pid, name="Leadership Domain", sequence_order=0)
    db.add(domain)
    db.flush()

    # AnalysisDomainMember
    adm = AnalysisDomainMember(
        domain_id=domain.id, member_type="column",
        member_id=col1.id, sequence_order=0,
    )
    db.add(adm)
    db.flush()

    # MetricDefinition
    metric = MetricDefinition(
        project_id=pid, name="Q1 Freq", metric_type="frequency_distribution",
        config="{}",
        input_source_type="dataset_column", input_source_id=col1.id,
        grouping_column_id=None, sequence_order=0,
    )
    db.add(metric)
    db.flush()

    # Tier 3 crosswalk auto scale-score metric for Leadership Domain.
    # Must match what `services/metrics.py::create_scale_score_metric` would
    # create on a fresh domain — same origin/origin_context/config/stale
    # values — so the portability backfill is a no-op on roundtrip import.
    # If this is missing, the backfill creates it on first import and the
    # roundtrip-fidelity test fails on entity-count mismatch.
    scale_metric = MetricDefinition(
        project_id=pid,
        name=f"{domain.name} Score",
        metric_type="domain_aggregate",
        config='{"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}',
        input_source_type="dataset_domain",
        input_source_id=domain.id,
        grouping_column_id=None,
        grouping_column_id_2=None,
        sequence_order=1,
        origin="human",
        origin_context="crosswalk_auto",
        stale=False,
    )
    db.add(scale_metric)
    db.flush()

    # ComputedResult
    cr = ComputedResult(
        metric_definition_id=metric.id, result_data='{"bins": [1,2,3]}',
        valid_n=10, total_n=10,
    )
    db.add(cr)
    db.flush()

    # RowScore
    rs = RowScore(
        metric_definition_id=metric.id, dataset_row_id=row1.id, score=4.0,
    )
    db.add(rs)
    db.flush()

    # StatisticalTest
    st = StatisticalTest(
        project_id=pid, test_type="cronbachs_alpha",
        target_type="analysis_domain", target_id=domain.id,
        result_data='{"alpha": 0.85}',
    )
    db.add(st)
    db.flush()

    # MaterialCollection + Material
    collection = MaterialCollection(project_id=pid, name="Default", display_order=0)
    db.add(collection)
    db.flush()

    mat = Material(
        collection_id=collection.id, material_type="horizontal_bar",
        config=json.dumps({"column_ids": [col1.id], "domain_ids": [], "grouping_column_id": None}),
        auto_name="Q1 Freq", display_order=0, source_tab="descriptives",
    )
    db.add(mat)
    db.flush()

    # Memo on material (analysis type)
    memo_analysis = Memo(
        project_id=pid, numeric_id=7, entity_type="analysis",
        entity_id=mat.id, title="Analysis Memo", content="Chart notes",
    )
    db.add(memo_analysis)
    db.flush()

    # ScratchpadEntry
    scratch = ScratchpadEntry(
        project_id=pid, numeric_id=1, content="Quick thought",
    )
    db.add(scratch)
    db.flush()

    # TextCodingConfig
    cvc = TextCodingConfig(
        project_id=pid, view_mode="by_text",
        focal_column_ids=json.dumps([col2.id]),
        dataset_filter_ids=json.dumps([ds.id]),
        starred_value_ids=json.dumps([val2.id]),
        context_visibility=json.dumps({"demographics": True}),
        treat_as_empty=json.dumps(["N/A"]),
    )
    db.add(cvc)
    db.flush()

    # QuoteBoardConfig
    qbc = QuoteBoardConfig(
        project_id=pid,
        custom_orders=json.dumps({
            f"code-{code2.id}": [exc.id],
            "all": [exc.id],
        }),
    )
    db.add(qbc)
    db.flush()

    # Canvas + Themes + Relationships + Pending Items
    canvas = Canvas(project_id=pid, name="Analysis Canvas", display_order=1)
    db.add(canvas)
    db.flush()

    canvas_theme1 = CanvasTheme(
        canvas_id=canvas.id, name="Main Theme", color="#3b82f6",
        doc_order=100, table_column_order=100,
    )
    canvas_theme2 = CanvasTheme(
        canvas_id=canvas.id, name="Sub Theme",
        doc_order=200, table_column_order=200,
    )
    db.add_all([canvas_theme1, canvas_theme2])
    db.flush()

    # Theme prose content (Batch A: Tiptap JSON on theme)
    import json as _json
    canvas_theme1.content = _json.dumps({
        "type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Theme prose"}]},
            {"type": "excerpt-embed", "attrs": {"excerptId": exc.id, "displayText": "quote"}},
            {"type": "chart-embed", "attrs": {"materialId": mat.id, "title": "Q1 Freq"}},
            {"type": "memo-embed", "attrs": {"memoId": memo_analysis.id, "title": "Analysis Memo"}},
        ],
    })
    canvas_theme1.searchable_text = "Theme prose quote"
    canvas_theme1.referenced_source_ids = _json.dumps([
        {"type": "excerpt", "id": exc.id},
        {"type": "material", "id": mat.id},
        {"type": "memo", "id": memo_analysis.id},
    ])
    db.flush()

    # Pending items
    pending1 = CanvasPendingItem(canvas_id=canvas.id, item_type="excerpt", source_id=exc.id)
    pending2 = CanvasPendingItem(canvas_id=canvas.id, item_type="material", source_id=mat.id)
    db.add_all([pending1, pending2])
    db.flush()

    # Theme relationship
    canvas_rel = CanvasThemeRelationship(
        canvas_id=canvas.id, source_theme_id=canvas_theme1.id,
        target_theme_id=canvas_theme2.id,
        relationship_type="confirms", label="Strong link",
    )
    db.add(canvas_rel)
    db.flush()

    # Canvas memo
    memo_canvas = Memo(
        project_id=pid, numeric_id=8, entity_type="canvas",
        entity_id=canvas.id, title="Canvas Memo", content="Integration notes",
    )
    db.add(memo_canvas)
    db.flush()

    return {
        "project": project,
        "participant": p1,
        "speaker": s1,
        "conversation": conv,
        "document": doc,
        "observation": obs,
        "segment_group": sg,
        "segments": [seg1, seg2, doc_seg, obs_seg],
        "obs_segment": obs_seg,
        "categories": [cat1, cat2],
        "codes": [code1, code2, code3],
        "dataset": ds,
        "col1": col1,
        "columns": [col1, col2, col_comp],
        "rows": [row1],
        "values": [val1, val2, val_comp],
        "recode": recode,
        "excerpt": exc,
        "notes": [note1, note2, note3, note4],
        "memos": [memo_project, memo_conv, memo_doc, memo_code, memo_cat, memo_ds, memo_obs, memo_analysis, memo_canvas],
        "domain": domain,
        "domain_member": adm,
        "metric": metric,
        "computed_result": cr,
        "row_score": rs,
        "statistical_test": st,
        "collection": collection,
        "material": mat,
        "scratchpad": scratch,
        "text_coding_config": cvc,
        "quote_board_config": qbc,
        "equivalence_group": eg,
        "canvas": canvas,
        "canvas_themes": [canvas_theme1, canvas_theme2],
        "canvas_relationship": canvas_rel,
    }


# ── Export tests ────────────────────────────────────────────────────────

class TestExportProject:

    def test_export_basic(self, db_session, populated_project):
        """Export produces a ZIP with manifest.json and project.json."""
        pid = populated_project["project"].id
        buf = export_project(db_session, pid, Path("/nonexistent"))
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            assert "manifest.json" in names
            assert "project.json" in names

            manifest = json.loads(zf.read("manifest.json"))
            assert manifest["format_type"] == "mmproject"
            assert manifest["project_name"] == "Test Project"
            assert manifest["project_summary"]["conversation_count"] == 1
            assert manifest["project_summary"]["document_count"] == 1
            assert manifest["project_summary"]["code_count"] == 3
            assert manifest["project_summary"]["category_count"] == 2
            assert manifest["project_summary"]["canvas_count"] == 1
            assert manifest["project_summary"]["canvas_theme_count"] == 2

    def test_export_all_entities(self, db_session, populated_project):
        """All entity arrays are populated in project.json."""
        pid = populated_project["project"].id
        buf = export_project(db_session, pid, Path("/nonexistent"))
        with zipfile.ZipFile(buf, "r") as zf:
            data = json.loads(zf.read("project.json"))

        assert len(data["participants"]) == 1
        assert len(data["speakers"]) == 1
        assert len(data["conversations"]) == 1
        assert len(data["documents"]) == 1
        assert len(data["observations"]) == 1
        # 2 conversation + 1 document + 1 observation clip. Segment has no
        # project_id, so it is gathered per-parent — a parent without a branch in
        # the export gather is silent data loss.
        assert len(data["segments"]) == 4
        assert len(data["code_categories"]) == 2
        assert len(data["codes"]) == 3
        assert len(data["code_applications"]) == 3  # incl. the code on the clip
        assert len(data["notes"]) == 4              # incl. the observation note
        assert len(data["memos"]) == 9              # incl. the observation memo
        assert len(data["excerpts"]) == 2  # whole-segment + the clip time-range
        assert len(data["datasets"]) == 1
        assert len(data["dataset_columns"]) == 3
        assert len(data["dataset_rows"]) == 1
        assert len(data["dataset_values"]) == 3
        assert data["text_coding_config"] is not None
        assert data["quote_board_config"] is not None
        # Canvas entities
        assert len(data["canvases"]) == 1
        assert len(data["canvas_themes"]) == 2
        assert len(data["canvas_theme_relationships"]) == 1
        assert len(data["canvas_pending_items"]) == 2
        # Theme prose content survives export
        theme_data = data["canvas_themes"][0]
        assert theme_data.get("content") is not None
        assert theme_data.get("searchable_text") is not None

    def test_export_includes_documents(self, db_session, populated_project, tmp_path):
        """Document files on disk are included in the ZIP."""
        pid = populated_project["project"].id
        doc_id = populated_project["document"].id

        # Create mock document files
        doc_dir = tmp_path / str(pid) / str(doc_id)
        doc_dir.mkdir(parents=True)
        (doc_dir / "original.pdf").write_text("fake pdf")
        images_dir = doc_dir / "images"
        images_dir.mkdir()
        (images_dir / "0.png").write_bytes(b"\x89PNG")
        (images_dir / "positions.json").write_text('{"0": {"page": 1}}')

        buf = export_project(db_session, pid, tmp_path)
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            assert f"documents/{doc_id}/original.pdf" in names
            assert f"documents/{doc_id}/images/0.png" in names
            assert f"documents/{doc_id}/images/positions.json" in names

    def test_export_missing_docs_no_error(self, db_session, populated_project):
        """Export succeeds even when document files are missing from disk."""
        pid = populated_project["project"].id
        buf = export_project(db_session, pid, Path("/nonexistent"))
        assert buf.getbuffer().nbytes > 0


# ── Validation tests ───────────────────────────────────────────────────

class TestValidateProject:

    def test_validate_valid_file(self, db_session, populated_project, tmp_path):
        pid = populated_project["project"].id
        buf = export_project(db_session, pid, Path("/nonexistent"))
        file_path = tmp_path / "test.mmproject"
        file_path.write_bytes(buf.getvalue())

        result = validate_project_file(file_path)
        assert result["manifest"]["format_type"] == "mmproject"
        assert len(result["warnings"]) == 0

    def test_validate_bad_zip(self, tmp_path):
        file_path = tmp_path / "bad.mmproject"
        file_path.write_text("not a zip")
        with pytest.raises(ValueError, match="not a valid ZIP"):
            validate_project_file(file_path)

    def test_validate_missing_manifest(self, tmp_path):
        file_path = tmp_path / "no_manifest.mmproject"
        with zipfile.ZipFile(file_path, "w") as zf:
            zf.writestr("project.json", "{}")
        with pytest.raises(ValueError, match="missing manifest.json"):
            validate_project_file(file_path)

    def test_validate_future_version(self, tmp_path):
        """Files with higher format_version are rejected."""
        file_path = tmp_path / "future.mmproject"
        manifest = {"format_version": 999, "format_type": "mmproject", "app_version": "9.0.0"}
        with zipfile.ZipFile(file_path, "w") as zf:
            zf.writestr("manifest.json", json.dumps(manifest))
            zf.writestr("project.json", "{}")
        with pytest.raises(ValueError, match="newer version"):
            validate_project_file(file_path)


class TestImportZipSlipGuard:
    """A crafted .mmproject whose member name escapes the extraction root must
    be refused BEFORE anything is written to disk.

    import_project builds on-disk target paths (docs + media copies) from
    archive member names, so a member like ``media/1/../../../x`` or an absolute
    ``/x`` would otherwise let a shared .mmproject write outside the project's
    data dir. The guard lives in import_project ITSELF (not only in
    validate_project_file) because scripts and direct API calls skip
    /validate-import — the exact same reason the format-version gate is enforced
    there (see _read_manifest_and_check_format's docstring / the
    .mmproject-gate rule in the internal design notes). This test is the
    fail-closed guard on the guard: it existed untested, so a future refactor
    could silently drop it. Two guard arms: parent-traversal and absolute path.
    """

    def _minimal_evil(self, path: Path, member: str) -> None:
        """A hand-built .mmproject carrying only a malicious member — enough to
        prove the namelist scan rejects it (validate path)."""
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("manifest.json", json.dumps(
                {"format_type": "mmproject", "format_version": 1, "app_version": "1.0.0"}))
            zf.writestr("project.json", json.dumps(
                {"project": {"name": "evil", "uuid": "00000000-0000-0000-0000-000000000001"}}))
            zf.writestr(member, b"PWNED-BY-ZIPSLIP")

    def _tampered_export(self, db, pid: int, out_path: Path, member: str, tmp_path: Path) -> None:
        """A VALID exported .mmproject with one malicious member spliced in.

        Non-vacuity matters here: the escape assertion is only meaningful if,
        absent the guard, execution actually REACHES the media-copy phase and
        writes the sentinel. A hand-built minimal file crashes in DB import
        first (nothing to copy), so mutation-removing the guard would let the
        test 'pass' for the wrong reason. Splicing the member into a real export
        — keyed to a conversation id that survives into the import remap — means
        a guard-less import runs to the copy phase and the sentinel escapes.
        """
        buf = export_project(db, pid, tmp_path / "export_docs")
        base = tmp_path / "base.mmproject"
        base.write_bytes(buf.getvalue())
        with zipfile.ZipFile(base, "r") as zin, zipfile.ZipFile(out_path, "w") as zout:
            for item in zin.namelist():
                zout.writestr(item, zin.read(item))
            zout.writestr(member, b"PWNED-BY-ZIPSLIP")

    def test_validate_rejects_traversal(self, tmp_path):
        file_path = tmp_path / "evil.mmproject"
        self._minimal_evil(file_path, "media/1/../../../ESCAPED.txt")
        with pytest.raises(ValueError, match="suspicious path"):
            validate_project_file(file_path)

    def test_import_rejects_and_writes_nothing_outside(self, db_session, populated_project, tmp_path):
        """The security assertion: the guard fires AND no file escapes.

        The traversal member is keyed to the exported conversation's real id so
        that, without the guard, the media-copy loop would remap it and write
        the sentinel OUTSIDE the project media dir (into tmp_path). With the
        guard, import raises before any DB or file work. Mutation-verified: both
        assertions fail when either guard is removed.
        """
        pid = populated_project["project"].id
        conv = db_session.query(Conversation).filter(Conversation.project_id == pid).first()

        media_dir = tmp_path / "data" / "media"
        docs_dir = tmp_path / "data" / "documents"
        media_dir.mkdir(parents=True)
        docs_dir.mkdir(parents=True)
        escape_sentinel = tmp_path / "ESCAPED.txt"

        # Escape relative to where THIS member would land: media/<pid>/<conv>/…
        member = f"media/{conv.id}/../../../../ESCAPED.txt"
        file_path = tmp_path / "evil.mmproject"
        self._tampered_export(db_session, pid, file_path, member, tmp_path)

        # Decoupled so BOTH properties are independently exercised: a mutation
        # that drops the guard must trip the containment assertion (the file
        # escapes) regardless of the raise. Asserting only via pytest.raises
        # would let the escape check go unrun (it fails at the raise first).
        raised = False
        try:
            import_project(db_session, file_path, docs_dir, media_dir, user_id=1)
        except ValueError as e:
            raised = "suspicious path" in str(e)
        assert not escape_sentinel.exists(), (
            "SECURITY: a traversal member escaped the project media directory")
        assert raised, "guard did not raise 'suspicious path'"


class TestChunkedMemberCopy:
    """#567: media files (up to 4 GB) must stream to disk in chunks, never be
    read whole into RAM. _extract_zip_member is the single copy path for docs +
    media + canvas. A payload larger than the 1 MiB chunk exercises multiple
    copyfileobj iterations, so byte-identity here proves the chunk boundaries
    are handled — a tiny payload (like the docs round-trip fixture) can't."""

    def test_extract_is_byte_identical_across_chunk_boundaries(self, tmp_path):
        from app.services.project_portability import _extract_zip_member

        # 1.5 MiB → one full 1 MiB chunk + a partial remainder
        payload = (b"MixedMeasures" * 121_000)[:1_500_000]
        assert len(payload) > 1024 * 1024

        archive = tmp_path / "big.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("media/1/original.mp4", payload)

        base = tmp_path / "out"
        target = base / "nested" / "original.mp4"
        with zipfile.ZipFile(archive, "r") as zf:
            _extract_zip_member(zf, "media/1/original.mp4", target, base)

        assert target.exists()
        assert target.read_bytes() == payload


class TestImportedMediaNumbersAreBounded:
    """#625 sibling: `_build_entity` copies media numbers straight from the JSON.

    An imported duration/offset passes through NONE of the guards the live paths
    enforce — `sane_duration` on the probe, `MediaOffsetUpdate`'s ±300 on the API.
    And `.mmproject` is an interchange format users hand each other (the
    distribute-and-merge workflow), so "the file is ours" is not a safety
    argument; it is the same reasoning that makes the format gate and the
    zip-slip scan run INSIDE `import_project` rather than trusting the UI.

    The inf case is a CRASH, not a cosmetic: `cut_clips` guards
    `is None or <= 0`, which inf passes (inf > 0) and NaN passes
    (NaN <= 0 is False), reaching `math.ceil` as an OverflowError.
    """

    def _import_with_patched_media(self, db, pid, patch):
        """Export, rewrite the archive's media numbers, re-import."""
        buf = export_project(db, pid, Path("/nonexistent"))
        with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
            names = zf.namelist()
            blobs = {n: zf.read(n) for n in names}
        data = json.loads(blobs["project.json"])
        for key in ("conversations", "observations"):
            for row in data.get(key, []):
                patch(row)
        # `allow_nan=True` is the default and is the point — Python's json
        # EMITS and ACCEPTS bare Infinity/NaN, which is how the value survives
        # a round-trip through a file at all.
        blobs["project.json"] = json.dumps(data).encode()

        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as zf:
            for n in names:
                zf.writestr(n, blobs[n])
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(out.getvalue())
            tmp.close()
            new_id, _ = import_project(
                db, Path(tmp.name), Path("/tmp/docs_test"), user_id=1,
            )
            db.flush()
            return new_id
        finally:
            os.unlink(tmp.name)

    def _durations(self, db, pid):
        return [
            o.media_duration_seconds
            for model in (Conversation, Observation)
            for o in db.query(model).filter(model.project_id == pid).all()
        ]

    def test_an_infinite_duration_does_not_survive_the_import(self, db_session, populated_project):
        db = db_session
        new_pid = self._import_with_patched_media(
            db, populated_project["project"].id,
            lambda row: row.__setitem__("media_duration_seconds", float("inf")),
        )
        assert all(d is None for d in self._durations(db, new_pid))

    def test_a_nan_duration_is_neutralised_by_STORAGE_not_by_the_guard(self, db_session, populated_project):
        """⚠️ This one passes with the sanitizer REMOVED — verified by mutation.

        SQLite has no NaN representation for REAL and silently stores it as
        NULL (measured: `inf` round-trips as `inf`, `1e12` as `1e12`, `nan` as
        `None`). So from THIS door NaN was never the live risk — **inf was**, and
        it persists faithfully. Kept, labelled, because the asymmetry is the
        useful fact: a future reader must not conclude the guard is what handles
        NaN here, nor that "we tested NaN" means this path is proven.
        """
        db = db_session
        new_pid = self._import_with_patched_media(
            db, populated_project["project"].id,
            lambda row: row.__setitem__("media_duration_seconds", float("nan")),
        )
        assert all(d is None for d in self._durations(db, new_pid))

    def test_an_absurd_finite_duration_does_not_survive_the_import(self, db_session, populated_project):
        """The value a `[inf, nan]`-only fixture would miss."""
        db = db_session
        new_pid = self._import_with_patched_media(
            db, populated_project["project"].id,
            lambda row: row.__setitem__("media_duration_seconds", 1e12),
        )
        assert all(d is None for d in self._durations(db, new_pid))

    def test_a_real_duration_is_preserved(self, db_session, populated_project):
        """The sanitizer must not be a filter that eats legitimate values."""
        db = db_session
        new_pid = self._import_with_patched_media(
            db, populated_project["project"].id,
            lambda row: row.__setitem__("media_duration_seconds", 612.5),
        )
        assert self._durations(db, new_pid) and all(
            d == pytest.approx(612.5) for d in self._durations(db, new_pid)
        )

    def test_an_out_of_range_offset_is_reset_to_aligned(self, db_session, populated_project):
        """An import must not accept what `MediaOffsetUpdate` refuses (±300 s)."""
        db = db_session
        new_pid = self._import_with_patched_media(
            db, populated_project["project"].id,
            lambda row: row.__setitem__("media_offset_seconds", 99999.0),
        )
        offsets = [
            o.media_offset_seconds
            for model in (Conversation, Observation)
            for o in db.query(model).filter(model.project_id == new_pid).all()
        ]
        assert offsets and all(o == 0.0 for o in offsets)

    def test_a_legitimate_offset_is_preserved(self, db_session, populated_project):
        db = db_session
        new_pid = self._import_with_patched_media(
            db, populated_project["project"].id,
            lambda row: row.__setitem__("media_offset_seconds", -12.5),
        )
        offsets = [
            o.media_offset_seconds
            for model in (Conversation, Observation)
            for o in db.query(model).filter(model.project_id == new_pid).all()
        ]
        assert offsets and all(o == pytest.approx(-12.5) for o in offsets)


class TestObservationPortability:
    """Observations track: the third Segment parent must survive .mmproject.

    Segment and Note have NO project_id — they are gathered through their parents,
    so a parent the export gather doesn't know about is SILENT data loss (the clip,
    every code on it, and its notes simply never leave the project). And because
    `_build_entity` copies any column the import doesn't explicitly remap, the
    inverse failure is worse than loss: the source instance's raw observation_id
    gets written into THIS database, attaching the clip to an unrelated project's
    observation (or dying on an opaque IntegrityError).

    The shared `populated_project` fixture carries an Observation + a coded clip +
    a note + a memo, so the generic round-trip tests (notably `test_roundtrip_
    fidelity`, which walks every key in project.json) cover observations too. This
    class pins what the shared fixture cannot reach: the on-disk media namespace,
    the merge posture, and the polymorphic memo remap.
    """

    def _export_import(self, db, pid, media_dir=None):
        buf = export_project(db, pid, Path("/nonexistent"), media_dir=media_dir)
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(buf.getvalue())
            tmp.close()
            new_id, _ = import_project(
                db, Path(tmp.name), Path("/tmp/docs_test"),
                media_dir=media_dir, user_id=1,
            )
            db.flush()
            return new_id
        finally:
            os.unlink(tmp.name)

    def test_manifest_observation_count_survives_the_response_schema(self):
        """#639: the exporter wrote this count; the SCHEMA threw it away.

        `ProjectSummary` is reached through `ImportValidationResult`, and a
        response_model silently drops undeclared fields — so `observation_count`
        sat in every v3+ archive and could never reach the import preview, which
        went on reporting only conversations/documents/datasets for a file full
        of observations.

        It was left undeclared on the reasoning that the schema's fields are
        REQUIRED, so adding one would fail to parse every v1/v2 manifest. True of
        a *required* field — hence the default. Both arms are pinned here because
        fixing either one alone reintroduces the other bug.
        """
        from app.schemas.project_portability import ProjectExportManifest

        base = {
            "format_version": 4, "format_type": "mmproject", "app_version": "9.9.9",
            "created_at": "2026-08-01", "project_name": "X",
        }
        counts = {
            "conversation_count": 1, "dataset_count": 0, "document_count": 0,
            "code_count": 2, "category_count": 0, "memo_count": 0,
            "participant_count": 1, "excerpt_count": 3,
        }

        # (a) A v3+ manifest: the real count must reach the client.
        v4 = ProjectExportManifest(
            **base,
            project_summary={**counts, "observation_count": 7,
                             "canvas_count": 0, "canvas_theme_count": 0},
        )
        assert v4.project_summary.model_dump()["observation_count"] == 7

        # (b) A pre-observations manifest: still parses, reads 0 — never raises.
        v2 = ProjectExportManifest(**{**base, "format_version": 2}, project_summary=counts)
        assert v2.project_summary.model_dump()["observation_count"] == 0

    def test_export_manifest_carries_the_observation_count(self, db_session, populated_project):
        """End-to-end companion to the schema pin: a real export states the count."""
        db = db_session
        pid = populated_project["project"].id
        buf = export_project(db, pid, Path("/nonexistent"))
        with zipfile.ZipFile(buf) as zf:
            manifest = json.loads(zf.read("manifest.json"))
        summary = manifest["project_summary"]
        observations = db.query(Observation).filter(Observation.project_id == pid).count()
        assert observations > 0, "fixture must carry an observation for this to mean anything"
        assert summary["observation_count"] == observations

    def test_observation_and_coded_clip_survive_roundtrip(self, db_session, populated_project):
        """The whole observation spine round-trips: source, clip, code, note, memo."""
        db = db_session
        old_pid = populated_project["project"].id
        new_pid = self._export_import(db, old_pid)

        obs = db.query(Observation).filter(Observation.project_id == new_pid).one()
        assert obs.name == "Classroom session 1"
        assert obs.media_filename == "session1.mp4"
        assert obs.media_type == "video"
        assert obs.media_duration_seconds == 600.0

        clip = db.query(Segment).filter(Segment.observation_id == obs.id).one()
        assert clip.text == "Small-group transition"
        assert (clip.start_time, clip.end_time) == (12.5, 48.25)
        # The clip must belong to the NEW observation, not the source's.
        assert clip.observation_id == obs.id
        assert clip.conversation_id is None and clip.document_id is None

        # The code on the clip travelled (it hangs off segment_ids in the gather).
        app = db.query(CodeApplication).filter(CodeApplication.segment_id == clip.id).one()
        assert db.query(Code).filter(Code.id == app.code_id).one().project_id == new_pid

        note = db.query(Note).filter(Note.observation_id == obs.id).one()
        assert note.content == "Teacher circulates here"
        assert note.segment_id == clip.id

        # The time-range excerpt round-trips with POPULATED times (slab 5).
        # Reflection carries the columns automatically — this pin is what makes
        # that claim non-vacuous (a NULL fixture would pass with the columns
        # dropped entirely).
        time_exc = db.query(Excerpt).filter(
            Excerpt.segment_id == clip.id, Excerpt.start_time.isnot(None),
        ).one()
        assert (time_exc.start_time, time_exc.end_time) == (20.0, 31.5)
        assert time_exc.start_offset is None and time_exc.end_offset is None

        memo = db.query(Memo).filter(
            Memo.project_id == new_pid, Memo.entity_type == "observation",
        ).one()
        # Memo.entity_id has no FK — an unregistered entity_type is copied verbatim
        # and silently points at the SOURCE project's observation.
        assert memo.entity_id == obs.id
        assert memo.entity_id != populated_project["observation"].id

    def test_export_with_observations_declares_format_v3(self, db_session, populated_project):
        """An observation-bearing file MUST declare format_version >= 3.

        An older build has no `segments.observation_id` column, so `_build_entity`
        silently DROPS the field and inserts the clip with all three parents NULL —
        violating that build's two-parent ck_segment_exactly_one_parent and dying
        mid-write on an opaque IntegrityError. The version gate is what turns that
        into a clean "created by a newer version" refusal, and the gate only fires
        if we actually declare the bump. Downgrading the constant re-arms the trap.
        """
        db = db_session
        buf = export_project(db, populated_project["project"].id, Path("/nonexistent"))
        with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
            manifest = json.loads(zf.read("manifest.json"))

        assert manifest["format_version"] >= 3
        assert manifest["project_summary"]["observation_count"] == 1

    def test_observation_recording_roundtrips_under_obs_namespace(
        self, db_session, populated_project, tmp_path
    ):
        """The recording lands under `media/obs-{id}/` on disk, on BOTH sides.

        A bare `int(parts[1])` on the import side raises ValueError on "obs-7" and
        silently `continue`s — the file is exported correctly and then dropped on
        the way back in, with no log line. That is the regression this pins.
        """
        db = db_session
        old_pid = populated_project["project"].id
        old_obs = populated_project["observation"]

        media_dir = tmp_path / "media"
        src = media_dir / str(old_pid) / f"obs-{old_obs.id}"
        src.mkdir(parents=True)
        (src / "original.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"payload" * 100)

        new_pid = self._export_import(db, old_pid, media_dir=media_dir)
        new_obs = db.query(Observation).filter(Observation.project_id == new_pid).one()

        landed = media_dir / str(new_pid) / f"obs-{new_obs.id}" / "original.mp4"
        assert landed.is_file(), "observation recording did not survive the round-trip"
        assert landed.read_bytes() == (src / "original.mp4").read_bytes()

        # The media metadata must SURVIVE (the orphan-clearing pass must not treat a
        # present obs recording as missing — it looked at Conversation rows only).
        assert new_obs.media_filename == "session1.mp4"
        assert new_obs.media_format == "mp4"

    def test_missing_observation_recording_clears_metadata(
        self, db_session, populated_project, tmp_path
    ):
        """A media-less archive must leave a clean re-attach state, not a dead player.

        The orphan-metadata sweep queried Conversation only, so an imported
        Observation kept media_filename pointing at a file that never landed.
        """
        db = db_session
        old_pid = populated_project["project"].id
        media_dir = tmp_path / "media"
        media_dir.mkdir()

        # No file on disk for the observation → nothing to carry across.
        new_pid = self._export_import(db, old_pid, media_dir=media_dir)
        new_obs = db.query(Observation).filter(Observation.project_id == new_pid).one()

        assert new_obs.media_filename is None
        assert new_obs.media_format is None
        assert new_obs.media_type is None
        assert new_obs.media_duration_seconds is None
        assert new_obs.media_is_vbr is None
        assert new_obs.media_offset_seconds == 0.0

    def test_import_as_new_fresh_stamps_observation_uuid(self, db_session, populated_project):
        """Import-as-new must FRESH-stamp the uuid or re-importing collides on the
        unique index (the J3-2-0 spine trap). Rides `_add`'s fresh_uuid — verify it
        actually reaches Observation."""
        db = db_session
        old_obs = populated_project["observation"]
        old_uuid = old_obs.uuid
        assert old_uuid

        new_pid = self._export_import(db, populated_project["project"].id)
        new_obs = db.query(Observation).filter(Observation.project_id == new_pid).one()

        assert new_obs.uuid and new_obs.uuid != old_uuid

    def test_merge_exempts_observations_from_the_segmentation_gate(
        self, db_session, populated_project
    ):
        """Clips are DELIBERATELY exempt from the frozen-segmentation gate.

        Frozen segmentation exists because text units PARTITION the material — two
        coders must agree on the turns. Clips don't partition anything: each coder
        marks their OWN ranges, and that divergence is the SUBJECT of unitizing-α,
        not a defect. Requiring identical clip uuid sets would refuse every real
        multi-coder observation merge. So a colleague's extra clip must MERGE IN
        additively, not raise MergeDivergenceError.
        """
        db = db_session
        pid = populated_project["project"].id
        obs = populated_project["observation"]

        buf = export_project(db, pid, Path("/nonexistent"))
        data = json.loads(zipfile.ZipFile(io.BytesIO(buf.getvalue())).read("project.json"))

        # The colleague marked a SECOND clip on the same observation — a clip-set
        # divergence that would refuse if observations went through the gate.
        obs_item = next(o for o in data["observations"] if o["_original_id"] == obs.id)
        template = next(s for s in data["segments"] if s.get("observation_id") == obs.id)
        extra = dict(template)
        extra["_original_id"] = max(s["_original_id"] for s in data["segments"]) + 1
        extra["uuid"] = str(uuid_module.uuid4())
        extra["sequence_order"] = 1
        extra["text"] = "Colleague's clip"
        extra["start_time"], extra["end_time"] = 100.0, 140.0
        data["segments"].append(extra)
        assert obs_item["uuid"]

        # Sanity: a divergent CONVERSATION segmentation still refuses, so this test
        # can't pass just because the gate stopped working.
        _assert_merge_compatible(db, data, target_project_id=pid)  # must not raise

        conv_seg = next(
            s for s in data["segments"]
            if s.get("conversation_id") and s.get("merged_into_id") is None
            and s.get("split_into_id") is None
        )
        diverged = json.loads(json.dumps(data))
        conv_extra = dict(conv_seg)
        conv_extra["_original_id"] = 9999
        conv_extra["uuid"] = str(uuid_module.uuid4())
        diverged["segments"].append(conv_extra)
        with pytest.raises(Exception, match="[Ss]egmentation diverged"):
            _assert_merge_compatible(db, diverged, target_project_id=pid)

    def _export_with_extra_clip(self, db, pid, obs):
        """An export of this project plus one clip the colleague added."""
        buf = export_project(db, pid, Path("/nonexistent"))
        data = json.loads(zipfile.ZipFile(io.BytesIO(buf.getvalue())).read("project.json"))
        template = next(s for s in data["segments"] if s.get("observation_id") == obs.id)
        extra = dict(template)
        extra["_original_id"] = max(s["_original_id"] for s in data["segments"]) + 1
        extra["uuid"] = str(uuid_module.uuid4())
        extra["sequence_order"] = 1
        extra["text"] = "Colleague's clip"
        extra["start_time"], extra["end_time"] = 100.0, 140.0
        data["segments"].append(extra)
        return data

    def test_merge_refuses_when_only_the_LOCAL_observation_is_frozen(
        self, db_session, populated_project
    ):
        """#572: the lead froze AFTER distributing copies.

        The colleague's file honestly reports an OPEN segmentation — it is the
        posture they coded under — so reading only the file exempts the merge and
        inserts their clips into a frozen observation, expanding the very unit set
        the freeze declared agreed. Those clips get exactly one voter, so consensus
        can never resolve them.
        """
        db = db_session
        pid = populated_project["project"].id
        obs = populated_project["observation"]

        data = self._export_with_extra_clip(db, pid, obs)  # file: open
        obs.segmentation_frozen_at = datetime(2026, 7, 19, 12, 0, 0)
        db.flush()

        with pytest.raises(MergeDivergenceError) as exc:
            _assert_merge_compatible(db, data, target_project_id=pid)
        assert exc.value.payload["kind"] == "segmentation_freeze"
        assert exc.value.payload["diverged_sources"][0]["frozen_side"] == "local"
        # Never the generic message: "re-segment to match" is wrong here — the
        # colleague's cuts predate the freeze and are not the thing to change.
        assert "re-segment to match" not in str(exc.value)

    def test_merge_refuses_when_only_the_FILE_observation_is_frozen(
        self, db_session, populated_project
    ):
        """The mirror direction, found while verifying #572.

        This case already refused before the fix — but through the clip-set
        comparison, which told the local coder to "re-segment to match" while their
        own open cuts were legitimate. Same one-sided read, opposite direction.
        """
        db = db_session
        pid = populated_project["project"].id
        obs = populated_project["observation"]

        data = self._export_with_extra_clip(db, pid, obs)
        obs_item = next(o for o in data["observations"] if o["_original_id"] == obs.id)
        obs_item["segmentation_frozen_at"] = "2026-07-19T12:00:00"  # file: frozen

        with pytest.raises(MergeDivergenceError) as exc:
            _assert_merge_compatible(db, data, target_project_id=pid)
        assert exc.value.payload["kind"] == "segmentation_freeze"
        assert exc.value.payload["diverged_sources"][0]["frozen_side"] == "file"

    def test_merge_still_gates_two_frozen_observations_on_their_clip_sets(
        self, db_session, populated_project
    ):
        """Both frozen = the D18 agreed-units case: compare clips, as before."""
        db = db_session
        pid = populated_project["project"].id
        obs = populated_project["observation"]

        data = self._export_with_extra_clip(db, pid, obs)
        obs_item = next(o for o in data["observations"] if o["_original_id"] == obs.id)
        obs_item["segmentation_frozen_at"] = "2026-07-19T12:00:00"
        obs.segmentation_frozen_at = datetime(2026, 7, 19, 12, 0, 0)
        db.flush()

        with pytest.raises(MergeDivergenceError) as exc:
            _assert_merge_compatible(db, data, target_project_id=pid)
        assert exc.value.payload["kind"] == "segmentation"

    def test_merge_accepts_two_frozen_observations_with_identical_clips(
        self, db_session, populated_project
    ):
        """The frozen happy path: same agreed clips on both sides, additive codings."""
        db = db_session
        pid = populated_project["project"].id
        obs = populated_project["observation"]

        buf = export_project(db, pid, Path("/nonexistent"))
        data = json.loads(zipfile.ZipFile(io.BytesIO(buf.getvalue())).read("project.json"))
        obs_item = next(o for o in data["observations"] if o["_original_id"] == obs.id)
        obs_item["segmentation_frozen_at"] = "2026-07-19T12:00:00"
        obs.segmentation_frozen_at = datetime(2026, 7, 19, 12, 0, 0)
        db.flush()

        _assert_merge_compatible(db, data, target_project_id=pid)  # must not raise


# ── Import tests ───────────────────────────────────────────────────────

class TestImportProject:

    def _export_and_import(self, db: Session, pid: int, docs_dir: Path | None = None) -> int:
        """Helper: export project, then import it, return new project ID."""
        buf = export_project(db, pid, docs_dir or Path("/nonexistent"))
        tmp = tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False)
        try:
            tmp.write(buf.getvalue())
            tmp.close()
            new_id, _ = import_project(db, Path(tmp.name), docs_dir or Path("/tmp/docs_test"), user_id=1)
            db.flush()
            return new_id
        finally:
            os.unlink(tmp.name)

    def test_roundtrip_preserves_conversation_date(self, db_session, populated_project):
        """A conversation date must survive .mmproject export → import.

        The date flows through portability's generic column-introspection
        serializer, so a column rename (or the datetime-by-name parse bug fixed
        alongside this) can silently drop/break it with no other test covering it.
        .mmproject is also the backup + Postgres-bridge format, so the round-trip
        matters in its own right. (Also the regression guard for the
        interview_date → conversation_date rename.)
        """
        import datetime as _dt

        pid = populated_project["project"].id
        conv = (
            db_session.query(Conversation)
            .filter(Conversation.project_id == pid)
            .first()
        )
        the_date = _dt.datetime(2024, 3, 15, 9, 30, 0)
        conv.conversation_date = the_date
        db_session.commit()

        new_id = self._export_and_import(db_session, pid)

        new_conv = (
            db_session.query(Conversation)
            .filter(Conversation.project_id == new_id)
            .first()
        )
        assert new_conv is not None
        assert isinstance(new_conv.conversation_date, _dt.datetime), (
            f"conversation_date came back as {type(new_conv.conversation_date).__name__}, "
            "not a datetime"
        )
        assert new_conv.conversation_date == the_date

    def test_creates_new_project(self, db_session, populated_project):
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)
        assert new_id != pid

        new_project = db_session.query(Project).filter(Project.id == new_id).first()
        assert new_project is not None
        # Original project still exists, so name gets dedup suffix
        assert new_project.name == "Test Project (imported)"

    def test_name_dedup(self, db_session, populated_project):
        """Importing when same-named project exists appends (imported)."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)
        new_project = db_session.query(Project).filter(Project.id == new_id).first()
        assert new_project.name == "Test Project (imported)"

    def test_preserves_relationships(self, db_session, populated_project):
        """Segments reference correct conversations, codes, etc."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        # Check segments belong to the new project's conversation
        new_conv = db_session.query(Conversation).filter(
            Conversation.project_id == new_id
        ).first()
        assert new_conv is not None
        new_segs = db_session.query(Segment).filter(
            Segment.conversation_id == new_conv.id
        ).all()
        assert len(new_segs) == 2  # 2 conversation segments

        # Check code applications reference new codes and segments
        new_codes = db_session.query(Code).filter(Code.project_id == new_id).all()
        code_ids = {c.id for c in new_codes}
        new_cas = db_session.query(CodeApplication).filter(
            CodeApplication.segment_id.in_([s.id for s in new_segs])
        ).all()
        for ca in new_cas:
            assert ca.code_id in code_ids

    def test_segment_self_refs_preserved(self, db_session, populated_project):
        """Merged/split segment self-references are correctly remapped."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_conv = db_session.query(Conversation).filter(
            Conversation.project_id == new_id
        ).first()
        new_segs = db_session.query(Segment).filter(
            Segment.conversation_id == new_conv.id
        ).order_by(Segment.sequence_order).all()

        # seg1 was merged into seg2
        seg1_new = [s for s in new_segs if s.text == "Hello world"][0]
        seg2_new = [s for s in new_segs if s.text == "Merged segment"][0]
        assert seg1_new.merged_into_id == seg2_new.id

    def test_remaps_polymorphic_memo_ids(self, db_session, populated_project):
        """Memos have entity_ids correctly remapped for all entity types."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_memos = db_session.query(Memo).filter(
            Memo.project_id == new_id
        ).all()
        memo_by_type = {m.entity_type: m for m in new_memos}

        # Project memo points to new project
        assert memo_by_type["project"].entity_id == new_id

        # Conversation memo points to new conversation
        new_conv = db_session.query(Conversation).filter(
            Conversation.project_id == new_id
        ).first()
        assert memo_by_type["conversation"].entity_id == new_conv.id

        # Document memo points to new document
        new_doc = db_session.query(Document).filter(
            Document.project_id == new_id
        ).first()
        assert memo_by_type["document"].entity_id == new_doc.id

        # Code memo points to new code
        new_code = db_session.query(Code).filter(
            Code.project_id == new_id, Code.name == "Leadership"
        ).first()
        assert memo_by_type["code"].entity_id == new_code.id

        # Category memo points to new category
        new_cat = db_session.query(CodeCategory).filter(
            CodeCategory.project_id == new_id, CodeCategory.name == "Theme A"
        ).first()
        assert memo_by_type["code_category"].entity_id == new_cat.id

        # Dataset memo points to new dataset
        new_ds = db_session.query(Dataset).filter(
            Dataset.project_id == new_id
        ).first()
        assert memo_by_type["dataset"].entity_id == new_ds.id

        # Analysis memo points to new material
        new_mat = db_session.query(Material).join(MaterialCollection).filter(
            MaterialCollection.project_id == new_id
        ).first()
        assert memo_by_type["analysis"].entity_id == new_mat.id

        # Canvas memo points to new canvas
        new_canvas = db_session.query(Canvas).filter(
            Canvas.project_id == new_id
        ).first()
        assert memo_by_type["canvas"].entity_id == new_canvas.id

    def test_remaps_material_config(self, db_session, populated_project):
        """Material config JSON has column_ids remapped."""
        pid = populated_project["project"].id
        old_col_id = populated_project["columns"][0].id

        new_id = self._export_and_import(db_session, pid)

        new_mat = db_session.query(Material).join(MaterialCollection).filter(
            MaterialCollection.project_id == new_id
        ).first()
        config = json.loads(new_mat.config)
        # column_ids should contain the new column ID, not the old one
        assert old_col_id not in config["column_ids"]
        new_col = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_id, DatasetColumn.column_name == "Q1"
        ).first()
        assert new_col.id in config["column_ids"]

    def test_remaps_text_coding_config(self, db_session, populated_project):
        """TextCodingConfig JSON arrays are remapped correctly."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_cvc = db_session.query(TextCodingConfig).filter(
            TextCodingConfig.project_id == new_id
        ).first()
        assert new_cvc is not None

        focal = json.loads(new_cvc.focal_column_ids)
        assert len(focal) == 1
        # Should be the new column ID for "Comments"
        new_col = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_id, DatasetColumn.column_name == "Comments"
        ).first()
        assert focal[0] == new_col.id

        # context_visibility preserved as-is
        cv = json.loads(new_cvc.context_visibility)
        assert cv == {"demographics": True}

    def test_remaps_quote_board_config(self, db_session, populated_project):
        """QuoteBoardConfig custom_orders keys and values are remapped."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_qbc = db_session.query(QuoteBoardConfig).filter(
            QuoteBoardConfig.project_id == new_id
        ).first()
        assert new_qbc is not None

        orders = json.loads(new_qbc.custom_orders)

        # "all" key should remain
        assert "all" in orders

        # code-{id} key should use new code ID
        new_code = db_session.query(Code).filter(
            Code.project_id == new_id, Code.name == "Leadership"
        ).first()
        assert f"code-{new_code.id}" in orders

    def test_remaps_metric_polymorphic(self, db_session, populated_project):
        """MetricDefinition input_source_id is remapped correctly."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_metric = db_session.query(MetricDefinition).filter(
            MetricDefinition.project_id == new_id
        ).first()
        assert new_metric is not None

        new_col = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_id, DatasetColumn.column_name == "Q1"
        ).first()
        assert new_metric.input_source_id == new_col.id

    def test_remaps_statistical_test_target(self, db_session, populated_project):
        """StatisticalTest target_id is remapped."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_st = db_session.query(StatisticalTest).filter(
            StatisticalTest.project_id == new_id
        ).first()
        new_domain = db_session.query(AnalysisDomain).filter(
            AnalysisDomain.project_id == new_id
        ).first()
        assert new_st.target_id == new_domain.id

    def test_remaps_domain_member(self, db_session, populated_project):
        """AnalysisDomainMember member_id is remapped."""
        pid = populated_project["project"].id
        new_id = self._export_and_import(db_session, pid)

        new_domain = db_session.query(AnalysisDomain).filter(
            AnalysisDomain.project_id == new_id
        ).first()
        new_adm = db_session.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.domain_id == new_domain.id
        ).first()
        new_col = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_id, DatasetColumn.column_name == "Q1"
        ).first()
        assert new_adm.member_id == new_col.id

    def test_copies_document_files(self, db_session, populated_project, tmp_path):
        """Document files are extracted from ZIP to the new project directory."""
        pid = populated_project["project"].id
        old_doc_id = populated_project["document"].id

        # Create mock source files
        src_dir = tmp_path / "src_docs"
        doc_dir = src_dir / str(pid) / str(old_doc_id)
        doc_dir.mkdir(parents=True)
        (doc_dir / "original.pdf").write_text("fake pdf content")

        # Export with real docs
        buf = export_project(db_session, pid, src_dir)
        tmp_file = tmp_path / "test.mmproject"
        tmp_file.write_bytes(buf.getvalue())

        # Import to a new docs dir
        dest_dir = tmp_path / "dest_docs"
        dest_dir.mkdir()
        new_id, _ = import_project(db_session, tmp_file, dest_dir, user_id=1)
        db_session.flush()

        # Find the new document ID
        new_doc = db_session.query(Document).filter(
            Document.project_id == new_id
        ).first()
        new_doc_path = dest_dir / str(new_id) / str(new_doc.id) / "original.pdf"
        assert new_doc_path.exists()
        assert new_doc_path.read_text() == "fake pdf content"

    def test_remaps_canvas_entities(self, db_session, populated_project):
        """Canvas, themes, relationships, pending items get new IDs with valid FKs."""
        pid = populated_project["project"].id
        old_canvas_id = populated_project["canvas"].id
        new_id = self._export_and_import(db_session, pid)

        # Canvas remapped
        new_canvas = db_session.query(Canvas).filter(Canvas.project_id == new_id).first()
        assert new_canvas is not None
        assert new_canvas.id != old_canvas_id
        assert new_canvas.name == "Analysis Canvas"

        # Themes belong to new canvas
        new_themes = db_session.query(CanvasTheme).filter(
            CanvasTheme.canvas_id == new_canvas.id
        ).order_by(CanvasTheme.doc_order).all()
        assert len(new_themes) == 2
        assert new_themes[0].name == "Main Theme"
        assert new_themes[0].color == "#3b82f6"
        assert new_themes[1].name == "Sub Theme"

        # Theme relationship with valid FKs
        new_rels = db_session.query(CanvasThemeRelationship).filter(
            CanvasThemeRelationship.canvas_id == new_canvas.id
        ).all()
        assert len(new_rels) == 1
        assert new_rels[0].source_theme_id == new_themes[0].id
        assert new_rels[0].target_theme_id == new_themes[1].id
        assert new_rels[0].relationship_type == "confirms"
        assert new_rels[0].label == "Strong link"

        # Pending items with remapped canvas_id
        new_pending = db_session.query(CanvasPendingItem).filter(
            CanvasPendingItem.canvas_id == new_canvas.id
        ).all()
        assert len(new_pending) == 2
        pending_types = {pi.item_type for pi in new_pending}
        assert pending_types == {"excerpt", "material"}

        # Theme prose content preserved
        assert new_themes[0].content is not None
        import json as _json
        parsed = _json.loads(new_themes[0].content)
        assert parsed["type"] == "doc"
        assert new_themes[0].searchable_text == "Theme prose quote"
        assert new_themes[0].referenced_source_ids is not None

    def test_remaps_canvas_embed_and_pending_ids(self, db_session, populated_project):
        """#387: embedded entity IDs in CanvasTheme.content, the re-derived
        referenced_source_ids, and polymorphic CanvasPendingItem.source_id are
        all remapped to the imported project's new IDs — not carried verbatim.
        """
        import json as _json
        pid = populated_project["project"].id
        old_excerpt_id = populated_project["excerpt"].id
        old_material_id = populated_project["material"].id
        old_memo_id = next(
            m.id for m in populated_project["memos"] if m.entity_type == "analysis"
        )
        new_id = self._export_and_import(db_session, pid)

        # Resolve the imported excerpt + material + memo IDs.
        new_canvas = db_session.query(Canvas).filter(Canvas.project_id == new_id).first()
        new_conv = db_session.query(Conversation).filter(
            Conversation.project_id == new_id
        ).first()
        new_seg_ids = [
            s.id for s in db_session.query(Segment).filter(
                Segment.conversation_id == new_conv.id
            ).all()
        ]
        new_excerpt = db_session.query(Excerpt).filter(
            Excerpt.segment_id.in_(new_seg_ids)
        ).first()
        new_material = db_session.query(Material).join(MaterialCollection).filter(
            MaterialCollection.project_id == new_id
        ).first()
        new_memo = db_session.query(Memo).filter(
            Memo.project_id == new_id, Memo.entity_type == "analysis"
        ).first()
        assert new_excerpt is not None and new_material is not None and new_memo is not None
        # Sanity: the import really did mint new IDs (otherwise the test is vacuous).
        assert new_excerpt.id != old_excerpt_id

        new_theme = db_session.query(CanvasTheme).filter(
            CanvasTheme.canvas_id == new_canvas.id, CanvasTheme.name == "Main Theme"
        ).first()

        # M2: all three embed node attrs remapped inside the content blob.
        content = _json.loads(new_theme.content)
        nodes_by_type = {n.get("type"): n for n in content["content"]}
        assert nodes_by_type["excerpt-embed"]["attrs"]["excerptId"] == new_excerpt.id
        assert nodes_by_type["excerpt-embed"]["attrs"]["excerptId"] != old_excerpt_id
        assert nodes_by_type["chart-embed"]["attrs"]["materialId"] == new_material.id
        assert nodes_by_type["chart-embed"]["attrs"]["materialId"] != old_material_id
        assert nodes_by_type["memo-embed"]["attrs"]["memoId"] == new_memo.id
        assert nodes_by_type["memo-embed"]["attrs"]["memoId"] != old_memo_id

        # M3: referenced_source_ids re-derived from the rewritten content.
        refs = _json.loads(new_theme.referenced_source_ids)
        assert {(r["type"], r["id"]) for r in refs} == {
            ("excerpt", new_excerpt.id),
            ("material", new_material.id),
            ("memo", new_memo.id),
        }

        # M1: polymorphic pending source_id remapped per item_type.
        new_pending = db_session.query(CanvasPendingItem).filter(
            CanvasPendingItem.canvas_id == new_canvas.id
        ).all()
        pending_by_type = {pi.item_type: pi for pi in new_pending}
        assert pending_by_type["excerpt"].source_id == new_excerpt.id
        assert pending_by_type["excerpt"].source_id != old_excerpt_id
        assert pending_by_type["material"].source_id == new_material.id
        assert pending_by_type["material"].source_id != old_material_id

    def test_roundtrip_fidelity(self, db_session, populated_project):
        """Export -> import -> export produces structurally equivalent data."""
        pid = populated_project["project"].id

        # First export
        buf1 = export_project(db_session, pid, Path("/nonexistent"))
        with zipfile.ZipFile(buf1, "r") as zf:
            data1 = json.loads(zf.read("project.json"))

        # Import
        new_id = self._export_and_import(db_session, pid)

        # Second export
        buf2 = export_project(db_session, new_id, Path("/nonexistent"))
        with zipfile.ZipFile(buf2, "r") as zf:
            data2 = json.loads(zf.read("project.json"))

        # Compare entity counts
        for key in data1:
            if key in ("project", "text_coding_config", "quote_board_config"):
                continue  # singletons, checked differently
            assert len(data1[key]) == len(data2[key]), f"Mismatch in {key}: {len(data1[key])} vs {len(data2[key])}"

    # ───────────────────────────────────────────────────────────────────────
    # Tier 3 Session A — portability backfill tests (Task 1.9 / GAP 3.12)
    # ───────────────────────────────────────────────────────────────────────

    def test_tier3_backfill_creates_missing_scale_score_metric(self, db_session, populated_project):
        """Legacy .mmproject with a domain but no scale-score metric gets the
        metric backfilled during import. The resulting metric has the same
        canonical shape as one created directly by create_scale_score_metric
        (origin='human', origin_context='crosswalk_auto').
        """
        pid = populated_project["project"].id

        # Simulate a legacy project: delete the scale-score metric from the
        # fixture project before export. The domain + member rows remain.
        legacy_metric = (
            db_session.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == pid,
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.metric_type == "domain_aggregate",
                MetricDefinition.origin_context == "crosswalk_auto",
            )
            .first()
        )
        assert legacy_metric is not None, (
            "populated_project fixture should include a scale-score metric "
            "for the roundtrip tests — see the Revision 5 test fixture update."
        )
        db_session.delete(legacy_metric)
        db_session.flush()

        # Export (without the scale-score metric) and re-import
        new_pid = self._export_and_import(db_session, pid)

        # After import, the backfill should have created a fresh scale-score
        # metric for the imported Leadership Domain.
        imported_domain = (
            db_session.query(AnalysisDomain)
            .filter(AnalysisDomain.project_id == new_pid, AnalysisDomain.name == "Leadership Domain")
            .first()
        )
        assert imported_domain is not None

        backfilled = (
            db_session.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == new_pid,
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.input_source_id == imported_domain.id,
                MetricDefinition.metric_type == "domain_aggregate",
                MetricDefinition.grouping_column_id.is_(None),
                MetricDefinition.grouping_column_id_2.is_(None),
            )
            .first()
        )
        assert backfilled is not None, (
            "Tier 3 backfill should have created a scale-score metric for "
            "the imported Leadership Domain. See project_portability.py "
            "Tier 3 backfill block."
        )
        assert backfilled.name == "Leadership Domain Score"
        assert backfilled.origin == "human"
        assert backfilled.origin_context == "crosswalk_auto"

    def test_tier3_backfill_skips_existing_metric(self, db_session, populated_project):
        """Projects that already have a scale-score metric (e.g. roundtripped
        crosswalk-era projects) don't get a duplicate on import. Idempotency
        via the service function's find-existing path.
        """
        pid = populated_project["project"].id

        # Fixture already has a scale-score metric via the Revision 5 update.
        # Count the pre-export scale-score metrics.
        pre_count = (
            db_session.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == pid,
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.metric_type == "domain_aggregate",
                MetricDefinition.grouping_column_id.is_(None),
                MetricDefinition.grouping_column_id_2.is_(None),
            )
            .count()
        )
        assert pre_count == 1

        new_pid = self._export_and_import(db_session, pid)

        # Exactly one scale-score metric after import — the backfill should
        # have found the imported-from-source one and skipped creating another.
        post_count = (
            db_session.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == new_pid,
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.metric_type == "domain_aggregate",
                MetricDefinition.grouping_column_id.is_(None),
                MetricDefinition.grouping_column_id_2.is_(None),
            )
            .count()
        )
        assert post_count == 1

    def test_tier3_backfill_post_write_sanity_pass_on_valid_groups(self, db_session, populated_project):
        """The post-write sanity pass (assert_equivalence_group_types_consistent)
        should be a no-op on valid groups. Covers the happy path of the
        sanity check — failure path is exercised by the validators' own tests.
        """
        pid = populated_project["project"].id

        # Populated fixture has 1 equivalence group with 1 ordinal column —
        # trivially valid. Import should succeed without raising.
        new_pid = self._export_and_import(db_session, pid)

        imported_egs = (
            db_session.query(EquivalenceGroup)
            .filter(EquivalenceGroup.project_id == new_pid)
            .all()
        )
        assert len(imported_egs) >= 1

    def test_computed_column_expression_preserved(self, db_session, populated_project):
        """Computed column expression survives export→import round-trip."""
        pid = populated_project["project"].id
        new_pid = self._export_and_import(db_session, pid)

        imported_cols = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_pid
        ).all()
        computed = [c for c in imported_cols if c.source == "computed"]
        assert len(computed) == 1
        assert computed[0].expression == "[Q1] * 2"

    def test_computed_column_depends_remapped(self, db_session, populated_project):
        """depends_on_column_ids are remapped to new column IDs after import."""
        pid = populated_project["project"].id
        new_pid = self._export_and_import(db_session, pid)

        imported_cols = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_pid
        ).all()
        computed = [c for c in imported_cols if c.source == "computed"]
        assert len(computed) == 1
        dep_ids = json.loads(computed[0].depends_on_column_ids)
        assert len(dep_ids) == 1
        # The remapped ID should NOT equal the original col1.id from the fixture
        original_col1_id = populated_project["col1"].id
        assert dep_ids[0] != original_col1_id
        # But it should point to a valid column in the imported project
        imported_col_ids = {c.id for c in imported_cols}
        assert dep_ids[0] in imported_col_ids

    def test_computed_column_source_preserved(self, db_session, populated_project):
        """Computed column source field stays 'computed' after import."""
        pid = populated_project["project"].id
        new_pid = self._export_and_import(db_session, pid)

        imported_cols = db_session.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == new_pid
        ).all()
        computed = [c for c in imported_cols if c.source == "computed"]
        assert len(computed) == 1
        assert computed[0].column_text == "Doubled Q1"


# ── Codebook export tests ──────────────────────────────────────────────

class TestCodebookExport:

    def test_native_export(self, db_session, populated_project):
        pid = populated_project["project"].id
        result = export_codebook_native(db_session, pid)

        assert result["format_type"] == "mmcodebook"
        assert len(result["categories"]) > 0
        assert len(result["codes"]) > 0

        # Includes inactive codes
        inactive = [c for c in result["codes"] if not c["is_active"]]
        assert len(inactive) == 1

    def test_native_category_path(self, db_session, populated_project):
        pid = populated_project["project"].id
        result = export_codebook_native(db_session, pid)

        leadership = [c for c in result["codes"] if c["name"] == "Leadership"][0]
        assert leadership["category_name_path"] == "Theme A > Sub A"

    def test_qdc_export(self, db_session, populated_project):
        pid = populated_project["project"].id
        xml_str = export_codebook_qdc(db_session, pid)

        assert '<?xml' in xml_str
        assert 'origin="Mixed Measures' in xml_str
        assert 'isCodable="false"' in xml_str  # categories
        assert 'isCodable="true"' in xml_str   # codes

    def test_qdc_excludes_inactive(self, db_session, populated_project):
        pid = populated_project["project"].id
        xml_str = export_codebook_qdc(db_session, pid)
        assert "Inactive Code" not in xml_str

    # ── #633: REFI-QDA schema conformance ──────────────────────────────

    def test_qdc_export_uses_the_standards_namespace(self, db_session, populated_project):
        """The exported namespace is the standard's, NOT MM's pre-#633 one.

        REFI-QDA 1.5 §5.2 declares targetNamespace="urn:QDA-XML:codebook:1.0".
        MM shipped "…:1:0" (a COLON for the DOT) from 2026-03-16, which is why
        no other tool ever accepted our file. Asserted on the PARSED tree, not
        on a substring — the point is what a validating parser resolves.
        """
        xml_str = export_codebook_qdc(db_session, populated_project["project"].id)
        root = ET.fromstring(xml_str)

        assert root.tag == f"{{{QDC_NAMESPACE}}}CodeBook"
        assert QDC_NAMESPACE == "urn:QDA-XML:codebook:1.0"
        assert LEGACY_QDC_NAMESPACE not in xml_str

        # Children inherit the root's default namespace on reparse — this is
        # what makes the unqualified serialization correct rather than a second
        # bug hiding behind the first.
        for el in root.iter():
            assert el.tag.startswith(f"{{{QDC_NAMESPACE}}}"), el.tag

    def test_qdc_export_guid_prefers_the_uuid_spine(self, db_session, populated_project):
        """A code's GUID is its Track J uuid, so .qdc and .mmproject agree."""
        pid = populated_project["project"].id
        leadership = db_session.query(Code).filter(
            Code.project_id == pid, Code.name == "Leadership"
        ).first()
        assert leadership.uuid  # spine populated by the model default

        root = ET.fromstring(export_codebook_qdc(db_session, pid))
        guids = {
            el.get("name"): el.get("guid")
            for el in root.iter(f"{{{QDC_NAMESPACE}}}Code")
        }
        assert guids["Leadership"] == leadership.uuid

    def test_qdc_export_falls_back_when_the_spine_is_null(self, db_session, populated_project):
        """Pre-spine rows hold uuid=NULL and still get a schema-legal GUID."""
        pid = populated_project["project"].id
        leadership = db_session.query(Code).filter(
            Code.project_id == pid, Code.name == "Leadership"
        ).first()
        leadership.uuid = None
        db_session.flush()

        root = ET.fromstring(export_codebook_qdc(db_session, pid))
        guid = next(
            el.get("guid") for el in root.iter(f"{{{QDC_NAMESPACE}}}Code")
            if el.get("name") == "Leadership"
        )
        # The schema's GUIDType pattern.
        assert re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            guid,
        )

    def test_qdc_export_omits_a_schema_illegal_colour(self, db_session, populated_project):
        """RGBType is #RGB or #RRGGBB — anything else is dropped, not emitted."""
        pid = populated_project["project"].id
        leadership = db_session.query(Code).filter(
            Code.project_id == pid, Code.name == "Leadership"
        ).first()
        leadership.color = "rebecca"  # fits String(7); is not a legal RGB
        db_session.flush()

        root = ET.fromstring(export_codebook_qdc(db_session, pid))
        el = next(
            e for e in root.iter(f"{{{QDC_NAMESPACE}}}Code")
            if e.get("name") == "Leadership"
        )
        assert el.get("color") is None
        assert "rebecca" not in export_codebook_qdc(db_session, pid)

    def test_qdc_export_satisfies_every_schema_constraint(self, db_session, populated_project):
        """Assert the XSD's actual rules, not just the namespace string.

        The official Codebook.xsd sits behind a Tresorit link and is not
        vendorable here, so these are the constraints transcribed from
        REFI-QDA 1.5 §5.2 rather than a live schema validation:

            CodeBookType : sequence(Codes, Sets?) + optional @origin
            CodesType    : Code, maxOccurs=unbounded (implicit minOccurs=1)
            CodeType     : sequence(Description?, Code*)
                           @guid, @name, @isCodable REQUIRED; @color optional
            GUIDType     : hyphenated hex, optionally brace-wrapped
            RGBType      : #RGB or #RRGGBB

        Matching the namespace alone would not catch a missing required
        attribute or an out-of-order child.
        """
        xml_str = export_codebook_qdc(db_session, populated_project["project"].id)
        root = ET.fromstring(xml_str)
        q = lambda n: f"{{{QDC_NAMESPACE}}}{n}"  # noqa: E731

        assert root.tag == q("CodeBook")
        # CodeBookType's only attribute is the optional `origin`.
        assert set(root.attrib) <= {"origin"}

        children = list(root)
        assert [c.tag for c in children][:1] == [q("Codes")]
        assert all(c.tag in (q("Codes"), q("Sets")) for c in children)

        codes_container = children[0]
        assert len(codes_container) >= 1, "CodesType requires at least one Code"

        guid_re = re.compile(
            r"^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
            r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$"
        )
        rgb_re = re.compile(r"^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$")

        seen = 0
        for el in root.iter(q("Code")):
            seen += 1
            for required in ("guid", "name", "isCodable"):
                assert el.get(required) is not None, f"{required} missing"
            assert guid_re.match(el.get("guid")), el.get("guid")
            assert el.get("isCodable") in ("true", "false")
            if el.get("color") is not None:
                assert rgb_re.match(el.get("color")), el.get("color")
            assert set(el.attrib) <= {"guid", "name", "isCodable", "color"}

            # sequence(Description?, Code*) — Description may appear at most
            # once and must precede any nested Code.
            tags = [c.tag for c in el]
            assert tags.count(q("Description")) <= 1
            assert all(t in (q("Description"), q("Code")) for t in tags)
            if q("Description") in tags:
                assert tags.index(q("Description")) == 0

        assert seen >= 1

    def test_qdc_export_refuses_an_empty_codebook(self, db_session):
        """CodesType has an implicit minOccurs=1, so <Codes /> is invalid.

        Refusing beats handing the researcher a file no tool will open.
        """
        project = Project(name="No codes", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        with pytest.raises(EmptyCodebookError):
            export_codebook_qdc(db_session, project.id)

        # .mmcodebook is MM's own format and has no such constraint.
        assert export_codebook_native(db_session, project.id)["codes"] == []

    def test_empty_codebook_answers_400_not_404_at_the_router(self, db_session):
        """EmptyCodebookError subclasses ValueError, which the router already
        maps to 404 for "project not found". Without its own arm it would tell
        the caller the PROJECT does not exist — a misdiagnosis. The project is
        there; the request is just unsatisfiable in this format.
        """
        import asyncio

        from fastapi import HTTPException

        from app.models.user import User
        from app.routers.project_portability import export_codebook_endpoint

        project = Project(name="Empty at the wire", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()
        user = db_session.query(User).filter(User.id == 1).first()

        with pytest.raises(HTTPException) as exc:
            asyncio.run(export_codebook_endpoint(
                project_id=project.id, format="qdc", db=db_session, user=user,
            ))
        assert exc.value.status_code == 400
        assert "at least one" in str(exc.value.detail)


# ── Codebook import tests ──────────────────────────────────────────────

class TestCodebookImport:

    def test_native_import_creates_codes(self, db_session):
        """Import into an empty project creates codes and categories."""
        project = Project(name="Import Target", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()
        # Add universal codes (always present)
        db_session.add(Code(project_id=project.id, numeric_id=0, name="Unsubstantive", is_universal=True, color="#ccc"))
        db_session.add(Code(project_id=project.id, numeric_id=1, name="Substantive", is_universal=True, color="#ccc"))
        db_session.flush()

        codebook = {
            "format_version": 1,
            "format_type": "mmcodebook",
            "categories": [
                {"name": "Theme X", "color": "#ff0000", "display_order": 0,
                 "parent_name_path": None, "children": []},
            ],
            "codes": [
                {"name": "Unsubstantive", "numeric_id": 0, "is_universal": True,
                 "color": "#ccc", "category_name_path": None, "category_order": 0},
                {"name": "New Code", "numeric_id": 5, "color": "#00ff00",
                 "is_active": True, "category_name_path": "Theme X",
                 "category_order": 0},
            ],
        }

        counts = import_codebook_native(db_session, project.id, codebook)
        assert counts["categories_created"] == 1
        assert counts["codes_created"] == 1
        assert counts["codes_skipped"] == 1  # universal skipped

    def test_native_import_dedup(self, db_session, populated_project):
        """Importing codes that already exist are skipped."""
        pid = populated_project["project"].id

        # Export then reimport
        codebook = export_codebook_native(db_session, pid)
        counts = import_codebook_native(db_session, pid, codebook)
        assert counts["codes_created"] == 0
        assert counts["categories_created"] == 0
        assert counts["codes_skipped"] > 0

    def test_native_same_name_different_category(self, db_session):
        """Two codes named 'Other' in different categories both get imported."""
        project = Project(name="Test", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        codebook = {
            "format_version": 1,
            "format_type": "mmcodebook",
            "categories": [
                {"name": "Strengths", "color": "#00f", "display_order": 0,
                 "parent_name_path": None, "children": []},
                {"name": "Weaknesses", "color": "#f00", "display_order": 1,
                 "parent_name_path": None, "children": []},
            ],
            "codes": [
                {"name": "Other", "numeric_id": 2, "color": "#aaa",
                 "category_name_path": "Strengths", "category_order": 0},
                {"name": "Other", "numeric_id": 3, "color": "#bbb",
                 "category_name_path": "Weaknesses", "category_order": 0},
            ],
        }

        counts = import_codebook_native(db_session, project.id, codebook)
        assert counts["codes_created"] == 2

        codes = db_session.query(Code).filter(
            Code.project_id == project.id, Code.name == "Other"
        ).all()
        assert len(codes) == 2

    def test_qdc_import(self, db_session):
        """Parse a QDC file and create codes with correct hierarchy."""
        project = Project(name="QDC Test", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        xml = '''<?xml version="1.0" encoding="UTF-8"?>
        <CodeBook origin="Test" xmlns="urn:QDA-XML:codebook:1.0">
          <Codes>
            <Code guid="a1" name="Theme" color="#ff0000" isCodable="false">
              <Code guid="a2" name="SubCode" color="#00ff00" isCodable="true">
                <Description>A test code</Description>
              </Code>
            </Code>
            <Code guid="a3" name="TopLevel" color="#0000ff" isCodable="true"/>
          </Codes>
        </CodeBook>'''

        counts = import_codebook_qdc(db_session, project.id, xml)
        assert counts["categories_created"] == 1  # Theme
        assert counts["codes_created"] == 2  # SubCode + TopLevel

        subcode = db_session.query(Code).filter(
            Code.project_id == project.id, Code.name == "SubCode"
        ).first()
        assert subcode.description == "A test code"
        assert subcode.category_id is not None

    def test_qdc_codable_parent(self, db_session):
        """A QDC code with children AND isCodable=true creates both."""
        project = Project(name="QDC Edge", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        xml = '''<?xml version="1.0" encoding="UTF-8"?>
        <CodeBook origin="Test" xmlns="urn:QDA-XML:codebook:1.0">
          <Codes>
            <Code guid="b1" name="CodableParent" color="#ff0000" isCodable="true">
              <Code guid="b2" name="Child" color="#00ff00" isCodable="true"/>
            </Code>
          </Codes>
        </CodeBook>'''

        counts = import_codebook_qdc(db_session, project.id, xml)
        assert counts["categories_created"] == 1
        assert counts["codes_created"] == 2  # CodableParent as code + Child

    def test_qdc_missing_iscodable(self, db_session):
        """Missing isCodable defaults: leaf=true, parent=false."""
        project = Project(name="QDC Default", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        xml = '''<?xml version="1.0" encoding="UTF-8"?>
        <CodeBook origin="Test" xmlns="urn:QDA-XML:codebook:1.0">
          <Codes>
            <Code guid="c1" name="ImplicitCategory" color="#ff0000">
              <Code guid="c2" name="ImplicitCode" color="#00ff00"/>
            </Code>
          </Codes>
        </CodeBook>'''

        counts = import_codebook_qdc(db_session, project.id, xml)
        assert counts["categories_created"] == 1  # parent defaults to category
        assert counts["codes_created"] == 1        # leaf defaults to code


# ── #633: QDC namespace conformance + import hardening ──────────────────

def _qdc(xmlns: str | None, prefix: str = "") -> str:
    """One codebook, rendered with whatever namespace declaration is asked for."""
    if xmlns is None:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<CodeBook origin="Test"><Codes>'
            '<Code guid="11111111-1111-1111-1111-111111111111" name="Trust" isCodable="true">'
            "<Description>Expressions of trust</Description>"
            "</Code></Codes></CodeBook>"
        )
    if prefix:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<{prefix}:CodeBook xmlns:{prefix}="{xmlns}" origin="Test"><{prefix}:Codes>'
            f'<{prefix}:Code guid="11111111-1111-1111-1111-111111111111" '
            f'name="Trust" isCodable="true">'
            f"<{prefix}:Description>Expressions of trust</{prefix}:Description>"
            f"</{prefix}:Code></{prefix}:Codes></{prefix}:CodeBook>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<CodeBook xmlns="{xmlns}" origin="Test"><Codes>'
        '<Code guid="11111111-1111-1111-1111-111111111111" name="Trust" isCodable="true">'
        "<Description>Expressions of trust</Description>"
        "</Code></Codes></CodeBook>"
    )


class TestQdcNamespaceConformance:
    """The regression that #633 is actually about.

    Before the fix, import matched MM's own wrong URN or no namespace at all, so
    a standards-compliant file raised "No <Codes> element found in QDC file" —
    the one file every other QDA tool writes was the one file MM refused. The
    fix matches on LOCAL NAME, so all four shapes below import identically and a
    future revision of the standard needs no code change.
    """

    @pytest.mark.parametrize("label,xml", [
        ("standard", _qdc(QDC_NAMESPACE)),
        ("legacy-mm", _qdc(LEGACY_QDC_NAMESPACE)),
        ("no-namespace", _qdc(None)),
        ("prefixed", _qdc(QDC_NAMESPACE, prefix="qdc")),
    ])
    def test_every_namespace_shape_imports_identically(self, db_session, label, xml):
        project = Project(name=f"NS {label}", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        counts = import_codebook_qdc(db_session, project.id, xml)
        assert counts["codes_created"] == 1, label

        code = db_session.query(Code).filter(
            Code.project_id == project.id, Code.name == "Trust"
        ).first()
        assert code is not None, label
        # Description is matched by local name too — it lived behind the same
        # namespace check as <Codes> and <Code>.
        assert code.description == "Expressions of trust", label

    def test_legacy_mm_files_still_import_after_the_namespace_change(self, db_session):
        """Back-compat is the reason matching is agnostic rather than retargeted.

        Every .qdc MM wrote between 2026-03-16 and the fix carries the old URN.
        Simply pointing the constant at the standard would have broken all of
        them — the fix must read both, and it does so without a legacy list.
        """
        project = Project(name="Legacy", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        counts = import_codebook_qdc(
            db_session, project.id, _qdc(LEGACY_QDC_NAMESPACE)
        )
        assert counts["codes_created"] == 1

    def test_export_then_import_round_trips_through_the_real_functions(self, db_session, populated_project):
        """End-to-end: our own export must satisfy our own import.

        Both sides moved, so a same-URN pair could agree while both were wrong.
        The namespace assertion above is what pins them to the STANDARD; this
        pins that the pair still composes.
        """
        source_pid = populated_project["project"].id
        xml_str = export_codebook_qdc(db_session, source_pid)

        target = Project(name="Round trip", status="active", user_id=1)
        db_session.add(target)
        db_session.flush()

        counts = import_codebook_qdc(db_session, target.id, xml_str)
        assert counts["codes_created"] >= 1
        assert counts["categories_created"] >= 1

        names = {
            c.name for c in db_session.query(Code).filter(
                Code.project_id == target.id
            ).all()
        }
        assert "Leadership" in names
        assert "Inactive Code" not in names  # export is active-only

    def test_missing_codes_element_names_the_root_it_found(self, db_session):
        """The error should point at the problem, not just restate the symptom."""
        project = Project(name="Bad root", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        with pytest.raises(ValueError) as exc:
            import_codebook_qdc(
                db_session, project.id,
                '<?xml version="1.0"?><Codebook><Wrong/></Codebook>',
            )
        assert "Codebook" in str(exc.value)


class TestQdcImportHardening:

    def test_deeply_nested_file_is_refused_not_a_500(self, db_session):
        """Measured: 2000 levels in 112 KB blew the stack; the cap is 10 MB.

        defusedxml stops entity expansion, not nesting depth — the recursion is
        ours. Without the cap this raised RecursionError, which the router turns
        into an opaque 500.
        """
        project = Project(name="Deep", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        depth = MAX_QDC_DEPTH + 5
        xml = (
            f'<CodeBook xmlns="{QDC_NAMESPACE}"><Codes>'
            + "".join(
                f'<Code guid="g{i}" name="C{i}" isCodable="false">'
                for i in range(depth)
            )
            + '<Code guid="leaf" name="leaf" isCodable="true"/>'
            + "</Code>" * depth
            + "</Codes></CodeBook>"
        )

        with pytest.raises(ValueError) as exc:
            import_codebook_qdc(db_session, project.id, xml)
        assert "levels deep" in str(exc.value)

    def test_a_normal_hierarchy_is_not_caught_by_the_depth_cap(self, db_session):
        """The cap must refuse the absurd without refusing real codebooks."""
        project = Project(name="Normal depth", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        depth = 5
        xml = (
            f'<CodeBook xmlns="{QDC_NAMESPACE}"><Codes>'
            + "".join(
                f'<Code guid="g{i}" name="C{i}" isCodable="false">'
                for i in range(depth)
            )
            + '<Code guid="leaf" name="leaf" isCodable="true"/>'
            + "</Code>" * depth
            + "</Codes></CodeBook>"
        )

        counts = import_codebook_qdc(db_session, project.id, xml)
        assert counts["codes_created"] == 1
        assert counts["categories_created"] == depth

    def test_too_many_codes_is_refused_before_any_db_work(self, db_session):
        """Every other import adapter caps; this one was the outlier."""
        from app.services import codebook_exchange

        project = Project(name="Wide", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        original = codebook_exchange.MAX_QDC_CODES
        codebook_exchange.MAX_QDC_CODES = 3
        try:
            xml = (
                f'<CodeBook xmlns="{QDC_NAMESPACE}"><Codes>'
                + "".join(
                    f'<Code guid="g{i}" name="C{i}" isCodable="true"/>'
                    for i in range(10)
                )
                + "</Codes></CodeBook>"
            )
            with pytest.raises(ValueError) as exc:
                import_codebook_qdc(db_session, project.id, xml)
            assert "exceeds" in str(exc.value)
        finally:
            codebook_exchange.MAX_QDC_CODES = original

        # Refused pre-flight: nothing was written.
        assert db_session.query(Code).filter(
            Code.project_id == project.id
        ).count() == 0

    def test_foreign_colour_and_name_are_sanitised(self, db_session):
        """A foreign file's attributes are arbitrary text until proven otherwise.

        SQLite does not enforce String(7)/String(255), so an over-long name or a
        junk colour would land in the DB and reach the UI verbatim.
        """
        project = Project(name="Hostile attrs", status="active", user_id=1)
        db_session.add(project)
        db_session.flush()

        long_name = "N" * 400
        xml = (
            f'<CodeBook xmlns="{QDC_NAMESPACE}"><Codes>'
            f'<Code guid="d1" name="{long_name}" color="javascript:alert(1)" isCodable="true"/>'
            f'<Code guid="d2" name="Good" color="#ff0000" isCodable="true"/>'
            "</Codes></CodeBook>"
        )
        import_codebook_qdc(db_session, project.id, xml)

        codes = {
            c.name: c for c in db_session.query(Code).filter(
                Code.project_id == project.id
            ).all()
        }
        assert len(next(iter(k for k in codes if k.startswith("N")))) == 255
        assert codes["Good"].color == "#ff0000"
        bad = next(c for k, c in codes.items() if k.startswith("N"))
        assert bad.color is None


def test_coder_attribution_survives_roundtrip(db_session: Session):
    """Track J · J1: a code application by a non-default coder round-trips with its
    attribution remapped through the coders section (matched by name on import),
    instead of being nulled (the pre-J1 behavior)."""
    from app.models.user import User

    db = db_session
    coder = User(username="Dr. Alvarez", password_hash=None, coder_type="human", display_color="#3b82f6")
    db.add(coder)
    db.flush()

    project = Project(name="Attribution Study", status="active", user_id=1)
    db.add(project)
    db.flush()
    conv = Conversation(project_id=project.id, name="Interview 1", status="completed")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="hello world", word_count=2)
    db.add(seg)
    db.flush()
    code = Code(project_id=project.id, numeric_id=1, name="Positive", color="#10b981")
    db.add(code)
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=coder.id, attribution="Dr. Alvarez"))
    db.commit()

    buf = export_project(db, project.id, Path("/nonexistent"))
    with tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False) as tmp:
        tmp.write(buf.getvalue())
        tmp_path = Path(tmp.name)
    try:
        new_id, _ = import_project(db, tmp_path, Path("/tmp/docs_test"), user_id=1)
    finally:
        os.unlink(tmp_path)

    new_conv = db.query(Conversation).filter(Conversation.project_id == new_id).first()
    new_cas = (
        db.query(CodeApplication)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .filter(Segment.conversation_id == new_conv.id)
        .all()
    )
    assert len(new_cas) == 1
    # remapped to the SAME coder (matched by name) — NOT nulled
    assert new_cas[0].user_id == coder.id
    assert new_cas[0].attribution == "Dr. Alvarez"
    # matched by name → no duplicate coder created on import
    assert db.query(User).filter(User.username == "Dr. Alvarez").count() == 1


def test_code_equivalence_group_roundtrip(db_session: Session):
    """Track J · J2-3 Slab 6: a CodeEquivalenceGroup round-trips with its members'
    FK remapped AND its plain-int canonical_code_id remapped (the ADJ-4 trap), and
    the derived consensus layer is EXCLUDED from export then REGENERATED on import
    (§8 decision 4 / C2-C3) — never double-imported, and the global consensus user
    is not exported as a roster coder."""
    from app.models.user import User
    from app.models.code_equivalence_group import CodeEquivalenceGroup
    from app.services.consensus import materialize_consensus_for_project

    db = db_session
    coder_b = User(username="Coder B", password_hash=None, coder_type="human")
    db.add(coder_b)
    db.flush()

    project = Project(name="CEG Study", status="active", user_id=1)
    db.add(project)
    db.flush()
    conv = Conversation(project_id=project.id, name="Int", status="completed")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="x", word_count=1)
    db.add(seg)
    db.flush()
    pos = Code(project_id=project.id, numeric_id=1, name="Positive", color="#10b981")
    pos2 = Code(project_id=project.id, numeric_id=2, name="POSITIVE", color="#10b981")
    db.add_all([pos, pos2])
    db.flush()
    grp = CodeEquivalenceGroup(project_id=project.id, label="positive-ish", canonical_code_id=pos.id)
    db.add(grp)
    db.flush()
    pos.code_equivalence_group_id = grp.id
    pos2.code_equivalence_group_id = grp.id
    db.flush()

    # Two coders agree via the group → consensus materializes in the SOURCE.
    db.add_all([
        CodeApplication(segment_id=seg.id, code_id=pos.id, user_id=1),
        CodeApplication(segment_id=seg.id, code_id=pos2.id, user_id=coder_b.id),
    ])
    db.flush()
    materialize_consensus_for_project(db, project.id)
    db.commit()
    src_consensus = db.query(CodeApplication).filter(
        CodeApplication.origin == "consensus", CodeApplication.segment_id == seg.id
    ).all()
    assert len(src_consensus) == 1, "source has a consensus row to (wrongly) export"

    buf = export_project(db, project.id, Path("/nonexistent"))
    with tempfile.NamedTemporaryFile(suffix=".mmproject", delete=False) as tmp:
        tmp.write(buf.getvalue())
        tmp_path = Path(tmp.name)
    try:
        new_id, _ = import_project(db, tmp_path, Path("/tmp/docs_test"), user_id=1)
        db.commit()
    finally:
        os.unlink(tmp_path)

    # Group recreated with both members + canonical remapped to a NEW member id.
    new_grp = db.query(CodeEquivalenceGroup).filter(
        CodeEquivalenceGroup.project_id == new_id
    ).one()
    new_members = db.query(Code).filter(
        Code.project_id == new_id, Code.code_equivalence_group_id == new_grp.id
    ).all()
    member_ids = {c.id for c in new_members}
    assert {c.name for c in new_members} == {"Positive", "POSITIVE"}
    assert new_grp.canonical_code_id in member_ids, "canonical remapped to a live new member (not stale source id)"
    assert db.get(Code, new_grp.canonical_code_id).name == "Positive"

    # Consensus REGENERATED on import (not the verbatim source row): exactly one,
    # on the new segment, pointing at the (remapped) canonical effective code.
    new_seg = db.query(Segment).join(Conversation).filter(
        Conversation.project_id == new_id
    ).one()
    new_consensus = db.query(CodeApplication).filter(
        CodeApplication.origin == "consensus", CodeApplication.segment_id == new_seg.id
    ).all()
    assert len(new_consensus) == 1
    assert new_consensus[0].code_id in member_ids

    # The GLOBAL consensus user is shared, never exported/duplicated as a coder.
    assert db.query(User).filter(User.coder_type == "consensus").count() == 1


def test_duplicate_project_endpoint(db_session, populated_project, tmp_path, monkeypatch):
    """#464: the duplicate endpoint deep-copies a project as a fresh, independent copy.

    Exercises the endpoint (not just the service) so the export → temp-spill →
    import_mode="new" wiring + the "(copy)" rename + the audit/commit are covered.
    """
    import asyncio
    from app.routers import project_portability as pp
    from app.models.user import User

    orig = populated_project["project"]
    pid = orig.id
    orig_uuid = orig.project_uuid
    orig_name = orig.name
    orig_code_count = db_session.query(Code).filter(Code.project_id == pid).count()

    docs = tmp_path / "docs"
    media = tmp_path / "media"
    docs.mkdir()
    media.mkdir()
    monkeypatch.setattr(pp, "_get_data_dirs", lambda: (docs, media))

    user = db_session.query(User).filter(User.id == 1).first()
    result = asyncio.run(pp.duplicate_project_endpoint(pid, db=db_session, user=user))

    assert result.project_id != pid
    assert result.project_name == f"{orig_name} (copy)"
    assert result.merge_report is None

    copy = db_session.query(Project).filter(Project.id == result.project_id).first()
    assert copy is not None
    # Fresh identity (import_mode="new") so the copy can itself be exported/merged.
    assert copy.project_uuid is not None
    assert copy.project_uuid != orig_uuid
    # Codes deep-copied.
    assert (
        db_session.query(Code).filter(Code.project_id == result.project_id).count()
        == orig_code_count
    )

    # Duplicating again must NOT collide on the name — the second copy gets
    # "(copy 2)" so no two projects in the list ever share a name.
    result2 = asyncio.run(pp.duplicate_project_endpoint(pid, db=db_session, user=user))
    assert result2.project_id not in (pid, result.project_id)
    assert result2.project_name == f"{orig_name} (copy 2)"
    names = [
        p.name
        for p in db_session.query(Project).filter(Project.user_id == 1).all()
    ]
    assert len(names) == len(set(names)), f"duplicate project names: {names}"


class TestFormatVersionIsPinned:
    """The CURRENT format version must be pinned, so a bump is a deliberate act.

    Nothing pinned it before, which is how #687's v5 bump surfaced as a surprise
    failure in an unrelated declaration test that happened to hard-code `== 4`.
    A bump changes what an older build does with a file, so it should never be an
    incidental side effect of another change.
    """

    def test_current_version_is_5(self):
        from app.services.project_portability import CURRENT_FORMAT_VERSION
        assert CURRENT_FORMAT_VERSION == 5, (
            "The .mmproject format version changed. That is a real decision, not a "
            "detail: v2 = #414 identifier, v3 = the third Segment parent, v4 = #592 "
            "missing declarations, v5 = #687 code-point excerpt offsets. If this is "
            "intentional, update this pin AND document what the new version means "
            "in project_portability.py, the internal design notes, and the internal design notes."
        )


class TestPreV5OffsetRepairOnImport:
    """#687 — a pre-v5 archive carries UTF-16 excerpt offsets; convert on the way in.

    Without this, importing an old project would silently reintroduce exactly the
    drift the repair migration removed — the other door into the same defect. It is
    scoped to segments whose text actually contains an astral character, because for
    everything else the two bases coincide and the stored number is already right.

    ⚠️ **The cases below call `_repair_pre_v5_excerpt_offsets` DIRECTLY**, so none of
    them can see WHERE `import_project` calls it — which is precisely how #747's
    sibling call shipped inert, wired ~50 lines too early and handed an empty set on
    every import. `test_the_repair_is_wired_into_the_real_import` closes that: it
    enters at the pipeline's mouth. (Guard-gap sweep, 2026-08-12.)
    """

    def test_the_repair_is_wired_into_the_real_import(self, db_session, tmp_path, monkeypatch):
        """The repair must be reached, AFTER the excerpts it is supposed to repair.

        Deliberately a spy on the call rather than an end-to-end offset assertion:
        the repair only acts on a pre-v5 archive containing astral text, and the
        cases above already prove what it DOES. The open question this answers is
        only whether the pipeline reaches it with a non-empty inserted set — the
        #747 failure mode, which is invisible to every other test in this class.
        """
        from app.services import project_portability as pp
        from app.models.excerpt import Excerpt

        db = db_session
        project = Project(name="Wiring", user_id=1, project_uuid=str(uuid_module.uuid4()))
        db.add(project); db.flush()
        conv = Conversation(project_id=project.id, name="C1")
        db.add(conv); db.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=1, text="hello world")
        db.add(seg); db.flush()
        db.add(Excerpt(project_id=project.id, segment_id=seg.id, start_offset=0, end_offset=5))
        db.flush(); db.commit()

        archive = tmp_path / "p.mmproject"
        archive.write_bytes(pp.export_project(db, project.id, tmp_path / "docs").getvalue())

        seen = {}
        real = pp._repair_pre_v5_excerpt_offsets

        def spy(dbx, data, remap, inserted):
            seen["inserted"] = set(inserted)
            return real(dbx, data, remap, inserted)

        monkeypatch.setattr(pp, "_repair_pre_v5_excerpt_offsets", spy)
        new_pid, _ = pp.import_project(db, archive, tmp_path / "docs2", user_id=1)

        assert db.query(Excerpt).filter(Excerpt.project_id == new_pid).count() == 1, (
            "fixture: the import must actually have inserted an excerpt"
        )
        assert seen.get("inserted"), (
            "the repair was reached with an EMPTY inserted set — it runs before the "
            "excerpts are inserted, so it can never repair anything (#747's shape)"
        )

    ASTRAL_TEXT = "Reaction 😀 then CODE THIS PHRASE and more"
    TARGET = "CODE THIS PHRASE"

    def _utf16_index(self, text: str, needle: str) -> int:
        return len(text[: text.index(needle)].encode("utf-16-le")) // 2

    def test_astral_offsets_are_converted_from_a_v4_archive(self, db_session):
        from app.services.project_portability import _repair_pre_v5_excerpt_offsets

        project = Project(name="P", user_id=1)
        db_session.add(project)
        db_session.flush()
        conv = Conversation(project_id=project.id, name="C")
        db_session.add(conv)
        db_session.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=0,
                      text=self.ASTRAL_TEXT, word_count=7)
        db_session.add(seg)
        db_session.flush()

        # Land the excerpt with the UTF-16 offsets an old archive would carry.
        u16 = self._utf16_index(self.ASTRAL_TEXT, self.TARGET)
        exc = Excerpt(project_id=project.id, segment_id=seg.id,
                      start_offset=u16, end_offset=u16 + len(self.TARGET))
        db_session.add(exc)
        db_session.flush()

        # Pre-repair, Python slicing drifts — this is the defect, asserted.
        assert seg.text[exc.start_offset:exc.end_offset] != self.TARGET

        repaired = _repair_pre_v5_excerpt_offsets(
            db_session,
            {"format_version": 4,
             "excerpts": [{"_original_id": 1, "start_offset": u16}]},
            {"excerpts": {1: exc.id}},
            {exc.id},
        )
        assert repaired == 1
        db_session.refresh(exc)
        assert seg.text[exc.start_offset:exc.end_offset] == self.TARGET

    def test_a_v5_archive_is_left_alone(self, db_session):
        """v5 already writes code points — converting again would BREAK it."""
        from app.services.project_portability import _repair_pre_v5_excerpt_offsets

        project = Project(name="P2", user_id=1)
        db_session.add(project)
        db_session.flush()
        conv = Conversation(project_id=project.id, name="C2")
        db_session.add(conv)
        db_session.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=0,
                      text=self.ASTRAL_TEXT, word_count=7)
        db_session.add(seg)
        db_session.flush()
        cp = len(self.ASTRAL_TEXT[: self.ASTRAL_TEXT.index(self.TARGET)])
        exc = Excerpt(project_id=project.id, segment_id=seg.id,
                      start_offset=cp, end_offset=cp + len(self.TARGET))
        db_session.add(exc)
        db_session.flush()

        repaired = _repair_pre_v5_excerpt_offsets(
            db_session,
            {"format_version": 5, "excerpts": [{"_original_id": 1, "start_offset": cp}]},
            {"excerpts": {1: exc.id}},
            {exc.id},
        )
        assert repaired == 0
        db_session.refresh(exc)
        assert seg.text[exc.start_offset:exc.end_offset] == self.TARGET

    def test_a_bmp_only_segment_is_untouched_even_from_a_v4_archive(self, db_session):
        """The scope claim: BMP text already agrees in both bases."""
        from app.services.project_portability import _repair_pre_v5_excerpt_offsets

        project = Project(name="P3", user_id=1)
        db_session.add(project)
        db_session.flush()
        conv = Conversation(project_id=project.id, name="C3")
        db_session.add(conv)
        db_session.flush()
        text = "مرحبا then CODE THIS PHRASE and more"  # RTL, all BMP
        seg = Segment(conversation_id=conv.id, sequence_order=0, text=text, word_count=6)
        db_session.add(seg)
        db_session.flush()
        start = text.index(self.TARGET)
        exc = Excerpt(project_id=project.id, segment_id=seg.id,
                      start_offset=start, end_offset=start + len(self.TARGET))
        db_session.add(exc)
        db_session.flush()

        repaired = _repair_pre_v5_excerpt_offsets(
            db_session,
            {"format_version": 4, "excerpts": [{"_original_id": 1, "start_offset": start}]},
            {"excerpts": {1: exc.id}},
            {exc.id},
        )
        assert repaired == 0
        db_session.refresh(exc)
        assert seg.text[exc.start_offset:exc.end_offset] == self.TARGET

    TAIL = "and more"

    def test_a_merge_converts_what_it_inserted_and_leaves_matched_rows_alone(
        self, db_session, tmp_path,
    ):
        """#714 — the repair must run on the rows it WROTE, and only those.

        Driven through the REAL merge path, because the defect was never in the
        arithmetic — it was in WHICH rows the arithmetic ran on. Under
        `import_mode="merge"` an incoming excerpt matches an existing local one by
        uuid; that is the designed multi-coder flow, and those matched rows are
        precisely the quotes both copies already share. They live in the target and
        already hold code points, so converting them a second time shifts them one
        place per preceding astral character — silently, permanently, on data the
        import never wrote.

        ⚠️ The scenario needs BOTH arms in one merge, and that is not fussiness. A
        merge where every excerpt matches leaves the inserted set EMPTY, so the
        function's early return fires and a broken filter below it is masked — a
        mutation of the filter survives such a test. Here the colleague's file also
        carries a quote the target does not have, so the set is non-empty and the
        filter is the only thing standing between the matched row and a rewrite.

        Story: a colleague still on an older build sends their copy back. Their file
        is in the old UTF-16 basis throughout. The target has since been migrated, so
        its shared quote is already correct, and it never had the second quote.
        """
        project = Project(name="Merge astral", user_id=1, project_uuid=str(uuid_module.uuid4()))
        db_session.add(project)
        db_session.flush()
        conv = Conversation(project_id=project.id, name="C")
        db_session.add(conv)
        db_session.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=0,
                      text=self.ASTRAL_TEXT, word_count=7)
        db_session.add(seg)
        db_session.flush()

        # Both quotes as the OLD build stored them — UTF-16, the browser's basis.
        shared_u16 = self._utf16_index(self.ASTRAL_TEXT, self.TARGET)
        tail_u16 = self._utf16_index(self.ASTRAL_TEXT, self.TAIL)
        shared = Excerpt(project_id=project.id, segment_id=seg.id,
                         start_offset=shared_u16, end_offset=shared_u16 + len(self.TARGET))
        tail = Excerpt(project_id=project.id, segment_id=seg.id,
                       start_offset=tail_u16, end_offset=tail_u16 + len(self.TAIL))
        db_session.add_all([shared, tail])
        db_session.flush()
        shared_id = tail_uuid = None
        shared_id, tail_uuid = shared.id, tail.uuid

        # The colleague's file: everything in the old basis, labelled v4.
        buf = export_project(db_session, project.id, tmp_path / "docs")
        current = tmp_path / "current.mmproject"
        current.write_bytes(buf.getvalue())
        old_file = tmp_path / "v4.mmproject"
        with zipfile.ZipFile(current, "r") as zin, zipfile.ZipFile(old_file, "w") as zout:
            for entry in zin.infolist():
                payload = zin.read(entry.filename)
                if entry.filename in ("manifest.json", "project.json"):
                    obj = json.loads(payload)
                    obj["format_version"] = 4
                    payload = json.dumps(obj).encode()
                zout.writestr(entry, payload)

        # The target moved on: migration a1b2c3d4e5f7 converted the shared quote,
        # and the second quote is not here at all (so the merge must insert it).
        shared_cp = self.ASTRAL_TEXT.index(self.TARGET)
        shared.start_offset, shared.end_offset = shared_cp, shared_cp + len(self.TARGET)
        db_session.delete(tail)
        db_session.flush()
        assert self.ASTRAL_TEXT[shared.start_offset:shared.end_offset] == self.TARGET

        import_project(db_session, old_file, tmp_path / "docs2", user_id=1,
                       import_mode="merge", target_project_id=project.id)
        db_session.flush()

        seg_after = db_session.query(Segment).filter(Segment.id == seg.id).first()
        matched = db_session.query(Excerpt).filter(Excerpt.id == shared_id).first()
        inserted = db_session.query(Excerpt).filter(Excerpt.uuid == tail_uuid).first()

        # Arm 1 — matched by uuid, so already correct and NOT ours to rewrite.
        assert seg_after.text[matched.start_offset:matched.end_offset] == self.TARGET, (
            "a merge-matched excerpt was re-converted: its offsets were already code "
            "points, so the pre-v5 repair must skip it (#714)"
        )
        # Arm 2 — non-vacuity. This row DID come out of the v4 file, so the repair
        # must still have run; without it the assertion above passes for the wrong
        # reason (a repair that simply stopped working).
        assert inserted is not None
        assert seg_after.text[inserted.start_offset:inserted.end_offset] == self.TAIL, (
            "an excerpt this import INSERTED from a v4 archive was left in the UTF-16 "
            "basis — the #714 fix must narrow the repair, not disable it"
        )
