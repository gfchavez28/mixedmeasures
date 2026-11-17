"""Every door that deletes turns or answers takes their edit wording out of the trail (#1546 D161).

🔴 **Why a derived guard.** #1546 was a door population nobody had enumerated: a
conversation, a dataset, a record and a column delete each removed rows whose audit
entries kept a person's words, and a later withdrawal could not reach them. A list of doors
rots as soon as a new one is written, so this walks `app/` the way
`test_metric_staleness_doors.py` does (and imports its call-graph helpers rather than
copying them, #733):

1. **Writers are found by what they DELETE** — a function whose body deletes a row of a
   table whose delete takes turns or answers with it: a session `.delete(x)` beside one of
   those models, a Core `delete(...)` of the model, its `__table__` or an alias
   (`rows_t`, `values_t`), a `.query(Model)` chain ending in `.delete`, or raw SQL.
2. **Doors** are the route handlers and the startup repairs.
3. Each door that reaches such a writer must reach `strip_deleted_conversation_words` or
   `strip_deleted_answer_words`, or carry an ALLOWLIST entry saying why its rows' entries
   hold no one's words, or are another rule's.

⚠️ **What it cannot see** (the staleness guard's limits, inherited): the check is per DOOR,
not per branch, and a call the name-resolved graph cannot follow is invisible.
"""
from __future__ import annotations

import ast
import re

import pytest

from tests.guard_support import APP_DIR, app_files
from tests.test_metric_staleness_doors import (
    BOOT_MODULE,
    NOT_RESOLVED,
    _call_name,
    _is_route,
    _references,
    _root_name,
)

#: Tables whose delete takes turns or answers with it (directly, or by cascade).
MODELS = {
    "Conversation", "Segment", "Dataset", "DatasetRow", "DatasetColumn", "DatasetValue",
    "Document", "Observation", "Project",
}
ALIASES = {"rows_t", "values_t"}
RAW_SQL = re.compile(
    r"\bdelete\s+from\s+(segments|dataset_values|dataset_rows|dataset_columns|datasets|"
    r"conversations|documents|observations|projects)\b", re.I,
)
STRIPPERS = {"strip_deleted_conversation_words", "strip_deleted_answer_words"}

#: Doors that delete turns or answers and need not strip, each with its reason.
#: `test_the_allowlist_has_no_stale_entries` fails when one stops matching.
ALLOWLIST: dict[str, str] = {
    "routers/projects.py::delete_project":
        "the WHOLE project goes, and its audit history with it (#1230 "
        "`forget_project_audit`, in the same transaction)",
    "routers/project_portability.py::import_project_endpoint":
        "an OVERWRITE replaces the project through `delete_project_tree`, and #1230 moves "
        "its history to the new id; a merge deletes no turn or answer",
    "routers/documents.py::delete_document":
        "the document door's edit entry records lengths, never words (D6, "
        "`excerpt-shapes.md` §4)",
    "routers/observations.py::delete_observation":
        "an observation's clips have no speaker and their text is the researcher's label",
    "routers/observations.py::delete_clip":
        "a clip's text is the researcher's label; its entries hold times and labels",
    "routers/participants.py::withdraw_participant":
        "the withdrawal redacts its own person's entries (D9), each within its own "
        "lifetime (#1547 D159)",
    "routers/project_portability.py::duplicate_project_endpoint":
        "a Duplicate imports a NEW project; `delete_project_tree` is the overwrite branch "
        "of the import it shares, which a duplicate never takes",
    # An Unmerge or Unsplit deletes the merge result or the split's children, and must
    # NOT strip them: `withdrawal_history.deleted_lineage` finds them again from the trail
    # and needs their edits' words to match a canvas quote across the join (#1473 b).
    # A conversation delete takes that lineage with it (D157).
    "routers/segments.py::unmerge_segments_endpoint":
        "#1473 (b): the walk needs a deleted merge result's edit wording",
    "routers/segments.py::unsplit_segment_endpoint":
        "#1473 (b): the walk needs a deleted split child's edit wording",
    "routers/documents.py::unmerge_document_segment":
        "a document passage's edit entry records lengths, never words (D6)",
    "routers/documents.py::unsplit_document_segment":
        "a document passage's edit entry records lengths, never words (D6)",
    "routers/observations.py::unmerge_clip":
        "a clip's text is the researcher's label; its entries hold times and labels",
    "routers/observations.py::unsplit_observation_clip":
        "a clip's text is the researcher's label; its entries hold times and labels",
}


def _model_ref(node) -> bool:
    if isinstance(node, ast.Name):
        return node.id in MODELS or node.id in ALIASES
    return (
        isinstance(node, ast.Attribute) and node.attr == "__table__"
        and isinstance(node.value, ast.Name) and node.value.id in MODELS
    )


def _chain_queries_a_model(node) -> bool:
    while isinstance(node, (ast.Call, ast.Attribute)):
        if isinstance(node, ast.Call):
            f = node.func
            if (isinstance(f, ast.Attribute) and f.attr == "query"
                    and node.args and _model_ref(node.args[0])):
                return True
            node = f
        else:
            node = node.value
    return False


#: What a variable holding one of those rows is called where it is not bound by a query
#: here (`dataset = _get_dataset_or_404(…)`, `document = _get_document_or_404(…)`).
MODEL_VAR_NAMES = {
    "conversation", "dataset", "row", "column", "segment", "seg", "document",
    "observation", "project",
}


def _gets_a_model(node) -> bool:
    """`db.get(Model, …)`."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get" and node.args and _model_ref(node.args[0]))


def _model_vars(fn) -> set[str]:
    """Names bound to a row of one of the MODELS: assigned from a query or a `get` of one,
    or iterating one."""
    out: set[str] = set()
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and (_chain_queries_a_model(n.value) or _gets_a_model(n.value)):
            out |= {t.id for t in n.targets if isinstance(t, ast.Name)}
        if isinstance(n, ast.For) and _chain_queries_a_model(n.iter) and isinstance(n.target, ast.Name):
            out.add(n.target.id)
    return out


def deletes(fn) -> list[str]:
    """Why this function's body deletes turns or answers ([] = it does not)."""
    why: list[str] = []
    rows = _model_vars(fn) | MODEL_VAR_NAMES
    query_vars = {
        t.id
        for n in ast.walk(fn) if isinstance(n, ast.Assign) and _chain_queries_a_model(n.value)
        for t in n.targets if isinstance(t, ast.Name)
    }
    for n in ast.walk(fn):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and RAW_SQL.search(n.value):
            why.append("raw SQL")
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if _call_name(n) in {"delete", "sa_delete"} and n.args and _model_ref(n.args[0]):
            why.append("core delete")
        if isinstance(f, ast.Attribute) and f.attr == "delete" and (
            _chain_queries_a_model(f.value) or _root_name(f.value) in query_vars
        ):
            why.append("query().delete")
        if (isinstance(f, ast.Attribute) and f.attr == "delete" and len(n.args) == 1
                and not n.keywords and isinstance(n.args[0], ast.Name)
                and n.args[0].id in rows):
            why.append(f"session.delete({n.args[0].id})")
    return why


def _aliases(node) -> dict[str, str]:
    """`from … import name as alias` inside this node: alias → name, so a call through
    the alias resolves (`unmerge_segment as do_unmerge`, `routers/segments.py`)."""
    return {
        a.asname: a.name
        for n in ast.walk(node) if isinstance(n, ast.ImportFrom)
        for a in n.names if a.asname
    }


class _Graph:
    def __init__(self, modules: dict[str, str]):
        self.units: dict[str, ast.AST] = {}
        self.doors: list[str] = []
        by_name: dict[str, list[str]] = {}
        module_aliases: dict[str, dict[str, str]] = {}
        for mod, source in modules.items():
            tree = ast.parse(source)
            module_aliases[mod] = {
                a.asname: a.name for n in tree.body if isinstance(n, ast.ImportFrom)
                for a in n.names if a.asname
            }
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
                by_name.setdefault(node.name, []).append(key)
                if _is_route(node) or mod == BOOT_MODULE:
                    self.doors.append(key)
        self.writer = {k: deletes(n) for k, n in self.units.items()}
        refs = {}
        for k, n in self.units.items():
            alias = {**module_aliases[k.split("::")[0]], **_aliases(n)}
            refs[k] = {alias.get(r, r) for r in _references(n)}
        self.calls = {k: {t for name in r for t in by_name.get(name, ())} for k, r in refs.items()}
        self.strips = {k for k, r in refs.items() if r & STRIPPERS}

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

    def unstripped_doors(self) -> dict[str, str]:
        out = {}
        for door in self.doors:
            writer = self.reaches(door, lambda k: bool(self.writer[k]))
            if writer and not self.reaches(door, lambda k: k in self.strips):
                out[door] = writer
        return out

    def deleting_doors(self) -> set[str]:
        return {d for d in self.doors if self.reaches(d, lambda k: bool(self.writer[k]))}


@pytest.fixture(scope="module")
def graph() -> _Graph:
    files = app_files(
        floor=150,
        sentinels=(
            "routers/conversations.py", "routers/dataset.py",
            "services/deleted_source_audit.py", "services/participant_dataset.py",
        ),
    )
    return _Graph({p.relative_to(APP_DIR).as_posix(): p.read_text(encoding="utf-8") for p in files})


def test_the_scan_finds_the_known_deleters_and_doors(graph):
    """POPULATION self-check: a scan that finds nothing passes by finding nothing."""
    writers = {k for k, why in graph.writer.items() if why}
    for known in (
        "routers/conversations.py::delete_conversation",
        "routers/dataset.py::delete_dataset",
        "routers/dataset.py::delete_row",
        "routers/dataset.py::delete_manual_column",
        "services/participant_dataset.py::sync_rows",
        "services/withdrawal_redaction.py::apply_withdrawal",
        "services/project_deletion.py::delete_project_tree",
    ):
        assert known in writers, f"the delete scan no longer sees {known} — it has gone blind"
    doors = graph.deleting_doors()
    for known in (
        "routers/conversations.py::delete_conversation",
        "routers/dataset.py::delete_row",
        "routers/dataset.py::delete_computed_column",
    ):
        assert known in doors, f"the door scan no longer reaches a delete from {known}"
    assert len(writers) >= 10 and len(doors) >= 10, (len(writers), len(doors))


def test_the_predicate_actually_discriminates():
    """PREDICATE falsifier: a planted door that deletes a record and never strips is
    flagged; its twin that strips is not; a door that deletes a code is not a door here."""
    planted = _Graph({
        "routers/planted.py": (
            "@router.delete('/a')\n"
            "def forgets(db, row_id):\n"
            "    _gone(db, row_id)\n"
            "def _gone(db, row_id):\n"
            "    row = db.query(DatasetRow).filter(DatasetRow.id == row_id).first()\n"
            "    db.delete(row)\n"
            "@router.delete('/b')\n"
            "def strips(db, row_id):\n"
            "    strip_deleted_answer_words(db, 1, row_ids=[row_id])\n"
            "    _gone(db, row_id)\n"
            "@router.delete('/c')\n"
            "def deletes_a_code(db, code_id):\n"
            "    db.query(Code).filter(Code.id == code_id).delete()\n"
        ),
    })
    assert planted.unstripped_doors() == {"routers/planted.py::forgets": "routers/planted.py::_gone"}
    assert "routers/planted.py::deletes_a_code" not in planted.deleting_doors()


def test_every_door_that_deletes_turns_or_answers_strips_their_words(graph):
    missing = {
        door: writer for door, writer in graph.unstripped_doors().items()
        if door not in ALLOWLIST
    }
    assert not missing, (
        "These doors delete conversation turns or survey answers and never reach "
        "`deleted_source_audit`, so the audit trail keeps the wording of their edits where "
        "no later withdrawal can find it (#1546):\n"
        + "\n".join(f"  {d}  (deletes through {w})" for d, w in sorted(missing.items()))
        + "\nCall `strip_deleted_conversation_words` / `strip_deleted_answer_words` BEFORE "
        "the rows go, or allowlist the door here with the reason its rows' entries hold no "
        "one's words."
    )


def test_the_allowlist_has_no_stale_entries(graph):
    unstripped = graph.unstripped_doors()
    stale = sorted(door for door in ALLOWLIST if door not in unstripped)
    assert not stale, (
        f"{stale} are allowlisted but no longer reach an unstripped delete — remove "
        "them, or the allowlist becomes a place a real door can hide"
    )


def test_not_resolved_is_the_staleness_guards_own():
    """The two guards share one notion of what a method name resolves to (#733)."""
    assert "delete" in NOT_RESOLVED and "query" in NOT_RESOLVED
