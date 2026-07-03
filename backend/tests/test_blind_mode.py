"""Track J · J2-5 blind mode — backend pieces (B1 coding-progress coder scope, B2 reveal log).

Blind mode is mostly frontend (it seeds the existing per-coder visibility lens to
all-but-self), but two server bits exist: the Text Coding gauge is server-driven
all-coder coverage, so it needs a `coder_id` scope (DEC-G self-only); and breaking
blindness is logged via the audit service (D4).
"""
import asyncio

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.audit import AuditEntry
from app.routers.text_coding import coding_progress
from app.routers.code_analysis import reveal_blind_mode
from app.schemas.code_analysis import RevealRequest


def _run(coro):
    return asyncio.run(coro)


def _seed(db):
    db.add_all([
        Project(id=960, name="P", user_id=1),
        Dataset(id=960, project_id=960, name="S"),
        DatasetColumn(id=9601, dataset_id=960, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text", sequence_order=0, display_order=0),
        DatasetRow(id=9610, dataset_id=960),
        DatasetRow(id=9611, dataset_id=960),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=96100, row_id=9610, column_id=9601, value_text="alpha"),
        DatasetValue(id=96101, row_id=9611, column_id=9601, value_text="beta"),
    ])
    db.flush()
    db.add(User(id=2, username="Reviewer B", password_hash=None, coder_type="human"))
    db.flush()
    db.add(Code(id=9690, project_id=960, name="Theme", numeric_id=2, is_active=True, is_universal=False))
    db.flush()
    db.add_all([
        CodeApplication(code_id=9690, user_id=1, dataset_value_id=96100),  # coder 1 → value A
        CodeApplication(code_id=9690, user_id=2, dataset_value_id=96101),  # coder 2 → value B
    ])
    db.flush()


def test_coding_progress_all_coders_default(db_session):
    db = db_session
    _seed(db)
    res = _run(coding_progress(project_id=960, column_ids=None, coder_id=None, user=db.get(User, 1), db=db))
    assert res.overall_texts == {"coded": 2, "total": 2}
    assert {b.user_id for b in res.by_coder} == {1, 2}


def test_coding_progress_scoped_to_coder_is_self_only(db_session):
    """DEC-G: blind mode passes coder_id=self → the gauge counts only that coder, and
    NO colleague counts reach the wire (by_coder is scoped too)."""
    db = db_session
    _seed(db)
    res = _run(coding_progress(project_id=960, column_ids=None, coder_id=1, user=db.get(User, 1), db=db))
    assert res.overall_texts == {"coded": 1, "total": 2}, "self-only coverage"
    assert {b.user_id for b in res.by_coder} == {1}, "colleague counts absent from the payload"


def test_reveal_logs_audit_entry(db_session):
    db = db_session
    _seed(db)
    res = _run(reveal_blind_mode(project_id=960, body=RevealRequest(surface="workbench"),
                                 user=db.get(User, 1), db=db))
    assert res.logged is True
    rows = db.query(AuditEntry).filter(
        AuditEntry.action == "reveal_codes", AuditEntry.project_id == 960
    ).all()
    assert len(rows) == 1
    assert rows[0].entity_type == "blind_mode" and rows[0].user_id == 1
