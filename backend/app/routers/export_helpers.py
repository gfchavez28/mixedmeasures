"""Shared helpers and constants for export sub-modules."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session
from sqlalchemy import func
from collections import defaultdict

from ..models.conversation import Conversation
from ..models.segment import Segment
from ..models.code_application import CodeApplication
from ..models.code_category import CodeCategory
from ..services.code_analysis import build_code_cooccurrence_matrix as _build_cooccurrence
from ..services.coding_layers import non_consensus_filter

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


def build_code_conversation_matrix(db: Session, project_id: int):
    """Returns dict: (conversation_id, code_id) -> count (excludes soft-deleted segments).

    Track J · J2: distinct coded segments per (conversation, code), not raw
    application rows (two coders on one segment are two rows), excluding the
    consensus layer (J2-B)."""
    results = db.query(
        Segment.conversation_id,
        CodeApplication.code_id,
        func.count(func.distinct(CodeApplication.segment_id))
    ).join(CodeApplication).join(Conversation).filter(
        Conversation.project_id == project_id,
        Segment.merged_into_id == None,  # Exclude soft-deleted
        Segment.split_into_id == None,
        non_consensus_filter(),
    ).group_by(Segment.conversation_id, CodeApplication.code_id).all()

    return {(r[0], r[1]): r[2] for r in results}


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
