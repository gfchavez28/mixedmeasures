"""Observation (video-only coding source) CRUD.

An Observation is a recording coded on its OWN timeline, with no transcript —
the third Segment parent. This router owns the entity's lifecycle; attaching a
recording is handled by the shared media router mounted under
``.../observations/{observation_id}/media`` (media seam), and delineating clips
lives in the workbench (later slabs).
"""
import math
import shutil
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload, selectinload

from ..auth import get_current_user
from ..database import get_db
from ..models.code_application import CodeApplication
from ..models.note import Note
from ..services.note_numbering import next_note_sequence
from ..models.observation import Observation
from ..models.segment import Segment
from ..models.user import User
from ..schemas.common import AppliedCodeDetail, utc_wire
from ..schemas.conversation import MediaUploadResponse
from ..schemas.observation import (
    ClipCreate,
    ClipMergeRequest,
    ClipPreview,
    ClipSplitRequest,
    ClipUnsplitRequest,
    ClipUpdate,
    ObservationCreate,
    ObservationNoteCreate,
    ObservationResponse,
    ObservationSegmentResponse,
    ObservationUpdate,
    SegmentationCutResponse,
    SegmentationPreviewResponse,
)
from ..schemas.segment import SegmentNoteInfo
from ..services import media_storage
from ..services.audit import log_action
from ..services.coding_counts import (
    coded_segment_count as coded_segment_count_fn,
    coded_segment_counts,
    timeline_coverage_by_observation,
)
from ..services.coding_layers import CONSENSUS_ORIGIN, non_consensus_filter
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale
from ..services.observation_segmentation import (
    MAX_CLIPS,
    coverage_extent,
    MODE_CUE_LIST,
    MODE_NONE,
    CutResult,
    SegmentationError,
    cut_clips,
    looks_like_a_transcript,
    resequence_observation_clips,
)
from ..services.segment_operations import (
    merge_clips,
    split_clip_at_time,
    unmerge_segment,
    unsplit_clip,
)
from ..services.subtitle_import import (
    DEFAULT_SPEAKER,
    SubtitleImportError,
    parse_cue_bytes,
)
from .helpers import (
    _get_observation_or_404,
    _get_project_or_404,
    read_upload_with_limit,
    visible_segment_filter,
)
from .media import (
    _get_conversation,
    attach_recording,
    copy_recording,
    detach_recording,
    media_upload_response,
    stream_recording,
)

router = APIRouter(prefix="/api/projects/{project_id}/observations", tags=["observations"])

# The wizard renders a head, not the whole set — a 2,000-clip list is a megabyte
# of JSON nobody scrolls. `total_segments` carries the real count.
PREVIEW_CLIP_LIMIT = 20


def observation_to_response(
    observation: Observation,
    db: Session,
    *,
    segment_count: int | None = None,
    coded_segment_count: int | None = None,
    code_count: int | None = None,
    covered_seconds: float | None = None,
    coverage_extent_seconds: float | None = None,
    coverage_precomputed: bool = False,
) -> ObservationResponse:
    """Serialize an Observation with its clip counts + media stat.

    Counts exclude soft-deleted (merged/split) segments. Observations have no
    participant spine, so coded-count is not participant-scoped (like documents).
    The `code_count` excludes the derived consensus layer (J2-B) — which a FROZEN
    observation genuinely has (D18 superseded D2's blanket exclusion), so this is
    a real filter here, not just shape-keeping.

    Pass the counts in when serializing a LIST — computing them here costs three
    queries per row. The same applies to coverage (6a): pass
    ``coverage_precomputed=True`` with the batched values, or this runs its own
    two queries. The flag is explicit because BOTH coverage values are legitimately
    falsy (0.0 covered, None extent), so "did the caller supply them?" cannot be
    inferred from the values themselves — the falsy-zero trap.
    """
    if segment_count is None:
        segment_count = db.query(func.count(Segment.id)).filter(
            Segment.observation_id == observation.id, *visible_segment_filter()
        ).scalar() or 0
    if coded_segment_count is None:
        coded_segment_count = coded_segment_count_fn(
            db, Segment.observation_id, observation.id, participant_only=False
        )
    if code_count is None:
        code_count = db.query(func.count(func.distinct(CodeApplication.code_id))).join(
            Segment, Segment.id == CodeApplication.segment_id
        ).filter(
            Segment.observation_id == observation.id,
            *visible_segment_filter(),
            non_consensus_filter(),
        ).scalar() or 0

    if not coverage_precomputed:
        max_clip_end = db.query(func.max(Segment.end_time)).filter(
            Segment.observation_id == observation.id, *visible_segment_filter()
        ).scalar()
        coverage_extent_seconds = coverage_extent(
            observation.media_duration_seconds, max_clip_end
        )
        covered_seconds = (
            timeline_coverage_by_observation(
                db, {observation.id: coverage_extent_seconds}
            ).get(observation.id, 0.0)
            if coverage_extent_seconds is not None else 0.0
        )

    media_size_bytes, media_version = media_storage.media_file_stat(
        observation.project_id, media_storage.OBSERVATION,
        observation.id, observation.media_format,
    ) if observation.media_filename else (None, None)

    return ObservationResponse(
        id=observation.id,
        project_id=observation.project_id,
        name=observation.name,
        description=observation.description,
        created_at=observation.created_at,
        updated_at=observation.updated_at,
        segmentation_frozen_at=observation.segmentation_frozen_at,
        segment_count=segment_count,
        coded_segment_count=coded_segment_count,
        code_count=code_count,
        media_filename=observation.media_filename,
        media_format=observation.media_format,
        media_type=observation.media_type,
        media_duration_seconds=observation.media_duration_seconds,
        media_offset_seconds=observation.media_offset_seconds,
        media_is_vbr=observation.media_is_vbr,
        has_media=observation.media_filename is not None,
        media_size_bytes=media_size_bytes,
        media_version=media_version,
        covered_seconds=covered_seconds or 0.0,
        coverage_extent_seconds=coverage_extent_seconds,
    )


def _refuse_frozen_clip_set(observation: Observation) -> None:
    """D22 — a FROZEN clip set takes no clip-SET mutations: hard 409, explicit
    unfreeze. Label edits, notes, memos and coding stay legal while frozen
    (annotation, not segmentation — coding frozen clips is the point).

    Deliberately NOT the codebook freeze's client-only warn-then-proceed: this
    freeze is D18's consensus-eligibility discriminant, so "proceed anyway"
    would silently invalidate the statistics the freeze exists to license. Same
    posture as the shipped media-replace/reuse/cut 409s.
    """
    if observation.segmentation_frozen_at is not None:
        raise HTTPException(
            409,
            "This observation's clips are frozen — the team has agreed them. "
            "Unfreeze the segmentation to change the clip set.",
        )


@router.get("", response_model=list[ObservationResponse])
async def list_observations(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    rows = (
        db.query(Observation)
        .filter(Observation.project_id == project_id)
        .order_by(Observation.created_at.desc(), Observation.id.desc())
        .all()
    )
    if not rows:
        return []

    # Batch the counts. Serializing each row on its own runs THREE count queries
    # per observation (the list page is what makes that bite), so this mirrors
    # list_conversations rather than the naive comprehension it replaces.
    ids = [o.id for o in rows]
    clip_counts = dict(
        db.query(Segment.observation_id, func.count(Segment.id))
        .filter(Segment.observation_id.in_(ids), *visible_segment_filter())
        .group_by(Segment.observation_id)
        .all()
    )
    coded_counts = coded_segment_counts(
        db, Segment.observation_id, ids, participant_only=False
    )
    code_counts = dict(
        db.query(Segment.observation_id, func.count(func.distinct(CodeApplication.code_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .filter(
            Segment.observation_id.in_(ids),
            *visible_segment_filter(),
            non_consensus_filter(),
        )
        .group_by(Segment.observation_id)
        .all()
    )

    # Coverage (6a) rides the same batch — two more grouped queries for the whole
    # page, never per row. The extent is derived FIRST because it is the clamp
    # the coverage is measured against (D34).
    max_ends = dict(
        db.query(Segment.observation_id, func.max(Segment.end_time))
        .filter(Segment.observation_id.in_(ids), *visible_segment_filter())
        .group_by(Segment.observation_id)
        .all()
    )
    extents = {
        o.id: extent
        for o in rows
        if (extent := coverage_extent(o.media_duration_seconds, max_ends.get(o.id))) is not None
    }
    covered = timeline_coverage_by_observation(db, extents)

    return [
        observation_to_response(
            o, db,
            segment_count=clip_counts.get(o.id, 0),
            coded_segment_count=coded_counts.get(o.id, 0),
            code_count=code_counts.get(o.id, 0),
            covered_seconds=covered.get(o.id, 0.0),
            coverage_extent_seconds=extents.get(o.id),
            coverage_precomputed=True,
        )
        for o in rows
    ]


@router.post("", response_model=ObservationResponse)
async def create_observation(
    project_id: int,
    data: ObservationCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    observation = Observation(
        project_id=project_id, name=data.name, description=data.description,
    )
    db.add(observation)
    db.flush()
    log_action(
        db, action="observation_create", entity_type="observation",
        entity_id=observation.id, user_id=user.id, project_id=project_id,
        details={"name": observation.name},
    )
    db.commit()
    db.refresh(observation)
    return observation_to_response(observation, db)


@router.get("/{observation_id}", response_model=ObservationResponse)
async def get_observation(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    return observation_to_response(observation, db)


@router.patch("/{observation_id}", response_model=ObservationResponse)
async def update_observation(
    project_id: int,
    observation_id: int,
    data: ObservationUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    if data.name is not None:
        observation.name = data.name
    if data.description is not None:
        observation.description = data.description
    db.commit()
    db.refresh(observation)
    return observation_to_response(observation, db)


@router.delete("/{observation_id}")
async def delete_observation(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    # Media dir removed AFTER the DB delete commits (mirrors delete_conversation);
    # a leftover dir on rmtree failure is harmless (no DB row references it).
    media_dir = media_storage.media_owner_dir(
        project_id, media_storage.OBSERVATION, observation_id
    )
    db.delete(observation)
    log_action(
        db, action="observation_delete", entity_type="observation",
        entity_id=observation_id, user_id=user.id, project_id=project_id,
        details={"name": observation.name},
    )
    db.commit()
    if media_dir.exists():
        shutil.rmtree(media_dir, ignore_errors=True)
    return {"deleted": True}


# ── Recording (media) ──────────────────────────────────────────────────────
#
# The SECOND mount of the recording seam. All the heavy, risky logic — chunked
# spool, format sniff + mp4-family refine, ENOSPC→507, atomic replace, stale-
# format sweep, the six media columns, Range streaming — is shared with
# conversations via routers/media.py's owner-agnostic handlers. Only three
# things are ours: the ownership gate, the audit entity_type (carried by
# `owner_kind`), and the response builder.
#
# The gate is called HERE, by name, rather than injected into a shared factory —
# that is what keeps tests/test_ownership_gate_sweep.py's fail-closed AST scan
# able to SEE it (an injected resolver would have hidden the gate behind a
# parameter and forced a GATE_TOKENS entry, trading the guarantee for DRY).
#
# There is deliberately NO PATCH /media/offset here: an Observation's
# media_offset_seconds is definitionally 0 (the recording IS the timeline; a
# nonzero offset would shear coverage against duration).


@router.post("/{observation_id}/media", response_model=MediaUploadResponse)
async def upload_observation_media(
    project_id: int,
    observation_id: int,
    file: UploadFile,
    duration_seconds: float | None = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Attach a recording to an observation.

    `duration_seconds` is the browser's own measurement of the file, used only
    when the server cannot read the length itself. It matters far more here than
    on a conversation: the recording IS this source's timeline, so a NULL length
    means no ruler and no interval cutting.

    Replacing the recording under a FROZEN clip set is refused — the freeze is a
    promise that the agreed units are stable, and re-pointing them at a different
    recording would silently invalidate every clip boundary the team agreed on.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    if observation.segmentation_frozen_at is not None:
        raise HTTPException(
            409,
            "This observation's clips are frozen. Unfreeze the segmentation "
            "before replacing the recording — the existing clips are timed "
            "against the current one.",
        )
    await attach_recording(
        db, project_id=project_id, owner=observation,
        owner_kind=media_storage.OBSERVATION, file=file, user_id=user.id,
        duration_hint=duration_seconds,
    )
    return media_upload_response(observation)


@router.post("/{observation_id}/media/from-conversation/{conversation_id}",
             response_model=ObservationResponse)
async def reuse_conversation_recording(
    project_id: int,
    observation_id: int,
    conversation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Re-use a conversation's recording here, without re-uploading it (D17).

    The escape hatch for the one choice in this tool that cannot be undone: a
    Conversation codes what was SAID, an Observation codes what HAPPENED, and
    there is no conversion between them. Discovering that after uploading 4 GB —
    and being asked to upload it again — is a failure we can just remove.

    It copies the FILE, never the coding: this observation starts with no codes.

    TWO gates, both by name, and the second one is load-bearing:
    `_get_conversation` verifies the conversation lives in THIS project AND that
    the caller owns it. The sweep in test_ownership_gate_sweep.py passes an
    endpoint the moment it sees ANY gate token, so gating only the project here
    would have let a caller name another tenant's conversation and copy their
    recording into a project they own — where the stream endpoint would then
    happily serve it back.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    conversation = _get_conversation(db, project_id, conversation_id, user.id)

    if observation.segmentation_frozen_at is not None:
        raise HTTPException(
            409,
            "This observation's clips are frozen and are timed against its current "
            "recording. Unfreeze the segmentation before replacing it.",
        )

    await copy_recording(
        db, project_id=project_id,
        source_owner=conversation, source_kind=media_storage.CONVERSATION,
        target_owner=observation, target_kind=media_storage.OBSERVATION,
        user_id=user.id,
    )
    return observation_to_response(observation, db)


@router.get("/{observation_id}/media/stream")
async def stream_observation_media(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Stream an observation's recording (HTTP Range supported, for seeking)."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    return stream_recording(project_id, observation, media_storage.OBSERVATION)


@router.delete("/{observation_id}/media", response_model=ObservationResponse)
async def delete_observation_media(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Detach an observation's recording. The Observation itself survives — its
    clips and their codings are keyed on segments, not on the file."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    detach_recording(
        db, project_id=project_id, owner=observation,
        owner_kind=media_storage.OBSERVATION, user_id=user.id,
    )
    return observation_to_response(observation, db)


# ── Segmentation (cutting the timeline into clips) ─────────────────────────
#
# The recording is uploaded ONCE, through the media seam above. Preview and cut
# are both MEDIA-FREE: they read the length the server already persisted, so the
# clip count the wizard shows is computed by the same function, from the same
# number, as the clips it later writes. (A preview that took the file would mean
# uploading gigabytes twice and would still disagree with the import, because the
# browser's duration and the server's are different measurements.)


async def _resolve_segmentation(
    observation: Observation,
    mode: str,
    interval_seconds: float | None,
    cue_file: UploadFile | None,
) -> CutResult:
    """Shared by preview and cut — the ONE place a segmentation request is decided."""
    cues: list[dict] | None = None
    warnings: list[str] = []

    if mode == MODE_CUE_LIST:
        if cue_file is None:
            raise HTTPException(400, "Choose a cue file (.vtt or .srt) to cut clips from.")
        content = await read_upload_with_limit(cue_file)
        try:
            # Regex-heavy parse of untrusted input — off the event loop.
            cues = await run_in_threadpool(parse_cue_bytes, content)
        except SubtitleImportError as e:
            raise HTTPException(400, str(e)) from e
        if looks_like_a_transcript(cues, DEFAULT_SPEAKER):
            warnings.append(
                "This looks like a transcript — the cues name speakers. To code what was "
                "said (with searchable text, verbatim quotes and a speaker spine), import "
                "it as a Conversation with the recording attached instead. Cue text here "
                "only becomes a clip label."
            )

    try:
        result = cut_clips(
            mode,
            duration_seconds=observation.media_duration_seconds,
            interval_seconds=interval_seconds,
            cues=cues,
        )
    except SegmentationError as e:
        raise HTTPException(400, str(e)) from e

    result.warnings = warnings + result.warnings
    return result


@router.post(
    "/{observation_id}/segmentation/preview",
    response_model=SegmentationPreviewResponse,
)
async def preview_segmentation(
    project_id: int,
    observation_id: int,
    mode: str = Form(MODE_NONE),
    interval_seconds: float | None = Form(None),
    cue_file: UploadFile | None = File(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What cutting WOULD produce. Writes nothing."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    result = await _resolve_segmentation(observation, mode, interval_seconds, cue_file)
    return SegmentationPreviewResponse(
        total_segments=result.total,
        segments=[
            ClipPreview(
                sequence_order=i,
                start_time=c.start_time,
                end_time=c.end_time,
                label=c.label,
            )
            for i, c in enumerate(result.clips[:PREVIEW_CLIP_LIMIT])
        ],
        warnings=result.warnings,
    )


@router.post(
    "/{observation_id}/segmentation/cut",
    response_model=SegmentationCutResponse,
)
async def cut_segmentation(
    project_id: int,
    observation_id: int,
    mode: str = Form(MODE_NONE),
    interval_seconds: float | None = Form(None),
    cue_file: UploadFile | None = File(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Write the clips. Refuses rather than duplicating or overwriting.

    An observation that already has clips is NOT re-cut: a network retry would
    otherwise silently double the clip set, and re-cutting an observation someone
    has already coded would strand every existing code on a unit that no longer
    exists. Clearing clips is a workbench act, deliberately not a side effect of
    an import retry.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)

    existing = db.query(func.count(Segment.id)).filter(
        Segment.observation_id == observation.id, *visible_segment_filter()
    ).scalar() or 0
    if existing:
        raise HTTPException(
            409,
            f"This observation already has {existing} clip(s). Cut clips in the "
            "workbench rather than re-slicing the whole timeline.",
        )

    result = await _resolve_segmentation(observation, mode, interval_seconds, cue_file)

    for order, clip in enumerate(result.clips):
        db.add(
            Segment(
                observation_id=observation.id,
                sequence_order=order,
                start_time=clip.start_time,
                end_time=clip.end_time,
                # NOT NULL, and '' is the legal "unlabelled clip". A synthesized
                # label ("Clip 12") would flood search with noise duplicating the
                # timecode we already store.
                text=clip.label,
            )
        )

    log_action(
        db,
        action="segmentation_cut",
        entity_type=media_storage.OBSERVATION,
        entity_id=observation.id,
        user_id=user.id,
        project_id=project_id,
        details={"mode": mode, "clips": result.total},
    )
    db.commit()
    db.refresh(observation)

    return SegmentationCutResponse(
        observation=observation_to_response(observation, db),
        created=result.total,
        warnings=result.warnings,
    )


@router.post("/{observation_id}/segmentation/freeze", response_model=ObservationResponse)
async def freeze_segmentation(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Freeze an observation's clip set — the team has AGREED these units (D18).

    This is the decision that decides the whole reliability posture, so it is an
    explicit act rather than a mode toggled at import (and it mirrors the existing
    "Freeze Codebook" soft-lock, Track J · J3-1):

      FROZEN  -> every coder codes the SAME clips, so agreement is just "did we
                 apply the same codes?" => ordinary kappa + consensus +
                 reconciliation, through the engines that already ship. No
                 observational tool on the market offers this workflow.
      OPEN    -> each coder marks their own ranges => unitizing-alpha (agreement
                 about the BOUNDARIES), and no consensus (one voter per clip).

    Freeze BEFORE distributing for coding. Freezing afterwards does not
    retroactively make divergent clips shared — it only changes what the machinery
    will compute from here on.

    Refuses an observation with ZERO clips (400) — freezing records that the team
    agreed a specific clip set, and there is no set to agree on yet (D20 named
    this the nonsense state; the endpoint used to stamp it anyway).

    Idempotent: re-freezing keeps the original timestamp (the freeze is a fact
    about when the team agreed, not a toggle to bounce).

    #615 — freezing makes already-coded clips consensus-ELIGIBLE, so it marks
    them stale here; without that, consensus would not materialize until each
    clip's next incidental code mutation.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    if observation.segmentation_frozen_at is None:
        clip_count = db.query(func.count(Segment.id)).filter(
            Segment.observation_id == observation.id, *visible_segment_filter()
        ).scalar() or 0
        if not clip_count:
            raise HTTPException(
                400,
                "There are no clips to freeze yet. Cut or mark clips first — "
                "freezing records that the team agreed a specific clip set.",
            )
        observation.segmentation_frozen_at = datetime.now(timezone.utc).replace(tzinfo=None)
        # LOAD-BEARING flush (#615): mark_consensus_stale intersects candidate
        # ids with the eligibility clause via a SUBQUERY that re-reads
        # segmentation_frozen_at from the DB, and autoflush is OFF — without
        # this flush every id below is silently filtered back out (the marker
        # never lands and the test that freezes-then-sweeps fails).
        db.flush()
        if consensus_enabled(db):
            coded_ids = [
                sid
                for (sid,) in db.query(func.distinct(CodeApplication.segment_id))
                .join(Segment, Segment.id == CodeApplication.segment_id)
                .filter(
                    Segment.observation_id == observation.id,
                    *visible_segment_filter(),
                    non_consensus_filter(),
                )
            ]
            if coded_ids:
                mark_consensus_stale(db, project_id, segment_ids=coded_ids)
        log_action(
            db, action="segmentation_freeze", entity_type="observation",
            entity_id=observation.id, user_id=user.id, project_id=project_id,
            details={"name": observation.name, "clips": clip_count},
        )
        db.commit()
        db.refresh(observation)
    return observation_to_response(observation, db)


@router.post("/{observation_id}/segmentation/unfreeze", response_model=ObservationResponse)
async def unfreeze_segmentation(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Re-open an observation's clip set (D18).

    Deliberately allowed, and no HUMAN coding is touched. What changes is what
    the machinery computes: the clips stop being consensus-eligible, so their
    DERIVED consensus layer is dropped HERE, synchronously (#615) — it cannot
    ride the staleness markers, because ``mark_consensus_stale`` intersects
    candidate ids with the eligibility clause BEFORE inserting, so a now-open
    clip's id is filtered out and no sweep would ever revisit it. Reliability
    reverts to the open-cuts statistics.

    The UI must say that plainly before calling this: re-opening mid-study means
    the team is no longer coding an agreed unit set, and any kappa/consensus
    already reported was computed against units that are now open to change.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    if observation.segmentation_frozen_at is not None:
        observation.segmentation_frozen_at = None
        # Scope = ALL of this observation's segments, soft-deleted included
        # (cleaner ⊃ writer — a consensus row can sit on a merged/split-away
        # original), and deliberately NOT gated on consensus_enabled: the rows
        # may predate a roster change. Only the derived origin='consensus' rows
        # go; every human application stays.
        dropped = (
            db.query(CodeApplication)
            .filter(
                CodeApplication.origin == CONSENSUS_ORIGIN,
                CodeApplication.segment_id.in_(
                    db.query(Segment.id).filter(
                        Segment.observation_id == observation.id
                    )
                ),
            )
            .delete(synchronize_session=False)
        )
        log_action(
            db, action="segmentation_unfreeze", entity_type="observation",
            entity_id=observation.id, user_id=user.id, project_id=project_id,
            details={"name": observation.name, "consensus_rows_dropped": dropped},
        )
        db.commit()
        db.refresh(observation)
    return observation_to_response(observation, db)


# ── Clips (slab 3a) ────────────────────────────────────────────────────────
#
# The workbench's clip CRUD. A clip is a Segment with observation_id set;
# start_time/end_time carry the range (start == end is a legal POINT EVENT,
# D7), text holds the label ('' = unlabelled). Frozen-ness gates the clip SET
# (create/delete/time-edit → 409 via _refuse_frozen_clip_set), never the label.
# Every mutation ends with resequence_observation_clips — sequence_order is
# what every ordering surface reads, and nothing else reconciles it against
# start_time (§8h.3). Time-based split/merge land in slab 3b.


def _get_visible_clip_or_404(db: Session, observation_id: int, segment_id: int) -> Segment:
    segment = (
        db.query(Segment)
        .filter(
            Segment.id == segment_id,
            Segment.observation_id == observation_id,
            *visible_segment_filter(),
        )
        .first()
    )
    if segment is None:
        raise HTTPException(404, "Clip not found in this observation")
    return segment


def _validate_clip_range(start_time: float, end_time: float) -> None:
    """Range sanity. NO upper clamp against the recording's duration — clips
    past its end are legal (the cue posture: the cue file and the recording are
    independent artifacts, and the timeline is allowed to outrun the media)."""
    if not (math.isfinite(start_time) and math.isfinite(end_time)):
        raise HTTPException(400, "Clip times must be finite numbers of seconds.")
    if start_time < 0:
        raise HTTPException(400, "A clip cannot start before 0:00.")
    if end_time < start_time:
        raise HTTPException(400, "A clip's end must not come before its start.")


def _clip_to_response(segment: Segment) -> ObservationSegmentResponse:
    """Serialize one clip. Mirrors segments.py's builder: the human/working
    layer only — a consensus row must not inflate the client gauges (P-1)."""
    human_apps = [
        ca for ca in segment.code_applications if ca.origin != CONSENSUS_ORIGIN
    ]
    active_notes = sorted(
        (n for n in segment.attached_notes if not n.is_archived),
        key=lambda n: n.sequence_number or 0,
    )
    return ObservationSegmentResponse(
        id=segment.id,
        sequence_order=segment.sequence_order,
        start_time=segment.start_time,
        end_time=segment.end_time,
        text=segment.text,
        applied_codes=[ca.code_id for ca in human_apps],
        applied_code_details=[
            AppliedCodeDetail(
                code_id=ca.code_id,
                user_id=ca.user_id,
                attribution=ca.attribution,
                is_universal=bool(ca.code.is_universal) if ca.code else False,
            )
            for ca in human_apps
        ],
        attached_notes=[
            SegmentNoteInfo(id=n.id, sequence_number=n.sequence_number)
            for n in active_notes
        ],
        created_at=segment.created_at,
    )


@router.get(
    "/{observation_id}/segments",
    response_model=list[ObservationSegmentResponse],
)
async def list_observation_segments(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The workbench's clip list — visible clips in sequence order."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    segments = (
        db.query(Segment)
        .options(
            # N+1 guard (the get_document pattern): the builder reads
            # ca.code.is_universal per application.
            selectinload(Segment.code_applications).joinedload(CodeApplication.code),
            selectinload(Segment.attached_notes),
        )
        .filter(Segment.observation_id == observation.id, *visible_segment_filter())
        .order_by(Segment.sequence_order)
        .all()
    )
    return [_clip_to_response(s) for s in segments]


@router.post(
    "/{observation_id}/segments",
    response_model=ObservationSegmentResponse,
)
async def create_clip(
    project_id: int,
    observation_id: int,
    data: ClipCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark one clip (workbench I/O marks, drag, or a point event).

    The MAX_CLIPS cap applies here too — the cut-time cap alone would let the
    timeline grow unbounded one manual mark at a time.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)
    _validate_clip_range(data.start_time, data.end_time)

    existing = db.query(func.count(Segment.id)).filter(
        Segment.observation_id == observation.id, *visible_segment_filter()
    ).scalar() or 0
    if existing >= MAX_CLIPS:
        raise HTTPException(
            400,
            f"This observation already has {MAX_CLIPS:,} clips — the limit. "
            "Merge or delete clips before marking more.",
        )

    segment = Segment(
        observation_id=observation.id,
        sequence_order=existing,  # provisional; resequence derives the real one
        start_time=data.start_time,
        end_time=data.end_time,
        text=data.text,
    )
    db.add(segment)
    db.flush()
    resequence_observation_clips(db, observation.id)
    log_action(
        db, action="clip_create", entity_type="segment", entity_id=segment.id,
        user_id=user.id, project_id=project_id,
        details={
            "observation_id": observation.id,
            "start_time": data.start_time,
            "end_time": data.end_time,
        },
    )
    db.commit()
    db.refresh(segment)
    return _clip_to_response(segment)


@router.patch(
    "/{observation_id}/segments/{segment_id}",
    response_model=ObservationSegmentResponse,
)
async def update_clip(
    project_id: int,
    observation_id: int,
    segment_id: int,
    data: ClipUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Edit a clip's boundaries and/or label.

    D22: while frozen, the TIME fields 409 (a boundary IS the cut) but the
    label stays editable — annotation, not segmentation.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    segment = _get_visible_clip_or_404(db, observation.id, segment_id)

    time_change = data.start_time is not None or data.end_time is not None
    if not time_change and data.text is None:
        return _clip_to_response(segment)

    old = {
        "start_time": segment.start_time,
        "end_time": segment.end_time,
        "text": segment.text,
    }
    if time_change:
        _refuse_frozen_clip_set(observation)
        new_start = data.start_time if data.start_time is not None else segment.start_time
        new_end = data.end_time if data.end_time is not None else segment.end_time
        _validate_clip_range(new_start, new_end)
        segment.start_time = new_start
        segment.end_time = new_end
        db.flush()
        resequence_observation_clips(db, observation.id)
    if data.text is not None:
        segment.text = data.text

    log_action(
        db, action="clip_update", entity_type="segment", entity_id=segment.id,
        user_id=user.id, project_id=project_id,
        details={
            "observation_id": observation.id,
            "old": old,
            "new": {
                "start_time": segment.start_time,
                "end_time": segment.end_time,
                "text": segment.text,
            },
        },
    )
    db.commit()
    db.refresh(segment)
    return _clip_to_response(segment)


@router.delete("/{observation_id}/segments/{segment_id}")
async def delete_clip(
    project_id: int,
    observation_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a clip — the first hard segment delete in the app, safe here
    because clips are researcher-created marks, not material.

    The DB owns the cascade: CodeApplications and Excerpts on the clip are
    CASCADE-deleted (consensus rows are CodeApplications, so they go too);
    a Note's segment link is SET NULL, so the note SURVIVES as an
    observation-level note. The client confirm for an annotated clip states
    exactly that.
    """
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)
    segment = _get_visible_clip_or_404(db, observation.id, segment_id)

    codes_removed = len(
        [ca for ca in segment.code_applications if ca.origin != CONSENSUS_ORIGIN]
    )
    detail = {
        "observation_id": observation.id,
        "start_time": segment.start_time,
        "end_time": segment.end_time,
        "label": segment.text,
        "codes_removed": codes_removed,
    }
    db.delete(segment)
    db.flush()
    resequence_observation_clips(db, observation.id)
    log_action(
        db, action="clip_delete", entity_type="segment", entity_id=segment_id,
        user_id=user.id, project_id=project_id, details=detail,
    )
    db.commit()
    return {"deleted": True}


# ── Time operations (slab 3b) ──────────────────────────────────────────────
#
# The op semantics (carry rules, tiling validation, resequence) live in
# services/segment_operations.py; here each endpoint contributes ownership
# (_get_observation_or_404 BY NAME, the AST sweep's contract) + the D22 frozen
# 409. unmerge REUSES the parent-generic unmerge_segment; unsplit is the
# time-specific unsplit_clip (both half ids explicit — never the text op's
# contiguity heuristic).


@router.post(
    "/{observation_id}/segments/{segment_id}/split",
    response_model=list[ObservationSegmentResponse],
)
async def split_clip(
    project_id: int,
    observation_id: int,
    segment_id: int,
    data: ClipSplitRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Split a clip at a time strictly inside its range → its two halves."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)
    halves = split_clip_at_time(
        db, segment_id, data.time, observation.id, project_id, user.id
    )
    return [_clip_to_response(s) for s in halves]


@router.post(
    "/{observation_id}/segments/merge",
    response_model=ObservationSegmentResponse,
)
async def merge_observation_clips(
    project_id: int,
    observation_id: int,
    data: ClipMergeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merge ≥2 clips (no adjacency; the merged range spans gaps)."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)
    merged = merge_clips(db, data.segment_ids, observation.id, project_id, user.id)
    return _clip_to_response(merged)


@router.post(
    "/{observation_id}/segments/{segment_id}/unmerge",
    response_model=list[ObservationSegmentResponse],
)
async def unmerge_clip(
    project_id: int,
    observation_id: int,
    segment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Undo a clip merge — restores the originals (notes included)."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)
    restored, _count = unmerge_segment(
        db, segment_id, 'observation', observation.id, project_id, user.id
    )
    return [_clip_to_response(s) for s in restored]


@router.post(
    "/{observation_id}/segments/unsplit",
    response_model=ObservationSegmentResponse,
)
async def unsplit_observation_clip(
    project_id: int,
    observation_id: int,
    data: ClipUnsplitRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Undo a time split — rejoins the two named halves into the original."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)
    _refuse_frozen_clip_set(observation)
    restored = unsplit_clip(db, data.segment_ids, observation.id, project_id, user.id)
    return _clip_to_response(restored)


# ── Notes (slab 4a) ────────────────────────────────────────────────────────
#
# The Note model already supports clips (`observation_id`, CASCADE, the widened
# `ck_note_at_least_one_parent`), but there was no create/list path — an
# imported observation note 404'd on get/update/archive (fixed by the
# `_validate_note_parent` observation branch). A clip note MUST set
# `observation_id` (the CHECK has no segment arm), which is also what makes a
# clip note SURVIVE the clip's deletion as an observation-level note.


def _observation_note_dict(note: Note) -> dict:
    """Mirror the document-note response shape (documents.py::list_document_notes)."""
    seg = note.segment
    return {
        "id": note.id,
        "observation_id": note.observation_id,
        "segment_id": note.segment_id,
        "content": note.content,
        "segment_sequence_order": seg.sequence_order if seg else None,
        "segment_text_snippet": (
            (seg.text[:100] + "...") if seg and len(seg.text) > 100
            else (seg.text if seg else None)
        ),
        "created_at": utc_wire(note.created_at),
        "updated_at": utc_wire(note.updated_at),
    }


@router.post("/{observation_id}/notes")
async def create_observation_note(
    project_id: int,
    observation_id: int,
    data: ObservationNoteCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a note on an observation, optionally anchored to a clip."""
    observation = _get_observation_or_404(db, project_id, observation_id, user.id)

    # SECURITY: a named clip MUST belong to THIS observation. The ownership AST
    # sweep passes on the first gate token it sees and is structurally BLIND to a
    # second entity id (the D17 lesson), so this cross-tenant guard is enforced by
    # hand here and pinned by a behavioral test — never trust the sweep for it.
    if data.segment_id is not None:
        clip = db.query(Segment).filter(
            Segment.id == data.segment_id,
            Segment.observation_id == observation_id,
        ).first()
        if not clip:
            raise HTTPException(status_code=404, detail="Clip not found in this observation")

    note = Note(
        observation_id=observation_id,  # the parent — a clip note keeps it (CHECK)
        segment_id=data.segment_id,
        conversation_id=None,
        document_id=None,
        dataset_value_id=None,
        content=data.content,
    )
    # #747: was a literal 0, so every observation note was "note 0" — visible the
    # moment #740 gave each note its own badge, and printed as `N-0` by the Excel
    # export and the Memos & Notes page all along.
    note.sequence_number = next_note_sequence(db, note)
    db.add(note)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="note",
        entity_id=note.id,
        user_id=user.id,
        project_id=project_id,
        details={"observation_id": observation_id, "segment_id": data.segment_id},
    )
    db.commit()
    db.refresh(note)
    return _observation_note_dict(note)


@router.get("/{observation_id}/notes")
async def list_observation_notes(
    project_id: int,
    observation_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List an observation's notes (observation-level + clip-anchored)."""
    _get_observation_or_404(db, project_id, observation_id, user.id)

    notes = (
        db.query(Note)
        .filter(
            Note.observation_id == observation_id,
            Note.is_archived == False,
        )
        .options(joinedload(Note.segment))
        .order_by(Note.id)
        .all()
    )
    return [_observation_note_dict(n) for n in notes]
