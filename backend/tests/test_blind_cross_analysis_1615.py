"""#1615 — while blind, Text Coding's Cross-analysis neither filters nor groups by a score.

The first round (D283–D287) closed grouping and filtering on the Qualitative page and the
joint display; D293 left Text Coding's Cross-analysis for this one. Its four doors read a
column the researcher picks beside the open-text answers: the subgroup FILTERS
(`filtered-frequencies` and the CSV, through `_apply_filters`), the CROSS-TAB variable and
the code-density GROUP BY. A filter is judged inside the dataset its column sits in (#1534
D107), so a score reaches a comparison when the participant table holds an open-text column
(a researcher can add one — `create_manual_column` refuses no managed table); the cross-tab
also follows participant links into another dataset (the panel offers only the focal
datasets' columns; the server takes any column of the project).

On this fixture (the #1608 `scored_project`: Ana's T1 carries Alice's 2 and Bob's 5, the
snapshot 3.5) the table gains a hand-typed open-text Note, Ana's answer coded by Alice:

- a filter ``score ≥ 3`` keeps Ana (her every-coder 3.5) — Alice's own 2 would drop her —
  and a threshold moved by halves reads the score off exactly;
- ``score above its mean`` prints the every-coder MEAN (``describe_filter``, the screen's
  description and the CSV's ``Filters`` line): 3.50, from which Bob's 5 is read (2 × 3.5 − 2);
- the band (``high`` = score ≥ 3) as a filter, a cross-tab column or a density group puts
  Ana in ``high``.

The blind signal is D273's flag: the panel's ``coder_ids`` is also a lead's coder FILTER, so
the ratings follow it only with ``ratings_follow_coder_ids`` (sent only while withholding).
"""
import csv
import io
import json

import pytest
from fastapi import HTTPException

from app.models.code_application import CodeApplication
from app.models.dataset import ColumnType, DatasetColumn, DatasetRow, DatasetValue
from app.schemas.text_analysis import (
    CrossTabulationRequest, FilteredFrequenciesRequest, SubgroupFilter,
)
from tests.test_blind_file_scope_1530 import (  # noqa: F401 — the fixtures
    ALICE, ALICE_THEME, BOB, PID, TEXT_COL, _body, _user, blind_project, scored_project,
)
from tests.test_blind_grouping_1615 import BAND, BAND_DEMO, SITE, banded  # noqa: F401

BLIND = [ALICE]
NOTE, NOTE_ANA = 161551, 161552


@pytest.fixture
def noted(banded):
    """The participant table gains a hand-typed open-text Note (Ana's answer, coded by
    Alice), so its own columns can filter, cross-tab and group the comparison; and the
    Survey's first answer is linked to Ana, so a cross-tab across datasets reaches her."""
    db, ds, ana = banded["db"], banded["dataset"], banded["ana"]
    row = db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id,
                                      DatasetRow.participant_id == ana.id).one()
    db.add(DatasetColumn(id=NOTE, dataset_id=ds.id, column_code="note", column_name="note",
                         column_text="Note", column_type=ColumnType.OPEN_TEXT, source="manual",
                         sequence_order=94, display_order=94))
    db.flush()
    db.add(DatasetValue(id=NOTE_ANA, row_id=row.id, column_id=NOTE, value_text="the bus again"))
    db.flush()
    db.add(CodeApplication(code_id=ALICE_THEME, user_id=ALICE, dataset_value_id=NOTE_ANA))
    db.get(DatasetRow, 15320).participant_id = ana.id
    db.flush()
    banded["score_id"] = banded["score"].id
    return banded


def _freq(db, filters, **kw):
    from app.routers.text_analysis import filtered_frequencies
    body = FilteredFrequenciesRequest(
        column_ids=[NOTE], filters=[SubgroupFilter(**f) for f in filters], **kw)
    return filtered_frequencies(PID, body, db=db, user=_user(db))


def _export(db, filters, **kw):
    from app.routers.text_analysis import export_cross_analysis
    resp = export_cross_analysis(PID, column_ids=str(NOTE), filters_json=json.dumps(filters),
                                 layer_scope=None, db=db, user=_user(db), **kw)
    return list(csv.reader(io.StringIO(_body(resp).decode("utf-8"))))


def _cross(db, cross_column_id, text_column_ids=(NOTE,), **kw):
    from app.routers.text_analysis import cross_tabulation
    body = CrossTabulationRequest(text_column_ids=list(text_column_ids),
                                  cross_column_id=cross_column_id, **kw)
    return cross_tabulation(PID, body, db=db, user=_user(db))


def _density(db, group_by, coder_ids=None, **kw):
    from app.routers.text_analysis import code_density
    return code_density(PID, column_ids=str(NOTE), group_by_column_id=group_by,
                        coder_ids=coder_ids, layer_scope=None, db=db, user=_user(db), **kw)


def _refused(fn, *, filter_word):
    with pytest.raises(HTTPException) as exc:
        fn()
    assert exc.value.status_code == 409
    detail = exc.value.detail
    assert "while blind" in detail and "every coder's ratings" in detail
    assert filter_word in detail
    return detail


def _gte(col, value):
    return {"column_id": col, "operator": "gte", "value": value}


def _above(col):
    return {"column_id": col, "operator": "above_mean"}


def _band_in(values):
    return {"column_id": BAND, "operator": "in", "values": values}


class TestTheFilters:
    def test_a_filter_on_the_score_itself_is_refused_while_blind(self, noted):
        db, score = noted["db"], noted["score_id"]
        # The leak's shape, unscoped: the threshold keeps Ana on her every-coder 3.5 …
        assert _freq(db, [_gte(score, 3)]).filtered.row_count == 1
        assert _freq(db, [_gte(score, 3.6)]).filtered.row_count == 0   # … and halves read it off
        detail = _refused(lambda: _freq(db, [_gte(score, 3)], coder_ids=BLIND,
                                        ratings_follow_coder_ids=True), filter_word="cannot filter")
        assert detail.startswith("“")  # the column's name, as the grouping refusal names it

    def test_a_mean_filter_never_prints_the_every_coder_mean_while_blind(self, noted):
        db, score = noted["db"], noted["score_id"]
        assert "(3.50)" in _freq(db, [_above(score)]).filter_description   # Bob's 5 = 2 × 3.5 − 2
        _refused(lambda: _freq(db, [_above(score)], coder_ids=BLIND, ratings_follow_coder_ids=True),
                 filter_word="cannot filter")

    def test_a_band_filter_is_refused_and_a_score_filter_beside_an_ordinary_one_too(self, noted):
        db = noted["db"]
        assert _freq(db, [_band_in(["high"])]).filtered.row_count == 1   # Ana is in `high`
        site = {"column_id": SITE, "operator": "in", "values": ["North"]}
        _refused(lambda: _freq(db, [site, _band_in(["high"])], coder_ids=BLIND,
                               ratings_follow_coder_ids=True), filter_word="cannot filter")

    def test_controls_every_rater_an_ordinary_column_and_a_leads_coder_filter(self, noted):
        db, score = noted["db"], noted["score_id"]
        # A scope holding every coder whose ratings the snapshot carries withholds nothing (D98).
        assert _freq(db, [_gte(score, 3)], coder_ids=[ALICE, BOB],
                     ratings_follow_coder_ids=True).filtered.row_count == 1
        # An ordinary hand-typed column filters while blind, and her own coding is counted.
        out = _freq(db, [{"column_id": SITE, "operator": "in", "values": ["North"]}],
                    coder_ids=BLIND, ratings_follow_coder_ids=True)
        assert out.filtered.row_count == 1 and out.filtered.frequencies
        # A lead's coder FILTER without the flag is not blind (D273): the score still filters.
        assert _freq(db, [_gte(score, 3)], coder_ids=BLIND).filtered.row_count == 1

    def test_the_csv_refuses_the_same_filter_and_keeps_an_ordinary_one(self, noted):
        db, score = noted["db"], noted["score_id"]
        rows = _export(db, [_above(score)], coder_ids=None)
        assert any(r and r[0] == "Filters" and "(3.50)" in r[1] for r in rows)   # the leak
        _refused(lambda: _export(db, [_above(score)], coder_ids=str(ALICE),
                                 ratings_follow_coder_ids=True), filter_word="cannot filter")
        rows = _export(db, [{"column_id": SITE, "operator": "in", "values": ["North"]}],
                       coder_ids=str(ALICE), ratings_follow_coder_ids=True)
        assert ["Filters", "site is one of North"] in rows


class TestTheGroupings:
    def test_the_cross_tab_by_a_band_is_refused_while_blind(self, noted):
        db = noted["db"]
        assert _cross(db, BAND).response_values == ["high"]           # the leak's shape
        detail = _refused(lambda: _cross(db, BAND, coder_ids=BLIND, ratings_follow_coder_ids=True),
                          filter_word="cannot form groups")
        assert detail.startswith("“band”")

    def test_the_cross_tab_follows_participant_links_so_another_datasets_text_is_refused_too(self, noted):
        db, score = noted["db"], noted["score_id"]
        # The Survey's answer, linked to Ana, crossed by the participant table's SCORE itself —
        # the server takes any column (the panel offers only the focal datasets' categoricals).
        out = _cross(db, score, text_column_ids=(TEXT_COL,))
        assert out.response_values == ["3.500"] and out.total_coded_texts == 1   # the raw score
        _refused(lambda: _cross(db, score, text_column_ids=(TEXT_COL,), coder_ids=BLIND,
                                ratings_follow_coder_ids=True), filter_word="cannot form groups")

    def test_the_code_density_by_a_band_is_refused_while_blind(self, noted):
        db = noted["db"]
        assert [g.group_value for g in _density(db, BAND).groups] == ["high"]
        _refused(lambda: _density(db, BAND, coder_ids=str(ALICE), ratings_follow_coder_ids=True),
                 filter_word="cannot form groups")

    def test_controls_every_rater_an_ordinary_column_and_a_leads_coder_filter(self, noted):
        db = noted["db"]
        assert _cross(db, BAND, coder_ids=[ALICE, BOB], ratings_follow_coder_ids=True).response_values == ["high"]
        assert _cross(db, SITE, coder_ids=BLIND, ratings_follow_coder_ids=True).response_values == ["North"]
        assert _cross(db, BAND, coder_ids=BLIND).response_values == ["high"]   # a lead's filter
        assert [g.group_value for g in _density(db, SITE, coder_ids=str(ALICE),
                                                ratings_follow_coder_ids=True).groups] == ["North"]
        assert [g.group_value for g in _density(db, BAND, coder_ids=str(ALICE)).groups] == ["high"]
        # No grouping at all: the density's overall needs no gate.
        assert _density(db, None, coder_ids=str(ALICE), ratings_follow_coder_ids=True).overall.text_count == 1


class TestTheGateIsAskedEverywhere:
    def test_the_filter_resolver_takes_the_blind_scope_with_no_default(self):
        import inspect
        from app.routers import text_analysis
        p = inspect.signature(text_analysis._apply_filters).parameters["blind_scope"]
        assert p.kind is inspect.Parameter.KEYWORD_ONLY and p.default is inspect.Parameter.empty

    def test_every_text_analysis_route_that_reads_a_picked_column_takes_the_flag(self):
        """The four doors that read a column the researcher picks (a filter, a cross-tab or a
        density grouping) take `ratings_follow_coder_ids`; the response-length route reads
        only the focal texts, so it is the falsifier — it must NOT need one."""
        import inspect
        from app.routers import text_analysis as ta
        from app.schemas.text_analysis import CrossTabulationRequest, FilteredFrequenciesRequest
        assert "ratings_follow_coder_ids" in FilteredFrequenciesRequest.model_fields
        assert "ratings_follow_coder_ids" in CrossTabulationRequest.model_fields
        for fn in (ta.code_density, ta.export_cross_analysis):
            assert "ratings_follow_coder_ids" in inspect.signature(fn).parameters, fn.__name__
        assert "ratings_follow_coder_ids" not in inspect.signature(ta.response_length_by_code).parameters
