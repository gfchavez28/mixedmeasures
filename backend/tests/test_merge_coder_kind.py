"""#1034 — a file coder lands only on a local coder of the SAME KIND, and a machine only
on the SAME CONFIGURATION.

**The defect (executed by the 2026-09-24 audit, and again here).** The `.mmproject`
import matched coders by NAME alone — the silent fallback every new / overwrite /
coding-copy import takes, and the merge preview's proposal — so:

(a) a file's MACHINE coder "Model-1" landed on a local PERSON "Model-1". Its codings
    then VOTED in consensus and entered reliability: #989's exclusion, undone by a
    name collision;
(b) a file's machine landed on a local machine of the same name run with a DIFFERENT
    configuration, and the imported codings were re-labelled with the local one —
    breaking row 49's "two configurations of one model are two coders".

**What the fix is:** ONE predicate, `project_portability.coder_match_refusal`, asked by
the silent fallback, by an explicit `match` decision, and by the preview's proposal and
option list. A refused name-match creates a new coder under a suffixed name, and the
preview says so (`name_in_use`) instead of proposing it.

⚠️ **Two unrecorded configurations are the same** (`machine_coder.same_configuration`):
the alternative duplicates a model coder on every round trip of a project whose
configuration was never written down. The positive controls below pin that the fix does
not break the ordinary round trip.
"""
from __future__ import annotations

import json
import uuid
import zipfile
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
    CODER_MISMATCH_CONFIGURATION,
    CODER_MISMATCH_KIND,
    build_merge_coder_preview,
    export_project,
    import_project,
)

NAME = "Model-1"
P1 = {"model": "gpt-4o-2024-08-06", "access": "api", "parameters": {"temperature": "0"}}
P2 = {"model": "gpt-4o-2024-08-06", "access": "api", "parameters": {"temperature": "0.7"}}


@pytest.fixture
def db():
    from app.database import Base, SessionLocal, engine
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    session.add(User(id=1, username="Researcher", password_hash="x", is_admin=True))
    session.flush()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
        Base.metadata.drop_all(bind=engine)


def _file(db, tmp_path: Path, *, kind: str, provenance: dict | None) -> tuple[Project, Path]:
    """A project whose ONE coding is by coder id 2 (`NAME`, of `kind`), exported — then
    that coder and its coding removed, so the file is the only place they exist. The
    project stays, with the same identity, so the file can also be MERGED back."""
    source = User(id=2, username=NAME, password_hash=None, coder_type=kind)
    machine_coder.write_provenance(source, provenance)
    db.add(source)
    p = Project(name="Study", status="active", user_id=1, project_uuid=str(uuid.uuid4()))
    db.add(p)
    db.flush()
    conv = Conversation(project_id=p.id, name="Interview", status="completed")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="A passage.")
    code = Code(project_id=p.id, numeric_id=1, name="Theme", is_active=True)
    db.add_all([seg, code])
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=2, origin="human"))
    db.flush()
    exported = tmp_path / "file.mmproject"
    exported.write_bytes(export_project(db, p.id, tmp_path / "docs").getvalue())
    db.query(CodeApplication).filter(CodeApplication.user_id == 2).delete()
    db.delete(source)
    db.flush()
    return p, exported


def _local(db, *, kind: str, provenance: dict | None = None) -> User:
    local = User(id=50, username=NAME, password_hash=None, coder_type=kind)
    machine_coder.write_provenance(local, provenance)
    db.add(local)
    db.flush()
    return local


def _import_new(db, f, tmp_path) -> int:
    pid, _ = import_project(db, f, tmp_path / "docs", user_id=1)
    db.flush()
    return pid


def _coder_of_the_imported_coding(db, pid) -> User:
    app = (
        db.query(CodeApplication)
        .join(Code, Code.id == CodeApplication.code_id)
        .filter(Code.project_id == pid)
        .one()
    )
    return db.get(User, app.user_id)


class TestTheSilentNameMatch:
    """The path every new / overwrite / coding-copy import takes — no decision at all."""

    def test_a_machine_never_lands_on_a_PERSON_of_its_name(self, db, tmp_path):
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        person = _local(db, kind="human")
        pid = _import_new(db, f, tmp_path)
        landed = _coder_of_the_imported_coding(db, pid)
        assert landed.id != person.id
        assert (landed.coder_type, landed.username) == ("ai", f"{NAME} (2)")
        assert machine_coder.read_provenance(landed) == P1
        # The person keeps only what was theirs — before the fix the model's coding
        # was attributed to them, and voted.
        assert db.query(CodeApplication).filter(CodeApplication.user_id == person.id).count() == 0

    def test_a_person_never_lands_on_a_MACHINE_of_their_name(self, db, tmp_path):
        """The reverse direction: a person's codings would silently join the machine
        layer and leave every reliability figure."""
        _, f = _file(db, tmp_path, kind="human", provenance=None)
        model = _local(db, kind="ai", provenance=P1)
        pid = _import_new(db, f, tmp_path)
        landed = _coder_of_the_imported_coding(db, pid)
        assert landed.id != model.id
        assert (landed.coder_type, landed.username) == ("human", f"{NAME} (2)")

    def test_another_CONFIGURATION_of_the_model_is_another_coder(self, db, tmp_path):
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        other = _local(db, kind="ai", provenance=P2)
        pid = _import_new(db, f, tmp_path)
        landed = _coder_of_the_imported_coding(db, pid)
        assert landed.id != other.id
        assert machine_coder.read_provenance(landed) == P1
        assert machine_coder.read_provenance(other) == P2  # untouched

    def test_the_SAME_configuration_still_matches(self, db, tmp_path):
        """POSITIVE CONTROL — the round trip of your own project must not grow a
        duplicate model coder."""
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        same = _local(db, kind="ai", provenance=P1)
        pid = _import_new(db, f, tmp_path)
        assert _coder_of_the_imported_coding(db, pid).id == same.id

    def test_two_UNRECORDED_configurations_match(self, db, tmp_path):
        _, f = _file(db, tmp_path, kind="ai", provenance=None)
        same = _local(db, kind="ai", provenance=None)
        pid = _import_new(db, f, tmp_path)
        assert _coder_of_the_imported_coding(db, pid).id == same.id

    def test_a_person_still_matches_a_person(self, db, tmp_path):
        """POSITIVE CONTROL for the ordinary case: name-matching people is unchanged."""
        _, f = _file(db, tmp_path, kind="human", provenance=None)
        person = _local(db, kind="human")
        pid = _import_new(db, f, tmp_path)
        assert _coder_of_the_imported_coding(db, pid).id == person.id


class TestAnExplicitDecision:
    def test_a_match_across_kinds_is_REFUSED_with_the_way_out(self, db, tmp_path):
        p, f = _file(db, tmp_path, kind="ai", provenance=P1)
        person = _local(db, kind="human")
        with pytest.raises(ValueError, match="cannot stand in for the other") as exc:
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=p.id,
                coder_mapping={"2": {"action": "match", "target_user_id": person.id}},
            )
        assert "Add “Model-1” as a new coder" in str(exc.value)

    def test_a_match_onto_another_configuration_is_REFUSED(self, db, tmp_path):
        p, f = _file(db, tmp_path, kind="ai", provenance=P1)
        other = _local(db, kind="ai", provenance=P2)
        with pytest.raises(ValueError, match="different configuration"):
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=p.id,
                coder_mapping={"2": {"action": "match", "target_user_id": other.id}},
            )

    def test_a_match_onto_the_same_configuration_is_accepted(self, db, tmp_path):
        p, f = _file(db, tmp_path, kind="ai", provenance=P1)
        same = _local(db, kind="ai", provenance=P1)
        report = {"coders_matched": 0, "coders_created": 0}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id, report=report,
            coder_mapping={"2": {"action": "match", "target_user_id": same.id}},
        )
        assert report["coders_matched"] == 1


class TestThePreviewPredictsTheAct:
    """The confirm screen is built from this, so it must say what the import will do."""

    def _row(self, db, f):
        (row,) = build_merge_coder_preview(db, f)
        return row

    def test_a_person_holding_the_name_is_not_proposed_and_says_why(self, db, tmp_path):
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        person = _local(db, kind="human")
        row = self._row(db, f)
        assert row["local_match"] is None
        assert row["name_in_use"] == {
            "username": NAME, "coder_type": "human", "reason": CODER_MISMATCH_KIND,
            "new_username": f"{NAME} (2)",
        }
        assert person.id not in {o["id"] for o in row["match_options"]}
        assert row["machine_provenance"] == P1

    def test_another_configuration_is_not_proposed_and_says_why(self, db, tmp_path):
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        _local(db, kind="ai", provenance=P2)
        row = self._row(db, f)
        assert row["local_match"] is None
        assert row["name_in_use"]["reason"] == CODER_MISMATCH_CONFIGURATION

    def test_the_options_are_every_eligible_coder_and_only_those(self, db, tmp_path):
        """A file machine may be mapped onto a same-configuration machine by ANOTHER
        name, never onto a person or another configuration."""
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        db.add_all([
            User(id=60, username="Twin", password_hash=None, coder_type="ai",
                 machine_provenance=json.dumps(P1)),
            User(id=61, username="Other run", password_hash=None, coder_type="ai",
                 machine_provenance=json.dumps(P2)),
            User(id=62, username="Ana", password_hash=None, coder_type="human"),
        ])
        db.flush()
        row = self._row(db, f)
        assert [o["id"] for o in row["match_options"]] == [60]

    def test_a_matching_coder_is_proposed_first(self, db, tmp_path):
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        db.add(User(id=40, username="Twin", password_hash=None, coder_type="ai",
                    machine_provenance=json.dumps(P1)))
        same = _local(db, kind="ai", provenance=P1)
        row = self._row(db, f)
        assert row["local_match"]["id"] == same.id
        assert row["name_in_use"] is None
        assert [o["id"] for o in row["match_options"]] == [same.id, 40]

    def test_a_file_written_before_the_configuration_joined_the_block(self, db, tmp_path):
        """🔴 Every block v1.5.4 wrote lacks `machine_provenance`. Read as "not
        recorded" it would propose ADDING a model the import then name-matches — a
        preview that disagrees with the act. The key's ABSENCE sends the preview to
        `project.json`, which the import itself reads."""
        _, f = _file(db, tmp_path, kind="ai", provenance=P1)
        with zipfile.ZipFile(f) as zf:
            members = {n: zf.read(n) for n in zf.namelist()}
        block = json.loads(members["merge_preview.json"])
        for coder in block["coders"]:
            assert coder.pop("machine_provenance") is not None
        members["merge_preview.json"] = json.dumps(block).encode()
        old = tmp_path / "v154.mmproject"
        with zipfile.ZipFile(old, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        same = _local(db, kind="ai", provenance=P1)
        row = self._row(db, old)
        assert row["local_match"]["id"] == same.id
        assert row["machine_provenance"] == P1
        # …and the import agrees with it.
        pid = _import_new(db, old, tmp_path)
        assert _coder_of_the_imported_coding(db, pid).id == same.id



def test_a_new_block_carries_the_configuration(db, tmp_path):
    """The export WRITES `machine_provenance` into `merge_preview.json`, so a file this
    build writes never needs the `project.json` fallback. Pinned on its own because the
    fallback would otherwise hide its absence: the preview stays right either way, and
    only the cost moves (#941's reading of a surviving mutant — here the redundancy is
    the point, and this is what says so)."""
    _, f = _file(db, tmp_path, kind="ai", provenance=P1)
    with zipfile.ZipFile(f) as zf:
        block = json.loads(zf.read("merge_preview.json"))
    (coder,) = block["coders"]
    assert json.loads(coder["machine_provenance"]) == P1
