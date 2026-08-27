"""Foreign-tool interoperability for REFI-QDA codebook exchange (#760).

⚠️ Every OTHER `.qdc` test in this suite calls ``import_codebook_qdc()`` directly,
so the ROUTER's decode-and-sniff — where a foreign tool's encoding actually
lands — had never been exercised. That is the #633 shape repeating: the guard and
the defect shared an assumption, because every fixture was MM's own output. This
file exists to hold checks driven by what OTHER TOOLS really emit.

**QualCoder writes its codebook with a BOM.** ``src/qualcoder/refi.py::export_codebook``
opens the file with ``encoding='utf-8-sig'``, so byte 0 of every QualCoder `.qdc`
is ``EF BB BF``. Decoding those bytes as plain ``utf-8`` leaves ``\\ufeff`` at the
head of the string, and **Python's ``str.lstrip()`` does not strip U+FEFF** (it is
not whitespace by ``str.isspace()``) — so the XML sniff misses, the file falls to
the JSON branch, and the endpoint answers **400 "Unexpected UTF-8 BOM"**: an XML
file rejected with a JSON diagnosis. The parser itself is blameless; it accepts a
BOM-bearing string fine. The bug is entirely in detection.
"""
from pathlib import Path

import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base

QDC_NS = "urn:QDA-XML:codebook:1.0"
_REF = Path(__file__).parent / "reference_data"
FIXTURE = _REF / "qualcoder-3.8.2-codebook.qdc"
TAGUETTE_FIXTURE = _REF / "taguette-1.4.1-codebook.qdc"

# Shaped like QualCoder's own emission: namespaced root, an `origin` naming the
# producing tool, a nested child code, colours and a description.
FOREIGN_QDC = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    f'<CodeBook xmlns="{QDC_NS}" origin="QualCoder 3.8.2">\n'
    "  <Codes>\n"
    '    <Code guid="6b6f6c62-1111-4a2b-8c3d-000000000001" name="Access barriers"'
    ' isCodable="true" color="#E06C75">\n'
    "      <Description>Things that stopped families enrolling.</Description>\n"
    '      <Code guid="6b6f6c62-1111-4a2b-8c3d-000000000002" name="Transport"'
    ' isCodable="true" color="#61AFEF"/>\n'
    "    </Code>\n"
    "  </Codes>\n"
    "</CodeBook>\n"
)


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
        for t in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {t}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _csrf(client: TestClient) -> str:
    resp = client.get("/api/auth/status")
    assert resp.status_code == 200, resp.text
    return resp.json()["user"]["csrf_token"]


def _new_project(client: TestClient, csrf: str) -> int:
    resp = client.post(
        "/api/projects", json={"name": "REFI interop"}, headers={"X-CSRF-Token": csrf}
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def _post_codebook(client: TestClient, csrf: str, pid: int, payload: bytes):
    return client.post(
        f"/api/projects/{pid}/import-codebook",
        files={"file": ("Codebook-foreign.qdc", payload, "text/xml")},
        headers={"X-CSRF-Token": csrf},
    )


class TestForeignCodebookEncodings:
    """A foreign `.qdc` must import regardless of how the producing tool encoded it."""

    @pytest.mark.parametrize(
        "encoding, label",
        [
            ("utf-8", "no BOM (MM's own emission)"),
            ("utf-8-sig", "BOM (QualCoder's emission)"),
        ],
    )
    def test_qdc_imports_through_the_endpoint(self, client, encoding, label):
        csrf = _csrf(client)
        pid = _new_project(client, csrf)

        resp = _post_codebook(client, csrf, pid, FOREIGN_QDC.encode(encoding))

        assert resp.status_code == 200, f"{label}: {resp.status_code} {resp.text}"
        body = resp.json()
        # A foreign parent that is ITSELF codable (isCodable="true" with
        # children) legitimately lands as BOTH a category and a code — MM logs
        # that choice. So: 1 category ("Access barriers" as a container) and 2
        # codes ("Access barriers", "Transport").
        assert body["categories_created"] == 1, f"{label}: {body}"
        assert body["codes_created"] == 2, f"{label}: {body}"

    def test_bom_and_no_bom_are_indistinguishable(self, client):
        """The actual interop claim: the BOM must change NOTHING about the outcome.

        Stronger than the per-encoding assertions above, which could both be
        satisfied while the two paths still diverged in some field.
        """
        csrf = _csrf(client)

        results = {}
        for encoding in ("utf-8", "utf-8-sig"):
            pid = _new_project(client, csrf)
            resp = _post_codebook(client, csrf, pid, FOREIGN_QDC.encode(encoding))
            assert resp.status_code == 200, f"{encoding}: {resp.text}"
            results[encoding] = resp.json()

        assert results["utf-8"] == results["utf-8-sig"], results

    def test_real_qualcoder_export_imports(self, client):
        """The #760 deliverable: a genuinely FOREIGN artifact, not our own output.

        `reference_data/qualcoder-3.8.2-codebook.qdc` is a real QualCoder 3.8.2
        export, produced by round-tripping MM's own Ferncrest codebook through
        the GUI on 2026-08-16 (38 elements in, 38 out). #633 lived four months
        precisely because every fixture was MM's own emission — a check that
        reads only our side cannot fail on a misreading of the spec.
        """
        payload = FIXTURE.read_bytes()

        # Guard the FIXTURE, not just the code: the BOM is why this file has
        # value, and a well-meant "cleanup" that re-saved it as plain UTF-8
        # would silently retire the regression while every test stayed green.
        assert payload[:3] == b"\xef\xbb\xbf", "fixture lost its BOM — do not re-save it"

        csrf = _csrf(client)
        pid = _new_project(client, csrf)
        resp = _post_codebook(client, csrf, pid, payload)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["categories_created"] == 6, body
        assert body["codes_created"] == 32, body
        assert body["codes_uncategorized"] == 0, body

    def test_real_taguette_export_imports_despite_being_schema_invalid(self, client):
        """A SECOND independent producer — and it fails differently from the first.

        `taguette-1.4.1-codebook.qdc` is a real Taguette 1.4.1 export. It shares
        almost nothing with QualCoder's emission: no BOM, no inter-element
        whitespace, self-closing empties (`XMLGenerator(short_empty_elements=True)`),
        uppercase GUIDs, no colours at all (Taguette's `Tag` model has no colour
        column) and a flat tag list with no hierarchy. That difference is the
        point: two producers make it far harder for our importer to be quietly
        depending on one tool's formatting.

        ⚠️ **It is SCHEMA-INVALID and must still import.** It emits an empty
        `<Sets/>`, but `SetsType` requires at least one `Set` (implicit
        minOccurs=1), so `lxml` rejects it: *"Missing child element(s). Expected
        is ( Set )"*. MM and QualCoder both omit the element entirely when there
        are no sets. Being liberal in what we accept is deliberate — a researcher
        migrating off Taguette should not be blocked by an empty element that
        carries no information. Do NOT "fix" this by validating imports against
        the XSD.
        """
        payload = TAGUETTE_FIXTURE.read_bytes()
        assert b"<Sets/>" in payload, "fixture lost the invalid empty Sets element"
        assert payload[:3] != b"\xef\xbb\xbf", "fixture gained a BOM it never had"

        csrf = _csrf(client)
        pid = _new_project(client, csrf)
        resp = _post_codebook(client, csrf, pid, payload)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["codes_created"] == 3, body
        assert body["categories_created"] == 0, body

    def test_bom_is_not_misreported_as_a_json_problem(self, client):
        """The failure mode this guards: an XML file rejected with a JSON diagnosis.

        Worth pinning separately from the success case — a future refactor could
        keep the import working while restoring a misleading error on some other
        malformed input.
        """
        csrf = _csrf(client)
        pid = _new_project(client, csrf)

        resp = _post_codebook(client, csrf, pid, FOREIGN_QDC.encode("utf-8-sig"))
        assert "BOM" not in resp.text, resp.text
