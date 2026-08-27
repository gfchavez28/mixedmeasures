"""Codebook exchange service — export and import .mmcodebook and .qdc files.

Handles native JSON codebook format and REFI-QDA XML codebook format
for interoperability with ATLAS.ti, NVivo, MAXQDA, Dedoose, etc.
"""

import logging
import re
import uuid
import xml.etree.ElementTree as ET
from defusedxml.ElementTree import fromstring as _safe_fromstring
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Code, CodeCategory, Project
from ..services.backup import APP_VERSION

logger = logging.getLogger(__name__)

# The REFI-QDA codebook namespace, verbatim from the standard's XSD
# (REFI-QDA 1.5 §5.2: targetNamespace="urn:QDA-XML:codebook:1.0").
#
# ⚠️ #633: MM emitted "urn:QDA-XML:codebook:1:0" — a COLON where the standard
# has a DOT — from 2026-03-16 until 2026-07-26. Every .qdc we wrote in that
# window carries the wrong namespace, and our import only ever accepted our own
# value or no namespace at all, so the format round-tripped with itself and with
# nothing else. Import is now namespace-AGNOSTIC (see `_local`), which is what
# keeps those legacy files readable without a hardcoded legacy list to maintain.
QDC_NAMESPACE = "urn:QDA-XML:codebook:1.0"

# What MM wrote before #633. Nothing matches against this — `_local` ignores
# namespaces entirely — but a reader hitting an old file deserves the pointer.
LEGACY_QDC_NAMESPACE = "urn:QDA-XML:codebook:1:0"

CURRENT_FORMAT_VERSION = 1

# Import caps. The upload is already bounded at 10 MB by the router, but 10 MB of
# XML is ~100k elements and ~300k levels of nesting — enough to exhaust the
# Python stack (measured: 2000 levels in a 112 KB file raises RecursionError) or
# to fire 100k INSERTs. Every other import adapter here caps (MAX_CLIPS,
# MAX_XLSX_ROWS, MAX_SAV_ROWS); this one was the outlier. Refuse pre-flight with
# a 400 rather than dying mid-parse with a 500.
MAX_QDC_CODES = 10_000
MAX_QDC_DEPTH = 100

# The standard's RGBType: `#RGB` or `#RRGGBB`, nothing else. Applied on BOTH
# sides — a malformed stored colour would make our export schema-invalid, and a
# foreign file's arbitrary string would land in a String(7) column that SQLite
# does not enforce.
_RGB_RE = re.compile(r"^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$")

# Both `name` columns are String(255); SQLite will not enforce it for us.
_MAX_NAME_LEN = 255


class EmptyCodebookError(ValueError):
    """A QDC export was requested for a codebook with no active codes.

    Distinct from the "project not found" ValueError so the router can answer
    400 rather than 404. The standard's CodesType declares
    `<Code maxOccurs="unbounded"/>` with an implicit minOccurs=1, so `<Codes />`
    is schema-INVALID — emitting it hands the researcher a file no tool will
    open, which is strictly worse than saying so.
    """


def _local(tag) -> str:
    """Local name of an ElementTree tag, ignoring any namespace.

    This is what makes the import namespace-agnostic, and it is deliberately
    chosen over matching a fixed set of accepted URNs: it reads the correct
    `urn:QDA-XML:codebook:1.0`, our own pre-#633 `…:1:0`, a namespace-less file,
    and whatever a future revision of the standard picks — with no list to keep
    in sync. Comments and processing instructions carry a callable `tag` rather
    than a string; they return "" and are ignored by every caller.
    """
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1] if tag.startswith("{") else tag


def _find_child(el, local_name: str):
    """First direct child with this local name, ignoring namespaces."""
    return next((c for c in el if _local(c.tag) == local_name), None)


def _safe_color(value: str | None) -> str | None:
    """Return `value` iff it is a schema-legal RGB colour, else None.

    The shorthand `#RGB` form is EXPANDED to `#RRGGBB` — the same colour, in the
    form every consumer actually handles. Applied on both sides, so MM neither
    stores nor emits a 3-digit value; only accepts one.

    Why bother, given `#RGB` is explicitly legal in RGBType: QualCoder 3.8.2's
    `color_matcher()` opens with `if len(hex_color) != 7: return "#D8D8D8"`, so a
    conformant `#0a0` silently becomes light grey rather than green (#760's
    round-trip, measured 2026-08-16). Being right about the spec does not make a
    researcher's colours survive the trip. Expanding costs nothing, loses
    nothing, and is exactly "conservative in what you send" — MM's own picker
    only ever emits 6-digit anyway, so the shorthand can only ARRIVE by import
    and would otherwise be re-emitted on the next hop.
    """
    if not value or not _RGB_RE.match(value):
        return None
    if len(value) == 4:  # "#abc" -> "#aabbcc"; case deliberately left alone
        return "#" + "".join(ch * 2 for ch in value[1:])
    return value


# ── Shared helpers ──────────────────────────────────────────────────────

def _build_category_chain_map(categories: list) -> dict[int, list[str]]:
    """Build {cat_id: [ancestor_name_1, ..., cat_name]} from root down."""
    cat_by_id = {c.id: c for c in categories}
    chain_map: dict[int, list[str]] = {}
    for cat in categories:
        chain = []
        current = cat
        while current:
            chain.append(current.name)
            current = cat_by_id.get(current.parent_id) if current.parent_id else None
        chain.reverse()
        chain_map[cat.id] = chain
    return chain_map


def _build_category_tree(categories: list, chain_map: dict[int, list[str]]) -> list[dict]:
    """Build nested category tree structure."""
    children_map: dict[int | None, list] = defaultdict(list)
    for cat in categories:
        children_map[cat.parent_id].append(cat)

    def build_subtree(parent_id):
        result = []
        for cat in children_map.get(parent_id, []):
            chain = chain_map.get(cat.id, [])
            parent_path = " > ".join(chain[:-1]) if len(chain) > 1 else None
            node = {
                "name": cat.name,
                "color": cat.color,
                "display_order": cat.display_order,
                "parent_name_path": parent_path,
                "children": build_subtree(cat.id),
            }
            result.append(node)
        return result

    return build_subtree(None)


# ── Native codebook export ──────────────────────────────────────────────

def export_codebook_native(db: Session, project_id: int) -> dict:
    """Export all codes and categories as a .mmcodebook JSON dict."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise ValueError(f"Project {project_id} not found")

    categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).order_by(CodeCategory.display_order).all()

    # All codes — active and inactive
    codes = db.query(Code).filter(
        Code.project_id == project_id
    ).order_by(Code.category_order, Code.numeric_id).all()

    chain_map = _build_category_chain_map(categories)
    tree = _build_category_tree(categories, chain_map)

    code_list = []
    for code in codes:
        cat_path = None
        if code.category_id and code.category_id in chain_map:
            cat_path = " > ".join(chain_map[code.category_id])
        code_list.append({
            "name": code.name,
            "description": code.description,
            "color": code.color,
            "numeric_id": code.numeric_id,
            "is_universal": code.is_universal,
            "is_active": code.is_active if hasattr(code, "is_active") else True,
            "category_name_path": cat_path,
            "category_order": code.category_order,
        })

    return {
        "format_version": CURRENT_FORMAT_VERSION,
        "format_type": "mmcodebook",
        "app_version": APP_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "project_name": project.name,
        "category_level_names": project.category_level_names,
        "categories": tree,
        "codes": code_list,
    }


# ── QDC codebook export ────────────────────────────────────────────────

def export_codebook_qdc(db: Session, project_id: int) -> str:
    """Export active codes and categories as REFI-QDA .qdc XML string."""
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise ValueError(f"Project {project_id} not found")

    categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).order_by(CodeCategory.display_order).all()

    # Only active codes for QDC
    codes = db.query(Code).filter(
        Code.project_id == project_id,
        Code.is_active == True,
    ).order_by(Code.category_order, Code.numeric_id).all()

    # Build category → codes mapping
    cat_codes: dict[int | None, list] = defaultdict(list)
    for code in codes:
        cat_codes[code.category_id].append(code)

    # Build category children mapping
    cat_children: dict[int | None, list] = defaultdict(list)
    for cat in categories:
        cat_children[cat.parent_id].append(cat)

    def make_guid(entity, entity_type: str) -> str:
        """The entity's own uuid spine value, falling back to a derived GUID.

        REFI requires a GUID on every element and the Track J · J3-2 uuid spine
        already carries one, so preferring it keeps a code's identity IDENTICAL
        across .qdc and .mmproject — which is what QDPX will need to
        cross-reference later. The column is nullable (rows predating the spine
        hold NULL), hence the deterministic uuid5 fallback. Both forms satisfy
        the schema's GUIDType pattern.
        """
        own = getattr(entity, "uuid", None)
        if own:
            return own
        return str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"mixedmeasures:{entity_type}:{project_id}:{entity.id}",
        ))

    def build_code_element(code) -> ET.Element:
        attrs = {
            "guid": make_guid(code, "code"),
            "name": code.name,
            "isCodable": "true",
        }
        color = _safe_color(code.color)
        if color:
            attrs["color"] = color
        el = ET.Element("Code", attrs)
        if code.description:
            desc = ET.SubElement(el, "Description")
            desc.text = code.description
        return el

    def build_category_element(cat) -> ET.Element:
        attrs = {
            "guid": make_guid(cat, "category"),
            "name": cat.name,
            "isCodable": "false",
        }
        color = _safe_color(cat.color)
        if color:
            attrs["color"] = color
        el = ET.Element("Code", attrs)

        # Add child categories recursively
        for child_cat in cat_children.get(cat.id, []):
            el.append(build_category_element(child_cat))

        # Add codes in this category
        for code in cat_codes.get(cat.id, []):
            el.append(build_code_element(code))

        return el

    # Build XML. Only the ROOT is namespace-qualified: ElementTree writes the
    # children unqualified, and they then inherit the root's default namespace
    # on reparse — verified by round-trip, so this is correct rather than a
    # second bug hiding behind the first.
    ET.register_namespace("", QDC_NAMESPACE)
    root = ET.Element(
        f"{{{QDC_NAMESPACE}}}CodeBook",
        {"origin": f"Mixed Measures {APP_VERSION}"},
    )
    codes_container = ET.SubElement(root, "Codes")

    # Root categories
    for cat in cat_children.get(None, []):
        codes_container.append(build_category_element(cat))

    # Uncategorized codes (including universal codes)
    for code in cat_codes.get(None, []):
        codes_container.append(build_code_element(code))

    # CodesType requires at least one Code (implicit minOccurs=1), so an empty
    # codebook cannot be represented validly. Checked on the BUILT container
    # rather than predicted from the queries — that stays correct however the
    # container ended up empty (no codes, no categories, or an orphaned tree
    # with nothing at the root).
    if len(codes_container) == 0:
        raise EmptyCodebookError(
            "This codebook has no active codes, and the REFI-QDA format "
            "requires at least one. Add a code before exporting, or use "
            ".mmcodebook to export an empty codebook."
        )

    # Serialize
    tree = ET.ElementTree(root)
    import io
    buf = io.BytesIO()
    tree.write(buf, encoding="UTF-8", xml_declaration=True)
    return buf.getvalue().decode("utf-8")


# ── Native codebook import ──────────────────────────────────────────────

def import_codebook_native(db: Session, project_id: int, data: dict) -> dict:
    """Import a .mmcodebook JSON dict into an existing project.

    Returns counts of created/skipped entities.
    """
    if data.get("format_type") != "mmcodebook":
        raise ValueError(f"Invalid format_type: {data.get('format_type')}")

    # Format gate (mirrors project_portability._read_manifest_and_check_format):
    # a codebook written by a newer app version must be refused gracefully,
    # not imported best-effort with silently dropped fields.
    file_version = data.get("format_version", 0)
    if file_version > CURRENT_FORMAT_VERSION:
        raise ValueError(
            f"This codebook was created by a newer version of Mixed Measures "
            f"(format version {file_version}). Please update to import it."
        )

    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise ValueError(f"Project {project_id} not found")

    # Load existing state for dedup
    existing_categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()
    existing_codes = db.query(Code).filter(
        Code.project_id == project_id
    ).all()

    chain_map = _build_category_chain_map(existing_categories)

    # Build set of existing (name, parent_path) for categories
    existing_cat_paths = set()
    for cat in existing_categories:
        chain = chain_map.get(cat.id, [cat.name])
        parent_path = " > ".join(chain[:-1]) if len(chain) > 1 else None
        existing_cat_paths.add((cat.name, parent_path))

    # Build set of existing (name, category_path) for codes
    existing_code_paths = set()
    for code in existing_codes:
        cat_path = None
        if code.category_id and code.category_id in chain_map:
            cat_path = " > ".join(chain_map[code.category_id])
        existing_code_paths.add((code.name, cat_path))

    # Track created categories by path for code assignment
    cat_path_to_id: dict[str, int] = {}
    for cat in existing_categories:
        chain = chain_map.get(cat.id, [cat.name])
        cat_path_to_id[" > ".join(chain)] = cat.id

    # Get max display_order for categories
    max_cat_order = max(
        (c.display_order for c in existing_categories), default=-1
    )

    # Get max numeric_id for codes
    max_numeric_id = max(
        (c.numeric_id for c in existing_codes), default=1
    )

    counts = {
        "categories_created": 0,
        "categories_skipped": 0,
        "codes_created": 0,
        "codes_skipped": 0,
        "codes_uncategorized": 0,
    }

    # Import categories from tree
    def import_category_tree(nodes: list[dict], parent_id: int | None, parent_path: str | None):
        nonlocal max_cat_order
        for node in nodes:
            name = node["name"]
            key = (name, parent_path)
            if key in existing_cat_paths:
                counts["categories_skipped"] += 1
                # Still need to get its ID for code assignment
                full_path = f"{parent_path} > {name}" if parent_path else name
            else:
                max_cat_order += 1
                cat = CodeCategory(
                    project_id=project_id,
                    name=name,
                    color=node.get("color"),
                    display_order=max_cat_order,
                    parent_id=parent_id,
                )
                db.add(cat)
                db.flush()
                full_path = f"{parent_path} > {name}" if parent_path else name
                cat_path_to_id[full_path] = cat.id
                existing_cat_paths.add(key)
                counts["categories_created"] += 1

            # Recurse for children
            current_id = cat_path_to_id.get(
                f"{parent_path} > {name}" if parent_path else name
            )
            import_category_tree(
                node.get("children", []),
                current_id,
                f"{parent_path} > {name}" if parent_path else name,
            )

    import_category_tree(data.get("categories", []), None, None)

    # Import codes
    for code_data in data.get("codes", []):
        name = code_data["name"]
        cat_path = code_data.get("category_name_path")
        numeric_id = code_data.get("numeric_id", 0)

        # Skip universal codes
        if numeric_id in (0, 1) or code_data.get("is_universal"):
            counts["codes_skipped"] += 1
            continue

        # Check dedup
        key = (name, cat_path)
        if key in existing_code_paths:
            counts["codes_skipped"] += 1
            continue

        # Assign category
        category_id = None
        if cat_path:
            category_id = cat_path_to_id.get(cat_path)
            if category_id is None:
                counts["codes_uncategorized"] += 1
                logger.warning(
                    "Code '%s' category path '%s' not found, importing uncategorized",
                    name, cat_path,
                )

        max_numeric_id += 1
        code = Code(
            project_id=project_id,
            numeric_id=max_numeric_id,
            name=name,
            description=code_data.get("description"),
            color=code_data.get("color"),
            is_universal=False,
            is_active=code_data.get("is_active", True),
            category_id=category_id,
            category_order=code_data.get("category_order", 0),
        )
        db.add(code)
        existing_code_paths.add(key)
        counts["codes_created"] += 1

    db.flush()
    return counts


# ── QDC codebook import ────────────────────────────────────────────────

def import_codebook_qdc(db: Session, project_id: int, xml_content: str) -> dict:
    """Import a REFI-QDA .qdc XML codebook into an existing project.

    Returns counts of created/skipped entities.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise ValueError(f"Project {project_id} not found")

    # Parse XML with namespace
    try:
        root = _safe_fromstring(xml_content)
    except ET.ParseError as e:
        raise ValueError(f"Invalid XML: {e}")

    # Find the <Codes> container by LOCAL NAME, so the file's namespace is
    # irrelevant (#633). This reads a standards-compliant
    # `urn:QDA-XML:codebook:1.0` file, one of MM's own pre-#633 `…:1:0` files,
    # a namespace-less file, and any future revision of the standard.
    codes_container = _find_child(root, "Codes")
    if codes_container is None:
        raise ValueError(
            "No <Codes> element found in QDC file "
            f"(root element is <{_local(root.tag) or 'unknown'}>; "
            "a REFI-QDA codebook has <CodeBook> at the root with a <Codes> child)"
        )

    # Pre-flight caps, before any DB work — refuse loudly instead of dying
    # mid-import with a 500. `iter()` walks the whole subtree once.
    total_codes = sum(1 for e in codes_container.iter() if _local(e.tag) == "Code")
    if total_codes > MAX_QDC_CODES:
        raise ValueError(
            f"QDC file contains {total_codes} codes, which exceeds the "
            f"{MAX_QDC_CODES} supported in one import."
        )

    # Load existing state for dedup
    existing_categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()
    existing_codes = db.query(Code).filter(
        Code.project_id == project_id
    ).all()

    chain_map = _build_category_chain_map(existing_categories)

    existing_cat_paths = set()
    for cat in existing_categories:
        chain = chain_map.get(cat.id, [cat.name])
        parent_path = " > ".join(chain[:-1]) if len(chain) > 1 else None
        existing_cat_paths.add((cat.name, parent_path))

    existing_code_paths = set()
    for code in existing_codes:
        cat_path = None
        if code.category_id and code.category_id in chain_map:
            cat_path = " > ".join(chain_map[code.category_id])
        existing_code_paths.add((code.name, cat_path))

    cat_path_to_id: dict[str, int] = {}
    for cat in existing_categories:
        chain = chain_map.get(cat.id, [cat.name])
        cat_path_to_id[" > ".join(chain)] = cat.id

    max_cat_order = max(
        (c.display_order for c in existing_categories), default=-1
    )
    max_numeric_id = max(
        (c.numeric_id for c in existing_codes), default=1
    )

    counts = {
        "categories_created": 0,
        "categories_skipped": 0,
        "codes_created": 0,
        "codes_skipped": 0,
        "codes_uncategorized": 0,
    }

    def process_code_element(
        el: ET.Element,
        parent_id: int | None,
        parent_path: str | None,
        depth: int = 0,
    ):
        nonlocal max_cat_order, max_numeric_id

        # This function recurses once per nesting level, so a deeply nested file
        # exhausts the Python stack long before it exhausts the 10 MB upload cap
        # (measured: 2000 levels in 112 KB). defusedxml stops entity expansion,
        # not nesting depth.
        if depth > MAX_QDC_DEPTH:
            raise ValueError(
                f"QDC file nests codes more than {MAX_QDC_DEPTH} levels deep, "
                "which is deeper than any real codebook and is not supported."
            )

        name = (el.get("name") or "").strip()
        if not name:
            return
        # String(255) on both models, and SQLite will not enforce it.
        name = name[:_MAX_NAME_LEN]

        # Determine if category or code
        is_codable_attr = el.get("isCodable")
        children = [c for c in el if _local(c.tag) == "Code"]
        has_children = len(children) > 0

        if is_codable_attr is not None:
            is_codable = is_codable_attr.lower() == "true"
        else:
            # Default: leaf → codable, parent → not codable
            is_codable = not has_children

        is_category = has_children or not is_codable
        # A foreign file's colour is arbitrary text until proven otherwise.
        color = _safe_color(el.get("color"))

        # Get description
        desc_el = _find_child(el, "Description")
        description = desc_el.text if desc_el is not None else None

        current_cat_id = parent_id
        current_path = parent_path

        if is_category:
            # Create as category
            key = (name, parent_path)
            full_path = f"{parent_path} > {name}" if parent_path else name

            if key in existing_cat_paths:
                counts["categories_skipped"] += 1
                current_cat_id = cat_path_to_id.get(full_path)
            else:
                max_cat_order += 1
                cat = CodeCategory(
                    project_id=project_id,
                    name=name,
                    color=color,
                    display_order=max_cat_order,
                    parent_id=parent_id,
                )
                db.add(cat)
                db.flush()
                cat_path_to_id[full_path] = cat.id
                existing_cat_paths.add(key)
                current_cat_id = cat.id
                counts["categories_created"] += 1

            current_path = full_path

            # Edge case: both parent AND codable — also create a code
            if is_codable and has_children:
                code_key = (name, current_path)
                if code_key not in existing_code_paths:
                    max_numeric_id += 1
                    code = Code(
                        project_id=project_id,
                        numeric_id=max_numeric_id,
                        name=name,
                        description=description,
                        color=color,
                        is_universal=False,
                        is_active=True,
                        category_id=current_cat_id,
                        category_order=0,
                    )
                    db.add(code)
                    existing_code_paths.add(code_key)
                    counts["codes_created"] += 1
                    logger.warning(
                        "QDC: '%s' is both parent and codable — "
                        "created as category + code",
                        name,
                    )

            # Recurse into children
            for child in children:
                process_code_element(child, current_cat_id, current_path, depth + 1)

        else:
            # Create as code
            code_key = (name, parent_path)
            if code_key in existing_code_paths:
                counts["codes_skipped"] += 1
                return

            # Matches the native import's meaning of "uncategorized": the file
            # NAMED a placement we could not resolve. A legitimately top-level
            # code (parent_path is None) is not an anomaly and is not counted.
            if parent_path is not None and parent_id is None:
                counts["codes_uncategorized"] += 1
                logger.warning(
                    "QDC: code '%s' nested under '%s', which did not resolve to "
                    "a category — importing uncategorized",
                    name, parent_path,
                )

            max_numeric_id += 1
            code = Code(
                project_id=project_id,
                numeric_id=max_numeric_id,
                name=name,
                description=description,
                color=color,
                is_universal=False,
                is_active=True,
                category_id=parent_id,
                category_order=0,
            )
            db.add(code)
            existing_code_paths.add(code_key)
            counts["codes_created"] += 1

    # Process all top-level <Code> elements
    for code_el in codes_container:
        if _local(code_el.tag) == "Code":
            process_code_element(code_el, None, None, 0)

    db.flush()
    return counts
