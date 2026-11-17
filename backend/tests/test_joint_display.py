"""The joint display's numbers (D165–D172) — `services/joint_display.py`.

One fixture, built so the rules have something to disagree about:

- the groups come from `Gain group` in a ROSTER dataset, and the survey sits in ANOTHER
  dataset — the join the row-grouped comparison cannot make (#827), made here through
  the participants (D167);
- `Gain group` is DERIVED from `Gain score` (a recode), and `Gain index` is computed from
  `Gain score` too — a sibling, so not derived from the grouping variable (D171's "both
  ways, never sideways");
- one person has turns and no group, one has a non-answer as their group (`N/A`), one
  High member answered no survey and another's hours are a non-answer, so the group
  header, the code n and the survey n all differ (D168.1);
- a facilitator turn linked to a Low participant carries a code it must not count;
- a document linked to a Low participant is that person's only material;
- a colleague's coding and rating sit on a Low participant only, so a coder scope moves
  both a count and a rated cell (D175, D197).
"""
from __future__ import annotations

import json
import math
import subprocess

import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.schemas.joint_display import JointDisplayComputeRequest, JointDisplayComputeResponse
from app.services import comparison_basis as cmp_basis
from app.services import joint_display as jd
from app.services.code_analysis import GroupingColumnError, get_demographic_comparison
from app.services.comparisons import CI_METHOD_HEDGES_OLKIN_D
from app.services.undefined_stats import EMPTY_GROUP, INSUFFICIENT_N, NO_GROUP_VALUES, NO_SEGMENTS
from tests import r_support

PID = 1650
ROSTER, SURVEY, OTHER = 1650, 1651, 1652
GROUP, GAIN, SCHOOL, GRADE, GAIN2 = 16501, 16502, 16503, 16504, 16505
HOURS, CONF, ROLE, FREE = 16511, 16512, 16513, 16514
CONV, DOC = 1650, 1650
PLAN, RESP, NOBODY = 16521, 16522, 16523
ME, COLLEAGUE = 1, 2

HIGH = [1, 2, 3, 4]
LOW = [5, 6, 7]


def _col(cid, ds, name, ctype, order, **kw):
    return DatasetColumn(id=cid, dataset_id=ds, column_code=name, column_name=name,
                         column_text=name, column_type=ctype, sequence_order=order,
                         display_order=order, **kw)


class _Fixture:
    def __init__(self, db):
        self.db = db
        self._seg = 165_000
        db.add(User(id=COLLEAGUE, username="Colleague", password_hash="x", coder_type="human"))
        db.add(Project(id=PID, name="Joint", user_id=ME))
        db.flush()
        db.add_all([Dataset(id=ROSTER, project_id=PID, name="Roster"),
                    Dataset(id=SURVEY, project_id=PID, name="Survey")])
        db.flush()
        db.add_all([
            _col(GAIN, ROSTER, "Gain score", ColumnType.NUMERIC, 0),
            _col(GROUP, ROSTER, "Gain group", ColumnType.NOMINAL, 1,
                 derived_from_column_id=GAIN, derived_via="Band the gains"),
            _col(SCHOOL, ROSTER, "School", ColumnType.NOMINAL, 2),
            _col(GRADE, ROSTER, "Grade", ColumnType.ORDINAL, 3),
            _col(GAIN2, ROSTER, "Gain index", ColumnType.NUMERIC, 4, source="computed",
                 expression="[Gain score] * 2", depends_on_column_ids=json.dumps([GAIN])),
            _col(HOURS, SURVEY, "Training hours", ColumnType.NUMERIC, 0),
            _col(CONF, SURVEY, "Confidence", ColumnType.ORDINAL, 1,
                 missing_values=json.dumps([{"value": "9", "label": "Not sure"}])),
            _col(ROLE, SURVEY, "Role", ColumnType.NOMINAL, 2),
            _col(FREE, SURVEY, "Comments", ColumnType.OPEN_TEXT, 3),
        ])
        db.add(Conversation(id=CONV, project_id=PID, name="Focus group"))
        db.flush()
        db.add_all([
            Code(id=PLAN, project_id=PID, numeric_id=1, name="Planning time",
                 is_universal=False, is_active=True),
            Code(id=RESP, project_id=PID, numeric_id=2, name="Student response",
                 is_universal=False, is_active=True,
                 magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0),
            Code(id=NOBODY, project_id=PID, numeric_id=3, name="Nobody",
                 is_universal=False, is_active=True),
        ])
        db.flush()

    def person(self, pid, roster: dict, survey: dict | None):
        db = self.db
        db.add(Participant(id=pid, project_id=PID, identifier=f"T{pid}"))
        db.flush()
        db.add(DatasetRow(id=pid, dataset_id=ROSTER, row_identifier=f"T{pid}", participant_id=pid))
        if survey is not None:
            db.add(DatasetRow(id=100 + pid, dataset_id=SURVEY, row_identifier=f"S{pid}",
                              participant_id=pid))
        db.flush()
        for col, (text, number) in roster.items():
            db.add(DatasetValue(row_id=pid, column_id=col, value_text=text, value_numeric=number))
        for col, (text, number) in (survey or {}).items():
            db.add(DatasetValue(row_id=100 + pid, column_id=col, value_text=text,
                                value_numeric=number))
        db.flush()

    def speaker(self, sid, participant_id, facilitator=False):
        self.db.add(Speaker(id=sid, project_id=PID, name=f"S{sid}",
                            is_facilitator=1 if facilitator else 0, color_index=0,
                            participant_id=participant_id))
        self.db.flush()

    def turn(self, speaker_id, codes=(), document_id=None):
        """``codes``: (code, coder, rating | None) for each application on the turn."""
        self._seg += 1
        if document_id is None:
            seg = Segment(id=self._seg, conversation_id=CONV, sequence_order=self._seg,
                          text="t", word_count=1, speaker_id=speaker_id)
        else:
            seg = Segment(id=self._seg, document_id=document_id, sequence_order=self._seg,
                          text="p", word_count=1)
        self.db.add(seg)
        self.db.flush()
        for code, coder, rating in codes:
            self.db.add(CodeApplication(segment_id=seg.id, code_id=code, user_id=coder,
                                        magnitude=rating))
        self.db.flush()


def _roster(group, gain, school="A", grade=None):
    out = {GAIN: (str(gain), float(gain)), SCHOOL: (school, None)}
    if group is not None:
        out[GROUP] = (group, None)
    if grade is not None:
        out[GRADE] = (str(grade), float(grade))
    return out


@pytest.fixture
def fx(db_session):
    f = _Fixture(db_session)
    survey = {
        1: {HOURS: ("10", 10.0), CONF: ("4", 4.0), ROLE: ("Teacher", None)},
        2: {HOURS: ("12", 12.0), CONF: ("5", 5.0), ROLE: ("Teacher", None)},
        3: {HOURS: ("N/A", None), CONF: ("4", 4.0), ROLE: ("N/A", None)},
        5: {HOURS: ("4", 4.0), CONF: ("2", 2.0), ROLE: ("Coach", None)},
        # A DECLARED non-answer whose number is stored — only the column's rule drops it.
        6: {HOURS: ("6", 6.0), CONF: ("9", 9.0), ROLE: ("Teacher", None)},
        7: {HOURS: ("5", 5.0), CONF: ("3", 3.0), ROLE: ("Coach", None),
            FREE: ("Long answer", None)},
    }
    for pid in HIGH:
        f.person(pid, _roster("High", 0.8 + pid / 10, school="A" if pid < 3 else "B"),
                 survey.get(pid))
    for pid in LOW:
        f.person(pid, _roster("Low", 0.1 * pid / 10, school="C"), survey.get(pid))
    f.person(8, _roster(None, 0.5), None)          # turns, no group
    f.person(9, _roster("N/A", 0.5), None)         # a non-answer is not a group
    for pid in (1, 2, 3, 4, 5, 7, 8):
        f.speaker(pid, pid)
    # A facilitator linked to a Low person who never used Planning time themself: were
    # the facilitator's turn counted, Low's count would move.
    f.speaker(50, 7, facilitator=True)
    f.turn(1, [(PLAN, ME, None), (RESP, ME, 4.0)])
    f.turn(1, [(RESP, ME, 2.0)])
    f.turn(2, [(PLAN, ME, None), (RESP, ME, 5.0)])
    f.turn(3, [(PLAN, ME, None)])
    f.turn(4, [])
    f.turn(5, [(PLAN, ME, None), (RESP, ME, 1.0)])
    f.turn(7, [(RESP, COLLEAGUE, 5.0)])           # the colleague's only work
    f.turn(8, [(PLAN, ME, None)])                 # no group
    f.turn(50, [(PLAN, ME, None)])                # the facilitator's turn: never counted
    f.db.add(Document(id=DOC, project_id=PID, name="Journal", source_filename="j.txt",
                      source_format="txt", participant_id=6))
    f.db.flush()
    f.turn(None, [(RESP, ME, 3.0)], document_id=DOC)
    return f


def _display(fx, rows, **kw):
    kw.setdefault("group_by_column_id", GROUP)
    kw.setdefault("conversation_ids", None)
    kw.setdefault("document_ids", None)
    kw.setdefault("coder_ids", None)
    kw.setdefault("layer_scope", None)
    kw.setdefault("newcombe", False)
    result = jd.compute_joint_display(fx.db, PID, rows=rows, **kw)
    # Every answer must also be a valid wire payload (the suite's schemas forbid extras).
    JointDisplayComputeResponse.model_validate(result)
    return result


def _row(key="r1", codes=(), columns=(), **kw):
    return jd.RowRequest(key=key, code_ids=tuple(codes), column_ids=tuple(columns), **kw)


def _cells(strand):
    return {c["group"]: c for c in strand["cells"]}


class TestTheGroups:
    def test_named_by_the_column_with_their_sizes_and_the_non_answer_left_out(self, fx):
        r = _display(fx, [])
        # #1626 (D243): the code strand's denominator and its no-coding count ride each
        # group — None here, where the display binds no code (no strand to describe).
        assert r["groups"] == [
            {"key": "High", "participants": 4, "with_material": None, "without_coding": None},
            {"key": "Low", "participants": 3, "with_material": None, "without_coding": None}]
        assert r["group_by"] == {"column_id": GROUP, "name": "Gain group",
                                 "dataset_id": ROSTER, "dataset_name": "Roster"}
        assert r["unit"] == jd.UNIT_PARTICIPANTS and r["unavailable_reason"] is None

    def test_numeric_labels_order_numerically(self, fx):
        """#406 — the multi-digit case: 9 before 10, never "10" before "9"."""
        for pid, grade in ((1, 9), (2, 10), (5, 10)):
            fx.db.add(DatasetValue(row_id=pid, column_id=GRADE, value_text=str(grade),
                                   value_numeric=float(grade)))
        fx.db.flush()
        r = _display(fx, [], group_by_column_id=GRADE)
        assert [g["key"] for g in r["groups"]] == ["9", "10"]

    def test_a_column_with_no_values_says_why(self, fx):
        fx.db.add(Dataset(id=OTHER, project_id=PID, name="Empty"))
        fx.db.add(_col(16599, OTHER, "Nothing", ColumnType.NOMINAL, 0))
        fx.db.flush()
        r = _display(fx, [_row(codes=[PLAN])], group_by_column_id=16599)
        assert r["groups"] == [] and r["unavailable_reason"] == NO_GROUP_VALUES

    def test_a_continuous_variable_is_refused(self, fx):
        with pytest.raises(GroupingColumnError) as exc:
            _display(fx, [], group_by_column_id=HOURS)
        assert exc.value.status_code == 400

    def test_another_projects_column_is_not_found(self, fx):
        fx.db.add(Project(id=PID + 1, name="Other", user_id=ME))
        fx.db.add(Dataset(id=OTHER, project_id=PID + 1, name="Theirs"))
        fx.db.add(_col(16598, OTHER, "Group", ColumnType.NOMINAL, 0))
        fx.db.flush()
        with pytest.raises(GroupingColumnError) as exc:
            _display(fx, [], group_by_column_id=16598)
        assert exc.value.status_code == 404


class TestTheCodeStrand:
    def test_counts_participants_with_material_and_never_the_facilitators_turn(self, fx):
        (row,) = _display(fx, [_row(codes=[PLAN])])["rows"]
        (plan,) = row["codes"]
        cells = _cells(plan)
        # High: 1, 2, 3 used it of 1–4 (each has a turn); Low: 5 of 5, 6 (the journal) and
        # 7 — the facilitator turn linked to 7 adds nothing, 8 has no group.
        assert (cells["High"]["count"], cells["High"]["n"]) == (3, 4)
        assert (cells["Low"]["count"], cells["Low"]["n"]) == (1, 3)
        assert cells["High"]["share"] == 0.75 and cells["Low"]["share"] == 0.3333
        assert plan["difference"]["value"] == round(0.75 - 0.3333, 4)
        assert plan["difference"]["ci_method"] is None, "D172: no interval unless asked"
        assert plan["unit"] == jd.UNIT_PARTICIPANTS

    def test_equals_the_code_by_group_comparison_on_the_same_question(self, fx):
        """D167/D168 read the comparison's own gather — the two must never disagree."""
        rows = _display(fx, [_row(codes=[PLAN, RESP, NOBODY])], newcombe=True)["rows"]
        cmp = get_demographic_comparison(
            fx.db, PID, group_by_column_id=GROUP, code_ids=[PLAN, RESP, NOBODY],
            text_column_ids=[])
        by_code = {e["code_id"]: e for e in cmp["codes"]}
        assert cmp["groups"] == ["High", "Low"]
        for strand in rows[0]["codes"]:
            entry = by_code[strand["code_id"]]
            for cell in strand["cells"]:
                theirs = entry["by_group"][cell["group"]]
                assert (cell["count"], cell["share"], cell["passages"]) == (
                    theirs["count"], theirs["proportion"], theirs["passages"])
                assert cell["n"] == cmp["group_totals"][cell["group"]]["n"]
            assert strand["difference"]["value"] == entry["delta_proportion"]
            assert strand["difference"]["ci_lower"] == entry["delta_ci"]["lower"]
            assert strand["difference"]["ci_upper"] == entry["delta_ci"]["upper"]
            assert strand["difference"]["ci_method"] == cmp_basis.CI_METHOD_NEWCOMBE_HYBRID

    def test_a_source_selection_narrows_the_material(self, fx):
        (row,) = _display(fx, [_row(codes=[RESP])], conversation_ids=[], document_ids=[DOC])["rows"]
        cells = _cells(row["codes"][0])
        # Only the journal: participant 6 alone has material.
        assert (cells["High"]["n"], cells["Low"]["n"]) == (0, 1)
        assert cells["High"]["share"] is None
        assert cells["High"]["share_undefined_reason"] == NO_SEGMENTS
        assert row["codes"][0]["difference"]["unavailable_reason"] == NO_SEGMENTS

    def test_the_coder_scope_reaches_the_counts(self, fx):
        """D175 — the colleague's coding on participant 7 leaves under the viewer's scope."""
        everyone = _cells(_display(fx, [_row(codes=[RESP])])["rows"][0]["codes"][0])
        mine = _cells(_display(fx, [_row(codes=[RESP])], coder_ids=[ME])["rows"][0]["codes"][0])
        assert everyone["Low"]["count"] == 3  # 5, 6 (journal), 7 (the colleague's)
        assert mine["Low"]["count"] == 2


class TestRatedCells:
    def test_the_mean_of_the_groups_participant_scores(self, fx):
        (row,) = _display(fx, [_row(codes=[RESP])])["rows"]
        strand = row["codes"][0]
        assert strand["rated"] is True
        cells = _cells(strand)
        # High: 1 → (4 + 2) / 2 = 3, 2 → 5; Low: 5 → 1, 6 → 3 (journal), 7 → 5 (colleague).
        assert cells["High"]["rating"] == {"mean": 4.0, "n": 2, "undefined_reason": None}
        assert cells["Low"]["rating"] == {"mean": 3.0, "n": 3, "undefined_reason": None}
        rating = _display(fx, [_row(codes=[RESP])])["rating"]
        assert rating["basis"] == jd.RATING_CELL_BASIS_MEAN_OF_PARTICIPANT_SCORES
        assert rating["scope"] == jd.RATING_SCOPE_PROJECT

    def test_the_viewers_scope_reaches_the_ratings_too(self, fx):
        """D197 — the rollup takes the same coder_ids as the counts."""
        (row,) = _display(fx, [_row(codes=[RESP])], coder_ids=[ME])["rows"]
        assert _cells(row["codes"][0])["Low"]["rating"] == {
            "mean": 2.0, "n": 2, "undefined_reason": None}

    def test_the_disclosure_is_about_the_displays_rated_codes(self, fx):
        """D168 (a) — the rollup is NARROWED to the display's rated codes, so what it
        left out is said for THEM: the facilitator's rating of another scaled code is no
        fact about this display, and before the narrowing it was counted here."""
        fx.db.add(Code(id=16524, project_id=PID, numeric_id=4, name="Pacing",
                       is_universal=False, is_active=True,
                       magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0))
        fx.db.flush()
        fx.turn(50, [(RESP, ME, 4.0), (16524, ME, 3.0)])   # the facilitator's turn, both rated
        r = _display(fx, [_row(codes=[RESP])])
        assert r["rating"]["excluded_ratings"] == {"facilitator_turn": 1}
        # …and the cells are unmoved: a facilitator's rating never reaches a score.
        assert _cells(r["rows"][0]["codes"][0])["Low"]["rating"] == {
            "mean": 3.0, "n": 3, "undefined_reason": None}

    def test_an_unrated_code_has_no_rating_cell(self, fx):
        (row,) = _display(fx, [_row(codes=[PLAN])])["rows"]
        assert row["codes"][0]["rated"] is False
        assert all(c["rating"] is None for c in row["codes"][0]["cells"])
        assert _display(fx, [_row(codes=[PLAN])])["rating"] is None

    def test_the_machine_layer_has_no_scores_to_show(self, fx):
        r = _display(fx, [_row(codes=[RESP])], layer_scope="machine")
        assert r["rating"]["unavailable_reason"] == jd.RATING_NOT_ON_MACHINE_LAYER
        assert {c["rating"]["undefined_reason"] for c in r["rows"][0]["codes"][0]["cells"]} == {
            jd.RATING_NOT_ON_MACHINE_LAYER}


class TestTheSurveyStrand:
    def test_joins_through_the_participants_across_datasets(self, fx):
        (row,) = _display(fx, [_row(columns=[HOURS])])["rows"]
        (hours,) = row["variables"]
        assert hours["dataset_id"] == SURVEY and hours["summary"] == jd.SUMMARY_MEAN
        cells = _cells(hours)
        # High: 10, 12 (3's "N/A" is a non-answer, 4 answered no survey); Low: 4, 6, 5.
        assert (cells["High"]["n"], cells["High"]["mean"]) == (2, 11.0)
        assert cells["High"]["sd"] == round(math.sqrt(2), 4)
        assert (cells["Low"]["n"], cells["Low"]["mean"], cells["Low"]["sd"]) == (3, 5.0, 1.0)
        sp = math.sqrt((1 * 2 + 2 * 1) / 3)
        effect = hours["effect"]
        assert effect["d"] == round((11 - 5) / sp, 4)
        assert effect["ci_method"] == CI_METHOD_HEDGES_OLKIN_D
        assert effect["ci_lower"] < effect["d"] < effect["ci_upper"]

    def test_a_categorical_variable_is_a_distribution_and_carries_no_effect(self, fx):
        (row,) = _display(fx, [_row(columns=[ROLE])])["rows"]
        (role,) = row["variables"]
        assert role["summary"] == jd.SUMMARY_DISTRIBUTION
        assert role["categories"] == ["Coach", "Teacher"]
        cells = _cells(role)
        # 3's "N/A" is a non-answer by the defaults: no category, and not in the n.
        assert [(d["label"], d["count"]) for d in cells["High"]["distribution"]] == [
            ("Coach", 0), ("Teacher", 2)]
        assert cells["High"]["n"] == 2
        assert [(d["label"], d["count"]) for d in cells["Low"]["distribution"]] == [
            ("Coach", 2), ("Teacher", 1)]
        assert cells["Low"]["distribution"][0]["share"] == round(2 / 3, 4)
        assert role["effect"] is None

    def test_an_ordinal_variable_is_a_mean_and_a_declared_non_answer_leaves_it(self, fx):
        (row,) = _display(fx, [_row(columns=[CONF])])["rows"]
        (conf,) = row["variables"]
        assert conf["summary"] == jd.SUMMARY_MEAN
        cells = _cells(conf)
        # High 4, 5, 4; Low 2 and 3 — 6's "9" is declared missing though its number is stored.
        assert (cells["High"]["n"], cells["High"]["mean"]) == (3, round(13 / 3, 4))
        assert (cells["Low"]["n"], cells["Low"]["mean"]) == (2, 2.5)

    def test_one_value_has_no_sd_and_the_effect_says_why(self, fx):
        fx.db.query(DatasetValue).filter(DatasetValue.column_id == HOURS,
                                         DatasetValue.row_id == 102).delete()
        fx.db.flush()
        (row,) = _display(fx, [_row(columns=[HOURS])])["rows"]
        cells = _cells(row["variables"][0])
        assert (cells["High"]["n"], cells["High"]["sd"]) == (1, None)
        assert cells["High"]["sd_undefined_reason"] == INSUFFICIENT_N
        assert row["variables"][0]["effect"]["d"] is None
        assert row["variables"][0]["effect"]["unavailable_reason"] == INSUFFICIENT_N

    def test_an_empty_group_says_so(self, fx):
        fx.db.query(DatasetValue).filter(DatasetValue.column_id == HOURS,
                                         DatasetValue.row_id.in_([101, 102])).delete()
        fx.db.flush()
        cells = _cells(_display(fx, [_row(columns=[HOURS])])["rows"][0]["variables"][0])
        assert (cells["High"]["n"], cells["High"]["mean"]) == (0, None)
        assert cells["High"]["mean_undefined_reason"] == EMPTY_GROUP

    def test_free_text_is_not_summarised(self, fx):
        (row,) = _display(fx, [_row(columns=[FREE])])["rows"]
        assert row["variables"][0]["unavailable_reason"] == jd.VARIABLE_NOT_SUMMARISABLE
        assert row["variables"][0]["cells"] == []

    def test_three_groups_carry_no_d(self, fx):
        (row,) = _display(fx, [_row(codes=[PLAN], columns=[HOURS])],
                          group_by_column_id=SCHOOL)["rows"]
        assert row["variables"][0]["effect"]["unavailable_reason"] == jd.EFFECT_NOT_TWO_GROUPS
        assert row["codes"][0]["difference"]["unavailable_reason"] == jd.EFFECT_NOT_TWO_GROUPS


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_d_and_its_interval_against_r(fx):
    """d against R's own pooled t (`t.test(var.equal = TRUE)`): for Cohen's d on the
    pooled SD, d = t·√(1/n₁ + 1/n₂) exactly, so R's t is an independent route to the same
    number (High − Low, R's first group minus its second). The interval is Hedges &
    Olkin's normal approximation evaluated in R from that d.

    ⚠️ Not `psych::cohen.d`: it pools the SD over n, not n − 2 (measured: 6.708 here against
    the d_s of 5.196 — the ratio √(n/(n − 2))), so it is a different statistic."""
    high, low = [10, 12], [4, 6, 5]
    script = f"""
x1 <- c({", ".join(map(str, high))}); x2 <- c({", ".join(map(str, low))})
n1 <- length(x1); n2 <- length(x2)
t <- unname(t.test(x1, x2, var.equal = TRUE)$statistic)
d <- t * sqrt(1 / n1 + 1 / n2)
se <- sqrt((n1 + n2) / (n1 * n2) + d^2 / (2 * (n1 + n2 - 2)))
cat("d", format(d, digits = 15), "\\n")
cat("lower", format(d - qnorm(0.975) * se, digits = 15), "\\n")
cat("upper", format(d + qnorm(0.975) * se, digits = 15), "\\n")
"""
    out = subprocess.run([r_support.RSCRIPT, "--vanilla", "-e", script],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    r = {k: float(v) for k, v in (line.split() for line in out.stdout.splitlines() if line.strip())}
    effect = _display(fx, [_row(columns=[HOURS])])["rows"][0]["variables"][0]["effect"]
    assert effect["d"] == pytest.approx(r["d"], abs=1e-4)
    assert effect["ci_lower"] == pytest.approx(r["lower"], abs=1e-4)
    assert effect["ci_upper"] == pytest.approx(r["upper"], abs=1e-4)
    # The fixture can tell d_s from psych's n-pooled d (the two must differ here).
    assert abs(effect["d"] - r["d"] * math.sqrt(5 / 3)) > 0.5


class TestAStrandThatFormedTheGroups:
    """D171 — labelled, never blocked, and no between-group statistic (D172)."""

    def test_the_grouping_variable_itself(self, fx):
        (row,) = _display(fx, [_row(columns=[GROUP])])["rows"]
        assert row["variables"][0]["formed_groups"] == jd.FORMED_BY_GROUPING_VARIABLE

    def test_what_it_was_derived_from_and_the_descriptives_stay(self, fx):
        (row,) = _display(fx, [_row(columns=[GAIN])])["rows"]
        gain = row["variables"][0]
        assert gain["formed_groups"] == jd.FORMED_BY_DERIVATION
        assert gain["effect"]["d"] is None
        assert gain["effect"]["unavailable_reason"] == jd.EFFECT_FORMED_GROUPS
        assert all(c["mean"] is not None for c in gain["cells"])

    def test_a_sibling_of_the_same_source_is_not_derived_from_it(self, fx):
        for pid in HIGH + LOW:
            fx.db.add(DatasetValue(row_id=pid, column_id=GAIN2, value_text=str(pid),
                                   value_numeric=float(pid)))
        fx.db.flush()
        (row,) = _display(fx, [_row(columns=[GAIN2])])["rows"]
        assert row["variables"][0]["formed_groups"] is None
        assert row["variables"][0]["effect"]["d"] is not None

    def test_a_computed_variable_downstream_of_the_grouping_variable(self, fx):
        fx.db.add(_col(16506, ROSTER, "Group flag", ColumnType.NUMERIC, 5, source="computed",
                       expression="IF([Gain group] == \"High\", 1, 0)",
                       depends_on_column_ids=json.dumps([GROUP])))
        fx.db.flush()
        assert 16506 in jd.related_by_derivation(fx.db, PID, GROUP)

    def test_the_researchers_mark(self, fx):
        (row,) = _display(fx, [_row(codes=[PLAN], columns=[HOURS], codes_marked_formed=True,
                                     variables_marked_formed=True)])["rows"]
        assert row["codes"][0]["formed_groups"] == jd.FORMED_BY_MARK
        assert row["codes"][0]["difference"]["value"] is None
        assert row["codes"][0]["difference"]["unavailable_reason"] == jd.EFFECT_FORMED_GROUPS
        assert row["variables"][0]["formed_groups"] == jd.FORMED_BY_MARK
        assert row["variables"][0]["effect"]["unavailable_reason"] == jd.EFFECT_FORMED_GROUPS


class TestWhatARowBinds:
    def test_a_row_that_binds_nothing_from_a_strand_is_not_measured(self, fx):
        """D169 — "not measured" is a fact the APP states, from the bindings."""
        rows = _display(fx, [_row("a", codes=[PLAN]), _row("b", columns=[HOURS])])["rows"]
        assert rows[0]["strands"] == {"codes": jd.STRAND_COVERS,
                                      "variables": jd.STRAND_NOT_MEASURED}
        assert rows[1]["strands"] == {"codes": jd.STRAND_NOT_MEASURED,
                                      "variables": jd.STRAND_COVERS}

    def test_an_id_that_is_not_this_projects_is_named_missing_never_an_error(self, fx):
        fx.db.add(Project(id=PID + 1, name="Other", user_id=ME))
        fx.db.add(Code(id=16590, project_id=PID + 1, numeric_id=1, name="Theirs",
                       is_universal=False, is_active=True))
        fx.db.flush()
        (row,) = _display(fx, [_row(codes=[PLAN, 16590, 999999], columns=[999998])])["rows"]
        assert [c["code_id"] for c in row["codes"]] == [PLAN]
        assert row["missing_code_ids"] == [16590, 999999]
        assert row["missing_column_ids"] == [999998]
        assert row["strands"]["variables"] == jd.STRAND_NOT_MEASURED

    def test_strands_keep_the_order_the_row_names_them(self, fx):
        (row,) = _display(fx, [_row(codes=[RESP, PLAN], columns=[ROLE, HOURS])])["rows"]
        assert [c["code_id"] for c in row["codes"]] == [RESP, PLAN]
        assert [v["column_id"] for v in row["variables"]] == [ROLE, HOURS]


class TestTheEndpoint:
    def test_answers_through_the_router_and_refuses_with_the_reason(self, fx):
        from fastapi import HTTPException
        from app.routers.joint_display import compute
        user = fx.db.get(User, ME)
        body = JointDisplayComputeRequest(group_by_column_id=GROUP,
                                          rows=[{"key": "r", "code_ids": [PLAN]}])
        out = compute(project_id=PID, body=body, user=user, db=fx.db)
        assert out["rows"][0]["codes"][0]["code_id"] == PLAN
        with pytest.raises(HTTPException) as exc:
            compute(project_id=PID, body=JointDisplayComputeRequest(group_by_column_id=HOURS),
                    user=user, db=fx.db)
        assert exc.value.status_code == 400 and "cannot form groups" in exc.value.detail

    def test_a_request_beyond_its_bounds_is_refused(self):
        with pytest.raises(ValueError):
            JointDisplayComputeRequest(group_by_column_id=1,
                                       rows=[{"key": str(i)} for i in range(101)])
        with pytest.raises(ValueError):
            JointDisplayComputeRequest(group_by_column_id=1, layer_scope="everyone")


class TestTheComparisonGroupsByAColumnToo:
    """D166 — the existing comparison may name its groups by column id."""

    def test_by_column_id(self, fx):
        cmp = get_demographic_comparison(fx.db, PID, group_by_column_id=GROUP, code_ids=[PLAN])
        assert cmp["groups"] == ["High", "Low"]

    def test_exactly_one_way_of_naming_the_groups(self, fx):
        with pytest.raises(ValueError):
            get_demographic_comparison(fx.db, PID, code_ids=[PLAN])
        with pytest.raises(ValueError):
            get_demographic_comparison(fx.db, PID, group_by_subtype="gender",
                                       group_by_column_id=GROUP, code_ids=[PLAN])

    def test_the_request_schema_holds_the_same_rule(self):
        from app.schemas.code_analysis import DemographicComparisonRequest
        assert DemographicComparisonRequest(group_by_column_id=3).group_by_subtype is None
        with pytest.raises(ValueError):
            DemographicComparisonRequest()
        with pytest.raises(ValueError):
            DemographicComparisonRequest(group_by_subtype="role", group_by_column_id=3)

    def test_the_csv_door_refuses_neither_and_a_continuous_column(self, fx):
        from fastapi import HTTPException
        from app.routers.code_analysis import demographic_comparison_csv
        user = fx.db.get(User, ME)
        with pytest.raises(HTTPException) as exc:
            demographic_comparison_csv(project_id=PID, group_by_subtype=None, user=user, db=fx.db)
        assert exc.value.status_code == 400
        with pytest.raises(HTTPException) as exc:
            demographic_comparison_csv(project_id=PID, group_by_subtype=None,
                                       group_by_column_id=HOURS, code_ids=None,
                                       conversation_ids=None, text_column_ids=None,
                                       exclude_facilitator=True, participant_ids=None,
                                       coder_ids=None, layer_scope=None, user=user, db=fx.db)
        assert exc.value.status_code == 400
