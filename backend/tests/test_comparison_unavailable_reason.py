"""An empty comparison says WHY, and the client never guesses (#823c · #827 · #830b).

**The defect this closes.** Every early return from `compute_group_comparison`
was the same shapeless `rows: []`, so the client rendered one hardcoded
sentence — *"No comparison data available. The selected demographic may have
fewer than 2 groups."* — which is right for exactly ONE of the four ways a
comparison comes back empty. Both cases a real research pass met were among the
other three, and both sent the researcher to inspect data that was fine.

🔴 **The tests below encode a measurement that CONTRADICTS #827's filed
analysis, which is why they are behavioural rather than a source scan.** That
entry says cross-dataset row correspondence "runs through participant links" and
concludes the gate is *"are these two datasets linked?"*. Executed here:
`test_participant_links_do_not_make_a_cross_dataset_comparison_work` links every
row one-to-one and the comparison still returns nothing, because
`_load_grouping_map` reads the grouping column on the ANALYSED row ids and never
consults `participant_id`. The complementary case — a cross-dataset variable
GROUP grouped by a column in one of its datasets — DOES work, so neither "same
dataset" nor "linked datasets" is the predicate. What decides it is whether the
grouping column's dataset is among the analysed rows'.
"""

import json

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.equivalence_group import EquivalenceGroup
from app.models.metric import MetricDefinition
from app.models.participant import Participant
from app.models.project import Project
from app.models.row_score import RowScore
from app.services.comparisons import compute_group_comparison
from app.services.metrics import compute_metric
from app.services.undefined_stats import (
    DOMAIN_SCORES_MISSING,
    DOMAIN_SCORES_NOT_COMPUTED,
    INSUFFICIENT_GROUPS,
    NO_GROUP_VALUES,
    NO_VARIABLES,
    NOT_NUMERIC,
    UNAVAILABLE_REASONS,
)

PID = 8270


def _compare(db, *, column_ids=(), domain_ids=(), grouping_column_id=None):
    return compute_group_comparison(
        db, project_id=PID, column_ids=list(column_ids), domain_ids=list(domain_ids),
        grouping_column_id=grouping_column_id, grouping_column_id_2=None,
        test_type="auto", include_effect_size_ci=False,
    )


@pytest.fixture
def two_datasets(db_session):
    """Dataset A holds the outcome; dataset B holds a grouping variable.

    A also holds a same-dataset grouping column, so every test here has a
    POSITIVE CONTROL available — a guard that reports a failure by breaking the
    feature would otherwise pass its own negative assertions.
    """
    db = db_session
    db.add(Project(id=PID, name="Cross", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="A"))
    db.add(Dataset(id=PID + 1, project_id=PID, name="B"))
    db.flush()
    db.add(DatasetColumn(id=8271, dataset_id=PID, column_code="score", column_name="Score",
                         column_text="Score", column_type=ColumnType.NUMERIC,
                         sequence_order=0, display_order=0))
    db.add(DatasetColumn(id=8272, dataset_id=PID, column_code="site", column_name="Site",
                         column_text="Site", column_type=ColumnType.NOMINAL,
                         sequence_order=1, display_order=1))
    db.add(DatasetColumn(id=8273, dataset_id=PID + 1, column_code="band", column_name="Band",
                         column_text="Band", column_type=ColumnType.NOMINAL,
                         sequence_order=0, display_order=0))
    db.flush()
    for i in range(6):
        db.add(Participant(id=8300 + i, project_id=PID, identifier=f"P{i}"))
    db.flush()
    for i in range(6):
        db.add(DatasetRow(id=8310 + i, dataset_id=PID, row_identifier=f"A{i}",
                          participant_id=8300 + i))
        db.add(DatasetRow(id=8320 + i, dataset_id=PID + 1, row_identifier=f"B{i}",
                          participant_id=8300 + i))
    db.flush()
    for i in range(6):
        db.add(DatasetValue(row_id=8310 + i, column_id=8271,
                            value_text=str(10 + i), value_numeric=float(10 + i)))
        db.add(DatasetValue(row_id=8310 + i, column_id=8272,
                            value_text="X" if i < 3 else "Y"))
        db.add(DatasetValue(row_id=8320 + i, column_id=8273,
                            value_text="High" if i < 3 else "Low"))
    db.flush()
    return db


class TestTheReasonIsComputedNotGuessed:
    def test_a_working_comparison_carries_no_reason(self, two_datasets):
        # The positive control. Every assertion below is an ABSENCE of rows, and
        # an absence is what a broken computation produces too.
        out = _compare(two_datasets, column_ids=[8271], grouping_column_id=8272)
        assert len(out["rows"]) == 1
        assert out["unavailable_reason"] is None
        assert out["groups"] == ["X", "Y"]

    def test_participant_links_do_not_make_a_cross_dataset_comparison_work(self, two_datasets):
        """🔴 The measurement that refutes #827's filed cause.

        Every row is linked one-to-one to a participant — the shape the entry
        says is required — and the comparison still produces nothing, because
        this code path never reads `participant_id`. A gate built on "are these
        datasets linked?" would therefore keep offering exactly this.
        """
        db = two_datasets
        linked = db.query(DatasetRow).filter(DatasetRow.participant_id.isnot(None)).count()
        assert linked == 12, "fixture must be fully linked or it proves nothing"

        out = _compare(db, column_ids=[8271], grouping_column_id=8273)
        assert out["rows"] == []
        assert out["unavailable_reason"] == NO_GROUP_VALUES

    def test_fewer_than_two_groups_keeps_the_sentence_that_was_always_right(self, two_datasets):
        db = two_datasets
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == 8272).all():
            v.value_text = "X"
        db.flush()
        out = _compare(db, column_ids=[8271], grouping_column_id=8272)
        assert out["unavailable_reason"] == INSUFFICIENT_GROUPS

    def test_no_group_values_and_insufficient_groups_are_different_answers(self, two_datasets):
        """The distinction the old copy could not make.

        Both are "no groups", and the remedies are opposite: one says the
        grouping variable does not reach these records at all, the other says it
        does and there is only one of them.
        """
        db = two_datasets
        cross = _compare(db, column_ids=[8271], grouping_column_id=8273)
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == 8272).all():
            v.value_text = "X"
        db.flush()
        thin = _compare(db, column_ids=[8271], grouping_column_id=8272)
        assert cross["unavailable_reason"] != thin["unavailable_reason"]

    def test_nothing_selected(self, two_datasets):
        assert _compare(two_datasets, grouping_column_id=8272)["unavailable_reason"] == NO_VARIABLES

    def test_every_emitted_reason_is_in_the_vocabulary(self, two_datasets):
        db = two_datasets
        seen = {
            _compare(db, grouping_column_id=8272)["unavailable_reason"],
            _compare(db, column_ids=[8271], grouping_column_id=8273)["unavailable_reason"],
        }
        assert seen  # the walk found something
        assert seen <= UNAVAILABLE_REASONS


class TestAVariableGroupSaysWhichHalfIsMissing:
    """#823(c) — the two states have different remedies, so they are two reasons."""

    @pytest.fixture
    def cross_domain(self, two_datasets):
        db = two_datasets
        eg = EquivalenceGroup(id=8280, project_id=PID, label="Q1")
        db.add(eg)
        db.flush()
        db.add(DatasetColumn(id=8281, dataset_id=PID, column_code="q1a", column_name="q1a",
                             column_text="q1a", column_type=ColumnType.ORDINAL,
                             sequence_order=2, display_order=2, equivalence_group_id=8280))
        db.add(DatasetColumn(id=8282, dataset_id=PID + 1, column_code="q1b", column_name="q1b",
                             column_text="q1b", column_type=ColumnType.ORDINAL,
                             sequence_order=1, display_order=1, equivalence_group_id=8280))
        db.flush()
        db.add(AnalysisDomain(id=8290, project_id=PID, name="Scale"))
        db.flush()
        db.add(AnalysisDomainMember(domain_id=8290, member_type="column", member_id=8281,
                                    sequence_order=0))
        db.add(AnalysisDomainMember(domain_id=8290, member_type="column", member_id=8282,
                                    sequence_order=1))
        db.flush()
        for i in range(6):
            db.add(DatasetValue(row_id=8310 + i, column_id=8281,
                                value_text=str(1 + i % 5), value_numeric=float(1 + i % 5)))
            db.add(DatasetValue(row_id=8320 + i, column_id=8282,
                                value_text=str(1 + i % 4), value_numeric=float(1 + i % 4)))
        db.flush()
        return db

    def test_no_scale_score_metric_at_all(self, cross_domain):
        out = _compare(cross_domain, domain_ids=[8290], grouping_column_id=8272)
        assert out["unavailable_reason"] == DOMAIN_SCORES_MISSING

    def test_the_metric_exists_but_was_never_computed(self, cross_domain):
        """The state the GSS pass met: a 5-group variable, and a message about
        group count, on a comparison whose grouping column was never consulted."""
        db = cross_domain
        db.add(MetricDefinition(id=8295, project_id=PID, name="Scale score",
                                metric_type="domain_aggregate",
                                input_source_type="dataset_domain", input_source_id=8290,
                                config=json.dumps({"child_metric_type": "mean",
                                                   "child_config": {}, "aggregation": "mean"}),
                                origin="human", stale=True))
        db.flush()
        assert db.query(RowScore).count() == 0
        out = _compare(db, domain_ids=[8290], grouping_column_id=8272)
        assert out["unavailable_reason"] == DOMAIN_SCORES_NOT_COMPUTED

    def test_once_computed_a_cross_dataset_group_compares_by_either_dataset(self, cross_domain):
        """🔴 The case a naive "same dataset as the variable" gate would refuse.

        A cross-dataset variable group writes row scores in BOTH datasets, so a
        grouping column in either one reaches half the rows and the comparison
        runs. This is why the offer is gated on the SET of analysed datasets.
        """
        db = cross_domain
        m = MetricDefinition(id=8296, project_id=PID, name="Scale score",
                             metric_type="domain_aggregate",
                             input_source_type="dataset_domain", input_source_id=8290,
                             config=json.dumps({"child_metric_type": "mean",
                                                "child_config": {}, "aggregation": "mean"}),
                             origin="human", stale=True)
        db.add(m)
        db.flush()
        compute_metric(db, m)
        db.flush()
        assert db.query(RowScore).count() > 0

        out = _compare(db, domain_ids=[8290], grouping_column_id=8272)
        assert out["unavailable_reason"] is None
        assert out["groups"] == ["X", "Y"]


class TestANonNumericVariableSaysSo:
    """#830(b) — the type is the reason, and the type is known."""

    def test_a_nominal_variable_reports_its_type_not_an_empty_group(self, two_datasets):
        db = two_datasets
        out = _compare(db, column_ids=[8272, 8271], grouping_column_id=8272)
        by_label = {r["label"]: r for r in out["rows"]}
        nominal = by_label["Site"]
        assert {g["undefined_reason"] for g in nominal["group_stats"]} == {NOT_NUMERIC}
        assert nominal["test_omitted_reason"] == NOT_NUMERIC
        # ...and the numeric variable beside it is unaffected — the positive
        # control that stops this passing by marking everything not_numeric.
        numeric = by_label["Score"]
        assert [g["n"] for g in numeric["group_stats"]] == [3, 3]
        assert numeric["test_omitted_reason"] is None

    def test_an_all_missing_NUMERIC_variable_still_reports_an_empty_group(self, two_datasets):
        """The discrimination the fix must preserve: a numeric column with no
        usable values IS an empty group, and saying `not_numeric` there would be
        the same class of wrong diagnosis pointing the other way."""
        db = two_datasets
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == 8271).all():
            v.value_numeric = None
        db.flush()
        out = _compare(db, column_ids=[8271], grouping_column_id=8272)
        # No rows survive at all (nothing to group), so the answer is at the
        # result level — and it is NOT a claim about the variable's type.
        assert out["unavailable_reason"] == NO_VARIABLES


# ── The vocabulary is mirrored on the client ─────────────────────────────────


def test_every_reason_has_a_sentence_in_the_client():
    """Python reads the TypeScript (the stated-basis family's rule (a)).

    The constants are hand-mirrored with no codegen, and **the client's fallback
    for an unknown reason is SILENCE** — right for a payload that predates the
    field, invisible for a value a newer server sends. A reason added here
    without a sentence there would render as the generic line, which is the
    defect this whole round is about.
    """
    from pathlib import Path

    client = (Path(__file__).resolve().parents[2]
              / "frontend" / "src" / "lib" / "comparison-unavailable.ts")
    text = client.read_text(encoding="utf-8")
    for reason in UNAVAILABLE_REASONS:
        assert f"{reason}: {{" in text, (
            f"`{reason}` has no copy in comparison-unavailable.ts"
        )
        assert f"'{reason}'" in text, f"`{reason}` is missing from the TS union"
    # Guard the guard: a renamed export would leave the loop reading nothing.
    assert len(UNAVAILABLE_REASONS) >= 5
    assert "satisfies Record<ComparisonUnavailableReason" in text, (
        "the client map must be `satisfies`-checked, or a new reason falls "
        "through to a default instead of failing the build"
    )
