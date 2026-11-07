"""#1463 D59/D60/D63 — "who has coded here?" is asked PER CODER, and costs the same
whatever the project holds.

Three sites ask it: `coding_coverage.project_coder_counts` (the Dashboard, and
`GET /projects/{id}` on every project page), `project_coder_coverage` (the analysis and
merge pages) and `machine_coder.locked_coder_ids` (`GET /auth/coders`, every page). Each
was a DISTINCT over every coding: 29 s on 3.6M codings, encrypted, against the client's
30 s abort. Each is now an EXISTS per roster coder through `ix_code_applications_code_user`,
about 1 ms. Record: the internal design notes (git-ignored).

Two kinds of guard, because the change has two halves and NEITHER WORKS ALONE (measured):

- **The differential** holds the new functions to the OLD statements, kept verbatim below
  as the oracle (the `_old_inline_dataset_cascade` precedent), over every coder kind the
  filters distinguish, in two projects — and to LITERAL expected answers, so an oracle and
  a function wrong together still fail.
- **The work counts** (`sql-id-sets.md` §6) count SQLite's own work through its progress
  handler, so a machine's speed cannot pass or fail them: each question must cost under
  twice as much on ten times the codings. The DISTINCT fails that (it visits every
  coding); so does the per-coder form WITHOUT the index (it walks every coding of a code
  once per coder who has none) — dropping the index from the model or the migration
  reddens these, and `scripts/schema_diff_harness.py` holds the two together.
"""
from sqlalchemy import func, insert

from app.auth import SYSTEM_CODER_TYPES
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.coding_coverage import project_coder_counts, project_coder_coverage
from app.services.coding_layers import non_consensus_filter
from app.services.machine_coder import locked_coder_ids


# ── The ORACLE: the three statements as they stood before #1463, verbatim ────────


def _old_real_coding_filters():
    return [
        Code.is_universal == False,  # noqa: E712
        non_consensus_filter(),
        User.coder_type.notin_(SYSTEM_CODER_TYPES),
    ]


def _old_project_coder_coverage(db, project_id):
    rows = (
        db.query(User.id, User.username, User.display_color, User.archived, User.coder_type)
        .join(CodeApplication, CodeApplication.user_id == User.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(Code.project_id == project_id, *_old_real_coding_filters())
        .distinct()
        .order_by(User.archived, User.username)
        .all()
    )
    return [(r[0], r[1], r[2], bool(r[3]), r[4]) for r in rows]


def _old_project_coder_counts(db, project_ids):
    if not project_ids:
        return {}
    rows = (
        db.query(Code.project_id, func.count(func.distinct(CodeApplication.user_id)))
        .join(CodeApplication, CodeApplication.code_id == Code.id)
        .join(User, CodeApplication.user_id == User.id)
        .filter(Code.project_id.in_(project_ids), *_old_real_coding_filters())
        .group_by(Code.project_id)
        .all()
    )
    return {pid: count for pid, count in rows}


def _old_locked_coder_ids(db, user_ids):
    if not user_ids:
        return set()
    return {
        uid
        for (uid,) in db.query(CodeApplication.user_id)
        .filter(CodeApplication.user_id.in_(user_ids))
        .distinct()
        .all()
        if uid is not None
    }


def _coverage(db, project_id):
    return [(c.user_id, c.username, c.display_color, c.archived, c.coder_type)
            for c in project_coder_coverage(db, project_id)]


# ── Every coder kind the filters distinguish (the review's `build_multi.py`) ─────

P1, P2 = 801, 802
ALL_CODERS = list(range(1, 12))


def _nine_kinds(db):
    """Project P1's answer is {1, 2, 3, 4}: a person (the fixture's own user), a colleague,
    an ARCHIVED colleague (counted, flagged) and a MACHINE (counted). Never counted in P1:
    5 the consensus coder, 6 the Unattributed bucket, legacy NULL-user rows, 7 (codings
    only in P2), 8 (no codings), 9 (only a UNIVERSAL code), 10 (only consensus-ORIGIN
    rows), 11 (a machine with no codings — the case the old lock answered slowest).
    P2's answer is {7}. The codings sit on all three target kinds (a turn, a document
    paragraph, a survey answer), because the project scope is the CODE, not the source."""
    db.add_all([
        User(id=2, username="colleague", display_color="#224466"),
        User(id=3, username="departed", archived=True),
        User(id=4, username="model-a", coder_type="ai"),
        User(id=5, username="Consensus", coder_type="consensus"),
        User(id=6, username="Unattributed", coder_type="unattributed"),
        User(id=7, username="other-project-only"),
        User(id=8, username="roster-only"),
        User(id=9, username="universal-only"),
        User(id=10, username="consensus-origin-only"),
        User(id=11, username="model-unused", coder_type="ai"),
    ])
    db.add_all([Project(id=P1, name="P1", user_id=1), Project(id=P2, name="P2", user_id=1)])
    db.flush()
    db.add_all([
        Conversation(id=P1, project_id=P1, name="Interview"),
        Conversation(id=P2, project_id=P2, name="Other"),
        Document(id=P1, project_id=P1, name="Notes", source_filename="n.txt", source_format="txt"),
        Code(id=8101, project_id=P1, numeric_id=2, name="A"),
        Code(id=8102, project_id=P1, numeric_id=3, name="B"),
        Code(id=8100, project_id=P1, numeric_id=0, name="Unclear", is_universal=True),
        Code(id=8201, project_id=P2, numeric_id=2, name="P2 code"),
        Dataset(id=P1, project_id=P1, name="Survey"),
    ])
    db.flush()
    db.add_all([
        Segment(id=81001, conversation_id=P1, sequence_order=0, text="a"),
        Segment(id=81002, conversation_id=P1, sequence_order=1, text="b"),
        Segment(id=81003, conversation_id=P1, sequence_order=2, text="c"),
        Segment(id=81004, document_id=P1, sequence_order=0, text="d"),
        Segment(id=82001, conversation_id=P2, sequence_order=0, text="e"),
        DatasetColumn(id=P1, dataset_id=P1, column_text="Comments",
                      column_type=ColumnType.OPEN_TEXT, sequence_order=0),
        DatasetRow(id=P1, dataset_id=P1),
    ])
    db.flush()
    db.add(DatasetValue(id=P1, row_id=P1, column_id=P1, value_text="great"))
    db.flush()
    db.add_all([
        CodeApplication(segment_id=81001, code_id=8101, user_id=1),
        CodeApplication(segment_id=81004, code_id=8102, user_id=2),              # a document
        CodeApplication(dataset_value_id=P1, code_id=8101, user_id=3),           # an answer
        CodeApplication(segment_id=81002, code_id=8101, user_id=4),
        CodeApplication(segment_id=81001, code_id=8101, user_id=5, origin="consensus"),
        CodeApplication(segment_id=81003, code_id=8101, user_id=6),
        CodeApplication(segment_id=81003, code_id=8102, user_id=None),
        CodeApplication(segment_id=81001, code_id=8100, user_id=9),              # universal
        CodeApplication(segment_id=81002, code_id=8102, user_id=10, origin="consensus"),
        CodeApplication(segment_id=82001, code_id=8201, user_id=7),
    ])
    db.flush()
    return db


class TestTheAnswersAreTheOldStatementsAnswers:
    def test_coverage_equals_the_old_statement_in_both_projects(self, db_session):
        db = _nine_kinds(db_session)
        for pid in (P1, P2):
            assert _coverage(db, pid) == _old_project_coder_coverage(db, pid)

    def test_counts_equal_the_old_statement(self, db_session):
        db = _nine_kinds(db_session)
        ids = [P1, P2, 999]
        assert project_coder_counts(db, ids) == _old_project_coder_counts(db, ids)

    def test_the_lock_equals_the_old_statement(self, db_session):
        db = _nine_kinds(db_session)
        assert locked_coder_ids(db, ALL_CODERS) == _old_locked_coder_ids(db, ALL_CODERS)
        assert locked_coder_ids(db, [8, 11]) == _old_locked_coder_ids(db, [8, 11]) == set()
        assert locked_coder_ids(db, []) == set()


class TestTheLiteralAnswers:
    """An oracle and a function wrong TOGETHER would pass the differential; these would not."""

    def test_P1_is_the_four_real_coders_active_first_then_alphabetical(self, db_session):
        cov = _coverage(_nine_kinds(db_session), P1)
        assert [c[1] for c in cov] == ["colleague", "model-a", "testuser", "departed"]
        assert [c[3] for c in cov] == [False, False, False, True]   # the archived flag
        assert [c[4] for c in cov] == ["human", "ai", "human", "human"]
        assert cov[0][2] == "#224466"

    def test_P2_is_the_coder_who_coded_only_there(self, db_session):
        assert [c[0] for c in _coverage(_nine_kinds(db_session), P2)] == [7]

    def test_each_exclusion_arm(self, db_session):
        """One coder per arm, each named — so a dropped arm names itself on failure."""
        counted = {c[0] for c in _coverage(_nine_kinds(db_session), P1)}
        assert 5 not in counted, "the consensus coder (system kind AND consensus origin)"
        assert 6 not in counted, "the Unattributed bucket (system kind)"
        assert 7 not in counted, "a coder whose codings are all in ANOTHER project"
        assert 8 not in counted, "a roster coder with no codings"
        assert 9 not in counted, "a coder who applied only a UNIVERSAL code"
        assert 10 not in counted, "a coder holding only consensus-ORIGIN rows"
        assert 11 not in counted, "a machine with no codings"

    def test_counts(self, db_session):
        db = _nine_kinds(db_session)
        assert project_coder_counts(db, [P1, P2, 999]) == {P1: 4, P2: 1}
        assert project_coder_counts(db, [P1, P1]) == {P1: 4}   # a repeated id is asked once
        assert project_coder_counts(db, []) == {}

    def test_the_lock_is_any_coding_at_all(self, db_session):
        """The lock is not coverage: a universal mark, a consensus row and a system bucket's
        rows all FREEZE a configuration — "has this coder produced anything?"."""
        db = _nine_kinds(db_session)
        assert locked_coder_ids(db, ALL_CODERS) == {1, 2, 3, 4, 5, 6, 7, 9, 10}


# ── The work counts ──────────────────────────────────────────────────────────────

N_CODES = 5


def _coders(db):
    db.add_all([
        User(id=2, username="colleague"),
        User(id=3, username="departed", archived=True),
        User(id=4, username="model-a", coder_type="ai"),
        User(id=8, username="roster-only"),                 # no codings: the EXISTS walks
        User(id=11, username="model-unused", coder_type="ai"),  # every code for these two
    ])
    db.flush()


def _world(db, pid):
    """A project with N_CODES real codes and a universal one, and one conversation."""
    db.add(Project(id=pid, name=f"P{pid}", user_id=1))
    db.flush()
    db.add(Conversation(id=pid, project_id=pid, name="Interview"))
    db.add_all([Code(id=pid * 10 + k, project_id=pid, numeric_id=k + 2, name=f"C{k}")
                for k in range(N_CODES)])
    db.add(Code(id=pid * 10 + 9, project_id=pid, numeric_id=0, name="Unclear", is_universal=True))
    db.flush()


def _code(db, pid, first, n):
    """`n` more turns in `pid`'s conversation, ids from `first`, each coded on the SAME
    codes: by the fixture's user always, the colleague on every other turn, and the
    archived coder and the machine now and then. The number of codes never grows."""
    db.execute(insert(Segment.__table__), [
        {"id": first + i, "conversation_id": pid, "sequence_order": first + i, "text": "t"}
        for i in range(n)
    ])
    rows = []
    for i in range(n):
        seg, code = first + i, pid * 10 + (i % N_CODES)
        rows.append({"segment_id": seg, "code_id": code, "user_id": 1})
        if i % 2 == 0:
            rows.append({"segment_id": seg, "code_id": code, "user_id": 2})
        if i % 50 == 7:
            rows.append({"segment_id": seg, "code_id": code, "user_id": 3})
        if i % 50 == 21:
            rows.append({"segment_id": seg, "code_id": code, "user_id": 4})
    db.execute(insert(CodeApplication.__table__), rows)
    db.flush()


def _work(db, fn):
    """SQLite's own work for one call, counted every 100 virtual-machine steps."""
    conn = db.connection().connection.driver_connection
    ticks = [0]

    def tick():
        ticks[0] += 1
        return 0

    conn.set_progress_handler(tick, 100)
    try:
        answer = fn()
    finally:
        conn.set_progress_handler(None, 100)
    return ticks[0], answer


SMALL, LARGE = 2_000, 20_000


class TestTheCoderQuestionsCostTheSameOnTenTimesTheCodings:
    """⚠️ The SAME codes on both sides: the per-coder question is one seek per (code,
    coder), so its cost moves with the codebook and the roster — never with the codings.
    The old DISTINCT measured ~10x here, as did the per-coder form without the index."""

    def test_the_coverage(self, db_session):
        db = db_session
        _coders(db)
        _world(db, 901)
        _code(db, 901, 1_000_000, SMALL)
        _world(db, 902)
        _code(db, 902, 2_000_000, LARGE)
        small, a = _work(db, lambda: project_coder_coverage(db, 901))
        large, b = _work(db, lambda: project_coder_coverage(db, 902))
        assert [c.user_id for c in a] == [c.user_id for c in b] == [2, 4, 1, 3]  # it answered
        assert small > 0
        assert large < 2 * small, (small, large)

    def test_the_count(self, db_session):
        db = db_session
        _coders(db)
        _world(db, 901)
        _code(db, 901, 1_000_000, SMALL)
        _world(db, 902)
        _code(db, 902, 2_000_000, LARGE)
        small, a = _work(db, lambda: project_coder_counts(db, [901]))
        large, b = _work(db, lambda: project_coder_counts(db, [902]))
        assert a == {901: 4} and b == {902: 4}
        assert large < 2 * small, (small, large)

    def test_the_lock(self, db_session):
        """Install-wide, so the codings grow in place: nine times more turns on the same
        codes. A machine with no codings is in the roster — the old full scan's worst case."""
        db = db_session
        _coders(db)
        _world(db, 901)
        _code(db, 901, 1_000_000, SMALL)
        roster = [1, 2, 3, 4, 8, 11]
        small, a = _work(db, lambda: locked_coder_ids(db, roster))
        _code(db, 901, 1_000_000 + SMALL, LARGE - SMALL)
        large, b = _work(db, lambda: locked_coder_ids(db, roster))
        assert a == b == {1, 2, 3, 4}
        assert small > 0
        assert large < 2 * small, (small, large)
