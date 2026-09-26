"""`merge_preview.json` — the merge previews' precomputed inputs (#860 / #962).

Both merge previews used to parse the WHOLE `project.json` to read two small arrays and
tally applications over them, and `/validate-import` runs BOTH, so it paid that twice.
MEASURED 2026-09-20 on the real corpora in `testdata/scale_review/` (one case per
process, `ru_maxrss`):

    BES   427,398,554 B project.json   5.49 s / 2,043 MB per parse  -> 10.99 s
    GSS   517,777,682 B project.json   6.89 s / 2,611 MB per parse  -> 13.79 s

GSS is the sharpest case: it holds 0 coders, 0 codes and 0 code applications, so that
13.79 s and 2.6 GB bought two empty lists. The precomputed block is 4,368 B on BES and
parses in 0.059 ms.

🔴 **The differential is the test that matters** — `test_the_two_paths_agree`. An
archive written before this shipped has no entry and is projected by the fallback, so
there are two ways into the same contract and they must not drift. They are single-sourced
through `_merge_preview_block`, and this file proves it on an archive with the entry
stripped back out.
"""

import json
import os
import zipfile
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

# Safety guard: ensure in-memory DB (conftest also sets this)
os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_category import CodeCategory
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.project_portability import (
    _MERGE_PREVIEW_ENTRY,
    _merge_preview_inputs,
    build_merge_code_preview,
    build_merge_coder_preview,
    export_project,
    import_project,
)


@pytest.fixture
def db_session():
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


# ── Fixture ─────────────────────────────────────────────────────────────────


def _seed(db: Session, tmp_path: Path) -> tuple[Project, Path]:
    """A project deliberately non-degenerate on every axis the block projects.

    Per `tests/the internal design notes's DISCRIMINATION rule: a fixture on which the right and the
    plausible-wrong projections agree proves nothing. Here every field the block carries
    varies — pinned by `test_the_fixture_could_tell_the_projections_apart`.
    """
    db.add(User(id=2, username="Bob", password_hash="x", coder_type="human"))
    db.add(User(id=3, username="Retired", password_hash="x", coder_type="human",
                archived=True))
    # A SYSTEM coder that owns rows but is never offered for mapping.
    db.add(User(id=4, username="Unattributed", password_hash="x",
                coder_type="unattributed"))
    db.flush()

    p = Project(name="Team", status="active", user_id=1,
                project_uuid="11111111-2222-3333-4444-555555555555")
    db.add(p)
    db.flush()
    conv = Conversation(project_id=p.id, name="C1", status="completed")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="hello world")
    seg2 = Segment(conversation_id=conv.id, sequence_order=1, text="second turn")
    db.add_all([seg, seg2])
    db.flush()

    cat = CodeCategory(project_id=p.id, name="Practices", display_order=0)
    db.add(cat)
    db.flush()

    # Three codes: one categorised and rating-scaled, one uncategorised with a
    # description, one categorised but never applied (app_count 0 must survive).
    scaled = Code(project_id=p.id, numeric_id=0, name="Fidelity", is_active=True,
                  category_id=cat.id, color="#112233", description="scaled code",
                  magnitude_min=-2, magnitude_max=2, magnitude_step=1,
                  magnitude_labels=json.dumps(
                      [{"value": -2, "label": "low"}, {"value": 2, "label": "high"}]
                  ))
    plain = Code(project_id=p.id, numeric_id=1, name="Access", is_active=True,
                 description="no category, no scale")
    unused = Code(project_id=p.id, numeric_id=2, name="Never applied", is_active=True,
                  category_id=cat.id)
    db.add_all([scaled, plain, unused])
    db.flush()

    # Counts differ per coder AND per code, so a swapped tally cannot pass.
    db.add_all([
        CodeApplication(segment_id=seg.id, code_id=scaled.id, user_id=1, origin="human"),
        CodeApplication(segment_id=seg2.id, code_id=scaled.id, user_id=1, origin="human"),
        CodeApplication(segment_id=seg.id, code_id=plain.id, user_id=1, origin="human"),
        CodeApplication(segment_id=seg.id, code_id=scaled.id, user_id=2, origin="human"),
        CodeApplication(segment_id=seg.id, code_id=plain.id, user_id=3, origin="human"),
        # No user_id: counted per CODE and skipped per CODER, which is the one place the
        # two tallies deliberately disagree.
        CodeApplication(segment_id=seg2.id, code_id=plain.id, user_id=None,
                        origin="human"),
        # Owned by a system coder, which the coder preview filters out at READ time.
        CodeApplication(segment_id=seg2.id, code_id=unused.id, user_id=4,
                        origin="human"),
    ])
    db.flush()

    dest = tmp_path / "team.mmproject"
    dest.write_bytes(export_project(db, p.id, tmp_path / "docs").getvalue())
    return p, dest


def _without_the_entry(src: Path, dest: Path) -> Path:
    """The same archive as an older build would have written it — no preview entry."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w") as zout:
        for info in zin.infolist():
            if info.filename == _MERGE_PREVIEW_ENTRY:
                continue
            zout.writestr(info, zin.read(info.filename))
    return dest


def _block(archive: Path) -> dict:
    with zipfile.ZipFile(archive) as z:
        return json.loads(z.read(_MERGE_PREVIEW_ENTRY))


def _project_json(archive: Path) -> dict:
    """The payload, with the v7 entity entries folded in.

    Named for what it was before #958 moved `code_applications` into its own member; the
    assertion below walks that array to re-derive the counts, so it has to read wherever
    the rows actually live.
    """
    from tests.archive_support import archive_payload
    return archive_payload(archive)


# ── The entry ───────────────────────────────────────────────────────────────


class TestTheExportWritesTheEntry:
    def test_the_entry_is_present_and_carries_both_keys(self, db_session, tmp_path):
        _, archive = _seed(db_session, tmp_path)
        with zipfile.ZipFile(archive) as z:
            names = z.namelist()
        assert _MERGE_PREVIEW_ENTRY in names
        # The members every reader requires are untouched by the addition.
        assert "manifest.json" in names and "project.json" in names

        block = _block(archive)
        assert set(block) == {"coders", "codes"}
        assert len(block["codes"]) == 3
        # Every coder is projected, INCLUDING the system one — the filter is the
        # reader's (`SYSTEM_CODER_TYPES`), so the block stays a faithful projection.
        assert {c["username"] for c in block["coders"]} == {
            "testuser", "Bob", "Retired", "Unattributed"
        }

    def test_the_manifest_is_untouched(self, db_session, tmp_path):
        """The block is a SIBLING, not a manifest key: the manifest is 549 B on the real
        corpora, human-read, shown in the import preview, and returned straight into
        `ImportValidationResult` — where a new key would need declaring on
        `ProjectExportManifest` (which the test session runs under `extra='forbid'`) and
        would ride the wire on every validate-import."""
        _, archive = _seed(db_session, tmp_path)
        with zipfile.ZipFile(archive) as z:
            manifest = json.loads(z.read("manifest.json"))
        assert set(manifest) == {
            "format_version", "format_type", "app_version", "created_at",
            "project_name", "project_uuid", "project_summary",
        }


class TestTheCountsMatchTheFileTheyDescribe:
    """The block's tallies come from two `GROUP BY`s over `code_application_clause` —
    the SAME predicate the rows are streamed with. This asserts the agreement against
    the array actually written, which is what the previews used to walk."""

    def test_per_coder_and_per_code_counts_equal_the_exported_array(
        self, db_session, tmp_path
    ):
        _, archive = _seed(db_session, tmp_path)
        data = _project_json(archive)
        block = _block(archive)

        per_coder: dict[int, int] = {}
        per_code: dict[int, int] = {}
        for app in data["code_applications"]:
            if app.get("user_id") is not None:
                per_coder[app["user_id"]] = per_coder.get(app["user_id"], 0) + 1
            if app.get("code_id") is not None:
                per_code[app["code_id"]] = per_code.get(app["code_id"], 0) + 1

        assert {c["_original_id"]: c["app_count"] for c in block["coders"]} == {
            **{cid: 0 for cid in ()}, **per_coder
        }
        assert {
            c["name"]: c["app_count"] for c in block["codes"]
        } == {"Fidelity": per_code[1], "Access": per_code[2], "Never applied": per_code[3]}

    def test_the_two_tallies_disagree_where_they_are_meant_to(
        self, db_session, tmp_path
    ):
        """PREDICATE falsifier for the one deliberate difference: an application with a
        NULL `user_id` counts for its CODE and for no coder. A fixture without one
        cannot tell the two filters apart."""
        _, archive = _seed(db_session, tmp_path)
        block = _block(archive)
        by_code = {c["name"]: c["app_count"] for c in block["codes"]}
        assert sum(c["app_count"] for c in block["coders"]) == 6
        assert sum(by_code.values()) == 7  # the unattributed row is the seventh


# ── The differential ────────────────────────────────────────────────────────


class TestTheTwoPathsAgree:
    """🔴 The entry-reading path and the `project.json` fallback are ONE projection
    (`_merge_preview_block`) with two callers. This is the proof, on a real export with
    the entry stripped back out."""

    def test_the_coder_preview_is_identical_either_way(self, db_session, tmp_path):
        db = db_session
        _, archive = _seed(db, tmp_path)
        legacy = _without_the_entry(archive, tmp_path / "legacy.mmproject")

        assert build_merge_coder_preview(db, archive) == build_merge_coder_preview(
            db, legacy
        )

    def test_the_code_preview_is_identical_either_way(self, db_session, tmp_path):
        db = db_session
        p, archive = _seed(db, tmp_path)
        legacy = _without_the_entry(archive, tmp_path / "legacy.mmproject")

        # Make the file's codes divergent, so the preview has rows to compare rather
        # than the empty shared-frozen case. ⚠️ Divergence is GLOBAL (uuid is globally
        # unique), so the source project's own codes have to go — otherwise the file's
        # uuids are still local and the preview is correctly empty.
        db.query(CodeApplication).delete()
        db.query(Code).filter(Code.project_id == p.id).delete()
        db.flush()
        target = Project(name="Mine", status="active", user_id=1,
                         project_uuid="99999999-8888-7777-6666-555555555555")
        db.add(target)
        db.flush()
        db.add(Code(project_id=target.id, numeric_id=0, name="Fidelity of use",
                    is_active=True))
        db.flush()

        from_entry = build_merge_code_preview(db, archive, target.id)
        from_fallback = build_merge_code_preview(db, legacy, target.id)
        assert from_entry == from_fallback
        # Non-vacuous: the comparison is over real rows, with the fields the block
        # resolves at export actually populated.
        assert len(from_entry) == 3
        scaled = next(r for r in from_entry if r["name"] == "Fidelity")
        assert scaled["category_name"] == "Practices"
        assert scaled["file_app_count"] == 3
        assert scaled["magnitude_scale"] is not None
        assert scaled["candidates"], "the fixture should rank a local candidate"

    def test_the_fixture_could_tell_the_projections_apart(self, db_session, tmp_path):
        """DISCRIMINATION (`tests/the internal design notes): the differential above is only worth
        running because every projected field VARIES across the fixture's rows."""
        _, archive = _seed(db_session, tmp_path)
        block = _block(archive)
        codes = block["codes"]
        assert len({c["app_count"] for c in codes}) > 1, "counts must differ per code"
        assert len({c["category_name"] for c in codes}) > 1, "a NULL and a real category"
        assert len({c["description"] for c in codes}) > 1
        assert sum(1 for c in codes if c["magnitude_min"] is not None) == 1
        coders = block["coders"]
        assert len({c["app_count"] for c in coders}) > 1, "counts must differ per coder"
        assert any(c["archived"] for c in coders) and not all(
            c["archived"] for c in coders
        )
        assert len({c["coder_type"] for c in coders}) > 1


# ── What the entry does and does not change ─────────────────────────────────


class TestTheEntryIsNotConsulted:
    def test_the_preview_never_opens_project_json(self, db_session, tmp_path,
                                                  monkeypatch):
        """The WIN, asserted as behaviour rather than inferred from timings: with the
        entry present, neither preview touches the half-gigabyte member."""
        db = db_session
        p, archive = _seed(db, tmp_path)
        target = Project(name="Mine", status="active", user_id=1, project_uuid="x-y-z")
        db.add(target)
        db.flush()

        opened: list[str] = []
        real_read = zipfile.ZipFile.read

        def spy(self, name, *a, **k):
            opened.append(name if isinstance(name, str) else name.filename)
            return real_read(self, name, *a, **k)

        monkeypatch.setattr(zipfile.ZipFile, "read", spy)
        build_merge_coder_preview(db, archive)
        build_merge_code_preview(db, archive, target.id)

        assert opened == [_MERGE_PREVIEW_ENTRY, _MERGE_PREVIEW_ENTRY]
        assert "project.json" not in opened

    def test_an_archive_without_the_entry_falls_back_to_project_json(
        self, db_session, tmp_path, monkeypatch
    ):
        """PREDICATE falsifier for the spy above: it CAN observe `project.json`."""
        db = db_session
        _, archive = _seed(db, tmp_path)
        legacy = _without_the_entry(archive, tmp_path / "legacy.mmproject")

        opened: list[str] = []
        real_read = zipfile.ZipFile.read

        def spy(self, name, *a, **k):
            opened.append(name if isinstance(name, str) else name.filename)
            return real_read(self, name, *a, **k)

        monkeypatch.setattr(zipfile.ZipFile, "read", spy)
        assert build_merge_coder_preview(db, legacy)
        assert opened == ["project.json"]

    def test_the_import_never_reads_the_entry(self, db_session, tmp_path):
        """⚠️ The block is DERIVED data for a PREVIEW. Corrupting it must not disturb an
        import — a disagreement with `project.json` has to be a wrong preview, never a
        wrong merge."""
        db = db_session
        _, archive = _seed(db, tmp_path)

        corrupt = tmp_path / "corrupt.mmproject"
        with zipfile.ZipFile(archive) as zin, zipfile.ZipFile(corrupt, "w") as zout:
            for info in zin.infolist():
                if info.filename == _MERGE_PREVIEW_ENTRY:
                    zout.writestr(info.filename, b"{ this is not json")
                else:
                    zout.writestr(info, zin.read(info.filename))

        new_id, _name = import_project(
            db, corrupt, user_id=1, docs_dir=tmp_path / "in_docs",
            media_dir=tmp_path / "in_media",
        )
        imported = db.query(Project).filter(Project.id == new_id).first()
        assert imported is not None
        assert db.query(Code).filter(Code.project_id == new_id).count() == 3


class TestADamagedEntryIsNoWorseThanNoEntry:
    """🔴 STRICT IN, TOLERANT OUT. The entry is DERIVED data for a preview, so an
    unreadable one must fall back — not refuse.

    This was a real gap in the first draft of this change, found by asking what the
    corrupt-entry fixture two tests down does to `/validate-import` rather than to the
    import: `json.JSONDecodeError` subclasses `ValueError`, which
    `validate_import_endpoint` maps to a **400**. A few damaged kilobytes would have
    refused an archive that imports perfectly well and previewed perfectly well before
    this change existed.
    """

    def _rewrite_entry(self, src: Path, dest: Path, payload: bytes) -> Path:
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w") as zout:
            for info in zin.infolist():
                if info.filename == _MERGE_PREVIEW_ENTRY:
                    zout.writestr(info.filename, payload)
                else:
                    zout.writestr(info, zin.read(info.filename))
        return dest

    @pytest.mark.parametrize(
        "payload, why",
        [
            (b"{ this is not json", "unparseable"),
            (b"[]", "right JSON, wrong type"),
            (b'{"coders": []}', "half the contract"),
            (b'{"coders": {}, "codes": []}', "a key of the wrong type"),
        ],
    )
    def test_a_damaged_entry_previews_exactly_as_if_it_were_absent(
        self, db_session, tmp_path, payload, why
    ):
        db = db_session
        _, archive = _seed(db, tmp_path)
        legacy = _without_the_entry(archive, tmp_path / "legacy.mmproject")
        damaged = self._rewrite_entry(
            archive, tmp_path / f"damaged-{len(payload)}.mmproject", payload
        )
        assert build_merge_coder_preview(db, damaged) == build_merge_coder_preview(
            db, legacy
        ), why

    def test_a_valid_block_is_returned_verbatim(self, db_session, tmp_path):
        """The accessor hands back the entry's own bytes, not a re-projection of them.

        ⚠️ **This is NOT the falsifier for "a valid block is not sent to the fallback",
        and its first docstring said it was.** Mutation-proved: an arm that ALWAYS falls
        back still passes here, because the two paths produce identical output — which is
        the entire design. The test that kills that mutant is
        `test_the_preview_never_opens_project_json`, which watches which member is read.
        A comment naming the test that guards a property is a claim like any other.
        """
        db = db_session
        _, archive = _seed(db, tmp_path)
        with zipfile.ZipFile(archive) as z:
            assert _merge_preview_inputs(z) == json.loads(z.read(_MERGE_PREVIEW_ENTRY))


class TestEdgesThatMustNotChange:
    def test_a_file_whose_codes_have_no_uuid_previews_nothing(self, db_session,
                                                              tmp_path):
        """A pre-spine archive: `build_merge_code_preview` returned [] before this
        change and must still, whichever path produced its inputs."""
        db = db_session
        _, archive = _seed(db, tmp_path)
        stripped = tmp_path / "nouuid.mmproject"
        with zipfile.ZipFile(archive) as zin, zipfile.ZipFile(stripped, "w") as zout:
            for info in zin.infolist():
                if info.filename == _MERGE_PREVIEW_ENTRY:
                    block = json.loads(zin.read(info.filename))
                    for c in block["codes"]:
                        c["uuid"] = None
                    zout.writestr(info.filename, json.dumps(block))
                else:
                    zout.writestr(info, zin.read(info.filename))

        target = Project(name="Mine", status="active", user_id=1, project_uuid="q")
        db.add(target)
        db.flush()
        assert build_merge_code_preview(db, stripped, target.id) == []

    def test_system_coders_are_still_excluded(self, db_session, tmp_path):
        db = db_session
        _, archive = _seed(db, tmp_path)
        preview = build_merge_coder_preview(db, archive)
        assert "Unattributed" not in {c["username"] for c in preview}
        by_name = {c["username"]: c for c in preview}
        assert by_name["Bob"]["file_app_count"] == 1
        assert by_name["testuser"]["file_app_count"] == 3
        assert by_name["Retired"]["archived"] is True
        assert by_name["testuser"]["local_match"]["id"] == 1
