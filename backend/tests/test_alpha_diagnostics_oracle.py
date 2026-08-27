"""R correctness oracle for Cronbach's alpha item diagnostics (#707a).

`psych::alpha` reports exactly the two diagnostics this adds:

    item.stats$r.drop      corrected item-total correlation
    alpha.drop$raw_alpha   alpha with that item removed

`psych` is already provisioned in both CI workflows (`r_support.REQUIRED_R_PACKAGES`),
so this oracle costs no new dependency.

**Why an oracle rather than hand-anchored numbers.** Both diagnostics have a
plausible wrong implementation that is self-consistent: the UNCORRECTED
item-total correlation (item against a total that includes itself) is inflated by
construction and looks perfectly reasonable in isolation, and alpha-if-deleted
has an off-by-one in the `k` it uses for the reduced scale. Neither is visible
without a second implementation to disagree with, and a fixture anchored to our
own output would freeze either mistake.

⚠️ The fixture is deliberately NOT a well-behaved scale. It contains one item
scored in the opposite direction, because that is the case the diagnostics exist
to reveal — and it is the case where the corrected and uncorrected correlations
differ in SIGN, not merely in magnitude.
"""

import json
import subprocess

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.statistical_test import StatisticalTest
from app.services.statistical_tests import compute_cronbachs_alpha
from tests import r_support

_RSCRIPT = r_support.RSCRIPT
_HAS_PSYCH = r_support.HAS_R and "psych" not in r_support.MISSING_R_PACKAGES

PID = 707

# Three items x 12 records, solved for numerically rather than hand-written.
#
# ⚠️ The FIRST fixture here was a five-item scale with one cleanly reversed item.
# It matched `psych` perfectly and was still a bad fixture: the reversed item
# dominated the total so completely that its corrected and uncorrected
# item-total correlations differed by only 0.016, i.e. an UNCORRECTED
# implementation would have passed the oracle. The
# `test_the_fixture_can_tell_...` guard below caught that and is why it exists.
#
# In this one, item 3 (index 2) has a corrected item-total of about **-0.25** and
# an uncorrected one of about **+0.29** — OPPOSITE SIGNS. So the wrong formula
# does not merely differ by a rounding: it reports the mis-keyed item as
# positively related to the scale and never raises the reverse-coding flag,
# which is the entire finding.
_FORWARD = [
    [1, 2, 3],
    [2, 2, 1],
    [3, 3, 5],
    [4, 4, 2],
    [5, 5, 4],
    [4, 5, 1],
    [3, 3, 3],
    [2, 1, 5],
    [5, 4, 2],
    [1, 1, 4],
    [4, 4, 3],
    [2, 3, 1],
]

#: Index of the mis-keyed item within `_FORWARD`.
REVERSED_IDX = 2


@pytest.fixture
def alpha_project(db_session):
    db_session.add(Project(id=PID, name="P707", user_id=1))
    db_session.add(Dataset(id=PID, project_id=PID, name="Scale"))
    db_session.flush()

    cols = []
    for i in range(len(_FORWARD[0])):
        col = DatasetColumn(
            id=PID * 10 + i, dataset_id=PID, column_code=f"q{i + 1}",
            column_name=f"Item {i + 1}", column_text=f"Question {i + 1}",
            column_type="ordinal", sequence_order=i, display_order=i,
        )
        db_session.add(col)
        cols.append(col)

    db_session.add(AnalysisDomain(id=PID, project_id=PID, name="Scale"))
    for i, col in enumerate(cols):
        db_session.add(AnalysisDomainMember(
            domain_id=PID, member_type="column", member_id=col.id, sequence_order=i,
        ))
    db_session.flush()

    vid = 0
    for r_idx, row in enumerate(_FORWARD):
        dr = DatasetRow(id=PID * 100 + r_idx, dataset_id=PID)
        db_session.add(dr)
        db_session.flush()
        for col, v in zip(cols, row):
            vid += 1
            db_session.add(DatasetValue(
                id=PID * 1000 + vid, row_id=dr.id, column_id=col.id,
                value_text=str(v), value_numeric=float(v),
            ))
    db_session.flush()

    test = StatisticalTest(
        project_id=PID, test_type="cronbachs_alpha",
        target_type="analysis_domain", target_id=PID, config="{}",
    )
    db_session.add(test)
    db_session.flush()
    return test


def _r_alpha_diagnostics():
    rows = ", ".join(
        f"c({', '.join(str(v) for v in row)})" for row in _FORWARD
    )
    expr = f"""
    suppressMessages(library(psych))
    d <- as.data.frame(do.call(rbind, list({rows})))
    a <- suppressWarnings(psych::alpha(d, warnings = FALSE))
    cat(sprintf("%.10f", a$total$raw_alpha), "\\n")
    cat(paste(sprintf("%.10f", a$item.stats$r.drop), collapse = " "), "\\n")
    cat(paste(sprintf("%.10f", a$alpha.drop$raw_alpha), collapse = " "), "\\n")
    """
    out = subprocess.run(
        [_RSCRIPT, "--vanilla", "-e", expr],
        capture_output=True, text=True, timeout=180,
    )
    assert out.returncode == 0, f"Rscript failed: {out.stderr.strip()[:600]}"
    lines = [ln for ln in out.stdout.strip().splitlines() if ln.strip()]
    return (
        float(lines[0]),
        [float(x) for x in lines[1].split()],
        [float(x) for x in lines[2].split()],
    )


@pytest.mark.skipif(not _HAS_PSYCH, reason="Rscript + psych package not available")
def test_item_diagnostics_match_psych_alpha(db_session, alpha_project):
    result = compute_cronbachs_alpha(db_session, alpha_project)
    r_alpha, r_drop, r_alpha_drop = _r_alpha_diagnostics()

    assert result["alpha"] == pytest.approx(r_alpha, abs=1e-4)

    ours_r = [it["item_total_r"] for it in result["items"]]
    ours_a = [it["alpha_if_deleted"] for it in result["items"]]

    for i, (mine, theirs) in enumerate(zip(ours_r, r_drop)):
        assert mine == pytest.approx(theirs, abs=1e-4), (
            f"item {i} corrected item-total: ours {mine}, psych {theirs}"
        )
    for i, (mine, theirs) in enumerate(zip(ours_a, r_alpha_drop)):
        assert mine == pytest.approx(theirs, abs=1e-4), (
            f"item {i} alpha-if-deleted: ours {mine}, psych {theirs}"
        )


@pytest.mark.skipif(not _HAS_PSYCH, reason="Rscript + psych package not available")
def test_the_fixture_can_tell_corrected_from_uncorrected(db_session, alpha_project):
    """Guard the GUARD: an uncorrected item-total would have to fail the test above.

    The corrected and uncorrected forms agree closely on a long, well-behaved
    scale, so a fixture chosen for tidiness would let the wrong implementation
    pass. Here the reversed item's corrected correlation is strongly negative
    while its uncorrected one is pulled toward zero by its own contribution.
    """
    import numpy as np

    data = np.array(_FORWARD, dtype=float)
    totals = data.sum(axis=1)
    result = compute_cronbachs_alpha(db_session, alpha_project)

    item = data[:, REVERSED_IDX]
    corrected = float(np.corrcoef(item, totals - item)[0, 1])
    uncorrected = float(np.corrcoef(item, totals)[0, 1])

    assert result["items"][REVERSED_IDX]["item_total_r"] == pytest.approx(corrected, abs=1e-4)
    assert corrected < 0 < uncorrected, (
        f"this fixture cannot distinguish corrected ({corrected:.4f}) from "
        f"uncorrected ({uncorrected:.4f}) item-total correlations, so the oracle "
        "above would pass on the wrong formula — and the reverse-coding flag, "
        "which keys on the SIGN, would not fire either"
    )


@pytest.mark.skipif(not _HAS_PSYCH, reason="Rscript + psych package not available")
def test_the_reversed_item_is_flagged_and_named(db_session, alpha_project):
    """The diagnostic's whole point: name the item, in the researcher's words.

    `item_variances` has always been a positional list with nothing saying WHICH
    item — which is why nothing ever displayed it.
    """
    result = compute_cronbachs_alpha(db_session, alpha_project)
    flagged = [it for it in result["items"] if it["possible_reverse_coding"]]

    assert len(flagged) == 1
    assert flagged[0]["label"] == f"Item {REVERSED_IDX + 1}"
    assert flagged[0]["item_total_r"] < 0
    assert all(
        it["label"] and not it["label"].startswith("Column ")
        for it in result["items"]
    ), "every item resolved a human label, not the id fallback"


def test_the_payload_json_serialises(db_session, alpha_project):
    """Not R-gated. The saved-test path `json.dumps` this into `result_data`, so
    a numpy scalar or a NaN that reached the payload would corrupt the row for
    every later read (#689's serialisation half)."""
    result = compute_cronbachs_alpha(db_session, alpha_project)
    json.dumps(result, allow_nan=False)
