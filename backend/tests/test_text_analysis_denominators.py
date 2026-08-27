"""#519 — text-analysis denominators must match the coding-progress gauge.

The workbench gauge drops blank AND recognized non-substantive strings
(`treat_as_empty`, default incl. "N/A") from its totals, but the text-analysis
denominators (`code-density` text_count, frequency percentages, response length,
CSV export) used a NULL/''-only filter — so a column with 4 literal "N/A" values
showed "0/36" in the gauge and "40 comments" in Code Density (the live repro).

Fix: `services/text_analysis.get_non_empty_comment_values` requires a
`treat_as_empty` list (read via `treat_as_empty_for_project`, read-only — no
config row is created on GET) and is the single place the "which texts count"
decision lives; `routers/text_coding._is_empty` delegates to the same
`models.text_coding_config.is_empty_text`.
"""
import asyncio
import json

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.text_coding_config import TextCodingConfig
from app.routers.text_analysis import code_density
from app.routers.text_coding import coding_progress, text_columns
from app.services.text_analysis import compute_comment_frequencies

PID = 970
TEXT_COL = 9700
CODE_Y = 9705
V_CODED = 97010    # substantive, coded
V_PLAIN = 97020    # substantive, uncoded
V_NA = 97030       # literal "N/A" — the #519 trap
V_BLANK = 97040    # whitespace-only


def _run(coro):
    return asyncio.run(coro)


def _setup(db):
    db.add_all([
        Project(id=PID, name="Denominators", user_id=1),
        Dataset(id=PID, project_id=PID, name="Survey"),
        DatasetColumn(id=TEXT_COL, dataset_id=PID, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9701, dataset_id=PID),
        DatasetRow(id=9702, dataset_id=PID),
        DatasetRow(id=9703, dataset_id=PID),
        DatasetRow(id=9704, dataset_id=PID),
        Code(id=CODE_Y, project_id=PID, name="Y", color="#222222",
             numeric_id=1, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=V_CODED, row_id=9701, column_id=TEXT_COL, value_text="strong pacing overall"),
        DatasetValue(id=V_PLAIN, row_id=9702, column_id=TEXT_COL, value_text="uneven start"),
        DatasetValue(id=V_NA, row_id=9703, column_id=TEXT_COL, value_text="N/A"),
        DatasetValue(id=V_BLANK, row_id=9704, column_id=TEXT_COL, value_text="   "),
    ])
    db.flush()
    db.add(CodeApplication(dataset_value_id=V_CODED, code_id=CODE_Y, user_id=1))
    db.flush()


def test_code_density_denominator_matches_gauge(db_session):
    db = db_session
    _setup(db)
    user = db.get(User, 1)

    gauge = _run(coding_progress(project_id=PID, column_ids=str(TEXT_COL), user=user, db=db))
    density = _run(code_density(project_id=PID, column_ids=str(TEXT_COL),
                                group_by_column_id=None, coder_ids=None, layer_scope=None,
                                db=db, user=user))

    # 2 substantive texts — "N/A" and the blank are out of BOTH denominators.
    assert gauge.overall_texts["total"] == 2
    assert density.overall.text_count == 2, "density counted N/A/blank texts the gauge drops"
    assert density.overall.text_count == gauge.overall_texts["total"]
    # 1 code on 2 substantive texts → 0.5 (the pre-fix 4-text denominator gave 0.25).
    assert density.overall.avg_codes_per_text == 0.5


def test_frequency_percentage_uses_substantive_denominator(db_session):
    db = db_session
    _setup(db)

    result = compute_comment_frequencies(db, PID, [TEXT_COL])

    assert result["text_count"] == 2
    freq = {f["code_id"]: f for f in result["frequencies"]}[CODE_Y]
    assert freq.get("count") == 1
    assert freq.get("percentage") == 50.0, "1 of 2 substantive texts, not 1 of 4"


def test_custom_treat_as_empty_config_is_honored_read_only(db_session):
    db = db_session
    _setup(db)
    user = db.get(User, 1)

    # Custom config: only "skip me" is non-substantive — "N/A" becomes a real text.
    db.add(TextCodingConfig(project_id=PID, treat_as_empty=json.dumps(["skip me"])))
    db.flush()

    density = _run(code_density(project_id=PID, column_ids=str(TEXT_COL),
                                group_by_column_id=None, coder_ids=None, layer_scope=None,
                                db=db, user=user))

    # "N/A" now counts (blank never does): coded + plain + "N/A" = 3.
    assert density.overall.text_count == 3

    # Read path must not have spawned a second config row (read-only lookup).
    assert db.query(TextCodingConfig).filter(TextCodingConfig.project_id == PID).count() == 1


# ─────────────────────────────────────────────────────────────────────────────
# #840 — the SAME rule on the source-frequencies surface, and the SQL half
#
# `get_source_frequencies` hand-rolled `value_text != ''` for its open-text
# totals, so a column whose every substantive text was coded reported 90%
# (measured on the dev corpus: 36 coded of a 40 that included four "N/A"s).
# Those four cells are hidden from the workbench by default and can never be
# coded, so they were rows in a denominator the numerator cannot reach.
#
# The rule now comes from `substantive_text_clause` — the SQL expression of
# `is_empty_text`. Routing these aggregates through
# `get_non_empty_comment_values` was REJECTED: it materialises every row, and an
# open-text column can hold 75,699 of them (#844).
# ─────────────────────────────────────────────────────────────────────────────

import pytest

from app.models.participant import Participant
from app.models.text_coding_config import DEFAULT_TREAT_AS_EMPTY, is_empty_text
from app.services.code_analysis import get_source_frequencies
from app.services.text_analysis import substantive_text_clause

CLAUSE_PID = 972
CLAUSE_COL = 9720

# Every case that separates the SQL rule from the Python one. The padded and
# whitespace-only forms are the ones a naive `TRIM(x)` or a bare `!= val` chain
# gets wrong — which is exactly what `text_coding.py` used to do.
CLAUSE_CASES = [
    "N/A", " N/A ", "N/A\n", "\tNA", "n/a", " N/A",
    "NONE", "None", "no response", "No response",
    "real answer", "N/A extra", "-", ".", "   ", "", None,
]


def _clause_setup(db):
    db.add_all([
        Project(id=CLAUSE_PID, name="Clause", user_id=1),
        Dataset(id=CLAUSE_PID, project_id=CLAUSE_PID, name="S"),
        DatasetColumn(id=CLAUSE_COL, dataset_id=CLAUSE_PID, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
    ])
    db.flush()
    for i, text in enumerate(CLAUSE_CASES):
        db.add(DatasetRow(id=97200 + i, dataset_id=CLAUSE_PID))
    db.flush()
    for i, text in enumerate(CLAUSE_CASES):
        db.add(DatasetValue(id=97200 + i, row_id=97200 + i, column_id=CLAUSE_COL, value_text=text))
    db.flush()


class TestSubstantiveTextClauseAgreement:
    """The SQL clause and `is_empty_text` are ONE predicate in two languages.

    Only this test keeps them from drifting into the bug they exist to prevent.
    """

    def test_sql_clause_matches_is_empty_text_on_every_case(self, db_session):
        db = db_session
        _clause_setup(db)

        kept = {
            r[0] for r in db.query(DatasetValue.id)
            .filter(DatasetValue.column_id == CLAUSE_COL)
            .filter(substantive_text_clause(DEFAULT_TREAT_AS_EMPTY)).all()
        }
        disagreements = []
        for i, text in enumerate(CLAUSE_CASES):
            sql = (97200 + i) in kept
            python = not is_empty_text(text, DEFAULT_TREAT_AS_EMPTY)
            if sql != python:
                disagreements.append((text, sql, python))
        assert not disagreements, f"SQL/Python disagree on: {disagreements}"

        # Positive control: the fixture must actually separate the two outcomes,
        # or a clause that keeps (or drops) everything would pass the loop above.
        assert 0 < len(kept) < len(CLAUSE_CASES), "fixture does not discriminate"

    def test_empty_treat_as_empty_list_still_drops_blanks(self, db_session):
        db = db_session
        _clause_setup(db)

        kept = {
            r[0] for r in db.query(DatasetValue.id)
            .filter(DatasetValue.column_id == CLAUSE_COL)
            .filter(substantive_text_clause([])).all()
        }
        expected = {97200 + i for i, t in enumerate(CLAUSE_CASES) if not is_empty_text(t, [])}
        assert kept == expected
        # "N/A" is substantive when nothing is declared non-substantive...
        assert 97200 + CLAUSE_CASES.index("N/A") in kept
        # ...but NULL / blank / whitespace-only never are.
        assert 97200 + CLAUSE_CASES.index("   ") not in kept
        assert 97200 + CLAUSE_CASES.index(None) not in kept


class TestSourceFrequenciesTextDenominator:
    """The measured #840 defects, and the invariant that keeps the fix sound."""

    def _text_source(self, db):
        result = get_source_frequencies(db, PID, text_column_ids=[TEXT_COL])
        sources = [s for s in result["sources"] if s["source_type"] == "text_column"]
        assert len(sources) == 1, sources
        return sources[0], result

    def test_total_segments_excludes_texts_that_cannot_be_coded(self, db_session):
        db = db_session
        _setup(db)

        source, _ = self._text_source(db)

        # 2 substantive of 4 stored values. Pre-fix this was 4, so the fully
        # codeable column read 1/4 = 25% instead of 1/2 = 50%.
        assert source["total_segments"] == 2, "N/A and blank counted in the denominator"
        assert source["coded_segments"] == 1

    def test_total_segments_agrees_with_the_gauge(self, db_session):
        db = db_session
        _setup(db)
        user = db.get(User, 1)

        source, _ = self._text_source(db)
        gauge = _run(coding_progress(project_id=PID, column_ids=str(TEXT_COL), user=user, db=db))

        assert source["total_segments"] == gauge.overall_texts["total"]
        assert source["coded_segments"] == gauge.overall_texts["coded"]

    def test_total_records_excludes_non_substantive_only_records(self, db_session):
        db = db_session
        _setup(db)

        _, result = self._text_source(db)

        # 4 rows carry a value; only 2 carry a substantive one. Measured on the
        # dev corpus this read 160 where the truth is 156.
        assert result["totals"]["total_records"] == 2

    def test_a_coded_non_substantive_text_cannot_inflate_coverage(self, db_session):
        """The reason the NUMERATORS moved too.

        `hide_empty` is a user toggle, so an "N/A" cell CAN be coded. With only
        the denominators filtered, this column would report 2 coded of 2 — 100%
        — when one of those two codings is on a cell no denominator counts.
        """
        db = db_session
        _setup(db)
        db.add(CodeApplication(dataset_value_id=V_NA, code_id=CODE_Y, user_id=1))
        db.flush()

        source, result = self._text_source(db)

        assert source["coded_segments"] == 1, "counted a coding on a non-substantive text"
        assert source["coded_segments"] <= source["total_segments"]
        assert result["totals"]["total_records"] == 2

        # The per-code RECORD share has the same numerator/denominator pairing:
        # unfiltered, `rec_by_code_q` reports this code on 2 of 2 records when
        # only one substantive record carries it.
        code_row = {c["id"]: c for c in result["codes"]}[CODE_Y]
        assert code_row["record_count"] == 1


class TestSourceFrequenciesGroupDenominator:
    """The per-GROUP totals — the second site, which no real corpus reaches.

    `_compute_source_groups` carries its own copy of the totals and the coded
    count. The dev corpus has no participant-linked open-text rows, so this path
    is unmeasurable there and only a fixture can pin it.
    """

    def test_group_totals_exclude_texts_that_cannot_be_coded(self, db_session):
        db = db_session
        _setup(db)
        db.add_all([
            Participant(id=9791, project_id=PID, identifier="P1",
                        display_name="P1", role="Teacher"),
            Participant(id=9792, project_id=PID, identifier="P2",
                        display_name="P2", role="Teacher"),
            Participant(id=9793, project_id=PID, identifier="P3",
                        display_name="P3", role="Coach"),
        ])
        db.flush()
        # A dataset links each participant to at most ONE row, so the group's
        # total and coded count are separated by putting two TEACHERS on the two
        # rows that differ: one substantive+coded, one "N/A".
        db.get(DatasetRow, 9701).participant_id = 9791   # "strong pacing overall", coded
        db.get(DatasetRow, 9703).participant_id = 9792   # "N/A"
        db.get(DatasetRow, 9702).participant_id = 9793   # "uneven start", uncoded
        # Code the "N/A" too, so this fixture exercises the group COUNT as well
        # as the group TOTAL — `_compute_source_groups` carries its own copy of
        # both, and without a coded non-substantive value the numerator half is
        # unguarded (a mutant that drops its filter would survive).
        db.add(CodeApplication(dataset_value_id=V_NA, code_id=CODE_Y, user_id=1))
        db.flush()

        result = get_source_frequencies(db, PID, text_column_ids=[TEXT_COL],
                                        group_by_subtype="role")
        source = [s for s in result["sources"] if s["source_type"] == "text_column"][0]
        groups = source["groups"]
        assert groups, "fixture produced no groups — the site under test never ran"

        # Teacher: 2 stored values, 1 substantive, 1 coded → 1/1, not 1/2.
        assert groups["Teacher"]["total_segments"] == 1
        assert groups["Teacher"]["coded_segments"] == 1
        assert groups["Coach"]["total_segments"] == 1
        assert groups["Coach"]["coded_segments"] == 0


class TestTextColumnPickerUsesTheSharedClause:
    """`text_coding.text_columns` had its OWN SQL rule — an untrimmed `!= val`
    chain — so it kept " N/A " where `is_empty_text` drops it. Two SQL rules for
    one predicate, already disagreeing. It now shares `substantive_text_clause`.

    ⚠️ This test needs a PADDED value: on unpadded data the two rules agree, so
    a fixture without one cannot tell the change happened (both mutants of the
    picker survived until this was added).
    """

    def test_padded_non_substantive_text_is_excluded_like_the_gauge(self, db_session):
        db = db_session
        _setup(db)
        # A padded sentinel — the exact case the old chain kept.
        db.add(DatasetRow(id=9705, dataset_id=PID))
        db.flush()
        db.add(DatasetValue(id=97050, row_id=9705, column_id=TEXT_COL, value_text="  N/A  "))
        db.flush()
        user = db.get(User, 1)

        listing = _run(text_columns(project_id=PID, user=user, db=db))
        col = {c.column_id: c for c in listing.columns}[TEXT_COL]
        gauge = _run(coding_progress(project_id=PID, column_ids=str(TEXT_COL), user=user, db=db))

        assert is_empty_text("  N/A  ", DEFAULT_TREAT_AS_EMPTY), "fixture value is not the trap"
        assert col.non_empty_rows == 2, "the padded sentinel was counted as a response"
        assert col.non_empty_rows == gauge.overall_texts["total"]

    def test_padded_non_substantive_text_is_excluded_from_the_coded_count(self, db_session):
        db = db_session
        _setup(db)
        db.add(DatasetRow(id=9705, dataset_id=PID))
        db.flush()
        db.add(DatasetValue(id=97050, row_id=9705, column_id=TEXT_COL, value_text="  N/A  "))
        db.flush()
        db.add(CodeApplication(dataset_value_id=97050, code_id=CODE_Y, user_id=1))
        db.flush()
        user = db.get(User, 1)

        listing = _run(text_columns(project_id=PID, user=user, db=db))
        col = {c.column_id: c for c in listing.columns}[TEXT_COL]

        # "N coded ⊆ y responded" — the reading the picker's own #492 comment
        # promises. Unfiltered, the coded count reaches 2 of a 2-response base.
        assert col.coded_rows == 1
        assert col.coded_rows <= col.non_empty_rows
