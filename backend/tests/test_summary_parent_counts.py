"""#1463 D62 — the project summary's document and observation counts are planned FROM
THE PARENT, and say what they said before.

`GET /projects/{id}/summary` (TopRail, every project page) counted a project's visible
document segments and observation clips, and the coded ones among them, with the
visible-segment rule written `merged_into_id IS NULL AND split_into_id IS NULL`. SQLite
has no statistics here and prices `split_into_id IS NULL` as selective, so each of the
four counts started from `ix_segments_split_into_id` — every visible segment on the
INSTALL — and probed each for the parent: 1.45 s per count on 1.2M turns, encrypted, for
a project with no documents or observations at all. `visible_segment_filter(
from_parent=True)` writes the same rule as one `coalesce(...) IS NULL`, which no index
serves, so the parent's index is the only way in: about 1 ms.

- **The differential** holds the four counts to the old statements, kept verbatim below.
- **The truth table** holds the one-expression form to the two-clause rule.
- **The work counts** (`sql-id-sets.md` §6): a project's counts must cost the same when
  the install around it grows tenfold — with no documents (the measured case) and with
  some (the plan is from the parent either way).
"""
from sqlalchemy import func, insert

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.helpers import visible_segment_filter
from app.services.coding_counts import (
    coded_segment_count_for_project,
    visible_segment_count_for_project,
)
from app.services.coding_layers import layer_scope_filter

PARENTS = {"document": (Document, Segment.document_id),
           "observation": (Observation, Segment.observation_id)}


# ── The ORACLE: the statements as they stood before #1463, verbatim ──────────────


def _old_visible_count(db, project_id, source):
    parent, fk = PARENTS[source]
    return db.query(func.count(Segment.id)).join(
        parent, fk == parent.id
    ).filter(
        parent.project_id == project_id,
        *visible_segment_filter(),
    ).scalar() or 0


def _old_coded_count(db, project_id, source, layer_scope=None):
    parent, fk = PARENTS[source]
    return (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .select_from(Segment)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .join(parent, fk == parent.id)
        .filter(
            parent.project_id == project_id,
            *visible_segment_filter(),
            Code.is_universal == False,  # noqa: E712
            layer_scope_filter(layer_scope),
        )
    ).scalar() or 0


# ── A project whose documents and clips exercise every arm ───────────────────────

P1, P2 = 811, 812


def _sources(db):
    """Per project: two documents and two observations. In each parent, segments that
    are visible, MERGED away, SPLIT away, and both; coded with a real code, with only a
    universal one, by the consensus layer and by a machine. P2 holds a copy, so a count
    that loses its project scope reads P1 + P2."""
    db.add_all([
        User(id=2, username="colleague"),
        User(id=3, username="Consensus", coder_type="consensus"),
        User(id=4, username="model-a", coder_type="ai"),
    ])
    for pid in (P1, P2):
        db.add(Project(id=pid, name=f"P{pid}", user_id=1))
        db.flush()
        db.add_all([
            Code(id=pid * 10 + 1, project_id=pid, numeric_id=2, name="Theme"),
            Code(id=pid * 10, project_id=pid, numeric_id=0, name="Unclear", is_universal=True),
        ])
        for k in range(2):
            db.add(Document(id=pid * 10 + k, project_id=pid, name=f"D{k}",
                            source_filename="d.txt", source_format="txt"))
            db.add(Observation(id=pid * 10 + k, project_id=pid, name=f"O{k}"))
        db.flush()
        theme, unclear = pid * 10 + 1, pid * 10
        for source in ("document", "observation"):
            for k in range(2):
                parent_id = pid * 10 + k
                base = pid * 10_000 + (0 if source == "document" else 5_000) + k * 100
                fk = "document_id" if source == "document" else "observation_id"
                timing = {} if source == "document" else {"start_time": 0.0, "end_time": 1.0}
                ids = [base + i for i in range(6)]
                for i, sid in enumerate(ids):
                    db.add(Segment(id=sid, sequence_order=i, text="x", **{fk: parent_id}, **timing))
                db.flush()
                kept = ids[0]
                db.get(Segment, ids[3]).merged_into_id = kept      # merged away
                db.get(Segment, ids[4]).split_into_id = kept       # split away
                s5 = db.get(Segment, ids[5])
                s5.merged_into_id, s5.split_into_id = kept, kept   # both
                db.flush()
                db.add_all([
                    CodeApplication(segment_id=ids[0], code_id=theme, user_id=1),
                    CodeApplication(segment_id=ids[0], code_id=theme, user_id=2),   # once
                    CodeApplication(segment_id=ids[1], code_id=unclear, user_id=1),  # universal
                    CodeApplication(segment_id=ids[2], code_id=theme, user_id=3,
                                    origin="consensus"),
                    CodeApplication(segment_id=ids[1], code_id=theme, user_id=4),   # machine
                    CodeApplication(segment_id=ids[3], code_id=theme, user_id=1),   # hidden
                    CodeApplication(segment_id=ids[4], code_id=theme, user_id=1),   # hidden
                ])
    db.flush()
    return db


class TestTheCountsAreTheOldStatementsCounts:
    def test_visible_counts(self, db_session):
        db = _sources(db_session)
        for pid in (P1, P2, 999):
            for source in PARENTS:
                assert (visible_segment_count_for_project(db, pid, source=source)
                        == _old_visible_count(db, pid, source)), (pid, source)

    def test_coded_counts_in_every_layer(self, db_session):
        db = _sources(db_session)
        for pid in (P1, P2, 999):
            for source in PARENTS:
                for layer in (None, "human", "consensus", "machine"):
                    assert (coded_segment_count_for_project(db, pid, source=source,
                                                            layer_scope=layer)
                            == _old_coded_count(db, pid, source, layer)), (pid, source, layer)

    def test_the_literal_counts(self, db_session):
        """Three visible segments per parent, two parents: 6. Coded by PEOPLE: only the
        first (the universal-only one is not coded; the consensus and machine rows are
        other layers; hidden segments never count): 1 per parent, 2."""
        db = _sources(db_session)
        for source in PARENTS:
            assert visible_segment_count_for_project(db, P1, source=source) == 6
            assert coded_segment_count_for_project(db, P1, source=source) == 2
            assert coded_segment_count_for_project(db, P1, source=source,
                                                   layer_scope="consensus") == 2
            assert coded_segment_count_for_project(db, P1, source=source,
                                                   layer_scope="machine") == 2
            assert visible_segment_count_for_project(db, 999, source=source) == 0

    def test_a_conversation_is_not_a_source_here(self, db_session):
        import pytest
        with pytest.raises(ValueError):
            visible_segment_count_for_project(db_session, P1, source="conversation")


class TestTheOneExpressionFormIsTheSameRule:
    def test_the_truth_table(self, db_session):
        db = db_session
        db.add(Project(id=P1, name="P", user_id=1))
        db.flush()
        db.add(Conversation(id=P1, project_id=P1, name="C"))
        db.flush()
        for i in range(5):
            db.add(Segment(id=1000 + i, conversation_id=P1, sequence_order=i, text="x"))
        db.flush()
        db.get(Segment, 1001).merged_into_id = 1000
        db.get(Segment, 1002).split_into_id = 1000
        s = db.get(Segment, 1003)
        s.merged_into_id, s.split_into_id = 1000, 1000
        db.flush()

        def visible(**kw):
            return sorted(i for (i,) in db.query(Segment.id).filter(
                Segment.conversation_id == P1, *visible_segment_filter(**kw)))

        assert visible() == visible(from_parent=True) == [1000, 1004]

    def test_it_is_one_clause_that_no_index_serves(self):
        """The plan property lives in the SHAPE: one expression over both columns. Two
        bare `IS NULL` terms would hand SQLite `ix_segments_split_into_id` again."""
        (clause,) = visible_segment_filter(from_parent=True)
        sql = str(clause.compile(compile_kwargs={"literal_binds": True}))
        assert sql == "coalesce(segments.merged_into_id, segments.split_into_id) IS NULL"
        assert len(visible_segment_filter()) == 2   # the default is untouched


# ── The work counts ──────────────────────────────────────────────────────────────

BIG = 900


def _install(db):
    """Another project, whose conversation is where the install grows."""
    db.add(Project(id=BIG, name="Big", user_id=1))
    db.flush()
    db.add(Conversation(id=BIG, project_id=BIG, name="Long interview"))
    db.flush()


def _turns(db, first, n):
    db.execute(insert(Segment.__table__), [
        {"id": first + i, "conversation_id": BIG, "sequence_order": first + i, "text": "t"}
        for i in range(n)
    ])
    db.flush()


def _work(db, fn):
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


def _four(db, pid):
    return tuple(f(db, pid, source=s)
                 for f in (visible_segment_count_for_project, coded_segment_count_for_project)
                 for s in PARENTS)


class TestTheCountsDoNotGrowWithTheInstall:
    """The old form's cost tracked the INSTALL's visible turns (~10x here)."""

    SMALL, LARGE = 2_000, 20_000

    def _measure(self, db, pid):
        _install(db)
        _turns(db, 1_000_000, self.SMALL)
        before = {}
        for f in (visible_segment_count_for_project, coded_segment_count_for_project):
            for s in PARENTS:
                before[(f.__name__, s)] = _work(db, lambda: f(db, pid, source=s))
        _turns(db, 1_000_000 + self.SMALL, self.LARGE - self.SMALL)
        for (name, s), (small, answer) in before.items():
            f = {"visible_segment_count_for_project": visible_segment_count_for_project,
                 "coded_segment_count_for_project": coded_segment_count_for_project}[name]
            large, again = _work(db, lambda: f(db, pid, source=s))
            assert again == answer
            assert large < 2 * max(small, 1), (name, s, small, large)

    def test_a_project_with_no_documents_or_observations(self, db_session):
        db = db_session
        db.add(Project(id=P1, name="Survey only", user_id=1))
        db.flush()
        self._measure(db, P1)
        assert _four(db, P1) == (0, 0, 0, 0)

    def test_a_project_with_documents_and_observations(self, db_session):
        db = _sources(db_session)
        self._measure(db, P1)
        assert _four(db, P1) == (6, 6, 2, 2)
