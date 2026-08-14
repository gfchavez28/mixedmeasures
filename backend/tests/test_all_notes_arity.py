"""#676 — every `Note` PARENT must have a group in the all-notes response.

**Why this is shaped as an arity pin and not "observations render".** #515 fixed
this same surface for documents in July and its regression test is titled *"the
all-notes response's `documents` group must actually render"*. That pins the
PARENT. Observations shipped a week later, the reader was never revisited, and
the #515 test stayed green throughout — the page reported "No notes yet" on a
project that contained a note (#676). A third parent-shaped test would set up a
fourth instance.

So the guard below derives the parent set from `ck_note_at_least_one_parent` —
the constraint a new parent MUST be added to — and fails if any parent has no
group. Nobody has to remember this file exists.
"""
import asyncio
import re

import pytest
from sqlalchemy import CheckConstraint

from app.models.conversation import Conversation
from app.models.document import Document
from app.models.note import Note
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.all_notes import get_all_notes
from app.schemas.note import AllNotesResponse

# The ONE place a parent is mapped to the group that surfaces it. A new parent
# must appear here (and in the response) or `test_every_note_parent_has_a_group`
# fails — that is the whole point.
PARENT_TO_GROUP = {
    "conversation_id": "conversations",
    "dataset_value_id": "texts",
    "document_id": "documents",
    "observation_id": "observations",
}


def _declared_note_parents() -> set[str]:
    """Parent FK names, read from the at-least-one CHECK rather than hardcoded."""
    for c in Note.__table__.constraints:
        if isinstance(c, CheckConstraint) and c.name == "ck_note_at_least_one_parent":
            return set(re.findall(r"(\w+_id)\s+IS NOT NULL", str(c.sqltext)))
    raise AssertionError("ck_note_at_least_one_parent is gone — the arity pin cannot work")


def test_every_note_parent_has_a_group():
    parents = _declared_note_parents()
    assert parents, "no parents parsed from the CHECK — the regex or the constraint changed"

    unmapped = parents - set(PARENT_TO_GROUP)
    assert not unmapped, (
        f"Note gained parent(s) {sorted(unmapped)} with no all-notes group. Notes on that "
        "parent are storable and invisible on the Memos & Notes page — the #515/#676 shape. "
        "Add the query block, the schema group, the TS type and the panel arm together."
    )
    stale = set(PARENT_TO_GROUP) - parents
    assert not stale, f"PARENT_TO_GROUP names {sorted(stale)}, which the CHECK no longer declares"

    for group in PARENT_TO_GROUP.values():
        assert group in AllNotesResponse.model_fields, (
            f"'{group}' is mapped from a Note parent but AllNotesResponse has no such field"
        )


def test_an_observation_note_reaches_the_response(db_session):
    """The behavioural half — #676 itself, on a project whose ONLY note is on an
    observation (the shape that made the page read 'No notes yet')."""
    db = db_session
    db.add_all([
        Project(id=900, name="Obs notes", user_id=1),
        Observation(id=900, project_id=900, name="Session 1"),
        Segment(id=9001, observation_id=900, sequence_order=0, text="Clip label",
                start_time=1.0, end_time=2.0),
    ])
    db.flush()
    db.add(Note(observation_id=900, segment_id=9001, content="Something worth noting",
                sequence_number=1))
    db.commit()

    user = db.query(User).filter(User.id == 1).first()
    res = asyncio.run(get_all_notes(900, search=None, include_archived=False, user=user, db=db))

    assert len(res.observations) == 1
    group = res.observations[0]
    assert group.observation_id == 900
    assert group.observation_name == "Session 1"
    assert [n.content for n in group.notes] == ["Something worth noting"]
    assert group.notes[0].segment_id == 9001
    assert group.notes[0].segment_text == "Clip label"
    # And the other groups stay empty rather than absorbing it.
    assert res.conversations == [] and res.documents == [] and res.texts == []


def test_an_unlabelled_clips_note_carries_no_empty_context(db_session):
    """A clip label is frequently '' — that must not become an empty quote block."""
    db = db_session
    db.add_all([
        Project(id=901, name="Obs notes 2", user_id=1),
        Observation(id=901, project_id=901, name="Session 2"),
        Segment(id=9011, observation_id=901, sequence_order=0, text="",
                start_time=1.0, end_time=2.0),
    ])
    db.flush()
    db.add(Note(observation_id=901, segment_id=9011, content="On an unlabelled clip",
                sequence_number=1))
    db.commit()

    user = db.query(User).filter(User.id == 1).first()
    res = asyncio.run(get_all_notes(901, search=None, include_archived=False, user=user, db=db))
    assert res.observations[0].notes[0].segment_text is None


def test_all_four_parents_populate_together(db_session):
    """Two-sided: with a note on every parent, every group fills.

    A single-parent fixture cannot distinguish "reads all parents" from "reads
    the one I happened to seed".
    """
    db = db_session
    db.add_all([
        Project(id=902, name="All four", user_id=1),
        Conversation(id=902, project_id=902, name="C"),
        Document(id=902, project_id=902, name="D", source_filename="d.docx", source_format="docx"),
        Observation(id=902, project_id=902, name="O"),
    ])
    db.flush()
    db.add_all([
        Note(conversation_id=902, content="conv note", sequence_number=1),
        Note(document_id=902, content="doc note", sequence_number=1),
        Note(observation_id=902, content="obs note", sequence_number=1),
    ])
    db.commit()

    user = db.query(User).filter(User.id == 1).first()
    res = asyncio.run(get_all_notes(902, search=None, include_archived=False, user=user, db=db))

    assert len(res.conversations) == 1
    assert len(res.documents) == 1
    assert len(res.observations) == 1


def test_search_and_archive_filters_reach_observation_notes(db_session):
    """The three older blocks each apply search + include_archived; a new block
    that forgets either is silently inconsistent rather than broken."""
    db = db_session
    db.add_all([
        Project(id=903, name="Filters", user_id=1),
        Observation(id=903, project_id=903, name="O"),
    ])
    db.flush()
    db.add_all([
        Note(observation_id=903, content="findable", sequence_number=1),
        Note(observation_id=903, content="hidden", sequence_number=2, is_archived=True),
    ])
    db.commit()
    user = db.query(User).filter(User.id == 1).first()

    plain = asyncio.run(get_all_notes(903, search=None, include_archived=False, user=user, db=db))
    assert [n.content for n in plain.observations[0].notes] == ["findable"]

    archived = asyncio.run(get_all_notes(903, search=None, include_archived=True, user=user, db=db))
    assert len(archived.observations[0].notes) == 2

    searched = asyncio.run(get_all_notes(903, search="findab", include_archived=False, user=user, db=db))
    assert len(searched.observations[0].notes) == 1

    missed = asyncio.run(get_all_notes(903, search="nothingmatches", include_archived=False, user=user, db=db))
    assert missed.observations == []
