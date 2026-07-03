"""#496 / #498 regression guards — demographic ordering and Compare-By groups.

#496: demographic-comparison group columns and the filter dropdown values used
plain sorted() — lexicographic "10" before "8" (the #406 class). Both now route
through `order_value_labels`. Per the #406 rule, the fixture's labels include a
multi-digit value so a string-sort regression actually fails.

#498: `sources[].groups` was hard-coded None at every construction site while
the qual UI's Group-By control sent `group_by_subtype` — a grouping request
silently rendered ungrouped bars (and even the flat code_counts were nulled).
Now populated per (source, group) via the participant spine; documents keep
groups=None (no participant linkage); flat code_counts always populated.
"""
import pytest

from app.models.user import User
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.speaker import Speaker
from app.models.segment import Segment
from app.models.document import Document
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.participant import Participant
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services.code_analysis import (
    get_demographic_comparison,
    get_demographic_filter_options,
    get_source_frequencies,
)


@pytest.fixture
def demographic_project(db_session):
    """Two participants in Grade groups "8" and "10" (the ordering trap),
    each speaking coded conversation segments; a document segment (no
    participant spine); Grade lives on a demographic-typed dataset column."""
    db = db_session
    db.add(Project(id=750, name="Demo", user_id=1))
    db.flush()

    parts = {
        "Mara": Participant(id=7501, project_id=750, identifier="Mara"),
        "Jon": Participant(id=7502, project_id=750, identifier="Jon"),
    }
    db.add_all(parts.values())
    conv = Conversation(id=750, project_id=750, name="Conv")
    doc = Document(id=750, project_id=750, name="Doc",
                   source_filename="d.txt", source_format="txt")
    db.add_all([conv, doc])
    db.flush()
    db.add_all([
        Speaker(id=7501, project_id=750, name="Mara", is_facilitator=0,
                color_index=1, participant_id=7501),
        Speaker(id=7502, project_id=750, name="Jon", is_facilitator=0,
                color_index=2, participant_id=7502),
    ])
    db.flush()
    db.add_all([
        Segment(id=7501, conversation_id=750, sequence_order=0, text="a b c",
                word_count=3, speaker_id=7501),
        Segment(id=7502, conversation_id=750, sequence_order=1, text="d e",
                word_count=2, speaker_id=7502),
        Segment(id=7503, conversation_id=750, sequence_order=2, text="f",
                word_count=1, speaker_id=7502),
        Segment(id=7510, document_id=750, sequence_order=0, text="para"),
    ])
    code = Code(id=7500, project_id=750, numeric_id=2, name="theme A",
                is_universal=False, is_active=True)
    db.add(code)
    ds = Dataset(id=750, project_id=750, name="Survey")
    db.add(ds)
    db.flush()
    grade = DatasetColumn(id=7500, dataset_id=750, column_code="Grade",
                          column_name="Grade", column_text="Grade",
                          column_type="demographic", sequence_order=0,
                          display_order=0)
    db.add(grade)
    db.flush()
    for i, (pid, val) in enumerate([(7501, "8"), (7502, "10")], 1):
        row = DatasetRow(id=7500 + i, dataset_id=750, row_identifier=f"R{i}",
                         participant_id=pid)
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=7500, value_text=val))
    db.add_all([
        CodeApplication(segment_id=7501, code_id=7500, user_id=1),  # Mara ("8")
        CodeApplication(segment_id=7502, code_id=7500, user_id=1),  # Jon ("10")
        CodeApplication(segment_id=7510, code_id=7500, user_id=1),  # doc
    ])
    db.flush()
    return db.get(User, 1)


def test_demographic_comparison_groups_numeric_order(demographic_project, db_session):
    result = get_demographic_comparison(db_session, 750, group_by_subtype="Grade")
    assert result["groups"] == ["8", "10"], "lexicographic order regressed (#496)"


def test_demographic_filter_values_numeric_order(demographic_project, db_session):
    options = get_demographic_filter_options(db_session, 750)
    grade = next(f for f in options["filters"] if f["subtype"] == "Grade")
    assert [v["value"] for v in grade["values"]] == ["8", "10"]


def test_source_frequencies_groups_populated(demographic_project, db_session):
    result = get_source_frequencies(db_session, 750, group_by_subtype="Grade")
    by_type = {(s["source_type"], s["source_id"]): s for s in result["sources"]}

    conv = by_type[("conversation", 750)]
    assert conv["groups"] is not None, "#498: groups still unpopulated"
    assert set(conv["groups"].keys()) == {"8", "10"}
    g8, g10 = conv["groups"]["8"], conv["groups"]["10"]
    # Mara ("8"): 1 segment, 3 words, 1 coded; Jon ("10"): 2 segments, 1 coded.
    assert (g8["total_segments"], g8["total_word_count"], g8["coded_segments"]) == (1, 3, 1)
    assert (g10["total_segments"], g10["total_word_count"], g10["coded_segments"]) == (3 - 1, 3, 1)
    assert g8["code_counts"]["7500"] == {"count": 1, "word_count": 3}
    assert g10["code_counts"]["7500"] == {"count": 1, "word_count": 2}

    # Flat counts stay populated under grouping (chart fallback).
    assert conv["code_counts"] is not None
    # Documents have no participant spine → groups stays None.
    assert by_type[("document", 750)]["groups"] is None


def test_source_frequencies_groups_absent_without_request(demographic_project, db_session):
    result = get_source_frequencies(db_session, 750)
    conv = next(s for s in result["sources"] if s["source_type"] == "conversation")
    assert conv["groups"] is None
    assert conv["code_counts"] is not None
