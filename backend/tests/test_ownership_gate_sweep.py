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
    "_get_observation_or_404",      # observations.py — gates internally (Observations track)
    "_get_conversation",            # media.py — chains to _get_project_or_404
    "_get_text_value_or_404",       # text_coding.py — chains
}

# Endpoints that take `project_id` but legitimately never gate. Every entry needs
# a reason; an entry that stops being needed fails the test (see UNEXPECTED).
ALLOWLIST: dict[str, str] = {
    "metrics.py::get_row_matrix_csv": (
        "gated by delegation — its whole body is `get_row_matrix(project_id, "
        "metric_ids, user, db)`, and THAT endpoint calls _get_project_or_404. The "
        "AST scan cannot follow the call. If this endpoint ever queries the project "
        "directly, it must gate itself and this entry must go. (#837 dropped the "
        "`await`: both are now `def`. The delegation — the only thing this entry "
        "turns on — is unchanged.)"
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


# ── Guarding the guard: every GATE_TOKENS entry must actually gate ──────────────
#
# 🔴 **#845 (2026-08-30): a `GATE_TOKENS` entry did not gate, and both designated guards
# certified it.** `_get_text_value_or_404` took no `user_id` and never reached
# `_get_project_or_404` — it answered only "does this DatasetValue belong to this project,
# on a text column?". Mutation-confirmed: removing the real gate from
# `text_coding.py::apply_code` left this file at 6 passed and
# `test_multiuser_ownership_gate.py` at 15 passed, because `_calls_a_gate` matches a NAME.
#
# The old check here pinned THREE helpers by hand against a ten-entry `GATE_TOKENS` — the
# #515 → #676 arity shape exactly: a hand-maintained subset of a set enumerated elsewhere,
# which guarantees a next instance. It is replaced by a check DERIVED from `GATE_TOKENS`,
# so a token added tomorrow is held to the same three properties automatically.


def _router_function_defs() -> dict[str, list[tuple[str, ast.AST]]]:
    """Map function name -> [(file, node)] for every module-level def in routers/."""
    defs: dict[str, list[tuple[str, ast.AST]]] = {}
    for path in sorted(ROUTERS_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs.setdefault(node.name, []).append((path.name, node))
    return defs


def _called_names(node) -> set[str]:
    out = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            fn = sub.func
            name = (
                fn.id if isinstance(fn, ast.Name)
                else fn.attr if isinstance(fn, ast.Attribute)
                else None
            )
            if name:
                out.add(name)
    return out


#: The predicate every gate token must transitively reach. `apply_project_owner_filter` is
#: the ONE place `Project.user_id` is filtered, so reaching it is what "gates" means —
#: reaching `_get_project_or_404` is only the usual route to it.
GATE_PREDICATE = "apply_project_owner_filter"


def test_every_gate_token_resolves_to_exactly_one_definition():
    """`_calls_a_gate` matches by NAME, so two defs of one token is a blind spot.

    No duplicate exists today (verified), but `_get_conversation` is a generic enough name
    that a second router could define its own ungated version and every endpoint reaching
    it would still pass the sweep. Cheap to pin, invisible to find later.
    """
    defs = _router_function_defs()
    problems = []
    for token in sorted(GATE_TOKENS):
        sites = defs.get(token, [])
        if len(sites) != 1:
            where = ", ".join(f for f, _ in sites) or "nowhere"
            problems.append(f"{token}: {len(sites)} definition(s) in routers/ ({where})")
    assert not problems, (
        "Each GATE_TOKENS entry must resolve to exactly one definition under routers/, "
        "because the sweep matches call names, not call targets:\n  "
        + "\n  ".join(problems)
    )


@pytest.mark.parametrize("token", sorted(GATE_TOKENS))
def test_gate_token_requires_user_id(token):
    """Every gate token takes a REQUIRED `user_id` — the signature IS the guard.

    Making it optional, or dropping it, silently reopens every endpoint that reaches its
    entity through the helper. Parametrized over `GATE_TOKENS` so adding a token adds a
    case; the old form listed three names and missed #845's for months.
    """
    sites = _router_function_defs().get(token, [])
    assert len(sites) == 1, f"{token} does not resolve to one definition (see sibling test)"
    fname, node = sites[0]
    args = node.args
    positional = args.posonlyargs + args.args
    names = [a.arg for a in positional] + [a.arg for a in args.kwonlyargs]
    assert "user_id" in names, (
        f"{fname}::{token} is a GATE_TOKENS entry but takes no `user_id`, so it cannot "
        f"apply the ownership predicate — this is #845 exactly. Either fold "
        f"`_get_project_or_404(db, project_id, user_id)` in, or remove it from GATE_TOKENS "
        f"so its callers must name the real gate."
    )
    # A default on user_id lets a call site omit the gate. Defaults bind to the TAIL of the
    # positional list, so compare positions rather than assuming alignment.
    n_defaulted = len(args.defaults)
    defaulted = {a.arg for a in positional[len(positional) - n_defaulted:]} if n_defaulted else set()
    defaulted |= {
        a.arg for a, d in zip(args.kwonlyargs, args.kw_defaults) if d is not None
    }
    assert "user_id" not in defaulted, (
        f"{fname}::{token}'s `user_id` has a default — it must be required so a new call "
        f"site cannot omit the ownership gate"
    )


@pytest.mark.parametrize("token", sorted(GATE_TOKENS))
def test_gate_token_reaches_the_ownership_predicate(token):
    """Every gate token transitively reaches `apply_project_owner_filter`.

    This is the half a name-scan cannot do and the half #845 needed: `_get_text_value_or_404`
    was in GATE_TOKENS and reached nothing. Resolution is a BFS over router-level defs, so
    a helper that chains through two hops still passes honestly.
    """
    if token == GATE_PREDICATE:
        return  # the predicate is its own base case
    defs = _router_function_defs()
    seen, frontier = set(), [token]
    while frontier:
        current = frontier.pop()
        if current in seen:
            continue
        seen.add(current)
        sites = defs.get(current, [])
        if len(sites) != 1:
            continue
        called = _called_names(sites[0][1])
        if GATE_PREDICATE in called:
            return
        frontier.extend(n for n in called if n in defs and n not in seen)
    raise AssertionError(
        f"{token} is in GATE_TOKENS but no call path from it reaches `{GATE_PREDICATE}`, "
        f"the ONE place `Project.user_id` is filtered. Every endpoint relying on this token "
        f"is certified by the sweep while gating nothing (#845). Fold "
        f"`_get_project_or_404(db, project_id, user_id)` in, or drop the token."
    )


def test_the_gate_token_resolver_can_fail():
    """PREDICATE falsifier: prove the reachability walk can return False.

    Three tests above assert a property holds for every token. If `_router_function_defs`
    or `_called_names` rotted to something that always succeeded, all three would pass by
    construction and read exactly like real success (#729/#730). So drive the resolver at a
    function that genuinely does NOT gate and require a negative.
    """
    defs = _router_function_defs()
    # `_get_config` (text_coding.py) is a real, non-gating helper: it takes no user_id and
    # touches only TextCodingConfig. If the walk claims IT gates, the walk is broken.
    assert "_get_config" in defs, "the resolver found no _get_config — the AST walk is broken"
    called = _called_names(defs["_get_config"][0][1])
    assert GATE_PREDICATE not in called
    assert "_get_project_or_404" not in called, (
        "_get_config now gates, so it is no longer a valid falsifier — pick another "
        "non-gating helper rather than deleting this test"
    )
