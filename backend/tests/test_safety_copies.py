"""The safety copies taken before a merge or an overwrite — named, written, listed,
downloaded and deleted in one place (#919).

What these guard, and why each is here:

- The WRITER and the LIST share one definition of a safety copy, so a copy the
  import writes is a copy Settings shows (`TestTheWriterAndTheListAgree`).
- A file carrying a safety copy's name is COMPLETE, and a second copy in the same
  second never destroys the first (`TestWriteSafetyCopy`).
- A request can reach safety copies and nothing else in the backup folder — never
  a rotated `.mmbackup`, never a path outside it (`TestFindSafetyCopy`).
- A copy that cannot be read is still listed: it takes disk space, and hiding it is
  the defect #919 exists to fix.
"""

import io
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine as shared_engine
from app.models.audit import AuditEntry
from app.models.project import Project
from app.models.user import User
from app.routers import backup as backup_router
from app.services import project_portability as pp
from app.services.safety_copies import (
    ACT_MERGE,
    ACT_MERGE_OR_OVERWRITE,
    ACT_OVERWRITE,
    SAFETY_COPY_PREFIXES,
    SafetyCopyNameError,
    find_safety_copy,
    list_safety_copies,
    safety_copy_filename,
    write_safety_copy,
)


def _archive(manifest: dict | None, extra: bytes = b"") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        if manifest is not None:
            zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("project.json", "{}" + extra.decode("latin-1"))
    return buf.getvalue()


def _copy(
    backup_dir: Path, filename: str, *, name: str | None = "Study",
    uuid: str | None = "u-1", version: str | None = "1.5.2", raw: bytes | None = None,
) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"format_type": "mmproject"}
    if name is not None:
        manifest["project_name"] = name
    if uuid is not None:
        manifest["project_uuid"] = uuid
    if version is not None:
        manifest["app_version"] = version
    path = backup_dir / filename
    path.write_bytes(raw if raw is not None else _archive(manifest))
    return path


# ── naming ────────────────────────────────────────────────────────────────


class TestSafetyCopyFilename:
    def test_the_name_is_the_acts_prefix_the_project_and_the_utc_second(self):
        when = datetime(2026, 9, 12, 10, 15, 30, tzinfo=timezone.utc)
        assert safety_copy_filename("pre-merge", 7, when) == "pre-merge_7_20260912_101530.mmproject"

    def test_an_unknown_prefix_is_refused(self):
        with pytest.raises(ValueError, match="SAFETY_COPY_PREFIXES"):
            safety_copy_filename("pre-rename", 7, datetime.now(timezone.utc))

    def test_every_prefix_the_writer_accepts_is_a_name_the_list_recognises(self, tmp_path):
        """The population is non-empty and each member round-trips through the list."""
        assert len(SAFETY_COPY_PREFIXES) >= 2
        when = datetime(2026, 9, 12, 10, 15, 30, tzinfo=timezone.utc)
        for prefix in SAFETY_COPY_PREFIXES:
            _copy(tmp_path, safety_copy_filename(prefix, 3, when))
        assert len(list_safety_copies(tmp_path)) == len(SAFETY_COPY_PREFIXES)


# ── writing ───────────────────────────────────────────────────────────────


class TestWriteSafetyCopy:
    NAME = "pre-merge_4_20260912_101530.mmproject"

    def test_writes_the_whole_payload_and_leaves_no_partial_file(self, tmp_path):
        path = write_safety_copy(tmp_path / "b", self.NAME, io.BytesIO(b"payload"))
        assert path.read_bytes() == b"payload"
        assert sorted(p.name for p in (tmp_path / "b").iterdir()) == [self.NAME]

    def test_a_failed_write_leaves_neither_the_copy_nor_a_partial(self, tmp_path, monkeypatch):
        """Written straight to its final name, a full disk left a truncated archive
        that the list would present as a recovery point."""
        def disk_full(_fd):
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(os, "fsync", disk_full)
        with pytest.raises(OSError):
            write_safety_copy(tmp_path, self.NAME, io.BytesIO(b"payload"))
        assert list(tmp_path.iterdir()) == []

    def test_the_list_cannot_see_a_copy_until_it_is_complete(self, tmp_path, monkeypatch):
        """The property a CRASH needs, where no cleanup runs: while the bytes are
        still being written, nothing carrying a safety copy's name exists.

        The failed-write test above cannot see this on its own — a writer that
        wrote straight to the final name and deleted it on error would pass it."""
        seen_mid_write: list[list[str]] = []
        real_fsync = os.fsync

        def observe(fd):
            seen_mid_write.append([c.filename for c in list_safety_copies(tmp_path)])
            real_fsync(fd)

        monkeypatch.setattr(os, "fsync", observe)
        write_safety_copy(tmp_path, self.NAME, io.BytesIO(_archive({"project_name": "x"})))
        assert seen_mid_write == [[]]
        assert [c.filename for c in list_safety_copies(tmp_path)] == [self.NAME]

    def test_a_second_copy_in_the_same_second_does_not_destroy_the_first(self, tmp_path):
        first = write_safety_copy(tmp_path, self.NAME, io.BytesIO(b"older state"))
        second = write_safety_copy(tmp_path, self.NAME, io.BytesIO(b"newer state"))
        third = write_safety_copy(tmp_path, self.NAME, io.BytesIO(b"newest"))
        assert first.read_bytes() == b"older state"
        assert second.name == "pre-merge_4_20260912_101530-2.mmproject"
        assert third.name == "pre-merge_4_20260912_101530-3.mmproject"
        assert len(list_safety_copies(tmp_path)) == 3

    def test_refuses_a_name_the_list_could_not_see(self, tmp_path):
        with pytest.raises(SafetyCopyNameError):
            write_safety_copy(tmp_path, "project-copy.mmproject", io.BytesIO(b"x"))


# ── listing ───────────────────────────────────────────────────────────────


class TestListSafetyCopies:
    def test_a_missing_folder_lists_nothing(self, tmp_path):
        assert list_safety_copies(tmp_path / "absent") == []

    def test_lists_only_safety_copies(self, tmp_path):
        _copy(tmp_path, "pre-merge_1_20260901_090000.mmproject")
        (tmp_path / "auto_20260901_090000.mmbackup").write_bytes(b"x")
        (tmp_path / "dev_20260901_090000.db").write_bytes(b"x")
        (tmp_path / "exported-study.mmproject").write_bytes(b"x")
        (tmp_path / ".pre-merge_1_20260901_100000.mmproject.partial").write_bytes(b"x")
        (tmp_path / "pre-merge_2_20260901_090000.mmproject").mkdir()
        assert [c.filename for c in list_safety_copies(tmp_path)] == [
            "pre-merge_1_20260901_090000.mmproject"
        ]

    def test_newest_first_by_the_time_in_the_name_not_the_file_time(self, tmp_path):
        """Copying the backup folder elsewhere resets modification times; the name
        was written in the same call as the file and is the record."""
        older = _copy(tmp_path, "pre-merge_1_20260101_090000.mmproject")
        newer = _copy(tmp_path, "pre-overwrite_1_20260601_090000.mmproject")
        os.utime(newer, (1_000_000, 1_000_000))
        os.utime(older, (2_000_000_000, 2_000_000_000))
        copies = list_safety_copies(tmp_path)
        assert [c.filename for c in copies] == [newer.name, older.name]
        assert copies[0].taken_at == "2026-06-01T09:00:00+00:00"

    def test_reads_the_project_name_and_identity_from_the_copy_itself(self, tmp_path):
        _copy(tmp_path, "pre-merge_9_20260901_090000.mmproject", name="Wave 2 interviews", uuid="abc")
        [copy] = list_safety_copies(tmp_path)
        assert copy.project_name == "Wave 2 interviews"
        assert copy.project_uuid == "abc"
        assert copy.readable is True
        assert copy.size_bytes == (tmp_path / copy.filename).stat().st_size

    def test_an_unreadable_copy_is_still_listed_and_says_so(self, tmp_path):
        _copy(tmp_path, "pre-merge_9_20260901_090000.mmproject", raw=b"truncated, not a zip")
        _copy(tmp_path, "pre-merge_9_20260902_090000.mmproject", raw=_archive(None))
        copies = list_safety_copies(tmp_path)
        assert len(copies) == 2
        for copy in copies:
            assert copy.readable is False
            assert copy.project_name is None
            assert copy.project_uuid is None
            assert copy.act == ACT_MERGE

    def test_a_pre_merge_copy_precedes_a_merge(self, tmp_path):
        _copy(tmp_path, "pre-merge_1_20260901_090000.mmproject", version="1.5.2")
        assert list_safety_copies(tmp_path)[0].act == ACT_MERGE

    @pytest.mark.parametrize("version,act", [
        ("1.5.2", ACT_OVERWRITE),
        # Numeric, not lexical: "1.10.0" < "1.5.2" as strings.
        ("1.10.0", ACT_OVERWRITE),
        ("2.0.0", ACT_OVERWRITE),
        ("1.5.1", ACT_MERGE_OR_OVERWRITE),
        ("1.4.0", ACT_MERGE_OR_OVERWRITE),
        (None, ACT_MERGE_OR_OVERWRITE),
        ("unknown", ACT_MERGE_OR_OVERWRITE),
    ])
    def test_an_older_builds_pre_overwrite_copy_may_precede_a_merge(self, tmp_path, version, act):
        """Before 1.5.2 a merge's copy was ALSO named `pre-overwrite`, so labelling
        such a file "before an overwrite" repeats the contradiction the rename fixed."""
        _copy(tmp_path, "pre-overwrite_1_20260901_090000.mmproject", version=version)
        assert list_safety_copies(tmp_path)[0].act == act


# ── resolving a filename from a request ───────────────────────────────────


class TestFindSafetyCopy:
    def test_resolves_an_existing_copy(self, tmp_path):
        path = _copy(tmp_path, "pre-merge_1_20260901_090000.mmproject")
        assert find_safety_copy(tmp_path, path.name) == path.resolve()

    @pytest.mark.parametrize("name", [
        "auto_20260901_090000.mmbackup",
        "manual_20260901_090000.mmbackup",
        "../pre-merge_1_20260901_090000.mmproject",
        "pre-merge_1_20260901_090000.mmproject/../../secret",
        "/etc/passwd",
        "pre-merge_1_20260901_090000.mmproject.partial",
        ".pre-merge_1_20260901_090000.mmproject.partial",
        "exported-study.mmproject",
        "",
    ])
    def test_refuses_anything_that_is_not_a_safety_copy(self, tmp_path, name):
        # Plant the rotated database backup so a too-wide matcher would find it.
        (tmp_path / "auto_20260901_090000.mmbackup").write_bytes(b"database")
        with pytest.raises(SafetyCopyNameError):
            find_safety_copy(tmp_path, name)

    def test_a_well_formed_name_with_no_file_is_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            find_safety_copy(tmp_path, "pre-merge_1_20260901_090000.mmproject")


# ── the writer and the list agree ─────────────────────────────────────────


class TestTheWriterAndTheListAgree:
    def _project(self, db_session) -> Project:
        project = Project(name="Community health study", user_id=1)
        db_session.add(project)
        db_session.commit()
        return project

    @pytest.mark.parametrize("prefix,act", [("pre-merge", ACT_MERGE), ("pre-overwrite", ACT_OVERWRITE)])
    def test_the_import_writes_a_copy_that_the_list_shows(self, db_session, tmp_path, monkeypatch, prefix, act):
        project = self._project(db_session)
        monkeypatch.setattr(pp, "get_backup_dir", lambda: tmp_path / "backups")
        report: dict = {}
        path = pp._safety_export_before_overwrite(
            db_session, project, tmp_path / "docs", tmp_path / "media",
            prefix=prefix, safety_report=report,
        )
        [copy] = list_safety_copies(tmp_path / "backups")
        assert copy.filename == path.name == report["filename"]
        assert copy.project_name == "Community health study"
        assert copy.project_uuid == project.project_uuid
        assert copy.readable is True
        assert copy.act == act

    def test_an_unknown_prefix_is_a_programming_error_not_a_backup_failure(self, db_session, tmp_path, monkeypatch):
        """Inside the export's `try` it would reach the researcher as "Could not
        create a safety backup … aborting to protect your data"."""
        project = self._project(db_session)
        monkeypatch.setattr(pp, "get_backup_dir", lambda: tmp_path / "backups")
        with pytest.raises(ValueError) as exc:
            pp._safety_export_before_overwrite(
                db_session, project, tmp_path / "docs", tmp_path / "media", prefix="pre-rename",
            )
        assert "Could not create a safety backup" not in str(exc.value)
        assert not (tmp_path / "backups").exists() or list((tmp_path / "backups").iterdir()) == []


# ── the endpoints, called directly ────────────────────────────────────────


@pytest.fixture()
def backup_dir(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "backups"
    path.mkdir()
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: path)
    return path


def _user(db_session) -> User:
    return db_session.query(User).filter(User.id == 1).one()


class TestSafetyCopyEndpoints:
    def test_the_list_says_whether_the_project_is_still_here(self, db_session, backup_dir):
        present = Project(name="Still here", user_id=1)
        db_session.add(present)
        db_session.commit()
        _copy(backup_dir, "pre-merge_1_20260903_090000.mmproject", name="Still here", uuid=present.project_uuid)
        _copy(backup_dir, "pre-merge_2_20260902_090000.mmproject", name="Deleted since", uuid="gone-uuid")
        _copy(backup_dir, "pre-merge_3_20260901_090000.mmproject", raw=b"damaged")

        rows = backup_router.safety_copy_list(user=_user(db_session), db=db_session)
        assert [(r.project_name, r.project_in_app, r.readable) for r in rows] == [
            ("Still here", True, True),
            ("Deleted since", False, True),
            (None, None, False),
        ]

    def test_download_serves_the_file_under_its_own_name(self, db_session, backup_dir):
        path = _copy(backup_dir, "pre-overwrite_5_20260901_090000.mmproject")
        response = backup_router.safety_copy_download(path.name, user=_user(db_session))
        assert Path(response.path) == path.resolve()
        assert path.name in response.headers["content-disposition"]

    @pytest.mark.parametrize("call", ["download", "delete"])
    def test_a_rotated_database_backup_cannot_be_reached(self, db_session, backup_dir, call):
        target = backup_dir / "auto_20260901_090000.mmbackup"
        target.write_bytes(b"the whole database")
        with pytest.raises(HTTPException) as exc:
            if call == "download":
                backup_router.safety_copy_download(target.name, user=_user(db_session))
            else:
                backup_router.safety_copy_delete(target.name, user=_user(db_session), db=db_session)
        assert exc.value.status_code == 400
        assert target.read_bytes() == b"the whole database"

    def test_delete_removes_the_file_and_records_it(self, db_session, backup_dir):
        path = _copy(backup_dir, "pre-merge_1_20260901_090000.mmproject")
        keep = _copy(backup_dir, "pre-merge_1_20260902_090000.mmproject")
        size = path.stat().st_size

        backup_router.safety_copy_delete(path.name, user=_user(db_session), db=db_session)

        assert not path.exists()
        assert keep.exists()
        [entry] = db_session.query(AuditEntry).filter(AuditEntry.action == "safety_copy_deleted").all()
        assert json.loads(entry.details) == {"filename": path.name, "size_bytes": size}

    def test_deleting_a_copy_that_is_gone_is_not_found(self, db_session, backup_dir):
        with pytest.raises(HTTPException) as exc:
            backup_router.safety_copy_delete(
                "pre-merge_1_20260901_090000.mmproject", user=_user(db_session), db=db_session,
            )
        assert exc.value.status_code == 404

    def test_a_file_the_system_will_not_delete_says_why(self, db_session, backup_dir, monkeypatch):
        path = _copy(backup_dir, "pre-merge_1_20260901_090000.mmproject")

        def locked(self, missing_ok=False):
            raise PermissionError(13, "The process cannot access the file")

        monkeypatch.setattr(Path, "unlink", locked)
        with pytest.raises(HTTPException) as exc:
            backup_router.safety_copy_delete(path.name, user=_user(db_session), db=db_session)
        assert exc.value.status_code == 409
        assert "open in another program" in exc.value.detail
        assert db_session.query(AuditEntry).filter(AuditEntry.action == "safety_copy_deleted").count() == 0


# ── over HTTP: the routes resolve a filename that contains dots ───────────


@pytest.fixture()
def http_client(tmp_path, monkeypatch):
    path = tmp_path / "backups"
    path.mkdir()
    monkeypatch.setattr(backup_router, "get_backup_dir", lambda: path)
    Base.metadata.create_all(bind=shared_engine)
    from app.main import app as fastapi_app

    with TestClient(fastapi_app, raise_server_exceptions=False) as client:
        yield client, path
    Base.metadata.drop_all(bind=shared_engine)


class TestSafetyCopiesOverHttp:
    def test_list_download_and_delete(self, http_client):
        client, folder = http_client
        status = client.get("/api/auth/status")
        assert status.status_code == 200
        headers = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
        path = _copy(folder, "pre-merge_1_20260901_090000.mmproject", name="Över the wire")

        listed = client.get("/api/backup/safety-copies")
        assert listed.status_code == 200, listed.text
        [row] = listed.json()
        assert row["filename"] == path.name
        assert row["project_name"] == "Över the wire"
        assert row["taken_at"].endswith("+00:00")

        download = client.get(f"/api/backup/safety-copies/{path.name}")
        assert download.status_code == 200
        assert download.content == path.read_bytes()

        deleted = client.delete(f"/api/backup/safety-copies/{path.name}", headers=headers)
        assert deleted.status_code == 204, deleted.text
        assert not path.exists()
        db = SessionLocal()
        try:
            assert db.query(AuditEntry).filter(AuditEntry.action == "safety_copy_deleted").count() == 1
        finally:
            db.close()
