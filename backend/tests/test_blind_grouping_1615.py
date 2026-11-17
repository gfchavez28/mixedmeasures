"""#1615 — while blind, a variable worked out from participant scores forms no groups.

#1608 withheld the participant table's rating columns at the doors that SHOW the table. A
door that GROUPS or ATTRIBUTES by one of them shows them too: grouping participants by a
band of a score tells a blind coder which band each person's EVERY-CODER score fell in.
On this fixture (the #1608 `scored_project`: Ana's T1 carries Alice's 2 and Bob's 5, the
snapshot 3.5) a band ``high`` = "score ≥ 3" puts Ana in ``high`` — where Alice's own 2
would put her in ``low`` — so Alice reads that a colleague rated higher. A survey strand
over the score itself prints the 3.5, from which Bob's 5 is read exactly (2 × 3.5 − 2).

The blind signal: the joint display sends ``coder_ids`` ONLY while withholding (D175 —
it has no coder filter), so there ``coder_ids`` IS the blind scope. The Qualitative page's
``coder_ids`` is also a lead's coder FILTER (#499), so its doors take the blind scope only
with ``ratings_follow_coder_ids`` (D102's shape, sent only while withholding) — a lead
filtering to one coder is not blind and keeps every grouping.
"""
import json

import pytest

from app.models.dataset import ColumnType, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.services.code_analysis import GroupingColumnError
from tests.test_blind_file_scope_1530 import (  # noqa: F401 — the fixtures
    ALICE, BOB, PID, SHARED, T1, _run, _user, blind_project, scored_project,
)

BLIND = [ALICE]
BAND, BAND_DEMO, SITE = 161501, 161502, 161503


@pytest.fixture
def banded(scored_project):
    """The participant table gains a band of the score (computed, nominal — the joint
    display's and the column-id comparison's grouping), the same band retyped to
    DEMOGRAPHIC (the Qualitative page's subtype grouping and Filters — reachable through
    the Variables view's bulk type change, which refuses only managed columns), and an
    ordinary hand-typed Site (the control: never withheld)."""
    db, ds, ana = scored_project["db"], scored_project["dataset"], scored_project["ana"]
    score = scored_project["cols"]["magnitude_score"]
    row = db.query(DatasetRow).filter(DatasetRow.dataset_id == ds.id,
                                      DatasetRow.participant_id == ana.id).one()
    db.add_all([
        DatasetColumn(id=BAND, dataset_id=ds.id, column_code="band", column_name="band",
                      column_text="Score band", column_type=ColumnType.NOMINAL,
                      source="computed", expression='if([s] >= 3, "high", "low")',
                      sequence_order=91, display_order=91,
                      depends_on_column_ids=json.dumps([score.id])),
        DatasetColumn(id=BAND_DEMO, dataset_id=ds.id, column_code="bandd", column_name="bandd",
                      column_text="Score group", column_type=ColumnType.DEMOGRAPHIC,
                      source="computed", expression='if([s] >= 3, "high", "low")',
                      sequence_order=92, display_order=92,
                      depends_on_column_ids=json.dumps([score.id])),
        DatasetColumn(id=SITE, dataset_id=ds.id, column_code="site", column_name="site",
                      column_text="Site", column_type=ColumnType.DEMOGRAPHIC,
                      source="manual", sequence_order=93, display_order=93),
    ])
    db.flush()
    db.add_all([
        DatasetValue(row_id=row.id, column_id=BAND, value_text="high"),
        DatasetValue(row_id=row.id, column_id=BAND_DEMO, value_text="high"),
        DatasetValue(row_id=row.id, column_id=SITE, value_text="North"),
    ])
    db.flush()
    scored_project["score"] = score
    scored_project["quote"] = db.query(Excerpt.id).filter(Excerpt.segment_id == T1).scalar()
    return scored_project


def _display(db, group_by, column_ids=(), coder_ids=None):
    from app.services.joint_display import RowRequest, compute_joint_display
    return compute_joint_display(
        db, PID, group_by_column_id=group_by,
        rows=[RowRequest(key="r", code_ids=(SHARED,), column_ids=tuple(column_ids))],
        conversation_ids=None, document_ids=None, coder_ids=coder_ids,
        layer_scope="human", newcombe=False)


def _refused(fn):
    with pytest.raises(GroupingColumnError) as exc:
        fn()
    assert exc.value.status_code == 409
    msg = str(exc.value)
    assert "cannot form groups while blind" in msg
    assert "every coder's ratings" in msg
    return msg


class TestTheJointDisplay:
    def test_a_band_of_a_score_forms_no_groups_while_blind(self, banded):
        db = banded["db"]
        assert [g["key"] for g in _display(db, BAND)["groups"]] == ["high"]   # the leak's shape
        msg = _refused(lambda: _display(db, BAND, coder_ids=BLIND))
        assert msg.startswith("“band”")   # the column's name, as the 400 beside it names it

    def test_a_scope_holding_every_rater_and_an_ordinary_column_keep_their_groups(self, banded):
        db = banded["db"]
        assert [g["key"] for g in _display(db, BAND, coder_ids=[ALICE, BOB])["groups"]] == ["high"]
        assert [g["key"] for g in _display(db, SITE, coder_ids=BLIND)["groups"]] == ["North"]

    def test_a_survey_strand_over_a_score_is_left_out_and_says_why(self, banded):
        db, score = banded["db"], banded["score"]
        (open_var,) = _display(db, SITE, column_ids=[score.id])["rows"][0]["variables"]
        assert open_var["cells"][0]["mean"] == 3.5   # the leak, unscoped: 2 × 3.5 − 2 = Bob's 5
        out = _display(db, SITE, column_ids=[score.id, SITE], coder_ids=BLIND)["rows"][0]
        withheld, site = out["variables"]
        assert withheld["unavailable_reason"] == "rating_withheld_blind"
        assert withheld["summary"] is None and withheld["cells"] == [] and withheld["effect"] is None
        assert site["unavailable_reason"] is None and site["summary"] == "distribution"
        # The row's RATED code still follows the scope: her own rating, never the snapshot's.
        (code,) = out["codes"]
        assert code["cells"][0]["rating"]["mean"] == 2.0

    def test_a_band_as_a_survey_strand_is_left_out_too(self, banded):
        db = banded["db"]
        (v,) = _display(db, SITE, column_ids=[BAND], coder_ids=BLIND)["rows"][0]["variables"]
        assert v["unavailable_reason"] == "rating_withheld_blind"

    def test_the_pin_pickers_group_is_refused(self, banded):
        from app.services import joint_display_pins as pins
        db = banded["db"]

        def passages(coder_ids):
            return pins.group_passages(
                db, PID, group_by_column_id=BAND, group="high", code_id=SHARED,
                conversation_ids=None, document_ids=None, coder_ids=coder_ids,
                layer_scope="human", chips_follow_coder_ids=bool(coder_ids), limit=10, offset=0)

        assert passages(None)["total_segments"] >= 1
        _refused(lambda: passages(BLIND))

    def test_a_pins_attribution_leaves_the_bands_value_out_and_says_so(self, banded):
        from app.routers.joint_display import pin_attribution_facts
        from app.schemas.joint_display import JointDisplayPinFactsRequest
        db, quote = banded["db"], banded["quote"]

        def facts(column_id, coder_ids=None):
            body = JointDisplayPinFactsRequest(excerpt_ids=[quote], column_id=column_id,
                                               coder_ids=coder_ids)
            return pin_attribution_facts(PID, body, user=_user(db), db=db)

        unscoped = facts(BAND)
        assert unscoped["pins"][0]["column_value"] == "high"     # the leak, unscoped
        assert unscoped["column_name"] is None
        scoped = facts(BAND, BLIND)
        assert scoped["pins"][0]["column_value"] is None
        assert scoped["column_withheld"] is True
        # D286 (the build): the note names the column, so the answer does — only when withheld.
        assert scoped["column_name"] == "band"
        # The rest of the attribution stays: who said it and where (D163.4).
        assert scoped["pins"][0]["participant_identifier"] == "Ana"
        assert scoped["pins"][0]["source_name"] == "Interview 1"
        ordinary = facts(SITE, BLIND)
        assert ordinary["pins"][0]["column_value"] == "North" and ordinary["column_withheld"] is False
        assert ordinary["column_name"] is None
        # Through the response model, as the client receives it (pytest forbids extra keys).
        from app.schemas.joint_display import JointDisplayPinFactsResponse
        assert JointDisplayPinFactsResponse(**scoped).column_name == "band"


class TestTheQualitativePage:
    def test_the_comparison_by_a_band_is_refused_while_blind(self, banded):
        from app.routers.code_analysis import demographic_comparison
        from app.schemas.code_analysis import DemographicComparisonRequest
        from fastapi import HTTPException
        db = banded["db"]

        def compare(**kw):
            return demographic_comparison(PID, DemographicComparisonRequest(**kw),
                                          user=_user(db), db=db)

        assert compare(group_by_column_id=BAND)["groups"]   # unscoped: the band forms groups
        # A lead's coder FILTER is not blind: the same scope without the flag keeps it.
        assert compare(group_by_column_id=BAND, coder_ids=BLIND)["groups"]
        with pytest.raises(HTTPException) as exc:
            compare(group_by_column_id=BAND, coder_ids=BLIND, ratings_follow_coder_ids=True)
        assert exc.value.status_code == 409 and "while blind" in exc.value.detail
        with pytest.raises(HTTPException) as exc:
            compare(group_by_subtype="Score group", coder_ids=BLIND, ratings_follow_coder_ids=True)
        assert exc.value.status_code == 409 and exc.value.detail.startswith("“Score group”")
        # An ordinary subtype is untouched while blind.
        assert compare(group_by_subtype="Site", coder_ids=BLIND, ratings_follow_coder_ids=True)["groups"]

    def test_the_comparison_csv_is_refused_too(self, banded):
        from app.routers.code_analysis import demographic_comparison_csv
        from fastapi import HTTPException
        db = banded["db"]
        with pytest.raises(HTTPException) as exc:
            demographic_comparison_csv(PID, group_by_subtype=None, code_ids=None,
                                       conversation_ids=None, text_column_ids=None,
                                       exclude_facilitator=True, participant_ids=None,
                                       coder_ids=str(ALICE), layer_scope=None,
                                       group_by_column_id=BAND, ratings_follow_coder_ids=True,
                                       user=_user(db), db=db)
        assert exc.value.status_code == 409

    def test_the_sources_grouped_by_a_score_group_are_refused(self, banded):
        from app.routers.code_analysis import source_frequencies, source_frequencies_csv
        from app.schemas.code_analysis import SourceFrequenciesRequest
        from fastapi import HTTPException
        db = banded["db"]
        body = dict(group_by_subtype="Score group", coder_ids=BLIND)
        assert source_frequencies(PID, SourceFrequenciesRequest(**body), user=_user(db), db=db)
        with pytest.raises(HTTPException) as exc:
            source_frequencies(PID, SourceFrequenciesRequest(**body, ratings_follow_coder_ids=True),
                               user=_user(db), db=db)
        assert exc.value.status_code == 409
        with pytest.raises(HTTPException) as exc:
            source_frequencies_csv(PID, code_ids=None, conversation_ids=None, text_column_ids=None,
                                   document_ids=None, exclude_facilitator=True, participant_ids=None,
                                   group_by_subtype="Score group", coder_ids=str(ALICE),
                                   layer_scope=None, ratings_follow_coder_ids=True,
                                   user=_user(db), db=db)
        assert exc.value.status_code == 409

    def test_the_filters_leave_a_score_group_out_and_count_it(self, banded):
        from app.routers.code_analysis import demographic_filter_options
        db, ana = banded["db"], banded["ana"]

        def options(coder_ids=None):
            out = _run(demographic_filter_options(PID, user=_user(db), db=db, coder_ids=coder_ids))
            return {f["subtype"]: f for f in out["filters"]}, out

        full, full_out = options()
        # The leak, unscoped: the filter names who is in the colleague-informed band.
        (high,) = [v for v in full["Score group"]["values"] if v["value"] == "high"]
        assert high["participant_ids"] == [ana.id]
        assert full_out["withheld_rating_filters"] == 0
        scoped, scoped_out = options(str(ALICE))
        assert "Score group" not in scoped and "Site" in scoped
        assert scoped_out["withheld_rating_filters"] == 1


class TestTheGateIsAskedEverywhere:
    """Fail closed: the two grouping gates take the blind scope as a REQUIRED keyword (the
    D197 shape), so a new caller cannot forget it; and every ROUTE that groups or filters
    participants by a column decides it (a source scan with a population floor)."""

    def test_the_gates_have_no_default(self):
        import inspect
        from app.services import code_analysis
        for fn in (code_analysis.grouping_column, code_analysis._build_participant_group_map,
                   code_analysis.get_demographic_filter_options):
            p = inspect.signature(fn).parameters["blind_scope"]
            assert p.kind is inspect.Parameter.KEYWORD_ONLY and p.default is inspect.Parameter.empty, fn

    def test_every_route_that_groups_passes_a_blind_scope(self):
        import ast
        from tests.guard_support import app_files  # the population floor + tree identity (#730)
        names = {"get_source_frequencies", "get_demographic_comparison",
                 "get_demographic_filter_options", "grouping_column"}
        seen = []
        for path in app_files("routers", floor=30, recursive=False,
                              sentinels=("routers/code_analysis.py", "routers/joint_display.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.Call) and getattr(node.func, "id", None) in names:
                    seen.append((path.name, node.func.id, node.lineno,
                                 any(k.arg == "blind_scope" for k in node.keywords)))
        assert len(seen) >= 6, f"population floor: the scan must find the grouping routes ({seen})"
        missing = [s for s in seen if not s[3]]
        assert not missing, f"a route groups or filters by a column without a blind scope: {missing}"
