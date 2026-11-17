"""Row 45 (i) step 2 — `services/magnitude_rollup.py`.

The working corpus (`backend/seed_pd_audit.py`) is the ORACLE for the arithmetic
and it is checked by hand against `testdata/pd_audit/EXPECTED_OUTCOMES.md`. But
it is DEGENERATE on the axis the "whose ratings" rule turns on: MEASURED
2026-09-08, its only rated cell without a consensus row is the observation clip
(unfrozen, so D18 gives it no consensus layer), and that reaches no participant
anyway. So every fixture below exists because the corpus cannot reach it:

  * a SOLE coder's rating (one voter — no consensus is possible)
  * a MINORITY application in a multi-voter target (consensus refused it)
  * a rating on a code whose scale was cleared
  * a rated FACILITATOR turn
  * a fixture on which mean-of-medians, median-of-medians, mean-of-all and
    median-of-all are FOUR DIFFERENT NUMBERS (the #707a discrimination rule —
    an oracle test's failure mode is a fixture the right and the plausible-wrong
    implementations agree on)
"""

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.observation import Observation
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.services import magnitude_rollup as mr
from app.services.consensus import gather_target_votes
from app.services.magnitude_rollup import (
    CI_METHOD_PASSAGE_LEVEL_T,
    CI_UNAVAILABLE_INSUFFICIENT_PASSAGES,
    EXCLUDED_FACILITATOR_TURN,
    EXCLUDED_NO_CODE_CONSENSUS,
    EXCLUDED_NO_DECLARED_SCALE,
    MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
    compute_magnitude_rollup,
)
from app.services.participant_resolution import UNRESOLVED_OBSERVATION_CLIP


@pytest.fixture
def world(db_session):
    """A project with three coders, one participant, and nothing coded yet.

    Callers add targets and ratings, so each test states the exact shape it is
    about instead of sharing one over-populated fixture.
    """
    db = db_session
    db.add_all([
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
        User(id=3, username="Coder C", password_hash=None, coder_type="human"),
    ])
    db.add(Project(id=1, name="P", user_id=1))
    db.flush()

    person = Participant(project_id=1, identifier="E-01", display_name="Amara")
    db.add(person)
    db.flush()

    conv = Conversation(project_id=1, name="Interview")
    db.add(conv)
    db.flush()
    speaker = Speaker(project_id=1, name="Amara", participant_id=person.id)
    facilitator = Speaker(project_id=1, name="Interviewer", is_facilitator=1,
                          participant_id=person.id)
    db.add_all([speaker, facilitator])
    db.flush()

    scaled = Code(project_id=1, numeric_id=10, name="Goal quality",
                  magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0)
    other_scale = Code(project_id=1, numeric_id=11, name="Support",
                       magnitude_min=-2.0, magnitude_max=2.0, magnitude_step=1.0)
    unscaled = Code(project_id=1, numeric_id=12, name="Barrier noted")
    universal = Code(project_id=1, numeric_id=1, name="Unclear", is_universal=True)
    db.add_all([scaled, other_scale, unscaled, universal])
    db.flush()

    state = {
        "db": db, "person": person, "conv": conv, "speaker": speaker,
        "facilitator": facilitator, "scaled": scaled, "other_scale": other_scale,
        "unscaled": unscaled, "universal": universal, "seq": 0,
    }

    def turn(*, facilitator_turn=False):
        state["seq"] += 1
        seg = Segment(
            conversation_id=conv.id,
            speaker_id=(facilitator if facilitator_turn else speaker).id,
            sequence_order=state["seq"], text=f"turn {state['seq']}",
        )
        db.add(seg)
        db.flush()
        return seg

    def rate(seg, code, coder_id, magnitude):
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id,
                               user_id=coder_id, magnitude=magnitude))
        db.flush()

    state["turn"] = turn
    state["rate"] = rate
    return state


def _only(rollup):
    assert len(rollup.scores) == 1, rollup.scores
    return rollup.scores[0]


class TestTheTwoSteps:
    def test_median_across_coders_then_mean_across_targets(self, world):
        """🔴 THE DISCRIMINATION FIXTURE. Four plausible implementations give
        four different numbers here, so agreeing with the oracle means the
        arithmetic is right rather than lucky:

            mean of per-target MEDIANS  = (5 + 2 + 1) / 3 = 2.667   ← correct
            median of per-target medians                  = 2
            mean of ALL ratings   = (1+5+5+2+2+1+1) / 7   = 2.4286
            median of ALL ratings                         = 2
        """
        t1, t2, t3 = world["turn"](), world["turn"](), world["turn"]()
        for coder, value in ((1, 1.0), (2, 5.0), (3, 5.0)):
            world["rate"](t1, world["scaled"], coder, value)
        for coder in (1, 2):
            world["rate"](t2, world["scaled"], coder, 2.0)
        for coder in (1, 2):
            world["rate"](t3, world["scaled"], coder, 1.0)

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.target_ratings == (5.0, 2.0, 1.0)
        assert score.mean == pytest.approx(2.6667, abs=5e-4)
        assert score.mean != pytest.approx(2.4286, abs=5e-4)  # not mean-of-all
        assert score.mean != 2.0                              # not either median

    def test_the_score_states_its_basis(self, world):
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 3.0)
        assert _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None)).basis == (
            MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
        )

    def test_an_even_split_keeps_the_half_step(self, world):
        """`_decide_magnitude` does not snap a median to one coder's side, and
        the mean must not round it away either."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["scaled"], 2, 5.0)
        assert _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None)).mean == 4.5


class TestWhoseRatings:
    def test_a_sole_voter_scores(self, world):
        """One coder on a target: no consensus is POSSIBLE, so their judgement
        stands. Without this arm a single-coder project — the common case —
        produces no scores at all."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert _only(rollup).mean == 4.0
        assert rollup.excluded_ratings == {}

    def test_a_minority_application_is_excluded_and_disclosed(self, world):
        """Two coders looked; only one applied the code. The team did not agree
        it applies, so scoring it would quote a judgement they rejected — and
        dropping it silently is what Decision 4 forbids."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["unscaled"], 2, None)  # coder 2 voted, chose differently
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {EXCLUDED_NO_CODE_CONSENSUS: 1}

    def test_a_strict_majority_scores(self, world):
        """Three voters, two applied — `_decide_consensus`'s majority rule, and
        the median is over the two who rated."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["scaled"], 2, 2.0)
        world["rate"](seg, world["unscaled"], 3, None)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.mean == 3.0
        assert score.n_ratings == 2

    def test_the_rule_is_per_target_not_per_project(self, world):
        """A three-coder project still scores a target only one of them touched:
        nobody disagreed there because nobody else looked."""
        shared, solo = world["turn"](), world["turn"]()
        world["rate"](shared, world["scaled"], 1, 2.0)
        world["rate"](shared, world["scaled"], 2, 2.0)
        world["rate"](solo, world["scaled"], 3, 5.0)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert sorted(score.target_ratings) == [2.0, 5.0]


class TestTheNThatMustNotBeHidden:
    def test_two_coders_agreed_and_one_coder_said_so_do_not_look_alike(self, world):
        """A consensus median can rest on ONE rating (`magnitude-coding.md`
        §6c): two coders APPLYING is enough, so a rated/unrated pair still
        produces a median. The score must carry that."""
        thin, thick = world["turn"](), world["turn"]()
        world["rate"](thin, world["scaled"], 1, 4.0)
        world["rate"](thin, world["scaled"], 2, None)   # applied, not rated
        world["rate"](thick, world["scaled"], 1, 2.0)
        world["rate"](thick, world["scaled"], 2, 2.0)

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.n_targets == 2
        assert score.n_ratings == 3          # not 4 — an unrated application is not a rating
        assert score.min_raters_per_target == 1
        assert score.max_raters_per_target == 2

    def test_an_unrated_application_contributes_nothing_not_a_zero(self, world):
        """NULL is UNRATED, never zero (#35 §2). The mean must be over the rated
        target alone, not dragged toward zero by the unrated one."""
        rated, unrated = world["turn"](), world["turn"]()
        world["rate"](rated, world["scaled"], 1, 4.0)
        world["rate"](unrated, world["scaled"], 1, None)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.mean == 4.0 and score.n_targets == 1

    def test_a_rating_of_zero_is_a_rating(self, world):
        """The falsy-zero class: on an interior-zero scale 0 is a real neutral."""
        seg = world["turn"]()
        world["rate"](seg, world["other_scale"], 1, 0.0)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.mean == 0.0 and score.n_ratings == 1

    def test_a_flagged_target_is_counted(self, world):
        """`spread > step` is already decided at step 1; a score built from
        contested passages is weaker evidence and says so."""
        contested, agreed = world["turn"](), world["turn"]()
        world["rate"](contested, world["scaled"], 1, 1.0)
        world["rate"](contested, world["scaled"], 2, 5.0)
        world["rate"](agreed, world["scaled"], 1, 3.0)
        world["rate"](agreed, world["scaled"], 2, 4.0)   # one step — NOT flagged
        assert _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None)).n_flagged_targets == 1


class TestWhatIsExcludedAndDisclosed:
    def test_a_rated_clip_is_excluded_and_disclosed(self, world):
        """Decision 4 and 🔴 the defect the corpus oracle caught: sourcing the
        gather from the consensus WRITER's scope drops an unfrozen observation's
        clips before the rollup sees them, so their ratings vanish with no
        disclosure. `Observation` has no participant link at all."""
        db = world["db"]
        obs = Observation(project_id=1, name="Team huddle")
        db.add(obs)
        db.flush()
        clip = Segment(observation_id=obs.id, sequence_order=0, text="a clip",
                       start_time=1.0, end_time=4.0)
        db.add(clip)
        db.flush()
        world["rate"](clip, world["scaled"], 1, 5.0)
        world["rate"](clip, world["scaled"], 2, 5.0)

        rollup = compute_magnitude_rollup(db, 1, coder_ids=None)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {UNRESOLVED_OBSERVATION_CLIP: 2}

    def test_a_rated_facilitator_turn_is_excluded_and_disclosed(self, world):
        """The link is real — a facilitator may be a participant — but every
        participant count in the codebase excludes their turns, and scoring a
        person on their own prompts is not the measure."""
        seg = world["turn"](facilitator_turn=True)
        world["rate"](seg, world["scaled"], 1, 5.0)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {EXCLUDED_FACILITATOR_TURN: 1}

    def test_a_rating_on_a_scaleless_code_is_excluded_and_disclosed(self, world):
        """Clearing a scale is allowed and KEEPS the ratings (`magnitude.py` §5).
        A number with no declared range is not interpretable, so it scores
        nothing — and the researcher is told, because restoring the scale
        restores the score."""
        seg = world["turn"]()
        world["rate"](seg, world["unscaled"], 1, 3.0)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {EXCLUDED_NO_DECLARED_SCALE: 1}

    def test_an_unlinked_speakers_rating_is_disclosed_by_its_own_reason(self, world):
        """The resolver's five reasons and this module's three merge into ONE
        dict, so a consumer renders one list."""
        db = world["db"]
        stranger = Speaker(project_id=1, name="Unknown voice", participant_id=None)
        db.add(stranger)
        db.flush()
        seg = Segment(conversation_id=world["conv"].id, speaker_id=stranger.id,
                      sequence_order=99, text="who was that")
        db.add(seg)
        db.flush()
        world["rate"](seg, world["scaled"], 1, 4.0)
        rollup = compute_magnitude_rollup(db, 1, coder_ids=None)
        assert rollup.excluded_ratings == {"speaker_unlinked": 1}

    def test_a_merged_away_segments_rating_never_enters(self, world):
        """#500 from the rollup's end. The gather applies
        `visible_segment_filter`, so this asserts the COMPOSITION rather than
        the mechanism — the property survives however the scope is written."""
        kept, merged = world["turn"](), world["turn"]()
        world["rate"](kept, world["scaled"], 1, 2.0)
        world["rate"](merged, world["scaled"], 1, 5.0)
        merged.merged_into_id = kept.id
        world["db"].flush()
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.target_ratings == (2.0,)
        assert score.n_targets == 1

    def test_a_universal_code_is_not_a_vote_and_not_a_score(self, world):
        """Universal codes are refused a scale (§8) and excluded from the voter
        rule, so an "Unclear" mark neither scores nor makes a second voter."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["universal"], 2, None)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert _only(rollup).mean == 4.0        # coder 2 never voted → sole voter
        assert rollup.excluded_ratings == {}


class TestTheIntervalOverPassages:
    """Row 45 (iii). A score's interval is over THIS PERSON's passages and says
    so; below three passages it says why there is none. The oracle corpus has
    three scores at n ≥ 3 (E-01/E-03/E-06 on the goal code) and is checked
    against `EXPECTED_OUTCOMES.md` by hand; the fixtures here isolate the
    properties the corpus cannot separate.
    """

    def test_three_passages_get_a_t_interval_over_the_target_ratings(self, world):
        """Hand arithmetic, independent of `_ci_mean`: medians 5, 2, 1 →
        mean 2.6667, sample sd 2.0817, se 1.2019, t(2) = 4.3027 →
        half-width 5.1712 → [−2.5045, 7.8379]."""
        t1, t2, t3 = world["turn"](), world["turn"](), world["turn"]()
        for coder, value in ((1, 1.0), (2, 5.0), (3, 5.0)):
            world["rate"](t1, world["scaled"], coder, value)
        for coder in (1, 2):
            world["rate"](t2, world["scaled"], coder, 2.0)
        for coder in (1, 2):
            world["rate"](t3, world["scaled"], coder, 1.0)

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.ci_method == CI_METHOD_PASSAGE_LEVEL_T
        assert score.ci_level == 0.95
        assert score.ci_unavailable_reason is None
        assert score.target_sd == pytest.approx(2.0817, abs=5e-4)
        assert score.ci_lower == pytest.approx(-2.5045, abs=5e-4)
        assert score.ci_upper == pytest.approx(7.8379, abs=5e-4)

    def test_the_interval_is_over_the_step_1_medians_not_every_rating(self, world):
        """🔴 THE DISCRIMINATION FIXTURE for the interval. Three passages whose
        coders split (1|5, 3|3, 2|4) all have median 3, so the person's
        passages agree PERFECTLY and the honest interval is zero-width — while
        the six raw ratings have sd 1.41, which would print [1.5, 4.5]. The
        two implementations cannot both pass this."""
        for pair in ((1.0, 5.0), (3.0, 3.0), (2.0, 4.0)):
            seg = world["turn"]()
            world["rate"](seg, world["scaled"], 1, pair[0])
            world["rate"](seg, world["scaled"], 2, pair[1])

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.target_ratings == (3.0, 3.0, 3.0)
        assert score.target_sd == 0.0
        assert (score.ci_lower, score.ci_upper) == (3.0, 3.0)
        assert score.ci_unavailable_reason is None   # a real zero, not "unavailable"

    def test_two_passages_state_why_there_is_no_interval(self, world):
        """The floor is three — `_ci_mean`'s own — and the fixture STRADDLES
        it (n = 2 here, n = 3 above). Below it an SD still exists, the bounds
        are None, and the reason rides beside the method that would apply."""
        for value in (2.0, 4.0):
            world["rate"](world["turn"](), world["scaled"], 1, value)

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.n_targets == 2
        assert score.target_sd == pytest.approx(1.4142, abs=5e-4)
        assert (score.ci_lower, score.ci_upper) == (None, None)
        assert score.ci_unavailable_reason == CI_UNAVAILABLE_INSUFFICIENT_PASSAGES
        assert score.ci_method == CI_METHOD_PASSAGE_LEVEL_T   # stated either way
        assert score.ci_level == 0.95

    def test_one_passage_has_no_sd_and_no_interval(self, world):
        world["rate"](world["turn"](), world["scaled"], 1, 4.0)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.target_sd is None
        assert (score.ci_lower, score.ci_upper) == (None, None)
        assert score.ci_unavailable_reason == CI_UNAVAILABLE_INSUFFICIENT_PASSAGES

    def test_a_sole_coder_gets_the_interval_too(self, world):
        """The interval is over PASSAGES, so it needs no second coder — a
        single-coder project (the default install) must not be the case that
        silently gets none (multicoder.md's one-coder question)."""
        for value in (1.0, 2.0, 3.0, 4.0):
            world["rate"](world["turn"](), world["scaled"], 1, value)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.min_raters_per_target == 1
        assert score.ci_lower is not None and score.ci_upper is not None
        # mean 2.5, sd 1.291, se 0.6455, t(3) = 3.1824 → ±2.0542
        assert score.ci_lower == pytest.approx(0.4458, abs=5e-4)
        assert score.ci_upper == pytest.approx(4.5542, abs=5e-4)

    def test_the_method_is_not_the_respondent_level_one(self):
        """The whole point of a new value: the analysis view will compute a
        `t_interval` over PARTICIPANTS from the same score column, and the
        two must never render alike."""
        from app.services.metrics import CI_METHOD_T_INTERVAL
        assert CI_METHOD_PASSAGE_LEVEL_T != CI_METHOD_T_INTERVAL

    def test_the_floor_is_ci_means_own(self):
        """`_passage_interval` decides `insufficient_passages` ONLY from
        `_ci_mean` returning None. If that floor ever moves, this pins that
        the reason moves with it rather than a second copy of `n < 3`."""
        from app.services.metrics import _ci_mean
        assert _ci_mean(1.0, 1.0, 2) is None
        assert _ci_mean(1.0, 1.0, 3) is not None
        assert mr._passage_interval((1.0, 2.0))["ci_unavailable_reason"] == (
            CI_UNAVAILABLE_INSUFFICIENT_PASSAGES
        )
        assert mr._passage_interval((1.0, 2.0, 3.0))["ci_unavailable_reason"] is None


class TestScalesAreNeverPooled:
    def test_two_codes_are_two_rows_carrying_their_own_instruments(self, world):
        """"Goal quality 1–5" and "Support −2…+2" are different instruments; one
        number over both would average judgements in different units."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["other_scale"], 1, -2.0)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert len(rollup.scores) == 2
        by_code = {s.code_name: s for s in rollup.scores}
        assert by_code["Goal quality"].mean == 4.0
        assert by_code["Goal quality"].scale["min"] == 1.0
        assert by_code["Support"].mean == -2.0
        assert by_code["Support"].scale["min"] == -2.0


class TestAbsenceIsNotZero:
    def test_a_coded_but_unrated_participant_is_named_not_scored(self, world):
        """The oracle's E-07: no score, never a 0 — and a distinct fact from a
        participant with no coding, who is simply absent."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, None)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert rollup.scores == ()
        assert rollup.participants_coded_unrated == frozenset({world["person"].id})

    def test_a_participant_with_no_coding_is_absent_entirely(self, world):
        """The oracle's E-10/E-12."""
        db = world["db"]
        db.add(Participant(project_id=1, identifier="E-10", display_name="Jonas"))
        db.flush()
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 3.0)
        rollup = compute_magnitude_rollup(db, 1, coder_ids=None)
        assert rollup.participants_coded_unrated == frozenset()
        assert {s.participant_id for s in rollup.scores} == {world["person"].id}

    def test_a_scored_participant_is_not_also_reported_unrated(self, world):
        rated, unrated = world["turn"](), world["turn"]()
        world["rate"](rated, world["scaled"], 1, 3.0)
        world["rate"](unrated, world["scaled"], 1, None)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert rollup.participants_coded_unrated == frozenset()


class TestRoutesOtherThanSpeakers:
    def test_a_document_and_a_conversation_pool_into_one_score(self, world):
        """Row 46's payoff, and the oracle's E-01: two routes, one person, one
        score. The document arm has no speaker — a resolver reaching for one
        would report every document segment as unattributed."""
        db = world["db"]
        doc = Document(project_id=1, name="Workplan", source_filename="w.docx",
                       source_format="docx", participant_id=world["person"].id)
        db.add(doc)
        db.flush()
        doc_seg = Segment(document_id=doc.id, sequence_order=0, text="a goal")
        db.add(doc_seg)
        db.flush()
        world["rate"](doc_seg, world["scaled"], 1, 5.0)
        world["rate"](world["turn"](), world["scaled"], 1, 3.0)

        score = _only(compute_magnitude_rollup(db, 1, coder_ids=None))
        assert sorted(score.target_ratings) == [3.0, 5.0]
        assert score.mean == 4.0


class TestTheSharedGather:
    def test_the_segment_scope_has_no_default(self):
        """The signature is what stops a new caller inheriting the writer's
        narrow scope — the defect the oracle caught."""
        import inspect
        param = inspect.signature(gather_target_votes).parameters["segment_scope"]
        assert param.default is inspect.Parameter.empty
        assert param.kind is inspect.Parameter.KEYWORD_ONLY

    def test_an_unknown_scope_fails_closed(self, world):
        with pytest.raises(ValueError, match="unknown segment_scope"):
            gather_target_votes(world["db"], 1, segment_scope="whatever", min_voters=1,
                                group_units=False, coder_ids=None)

    def test_the_two_scopes_differ_exactly_on_unfrozen_clips(self, world):
        """The property that makes the parameter load-bearing rather than
        decorative. A fixture with no observation cannot see it."""
        db = world["db"]
        obs = Observation(project_id=1, name="Huddle")
        db.add(obs)
        db.flush()
        clip = Segment(observation_id=obs.id, sequence_order=0, text="clip",
                       start_time=0.0, end_time=2.0)
        db.add(clip)
        db.flush()
        world["rate"](clip, world["scaled"], 1, 5.0)
        turn = world["turn"]()
        world["rate"](turn, world["scaled"], 1, 3.0)

        def segments(scope):
            votes = gather_target_votes(db, 1, segment_scope=scope, min_voters=1,
                                        group_units=False, coder_ids=None)
            return {b.target_id for b in votes.ballots() if b.kind == "seg"}

        assert segments("consensus_eligible") == {turn.id}
        assert segments("project") == {turn.id, clip.id}


class TestTheStreamedRollup:
    """#958's last step: the rollup reads the gather as a STREAM and resolves
    participants one batch of targets at a time. The batching is the one new
    way to be wrong — a target resolved in the wrong batch is ABSENT from that
    batch's answers, and `_consume` treats an absent route as unreachable and
    drops the target silently. So every arrangement of boundaries must give the
    answer one batch gives."""

    def _mixed_world(self, world):
        from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue

        db, person, scaled = world["db"], world["person"], world["scaled"]
        rate = world["rate"]
        rate(world["turn"](), scaled, 1, 2.0)                       # sole voter
        agreed = world["turn"]()
        rate(agreed, scaled, 1, 4.0)
        rate(agreed, scaled, 2, 5.0)                                # two agree
        split = world["turn"]()
        rate(split, scaled, 1, 1.0)
        rate(split, world["other_scale"], 2, 1.0)                   # no consensus
        rate(world["turn"](facilitator_turn=True), scaled, 1, 5.0)  # facilitator
        obs = Observation(project_id=1, name="Huddle")
        doc = Document(project_id=1, name="Workplan", source_filename="w.docx",
                       source_format="docx", participant_id=person.id)
        ds = Dataset(project_id=1, name="Survey")
        db.add_all([obs, doc, ds])
        db.flush()
        clip = Segment(observation_id=obs.id, sequence_order=0, text="clip",
                       start_time=0.0, end_time=2.0)
        doc_seg = Segment(document_id=doc.id, sequence_order=0, text="a goal")
        column = DatasetColumn(dataset_id=ds.id, column_code="Q", column_name="Q",
                               column_text="Open", column_type="open_text",
                               sequence_order=0, display_order=0)
        row = DatasetRow(dataset_id=ds.id, participant_id=person.id)
        db.add_all([clip, doc_seg, column, row])
        db.flush()
        cell = DatasetValue(row_id=row.id, column_id=column.id, value_text="x")
        db.add(cell)
        db.flush()
        rate(clip, scaled, 1, 3.0)                                  # disclosed
        rate(doc_seg, scaled, 1, 5.0)                               # a second route
        db.add(CodeApplication(dataset_value_id=cell.id, code_id=scaled.id,
                               user_id=1, magnitude=1.0))           # a THIRD route
        db.flush()

    def test_the_batch_size_never_changes_the_answer(self, world, monkeypatch):
        import app.services.consensus as consensus

        db = world["db"]
        self._mixed_world(world)
        whole = compute_magnitude_rollup(db, 1, coder_ids=None)
        # Non-vacuous: all three routes reached the score, and both kinds of
        # disclosure are present, so a dropped target in any arm would show.
        assert sorted(_only(whole).target_ratings) == [1.0, 2.0, 4.5, 5.0]
        assert set(whole.excluded_ratings) == {
            EXCLUDED_NO_CODE_CONSENSUS, EXCLUDED_FACILITATOR_TURN, UNRESOLVED_OBSERVATION_CLIP,
        }
        for size in (1, 2, 3):
            monkeypatch.setattr(mr, "GATHER_STREAM_BATCH", size)
            monkeypatch.setattr(consensus, "GATHER_STREAM_BATCH", size)
            assert compute_magnitude_rollup(db, 1, coder_ids=None) == whole, size


class TestTheVocabularyIsDeclared:
    def test_every_reason_emitted_is_declared(self, world):
        """A consumer renders these; an unknown value renders nothing."""
        from app.services import participant_resolution as pr
        declared = set(mr.EXCLUSION_REASONS) | set(pr.UNRESOLVED_REASONS)
        seg = world["turn"](facilitator_turn=True)
        world["rate"](seg, world["scaled"], 1, 5.0)
        world["rate"](world["turn"](), world["unscaled"], 1, 3.0)
        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert rollup.excluded_ratings          # non-vacuous
        assert set(rollup.excluded_ratings) <= declared

    def test_the_two_vocabularies_do_not_collide(self):
        """They merge into one dict, so a shared string would silently sum two
        different facts into one count."""
        from app.services import participant_resolution as pr
        assert not set(mr.EXCLUSION_REASONS) & set(pr.UNRESOLVED_REASONS)


class TestAGroupIsOnePassage:
    """#1334 — a SegmentGroup's members are coded (and rated) as ONE unit: the
    apply and `_fan_out_rating` reach every visible member. Scoring each member
    counted one judgement once per turn."""

    def _group(self, world, segs):
        from app.models.segment_group import SegmentGroup

        db = world["db"]
        group = SegmentGroup(conversation_id=world["conv"].id)
        db.add(group)
        db.flush()
        for seg in segs:
            seg.group_id = group.id
        db.flush()
        return group

    def test_the_reviews_example(self, world):
        """The filed example: a 4-turn group rated 5 beside three single turns
        rated 2 is 3.714 over 7 passages per turn, and 2.75 over 4 as units."""
        members = [world["turn"]() for _ in range(4)]
        self._group(world, members)
        for seg in members:                       # the apply's fan-out
            world["rate"](seg, world["scaled"], 1, 5.0)
        for _ in range(3):
            world["rate"](world["turn"](), world["scaled"], 1, 2.0)

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.n_targets == 4
        assert score.mean == pytest.approx(2.75)
        assert score.mean != pytest.approx(26 / 7, abs=1e-3)

    def test_a_group_decides_once_with_every_member_as_one_ballot(self, world):
        """B rated ONE member (a door that does not fan out). As a unit, B is a
        voter on the whole group: median(4, 2) = 3 on one passage. Per member
        the group read as one consensus passage (3) and three sole-voter ones (4)."""
        members = [world["turn"]() for _ in range(4)]
        self._group(world, members)
        for seg in members:
            world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](members[2], world["scaled"], 2, 2.0)

        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.target_ratings == (3.0,)
        assert score.min_raters_per_target == 2

    def test_two_different_ratings_from_one_coder_are_no_rating(self, world):
        """A coder whose members disagree gave the unit two answers — not a
        value, and never their mean (`segment_groups.merge_unit_rating`)."""
        members = [world["turn"]() for _ in range(2)]
        self._group(world, members)
        world["rate"](members[0], world["scaled"], 1, 1.0)
        world["rate"](members[1], world["scaled"], 1, 5.0)
        world["rate"](world["turn"](), world["scaled"], 1, 2.0)

        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        score = _only(rollup)
        assert score.target_ratings == (2.0,), "the contradictory group scores nothing"

    def test_a_facilitator_member_is_excluded_once_per_judgement(self, world):
        """The facilitator turn in a group leaves the score (as every facilitator
        turn does) and is DISCLOSED once per coder judgement, not once per turn."""
        prompts = [world["turn"](facilitator_turn=True) for _ in range(3)]
        answer = world["turn"]()
        self._group(world, prompts + [answer])
        for seg in prompts + [answer]:
            world["rate"](seg, world["scaled"], 1, 4.0)

        rollup = compute_magnitude_rollup(world["db"], 1, coder_ids=None)
        assert _only(rollup).target_ratings == (4.0,)
        assert rollup.excluded_ratings == {EXCLUDED_FACILITATOR_TURN: 1}

    def test_ungrouped_turns_are_unchanged(self, world):
        """CONTROL — passes before and after."""
        for value in (5.0, 2.0, 2.0):
            world["rate"](world["turn"](), world["scaled"], 1, value)
        score = _only(compute_magnitude_rollup(world["db"], 1, coder_ids=None))
        assert score.n_targets == 3
        assert score.mean == pytest.approx(3.0)

    def test_a_group_spanning_two_people_is_one_passage_of_each(self, world):
        """A focus-group exchange grouped across two speakers: one passage for
        EACH participant it contains — never one passage shared, never two."""
        db = world["db"]
        ben = Participant(project_id=1, identifier="E-02", display_name="Ben")
        db.add(ben)
        db.flush()
        ben_speaker = Speaker(project_id=1, name="Ben", participant_id=ben.id)
        db.add(ben_speaker)
        db.flush()
        amara_turns = [world["turn"](), world["turn"]()]
        ben_turn = Segment(conversation_id=world["conv"].id, speaker_id=ben_speaker.id,
                           sequence_order=99, text="ben")
        db.add(ben_turn)
        db.flush()
        self._group(world, amara_turns + [ben_turn])
        for seg in amara_turns + [ben_turn]:
            world["rate"](seg, world["scaled"], 1, 4.0)

        rollup = compute_magnitude_rollup(db, 1, coder_ids=None)
        by_person = {s.participant_id: s for s in rollup.scores}
        assert by_person[world["person"].id].n_targets == 1
        assert by_person[ben.id].n_targets == 1


class TestTheNarrowedRollup:
    """D168 (a) — `compute_magnitude_rollup(code_ids=)`, the joint display's rated cells.

    One rated code made a display read every coding in the project: 61–62 s on D12
    (2026-11-12c), 57 s re-measured, against 10.7 s narrowed. Narrowed, the rollup reads
    only the passages holding an asked code — and must give EXACTLY what the whole rollup
    gives for that code. Two halves make it exact, and each can be wrong where the other
    cannot see it:

      * the GATHER keeps each passage's ballot WHOLE (its other codes are its other
        voters) and, for a segment group, every turn of it (the fold is the ballot);
      * the ROLLUP counts nothing but the asked codes.

    So the oracle is the whole rollup itself, through two identities, on a fixture where
    every wrong narrowing moves a number (the comments name the arm each line pins):

      * scores: narrowed({c}) == the whole rollup's scores on c, for every code;
      * disclosure: the narrowed exclusions summed over every code == the whole's.
    """

    def _world(self, world):
        from app.models.code_equivalence_group import CodeEquivalenceGroup
        from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
        from app.models.segment_group import SegmentGroup

        db, conv, rate, turn = world["db"], world["conv"], world["rate"], world["turn"]
        c, d, u = world["scaled"], world["other_scale"], world["unscaled"]

        def person(identifier):
            p = Participant(project_id=1, identifier=identifier, display_name=identifier)
            db.add(p)
            db.flush()
            s = Speaker(project_id=1, name=identifier, participant_id=p.id)
            db.add(s)
            db.flush()
            return p, s

        def said_by(speaker):
            world["seq"] += 1
            seg = Segment(conversation_id=conv.id, speaker_id=speaker.id,
                          sequence_order=world["seq"], text=f"turn {world['seq']}")
            db.add(seg)
            db.flush()
            return seg

        def group(segs):
            g = SegmentGroup(conversation_id=conv.id)
            db.add(g)
            db.flush()
            for seg in segs:
                seg.group_id = g.id
            db.flush()

        ben, ben_s = person("E-02")
        cara, cara_s = person("E-03")
        dee, dee_s = person("E-04")
        eq = CodeEquivalenceGroup(project_id=1, label="Goal quality", canonical_code_id=c.id)
        db.add(eq)
        db.flush()
        sibling = Code(project_id=1, numeric_id=13, name="Goal quality (alt)",
                       code_equivalence_group_id=eq.id)
        c.code_equivalence_group_id = eq.id
        db.add(sibling)
        db.flush()

        rate(turn(), c, 1, 2.0)                                       # a sole voter
        agreed = turn()
        rate(agreed, c, 1, 4.0)
        rate(agreed, c, 2, 5.0)                                       # two agree: 4.5
        split = turn()
        rate(split, c, 1, 1.0)
        rate(split, d, 2, 1.0)            # the passage's OTHER code is its other voter
        g1, g2 = turn(), turn()
        group([g1, g2])
        rate(g1, c, 1, 4.0)
        rate(g2, d, 2, -1.0)              # a turn holding only D is a voter on the group
        both = turn()
        rate(both, c, 1, 3.0)
        rate(both, d, 1, 1.0)             # one passage, two scored codes
        fac = turn(facilitator_turn=True)
        rate(fac, c, 1, 5.0)
        rate(fac, d, 1, 2.0)              # disclosed once per code
        cara_turn, ben_turn = said_by(cara_s), said_by(ben_s)
        group([cara_turn, ben_turn])
        rate(cara_turn, d, 1, 1.0)        # a group spanning two people: Cara holds only D
        rate(ben_turn, c, 1, 4.0)
        rate(said_by(dee_s), sibling, 1, None)   # holds C through its sibling, unrated
        rate(turn(), u, 1, 3.0)                  # a rating with no declared scale
        obs = Observation(project_id=1, name="Huddle")
        ds = Dataset(project_id=1, name="Survey")
        db.add_all([obs, ds])
        db.flush()
        clip = Segment(observation_id=obs.id, sequence_order=0, text="clip",
                       start_time=0.0, end_time=2.0)
        column = DatasetColumn(dataset_id=ds.id, column_code="Q", column_name="Q",
                               column_text="Open", column_type="open_text",
                               sequence_order=0, display_order=0)
        row = DatasetRow(dataset_id=ds.id, participant_id=world["person"].id)
        db.add_all([clip, column, row])
        db.flush()
        cell = DatasetValue(row_id=row.id, column_id=column.id, value_text="x")
        db.add(cell)
        db.flush()
        rate(clip, c, 1, 3.0)                                         # disclosed: a clip
        db.add(CodeApplication(dataset_value_id=cell.id, code_id=c.id, user_id=1,
                               magnitude=1.0))                        # a third route
        db.flush()
        return {"c": c, "d": d, "u": u, "sibling": sibling, "ben": ben, "cara": cara,
                "dee": dee}

    @staticmethod
    def _effective_codes(db):
        from app.services.coding_layers import build_effective_code_map
        effective = build_effective_code_map(db, 1)
        return sorted({effective.get(cid, cid) for (cid,) in db.query(Code.id)})

    def test_each_codes_scores_and_disclosure_are_the_whole_rollups(self, world):
        from collections import Counter

        db = world["db"]
        w = self._world(world)
        whole = compute_magnitude_rollup(db, 1, coder_ids=None)
        # Non-vacuous, hand-derived: two codes scored for three people, four reasons.
        amara = world["person"].id
        assert {(s.participant_id, s.code_id): s.target_ratings for s in whole.scores} == {
            (amara, w["c"].id): (2.0, 4.5, 3.0, 1.0),
            (amara, w["d"].id): (1.0,),
            (w["ben"].id, w["c"].id): (4.0,),
            (w["cara"].id, w["d"].id): (1.0,),
        }
        assert whole.excluded_ratings == {
            EXCLUDED_NO_CODE_CONSENSUS: 4, EXCLUDED_FACILITATOR_TURN: 2,
            EXCLUDED_NO_DECLARED_SCALE: 1, UNRESOLVED_OBSERVATION_CLIP: 1,
        }

        disclosed = Counter()
        codes = self._effective_codes(db)
        assert len(codes) >= 4
        for code in codes:
            part = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=[code])
            assert part.scores == tuple(s for s in whole.scores if s.code_id == code), code
            disclosed.update(part.excluded_ratings)
        assert dict(disclosed) == whole.excluded_ratings

    def test_several_codes_at_once(self, world):
        db = world["db"]
        w = self._world(world)
        whole = compute_magnitude_rollup(db, 1, coder_ids=None)
        asked = {w["c"].id, w["d"].id}
        part = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=sorted(asked))
        assert part.scores == tuple(s for s in whole.scores if s.code_id in asked)
        assert part.excluded_ratings == {
            EXCLUDED_NO_CODE_CONSENSUS: 4, EXCLUDED_FACILITATOR_TURN: 2,
            UNRESOLVED_OBSERVATION_CLIP: 1,
        }

    def test_a_passage_holding_the_code_through_its_sibling_reaches_its_person(self, world):
        """Dee's only passage carries C's equivalence-group sibling, unrated: the whole
        rollup names her coded-but-unrated, so the narrowed one must reach her too — a
        ballot holds EFFECTIVE codes, so the narrowing reads the sibling's rows."""
        db = world["db"]
        w = self._world(world)
        part = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=[w["c"].id])
        assert part.participants_coded_unrated == frozenset({w["dee"].id})
        assert compute_magnitude_rollup(db, 1, coder_ids=None).participants_coded_unrated == (
            frozenset({w["dee"].id}))

    def test_a_person_whose_turn_in_a_group_holds_none_of_the_codes_is_not_reached(self, world):
        """Cara and Ben share a group: it is gathered whole for Ben's C, so Cara's fold —
        D only — reaches the rollup too. She was coded, but not with C."""
        db = world["db"]
        w = self._world(world)
        part = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=[w["c"].id])
        assert w["cara"].id not in part.participants_coded_unrated
        assert w["cara"].id not in {s.participant_id for s in part.scores}

    def test_a_siblings_id_asks_for_its_canonical_code(self, world):
        db = world["db"]
        w = self._world(world)
        by_sibling = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=[w["sibling"].id])
        by_canonical = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=[w["c"].id])
        assert by_sibling == by_canonical
        assert by_sibling.scores                      # non-vacuous

    def test_no_codes_asks_for_nothing(self, world):
        """An empty list is NONE of the codes, never every code (#1297's reading)."""
        db = world["db"]
        self._world(world)
        part = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=[])
        assert part.scores == () and part.excluded_ratings == {}
        assert part.participants_coded_unrated == frozenset()

    def test_the_writers_form_refuses_a_narrowing(self, world):
        """The writer decides every target; its group arm is not narrowed, so a narrowed
        writer would decide a group from part of its votes."""
        db = world["db"]
        with pytest.raises(ValueError, match="per-turn stream only"):
            gather_target_votes(db, 1, segment_scope="project", min_voters=1,
                                group_units=True, coder_ids=None,
                                target_codes=[world["scaled"].id])
        gather_target_votes(db, 1, segment_scope="project", min_voters=1,  # control
                            group_units=True, coder_ids=None, target_codes=None)

    # ── The cost, in SQLite's own work (the #1021 technique) ─────────────────────

    @staticmethod
    def _passages(world, n):
        """``n`` turns and ``n`` survey answers, under the same ids — the stream has a
        segment arm and a value arm, and each is narrowed on its own."""
        from sqlalchemy import insert

        from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue

        db, conv, speaker = world["db"], world["conv"], world["speaker"]
        first = 10_000 + world["seq"] + 1
        ids = list(range(first, first + n))
        world["seq"] += n
        db.execute(insert(Segment.__table__), [
            {"id": i, "conversation_id": conv.id, "speaker_id": speaker.id,
             "sequence_order": i, "text": "x"} for i in ids
        ])
        ds = Dataset(project_id=1, name=f"Survey {first}")
        db.add(ds)
        db.flush()
        column = DatasetColumn(dataset_id=ds.id, column_code="Q", column_name="Q",
                               column_text="Open", column_type="open_text",
                               sequence_order=0, display_order=0)
        db.add(column)
        db.flush()
        db.execute(insert(DatasetRow.__table__), [{"id": i, "dataset_id": ds.id} for i in ids])
        db.execute(insert(DatasetValue.__table__), [
            {"id": i, "row_id": i, "column_id": column.id, "value_text": "x"} for i in ids
        ])
        db.flush()
        return ids

    @staticmethod
    def _code_every_passage(world, ids, n_codes):
        """``n_codes`` more codes, each applied to every turn AND answer of ``ids`` by all
        three coders — more CODINGS on the same passages."""
        from sqlalchemy import insert

        db = world["db"]
        made = world.setdefault("other_codes", 0)
        codes = [Code(project_id=1, numeric_id=100 + made + k, name=f"Other {made + k}")
                 for k in range(n_codes)]
        world["other_codes"] = made + n_codes
        db.add_all(codes)
        db.flush()
        for target in ("segment_id", "dataset_value_id"):  # one key set per executemany
            db.execute(insert(CodeApplication.__table__), [
                {target: i, "code_id": code.id, "user_id": coder}
                for i in ids for code in codes for coder in (1, 2, 3)
            ])
        db.flush()

    @staticmethod
    def _work(db, code_ids):
        conn = db.connection().connection.driver_connection
        ticks = [0]

        def tick():
            ticks[0] += 1
            return 0

        conn.set_progress_handler(tick, 100)
        try:
            rollup = compute_magnitude_rollup(db, 1, coder_ids=None, code_ids=code_ids)
        finally:
            conn.set_progress_handler(None, 100)
        return rollup, ticks[0]

    def test_the_cost_follows_the_asked_codes_not_the_projects_codings(self, world):
        """Ten times the OTHER coding must not cost the narrowed rollup twice its work.
        Counted by SQLite's progress handler, so a machine's speed cannot pass or fail
        it — and paired with the whole rollup's work on the same two sizes, which must
        grow, or the fixture could not have told a narrowed read from a full one.

        ⚠️ The growth is in CODINGS on the same passages, not in passages. The rollup's
        group-membership read (`group_of`) walks every segment of the project whatever
        is asked — measured 2026-11-12d: 0.22–0.27 s over D12's 1.2M segments, a
        residual left as it was — so more TURNS would grow it and fail this for a cost
        D168 did not take on."""
        db, scaled = world["db"], world["scaled"]
        for value in (1.0, 2.0, 3.0, 4.0, 5.0):
            world["rate"](world["turn"](), scaled, 1, value)
        ids = self._passages(world, 200)
        self._code_every_passage(world, ids, 1)     # 1,200 other codings, half on answers
        small, small_work = self._work(db, [scaled.id])
        _, small_whole = self._work(db, None)
        self._code_every_passage(world, ids, 9)     # 12,000
        large, large_work = self._work(db, [scaled.id])
        _, large_whole = self._work(db, None)

        assert small == large and _only(large).n_targets == 5   # it answered, unmoved
        assert large_whole > 5 * small_whole, (small_whole, large_whole)  # discrimination
        assert large_work < 2 * small_work, (small_work, large_work)
