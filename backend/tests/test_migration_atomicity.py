"""#1312: a startup migration is ONE transaction — its DDL, its data and the
foreign-key check — so a failure leaves the database exactly as it was.

Before #1312, pysqlite autocommitted every CREATE/ALTER/DROP: a migration that
failed partway kept its new column (and a stray `_alembic_tmp_*` table) while the
version stayed at the old revision, so every later launch failed on "duplicate
column". A migration that left a dangling reference was committed, version and all,
before the foreign-key check refused it. Both measured on plaintext SQLite and on
SQLCipher, which is why every test here runs on both drivers.

Each test copies the REAL script directory (so the real `env.py` runs) and adds one
probe revision on top of head. Nothing touches the app's own database.
"""
import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from app import config, database
from app.database import (
    HELP_CONTACT,
    MIGRATION_DISK_FULL,
    MigrationFailedError,
    migration_failed_guidance,
    run_migrations,
)
from app.startup_errors import MAX_FATAL_MESSAGE_CHARS, fatal_startup_message
from tests.backup_support import head_revision

KEY = "c0ffee" * 10 + "abcd"  # 64 hex characters

PROBE = '''"""probe revision for test_migration_atomicity.py"""
from alembic import op
import sqlalchemy as sa

revision = "zz_probe"
down_revision = {head!r}
branch_labels = None
depends_on = None


def upgrade():
{body}


def downgrade():
    pass
'''

#: DDL of both kinds — a plain ALTER and a batch RECREATE of a table holding a row —
#: then the fault. The fault's own words are asserted, so a probe that died BEFORE
#: its DDL (and so proved nothing about rolling it back) fails the test.
PARTWAY = '''    op.add_column("users", sa.Column("zz_probe", sa.Integer(), nullable=True))
    with op.batch_alter_table("projects", recreate="always") as batch:
        batch.add_column(sa.Column("zz_probe2", sa.Integer(), nullable=True))
    raise RuntimeError("probe: a migration that fails partway")'''

#: The same revision with its fault removed — the build that fixes it.
FIXED = PARTWAY.rsplit("\n", 1)[0]

#: A dangling reference, which only `env.py`'s foreign-key check can refuse.
DANGLING = '''    op.create_table(
        "zz_child",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("project_id", sa.Integer, sa.ForeignKey("projects.id")),
    )
    op.execute("INSERT INTO zz_child (id, project_id) VALUES (1, 999)")'''


@pytest.fixture(params=["plaintext", "sqlcipher"])
def driver(request, tmp_path, monkeypatch):
    """The encryption key in force for the database under test, or None.

    Under SQLCipher `env.py` reads the key through `current_database_key_hex`, which
    reads `database.settings` — patched onto a file path, as the `enc` fixture in
    `test_encryption_raw_sites.py` does.
    """
    if request.param == "plaintext":
        return None
    pytest.importorskip("sqlcipher3", reason="sqlcipher3 driver not installed")
    monkeypatch.setenv("MM_ENCRYPTION_KEY", KEY)
    monkeypatch.setattr(
        database, "settings",
        config.Settings(mm_encryption_enabled=True, mm_database_path=str(tmp_path / "enc.db")),
    )
    return KEY


def _connect(db: Path, key: str | None):
    if key is None:
        return sqlite3.connect(str(db))
    import sqlcipher3.dbapi2 as sqlcipher

    conn = sqlcipher.connect(str(db))
    conn.execute(f"PRAGMA key = \"x'{key}'\"")
    return conn


def _scripts(tmp_path: Path, body: str | None = None) -> Path:
    """The real script directory, plus a probe revision on top of head."""
    scripts = tmp_path / "alembic"
    if scripts.exists():
        shutil.rmtree(scripts)
    shutil.copytree(
        config.resource_base() / "alembic", scripts,
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    if body is not None:
        (scripts / "versions" / "zz_probe.py").write_text(
            PROBE.format(head=head_revision(), body=body)
        )
    return scripts


def _chain_scripts(tmp_path: Path) -> Path:
    """Two probe revisions on top of head: the first succeeds, the second fails."""
    scripts = _scripts(tmp_path)
    first = PROBE.format(head=head_revision(), body=FIXED).replace(
        'revision = "zz_probe"', 'revision = "zz_probe_first"'
    )
    (scripts / "versions" / "zz_probe_first.py").write_text(first)
    (scripts / "versions" / "zz_probe.py").write_text(
        PROBE.format(head="zz_probe_first", body='    raise RuntimeError("probe: the second fails")')
    )
    return scripts


def _upgrade(scripts: Path, db: Path) -> None:
    cfg = Config()
    cfg.set_main_option("script_location", str(scripts))
    cfg.attributes["mm_database_path"] = str(db)
    command.upgrade(cfg, "head")


def _head_db(tmp_path: Path, key: str | None) -> Path:
    """A database at this build's head, holding a user and a project."""
    db = tmp_path / ("enc.db" if key else "plain.db")
    _upgrade(_scripts(tmp_path), db)
    conn = _connect(db, key)
    conn.execute(
        "INSERT INTO users (id, username, password_hash, created_at) "
        "VALUES (1, 'Researcher', '', '2026-10-21 00:00:00')"
    )
    conn.execute(
        "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) "
        "VALUES (1, 1, 'Kept', 'active', '2026-10-21 00:00:00', '2026-10-21 00:00:00')"
    )
    conn.commit()
    conn.close()
    return db


def _state(db: Path, key: str | None):
    """Everything a failed migration could leave behind: schema, version, rows."""
    conn = _connect(db, key)
    try:
        schema = sorted(
            conn.execute("SELECT type, name, sql FROM sqlite_master").fetchall(), key=str
        )
        version = conn.execute("SELECT version_num FROM alembic_version").fetchall()
        projects = conn.execute("SELECT id, name FROM projects").fetchall()
    finally:
        conn.close()
    return schema, version, projects


class TestTheChainIsOneTransaction:
    def test_a_migration_that_fails_partway_leaves_the_database_as_it_was(
        self, tmp_path, driver
    ):
        db = _head_db(tmp_path, driver)
        before = _state(db, driver)

        with pytest.raises(RuntimeError, match="probe: a migration that fails partway"):
            _upgrade(_scripts(tmp_path, PARTWAY), db)

        schema, version, projects = _state(db, driver)
        assert not [n for _, n, _ in schema if n.startswith("_alembic_tmp")]
        assert (schema, version, projects) == before

    def test_the_same_revision_without_its_fault_then_applies(self, tmp_path, driver):
        """The relaunch that used to fail on "duplicate column name"."""
        db = _head_db(tmp_path, driver)
        with pytest.raises(RuntimeError):
            _upgrade(_scripts(tmp_path, PARTWAY), db)

        _upgrade(_scripts(tmp_path, FIXED), db)

        conn = _connect(db, driver)
        try:
            assert conn.execute("SELECT version_num FROM alembic_version").fetchall() == [
                ("zz_probe",)
            ]
            assert "zz_probe" in {r[1] for r in conn.execute("PRAGMA table_info(users)")}
            assert conn.execute("SELECT id, name FROM projects").fetchall() == [(1, "Kept")]
        finally:
            conn.close()

    def test_a_failure_rolls_back_the_revisions_before_it_too(self, tmp_path, driver):
        """ONE transaction for the chain, not one per revision — so a failure leaves
        the revision the PREVIOUS version can open (the pre-implementation review's R1)."""
        db = _head_db(tmp_path, driver)
        before = _state(db, driver)

        with pytest.raises(RuntimeError, match="probe: the second fails"):
            _upgrade(_chain_scripts(tmp_path), db)

        assert _state(db, driver) == before  # the first revision's column is gone too

    def test_a_migration_that_breaks_a_foreign_key_is_rolled_back(self, tmp_path, driver):
        db = _head_db(tmp_path, driver)
        before = _state(db, driver)

        with pytest.raises(RuntimeError, match="1 foreign key violations"):
            _upgrade(_scripts(tmp_path, DANGLING), db)

        assert _state(db, driver) == before  # no zz_child, version unmoved


class TestTheStartupMessage:
    def test_a_failed_pending_migration_reaches_the_dialog_as_guidance(
        self, tmp_path, monkeypatch
    ):
        """Through `run_migrations` itself: a real pre-migration copy, a real failure.

        `run_migrations` reads `alembic.ini` and the scripts from `resource_base()`,
        so a copy of both with the probe on top stands in for this build.
        """
        db = _head_db(tmp_path, None)
        before = _state(db, None)
        base = tmp_path / "build"
        base.mkdir()
        shutil.copy(config.resource_base() / "alembic.ini", base / "alembic.ini")
        shutil.copytree(_scripts(tmp_path, PARTWAY), base / "alembic")
        monkeypatch.setattr(database, "resource_base", lambda: base)
        monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
        monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")

        with pytest.raises(MigrationFailedError) as exc:
            run_migrations()

        message = str(exc.value)
        assert message.startswith("Mixed Measures could not update its database")
        assert "nothing has been changed" in message
        copies = sorted((tmp_path / "backups").glob(f"{db.stem}_*.db"))
        assert len(copies) == 1 and f"A copy taken before the update is at: {copies[0]}." in message
        assert message.endswith(f"The database is: {db} (probe: a migration that fails partway).")
        assert _state(db, None) == before
        assert fatal_startup_message(exc.value) == message  # shown verbatim

    def test_at_head_a_failure_is_not_described_as_an_update(self, tmp_path, monkeypatch):
        """Nothing was pending, so "the update was undone" would be false."""
        db = _head_db(tmp_path, None)
        monkeypatch.setattr(database.settings, "mm_database_path", str(db), raising=False)
        monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")
        import alembic.command

        def _fails(*_a, **_k):
            raise RuntimeError("Migration produced 1 foreign key violations.")

        monkeypatch.setattr(alembic.command, "upgrade", _fails)

        with pytest.raises(RuntimeError) as exc:
            run_migrations()
        assert not isinstance(exc.value, MigrationFailedError)

    def test_a_full_disk_gets_its_own_sentence(self, tmp_path):
        db, copy = tmp_path / "mm.db", tmp_path / "backups" / "mm_20261021_000000.db"
        full = migration_failed_guidance(db, copy, f"{MIGRATION_DISK_FULL}")
        other = migration_failed_guidance(db, None, "no such table: projects")

        assert full.startswith("There was not enough free disk space")
        assert "Free up disk space" in full and HELP_CONTACT not in full
        assert HELP_CONTACT in other and "Free up disk space" not in other
        assert "A copy taken before the update" not in other
        for message in (full, other):
            assert "\n" not in message and len(message) < MAX_FATAL_MESSAGE_CHARS

    def test_sqlite_really_says_disk_full_in_those_words(self, tmp_path):
        """The sentence keys on the driver's text, so bind the text for real."""
        conn = sqlite3.connect(str(tmp_path / "small.db"))
        conn.execute("CREATE TABLE t (x TEXT)")
        conn.execute("PRAGMA max_page_count = 2")
        with pytest.raises(sqlite3.OperationalError) as exc:
            for _ in range(100):
                conn.execute("INSERT INTO t VALUES (?)", ("x" * 4096,))
        conn.close()
        assert MIGRATION_DISK_FULL in str(exc.value)
