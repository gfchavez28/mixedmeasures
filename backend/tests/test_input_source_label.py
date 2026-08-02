"""#575: the chart/metric default label must honor a column's short name.

`resolve_input_source_labels` used to emit `f"{ds}: {column_text}"`, ignoring
`column_name` — so a user's rename never reached chart axes / metric labels. It
now prefers `column_name` (matching the sibling label builders), falling back to
`column_text`.
"""
import json

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, ColumnType
from app.models.metric import MetricDefinition
from app.services.metrics import resolve_input_source_labels


def _metric(db, *, column_name):
    p = Project(id=800, name="P", user_id=1); db.add(p); db.flush()
    d = Dataset(id=800, project_id=800, name="Survey"); db.add(d); db.flush()
    c = DatasetColumn(
        dataset_id=800, column_code="Q1",
        column_name=column_name, column_text="How anxious have you felt?",
        column_type=ColumnType.ORDINAL, sequence_order=0, display_order=0,
    )
    db.add(c); db.flush()
    m = MetricDefinition(
        project_id=800, name="m", metric_type="mean", config=json.dumps({}),
        input_source_type="dataset_column", input_source_id=c.id,
    )
    db.add(m); db.flush()
    return m


def test_label_prefers_short_name(db_session):
    m = _metric(db_session, column_name="Anxiety")
    labels = resolve_input_source_labels(db_session, [m])
    assert labels[("dataset_column", m.input_source_id)] == "Survey: Anxiety"


def test_label_falls_back_to_text_when_name_null(db_session):
    m = _metric(db_session, column_name=None)
    labels = resolve_input_source_labels(db_session, [m])
    assert labels[("dataset_column", m.input_source_id)] == "Survey: How anxious have you felt?"
