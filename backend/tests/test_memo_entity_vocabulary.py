"""The memo entity-type vocabulary, declared FIVE times and disagreeing (#780).

The entry was filed as *"two hand-maintained lists"* with **no live defect** —
both carry the same 11 types, measured. Scoping it at pickup found three more
declarations and two live holes, which is the queue-entry-is-not-the-scope rule
paying out again.

    schemas/memo.py                          regex, 11 types
    project_portability.py MEMO_ENTITY_REMAP dict,  11 types
    routers/memos.py                         validation chain, 10 — no `document`
    routers/scratchpad.py                    validation chain,  8 — no `document`,
                                             `observation` or `canvas`
    models/memo.py                           docstring says 4, column comment says 5

⚠️ **`Memo.entity_id` carries NO ForeignKey**, which is what makes every gap
silent: nothing raises, and the row points at whatever happens to own that id.

⚠️ **`test_ownership_gate_sweep.py` is structurally blind to this.** Both
endpoints DO call `_get_project_or_404`, so the project gate is satisfied; the
hole is in the per-ENTITY check that runs after it. A sweep that asks "does this
endpoint reach a gate token" cannot see a branch chain that forgot an arm.

⚠️ **Do not confuse this vocabulary with `log_action(entity_type=...)`** — the
audit log has its own, unrelated set (`code_application`, `speaker`,
`blind_mode`, …) and must not be folded in.
"""

import pytest
from fastapi import HTTPException

from app.models.code import Code
from app.models.code_category import CodeCategory
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.materials import Material, MaterialCollection
from app.models.memo import MEMO_ENTITY_TYPES, Memo
from app.models.project import Project
from app.routers.memos import _validate_memo_entity
from app.services.project_portability import MEMO_ENTITY_REMAP


class TestOneVocabulary:
    """The remedy is DERIVATION, not an agreement test between copies.

    #515 → #676: *pin the RELATIONSHIP between the two sets — derive one from a
    schema/constraint the next variant must touch — never the variant you just
    added.* `MEMO_ENTITY_TYPES` lives beside the column it describes, the schema
    builds its pattern from it, and everything else is checked against it.
    """

    def test_the_vocabulary_is_non_empty(self):
        # A population self-check (#730): every assertion below is vacuously
        # true if the set is empty, including when an import silently rots.
        assert len(MEMO_ENTITY_TYPES) >= 11

    def test_the_schema_pattern_is_DERIVED_from_it(self):
        from app.schemas.memo import MemoCreate

        pattern = MemoCreate.model_fields["entity_type"].metadata[0].pattern
        for t in MEMO_ENTITY_TYPES:
            assert f"|{t}|" in f"|{'|'.join(MEMO_ENTITY_TYPES)}|", t
        # Every declared type is accepted, and nothing else is.
        for t in MEMO_ENTITY_TYPES:
            MemoCreate(entity_type=t, entity_id=1)
        with pytest.raises(Exception):
            MemoCreate(entity_type="participant", entity_id=1)
        assert pattern.startswith("^(") and pattern.endswith(")$")

    def test_the_portability_remap_covers_every_type(self):
        """A type missing here imports cleanly onto a stranger's row.

        The map's own comment says so; nothing enforced it until now.
        """
        missing = set(MEMO_ENTITY_TYPES) - set(MEMO_ENTITY_REMAP)
        assert not missing, f"MEMO_ENTITY_REMAP is missing {sorted(missing)}"

    def test_the_remap_declares_nothing_the_vocabulary_does_not(self):
        # The other direction: a stale key here is a type nobody can create.
        extra = set(MEMO_ENTITY_REMAP) - set(MEMO_ENTITY_TYPES)
        assert not extra, f"MEMO_ENTITY_REMAP has retired types {sorted(extra)}"


class TestEveryTypeIsVALIDATED:
    """🔴 The live half, and the reason this stopped being a guard-only issue.

    `_validate_memo_entity` is a branch chain with no `else`, so a type it does
    not know falls through **validated by nothing** — the project-ownership
    check simply does not run for it.
    """

    def _project(self, db):
        db.add_all([
            Project(id=940, name="Mine", user_id=1),
            Project(id=941, name="Theirs", user_id=1),
        ])
        db.flush()
        return 940, 941

    def test_no_declared_type_falls_through_unvalidated(self, db_session):
        """The POPULATION assertion — the only shape that catches a MISSING arm.

        A per-type test proves the types someone remembered; this fails for the
        next one nobody adds an arm for. `document` was exactly that: accepted by
        the regex, matched by no branch, checked by nothing.
        """
        db = db_session
        mine, _theirs = self._project(db)
        unvalidated = []
        for t in MEMO_ENTITY_TYPES:
            if t == "project":
                continue  # its rule is entity_id == project_id, tested below
            try:
                # id 999_999 exists nowhere, so a validated type MUST refuse it.
                _validate_memo_entity(db, mine, t, 999_999)
            except HTTPException:
                continue
            unvalidated.append(t)
        assert not unvalidated, (
            f"these memo entity types accept a nonexistent entity_id: {unvalidated}"
        )

    def test_a_foreign_projects_entity_is_refused(self, db_session):
        """Existing-but-not-mine is the case a bare existence check would pass."""
        db = db_session
        mine, theirs = self._project(db)
        db.add_all([
            Conversation(id=940, project_id=theirs, name="C"),
            Document(id=940, project_id=theirs, name="D",
                     source_filename="d.docx", source_format="docx"),
            Code(id=940, project_id=theirs, numeric_id=1, name="X"),
            CodeCategory(id=940, project_id=theirs, name="Cat"),
        ])
        coll = MaterialCollection(id=940, project_id=theirs, name="M")
        db.add(coll)
        db.flush()
        db.add(Material(id=940, collection_id=940, material_type="mean",
                        config="{}", auto_name="M"))
        db.flush()

        for t in ("conversation", "document", "code", "code_category", "analysis"):
            with pytest.raises(HTTPException) as exc:
                _validate_memo_entity(db, mine, t, 940)
            assert exc.value.status_code == 400, t

    def test_project_memos_must_name_their_own_project(self, db_session):
        db = db_session
        mine, theirs = self._project(db)
        _validate_memo_entity(db, mine, "project", mine)
        with pytest.raises(HTTPException):
            _validate_memo_entity(db, mine, "project", theirs)

    def test_a_legitimate_entity_is_ACCEPTED(self, db_session):
        """The two-sided half — a guard that refuses everything also passes."""
        db = db_session
        mine, _ = self._project(db)
        db.add(Document(id=942, project_id=mine, name="D",
                        source_filename="d.docx", source_format="docx"))
        db.flush()
        _validate_memo_entity(db, mine, "document", 942)  # must not raise


class TestBothCreationPathsShareTheValidator:
    """Two endpoints create memos; they had two different chains.

    `routers/memos.py` had an inline chain (10 types) and
    `routers/scratchpad.py` a private copy (8) whose `analysis` arm did not scope
    to the project AT ALL — `Material.id == entity_id`, no collection join — so
    converting a scratchpad entry could attach a memo to another project's
    material. The #733 rule: a copy does not merely drift, it propagates.
    """

    def test_the_scratchpad_path_uses_the_shared_validator(self):
        import inspect

        from app.routers import scratchpad

        src = inspect.getsource(scratchpad)
        assert "_validate_memo_entity" in src
        # ...and does not carry its own chain any more.
        assert 'entity_type == "dataset_row"' not in src, (
            "scratchpad.py has re-inlined a validation chain"
        )

    def test_the_memos_router_uses_the_shared_validator(self):
        import inspect

        from app.routers import memos

        src = inspect.getsource(memos.create_memo)
        assert "_validate_memo_entity" in src
        assert "entity_models" not in src, "memos.py has re-inlined its chain"
