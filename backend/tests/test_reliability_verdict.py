"""#1505 — how little data a reliability coefficient may rest on (1.5.9, D42–D45).

Three rules, each with a fixture on BOTH sides of its boundary (the rule that a
convention selected by a property of the input needs fixtures straddling the
selector — `backend/tests/the internal design notes):

- **D42** — over ONE comparable unit κ and α are undefined (`insufficient_n`).
  Over one unit α is identically 0 whenever the coders differ, for every metric
  and any number of coders; that is arithmetic, not a measurement.
- **D43** — below `VERDICT_MIN_UNITS` (18) a coefficient keeps its value, its n
  and its interval, and loses its band word, with a stated reason.
- **D44** — an interval with no width is refused (`no_spread`): a bootstrap
  whose resamples cannot differ, and κ's analytic variance at exactly 0.

Record: the internal design notes.
"""
from statistics import NormalDist

import pytest

from app.auth import CODER_TYPE_MACHINE
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_set import CodeSet
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import machine_agreement as ma
from app.services import reliability_basis as rb
from app.services.irr import (
    _krippendorff_alpha,
    binary_undefined_reason,
    compute_irr,
    set_undefined_reason,
    valued_undefined_reason,
)
from app.services.reliability_intervals import (
    CI_UNAVAILABLE_NO_SPREAD,
    alpha_interval,
    kappa_interval,
    unit_contributions,
)

PID = 1505
CODE = 150501
RATED = 150502
SET_ID = 150510
MEMBERS = (150511, 150512, 150513)


# ── The constants, against what they claim to be ─────────────────────────────


def test_the_verdict_floor_is_krippendorffs_most_lenient_cell():
    """D43: N = 2z²[(1+α)(3−α)/(4(1−α)p(1−p)) − α] at α_min .667, p .10, an evenly
    split binary variable is 36 VALUES — the table's printed cell — i.e. 18 units
    for two coders. Recomputed here, so a hand-edit of the constant fails."""
    z = NormalDist().inv_cdf(0.90)
    a, p = 0.667, 0.5
    n_values = 2 * z * z * ((1 + a) * (3 - a) / (4 * (1 - a) * p * (1 - p)) - a)
    assert round(n_values) == 36
    assert rb.VERDICT_MIN_UNITS == round(n_values) // 2 == 18
    assert rb.MIN_COMPARABLE_UNITS == 2


def test_one_unit_is_an_identity_for_every_metric():
    """The fact D42 rests on, executed: one unit, any disagreement, α = 0."""
    for rows, metric in (([[3, 4]], "interval"), ([[1, 9]], "interval"),
                         ([[2, 2, 5]], "interval"), ([[1, 0]], "nominal"),
                         ([[11, 12, -1]], "nominal"), ([[1, 5]], "ordinal")):
        assert _krippendorff_alpha(rows, metric) == pytest.approx(0.0, abs=1e-12)


# ── The undefined-reason helpers (shared with the R export) ──────────────────


class TestUndefinedReasons:
    def test_binary(self):
        assert binary_undefined_reason([]) == "insufficient_n"
        assert binary_undefined_reason([[1, 0]]) == "insufficient_n"
        assert binary_undefined_reason([[1, 0], [0, 0]]) is None
        # Variance is the SECOND question: one agreeing unit is too little data
        # first (the reason the researcher can act on).
        assert binary_undefined_reason([[1, 1]]) == "insufficient_n"
        assert binary_undefined_reason([[1, 1], [1, 1]]) == "no_variance"
        assert binary_undefined_reason([[0, 0], [0, 0]]) == "no_variance"
        # A lone value (one coder) is not a comparable unit.
        assert binary_undefined_reason([[1, 0], [1, None]]) == "insufficient_n"

    def test_valued(self):
        assert valued_undefined_reason([[3, None], [None, 4]]) == "insufficient_n"
        assert valued_undefined_reason([[3, 4]]) == "insufficient_n"
        assert valued_undefined_reason([[3, 4], [2, 2]]) is None
        assert valued_undefined_reason([[3, 3], [3, 3], [3, None]]) == "no_variance"

    def test_set(self):
        assert set_undefined_reason([[1, 2], [2, 2]], 1) == "degenerate"
        assert set_undefined_reason([[1, 2]], 3) == "insufficient_n"
        assert set_undefined_reason([[1, 2], [2, 2]], 3) is None


# ── compute_irr — the three tables and the headline ──────────────────────────


def _project(db, n_units: int, *, three_values: bool = False):
    """Two coders on ``n_units`` turns of one conversation, with a binary code, a
    rated code and a three-valued set — each disagreeing on some units and
    agreeing on others, so every coefficient is DEFINED at n ≥ 2."""
    db.add(Project(id=PID, name="Verdict", user_id=1))
    db.add(User(id=2, username="Second coder", password_hash=None, coder_type="human"))
    db.add(Conversation(id=PID, project_id=PID, name="Interview"))
    db.add(CodeSet(id=SET_ID, project_id=PID, label="Stance", exhaustive=True))
    db.flush()
    db.add(Code(id=CODE, project_id=PID, numeric_id=1, name="Theme"))
    db.add(Code(id=RATED, project_id=PID, numeric_id=2, name="Intensity",
                magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0))
    for i, cid in enumerate(MEMBERS):
        db.add(Code(id=cid, project_id=PID, numeric_id=10 + i, name=f"Value {i}",
                    code_set_id=SET_ID))
    db.flush()
    for i in range(n_units):
        sid = PID * 100 + i
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=f"turn {i}"))
        db.flush()
        # Theme: coder 1 on even units, coder 2 on units divisible by 3 → disagree
        # on some, agree on others.
        if i % 2 == 0:
            db.add(CodeApplication(code_id=CODE, user_id=1, segment_id=sid))
        if i % 3 == 0:
            db.add(CodeApplication(code_id=CODE, user_id=2, segment_id=sid))
        # Every unit rated by both: 1..5 cycling, the second coder one step off
        # on every third unit.
        r1 = 1 + i % 5
        r2 = r1 if i % 3 else min(5, r1 + 1)
        db.add(CodeApplication(code_id=RATED, user_id=1, segment_id=sid, magnitude=r1))
        db.add(CodeApplication(code_id=RATED, user_id=2, segment_id=sid, magnitude=r2))
        # The set: both choose a value, differing on every fourth unit.
        m1 = MEMBERS[i % 3]
        m2 = m1 if i % 4 else MEMBERS[(i + 1) % 3]
        db.add(CodeApplication(code_id=m1, user_id=1, segment_id=sid))
        db.add(CodeApplication(code_id=m2, user_id=2, segment_id=sid))
    db.flush()
    return compute_irr(db, PID)


def _rows(res):
    code = next(c for c in res["per_code"] if c["code_id"] == CODE)
    rated = next(c for c in res["magnitude_per_code"] if c["code_id"] == RATED)
    the_set = next(s for s in res["set_agreement"] if s["set_id"] == SET_ID)
    return code, rated, the_set


class TestOneUnit:
    def test_every_table_is_undefined_and_says_so(self, db_session):
        res = _project(db_session, 1)
        code, rated, the_set = _rows(res)
        for row in (code, rated, the_set):
            assert row["n_units"] == 1
            assert row["krippendorff_alpha"] is None
            assert row["undefined_reason"] == "insufficient_n"
            assert row["alpha_ci"] is None
            assert row["verdict_withheld_reason"] is None, "one reason per blank cell"
        assert code["cohens_kappa"] is None and code["kappa_interpretation"] is None
        assert code["percent_agreement"] is not None, "a share over one unit still describes it"
        member = the_set["members"][0]
        assert member["undefined_reason"] == "insufficient_n"
        assert member["krippendorff_alpha"] is None
        # The headline pools nothing that is undefined.
        assert res["overall_alpha"] is None and res["overall_alpha_interpretation"] is None

    def test_two_units_are_a_coefficient(self, db_session):
        """The other side of D42's boundary."""
        res = _project(db_session, 2)
        code, rated, the_set = _rows(res)
        assert code["undefined_reason"] is None and code["krippendorff_alpha"] is not None
        assert rated["undefined_reason"] is None and rated["krippendorff_alpha"] is not None


class TestTheVerdictFloor:
    def test_below_the_floor_the_number_stays_and_the_band_goes(self, db_session):
        res = _project(db_session, rb.VERDICT_MIN_UNITS - 1)
        assert res["verdict_min_units"] == rb.VERDICT_MIN_UNITS
        code, rated, the_set = _rows(res)
        for row in (code, rated, the_set):
            assert row["krippendorff_alpha"] is not None
            assert row["alpha_interpretation"] is None
            assert row["verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS
            assert row["undefined_reason"] is None
        for row in (code, the_set):
            assert row["cohens_kappa"] is not None
            assert row["kappa_interpretation"] is None
        assert res["overall_alpha"] is not None
        assert res["overall_alpha_interpretation"] is None
        assert res["overall_verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS
        member = the_set["members"][0]
        assert member["krippendorff_alpha"] is not None
        assert member["alpha_interpretation"] is None
        assert member["verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS

    def test_at_the_floor_every_row_carries_its_band(self, db_session):
        res = _project(db_session, rb.VERDICT_MIN_UNITS)
        code, rated, the_set = _rows(res)
        for row in (code, rated, the_set):
            assert row["alpha_interpretation"] in {"unreliable", "tentative", "reliable"}
            assert row["verdict_withheld_reason"] is None
        for row in (code, the_set):
            assert row["kappa_interpretation"] is not None
        assert res["overall_alpha_interpretation"] is not None
        assert res["overall_verdict_withheld_reason"] is None

    def test_the_unavailable_payload_states_the_floor_too(self, db_session):
        db_session.add(Project(id=PID, name="Empty", user_id=1))
        db_session.flush()
        res = compute_irr(db_session, PID)
        assert res["available"] is False
        assert res["verdict_min_units"] == rb.VERDICT_MIN_UNITS
        assert res["overall_verdict_withheld_reason"] is None

    def test_the_fields_reach_the_wire(self, db_session):
        """Declared on the schema, or the endpoint's `response_model` drops them —
        the half-landed-wire class (#855)."""
        from app.schemas.code_analysis import IrrResponse

        wire = IrrResponse(**_project(db_session, 5)).model_dump()
        assert wire["verdict_min_units"] == rb.VERDICT_MIN_UNITS
        assert wire["overall_verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS
        # (The rated code's presence row is `no_variance` — both coders applied
        # it everywhere — so it carries no verdict to withhold; Theme does.)
        theme = next(c for c in wire["per_code"] if c["code_id"] == CODE)
        assert theme["verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS
        assert wire["magnitude_per_code"][0]["verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS
        assert wire["set_agreement"][0]["verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS
        assert wire["set_agreement"][0]["members"][0]["verdict_withheld_reason"] == rb.VERDICT_WITHHELD_TOO_FEW_UNITS


# ── D44 — an interval with no width ──────────────────────────────────────────


class TestNoSpread:
    def test_perfect_agreement_has_no_alpha_interval(self):
        rows = [[1, 1]] * 3 + [[0, 0]] * 7
        ci = alpha_interval(unit_contributions(rows))
        assert (ci["lower"], ci["upper"], ci["unavailable_reason"]) == (None, None, CI_UNAVAILABLE_NO_SPREAD)

    def test_one_repeated_pattern_has_no_alpha_interval(self):
        ci = alpha_interval(unit_contributions([[1, 0]] * 20))
        assert ci["unavailable_reason"] == CI_UNAVAILABLE_NO_SPREAD

    def test_an_ordinary_alpha_interval_keeps_its_bounds(self):
        rows = [[1, 0], [0, 0], [1, 1], [0, 0], [1, 1], [0, 1], [1, 1], [0, 0]]
        ci = alpha_interval(unit_contributions(rows))
        assert ci["unavailable_reason"] is None
        assert ci["lower"] < ci["upper"]

    def test_perfect_agreement_has_no_kappa_interval(self):
        ci = kappa_interval([[1, 1]] * 3 + [[0, 0]] * 7)
        assert (ci["lower"], ci["upper"], ci["unavailable_reason"]) == (None, None, CI_UNAVAILABLE_NO_SPREAD)

    def test_a_coder_who_never_varies_has_no_kappa_interval(self):
        ci = kappa_interval([[1, 0]] * 5 + [[0, 0]] * 5)
        assert ci["unavailable_reason"] == CI_UNAVAILABLE_NO_SPREAD

    def test_an_ordinary_kappa_interval_keeps_its_bounds(self):
        ci = kappa_interval([[1, 0], [0, 0], [1, 1], [0, 0], [1, 1], [0, 1], [1, 1], [0, 0]])
        assert ci["unavailable_reason"] is None
        assert ci["lower"] < ci["upper"]


# ── D45 — the Model comparison takes the same rules ──────────────────────────


def _machine_project(db, n_units: int):
    db.add(Project(id=PID, name="Model", user_id=1))
    db.add(User(id=2, username="A model", password_hash=None, coder_type=CODER_TYPE_MACHINE))
    db.add(Conversation(id=PID, project_id=PID, name="Thread"))
    db.flush()
    db.add(Code(id=CODE, project_id=PID, numeric_id=1, name="Theme"))
    db.flush()
    for i in range(n_units):
        sid = PID * 100 + i
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=f"post {i}"))
        db.flush()
        if i % 2 == 0:
            db.add(CodeApplication(code_id=CODE, user_id=1, segment_id=sid))
        if i % 3 == 0:
            db.add(CodeApplication(code_id=CODE, user_id=2, segment_id=sid))
    db.flush()
    result = ma.compute_machine_agreement(db, PID)
    assert result.verdict_min_units == rb.VERDICT_MIN_UNITS
    return result.pairs[0].per_code[0]


class TestTheModelComparison:
    def test_one_unit_is_undefined_and_keeps_its_share(self, db_session):
        row = _machine_project(db_session, 1)
        assert row.kappa is None and row.undefined_reason == "insufficient_n"
        assert row.percent_agreement is not None
        assert row.verdict_withheld_reason is None

    def test_below_the_floor_kappa_has_no_band(self, db_session):
        row = _machine_project(db_session, rb.VERDICT_MIN_UNITS - 1)
        assert row.kappa is not None
        assert row.kappa_interpretation is None
        assert row.verdict_withheld_reason == rb.VERDICT_WITHHELD_TOO_FEW_UNITS

    def test_at_the_floor_kappa_has_its_band(self, db_session):
        row = _machine_project(db_session, rb.VERDICT_MIN_UNITS)
        assert row.kappa_interpretation is not None
        assert row.verdict_withheld_reason is None
