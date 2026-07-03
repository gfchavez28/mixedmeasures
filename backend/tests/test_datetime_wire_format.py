"""Response-layer regression tests for #408: datetime wire format.

ORM DateTime columns store naive UTC. Serialized offset-less, the frontend's
`new Date()` parses the UTC clock time as LOCAL time, so every rendered date
shows the UTC calendar day ("imported tomorrow" for evening UTC-negative
users). `app.schemas.common.UTCTimestamp` serializes timestamp fields with an
explicit +00:00 offset at the JSON boundary; raw-dict endpoints route through
`utc_wire` directly.

`conversation_date` is deliberately exempt: it is a user-entered calendar
date with no time-of-day meaning, and shifting it to the viewer's timezone
would move it across midnight.

Wire-format flips need coverage at the HTTP response layer, not the service
layer (a service-level test can pass while the wire still emits the old
format).
"""
import re

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from datetime import datetime

from app.main import app
from app.database import engine, SessionLocal, Base
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.note import Note

ISO_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
UTC_OFFSET_RE = re.compile(r"(Z|[+-]\d{2}:\d{2})$")

# Calendar-date fields: naive on the wire by design (see module docstring).
CALENDAR_DATE_KEYS = {"conversation_date"}


@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM audit_entries"))
        db.execute(text("DELETE FROM sessions"))
        db.execute(text("DELETE FROM projects"))
        db.execute(text("DELETE FROM users"))
        db.commit()
    finally:
        db.close()


def _bootstrap(client):
    """Auto-provision the local coder, create a project; return (pid, csrf headers)."""
    status = client.get("/api/auth/status")
    assert status.status_code == 200
    headers = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
    resp = client.post("/api/projects", json={"name": "Wire format"}, headers=headers)
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"], headers


def _orm_create_conversation(pid, name, conversation_date=None):
    """Conversations are only created via CSV import (multipart); ORM-create
    one directly — the StaticPool :memory: engine is shared with TestClient."""
    db = SessionLocal()
    try:
        conv = Conversation(project_id=pid, name=name, conversation_date=conversation_date)
        db.add(conv)
        db.commit()
        return conv.id
    finally:
        db.close()


def _iter_strings(obj, key=None):
    """Yield (nearest dict key, value) for every string in a JSON payload."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _iter_strings(v, k)
    elif isinstance(obj, list):
        for item in obj:
            yield from _iter_strings(item, key)
    elif isinstance(obj, str):
        yield key, obj


def test_timestamps_carry_utc_offset_across_endpoints(client):
    """Every ISO-datetime string on the wire carries an explicit offset,
    except calendar-date fields, which must stay naive."""
    pid, headers = _bootstrap(client)

    cid = _orm_create_conversation(pid, "Kickoff", datetime(2026, 3, 5))

    assert client.post(
        f"/api/projects/{pid}/codes", json={"name": "Theme A"}, headers=headers
    ).status_code in (200, 201)
    assert client.post(
        f"/api/projects/{pid}/memos",
        json={"entity_type": "project", "entity_id": pid, "content": "memo body"},
        headers=headers,
    ).status_code in (200, 201)

    endpoints = [
        "/api/projects",
        f"/api/projects/{pid}",
        f"/api/projects/{pid}/conversations",
        f"/api/projects/{pid}/conversations/{cid}",
        f"/api/projects/{pid}/codes",
        f"/api/projects/{pid}/memos",
    ]
    timestamps_seen = 0
    for endpoint in endpoints:
        resp = client.get(endpoint)
        assert resp.status_code == 200, endpoint
        for key, value in _iter_strings(resp.json()):
            if not ISO_DATETIME_RE.match(value):
                continue
            if key in CALENDAR_DATE_KEYS:
                assert not UTC_OFFSET_RE.search(value), (
                    f"{endpoint}: calendar-date field {key!r} must stay naive, got {value!r}"
                )
                continue
            timestamps_seen += 1
            assert UTC_OFFSET_RE.search(value), (
                f"{endpoint}: timestamp field {key!r} serialized offset-less: {value!r}"
            )
    # Guard against the walk silently matching nothing.
    assert timestamps_seen >= 8


def test_conversation_date_is_calendar_stable(client):
    """A user-entered conversation date round-trips as the same calendar day."""
    pid, _headers = _bootstrap(client)
    cid = _orm_create_conversation(pid, "Dated", datetime(2026, 3, 5))

    data = client.get(f"/api/projects/{pid}/conversations/{cid}").json()
    assert data["conversation_date"].startswith("2026-03-05T00:00:00")
    assert not UTC_OFFSET_RE.search(data["conversation_date"])
    assert UTC_OFFSET_RE.search(data["created_at"])


def test_document_note_raw_dict_carries_offset(client):
    """documents.py note endpoints build raw dicts (no response_model) —
    they must route datetimes through utc_wire."""
    pid, headers = _bootstrap(client)

    db = SessionLocal()
    try:
        doc = Document(
            project_id=pid,
            name="Field notes",
            source_filename="notes.txt",
            source_format="txt",
        )
        db.add(doc)
        db.flush()
        note = Note(document_id=doc.id, content="margin note", sequence_number=0)
        db.add(note)
        db.commit()
        doc_id = doc.id
    finally:
        db.close()

    notes = client.get(f"/api/projects/{pid}/documents/{doc_id}/notes")
    assert notes.status_code == 200
    payload = notes.json()
    assert len(payload) == 1
    assert UTC_OFFSET_RE.search(payload[0]["created_at"]), payload[0]["created_at"]
    assert UTC_OFFSET_RE.search(payload[0]["updated_at"]), payload[0]["updated_at"]


# ── #513: human-facing Excel timestamp cells must localize ───────────────────

def test_excel_export_has_no_unwrapped_strftime():
    """#513 fail-closed source scan: every ``.strftime(`` in export_excel.py
    must be wrapped in ``local_wall_time`` (localized #408 wall time) or be one
    of the two legitimate exceptions — ``datetime.now()`` (already local, used
    in filenames) and ``conversation_date`` (the #408 naive-calendar carve-out).
    Notes/Audit-Trail/Metrics "Computed At" previously emitted raw naive UTC,
    disagreeing with the localized Codebook/Memos cells in the same workbook.
    """
    from pathlib import Path
    import app.routers.export_excel as mod

    src = Path(mod.__file__).read_text(encoding="utf-8")
    offenders = []
    for lineno, line in enumerate(src.splitlines(), start=1):
        if ".strftime(" not in line:
            continue
        if "local_wall_time" in line:
            continue
        if "datetime.now()" in line or "conversation_date" in line:
            continue
        offenders.append(f"export_excel.py:{lineno}: {line.strip()}")
    assert not offenders, (
        "unlocalized .strftime( on a (naive-UTC) datetime in a human-facing "
        "Excel cell — route through local_wall_time (#408/#513):\n"
        + "\n".join(offenders)
    )


def test_local_wall_time_localizes_and_keeps_format():
    """local_wall_time converts naive UTC to the local wall clock; the optional
    fmt arg (audit trail keeps seconds) must not bypass the conversion."""
    from datetime import timezone as _tz
    from app.routers.export_helpers import local_wall_time

    naive_utc = datetime(2026, 7, 3, 5, 12, 34)
    expected_minute = (
        naive_utc.replace(tzinfo=_tz.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    )
    expected_second = (
        naive_utc.replace(tzinfo=_tz.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    )
    assert local_wall_time(naive_utc) == expected_minute
    assert local_wall_time(naive_utc, "%Y-%m-%d %H:%M:%S") == expected_second
