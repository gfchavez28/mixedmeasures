"""The v7 read side: per-entity JSONL entries, and the v<=6 inline fallback (#958).

**Why this file exists.** `test_portability_stream_equivalence.py` owns the WRITE side and
says so: it proves the Core and ORM serializers agree, and since v7 that the rows land in
`{key}.jsonl` rather than inline. Nothing there reads an archive back. The format decision
(the internal design notes) names step 3 — the reader and the
import call sites — as *"where the data loss lives"*, and the failure it describes is
silent: a one-shot generator yields nothing on a second pass, so the rows simply do not
arrive and the import reports success.

⚠️ **This file is not the gate.** The gate for the reader is a round trip over a REAL
corpus (`backend/scripts/measure_portability.py`, the BES and GSS archives in
`testdata/scale_review/`), because a fixture of seven rows cannot see a batching or
ordering defect. What these tests pin is the set of properties a corpus run cannot
isolate: which pass fails, what a missing entry does, and that an old file still imports.
"""
from __future__ import annotations

import json
import os
import uuid as uuid_module
import zipfile
from pathlib import Path

import pytest

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.excerpt import Excerpt
from app.models.note import Note
from app.models.project import Project
from app.models.segment import Segment
from app.services import project_portability as pp
from tests.archive_support import rewrite_as_v6


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def coded_project(db_session, tmp_path):
    """A project with rows in EVERY entity the format moves, plus the children that
    remap through `dataset_values` — an excerpt, a note and a coding.

    🔴 **Those three are the point.** `remap["dataset_values"]` is rebuilt by a SECOND
    pass over the values, and it is read by exactly these consumers. A reader that can be
    iterated only once leaves that remap empty, and then every quote, note and coding on a
    survey response lands on nothing — while the values themselves import perfectly and
    the import reports success.
    """
    project = Project(name="Coded", user_id=1, project_uuid=str(uuid_module.uuid4()))
    db_session.add(project)
    db_session.flush()

    ds = Dataset(project_id=project.id, name="D")
    db_session.add(ds)
    db_session.flush()
    # The Enum member, never the string — a plain string stays a `str` on the Python
    # attribute until it round-trips through the DB (`backend/tests/the internal design notes).
    col = DatasetColumn(dataset_id=ds.id, column_name="q1", column_text="Q1",
                        column_type=ColumnType.NUMERIC,
                        sequence_order=0, display_order=0)
    db_session.add(col)
    db_session.flush()

    values = []
    for i in range(6):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i}")
        db_session.add(row)
        db_session.flush()
        val = DatasetValue(row_id=row.id, column_id=col.id,
                           value_text=f"answer {i}", value_numeric=float(i))
        db_session.add(val)
        values.append(val)
    db_session.flush()

    conv = Conversation(project_id=project.id, name="C")
    db_session.add(conv)
    db_session.flush()
    segs = []
    for i in range(4):
        seg = Segment(conversation_id=conv.id, sequence_order=i, text=f"turn {i}")
        db_session.add(seg)
        segs.append(seg)
    db_session.flush()

    code = Code(project_id=project.id, name="Cde", numeric_id=1,
                is_active=True, is_universal=False)
    db_session.add(code)
    db_session.flush()
    for seg in segs:
        db_session.add(CodeApplication(code_id=code.id, segment_id=seg.id,
                                       user_id=1, origin="human"))
    # The three children that reach a dataset VALUE, each on a different cell so a
    # remap that is merely off-by-one is distinguishable from one that is empty.
    db_session.add(CodeApplication(code_id=code.id, dataset_value_id=values[1].id,
                                   user_id=1, origin="human"))
    db_session.add(Excerpt(project_id=project.id, dataset_value_id=values[3].id))
    db_session.add(Note(dataset_value_id=values[5].id, content="on the last answer",
                        sequence_number=1))
    db_session.commit()
    return project


def _export(db, project, tmp_path) -> Path:
    out = tmp_path / f"{project.id}.mmproject"
    out.write_bytes(
        pp.export_project(db, project.id, tmp_path / "docs", include_media=False).getvalue()
    )
    return out


#: A faithful OLD file rather than a hand-built one — every field is whatever this
#: build's exporter produced, so the only thing under test is the LAYOUT.
_rewrite_as_v6 = rewrite_as_v6


def _landed(db, pid: int) -> dict[str, int]:
    """What actually arrived, counted at the DATABASE rather than at the archive."""
    ds_ids = [d.id for d in db.query(Dataset).filter(Dataset.project_id == pid).all()]
    row_ids = [
        r.id for r in db.query(DatasetRow).filter(DatasetRow.dataset_id.in_(ds_ids)).all()
    ] if ds_ids else []
    conv_ids = [
        c.id for c in db.query(Conversation).filter(Conversation.project_id == pid).all()
    ]
    seg_ids = [
        s.id for s in db.query(Segment).filter(Segment.conversation_id.in_(conv_ids)).all()
    ] if conv_ids else []
    value_ids = [
        v.id for v in db.query(DatasetValue).filter(DatasetValue.row_id.in_(row_ids)).all()
    ] if row_ids else []
    return {
        "dataset_rows": len(row_ids),
        "dataset_values": len(value_ids),
        "segments": len(seg_ids),
        "segment_codings": db.query(CodeApplication).filter(
            CodeApplication.segment_id.in_(seg_ids)).count() if seg_ids else 0,
        "value_codings": db.query(CodeApplication).filter(
            CodeApplication.dataset_value_id.in_(value_ids)).count() if value_ids else 0,
        "value_excerpts": db.query(Excerpt).filter(
            Excerpt.dataset_value_id.in_(value_ids)).count() if value_ids else 0,
        "value_notes": db.query(Note).filter(
            Note.dataset_value_id.in_(value_ids)).count() if value_ids else 0,
    }


EXPECTED = {
    "dataset_rows": 6, "dataset_values": 6, "segments": 4,
    "segment_codings": 4, "value_codings": 1, "value_excerpts": 1, "value_notes": 1,
}


# ── The round trip, both layouts ────────────────────────────────────────────

class TestTheRoundTrip:

    def test_a_v7_archive_imports_every_entity_and_every_child(
        self, db_session, coded_project, tmp_path,
    ):
        archive = _export(db_session, coded_project, tmp_path)
        pid, _ = pp.import_project(db_session, archive, tmp_path / "docs2", user_id=1)
        db_session.flush()
        assert _landed(db_session, pid) == EXPECTED

    def test_a_v6_archive_still_imports_unchanged(self, db_session, coded_project,
                                                  tmp_path):
        """The fallback is not a legacy branch to retire — it is every file ever exported.

        v7 shipped in one release; v1–v6 are four years of archives, and a researcher's
        `.mmproject` is a backup as much as an exchange file.
        """
        v7 = _export(db_session, coded_project, tmp_path)
        v6 = _rewrite_as_v6(v7, tmp_path / "old.mmproject")
        pid, _ = pp.import_project(db_session, v6, tmp_path / "docs3", user_id=1)
        db_session.flush()
        assert _landed(db_session, pid) == EXPECTED

    def test_the_two_layouts_land_the_same_cells(self, db_session, coded_project,
                                                 tmp_path):
        """Not just the same COUNTS — the same values under the same children.

        A remap that is populated but WRONG passes every count assertion above. This
        reads the cell each child actually points at.
        """
        v7 = _export(db_session, coded_project, tmp_path)
        v6 = _rewrite_as_v6(v7, tmp_path / "old.mmproject")

        def child_targets(archive: Path, docs: str) -> dict[str, str]:
            pid, _ = pp.import_project(db_session, archive, tmp_path / docs, user_id=1)
            db_session.flush()
            ds_ids = [d.id for d in db_session.query(Dataset).filter(
                Dataset.project_id == pid).all()]
            row_ids = [r.id for r in db_session.query(DatasetRow).filter(
                DatasetRow.dataset_id.in_(ds_ids)).all()]
            vals = {v.id: v.value_text for v in db_session.query(DatasetValue).filter(
                DatasetValue.row_id.in_(row_ids)).all()}
            coding = db_session.query(CodeApplication).filter(
                CodeApplication.dataset_value_id.in_(list(vals))).one()
            excerpt = db_session.query(Excerpt).filter(
                Excerpt.dataset_value_id.in_(list(vals))).one()
            note = db_session.query(Note).filter(
                Note.dataset_value_id.in_(list(vals))).one()
            return {
                "coding": vals[coding.dataset_value_id],
                "excerpt": vals[excerpt.dataset_value_id],
                "note": vals[note.dataset_value_id],
            }

        from_v7 = child_targets(v7, "d7")
        from_v6 = child_targets(v6, "d6")
        assert from_v7 == {"coding": "answer 1", "excerpt": "answer 3",
                           "note": "answer 5"}, (
            "the children landed on the wrong cells — `remap['dataset_values']` is "
            "populated from a SECOND pass over the entry, which is the pass a one-shot "
            "reader loses"
        )
        assert from_v6 == from_v7


# ── What a missing or damaged entry does ────────────────────────────────────

class TestAMissingEntry:
    """🔴 An absent entry must never read as an entity with no rows.

    This is the same rule as the version gate one level down: a v6 build reading a v7
    file gets `[]` from `data.get("dataset_values")` and imports a dataset with its
    columns, its rows and not one cell. Inside v7 the equivalent is a truncated archive,
    and the answer is the same — refuse, say which member, and write nothing.
    """

    def _without(self, src: Path, dst: Path, drop: str) -> Path:
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
            for entry in zin.infolist():
                if entry.filename == drop:
                    continue
                zout.writestr(entry, zin.read(entry.filename))
        return dst

    @pytest.mark.parametrize("key", pp.JSONL_ENTITY_KEYS)
    def test_every_entry_is_required_by_name(self, db_session, coded_project, tmp_path,
                                             key):
        archive = _export(db_session, coded_project, tmp_path)
        broken = self._without(archive, tmp_path / f"no-{key}.mmproject",
                               f"{key}.jsonl")
        with pytest.raises(ValueError, match=f"{key}.jsonl"):
            pp.import_project(db_session, broken, tmp_path / "docs4", user_id=1)

    @pytest.mark.parametrize("key", pp.JSONL_ENTITY_KEYS)
    def test_validate_refuses_it_too_so_the_safety_copy_is_never_taken(
        self, db_session, coded_project, tmp_path, key,
    ):
        """The check lives in the helper BOTH doors call, and that is the point.

        A merge or an overwrite writes a full safety export of the target before it
        touches anything. Discovering a truncated archive only at import time means that
        copy is taken — minutes, and a `.mmproject` the size of the project — to protect
        a write that was never going to happen. `/validate-import` is where the
        researcher is standing when they can still choose a different file.
        """
        archive = _export(db_session, coded_project, tmp_path)
        broken = self._without(archive, tmp_path / f"v-{key}.mmproject", f"{key}.jsonl")
        with pytest.raises(ValueError, match=f"{key}.jsonl"):
            pp.validate_project_file(broken)

    def test_the_refusal_happens_before_anything_is_written(self, db_session,
                                                            coded_project, tmp_path):
        """A refused import must leave the database exactly as it found it."""
        archive = _export(db_session, coded_project, tmp_path)
        broken = self._without(archive, tmp_path / "broken.mmproject",
                               "dataset_values.jsonl")
        before = db_session.query(Project).count()
        with pytest.raises(ValueError):
            pp.import_project(db_session, broken, tmp_path / "docs5", user_id=1)
        db_session.rollback()
        assert db_session.query(Project).count() == before

    def test_a_v6_archive_missing_the_entries_is_NOT_refused(self, db_session,
                                                             coded_project, tmp_path):
        """The strictness is keyed on the VERSION, or every old file would be refused."""
        v7 = _export(db_session, coded_project, tmp_path)
        v6 = _rewrite_as_v6(v7, tmp_path / "old.mmproject")
        with zipfile.ZipFile(v6) as zf:
            assert not [n for n in zf.namelist() if n.endswith(".jsonl")]
        pid, _ = pp.import_project(db_session, v6, tmp_path / "docs6", user_id=1)
        assert _landed(db_session, pid) == EXPECTED


# ── The reader itself ───────────────────────────────────────────────────────

class TestTheReader:

    def test_it_can_be_iterated_more_than_once(self, db_session, coded_project,
                                               tmp_path):
        """The defect the format decision names: a generator is empty the second time.

        Asserted on the reader directly as well as through the import, because through
        the import the symptom is 'some children have no target' — which is a long way
        from the cause.
        """
        archive = _export(db_session, coded_project, tmp_path)
        with zipfile.ZipFile(archive) as zf:
            rows = pp._ArchiveRows(zf, "dataset_values.jsonl")
            first = list(rows)
            second = list(rows)
        assert first, "vacuous: the fixture produced no values"
        assert first == second

    def test_bool_is_answered_without_reading_the_member(self, db_session,
                                                         coded_project, tmp_path):
        archive = _export(db_session, coded_project, tmp_path)
        with zipfile.ZipFile(archive) as zf:
            assert bool(pp._ArchiveRows(zf, "dataset_values.jsonl")) is True
            # `row_scores` is empty for this fixture — the `if row_items:` shape in
            # `import_project` reads exactly this.
            assert bool(pp._ArchiveRows(zf, "row_scores.jsonl")) is False

    def test_len_is_deliberately_unavailable(self, db_session, coded_project, tmp_path):
        """A count costs a full pass, so it must be taken knowingly, never by accident."""
        archive = _export(db_session, coded_project, tmp_path)
        with zipfile.ZipFile(archive) as zf:
            with pytest.raises(TypeError):
                len(pp._ArchiveRows(zf, "dataset_values.jsonl"))

    def test_a_trailing_newline_is_not_a_row(self, db_session, coded_project, tmp_path):
        archive = _export(db_session, coded_project, tmp_path)
        with zipfile.ZipFile(archive) as zf:
            raw = zf.read("dataset_values.jsonl")
            rows = list(pp._ArchiveRows(zf, "dataset_values.jsonl"))
        assert raw.endswith(b"\n")
        assert len(rows) == 6


# ── The merge preview's fallback, on a v7 file ──────────────────────────────

def test_the_preview_fallback_counts_applications_on_a_v7_archive(
    db_session, coded_project, tmp_path,
):
    """🔴 A damaged `merge_preview.json` must not turn into "0 applications".

    The fallback re-derives the previews by walking `project.json`. On a v7 archive the
    applications are not in that document at all, so a bare `data.get("code_applications")`
    tallies zero — and a merge-coder preview reading 0 for a colleague who brings hundreds
    of codings is a confident wrong answer at the one screen where the researcher decides
    who maps onto whom. `_entity_rows` is what keeps it honest.
    """
    archive = _export(db_session, coded_project, tmp_path)
    damaged = tmp_path / "damaged.mmproject"
    with zipfile.ZipFile(archive) as zin, zipfile.ZipFile(damaged, "w") as zout:
        for entry in zin.infolist():
            payload = b"not json at all" if entry.filename == "merge_preview.json" \
                else zin.read(entry.filename)
            zout.writestr(entry, payload)

    with zipfile.ZipFile(damaged) as zf:
        block = pp._merge_preview_inputs(zf)
    counts = {c["username"]: c["app_count"] for c in block["coders"]}
    assert counts and all(n == 5 for n in counts.values()), (
        f"the fallback lost the applications on a v7 archive: {counts}"
    )
    assert [c["app_count"] for c in block["codes"]] == [5]
