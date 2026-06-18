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

# Interpret the config file for Python logging
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Target metadata for 'autogenerate' support
target_metadata = Base.metadata

# Get database URL from our settings
settings = get_settings()
db_url = f"sqlite:///{settings.mm_database_path}"

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

    Foreign keys are re-enabled after migrations complete (see below).
    The application's own connection listener (database.py) enables
    foreign_keys=ON for normal runtime connections.

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

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # Required for SQLite ALTER operations
        )

        with context.begin_transaction():
            context.run_migrations()

        # Re-enable foreign keys and verify integrity after migrations
        connection.execute(sa.text("PRAGMA foreign_keys=ON"))
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
