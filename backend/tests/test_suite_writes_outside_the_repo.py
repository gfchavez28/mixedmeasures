"""The suite must not write into the working tree (#916).

`conftest.py` pins `MM_DATABASE_PATH`, `MM_BACKUP_DIR` and `MM_DATA_DIR` before any
app import. Without the backup pin, every "merge"/"overwrite" import test wrote a
real `pre-*.mmproject` safety export into `backend/backups/` — the developer's own
backup folder, alongside the app's rotated `.mmbackup`s. **1,946 files / 31 MB** had
accumulated before anyone noticed, because the directory is git-ignored: `git
status` is clean the whole time, so nothing in the ordinary close-out could see it.

🔴 **The pins are three lines of `os.environ` in a module nobody re-reads, and a
suite that has lost them is GREEN.** That is the whole argument for this file: the
damage is invisible to `git status`, invisible to the suite, and only shows up as a
folder that has quietly grown for months. The three assertions below are cheap and
they fail the moment a pin is deleted, moved below the first app import, or
overridden by an environment that points back into the tree.

⚠️ **This guard is about WHERE the settings point, never about what any one test
does.** Three test modules patch `get_backup_dir` locally for their own assertions;
that is correct and invisible here. A test that hand-rolls a write into the repo by
some other route is a different defect and this file does not claim to catch it.
"""

import inspect
from pathlib import Path

import pytest

from app import config

# tests/ → backend/ → the repository root.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

#: Accessors in `app.config` that answer "where does the app WRITE?". Derived by
#: name from the module rather than listed here, so a fourth writable path is
#: covered on the day it is added — the enumeration lives in the artifact the next
#: one must touch (`config.py`), not in a list this file would have to remember.
#:
#: ⚠️ `resource_base()` and `dist_dir()` are deliberately NOT in this population and
#: must never join it: they are READ-ONLY bundled resources (the alembic tree, the
#: built SPA) and are legitimately inside the repo in dev. The `get_*_dir` shape is
#: what separates them — see `config.py`'s own docstring on `resource_base`.
WRITABLE_DIR_ACCESSOR_PREFIX = "get_"
WRITABLE_DIR_ACCESSOR_SUFFIX = "_dir"
MIN_WRITABLE_DIR_ACCESSORS = 3  # documents, media, backups


def writable_dir_accessors() -> list[tuple[str, object]]:
    """Every zero-argument `get_*_dir()` in `app.config`."""
    found = []
    for name, obj in vars(config).items():
        if not (
            name.startswith(WRITABLE_DIR_ACCESSOR_PREFIX)
            and name.endswith(WRITABLE_DIR_ACCESSOR_SUFFIX)
            and callable(obj)
            and getattr(obj, "__module__", None) == config.__name__
        ):
            continue
        if inspect.signature(obj).parameters:
            continue
        found.append((name, obj))
    return sorted(found)


def is_inside_repo(path: Path) -> bool:
    """Does `path` resolve to somewhere inside the working tree?

    Relative settings resolve against the CWD, which is `backend/` when the suite is
    run from there and the repo root when it is run from the root — inside the tree
    either way, which is the point.
    """
    try:
        path.resolve().relative_to(REPO_ROOT)
        return True
    except ValueError:
        return False


def test_the_repo_root_is_actually_the_repo():
    """Self-check: a wrong REPO_ROOT makes every containment test below vacuous.

    `Path.relative_to` raises for any path outside the root, so a root pointing at,
    say, `/` or a directory that does not exist would report "outside the repo" for
    everything and this file would pass while the folder filled up.
    """
    assert (REPO_ROOT / "backend" / "app" / "config.py").is_file(), (
        f"REPO_ROOT={REPO_ROOT} does not look like the repository — every "
        "containment assertion in this file is vacuous until this is fixed."
    )


def test_the_containment_predicate_fires():
    """Predicate falsifier: prove `is_inside_repo` can return True.

    Without this, a predicate that always returned False would pass every assertion
    below — the failure mode #729 names, where a guard's own matcher has rotted and
    a green run means nothing.
    """
    assert is_inside_repo(REPO_ROOT / "backend" / "backups")
    assert not is_inside_repo(Path("/tmp"))


def test_the_database_is_in_memory():
    """The oldest pin, and it had no guard at all until #916.

    `conftest.py` line 6 exists so the module-level engine in `app.database` cannot
    reach the real `dev.db`. Losing it does not fail anything — the suite runs
    happily against the developer's live research data.
    """
    assert config.get_settings().mm_database_path.startswith(":memory:")


@pytest.mark.parametrize("name", [n for n, _ in writable_dir_accessors()])
def test_no_writable_path_points_into_the_repo(name):
    accessor = dict(writable_dir_accessors())[name]
    path = accessor()
    assert not is_inside_repo(path), (
        f"config.{name}() resolves to {path.resolve()}, inside the working tree. "
        "The suite would write real files into the developer's own folder "
        "(#916). Check the MM_BACKUP_DIR / MM_DATA_DIR pins at the top of "
        "tests/conftest.py — they must be set BEFORE any app import, and an "
        "environment that presets either one wins over them."
    )


def test_the_population_is_not_empty():
    """A parametrized test over an empty list passes by running nothing.

    So assert the walk found the accessors it exists to check — the population
    self-check that `assert offenders == []` can never give you.
    """
    names = [n for n, _ in writable_dir_accessors()]
    assert len(names) >= MIN_WRITABLE_DIR_ACCESSORS, (
        f"Found only {names} in app.config; expected at least "
        f"{MIN_WRITABLE_DIR_ACCESSORS} writable-directory accessors. The naming "
        "convention this walk keys on has changed — fix the walk, not this number."
    )
