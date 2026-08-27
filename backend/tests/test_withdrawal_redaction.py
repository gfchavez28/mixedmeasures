"""#702(3) — honouring a withdrawal without damaging anyone else's data.

The decision under test (developer, 2026-08-22): remove the identity, delete what
is unambiguously theirs, and BLANK their turns in shared conversations rather than
deleting them.

Most of these assertions are about what must SURVIVE. A redaction that removes too
much is not a smaller bug than one that removes too little — it destroys other
participants' records to honour one person's request, and nothing in the suite
would notice unless it is asserted.
"""
import pytest

from app.models.project import Project
from app.models.participant import Participant
from app.models.speaker import Speaker
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.services.withdrawal_redaction import (
    apply_withdrawal,
    BLANKED_SEGMENT_TEXT,
    WITHDRAWN_SPEAKER_PREFIX,
)


@pytest.fixture
def focus_group(db_session):
    """Two participants in one conversation, plus a survey for the withdrawer.

    The SECOND participant is the point of the fixture: every assertion about
    what survives needs someone whose data must not be touched.
    """
    db = db_session
    db.add(Project(id=1, name="P", user_id=1)); db.flush()
    db.add(Conversation(id=1, project_id=1, name="Focus group")); db.flush()

    withdrawer = Participant(id=1, project_id=1, identifier="P07", display_name="Maria")
    other = Participant(id=2, project_id=1, identifier="P08", display_name="Sam")
    db.add_all([withdrawer, other]); db.flush()

    sp_w = Speaker(id=1, project_id=1, name="Maria", original_label="SPEAKER_01",
                   participant_id=1)
    sp_o = Speaker(id=2, project_id=1, name="Sam", original_label="SPEAKER_02",
                   participant_id=2)
    db.add_all([sp_w, sp_o]); db.flush()

    db.add_all([
        Segment(id=1, conversation_id=1, speaker_id=1, text="I never trusted them.",
                word_count=4, sequence_order=0),
        Segment(id=2, conversation_id=1, speaker_id=2, text="Sam's own words here.",
                word_count=4, sequence_order=1),
        Segment(id=3, conversation_id=1, speaker_id=1, text="Second thing Maria said.",
                word_count=4, sequence_order=2),
    ])
    db.flush()

    db.add(Code(id=1, project_id=1, name="distrust", numeric_id=1)); db.flush()
    db.add_all([
        CodeApplication(id=1, segment_id=1, code_id=1, user_id=1),
        CodeApplication(id=2, segment_id=2, code_id=1, user_id=1),
    ])
    db.add_all([
        Excerpt(id=1, project_id=1, segment_id=1),   # a quote OF the withdrawer's words
        Excerpt(id=2, project_id=1, segment_id=2),   # someone else's — must survive
    ])
    db.flush()

    # The survey side — unambiguously the withdrawer's.
    db.add(Dataset(id=1, project_id=1, name="Survey")); db.flush()
    db.add(DatasetColumn(id=1, dataset_id=1, column_code="Q1", column_text="Q1",
                         column_type="open_text", sequence_order=0, display_order=0))
    db.flush()
    db.add_all([
        DatasetRow(id=1, dataset_id=1, participant_id=1),
        DatasetRow(id=2, dataset_id=1, participant_id=2),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=1, row_id=1, column_id=1, value_text="Maria's answer"),
        DatasetValue(id=2, row_id=2, column_id=1, value_text="Sam's answer"),
    ])
    db.flush()
    return db


class TestTheWithdrawersOwnData:
    def test_their_turns_are_blanked_not_deleted(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()

        seg = db.get(Segment, 1)
        assert seg is not None, "the turn must SURVIVE — deleting it damages the dialogue"
        assert seg.text == BLANKED_SEGMENT_TEXT
        assert "trusted" not in seg.text

    def test_the_word_count_moves_with_the_text(self, focus_group):
        """Leaving it would keep the person's words in every density and volume
        figure while the words themselves are gone."""
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Segment, 1).word_count == 0

    def test_their_survey_responses_are_deleted_outright(self, focus_group):
        """A survey response has exactly one author — no conflict, so it goes."""
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(DatasetValue, 1) is None
        assert db.get(DatasetRow, 1) is None

    def test_a_quote_of_their_words_is_deleted(self, focus_group):
        """An excerpt is a POINTER INTO the text: after blanking its offsets
        address nothing, and a quote of removed words is what a withdrawal is
        about."""
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Excerpt, 1) is None

    def test_the_participant_record_is_gone(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Participant, 1) is None


class TestTheIdentity:
    def test_the_speaker_is_renamed_not_deleted(self, focus_group):
        """Deleting the speaker row would orphan the turns and lose the
        turn-taking structure that makes a transcript readable."""
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()

        sp = db.get(Speaker, 1)
        assert sp is not None
        assert sp.name.startswith(WITHDRAWN_SPEAKER_PREFIX)
        assert sp.original_label is None, "the import label identifies too"
        assert sp.participant_id is None

    def test_two_withdrawals_stay_two_speakers(self, focus_group):
        """⚠️ Anonymity does not require pretending several people were one.
        Collapsing two withdrawn speakers to one label would corrupt the
        discourse structure of the conversation they shared.
        """
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        apply_withdrawal(db, db.get(Participant, 2))
        db.flush()

        names = {db.get(Speaker, 1).name, db.get(Speaker, 2).name}
        assert len(names) == 2, f"both withdrawn speakers got the same label: {names}"


class TestEveryoneElseIsUntouched:
    """🔴 The assertions that matter most. Removing too much is not a smaller bug
    than removing too little."""

    def test_the_other_participants_turn_is_intact(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Segment, 2).text == "Sam's own words here."
        assert db.get(Segment, 2).word_count == 4

    def test_the_other_participants_speaker_name_is_intact(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Speaker, 2).name == "Sam"
        assert db.get(Speaker, 2).participant_id == 2

    def test_the_other_participants_responses_and_quotes_survive(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(DatasetValue, 2) is not None
        assert db.get(DatasetRow, 2) is not None
        assert db.get(Excerpt, 2) is not None

    def test_the_other_participants_record_survives(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Participant, 2) is not None


class TestCodeApplicationsAreKept:
    """The researcher's analysis, not the participant's personal data — and
    deleting them would silently change every reliability figure other coders'
    work feeds. Reported instead, so a human can review."""

    def test_a_code_on_a_blanked_turn_survives(self, focus_group):
        db = focus_group
        out = apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(CodeApplication, 1) is not None
        assert out.code_applications_kept == 1

    def test_a_code_on_someone_elses_turn_survives(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(CodeApplication, 2) is not None


class TestTheOutcomeIsAnHonestRecord:
    def test_it_reports_what_it_did_and_what_needs_review(self, focus_group):
        db = focus_group
        out = apply_withdrawal(db, db.get(Participant, 1))
        assert out.segments_blanked == 2
        assert out.excerpts_deleted == 1
        assert out.responses_deleted == 1
        assert out.dataset_rows_deleted == 1
        assert out.identifier == "P07"
        # The counts a machine cannot judge are surfaced rather than guessed at.
        assert hasattr(out, "notes_for_review")
        assert hasattr(out, "memos_for_review")

    def test_a_participant_with_nothing_attached_is_handled(self, db_session):
        db = db_session
        db.add(Project(id=1, name="P", user_id=1)); db.flush()
        db.add(Participant(id=1, project_id=1, identifier="P99")); db.flush()

        out = apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert out.segments_blanked == 0
        assert out.speaker_label is None
        assert db.get(Participant, 1) is None
