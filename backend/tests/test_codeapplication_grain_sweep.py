"""Backstop for the multi-coder ``CodeApplication``-grain class (Track J · Stream 1).

`CodeApplication`'s grain changed twice (`(target,code)` → `(target,code,coder)`
at J2-0 → + derived `origin='consensus'` rows at J2-3), creating codebase-wide
read obligations — exclude consensus, de-dup per coder, count distinct targets —
that were enforced only by *convention* (use the `coding_layers` helpers). The
convention leaked at the edges 5+ times (#441/#446/#447/#448), a textbook
sequential-reopen chain. This file is the structural backstop that ENDS the
cycle. It has two complementary parts:

**1a — Source-scan guard (fail-closed; the cycle-ender).** A static scan asserting
that no source file counts ``CodeApplication`` *rows* as if a row were a code
(``func.count(CodeApplication.id)`` — the precise tell of the retired pre-J2-0
grain). The per-surface tests never enumerated the consumer set, so a *new* or
*missed* consumer slipped through every time; this catches any such site the
instant it is added, with no per-surface bookkeeping. Genuinely-justified row
counts opt out with an inline ``# grain-allow: <reason>`` marker.

**1b — Behavioral sweep.** A multi-coder + materialized-consensus fixture (one
code applied to one segment by two humans, plus the consensus row the materializer
writes) drives representative count/usage surfaces and asserts each returns the
de-duplicated, consensus-excluded number (the right answer is **1**, never 2 or
3). 1a covers the raw-count *form* exhaustively; 1b covers the *consensus-layer*
inflation that a raw-count scan can't see (surfaces whose count is already
distinct but whose origin filter is missing — e.g. the #447 Content path).

Model: ``test_export_formula_injection.py`` (polluted-fixture sweep) + the
multi-coder fixtures in ``test_consensus.py`` / ``test_p1_workbench_consensus_exclusion.py``.
"""
import asyncio
import re
from pathlib import Path

from app.models.project import Project
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.user import User
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.auth import get_or_create_consensus_user
from app.services.consensus import materialize_consensus_for_project
from app.services.code_analysis import get_segments_with_context
from app.routers.codes import code_to_response
from app.routers.conversations import conversation_to_response
from app.routers.search import search_study


def _run(coro):
    return asyncio.run(coro)


# ── 1a. Source-scan guard ────────────────────────────────────────────────────

_APP_DIR = Path(__file__).resolve().parent.parent / "app"

# The retired-grain tell: counting application ROWS (`CodeApplication.id`) as a
# code count. `\s*` spans newlines, so a wrapped `func.count(\n  CodeApplication.id\n)`
# is caught too. Distinct-target / distinct-code forms (`func.count(func.distinct(...))`)
# and the `code_usage_count_expr()` helper do NOT match — they are the correct shapes.
_RAW_ROW_COUNT_RE = re.compile(r"func\.count\(\s*CodeApplication\.id\s*\)")


def test_no_unmarked_raw_codeapplication_row_count():
    """No source file may count CodeApplication rows as a code/usage count.

    Under per-coder layers + the consensus layer this over-counts (N coders → N
    rows; consensus → +1). Route through ``code_usage_count_expr()`` /
    ``non_consensus_filter()`` (or ``func.count(func.distinct(code_id/target))``).
    A genuine row count (rare) opts out with an inline ``# grain-allow: <reason>``
    comment on the same or preceding line. This guard is what the per-surface
    inflation tests never had: it fails the instant a NEW raw-count site appears.
    """
    violations: list[str] = []
    for path in sorted(_APP_DIR.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        if not _RAW_ROW_COUNT_RE.search(text):
            continue
        lines = text.splitlines()
        for m in _RAW_ROW_COUNT_RE.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            context = " ".join(lines[max(0, line_no - 2):line_no])
            if "grain-allow" in context:
                continue
            rel = path.relative_to(_APP_DIR.parent)
            violations.append(f"{rel}:{line_no}: {lines[line_no - 1].strip()}")

    assert not violations, (
        "Raw `func.count(CodeApplication.id)` counts application ROWS as if a row were "
        "a code (the retired pre-J2-0 grain). Under per-coder layers + consensus this "
        "inflates the count. Route through code_usage_count_expr()/non_consensus_filter() "
        "or func.count(func.distinct(code_id)) — or, if it is a genuine row count, mark the "
        "line `# grain-allow: <reason>`.\n  " + "\n  ".join(violations)
    )


# ── 1b. Behavioral sweep — multi-coder + materialized consensus ──────────────

_PID = 8800
_CONV = 8800
_SEG = 88000
_CODE = 88100
_CODE_NAME = "GrainTheme"


def _multicoder_consensus_fixture(db):
    """One conversation + one segment; code applied to that segment by TWO human
    coders, then real consensus materialized (writes one ``origin='consensus'``
    row on the segment). The unambiguous "right answer" for every count of this
    code / segment / conversation is therefore **1** — not 2 (per-coder rows) and
    not 3 (per-coder + consensus). Returns the consensus user id.
    """
    db.add_all([
        Project(id=_PID, name="Grain", user_id=1),
        Conversation(id=_CONV, project_id=_PID, name="C"),
        Segment(id=_SEG, conversation_id=_CONV, sequence_order=0, text="agreed segment"),
        User(id=2, username="Coder B", password_hash=None, coder_type="human"),
        Code(id=_CODE, project_id=_PID, name=_CODE_NAME, numeric_id=2,
             is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=_CODE, user_id=1, segment_id=_SEG),
        CodeApplication(code_id=_CODE, user_id=2, segment_id=_SEG),
    ])
    db.flush()
    materialize_consensus_for_project(db, _PID)  # → 1 unanimous consensus row on _SEG
    db.flush()
    return get_or_create_consensus_user(db).id


def test_reference_usage_count_is_one(db_session):
    """Control: the authoritative count helper (`code_usage_count_expr` +
    `non_consensus_filter`, the reference impl at codes.py:46) returns 1 — proves
    the fixture's unambiguous right answer and that the control path is correct."""
    db = db_session
    consensus_id = _multicoder_consensus_fixture(db)
    # sanity: the table really does hold 3 rows (2 human + 1 consensus) for this code
    assert db.query(CodeApplication).filter(CodeApplication.code_id == _CODE).count() == 3
    assert consensus_id not in (1, 2)
    assert code_to_response(db.get(Code, _CODE), db).usage_count == 1


def test_search_usage_badge_not_inflated(db_session):
    """#448(a): the Cmd-K code search usage badge must not count per-coder rows
    or the consensus layer."""
    db = db_session
    _multicoder_consensus_fixture(db)
    resp = _run(search_study(
        project_id=_PID, q=_CODE_NAME, types="codes", limit=5,
        full_type=None, quoted=None, user=db.get(User, 1), db=db,
    ))
    item = next(c for c in resp.codes.items if c.id == _CODE)
    assert item.usage_count == 1, "search usage badge inflated by per-coder rows / consensus"


def test_content_focal_codes_distinct_and_consensus_excluded(db_session):
    """#447: the qualitative Content tab's per-segment focal code list (the main
    analysis path) must be DISTINCT and exclude the consensus layer — the source
    of the #441 key collision and consensus inflation."""
    db = db_session
    _multicoder_consensus_fixture(db)
    result = get_segments_with_context(db, _PID, _CODE, context_size=1, exclude_facilitator=False)
    focal = next(
        (seg for conv in result["conversations"] for seg in conv["segments"] if seg["id"] == _SEG),
        None,
    )
    assert focal is not None, "focal segment should be returned"
    assert focal["applied_code_ids"] == [_CODE], (
        "focal codes must be distinct + consensus-excluded "
        f"(got {focal['applied_code_ids']!r})"
    )


def test_conversation_card_code_count_excludes_consensus(db_session):
    """#448(e), contract: the conversation-card distinct code count must exclude
    consensus. (In this fixture the consensus row reuses the human code_id so the
    distinct count is unchanged — this asserts the contract; the per-coder/raw
    inflation it guards against is exercised by the search + focal-codes cases and
    the source-scan guard.)"""
    db = db_session
    _multicoder_consensus_fixture(db)
    resp = conversation_to_response(db.get(Conversation, _CONV), db)
    assert resp.code_count == 1
