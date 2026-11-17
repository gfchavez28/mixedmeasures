"""#1485 — one XML-illegal character must not fail a whole export file.

The import doors keep what they are given: a CSV answer stores a vertical tab
(FileMaker's in-cell return, Word's manual line break pasted as text) as it
came, a UTF-16 `.txt` read as UTF-8 stores NULs (#1233), and a JSON column
holds an escaped lone surrogate. The `.xlsx`, `.docx` and `.qdc` exports are
XML underneath and cannot hold any of them, so every string those writers meet
goes through `services/xml_text.py`.

Four layers:
1. The cleaned set IS what lxml refuses — every code point, both directions.
2. What a cleaned string becomes, and the formula defang reading the CLEANED
   value (`exports-wire.md` §1b).
3. Each export entered at its MOUTH with a payload in every string it writes —
   the population guard: a writer that skips the sanitiser fails here.
4. The Word endpoint through TestClient, with a lone surrogate in the body.
"""
import asyncio
import io
import json
from datetime import datetime, timezone

import pytest
from defusedxml.ElementTree import fromstring
from docx import Document
from lxml import etree
from openpyxl import Workbook, load_workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from sqlalchemy import text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.audit import AuditEntry
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_category import CodeCategory
from app.models.conversation import Conversation
from app.models.dataset import (
    ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue,
)
from app.models.document import Document as MMDocument
from app.models.excerpt import Excerpt
from app.models.memo import Memo
from app.models.metric import ComputedResult, MetricDefinition
from app.models.note import Note
from app.models.participant import Participant
from app.models.project import Project
from app.models.recode import OutputType, RecodeDefinition, RecodeType
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.routers.export_excel import export_datasets_excel, export_study_excel
from app.routers.export_helpers import excel_set_safe
from app.services.canvas import (
    create_canvas, create_theme, create_theme_relationship, get_canvas_full,
)
from app.services.canvas_export import ChartTable, DisplayAppendix, DisplayTable, export_canvas_docx
from app.services.codebook_exchange import export_codebook_qdc, import_codebook_qdc
from app.services.dataset_import import import_dataset_csv
from app.services.xml_text import xml_safe_text, xml_safe_tree

# A vertical tab (→ line break), a C0 control and U+FFFF (→ removed). A lone
# surrogate cannot be STORED in a text column — SQLite refuses it at the write
# — so it rides only where JSON carries it (a JSON column, a request body).
PAY = "P\x0bQ\x01R\uffffS"
CLEAN = "P\nQRS"
LONE = "\ud800"


def _drain(response) -> bytes:
    """A StreamingResponse's body; Starlette wraps a sync iterable as async."""
    chunks: list[bytes] = []

    async def _read():
        async for c in response.body_iterator:
            chunks.append(c if isinstance(c, bytes) else c.encode("utf-8"))

    asyncio.run(_read())
    return b"".join(chunks)


# ── 1. The cleaned set is exactly what the XML writer refuses ────────────────


def _lxml_refuses(ch: str) -> bool:
    """lxml is the writer under python-docx AND openpyxl's `save`."""
    try:
        etree.Element("a").text = f"x{ch}y"
    except (ValueError, UnicodeEncodeError):
        return True
    return False


def test_the_cleaned_set_is_exactly_what_lxml_refuses():
    """An ORACLE, not a restatement: the library decides, over every code point.

    Fails if the sanitiser misses a character a writer refuses (an export
    fails) or removes one it accepts (the export silently loses text)."""
    refused = {cp for cp in range(0x110000) if _lxml_refuses(chr(cp))}
    cleaned = {cp for cp in range(0x110000) if xml_safe_text(chr(cp)) != chr(cp)}
    assert refused == cleaned
    # The fixture could have disagreed: both arms of XML 1.0's exclusion are in
    # it, and the legal look-alikes are not.
    assert {0x00, 0x0B, 0x0C, 0x1F, 0xD800, 0xDFFF, 0xFFFE, 0xFFFF} <= refused
    assert not {0x09, 0x0A, 0x0D, 0x7F, 0x85, 0xFDD0, 0x1F600} & refused
    # openpyxl's own assignment check is a strict SUBSET — why it is not enough.
    openpyxl_own = {cp for cp in range(0x10000) if ILLEGAL_CHARACTERS_RE.search(chr(cp))}
    assert openpyxl_own < cleaned


# ── 2. What a cleaned string becomes ─────────────────────────────────────────


@pytest.mark.parametrize("raw, want", [
    ("first\x0bsecond", "first\nsecond"),     # FileMaker's in-cell return
    ("page one\x0cpage two", "page one\npage two"),
    ("a\x00b\x01c\x1fd", "abcd"),
    ("a\ud800b\udc00c", "abc"),
    ("a\ufffeb\uffffc", "abc"),
    ("tab\tnew\nret\r", "tab\tnew\nret\r"),   # legal — kept
    ("\x7f\x85\ufdd0\U0001F600", "\x7f\x85\ufdd0\U0001F600"),
    ("", ""),
])
def test_xml_safe_text(raw, want):
    assert xml_safe_text(raw) == want


def test_xml_safe_text_one_line_and_non_strings():
    assert xml_safe_text("Wave\x0b1\x0c2", line_break=" ") == "Wave 1 2"
    for v in (42, 3.5, None, True):
        assert xml_safe_text(v) is v


def test_xml_safe_tree_cleans_every_string_and_never_mutates():
    doc = {"type": "doc", "content": [{"type": "x", "attrs": {"a\x0b": ["v\x01", 7, None]}}]}
    before = json.dumps(doc)
    assert xml_safe_tree(doc) == {"type": "doc", "content": [{"type": "x", "attrs": {"a\n": ["v", 7, None]}}]}
    assert json.dumps(doc) == before


@pytest.mark.parametrize("raw, written", [("\x01=cmd|' /c calc'!A1", "=cmd|' /c calc'!A1"),
                                          ("\x0b=cmd", "\n=cmd")])
def test_the_defang_reads_the_cleaned_value(raw, written):
    """`exports-wire.md` §1b: clean BEFORE the '=' check. A check on the raw
    value misses `"\\x01=cmd"`, which is written as `"=cmd"` — a formula."""
    wb = Workbook()
    cell = excel_set_safe(wb.active.cell(row=1, column=1), raw)
    assert (cell.value, cell.data_type) == (written, "s")
    buf = io.BytesIO()
    wb.save(buf)
    loaded = load_workbook(io.BytesIO(buf.getvalue())).active.cell(row=1, column=1)
    assert (loaded.value, loaded.data_type) == (written, "s")


# ── 3a. The dataset workbook, from the CSV door (the audit's end-to-end) ─────


def test_a_csv_answer_with_a_vertical_tab_exports_as_two_lines(db_session):
    db = db_session
    p = Project(name="R", user_id=1)
    db.add(p)
    db.flush()
    configs = [{"column_index": 0, "column_type": "open_text", "column_text": "Comment", "column_code": "C001"}]
    import_dataset_csv(db, p.id, "D", configs, 'Comment\n"first line\x0bsecond"\n"plain"\n')
    db.flush()
    stored = {v for (v,) in db.query(DatasetValue.value_text)}
    assert "first line\x0bsecond" in stored  # the door keeps it, by decision
    resp = export_datasets_excel(project_id=p.id, user=db.get(User, 1), db=db)
    ws = load_workbook(io.BytesIO(_drain(resp))).worksheets[0]
    assert {c.value for c in ws["C"]} >= {"first line\nsecond", "plain"}


# ── 3b. Both workbooks: a payload in every string they write ─────────────────


def _polluted_project(db) -> int:
    """Every user string the two workbooks write carries PAY."""
    db.add(Project(id=71, name=f"Proj {PAY}", user_id=1))
    db.flush()
    db.add(Conversation(id=71, project_id=71, name=f"Conv {PAY}", subject_id=f"Subj {PAY}"))
    db.add(MMDocument(id=71, project_id=71, name=f"Doc {PAY}", source_filename="d.txt", source_format="txt"))
    db.add(Speaker(id=71, project_id=71, name=f"Spk {PAY}", is_facilitator=0))
    db.add(CodeCategory(id=71, project_id=71, name=f"Cat {PAY}", display_order=0))
    db.flush()
    db.add(Segment(id=71, conversation_id=71, speaker_id=71, sequence_order=0, text=f"Seg {PAY}"))
    db.add(Code(
        id=71, project_id=71, numeric_id=1, name=f"Code {PAY}", description=f"Desc {PAY}",
        is_active=True, category_id=71,
        magnitude_min=0.0, magnitude_max=10.0, magnitude_step=1.0,
        # JSON-escaped, so it CAN hold a lone surrogate — openpyxl's own check
        # passes one and `save` fails.
        magnitude_labels=json.dumps([{"value": 7.0, "label": f"Anchor {PAY}{LONE}"}]),
    ))
    db.flush()
    db.add(CodeApplication(segment_id=71, code_id=71, user_id=1, magnitude=7.0))
    db.add(Memo(project_id=71, numeric_id=1, content=f"Memo {PAY}", entity_type="project", entity_id=71))
    db.add(Note(conversation_id=71, segment_id=71, sequence_number=1, content=f"Note {PAY}"))
    db.add(Excerpt(project_id=71, segment_id=71))
    db.add(AuditEntry(action="edit", entity_type="code", project_id=71, details=f"Audit {PAY}"))
    db.add(Participant(id=71, project_id=71, identifier="P-71", display_name=f"Person {PAY}"))
    db.add(Dataset(id=71, project_id=71, name=f"DS {PAY}"))
    db.flush()
    db.add(DatasetColumn(
        id=71, dataset_id=71, column_code=f"Q {PAY}", column_text=f"Question {PAY}",
        column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0,
        scale_labels=json.dumps([f"Label {PAY}"]),
    ))
    db.add(DatasetRow(id=71, dataset_id=71, row_identifier=f"Rec {PAY}", participant_id=71))
    db.flush()
    db.add(DatasetValue(id=71, row_id=71, column_id=71, value_text="yes"))
    db.add(RecodeDefinition(
        column_id=71, name=f"Group {PAY}", recode_type=RecodeType.CATEGORY_GROUP,
        output_type=OutputType.CATEGORICAL, mapping=json.dumps({"yes": f"Grp {PAY}"}),
        is_primary=False,
    ))
    db.add(AnalysisDomain(id=71, project_id=71, name=f"Dom {PAY}"))
    db.flush()
    db.add(AnalysisDomainMember(domain_id=71, member_type="column", member_id=71, sequence_order=0))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(MetricDefinition(
        id=71, project_id=71, name=f"Freq {PAY}", metric_type="frequency_distribution",
        config="{}", input_source_type="dataset_column", input_source_id=71, sequence_order=1,
    ))
    db.add(MetricDefinition(
        id=72, project_id=71, name=f"Grouped {PAY}", metric_type="mean", config="{}",
        input_source_type="dataset_column", input_source_id=71, sequence_order=2,
        grouping_column_id=71,
    ))
    db.flush()
    option = f"Opt {PAY}"
    db.add(ComputedResult(
        metric_definition_id=71, valid_n=1, total_n=1, computed_at=now,
        result_data=json.dumps({"counts": {option: 1}, "percentages": {option: 100.0}, "scale_order": [option]}),
    ))
    db.add(ComputedResult(
        metric_definition_id=72, valid_n=1, total_n=1, computed_at=now, group_value=f"GV {PAY}",
        result_data=json.dumps({"mean": 1.0}),
    ))
    db.flush()
    return 71


def _cleaned_cells(body: bytes) -> dict[str, set[str]]:
    """{sheet title: every cell value that carries the CLEANED payload}."""
    wb = load_workbook(io.BytesIO(body))
    out: dict[str, set[str]] = {}
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and CLEAN in cell.value:
                    out.setdefault(ws.title, set()).add(cell.value)
    return out


def test_the_study_workbook_writes_every_string_cleaned(db_session):
    pid = _polluted_project(db_session)
    body = _drain(export_study_excel(project_id=pid, user=db_session.get(User, 1), db=db_session))
    got = _cleaned_cells(body)
    want = {
        # the Coded Data HEADER is a direct write of the code name (#1485's widening)
        "Coded Data": {f"1 - Code {CLEAN}", f"Conv {CLEAN}", f"Spk {CLEAN}", f"Seg {CLEAN}"},
        "Ratings": {f"Anchor {CLEAN}", f"Code {CLEAN}"},
        "Codebook": {f"Code {CLEAN}", f"Desc {CLEAN}", f"Cat {CLEAN}"},
        "Memos": {f"Memo {CLEAN}"},
        "Notes": {f"Note {CLEAN}"},
        "Quotes": {f"Seg {CLEAN}"},
        "Sources": {f"Conv {CLEAN}", f"Subj {CLEAN}", f"Doc {CLEAN}"},
        "Audit Trail": {f"Audit {CLEAN}"},
    }
    for sheet, values in want.items():
        assert values <= got.get(sheet, set()), (sheet, got.get(sheet))


def test_the_dataset_workbook_writes_every_string_cleaned(db_session):
    pid = _polluted_project(db_session)
    body = _drain(export_datasets_excel(project_id=pid, user=db_session.get(User, 1), db=db_session))
    got = _cleaned_cells(body)
    sheet = "DS P QRS"  # a TITLE is one line: the line break is a space
    assert sheet in load_workbook(io.BytesIO(body)).sheetnames
    want = {
        # the category_group LABEL is a direct write (#1485's widening)
        sheet: {f"Q {CLEAN}", f"Q {CLEAN} [Group {CLEAN}]", f"Rec {CLEAN}", f"Person {CLEAN}", f"Grp {CLEAN}"},
        "Data Dictionary": {f"DS {CLEAN}", f"Question {CLEAN}", f"Label {CLEAN}", f"Group {CLEAN}"},
        "Metrics Detail": {f"Opt {CLEAN}"},
        "Grouped Metrics": {f"Grouped {CLEAN}", f"GV {CLEAN}"},
    }
    for name, values in want.items():
        assert values <= got.get(name, set()), (name, got.get(name))


def test_a_category_group_label_is_defanged_too(db_session):
    """The same direct write skipped the formula defang: a group label starting
    with '=' (a project file from someone else can carry one) was written as a
    FORMULA cell. The polluted-fixture sweep in `test_export_formula_injection.py`
    has no category_group recode, so it could not see it."""
    db = db_session
    db.add(Project(id=73, name="F", user_id=1))
    db.flush()
    db.add(Dataset(id=73, project_id=73, name="DS"))
    db.flush()
    db.add(DatasetColumn(id=73, dataset_id=73, column_code="Q", column_text="Q",
                         column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0))
    db.add(DatasetRow(id=73, dataset_id=73, row_identifier="R1"))
    db.flush()
    db.add(DatasetValue(id=73, row_id=73, column_id=73, value_text="yes"))
    db.add(RecodeDefinition(column_id=73, name="G", recode_type=RecodeType.CATEGORY_GROUP,
                            output_type=OutputType.CATEGORICAL,
                            mapping=json.dumps({"yes": "=HYPERLINK(\"http://x\")"}), is_primary=False))
    db.flush()
    body = _drain(export_datasets_excel(project_id=73, user=db.get(User, 1), db=db))
    ws = load_workbook(io.BytesIO(body))["DS"]
    cell = next(c for c in ws[2] if c.value == "=HYPERLINK(\"http://x\")")
    assert cell.data_type == "s"


# ── 3c. The Canvas Word export: every node type, every string ────────────────


def _polluted_canvas(db):
    p = Project(name="P", user_id=1)
    db.add(p)
    db.flush()
    c = create_canvas(db, p.id, f"Canvas {PAY}")
    a = create_theme(db, c.id, f"Theme {PAY}")
    b = create_theme(db, c.id, f"Child {PAY}", parent_theme_id=a.id)
    create_theme_relationship(db, c.id, a.id, b.id, "supports", label=f"Rel {PAY}")

    def t(s):
        return {"type": "text", "text": s}

    tag = {"materialTag": f"Tag {PAY}"}
    # Stored through json.dumps, so the tree CAN hold a lone surrogate (an
    # imported `.mmproject` writes `content` verbatim).
    a.content = json.dumps({"type": "doc", "content": [
        {"type": "paragraph", "content": [t(f"Para {PAY}{LONE}"), {**t(f"Bold {PAY}"), "marks": [{"type": "bold"}]}]},
        # #1457 / #1420 — a mention's label and a link's ADDRESS (a relationship target, not text).
        {"type": "paragraph", "content": [
            {"type": "mention", "attrs": {"id": "1", "label": f"Men {PAY}"}},
            {**t(f"Link {PAY}"), "marks": [{"type": "link", "attrs": {"href": f"https://x.example/{PAY}"}}]},
        ]},
        {"type": "heading", "attrs": {"level": 2}, "content": [t(f"Head {PAY}")]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [t(f"Bullet {PAY}")]}]},
        {"type": "orderedList", "content": [{"type": "listItem", "content": [t(f"Numbered {PAY}")]}]},
        {"type": "blockquote", "content": [t(f"Quote {PAY}")]},
        {"type": "excerpt-embed", "attrs": {"displayText": f"Excerpt {PAY}", "sourceContext": f"Src {PAY}", **tag}},
        {"type": "chart-embed", "attrs": {"materialId": 5, "title": f"Chart {PAY}", **tag}},
        {"type": "memo-embed", "attrs": {"numericId": 1, "title": f"MemoT {PAY}", "preview": f"Preview {PAY}", **tag}},
        {"type": "callout-stat", "attrs": {"value": f"Val {PAY}", "label": f"Lab {PAY}", "sourceDescription": f"SD {PAY}", **tag}},
        {"type": "image-embed", "attrs": {"imageId": "", "alt": f"Alt {PAY}", **tag}},
        {"type": "joint-display", "attrs": {"displayKey": "k-1", "display": {"title": f"JD {PAY}"}}},
        {"type": "unknownWrapper", "content": [{"type": "paragraph", "content": [t(f"Nested {PAY}")]}]},
    ]})
    db.flush()
    return p, get_canvas_full(db, p.id, c.id)


def _docx_texts(buf) -> set[str]:
    doc = Document(buf)
    texts = {para.text for para in doc.paragraphs}
    for table in doc.tables:
        for row in table.rows:
            texts.update(cell.text for cell in row.cells)
    return texts


#: A joint display's report (D174) with a payload in EVERY string it carries.
_DISPLAY = DisplayTable(
    title=f"DT {PAY}{LONE}",
    headers=[f"DH {PAY}", "B"],
    rows=[[f"DC {PAY}", "x"], [f"DS {PAY}"]],
    span_rows=frozenset({1}),
    note=f"DN {PAY}",
    appendix=[DisplayAppendix(title=f"AT {PAY}", headers=[f"AH {PAY}"], rows=[[f"AC {PAY}"]], note=f"AN {PAY}")],
)


def test_the_canvas_word_export_writes_every_string_cleaned(db_session):
    p, canvas = _polluted_canvas(db_session)
    tables = {5: ChartTable(headers=[f"H {PAY}{LONE}", "n"], rows=[[f"Cell {PAY}{LONE}", "3"]], note=f"CN {PAY}{LONE}")}
    buf = export_canvas_docx(canvas, p.id, None, tables, {"k-1": _DISPLAY})
    texts = _docx_texts(buf)
    buf.seek(0)
    addresses = {r.target_ref for r in Document(buf).part.rels.values() if r.reltype.endswith("/hyperlink")}
    assert addresses == {f"https://x.example/{CLEAN}"}
    want = {
        f"DT {CLEAN}", f"DH {CLEAN}", f"DC {CLEAN}", f"DS {CLEAN}", f"DN {CLEAN}",
        f"AT {CLEAN}", f"AH {CLEAN}", f"AC {CLEAN}", f"AN {CLEAN}",
        f"Canvas {CLEAN}", f"Theme {CLEAN}", f"Child {CLEAN}",
        f"Para {CLEAN}Bold {CLEAN}", f"@Men {CLEAN}Link {CLEAN}", f"Head {CLEAN}", f"Bullet {CLEAN}", f"Numbered {CLEAN}",
        f"Quote {CLEAN}", f"“Excerpt {CLEAN}”\n— Src {CLEAN}", f"Tag: Tag {CLEAN}",
        f"Chart {CLEAN}", f"H {CLEAN}", f"Cell {CLEAN}", f"CN {CLEAN}", f"Memo M-1: MemoT {CLEAN}", f"Preview {CLEAN}",
        f"Val {CLEAN} Lab {CLEAN}", f"SD {CLEAN}", f"Alt {CLEAN}", f"Nested {CLEAN}",
        f"Theme {CLEAN} → Child {CLEAN}: supports · Rel {CLEAN}",
    }
    assert want <= texts, want - texts


def test_the_word_export_never_writes_a_cleaned_value_back(db_session):
    """The router COMMITS after the export: a cleaned name assigned back to the
    canvas would be written into the researcher's project."""
    p, canvas = _polluted_canvas(db_session)
    export_canvas_docx(canvas, p.id, None, None)
    assert canvas.name == f"Canvas {PAY}"
    assert {t.name for t in canvas.themes} == {f"Theme {PAY}", f"Child {PAY}"}
    assert not db_session.dirty


# ── 3d. The REFI-QDA codebook (.qdc): ElementTree fails SILENTLY ─────────────


def test_the_qdc_codebook_is_well_formed_and_reads_back(db_session):
    db = db_session
    p = Project(name="Q", user_id=1)
    db.add(p)
    db.flush()
    db.add(CodeCategory(id=81, project_id=p.id, name=f"Cat {PAY}", display_order=0))
    db.flush()
    db.add(Code(project_id=p.id, numeric_id=1, name=f"Code {PAY}", description=f"Desc {PAY}",
                is_active=True, category_id=81))
    db.flush()
    xml = export_codebook_qdc(db, p.id)
    fromstring(xml.encode("utf-8"))  # HEAD: ParseError — a file nothing opens
    q = Project(name="Q2", user_id=1)
    db.add(q)
    db.flush()
    import_codebook_qdc(db, q.id, xml)
    db.flush()
    names = {c.name for c in db.query(Code).filter(Code.project_id == q.id)}
    descs = {c.description for c in db.query(Code).filter(Code.project_id == q.id)}
    assert "Code P QRS" in names  # a name is one line
    assert f"Desc {CLEAN}" in descs


# ── 4. The Word endpoint, entered through HTTP ───────────────────────────────


@pytest.fixture()
def client():
    Base.metadata.create_all(bind=engine)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    db = SessionLocal()
    try:
        for table in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()
    finally:
        db.close()


def test_the_word_endpoint_answers_200_for_a_control_character(client):
    headers = {"X-CSRF-Token": client.get("/api/auth/status").json()["user"]["csrf_token"]}
    pid = client.post("/api/projects", json={"name": "P"}, headers=headers).json()["id"]
    db = SessionLocal()
    try:
        c = create_canvas(db, pid, "C")
        t = create_theme(db, c.id, "Findings")
        t.content = json.dumps({"type": "doc", "content": [
            {"type": "excerpt-embed", "attrs": {"displayText": "first\x0bsecond"}},
            {"type": "chart-embed", "attrs": {"materialId": 5, "title": "Q1", "config": "{}"}},
        ]})
        db.commit()
        cid = c.id
    finally:
        db.close()
    # json.dumps escapes the lone surrogate, exactly as a browser's JSON.stringify does.
    body = json.dumps({"chart_tables": {"5": {"headers": ["Answer", "n"], "rows": [[f"line one\x0bline two{LONE}", "3"]]}}})
    resp = client.post(
        f"/api/projects/{pid}/canvases/{cid}/export-docx", content=body.encode("ascii"),
        headers={**headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 200, resp.text
    texts = _docx_texts(io.BytesIO(resp.content))
    assert {"“first\nsecond”", "line one\nline two"} <= texts
