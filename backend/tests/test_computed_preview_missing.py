"""The formula PREVIEW judges a cell missing the way the SAVE does.

`preview_computed_column` called `evaluate` with no missing rules, so a code a
column DECLARES missing was not missing in the preview (the recognized-N/A
defaults do not know "-9"): it previewed as TEXT, so `IS_MISSING([score])`
previewed FALSE where the save stores TRUE, and `[score] + 1` previewed a
"could not be evaluated" warning for a formula that saves cleanly.
`evaluate_computed_column` passes each column's rules. Found by the #1368
review (r2).
"""
import asyncio
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.dataset import DatasetColumn, DatasetValue, ColumnType
from app.routers.dataset import preview_computed_column
from app.schemas.dataset import ComputedColumnCreate
from app.services.dataset_import import import_dataset_csv
from app.services.computed_columns import evaluate_computed_column

CONFIGS = [{"column_index": 0, "column_type": "numeric", "column_text": "Score",
            "column_code": "score", "missing_values": [{"value": "-9"}]}]
CSV = "Score\n5\n-9\n7\n"


@pytest.mark.parametrize("expr, saved_expected", [
    ("IS_MISSING([score])", ["FALSE", "TRUE", "FALSE"]),
    ("[score] + 1", ["6", None, "8"]),
])
def test_the_preview_and_the_save_agree_on_a_declared_missing_code(db_session, expr, saved_expected):
    db = db_session
    p = Project(name="P", user_id=1)
    db.add(p)
    db.flush()
    dsid = import_dataset_csv(db, p.id, "D", CONFIGS, CSV)["dataset_id"]
    user = db.get(User, 1)

    preview = asyncio.run(preview_computed_column(
        p.id, dsid, ComputedColumnCreate(column_text="X", expression=expr), user, db,
    ))
    previewed = [r["result_text"] for r in preview["preview_rows"]]

    c = DatasetColumn(dataset_id=dsid, column_code="X", column_text="X",
                      column_type=ColumnType.NUMERIC, sequence_order=9, display_order=9,
                      source="computed", expression=expr, depends_on_column_ids="[]")
    db.add(c)
    db.flush()
    evaluate_computed_column(db, c)
    saved = [v for (v,) in db.query(DatasetValue.value_text)
             .filter(DatasetValue.column_id == c.id).order_by(DatasetValue.row_id)]

    assert saved == saved_expected
    assert previewed == saved
    # and no spurious "could not be evaluated" for a formula that saves fine
    assert preview["warnings"] == []
