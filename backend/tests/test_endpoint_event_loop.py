"""#804 — which endpoints must NOT run on the event loop, and which must stay async.

A FastAPI endpoint declared `async def` runs ON the event loop; one declared
`def` is dispatched to the threadpool. So for a purely synchronous handler doing
seconds of database work, `async` is not a neutral stylistic choice — it is the
difference between a responsive server and a frozen one.

MEASURED end-to-end on the 75,699-row GSS dataset, `/health` polled every 200ms
while a 500-label value-labels apply ran:

    async def : apply 7.78s, worst concurrent /health  7.70s  (loop frozen)
    def       : apply 8.51s, worst concurrent /health  0.012s

⚠️ **The criterion is STRUCTURAL: does the body contain an `await`?** That is
what makes this checkable rather than a matter of taste, and it is what split
#804's "decide all four together" cleanly — two of the four could change and two
could not, decided by the code.

⚠️ **This file pins a DECISION about specific endpoints; it is not a general
rule.** The large majority of async endpoints in this codebase contain no
`await` — re-measure rather than quoting a number, which rots (it read "320 of
341" until #837's own batch converted five more). **Only the ones with a MEASURED
freeze were converted**; widening that to a sweep is a separate call, because a
blanket conversion caps concurrent requests at FastAPI's threadpool size and
costs a direct-call test refactor per endpoint. That widening is tracked as #837.
Do not "finish the job" by asserting the property over every endpoint here.

⚠️ **`def` is not a cure on a CPU-bound body, and #837 measured that too.**
`apply_value_labels` reaches 0.012s because its time is spent in SQLite, which
releases the GIL. The Excel export is Python holding the GIL, so converting it
took the worst concurrent `/health` from 74.4s to 5.5s — a 13x improvement and
not zero. Expect the first, not the second.
"""
import ast
import inspect
import pathlib

import pytest

from app.routers.dataset import append_import, import_dataset
from app.routers.export_excel import export_datasets_excel, export_study_excel
from app.routers.export_r import export_r_data
from app.routers.metrics import get_row_matrix, get_row_matrix_csv
from app.routers.recode import apply_value_labels_endpoint, bulk_set_missing_values


ROUTERS = pathlib.Path(__file__).resolve().parents[1] / "app" / "routers"

# Endpoints converted under #804 and #837, with the measurement that justified
# each. Every wall time below is the FREEZE it imposed: an `async def` body with
# no `await` runs start-to-finish on the loop, so nothing else is served while it
# runs. Measured against the real 75,699 x 41 GSS corpus (project 4) except where
# noted; see ISSUES #837.
MUST_BE_SYNC = [
    # #804
    (apply_value_labels_endpoint, "7.70s frozen /health at MAX_VALUE_LABELS on 75,699 rows"),
    (bulk_set_missing_values, "loops apply_missing_declaration over every column of a dataset"),
    # #837 — the five measured freezes, worst first. ⚠️ Keep this count in step
    # with the list below it, or delete it: a number in a comment beside the
    # thing it counts is the cheapest kind of doc rot, and it shipped wrong in
    # the very commit that added the fifth entry.
    (export_datasets_excel, "181.3s building the workbook, all of it on the loop"),
    (export_r_data, "44.0s"),
    (export_study_excel, "15.1s"),
    (get_row_matrix, "7.9s — and it is a plain GET the analysis UI issues, not an export"),
    (get_row_matrix_csv, "7.1s — its body is a call to get_row_matrix; the two move together"),
]

# Endpoints that genuinely await I/O and therefore CANNOT take that treatment.
MUST_STAY_ASYNC = [
    (import_dataset, "await _upload_to_csv_text"),
    (append_import, "await _upload_to_csv_text"),
]


@pytest.mark.parametrize("fn,why", MUST_BE_SYNC, ids=lambda v: getattr(v, "__name__", ""))
def test_heavy_synchronous_endpoints_are_declared_sync(fn, why):
    """`async def` here would put seconds of DB work back on the event loop."""
    assert not inspect.iscoroutinefunction(fn), (
        f"{fn.__name__} is `async def` again. It does heavy synchronous work "
        f"({why}) and contains no `await`, so declaring it async runs that work "
        f"ON the event loop — no other request, including the packaged app's "
        f"/health probe, is answered while it runs. Declare it `def`."
    )


@pytest.mark.parametrize("fn,why", MUST_STAY_ASYNC, ids=lambda v: getattr(v, "__name__", ""))
def test_endpoints_that_await_stay_async(fn, why):
    """The other half of #804's question, and the reason it is not "all four"."""
    assert inspect.iscoroutinefunction(fn), (
        f"{fn.__name__} must stay `async def` — it {why}."
    )


def _body_has_await(path: pathlib.Path, name: str) -> bool:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return any(isinstance(n, (ast.Await, ast.AsyncFor, ast.AsyncWith))
                       for n in ast.walk(node))
    raise AssertionError(f"{name} not found in {path.name}")


@pytest.mark.parametrize("fn,_why", MUST_BE_SYNC, ids=lambda v: getattr(v, "__name__", ""))
def test_the_sync_ones_really_have_no_await(fn, _why):
    """The structural half — asserted with a parser, not by reading the source.

    If someone adds real awaitable I/O to one of these, `def` becomes the wrong
    answer and this fails rather than letting the endpoint block on a
    `RuntimeWarning: coroutine was never awaited`.
    """
    path = ROUTERS / (fn.__module__.rsplit(".", 1)[-1] + ".py")
    assert not _body_has_await(path, fn.__name__)


def test_the_await_detector_can_actually_detect_an_await():
    """PREDICATE self-check (#729): a matcher that never fires proves nothing.

    Without this, `_body_has_await` returning a constant `False` would leave
    every assertion above green.
    """
    assert _body_has_await(ROUTERS / "dataset.py", "import_dataset") is True
    assert _body_has_await(ROUTERS / "recode.py", "apply_value_labels_endpoint") is False


# ── The criterion's one blind spot (#837) ────────────────────────────────────
#
# "Does the body contain an `await`?" is what makes this checkable rather than a
# matter of taste — but it answers the question we care about ("does this body
# yield to the loop?") only while every `await` is on real I/O.
#
# `get_row_matrix_csv` was the counter-example, and it hid a 7.1s freeze in
# plain sight: its whole body was `await get_row_matrix(...)`, a call to a
# SIBLING ENDPOINT that itself did no I/O. The await made it look like the one
# shape this file says cannot be converted, so a reader applying the criterion
# would have left it alone forever.
#
# So the criterion is sound only if that coupling does not exist. This scan is
# what keeps it true.

_HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


def _endpoint_names() -> set[str]:
    """Every function in app/routers decorated with a router HTTP method."""
    names: set[str] = set()
    for path in sorted(ROUTERS.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                if (
                    isinstance(dec, ast.Call)
                    and isinstance(dec.func, ast.Attribute)
                    and dec.func.attr in _HTTP_METHODS
                ):
                    names.add(node.name)
    return names


def _awaited_endpoint_calls(tree: ast.AST, endpoints: set[str]) -> list[tuple[int, str]]:
    """`await some_endpoint(...)` sites — the shape that breaks the criterion."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Await):
            continue
        call = node.value
        if (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id in endpoints
        ):
            found.append((node.lineno, call.func.id))
    return found


def test_no_endpoint_awaits_another_endpoint():
    """An endpoint calling an endpoint makes `has an await` mean two things.

    If this fails, do NOT satisfy it by leaving the caller async. Either extract
    the shared work into a service both call, or convert the pair together —
    which is what #837 did for `get_row_matrix` / `get_row_matrix_csv`.
    """
    endpoints = _endpoint_names()
    offenders = []
    for path in sorted(ROUTERS.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for lineno, name in _awaited_endpoint_calls(tree, endpoints):
            offenders.append(f"{path.name}:{lineno} awaits endpoint {name}()")
    assert offenders == [], (
        "An endpoint awaits another endpoint:\n  "
        + "\n  ".join(offenders)
        + "\nThat makes this file's structural criterion ambiguous — the await is "
        "not I/O, so `must stay async` would be the wrong reading. See the note "
        "above this test."
    )


def test_the_endpoint_scan_found_a_real_population():
    """POPULATION self-check (#729/#730): a walk that finds nothing passes.

    `assert offenders == []` above is the shape that cannot detect its own
    blindness — if `_endpoint_names()` returned an empty set (a moved directory,
    a renamed decorator convention) the scan would be vacuous and green.
    """
    names = _endpoint_names()
    assert len(names) > 250, f"expected the full router surface, found {len(names)}"
    assert "export_datasets_excel" in names
    assert "get_row_matrix" in names


def test_the_awaited_endpoint_detector_can_actually_fire():
    """PREDICATE self-check: the matcher must catch the shape it exists to ban.

    Written against source text rather than a real file, so the control cannot
    be invalidated by fixing the codebase — which is precisely what happened to
    the case it was built from.
    """
    src = "async def caller():\n    return await some_endpoint(1, 2)\n"
    hits = _awaited_endpoint_calls(ast.parse(src), {"some_endpoint"})
    assert hits == [(2, "some_endpoint")]
    # …and does not fire on an await of something that is not an endpoint.
    assert _awaited_endpoint_calls(ast.parse(src), {"unrelated"}) == []
