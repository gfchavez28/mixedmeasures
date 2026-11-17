"""D163 — pinning a passage gets or creates its WHOLE quote (`POST …/excerpts/whole-passage`).

A pin is a quote, and a second whole quote of one passage answers 409 at the ordinary
create, so the joint display's pin goes through this door: the existing whole quote, or
a new one, logged once. A sub-passage quote of the same passage is a different quote.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.audit import AuditEntry
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.excerpts import get_or_create_whole_passage_quote
from app.schemas.excerpt import WholePassageQuoteRequest

PID = 1651


@pytest.fixture
def setup(db_session):
    db = db_session
    db.add_all([Project(id=PID, name="P", user_id=1), Project(id=PID + 1, name="Q", user_id=1)])
    db.flush()
    db.add_all([Conversation(id=PID, project_id=PID, name="C"),
                Conversation(id=PID + 1, project_id=PID + 1, name="Theirs")])
    db.flush()
    db.add_all([
        Segment(id=16510, conversation_id=PID, sequence_order=0, text="We plan on Fridays."),
        Segment(id=16511, conversation_id=PID, sequence_order=1, text="Hidden by a merge.",
                merged_into_id=16510),
        Segment(id=16512, conversation_id=PID + 1, sequence_order=0, text="Another project."),
    ])
    ds = Dataset(id=PID, project_id=PID, name="Survey")
    db.add(ds)
    db.flush()
    db.add(DatasetColumn(id=PID, dataset_id=PID, column_code="Q", column_name="Q",
                         column_text="Q", column_type=ColumnType.OPEN_TEXT,
                         sequence_order=0, display_order=0))
    db.add(DatasetRow(id=PID, dataset_id=PID, row_identifier="R1"))
    db.flush()
    db.add(DatasetValue(id=PID, row_id=PID, column_id=PID, value_text="An answer."))
    db.flush()
    return db, db.get(User, 1)


def _pin(db, user, **body):
    return get_or_create_whole_passage_quote(
        project_id=PID, data=WholePassageQuoteRequest(**body), user=user, db=db)


def _creations(db):
    return db.query(AuditEntry).filter(AuditEntry.action == "created",
                                       AuditEntry.entity_type == "excerpt").count()


class TestAPassage:
    def test_is_quoted_once_and_then_returned(self, setup):
        db, user = setup
        first = _pin(db, user, segment_id=16510)
        assert first.created is True
        assert first.excerpt_text == "We plan on Fridays."
        assert first.start_offset is None and first.conversation_id == PID
        again = _pin(db, user, segment_id=16510)
        assert again.created is False and again.id == first.id
        assert db.query(Excerpt).filter(Excerpt.segment_id == 16510).count() == 1
        assert _creations(db) == 1, "the second call made nothing, so logged nothing"

    def test_a_sub_passage_quote_is_a_different_quote(self, setup):
        db, user = setup
        part = Excerpt(project_id=PID, segment_id=16510, start_offset=0, end_offset=6)
        db.add(part)
        db.flush()
        whole = _pin(db, user, segment_id=16510)
        assert whole.created is True and whole.id != part.id and whole.start_offset is None

    def test_an_existing_whole_quote_is_the_answer(self, setup):
        db, user = setup
        made = Excerpt(project_id=PID, segment_id=16510)
        db.add(made)
        db.flush()
        out = _pin(db, user, segment_id=16510)
        assert (out.id, out.created) == (made.id, False)

    def test_a_hidden_passage_and_another_projects_are_not_found(self, setup):
        db, user = setup
        for seg in (16511, 16512, 999_999):
            with pytest.raises(HTTPException) as exc:
                _pin(db, user, segment_id=seg)
            assert exc.value.status_code == 404
        assert db.query(Excerpt).count() == 0


class TestAnAnswer:
    def test_is_quoted_once_and_then_returned(self, setup):
        db, user = setup
        first = _pin(db, user, dataset_value_id=PID)
        assert first.created is True and first.excerpt_text == "An answer."
        assert _pin(db, user, dataset_value_id=PID).id == first.id

    def test_a_value_outside_the_project_is_not_found(self, setup):
        db, user = setup
        with pytest.raises(HTTPException) as exc:
            _pin(db, user, dataset_value_id=999_999)
        assert exc.value.status_code == 404


def test_exactly_one_target():
    with pytest.raises(ValueError):
        WholePassageQuoteRequest()
    with pytest.raises(ValueError):
        WholePassageQuoteRequest(segment_id=1, dataset_value_id=2)
