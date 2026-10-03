"""#1047 — the participant list is built set-based, off the event loop, and says the
same thing about each person as the single-participant builder.

The list used to call `participant_to_response` once per participant over an ORM
load with three joined collections; on BES's 122,382 participants that was 15.1 s
with `/health` held for 14.9 s, because the endpoint was `async def`. It now has
its own builder, `participant_list_payload`, and two builders of one shape is
#542b's risk — so the first test here pins them to each other on a fixture that
reaches every field, and the second pins what made the old one slow.

⚠️ Nothing in the suite called this endpoint before #1047.
"""
import json
from datetime import datetime

import pytest
from sqlalchemy import event

from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetRow
from app.models.document import Document
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.routers.participants import list_participants, participant_to_response


def _listed(db, project_id=1) -> list[dict]:
    response = list_participants(project_id, user=db.get(User, 1), db=db)
    body = json.loads(response.body)
    assert body["total"] == len(body["participants"])
    return body["participants"]


def _by_id(person: dict) -> dict:
    """Order within a participant is by id in the list and unspecified (primary
    key in practice) through the ORM relationships, so both sides are sorted."""
    return {
        **person,
        "linked_speakers": sorted(person["linked_speakers"], key=lambda s: s["speaker_id"]),
        "dataset_rows": sorted(person["dataset_rows"], key=lambda r: r["id"]),
        "linked_documents": sorted(person["linked_documents"], key=lambda d: d["id"]),
    }


@pytest.fixture
def world(db_session):
    db = db_session
    db.add_all([Project(id=1, name="Linked", user_id=1), Project(id=2, name="Other", user_id=1)])
    db.flush()

    # Created out of identifier order, so the list's ORDER is tested too.
    rich = Participant(project_id=1, identifier="P-02", display_name="Ana",
                       role="Nurse", demographics='{"age": 41}')
    bare = Participant(project_id=1, identifier="P-01")
    stranger = Participant(project_id=2, identifier="X-01")
    db.add_all([rich, bare, stranger])
    db.flush()

    interviews = [Conversation(project_id=1, name=f"Interview {i}") for i in (1, 2, 3)]
    db.add_all(interviews)
    db.flush()
    speaker = Speaker(project_id=1, name="Ana", participant_id=rich.id, color_index=3)
    facilitator = Speaker(project_id=1, name="Mod", participant_id=rich.id,
                          is_facilitator=1, color="#3b82f6")
    db.add_all([speaker, facilitator])
    db.flush()
    seq = 0
    for conv in interviews[:2]:
        for _ in range(2):  # two turns in one conversation → listed ONCE
            seq += 1
            db.add(Segment(conversation_id=conv.id, speaker_id=speaker.id,
                           sequence_order=seq, text=f"turn {seq}"))
    db.flush()
    # A merged-away turn is the only one in the third conversation, so that
    # conversation must NOT be listed.
    survivor = db.query(Segment).first()
    db.add(Segment(conversation_id=interviews[2].id, speaker_id=speaker.id,
                   sequence_order=99, text="merged away", merged_into_id=survivor.id))
    db.add(Segment(conversation_id=interviews[0].id, speaker_id=facilitator.id,
                   sequence_order=100, text="a question"))

    survey = Dataset(project_id=1, name="Survey")
    db.add(survey)
    db.flush()
    db.add(DatasetRow(dataset_id=survey.id, participant_id=rich.id, row_identifier="R0007",
                      submitted_at=datetime(2026, 3, 4, 5, 6, 7)))
    db.add(Document(project_id=1, name="Workplan", source_filename="w.docx",
                    source_format="docx", participant_id=rich.id))
    db.flush()
    return {"db": db, "rich": rich, "bare": bare}


class TestTheListSaysWhatTheSingleBuilderSays:
    def test_every_field_of_every_participant_agrees(self, world):
        db = world["db"]
        listed = _listed(db)
        expected = [
            participant_to_response(p, db).model_dump(mode="json")
            for p in (world["bare"], world["rich"])
        ]
        assert [_by_id(p) for p in listed] == [_by_id(p) for p in expected]

    def test_the_fixture_reaches_every_field(self, world):
        """The differential is only as good as what the fixture puts in each
        field — an empty speaker list agrees with any builder."""
        rich = next(p for p in _listed(world["db"]) if p["identifier"] == "P-02")
        assert [s["is_facilitator"] for s in rich["linked_speakers"]] == [False, True]
        assert [len(s["conversations"]) for s in rich["linked_speakers"]] == [2, 1]
        assert rich["linked_speakers"][1]["color"] == "#3b82f6"
        assert rich["dataset_rows"][0]["submitted_at"].endswith("+00:00")
        assert rich["linked_documents"][0]["source_format"] == "docx"
        assert rich["demographics"] == '{"age": 41}'

    def test_ordered_by_identifier_and_scoped_to_the_project(self, world):
        assert [p["identifier"] for p in _listed(world["db"])] == ["P-01", "P-02"]


class TestItCostsTheSameQueriesAtAnySize:
    """What made the old list slow was per-participant work: the single builder
    asks for each participant's speakers' conversations. Counted in SQL
    statements, so a machine's speed cannot pass or fail it."""

    @staticmethod
    def _statements(db, n_people, prefix):
        for i in range(n_people):
            person = Participant(project_id=1, identifier=f"{prefix}-{i:03d}")
            db.add(person)
            db.flush()
            db.add(Speaker(project_id=1, name=f"{prefix}-{i}", participant_id=person.id))
        db.flush()
        seen = []
        bind = db.get_bind()

        def count(_conn, _cursor, statement, *_a):
            seen.append(statement)

        event.listen(bind, "before_cursor_execute", count)
        try:
            _listed(db)
        finally:
            event.remove(bind, "before_cursor_execute", count)
        return len(seen)

    def test_ten_more_linked_participants_cost_no_more_statements(self, world):
        db = world["db"]
        small = self._statements(db, 2, "S")
        large = self._statements(db, 10, "L")
        assert small == large, f"{small} statements for a small list, {large} for a larger one"
