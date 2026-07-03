import os
# SAFETY: Must be set BEFORE any app module is imported.
# Importing app.database creates a module-level engine connected to
# settings.mm_database_path. Without this, that engine points at the
# real dev.db — the production database is live in the test process.
os.environ["MM_DATABASE_PATH"] = ":memory:"

import csv
import pytest
from datetime import datetime, timezone
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request
from app.database import Base


# ── Rate-limited router test helper ──────────────────────────────────────────
#
# slowapi's @limiter.limit decorator inspects function parameters for a
# Request instance and reads request.client.host to key the rate limit. Tests
# that call router functions directly via asyncio.run() (the _run helper used
# in test_analysis_domain_cross_dataset_pairing.py, test_equivalence_1to1.py,
# test_recode.py, and test_equivalence_swap.py) bypass FastAPI's dependency
# injection, so they need to pass a hand-built Request to satisfy the
# decorator.
#
# In test mode the limiter is disabled — main.py:150 sets
# auth.limiter.enabled = False when MM_DATABASE_PATH starts with ':memory:'.
# So the decorator is effectively a passthrough; this helper just provides the
# bare minimum ASGI scope so the decorator's `request.client.host` lookup
# doesn't crash when it inspects the signature.
#
# Added by Tier 3 Session B per directive Task 1.2 Revision 5 rate-limiting
# resolution.

def mock_request(client_host: str = "127.0.0.1") -> Request:
    """Build a minimal Starlette Request for direct-call rate-limited router tests.

    Usage: `_run(swap(request=mock_request(), project_id=..., ...))`

    **Intentional minimalism** (Session B reviewer note): returns a Request
    with an empty ASGI scope sufficient for slowapi's `get_remote_address`
    key function to read `request.client.host`. It is NOT a general-purpose
    Request factory — do NOT use it for tests that need:
      - Authentication headers. The route's `get_current_user` dependency
        is bypassed entirely by the `_run(coro)` direct-call pattern (tests
        pass a real `user` kwarg instead), so auth-header tests must use
        TestClient.
      - Query parameters (empty `query_string=b""`).
      - Request body bytes (pass body data via the schema arg, not via Request).
      - Multi-part form data.
      - Cookies or session state.
      - Real middleware chain (Starlette middleware isn't run).
      - `state` dict for app-level state injection.

    If a future test needs any of the above, either extend this helper
    carefully (add parameters, keep defaults minimal), build a one-off
    Request in the test file, or switch to TestClient for that specific
    test. Do NOT silently widen the default scope — other tests rely on
    the minimal shape as a signal that they're using the direct-call-plus-
    mock-request pattern, not the FastAPI dependency injection path.
    """
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [],
        "client": (client_host, 0),
        "query_string": b"",
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)

# Import ALL models so metadata is populated for create_all().
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.recode import RecodeDefinition
from app.models.participant import Participant
from app.models.equivalence_group import EquivalenceGroup
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.code_category import CodeCategory
from app.models.metric import MetricDefinition, ComputedResult
from app.models.statistical_test import StatisticalTest
from app.models.row_score import RowScore
from app.models.user import User
from app.models.canvas import Canvas, CanvasTheme, CanvasThemeRelationship
from app.models.materials import MaterialCollection, Material

# ── Inline mtcars data (32 rows) ──────────────────────────────────────────

MTCARS = [
    {"car": "Mazda RX4", "mpg": 21.0, "cyl": 6, "disp": 160.0, "hp": 110, "wt": 2.620, "am": 1},
    {"car": "Mazda RX4 Wag", "mpg": 21.0, "cyl": 6, "disp": 160.0, "hp": 110, "wt": 2.875, "am": 1},
    {"car": "Datsun 710", "mpg": 22.8, "cyl": 4, "disp": 108.0, "hp": 93, "wt": 2.320, "am": 1},
    {"car": "Hornet 4 Drive", "mpg": 21.4, "cyl": 6, "disp": 258.0, "hp": 110, "wt": 3.215, "am": 0},
    {"car": "Hornet Sportabout", "mpg": 18.7, "cyl": 8, "disp": 360.0, "hp": 175, "wt": 3.440, "am": 0},
    {"car": "Valiant", "mpg": 18.1, "cyl": 6, "disp": 225.0, "hp": 105, "wt": 3.460, "am": 0},
    {"car": "Duster 360", "mpg": 14.3, "cyl": 8, "disp": 360.0, "hp": 245, "wt": 3.570, "am": 0},
    {"car": "Merc 240D", "mpg": 24.4, "cyl": 4, "disp": 146.7, "hp": 62, "wt": 3.190, "am": 0},
    {"car": "Merc 230", "mpg": 22.8, "cyl": 4, "disp": 140.8, "hp": 95, "wt": 3.150, "am": 0},
    {"car": "Merc 280", "mpg": 19.2, "cyl": 6, "disp": 167.6, "hp": 123, "wt": 3.440, "am": 0},
    {"car": "Merc 280C", "mpg": 17.8, "cyl": 6, "disp": 167.6, "hp": 123, "wt": 3.440, "am": 0},
    {"car": "Merc 450SE", "mpg": 16.4, "cyl": 8, "disp": 275.8, "hp": 180, "wt": 4.070, "am": 0},
    {"car": "Merc 450SL", "mpg": 17.3, "cyl": 8, "disp": 275.8, "hp": 180, "wt": 3.730, "am": 0},
    {"car": "Merc 450SLC", "mpg": 15.2, "cyl": 8, "disp": 275.8, "hp": 180, "wt": 3.780, "am": 0},
    {"car": "Cadillac Fleetwood", "mpg": 10.4, "cyl": 8, "disp": 472.0, "hp": 205, "wt": 5.250, "am": 0},
    {"car": "Lincoln Continental", "mpg": 10.4, "cyl": 8, "disp": 460.0, "hp": 215, "wt": 5.424, "am": 0},
    {"car": "Chrysler Imperial", "mpg": 14.7, "cyl": 8, "disp": 440.0, "hp": 230, "wt": 5.345, "am": 0},
    {"car": "Fiat 128", "mpg": 32.4, "cyl": 4, "disp": 78.7, "hp": 66, "wt": 2.200, "am": 1},
    {"car": "Honda Civic", "mpg": 30.4, "cyl": 4, "disp": 75.7, "hp": 52, "wt": 1.615, "am": 1},
    {"car": "Toyota Corolla", "mpg": 33.9, "cyl": 4, "disp": 71.1, "hp": 65, "wt": 1.835, "am": 1},
    {"car": "Toyota Corona", "mpg": 21.5, "cyl": 4, "disp": 120.1, "hp": 97, "wt": 2.465, "am": 0},
    {"car": "Dodge Challenger", "mpg": 15.5, "cyl": 8, "disp": 318.0, "hp": 150, "wt": 3.520, "am": 0},
    {"car": "AMC Javelin", "mpg": 15.2, "cyl": 8, "disp": 304.0, "hp": 150, "wt": 3.435, "am": 0},
    {"car": "Camaro Z28", "mpg": 13.3, "cyl": 8, "disp": 350.0, "hp": 245, "wt": 3.840, "am": 0},
    {"car": "Pontiac Firebird", "mpg": 19.2, "cyl": 8, "disp": 400.0, "hp": 175, "wt": 3.845, "am": 0},
    {"car": "Fiat X1-9", "mpg": 27.3, "cyl": 4, "disp": 79.0, "hp": 66, "wt": 1.935, "am": 1},
    {"car": "Porsche 914-2", "mpg": 26.0, "cyl": 4, "disp": 120.3, "hp": 91, "wt": 2.140, "am": 1},
    {"car": "Lotus Europa", "mpg": 30.4, "cyl": 4, "disp": 95.1, "hp": 113, "wt": 1.513, "am": 1},
    {"car": "Ford Pantera L", "mpg": 15.8, "cyl": 8, "disp": 351.0, "hp": 264, "wt": 3.170, "am": 1},
    {"car": "Ferrari Dino", "mpg": 19.7, "cyl": 6, "disp": 145.0, "hp": 175, "wt": 2.770, "am": 1},
    {"car": "Maserati Bora", "mpg": 15.0, "cyl": 8, "disp": 301.0, "hp": 335, "wt": 3.570, "am": 1},
    {"car": "Volvo 142E", "mpg": 21.4, "cyl": 4, "disp": 121.0, "hp": 109, "wt": 2.780, "am": 1},
]

# ── Board 360 data (20 rows) ──────────────────────────────────────────────

NA_VALUE = "Not applicable / I don't have enough direct experience to assess"

RECODE_MAP = {
    "Excellent": 5, "Very Good": 4, "Good": 3, "Fair": 2, "Poor": 1,
}

BOARD_COL9 = [
    "Excellent", "Excellent", "Excellent", "Excellent", "Very Good",
    "Good", "Very Good", "Very Good", "Very Good", "Excellent",
    "Excellent", "Excellent", "Very Good", "Very Good", "Excellent",
    "Very Good", "Very Good", "Very Good", "Excellent", "Good",
]

BOARD_COL10 = [
    "Excellent", "Excellent", "Very Good", "Very Good", "Very Good",
    "Good", "Good", "Good", "Very Good", "Very Good",
    "Very Good", "Good", "Very Good", "Very Good", "Excellent",
    "Very Good", "Very Good", "Good", "Excellent", "Very Good",
]

BOARD_COL11 = [
    "Excellent", "Excellent", "Excellent", "Excellent", "Very Good",
    "Very Good", "Very Good", "Excellent", "Very Good", "Excellent",
    "Excellent", "Very Good", "Excellent", "Excellent", "Excellent",
    "Excellent", "Good", "Very Good", "Excellent", "Good",
]

BOARD_COL12 = [
    "Excellent", "Excellent", NA_VALUE, "Very Good", "Very Good",
    "Good", "Good", "Excellent", "Very Good", "Excellent",
    NA_VALUE, "Very Good", "Excellent", "Very Good", "Excellent",
    NA_VALUE, "Very Good", "Excellent", "Excellent", "Very Good",
]

BOARD_COL13 = [
    "Excellent", "Excellent", "Excellent", "Excellent", "Very Good",
    "Good", "Very Good", "Excellent", "Very Good", "Excellent",
    "Excellent", "Excellent", "Very Good", "Very Good", "Excellent",
    "Very Good", "Very Good", "Excellent", "Excellent", "Excellent",
]

BOARD_GENDER = [
    "Female", "", "Male", "Female", "",
    "Decline to state", "Female", "Female", "Female", "Male",
    "Female", "Decline to state", "Female", "Female", "Male",
    "Male", "Female", "Female", "", "",
]

# ── BFI constants ──────────────────────────────────────────────────────────

BFI_REVERSE_ITEMS = {"A1", "C4", "C5", "E1", "E2", "O2", "O5"}

BFI_SUBSCALES = {
    "Agreeableness":     ["A1", "A2", "A3", "A4", "A5"],
    "Conscientiousness": ["C1", "C2", "C3", "C4", "C5"],
    "Extraversion":      ["E1", "E2", "E3", "E4", "E5"],
    "Neuroticism":       ["N1", "N2", "N3", "N4", "N5"],
    "Openness":          ["O1", "O2", "O3", "O4", "O5"],
}

# ── Helper functions ───────────────────────────────────────────────────────


def _make_engine():
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    return engine


def _populate_bfi(session):
    csv_path = os.path.join(os.path.dirname(__file__), "reference_data", "bfi_dataset.csv")
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    test_user = User(id=1, username="testuser", password_hash="x", is_admin=True)
    session.add(test_user)

    project = Project(id=1, name="BFI Test", user_id=1)
    session.add(project)

    dataset = Dataset(id=1, project_id=1, name="BFI")
    session.add(dataset)

    bfi_items = [
        "A1", "A2", "A3", "A4", "A5", "C1", "C2", "C3", "C4", "C5",
        "E1", "E2", "E3", "E4", "E5", "N1", "N2", "N3", "N4", "N5",
        "O1", "O2", "O3", "O4", "O5",
    ]
    demographics = ["gender", "education", "age"]
    col_objects = {}

    for i, name in enumerate(bfi_items + demographics):
        col_type = "ordinal" if name in bfi_items else "demographic"
        col = DatasetColumn(
            id=i + 1, dataset_id=1, column_code=name,
            column_text=name, column_type=col_type,
            sequence_order=i, display_order=i,
        )
        session.add(col)
        col_objects[name] = col

    domain_objects = {}
    domain_id = 0
    for subscale_name, item_names in BFI_SUBSCALES.items():
        domain_id += 1
        domain = AnalysisDomain(
            id=domain_id, project_id=1, name=subscale_name,
        )
        session.add(domain)
        domain_objects[subscale_name] = domain

        for seq, item_name in enumerate(item_names):
            member = AnalysisDomainMember(
                domain_id=domain_id,
                member_type="column",
                member_id=col_objects[item_name].id,
                sequence_order=seq,
            )
            session.add(member)

    session.flush()

    val_id = 0
    for row_idx, row_dict in enumerate(rows):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        session.add(dr)

        for col_name in bfi_items + demographics:
            raw = row_dict[col_name]
            if raw in ("NA", ""):
                value_text = None
                value_numeric = None
            else:
                value_text = raw
                try:
                    num = float(raw)
                    if col_name in BFI_REVERSE_ITEMS:
                        value_numeric = 7.0 - num
                    else:
                        value_numeric = num
                except ValueError:
                    value_numeric = None

            val_id += 1
            dv = DatasetValue(
                id=val_id,
                row_id=dr.id,
                column_id=col_objects[col_name].id,
                value_text=value_text,
                value_numeric=value_numeric,
            )
            session.add(dv)


def _populate_mtcars(session):
    test_user = User(id=1, username="testuser", password_hash="x", is_admin=True)
    session.add(test_user)

    project = Project(id=1, name="Mtcars Test", user_id=1)
    session.add(project)

    dataset = Dataset(id=1, project_id=1, name="mtcars")
    session.add(dataset)

    numeric_cols = ["mpg", "hp", "wt", "disp"]
    grouping_cols = ["cyl", "am"]
    col_objects = {}

    for i, name in enumerate(numeric_cols):
        col = DatasetColumn(
            id=i + 1, dataset_id=1, column_code=name,
            column_name=name, column_text=name, column_type="numeric",
            sequence_order=i, display_order=i,
        )
        session.add(col)
        col_objects[name] = col

    for i, name in enumerate(grouping_cols):
        col = DatasetColumn(
            id=len(numeric_cols) + i + 1, dataset_id=1, column_code=name,
            column_name=name, column_text=name, column_type="nominal",
            sequence_order=len(numeric_cols) + i,
            display_order=len(numeric_cols) + i,
        )
        session.add(col)
        col_objects[name] = col

    session.flush()

    val_id = 0
    for row_idx, row_dict in enumerate(MTCARS):
        dr = DatasetRow(id=row_idx + 1, dataset_id=1)
        session.add(dr)

        for col_name in numeric_cols + grouping_cols:
            val = row_dict[col_name]
            val_id += 1
            dv = DatasetValue(
                id=val_id,
                row_id=dr.id,
                column_id=col_objects[col_name].id,
                value_text=str(val),
                value_numeric=float(val),
            )
            session.add(dv)


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(scope="function")
def db_session():
    engine = _make_engine()
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = Session()
    test_user = User(id=1, username="testuser", password_hash="x", is_admin=True)
    session.add(test_user)
    session.flush()
    yield session
    session.rollback()
    session.close()
    engine.dispose()


@pytest.fixture(scope="module")
def bfi_engine():
    engine = _make_engine()
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = Session()
    _populate_bfi(session)
    session.commit()
    yield engine
    session.close()
    engine.dispose()


@pytest.fixture
def bfi_session(bfi_engine):
    Session = sessionmaker(bind=bfi_engine, autocommit=False, autoflush=False)
    session = Session()
    yield session
    session.rollback()
    session.close()


@pytest.fixture(scope="module")
def mtcars_engine():
    engine = _make_engine()
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = Session()
    _populate_mtcars(session)
    session.commit()
    yield engine
    session.close()
    engine.dispose()


@pytest.fixture
def mtcars_session(mtcars_engine):
    Session = sessionmaker(bind=mtcars_engine, autocommit=False, autoflush=False)
    session = Session()
    yield session
    session.rollback()
    session.close()
