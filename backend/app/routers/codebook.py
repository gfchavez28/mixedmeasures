"""Router for codebook tree and co-occurrence endpoints."""

from collections import defaultdict
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.code import Code
from ..models.code_category import CodeCategory
from ..models.code_application import CodeApplication
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.speaker import Speaker
from ..models.dataset import Dataset, DatasetColumn, DatasetValue, ColumnType
from ..models.excerpt import Excerpt
from ..auth import get_current_user
from .helpers import parse_int_list, _get_project_or_404
from ..schemas.codebook import (
    CodebookCodeNode,
    CodebookCategoryNode,
    CodebookTreeResponse,
    CodebookCooccurrenceNode,
    CodebookCooccurrenceEdge,
    CodebookCooccurrenceResponse,
)
from ..services.code_analysis import build_code_cooccurrence_matrix

router = APIRouter(prefix="/api/projects/{project_id}/codebook", tags=["codebook"])


# ── Helpers ──────────────────────────────────────────────────────────────────


def _build_category_path(cat_id: int, cat_map: dict[int, CodeCategory]) -> list[str]:
    """Walk parent chain to build [root, ..., parent] path."""
    path = []
    current_id = cat_id
    visited = set()
    while current_id is not None and current_id in cat_map:
        if current_id in visited:
            break
        visited.add(current_id)
        cat = cat_map[current_id]
        path.append(cat.name)
        current_id = cat.parent_id
    path.reverse()
    return path


def _get_cat_depth(cat_id: int, cat_map: dict[int, CodeCategory]) -> int:
    """Compute depth from root (0 = root) using in-memory cat_map."""
    depth = 0
    current_id = cat_map[cat_id].parent_id if cat_id in cat_map else None
    visited = set()
    while current_id is not None and current_id in cat_map:
        if current_id in visited:
            break
        visited.add(current_id)
        depth += 1
        current_id = cat_map[current_id].parent_id
    return depth


def _get_ancestor_at_depth(cat_id: int, target_depth: int, cat_map: dict[int, CodeCategory], depth_map: dict[int, int]) -> int | None:
    """Walk up from cat_id to find ancestor at target_depth."""
    current_id = cat_id
    visited = set()
    while current_id is not None and current_id in cat_map:
        if current_id in visited:
            break
        visited.add(current_id)
        if depth_map.get(current_id, -1) == target_depth:
            return current_id
        current_id = cat_map[current_id].parent_id
    return None


def _resolve_color(cat_id: int | None, cat_map: dict[int, CodeCategory]) -> str | None:
    """Walk up the category chain returning the first non-null color."""
    current_id = cat_id
    visited: set[int] = set()
    while current_id is not None and current_id in cat_map:
        if current_id in visited:
            break
        visited.add(current_id)
        cat = cat_map[current_id]
        if cat.color:
            return cat.color
        current_id = cat.parent_id
    return None


# ── Tree Endpoint ────────────────────────────────────────────────────────────


@router.get("/tree", response_model=CodebookTreeResponse)
async def get_codebook_tree(
    project_id: int,
    conversation_ids: str | None = Query(None),
    text_column_ids: str | None = Query(None),
    exclude_facilitator: bool = Query(True),
    include_inactive: bool = Query(False),
    min_segments: int | None = Query(None),
    max_segments: int | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get the full codebook tree with nested categories and usage counts."""
    _get_project_or_404(db, project_id, user.id)

    conv_ids = parse_int_list(conversation_ids)
    cc_ids = parse_int_list(text_column_ids)

    # 1. Load all categories and codes
    categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()
    cat_map = {c.id: c for c in categories}

    code_query = db.query(Code).filter(Code.project_id == project_id)
    if not include_inactive:
        code_query = code_query.filter(Code.is_active == True)
    codes = code_query.all()

    code_ids = [c.id for c in codes]
    if not code_ids:
        return CodebookTreeResponse()

    # 2. Batch queries for counts

    # 2a. Conversation-based segment counts per code
    conv_seg_query = (
        db.query(CodeApplication.code_id, func.count(CodeApplication.segment_id))
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.segment_id.isnot(None),
        )
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        conv_seg_query = conv_seg_query.outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        conv_seg_query = conv_seg_query.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conv_ids:
        conv_seg_query = conv_seg_query.filter(Segment.conversation_id.in_(conv_ids))

    conv_seg_counts = dict(conv_seg_query.group_by(CodeApplication.code_id).all())

    # 2b. Comment-based segment counts per code
    comment_seg_query = (
        db.query(CodeApplication.code_id, func.count(CodeApplication.dataset_value_id))
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.dataset_value_id.isnot(None),
        )
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if cc_ids:
        comment_seg_query = comment_seg_query.filter(DatasetValue.column_id.in_(cc_ids))

    comment_seg_counts = dict(comment_seg_query.group_by(CodeApplication.code_id).all())

    # 2c. Conversation source IDs per code (for set-union at category level)
    conv_source_query = (
        db.query(CodeApplication.code_id, Segment.conversation_id)
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.segment_id.isnot(None),
        )
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
        .distinct()
    )
    if exclude_facilitator:
        conv_source_query = conv_source_query.outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        conv_source_query = conv_source_query.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conv_ids:
        conv_source_query = conv_source_query.filter(Segment.conversation_id.in_(conv_ids))

    code_conv_sources: dict[int, set[tuple[str, int]]] = defaultdict(set)
    for code_id, conv_id in conv_source_query.all():
        code_conv_sources[code_id].add(("conv", conv_id))

    # 2d. Comment column source IDs per code
    col_source_query = (
        db.query(CodeApplication.code_id, DatasetValue.column_id)
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.dataset_value_id.isnot(None),
        )
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
        .distinct()
    )
    if cc_ids:
        col_source_query = col_source_query.filter(DatasetValue.column_id.in_(cc_ids))

    code_col_sources: dict[int, set[tuple[str, int]]] = defaultdict(set)
    for code_id, col_id in col_source_query.all():
        code_col_sources[code_id].add(("col", col_id))

    # 2f. Document-based segment counts per code
    doc_seg_query = (
        db.query(CodeApplication.code_id, func.count(CodeApplication.segment_id))
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.segment_id.isnot(None),
        )
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    doc_seg_counts = dict(doc_seg_query.group_by(CodeApplication.code_id).all())

    # 2g. Document source IDs per code (for set-union at category level)
    doc_source_query = (
        db.query(CodeApplication.code_id, Segment.document_id)
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.segment_id.isnot(None),
        )
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
        .distinct()
    )

    code_doc_sources: dict[int, set[tuple[str, int]]] = defaultdict(set)
    for code_id, doc_id in doc_source_query.all():
        code_doc_sources[code_id].add(("doc", doc_id))

    # 2e. Excerpt counts per code (segment-based + comment-based)
    excerpt_seg_query = (
        db.query(CodeApplication.code_id, func.count(func.distinct(Excerpt.id)))
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.segment_id.isnot(None),
        )
        .join(Excerpt, CodeApplication.segment_id == Excerpt.segment_id)
        .group_by(CodeApplication.code_id)
    )
    excerpt_seg_counts = dict(excerpt_seg_query.all())

    excerpt_comment_query = (
        db.query(CodeApplication.code_id, func.count(func.distinct(Excerpt.id)))
        .filter(
            CodeApplication.code_id.in_(code_ids),
            CodeApplication.dataset_value_id.isnot(None),
        )
        .join(Excerpt, CodeApplication.dataset_value_id == Excerpt.dataset_value_id)
        .group_by(CodeApplication.code_id)
    )
    excerpt_comment_counts = dict(excerpt_comment_query.all())

    # 3. Build code nodes
    def make_code_node(code: Code) -> CodebookCodeNode:
        seg_count = conv_seg_counts.get(code.id, 0) + comment_seg_counts.get(code.id, 0) + doc_seg_counts.get(code.id, 0)
        sources = code_conv_sources.get(code.id, set()) | code_col_sources.get(code.id, set()) | code_doc_sources.get(code.id, set())
        exc_count = excerpt_seg_counts.get(code.id, 0) + excerpt_comment_counts.get(code.id, 0)
        return CodebookCodeNode(
            id=code.id,
            numeric_id=code.numeric_id,
            name=code.name,
            description=code.description,
            color=code.color,
            is_active=code.is_active,
            is_universal=code.is_universal,
            segment_count=seg_count,
            source_count=len(sources),
            excerpt_count=exc_count,
            category_id=code.category_id,
        )

    # Combined source sets per code (for category aggregation)
    code_source_sets: dict[int, set] = {}
    cat_code_ids: dict[int, list[int]] = defaultdict(list)
    for code in codes:
        code_source_sets[code.id] = code_conv_sources.get(code.id, set()) | code_col_sources.get(code.id, set()) | code_doc_sources.get(code.id, set())
        if code.category_id is not None:
            cat_code_ids[code.category_id].append(code.id)

    # Separate codes
    universal_codes = []
    categorized: dict[int, list[CodebookCodeNode]] = defaultdict(list)
    uncategorized_codes = []

    for code in codes:
        node = make_code_node(code)
        if code.is_universal:
            universal_codes.append(node)
        elif code.category_id is not None and code.category_id in cat_map:
            categorized[code.category_id].append(node)
        else:
            uncategorized_codes.append(node)

    # Apply min/max segment filters to code lists only
    def filter_codes(code_list: list[CodebookCodeNode]) -> list[CodebookCodeNode]:
        result = code_list
        if min_segments is not None:
            result = [c for c in result if c.segment_count >= min_segments]
        if max_segments is not None:
            result = [c for c in result if c.segment_count <= max_segments]
        return result

    # 4. Build category tree bottom-up
    depth_map = {cat_id: _get_cat_depth(cat_id, cat_map) for cat_id in cat_map}

    # Build category nodes (leaves first, then up)
    cat_nodes: dict[int, CodebookCategoryNode] = {}
    for depth in sorted(set(depth_map.values()), reverse=True):
        for cat_id, d in depth_map.items():
            if d != depth:
                continue
            cat = cat_map[cat_id]
            cat_codes = categorized.get(cat_id, [])
            filtered_codes = filter_codes(cat_codes)

            # Children already built (deeper depth processed first)
            child_nodes = [cat_nodes[child.id] for child in (cat.children or []) if child.id in cat_nodes]
            child_nodes.sort(key=lambda n: n.display_order)

            # Aggregate: direct codes + all descendant codes
            total_code_count = len(cat_codes)
            total_segments = sum(c.segment_count for c in cat_codes)
            source_union: set = set()
            for cid in cat_code_ids.get(cat_id, []):
                source_union |= code_source_sets.get(cid, set())

            for child in child_nodes:
                total_code_count += child.total_code_count
                total_segments += child.total_segments
                source_union |= _collect_descendant_sources(child.id, cat_map, cat_code_ids, code_source_sets)

            cat_nodes[cat_id] = CodebookCategoryNode(
                id=cat_id,
                name=cat.name,
                color=cat.color,
                display_order=cat.display_order,
                parent_id=cat.parent_id,
                depth=depth,
                created_at=cat.created_at,
                code_count=len(cat_codes),
                total_code_count=total_code_count,
                total_segments=total_segments,
                total_sources=len(source_union),
                children=child_nodes,
                codes=filtered_codes,
            )

    # Root categories (parent_id is None)
    tree = [cat_nodes[cat_id] for cat_id in cat_nodes if cat_map[cat_id].parent_id is None]
    tree.sort(key=lambda n: n.display_order)

    return CodebookTreeResponse(
        universal_codes=universal_codes,
        tree=tree,
        uncategorized_codes=filter_codes(uncategorized_codes),
    )


def _collect_descendant_sources(
    cat_id: int,
    cat_map: dict[int, CodeCategory],
    cat_code_ids: dict[int, list[int]],
    code_source_sets: dict[int, set],
) -> set:
    """Recursively collect source sets from all codes under a category."""
    sources: set = set()
    for cid in cat_code_ids.get(cat_id, []):
        sources |= code_source_sets.get(cid, set())
    cat = cat_map.get(cat_id)
    if cat and cat.children:
        for child in cat.children:
            sources |= _collect_descendant_sources(child.id, cat_map, cat_code_ids, code_source_sets)
    return sources


# ── Co-occurrence Endpoint ───────────────────────────────────────────────────


@router.get("/cooccurrence", response_model=CodebookCooccurrenceResponse)
async def get_codebook_cooccurrence(
    project_id: int,
    hierarchy_level: int = Query(-1, description="-1 for codes, 0+ for category depth"),
    conversation_ids: str | None = Query(None),
    text_column_ids: str | None = Query(None),
    exclude_facilitator: bool = Query(True),
    include_inactive: bool = Query(False),
    min_segments: int | None = Query(None),
    max_segments: int | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get co-occurrence data for codebook visualization."""
    _get_project_or_404(db, project_id, user.id)

    conv_ids = parse_int_list(conversation_ids)
    cc_ids = parse_int_list(text_column_ids)

    # Load codes (respecting include_inactive)
    code_query = db.query(Code).filter(Code.project_id == project_id)
    if not include_inactive:
        code_query = code_query.filter(Code.is_active == True)
    codes = code_query.all()
    code_map = {c.id: c for c in codes}
    active_code_ids = [c.id for c in codes]

    if not active_code_ids:
        return CodebookCooccurrenceResponse(
            hierarchy_level=hierarchy_level, total_codes_in_project=0,
        )

    # #354: total non-universal codes for the "Showing N of M" denominator.
    # Computed from the already-loaded `codes` list (no extra query). Matches
    # the universe the network draws nodes from — universal codes (numeric_id
    # 0/1) are always excluded; inactive codes follow the include_inactive
    # query param.
    total_codes_in_project = sum(1 for c in codes if not c.is_universal)

    # Load categories for path building + color resolution
    categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()
    cat_map = {c.id: c for c in categories}

    # Pre-compute resolved color for every category (avoids per-node parent-chain walks)
    cat_color_map: dict[int, str | None] = {}
    for cat_id in cat_map:
        cat_color_map[cat_id] = _resolve_color(cat_id, cat_map)

    # Get code-level co-occurrence
    cooccur, total_units, conv_total, comment_total, doc_total = build_code_cooccurrence_matrix(
        db, project_id,
        code_ids=active_code_ids,
        exclude_facilitator=exclude_facilitator,
        conversation_ids=conv_ids,
        source="all",
        text_column_ids=cc_ids,
    )

    if hierarchy_level == -1:
        # Batch source counts (replaces per-code _count_code_sources N+1 queries)
        _conv_src_q = (
            db.query(CodeApplication.code_id, func.count(func.distinct(Segment.conversation_id)))
            .filter(
                CodeApplication.code_id.in_(active_code_ids),
                CodeApplication.segment_id.isnot(None),
            )
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            _conv_src_q = _conv_src_q.outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            _conv_src_q = _conv_src_q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conv_ids:
            _conv_src_q = _conv_src_q.filter(Segment.conversation_id.in_(conv_ids))
        conv_source_counts = dict(_conv_src_q.group_by(CodeApplication.code_id).all())

        _col_src_q = (
            db.query(CodeApplication.code_id, func.count(func.distinct(DatasetValue.column_id)))
            .filter(
                CodeApplication.code_id.in_(active_code_ids),
                CodeApplication.dataset_value_id.isnot(None),
            )
            .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if cc_ids:
            _col_src_q = _col_src_q.filter(DatasetValue.column_id.in_(cc_ids))
        col_source_counts = dict(_col_src_q.group_by(CodeApplication.code_id).all())

        _doc_src_q = (
            db.query(CodeApplication.code_id, func.count(func.distinct(Segment.document_id)))
            .filter(
                CodeApplication.code_id.in_(active_code_ids),
                CodeApplication.segment_id.isnot(None),
            )
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        doc_source_counts = dict(_doc_src_q.group_by(CodeApplication.code_id).all())

        # Code-level nodes and edges
        nodes = []
        for code in codes:
            if code.is_universal:
                continue
            seg_count = cooccur.get((code.id, code.id), 0)
            # Intentional: drop codes with zero co-occurrence-eligible
            # applications. After `exclude_facilitator=True` (default), a code
            # whose only applications are on facilitator segments / non-text
            # dataset columns / merged segments produces seg_count==0 and is
            # hidden from the network. The discrepancy with the tree's "total
            # codes" is surfaced to the frontend via `total_codes_in_project`
            # (see CodebookCooccurrenceResponse, #354) so the user sees
            # "Showing N of M codes" instead of an unexplained gap.
            if seg_count == 0:
                continue
            if min_segments is not None and seg_count < min_segments:
                continue
            if max_segments is not None and seg_count > max_segments:
                continue
            cat_path = _build_category_path(code.category_id, cat_map) if code.category_id else []
            source_count = conv_source_counts.get(code.id, 0) + col_source_counts.get(code.id, 0) + doc_source_counts.get(code.id, 0)
            resolved_color = code.color or (cat_color_map.get(code.category_id) if code.category_id else None)
            nodes.append(CodebookCooccurrenceNode(
                id=code.id,
                name=code.name,
                color=resolved_color,
                segment_count=seg_count,
                source_count=source_count,
                category_path=cat_path,
            ))

        node_ids = {n.id for n in nodes}
        edges = []
        max_weight = 0
        seen_pairs: set[tuple[int, int]] = set()
        for (a, b), weight in cooccur.items():
            if a == b or a not in node_ids or b not in node_ids:
                continue
            pair = (min(a, b), max(a, b))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            if weight < 2:
                continue
            edges.append(CodebookCooccurrenceEdge(source=pair[0], target=pair[1], weight=weight))
            if weight > max_weight:
                max_weight = weight

        return CodebookCooccurrenceResponse(
            nodes=nodes, edges=edges, max_weight=max_weight, hierarchy_level=-1,
            total_codes_in_project=total_codes_in_project,
        )

    # Category-level aggregation
    depth_map = {cat_id: _get_cat_depth(cat_id, cat_map) for cat_id in cat_map}

    # Map each code to its ancestor at the requested depth
    code_to_ancestor: dict[int, int] = {}
    for code in codes:
        if code.is_universal or code.category_id is None:
            continue
        ancestor = _get_ancestor_at_depth(code.category_id, hierarchy_level, cat_map, depth_map)
        if ancestor is not None:
            code_to_ancestor[code.id] = ancestor

    # Aggregate co-occurrence at category level
    cat_cooccur: dict[tuple[int, int], int] = defaultdict(int)
    cat_seg_counts: dict[int, int] = defaultdict(int)

    for (a, b), weight in cooccur.items():
        ancestor_a = code_to_ancestor.get(a)
        ancestor_b = code_to_ancestor.get(b)
        if ancestor_a is None or ancestor_b is None:
            continue
        if a == b:
            cat_seg_counts[ancestor_a] += weight
        elif ancestor_a != ancestor_b:
            cat_cooccur[(ancestor_a, ancestor_b)] += weight

    # Build nodes
    nodes = []
    for cat_id in set(code_to_ancestor.values()):
        cat = cat_map.get(cat_id)
        if not cat:
            continue
        nodes.append(CodebookCooccurrenceNode(
            id=cat_id,
            name=cat.name,
            color=cat_color_map.get(cat_id),
            segment_count=cat_seg_counts.get(cat_id, 0),
            source_count=0,
            category_path=_build_category_path(cat.parent_id, cat_map) if cat.parent_id else [],
        ))

    node_ids = {n.id for n in nodes}
    edges = []
    max_weight = 0
    seen_pairs: set[tuple[int, int]] = set()
    for (a, b), weight in cat_cooccur.items():
        if a not in node_ids or b not in node_ids:
            continue
        pair = (min(a, b), max(a, b))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        if weight < 2:
            continue
        edges.append(CodebookCooccurrenceEdge(source=pair[0], target=pair[1], weight=weight))
        if weight > max_weight:
            max_weight = weight

    return CodebookCooccurrenceResponse(
        nodes=nodes, edges=edges, max_weight=max_weight, hierarchy_level=hierarchy_level,
        total_codes_in_project=total_codes_in_project,
    )
