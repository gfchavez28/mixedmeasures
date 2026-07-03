"""Track J · J2 slab 3b — the LIVE text-coding analysis endpoints exclude the
consensus layer by default and count DISTINCT (de-inflate per coder).

Why this file exists: the J2-2 de-inflation + consensus-exclusion fix was applied
to `services/text_analysis.compute_comment_frequencies`, which was DEAD (no app
callers — the endpoints used a parallel inline `_build_frequency_set`). So the
shipped `/text-analysis/*` endpoints still raw-counted every CodeApplication,
inflating by coder count AND silently adding the derived consensus layer the
instant it materialized. These tests drive the endpoints themselves.

Fixture: one comment value coded by BOTH coders + a consensus row (origin=
'consensus'), and a second comment value coded by one coder only. So:
  - human layer  → code X on 2 DISTINCT comments (not 3 raw rows, not 4 with consensus)
  - consensus    → code X on 1 comment
"""
import asyncio

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.services.coding_layers import LAYER_CONSENSUS, CONSENSUS_ORIGIN
from app.schemas.text_analysis import FilteredFrequenciesRequest, CrossTabulationRequest
from app.routers.text_analysis import (
    filtered_frequencies, cross_tabulation, code_density,
    response_length_by_code, export_cross_analysis,
)

CODE_X = 9605
COMMENT_COL = 9600
CROSS_COL = 9601
V1 = 96020  # coded by both coders + consensus
V2 = 96030  # coded by one coder only


def _run(coro):
    return asyncio.run(coro)


def _setup(db, pid=960):
    db.add_all([
        Project(id=pid, name="TA", user_id=1),
        Dataset(id=pid, project_id=pid, name="Survey"),
        DatasetColumn(id=COMMENT_COL, dataset_id=pid, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetColumn(id=CROSS_COL, dataset_id=pid, column_code="G", column_name="Grp",
                      column_text="Group", column_type="nominal",
                      sequence_order=1, display_order=1),
        DatasetRow(id=9602, dataset_id=pid),
        DatasetRow(id=9603, dataset_id=pid),
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
        # The consensus layer is owned by a distinct (global) consensus user, so a
        # consensus row never collides with a human's on the (value, code, user) index.
        User(id=3, username="Consensus", password_hash=None, coder_type="consensus"),
        Code(id=CODE_X, project_id=pid, name="X", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=V1, row_id=9602, column_id=COMMENT_COL, value_text="alpha beta gamma"),
        DatasetValue(id=V2, row_id=9603, column_id=COMMENT_COL, value_text="delta"),
        DatasetValue(id=96021, row_id=9602, column_id=CROSS_COL, value_text="GroupA"),
        DatasetValue(id=96031, row_id=9603, column_id=CROSS_COL, value_text="GroupB"),
    ])
    db.flush()
    db.add_all([
        CodeApplication(dataset_value_id=V1, code_id=CODE_X, user_id=1),
        CodeApplication(dataset_value_id=V1, code_id=CODE_X, user_id=2),  # 2nd coder, SAME value
        CodeApplication(dataset_value_id=V1, code_id=CODE_X, user_id=3, origin=CONSENSUS_ORIGIN),
        CodeApplication(dataset_value_id=V2, code_id=CODE_X, user_id=1),  # solo
    ])
    db.flush()
    return pid


def _freq(res, code_id):
    return {f.code_id: f for f in res.filtered.frequencies}[code_id]


def test_filtered_frequencies_distinct_and_excludes_consensus(db_session):
    db = db_session
    pid = _setup(db)
    user = db.get(User, 1)

    default = _run(filtered_frequencies(
        project_id=pid, body=FilteredFrequenciesRequest(column_ids=[COMMENT_COL]), db=db, user=user))
    consensus = _run(filtered_frequencies(
        project_id=pid,
        body=FilteredFrequenciesRequest(column_ids=[COMMENT_COL], layer_scope=LAYER_CONSENSUS),
        db=db, user=user))

    # 2 DISTINCT coded comments, not 3 raw rows and NOT 4 with the consensus row.
    assert _freq(default, CODE_X).count == 2
    assert _freq(default, CODE_X).percentage == 100.0, "2 of 2 comments — must not exceed 100%"
    assert _freq(consensus, CODE_X).count == 1, "only V1 reached consensus"


def test_code_density_distinct_and_excludes_consensus(db_session):
    db = db_session
    pid = _setup(db)
    user = db.get(User, 1)

    default = _run(code_density(project_id=pid, column_ids=str(COMMENT_COL),
                                group_by_column_id=None, coder_ids=None, layer_scope=None,
                                db=db, user=user))
    consensus = _run(code_density(project_id=pid, column_ids=str(COMMENT_COL),
                                  group_by_column_id=None, coder_ids=None, layer_scope=LAYER_CONSENSUS,
                                  db=db, user=user))

    # 1 distinct code on each of 2 comments → 1.0 (raw-count bug gave (3+1)/2 = 2.0).
    assert default.overall.avg_codes_per_text == 1.0
    assert default.overall.text_count == 2
    # consensus: V1 has 1, V2 has 0 → 0.5.
    assert consensus.overall.avg_codes_per_text == 0.5


def test_cross_tabulation_excludes_consensus(db_session):
    db = db_session
    pid = _setup(db)
    user = db.get(User, 1)

    default = _run(cross_tabulation(
        project_id=pid,
        body=CrossTabulationRequest(text_column_ids=[COMMENT_COL], cross_column_id=CROSS_COL),
        db=db, user=user))
    consensus = _run(cross_tabulation(
        project_id=pid,
        body=CrossTabulationRequest(text_column_ids=[COMMENT_COL], cross_column_id=CROSS_COL,
                                    layer_scope=LAYER_CONSENSUS),
        db=db, user=user))

    assert default.total_coded_texts == 2, "both comments coded in the human layer"
    assert consensus.total_coded_texts == 1, "only V1 in the consensus layer"


def test_response_length_excludes_consensus(db_session):
    db = db_session
    pid = _setup(db)
    user = db.get(User, 1)

    default = _run(response_length_by_code(project_id=pid, column_ids=str(COMMENT_COL),
                                           coder_ids=None, layer_scope=None, db=db, user=user))
    consensus = _run(response_length_by_code(project_id=pid, column_ids=str(COMMENT_COL),
                                             coder_ids=None, layer_scope=LAYER_CONSENSUS, db=db, user=user))

    default_x = {c.code_id: c for c in default.codes}[CODE_X]
    consensus_x = {c.code_id: c for c in consensus.codes}[CODE_X]
    assert default_x.text_count == 2, "X on 2 distinct comments (human layer)"
    assert consensus_x.text_count == 1, "X on 1 comment (consensus layer)"


async def _csv_body(resp):
    chunks = []
    async for chunk in resp.body_iterator:
        chunks.append(chunk if isinstance(chunk, (bytes, bytearray)) else chunk.encode())
    return b"".join(chunks)


def test_export_excludes_consensus_and_reflects_layer(db_session):
    db = db_session
    pid = _setup(db)
    user = db.get(User, 1)

    human = _run(export_cross_analysis(project_id=pid, column_ids=str(COMMENT_COL),
                                       filters_json="[]", cross_column_id=None,
                                       coder_ids=None, layer_scope=None, db=db, user=user))
    consensus = _run(export_cross_analysis(project_id=pid, column_ids=str(COMMENT_COL),
                                           filters_json="[]", cross_column_id=None,
                                           coder_ids=None, layer_scope=LAYER_CONSENSUS, db=db, user=user))
    human_body = _run(_csv_body(human))
    consensus_body = _run(_csv_body(consensus))

    assert b"Code Frequencies" in human_body
    # The human export counts X on 2 comments; consensus on 1 → the CSVs differ.
    assert human_body != consensus_body, "export must reflect the selected layer"
