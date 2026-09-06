"""THE walk over ``app/`` for every fail-closed source scan in this suite (#729).

**What this unifies, and what it deliberately does not.** Six test modules walked the
application tree on 2026-09-04 — three with byte-identical ``_app_files()`` blocks
(the grain sweep, the logger sweep, the grouping sweep), two globbing ``routers/``
(the ownership sweep, the event-loop scan) and one ``rglob`` in the preflight arity
guard. Every one carried its own population floor, which is to say the #730 lesson
had propagated by copy — and #733 is the standing record that a copy propagates the
original's defects as faithfully as its fixes. The predicates stay where they are
(they differ for load-bearing reasons); the WALK and its two self-checks live here:

  * a **population floor** — ``Path.rglob`` on a mistyped root yields ``[]`` and does
    not raise (measured, 3.12.3), so a scan asserting an empty offender list would
    pass VACUOUSLY over an empty tree. The floor is a REQUIRED argument and the walk
    itself raises below it, so a consumer cannot forget it.
  * a **tree-identity check** — a count cannot tell ``app/`` from some other directory
    of ``.py`` files; ``main.py`` at the app root is asserted on every call, and each
    caller may add the SENTINEL modules its scan exists to police.

``tests/test_guard_support.py`` fails the suite if any other test module walks the app
tree itself — the single-source enforcement that makes the floor unavoidable for the
next guard, the shape ``strip-comments.test.ts`` applies on the frontend (#838).

⚠️ **This module is imported, never collected** (its name does not match ``test_*.py``),
like ``r_support.py``. Import it as ``from tests.guard_support import app_files``.

⚠️ **Verifying a change HERE cannot be done by running the suite** — a walk that rots to
nothing turns every consumer green (#729). ``test_guard_support.py`` proves the floor and
the sentinel check can fire; a consumer migration is proven by DIFFING its old file list
against the new one, never by "the suite still passes".
"""
from __future__ import annotations

from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
APP_DIR = BACKEND_DIR / "app"


def app_files(
    subdir: str = "",
    *,
    floor: int,
    sentinels: tuple[str, ...] = (),
    recursive: bool = True,
) -> list[Path]:
    """Every ``.py`` module under ``app/<subdir>``, sorted, proven non-vacuous first.

    ``floor`` is the population self-check (#730): set it well below today's count
    — it detects a BAD ROOT, not growth. ``sentinels`` are paths relative to
    ``app/`` that must be in the result. Raises ``AssertionError`` with the failure
    frame (what was walked, how many, against what floor, and the remedy) so that a
    caller at module scope fails as loudly as one inside a test.
    """
    root = APP_DIR / subdir if subdir else APP_DIR

    # Tree identity, independent of the sub-directory asked for.
    assert (APP_DIR / "main.py").is_file(), (
        f"{APP_DIR} does not hold main.py, so this is not the application tree — "
        "tests/guard_support.py has moved and every scan built on it is looking at "
        "the wrong place."
    )

    files = sorted(root.rglob("*.py") if recursive else root.glob("*.py"))
    where = f"app/{subdir}" if subdir else "app/"
    assert len(files) >= floor, (
        f"app_files() found {len(files)} module(s) under {where} (recursive={recursive}) — "
        f"below the floor of {floor}. rglob returns [] for a bad path instead of raising, "
        "so every 'no offenders' assertion built on this list would pass VACUOUSLY (#730). "
        "Fix the sub-directory; do NOT lower the floor."
    )

    rels = {p.relative_to(APP_DIR).as_posix() for p in files}
    missing = [s for s in sentinels if s not in rels]
    assert not missing, (
        f"app_files() cannot see {missing} under {where}. A file COUNT ({len(files)}, over "
        f"the floor of {floor}) cannot tell this tree from another that also holds .py "
        "files; these are the modules the scan exists to police, so their absence means "
        "the root is wrong even though the count looked fine."
    )
    return files
