"""Cross-language pin: every `ci_method` the server sends has a client label.

`ci_method` rides the wire and `frontend/src/lib/ci-label.ts` DISPLAYS it, never
derives it (#690/#715). The two halves are hand-mirrored across languages with no
codegen between them, so nothing but this test connects them — the same shape as
`test_startup_fatal.py::TestCrossLanguageContract` and `test_aggregate_basis.py`.

**Why it matters more here than "the strings should match".** The client's
descriptor table has a deliberate fall-through: an unrecognised method gets the
plain `"95% CI"`. That default is correct for OLD payloads (rows predating
`ci_method` must not be over-qualified) and silently WRONG for a new one — a
per-category binomial interval rendered as a bare "95% CI" is precisely the false
statement `ci-label.ts` exists to prevent. TypeScript catches a value added to
the client union with no descriptor; nothing but this catches a value added to
the SERVER with no client row.

The client side is additionally `satisfies Record<CiMethod, CiDescriptor>`, so
the two guards close opposite directions of the same gap.
"""

import re
from pathlib import Path

import pytest

from app.services import metrics, reliability_intervals

CI_LABEL_TS = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "lib" / "ci-label.ts"
)

#: ⚠️ **The vocabulary lives in MORE THAN ONE module, and this test is the only
#: thing that knows it.** #43 put the reliability methods in
#: `reliability_intervals` rather than in `metrics` (IRR is not a metrics
#: surface), and a scan that walked only `metrics` would have passed while the
#: client had no descriptor for either new value — the exact silent
#: fall-through this file exists to prevent, reached from a direction the file
#: did not previously cover. A new module that mints a `CI_METHOD_*` MUST be
#: added here.
_VOCABULARY_MODULES = (metrics, reliability_intervals)


def _server_methods() -> dict[str, str]:
    """Every `CI_METHOD_*` constant the server can send, by name."""
    return {
        name: getattr(module, name)
        for module in _VOCABULARY_MODULES
        for name in dir(module)
        if name.startswith("CI_METHOD_")
    }


def _server_unavailable_reasons() -> dict[str, str]:
    """Every `CI_UNAVAILABLE_*` constant — why a coefficient has NO interval."""
    return {
        name: getattr(reliability_intervals, name)
        for name in dir(reliability_intervals)
        if name.startswith("CI_UNAVAILABLE_") and name != "CI_UNAVAILABLE_REASONS"
    }


def _client_source() -> str:
    assert CI_LABEL_TS.exists(), (
        f"{CI_LABEL_TS} not found — the client half of the ci_method contract "
        "moved. Update this path rather than deleting the test."
    )
    return CI_LABEL_TS.read_text(encoding="utf-8")


def test_the_server_declares_its_vocabulary_as_constants():
    """The population this test walks must be non-empty and plausible (#730).

    An empty `_server_methods()` would make every assertion below pass
    vacuously — the failure mode a fail-closed scan is most prone to.
    """
    found = _server_methods()
    assert len(found) >= 6, (
        f"expected at least the six known ci_method constants, found {sorted(found)}"
    )
    # Literals, not a set built from the same call: these are the fixed points
    # the rest of the test triangulates against. One per module, so a walk that
    # silently stops covering a module fails here rather than passing thinner.
    assert "wilson_per_category" in found.values()
    assert "alpha_bootstrap_units" in found.values()

    reasons = _server_unavailable_reasons()
    assert len(reasons) >= 3, f"found only {sorted(reasons)}"
    assert "single_continuum" in reasons.values()


@pytest.mark.parametrize("const_name", sorted(_server_methods()))
def test_every_server_ci_method_has_a_client_descriptor(const_name):
    value = _server_methods()[const_name]
    source = _client_source()

    # The descriptor table is keyed by the bare method name.
    key_pattern = rf"^\s*{re.escape(value)}\s*:\s*\{{"
    assert re.search(key_pattern, source, re.MULTILINE), (
        f"`ci-label.ts` has no CI_DESCRIPTORS entry for {const_name} "
        f"({value!r}).\n\n"
        "Without one it falls through to a bare '95% CI', which is the exact "
        "false statement that module exists to prevent — and no TypeScript "
        "error fires, because the fall-through is a legitimate default for "
        "payloads that predate ci_method."
    )


def test_the_client_union_lists_every_server_method():
    """The `CiMethod` union is what makes a missing descriptor a COMPILE error.

    A value present in `CI_DESCRIPTORS` but absent from the union would still
    type-check (the object is wider than the record it satisfies), so the union
    is checked separately rather than inferred from the table above.
    """
    source = _client_source()
    union = re.search(r"export type CiMethod\s*=([^\n]*(?:\n\s*\|[^\n]*)*)", source)
    assert union, "could not find the `CiMethod` union in ci-label.ts"
    declared = set(re.findall(r"'([a-z_]+)'", union.group(1)))

    missing = {v for v in _server_methods().values()} - declared
    assert not missing, (
        f"`CiMethod` in ci-label.ts is missing {sorted(missing)}. Add them to the "
        "union AND to CI_DESCRIPTORS — the union alone leaves the descriptor "
        "lookup falling through at runtime."
    )


@pytest.mark.parametrize("const_name", sorted(_server_unavailable_reasons()))
def test_every_unavailable_reason_has_a_client_sentence(const_name):
    """A coefficient with NO interval must say why (#43).

    u-α and time-binned κ sit beside coefficients that DO carry intervals, so a
    silent blank reads as an oversight rather than as the deliberate refusal it
    is. The reason rides the wire and the client renders a sentence for it; a
    value with no sentence renders nothing, which is the same silent blank.
    """
    value = _server_unavailable_reasons()[const_name]
    source = _client_source()
    key_pattern = rf"^\s*{re.escape(value)}\s*:"
    assert re.search(key_pattern, source, re.MULTILINE), (
        f"`ci-label.ts` has no CI_UNAVAILABLE_NOTES entry for {const_name} "
        f"({value!r}) — the coefficient would render a bare blank with no "
        "explanation, which is what this vocabulary exists to prevent."
    )


def test_the_client_union_lists_every_unavailable_reason():
    """`CiUnavailableReason` is what makes a missing sentence a COMPILE error."""
    source = _client_source()
    union = re.search(
        r"export type CiUnavailableReason\s*=([^\n]*(?:\n\s*\|[^\n]*)*)", source)
    assert union, "could not find the `CiUnavailableReason` union in ci-label.ts"
    declared = set(re.findall(r"'([a-z_]+)'", union.group(1)))

    missing = set(_server_unavailable_reasons().values()) - declared
    assert not missing, (
        f"`CiUnavailableReason` in ci-label.ts is missing {sorted(missing)}."
    )
