"""#490 / #493 regression guards — export layer correctness and artifact parity.

#490: the coded-segments CSV exported the raw `CodeApplication` table without
`non_consensus_filter()` and without saying WHOSE application each row was — on
a consensus-materialized project the derived consensus rows appeared as
indistinguishable duplicate rows (3 of 17 on the audit corpus). The "Other
Codes" column repeated a code name once per coder. Fixed: human layer only,
a "Coder" column, distinct other-code names.

#493: the Excel Co-occurrence sheet hard-coded ``exclude_facilitator=False``
while the co-occurrence CSV endpoint defaults True — same matrix, two numbers
(diagonal 5 vs 4 on the audit corpus). Fixed: the Excel builder excludes
facilitator segments like every sibling surface, and the sheet's corner cell
carries the scope label.
"""
import asyncio
import csv as csv_module
import io

import pytest

from app.auth import get_or_create_consensus_user
from app.models.user import User
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.speaker import Speaker
from app.models.segment import Segment
from app.models.code import Code
from app.models.code_application import CodeApplication


def _run(coro):
    return asyncio.run(coro)


def _stream_to_text(response):
    chunks = []
    body = response.body_iterator
    try:
        for ch in body:
            chunks.append(ch.decode("utf-8") if isinstance(ch, bytes) else ch)
    except TypeError:
        async def _drain():
            async for ch in body:
                chunks.append(ch.decode("utf-8") if isinstance(ch, bytes) else ch)
        asyncio.run(_drain())
    return "".join(chunks)


@pytest.fixture
def multicoder_project(db_session):
    """Two human coders + a materialized-consensus row + a facilitator segment.

    - seg 7300 (participant): code A by Ada(1) AND Ben(2) + a CONSENSUS row
      → CSV must show exactly two rows (one per human), never the consensus row.
    - seg 7301 (participant): code A by Ada, code B by Ada AND Ben
      → the code-A row's "Other Codes" must name "theme B" ONCE.
    - seg 7302 (facilitator): code A by Ada
      → excluded by the CSV default and by the Excel co-occurrence builder.
    """
    db = db_session
    db.add(User(id=2, username="Ben", coder_type="human"))
    db.add(Project(id=730, name="Layer Parity", user_id=1))
    db.flush()
    consensus = get_or_create_consensus_user(db)

    conv = Conversation(id=730, project_id=730, name="Focus Group")
    db.add(conv)
    db.flush()
    db.add_all([
        Speaker(id=7300, project_id=730, name="Facilitator", is_facilitator=1, color_index=0),
        Speaker(id=7301, project_id=730, name="Mara", is_facilitator=0, color_index=1),
    ])
    db.flush()
    db.add_all([
        Segment(id=7300, conversation_id=730, sequence_order=0,
                text="Participant one.", speaker_id=7301),
        Segment(id=7301, conversation_id=730, sequence_order=1,
                text="Participant two.", speaker_id=7301),
        Segment(id=7302, conversation_id=730, sequence_order=2,
                text="Facilitator prompt.", speaker_id=7300),
    ])
    db.add_all([
        Code(id=7300, project_id=730, numeric_id=2, name="theme A",
             is_universal=False, is_active=True),
        Code(id=7301, project_id=730, numeric_id=3, name="theme B",
             is_universal=False, is_active=True),
    ])
    db.flush()
    db.add_all([
        # seg 7300: unanimous code A + the derived consensus row
        CodeApplication(segment_id=7300, code_id=7300, user_id=1, origin="human"),
        CodeApplication(segment_id=7300, code_id=7300, user_id=2, origin="human"),
        CodeApplication(segment_id=7300, code_id=7300, user_id=consensus.id,
                        origin="consensus"),
        # seg 7301: code A (Ada) + code B by both coders
        CodeApplication(segment_id=7301, code_id=7300, user_id=1, origin="human"),
        CodeApplication(segment_id=7301, code_id=7301, user_id=1, origin="human"),
        CodeApplication(segment_id=7301, code_id=7301, user_id=2, origin="human"),
        # seg 7302: facilitator-coded
        CodeApplication(segment_id=7302, code_id=7300, user_id=1, origin="human"),
    ])
    db.flush()
    return db.get(User, 1)


def _rows(db, user, **overrides):
    from app.routers.export import export_coded_segments_csv
    kwargs = dict(project_id=730, code_ids=None, exclude_facilitator=True,
                  conversation_ids=None, participant_ids=None,
                  user=user, db=db)
    kwargs.update(overrides)
    text = _stream_to_text(_run(export_coded_segments_csv(**kwargs)))
    return list(csv_module.reader(io.StringIO(text)))


def test_coded_segments_csv_excludes_consensus_and_names_coders(
    multicoder_project, db_session,
):
    rows = _rows(db_session, multicoder_project)
    header, data = rows[0], rows[1:]

    assert "Coder" in header, "the per-application grain needs a Coder column"
    coder_col = header.index("Coder")
    code_col = header.index("Code")
    other_col = header.index("Other Codes")

    # 5 human applications on participant segments; the consensus row must not
    # appear (pre-fix: 6 rows, one indistinguishable from the humans').
    assert len(data) == 5
    # conftest's User(id=1) is "testuser"; Ben is id=2. The consensus user's
    # name must never appear, and every row must carry a real coder.
    assert set(r[coder_col] for r in data) == {"testuser", "Ben"}, (
        "consensus (or unattributed) rows leaked into the export"
    )

    # seg 7301's code-A row: "theme B" listed once, not once per coder.
    theme_a_rows = [r for r in data if r[code_col] == "theme A"
                    and "two" in r[header.index("Segment Text")]]
    assert len(theme_a_rows) == 1
    assert theme_a_rows[0][other_col] == "theme B"


def test_coded_segments_csv_facilitator_included_only_on_request(
    multicoder_project, db_session,
):
    rows = _rows(db_session, multicoder_project, exclude_facilitator=False)
    assert len(rows) - 1 == 6  # + the facilitator application, still no consensus


def test_excel_cooccurrence_builder_matches_csv_default(multicoder_project, db_session):
    """#493: the Excel sheet's matrix must equal the CSV endpoint's default
    (participant-only) — previously the Excel builder hard-coded facilitator
    inclusion and the two artifacts disagreed on the same project state."""
    from app.routers.export_helpers import build_code_cooccurrence_matrix, _build_cooccurrence

    excel_matrix = build_code_cooccurrence_matrix(db_session, 730)
    # Diagonal for code A: segments 7300 + 7301 only — the facilitator-coded
    # 7302 must NOT count (it did pre-fix).
    assert excel_matrix.get((7300, 7300)) == 2

    csv_default_matrix, *_ = _build_cooccurrence(
        db_session, 730, exclude_facilitator=True,
    )
    assert excel_matrix == csv_default_matrix


def test_code_frequencies_csv_honors_coder_scope(multicoder_project, db_session):
    """#499: the CSV export must accept and honor the screen's coder/layer
    scope — pre-fix the endpoint had no such params, so a coder-filtered
    screen exported silently-unfiltered numbers. A scoped file also carries a
    'Scope:' claim line."""
    import io as _io
    import csv as _csv
    from app.routers.export import export_code_frequencies_csv
    from app.services.code_analysis import get_code_frequencies

    def rows(coder_ids=None):
        text = _stream_to_text(_run(export_code_frequencies_csv(
            project_id=730, code_ids=None, exclude_facilitator=True,
            conversation_ids=None, participant_ids=None,
            source="conversations", document_ids=None,
            coder_ids=coder_ids, layer_scope=None,
            user=multicoder_project, db=db_session,
        )))
        return list(_csv.reader(_io.StringIO(text)))

    all_rows = rows()
    ben_rows = rows(coder_ids="2")
    assert all_rows[0][0] == "Code", "unscoped export must not carry a Scope line"
    assert ben_rows[0][0].startswith("Scope:") and "Ben" in ben_rows[0][0]

    def seg_count(parsed, code_name):
        header_idx = 1 if parsed[0][0].startswith("Scope:") else 0
        header = parsed[header_idx]
        for r in parsed[header_idx + 1:]:
            if r[header.index("Code")] == code_name:
                return int(r[header.index("Segments")])
        return None

    screen = get_code_frequencies(db_session, 730, coder_ids=[2])
    screen_count = next(
        f["segment_count"] for f in screen["frequencies"]
        if f["code_name"] == "theme A"
    )
    assert seg_count(ben_rows, "theme A") == screen_count
    assert seg_count(all_rows, "theme A") != seg_count(ben_rows, "theme A"), (
        "fixture should make the scoped and unscoped counts differ"
    )


def test_cooccurrence_csv_honors_coder_scope(multicoder_project, db_session):
    """#512: the co-occurrence CSV export must accept and honor the screen's
    coder/layer/source scope (the #499 sibling that fix missed) — pre-fix the
    endpoint and its FE sender dropped coder_ids/layer_scope/source, so a
    blind-mode or coder-filtered screen exported a silently-unfiltered
    all-coder conv+doc matrix. A scoped file also carries the 'Scope:' line."""
    from app.routers.export import export_code_cooccurrence_csv
    from app.services.code_analysis import get_code_cooccurrence

    def parsed(coder_ids=None):
        text = _stream_to_text(_run(export_code_cooccurrence_csv(
            project_id=730, code_ids=None, exclude_facilitator=True,
            conversation_ids=None, participant_ids=None,
            source="conversations", document_ids=None,
            coder_ids=coder_ids, layer_scope=None,
            user=multicoder_project, db=db_session,
        )))
        return list(csv_module.reader(io.StringIO(text)))

    def diagonal(rows, code_name):
        start = 1 if rows[0][0].startswith("Scope:") else 0
        header = rows[start]
        col = header.index(code_name)
        row = next(r for r in rows[start + 1:] if r[0] == code_name)
        return int(row[col])

    all_rows = parsed()
    ben_rows = parsed(coder_ids="2")
    assert not all_rows[0][0].startswith("Scope:")
    assert ben_rows[0][0].startswith("Scope:") and "Ben" in ben_rows[0][0]

    # Fixture: theme A on participant segs 7300 (both coders) + 7301 (Ada only)
    # → all-coder diagonal 2, Ben-only diagonal 1.
    assert diagonal(all_rows, "theme A") == 2
    assert diagonal(ben_rows, "theme A") == 1

    # And each equals the screen endpoint's same-scoped matrix.
    for coder_ids, rows in ((None, all_rows), ([2], ben_rows)):
        screen = get_code_cooccurrence(db_session, 730, coder_ids=coder_ids)
        i = next(idx for idx, c in enumerate(screen["codes"]) if c["name"] == "theme A")
        assert diagonal(rows, "theme A") == screen["matrix"][i][i]


# ── #732 — the group-comparison CSV vs the two screens that show the same test ──
#
# The strip (`ComparisonTestStrip.tsx:34`) and the comparison table
# (`GroupComparisonTable.tsx:357`) both display OMEGA-squared for a one-way
# ANOVA. The CSV wrote `test['effect_size']`, which is ETA-squared, under a
# header that said `eta_sq`. Nothing was mislabelled and nothing was wrong —
# which is why it survived: a researcher who quotes the screen and attaches the
# file simply has two different effect sizes for one test in one deliverable.
#
# The fix emits BOTH (the saved-test APA string already does) and, more
# importantly, defines each column's header label and cell value in ONE place
# (`_test_columns`), because their being thirty lines apart is the actual defect.

from app.routers.comparisons import group_comparison_csv          # noqa: E402
from app.routers.helpers import _fmt_p, _fmt_stat                 # noqa: E402
from app.services.comparisons import compute_group_comparison     # noqa: E402

# mtcars column ids from conftest (mirrors test_comparisons.py)
MPG_ID, CYL_ID, AM_ID = 1, 5, 6


def _comparison_csv(db, **overrides):
    """Direct-call the CSV endpoint.

    ⚠️ EVERY `Query(...)`-defaulted parameter is passed explicitly. A direct
    call takes the function default verbatim, so an omitted `test_type` would
    arrive as the `Query("auto")` OBJECT — which `_resolve_test_type` does not
    match, silently resolving to a t-test and testing the wrong branch.
    """
    kwargs = dict(
        project_id=1,
        column_ids=str(MPG_ID),
        domain_ids=None,
        grouping_column_id=CYL_ID,       # 3 groups → one-way ANOVA
        grouping_column_id_2=None,
        test_type="auto",
        exclude_groups=None,
        nonparametric=False,
        user=db.get(User, 1),
        db=db,
    )
    kwargs.update(overrides)
    text = _stream_to_text(_run(group_comparison_csv(**kwargs)))
    rows = list(csv_module.reader(io.StringIO(text)))
    # #744: the file opens by stating the significance convention it follows,
    # the same shape as the `Scope:` line the coder-scoped exports write. Strip
    # it here so every assertion below still reads `rows[0]` as the header.
    return rows[1:] if rows and rows[0] and rows[0][0].startswith("Significance:") else rows


def test_the_csv_states_the_significance_convention_it_follows(mtcars_session):
    """#744 — an export applies data filters and discloses them; it does not
    apply annotation filters, and says so.

    The screen gates each star on the researcher's show_05/show_01/show_001
    toggles; the file writes the full ladder. That is deliberate — the p-value
    is in the file either way — but a reader comparing the file against a
    screenshot needs the file to say which convention it used.
    """
    text = _stream_to_text(_run(group_comparison_csv(
        project_id=1, column_ids=str(MPG_ID), domain_ids=None,
        grouping_column_id=CYL_ID, grouping_column_id_2=None, test_type="auto",
        exclude_groups=None, nonparametric=False,
        user=mtcars_session.get(User, 1), db=mtcars_session,
    )))
    # Read it as CSV, not as raw text: the line contains commas, so it is
    # quoted on the wire — asserting on `splitlines()[0]` tests the quoting.
    first_cell = next(csv_module.reader(io.StringIO(text)))[0]
    assert first_cell.startswith("Significance:")
    assert "*** p < .001" in first_cell
    assert "display settings are not applied" in first_cell


def _service(db, **overrides):
    kwargs = dict(
        db=db, project_id=1, column_ids=[MPG_ID], domain_ids=[],
        grouping_column_id=CYL_ID, grouping_column_id_2=None,
        test_type="auto", include_effect_size_ci=True,
    )
    kwargs.update(overrides)
    return compute_group_comparison(**kwargs)


def test_anova_csv_carries_the_effect_size_the_screen_displays(mtcars_session):
    """#732: omega-squared reaches the file, and it equals the service's value."""
    db = mtcars_session
    header, data = _comparison_csv(db)[:2]

    assert "omega_sq" in header, (
        "both comparison screens display omega-squared; an export that cannot "
        "carry it disagrees with the screenshot beside it (#732)"
    )
    assert "eta_sq" in header, (
        "eta-squared is kept, not replaced — the saved-test APA string reports "
        "the pair, and dropping it would lose the primary field"
    )

    test = _service(db)["rows"][0]["test"]
    assert data[header.index("omega_sq")] == _fmt_stat(test["omega_squared"])
    assert data[header.index("eta_sq")] == _fmt_stat(test["effect_size"])

    # Without this the fixture proves nothing: if the two statistics rendered
    # identically, a CSV still emitting only eta-squared would pass every
    # assertion above. mtcars mpg×cyl gives .73 vs .71.
    assert data[header.index("omega_sq")] != data[header.index("eta_sq")]


def test_two_group_csv_carries_the_confidence_interval_it_already_computes(mtcars_session):
    """The endpoint hardcodes include_effect_size_ci=True; the CSV discarded it."""
    db = mtcars_session
    header, data = _comparison_csv(db, grouping_column_id=AM_ID)[:2]  # am → 2 groups

    assert "d_CI_lower" in header and "d_CI_upper" in header
    test = _service(db, grouping_column_id=AM_ID)["rows"][0]["test"]
    assert test["effect_size_ci_lower"] is not None, "fixture must actually have a CI"
    assert data[header.index("d_CI_lower")] == _fmt_stat(test["effect_size_ci_lower"])
    assert data[header.index("d_CI_upper")] == _fmt_stat(test["effect_size_ci_upper"])


def test_column_labels_follow_the_test_that_actually_ran(mtcars_session):
    """The header is resolved from the same inputs the service used, not sniffed.

    The 3-groups-but-t_test case is the one that matters: group COUNT says ANOVA
    while the requested test says t, and only the effective test type is right.
    """
    db = mtcars_session
    cases = [
        (dict(), ["F", "p", "eta_sq", "omega_sq", "Sig"]),
        (dict(nonparametric=True), ["H", "p", "epsilon_sq", "Sig"]),
        (dict(grouping_column_id=AM_ID), ["Delta", "p", "d", "d_CI_lower", "d_CI_upper", "Sig"]),
        (dict(grouping_column_id=AM_ID, nonparametric=True), ["U", "p", "r", "Sig"]),
        # 3 groups, t-test requested → the first two groups get a Welch t-test
        (dict(test_type="t_test"), ["t", "p", "d", "d_CI_lower", "d_CI_upper", "Sig"]),
    ]
    for overrides, expected_tail in cases:
        header = _comparison_csv(db, **overrides)[0]
        assert header[-len(expected_tail):] == expected_tail, (
            f"{overrides or 'defaults'} produced {header[-len(expected_tail):]}"
        )


def test_every_declared_column_gets_exactly_one_cell(mtcars_session):
    """Header width and row width derive from one list, so they cannot drift.

    Their drifting apart is the defect class this whole change is about — the
    old code built the header in one branch and the values in another.

    ⚠️ Covers the POPULATED branch only: every mtcars row computes a test, so
    the `test is None` path (which now pads by `len(test_cols)` rather than a
    literal 4) is correct by construction here rather than by execution.
    """
    db = mtcars_session
    for overrides in (dict(), dict(nonparametric=True), dict(grouping_column_id=AM_ID)):
        rows = _comparison_csv(db, **overrides)
        header = rows[0]
        # Skip the post-hoc sub-table, which is deliberately padded to width.
        body = [r for r in rows[1:] if r and not r[0].startswith(("Post-hoc", "Pair"))]
        assert body, "fixture produced no data rows"
        for row in body:
            assert len(row) == len(header), f"{overrides}: {row}"


def test_a_statistic_that_is_not_computable_is_blank_not_zero():
    """#689 makes these fields nullable; a bare f-string 500s the download.

    Pinned at the formatter because that is the single place every export cell
    passes through. The 0.0 case is not decoration: a `if not value` shortcut
    would blank a real measured zero, which is the falsy-zero defect this
    project has already shipped twice.
    """
    assert _fmt_stat(None) == ""
    assert _fmt_p(None) == ""
    assert _fmt_stat(0.0) == "0.00"
    assert _fmt_stat(-0.5) == "-0.50"
    assert _fmt_stat(0.12345, 4) == "0.1235"
