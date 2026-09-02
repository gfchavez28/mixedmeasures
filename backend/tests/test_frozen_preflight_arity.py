"""Fail-closed: every lazily-imported third-party package is probed by the frozen preflight.

**Why this exists (#858, and it is the arity lesson in the packaging layer).** `#29 S1`'s
frozen smoke drives a `.sav` preview so that a **pyreadstat** collection miss fails the
build rather than the first user. It was written for pyreadstat and it pins pyreadstat —
so when scipy failed the same way one dependency over, nothing covered it, and every
statistical test was dead in two shipped releases while 2,858 tests stayed green.

That is #515 → #676 exactly: *a guard that pins the variant you just fixed guarantees a
next instance.* The remedy the project has already proven is to pin the RELATIONSHIP
between two sets by deriving one from an artifact the next variant must touch. Here:

    every third-party package imported INSIDE a function in `app/`
        ⊆  lazy_native_imports.LAZY_NATIVE_IMPORTS ∪ PROBE_EXEMPT

A function-local import is the signal, because that is precisely what PyInstaller's static
analysis is worst at and what the codebase does deliberately (services lazy-import scipy,
pyreadstat, openpyxl, docx… to keep startup fast and memory low). Add a new one and this
test fails until it is either probed or exempted with a reason.

⚠️ **What this test CANNOT do, stated so nobody reads more into a green run.** It proves the
LIST is complete with respect to the source. It does not prove the bundle contains them —
only running `MM_PREFLIGHT=1` inside a real frozen build does that, which is why
`release.yml` runs it on every packaged artifact and `RELEASING` §4b names it by hand. The
two halves are complementary: this one fails at push, that one fails at cut.
"""
from __future__ import annotations

import ast
import os
import pathlib
import sys

import pytest

BACKEND = pathlib.Path(__file__).resolve().parent.parent
APP_DIR = BACKEND / "app"

sys.path.insert(0, str(BACKEND))
from lazy_native_imports import (  # noqa: E402
    LAZY_NATIVE_IMPORTS,
    PROBE_EXEMPT,
    run_probes,
)

#: Top-level names that are first-party or stdlib and therefore never probe candidates.
_NOT_THIRD_PARTY = set(sys.stdlib_module_names) | {"app", "lazy_native_imports"}


def _function_local_third_party_imports() -> dict[str, set[str]]:
    """Map top-level package -> the app files that import it from inside a function."""
    found: dict[str, set[str]] = {}
    for path in sorted(APP_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(fn):
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    # `level > 0` is a relative (first-party) import — never a probe target.
                    names = [node.module] if node.module and node.level == 0 else []
                else:
                    continue
                for name in names:
                    top = name.split(".")[0]
                    if top and top not in _NOT_THIRD_PARTY:
                        found.setdefault(top, set()).add(
                            path.relative_to(BACKEND).as_posix()
                        )
    return found


def _probed_top_level() -> set[str]:
    return {name.split(".")[0] for name in LAZY_NATIVE_IMPORTS}


def test_the_scan_actually_sees_lazy_imports():
    """POPULATION self-check: a broken AST walk would make the real test vacuously pass.

    Measured 2026-08-30: 13 distinct top-level packages across `app/`. The floor sits well
    below that so ordinary change never trips it, while a walk that rots to nothing does.
    ⚠️ Required by the project's own rule — a scan whose expected result is empty passes by
    finding nothing, including when its own selector has rotted (#730/#772).
    """
    found = _function_local_third_party_imports()
    assert len(found) >= 8, (
        f"scan found only {len(found)} function-local third-party imports across "
        f"{APP_DIR} — the AST walk is broken, not the code"
    )
    # The two headliners: if the scan cannot see these it cannot see anything. scipy is
    # #858's own dependency; pyreadstat is the one the original guard was written for.
    for expected in ("scipy", "pyreadstat"):
        assert expected in found, f"scan missed {expected}"


def test_every_lazily_imported_package_is_probed_or_exempt():
    """MISSING direction: a new lazily-imported native dep cannot ship unprobed."""
    found = _function_local_third_party_imports()
    probed = _probed_top_level()
    unprobed = {
        top: sorted(files)
        for top, files in found.items()
        if top not in probed and top not in PROBE_EXEMPT
    }
    assert not unprobed, (
        "These packages are imported inside a function in app/ but the frozen preflight "
        "never probes them, so a PyInstaller collection miss would reach users as a 500 "
        "on first use (#858):\n  "
        + "\n  ".join(f"{top}  ({', '.join(files)})" for top, files in sorted(unprobed.items()))
        + "\n\nFix: add it to lazy_native_imports.LAZY_NATIVE_IMPORTS (which also bundles "
          "it via mixedmeasures.spec), or to PROBE_EXEMPT with the reason it needs no probe."
    )


def test_exemptions_are_not_stale():
    """UNEXPECTED direction: an exemption for a package nobody lazy-imports any more is a
    blind spot with a reason attached — the same rot `test_allowlist_has_no_stale_entries`
    guards against in the ownership sweep."""
    found = _function_local_third_party_imports()
    stale = sorted(set(PROBE_EXEMPT) - set(found))
    assert not stale, (
        "PROBE_EXEMPT excuses packages that no longer appear as a function-local import "
        f"in app/: {stale}. Drop the entry, or the reason nobody can see stops being true."
    )


def test_probes_run_and_report_per_module():
    """PREDICATE falsifier: prove the probe matcher fires and reports one row per module.

    Without this, `run_probes()` returning `[]` — the shape a rotted list produces — would
    make the CI step exit 0 and read exactly like success. ⚠️ Assert the ARITY, never
    `len(results) > 0` (#515).
    """
    results = run_probes()
    assert len(results) == len(LAZY_NATIVE_IMPORTS) + 1, (
        f"expected one row per module plus the scipy execution probe "
        f"({len(LAZY_NATIVE_IMPORTS) + 1}), got {len(results)}"
    )
    names = [name for name, _ in results]
    assert names[: len(LAZY_NATIVE_IMPORTS)] == list(LAZY_NATIVE_IMPORTS)
    assert names[-1] == "scipy.stats:ttest_ind", (
        "the execution probe must be last and must be an EXECUTION, not an import — "
        "#858's whole point is that the name resolved and the body died"
    )


def test_probes_pass_against_the_source_tree():
    """Every probe passes unfrozen. A failure here is a broken venv, not a packaging bug —
    but it must be loud, because it would otherwise be indistinguishable from #858 when
    the same probes run inside the bundle."""
    failures = [(n, s) for n, s in run_probes() if s != "ok"]
    assert not failures, (
        "preflight probes fail against the SOURCE tree (so this is not a freezing "
        f"problem — check the venv): {failures}"
    )


@pytest.mark.parametrize("module", LAZY_NATIVE_IMPORTS)
def test_each_probed_module_is_bundled_by_the_spec(module):
    """The list is shared with `mixedmeasures.spec`, and this pins that it stays shared.

    Re-inlining the names in the spec is what produced #858's underlying defect: two
    hand-maintained enumerations of one set, neither a superset of the other. Reading the
    spec as TEXT (not executing it — that needs PyInstaller) is enough to catch a re-inline.
    """
    spec = (BACKEND / "mixedmeasures.spec").read_text(encoding="utf-8")
    assert "from lazy_native_imports import LAZY_NATIVE_IMPORTS" in spec, (
        "mixedmeasures.spec no longer imports the shared list — a re-inlined copy will "
        "drift from the runtime preflight exactly as it did before #858"
    )
    assert "list(LAZY_NATIVE_IMPORTS)" in spec, (
        "mixedmeasures.spec imports the shared list but no longer spreads it into "
        "hiddenimports"
    )
    # The parametrization is the arity: adding a module to the list adds a case here, so
    # the count can never silently diverge from what the spec bundles.
    assert module in LAZY_NATIVE_IMPORTS


def test_preflight_reports_through_an_ascii_stdout(tmp_path):
    """The preflight's OWN output must survive a non-UTF-8 stdout (v1.5.0 cut, 2026-09-02).

    🔴 This is the defect that failed the FIRST release run of the `release.yml` preflight
    step: the frozen Windows interpreter writes **cp1252**, all 21 probes reported `ok`,
    and the step still exited 1 — `print` raised `UnicodeEncodeError` on the `✅` in the
    success line, *after* every probe had passed. Both summaries carried an emoji, so on
    Windows the mode could never report anything correctly: a pass died on `✅` and a real
    failure died on `❌` before reaching its `sys.exit(2)`, and both surfaced as exit 1.

    ⚠️ **Asserted in the channel the property lives in.** A source scan for non-ASCII
    would be the wrong instrument twice over — it cannot see a runtime f-string, and this
    file is itself full of emoji in prose that such a scan would have to except. What
    matters is the BYTES the process writes, so this runs the real thing with an ASCII
    stdout and reads the exit code.

    ⚠️ The subprocess needs `PYTHONUTF8=0` **and** `PYTHONCOERCECLOCALE=0`: since 3.7,
    `LC_ALL=C` alone is silently coerced back to UTF-8 (PEP 538), so the obvious form of
    this test passes against the broken code. Measured — the first attempt did exactly
    that.
    """
    import subprocess

    env = {
        "PATH": os.environ.get("PATH", ""),
        "MM_PREFLIGHT": "1",
        "MM_DATABASE_PATH": ":memory:",
        "PYTHONUTF8": "0",
        "PYTHONCOERCECLOCALE": "0",
        "LC_ALL": "C",
        "LANG": "C",
        "PYTHONPATH": str(BACKEND),
    }
    proc = subprocess.run(
        [sys.executable, str(BACKEND / "run_server.py")],
        env=env, capture_output=True, timeout=300,
    )
    out = proc.stdout.decode("ascii", errors="replace") + proc.stderr.decode("ascii", errors="replace")
    assert "UnicodeEncodeError" not in out, (
        "the preflight's own summary line is not encodable on a non-UTF-8 stdout — this is "
        "the Windows cp1252 case that failed the v1.5.0 build with every probe passing. "
        "Keep this output ASCII (see the note in run_server.py::_preflight); do NOT reach "
        f"for PYTHONIOENCODING, which the frozen interpreter ignores (#762).\n{out[-2000:]}"
    )
    assert proc.returncode == 0, f"preflight exited {proc.returncode} under an ASCII stdout:\n{out[-2000:]}"
    assert "OK preflight" in out, f"the success summary did not reach stdout:\n{out[-2000:]}"


def test_every_preflight_output_literal_is_ascii():
    """The ARM the behavioural test above cannot reach — the FAILURE path (#873).

    🔴 The first fix for #873 was INCOMPLETE and the subprocess test could not see it.
    That test necessarily takes the success branch (every probe passes against the source
    tree), so the `FAILED` summary and the per-module `- {status}` suffix — which only
    render when a probe fails — kept their em-dashes and were never executed. An AST scan
    reaches them; running the code does not, short of synthesising a broken bundle.

    ⚠️ This is deliberately an AST scan and NOT a text grep: `run_server.py` documents
    this rule in prose that necessarily *contains* the characters it forbids, so a grep
    would match its own explanation. Reading `print()` arguments as syntax is what makes
    the comment and the code distinguishable (#772's lesson — a guard's own parser must
    not read prose as markup).

    ⚠️ **The two guards are a pair, and neither is redundant.** This one proves the
    literals are ASCII; the subprocess one proves the *runtime* result is (an f-string
    can interpolate a non-ASCII value that no literal contains) and that the process
    actually exits 0. Deleting either leaves a live gap.
    """
    tree = ast.parse((BACKEND / "run_server.py").read_text(encoding="utf-8"))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fname = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
        if fname not in ("print", "write"):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                non_ascii = sorted({c for c in sub.value if ord(c) > 127})
                if non_ascii:
                    offenders.append((sub.lineno, non_ascii, sub.value[:60]))
    assert not offenders, (
        "run_server.py writes non-ASCII to stdout/stderr. The frozen Windows interpreter "
        "encodes cp1252 and the packaged binary dies on it — that is #873, and it blocked "
        "the whole v1.5.0 Windows leg with every probe passing. Keep this output ASCII; do "
        f"NOT reach for PYTHONIOENCODING (#762 — the frozen interpreter ignores it).\n"
        f"offenders: {offenders}"
    )
    # POPULATION self-check (#730): a scan whose walk finds nothing passes by finding
    # nothing. The preflight has at least the per-module row, the machine-readable line,
    # and the two summaries.
    printed = [n for n in ast.walk(tree)
               if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "print"]
    assert len(printed) >= 4, (
        f"the scan found only {len(printed)} print() calls in run_server.py — it has gone "
        "blind (moved file? renamed function?), and an empty scan is indistinguishable "
        "from a pass"
    )
