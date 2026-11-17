"""Every door that READS an analysis result asks the blind rule first (#1615).

🔴 **Why a derived guard.** #1608 withheld the participant table's rating columns at
the doors that SHOW the table; #1615 found the doors that COMPUTE over a column had
been left reading every coder's ratings, because a door table built by asking "is this
a coding view?" misses a view of VALUES DERIVED from coding (the 11-08f lesson). A
list of doors would rot the same way, so this walks `app/`:

1. **Readers are found by what they READ** — a function whose body names a metric
   OUTPUT (`ComputedResult`, `RowScore`, a saved test's `.result_data`), or calls one
   of the analysis computers that turn chosen columns into numbers (`ANALYSIS_COMPUTERS`,
   each checked to exist, so a rename cannot empty the set).
2. **Doors** are the route handlers; a door reaches a reader through the name-resolved
   call graph (`test_metric_staleness_doors.py`'s shape).
3. Each door that reaches a reader must reach `rating_withholding` (or the table's own
   `withheld_rating_column_ids`), or carry an ALLOWLIST entry with its reason.

⚠️ **What it cannot see.** Per DOOR, not per branch (a door asking in one branch and
reading in another passes); a door reading `DatasetValue` directly is not a reader here
— the doors that SHOW the table are #1608's and pinned by behaviour in
`test_blind_file_scope_1530.py`, and the behaviour of every door below is pinned in
`test_blind_rating_analysis_1615.py`. A NEW computer that reads columns without naming a
metric output joins `ANALYSIS_COMPUTERS` by hand — the residual this guard states.
"""
from __future__ import annotations

import ast
from collections import defaultdict

import pytest

from tests.guard_support import APP_DIR, app_files

OUTPUT_NAMES = {"ComputedResult", "RowScore"}
OUTPUT_ATTRS = {"result_data"}
#: The services that turn client-chosen columns into numbers without naming a metric
#: output — each must exist (`test_the_scan_finds_the_known_readers_and_doors`).
ANALYSIS_COMPUTERS = {
    "services/comparisons.py::compute_group_comparison",
    "services/correlations.py::compute_correlation_matrix",
    "services/correlations.py::compute_scatter_data",
    "services/correlations.py::compute_scatter_matrix",
    "services/cross_tabulation.py::compute_cross_tabulation",
    "services/data_quality.py::compute_missing_summary",
    "services/data_quality.py::compute_missing_patterns",
    "services/data_quality.py::compute_littles_mcar",
}
GATES = {"rating_withholding", "withheld_rating_column_ids", "withheld_rating_columns_in_project"}
ROUTE_METHODS = {"get", "post", "patch", "put", "delete"}
NOT_RESOLVED = {
    "get", "update", "delete", "add", "execute", "query", "filter", "all", "first",
    "one", "flush", "commit", "rollback", "refresh", "merge", "close", "scalar",
    "append", "extend", "items", "keys", "values", "pop", "join", "split", "strip",
    "format", "copy", "sort", "count", "index", "insert", "remove", "clear",
    "setdefault", "read", "write", "open", "load", "loads", "dump", "dumps", "run",
    "start", "stop", "send", "parse", "replace", "lower", "upper", "encode",
    "decode", "match", "search",
}

#: Doors that reach a reader and need not ask, each with its reason.
#: `test_the_allowlist_has_no_stale_entries` fails when one stops matching.
ALLOWLIST: dict[str, str] = {
    # Computing is what the shared metric IS; the response carries no number.
    "routers/metrics.py::compute_all":
        "computes every metric and returns only how many, and the errors' metric ids",
    "routers/statistical_tests.py::compute_all_tests":
        "computes every saved test and returns only how many, and the errors",
    "routers/crosswalk.py::move_members":
        "recomputes the moved groups' metrics as a side effect; returns the groups and "
        "the recomputed metric IDS, no result (`MoveMembersResponse`)",
    "routers/equivalence.py::swap_columns":
        "recomputes metrics as a side effect; returns the groups and the recomputed "
        "metric IDS, no result (`EquivalenceGroupSwapResponse`)",
    "routers/metrics.py::create_metric":
        "a NEW definition, never computed here — its response holds no results",
    "routers/metrics.py::bulk_create_metrics":
        "NEW definitions, never computed here — their responses hold no results",
    # Every coder by design (D95), or no number at all.
    "routers/project_portability.py::export_project_endpoint":
        "the .mmproject is every coder by design — the merge's transport (D95)",
    "routers/project_portability.py::duplicate_project_endpoint":
        "a whole-project copy, every coder by design (D95); returns the new project",
    "routers/project_portability.py::import_project_endpoint":
        "writes an archive's results; returns counts, no number",
    "routers/projects.py::delete_project":
        "deletes the whole project, results included; returns nothing to read",
    "routers/backup.py::backup_restore":
        "restores a backup; its repair pass reads metric DEFINITIONS, returns no number",
    "routers/backup.py::backup_restore_local":
        "restores a backup; its repair pass reads metric DEFINITIONS, returns no number",
    "routers/participants.py::get_withdrawal_report":
        "counts a person's stored scores (how many, never a value) for the withdrawal "
        "report — every coder by design: the researcher removing them must see it all",
    "routers/participants.py::withdraw_participant":
        "deletes a withdrawn person's stored scores and counts them; no value returned",
}


def _reads_output(fn) -> bool:
    for n in ast.walk(fn):
        if isinstance(n, ast.Name) and n.id in OUTPUT_NAMES:
            return True
        if isinstance(n, ast.Attribute) and (n.attr in OUTPUT_ATTRS or n.attr in OUTPUT_NAMES):
            return True
    return False


def _references(fn) -> set[str]:
    out: set[str] = set()
    for n in ast.walk(fn):
        if not isinstance(n, ast.Call):
            continue
        if isinstance(n.func, ast.Name):
            out.add(n.func.id)
        elif isinstance(n.func, ast.Attribute) and n.func.attr not in NOT_RESOLVED:
            out.add(n.func.attr)
        for arg in [*n.args, *(k.value for k in n.keywords)]:
            if isinstance(arg, ast.Name):
                out.add(arg.id)
    return out


def _is_route(fn) -> bool:
    return any(
        isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
        and d.func.attr in ROUTE_METHODS
        for d in fn.decorator_list
    )


class _Graph:
    def __init__(self, modules: dict[str, str]):
        self.doors: list[str] = []
        self.reader: dict[str, bool] = {}
        by_name: dict[str, list[str]] = defaultdict(list)
        units = {}
        for mod, source in modules.items():
            for node in ast.parse(source).body:
                fns = ([node] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else
                       [m for m in getattr(node, "body", []) if isinstance(node, ast.ClassDef)
                        and isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))])
                for fn in fns:
                    key = f"{mod}::{fn.name}"
                    units[key] = fn
                    by_name[fn.name].append(key)
                    if _is_route(fn):
                        self.doors.append(key)
        self.units = units
        self.reader = {k: (_reads_output(n) or k in ANALYSIS_COMPUTERS) for k, n in units.items()}
        refs = {k: _references(n) for k, n in units.items()}
        self.calls = {k: {t for name in r for t in by_name.get(name, ())} for k, r in refs.items()}
        self.asks = {k for k, r in refs.items() if r & GATES}

    def reaches(self, start: str, pred):
        seen, stack = set(), [start]
        while stack:
            k = stack.pop()
            if k in seen:
                continue
            seen.add(k)
            if pred(k):
                return k
            stack.extend(self.calls.get(k, ()))
        return None

    def reading_doors(self) -> dict[str, str]:
        out = {}
        for door in self.doors:
            hit = self.reaches(door, lambda k: self.reader[k])
            if hit:
                out[door] = hit
        return out

    def unasked_doors(self) -> dict[str, str]:
        return {d: r for d, r in self.reading_doors().items()
                if not self.reaches(d, lambda k: k in self.asks)}


@pytest.fixture(scope="module")
def graph() -> _Graph:
    files = app_files(floor=150, sentinels=(
        "routers/metrics.py", "routers/comparisons.py", "routers/correlations.py",
        "services/rating_withholding.py", "services/participant_scores.py",
    ))
    return _Graph({p.relative_to(APP_DIR).as_posix(): p.read_text(encoding="utf-8") for p in files})


def test_the_scan_finds_the_known_readers_and_doors(graph):
    """Population self-check: a scan that finds nothing passes every assertion below."""
    missing = sorted(k for k in ANALYSIS_COMPUTERS if k not in graph.units)
    assert not missing, f"ANALYSIS_COMPUTERS names functions that no longer exist: {missing}"
    doors = graph.reading_doors()
    for known in ("routers/metrics.py::quick_compute", "routers/metrics.py::get_row_matrix",
                  "routers/comparisons.py::group_comparison",
                  "routers/correlations.py::scatter_data",
                  "routers/statistical_tests.py::get_test",
                  "routers/data_quality.py::missing_summary"):
        assert known in doors, f"{known} is a reading door the scan cannot see"
    assert len(doors) >= 25, len(doors)


def test_the_predicate_actually_discriminates():
    """Falsifier: a door that reads a stored result without asking is caught; the same
    door asking is not."""
    src = (
        "@router.get('/x')\n"
        "def door(db):\n    return helper(db)\n"
        "def helper(db):\n    return db.query(ComputedResult).all()\n"
    )
    asked = src.replace("    return helper(db)", "    rating_withholding(db, 1, None)\n    return helper(db)")
    assert _Graph({"routers/x.py": src}).unasked_doors() == {"routers/x.py::door": "routers/x.py::helper"}
    assert _Graph({"routers/x.py": asked}).unasked_doors() == {}


def test_every_door_that_reads_an_analysis_result_asks_the_blind_rule(graph):
    unasked = {d: r for d, r in graph.unasked_doors().items() if d not in ALLOWLIST}
    assert not unasked, (
        "These doors read an analysis result (a metric's stored numbers, a record's score, "
        "a saved test, or a computation over chosen columns) without asking whether the "
        "viewer is blind (#1615). Take `coder_ids` and ask "
        "`services/rating_withholding.py::rating_withholding`, or add an ALLOWLIST entry "
        "saying why no participant rating score can reach a blind viewer through it:\n"
        + "\n".join(f"  {d}  (reaches {r})" for d, r in sorted(unasked.items()))
    )


def test_the_allowlist_has_no_stale_entries(graph):
    unasked = graph.unasked_doors()
    stale = sorted(k for k in ALLOWLIST if k not in unasked)
    assert not stale, f"ALLOWLIST entries that no longer match an unasked reading door: {stale}"
