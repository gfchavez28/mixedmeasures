"""Project portability service — export and import .mmproject files.

Handles serialization of all project-scoped entities to JSON,
ZIP packaging with document files, and full import with ID remapping.
"""

import enum
import io
import json
import logging
import math
import os
import re
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import inspect as sa_inspect, func
from sqlalchemy.orm import Session

from . import media_storage
from .archive_safety import assert_expanded_size_within_limit, assert_member_within
from .text_offsets import has_astral, utf16_to_codepoint
from .text_similarity import similarity_ratio
from .media_duration import MAX_MEDIA_OFFSET_SECONDS, sane_duration
from .note_numbering import renumber_imported_notes

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
    CodeEquivalenceGroup,
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
from ..models.user import User
from ..auth import unique_username
from ..config import get_backup_dir
from ..services.backup import APP_VERSION
from ..services.coding_layers import CONSENSUS_ORIGIN, code_usage_count_expr, non_consensus_filter
from ..services.canvas import (
    EMBED_NODE_TYPES,
    EMBED_TYPE_MAP,
    extract_referenced_source_ids,
    walk_tiptap_nodes,
)

logger = logging.getLogger(__name__)

# Version 2 (2026-07-06, #414): ColumnType gained "identifier". Older builds
# constructing ColumnType("identifier") at import would crash mid-write with a
# LookupError, so files exported from ≥2 must be refused cleanly by the gate
# below rather than half-imported. Version-1 files still import (warning only).
#
# Version 3 (2026-07-12, Observations): Segment gained a THIRD parent
# (observation_id). An older build has no such column, so `_build_entity` drops it
# and inserts the segment with all parents NULL — which violates that build's
# two-parent ck_segment_exactly_one_parent and dies mid-write with an opaque
# IntegrityError. Same shape as #414: bump so the gate refuses cleanly instead.
# Version-1 and -2 files still import.
#
# v4 (2026-07-16, #592 slab 3): DatasetColumn.missing_values — a per-column
# declared-missing rule list that DECIDES STATISTICS (which cells are NULL,
# which values form groups). An older build's _build_entity silently DROPS the
# unknown column on import, so the declaration would vanish without a word and
# every analysis on that column silently changes — the silent-wrongness class
# v2 (#414) and v3 (Observations) bumped for. Bumped with the slab-3 endpoint,
# the first production write path (the slab-1 decision: until something could
# WRITE a declaration, refusing old builds bought nothing). v1–v3 files still
# import.
# v5 = #687 — char excerpt offsets are CODE POINTS. v1–v4 archives carry UTF-16
# code units (the browser's basis, unconverted), so an excerpt on a segment with an
# astral character points at the wrong text. Unlike v2/v3/v4 this bump is NOT a
# refusal gate for old files — they import fine, and `_repair_pre_v5_excerpt_offsets`
# converts them on the way in. The version is what makes "is this file's basis
# UTF-16?" answerable at all; without it a re-import would silently reintroduce the
# drift the repair migration just removed.
CURRENT_FORMAT_VERSION = 5
MAX_UPLOAD_SIZE = 500 * 1024 * 1024  # 500 MB


class MergeDivergenceError(ValueError):
    """Track J · J3-2c: a merge was refused because the colleague's copy diverged
    from the target (re-segmentation or a code not in the shared codebook).

    Subclasses ``ValueError`` so the service's existing ``except ValueError`` paths
    (and the direct-call tests that ``pytest.raises(ValueError)``) still catch it,
    while the endpoint can catch it FIRST and surface ``.payload`` as a structured
    409 the UI can render as a per-source diff (the machine-readable half of the
    scope §7 gate; the full visualization is J3-3).
    """

    def __init__(self, message: str, payload: dict):
        super().__init__(message)
        self.payload = payload


# ── Export size bound (#842) ────────────────────────────────────────────

MAX_PROJECT_EXPORT_VALUES = 500_000
"""The largest project `.mmproject` will export, in dataset values.

**Chosen on TIME, with margin, 2026-08-27.** The binding constraint is the IMPORT
half, not the export: `import_project` flushes once per entity, measured linear at
0.376-0.433 s per 1,000 values across a 15x range (#847), against `importProject`'s
hard-coded 300,000 ms client timeout. 500,000 values imports in roughly 190 s — 37%
headroom.

⚠️ **Do NOT raise this to the ~800,000 where the timeout actually bites.** That is the
FAILURE POINT, not a bound: at 720,000 the margin is already 9.8% on an unloaded
6-core machine, and a slower one would abandon a valid import.

⚠️ **This is deliberately NOT `MAX_DATASET_CELLS` (4,000,000) and the 8x gap is
KNOWN** — the tool imports far more than it can share. The bound makes that honest;
it does not close it. The real fix is BOTH halves together (streaming export +
batched import) in v1.5.0 — `docs/release-1.4.0-checklist.md` §4d, tracked by #842
and #847, which both stay open.

⚠️ Dependency note (the internal design notes's blue block): this value was derived from TIME, so it
does not key on the parked cloud/VPS question.
"""


class ProjectTooLargeError(ValueError):
    """Refused: over `MAX_PROJECT_EXPORT_VALUES` (#842).

    ⚠️ A DISTINCT type, not a bare `ValueError`, for the same reason
    `DatasetTooLargeError` is (#797/#803): `export_project_endpoint` catches
    `ValueError` and re-raises it as **HTTPException(404)**, so a bare ValueError
    would tell the researcher their project was NOT FOUND. Every caller catches this
    one FIRST and shows its message verbatim.
    """


def project_export_size_error(n_values: int) -> str | None:
    """The refusal message for an over-bound project, or None if it fits.

    ONE function so the export endpoint, Duplicate Project and the overwrite
    safety-backup refuse at the same size with the same words — those three call
    `export_project` and all three were breaking with a raw `OperationalError`.

    ⚠️ The message must not offer `include_media=False` as a workaround: media is not
    counted here, so excluding it changes nothing about this limit. Advice that does
    not work is worse than none.
    """
    if n_values <= MAX_PROJECT_EXPORT_VALUES:
        return None
    return (
        f"This project holds {n_values:,} dataset values, over the "
        f"{MAX_PROJECT_EXPORT_VALUES:,} limit for a .mmproject file. "
        "Your data is not at risk and backups are unaffected — Settings → "
        "Backup & Data still covers this project in full, including its datasets. "
        "What this limit blocks is sharing a copy, duplicating the project, and "
        "merging a colleague's coding. A project comes under the limit if its "
        "datasets hold fewer records or fewer variables. A larger limit is planned."
    )


def assert_project_exportable(db: Session, project_id: int) -> None:
    """Refuse an over-bound project BEFORE the gather begins.

    ⚠️ Enforced in the SERVICE, not at a router: `export_project` has three callers
    (the export endpoint, `duplicate_project_endpoint`, and
    `_safety_export_before_overwrite`) and a router guard is not a guard on the
    operation (#589). One COUNT — it must not spend the memory it is refusing.
    """
    n_values = db.query(func.count(DatasetValue.id)).join(
        DatasetRow, DatasetValue.row_id == DatasetRow.id
    ).join(
        Dataset, DatasetRow.dataset_id == Dataset.id
    ).filter(Dataset.project_id == project_id).scalar() or 0
    message = project_export_size_error(n_values)
    if message:
        raise ProjectTooLargeError(message)


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

def export_project(
    db: Session,
    project_id: int,
    docs_dir: Path,
    media_dir: Path | None = None,
    include_media: bool = True,
) -> io.BytesIO:
    """Export a project as an in-memory .mmproject ZIP.

    Returns a BytesIO buffer containing the ZIP. Raises ValueError
    if the project is not found.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise ValueError(f"Project {project_id} not found")

    # #842 — refuse an over-bound project here, before a single entity is loaded.
    assert_project_exportable(db, project_id)

    # Pre-compute column lists once
    cols = {
        m: _get_columns(m)
        for m in [
            Project, Participant, Speaker, Conversation, Document, Observation,
            SegmentGroup, Segment, CodeCategory, Code, CodeEquivalenceGroup,
            CodeApplication,
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
    # Coders are global Users (Track J · J1); export name/color/type only — NEVER password_hash.
    cols[User] = [c for c in _get_columns(User) if c != "password_hash"]

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

    observations = db.query(Observation).filter(
        Observation.project_id == project_id
    ).all()
    obs_ids = [o.id for o in observations]

    segment_groups = db.query(SegmentGroup).filter(
        SegmentGroup.conversation_id.in_(conv_ids)
    ).all() if conv_ids else []

    # Segment has no project_id — it is gathered through its parents, so EVERY
    # Segment parent needs a branch here. A missing one is silent data loss that
    # cascades: segment_ids below is the root of the code_applications, coders,
    # and (via segment_id) excerpt/note dependency chains.
    segments = []
    if conv_ids:
        segments.extend(
            db.query(Segment).filter(Segment.conversation_id.in_(conv_ids)).all()
        )
    if doc_ids:
        segments.extend(
            db.query(Segment).filter(Segment.document_id.in_(doc_ids)).all()
        )
    if obs_ids:
        segments.extend(
            db.query(Segment).filter(Segment.observation_id.in_(obs_ids)).all()
        )
    segment_ids = [s.id for s in segments]

    code_categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()

    codes = db.query(Code).filter(
        Code.project_id == project_id
    ).all()

    code_equivalence_groups = db.query(CodeEquivalenceGroup).filter(
        CodeEquivalenceGroup.project_id == project_id
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

    # #842 — JOIN BACK to the dataset; never materialise a project-wide id list.
    #
    # This used to build `row_ids` and hand it to `.in_()`. SQLAlchemy renders ONE
    # BIND PARAMETER PER ELEMENT and SQLite's SQLITE_MAX_VARIABLE_NUMBER is exactly
    # 250,000 (measured by bisection), so a real survey raised a raw OperationalError
    # that reached the researcher as an unexplained failure — on export, on Duplicate
    # Project, and on the safety backup an overwrite-import takes first.
    #
    # `dataset_ids` is bounded by the project's dataset COUNT, so passing it by value
    # is safe; the row and value sets are not, so they are joined instead. Measured
    # 2026-08-27 on a 3,633,552-value corpus: identical result sets, 0.45 s, no memory
    # growth. `order_by` keeps the archive reproducible so two exports of an unchanged
    # project can be compared — the shape the v1.5.0 round-trip guard needs.
    dataset_values = db.query(DatasetValue).join(
        DatasetRow, DatasetValue.row_id == DatasetRow.id
    ).filter(
        DatasetRow.dataset_id.in_(dataset_ids)
    ).order_by(DatasetValue.id).all() if dataset_ids else []

    # Exclude the derived consensus layer from export — it is regenerated on
    # import via materialize_consensus_for_project (§8 decision 4 / C2). This also
    # keeps the GLOBAL consensus user out of the coder_ids derived below, so it is
    # never exported/recreated as a roster coder.
    code_applications = []
    if segment_ids:
        code_applications.extend(
            db.query(CodeApplication).filter(
                CodeApplication.segment_id.in_(segment_ids),
                CodeApplication.origin != CONSENSUS_ORIGIN,
            ).all()
        )
    if dataset_ids:
        # #842 join-back — see the note on `dataset_values` above. The filter is the
        # same predicate the id list expressed ("this project's dataset values"),
        # reached through the FK chain instead of through 3.6 million bind parameters.
        code_applications.extend(
            db.query(CodeApplication).join(
                DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id
            ).join(
                DatasetRow, DatasetValue.row_id == DatasetRow.id
            ).filter(
                DatasetRow.dataset_id.in_(dataset_ids),
                CodeApplication.origin != CONSENSUS_ORIGIN,
            ).order_by(CodeApplication.id).all()
        )

    # Coders referenced by this project's code applications (Track J · J1).
    coder_ids = {ca.user_id for ca in code_applications if ca.user_id is not None}
    coders = db.query(User).filter(User.id.in_(coder_ids)).all() if coder_ids else []

    # Note has no project_id either — same rule as segments: every Note parent
    # needs a branch or those notes silently never leave the project.
    notes = []
    if conv_ids:
        notes.extend(
            db.query(Note).filter(Note.conversation_id.in_(conv_ids)).all()
        )
    if dataset_ids:
        # #842 join-back — see the note on `dataset_values` above.
        notes.extend(
            db.query(Note).join(
                DatasetValue, Note.dataset_value_id == DatasetValue.id
            ).join(
                DatasetRow, DatasetValue.row_id == DatasetRow.id
            ).filter(
                DatasetRow.dataset_id.in_(dataset_ids)
            ).order_by(Note.id).all()
        )
    if doc_ids:
        notes.extend(
            db.query(Note).filter(Note.document_id.in_(doc_ids)).all()
        )
    if obs_ids:
        notes.extend(
            db.query(Note).filter(Note.observation_id.in_(obs_ids)).all()
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
        "observations": _serialize_all(observations, cols[Observation]),
        "segment_groups": _serialize_all(segment_groups, cols[SegmentGroup]),
        "segments": _serialize_all(segments, cols[Segment]),
        "code_categories": _serialize_all(code_categories, cols[CodeCategory]),
        "codes": _serialize_all(codes, cols[Code]),
        "code_equivalence_groups": _serialize_all(code_equivalence_groups, cols[CodeEquivalenceGroup]),
        "coders": _serialize_all(coders, cols[User]),
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
        # Stable cross-instance identity surfaced in the manifest (Track J · J3-1) so
        # /validate-import can detect "this project already exists here" without
        # parsing project.json. Also present in project.json; the manifest copy is the
        # cheap lookup. Backward-compatible — older files lack it (treated as no-match).
        "project_uuid": project.project_uuid,
        "project_summary": {
            "conversation_count": len(conversations),
            "dataset_count": len(datasets),
            "document_count": len(documents),
            # Declared on the ProjectSummary schema WITH A DEFAULT (#639). It was
            # omitted originally on the reasoning that the schema's fields are
            # required, so adding one would fail to parse every v1/v2 manifest —
            # true of a required field, but omission has its own cost: the schema
            # is reached through a response_model, which DROPS undeclared fields,
            # so this count never reached the import preview. A default satisfies
            # both (old manifests read 0; new ones carry the real count).
            # `canvas_count`/`canvas_theme_count` below are still undeclared —
            # nothing renders them today; declare them the same way if that changes.
            "observation_count": len(observations),
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

        # Add media files. Canvas images (media/{pid}/canvas/) are canvas
        # CONTENT and always travel; RECORDINGS — a conversation's (numeric dir)
        # or an observation's (obs-{id} dir, media_storage.media_owner_segment) —
        # are skipped when include_media=False, the media-less export. The import
        # side clears the orphaned media_* metadata for BOTH owner kinds so the
        # workbench shows a clean re-attach state, not a dead player (§8 of the
        # video scoping doc). Recordings are already-compressed containers, so
        # ZIP_STORED skips a pointless deflate pass.
        #
        # The walk is DIRECTORY-driven, not entity-driven, so a new media owner
        # travels for free — but note the arcname deliberately STRIPS project_id
        # (the importer re-prepends the NEW pid), which is why the owner dir name
        # is the only thing carrying owner identity across the archive.
        if media_dir is not None:
            project_media_dir = media_dir / str(project_id)
            if project_media_dir.is_dir():
                for owner_dir in project_media_dir.iterdir():
                    if not owner_dir.is_dir():
                        continue
                    if owner_dir.name != "canvas" and not include_media:
                        continue
                    for file_path in owner_dir.rglob("*"):
                        if file_path.is_file():
                            arcname = f"media/{owner_dir.name}/{file_path.relative_to(owner_dir)}"
                            zf.write(str(file_path), arcname, compress_type=zipfile.ZIP_STORED)

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
            # Cheap pre-flight only. The REAL containment check is per-member, inside
            # `_extract_zip_member` (#688) — this pattern scan cannot see a Windows
            # drive-absolute or UNC member, which is what made it bypassable.
            for name in zf.namelist():
                if name.startswith("/") or ".." in name:
                    raise ValueError(f"Invalid project file: suspicious path '{name}'")

            # #696: MAX_UPLOAD_SIZE caps the archive, not what it expands to.
            assert_expanded_size_within_limit(zf)

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
    # Memo.entity_id carries NO ForeignKey, so an entity_type missing from this map
    # is copied verbatim and points at whatever row happens to own that id locally —
    # silent cross-project corruption with no IntegrityError and no warning. Every
    # new memo-able entity MUST be registered here.
    "observation": "observations",
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


def _build_entity(model, item: dict, overrides: dict | None = None, fresh_uuid: bool = False) -> object:
    """Construct an ORM entity from an export dict.

    Only sets fields that exist as columns on the model.
    DateTime columns are parsed from ISO strings.
    The _original_id key is skipped.
    ``overrides`` takes precedence over ``item`` values.
    ``fresh_uuid``: when True and the model has a J3-2-0 ``uuid`` column, stamp a FRESH
    uuid instead of copying the source's (import-as-new — see note below).
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
    # Track J · J3-2-0: import-as-new gets a FRESH per-entity uuid — never copy the
    # source's (it would collide on the unique index when re-importing into the same
    # instance, exactly like project_uuid). The J3 merge/round-trip path (which MATCHES
    # on uuid) imports with fresh_uuid=False to PRESERVE cross-copy identity.
    if fresh_uuid and "uuid" in valid_cols and not (overrides and "uuid" in overrides):
        kwargs["uuid"] = str(uuid.uuid4())
    return model(**kwargs)


def _merge_uuid_match(db: Session, model, incoming_uuid: str, project_id: int):
    """Track J · J3-2 / #449(c): build the merge match query for an entity uuid, scoped to
    the target project when the model carries a ``project_id`` column. Defense-in-depth so a
    file entity can never match (and re-point children onto) a row in an UNRELATED local
    project. Models reached only through a parent FK (Segment, DatasetColumn, …) lack a
    ``project_id`` and rely on the global unique uuid index, which already guarantees a
    single match. Returns a Query; the caller does ``.first()``."""
    q = db.query(model).filter(model.uuid == incoming_uuid)
    if "project_id" in sa_inspect(model).columns.keys():
        q = q.filter(model.project_id == project_id)
    return q


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


def _safety_export_before_overwrite(
    db: Session, target: Project, docs_dir: Path, media_dir: Path | None,
) -> Path:
    """Write a recovery .mmproject of a project about to be overwritten (Track J · J3-1).

    Overwrite is the first IN-PLACE destructive import — it deletes an existing
    populated project. Mirror the pre-restore safety-backup discipline: snapshot the
    target to the backup dir BEFORE the delete. A failure here ABORTS the overwrite
    (we refuse to destroy data we couldn't back up). Returns the backup file path.
    """
    try:
        buf = export_project(db, target.id, docs_dir, media_dir)
        backup_dir = get_backup_dir()
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        path = backup_dir / f"pre-overwrite_{target.id}_{ts}.mmproject"
        path.write_bytes(buf.getvalue())
        return path
    except ProjectTooLargeError as e:
        # #842 — the abort is CORRECT (never destroy data we could not back up), but
        # the REASON has to survive. Without this arm the generic wrapper below
        # reports "Could not create a safety backup … (too many SQL variables)",
        # which describes neither the cause nor anything the researcher can act on.
        raise ProjectTooLargeError(
            "Overwriting was stopped because the project being replaced is too large "
            f"to snapshot first, and it is not overwritten without a snapshot. {e}"
        )
    except Exception as e:
        raise ValueError(
            "Could not create a safety backup before overwrite; aborting to protect "
            f"your data ({e})."
        )


def _validate_merge_code_decisions(
    db: Session, divergent_codes: list[dict], code_mapping: dict, target_project_id: int | None,
) -> None:
    """Track J · J3-2b: validate the reconcile decisions for divergent codes before any
    write. Raises ValueError (→ 400) on a malformed/illegal decision. Decisions for
    non-divergent or unknown codes are ignored (harmless no-ops in the apply loop)."""
    divergent_by_uuid = {c["uuid"]: c for c in divergent_codes}
    for uuid, decision in code_mapping.items():
        file_code = divergent_by_uuid.get(uuid)
        if file_code is None:
            continue  # a decision for an already-local / unknown code — ignore
        if not isinstance(decision, dict):
            raise ValueError(f"Invalid reconcile decision for code '{file_code.get('name', '?')}'.")
        action = decision.get("action")
        if action not in ("collapse", "link", "new"):
            raise ValueError(
                f"Unknown reconcile action '{action}' for code '{file_code.get('name', '?')}'."
            )
        if action in ("collapse", "link"):
            tid = decision.get("target_code_id")
            target = (
                db.query(Code)
                .filter(Code.id == tid, Code.project_id == target_project_id)
                .first()
                if tid is not None else None
            )
            if target is None:
                raise ValueError(
                    f"Reconcile target code {tid} for '{file_code.get('name', '?')}' is not "
                    "a code in your project."
                )
            if not target.is_active:
                raise ValueError(f"Cannot reconcile onto the deleted code '{target.name}'.")
            if target.is_universal:
                raise ValueError(f"Cannot reconcile onto the universal code '{target.name}'.")
            if action == "link" and file_code.get("is_universal"):
                raise ValueError(
                    f"Cannot link the universal code '{file_code.get('name', '?')}' — "
                    "collapse it or add it as new instead."
                )


def _assert_merge_compatible(
    db: Session, data: dict, code_mapping: dict | None = None,
    target_project_id: int | None = None,
) -> None:
    """Track J · J3-2c gate (+ J3-2b reconcile): refuse a merge whose source diverged
    from the target, EXCEPT for divergent codes the caller has supplied a reconcile
    decision for.

    A merge matches shared sources by their J3-2-0 uuid, so it requires the colleague's
    copy to be FROZEN against the target:
      - Segmentation: within each shared conversation/document, the VISIBLE segments must
        match 1:1 by uuid. A re-split/merge creates new segment uuids that wouldn't match,
        so the codings would land on overlapping/duplicate segments — refuse instead.
      - Codebook: every code in the file must either exist locally by uuid OR carry a
        J3-2b reconcile decision (collapse/link/new) in ``code_mapping`` (keyed by file
        code uuid). An UNDECIDED divergent code refuses — the gate never assumes the
        reconcile UI ran (scripts/direct calls skip it).
    Raises MergeDivergenceError (segmentation/undecided-codebook) or ValueError (bad
    decision). Runs BEFORE any writes (incl. the safety export), so a refused merge
    changes nothing.
    """
    code_mapping = code_mapping or {}

    # ── #449(d): pre-spine file guard ───────────────────────────────
    # A merge matches shared sources by their J3-2-0 entity uuid. A file exported BEFORE the
    # uuid spine (project_uuid present, entity uuids absent — format_version did NOT bump, so
    # the version gate can't catch it) would skip every match and fall to the insert path,
    # colliding on e.g. ix_codes_project_numeric mid-write AFTER the safety export. Refuse
    # early (before any write) with an actionable message instead.
    for _spine_key in ("codes", "segments", "conversations", "documents", "observations"):
        if any(not _item.get("uuid") for _item in data.get(_spine_key, [])):
            raise ValueError(
                "This file was exported by a version of Mixed Measures that predates merge "
                "support, so its sources can't be matched for merging. Ask your colleague to "
                "re-export the project from an updated copy, then merge that file."
            )

    # ── Codebook gate (DJ3-1a frozen shared codebook + J3-2b reconcile) ──
    file_codes = [c for c in data.get("codes", []) if c.get("uuid")]
    file_code_uuids = {c["uuid"] for c in file_codes}
    if file_code_uuids:
        local_code_uuids = {
            u for (u,) in db.query(Code.uuid).filter(Code.uuid.in_(file_code_uuids)).all()
        }
        divergent = [c for c in file_codes if c["uuid"] not in local_code_uuids]
        undecided = [c.get("name", "?") for c in divergent if c["uuid"] not in code_mapping]
        if undecided:
            shown = ", ".join(f"'{n}'" for n in undecided[:5])
            raise MergeDivergenceError(
                f"This file has {len(undecided)} code(s) not in your codebook ({shown}"
                f"{'…' if len(undecided) > 5 else ''}). Reconcile each divergent code "
                "(collapse / link / add as new) before merging.",
                {
                    "error": "merge_divergence",
                    "kind": "codebook",
                    "diverged_codes": undecided,
                },
            )
        if code_mapping:
            _validate_merge_code_decisions(db, divergent, code_mapping, target_project_id)

    # ── Segmentation gate (§10.2: frozen segmentation) ──────────────
    conv_uuid_by_oldid = {c["_original_id"]: c.get("uuid") for c in data.get("conversations", [])}
    doc_uuid_by_oldid = {d["_original_id"]: d.get("uuid") for d in data.get("documents", [])}
    # D18: an OPEN observation's clips are each coder's own, so their sets legitimately
    # differ and the gate must not compare them. A FROZEN one's clips are the AGREED
    # units — a colleague who re-cut them has diverged exactly as if they had
    # re-segmented a transcript, so it goes through the gate like any other source.
    #
    # #572: the exemption is computed from BOTH sides, not just the file's. Reading
    # only the file (the original shape) meant a lead who froze AFTER distributing
    # copies silently accepted a colleague's still-open clips INTO the frozen local
    # observation — expanding the very unit set the freeze declared agreed. Those
    # clips then have exactly one voter, so `_decide_consensus` yields nothing and
    # they sit permanently unresolved while any κ already reported was computed on a
    # unit set that no longer exists. Nothing downstream catches it: every D22 frozen
    # 409 lives in the observations router, and merge never calls a router.
    file_obs = data.get("observations", [])
    local_frozen_by_uuid: dict[str, bool] = {}
    file_obs_uuids = [o.get("uuid") for o in file_obs if o.get("uuid")]
    if file_obs_uuids:
        local_frozen_by_uuid = {
            uuid: frozen_at is not None
            for uuid, frozen_at in db.query(
                Observation.uuid, Observation.segmentation_frozen_at
            ).filter(Observation.uuid.in_(file_obs_uuids)).all()
        }

    open_obs_oldids: set = set()
    obs_uuid_by_oldid: dict = {}
    freeze_conflicts: list[tuple[str, str]] = []
    for o in file_obs:
        oldid, uuid = o["_original_id"], o.get("uuid")
        file_frozen = bool(o.get("segmentation_frozen_at"))
        # No local counterpart = a new source the colleague added: additive, and the
        # parent lookup below would find nothing anyway.
        local_frozen = local_frozen_by_uuid.get(uuid) if uuid else None
        if local_frozen is None or file_frozen == local_frozen:
            if file_frozen:
                obs_uuid_by_oldid[oldid] = uuid  # both frozen → gate normally
            else:
                open_obs_oldids.add(oldid)       # both open → additive, exempt
            continue
        # The sides disagree. Neither direction can be resolved by comparing clip
        # sets, and each needs its OWN instruction — "re-segment to match" is wrong
        # for both, so these never fall through to the segmentation message.
        freeze_conflicts.append((o.get("name") or "?", "local" if local_frozen else "file"))

    if freeze_conflicts:
        local_side = [n for n, side in freeze_conflicts if side == "local"]
        if local_side:
            detail = ", ".join(f"'{n}'" for n in local_side[:5])
            message = (
                f"Segmentation was frozen here after this copy was shared: {detail}"
                f"{'…' if len(local_side) > 5 else ''}. Merging would add clips that "
                "were cut before the freeze, expanding the unit set the freeze marked "
                "as agreed. Unfreeze to accept their clips as part of an open set, or "
                "ask for a copy re-cut against the frozen clips."
            )
        else:
            file_side = [n for n, side in freeze_conflicts if side == "file"]
            detail = ", ".join(f"'{n}'" for n in file_side[:5])
            message = (
                f"This copy froze its segmentation and yours is still open: {detail}"
                f"{'…' if len(file_side) > 5 else ''}. Their clips are an agreed set "
                "and yours are not, so the two cannot be reconciled by merging. Freeze "
                "to the same clips first, or merge a copy that was cut from yours."
            )
        raise MergeDivergenceError(
            message,
            {
                "error": "merge_divergence",
                "kind": "segmentation_freeze",
                "diverged_sources": [
                    {"name": n, "frozen_side": side} for n, side in freeze_conflicts
                ],
            },
        )
    # File: parent uuid -> set of VISIBLE (non-soft-deleted) segment uuids.
    file_segs: dict[str, set] = {}
    # File: parent uuid -> {segment uuid: text}, for TEXT sources ONLY (#694).
    # Deliberately not populated for observations — see the text gate below.
    file_seg_text: dict[str, dict[str, str]] = {}
    for s in data.get("segments", []):
        if s.get("merged_into_id") is not None or s.get("split_into_id") is not None:
            continue
        if not s.get("uuid"):
            continue
        # Observations: exempt from the frozen-segmentation gate iff the source
        # Observation is UNFROZEN (D18 — the exemption is by UNIT PROVENANCE, not
        # parent type).
        #
        # Frozen segmentation exists because text units PARTITION the material: two
        # coders must agree on the turns, or their codings can't line up. An OPEN
        # observation's clips partition nothing — each coder marks their OWN time
        # ranges, and that divergence is the SUBJECT of the reliability statistic
        # (unitizing-α), not a defect to refuse. Requiring identical clip-uuid sets
        # there would refuse every real multi-coder observation merge, so an open
        # observation merges purely ADDITIVELY: both coders' clips coexist.
        #
        # A FROZEN observation is the opposite: the team AGREED the clips, every
        # coder codes the same ones, and consensus/reconciliation/κ run on them —
        # so a colleague who re-cut them HAS diverged, exactly as if they had
        # re-segmented a transcript, and the gate must refuse. Falling through to
        # the parent lookups below does that (the observation branch resolves its
        # uuid like any other source).
        if s.get("observation_id") is not None and s["observation_id"] in open_obs_oldids:
            continue
        text_parent_uuid = (
            conv_uuid_by_oldid.get(s.get("conversation_id"))
            or doc_uuid_by_oldid.get(s.get("document_id"))
        )
        parent_uuid = text_parent_uuid or obs_uuid_by_oldid.get(s.get("observation_id"))
        if parent_uuid:
            file_segs.setdefault(parent_uuid, set()).add(s["uuid"])
            if text_parent_uuid:
                file_seg_text.setdefault(parent_uuid, {})[s["uuid"]] = s.get("text") or ""

    diverged = []
    text_diverged: list[tuple[str, int, int]] = []
    for parent_uuid, file_set in file_segs.items():
        local_conv = db.query(Conversation).filter(Conversation.uuid == parent_uuid).first()
        local_doc = (
            None if local_conv is not None
            else db.query(Document).filter(Document.uuid == parent_uuid).first()
        )
        local_obs = (
            None if (local_conv is not None or local_doc is not None)
            else db.query(Observation).filter(Observation.uuid == parent_uuid).first()
        )
        local_parent = local_conv or local_doc or local_obs
        if local_parent is None:
            continue  # a NEW source the colleague added — additive, not divergence
        # `text` rides the SAME query the uuid check already runs — one extra column,
        # no extra round trip. It is only READ for text sources (#694, below).
        seg_q = db.query(Segment.uuid, Segment.text).filter(
            Segment.merged_into_id.is_(None), Segment.split_into_id.is_(None)
        )
        # The FK column MUST be chosen by the parent's KIND. The three tables have
        # independent id sequences, so filtering an observation parent by
        # `Segment.document_id == 7` would silently compare against a DIFFERENT
        # source's segments.
        if local_conv is not None:
            seg_q = seg_q.filter(Segment.conversation_id == local_parent.id)
        elif local_doc is not None:
            seg_q = seg_q.filter(Segment.document_id == local_parent.id)
        else:
            seg_q = seg_q.filter(Segment.observation_id == local_parent.id)
        local_rows = [(u, t) for (u, t) in seg_q.all() if u]
        local_set = {u for u, _ in local_rows}
        if file_set != local_set:
            diverged.append((getattr(local_parent, "name", "?"), len(file_set), len(local_set)))
            # Short-circuit ONLY. What makes segmentation win is the raise ORDER below
            # (its block runs first), not this line — verified by mutation: replacing
            # this `continue` with `pass` leaves the whole suite green. It is kept
            # because comparing text across mismatched unit sets is wasted work whose
            # every "difference" is really the uuid mismatch already being reported.
            continue

        # ── Segment-text gate (#694) ────────────────────────────────────
        # The uuid sets match, so the two copies agree on the UNITS. They can still
        # disagree on the WORDS: a colleague who corrects a transcription typo keeps
        # the segment's uuid and the count, so every check above passes — while their
        # codings, and especially their char-range quote offsets, were made against
        # text this project does not have. A merge KEEPS the target's field values
        # (J3-2 trap 2), so their text is discarded and their quotes are re-anchored
        # onto ours, silently pointing at the wrong words. Same class as #687, reached
        # from the other end.
        #
        # ⚠️ TEXT SOURCES ONLY — never observations. A clip's `text` is a LABEL, i.e.
        # annotation rather than material: D22 keeps label edits legal on a frozen
        # observation, and a clip's quotes are TIME-range, so there are no character
        # offsets for an edited label to invalidate. Comparing labels here would refuse
        # a merge for an edit the design explicitly permits. `file_seg_text` is only
        # populated for conv/doc, so this is enforced by construction rather than by a
        # parent check that a later edit could drop.
        #
        # ⚠️ Compared RAW — no whitespace or unicode normalization. Offsets are code
        # points (#687), so ANY edit shifts every offset after it; normalizing would
        # accept exactly the differences that break a quote.
        file_text = file_seg_text.get(parent_uuid)
        if file_text:
            changed = sum(1 for u, t in local_rows if file_text.get(u, "") != (t or ""))
            if changed:
                text_diverged.append(
                    (getattr(local_parent, "name", "?"), changed, len(local_set))
                )

    if diverged:
        detail = "; ".join(f"'{n}' (file {fc} vs local {lc} segments)" for n, fc, lc in diverged[:5])
        raise MergeDivergenceError(
            f"Segmentation diverged in {len(diverged)} source(s): {detail}"
            f"{'…' if len(diverged) > 5 else ''}. Merging requires frozen segmentation so "
            "codings line up; re-segment to match before merging, or divide the work without "
            "re-segmenting.",
            {
                "error": "merge_divergence",
                "kind": "segmentation",
                "diverged_sources": [
                    {"name": n, "file_segments": fc, "local_segments": lc}
                    for n, fc, lc in diverged
                ],
            },
        )

    if text_diverged:
        detail = "; ".join(
            f"'{n}' ({c} of {t} segments)" for n, c, t in text_diverged[:5]
        )
        raise MergeDivergenceError(
            f"The text differs in {len(text_diverged)} source(s): {detail}"
            f"{'…' if len(text_diverged) > 5 else ''}. The segments match, so this copy "
            "was coded against edited words — quotes would be re-anchored onto text "
            "their author never saw. Decide whose text is correct first: re-export from "
            "the copy that has the correction, or ask for a copy re-exported from this "
            "project.",
            {
                "error": "merge_divergence",
                "kind": "segment_text",
                # Counts only — the segment text is research data and this payload
                # reaches a browser and any request log.
                "diverged_sources": [
                    {"name": n, "changed_segments": c, "total_segments": t}
                    for n, c, t in text_diverged
                ],
            },
        )


def build_merge_coder_preview(db: Session, file_path: Path) -> list[dict]:
    """Track J · J3-2 (D8): read-only preview of an incoming merge file's coders, each
    with its local name-match candidate + application counts, so the confirm UI can
    map/override before committing. System coders (Unattributed/Consensus) are excluded —
    they own data but aren't selectable people. ``local_app_count`` is the local coder's
    total applications (global; on the common single-project install that equals the
    project's count). Returns rows shaped for ``MergeCoderPreview``."""
    from ..auth import SYSTEM_CODER_TYPES
    with zipfile.ZipFile(str(file_path), "r") as zf:
        data = json.loads(zf.read("project.json"))

    # File-side application count per coder (the exported user_id == the coder's
    # _original_id in the same file).
    file_counts: dict[int, int] = {}
    for app in data.get("code_applications", []):
        uid = app.get("user_id")
        if uid is not None:
            file_counts[uid] = file_counts.get(uid, 0) + 1

    previews: list[dict] = []
    for c in data.get("coders", []):
        if c.get("coder_type") in SYSTEM_CODER_TYPES:
            continue
        name = c.get("username")
        local = db.query(User).filter(User.username == name).first() if name else None
        local_match = None
        if local is not None:
            local_match = {
                "id": local.id,
                "username": local.username,
                "archived": bool(local.archived),
                "local_app_count": db.query(CodeApplication)
                .filter(CodeApplication.user_id == local.id)
                .count(),
            }
        previews.append({
            "original_id": c["_original_id"],
            "username": name,
            "coder_type": c.get("coder_type", "human"),
            "archived": bool(c.get("archived", False)),
            "file_app_count": file_counts.get(c["_original_id"], 0),
            "local_match": local_match,
        })
    return previews


# Reconcile triage: how many ranked local candidates to surface per divergent code,
# and the similarity at/above which a candidate is flagged "confident" (the crosswalk
# Suggest auto-pair threshold — the internal design notes).
_MERGE_CODE_CANDIDATE_LIMIT = 5
_MERGE_CODE_CONFIDENT_SIMILARITY = 0.70


def build_merge_code_preview(
    db: Session, file_path: Path, target_project_id: int,
) -> list[dict]:
    """Track J · J3-2b: read-only preview of an incoming merge file's DIVERGENT codes
    (uuid not present in the local codebook — the same set `_assert_merge_compatible`
    would refuse), each with file-side usage + the target project's local codes ranked
    by name similarity, so the reconcile UI can map each to collapse / link / new.

    Returns rows shaped for ``MergeCodePreview`` (empty when the codebook is
    shared-frozen — no divergence — which is the common case). Categories are shown
    for context only; they are never matched on (R5). Read-only — no DB writes."""
    with zipfile.ZipFile(str(file_path), "r") as zf:
        data = json.loads(zf.read("project.json"))

    file_codes = data.get("codes", [])
    file_code_uuids = {c["uuid"] for c in file_codes if c.get("uuid")}
    if not file_code_uuids:
        return []
    # Divergent == file code whose uuid is not local. Mirrors the gate's check exactly
    # (global; uuid is globally unique, so == "not in the matched target project").
    local_uuids = {
        u for (u,) in db.query(Code.uuid).filter(Code.uuid.in_(file_code_uuids)).all()
    }
    divergent = [c for c in file_codes if c.get("uuid") and c["uuid"] not in local_uuids]
    if not divergent:
        return []

    # File-side application count per code (exported code_id == the code's _original_id).
    file_counts: dict[int, int] = {}
    for app in data.get("code_applications", []):
        cid = app.get("code_id")
        if cid is not None:
            file_counts[cid] = file_counts.get(cid, 0) + 1

    # File category names by id (context only — R5).
    file_cat_names = {
        cat["_original_id"]: cat.get("name") for cat in data.get("code_categories", [])
    }

    # Local candidate codes (target project, real codes — not universal, not inactive)
    # + their usage, in one grouped query.
    local_codes = (
        db.query(Code)
        .filter(
            Code.project_id == target_project_id,
            Code.is_universal == False,  # noqa: E712 (SQLAlchemy column comparison)
            Code.is_active == True,       # noqa: E712
        )
        .all()
    )
    usage_map: dict[int, int] = {}
    if local_codes:
        local_ids = [lc.id for lc in local_codes]
        for cid, n in (
            db.query(CodeApplication.code_id, code_usage_count_expr())
            .filter(CodeApplication.code_id.in_(local_ids), non_consensus_filter())
            .group_by(CodeApplication.code_id)
            .all()
        ):
            usage_map[cid] = n

    previews: list[dict] = []
    for c in divergent:
        name = c.get("name") or ""
        scored = sorted(
            ((similarity_ratio(name, lc.name or ""), lc) for lc in local_codes),
            key=lambda t: t[0],
            reverse=True,
        )
        candidates = [
            {
                "code_id": lc.id,
                "name": lc.name,
                "description": lc.description,
                "usage": usage_map.get(lc.id, 0),
                "similarity": round(sim, 4),
                "confident": sim >= _MERGE_CODE_CONFIDENT_SIMILARITY,
            }
            for sim, lc in scored[:_MERGE_CODE_CANDIDATE_LIMIT]
        ]
        previews.append({
            "uuid": c["uuid"],
            "name": c.get("name"),
            "description": c.get("description"),
            "color": c.get("color"),
            "category_name": file_cat_names.get(c.get("category_id")),
            "file_app_count": file_counts.get(c["_original_id"], 0),
            "candidates": candidates,
        })
    return previews


def _repair_pre_v5_excerpt_offsets(
    db: Session, data: dict, remap: dict, inserted_excerpt_ids: set[int],
) -> int:
    """Convert an old archive's UTF-16 excerpt offsets to code points (#687).

    Format v5 is the first to write code-point offsets. Anything earlier carries the
    browser's UTF-16 basis unconverted, so an excerpt on a segment containing an
    astral character (emoji, CJK Ext-B, ZWJ sequence, flag, skin-tone modifier)
    points at the wrong text — the same defect the repair migration fixed in place,
    arriving through the other door.

    Scoped to segments whose text actually contains an astral character: every BMP
    character is one unit in BOTH bases, so for everything else the stored number is
    already correct and rewriting it would be a no-op at best. That is what keeps
    this safe to run over an entire archive.

    ⚠️ ``inserted_excerpt_ids`` is REQUIRED, and it is the whole correctness argument
    (#714). The conversion is only valid on rows whose offsets CAME OUT OF THIS FILE.
    Under ``import_mode="merge"`` the excerpt remap also points at rows that already
    existed locally — matched by uuid, which is the designed multi-coder flow, so
    those are exactly the shared quotes both copies carry. Those rows already hold
    code points (the repair migration converted them, or a post-fix build wrote
    them), so converting again shifts them one place per preceding astral character:
    silent, permanent, and on data this import never wrote. Reading `remap` here
    instead of the inserted set is what caused that, so the parameter has no default
    — a future caller has to answer the question rather than inherit a wrong answer.

    Returns the number of excerpts rewritten (for the import report / tests).
    """
    if int(data.get("format_version", 0) or 0) >= 5:
        return 0

    excerpt_remap = remap.get("excerpts", {})
    # No `or not inserted_excerpt_ids` short-circuit here on purpose: the filter
    # below already yields nothing against an empty set, so the extra clause could
    # not be killed by mutation — and it actively HID a broken filter, because a
    # merge where every excerpt matches leaves the set empty and returns here before
    # the filter ever runs.
    if not excerpt_remap:
        return 0

    # Only char-range excerpts can be affected; time ranges are seconds (D29) and
    # whole-segment excerpts carry no offsets at all.
    char_range_old_ids = {
        it.get("_original_id")
        for it in data.get("excerpts", [])
        if it.get("start_offset") is not None
    }
    new_ids = [
        nid for old_id, nid in excerpt_remap.items()
        if old_id in char_range_old_ids and nid in inserted_excerpt_ids
    ]
    if not new_ids:
        return 0

    repaired = 0
    rows = (
        db.query(Excerpt, Segment.text)
        .join(Segment, Excerpt.segment_id == Segment.id)
        .filter(Excerpt.id.in_(new_ids), Excerpt.start_offset.isnot(None))
        .all()
    )
    for excerpt, text in rows:
        if not text or not has_astral(text):
            continue
        new_start = utf16_to_codepoint(text, excerpt.start_offset)
        new_end = utf16_to_codepoint(text, excerpt.end_offset)
        # ck_excerpt_offsets_valid_range needs end > start STRICTLY; a range that
        # collapses under conversion was already degenerate, so leave it be rather
        # than fail the whole import over one malformed row.
        if new_end <= new_start or (new_start == excerpt.start_offset and new_end == excerpt.end_offset):
            continue
        excerpt.start_offset = new_start
        excerpt.end_offset = new_end
        repaired += 1

    if repaired:
        db.flush()
    return repaired


def _extract_zip_member(
    zf: zipfile.ZipFile, member: str, target_path: Path, base_dir: Path
) -> None:
    """Stream one archive member to target_path in fixed-size chunks.

    #567: media files can be up to 4 GB (MAX_MEDIA_SIZE) against a <256 MB
    backend memory target, so NEVER buffer the whole member in RAM
    (``dst.write(src.read())`` would). ``shutil.copyfileobj`` reads in 1 MiB
    slices — matching the upload path's streaming (``_stream_upload_to_temp``).

    #688: the containment check lives HERE, not at the call sites, and ``base_dir``
    is REQUIRED for that reason. This function opens the member with ``zf.open()``
    and writes through a manually-joined path — which bypasses the member
    sanitisation CPython applies inside ``zf.extract`` — so it is the last place the
    destination can be judged, and the only place all three call sites pass through.
    The old top-of-import name scan is retained as a cheap pre-flight, but it is no
    longer what makes extraction safe: it matched patterns (``startswith("/")``,
    ``".." in name``) and a Windows drive-absolute member defeated both.
    """
    assert_member_within(base_dir, target_path, member)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with zf.open(member) as src, open(target_path, "wb") as dst:
        shutil.copyfileobj(src, dst, length=1024 * 1024)


def import_project(
    db: Session,
    file_path: Path,
    docs_dir: Path,
    media_dir: Path | None = None,
    user_id: int | None = None,
    import_mode: str = "new",
    target_project_id: int | None = None,
    coder_mapping: dict | None = None,
    code_mapping: dict | None = None,
    report: dict | None = None,
) -> tuple[int, str]:
    """Import an .mmproject ZIP.

    import_mode="new" (default): always create a NEW project with a fresh project_uuid
    (and fresh J3-2-0 entity uuids).
    import_mode="overwrite" (Track J · J3-1): replace `target_project_id` — an existing
    local project that shares the file's stable project_uuid — preserving that uuid so
    the project keeps its identity across the round-trip. Takes a safety export first,
    then deletes the target (freeing the unique uuid) before re-inserting.
    import_mode="copy_for_coding" (Track J · J3-2): import a co-coder's working copy that
    PRESERVES identity (project_uuid + entity uuids) so it can be merged back later.
    Creates a new project; refuses if that identity already exists locally (merge instead).
    import_mode="merge" (Track J · J3-2): merge a colleague's codings/annotations on SHARED
    sources INTO `target_project_id` (matched by project_uuid). Refuses divergent
    segmentation/codebook (raises MergeDivergenceError BEFORE any write).

    `coder_mapping` (merge only): {file_coder_original_id(str) -> {"action": "match"|"create",
    "target_user_id"?: int, "new_username"?: str, "unarchive"?: bool}}. Decides how each
    incoming coder maps to a local roster coder (D8 confirm). When omitted/absent for a
    coder, falls back to the legacy silent name-match.
    `code_mapping` (merge only, J3-2b): {file_code_uuid(str) -> {"action": "collapse"|"link"|
    "new", "target_code_id"?: int, "combined_label"?: str}}. Reconciles each DIVERGENT code
    (uuid not local): collapse → remap its codings onto an existing local code (no new code);
    link → insert it + group it with a local code (one effective code); new → insert it
    standalone. Every divergent code MUST have a decision or the merge is refused.
    `report` (merge only): a dict the caller passes in; populated in-place with the merge
    counts (sources_matched / applications_added / duplicates_skipped / coders_created /
    coders_matched).

    Returns (new_project_id, project_name).
    Wraps everything in the caller's transaction — caller commits or rolls back.
    """
    if report is not None:
        report.setdefault("sources_matched", 0)
        report.setdefault("applications_added", 0)
        report.setdefault("duplicates_skipped", 0)
        report.setdefault("coders_created", 0)
        report.setdefault("coders_matched", 0)
        report.setdefault("codes_collapsed", 0)
        report.setdefault("codes_linked", 0)
        report.setdefault("codes_created", 0)
    with zipfile.ZipFile(str(file_path), "r") as zf:
        # Cheap pre-flight (matches validate_project_file). Per-member containment
        # is enforced inside `_extract_zip_member`; the expansion cap is #696.
        # Both run HERE too rather than trusting /validate-import — same reasoning
        # as the format gate three lines down (see its helper docstring).
        for name in zf.namelist():
            if name.startswith("/") or ".." in name:
                raise ValueError(f"Invalid project file: suspicious path '{name}'")
        assert_expanded_size_within_limit(zf)

        # Format gate — must run here too, not just in /validate-import (see helper docstring)
        _read_manifest_and_check_format(zf)

        data = json.loads(zf.read("project.json"))

        if import_mode == "merge":
            # Track J · J3-2: a merge imports a colleague's CODINGS + annotations on
            # SHARED sources only. The frozen dataset/codebook structure the target
            # already owns, and the colleague's analysis + workspace artifacts, are NOT
            # merged — blank those sections so their import loops are no-ops (no per-loop
            # guards). DatasetValue + CodeApplication are handled specially below
            # (transitive-match / dedup); equivalence-group reconciliation is J3-2b.
            for _k in (
                "code_equivalence_groups", "equivalence_groups", "recode_definitions",
                "analysis_domains", "analysis_domain_members", "metric_definitions",
                "computed_results", "row_scores", "statistical_tests",
                "material_collections", "materials", "canvases", "canvas_themes",
                "canvas_theme_relationships", "canvas_pending_items", "scratchpad_entries",
            ):
                data[_k] = []
            data["text_coding_config"] = None
            data["quote_board_config"] = None

        remap: dict[str, dict[int, int]] = {
            "projects": {}, "participants": {}, "speakers": {},
            "conversations": {}, "documents": {}, "observations": {},
            "segment_groups": {},
            "segments": {}, "code_categories": {}, "codes": {},
            "code_equivalence_groups": {},
            "datasets": {}, "equivalence_groups": {}, "dataset_columns": {},
            "dataset_rows": {}, "dataset_values": {}, "recode_definitions": {},
            "excerpts": {}, "notes": {}, "memos": {}, "analysis_domains": {},
            "metric_definitions": {}, "material_collections": {},
            "materials": {}, "scratchpad_entries": {},
            "canvases": {}, "canvas_themes": {},
            "canvas_pending_items": {}, "coders": {},
        }

        # #714: which rows this import actually INSERTED, per remap key.
        #
        # `remap` alone cannot answer that. A MERGE remaps a matched entity onto a
        # row that ALREADY EXISTED in the target, so every value in `remap` is
        # either "we wrote this" or "this was already here" with nothing to tell
        # them apart — and a post-pass that rewrites the second kind is editing the
        # user's own data, which `_add`'s match branch deliberately never does.
        # Any post-pass that MUTATES imported rows must read this, not `remap`.
        inserted_ids: dict[str, set[int]] = {}

        def _add(model, item, overrides=None, remap_key=None):
            """Build entity from export dict, add to session, track in remap.

            Track J · J3-2 merge: when import_mode == "merge", first try to MATCH an
            existing local entity by its stable J3-2-0 uuid (it already lives in the
            target) and record the remap to it instead of inserting a duplicate —
            children re-point at the matched row transparently through `remap`. Matched
            entities keep the TARGET's field values (a frozen merge never overwrites the
            shared sources with the colleague's copy).
            """
            if import_mode == "merge" and remap_key:
                incoming_uuid = item.get("uuid")
                if incoming_uuid and "uuid" in sa_inspect(model).columns.keys():
                    # #449(c): scope the match to the target project (defense-in-depth) so a
                    # file entity can never match a row in an UNRELATED local project.
                    existing = _merge_uuid_match(db, model, incoming_uuid, pid).first()
                    if existing is not None:
                        remap[remap_key][item["_original_id"]] = existing.id
                        if report is not None and remap_key in (
                            "conversations", "documents", "observations",
                        ):
                            report["sources_matched"] += 1
                        return existing
            obj = _build_entity(model, item, overrides, fresh_uuid=(import_mode == "new"))
            db.add(obj)
            db.flush()
            if remap_key:
                remap[remap_key][item["_original_id"]] = obj.id
                inserted_ids.setdefault(remap_key, set()).add(obj.id)
            return obj

        # ── a. Project ──────────────────────────────────────────────
        pdata = data["project"]
        incoming_uuid = pdata.get("project_uuid")

        if import_mode == "merge":
            # Track J · J3-2: merge a colleague's copy INTO an existing project. Match the
            # target by project_uuid (never create one); the entity loop below matches
            # shared sources by their J3-2-0 uuid and only inserts new codings/annotations.
            # Safety-export the target first (pre-merge backup, §10.1; reuses the J3-1 helper).
            if target_project_id is None or not incoming_uuid:
                raise ValueError(
                    "Merge requires a target project and a file that carries a project_uuid."
                )
            target = db.query(Project).filter(Project.id == target_project_id).first()
            if target is None:
                raise ValueError("Target project for merge not found.")
            if target.project_uuid != incoming_uuid:
                raise ValueError(
                    "Target project identity does not match the file. Re-validate the "
                    "import before merging."
                )
            # J3-2c gate (+ J3-2b reconcile): refuse a divergent merge BEFORE any writes
            # (no safety backup is written for a merge that's going to be refused) —
            # EXCEPT divergent codes the caller reconciled via code_mapping.
            _assert_merge_compatible(
                db, data, code_mapping=code_mapping, target_project_id=target.id,
            )
            _safety_export_before_overwrite(db, target, docs_dir, media_dir)
            new_project = target
            pid = target.id
            project_name = target.name
            remap["projects"][pdata["_original_id"]] = pid
        elif import_mode == "overwrite":
            # Track J · J3-1 round-trip: replace an existing local project that shares
            # this file's stable identity, PRESERVING its project_uuid. Validate the
            # target matches the incoming uuid (never overwrite a different project),
            # safety-export it (recovery net), then delete it so the preserved uuid is
            # free before re-insert (flush so the cascade + unique-index release apply
            # within this txn — autoflush is OFF, see database.py).
            if target_project_id is None or not incoming_uuid:
                raise ValueError(
                    "Overwrite import requires a target project and a file that carries "
                    "a project_uuid."
                )
            target = db.query(Project).filter(Project.id == target_project_id).first()
            if target is None:
                raise ValueError("Target project for overwrite not found.")
            # Ownership is gated by the caller (the endpoint mirrors list_projects'
            # multiuser-aware visibility). The identity check below is the service's
            # own safety: never overwrite a project whose uuid doesn't match the file.
            if target.project_uuid != incoming_uuid:
                raise ValueError(
                    "Target project identity does not match the file. Re-validate the "
                    "import before overwriting."
                )
            _safety_export_before_overwrite(db, target, docs_dir, media_dir)
            db.delete(target)
            db.flush()
            project_name = pdata["name"]
            project_uuid_override = incoming_uuid
        elif import_mode == "copy_for_coding":
            # Track J · J3-2: import a co-coder's WORKING COPY that PRESERVES identity
            # (project_uuid + the J3-2-0 entity uuids, via fresh_uuid=False below) so it
            # can be merged back later. Creates a new project; refuse if this identity
            # already exists locally — you should MERGE the file into it, not import a
            # second copy.
            if not incoming_uuid:
                raise ValueError(
                    "This file has no stable identity; import it as a new project instead."
                )
            clash = db.query(Project).filter(Project.project_uuid == incoming_uuid).first()
            if clash is not None:
                raise ValueError(
                    "You already have this project here — merge the file into it instead "
                    "of importing another coding copy."
                )
            project_name = pdata["name"]
            existing = db.query(Project).filter(Project.name == project_name).first()
            if existing:
                project_name = f"{project_name} (coding copy)"
            project_uuid_override = incoming_uuid
        else:
            # import_mode == "new": always a NEW project with a FRESH stable identity —
            # never copy the source's project_uuid (it would collide on the unique
            # index when re-importing into the same instance).
            project_name = pdata["name"]
            existing = db.query(Project).filter(Project.name == project_name).first()
            if existing:
                project_name = f"{project_name} (imported)"
            project_uuid_override = str(uuid.uuid4())

        if import_mode != "merge":
            # merge matched the target above; every other mode creates the project here.
            project_overrides = {"name": project_name, "project_uuid": project_uuid_override}
            if user_id is not None:
                project_overrides["user_id"] = user_id
            new_project = _add(Project, pdata, project_overrides, "projects")
            pid = new_project.id

        # ── a2. Coders (Track J · J1/J3-2): map each incoming coder to a local roster
        #     coder so the code_applications user_id remap below preserves attribution.
        #     A merge can carry an explicit `coder_mapping` (the D8 confirm UI's
        #     decisions): "match" onto a chosen local coder, or "create" a new one
        #     (suffix-on-collision). With no decision for a coder — and for every
        #     non-merge import — fall back to the legacy silent name-match.
        for item in data.get("coders", []):
            oid = item["_original_id"]
            name = item.get("username")
            decision = (coder_mapping or {}).get(str(oid)) if coder_mapping else None

            if decision and decision.get("action") == "match" and decision.get("target_user_id"):
                target_coder = (
                    db.query(User).filter(User.id == decision["target_user_id"]).first()
                )
                if target_coder is None:
                    raise ValueError(
                        f"Coder mapping points at a local coder (id {decision['target_user_id']}) "
                        "that no longer exists. Re-validate the import before merging."
                    )
                remap["coders"][oid] = target_coder.id
                if decision.get("unarchive") and target_coder.archived:
                    target_coder.archived = False  # DEC-F: bring a colleague back into voting
                if report is not None:
                    report["coders_matched"] += 1
            elif decision and decision.get("action") == "create":
                base = (decision.get("new_username") or name or "Coder").strip() or "Coder"
                _add(
                    User, item,
                    {"username": unique_username(db, base), "password_hash": None, "is_admin": False},
                    "coders",
                )
                if report is not None:
                    report["coders_created"] += 1
            else:
                existing_coder = (
                    db.query(User).filter(User.username == name).first() if name else None
                )
                if existing_coder:
                    remap["coders"][oid] = existing_coder.id
                    if report is not None:
                        report["coders_matched"] += 1
                else:
                    _add(User, item, {"password_hash": None, "is_admin": False}, "coders")
                    if report is not None:
                        report["coders_created"] += 1

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

        # ── e2. Observations (the third Segment parent) ────────────
        # MUST precede segments (g), notes (r) and memos (s) — they all remap
        # through remap["observations"]. A merge matches them by uuid like any
        # other source, so a colleague's clips land on the shared Observation.
        for item in data.get("observations", []):
            _add(Observation, item, {"project_id": pid}, "observations")

        # ── f. SegmentGroups ───────────────────────────────────────
        for item in data.get("segment_groups", []):
            _add(SegmentGroup, item, {
                "conversation_id": _remap_id(remap, "conversations", item.get("conversation_id")),
            }, "segment_groups")

        # ── g. Segments (two-pass for self-refs) ───────────────────
        # #449(b): a merge matches existing local segments by uuid. Capture which file
        # segments ALREADY exist locally (snapshot BEFORE the insert loop) so the self-ref
        # pass below never rewrites a matched segment — the target owns the frozen structure
        # and already carries the correct merged_into_id/split_into_id.
        pre_existing_seg_uuids: set = set()
        if import_mode == "merge":
            _file_seg_uuids = {s["uuid"] for s in data.get("segments", []) if s.get("uuid")}
            if _file_seg_uuids:
                pre_existing_seg_uuids = {
                    u for (u,) in db.query(Segment.uuid)
                    .filter(Segment.uuid.in_(_file_seg_uuids)).all()
                }

        segment_self_refs = []
        for item in data.get("segments", []):
            # EVERY parent FK must be remapped here. `_build_entity` copies any column
            # NOT in this overrides dict verbatim from the file, so a missing parent
            # is not a null — it is the SOURCE instance's raw id written into this
            # database. With PRAGMA foreign_keys=ON that either attaches the segment
            # to an unrelated project's row (silent cross-project corruption) or dies
            # on an opaque IntegrityError. It can never be a harmless NULL, because
            # ck_segment_exactly_one_parent forbids all-three-NULL.
            _add(Segment, item, {
                "conversation_id": _remap_id(remap, "conversations", item.get("conversation_id")),
                "document_id": _remap_id(remap, "documents", item.get("document_id")),
                "observation_id": _remap_id(remap, "observations", item.get("observation_id")),
                "speaker_id": _remap_id(remap, "speakers", item.get("speaker_id")),
                "group_id": _remap_id(remap, "segment_groups", item.get("group_id")),
                "merged_into_id": None,
                "split_into_id": None,
            }, "segments")
            if item.get("merged_into_id") or item.get("split_into_id"):
                segment_self_refs.append(item)

        for item in segment_self_refs:
            # #449(b): never touch a segment that matched an existing local row — it already
            # carries correct self-refs; rewriting it could un-soft-delete a target segment.
            if import_mode == "merge" and item.get("uuid") in pre_existing_seg_uuids:
                continue
            new_id = remap["segments"][item["_original_id"]]
            updates = {}
            # #449(b): only set a self-ref when its target actually remapped. A malformed or
            # hand-edited file whose merged_into_id/split_into_id points at a non-exported
            # segment would otherwise NULL the ref (un-soft-deleting the segment) — skip it.
            # (Hardens every import mode, not just merge.)
            if item.get("merged_into_id"):
                tgt = remap["segments"].get(item["merged_into_id"])
                if tgt is not None:
                    updates["merged_into_id"] = tgt
                else:
                    logger.warning(
                        "Segment %s merged_into_id target not in import; leaving unset",
                        item["_original_id"],
                    )
            if item.get("split_into_id"):
                tgt = remap["segments"].get(item["split_into_id"])
                if tgt is not None:
                    updates["split_into_id"] = tgt
                else:
                    logger.warning(
                        "Segment %s split_into_id target not in import; leaving unset",
                        item["_original_id"],
                    )
            if updates:
                db.query(Segment).filter(Segment.id == new_id).update(updates)
        if segment_self_refs:
            db.flush()

        # ── h. CodeCategories (topological order) ──────────────────
        _import_categories_topological(
            db, data.get("code_categories", []), pid, remap,
            import_mode=import_mode,
        )

        # ── h.5. CodeEquivalenceGroups (BEFORE codes — codes carry the
        # code_equivalence_group_id FK; opposite order from dataset EGs, which
        # import after their columns). canonical_code_id is a PLAIN int (not a
        # FK), so _build_entity would copy the stale source id — null it here and
        # remap it in a post-pass once remap["codes"] is populated (ADJ-4/C1).
        for item in data.get("code_equivalence_groups", []):
            _add(CodeEquivalenceGroup, item, {
                "project_id": pid,
                "canonical_code_id": None,
            }, "code_equivalence_groups")

        # ── i. Codes ───────────────────────────────────────────────
        # Track J · J3-2b: in a merge, a code either MATCHES locally by uuid (handled by
        # _add, keeps the target's copy) or is DIVERGENT and carries a reconcile decision
        # (the gate guaranteed every divergent code is decided). Apply the decision here:
        #   collapse → seed remap["codes"] onto the chosen local code, skip the insert
        #              (its codings re-point + dedup downstream — no new code, no merge_codes);
        #   link/new → insert with a FRESH numeric_id (a verbatim copy collides on
        #              ix_codes_project_numeric, untested in frozen merge), link → queue a
        #              CodeEquivalenceGroup so both resolve to one effective code.
        merge_link_requests: list[tuple[int, int, str | None]] = []  # (new_id, target_id, label)
        local_code_uuids_for_merge: set = set()
        merge_next_numeric = [0]
        if import_mode == "merge":
            _file_uuids = {c["uuid"] for c in data.get("codes", []) if c.get("uuid")}
            if _file_uuids:
                local_code_uuids_for_merge = {
                    u for (u,) in db.query(Code.uuid).filter(Code.uuid.in_(_file_uuids)).all()
                }
            # NOT `(max or -1)` — a legitimate max of 0 (a project with one code) is falsy
            # and would wrap back to 0, colliding on ix_codes_project_numeric.
            _max_numeric = db.query(func.max(Code.numeric_id)).filter(Code.project_id == pid).scalar()
            merge_next_numeric[0] = (_max_numeric + 1) if _max_numeric is not None else 0

        for item in data.get("codes", []):
            if import_mode == "merge":
                _uuid = item.get("uuid")
                decision = (code_mapping or {}).get(_uuid) if _uuid else None
                is_divergent = bool(_uuid) and _uuid not in local_code_uuids_for_merge
                if is_divergent and decision:
                    action = decision.get("action")
                    if action == "collapse":
                        remap["codes"][item["_original_id"]] = decision["target_code_id"]
                        if report is not None:
                            report["codes_collapsed"] += 1
                        continue
                    # link / new: insert with a fresh numeric_id (not the file's).
                    obj = _add(Code, item, {
                        "project_id": pid,
                        "numeric_id": merge_next_numeric[0],
                        "category_id": _remap_id(remap, "code_categories", item.get("category_id")),
                        "code_equivalence_group_id": None,
                    }, "codes")
                    merge_next_numeric[0] += 1
                    if action == "link":
                        merge_link_requests.append(
                            (obj.id, decision["target_code_id"], decision.get("combined_label"))
                        )
                        if report is not None:
                            report["codes_linked"] += 1
                    elif report is not None:
                        report["codes_created"] += 1
                    continue
            _add(Code, item, {
                "project_id": pid,
                "category_id": _remap_id(remap, "code_categories", item.get("category_id")),
                "code_equivalence_group_id": _remap_id(
                    remap, "code_equivalence_groups", item.get("code_equivalence_group_id")
                ),
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
                # 🔴 SELF-REFERENCING FK (Decision B) — nulled here, resolved in the
                # post-pass below. It cannot be remapped in this loop: it points at
                # another row of the table currently being inserted, which may not
                # exist yet. Leaving it OUT of the overrides is not neutral either —
                # `_build_entity` copies any column the import does not explicitly
                # remap, so the SOURCE instance's raw id would be written into this
                # database, which is the exact hazard `backend-invariants.md` §6
                # names for un-remapped parent FKs.
                "derived_from_column_id": None,
            }, "dataset_columns")

        # ── l-bis. Derived-column provenance (Decision B) ──────────
        # The self-reference resolved once every column of this import exists.
        #
        # 🔴 Scoped to `inserted_ids`, NEVER `remap` (#714). On a MERGE, `remap`
        # maps a uuid-matched file column onto a row that ALREADY EXISTED locally,
        # and a merge deliberately keeps the target's field values — so writing
        # through `remap` would overwrite the target's own correct provenance with
        # the colleague's. This is the trap `_repair_pre_v5_excerpt_offsets`
        # documents, and it is silent.
        #
        # ⚠️ An all-matched merge leaves the inserted set EMPTY. Do not add an
        # early return on it: that is what let a mutant survive during #714's fix.
        _inserted_cols = inserted_ids.get("dataset_columns", set())
        for item in data.get("dataset_columns", []):
            src = item.get("derived_from_column_id")
            if src is None:
                continue
            new_id = remap["dataset_columns"].get(item["_original_id"])
            if new_id is None or new_id not in _inserted_cols:
                continue
            resolved = _remap_id(remap, "dataset_columns", src)
            if resolved is not None:
                db.query(DatasetColumn).filter(DatasetColumn.id == new_id).update(
                    {"derived_from_column_id": resolved}, synchronize_session=False,
                )
        # ⚠️ NO `CURRENT_FORMAT_VERSION` bump, and this is a decision rather than
        # an omission. The gate REFUSES a file whose version exceeds the reader's,
        # so bumping would stop a colleague on v1.3.2 importing this build's
        # projects at all. `derived_from_column_id` and `derived_via` are purely
        # descriptive — an older build drops both and keeps the column, its cells,
        # its value labels and its missing declaration intact. That is the opposite
        # of v4's case (`missing_values`), which was bumped because losing it
        # changed every statistic on the column, silently.

        # ── m. DatasetRows ─────────────────────────────────────────
        for item in data.get("dataset_rows", []):
            _add(DatasetRow, item, {
                "dataset_id": _remap_id(remap, "datasets", item.get("dataset_id")),
                "participant_id": _remap_id(remap, "participants", item.get("participant_id")),
            }, "dataset_rows")

        # ── n. DatasetValues ───────────────────────────────────────
        for item in data.get("dataset_values", []):
            row_id = _remap_id(remap, "dataset_rows", item.get("row_id"))
            column_id = _remap_id(remap, "dataset_columns", item.get("column_id"))
            if import_mode == "merge" and row_id is not None and column_id is not None:
                # DatasetValue has no uuid — match transitively on (row, column) (unique).
                # The value already exists in the target (frozen dataset); re-point at it.
                existing_val = (
                    db.query(DatasetValue)
                    .filter(DatasetValue.row_id == row_id, DatasetValue.column_id == column_id)
                    .first()
                )
                if existing_val is not None:
                    remap["dataset_values"][item["_original_id"]] = existing_val.id
                    continue
            _add(DatasetValue, item, {
                "row_id": row_id,
                "column_id": column_id,
            }, "dataset_values")

        # ── o. RecodeDefinitions (topological) ─────────────────────
        _import_recodes_topological(
            db, data.get("recode_definitions", []), remap, import_mode=import_mode
        )

        # ── p. Excerpts ────────────────────────────────────────────
        for item in data.get("excerpts", []):
            _add(Excerpt, item, {
                "project_id": pid,
                "segment_id": _remap_id(remap, "segments", item.get("segment_id")),
                "dataset_value_id": _remap_id(remap, "dataset_values", item.get("dataset_value_id")),
            }, "excerpts")

        # #687: a pre-v5 archive carries UTF-16 offsets. Repair AFTER the excerpts
        # land, because the conversion needs each one's segment TEXT, which is only
        # addressable once both rows exist and the FK has been remapped. #714: only
        # the rows THIS import inserted — a merge-matched row is the target's own
        # data and already speaks code points.
        _repair_pre_v5_excerpt_offsets(
            db, data, remap, inserted_ids.get("excerpts", set()),
        )

        # ── q. CodeApplications ────────────────────────────────────
        for item in data.get("code_applications", []):
            seg_id = _remap_id(remap, "segments", item.get("segment_id"))
            dv_id = _remap_id(remap, "dataset_values", item.get("dataset_value_id"))
            code_id = _remap_id(remap, "codes", item.get("code_id"))
            # Track J · J1: remap through the coders table so attribution survives (raw
            # user IDs are meaningless across instances; the coders section maps old->new).
            app_user_id = _remap_id(remap, "coders", item.get("user_id"))
            if import_mode == "merge":
                # Skip applications whose target/code didn't resolve — a divergent source
                # (the J3-2c gate refuses these up front; here we never mis-attach).
                if code_id is None or (seg_id is None and dv_id is None):
                    continue
                # DEDUP on the effective (target, code, coder): a colleague may share
                # codings already present (re-merge, or both coded a unit identically).
                # The J2-0 per-coder unique indexes would IntegrityError on a duplicate,
                # and under autoflush=False that fires mid-loop — so PRE-CHECK (this also
                # catches NULL-user_id legacy rows, which the unique index does not).
                dup_q = db.query(CodeApplication).filter(
                    CodeApplication.code_id == code_id,
                    CodeApplication.user_id == app_user_id,
                )
                dup_q = (
                    dup_q.filter(CodeApplication.segment_id == seg_id)
                    if seg_id is not None
                    else dup_q.filter(CodeApplication.dataset_value_id == dv_id)
                )
                if dup_q.first() is not None:
                    if report is not None:
                        report["duplicates_skipped"] += 1
                    continue
            _add(CodeApplication, item, {
                "segment_id": seg_id,
                "dataset_value_id": dv_id,
                "code_id": code_id,
                "user_id": app_user_id,
            })
            if import_mode == "merge" and report is not None:
                report["applications_added"] += 1

        # ── r. Notes ───────────────────────────────────────────────
        for item in data.get("notes", []):
            # Same verbatim-copy rule as segments above — every Note parent remaps.
            _add(Note, item, {
                "conversation_id": _remap_id(remap, "conversations", item.get("conversation_id")),
                "segment_id": _remap_id(remap, "segments", item.get("segment_id")),
                "dataset_value_id": _remap_id(remap, "dataset_values", item.get("dataset_value_id")),
                "document_id": _remap_id(remap, "documents", item.get("document_id")),
                "observation_id": _remap_id(remap, "observations", item.get("observation_id")),
                "excerpt_id": _remap_id(remap, "excerpts", item.get("excerpt_id")),
            }, "notes")

        # #747: give imported notes numbers that do not collide with the target's
        # own. This is NOT version-gated — the collision predates the fix, because
        # `sequence_number` rides the wire as a plain column, so a merge into an
        # existing conversation has always brought a second `1..n` run into the
        # same parent. Same #714 rule as `_repair_pre_v5_excerpt_offsets` above:
        # the INSERTED set, never `remap`, or the target's own labels get rewritten.
        #
        # ⚠️ It must run AFTER the loop that inserts them. It originally sat beside
        # the excerpt repair, ~50 lines earlier, where `inserted_ids["notes"]` is
        # still empty — so it returned 0 on its first line and renumbered nothing,
        # on every import. The unit tests could not see it: they call the service
        # directly with a hand-built id set, so 14 of 16 stayed green under the
        # mutant. `tests/test_note_numbering.py::TestImportRenumberingIsWired`
        # drives a real `import_project` for exactly that reason.
        renumber_imported_notes(db, inserted_ids.get("notes", set()))

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
        # In merge mode the analysis/canvas targets are NOT imported (blanked above), so
        # these memos have no target — skip them (their sources are the colleague's
        # workspace, not shared coding).
        for item in (deferred_memos if import_mode != "merge" else []):
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

        # ── Code-equivalence post-passes (Track J · J2-3, Slab 6) ──
        # (1) canonical_code_id is a PLAIN int (not a FK) so the relational pass
        # left it pointing at the SOURCE-db code id — remap it through the new
        # code ids now that remap["codes"] is populated (ADJ-4/C1). A stale value
        # is harmless (the resolver re-validates + falls back to lowest member),
        # but remap for fidelity.
        ceg_remap = remap["code_equivalence_groups"]
        if ceg_remap:
            for item in data.get("code_equivalence_groups", []):
                new_group_id = ceg_remap.get(item["_original_id"])
                if new_group_id is None:
                    continue
                new_canonical = _remap_id(remap, "codes", item.get("canonical_code_id"))
                if new_canonical is not None:
                    db.query(CodeEquivalenceGroup).filter(
                        CodeEquivalenceGroup.id == new_group_id
                    ).update({"canonical_code_id": new_canonical})
            db.flush()

        # Track J · J3-2b: realize "link" reconcile decisions — group each newly-inserted
        # divergent code with its chosen local code so they resolve to ONE effective code
        # (consensus/IRR treat them as one, via build_effective_code_map). Runs BEFORE the
        # consensus rebuild below so it picks up the links. If the local twin is already in
        # a group (prior J2 work or an earlier link this merge), add to THAT group and keep
        # its label (D-4); else create a new group. Validated in the gate (target active,
        # non-universal; file code non-universal), so this trusts the inputs.
        for new_code_id, target_code_id, combined_label in merge_link_requests:
            target_code = db.get(Code, target_code_id)
            new_code = db.get(Code, new_code_id)
            if target_code is None or new_code is None:
                continue
            if target_code.code_equivalence_group_id is not None:
                new_code.code_equivalence_group_id = target_code.code_equivalence_group_id
            else:
                label = (combined_label or f"{new_code.name} / {target_code.name}")[:255]
                group = CodeEquivalenceGroup(project_id=pid, label=label)
                db.add(group)
                db.flush()
                target_code.code_equivalence_group_id = group.id
                new_code.code_equivalence_group_id = group.id
            db.flush()

        # (2) Regenerate the derived consensus layer from the imported human/AI
        # layers + code-equivalence groups (consensus rows were excluded from
        # export — §8 decision 4 / C3). Gated on ≥2 roster coders; flush-only, so
        # the caller's single commit covers it.
        from .consensus import consensus_enabled, materialize_consensus_for_project
        if consensus_enabled(db):
            materialize_consensus_for_project(db, pid)

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
                _extract_zip_member(zf, member, target_path, new_project_docs_dir)

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
                        _extract_zip_member(zf, member, target_path, new_project_media_dir)
                        continue

                    # Recordings: media/{owner_dir}/{filename}, where owner_dir is a
                    # conversation id or `obs-{observation_id}`. Parse through the
                    # media_storage convention so the archive layout and the on-disk
                    # layout cannot drift — a bare int() here is what silently dropped
                    # every observation recording on import (obs-7 → ValueError → skip).
                    owner = media_storage.parse_media_owner_segment(parts[1])
                    if owner is None:
                        continue
                    owner_kind, old_owner_id = owner
                    remap_table = (
                        "conversations"
                        if owner_kind == media_storage.CONVERSATION
                        else "observations"
                    )
                    new_owner_id = remap[remap_table].get(old_owner_id)
                    if new_owner_id is None:
                        continue

                    relative_path = parts[2]
                    target_path = (
                        new_project_media_dir
                        / media_storage.media_owner_segment(owner_kind, new_owner_id)
                        / relative_path
                    )
                    _extract_zip_member(zf, member, target_path, new_project_media_dir)

        # Media-less archives (include_media=False exports, or trimmed files):
        # clear orphaned media metadata for any conversation whose recording
        # did not land on disk, so the workbench offers a clean "Attach
        # Recording" state instead of a dead player (§8 iii — graceful
        # degradation is the point of the media-less export). Stat-based, so
        # merge-matched conversations whose local files exist are untouched.
        if media_dir is not None:
            for owner_kind, model in (
                (media_storage.CONVERSATION, Conversation),
                (media_storage.OBSERVATION, Observation),
            ):
                for owner in (
                    db.query(model)
                    .filter(model.project_id == pid, model.media_filename.isnot(None))
                    .all()
                ):
                    expected = (
                        media_dir / str(pid)
                        / media_storage.media_owner_segment(owner_kind, owner.id)
                        / f"original.{owner.media_format}"
                    )
                    if not expected.is_file():
                        owner.media_filename = None
                        owner.media_format = None
                        owner.media_type = None
                        owner.media_duration_seconds = None
                        owner.media_offset_seconds = 0.0
                        owner.media_is_vbr = None
            db.flush()

    _sanitize_imported_media_numbers(db, pid)

    return pid, project_name


def _sanitize_imported_media_numbers(db: Session, pid: int) -> None:
    """Bound the media numbers an archive restored (#625 sibling).

    `_build_entity` copies every column by reflection, so `media_duration_seconds`
    and `media_offset_seconds` arrive from the archive's JSON verbatim — they pass
    through NONE of the guards the live paths enforce. Two consequences, and the
    first is a crash rather than a cosmetic:

    1. **`json.loads` accepts `Infinity` and `NaN`** (Python extends JSON here,
       and `import_project` reads the archive with the stdlib default). So an
       archive carrying `"media_duration_seconds": Infinity` lands a non-finite
       float in the DB — VERIFIED by execution, not inferred. Downstream,
       `cut_clips` guards `is None or <= 0`, which **inf passes (inf > 0) and NaN
       passes too (NaN <= 0 is False)**, reaching `math.ceil` as an OverflowError.
       That is exactly the #573 crash class arriving through a different door.
    2. `MediaOffsetUpdate` constrains the offset to ±300 s at the API, and an
       import must not accept what the API refuses — an absurd offset shears the
       transcript against its recording for every playback surface at once.

    `.mmproject` is an interchange format users hand to each other (the
    distribute-and-merge workflow), so "the file is ours" is not a safety
    argument — the same reasoning that makes the format gate and the zip-slip
    scan run inside `import_project` rather than trusting `/validate-import`.
    """
    for model in (Conversation, Observation):
        for owner in db.query(model).filter(model.project_id == pid).all():
            owner.media_duration_seconds = sane_duration(owner.media_duration_seconds)
            offset = owner.media_offset_seconds
            if offset is None or not math.isfinite(offset) or abs(offset) > MAX_MEDIA_OFFSET_SECONDS:
                # NOT NULL on Observation and defaulted 0.0 on Conversation, so
                # the fallback is 0.0 (= "aligned"), never None.
                owner.media_offset_seconds = 0.0
    db.flush()


# ── Import sub-helpers ──────────────────────────────────────────────────

def _import_categories_topological(
    db: Session,
    cat_items: list[dict],
    project_id: int,
    remap: dict,
    import_mode: str = "new",
) -> None:
    """Insert CodeCategories in topological order (roots first).

    CodeCategory is the one J3-2-0 uuid'd entity that bypasses `_add`, so the
    import-as-new fresh-uuid stamp AND the merge match-by-uuid are threaded here.
    """
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
                # J3-2 merge: match an existing category by uuid instead of duplicating.
                incoming_uuid = item.get("uuid")
                if import_mode == "merge" and incoming_uuid:
                    # #449(c): scope the uuid match to the target project (defense-in-depth).
                    existing_cat = _merge_uuid_match(
                        db, CodeCategory, incoming_uuid, project_id
                    ).first()
                    if existing_cat is not None:
                        remap["code_categories"][item["_original_id"]] = existing_cat.id
                        inserted.add(item["_original_id"])
                        continue
                obj = _build_entity(CodeCategory, item, {
                    "project_id": project_id,
                    "parent_id": _remap_id(remap, "code_categories", parent_old_id),
                }, fresh_uuid=(import_mode == "new"))
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
    import_mode: str = "new",
) -> None:
    """Insert RecodeDefinitions in topological order (parents first).

    #449(a): threads ``import_mode`` so ``fresh_uuid`` is set consistently with the other
    import helpers. RecodeDefinition has no J3-2-0 ``uuid`` column today (so this is a
    no-op), and a merge blanks ``recode_definitions`` entirely — but if a uuid is ever added
    to a model routed through here, import-as-new must fresh-stamp it or a re-import collides
    on the unique uuid index (the trap-class the invariant warns about).
    """
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
                }, fresh_uuid=(import_mode == "new"))
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
