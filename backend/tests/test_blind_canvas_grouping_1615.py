"""#1615 (D297's Canvas path) — a saved QUALITATIVE Canvas chart grouped by a score band,
opened by a blind coder.

A Canvas embed replays the coder scope that was SAVED (`inline-chart-params.ts`: the figure
is a snapshot), so its ``coder_ids`` describe the FIGURE, not the viewer. The Qualitative
page's signal (``ratings_follow_coder_ids``: "my ``coder_ids`` IS the blind scope", D273) is
therefore wrong here: a lead's every-coder chart (``coder_ids`` absent) or one saved over
[Alice, Bob] would keep a band of their ratings for a blind Alice. The embed sends the
VIEWER's id as ``ratings_viewer_id``, only while blind mode withholds; it feeds the grouping
gate's ``blind_scope`` (r3's `_build_participant_group_map`) and nothing else — which
coders' coding the figure counts does not move.

Fixture: r3's ``banded`` (the #1608 `scored_project` — Ana's T1 carries Alice's 2 and Bob's
5, the snapshot 3.5 — plus a band ``Score group`` = "score ≥ 3", retyped DEMOGRAPHIC, and an
ordinary ``Site``). Ana sits in ``high`` from the every-coder 3.5, where Alice's own 2 would
put her in ``low``.
"""
import inspect
import json

import pytest
from fastapi import HTTPException

from app.models.dataset import Dataset
from app.routers import code_analysis as router
from app.schemas.code_analysis import DemographicComparisonRequest, SourceFrequenciesRequest
from tests.test_blind_file_scope_1530 import (  # noqa: F401 — the fixtures
    ALICE, BOB, PID, _user, blind_project, scored_project,
)
from tests.test_blind_grouping_1615 import banded  # noqa: F401 — the fixture

BAND, SITE = "Score group", "Site"


def _compare(db, **kw):
    return router.demographic_comparison(PID, DemographicComparisonRequest(**kw),
                                         user=_user(db), db=db)


def _sources(db, **kw):
    return router.source_frequencies(PID, SourceFrequenciesRequest(**kw), user=_user(db), db=db)


def _refused(fn):
    with pytest.raises(HTTPException) as exc:
        fn()
    assert exc.value.status_code == 409
    # D284's words, unchanged: the variable's name, then why.
    assert exc.value.detail.startswith(f"“{BAND}” cannot form groups while blind")
    assert "every coder's ratings" in exc.value.detail
    return exc.value.detail


class TestTheEmbedsGroupingDoors:
    def test_a_saved_every_coder_comparison_by_a_band_is_refused_for_a_blind_viewer(self, banded):
        db = banded["db"]
        # The leak's shape: the embed replays the lead's every-coder scope; Ana is in `high`.
        assert set(_compare(db, group_by_subtype=BAND)["groups"]) == {"high"}
        _refused(lambda: _compare(db, group_by_subtype=BAND, ratings_viewer_id=ALICE))

    def test_the_viewer_decides_never_the_figures_coder_scope(self, banded):
        db = banded["db"]
        # A chart saved over [Alice, Bob]: the page's flag would read that as a scope holding
        # every rater and keep the band — but the viewer is Alice alone.
        refused = _refused(lambda: _compare(db, group_by_subtype=BAND, coder_ids=[ALICE, BOB],
                                            ratings_viewer_id=ALICE))
        assert refused   # and the same chart for a lead (no viewer id) keeps its groups:
        assert _compare(db, group_by_subtype=BAND, coder_ids=[ALICE, BOB])["groups"]
        # Why the page's flag cannot serve the embed: over the figure's scope it keeps the band.
        assert _compare(db, group_by_subtype=BAND, coder_ids=[ALICE, BOB],
                        ratings_follow_coder_ids=True)["groups"]
        # A chart a lead saved filtered to Bob, opened by the lead (not blind): kept.
        assert _compare(db, group_by_subtype=BAND, coder_ids=[BOB])["groups"]

    def test_the_sources_bar_grouped_by_a_band_is_refused_for_a_blind_viewer(self, banded):
        db = banded["db"]
        assert _sources(db, group_by_subtype=BAND)["group_by"] == BAND   # unscoped: drawn
        _refused(lambda: _sources(db, group_by_subtype=BAND, ratings_viewer_id=ALICE))


class TestWhatTheViewerIdDoesNotTouch:
    def test_it_never_changes_what_the_figure_counts(self, banded):
        """The figure's coder scope is the SAVED one (the recorded rule): the viewer id is a
        question about ratings only, so an ordinary grouping returns the identical payload."""
        db = banded["db"]
        for saved in (None, [BOB]):
            plain = _compare(db, group_by_subtype=SITE, coder_ids=saved)
            viewed = _compare(db, group_by_subtype=SITE, coder_ids=saved, ratings_viewer_id=ALICE)
            assert json.dumps(viewed, sort_keys=True, default=str) == \
                json.dumps(plain, sort_keys=True, default=str)
            plain = _sources(db, group_by_subtype=SITE, coder_ids=saved)
            viewed = _sources(db, group_by_subtype=SITE, coder_ids=saved, ratings_viewer_id=ALICE)
            assert json.dumps(viewed, sort_keys=True, default=str) == \
                json.dumps(plain, sort_keys=True, default=str)
        assert set(_compare(db, group_by_subtype=SITE, ratings_viewer_id=ALICE)["groups"]) == {"North"}

    def test_a_viewer_whose_ratings_are_the_whole_snapshot_keeps_the_band(self, banded):
        """D98: a scope holding every coder whose ratings the table carries keeps them — here
        a table refreshed when only Alice had rated (the snapshot's record, D222)."""
        db, ds = banded["db"], banded["dataset"]
        db.get(Dataset, ds.id).managed_rater_ids = json.dumps([ALICE])
        db.flush()
        assert set(_compare(db, group_by_subtype=BAND, ratings_viewer_id=ALICE)["groups"]) == {"high"}
        _refused(lambda: _compare(db, group_by_subtype=BAND, ratings_viewer_id=BOB))

    def test_a_saved_participant_filter_is_not_judged(self, banded):
        """r6-3: a material saves its filter as participant ids only (`participant-filter.md`
        §4 — no values), so nothing can tell a list chosen from a band from any other list
        (D124 rejected inferring values from ids). The residual is stated, not guessed at."""
        db, ana = banded["db"], banded["ana"]
        out = _compare(db, group_by_subtype=SITE, participant_ids=[ana.id], ratings_viewer_id=ALICE)
        assert set(out["groups"]) == {"North"}


class TestTheSignalIsDecidedAtEachDoor:
    def test_the_router_helper_takes_the_viewer_id_with_no_default(self):
        p = inspect.signature(router._blind_scope).parameters["ratings_viewer_id"]
        assert p.kind is inspect.Parameter.KEYWORD_ONLY and p.default is inspect.Parameter.empty

    def test_only_the_two_bodies_carry_it(self):
        assert "ratings_viewer_id" in SourceFrequenciesRequest.model_fields
        assert "ratings_viewer_id" in DemographicComparisonRequest.model_fields
        assert SourceFrequenciesRequest().ratings_viewer_id is None   # absent = not blind
