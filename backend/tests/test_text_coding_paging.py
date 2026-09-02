"""`GET /text-coding/texts` returns a PAGE, and its totals describe the SELECTION — #844.

## Why this exists

`list_texts` was the one dataset read path #796–#803 did not bound: no `limit`,
no `offset`, no cap. Measured on one `open_text` column of a 75,699-record
survey it returned **37.8 MB of JSON** at ~239 MB transient against a <256 MB
resident budget — on the *entry screen* of the Text Coding workspace. Three
columns cost 6.8 s on the event loop at 699 MB.

## What is easy to get wrong here, and what each class costs

1. **Paging naively.** The response carries five whole-population aggregates.
   Page it without moving them into SQL and every one silently starts
   describing the page — the `rows.length`-vs-`total_rows` class #800 exists to
   prevent. `TestTotalsDescribeTheSelection` is the guard, and its fixture is
   deliberately **larger than one page**: totals asserted inside a single page
   certify exactly the case that cannot fail.

2. **An unstable sort.** Before #844 the whole set was materialised and sorted
   in Python, so rows comparing equal fell back to whatever order SQLite
   returned — unobservable. Under LIMIT/OFFSET that is a correctness bug: a
   researcher paging through responses sees one twice and never sees another.
   Ties are the COMMON case (`column_sequence_order` ties on every row of a
   column), so `TestPagingIsAPartition` walks every page and asserts the union
   is the population exactly once.

3. **Losing the seeded shuffle.** `random_seed` is PERSISTED in
   `TextCodingConfig`, so the order must survive paging *and* stay reproducible
   across requests.

⚠️ Row identifiers here run to three digits (`R001`…`R250`) deliberately: the
1–5 / single-digit fixtures that hid #406 also hide a lexicographic-vs-numeric
ordering slip, and `row_identifier` is a STRING sort key in this endpoint.
"""

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import (
    Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType,
)
from app.models.excerpt import Excerpt
from app.models.project import Project
from app.models.user import User
from app.routers.text_coding import (
    list_texts, _text_order_clauses, TEXT_PAGE_SIZE, MAX_TEXT_PAGE_SIZE,
)

# A page large enough to hold this module's whole corpus in one response, for
# the few assertions that are about a complete ordering rather than a page.
MAX_FOR_TEST = MAX_TEXT_PAGE_SIZE

PROJECT = 9100
DATASET = 9110
COL_A = 9120
COL_B = 9121

# Larger than one page ON PURPOSE — see the module docstring.
# ⚠️ It must be large enough that the SUBSTANTIVE subset still exceeds a page,
# not merely the row count: roughly a third of these rows are blank or "N/A",
# so `TEXT_PAGE_SIZE + 47` left 169 codeable texts and every totals assertion
# below would have been made inside a single page. `TestFixtureIsDiscriminating`
# is what caught that, and it is why that class is first in the file.
N_ROWS = TEXT_PAGE_SIZE + 160

# Of the rows below: every 5th is blank, every 7th is a recognized non-response.
BLANK_EVERY = 5
NA_EVERY = 7


def _is_blank(i: int) -> bool:
    return i % BLANK_EVERY == 0


def _is_na(i: int) -> bool:
    return not _is_blank(i) and i % NA_EVERY == 0


def _text_for(i: int) -> str:
    if _is_blank(i):
        return ""
    if _is_na(i):
        return "N/A"
    return f"response number {i}"


@pytest.fixture
def corpus(db_session):
    """Two open-text columns over N_ROWS records, spanning several pages."""
    db = db_session
    db.add_all([
        Project(id=PROJECT, user_id=1, name="Paging"),
        Dataset(id=DATASET, project_id=PROJECT, name="Survey"),
        DatasetColumn(
            id=COL_A, dataset_id=DATASET, column_code="QA", column_name="QA",
            column_text="Open A", column_type=ColumnType.OPEN_TEXT,
            sequence_order=0, display_order=0,
        ),
        DatasetColumn(
            id=COL_B, dataset_id=DATASET, column_code="QB", column_name="QB",
            column_text="Open B", column_type=ColumnType.OPEN_TEXT,
            sequence_order=1, display_order=1,
        ),
        Code(id=9130, project_id=PROJECT, name="Theme", numeric_id=2,
             color="#111111", is_universal=False),
        Code(id=9131, project_id=PROJECT, name="Unclear", numeric_id=1,
             color="#222222", is_universal=True),
    ])
    db.flush()

    for i in range(N_ROWS):
        row_id = 91000 + i
        db.add(DatasetRow(id=row_id, dataset_id=DATASET,
                          row_identifier=f"R{i:03d}"))
        # Column A carries the interesting text; column B is always substantive
        # so the two columns can be told apart by their counts.
        db.add(DatasetValue(id=910000 + i, row_id=row_id, column_id=COL_A,
                            value_text=_text_for(i)))
        db.add(DatasetValue(id=920000 + i, row_id=row_id, column_id=COL_B,
                            value_text=f"second answer {i}"))
    db.flush()
    return db


def _call(db, **kw):
    params = dict(
        project_id=PROJECT, column_ids=str(COL_A), dataset_ids=None,
        hide_empty=True, record_id=None, search=None, sort_by="column_asc",
        random_seed=None, quoted_only=False,
        limit=TEXT_PAGE_SIZE, offset=0,
        user=db.get(User, 1), db=db,
    )
    params.update(kw)
    return list_texts(**params)


def _walk_pages(db, page_size, **kw):
    """Every page, in order, following `has_more`. Returns the flat id list."""
    ids, offset, guard = [], 0, 0
    while True:
        guard += 1
        assert guard < 100, "pagination did not terminate"
        res = _call(db, limit=page_size, offset=offset, **kw)
        ids.extend(t.dataset_value_id for t in res.texts)
        if not res.has_more:
            return ids
        assert res.texts, "has_more=True with an empty page would spin forever"
        offset += len(res.texts)


# ── The substantive population, derived from the fixture rule, not restated ──
SUBSTANTIVE = [i for i in range(N_ROWS) if not _is_blank(i) and not _is_na(i)]


class TestFixtureIsDiscriminating:
    """The fixture must be able to fail the tests below (#707a / #730)."""

    def test_the_corpus_spans_more_than_one_page(self, corpus):
        assert N_ROWS > TEXT_PAGE_SIZE
        # And the substantive subset must ALSO exceed a page, or the
        # hide_empty totals would fit in one response and prove nothing.
        assert len(SUBSTANTIVE) > TEXT_PAGE_SIZE

    def test_the_fixture_actually_contains_all_three_text_kinds(self, corpus):
        kinds = {_is_blank(i) or _is_na(i) for i in range(N_ROWS)}
        assert kinds == {True, False}
        assert any(_is_blank(i) for i in range(N_ROWS))
        assert any(_is_na(i) for i in range(N_ROWS))


class TestPageIsBounded:
    def test_the_default_page_is_not_the_population(self, corpus):
        res = _call(corpus)

        assert len(res.texts) == TEXT_PAGE_SIZE
        assert res.total_texts == len(SUBSTANTIVE)
        assert res.total_texts > len(res.texts)
        assert res.has_more is True

    def test_the_last_page_reports_no_more(self, corpus):
        # Land exactly on the end of the substantive set.
        offset = len(SUBSTANTIVE) - 5
        res = _call(corpus, limit=TEXT_PAGE_SIZE, offset=offset)

        assert len(res.texts) == 5
        assert res.has_more is False

    def test_an_offset_past_the_end_is_empty_not_an_error(self, corpus):
        res = _call(corpus, offset=len(SUBSTANTIVE) + 10)

        assert res.texts == []
        assert res.has_more is False
        # The totals still describe the selection, not the empty page.
        assert res.total_texts == len(SUBSTANTIVE)


class TestTotalsDescribeTheSelection:
    """🔴 The class #800 exists to prevent, measured on a multi-page corpus."""

    def test_totals_are_identical_on_every_page(self, corpus):
        first = _call(corpus, offset=0)
        middle = _call(corpus, offset=TEXT_PAGE_SIZE)
        beyond = _call(corpus, offset=len(SUBSTANTIVE) + 10)

        for res in (first, middle, beyond):
            assert res.total_texts == len(SUBSTANTIVE)
            assert res.total_rows == len(SUBSTANTIVE)
            assert res.non_empty_texts == len(SUBSTANTIVE)

        # Discrimination: the pages genuinely differ, so equal totals are a
        # claim about the totals rather than about identical responses.
        assert [t.dataset_value_id for t in first.texts] != \
               [t.dataset_value_id for t in middle.texts]

    def test_hide_empty_false_widens_the_totals(self, corpus):
        """Two-sided: the declaration must MOVE the number, in the right direction."""
        shown = _call(corpus, hide_empty=False)

        assert shown.total_texts == N_ROWS
        # `non_empty_texts` keeps its own meaning when nothing is hidden.
        assert shown.non_empty_texts == len(SUBSTANTIVE)
        assert shown.non_empty_texts < shown.total_texts

    def test_a_second_column_is_counted_in_the_totals_not_the_page(self, corpus):
        both = _call(corpus, column_ids=f"{COL_A},{COL_B}")

        # Column B is substantive on every row.
        assert both.total_texts == len(SUBSTANTIVE) + N_ROWS
        assert len(both.texts) == TEXT_PAGE_SIZE
        assert both.total_rows == N_ROWS


class TestCodedTotalsHonourInvariantJA:
    """Coded = ≥1 NON-universal, non-consensus application (#488)."""

    def test_a_universal_only_value_is_not_coded(self, corpus):
        db = corpus
        # Two ordinary codings, one universal-only value.
        db.add_all([
            CodeApplication(dataset_value_id=910000 + 1, code_id=9130, user_id=1),
            CodeApplication(dataset_value_id=910000 + 2, code_id=9130, user_id=1),
            CodeApplication(dataset_value_id=910000 + 3, code_id=9131, user_id=1),
        ])
        db.flush()

        res = _call(db)

        assert res.coded_texts == 2, "a universal-only value leaked into coded_texts"
        assert res.coded_rows == 2

    def test_two_codes_on_one_value_still_count_it_once(self, corpus):
        """🔴 The join-multiplication trap the EXISTS clauses exist to avoid.

        If `coded_exists` were a join instead, this value would contribute two
        rows — inflating `coded_texts` AND `total_texts`.
        """
        db = corpus
        db.add(Code(id=9132, project_id=PROJECT, name="Second", numeric_id=3,
                    color="#333333", is_universal=False))
        db.flush()
        db.add_all([
            CodeApplication(dataset_value_id=910000 + 1, code_id=9130, user_id=1),
            CodeApplication(dataset_value_id=910000 + 1, code_id=9132, user_id=1),
        ])
        db.flush()

        res = _call(db)

        assert res.coded_texts == 1
        assert res.coded_rows == 1
        # The population count must be untouched by how many codes exist.
        assert res.total_texts == len(SUBSTANTIVE)


class TestTheTiebreakIsRealAndLoadBEARING:
    """🔴 A FULL tie between two different values — the axis the tiebreak exists for.

    ⚠️ **The general paging fixture below could NOT prove this.** With one
    column, `sequence_order` is constant and `row_identifier` is unique, so the
    sort key already determines a total order and SQLite's scan happens to be
    stable — **mutation-tested: removing the tiebreak left all 24 other tests
    green.** That is the degenerate-fixture trap in its exact form: the two
    implementations produce the same answer, so the fixture cannot see the
    difference however large it is.

    ⚠️ **The first attempt at such a fixture was REFUTED BY THE DATABASE**, and
    the refutation is worth keeping: two columns cannot share a
    `sequence_order`, because `dataset_columns` carries a UNIQUE constraint on
    `(dataset_id, sequence_order)`. The premise "nothing constrains
    sequence_order to be unique" was simply wrong.

    The realistic full tie is both simpler and far more common: **a dataset
    whose rows carry no `row_identifier` at all.** `coalesce(row_identifier,
    '')` then collapses to the empty string for every row, so the entire column
    ties on `(sequence_order, '')` and only `DatasetValue.id` separates any two
    of its texts. That is the state every dataset imported without an
    identifier column is in — not an exotic one.
    """

    TIE_DATASET = 9140
    TIE_COL = 9141

    @pytest.fixture
    def tied(self, corpus):
        db = corpus
        db.add(Dataset(id=self.TIE_DATASET, project_id=PROJECT, name="No IDs"))
        db.add(DatasetColumn(
            id=self.TIE_COL, dataset_id=self.TIE_DATASET, column_code="QT",
            column_name="QT", column_text="Tied", column_type=ColumnType.OPEN_TEXT,
            sequence_order=0, display_order=0,
        ))
        db.flush()
        for i in range(N_ROWS):
            # row_identifier deliberately absent — this is what ties them.
            db.add(DatasetRow(id=94000 + i, dataset_id=self.TIE_DATASET,
                              row_identifier=None))
            db.add(DatasetValue(id=930000 + i, row_id=94000 + i,
                                column_id=self.TIE_COL,
                                value_text=f"tied answer {i}"))
        db.flush()
        return db

    def test_the_fixture_really_contains_full_ties(self, tied):
        """Discrimination: proves the sort key cannot separate these rows."""
        res = _call(tied, column_ids=str(self.TIE_COL),
                    limit=MAX_FOR_TEST, offset=0)
        keys = [(t.column_sequence_order, t.row_identifier) for t in res.texts]

        assert len(keys) == N_ROWS
        assert len(set(keys)) == 1, (
            "fixture does not tie — every row must share one sort key, or the "
            "partition assertion below is vacuous"
        )

    def test_a_tied_population_still_pages_as_a_partition(self, tied):
        seen = _walk_pages(tied, page_size=7, column_ids=str(self.TIE_COL))

        assert len(set(seen)) == len(seen), "a tied text appeared on two pages"
        assert len(seen) == N_ROWS

    def test_the_ordering_ends_in_a_unique_key(self):
        """🔴 The structural half — and MEASURED to be the only half that bites.

        Mutation-tested twice. Removing the `DatasetValue.id` tiebreak leaves
        **every behavioural test in this module green, including
        `test_a_tied_population_still_pages_as_a_partition` above, where all
        360 rows share one sort key.** SQLite's planner walked them in rowid
        order both times; a full tie was not enough to make the defect
        observable.

        So the behavioural assertions are kept for what they DO prove (offset
        arithmetic, `has_more`, the seeded shuffle) and this one carries the
        tiebreak. SQL guarantees no ordering among rows a sort key cannot
        separate, so the property worth pinning is structural: the clause list
        ENDS in a unique column. It pins the DECISION, not its consequences —
        which is the honest thing available here, and better than a behavioural
        test that cannot fail.
        """
        for sort_by in ("column_asc", "column_desc", "record_asc", "record_desc"):
            clauses = _text_order_clauses(sort_by)
            last = clauses[-1]

            assert "dataset_values.id" in str(last), (
                f"{sort_by}'s ordering does not end in a unique key, so a page "
                f"boundary falling inside a tie is not reproducible"
            )


class TestPagingIsAPartition:
    """Every text appears on exactly one page — the unstable-sort guard."""

    @pytest.mark.parametrize("sort_by", [
        "column_asc", "column_desc", "record_asc", "record_desc",
    ])
    def test_walking_the_pages_yields_the_population_exactly_once(
        self, corpus, sort_by,
    ):
        seen = _walk_pages(corpus, page_size=17, sort_by=sort_by)

        assert len(seen) == len(SUBSTANTIVE)
        assert len(set(seen)) == len(seen), "a text appeared on two pages"

    def test_a_tiny_page_size_agrees_with_a_large_one(self, corpus):
        """Ordering must not depend on where the pages happen to be cut."""
        small = _walk_pages(corpus, page_size=13)
        large = _walk_pages(corpus, page_size=TEXT_PAGE_SIZE)

        assert small == large

    def test_ties_are_broken_deterministically_across_requests(self, corpus):
        """Every row of one column ties on `sequence_order` — the common case."""
        first = _walk_pages(corpus, page_size=29)
        second = _walk_pages(corpus, page_size=29)

        assert first == second

    def test_the_two_column_orders_are_actually_different(self, corpus):
        """Discrimination: proves the sort parameter reaches the query at all."""
        asc = _walk_pages(corpus, page_size=64, sort_by="column_asc")
        desc = _walk_pages(corpus, page_size=64, sort_by="column_desc")

        assert asc != desc
        assert sorted(asc) == sorted(desc)


class TestSeededShufflePagesCoherently:
    def test_the_shuffle_is_a_partition_too(self, corpus):
        seen = _walk_pages(corpus, page_size=23, random_seed=4242)

        assert len(seen) == len(SUBSTANTIVE)
        assert len(set(seen)) == len(seen)

    def test_the_same_seed_reproduces_the_order_across_pagings(self, corpus):
        a = _walk_pages(corpus, page_size=11, random_seed=137)
        b = _walk_pages(corpus, page_size=97, random_seed=137)

        assert a == b

    def test_it_is_a_shuffle_and_not_the_default_order(self, corpus):
        """Discrimination — #486's degenerate key was monotone in id."""
        plain = _walk_pages(corpus, page_size=50)
        shuffled = _walk_pages(corpus, page_size=50, random_seed=99999)

        assert shuffled != plain
        assert sorted(shuffled) == sorted(plain)

    def test_a_different_seed_gives_a_different_order(self, corpus):
        assert _walk_pages(corpus, page_size=50, random_seed=2) != \
               _walk_pages(corpus, page_size=50, random_seed=3)


class TestFiltersMovedIntoSql:
    def test_quoted_only_filters_the_page_and_the_totals_together(self, corpus):
        db = corpus
        quoted_ids = [910000 + i for i in SUBSTANTIVE[:3]]
        for n, dv_id in enumerate(quoted_ids):
            db.add(Excerpt(id=9400 + n, project_id=PROJECT, dataset_value_id=dv_id))
        db.flush()

        res = _call(db, quoted_only=True)

        assert res.total_texts == 3
        assert {t.dataset_value_id for t in res.texts} == set(quoted_ids)
        assert all(t.is_quoted for t in res.texts)
        assert res.has_more is False

    def test_search_narrows_the_totals_not_just_the_page(self, corpus):
        res = _call(corpus, search="response number 1")

        expected = [i for i in SUBSTANTIVE if "response number 1" in _text_for(i)]
        assert res.total_texts == len(expected)
        assert res.total_texts > 0, "fixture does not discriminate"

    def test_record_id_scopes_to_one_record(self, corpus):
        target = SUBSTANTIVE[10]
        res = _call(corpus, record_id=91000 + target,
                    column_ids=f"{COL_A},{COL_B}")

        assert res.total_texts == 2  # both columns, one record
        assert res.total_rows == 1
