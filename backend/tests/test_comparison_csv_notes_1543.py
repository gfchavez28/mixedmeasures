"""#1543 — the group-comparison CSV says which groups a test left out, why a row has no
test, which groups were excluded, and the degrees of freedom.

#1329 (D51) leaves a one-value group out of every test of its row and says so in four
places — under the table, in the chart strip, after the saved ANOVA's line and under
the Canvas export's table. The CSV, the fifth reader, printed the one-value group's n
and mean on the same row as an F taken WITHOUT it, with no word and no df: on #1329's
fixture, A(6) B(5) C(1), the file read `…,1,3.90,,104.43,<.001,…` — an F that is
`f_oneway(A, B)` exactly, and 52.2 over all three. A row with no test printed blanks
with no reason, and a group excluded by request vanished, though the router's own
comment said a `Scope:` line disclosed it.

The words are the SCREEN's (`lib/untested-groups.ts`, `lib/stat-format.ts`), mirrored in
`services/comparisons.py` and held equal here by reading the TypeScript.
"""
from __future__ import annotations

import asyncio
import csv
import io
import re
from pathlib import Path

import pytest
from scipy import stats

from app.models.user import User
from app.routers.comparisons import group_comparison_csv
from app.services import comparisons
from app.services.comparisons import TEST_OMITTED_CSV_TEXT, untested_groups_note
from tests.test_one_value_groups_1329 import A, B, C, GRP, GRP2, PID, Y, _seed

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib"


def _csv(db, grouping=GRP, exclude=None) -> list[list[str]]:
    resp = asyncio.run(group_comparison_csv(
        project_id=PID, column_ids=str(Y), domain_ids=None, grouping_column_id=grouping,
        grouping_column_id_2=None, test_type="auto", exclude_groups=exclude,
        nonparametric=False, user=db.get(User, 1), db=db,
    ))

    async def body():
        return b"".join([c if isinstance(c, bytes) else c.encode() async for c in resp.body_iterator])

    return list(csv.reader(io.StringIO(asyncio.run(body()).decode())))


def _row(lines, label="y"):
    header = next(l for l in lines if l and l[0] == "Variable")
    data = next(l for l in lines if l and l[0] == label)
    return dict(zip(header, data))


class TestTheFileSaysWhatTheScreenSays:
    def test_the_left_out_group_is_named_beside_the_f_taken_without_it(self, db_session):
        _seed(db_session)
        row = _row(_csv(db_session))
        assert row["C_n"] == "1"                                  # control: C is listed
        assert float(row["F"]) == pytest.approx(stats.f_oneway(A, B).statistic, abs=0.01)
        assert row["df1"] == "1" and row["df2"] == "9"            # two groups, by its df
        assert row["Note"] == (
            "C has only one value, so it is shown without an SD and left out of the tests."
        )

    def test_a_row_with_no_test_says_why(self, db_session):
        """`grp2`: A(6) and C(1) — one testable group, so no test."""
        _seed(db_session)
        row = _row(_csv(db_session, grouping=GRP2))
        assert row["p"] == ""                                      # no test
        assert row["Note"].startswith(tuple(TEST_OMITTED_CSV_TEXT.values()))
        assert row["Note"].endswith("left out of the tests.")     # and C is still named

    def test_an_excluded_group_is_named_in_a_scope_line(self, db_session):
        _seed(db_session)
        assert _csv(db_session)[0][0].startswith("Significance:")          # control
        lines = _csv(db_session, exclude="B")
        assert lines[0] == ["Scope: groups excluded: B"]
        assert "B_n" not in next(l for l in lines if l and l[0] == "Variable")


class TestTheWordsAreTheScreens:
    def test_every_reason_sentence_is_the_clients(self):
        ts = (FRONTEND / "stat-format.ts").read_text(encoding="utf-8")
        client = dict(re.findall(r"^\s+(\w+): '([^']+)',", ts, flags=re.M))
        assert len(client) >= 5, "population: the scan must find REASON_TEXT"
        for key, sentence in TEST_OMITTED_CSV_TEXT.items():
            assert client.get(key) == sentence, key

    def test_the_untested_sentence_is_the_clients(self):
        ts = (FRONTEND / "untested-groups.ts").read_text(encoding="utf-8")
        for fragment in ("has' : 'have'} only one value", "' each'", "shown without an SD and left out of the tests."):
            assert fragment in ts, fragment          # the template the Python mirrors
        assert untested_groups_note(["C"]) == (
            "C has only one value, so it is shown without an SD and left out of the tests.")
        assert untested_groups_note(["C", "D", "E"]) == (
            "C, D and E have only one value each, so they are shown without an SD and left "
            "out of the tests.")
        assert untested_groups_note([]) is None and untested_groups_note(None) is None

    def test_only_reasons_a_row_can_carry_are_mirrored(self):
        from app.services.undefined_stats import UNDEFINED_REASONS
        assert set(TEST_OMITTED_CSV_TEXT) <= UNDEFINED_REASONS
        assert hasattr(comparisons, "untested_groups_note")
