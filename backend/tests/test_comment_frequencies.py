"""Tests for comment analysis frequency computation service."""
import pytest
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.services.text_analysis import compute_comment_frequencies


@pytest.fixture
def comment_freq_fixture(db_session):
    """8 respondents, 1 comment column, 3 codes applied."""
    db = db_session
    project = Project(id=300, name="Comment Freq Test", user_id=1)
    db.add(project)
    dataset = Dataset(id=300, project_id=300, name="Exit Survey")
    db.add(dataset)

    comment_col = DatasetColumn(
        id=3001, dataset_id=300, column_code="Q10",
        column_name="Q10", column_text="Open feedback",
        column_type="open_text", sequence_order=0, display_order=0,
    )
    db.add(comment_col)

    code_a = Code(id=501, project_id=300, name="Leadership", color="#FF0000", numeric_id=1, is_active=True)
    code_b = Code(id=502, project_id=300, name="Communication", color="#00FF00", numeric_id=2, is_active=True)
    code_c = Code(id=503, project_id=300, name="Vision", color="#0000FF", numeric_id=3, is_active=True)
    db.add_all([code_a, code_b, code_c])
    db.flush()

    COMMENTS = [
        "Great leadership",                  # → Code A
        "Communication needs work",          # → Code B
        "Strong vision and leadership",      # → Code A + Code C
        "No comment",                        # → (uncoded)
        "Team morale is low",                # → Code B
        "Clear strategic direction",         # → Code A + Code C
        "",                                  # → (blank, excluded)
        "Good communication",               # → Code B
    ]

    APPS = [
        (0, 501), (1, 502), (2, 501), (2, 503),
        (4, 502), (5, 501), (5, 503), (7, 502),
    ]

    val_id = 30000
    value_ids = []
    for i, text in enumerate(COMMENTS):
        row = DatasetRow(id=8000 + i, dataset_id=300)
        db.add(row)
        val_id += 1
        dv = DatasetValue(
            id=val_id, row_id=row.id,
            column_id=comment_col.id,
            value_text=text if text else None,
        )
        db.add(dv)
        value_ids.append(dv.id)
    db.flush()

    app_id = 40000
    for comment_idx, code_id in APPS:
        app_id += 1
        db.add(CodeApplication(
            id=app_id, dataset_value_id=value_ids[comment_idx], code_id=code_id,
        ))
    db.flush()

    return {"project_id": 300, "column_id": comment_col.id}


def test_basic_frequencies(comment_freq_fixture, db_session):
    f = comment_freq_fixture
    result = compute_comment_frequencies(db_session, f["project_id"], [f["column_id"]])

    assert result["row_count"] == 7
    assert result["text_count"] == 7

    freq_map = {fr["code_id"]: fr for fr in result["frequencies"]}
    assert freq_map[501]["count"] == 3
    assert freq_map[501]["percentage"] == pytest.approx(42.9, abs=0.1)
    assert freq_map[502]["count"] == 3
    assert freq_map[502]["percentage"] == pytest.approx(42.9, abs=0.1)
    assert freq_map[503]["count"] == 2
    assert freq_map[503]["percentage"] == pytest.approx(28.6, abs=0.1)


def test_blank_exclusion(comment_freq_fixture, db_session):
    """Blank comment (stored as None) excluded from comment_count."""
    f = comment_freq_fixture
    result = compute_comment_frequencies(db_session, f["project_id"], [f["column_id"]])
    # 8 respondents total, 1 blank → 7 non-empty
    assert result["text_count"] == 7
    assert result["row_count"] == 7


def test_uncoded_comment_included(comment_freq_fixture, db_session):
    """Uncoded comment ('No comment') is non-empty, counted in comment_count."""
    f = comment_freq_fixture
    result = compute_comment_frequencies(db_session, f["project_id"], [f["column_id"]])
    # comment_count=7 includes the uncoded "No comment"
    # No code has count > 3, confirming the uncoded comment isn't inflating any code
    assert result["text_count"] == 7
    for fr in result["frequencies"]:
        assert fr["count"] <= 3


def test_inactive_code_exclusion(comment_freq_fixture, db_session):
    """Deactivating a code excludes it from the frequency list."""
    f = comment_freq_fixture
    db = db_session

    # Deactivate code_c (Vision)
    code_c = db.query(Code).filter(Code.id == 503).first()
    code_c.is_active = False
    db.flush()

    result = compute_comment_frequencies(db, f["project_id"], [f["column_id"]])
    code_ids = [fr["code_id"] for fr in result["frequencies"]]
    assert 503 not in code_ids
    assert len(result["frequencies"]) == 2  # Only A and B
