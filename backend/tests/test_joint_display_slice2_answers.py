"""Joint display slice 2 (r4) — open-text ANSWERS as a code strand's material and as quotes.

The rules under test (the review's r4-1 … r4-3):

- **r4-1 — one door, `joint_display.code_strand_answer_columns`:** the open-text columns a
  code strand counts are the ones the display NAMES; no list and an empty list are both
  NONE (the gather reads ``None`` as every open-text column, so a slice-1 display must
  never reach it with ``None``). The counts and the pin suggestions read the SAME columns
  (D209: a suggestion is a passage the numbers count), substantive answers only (#519:
  an "N/A" somebody coded is neither material nor a suggestion), under the counts' coder
  scope (D175).
- **r4-2 — a pin of an answer is the WHOLE answer**, through `POST …/excerpts/whole-passage`
  (it already takes ``dataset_value_id``); the pin stays exactly an excerpt-embed's
  attributes with ``conversationId`` and ``observationId`` null, so no new stored key.
- **r4-3 — its attribution is derived (D163.4)**: `pin_facts` learns the answer arm (the
  row's participant, "Dataset › Column", no speaker) — before, an answer's quote was absent.

The shared fixture is `test_joint_display.py`'s (`fx`), extended here with answers.
"""
from __future__ import annotations

import json

import pytest

from app.models.canvas import Canvas, CanvasTheme
from app.models.code_application import CodeApplication
from app.models.dataset import ColumnType, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.participant import Participant
from app.models.user import User
from app.routers.joint_display import passages as passages_endpoint
from app.schemas import joint_display as wire  # read at call time, so base collects
from app.schemas.joint_display import JointDisplayComputeRequest, JointDisplayPassagesRequest
from app.services import joint_display as jd
from app.services import joint_display_node as node
from app.services import joint_display_pins as pins
from app.services.canvas import update_theme_content
from tests.test_joint_display import (  # noqa: F401 — `fx` is the fixture
    COLLEAGUE, FREE, GROUP, ME, PID, PLAN, RESP, ROLE, SCHOOL, SURVEY, _cells, _col, _display,
    _roster, _row, fx,
)

FREE2 = 16515  # a second open-text question, named only where a test names it


def _answer(fx, participant_id, column, text, codes=()) -> int:
    """An answer in the survey (the participant's row there is made if missing)."""
    db = fx.db
    row = db.query(DatasetRow).filter_by(dataset_id=SURVEY, participant_id=participant_id).first()
    if row is None:
        row = DatasetRow(id=100 + participant_id, dataset_id=SURVEY,
                         row_identifier=f"S{participant_id}", participant_id=participant_id)
        db.add(row)
        db.flush()
    value = DatasetValue(row_id=row.id, column_id=column, value_text=text,
                         word_count=len(text.split()))
    db.add(value)
    db.flush()
    for code, coder in codes:
        db.add(CodeApplication(dataset_value_id=value.id, code_id=code, user_id=coder))
    db.flush()
    return value.id


@pytest.fixture
def ax(fx):
    """`fx` plus answers that make each rule discriminate.

    - T10 (High) has NO turn and NO document — an answer is their only material;
    - T11 (Low) has only an "N/A" answer, coded: a non-answer is neither material nor a quote;
    - T7 (Low) already answered "Long answer" in `fx`; a colleague codes it here;
    - T1 (High) answers the SECOND question, coded — reached only when that column is named.
    """
    fx.db.add(_col(FREE2, SURVEY, "Other comments", ColumnType.OPEN_TEXT, 4))
    fx.db.flush()
    fx.person(10, _roster("High", 0.95, school="B"), None)
    fx.person(11, _roster("Low", 0.02, school="C"), None)
    fx.t10 = _answer(fx, 10, FREE, "Friday afternoons are protected for planning", [(PLAN, ME)])
    fx.t11 = _answer(fx, 11, FREE, "N/A", [(PLAN, ME)])
    seven = fx.db.query(DatasetValue.id).filter_by(column_id=FREE, row_id=107).scalar()
    fx.db.add(CodeApplication(dataset_value_id=seven, code_id=RESP, user_id=COLLEAGUE))
    fx.db.flush()
    fx.t7 = seven
    fx.t1b = _answer(fx, 1, FREE2, "We plan together", [(PLAN, ME)])
    return fx


def _passages(fx, group, code, **kw):
    for key, value in (("conversation_ids", None), ("document_ids", None), ("coder_ids", None),
                       ("layer_scope", None), ("chips_follow_coder_ids", False),
                       ("limit", 50), ("offset", 0)):
        kw.setdefault(key, value)
    result = pins.group_passages(fx.db, PID, group_by_column_id=GROUP, group=group,
                                 code_id=code, **kw)
    wire.JointDisplayPassagesResponse.model_validate(result)  # a valid wire payload (extra=forbid)
    return result


class TestTheOneDoor:
    """r4-1: `code_strand_answer_columns` — the display's list → the gather's."""

    def test_no_list_and_an_empty_list_are_both_none_never_every(self, ax):
        assert jd.code_strand_answer_columns(ax.db, PID, None) == ([], [])
        assert jd.code_strand_answer_columns(ax.db, PID, []) == ([], [])

    def test_keeps_this_projects_open_text_columns_and_names_the_rest_missing(self, ax):
        cols, missing = jd.code_strand_answer_columns(ax.db, PID, [FREE2, FREE, ROLE, 999_999])
        assert cols == sorted([FREE, FREE2])
        assert missing == [ROLE, 999_999]  # a nominal column is not an answer; a gone id


class TestACodesStrandNeverPoolsAnswers:
    """R7 (the combine): r4's first prototype POOLED answers into the code strand; after L3
    that stub is NOT taken. A ``codes`` strand counts its conversations and documents only —
    even one naming open-text columns (the key is reserved on every kind, r1-6) — and
    answers count only on a ``text_codes`` strand of their own, over who answered."""

    def test_a_codes_strand_naming_columns_counts_as_one_naming_none(self, ax):
        S, B = jd.StrandRequest, jd.BindingRequest
        rows = [jd.RowRequest(key="r1", bindings={"i": B(code_ids=(PLAN,))})]
        named = _display(ax, rows, strands=[S("i", "codes", text_column_ids=(FREE,))])
        plain = _display(ax, [_row(codes=[PLAN])])
        high = _cells(named["rows"][0]["by_strand"]["i"]["codes"][0])["High"]
        assert (high["count"], high["n"]) == (3, 4), "T10's only material is an answer: not counted"
        assert named["rows"][0]["codes"] == plain["rows"][0]["codes"]

    def test_the_answers_count_on_their_own_strand(self, ax):
        S, B = jd.StrandRequest, jd.BindingRequest
        rows = [jd.RowRequest(key="r1", bindings={"t": B(code_ids=(PLAN,))})]
        out = _display(ax, rows, strands=[S("t", "text_codes", text_column_ids=(FREE,))])
        cells = _cells(out["rows"][0]["by_strand"]["t"]["codes"][0])
        # High: T10 answered FREE, coded PLAN. Low: T7 answered (coded RESP, not PLAN); T11's
        # coded "N/A" is not an answer (#519), so it is in neither number.
        assert {g: (c["count"], c["n"]) for g, c in cells.items()} == {"High": (1, 1), "Low": (0, 1)}

    def test_the_compute_request_has_no_display_level_answer_list(self):
        assert "text_column_ids" not in JointDisplayComputeRequest.model_fields


class TestTheSuggestionsIncludeAnswers:
    def test_a_groups_coded_answers_in_the_named_columns_only(self, ax):
        r = _passages(ax, "High", PLAN, text_column_ids=[FREE])
        assert [a["dataset_value_id"] for a in r["answers"]] == [ax.t10]
        (a,) = r["answers"]
        assert a["text"] == "Friday afternoons are protected for planning"
        assert a["source_name"] == "Survey › Comments"
        assert a["participant_id"] == 10 and a["is_quoted"] is False
        assert r["answer_total"] == 1
        assert r["total_segments"] == r["conversation_total"] + r["document_total"] + 1
        both = _passages(ax, "High", PLAN, text_column_ids=[FREE, FREE2])
        assert sorted(a["dataset_value_id"] for a in both["answers"]) == sorted([ax.t10, ax.t1b])
        # The group's OWN answers: Low's T7 answer carries RESP; High has none.
        assert _passages(ax, "High", RESP, text_column_ids=[FREE])["answers"] == []

    def test_none_named_lists_no_answer_and_the_passages_are_unchanged(self, ax):
        """Positive control: the slice-1 request (no list) reads exactly as before."""
        r = _passages(ax, "High", PLAN)
        assert r["answers"] == [] and r["answer_total"] == 0
        assert r["total_segments"] == 3

    def test_an_answer_the_project_treats_as_empty_is_never_suggested(self, ax):
        r = _passages(ax, "Low", PLAN, text_column_ids=[FREE])
        assert ax.t11 not in [a["dataset_value_id"] for a in r["answers"]]
        assert r["answer_total"] == 0

    def test_the_coder_scope_is_the_counts(self, ax):
        every = _passages(ax, "Low", RESP, text_column_ids=[FREE])
        assert [a["dataset_value_id"] for a in every["answers"]] == [ax.t7]
        mine = _passages(ax, "Low", RESP, text_column_ids=[FREE], coder_ids=[ME])
        assert mine["answers"] == [] and mine["answer_total"] == 0

    def test_answers_are_listed_when_the_display_names_no_conversation_or_document(self, ax):
        """The early exit (nobody a source links) still carries the answers."""
        r = _passages(ax, "High", PLAN, text_column_ids=[FREE],
                      conversation_ids=[], document_ids=[])
        assert r["conversation_total"] == 0 and r["document_total"] == 0
        assert [a["dataset_value_id"] for a in r["answers"]] == [ax.t10]
        assert r["total_segments"] == 1

    def test_paging_and_the_quoted_mark(self, ax):
        first = _passages(ax, "High", PLAN, text_column_ids=[FREE, FREE2], limit=1)
        assert len(first["answers"]) == 1 and first["answer_total"] == 2
        assert first["has_more"] is True
        ax.db.add(Excerpt(project_id=PID, dataset_value_id=ax.t10))
        ax.db.flush()
        r = _passages(ax, "High", PLAN, text_column_ids=[FREE])
        assert r["answers"][0]["is_quoted"] is True

    def test_an_answer_names_its_whole_quote_by_id(self, ax):
        """#1704 (b) (D384): the picker's "pinned here" — an answer's whole quote, by id."""
        assert _passages(ax, "High", PLAN, text_column_ids=[FREE])["answer_quote_ids"] == {}
        quote = Excerpt(project_id=PID, dataset_value_id=ax.t10)
        ax.db.add(quote)
        ax.db.flush()
        assert _passages(ax, "High", PLAN, text_column_ids=[FREE])["answer_quote_ids"] == {ax.t10: quote.id}

    def test_the_endpoint_answers_with_the_answers(self, ax):
        body = JointDisplayPassagesRequest(group_by_column_id=GROUP, group="High", code_id=PLAN,
                                           text_column_ids=[FREE])
        r = passages_endpoint(PID, body, user=ax.db.get(User, ME), db=ax.db)
        assert [a["dataset_value_id"] for a in r["answers"]] == [ax.t10]
        assert JointDisplayPassagesRequest(group_by_column_id=GROUP, group="High",
                                           code_id=PLAN).text_column_ids == []


class TestTheAttributionOfAnAnswer:
    def test_is_its_rows_participant_and_its_question_with_no_speaker(self, ax):
        quote = Excerpt(project_id=PID, dataset_value_id=ax.t10)
        ax.db.add(quote)
        ax.db.flush()
        [fact] = pins.pin_facts(ax.db, PID, excerpt_ids=[quote.id], column_id=SCHOOL,
                                coder_ids=None)
        assert fact == {"excerpt_id": quote.id, "participant_id": 10,
                        "participant_identifier": "T10", "speaker_label": None,
                        "source_name": "Survey › Comments", "column_value": "B",
                        # R8 (r4-4): said to be a survey answer — the attribution's label.
                        "source_kind": pins.PIN_SOURCE_ANSWER}

    def test_the_source_kind_rides_the_wire(self, ax):
        """R8: `source_kind` is declared on the response (the suite's schemas forbid extras)
        and a turn is never read as an answer beside it."""
        from app.schemas.joint_display import JointDisplayPinFactsResponse
        quote = Excerpt(project_id=PID, dataset_value_id=ax.t10)
        ax.db.add(quote)
        ax.db.flush()
        facts = pins.pin_facts(ax.db, PID, excerpt_ids=[quote.id], column_id=None, coder_ids=None)
        wire_facts = JointDisplayPinFactsResponse.model_validate({"pins": facts}).pins
        assert [f.source_kind for f in wire_facts] == [pins.PIN_SOURCE_ANSWER]

    def test_another_projects_answer_quote_is_absent(self, ax):
        quote = Excerpt(project_id=PID, dataset_value_id=ax.t10)
        ax.db.add(quote)
        ax.db.flush()
        assert pins.pin_facts(ax.db, PID + 1, excerpt_ids=[quote.id], column_id=None,
                              coder_ids=None) == []


class TestTheStoredShape:
    def test_a_strands_list_is_remapped_and_an_unresolved_id_is_null(self):
        """R7: the answer columns live on a STRAND (r1-6's reserved key), never display level."""
        display = {"strands": [{"key": "t", "kind": "text_codes", "text_column_ids": [FREE, 4242]}],
                   "rows": []}
        node.remap_display(display, lambda table, old: {("dataset_columns", FREE): 7}.get((table, old)))
        assert display["strands"][0]["text_column_ids"] == [7, None]

    def test_a_pin_of_an_answer_needs_no_new_key(self):
        """r4-2: an answer's pin is an excerpt-embed with no conversation and no clip."""
        pin = {"excerptId": 5, "displayText": "x", "sourceContext": "Survey › Comments",
               "conversationId": None, "observationId": None, "group": "High",
               "role": None, "purpose": ""}
        node.remap_display({"rows": [{"pins": [pin]}]},
                           lambda table, old: {("excerpts", 5): 9}.get((table, old)))
        assert pin["excerptId"] == 9


class TestAWithdrawalReachesAnAnswerPin:
    """Evidence, not a change: the scrub's ONE predicate already decides an answer pin
    (`_Judge.theirs`: its quote is among the removed). Passes on base too, by design."""

    def test_their_answer_pinned_in_a_display_is_blanked(self, ax):
        from app.services.withdrawal_redaction import apply_withdrawal
        quote = Excerpt(project_id=PID, dataset_value_id=ax.t10)
        ax.db.add(quote)
        ax.db.flush()
        canvas = Canvas(project_id=PID, name="Main")
        ax.db.add(canvas)
        ax.db.flush()
        theme = CanvasTheme(canvas_id=canvas.id, name="Findings")
        ax.db.add(theme)
        ax.db.flush()
        pin = {"excerptId": quote.id, "displayText": "Friday afternoons are protected for planning",
               "sourceContext": "Survey › Comments", "conversationId": None,
               "observationId": None, "group": "High", "role": "typical", "purpose": ""}
        update_theme_content(ax.db, theme, {"type": "doc", "content": [{
            "type": "joint-display", "attrs": {"displayKey": "k", "figureEpoch": 1,
                                               "display": {"rows": [{"key": "r", "pins": [pin]}]}}}]})
        apply_withdrawal(ax.db, ax.db.get(Participant, 10))
        ax.db.flush()
        ax.db.expire_all()
        content = json.loads(ax.db.get(CanvasTheme, theme.id).content)
        (after,) = content["content"][0]["attrs"]["display"]["rows"][0]["pins"]
        assert after["excerptId"] is None
        assert "Friday" not in after["displayText"]


class TestASeparateAnswerStrand:
    """r4-1 as revised after L3: answers are their OWN strand, with their own denominator."""

    def test_its_n_is_who_answered_beside_who_was_surveyed(self, ax):
        g = jd.answer_strand_gather(ax.db, PID, text_column_ids=[FREE], code_ids=[PLAN, RESP],
                                    coder_ids=None, layer_scope=None)
        assert g.answered == {7, 10}            # T11's "N/A" is no answer (#519)
        assert 1 not in g.answered              # an interviewee who did not answer: not pooled
        assert g.surveyed == {1, 2, 3, 5, 6, 7, 10, 11}   # a record in the survey (#830d)
        assert {(p, c) for p, c, _ in g.person_codes} == {(10, PLAN), (7, RESP)}
        mine = jd.answer_strand_gather(ax.db, PID, text_column_ids=[FREE], code_ids=[PLAN, RESP],
                                       coder_ids=[ME], layer_scope=None)
        assert {(p, c) for p, c, _ in mine.person_codes} == {(10, PLAN)}

    def test_no_column_named_is_an_empty_strand_never_every_answer(self, ax):
        g = jd.answer_strand_gather(ax.db, PID, text_column_ids=None, code_ids=[PLAN],
                                    coder_ids=None, layer_scope=None)
        assert (g.answered, g.surveyed, g.person_codes) == (set(), set(), [])


class TestTheCaseReadTakesTheStrandModel:
    """R10 (the combine): the case read takes the compute's own strands — a ``text_codes``
    strand's facts are "answered / not answered" from r4's gather, and an observation strand
    is never a case column (an observation names no participant, D165)."""

    def _read(self, ax, strands, bindings, rule=None):
        from app.services import joint_display_cases as jdc
        return jdc.read_cases(
            ax.db, PID, group_by_column_id=GROUP, strands=strands,
            bindings={k: jdc.CaseBinding(code_ids=tuple(v)) for k, v in bindings.items()},
            coder_ids=None, layer_scope=None, rule=rule, only="all",
            added_participant_ids=[], removed_participant_ids=[], offset=0, limit=200)

    def test_an_answer_strand_reads_who_answered_and_an_observation_strand_is_no_column(self, ax):
        S = jd.StrandRequest
        out = self._read(ax, [S("i", "codes"), S("t", "text_codes", text_column_ids=(FREE,)),
                              S("o", "observation_codes")],
                         {"i": [PLAN], "t": [PLAN], "o": [PLAN]})
        by_id = {c["participant_id"]: c for c in out["cases"]}
        assert all(set(c["facts"]) == {"i", "t"} for c in out["cases"]), "no observation column"
        t10, t7, t11 = (by_id[p]["facts"]["t"] for p in (10, 7, 11))
        assert (t10["has_material"], t10["codes"][0]["used"]) == (True, True)
        assert (t7["has_material"], t7["codes"][0]["used"]) == (True, False)
        # T11's coded "N/A" is not an answer (#519): no answer, so "used it?" has none.
        assert (t11["has_material"], t11["codes"][0]["used"]) == (False, None)
        assert by_id[10]["facts"]["i"]["has_material"] is False, "T10 has no turn or document"

    def test_a_rule_on_the_answer_strand_selects_by_the_answers(self, ax):
        S = jd.StrandRequest
        out = self._read(ax, [S("t", "text_codes", text_column_ids=(FREE,))], {"t": [PLAN]},
                         rule=[{"kind": "code", "strand_key": "t", "code_id": PLAN,
                                "present": True}])
        assert out["matched"] == 1 and [c["participant_id"] for c in out["cases"]
                                        if c["matches"]] == [10]
