"""#1335 (D46–D48, 1.5.9) — a co-occurrence pair needs ONE coder to have applied both codes.

Before 1.5.9 every builder put every in-scope coder's codes for a passage into ONE
set before counting pairs, so coder A's X beside coder B's Y on one passage read as
an X–Y co-occurrence: on the Track J stress corpus 13 of 18 co-occurring pairs (72%)
existed only because two DIFFERENT people coded the passage (the 2026-11-01e review,
the internal design notes, git-ignored).

D46: a pair co-occurs on a passage when ONE coder applied both there; the passage
stays the unit and the DIAGONAL is unchanged (the passages carrying a code, by
anyone), so the matrix keeps agreeing with the frequency table beside it. At the
source level, a pair co-occurs in a source when one coder applied both somewhere in
it. One tally, `code_analysis._tally_cooccurrence`, serves all four builders and the
source level (the #733 copy-drift shape is why). D47: the rule is said on every
reader; the server's two (the CSV's first line, the Excel corner cell) are pinned in
`test_export_layer_parity.py`, the client's in `QualCooccurrence.test.tsx` and
`canvas-export.test.ts`, and the WORDS are held equal across the two languages here.

⚠️ Every fixture straddles the rule — the "cross" passage is where the old union and
the new rule disagree, and `test_the_fixture_can_tell_the_union_from_the_rule` says so
(the #707a discrimination assertion). ⚠️ The units' ids DESCEND against the order the
rows are inserted and their parents are numbered, so a builder that loses its
ORDER BY meets `CooccurrenceOrderError` instead of silently passing.
"""
import re
from datetime import datetime
from pathlib import Path

import pytest

from app.auth import get_or_create_consensus_user
from app.models import (
    Code, CodeApplication, Conversation, Document, Observation, Project, Segment, User,
)
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services import code_analysis as ca

X, Y, Z = 9001, 9002, 9003
ADA, BEN = 1, 2  # conftest's User(id=1) is "testuser"; Ben is added here

# The rule's four cases, one unit each: who applied which codes there.
CASES = {
    "cross": {ADA: {X}, BEN: {Y}},           # A's X beside B's Y: NOT a pair (the discrimination case)
    "one": {ADA: {X, Y}},                    # one coder applied both: a pair
    "both": {ADA: {X, Y}, BEN: {X, Y}},      # both coders applied the pair: ONE unit, counted once
    "diag": {ADA: {Z}, BEN: {Z}},            # one code by two coders: the diagonal counts the unit once
}
# Unit ids per case: "cross" and "one" sit in the FIRST parent with the HIGHER ids,
# "both" and "diag" in the second parent with the lower ids — a read driven by the
# parent, or by insertion order, returns them out of order.
UNIT_OFFSET = {"cross": 8, "one": 7, "both": 2, "diag": 1}
FIRST_PARENT_CASES = ("cross", "one")
INSERT_ORDER = ("cross", "both", "one", "diag")

# What the rule gives per kind, and what the old union gave.
RULE_XY, UNION_XY = 2, 3          # "one" + "both" ; + "cross"
DIAG = {X: 3, Y: 3, Z: 1}         # "cross", "one", "both" carry X and Y; "diag" carries Z

PID = 900
KIND_BASE = {"conv": 9100, "doc": 9200, "obs": 9300, "text": 9400}
FIRST_PARENT, SECOND_PARENT = 901, 902


def _seed_units(db):
    """One project holding all four kinds, each with the four cases."""
    db.add(User(id=BEN, username="Ben", coder_type="human"))
    db.add(Project(id=PID, name="Co-occurrence rule", user_id=1))
    db.flush()
    db.add_all([
        Code(id=X, project_id=PID, name="X", numeric_id=1, is_active=True, is_universal=False),
        Code(id=Y, project_id=PID, name="Y", numeric_id=2, is_active=True, is_universal=False),
        Code(id=Z, project_id=PID, name="Z", numeric_id=3, is_active=True, is_universal=False),
    ])
    for parent_id in (FIRST_PARENT, SECOND_PARENT):
        db.add_all([
            Conversation(id=parent_id, project_id=PID, name=f"Interview {parent_id}",
                         created_at=datetime(2026, 11, 2)),
            Document(id=parent_id, project_id=PID, name=f"Notes {parent_id}",
                     source_filename="n.txt", source_format="txt", created_at=datetime(2026, 11, 2)),
            Observation(id=parent_id, project_id=PID, name=f"Classroom {parent_id}",
                        created_at=datetime(2026, 11, 2)),
        ])
    db.add(Dataset(id=PID, project_id=PID, name="Survey"))
    db.flush()
    db.add_all([
        DatasetColumn(id=parent_id, dataset_id=PID, column_code=f"Q{parent_id}",
                      column_name=f"Q{parent_id}", column_text="Open feedback",
                      column_type=ColumnType.OPEN_TEXT, sequence_order=i, display_order=i)
        for i, parent_id in enumerate((FIRST_PARENT, SECOND_PARENT))
    ])
    db.flush()

    for case, offset in UNIT_OFFSET.items():
        parent = FIRST_PARENT if case in FIRST_PARENT_CASES else SECOND_PARENT
        db.add_all([
            Segment(id=KIND_BASE["conv"] + offset, conversation_id=parent, sequence_order=offset,
                    text=f"turn {case}"),
            Segment(id=KIND_BASE["doc"] + offset, document_id=parent, conversation_id=None,
                    sequence_order=offset, text=f"para {case}"),
            Segment(id=KIND_BASE["obs"] + offset, observation_id=parent, conversation_id=None,
                    sequence_order=offset, start_time=float(offset), end_time=offset + 0.5,
                    text=f"clip {case}"),
        ])
        db.add(DatasetRow(id=KIND_BASE["text"] + offset, dataset_id=PID))
        db.flush()
        db.add(DatasetValue(id=KIND_BASE["text"] + offset, row_id=KIND_BASE["text"] + offset,
                            column_id=parent, value_text=f"answer {case}"))
    db.flush()

    for case in INSERT_ORDER:
        for coder, codes in CASES[case].items():
            for code in sorted(codes):
                for kind, base in KIND_BASE.items():
                    target = (dict(dataset_value_id=base + UNIT_OFFSET[case]) if kind == "text"
                              else dict(segment_id=base + UNIT_OFFSET[case]))
                    db.add(CodeApplication(code_id=code, user_id=coder, origin="human", **target))
    db.flush()
    return PID


BUILDERS = {
    "conv": lambda db, **kw: ca._build_conversation_cooccurrence(db, PID, **kw),
    "doc": lambda db, **kw: ca._build_document_cooccurrence(db, PID, **kw),
    "obs": lambda db, **kw: ca._build_observation_cooccurrence(db, PID, **kw),
    "text": lambda db, **kw: ca._build_comment_cooccurrence(db, PID, **kw),
}


def _union_xy(cases):
    """The OLD rule, recomputed from the fixture's own literals: every coder's codes in one set."""
    return sum(1 for by in cases.values() if {X, Y} <= set().union(*by.values()))


def test_the_fixture_can_tell_the_union_from_the_rule():
    # The #707a discrimination assertion: on a fixture where the union and the rule
    # agree, every assertion below would pass under the old code.
    assert _union_xy(CASES) == UNION_XY
    assert UNION_XY != RULE_XY


class TestEveryBuilderCountsAPairOnlyWhereOneCoderAppliedBoth:
    @pytest.mark.parametrize("kind", sorted(BUILDERS))
    def test_the_pair_needs_one_coder(self, db_session, kind):
        _seed_units(db_session)
        cooccur, n_units = BUILDERS[kind](db_session)
        assert cooccur[(X, Y)] == RULE_XY, f"{kind}: coder A's X beside coder B's Y must not pair"
        assert cooccur[(Y, X)] == RULE_XY, "the matrix stays symmetric"
        assert n_units == 4, "every unit holding a code is counted, cross-coder ones included"

    @pytest.mark.parametrize("kind", sorted(BUILDERS))
    def test_the_diagonal_is_unchanged_and_counts_each_unit_once(self, db_session, kind):
        _seed_units(db_session)
        cooccur, _ = BUILDERS[kind](db_session)
        assert {c: cooccur[(c, c)] for c in (X, Y, Z)} == DIAG
        assert cooccur.get((X, Z), 0) == 0 and cooccur.get((Y, Z), 0) == 0

    @pytest.mark.parametrize("kind", sorted(BUILDERS))
    def test_one_coder_reads_exactly_as_the_union_did(self, db_session, kind):
        # A single coder in scope: the rule and the old union coincide by construction.
        _seed_units(db_session)
        ada_only = {case: {c: s for c, s in by.items() if c == ADA} for case, by in CASES.items()}
        cooccur, _ = BUILDERS[kind](db_session, coder_ids=[ADA])
        assert cooccur[(X, Y)] == _union_xy({k: v for k, v in ada_only.items() if v}) == 2

    def test_the_public_matrix_merges_the_three_segment_kinds_and_the_text_kind(self, db_session):
        _seed_units(db_session)
        result = ca.get_code_cooccurrence(db_session, PID, source="all")
        ids = [c["id"] for c in result["codes"]]
        xi, yi = ids.index(X), ids.index(Y)
        assert result["matrix"][xi][yi] == 4 * RULE_XY
        assert result["matrix"][xi][xi] == 4 * DIAG[X]
        # The heat scale's top is the largest OFF-diagonal cell, so it falls with the rule (union: 12).
        assert result["max_cooccurrence"] == 4 * RULE_XY


class TestTheConsensusLayerIsOneCoder:
    def test_a_consensus_pair_counts_and_the_human_layer_ignores_it(self, db_session):
        _seed_units(db_session)
        consensus = get_or_create_consensus_user(db_session)
        # The consensus layer holds X and Y on the "cross" turn — one (synthetic) coder.
        seg = KIND_BASE["conv"] + UNIT_OFFSET["cross"]
        db_session.add_all([
            CodeApplication(segment_id=seg, code_id=X, user_id=consensus.id, origin="consensus"),
            CodeApplication(segment_id=seg, code_id=Y, user_id=consensus.id, origin="consensus"),
        ])
        db_session.flush()
        layer, n = ca._build_conversation_cooccurrence(db_session, PID, layer_scope="consensus")
        assert (layer[(X, Y)], n) == (1, 1)
        human, _ = ca._build_conversation_cooccurrence(db_session, PID)
        assert human[(X, Y)] == RULE_XY, "consensus rows never enter the human layer's pairs"


# ── The source level: a pair co-occurs in a source when ONE coder applied both in it ──

SRC_PID = 950
# Two sources per kind. "cross": Ada's X and Ben's Y on two passages — no pair.
# "one": Ada's X and Ada's Y on two passages — a pair. The "one" source gets the
# LOWER id but its passages the HIGHER ids, and is inserted SECOND.
SRC_PARENT = {"one": 951, "cross": 952}
SRC_UNITS = {"cross": ((9551, ADA, X), (9552, BEN, Y)), "one": ((9561, ADA, X), (9562, ADA, Y))}


def _seed_sources(db):
    db.add(User(id=BEN, username="Ben", coder_type="human"))
    db.add(Project(id=SRC_PID, name="Source level", user_id=1))
    db.flush()
    db.add_all([
        Code(id=X, project_id=SRC_PID, name="X", numeric_id=1, is_active=True, is_universal=False),
        Code(id=Y, project_id=SRC_PID, name="Y", numeric_id=2, is_active=True, is_universal=False),
    ])
    for parent_id in SRC_PARENT.values():
        db.add_all([
            Conversation(id=parent_id, project_id=SRC_PID, name=f"I {parent_id}",
                         created_at=datetime(2026, 11, 2)),
            Document(id=parent_id, project_id=SRC_PID, name=f"D {parent_id}",
                     source_filename="d.txt", source_format="txt", created_at=datetime(2026, 11, 2)),
            Observation(id=parent_id, project_id=SRC_PID, name=f"O {parent_id}",
                        created_at=datetime(2026, 11, 2)),
        ])
    db.add(Dataset(id=SRC_PID, project_id=SRC_PID, name="Survey"))
    db.flush()
    db.add_all([
        DatasetColumn(id=parent_id, dataset_id=SRC_PID, column_code=f"Q{parent_id}",
                      column_name=f"Q{parent_id}", column_text="Open", column_type=ColumnType.OPEN_TEXT,
                      sequence_order=i, display_order=i)
        for i, parent_id in enumerate(SRC_PARENT.values())
    ])
    db.flush()
    for case in ("cross", "one"):  # inserted cross first: its source id is the HIGHER one
        parent = SRC_PARENT[case]
        for unit, coder, code in SRC_UNITS[case]:
            db.add_all([
                Segment(id=unit, conversation_id=parent, sequence_order=unit, text="t"),
                Segment(id=unit + 1000, document_id=parent, conversation_id=None,
                        sequence_order=unit, text="p"),
                Segment(id=unit + 2000, observation_id=parent, conversation_id=None,
                        sequence_order=unit, start_time=float(unit), end_time=unit + 0.5, text="c"),
                DatasetRow(id=unit, dataset_id=SRC_PID),
            ])
            db.flush()
            db.add(DatasetValue(id=unit, row_id=unit, column_id=parent, value_text="a"))
            db.flush()
            db.add_all([
                CodeApplication(segment_id=unit, code_id=code, user_id=coder, origin="human"),
                CodeApplication(segment_id=unit + 1000, code_id=code, user_id=coder, origin="human"),
                CodeApplication(segment_id=unit + 2000, code_id=code, user_id=coder, origin="human"),
                CodeApplication(dataset_value_id=unit, code_id=code, user_id=coder, origin="human"),
            ])
    db.flush()


class TestTheSourceLevel:
    @pytest.mark.parametrize("source,kinds", [("conversations", 3), ("text", 1), ("all", 4)])
    def test_a_source_pair_needs_one_coder(self, db_session, source, kinds):
        _seed_sources(db_session)
        cooccur, n_sources = ca.get_source_level_cooccurrence(db_session, SRC_PID, source=source)
        # Per kind: the "one" source pairs, the "cross" source does not (the union paired both).
        assert cooccur[(X, Y)] == kinds * 1
        assert cooccur[(X, X)] == kinds * 2 and cooccur[(Y, Y)] == kinds * 2, "the diagonal is unchanged"
        assert n_sources == kinds * 2

    def test_each_kind_alone(self, db_session):
        # One kind at a time, through the scoping filters, so a kind whose read lost the
        # rule cannot hide behind the others' sum.
        _seed_sources(db_session)
        foreign = [999999]
        scopes = {
            "conv": dict(source="conversations", document_ids=foreign, observation_ids=foreign),
            "doc": dict(source="conversations", conversation_ids=foreign, observation_ids=foreign),
            "obs": dict(source="conversations", conversation_ids=foreign, document_ids=foreign),
        }
        for kind, scope in scopes.items():
            cooccur, n = ca.get_source_level_cooccurrence(db_session, SRC_PID, **scope)
            assert (cooccur[(X, Y)], n) == (1, 2), kind


# ── The tally itself ─────────────────────────────────────────────────────────

class TestTheTally:
    def test_unattributed_rows_are_one_coder(self):
        # Pre-J1 rows carry no user_id; they are one coder, as a merge's "Unattributed" is.
        cooccur, n = ca._tally_cooccurrence([(1, None, X), (1, None, Y)])
        assert (cooccur[(X, Y)], n) == (1, 1)

    def test_nothing_in_nothing_out(self):
        cooccur, n = ca._tally_cooccurrence([])
        assert (dict(cooccur), n) == ({}, 0)

    def test_a_unit_that_returns_after_it_closed_is_refused(self):
        # The ORDER BY is load-bearing: a unit seen again would be counted twice.
        with pytest.raises(ca.CooccurrenceOrderError):
            ca._tally_cooccurrence([(2, ADA, X), (1, ADA, Y), (2, ADA, Y)])

    def test_rows_of_one_unit_may_arrive_in_any_coder_order(self):
        rows = [(5, BEN, Y), (5, ADA, X), (5, BEN, X), (6, ADA, Y), (6, BEN, Y)]
        cooccur, n = ca._tally_cooccurrence(rows)
        assert (cooccur[(X, Y)], cooccur[(Y, Y)], n) == (1, 2, 2)


def _tally_reads(source: str) -> list[str]:
    """The argument of every `_tally_cooccurrence(...)` call in ``source``, as source text."""
    import ast
    return [
        ast.unparse(node.args[0]) for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_tally_cooccurrence"
    ]


def test_every_read_the_tally_streams_is_ordered():
    """The ORDER BY the tally depends on, pinned in the SOURCE — because behaviour cannot.

    Session C's mutation run (the internal design notes)
    removed the ORDER BY from each read: the text read and the source level failed
    loudly (`CooccurrenceOrderError`), but the three SEGMENT builders' mutants survived
    every test — SQLite's plan happens to return their rows by segment id anyway on
    these fixtures, however the units are numbered and inserted. A query plan is not
    a contract (#1021: a plan flipped with list length), so the order is asserted here.
    """
    import inspect
    reads = _tally_reads(inspect.getsource(ca))
    # POPULATION: the four builders and the source level's one read helper.
    assert len(reads) == 5, reads
    unordered = [r for r in reads if ".order_by(" not in r]
    assert unordered == [], f"a co-occurrence read the tally streams has no ORDER BY: {unordered}"


def test_the_order_check_can_fire():
    # PREDICATE falsifier: the matcher above finds a call, and sees a missing ORDER BY.
    reads = _tally_reads("_tally_cooccurrence(query.yield_per(10))\n"
                         "_tally_cooccurrence(query.order_by(u).yield_per(10))\n")
    assert reads == ["query.yield_per(10)", "query.order_by(u).yield_per(10)"]
    assert [r for r in reads if ".order_by(" not in r] == ["query.yield_per(10)"]


# ── The words, held equal across the two languages (D47) ─────────────────────

REPO = Path(__file__).resolve().parents[2]
TS_RULE = REPO / "frontend" / "src" / "lib" / "cooccurrence-rule.ts"


def test_the_client_says_the_rule_in_the_servers_words():
    source = TS_RULE.read_text(encoding="utf-8")
    found = re.findall(r"export const COOCCURRENCE_RULE = '([^']*)'", source)
    assert len(found) == 1, f"expected one COOCCURRENCE_RULE literal in {TS_RULE}"
    assert found[0] == ca.COOCCURRENCE_RULE
