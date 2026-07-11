"""Regression tests for facilitator-optional conversation import.

The facilitator designation is optional (interviews, oral arguments, and
dyadic conversations have no facilitator). The frontend import wizard only
requires >=1 non-facilitator speaker; the backend has never required a
facilitator. These tests lock in the downstream guarantee that matters:
with no facilitator, every speaker still gets a Participant row, and a
facilitator (when present) is intentionally excluded from Participant
auto-creation.
"""

from app.models.participant import Participant
from app.models.project import Project
from app.models.speaker import Speaker
from app.routers.conversations import ensure_participant_for_speaker


def _project(db):
    p = Project(name="Audio Sync Test", user_id=1)
    db.add(p)
    db.flush()
    return p


def test_no_facilitator_import_creates_participants_for_all_speakers(db_session):
    """A facilitator-free conversation: every speaker becomes a Participant."""
    db = db_session
    project = _project(db)

    names = ["John G. Roberts, Jr.", "James R. Barney", "Sonia Sotomayor"]
    speakers = []
    for n in names:
        s = Speaker(project_id=project.id, name=n, is_facilitator=0)
        db.add(s)
        db.flush()
        speakers.append(s)

    for s in speakers:
        ensure_participant_for_speaker(db, project.id, s, s.name)
    db.flush()

    participants = db.query(Participant).filter(
        Participant.project_id == project.id
    ).all()
    assert {p.identifier for p in participants} == set(names)
    assert all(s.participant_id is not None for s in speakers)


def test_facilitator_speaker_is_not_given_a_participant(db_session):
    """When a facilitator IS marked, it is excluded from Participant creation
    while non-facilitators still get one (the inclusive-filter contract)."""
    db = db_session
    project = _project(db)

    fac = Speaker(project_id=project.id, name="Moderator", is_facilitator=1)
    part = Speaker(project_id=project.id, name="Respondent", is_facilitator=0)
    db.add_all([fac, part])
    db.flush()

    ensure_participant_for_speaker(db, project.id, fac, fac.name)
    ensure_participant_for_speaker(db, project.id, part, part.name)
    db.flush()

    identifiers = {
        p.identifier
        for p in db.query(Participant).filter(
            Participant.project_id == project.id
        )
    }
    assert identifiers == {"Respondent"}
    assert fac.participant_id is None
    assert part.participant_id is not None


def test_speaker_name_with_stray_whitespace_links_to_existing_participant(db_session):
    """#534: speaker matching is trim-then-exact on Participant.identifier —
    the rule dataset linking already follows — so 'Maria Lopez ' (trailing
    space in the CSV) links to the existing 'Maria Lopez' instead of silently
    minting a duplicate participant."""
    db = db_session
    project = _project(db)

    existing = Participant(project_id=project.id, identifier="Maria Lopez",
                           display_name="Maria Lopez")
    db.add(existing)
    db.flush()

    s = Speaker(project_id=project.id, name="Maria Lopez ", is_facilitator=0)
    db.add(s)
    db.flush()
    ensure_participant_for_speaker(db, project.id, s, s.name)
    db.flush()

    assert s.participant_id == existing.id
    count = db.query(Participant).filter(
        Participant.project_id == project.id
    ).count()
    assert count == 1  # no duplicate


def test_speaker_name_is_trimmed_on_participant_creation(db_session):
    """#534: a padded label creates the participant with the TRIMMED
    identifier/display name, so a later exact-labelled source matches it."""
    db = db_session
    project = _project(db)

    s = Speaker(project_id=project.id, name="  Devon Clarke\t", is_facilitator=0)
    db.add(s)
    db.flush()
    ensure_participant_for_speaker(db, project.id, s, s.name)
    db.flush()

    p = db.query(Participant).filter(
        Participant.project_id == project.id
    ).one()
    assert p.identifier == "Devon Clarke"
    assert p.display_name == "Devon Clarke"
    assert s.participant_id == p.id


def test_whitespace_only_speaker_name_links_nothing(db_session):
    """#534: a whitespace-only label identifies nobody — no participant is
    created and the speaker stays unlinked (mirrors dataset linking's
    blank-skip rule)."""
    db = db_session
    project = _project(db)

    s = Speaker(project_id=project.id, name="   ", is_facilitator=0)
    db.add(s)
    db.flush()
    ensure_participant_for_speaker(db, project.id, s, s.name)
    db.flush()

    assert s.participant_id is None
    assert db.query(Participant).filter(
        Participant.project_id == project.id
    ).count() == 0
