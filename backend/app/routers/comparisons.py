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
from .helpers import (
    _get_project_or_404,
    _parse_ids,
    _fmt_p,
    _fmt_stat,
    coder_scope_filename_suffix,
    parse_int_list,
    sanitize_content_disposition,
)
from ..services.participant_scores import RATING_COLUMNS_WITHHELD_NOTE
from ..services.rating_withholding import RatingWithholding, rating_withholding
from ..services.undefined_stats import RATING_WITHHELD_BLIND
from .export_helpers import csv_safe
from ..schemas.comparison import GroupComparisonRequest, GroupComparisonResponse
# `_resolve_test_type` is imported rather than mirrored ON PURPOSE: the CSV has
# to label its columns for the same test the service actually ran, and a second
# copy of "which test does this group count get?" is the shape of defect this
# module is being fixed for.
from ..services.comparisons import (
    P_METHOD_CSV_LABEL,
    TEST_OMITTED_CSV_TEXT,
    _no_comparison,
    _resolve_test_type,
    compute_group_comparison,
    untested_groups_note,
)

router = APIRouter(tags=["comparisons"])


def _comparison_without_ratings(
    db: Session, project_id: int, withholding: RatingWithholding, *,
    column_ids: list[int], domain_ids: list[int],
    grouping_column_id: int, grouping_column_id_2: int | None, **kwargs,
) -> dict:
    """#1615 — the comparison a blind viewer may see: every variable that is a
    participant rating score (or a variable group holding one) left out and
    counted. A rating score as the GROUPING variable sorts people by their
    every-coder score, so nothing is computed — `RATING_WITHHELD_BLIND` says why,
    as it does when every variable asked for was left out."""
    cols, n_cols = withholding.split_columns(column_ids)
    doms, n_doms = withholding.split_domains(db, domain_ids)
    n_grouping = withholding.column(grouping_column_id) + withholding.column(grouping_column_id_2)
    withheld = n_cols + n_doms + n_grouping
    if n_grouping or (withheld and not cols and not doms):
        return {**_no_comparison(RATING_WITHHELD_BLIND), "withheld_rating_variables": withheld}
    result = compute_group_comparison(
        db=db, project_id=project_id, column_ids=cols, domain_ids=doms,
        grouping_column_id=grouping_column_id, grouping_column_id_2=grouping_column_id_2,
        **kwargs,
    )
    return {**result, "withheld_rating_variables": withheld}


@router.post(
    "/api/projects/{project_id}/metrics/group-comparison",
    response_model=GroupComparisonResponse,
)
async def group_comparison(
    project_id: int,
    body: GroupComparisonRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Compute group comparisons for selected variables against a demographic grouping."""
    _get_project_or_404(db, project_id, user.id)
    withholding = rating_withholding(db, project_id, parse_int_list(coder_ids))

    if not body.column_ids and not body.domain_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids")
    if body.column_ids and body.domain_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids, not both")

    try:
        result = _comparison_without_ratings(
            db,
            project_id,
            withholding,
            column_ids=body.column_ids,
            domain_ids=body.domain_ids,
            grouping_column_id=body.grouping_column_id,
            grouping_column_id_2=body.grouping_column_id_2,
            test_type=body.test_type,
            include_effect_size_ci=body.include_effect_size_ci,
            exclude_groups=body.exclude_groups,
            nonparametric=body.nonparametric,
            include_qq=body.include_qq,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return result


# ── CSV Export ───────────────────────────────────────────────────────────────


def _significance_stars(p: float | None) -> str:
    """Star ladder for the `Sig` column.

    ⚠️ Unconditional, unlike the screen — `chart-data.ts::getSignificanceStars`
    gates each rung on the researcher's show_05 / show_01 / show_001 toggles, so
    a level switched off shows no star there and still stars here. That is #744,
    left open deliberately: the endpoint receives no `sigLevels`, and whether an
    export honours a display filter is a decision for the whole export layer.
    """
    if p is None:
        return ""
    if p < 0.001:
        return "***"
    if p < 0.01:
        return "**"
    if p < 0.05:
        return "*"
    return ""


def _fmt_df(value: float | None) -> str:
    """A whole df prints as an integer; Welch's fractional df keeps two decimals."""
    if value is None:
        return ""
    return str(int(value)) if float(value).is_integer() else _fmt_stat(value)


def _row_note(row) -> str:
    """#1543: why a row's test left a group out, or was not run — the screen's own
    sentences (`untested-groups.ts`, `stat-format.ts`), so the file and the table
    beside it say the same thing. Blank when there is nothing to say."""
    parts = []
    if not row.get("test"):
        reason = TEST_OMITTED_CSV_TEXT.get(row.get("test_omitted_reason") or "")
        parts.append(reason or ("Not computed." if row.get("test_omitted_reason") else ""))
    parts.append(untested_groups_note(row.get("untested_groups")) or "")
    return " ".join(p for p in parts if p)


def _test_columns(effective_test: str, is_two_group: bool, groups: list[str]):
    """The test-result columns: header label and cell value defined TOGETHER.

    These used to live thirty lines apart — a header branch that named the
    statistic, and a value line that wrote `test['effect_size']`. That gap is
    exactly how the CSV came to publish **eta-squared** under a screen that
    displays **omega-squared** (#732): ANOVA gained the less-biased statistic,
    the two screens were updated to show it, and the export's value line was
    never touched because nothing put the two decisions in the same place.

    Returns `[(header_label, cell_fn)]`; `cell_fn(row, test) -> str`. Adding a
    statistic means adding ONE entry, so the label and the number cannot
    disagree again. The blank-row width derives from `len()` of this list too,
    so that cannot drift either.
    """
    def _delta(row, test) -> str:
        # Two-group parametric reports the mean difference in the statistic
        # slot (the screen shows `t` there — that divergence is filed ⚪ and is
        # deliberately NOT changed here).
        g1 = next((s for s in row["group_stats"] if s["group"] == groups[0]), None)
        g2 = next((s for s in row["group_stats"] if s["group"] == groups[1]), None)
        if not g1 or not g2 or g1["mean"] is None or g2["mean"] is None:
            return ""
        return _fmt_stat(g1["mean"] - g2["mean"])

    if effective_test == "independent_t_test" and is_two_group:
        cols = [("Delta", _delta)]
    else:
        label = {
            "one_way_anova": "F",
            "kruskal_wallis": "H",
            "mann_whitney_u": "U",
        }.get(effective_test, "t")
        cols = [(label, lambda row, test: _fmt_stat(test["statistic"]))]

    # #1543 (1.6.0): the degrees of freedom, so a reader can see which groups a test
    # was over — an F on df 1 is two groups, whatever the header lists — and report
    # it. Mann–Whitney's U has none.
    if effective_test == "one_way_anova":
        cols.append(("df1", lambda row, test: _fmt_df(test.get("df"))))
        cols.append(("df2", lambda row, test: _fmt_df(test.get("df2"))))
    elif effective_test in ("independent_t_test", "kruskal_wallis"):
        cols.append(("df", lambda row, test: _fmt_df(test.get("df"))))

    cols.append(("p", lambda row, test: _fmt_p(test["p"])))
    if effective_test == "mann_whitney_u":
        # #1326 STAT-12 (D58): the data chooses this p's method, per row, so the
        # file says which — in words (`P_METHOD_CSV_LABEL`), never the wire key.
        cols.append((
            "p method",
            lambda row, test: P_METHOD_CSV_LABEL.get(test.get("p_method") or "", ""),
        ))

    if effective_test == "one_way_anova":
        # #732: BOTH, not either. The strip and the comparison table display
        # omega-squared; `effect_size` (the primary field) is eta-squared; and
        # the saved-test APA string has always reported the pair. Emitting both
        # is the only option that carries the displayed field without dropping
        # the one the rest of the app and the wider literature use.
        # NOTE: no effect-size LABEL column — `effect_size_label` is classified
        # from eta-squared (#742), so shipping it beside omega-squared would put
        # a known mislabel into a file researchers cite.
        cols.append(("eta_sq", lambda row, test: _fmt_stat(test["effect_size"])))
        cols.append(("omega_sq", lambda row, test: _fmt_stat(test.get("omega_squared"))))
    elif effective_test == "kruskal_wallis":
        cols.append(("epsilon_sq", lambda row, test: _fmt_stat(test["effect_size"])))
    elif effective_test == "mann_whitney_u":
        cols.append(("r", lambda row, test: _fmt_stat(test["effect_size"])))
    else:
        # Cohen's d is the one effect size that carries a CI, and the endpoint
        # already pays to compute it (`include_effect_size_ci=True`) — it was
        # then discarded, while the screen showed it.
        cols.append(("d", lambda row, test: _fmt_stat(test["effect_size"])))
        cols.append(("d_CI_lower", lambda row, test: _fmt_stat(test.get("effect_size_ci_lower"))))
        cols.append(("d_CI_upper", lambda row, test: _fmt_stat(test.get("effect_size_ci_upper"))))

    cols.append(("Sig", lambda row, test: _significance_stars(test["p"])))
    return cols


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
    # #1615 — bare default, LAST (direct-call tests); the client sends it while blind.
    coder_ids: str | None = None,
):
    """Export group comparison as CSV."""
    _get_project_or_404(db, project_id, user.id)
    scope = parse_int_list(coder_ids)
    withholding = rating_withholding(db, project_id, scope)

    col_ids = _parse_ids(column_ids)
    dom_ids = _parse_ids(domain_ids)
    if not col_ids and not dom_ids:
        raise HTTPException(status_code=400, detail="Provide column_ids or domain_ids")

    excl = [g.strip() for g in exclude_groups.split(',') if g.strip()] if exclude_groups else []

    try:
        result = _comparison_without_ratings(
            db, project_id, withholding,
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
    # Resolved the same way the service did, from the same inputs — NOT sniffed
    # from the first row that happens to carry a test. An export whose every row
    # failed to compute still has to label its columns correctly.
    effective_test = _resolve_test_type(test_type, len(groups), nonparametric=nonparametric)
    test_cols = _test_columns(effective_test, is_two_group, groups)

    output = io.StringIO()
    writer = csv.writer(output)

    # #744 — the export layer's rule, stated in the file that follows it: an
    # export HONOURS a filter that changes which data is in the file (coder
    # scope, excluded groups — disclosed in a `Scope:` line, the #499/#512
    # convention) and does NOT apply one that only changes how present data is
    # ANNOTATED. The screen's significance toggles are the second kind: the
    # p-value is in the file either way, so the full ladder is written and the
    # file says so rather than silently differing from the screen beside it.
    # #1543: the excluded groups — the comment above said they were disclosed in a
    # `Scope:` line, and none was written, so a group left out by choice vanished from
    # the file without a word.
    if excl:
        writer.writerow([csv_safe(f"Scope: groups excluded: {', '.join(excl)}")])
    if result.get("withheld_rating_variables"):
        # #1615: the variables left out while blind, in the file's own Scope line.
        writer.writerow([csv_safe(
            f"Scope: {result['withheld_rating_variables']} rating variable(s) left out. "
            f"{RATING_COLUMNS_WITHHELD_NOTE}"
        )])
    writer.writerow([csv_safe(
        "Significance: * p < .05, ** p < .01, *** p < .001 "
        "(full ladder; the screen's display settings are not applied)"
    )])

    # Build header — adapt for non-parametric. Group names come from user-typed
    # column values; defang the header cells that lead with them.
    header = ["Variable"]
    if nonparametric:
        for g in groups:
            header.extend([csv_safe(f"{g}_n"), csv_safe(f"{g}_Mdn")])
    else:
        for g in groups:
            header.extend([csv_safe(f"{g}_n"), csv_safe(f"{g}_M"), csv_safe(f"{g}_SD")])

    header.extend(label for label, _ in test_cols)
    header.append("Note")          # #1543: who a test left out, or why it did not run

    writer.writerow(header)

    # Data rows
    for row in rows:
        csv_row = [csv_safe(row["label"])]

        # Group stats
        for g in groups:
            stat = next((s for s in row["group_stats"] if s["group"] == g), None)
            if stat and stat["n"] > 0:
                if nonparametric:
                    csv_row.extend([stat["n"], _fmt_stat(stat.get("median"))])
                else:
                    csv_row.extend([stat["n"], _fmt_stat(stat["mean"]), _fmt_stat(stat["sd"])])
            else:
                csv_row.extend(["", ""] if nonparametric else ["", "", ""])

        # Test results — one entry per declared column, so the row can never be
        # a different width or a different statistic than the header promised.
        test = row.get("test")
        if test:
            csv_row.extend(cell(row, test) for _, cell in test_cols)
        else:
            csv_row.extend([""] * len(test_cols))
        csv_row.append(csv_safe(_row_note(row)))

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
                ph_row = [
                    csv_safe(f"{comp['group_a']} vs {comp['group_b']}"),
                    _fmt_stat(comp["mean_diff"]),
                    _fmt_p(comp["p"]),
                    _fmt_stat(comp["ci_lower"]),
                    _fmt_stat(comp["ci_upper"]),
                    _significance_stars(comp["p"]),
                ]
                writer.writerow(ph_row + [""] * max(0, n_cols - len(ph_row)))

    output.seek(0)
    group_label = result.get("group_column_label", "comparison")
    # #389: sanitize the user-controlled group label (strips control chars /
    # quotes / anything outside \w-. ) before it lands in the header.
    filename = (
        f"group_comparison_{sanitize_content_disposition(group_label)}"
        f"{coder_scope_filename_suffix(db, scope)}.csv"   # #1615, #1530 D97
    )

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
