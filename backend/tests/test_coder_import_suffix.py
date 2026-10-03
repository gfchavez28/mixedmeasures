"""#1071 — a file coder renamed because its name is taken must not take ANOTHER
file coder's name.

#1034 made a refused name-match create the file's coder under a suffix
(`unique_username`). The suffix was chosen against the DATABASE only, so it
could equal the next file coder's own name — which the silent name-match then
looked up and found: the row this import had just created. Two runs of a model
(the coding import itself names a second run "GPT-4o (2)") became one coder, or
the insert died on the per-coder unique index. Every file coder's name is now
reserved before any is suffixed, in the import AND in the merge preview.

⚠️ The fixture needs a local coder holding the base name with a DIFFERENT
configuration: `test_merge_coder_kind.py` used one-coder files and could not
reach this.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import machine_coder
from app.services.project_portability import (
    build_merge_coder_preview,
    export_project,
    import_project,
)

RECORDED = {"model": "gpt-4o-2024-08-06", "access": "api"}


def _file(db, tmp_path: Path, *, overlap: bool, kind: str = "ai") -> Path:
    """A colleague's project coded by two runs 'GPT-4o' and 'GPT-4o (2)' (the
    same, unrecorded configuration). Their rows are removed after export, so the
    database then stands for THIS install."""
    run1 = User(id=2, username="GPT-4o", password_hash=None, coder_type=kind)
    run2 = User(id=3, username="GPT-4o (2)", password_hash=None, coder_type=kind)
    db.add_all([run1, run2])
    project = Project(name="Study", status="active", user_id=1, project_uuid=str(uuid.uuid4()))
    db.add(project)
    db.flush()
    conv = Conversation(project_id=project.id, name="Interview", status="completed")
    db.add(conv)
    db.flush()
    s1 = Segment(conversation_id=conv.id, sequence_order=0, text="A passage.")
    s2 = Segment(conversation_id=conv.id, sequence_order=1, text="Another passage.")
    code = Code(project_id=project.id, numeric_id=1, name="Theme", is_active=True)
    db.add_all([s1, s2, code])
    db.flush()
    db.add(CodeApplication(segment_id=s1.id, code_id=code.id, user_id=2, origin="human"))
    db.add(CodeApplication(segment_id=(s1.id if overlap else s2.id), code_id=code.id,
                           user_id=3, origin="human"))
    db.flush()
    archive = tmp_path / "file.mmproject"
    archive.write_bytes(export_project(db, project.id, tmp_path / "docs").getvalue())
    db.query(CodeApplication).filter(CodeApplication.user_id.in_([2, 3])).delete()
    db.delete(run1)
    db.delete(run2)
    db.flush()
    return archive


def _local_gpt(db, kind="ai") -> User:
    """THIS install's 'GPT-4o' — a RECORDED configuration, so the file's refuses it."""
    local = User(id=50, username="GPT-4o", password_hash=None, coder_type=kind)
    if kind == "ai":
        machine_coder.write_provenance(local, RECORDED)
    db.add(local)
    db.flush()
    return local


def _attribution(db, pid) -> dict[str, int]:
    rows = (
        db.query(User.username, CodeApplication.id)
        .join(CodeApplication, CodeApplication.user_id == User.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .filter(Code.project_id == pid)
        .all()
    )
    out: dict[str, int] = {}
    for name, _ in rows:
        out[name] = out.get(name, 0) + 1
    return out


class TestTwoFileCodersStayTwo:
    @pytest.mark.parametrize("overlap", [False, True])
    def test_two_runs_of_one_model(self, db_session, tmp_path, overlap):
        """Disjoint codings used to COLLAPSE; overlapping ones died on the unique
        index. Either way the two runs stay two coders."""
        db = db_session
        archive = _file(db, tmp_path, overlap=overlap)
        _local_gpt(db)
        pid, _ = import_project(db, archive, tmp_path / "i", user_id=1)
        db.flush()
        assert _attribution(db, pid) == {"GPT-4o (3)": 1, "GPT-4o (2)": 1}
        # The local run with the RECORDED configuration was matched by neither.
        assert _attribution(db, pid).get("GPT-4o") is None

    def test_two_people_beside_a_local_model_holding_the_name(self, db_session, tmp_path):
        db = db_session
        archive = _file(db, tmp_path, overlap=False, kind="human")
        _local_gpt(db, kind="ai")
        pid, _ = import_project(db, archive, tmp_path / "i", user_id=1)
        db.flush()
        assert _attribution(db, pid) == {"GPT-4o (3)": 1, "GPT-4o (2)": 1}

    def test_control_without_a_local_collision(self, db_session, tmp_path):
        db = db_session
        archive = _file(db, tmp_path, overlap=True)
        pid, _ = import_project(db, archive, tmp_path / "i", user_id=1)
        db.flush()
        assert _attribution(db, pid) == {"GPT-4o": 1, "GPT-4o (2)": 1}


class TestThePreviewNamesWhatTheImportWrites:
    def test_the_suffixed_name_is_the_one_created(self, db_session, tmp_path):
        """The confirm screen says what each coder will be called; the import —
        through the explicit create a screen sends — must write exactly that."""
        db = db_session
        archive = _file(db, tmp_path, overlap=False)
        _local_gpt(db)
        preview = {row["username"]: row for row in build_merge_coder_preview(db, archive)}

        assert preview["GPT-4o"]["name_in_use"]["new_username"] == "GPT-4o (3)"
        assert preview["GPT-4o (2)"]["name_in_use"] is None
        assert preview["GPT-4o (2)"]["local_match"] is None

        mapping = {
            str(row["original_id"]): {
                "action": "create",
                "new_username": (row["name_in_use"] or {}).get("new_username") or row["username"],
            }
            for row in preview.values()
        }
        pid, _ = import_project(db, archive, tmp_path / "i", user_id=1,
                                import_mode="new", coder_mapping=mapping)
        db.flush()
        assert set(_attribution(db, pid)) == {"GPT-4o (3)", "GPT-4o (2)"}


class TestAnExplicitCreateReservesTheFileNamesToo:
    def test_a_typed_name_equal_to_another_file_coder_is_suffixed(self, db_session, tmp_path):
        """The confirm screen lets a name be TYPED. One equal to another file
        coder's name would be found by that coder's silent name-match — the same
        collapse through the other door."""
        db = db_session
        archive = _file(db, tmp_path, overlap=False)
        _local_gpt(db)
        preview = {row["username"]: row for row in build_merge_coder_preview(db, archive)}
        # Only the first coder gets a decision — "GPT-4o (2)" typed for it; the
        # second takes the silent path.
        mapping = {str(preview["GPT-4o"]["original_id"]): {"action": "create", "new_username": "GPT-4o (2)"}}
        pid, _ = import_project(db, archive, tmp_path / "i", user_id=1,
                                import_mode="new", coder_mapping=mapping)
        db.flush()
        assert _attribution(db, pid) == {"GPT-4o (2) (2)": 1, "GPT-4o (2)": 1}
