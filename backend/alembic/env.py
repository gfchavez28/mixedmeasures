"""Alembic environment configuration for Mixed Measures.

This module configures the migration environment, including:
- SQLite-specific settings (PRAGMAs, batch mode for ALTER operations)
- Connection to our database using app config
- Import of all models for autogenerate support
"""
from logging.config import fileConfig

import sqlalchemy as sa
from sqlalchemy import engine_from_config
from sqlalchemy import pool
from sqlalchemy import event

from alembic import context

# Import our application's Base and settings
import sys
from pathlib import Path

# Add the backend directory to the path so we can import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import Base, current_database_key_hex
from app.config import get_settings

# Import all models to populate Base.metadata
# This is required for autogenerate to work
from app import models  # noqa: F401

# this is the Alembic Config object
config = context.config

# Interpret the config file for Python logging.
#
# `disable_existing_loggers=False` is LOAD-BEARING (#631). Python's default for
# that argument is True, and `run_migrations()` runs on EVERY boot — after
# `app.main` and its router/service imports have already created their
# module-level loggers. With the default, all 31 `app.*` loggers end up
# `disabled=True`, so every deliberate caught-log-and-continue diagnostic
# vanishes: a failed auto-backup, the #578 reverse-recode repair, the consensus
# sweep, the #574 media-duration backfill. Unhandled exceptions still surface
# (uvicorn configures `uvicorn.error` separately) — what is lost is exactly the
# non-fatal failures that leave no other trace.
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# Target metadata for 'autogenerate' support
target_metadata = Base.metadata

# Get database URL from our settings — unless the caller named another file.
# `database.upgrade_database_file` does, to bring a restored backup's database to
# this version in STAGING, before it replaces the running one (#1026).
settings = get_settings()
db_url = f"sqlite:///{config.attributes.get('mm_database_path') or settings.mm_database_path}"

# When at-rest encryption is enabled, the migration engine must open the file
# with the SQLCipher key. None when encryption is off (plaintext path unchanged).
_db_key_hex = current_database_key_hex()


def set_sqlite_pragma_for_migrations(dbapi_conn, connection_record):
    """Set SQLite pragmas for migration safety.

    CRITICAL: foreign_keys must be OFF during migrations. SQLite's
    batch_alter_table (recreate='always') does DROP TABLE, which performs
    an implicit DELETE FROM when foreign_keys=ON — destroying all child
    rows via CASCADE before the temp table is renamed back. The PRAGMA
    must be set here (outside any transaction) because PRAGMA foreign_keys
    is a no-op inside a transaction.

    This connection is discarded when the migrations end; the application's
    own connection listener (database.py) enables foreign_keys=ON for normal
    runtime connections.

    Under encryption, ``PRAGMA key`` MUST be the first statement on the
    connection — before foreign_keys/journal_mode or any read — or the file
    reads as ciphertext.
    """
    cursor = dbapi_conn.cursor()
    if _db_key_hex is not None:
        # Raw-key hex form first; hex-only value is injection-safe.
        cursor.execute(f"PRAGMA key = \"x'{_db_key_hex}'\"")
    cursor.execute("PRAGMA foreign_keys=OFF")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL and not an Engine,
    though an Engine is acceptable here as well. By skipping the Engine
    creation we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.
    """
    context.configure(
        url=db_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # Required for SQLite ALTER operations
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine and associate a
    connection with the context.
    """
    # Override the sqlalchemy.url from alembic.ini with our config
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = db_url

    engine_kwargs = {}
    if _db_key_hex is not None:
        # Build the migration engine on the SQLCipher DBAPI module (plain sqlite
        # dialect + module=, matching database._get_encrypted_engine).
        import sqlcipher3.dbapi2 as sqlcipher_dbapi
        engine_kwargs["module"] = sqlcipher_dbapi

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        **engine_kwargs,
    )

    # Add SQLite pragma listener — PRAGMA key (if encrypted) then foreign_keys OFF
    event.listen(connectable, "connect", set_sqlite_pragma_for_migrations)

    # 🔴 #1312: THE WHOLE CHAIN IS ONE TRANSACTION, DDL INCLUDED. Before this, a
    # migration that failed partway kept the DDL it had run (pysqlite autocommits
    # it), left the version at the old revision, and every later launch failed on
    # "duplicate column" — while each failed launch took a fresh pre-migration copy
    # of the HALF-MIGRATED database, so the sixth rotated away the last good one.
    # Measured on plaintext SQLite and SQLCipher alike. Now a failure rolls back to
    # exactly the database the previous version wrote.
    #
    # The driver begins a transaction of its own only before INSERT/UPDATE/DELETE, so
    # without the explicit BEGIN below every CREATE/ALTER/DROP ran in autocommit.
    # Inside an explicit BEGIN the DDL stays in the transaction: since Python 3.6 the
    # driver no longer commits before DDL. SQLAlchemy's documented recipe also sets
    # the driver's `isolation_level = None`; on Python 3.12 and sqlcipher3 that
    # changed nothing (a mutant removing it passed every test in
    # `test_migration_atomicity.py`, 2026-10-21), so it is not here.
    #
    # ⚠️ One transaction for the chain, NOT `transaction_per_migration`: a failure
    # then leaves the revision the PREVIOUS version can open. A long upgrade does
    # not need per-revision commits either: since #1362 the backend announces an
    # update (`startup_errors.emit_startup_phase`) and the shell waits up to 30
    # minutes for it, not 60 s. ⚠️ Nothing that cannot run inside a
    # transaction (VACUUM, PRAGMA foreign_keys/journal_mode) may appear in a
    # migration — `backend/alembic/the internal design notes.
    @event.listens_for(connectable, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # Required for SQLite ALTER operations
            transactional_ddl=True,
        )

        with context.begin_transaction():
            context.run_migrations()

            # Verify integrity INSIDE the transaction, so a migration that leaves a
            # dangling reference is rolled back with the rest (#1312). It used to run
            # after the commit: the bad rows and the new version were already saved
            # when this refused them. `foreign_key_check` works whatever
            # `foreign_keys` is set to. It runs on every launch, at head too
            # (0.51 s on a 480 MB database, measured 2026-10-21).
            result = connection.execute(sa.text("PRAGMA foreign_key_check"))
            violations = result.fetchall()
            if violations:
                print(f"WARNING: {len(violations)} foreign key violations detected after migration!")
                for v in violations[:10]:
                    print(f"  table={v[0]}, rowid={v[1]}, referenced_table={v[2]}, fk_index={v[3]}")
                raise RuntimeError(
                    f"Migration produced {len(violations)} foreign key violations. "
                    "Database may be inconsistent. Restore from backup."
                )


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
