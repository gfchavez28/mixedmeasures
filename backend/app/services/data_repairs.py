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
exactly that reason; #1230's walks one index (`audit_entries.project_id`) and
writes only where a read found something; #1546's is one query per kind of edit entry,
returning only the leftovers (200 ms at 100,000 live hand edits, measured), and writes
only what they found; #1313's is one query over the variable-group metrics' stored
results.
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


def repair_deleted_project_audit(session_factory) -> None:
    """#1230 — remove the entries an older build left behind when it deleted a project.

    Before #1230 a delete kept them, so the next project given the same id listed them in
    its Excel export. `audit.repair_project_audit_rows` owns the rule (decided without a
    clock); a settled install pays a few indexed queries. Never raises.
    """
    from .audit import repair_project_audit_rows

    db = session_factory()
    try:
        removed = repair_project_audit_rows(db)
        db.commit()
        if removed:
            logger.info("Audit repair (#1230): removed %d entries of deleted projects", removed)
    except Exception:
        db.rollback()
        logger.exception("Audit repair (#1230) failed; skipping")
    finally:
        db.close()


def repair_leftover_audit_words(session_factory) -> None:
    """#1546 (D160) — the edit wording an older build's delete left in the audit trail.

    Before #1546 a conversation, dataset, record or column delete kept its turns' and
    answers' edit entries with their words, where no withdrawal could reach them.
    `deleted_source_audit.repair_leftover_words` owns the rule (it keeps what a live
    row's own history or a merge result's lifetime claims). SQL picks the candidates —
    one query per kind, so a settled install loads no entry — and it writes only what
    they found. Never raises.
    """
    from .deleted_source_audit import repair_leftover_words

    db = session_factory()
    try:
        stripped = repair_leftover_words(db)
        db.commit()
        if stripped:
            logger.info("Audit repair (#1546): stripped the words from %d entries of deleted sources", stripped)
    except Exception:
        db.rollback()
        logger.exception("Audit repair (#1546) failed; skipping")
    finally:
        db.close()


def repair_material_rc_keys(session_factory) -> None:
    """#1315 — the Relationships & Comparisons keys an older saver wrote on every tab.

    Strips them from every stored copy of a Descriptives chart and stamps `rc_view`
    on an R&C chart saved without one: the material, each canvas embed's own copy,
    each canvas snapshot. `material_config.normalise_rc_keys` owns the rule;
    `rc_keys_need_repair` is the gate — ONE query over `materials`, so a settled
    install pays exactly that. After a restore it repairs a backup taken before the
    fix. Never raises.
    """
    from .material_config import RcRepairScope, normalise_rc_keys, rc_keys_need_repair

    db = session_factory()
    try:
        if not rc_keys_need_repair(db):
            return
        normalise_rc_keys(db, scope=RcRepairScope.everything())
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("R&C key repair (#1315) failed; skipping")
    finally:
        db.close()


def repair_record_scores(session_factory) -> None:
    """#1313 — record scores and saved tests computed before the own-dataset rule.

    An older build judged a record against every column of a variable group across
    every dataset, so a group over two or more datasets scored almost no one, and
    a saved t-test or ANOVA read a sample the stored scores did not. Nothing marked
    them, so quick compute kept serving them. `metrics.repair_record_score_rule`
    owns the rule; `metrics_lacking_record_score_rule` is the gate — ONE query, and
    it finds nothing once every metric is recomputed or stamped. Marks only, never
    recomputes. After a restore it repairs a backup taken before the fix. Never
    raises.
    """
    from .metrics import metrics_lacking_record_score_rule, repair_record_score_rule

    db = session_factory()
    try:
        metric_ids = metrics_lacking_record_score_rule(db)
        if not metric_ids:
            return
        report = repair_record_score_rule(db, metric_ids)
        db.commit()
        if report.marked_stale or report.tests_marked:
            logger.info(
                "Record-score repair (#1313): %d metric(s) and %d saved test(s) marked out of date",
                len(report.marked_stale), report.tests_marked,
            )
    except Exception:
        db.rollback()
        logger.exception("Record-score repair (#1313) failed; skipping")
    finally:
        db.close()


def run_data_repairs(session_factory) -> None:
    """Every repair, in order. Blocking (the media backfill opens files), so an
    async caller runs it in a worker thread."""
    from .media_backfill import run_media_duration_backfill

    repair_reverse_recodes(session_factory)
    repair_missing_value_numbers(session_factory)
    repair_deleted_project_audit(session_factory)
    repair_leftover_audit_words(session_factory)
    repair_material_rc_keys(session_factory)
    repair_record_scores(session_factory)
    run_media_duration_backfill(session_factory)
