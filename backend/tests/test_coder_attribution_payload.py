"""Track J · J1 payload-enrichment regression tests.

The three workbench segment-code payloads must carry per-application coder
attribution so the frontend can render badges + run the per-coder visibility
filter (plan §2.4):

  - conversation `SegmentResponse.applied_code_details` (sibling to the bare
    `applied_codes: list[int]`, which stays for the optimistic-patch path)
  - document `SegmentCodeResponse.user_id` (enriched in place on the existing
    objects)
  - text `TextResponse.applied_code_details` (sibling to `applied_code_ids`)

Plus: bulk text-coding now stamps `attribution` (D-d) the way single-apply
already did, and the enrichment must keep `is_universal` correct so the same
payload can drive the coder-scoped `isSegmentCoded` predicate (invariant J-A).
"""
import asyncio

from app.models.project import Project
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.segment import Segment
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.user import User

from app.routers.segments import segment_to_response
from app.routers.documents import _segment_to_doc_response
from app.routers.text_coding import list_texts, bulk_code
from app.schemas.text_coding import BulkCodeRequest


def test_conversation_segment_carries_applied_code_details(db_session):
    db = db_session
    db.add_all([
        Project(id=700, name="Attr Conv", user_id=1),
        Conversation(id=700, project_id=700, name="C1"),
        Segment(id=7000, conversation_id=700, sequence_order=0, text="hello world"),
        Code(id=701, project_id=700, name="Theme", color="#111111", numeric_id=1, is_active=True, is_universal=False),
        Code(id=702, project_id=700, name="Unclear", color="#222222", numeric_id=2, is_active=True, is_universal=True),
        User(id=5, username="Dr. R", password_hash=None),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=7000, code_id=701, user_id=5, attribution="round 1"),
        CodeApplication(segment_id=7000, code_id=702, user_id=1),
    ])
    db.flush()
    db.refresh(db.get(Segment, 7000))

    resp = segment_to_response(db.get(Segment, 7000))

    # bare ID list preserved (optimistic-patch path is untouched)
    assert sorted(resp.applied_codes) == [701, 702]
    # enriched detail carries the coder + provenance + universal flag
    by_code = {d.code_id: d for d in resp.applied_code_details}
    assert by_code[701].user_id == 5
    assert by_code[701].attribution == "round 1"
    assert by_code[701].is_universal is False
    assert by_code[702].user_id == 1
    assert by_code[702].is_universal is True


def test_document_segment_codes_carry_user_id(db_session):
    db = db_session
    db.add_all([
        Project(id=701, name="Attr Doc", user_id=1),
        Document(id=701, project_id=701, name="D1", source_filename="d.txt", source_format="txt"),
        Segment(id=7010, document_id=701, sequence_order=0, text="a paragraph"),
        Code(id=711, project_id=701, name="Theme", color="#111111", numeric_id=1, is_active=True, is_universal=False),
        User(id=6, username="Dr. S", password_hash=None),
    ])
    db.flush()
    db.add(CodeApplication(segment_id=7010, code_id=711, user_id=6, attribution="d-note"))
    db.flush()
    db.refresh(db.get(Segment, 7010))

    resp = _segment_to_doc_response(db.get(Segment, 7010))

    assert len(resp.codes) == 1
    assert resp.codes[0].id == 711
    assert resp.codes[0].is_universal is False
    assert resp.codes[0].user_id == 6  # enriched in place (Track J · J1)


def test_text_payload_details_and_bulk_attribution(db_session):
    db = db_session
    db.add_all([
        Project(id=702, name="Attr Text", user_id=1),
        Dataset(id=702, project_id=702, name="Survey"),
        DatasetColumn(id=7020, dataset_id=702, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text", sequence_order=0, display_order=0),
        DatasetRow(id=7021, dataset_id=702),
        DatasetValue(id=70210, row_id=7021, column_id=7020, value_text="some text"),
        DatasetRow(id=7022, dataset_id=702),
        DatasetValue(id=70220, row_id=7022, column_id=7020, value_text="second text"),
        Code(id=721, project_id=702, name="Theme", color="#111111", numeric_id=1, is_active=True, is_universal=False),
        User(id=7, username="Dr. T", password_hash=None),
    ])
    db.flush()
    db.add(CodeApplication(dataset_value_id=70210, code_id=721, user_id=7, attribution="t-note"))
    db.flush()

    user1 = db.get(User, 1)
    res = asyncio.run(list_texts(
        702, column_ids="7020", dataset_ids=None, hide_empty=True, record_id=None,
        search=None, sort_by="column_asc", random_seed=None, quoted_only=False,
        user=user1, db=db,
    ))
    by_dv = {t.dataset_value_id: t for t in res.texts}
    detail = by_dv[70210].applied_code_details
    assert by_dv[70210].applied_code_ids == [721]  # bare ID list preserved
    assert len(detail) == 1
    assert detail[0].user_id == 7
    assert detail[0].attribution == "t-note"
    assert detail[0].is_universal is False

    # D-d: bulk-apply now stamps attribution (single-apply already did)
    asyncio.run(bulk_code(
        702,
        BulkCodeRequest(dataset_value_ids=[70220], code_id=721, attribution="bulk-note"),
        user=user1, db=db,
    ))
    ca = db.query(CodeApplication).filter(
        CodeApplication.dataset_value_id == 70220, CodeApplication.code_id == 721
    ).first()
    assert ca.attribution == "bulk-note"
    assert ca.user_id == 1  # server-stamped to the active coder
