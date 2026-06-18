"""Codebook exchange service — export and import .mmcodebook and .qdc files.

Handles native JSON codebook format and REFI-QDA XML codebook format
for interoperability with ATLAS.ti, NVivo, MAXQDA, Dedoose, etc.
"""

import logging
import uuid
import xml.etree.ElementTree as ET
from defusedxml.ElementTree import fromstring as _safe_fromstring
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Code, CodeCategory, Project
from ..services.backup import APP_VERSION

logger = logging.getLogger(__name__)

QDC_NAMESPACE = "urn:QDA-XML:codebook:1:0"
CURRENT_FORMAT_VERSION = 1


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

    def make_guid(entity_type: str, entity_id: int) -> str:
        return str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"mixedmeasures:{entity_type}:{project_id}:{entity_id}",
        ))

    def build_code_element(code) -> ET.Element:
        attrs = {
            "guid": make_guid("code", code.id),
            "name": code.name,
            "isCodable": "true",
        }
        if code.color:
            attrs["color"] = code.color
        el = ET.Element("Code", attrs)
        if code.description:
            desc = ET.SubElement(el, "Description")
            desc.text = code.description
        return el

    def build_category_element(cat) -> ET.Element:
        attrs = {
            "guid": make_guid("category", cat.id),
            "name": cat.name,
            "isCodable": "false",
        }
        if cat.color:
            attrs["color"] = cat.color
        el = ET.Element("Code", attrs)

        # Add child categories recursively
        for child_cat in cat_children.get(cat.id, []):
            el.append(build_category_element(child_cat))

        # Add codes in this category
        for code in cat_codes.get(cat.id, []):
            el.append(build_code_element(code))

        return el

    # Build XML
    ET.register_namespace("", QDC_NAMESPACE)
    root = ET.Element(
        f"{{{QDC_NAMESPACE}}}CodeBook",
        {"origin": "Mixed Measures"},
    )
    codes_container = ET.SubElement(root, "Codes")

    # Root categories
    for cat in cat_children.get(None, []):
        codes_container.append(build_category_element(cat))

    # Uncategorized codes (including universal codes)
    for code in cat_codes.get(None, []):
        codes_container.append(build_code_element(code))

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

    # Find <Codes> container — try with and without namespace
    ns = {"qda": QDC_NAMESPACE}
    codes_container = root.find("qda:Codes", ns)
    if codes_container is None:
        codes_container = root.find("Codes")
    if codes_container is None:
        raise ValueError("No <Codes> element found in QDC file")

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
    ):
        nonlocal max_cat_order, max_numeric_id

        name = el.get("name", "")
        if not name:
            return

        # Determine if category or code
        is_codable_attr = el.get("isCodable")
        children = [
            c for c in el
            if c.tag == "Code" or c.tag == f"{{{QDC_NAMESPACE}}}Code"
        ]
        has_children = len(children) > 0

        if is_codable_attr is not None:
            is_codable = is_codable_attr.lower() == "true"
        else:
            # Default: leaf → codable, parent → not codable
            is_codable = not has_children

        is_category = has_children or not is_codable
        color = el.get("color")

        # Get description
        desc_el = el.find("Description")
        if desc_el is None:
            desc_el = el.find(f"{{{QDC_NAMESPACE}}}Description")
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
                process_code_element(child, current_cat_id, current_path)

        else:
            # Create as code
            code_key = (name, parent_path)
            if code_key in existing_code_paths:
                counts["codes_skipped"] += 1
                return

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
        if code_el.tag == "Code" or code_el.tag == f"{{{QDC_NAMESPACE}}}Code":
            process_code_element(code_el, None, None)

    db.flush()
    return counts
