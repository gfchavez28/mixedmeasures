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

        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.target_ratings == (5.0, 2.0, 1.0)
        assert score.mean == pytest.approx(2.6667, abs=5e-4)
        assert score.mean != pytest.approx(2.4286, abs=5e-4)  # not mean-of-all
        assert score.mean != 2.0                              # not either median

    def test_the_score_states_its_basis(self, world):
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 3.0)
        assert _only(compute_magnitude_rollup(world["db"], 1)).basis == (
            MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
        )

    def test_an_even_split_keeps_the_half_step(self, world):
        """`_decide_magnitude` does not snap a median to one coder's side, and
        the mean must not round it away either."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["scaled"], 2, 5.0)
        assert _only(compute_magnitude_rollup(world["db"], 1)).mean == 4.5


class TestWhoseRatings:
    def test_a_sole_voter_scores(self, world):
        """One coder on a target: no consensus is POSSIBLE, so their judgement
        stands. Without this arm a single-coder project — the common case —
        produces no scores at all."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        rollup = compute_magnitude_rollup(world["db"], 1)
        assert _only(rollup).mean == 4.0
        assert rollup.excluded_ratings == {}

    def test_a_minority_application_is_excluded_and_disclosed(self, world):
        """Two coders looked; only one applied the code. The team did not agree
        it applies, so scoring it would quote a judgement they rejected — and
        dropping it silently is what Decision 4 forbids."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["unscaled"], 2, None)  # coder 2 voted, chose differently
        rollup = compute_magnitude_rollup(world["db"], 1)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {EXCLUDED_NO_CODE_CONSENSUS: 1}

    def test_a_strict_majority_scores(self, world):
        """Three voters, two applied — `_decide_consensus`'s majority rule, and
        the median is over the two who rated."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["scaled"], 2, 2.0)
        world["rate"](seg, world["unscaled"], 3, None)
        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.mean == 3.0
        assert score.n_ratings == 2

    def test_the_rule_is_per_target_not_per_project(self, world):
        """A three-coder project still scores a target only one of them touched:
        nobody disagreed there because nobody else looked."""
        shared, solo = world["turn"](), world["turn"]()
        world["rate"](shared, world["scaled"], 1, 2.0)
        world["rate"](shared, world["scaled"], 2, 2.0)
        world["rate"](solo, world["scaled"], 3, 5.0)
        score = _only(compute_magnitude_rollup(world["db"], 1))
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

        score = _only(compute_magnitude_rollup(world["db"], 1))
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
        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.mean == 4.0 and score.n_targets == 1

    def test_a_rating_of_zero_is_a_rating(self, world):
        """The falsy-zero class: on an interior-zero scale 0 is a real neutral."""
        seg = world["turn"]()
        world["rate"](seg, world["other_scale"], 1, 0.0)
        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.mean == 0.0 and score.n_ratings == 1

    def test_a_flagged_target_is_counted(self, world):
        """`spread > step` is already decided at step 1; a score built from
        contested passages is weaker evidence and says so."""
        contested, agreed = world["turn"](), world["turn"]()
        world["rate"](contested, world["scaled"], 1, 1.0)
        world["rate"](contested, world["scaled"], 2, 5.0)
        world["rate"](agreed, world["scaled"], 1, 3.0)
        world["rate"](agreed, world["scaled"], 2, 4.0)   # one step — NOT flagged
        assert _only(compute_magnitude_rollup(world["db"], 1)).n_flagged_targets == 1


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

        rollup = compute_magnitude_rollup(db, 1)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {UNRESOLVED_OBSERVATION_CLIP: 2}

    def test_a_rated_facilitator_turn_is_excluded_and_disclosed(self, world):
        """The link is real — a facilitator may be a participant — but every
        participant count in the codebase excludes their turns, and scoring a
        person on their own prompts is not the measure."""
        seg = world["turn"](facilitator_turn=True)
        world["rate"](seg, world["scaled"], 1, 5.0)
        rollup = compute_magnitude_rollup(world["db"], 1)
        assert rollup.scores == ()
        assert rollup.excluded_ratings == {EXCLUDED_FACILITATOR_TURN: 1}

    def test_a_rating_on_a_scaleless_code_is_excluded_and_disclosed(self, world):
        """Clearing a scale is allowed and KEEPS the ratings (`magnitude.py` §5).
        A number with no declared range is not interpretable, so it scores
        nothing — and the researcher is told, because restoring the scale
        restores the score."""
        seg = world["turn"]()
        world["rate"](seg, world["unscaled"], 1, 3.0)
        rollup = compute_magnitude_rollup(world["db"], 1)
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
        rollup = compute_magnitude_rollup(db, 1)
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
        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.target_ratings == (2.0,)
        assert score.n_targets == 1

    def test_a_universal_code_is_not_a_vote_and_not_a_score(self, world):
        """Universal codes are refused a scale (§8) and excluded from the voter
        rule, so an "Unclear" mark neither scores nor makes a second voter."""
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 4.0)
        world["rate"](seg, world["universal"], 2, None)
        rollup = compute_magnitude_rollup(world["db"], 1)
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

        score = _only(compute_magnitude_rollup(world["db"], 1))
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

        score = _only(compute_magnitude_rollup(world["db"], 1))
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

        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.n_targets == 2
        assert score.target_sd == pytest.approx(1.4142, abs=5e-4)
        assert (score.ci_lower, score.ci_upper) == (None, None)
        assert score.ci_unavailable_reason == CI_UNAVAILABLE_INSUFFICIENT_PASSAGES
        assert score.ci_method == CI_METHOD_PASSAGE_LEVEL_T   # stated either way
        assert score.ci_level == 0.95

    def test_one_passage_has_no_sd_and_no_interval(self, world):
        world["rate"](world["turn"](), world["scaled"], 1, 4.0)
        score = _only(compute_magnitude_rollup(world["db"], 1))
        assert score.target_sd is None
        assert (score.ci_lower, score.ci_upper) == (None, None)
        assert score.ci_unavailable_reason == CI_UNAVAILABLE_INSUFFICIENT_PASSAGES

    def test_a_sole_coder_gets_the_interval_too(self, world):
        """The interval is over PASSAGES, so it needs no second coder — a
        single-coder project (the default install) must not be the case that
        silently gets none (multicoder.md's one-coder question)."""
        for value in (1.0, 2.0, 3.0, 4.0):
            world["rate"](world["turn"](), world["scaled"], 1, value)
        score = _only(compute_magnitude_rollup(world["db"], 1))
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
        rollup = compute_magnitude_rollup(world["db"], 1)
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
        rollup = compute_magnitude_rollup(world["db"], 1)
        assert rollup.scores == ()
        assert rollup.participants_coded_unrated == frozenset({world["person"].id})

    def test_a_participant_with_no_coding_is_absent_entirely(self, world):
        """The oracle's E-10/E-12."""
        db = world["db"]
        db.add(Participant(project_id=1, identifier="E-10", display_name="Jonas"))
        db.flush()
        seg = world["turn"]()
        world["rate"](seg, world["scaled"], 1, 3.0)
        rollup = compute_magnitude_rollup(db, 1)
        assert rollup.participants_coded_unrated == frozenset()
        assert {s.participant_id for s in rollup.scores} == {world["person"].id}

    def test_a_scored_participant_is_not_also_reported_unrated(self, world):
        rated, unrated = world["turn"](), world["turn"]()
        world["rate"](rated, world["scaled"], 1, 3.0)
        world["rate"](unrated, world["scaled"], 1, None)
        rollup = compute_magnitude_rollup(world["db"], 1)
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

        score = _only(compute_magnitude_rollup(db, 1))
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
            gather_target_votes(world["db"], 1, segment_scope="whatever")

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

        writer = gather_target_votes(db, 1, segment_scope="consensus_eligible")
        discloser = gather_target_votes(db, 1, segment_scope="project")
        assert set(writer.seg_buckets) == {turn.id}
        assert set(discloser.seg_buckets) == {turn.id, clip.id}


class TestTheVocabularyIsDeclared:
    def test_every_reason_emitted_is_declared(self, world):
        """A consumer renders these; an unknown value renders nothing."""
        from app.services import participant_resolution as pr
        declared = set(mr.EXCLUSION_REASONS) | set(pr.UNRESOLVED_REASONS)
        seg = world["turn"](facilitator_turn=True)
        world["rate"](seg, world["scaled"], 1, 5.0)
        world["rate"](world["turn"](), world["unscaled"], 1, 3.0)
        rollup = compute_magnitude_rollup(world["db"], 1)
        assert rollup.excluded_ratings          # non-vacuous
        assert set(rollup.excluded_ratings) <= declared

    def test_the_two_vocabularies_do_not_collide(self):
        """They merge into one dict, so a shared string would silently sum two
        different facts into one count."""
        from app.services import participant_resolution as pr
        assert not set(mr.EXCLUSION_REASONS) & set(pr.UNRESOLVED_REASONS)
