"""#1606 — where the person's data still is that a withdrawal does not reach (D234, D235).

The withdrawal's list of copies named backups, safety copies and exported files, and left
out two kinds that hold everything: a project duplicated from this one BEFORE the
withdrawal (its own record is empty, so nothing stops it being copied on), and the copies
of the whole database taken before each update (in the backup folder, which Settings does
not list). The report — and the withdraw endpoint's answer, for the note after — now name
both:

- `other_projects_with_identifier` (D234): the other projects here holding a participant
  with the same ID under the withdrawal record's rule (D227: any canonically equivalent
  Unicode form, capitals kept), a Duplicate flagged in either direction from the
  `project_duplicate` audit entries, copies first, capped at 20 with the total;
- `pre_update_copies` (D235): how many of THIS database's pre-update copies the backup
  folder holds — `database.is_pre_migration_copy_of`, the rotation's own predicate — and
  the folder, which is returned to the page and NEVER stored (the audit entry travels in
  every export).
"""

import json
import pathlib
import unicodedata

import pytest
from sqlalchemy import text

from app.config import get_settings
from app.database import SessionLocal
from app.models.audit import AuditEntry
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.services.withdrawal_report import (
    OTHER_PROJECTS_CAP, build_withdrawal_report, other_projects_with_identifier,
    pre_update_copies,
)
from tests.test_merge_brings_back import build_world, client, ok  # noqa: F401


def _project(db, name, *idents, user_id=1):
    p = Project(name=name, user_id=user_id)
    db.add(p)
    db.flush()
    for ident in idents:
        db.add(Participant(project_id=p.id, identifier=ident))
    db.flush()
    return p


def _duplicated(db, copy, source, details=None):
    """The entry a Duplicate writes in the COPY's trail (`routers/project_portability.py`)."""
    db.add(AuditEntry(
        user_id=1, action="project_duplicate", entity_type="project", entity_id=copy.id,
        project_id=copy.id,
        details=details if details is not None else json.dumps({"source_project_id": source.id}),
    ))
    db.flush()


def _listed(result):
    return [(p.name, p.copy_relation) for p in result.projects]


class TestOtherProjects:
    def test_the_same_id_in_either_unicode_form_is_found_and_capitals_count(self, db_session):
        db = db_session
        composed = unicodedata.normalize("NFC", "José")
        here = _project(db, "Here", composed)
        _project(db, "Decomposed", unicodedata.normalize("NFD", "José"))
        _project(db, "Padded", f"  {composed} ")
        _project(db, "Lower case", composed.lower())   # DEC-2: `josé` is another ID
        _project(db, "Longer", composed + "2")           # `instr` finds it; the rule does not
        _project(db, "Unrelated", "P01")
        got = other_projects_with_identifier(db, here.id, composed)
        assert _listed(got) == [("Decomposed", None), ("Padded", None)]
        assert got.total == 2
        # Asked the other way round, the decomposed ID finds the composed one too.
        dec = db.query(Project).filter_by(name="Decomposed").one()
        assert ("Here", None) in _listed(
            other_projects_with_identifier(db, dec.id, unicodedata.normalize("NFD", "José")))

    def test_this_project_is_never_listed(self, db_session):
        db = db_session
        here = _project(db, "Here", "P01", "P01 ")  # a stray twin in the same project
        assert other_projects_with_identifier(db, here.id, "P01").total == 0

    def test_a_duplicate_is_flagged_in_either_direction_and_listed_first(self, db_session):
        db = db_session
        here = _project(db, "Here", "M01")
        copy = _project(db, "Zeta copy", "M01")
        source = _project(db, "Mid original", "M01")
        _project(db, "Alpha", "M01")
        _duplicated(db, copy, here)       # Zeta copy was duplicated FROM here
        _duplicated(db, here, source)     # here was duplicated from Mid original
        got = other_projects_with_identifier(db, here.id, "M01")
        assert _listed(got) == [
            ("Mid original", "source"), ("Zeta copy", "copy"), ("Alpha", None)]

    def test_an_entry_it_cannot_read_links_nothing(self, db_session):
        db = db_session
        here = _project(db, "Here", "M01")
        a = _project(db, "A", "M01")
        b = _project(db, "B", "M01")
        _duplicated(db, a, here, details="not json")
        _duplicated(db, b, here, details=json.dumps({"source_project_id": str(here.id)}))
        # This project's OWN entry naming something that is not an id (a list is not even
        # hashable) — never a crash on the report a withdrawal reads.
        _duplicated(db, here, a, details=json.dumps({"source_project_id": [a.id]}))
        assert _listed(other_projects_with_identifier(db, here.id, "M01")) == [
            ("A", None), ("B", None)]

    def test_a_duplicate_link_alone_lists_nothing_without_the_id(self, db_session):
        """The flag is about projects ALREADY found by the ID — a copy whose person was
        renamed is a stated miss, not something the audit trail can invent."""
        db = db_session
        here = _project(db, "Here", "M01")
        renamed = _project(db, "Copy, renamed", "M01-renamed")
        _duplicated(db, renamed, here)
        assert other_projects_with_identifier(db, here.id, "M01").total == 0

    def test_the_list_is_capped_and_the_total_counts_every_one(self, db_session):
        db = db_session
        here = _project(db, "Here", "P01")
        for i in range(OTHER_PROJECTS_CAP + 5):
            _project(db, f"Study {i:02d}", "P01")
        got = other_projects_with_identifier(db, here.id, "P01")
        assert got.total == OTHER_PROJECTS_CAP + 5
        assert [p.name for p in got.projects] == [f"Study {i:02d}" for i in range(OTHER_PROJECTS_CAP)]

    def test_with_accounts_on_only_the_owners_projects_are_named(self, db_session, monkeypatch):
        """The ownership gate's own predicate (`apply_project_owner_filter`). Off — the
        default, a shared local roster — every project on the install is the user's;
        on, another account's project is not this report's to name."""
        db = db_session
        db.add(User(id=2, username="other", password_hash="x"))
        db.flush()
        here = _project(db, "Here", "P01")
        _project(db, "Mine", "P01")
        _project(db, "Theirs", "P01", user_id=2)
        assert _listed(other_projects_with_identifier(db, here.id, "P01")) == [
            ("Mine", None), ("Theirs", None)]
        monkeypatch.setattr(get_settings(), "mm_multiuser_auth_enabled", True)
        assert _listed(other_projects_with_identifier(db, here.id, "P01")) == [("Mine", None)]

    def test_the_report_carries_it_outside_total_items(self, db_session):
        db = db_session
        here = _project(db, "Here", "P01")
        _project(db, "Other", "P01")
        subject = db.query(Participant).filter_by(project_id=here.id).one()
        report = build_withdrawal_report(db, subject)
        assert [p.name for p in report.other_projects_with_identifier.projects] == ["Other"]
        assert report.total_items == 1  # the record itself; the other project is not reached


class TestPreUpdateCopies:
    @pytest.fixture
    def folder(self, tmp_path, monkeypatch):
        backups = tmp_path / "backups"
        backups.mkdir()
        settings = get_settings()
        monkeypatch.setattr(settings, "mm_backup_dir", str(backups))
        monkeypatch.setattr(settings, "mm_database_path", str(tmp_path / "study.db"))
        return backups

    def test_counts_this_databases_copies_only(self, folder):
        for name in (
            "study_20260101_000000.db", "study_20261101_120000.db",   # this database's
            "study_bes_20260101_000000.db",            # another database's (#1039 e)
            "study_20260101_000000.db-wal",            # a side file
            ".study_20261113_000000.db.partial",       # a copy being written
            "auto_backup_20261113_000000.mmbackup",    # a backup Settings lists
            "study.db",                                # a database parked there
        ):
            (folder / name).write_bytes(b"x")
        got = pre_update_copies()
        assert got.count == 2
        assert got.folder == str(folder.absolute())

    def test_the_folder_is_shown_absolute_when_the_setting_is_relative(self, folder, monkeypatch):
        monkeypatch.chdir(folder.parent)
        monkeypatch.setattr(get_settings(), "mm_backup_dir", "backups")
        (folder / "study_20260101_000000.db").write_bytes(b"x")
        got = pre_update_copies()
        assert got.count == 1
        assert pathlib.Path(got.folder).is_absolute()
        assert got.folder == str(folder.absolute())

    def test_no_folder_yet_is_none(self, folder):
        folder.rmdir()
        assert pre_update_copies().count == 0

    def test_a_folder_it_cannot_read_is_unknown_never_zero(self, folder, monkeypatch):
        (folder / "study_20260101_000000.db").write_bytes(b"x")

        def refuse(self):
            raise PermissionError(13, "Permission denied", str(self))

        monkeypatch.setattr(pathlib.Path, "iterdir", refuse)
        got = pre_update_copies()
        assert got.count is None
        assert got.folder == str(folder.absolute())


def _q(sql, **params):
    db = SessionLocal()
    try:
        return db.execute(text(sql), params).fetchall()
    finally:
        db.close()


class TestThroughTheApp:
    """Through `TestClient`, so FastAPI's `response_model` runs on the report (#1123's
    class), and the withdraw endpoint is asked what it returns AND what it stores."""

    def test_a_duplicate_made_before_is_named_and_the_folder_is_never_stored(self, client):
        k = client
        ids = build_world(k)
        pid, m01 = ids["pid"], ids["P"]["M01"]
        dup = ok(k.c.post(f"/api/projects/{pid}/duplicate", headers=k.H))
        report = ok(k.c.get(f"/api/projects/{pid}/participants/{m01}/withdrawal-report"))
        named = report["other_projects_with_identifier"]
        assert named == {"projects": [{
            "project_id": dup["project_id"], "name": dup["project_name"],
            "copy_relation": "copy"}], "total": 1}
        folder = report["pre_update_copies"]["folder"]
        assert folder and report["pre_update_copies"]["count"] == 0

        done = ok(k.c.post(f"/api/projects/{pid}/participants/{m01}/withdraw", headers=k.H))
        assert done["other_projects_with_identifier"] == named
        assert done["pre_update_copies"] == report["pre_update_copies"]
        # Never stored: the entry travels in every export and the Excel Audit Trail.
        (details,) = _q(
            "SELECT details FROM audit_entries WHERE project_id=:p AND action='withdrawn'",
            p=pid)[0]
        stored = json.loads(details)
        assert "other_projects_with_identifier" not in stored
        assert "pre_update_copies" not in stored
        assert folder not in details
        assert stored["identifier"] == "M01"  # the entry is the one asked about

    def test_a_withdrawal_in_the_copy_names_the_original(self, client):
        k = client
        ids = build_world(k)
        pid = ids["pid"]
        dup = ok(k.c.post(f"/api/projects/{pid}/duplicate", headers=k.H))
        (copy_m01,) = _q(
            "SELECT id FROM participants WHERE project_id=:p AND identifier='M01'",
            p=dup["project_id"])[0]
        report = ok(k.c.get(
            f"/api/projects/{dup['project_id']}/participants/{copy_m01}/withdrawal-report"))
        (original,) = report["other_projects_with_identifier"]["projects"]
        assert original["project_id"] == pid and original["copy_relation"] == "source"
