"""#702(2) — what a participant's data actually touches.

The report is an ENUMERATION, which is the shape #515/#676 names as guaranteeing
a next instance: a consumer that knows N of M reachable kinds looks complete and
under-reports. On a withdrawal report under-reporting is the direction that
matters — a researcher acts on the number and believes they are done.

So the fixture below populates **every reachable kind at once** and the headline
test asserts the WHOLE report, not a field at a time. A per-field test passes
happily on a report missing three arms.
"""

import asyncio

import pytest

from app.models.user import User
from app.models.project import Project
from app.models.participant import Participant
from app.models.speaker import Speaker
from app.models.segment import Segment
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetRow, DatasetValue, DatasetColumn, ColumnType
from app.models.code_application import CodeApplication
from app.models.code import Code
from app.models.excerpt import Excerpt
from app.models.note import Note
from app.models.memo import Memo
from app.models.row_score import RowScore
from app.models.metric import MetricDefinition
from app.services.withdrawal_report import build_withdrawal_report


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def populated(db_session):
    """One participant with EVERY reachable kind of data, plus a decoy.

    The decoy participant matters: a query missing its `participant_id` filter
    still produces plausible non-zero counts, and only a second person in the
    same sources can tell "this participant's data" from "the project's data".
    """
    db = db_session
    db.add(Project(id=1, name="P", user_id=1)); db.flush()

    subject = Participant(project_id=1, identifier="P001", display_name="Jane Doe",
                          role="staff", demographics='{"age": 40}')
    decoy = Participant(project_id=1, identifier="P002", display_name="Other")
    db.add_all([subject, decoy]); db.flush()

    conv = Conversation(project_id=1, name="Interview A"); db.add(conv); db.flush()
    # ⚠️ Speaker is PROJECT-scoped, not conversation-scoped.
    sp = Speaker(project_id=1, name="Jane", participant_id=subject.id)
    sp_decoy = Speaker(project_id=1, name="Sam", participant_id=decoy.id)
    db.add_all([sp, sp_decoy]); db.flush()

    code = Code(project_id=1, numeric_id=1, name="Theme"); db.add(code); db.flush()

    # Two turns for the subject, one for the decoy.
    segs = []
    for i in range(2):
        s = Segment(conversation_id=conv.id, speaker_id=sp.id, sequence_order=i,
                    text=f"subject turn {i}")
        db.add(s); segs.append(s)
    d_seg = Segment(conversation_id=conv.id, speaker_id=sp_decoy.id, sequence_order=9,
                    text="decoy turn")
    db.add(d_seg); db.flush()

    db.add(CodeApplication(segment_id=segs[0].id, code_id=code.id))
    db.add(CodeApplication(segment_id=d_seg.id, code_id=code.id))          # decoy
    db.add(Excerpt(project_id=1, segment_id=segs[0].id))
    db.add(Note(conversation_id=conv.id, segment_id=segs[1].id, content="n", sequence_number=1))
    db.flush()

    ds = Dataset(project_id=1, name="Survey"); db.add(ds); db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_text="Q1",
                        column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0)
    db.add(col); db.flush()

    row = DatasetRow(dataset_id=ds.id, participant_id=subject.id, row_identifier="r1")
    d_row = DatasetRow(dataset_id=ds.id, participant_id=decoy.id, row_identifier="r2")
    db.add_all([row, d_row]); db.flush()

    val = DatasetValue(row_id=row.id, column_id=col.id, value_text="an answer")
    d_val = DatasetValue(row_id=d_row.id, column_id=col.id, value_text="decoy answer")
    db.add_all([val, d_val]); db.flush()

    db.add(CodeApplication(dataset_value_id=val.id, code_id=code.id))
    db.add(Excerpt(project_id=1, dataset_value_id=val.id))
    db.add(Note(dataset_value_id=val.id, content="n2", sequence_number=1))
    db.add(Memo(project_id=1, numeric_id=1, entity_type="dataset_row",
                entity_id=row.id, title="m", content="c"))
    db.add(Memo(project_id=1, numeric_id=2, entity_type="dataset_row",
                entity_id=d_row.id, title="m2", content="c2"))       # decoy
    md = MetricDefinition(project_id=1, name="score", metric_type="mean", config="{}",
                          input_source_type="dataset_column", input_source_id=col.id)
    db.add(md); db.flush()
    db.add(RowScore(metric_definition_id=md.id, dataset_row_id=row.id, score=1.0))
    db.flush()
    return db, subject, decoy


class TestReachability:
    def test_the_WHOLE_report_at_once(self, populated):
        """🔴 The population assertion. Every reachable kind is non-zero here, so
        an arm dropped from the walk changes this dict — where a per-field test
        would keep passing on a report that had gone silent about three of them.
        """
        db, subject, _ = populated
        got = build_withdrawal_report(db, subject).to_dict()

        assert got == {
            "participant_id": subject.id,
            "identifier": "P001",
            "display_name": "Jane Doe",
            "role": "staff",
            "has_demographics": True,
            "speaker_names": ["Jane"],
            "conversations": [{
                "conversation_id": 1, "name": "Interview A",
                "segments": 2, "code_applications": 1, "excerpts": 1, "notes": 1,
            }],
            "datasets": [{
                "dataset_id": 1, "name": "Survey",
                "rows": 1, "responses": 1, "code_applications": 1, "excerpts": 1,
                "notes": 1, "memos": 1, "row_scores": 1,
            }],
            # 1 participant + (2+1+1+1) + (1+1+1+1+1+1+1)
            "total_items": 13,
        }

    def test_another_participant_in_the_SAME_sources_is_excluded(self, populated):
        """A missing `participant_id` filter still yields plausible counts."""
        db, _, decoy = populated
        got = build_withdrawal_report(db, decoy)
        assert got.conversations[0].segments == 1          # not 3
        assert got.datasets[0].memos == 1                  # not 2
        assert got.datasets[0].row_scores == 0             # the decoy has none
        assert got.speaker_names == ["Sam"]

    def test_a_participant_with_no_data_reports_only_itself(self, db_session):
        db_session.add(Project(id=1, name="P", user_id=1)); db_session.flush()
        p = Participant(project_id=1, identifier="EMPTY")
        db_session.add(p); db_session.flush()
        got = build_withdrawal_report(db_session, p)
        assert got.conversations == [] and got.datasets == [] and got.speaker_names == []
        # Still 1: the participant record is itself an item to remove, and a
        # headline of 0 would misstate the action the reader is about to take.
        assert got.total_items == 1


class TestWhatItDeliberatelyOmits:
    def test_it_reports_no_text(self, populated):
        """A report reproducing the content is one more copy of the data."""
        db, subject, _ = populated
        blob = repr(build_withdrawal_report(db, subject).to_dict())
        for secret in ("subject turn", "an answer", '{"age": 40}'):
            assert secret not in blob, f"the report leaked content: {secret!r}"
        # The identifying speaker NAME is deliberately present — it survives the
        # delete and is what a reader would recognise in the transcript.
        assert "Jane" in blob

    def test_a_merged_segment_still_counts(self, populated):
        """Segments are NOT filtered by visibility: a merged turn still holds
        the participant's words, and under-reporting is the direction that
        matters on a withdrawal report."""
        db, subject, _ = populated
        segs = db.query(Segment).filter(Segment.speaker_id.isnot(None)).all()
        target = [s for s in segs if s.text.startswith("subject")][0]
        target.merged_into_id = [s for s in segs if s.id != target.id][0].id
        db.flush()
        assert build_withdrawal_report(db, subject).conversations[0].segments == 2


class TestEndpoint:
    def test_returns_the_report(self, populated):
        from app.routers.participants import get_withdrawal_report
        db, subject, _ = populated
        user = db.query(User).filter_by(id=1).first()
        out = _run(get_withdrawal_report(
            project_id=1, participant_id=subject.id, user=user, db=db))
        assert out["identifier"] == "P001"
        assert out["total_items"] == 13

    def test_404s_for_a_participant_in_another_project(self, populated):
        from fastapi import HTTPException
        from app.routers.participants import get_withdrawal_report
        db, subject, _ = populated
        db.add(Project(id=2, name="Other", user_id=1)); db.flush()
        user = db.query(User).filter_by(id=1).first()
        with pytest.raises(HTTPException) as exc:
            _run(get_withdrawal_report(
                project_id=2, participant_id=subject.id, user=user, db=db))
        assert exc.value.status_code == 404

    def test_changes_nothing(self, populated):
        """⛔ Read-only. The whole argument for building this before a cascade
        delete is that it cannot destroy anything."""
        from app.routers.participants import get_withdrawal_report
        db, subject, _ = populated
        counts = {
            m.__name__: db.query(m).count()
            for m in (Participant, Speaker, Segment, DatasetRow, DatasetValue,
                      CodeApplication, Excerpt, Note, Memo, RowScore)
        }
        user = db.query(User).filter_by(id=1).first()
        _run(get_withdrawal_report(
            project_id=1, participant_id=subject.id, user=user, db=db))
        after = {
            m.__name__: db.query(m).count()
            for m in (Participant, Speaker, Segment, DatasetRow, DatasetValue,
                      CodeApplication, Excerpt, Note, Memo, RowScore)
        }
        assert after == counts
