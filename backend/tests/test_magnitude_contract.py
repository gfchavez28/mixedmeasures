"""#35 — the two `describe` implementations must not drift apart.

`services/magnitude.py::describe_value` and `frontend/src/lib/magnitude.ts::
describeMagnitude` produce THE SAME SENTENCE about a rating. The screen reads one;
anything the server renders (an export, a future report) reads the other. A silent
divergence would mean the same number is described two ways, and nothing in either
suite would notice — each side would keep passing its own tests.

Direction is deliberate: **Python reads the TypeScript**, the house pattern already
used by `test_ci_method_contract.py`. The alternative — a JS test shelling out to
Python — needs a runtime the frontend suite does not have.

⚠️ **This checks the SENTENCE FORMS, not a full parse.** A JS interpreter here would
be a second implementation of the thing under test. What it catches is the realistic
failure: one side's wording is edited and the other is not.
"""
from pathlib import Path

import pytest

from app.models.code import Code
from app.services import magnitude

TS_SOURCE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "magnitude.ts"


def _code(**kw):
    """A detached Code carrying just the scale columns — no DB needed."""
    c = Code(name=kw.pop("name", "District support"), numeric_id=2, project_id=1)
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def test_the_typescript_mirror_exists_where_this_test_expects_it():
    """A path self-check.

    `Path.read_text` on a moved file raises, but a scan that merely *searches* a
    file it cannot find would degrade to silence — #729's rule. This asserts the
    target before anything reads it.
    """
    assert TS_SOURCE.is_file(), f"the client mirror moved; update this contract: {TS_SOURCE}"


@pytest.mark.parametrize(
    "phrase",
    ["not rated", "out of", "on a scale from"],
)
def test_the_two_describe_implementations_agree(phrase):
    """Each sentence form the client emits is one the server also emits.

    The three forms are load-bearing and mean different things:
      - `not rated`        — UNRATED, and never the string "0".
      - `out of`           — a zero-based scale, the natural reading.
      - `on a scale from`  — any other scale, because "−0.5 out of 1" invites the
                             reader to assume a floor of zero.
    """
    ts = TS_SOURCE.read_text(encoding="utf-8")
    assert phrase in ts, f"the client no longer emits {phrase!r}"

    zero_based = _code(magnitude_min=0.0, magnitude_max=10.0, magnitude_step=1.0)
    bipolar = _code(magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5)

    produced = {
        magnitude.describe_value(zero_based, None),
        magnitude.describe_value(zero_based, 8.0),
        magnitude.describe_value(bipolar, -0.5),
    }
    assert any(phrase in p for p in produced), (
        f"the server no longer emits {phrase!r}; the client still does"
    )


def test_a_zero_based_scale_reads_out_of_on_BOTH_sides():
    zero_based = _code(magnitude_min=0.0, magnitude_max=10.0, magnitude_step=1.0)
    assert magnitude.describe_value(zero_based, 8.0) == "8 out of 10"
    # The client's branch condition, asserted as source: `scale.min === 0`.
    assert "scale.min === 0" in TS_SOURCE.read_text(encoding="utf-8")


def test_unrated_is_the_word_on_BOTH_sides_and_never_a_zero():
    """🔴 The rule the whole feature turns on.

    Asserted here as well as in the unit suites because this is the one place both
    implementations are in view at once.
    """
    bipolar = _code(magnitude_min=-1.0, magnitude_max=1.0, magnitude_step=0.5)
    assert magnitude.describe_value(bipolar, None) == "not rated"
    # And a real zero is NOT that.
    assert magnitude.describe_value(bipolar, 0.0) != "not rated"

    ts = TS_SOURCE.read_text(encoding="utf-8")
    # The client's unrated predicate must stay `== null`, which catches
    # null/undefined and NOT 0. A `!value` would pass every other assertion here.
    assert "return value == null" in ts, (
        "the client's isUnrated is no longer a null check — a truthiness test "
        "would render a real zero rating as 'not rated'"
    )
