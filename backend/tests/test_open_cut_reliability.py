"""Observations slab 6b-A — reliability for OPEN (unfrozen) observation cuts.

Three layers, mirroring test_irr.py:
1. Pure helpers (merge semantics, tick conversion) — hand-checked.
2. R round-trip for time-binned κ (Rscript + the `irr` package, gated). The
   binned matrix is exactly the units×coders 0/1 shape `irr::kappa2` takes, so
   this is a real oracle. α_U has NO R analogue — its math is already pinned
   against published DKPro vectors in test_unitizing_alpha.py, so the tests here
   pin the GATHER (seconds→ticks, overlap merge, roster) instead.
3. DB integration + the ownership gate.
"""
import asyncio
import subprocess
from datetime import datetime

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.open_cut_reliability import (
    compute_binned_kappa,
    compute_unitizing_alpha,
    gather_open_cut_marks,
    merge_strict_overlaps,
    seconds_to_ticks,
)
from tests import r_support

# R availability is single-sourced in tests/r_support.py (#642).
_RSCRIPT = r_support.RSCRIPT
_HAS_IRR = r_support.HAS_IRR


# ── 1. Pure helpers ──────────────────────────────────────────────────────────


class TestMergeStrictOverlaps:

    def test_overlapping_marks_merge(self):
        assert merge_strict_overlaps([(0.0, 5.0), (3.0, 8.0)]) == ([(0.0, 8.0)], 1)

    def test_abutting_marks_stay_distinct(self):
        """The load-bearing difference from 6a's `union_intervals`, which merges
        abutting ranges. Krippendorff's reference keeps them separate — two
        back-to-back 5 s marks are two units, not one 10 s unit — and collapsing
        them changes the unit count AND the length distribution, both of which
        feed expected disagreement. Reusing the 6a union would silently move α.
        """
        assert merge_strict_overlaps([(0.0, 5.0), (5.0, 10.0)]) == (
            [(0.0, 5.0), (5.0, 10.0)], 0)

    def test_nested_mark_is_absorbed(self):
        assert merge_strict_overlaps([(0.0, 20.0), (5.0, 8.0)]) == ([(0.0, 20.0)], 1)

    def test_disjoint_marks_are_untouched(self):
        assert merge_strict_overlaps([(0.0, 5.0), (7.0, 9.0)]) == (
            [(0.0, 5.0), (7.0, 9.0)], 0)

    def test_merge_count_is_reported(self):
        _merged, n = merge_strict_overlaps([(0.0, 5.0), (3.0, 8.0), (7.0, 12.0)])
        assert n == 2, "the count rides the wire — merging MOVES the statistic"


class TestTickConversion:

    def test_rounds_half_up_not_bankers(self):
        """Python's round() is banker's rounding, which would send 0.05 and 0.15
        in opposite directions. Same trap `format_timecode` documents."""
        assert seconds_to_ticks(0.05) == 1
        assert seconds_to_ticks(0.15) == 2

    def test_whole_seconds_are_exact(self):
        assert seconds_to_ticks(12.0) == 120


# ── 2. DB fixtures ───────────────────────────────────────────────────────────


def _seed(db, pid=600, *, frozen=False, duration=100.0):
    db.add(Project(id=pid, name="P", user_id=1))
    db.flush()
    db.add(User(id=2, username="Bob", password_hash=None, coder_type="human"))
    db.add(Observation(
        id=pid, project_id=pid, name="Playground",
        media_duration_seconds=duration,
        segmentation_frozen_at=datetime(2026, 7, 19) if frozen else None,
    ))
    db.add(Code(id=pid, project_id=pid, name="Off-task", numeric_id=1,
                is_active=True, is_universal=False))
    db.flush()
    return db.get(Observation, pid)


def _mark(db, sid, obs_id, coder, start, end, code_id, order=0):
    db.add(Segment(id=sid, conversation_id=None, observation_id=obs_id,
                   sequence_order=order, start_time=start, end_time=end, text=""))
    db.flush()
    db.add(CodeApplication(code_id=code_id, user_id=coder, segment_id=sid))
    db.flush()


# ── 3. The gather ────────────────────────────────────────────────────────────


class TestGather:

    def test_a_coder_who_marked_nothing_is_excluded_not_counted_as_silent(self, db_session):
        """A no-show would otherwise read as perfect disagreement with everyone:
        their whole continuum is gap, so every other coder's mark is a
        disagreement against them. Excluding is the honest roster."""
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 0.0, 10.0, 600)
        # Coder 2 exists on the roster but marked nothing.

        data = gather_open_cut_marks(db, 600, obs)

        assert data.coder_ids == [1]
        assert data.disclosure.excluded_coder_ids == [2]

    def test_overlapping_same_code_marks_are_merged_and_counted(self, db_session):
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 0.0, 10.0, 600)
        _mark(db, 6002, obs.id, 1, 5.0, 15.0, 600, order=1)

        data = gather_open_cut_marks(db, 600, obs)

        assert data.intervals[(1, 600)] == [(0.0, 15.0)]
        assert data.disclosure.n_merged_overlaps == 1

    def test_point_events_are_dropped_and_disclosed(self, db_session):
        """Zero length has no representation on the continuum, so α_U cannot see
        a point mark at all. Silently ignoring them would make D7's point events
        look counted."""
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 4.0, 4.0, 600)

        data = gather_open_cut_marks(db, 600, obs)

        assert data.disclosure.n_zero_length_dropped == 1
        assert data.intervals == {}

    def test_extent_source_is_disclosed(self, db_session):
        """#622's lesson: a fallback denominator must never read as the
        recording's true length."""
        db = db_session
        obs = _seed(db, duration=100.0)
        _mark(db, 6001, obs.id, 1, 0.0, 10.0, 600)
        assert gather_open_cut_marks(db, 600, obs).disclosure.extent_source == "recording"

        obs.media_duration_seconds = None
        db.flush()
        data = gather_open_cut_marks(db, 600, obs)
        assert data.disclosure.extent_source == "marked_extent"
        assert data.extent_seconds == 10.0


# ── 4. Unitizing α ───────────────────────────────────────────────────────────


class TestUnitizingAlpha:

    def test_identical_marks_agree_perfectly(self, db_session):
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 10.0, 30.0, 600)
        _mark(db, 6002, obs.id, 2, 10.0, 30.0, 600, order=1)

        res = compute_unitizing_alpha(db, 600, obs)

        assert res["available"] is True
        assert res["overall"]["alpha"] == pytest.approx(1.0)

    def test_offset_boundaries_lower_alpha_without_destroying_it(self, db_session):
        """The case α_U exists for: both coders saw the same behaviour but drew
        the edges differently. That is partial agreement, not a miss."""
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 10.0, 30.0, 600)
        _mark(db, 6002, obs.id, 2, 12.0, 32.0, 600, order=1)

        res = compute_unitizing_alpha(db, 600, obs)
        alpha = res["overall"]["alpha"]

        assert 0.0 < alpha < 1.0, "boundary disagreement is partial, not total"

    def test_single_coder_is_unavailable_with_a_reason(self, db_session):
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 0.0, 10.0, 600)

        res = compute_unitizing_alpha(db, 600, obs)

        assert res["available"] is False
        assert "at least 2 coders" in res["reason"]

    def test_coverage_fraction_is_reported_per_code(self, db_session):
        """α_U's own prevalence figure — a DIFFERENT denominator from binned κ's
        bin fraction, so the two are deliberately named apart."""
        db = db_session
        obs = _seed(db, duration=100.0)
        _mark(db, 6001, obs.id, 1, 0.0, 20.0, 600)
        _mark(db, 6002, obs.id, 2, 0.0, 20.0, 600, order=1)

        res = compute_unitizing_alpha(db, 600, obs)

        assert res["per_category"][0]["coverage_fraction"] == pytest.approx(0.2)


# ── 5. Time-binned κ (R-oracled) ─────────────────────────────────────────────


class TestBinnedKappa:

    def test_identical_marks_agree_perfectly(self, db_session):
        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 10.0, 30.0, 600)
        _mark(db, 6002, obs.id, 2, 10.0, 30.0, 600, order=1)

        res = compute_binned_kappa(db, 600, obs, bin_seconds=1.0)

        assert res["available"] is True
        assert res["per_code"][0]["cohens_kappa"] == pytest.approx(1.0)
        assert res["per_code"][0]["percent_agreement"] == pytest.approx(1.0)

    def test_prevalence_rides_beside_the_coefficient(self, db_session):
        """The sparse-clip trap: 20 s of behaviour on a 100 s recording leaves
        most bins empty for both coders, so percent agreement looks excellent
        whatever κ says. The base rate is what tells them apart."""
        db = db_session
        obs = _seed(db, duration=100.0)
        _mark(db, 6001, obs.id, 1, 0.0, 20.0, 600)
        _mark(db, 6002, obs.id, 2, 0.0, 20.0, 600, order=1)

        entry = compute_binned_kappa(db, 600, obs, bin_seconds=1.0)["per_code"][0]

        assert entry["prevalence"] == pytest.approx(0.2, abs=0.02)
        assert entry["percent_agreement"] == pytest.approx(1.0)

    def test_bin_width_changes_the_answer_and_is_echoed_back(self, db_session):
        """Why the parameter is reported: a 4 s offset is a total disagreement at
        1 s bins and mostly absorbed at 20 s bins. Same data, different number."""
        db = db_session
        obs = _seed(db, duration=100.0)
        _mark(db, 6001, obs.id, 1, 0.0, 8.0, 600)
        _mark(db, 6002, obs.id, 2, 4.0, 12.0, 600, order=1)

        fine = compute_binned_kappa(db, 600, obs, bin_seconds=1.0)
        coarse = compute_binned_kappa(db, 600, obs, bin_seconds=20.0)

        assert fine["bin_seconds"] == 1.0 and coarse["bin_seconds"] == 20.0
        assert fine["per_code"][0]["percent_agreement"] < coarse["per_code"][0]["percent_agreement"]

    def test_an_absurd_bin_size_is_refused_with_the_way_out(self, db_session):
        db = db_session
        obs = _seed(db, duration=100_000.0)
        _mark(db, 6001, obs.id, 1, 0.0, 10.0, 600)
        _mark(db, 6002, obs.id, 2, 0.0, 10.0, 600, order=1)

        res = compute_binned_kappa(db, 600, obs, bin_seconds=0.1)

        assert res["available"] is False
        assert "larger bin" in res["reason"]

    @pytest.mark.skipif(not _HAS_IRR, reason="Rscript with the irr package not available")
    def test_binned_kappa_reproduces_r(self, db_session, tmp_path):
        """#402: the tool's number must be R's number, not merely valid R.

        Binning produces exactly the units×coders 0/1 matrix `irr::kappa2` takes,
        so unlike α_U this has a true external oracle.
        """
        db = db_session
        obs = _seed(db, duration=60.0)
        _mark(db, 6001, obs.id, 1, 0.0, 10.0, 600)
        _mark(db, 6002, obs.id, 1, 20.0, 30.0, 600, order=1)
        _mark(db, 6003, obs.id, 2, 0.0, 12.0, 600, order=2)
        _mark(db, 6004, obs.id, 2, 25.0, 30.0, 600, order=3)

        res = compute_binned_kappa(db, 600, obs, bin_seconds=1.0)
        entry = res["per_code"][0]

        # Rebuild the same matrix independently and hand it to R.
        n_bins = res["n_bins"]
        a = {b for b in range(n_bins) if b < 10 or 20 <= b < 30}
        c = {b for b in range(n_bins) if b < 12 or 25 <= b < 30}
        rows = [[1 if b in a else 0, 1 if b in c else 0] for b in range(n_bins)]

        csv_path = tmp_path / "m.csv"
        csv_path.write_text(
            "a,b\n" + "\n".join(f"{r[0]},{r[1]}" for r in rows) + "\n")
        script = tmp_path / "run.R"
        script.write_text(
            'library(irr)\n'
            f'm <- read.csv("{csv_path}")\n'
            'cat(kappa2(m)$value, agree(m)$value/100, sep="\\n")\n'
        )
        out = subprocess.run([_RSCRIPT, str(script)], capture_output=True,
                             text=True, timeout=120)
        assert out.returncode == 0, out.stderr
        r_kappa, r_agree = (float(x) for x in out.stdout.strip().splitlines())

        assert entry["cohens_kappa"] == pytest.approx(r_kappa, abs=1e-6)
        assert entry["percent_agreement"] == pytest.approx(r_agree, abs=1e-6)


# ── 6. The endpoints + the ownership gate ────────────────────────────────────


class TestEndpoints:

    def test_frozen_observations_are_refused_with_the_better_answer_named(self, db_session):
        """Frozen clips are shared units, so ordinary κ applies — pointing the
        open-cut statistic at them would answer a question nobody asked."""
        from fastapi import HTTPException
        from app.routers.code_analysis import unitizing_alpha_endpoint

        db = db_session
        obs = _seed(db, frozen=True)
        user = db.get(User, 1)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(unitizing_alpha_endpoint(
                project_id=600, observation_id=obs.id, coder_ids=None,
                user=user, db=db))
        assert exc.value.status_code == 400
        assert "inter-rater reliability" in exc.value.detail

    def test_another_tenants_observation_is_not_readable(self, db_session):
        """⚠️ The AST ownership sweep passes on ANY gate token and is structurally
        blind to a SECOND entity id — gating only the project would satisfy it
        while letting a caller name another tenant's observation and read its
        coding back. This behavioural test is the actual guarantee; the scan
        cannot provide it.
        """
        from fastapi import HTTPException
        from app.routers.code_analysis import unitizing_alpha_endpoint

        db = db_session
        mine = _seed(db, pid=600)
        db.add(User(id=9, username="Other", password_hash=None, coder_type="human"))
        db.add(Project(id=700, name="Theirs", user_id=9))
        db.flush()
        db.add(Observation(id=700, project_id=700, name="Theirs",
                           media_duration_seconds=100.0))
        db.flush()

        user = db.get(User, 1)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(unitizing_alpha_endpoint(
                project_id=mine.project_id, observation_id=700, coder_ids=None,
                user=user, db=db))
        assert exc.value.status_code == 404

    def test_alpha_reaches_the_wire_through_its_schema(self, db_session):
        """The disclosure block must survive validation — an undeclared field is
        dropped silently, and these fields are what make the number checkable."""
        from app.routers.code_analysis import unitizing_alpha_endpoint
        from app.schemas.code_analysis import UnitizingAlphaResponse

        db = db_session
        obs = _seed(db)
        _mark(db, 6001, obs.id, 1, 10.0, 30.0, 600)
        _mark(db, 6002, obs.id, 2, 12.0, 32.0, 600, order=1)
        user = db.get(User, 1)

        raw = asyncio.run(unitizing_alpha_endpoint(
            project_id=600, observation_id=obs.id, coder_ids=None, user=user, db=db))
        validated = UnitizingAlphaResponse(**raw)

        assert validated.available is True
        assert validated.disclosure.tick_ms == 100
        assert validated.disclosure.extent_source == "recording"
        assert validated.per_category[0].code_name == "Off-task"
