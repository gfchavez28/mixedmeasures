"""Observations CRUD router (slab 1c). Endpoints are async and called directly
via asyncio.run (the _run pattern); ownership is structurally guaranteed by
test_ownership_gate_sweep.py — here we exercise the happy path + a 404."""
import asyncio

import pytest
from fastapi import HTTPException

from app.models import User, Project, Observation
from app.routers.observations import (
    list_observations, create_observation, get_observation,
    update_observation, delete_observation,
)
from app.schemas.observation import ObservationCreate, ObservationUpdate


def _run(coro):
    return asyncio.run(coro)


def _project(db, pid=700, uid=1):
    db.add(Project(id=pid, name="P", user_id=uid))
    db.flush()
    return pid


def _user(db, uid=1):
    return db.query(User).filter(User.id == uid).one()


class TestObservationCrud:
    def test_create_list_get(self, db_session):
        db = db_session
        pid = _project(db)
        u = _user(db)
        created = _run(create_observation(
            pid, ObservationCreate(name="Classroom Obs 1", description="day two"), user=u, db=db))
        assert created.name == "Classroom Obs 1"
        assert created.description == "day two"
        assert created.has_media is False and created.media_size_bytes is None
        assert created.segment_count == 0 and created.coded_segment_count == 0

        listed = _run(list_observations(pid, user=u, db=db))
        assert [o.id for o in listed] == [created.id]

        got = _run(get_observation(pid, created.id, user=u, db=db))
        assert got.id == created.id and got.name == "Classroom Obs 1"

    def test_update(self, db_session):
        db = db_session
        pid = _project(db)
        u = _user(db)
        obs = _run(create_observation(pid, ObservationCreate(name="A"), user=u, db=db))
        updated = _run(update_observation(
            pid, obs.id, ObservationUpdate(name="B", description="notes"), user=u, db=db))
        assert updated.name == "B" and updated.description == "notes"

    def test_delete(self, db_session):
        db = db_session
        pid = _project(db)
        u = _user(db)
        obs = _run(create_observation(pid, ObservationCreate(name="A"), user=u, db=db))
        _run(delete_observation(pid, obs.id, user=u, db=db))
        assert db.query(Observation).filter(Observation.id == obs.id).count() == 0

    def test_get_missing_404(self, db_session):
        db = db_session
        pid = _project(db)
        u = _user(db)
        with pytest.raises(HTTPException) as ei:
            _run(get_observation(pid, 999, user=u, db=db))
        assert ei.value.status_code == 404


class TestListIsBatched:
    """The list page is what makes an N+1 bite. Serializing each row on its own
    ran three count queries per observation."""

    def test_query_count_does_not_grow_with_the_number_of_observations(self, db_session):
        from sqlalchemy import event

        db = db_session
        pid = _project(db)
        u = _user(db)

        def _count_queries_for(n_extra):
            for i in range(n_extra):
                _run(create_observation(
                    pid, ObservationCreate(name=f"Obs {i}"), user=u, db=db))
            seen = []
            listener = lambda conn, cur, stmt, *a: seen.append(stmt)  # noqa: E731
            event.listen(db.bind, "before_cursor_execute", listener)
            try:
                _run(list_observations(pid, user=u, db=db))
            finally:
                event.remove(db.bind, "before_cursor_execute", listener)
            return len(seen)

        one = _count_queries_for(1)
        five = _count_queries_for(4)  # now 5 observations total
        assert five == one, (
            f"query count grew with row count ({one} -> {five}): the list is N+1 again"
        )

    def test_query_count_does_not_grow_with_the_number_of_clips(self, db_session):
        """#643 — the same shape one level down, and the bigger ceiling.

        The clip list eager-loads `code_applications -> code` and
        `attached_notes` because `_clip_to_response` reads both per row, but
        nothing pinned it: removing BOTH selectinloads left 42/42 tests passing.
        `MAX_CLIPS` allows 2,000 rows, so a silent regression here costs ~4,000
        extra queries on one large observation — where the observations list is
        bounded by how many recordings a project has.

        Each clip carries a code application AND a note on purpose: with empty
        relationships the eager loads have nothing to batch, so the mutant and
        the fix would issue the same number of queries and the pin would be
        vacuous.
        """
        from sqlalchemy import event

        from app.models.code import Code
        from app.models.code_application import CodeApplication
        from app.models.note import Note
        from app.routers.observations import create_clip, list_observation_segments
        from app.schemas.observation import ClipCreate

        db = db_session
        pid = _project(db)
        u = _user(db)
        obs = _run(create_observation(pid, ObservationCreate(name="Long"), user=u, db=db))
        db.add(Code(id=7430, project_id=pid, name="Theme", numeric_id=1,
                    is_active=True, is_universal=False))
        db.flush()

        made = 0

        def _count_queries_for(n_extra):
            nonlocal made
            for _ in range(n_extra):
                clip = _run(create_clip(
                    pid, obs.id,
                    ClipCreate(start_time=float(made * 10), end_time=float(made * 10 + 5)),
                    user=u, db=db))
                db.add(CodeApplication(code_id=7430, user_id=1, segment_id=clip.id))
                db.add(Note(observation_id=obs.id, segment_id=clip.id,
                            content="n", sequence_number=made + 1))
                db.flush()
                made += 1
            db.expire_all()          # force a real load, not the identity map
            seen = []
            listener = lambda conn, cur, stmt, *a: seen.append(stmt)  # noqa: E731
            event.listen(db.bind, "before_cursor_execute", listener)
            try:
                _run(list_observation_segments(pid, obs.id, user=u, db=db))
            finally:
                event.remove(db.bind, "before_cursor_execute", listener)
            return len(seen)

        one = _count_queries_for(1)
        five = _count_queries_for(4)  # now 5 clips total
        assert five == one, (
            f"query count grew with clip count ({one} -> {five}): the clip list "
            "is N+1 again — check the selectinloads in list_observation_segments"
        )


class TestProjectCounts:
    """The TopRail tab count and the Overview's source cards read these.

    Slab 1b already folded observation clips into the summary's `coded_segments`,
    so without these siblings a project whose only source is an Observation
    reported coded segments while claiming zero sources — and the Overview would
    still tell the researcher to import something to begin.
    """

    def test_observation_count_on_the_project_response(self, db_session):
        from app.routers.projects import get_project, list_projects
        db = db_session
        pid = _project(db)
        u = _user(db)
        _run(create_observation(pid, ObservationCreate(name="Obs"), user=u, db=db))

        single = _run(get_project(pid, user=u, db=db))
        assert single.observation_count == 1

        # The batched path is the one a miss turns into a silent zero on every
        # Dashboard card, so it is pinned separately.
        listed = _run(list_projects(user=u, db=db))
        assert next(p for p in listed.projects if p.id == pid).observation_count == 1

    def test_summary_carries_observations_and_recents(self, db_session):
        from app.routers.projects import get_project_summary
        db = db_session
        pid = _project(db)
        u = _user(db)
        obs = _run(create_observation(pid, ObservationCreate(name="Day 2"), user=u, db=db))

        summary = _run(get_project_summary(pid, user=u, db=db))
        assert summary.observations == 1
        assert [o.id for o in summary.recent_observations] == [obs.id]
        assert summary.recent_observations[0].name == "Day 2"
        assert summary.recent_observations[0].has_media is False

    def test_summary_carries_project_wide_clip_total(self, db_session):
        """#627: the Overview stat cell's sub-label needs a PROJECT-WIDE total.

        `recent_observations` covers only the four most recent, so it cannot
        supply this figure — the fixture below deliberately spreads clips across
        FIVE observations so a `recent_observations`-derived sum would come up
        short (it would see four of them and report 8, not 10).
        """
        from app.models.segment import Segment
        from app.routers.projects import get_project_summary
        db = db_session
        pid = _project(db)
        u = _user(db)

        for i in range(5):
            obs = _run(create_observation(pid, ObservationCreate(name=f"Obs {i}"), user=u, db=db))
            for j in range(2):
                db.add(Segment(
                    observation_id=obs.id,
                    text=f"clip {j}",
                    start_time=float(j * 10),
                    end_time=float(j * 10 + 5),
                    sequence_order=j,
                ))
        db.flush()

        summary = _run(get_project_summary(pid, user=u, db=db))
        assert summary.observations == 5
        assert summary.observation_clips == 10
        assert len(summary.recent_observations) == 4  # the window that can't answer this

    def test_summary_clip_total_excludes_soft_deleted_clips(self, db_session):
        """The total rides `visible_segment_filter()` like `document_segments`.

        A clip consumed by a split/merge keeps its row and would otherwise be
        double-counted alongside its replacements.
        """
        from app.models.segment import Segment
        from app.routers.projects import get_project_summary
        db = db_session
        pid = _project(db)
        u = _user(db)
        obs = _run(create_observation(pid, ObservationCreate(name="Obs"), user=u, db=db))

        live = Segment(observation_id=obs.id, text="live", start_time=0.0, end_time=5.0, sequence_order=0)
        gone = Segment(observation_id=obs.id, text="merged away", start_time=5.0, end_time=9.0, sequence_order=1)
        db.add_all([live, gone])
        db.flush()
        gone.merged_into_id = live.id
        db.flush()

        summary = _run(get_project_summary(pid, user=u, db=db))
        assert summary.observation_clips == 1
