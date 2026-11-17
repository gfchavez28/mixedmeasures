"""Correlation endpoints for the Relationships & Comparisons tab."""

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..auth import get_current_user
from .helpers import (
    _get_project_or_404, _parse_ids, _fmt_p, coder_scope_filename_suffix, parse_int_list,
    sanitize_content_disposition,
)
from ..services.participant_scores import RATING_COLUMNS_WITHHELD_NOTE
from ..services.rating_withholding import rating_withholding
from .export_helpers import csv_safe
from ..schemas.correlation import (
    CorrelationMatrixRequest,
    CorrelationMatrixResponse,
    ScatterDataRequest,
    ScatterDataResponse,
    ScatterMatrixRequest,
    ScatterMatrixResponse,
)
from ..services.correlations import (
    compute_correlation_matrix,
    compute_scatter_data,
    compute_scatter_matrix,
)

router = APIRouter(tags=["correlations"])


@router.post(
    "/api/projects/{project_id}/metrics/correlation-matrix",
    response_model=CorrelationMatrixResponse,
)
async def correlation_matrix(
    project_id: int,
    body: CorrelationMatrixRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Compute a correlation matrix for selected columns or domains.

    #1615: while blind, a rating score (or a group holding one) is left out of the
    matrix and counted — each pair's r is over people's every-coder scores.
    """
    _get_project_or_404(db, project_id, user.id)

    if not body.column_ids and not body.domain_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids")
    if body.column_ids and body.domain_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids, not both")

    cols, doms, withheld = rating_withholding(
        db, project_id, parse_int_list(coder_ids)).split_sources(db, body.column_ids, body.domain_ids)
    if withheld and not cols and not doms:
        return {"labels": [], "full_labels": [], "matrix": [], "num_comparisons": 0,
                "withheld_rating_variables": withheld}
    result = compute_correlation_matrix(
        db=db,
        project_id=project_id,
        column_ids=cols,
        domain_ids=doms,
        correlation_type=body.correlation_type,
        bonferroni=body.bonferroni,
    )
    return {**result, "withheld_rating_variables": withheld}


@router.post(
    "/api/projects/{project_id}/metrics/scatter-data",
    response_model=ScatterDataResponse,
)
async def scatter_data(
    project_id: int,
    body: ScatterDataRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Compute scatter data for a single pair of variables.

    #1615: every point is one person, so while blind a rating score on either axis
    gives no points (409, with the reason); as the COLOUR it is dropped and counted.
    """
    _get_project_or_404(db, project_id, user.id)
    withholding = rating_withholding(db, project_id, parse_int_list(coder_ids))
    is_withheld = (
        withholding.column if body.id_type == "column" else (lambda i: withholding.domain(db, i))
    )
    if is_withheld(body.x_id) or is_withheld(body.y_id):
        raise HTTPException(status_code=409, detail=RATING_COLUMNS_WITHHELD_NOTE)
    group_withheld = withholding.column(body.group_column_id)

    result = compute_scatter_data(
        db=db,
        project_id=project_id,
        x_id=body.x_id,
        y_id=body.y_id,
        id_type=body.id_type,
        group_column_id=None if group_withheld else body.group_column_id,
    )
    return {**result, "withheld_rating_variables": int(group_withheld)}


@router.post(
    "/api/projects/{project_id}/metrics/scatter-matrix",
    response_model=ScatterMatrixResponse,
)
async def scatter_matrix_endpoint(
    project_id: int,
    body: ScatterMatrixRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Compute scatter data for all lower-triangle pairs of selected variables.

    #1615: while blind, rating scores are left out (and the colour, if it is one)
    and counted; if fewer than two variables remain, 409 with the reason.
    """
    _get_project_or_404(db, project_id, user.id)

    source_ids = body.column_ids if body.id_type == "column" else body.domain_ids
    if len(source_ids) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 variables")

    withholding = rating_withholding(db, project_id, parse_int_list(coder_ids))
    cols, doms, withheld = withholding.split_sources(db, body.column_ids, body.domain_ids)
    if len(cols if body.id_type == "column" else doms) < 2:
        raise HTTPException(status_code=409, detail=RATING_COLUMNS_WITHHELD_NOTE)
    group_withheld = withholding.column(body.group_column_id)

    result = compute_scatter_matrix(
        db=db,
        project_id=project_id,
        column_ids=cols,
        domain_ids=doms,
        id_type=body.id_type,
        group_column_id=None if group_withheld else body.group_column_id,
        max_variables=body.max_variables,
    )
    return {**result, "withheld_rating_variables": withheld + int(group_withheld)}


# ── CSV Exports ──────────────────────────────────────────────────────────────


def _fmt_r(r: float) -> str:
    """Format r value: remove leading zero."""
    if r == 1.0:
        return "1"
    if r == -1.0:
        return "-1"
    s = f"{r:.2f}"
    if s.startswith("0."):
        return s[1:]
    if s.startswith("-0."):
        return "-" + s[2:]
    return s


@router.get("/api/projects/{project_id}/metrics/correlation-matrix/csv")
async def correlation_matrix_csv(
    project_id: int,
    column_ids: Optional[str] = Query(None),
    domain_ids: Optional[str] = Query(None),
    correlation_type: str = Query("pearson"),
    bonferroni: bool = Query(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Export correlation matrix as CSV with three stacked sections."""
    _get_project_or_404(db, project_id, user.id)

    col_ids = _parse_ids(column_ids)
    dom_ids = _parse_ids(domain_ids)
    if not col_ids and not dom_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids")
    # #1615: the screen's own rule — rating scores left out while blind, counted.
    scope = parse_int_list(coder_ids)
    col_ids, dom_ids, withheld = rating_withholding(db, project_id, scope).split_sources(
        db, col_ids, dom_ids)
    if withheld and len(col_ids) + len(dom_ids) < 2:
        raise HTTPException(status_code=409, detail=RATING_COLUMNS_WITHHELD_NOTE)

    result = compute_correlation_matrix(
        db=db, project_id=project_id,
        column_ids=col_ids, domain_ids=dom_ids,
        correlation_type=correlation_type, bonferroni=bonferroni,
    )

    labels = result["labels"]
    matrix = result["matrix"]
    k = len(labels)

    if k < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 variables")

    # Detect varying N
    ns = set()
    for i in range(k):
        for j in range(i + 1, k):
            cell = matrix[i][j]
            if cell:
                ns.add(cell["n"])
    varying_n = len(ns) > 1

    output = io.StringIO()
    writer = csv.writer(output)

    # `labels` originate from user-typed column/domain names; defang once.
    safe_labels = [csv_safe(l) for l in labels]

    # Section 1: Combined r (p)
    writer.writerow([f"Correlation Matrix ({correlation_type.title()})"])
    if withheld:
        writer.writerow([csv_safe(
            f"Scope: {withheld} rating variable(s) left out. {RATING_COLUMNS_WITHHELD_NOTE}")])
    writer.writerow([""] + safe_labels)
    for i in range(k):
        row = [safe_labels[i]]
        for j in range(k):
            if i == j:
                row.append("1")
            elif j < i:
                cell = matrix[i][j]
                if cell:
                    row.append(f"{_fmt_r(cell['r'])} ({_fmt_p(cell['p'])})")
                else:
                    row.append("")
            else:
                row.append("")
        writer.writerow(row)

    writer.writerow([])

    # Section 2: r-only
    writer.writerow(["r values"])
    writer.writerow([""] + safe_labels)
    for i in range(k):
        row = [safe_labels[i]]
        for j in range(k):
            if i == j:
                row.append("1")
            elif j < i:
                cell = matrix[i][j]
                row.append(_fmt_r(cell["r"]) if cell else "")
            else:
                row.append("")
        writer.writerow(row)

    writer.writerow([])

    # Section 3: p-only
    writer.writerow(["p values"])
    writer.writerow([""] + safe_labels)
    for i in range(k):
        row = [safe_labels[i]]
        for j in range(k):
            if i == j:
                row.append("")
            elif j < i:
                cell = matrix[i][j]
                row.append(_fmt_p(cell["p"]) if cell else "")
            else:
                row.append("")
        writer.writerow(row)

    # Section 4: n per pair (only if varying)
    if varying_n:
        writer.writerow([])
        writer.writerow(["n per pair"])
        writer.writerow([""] + safe_labels)
        for i in range(k):
            row = [safe_labels[i]]
            for j in range(k):
                if i == j:
                    cell = matrix[i][j]
                    row.append(str(cell["n"]) if cell else "")
                elif j < i:
                    cell = matrix[i][j]
                    row.append(str(cell["n"]) if cell else "")
                else:
                    row.append("")
            writer.writerow(row)

    output.seek(0)
    # #389: correlation_type is a raw query param (the service only branches on
    # == "spearman", so any string passes through) — sanitize before it lands
    # in the Content-Disposition header.
    filename = (
        f"correlation_matrix_{sanitize_content_disposition(correlation_type)}"
        f"{coder_scope_filename_suffix(db, scope)}.csv"   # #1615, #1530 D97
    )

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/projects/{project_id}/metrics/scatter-data/csv")
async def scatter_data_csv(
    project_id: int,
    column_ids: Optional[str] = Query(None),
    domain_ids: Optional[str] = Query(None),
    id_type: str = Query("column"),
    group_column_id: Optional[int] = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Export scatter data for all pairs as CSV."""
    _get_project_or_404(db, project_id, user.id)

    col_ids = _parse_ids(column_ids)
    dom_ids = _parse_ids(domain_ids)
    source_ids = col_ids if id_type == "column" else dom_ids
    if len(source_ids) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 variables")
    # #1615: each row is a person's values, so a rating score (and a colour that is
    # one) is left out while blind; fewer than two left is a 409 with the reason.
    scope = parse_int_list(coder_ids)
    withholding = rating_withholding(db, project_id, scope)
    col_ids, dom_ids, _withheld = withholding.split_sources(db, col_ids, dom_ids)
    if len(col_ids if id_type == "column" else dom_ids) < 2:
        raise HTTPException(status_code=409, detail=RATING_COLUMNS_WITHHELD_NOTE)
    if withholding.column(group_column_id):
        group_column_id = None

    result = compute_scatter_matrix(
        db=db, project_id=project_id,
        column_ids=col_ids, domain_ids=dom_ids,
        id_type=id_type, group_column_id=group_column_id,
        max_variables=20,
    )

    output = io.StringIO()
    writer = csv.writer(output)
    has_groups = any(p.get("groups") for p in result["pairs"])

    header = ["record_id", "x_variable", "x_value", "y_variable", "y_value"]
    if has_groups:
        header.append("group")
    writer.writerow(header)

    for pair in result["pairs"]:
        groups = pair.get("groups") or []
        x_label = csv_safe(pair["x_label"])
        y_label = csv_safe(pair["y_label"])
        for idx in range(len(pair["x"])):
            row = [
                csv_safe(pair["record_ids"][idx]),
                x_label,
                pair["x"][idx],
                y_label,
                pair["y"][idx],
            ]
            if has_groups:
                row.append(csv_safe(groups[idx]) if idx < len(groups) else "")
            writer.writerow(row)

    output.seek(0)
    filename = f"scatter_data{coder_scope_filename_suffix(db, scope)}.csv"   # #1615

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
