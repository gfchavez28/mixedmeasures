"""Bulk import of code applications (queue row 49).

Five layers: the parser, unit resolution (both target kinds), code resolution,
the write (plain applies, code-set selections, ratings), and the ENDPOINTS —
because a service test proves the functions work and says nothing about whether
the endpoints reach them (`backend/tests/the internal design notes, the `renumber_imported_notes`
shape).

⚠️ **The fixture's record identifiers are multi-digit and its codes are
case-varied on purpose.** Unit matching is case-SENSITIVE (a participant register
can hold `P01` and `p01` as two people) while code matching is case-INSENSITIVE
(`create_code` has refused a case-insensitive duplicate since #963) — a fixture
that never exercises the difference cannot tell the two rules apart.
"""
import asyncio
import csv
import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from app.auth import CODER_TYPE_MACHINE
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_set import CodeSet
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.text_coding_config import TextCodingConfig
from app.models.user import User
from app.routers.coding_import import import_coding, preview_coding_import
from app.services import coding_import as ci


def _run(coro):
    return asyncio.run(coro)


def _upload(text: str, name: str = "codings.csv") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(text.encode("utf-8")))


def _decisions(**by_name) -> str:
    return json.dumps(by_name)


# ── Fixtures ─────────────────────────────────────────────────────────────────


def _coder(db, uid, name, coder_type="human"):
    if db.get(User, uid) is None:
        db.add(User(id=uid, username=name, password_hash=None, coder_type=coder_type))
        db.flush()
    return db.get(User, uid)


def _segment_project(db, pid=200):
    """A conversation with three segments carrying known uuids, plus two codes."""
    db.add(Project(id=pid, name="Interviews", user_id=1))
    db.add(Conversation(id=pid, project_id=pid, name="Session 1"))
    db.flush()
    for i in range(3):
        # ⚠️ The uuid is PROJECT-PREFIXED because `Segment.uuid` is globally
        # unique — two fixture projects cannot both carry `seg-200-0`, and the
        # cross-project test below needs two real projects to exist at once.
        db.add(Segment(
            id=pid * 10 + i, conversation_id=pid, sequence_order=i,
            text=f"turn {i}", uuid=f"seg-{pid}-{i}",
        ))
    db.add(Code(id=pid * 100 + 1, project_id=pid, numeric_id=10, name="Trust"))
    db.add(Code(id=pid * 100 + 2, project_id=pid, numeric_id=11, name="Risk"))
    db.flush()
    return pid


def _text_project(db, pid=300, *, treat_as_empty=None):
    """A dataset with an open-text column, four records, and two codes.

    Record `R0003` is deliberately a non-response so the #987 refusal has
    something real to refuse; `R0004` has NO cell in the coded column at all
    (an imported column is sparse by design, #897) so the two uncodeable
    sentences can be told apart.
    """
    db.add(Project(id=pid, name="Posts", user_id=1))
    db.add(Dataset(id=pid, project_id=pid, name="Survey"))
    db.flush()
    db.add(DatasetColumn(
        id=pid * 10 + 1, dataset_id=pid, column_name="Comment",
        column_text="What did you think?", column_type=ColumnType.OPEN_TEXT,
        sequence_order=1,
    ))
    db.add(DatasetColumn(
        id=pid * 10 + 2, dataset_id=pid, column_name="post_id",
        column_text="Post id", column_type=ColumnType.IDENTIFIER,
        sequence_order=2,
    ))
    db.flush()
    texts = {1: "I trust them", 2: "Not sure", 3: "N/A", 4: None}
    for n in (1, 2, 3, 4):
        db.add(DatasetRow(id=pid * 10 + n, dataset_id=pid, row_identifier=f"R{n:04d}"))
        db.flush()
        if texts[n] is not None:
            db.add(DatasetValue(
                id=pid * 100 + n, row_id=pid * 10 + n, column_id=pid * 10 + 1,
                value_text=texts[n],
            ))
        db.add(DatasetValue(
            id=pid * 100 + 50 + n, row_id=pid * 10 + n, column_id=pid * 10 + 2,
            value_text=f"post-{n}",
        ))
    db.add(Code(id=pid * 100 + 1, project_id=pid, numeric_id=10, name="Trust"))
    db.add(Code(id=pid * 100 + 2, project_id=pid, numeric_id=11, name="Risk"))
    if treat_as_empty is not None:
        db.add(TextCodingConfig(project_id=pid, treat_as_empty=json.dumps(treat_as_empty)))
    db.flush()
    return pid, pid * 10 + 1, pid * 10 + 2


def _plan(db, pid, csv_text, **kw):
    rows = ci.parse_rows(csv_text)
    return ci.build_plan(db, pid, rows, **kw)


def _reasons(plan) -> dict[int, str]:
    return {p.line: p.reason for p in plan.problems}


# ── 1. The parser ────────────────────────────────────────────────────────────


class TestParser:
    def test_headers_are_matched_liberally(self):
        rows = ci.parse_rows("Unit ID,Coder,Code\nseg-200-0,Alice,Trust\n")
        assert rows[0].unit_id == "seg-200-0"
        rows = ci.parse_rows("unit-id,CODER,code\nseg-200-0,Alice,Trust\n")
        assert rows[0].coder == "Alice"

    def test_a_missing_required_header_names_it_and_shows_the_shape(self):
        with pytest.raises(ci.CodingImportError) as exc:
            ci.parse_rows("unit_id,code\nseg-200-0,Trust\n")
        assert "“coder”" in str(exc.value)
        assert "magnitude" in str(exc.value)  # the optional ones are shown too

    def test_a_BOM_is_consumed_rather_than_becoming_part_of_a_header(self):
        """Excel writes one. Without `utf-8-sig` the first header reads
        `\\ufeffunit_id` and every import from a spreadsheet is refused — the
        #764 trap, reached by the same route."""
        raw = "﻿unit_id,coder,code\nseg-200-0,Alice,Trust\n".encode("utf-8")
        rows = ci.parse_rows(ci.decode_csv(raw))
        assert rows[0].unit_id == "seg-200-0"

    def test_blank_lines_are_skipped_and_the_LINE_NUMBER_still_counts_them(self):
        """The number has to be the spreadsheet row the researcher will look at."""
        rows = ci.parse_rows("unit_id,coder,code\n\nseg-200-0,Alice,Trust\n")
        assert [r.line for r in rows] == [3]

    def test_cells_are_trimmed(self):
        rows = ci.parse_rows("unit_id,coder,code\n  seg-200-0 , Alice ,  Trust \n")
        assert (rows[0].unit_id, rows[0].coder, rows[0].code) == ("seg-200-0", "Alice", "Trust")

    def test_a_duplicated_header_takes_the_FIRST_column(self):
        """Taking the LAST is how `preview_dataset_csv` described the second
        column's values under the first column's name (#973 (b'))."""
        rows = ci.parse_rows("unit_id,coder,code,code\nseg-200-0,Alice,Trust,Risk\n")
        assert rows[0].code == "Trust"

    def test_an_empty_file_says_so(self):
        with pytest.raises(ci.CodingImportError, match="empty"):
            ci.parse_rows("")

    def test_the_row_cap_is_enforced(self, monkeypatch):
        monkeypatch.setattr(ci, "MAX_CODING_IMPORT_ROWS", 3)
        body = "unit_id,coder,code\n" + "seg-200-0,Alice,Trust\n" * 4
        with pytest.raises(ci.CodingImportError, match="more than 3"):
            ci.parse_rows(body)

    def test_unreadable_bytes_are_refused_rather_than_mojibake(self):
        """A file decoded into mojibake would then match no unit, and the
        researcher would be told their ids are wrong."""
        # ⚠️ 0x81 and 0x8D are UNDEFINED in cp1252, so they fail BOTH attempts.
        # A byte cp1252 happens to map (0xFF → ÿ) would decode into mojibake and
        # prove nothing — which is the whole failure mode being guarded.
        with pytest.raises(ci.CodingImportError, match="UTF-8"):
            ci.decode_csv(b"\x81\x8dunit_id")


# ── 2. Unit resolution — segments ────────────────────────────────────────────


class TestSegmentUnits:
    def test_a_uuid_resolves_to_its_segment(self, db_session):
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-1,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        assert plan.applications[0].segment_id == pid * 10 + 1

    def test_an_unknown_uuid_is_named_in_its_refusal(self, db_session):
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nnope,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_UNIT_NOT_FOUND}
        assert "“nope”" in plan.problems[0].detail

    def test_a_MERGED_AWAY_segment_is_NOT_CODEABLE_rather_than_missing(self, db_session):
        """🔴 Its codings are UI-unreachable (#500), so writing one creates a row
        with no chip and no way to remove it. And "that unit does not exist"
        would be a false sentence about a unit that does."""
        db = db_session
        pid = _segment_project(db)
        db.get(Segment, pid * 10 + 2).merged_into_id = pid * 10 + 1
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-2,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_UNIT_NOT_CODEABLE}
        assert "merged or split" in plan.problems[0].detail

    def test_a_segment_in_ANOTHER_project_does_not_resolve(self, db_session):
        """The lookup is PROJECT-scoped, not merely uuid-keyed.

        ⚠️ `Segment.uuid` is globally unique, so this cannot be tested by giving
        two projects the same uuid — the fixture would not insert. It is tested
        the other way: a uuid that exists, in a project the caller did not ask
        about, must come back `unit_not_found` rather than being coded into the
        wrong project.
        """
        db = db_session
        _segment_project(db, 200)
        _segment_project(db, 201)
        plan = _plan(db, 200, "unit_id,coder,code\nseg-201-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_UNIT_NOT_FOUND}
        # The positive control: the same file against the OTHER project resolves,
        # so the refusal above is the scope and not a broken fixture.
        plan = _plan(db, 201, "unit_id,coder,code\nseg-201-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.applications[0].segment_id == 2010


class TestTextUnits:
    def test_a_record_identifier_resolves_to_the_cell_in_the_coded_column(self, db_session):
        db = db_session
        pid, col, _ = _text_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nR0001,Alice,Trust\n",
                     target_kind=ci.TARGET_TEXT_COLUMN, column_id=col)
        assert plan.problems == []
        assert plan.applications[0].dataset_value_id == pid * 100 + 1

    def test_a_CHOSEN_COLUMN_is_the_other_named_key(self, db_session):
        """🔴 `row_identifier` is always MACHINE-generated (`R0001`), never a raw
        cell — so without this arm a pipeline built on the researcher's OWN file
        could not address anything at all."""
        db = db_session
        pid, col, post_id = _text_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\npost-2,Alice,Trust\n",
                     target_kind=ci.TARGET_TEXT_COLUMN, column_id=col,
                     match_column_id=post_id)
        assert plan.problems == []
        assert plan.applications[0].dataset_value_id == pid * 100 + 2

    def test_a_NON_RESPONSE_cell_is_refused_with_the_project_s_own_rule(self, db_session):
        """🔴 #987's rule reached from the import side. A cell the project treats
        as a non-response is not offered for coding, so writing there creates the
        UI-unreachable application #987 removed from the reliability statistic."""
        db = db_session
        pid, col, _ = _text_project(db)   # the DEFAULT list contains "N/A"
        plan = _plan(db, pid, "unit_id,coder,code\nR0003,Alice,Trust\n",
                     target_kind=ci.TARGET_TEXT_COLUMN, column_id=col)
        assert _reasons(plan) == {2: ci.REASON_UNIT_NOT_CODEABLE}
        assert "non-response" in plan.problems[0].detail

    def test_the_project_s_OWN_list_decides_it_not_a_hardcoded_default(self, db_session):
        """Two-sided, the REPLACE-semantics corollary: declaring a different list
        must both ADMIT "N/A" and REFUSE the newly-declared value. A one-sided
        test passes against a hardcoded default."""
        db = db_session
        pid, col, _ = _text_project(db, 301, treat_as_empty=["Not sure"])
        plan = _plan(
            db, pid,
            "unit_id,coder,code\nR0003,Alice,Trust\nR0002,Alice,Trust\n",
            target_kind=ci.TARGET_TEXT_COLUMN, column_id=col,
        )
        # "N/A" is no longer a non-response here …
        assert 2 not in _reasons(plan)
        # … and "Not sure" now is.
        assert _reasons(plan) == {3: ci.REASON_UNIT_NOT_CODEABLE}

    def test_a_record_with_NO_CELL_gets_its_own_sentence(self, db_session):
        """An imported column is sparse by design (#897), so this is a real
        state and its remedy is different from the non-response one."""
        db = db_session
        pid, col, _ = _text_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nR0004,Alice,Trust\n",
                     target_kind=ci.TARGET_TEXT_COLUMN, column_id=col)
        assert _reasons(plan) == {2: ci.REASON_UNIT_NOT_CODEABLE}
        assert "no text in the column" in plan.problems[0].detail

    def test_a_DUPLICATED_identifier_matches_NOTHING(self, db_session):
        """🔴 The `link_rows_by_identifier_column` rule, single-sourced in
        `identifier_match.py`: every tie-break encodes a judgement the researcher
        never made, so neither candidate is taken."""
        db = db_session
        pid, col, post_id = _text_project(db)
        db.get(DatasetValue, pid * 100 + 52).value_text = "post-1"  # a twin
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\npost-1,Alice,Trust\n",
                     target_kind=ci.TARGET_TEXT_COLUMN, column_id=col,
                     match_column_id=post_id)
        assert _reasons(plan) == {2: ci.REASON_UNIT_AMBIGUOUS}
        assert plan.applications == []

    def test_unit_matching_is_CASE_SENSITIVE(self, db_session):
        """`P01` and `p01` can genuinely be two records. The asymmetry with code
        matching is deliberate — see the module docstring."""
        db = db_session
        pid, col, _ = _text_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nr0001,Alice,Trust\n",
                     target_kind=ci.TARGET_TEXT_COLUMN, column_id=col)
        assert _reasons(plan) == {2: ci.REASON_UNIT_NOT_FOUND}


# ── 3. Code resolution ───────────────────────────────────────────────────────


class TestCodeResolution:
    def test_code_matching_is_CASE_INSENSITIVE(self, db_session):
        """`create_code` refuses a case-insensitive duplicate (#963), so two
        spellings ARE one code."""
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,  tRuSt \n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        assert plan.applications[0].code_id == pid * 100 + 1

    def test_two_codes_of_one_name_match_NEITHER(self, db_session):
        """Reachable on a project created before #963's refusal."""
        db = db_session
        pid = _segment_project(db)
        db.add(Code(id=pid * 100 + 9, project_id=pid, numeric_id=19, name="trust"))
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_CODE_AMBIGUOUS}

    def test_a_universal_code_is_refused_and_says_why_it_would_do_nothing(self, db_session):
        db = db_session
        pid = _segment_project(db)
        db.add(Code(id=pid * 100 + 8, project_id=pid, numeric_id=0,
                    name="Unclear", is_universal=True))
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Unclear\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_CODE_UNIVERSAL}
        assert "would have no effect" in plan.problems[0].detail

    def test_an_inactive_code_is_refused(self, db_session):
        db = db_session
        pid = _segment_project(db)
        db.get(Code, pid * 100 + 2).is_active = False
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Risk\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_CODE_INACTIVE}

    def test_a_repeated_triple_is_reported_ONCE_and_applied_once(self, db_session):
        db = db_session
        pid = _segment_project(db)
        plan = _plan(
            db, pid,
            "unit_id,coder,code\nseg-200-0,Alice,Trust\nseg-200-0,Alice,Trust\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        assert _reasons(plan) == {3: ci.REASON_DUPLICATE_ROW}
        assert len(plan.applications) == 1


# ── 4. Ratings ───────────────────────────────────────────────────────────────


class TestRatings:
    def _scaled(self, db, pid):
        code = db.get(Code, pid * 100 + 1)
        code.magnitude_min, code.magnitude_max, code.magnitude_step = -1.0, 1.0, 0.5
        db.flush()
        return code

    def test_a_rating_of_ZERO_survives(self, db_session):
        """🔴 The falsy-zero class. The fixture is −1…+1 so zero is INTERIOR —
        on a 0–10 scale a correct implementation and a truthiness slip agree
        about almost everything (#35 §2)."""
        db = db_session
        pid = _segment_project(db)
        self._scaled(db, pid)
        plan = _plan(db, pid, "unit_id,coder,code,magnitude\nseg-200-0,Alice,Trust,0\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        assert plan.applications[0].magnitude == 0.0

    def test_an_out_of_range_rating_is_refused_with_the_scale(self, db_session):
        db = db_session
        pid = _segment_project(db)
        self._scaled(db, pid)
        plan = _plan(db, pid, "unit_id,coder,code,magnitude\nseg-200-0,Alice,Trust,5\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_RATING_OUTSIDE_SCALE}
        assert "-1 to 1" in plan.problems[0].detail

    def test_a_rating_on_a_SCALELESS_code_gets_its_own_reason(self, db_session):
        """A different remedy from an out-of-range value: declare a scale."""
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code,magnitude\nseg-200-0,Alice,Trust,1\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_RATING_WITHOUT_SCALE}

    def test_a_non_numeric_rating_is_refused(self, db_session):
        db = db_session
        pid = _segment_project(db)
        self._scaled(db, pid)
        plan = _plan(db, pid, "unit_id,coder,code,magnitude\nseg-200-0,Alice,Trust,high\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert _reasons(plan) == {2: ci.REASON_RATING_NOT_A_NUMBER}

    def test_an_EMPTY_magnitude_cell_is_UNRATED_not_zero(self, db_session):
        db = db_session
        pid = _segment_project(db)
        self._scaled(db, pid)
        plan = _plan(db, pid, "unit_id,coder,code,magnitude\nseg-200-0,Alice,Trust,\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        assert plan.applications[0].magnitude is None


# ── 5. Code sets ─────────────────────────────────────────────────────────────


def _stance(db, pid):
    """A three-valued set over the project's codes."""
    db.add(CodeSet(id=pid, project_id=pid, label="Stance"))
    db.flush()
    for cid, numeric, name in (
        (pid * 100 + 11, 20, "Positive"),
        (pid * 100 + 12, 21, "Negative"),
        (pid * 100 + 13, 22, "Neutral"),
    ):
        db.add(Code(id=cid, project_id=pid, numeric_id=numeric, name=name, code_set_id=pid))
    db.flush()
    return pid


class TestCodeSets:
    def test_membership_is_DERIVED_from_the_code_not_declared_in_the_file(self, db_session):
        """The file cannot then contradict the database about what kind of write
        this is, and the researcher has one less column to get wrong."""
        db = db_session
        pid = _segment_project(db)
        set_id = _stance(db, pid)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Positive\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.applications[0].code_set_id == set_id

    def test_a_declared_code_set_that_DISAGREES_is_refused(self, db_session):
        """An assertion, not an instruction: a file built against a different
        codebook fails loudly instead of applying the wrong kind of write."""
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        plan = _plan(
            db, pid, "unit_id,coder,code,code_set\nseg-200-0,Alice,Positive,Sentiment\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        assert _reasons(plan) == {2: ci.REASON_SET_MISMATCH}
        assert "“Stance”" in plan.problems[0].detail

    def test_a_MATCHING_declared_code_set_passes(self, db_session):
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        plan = _plan(
            db, pid, "unit_id,coder,code,code_set\nseg-200-0,Alice,Positive,Stance\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        assert plan.problems == []

    def test_TWO_VALUES_OF_ONE_SET_for_one_unit_apply_NEITHER(self, db_session):
        """🔴 `SET_MULTIPLE`'s rule, reached at the FILE. Silently picking one
        fabricates a judgement nobody made — and the EARLIER row is withdrawn
        too, or "first wins" is the coin toss by another name."""
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        plan = _plan(
            db, pid,
            "unit_id,coder,code\nseg-200-0,Alice,Positive\nseg-200-0,Alice,Negative\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        assert plan.applications == []
        assert sorted(_reasons(plan).items()) == [
            (2, ci.REASON_SET_CONFLICT_IN_FILE),
            (3, ci.REASON_SET_CONFLICT_IN_FILE),
        ]

    def test_two_CODERS_may_choose_differently_on_one_unit(self, db_session):
        """That is disagreement, which is the thing being measured — not a
        contradiction. The claim key must include the coder."""
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        plan = _plan(
            db, pid,
            "unit_id,coder,code\nseg-200-0,Alice,Positive\nseg-200-0,Bob,Negative\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        assert plan.problems == []
        assert len(plan.applications) == 2

    def test_a_GROUPED_segment_carries_its_siblings(self, db_session):
        """`code-sets.md` §6: a group is coded as ONE unit, and the CALLER passes
        the siblings — `apply_selection` does not re-derive them."""
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        db.add(SegmentGroup(id=1, conversation_id=pid))
        db.flush()
        for i in (0, 1):
            db.get(Segment, pid * 10 + i).group_id = 1
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Positive\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert set(plan.applications[0].group_segment_ids) == {pid * 10, pid * 10 + 1}


# ── 6. Coder resolution ──────────────────────────────────────────────────────


class TestCoderResolution:
    def test_a_name_with_NO_DECISION_is_refused_and_named(self, db_session):
        """🔴 The one deliberate divergence from the `.mmproject` merge, whose
        loop falls back to a silent name-match. A CSV carries a typed string, not
        a uuid spine, so a name that merely LOOKS like a colleague's is exactly
        the misattribution J3-2's confirm screen exists to prevent."""
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        with pytest.raises(ci.CodingImportError, match="“Alice”"):
            ci.apply_plan(db, pid, plan, {})

    def test_the_candidate_carries_the_local_match_and_its_volume(self, db_session):
        db = db_session
        pid = _segment_project(db)
        alice = _coder(db, 20, "Alice")
        db.add(CodeApplication(code_id=pid * 100 + 1, user_id=alice.id,
                               segment_id=pid * 10))
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-1,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        candidate = plan.coders[0]
        assert candidate.local_user_id == alice.id
        assert candidate.local_application_count == 1
        assert candidate.row_count == 1

    def test_a_SYSTEM_coder_is_never_a_candidate(self, db_session):
        """"Unattributed" and "Consensus" own data and are not people; matching
        onto either would write coding into a derived layer."""
        db = db_session
        pid = _segment_project(db)
        db.add(User(id=21, username="Consensus", password_hash=None,
                    coder_type="consensus"))
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Consensus,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.coders[0].local_user_id is None

    def test_skip_leaves_the_rows_out_and_says_so(self, db_session):
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        report = ci.apply_plan(db, pid, plan, {"Alice": ci.CoderDecision(action="skip")})
        assert report.applied == 0
        assert report.problems[0].reason == ci.REASON_CODER_SKIPPED

    def test_creating_a_MACHINE_carries_its_provenance(self, db_session):
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,GPT-4o,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        report = ci.apply_plan(db, pid, plan, {
            "GPT-4o": ci.CoderDecision(
                action="create", coder_type=CODER_TYPE_MACHINE,
                machine_provenance={"model": "gpt-4o-2024-08-06", "access": "api"},
            ),
        })
        assert report.coders_created == 1
        machine = db.query(User).filter(User.username == "GPT-4o").one()
        assert machine.coder_type == CODER_TYPE_MACHINE
        assert json.loads(machine.machine_provenance)["model"] == "gpt-4o-2024-08-06"


# ── 7. The write ─────────────────────────────────────────────────────────────


class TestApply:
    def _applied(self, db, pid):
        return db.query(CodeApplication).filter(
            CodeApplication.code_id.in_(
                db.query(Code.id).filter(Code.project_id == pid)
            )
        ).all()

    def test_a_plain_apply_lands_on_the_right_coder_and_unit(self, db_session):
        db = db_session
        pid = _segment_project(db)
        alice = _coder(db, 22, "Alice")
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-1,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        report = ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        assert report.applied == 1
        row = self._applied(db, pid)[0]
        assert (row.user_id, row.segment_id) == (alice.id, pid * 10 + 1)

    def test_a_row_the_coder_ALREADY_HAS_is_counted_not_duplicated(self, db_session):
        db = db_session
        pid = _segment_project(db)
        alice = _coder(db, 23, "Alice")
        db.add(CodeApplication(code_id=pid * 100 + 1, user_id=alice.id,
                               segment_id=pid * 10))
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        report = ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        assert (report.applied, report.already_present) == (0, 1)
        assert len(self._applied(db, pid)) == 1

    def test_a_SELECTION_clears_the_coder_s_previous_value_of_that_set(self, db_session):
        """The swap, reused rather than re-implemented — `apply_selection` is the
        one place it lives (`code-sets.md` §6)."""
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        alice = _coder(db, 24, "Alice")
        db.add(CodeApplication(code_id=pid * 100 + 12, user_id=alice.id,
                               segment_id=pid * 10))  # Negative, already there
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Positive\n",
                     target_kind=ci.TARGET_SEGMENTS)
        report = ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        assert (report.selections, report.replaced) == (1, 1)
        rows = [r.code_id for r in self._applied(db, pid)]
        assert rows == [pid * 100 + 11]

    def test_TWO_ROWS_naming_two_siblings_of_ONE_group_do_not_collide(self, db_session):
        """🔴 Found by a SURVIVING MUTANT, and it is a real 500 rather than a
        tidiness point.

        A file may legitimately name each member of a segment group — an export
        lists them separately. Each row fans out to EVERY sibling, so the group's
        target list arrives at `apply_selection` holding each id twice, and two
        inserts for one `(segment, code, coder)` breach
        `ix_code_applications_seg_code_user_unique` at COMMIT: an opaque
        IntegrityError far from its cause.

        `test_code_sets.py` could not see it — every call there passes one
        target — which is exactly why the dedup looked redundant until this
        path existed.
        """
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        alice = _coder(db, 27, "Alice")
        db.add(SegmentGroup(id=3, conversation_id=pid))
        db.flush()
        for i in (0, 1):
            db.get(Segment, pid * 10 + i).group_id = 3
        db.flush()
        plan = _plan(
            db, pid,
            "unit_id,coder,code\nseg-200-0,Alice,Positive\nseg-200-1,Alice,Positive\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        db.commit()   # the collision only surfaces at COMMIT
        rows = self._applied(db, pid)
        assert sorted(r.segment_id for r in rows) == [pid * 10, pid * 10 + 1]

    def test_a_SELECTION_reaches_every_sibling_of_a_group(self, db_session):
        db = db_session
        pid = _segment_project(db)
        _stance(db, pid)
        alice = _coder(db, 25, "Alice")
        db.add(SegmentGroup(id=2, conversation_id=pid))
        db.flush()
        for i in (0, 1):
            db.get(Segment, pid * 10 + i).group_id = 2
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Positive\n",
                     target_kind=ci.TARGET_SEGMENTS)
        ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        assert {r.segment_id for r in self._applied(db, pid)} == {pid * 10, pid * 10 + 1}

    def test_a_rating_is_written_and_CLEARS_a_merge_conflict(self, db_session):
        """Rating again IS the adjudication (#35 §6d), and that is true however
        the application arrived."""
        db = db_session
        pid = _segment_project(db)
        code = db.get(Code, pid * 100 + 1)
        code.magnitude_min, code.magnitude_max, code.magnitude_step = -1.0, 1.0, 0.5
        alice = _coder(db, 26, "Alice")
        db.add(CodeApplication(
            code_id=code.id, user_id=alice.id, segment_id=pid * 10,
            magnitude=1.0, magnitude_conflict=-1.0,
        ))
        db.flush()
        plan = _plan(db, pid, "unit_id,coder,code,magnitude\nseg-200-0,Alice,Trust,0\n",
                     target_kind=ci.TARGET_SEGMENTS)
        report = ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        assert report.ratings_set == 1
        row = self._applied(db, pid)[0]
        assert row.magnitude == 0.0            # a ZERO, not "unrated"
        assert row.magnitude_conflict is None

    def test_ORIGIN_is_left_at_its_default_even_for_a_machine(self, db_session):
        """🔴 `origin` says how a ROW was produced and is reserved for a human
        accepting a model's suggestion; the LAYER keys on the CODER
        (`coding_layers.py` is explicit that the two markers are different
        facts). Writing `'ai'` here would be a field no consumer reads (#941)."""
        db = db_session
        pid = _segment_project(db)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,GPT-4o,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        ci.apply_plan(db, pid, plan, {
            "GPT-4o": ci.CoderDecision(action="create", coder_type=CODER_TYPE_MACHINE),
        })
        assert self._applied(db, pid)[0].origin == "human"


# ── 8. Staleness ─────────────────────────────────────────────────────────────


class TestStaleness:
    def _two_coders(self, db, pid):
        _coder(db, 30, "Alice")
        _coder(db, 31, "Bob")
        return db.get(User, 30)

    def test_a_HUMAN_s_rows_mark_consensus_stale(self, db_session):
        db = db_session
        pid = _segment_project(db)
        alice = self._two_coders(db, pid)
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        ci.apply_plan(db, pid, plan, {
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        assert db.query(ConsensusStaleTarget).count() == 1

    def test_a_MACHINE_s_rows_mark_NOTHING(self, db_session):
        """🔴 `gather_target_votes` and the consensus materializer both filter
        `reliability_coder_clause()`, so a machine's application cannot move
        either derived quantity. Marking anyway would enqueue one recompute
        marker per target for a recompute that provably changes nothing —
        up to 200,000 of them — one per row at the cap — for recomputes that provably change nothing, drained one at a time."""
        db = db_session
        pid = _segment_project(db)
        self._two_coders(db, pid)   # consensus_enabled needs ≥2 roster coders
        plan = _plan(db, pid, "unit_id,coder,code\nseg-200-0,GPT-4o,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        ci.apply_plan(db, pid, plan, {
            "GPT-4o": ci.CoderDecision(action="create", coder_type=CODER_TYPE_MACHINE),
        })
        assert db.query(ConsensusStaleTarget).count() == 0

    def test_a_MIXED_file_marks_only_the_human_s_targets(self, db_session):
        """The positive control that makes the negative one mean something: with
        both in one file, the narrowing must be per ROW and not per FILE."""
        db = db_session
        pid = _segment_project(db)
        alice = self._two_coders(db, pid)
        plan = _plan(
            db, pid,
            "unit_id,coder,code\nseg-200-0,GPT-4o,Trust\nseg-200-1,Alice,Trust\n",
            target_kind=ci.TARGET_SEGMENTS,
        )
        ci.apply_plan(db, pid, plan, {
            "GPT-4o": ci.CoderDecision(action="create", coder_type=CODER_TYPE_MACHINE),
            "Alice": ci.CoderDecision(action="match", target_user_id=alice.id),
        })
        marked = [m.segment_id for m in db.query(ConsensusStaleTarget).all()]
        assert marked == [pid * 10 + 1]


# ── 9. The ENDPOINTS — entering at the pipeline's mouth ──────────────────────
#
# 🔴 `backend/tests/the internal design notes: a service test proves the functions work and says
# NOTHING about whether the endpoints reach them. Both are `async def` (the
# multipart read), so they ARE wrapped in `asyncio.run`.


class TestTheEndpoints:
    def test_the_whole_loop_reaches_the_database(self, db_session):
        db = db_session
        pid = _segment_project(db)
        user = db.get(User, 1)

        preview = _run(preview_coding_import(
            project_id=pid, file=_upload("unit_id,coder,code\nseg-200-0,GPT-4o,Trust\n"),
            target_kind=ci.TARGET_SEGMENTS, column_id=None, match_column_id=None,
            user=user, db=db,
        ))
        assert preview.will_apply == 1
        assert preview.units_matched == 1
        assert preview.coders[0].name == "GPT-4o"
        assert preview.coders[0].local_user_id is None
        # 🔴 A PREVIEW WRITES NOTHING, including no coder.
        assert db.query(User).filter(User.username == "GPT-4o").first() is None

        result = _run(import_coding(
            project_id=pid, file=_upload("unit_id,coder,code\nseg-200-0,GPT-4o,Trust\n"),
            target_kind=ci.TARGET_SEGMENTS, column_id=None, match_column_id=None,
            coder_mapping=_decisions(**{"GPT-4o": {
                "action": "create", "coder_type": "ai",
                "machine_provenance": {"model": "gpt-4o", "access": "api"},
            }}),
            user=user, db=db,
        ))
        assert result.applied == 1
        machine = db.query(User).filter(User.username == "GPT-4o").one()
        assert machine.coder_type == CODER_TYPE_MACHINE
        assert db.query(CodeApplication).filter(
            CodeApplication.user_id == machine.id).count() == 1

    def test_a_PARTIAL_failure_is_a_200_BODY_with_the_failed_set(self, db_session):
        """#678's rule: never a throw, and the failed set is stated explicitly
        rather than derived from what succeeded."""
        db = db_session
        pid = _segment_project(db)
        result = _run(import_coding(
            project_id=pid,
            file=_upload(
                "unit_id,coder,code\nseg-200-0,Alice,Trust\nnope,Alice,Trust\n"
            ),
            target_kind=ci.TARGET_SEGMENTS, column_id=None, match_column_id=None,
            coder_mapping=_decisions(Alice={"action": "create"}),
            user=db.get(User, 1), db=db,
        ))
        assert result.applied == 1
        assert result.skipped == 1
        assert result.problems[0].reason == ci.REASON_UNIT_NOT_FOUND
        assert result.problems[0].line == 3

    def test_an_unreadable_file_is_a_400_with_the_reason(self, db_session):
        db = db_session
        pid = _segment_project(db)
        with pytest.raises(HTTPException) as exc:
            _run(preview_coding_import(
                project_id=pid, file=_upload("wrong,headers\n1,2\n"),
                target_kind=ci.TARGET_SEGMENTS, column_id=None, match_column_id=None,
                user=db.get(User, 1), db=db,
            ))
        assert exc.value.status_code == 400
        assert "unit_id" in str(exc.value.detail)

    def test_a_malformed_coder_mapping_is_a_400(self, db_session):
        db = db_session
        pid = _segment_project(db)
        with pytest.raises(HTTPException) as exc:
            _run(import_coding(
                project_id=pid, file=_upload("unit_id,coder,code\nseg-200-0,A,Trust\n"),
                target_kind=ci.TARGET_SEGMENTS, column_id=None, match_column_id=None,
                coder_mapping="{not json", user=db.get(User, 1), db=db,
            ))
        assert exc.value.status_code == 400

    def test_the_text_arm_reaches_the_cell(self, db_session):
        db = db_session
        pid, col, _ = _text_project(db)
        result = _run(import_coding(
            project_id=pid, file=_upload("unit_id,coder,code\nR0001,Alice,Trust\n"),
            target_kind=ci.TARGET_TEXT_COLUMN, column_id=col, match_column_id=None,
            coder_mapping=_decisions(Alice={"action": "create"}),
            user=db.get(User, 1), db=db,
        ))
        assert result.applied == 1
        row = db.query(CodeApplication).one()
        assert row.dataset_value_id == pid * 100 + 1
        assert row.segment_id is None


# ── 10. The export is the import's PRODUCER ─────────────────────────────────


class TestTheExportRoundTrips:
    """🔴 The segment arm had NO producer until this column existed.

    `export_coded_segments_csv` wrote Code, Category, Coder, Source, Speaker,
    the segment TEXT, timestamps and ratings — and no unit identifier of any
    kind. So a researcher could not build a file `target_kind='segments'` would
    read, and the whole arm would have been an endpoint nothing could address.

    Found in the pre-implementation review by reading the exporter rather than
    assuming a round trip existed.
    """

    def test_the_export_carries_a_unit_id_and_the_import_reads_it(self, db_session):
        from app.routers.export import export_coded_segments_csv

        db = db_session
        pid = _segment_project(db)
        alice = _coder(db, 40, "Alice")
        db.add(CodeApplication(
            code_id=pid * 100 + 1, user_id=alice.id, segment_id=pid * 10 + 1,
        ))
        db.flush()

        response = _run(export_coded_segments_csv(
            project_id=pid, code_ids=None, exclude_facilitator=True,
            conversation_ids=None, participant_ids=None,
            user=db.get(User, 1), db=db,
        ))
        # ⚠️ Starlette wraps the plain iterator in an ASYNC one, so the body
        # is drained with `asyncio.run` like the endpoint call above.
        async def _drain():
            return "".join([
                c.decode("utf-8") if isinstance(c, bytes) else c
                async for c in response.body_iterator
            ])
        body = _run(_drain())
        rows = list(csv.reader(io.StringIO(body)))
        header, data = rows[0], rows[1]

        # APPENDED — every existing column keeps its position (#35's rule).
        assert header[-1] == "Unit ID"
        assert header[:3] == ["Code", "Category", "Coder"]

        unit_id = data[header.index("Unit ID")]
        # 🔴 The uuid, not the primary key: a `.mmproject` round trip renumbers
        # ids, so a file keyed on one would address other segments afterwards.
        assert unit_id == db.get(Segment, pid * 10 + 1).uuid

        # And the value the export wrote resolves, through the real planner.
        plan = _plan(db, pid, f"unit_id,coder,code\n{unit_id},Alice,Trust\n",
                     target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        assert plan.applications[0].segment_id == pid * 10 + 1
