"""#1070 — undoing a single apply or remove on a grouped conversation segment.

The single doors fan out to the whole segment GROUP; the siblings routinely hold
different codings (grouping does not unify them). The client's inverse therefore
names every sibling and goes through the BULK door, which acts on exactly the
listed segments — and it needs the server to say what the apply replaced on
EACH segment, which the merged `replaced_code_ids` could not.

These pin the server's half: the per-segment report, and that the inverse the
client issues (`lib/apply-undo.ts`, the group arm) restores each sibling exactly.
"""
import asyncio

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_set import CodeSet
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.user import User
from app.schemas.coding import BulkCodeRequest, MagnitudeValueUpdate

SCALE = dict(magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5)


def _grouped(db, pid):
    """Conversation `pid` with segments X, Y (grouped) and Z (ungrouped)."""
    db.add(Project(id=pid, name="p", user_id=1))
    db.flush()
    db.add(Conversation(id=pid, project_id=pid, name="c"))
    db.flush()
    X, Y, Z = pid * 100, pid * 100 + 1, pid * 100 + 2
    for i, sid in enumerate((X, Y, Z)):
        db.add(Segment(id=sid, conversation_id=pid, sequence_order=i, text="x"))
    db.add(SegmentGroup(id=pid, conversation_id=pid))
    db.flush()
    for sid in (X, Y):
        db.get(Segment, sid).group_id = pid
    db.flush()
    return X, Y, Z


def _held(db, seg):
    return sorted(
        (r.code_id, r.magnitude) for r in db.query(CodeApplication).filter(
            CodeApplication.segment_id == seg, CodeApplication.user_id == 1,
        )
    )


def _apply(db, seg, code_id):
    from app.routers.coding import apply_code
    return asyncio.run(apply_code(seg, code_id, None, user=db.get(User, 1), db=db))


def _bulk(db, segs, code_id, action):
    from app.routers.coding import bulk_code
    return asyncio.run(bulk_code(
        BulkCodeRequest(segment_ids=segs, code_id=code_id, action=action),
        user=db.get(User, 1), db=db,
    ))


def _rate(db, seg, code_id, value):
    from app.routers.coding import set_code_magnitude
    return set_code_magnitude(seg, code_id, MagnitudeValueUpdate(magnitude=value),
                              user=db.get(User, 1), db=db)


def _stance(db, pid):
    db.add(CodeSet(id=pid, project_id=pid, label="Stance"))
    db.flush()
    pos = Code(id=pid * 10 + 1, project_id=pid, numeric_id=10, name="Positive",
               code_set_id=pid, **SCALE)
    neg = Code(id=pid * 10 + 3, project_id=pid, numeric_id=12, name="Negative",
               code_set_id=pid, **SCALE)
    db.add_all([pos, neg])
    db.flush()
    return pos, neg


class TestTheSingleApplyReportsPerSegment:
    def test_only_the_sibling_that_held_a_rival_reports_it(self, db_session):
        db = db_session
        X, Y, _ = _grouped(db, 81)
        pos, neg = _stance(db, 81)
        db.add(CodeApplication(code_id=pos.id, user_id=1, segment_id=X, magnitude=0.5))
        db.flush()

        resp = _apply(db, Y, neg.id)

        assert resp.replaced_code_ids == [pos.id]
        assert [(t.segment_id, t.replaced_code_ids) for t in resp.replaced_by_target] == [
            (X, [pos.id]),
        ]

    def test_an_ordinary_code_reports_nothing(self, db_session):
        db = db_session
        X, Y, _ = _grouped(db, 82)
        plain = Code(id=821, project_id=82, numeric_id=1, name="Pacing")
        db.add(plain)
        db.flush()
        resp = _apply(db, Y, plain.id)
        assert resp.replaced_code_ids == [] and resp.replaced_by_target == []


class TestTheClientsInverseIsExactPerSibling:
    def test_a_siblings_earlier_coding_survives_the_undo(self, db_session):
        """#1070 (a): X coded before grouping; apply on Y fans out (a no-op on X);
        the inverse removes from Y ONLY — through the bulk door."""
        db = db_session
        X, Y, _ = _grouped(db, 83)
        pacing = Code(id=831, project_id=83, numeric_id=1, name="Pacing")
        db.add(pacing)
        db.add(CodeApplication(code_id=831, user_id=1, segment_id=X))
        db.flush()

        _apply(db, Y, pacing.id)
        assert _held(db, X) == [(831, None)] and _held(db, Y) == [(831, None)]

        _bulk(db, [Y], pacing.id, "remove")  # the plan: removeFrom = [Y]
        assert _held(db, X) == [(831, None)]
        assert _held(db, Y) == []

    def test_each_sibling_gets_back_its_own_value_and_rating(self, db_session):
        """#1070 (b): X held Positive rated 0.5, Y nothing. The inverse restores
        Positive on X with its rating and removes Negative from Y — never
        Positive on Y, which it never had."""
        db = db_session
        X, Y, _ = _grouped(db, 84)
        pos, neg = _stance(db, 84)
        db.add(CodeApplication(code_id=pos.id, user_id=1, segment_id=X, magnitude=0.5))
        db.flush()

        _apply(db, Y, neg.id)
        assert _held(db, X) == [(neg.id, None)] and _held(db, Y) == [(neg.id, None)]

        _bulk(db, [X], pos.id, "apply")   # restore: the swap removes Negative on X
        _rate(db, X, pos.id, 0.5)         # …then its rating
        _bulk(db, [Y], neg.id, "remove")  # removeFrom = [Y]
        assert _held(db, X) == [(pos.id, 0.5)]
        assert _held(db, Y) == []
