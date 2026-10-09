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
from app.models.document import Document
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

    # The document side (row 46) — a third treatment, neither blanked nor
    # deleted. The other participant's document is the control.
    db.add_all([
        Document(id=1, project_id=1, name="Maria's workplan", source_filename="m.txt",
                 source_format="txt", participant_id=1),
        Document(id=2, project_id=1, name="Sam's workplan", source_filename="s.txt",
                 source_format="txt", participant_id=2),
    ])
    db.flush()
    db.add(Segment(id=4, document_id=1, text="Maria's stated goal.", word_count=3,
                   sequence_order=0))
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


class TestLinkedDocumentsAreUnlinkedNotDeleted:
    """Row 46's treatment — the THIRD one, decided with the developer 2026-09-07.

    The dataset rule ("theirs alone, so it goes") does not transfer:
    `Document.participant_id` says the document is ABOUT this person, which is
    true both of a workplan they wrote and of a document that merely names them.
    The tool cannot tell those apart, deletion is unrecoverable, and blanking
    would leave a shell that still counts in coverage. So the LINK goes and the
    document is reported for the human decision.
    """

    def test_the_document_survives(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        doc = db.get(Document, 1)
        assert doc is not None, "the document was deleted — it must only be unlinked"
        assert doc.name == "Maria's workplan"

    def test_its_text_is_untouched(self, focus_group):
        """Deliberately NOT the conversation treatment either: a document has no
        second author sharing the structure, so there is nothing to preserve by
        blanking — and a blanked document still counts in every coverage figure
        while saying nothing."""
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Segment, 4).text == "Maria's stated goal."

    def test_the_link_is_gone(self, focus_group):
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Document, 1).participant_id is None

    def test_someone_elses_document_keeps_its_link(self, focus_group):
        """The control. An arm that dropped its `participant_id` filter would
        unlink every document in the project and still report a plausible count."""
        db = focus_group
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        assert db.get(Document, 2).participant_id == 2

    def test_the_relationship_carries_no_delete_cascade(self):
        """🔴 The catastrophic case, pinned in the channel it lives in.

        If `Participant.documents` were ever given `delete-orphan` (a plausible
        edit — "surely a person's documents go with them"), the withdrawal would
        DELETE those documents while still reporting them as merely unlinked:
        irreversible data loss described in the outcome as something else.

        ⚠️ **The behavioural tests above cannot see this — MEASURED.** Adding
        `cascade="all, delete-orphan"` leaves all four of them green, because the
        service nulls the FK column directly rather than mutating the collection,
        so SQLAlchemy's orphan detection never fires on this path. An earlier
        version of the comment in `withdrawal_redaction.py` claimed
        `test_the_document_survives` covered it; it does not. Assert the mapper
        configuration itself.
        """
        from sqlalchemy import inspect as sa_inspect

        rel = sa_inspect(Participant).relationships["documents"]
        assert not rel.cascade.delete, (
            "Participant.documents must not cascade deletes: a withdrawal "
            "UNLINKS documents and reports them for human review (row 46). A "
            "delete cascade would destroy them and the outcome would still say "
            "'unlinked'."
        )
        assert not rel.cascade.delete_orphan


class TestTheOutcomeIsAnHonestRecord:
    def test_it_reports_what_it_did_and_what_needs_review(self, focus_group):
        db = focus_group
        out = apply_withdrawal(db, db.get(Participant, 1))
        assert out.segments_blanked == 2
        assert out.excerpts_deleted == 1
        assert out.responses_deleted == 1
        assert out.dataset_rows_deleted == 1
        assert out.identifier == "P07"
        # Row 46 — the count a human has to finish, not a count of deletions.
        assert out.documents_unlinked == 1
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


class TestTheirDataLeavesTheNumbersToo:
    """🔴 #1144 (widened by the 1.5.6 pre-cut batch's review) — a withdrawal deleted
    the person's responses and rows and marked no metric out of date. A saved metric
    keeps the result it last computed, and quick compute reuses any metric that is not
    stale, so the analysis view went on showing means and frequencies that INCLUDED the
    withdrawn person — on the one feature whose purpose is that their data is gone."""

    def _metric(self, db, column_id, name):
        from app.models.metric import MetricDefinition
        from app.models.statistical_test import StatisticalTest

        m = MetricDefinition(project_id=1, name=name, metric_type="frequency_distribution",
                             input_source_type="dataset_column", input_source_id=column_id,
                             config="{}", stale=False)
        db.add(m)
        db.flush()
        db.add(StatisticalTest(project_id=1, test_type="independent_t_test", config="{}",
                               target_type="metric_definition", target_id=m.id,
                               result_data="{}", stale=False))
        db.flush()
        return m.id

    def _state(self, db, metric_id):
        from app.models.metric import MetricDefinition
        from app.models.statistical_test import StatisticalTest

        db.expire_all()
        test = db.query(StatisticalTest).filter(StatisticalTest.target_id == metric_id).one()
        return db.get(MetricDefinition, metric_id).stale, test.stale

    def test_a_metric_on_a_dataset_that_lost_their_row_is_marked(self, focus_group):
        db = focus_group
        # A second column of the same survey, with no answer from them: a row is in
        # EVERY column's population, so it is marked too.
        db.add(DatasetColumn(id=2, dataset_id=1, column_code="Q2", column_text="Q2",
                             column_type="nominal", sequence_order=1, display_order=1))
        db.flush()
        answered = self._metric(db, 1, "Q1 frequencies")
        unanswered = self._metric(db, 2, "Q2 frequencies")

        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()

        assert self._state(db, answered) == (True, True)
        assert self._state(db, unanswered) == (True, True)

    def test_a_dataset_they_were_never_in_is_left_alone(self, focus_group):
        """The control: a guard that marked every metric in the project would pass
        the test above."""
        db = focus_group
        db.add(Dataset(id=2, project_id=1, name="Staff list"))
        db.flush()
        db.add(DatasetColumn(id=3, dataset_id=2, column_code="S1", column_text="Grade",
                             column_type="nominal", sequence_order=0, display_order=0))
        db.add(DatasetRow(id=3, dataset_id=2, participant_id=2))
        db.flush()
        theirs = self._metric(db, 1, "Q1 frequencies")
        elsewhere = self._metric(db, 3, "Grade frequencies")

        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()

        assert self._state(db, theirs) == (True, True)
        assert self._state(db, elsewhere) == (False, False)
