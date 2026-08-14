"""#747 — a note's sequence number, for every parent.

Three of the four writers stored the literal `0`, so every document, observation
and dataset-value note shared one label. Two surfaces printed it raw — the Excel
export's `N-` column and the Memos & Notes page — while two others hid the gap by
renumbering positionally on read, which is why this survived a parity audit: the
screens that would have shown it were the ones that had worked around it.

The arity test at the bottom is the part that matters longest: it derives the
parent set from `ck_note_at_least_one_parent`, so a FIFTH parent fails here
instead of quietly storing another zero (#515 → #676 → this).
"""
import asyncio
import re
import uuid as _uuid
from pathlib import Path

import pytest
from sqlalchemy import CheckConstraint

from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.document import Document
from app.models.note import Note
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.documents import create_document_note
from app.routers.notes import create_note
from app.routers.observations import create_observation_note
from app.routers.text_coding import create_text_note
from app.schemas.document import DocumentNoteCreateRequest
from app.schemas.note import NoteCreate
from app.schemas.observation import ObservationNoteCreate
from app.schemas.text_coding import TextNoteCreate
from app.services.project_portability import export_project, import_project
from app.services.note_numbering import (
    declared_note_parents,
    next_note_sequence,
    renumber_imported_notes,
)


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    p = Project(name="Numbering", user_id=1)
    db_session.add(p)
    db_session.flush()
    return p


def _new_note(db, **parent) -> Note:
    """Create a note the way a writer does: build, number, add.

    ⚠️ Only for tests ABOUT the service (import renumbering, the migration). The
    per-parent numbering tests drive the real endpoints instead — this helper
    re-implements the writer, so a writer that reverts to a literal 0 leaves it
    entirely green. Measured, not assumed: it did exactly that under mutation
    before these tests were rewritten to call the routers.
    """
    note = Note(content="n", **parent)
    note.sequence_number = next_note_sequence(db, note)
    db.add(note)
    db.flush()
    return note


@pytest.fixture
def parents(db_session, project):
    """One instance of every parent a note can hang off."""
    conv = Conversation(project_id=project.id, name="C")
    doc = Document(project_id=project.id, name="D", source_filename="d.txt",
                   source_format="txt")
    obs = Observation(project_id=project.id, name="O")
    ds = Dataset(project_id=project.id, name="DS")
    db_session.add_all([conv, doc, obs, ds])
    db_session.flush()
    col = DatasetColumn(dataset_id=ds.id, column_name="q1", column_text="Q1",
                        column_type=ColumnType.OPEN_TEXT, sequence_order=1)
    row = DatasetRow(dataset_id=ds.id, row_identifier="R1")
    db_session.add_all([col, row])
    db_session.flush()
    dv = DatasetValue(row_id=row.id, column_id=col.id, value_text="hello")
    db_session.add(dv)
    db_session.flush()
    return {
        "conversation_id": conv.id,
        "document_id": doc.id,
        "observation_id": obs.id,
        "dataset_value_id": dv.id,
    }


@pytest.fixture
def user(db_session):
    return db_session.query(User).filter(User.id == 1).one()


@pytest.fixture
def writers(db_session, project, parents, user):
    """The four REAL create endpoints, each as a zero-arg callable.

    Driving the endpoints is the whole point: the defect was three writers
    storing a literal 0, so a test that numbers notes itself cannot see it.
    """
    seg = Segment(document_id=parents["document_id"], sequence_order=1, text="para")
    clip = Segment(observation_id=parents["observation_id"], sequence_order=1,
                   text="clip", start_time=0.0, end_time=1.0)
    db_session.add_all([seg, clip])
    db_session.flush()

    def conversation():
        return _run(create_note(parents["conversation_id"], NoteCreate(content="n"),
                                user, db_session))

    def document():
        return _run(create_document_note(
            project.id, parents["document_id"],
            DocumentNoteCreateRequest(segment_id=seg.id, content="n"), user, db_session))

    def observation():
        return _run(create_observation_note(
            project.id, parents["observation_id"],
            ObservationNoteCreate(segment_id=clip.id, content="n"), user, db_session))

    def dataset_value():
        return _run(create_text_note(
            project.id,
            TextNoteCreate(dataset_value_id=parents["dataset_value_id"], content="n"),
            user, db_session))

    return {
        "conversation_id": conversation,
        "document_id": document,
        "observation_id": observation,
        "dataset_value_id": dataset_value,
    }


class TestEveryParentIsNumbered:
    @pytest.mark.parametrize("parent_col", [
        "conversation_id", "document_id", "observation_id", "dataset_value_id",
    ])
    def test_notes_number_from_one_and_increment(
        self, db_session, writers, parents, parent_col,
    ):
        for _ in range(3):
            writers[parent_col]()

        # Read back what was STORED, not what the endpoint returned — two of the
        # four answer with a dict, and the export/notes-page defect was about the
        # stored value in the first place.
        stored = (
            db_session.query(Note.sequence_number)
            .filter(getattr(Note, parent_col) == parents[parent_col])
            .order_by(Note.id)
            .all()
        )
        assert [s for (s,) in stored] == [1, 2, 3], (
            f"{parent_col} notes are not numbered — this is the #747 defect, where "
            "three of four writers stored a literal 0"
        )

    def test_numbering_is_scoped_to_the_parent(self, db_session, project, parents):
        """Two documents each start at 1 — the number is per parent, not global."""
        other = Document(project_id=project.id, name="D2", source_filename="d2.txt",
                         source_format="txt")
        db_session.add(other)
        db_session.flush()

        first = _new_note(db_session, document_id=parents["document_id"])
        second = _new_note(db_session, document_id=other.id)
        assert (first.sequence_number, second.sequence_number) == (1, 1)

        # ...and a note on a THIRD parent kind does not see either of them.
        clip_note = _new_note(db_session, observation_id=parents["observation_id"])
        assert clip_note.sequence_number == 1

    def test_archiving_does_not_recycle_a_number(self, db_session, parents):
        """An archived note keeps its number, so the next note cannot reuse it.

        Reuse would give two notes in one parent the same label and silently
        re-point any citation of the older one.
        """
        first = _new_note(db_session, document_id=parents["document_id"])
        first.is_archived = True
        db_session.flush()
        second = _new_note(db_session, document_id=parents["document_id"])
        assert second.sequence_number == 2

    def test_a_parentless_note_is_refused_rather_than_numbered(self, db_session):
        with pytest.raises(ValueError, match="needs a parent"):
            next_note_sequence(db_session, Note(content="orphan"))


class TestImportRenumbering:
    """The #714 rule, one seam over: renumber what THIS import inserted."""

    def test_imported_notes_continue_after_the_targets_own(self, db_session, parents):
        local = [_new_note(db_session, document_id=parents["document_id"]) for _ in range(2)]

        # Two notes arriving from a file, carrying the source's own 1..2.
        incoming = []
        for seq in (1, 2):
            n = Note(content="from file", document_id=parents["document_id"],
                     sequence_number=seq)
            db_session.add(n)
            db_session.flush()
            incoming.append(n)

        moved = renumber_imported_notes(db_session, {n.id for n in incoming})

        assert moved == 2
        assert [n.sequence_number for n in incoming] == [3, 4]
        assert [n.sequence_number for n in local] == [1, 2], (
            "the target's own notes must keep their labels — renumbering them is "
            "the #714 harm this parameter exists to prevent"
        )

    def test_merge_matched_notes_are_left_alone(self, db_session, parents):
        """A note the merge MATCHED is the target's own row, and is not inserted.

        Passing an empty inserted set is exactly what an all-matched merge does,
        so this also pins that the no-op path is a no-op.
        """
        existing = [_new_note(db_session, document_id=parents["document_id"]) for _ in range(3)]
        before = [n.sequence_number for n in existing]

        assert renumber_imported_notes(db_session, set()) == 0
        assert [n.sequence_number for n in existing] == before

    def test_source_order_survives_the_renumber(self, db_session, parents):
        """Imported notes keep their relative order, not their absolute numbers."""
        incoming = []
        for seq in (9, 4, 6):
            n = Note(content="f", observation_id=parents["observation_id"],
                     sequence_number=seq)
            db_session.add(n)
            db_session.flush()
            incoming.append(n)

        renumber_imported_notes(db_session, {n.id for n in incoming})
        by_new = sorted(incoming, key=lambda n: n.sequence_number)
        assert [n.content for n in by_new] == ["f", "f", "f"]
        # 4 → 1, 6 → 2, 9 → 3
        assert [n.sequence_number for n in incoming] == [3, 1, 2]


class TestImportRenumberingIsWired:
    """Drives a REAL `import_project`, because the tests above cannot.

    ⚠️ Every test in `TestImportRenumbering` calls `renumber_imported_notes`
    directly with a hand-built id set, so all of them pass no matter where — or
    whether — `import_project` calls it. It shipped calling it ~50 lines too
    early, beside the excerpt repair, where `inserted_ids["notes"]` is still
    empty: the function returned 0 on its first line and renumbered nothing, on
    every import, with the whole suite green.

    So these assert on note numbers AFTER an import that really ran. The rule
    they encode: a fix wired into a pipeline needs one test that enters at the
    pipeline's mouth, not at the unit's.
    """

    @staticmethod
    def _export(db, project_id, tmp_path) -> Path:
        dest = tmp_path / "p.mmproject"
        dest.write_bytes(export_project(db, project_id, tmp_path / "docs").getvalue())
        return dest

    @staticmethod
    def _seed(db, project_id, seqs):
        """A conversation carrying notes at the given stored numbers."""
        conv = Conversation(project_id=project_id, name="C1")
        db.add(conv)
        db.flush()
        seg = Segment(conversation_id=conv.id, sequence_order=1, text="hello")
        db.add(seg)
        db.flush()
        notes = []
        for i, seq in enumerate(seqs):
            n = Note(conversation_id=conv.id, segment_id=seg.id,
                     content=f"note {i}", sequence_number=seq)
            db.add(n)
            notes.append(n)
        db.flush()
        return conv, seg, notes

    @staticmethod
    def _notes_of(db, project_id):
        return (
            db.query(Note)
            .join(Segment, Note.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .filter(Conversation.project_id == project_id)
            .order_by(Note.id)
            .all()
        )

    def test_an_import_actually_renumbers_what_it_inserted(self, db_session, tmp_path):
        """Gaps in the source compact to 1..n — which only happens if the call runs.

        The fixture numbers are 3/7/11 deliberately: gaps after deletion are
        legal and expected, so a real export carries them. With the call in its
        shipped position the imported notes keep 3/7/11 verbatim, which is what
        makes this fail loudly rather than coincide.
        """
        db = db_session
        p = Project(name="Src", user_id=1, project_uuid=str(_uuid.uuid4()))
        db.add(p)
        db.flush()
        self._seed(db, p.id, [3, 7, 11])
        db.commit()

        src = self._export(db, p.id, tmp_path)
        new_pid, _ = import_project(db, src, tmp_path / "docs2", user_id=1)

        imported = self._notes_of(db, new_pid)
        assert len(imported) == 3, "sanity: the import must have inserted the notes"
        assert [n.sequence_number for n in imported] == [1, 2, 3], (
            "imported notes were not renumbered — `renumber_imported_notes` is "
            "either not called or called before the notes are inserted"
        )
        assert [n.content for n in imported] == ["note 0", "note 1", "note 2"], (
            "the source's relative order must survive the renumber"
        )

    def test_a_merge_does_not_land_a_colliding_label(self, db_session, tmp_path):
        """The scenario the renumber exists for, end to end.

        Two coders' copies each number their own notes from 1. Merging one into
        the other must not leave two notes in one conversation sharing a label —
        `sequence_number` rides the wire as a plain column, so nothing else
        prevents it.
        """
        db = db_session
        p = Project(name="Shared", user_id=1, project_uuid=str(_uuid.uuid4()))
        db.add(p)
        db.flush()
        conv, seg, notes = self._seed(db, p.id, [1])
        db.commit()

        # The colleague's file: this project, with its note.
        src = self._export(db, p.id, tmp_path)

        # Locally that note never existed; a DIFFERENT note took the number 1.
        db.delete(notes[0])
        db.flush()
        local = Note(conversation_id=conv.id, segment_id=seg.id, content="mine")
        local.sequence_number = next_note_sequence(db, local)
        db.add(local)
        db.commit()
        assert local.sequence_number == 1, "fixture: the local note must hold 1"

        import_project(db, src, tmp_path / "docs2", user_id=1,
                       import_mode="merge", target_project_id=p.id)

        after = self._notes_of(db, p.id)
        assert len(after) == 2, "the file's note must have been inserted, not matched"
        seqs = [n.sequence_number for n in after]
        assert len(set(seqs)) == 2, (
            f"both notes on one conversation share a label: {seqs} — a merge "
            "brought a second 1..n run into the same parent"
        )
        assert local.sequence_number == 1, (
            "the target's OWN note must keep its label (#714) — only the "
            "inserted note moves"
        )


class TestBackfillMigration:
    """Runs the migration's OWN sql, not a paraphrase of it.

    The alembic module is loaded by path because `alembic/versions` is not a
    package. Importing the statement rather than re-typing it is the point: a
    re-typed copy would pass while the shipped migration was wrong, which is the
    same "a guard that validates a copy" failure #729 found three times.
    """

    @staticmethod
    def _backfill_sql() -> str:
        import importlib.util
        from pathlib import Path

        path = (Path(__file__).resolve().parents[1] / "alembic" / "versions"
                / "b8e4c2a70d19_backfill_note_sequence_numbers.py")
        spec = importlib.util.spec_from_file_location("mig_b8e4c2a70d19", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module._BACKFILL

    def test_it_numbers_the_zeros_per_parent_and_leaves_conversations_alone(
        self, db_session, project, parents,
    ):
        from sqlalchemy import text

        other_doc = Document(project_id=project.id, name="D2",
                             source_filename="d2.txt", source_format="txt")
        db_session.add(other_doc)
        db_session.flush()

        # The pre-fix state: conversation notes numbered, everything else 0.
        conv_notes = [_new_note(db_session, conversation_id=parents["conversation_id"])
                      for _ in range(2)]
        zeros = {}
        for col, parent_id in [
            ("document_id", parents["document_id"]),
            ("document_id", other_doc.id),
            ("observation_id", parents["observation_id"]),
            ("dataset_value_id", parents["dataset_value_id"]),
        ]:
            made = []
            for _ in range(3):
                n = Note(content="old", sequence_number=0, **{col: parent_id})
                db_session.add(n)
                db_session.flush()
                made.append(n)
            zeros[(col, parent_id)] = made

        db_session.execute(text(self._backfill_sql()))
        db_session.expire_all()

        for (col, parent_id), made in zeros.items():
            assert [n.sequence_number for n in made] == [1, 2, 3], (
                f"{col}={parent_id} was not renumbered 1..3 in id order"
            )
        assert [n.sequence_number for n in conv_notes] == [1, 2], (
            "conversation notes are the ones a researcher may already have cited — "
            "the migration must not touch them"
        )

    def test_a_new_note_continues_after_the_backfill(self, db_session, parents):
        """The writer and the migration must agree, or the first post-migration
        note collides with the last backfilled one."""
        from sqlalchemy import text

        for _ in range(3):
            db_session.add(Note(content="old", sequence_number=0,
                                observation_id=parents["observation_id"]))
        db_session.flush()
        db_session.execute(text(self._backfill_sql()))
        db_session.expire_all()

        nxt = _new_note(db_session, observation_id=parents["observation_id"])
        assert nxt.sequence_number == 4


class TestParentArity:
    """Derived from the CHECK, so a fifth parent cannot arrive unnumbered."""

    def test_declared_parents_match_the_check_constraint(self):
        for c in Note.__table__.constraints:
            if isinstance(c, CheckConstraint) and c.name == "ck_note_at_least_one_parent":
                expected = set(re.findall(r"(\w+_id)\s+IS NOT NULL", str(c.sqltext)))
                break
        else:
            pytest.fail("ck_note_at_least_one_parent is gone")
        assert set(declared_note_parents()) == expected

    def test_every_declared_parent_is_exercised_by_this_file(self, parents):
        """The parametrized test above must cover every parent the schema allows.

        Without this, adding `interview_id` to the CHECK leaves a writer storing
        zeros and every test here still green — the #515/#676 shape, which is
        precisely how #747 came to exist.
        """
        missing = set(declared_note_parents()) - set(parents)
        assert not missing, (
            f"Note gained parent(s) {sorted(missing)} that this file does not "
            "number. Add it to the `parents` fixture and to the parametrize list, "
            "and make sure its writer calls `next_note_sequence`."
        )
