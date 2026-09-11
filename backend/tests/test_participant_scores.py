"""Row 45 (i) step 4 — rating scores as ordinary dataset variables.

What has to be pinned here, and why each is not obvious:

  * **The score is a real `DatasetColumn` with real cells.** That IS the feature —
    Option C was chosen over a virtual column precisely so every consumer works
    untouched, and a service that computes a number nobody stores delivers none
    of it.
  * **TWO columns per rated code.** The *n* is a variable, not prose (#693: the
    n is the dangerous half). A suite that checked only the mean would pass on a
    build where 3.643-over-one-passage and 3.643-over-eight are the same cell.
  * **NULL is never zero, and no cell is not a zero cell.**
  * **The column set is the codes that DECLARE A SCALE**, so it does not change
    shape as coding proceeds — and a code whose scale is merely CLEARED keeps its
    columns while a DELETED one has them reaped.
  * **The freshness pair is asymmetric on purpose.** The marker is ungated, so a
    single-coder project gets it; and nothing anywhere claims a score is current.
"""

import pytest
from fastapi import HTTPException

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.equivalence_group import EquivalenceGroup
from app.models.metric import MetricDefinition
from app.models.participant import Participant
from app.models.project import Project
from app.models.statistical_test import StatisticalTest
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.services import magnitude
from app.services import participant_scores as ps
from app.services.magnitude_rollup import MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
from app.services.column_cleanup import delete_column_references
from app.services.participant_dataset import (
    MANAGED_COLUMN_SOURCE,
    create_participant_dataset,
    get_participant_dataset,
)


@pytest.fixture
def world(db_session):
    """One project, three participants, one scaled code, one conversation.

    Deliberately SINGLE-CODER: that is the default install, it is the case the
    multi-coder machinery does not serve, and it is the one a suite written
    around consensus fixtures never reaches.
    """
    db = db_session
    db.add(Project(id=1, name="PD audit", user_id=1))
    db.flush()

    people = {}
    for ident in ("E-01", "E-02", "E-03"):
        p = Participant(project_id=1, identifier=ident)
        db.add(p)
        db.flush()
        people[ident] = p

    conv = Conversation(project_id=1, name="Interviews")
    db.add(conv)
    db.flush()

    speakers = {}
    for ident, person in people.items():
        sp = Speaker(project_id=1, name=ident, participant_id=person.id)
        db.add(sp)
        db.flush()
        speakers[ident] = sp

    # Interior zero on purpose (-2..+2): a falsy-zero slip is only observable
    # when zero is a real, meaningful value rather than the floor (#35 §2).
    code = Code(project_id=1, numeric_id=10, name="Supervisor support",
                magnitude_min=-2.0, magnitude_max=2.0, magnitude_step=1.0)
    db.add(code)
    db.flush()

    state = {"db": db, "people": people, "speakers": speakers,
             "code": code, "conv": conv, "seq": 0}

    def rate(ident, value, code_obj=None):
        state["seq"] += 1
        seg = Segment(conversation_id=conv.id, speaker_id=speakers[ident].id,
                      sequence_order=state["seq"], text=f"turn {state['seq']}")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=(code_obj or code).id,
                               user_id=1, magnitude=value))
        db.flush()
        return seg

    state["rate"] = rate
    return state


def _columns(db, dataset):
    return (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == dataset.id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )


def _cells(db, dataset, kind):
    """`{participant identifier: value_numeric}` for the column of this kind."""
    column = next(
        c for c in _columns(db, dataset)
        if (ps.parse_managed_spec(c.managed_spec) or {}).get("kind") == kind
    )
    rows = {
        r.id: r.row_identifier
        for r in db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id)
    }
    return {
        rows[v.row_id]: v.value_numeric
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == column.id)
    }


class TestTheScoreBecomesAVariable:
    def test_the_mean_lands_in_a_real_cell(self, world):
        """The whole point of Option C: the score IS a `DatasetColumn` value, so
        every picker, comparison, chart and export works with no change."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        world["rate"]("E-01", 1.0)
        world["rate"]("E-02", -1.0)
        create_participant_dataset(db, 1)

        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        assert _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE) == {
            "E-01": 1.5, "E-02": -1.0,
        }

    def test_the_n_is_its_OWN_variable(self, world):
        """🔴 #693 — the *n* is the dangerous half. A mean of 1.5 over two
        passages and over one are the same number and NOT the same evidence, and
        a `DatasetValue` holds only the number, so the count has to be a second
        variable or it is lost."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        world["rate"]("E-01", 1.0)
        world["rate"]("E-02", 1.5)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        scores = _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE)
        counts = _cells(db, dataset, ps.MANAGED_SPEC_KIND_RATED_TARGETS)
        # Same score, different evidence — and the table SAYS so.
        assert scores["E-01"] == scores["E-02"] == 1.5
        assert counts == {"E-01": 2.0, "E-02": 1.0}

    def test_a_rating_of_ZERO_is_a_score_and_not_an_absence(self, world):
        """The interior-zero fixture earns its keep here: a truthiness slip
        anywhere in the write path renders a real neutral as no cell at all."""
        db = world["db"]
        world["rate"]("E-01", 0.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        assert _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE) == {"E-01": 0.0}

    def test_an_unscored_participant_gets_NO_cell_rather_than_a_zero(self, world):
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        cells = _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE)
        assert "E-02" not in cells and "E-03" not in cells
        # ...and the ROW still exists — the person is in the table, their score
        # is simply not known.
        assert db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).count() == 3

    def test_the_columns_are_numeric_and_axed_to_the_DECLARED_scale(self, world):
        """A chart of scores on a -2..+2 instrument should show the instrument,
        not whatever range this corpus happens to span."""
        db = world["db"]
        world["rate"]("E-01", 1.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        score_col = next(
            c for c in _columns(db, dataset)
            if (ps.parse_managed_spec(c.managed_spec) or {}).get("kind")
            == ps.MANAGED_SPEC_KIND_SCORE
        )
        assert score_col.column_type == ColumnType.NUMERIC
        assert (score_col.numeric_min, score_col.numeric_max) == (-2.0, 2.0)

    def test_the_score_column_states_its_basis(self, world):
        """The eleventh stated-basis member: the server says HOW the number was
        made, per column, so a future variant is a new value rather than a silent
        change of meaning under an unchanged heading."""
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        spec = next(
            ps.parse_managed_spec(c.managed_spec) for c in _columns(db, dataset)
            if (ps.parse_managed_spec(c.managed_spec) or {}).get("kind")
            == ps.MANAGED_SPEC_KIND_SCORE
        )
        assert spec["basis"] == MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS
        assert spec["code_id"] == world["code"].id


class TestTheColumnSet:
    def test_a_scaled_code_gets_columns_even_before_anyone_rates(self, world):
        """The set is the codes that DECLARE a scale, not the codes that scored.

        Deriving it from who happens to have a score would make columns appear
        and vanish as coding proceeds, so a saved chart could lose a variable it
        referenced between two readings.
        """
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        kinds = {
            (ps.parse_managed_spec(c.managed_spec) or {}).get("kind")
            for c in _columns(db, dataset)
        }
        assert ps.MANAGED_SPEC_KIND_SCORE in kinds
        assert ps.MANAGED_SPEC_KIND_RATED_TARGETS in kinds

    def test_an_UNSCALED_code_gets_none(self, world):
        db = world["db"]
        db.add(Code(project_id=1, numeric_id=11, name="Barrier noted"))
        db.flush()
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        code_ids = {
            (ps.parse_managed_spec(c.managed_spec) or {}).get("code_id")
            for c in _columns(db, dataset)
        }
        assert code_ids == {None, world["code"].id}

    def test_CLEARING_a_scale_keeps_the_columns_and_nulls_them(self, world):
        """⚠️ Clearing is RECOVERABLE (`magnitude-coding.md` §5 — the ratings
        survive, uninterpretable until a scale returns). Destroying the variable
        would not be, so the column stays and simply stops having a value."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        assert _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE) == {"E-01": 2.0}

        magnitude.write_scale(world["code"], None)
        db.flush()
        ps.refresh_participant_dataset(db, 1)

        assert _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE) == {}
        assert len(_columns(db, dataset)) == 3  # identifier + score + n

    def test_a_DELETED_code_has_its_columns_reaped(self, world):
        """🔴 Step 3's own lesson, reached from the column side: a managed column
        is read-only through the three `source != "manual"` gates, so a column
        nothing can ever recompute would be permanently undeletable."""
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        assert len(_columns(db, dataset)) == 3

        db.delete(world["code"])
        db.flush()
        report = ps.refresh_participant_dataset(db, 1)

        assert report.columns_removed == 2
        assert len(_columns(db, dataset)) == 1  # the identifier survives

    def test_the_tool_columns_carry_the_managed_source(self, world):
        """The structural claim step 3 rests on: `source = "managed"` makes these
        read-only through gates that already exist, so no new guard is written."""
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        assert {c.source for c in _columns(db, dataset)} == {MANAGED_COLUMN_SOURCE}


class TestIdempotenceAndReconcile:
    def test_refreshing_twice_changes_nothing_the_second_time(self, world):
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        second = ps.refresh_participant_dataset(db, 1)
        assert (second.rows_added, second.rows_removed) == (0, 0)
        assert (second.columns_added, second.columns_removed) == (0, 0)
        assert (second.cells_written, second.cells_cleared) == (0, 0)

    def test_a_score_that_goes_away_CLEARS_its_cell_rather_than_zeroing_it(self, world):
        db = world["db"]
        seg = world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        assert _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE) == {"E-01": 2.0}

        db.query(CodeApplication).filter(
            CodeApplication.segment_id == seg.id).delete()
        db.flush()
        report = ps.refresh_participant_dataset(db, 1)

        assert report.cells_cleared == 2  # the score and its n
        assert _cells(db, dataset, ps.MANAGED_SPEC_KIND_SCORE) == {}

    def test_a_new_participant_gets_a_row_on_refresh(self, world):
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        db.add(Participant(project_id=1, identifier="E-04"))
        db.flush()
        report = ps.refresh_participant_dataset(db, 1)

        assert report.rows_added == 1

    def test_refresh_on_a_project_with_no_participant_table_is_None(self, world):
        """Not an error — the endpoint turns it into a 404 with instructions, and
        the service stays callable from anywhere without a pre-check."""
        assert ps.refresh_participant_dataset(world["db"], 1) is None


class TestTheDisclosureReachesTheReport:
    def test_a_facilitators_own_rating_is_excluded_AND_reported(self, world):
        """Decision 4: the rollup must SAY what it left out. A count that reaches
        no surface discharges nothing, so the report carries it."""
        db = world["db"]
        facilitator = Speaker(project_id=1, name="Interviewer", is_facilitator=1,
                              participant_id=world["people"]["E-01"].id)
        db.add(facilitator)
        db.flush()
        seg = Segment(conversation_id=world["conv"].id, speaker_id=facilitator.id,
                      sequence_order=99, text="facilitator turn")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=world["code"].id,
                               user_id=1, magnitude=2.0))
        db.flush()
        create_participant_dataset(db, 1)

        report = ps.refresh_participant_dataset(db, 1)

        assert report.excluded_ratings.get("facilitator_turn") == 1
        assert report.participants_scored == 0

    def test_coded_but_unrated_is_a_THIRD_state_and_is_counted(self, world):
        """Distinct from "not coded", who is simply absent — and in the table
        both are an empty cell, so the report is the only place the difference
        survives."""
        db = world["db"]
        seg = Segment(conversation_id=world["conv"].id,
                      speaker_id=world["speakers"]["E-01"].id,
                      sequence_order=1, text="coded, never rated")
        db.add(seg)
        db.flush()
        db.add(CodeApplication(segment_id=seg.id, code_id=world["code"].id,
                               user_id=1, magnitude=None))
        db.flush()
        create_participant_dataset(db, 1)

        report = ps.refresh_participant_dataset(db, 1)

        assert report.participants_coded_unrated == 1
        assert report.participants_scored == 0


class TestFreshness:
    def test_a_refresh_stamps_the_time_and_clears_the_flag(self, world):
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.mark_participant_scores_stale(db, 1)
        dataset = get_participant_dataset(db, 1)
        assert dataset.managed_stale is True

        ps.refresh_participant_dataset(db, 1)

        assert dataset.managed_stale is False
        assert dataset.managed_synced_at is not None

    def test_the_marker_is_UNGATED_so_a_single_coder_project_gets_it(self, world):
        """🔴 The trap the ROADMAP named, asserted rather than assumed.

        `_mark_segment_consensus_stale` returns early when `consensus_enabled` is
        false — correct for consensus, meaningless with one voter — and this
        fixture has exactly ONE coder. If the score marker were reusing that
        gate, the default install would hold a score that is never marked out of
        date.
        """
        from app.services.consensus import consensus_enabled
        db = world["db"]
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        assert consensus_enabled(db) is False  # the precondition IS the point

        assert ps.mark_participant_scores_stale(db, 1) is True
        assert get_participant_dataset(db, 1).managed_stale is True

    def test_marking_with_no_project_scope_reaches_every_project(self, world):
        """The archiving-a-coder path: a `User` is instance-global and an
        archived coder does not vote, so it moves scores in every project."""
        db = world["db"]
        db.add(Project(id=2, name="Other", user_id=1))
        db.flush()
        create_participant_dataset(db, 1)
        create_participant_dataset(db, 2)
        ps.refresh_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 2)

        ps.mark_participant_scores_stale(db)

        stale = {
            d.project_id: d.managed_stale
            for d in db.query(Dataset).filter(Dataset.managed_kind.isnot(None))
        }
        assert stale == {1: True, 2: True}

    def test_an_ordinary_project_with_no_managed_table_reports_nothing_marked(self, world):
        assert ps.mark_participant_scores_stale(world["db"], 1) is False


class TestNumberFormatting:
    @pytest.mark.parametrize("value,expected", [
        (7.0, "7"), (0.0, "0"), (-2.0, "-2"), (7.4, "7"),
    ])
    def test_a_COUNT_has_no_decimal_and_negatives_use_a_hyphen(self, value, expected):
        """A DATA cell, not a chip: this string is read by the CSV export, the
        Excel export and `_compute_value_numeric` on any re-import, so it takes a
        plain hyphen rather than the U+2212 the rating chips use."""
        assert ps._format_number(value, decimals=0) == expected

    @pytest.mark.parametrize("value,expected", [
        (1.5, "1.500"), (3.643, "3.643"), (-0.5, "-0.500"), (2.0, "2.000"),
    ])
    def test_a_SCORE_keeps_a_FIXED_number_of_places(self, value, expected):
        """#942 — it used to strip trailing zeros, so a column read
        `3.643 / 1.25 / 4.167 / 2` with nothing aligned and a whole number looking
        like a different kind of value. Padding is a DISPLAY fix: the stored
        number is unchanged, which is why this is not the harder rounding the
        entry warned against."""
        assert ps._format_number(value, decimals=ps._SCORE_DP) == expected

    def test_the_padded_text_still_PARSES_to_the_stored_number(self):
        """The invariant the padding must not break: `"2.000"` and `2.0` are the
        same value, so an export and a chart cannot disagree about the cell."""
        assert float(ps._format_number(2.0, decimals=ps._SCORE_DP)) == 2.0

    def test_a_score_column_and_an_n_column_are_formatted_DIFFERENTLY(self, world):
        """The whole point of passing the decision in: one formatter, two
        answers, decided by what the column HOLDS."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        world["rate"]("E-01", 1.0)
        world["rate"]("E-01", 1.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        texts = {}
        for column in _columns(db, dataset):
            spec = ps.parse_managed_spec(column.managed_spec)
            if spec is None:
                continue
            cell = db.query(DatasetValue).filter(
                DatasetValue.column_id == column.id).one()
            texts[spec["kind"]] = cell.value_text

        assert texts[ps.MANAGED_SPEC_KIND_SCORE] == "1.333"
        assert texts[ps.MANAGED_SPEC_KIND_RATED_TARGETS] == "3", "a count, not 3.000"

    def test_the_text_and_the_number_agree(self, world):
        """A text/numeric pair that disagree is how an export and a chart come to
        show different values for one cell."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        world["rate"]("E-01", 1.0)
        world["rate"]("E-01", 1.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)

        dataset = get_participant_dataset(db, 1)
        column = next(
            c for c in _columns(db, dataset)
            if (ps.parse_managed_spec(c.managed_spec) or {}).get("kind")
            == ps.MANAGED_SPEC_KIND_SCORE
        )
        cell = db.query(DatasetValue).filter(
            DatasetValue.column_id == column.id).one()
        assert cell.value_text == "1.333"
        assert cell.value_numeric == 1.333


# ── #923 — the reap deletes more than the column ─────────────────────────────
#
# A score column is an ordinary `DatasetColumn`, which is the whole argument for
# Option C — so the analysis view will build a `MetricDefinition` on it, and a
# metric names its column through the polymorphic `input_source_id`, which carries
# NO ForeignKey. The reap was a bare `db.delete(column)`, so the metric survived
# pointing at an id that no longer existed and `compute_metric` raised
# `ValueError: Dataset column N not found in project`.


def _metric_on(db, column_id: int, name="Support (mean)") -> MetricDefinition:
    m = MetricDefinition(
        project_id=1, name=name, metric_type="mean",
        input_source_type="dataset_column", input_source_id=column_id,
        config="{}",
    )
    db.add(m)
    db.flush()
    return m


def _score_column(db, dataset):
    for column in _columns(db, dataset):
        spec = ps.parse_managed_spec(column.managed_spec)
        if spec and spec["kind"] == ps.MANAGED_SPEC_KIND_SCORE:
            return column
    raise AssertionError("fixture is degenerate: no score column")


class TestTheReapCleansUpAfterItself:

    def test_a_metric_on_a_reaped_score_column_is_deleted(self, world):
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        metric = _metric_on(db, _score_column(db, dataset).id)

        db.delete(world["code"])
        db.flush()
        ps.refresh_participant_dataset(db, 1)

        assert db.query(MetricDefinition).filter(
            MetricDefinition.id == metric.id,
        ).count() == 0

    def test_a_statistical_test_on_that_metric_goes_with_it(self, world):
        """The metric's own children: a saved test targets the metric
        polymorphically, so deleting the metric alone would strand it."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        metric = _metric_on(db, _score_column(db, dataset).id)
        test = StatisticalTest(
            project_id=1, test_type="t_test",
            target_type="metric_definition", target_id=metric.id,
        )
        db.add(test)
        db.flush()

        db.delete(world["code"])
        db.flush()
        ps.refresh_participant_dataset(db, 1)

        assert db.query(StatisticalTest).filter(
            StatisticalTest.id == test.id,
        ).count() == 0

    def test_the_domain_membership_goes_too(self, world):
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        column = _score_column(db, dataset)
        domain = AnalysisDomain(project_id=1, name="Support")
        db.add(domain)
        db.flush()
        db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                    member_id=column.id))
        db.flush()

        db.delete(world["code"])
        db.flush()
        ps.refresh_participant_dataset(db, 1)

        assert db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.member_id == column.id,
            AnalysisDomainMember.member_type == "column",
        ).count() == 0

    def test_the_refresh_REPORTS_how_many_saved_metrics_it_removed(self, world):
        """The disclosure half. A chart vanishing without a word is the one part
        of the reap the researcher did not ask for, and `columns_removed` does not
        say it: a column can be reaped with no metric on it at all."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        _metric_on(db, _score_column(db, dataset).id)

        db.delete(world["code"])
        db.flush()
        report = ps.refresh_participant_dataset(db, 1)

        assert report.columns_removed == 2, "the score and its n"
        assert report.metrics_removed == 1

    def test_a_metric_on_an_UNRELATED_column_survives(self, world):
        """Positive control. The cleanup is keyed on the reaped column's id; a
        predicate wide enough to take a neighbour's metric would pass every test
        above."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        mine = DatasetColumn(
            dataset_id=dataset.id, column_text="Department",
            column_type=ColumnType.NOMINAL, sequence_order=90, display_order=90,
            source="manual",
        )
        db.add(mine)
        db.flush()
        keeper = _metric_on(db, mine.id, name="Departments")

        db.delete(world["code"])
        db.flush()
        report = ps.refresh_participant_dataset(db, 1)

        assert db.query(MetricDefinition).filter(
            MetricDefinition.id == keeper.id,
        ).count() == 1
        assert report.metrics_removed == 0

    def test_nothing_is_removed_when_the_code_merely_loses_its_SCALE(self, world):
        """The other half of the reap rule: clearing a scale is recoverable, so
        the columns (and anything built on them) stay."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        dataset = get_participant_dataset(db, 1)
        metric = _metric_on(db, _score_column(db, dataset).id)

        world["code"].magnitude_min = None
        world["code"].magnitude_max = None
        world["code"].magnitude_step = None
        db.flush()
        report = ps.refresh_participant_dataset(db, 1)

        assert report.columns_removed == 0
        assert report.metrics_removed == 0
        assert db.query(MetricDefinition).filter(
            MetricDefinition.id == metric.id,
        ).count() == 1


class TestTheReapDoesNotBlockTheRefresh:
    """🔴 The `validate_domains=False` decision, driven at the refresh's mouth.

    The shared cleanup's last step raises 409 `cross_dataset_unpaired` when a
    surviving cross-dataset domain would be left unpaired — right for a researcher
    deleting a column by hand, wrong here: the column goes away as a CONSEQUENCE
    of a code deleted elsewhere, so a raise would abort the whole refresh and leave
    every OTHER score stale over a domain this action never touched.
    """

    def _unpairable_domain(self, world):
        """Build the one shape where removing the score column BREAKS pairing.

        Removing a member from a multi-dataset equivalence group leaves the others
        still bridged, so the score column has to be some other member's ONLY
        partner: two groups, one of which loses its bridge.

          EG1 = {score(P), b1(B)}      ← loses its bridge when score goes
          EG2 = {c1(C),   b2(B)}       ← keeps the domain spanning 2+ datasets
        """
        db = world["db"]
        dataset = get_participant_dataset(db, 1)
        score = _score_column(db, dataset)

        others = {}
        for name, cols in (("B", ("b1", "b2")), ("C", ("c1",))):
            ds = Dataset(project_id=1, name=f"Wave {name}")
            db.add(ds)
            db.flush()
            for i, cname in enumerate(cols):
                col = DatasetColumn(
                    dataset_id=ds.id, column_text=cname,
                    column_type=ColumnType.NUMERIC,
                    sequence_order=i, display_order=i, source="imported",
                )
                db.add(col)
                db.flush()
                others[cname] = col

        eg1 = EquivalenceGroup(project_id=1, label="bridge 1")
        eg2 = EquivalenceGroup(project_id=1, label="bridge 2")
        db.add_all([eg1, eg2])
        db.flush()
        score.equivalence_group_id = eg1.id
        others["b1"].equivalence_group_id = eg1.id
        others["c1"].equivalence_group_id = eg2.id
        others["b2"].equivalence_group_id = eg2.id

        domain = AnalysisDomain(project_id=1, name="Cross-wave support")
        db.add(domain)
        db.flush()
        for i, col in enumerate([score, others["b1"], others["c1"], others["b2"]]):
            db.add(AnalysisDomainMember(domain_id=domain.id, member_type="column",
                                        member_id=col.id, sequence_order=i))
        db.flush()
        return score, domain

    def test_the_fixture_really_is_the_blocking_state(self, world):
        """DISCRIMINATION guard: without this the test below passes on any fixture,
        including one where the validator would never have fired."""
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        score, _domain = self._unpairable_domain(world)

        with pytest.raises(HTTPException) as exc:
            delete_column_references(
                db, 1, score.id, validate_domains=True,
            )
        assert exc.value.status_code == 409
        db.rollback()

    def test_the_refresh_completes_anyway(self, world):
        db = world["db"]
        world["rate"]("E-01", 2.0)
        create_participant_dataset(db, 1)
        ps.refresh_participant_dataset(db, 1)
        self._unpairable_domain(world)

        db.delete(world["code"])
        db.flush()

        report = ps.refresh_participant_dataset(db, 1)  # the assertion IS this

        assert report.columns_removed == 2
        assert report.synced_at is not None
