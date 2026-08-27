"""#707(b) — Little's MCAR test states which estimates produced it.

The NINTH member of the stated-basis family. Two halves are guarded here: that the
basis actually reaches the WIRE (the endpoint declares a `response_model`, so a
field the service returns without a schema entry is silently dropped), and that the
hand-mirrored TypeScript has not drifted.
"""
from pathlib import Path

import pytest

from app.schemas.data_quality import McarTestResult
from app.services.data_quality import MCAR_ESTIMATOR_AVAILABLE_CASE


class TestTheBasisReachesTheWire:
    """⚠️ The half that a service-level assertion cannot see.

    `mcar_test` declares `response_model=McarTestResponse`, so FastAPI serializes
    through the schema and drops anything the model does not declare. A service
    returning `mcar_estimator` with no field on `McarTestResult` would pass every
    unit test of the computation and reach the client as nothing — the half-landed
    wire class this project has hit repeatedly.
    """

    def test_the_result_schema_declares_the_basis(self):
        assert "mcar_estimator" in McarTestResult.model_fields

    def test_the_schema_survives_a_payload_that_predates_the_field(self):
        # An older stored or mocked payload must still validate; the client renders
        # nothing for an absent basis rather than inventing one.
        older = McarTestResult(
            chi2=1.0, df=2, p=0.6, n=10, n_patterns=2, n_variables=2,
            apa_string="x", interpretation="y",
        )
        assert older.mcar_estimator is None

    def test_a_declared_basis_serializes(self):
        result = McarTestResult(
            chi2=1.0, df=2, p=0.6, n=10, n_patterns=2, n_variables=2,
            apa_string="x", interpretation="y",
            mcar_estimator=MCAR_ESTIMATOR_AVAILABLE_CASE,
        )
        assert result.model_dump()["mcar_estimator"] == MCAR_ESTIMATOR_AVAILABLE_CASE


class TestCrossLanguageContract:
    """The constants are hand-mirrored in TypeScript with NO codegen.

    Required of every stated-basis member: the client's fallback for an unknown
    basis is to report it verbatim, which is correct for an older payload and
    INVISIBLE for a value a newer server sends. TypeScript catches only the
    opposite direction, so Python reads the `.ts`.
    """

    def _ts(self) -> str:
        p = (
            Path(__file__).resolve().parents[2]
            / "frontend" / "src" / "lib" / "mcar-basis.ts"
        )
        assert p.exists(), f"the TS mirror moved: {p}"
        return p.read_text(encoding="utf-8")

    def test_estimator_constant_matches(self):
        assert f"'{MCAR_ESTIMATOR_AVAILABLE_CASE}'" in self._ts()

    def test_the_client_reports_an_unknown_estimator_rather_than_relabelling(self):
        assert "Estimator: ${estimator}." in self._ts()

    def test_the_client_keeps_the_exhaustiveness_guard(self):
        # Property (b) of the family rule: a variant added to the union without a
        # phrase must be a COMPILE error, not silence. `ci-label.ts` was a ternary
        # and fell through to a bare wrong label — the defect #42 found in the one
        # module meant to prevent it.
        assert "satisfies Record<McarEstimator, string>" in self._ts()

    def test_the_client_names_both_estimators_not_just_the_one_used(self):
        # The sentence is only useful if it says what the test is DEFINED over as
        # well as what was used; otherwise it reads as a detail rather than a caveat.
        ts = self._ts()
        assert "EM" in ts


class TestTheBasisIsNotAWarning:
    """⚠️ Placement is the design decision, and it is guarded.

    The pseudo-inverse and clamped-statistic notes are CONDITIONAL — they fire on
    degeneracy — and ride `eligibility.warning`. The estimator is a property of the
    method, true on EVERY run. Putting a standing fact in the exceptional channel is
    how readers learn to dismiss that channel, so it must not be appended there.
    """

    def test_the_estimator_is_not_appended_to_the_warning_list(self):
        src = (
            Path(__file__).resolve().parents[1]
            / "app" / "services" / "data_quality.py"
        ).read_text(encoding="utf-8")
        # The constant must be returned in the result, never joined into warnings.
        assert '"mcar_estimator": MCAR_ESTIMATOR_AVAILABLE_CASE' in src
        assert "warnings_list.append(MCAR_ESTIMATOR" not in src


@pytest.mark.parametrize("field", ["chi2", "df", "p", "n", "apa_string"])
def test_the_existing_result_fields_are_untouched(field):
    """The basis is additive: nothing about the statistic itself changed."""
    assert field in McarTestResult.model_fields
