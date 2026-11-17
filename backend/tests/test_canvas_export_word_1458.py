"""#1458, #1457 (Word) and #1420 — what a Canvas's lists, quotes, mentions, line breaks and links
become in the Word export, read back from the built `.docx`.

Before: a list item and a quote were `_extract_text` of everything in them — a nested list
printed "ParentChild AChild B", two paragraphs ran together, marks were dropped and an EMBED
inside an item or a quote vanished; every ordered list in the document was ONE count (each
"List Number" paragraph took the style's single numbering); a mention printed nothing and a
Shift+Enter break glued two lines into one word; a link was an underline with no address.
"""
import json
import re
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

from app.services import canvas_export
from app.services.canvas import extract_theme_searchable_text
from app.services.canvas_export import _render_tiptap_content

FRONTEND_LIB = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib"


def t(s, *marks):
    n = {"type": "text", "text": s}
    if marks:
        n["marks"] = list(marks)
    return n


def p(*kids):
    return {"type": "paragraph", "content": list(kids)}


def li(*kids):
    return {"type": "listItem", "content": list(kids)}


def ul(*items, **attrs):
    return {"type": "bulletList", "content": list(items)}


def ol(*items, start=None):
    n = {"type": "orderedList", "content": list(items)}
    if start is not None:
        n["attrs"] = {"start": start}
    return n


def link(href):
    return {"type": "link", "attrs": {"href": href}}


MENTION = {"type": "mention", "attrs": {"id": "12", "label": "Barriers"}}
BR = {"type": "hardBreak"}
EXCERPT = {"type": "excerpt-embed", "attrs": {"displayText": "We never had the time", "sourceContext": "P3"}}
BOLD, ITALIC = {"type": "bold"}, {"type": "italic"}


def render(*nodes) -> Document:
    doc = Document()
    _render_tiptap_content(doc, json.dumps({"type": "doc", "content": list(nodes)}), 1)
    return doc


def rows(doc) -> list[tuple[str, str]]:
    return [(par.style.name, par.text) for par in doc.paragraphs]


def num_id(par) -> str | None:
    pPr = par._p.pPr
    if pPr is None or pPr.numPr is None or pPr.numPr.numId is None:
        return None
    return str(pPr.numPr.numId.val)


def start_of(doc, nid: str) -> int | None:
    numbering = doc.part.numbering_part.element
    vals = numbering.xpath(f'./w:num[@w:numId="{nid}"]/w:lvlOverride/w:startOverride/@w:val')
    return int(vals[0]) if vals else None


# ── #1457: mentions and line breaks ───────────────────────────────────────────


class TestMentionsAndBreaks:
    def test_a_mention_prints_its_label(self):
        doc = render(p(t("as "), MENTION, t(" shows")))
        assert rows(doc) == [("Normal", "as @Barriers shows")]

    def test_a_mention_with_no_label_prints_its_id_as_the_editor_does(self):
        doc = render(p({"type": "mention", "attrs": {"id": "7", "label": None}}))
        assert doc.paragraphs[0].text == "@7"

    def test_a_mention_keeps_the_marks_around_it(self):
        doc = render(p({**MENTION, "marks": [BOLD]}))
        assert [(r.text, r.bold) for r in doc.paragraphs[0].runs] == [("@Barriers", True)]

    def test_a_hard_break_is_a_line_break_not_glue(self):
        doc = render(p(t("line one"), BR, t("line two")))
        par = doc.paragraphs[0]
        assert par.text == "line one\nline two"
        assert len(par._p.findall(".//" + qn("w:br"))) == 1

    def test_the_editors_underline_survives(self):
        """StarterKit 3 ships Underline (Ctrl+U) and the canvas editor does not turn it off."""
        doc = render(p(t("under", {"type": "underline"}), t(" plain")))
        assert [(r.text, bool(r.underline)) for r in doc.paragraphs[0].runs] == [("under", True), (" plain", False)]

    def test_the_search_text_holds_the_mention(self):
        text = extract_theme_searchable_text({"type": "doc", "content": [p(t("as "), MENTION, t(" shows"))]})
        assert "@Barriers" in text
        assert "as" in text and "shows" in text   # control: the prose around it


# ── #1458: lists and quotes ───────────────────────────────────────────────────


class TestListsAndQuotes:
    def test_a_nested_list_is_one_paragraph_per_item_one_level_deeper(self):
        doc = render(ul(li(p(t("Parent")), ul(li(p(t("Child A"))), li(p(t("Child B")))))))
        assert rows(doc) == [
            ("List Bullet", "Parent"), ("List Bullet 2", "Child A"), ("List Bullet 2", "Child B"),
        ]

    def test_a_list_deeper_than_three_takes_the_third_levels_style(self):
        deep = ul(li(p(t("1")), ul(li(p(t("2")), ul(li(p(t("3")), ul(li(p(t("4"))))))))))
        assert [s for s, _ in rows(render(deep))] == [
            "List Bullet", "List Bullet 2", "List Bullet 3", "List Bullet 3",
        ]

    def test_an_items_second_paragraph_is_its_own_paragraph_under_it(self):
        doc = render(ol(li(p(t("Para one")), p(t("Para two")))))
        assert rows(doc) == [("List Number", "Para one"), ("List Continue", "Para two")]
        assert num_id(doc.paragraphs[1]) is None     # no second number for the same item

    def test_a_quotes_paragraphs_stay_apart_with_their_marks(self):
        doc = render({"type": "blockquote", "content": [p(t("One")), p(t("Two", BOLD), t(" three", ITALIC))]})
        assert rows(doc) == [("Quote", "One"), ("Quote", "Two three")]
        assert [(r.text, bool(r.bold), bool(r.italic)) for r in doc.paragraphs[1].runs] == [
            ("Two", True, False), (" three", False, True),
        ]
        assert doc.paragraphs[0].paragraph_format.left_indent is not None

    def test_marks_mentions_breaks_and_links_survive_inside_a_list_item(self):
        doc = render(ul(li(p(t("see "), t("bold", BOLD), t(" "), t("the source", link("https://e.org/r")),
                              t(" and "), MENTION, BR, t("next")))))
        par = doc.paragraphs[0]
        assert par.text == "see bold the source and @Barriers\nnext"
        assert any(r.bold and r.text == "bold" for r in par.runs)
        assert [(h.address, h.text) for h in par.hyperlinks] == [("https://e.org/r", "the source")]

    def test_an_embed_inside_a_list_item_or_a_quote_is_printed_not_dropped(self):
        doc = render(
            ul(li(p(t("Item")), EXCERPT)),
            {"type": "blockquote", "content": [p(t("Quote")), EXCERPT]},
        )
        texts = [par.text for par in doc.paragraphs]
        assert sum("We never had the time" in x for x in texts) == 2, texts
        assert "Item" in texts and "Quote" in texts                   # control

    def test_a_quote_inside_a_list_item_prints_as_a_quote(self):
        doc = render(ul(li(p(t("Item")), {"type": "blockquote", "content": [p(t("Said"))]})))
        assert rows(doc) == [("List Bullet", "Item"), ("Quote", "Said")]

    def test_a_list_inside_a_quote_prints_as_a_list(self):
        doc = render({"type": "blockquote", "content": [p(t("Said")), ul(li(p(t("Item")), p(t("More"))))]})
        assert rows(doc) == [("Quote", "Said"), ("List Bullet", "Item"), ("List Continue", "More")]

    def test_a_heading_keeps_its_mention_marks_and_breaks(self):
        """A heading reaches Word only from imported JSON the editor has not yet cleaned."""
        doc = render({"type": "heading", "attrs": {"level": 2}, "content": [t("On "), MENTION, BR, t("again", ITALIC)]})
        par = doc.paragraphs[0]
        assert (par.style.name, par.text) == ("Heading 3", "On @Barriers\nagain")
        assert any(r.italic and r.text == "again" for r in par.runs)

    def test_text_put_straight_into_an_item_or_quote_is_kept(self):
        """Imported JSON may skip the paragraph (the #1485 oracle's fixture does)."""
        doc = render(ul(li(t("Bare"), t(" item"))), {"type": "blockquote", "content": [t("Bare quote")]})
        assert rows(doc) == [("List Bullet", "Bare item"), ("Quote", "Bare quote")]


class TestNumbering:
    def test_each_ordered_list_counts_from_its_own_start(self):
        doc = render(
            ol(li(p(t("A1"))), li(p(t("A2")))),
            p(t("between")),
            ol(li(p(t("B1")))),
            ol(li(p(t("C3"))), start=3),
        )
        a1, a2, _, b1, c3 = doc.paragraphs
        assert num_id(a1) == num_id(a2) is not None                   # control: ONE list, one count
        assert len({num_id(a1), num_id(b1), num_id(c3)}) == 3         # three lists, three counts
        assert [start_of(doc, num_id(x)) for x in (a1, b1, c3)] == [1, 1, 3]

    def test_a_nested_ordered_list_restarts_under_each_parent(self):
        doc = render(ol(
            li(p(t("P1")), ol(li(p(t("P1.a"))))),
            li(p(t("P2")), ol(li(p(t("P2.a"))))),
        ))
        _, c1, _, c2 = doc.paragraphs
        assert c1.style.name == c2.style.name == "List Number 2"
        assert num_id(c1) != num_id(c2)
        assert start_of(doc, num_id(c2)) == 1

    def test_a_malformed_start_counts_from_one(self):
        for bad in ("3", None, -2, True, False, 2.5):
            doc = render({"type": "orderedList", "attrs": {"start": bad}, "content": [li(p(t("x")))]})
            assert start_of(doc, num_id(doc.paragraphs[0])) == 1, bad

    def test_a_bulleted_list_is_unchanged(self):
        """CONTROL: bullets carry no count, so they keep the style's own numbering."""
        doc = render(ul(li(p(t("a"))), li(p(t("b")))))
        assert rows(doc) == [("List Bullet", "a"), ("List Bullet", "b")]
        assert num_id(doc.paragraphs[0]) is None


# ── #1420: links ──────────────────────────────────────────────────────────────


class TestLinks:
    def test_a_link_is_a_hyperlink_to_its_address(self):
        doc = render(p(t("see "), t("the source", link("https://example.org/report"))))
        par = doc.paragraphs[0]
        assert par.text == "see the source"
        assert [(h.address, h.text) for h in par.hyperlinks] == [("https://example.org/report", "the source")]

    def test_two_links_to_one_address_share_one_relationship(self):
        doc = render(p(t("a", link("https://e.org")), t(" "), t("b", link("https://e.org"))))
        rels = [r for r in doc.part.rels.values() if r.reltype.endswith("/hyperlink")]
        assert len(rels) == 1 and rels[0].is_external

    def test_a_refused_link_keeps_its_words_and_nothing_else(self):
        for href in ("javascript:alert(1)", "#section-2", "www.example.org", None, 42):
            doc = render(p(t("see "), t("here", link(href))))
            par = doc.paragraphs[0]
            assert par.text == "see here", href
            assert par.hyperlinks == [], href
            assert not any(r.underline for r in par.runs), href   # not an underline to nowhere
        rels = [r for r in doc.part.rels.values() if r.reltype.endswith("/hyperlink")]
        assert rels == []


# ── #1420: the allow-list is the client's ─────────────────────────────────────


def _vectors() -> dict:
    return json.loads((FRONTEND_LIB / "export-href-vectors-1420.json").read_text(encoding="utf-8"))


class TestTheAllowListIsTheClients:
    def test_the_scheme_set_is_the_typescript_one(self):
        ts = (FRONTEND_LIB / "canvas-export.ts").read_text(encoding="utf-8")
        m = re.search(r"EXPORT_LINK_SCHEMES[^=]*=\s*new Set\(\[([^\]]*)\]\)", ts)
        assert m, "EXPORT_LINK_SCHEMES not found in canvas-export.ts"
        client = set(re.findall(r"'([^']+)'", m.group(1)))
        assert client == set(canvas_export.EXPORT_LINK_SCHEMES)

    def test_the_shared_vectors(self):
        v = _vectors()
        assert len(v["kept"]) >= 5 and len(v["refused"]) >= 10     # a table that lost its rows passes
        kept = [h for h in v["kept"] if canvas_export.exportable_href(h) is None]
        refused = [h for h in v["refused"] if canvas_export.exportable_href(h) is not None]
        assert (kept, refused) == ([], [])

    def test_the_address_written_is_the_trimmed_href(self):
        assert canvas_export.exportable_href(" https://e.org/x ") == "https://e.org/x"
