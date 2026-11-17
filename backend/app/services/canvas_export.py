"""Canvas Word (.docx) export.

Walks Tiptap JSON content from canvas themes and generates a Word document
using python-docx. A chart renders as the PNG the client captured from the
live chart, else as the data table the client shaped (#1406 D5) — the server
derives no chart numbers of its own.
"""

import io
import json
import logging
import re
from dataclasses import dataclass, field

from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml.ns import qn

from ..models.canvas import Canvas, CanvasTheme, CanvasThemeRelationship
from ..config import get_media_dir
from .canvas import mention_text
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
    document then says so; ``headers``/``rows`` are empty). ``note`` is the sentence the
    Markdown and HTML exports print under the table (`ExportTable.note`), printed under it here
    too — Word dropped it, so a comparison's table lost the words saying which groups its tests
    left out.
    """
    headers: list[str]
    rows: list[list[str]]
    too_large: bool = False
    note: str = ""


@dataclass(frozen=True)
class DisplayAppendix:
    """A saved result's own table, printed after the joint display it stands beside (D165)."""
    title: str
    headers: list[str]
    rows: list[list[str]]
    note: str = ""


@dataclass(frozen=True)
class DisplayTable:
    """A joint display's REPORT table as the CLIENT built it (ROADMAP row 56, D174).

    🔴 The same table the Report view on the Canvas shows and the Markdown and HTML exports
    print — `lib/joint-display-report.ts::buildJointDisplayReport` builds it once, from the
    display's LIVE numbers under the viewer's blind scope — so the server writes strings and
    derives nothing (#1406 D5's rule for chart tables, here for the display). Unlike a chart
    table it carries its ``note`` (the bases, the definitions, the scope, the date — D176's
    build note: the note must reach Word too) and ``span_rows``: a different-unit result's row
    beside its construct, one cell merged across the table. ``message`` replaces the table
    when there is nothing to tabulate; ``too_large`` marks one the router refused for size.
    """
    title: str
    message: str | None = None
    headers: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    span_rows: frozenset[int] = frozenset()
    note: str = ""
    appendix: list[DisplayAppendix] = field(default_factory=list)
    too_large: bool = False


# ── Tiptap → docx walker ─────────────────────────────────────────────────────


#: #1420 — the schemes a link in an exported document keeps its address for: the Python
#: twin of `lib/canvas-export.ts::EXPORT_LINK_SCHEMES` (#1339), held equal to it by
#: `tests/test_canvas_export_word_1458.py` (which reads the TypeScript).
EXPORT_LINK_SCHEMES = frozenset({"http", "https", "mailto"})

#: What JavaScript's `String.prototype.trim` removes (ECMAScript WhiteSpace + LineTerminator)
#: — NOT Python's `str.strip()`, which also takes U+001C–U+001F and U+0085 and leaves U+FEFF,
#: so the twin would keep or drop a different set of links than the client. (Built from code
#: points so no invisible character sits in the source.)
_JS_TRIM = "\t\n\v\f\r " + "".join(map(chr, (
    0x00A0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
)))

#: `re.ASCII`: without it IGNORECASE lets `[a-z]` match U+017F and U+212A, which the client's
#: `/i` regex does not. Defensive — neither lowercases into "http", "https" or "mailto" — but it
#: keeps the twin a twin if the set grows.
_SCHEME = re.compile(r"([a-z][a-z0-9+.-]*):", re.IGNORECASE | re.ASCII)

_LINK_BLUE = RGBColor(0x33, 0x6B, 0x87)


def exportable_href(href) -> str | None:
    """#1420 — the address a link keeps in the Word file, or None when only its words may go.

    The SAME allow-list as the client's `exportableHref` (#1339 D8): kept only when the href,
    from its first non-blank character, begins `http:`, `https:` or `mailto:`. Content arrives
    verbatim from `.mmproject` imports, so Tiptap's own link check is no guard here. Returns the
    trimmed href (a relationship target with a leading blank leads nowhere).
    """
    if not isinstance(href, str):
        return None
    trimmed = href.strip(_JS_TRIM)
    m = _SCHEME.match(trimmed)
    return trimmed if m and m.group(1).lower() in EXPORT_LINK_SCHEMES else None


def _hyperlink(paragraph, run, href: str) -> None:
    """#1420 — move ``run`` into a ``w:hyperlink`` to ``href`` (python-docx has no API for one).
    The run is made by ``add_run`` first so its text gets python-docx's own line-break and tab
    handling; ``relate_to`` reuses one relationship per address."""
    r_id = paragraph.part.relate_to(href, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run._r.addprevious(link)
    link.append(run._r)


def _add_text_runs(paragraph, node: dict) -> None:
    """Add a node's inline content to a paragraph as runs, with its marks.

    #1457: a ``mention`` prints ``@label`` and a ``hardBreak`` is Word's line break — both were
    dropped (the words around a mention closed up; Shift+Enter lines ran together). #1420: a link
    is a real hyperlink when ``exportable_href`` keeps it, else its words alone, as the Markdown
    and HTML exports print it — no longer an underline leading nowhere.
    """
    ntype = node.get("type")
    if ntype == "hardBreak":
        paragraph.add_run().add_break()
        return
    if ntype == "text":
        text = node.get("text", "")
    elif ntype == "mention":
        text = mention_text(node.get("attrs") or {})
    else:
        for child in node.get("content", []):
            _add_text_runs(paragraph, child)
        return
    if not text:
        return
    run = paragraph.add_run(text)
    href = None
    for mark in node.get("marks") or []:
        mt = mark.get("type")
        if mt == "bold":
            run.bold = True
        elif mt == "italic":
            run.italic = True
        elif mt == "strike":
            run.font.strike = True
        elif mt == "underline":
            run.underline = True
        elif mt == "link":
            href = exportable_href((mark.get("attrs") or {}).get("href"))
            if href is not None:
                run.underline = True
                run.font.color.rgb = _LINK_BLUE
    if href is not None:
        _hyperlink(paragraph, run, href)


# ── Lists and quotes (#1458) ─────────────────────────────────────────────────

#: The deepest level python-docx's default template styles ("List Bullet 3", "List Number 3",
#: "List Continue 3"); a deeper item takes level 3's style.
_MAX_LIST_LEVEL = 3
_INLINE = frozenset({"text", "mention", "hardBreak"})


@dataclass(frozen=True)
class _Where:
    """Where a block sits (#1458): inside how many lists, and whether the INNERMOST container
    is a quote (a quote in a list item prints as a quote; a list in a quote, as a list)."""
    list_level: int = 0
    quote: bool = False


_TOP = _Where()


def _blocks(node: dict) -> list[dict]:
    """A container's children as blocks: a run of bare inline nodes (imported JSON may put
    text straight into a list item or quote — the schema never does) becomes one paragraph."""
    out: list[dict] = []
    for child in node.get("content", []):
        if child.get("type") in _INLINE:
            if out and out[-1].get("_inline"):
                out[-1]["content"].append(child)
            else:
                out.append({"type": "paragraph", "content": [child], "_inline": True})
        else:
            out.append(child)
    return out


def _level_suffix(level: int) -> str:
    return "" if level <= 1 else f" {min(level, _MAX_LIST_LEVEL)}"


def _new_numbering(doc: Document, style: str, start) -> str:
    """#1458 — a fresh numbering instance for ONE ordered list, counting from its ``start``.

    Every "List Number" paragraph takes its numbering from the STYLE, and the style names one
    ``w:num`` — so every ordered list in the document was one count: a second list (another
    theme's included) went on from where the first stopped, and a list typed as "3." began at
    whatever came next. A new ``w:num`` over the style's own abstract numbering, with a
    ``startOverride``, restarts it.
    """
    numbering = doc.part.numbering_part.element
    style_num = doc.styles[style].element.pPr.numPr.numId.val
    abstract = numbering.xpath(f'./w:num[@w:numId="{style_num}"]/w:abstractNumId/@w:val')[0]
    num = numbering.add_num(int(abstract))
    first = start if isinstance(start, int) and not isinstance(start, bool) and start >= 0 else 1
    num.add_lvlOverride(ilvl=0).add_startOverride(first)
    return num.numId


def _render_list(doc: Document, node: dict, where: _Where, render) -> None:
    """#1458 — each item's paragraphs through ``_add_text_runs`` (marks, mentions, breaks and
    links kept), nested lists one style level deeper, an item's later paragraphs as "List
    Continue", and an embed inside an item rendered as it is anywhere else. Before, an item was
    ``_extract_text`` of everything in it: a nested list printed "ParentChild AChild B", two
    paragraphs ran together, marks were dropped and an embed inside vanished."""
    level = where.list_level + 1
    ordered = node.get("type") == "orderedList"
    style = ("List Number" if ordered else "List Bullet") + _level_suffix(level)
    num_id = _new_numbering(doc, style, (node.get("attrs") or {}).get("start")) if ordered else None
    inner = _Where(list_level=level)
    for item in node.get("content", []):
        blocks = _blocks(item)
        first = blocks.pop(0) if blocks and blocks[0].get("type") == "paragraph" else {}
        p = doc.add_paragraph(style=style)
        if num_id is not None:
            num_pr = p._p.get_or_add_pPr().get_or_add_numPr()
            num_pr.get_or_add_ilvl().val = 0
            num_pr.get_or_add_numId().val = num_id
        _add_text_runs(p, first)
        for block in blocks:
            render(block, inner)


_MUTED = RGBColor(0x9C, 0xA3, 0xAF)
_TOO_LARGE = "Table too large for the Word export — the HTML, PDF and Markdown exports include it."
_DISPLAY_UNAVAILABLE = "Joint display not available in this export."


def _muted_line(doc: Document, text: str) -> None:
    r = doc.add_paragraph().add_run(text)
    r.italic = True
    r.font.color.rgb = _MUTED


def _write_table(
    doc: Document, headers: list[str], rows: list[list[str]], span_rows: frozenset[int] = frozenset(),
) -> None:
    """A grid of strings, header row bold, 9 pt. A row in ``span_rows`` (an index into ``rows``)
    holds ONE cell, merged across the table.

    ⚠️ ONE pass over the rows. Indexing `table.rows[i].cells[j]` re-walks the table per cell:
    MEASURED 19.8 s for a 2,000-row table against 1.1 s iterated (python-docx 1.2.0), on an
    endpoint that runs on the event loop — and a grouped long table (#1406 D7) can be that long.
    """
    width = len(headers)
    table = doc.add_table(rows=len(rows) + 1, cols=width)
    table.style = "Table Grid"
    for i, (tr, values) in enumerate(zip(table.rows, [headers, *rows])):
        if i > 0 and (i - 1) in span_rows:
            cells = [tr.cells[0].merge(tr.cells[width - 1]) if width > 1 else tr.cells[0]]
            values = values[:1]
        else:
            cells = tr.cells
        for cell, val in zip(cells, values):
            cell.text = val
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(9)
                    if i == 0:
                        run.bold = True


def _write_note(doc: Document, note: str) -> None:
    if not note:
        return
    r = doc.add_paragraph().add_run(note)
    r.font.size = Pt(9)
    r.font.color.rgb = RGBColor(0x4B, 0x55, 0x63)


def _render_display(doc: Document, table: DisplayTable | None) -> None:
    """A joint display's report (D174): its title, its table or the sentence saying why there
    is none, its note, then each beside result's own table."""
    if table is None:
        _muted_line(doc, _DISPLAY_UNAVAILABLE)
        return
    doc.add_paragraph().add_run(table.title).bold = True
    if table.too_large:
        _muted_line(doc, _TOO_LARGE)
        return
    if table.message is not None:
        _muted_line(doc, table.message)
        return
    _write_table(doc, table.headers, table.rows, table.span_rows)
    _write_note(doc, table.note)
    for a in table.appendix:
        doc.add_paragraph().add_run(a.title).bold = True
        _write_table(doc, a.headers, a.rows)
        _write_note(doc, a.note)


def _render_node(
    doc: Document, node: dict, project_id: int,
    chart_images: dict[int, bytes] | None = None,
    chart_tables: dict[int, ChartTable] | None = None,
    display_tables: dict[str, DisplayTable] | None = None,
    where: _Where = _TOP,
) -> None:
    """Render a single Tiptap node to the Word document. ``where`` says whether it sits in a
    list or a quote (#1458)."""
    ntype = node.get("type", "")
    attrs = node.get("attrs") or {}

    def render(child: dict, at: _Where) -> None:
        _render_node(doc, child, project_id, chart_images, chart_tables, display_tables, at)

    if ntype == "paragraph":
        if where.quote:
            p = doc.add_paragraph(style="Quote")
            p.paragraph_format.left_indent = Inches(0.5)
        elif where.list_level:
            # A list item's second and later paragraphs: indented under its text, no bullet.
            p = doc.add_paragraph(style="List Continue" + _level_suffix(where.list_level))
        else:
            p = doc.add_paragraph()
        _add_text_runs(p, node)

    elif ntype == "heading":
        level = min(int(attrs.get("level", 3)) + 1, 6)
        _add_text_runs(doc.add_heading("", level=level), node)

    elif ntype in ("bulletList", "orderedList"):
        _render_list(doc, node, where, render)

    elif ntype == "blockquote":
        # #1458 — each paragraph of a quote is its own paragraph, with its marks; was one
        # paragraph of `_extract_text`, run together.
        for block in _blocks(node):
            render(block, _Where(list_level=where.list_level, quote=True))

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
            _muted_line(doc, _TOO_LARGE)
        elif table_data is not None:
            _write_table(doc, table_data.headers, table_data.rows)
            _write_note(doc, table_data.note)
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

    elif ntype == "joint-display":
        # D174 — the client's report table, keyed by the node's `displayKey`. The node holds
        # no text of its own, so without this arm it rendered NOTHING (the walker below finds
        # no children) — silently, in every Word file holding one.
        key = attrs.get("displayKey")
        _render_display(doc, display_tables.get(key) if display_tables and isinstance(key, str) else None)

    else:
        # Unknown node — try to render children
        for child in node.get("content", []):
            render(child, where)


def _render_tiptap_content(
    doc: Document, content: str | dict | None, project_id: int,
    chart_images: dict[int, bytes] | None = None,
    chart_tables: dict[int, ChartTable] | None = None,
    display_tables: dict[str, DisplayTable] | None = None,
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
        _render_node(doc, node, project_id, chart_images, chart_tables, display_tables)


# ── Main export function ─────────────────────────────────────────────────────


def _clean_display(t: DisplayTable) -> DisplayTable:
    """Every string of a display's report through `xml_text` (#1485), into a NEW value."""
    clean = xml_safe_text
    return DisplayTable(
        title=clean(t.title),
        message=None if t.message is None else clean(t.message),
        headers=[clean(h) for h in t.headers],
        rows=[[clean(c) for c in r] for r in t.rows],
        span_rows=t.span_rows,
        note=clean(t.note),
        appendix=[
            DisplayAppendix(
                title=clean(a.title), headers=[clean(h) for h in a.headers],
                rows=[[clean(c) for c in r] for r in a.rows], note=clean(a.note),
            )
            for a in t.appendix
        ],
        too_large=t.too_large,
    )


def export_canvas_docx(
    canvas: Canvas, project_id: int,
    chart_images: dict[int, bytes] | None = None,
    chart_tables: dict[int, ChartTable] | None = None,
    display_tables: dict[str, DisplayTable] | None = None,
) -> io.BytesIO:
    """Generate a Word document from a canvas and return as BytesIO.

    ``chart_images`` maps a chart-embed's materialId to a PNG (captured
    client-side from the live chart). When present, the chart renders as that
    image; otherwise it renders as ``chart_tables``' entry — the table the
    client shaped, the one its Markdown and HTML exports print (#1406 D5) —
    and with neither, as "Chart data unavailable". A joint display renders as
    ``display_tables``' entry for its ``displayKey`` (D174), else as one sentence
    saying it is not available — never as nothing.

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
                note=xml_safe_text(t.note),
            )
            for mid, t in chart_tables.items()
        }
    if display_tables:
        display_tables = {key: _clean_display(t) for key, t in display_tables.items()}

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
        _render_tiptap_content(doc, theme.content, project_id, chart_images, chart_tables, display_tables)

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
