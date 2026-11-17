"""Joint display slice 2, round 2 (r5) — what the case view's UI and the export ask of the case read.

r5-6: the answer NAMES the cases the researcher added or removed (identifier + group), so the
open construct's lists and the export's note can print them whatever page was read — and
never a rule-selected case, which is counted, not named (r3-11, Kaiser 2009). r5-7: ``limit``
0 is the count alone, the read the open construct, the Report view and the export make.

The fixture is r3's (`test_joint_display_slice2_cases.py`): High = T1..T3, Low = T4..T6, T7
has no group.
"""

from __future__ import annotations

from app.schemas.joint_display import JointDisplayCasesRequest, JointDisplayCasesResponse
from tests import test_joint_display_slice2_cases as r3
from tests.test_joint_display_slice2_cases import _read, fx  # noqa: F401 — fixture

RULE = r3.TestTheRule.HIGH_FEW_HOURS  # selects T2 only

T1, T2, T4, T5, T7 = 26501, 26502, 26504, 26505, 26507


class TestNamedCases:
    def test_the_added_and_removed_are_named_with_their_group(self, fx):  # noqa: F811
        out = _read(fx, rule=RULE, added=[T5, T7, 99], removed=[T2],
                    only="all", limit=1)
        assert out["named_cases"] == [
            {"participant_id": T2, "label": "T2", "group": "High"},
            {"participant_id": T5, "label": "T5", "group": "Low"},
            # T7 has no group: named, with no group; 99 names no one here, so it is absent.
            {"participant_id": T7, "label": "T7", "group": None},
        ]

    def test_a_rule_selected_case_is_never_named(self, fx):  # noqa: F811
        # The rule selects T2 only; nothing was added or removed — so no one is named.
        out = _read(fx, rule=RULE, limit=0)
        assert out["matched"] == 1 and out["named_cases"] == []

    def test_the_wire_carries_them(self, fx):  # noqa: F811
        out = _read(fx, added=[T4], limit=0)
        assert JointDisplayCasesResponse.model_validate(out).named_cases[0].label == "T4"


class TestTheCountAlone:
    def test_limit_0_is_the_count_with_no_persons_facts(self, fx):  # noqa: F811
        out = _read(fx, rule=RULE, limit=0)
        assert out["cases"] == []
        assert (out["total"], out["matched"]) == (6, 1)
        # control: the same read with a page carries the facts, and the same count
        page = _read(fx, rule=RULE, limit=50)
        assert len(page["cases"]) == 6 and (page["total"], page["matched"]) == (6, 1)

    def test_the_request_accepts_0(self):
        assert JointDisplayCasesRequest(group_by_column_id=1, row_key="r", limit=0).limit == 0
