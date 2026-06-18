"""Phase 2 (packaging P4): the raw-connect sites + alembic route through one
keyed-connection path, and wrong-key now maps to DatabaseUnreadableError.

Covers: open_raw_connection (the single key-PRAGMA chokepoint), current_database_
key_hex (the alembic accessor), _get_current_revision under REAL encryption (the
Phase 0.5 guard re-verified with an actual wrong key, not just garbage bytes),
the startup probe, and the backup service's keyed project-summary read.

Encryption-path tests patch `database.settings` + set MM_ENCRYPTION_KEY and build
their own connections/engines on a temp file — the module-level engine is pinned
to :memory: (force-plaintext) by conftest.
"""
import pytest
from sqlalchemy import text

from app import config, database

SQLITE_HEADER = b"SQLite format 3\x00"
KEY = "ab" * 32      # 64 hex chars
WRONG = "cd" * 32

pytest.importorskip("sqlcipher3", reason="sqlcipher3 driver not installed")


def _make_settings(**overrides):
    base = {"mm_database_path": ":memory:"}
    base.update(overrides)
    return config.Settings(**base)


@pytest.fixture
def enc(tmp_path, monkeypatch):
    """Encryption ON, key in env, settings patched onto a temp DB path."""
    db_path = tmp_path / "enc.db"
    monkeypatch.setenv("MM_ENCRYPTION_KEY", KEY)
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=True, mm_database_path=str(db_path)),
    )
    return db_path


# --- open_raw_connection ----------------------------------------------------

def test_open_raw_connection_plaintext_when_disabled(tmp_path, monkeypatch):
    db_path = tmp_path / "plain.db"
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=False, mm_database_path=str(db_path)),
    )
    conn = database.open_raw_connection(db_path)
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.execute("INSERT INTO t VALUES ('plain')")
    conn.commit()
    conn.close()
    assert db_path.read_bytes()[:16] == SQLITE_HEADER  # plaintext header present


def test_open_raw_connection_keyed_writes_ciphertext(enc):
    conn = database.open_raw_connection(enc)
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.execute("INSERT INTO t VALUES ('secret-raw')")
    conn.commit()
    conn.close()
    raw = enc.read_bytes()
    assert raw[:16] != SQLITE_HEADER
    assert b"secret-raw" not in raw


# --- current_database_key_hex (alembic accessor) ----------------------------

def test_key_hex_none_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=False, mm_database_path=str(tmp_path / "x.db")),
    )
    assert database.current_database_key_hex() is None


def test_key_hex_none_on_memory_even_when_enabled(monkeypatch):
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=True, mm_database_path=":memory:"),
    )
    assert database.current_database_key_hex() is None


def test_key_hex_returns_key_when_enabled(enc):
    assert database.current_database_key_hex() == KEY


# --- _get_current_revision under REAL encryption (Phase 0.5 re-verify) -------

def test_revision_read_with_correct_key(enc):
    conn = database.open_raw_connection(enc)
    conn.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
    conn.execute("INSERT INTO alembic_version VALUES ('94edc0f39eba')")
    conn.commit()
    conn.close()
    assert database._get_current_revision(enc) == "94edc0f39eba"


def test_wrong_key_raises_unreadable_not_fresh(enc, monkeypatch):
    # Write a real, migrated-looking encrypted DB with the correct key...
    conn = database.open_raw_connection(enc)
    conn.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
    conn.execute("INSERT INTO alembic_version VALUES ('94edc0f39eba')")
    conn.commit()
    conn.close()
    # ...then a WRONG key must NOT read as fresh (would baseline over data).
    monkeypatch.setenv("MM_ENCRYPTION_KEY", WRONG)
    with pytest.raises(database.DatabaseUnreadableError):
        database._get_current_revision(enc)


# --- startup probe ----------------------------------------------------------

def test_probe_noop_when_disabled(monkeypatch):
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=False),
    )
    database._probe_engine_readable()  # returns silently, no engine touch


def test_probe_raises_on_wrong_key(enc, monkeypatch):
    eng = database.get_engine()
    with eng.begin() as c:
        c.execute(text("CREATE TABLE t (v TEXT)"))
    eng.dispose()
    # Install a wrong-key engine as the module engine and probe it.
    monkeypatch.setenv("MM_ENCRYPTION_KEY", WRONG)
    wrong_eng = database.get_engine()
    monkeypatch.setattr(database, "engine", wrong_eng)
    with pytest.raises(database.DatabaseUnreadableError):
        database._probe_engine_readable()
    wrong_eng.dispose()


# --- backup service reads through the keyed connection ----------------------

def test_backup_project_summaries_read_encrypted(enc):
    from app.services import backup

    conn = database.open_raw_connection(enc)
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE conversations (project_id INTEGER)")
    conn.execute("CREATE TABLE datasets (project_id INTEGER)")
    conn.execute("CREATE TABLE documents (project_id INTEGER)")
    conn.execute("INSERT INTO projects (id, name) VALUES (1, 'Encrypted Project')")
    conn.execute("INSERT INTO conversations (project_id) VALUES (1)")
    conn.commit()
    conn.close()

    summaries = backup._read_project_summaries(enc)
    assert len(summaries) == 1
    assert summaries[0].name == "Encrypted Project"
    assert summaries[0].conversation_count == 1


# --- restore DB probe under REAL encryption (Phase 4) -----------------------

def test_backup_db_probe_passes_with_correct_key(enc):
    """_assert_backup_db_readable accepts a decryptable, intact encrypted DB."""
    from app.services import backup

    conn = database.open_raw_connection(enc)
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.execute("INSERT INTO t VALUES ('ok')")
    conn.commit()
    conn.close()

    backup._assert_backup_db_readable(enc)  # must not raise


def test_backup_db_probe_rejects_wrong_key(enc, monkeypatch):
    """A backup encrypted under one key, probed with another (the cross-machine /
    foreign-backup case), is rejected with the distinct "could not be opened"
    message — proving the SQLCipher first-read raise is mapped, not surfaced raw."""
    from app.services import backup

    conn = database.open_raw_connection(enc)
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.execute("INSERT INTO t VALUES ('secret')")
    conn.commit()
    conn.close()

    monkeypatch.setenv("MM_ENCRYPTION_KEY", WRONG)
    with pytest.raises(ValueError, match="could not be opened"):
        backup._assert_backup_db_readable(enc)


# --- full encrypted backup → restore pipeline (Phase 6, gaps A + B) ----------

def _seed_encrypted_db(db_path, project_names=("Alpha",)):
    """Create the tables _read_project_summaries needs + seed projects, keyed."""
    conn = database.open_raw_connection(db_path)
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE conversations (project_id INTEGER)")
    conn.execute("CREATE TABLE datasets (project_id INTEGER)")
    conn.execute("CREATE TABLE documents (project_id INTEGER)")
    for i, name in enumerate(project_names, start=1):
        conn.execute("INSERT INTO projects (id, name) VALUES (?, ?)", (i, name))
    conn.commit()
    conn.close()


def test_encrypted_backup_restore_round_trip(enc, tmp_path):
    """Gap A: the whole create_backup → restore_from_backup pipeline works under
    encryption end-to-end — restore reverts the live DB to the backup state, and
    the restored file is still ciphertext readable with the same key."""
    from app.services import backup

    docs = tmp_path / "documents"; docs.mkdir()
    media = tmp_path / "media"
    backups = tmp_path / "backups"
    _seed_encrypted_db(enc)

    info = backup.create_backup(enc, docs, media, backups, "manual")

    # Mutate the live DB after the backup was taken.
    conn = database.open_raw_connection(enc)
    conn.execute("INSERT INTO projects (id, name) VALUES (99, 'ShouldVanish')")
    conn.commit()
    conn.close()

    backup.restore_from_backup(backups / info.filename, enc, docs, media, backups)

    # Restored to the backup state, readable with the same key, still ciphertext.
    conn = database.open_raw_connection(enc)
    names = [r[0] for r in conn.execute("SELECT name FROM projects ORDER BY id").fetchall()]
    conn.close()
    assert names == ["Alpha"]
    assert enc.read_bytes()[:16] != SQLITE_HEADER


def test_encrypted_restore_foreign_backup_rejected_before_mutation(enc, tmp_path, monkeypatch):
    """Gap B: a backup made under key K1, restored on a machine whose active key is
    K2, is rejected by the preflight BEFORE the pre-restore safety backup runs and
    BEFORE the live DB is touched."""
    from app.services import backup

    docs = tmp_path / "documents"; docs.mkdir()
    media = tmp_path / "media"
    backups = tmp_path / "backups"
    _seed_encrypted_db(enc)

    info = backup.create_backup(enc, docs, media, backups, "manual")
    live_before = enc.read_bytes()

    # Simulate a different machine: same backup file, a DIFFERENT active key.
    monkeypatch.setenv("MM_ENCRYPTION_KEY", WRONG)
    with pytest.raises(ValueError, match="could not be opened"):
        backup.restore_from_backup(backups / info.filename, enc, docs, media, backups)

    # Fail-fast: no pre-restore safety backup was written, live DB untouched.
    assert list(backups.glob("pre_restore_*.mmbackup")) == []
    assert enc.read_bytes() == live_before
