"""#1424 — the group comparison's `effect_size_type` is a stated basis, and the client names
the effect size from it (`frontend/src/lib/group-comparison-display.ts`), never from the test
type or the group count.

The names are hand-mirrored (no codegen), so this is the cross-language contract
(the internal design notes: the client's fallback for an unknown type is to call it
"effect size", which is right for a payload from a newer server and invisible for a type this
server sends that the client never learned). It is BEHAVIOURAL on the Python side: the four
runners are called through `_run_test` and the types they actually emit are read — the
service mints them as literals, so a constant scan would find nothing.
"""
import re
from pathlib import Path

from app.services.comparisons import _run_test

TS_MIRROR = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "group-comparison-display.ts"
)

# Each test's data, chosen so it computes (no ties to zero, no constant group).
_GROUPS2 = {"a": [3.0, 4.0, 4.0, 5.0, 5.0, 6.0], "b": [2.0, 3.0, 3.0, 4.0, 2.0, 1.0]}
_GROUPS3 = {**_GROUPS2, "c": [6.0, 7.0, 5.0, 8.0, 7.0, 6.0]}
_CASES = {
    "independent_t_test": (_GROUPS2, False),
    "one_way_anova": (_GROUPS3, False),
    "mann_whitney_u": (_GROUPS2, True),
    "kruskal_wallis": (_GROUPS3, True),
}


def _emitted_types() -> dict[str, str]:
    out = {}
    for test_type, (grouped, nonparametric) in _CASES.items():
        result, reason = _run_test(grouped, list(grouped), test_type, True, nonparametric=nonparametric)
        assert reason is None, f"{test_type} did not compute: {reason}"
        out[test_type] = result["effect_size_type"]
    return out


def _mirrored() -> dict[str, str]:
    return dict(re.findall(r"export const (EFFECT_SIZE_\w+) = '([^']+)'", TS_MIRROR.read_text(encoding="utf-8")))


class TestCrossLanguageContract:
    def test_every_emitted_type_is_named_on_the_client_and_nothing_else(self):
        emitted = set(_emitted_types().values())
        assert len(emitted) == 4, "population: one effect size per runner"
        assert set(_mirrored().values()) == emitted

    def test_a_new_type_is_a_compile_error_on_the_client(self):
        assert "satisfies Record<EffectSizeType, EffectSizeName>" in TS_MIRROR.read_text(encoding="utf-8")

    def test_the_omega_override_still_rides_beside_eta(self):
        # The client shows ω² where the wire's effect size is η² AND ω² is sent with it
        # (statistics.md §3); the override is keyed on that pairing, so it is pinned here.
        result, _ = _run_test(_GROUPS3, list(_GROUPS3), "one_way_anova", True)
        assert result["effect_size_type"] == "eta_squared"
        assert result["omega_squared"] is not None
        for test_type, (grouped, nonparametric) in _CASES.items():
            if test_type != "one_way_anova":
                other, _ = _run_test(grouped, list(grouped), test_type, True, nonparametric=nonparametric)
                assert other.get("omega_squared") is None, test_type
