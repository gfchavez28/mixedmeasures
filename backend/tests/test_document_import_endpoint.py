"""#1318 — what the body walk reads reaches the researcher, through the real doors.

Nothing drove `/documents/upload-preview` or `/documents/import` end to end
before this: the service tests call `extract_text_from_docx` directly, which
proves the walk and says nothing about whether its paragraphs, its picture and
its warnings survive the router, the segmentation and the database.
"""

from io import BytesIO

import docx
import pytest
from lxml import etree
from sqlalchemy import text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from tests.test_docx_body_walk import P, PNG, R, TRACKED, W, inject, not_imported, text_box


@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _clean(_migrated_db):
    yield
    db = SessionLocal()
    try:
        for t in ("segments", "documents", "audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {t}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _interview() -> bytes:
    """Five things the old reader dropped, and two it never counted."""
    d = docx.Document()
    d.add_heading("Interview 7", level=1)
    inject(d, P(R("Participant: ") + "<w:sdt><w:sdtPr/><w:sdtContent>" + R("Maria") + "</w:sdtContent></w:sdt>"))
    inject(d, P(R("It was ") + '<w:ins w:id="1" w:author="A">' + R("very ") + "</w:ins>" + R("hard at first.")))
    d.add_picture(BytesIO(PNG))
    pic = d.element.body.findall(W + "p")[-1]
    pic_xml = etree.tostring(pic).decode()
    pic.getparent().remove(pic)
    inject(d, text_box("See the box.", pic_xml + P(R("Boxed aside.")), ""))
    t = d.add_table(rows=1, cols=1)
    t.cell(0, 0).text = "Age 34"
    p = d.add_paragraph("Closing remark.")
    d.add_comment(p.runs, text="Check consent form", author="Rev")
    buf = BytesIO()
    d.save(buf)
    return buf.getvalue()


EXPECTED_TEXT = [
    "Interview 7", "Participant: Maria", "It was very hard at first.",
    "See the box.", "Boxed aside.", "Closing remark.",
]


def test_the_preview_and_the_import_carry_what_the_walk_reads(client):
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
    headers = {"X-CSRF-Token": csrf}
    pid = client.post("/api/projects", json={"name": "Docs"}, headers=headers).json()["id"]
    body = _interview()
    warnings = [not_imported("1 table", "1 comment", tables=True), TRACKED]

    preview = client.post(
        f"/api/projects/{pid}/documents/upload-preview",
        files={"file": ("interview.docx", body, "application/octet-stream")},
        data={"segmentation_mode": "paragraph"},
        headers=headers,
    )
    assert preview.status_code == 200, preview.text
    assert [s["text"] for s in preview.json()["segments"]] == EXPECTED_TEXT
    assert preview.json()["warnings"] == warnings

    imported = client.post(
        f"/api/projects/{pid}/documents/import",
        files={"file": ("interview.docx", body, "application/octet-stream")},
        data={"segmentation_mode": "paragraph"},
        headers=headers,
    )
    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert result["error"] is None
    assert result["segment_count"] == len(EXPECTED_TEXT)
    assert result["warnings"] == warnings

    detail = client.get(f"/api/projects/{pid}/documents/{result['document_id']}")
    assert detail.status_code == 200, detail.text
    segments = detail.json()["segments"]
    assert [(s["text"], s["heading_level"]) for s in segments] == [
        (EXPECTED_TEXT[0], 1), *[(t, None) for t in EXPECTED_TEXT[1:]],
    ]
    # The picture in the text box is stored ONCE (it was three copies), after
    # the box's anchor paragraph.
    assert detail.json()["image_positions"] == [{"index": 0, "after_sequence_order": 3}]


# ── #1372: a Word file that cannot be OPENED is refused in words, at both doors ──
#
# Eleven damaged shapes, MEASURED to answer 500 at both doors before the fix.
# Eight are lxml's XMLSyntaxError (python-docx parses EVERY XML part as it opens,
# so a damaged header or comments part refuses the whole file too); three are not
# XML at all (an unreadable compression method, an encrypted member, a damaged
# deflate stream). The filed fix — one tuple entry for XMLSyntaxError — closes
# eight; the last three are the mutant's evidence that a list is the wrong shape.

import struct
import zipfile

from app.services.document_import import extract_text_from_docx

DAMAGED_SENTENCE = (
    "This file could not be read as a Word document. "
    "It may be corrupt or in an unsupported format."
)


def _plain_docx() -> bytes:
    d = docx.Document()
    p = d.add_paragraph("Hello there.")
    d.sections[0].header.paragraphs[0].text = "Head"
    d.add_comment(p.runs, text="note", author="A")
    buf = BytesIO()
    d.save(buf)
    return buf.getvalue()


def _rewrite_member(raw: bytes, member: str, fn) -> bytes:
    src = zipfile.ZipFile(BytesIO(raw))
    out = BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for info in src.infolist():
            data = src.read(info.filename)
            z.writestr(info.filename, fn(data) if info.filename == member else data)
    return out.getvalue()


def _patch_headers(raw: bytes, member: str, *, method=None, encrypted=False) -> bytes:
    """Set a member's compression method or encryption bit in BOTH zip headers."""
    b = bytearray(raw)
    lh = zipfile.ZipFile(BytesIO(raw)).getinfo(member).header_offset
    i = b.find(b"PK\x01\x02")
    while bytes(b[i + 46:i + 46 + struct.unpack("<H", b[i + 28:i + 30])[0]]) != member.encode():
        i = b.find(b"PK\x01\x02", i + 4)
    for flags_at, method_at in ((lh + 6, lh + 8), (i + 8, i + 10)):
        if method is not None:
            b[method_at:method_at + 2] = struct.pack("<H", method)
        if encrypted:
            flags = struct.unpack("<H", b[flags_at:flags_at + 2])[0] | 1
            b[flags_at:flags_at + 2] = struct.pack("<H", flags)
    return bytes(b)


def _corrupt_stream(raw: bytes, member: str) -> bytes:
    b = bytearray(raw)
    info = zipfile.ZipFile(BytesIO(raw)).getinfo(member)
    lh = info.header_offset
    n, m = struct.unpack("<HH", b[lh + 26:lh + 30])
    start = lh + 30 + n + m
    for k in range(start + 2, start + min(40, info.compress_size - 2)):
        b[k] ^= 0xFF
    return bytes(b)


def _half(data: bytes) -> bytes:
    return data[: len(data) // 2]


def _deeper_than_libxml2_allows(_data: bytes) -> bytes:
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    inner = "<w:customXml>" * 300 + "<w:p><w:r><w:t>x</w:t></w:r></w:p>" + "</w:customXml>" * 300
    return f'<?xml version="1.0"?><w:document {ns}><w:body>{inner}</w:body></w:document>'.encode()


def _damaged():
    base = _plain_docx()
    header = next(n for n in zipfile.ZipFile(BytesIO(base)).namelist() if "header" in n)
    return [
        ("document part cut short", _rewrite_member(base, "word/document.xml", _half)),
        ("content types cut short", _rewrite_member(base, "[Content_Types].xml", _half)),
        ("package relationships cut short", _rewrite_member(base, "_rels/.rels", _half)),
        ("styles part cut short", _rewrite_member(base, "word/styles.xml", _half)),
        ("header part cut short", _rewrite_member(base, header, _half)),
        ("comments part cut short", _rewrite_member(base, "word/comments.xml", _half)),
        ("deeper than 256 levels", _rewrite_member(base, "word/document.xml", _deeper_than_libxml2_allows)),
        ("undeclared namespace prefix", _rewrite_member(
            base, "word/document.xml", lambda d: d.replace(b"<w:body>", b"<w:body><x:y/>", 1))),
        ("unsupported compression method", _patch_headers(base, "word/document.xml", method=9)),
        ("member flagged encrypted", _patch_headers(base, "word/document.xml", encrypted=True)),
        ("damaged compressed stream", _corrupt_stream(base, "word/document.xml")),
    ]


@pytest.mark.parametrize("label, body", _damaged(), ids=[d[0] for d in _damaged()])
def test_a_damaged_word_file_is_refused_in_words(label, body):
    with pytest.raises(ValueError, match="could not be read as a Word document"):
        extract_text_from_docx(body)


def test_both_doors_refuse_a_damaged_word_file_in_words(client):
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
    headers = {"X-CSRF-Token": csrf}
    pid = client.post("/api/projects", json={"name": "Docs"}, headers=headers).json()["id"]
    for label, body in _damaged():
        preview = client.post(
            f"/api/projects/{pid}/documents/upload-preview",
            files={"file": ("damaged.docx", body, "application/octet-stream")},
            data={"segmentation_mode": "paragraph"}, headers=headers,
        )
        assert (preview.status_code, preview.json()["detail"]) == (422, DAMAGED_SENTENCE), label
        imported = client.post(
            f"/api/projects/{pid}/documents/import",
            files={"file": ("damaged.docx", body, "application/octet-stream")},
            data={"segmentation_mode": "paragraph"}, headers=headers,
        )
        assert imported.status_code == 200, label
        assert imported.json()["error"] == DAMAGED_SENTENCE, label
    # nothing was stored for any of them
    assert client.get(f"/api/projects/{pid}/documents").json() == []


def test_the_control_an_intact_file_still_imports():
    assert [p.text for p in extract_text_from_docx(_plain_docx()).paragraphs] == ["Hello there."]
