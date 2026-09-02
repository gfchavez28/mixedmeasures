"""#35 — a reliability coefficient states its FACET and its α METRIC.

The TENTH member of the stated-basis family. Three halves are guarded here:

1. **The basis reaches the WIRE.** `/irr` declares `response_model=IrrResponse`,
   so a field the service returns without a schema entry is silently dropped —
   the half-landed-wire class this project has hit repeatedly.
2. **The hand-mirrored TypeScript has not drifted.** No codegen connects
   `services/reliability_basis.py` to `lib/reliability-basis.ts`; this file does.
3. **The consumers read the constant, never a literal.** The R export must emit
   the metric the app scored with; the Cronbach payload must state `items`.
"""
from pathlib import Path

import pytest

from app.schemas.code_analysis import IrrCodeResult, IrrMagnitudeResult, IrrResponse
from app.services import reliability_basis as rb

REPO = Path(__file__).resolve().parents[2]
TS_MIRROR = REPO / "frontend" / "src" / "lib" / "reliability-basis.ts"


def _ts() -> str:
    assert TS_MIRROR.exists(), f"the TS mirror moved: {TS_MIRROR}"
    return TS_MIRROR.read_text(encoding="utf-8")


def _py(rel: str) -> str:
    return (REPO / "backend" / "app" / rel).read_text(encoding="utf-8")


class TestTheVocabulary:
    def test_the_two_facets_are_distinct_and_enumerated(self):
        assert rb.RELIABILITY_FACET_CODERS != rb.RELIABILITY_FACET_ITEMS
        assert rb.RELIABILITY_FACETS == {rb.RELIABILITY_FACET_CODERS, rb.RELIABILITY_FACET_ITEMS}

    def test_the_metric_strings_are_the_ones_the_alpha_function_accepts(self):
        """The constants are what `irr._krippendorff_alpha(metric=)` — and R's
        `kripp.alpha(method=)` — take verbatim, so nothing translates them."""
        from app.services.irr import _krippendorff_alpha

        rows = [[1.0, 2.0], [2.0, 2.0], [3.0, 4.0], [4.0, 4.0]]
        for metric in rb.ALPHA_METRICS:
            assert _krippendorff_alpha(rows, metric) is not None

    def test_the_magnitude_metric_is_a_member_of_the_vocabulary(self):
        assert rb.MAGNITUDE_ALPHA_METRIC in rb.ALPHA_METRICS
        # The design decision, pinned: a declared scale is an INTERVAL instrument.
        assert rb.MAGNITUDE_ALPHA_METRIC == rb.ALPHA_METRIC_INTERVAL


class TestTheBasisReachesTheWire:
    """⚠️ The half a service-level assertion cannot see (`test_mcar_basis.py`'s
    shape): FastAPI serializes through the schema and drops the undeclared."""

    def test_the_response_schema_declares_the_facet_and_the_rating_rows(self):
        assert "reliability_facet" in IrrResponse.model_fields
        assert "magnitude_per_code" in IrrResponse.model_fields

    def test_every_alpha_row_declares_its_metric(self):
        assert "alpha_metric" in IrrCodeResult.model_fields
        assert "alpha_metric" in IrrMagnitudeResult.model_fields

    def test_the_rating_row_declares_its_coverage_and_scale(self):
        for field in ("n_units", "n_applications", "n_rated", "scale",
                      "mean_abs_difference", "alpha_ci", "undefined_reason"):
            assert field in IrrMagnitudeResult.model_fields, field

    def test_the_schema_survives_a_payload_that_predates_the_fields(self):
        older = IrrResponse(available=False, n_coders=1)
        assert older.reliability_facet is None
        assert older.magnitude_per_code == []

    def test_a_declared_basis_serializes(self):
        payload = IrrResponse(
            available=True, n_coders=2, reliability_facet=rb.RELIABILITY_FACET_CODERS,
        ).model_dump()
        assert payload["reliability_facet"] == rb.RELIABILITY_FACET_CODERS


class TestCrossLanguageContract:
    """Python reads the `.ts` — the client's fallback for an unknown basis is to
    report it verbatim, which is correct for an older payload and INVISIBLE for
    a value a newer server sends. TypeScript catches only the other direction."""

    def test_the_facet_constants_match(self):
        ts = _ts()
        assert f"'{rb.RELIABILITY_FACET_CODERS}'" in ts
        assert f"'{rb.RELIABILITY_FACET_ITEMS}'" in ts

    def test_every_alpha_metric_is_in_the_client_union(self):
        ts = _ts()
        for metric in rb.ALPHA_METRICS:
            assert f"'{metric}'" in ts, f"AlphaMetric union lacks {metric!r}"

    def test_the_client_keeps_both_exhaustiveness_guards(self):
        # Property (b) of the family rule: a variant added to a union without
        # words must be a COMPILE error, not silence.
        ts = _ts()
        assert "satisfies Record<ReliabilityFacet, string>" in ts
        assert "satisfies Record<AlphaMetric, string>" in ts

    def test_the_client_reports_an_unknown_facet_rather_than_relabelling(self):
        ts = _ts()
        assert "`over ${facet}`" in ts
        assert "`Reliability facet: ${facet}.`" in ts


class TestTheConsumersReadTheConstant:
    def test_the_categorical_alpha_rows_state_nominal(self):
        src = _py("services/irr.py")
        assert src.count('"alpha_metric": ALPHA_METRIC_NOMINAL') == 2, (
            "both per-code result shapes (defined and no-variance) must state the metric"
        )

    def test_the_rating_rows_state_the_magnitude_metric(self):
        assert '"alpha_metric": MAGNITUDE_ALPHA_METRIC' in _py("services/irr.py")

    def test_the_rating_interval_is_scored_on_the_same_metric_as_its_estimate(self):
        """The interval must bracket the number it sits beside. A nominal
        interval around an interval-metric estimate is plausible and wrong."""
        src = _py("services/irr.py")
        assert "metric=MAGNITUDE_ALPHA_METRIC" in src

    def test_the_r_export_emits_the_constant_not_a_literal(self):
        src = _py("routers/export_r.py")
        assert 'method = "{ALPHA_METRIC_NOMINAL}"' in src
        assert 'method = "{MAGNITUDE_ALPHA_METRIC}"' in src
        # And no restated literal survives in the IRR blocks.
        assert 'method = "nominal"' not in src
        assert 'method = "interval"' not in src

    def test_cronbachs_alpha_states_the_items_facet(self):
        src = _py("services/statistical_tests.py")
        assert '"reliability_facet": RELIABILITY_FACET_ITEMS' in src


@pytest.mark.parametrize("field", ["available", "n_coders", "per_code", "overall_alpha"])
def test_the_existing_response_fields_are_untouched(field):
    """The basis is additive: nothing about the existing payload changed."""
    assert field in IrrResponse.model_fields
