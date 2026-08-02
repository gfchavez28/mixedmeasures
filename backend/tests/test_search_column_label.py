"""#575: the text/comment search subtitle must never render blank.

`routers/search.py` used to select only `DatasetColumn.column_name` for text
results and return it raw, so an open-text column with NO short name (the common
case) produced an empty subtitle in `SearchPopover`. The fix loads `column_text`
too and coalesces name→text at the backend (the frontend can't fall back — the
label isn't otherwise on the wire).
"""
import asyncio

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.user import User
from app.routers.search import search_study


def _run(coro):
    return asyncio.run(coro)


def _seed_comment(db, *, column_name):
    p = Project(id=700, name="P", user_id=1); db.add(p); db.flush()
    d = Dataset(id=700, project_id=700, name="D"); db.add(d); db.flush()
    c = DatasetColumn(
        dataset_id=700, column_code="Q1",
        column_name=column_name, column_text="What could be improved?",
        column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0,
    )
    db.add(c); db.flush()
    r = DatasetRow(dataset_id=700, row_identifier="R0001"); db.add(r); db.flush()
    db.add(DatasetValue(row_id=r.id, column_id=c.id,
                        value_text="More flexible scheduling please"))
    db.flush()
    return db.get(User, 1)


def test_text_result_falls_back_to_column_text_when_name_null(db_session):
    user = _seed_comment(db_session, column_name=None)
    resp = _run(search_study(700, q="scheduling", types="text", limit=5, full_type=None, quoted=None,
                            user=user, db=db_session))
    assert resp.text is not None and resp.text.count == 1
    # The subtitle must carry the descriptive label, not an empty string.
    assert resp.text.items[0].column_name == "What could be improved?"


def test_text_result_prefers_short_name_when_present(db_session):
    user = _seed_comment(db_session, column_name="Improvements")
    resp = _run(search_study(700, q="scheduling", types="text", limit=5, full_type=None, quoted=None,
                            user=user, db=db_session))
    assert resp.text is not None and resp.text.count == 1
    assert resp.text.items[0].column_name == "Improvements"
