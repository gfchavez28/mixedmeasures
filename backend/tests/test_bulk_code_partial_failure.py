"""#678 — a bulk-code partial failure must name WHICH ids it skipped.

The bulk endpoints report a partial failure as an ordinary ``200``. Before this
the response carried only counts, the client declared neither, and every call
site discarded the body — so a batch that applied nothing still rendered as
coded, with coder attribution. These pin the server half: the explicit
``failed_*_ids`` list, and the two latent input bugs found while fixing it.

⚠️ **The remove case is the load-bearing one.** ``results[].applied`` cannot be
used to derive failure, because on a REMOVE ``applied=False`` is the *success*
value ("the code is now not applied") — the same value a skipped id carries. A
reader keyed on ``applied`` would treat every successful bulk-remove as a total
failure. ``test_remove_lists_only_the_skipped_id`` is two-sided on purpose: it
asserts the skipped id IS listed *and* the successfully-removed id is NOT. A
one-sided version passes against a ``failed_segment_ids = [s.id for s in all]``
mutant.
"""
import asyncio

import pytest
from pydantic import ValidationError

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.coding import bulk_code
from app.schemas.coding import BulkCodeRequest

# An id no fixture allocates — the stand-in for a segment deleted, merged, or
# scoped away between the client's read and its bulk post.
GONE = 987654


def _fixture(db):
    db.add_all([
        Project(id=800, name="Bulk", user_id=1),
        Conversation(id=800, project_id=800, name="C"),
        Segment(id=8001, conversation_id=800, sequence_order=0, text="one"),
        Segment(id=8002, conversation_id=800, sequence_order=1, text="two"),
        Code(id=801, project_id=800, name="Theme", color="#111111",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.commit()
    return db.query(User).filter(User.id == 1).first()


def test_apply_lists_the_skipped_id(db_session):
    db = db_session
    user = _fixture(db)

    res = asyncio.run(bulk_code(
        BulkCodeRequest(segment_ids=[8001, GONE], code_id=801, action="apply"),
        user=user, db=db,
    ))

    assert res.failed_segment_ids == [GONE]
    assert res.error_count == 1
    assert res.success_count == 1
    # The real one landed — a fix that simply refused the whole batch would also
    # produce a non-empty failed list, so pin the surviving write too.
    assert db.query(CodeApplication).filter(
        CodeApplication.segment_id == 8001, CodeApplication.code_id == 801
    ).count() == 1


def test_remove_lists_only_the_skipped_id(db_session):
    """Two-sided: the skipped id listed, the successfully-removed id NOT.

    This is the guard that `applied` cannot provide — see the module docstring.
    """
    db = db_session
    user = _fixture(db)
    db.add(CodeApplication(segment_id=8001, code_id=801, user_id=1))
    db.commit()

    res = asyncio.run(bulk_code(
        BulkCodeRequest(segment_ids=[8001, GONE], code_id=801, action="remove"),
        user=user, db=db,
    ))

    assert res.failed_segment_ids == [GONE]
    assert 8001 not in res.failed_segment_ids          # the ambiguity pin
    assert db.query(CodeApplication).filter(
        CodeApplication.segment_id == 8001, CodeApplication.code_id == 801
    ).count() == 0                                      # it really was removed


def test_every_id_skipped_reports_them_all_and_writes_nothing(db_session):
    """The D23 shape: the whole batch missing the scope, inside a 200."""
    db = db_session
    user = _fixture(db)

    res = asyncio.run(bulk_code(
        BulkCodeRequest(segment_ids=[GONE, GONE + 1], code_id=801, action="apply"),
        user=user, db=db,
    ))

    assert res.failed_segment_ids == [GONE, GONE + 1]
    assert res.success_count == 0
    assert db.query(CodeApplication).count() == 0


def test_duplicate_ids_do_not_double_apply(db_session):
    """A repeated id used to be processed twice against a stale `existing_set`,
    inserting a second row for the same (segment, code, coder) — which the
    per-coder unique index turns into an IntegrityError 500 at commit."""
    db = db_session
    user = _fixture(db)

    res = asyncio.run(bulk_code(
        BulkCodeRequest(segment_ids=[8001, 8001, 8002], code_id=801, action="apply"),
        user=user, db=db,
    ))

    assert db.query(CodeApplication).filter(
        CodeApplication.segment_id == 8001, CodeApplication.code_id == 801
    ).count() == 1
    # De-duplicated before the walk, so the id is counted once, not twice.
    assert res.success_count == 2
    assert res.failed_segment_ids == []


def test_segment_ids_is_bounded_like_its_text_coding_sibling():
    with pytest.raises(ValidationError):
        BulkCodeRequest(segment_ids=list(range(5001)), code_id=1, action="apply")
    with pytest.raises(ValidationError):
        BulkCodeRequest(segment_ids=[], code_id=1, action="apply")
