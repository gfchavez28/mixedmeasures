"""#631 regression: migrations must not silence the application's loggers.

The bug: `alembic/env.py` called `fileConfig(...)` without
`disable_existing_loggers=False`, and Python's default for that argument is
True. `run_migrations()` runs on EVERY boot, after `app.main` and its
router/service imports have already created their module-level loggers — so all
31 `app.*` loggers ended up `disabled=True`. Every deliberate
caught-log-and-continue diagnostic went silent: a failed auto-backup (in a tool
whose premise is that this data is irreplaceable), the #578 reverse-recode
repair, the consensus sweep, the #574 duration backfill.

⚠️ These tests assert on logger STATE, never on captured output. `caplog`
installs its own handler and forces levels, so a `caplog`-based test passes
green against the broken app — which is exactly why this survived for so long,
and why `backend/tests/the internal design notes carried it as a test-harness quirk rather than
a production defect.
"""

import logging
from logging.config import fileConfig

import pytest

from app.config import resource_base
from app.main import configure_app_logging


# The real call sites this protects. If a module moves, update the list —
# the point is to pin the loggers that carry non-fatal failure diagnostics.
DIAGNOSTIC_LOGGERS = [
    "app.main",              # auto-backup failed / shutdown backup failed
    "app.database",          # pre-migration backup, unreadable-DB refusal
    "app.services.recode",   # #578 reverse-recode repair
    "app.services.media_backfill",  # #574 duration backfill
]


@pytest.fixture
def restore_logging():
    """Snapshot and restore global logging state around a fileConfig call."""
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_root_level = root.level
    saved = {
        name: (logging.getLogger(name).level, logging.getLogger(name).disabled)
        for name in DIAGNOSTIC_LOGGERS + ["app"]
    }
    yield
    root.handlers[:] = saved_handlers
    root.setLevel(saved_root_level)
    for name, (level, disabled) in saved.items():
        lg = logging.getLogger(name)
        lg.setLevel(level)
        lg.disabled = disabled


def _run_real_alembic_fileconfig():
    """Replay exactly what `alembic/env.py` does at migration time.

    Uses the REAL `alembic.ini` so the test tracks the shipped config rather
    than a re-implementation of it.
    """
    ini = resource_base() / "alembic.ini"
    assert ini.exists(), f"alembic.ini not found at {ini}"
    fileConfig(str(ini), disable_existing_loggers=False)


@pytest.mark.parametrize("name", DIAGNOSTIC_LOGGERS)
def test_app_loggers_survive_migration_logging_config(name, restore_logging):
    """After the migration-time fileConfig, app diagnostics must still emit.

    Mutating `env.py` to drop `disable_existing_loggers=False` (or this test's
    replay of it) turns every assertion below False.
    """
    configure_app_logging()
    logging.getLogger(name)  # created BEFORE migrations, as at real startup

    _run_real_alembic_fileconfig()

    lg = logging.getLogger(name)
    assert lg.disabled is False, f"{name} was disabled by the migration logging config"
    assert lg.isEnabledFor(logging.ERROR), f"{name} cannot emit ERROR"
    assert lg.isEnabledFor(logging.WARNING), f"{name} cannot emit WARNING"


def test_app_info_survives_the_warn_root(restore_logging):
    """INFO diagnostics must reach the log despite `[logger_root] level = WARN`.

    This is the half that `disable_existing_loggers=False` alone does NOT fix:
    `app.*` loggers have no level of their own, so they inherit root's WARN and
    every `logger.info` is dropped. `configure_app_logging` pins the `app`
    namespace at INFO, which survives fileConfig's replacement of root.
    """
    configure_app_logging()
    _run_real_alembic_fileconfig()

    assert logging.getLogger().level == logging.WARNING, (
        "precondition: alembic.ini is expected to set root to WARN — if this "
        "fails the test below is no longer proving anything"
    )
    assert logging.getLogger("app.services.media_backfill").isEnabledFor(logging.INFO), (
        "the #574 backfill summary — the log line whose absence surfaced #631 — "
        "is still unreachable"
    )


def test_real_run_migrations_does_not_disable_app_loggers(restore_logging):
    """The REAL path: `run_migrations()` → `env.py` → `fileConfig`.

    The replay tests above cannot catch a regression in `env.py` itself — they
    pass their own `disable_existing_loggers=False`, so reverting the shipped
    fix would leave them green. This one drives the actual startup call, so it
    is the test that fails if `alembic/env.py` loses the kwarg.

    Runs against conftest's `:memory:` database. Alembic builds its own engine,
    so this is a throwaway in-memory DB distinct from the app's StaticPool one —
    no other test's state is touched.
    """
    from app.database import run_migrations

    configure_app_logging()
    for name in DIAGNOSTIC_LOGGERS:
        logging.getLogger(name)  # created BEFORE migrations, as at real startup

    run_migrations()

    for name in DIAGNOSTIC_LOGGERS:
        lg = logging.getLogger(name)
        assert lg.disabled is False, (
            f"{name} was disabled by run_migrations() — alembic/env.py must pass "
            "disable_existing_loggers=False to fileConfig (#631)"
        )
        assert lg.isEnabledFor(logging.ERROR), f"{name} cannot emit ERROR after migrations"


def test_a_handler_exists_without_alembic(restore_logging):
    """The app must not depend on a migration tool to install its handler.

    Strips root's handlers, then asserts `configure_app_logging` puts one back.
    """
    root = logging.getLogger()
    root.handlers[:] = []

    configure_app_logging()

    assert root.handlers, "configure_app_logging installed no handler"
