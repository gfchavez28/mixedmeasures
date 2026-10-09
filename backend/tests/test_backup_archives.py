"""A backup this app made can be RESTORED, and only real backups are listed (#971).

What these guard, and why each is here:

- **A backup the app wrote can be restored in place.** `create_backup` has no size
  cap and restore accepted only an UPLOAD, capped at 500 MB — so an instance could
  write archives it could not read back through its own UI. The complete backup,
  the one a researcher takes by hand before something risky, is the likeliest to
  exceed it, because the automatic ones exclude video to stay small.
- **A file carrying a backup's name is a real backup.** A staging file left by an
  interrupted write used to be listed as one, counted into the disk total, and —
  since freshness is just the newest file's mtime — could report a stale install
  as freshly backed up. MEASURED on the developer's own folder: an 88.1 MB
  `tmpouivnp8v.mmbackup` that is a `BadZipFile`.
- **A row says which KIND of backup it is.** Two of the five types contain an
  underscore, and the old `split("_", 1)` parse reported both as `"pre"`. Harmless
  while the list was read-only; the rows carry a Restore button now.
- **A request can reach backups and nothing else in that folder** — never a
  `.mmproject` safety copy, never a raw pre-migration `.db`, never a path outside.
- **A quit does not spend a 4-hourly recovery point** (#920): the shutdown backup
  has its own type and its own rotation.
"""

import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import json
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routers import backup as backup_router
from app.models.user import User
from app.services.backup import (
    MANUAL_BACKUP_MAX_COUNT,
    SHUTDOWN_BACKUP_MAX_COUNT,
    VALID_BACKUP_TYPES,
    BackupNameError,
    backup_files,
    cleanup_old_backups,
    create_backup,
    find_backup,
    get_backup_status,
    list_backups,
    parse_backup_name,
)
from tests.backup_support import stamp_revision


def _db(path: Path) -> Path:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)")
    for t in ("conversations", "datasets", "documents", "observations"):
        conn.execute(f"CREATE TABLE {t} (id INTEGER PRIMARY KEY, project_id INTEGER)")
    conn.execute("INSERT INTO projects VALUES (1, 'Study')")
    stamp_revision(conn)  # a restore refuses a database that records no revision (#1026)
    conn.commit()
    conn.close()
    return path


def _fake(backup_dir: Path, name: str, payload: bytes | None = None) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    path = backup_dir / name
    if payload is not None:
        path.write_bytes(payload)
        return path
    with zipfile.ZipFile(str(path), "w") as zf:
        zf.writestr("manifest.json", json.dumps({
            "format_version": 1, "app_version": "1.0.0",
            "created_at": "2026-01-01T00:00:00+00:00", "backup_type": "auto",
            "db_size_bytes": 1, "document_count": 0, "project_summaries": [],
        }))
        zf.writestr("database.db", "fake")
    return path


# ── what counts as a backup ───────────────────────────────────────────────


class TestBackupNaming:
    @pytest.mark.parametrize("name", [
        "auto_20260920_020736.mmbackup",
        "manual_20260101_000001.mmbackup",
        "manual_20260101_000001-2.mmbackup",
        "shutdown_20260920_020736.mmbackup",
        "pre_restore_20260919_120000.mmbackup",
        "pre_withdrawal_20260919_120000.mmbackup",
    ])
    def test_every_type_the_writer_accepts_is_a_name_the_list_recognises(self, name):
        assert parse_backup_name(name) is not None

    def test_the_population_is_the_writers_own_vocabulary(self):
        """Derived from `VALID_BACKUP_TYPES`, so a sixth type is a failing test
        with instructions rather than a row the list silently drops (#676's
        arity rule)."""
        for backup_type in VALID_BACKUP_TYPES:
            match = parse_backup_name(f"{backup_type}_20260101_000000.mmbackup")
            assert match is not None, f"{backup_type} is written but would not be listed"
            assert match["type"] == backup_type

    @pytest.mark.parametrize("name", [
        "tmpouivnp8v.mmbackup",          # the MEASURED staging orphan
        ".auto_20260101_000000.mmbackup.partial",
        ".upload_abc.partial",
        "pre-merge_1_20260101_000000.mmproject",   # a safety copy
        "dev_20260910_182237.db",                  # a pre-migration copy
        "auto_2026_01.mmbackup",
        "auto_20260101_000000.mmbackup.bak",
    ])
    def test_what_is_not_a_backup_is_refused(self, name):
        assert parse_backup_name(name) is None

    def test_pre_restore_and_pre_withdrawal_are_told_apart(self):
        """The old parse was `stem.split("_", 1)[0]`, which called both "pre"."""
        assert parse_backup_name("pre_restore_20260101_000000.mmbackup")["type"] == "pre_restore"
        assert parse_backup_name("pre_withdrawal_20260101_000000.mmbackup")["type"] == "pre_withdrawal"


class TestTheListShowsOnlyRealBackups:
    def test_a_staging_orphan_is_not_listed_counted_or_treated_as_fresh(self, tmp_path):
        """The measured defect, in all three of its consequences."""
        d = tmp_path / "backups"
        _fake(d, "auto_20260101_000000.mmbackup")
        orphan = _fake(d, "tmpouivnp8v.mmbackup", payload=b"truncated, not a zip")
        # Make the orphan the NEWEST file — the case where it sets freshness.
        os.utime(orphan, (2_000_000_000, 2_000_000_000))

        assert [b.filename for b in list_backups(d)] == ["auto_20260101_000000.mmbackup"]
        status = get_backup_status(d)
        assert status.backup_count == 1
        assert status.total_size_bytes == (d / "auto_20260101_000000.mmbackup").stat().st_size
        assert status.last_backup_at is not None
        # The orphan's future mtime must not be what freshness is read from.
        assert status.last_backup_at < "2033"

    def test_the_type_of_every_row_is_one_the_app_writes(self, tmp_path):
        d = tmp_path / "backups"
        for t in sorted(VALID_BACKUP_TYPES):
            _fake(d, f"{t}_20260101_000000.mmbackup")
        listed = list_backups(d)
        assert len(listed) == len(VALID_BACKUP_TYPES)
        assert {b.backup_type for b in listed} == VALID_BACKUP_TYPES

    def test_within_one_second_the_tail_is_compared_as_a_NUMBER(self, tmp_path):
        """🔴 Added after a mutant survived. A plain string tiebreaker is wrong
        twice: `.` (0x2E) sorts above `-` (0x2D), so the UNTAILED name reads as the
        newest of its second when it is the oldest; and `-10` reads as older than
        `-2`. The max+1 allocation happens to mask both in the rotation, which is
        exactly why this needs its own discriminating fixture — reverting the sort
        alone left every other test green.
        """
        d = tmp_path / "backups"
        for name in ("auto_20260101_000000.mmbackup",
                     "auto_20260101_000000-2.mmbackup",
                     "auto_20260101_000000-10.mmbackup"):
            _fake(d, name)
        assert [p.name for p in backup_files(d)] == [
            "auto_20260101_000000-10.mmbackup",   # newest: highest tail
            "auto_20260101_000000-2.mmbackup",
            "auto_20260101_000000.mmbackup",      # oldest: no tail means FIRST
        ]

    def test_newest_first_by_the_time_in_the_name_not_the_file_time(self, tmp_path):
        """Copying a folder to a new machine rewrites every mtime, in arbitrary
        order. The name carries the UTC stamp written with the file."""
        d = tmp_path / "backups"
        older = _fake(d, "auto_20260101_000000.mmbackup")
        newer = _fake(d, "auto_20260102_000000.mmbackup")
        os.utime(newer, (1_000_000, 1_000_000))   # newest name, OLDEST mtime
        os.utime(older, (2_000_000, 2_000_000))
        assert [p.name for p in backup_files(d)] == [newer.name, older.name]


# ── writing one ───────────────────────────────────────────────────────────


class TestCreateBackupWritesCompleteFiles:
    def test_the_staging_file_is_not_named_like_a_backup(self, tmp_path, monkeypatch):
        """The orphan class at its source.

        ⚠️ **Asserts the NAME, not the listing, and the difference was found by
        mutation.** Restoring the old `mkstemp(suffix=".mmbackup", …)` leaves the
        LIST clean anyway, because `_BACKUP_NAME_RE` rejects `tmpXXXXXXXX` — so a
        test phrased as "the staging file is not listed" passes under the bug and
        measures the pattern instead. What the staging name buys is the half the
        pattern cannot reach: a file ending `.mmbackup` is a backup to everything
        OUTSIDE this app — the researcher browsing the folder, a sync tool, the
        next person to write a glob — and one such 88.1 MB orphan, unreadable,
        was measured on the developer's own machine.
        """
        d = tmp_path / "backups"
        db = _db(tmp_path / "t.db")
        staged: list[Path] = []

        import app.services.backup as backup_service
        original = backup_service.os.replace

        def spy(src, dst):
            # The instant before the rename: the staging file is fully written and
            # the final name does not exist yet. This is exactly what an
            # interrupted write leaves behind permanently.
            staged.append(Path(src))
            assert backup_files(d) == [], "a staging file was listed as a backup"
            return original(src, dst)

        monkeypatch.setattr(backup_service.os, "replace", spy)
        create_backup(db, tmp_path / "docs", tmp_path / "media", d, "manual")

        assert staged, "the spy never ran — this test would be asserting nothing"
        # Neither the staged archive nor the folder holding it reads as a backup
        # (#1080 moved the archive into a hidden staging FOLDER in the backup folder).
        for name in (staged[0].name, staged[0].parent.name):
            assert parse_backup_name(name) is None
            assert not name.endswith(".mmbackup"), (
                f"{name} would read as a backup to anything outside this app"
            )
        assert staged[0].parent.parent == d, "the archive was not staged in the backup folder"
        assert backup_service.is_staging_name(staged[0].parent.name)
        assert len(backup_files(d)) == 1

    def test_a_second_backup_in_the_same_second_does_not_destroy_the_first(
        self, tmp_path, monkeypatch
    ):
        """`shutil.move` onto an existing path replaces it silently — and the file
        replaced is the OLDER snapshot, i.e. the one further back in the recovery
        window. `write_safety_copy` solved this for the sibling writer in #919."""
        d = tmp_path / "backups"
        db = _db(tmp_path / "t.db")

        import app.services.backup as backup_service
        frozen = backup_service.datetime

        class Frozen(frozen):
            @classmethod
            def now(cls, tz=None):
                return frozen(2026, 1, 1, 0, 0, 0, tzinfo=tz)

        monkeypatch.setattr(backup_service, "datetime", Frozen)
        first = create_backup(db, tmp_path / "docs", tmp_path / "media", d, "manual")
        second = create_backup(db, tmp_path / "docs", tmp_path / "media", d, "manual")

        assert first.filename != second.filename
        assert second.filename == "manual_20260101_000000-2.mmbackup"
        assert (d / first.filename).exists() and (d / second.filename).exists()
        assert parse_backup_name(second.filename) is not None


# ── reaching one ──────────────────────────────────────────────────────────


class TestFindBackup:
    def test_resolves_a_real_backup(self, tmp_path):
        d = tmp_path / "backups"
        path = _fake(d, "auto_20260101_000000.mmbackup")
        assert find_backup(d, path.name) == path.resolve()

    @pytest.mark.parametrize("name", [
        "pre-merge_1_20260101_000000.mmproject",  # a safety copy in the same folder
        "dev_20260910_182237.db",                 # a raw pre-migration copy
        "../../etc/passwd",
        "..%2Fsecret.mmbackup",
        "/etc/passwd",
        "tmpouivnp8v.mmbackup",
    ])
    def test_nothing_else_in_the_folder_can_be_reached(self, tmp_path, name):
        d = tmp_path / "backups"
        d.mkdir()
        with pytest.raises(BackupNameError):
            find_backup(d, name)

    def test_a_well_formed_name_with_no_file_is_a_different_failure(self, tmp_path):
        """Distinct from `BackupNameError` so the router can answer 404 rather
        than 400 — "it is gone" and "that is not a backup" are different facts."""
        d = tmp_path / "backups"
        d.mkdir()
        with pytest.raises(FileNotFoundError):
            find_backup(d, "auto_20260101_000000.mmbackup")

    def test_a_symlink_out_of_the_folder_is_refused(self, tmp_path):
        d = tmp_path / "backups"
        d.mkdir()
        outside = tmp_path / "elsewhere.mmbackup"
        outside.write_bytes(b"x")
        link = d / "auto_20260101_000000.mmbackup"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            pytest.skip("symlinks unavailable on this platform")
        with pytest.raises(FileNotFoundError):
            find_backup(d, link.name)


# ── rotation ──────────────────────────────────────────────────────────────


class TestRotation:
    def test_a_quit_does_not_spend_a_four_hourly_recovery_point(self, tmp_path):
        """#920: the shutdown hook wrote `auto` backups and rotated the `auto`
        set, so five restarts emptied the window the 4-hourly loop is building.
        MEASURED twice — the second time by the session that fixed it, which
        replaced five snapshots spanning ~9 hours with five spanning 82 seconds."""
        d = tmp_path / "backups"
        for i in range(5):
            _fake(d, f"auto_20260101_00000{i}.mmbackup")
        for i in range(5):
            _fake(d, f"shutdown_2026010{i + 1}_120000.mmbackup")

        deleted = cleanup_old_backups(d, "shutdown", SHUTDOWN_BACKUP_MAX_COUNT)

        assert deleted == 5 - SHUTDOWN_BACKUP_MAX_COUNT
        surviving = {p.name for p in backup_files(d)}
        assert len([n for n in surviving if n.startswith("auto_")]) == 5, (
            "a quit rotated away a 4-hourly recovery point"
        )
        assert len([n for n in surviving if n.startswith("shutdown_")]) == SHUTDOWN_BACKUP_MAX_COUNT

    def test_the_shutdown_hook_actually_writes_the_shutdown_type(self, tmp_path, monkeypatch):
        """🔴 The test above proves `cleanup_old_backups` CAN spare the `auto` set;
        it says nothing about whether the hook asks it to. Unit-testing the callee
        and calling the pipeline covered is the #747 class, so this enters at the
        hook and reads what it wrote.
        """
        import app.main as app_main

        d = tmp_path / "backups"
        db = _db(tmp_path / "t.db")
        monkeypatch.setattr(app_main, "get_backup_dir", lambda: d)
        monkeypatch.setattr(app_main, "get_documents_dir", lambda: tmp_path / "docs")
        monkeypatch.setattr(app_main, "get_media_dir", lambda: tmp_path / "media")
        settings = app_main.get_settings()
        monkeypatch.setattr(settings, "mm_database_path", str(db), raising=False)

        for i in range(5):
            _fake(d, f"auto_20260101_00000{i}.mmbackup")

        app_main._shutdown_backup()

        written = [b for b in list_backups(d) if b.backup_type == "shutdown"]
        assert len(written) == 1, "the shutdown hook did not write a shutdown backup"
        assert len([b for b in list_backups(d) if b.backup_type == "auto"]) == 5, (
            "quitting spent a 4-hourly recovery point"
        )

    def test_repeated_quits_cannot_empty_the_four_hourly_window(self, tmp_path, monkeypatch):
        """The measured scenario, end to end: five restarts in quick succession.
        Before the split they replaced all five `auto` snapshots — ~9 hours of
        recovery points — with five copies of one moment."""
        import app.main as app_main

        d = tmp_path / "backups"
        db = _db(tmp_path / "t.db")
        monkeypatch.setattr(app_main, "get_backup_dir", lambda: d)
        monkeypatch.setattr(app_main, "get_documents_dir", lambda: tmp_path / "docs")
        monkeypatch.setattr(app_main, "get_media_dir", lambda: tmp_path / "media")
        monkeypatch.setattr(app_main.get_settings(), "mm_database_path", str(db), raising=False)

        keepers = [f"auto_2026010{i + 1}_120000.mmbackup" for i in range(5)]
        for name in keepers:
            _fake(d, name)

        for _ in range(5):
            app_main._shutdown_backup()

        surviving = {p.name for p in backup_files(d)}
        assert set(keepers) <= surviving, (
            f"five quits destroyed recovery points: {sorted(set(keepers) - surviving)}"
        )
        assert len([n for n in surviving if n.startswith("shutdown_")]) <= SHUTDOWN_BACKUP_MAX_COUNT

    def test_pre_restore_is_not_taken_for_pre_withdrawal(self, tmp_path):
        """They share a prefix; a glob on `pre_` would rotate away the only
        recovery point for an irreversible removal of a real person's data."""
        d = tmp_path / "backups"
        for i in range(3):
            _fake(d, f"pre_restore_2026010{i + 1}_000000.mmbackup")
        _fake(d, "pre_withdrawal_20260101_000000.mmbackup")

        cleanup_old_backups(d, "pre_restore", max_count=1)

        surviving = {p.name for p in backup_files(d)}
        assert "pre_withdrawal_20260101_000000.mmbackup" in surviving
        assert len([n for n in surviving if n.startswith("pre_restore_")]) == 1

    def test_a_file_that_will_not_delete_is_skipped_not_raised(self, tmp_path, monkeypatch):
        """Windows refuses to unlink a file another process holds open — including
        the archive a restore is reading, which is reachable since #971. An
        exception here aborts the rotation, and at shutdown it is the last thing
        that happens."""
        d = tmp_path / "backups"
        for i in range(3):
            _fake(d, f"auto_2026010{i + 1}_000000.mmbackup")

        import app.services.backup as backup_service
        real_unlink = Path.unlink

        def refuse(self, *a, **kw):
            if self.name == "auto_20260101_000000.mmbackup":
                raise PermissionError("held open by another program")
            return real_unlink(self, *a, **kw)

        monkeypatch.setattr(Path, "unlink", refuse)
        deleted = cleanup_old_backups(d, "auto", max_count=1)

        assert deleted == 1  # the one it could delete, not the one it could not
        assert (d / "auto_20260101_000000.mmbackup").exists()
        assert backup_service.VALID_BACKUP_TYPES  # module import sanity

    def test_an_unknown_type_is_refused_rather_than_matching_nothing(self, tmp_path):
        """A typo used to glob zero files and report a successful rotation of 0."""
        with pytest.raises(ValueError):
            cleanup_old_backups(tmp_path, "atuo", max_count=1)

    def test_a_downloaded_backup_does_not_leave_a_copy_forever(
        self, db_session, backup_dir, tmp_path, monkeypatch
    ):
        """#982: `manual` never rotated, and its server copy is a DUPLICATE — the
        archive is streamed to the researcher's downloads, and it is the one type
        that includes video by default.

        Enters at the ENDPOINT, because the rotation is the router's and a
        service-level test would prove only that `cleanup_old_backups` can count
        (#747). ⚠️ `backup_create` was `async def` until #1025, and the first draft
        of the sibling below called it bare, passed, and had run nothing at all —
        which is why `names` is counted below: a call that returns a coroutine
        fails the length check rather than passing silently.
        """
        db = _db(tmp_path / "t.db")
        monkeypatch.setattr(
            backup_router, "_get_paths",
            lambda: (db, tmp_path / "docs", tmp_path / "media", backup_dir),
        )
        names = []
        for _ in range(MANUAL_BACKUP_MAX_COUNT + 2):
            response = backup_router.backup_create(
                user=_user(db_session), db=db_session, include_video=False
            )
            names.append(Path(response.path).name)

        kept = [b for b in list_backups(backup_dir) if b.backup_type == "manual"]
        assert len(names) == MANUAL_BACKUP_MAX_COUNT + 2, "the endpoint did not run"
        assert len(kept) == MANUAL_BACKUP_MAX_COUNT
        # 🔴 The archive this response is about to STREAM must survive its own
        # rotation — the whole reason the cleanup runs after the create and keeps
        # the newest N rather than deleting all but the newest.
        assert names[-1] in {b.filename for b in kept}
        assert (backup_dir / names[-1]).exists()

    def test_the_other_types_are_untouched_by_that_rotation(
        self, db_session, backup_dir, tmp_path, monkeypatch
    ):
        """The POSITIVE control: a rotation that swept the folder would pass every
        assertion above."""
        for name in ("auto_20260101_000000.mmbackup", "pre_withdrawal_20260101_000000.mmbackup"):
            _fake(backup_dir, name)
        db = _db(tmp_path / "t.db")
        monkeypatch.setattr(
            backup_router, "_get_paths",
            lambda: (db, tmp_path / "docs", tmp_path / "media", backup_dir),
        )
        for _ in range(4):
            backup_router.backup_create(
                user=_user(db_session), db=db_session, include_video=False
            )

        surviving = {p.name for p in backup_files(backup_dir)}
        assert len([n for n in surviving if n.startswith("manual_")]) == MANUAL_BACKUP_MAX_COUNT
        assert "auto_20260101_000000.mmbackup" in surviving
        assert "pre_withdrawal_20260101_000000.mmbackup" in surviving

    def test_a_file_that_will_not_delete_is_skipped_not_raised(self, tmp_path, monkeypatch):
        """Windows refuses to unlink a file another process holds open — including
        the archive a restore is reading, which is reachable since #971. An
        exception here aborts the rotation, and at shutdown it is the last thing
        that happens."""
        d = tmp_path / "backups"
        for i in range(3):
            _fake(d, f"auto_2026010{i + 1}_000000.mmbackup")

        import app.services.backup as backup_service
        real_unlink = Path.unlink

        def refuse(self, *a, **kw):
            if self.name == "auto_20260101_000000.mmbackup":
                raise PermissionError("held open by another program")
            return real_unlink(self, *a, **kw)

        monkeypatch.setattr(Path, "unlink", refuse)
        deleted = cleanup_old_backups(d, "auto", max_count=1)

        assert deleted == 1  # the one it could delete, not the one it could not
        assert (d / "auto_20260101_000000.mmbackup").exists()
        assert backup_service.VALID_BACKUP_TYPES  # module import sanity

    def test_an_unknown_type_is_refused_rather_than_matching_nothing(self, tmp_path):
        """A typo used to glob zero files and report a successful rotation of 0."""
        with pytest.raises(ValueError):
            cleanup_old_backups(tmp_path, "atuo", max_count=1)

# ── the endpoints ─────────────────────────────────────────────────────────


@pytest.fixture
def backup_dir(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "backups"
    path.mkdir()
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: path)
    return path


def _user(db_session) -> User:
    return db_session.query(User).filter(User.id == 1).one()


class TestArchiveEndpoints:
    def test_download_serves_the_file_under_its_own_name(self, db_session, backup_dir):
        path = _fake(backup_dir, "manual_20260101_000000.mmbackup")
        response = backup_router.backup_download(path.name, user=_user(db_session))
        assert Path(response.path) == path.resolve()
        assert path.name in response.headers["content-disposition"]

    @pytest.mark.parametrize(
        "call", ["backup_download", "backup_validate_local", "backup_delete"]
    )
    def test_a_safety_copy_cannot_be_reached_through_the_backup_doors(
        self, db_session, backup_dir, call
    ):
        """They share a folder. `find_safety_copy` already refuses every
        `.mmbackup`; this is the same refusal pointing the other way."""
        name = "pre-merge_1_20260101_000000.mmproject"
        (backup_dir / name).write_bytes(b"x")
        kwargs = {"user": _user(db_session)}
        if call == "backup_delete":
            kwargs["db"] = db_session
        with pytest.raises(HTTPException) as exc:
            getattr(backup_router, call)(name, **kwargs)
        assert exc.value.status_code == 400

    def test_a_missing_backup_is_404_not_400(self, db_session, backup_dir):
        with pytest.raises(HTTPException) as exc:
            backup_router.backup_download(
                "auto_20260101_000000.mmbackup", user=_user(db_session)
            )
        assert exc.value.status_code == 404

    def test_delete_removes_the_file_and_records_it(self, db_session, backup_dir):
        from app.models.audit import AuditEntry

        path = _fake(backup_dir, "manual_20260101_000000.mmbackup")
        backup_router.backup_delete(path.name, user=_user(db_session), db=db_session)
        assert not path.exists()
        entry = db_session.query(AuditEntry).filter(
            AuditEntry.action == "backup_deleted"
        ).one()
        assert json.loads(entry.details)["filename"] == path.name

    def test_validate_reports_a_damaged_backup_as_a_400(self, db_session, backup_dir):
        _fake(backup_dir, "auto_20260101_000000.mmbackup", payload=b"not a zip")
        with pytest.raises(HTTPException) as exc:
            backup_router.backup_validate_local(
                "auto_20260101_000000.mmbackup", user=_user(db_session)
            )
        assert exc.value.status_code == 400

    def test_validate_previews_a_real_backup_without_an_upload(
        self, db_session, backup_dir, tmp_path
    ):
        """The door #971 needs beside restore: a restore is confirmed from its
        preview, so a preview that still required an upload would hit the same
        wall one step earlier."""
        db = _db(tmp_path / "t.db")
        info = create_backup(db, tmp_path / "docs", tmp_path / "media", backup_dir, "manual")
        preview = backup_router.backup_validate_local(info.filename, user=_user(db_session))
        assert preview.manifest.backup_type == "manual"
        assert [p.name for p in preview.manifest.project_summaries] == ["Study"]


class TestRestoreInPlace:
    """The heart of #971. `restore_from_backup` itself is covered behaviourally in
    `test_backup.py`; what is new is the door — so these enter at the ENDPOINT.

    ⚠️ A SPY, deliberately: the real call disposes the engine pool and replaces
    the database file, and this suite's engine is the shared `:memory:` one
    conftest pins. What has to be proven here is that the endpoint reaches the
    restore with the RESOLVED path and nothing copied — the pipeline-mouth rule
    (#747) applied to a step whose behaviour cannot be run in-process.
    """

    def test_restore_reaches_the_file_in_place_with_no_upload(
        self, db_session, backup_dir, monkeypatch, tmp_path
    ):
        db = _db(tmp_path / "t.db")
        info = create_backup(db, tmp_path / "docs", tmp_path / "media", backup_dir, "manual")
        called: list[Path] = []

        def spy(zip_path, *a, **kw):
            called.append(Path(zip_path))
            from app.schemas.backup import BackupInfo
            return BackupInfo(
                filename="pre_restore_20260101_000000.mmbackup",
                created_at="2026-01-01T00:00:00+00:00", size_bytes=1,
                backup_type="pre_restore",
            )

        monkeypatch.setattr(backup_router, "restore_from_backup", spy)
        monkeypatch.setattr(backup_router.engine, "dispose", lambda: None)

        result = backup_router.backup_restore_local(
            info.filename, user=_user(db_session), db=db_session
        )

        assert called == [(backup_dir / info.filename).resolve()], (
            "the restore did not run against the backup in the folder"
        )
        assert result["pre_restore_backup"] == "pre_restore_20260101_000000.mmbackup"

    def test_the_two_doors_are_told_apart_in_the_audit_trail(
        self, db_session, backup_dir, monkeypatch, tmp_path
    ):
        """Both write `restore_started`. Without the source, a trail cannot say
        whether a restore came from a file the researcher chose on their disk or
        from the app's own folder — which is the first question after a bad one."""
        from app.models.audit import AuditEntry

        db = _db(tmp_path / "t.db")
        info = create_backup(db, tmp_path / "docs", tmp_path / "media", backup_dir, "manual")
        monkeypatch.setattr(backup_router, "restore_from_backup", lambda *a, **k: _BackupInfoStub())
        monkeypatch.setattr(backup_router.engine, "dispose", lambda: None)

        backup_router.backup_restore_local(info.filename, user=_user(db_session), db=db_session)

        entry = db_session.query(AuditEntry).filter(
            AuditEntry.action == "restore_started"
        ).one()
        details = json.loads(entry.details)
        assert details["source"] == "backup_folder"
        assert details["filename"] == info.filename

    def test_a_file_that_is_not_a_backup_never_reaches_the_restore(
        self, db_session, backup_dir, monkeypatch
    ):
        """The refusal has to come BEFORE the engine is disposed and the audit
        row written — a 400 that has already torn down the connection pool is a
        broken app, not a refusal."""
        (backup_dir / "pre-merge_1_20260101_000000.mmproject").write_bytes(b"x")
        reached = []
        monkeypatch.setattr(
            backup_router, "restore_from_backup", lambda *a, **k: reached.append(1)
        )
        monkeypatch.setattr(
            backup_router.engine, "dispose", lambda: reached.append("disposed")
        )
        with pytest.raises(HTTPException) as exc:
            backup_router.backup_restore_local(
                "pre-merge_1_20260101_000000.mmproject", user=_user(db_session), db=db_session
            )
        assert exc.value.status_code == 400
        assert reached == []


class _BackupInfoStub:
    filename = "pre_restore_20260101_000000.mmbackup"
    created_at = "2026-01-01T00:00:00+00:00"


class TestTheUploadCeilingIsNotTheRestoreCeiling:
    def test_the_upload_refusal_names_the_door_that_has_no_limit(self):
        """A researcher meeting the 500 MB wall is meeting it on the path that
        does not need to exist for their own backups — the message has to say so,
        because the folder is not reachable from a file picker on the desktop
        build."""
        import inspect

        source = inspect.getsource(backup_router._stream_upload_to_temp)
        assert "Backup history" in source, (
            "the 413 must point at the in-place restore, not just state a number"
        )

    def test_upload_staging_lands_in_the_backup_folder_not_os_temp(self):
        """`restore_from_backup` refuses to put its media payload in OS temp —
        "commonly size-capped tmpfs" — and this streamed the whole uploaded
        archive there. Same filesystem as the destination, and a name the backup
        list cannot mistake for a backup."""
        import inspect

        source = inspect.getsource(backup_router._stream_upload_to_temp)
        assert "dir=str(backup_dir)" in source
        assert 'suffix=".mmbackup"' not in source, (
            "a staging file ending .mmbackup is what left an unreadable orphan"
        )
