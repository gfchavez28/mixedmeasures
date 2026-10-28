"""#1362: an upgrade's statement count must not grow with the data.

`d7a2f3b8c1e9` and `e8b3c1d65a04` backfilled their uuids with one UPDATE per row,
issued through SQLAlchemy. On a 1.0 project of 400k transcript turns that was 38 s
of a 48 s upgrade (plaintext; 43 s on SQLCipher, where the whole upgrade passed the
shell's 60 s startup deadline). One statement per table does the same work in about
4-6 s, because SQLite walks each table once instead of seeking and rewriting one row
per round trip.

The guard: the whole chain, from the first release's schema to head, run on a
database holding N rows in every table those two revisions backfill, and again on 2N.
The statements issued AND the parameter sets bound must be identical — a per-row
`execute` loop moves the first, a per-row `executemany` the second. Either way it is
a migration whose cost is a Python round trip per row.

Runs on both drivers: the backfill registers a Python `uuid4()` on the migration's own
DBAPI connection, and the packaged app's driver is sqlcipher3.

⚠️ Outside this guard's population, on purpose: `af95c698c3a2` (projects),
`b3f1d9a7c2e5` (code equivalence groups) and `c6e2a8d41f97` (users) still backfill one
row at a time. Those tables hold a handful of rows in any real install, so the fixture
keeps one project, one user and no groups. A new backfill over a table that GROWS with
the research belongs in `_first_release_db`.
"""
import re
import sqlite3
from collections import Counter
from pathlib import Path

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app import config, database
from app.database import _script_only_alembic_config

KEY = "5ca1ab1e" * 8  # 64 hex characters
NOW = "2026-06-19 12:00:00"
V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

#: Every table the two backfills give a uuid — d7a2f3b8c1e9's nine, e8b3c1d65a04's five.
UUID_TABLES = (
    "conversations", "documents", "segments", "codes", "code_categories", "datasets",
    "dataset_columns", "dataset_rows", "participants",
    "speakers", "segment_groups", "notes", "memos", "excerpt",
)


@pytest.fixture(params=["plaintext", "sqlcipher"])
def key(request, tmp_path, monkeypatch):
    if request.param == "plaintext":
        return None
    pytest.importorskip("sqlcipher3", reason="sqlcipher3 driver not installed")
    monkeypatch.setenv("MM_ENCRYPTION_KEY", KEY)
    monkeypatch.setattr(
        database, "settings",
        config.Settings(mm_encryption_enabled=True, mm_database_path=str(tmp_path / "x.db")),
    )
    return KEY


def _connect(db: Path, key):
    if key is None:
        return sqlite3.connect(str(db))
    import sqlcipher3.dbapi2 as sqlcipher

    conn = sqlcipher.connect(str(db))
    conn.execute(f"PRAGMA key = \"x'{key}'\"")
    return conn


def _upgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.upgrade(cfg, revision)


def _first_release_db(db: Path, key, n: int) -> Path:
    """The baseline schema, holding `n` rows in every table the backfills touch."""
    base = ScriptDirectory.from_config(_script_only_alembic_config()).get_base()
    _upgrade(db, base)
    c = _connect(db, key)
    c.execute("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'r', '', 1, ?)", (NOW,))
    c.execute("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (1, 1, 'p', 'active', ?, ?)", (NOW, NOW))
    ids = range(1, n + 1)
    c.executemany("INSERT INTO code_categories (id, project_id, name, display_order, created_at) VALUES (?, 1, 'c', ?, ?)", [(i, i, NOW) for i in ids])
    c.executemany("INSERT INTO codes (id, project_id, numeric_id, name, is_universal, is_active, created_at, updated_at) VALUES (?, 1, ?, ?, 0, 1, ?, ?)", [(i, i, f"code {i}", NOW, NOW) for i in ids])
    c.executemany("INSERT INTO participants (id, project_id, identifier, created_at, updated_at) VALUES (?, 1, ?, ?, ?)", [(i, f"P{i}", NOW, NOW) for i in ids])
    c.executemany("INSERT INTO conversations (id, project_id, name, status, created_at, updated_at, media_offset_seconds) VALUES (?, 1, ?, 'completed', ?, ?, 0)", [(i, f"i{i}", NOW, NOW) for i in ids])
    c.executemany("INSERT INTO documents (id, project_id, name, source_filename, source_format, segmentation_mode, created_at, updated_at) VALUES (?, 1, ?, 'd.docx', 'docx', 'paragraph', ?, ?)", [(i, f"d{i}", NOW, NOW) for i in ids])
    c.executemany("INSERT INTO speakers (id, project_id, name, is_facilitator, color_index, created_at) VALUES (?, 1, ?, 0, 0, ?)", [(i, f"s{i}", NOW) for i in ids])
    c.executemany("INSERT INTO segment_groups (id, conversation_id, created_at) VALUES (?, 1, ?)", [(i, NOW) for i in ids])
    c.executemany("INSERT INTO segments (id, conversation_id, speaker_id, sequence_order, text, created_at, is_starred, is_merge_result, is_split_result) VALUES (?, 1, 1, ?, 'a turn', ?, 0, 0, 0)", [(i, i, NOW) for i in ids])
    c.execute("INSERT INTO datasets (id, project_id, name, created_at) VALUES (1, 1, 'ds', ?)", (NOW,))
    c.executemany("INSERT INTO datasets (id, project_id, name, created_at) VALUES (?, 1, 'ds', ?)", [(i, NOW) for i in range(2, n + 1)])
    c.executemany("INSERT INTO dataset_columns (id, dataset_id, column_text, column_type, sequence_order) VALUES (?, 1, 'q', 'numeric', ?)", [(i, i) for i in ids])
    c.executemany("INSERT INTO dataset_rows (id, dataset_id, participant_id, created_at) VALUES (?, 1, ?, ?)", [(i, i, NOW) for i in ids])
    c.executemany("INSERT INTO notes (id, conversation_id, segment_id, content, sequence_number, is_archived, created_at, updated_at) VALUES (?, 1, ?, 'n', ?, 0, ?, ?)", [(i, i, i, NOW, NOW) for i in ids])
    c.executemany("INSERT INTO memos (id, project_id, numeric_id, entity_type, entity_id, content, is_archived, created_at, updated_at) VALUES (?, 1, ?, 'code', 1, 'm', 0, ?, ?)", [(i, i, NOW, NOW) for i in ids])
    c.executemany("INSERT INTO excerpt (id, project_id, segment_id, created_at, updated_at) VALUES (?, 1, ?, ?, ?)", [(i, i, NOW, NOW) for i in ids])
    c.commit()
    c.close()
    return db


def _bound_work(db: Path) -> tuple[Counter, int]:
    """Upgrade to head; return the statements issued (by text) and the parameter sets bound."""
    statements: Counter = Counter()
    bound = 0

    def count(_conn, _cursor, statement, parameters, _context, executemany):
        nonlocal bound
        # Keyed on the statement's first four words ("UPDATE segments SET uuid"): a batch
        # recreate emits a table's constraints in a different order from run to run
        # (measured), which is not a difference in work, and a per-row statement repeats
        # its head however its parameters vary.
        statements[" ".join(statement.split()[:4])] += 1
        bound += len(parameters) if executemany else 1

    event.listen(Engine, "before_cursor_execute", count)
    try:
        _upgrade(db, "head")
    finally:
        event.remove(Engine, "before_cursor_execute", count)
    return statements, bound


def test_an_upgrade_from_the_first_release_does_no_per_row_round_trips(tmp_path, key):
    small = _bound_work(_first_release_db(tmp_path / "small.db", key, 20))
    large = _bound_work(_first_release_db(tmp_path / "large.db", key, 40))

    grew = {
        s: (small[0][s], large[0][s])
        for s in large[0].keys() | small[0].keys() if large[0][s] != small[0][s]
    }
    assert not grew, f"statements issued once per row: {list(grew.items())[:5]}"
    assert large[1] == small[1], f"parameter sets bound grew with the data: {small[1]} -> {large[1]}"


def test_the_backfill_still_gives_every_row_its_own_uuid4(tmp_path, key):
    """What the per-row loop produced: one distinct `str(uuid.uuid4())` per row."""
    db = _first_release_db(tmp_path / "x.db", key, 40)
    _upgrade(db, "head")
    c = _connect(db, key)
    try:
        for table in UUID_TABLES:
            values = [u for (u,) in c.execute(f"SELECT uuid FROM {table}")]
            assert len(values) == 40, table
            assert all(v is not None and V4.match(v) for v in values), table
            assert len(set(values)) == 40, table
    finally:
        c.close()
