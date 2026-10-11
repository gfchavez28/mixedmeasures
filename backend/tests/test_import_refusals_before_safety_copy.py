"""#1150 (a) — a `.mmproject` the import REFUSES writes no safety copy.

A merge or an overwrite writes a full `.mmproject` of the target first
(`_safety_export_before_overwrite`), and nothing rotates those copies (#919). Five
refusals ran AFTER it, so each refused attempt left one more full copy behind, for a
file that changed nothing — and the merge branch's own comment promises *"no safety
backup is written for a merge that's going to be refused"*:

- a coder of the CONSENSUS kind (#1039 d) — hand-edited files only;
- a coder decision naming a local coder that no longer exists, or one of another kind
  or model configuration (#1034) — a script or a stale confirm screen;
- the 1:1 equivalence pre-flight (#289) and the cross-dataset pre-flight (#290) —
  legacy or hand-edited files.

All five read only the FILE and the caller's decisions, so they run in ONE pre-flight
before the mode branch, before anything is written.

🔴 **The cross-dataset pre-flight had never fired on a real file.** It keyed the file's
columns on ``"id"``, which `_serialize_row` never writes (it writes ``_original_id``),
so every column landed under one ``None`` key and no member resolved — a violation
imported, and met `resolve_dataset_domain`'s runtime assertion later, the opaque error
the pre-flight existed to prevent.
"""

from __future__ import annotations

import json
import uuid as uuid_module
import zipfile

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import project_portability as pp
from tests.archive_support import archive_extras, archive_payload, write_archive


@pytest.fixture
def backups(tmp_path, monkeypatch):
    """The folder the safety copy is written to — patched, so a test can count it."""
    folder = tmp_path / "backups"
    monkeypatch.setattr("app.services.project_portability.get_backup_dir", lambda: folder)
    return folder


def _copies(folder) -> list:
    return sorted(folder.glob("*.mmproject")) if folder.exists() else []


def _project(db) -> Project:
    """A coded project with two datasets — A holding two columns, B one — so every
    pre-flight has something real to refuse."""
    project = Project(name="Study", user_id=1, project_uuid=str(uuid_module.uuid4()))
    db.add(project)
    db.flush()
    conv = Conversation(project_id=project.id, name="Interview")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="a turn")
    code = Code(project_id=project.id, numeric_id=1, name="Theme")
    coder = User(username="Dana", password_hash=None, coder_type="human")
    db.add_all([seg, code, coder])
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=coder.id))
    for name, columns in (("Wave A", ("q1", "q2")), ("Wave B", ("q1",))):
        ds = Dataset(project_id=project.id, name=name)
        db.add(ds)
        db.flush()
        for i, col in enumerate(columns):
            db.add(DatasetColumn(
                dataset_id=ds.id, column_name=col, column_text=col,
                column_type=ColumnType.NUMERIC, sequence_order=i, display_order=i,
            ))
    db.commit()
    return project


def _doctor(db, project, tmp_path, name, edit) -> object:
    source = tmp_path / "clean.mmproject"
    source.write_bytes(
        pp.export_project(db, project.id, tmp_path / "docs", include_media=False).getvalue()
    )
    with zipfile.ZipFile(source) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        payload = archive_payload(zf)
        extras = archive_extras(zf)
    edit(payload)
    return write_archive(tmp_path / name, manifest, payload, extras)


def _columns(payload) -> dict[tuple[str, str], dict]:
    """(dataset name, column name) → the file's column entry."""
    names = {d["_original_id"]: d["name"] for d in payload["datasets"]}
    cols = {(names[c["dataset_id"]], c["column_name"]): c for c in payload["dataset_columns"]}
    assert len(cols) == 3, "vacuous fixture"
    return cols


def _consensus_coder(payload):
    assert [c["username"] for c in payload["coders"]] == ["Dana"], "vacuous fixture"
    payload["coders"][0]["coder_type"] = "consensus"


def _two_columns_of_one_dataset_in_one_group(payload):
    cols = _columns(payload)
    payload["equivalence_groups"] = [{"_original_id": 77, "label": "Trust"}]
    cols[("Wave A", "q1")]["equivalence_group_id"] = 77
    cols[("Wave A", "q2")]["equivalence_group_id"] = 77


def _an_unpaired_cross_dataset_group(payload):
    cols = _columns(payload)
    payload["analysis_domains"] = [{"_original_id": 55, "name": "Wellbeing"}]
    payload["analysis_domain_members"] = [
        {"_original_id": 1, "domain_id": 55, "member_type": "column",
         "member_id": cols[("Wave A", "q1")]["_original_id"], "sequence_order": 0},
        {"_original_id": 2, "domain_id": 55, "member_type": "column",
         "member_id": cols[("Wave B", "q1")]["_original_id"], "sequence_order": 1},
    ]


FILE_REFUSALS = [
    ("consensus", _consensus_coder, "as the consensus layer"),
    ("one_to_one", _two_columns_of_one_dataset_in_one_group, "at most one column per dataset"),
    ("cross_dataset", _an_unpaired_cross_dataset_group, "must be linked via equivalence groups"),
]


class TestAFileRefusalWritesNoSafetyCopy:
    @pytest.mark.parametrize("label, edit, message", FILE_REFUSALS, ids=[f[0] for f in FILE_REFUSALS])
    def test_an_OVERWRITE(self, db_session, tmp_path, backups, label, edit, message):
        project = _project(db_session)
        archive = _doctor(db_session, project, tmp_path, f"{label}.mmproject", edit)
        safety: dict = {}
        with pytest.raises(ValueError, match=message):
            pp.import_project(
                db_session, archive, tmp_path / "docs", user_id=1, import_mode="overwrite",
                target_project_id=project.id, safety_report=safety,
            )
        assert _copies(backups) == []
        assert safety == {}

    @pytest.mark.parametrize("label, edit, message", FILE_REFUSALS[:2], ids=[f[0] for f in FILE_REFUSALS[:2]])
    def test_a_MERGE(self, db_session, tmp_path, backups, label, edit, message):
        """A merge blanks the variable groups, so it reaches the first two — the 1:1
        pre-flight reads the columns, which a merge keeps."""
        project = _project(db_session)
        archive = _doctor(db_session, project, tmp_path, f"{label}.mmproject", edit)
        with pytest.raises(ValueError, match=message):
            pp.import_project(
                db_session, archive, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=project.id,
            )
        assert _copies(backups) == []

    def test_the_control_a_clean_overwrite_still_writes_its_copy(self, db_session, tmp_path, backups):
        """The pre-flight must refuse only what it names — a clean file is copied first."""
        project = _project(db_session)
        archive = _doctor(db_session, project, tmp_path, "clean2.mmproject", lambda p: None)
        pp.import_project(
            db_session, archive, tmp_path / "docs", user_id=1, import_mode="overwrite",
            target_project_id=project.id,
        )
        assert len(_copies(backups)) == 1


class TestACoderDecisionRefusalWritesNoSafetyCopy:
    def _dana(self, archive) -> int:
        with zipfile.ZipFile(archive) as zf:
            return archive_payload(zf)["coders"][0]["_original_id"]

    def test_a_decision_naming_a_coder_that_no_longer_exists(self, db_session, tmp_path, backups):
        project = _project(db_session)
        archive = _doctor(db_session, project, tmp_path, "a.mmproject", lambda p: None)
        with pytest.raises(ValueError, match="no longer exists"):
            pp.import_project(
                db_session, archive, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=project.id,
                coder_mapping={str(self._dana(archive)): {"action": "match", "target_user_id": 987654}},
            )
        assert _copies(backups) == []

    def test_a_decision_matching_a_person_onto_a_MODEL(self, db_session, tmp_path, backups):
        project = _project(db_session)
        bot = User(username="Bot", password_hash=None, coder_type="ai")
        db_session.add(bot)
        db_session.commit()
        archive = _doctor(db_session, project, tmp_path, "b.mmproject", lambda p: None)
        with pytest.raises(ValueError):
            pp.import_project(
                db_session, archive, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=project.id,
                coder_mapping={str(self._dana(archive)): {"action": "match", "target_user_id": bot.id}},
            )
        assert _copies(backups) == []


class TestTheCrossDatasetPreflightFires:
    def test_on_a_NEW_import_too(self, db_session, tmp_path):
        """It read `"id"`, which no export writes — so it never fired, on any mode."""
        project = _project(db_session)
        archive = _doctor(db_session, project, tmp_path, "x.mmproject", _an_unpaired_cross_dataset_group)
        with pytest.raises(ValueError, match="must be linked via equivalence groups") as exc:
            pp.import_project(db_session, archive, tmp_path / "docs", user_id=1)
        # The violation names the file's own column ids, not None.
        assert "None" not in str(exc.value)

    def test_the_control_a_PAIRED_cross_dataset_group_imports(self, db_session, tmp_path):
        def paired(payload):
            _an_unpaired_cross_dataset_group(payload)
            cols = _columns(payload)
            payload["equivalence_groups"] = [{"_original_id": 78, "label": "Q1"}]
            cols[("Wave A", "q1")]["equivalence_group_id"] = 78
            cols[("Wave B", "q1")]["equivalence_group_id"] = 78

        project = _project(db_session)
        archive = _doctor(db_session, project, tmp_path, "y.mmproject", paired)
        pid, _ = pp.import_project(db_session, archive, tmp_path / "docs", user_id=1)
        assert pid != project.id
