"""#968 / #969 — the Content tab's coded-segments read PAGES every kind.

`get_segments_with_context` paged its conversation kind by `offset` and sliced the
document and clip kinds `[:limit]` — so every page re-sent the first `limit`
document segments and clips, nothing past them was reachable, and `has_more`
described conversations alone: a code with few conversation passages and many
document segments offered no Load more anywhere and ended those lists silently.

Fixture: three KINDS with deliberately DIFFERENT counts (conversation 3, document
5, clips 4), paged at 2, so each kind runs out on a different page and a fixture
where the kinds tie cannot hide a kind-specific bug.
"""
from datetime import datetime

from app.models import Project, Conversation, Document, Observation, Segment, Code, CodeApplication
from app.services.code_analysis import get_segments_with_context

CODE = 9701
PID = 970


def _seed(db, conv=3, doc=5, clips=4):
    db.add(Project(id=PID, name="P", user_id=1))
    db.flush()
    db.add_all([
        Conversation(id=PID, project_id=PID, name="Interview", created_at=datetime(2026, 10, 1)),
        Document(id=PID, project_id=PID, name="Notes", source_filename="n.txt",
                 source_format="txt", created_at=datetime(2026, 10, 2)),
        Observation(id=PID, project_id=PID, name="Room", created_at=datetime(2026, 10, 3)),
        Code(id=CODE, project_id=PID, name="X", numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    sid = 97000
    for i in range(conv):
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=f"turn {i}"))
        db.add(CodeApplication(code_id=CODE, user_id=1, segment_id=sid))
        sid += 1
    for i in range(doc):
        db.add(Segment(id=sid, document_id=PID, sequence_order=i, text=f"para {i}"))
        db.add(CodeApplication(code_id=CODE, user_id=1, segment_id=sid))
        sid += 1
    for i in range(clips):
        db.add(Segment(id=sid, observation_id=PID, sequence_order=i,
                       start_time=10.0 * i, end_time=10.0 * i + 5, text=f"clip {i}"))
        db.add(CodeApplication(code_id=CODE, user_id=1, segment_id=sid))
        sid += 1
    db.flush()


def _ids(result, kind):
    return [s["id"] for group in result[kind] for s in group["segments"]]


def _page(db, offset):
    return get_segments_with_context(db, PID, code_id=CODE, limit=2, offset=offset)


class TestEveryKindPages:
    def test_each_kind_returns_its_OWN_next_window(self, db_session):
        _seed(db_session)
        first, second = _page(db_session, 0), _page(db_session, 2)
        for kind in ("conversations", "documents", "observations"):
            assert not set(_ids(first, kind)) & set(_ids(second, kind)), kind
        # Documents and clips used to repeat their first two on every page.
        assert len(_ids(second, "documents")) == 2
        assert len(_ids(second, "observations")) == 2

    def test_walking_every_page_reaches_every_row_exactly_once(self, db_session):
        _seed(db_session)
        seen = {"conversations": [], "documents": [], "observations": []}
        offset = 0
        while True:
            page = _page(db_session, offset)
            for kind in seen:
                seen[kind] += _ids(page, kind)
            if not page["has_more"]:
                break
            offset += 2
        assert [len(seen[k]) for k in ("conversations", "documents", "observations")] == [3, 5, 4]
        for ids in seen.values():
            assert len(ids) == len(set(ids))


class TestTotalsAndHasMore:
    def test_each_kind_states_its_own_total_and_they_sum_to_the_clip_inclusive_total(self, db_session):
        _seed(db_session)
        r = _page(db_session, 0)
        assert (r["conversation_total"], r["document_total"], r["observation_total"]) == (3, 5, 4)
        assert r["total_segments"] == 12   # D25: the frequencies' number, unchanged

    def test_has_more_while_ANY_kind_has_more(self, db_session):
        """The conversation kind is exhausted on page 2 (3 rows), documents are not (5)."""
        _seed(db_session)
        assert _page(db_session, 2)["has_more"] is True
        assert _page(db_session, 4)["has_more"] is False

    def test_a_kind_with_more_than_a_page_and_NO_conversation_rows_still_has_more(self, db_session):
        """#969's real reach: a document-only code with more than one page."""
        _seed(db_session, conv=0, doc=3, clips=0)
        assert _page(db_session, 0)["has_more"] is True
        assert _page(db_session, 2)["has_more"] is False
