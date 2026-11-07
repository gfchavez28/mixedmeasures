"""#1333 + #1334 — what one RELIABILITY UNIT is.

Two decisions (2026-10-31), one question — *what does "Units" count?*

* **#1333 — a facilitator (interviewer) turn is not a unit by default.** Every
  other count in the app leaves facilitator turns out (J-A's participant gauge,
  the analysis frequencies' `exclude_facilitator`, the rating rollup's
  `facilitator_turn`), while the reliability gather counted them — and two coders
  who both leave the interviewer's prompts blank AGREE on every one of them, which
  inflates α with agreement on absence.
* **#1334 — a group of turns counts once.** A `SegmentGroup` exists so adjacent
  turns are coded as ONE unit (`services/segment_groups.py`), and the coding fans
  out to every member; the gather made one unit per MEMBER, so a four-turn group
  was four units of identical (or, after a partial coding, contradictory) data.

Every fixture sits where the old and the new reading DISAGREE (backend/tests/
the internal design notes, "degenerate fixtures"), and each new rule has a control that the old
code also passes, so a failure says which half moved.
"""
import pytest

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.speaker import Speaker
from app.models.user import User
from app.services import reliability_basis as rb
from app.services.irr import _krippendorff_alpha, build_irr_matrices, compute_irr


A, B = 21, 22


def _world(db, pid):
    db.add(Project(id=pid, name="Units", user_id=1))
    db.add_all([
        User(id=A, username="Coder A", password_hash=None, coder_type="human"),
        User(id=B, username="Coder B", password_hash=None, coder_type="human"),
    ])
    db.flush()
    conv = Conversation(id=pid, project_id=pid, name="Interview")
    db.add(conv)
    db.flush()
    person = Participant(project_id=pid, identifier=f"P-{pid}")
    db.add(person)
    db.flush()
    interviewer = Speaker(project_id=pid, name="Interviewer", is_facilitator=1)
    respondent = Speaker(project_id=pid, name="Respondent", participant_id=person.id)
    db.add_all([interviewer, respondent])
    db.flush()
    code = Code(id=pid * 10, project_id=pid, name="Theme X", numeric_id=2,
                is_active=True, is_universal=False)
    db.add(code)
    db.flush()
    return conv, interviewer, respondent, code


def _turn(db, conv, sid, order, speaker=None, group_id=None):
    db.add(Segment(id=sid, conversation_id=conv.id, sequence_order=order,
                   text=f"t{order}", speaker_id=speaker.id if speaker else None,
                   group_id=group_id))
    db.flush()


def _apply(db, code_id, uid, sid, magnitude=None):
    db.add(CodeApplication(code_id=code_id, user_id=uid, segment_id=sid, magnitude=magnitude))
    db.flush()


def _row(payload, code_id):
    return next(c for c in payload["per_code"] if c["code_id"] == code_id)


# ── #1333 — facilitator turns ─────────────────────────────────────────────────


def _interview(db, pid):
    """Eight alternating turns. Both coders leave every interviewer prompt blank
    (the common case the review describes); on the four respondent turns they
    agree twice and disagree twice.

        respondent turns only:     [1,1] [1,0] [0,1] [0,0]   → α 0.125
        + four [0,0] prompts:      … and α 0.375, all of it agreement on absence
    """
    conv, interviewer, respondent, code = _world(db, pid)
    base = pid * 100
    for i in range(8):
        _turn(db, conv, base + i, i, interviewer if i % 2 == 0 else respondent)
    r1, r3, r5 = base + 1, base + 3, base + 5
    _apply(db, code.id, A, r1); _apply(db, code.id, B, r1)
    _apply(db, code.id, A, r3)
    _apply(db, code.id, B, r5)
    return code, base


def test_the_fixture_could_have_disagreed():
    """The discrimination assertion (#707a): the two readings give different α."""
    participant_only = [[1, 1], [1, 0], [0, 1], [0, 0]]
    with_prompts = participant_only + [[0, 0]] * 4
    assert _krippendorff_alpha(participant_only) == pytest.approx(0.125)
    assert _krippendorff_alpha(with_prompts) == pytest.approx(0.375)


def test_facilitator_turns_are_not_units_by_default(db_session):
    code, _ = _interview(db_session, 1301)
    row = _row(compute_irr(db_session, 1301), code.id)
    assert row["n_units"] == 4, "the four respondent turns, not all eight"
    assert row["krippendorff_alpha"] == pytest.approx(0.125)


def test_the_basis_says_what_a_unit_is(db_session):
    _interview(db_session, 1302)
    payload = compute_irr(db_session, 1302)
    assert payload["unit_basis"] == rb.DEFAULT_RELIABILITY_UNIT_BASIS
    assert payload["unit_basis"] == rb.UNIT_BASIS_PARTICIPANT_PASSAGES


def test_the_alternative_reading_is_one_argument_away(db_session):
    """The contestable choice is ISOLATED: the include-facilitator reading is the
    same computation with one argument, and it reports the old number."""
    code, _ = _interview(db_session, 1303)
    payload = compute_irr(db_session, 1303, unit_basis=rb.UNIT_BASIS_ALL_PASSAGES)
    row = _row(payload, code.id)
    assert row["n_units"] == 8
    assert row["krippendorff_alpha"] == pytest.approx(0.375)
    assert payload["unit_basis"] == rb.UNIT_BASIS_ALL_PASSAGES
    assert payload["facilitator_turns_excluded"] is None, "nothing was left out"
    assert payload["facilitator_speakers"] is None
    assert row["facilitator_turns_coded"] is None


def test_an_unknown_basis_fails_closed(db_session):
    _interview(db_session, 1304)
    with pytest.raises(ValueError):
        compute_irr(db_session, 1304, unit_basis="everything")


def test_a_coded_facilitator_turn_leaves_the_figure_but_not_the_grid(db_session):
    """What happens to a facilitator turn a coder DID code: it is still coding —
    it stays in the reconciliation grid (the consensus layer is written there and
    the analysis view can include facilitator turns) — but it is not a unit."""
    from app.services.reconciliation import build_reconciliation

    from app.auth import CODER_TYPE_MACHINE

    code, base = _interview(db_session, 1305)
    _apply(db_session, code.id, A, base + 6)  # A tags an interviewer prompt
    # A MODEL's tag on another prompt is not a coder's: the disclosure counts the
    # people whose figure this is (`reliability_coder_clause`), never a machine.
    db_session.add(User(id=24, username="Model", password_hash=None, coder_type=CODER_TYPE_MACHINE))
    db_session.flush()
    _apply(db_session, code.id, 24, base + 4)
    payload = compute_irr(db_session, 1305)
    row = _row(payload, code.id)
    assert row["n_units"] == 4
    assert row["krippendorff_alpha"] == pytest.approx(0.125), "unchanged by the prompt"
    # …and SAID: four prompts left out, one of them carrying this code.
    assert payload["facilitator_turns_excluded"] == 4
    assert row["facilitator_turns_coded"] == 1

    grid = build_reconciliation(db_session, 1305, limit=100)
    unit_ids = {u["unit_id"] for u in grid["units"]}
    assert base + 6 in unit_ids, "the grid still shows the coded prompt"
    flagged = next(u for u in grid["units"] if u["unit_id"] == base + 6)
    assert flagged["has_disagreement"] is True


def test_a_turn_with_no_speaker_is_a_participant_turn(db_session):
    """J-A's rule, unchanged: an untagged turn counts (`speaker_id IS NULL`)."""
    conv, interviewer, respondent, code = _world(db_session, 1306)
    _turn(db_session, conv, 130601, 0, None)
    _turn(db_session, conv, 130602, 1, respondent)
    _apply(db_session, code.id, A, 130601); _apply(db_session, code.id, B, 130601)
    _apply(db_session, code.id, A, 130602)
    assert _row(compute_irr(db_session, 1306), code.id)["n_units"] == 2


def test_documents_are_unaffected(db_session):
    """CONTROL — documents have no speakers, so the clause is a no-op there and
    this passes before and after the change."""
    db = db_session
    db.add(Project(id=1307, name="Docs", user_id=1))
    db.add_all([
        User(id=A, username="Coder A", password_hash=None, coder_type="human"),
        User(id=B, username="Coder B", password_hash=None, coder_type="human"),
    ])
    db.flush()
    db.add(Document(id=1307, project_id=1307, name="Memo", source_filename="m.docx",
                    source_format="docx"))
    db.flush()
    for i in range(3):
        db.add(Segment(id=130700 + i, document_id=1307, sequence_order=i, text=f"p{i}"))
    db.add(Code(id=13070, project_id=1307, name="X", numeric_id=2, is_active=True, is_universal=False))
    db.flush()
    _apply(db, 13070, A, 130700); _apply(db, 13070, B, 130700)
    _apply(db, 13070, A, 130701)
    assert _row(compute_irr(db, 1307), 13070)["n_units"] == 3


def test_a_coder_whose_only_coding_is_a_prompt_has_not_engaged_the_source(db_session):
    """The engagement half of the decision: Option B reads 'engaged' from the
    codings IN SCOPE, so a coder who tagged only an interviewer prompt is not
    treated as having reviewed the respondent turns (the participant gauge, J-A,
    would show them 0 coded there too)."""
    conv, interviewer, respondent, code = _world(db_session, 1308)
    for i in range(4):
        _turn(db_session, conv, 130800 + i, i, interviewer if i % 2 == 0 else respondent)
    _apply(db_session, code.id, A, 130801)
    _apply(db_session, code.id, B, 130800)  # B's only coding: a prompt
    payload = compute_irr(db_session, 1308)
    assert payload["available"] is False


# ── D18 — who was treated as a facilitator is SAID ────────────────────────────


def test_the_payload_names_the_speakers_left_out(db_session):
    """D18: the exclusion keys on a flag the import sets only for an
    "Interviewer"/"Facilitator" label, so the payload names whose turns it left
    out — and a speaker the flag did NOT catch (a "Moderator") is a unit and is
    not named, which is what lets the researcher see the gap."""
    code, base = _interview(db_session, 1310)
    conv = db_session.get(Conversation, 1310)
    moderator = Speaker(project_id=1310, name="Moderator", is_facilitator=0)
    db_session.add(moderator)
    db_session.flush()
    _turn(db_session, conv, base + 8, 8, moderator)
    payload = compute_irr(db_session, 1310)
    assert payload["facilitator_speakers"] == ["Interviewer"]
    assert _row(payload, code.id)["n_units"] == 5, "the Moderator's turn is a unit"


def test_the_speakers_named_are_only_those_in_scope(db_session):
    """A facilitator in a conversation outside the reported source is not named
    (and its turns are not counted) — the disclosure is about THIS figure. The
    second conversation is a SHARED source, so the pooled figure does name its
    host: without that, scoping and not scoping would give the same answer."""
    code, _ = _interview(db_session, 1311)
    other = Conversation(id=1312, project_id=1311, name="Another")
    db_session.add(other)
    host = Speaker(project_id=1311, name="host", is_facilitator=1)
    respondent = db_session.query(Speaker).filter_by(project_id=1311, name="Respondent").one()
    db_session.add(host)
    db_session.flush()
    _turn(db_session, other, 131200, 0, host)
    _turn(db_session, other, 131201, 1, respondent)
    _apply(db_session, code.id, A, 131201); _apply(db_session, code.id, B, 131201)

    pooled = compute_irr(db_session, 1311)
    assert pooled["facilitator_speakers"] == ["host", "Interviewer"], "sorted case-blind"
    assert pooled["facilitator_turns_excluded"] == 5
    scoped = compute_irr(db_session, 1311, source=("conv", 1311))
    assert scoped["facilitator_speakers"] == ["Interviewer"]
    assert scoped["facilitator_turns_excluded"] == 4


# ── #1334 — a group of turns counts once ──────────────────────────────────────


def _grouped(db, pid, *, b_codes):
    """Six respondent turns; t1–t4 are ONE group. A codes the group (the apply
    fans out to all four members, as `routers/coding.py::apply_code` does) and
    t0. B's codings are the parameter."""
    conv, _interviewer, respondent, code = _world(db, pid)
    group = SegmentGroup(id=pid, conversation_id=conv.id)
    db.add(group)
    db.flush()
    base = pid * 100
    for i in range(6):
        _turn(db, conv, base + i, i, respondent, group_id=pid if 1 <= i <= 4 else None)
    for i in (1, 2, 3, 4):
        _apply(db, code.id, A, base + i)
    _apply(db, code.id, A, base + 0)
    for i in b_codes:
        _apply(db, code.id, B, base + i)
    return code, base


def test_a_group_is_one_unit(db_session):
    """Both coders code the group as a group: per turn the four identical rows
    count four times (α 0.593); collapsed, once (α 0.444)."""
    code, _ = _grouped(db_session, 1341, b_codes=(1, 2, 3, 4))
    row = _row(compute_irr(db_session, 1341), code.id)
    assert row["n_units"] == 3, "t0, the group, t5"
    assert row["krippendorff_alpha"] == pytest.approx(
        _krippendorff_alpha([[1, 0], [1, 1], [0, 0]])
    )
    assert row["krippendorff_alpha"] != pytest.approx(
        _krippendorff_alpha([[1, 0]] + [[1, 1]] * 4 + [[0, 0]])
    )


def test_a_partly_coded_group_is_coded(db_session):
    """B reached ONE member (a bulk apply over a multi-selection touches only the
    listed ids — `bulk_code` never fans out). A group is one unit, so B's coding
    of a member is B's coding of the unit: presence ANYWHERE in the group."""
    code, _ = _grouped(db_session, 1342, b_codes=(2, 5))
    row = _row(compute_irr(db_session, 1342), code.id)
    assert row["n_units"] == 3
    # t0 [1,0] · group [1,1] · t5 [0,1]
    assert row["krippendorff_alpha"] == pytest.approx(
        _krippendorff_alpha([[1, 0], [1, 1], [0, 1]])
    )


def test_ungrouped_turns_are_unchanged(db_session):
    """CONTROL — no group, no change: passes before and after."""
    conv, _i, respondent, code = _world(db_session, 1343)
    for i in range(3):
        _turn(db_session, conv, 134300 + i, i, respondent)
    _apply(db_session, code.id, A, 134300); _apply(db_session, code.id, B, 134300)
    _apply(db_session, code.id, A, 134301)
    assert _row(compute_irr(db_session, 1343), code.id)["n_units"] == 3


def test_a_group_with_a_prompt_inside_counts_its_respondent_turns_once(db_session):
    """#1333 × #1334: the facilitator clause applies to the TURNS, then the
    remaining members collapse. A group made only of prompts is no unit at all."""
    conv, interviewer, respondent, code = _world(db_session, 1344)
    db = db_session
    db.add_all([SegmentGroup(id=13441, conversation_id=conv.id),
                SegmentGroup(id=13442, conversation_id=conv.id)])
    db.flush()
    _turn(db, conv, 134400, 0, interviewer, group_id=13441)
    _turn(db, conv, 134401, 1, respondent, group_id=13441)
    _turn(db, conv, 134402, 2, respondent, group_id=13441)
    _turn(db, conv, 134403, 3, interviewer, group_id=13442)
    _turn(db, conv, 134404, 4, interviewer, group_id=13442)
    _turn(db, conv, 134405, 5, respondent)
    for sid in (134400, 134401, 134402):
        _apply(db, code.id, A, sid); _apply(db, code.id, B, sid)
    for sid in (134403, 134404):
        _apply(db, code.id, A, sid)
    _apply(db, code.id, B, 134405)
    row = _row(compute_irr(db, 1344), code.id)
    assert row["n_units"] == 2, "group 1 once, the lone respondent turn; group 2 is all prompts"


def test_a_coders_two_ratings_on_one_group_are_not_a_rating(db_session):
    """Members of one group can carry DIFFERENT ratings for one coder (a rating
    given before the turn joined the group; `_fan_out_rating` only evens them out
    on the next rating act). Two answers on one unit is a contradiction, not a
    value — `code_sets`' SET_MULTIPLE rule, and the coding import's (#1031) — so
    that coder is not a rater on that unit. A coder whose members AGREE, or who
    rated one member and left the rest unrated, rates the unit."""
    db = db_session
    conv, _i, respondent, _code = _world(db, 1345)
    scaled = Code(id=13459, project_id=1345, name="Strength", numeric_id=3, is_active=True,
                  is_universal=False, magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0)
    db.add(scaled)
    db.add(SegmentGroup(id=1345, conversation_id=conv.id))
    db.flush()
    for i in range(4):
        _turn(db, conv, 134500 + i, i, respondent, group_id=1345 if i < 3 else None)
    for sid in (134500, 134501, 134502):
        _apply(db, scaled.id, A, sid, magnitude=4.0)          # A: the group, rated 4
    _apply(db, scaled.id, B, 134500, magnitude=2.0)           # B: two answers
    _apply(db, scaled.id, B, 134501, magnitude=5.0)
    _apply(db, scaled.id, B, 134502, magnitude=None)
    _apply(db, scaled.id, A, 134503, magnitude=3.0)
    _apply(db, scaled.id, B, 134503, magnitude=3.0)
    payload = compute_irr(db, 1345)
    rating = next(r for r in payload["magnitude_per_code"] if r["code_id"] == scaled.id)
    assert rating["n_applications"] == 4, "one per (unit, coder): group×2 + t3×2"
    assert rating["n_rated"] == 3, "B's contradictory group rating is not a rating"
    assert rating["n_units"] == 1, "only t3 is rated by both"


def test_the_r_export_matrix_is_the_collapsed_one(db_session):
    """`export_r.py` writes `build_irr_matrices`' rows verbatim, so the script
    reproduces the collapsed figure by construction — the real-R half is in
    `test_export_r_irr.py`."""
    code, _ = _grouped(db_session, 1346, b_codes=(1, 2, 3, 4))
    _roster, _names, per_code, *_ = build_irr_matrices(db_session, 1346)
    assert len(per_code[code.id]) == 3


# ── The doors that now move a score (#1333 / #1334) ───────────────────────────


@pytest.fixture
def scored(db_session):
    """A project with a participant table, so the score marker has a target."""
    from app.models.dataset import Dataset

    conv, interviewer, respondent, code = _world(db_session, 1350)
    for i in range(3):
        _turn(db_session, conv, 135000 + i, i, respondent)
    table = Dataset(id=1350, project_id=1350, name="Participants", managed_kind="participants")
    db_session.add(table)
    db_session.flush()
    return db_session, conv, table


def _user(db):
    return db.get(User, 1)


def test_grouping_marks_the_scores_stale(scored):
    import asyncio

    from app.routers.segments import create_segment_group
    from app.schemas.segment import SegmentGroupRequest

    db, conv, table = scored
    asyncio.run(create_segment_group(
        conv.id, SegmentGroupRequest(segment_ids=[135000, 135001]), user=_user(db), db=db,
    ))
    db.refresh(table)
    assert table.managed_stale is True


def test_ungrouping_marks_the_scores_stale(scored):
    import asyncio

    from app.routers.segments import ungroup_segments

    db, conv, table = scored
    db.add(SegmentGroup(id=13501, conversation_id=conv.id))
    db.flush()
    for sid in (135000, 135001):
        db.get(Segment, sid).group_id = 13501
    db.flush()
    asyncio.run(ungroup_segments(conv.id, 13501, user=_user(db), db=db))
    db.refresh(table)
    assert table.managed_stale is True


def test_a_speakers_role_marks_the_scores_stale(scored):
    import asyncio

    from app.routers.segments import update_segment_speaker_role
    from app.schemas.segment import SpeakerUpdateRequest

    db, conv, table = scored
    asyncio.run(update_segment_speaker_role(
        conv.id, 135000, SpeakerUpdateRequest(is_facilitator=True), user=_user(db), db=db,
    ))
    db.refresh(table)
    assert table.managed_stale is True


def test_the_model_comparison_counts_the_same_units(db_session):
    """`machine_agreement.py` promises "the SAME rule the human table uses" — so a
    prompt is not a unit there and a group counts once there too, through the
    same two helpers, and the payload states the basis it shares."""
    from app.auth import CODER_TYPE_MACHINE
    from app.services.machine_agreement import compute_machine_agreement

    db = db_session
    conv, interviewer, respondent, code = _world(db, 1360)
    db.add(User(id=23, username="Model", password_hash=None, coder_type=CODER_TYPE_MACHINE))
    db.add(SegmentGroup(id=1360, conversation_id=conv.id))
    db.flush()
    _turn(db, conv, 136000, 0, interviewer)
    _turn(db, conv, 136001, 1, respondent, group_id=1360)
    _turn(db, conv, 136002, 2, respondent, group_id=1360)
    _turn(db, conv, 136003, 3, respondent)
    for sid in (136001, 136002):
        _apply(db, code.id, A, sid)
    _apply(db, code.id, 23, 136003)
    _apply(db, code.id, 23, 136000)  # the model tags the prompt: still no unit

    result = compute_machine_agreement(db, 1360)
    pair = next(p for p in result.pairs if p.human_id == A)
    assert pair.n_units == 2, "the group once and the lone answer; the prompt is no unit"
    assert result.unit_basis == rb.DEFAULT_RELIABILITY_UNIT_BASIS


def test_the_rating_collapse_rule():
    """`segment_groups.merge_unit_rating` — zero is a rating (the falsy-zero class,
    `magnitude-coding.md` §2), unrated adds nothing, two values are no value."""
    from app.services.segment_groups import GROUP_RATING_CONFLICT as C, merge_unit_rating as m

    assert m(None, 3.0) == 3.0 and m(3.0, None) == 3.0 and m(3.0, 3.0) == 3.0
    assert m(0.0, None) == 0.0 and m(None, 0.0) == 0.0 and m(0.0, 0.0) == 0.0
    assert m(3.0, 5.0) is C and m(0.0, 1.0) is C and m(1.0, 0.0) is C
    assert m(C, 3.0) is C and m(C, None) is C


def test_the_grid_lists_a_group_once(db_session):
    """#1334 unit 3 (D35) — the reconciliation grid adjudicates the consensus
    layer, which decides a group once since session A, so the group is ONE row
    naming its turns (this test said the opposite until 1.5.9's session B; the
    full contract is `test_reconciliation_groups.py`)."""
    from app.services.reconciliation import build_reconciliation

    _code, base = _grouped(db_session, 1347, b_codes=(2, 5))
    grid = build_reconciliation(db_session, 1347, limit=100)
    assert [(u["unit_type"], u["unit_id"]) for u in grid["units"]] == [
        ("segment", base), ("group", 1347), ("segment", base + 5),
    ]
    group = grid["units"][1]
    assert group["member_segment_ids"] == [base + i for i in (1, 2, 3, 4)]


def test_a_coder_holding_two_values_across_a_group_holds_two_values(db_session):
    """Code sets × groups: the members fold into one unit, so a coder whose
    members carry DIFFERENT values of one set holds two values on that unit —
    `SET_MULTIPLE`, no comparable choice, counted (`code-sets.md` §8) — rather
    than two units each with a clean choice."""
    from app.models.code_set import CodeSet

    db = db_session
    conv, _i, respondent, _code = _world(db, 1348)
    db.add(CodeSet(id=1348, project_id=1348, label="Stance"))
    db.add(SegmentGroup(id=1348, conversation_id=conv.id))
    db.flush()
    pos = Code(id=134811, project_id=1348, name="Positive", numeric_id=11, is_active=True,
               is_universal=False, code_set_id=1348)
    neg = Code(id=134813, project_id=1348, name="Negative", numeric_id=13, is_active=True,
               is_universal=False, code_set_id=1348)
    db.add_all([pos, neg])
    db.flush()
    _turn(db, conv, 134800, 0, respondent, group_id=1348)
    _turn(db, conv, 134801, 1, respondent, group_id=1348)
    _turn(db, conv, 134802, 2, respondent)
    for sid in (134800, 134801):
        _apply(db, pos.id, A, sid)
    _apply(db, pos.id, B, 134800)
    _apply(db, neg.id, B, 134801)            # B: two values on one unit
    _apply(db, neg.id, A, 134802); _apply(db, neg.id, B, 134802)
    row = next(r for r in compute_irr(db, 1348)["set_agreement"] if r["set_id"] == 1348)
    assert row["n_multiple_selection"] == 1, "one unit, one contradiction — not two clean units"
    assert row["n_units"] == 1, "only the lone turn is comparable"


def test_the_lead_verified_figures_and_the_blank_participant_turns_stay(db_session):
    """The literature review's figures, reproduced through the GATHER: a=3, b=1,
    c=0, d=2 over six participant turns is α 0.686 / κ 0.667; six prompts nobody
    coded would make it 0.807 / 0.800. The exclusion is by SPEAKER ROLE: the two
    participant turns both coders left blank are real "absent" judgements and
    stay units (with d = 0 the same coding gives κ <= 0)."""
    conv, interviewer, respondent, code = _world(db_session, 1309)
    for i in range(12):
        _turn(db_session, conv, 130900 + i, i, interviewer if i >= 6 else respondent)
    for sid in (130900, 130901, 130902):
        _apply(db_session, code.id, A, sid); _apply(db_session, code.id, B, sid)
    _apply(db_session, code.id, A, 130903)
    payload = compute_irr(db_session, 1309)
    row = _row(payload, code.id)
    assert row["n_units"] == 6
    assert row["krippendorff_alpha"] == pytest.approx(0.686, abs=5e-4)
    assert row["cohens_kappa"] == pytest.approx(0.667, abs=5e-4)
    assert payload["facilitator_turns_excluded"] == 6 and row["facilitator_turns_coded"] == 0
    assert payload["facilitator_speakers"] == ["Interviewer"]
