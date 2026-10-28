"""#1318 — a Word document is read through ONE walk of its body.

`extract_text_from_docx` used to read `doc.paragraphs` / `para.text` /
`para.runs` / `doc.tables`, which see only the body's DIRECT `w:p` children and
each paragraph's DIRECT `w:r | w:hyperlink`. Everything Word wraps in another
element — a tracked insertion, a content control, a simple field, a smart tag, a
text box — was dropped without a word, and a form made only of content controls
was refused as empty. `services/document_import.py::_docx_body_walk` is now the
one reader (rule: the internal design notes).

Every fixture is BUILT here, with python-docx plus injected XML — no foreign
file enters the repo.
"""

import time
from io import BytesIO

import docx
import pytest
from docx.opc.constants import CONTENT_TYPE as CT, RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import parse_xml
from lxml import etree

from app.models.document import SegmentationMode
from app.services import document_import
from app.services.document_import import extract_text_from_docx, segment_document


NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:v="urn:schemas-microsoft-com:vml" '
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
)


def R(text: str, extra: str = "") -> str:
    """A run holding `text`."""
    return f'<w:r>{extra}<w:t xml:space="preserve">{text}</w:t></w:r>'


def P(inner: str, ppr: str = "") -> str:
    """A paragraph element carrying its own namespace declarations."""
    return f"<w:p {NS}>{ppr}{inner}</w:p>"


def inject(d, xml: str):
    """Put a raw block-level element at the end of the body (before sectPr)."""
    el = parse_xml(xml)
    d.element.body.sectPr.addprevious(el)
    return el


def save(d) -> bytes:
    buf = BytesIO()
    d.save(buf)
    return buf.getvalue()


def texts(file_bytes: bytes) -> list[str]:
    return [p.text for p in extract_text_from_docx(file_bytes).paragraphs]


def framed(*blocks: str) -> bytes:
    """`Before.`, then each raw block, then `After.`."""
    d = docx.Document()
    d.add_paragraph("Before.")
    for block in blocks:
        inject(d, block)
    d.add_paragraph("After.")
    return save(d)


# ---------------------------------------------------------------------------
# Characterisation pins — these held at HEAD (29d7494f) before the walk, and
# were unpinned. The walk must keep every one.
# ---------------------------------------------------------------------------

class TestWhatTheOldReaderGotRight:
    def test_heading_levels_come_from_the_paragraph_style(self):
        d = docx.Document()
        d.add_heading("The title", level=0)          # style "Title": not a heading level
        for level in range(1, 8):
            d.add_heading(f"Level {level}", level=level)
        d.add_paragraph("Body text.")
        d.add_heading("Level 2 again", level=2)      # a style seen before (#1318's cache)
        extracted = extract_text_from_docx(save(d))
        assert [(p.text, p.heading_level) for p in extracted.paragraphs] == [
            ("The title", None),
            ("Level 1", 1), ("Level 2", 2), ("Level 3", 3),
            ("Level 4", 4), ("Level 5", 5), ("Level 6", 6),
            ("Level 7", None),                       # only Heading 1-6 are levels
            ("Body text.", None),
            ("Level 2 again", 2),
        ]

    def test_run_specials_map_as_python_docx_mapped_them(self):
        # tab -> \t · line break -> \n · cr -> \n · no-break hyphen -> "-" ·
        # soft hyphen and symbol -> nothing · page break -> nothing.
        specials = P(
            '<w:r><w:t xml:space="preserve">a</w:t><w:tab/>'
            '<w:t xml:space="preserve">b</w:t><w:br/>'
            '<w:t xml:space="preserve">c</w:t><w:cr/>'
            '<w:t xml:space="preserve">d</w:t><w:noBreakHyphen/>'
            '<w:t xml:space="preserve">e</w:t><w:softHyphen/>'
            '<w:t xml:space="preserve">f</w:t><w:sym w:font="Wingdings" w:char="F0FC"/>'
            '<w:t xml:space="preserve">g</w:t><w:br w:type="page"/>'
            '<w:t xml:space="preserve">h</w:t><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/>'
            '<w:t xml:space="preserve">i</w:t><w:br w:type="column"/>'
            '<w:t xml:space="preserve">j</w:t></w:r>'
        )
        assert texts(framed(specials)) == ["Before.", "a\tb\nc\nd-efgh\ti" + "j", "After."]

    def test_a_non_breaking_space_becomes_a_space_and_the_edges_are_trimmed(self):
        d = docx.Document()
        d.add_paragraph("non breaking")
        d.add_paragraph("  padded  ")
        assert texts(save(d)) == ["non breaking", "padded"]

    def test_an_empty_paragraph_is_skipped(self):
        d = docx.Document()
        d.add_paragraph("One.")
        d.add_paragraph("")
        d.add_paragraph("   ")
        d.add_paragraph(" ")
        d.add_paragraph("Two.")
        assert texts(save(d)) == ["One.", "Two."]

    def test_a_hyperlinks_text_is_kept(self):
        link = P(R("See ") + '<w:hyperlink w:anchor="x">' + R("the report") + "</w:hyperlink>" + R("."))
        assert texts(framed(link)) == ["Before.", "See the report.", "After."]

    def test_a_complex_fields_result_is_kept_and_its_instruction_is_not(self):
        field = P(
            R("Site: ")
            + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            + '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Site </w:instrText></w:r>'
            + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            + R("Riverside clinic")
            + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        )
        assert texts(framed(field)) == ["Before.", "Site: Riverside clinic", "After."]

    def test_a_table_of_contents_field_without_a_content_control_is_imported(self):
        # Older Word and LibreOffice write a bare TOC field whose result spans
        # paragraphs. The old reader imported it; the walk keeps doing so.
        first = P(
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            + R("Introduction") + "<w:r><w:tab/></w:r>" + R("1")
        )
        second = P(R("Methods") + "<w:r><w:tab/></w:r>" + R("2") + '<w:r><w:fldChar w:fldCharType="end"/></w:r>')
        assert texts(framed(first, second)) == ["Before.", "Introduction\t1", "Methods\t2", "After."]

    def test_a_deleted_paragraph_mark_keeps_two_paragraphs(self):
        # Accepting the deletion would JOIN them; both readers keep two, and no
        # text is lost. Pinned as the decided behaviour (#1318 review, item 11).
        first = P(R("First half"), '<w:pPr><w:rPr><w:del w:id="24" w:author="A"/></w:rPr></w:pPr>')
        second = P(R(" second half."))
        assert texts(framed(first, second)) == ["Before.", "First half", "second half.", "After."]

    def test_hidden_text_is_imported(self):
        # `w:vanish` is formatting; the old reader imported hidden text and so
        # does the walk (a separate question, not #1318's).
        hidden = P(R("Visible ") + '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">HIDDEN </w:t></w:r>' + R("text."))
        assert texts(framed(hidden)) == ["Before.", "Visible HIDDEN text.", "After."]


# ---------------------------------------------------------------------------
# One fixture per construct the old reader dropped (the review's table)
# ---------------------------------------------------------------------------

#: The tracked-changes sentence, as decided (D15) — written out here rather than
#: imported, so the test is an independent statement of the wording.
TRACKED = (
    "This document has tracked changes. It was imported as if all of them were "
    "accepted: inserted text kept, deleted text left out. To import another "
    "version, accept or reject the changes in your word processor and import again."
)


def INS(inner: str, n: int = 1) -> str:
    return f'<w:ins w:id="{n}" w:author="A" w:date="2026-01-01T00:00:00Z">{inner}</w:ins>'


def DEL(text: str, n: int = 2) -> str:
    return (f'<w:del w:id="{n}" w:author="A" w:date="2026-01-01T00:00:00Z">'
            f'<w:r><w:delText xml:space="preserve">{text}</w:delText></w:r></w:del>')


def warnings_of(file_bytes: bytes) -> list[str]:
    return extract_text_from_docx(file_bytes).extraction_warnings


class TestTrackedChangesAreImportedAsAccepted:
    def test_an_inserted_run_and_an_inserted_paragraph_are_kept(self):
        run = P(R("The participant said ") + INS(R("very ")) + R("clearly."))
        whole = P(INS(R("A whole new paragraph."), 20), '<w:pPr><w:rPr><w:ins w:id="21" w:author="A"/></w:rPr></w:pPr>')
        data = framed(run, whole)
        assert texts(data) == [
            "Before.", "The participant said very clearly.", "A whole new paragraph.", "After.",
        ]
        assert warnings_of(data) == [TRACKED]

    def test_a_deletion_and_an_insertion_in_one_sentence_read_as_the_accepted_version(self):
        # The old reader produced "I was happy." — neither version.
        sentence = P(
            R("I was ") + DEL("not ") + INS(R("very "), 3) + R("happy.")
            + INS(DEL(" (inserted then deleted)", 5), 4)
        )
        assert texts(framed(sentence)) == ["Before.", "I was very happy.", "After."]

    def test_a_move_keeps_the_destination_only(self):
        source = P(
            '<w:moveFromRangeStart w:id="10" w:name="move1" w:author="A"/>'
            '<w:moveFrom w:id="11" w:author="A">' + R("Moved sentence.") + "</w:moveFrom>"
            '<w:moveFromRangeEnd w:id="10"/>' + R(" Stays here.")
        )
        destination = P(
            R("Destination: ") + '<w:moveToRangeStart w:id="12" w:name="move1" w:author="A"/>'
            '<w:moveTo w:id="13" w:author="A">' + R("Moved sentence.") + "</w:moveTo>"
            '<w:moveToRangeEnd w:id="12"/>'
        )
        data = framed(source, destination)
        assert texts(data) == ["Before.", "Stays here.", "Destination: Moved sentence.", "After."]
        assert warnings_of(data) == [TRACKED]

    def test_an_insertion_inside_a_link_and_a_field_inside_an_insertion_are_kept(self):
        nested = P(
            '<w:hyperlink w:anchor="x">' + R("link ") + INS(R("inserted-in-link"), 30) + "</w:hyperlink>"
            + INS('<w:fldSimple w:instr=" PAGE ">' + R(" 7") + "</w:fldSimple>", 31)
        )
        assert texts(framed(nested)) == ["Before.", "link inserted-in-link 7", "After."]

    def test_no_tracked_change_no_sentence(self):
        assert warnings_of(framed(P(R("Plain.")))) == []


class TestContentControls:
    def test_an_inline_control_is_read(self):
        inline = P(R("Name: ") + '<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent>'
                   + R("Maria") + "</w:sdtContent></w:sdt>")
        assert texts(framed(inline)) == ["Before.", "Name: Maria", "After."]

    def test_a_block_control_is_read_with_its_heading_level(self):
        block = (f'<w:sdt {NS}><w:sdtPr><w:alias w:val="Answer"/></w:sdtPr><w:sdtContent>'
                 + P(R("Answer paragraph one."))
                 + P(R("Answer heading."), '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>')
                 + "</w:sdtContent></w:sdt>")
        extracted = extract_text_from_docx(framed(block))
        assert [(p.text, p.heading_level) for p in extracted.paragraphs] == [
            ("Before.", None), ("Answer paragraph one.", None), ("Answer heading.", 2), ("After.", None),
        ]

    def test_a_form_made_only_of_controls_is_not_empty(self):
        # The old reader found no text here, and the import refused the file.
        d = docx.Document()
        inject(d, f"<w:sdt {NS}><w:sdtPr/><w:sdtContent>"
                  + P(R("Q1 answer in control.")) + P(R("Q2 answer in control."))
                  + "</w:sdtContent></w:sdt>")
        assert texts(save(d)) == ["Q1 answer in control.", "Q2 answer in control."]

    def test_a_control_showing_its_placeholder_is_not_read(self):
        placeholder = P(R("Name: ") + "<w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent>"
                        + R("Click or tap here to enter text.") + "</w:sdtContent></w:sdt>")
        assert texts(framed(placeholder)) == ["Before.", "Name:", "After."]

    def test_a_table_of_contents_control_is_not_read(self):
        toc = (f"<w:sdt {NS}><w:sdtPr><w:docPartObj><w:docPartGallery w:val=\"Table of Contents\"/>"
               "<w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>"
               + P(R("Contents"), '<w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr>')
               + P('<w:hyperlink w:anchor="_Toc1">' + R("Introduction") + "<w:r><w:tab/></w:r>"
                   + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                   + '<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r>'
                   + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                   + R("3") + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>')
               + "</w:sdtContent></w:sdt>")
        assert texts(framed(toc)) == ["Before.", "After."]


class TestFields:
    def test_a_simple_fields_result_is_read(self):
        simple = P(R("Interview date: ") + '<w:fldSimple w:instr=" DATE \\@ &quot;d MMMM yyyy&quot; ">'
                   + R("3 March 2026") + "</w:fldSimple>")
        assert texts(framed(simple)) == ["Before.", "Interview date: 3 March 2026", "After."]

    def test_a_field_nested_in_an_instruction_leaves_only_the_outer_result(self):
        # The old reader let the nested field's result leak: "X: inner-resultyes".
        nested = P(
            R("X: ")
            + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            + '<w:r><w:instrText xml:space="preserve"> IF </w:instrText></w:r>'
            + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            + '<w:r><w:instrText xml:space="preserve"> MERGEFIELD A </w:instrText></w:r>'
            + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + R("inner-result")
            + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
            + '<w:r><w:instrText xml:space="preserve"> = 1 "yes" "no" </w:instrText></w:r>'
            + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            + R("yes")
            + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        )
        assert texts(framed(nested)) == ["Before.", "X: yes", "After."]

    def test_a_field_left_open_does_not_hide_the_rest_of_the_document(self):
        unclosed = P(R("Lead ") + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                     '<w:r><w:instrText> MERGEFIELD X </w:instrText></w:r>')
        assert texts(framed(unclosed, P(R("Must survive.")))) == ["Before.", "Lead", "Must survive.", "After."]


class TestInlineWrappers:
    def test_a_smart_tag_is_read(self):
        tagged = P(R("We met in ") + '<w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="City">'
                   + R("Boston") + "</w:smartTag>" + R("."))
        assert texts(framed(tagged)) == ["Before.", "We met in Boston.", "After."]

    def test_custom_xml_is_read_inline_and_as_a_block(self):
        inline = P(R("Code ") + '<w:customXml w:element="x">' + R("ABC") + "</w:customXml>" + R(" end."))
        block = f'<w:customXml {NS} w:element="blk">' + P(R("Inside block customXml.")) + "</w:customXml>"
        assert texts(framed(inline, block)) == ["Before.", "Code ABC end.", "Inside block customXml.", "After."]

    def test_bidirectional_wrappers_are_read(self):
        bidi = P(R("Quote: ") + '<w:dir w:val="rtl">' + R("שלום") + "</w:dir>"
                 + '<w:bdo w:val="rtl">' + R(" עולם") + "</w:bdo>")
        assert texts(framed(bidi)) == ["Before.", "Quote: שלום עולם", "After."]

    def test_ruby_reads_the_base_text_and_not_the_guide(self):
        ruby = P(R("Base: ") + "<w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>かん</w:t></w:r></w:rt>"
                 "<w:rubyBase><w:r><w:t>漢</w:t></w:r></w:rubyBase></w:ruby></w:r>" + R(" end."))
        assert texts(framed(ruby)) == ["Before.", "Base: 漢 end.", "After."]


# A minimal valid 1x1 PNG (python-docx reads its IHDR for the size).
PNG = (
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
    b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00'
    b'\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
)
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def picture_paragraph(d) -> str:
    """A picture paragraph's XML whose image part stays related to `d` — built
    by `add_picture`, then lifted out of the body so a test can place it."""
    d.add_picture(BytesIO(PNG))
    p = d.element.body.findall(W + "p")[-1]
    xml = etree.tostring(p).decode()
    p.getparent().remove(p)
    return xml


def text_box(anchor_text: str, box_content: str, tail_text: str) -> str:
    """A paragraph anchoring a text box the way Word writes one: the SAME box in
    a modern `mc:Choice` and a VML `mc:Fallback`."""
    return P(
        R(anchor_text)
        + '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor>'
        + '<wp:docPr id="1" name="TB"/><a:graphic>'
        + '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
        + "<wps:wsp><wps:txbx><w:txbxContent>" + box_content
        + "</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>"
        + "<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>" + box_content
        + "</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>"
        + R(tail_text)
    )


class TestTextBoxes:
    def test_a_text_box_is_read_once_after_its_anchor(self):
        boxed = text_box("Anchor paragraph.", P(R("Text box sentence.")), " Anchor continues.")
        assert texts(framed(boxed)) == [
            "Before.", "Anchor paragraph. Anchor continues.", "Text box sentence.", "After.",
        ]

    def test_a_picture_in_a_text_box_is_stored_once(self):
        # The old scan searched every `w:drawing` under the run, so the picture
        # was found once per enclosing drawing: three copies.
        d = docx.Document()
        d.add_paragraph("Before.")
        pic = picture_paragraph(d)
        inject(d, text_box("Anchor.", pic + P(R("Caption in box.")), ""))
        d.add_paragraph("After.")
        extracted = extract_text_from_docx(save(d))
        assert [p.text for p in extracted.paragraphs] == ["Before.", "Anchor.", "Caption in box.", "After."]
        assert len(extracted.images) == 1
        assert extracted.images[0].format == "png"
        assert extracted.images[0].position_after_paragraph == 1   # the box comes after "Anchor."


class TestPictures:
    def test_a_picture_in_a_block_control_and_in_an_inserted_run_are_kept(self):
        d = docx.Document()
        d.add_paragraph("Before.")
        pic = picture_paragraph(d)
        inject(d, f"<w:sdt {NS}><w:sdtPr/><w:sdtContent>" + pic + "</w:sdtContent></w:sdt>")
        d.add_paragraph("Middle.")
        run = etree.tostring(parse_xml(pic).find(W + "r")).decode()
        inject(d, P(INS(run, 5)))
        d.add_paragraph("After.")
        extracted = extract_text_from_docx(save(d))
        assert [p.text for p in extracted.paragraphs] == ["Before.", "Middle.", "After."]
        assert [i.position_after_paragraph for i in extracted.images] == [0, 1]

    def test_a_picture_in_a_deleted_run_is_left_out(self):
        d = docx.Document()
        d.add_paragraph("Before.")
        pic = picture_paragraph(d)
        run = etree.tostring(parse_xml(pic).find(W + "r")).decode()
        inject(d, P(f'<w:del w:id="6" w:author="A">{run}</w:del>'))
        assert extract_text_from_docx(save(d)).images == []


def not_imported(*items: str, tables: bool = False) -> str:
    """The parts-not-imported sentence, as drafted (D13/D14)."""
    listed = items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]
    how = "move them into the main text (convert tables to text)" if tables else "move them into the main text"
    return (f"Some of this document was not imported: {listed}. Only the main text is imported. "
            f"To code any of these, {how} and import again.")


def add_table(d, text: str = "Cell"):
    t = d.add_table(rows=1, cols=2)
    t.cell(0, 0).text = text
    return t


def table_xml(text: str) -> str:
    return (f"<w:tbl {NS}><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid>"
            f"<w:tr><w:tc><w:tcPr/>" + P(R(text)) + "</w:tc></w:tr></w:tbl>")


class TestWhatIsNotImportedIsCounted:
    def test_the_drafted_sentence(self):
        d = docx.Document()
        p = d.add_paragraph("Commented sentence.")
        d.add_comment(p.runs, text="Reviewer: check this", author="Rev")
        d.add_comment(p.runs, text="A second note", author="Rev")
        q = d.add_paragraph("Another commented one.")
        d.add_comment(q.runs, text="Third", author="Rev")
        add_table(d, "Tier")
        add_table(d, "Weeks")
        inject(d, P(R("A claim") + '<w:r><w:footnoteReference w:id="1"/></w:r>' + R(".")))
        footnotes = (f'<w:footnotes {NS}><w:footnote w:id="1"><w:p>' + R("Footnote text.")
                     + "</w:p></w:footnote></w:footnotes>").encode()
        d.part.relate_to(Part(PackURI("/word/footnotes.xml"), CT.WML_FOOTNOTES, footnotes, d.part.package), RT.FOOTNOTES)
        section = d.sections[0]
        section.different_first_page_header_footer = True
        section.header.paragraphs[0].text = "Site 4 interview"
        section.first_page_header.paragraphs[0].text = "Cover header"
        section.footer.paragraphs[0].text = "Confidential"
        section.first_page_footer.paragraphs[0].text = "Cover footer"
        data = save(d)
        assert texts(data) == ["Commented sentence.", "Another commented one.", "A claim."]
        assert warnings_of(data) == [not_imported(
            "2 tables", "3 comments", "1 footnote", "the text in its headers and footers", tables=True,
        )]

    def test_a_table_inside_a_content_control_is_counted(self):
        # The old warning read body-level `doc.tables` and said nothing here.
        wrapped = f"<w:sdt {NS}><w:sdtPr/><w:sdtContent>" + table_xml("Cell in sdt table") + "</w:sdtContent></w:sdt>"
        assert warnings_of(framed(wrapped)) == [not_imported("1 table", tables=True)]

    def test_a_table_inside_a_text_box_is_counted(self):
        boxed = text_box("Anchor.", table_xml("Cell in a box"), "")
        assert warnings_of(framed(boxed)) == [not_imported("1 table", tables=True)]

    def test_a_table_with_a_table_inside_it_is_one_table(self):
        outer = (f"<w:tbl {NS}><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr/>"
                 + table_xml("Inner cell") + "<w:p/></w:tc></w:tr></w:tbl>")
        assert warnings_of(framed(outer)) == [not_imported("1 table", tables=True)]

    def test_an_empty_table_loses_nothing_and_is_not_counted(self):
        d = docx.Document()
        d.add_paragraph("Body.")
        d.add_table(rows=2, cols=2)
        assert warnings_of(save(d)) == []

    def test_endnotes_equations_and_embedded_documents_are_counted(self):
        data = framed(
            P(R("And more") + '<w:r><w:endnoteReference w:id="1"/></w:r>' + R(".")),
            P(R("Effect size ") + "<m:oMath><m:r><m:t>d=0.4</m:t></m:r></m:oMath>" + R(" observed.")),
            f'<w:altChunk {NS} r:id="rIdAlt"/>',
        )
        assert texts(data) == ["Before.", "And more.", "Effect size  observed.", "After."]
        assert warnings_of(data) == [not_imported("1 endnote", "1 equation", "1 embedded document")]

    def test_a_footer_holding_only_a_page_number_is_not_counted(self):
        d = docx.Document()
        d.add_paragraph("Body.")
        d.sections[0].footer.paragraphs[0]._p.append(
            parse_xml(f'<w:fldSimple {NS} w:instr=" PAGE ">' + R("1") + "</w:fldSimple>"))
        d.sections[0].header.paragraphs[0]._p.append(parse_xml(
            f'<w:r {NS}><w:fldChar w:fldCharType="begin"/></w:r>'))
        hp = d.sections[0].header.paragraphs[0]._p
        hp.append(parse_xml(f'<w:r {NS}><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'))
        hp.append(parse_xml(f'<w:r {NS}><w:fldChar w:fldCharType="separate"/></w:r>'))
        hp.append(parse_xml(R("2").replace("<w:r>", f"<w:r {NS}>")))
        hp.append(parse_xml(f'<w:r {NS}><w:fldChar w:fldCharType="end"/></w:r>'))
        assert warnings_of(save(d)) == []

    def test_a_header_showing_only_a_placeholder_is_not_counted(self):
        d = docx.Document()
        d.add_paragraph("Body.")
        d.sections[0].header.paragraphs[0]._p.append(parse_xml(
            f"<w:sdt {NS}><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent>"
            + R("[Type here]") + "</w:sdtContent></w:sdt>"))
        assert warnings_of(save(d)) == []

    def test_one_header_with_text_is_named_as_one(self):
        d = docx.Document()
        d.add_paragraph("Body.")
        d.sections[0].header.paragraphs[0].text = "Site 4 interview"
        assert warnings_of(save(d)) == [not_imported("the text in its header")]

    def test_both_sentences_in_order(self):
        d = docx.Document()
        d.add_paragraph("Body.")
        add_table(d)
        inject(d, P(R("Kept ") + INS(R("inserted"))))
        assert warnings_of(save(d)) == [not_imported("1 table", tables=True), TRACKED]


class TestTheWalkKeepsItsSafetyNets:
    def test_a_failure_after_some_text_keeps_what_was_read(self, monkeypatch):
        real = document_import._DocxWalk._heading_level
        calls = []

        def fail_on_the_second(self, p):
            calls.append(p)
            if len(calls) == 2:
                raise KeyError("unexpected structure")
            return real(self, p)

        monkeypatch.setattr(document_import._DocxWalk, "_heading_level", fail_on_the_second)
        d = docx.Document()
        d.add_paragraph("One.")
        d.add_paragraph("Two.")
        d.add_paragraph("Three.")
        assert texts(save(d)) == ["One."]

    def test_a_failure_before_any_text_is_refused_in_words(self, monkeypatch):
        def fail(self, p):
            raise AttributeError("unexpected structure")

        monkeypatch.setattr(document_import._DocxWalk, "_heading_level", fail)
        d = docx.Document()
        d.add_paragraph("One.")
        with pytest.raises(ValueError, match="could not be processed"):
            extract_text_from_docx(save(d))


def test_twenty_thousand_paragraphs_well_inside_the_clients_timeout():
    """`para.style` cost ~1 ms a paragraph, so the old reader took 26 s here —
    against the client's 30 s default (`client.ts`). The heading cache answers
    once per distinct style (0.27 s measured on the same shape)."""
    d = docx.Document()
    body = "".join(
        P(R(f"Section {i}"), '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>') if i % 50 == 0
        else P(R(f"Paragraph number {i} of the long interview transcript."))
        for i in range(20_000)
    )
    sect = d.element.body.sectPr
    for p in list(parse_xml(f"<w:body {NS}>{body}</w:body>")):
        sect.addprevious(p)
    data = save(d)

    started = time.perf_counter()
    extracted = extract_text_from_docx(data)
    elapsed = time.perf_counter() - started

    assert len(extracted.paragraphs) == 20_000
    assert sum(p.heading_level == 2 for p in extracted.paragraphs) == 400
    assert elapsed < 6.0, f"{elapsed:.1f} s for 20,000 paragraphs"


def test_a_warning_reaches_the_segmentation_ahead_of_its_own():
    d = docx.Document()
    d.add_paragraph("Body.")
    add_table(d)
    _, warnings = segment_document(extract_text_from_docx(save(d)), SegmentationMode.HEADING)
    assert warnings == [
        not_imported("1 table", tables=True),
        "No headings detected in this document. Fell back to paragraph mode.",
    ]
