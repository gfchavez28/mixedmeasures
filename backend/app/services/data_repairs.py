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

⚠️ **Startup waits for this list** (Electron's `/health` probe is not answered
until the lifespan finishes), so a repair must cost a settled install a few
queries — never a scan of the data. #1069's is gated on column metadata for
exactly that reason.
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


def repair_missing_value_numbers(session_factory) -> None:
    """#1069 — clear the stored number on a cell its column now calls missing.

    #1048 widened the recognized-N/A defaults at READ time; numbers stored under
    the old rule stayed, so the correlation, comparison and export surfaces (which
    read the stored number) disagreed with every text surface about the same
    column. `missing_declaration.realign_undeclared_numbers` owns the rule and why
    it is gated on metadata — a settled install pays a few queries. After the
    reverse-recode repair, which can itself rewrite a primary's numbers. Never
    raises.
    """
    from .missing_declaration import realign_undeclared_numbers

    db = session_factory()
    try:
        changed = realign_undeclared_numbers(db)
        db.commit()
        if changed:
            logger.info(
                "Missing-value repair (#1069): realigned %d column(s) in %d project(s)",
                sum(len(c) for c in changed.values()), len(changed),
            )
    except Exception:
        db.rollback()
        logger.exception("Missing-value repair (#1069) failed; skipping")
    finally:
        db.close()


def run_data_repairs(session_factory) -> None:
    """Every repair, in order. Blocking (the media backfill opens files), so an
    async caller runs it in a worker thread."""
    from .media_backfill import run_media_duration_backfill

    repair_reverse_recodes(session_factory)
    repair_missing_value_numbers(session_factory)
    run_media_duration_backfill(session_factory)
