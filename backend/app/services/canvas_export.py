"""Canvas Word (.docx) export.

Walks Tiptap JSON content from canvas themes and generates a Word document
using python-docx. A chart renders as the PNG the client captured from the
live chart, else as the data table the client shaped (#1406 D5) — the server
derives no chart numbers of its own.
"""

import io
import json
import logging
from dataclasses import dataclass

from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml.ns import qn

from ..models.canvas import Canvas, CanvasTheme, CanvasThemeRelationship
from ..config import get_media_dir
from .xml_text import xml_safe_text, xml_safe_tree

logger = logging.getLogger(__name__)


# ── Chart tables ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ChartTable:
    """A chart's data table as the CLIENT shaped it (#1406 D5).

    🔴 The server used to derive its own (`_get_chart_table_data`, deleted):
    it matched a metric by column and type alone, ignoring the embed's grouping,
    proportion settings and exclusions, and read the missing-group bucket of a
    grouped metric as the variable's value — wrong for every grouped embed, and
    a third copy of a decision `lib/canvas-export.ts::fetchChartTables` already
    makes for the Markdown and HTML exports. Now all four formats print one
    table. ``too_large`` marks a table the router refused for its size (the
    document then says so; ``headers``/``rows`` are empty).
    """
    headers: list[str]
    rows: list[list[str]]
    too_large: bool = False


# ── Tiptap → docx walker ─────────────────────────────────────────────────────


def _extract_text(node: dict) -> str:
    """Recursively extract plain text from a Tiptap node."""
    if node.get("type") == "text":
        return node.get("text", "")
    parts = []
    for child in node.get("content", []):
        parts.append(_extract_text(child))
    return "".join(parts)


def _add_text_runs(paragraph, node: dict) -> None:
    """Add text with formatting marks as runs to a paragraph."""
    if node.get("type") == "text":
        text = node.get("text", "")
        if not text:
            return
        run = paragraph.add_run(text)
        for mark in node.get("marks", []):
            mt = mark.get("type")
            if mt == "bold":
                run.bold = True
            elif mt == "italic":
                run.italic = True
            elif mt == "strike":
                run.font.strike = True
            elif mt == "link":
                run.underline = True
                run.font.color.rgb = RGBColor(0x33, 0x6B, 0x87)
        return

    for child in node.get("content", []):
        _add_text_runs(paragraph, child)


def _render_node(
    doc: Document, node: dict, project_id: int,
    chart_images: dict[int, bytes] | None = None,
    chart_tables: dict[int, ChartTable] | None = None,
) -> None:
    """Render a single Tiptap node to the Word document."""
    ntype = node.get("type", "")
    attrs = node.get("attrs") or {}

    if ntype == "paragraph":
        p = doc.add_paragraph()
        _add_text_runs(p, node)

    elif ntype == "heading":
        level = min(int(attrs.get("level", 3)) + 1, 6)
        text = _extract_text(node)
        doc.add_heading(text, level=level)

    elif ntype == "bulletList":
        for li in node.get("content", []):
            text = _extract_text(li)
            doc.add_paragraph(text, style="List Bullet")

    elif ntype == "orderedList":
        for li in node.get("content", []):
            text = _extract_text(li)
            doc.add_paragraph(text, style="List Number")

    elif ntype == "blockquote":
        text = _extract_text(node)
        p = doc.add_paragraph(text)
        p.style = doc.styles["Quote"] if "Quote" in [s.name for s in doc.styles] else None
        p.paragraph_format.left_indent = Inches(0.5)

    elif ntype == "horizontalRule":
        p = doc.add_paragraph()
        pPr = p._element.get_or_add_pPr()
        pBdr = pPr.makeelement(qn("w:pBdr"), {})
        bottom = pBdr.makeelement(qn("w:bottom"), {
            qn("w:val"): "single",
            qn("w:sz"): "4",
            qn("w:space"): "1",
            qn("w:color"): "CCCCCC",
        })
        pBdr.append(bottom)
        pPr.append(pBdr)

    elif ntype == "excerpt-embed":
        display_text = attrs.get("displayText", "")
        source = attrs.get("sourceContext", "")
        tag = attrs.get("materialTag")

        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.4)
        run = p.add_run(f"\u201c{display_text}\u201d")
        run.italic = True
        if source:
            p.add_run(f"\n\u2014 {source}").italic = True
        if tag:
            t = doc.add_paragraph()
            t.paragraph_format.left_indent = Inches(0.4)
            r = t.add_run(f"Tag: {tag}")
            r.italic = True
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

    elif ntype == "chart-embed":
        title = attrs.get("title", "Chart")
        tag = attrs.get("materialTag")
        material_id = attrs.get("materialId")

        # Title
        p = doc.add_paragraph()
        r = p.add_run(title)
        r.bold = True

        # Prefer a rasterized chart image (captured client-side); fall back to a data table.
        png_bytes = None
        if chart_images and material_id is not None:
            try:
                png_bytes = chart_images.get(int(material_id))
            except (ValueError, TypeError):
                png_bytes = None

        if png_bytes:
            try:
                doc.add_picture(io.BytesIO(png_bytes), width=Inches(6))
            except Exception:
                logger.warning("Failed to embed chart image for material %s", material_id)
                png_bytes = None  # fall through to table

        # The client's data table (when no image, or image embed failed) — #1406 D5.
        table_data = None
        if not png_bytes and chart_tables and material_id is not None:
            try:
                table_data = chart_tables.get(int(material_id))
            except (ValueError, TypeError):
                table_data = None

        if png_bytes:
            pass  # image already added
        elif table_data is not None and table_data.too_large:
            p = doc.add_paragraph()
            r = p.add_run("Table too large for the Word export — the HTML, PDF and Markdown exports include it.")
            r.italic = True
            r.font.color.rgb = RGBColor(0x9C, 0xA3, 0xAF)
        elif table_data is not None:
            headers, rows = table_data.headers, table_data.rows
            table = doc.add_table(rows=len(rows) + 1, cols=len(headers))
            table.style = "Table Grid"
            # ⚠️ ONE pass over the rows. Indexing `table.rows[i].cells[j]` re-walks
            # the table per cell: MEASURED 19.8 s for a 2,000-row table against
            # 1.1 s iterated (python-docx 1.2.0), on an endpoint that runs on the
            # event loop — and a grouped long table (#1406 D7) can be that long.
            for i, (tr, values) in enumerate(zip(table.rows, [headers, *rows])):
                for cell, val in zip(tr.cells, values):
                    cell.text = val
                    for paragraph in cell.paragraphs:
                        for run in paragraph.runs:
                            run.font.size = Pt(9)
                            if i == 0:
                                run.bold = True
        else:
            p = doc.add_paragraph()
            r = p.add_run("Chart data unavailable")
            r.italic = True
            r.font.color.rgb = RGBColor(0x9C, 0xA3, 0xAF)

        if tag:
            t = doc.add_paragraph()
            r = t.add_run(f"Tag: {tag}")
            r.italic = True
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

    elif ntype == "memo-embed":
        num_id = attrs.get("numericId", "")
        title = attrs.get("title", "")
        preview = attrs.get("preview", "")
        tag = attrs.get("materialTag")

        p = doc.add_paragraph()
        label = f"Memo M-{num_id}"
        if title:
            label += f": {title}"
        r = p.add_run(label)
        r.bold = True

        if preview:
            doc.add_paragraph(preview)

        if tag:
            t = doc.add_paragraph()
            r = t.add_run(f"Tag: {tag}")
            r.italic = True
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

    elif ntype == "callout-stat":
        value = attrs.get("value", "")
        label = attrs.get("label", "")
        source = attrs.get("sourceDescription")
        tag = attrs.get("materialTag")

        p = doc.add_paragraph()
        p.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
        r = p.add_run(value)
        r.bold = True
        r.font.size = Pt(18)
        if label:
            r2 = p.add_run(f" {label}")
            r2.font.size = Pt(11)

        if source:
            s = doc.add_paragraph()
            s.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
            r = s.add_run(source)
            r.italic = True
            r.font.color.rgb = RGBColor(0x9C, 0xA3, 0xAF)

        if tag:
            t = doc.add_paragraph()
            t.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
            r = t.add_run(f"Tag: {tag}")
            r.italic = True
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

    elif ntype == "image-embed":
        image_id = attrs.get("imageId", "")
        alt = attrs.get("alt", "")
        tag = attrs.get("materialTag")

        if image_id:
            path = get_media_dir() / str(project_id) / "canvas" / str(image_id)
            if path.is_file():
                try:
                    doc.add_picture(str(path), width=Inches(5))
                except Exception:
                    logger.warning("Failed to embed image %s", image_id)
                    p = doc.add_paragraph()
                    r = p.add_run("Image unavailable")
                    r.italic = True
                    r.font.color.rgb = RGBColor(0x9C, 0xA3, 0xAF)
            else:
                p = doc.add_paragraph()
                r = p.add_run("Image unavailable")
                r.italic = True
                r.font.color.rgb = RGBColor(0x9C, 0xA3, 0xAF)

        if alt:
            p = doc.add_paragraph()
            r = p.add_run(alt)
            r.italic = True
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

        if tag:
            t = doc.add_paragraph()
            r = t.add_run(f"Tag: {tag}")
            r.italic = True
            r.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)

    else:
        # Unknown node — try to render children
        for child in node.get("content", []):
            _render_node(doc, child, project_id, chart_images, chart_tables)


def _render_tiptap_content(
    doc: Document, content: str | dict | None, project_id: int,
    chart_images: dict[int, bytes] | None = None,
    chart_tables: dict[int, ChartTable] | None = None,
) -> None:
    """Render Tiptap JSON content to the Word document."""
    if not content:
        return
    try:
        parsed = json.loads(content) if isinstance(content, str) else content
    except (json.JSONDecodeError, TypeError):
        return
    # #1485: python-docx refuses an XML-illegal character as the run is added,
    # failing the whole document. Clean the WHOLE tree once, here, so every
    # node type and every attr a renderer reads — today's and a new one's — is
    # covered without a call at each `add_run`.
    parsed = xml_safe_tree(parsed)
    for node in parsed.get("content", []):
        _render_node(doc, node, project_id, chart_images, chart_tables)


# ── Main export function ─────────────────────────────────────────────────────


def export_canvas_docx(
    canvas: Canvas, project_id: int,
    chart_images: dict[int, bytes] | None = None,
    chart_tables: dict[int, ChartTable] | None = None,
) -> io.BytesIO:
    """Generate a Word document from a canvas and return as BytesIO.

    ``chart_images`` maps a chart-embed's materialId to a PNG (captured
    client-side from the live chart). When present, the chart renders as that
    image; otherwise it renders as ``chart_tables``' entry — the table the
    client shaped, the one its Markdown and HTML exports print (#1406 D5) —
    and with neither, as "Chart data unavailable".

    Every string reaches the document through ``services/xml_text.py`` (#1485):
    the Tiptap tree in ``_render_tiptap_content``, the rest here. ⚠️ Cleaned
    into LOCALS — never assign a cleaned value back to ``canvas`` or a theme:
    the router commits after the export, so it would be written to the project.
    """
    doc = Document()
    if chart_tables:
        chart_tables = {
            mid: ChartTable(
                headers=[xml_safe_text(h) for h in t.headers],
                rows=[[xml_safe_text(c) for c in r] for r in t.rows],
                too_large=t.too_large,
            )
            for mid, t in chart_tables.items()
        }

    # Title
    doc.add_heading(xml_safe_text(canvas.name), level=0)

    # Themes in doc_order
    themes = sorted(canvas.themes, key=lambda t: t.doc_order)
    theme_names: dict[int, str] = {t.id: xml_safe_text(t.name) for t in themes}

    for theme in themes:
        # Heading level based on nesting
        level = 2 if theme.parent_theme_id is not None else 1
        doc.add_heading(theme_names[theme.id], level=level)

        # Render prose content
        _render_tiptap_content(doc, theme.content, project_id, chart_images, chart_tables)

    # Relationships section
    all_rels: list[CanvasThemeRelationship] = []
    seen_ids: set[int] = set()
    for theme in themes:
        if hasattr(theme, "relationships_out") and theme.relationships_out:
            for r in theme.relationships_out:
                if r.id not in seen_ids:
                    seen_ids.add(r.id)
                    all_rels.append(r)

    if all_rels:
        doc.add_page_break()
        doc.add_heading("Relationships", level=1)
        for rel in all_rels:
            src = theme_names.get(rel.source_theme_id, "Unknown")
            tgt = theme_names.get(rel.target_theme_id, "Unknown")
            arrow = "\u2194" if rel.is_bidirectional else "\u2192"
            type_str = "" if rel.relationship_type == "custom" else xml_safe_text(rel.relationship_type)
            label_str = xml_safe_text(rel.label or "")
            desc = ""
            if type_str and label_str:
                desc = f": {type_str} \u00b7 {label_str}"
            elif type_str:
                desc = f": {type_str}"
            elif label_str:
                desc = f": {label_str}"
            doc.add_paragraph(
                f"{src} {arrow} {tgt}{desc}",
                style="List Bullet",
            )

    # Save to buffer
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf
