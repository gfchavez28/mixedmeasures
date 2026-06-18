from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from pathlib import Path
import logging
import os
import re
import shutil
from datetime import datetime, timezone
from .config import get_settings, get_backup_dir, resource_base

logger = logging.getLogger(__name__)

settings = get_settings()


# --- SQLCipher key management (packaging P4, Phase 1) -----------------------
# A 256-bit key is 64 hex characters. The raw-key PRAGMA form `PRAGMA key =
# "x'<64 hex>'"` skips PBKDF2 (correct for a random key, not a passphrase) and
# is injection-safe precisely because the value is validated to be hex-only.
_HEX256_RE = re.compile(r"\A[0-9a-fA-F]{64}\Z")


class KeyProvider:
    """Source of the raw SQLCipher database key (64 hex chars = 256 bits).

    The cipher-key *source* lives behind this interface so it is swappable
    without touching get_engine or the raw-connect sites. Phase 1 ships only
    the env-var stub below; Phase 3 adds the Model-A OS-keychain provider
    (macOS Keychain / Windows DPAPI / Linux libsecret) behind the same shape.
    """

    def get_key_hex(self) -> str:  # pragma: no cover - interface
        raise NotImplementedError


class EnvKeyProvider(KeyProvider):
    """Reads the key from MM_ENCRYPTION_KEY (64 hex chars). Test/dev stub.

    Raises a clear error rather than booting an encrypted engine with a missing
    or malformed key — failing loud here beats an opaque "file is not a
    database" later.
    """

    def get_key_hex(self) -> str:
        key = os.environ.get("MM_ENCRYPTION_KEY", "").strip()
        if not _HEX256_RE.match(key):
            raise RuntimeError(
                "Encryption is enabled but MM_ENCRYPTION_KEY is missing or not a "
                "64-hex-char (256-bit) key. Phase 1 sources the key from this env "
                "var; the OS-keychain provider lands in Phase 3."
            )
        return key.lower()


_key_provider: KeyProvider = EnvKeyProvider()


def set_key_provider(provider: KeyProvider) -> None:
    """Swap the key source (Phase 3 keychain provider; tests).

    Rebuild the engine after calling — get_engine reads the provider only at
    engine-build time, so an already-built engine keeps its original key.
    """
    global _key_provider
    _key_provider = provider


class DatabaseUnreadableError(Exception):
    """The database file exists and is non-empty but could not be opened.

    Raised instead of silently treating the file as "fresh." Under encryption
    (SQLCipher) this is the wrong/missing-key case; without encryption it means
    corruption. Either way the startup migration MUST NOT proceed — baselining
    over an unreadable-but-real database would destroy data (packaging plan
    Phase 0.5). This is a latent data-loss guard independent of encryption.
    """


class Base(DeclarativeBase):
    pass


def get_engine():
    # StaticPool for :memory: databases ensures all connections share the same DB
    pool_kwargs = {}
    if settings.mm_database_path == ":memory:":
        pool_kwargs["poolclass"] = StaticPool

    # Encryption is force-disabled on :memory: — the test suite (and any in-memory
    # use) stays plaintext, with zero SQLCipher overhead. Only a real file path
    # with the flag ON takes the encrypted branch.
    if settings.mm_encryption_enabled and settings.mm_database_path != ":memory:":
        return _get_encrypted_engine(pool_kwargs)

    # --- Plaintext path (default; unchanged) ---
    engine = create_engine(
        f"sqlite:///{settings.mm_database_path}",
        echo=False,
        connect_args={"check_same_thread": False},
        **pool_kwargs,
    )

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def _get_encrypted_engine(pool_kwargs):
    """SQLCipher-backed engine. Uses the plain sqlite dialect with the sqlcipher3
    DBAPI module (NOT the sqlite+pysqlcipher dialect, which would put the key in
    the engine URL). The connect listener issues `PRAGMA key` FIRST, before any
    statement touches the database, then the same PRAGMAs as the plaintext path.
    """
    import sqlcipher3.dbapi2 as sqlcipher_dbapi

    key_hex = _key_provider.get_key_hex()  # validated 64-hex; raises if missing

    engine = create_engine(
        f"sqlite:///{settings.mm_database_path}",
        echo=False,
        module=sqlcipher_dbapi,
        connect_args={"check_same_thread": False},
        **pool_kwargs,
    )

    @event.listens_for(engine, "connect")
    def set_sqlcipher_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        # PRAGMA key MUST be the first statement on the connection. Raw-key hex
        # form (x'...') = no PBKDF2; hex-only value is injection-safe.
        cursor.execute(f"PRAGMA key = \"x'{key_hex}'\"")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def open_raw_connection(db_path):
    """Open a raw DBAPI connection to a SQLite/SQLCipher DB file — keyed when
    encryption is enabled. This is the SINGLE place raw-connect key logic lives;
    every stdlib-``sqlite3`` site (the revision check, the pre-migration backup,
    and the backup service's checkpoint / project-summary / restore-integrity
    reads) must route through here so ``PRAGMA key`` is issued before any other
    statement.

    Returns a DBAPI connection (stdlib ``sqlite3`` or ``sqlcipher3.dbapi2``);
    the caller owns closing it. Mirrors get_engine's gating: encryption is
    force-disabled on ``:memory:``.
    """
    if settings.mm_encryption_enabled and str(db_path) != ":memory:":
        import sqlcipher3.dbapi2 as sqlcipher_dbapi
        key_hex = _key_provider.get_key_hex()  # validated 64-hex; raises if missing
        conn = sqlcipher_dbapi.connect(str(db_path))
        # Raw-key hex form first (no PBKDF2); hex-only value is injection-safe.
        conn.execute(f"PRAGMA key = \"x'{key_hex}'\"")
        return conn
    import sqlite3
    return sqlite3.connect(str(db_path))


def current_database_key_hex() -> str | None:
    """The active raw key hex, or None when encryption is off (or :memory:).

    For alembic/env.py, which builds its own migration engine and must issue
    ``PRAGMA key`` in its connect listener. Mirrors the gating in get_engine /
    open_raw_connection so the three paths never disagree on whether the file
    is encrypted.
    """
    if not settings.mm_encryption_enabled or settings.mm_database_path == ":memory:":
        return None
    return _key_provider.get_key_hex()


engine = get_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_context():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables using create_all (legacy, prefer run_migrations)."""
    from . import models  # noqa: F401
    Base.metadata.create_all(bind=engine)


def _get_current_revision(db_path: Path) -> str | None:
    """Read the current Alembic revision from the database.

    Returns None ONLY when the database is legitimately fresh: the file is
    absent, zero bytes, or readable-but-has-no-`alembic_version` table (a new
    or pre-Alembic DB). A present, non-empty file that cannot be read as SQLite
    raises DatabaseUnreadableError — it is NOT treated as fresh, because
    baselining over it would migrate-over-real-data (Phase 0.5). This matters
    most under encryption, where a wrong key makes a real DB look like garbage.
    """
    if not db_path.exists() or db_path.stat().st_size == 0:
        return None
    try:
        conn = open_raw_connection(db_path)
        try:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='alembic_version'"
            )
            if not cursor.fetchone():
                return None  # readable, but no alembic_version → fresh / pre-Alembic
            row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
            return row[0] if row else None
        finally:
            conn.close()
    except Exception as e:
        # The file exists and is non-empty but we could not read it as a SQLite
        # database (corruption, a lock, or under encryption a wrong/missing key).
        # Never fall through to None here — that would baseline over real data.
        raise DatabaseUnreadableError(
            f"Database at {db_path} exists ({db_path.stat().st_size} bytes) but "
            f"could not be opened: {e}"
        ) from e


def _backup_database(db_path: Path) -> Path | None:
    """Create a timestamped backup of the database before migration.

    Checkpoints the WAL first so the backup is self-contained.
    Keeps up to 5 most recent backups to limit disk usage.
    Returns the backup path, or None if backup was skipped/failed.
    """
    if not db_path.exists() or db_path.stat().st_size == 0:
        return None

    backup_dir = get_backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{db_path.stem}_{timestamp}.db"

    try:
        # Checkpoint WAL so the .db file is self-contained (keyed if encrypted)
        conn = open_raw_connection(db_path)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()

        shutil.copy2(str(db_path), str(backup_path))
        logger.info("Database backed up to %s", backup_path)

        # Prune old backups — keep most recent 5
        backups = sorted(backup_dir.glob(f"{db_path.stem}_*.db"), reverse=True)
        for old in backups[5:]:
            old.unlink(missing_ok=True)

        return backup_path
    except Exception as e:
        logger.warning("Failed to backup database: %s", e)
        return None


def _probe_engine_readable():
    """Defense-in-depth (encryption only): confirm the application's own ORM
    engine can actually read the DB. SQLCipher's ``PRAGMA key`` always succeeds;
    a wrong key only throws on the first real page-1 read. Translate that opaque
    error into DatabaseUnreadableError at startup so the app fails loudly+clearly
    instead of on the first ORM query mid-request. No-op when encryption is off
    (keeps the default path byte-for-byte unchanged)."""
    if not settings.mm_encryption_enabled or settings.mm_database_path == ":memory:":
        return
    from sqlalchemy import text as _text
    from sqlalchemy.exc import DatabaseError, OperationalError
    try:
        with engine.connect() as conn:
            conn.execute(_text("SELECT count(*) FROM sqlite_master"))
    except (DatabaseError, OperationalError) as e:
        raise DatabaseUnreadableError(
            f"Database at {settings.mm_database_path} opened but could not be read "
            f"by the application engine (corruption, or a wrong/missing encryption "
            f"key): {e}"
        ) from e


def run_migrations():
    """Run any pending Alembic migrations with automatic backup."""
    from alembic.config import Config
    from alembic import command

    # Resolve the alembic tree: the bundle's _MEIPASS when frozen, else backend/.
    base_dir = resource_base()
    alembic_cfg = Config(str(base_dir / "alembic.ini"))

    # Script location must be absolute (CWD is unpredictable when packaged).
    alembic_cfg.set_main_option("script_location", str(base_dir / "alembic"))

    # Check if migrations are actually pending
    db_path = Path(settings.mm_database_path)
    try:
        current_rev = _get_current_revision(db_path)
    except DatabaseUnreadableError:
        # Refuse to migrate over a real-but-unreadable DB (corruption / wrong
        # encryption key). Surfacing this loudly at startup is the correct
        # outcome — far better than baselining and destroying the data.
        logger.error(
            "Refusing to run migrations: the database exists but could not be "
            "opened (corruption, or under encryption a wrong/missing key). "
            "No migration was applied; existing data is untouched."
        )
        raise

    # Backup before migrating (skips if DB is empty/new)
    if current_rev is not None:
        backup_path = _backup_database(db_path)
        if backup_path:
            logger.info(
                "Pre-migration backup created (rev %s): %s",
                current_rev, backup_path,
            )

    command.upgrade(alembic_cfg, "head")

    # Confirm the app's ORM engine can read the (possibly encrypted) DB before
    # we start serving — see _probe_engine_readable. No-op when encryption is off.
    _probe_engine_readable()
