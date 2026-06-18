"""Group comparison endpoints for the Relationships & Comparisons tab."""

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..auth import get_current_user
from .helpers import _get_project_or_404, _parse_ids, _fmt_p, sanitize_content_disposition
from .export_helpers import csv_safe
from ..schemas.comparison import GroupComparisonRequest, GroupComparisonResponse
from ..services.comparisons import compute_group_comparison

router = APIRouter(tags=["comparisons"])


@router.post(
    "/api/projects/{project_id}/metrics/group-comparison",
    response_model=GroupComparisonResponse,
)
async def group_comparison(
    project_id: int,
    body: GroupComparisonRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compute group comparisons for selected variables against a demographic grouping."""
    _get_project_or_404(db, project_id, user.id)

    if not body.column_ids and not body.domain_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids")
    if body.column_ids and body.domain_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids, not both")

    try:
        result = compute_group_comparison(
            db=db,
            project_id=project_id,
            column_ids=body.column_ids,
            domain_ids=body.domain_ids,
            grouping_column_id=body.grouping_column_id,
            grouping_column_id_2=body.grouping_column_id_2,
            test_type=body.test_type,
            include_effect_size_ci=body.include_effect_size_ci,
            exclude_groups=body.exclude_groups,
            nonparametric=body.nonparametric,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return result


# ── CSV Export ───────────────────────────────────────────────────────────────


@router.get("/api/projects/{project_id}/metrics/group-comparison/csv")
async def group_comparison_csv(
    project_id: int,
    column_ids: Optional[str] = Query(None),
    domain_ids: Optional[str] = Query(None),
    grouping_column_id: int = Query(...),
    grouping_column_id_2: Optional[int] = Query(None),
    test_type: str = Query("auto"),
    exclude_groups: Optional[str] = Query(None),
    nonparametric: bool = Query(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export group comparison as CSV."""
    _get_project_or_404(db, project_id, user.id)

    col_ids = _parse_ids(column_ids)
    dom_ids = _parse_ids(domain_ids)
    if not col_ids and not dom_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids")

    excl = [g.strip() for g in exclude_groups.split(',') if g.strip()] if exclude_groups else []

    try:
        result = compute_group_comparison(
            db=db, project_id=project_id,
            column_ids=col_ids, domain_ids=dom_ids,
            grouping_column_id=grouping_column_id,
            grouping_column_id_2=grouping_column_id_2,
            test_type=test_type,
            include_effect_size_ci=True,
            exclude_groups=excl,
            nonparametric=nonparametric,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    groups = result["groups"]
    rows = result["rows"]
    is_two_group = len(groups) == 2
    first_test = next((r["test"] for r in rows if r.get("test")), None)

    output = io.StringIO()
    writer = csv.writer(output)

    # Build header — adapt for non-parametric. Group names come from user-typed
    # column values; defang the header cells that lead with them.
    header = ["Variable"]
    if nonparametric:
        for g in groups:
            header.extend([csv_safe(f"{g}_n"), csv_safe(f"{g}_Mdn")])
    else:
        for g in groups:
            header.extend([csv_safe(f"{g}_n"), csv_safe(f"{g}_M"), csv_safe(f"{g}_SD")])

    if nonparametric:
        stat_label = "U" if is_two_group else "H"
        es_label = "r" if is_two_group else "epsilon_sq"
        header.extend([stat_label, "p", es_label, "Sig"])
    elif is_two_group:
        header.extend(["Delta", "p", "d", "Sig"])
    else:
        stat_label = "F" if first_test and first_test.get("test_type") == "one_way_anova" else "t"
        es_label = "eta_sq" if first_test and first_test.get("effect_size_type") == "eta_squared" else "d"
        header.extend([stat_label, "p", es_label, "Sig"])

    writer.writerow(header)

    # Data rows
    for row in rows:
        csv_row = [csv_safe(row["label"])]

        # Group stats
        for g in groups:
            stat = next((s for s in row["group_stats"] if s["group"] == g), None)
            if stat and stat["n"] > 0:
                if nonparametric:
                    mdn = stat.get("median")
                    csv_row.extend([stat["n"], f"{mdn:.2f}" if mdn is not None else ""])
                else:
                    csv_row.extend([stat["n"], f"{stat['mean']:.2f}", f"{stat['sd']:.2f}"])
            else:
                csv_row.extend(["", ""] if nonparametric else ["", "", ""])

        # Test results
        test = row.get("test")
        if test:
            if not nonparametric and is_two_group:
                g1 = next((s for s in row["group_stats"] if s["group"] == groups[0]), None)
                g2 = next((s for s in row["group_stats"] if s["group"] == groups[1]), None)
                delta = (g1["mean"] - g2["mean"]) if g1 and g2 else 0
                csv_row.append(f"{delta:.2f}")
            else:
                csv_row.append(f"{test['statistic']:.2f}")

            csv_row.append(_fmt_p(test["p"]))
            csv_row.append(f"{test['effect_size']:.2f}")

            if test["p"] < 0.001:
                csv_row.append("***")
            elif test["p"] < 0.01:
                csv_row.append("**")
            elif test["p"] < 0.05:
                csv_row.append("*")
            else:
                csv_row.append("")
        else:
            csv_row.extend(["", "", "", ""])

        writer.writerow(csv_row)

        # Post-hoc rows (for ANOVA)
        if test and test.get("post_hoc") and test["post_hoc"].get("comparisons"):
            ph = test["post_hoc"]
            method = ph.get("post_hoc_method", "tukey_hsd")
            n_cols = len(header)
            writer.writerow([f"Post-hoc ({method})"] + [""] * (n_cols - 1))
            ph_header = ["Pair", "Mean Diff", "p", "CI Lower", "CI Upper", "Sig"]
            writer.writerow(ph_header + [""] * max(0, n_cols - len(ph_header)))
            for comp in ph["comparisons"]:
                sig = "***" if comp["p"] < 0.001 else "**" if comp["p"] < 0.01 else "*" if comp["p"] < 0.05 else ""
                ph_row = [
                    csv_safe(f"{comp['group_a']} vs {comp['group_b']}"),
                    f"{comp['mean_diff']:.2f}",
                    _fmt_p(comp["p"]),
                    f"{comp['ci_lower']:.2f}",
                    f"{comp['ci_upper']:.2f}",
                    sig,
                ]
                writer.writerow(ph_row + [""] * max(0, n_cols - len(ph_row)))

    output.seek(0)
    group_label = result.get("group_column_label", "comparison")
    # #389: sanitize the user-controlled group label (strips control chars /
    # quotes / anything outside \w-. ) before it lands in the header.
    filename = f"group_comparison_{sanitize_content_disposition(group_label)}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
