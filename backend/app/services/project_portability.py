"""Project portability service — export and import .mmproject files.

Handles serialization of all project-scoped entities to JSON,
ZIP packaging with document files, and full import with ID remapping.
"""

import enum
import io
import json
import logging
import os
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from ..models import (
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
from ..services.backup import APP_VERSION
from ..services.canvas import (
    EMBED_NODE_TYPES,
    EMBED_TYPE_MAP,
    extract_referenced_source_ids,
    walk_tiptap_nodes,
)

logger = logging.getLogger(__name__)

CURRENT_FORMAT_VERSION = 1
MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 500 MB


# ── Serialization helpers ───────────────────────────────────────────────

def _get_columns(model) -> list[str]:
    """Get column names for an ORM model class."""
    return list(sa_inspect(model).columns.keys())


def _serialize_row(obj, columns: list[str]) -> dict:
    """Serialize an ORM object to a dict with _original_id."""
    data = {"_original_id": obj.id}
    for col in columns:
        if col == "id":
            continue
        val = getattr(obj, col)
        if isinstance(val, datetime):
            data[col] = val.isoformat()
        elif isinstance(val, enum.Enum):
            data[col] = val.value
        else:
            data[col] = val
    return data


def _serialize_all(objects, columns: list[str]) -> list[dict]:
    """Serialize a list of ORM objects."""
    return [_serialize_row(obj, columns) for obj in objects]


# ── Export ──────────────────────────────────────────────────────────────

def export_project(db: Session, project_id: int, docs_dir: Path, media_dir: Path | None = None) -> io.BytesIO:
    """Export a project as an in-memory .mmproject ZIP.

    Returns a BytesIO buffer containing the ZIP. Raises ValueError
    if the project is not found.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise ValueError(f"Project {project_id} not found")

    # Pre-compute column lists once
    cols = {
        m: _get_columns(m)
        for m in [
            Project, Participant, Speaker, Conversation, Document,
            SegmentGroup, Segment, CodeCategory, Code, CodeApplication,
            Note, Memo, Excerpt, Dataset, DatasetColumn, DatasetRow,
            DatasetValue, RecodeDefinition, EquivalenceGroup,
            AnalysisDomain, AnalysisDomainMember, MetricDefinition,
            ComputedResult, RowScore, StatisticalTest,
            MaterialCollection, Material, ScratchpadEntry,
            TextCodingConfig, QuoteBoardConfig,
            Canvas, CanvasTheme,
            CanvasThemeRelationship, CanvasPendingItem,
        ]
    }

    # ── Query all entities ──────────────────────────────────────────

    participants = db.query(Participant).filter(
        Participant.project_id == project_id
    ).all()

    speakers = db.query(Speaker).filter(
        Speaker.project_id == project_id
    ).all()

    conversations = db.query(Conversation).filter(
        Conversation.project_id == project_id
    ).all()
    conv_ids = [c.id for c in conversations]

    documents = db.query(Document).filter(
        Document.project_id == project_id
    ).all()
    doc_ids = [d.id for d in documents]

    segment_groups = db.query(SegmentGroup).filter(
        SegmentGroup.conversation_id.in_(conv_ids)
    ).all() if conv_ids else []

    segments = []
    if conv_ids:
        segments.extend(
            db.query(Segment).filter(Segment.conversation_id.in_(conv_ids)).all()
        )
    if doc_ids:
        segments.extend(
            db.query(Segment).filter(Segment.document_id.in_(doc_ids)).all()
        )
    segment_ids = [s.id for s in segments]

    code_categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()

    codes = db.query(Code).filter(
        Code.project_id == project_id
    ).all()

    # CodeApplications: via segments or dataset values
    datasets = db.query(Dataset).filter(
        Dataset.project_id == project_id
    ).all()
    dataset_ids = [d.id for d in datasets]

    dataset_columns = db.query(DatasetColumn).filter(
        DatasetColumn.dataset_id.in_(dataset_ids)
    ).all() if dataset_ids else []
    col_ids = [c.id for c in dataset_columns]

    dataset_rows = db.query(DatasetRow).filter(
        DatasetRow.dataset_id.in_(dataset_ids)
    ).all() if dataset_ids else []
    row_ids = [r.id for r in dataset_rows]

    dataset_values = db.query(DatasetValue).filter(
        DatasetValue.row_id.in_(row_ids)
    ).all() if row_ids else []
    value_ids = [v.id for v in dataset_values]

    code_applications = []
    if segment_ids:
        code_applications.extend(
            db.query(CodeApplication).filter(
                CodeApplication.segment_id.in_(segment_ids)
            ).all()
        )
    if value_ids:
        code_applications.extend(
            db.query(CodeApplication).filter(
                CodeApplication.dataset_value_id.in_(value_ids)
            ).all()
        )

    notes = []
    if conv_ids:
        notes.extend(
            db.query(Note).filter(Note.conversation_id.in_(conv_ids)).all()
        )
    if value_ids:
        notes.extend(
            db.query(Note).filter(Note.dataset_value_id.in_(value_ids)).all()
        )
    if doc_ids:
        notes.extend(
            db.query(Note).filter(Note.document_id.in_(doc_ids)).all()
        )

    memos = db.query(Memo).filter(
        Memo.project_id == project_id
    ).all()

    excerpts = db.query(Excerpt).filter(
        Excerpt.project_id == project_id
    ).all()

    recode_definitions = db.query(RecodeDefinition).filter(
        RecodeDefinition.column_id.in_(col_ids)
    ).all() if col_ids else []

    equivalence_groups = db.query(EquivalenceGroup).filter(
        EquivalenceGroup.project_id == project_id
    ).all()

    analysis_domains = db.query(AnalysisDomain).filter(
        AnalysisDomain.project_id == project_id
    ).all()
    domain_ids = [d.id for d in analysis_domains]

    analysis_domain_members = db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.domain_id.in_(domain_ids)
    ).all() if domain_ids else []

    metric_definitions = db.query(MetricDefinition).filter(
        MetricDefinition.project_id == project_id
    ).all()
    metric_ids = [m.id for m in metric_definitions]

    computed_results = db.query(ComputedResult).filter(
        ComputedResult.metric_definition_id.in_(metric_ids)
    ).all() if metric_ids else []

    row_scores = db.query(RowScore).filter(
        RowScore.metric_definition_id.in_(metric_ids)
    ).all() if metric_ids else []

    statistical_tests = db.query(StatisticalTest).filter(
        StatisticalTest.project_id == project_id
    ).all()

    material_collections = db.query(MaterialCollection).filter(
        MaterialCollection.project_id == project_id
    ).all()
    collection_ids = [c.id for c in material_collections]

    materials_list = db.query(Material).filter(
        Material.collection_id.in_(collection_ids)
    ).all() if collection_ids else []

    canvases = db.query(Canvas).filter(
        Canvas.project_id == project_id
    ).all()
    canvas_ids = [c.id for c in canvases]

    canvas_themes = db.query(CanvasTheme).filter(
        CanvasTheme.canvas_id.in_(canvas_ids)
    ).all() if canvas_ids else []
    canvas_theme_ids = [t.id for t in canvas_themes]

    canvas_theme_relationships = db.query(CanvasThemeRelationship).filter(
        CanvasThemeRelationship.canvas_id.in_(canvas_ids)
    ).all() if canvas_ids else []

    canvas_pending_items = db.query(CanvasPendingItem).filter(
        CanvasPendingItem.canvas_id.in_(canvas_ids)
    ).all() if canvas_ids else []

    scratchpad_entries = db.query(ScratchpadEntry).filter(
        ScratchpadEntry.project_id == project_id
    ).all()

    text_coding_config = db.query(TextCodingConfig).filter(
        TextCodingConfig.project_id == project_id
    ).first()

    quote_board_config = db.query(QuoteBoardConfig).filter(
        QuoteBoardConfig.project_id == project_id
    ).first()

    # ── Serialize ───────────────────────────────────────────────────

    project_data = {
        "project": _serialize_row(project, cols[Project]),
        "participants": _serialize_all(participants, cols[Participant]),
        "speakers": _serialize_all(speakers, cols[Speaker]),
        "conversations": _serialize_all(conversations, cols[Conversation]),
        "documents": _serialize_all(documents, cols[Document]),
        "segment_groups": _serialize_all(segment_groups, cols[SegmentGroup]),
        "segments": _serialize_all(segments, cols[Segment]),
        "code_categories": _serialize_all(code_categories, cols[CodeCategory]),
        "codes": _serialize_all(codes, cols[Code]),
        "code_applications": _serialize_all(code_applications, cols[CodeApplication]),
        "notes": _serialize_all(notes, cols[Note]),
        "memos": _serialize_all(memos, cols[Memo]),
        "excerpts": _serialize_all(excerpts, cols[Excerpt]),
        "datasets": _serialize_all(datasets, cols[Dataset]),
        "dataset_columns": _serialize_all(dataset_columns, cols[DatasetColumn]),
        "dataset_rows": _serialize_all(dataset_rows, cols[DatasetRow]),
        "dataset_values": _serialize_all(dataset_values, cols[DatasetValue]),
        "recode_definitions": _serialize_all(recode_definitions, cols[RecodeDefinition]),
        "equivalence_groups": _serialize_all(equivalence_groups, cols[EquivalenceGroup]),
        "analysis_domains": _serialize_all(analysis_domains, cols[AnalysisDomain]),
        "analysis_domain_members": _serialize_all(analysis_domain_members, cols[AnalysisDomainMember]),
        "metric_definitions": _serialize_all(metric_definitions, cols[MetricDefinition]),
        "computed_results": _serialize_all(computed_results, cols[ComputedResult]),
        "row_scores": _serialize_all(row_scores, cols[RowScore]),
        "statistical_tests": _serialize_all(statistical_tests, cols[StatisticalTest]),
        "material_collections": _serialize_all(material_collections, cols[MaterialCollection]),
        "materials": _serialize_all(materials_list, cols[Material]),
        "canvases": _serialize_all(canvases, cols[Canvas]),
        "canvas_themes": _serialize_all(canvas_themes, cols[CanvasTheme]),
        "canvas_theme_relationships": _serialize_all(canvas_theme_relationships, cols[CanvasThemeRelationship]),
        "canvas_pending_items": _serialize_all(canvas_pending_items, cols[CanvasPendingItem]),
        "scratchpad_entries": _serialize_all(scratchpad_entries, cols[ScratchpadEntry]),
        "text_coding_config": (
            _serialize_row(text_coding_config, cols[TextCodingConfig])
            if text_coding_config else None
        ),
        "quote_board_config": (
            _serialize_row(quote_board_config, cols[QuoteBoardConfig])
            if quote_board_config else None
        ),
    }

    # ── Build manifest ──────────────────────────────────────────────

    manifest = {
        "format_version": CURRENT_FORMAT_VERSION,
        "format_type": "mmproject",
        "app_version": APP_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "project_name": project.name,
        "project_summary": {
            "conversation_count": len(conversations),
            "dataset_count": len(datasets),
            "document_count": len(documents),
            "code_count": len(codes),
            "category_count": len(code_categories),
            "memo_count": len(memos),
            "participant_count": len(participants),
            "excerpt_count": len(excerpts),
            "canvas_count": len(canvases),
            "canvas_theme_count": len(canvas_themes),
        },
    }

    # ── Write ZIP ───────────────────────────────────────────────────

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        zf.writestr("project.json", json.dumps(project_data, indent=2))

        # Add document files
        project_docs_dir = docs_dir / str(project_id)
        for doc in documents:
            doc_dir = project_docs_dir / str(doc.id)
            if not doc_dir.is_dir():
                logger.warning(
                    "Document directory not found on disk: %s (doc %d)",
                    doc_dir, doc.id,
                )
                continue
            for root, _dirs, files in os.walk(doc_dir):
                for fname in files:
                    file_path = Path(root) / fname
                    arcname = f"documents/{doc.id}/{file_path.relative_to(doc_dir)}"
                    zf.write(str(file_path), arcname)

        # Add media files (audio per conversation)
        if media_dir is not None:
            project_media_dir = media_dir / str(project_id)
            if project_media_dir.is_dir():
                for conv_id_dir in project_media_dir.iterdir():
                    if conv_id_dir.is_dir():
                        for file_path in conv_id_dir.rglob("*"):
                            if file_path.is_file():
                                arcname = f"media/{conv_id_dir.name}/{file_path.relative_to(conv_id_dir)}"
                                zf.write(str(file_path), arcname)

    buf.seek(0)
    return buf


# ── Validation ──────────────────────────────────────────────────────────

def _read_manifest_and_check_format(zf: zipfile.ZipFile) -> dict:
    """Read manifest.json and enforce the format gate. Returns the manifest.

    Shared by validate_project_file AND import_project: the UI calls
    /validate-import before /import-project, but direct API and script imports
    skip validation, so the import path must refuse a newer-format file
    gracefully on its own — a future format bump only degrades safely on v1.0
    installs if this check ships in them. Raises ValueError for a missing
    manifest/project.json, a non-mmproject format_type (e.g. a .mmbackup posted
    here by mistake), or a file written by a newer app version.
    """
    names = zf.namelist()
    if "manifest.json" not in names:
        raise ValueError("Invalid project file: missing manifest.json")
    if "project.json" not in names:
        raise ValueError("Invalid project file: missing project.json")

    manifest = json.loads(zf.read("manifest.json"))

    if manifest.get("format_type") != "mmproject":
        raise ValueError(
            f"Invalid format_type: {manifest.get('format_type')} "
            f"(expected 'mmproject')"
        )

    file_version = manifest.get("format_version", 0)
    if file_version > CURRENT_FORMAT_VERSION:
        raise ValueError(
            f"This file was created by a newer version of Mixed Measures "
            f"(format version {file_version}). Please update to import it."
        )
    return manifest


def validate_project_file(file_path: Path) -> dict:
    """Validate an .mmproject ZIP and return manifest + warnings.

    Returns dict with keys: manifest (dict), warnings (list[str]).
    Raises ValueError for invalid files.
    """
    if not file_path.exists():
        raise ValueError("File not found")

    try:
        with zipfile.ZipFile(str(file_path), "r") as zf:
            # Zip-slip prevention
            for name in zf.namelist():
                if name.startswith("/") or ".." in name:
                    raise ValueError(f"Invalid project file: suspicious path '{name}'")

            manifest = _read_manifest_and_check_format(zf)

            warnings: list[str] = []
            file_version = manifest.get("format_version", 0)

            if file_version < CURRENT_FORMAT_VERSION:
                warnings.append(
                    f"File uses an older format version ({file_version}). "
                    f"Some data may not import correctly."
                )

            file_app_version = manifest.get("app_version", "unknown")
            if file_app_version != APP_VERSION:
                warnings.append(
                    f"Exported from app version {file_app_version} "
                    f"(current: {APP_VERSION})."
                )

            return {"manifest": manifest, "warnings": warnings}

    except zipfile.BadZipFile:
        raise ValueError("Invalid project file: not a valid ZIP file")


# ── Import ──────────────────────────────────────────────────────────────

# Polymorphic remap tables for Memo.entity_type → remap dict name
MEMO_ENTITY_REMAP = {
    "project": "projects",
    "conversation": "conversations",
    "document": "documents",
    "code": "codes",
    "code_category": "code_categories",
    "analysis": "materials",
    "dataset": "datasets",
    "dataset_row": "dataset_rows",
    "dataset_column": "dataset_columns",
    "canvas": "canvases",
}

# Material config JSON keys that contain entity IDs needing remapping
MATERIAL_CONFIG_REMAP = {
    # key → (remap_table_name, is_array)
    "column_ids": ("dataset_columns", True),
    "domain_ids": ("analysis_domains", True),
    "grouping_column_id": ("dataset_columns", False),
    "grouping_column_id_2": ("dataset_columns", False),
    "cross_tab_column_id": ("dataset_columns", False),
    "code_ids": ("codes", True),
    "conversation_ids": ("conversations", True),
    "document_ids": ("documents", True),
    "text_column_ids": ("dataset_columns", True),
    "comment_column_ids": ("dataset_columns", True),  # backward compat with old .mmproject files
    "content_code_id": ("codes", False),
    "participant_ids": ("participants", True),
    "custom_order": ("codes", True),
}


def _build_entity(model, item: dict, overrides: dict | None = None) -> object:
    """Construct an ORM entity from an export dict.

    Only sets fields that exist as columns on the model.
    DateTime columns are parsed from ISO strings.
    The _original_id key is skipped.
    ``overrides`` takes precedence over ``item`` values.
    """
    columns = sa_inspect(model).columns
    valid_cols = set(columns.keys()) - {"id"}
    kwargs = {}
    for col in valid_cols:
        if overrides and col in overrides:
            kwargs[col] = overrides[col]
        elif col in item:
            val = item[col]
            # Parse datetime strings by COLUMN TYPE, not name suffix. The old
            # `col.endswith("_at")` check missed non-_at DateTime columns
            # (e.g. Conversation.conversation_date), passing a raw ISO string to a
            # DateTime column and crashing import.
            if isinstance(val, str) and _is_datetime_column(columns[col]):
                kwargs[col] = _parse_datetime(val)
            else:
                kwargs[col] = val
    return model(**kwargs)


def _is_datetime_column(column) -> bool:
    """True if the column maps to a Python datetime/date (parse ISO strings)."""
    from datetime import date

    try:
        return issubclass(column.type.python_type, (datetime, date))
    except (NotImplementedError, AttributeError):
        return False


def _remap_id(remap: dict, table: str, old_id, warn_context: str = "") -> int | None:
    """Remap a single ID, returning None if not found."""
    if old_id is None:
        return None
    table_remap = remap.get(table, {})
    new_id = table_remap.get(old_id)
    if new_id is None and old_id is not None:
        logger.warning("Unmapped ID: %s[%s] %s", table, old_id, warn_context)
    return new_id


def _remap_material_config(config_json: str | None, remap: dict) -> str | None:
    """Remap entity IDs inside a Material config JSON string."""
    if not config_json:
        return config_json
    try:
        config = json.loads(config_json)
    except (json.JSONDecodeError, TypeError):
        return config_json

    for key, (table, is_array) in MATERIAL_CONFIG_REMAP.items():
        if key not in config or config[key] is None:
            continue
        table_remap = remap.get(table, {})
        if is_array and isinstance(config[key], list):
            config[key] = [
                table_remap.get(v, v) for v in config[key]
                if isinstance(v, int)
            ]
        elif not is_array and isinstance(config[key], int):
            new_val = table_remap.get(config[key])
            if new_val is not None:
                config[key] = new_val
            else:
                logger.warning(
                    "Material config: unmapped %s=%s", key, config[key]
                )

    return json.dumps(config)


# Canvas embed/pending source_type → remap-table name. The embed source_type
# comes from services.canvas.EMBED_TYPE_MAP; pending items use the same vocabulary
# via CanvasPendingItem.item_type ("excerpt" | "material" | "memo").
CANVAS_SOURCE_REMAP = {
    "excerpt": "excerpts",
    "material": "materials",
    "memo": "memos",
}


def _remap_canvas_content(content_json: str | None, remap: dict) -> tuple[str | None, str | None]:
    """Remap embedded entity IDs inside a CanvasTheme.content Tiptap JSON string.

    Walks excerpt-embed/chart-embed/memo-embed nodes and rewrites their
    excerptId/materialId/memoId attrs through the import remaps, then re-derives
    referenced_source_ids from the rewritten content (rather than carrying the
    stale denormalized array). Returns ``(content_json, referenced_source_ids_json)``,
    both serialized strings (or None when empty), mirroring update_theme_content.
    """
    if not content_json:
        return content_json, None
    try:
        content = json.loads(content_json)
    except (json.JSONDecodeError, TypeError):
        return content_json, None

    def _rewrite(node: dict) -> None:
        attrs = node.get("attrs")
        if not isinstance(attrs, dict):
            return
        source_type, id_key = EMBED_TYPE_MAP[node["type"]]
        old_id = attrs.get(id_key)
        if not isinstance(old_id, int):
            return
        table = CANVAS_SOURCE_REMAP[source_type]
        new_id = remap.get(table, {}).get(old_id)
        if new_id is not None:
            attrs[id_key] = new_id
        else:
            logger.warning(
                "Canvas embed: unmapped %s %s=%s", node["type"], id_key, old_id
            )

    walk_tiptap_nodes(content, EMBED_NODE_TYPES, _rewrite)

    refs = extract_referenced_source_ids(content)
    return json.dumps(content), (json.dumps(refs) if refs else None)


def _remap_json_id_array(
    json_str: str | None, remap: dict, table: str,
) -> str | None:
    """Parse a JSON array of IDs, remap each, re-serialize."""
    if not json_str:
        return json_str
    try:
        ids = json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return json_str
    if not isinstance(ids, list):
        return json_str
    table_remap = remap.get(table, {})
    remapped = [table_remap.get(v, v) for v in ids if isinstance(v, int)]
    return json.dumps(remapped)


def _remap_quote_board_orders(
    json_str: str | None, remap: dict,
) -> str | None:
    """Remap QuoteBoardConfig custom_orders JSON.

    Keys: "code-{id}", "cat-{id}", "all", "code-uncoded",
          "cat-uncategorized", "cat-none", "src-{name}"
    Values: arrays of excerpt IDs
    """
    if not json_str:
        return json_str
    try:
        orders = json.loads(json_str)
    except (json.JSONDecodeError, TypeError):
        return json_str
    if not isinstance(orders, dict):
        return json_str

    code_remap = remap.get("codes", {})
    cat_remap = remap.get("code_categories", {})
    excerpt_remap = remap.get("excerpts", {})
    result = {}

    for key, value in orders.items():
        new_key = key

        # Remap code-{id} keys
        m = re.match(r"^code-(\d+)$", key)
        if m:
            old_id = int(m.group(1))
            new_id = code_remap.get(old_id)
            if new_id is None:
                continue  # drop stale entry
            new_key = f"code-{new_id}"

        # Remap cat-{id} keys
        m = re.match(r"^cat-(\d+)$", key)
        if m:
            old_id = int(m.group(1))
            new_id = cat_remap.get(old_id)
            if new_id is None:
                continue
            new_key = f"cat-{new_id}"

        # Remap excerpt IDs in values
        if isinstance(value, list):
            new_value = []
            for eid in value:
                if isinstance(eid, int):
                    new_eid = excerpt_remap.get(eid)
                    if new_eid is not None:
                        new_value.append(new_eid)
                    # drop unmapped excerpt IDs
            result[new_key] = new_value
        else:
            result[new_key] = value

    return json.dumps(result)


def _parse_datetime(val) -> datetime | None:
    """Parse an ISO datetime string back to a datetime object."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    return datetime.fromisoformat(val)


def import_project(db: Session, file_path: Path, docs_dir: Path, media_dir: Path | None = None, user_id: int | None = None) -> tuple[int, str]:
    """Import an .mmproject ZIP, creating a new project.

    Returns (new_project_id, project_name).
    Wraps everything in the caller's transaction — caller commits or rolls back.
    """
    with zipfile.ZipFile(str(file_path), "r") as zf:
        # Zip-slip prevention (matches validate_project_file check)
        for name in zf.namelist():
            if name.startswith("/") or ".." in name:
                raise ValueError(f"Invalid project file: suspicious path '{name}'")

        # Format gate — must run here too, not just in /validate-import (see helper docstring)
        _read_manifest_and_check_format(zf)

        data = json.loads(zf.read("project.json"))

        remap: dict[str, dict[int, int]] = {
            "projects": {}, "participants": {}, "speakers": {},
            "conversations": {}, "documents": {}, "segment_groups": {},
            "segments": {}, "code_categories": {}, "codes": {},
            "datasets": {}, "equivalence_groups": {}, "dataset_columns": {},
            "dataset_rows": {}, "dataset_values": {}, "recode_definitions": {},
            "excerpts": {}, "notes": {}, "memos": {}, "analysis_domains": {},
            "metric_definitions": {}, "material_collections": {},
            "materials": {}, "scratchpad_entries": {},
            "canvases": {}, "canvas_themes": {},
            "canvas_pending_items": {},
        }

        def _add(model, item, overrides=None, remap_key=None):
            """Build entity from export dict, add to session, track in remap."""
            obj = _build_entity(model, item, overrides)
            db.add(obj)
            db.flush()
            if remap_key:
                remap[remap_key][item["_original_id"]] = obj.id
            return obj

        # ── a. Project ──────────────────────────────────────────────
        pdata = data["project"]
        project_name = pdata["name"]
        existing = db.query(Project).filter(Project.name == project_name).first()
        if existing:
            project_name = f"{project_name} (imported)"

        project_overrides = {"name": project_name}
        if user_id is not None:
            project_overrides["user_id"] = user_id
        new_project = _add(Project, pdata, project_overrides, "projects")
        pid = new_project.id

        # ── b–e. Simple FK-to-project entities ─────────────────────
        for item in data.get("participants", []):
            _add(Participant, item, {"project_id": pid}, "participants")

        for item in data.get("speakers", []):
            _add(Speaker, item, {
                "project_id": pid,
                "participant_id": _remap_id(remap, "participants", item.get("participant_id")),
            }, "speakers")

        for item in data.get("conversations", []):
            _add(Conversation, item, {"project_id": pid}, "conversations")

        for item in data.get("documents", []):
            _add(Document, item, {"project_id": pid}, "documents")

        # ── f. SegmentGroups ───────────────────────────────────────
        for item in data.get("segment_groups", []):
            _add(SegmentGroup, item, {
                "conversation_id": _remap_id(remap, "conversations", item.get("conversation_id")),
            }, "segment_groups")

        # ── g. Segments (two-pass for self-refs) ───────────────────
        segment_self_refs = []
        for item in data.get("segments", []):
            _add(Segment, item, {
                "conversation_id": _remap_id(remap, "conversations", item.get("conversation_id")),
                "document_id": _remap_id(remap, "documents", item.get("document_id")),
                "speaker_id": _remap_id(remap, "speakers", item.get("speaker_id")),
                "group_id": _remap_id(remap, "segment_groups", item.get("group_id")),
                "merged_into_id": None,
                "split_into_id": None,
            }, "segments")
            if item.get("merged_into_id") or item.get("split_into_id"):
                segment_self_refs.append(item)

        for item in segment_self_refs:
            new_id = remap["segments"][item["_original_id"]]
            updates = {}
            if item.get("merged_into_id"):
                updates["merged_into_id"] = remap["segments"].get(item["merged_into_id"])
            if item.get("split_into_id"):
                updates["split_into_id"] = remap["segments"].get(item["split_into_id"])
            if updates:
                db.query(Segment).filter(Segment.id == new_id).update(updates)
        if segment_self_refs:
            db.flush()

        # ── h. CodeCategories (topological order) ──────────────────
        _import_categories_topological(db, data.get("code_categories", []), pid, remap)

        # ── i. Codes ───────────────────────────────────────────────
        for item in data.get("codes", []):
            _add(Code, item, {
                "project_id": pid,
                "category_id": _remap_id(remap, "code_categories", item.get("category_id")),
            }, "codes")

        # ── j–k. Datasets & EquivalenceGroups ─────────────────────
        for item in data.get("datasets", []):
            _add(Dataset, item, {"project_id": pid}, "datasets")

        for item in data.get("equivalence_groups", []):
            _add(EquivalenceGroup, item, {"project_id": pid}, "equivalence_groups")

        # ── l. DatasetColumns ──────────────────────────────────────
        # Pre-flight: enforce 1:1 column-per-dataset on incoming equivalence
        # group memberships. A valid export should never carry a violation,
        # but a legacy or hand-edited .mmproject could. Fail loudly with a
        # clear message rather than letting the schema constraint raise a
        # confusing IntegrityError mid-import (see #289).
        _eg_dataset_seen: dict[tuple[int, int], int] = {}  # (eg_id, ds_id) -> original column id
        _eg_violations: list[dict] = []
        for item in data.get("dataset_columns", []):
            eg_id = item.get("equivalence_group_id")
            ds_id = item.get("dataset_id")
            col_id = item.get("id")
            if eg_id is not None and ds_id is not None:
                key = (eg_id, ds_id)
                if key in _eg_dataset_seen:
                    _eg_violations.append({
                        "equivalence_group_id": eg_id,
                        "dataset_id": ds_id,
                        "column_ids": [_eg_dataset_seen[key], col_id],
                    })
                else:
                    _eg_dataset_seen[key] = col_id
        if _eg_violations:
            raise ValueError(
                "Cannot import project: equivalence groups must contain at most "
                "one column per dataset, but the incoming file has "
                f"{len(_eg_violations)} violation(s): {_eg_violations}. "
                "This usually means the project was exported from an older "
                "version of Mixed Measures before the 1:1 constraint was "
                "enforced. Repair the source project (unlink the conflicting "
                "columns, or consolidate them into a computed column) and "
                "re-export before importing."
            )

        _LEGACY_COLUMN_TYPE = {"open_short": "open_text", "open_long": "open_text"}
        for item in data.get("dataset_columns", []):
            ct = item.get("column_type")
            if ct in _LEGACY_COLUMN_TYPE:
                item["column_type"] = _LEGACY_COLUMN_TYPE[ct]
            _add(DatasetColumn, item, {
                "dataset_id": _remap_id(remap, "datasets", item.get("dataset_id")),
                "equivalence_group_id": _remap_id(remap, "equivalence_groups", item.get("equivalence_group_id")),
                "depends_on_column_ids": _remap_json_id_array(
                    item.get("depends_on_column_ids"), remap, "dataset_columns"
                ),
            }, "dataset_columns")

        # ── m. DatasetRows ─────────────────────────────────────────
        for item in data.get("dataset_rows", []):
            _add(DatasetRow, item, {
                "dataset_id": _remap_id(remap, "datasets", item.get("dataset_id")),
                "participant_id": _remap_id(remap, "participants", item.get("participant_id")),
            }, "dataset_rows")

        # ── n. DatasetValues ───────────────────────────────────────
        for item in data.get("dataset_values", []):
            _add(DatasetValue, item, {
                "row_id": _remap_id(remap, "dataset_rows", item.get("row_id")),
                "column_id": _remap_id(remap, "dataset_columns", item.get("column_id")),
            }, "dataset_values")

        # ── o. RecodeDefinitions (topological) ─────────────────────
        _import_recodes_topological(db, data.get("recode_definitions", []), remap)

        # ── p. Excerpts ────────────────────────────────────────────
        for item in data.get("excerpts", []):
            _add(Excerpt, item, {
                "project_id": pid,
                "segment_id": _remap_id(remap, "segments", item.get("segment_id")),
                "dataset_value_id": _remap_id(remap, "dataset_values", item.get("dataset_value_id")),
            }, "excerpts")

        # ── q. CodeApplications ────────────────────────────────────
        for item in data.get("code_applications", []):
            _add(CodeApplication, item, {
                "segment_id": _remap_id(remap, "segments", item.get("segment_id")),
                "dataset_value_id": _remap_id(remap, "dataset_values", item.get("dataset_value_id")),
                "code_id": _remap_id(remap, "codes", item.get("code_id")),
                "user_id": None,
            })

        # ── r. Notes ───────────────────────────────────────────────
        for item in data.get("notes", []):
            _add(Note, item, {
                "conversation_id": _remap_id(remap, "conversations", item.get("conversation_id")),
                "segment_id": _remap_id(remap, "segments", item.get("segment_id")),
                "dataset_value_id": _remap_id(remap, "dataset_values", item.get("dataset_value_id")),
                "document_id": _remap_id(remap, "documents", item.get("document_id")),
                "excerpt_id": _remap_id(remap, "excerpts", item.get("excerpt_id")),
            }, "notes")

        # ── s. Memos (defer "analysis" and "canvas" types until their targets exist)
        deferred_memos = []
        for item in data.get("memos", []):
            entity_type = item.get("entity_type", "project")
            if entity_type in ("analysis", "canvas"):
                deferred_memos.append(item)
                continue
            entity_id = item.get("entity_id")
            remap_table = MEMO_ENTITY_REMAP.get(entity_type)
            if remap_table and entity_id is not None:
                entity_id = _remap_id(remap, remap_table, entity_id, f"memo entity_type={entity_type}")
            _add(Memo, item, {
                "project_id": pid,
                "entity_id": entity_id or 0,
            }, "memos")

        # ── t–u. AnalysisDomains & Members ────────────────────────
        # Pre-flight: enforce #290 on incoming analysis domain
        # members. A cross-dataset domain must have every member linked via
        # an equivalence group that bridges to another dataset in the same
        # domain. A valid export should never carry a violation, but legacy
        # projects from the pre-migration-025 era or hand-edited .mmproject
        # files could. Fail loudly with a clear message rather than letting
        # the runtime assertion in resolve_dataset_domain surprise users
        # later with an opaque ValueError.
        _col_to_ds_eg: dict[int, tuple[int | None, int | None]] = {}
        for _col in data.get("dataset_columns", []):
            _col_to_ds_eg[_col.get("id")] = (
                _col.get("dataset_id"),
                _col.get("equivalence_group_id"),
            )
        _domain_to_col_ids: dict[int, list[int]] = {}
        for _m in data.get("analysis_domain_members", []):
            _mtype = _m.get("member_type", "column")
            if _mtype != "column":
                continue
            _did = _m.get("domain_id")
            _mid = _m.get("member_id")
            if _did is None or _mid is None:
                continue
            _domain_to_col_ids.setdefault(_did, []).append(_mid)
        _domain_violations: list[dict] = []
        for _did, _col_ids in _domain_to_col_ids.items():
            _ds_set: set[int] = set()
            _eg_to_ds: dict[int, set[int]] = {}
            _member_info: list[tuple[int, int | None, int | None]] = []
            for _cid in _col_ids:
                _meta = _col_to_ds_eg.get(_cid)
                if _meta is None:
                    continue
                _ds, _eg = _meta
                if _ds is not None:
                    _ds_set.add(_ds)
                    _member_info.append((_cid, _ds, _eg))
                    if _eg is not None:
                        _eg_to_ds.setdefault(_eg, set()).add(_ds)
            if len(_ds_set) < 2:
                continue  # single-dataset domain — constraint doesn't apply
            for _cid, _ds, _eg in _member_info:
                if _eg is None:
                    _domain_violations.append({
                        "domain_id": _did, "column_id": _cid, "dataset_id": _ds,
                    })
                    continue
                if not (_eg_to_ds.get(_eg, set()) - {_ds}):
                    _domain_violations.append({
                        "domain_id": _did, "column_id": _cid, "dataset_id": _ds,
                    })
        if _domain_violations:
            raise ValueError(
                "Cannot import project: cross-dataset analysis domain members "
                "must be linked via equivalence groups, but the incoming file "
                f"has {len(_domain_violations)} violation(s): {_domain_violations}. "
                "This usually means the project was exported from an older "
                "version of Mixed Measures (before April 2026) when the "
                "constraint wasn't enforced. Repair the source project by "
                "pairing the unpaired columns via the mapping dialog, or "
                "remove them from the analysis domain."
            )

        for item in data.get("analysis_domains", []):
            _add(AnalysisDomain, item, {"project_id": pid}, "analysis_domains")

        for item in data.get("analysis_domain_members", []):
            member_type = item.get("member_type", "column")
            member_id = item.get("member_id")
            if member_type == "column" and member_id is not None:
                member_id = _remap_id(remap, "dataset_columns", member_id)
            _add(AnalysisDomainMember, item, {
                "domain_id": _remap_id(remap, "analysis_domains", item.get("domain_id")),
                "member_id": member_id or 0,
            })

        # ── v. MetricDefinitions ───────────────────────────────────
        for item in data.get("metric_definitions", []):
            ist = item.get("input_source_type", "dataset_column")
            isid = item.get("input_source_id")
            if ist == "dataset_column":
                isid = _remap_id(remap, "dataset_columns", isid)
            elif ist == "dataset_domain":
                isid = _remap_id(remap, "analysis_domains", isid)
            _add(MetricDefinition, item, {
                "project_id": pid,
                "input_source_id": isid or 0,
                "grouping_column_id": _remap_id(remap, "dataset_columns", item.get("grouping_column_id")),
                "grouping_column_id_2": _remap_id(remap, "dataset_columns", item.get("grouping_column_id_2")),
            }, "metric_definitions")

        # ── w. ComputedResults ─────────────────────────────────────
        for item in data.get("computed_results", []):
            _add(ComputedResult, item, {
                "metric_definition_id": _remap_id(remap, "metric_definitions", item.get("metric_definition_id")),
            })

        # ── x. RowScores ────────────────────────────────────
        for item in data.get("row_scores", []):
            _add(RowScore, item, {
                "metric_definition_id": _remap_id(remap, "metric_definitions", item.get("metric_definition_id")),
                "dataset_row_id": _remap_id(remap, "dataset_rows", item.get("dataset_row_id")),
            })

        # ── x.5 Tier 3 backfill: auto scale-score metrics for legacy domains ──
        # Projects exported before the crosswalk (pre-Apr 2026) have
        # AnalysisDomain rows but no auto-created ungrouped domain_aggregate
        # MetricDefinitions. After import, run the same service function the
        # crosswalk endpoint uses to backfill any missing scale-score metrics,
        # so legacy projects render correctly in the new crosswalk UI without
        # requiring manual researcher action.
        #
        # Placement rationale: runs AFTER all metric-adjacent imports complete
        # (metric_definitions, computed_results, row_scores) so the idempotency
        # check inside create_scale_score_metric correctly skips domains whose
        # scale-score metrics were already imported from the source file.
        # Runs BEFORE StatisticalTests so new backfilled metrics are available
        # for any imported statistical test that targets them — though in
        # practice statistical tests reference metrics by remap ID, which
        # won't match new backfilled metrics anyway. No ordering hazard.
        #
        # See directive Revision 5 Phase 1.9 and GAP 3.12 for the full rationale.
        try:
            from .equivalence_validators import assert_equivalence_group_types_consistent
            from .metrics import create_scale_score_metric as _create_scale_score_metric
        except ImportError as _backfill_exc:
            logger.warning(
                "Tier 3 crosswalk backfill unavailable during import: %s. "
                "Scale-score metrics for legacy domains will not be created.",
                _backfill_exc,
            )
        else:
            # Load ALL newly-imported domains for this project with their
            # members relationship populated. We need the members to derive
            # the cross-dataset-pairing check inside compute_metric.
            newly_imported_domain_ids = list(remap["analysis_domains"].values())
            if newly_imported_domain_ids:
                domains_to_backfill = (
                    db.query(AnalysisDomain)
                    .filter(AnalysisDomain.id.in_(newly_imported_domain_ids))
                    .all()
                )
                backfilled = 0
                for _dom in domains_to_backfill:
                    try:
                        _metric, _computed = _create_scale_score_metric(db, _dom)
                        if _computed:
                            backfilled += 1
                    except (ValueError, HTTPException) as _exc:
                        # Legacy domain with unpaired cross-dataset members —
                        # pre-flight validator should have caught this but
                        # defense in depth: log and skip rather than fail
                        # the whole import.
                        logger.warning(
                            "Skipping scale-score backfill for domain %d (%r): %s",
                            _dom.id, _dom.name, _exc,
                        )
                if backfilled:
                    logger.info(
                        "Tier 3 crosswalk backfill: created %d scale-score "
                        "metric(s) for %d domain(s) during project import.",
                        backfilled, len(domains_to_backfill),
                    )

            # Also run the post-write sanity pass on equivalence groups to
            # catch cross-source type-mismatch corruption before the researcher
            # hits it during a swap. See GAP 3.14.
            newly_imported_eg_ids = list(remap["equivalence_groups"].values())
            if newly_imported_eg_ids:
                eg_objects = (
                    db.query(EquivalenceGroup)
                    .filter(EquivalenceGroup.id.in_(newly_imported_eg_ids))
                    .all()
                )
                for _eg in eg_objects:
                    # Raises ValueError on mismatch — let it propagate to the
                    # import caller, which will roll back the transaction.
                    assert_equivalence_group_types_consistent(_eg)

        # ── y. StatisticalTests ────────────────────────────────────
        for item in data.get("statistical_tests", []):
            tt = item.get("target_type")
            tid = item.get("target_id")
            if tt == "analysis_domain":
                tid = _remap_id(remap, "analysis_domains", tid)
            elif tt == "metric_definition":
                tid = _remap_id(remap, "metric_definitions", tid)
            _add(StatisticalTest, item, {
                "project_id": pid,
                "target_id": tid or 0,
            })

        # ── z–aa. Material Collections & Materials ─────────────────
        for item in data.get("material_collections", []):
            _add(MaterialCollection, item, {"project_id": pid}, "material_collections")

        for item in data.get("materials", []):
            _add(Material, item, {
                "collection_id": _remap_id(remap, "material_collections", item.get("collection_id")),
                "config": _remap_material_config(item.get("config"), remap),
            }, "materials")

        # ── Canvas entities ────────────────────────────────────────
        for item in data.get("canvases", []):
            _add(Canvas, item, {"project_id": pid}, "canvases")

        # Canvas themes (two-pass for parent_theme_id self-ref). The content
        # blob's embedded entity IDs (#387 M2/M3) and the pending source_id
        # (#387 M1) are remapped in a LATER pass — they can reference memos,
        # which are deferred (analysis/canvas types) and not yet in the remap
        # table at this point.
        canvas_theme_self_refs = []
        for item in data.get("canvas_themes", []):
            _add(CanvasTheme, item, {
                "canvas_id": _remap_id(remap, "canvases", item.get("canvas_id")),
                "parent_theme_id": None,
            }, "canvas_themes")
            if item.get("parent_theme_id"):
                canvas_theme_self_refs.append(item)

        for item in canvas_theme_self_refs:
            new_id = remap["canvas_themes"][item["_original_id"]]
            new_parent = remap["canvas_themes"].get(item["parent_theme_id"])
            if new_parent:
                db.query(CanvasTheme).filter(CanvasTheme.id == new_id).update(
                    {"parent_theme_id": new_parent}
                )
        if canvas_theme_self_refs:
            db.flush()

        # Canvas theme relationships
        for item in data.get("canvas_theme_relationships", []):
            _add(CanvasThemeRelationship, item, {
                "canvas_id": _remap_id(remap, "canvases", item.get("canvas_id")),
                "source_theme_id": _remap_id(remap, "canvas_themes", item.get("source_theme_id")),
                "target_theme_id": _remap_id(remap, "canvas_themes", item.get("target_theme_id")),
            })

        # Canvas pending items (source_id remapped in the post-memo pass below)
        for item in data.get("canvas_pending_items", []):
            _add(CanvasPendingItem, item, {
                "canvas_id": _remap_id(remap, "canvases", item.get("canvas_id")),
            }, "canvas_pending_items")

        # ── Deferred memos (analysis → materials, canvas → canvases)
        for item in deferred_memos:
            entity_type = item.get("entity_type", "project")
            remap_table = MEMO_ENTITY_REMAP.get(entity_type)
            entity_id = _remap_id(
                remap, remap_table, item.get("entity_id"),
                f"memo entity_type={entity_type}",
            ) if remap_table else item.get("entity_id")
            _add(Memo, item, {
                "project_id": pid,
                "entity_id": entity_id or 0,
            }, "memos")

        # ── Canvas embed/pending ID remap (#387) ───────────────────
        # Runs AFTER all memos (including deferred analysis/canvas types) are
        # imported so memo-embed IDs resolve. Rewrites embedded excerptId /
        # materialId / memoId inside each theme's content blob, re-derives
        # referenced_source_ids from the rewritten content, and remaps the
        # polymorphic CanvasPendingItem.source_id per item_type.
        theme_remap = remap.get("canvas_themes", {})
        for item in data.get("canvas_themes", []):
            new_content, new_refs = _remap_canvas_content(item.get("content"), remap)
            if item.get("content") is None:
                continue
            new_theme_id = theme_remap.get(item["_original_id"])
            if new_theme_id is None:
                continue
            db.query(CanvasTheme).filter(CanvasTheme.id == new_theme_id).update(
                {"content": new_content, "referenced_source_ids": new_refs}
            )

        pending_remap_count = 0
        for item in data.get("canvas_pending_items", []):
            pending_table = CANVAS_SOURCE_REMAP.get(item.get("item_type"))
            if not pending_table:
                continue
            new_source_id = _remap_id(
                remap, pending_table, item.get("source_id"),
                f"canvas pending item_type={item.get('item_type')}",
            )
            if new_source_id is None:
                continue  # unmapped — leave the original (NOT NULL, no FK)
            new_pending_id = remap.get("canvas_pending_items", {}).get(item["_original_id"])
            if new_pending_id is None:
                continue
            db.query(CanvasPendingItem).filter(
                CanvasPendingItem.id == new_pending_id
            ).update({"source_id": new_source_id})
            pending_remap_count += 1

        if data.get("canvas_themes") or pending_remap_count:
            db.flush()

        # ── bb. ScratchpadEntries ──────────────────────────────────
        for item in data.get("scratchpad_entries", []):
            rid = item.get("resolved_into_id")
            rtype = item.get("resolved_into_type")
            if rtype == "memo" and rid is not None:
                rid = _remap_id(remap, "memos", rid)
            _add(ScratchpadEntry, item, {
                "project_id": pid,
                "resolved_into_id": rid,
            }, "scratchpad_entries")

        # ── cc. TextCodingConfig ──────────────────────────────────
        cvc = data.get("text_coding_config")
        if cvc:
            _add(TextCodingConfig, cvc, {
                "project_id": pid,
                "focal_column_ids": _remap_json_id_array(cvc.get("focal_column_ids"), remap, "dataset_columns"),
                "dataset_filter_ids": _remap_json_id_array(cvc.get("dataset_filter_ids"), remap, "datasets"),
                "starred_value_ids": _remap_json_id_array(cvc.get("starred_value_ids"), remap, "dataset_values"),
            })

        # ── dd. QuoteBoardConfig ───────────────────────────────────
        qbc = data.get("quote_board_config")
        if qbc:
            _add(QuoteBoardConfig, qbc, {
                "project_id": pid,
                "custom_orders": _remap_quote_board_orders(qbc.get("custom_orders"), remap),
            })

        # ── Copy document files ────────────────────────────────────
        doc_members = [m for m in zf.namelist() if m.startswith("documents/")]
        if doc_members:
            new_project_docs_dir = docs_dir / str(pid)
            new_project_docs_dir.mkdir(parents=True, exist_ok=True)

            for member in doc_members:
                # member looks like "documents/{old_doc_id}/original.pdf"
                parts = member.split("/", 2)
                if len(parts) < 3 or not parts[2]:
                    continue  # skip directory entries
                old_doc_id_str = parts[1]
                try:
                    old_doc_id = int(old_doc_id_str)
                except ValueError:
                    continue
                new_doc_id = remap["documents"].get(old_doc_id)
                if new_doc_id is None:
                    continue

                relative_path = parts[2]
                target_path = new_project_docs_dir / str(new_doc_id) / relative_path
                target_path.parent.mkdir(parents=True, exist_ok=True)

                with zf.open(member) as src, open(target_path, "wb") as dst:
                    dst.write(src.read())

        # ── Copy media files (audio) ──────────────────────────────
        if media_dir is not None:
            media_members = [m for m in zf.namelist() if m.startswith("media/")]
            if media_members:
                new_project_media_dir = media_dir / str(pid)
                new_project_media_dir.mkdir(parents=True, exist_ok=True)

                for member in media_members:
                    parts = member.split("/", 2)
                    if len(parts) < 3 or not parts[2]:
                        continue  # skip directory entries

                    # Canvas images: media/canvas/{uuid}.{ext} — no ID remapping
                    if parts[1] == "canvas":
                        target_path = new_project_media_dir / "canvas" / parts[2]
                        target_path.parent.mkdir(parents=True, exist_ok=True)
                        with zf.open(member) as src, open(target_path, "wb") as dst:
                            dst.write(src.read())
                        continue

                    # Audio: media/{old_conv_id}/{filename} — remap conversation ID
                    try:
                        old_conv_id = int(parts[1])
                    except ValueError:
                        continue
                    new_conv_id = remap["conversations"].get(old_conv_id)
                    if new_conv_id is None:
                        continue

                    relative_path = parts[2]
                    target_path = new_project_media_dir / str(new_conv_id) / relative_path
                    target_path.parent.mkdir(parents=True, exist_ok=True)

                    with zf.open(member) as src, open(target_path, "wb") as dst:
                        dst.write(src.read())

    return pid, project_name


# ── Import sub-helpers ──────────────────────────────────────────────────

def _import_categories_topological(
    db: Session,
    cat_items: list[dict],
    project_id: int,
    remap: dict,
) -> None:
    """Insert CodeCategories in topological order (roots first)."""
    pending = list(cat_items)
    inserted = set()

    max_passes = 10
    for _ in range(max_passes):
        if not pending:
            break
        still_pending = []
        for item in pending:
            parent_old_id = item.get("parent_id")
            if parent_old_id is None or parent_old_id in inserted:
                obj = _build_entity(CodeCategory, item, {
                    "project_id": project_id,
                    "parent_id": _remap_id(remap, "code_categories", parent_old_id),
                })
                db.add(obj)
                db.flush()
                remap["code_categories"][item["_original_id"]] = obj.id
                inserted.add(item["_original_id"])
            else:
                still_pending.append(item)
        pending = still_pending

    if pending:
        logger.warning(
            "Could not insert %d categories (orphaned parent references)", len(pending)
        )


def _import_recodes_topological(
    db: Session,
    recode_items: list[dict],
    remap: dict,
) -> None:
    """Insert RecodeDefinitions in topological order (parents first)."""
    pending = list(recode_items)
    inserted = set()

    max_passes = 10
    for _ in range(max_passes):
        if not pending:
            break
        still_pending = []
        for item in pending:
            source_old_id = item.get("source_definition_id")
            if source_old_id is None or source_old_id in inserted:
                obj = _build_entity(RecodeDefinition, item, {
                    "column_id": _remap_id(remap, "dataset_columns", item.get("column_id")),
                    "source_definition_id": _remap_id(remap, "recode_definitions", source_old_id),
                })
                db.add(obj)
                db.flush()
                remap["recode_definitions"][item["_original_id"]] = obj.id
                inserted.add(item["_original_id"])
            else:
                still_pending.append(item)
        pending = still_pending

    if pending:
        logger.warning(
            "Could not insert %d recode definitions (orphaned source refs)",
            len(pending),
        )
