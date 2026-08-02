"""Timeline coverage (Observations slab 6a) — the interval math and the wire.

Two things are pinned here:

1. **The shared fixture table.** ``COVERAGE_CASES`` below is the SAME case list
   as ``frontend/src/lib/clip-timeline.test.ts`` — the workbench gauge (blind
   scoped, client-side) and the list percentage (all-coder, server-side) are a
   deliberate two-language mirror of one definition, so both suites pin the same
   cases and the pair must be edited together. The precedent is
   ``order_value_labels`` ↔ ``compareValueLabels`` (#406).

   The frontend table also carries a ``gaps`` column; there is no Python mirror
   for it because nothing server-side consumes gaps (``u`` is a client gesture),
   and an unconsumed helper is speculative code.

2. **The DB helper's filters** — the J-A trio (visible · non-universal ·
   non-consensus) and, above all, that OVERLAP DOES NOT DOUBLE-COUNT. Clips
   point at a timeline rather than partition it (D6), so ``SUM(end - start)``
   would report two coders coding the same minute as two minutes covered.
"""
import asyncio

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.observations import get_observation, list_observations
from app.services.coding_counts import timeline_coverage_by_observation
from app.services.coding_layers import CONSENSUS_ORIGIN
from app.services.observation_segmentation import (
    coverage_extent,
    covered_seconds,
    union_intervals,
)

def _run(coro):
    """asyncio.run, never get_event_loop().run_until_complete — a shared loop
    closed by another module's asyncio.run makes this fail BY SUITE ORDER."""
    return asyncio.run(coro)


# ⚠️ MIRRORED in clip-timeline.test.ts — edit both. Values are >=10s throughout
# (the #406 fixture rule).
COVERAGE_CASES = [
    ("disjoint ranges stay separate", [(10, 20), (40, 55)], 100, [(10, 20), (40, 55)], 25),
    ("overlapping ranges merge and do NOT double-count", [(10, 30), (25, 45)], 100, [(10, 45)], 35),
    ("a contained range adds nothing", [(10, 90), (30, 40)], 100, [(10, 90)], 80),
    ("abutting ranges merge — the boundary is one cut, not a gap", [(10, 25), (25, 40)], 100, [(10, 40)], 30),
    ("point events are dropped — they mark, they do not cover (D7)", [(15, 15), (30, 45)], 100, [(30, 45)], 15),
    ("a clip overhanging the extent is clamped by the CONSUMER, not the union", [(80, 140)], 100, [(80, 140)], 20),
    ("nothing coded", [], 100, [], 0),
    ("fully covered", [(0, 100)], 100, [(0, 100)], 100),
    ("input order does not matter", [(60, 75), (10, 20)], 100, [(10, 20), (60, 75)], 25),
    ("zero extent covers nothing", [(10, 20)], 0, [(10, 20)], 0),
]


@pytest.mark.parametrize(
    "name,intervals,extent,expected_union,expected_covered",
    COVERAGE_CASES,
    ids=[c[0] for c in COVERAGE_CASES],
)
def test_coverage_cases(name, intervals, extent, expected_union, expected_covered):
    union = union_intervals([(float(a), float(b)) for a, b in intervals])
    assert union == [(float(a), float(b)) for a, b in expected_union]
    assert covered_seconds(union, float(extent)) == pytest.approx(float(expected_covered))


class TestCoverageExtent:
    """D34's law: max(duration, max clip end), None when there is nothing to measure."""

    def test_duration_wins_when_it_is_longer(self):
        assert coverage_extent(200.0, 120.0) == 200.0

    def test_a_clip_may_outrun_the_recording(self):
        # _validate_clip_range deliberately never clamps (the cue posture), so
        # the extent must stretch or coverage could exceed 100%.
        assert coverage_extent(100.0, 140.0) == 140.0

    def test_no_duration_falls_back_to_the_marked_extent(self):
        assert coverage_extent(None, 90.0) == 90.0

    def test_nothing_to_measure_is_None_not_zero(self):
        # The wire distinguishes "0% covered" from "no denominator" — a client
        # that divided by a 0 extent would render NaN%.
        assert coverage_extent(None, None) is None
        assert coverage_extent(0.0, 0.0) is None


class TestTimelineCoverageByObservation:
    """The DB helper — filters, batching, and the union."""

    def _setup(self, db, clips, *, universal=False, origin=None, pid=760):
        db.add(Project(id=pid, name="P", user_id=1))
        db.flush()
        obs = Observation(project_id=pid, name="Coverage obs")
        db.add(obs)
        db.flush()
        code = Code(
            project_id=pid, numeric_id=1, name="Engagement", is_universal=universal,
        )
        db.add(code)
        db.flush()
        for order, (start, end) in enumerate(clips):
            seg = Segment(
                observation_id=obs.id, sequence_order=order,
                start_time=float(start), end_time=float(end), text="",
            )
            db.add(seg)
            db.flush()
            kwargs = {"segment_id": seg.id, "code_id": code.id}
            if origin:
                kwargs["origin"] = origin
            db.add(CodeApplication(**kwargs))
        db.flush()
        return obs

    def test_overlapping_clips_do_not_double_count(self, db_session):
        obs = self._setup(db_session, [(0, 50), (40, 60)])
        result = timeline_coverage_by_observation(db_session, {obs.id: 200.0})
        # Union [0, 60] = 60. Summing the ranges would give 70.
        assert result[obs.id] == pytest.approx(60.0)

    def test_a_universal_only_clip_covers_nothing(self, db_session):
        obs = self._setup(db_session, [(0, 50)], universal=True)
        assert timeline_coverage_by_observation(db_session, {obs.id: 200.0}) == {}

    def test_the_consensus_layer_does_not_inflate_coverage(self, db_session):
        # J2-B: a FROZEN observation genuinely has a consensus layer (D18), so
        # this is a real filter here, not shape-keeping — without it a fully
        # reconciled observation would report double its true coverage.
        obs = self._setup(db_session, [(0, 50)], origin=CONSENSUS_ORIGIN)
        assert timeline_coverage_by_observation(db_session, {obs.id: 200.0}) == {}

    def test_a_soft_deleted_clip_is_invisible(self, db_session):
        obs = self._setup(db_session, [(0, 50), (100, 150)])
        kept, gone = (
            db_session.query(Segment)
            .filter(Segment.observation_id == obs.id)
            .order_by(Segment.start_time)
            .all()
        )
        gone.merged_into_id = kept.id
        db_session.flush()
        result = timeline_coverage_by_observation(db_session, {obs.id: 200.0})
        assert result[obs.id] == pytest.approx(50.0)

    def test_coverage_is_clamped_to_the_extent(self, db_session):
        # A clip running past the extent it is measured against can never push
        # the number over 100%.
        obs = self._setup(db_session, [(80, 140)])
        result = timeline_coverage_by_observation(db_session, {obs.id: 100.0})
        assert result[obs.id] == pytest.approx(20.0)

    def test_an_observation_absent_from_extents_is_not_measured(self, db_session):
        self._setup(db_session, [(0, 50)])
        assert timeline_coverage_by_observation(db_session, {}) == {}


class TestCoverageOnTheWire:
    """The RESPONSE object, not the schema (the splat rule) — list AND detail.

    The two paths compute coverage through DIFFERENT code (the list passes
    batched values with ``coverage_precomputed=True``; the single GET serves
    itself), so both are pinned: a divergence would show as a list percentage
    that changes when you open the observation.
    """

    def _coded_observation(self, db, pid=770, duration=200.0):
        db.add(Project(id=pid, name="P", user_id=1))
        db.flush()
        obs = Observation(project_id=pid, name="Wired obs", media_duration_seconds=duration)
        db.add(obs)
        db.flush()
        code = Code(project_id=pid, numeric_id=1, name="Engagement")
        db.add(code)
        db.flush()
        for order, (start, end) in enumerate([(0.0, 50.0), (40.0, 60.0)]):
            seg = Segment(
                observation_id=obs.id, sequence_order=order,
                start_time=start, end_time=end, text="",
            )
            db.add(seg)
            db.flush()
            db.add(CodeApplication(segment_id=seg.id, code_id=code.id))
        db.flush()
        return pid, obs

    def test_list_carries_unioned_coverage_and_its_extent(self, db_session):
        pid, _ = self._coded_observation(db_session)
        user = db_session.query(User).filter(User.id == 1).one()
        rows = _run(list_observations(pid, user=user, db=db_session))
        row = rows[0].model_dump()
        assert row["covered_seconds"] == pytest.approx(60.0)
        assert row["coverage_extent_seconds"] == pytest.approx(200.0)

    def test_detail_agrees_with_the_list(self, db_session):
        pid, obs = self._coded_observation(db_session)
        user = db_session.query(User).filter(User.id == 1).one()
        listed = _run(list_observations(pid, user=user, db=db_session))[0].model_dump()
        detail = _run(get_observation(pid, obs.id, user=user, db=db_session)).model_dump()
        assert detail["covered_seconds"] == pytest.approx(listed["covered_seconds"])
        assert detail["coverage_extent_seconds"] == pytest.approx(listed["coverage_extent_seconds"])
        assert detail["covered_seconds"] == pytest.approx(60.0)

    def test_no_duration_and_no_clips_reports_no_denominator(self, db_session):
        db_session.add(Project(id=780, name="P", user_id=1))
        db_session.flush()
        obs = Observation(project_id=780, name="Bare obs")
        db_session.add(obs)
        db_session.flush()
        user = db_session.query(User).filter(User.id == 1).one()
        detail = _run(get_observation(780, obs.id, user=user, db=db_session)).model_dump()
        # None, not 0 — a client must be able to tell "nothing covered" from
        # "nothing to measure against" (it would render NaN%).
        assert detail["coverage_extent_seconds"] is None
        assert detail["covered_seconds"] == 0.0

    def test_clips_without_a_duration_still_get_an_extent(self, db_session):
        # The #574 shape: every .mov/.webm uploaded before the backfill has a
        # NULL duration, and those observations must still report a percentage.
        pid, obs = self._coded_observation(db_session, pid=790, duration=None)
        user = db_session.query(User).filter(User.id == 1).one()
        detail = _run(get_observation(pid, obs.id, user=user, db=db_session)).model_dump()
        assert detail["coverage_extent_seconds"] == pytest.approx(60.0)
        assert detail["covered_seconds"] == pytest.approx(60.0)
