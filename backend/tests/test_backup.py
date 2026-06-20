import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import json
import sqlite3
import time
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

from app.services.backup import (
    create_backup,
    restore_from_backup,
    validate_backup,
    list_backups,
    get_backup_status,
    cleanup_old_backups,
    STALE_HOURS,
)


def _create_test_db(path: Path):
    """Create a minimal SQLite DB that passes integrity check.

    Includes all tables that _read_project_summaries queries.
    """
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE conversations (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("CREATE TABLE datasets (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("CREATE TABLE documents (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("INSERT INTO projects VALUES (1, 'Test Project')")
    conn.commit()
    conn.close()


def _create_fake_backup(backup_dir: Path, backup_type: str, suffix: str) -> str:
    """Create a minimal .mmbackup file with a unique name for rotation tests."""
    backup_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{backup_type}_{suffix}.mmbackup"
    path = backup_dir / filename
    manifest = {
        "format_version": 1, "app_version": "1.0.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "backup_type": backup_type, "db_size_bytes": 100,
        "document_count": 0, "project_summaries": [],
    }
    with zipfile.ZipFile(str(path), "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("database.db", "fake")
    return filename


# ── create_backup ─────────────────────────────────────────────────────────


def test_create_backup_basic(tmp_path):
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    info = create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "manual")

    assert info.filename.endswith(".mmbackup")
    assert info.backup_type == "manual"
    assert info.size_bytes > 0

    backup_path = backup_dir / info.filename
    assert backup_path.exists()

    with zipfile.ZipFile(str(backup_path), "r") as zf:
        names = zf.namelist()
        assert "manifest.json" in names
        assert "database.db" in names


def test_create_backup_includes_documents(tmp_path):
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    (docs_dir / "report.pdf").write_text("fake pdf content")
    sub = docs_dir / "subdir"
    sub.mkdir()
    (sub / "notes.txt").write_text("some notes")
    backup_dir = tmp_path / "backups"

    info = create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "manual")
    backup_path = backup_dir / info.filename

    with zipfile.ZipFile(str(backup_path), "r") as zf:
        names = zf.namelist()
        assert "documents/report.pdf" in names
        assert "documents/subdir/notes.txt" in names


def test_create_backup_manifest_fields(tmp_path):
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    (docs_dir / "a.txt").write_text("x")
    backup_dir = tmp_path / "backups"

    info = create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "auto")
    backup_path = backup_dir / info.filename

    with zipfile.ZipFile(str(backup_path), "r") as zf:
        manifest = json.loads(zf.read("manifest.json"))

    assert manifest["format_version"] == 1
    assert manifest["app_version"] == "1.0.1"
    assert "created_at" in manifest
    assert manifest["backup_type"] == "auto"
    assert manifest["db_size_bytes"] > 0
    assert manifest["document_count"] == 1
    assert len(manifest["project_summaries"]) == 1
    assert manifest["project_summaries"][0]["name"] == "Test Project"


def test_create_backup_no_db_raises(tmp_path):
    db_path = tmp_path / "nonexistent.db"
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    with pytest.raises(FileNotFoundError):
        create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "manual")


def test_create_backup_invalid_type_raises(tmp_path):
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    with pytest.raises(ValueError, match="Invalid backup type"):
        create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "bogus")


# ── validate_backup ───────────────────────────────────────────────────────


def test_validate_backup_valid(tmp_path):
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    info = create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "manual")
    backup_path = backup_dir / info.filename

    preview = validate_backup(backup_path)
    assert preview.manifest.format_version == 1
    assert preview.manifest.backup_type == "manual"
    assert preview.warnings == []


def test_validate_backup_invalid_zip(tmp_path):
    bad_file = tmp_path / "bad.mmbackup"
    bad_file.write_text("this is not a zip file")

    with pytest.raises(ValueError, match="not a valid ZIP file"):
        validate_backup(bad_file)


def test_validate_backup_missing_manifest(tmp_path):
    zip_path = tmp_path / "no_manifest.mmbackup"
    with zipfile.ZipFile(str(zip_path), "w") as zf:
        zf.writestr("database.db", "fake")

    with pytest.raises(ValueError, match="missing manifest.json"):
        validate_backup(zip_path)


def test_validate_backup_missing_db(tmp_path):
    zip_path = tmp_path / "no_db.mmbackup"
    manifest = {"format_version": 1, "app_version": "1.0.0", "created_at": "2026-01-01",
                "backup_type": "manual", "db_size_bytes": 0, "document_count": 0,
                "project_summaries": []}
    with zipfile.ZipFile(str(zip_path), "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))

    with pytest.raises(ValueError, match="missing database.db"):
        validate_backup(zip_path)


def test_validate_backup_not_found(tmp_path):
    with pytest.raises(ValueError, match="not found"):
        validate_backup(tmp_path / "ghost.mmbackup")


def _make_backup_with_db_bytes(path: Path, db_bytes: bytes):
    """Write a .mmbackup ZIP with a valid manifest and arbitrary database.db
    bytes — so the DB decrypt/integrity probe (not the manifest checks) is the
    thing under test."""
    manifest = {
        "format_version": 1, "app_version": "1.0.0",
        "created_at": "2026-01-01T00:00:00+00:00",
        "backup_type": "manual", "db_size_bytes": len(db_bytes),
        "document_count": 0, "media_file_count": 0, "project_summaries": [],
    }
    with zipfile.ZipFile(str(path), "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("database.db", db_bytes)


def test_validate_backup_rejects_unreadable_db(tmp_path):
    """A backup whose database.db is not a readable SQLite/SQLCipher file is
    rejected with the distinct "could not be opened" message (the wrong-key /
    foreign-backup / unencrypted-build / non-DB path) — not the corruption path."""
    zip_path = tmp_path / "garbage_db.mmbackup"
    _make_backup_with_db_bytes(zip_path, b"this is not a database" * 64)

    with pytest.raises(ValueError, match="could not be opened"):
        validate_backup(zip_path)


# ── list_backups ──────────────────────────────────────────────────────────


def test_list_backups_empty(tmp_path):
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    result = list_backups(backup_dir)
    assert result == []


def test_list_backups_sorted(tmp_path):
    """Backups are returned newest-first by mtime."""
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()

    fn1 = _create_fake_backup(backup_dir, "manual", "20260101_000001")
    time.sleep(0.05)
    fn2 = _create_fake_backup(backup_dir, "auto", "20260101_000002")

    result = list_backups(backup_dir)
    assert len(result) == 2
    # Newest first
    assert result[0].filename == fn2
    assert result[1].filename == fn1


def test_list_backups_nonexistent_dir(tmp_path):
    result = list_backups(tmp_path / "no_such_dir")
    assert result == []


# ── get_backup_status ─────────────────────────────────────────────────────


def test_get_backup_status_no_backups(tmp_path):
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    status = get_backup_status(backup_dir)
    assert status.is_stale is True
    assert status.backup_count == 0
    assert status.last_backup_at is None


def test_get_backup_status_recent(tmp_path):
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "manual")

    status = get_backup_status(backup_dir)
    assert status.is_stale is False
    assert status.backup_count == 1
    assert status.last_backup_at is not None
    assert status.total_size_bytes > 0
    # #357: no interval_hours passed → no next_backup_at projection
    assert status.next_backup_at is None


# ── #357 next_backup_at computation ────────────────────────────────────────


def test_get_backup_status_next_backup_at_computed_with_interval(tmp_path):
    """When interval_hours is provided, next_backup_at = last_backup + interval."""
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "manual")

    status = get_backup_status(backup_dir, interval_hours=4)
    assert status.last_backup_at is not None
    assert status.next_backup_at is not None
    # next should be 4h after last
    last = datetime.fromisoformat(status.last_backup_at)
    nxt = datetime.fromisoformat(status.next_backup_at)
    delta = (nxt - last).total_seconds()
    assert abs(delta - 4 * 3600) < 1, f"Expected ~4h delta, got {delta}s"


def test_get_backup_status_next_backup_at_null_when_no_backups(tmp_path):
    """No backups exist → next_backup_at is None (can't project from nothing)."""
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    status = get_backup_status(backup_dir, interval_hours=4)
    assert status.last_backup_at is None
    assert status.next_backup_at is None


def test_get_backup_status_advances_after_new_backup(tmp_path):
    """A new backup advances last_backup_at, which advances next_backup_at.
    Models the 'Backup now' UX: after manual trigger, the displayed countdown
    refreshes to reflect the new schedule."""
    db_path = tmp_path / "test.db"
    _create_test_db(db_path)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "auto")
    first_status = get_backup_status(backup_dir, interval_hours=4)
    first_next = datetime.fromisoformat(first_status.next_backup_at)

    # Force a small delay before the next backup so mtime advances
    time.sleep(0.05)
    create_backup(db_path, docs_dir, tmp_path / "media", backup_dir, "auto")
    second_status = get_backup_status(backup_dir, interval_hours=4)
    second_next = datetime.fromisoformat(second_status.next_backup_at)

    # The second backup is later → its next is later too
    assert second_next > first_next, "next_backup_at should advance after a fresh backup"


# ── cleanup_old_backups (rotate) ──────────────────────────────────────────


def test_rotate_backups_under_limit(tmp_path):
    backup_dir = tmp_path / "backups"

    _create_fake_backup(backup_dir, "manual", "20260101_000001")
    time.sleep(0.05)
    _create_fake_backup(backup_dir, "manual", "20260101_000002")

    deleted = cleanup_old_backups(backup_dir, "manual", max_count=5)
    assert deleted == 0
    assert len(list(backup_dir.glob("manual_*.mmbackup"))) == 2


def test_rotate_backups_over_limit(tmp_path):
    backup_dir = tmp_path / "backups"

    filenames = []
    for i in range(4):
        fn = _create_fake_backup(backup_dir, "manual", f"20260101_{i:06d}")
        filenames.append(fn)
        time.sleep(0.05)  # ensure distinct mtimes

    deleted = cleanup_old_backups(backup_dir, "manual", max_count=2)
    assert deleted == 2
    remaining = list(backup_dir.glob("manual_*.mmbackup"))
    assert len(remaining) == 2
    # The two newest should survive
    remaining_names = {p.name for p in remaining}
    assert filenames[-1] in remaining_names
    assert filenames[-2] in remaining_names


def test_rotate_backups_respects_type(tmp_path):
    backup_dir = tmp_path / "backups"

    for i in range(3):
        _create_fake_backup(backup_dir, "manual", f"20260101_{i:06d}")
        time.sleep(0.05)
    for i in range(3):
        _create_fake_backup(backup_dir, "auto", f"20260102_{i:06d}")
        time.sleep(0.05)

    deleted = cleanup_old_backups(backup_dir, "manual", max_count=1)
    assert deleted == 2
    assert len(list(backup_dir.glob("manual_*.mmbackup"))) == 1
    # Auto backups untouched
    assert len(list(backup_dir.glob("auto_*.mmbackup"))) == 3


# ── restore_from_backup ──────────────────────────────────────────────


def test_restore_basic(tmp_path):
    """Restore replaces DB with backup contents."""
    live_db = tmp_path / "live.db"
    _create_test_db(live_db)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    # Create a backup of the original state
    info = create_backup(live_db, docs_dir, tmp_path / "media", backup_dir, "manual")
    backup_path = backup_dir / info.filename

    # Modify the live DB (add a row the backup doesn't have)
    conn = sqlite3.connect(str(live_db))
    conn.execute("INSERT INTO projects VALUES (99, 'Should Disappear')")
    conn.commit()
    conn.close()

    # Restore from backup
    pre_restore = restore_from_backup(backup_path, live_db, docs_dir, tmp_path / "media", backup_dir)

    # Verify: the extra row is gone (restored to backup state)
    conn = sqlite3.connect(str(live_db))
    rows = conn.execute("SELECT id, name FROM projects").fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0] == (1, "Test Project")

    # Pre-restore backup was created
    assert pre_restore.backup_type == "pre_restore"
    assert pre_restore.filename.startswith("pre_restore_")


def test_restore_preserves_documents(tmp_path):
    """Restore replaces docs directory with backup's documents."""
    live_db = tmp_path / "live.db"
    _create_test_db(live_db)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    (docs_dir / "original.pdf").write_text("original content")
    backup_dir = tmp_path / "backups"

    # Create backup (contains original.pdf)
    info = create_backup(live_db, docs_dir, tmp_path / "media", backup_dir, "manual")
    backup_path = backup_dir / info.filename

    # Modify live docs (delete old, add new)
    (docs_dir / "original.pdf").unlink()
    (docs_dir / "new_file.txt").write_text("new content")

    # Restore
    restore_from_backup(backup_path, live_db, docs_dir, tmp_path / "media", backup_dir)

    # Verify: original.pdf is back, new_file.txt is gone
    assert (docs_dir / "original.pdf").exists()
    assert not (docs_dir / "new_file.txt").exists()
    assert (docs_dir / "original.pdf").read_text() == "original content"


def test_restore_creates_pre_restore_backup(tmp_path):
    """Restore creates a pre_restore backup before overwriting."""
    live_db = tmp_path / "live.db"
    _create_test_db(live_db)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    info = create_backup(live_db, docs_dir, tmp_path / "media", backup_dir, "manual")
    backup_path = backup_dir / info.filename

    pre_restore = restore_from_backup(backup_path, live_db, docs_dir, tmp_path / "media", backup_dir)

    # The pre-restore backup file should exist on disk
    pre_restore_path = backup_dir / pre_restore.filename
    assert pre_restore_path.exists()
    assert pre_restore.backup_type == "pre_restore"

    # Validate it's a proper backup
    preview = validate_backup(pre_restore_path)
    assert preview.manifest.backup_type == "pre_restore"


def test_restore_removes_wal_shm(tmp_path):
    """Restore removes stale WAL/SHM files from the old database."""
    live_db = tmp_path / "live.db"
    _create_test_db(live_db)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    info = create_backup(live_db, docs_dir, tmp_path / "media", backup_dir, "manual")
    backup_path = backup_dir / info.filename

    # Create fake WAL/SHM files
    wal_path = live_db.with_suffix(".db-wal")
    shm_path = live_db.with_suffix(".db-shm")
    wal_path.write_text("fake wal")
    shm_path.write_text("fake shm")

    restore_from_backup(backup_path, live_db, docs_dir, tmp_path / "media", backup_dir)

    assert not wal_path.exists()
    assert not shm_path.exists()


def test_restore_invalid_backup_raises(tmp_path):
    """Restore with an invalid backup raises ValueError."""
    live_db = tmp_path / "live.db"
    _create_test_db(live_db)
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    bad_zip = tmp_path / "bad.mmbackup"
    bad_zip.write_text("not a zip")

    with pytest.raises(ValueError, match="not a valid ZIP file"):
        restore_from_backup(bad_zip, live_db, docs_dir, tmp_path / "media", backup_dir)


def test_restore_unreadable_db_fails_before_pre_restore_backup(tmp_path):
    """A backup with an unreadable database.db is rejected by the validate_backup
    preflight BEFORE the pre-restore safety backup is created and before the live
    DB is touched (the corrected Phase 4 fail-fast contract)."""
    live_db = tmp_path / "live.db"
    _create_test_db(live_db)
    original_bytes = live_db.read_bytes()
    docs_dir = tmp_path / "documents"
    docs_dir.mkdir()
    backup_dir = tmp_path / "backups"

    bad_backup = tmp_path / "garbage_db.mmbackup"
    _make_backup_with_db_bytes(bad_backup, b"not a database" * 64)

    with pytest.raises(ValueError, match="could not be opened"):
        restore_from_backup(bad_backup, live_db, docs_dir, tmp_path / "media", backup_dir)

    # Fail-fast: no pre-restore safety backup was wasted on the doomed restore,
    # and the live DB is untouched.
    assert list(backup_dir.glob("pre_restore_*.mmbackup")) == []
    assert live_db.read_bytes() == original_bytes
