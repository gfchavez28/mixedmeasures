"""Router for cross-conversation qualitative code analysis."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import io
import csv

from ..database import get_db
from ..models.user import User
from ..auth import get_current_user
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
from ..schemas.code_analysis import (
    CodeSegmentsWithContextResponse,
    DemographicFilterOptionsResponse,
    CodeTextsResponse,
    SourceFrequenciesRequest,
    SourceFrequenciesResponse,
    DemographicComparisonRequest,
    DemographicComparisonResponse,
    SaturationResponse,
    TextColumnInfo,
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


@router.get("/frequencies")
async def code_frequencies(
    project_id: int,
    code_ids: str | None = Query(None, description="Comma-separated code IDs"),
    exclude_facilitator: bool = Query(True),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    participant_ids: str | None = Query(None, description="Comma-separated participant IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
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
    )
    return result


@router.get("/saturation", response_model=SaturationResponse)
async def saturation(
    project_id: int,
    exclude_facilitator: bool = Query(True),
    category_level: bool = Query(False),
    conversation_ids: str | None = Query(None, description="Comma-separated conversation IDs"),
    document_ids: str | None = Query(None, description="Comma-separated document IDs"),
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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export source frequencies as CSV."""
    _get_project_or_404(db, project_id, user.id)

    result = get_source_frequencies(
        db, project_id,
        code_ids=parse_int_list(code_ids),
        conversation_ids=parse_int_list(conversation_ids),
        text_column_ids=parse_int_list(text_column_ids),
        exclude_facilitator=exclude_facilitator,
        participant_ids=parse_int_list(participant_ids),
        group_by_subtype=group_by_subtype,
        document_ids=parse_int_list(document_ids),
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
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export demographic comparison as CSV."""
    _get_project_or_404(db, project_id, user.id)

    result = get_demographic_comparison(
        db, project_id,
        group_by_subtype=group_by_subtype,
        code_ids=parse_int_list(code_ids),
        conversation_ids=parse_int_list(conversation_ids),
        text_column_ids=parse_int_list(text_column_ids),
        exclude_facilitator=exclude_facilitator,
        participant_ids=parse_int_list(participant_ids),
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
