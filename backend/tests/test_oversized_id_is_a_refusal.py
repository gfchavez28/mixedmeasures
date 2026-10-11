"""#1128 — an id past SQLite's 64-bit range is a 400, not a 500.

FastAPI's `int` is unbounded and SQLite's INTEGER is not, so binding ``10**30``
raises ``OverflowError: Python int too large to convert to SQLite INTEGER`` from the
C driver — bare, not wrapped by SQLAlchemy — and every endpoint answered 500.

**One handler, not an annotation per parameter** (measured 2026-10-11b): 601 int path
parameters, 44 int query parameters, 86 comma-separated ``*_ids`` query parameters
no `int` type can bound, 145 id-named body fields, Form fields and tagged tokens —
an `Annotated` id type would be ~790 edits and still miss most of them. The handler
in `main.py` keys on the driver's EXACT message, which no other `OverflowError`
carries (float conversion, `math`, timestamps, C ints — all measured), so an
arithmetic overflow stays a 500.

⚠️ **These tests go through HTTP.** Direct-call tests bypass FastAPI's exception
handlers, which is where the fix lives.
"""

import sqlite3

import pytest
from sqlalchemy import Column, Integer, create_engine, select
from sqlalchemy.orm import declarative_base
from sqlalchemy import text
from starlette.testclient import TestClient

from app import main as app_main
from app.database import Base, SessionLocal, engine
from app.main import app

BIG = 10 ** 30


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
        for t in ("codes", "audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {t}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def session(client):
    """A project and the CSRF header a write needs."""
    status = client.get("/api/auth/status")
    headers = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
    resp = client.post("/api/projects", json={"name": "Ids"}, headers=headers)
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"], headers


def _refused(resp) -> None:
    assert resp.status_code == 400, f"{resp.status_code}: {resp.text}"
    assert resp.json() == {"detail": app_main.OVERSIZED_ID_DETAIL}


class TestEveryWayAnIdArrives:
    def test_a_PATH_id(self, client, session):
        _refused(client.get(f"/api/projects/{BIG}"))

    def test_a_negative_one(self, client, session):
        _refused(client.get(f"/api/projects/-{BIG}"))

    def test_the_first_value_past_the_range(self, client, session):
        """2**63 is the first that raises; 2**63 - 1 is a legal id that matches nothing."""
        _refused(client.get(f"/api/projects/{2 ** 63}"))
        assert client.get(f"/api/projects/{2 ** 63 - 1}").status_code == 404

    def test_a_QUERY_id(self, client, session):
        pid, _ = session
        _refused(client.get(f"/api/projects/{pid}/codes", params={"category_id": BIG}))

    def test_a_comma_separated_id_LIST(self, client, session):
        """86 parameters arrive like this, parsed by `parse_int_list` — no `int`
        annotation could have bounded them."""
        pid, _ = session
        _refused(client.get(f"/api/projects/{pid}/excerpts/starred", params={"code_ids": f"1,{BIG}"}))

    def test_a_BODY_id(self, client, session):
        pid, headers = session
        _refused(client.post(
            f"/api/projects/{pid}/codes", json={"name": "Trust", "category_id": BIG}, headers=headers,
        ))

    def test_a_SYNC_route(self, client, session):
        """A `def` route runs in the threadpool; the handler still sees its exception."""
        _refused(client.get(f"/api/projects/{BIG}/code-analysis/irr"))


class TestOnlyTheDriversOverflowIsMapped:
    @pytest.mark.parametrize("message", [
        "int too large to convert to float",
        "math range error",
        "cannot convert float infinity to integer",
        "timestamp out of range for platform time_t",
        "Python int too large to convert to C long",
    ])
    def test_an_arithmetic_overflow_is_RE_RAISED(self, message):
        """A real bug must stay a 500 — mapping it to "your request" would hide it."""
        import asyncio

        exc = OverflowError(message)
        with pytest.raises(OverflowError) as raised:
            asyncio.run(app_main._oversized_id_handler(None, exc))
        assert raised.value is exc

    def test_the_canary_the_DRIVER_still_says_what_the_handler_reads(self):
        """The handler keys on a string the C driver writes. If a Python or sqlite
        upgrade rewords it, the 400 silently becomes a 500 again — this fails first."""
        Model = declarative_base()

        class Row(Model):
            __tablename__ = "row"
            id = Column(Integer, primary_key=True)

        e = create_engine("sqlite://")
        Model.metadata.create_all(e)
        with e.connect() as conn, pytest.raises(OverflowError) as exc:
            conn.execute(select(Row).where(Row.id == 2 ** 63))
        assert str(exc.value) == app_main.SQLITE_INTEGER_OVERFLOW_MESSAGE
        with pytest.raises(OverflowError) as raw:
            sqlite3.connect(":memory:").execute("select ?", (2 ** 63,))
        assert str(raw.value) == app_main.SQLITE_INTEGER_OVERFLOW_MESSAGE
