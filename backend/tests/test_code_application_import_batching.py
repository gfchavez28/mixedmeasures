"""#958's ORM half — code applications import in BATCHES, and a merge dedups per batch.

`import_project` used to insert every code application through `_add`: one ORM instance
and one FLUSH per row, plus — in a merge — one duplicate-check query per row. On the BES
corpus that was 1,208,742 round trips (and twice that on a merge). It is a Core
`executemany` now, and a merge asks for the existing rows on a whole batch's targets at
once.

🔴 **What these tests exist to pin is that the per-row semantics SURVIVED the batching.**
The old loop treated a row as a duplicate if it was in the database OR had been inserted
moments earlier by the same import. Batching splits "moments earlier" into two cases —
an earlier batch (already in the database) and the SAME batch (only in memory) — and a
fixture larger than one batch never reaches the first boundary. So every test here
shrinks `CODE_APPLICATION_IMPORT_BATCH` to put a boundary INSIDE a small fixture, and
the in-file duplicate test runs at two sizes, one per case.
"""
from __future__ import annotations

import json
import uuid as _uuid
from pathlib import Path

import pytest
from sqlalchemy import event

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import project_portability as pp
from app.services.project_portability import export_project, import_project

from tests.archive_support import archive_extras, archive_payload, write_archive


@pytest.fixture
def db_session():
    """Per-test empty database session with User id=1 (the merge suite's fixture)."""
    from app.database import Base, SessionLocal, engine
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


@pytest.fixture
def tiny_batches(monkeypatch):
    """Put batch boundaries INSIDE the fixtures (see the module docstring)."""
    def _set(n: int) -> None:
        monkeypatch.setattr(pp, "CODE_APPLICATION_IMPORT_BATCH", n)
    _set(2)
    return _set


# ── Fixtures ────────────────────────────────────────────────────────────────


def _coded_project(db, *, n_segments: int = 5):
    """A project whose codings reach BOTH target kinds, rated on a −1…+1 scale.

    Returns (project, segments, value, code). Seven applications: one per segment by
    user 1, two more by user 2, and one on a dataset cell — the ``val`` arm of the
    duplicate key, which a segments-only fixture would never exercise.
    """
    db.add(User(id=2, username="Bob", password_hash="x", is_admin=False, coder_type="human"))
    db.flush()
    p = Project(name="Batch", status="active", user_id=1, project_uuid=str(_uuid.uuid4()))
    db.add(p)
    db.flush()
    conv = Conversation(project_id=p.id, name="C1", status="completed")
    db.add(conv)
    db.flush()
    segs = []
    for i in range(n_segments):
        s = Segment(conversation_id=conv.id, sequence_order=i, text=f"turn {i}")
        db.add(s)
        segs.append(s)
    db.flush()
    code = Code(project_id=p.id, numeric_id=0, name="Alpha", is_active=True,
                magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5)
    db.add(code)
    db.flush()
    ds = Dataset(project_id=p.id, name="Survey")
    db.add(ds)
    db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_name="Comment", column_text="Comment",
                        column_type="open_text", sequence_order=0, display_order=0)
    db.add(col)
    db.flush()
    row = DatasetRow(dataset_id=ds.id, row_identifier="R1")
    db.add(row)
    db.flush()
    val = DatasetValue(row_id=row.id, column_id=col.id, value_text="a comment")
    db.add(val)
    db.flush()
    # Zero is INTERIOR on −1…+1, so a truthiness slip on a rating cannot hide.
    ratings = [0.0, 0.5, -1.0, None, 1.0]
    for s, r in zip(segs, ratings):
        db.add(CodeApplication(segment_id=s.id, code_id=code.id, user_id=1,
                               origin="human", magnitude=r, attribution="Alice"))
    db.add(CodeApplication(segment_id=segs[0].id, code_id=code.id, user_id=2,
                           origin="human", magnitude=-0.5))
    db.add(CodeApplication(segment_id=segs[1].id, code_id=code.id, user_id=2, origin="human"))
    db.add(CodeApplication(dataset_value_id=val.id, code_id=code.id, user_id=1,
                           origin="human", magnitude=0.5))
    db.flush()
    return p, segs, val, code


def _export(db, pid, tmp_path: Path, name: str = "p.mmproject") -> Path:
    dest = tmp_path / name
    dest.write_bytes(export_project(db, pid, tmp_path / "docs").getvalue())
    return dest


def _apps_of(db, pid) -> list[CodeApplication]:
    seg_apps = (
        db.query(CodeApplication)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .filter(Conversation.project_id == pid, CodeApplication.origin != "consensus")
    )
    val_apps = (
        db.query(CodeApplication)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(Dataset.project_id == pid, CodeApplication.origin != "consensus")
    )
    # The consensus layer is DERIVED and re-materialised on every import with two or
    # more coders, so it is excluded here: these tests are about the imported rows.
    return seg_apps.all() + val_apps.all()


def _signature(app: CodeApplication) -> tuple:
    """What an application IS, independent of any id this database assigned."""
    target = (
        ("seg", app.segment.sequence_order) if app.segment_id is not None
        else ("val", app.dataset_value.value_text)
    )
    return (target, app.code.name, app.user_id, app.magnitude, app.magnitude_conflict,
            app.origin, app.attribution)


def _doctor(src: Path, dst: Path, mutate) -> Path:
    """Rewrite the archive's `code_applications` rows through `mutate(list) -> list`."""
    payload = archive_payload(src)
    payload["code_applications"] = mutate(payload["code_applications"])
    manifest = json.loads(__import__("zipfile").ZipFile(str(src)).read("manifest.json"))
    return write_archive(dst, manifest, payload, archive_extras(src))


# ── The new-project path ────────────────────────────────────────────────────


class TestAPlainImportCarriesEveryApplication:

    def test_every_application_arrives_with_every_field(self, db_session, tmp_path, tiny_batches):
        db = db_session
        p, *_ = _coded_project(db)
        before = sorted(map(_signature, _apps_of(db, p.id)), key=repr)
        f = _export(db, p.id, tmp_path)

        new_id, _ = import_project(db, f, tmp_path / "docs", user_id=1)
        db.flush()

        after = sorted(map(_signature, _apps_of(db, new_id)), key=repr)
        assert len(after) == 8
        assert after == before

    def test_a_row_missing_a_column_still_imports_with_that_columns_default(
        self, db_session, tmp_path, tiny_batches
    ):
        """A hand-edited file can omit a column on SOME rows; an ordinary export cannot.
        The ORM-enabled bulk insert batches by key set itself, so the omitted columns
        take their defaults. This pins that the drain keeps relying on that (a raw
        Core `executemany` over mixed key sets would not)."""
        db = db_session
        p, *_ = _coded_project(db)
        f = _export(db, p.id, tmp_path)

        def drop_columns_from_one_row(rows):
            rows[1].pop("origin", None)
            rows[1].pop("created_at", None)
            return rows

        doctored = _doctor(f, tmp_path / "doctored.mmproject", drop_columns_from_one_row)
        new_id, _ = import_project(db, doctored, tmp_path / "docs", user_id=1)
        db.flush()

        apps = _apps_of(db, new_id)
        assert len(apps) == 8
        assert all(a.origin == "human" for a in apps)
        assert all(a.created_at is not None for a in apps)


# ── The merge path ──────────────────────────────────────────────────────────


class TestAMergeDedupsPerBatch:

    def test_re_merging_your_own_export_adds_nothing(self, db_session, tmp_path, tiny_batches):
        db = db_session
        p, *_ = _coded_project(db)
        f = _export(db, p.id, tmp_path)
        before = len(_apps_of(db, p.id))

        report: dict = {}
        import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                       target_project_id=p.id, report=report)
        db.flush()

        assert len(_apps_of(db, p.id)) == before
        assert report["applications_added"] == 0
        assert report["duplicates_skipped"] == 8
        assert report["magnitude_conflicts"] == 0

    @pytest.mark.parametrize("batch", [2, 50], ids=["across-a-batch-boundary", "within-one-batch"])
    def test_a_duplicate_inside_the_file_is_a_duplicate(
        self, db_session, tmp_path, tiny_batches, batch
    ):
        """The same (target, code, coder) twice in ONE file, differing in rating.

        The old per-row loop inserted the first and then found it with its duplicate
        query, flagging the second's rating as a conflict. At batch 2 the pair falls
        in DIFFERENT batches (the second is found in the database); at batch 50 it
        falls in the SAME one (found in the batch's pending rows). Both must behave
        as the per-row loop did.
        """
        tiny_batches(batch)
        db = db_session
        p, segs, _val, code = _coded_project(db)
        f = _export(db, p.id, tmp_path)
        # Bob's application on segment 1 is removed locally, so the merge must ADD it.
        db.query(CodeApplication).filter(
            CodeApplication.segment_id == segs[1].id, CodeApplication.user_id == 2,
        ).delete()
        db.flush()

        def duplicate_bobs_row(rows):
            bob = next(r for r in rows if r["user_id"] == 2 and r["magnitude"] is None)
            bob["magnitude"] = 1.0
            twin = dict(bob, _original_id=10_000, magnitude=-1.0)
            # Put three rows between the pair, so at batch 2 they straddle a boundary.
            at = rows.index(bob)
            return rows[: at + 1] + rows[at + 1: at + 4] + [twin] + rows[at + 4:]

        doctored = _doctor(f, tmp_path / "dup.mmproject", duplicate_bobs_row)
        report: dict = {}
        import_project(db, doctored, tmp_path / "docs", user_id=1, import_mode="merge",
                       target_project_id=p.id, report=report)
        db.flush()

        bobs = db.query(CodeApplication).filter(
            CodeApplication.segment_id == segs[1].id, CodeApplication.user_id == 2,
        ).all()
        assert len(bobs) == 1, "the twin must not become a second application"
        assert bobs[0].magnitude == 1.0, "the FIRST copy's rating is the one that lands"
        assert bobs[0].magnitude_conflict == -1.0, "the twin's rating is the conflict"
        assert report["applications_added"] == 1
        assert report["duplicates_skipped"] == 8  # the seven already present + the twin
        assert report["magnitude_conflicts"] == 1

    def test_a_conflict_on_an_EXISTING_row_is_written_and_a_stale_one_cleared(
        self, db_session, tmp_path, tiny_batches
    ):
        """The UPDATE half: matched rows already in the target change only their flag."""
        db = db_session
        p, segs, val, code = _coded_project(db)
        f = _export(db, p.id, tmp_path)
        seg0_alice = db.query(CodeApplication).filter(
            CodeApplication.segment_id == segs[0].id, CodeApplication.user_id == 1).one()
        seg0_alice.magnitude = 1.0           # the file says 0.0 → a conflict of ZERO
        cell = db.query(CodeApplication).filter(
            CodeApplication.dataset_value_id == val.id).one()
        cell.magnitude_conflict = -1.0       # stale; the file agrees (0.5) → cleared
        db.flush()

        report: dict = {}
        import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                       target_project_id=p.id, report=report)
        db.expire_all()

        seg0_alice = db.query(CodeApplication).filter(
            CodeApplication.segment_id == segs[0].id, CodeApplication.user_id == 1).one()
        assert seg0_alice.magnitude == 1.0
        assert seg0_alice.magnitude_conflict == 0.0 and seg0_alice.magnitude_conflict is not None
        cell = db.query(CodeApplication).filter(
            CodeApplication.dataset_value_id == val.id).one()
        assert cell.magnitude == 0.5 and cell.magnitude_conflict is None
        assert report["magnitude_conflicts"] == 1

    def test_legacy_null_coder_rows_match_the_LOWEST_id(self, db_session, tmp_path, tiny_batches):
        """A NULL `user_id` escapes the per-coder unique index, so a target can hold two
        pre-J1 rows on one (target, code). The old `.first()` settled on one of them;
        the batch query orders by id, so it is the lowest, deterministically."""
        db = db_session
        p, segs, _val, code = _coded_project(db)
        db.add(CodeApplication(segment_id=segs[4].id, code_id=code.id, user_id=None,
                               origin="human", magnitude=0.0))
        db.flush()
        f = _export(db, p.id, tmp_path)
        second = CodeApplication(segment_id=segs[4].id, code_id=code.id, user_id=None,
                                 origin="human", magnitude=0.0)
        db.add(second)
        db.flush()
        lowest = min(
            a.id for a in db.query(CodeApplication).filter(
                CodeApplication.segment_id == segs[4].id,
                CodeApplication.user_id.is_(None)).all()
        )

        def rerate_the_null_row(rows):
            for r in rows:
                if r["user_id"] is None:
                    r["magnitude"] = 1.0
            return rows

        doctored = _doctor(f, tmp_path / "null.mmproject", rerate_the_null_row)
        import_project(db, doctored, tmp_path / "docs", user_id=1, import_mode="merge",
                       target_project_id=p.id)
        db.expire_all()

        flagged = db.query(CodeApplication).filter(
            CodeApplication.segment_id == segs[4].id,
            CodeApplication.user_id.is_(None),
            CodeApplication.magnitude_conflict.isnot(None),
        ).all()
        assert [a.id for a in flagged] == [lowest]


DUPLICATE_CHECK_PREFIX = (
    "SELECT code_applications.id, code_applications.segment_id, "
    "code_applications.dataset_value_id, code_applications.code_id, "
    "code_applications.user_id, code_applications.magnitude, "
    "code_applications.magnitude_conflict FROM code_applications"
)


class TestTheMergeAsksPerBatchNotPerRow:

    def test_the_duplicate_check_is_one_query_per_batch(self, db_session, tmp_path, tiny_batches):
        """The property the change exists for. The old loop ran one
        `SELECT … FROM code_applications` per incoming row; a batch runs one."""
        tiny_batches(3)
        db = db_session
        p, *_ = _coded_project(db)
        f = _export(db, p.id, tmp_path)

        selects: list[str] = []

        def count(conn, cursor, statement, params, context, executemany):
            # The duplicate check's exact column list. The merge's safety copy also
            # reads `code_applications` (an export), so a looser match counts it too.
            s = " ".join(statement.split())
            if s.startswith(DUPLICATE_CHECK_PREFIX):
                selects.append(s)

        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", count)
        try:
            import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                           target_project_id=p.id)
        finally:
            event.remove(engine, "before_cursor_execute", count)

        # 8 applications in batches of 3 → 3 duplicate-check queries, never 8.
        assert len(selects) == 3, selects
