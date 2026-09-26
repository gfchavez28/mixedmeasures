"""#1027 — an imported coder must never become this install's active identity.

**The defect (confirmed by execution in the 2026-09-24 audit, and first-hand here).**
A `.mmproject` exported every `User` column but `password_hash`, and the import
created a coder by REFLECTION, so a colleague's `last_active_at` — a fact about
THEIR install ("I last switched to this coder at 14:02") — arrived as a fact about
THIS one. `auth.ensure_default_user` picks the coder with the newest non-null
`last_active_at` whenever a session is missing (sessions last 24 h; a restore also
drops them), and a researcher who never switched coder holds NULL, which sorts
LAST. So the next morning the app silently opened as the colleague, and every
coding from then on was attributed to them. The only visible sign was the name in
the top bar.

**What each half of the fix answers:**

- the IMPORT keeps only the fields that describe the coder
  (`project_portability.CODER_PORTABLE_FIELDS`) — including from files already in
  the wild, which still carry `last_active_at`;
- the EXPORT writes only those fields, so new files do not carry it at all;
- `ensure_default_user` trusts `last_active_at` only for a coder someone actually
  SWITCHED TO on this install (the `coder_switched` audit entry, which never travels
  in a project file) — which is what repairs an install that imported a file before
  this fix, with no data migration.
"""
from __future__ import annotations

import json
import os
import uuid
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import inspect as sa_inspect

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.auth import ensure_default_user
from app.models.audit import AuditEntry
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.project_portability import (
    CODER_INSTALL_FIELDS,
    CODER_PORTABLE_FIELDS,
    export_project,
    import_project,
)
from tests.archive_support import archive_payload, write_archive


LOCAL = "Researcher"
COLLEAGUE = "Colleague"
#: A moment on the COLLEAGUE's install, later than anything that happens here.
THEIR_LAST_SWITCH = datetime(2031, 1, 1, 9, 0, 0)


@pytest.fixture
def db():
    """An install with ONE local coder who has never switched coder (NULL recency) —
    the default install, and the one the defect bites."""
    from app.database import Base, engine, SessionLocal
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    session.add(User(id=1, username=LOCAL, password_hash="x", is_admin=True))
    session.flush()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
        Base.metadata.drop_all(bind=engine)


def _colleagues_file(db, tmp_path: Path, *, carry_recency: bool) -> tuple[Project, Path]:
    """A shared project, exported with a colleague's coding, the colleague then gone
    from this install — so importing the file CREATES their coder. The project stays,
    with the same identity, so the file can also be MERGED back into it.

    ``carry_recency`` rewrites the archive so its coder entry carries
    ``last_active_at`` — the shape of every file exported before this fix. The
    colleague's coder has ``is_admin`` set too, which must not travel either.
    """
    colleague = User(
        id=2, username=COLLEAGUE, password_hash="x", is_admin=True, coder_type="human",
        display_color="#123456", last_active_at=THEIR_LAST_SWITCH,
    )
    db.add(colleague)
    p = Project(name="Shared study", status="active", user_id=1, project_uuid=str(uuid.uuid4()))
    db.add(p)
    db.flush()
    conv = Conversation(project_id=p.id, name="Interview 1", status="completed")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="A passage.")
    code = Code(project_id=p.id, numeric_id=1, name="Theme", is_active=True)
    db.add_all([seg, code])
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=2, origin="human"))
    db.flush()

    exported = tmp_path / "colleague.mmproject"
    exported.write_bytes(export_project(db, p.id, tmp_path / "docs").getvalue())

    # The colleague, and their coding, exist only in the file now.
    db.query(CodeApplication).filter(CodeApplication.user_id == 2).delete()
    db.delete(colleague)
    db.flush()

    if not carry_recency:
        return p, exported
    with zipfile.ZipFile(exported) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    payload = archive_payload(exported)
    for coder in payload["coders"]:
        coder["last_active_at"] = THEIR_LAST_SWITCH.isoformat()
        coder["is_admin"] = True
    legacy = tmp_path / "legacy.mmproject"
    write_archive(legacy, manifest, payload)
    return p, legacy


def _imported_colleague(db) -> User:
    return db.query(User).filter(User.username.like(f"{COLLEAGUE}%")).one()


class TestTheImportDoesNotHandOverTheInstall:
    """The symptom, entered where the researcher meets it: the default coder."""

    @pytest.mark.parametrize("carry_recency", [True, False], ids=["legacy file", "new file"])
    def test_the_local_researcher_stays_the_default_coder(self, db, tmp_path, carry_recency):
        assert ensure_default_user(db).username == LOCAL  # positive control, before
        _, f = _colleagues_file(db, tmp_path, carry_recency=carry_recency)
        import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()
        # The audit's observation was the COLLEAGUE here (id 3 in its fixture).
        assert ensure_default_user(db).username == LOCAL

    def test_a_legacy_files_recency_does_not_land(self, db, tmp_path):
        _, f = _colleagues_file(db, tmp_path, carry_recency=True)
        import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()
        colleague = _imported_colleague(db)
        assert colleague.last_active_at is None
        assert colleague.is_admin is False

    @pytest.mark.parametrize("decision", [None, {"action": "create"}], ids=["silent", "create"])
    def test_a_merge_creates_the_coder_without_it_too(self, db, tmp_path, decision):
        """The merge door, both ways it can create a coder: no decision for a coder
        the install does not know (the silent name-match miss), and the D8 confirm
        step's "this is a different person"."""
        p, f = _colleagues_file(db, tmp_path, carry_recency=True)
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id,
            coder_mapping={"2": decision} if decision else None,
        )
        db.flush()
        assert _imported_colleague(db).last_active_at is None
        assert ensure_default_user(db).username == LOCAL


class TestWhatStillTravels:
    """The coder's IDENTITY still arrives; only this-install facts stay behind."""

    def test_identity_fields_round_trip(self, db, tmp_path):
        _, f = _colleagues_file(db, tmp_path, carry_recency=False)
        import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()
        colleague = _imported_colleague(db)
        assert colleague.username == COLLEAGUE
        assert colleague.display_color == "#123456"
        assert colleague.coder_type == "human"
        assert colleague.archived is False
        # And their coding is attributed to them, which is the point of carrying them.
        assert db.query(CodeApplication).filter(
            CodeApplication.user_id == colleague.id
        ).count() == 1

    def test_the_export_writes_only_the_portable_fields(self, db, tmp_path):
        _, f = _colleagues_file(db, tmp_path, carry_recency=False)
        (coder,) = archive_payload(f)["coders"]
        assert set(coder) == set(CODER_PORTABLE_FIELDS) | {"_original_id"}
        assert "last_active_at" not in coder and "is_admin" not in coder


class TestEveryCoderColumnIsClassified:
    """A new `User` column must be DECIDED: does it describe the coder, or this install?

    The export used to take every column but one, so `last_active_at` travelled by
    default. The opposite default is no safer — a new identity field (as
    `machine_provenance` was) would silently fail to arrive. So neither is a
    default: every column is in exactly one set, and a new one fails here.
    """

    def test_the_two_sets_partition_the_model(self):
        columns = set(sa_inspect(User).columns.keys())
        portable, install = set(CODER_PORTABLE_FIELDS), set(CODER_INSTALL_FIELDS)
        assert not (portable & install), "a field cannot be both"
        assert portable | install == columns, (
            f"unclassified User column(s): {sorted(columns - portable - install)} — add each "
            "to CODER_PORTABLE_FIELDS (it describes the coder and must travel with their "
            "coding) or CODER_INSTALL_FIELDS (it is a fact about the install that held it)"
        )

    def test_the_install_facts_include_the_ones_that_bit(self):
        assert {"last_active_at", "password_hash", "is_admin", "id"} <= set(CODER_INSTALL_FIELDS)


class TestTheDefaultCoderTrustsOnlyThisInstallsSwitches:
    """The repair for installs that imported a file BEFORE this fix: the stored
    recency is still there, but only a switch made HERE can vouch for it."""

    # ⚠️ The action is spelled as a LITERAL here, not through `CODER_SWITCHED_ACTION`,
    # on purpose: every install already holds audit rows with exactly this string, so
    # a rename of the constant must fail these tests rather than quietly stop every
    # existing switch from vouching.

    def _coder(self, db, uid, name, last_active_at=None, switched_here=False):
        db.add(User(id=uid, username=name, password_hash=None, is_admin=False,
                    coder_type="human", last_active_at=last_active_at))
        if switched_here:
            db.add(AuditEntry(user_id=uid, action="coder_switched", entity_type="user",
                              entity_id=uid, details="{}"))
        db.flush()

    def test_an_imported_recency_is_ignored(self, db):
        self._coder(db, 2, COLLEAGUE, last_active_at=THEIR_LAST_SWITCH)
        assert ensure_default_user(db).username == LOCAL

    def test_a_switch_made_here_still_wins(self, db):
        """POSITIVE CONTROL — the J1 fix this must not undo: a coder switched to on
        this install survives session loss."""
        self._coder(db, 2, "Bea", last_active_at=datetime(2026, 1, 1), switched_here=True)
        assert ensure_default_user(db).username == "Bea"

    def test_the_most_recent_switch_here_wins_over_an_older_one(self, db):
        self._coder(db, 2, "Bea", last_active_at=datetime(2026, 1, 1), switched_here=True)
        self._coder(db, 3, "Cal", last_active_at=datetime(2026, 1, 2), switched_here=True)
        assert ensure_default_user(db).username == "Cal"

    def test_an_imported_recency_does_not_outrank_a_real_one(self, db):
        """The mixed install: a colleague's newer timestamp arrived by file, and a
        local coder was genuinely switched to earlier."""
        self._coder(db, 2, "Bea", last_active_at=datetime(2026, 1, 1), switched_here=True)
        self._coder(db, 3, COLLEAGUE, last_active_at=THEIR_LAST_SWITCH)
        assert ensure_default_user(db).username == "Bea"

    def test_a_switch_to_someone_ELSE_does_not_vouch_for_them(self, db):
        """The entry vouches for the coder it NAMES. With a switch on record for the
        local researcher only, the colleague — whose name sits in `details.from` on
        that very row — is still unvouched. (A predicate that asked only "has anyone
        switched here?" would pass the tests above and fail this one.)"""
        self._coder(db, 2, COLLEAGUE, last_active_at=THEIR_LAST_SWITCH)
        db.add(AuditEntry(user_id=1, action="coder_switched", entity_type="user",
                          entity_id=1, details=json.dumps({"from": 2, "to": 1})))
        db.flush()
        assert ensure_default_user(db).username == LOCAL

    def test_an_entry_about_another_KIND_of_entity_does_not_vouch(self, db):
        """`entity_id` is a user id only on a `user` entry. No writer puts this action
        on another kind today; the clause is what keeps an id collision from becoming
        a vouch the day one does."""
        self._coder(db, 2, COLLEAGUE, last_active_at=THEIR_LAST_SWITCH)
        db.add(AuditEntry(user_id=1, action="coder_switched", entity_type="project",
                          entity_id=2, details="{}"))
        db.flush()
        assert ensure_default_user(db).username == LOCAL

    def test_other_audit_actions_on_the_coder_do_not_vouch(self, db):
        self._coder(db, 2, COLLEAGUE, last_active_at=THEIR_LAST_SWITCH)
        db.add(AuditEntry(user_id=1, action="coder_updated", entity_type="user",
                          entity_id=2, details="{}"))
        db.flush()
        assert ensure_default_user(db).username == LOCAL

    def test_with_nobody_switched_to_the_lowest_id_is_the_default(self, db):
        """Unchanged from J1: no recency anywhere falls back to id order."""
        self._coder(db, 2, "Bea", last_active_at=datetime(2025, 1, 1) + timedelta(days=1))
        assert ensure_default_user(db).username == LOCAL
