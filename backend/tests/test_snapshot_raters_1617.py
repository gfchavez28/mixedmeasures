"""#1617 / #1623 (D222–D225) — a blind reader is kept from the participant table by WHOSE
ratings its snapshot holds, and the live rule it falls back to is a seek, not a walk.

The rating columns are a SNAPSHOT (`Dataset.managed_synced_at`), and the withholding used to
ask who holds a rating NOW (`score_rater_ids`). So a colleague whose every rating went after
the refresh was shown again — Bob's 5 read straight off the 3.5 beside Alice's 2 (#1623, the
review's probe on `test_blind_file_scope_1530.py`'s own fixture). Now:

- D222: the refresh records the raters its rollup READ (`MagnitudeRollup.rater_ids`) as
  `Dataset.managed_rater_ids`, and the withholding asks that record — no query at all.
- D223: a table with no record (an older build's refresh, an import, which writes none)
  falls back to the live rule, archived coders counted.
- D224: the live rule seeks `ix_code_applications_rated`, so its cost follows the codes and
  the coders, never the unrated codings (#1617: 25.7–27.6 s encrypted on a 4.9M-coding
  project before).
- D225: while the refresh writes its cells in committed batches, the record covers BOTH the
  previous snapshot's raters and the new one's.
"""
import json
import zipfile

import pytest
from sqlalchemy import event, insert, select
from sqlalchemy.orm import sessionmaker

from app import config, database
from app.database import Base
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import Dataset
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.services import participant_scores as ps
from app.services.magnitude_rollup import compute_magnitude_rollup
from app.services.participant_dataset import MANAGED_KIND_PARTICIPANTS
from app.services.project_portability import export_project, import_project
from tests.archive_support import archive_payload
from tests.test_blind_file_scope_1530 import (  # noqa: F401 — the fixtures are used by name
    ALICE, BOB, PID, SCOPE, SHARED, T0, T1, _grid, _user, blind_project, scored_project,
)

CAROL = 4


def _bobs_rated(db):
    return (db.query(CodeApplication)
            .filter(CodeApplication.user_id == BOB, CodeApplication.magnitude.isnot(None)).all())


def _withheld(db, ds_id, scope=SCOPE):
    return _grid(db, ds_id, scope).withheld_rating_columns


def _scores_shown(db, ds_id, score_col_id, scope=SCOPE):
    return [r.values[str(score_col_id)].value_numeric
            for r in _grid(db, ds_id, scope).rows if str(score_col_id) in r.values]


def _recorded(db, ds_id):
    raw = db.execute(select(Dataset.managed_rater_ids).where(Dataset.id == ds_id)).scalar()
    return raw, ps.parse_managed_rater_ids(raw)


def _add_carol(db):
    db.add(User(id=CAROL, username="Carol", password_hash=None, coder_type="human"))
    db.flush()


# ── #1623: the gap the probe found, closed ──────────────────────────────────


class TestTheSnapshotsRatersDecide:
    def test_the_refresh_records_both_raters(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        raw, recorded = _recorded(db, ds.id)
        assert recorded == {ALICE, BOB}
        assert raw == json.dumps([ALICE, BOB])          # sorted JSON, the stored form

    def test_control_bob_still_rated(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        assert _withheld(db, ds.id) == 2

    def test_bob_clears_his_rating_after_the_refresh(self, scored_project):
        """The probe's case: HEAD showed Alice 3.5, from which Bob's 5 is 2 × 3.5 − 2."""
        db, ds = scored_project["db"], scored_project["dataset"]
        col = scored_project["cols"]["magnitude_score"]
        apps = _bobs_rated(db)
        assert apps, "fixture: Bob holds a rating"
        for a in apps:
            a.magnitude = None
        db.flush()
        assert ps.score_rater_ids(db, PID) == {ALICE}   # the live rule no longer sees him …
        assert _withheld(db, ds.id) == 2                # … the snapshot still holds his 5
        assert _scores_shown(db, ds.id, col.id) == []

    def test_bobs_rated_codings_removed_after_the_refresh(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        for a in _bobs_rated(db):
            db.delete(a)
        db.flush()
        assert ps.score_rater_ids(db, PID) == {ALICE}
        assert _withheld(db, ds.id) == 2

    def test_the_next_refresh_records_the_new_snapshot(self, scored_project):
        """After Bob clears and the table is refreshed, the cells hold Alice's rating
        alone — so she sees them, and the score is her own 2."""
        db, ds = scored_project["db"], scored_project["dataset"]
        col = scored_project["cols"]["magnitude_score"]
        for a in _bobs_rated(db):
            a.magnitude = None
        db.flush()
        ps.refresh_participant_dataset(db, PID)
        assert _recorded(db, ds.id)[1] == {ALICE}
        assert _withheld(db, ds.id) == 0
        assert _scores_shown(db, ds.id, col.id) == [2.0]

    def test_an_archived_raters_record_still_withholds_and_a_later_refresh_drops_him(
            self, scored_project):
        """Refreshed while Bob was active: the record names him whatever his state now.
        Refreshed AFTER the archive: the gather leaves him out, so his ratings are in no
        cell and the record does not name him — exact."""
        db, ds = scored_project["db"], scored_project["dataset"]
        db.get(User, BOB).archived = True
        db.flush()
        assert _withheld(db, ds.id) == 2
        ps.refresh_participant_dataset(db, PID)
        assert _recorded(db, ds.id)[1] == {ALICE}
        assert _withheld(db, ds.id) == 0


class TestARatingAddedAfterTheRefreshIsInNoCell:
    def test_it_does_not_withhold_until_a_refresh_takes_it(self, scored_project):
        """Exactness: Carol rates after the refresh, and a scope of Alice and Bob — every
        rater the cells hold — is not withheld. The live rule withheld here (Carol is a
        live rater outside the scope); the record knows her rating is in no cell."""
        db, ds = scored_project["db"], scored_project["dataset"]
        _add_carol(db)
        db.add(CodeApplication(code_id=SHARED, user_id=CAROL, segment_id=T1, magnitude=4.0))
        db.flush()
        both = f"{ALICE},{BOB}"
        assert CAROL in ps.score_rater_ids(db, PID)     # discrimination: the live rule
        assert _withheld(db, ds.id, both) == 0          # would have said 2
        ps.refresh_participant_dataset(db, PID)
        assert _recorded(db, ds.id)[1] == {ALICE, BOB, CAROL}
        assert _withheld(db, ds.id, both) == 2


# ── D222: what the rollup records ───────────────────────────────────────────


class TestTheRollupsRaters:
    def test_a_rating_the_rollup_excluded_still_names_its_coder(self, scored_project):
        """Collected before any exclusion: Carol's rating on the interviewer's turn (a
        speaker no participant holds) is left out of every score, and she is still
        recorded — over-recording is the fail-closed direction."""
        db, ds = scored_project["db"], scored_project["dataset"]
        _add_carol(db)
        db.add(CodeApplication(code_id=SHARED, user_id=CAROL, segment_id=T0, magnitude=3.0))
        db.flush()
        rollup = compute_magnitude_rollup(db, PID, coder_ids=None)
        assert rollup.excluded_ratings == {"speaker_unlinked": 1}   # hers, and only hers
        assert CAROL in rollup.rater_ids
        ps.refresh_participant_dataset(db, PID)
        assert _recorded(db, ds.id)[1] == {ALICE, BOB, CAROL}

    def test_a_rating_of_zero_is_a_rating(self, scored_project):
        """`is not None`, never truthiness: on a −1…+1 scale zero is a real rating."""
        db = scored_project["db"]
        _add_carol(db)
        db.add(Code(id=15359, project_id=PID, numeric_id=9, name="Bipolar",
                    is_universal=False, is_active=True,
                    magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5))
        db.flush()
        db.add(CodeApplication(code_id=15359, user_id=CAROL, segment_id=T1, magnitude=0.0))
        db.flush()
        assert CAROL in compute_magnitude_rollup(db, PID, coder_ids=None).rater_ids

    def test_an_applied_but_unrated_code_is_not_a_rating(self, scored_project):
        db = scored_project["db"]
        _add_carol(db)
        db.add(CodeApplication(code_id=SHARED, user_id=CAROL, segment_id=T1, magnitude=None))
        db.flush()
        rollup = compute_magnitude_rollup(db, PID, coder_ids=None)
        assert rollup.rater_ids == {ALICE, BOB}


# ── D225: the record while the cells are written ────────────────────────────


class TestTheRecordWhileTheCellsAreWritten:
    def _observe_the_write(self, monkeypatch, db, ds_id, *, fail=False):
        seen = []
        real = ps._write_cell_plan

        def watching(session, plan):
            seen.append(_recorded(db, ds_id)[1])
            if fail:
                raise RuntimeError("a cell batch failed")
            return real(session, plan)

        monkeypatch.setattr(ps, "_write_cell_plan", watching)
        return seen

    def test_it_holds_the_old_and_the_new_raters_then_the_new(self, scored_project, monkeypatch):
        """Bob clears, Carol rates: the cells about to be written are Carol's, the ones
        not yet rewritten Bob's, so a blind reader between two batches needs both."""
        db, ds = scored_project["db"], scored_project["dataset"]
        _add_carol(db)
        for a in _bobs_rated(db):
            a.magnitude = None
        db.add(CodeApplication(code_id=SHARED, user_id=CAROL, segment_id=T1, magnitude=4.0))
        db.flush()
        seen = self._observe_the_write(monkeypatch, db, ds.id)
        ps.refresh_participant_dataset(db, PID)
        assert seen == [{ALICE, BOB, CAROL}]
        assert _recorded(db, ds.id)[1] == {ALICE, CAROL}

    def test_a_failed_write_leaves_the_union(self, scored_project, monkeypatch):
        db, ds = scored_project["db"], scored_project["dataset"]
        _add_carol(db)
        for a in _bobs_rated(db):
            a.magnitude = None
        db.add(CodeApplication(code_id=SHARED, user_id=CAROL, segment_id=T1, magnitude=4.0))
        db.flush()
        self._observe_the_write(monkeypatch, db, ds.id, fail=True)
        with pytest.raises(RuntimeError):
            ps.refresh_participant_dataset(db, PID)
        assert _recorded(db, ds.id)[1] == {ALICE, BOB, CAROL}

    def test_a_table_with_no_record_takes_the_live_raters_for_the_old_cells(
            self, scored_project, monkeypatch):
        """No record (D223): the previous cells' raters are the live rule's answer. Bob is
        archived, so the new rollup leaves him out while the live rule — archived counted —
        names him: the window must hold him, the old cells still being his."""
        db, ds = scored_project["db"], scored_project["dataset"]
        db.get(Dataset, ds.id).managed_rater_ids = None
        db.get(User, BOB).archived = True
        db.flush()
        assert compute_magnitude_rollup(db, PID, coder_ids=None).rater_ids == {ALICE}
        seen = self._observe_the_write(monkeypatch, db, ds.id)
        ps.refresh_participant_dataset(db, PID)
        assert seen == [{ALICE, BOB}]
        assert _recorded(db, ds.id)[1] == {ALICE}


# ── D223: no record → the live rule ─────────────────────────────────────────


class TestNoRecordFallsBackToTheLiveRule:
    def test_a_table_with_no_record_asks_who_rates_now(self, scored_project):
        """HEAD's behaviour, archived counted — and its residual: Bob cleared is not seen."""
        db, ds = scored_project["db"], scored_project["dataset"]
        db.get(Dataset, ds.id).managed_rater_ids = None
        db.flush()
        assert _withheld(db, ds.id) == 2
        db.get(User, BOB).archived = True
        db.flush()
        assert _withheld(db, ds.id) == 2                # archived, still rating: counted
        for a in _bobs_rated(db):
            a.magnitude = None
        db.flush()
        assert _withheld(db, ds.id) == 0                # the stated residual (D223)

    @pytest.mark.parametrize("raw", [
        "not json", '{"ids": [2, 3]}', "[true]", '[2, "3"]', "[2.5]", "", "null",
    ])
    def test_a_malformed_record_reads_as_none(self, raw):
        assert ps.parse_managed_rater_ids(raw) is None

    def test_a_malformed_record_falls_back_rather_than_failing(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        db.get(Dataset, ds.id).managed_rater_ids = '[2, "3"]'
        db.flush()
        assert _withheld(db, ds.id) == 2                # the live rule, no 500

    def test_an_empty_record_is_a_record(self, scored_project):
        """`[]` — nobody's ratings in the cells — is not "no record": nothing is withheld
        though Bob is a live rater outside the scope."""
        db, ds = scored_project["db"], scored_project["dataset"]
        assert ps.parse_managed_rater_ids("[]") == frozenset()
        db.get(Dataset, ds.id).managed_rater_ids = "[]"
        db.flush()
        assert BOB in ps.score_rater_ids(db, PID)
        assert _withheld(db, ds.id) == 0


class TestTheImportWritesNoRecord:
    def test_an_imported_participant_table_has_no_record(self, scored_project, tmp_path):
        db = scored_project["db"]
        docs = tmp_path / "docs"
        docs.mkdir()
        archive = tmp_path / "p.mmproject"
        archive.write_bytes(export_project(db, PID, docs).getvalue())
        carried = [d.get("managed_rater_ids") for d in archive_payload(zipfile.ZipFile(archive))["datasets"]
                   if d.get("managed_kind") == MANAGED_KIND_PARTICIPANTS]
        assert carried == [json.dumps([ALICE, BOB])]    # discrimination: the FILE carries it
        before = {i for (i,) in db.query(Project.id)}
        import_project(db, archive, docs, media_dir=None, user_id=1, import_mode="new")
        db.flush()
        (new_pid,) = {i for (i,) in db.query(Project.id)} - before
        imported = (db.query(Dataset)
                    .filter(Dataset.project_id == new_pid,
                            Dataset.managed_kind == MANAGED_KIND_PARTICIPANTS).one())
        assert imported.managed_rater_ids is None


class TestTheRecordNeverRidesTheWire:
    def test_no_dataset_payload_carries_it(self, scored_project):
        from app.routers.dataset import refresh_participants_dataset
        from app.schemas.dataset import DatasetResponse
        db, ds = scored_project["db"], scored_project["dataset"]
        assert "managed_rater_ids" not in DatasetResponse.model_fields
        for payload in (_grid(db, ds.id).model_dump_json(), _grid(db, ds.id, SCOPE).model_dump_json(),
                        refresh_participants_dataset(PID, user=_user(db), db=db).model_dump_json()):
            assert "managed_rater_ids" not in payload
            assert "rater_ids" not in payload


# ── D224: the live rule's plan and its cost ─────────────────────────────────


def _captured_rater_check(db):
    captured = []

    def grab(conn, cursor, statement, parameters, context, executemany):
        captured.append((statement, parameters))

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", grab)
    try:
        answer = ps.score_rater_ids(db, PID)
    finally:
        event.remove(engine, "before_cursor_execute", grab)
    checks = [c for c in captured if "magnitude IS NOT NULL" in c[0]]
    assert len(checks) == 1, [c[0][:80] for c in captured]   # it IS the rater check
    return answer, checks[0]


def _plan(db, statement, parameters):
    raw = db.connection().connection.dbapi_connection
    return " | ".join(str(row[3]) for row in raw.execute("EXPLAIN QUERY PLAN " + statement, parameters))


def _recreate_in_order(db, names):
    """Drop the named `code_applications` indexes and create them again in this order —
    the order SQLite breaks a cost tie by (the last created is tried first)."""
    from sqlalchemy.schema import CreateIndex
    by_name = {ix.name: ix for ix in CodeApplication.__table__.indexes}
    raw = db.connection().connection.dbapi_connection
    dialect = db.get_bind().dialect
    for name in names:
        raw.execute(f"DROP INDEX {name}")
    for name in names:
        raw.execute(str(CreateIndex(by_name[name]).compile(dialect=dialect)))


class TestTheLiveRuleSeeksTheRatedIndex:
    def test_on_sqlite(self, blind_project):
        db = blind_project
        answer, (statement, parameters) = _captured_rater_check(db)
        assert answer == {ALICE, BOB}
        plan = _plan(db, statement, parameters)
        assert "ix_code_applications_rated" in plan, plan
        assert "magnitude>?" in plan, plan              # the rating test is a range on it

    @pytest.mark.parametrize("order", [
        ("ix_code_applications_rated", "ix_code_applications_code_user"),
        ("ix_code_applications_code_user", "ix_code_applications_rated"),
    ])
    def test_whichever_index_was_created_last(self, blind_project, order):
        """D226: on `(code_id, user_id)` alone the two indexes cost the same and the one
        created last won, so `create_all`'s set order decided the plan run by run. The
        third key column makes the rated index cheaper outright."""
        db = blind_project
        _recreate_in_order(db, order)
        _, (statement, parameters) = _captured_rater_check(db)
        plan = _plan(db, statement, parameters)
        assert "ix_code_applications_rated" in plan, (order, plan)

    def test_on_sqlcipher(self, tmp_path, monkeypatch):
        """The shipped engine (SQLCipher's 3.51.1, not pysqlite's): the same plan."""
        pytest.importorskip("sqlcipher3", reason="sqlcipher3 driver not installed")
        monkeypatch.setenv("MM_ENCRYPTION_KEY", "ab" * 32)
        monkeypatch.setattr(database, "settings", config.Settings(
            mm_database_path=str(tmp_path / "enc.db"), mm_encryption_enabled=True))
        engine = database.get_engine()
        try:
            Base.metadata.create_all(engine)
            db = sessionmaker(bind=engine, autoflush=False)()
            try:
                db.add_all([User(id=1, username="t"), User(id=ALICE, username="Alice"),
                            User(id=BOB, username="Bob")])
                db.add(Project(id=PID, name="P", user_id=1))
                db.flush()
                db.add(Conversation(id=PID, project_id=PID, name="I"))
                db.add(Code(id=SHARED, project_id=PID, numeric_id=2, name="S",
                            magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0))
                db.flush()
                db.add(Segment(id=T1, conversation_id=PID, sequence_order=0, text="t"))
                db.flush()
                db.add(CodeApplication(code_id=SHARED, user_id=ALICE, segment_id=T1, magnitude=2.0))
                db.add(CodeApplication(code_id=SHARED, user_id=BOB, segment_id=T1))
                db.flush()
                driver = db.connection().connection.dbapi_connection
                assert type(driver).__module__.startswith("sqlcipher3")   # it IS the cipher
                answer, (statement, parameters) = _captured_rater_check(db)
                assert answer == {ALICE}
                plan = _plan(db, statement, parameters)
                assert "ix_code_applications_rated" in plan, plan
                assert "magnitude>?" in plan, plan
            finally:
                db.close()
        finally:
            engine.dispose()


N_CODES = 6


def _rating_world(db):
    """Two coders on six scaled codes: RATER rated ONE application, on the LAST code (the
    plan walks codes in id order, so without the index every earlier code's applications
    of hers are scanned first); IDLE rated nothing. Both grow only UNRATED codings."""
    db.add_all([User(id=2, username="rater"), User(id=3, username="idle"),
                User(id=4, username="rates-elsewhere")])
    db.add(Project(id=PID, name="P", user_id=1))
    db.flush()
    db.add(Conversation(id=PID, project_id=PID, name="I"))
    db.add_all([Code(id=16170 + k, project_id=PID, numeric_id=k + 2, name=f"C{k}",
                     magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0)
                for k in range(N_CODES)])
    db.flush()
    db.add(Segment(id=99, conversation_id=PID, sequence_order=0, text="t"))
    db.flush()
    db.add(CodeApplication(code_id=16170 + N_CODES - 1, user_id=2, segment_id=99, magnitude=3.0))
    db.flush()


ELSEWHERE = PID + 1


def _grow_unrated(db, first, n):
    db.execute(insert(Segment.__table__), [
        {"id": first + i, "conversation_id": PID, "sequence_order": first + i, "text": "t"}
        for i in range(n)
    ])
    db.execute(insert(CodeApplication.__table__), [
        {"segment_id": first + i, "code_id": 16170 + (i % N_CODES), "user_id": uid}
        for i in range(n) for uid in (2, 3)
    ])
    db.flush()


def _grow_rated_elsewhere(db, first, n):
    """RATINGS in another project on the install, by a coder who rated nothing in the asked
    one. A coder-first index `(user_id, code_id, …)` plans from the coder — `SEARCH
    code_applications USING … (user_id=?)` — and walks every one of them looking for a
    code of the asked project (the review's first try, on D12); code-first seeks per code
    of the asked project and never meets them."""
    if db.get(Project, ELSEWHERE) is None:
        db.add(Project(id=ELSEWHERE, name="Elsewhere", user_id=1))
        db.flush()
        db.add(Conversation(id=ELSEWHERE, project_id=ELSEWHERE, name="I"))
        db.add(Code(id=16190, project_id=ELSEWHERE, numeric_id=2, name="E",
                    magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0))
        db.flush()
    db.execute(insert(Segment.__table__), [
        {"id": first + i, "conversation_id": ELSEWHERE, "sequence_order": first + i, "text": "t"}
        for i in range(n)
    ])
    db.execute(insert(CodeApplication.__table__), [
        {"segment_id": first + i, "code_id": 16190, "user_id": 4, "magnitude": 3.0}
        for i in range(n)
    ])
    db.flush()


SMALL, LARGE = 2_000, 20_000


def _steps(db, fn):
    """SQLite's own virtual-machine steps for one call, every one counted: the seek is
    cheap enough that `test_coder_question_work.py`'s 100-step tick reads it as 1 or 2."""
    conn = db.connection().connection.driver_connection
    steps = [0]

    def tick():
        steps[0] += 1
        return 0

    conn.set_progress_handler(tick, 1)
    try:
        answer = fn()
    finally:
        conn.set_progress_handler(None, 1)
    return steps[0], answer


class TestTheLiveRuleCostsTheSameOnTenTimesTheCodings:
    def test_both_arms(self, db_session):
        """⚠️ Every arm grows (the 11-12d lesson): the idle coder (no rating anywhere —
        the filed case), the rater whose one rating here sits on the LAST code, and a
        coder whose ratings are all in ANOTHER project. Without the index the first two
        walk their unrated codings, ~10x here; with a coder-first one the third walks
        their ratings elsewhere; with this one, a seek per (code, coder), which grows
        only with the index's depth."""
        db = db_session
        _rating_world(db)
        _grow_unrated(db, 1_000_000, SMALL)
        _grow_rated_elsewhere(db, 3_000_000, SMALL)
        small, a = _steps(db, lambda: ps.score_rater_ids(db, PID))
        _grow_unrated(db, 1_000_000 + SMALL, LARGE - SMALL)
        _grow_rated_elsewhere(db, 3_000_000 + SMALL, LARGE - SMALL)
        large, b = _steps(db, lambda: ps.score_rater_ids(db, PID))
        print(f"\nlive rule: {small} steps at {SMALL} turns, {large} at {LARGE}")
        assert a == b == {2}                            # it answered, both arms
        assert small > 0
        assert large < 2 * small, (small, large)
