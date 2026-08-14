"""#749 — the Descriptives summary table answers one question, from one payload.

The table used to build its per-kind columns from ``get_code_frequencies`` while
its Count and % came from ``get_source_frequencies``. Those two read an empty id
list differently ("all of that kind" vs "none of that kind"), so a
conversations-only selection had its Conv. column scoped to the selection and
its Obs. column scoped to the whole project. #745 fixed one pair of numbers that
way; these are the rest.

Two of the four grains could always be derived from ``sources``. The other two
CANNOT — one participant speaks across conversations and one record can be coded
in several text columns — which is why they now ride the payload. The fixture
below is built so that summing per-source counts gives a DIFFERENT (wrong)
answer than the distinct count: P1 speaks in both conversations and row 1 is
coded in both text columns. A fixture without that overlap passes either way.
"""
from datetime import datetime

from app.models import (
    Project, Conversation, Observation, Segment, Speaker, Participant,
    Code, CodeCategory, CodeApplication, Dataset, DatasetColumn, DatasetRow,
    DatasetValue,
)
from app.models.dataset import ColumnType
from app.services.code_analysis import get_source_frequencies

PID = 749
CODE_A = 74901
CODE_B = 74902
CAT = 74910
CONV_1, CONV_2 = 74921, 74922
OBS = 74931
COL_1, COL_2 = 74941, 74942


def _seed(db):
    """2 conversations · 1 observation · 2 text columns.

    P1 is a speaker in BOTH conversations and row 1 is coded in BOTH text
    columns, so `distinct` and `sum-of-per-source` disagree by construction.
    Both codes sit in ONE category, so category mode also has to de-duplicate.
    """
    db.add(Project(id=PID, name="P", user_id=1))
    db.flush()
    db.add_all([
        Conversation(id=CONV_1, project_id=PID, name="C1", created_at=datetime(2026, 8, 1)),
        Conversation(id=CONV_2, project_id=PID, name="C2", created_at=datetime(2026, 8, 2)),
        Observation(id=OBS, project_id=PID, name="Obs", created_at=datetime(2026, 8, 3)),
        CodeCategory(id=CAT, project_id=PID, name="Cat", display_order=0),
    ])
    db.add_all([
        Code(id=CODE_A, project_id=PID, name="A", numeric_id=1, is_active=True,
             is_universal=False, category_id=CAT),
        Code(id=CODE_B, project_id=PID, name="B", numeric_id=2, is_active=True,
             is_universal=False, category_id=CAT),
    ])
    db.flush()

    db.add_all([
        Participant(id=74951, project_id=PID, identifier="P1", display_name="P1"),
        Participant(id=74952, project_id=PID, identifier="P2", display_name="P2"),
    ])
    db.flush()
    # Speakers are PROJECT-scoped, so one speaker row spans conversations —
    # which is what makes P1's two conversations a genuine de-duplication case.
    db.add_all([
        Speaker(id=74961, project_id=PID, name="P1", participant_id=74951, is_facilitator=0),
        Speaker(id=74963, project_id=PID, name="P2", participant_id=74952, is_facilitator=0),
    ])
    db.flush()

    db.add_all([
        Segment(id=74971, conversation_id=CONV_1, speaker_id=74961, sequence_order=0,
                text="one", word_count=1),
        Segment(id=74972, conversation_id=CONV_2, speaker_id=74961, sequence_order=0,
                text="two", word_count=1),
        Segment(id=74973, conversation_id=CONV_2, speaker_id=74963, sequence_order=1,
                text="three", word_count=1),
        Segment(id=74974, observation_id=OBS, sequence_order=0, text="clip",
                start_time=0.0, end_time=1.0, word_count=1),
    ])

    ds = Dataset(id=PID, project_id=PID, name="Survey")
    db.add(ds)
    db.flush()
    db.add_all([
        DatasetColumn(id=COL_1, dataset_id=PID, column_text="Q1", column_name="Q1",
                      column_type=ColumnType.OPEN_TEXT, sequence_order=0),
        DatasetColumn(id=COL_2, dataset_id=PID, column_text="Q2", column_name="Q2",
                      column_type=ColumnType.OPEN_TEXT, sequence_order=1),
    ])
    db.add_all([
        DatasetRow(id=74981, dataset_id=PID, row_identifier="R1"),
        DatasetRow(id=74982, dataset_id=PID, row_identifier="R2"),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=74991, row_id=74981, column_id=COL_1, value_text="a", word_count=1),
        DatasetValue(id=74992, row_id=74981, column_id=COL_2, value_text="b", word_count=1),
        DatasetValue(id=74993, row_id=74982, column_id=COL_1, value_text="c", word_count=1),
    ])
    db.flush()

    db.add_all([
        # Code A across every kind. Note P1 is reached through BOTH conversations
        # and row 1 through BOTH text columns.
        CodeApplication(code_id=CODE_A, segment_id=74971),
        CodeApplication(code_id=CODE_A, segment_id=74972),
        CodeApplication(code_id=CODE_A, segment_id=74974),
        CodeApplication(code_id=CODE_A, dataset_value_id=74991),
        CodeApplication(code_id=CODE_A, dataset_value_id=74992),
        # Code B: the second participant, and the second record.
        CodeApplication(code_id=CODE_B, segment_id=74973),
        CodeApplication(code_id=CODE_B, dataset_value_id=74993),
    ])
    db.flush()


def _codes(result):
    return {c["name"]: c for c in result["codes"]}


class TestCrossSourceGrainsRideThePayload:
    """Counts a client cannot derive, because summing per-source double-counts."""

    def test_participant_count_is_distinct_across_conversations(self, db_session):
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[CONV_1, CONV_2], document_ids=[], observation_ids=[],
            text_column_ids=[],
        )
        # P1 is coded with A in BOTH conversations. Per-source counts would say
        # 1 + 1 = 2 people; there is one person.
        assert _codes(r)["A"]["participant_count"] == 1
        assert _codes(r)["B"]["participant_count"] == 1
        assert r["totals"]["total_participants"] == 2

    def test_record_count_is_distinct_across_text_columns(self, db_session):
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[], document_ids=[], observation_ids=[],
            text_column_ids=[COL_1, COL_2],
        )
        # Row 1 carries code A in Q1 AND Q2 — two coded texts, one record.
        assert _codes(r)["A"]["record_count"] == 1
        assert _codes(r)["A"]["participant_count"] == 0
        assert r["totals"]["total_records"] == 2
        assert r["totals"]["coded_texts"] == 3

    def test_category_mode_folds_without_double_counting(self, db_session):
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[CONV_1, CONV_2], document_ids=[], observation_ids=[],
            text_column_ids=[COL_1, COL_2], aggregation="category",
        )
        # One category holding both codes. A reaches P1, B reaches P2, so the
        # category reaches 2 — and row 1 is coded by A in two columns while row
        # 2 is coded by B, so the category reaches 2 records, not 3.
        (cat,) = r["codes"]
        assert cat["id"] == CAT
        assert cat["participant_count"] == 2
        assert cat["record_count"] == 2

    def test_category_counts_are_keyed_by_category_id(self, db_session):
        """The counts must be looked up by the SAME id the rows carry.

        In category mode the response's `codes` are categories, so a consumer
        joining them against a code-keyed payload matches only where a category
        id happens to equal a code id — zero for most rows, another entity's
        numbers for the rest. That silent coincidence is what this pins.
        """
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[CONV_1, CONV_2], document_ids=[], observation_ids=[],
            text_column_ids=[], aggregation="category",
        )
        ids = {c["id"] for c in r["codes"]}
        assert ids == {CAT}
        assert CODE_A not in ids and CODE_B not in ids


class TestSelectionScoping:
    """An unselected kind contributes nothing — the #749 decision."""

    def test_unselected_kinds_are_absent_from_totals(self, db_session):
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[CONV_1], document_ids=[], observation_ids=[],
            text_column_ids=[],
        )
        t = r["totals"]
        assert t["total_conversations"] == 1
        assert t["total_observations"] == 0
        assert t["total_text_columns"] == 0
        # The grains that used to arrive project-wide from the other endpoint.
        assert t["total_records"] == 0
        assert t["coded_texts"] == 0
        assert _codes(r)["A"]["record_count"] == 0
        assert _codes(r)["A"]["participant_count"] == 1

    def test_text_column_selection_restricts_records(self, db_session):
        """The grain `get_code_frequencies` could not restrict AT ALL.

        `_get_comment_frequencies` takes no column-id argument and the
        `/frequencies` endpoint declares no `text_column_ids` query param, so
        the Texts and Records columns were whole-project no matter what the
        researcher picked. Here Q2 alone holds one coded text on row 1.
        """
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[], document_ids=[], observation_ids=[],
            text_column_ids=[COL_2],
        )
        assert r["totals"]["total_records"] == 1
        assert r["totals"]["coded_texts"] == 1
        assert _codes(r)["A"]["record_count"] == 1
        assert _codes(r)["B"]["record_count"] == 0

    def test_coded_denominators_are_split_by_kind(self, db_session):
        """A % of coded TEXTS must not be divided by a segment-inclusive total."""
        _seed(db_session)
        r = get_source_frequencies(
            db_session, PID,
            conversation_ids=[CONV_1, CONV_2], document_ids=[], observation_ids=[OBS],
            text_column_ids=[COL_1, COL_2],
        )
        t = r["totals"]
        assert t["coded_transcript_segments"] == 4   # 3 turns + 1 clip
        assert t["coded_texts"] == 3
        assert t["coded_segments"] == t["coded_transcript_segments"] + t["coded_texts"]
