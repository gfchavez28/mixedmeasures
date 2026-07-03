"""Tests for project portability (export/import) and codebook exchange."""

import json
import os
import tempfile
import zipfile
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
    export_project,
    import_project,
    validate_project_file,
)
from app.services.codebook_exchange import (
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
    db.add_all([seg1, seg2, doc_seg])
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
    db.add(ca1)
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
    db.add_all([note1, note2, note3])
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
    db.add_all([memo_project, memo_conv, memo_doc, memo_code, memo_cat, memo_ds])
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
        "segment_group": sg,
        "segments": [seg1, seg2, doc_seg],
        "categories": [cat1, cat2],
        "codes": [code1, code2, code3],
        "dataset": ds,
        "col1": col1,
        "columns": [col1, col2, col_comp],
        "rows": [row1],
        "values": [val1, val2, val_comp],
        "recode": recode,
        "excerpt": exc,
        "notes": [note1, note2, note3],
        "memos": [memo_project, memo_conv, memo_doc, memo_code, memo_cat, memo_ds, memo_analysis, memo_canvas],
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
        assert len(data["segments"]) == 3
        assert len(data["code_categories"]) == 2
        assert len(data["codes"]) == 3
        assert len(data["code_applications"]) == 2
        assert len(data["notes"]) == 3
        assert len(data["memos"]) == 8
        assert len(data["excerpts"]) == 1
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
        assert 'origin="Mixed Measures"' in xml_str
        assert 'isCodable="false"' in xml_str  # categories
        assert 'isCodable="true"' in xml_str   # codes

    def test_qdc_excludes_inactive(self, db_session, populated_project):
        pid = populated_project["project"].id
        xml_str = export_codebook_qdc(db_session, pid)
        assert "Inactive Code" not in xml_str


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
        <CodeBook origin="Test" xmlns="urn:QDA-XML:codebook:1:0">
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
        <CodeBook origin="Test" xmlns="urn:QDA-XML:codebook:1:0">
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
        <CodeBook origin="Test" xmlns="urn:QDA-XML:codebook:1:0">
          <Codes>
            <Code guid="c1" name="ImplicitCategory" color="#ff0000">
              <Code guid="c2" name="ImplicitCode" color="#00ff00"/>
            </Code>
          </Codes>
        </CodeBook>'''

        counts = import_codebook_qdc(db_session, project.id, xml)
        assert counts["categories_created"] == 1  # parent defaults to category
        assert counts["codes_created"] == 1        # leaf defaults to code


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
