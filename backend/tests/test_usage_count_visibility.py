"""#500 regression guard — `usage_count` counts VISIBLE targets only.

A merged/split-away original's code applications are unreachable anywhere in
the UI (the segment is hidden by `visible_segment_filter()` everywhere), yet
`code_usage_count_expr` counted them: the corpus probe showed "Wait times"
usage 3 (1 visible segment + 1 dataset value + 1 HIDDEN merged original) vs
the codebook tree's visible-only 2 — and the deactivate dialog warned about
an application the coder could never find. `visible_target_filter()` (paired
with an outerjoin to Segment) now scopes every "N uses" display surface;
dataset-value targets always pass. The merge-preview count in
project_portability deliberately keeps ALL rows (a merge processes hidden
originals' applications too).
"""
import asyncio

import pytest

from app.models.user import User
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def hidden_target_project(db_session):
    db = db_session
    db.add(Project(id=760, name="Usage Vis", user_id=1))
    db.flush()
    conv = Conversation(id=760, project_id=760, name="Conv")
    db.add(conv)
    db.flush()
    db.add_all([
        Segment(id=7601, conversation_id=760, sequence_order=0, text="visible"),
        # merged-away original — hidden everywhere
        Segment(id=7602, conversation_id=760, sequence_order=1, text="hidden",
                merged_into_id=7601),
    ])
    code = Code(id=7600, project_id=760, numeric_id=2, name="Wait times",
                is_universal=False, is_active=True)
    db.add(code)
    ds = Dataset(id=760, project_id=760, name="Survey")
    db.add(ds)
    db.flush()
    col = DatasetColumn(id=7600, dataset_id=760, column_code="C", column_name="Comment",
                        column_text="Comment", column_type="open_text",
                        sequence_order=0, display_order=0)
    db.add(col)
    db.flush()
    row = DatasetRow(id=7600, dataset_id=760, row_identifier="R1")
    db.add(row)
    db.flush()
    dv = DatasetValue(id=7600, row_id=7600, column_id=7600, value_text="hello")
    db.add(dv)
    db.flush()
    db.add_all([
        CodeApplication(segment_id=7601, code_id=7600, user_id=1),      # visible seg
        CodeApplication(segment_id=7602, code_id=7600, user_id=1),      # HIDDEN seg
        CodeApplication(dataset_value_id=7600, code_id=7600, user_id=1),  # dataset value
    ])
    db.flush()
    return db.get(User, 1)


def test_codes_list_usage_excludes_hidden_targets(hidden_target_project, db_session):
    from app.routers.codes import list_codes

    resp = _run(list_codes(
        project_id=760, include_inactive=False, category_id=None,
        layer_scope=None, user=hidden_target_project, db=db_session,
    ))
    wait = next(c for c in resp.codes if c.name == "Wait times")
    assert wait.usage_count == 2, (
        "hidden merged-original's application leaked into usage_count (#500)"
    )


def test_single_code_response_usage_excludes_hidden(hidden_target_project, db_session):
    from app.routers.codes import code_to_response

    code = db_session.get(Code, 7600)
    assert code_to_response(code, db_session).usage_count == 2
