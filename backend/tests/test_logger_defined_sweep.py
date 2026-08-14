"""Fail-closed sweep: a module that USES `logger.` must DEFINE or import it (#691).

`services/dataset_import.py` called ``logger.warning(...)`` at two sites and never
imported ``logging`` or bound ``logger``. Both branches are user-reachable — an SPSS
``.sav`` whose ``scale_values``/``scale_labels`` lengths disagree, and a
``cells_are_codes`` column with mismatched labels/values — so the malformed-metadata
case the warnings exist to REPORT raised ``NameError`` mid-import instead.

It was a singleton backend-wide when found, which is exactly why a sweep is the right
remedy rather than a one-line fix: the instance costs one line, the class costs this
file once. Same shape as the other fail-closed scans (ownership gate, grouping N/A,
CodeApplication grain) — the point is that the NEXT one fails the suite rather than
shipping.

⚠️ This is deliberately an AST check, not a grep. A grep for ``logger =`` would pass on
a module that only mentions the name in a comment or a docstring, and would miss
``from .x import logger``. The AST sees binding, not text.
"""

from __future__ import annotations

import ast
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent / "app"

# #730: the assertion below expects an EMPTY offender list, which a scan that
# read nothing satisfies just as well — and `rglob` on a mistyped root yields
# `[]` rather than raising. Prove the population first. 163 files today; the
# floor detects a BAD ROOT, not growth.
_MIN_APP_FILES = 100


def _app_files() -> list[Path]:
    files = sorted(APP_ROOT.rglob("*.py"))
    assert len(files) >= _MIN_APP_FILES, (
        f"This sweep's population is {len(files)} file(s) under {APP_ROOT} — "
        f"expected at least {_MIN_APP_FILES}. rglob returns [] for a bad path "
        "instead of raising, so the offender assertion would pass VACUOUSLY. "
        "Fix APP_ROOT — do NOT lower this floor."
    )
    assert (APP_ROOT / "main.py").is_file(), (
        f"the sweep cannot see main.py under {APP_ROOT}: a file COUNT alone "
        "cannot tell this tree from another that also contains .py files"
    )
    return files


def _bound_names(tree: ast.Module) -> set[str]:
    """Every name bound at MODULE scope — assignment, import, def, class.

    Module scope only: a `logger` bound inside one function does not make a
    reference from a different function legal, which is the bug we are pinning.
    """
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Try):
            # `try: import x / except ImportError: x = None` — a real pattern here.
            for sub in [*node.body, *node.handlers, *node.orelse, *node.finalbody]:
                for inner in ast.walk(sub):
                    if isinstance(inner, ast.Assign):
                        for target in inner.targets:
                            if isinstance(target, ast.Name):
                                names.add(target.id)
                    elif isinstance(inner, (ast.Import, ast.ImportFrom)):
                        for alias in inner.names:
                            names.add(alias.asname or alias.name.split(".")[0])
    return names


def _uses_bare_logger(tree: ast.Module) -> bool:
    """True if the module reads a bare `logger` name (``logger.warning(...)``).

    Attribute access on something else (``self.logger``, ``app.logger``) is not a
    bare Name load and is correctly ignored.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            if node.value.id == "logger" and isinstance(node.value.ctx, ast.Load):
                return True
    return False


def test_every_module_using_logger_defines_it():
    offenders: list[str] = []

    for path in _app_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        if not _uses_bare_logger(tree):
            continue
        if "logger" in _bound_names(tree):
            continue
        offenders.append(str(path.relative_to(APP_ROOT.parent)))

    assert not offenders, (
        "These modules call `logger.<method>()` but never bind `logger` at module "
        "scope — every call raises NameError at runtime, on whatever branch it sits "
        "on (#691):\n  " + "\n  ".join(offenders) + "\n\n"
        "Fix: add `import logging` and `logger = logging.getLogger(__name__)` at "
        "module scope, matching every other service module."
    )


def test_sweep_would_catch_a_missing_logger():
    """The sweep's own falsifier — a scan that cannot fail is not a guard.

    Pins both halves of the predicate: a module that USES logger without binding it
    is caught, and one that binds it is not. Without this, a bug in `_bound_names`
    (e.g. returning every name it sees) would make the sweep vacuously green.
    """
    offending = ast.parse("def f():\n    logger.warning('x')\n")
    assert _uses_bare_logger(offending)
    assert "logger" not in _bound_names(offending)

    fixed = ast.parse(
        "import logging\nlogger = logging.getLogger(__name__)\n"
        "def f():\n    logger.warning('x')\n"
    )
    assert _uses_bare_logger(fixed)
    assert "logger" in _bound_names(fixed)

    # An import-bound logger counts too — `from .log import logger` is legal.
    imported = ast.parse("from .log import logger\ndef f():\n    logger.info('x')\n")
    assert "logger" in _bound_names(imported)

    # `self.logger` is not a bare name and must not trip the scan.
    attribute = ast.parse("class C:\n    def f(self):\n        self.logger.info('x')\n")
    assert not _uses_bare_logger(attribute)
