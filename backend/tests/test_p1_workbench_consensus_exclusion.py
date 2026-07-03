"""Track J · J2-5 P-1 — the workbench READ surfaces exclude the derived
consensus layer (``origin='consensus'``).

J2-B says every all-coder count excludes consensus by default, but the three
workbench payload/gauge surfaces that feed the CLIENT-side coded gauge + the
per-segment code chips were iterating raw ``code_applications`` with no
``origin`` filter — only the backend ``coding_counts`` gauge service was
consensus-aware. The instant the Slab-5 sweep (or a ``.mmproject`` import)
materializes consensus on a >=2-coder project, the client gauge inflated and a
phantom consensus chip rendered (removable, with no coder badge). These lock the
exclusion across the conversation, document, and text-coding workbench surfaces.

Every assertion is an exact no-op for single-coder data (no consensus rows ever
exist there), so the single-layer suites stay green.
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
from app.auth import get_or_create_consensus_user
from app.services.consensus import materialize_consensus_for_project
from app.services.coding_layers import CONSENSUS_ORIGIN
from app.routers.segments import segment_to_response, list_segments
from app.routers.documents import _segment_to_doc_response
from app.routers.text_coding import coding_progress


def _run(coro):
    return asyncio.run(coro)


CODE_X = 7090


def _conv_setup(db, pid=70):
    """Project + conversation + 2 segments + 2 human coders. S1 coded by BOTH
    (-> unanimous consensus), S2 by coder 1 only. Real ``materialize`` writes the
    consensus row (so the consensus user id is whatever it allocates). Returns
    (pid, consensus_user_id)."""
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Conversation(id=pid, project_id=pid, name="C"),
        Segment(id=7000, conversation_id=pid, sequence_order=0, text="one"),
        Segment(id=7001, conversation_id=pid, sequence_order=1, text="two"),
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
        Code(id=CODE_X, project_id=pid, name="X", numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=7000),  # S1 coder 1
        CodeApplication(code_id=CODE_X, user_id=2, segment_id=7000),  # S1 coder 2 -> agree
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=7001),  # S2 coder 1 solo
    ])
    db.flush()
    materialize_consensus_for_project(db, pid)  # -> 1 consensus row on S1
    db.flush()
    return pid, get_or_create_consensus_user(db).id


def test_conversation_segment_payload_excludes_consensus(db_session):
    db = db_session
    _, consensus_id = _conv_setup(db)
    # S1 carries 2 human applications + 1 consensus row; the workbench payload
    # must surface only the 2 human ones (consensus is the reconciliation view's).
    s1 = segment_to_response(db.get(Segment, 7000))
    assert len(s1.applied_code_details) == 2, "consensus row excluded from per-coder detail"
    assert consensus_id not in [d.user_id for d in s1.applied_code_details]
    assert s1.applied_codes == [CODE_X, CODE_X], "bare ID list also excludes consensus"


def test_conversation_gauge_excludes_consensus_only_segment(db_session):
    db = db_session
    pid, consensus_id = _conv_setup(db)
    # A consensus-only segment (no human code) must NOT count as coded — the
    # in-memory has_code predicate would otherwise inflate the gauge during the
    # staleness window before a recompute drops a now-stale consensus row.
    db.add(Segment(id=7002, conversation_id=pid, sequence_order=2, text="three"))
    db.flush()
    db.add(CodeApplication(code_id=CODE_X, user_id=consensus_id, segment_id=7002,
                           origin=CONSENSUS_ORIGIN))
    db.flush()
    resp = _run(list_segments(conversation_id=pid, user=db.get(User, 1), db=db))
    assert resp.total == 3
    assert resp.coded_count == 2, "S1+S2 human-coded; the consensus-only segment is not coded"
    assert resp.participant_coded == 2


def test_document_segment_payload_excludes_consensus(db_session):
    db = db_session
    db.add(Project(id=71, name="P", user_id=1))
    db.flush()
    consensus = get_or_create_consensus_user(db)
    db.add_all([
        Document(id=71, project_id=71, name="Notes", source_filename="n.txt", source_format="txt"),
        Code(id=7110, project_id=71, name="D", numeric_id=2, is_active=True, is_universal=False),
        Segment(id=7100, document_id=71, conversation_id=None, sequence_order=0, text="para"),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=7110, user_id=1, segment_id=7100),
        CodeApplication(code_id=7110, user_id=consensus.id, segment_id=7100, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()
    resp = _segment_to_doc_response(db.get(Segment, 7100))
    assert len(resp.codes) == 1, "document workbench payload excludes the consensus row"
    assert consensus.id not in [c.user_id for c in resp.codes]


def test_text_coding_progress_excludes_consensus(db_session):
    db = db_session
    db.add_all([
        Project(id=72, name="P", user_id=1),
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
    ])
    db.flush()
    consensus = get_or_create_consensus_user(db)  # id allocated after users 1 & 2
    db.add_all([
        Dataset(id=72, project_id=72, name="Survey"),
        DatasetColumn(id=7201, dataset_id=72, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=7202, dataset_id=72),
        DatasetRow(id=7203, dataset_id=72),
        Code(id=7210, project_id=72, name="T", numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=72020, row_id=7202, column_id=7201, value_text="coded by humans"),
        DatasetValue(id=72030, row_id=7203, column_id=7201, value_text="consensus only"),
    ])
    db.flush()
    db.add_all([
        # V1: two humans -> a genuinely coded value.
        CodeApplication(code_id=7210, user_id=1, dataset_value_id=72020),
        CodeApplication(code_id=7210, user_id=2, dataset_value_id=72020),
        # V2: consensus only -> must NOT count as coded, and the consensus user
        # must NOT surface as a phantom coder in the per-coder breakdown.
        CodeApplication(code_id=7210, user_id=consensus.id, dataset_value_id=72030,
                        origin=CONSENSUS_ORIGIN),
    ])
    db.flush()
    resp = _run(coding_progress(project_id=72, column_ids=None, user=db.get(User, 1), db=db))
    assert resp.overall_texts == {"coded": 1, "total": 2}, "only V1 is coded; consensus-only V2 is not"
    assert consensus.id not in [c.user_id for c in resp.by_coder], "consensus is not a phantom coder"
