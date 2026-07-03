"""Track J · J3-1 — UUID round-trip / overwrite + the Freeze Codebook soft-lock.

Service-layer + direct-endpoint-call tests (in-memory SQLite, User id=1), mirroring
test_project_portability.py conventions.
"""

import asyncio
import io
import os
import uuid as _uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

# Safety guard: ensure in-memory DB (conftest also sets this)
os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models.project import Project
from app.models.code import Code
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.user import User
from app.models.audit import AuditEntry
from app.schemas.project import CodebookFreezeRequest
from app.routers.projects import set_codebook_freeze
from app.routers.project_portability import (
    _find_existing_project_by_uuid,
    import_project_endpoint,
    validate_import_endpoint,
)
from app.services.project_portability import (
    MergeDivergenceError,
    build_merge_coder_preview,
    build_merge_code_preview,
    export_project,
    import_project,
    validate_project_file,
    _import_recodes_topological,
    _merge_uuid_match,
)
from app.schemas.project_portability import MergeCodePreview


@pytest.fixture
def db_session():
    """Per-test empty database session with User id=1."""
    from app.database import Base, engine, SessionLocal
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    db.add(User(id=1, username="testuser", password_hash="x", is_admin=True))
    db.flush()
    try:
        yield db
    finally:
        db.rollback()
        db.close()
        Base.metadata.drop_all(bind=engine)


def _run(coro):
    return asyncio.run(coro)


def _make_project(db: Session, name: str, *, with_uuid: bool = True) -> Project:
    p = Project(
        name=name, status="active", user_id=1,
        project_uuid=str(_uuid.uuid4()) if with_uuid else None,
    )
    db.add(p)
    db.flush()
    return p


def _add_code(db: Session, pid: int, numeric_id: int, name: str) -> None:
    db.add(Code(project_id=pid, numeric_id=numeric_id, name=name, is_active=True))
    db.flush()


def _export_to_file(db: Session, pid: int, docs_dir: Path, dest: Path) -> Path:
    buf = export_project(db, pid, docs_dir)
    dest.write_bytes(buf.getvalue())
    return dest


# ── Freeze Codebook soft-lock ───────────────────────────────────────────────

class TestCodebookFreeze:

    def test_freeze_sets_timestamp_and_logs(self, db_session):
        db = db_session
        user = db.query(User).filter(User.id == 1).first()
        p = _make_project(db, "Frz")

        resp = _run(set_codebook_freeze(p.id, CodebookFreezeRequest(frozen=True), user=user, db=db))

        assert resp.codebook_frozen_at is not None
        db.refresh(p)
        assert p.codebook_frozen_at is not None
        logs = db.query(AuditEntry).filter(AuditEntry.action == "codebook_froze").all()
        assert len(logs) == 1
        assert logs[0].entity_type == "codebook"
        assert logs[0].project_id == p.id

    def test_unfreeze_clears_and_logs(self, db_session):
        db = db_session
        user = db.query(User).filter(User.id == 1).first()
        p = _make_project(db, "Unfrz")

        _run(set_codebook_freeze(p.id, CodebookFreezeRequest(frozen=True), user=user, db=db))
        resp = _run(set_codebook_freeze(p.id, CodebookFreezeRequest(frozen=False), user=user, db=db))

        assert resp.codebook_frozen_at is None
        db.refresh(p)
        assert p.codebook_frozen_at is None
        assert db.query(AuditEntry).filter(AuditEntry.action == "codebook_unfroze").count() == 1

    def test_refreeze_preserves_original_anchor(self, db_session):
        """A re-freeze must NOT move the anchor — the original freeze instant is the
        forensic reference a researcher reconstructs drift against."""
        db = db_session
        user = db.query(User).filter(User.id == 1).first()
        p = _make_project(db, "Refrz")

        _run(set_codebook_freeze(p.id, CodebookFreezeRequest(frozen=True), user=user, db=db))
        db.refresh(p)
        first_anchor = p.codebook_frozen_at

        _run(set_codebook_freeze(p.id, CodebookFreezeRequest(frozen=True), user=user, db=db))
        db.refresh(p)
        assert p.codebook_frozen_at == first_anchor

    def test_frozen_state_survives_roundtrip(self, db_session, tmp_path):
        """codebook_frozen_at must travel in the .mmproject export so a distributed
        copy arrives already frozen (reflection-driven, no special portability code)."""
        db = db_session
        user = db.query(User).filter(User.id == 1).first()
        p = _make_project(db, "RT Frozen")
        _run(set_codebook_freeze(p.id, CodebookFreezeRequest(frozen=True), user=user, db=db))
        db.refresh(p)
        frozen_at = p.codebook_frozen_at

        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "rt.mmproject")
        new_id, _ = import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()

        new_p = db.get(Project, new_id)
        assert new_p.codebook_frozen_at is not None
        assert new_p.codebook_frozen_at == frozen_at


# ── J3-1 UUID round-trip / overwrite ────────────────────────────────────────

class TestUuidRoundTrip:

    def test_validate_exposes_project_uuid_in_manifest(self, db_session, tmp_path):
        db = db_session
        p = _make_project(db, "V")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "v.mmproject")

        result = validate_project_file(f)
        assert result["manifest"]["project_uuid"] == p.project_uuid

    def test_find_existing_project_by_uuid(self, db_session):
        db = db_session
        user = db.query(User).filter(User.id == 1).first()
        p = _make_project(db, "Detect")

        assert _find_existing_project_by_uuid(db, p.project_uuid, user).id == p.id
        assert _find_existing_project_by_uuid(db, str(_uuid.uuid4()), user) is None

    def test_import_as_new_fresh_stamps_uuid(self, db_session, tmp_path):
        """Default import is create-fresh: the new project gets a NEW uuid and the
        original survives untouched (legacy behavior, backward compatible)."""
        db = db_session
        p = _make_project(db, "Source")
        orig_uuid = p.project_uuid
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "src.mmproject")

        new_id, _ = import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()

        new_p = db.get(Project, new_id)
        assert new_p.project_uuid is not None
        assert new_p.project_uuid != orig_uuid
        # Original still present with its identity intact
        assert db.get(Project, p.id).project_uuid == orig_uuid

    def test_overwrite_preserves_uuid_and_replaces_content(self, db_session, tmp_path, monkeypatch):
        db = db_session
        backup_dir = tmp_path / "backups"
        monkeypatch.setattr(
            "app.services.project_portability.get_backup_dir", lambda: backup_dir
        )
        docs = tmp_path / "docs"

        p = _make_project(db, "Laptop Copy")
        orig_uuid = p.project_uuid
        _add_code(db, p.id, 0, "Alpha")
        f = _export_to_file(db, p.id, docs, tmp_path / "rt.mmproject")

        # Local drift after the export — overwrite should discard this
        _add_code(db, p.id, 1, "Beta")

        new_id, _ = import_project(
            db, f, docs, media_dir=None, user_id=1,
            import_mode="overwrite", target_project_id=p.id,
        )
        db.flush()

        # Overwrite REPLACED (not duplicated) the project: exactly one remains,
        # carrying the original stable identity. (Its integer id may be reused by
        # SQLite when the old row's rowid is freed — uuid is the identity that matters.)
        assert db.query(Project).count() == 1
        new_p = db.get(Project, new_id)
        assert new_p.project_uuid == orig_uuid
        # Content reflects the file snapshot (Alpha only; the drifted Beta is gone)
        names = {c.name for c in db.query(Code).filter(Code.project_id == new_id)}
        assert names == {"Alpha"}
        # A pre-overwrite safety backup was written
        assert backup_dir.exists()
        assert list(backup_dir.glob("pre-overwrite_*.mmproject"))

    def test_overwrite_rejects_uuid_mismatch(self, db_session, tmp_path, monkeypatch):
        """Overwrite must never clobber a project whose identity differs from the file."""
        db = db_session
        monkeypatch.setattr(
            "app.services.project_portability.get_backup_dir", lambda: tmp_path / "backups"
        )
        docs = tmp_path / "docs"
        p1 = _make_project(db, "P1")
        p2 = _make_project(db, "P2")
        f = _export_to_file(db, p1.id, docs, tmp_path / "p1.mmproject")

        with pytest.raises(ValueError, match="does not match"):
            import_project(
                db, f, docs, user_id=1,
                import_mode="overwrite", target_project_id=p2.id,
            )

    def test_overwrite_requires_target(self, db_session, tmp_path):
        db = db_session
        p = _make_project(db, "NoTarget")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "n.mmproject")

        with pytest.raises(ValueError, match="requires a target"):
            import_project(
                db, f, tmp_path / "docs", user_id=1,
                import_mode="overwrite", target_project_id=None,
            )


# ── J3-2-0 per-entity UUID spine ────────────────────────────────────────────

def _seed_coded(db: Session, name: str):
    """A project with a conversation + segment + code (each gets a uuid)."""
    p = _make_project(db, name)
    conv = Conversation(project_id=p.id, name="C1", status="completed")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="hello world")
    db.add(seg)
    db.flush()
    _add_code(db, p.id, 0, "Alpha")
    return p, conv, seg


def _make_divergent_file(db, tmp_path, fname, *, twin_names, divergent_name, app_user_id=1):
    """Build a merge target P (Alpha + the given local twins) and a colleague's file that
    additionally carries a DIVERGENT code (uuid file-only) with one application by
    ``app_user_id``. Returns (p, conv, seg, twins, divergent_uuid, file_path)."""
    p, conv, seg = _seed_coded(db, fname)
    twins = {}
    nid = 1
    for tn in twin_names:
        c = Code(project_id=p.id, numeric_id=nid, name=tn, is_active=True)
        db.add(c)
        db.flush()
        twins[tn] = c
        nid += 1
    diverge = Code(project_id=p.id, numeric_id=nid, name=divergent_name, is_active=True)
    db.add(diverge)
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=diverge.id, user_id=app_user_id, origin="human"))
    db.flush()
    diverge_uuid = diverge.uuid
    f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / fname)
    db.delete(diverge)  # cascades its local application → the file's copy is now file-only
    db.flush()
    return p, conv, seg, twins, diverge_uuid, f


class TestEntityUuidSpine:

    def test_orm_default_stamps_uuid(self, db_session):
        """Creating entities via the ORM stamps a uuid (the model default)."""
        db = db_session
        p, conv, seg = _seed_coded(db, "Default")
        code = db.query(Code).filter(Code.project_id == p.id).first()
        assert conv.uuid and seg.uuid and code.uuid
        assert len({conv.uuid, seg.uuid, code.uuid}) == 3  # all distinct

    def test_import_as_new_fresh_stamps_entity_uuids(self, db_session, tmp_path):
        """Import-as-new must give entities FRESH uuids, never copy the source's."""
        db = db_session
        p, conv, seg = _seed_coded(db, "Src")
        src = {
            "conv": conv.uuid,
            "seg": seg.uuid,
            "code": db.query(Code).filter(Code.project_id == p.id).first().uuid,
        }
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "u.mmproject")

        new_id, _ = import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()

        new_conv = db.query(Conversation).filter(Conversation.project_id == new_id).first()
        new_seg = db.query(Segment).filter(Segment.conversation_id == new_conv.id).first()
        new_code = db.query(Code).filter(Code.project_id == new_id).first()
        assert new_conv.uuid and new_conv.uuid != src["conv"]
        assert new_seg.uuid and new_seg.uuid != src["seg"]
        assert new_code.uuid and new_code.uuid != src["code"]

    def test_double_import_does_not_collide_on_uuid_index(self, db_session, tmp_path):
        """Importing the same file twice must not violate the unique uuid indexes."""
        db = db_session
        p, _, _ = _seed_coded(db, "Src2")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "u2.mmproject")

        id1, _ = import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()
        id2, _ = import_project(db, f, tmp_path / "docs", user_id=1)  # must NOT raise
        db.flush()

        assert id1 != id2
        u1 = db.query(Conversation).filter(Conversation.project_id == id1).first().uuid
        u2 = db.query(Conversation).filter(Conversation.project_id == id2).first().uuid
        assert u1 and u2 and u1 != u2

    def test_export_carries_entity_uuid(self, db_session, tmp_path):
        """The entity uuid is serialized into project.json (free, reflection-driven)."""
        import json
        import zipfile

        db = db_session
        p, conv, _ = _seed_coded(db, "Exp")
        the_uuid = conv.uuid
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "e.mmproject")
        with zipfile.ZipFile(f) as z:
            pj = json.loads(z.read("project.json"))
        convs = pj.get("conversations", [])
        assert convs and convs[0].get("uuid") == the_uuid

    def test_code_equivalence_group_orm_default_stamps_uuid(self, db_session):
        """J3-2b · B0: a CodeEquivalenceGroup gets a uuid on ORM create."""
        db = db_session
        p, _, _ = _seed_coded(db, "CEG default")
        code = db.query(Code).filter(Code.project_id == p.id).first()
        group = CodeEquivalenceGroup(project_id=p.id, label="Pos/POS")
        db.add(group)
        db.flush()
        code.code_equivalence_group_id = group.id
        db.flush()
        assert group.uuid  # stamped by the model default

    def test_code_equivalence_group_import_as_new_fresh_stamps_uuid(self, db_session, tmp_path):
        """J3-2b · B0: import-as-new fresh-stamps the group uuid; double-import does
        NOT collide on ix_code_equivalence_groups_uuid (the reason B0 exists)."""
        db = db_session
        p, _, _ = _seed_coded(db, "CEG src")
        code = db.query(Code).filter(Code.project_id == p.id).first()
        group = CodeEquivalenceGroup(project_id=p.id, label="Pos/POS")
        db.add(group)
        db.flush()
        code.code_equivalence_group_id = group.id
        db.flush()
        src_uuid = group.uuid
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "ceg.mmproject")

        id1, _ = import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()
        id2, _ = import_project(db, f, tmp_path / "docs", user_id=1)  # must NOT raise
        db.flush()

        g1 = db.query(CodeEquivalenceGroup).filter(CodeEquivalenceGroup.project_id == id1).first()
        g2 = db.query(CodeEquivalenceGroup).filter(CodeEquivalenceGroup.project_id == id2).first()
        assert g1.uuid and g1.uuid != src_uuid  # fresh, not copied
        assert g2.uuid and g2.uuid != g1.uuid    # distinct across imports → no index collision


class TestMergeCodePreview:
    """Track J · J3-2b · B1: build_merge_code_preview — the divergent-code reconcile feed."""

    def test_shared_frozen_codebook_yields_no_preview(self, db_session, tmp_path):
        """No divergence → empty preview (the shared-frozen common case)."""
        db = db_session
        p, _, _ = _seed_coded(db, "Frozen preview")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "fz.mmproject")
        assert build_merge_code_preview(db, f, target_project_id=p.id) == []

    def test_divergent_code_preview_ranks_local_candidates(self, db_session, tmp_path):
        db = db_session
        p, conv, seg = _seed_coded(db, "Diverge preview")
        # Local twin (kept) — a confident candidate, with one application (usage 1).
        twin = Code(project_id=p.id, numeric_id=1, name="Empathy", is_active=True)
        db.add(twin)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=twin.id, user_id=1, origin="human"))
        # The code that becomes divergent: near-identical name + a definition + usage.
        diverge = Code(
            project_id=p.id, numeric_id=2, name="Empathy ",
            description="Shows understanding of others' feelings", is_active=True,
        )
        db.add(diverge)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=diverge.id, user_id=1, origin="human"))
        db.flush()
        diverge_uuid = diverge.uuid

        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "dp.mmproject")
        # Make it divergent: remove it locally so its uuid is file-only.
        db.delete(diverge)
        db.flush()

        previews = build_merge_code_preview(db, f, target_project_id=p.id)
        assert len(previews) == 1
        pv = previews[0]
        MergeCodePreview.model_validate(pv)  # conforms to the wire schema
        assert pv["uuid"] == diverge_uuid
        assert pv["name"] == "Empathy "
        assert pv["description"] == "Shows understanding of others' feelings"
        assert pv["file_app_count"] == 1
        # Local "Empathy" is the top, confident candidate, carrying its own usage count.
        cands = pv["candidates"]
        assert cands and cands[0]["code_id"] == twin.id
        assert cands[0]["confident"] is True   # "empathy" ≈ "empathy " → ratio 1.0
        assert cands[0]["usage"] == 1
        # Candidates are ranked descending by similarity.
        sims = [c["similarity"] for c in cands]
        assert sims == sorted(sims, reverse=True)


class TestMergeReconcile:
    """Track J · J3-2b · B2: divergent-code reconcile on merge (collapse / link / new)."""

    def test_collapse_remaps_codings_onto_local_code(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "collapse.mmproject",
            twin_names=["Listening"], divergent_name="Listening Skills",
        )
        target = twins["Listening"]
        report = {}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id,
            code_mapping={du: {"action": "collapse", "target_code_id": target.id}},
            report=report,
        )
        db.flush()
        # No new code is created — the collapse only re-points codings.
        assert db.query(Code).filter(
            Code.project_id == p.id, Code.name == "Listening Skills"
        ).first() is None
        # The colleague's application now sits on the local twin.
        apps = db.query(CodeApplication).filter(
            CodeApplication.code_id == target.id, CodeApplication.segment_id == seg.id
        ).all()
        assert len(apps) == 1
        assert report["codes_collapsed"] == 1
        assert report["applications_added"] == 1

    def test_link_inserts_and_groups_with_local_code(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "link.mmproject",
            twin_names=["Empathy"], divergent_name="Empathic",
        )
        twin = twins["Empathy"]
        report = {}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id,
            code_mapping={du: {
                "action": "link", "target_code_id": twin.id,
                "combined_label": "Empathy / Empathic",
            }},
            report=report,
        )
        db.flush()
        new_code = db.query(Code).filter(
            Code.project_id == p.id, Code.name == "Empathic"
        ).first()
        assert new_code is not None
        assert new_code.uuid == du                      # file uuid preserved → re-mergeable
        # Grouped with the twin → one effective code (consensus/IRR treat them as one).
        assert new_code.code_equivalence_group_id is not None
        assert new_code.code_equivalence_group_id == db.get(Code, twin.id).code_equivalence_group_id
        grp = db.get(CodeEquivalenceGroup, new_code.code_equivalence_group_id)
        assert grp.label == "Empathy / Empathic"
        # The colleague's application landed on the new code.
        assert db.query(CodeApplication).filter(
            CodeApplication.code_id == new_code.id, CodeApplication.segment_id == seg.id
        ).count() == 1
        assert report["codes_linked"] == 1

    def test_new_inserts_standalone_with_fresh_numeric_id(self, db_session, tmp_path):
        """The 'new' action inserts the divergent code; its numeric_id is freshly
        allocated (max+1) so a verbatim copy can't collide on ix_codes_project_numeric."""
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "new.mmproject",
            twin_names=[], divergent_name="Brand New Code",
        )
        # Force the collision trap: occupy the divergent code's freed numeric_id locally
        # (the file's "Brand New Code" carried numeric_id 1; P now has Alpha=0 only).
        squatter = Code(project_id=p.id, numeric_id=1, name="Squatter", is_active=True)
        db.add(squatter)
        db.flush()
        report = {}
        import_project(  # must NOT raise IntegrityError on ix_codes_project_numeric
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id,
            code_mapping={du: {"action": "new"}},
            report=report,
        )
        db.flush()
        new_code = db.query(Code).filter(
            Code.project_id == p.id, Code.name == "Brand New Code"
        ).first()
        assert new_code is not None
        assert new_code.numeric_id == 2                 # fresh max(0,1)+1, NOT the file's 1
        assert new_code.code_equivalence_group_id is None  # standalone, not grouped
        assert report["codes_created"] == 1
        assert report["applications_added"] == 1

    def test_undecided_divergent_code_still_refuses(self, db_session, tmp_path):
        """A divergent code WITHOUT a decision still hits the codebook gate (409) — the
        service never assumes the reconcile UI ran."""
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "undecided.mmproject",
            twin_names=[], divergent_name="Unreconciled",
        )
        with pytest.raises(MergeDivergenceError) as ei:
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=p.id, code_mapping={},  # no decision for the divergent code
            )
        assert ei.value.payload["kind"] == "codebook"
        assert "Unreconciled" in ei.value.payload["diverged_codes"]

    def test_bad_reconcile_target_rejected_before_write(self, db_session, tmp_path):
        """A decision pointing at a non-existent local code is rejected (ValueError → 400)
        in the gate, before any write."""
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "badtarget.mmproject",
            twin_names=[], divergent_name="Misaimed",
        )
        with pytest.raises(ValueError) as ei:
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=p.id,
                code_mapping={du: {"action": "collapse", "target_code_id": 999999}},
            )
        assert "not a code in your project" in str(ei.value)


class TestCopyForCoding:
    """Track J · J3-2: the co-coder 'import a working copy' mode preserves identity."""

    def test_copy_for_coding_preserves_identity(self, db_session, tmp_path):
        db = db_session
        p, conv, seg = _seed_coded(db, "Distributed")
        proj_uuid = p.project_uuid
        conv_uuid = conv.uuid
        seg_uuid = seg.uuid
        code_uuid = db.query(Code).filter(Code.project_id == p.id).first().uuid
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "c.mmproject")

        # Simulate the colleague's machine: the original isn't present there.
        db.delete(p)
        db.flush()

        new_id, _ = import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="copy_for_coding",
        )
        db.flush()

        new_p = db.get(Project, new_id)
        # project_uuid preserved → mergeable back to the origin
        assert new_p.project_uuid == proj_uuid
        # entity uuids preserved (NOT fresh-stamped) → merge will match exactly
        assert db.query(Conversation).filter(Conversation.project_id == new_id).first().uuid == conv_uuid
        assert db.query(Segment).join(Conversation).filter(Conversation.project_id == new_id).first().uuid == seg_uuid
        assert db.query(Code).filter(Code.project_id == new_id).first().uuid == code_uuid

    def test_copy_for_coding_refuses_when_identity_exists(self, db_session, tmp_path):
        """If the project already exists locally, you must MERGE, not import a 2nd copy."""
        db = db_session
        p, _, _ = _seed_coded(db, "Already Here")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "c2.mmproject")

        with pytest.raises(ValueError, match="merge the file into it"):
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="copy_for_coding",
            )


class TestMergeLoop:
    """Track J · J3-2a: import_mode='merge' combines a colleague's codings by matching
    shared sources on their stable uuid, deduping identical applications."""

    def _two_coder_project(self, db, tmp_path):
        """Project where Alice (u1) + Bob (u2) both coded seg S with the code; returns
        (project, segment, code, merge_file) after removing Bob's app from the target
        (so the file carries Bob's work that the merge must add back)."""
        db.add(User(id=2, username="Bob", password_hash="x", is_admin=False, coder_type="human"))
        db.flush()
        p, conv, seg = _seed_coded(db, "Team Study")
        code = db.query(Code).filter(Code.project_id == p.id).first()
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1, origin="human"))
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=2, origin="human"))
        db.flush()
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "team.mmproject")
        # Target state before merge: only Alice's app present.
        bob_app = (
            db.query(CodeApplication)
            .filter(CodeApplication.user_id == 2, CodeApplication.segment_id == seg.id)
            .first()
        )
        db.delete(bob_app)
        db.flush()
        return p, conv, seg, code, f

    def _human_apps(self, db, seg_id):
        return (
            db.query(CodeApplication)
            .filter(CodeApplication.segment_id == seg_id, CodeApplication.origin != "consensus")
            .all()
        )

    def test_merge_combines_coders_and_dedups(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, code, f = self._two_coder_project(db, tmp_path)
        assert len(self._human_apps(db, seg.id)) == 1  # only Alice before merge

        new_id, _ = import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id,
        )
        db.flush()

        assert new_id == p.id  # merged INTO the existing project (not a new one)
        apps = self._human_apps(db, seg.id)
        assert {a.user_id for a in apps} == {1, 2}  # Bob's work merged in
        assert len(apps) == 2  # Alice's app deduped (not doubled), Bob's added once
        # Shared sources matched by uuid — NOT duplicated
        assert db.query(Segment).filter(Segment.conversation_id == conv.id).count() == 1
        assert db.query(Code).filter(Code.project_id == p.id).count() == 1

    def test_merge_is_idempotent(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, code, f = self._two_coder_project(db, tmp_path)
        import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id)
        db.flush()
        first = len(self._human_apps(db, seg.id))
        # Re-merging the same file must add nothing (dedup holds).
        import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id)
        db.flush()
        assert len(self._human_apps(db, seg.id)) == first

    def test_merge_rejects_uuid_mismatch(self, db_session, tmp_path):
        db = db_session
        p1, _, _ = _seed_coded(db, "P1")
        p2, _, _ = _seed_coded(db, "P2")
        f = _export_to_file(db, p1.id, tmp_path / "docs", tmp_path / "p1.mmproject")
        with pytest.raises(ValueError, match="does not match"):
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p2.id,
            )

    def test_merge_refuses_segmentation_divergence(self, db_session, tmp_path):
        """J3-2c gate: a re-segmented source must be refused (codings wouldn't line up)."""
        db = db_session
        p, conv, seg = _seed_coded(db, "Seg Diverge")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "sd.mmproject")
        # Target re-segmented AFTER export: add a segment to the shared conversation.
        db.add(Segment(conversation_id=conv.id, sequence_order=1, text="extra chunk"))
        db.flush()
        with pytest.raises(ValueError, match="diverged"):
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id,
            )

    def test_merge_refuses_codebook_divergence(self, db_session, tmp_path):
        """J3-2c gate: a code in the file but not in the local codebook → refuse."""
        db = db_session
        p, conv, seg = _seed_coded(db, "Code Diverge")  # has code Alpha (numeric_id 0)
        _add_code(db, p.id, 1, "Beta")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "cd.mmproject")
        # Target's codebook no longer has Beta.
        beta = db.query(Code).filter(Code.project_id == p.id, Code.name == "Beta").first()
        db.delete(beta)
        db.flush()
        with pytest.raises(ValueError, match="not in your codebook"):
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id,
            )


# ── Track J · J3-2: coder-confirm (D8) + merge endpoint + structured divergence ──


def _two_coder_file(db, tmp_path):
    """Alice (u1=testuser) + Bob (u2) both coded seg S; export, then drop Bob's app
    locally so the merge file carries Bob's work to add back. Returns (p, conv, seg, code, file)."""
    db.add(User(id=2, username="Bob", password_hash="x", is_admin=False, coder_type="human"))
    db.flush()
    p, conv, seg = _seed_coded(db, "Team")
    code = db.query(Code).filter(Code.project_id == p.id).first()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1, origin="human"))
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=2, origin="human"))
    db.flush()
    f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "team.mmproject")
    bob = (
        db.query(CodeApplication)
        .filter(CodeApplication.user_id == 2, CodeApplication.segment_id == seg.id)
        .first()
    )
    db.delete(bob)
    db.flush()
    return p, conv, seg, code, f


def _human_apps(db, seg_id):
    return (
        db.query(CodeApplication)
        .filter(CodeApplication.segment_id == seg_id, CodeApplication.origin == "human")
        .all()
    )


def _upload(data: bytes) -> UploadFile:
    return UploadFile(filename="m.mmproject", file=io.BytesIO(data))


class TestMergeCoderMapping:
    """D8 confirm decisions threaded into the merge coder loop."""

    def test_create_action_attributes_to_new_suffixed_coder(self, db_session, tmp_path):
        """'This is a different person' — create a NEW coder even though a local 'Bob'
        exists; the username collision is suffixed, and Bob's work lands on the new coder."""
        db = db_session
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        mapping = {"2": {"action": "create", "new_username": "Bob"}}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id, coder_mapping=mapping,
        )
        db.flush()
        new_bob = db.query(User).filter(User.username == "Bob (2)").first()
        assert new_bob is not None and new_bob.id != 2  # suffixed, distinct from local Bob
        assert {a.user_id for a in _human_apps(db, seg.id)} == {1, new_bob.id}

    def test_match_action_overrides_to_chosen_coder(self, db_session, tmp_path):
        """Map the colleague's work onto an explicitly chosen local coder (Carol)."""
        db = db_session
        db.add(User(id=3, username="Carol", password_hash="x", is_admin=False, coder_type="human"))
        db.flush()
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        mapping = {"2": {"action": "match", "target_user_id": 3}}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id, coder_mapping=mapping,
        )
        db.flush()
        assert {a.user_id for a in _human_apps(db, seg.id)} == {1, 3}

    def test_unarchive_on_map(self, db_session, tmp_path):
        db = db_session
        dana = User(id=3, username="Dana", password_hash="x", is_admin=False,
                    coder_type="human", archived=True)
        db.add(dana)
        db.flush()
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        mapping = {"2": {"action": "match", "target_user_id": 3, "unarchive": True}}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id, coder_mapping=mapping,
        )
        db.flush()
        db.refresh(dana)
        assert dana.archived is False

    def test_stale_match_target_raises(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        mapping = {"2": {"action": "match", "target_user_id": 99999}}
        with pytest.raises(ValueError, match="no longer exists"):
            import_project(
                db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                target_project_id=p.id, coder_mapping=mapping,
            )


class TestMergeReport:
    def test_report_counts(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        report: dict = {}
        import_project(
            db, f, tmp_path / "docs", user_id=1, import_mode="merge",
            target_project_id=p.id, report=report,
        )
        db.flush()
        assert report["applications_added"] == 1   # Bob's app added back
        assert report["duplicates_skipped"] == 1    # Alice's app deduped
        assert report["sources_matched"] == 1       # the shared conversation
        assert report["coders_created"] == 0        # Alice + Bob both exist locally
        assert report["coders_matched"] == 2


class TestMergeCoderPreview:
    def test_preview_lists_coders_with_local_match(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        preview = build_merge_coder_preview(db, f)
        by_name = {c["username"]: c for c in preview}
        assert by_name["Bob"]["local_match"]["id"] == 2
        assert by_name["Bob"]["file_app_count"] == 1
        # System coders (Unattributed/Consensus) are never offered for mapping.
        assert all(c["coder_type"] not in ("consensus", "unattributed") for c in preview)


class TestValidateImportCodePreview:
    """Track J · J3-2b · B3: validate-import surfaces merge_codes_preview so the UI can
    show the reconcile step before attempting the merge."""

    def _user(self, db):
        return db.query(User).filter(User.id == 1).first()

    def test_validate_surfaces_divergent_codes_with_candidates(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "vip.mmproject",
            twin_names=["Empathy"], divergent_name="Empathic",
        )
        result = _run(validate_import_endpoint(
            file=_upload(f.read_bytes()), db=db, user=self._user(db),
        ))
        assert result["existing_project"]["id"] == p.id       # uuid match → merge possible
        preview = result["merge_codes_preview"]
        assert preview and len(preview) == 1
        assert preview[0]["uuid"] == du and preview[0]["name"] == "Empathic"
        assert twins["Empathy"].id in [c["code_id"] for c in preview[0]["candidates"]]

    def test_validate_frozen_codebook_yields_empty_preview(self, db_session, tmp_path):
        db = db_session
        p, _, _ = _seed_coded(db, "Frozen vip")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "fzv.mmproject")
        result = _run(validate_import_endpoint(
            file=_upload(f.read_bytes()), db=db, user=self._user(db),
        ))
        assert result["existing_project"]["id"] == p.id
        assert result["merge_codes_preview"] == []            # shared-frozen → nothing to reconcile

    def test_validate_import_as_new_has_no_preview(self, db_session, tmp_path):
        """No local project shares the file's uuid → no merge, preview stays None."""
        db = db_session
        p, _, _ = _seed_coded(db, "Orphan")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "orphan.mmproject")
        db.delete(p)  # remove the local twin → file's uuid no longer matches anything local
        db.flush()
        result = _run(validate_import_endpoint(
            file=_upload(f.read_bytes()), db=db, user=self._user(db),
        ))
        assert result["existing_project"] is None
        assert result["merge_codes_preview"] is None


class TestMergeStructuredDivergence:
    def test_segmentation_payload(self, db_session, tmp_path):
        db = db_session
        p, conv, seg = _seed_coded(db, "SegDiv")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "sd.mmproject")
        db.add(Segment(conversation_id=conv.id, sequence_order=1, text="extra chunk"))
        db.flush()
        with pytest.raises(MergeDivergenceError) as ei:
            import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id)
        payload = ei.value.payload
        assert payload["error"] == "merge_divergence" and payload["kind"] == "segmentation"
        assert payload["diverged_sources"][0]["file_segments"] == 1
        assert payload["diverged_sources"][0]["local_segments"] == 2

    def test_codebook_payload(self, db_session, tmp_path):
        db = db_session
        p, conv, seg = _seed_coded(db, "CodeDiv")
        _add_code(db, p.id, 1, "Beta")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "cd.mmproject")
        db.delete(db.query(Code).filter(Code.project_id == p.id, Code.name == "Beta").first())
        db.flush()
        with pytest.raises(MergeDivergenceError) as ei:
            import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge", target_project_id=p.id)
        assert ei.value.payload["kind"] == "codebook"
        assert "Beta" in ei.value.payload["diverged_codes"]


class TestMergeEndpoint:
    """The endpoint ownership gate + error/result mapping (direct async call, shares db_session)."""

    def _user(self, db):
        return db.query(User).filter(User.id == 1).first()

    def test_merge_requires_target(self, db_session):
        db = db_session
        with pytest.raises(HTTPException) as ei:
            _run(import_project_endpoint(
                file=_upload(b""), import_mode="merge", target_project_id=None,
                coder_mapping=None, code_mapping=None, db=db, user=self._user(db),
            ))
        assert ei.value.status_code == 400

    def test_merge_missing_target_404(self, db_session):
        db = db_session
        with pytest.raises(HTTPException) as ei:
            _run(import_project_endpoint(
                file=_upload(b""), import_mode="merge", target_project_id=99999,
                coder_mapping=None, code_mapping=None, db=db, user=self._user(db),
            ))
        assert ei.value.status_code == 404

    def test_merge_divergence_returns_409(self, db_session, tmp_path):
        db = db_session
        p, conv, seg = _seed_coded(db, "EpDiv")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "ed.mmproject")
        db.add(Segment(conversation_id=conv.id, sequence_order=1, text="extra chunk"))
        db.flush()
        with pytest.raises(HTTPException) as ei:
            _run(import_project_endpoint(
                file=_upload(f.read_bytes()), import_mode="merge", target_project_id=p.id,
                coder_mapping=None, code_mapping=None, db=db, user=self._user(db),
            ))
        assert ei.value.status_code == 409                    # MergeDivergenceError caught BEFORE ValueError
        assert ei.value.detail["kind"] == "segmentation"

    def test_merge_success_returns_report(self, db_session, tmp_path):
        db = db_session
        p, conv, seg, code, f = _two_coder_file(db, tmp_path)
        result = _run(import_project_endpoint(
            file=_upload(f.read_bytes()), import_mode="merge", target_project_id=p.id,
            coder_mapping=None, code_mapping=None, db=db, user=self._user(db),
        ))
        assert result.project_id == p.id
        assert result.merge_report is not None
        assert result.merge_report.applications_added == 1
        assert result.merge_report.duplicates_skipped == 1
        assert {a.user_id for a in _human_apps(db, seg.id)} == {1, 2}

    def test_merge_with_code_mapping_reconciles_divergent_code(self, db_session, tmp_path):
        """The code_mapping form field threads through the endpoint → service → reconcile."""
        import json as _json
        db = db_session
        p, conv, seg, twins, du, f = _make_divergent_file(
            db, tmp_path, "ep_reconcile.mmproject",
            twin_names=[], divergent_name="Endpoint New",
        )
        result = _run(import_project_endpoint(
            file=_upload(f.read_bytes()), import_mode="merge", target_project_id=p.id,
            coder_mapping=None, code_mapping=_json.dumps({du: {"action": "new"}}),
            db=db, user=self._user(db),
        ))
        assert result.merge_report.codes_created == 1
        assert db.query(Code).filter(
            Code.project_id == p.id, Code.name == "Endpoint New"
        ).first() is not None


def _rewrite_project_json(src: Path, dest: Path, mutate) -> Path:
    """Copy an .mmproject zip to ``dest`` with project.json transformed by
    ``mutate(data) -> data`` (manifest + every other member preserved verbatim)."""
    import json
    import zipfile

    with zipfile.ZipFile(src) as zin:
        names = zin.namelist()
        data = mutate(json.loads(zin.read("project.json")))
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                if name == "project.json":
                    zout.writestr(name, json.dumps(data))
                else:
                    zout.writestr(name, zin.read(name))
    return dest


class TestMergeDefensiveHardening:
    """Track J · #449 — merge-engine defensive hardening (latent edge guards)."""

    def test_merge_refuses_pre_spine_file(self, db_session, tmp_path):
        """#449(d): a file exported before the J3-2-0 uuid spine (project_uuid present,
        entity uuids absent) is refused BEFORE any write — not exploded mid-insert."""
        db = db_session
        p, _, _ = _seed_coded(db, "PreSpine")
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "ps.mmproject")

        def _strip_entity_uuids(data):
            # Keep project_uuid (so the target identity still matches) — strip the spine.
            for key in ("codes", "segments", "conversations", "documents"):
                for item in data.get(key, []):
                    item.pop("uuid", None)
            return data

        stale = _rewrite_project_json(f, tmp_path / "stale.mmproject", _strip_entity_uuids)
        with pytest.raises(ValueError, match="predates merge support"):
            import_project(
                db, stale, tmp_path / "docs", user_id=1,
                import_mode="merge", target_project_id=p.id,
            )

    def test_merge_preserves_matched_soft_deleted_segment_selfref(self, db_session, tmp_path):
        """#449(b): a malformed file whose soft-deleted segment points merged_into_id at a
        non-exported segment must NOT null (un-soft-delete) the matched local segment."""
        db = db_session
        p, conv, seg_v = _seed_coded(db, "SelfRef")  # seg_v stays visible
        seg_d = Segment(
            conversation_id=conv.id, sequence_order=1, text="merged away",
            merged_into_id=seg_v.id,
        )
        db.add(seg_d)
        db.flush()
        seg_d_uuid, seg_d_id = seg_d.uuid, seg_d.id
        f = _export_to_file(db, p.id, tmp_path / "docs", tmp_path / "sr.mmproject")

        def _break_selfref(data):
            bogus = max((s["_original_id"] for s in data["segments"]), default=0) + 9999
            for s in data["segments"]:
                if s.get("uuid") == seg_d_uuid:
                    s["merged_into_id"] = bogus  # target not present in the export
            return data

        bad = _rewrite_project_json(f, tmp_path / "bad.mmproject", _break_selfref)
        import_project(
            db, bad, tmp_path / "docs", user_id=1,
            import_mode="merge", target_project_id=p.id,
        )
        db.flush()
        refreshed = db.query(Segment).filter(Segment.id == seg_d_id).first()
        # The matched soft-deleted segment keeps its self-ref (not un-deleted to None).
        assert refreshed.merged_into_id == seg_v.id

    def test_merge_uuid_match_scopes_to_target_project(self, db_session):
        """#449(c): the merge uuid match is scoped to the target project when the model has
        a project_id column; models without one match globally (the unique index suffices)."""
        db = db_session
        pa = _make_project(db, "ScopeA")
        pc = _make_project(db, "ScopeC")
        shared = str(_uuid.uuid4())
        conv_c = Conversation(project_id=pc.id, name="inC", status="completed", uuid=shared)
        db.add(conv_c)
        db.flush()

        # Scoped to A: C's conversation is invisible (would otherwise cross-attach).
        assert _merge_uuid_match(db, Conversation, shared, pa.id).first() is None
        # Scoped to C: it matches.
        assert _merge_uuid_match(db, Conversation, shared, pc.id).first().id == conv_c.id

        # Segment has no project_id → matched globally regardless of the project arg.
        seg = Segment(conversation_id=conv_c.id, sequence_order=0, text="x")
        db.add(seg)
        db.flush()
        assert _merge_uuid_match(db, Segment, seg.uuid, pa.id).first().id == seg.id

    def test_import_recodes_topological_accepts_import_mode(self, db_session):
        """#449(a): the recode import helper threads import_mode (forward-proofs fresh_uuid
        consistency with the other import helpers). No-op today; locks the signature."""
        db = db_session
        # Empty list → loop never runs; this asserts the kwarg exists and is accepted.
        _import_recodes_topological(db, [], {}, import_mode="new")
        _import_recodes_topological(db, [], {}, import_mode="merge")
