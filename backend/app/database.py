from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from sqlalchemy.pool import StaticPool
from contextlib import contextmanager
from pathlib import Path
import logging
import os
import re
import time
from datetime import datetime, timezone
from .config import get_settings, get_backup_dir, resource_base
from .startup_errors import FatalStartupError

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


class PreMigrationBackupError(FatalStartupError):
    """The pre-migration backup was ATTEMPTED and failed (#692).

    Sibling of ``DatabaseUnreadableError`` and raised for the same reason: the
    startup migration is the only destructive path in the app, and this backup is
    its only guard. It used to be best-effort — every exception was swallowed to a
    ``logger.warning`` and ``command.upgrade()`` ran on the very next line — so the
    guard was absent precisely in the disk-full scenario it exists for. In a
    packaged Electron app a warning is not a user-visible event, so the failure was
    invisible as well as unhandled.

    ⚠️ This is NOT raised when there is simply nothing to back up. A new or empty
    database returns ``None`` from ``_backup_database`` and the migration proceeds
    normally — that distinction is the whole fix, because the old code collapsed
    "skipped, nothing at risk" and "attempted, failed, data at risk" into the same
    ``None`` and left the caller unable to tell them apart.

    ⚠️ Its message is USER-FACING (#716): it is shown verbatim in the packaged app's
    crash dialog, which is what `FatalStartupError` membership means. Keep it written
    as guidance a researcher can act on, not as a diagnostic.
    """


class DatabaseUnreadableError(FatalStartupError):
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
    every stdlib-``sqlite3`` site (the revision check, `snapshot_database_file`
    — which both the pre-migration copy and the backup service copy through —
    and the backup service's project-summary / restore-integrity reads) must
    route through here so ``PRAGMA key`` is issued before any other
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


class DatabaseBusyError(RuntimeError):
    """No copy of the database could be taken: another connection held it LOCKED for
    the whole wait (#1025, #1044). Nothing was written.

    Since #1044 the copy reads a snapshot through SQLite's backup API, so nothing this
    app does — an export, an import, a merge, a long write — can cause this. What can
    is a lock taken EXCLUSIVELY, which this app never takes: in practice another
    program holding the database file. ⚠️ And only while this process has NO
    connection open — measured: with one idle connection open, another program cannot
    take that lock at all. So it is reachable at startup (the pre-migration copy) and
    during a restore (the pool is disposed first), not while the app is serving.

    Callers turn this into their own sentence — what was NOT done differs per act
    (a backup not saved, a withdrawal not started, a migration not run).
    """

    def __init__(self, waited_seconds: float):
        super().__init__(
            f"The database was locked for the {waited_seconds:.0f} seconds this waited, "
            "so no copy of it could be taken."
        )
        self.waited_seconds = waited_seconds


#: How long ONE step of the copy waits for a lock before the budget is checked again,
#: and the pause between steps. Waiting for a READ lock holds nothing back from anyone.
SNAPSHOT_ATTEMPT_WAIT_MS = 1000
SNAPSHOT_RETRY_PAUSE_SECONDS = 1.0

#: What a backup step returns while it cannot get its lock (SQLITE_BUSY, SQLITE_LOCKED).
#: Numbers, not `sqlite3.SQLITE_BUSY`: the SQLCipher driver does not export the names.
_STEP_STILL_WAITING = frozenset({5, 6})


def _remove_database_file(path: Path) -> None:
    for suffix in ("", "-journal", "-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)


def snapshot_database_file(db_path: Path, dest: Path, *, busy_wait_seconds: float) -> None:
    """Copy the database at `db_path` to a NEW file `dest` as one consistent snapshot of
    everything committed, or raise having left nothing at `dest` (#1025, #1044).

    🔴 **Through SQLite's online backup API, never a file copy.** Two file-copy designs
    failed, each measured:

    - **#1025 — the WAL.** A committed change lives in the `-wal` file until a
      checkpoint moves it into the main file; copying the main file lost whatever a
      busy checkpoint left behind, and the copy still passed every integrity check
      (the audit: live 2 projects, backup 0). The backup API reads through SQLite's
      pager, so the WAL's committed pages are part of the snapshot — no checkpoint is
      needed, and none is run.
    - **#1044 — the process's locks.** A POSIX lock belongs to the PROCESS, and closing
      ANY descriptor on a file releases every lock the process holds on it. The file
      copy opened and closed the live database with an ordinary descriptor, so the
      server kept running with no locks while its connections believed they held
      them; another process could then decide it was the last connection and delete
      the `-wal` and `-shm` under the server (reproduced: `disk I/O error`). The backup
      API reads through the source connection's own descriptor, which SQLite manages.

    ``pages=-1`` copies every page in ONE step, inside one read transaction on the
    source: the snapshot is consistent, a writer is never held back (in WAL mode a
    reader blocks no one), and nothing is restarted by commits made meanwhile.

    ⚠️ **`dest` is opened through `open_raw_connection`, so it is KEYED when encryption
    is on** — the copy is ciphertext under the same key. SQLCipher refuses to back up
    into an unkeyed file (measured), so a plaintext copy cannot happen by accident.

    **The only wait left** is for a lock another connection holds EXCLUSIVELY, which
    blocks even a reader. Each step waits `SNAPSHOT_ATTEMPT_WAIT_MS`, then the driver
    pauses and retries; `DatabaseBusyError` ends it once `busy_wait_seconds` is spent.
    Any failure — that one, a wrong key, a full disk — removes the partial `dest` and
    propagates.
    """
    started = time.monotonic()

    def give_up_when_late(status: int, _remaining: int, _total: int) -> None:
        # Called after every step; raising here aborts the backup and propagates.
        waited = time.monotonic() - started
        if status in _STEP_STILL_WAITING and waited + SNAPSHOT_RETRY_PAUSE_SECONDS >= busy_wait_seconds:
            raise DatabaseBusyError(waited)

    try:
        src = open_raw_connection(db_path)
        try:
            src.execute(f"PRAGMA busy_timeout = {SNAPSHOT_ATTEMPT_WAIT_MS}")
            dst = open_raw_connection(dest)
            try:
                src.backup(
                    dst, pages=-1, progress=give_up_when_late,
                    sleep=SNAPSHOT_RETRY_PAUSE_SECONDS,
                )
            finally:
                dst.close()
        finally:
            src.close()
    except BaseException:
        _remove_database_file(dest)
        raise


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


#: `{stem}_{YYYYMMDD}_{HHMMSS}.db` — the shape `_backup_database` writes below.
#: Anchored, so nothing else in the backup folder can match: not a `.mmbackup`,
#: not a `.mmproject` safety copy, not a live database anyone parked there.
#: ASCII digits and `\Z` (#1039 f), as `services/backup._BACKUP_NAME_RE`.
_PRE_MIGRATION_RE = re.compile(
    r"^(?P<stem>.+)_(?P<date>\d{8})_(?P<time>\d{6})\.db\Z", re.ASCII
)

#: SQLite's companion files beside a pre-migration copy. The app never opens one,
#: but anyone inspecting a copy with a SQLite tool leaves them — MEASURED on the
#: developer's folder: `vl_20260714_235953.db-wal`/`-shm` outliving their database,
#: which #982's prune had removed. Without the database they are meaningless.
_PRE_MIGRATION_SIDE_FILES = ("-wal", "-shm", "-journal")


def _remove_side_files_of(copy: Path) -> None:
    for side in _PRE_MIGRATION_SIDE_FILES:
        Path(f"{copy}{side}").unlink(missing_ok=True)


def prune_orphaned_pre_migration_backups(db_path: Path, backup_dir: Path) -> int:
    """Delete pre-migration copies belonging to databases that no longer exist (#982).

    Returns how many were deleted. Best-effort and never raises.

    These copies rotate 5 deep **per database stem**, and the rotation only ever
    looks at the stem it is currently backing up — so every database that has ever
    run against this backup folder leaves up to five full, uncompressed copies
    behind forever. MEASURED on the developer's machine 2026-09-20: **3.77 GB of a
    4.60 GB folder, of which 1.42 GB belonged to six databases that were gone**
    (`scratch`, `verify`, `vl`, `grid`, `drive`, `reverse` — throwaway corpora from
    earlier sessions).

    🔴 **THIS DELETES RECOVERY POINTS, so every uncertainty resolves toward
    KEEPING them:**

    - A file is a candidate only if it matches `_PRE_MIGRATION_RE` exactly.
    - A stem is orphaned only if `{stem}.db` is **absent from the live database's
      own directory**. ⚠️ If that directory cannot be listed, NOTHING is pruned —
      an unreadable parent would otherwise make every stem look orphaned, which is
      the fail-closed-scan trap pointing at real files.
    - The live database's own stem is excluded explicitly, not merely by existing.
    - Every deletion is logged by name. ⚠️ This is only safe advice because #631
      is fixed; before it, all 31 `app.*` loggers were disabled at startup and this
      would have been a silent deletion.

    ⚠️ **In the packaged app this is a no-op by construction** — a researcher has
    exactly one database path, so there is only ever one stem and it is never
    orphaned. It reclaims space on a machine that has run several databases against
    one backup folder, which is the developer's.
    """
    try:
        if not backup_dir.is_dir():
            return 0
        db_dir = db_path.parent if str(db_path.parent) else Path(".")
        live_stems = {p.stem for p in db_dir.glob("*.db")}
        if not live_stems:
            # 🔴 THE FAIL-CLOSED CASE, and it covers BOTH ways of seeing nothing.
            # An `except OSError` around the glob above was written, and a mutant
            # proved it DEAD: measured on 3.12, `Path.glob` on an unreadable
            # directory returns `[]` and does NOT raise (unlike `os.listdir`), and
            # on a missing one it does the same. So "cannot read" and "nothing
            # there" arrive identically, and this single check is what stops an
            # empty answer being read as "every stem is orphaned".
            # Refusing costs disk; pruning would delete the copies of a database
            # that is merely detached right now.
            why = "could not be read" if not os.access(db_dir, os.R_OK) else "holds no database"
            logger.warning(
                "%s %s; keeping every pre-migration backup.", db_dir, why
            )
            return 0
        live_stems.add(db_path.stem)

        deleted = 0
        for path in backup_dir.iterdir():
            # A companion file whose copy is gone, whatever its stem (see
            # `_PRE_MIGRATION_SIDE_FILES`): never part of the count below.
            for side in _PRE_MIGRATION_SIDE_FILES:
                if path.name.endswith(side):
                    base = backup_dir / path.name[: -len(side)]
                    if _PRE_MIGRATION_RE.match(base.name) and not base.exists():
                        try:
                            path.unlink(missing_ok=True)
                            logger.info("Removed %s: the copy it belonged to is gone", path.name)
                        except OSError as e:
                            logger.warning("Could not remove %s: %s", path.name, e)
                    break
            match = _PRE_MIGRATION_RE.match(path.name)
            if match is None or match["stem"] in live_stems:
                continue
            try:
                if not path.is_file():
                    continue
                size = path.stat().st_size
                path.unlink()
                _remove_side_files_of(path)
            except OSError as e:
                logger.warning("Could not remove orphaned backup %s: %s", path.name, e)
                continue
            deleted += 1
            logger.info(
                "Removed pre-migration backup %s (%.1f MB): no database named '%s' remains",
                path.name, size / 1e6, match["stem"],
            )
        return deleted
    except Exception as e:  # never let housekeeping break startup
        logger.warning("Could not prune orphaned pre-migration backups: %s", e)
        return 0


#: At startup nothing in this process holds the database, so a busy one is held by
#: another program and waiting longer rarely helps; the packaged shell's health
#: probe allows 60 s for the whole startup (`electron/backend-process.js`).
PRE_MIGRATION_BUSY_WAIT_SECONDS = 10.0


def _backup_database(db_path: Path) -> Path | None:
    """Create a timestamped backup of the database before migration.

    Copies through `snapshot_database_file`, so the copy holds everything committed
    or the migration is refused (#1025). Keeps up to 5 most recent backups to limit
    disk usage.

    Returns the backup path, or ``None`` when there was nothing to back up (a new
    or empty database). **Raises ``PreMigrationBackupError`` when a backup was
    attempted and failed** — the caller must not migrate in that case (#692).
    """
    if not db_path.exists() or db_path.stat().st_size == 0:
        return None

    backup_dir = get_backup_dir()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{db_path.stem}_{timestamp}.db"

    try:
        # CREATING the directory is part of making the backup, so it belongs INSIDE
        # the guard. It used to sit above the try, where an unwritable parent (a
        # locked-down profile, a read-only volume, a synced folder mid-reconcile)
        # raised a bare PermissionError that the lifespan framed as "Mixed Measures
        # could not start. PermissionError: …" — the generic wording, for the exact
        # situation #692 wrote actionable guidance for. Same failure, same user, and
        # the message that names the folder and the fix was one line away.
        backup_dir.mkdir(parents=True, exist_ok=True)
        # #1025/#1044: a consistent snapshot through SQLite's backup API. Written under
        # a staging name and renamed into place, so a file carrying a pre-migration
        # copy's name is always a complete one (§2 of the backup rules, for .mmbackup):
        # the rotation below counts files by that name, and a half-written one would
        # push out a good copy. The name cannot match `_PRE_MIGRATION_RE`.
        staging = backup_dir / f".{backup_path.name}.partial"
        snapshot_database_file(
            db_path, staging, busy_wait_seconds=PRE_MIGRATION_BUSY_WAIT_SECONDS
        )
        os.replace(staging, backup_path)
        logger.info("Database backed up to %s", backup_path)
    except DatabaseBusyError as e:
        # Nothing in THIS process has the database open yet, so what holds it is
        # another program — and "free up disk space" would send the researcher the
        # wrong way.
        logger.error("Pre-migration backup FAILED (%s): refusing to migrate.", e)
        raise PreMigrationBackupError(
            f"Mixed Measures could not back up your database before updating it, "
            f"because another program is using {db_path}. No update was applied and "
            f"your data is untouched. Close any other copy of Mixed Measures, and any "
            f"program that may have that file open, then relaunch."
        ) from e
    except Exception as e:
        # #692: the backup is the only guard on the only destructive path. Refuse
        # rather than warn — a swallowed ENOSPC here is exactly how irreplaceable
        # coding work gets migrated over with no copy behind it.
        logger.error("Pre-migration backup FAILED (%s): refusing to migrate.", e)
        raise PreMigrationBackupError(
            f"Could not create the pre-migration backup at {backup_path}: {e}. "
            f"No migration was applied and your data is untouched. Free up disk "
            f"space (or fix permissions on {backup_dir}) and relaunch."
        ) from e

    # Pruning is deliberately OUTSIDE the critical section and stays best-effort:
    # the backup already exists on disk by this point, so a failure to delete an
    # OLD file is no reason to refuse the migration. Folding this into the try
    # above would turn a full-but-writable backup dir into a startup failure.
    #
    # 🔴 **This database's copies only, by the NAME PATTERN and an exact stem (#1039 e).**
    # It globbed `f"{stem}_*.db"`, which for the stem `dev` also matched another
    # database's copies (`dev_bes_20260101_000000.db`) — and sorted by name, those
    # read as NEWER (`b` > `2`), so the rotation could delete the copy just written.
    try:
        own = sorted(
            (p for p in backup_dir.iterdir()
             if (m := _PRE_MIGRATION_RE.match(p.name)) is not None and m["stem"] == db_path.stem),
            key=lambda p: p.name,
            reverse=True,
        )
        for old in own[5:]:
            old.unlink(missing_ok=True)
            _remove_side_files_of(old)
    except OSError as e:
        logger.warning("Could not prune old pre-migration backups: %s", e)

    return backup_path


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


def _script_only_alembic_config():
    """An Alembic config that knows where the scripts are and nothing else.

    ⚠️ **Deliberately built WITHOUT `alembic.ini`.** `env.py` runs `fileConfig` on
    the ini whenever it has one, which resets root logging; at startup that is
    harmless (it happens once, before serving), but these helpers run INSIDE a
    request, where it would reconfigure a live server's logging mid-flight.
    Nothing else in the ini matters to reading or applying revisions.
    """
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(resource_base() / "alembic"))
    return cfg


def classify_revision(revision: str | None) -> str:
    """Can THIS build open a database at `revision`? (#1026)

    - ``"current"`` — it is this build's head: nothing to do.
    - ``"older"`` — an ancestor these scripts contain: it can be brought forward.
    - ``"unknown"`` — no revision at all, or one these scripts do not contain. That
      is a database written by a NEWER build (the common case), or one from before
      the 2026-06-06 squash; either way this build cannot read it, and the startup
      migration would refuse to launch on it (`Can't locate revision`).
    """
    from alembic.script import ScriptDirectory

    if revision is None:
        return "unknown"
    script = ScriptDirectory.from_config(_script_only_alembic_config())
    if revision in set(script.get_heads()):
        return "current"
    known = {s.revision for s in script.walk_revisions()}
    return "older" if revision in known else "unknown"


def database_file_revision(db_path: Path) -> str | None:
    """The Alembic revision recorded in a database file — one that is NOT the
    running database, such as a backup extracted for a restore. None when the
    file has no `alembic_version` table. Raises `DatabaseUnreadableError` when
    the file cannot be read at all."""
    return _get_current_revision(db_path)


def upgrade_database_file(db_path: Path) -> str | None:
    """Bring a database file that is NOT the running one to this build's head (#1026).

    For a restore: the backup's database is migrated in STAGING, before it
    replaces anything, so a migration that fails changes nothing and the file
    swapped in is one this build's models can already read. No pre-migration copy
    is taken — the backup archive it came from IS that copy.

    Returns the revision the file ends at. Raises whatever the migration raised.
    """
    from alembic import command

    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db_path)
    command.upgrade(cfg, "head")
    return _get_current_revision(db_path)


def run_migrations():
    """Run any pending Alembic migrations with automatic backup."""
    from alembic.config import Config
    from alembic import command
    from alembic.script import ScriptDirectory

    # Resolve the alembic tree: the bundle's _MEIPASS when frozen, else backend/.
    base_dir = resource_base()
    alembic_cfg = Config(str(base_dir / "alembic.ini"))

    # Script location must be absolute (CWD is unpredictable when packaged).
    alembic_cfg.set_main_option("script_location", str(base_dir / "alembic"))

    # Where the DB currently sits — the first half of the pendency check below.
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

    # Is a migration ACTUALLY pending? (#920)
    #
    # 🔴 This block used to be commented "Check if migrations are actually pending"
    # while doing no such check: it backed up whenever `current_rev is not None`,
    # i.e. on EVERY startup of any non-empty database. `run_migrations()` is in the
    # lifespan's startup path, so every launch of the packaged app wrote a full copy
    # of the researcher's database — 468.8 MB per launch on the dev corpus, and five
    # ordinary launches after a bad migration rotated away (5-deep) the pre-migration
    # copy of the good state. That is precisely the recovery this backup exists to
    # provide, destroyed by normal use. In dev under `uvicorn --reload` the same
    # write happened on every file save.
    #
    # `not in heads`, never `!= head`: if the head set cannot be resolved, or the DB
    # sits on a revision the scripts no longer contain, or the chain has branched,
    # the predicate is True and we back up. Every unknown resolves toward taking the
    # backup — the only safe direction for the guard on the one destructive path.
    try:
        heads = set(ScriptDirectory.from_config(alembic_cfg).get_heads())
    except Exception as e:  # pragma: no cover - defensive; fails toward backing up
        logger.warning(
            "Could not resolve migration heads (%s); backing up as if pending.", e
        )
        heads = set()

    # Backup before migrating (skipped when the DB is empty/new — nothing at risk —
    # and, since #920, when it is already at head — nothing about to happen).
    # #692: a FAILED backup raises PreMigrationBackupError, which propagates past
    # command.upgrade() so the destructive step never runs; previously it was a
    # logger.warning that nobody saw and the migration proceeded anyway.
    #
    # ⚠️ This comment used to end "the packaged app turns this into a startup error
    # dialog" — which was NOT true and is the whole of #716: the message went to
    # stderr, and the spawned-child dialog said only "the local engine exited
    # unexpectedly". It is true as of #716 because the error subclasses
    # FatalStartupError and the lifespan emits it with the MM-FATAL marker.
    if current_rev is not None and current_rev not in heads:
        backup_path = _backup_database(db_path)
        if backup_path:
            logger.info(
                "Pre-migration backup created (rev %s): %s",
                current_rev, backup_path,
            )

    # #982: every database that has ever run against this backup folder leaves up
    # to five full copies behind, because the rotation above only ever looks at the
    # stem it is backing up. Runs on EVERY startup, not only when a migration is
    # pending — the copies it removes belong to databases that are gone, so waiting
    # for the next migration would just hold the disk longer. Best-effort, never
    # raises, and refuses to prune anything it is not certain about.
    prune_orphaned_pre_migration_backups(db_path, get_backup_dir())

    command.upgrade(alembic_cfg, "head")

    # Confirm the app's ORM engine can read the (possibly encrypted) DB before
    # we start serving — see _probe_engine_readable. No-op when encryption is off.
    _probe_engine_readable()
