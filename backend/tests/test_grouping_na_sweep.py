"""#597 / #384 — the recognized-N/A grouping rule on the text-analysis
surfaces, plus the source sweep that keeps the grouping-map query in ONE place.

Behavioral half: ``cross_tabulation`` and ``code_density`` built their grouping
from hand-rolled ``{row_id: value_text}`` queries that never applied ``_is_na``
and never routed through ``grouping.load_grouping_values`` — so the SAME
demographic column yielded a real "Decline to state" cross-tab column and a
real code-density group on the text-analysis surfaces while folding into the
missing bucket on every quantitative surface (the #593 class, two more
surfaces). Reproduced by execution before fixing
(the internal design notes).

Source-scan half (fail-closed, the #592-plan §I.9 slice): the grouping-map
select shapes must not reappear outside ``services/grouping.py``. Round 2 of
the #592 scope found four sites the round-1 hand inventory missed
(#597/#598/#599) — hand sweeps of this rule rot (#450/#552/#553 precedent), so
the shape is pinned by scan. The scan is deliberately best-effort (it catches
the exact two-/three-column select shapes, not every conceivable regrouping
query); the behavioral tests are the ground truth.
"""
import asyncio
import re
from pathlib import Path

from app.models.user import User
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.routers.text_analysis import code_density, cross_tabulation
from app.schemas.text_analysis import CrossTabulationRequest
from app.services.grouping import load_grouping_values

PID = 972
TEXT_COL = 9720
CROSS_COL = 9721
CODE_A = 9725


def _run(coro):
    return asyncio.run(coro)


def _setup(db):
    """Three respondents — Female / Male / "Decline to state" — each with a
    substantive, coded comment. Pre-fix, the declined respondent formed a real
    third group on both text-analysis surfaces."""
    db.add_all([
        Project(id=PID, name="Grouping NA", user_id=1),
        Dataset(id=PID, project_id=PID, name="Survey"),
        DatasetColumn(id=TEXT_COL, dataset_id=PID, column_code="Q1",
                      column_name="Comments", column_text="Any comments?",
                      column_type="open_text", sequence_order=0, display_order=0),
        DatasetColumn(id=CROSS_COL, dataset_id=PID, column_code="Q2",
                      column_name="Gender", column_text="Gender",
                      column_type="nominal", sequence_order=1, display_order=1),
        Code(id=CODE_A, project_id=PID, name="Theme", color="#222222",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    for i, group in enumerate(["Female", "Male", "Decline to state"], start=1):
        row_id = 9720 + i
        db.add(DatasetRow(id=row_id, dataset_id=PID))
        db.flush()
        dv = DatasetValue(id=97200 + i, row_id=row_id, column_id=TEXT_COL,
                          value_text=f"comment {i}", word_count=2)
        db.add_all([
            dv,
            DatasetValue(id=97210 + i, row_id=row_id, column_id=CROSS_COL,
                         value_text=group),
        ])
        db.flush()
        db.add(CodeApplication(dataset_value_id=dv.id, code_id=CODE_A, user_id=1))
    db.flush()


def test_cross_tabulation_excludes_recognized_na(db_session):
    """#597a: the cross-tab axis and totals exclude the N/A label, matching
    the quantitative reference path (``load_grouping_values``)."""
    _setup(db_session)
    user = db_session.get(User, 1)

    ref = load_grouping_values(db_session, CROSS_COL, None)
    assert "Decline to state" not in set(ref.values())  # the reference path

    resp = _run(cross_tabulation(
        project_id=PID,
        body=CrossTabulationRequest(
            text_column_ids=[TEXT_COL], cross_column_id=CROSS_COL,
        ),
        db=db_session, user=user,
    ))
    assert resp.response_values == ["Female", "Male"]
    assert "Decline to state" not in resp.column_totals
    # The declined respondent's coded comment counts toward NO column.
    assert resp.total_coded_texts == 2


def test_code_density_excludes_recognized_na(db_session):
    """#597b: a recognized-missing label never forms a code-density group."""
    _setup(db_session)
    user = db_session.get(User, 1)

    resp = _run(code_density(
        project_id=PID, column_ids=str(TEXT_COL),
        group_by_column_id=CROSS_COL,
        coder_ids=None, layer_scope=None,
        db=db_session, user=user,
    ))
    assert [g.group_value for g in resp.groups] == ["Female", "Male"]
    # Overall keeps ALL substantive comments — the #519 denominator is about
    # text substance, not the grouping column.
    assert resp.overall.text_count == 3


# ── Source sweep ─────────────────────────────────────────────────────────────

APP_DIR = Path(__file__).resolve().parents[1] / "app"

# The grouping-map select shapes. The `,?\s*\)` terminator excludes the
# four-column (…, value_text, value_numeric) VALUE loads, which are cell reads,
# not grouping maps.
TWO_COL_SHAPE = re.compile(
    r"DatasetValue\.row_id\s*,\s*DatasetValue\.value_text\s*,?\s*\)"
)
THREE_COL_SHAPE = re.compile(
    r"DatasetValue\.row_id\s*,\s*DatasetValue\.column_id\s*,"
    r"\s*DatasetValue\.value_text\s*,?\s*\)"
)

# Sites allowed to carry the three-column shape, with reasons. Pin the
# EXPECTED set — a new site (or a vanished one) must fail the suite, never be
# silently aggregated in.
THREE_COL_ALLOWLIST = {
    "services/grouping.py": 1,
    # THE loader itself (#592 slab 2: selects column_id so each value is
    # judged by ITS column's declared rules).
    "services/code_analysis.py": 2,
    # 1) _build_participant_group_map — participant-keyed grouping (#598):
    #    applies the missing rule in place (column-aware since #592 slab 2);
    #    not expressible through the row-keyed loader.
    # 2) get_demographic_filter_options — filter OPTIONS are subsetting, not
    #    grouping; offering "Decline to state" as a selectable filter value is
    #    deliberate.
}

# ── Bare `_is_na(` call sites (#592 §I.9, the second half) ───────────────────
# The missing decision is COLUMN-AWARE since slab 2: read surfaces route
# through services/missing_values (`is_missing` / `is_missing_for_column`),
# where a declared rule list REPLACES the `_is_na` defaults. A NEW bare
# `_is_na(` call re-hardcodes the defaults and makes that surface disagree
# with declared columns — the exact drift this arc keeps paying for
# (#381→#384→#593→#597/#598). services/missing_values.py is the owner and is
# excluded from the scan. Every allowed site below is WRITE/IMPORT-time,
# where declarations cannot exist yet or are slab-3 territory:
IS_NA_CALL = re.compile(r"\b_is_na\(")
IS_NA_ALLOWLIST: dict[str, int] = {
    # EMPTY as of #592 slab 5 — every call site now routes through the
    # column-aware `is_missing`. The last one was `preview_dataset_csv`'s type
    # detection + na_count, which looked genuinely preview-time ("no column
    # exists yet, so no declaration can") — until .sav turned out to carry its
    # own declaration BEFORE any column exists. It now takes
    # `missing_rules_by_column`; a column with no entry still gets the defaults,
    # which is the same behavior by a column-aware route.
    #
    # `_is_na` survives only as the DEFAULT rule set inside the predicate
    # module. A new bare call here means a surface decided missing-ness for
    # itself instead of asking the column — the failure this scan exists for.
}


# ── The scan's own population (#730) ─────────────────────────────────────────
# Every arm below asserts an EXPECTED set, and TWO of those sets are empty —
# `assert hits == {}` and `assert hits == IS_NA_ALLOWLIST`, the latter emptied by
# the successful #592 slab-5 cleanup. That assertion shape passes just as happily
# when the scan finds nothing AT ALL, and `Path.rglob` on a mistyped root yields
# `[]` rather than raising (measured, 3.12.3). So one typo in `APP_DIR` would
# silently convert both arms into permanent passes — including the `_is_na` arm
# this project cites as proof the #592 class is closed.
#
# The population is therefore asserted INSIDE `_scan`, not in a test beside it:
# the protection travels with every caller, present and future, instead of
# depending on whoever adds the fourth arm remembering that it needs one.
_MIN_APP_FILES = 100  # 163 as of 2026-08-09 — a floor for a BAD ROOT, not a growth pin
_POPULATION_SENTINELS = (
    "services/missing_values.py",  # the predicate owner (excluded from the _is_na arm)
    "services/grouping.py",        # THE loader, and an allowlisted three-column site
)


def _app_files() -> list[Path]:
    """Every `app/` module, with the walk proven non-vacuous before it is used."""
    files = sorted(APP_DIR.rglob("*.py"))
    assert len(files) >= _MIN_APP_FILES, (
        f"This sweep's population is {len(files)} file(s) under {APP_DIR} — "
        f"expected at least {_MIN_APP_FILES}. The scan is looking at the wrong "
        "tree, and because rglob returns [] for a bad path instead of raising, "
        "every assertion in this file would otherwise pass VACUOUSLY (#730). "
        "Fix APP_DIR — do NOT lower this floor."
    )
    rels = {p.relative_to(APP_DIR).as_posix() for p in files}
    missing = [s for s in _POPULATION_SENTINELS if s not in rels]
    assert not missing, (
        f"This sweep cannot see {missing} under {APP_DIR}. A file COUNT alone "
        "cannot tell this tree from some other tree that also contains .py "
        "files; these are the modules the sweep exists to police, so their "
        "absence means the root is wrong even though the count looked fine."
    )
    return files


def test_the_sweep_can_see_the_app_tree():
    """Guard the guard (#730): name the vacuity failure on its own, so a broken
    root reports as 'the scan is blind' rather than as three passing arms.

    `_scan` asserts this too — that is the load-bearing copy, because it cannot
    be forgotten by a future arm. This test exists so the failure has a name.
    """
    assert len(_app_files()) >= _MIN_APP_FILES


def _scan(pattern: re.Pattern, *, exclude: set[str] = frozenset()) -> dict[str, int]:
    hits: dict[str, int] = {}
    for path in _app_files():
        rel = path.relative_to(APP_DIR).as_posix()
        if rel in exclude:
            continue
        count = len(pattern.findall(path.read_text()))
        if count:
            hits[rel] = count
    return hits


def test_grouping_map_two_col_shape_is_extinct():
    """#597 sweep: the two-column ``{row_id: value_text}`` grouping-map select
    exists NOWHERE — even the loader now selects column_id (#592 slab 2), so
    any occurrence is a new hand-rolled copy of the #593/#597 bug class."""
    hits = _scan(TWO_COL_SHAPE)
    assert hits == {}, (
        f"Hand-rolled grouping-map query found: {hits}. Route it through "
        "grouping.load_grouping_values (#384/#593/#597)."
    )


def test_participant_keyed_grouping_sites_are_pinned():
    """#598 sweep: the three-column (row_id, column_id, value_text) select set
    is pinned. A new site that groups rows or participants by value_text MUST
    apply the missing rule (route through grouping.load_grouping_values, or
    apply it in place like _build_participant_group_map) — then extend the
    allowlist with a reason."""
    hits = _scan(THREE_COL_SHAPE)
    assert hits == THREE_COL_ALLOWLIST, (
        f"Three-column grouping-shape select set changed: {hits} vs allowlist "
        f"{THREE_COL_ALLOWLIST}. See this test's docstring before touching "
        "the allowlist."
    )


def test_bare_is_na_call_sites_are_pinned():
    """#592 §I.9: bare ``_is_na(`` calls outside the predicate module fail the
    suite. New read surfaces call ``is_missing``/``is_missing_for_column``
    (column-aware); the allowlist is write/import-time only, each with its
    reason and its converting slab."""
    hits = _scan(IS_NA_CALL, exclude={"services/missing_values.py"})
    assert hits == IS_NA_ALLOWLIST, (
        f"Bare _is_na( call set changed: {hits} vs allowlist "
        f"{IS_NA_ALLOWLIST}. A READ surface must use the column-aware "
        "predicate (services/missing_values.is_missing); only write/import "
        "paths may stay on the defaults until their slab converts them — "
        "then update the allowlist with a reason."
    )
