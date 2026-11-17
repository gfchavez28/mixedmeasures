"""#1626 (D242–D246) — the comparison and the joint display SAY how many participants have
material and no coding in scope.

They count as "did not use" every code (D5's denominator, kept), which is true only once
their material has been coded; the result states the count per group and whose coding it
is about. "Coded" is J-A's (a NON-universal code), over EVERY code — never narrowed by the
code selection — under the request's coder AND layer scope.

The fixture (the pre-implementation review's probe, plus one person coded only with a
universal code):
  A: 1001 X · 1002 X · 1003 material, no coding · 1004 only "Unclear" (universal)
  B: 2001 Y + X · 2002 Y · 2003 Y · 2004 X by coder 2 ONLY
Each assertion sits where a plausible wrong rule disagrees: a universal code counted as
coding (A 1, not 2), the code selection narrowing "coded" (B 2, not 0), every coder counted
under a coder scope (B 0, not 1), the layer ignored (consensus: 0, not 4).
"""
import asyncio
import csv
import io
import re
from pathlib import Path

import pytest

from app.models.code_application import CodeApplication
from app.models.segment import Segment
from app.models.user import User
from app.services import comparison_basis as cb
from app.services import joint_display as jd
from app.services.code_analysis import get_demographic_comparison
from tests.test_comparison_unit_1323 import DOC_COL, PID, UNCLEAR, X, Y, _Builder

TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "coding-completeness.ts"


@pytest.fixture
def fx(db_session):
    db = db_session
    b = _Builder(db)
    db.add(User(id=2, username="coder2", password_hash="x"))
    db.flush()
    b.person(1001, "A", turns=3, codes={X: 1})
    b.person(1002, "A", turns=3, codes={X: 2})
    b.person(1003, "A", turns=3)
    b.person(1004, "A", turns=3, codes={UNCLEAR: 2})
    b.person(2001, "B", turns=3, codes={Y: 1, X: 1})
    b.person(2002, "B", turns=3, codes={Y: 1})
    b.person(2003, "B", turns=3, codes={Y: 1})
    b.person(2004, "B", turns=3)
    seg = db.query(Segment).filter(Segment.speaker_id == 2004).first()
    db.add(CodeApplication(segment_id=seg.id, code_id=X, user_id=2))
    db.flush()
    return db


def _without(db, **kw):
    r = get_demographic_comparison(db, PID, group_by_column_id=DOC_COL, **kw)
    return {g: t["without_coding"] for g, t in r["group_totals"].items()}, r


def _display(db, **kw):
    rows = [jd.RowRequest(key="r", code_ids=(X,), column_ids=())]
    return jd.compute_joint_display(
        db, PID, group_by_column_id=DOC_COL, rows=rows, conversation_ids=None,
        document_ids=None, coder_ids=kw.get("coder_ids"), layer_scope=kw.get("layer_scope"),
        newcombe=False)


class TestTheCount:
    def test_every_coder_counts_a_universal_only_person_as_without_coding(self, fx):
        counts, r = _without(fx)
        assert counts == {"A": 2, "B": 0}          # 1003 and 1004 (only "Unclear")
        assert r["group_totals"]["A"]["n"] == 4     # D5's denominator is unchanged
        assert r["scope"]["no_coding_scope"] == cb.NO_CODING_SCOPE_EVERY

    def test_a_code_selection_does_not_narrow_who_is_coded(self, fx):
        # 2002 and 2003 are coded with Y only: still coded when only X is compared.
        counts, _ = _without(fx, code_ids=[X])
        assert counts == {"A": 2, "B": 0}
        # Both paths of the computation (free from the gather / its own read) agree.
        assert counts == _without(fx, code_ids=None)[0]

    def test_it_follows_the_coder_scope(self, fx):
        # 2004 is coded by coder 2 only: in coder 1's view, no coding — on both paths.
        for code_ids in (None, [X]):
            counts, r = _without(fx, coder_ids=[1], code_ids=code_ids)
            assert counts == {"A": 2, "B": 1}, code_ids
            assert r["scope"]["no_coding_scope"] == cb.NO_CODING_SCOPE_CODERS

    def test_it_follows_the_layer(self, fx):
        # No consensus has been written: nobody has consensus coding.
        for code_ids in (None, [X]):
            counts, r = _without(fx, layer_scope="consensus", code_ids=code_ids)
            assert counts == {"A": 4, "B": 4}, code_ids
            assert r["scope"]["no_coding_scope"] == cb.NO_CODING_SCOPE_CONSENSUS


class TestTheJointDisplay:
    def test_it_states_the_code_strands_denominator_and_the_count(self, fx):
        r = _display(fx)
        assert [(g["key"], g["with_material"], g["without_coding"]) for g in r["groups"]] \
            == [("A", 4, 2), ("B", 4, 0)]
        assert r["scope"]["no_coding_scope"] == cb.NO_CODING_SCOPE_EVERY
        # The comparison's own rule: equal to its count on the same request.
        assert {g["key"]: g["without_coding"] for g in r["groups"]} == _without(fx, code_ids=[X])[0]

    def test_under_a_coder_scope(self, fx):
        r = _display(fx, coder_ids=[1])
        assert [g["without_coding"] for g in r["groups"]] == [2, 1]
        assert r["scope"]["no_coding_scope"] == cb.NO_CODING_SCOPE_CODERS


def _csv(db, **kw):
    from app.routers.code_analysis import demographic_comparison_csv

    async def go():
        resp = demographic_comparison_csv(
            project_id=PID, group_by_subtype=None, code_ids=None, conversation_ids=None,
            text_column_ids=None, exclude_facilitator=True,
            participant_ids=kw.get("participant_ids"), coder_ids=kw.get("coder_ids"),
            layer_scope=None, document_ids=None, group_by_column_id=DOC_COL,
            user=db.get(User, 1), db=db,
        )
        chunks = [c async for c in resp.body_iterator]
        return "".join(c if isinstance(c, str) else c.decode() for c in chunks)
    return list(csv.reader(io.StringIO(asyncio.run(go()))))


class TestTheCsv:
    def test_it_says_the_note_above_the_header(self, fx):
        rows = _csv(fx)
        notes = [r[0] for r in rows[:next(i for i, r in enumerate(rows) if r and r[0] == "Code")]]
        assert ("Some participants have no coding here (A: 2, B: 0). They count as not using any "
                "code. If their material has not been coded yet, these shares are too low, and a "
                "group coded less far will look as if it uses codes less.") in notes

    def test_in_the_scopes_own_words(self, fx):
        rows = _csv(fx, coder_ids="1")
        assert any(r and r[0].startswith("Some participants have no coding by the coders shown "
                                          "here (A: 2, B: 1).") for r in rows)

    def test_and_says_nothing_when_no_group_has_one(self, fx):
        # Everyone in this selection is coded; the positive control is the test above.
        rows = _csv(fx, participant_ids="1001,1002,2001,2002,2003")
        assert not any(r and r[0].startswith("Some participants have") for r in rows)


class TestTheWords:
    def test_the_layer_decides_before_a_coder_scope(self):
        assert cb.no_coding_scope([1], "consensus") == cb.NO_CODING_SCOPE_CONSENSUS
        assert cb.no_coding_scope([1], "machine") == cb.NO_CODING_SCOPE_MACHINE
        assert cb.no_coding_scope([1], "human") == cb.NO_CODING_SCOPE_CODERS
        assert cb.no_coding_scope(None, None) == cb.NO_CODING_SCOPE_EVERY
        assert cb.no_coding_scope([], "human") == cb.NO_CODING_SCOPE_EVERY

    def test_no_note_when_every_group_is_zero(self):
        assert cb.no_coding_note([("A", 0), ("B", 0)], cb.NO_CODING_SCOPE_EVERY) is None


class TestCrossLanguageContract:
    """The screen and the CSV say ONE sentence: `lib/coding-completeness.ts` mirrors these."""

    def test_the_phrases_and_the_tail_are_the_clients(self):
        src = TS.read_text(encoding="utf-8")
        for scope, phrase in cb.NO_CODING_PHRASES.items():
            assert f"  {scope}: '{phrase}'," in src, scope
        assert f"export const NO_CODING_NOTE_TAIL = '{cb.NO_CODING_NOTE_TAIL}'" in src
        assert ("`Some participants have ${NO_CODING_PHRASES[scope]} here (${listed}). "
                "${NO_CODING_NOTE_TAIL}`") in src
        # Both group digits the same way (the scale corpus held 74,611 in one group).
        assert "${k.toLocaleString('en-US')}" in src
        assert cb.no_coding_note([("Maybe", 74611), ("No", 0)], cb.NO_CODING_SCOPE_EVERY) \
            .startswith("Some participants have no coding here (Maybe: 74,611, No: 0).")
        union = re.search(r"export type NoCodingScope = ([^\n]+)", src).group(1)
        assert set(re.findall(r"'(\w+)'", union)) == set(cb.NO_CODING_PHRASES)
