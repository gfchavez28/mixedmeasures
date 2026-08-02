"""Shared helpers and constants for export sub-modules."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session
from sqlalchemy import func
from collections import defaultdict

from ..models.segment import Segment
from ..models.code_application import CodeApplication
from ..models.code_category import CodeCategory
from ..services.code_analysis import build_code_cooccurrence_matrix as _build_cooccurrence
from ..services.coding_layers import non_consensus_filter, project_scoped_segments
from .helpers import visible_segment_filter

# ── Rounding precision constants ─────────────────────────────────────────────
EXPORT_VALUE_PRECISION = 2  # round(x, 2) for metric values in Excel export


def local_wall_time(dt: datetime, fmt: str = "%Y-%m-%d %H:%M") -> str:
    """Naive-UTC ORM datetime → local wall-clock 'YYYY-MM-DD HH:MM' (#408).

    Human-facing export cells should show the reader's clock, not UTC; in the
    local-first desktop posture the server's zone IS the user's zone.
    Every human-facing timestamp cell must route through this — a bare
    ``.strftime`` on the naive ORM datetime silently emits UTC (#513).
    """
    return dt.replace(tzinfo=timezone.utc).astimezone().strftime(fmt)


# ── Formula-injection defang (ROADMAP 12d (i)) ───────────────────────────────
# Tier 3 widened the blast radius: auto-created scale-score MetricDefinition
# rows take their name from f"{domain.name} Score", so user-typed domain names
# can flow into both .csv and .xlsx exports unchanged. Excel/Sheets/LibreOffice
# evaluate fields starting with formula prefixes when the user opens the file;
# openpyxl additionally auto-tags strings starting with '=' as data_type='f'.
#
# Scope is the high-impact subset of OWASP's CSV-injection prefix list. We
# intentionally exclude '+' and '-' to avoid false-positives on legitimate
# negative numbers / signed integers in respondent demographic free-text
# (e.g. '-1' as "decline to answer"). The realistic exploit vectors are
# '=cmd|...' and '@SUM(...)'; tab/CR are escaped because csv.writer preserves
# them inside quoted fields, where Excel still evaluates them.
_CSV_FORMULA_PREFIXES = ("=", "@", "\t", "\r")


def csv_safe(value):
    """Defang CSV-formula-injection at the field level.

    Prepends a single quote to strings whose first character is a known
    formula prefix (=, @, tab, CR). Numbers, booleans, None, and benign
    strings pass through unchanged. Apply at every csv.writer.writerow site
    where a field originates from user input.
    """
    if isinstance(value, str) and value and value[0] in _CSV_FORMULA_PREFIXES:
        return "'" + value
    return value


def excel_set_safe(cell, value):
    """openpyxl-safe value assign that defangs '=' formula-tagging.

    Sets the value, then forces data_type='s' for strings starting with '='
    (which openpyxl's _bind_value would otherwise tag as 'f'/formula). No
    leading apostrophe is added — in xlsx the cell type is authoritative;
    Excel renders type-'s' cells as literal text. Returns the cell for
    chaining.
    """
    cell.value = value
    if isinstance(value, str) and len(value) > 1 and value.startswith("="):
        cell.data_type = "s"
    return cell


def _build_category_tree_and_chains(db: Session, project_id: int):
    """Query all categories and build parent chain lookup + tree structure.
    Returns (parent_chain_map, tree, flat_list) where:
    - parent_chain_map: {cat_id: [ancestor_name_1, ..., cat_name]} (full path)
    - tree: list of root category dicts with nested children
    - flat_list: all categories as flat list
    """
    categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).order_by(CodeCategory.display_order).all()

    if not categories:
        return {}, [], categories

    cat_by_id = {c.id: c for c in categories}

    # Build parent chain (list of ancestor names from root down to self)
    parent_chain_map: dict[int, list[str]] = {}
    for cat in categories:
        chain = []
        current = cat
        while current:
            chain.append(current.name)
            current = cat_by_id.get(current.parent_id) if current.parent_id else None
        chain.reverse()
        parent_chain_map[cat.id] = chain

    # Build tree structure
    children_map: dict[int | None, list] = defaultdict(list)
    for cat in categories:
        children_map[cat.parent_id].append(cat)

    def build_subtree(parent_id):
        result = []
        for cat in children_map.get(parent_id, []):
            # Count direct codes
            code_count = sum(1 for c in (cat.codes or []))
            node = {
                "id": cat.id,
                "name": cat.name,
                "color": cat.color,
                "parent_id": cat.parent_id,
                "depth": len(parent_chain_map[cat.id]) - 1,
                "code_count": code_count,
                "children": build_subtree(cat.id),
            }
            result.append(node)
        return result

    tree = build_subtree(None)

    return parent_chain_map, tree, categories


def segment_source_pair(segment) -> tuple[str, str]:
    """(source kind, source name) for a segment, whatever its parent.

    The three-parent equivalent of the old `conversation.name` cell, and the ONE
    place an export decides what a row's source IS — it lived in two identical
    copies (the Excel Coded Data sheet from #620, the coded-segments CSV from
    #616) until #650 needed a third. Three exports agreeing by coincidence is the
    drift seam, not the fix.

    A parentless segment cannot exist — `ck_segment_exactly_one_parent` forbids
    it — so the final blank pair is unreachable defence, not a supported state.

    ⚠️ Object-based, so it needs the parents eager-loaded; the id-keyed variants
    (`build_code_source_matrix` here, `services/irr.py::_segment_source_key`)
    read raw FK columns instead and cannot share this.
    """
    if segment is None:  # pragma: no cover - defensive
        return "", ""
    if segment.conversation is not None:
        return "conversation", segment.conversation.name
    if segment.document is not None:
        return "document", segment.document.name
    if segment.observation is not None:
        return "observation", segment.observation.name
    return "", ""


def build_code_source_matrix(db: Session, project_id: int):
    """Returns dict: ((source_type, source_id), code_id) -> count.

    Distinct coded segments per (source, code) across ALL THREE segment parents
    — conversation, document, observation clip (#629). It inner-joined
    `Conversation` until 2026-08-02, so a document-only or observation-only
    project produced an empty matrix while the sheet still rendered.

    ⚠️ **The key is a (type, id) PAIR and must stay one.** The three parents are
    independent sequences, so conversation 5, document 5 and observation 5 all
    exist at once; a bare `source_id` key silently SUMS unrelated sources into
    one column. That is the trap that makes this class of bug pass every
    single-parent test — the ids coincide on the happy path.

    Track J · J2: distinct coded SEGMENTS per (source, code), not raw
    application rows (two coders on one segment are two rows), excluding the
    consensus layer (J2-B).
    """
    results = project_scoped_segments(
        db.query(
            Segment.conversation_id,
            Segment.document_id,
            Segment.observation_id,
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.segment_id)),
        ),
        project_id,
    ).join(
        # Explicit ON: CodeApplication is polymorphic (segment_id OR
        # dataset_value_id), so never leave this to inference.
        CodeApplication, CodeApplication.segment_id == Segment.id,
    ).filter(
        *visible_segment_filter(),
        non_consensus_filter(),
    ).group_by(
        Segment.conversation_id,
        Segment.document_id,
        Segment.observation_id,
        CodeApplication.code_id,
    ).all()

    matrix = {}
    for conv_id, doc_id, obs_id, code_id, count in results:
        # Exactly one parent is non-NULL (`ck_segment_exactly_one_parent`).
        if conv_id is not None:
            source = ("conversation", conv_id)
        elif doc_id is not None:
            source = ("document", doc_id)
        elif obs_id is not None:
            source = ("observation", obs_id)
        else:  # pragma: no cover - the CHECK constraint forbids it
            continue
        matrix[(source, code_id)] = count

    return matrix


def build_code_cooccurrence_matrix(db: Session, project_id: int):
    """Delegate to service layer. Facilitator segments are EXCLUDED (#493):
    the co-occurrence CSV endpoint and the screen heatmap both default to
    participant-only, and the Excel sheet must carry the same numbers — the
    old hard-coded ``exclude_facilitator=False`` made the same matrix differ
    across the two export artifacts."""
    cooccur, _total, _conv, _comment, _doc = _build_cooccurrence(
        db, project_id, exclude_facilitator=True,
    )
    return cooccur
