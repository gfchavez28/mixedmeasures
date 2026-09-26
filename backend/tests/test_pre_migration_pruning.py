"""Pre-migration copies of databases that no longer exist are pruned (#982).

These rotate 5 deep **per database stem**, and the rotation only ever looks at the
stem it is currently backing up — so every database that has ever run against one
backup folder leaves up to five full, uncompressed copies behind forever.
MEASURED on the developer's machine 2026-09-20: **3.77 GB of a 4.60 GB folder, of
which 1.42 GB belonged to six databases that were gone.**

🔴 **This DELETES recovery points, so the guards here are mostly NEGATIVE** — the
cases where it must keep its hands off. A prune that is merely correct on the happy
path is not good enough for a function whose failure mode is deleting the only copy
of someone's work.
"""

import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

from pathlib import Path

import pytest

from app.database import prune_orphaned_pre_migration_backups


def _live(db_dir: Path, *stems: str) -> Path:
    db_dir.mkdir(parents=True, exist_ok=True)
    for stem in stems:
        (db_dir / f"{stem}.db").write_bytes(b"SQLite format 3\x00")
    return db_dir / f"{stems[0]}.db"


def _copies(backup_dir: Path, *names: str) -> None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    for n in names:
        (backup_dir / n).write_bytes(b"x" * 64)


class TestWhatItRemoves:
    def test_removes_copies_of_a_database_that_is_gone(self, tmp_path):
        db = _live(tmp_path / "db", "dev")
        backups = tmp_path / "backups"
        _copies(
            backups,
            "dev_20260910_182237.db",
            "scratch_20260901_120000.db",
            "scratch_20260902_120000.db",
        )
        removed = prune_orphaned_pre_migration_backups(db, backups)
        assert removed == 2
        assert {p.name for p in backups.iterdir()} == {"dev_20260910_182237.db"}

    def test_the_measured_shape(self, tmp_path):
        """The developer's own folder: nine stems, three of them still live."""
        db = _live(tmp_path / "db", "dev", "pd_audit", "stress")
        backups = tmp_path / "backups"
        _copies(backups, *[
            f"{stem}_2026091{i}_120000.db"
            for stem, n in [("dev", 5), ("pd_audit", 5), ("stress", 5), ("scratch", 3),
                            ("verify", 4), ("vl", 3), ("grid", 1), ("drive", 1), ("reverse", 1)]
            for i in range(n)
        ])
        before = len(list(backups.iterdir()))
        removed = prune_orphaned_pre_migration_backups(db, backups)
        surviving = {p.name.rsplit("_", 2)[0] for p in backups.iterdir()}
        assert surviving == {"dev", "pd_audit", "stress"}
        assert removed == before - 15


class TestWhatItMustNeverTouch:
    def test_keeps_the_live_databases_own_copies(self, tmp_path):
        db = _live(tmp_path / "db", "dev")
        backups = tmp_path / "backups"
        _copies(backups, "dev_20260910_182237.db", "dev_20260910_182126.db")
        assert prune_orphaned_pre_migration_backups(db, backups) == 0
        assert len(list(backups.iterdir())) == 2

    def test_keeps_copies_of_another_database_that_still_exists(self, tmp_path):
        """A second corpus beside the live one is NOT orphaned. This is the case
        that makes `pd_audit`'s and `stress`'s copies safe on a machine booted
        against `dev.db`."""
        db = _live(tmp_path / "db", "dev", "pd_audit")
        backups = tmp_path / "backups"
        _copies(backups, "pd_audit_20260907_120000.db")
        assert prune_orphaned_pre_migration_backups(db, backups) == 0
        assert (backups / "pd_audit_20260907_120000.db").exists()

    @pytest.mark.parametrize("name", [
        "auto_20260920_020736.mmbackup",
        "pre-merge_1_20260101_000000.mmproject",
        "dev.db",                       # a live database parked in the folder
        "dev.db-wal",
        "notes.txt",
        "dev_2026_01.db",               # not the timestamp shape
        ".dev_20260910_182237.db.partial",
    ])
    def test_touches_nothing_that_is_not_a_pre_migration_copy(self, tmp_path, name):
        db = _live(tmp_path / "db", "dev")
        backups = tmp_path / "backups"
        _copies(backups, name)
        assert prune_orphaned_pre_migration_backups(db, backups) == 0
        assert (backups / name).exists()

    def test_keeps_everything_when_the_database_directory_does_not_exist(self, tmp_path):
        """🔴 The fail-closed case. If no live database can be seen, EVERY stem
        looks orphaned — and the response to "every stem looks orphaned" must never
        be "delete everything".

        ⚠️ **Renamed after mutation.** It was titled *"cannot be listed"*, which it
        does not test: `Path.glob` on a missing directory **yields `[]` and does not
        raise** (measured; the same fact `backend/tests/the internal design notes records for
        `rglob`), so the `OSError` arm never runs here — the empty-set check is what
        catches it. The unreadable case is the test below.
        """
        backups = tmp_path / "backups"
        _copies(backups, "dev_20260910_182237.db", "scratch_20260901_120000.db")
        missing = tmp_path / "no_such_dir" / "dev.db"
        assert prune_orphaned_pre_migration_backups(missing, backups) == 0
        assert len(list(backups.iterdir())) == 2

    def test_keeps_everything_when_the_database_directory_cannot_be_read(self, tmp_path):
        """The arm the test above does not reach: a directory that EXISTS and
        raises on listing."""
        db_dir = tmp_path / "db"
        db = _live(db_dir, "dev")
        backups = tmp_path / "backups"
        _copies(backups, "scratch_20260901_120000.db")
        os.chmod(db_dir, 0o000)
        try:
            if os.access(db_dir, os.R_OK):
                pytest.skip("running as root — an unreadable directory cannot be simulated")
            assert prune_orphaned_pre_migration_backups(db, backups) == 0
            assert (backups / "scratch_20260901_120000.db").exists()
        finally:
            os.chmod(db_dir, 0o700)

    def test_keeps_everything_when_the_database_itself_is_absent(self, tmp_path):
        """A database that is detached right now is not a database that is gone."""
        db_dir = tmp_path / "db"
        db_dir.mkdir()
        backups = tmp_path / "backups"
        _copies(backups, "dev_20260910_182237.db")
        assert prune_orphaned_pre_migration_backups(db_dir / "dev.db", backups) == 0
        assert (backups / "dev_20260910_182237.db").exists()

    def test_a_missing_backup_folder_is_not_an_error(self, tmp_path):
        db = _live(tmp_path / "db", "dev")
        assert prune_orphaned_pre_migration_backups(db, tmp_path / "absent") == 0

    def test_it_never_raises(self, tmp_path, monkeypatch):
        """Housekeeping must not be able to stop the app starting — it runs inside
        `run_migrations`, whose other failure modes are fatal by design (#692)."""
        db = _live(tmp_path / "db", "dev")
        backups = tmp_path / "backups"
        _copies(backups, "scratch_20260901_120000.db")

        def boom(self):
            raise RuntimeError("disk gone")

        monkeypatch.setattr(Path, "iterdir", boom)
        assert prune_orphaned_pre_migration_backups(db, backups) == 0


class TestItIsWiredIntoStartup:
    def test_run_migrations_calls_it(self, tmp_path, monkeypatch):
        """🔴 The pipeline-mouth test (#747). Every guard above calls the function
        directly, which proves it works and says nothing about whether startup
        reaches it — and the only thing that makes this prune worth anything is
        that it runs without being asked."""
        import app.database as database

        calls = []
        monkeypatch.setattr(
            database, "prune_orphaned_pre_migration_backups",
            lambda db_path, backup_dir: calls.append((db_path, backup_dir)),
        )
        monkeypatch.setattr(database, "get_backup_dir", lambda: tmp_path / "backups")
        monkeypatch.setattr(database, "_probe_engine_readable", lambda: None)

        class _Cmd:
            @staticmethod
            def upgrade(cfg, rev):
                pass

        monkeypatch.setattr("alembic.command.upgrade", _Cmd.upgrade)
        database.run_migrations()

        assert len(calls) == 1, "startup does not reach the prune"
        assert calls[0][1] == tmp_path / "backups"
