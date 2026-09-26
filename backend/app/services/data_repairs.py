"""The repairs a database gets whenever this build OPENS one (#1026).

Migrations change the schema; these change DATA that an older build wrote wrongly
or left incomplete. Both are part of bringing a database to this version, and a
database is opened in two places: at startup, and when a restore swaps one in
underneath the running app. Until #1026 only startup ran these, so a restored
backup from before a repair shipped kept the defect until the next relaunch —
statistics computed in between read the unrepaired values.

One list, two callers (`main.py`'s lifespan and `routers/backup.py`'s restore), so
the next repair added here reaches both. Each is idempotent and self-limiting, and
none may fail its caller: startup must still start, and a restore that has already
swapped the files must still say so.
"""

import logging

logger = logging.getLogger(__name__)


def repair_reverse_recodes(session_factory) -> None:
    """One-time idempotent repair of the #578 reverse double-flip.

    Reverse recodes created through the (buggy) Recode Workbench stored flipped
    codes that the backend then re-flipped at apply time, so value_numeric kept
    its forward (un-reversed) value. This rewrites those mappings to forward codes
    and re-applies primaries. Self-terminating: once forward, later runs find
    nothing to do. Bounded (reverse defs are few); never raises.
    """
    from .recode import repair_reverse_recode_mappings

    db = session_factory()
    try:
        repair_reverse_recode_mappings(db)
    except Exception:
        db.rollback()
        logger.exception("Reverse recode repair (#578) failed; skipping")
    finally:
        db.close()


def run_data_repairs(session_factory) -> None:
    """Every repair, in order. Blocking (the media backfill opens files), so an
    async caller runs it in a worker thread."""
    from .media_backfill import run_media_duration_backfill

    repair_reverse_recodes(session_factory)
    run_media_duration_backfill(session_factory)
