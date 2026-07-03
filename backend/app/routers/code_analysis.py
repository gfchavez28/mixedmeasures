"""Router for cross-conversation qualitative code analysis."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
import io
import csv

from ..database import get_db
from ..models.user import User
from ..auth import get_current_user
from .auth import limiter
from .helpers import parse_int_list, _get_project_or_404, sanitize_csv_filename
from .export_helpers import csv_safe
from ..services.code_analysis import (
    get_code_frequencies,
    get_segments_with_context,
    get_demographic_filter_options,
    get_code_cooccurrence,
    get_coded_comments_with_context,
    get_source_frequencies,
    get_source_level_cooccurrence,
    get_demographic_comparison,
    get_saturation_data,
    get_text_columns_with_coding,
    _get_ordered_codes,
    _build_cooccurrence_response,
)
from ..services.irr import compute_irr
from ..services.coding_coverage import source_coder_coverage, project_coder_coverage
from ..services.reconciliation import build_reconciliation
from ..services.consensus import consensus_enabled, consensus_exists_for_project
from ..services.consensus_staleness import sweep_stale_consensus
from ..services.audit import log_action
from ..models.consensus_stale_target import ConsensusStaleTarget
from ..schemas.code_analysis import (
    CoderCoverageItem,
    CoderCoverageResponse,
    CodeSegmentsWithContextResponse,
    DemographicFilterOptionsResponse,
    CodeTextsResponse,
    SourceFrequenciesRequest,
    SourceFrequenciesResponse,
    DemographicComparisonRequest,
    DemographicComparisonResponse,
    SaturationResponse,
    TextColumnInfo,
    IrrResponse,
    ConsensusStatusResponse,
    ReconciliationResponse,
    RecomputeConsensusResponse,
    RevealRequest,
    RevealResponse,
)

router = APIRouter(prefix="/api/projects/{project_id}/code-analysis", tags=["code-analysis"])


@router.get("/demographic-filters", response_model=DemographicFilterOptionsResponse)
async def demographic_filter_options(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get available demographic filter options for qualitative analysis."""
    _get_project_or_404(db, project_id, user.id)
    return get_demographic_filter_options(db, project_id)


@router.get("/coder-coverage", response_model=CoderCoverageResponse)
async def coder_coverage(
    project_id: int,
    conversation_id: int | None = None,
    document_id: int | None = None,
    text_column_ids: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Distinct coders who applied ≥1 non-universal code to a source — or, with no
    source selector, anywhere in the project (Track J · Group A — #1/#3/#13).

    The #444-safe "who coded HERE" surface: derived from codings, NOT the
    instance-global roster. Includes archived coders (flagged ``archived``);
    excludes the consensus/Unattributed system coders and null-applier rows.
    Pass exactly one of ``conversation_id`` / ``document_id`` / ``text_column_ids``
    for per-source coverage; omit all for project-wide coverage.
    """
    _get_project_or_404(db, project_id, user.id)
    col_ids = parse_int_list(text_column_ids)
    if conversation_id is not None or document_id is not None or col_ids:
        coverage = source_coder_coverage(
            db,
            project_id,
            conversation_id=conversation_id,
            document_id=document_id,
            text_column_ids=col_ids,
        )
    else:
        coverage = project_coder_coverage(db, project_id)
    return CoderCoverageResponse(
        coders=[
            CoderCoverageItem(
                user_id=c.user_id,
                username=c.username,
                display_color=c.display_color,
                archived=c.archived,
            )
            for c in coverage
        ],
        count=len(coverage),
    )


@router.get("/frequencies")
async def code_frequencies(
    project_id: int,
    code_ids: str | None = Query(None, description="Comma-separated code IDs"),
    exclude_facilitator: bool = Query(True),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    participant_ids: str | None = Query(None, description="Comma-separated participant IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default — all non-consensus coders, optionally narrowed by coder_ids) or 'consensus' (the derived consensus layer)"),
    source: str = Query("conversations", description="Source: all, conversations, or text (legacy 'comments' is coerced to 'text')"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get code frequency statistics across all conversations, documents, and/or text columns."""
    _get_project_or_404(db, project_id, user.id)

    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    if source not in ("conversations", "text", "all"):
        raise HTTPException(status_code=400, detail="source must be 'conversations', 'text', or 'all'")

    result = get_code_frequencies(
        db,
        project_id,
        code_ids=parse_int_list(code_ids),
        exclude_facilitator=exclude_facilitator,
        conversation_ids=parse_int_list(conversation_ids),
        participant_ids=parse_int_list(participant_ids),
        source=source,
        document_ids=parse_int_list(document_ids),
        coder_ids=parse_int_list(coder_ids),
        layer_scope=layer_scope,
    )
    return result


@router.get("/codes/{code_id}/segments", response_model=CodeSegmentsWithContextResponse)
async def code_segments_with_context(
    project_id: int,
    code_id: int,
    context_size: int = Query(1, ge=0, le=5),
    exclude_facilitator: bool = Query(True),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    participant_ids: str | None = Query(None, description="Comma-separated participant IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default — all non-consensus coders, optionally narrowed by coder_ids) or 'consensus' (the derived consensus layer)"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get segments with a specific code applied, including surrounding context."""
    _get_project_or_404(db, project_id, user.id)

    result = get_segments_with_context(
        db,
        project_id,
        code_id=code_id,
        context_size=context_size,
        exclude_facilitator=exclude_facilitator,
        conversation_ids=parse_int_list(conversation_ids),
        participant_ids=parse_int_list(participant_ids),
        limit=limit,
        offset=offset,
        document_ids=parse_int_list(document_ids),
        coder_ids=parse_int_list(coder_ids),
        layer_scope=layer_scope,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Code not found")

    return result


@router.get("/codes/{code_id}/texts", response_model=CodeTextsResponse)
async def code_comments_with_context(
    project_id: int,
    code_id: int,
    participant_ids: str | None = Query(None, description="Comma-separated participant IDs"),
    text_column_ids: str | None = Query(None, description="Comma-separated text column IDs"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default — all non-consensus coders, optionally narrowed by coder_ids) or 'consensus' (the derived consensus layer)"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get coded comments for a specific code, grouped by dataset."""
    _get_project_or_404(db, project_id, user.id)

    result = get_coded_comments_with_context(
        db,
        project_id,
        code_id=code_id,
        participant_ids=parse_int_list(participant_ids),
        text_column_ids=parse_int_list(text_column_ids),
        limit=limit,
        offset=offset,
        coder_ids=parse_int_list(coder_ids),
        layer_scope=layer_scope,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Code not found")

    return result


@router.get("/cooccurrence")
async def code_cooccurrence(
    project_id: int,
    code_ids: str | None = Query(None, description="Comma-separated code IDs"),
    exclude_facilitator: bool = Query(True),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    participant_ids: str | None = Query(None, description="Comma-separated participant IDs"),
    text_column_ids: str | None = Query(None, description="Comma-separated text column IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default — all non-consensus coders, optionally narrowed by coder_ids) or 'consensus' (the derived consensus layer)"),
    source: str = Query("conversations", description="Source: all, conversations, or text (legacy 'comments' is coerced to 'text')"),
    level: str = Query("segment", description="Level: segment or source"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get code co-occurrence matrix across all conversations, documents, and/or text columns."""
    _get_project_or_404(db, project_id, user.id)

    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    if source not in ("conversations", "text", "all"):
        raise HTTPException(status_code=400, detail="source must be 'conversations', 'text', or 'all'")
    if level not in ("segment", "source"):
        raise HTTPException(status_code=400, detail="level must be 'segment' or 'source'")

    parsed_code_ids = parse_int_list(code_ids)
    parsed_conv_ids = parse_int_list(conversation_ids)
    parsed_part_ids = parse_int_list(participant_ids)
    parsed_col_ids = parse_int_list(text_column_ids)
    parsed_doc_ids = parse_int_list(document_ids)
    parsed_coder_ids = parse_int_list(coder_ids)

    if level == "source":
        cooccur, total_units = get_source_level_cooccurrence(
            db, project_id,
            code_ids=parsed_code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=parsed_conv_ids,
            text_column_ids=parsed_col_ids,
            participant_ids=parsed_part_ids,
            source=source,
            document_ids=parsed_doc_ids,
            coder_ids=parsed_coder_ids,
            layer_scope=layer_scope,
        )
        all_codes = _get_ordered_codes(db, project_id, parsed_code_ids)
        return _build_cooccurrence_response(
            cooccur, all_codes, total_units, 0, source,
        )
    else:
        result = get_code_cooccurrence(
            db, project_id,
            code_ids=parsed_code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=parsed_conv_ids,
            participant_ids=parsed_part_ids,
            source=source,
            document_ids=parsed_doc_ids,
            coder_ids=parsed_coder_ids,
            layer_scope=layer_scope,
        )
        return result


# ── New Endpoints ─────────────────────────────────────────────────────────

@router.post("/source-frequencies", response_model=SourceFrequenciesResponse)
async def source_frequencies(
    project_id: int,
    body: SourceFrequenciesRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get per-source, per-code frequency statistics with word counts."""
    _get_project_or_404(db, project_id, user.id)

    result = get_source_frequencies(
        db, project_id,
        code_ids=body.code_ids,
        conversation_ids=body.conversation_ids,
        text_column_ids=body.text_column_ids,
        exclude_facilitator=body.exclude_facilitator,
        participant_ids=body.participant_ids,
        group_by_subtype=body.group_by_subtype,
        aggregation=body.aggregation,
        document_ids=body.document_ids,
        coder_ids=body.coder_ids,
        layer_scope=body.layer_scope,
    )
    return result


@router.post("/demographic-comparison", response_model=DemographicComparisonResponse)
async def demographic_comparison(
    project_id: int,
    body: DemographicComparisonRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compare code frequencies across demographic groups."""
    _get_project_or_404(db, project_id, user.id)

    result = get_demographic_comparison(
        db, project_id,
        group_by_subtype=body.group_by_subtype,
        code_ids=body.code_ids,
        conversation_ids=body.conversation_ids,
        text_column_ids=body.text_column_ids,
        exclude_facilitator=body.exclude_facilitator,
        participant_ids=body.participant_ids,
        coder_ids=body.coder_ids,
        layer_scope=body.layer_scope,
    )
    return result


@router.get("/saturation", response_model=SaturationResponse)
async def saturation(
    project_id: int,
    exclude_facilitator: bool = Query(True),
    category_level: bool = Query(False),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default — all non-consensus coders, optionally narrowed by coder_ids) or 'consensus' (the derived consensus layer)"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get code saturation curve across conversations and documents."""
    _get_project_or_404(db, project_id, user.id)

    result = get_saturation_data(
        db, project_id,
        exclude_facilitator=exclude_facilitator,
        category_level=category_level,
        conversation_ids=parse_int_list(conversation_ids),
        document_ids=parse_int_list(document_ids),
        coder_ids=parse_int_list(coder_ids),
        layer_scope=layer_scope,
    )
    return result


@router.get("/text-columns", response_model=list[TextColumnInfo])
async def comment_columns(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get open-ended columns that have coded responses."""
    _get_project_or_404(db, project_id, user.id)
    return get_text_columns_with_coding(db, project_id)


@router.get("/irr", response_model=IrrResponse)
async def inter_rater_reliability(
    project_id: int,
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs to compare; omit = all roster coders"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Inter-rater reliability (Track J · J2-4): per-code + overall Cohen's κ
    (2 coders) / Krippendorff's α (n) / percent agreement over the human roster,
    source-level engagement (Option B). `available=False` when <2 coders share a
    source. Universal codes + the consensus layer are excluded by construction."""
    _get_project_or_404(db, project_id, user.id)
    return compute_irr(db, project_id, coder_ids=parse_int_list(coder_ids))


@router.get("/consensus-status", response_model=ConsensusStatusResponse)
async def consensus_status(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Consensus-layer status for the J2-5 layer selector (Track J · M-2). Wires
    the otherwise-unused `consensus_exists_for_project`. `enabled` is the GLOBAL
    roster gate (≥2 selectable coders); `exists` + `stale_count` are project-scoped
    — `exists` drives "offer consensus only when it exists" (DEC-A), `stale_count`
    drives the "consensus may be out of date · recompute" affordance (UX-1)."""
    _get_project_or_404(db, project_id, user.id)
    stale_count = (
        db.query(ConsensusStaleTarget)
        .filter(ConsensusStaleTarget.project_id == project_id)
        .count()
    )
    return ConsensusStatusResponse(
        enabled=consensus_enabled(db),
        exists=consensus_exists_for_project(db, project_id),
        stale_count=stale_count,
    )


@router.get("/reconciliation", response_model=ReconciliationResponse)
async def reconciliation(
    project_id: int,
    source_type: str | None = Query(None, description="Narrow to one source: conversation|document|column"),
    source_id: int | None = Query(None, description="Source id paired with source_type"),
    disagreements_only: bool = Query(False, description="Only units where engaged coders disagree"),
    coder_ids: str | None = Query(None, description="Comma-separated coder IDs; omit = all roster coders"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Reconciliation grid (Track J · J2-5, M-1): per coding unit, what each coder
    applied + the LIVE-derived consensus (TARGET-level — matches the materialized
    layer) + a SOURCE-level disagreement flag (Option B). Read-only: reconcile by
    editing your own layer via the normal apply/remove endpoints; consensus is
    server-derived here, never written from the grid. `available=False` when <2
    roster coders share a source. Disagreements-first + paginated to keep it small."""
    _get_project_or_404(db, project_id, user.id)
    return build_reconciliation(
        db,
        project_id,
        source_type=source_type,
        source_id=source_id,
        disagreements_only=disagreements_only,
        coder_ids=parse_int_list(coder_ids),
        limit=limit,
        offset=offset,
    )


@router.post("/recompute-consensus", response_model=RecomputeConsensusResponse)
@limiter.limit("12/minute")
async def recompute_consensus(
    request: Request,
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Recompute this project's consensus layer on demand (Track J · J2-5, M-3).

    A BOUNDED project sweep of the staleness markers — NOT a full materialize, which
    would race the background `_consensus_sweep_loop` (the deliberate single writer)
    for the SQLite write lock. The loop drains markers every ~30s; this lets the user
    sync the saved consensus layer (read by the other Analysis tabs) immediately
    after a grid edit. Drains in bounded batches until clear; on a lock contention
    with the background sweep it returns what committed (both sweeps are idempotent).
    Note the reconciliation grid's own consensus column is already live-derived —
    this syncs the STORED layer for the other surfaces + clears the stale badge."""
    _get_project_or_404(db, project_id, user.id)
    recomputed = 0
    try:
        for _ in range(20):  # cap iterations (≤10k targets/call) — runaway backstop
            n = sweep_stale_consensus(db, project_id=project_id, limit=500)
            db.commit()
            recomputed += n
            if n < 500:
                break
    except OperationalError:
        # Two-writer lock race with the background sweep — leave the rest pending
        # (it drains on the next tick). Rollback or the session stays in a failed txn.
        db.rollback()
    remaining = (
        db.query(ConsensusStaleTarget)
        .filter(ConsensusStaleTarget.project_id == project_id)
        .count()
    )
    return RecomputeConsensusResponse(recomputed=recomputed, remaining=remaining)


@router.post("/reveal", response_model=RevealResponse)
async def reveal_blind_mode(
    project_id: int,
    body: RevealRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Log that a coder broke blind mode (Track J · J2-5, DEC-G / D4). Blind coding is
    a viewer-side DEFAULT, not a lock — revealing colleagues' work is honest + logged
    (the audit trail competitors lack). Reuses `services/audit.log_action`; the entry
    flows into the Excel audit-trail export for free. Only BREAKING blindness logs;
    re-hiding does not."""
    _get_project_or_404(db, project_id, user.id)
    log_action(
        db,
        action="reveal_codes",
        entity_type="blind_mode",
        entity_id=None,
        user_id=user.id,
        project_id=project_id,
        details={"surface": body.surface} if body.surface else None,
    )
    db.commit()
    return RevealResponse(logged=True)


# ── CSV Exports ───────────────────────────────────────────────────────────

@router.get("/source-frequencies/csv")
async def source_frequencies_csv(
    project_id: int,
    code_ids: str | None = Query(None),
    conversation_ids: str | None = Query(None),
    text_column_ids: str | None = Query(None),
    document_ids: str | None = Query(None),
    exclude_facilitator: bool = Query(True),
    participant_ids: str | None = Query(None),
    group_by_subtype: str | None = Query(None),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default) or 'consensus'"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export source frequencies as CSV."""
    _get_project_or_404(db, project_id, user.id)

    # Forward coder_ids + layer_scope so the export matches the on-screen filter
    # (J2-5 L; also closes a pre-existing J1 coder_ids gap in the CSV path).
    result = get_source_frequencies(
        db, project_id,
        code_ids=parse_int_list(code_ids),
        conversation_ids=parse_int_list(conversation_ids),
        text_column_ids=parse_int_list(text_column_ids),
        exclude_facilitator=exclude_facilitator,
        participant_ids=parse_int_list(participant_ids),
        group_by_subtype=group_by_subtype,
        document_ids=parse_int_list(document_ids),
        coder_ids=parse_int_list(coder_ids),
        layer_scope=layer_scope,
    )

    output = io.StringIO()
    writer = csv.writer(output)

    codes = result["codes"]
    code_names = [c["name"] for c in codes]

    # Header — header cells starting with formula prefixes (e.g. user code
    # name "=evil") would inject when the field STARTS with the user value.
    header = ["Source", "Source Type", "Total Segments", "Total Word Count", "Coded Segments"]
    for name in code_names:
        header.append(csv_safe(f"{name} (Count)"))
        header.append(csv_safe(f"{name} (Word Count)"))
    writer.writerow(header)

    # Data rows
    for src in result["sources"]:
        row = [
            csv_safe(src["source_label"]),
            csv_safe(src["source_type"]),
            src["total_segments"],
            src["total_word_count"],
            src["coded_segments"],
        ]
        cc = src.get("code_counts") or {}
        for c in codes:
            entry = cc.get(str(c["id"]), {})
            row.append(entry.get("count", 0))
            row.append(entry.get("word_count", 0))
        writer.writerow(row)

    # Totals row
    totals = result["totals"]
    total_row = [
        "TOTAL", "", totals["total_segments"], totals["total_word_count"], totals["coded_segments"],
    ]
    # Sum code counts across sources
    for c in codes:
        total_count = 0
        total_wc = 0
        for src in result["sources"]:
            cc = src.get("code_counts") or {}
            entry = cc.get(str(c["id"]), {})
            total_count += entry.get("count", 0)
            total_wc += entry.get("word_count", 0)
        total_row.append(total_count)
        total_row.append(total_wc)
    writer.writerow(total_row)

    output.seek(0)
    filename = "source_frequencies.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/demographic-comparison/csv")
async def demographic_comparison_csv(
    project_id: int,
    group_by_subtype: str = Query(...),
    code_ids: str | None = Query(None),
    conversation_ids: str | None = Query(None),
    text_column_ids: str | None = Query(None),
    exclude_facilitator: bool = Query(True),
    participant_ids: str | None = Query(None),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    layer_scope: str | None = Query(None, pattern="^(human|consensus)$", description="Coder layer (J2 Slab 7): 'human' (default) or 'consensus'"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export demographic comparison as CSV."""
    _get_project_or_404(db, project_id, user.id)

    # Forward coder_ids + layer_scope so the export matches the on-screen filter (J2-5 L).
    result = get_demographic_comparison(
        db, project_id,
        group_by_subtype=group_by_subtype,
        code_ids=parse_int_list(code_ids),
        conversation_ids=parse_int_list(conversation_ids),
        text_column_ids=parse_int_list(text_column_ids),
        exclude_facilitator=exclude_facilitator,
        participant_ids=parse_int_list(participant_ids),
        coder_ids=parse_int_list(coder_ids),
        layer_scope=layer_scope,
    )

    output = io.StringIO()
    writer = csv.writer(output)

    groups = result["groups"]

    # Header
    header = ["Code", "Category"]
    for g in groups:
        header.append(csv_safe(f"{g} (Count)"))
        header.append(csv_safe(f"{g} (Proportion)"))
    if len(groups) == 2:
        header.append("Delta")
    header.extend(["Test Method", "p-value", "Sig"])
    writer.writerow(header)

    # Data rows
    for entry in result["codes"]:
        row = [csv_safe(entry["code_name"]), csv_safe(entry.get("category_name") or "")]
        for g in groups:
            stats = entry["by_group"].get(g, {})
            row.append(stats.get("count", 0))
            row.append(f"{stats.get('proportion', 0):.4f}")
        if len(groups) == 2:
            row.append(f"{entry.get('delta_proportion', 0):.4f}" if entry.get("delta_proportion") is not None else "")
        test = entry.get("test")
        if test:
            row.append(test["method"])
            row.append(f"{test['p_value']:.6f}")
            row.append("*" if test["significant"] else "")
        else:
            row.extend(["", "", ""])
        writer.writerow(row)

    output.seek(0)
    filename = f"demographic_comparison_{sanitize_csv_filename(group_by_subtype)}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
