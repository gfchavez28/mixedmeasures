"""Tests for code_analysis service (synthetic coded data)."""
import pytest
from datetime import datetime
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.code import Code
from app.models.code_category import CodeCategory
from app.models.code_application import CodeApplication
from app.services.code_analysis import (
    get_code_frequencies,
    build_code_cooccurrence_matrix,
    get_source_level_cooccurrence,
    get_saturation_data,
)

# Inline the synthetic coded data spec from 05_synthetic_coded_data_v4.py

SEGMENTS = [
    {"id": 1,  "conversation_id": 1, "document_id": None, "speaker_id": 1, "sequence_order": 0,
     "text": "Can you tell me about the co-presidents' vision for the organization?",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 2,  "conversation_id": 1, "document_id": None, "speaker_id": 2, "sequence_order": 1,
     "text": "They have done an exceptional job articulating a clear vision and strategy.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 3,  "conversation_id": 1, "document_id": None, "speaker_id": 2, "sequence_order": 2,
     "text": "Malia is very skilled at communicating the big picture to stakeholders.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 4,  "conversation_id": 1, "document_id": None, "speaker_id": 2, "sequence_order": 3,
     "text": "I am concerned about their personal sustainability.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 5,  "conversation_id": 1, "document_id": None, "speaker_id": 2, "sequence_order": 4,
     "text": "Their ability to build enduring relationships with partners is a real strength.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    # Segment 6: merged into 7 (soft-deleted)
    {"id": 6,  "conversation_id": 1, "document_id": None, "speaker_id": 2, "sequence_order": 5,
     "text": "The staff morale is a concern.",
     "merged_into_id": 7, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 7,  "conversation_id": 1, "document_id": None, "speaker_id": 2, "sequence_order": 6,
     "text": "The staff morale is a concern. Several people feel uncertain.",
     "merged_into_id": None, "is_merge_result": 1, "split_into_id": None, "is_split_result": 0},
    # Conversation 2
    {"id": 8,  "conversation_id": 2, "document_id": None, "speaker_id": 1, "sequence_order": 0,
     "text": "What are your thoughts on role clarity?",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 9,  "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 1,
     "text": "The division of responsibilities is intentionally obtuse.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 10, "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 2,
     "text": "Both of them are excellent communicators and have a strong vision.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 11, "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 3,
     "text": "Grogu is incredibly gifted at building relationships.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 12, "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 4,
     "text": "I worry about long-term sustainability with this pace of work.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    # Segment 13: split into 14+15 (soft-deleted)
    {"id": 13, "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 5,
     "text": "Role clarity is a problem and it affects morale.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": 14, "is_split_result": 0},
    {"id": 14, "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 6,
     "text": "Role clarity is a problem.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 1},
    {"id": 15, "conversation_id": 2, "document_id": None, "speaker_id": 3, "sequence_order": 7,
     "text": "It affects morale across the organization.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 1},
    # Conversation 3
    {"id": 16, "conversation_id": 3, "document_id": None, "speaker_id": 1, "sequence_order": 0,
     "text": "How would you describe the co-presidents' strengths?",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 17, "conversation_id": 3, "document_id": None, "speaker_id": 2, "sequence_order": 1,
     "text": "They go above and beyond to build relationships.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    # Document segments
    {"id": 18, "conversation_id": None, "document_id": 1, "speaker_id": None, "sequence_order": 0,
     "text": "The board retreat highlighted the need for clearer role definition.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
    {"id": 19, "conversation_id": None, "document_id": 1, "speaker_id": None, "sequence_order": 1,
     "text": "Multiple board members expressed strong confidence in strategic vision.",
     "merged_into_id": None, "is_merge_result": 0, "split_into_id": None, "is_split_result": 0},
]

CODE_APPLICATIONS = [
    {"segment_id": 2, "code_id": 1},
    {"segment_id": 2, "code_id": 2},
    {"segment_id": 3, "code_id": 2},
    {"segment_id": 4, "code_id": 6},
    {"segment_id": 5, "code_id": 3},
    {"segment_id": 6, "code_id": 5},   # soft-deleted seg
    {"segment_id": 7, "code_id": 5},
    {"segment_id": 9,  "code_id": 4},
    {"segment_id": 10, "code_id": 1},
    {"segment_id": 10, "code_id": 2},
    {"segment_id": 11, "code_id": 3},
    {"segment_id": 12, "code_id": 6},
    {"segment_id": 13, "code_id": 4},  # soft-deleted seg
    {"segment_id": 13, "code_id": 5},  # soft-deleted seg
    {"segment_id": 14, "code_id": 4},
    {"segment_id": 15, "code_id": 5},
    {"segment_id": 17, "code_id": 3},
    {"segment_id": 18, "code_id": 4},
    {"segment_id": 19, "code_id": 1},
]

EXPECTED_FREQUENCIES = {
    1: {"segment_count": 3, "conversation_count": 2, "document_count": 1},
    2: {"segment_count": 3, "conversation_count": 2, "document_count": 0},
    3: {"segment_count": 3, "conversation_count": 3, "document_count": 0},
    4: {"segment_count": 3, "conversation_count": 1, "document_count": 1},
    5: {"segment_count": 2, "conversation_count": 2, "document_count": 0},
    6: {"segment_count": 2, "conversation_count": 2, "document_count": 0},
}


def _setup_coded_data(db):
    """Populate the DB with synthetic coded data."""
    project = Project(id=1, name="Test 360 Assessment", user_id=1)
    db.add(project)

    speakers = [
        Speaker(id=1, name="Arwen Reed", is_facilitator=1, project_id=1),
        Speaker(id=2, name="Chakra Zealous", is_facilitator=0, project_id=1),
        Speaker(id=3, name="Merry Yarrow", is_facilitator=0, project_id=1),
    ]
    for s in speakers:
        db.add(s)

    conversations = [
        Conversation(id=1, name="Interview - Chakra Z", project_id=1,
                     created_at=datetime(2026, 1, 1, 10, 0, 0)),
        Conversation(id=2, name="Interview - Merry Y", project_id=1,
                     created_at=datetime(2026, 1, 2, 10, 0, 0)),
        Conversation(id=3, name="Interview - Gandalf X", project_id=1,
                     created_at=datetime(2026, 1, 3, 10, 0, 0)),
    ]
    for c in conversations:
        db.add(c)

    doc = Document(
        id=1, name="Board Retreat Notes", project_id=1,
        source_filename="retreat_notes.docx", source_format="docx",
        segmentation_mode="paragraph",
        created_at=datetime(2026, 1, 4, 10, 0, 0),
    )
    db.add(doc)

    categories = [
        CodeCategory(id=1, name="Leadership Qualities", project_id=1, display_order=0),
        CodeCategory(id=2, name="Organizational Concerns", project_id=1, display_order=1),
    ]
    for cat in categories:
        db.add(cat)

    codes = [
        Code(id=1, numeric_id=2, name="Vision & Strategy", project_id=1, category_id=1, category_order=0, is_universal=False, is_active=True),
        Code(id=2, numeric_id=3, name="Communication Strength", project_id=1, category_id=1, category_order=1, is_universal=False, is_active=True),
        Code(id=3, numeric_id=4, name="Relationship Building", project_id=1, category_id=1, category_order=2, is_universal=False, is_active=True),
        Code(id=4, numeric_id=5, name="Role Clarity", project_id=1, category_id=2, category_order=0, is_universal=False, is_active=True),
        Code(id=5, numeric_id=6, name="Staff Morale", project_id=1, category_id=2, category_order=1, is_universal=False, is_active=True),
        Code(id=6, numeric_id=7, name="Sustainability Concern", project_id=1, category_id=2, category_order=2, is_universal=False, is_active=True),
        Code(id=7, numeric_id=0, name="Unsubstantive/Artifact", project_id=1, category_id=None, category_order=None, is_universal=True, is_active=True),
        Code(id=8, numeric_id=1, name="Unclear", project_id=1, category_id=None, category_order=None, is_universal=True, is_active=True),
    ]
    for code in codes:
        db.add(code)

    db.flush()

    # Two-pass insert: first without self-references (merged_into_id, split_into_id),
    # then update. SQLite FK constraints require the target row to exist.
    for seg_data in SEGMENTS:
        seg = Segment(
            id=seg_data["id"],
            conversation_id=seg_data["conversation_id"],
            document_id=seg_data["document_id"],
            speaker_id=seg_data["speaker_id"],
            sequence_order=seg_data["sequence_order"],
            text=seg_data["text"],
            merged_into_id=None,
            is_merge_result=seg_data["is_merge_result"],
            split_into_id=None,
            is_split_result=seg_data["is_split_result"],
        )
        db.add(seg)

    db.flush()

    # Second pass: set self-referencing FKs
    for seg_data in SEGMENTS:
        if seg_data["merged_into_id"] or seg_data["split_into_id"]:
            seg = db.get(Segment, seg_data["id"])
            if seg_data["merged_into_id"]:
                seg.merged_into_id = seg_data["merged_into_id"]
            if seg_data["split_into_id"]:
                seg.split_into_id = seg_data["split_into_id"]

    db.flush()

    for i, app_data in enumerate(CODE_APPLICATIONS):
        ca = CodeApplication(
            id=i + 1,
            segment_id=app_data["segment_id"],
            code_id=app_data["code_id"],
        )
        db.add(ca)

    db.flush()


def test_code_frequencies(db_session):
    db = db_session
    _setup_coded_data(db)

    result = get_code_frequencies(db, project_id=1, exclude_facilitator=True)

    for code_id, expected in EXPECTED_FREQUENCIES.items():
        freq = next(f for f in result["frequencies"] if f["code_id"] == code_id)
        assert freq["segment_count"] == expected["segment_count"], \
            f"Code {code_id}: segment_count {freq['segment_count']} != {expected['segment_count']}"
        assert freq["conversation_count"] == expected["conversation_count"], \
            f"Code {code_id}: conversation_count {freq['conversation_count']} != {expected['conversation_count']}"
        assert freq["document_count"] == expected["document_count"], \
            f"Code {code_id}: document_count {freq['document_count']} != {expected['document_count']}"


def test_soft_delete_merge(db_session):
    """Staff Morale segment_count must be 2 (seg 6 merged, excluded)."""
    db = db_session
    _setup_coded_data(db)
    result = get_code_frequencies(db, project_id=1, exclude_facilitator=True)
    freq = next(f for f in result["frequencies"] if f["code_id"] == 5)
    assert freq["segment_count"] == 2


def test_soft_delete_split(db_session):
    """Role Clarity segment_count must be 3 (seg 13 split, excluded)."""
    db = db_session
    _setup_coded_data(db)
    result = get_code_frequencies(db, project_id=1, exclude_facilitator=True)
    freq = next(f for f in result["frequencies"] if f["code_id"] == 4)
    assert freq["segment_count"] == 3


def test_document_segments(db_session):
    """Vision & Strategy must include document segments: seg_count=3, conv_count=2, doc_count=1."""
    db = db_session
    _setup_coded_data(db)
    result = get_code_frequencies(db, project_id=1, exclude_facilitator=True)
    freq = next(f for f in result["frequencies"] if f["code_id"] == 1)
    assert freq["segment_count"] == 3
    assert freq["conversation_count"] == 2
    assert freq["document_count"] == 1


def test_facilitator_exclusion(db_session):
    """Default exclude_facilitator=True should not crash with facilitator segments."""
    db = db_session
    _setup_coded_data(db)
    result = get_code_frequencies(db, project_id=1, exclude_facilitator=True)
    assert len(result["frequencies"]) == 8  # 6 codes + 2 universal


def test_segment_cooccurrence(db_session):
    db = db_session
    _setup_coded_data(db)

    cooccur, total_units, conv_total, comment_total, doc_total = \
        build_code_cooccurrence_matrix(db, project_id=1, exclude_facilitator=True)

    # Only codes 1 and 2 co-occur on segments (seg 2 and seg 10)
    assert cooccur.get((1, 2), 0) == 2
    assert cooccur.get((2, 1), 0) == 2

    # Diagonal entries: count of segments with that code
    assert cooccur.get((1, 1), 0) == 3  # Vision on 3 segments
    assert cooccur.get((3, 3), 0) == 3  # Relationship on 3 segments

    # No other non-diagonal pair should be > 0 among codes 1-6
    for a in range(1, 7):
        for b in range(a + 1, 7):
            if (a, b) == (1, 2):
                continue
            assert cooccur.get((a, b), 0) == 0, f"Unexpected co-occurrence ({a},{b})"


def test_source_cooccurrence(db_session):
    db = db_session
    _setup_coded_data(db)

    cooccur, total_sources = get_source_level_cooccurrence(
        db, project_id=1, exclude_facilitator=True, source="conversations",
    )

    expected = {
        (1, 2): 2, (1, 3): 2, (1, 4): 2, (1, 5): 2, (1, 6): 2,
        (2, 3): 2, (2, 4): 1, (2, 5): 2, (2, 6): 2,
        (3, 4): 1, (3, 5): 2, (3, 6): 2,
        (4, 5): 1, (4, 6): 1,
        (5, 6): 2,
    }

    assert total_sources == 4  # 3 conversations + 1 document

    for (a, b), count in expected.items():
        assert cooccur.get((a, b), 0) == count, \
            f"Source co-occurrence ({a},{b}): {cooccur.get((a, b), 0)} != {count}"

    # Verify the key distinction: (3,5) = 2 at source level but 0 at segment level
    assert cooccur.get((3, 5), 0) == 2


def test_saturation_curve(db_session):
    db = db_session
    _setup_coded_data(db)

    result = get_saturation_data(db, project_id=1, exclude_facilitator=True)

    new_per_source = [p["new_codes_this_source"] for p in result["points"]]
    cumulative = [p["cumulative_unique_codes"] for p in result["points"]]

    assert new_per_source == [5, 1, 0, 0]
    assert cumulative == [5, 6, 6, 6]
    assert result["total_unique_codes"] == 6

    labels = [p["source_label"] for p in result["points"]]
    assert labels == [
        "Interview - Chakra Z", "Interview - Merry Y",
        "Interview - Gandalf X", "Board Retreat Notes",
    ]
