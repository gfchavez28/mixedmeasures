"""One-shot backfill of `media_duration_seconds` for recordings that have none (#574).

Duration extraction runs at ATTACH time only, so the `4f61ac0` fix (`.mov`/`.mp4`
via `moov/mvhd`) and #573's WebM probe help NEW uploads and nothing else. Every
`.mov` and `.webm` attached since video V1 kept `media_duration_seconds = NULL`
forever. That is cosmetic for a Conversation — the transcript drives the timeline
and the browser reports the element's own duration — but an Observation's
timeline IS the recording: `cut_clips` refuses fixed-interval slicing without a
length, and the coverage denominator silently falls back to the farthest clip end.

**Runs on every boot, not once.** Two paths keep MINTING NULL durations after the
fix, so a done-flag would be wrong: `copy_recording` propagates the source's value
verbatim across the D17 recording-reuse hatch, and `.mmproject` import both
restores serialized NULLs and nulls all six media columns when the archive's file
is absent on disk (an `include_media=False` export). The `IS NULL` filter is what
makes repetition cheap — once everything readable is filled, the pass is one
query and no file IO.

Deliberately NOT a migration (it needs file IO and the media dir, neither of
which belongs in Alembic) and deliberately not a `scripts/` command: `scripts/`
is absent from the PyInstaller `datas`, so it does not exist inside the packaged
desktop app — where every affected user is.
"""

import logging

from sqlalchemy.orm import Session

from ..models.conversation import Conversation
from ..models.observation import Observation
from . import media_storage
from .media_duration import _extract_duration

logger = logging.getLogger(__name__)

# The two recording owners. Their media blocks are column-identical, so one loop
# covers both — the same (kind, model) shape `project_portability` already uses.
_OWNERS = (("conversation", Conversation), ("observation", Observation))


def backfill_media_durations(db: Session) -> dict[str, int]:
    """Fill `media_duration_seconds` wherever it is NULL and the file can answer.

    Returns a count breakdown for logging. Never raises: a probe that fails is a
    row we skip, not a startup that dies.
    """
    filled = 0
    missing_file = 0
    unreadable = 0

    for kind, model in _OWNERS:
        rows = (
            db.query(model)
            .filter(
                model.media_filename.isnot(None),
                model.media_duration_seconds.is_(None),
            )
            .all()
        )
        for row in rows:
            if not row.media_format:
                unreadable += 1
                continue
            path = media_storage.media_owner_dir(
                row.project_id, kind, row.id
            ) / f"original.{row.media_format}"
            # A row whose file is gone is a normal state, not an error (#551):
            # media-excluded backups and manual cleanups both produce it.
            if not path.exists():
                missing_file += 1
                continue
            duration = _extract_duration(path, row.media_format)
            if duration is None:
                # Formats whose container carries no answer — a live-muxed WebM
                # most often. These are re-probed on every boot by design; the
                # cost is a bounded header walk, never a full read.
                unreadable += 1
                continue
            # Only TRUE NULLs are touched. There is no provenance marker on this
            # column, so a client-measured value and a container probe are
            # indistinguishable once stored — and the browser's number is often
            # the better one. Overwriting would silently replace a measurement
            # with a declaration.
            row.media_duration_seconds = duration
            filled += 1

    if filled:
        db.commit()

    return {"filled": filled, "missing_file": missing_file, "unreadable": unreadable}


def run_media_duration_backfill(session_factory) -> None:
    """Lifespan entry point: bounded, self-limiting, never fails startup.

    Mirrors `repair_reverse_recodes` in `main.py` — own session, broad except,
    rollback and log rather than propagate. The log line names the skip reasons
    so "why is my recording still lengthless?" is answerable from the log instead
    of by re-deriving the format matrix.
    """
    db = session_factory()
    try:
        counts = backfill_media_durations(db)
        if counts["filled"] or counts["missing_file"] or counts["unreadable"]:
            logger.info(
                "Media duration backfill: filled %d, skipped %d (file absent), "
                "skipped %d (container carries no duration)",
                counts["filled"],
                counts["missing_file"],
                counts["unreadable"],
            )
    except Exception:
        db.rollback()
        logger.exception("Media duration backfill failed; continuing startup")
    finally:
        db.close()
