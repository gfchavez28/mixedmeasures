"""#491 / #492 / #488 regression guards — distinct-unit grain and the J-A
"coded" definition on the qualitative-analysis text surfaces.

#491: the ContentByCode drill-downs counted (and for segments, RENDERED)
application rows — a unit coded by two coders appeared as two cards and header
totals exceeded the rendered lists ("6 segments" for 4 distinct; texts said
"3 comments" over a 2-item list, leaving Load-more dangling).

#492: TextColumnPicker's `coded_rows` and ContentBySource's `coded_count`
counted ANY non-consensus application — universal-only (even empty "N/A")
values inflated the displayed "N coded" vs the coding-progress gauge on the
same screen.

#488: `list_texts` header fields (`coded_texts`/`coded_rows`) carried the same
universal-inclusive tally (latent — unconsumed, but the first consumer would
inherit the drift).
"""
import asyncio

import pytest

from app.models.user import User
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.speaker import Speaker
from app.models.segment import Segment
from app.models.document import Document
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services.code_analysis import (
    get_segments_with_context,
    get_coded_comments_with_context,
    get_text_columns_with_coding,
)


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def multicoder_text_project(db_session):
    """Conversation + document + open-text column with multi-coder and
    universal-only units:

    - conv seg 7400: code A by BOTH coders  → ONE drill-down card
    - conv seg 7401: code A by Ada          → one card
    - doc seg 7410:  code A by BOTH coders  → ONE doc card
    - dv R1 "hello world": code A by BOTH   → coded, ONE text entry
    - dv R2 "N/A":  universal only          → NOT coded (empty AND universal)
    - dv R3 "some text": universal only     → NOT coded (#492)
    - dv R4 "more text": code A by Ada      → coded
    - dv R5 "":     uncoded/empty           → NOT coded
    """
    db = db_session
    db.add(User(id=2, username="Ben", coder_type="human"))
    db.add(Project(id=740, name="Grain", user_id=1))
    db.flush()

    conv = Conversation(id=740, project_id=740, name="Conv")
    doc = Document(id=740, project_id=740, name="Doc",
                   source_filename="d.txt", source_format="txt")
    db.add_all([conv, doc])
    db.flush()
    db.add(Speaker(id=7400, project_id=740, name="P", is_facilitator=0, color_index=1))
    db.flush()
    db.add_all([
        Segment(id=7400, conversation_id=740, sequence_order=0, text="one", speaker_id=7400),
        Segment(id=7401, conversation_id=740, sequence_order=1, text="two", speaker_id=7400),
        Segment(id=7410, document_id=740, sequence_order=0, text="para"),
    ])
    db.add_all([
        Code(id=7400, project_id=740, numeric_id=2, name="theme A",
             is_universal=False, is_active=True),
        Code(id=7401, project_id=740, numeric_id=1, name="Unclear",
             is_universal=True, is_active=True),
    ])
    ds = Dataset(id=740, project_id=740, name="Survey")
    db.add(ds)
    db.flush()
    col = DatasetColumn(id=7400, dataset_id=740, column_code="C", column_name="Comment",
                        column_text="Comment", column_type="open_text",
                        sequence_order=0, display_order=0)
    db.add(col)
    db.flush()
    dvs = {}
    for i, text in enumerate(["hello world", "N/A", "some text", "more text", ""], 1):
        row = DatasetRow(id=7400 + i, dataset_id=740, row_identifier=f"R{i}")
        db.add(row)
        db.flush()
        dv = DatasetValue(id=7400 + i, row_id=row.id, column_id=7400,
                          value_text=text or None)
        db.add(dv)
        dvs[f"R{i}"] = dv
    db.flush()
    db.add_all([
        CodeApplication(segment_id=7400, code_id=7400, user_id=1),
        CodeApplication(segment_id=7400, code_id=7400, user_id=2),
        CodeApplication(segment_id=7401, code_id=7400, user_id=1),
        CodeApplication(segment_id=7410, code_id=7400, user_id=1),
        CodeApplication(segment_id=7410, code_id=7400, user_id=2),
        CodeApplication(dataset_value_id=dvs["R1"].id, code_id=7400, user_id=1),
        CodeApplication(dataset_value_id=dvs["R1"].id, code_id=7400, user_id=2),
        CodeApplication(dataset_value_id=dvs["R2"].id, code_id=7401, user_id=1),
        CodeApplication(dataset_value_id=dvs["R3"].id, code_id=7401, user_id=1),
        CodeApplication(dataset_value_id=dvs["R4"].id, code_id=7400, user_id=1),
    ])
    db.flush()
    return db.get(User, 1)


def test_segments_drilldown_distinct_grain(multicoder_text_project, db_session):
    """#491: totals and rendered lists are distinct-segment grain."""
    result = get_segments_with_context(db_session, 740, code_id=7400)
    # 2 conv + 1 doc distinct segments (pre-fix: 5 application rows, with
    # seg 7400 and doc seg 7410 each RENDERED twice).
    assert result["total_segments"] == 3
    conv_ids = [s["id"] for c in result["conversations"] for s in c["segments"]]
    assert conv_ids == [7400, 7401], "duplicate cards for multi-coder segments"
    doc_ids = [s["id"] for d in result["documents"] for s in d["segments"]]
    assert doc_ids == [7410]


def test_texts_drilldown_distinct_grain(multicoder_text_project, db_session):
    """#491: total_texts matches the (already-deduped) rendered list."""
    result = get_coded_comments_with_context(db_session, 740, code_id=7400)
    assert result["total_texts"] == 2  # R1 + R4 (pre-fix: 3 — R1 counted twice)
    listed = [t["dataset_value_id"] for d in result["datasets"] for t in d["texts"]]
    assert sorted(listed) == sorted([dvs_id for dvs_id in (7401, 7404)])


def test_text_columns_coded_rows_follow_ja(multicoder_text_project, db_session):
    """#492 (picker) + #488 (list_texts header fields): universal-only and
    empty values are not "coded"; the picker count matches the badge count."""
    from app.routers.text_coding import text_columns, list_texts

    resp = _run(text_columns(project_id=740, user=multicoder_text_project, db=db_session))
    col = next(c for c in resp.columns if c.column_id == 7400)
    assert col.coded_rows == 2, "universal-only/empty values leaked into coded_rows"
    assert col.non_empty_rows == 3  # hello world / some text / more text

    badge = get_text_columns_with_coding(db_session, 740)
    badge_count = next(c for c in badge if c["column_id"] == 7400)["coded_count"]
    assert badge_count == 2, "ContentBySource badge disagrees with the picker"

    texts_resp = _run(list_texts(
        project_id=740, column_ids="7400", dataset_ids=None, hide_empty=True,
        record_id=None, search=None, sort_by="column_asc", random_seed=None,
        quoted_only=False, user=multicoder_text_project, db=db_session,
    ))
    assert texts_resp.coded_texts == 2  # #488: was universal-inclusive
    assert texts_resp.coded_rows == 2
