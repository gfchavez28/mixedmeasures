"""#415: dataset import reports values recognized as missing (N/A / refusal).

The import already treats N/A and refusal labels as missing everywhere
downstream (#381/#384); these tests pin the disclosure count + distinct labels
that the import results screen surfaces, and confirm empty cells are not
counted (they are skipped, never stored).
"""

from app.models.project import Project
from app.services.dataset_import import import_dataset_csv

CONFIGS = [
    {
        "column_index": 0,
        "column_type": "ordinal",
        "column_text": "Satisfaction",
        "column_code": "sat",
        "scale_labels": ["Low", "Medium", "High"],
    },
    {
        "column_index": 1,
        "column_type": "open_text",
        "column_text": "Comment",
        "column_code": "comment",
    },
]

# Row 3 has an empty Comment; row 5 an empty Satisfaction — neither is counted.
CSV = (
    "Satisfaction,Comment\n"
    "High,good\n"
    "N/A,Don't know\n"
    "Low,\n"
    "Prefer not to say,fine\n"
    ",bad\n"
)


def _import(db_session, csv_text, configs=CONFIGS, name="NA Test"):
    project = Project(name="P", user_id=1)
    db_session.add(project)
    db_session.flush()
    return import_dataset_csv(
        db=db_session,
        project_id=project.id,
        name=name,
        column_configs=configs,
        file_contents=csv_text,
    )


def test_import_counts_recognized_missing(db_session):
    result = _import(db_session, CSV)
    # 2 in the ordinal column (N/A, Prefer not to say) + 1 open-text (Don't know)
    assert result["recognized_missing_count"] == 3
    # Empty cells are skipped, so values_created excludes the 2 blanks (10 - 2).
    assert result["values_created"] == 8
    # Distinct labels, sorted, with original casing preserved.
    assert result["recognized_missing_labels"] == [
        "Don't know",
        "N/A",
        "Prefer not to say",
    ]


def test_import_no_recognized_missing(db_session):
    result = _import(db_session, "Satisfaction,Comment\nHigh,good\nLow,fine\n")
    assert result["recognized_missing_count"] == 0
    assert result["recognized_missing_labels"] == []


def test_recognized_missing_labels_are_capped(db_session):
    # Many DISTINCT refusal labels: count is exact, label list stays bounded.
    rows = "\n".join(f"Prefer not to say {i},c{i}" for i in range(40))
    result = _import(db_session, "Satisfaction,Comment\n" + rows + "\n")
    assert result["recognized_missing_count"] == 40
    assert len(result["recognized_missing_labels"]) == 25
