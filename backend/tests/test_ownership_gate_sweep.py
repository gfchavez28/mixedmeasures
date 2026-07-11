"""Fail-closed sweep: every project-scoped endpoint must reach the ownership gate.

`routers/helpers.py::_get_project_or_404` is the SINGLE place the per-user
ownership predicate is applied (`apply_project_owner_filter` — a no-op in
local-roster mode, a hard filter under `MM_MULTIUSER_AUTH_ENABLED`). An endpoint
that takes a `project_id` path param and never reaches it reads/mutates whatever
project id it is handed.

That is exactly what #553 was: it was FILED as ten dataset endpoints, and the
fix-round sweep found the same dormant gap in five more routers (documents ×14 —
including the raw-file download; codes ×6 — including `merge_codes`;
conversations ×3 — including delete + media rmtree; excerpts ×2; the codebook
import). Per-endpoint vigilance is what let it spread, so this is a SOURCE SCAN,
not a behavioral test: any new project-scoped endpoint that forgets the gate
fails this suite the moment it is written.

Two directions, both fail-closed (`feedback_fail_open_aggregation_guard`):
  - MISSING: an endpoint with `project_id` and no gate token → fail.
  - UNEXPECTED: an allowlist entry that no longer needs to be there → fail.

To gate a new endpoint, call `_get_project_or_404(db, project_id, user.id)` (or
route through a helper that does — see GATE_TOKENS). Only add to the allowlist
for an endpoint that genuinely cannot gate, with the reason in the value.
"""
import ast
import pathlib

import pytest

ROUTERS_DIR = pathlib.Path(__file__).resolve().parent.parent / "app" / "routers"

# Calling any of these reaches `_get_project_or_404`. The chaining helpers each
# resolve their entity -> parent -> project -> user; the entity-scoped `_get_*`
# helpers fold the gate in themselves (#553).
GATE_TOKENS = {
    "_get_project_or_404",          # the gate itself
    "apply_project_owner_filter",   # the gate's predicate, for non-id lookups
    "_verify_conversation_ownership",
    "_verify_segment_ownership",
    "_get_dataset_or_404",          # helpers.py — gates internally (#553)
    "_get_column_or_404",           # recode.py — gates internally (#553)
    "_get_document_or_404",         # documents.py — gates internally (#553)
    "_get_conversation",            # media.py — chains to _get_project_or_404
    "_get_text_value_or_404",       # text_coding.py — chains
}

# Endpoints that take `project_id` but legitimately never gate. Every entry needs
# a reason; an entry that stops being needed fails the test (see UNEXPECTED).
ALLOWLIST: dict[str, str] = {
    "metrics.py::get_row_matrix_csv": (
        "gated by delegation — its whole body is `await get_row_matrix(project_id, "
        "metric_ids, user, db)`, and THAT endpoint calls _get_project_or_404. The "
        "AST scan cannot follow the call. If this endpoint ever queries the project "
        "directly, it must gate itself and this entry must go."
    ),
}


def _iter_endpoints():
    """Yield (file, funcname, node) for every router function taking project_id."""
    for path in sorted(ROUTERS_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            # Endpoint = decorated with a router method (@router.get, etc.)
            is_route = any(
                isinstance(d, ast.Call)
                and isinstance(d.func, ast.Attribute)
                and d.func.attr in {"get", "post", "patch", "put", "delete"}
                for d in node.decorator_list
            )
            if not is_route:
                continue
            args = [a.arg for a in node.args.args] + [a.arg for a in node.args.kwonlyargs]
            if "project_id" not in args:
                continue
            yield path.name, node.name, node


def _calls_a_gate(node) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            fn = sub.func
            name = (
                fn.id if isinstance(fn, ast.Name)
                else fn.attr if isinstance(fn, ast.Attribute)
                else None
            )
            if name in GATE_TOKENS:
                return True
    return False


def test_every_project_scoped_endpoint_reaches_the_ownership_gate():
    """MISSING direction: no ungated project-scoped endpoint may exist."""
    ungated = [
        f"{fname}::{func}"
        for fname, func, node in _iter_endpoints()
        if not _calls_a_gate(node) and f"{fname}::{func}" not in ALLOWLIST
    ]
    assert not ungated, (
        "These endpoints take a project_id but never reach _get_project_or_404 "
        "(the #553 class — an authenticated user could act on another user's "
        "project under MM_MULTIUSER_AUTH_ENABLED):\n  "
        + "\n  ".join(sorted(ungated))
        + "\n\nFix: call _get_project_or_404(db, project_id, user.id) first, or "
          "route through a helper that does (see GATE_TOKENS)."
    )


def test_allowlist_has_no_stale_entries():
    """UNEXPECTED direction: an allowlisted endpoint that now gates (or no longer
    exists) must be removed, or the allowlist silently rots into a blind spot."""
    live = {f"{fname}::{func}": node for fname, func, node in _iter_endpoints()}
    stale = []
    for entry in ALLOWLIST:
        if entry not in live:
            stale.append(f"{entry} (endpoint no longer exists)")
        elif _calls_a_gate(live[entry]):
            stale.append(f"{entry} (now gates — drop the allowlist entry)")
    assert not stale, "Stale ALLOWLIST entries:\n  " + "\n  ".join(stale)


def test_the_scan_actually_sees_endpoints():
    """Guard the guard: a broken AST walk would make both tests vacuously pass."""
    found = list(_iter_endpoints())
    assert len(found) > 150, f"scan found only {len(found)} project-scoped endpoints"
    names = {f"{f}::{n}" for f, n, _ in found}
    # The #553 headliners — if the scan can't see these, it can't see anything.
    for expected in (
        "dataset.py::delete_dataset",
        "documents.py::get_original_file",
        "codes.py::merge_codes",
        "conversations.py::delete_conversation",
        "recode.py::copy_to",
        "project_portability.py::import_codebook_endpoint",
    ):
        assert expected in names, f"scan missed {expected}"


@pytest.mark.parametrize("helper_module,helper_name", [
    ("app.routers.helpers", "_get_dataset_or_404"),
    ("app.routers.recode", "_get_column_or_404"),
    ("app.routers.documents", "_get_document_or_404"),
])
def test_entity_helpers_require_user_id(helper_module, helper_name):
    """The three fold-the-gate-in helpers must keep user_id REQUIRED.

    Making it optional (or dropping it) would silently reopen every endpoint
    that reaches its entity through them — the signature IS the guard.
    """
    import importlib
    import inspect

    fn = getattr(importlib.import_module(helper_module), helper_name)
    params = inspect.signature(fn).parameters
    assert "user_id" in params, f"{helper_name} lost its user_id parameter"
    assert params["user_id"].default is inspect.Parameter.empty, (
        f"{helper_name}'s user_id has a default — it must be required so a new "
        "call site cannot omit the ownership gate"
    )
