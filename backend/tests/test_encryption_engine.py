"""Phase 1 SQLCipher engine + KeyProvider smoke tests (packaging P4).

Scope: the config-gated engine branch and the env-var KeyProvider stub. The
encrypted-path tests build their OWN engine on a temp file via get_engine()
after patching `database.settings` — they CANNOT use the module-level engine
(conftest pins MM_DATABASE_PATH=:memory:, which is force-plaintext) nor flip env
post-import (get_engine reads the module-global settings, set once at import).

Default-OFF guarantee: with the flag off, the plaintext path is unchanged and
the rest of the suite runs without SQLCipher overhead.
"""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DatabaseError, OperationalError

from app import config, database

SQLITE_HEADER = b"SQLite format 3\x00"


def _make_settings(**overrides):
    """A Settings whose init kwargs override env/.env (highest precedence)."""
    base = {"mm_database_path": ":memory:"}
    base.update(overrides)
    return config.Settings(**base)


# --- KeyProvider validation (no sqlcipher3 needed) --------------------------

def test_env_key_provider_accepts_64_hex(monkeypatch):
    monkeypatch.setenv("MM_ENCRYPTION_KEY", "A" * 64)
    assert database.EnvKeyProvider().get_key_hex() == "a" * 64  # normalized lower


def test_env_key_provider_rejects_missing(monkeypatch):
    monkeypatch.delenv("MM_ENCRYPTION_KEY", raising=False)
    with pytest.raises(RuntimeError):
        database.EnvKeyProvider().get_key_hex()


def test_env_key_provider_rejects_wrong_length(monkeypatch):
    monkeypatch.setenv("MM_ENCRYPTION_KEY", "abc123")
    with pytest.raises(RuntimeError):
        database.EnvKeyProvider().get_key_hex()


def test_env_key_provider_rejects_non_hex(monkeypatch):
    monkeypatch.setenv("MM_ENCRYPTION_KEY", "z" * 64)
    with pytest.raises(RuntimeError):
        database.EnvKeyProvider().get_key_hex()


def test_set_key_provider_swaps_source():
    class Fixed(database.KeyProvider):
        def get_key_hex(self):
            return "ef" * 32

    original = database._key_provider
    try:
        database.set_key_provider(Fixed())
        assert database._key_provider.get_key_hex() == "ef" * 32
    finally:
        database.set_key_provider(original)


# --- Disabled / :memory: path stays plaintext -------------------------------

def test_disabled_engine_writes_plaintext_file(tmp_path, monkeypatch):
    db_path = tmp_path / "plain.db"
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=False, mm_database_path=str(db_path)),
    )
    eng = database.get_engine()
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE t (v TEXT)"))
        conn.execute(text("INSERT INTO t VALUES ('hello')"))
    eng.dispose()
    # Plaintext SQLite file → standard header present.
    assert db_path.read_bytes()[:16] == SQLITE_HEADER


def test_memory_db_stays_plaintext_even_when_enabled(monkeypatch):
    # Flag ON but :memory: → plaintext branch; key is never consulted.
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=True, mm_database_path=":memory:"),
    )
    monkeypatch.delenv("MM_ENCRYPTION_KEY", raising=False)
    eng = database.get_engine()
    with eng.connect() as conn:
        assert conn.execute(text("select 1")).scalar() == 1
    eng.dispose()


# --- Encrypted path (requires the sqlcipher3 driver) ------------------------

pytest.importorskip("sqlcipher3", reason="sqlcipher3 driver not installed")


@pytest.fixture
def enc_db(tmp_path, monkeypatch):
    """An encryption-enabled Settings on a temp DB, key in MM_ENCRYPTION_KEY."""
    db_path = tmp_path / "enc.db"
    monkeypatch.setenv("MM_ENCRYPTION_KEY", "ab" * 32)  # 64 hex chars
    monkeypatch.setattr(
        database, "settings",
        _make_settings(mm_encryption_enabled=True, mm_database_path=str(db_path)),
    )
    return db_path


def test_encrypted_engine_round_trips_and_writes_ciphertext(enc_db):
    eng = database.get_engine()
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE t (v TEXT)"))
        conn.execute(text("INSERT INTO t VALUES ('secret-payload')"))
    with eng.connect() as conn:
        assert conn.execute(text("SELECT v FROM t")).scalar() == "secret-payload"
    eng.dispose()
    raw = enc_db.read_bytes()
    assert raw[:16] != SQLITE_HEADER          # no plaintext SQLite header
    assert b"secret-payload" not in raw       # payload not stored in the clear


def test_restart_with_correct_key_reads_data(enc_db):
    eng = database.get_engine()
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE t (v TEXT)"))
        conn.execute(text("INSERT INTO t VALUES ('persist')"))
    eng.dispose()
    # Fresh engine, same key (env unchanged) → data is readable.
    eng2 = database.get_engine()
    with eng2.connect() as conn:
        assert conn.execute(text("SELECT v FROM t")).scalar() == "persist"
    eng2.dispose()


def test_wrong_key_cannot_read(enc_db, monkeypatch):
    eng = database.get_engine()
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE t (v TEXT)"))
        conn.execute(text("INSERT INTO t VALUES ('x')"))
    eng.dispose()
    # Rebuild the engine with a DIFFERENT key — the first real read must fail.
    monkeypatch.setenv("MM_ENCRYPTION_KEY", "cd" * 32)
    eng2 = database.get_engine()
    with pytest.raises((DatabaseError, OperationalError)):
        with eng2.connect() as conn:
            conn.execute(text("SELECT v FROM t")).scalar()
    eng2.dispose()
