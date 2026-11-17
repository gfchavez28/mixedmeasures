"""Data quality / missing data diagnostics endpoints."""

import csv
import io
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..auth import get_current_user
from .helpers import _get_project_or_404, _parse_ids, parse_int_list, sanitize_csv_filename
from ..services.participant_scores import RATING_COLUMNS_WITHHELD_NOTE
from ..services.rating_withholding import rating_withholding
from .export_helpers import csv_safe
from ..schemas.data_quality import (
    DataQualityRequest,
    MissingSummaryResponse,
    MissingPatternsRequest,
    MissingPatternsResponse,
    McarTestResponse,
)
from ..services.data_quality import (
    compute_missing_summary,
    compute_missing_patterns,
    compute_littles_mcar,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["data-quality"])


def _columns_without_ratings(db, project_id: int, column_ids, coder_ids) -> tuple[list[int], int]:
    """#1615 — the columns a blind viewer's diagnostics may read: a participant
    rating score (or a column computed from one) is left out and counted. How many
    people have a score is how many colleagues rated (D198's rated-passage count);
    with every requested column left out, 409 with the reason."""
    kept, withheld = rating_withholding(
        db, project_id, parse_int_list(coder_ids)).split_columns(column_ids)
    if withheld and not kept:
        raise HTTPException(status_code=409, detail=RATING_COLUMNS_WITHHELD_NOTE)
    return kept, withheld


@router.post(
    "/api/projects/{project_id}/data-quality/summary",
    response_model=MissingSummaryResponse,
)
async def missing_summary(
    project_id: int,
    body: DataQualityRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Compute per-variable missing data summary."""
    _get_project_or_404(db, project_id, user.id)

    if not body.column_ids:
        raise HTTPException(status_code=400, detail="Provide at least one column_id.")
    column_ids, withheld = _columns_without_ratings(db, project_id, body.column_ids, coder_ids)

    try:
        return {**compute_missing_summary(
            db=db,
            project_id=project_id,
            column_ids=column_ids,
            include_na=body.include_na_as_missing,
            include_empty=body.include_empty_as_missing,
        ), "withheld_rating_variables": withheld}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post(
    "/api/projects/{project_id}/data-quality/patterns",
    response_model=MissingPatternsResponse,
)
async def missing_patterns(
    project_id: int,
    body: MissingPatternsRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Compute missing data patterns (single dataset only)."""
    _get_project_or_404(db, project_id, user.id)

    if not body.column_ids:
        raise HTTPException(status_code=400, detail="Provide at least one column_id.")
    column_ids, withheld = _columns_without_ratings(db, project_id, body.column_ids, coder_ids)

    try:
        return {**compute_missing_patterns(
            db=db,
            project_id=project_id,
            column_ids=column_ids,
            include_na=body.include_na_as_missing,
            include_empty=body.include_empty_as_missing,
            max_patterns=body.max_patterns,
        ), "withheld_rating_variables": withheld}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post(
    "/api/projects/{project_id}/data-quality/mcar-test",
    response_model=McarTestResponse,
)
async def mcar_test(
    project_id: int,
    body: DataQualityRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Run Little's MCAR test on selected variables."""
    _get_project_or_404(db, project_id, user.id)

    if not body.column_ids:
        raise HTTPException(status_code=400, detail="Provide at least one column_id.")
    column_ids, withheld = _columns_without_ratings(db, project_id, body.column_ids, coder_ids)

    try:
        return {**compute_littles_mcar(
            db=db,
            project_id=project_id,
            column_ids=column_ids,
            include_na=body.include_na_as_missing,
            include_empty=body.include_empty_as_missing,
        ), "withheld_rating_variables": withheld}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("MCAR test failed unexpectedly")
        raise HTTPException(
            status_code=500,
            detail="MCAR test computation failed unexpectedly.",
        )


# ── CSV Export ───────────────────────────────────────────────────────────────


@router.get("/api/projects/{project_id}/data-quality/summary/csv")
async def missing_summary_csv(
    project_id: int,
    column_ids: Optional[str] = Query(None),
    include_na_as_missing: bool = Query(True),
    include_empty_as_missing: bool = Query(True),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Export missing data summary as CSV."""
    _get_project_or_404(db, project_id, user.id)

    col_ids = _parse_ids(column_ids)
    if not col_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids.")
    col_ids, withheld = _columns_without_ratings(db, project_id, col_ids, coder_ids)

    result = compute_missing_summary(
        db=db,
        project_id=project_id,
        column_ids=col_ids,
        include_na=include_na_as_missing,
        include_empty=include_empty_as_missing,
    )

    output = io.StringIO()
    writer = csv.writer(output)
    if withheld:
        # #1615: the comparison CSV's Scope-line convention (#499/#512).
        writer.writerow([csv_safe(
            f"Scope: {withheld} rating variable(s) left out. {RATING_COLUMNS_WITHHELD_NOTE}")])

    header = [
        "Variable", "Dataset", "Type", "N Total", "N Valid",
        "N Missing", "% Missing", "N Empty", "N NA",
    ]
    writer.writerow(header)

    for var in result["variables"]:
        writer.writerow([
            csv_safe(var["variable_name"]),
            csv_safe(var["dataset_name"]),
            csv_safe(var["column_type"]),
            var["n_total"],
            var["n_valid"],
            var["n_missing"],
            f"{var['pct_missing']:.1f}",
            var["n_empty"],
            var["n_na"],
        ])

    # Summary row
    writer.writerow([
        "TOTAL", "", "",
        result["total_cells"], "",
        result["total_missing"],
        f"{result['overall_pct_missing']:.1f}",
        "", "",
    ])

    output.seek(0)
    filename = sanitize_csv_filename("missing_data_summary") + ".csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
