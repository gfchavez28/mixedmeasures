"""Every door that writes survey cells or rows reaches a staleness marker (#1168, #947).

🔴 **Why a derived guard.** Quick compute serves a saved metric's stored result
whenever the metric is not `stale` (`routers/metrics.py`). "Every mutation marks"
was stated in prose four times and derived from nothing (#947), and on 2026-10-10
eight doors were found that moved a metric's input without marking it (#1168) —
each written by someone who did not know the rule, or knew it and missed one arm.
A list of doors would rot exactly as the prose did. So this walks `app/`:

1. **Writers are found by what they WRITE** — a function whose body inserts,
   updates or deletes `dataset_values` / `dataset_rows`: a `DatasetValue(` or
   `DatasetRow(` constructor, a Core `insert`/`update`/`delete` of the model or its
   `__table__`, a `.query(DatasetValue|DatasetRow)` chain (or a variable holding
   one) ending in `.update`/`.delete`, an `.update({DatasetValue.col: …})`, an
   assignment to `.value_text` / `.value_numeric`, a bulk-mapping call, raw SQL
   naming either table, or a session `.delete(x)` beside the models.
2. **Doors** are the route handlers and the startup repairs
   (`services/data_repairs.py`, the boot path). A door reaches a function through
   the name-resolved call graph — calls, and functions passed as arguments
   (`asyncio.to_thread(run_data_repairs, …)`).
3. Each door that reaches a writer must reach `mark_metrics_stale` or
   `mark_metrics_stale_for_columns`, or carry an ALLOWLIST entry with its reason.

⚠️ **What it cannot see.** The check is per DOOR, not per branch: a door that marks
in one branch and writes in another passes. And a metadata edit that moves no cell
(a type, a subtype, a pairing) is not a writer here — those doors are pinned by
behaviour in `test_saved_statistics_doors.py`.

Shape chosen 2026-10-10 after a prototype: the name-resolved call graph found 22
writing doors with no false edge (each door's writer and marker read by hand), so
the #1157 fallback — a declared writer set — was not needed.
"""
from __future__ import annotations

import ast
import re
from collections import defaultdict

import pytest

from tests.guard_support import APP_DIR, app_files

TABLES = {"DatasetValue", "DatasetRow"}
TABLE_ALIASES = {"values_t", "rows_t"}
CELL_ATTRS = {"value_text", "value_numeric"}
MARKERS = {"mark_metrics_stale", "mark_metrics_stale_for_columns"}
ROUTE_METHODS = {"get", "post", "patch", "put", "delete"}
BOOT_MODULE = "services/data_repairs.py"
RAW_SQL = re.compile(r"\b(update|insert\s+into|delete\s+from)\s+dataset_(values|rows)\b", re.I)

#: Method names that are SQLAlchemy / builtin calls far more often than app
#: functions: `db.refresh(x)` must not resolve to an app function named
#: `refresh` and count as reaching it.
NOT_RESOLVED = {
    "get", "update", "delete", "add", "execute", "query", "filter", "all", "first",
    "one", "flush", "commit", "rollback", "refresh", "merge", "close", "scalar",
    "append", "extend", "items", "keys", "values", "pop", "join", "split", "strip",
    "format", "copy", "sort", "count", "index", "insert", "remove", "clear",
    "setdefault", "read", "write", "open", "load", "loads", "dump", "dumps", "run",
    "start", "stop", "send", "parse", "replace", "lower", "upper", "encode",
    "decode", "match", "search",
}

#: Doors that reach a writer and need not mark, each with its reason.
#: `test_the_allowlist_has_no_stale_entries` fails when one stops matching.
ALLOWLIST: dict[str, str] = {
    "routers/dataset.py::import_dataset":
        "creates a NEW dataset — no saved metric can name a column that did not exist",
    "routers/dataset.py::create_computed_column":
        "writes the cells of a NEW computed column — no saved metric can name it yet",
    "routers/recode.py::derive_column_endpoint":
        "writes the cells (and value labels) of a NEW derived variable — no saved "
        "metric can name it yet",
    "routers/dataset.py::link_by_column":
        "writes only `dataset_rows.participant_id` (#1054) — no saved metric or test "
        "reads a row's participant link (checked 2026-10-13); the participant-score "
        "table it can move is marked by `mark_participant_scores_stale`",
    "routers/projects.py::delete_project":
        "deletes the WHOLE project (#1035) — every saved metric and test that could "
        "read these cells and rows is deleted in the same transaction",
}


def _table_ref(node) -> bool:
    if isinstance(node, ast.Name):
        return node.id in TABLES or node.id in TABLE_ALIASES
    return (
        isinstance(node, ast.Attribute) and node.attr == "__table__"
        and isinstance(node.value, ast.Name) and node.value.id in TABLES
    )


def _chain_queries_a_table(node) -> bool:
    while isinstance(node, (ast.Call, ast.Attribute)):
        if isinstance(node, ast.Call):
            f = node.func
            if (isinstance(f, ast.Attribute) and f.attr == "query"
                    and node.args and _table_ref(node.args[0])):
                return True
            node = f
        else:
            node = node.value
    return False


def _root_name(node):
    while isinstance(node, (ast.Call, ast.Attribute)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return node.id if isinstance(node, ast.Name) else None


def _call_name(call: ast.Call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def writes(fn) -> list[str]:
    """Why this function's body writes cells or rows ([] = it does not)."""
    why: list[str] = []
    names = {n.id for n in ast.walk(fn) if isinstance(n, ast.Name)}
    query_vars = {
        t.id
        for n in ast.walk(fn) if isinstance(n, ast.Assign) and _chain_queries_a_table(n.value)
        for t in n.targets if isinstance(t, ast.Name)
    }
    for n in ast.walk(fn):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and RAW_SQL.search(n.value):
            why.append("raw SQL")
        if isinstance(n, (ast.Assign, ast.AugAssign)):
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                if isinstance(t, ast.Attribute) and t.attr in CELL_ATTRS:
                    why.append(f"assigns .{t.attr}")
        if not isinstance(n, ast.Call):
            continue
        name = _call_name(n)
        f = n.func
        if name in TABLES:
            why.append(f"constructs {name}")
        if name in {"insert", "sa_insert", "update", "sa_update", "delete", "sa_delete"} \
                and n.args and _table_ref(n.args[0]):
            why.append(f"core {name}")
        if isinstance(f, ast.Attribute) and f.attr in {"update", "delete"} and (
            _chain_queries_a_table(f.value) or _root_name(f.value) in query_vars
        ):
            why.append(f"query().{f.attr}")
        if (isinstance(f, ast.Attribute) and f.attr in {"update", "values"} and n.args
                and isinstance(n.args[0], ast.Dict)
                and any(isinstance(k, ast.Attribute) and isinstance(k.value, ast.Name)
                        and k.value.id == "DatasetValue" for k in n.args[0].keys)):
            why.append("update {DatasetValue.col: …}")
        if name in {"bulk_update_mappings", "bulk_insert_mappings", "bulk_save_objects"} \
                and n.args and _table_ref(n.args[0]):
            why.append(name)
        if (isinstance(f, ast.Attribute) and f.attr == "delete" and len(n.args) == 1
                and not n.keywords and names & TABLES):
            why.append("session.delete beside the models")
    return why


def _references(fn) -> set[str]:
    """Names this function calls, or passes as an argument."""
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
        self.units: dict[str, ast.AST] = {}
        self.doors: list[str] = []
        by_name: dict[str, list[str]] = defaultdict(list)
        for mod, source in modules.items():
            tree = ast.parse(source)
            tops = []
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    tops.append(node)
                elif isinstance(node, ast.ClassDef):
                    tops += [m for m in node.body
                             if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
            for node in tops:
                key = f"{mod}::{node.name}"
                self.units[key] = node
                by_name[node.name].append(key)
                if _is_route(node) or mod == BOOT_MODULE:
                    self.doors.append(key)
        self.writer = {k: writes(n) for k, n in self.units.items()}
        refs = {k: _references(n) for k, n in self.units.items()}
        self.calls = {k: {t for name in r for t in by_name.get(name, ())} for k, r in refs.items()}
        self.marks = {k for k, r in refs.items() if r & MARKERS}

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

    def unmarked_doors(self) -> dict[str, str]:
        """{door: the writer it reaches} for each writing door that reaches no marker."""
        out = {}
        for door in self.doors:
            writer = self.reaches(door, lambda k: bool(self.writer[k]))
            if writer and not self.reaches(door, lambda k: k in self.marks):
                out[door] = writer
        return out

    def writing_doors(self) -> set[str]:
        return {d for d in self.doors if self.reaches(d, lambda k: bool(self.writer[k]))}


@pytest.fixture(scope="module")
def graph() -> _Graph:
    files = app_files(
        floor=150,
        sentinels=(
            "routers/dataset.py", "routers/recode.py", BOOT_MODULE,
            "services/staleness.py", "services/column_retype.py",
        ),
    )
    return _Graph({p.relative_to(APP_DIR).as_posix(): p.read_text(encoding="utf-8") for p in files})


def test_the_scan_finds_the_known_writers_and_doors(graph):
    """POPULATION self-check: a scan that finds nothing passes by finding nothing."""
    writers = {k for k, why in graph.writer.items() if why}
    for known in (
        "routers/dataset.py::update_value",
        "services/column_retype.py::write_rederived_cells",
        "services/computed_columns.py::evaluate_computed_column",
        "services/recode.py::apply_definition_to_column",
        "services/project_portability.py::import_project",
        "services/withdrawal_redaction.py::apply_withdrawal",
    ):
        assert known in writers, f"the writer scan no longer sees {known} — it has gone blind"
    doors = graph.writing_doors()
    for known in (
        "routers/dataset.py::recompute_column",
        "routers/dataset.py::delete_row",
        "routers/recode.py::bulk_type_update",
        "routers/recode.py::rederive_dependents",
        f"{BOOT_MODULE}::repair_reverse_recodes",
        f"{BOOT_MODULE}::repair_missing_value_numbers",
    ):
        assert known in doors, f"the door scan no longer reaches a writer from {known}"
    assert len(writers) >= 15 and len(doors) >= 20, (len(writers), len(doors))


def test_the_predicate_actually_discriminates():
    """PREDICATE falsifier: a planted module whose door writes a cell and never
    marks must be flagged; its twin that marks must not; a door that writes no
    cell must not be a writing door at all."""
    planted = _Graph({
        "routers/planted.py": (
            "@router.post('/a')\n"
            "def writes_and_forgets(db):\n"
            "    _helper(db)\n"
            "def _helper(db):\n"
            "    q = db.query(DatasetValue).filter(DatasetValue.column_id == 1)\n"
            "    q.update({'value_numeric': None})\n"
            "@router.post('/b')\n"
            "def writes_and_marks(db):\n"
            "    _helper(db)\n"
            "    mark_metrics_stale(db, 1, column_ids=[1])\n"
            "@router.post('/c')\n"
            "def renames(db):\n"
            "    db.query(DatasetColumn).filter(DatasetColumn.id == 1).update({'column_name': 'x'})\n"
        ),
    })
    assert planted.unmarked_doors() == {
        "routers/planted.py::writes_and_forgets": "routers/planted.py::_helper",
    }
    assert "routers/planted.py::renames" not in planted.writing_doors()


def test_every_door_that_writes_cells_or_rows_reaches_a_marker(graph):
    missing = {
        door: writer for door, writer in graph.unmarked_doors().items()
        if door not in ALLOWLIST
    }
    assert not missing, (
        "These doors write survey cells or rows and never reach a staleness marker, "
        "so a saved chart, test or scale score keeps showing a number its data no "
        "longer gives (#1168):\n"
        + "\n".join(f"  {d}  (writes through {w})" for d, w in sorted(missing.items()))
        + "\nCall `mark_metrics_stale(db, project_id, column_ids=…)` with the columns "
        "whose cells moved, or allowlist the door here with the reason no saved "
        "metric can read what it wrote."
    )


def test_the_allowlist_has_no_stale_entries(graph):
    unmarked = graph.unmarked_doors()
    stale = sorted(door for door in ALLOWLIST if door not in unmarked)
    assert not stale, (
        f"{stale} are allowlisted but no longer reach an unmarked writer — remove "
        "them, or the allowlist becomes a place a real door can hide"
    )
