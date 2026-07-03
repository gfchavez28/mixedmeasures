"""#519 — text-analysis denominators must match the coding-progress gauge.

The workbench gauge drops blank AND recognized non-substantive strings
(`treat_as_empty`, default incl. "N/A") from its totals, but the text-analysis
denominators (`code-density` text_count, frequency percentages, response length,
CSV export) used a NULL/''-only filter — so a column with 4 literal "N/A" values
showed "0/36" in the gauge and "40 comments" in Code Density (the live repro).

Fix: `services/text_analysis.get_non_empty_comment_values` requires a
`treat_as_empty` list (read via `treat_as_empty_for_project`, read-only — no
config row is created on GET) and is the single place the "which texts count"
decision lives; `routers/text_coding._is_empty` delegates to the same
`models.text_coding_config.is_empty_text`.
"""
import asyncio
import json

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.text_coding_config import TextCodingConfig
from app.routers.text_analysis import code_density
from app.routers.text_coding import coding_progress
from app.services.text_analysis import compute_comment_frequencies

PID = 970
TEXT_COL = 9700
CODE_Y = 9705
V_CODED = 97010    # substantive, coded
V_PLAIN = 97020    # substantive, uncoded
V_NA = 97030       # literal "N/A" — the #519 trap
V_BLANK = 97040    # whitespace-only


def _run(coro):
    return asyncio.run(coro)


def _setup(db):
    db.add_all([
        Project(id=PID, name="Denominators", user_id=1),
        Dataset(id=PID, project_id=PID, name="Survey"),
        DatasetColumn(id=TEXT_COL, dataset_id=PID, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9701, dataset_id=PID),
        DatasetRow(id=9702, dataset_id=PID),
        DatasetRow(id=9703, dataset_id=PID),
        DatasetRow(id=9704, dataset_id=PID),
        Code(id=CODE_Y, project_id=PID, name="Y", color="#222222",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=V_CODED, row_id=9701, column_id=TEXT_COL, value_text="strong pacing overall"),
        DatasetValue(id=V_PLAIN, row_id=9702, column_id=TEXT_COL, value_text="uneven start"),
        DatasetValue(id=V_NA, row_id=9703, column_id=TEXT_COL, value_text="N/A"),
        DatasetValue(id=V_BLANK, row_id=9704, column_id=TEXT_COL, value_text="   "),
    ])
    db.flush()
    db.add(CodeApplication(dataset_value_id=V_CODED, code_id=CODE_Y, user_id=1))
    db.flush()


def test_code_density_denominator_matches_gauge(db_session):
    db = db_session
    _setup(db)
    user = db.get(User, 1)

    gauge = _run(coding_progress(project_id=PID, column_ids=str(TEXT_COL), user=user, db=db))
    density = _run(code_density(project_id=PID, column_ids=str(TEXT_COL),
                                group_by_column_id=None, coder_ids=None, layer_scope=None,
                                db=db, user=user))

    # 2 substantive texts — "N/A" and the blank are out of BOTH denominators.
    assert gauge.overall_texts["total"] == 2
    assert density.overall.text_count == 2, "density counted N/A/blank texts the gauge drops"
    assert density.overall.text_count == gauge.overall_texts["total"]
    # 1 code on 2 substantive texts → 0.5 (the pre-fix 4-text denominator gave 0.25).
    assert density.overall.avg_codes_per_text == 0.5


def test_frequency_percentage_uses_substantive_denominator(db_session):
    db = db_session
    _setup(db)

    result = compute_comment_frequencies(db, PID, [TEXT_COL])

    assert result["text_count"] == 2
    freq = {f["code_id"]: f for f in result["frequencies"]}[CODE_Y]
    assert freq.get("count") == 1
    assert freq.get("percentage") == 50.0, "1 of 2 substantive texts, not 1 of 4"


def test_custom_treat_as_empty_config_is_honored_read_only(db_session):
    db = db_session
    _setup(db)
    user = db.get(User, 1)

    # Custom config: only "skip me" is non-substantive — "N/A" becomes a real text.
    db.add(TextCodingConfig(project_id=PID, treat_as_empty=json.dumps(["skip me"])))
    db.flush()

    density = _run(code_density(project_id=PID, column_ids=str(TEXT_COL),
                                group_by_column_id=None, coder_ids=None, layer_scope=None,
                                db=db, user=user))

    # "N/A" now counts (blank never does): coded + plain + "N/A" = 3.
    assert density.overall.text_count == 3

    # Read path must not have spawned a second config row (read-only lookup).
    assert db.query(TextCodingConfig).filter(TextCodingConfig.project_id == PID).count() == 1
