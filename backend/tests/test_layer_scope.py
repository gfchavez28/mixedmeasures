"""Track J · J2-3 Slab 7 — the layer-selection policy point.

`layer_scope` lets analysis surfaces show the derived consensus layer instead of
the all-human default. Only `consensus` is a genuinely new filter; per-coder /
union selection rides on the existing `coder_ids` (J1). Fixture distinguishes the
two layers: segment S1 is coded by BOTH coders (→ consensus), S2 only by one
(solo → no consensus). So human view sees code X on 2 segments, consensus on 1.
"""
import asyncio

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.coding_layers import LAYER_CONSENSUS, LAYER_HUMAN, layer_origin_filter
from app.services.consensus import consensus_exists_for_project, materialize_consensus_for_project
from app.services.coding_counts import coded_segment_count_for_project
from app.services.code_analysis import get_code_frequencies
from app.routers.codes import list_codes
from app.routers.codebook import get_codebook_tree
from app.routers.code_analysis import consensus_status, source_frequencies_csv
from app.models.consensus_stale_target import ConsensusStaleTarget


def _run(coro):
    return asyncio.run(coro)


CODE_X = 4090


def _setup(db, pid=40):
    """Project + conversation + 2 segments + 2 human coders. S1 coded by both
    (→ consensus), S2 by coder 1 only (no consensus). Returns (pid, s1, s2)."""
    db.add_all([
        Project(id=pid, name="P", user_id=1),
        Conversation(id=pid, project_id=pid, name="C"),
        Segment(id=4000, conversation_id=pid, sequence_order=0, text="one"),
        Segment(id=4001, conversation_id=pid, sequence_order=1, text="two"),
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
        Code(id=CODE_X, project_id=pid, name="X", numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=4000),  # S1: coder 1
        CodeApplication(code_id=CODE_X, user_id=2, segment_id=4000),  # S1: coder 2 → agree
        CodeApplication(code_id=CODE_X, user_id=1, segment_id=4001),  # S2: coder 1 solo
    ])
    db.flush()
    materialize_consensus_for_project(db, pid)  # → 1 consensus row on S1
    db.flush()
    return pid, 4000, 4001


def test_layer_origin_filter_selects_layer(db_session):
    db = db_session
    pid, _, _ = _setup(db)
    rows = db.query(CodeApplication).filter(CodeApplication.code_id == CODE_X)
    assert rows.filter(layer_origin_filter(LAYER_HUMAN)).count() == 3, "3 human applications"
    assert rows.filter(layer_origin_filter(LAYER_CONSENSUS)).count() == 1, "1 consensus row (S1)"
    assert rows.filter(layer_origin_filter()).count() == 3, "default (None) == human"


def test_consensus_exists_for_project(db_session):
    db = db_session
    # Fresh project with no consensus → False.
    db.add(Project(id=99, name="empty", user_id=1))
    db.flush()
    assert consensus_exists_for_project(db, 99) is False
    # After setup + materialize → True.
    pid, _, _ = _setup(db)
    assert consensus_exists_for_project(db, pid) is True


def test_coded_segment_count_for_project_honors_layer(db_session):
    db = db_session
    pid, _, _ = _setup(db)
    human = coded_segment_count_for_project(db, pid, source="conversation")
    consensus = coded_segment_count_for_project(db, pid, source="conversation", layer_scope=LAYER_CONSENSUS)
    assert human == 2, "S1 + S2 coded in the human layer"
    assert consensus == 1, "only S1 reached consensus"


def _freq_seg_count(result, code_id):
    for f in result["frequencies"]:
        if f["code_id"] == code_id:
            return f["segment_count"]
    return None


def test_get_code_frequencies_honors_layer(db_session):
    db = db_session
    pid, _, _ = _setup(db)
    human = get_code_frequencies(db, pid, source="conversations")
    consensus = get_code_frequencies(db, pid, source="conversations", layer_scope=LAYER_CONSENSUS)
    assert _freq_seg_count(human, CODE_X) == 2
    assert _freq_seg_count(consensus, CODE_X) == 1


def test_list_codes_usage_count_honors_layer(db_session):
    db = db_session
    pid, _, _ = _setup(db)
    user = db.get(User, 1)
    # Direct endpoint calls must pass every Query param explicitly (otherwise the
    # unset ones stay FastAPI Query objects rather than resolved values).
    human = _run(list_codes(project_id=pid, include_inactive=False, category_id=None,
                            layer_scope=LAYER_HUMAN, user=user, db=db))
    consensus = _run(list_codes(project_id=pid, include_inactive=False, category_id=None,
                                layer_scope=LAYER_CONSENSUS, user=user, db=db))
    human_x = next(c for c in human.codes if c.id == CODE_X)
    consensus_x = next(c for c in consensus.codes if c.id == CODE_X)
    assert human_x.usage_count == 2
    assert consensus_x.usage_count == 1


def test_codebook_tree_segment_count_honors_layer(db_session):
    db = db_session
    pid, _, _ = _setup(db)
    user = db.get(User, 1)
    kw = dict(conversation_ids=None, text_column_ids=None, exclude_facilitator=True,
              include_inactive=False, min_segments=None, max_segments=None, user=user, db=db)
    human = _run(get_codebook_tree(project_id=pid, layer_scope=LAYER_HUMAN, **kw))
    consensus = _run(get_codebook_tree(project_id=pid, layer_scope=LAYER_CONSENSUS, **kw))
    human_x = next(c for c in human.uncategorized_codes if c.id == CODE_X)
    consensus_x = next(c for c in consensus.uncategorized_codes if c.id == CODE_X)
    assert human_x.segment_count == 2
    assert consensus_x.segment_count == 1


def test_consensus_status_single_coder(db_session):
    """A solo-coder project: consensus can't form (enabled False), none exists,
    no stale markers — the layer selector must NOT offer the consensus view."""
    db = db_session
    db.add(Project(id=98, name="solo", user_id=1))
    db.flush()
    resp = _run(consensus_status(project_id=98, user=db.get(User, 1), db=db))
    assert resp.enabled is False, "only 1 roster coder"
    assert resp.exists is False
    assert resp.stale_count == 0


def test_consensus_status_after_materialize(db_session):
    """Two coders + a materialized consensus: enabled + exists True; a pending
    ConsensusStaleTarget surfaces as stale_count (drives the UX-1 recompute hint)."""
    db = db_session
    pid, _, s2 = _setup(db)
    resp = _run(consensus_status(project_id=pid, user=db.get(User, 1), db=db))
    assert resp.enabled is True, "2 roster coders"
    assert resp.exists is True, "consensus materialized on S1"
    assert resp.stale_count == 0
    db.add(ConsensusStaleTarget(project_id=pid, segment_id=s2))
    db.flush()
    resp2 = _run(consensus_status(project_id=pid, user=db.get(User, 1), db=db))
    assert resp2.stale_count == 1


# ── Step 3 (L): codebook source-counts + CSV exports honor layer_scope ──────
CODE_Y = 4190


def _setup_two_conv(db, pid=41):
    """CODE_Y in TWO conversations: conv A coded by BOTH coders (→ consensus),
    conv B coded by coder 1 only (solo → no consensus). Distinguishes source_count
    by layer — the human layer sees 2 sources, consensus only conv A. Without the
    L fix the source-count queries ignore origin and consensus would leak conv B."""
    db.add_all([
        Project(id=pid, name="P2", user_id=1),
        Conversation(id=41, project_id=pid, name="A"),
        Conversation(id=1041, project_id=pid, name="B"),
        Segment(id=4100, conversation_id=41, sequence_order=0, text="a"),
        Segment(id=4101, conversation_id=1041, sequence_order=0, text="b"),
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
        Code(id=CODE_Y, project_id=pid, name="Y", numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=CODE_Y, user_id=1, segment_id=4100),  # conv A coder 1
        CodeApplication(code_id=CODE_Y, user_id=2, segment_id=4100),  # conv A coder 2 → agree
        CodeApplication(code_id=CODE_Y, user_id=1, segment_id=4101),  # conv B solo
    ])
    db.flush()
    materialize_consensus_for_project(db, pid)  # consensus on conv A's segment only
    db.flush()
    return pid


def test_codebook_tree_source_count_honors_layer(db_session):
    db = db_session
    pid = _setup_two_conv(db)
    kw = dict(conversation_ids=None, text_column_ids=None, exclude_facilitator=True,
              include_inactive=False, min_segments=None, max_segments=None,
              user=db.get(User, 1), db=db)
    human = _run(get_codebook_tree(project_id=pid, layer_scope=LAYER_HUMAN, **kw))
    consensus = _run(get_codebook_tree(project_id=pid, layer_scope=LAYER_CONSENSUS, **kw))
    h = next(c for c in human.uncategorized_codes if c.id == CODE_Y)
    c = next(c for c in consensus.uncategorized_codes if c.id == CODE_Y)
    assert (h.segment_count, h.source_count) == (2, 2), "human: 2 segments across 2 conversations"
    # The fix: source_count must not leak conv B into the consensus layer.
    assert (c.segment_count, c.source_count) == (1, 1), "consensus only on conv A"


async def _collect_csv(resp):
    chunks = []
    async for chunk in resp.body_iterator:
        chunks.append(chunk if isinstance(chunk, (bytes, bytearray)) else chunk.encode())
    return b"".join(chunks)


def test_source_frequencies_csv_forwards_layer_scope(db_session):
    db = db_session
    pid = _setup_two_conv(db)
    kw = dict(code_ids=None, conversation_ids=None, text_column_ids=None, document_ids=None,
              exclude_facilitator=True, participant_ids=None, group_by_subtype=None,
              coder_ids=None, user=db.get(User, 1), db=db)
    human = _run(source_frequencies_csv(project_id=pid, layer_scope=LAYER_HUMAN, **kw))
    consensus = _run(source_frequencies_csv(project_id=pid, layer_scope=LAYER_CONSENSUS, **kw))
    human_body = _run(_collect_csv(human))
    consensus_body = _run(_collect_csv(consensus))
    assert b"TOTAL" in human_body and b"TOTAL" in consensus_body
    # If layer_scope weren't forwarded, the consensus export would equal the human one.
    assert human_body != consensus_body, "CSV must reflect the selected layer"
