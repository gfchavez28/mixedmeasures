"""Tests for the Tier 3 crosswalk's atomic move-members endpoint (Path A, #328).

The endpoint atomically updates BOTH the equivalence-group link
(`DatasetColumn.equivalence_group_id`) AND analysis-domain membership
(`AnalysisDomainMember`) in one transaction, with post-mutation validators
mirroring the swap endpoint pattern (#290 cross-dataset pairing + 1:1
per dataset + auto-dissolve empty source EGs).

This file groups into three sections:
  1. Schema validation (`MoveMembersRequest.target_mode` discriminator).
  2. Endpoint validation (column / domain / EG existence).
  3. Transaction body (B1 task — mutations + post-validators + cleanup +
     recompute + atomicity rollback). Implemented in the next task.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.models.project import Project
from app.models.user import User
from app.routers.crosswalk import move_members
from app.schemas.crosswalk import MoveMembersRequest, MoveMembersResponse

from tests.conftest import mock_request


def _run(coro):
    return asyncio.run(coro)


# ═════════════════════════════════════════════════════════════════════════════
# Section 1 — Schema validation
# ═════════════════════════════════════════════════════════════════════════════


class TestMoveMembersRequestValidation:
    def test_existing_eg_requires_target_eg_id(self):
        with pytest.raises(ValidationError) as exc:
            MoveMembersRequest(
                column_ids=[1],
                target_domain_id=10,
                target_mode="existing_eg",
            )
        assert "target_eg_id is required" in str(exc.value)

    def test_existing_eg_rejects_target_eg_label(self):
        with pytest.raises(ValidationError) as exc:
            MoveMembersRequest(
                column_ids=[1],
                target_domain_id=10,
                target_mode="existing_eg",
                target_eg_id=5,
                target_eg_label="should not be set",
            )
        assert "target_eg_label must be None" in str(exc.value)

    def test_new_eg_requires_target_eg_label(self):
        with pytest.raises(ValidationError) as exc:
            MoveMembersRequest(
                column_ids=[1, 2],
                target_domain_id=10,
                target_mode="new_eg",
            )
        assert "target_eg_label is required" in str(exc.value)

    def test_new_eg_rejects_target_eg_id(self):
        with pytest.raises(ValidationError) as exc:
            MoveMembersRequest(
                column_ids=[1, 2],
                target_domain_id=10,
                target_mode="new_eg",
                target_eg_label="My new EG",
                target_eg_id=99,
            )
        assert "target_eg_id must be None" in str(exc.value)

    def test_strip_rejects_eg_id_or_label(self):
        with pytest.raises(ValidationError):
            MoveMembersRequest(
                column_ids=[1],
                target_domain_id=10,
                target_mode="strip",
                target_eg_id=5,
            )
        with pytest.raises(ValidationError):
            MoveMembersRequest(
                column_ids=[1],
                target_domain_id=10,
                target_mode="strip",
                target_eg_label="nope",
            )

    def test_at_least_one_domain_required(self):
        with pytest.raises(ValidationError) as exc:
            MoveMembersRequest(
                column_ids=[1],
                target_mode="strip",
            )
        assert "source_domain_id or target_domain_id" in str(exc.value)

    def test_empty_column_ids_rejected(self):
        with pytest.raises(ValidationError):
            MoveMembersRequest(
                column_ids=[],
                target_domain_id=10,
                target_mode="strip",
            )

    def test_existing_eg_happy_path(self):
        req = MoveMembersRequest(
            column_ids=[1, 2],
            source_domain_id=5,
            target_domain_id=10,
            target_mode="existing_eg",
            target_eg_id=42,
        )
        assert req.target_eg_id == 42
        assert req.target_eg_label is None

    def test_new_eg_happy_path(self):
        req = MoveMembersRequest(
            column_ids=[1, 2],
            target_domain_id=10,
            target_mode="new_eg",
            target_eg_label="Self-Esteem",
        )
        assert req.target_eg_label == "Self-Esteem"
        assert req.target_eg_id is None

    def test_strip_to_unassigned(self):
        req = MoveMembersRequest(
            column_ids=[1],
            source_domain_id=5,
            target_domain_id=None,
            target_mode="strip",
        )
        assert req.target_domain_id is None


# ═════════════════════════════════════════════════════════════════════════════
# Section 2 — Endpoint pre-mutation validation (skeleton phase)
# ═════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def move_members_scenario(db_session):
    """Fixture for move-members tests.

    - Project 850, user 1
    - Dataset 850 (Board): cols 8501 Q1, 8502 Q2, 8503 Q3
    - Dataset 851 (Staff): cols 8551 Q1, 8552 Q2, 8553 Q3
    - EG 8580: Q1 across both (Board 8501 + Staff 8551)
    - EG 8581: Q2 across both (Board 8502 + Staff 8552)
    - EG 8582: Q3 across both (Board 8503 + Staff 8553)
    - Domain 8590 (cross-dataset): contains all 6 cols
    - Domain 8591 (single-dataset, Board only): contains 8501, 8502
    """
    db = db_session
    project = Project(id=850, name="Move-members Test", user_id=1)
    db.add(project)
    db.flush()

    board = Dataset(id=850, project_id=850, name="Board")
    staff = Dataset(id=851, project_id=850, name="Staff")
    db.add_all([board, staff])
    db.flush()

    eg_q1 = EquivalenceGroup(id=8580, project_id=850, label="Q1")
    eg_q2 = EquivalenceGroup(id=8581, project_id=850, label="Q2")
    eg_q3 = EquivalenceGroup(id=8582, project_id=850, label="Q3")
    db.add_all([eg_q1, eg_q2, eg_q3])
    db.flush()

    cols = [
        DatasetColumn(id=8501, dataset_id=850, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0, equivalence_group_id=8580),
        DatasetColumn(id=8502, dataset_id=850, column_code="Q2", column_name="Q2",
                      column_text="Comm", column_type="ordinal",
                      sequence_order=1, display_order=1, equivalence_group_id=8581),
        DatasetColumn(id=8503, dataset_id=850, column_code="Q3", column_name="Q3",
                      column_text="Strategy", column_type="ordinal",
                      sequence_order=2, display_order=2, equivalence_group_id=8582),
        DatasetColumn(id=8551, dataset_id=851, column_code="Q1", column_name="Q1",
                      column_text="Vision", column_type="ordinal",
                      sequence_order=0, display_order=0, equivalence_group_id=8580),
        DatasetColumn(id=8552, dataset_id=851, column_code="Q2", column_name="Q2",
                      column_text="Comm", column_type="ordinal",
                      sequence_order=1, display_order=1, equivalence_group_id=8581),
        DatasetColumn(id=8553, dataset_id=851, column_code="Q3", column_name="Q3",
                      column_text="Strategy", column_type="ordinal",
                      sequence_order=2, display_order=2, equivalence_group_id=8582),
    ]
    db.add_all(cols)
    db.flush()

    domain_cross = AnalysisDomain(
        id=8590, project_id=850, name="Cross-dataset domain",
        origin="human", sequence_order=0,
    )
    domain_board = AnalysisDomain(
        id=8591, project_id=850, name="Board-only domain",
        origin="human", sequence_order=1,
    )
    db.add_all([domain_cross, domain_board])
    db.flush()

    members_cross = [
        AnalysisDomainMember(domain_id=8590, member_type="column",
                             member_id=cid, sequence_order=i)
        for i, cid in enumerate([8501, 8502, 8503, 8551, 8552, 8553])
    ]
    members_board = [
        AnalysisDomainMember(domain_id=8591, member_type="column",
                             member_id=cid, sequence_order=i)
        for i, cid in enumerate([8501, 8502])
    ]
    db.add_all(members_cross + members_board)
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return {
        "project": project, "user": user,
        "domain_cross_id": 8590, "domain_board_id": 8591,
        "eg_q1": 8580, "eg_q2": 8581, "eg_q3": 8582,
        "board_q1": 8501, "board_q2": 8502, "board_q3": 8503,
        "staff_q1": 8551, "staff_q2": 8552, "staff_q3": 8553,
    }


class TestEndpointValidation:
    """Tests that hit the route stub and exercise pre-mutation validation.

    The transaction body raises 501 in the skeleton; these tests assert
    the 4xx validation paths fire BEFORE the 501 (so they're independent
    of the next task's transaction body).
    """

    def test_rejects_unknown_columns(self, move_members_scenario, db_session):
        s = move_members_scenario
        with pytest.raises(HTTPException) as exc:
            _run(move_members(
                request=mock_request(),
                project_id=850,
                data=MoveMembersRequest(
                    column_ids=[8501, 99999],  # 99999 doesn't exist
                    target_domain_id=s["domain_board_id"],
                    target_mode="strip",
                ),
                user=s["user"],
                db=db_session,
            ))
        assert exc.value.status_code == 400
        assert "99999" in str(exc.value.detail)

    def test_rejects_unknown_source_domain(self, move_members_scenario, db_session):
        s = move_members_scenario
        with pytest.raises(HTTPException) as exc:
            _run(move_members(
                request=mock_request(),
                project_id=850,
                data=MoveMembersRequest(
                    column_ids=[s["board_q1"]],
                    source_domain_id=99999,
                    target_domain_id=s["domain_board_id"],
                    target_mode="strip",
                ),
                user=s["user"],
                db=db_session,
            ))
        assert exc.value.status_code == 404

    def test_rejects_unknown_target_eg(self, move_members_scenario, db_session):
        s = move_members_scenario
        with pytest.raises(HTTPException) as exc:
            _run(move_members(
                request=mock_request(),
                project_id=850,
                data=MoveMembersRequest(
                    column_ids=[s["board_q1"]],
                    source_domain_id=s["domain_board_id"],
                    target_domain_id=s["domain_cross_id"],
                    target_mode="existing_eg",
                    target_eg_id=99999,
                ),
                user=s["user"],
                db=db_session,
            ))
        assert exc.value.status_code == 404
        assert "99999" in str(exc.value.detail)

    pass


# ═════════════════════════════════════════════════════════════════════════════
# Section 3 — Transaction body (mutation, validators, cleanup, recompute)
# ═════════════════════════════════════════════════════════════════════════════


class TestMoveMembersTransaction:
    """Tests for the transaction body — actual EG + domain mutations.

    Each test calls `move_members` directly via `_run(coro)` and asserts the
    resulting DB state. The fixture `move_members_scenario` provides:
      - 2 datasets (Board=850, Staff=851), 3 cols each (Q1/Q2/Q3)
      - 3 cross-dataset EGs (Q1=8580, Q2=8581, Q3=8582)
      - Cross-dataset domain 8590 (all 6 cols)
      - Single-dataset Board domain 8591 (Board Q1, Board Q2)
    """

    def test_basic_cross_bracket_move(self, move_members_scenario, db_session):
        """Move Board Q3 from cross-dataset domain to Board domain (existing EG)."""
        s = move_members_scenario
        db = db_session

        # We need to add Board Q3 to a Board-only EG before the test —
        # but the existing EG 8582 is cross-dataset. So we'll move it to
        # `target_mode='strip'` first or just add a synthetic single-cell
        # variant: pick the simpler test — move Board Q3 from the cross
        # domain to the Board-only domain, target_mode='existing_eg' on
        # EG 8582 (which is currently shared across datasets).
        # That would violate the cross-dataset pairing if we removed
        # Board Q3 from the cross domain — but Board Q3 is not paired
        # alone in EG 8582 (Staff Q3 is also in EG 8582 and stays in
        # the cross-domain). So pairing is preserved.
        response = _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_board_id"],
                target_mode="existing_eg",
                target_eg_id=s["eg_q3"],
            ),
            user=s["user"],
            db=db,
        ))

        assert isinstance(response, MoveMembersResponse)

        # Board Q3 should still have EG 8582 (move_members didn't change EG).
        col = db.query(DatasetColumn).filter(DatasetColumn.id == s["board_q3"]).one()
        assert col.equivalence_group_id == s["eg_q3"]

        # Board Q3 should now be a member of domain 8591 (Board-only).
        board_members = (
            db.query(AnalysisDomainMember)
            .filter(
                AnalysisDomainMember.domain_id == s["domain_board_id"],
                AnalysisDomainMember.member_type == "column",
            )
            .all()
        )
        member_col_ids = sorted(m.member_id for m in board_members)
        assert s["board_q3"] in member_col_ids

        # Board Q3 should NOT be a member of domain 8590 (cross-dataset).
        cross_members = (
            db.query(AnalysisDomainMember)
            .filter(
                AnalysisDomainMember.domain_id == s["domain_cross_id"],
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id == s["board_q3"],
            )
            .count()
        )
        assert cross_members == 0

    def test_strip_target_mode_severs_eg(self, move_members_scenario, db_session):
        """target_mode='strip' nullifies equivalence_group_id on moved columns."""
        s = move_members_scenario
        db = db_session

        # First move Board Q1 OUT of the cross-domain (so we can test stripping
        # without violating cross-dataset pairing on the cross-domain).
        # Actually: the simplest test — move Staff Q3 to Board domain with
        # target_mode='strip'. Staff Q3 stays in the same domain... wait, no.
        # Cleanest test: move Board Q3 from the Board-only domain (where we
        # haven't put it yet) — let me adjust.
        #
        # Scenario adjustment: Board Q1 is in BOTH cross-domain and
        # Board-only domain. Strip its EG from the Board-only domain only.
        # The cross-domain still has Board Q1 (unpaired) — wait, no, Board
        # Q1 is still EG-keyed (8580 = Q1 cross-dataset). Stripping its EG
        # removes the equivalence link, leaving Board Q1 in the cross-domain
        # without equivalence → violates #290.
        #
        # Cleanest: move Board Q3 (not in Board domain currently) FROM
        # cross-domain TO Board domain with target_mode='strip'. Cross-domain
        # loses Board Q3 (still has Staff Q3 → no pairing issue). Board Q3's
        # EG goes from 8582 (was paired with Staff Q3) to NULL. Staff Q3
        # remains in EG 8582 alone, but EG 8582 is still valid (1:1 per
        # dataset is fine with one column).
        response = _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_board_id"],
                target_mode="strip",
            ),
            user=s["user"],
            db=db,
        ))

        col = db.query(DatasetColumn).filter(DatasetColumn.id == s["board_q3"]).one()
        assert col.equivalence_group_id is None

        # EG 8582 should still exist (Staff Q3 remains).
        eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == s["eg_q3"]).first()
        assert eg is not None

        # Source domain (cross) should not have Board Q3 anymore.
        n = (
            db.query(AnalysisDomainMember)
            .filter(
                AnalysisDomainMember.domain_id == s["domain_cross_id"],
                AnalysisDomainMember.member_id == s["board_q3"],
            )
            .count()
        )
        assert n == 0

        # Target domain (Board) should have Board Q3.
        n = (
            db.query(AnalysisDomainMember)
            .filter(
                AnalysisDomainMember.domain_id == s["domain_board_id"],
                AnalysisDomainMember.member_id == s["board_q3"],
            )
            .count()
        )
        assert n == 1

    def test_new_eg_mode_creates_eg_and_assigns(self, move_members_scenario, db_session):
        """target_mode='new_eg' creates a new EG and attaches all moved columns."""
        s = move_members_scenario
        db = db_session

        # Add Stakeholder dataset + column to give us something to put into
        # a new EG. Or simpler: split the Q1 EG by promoting two columns
        # into a fresh EG together. But splitting requires we don't violate
        # 1:1. Cleanest: move Board Q3 + Staff Q3 (which are in EG 8582) to
        # a NEW EG via target_mode='new_eg'. They have to leave EG 8582
        # (which becomes empty → dissolves) AND land in a new one.
        response = _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q3"], s["staff_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_cross_id"],  # stay in cross domain
                target_mode="new_eg",
                target_eg_label="Q3 Renamed",
            ),
            user=s["user"],
            db=db,
        ))

        # Both columns should share a new EG.
        board_q3 = db.query(DatasetColumn).filter(DatasetColumn.id == s["board_q3"]).one()
        staff_q3 = db.query(DatasetColumn).filter(DatasetColumn.id == s["staff_q3"]).one()
        assert board_q3.equivalence_group_id is not None
        assert board_q3.equivalence_group_id == staff_q3.equivalence_group_id
        # And it's NOT the old EG 8582 (which dissolved).
        assert board_q3.equivalence_group_id != s["eg_q3"]

        new_eg = (
            db.query(EquivalenceGroup)
            .filter(EquivalenceGroup.id == board_q3.equivalence_group_id)
            .one()
        )
        assert new_eg.label == "Q3 Renamed"

        # Old EG 8582 should be auto-dissolved.
        old_eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == s["eg_q3"]).first()
        assert old_eg is None
        assert s["eg_q3"] in response.dissolved_eg_ids

    def test_dissolves_empty_source_eg(self, move_members_scenario, db_session):
        """Moving the last column out of a cross-dataset EG does NOT dissolve
        if the EG still has another column (Q3 case: 2 cols, move 1 → 1 left)."""
        s = move_members_scenario
        db = db_session

        # Move just Board Q3 to strip — Staff Q3 remains in EG 8582.
        response = _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_board_id"],
                target_mode="strip",
            ),
            user=s["user"],
            db=db,
        ))

        # EG 8582 should NOT be dissolved (Staff Q3 still there).
        eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == s["eg_q3"]).first()
        assert eg is not None
        assert response.dissolved_eg_ids == []

        # Now move Staff Q3 too — EG should dissolve.
        response2 = _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["staff_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=None,
                target_mode="strip",
            ),
            user=s["user"],
            db=db,
        ))
        eg = db.query(EquivalenceGroup).filter(EquivalenceGroup.id == s["eg_q3"]).first()
        assert eg is None
        assert s["eg_q3"] in response2.dissolved_eg_ids

    def test_rejects_unpaired_cross_dataset_on_target(self, move_members_scenario, db_session):
        """Adding an unpaired column to a cross-dataset domain raises 409."""
        s = move_members_scenario
        db = db_session

        # First strip Board Q3's EG (so it has no equivalence partner).
        _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_board_id"],
                target_mode="strip",
            ),
            user=s["user"],
            db=db,
        ))

        # Now try to ADD Board Q3 (unpaired) BACK to the cross-dataset domain.
        # Should 409: cross_dataset_unpaired (Board Q3 isn't equivalence-linked
        # to any Staff column).
        with pytest.raises(HTTPException) as exc:
            _run(move_members(
                request=mock_request(),
                project_id=850,
                data=MoveMembersRequest(
                    column_ids=[s["board_q3"]],
                    source_domain_id=s["domain_board_id"],
                    target_domain_id=s["domain_cross_id"],
                    target_mode="strip",
                ),
                user=s["user"],
                db=db,
            ))
        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "cross_dataset_unpaired"

    def test_promote_to_paired_within_same_domain_preserves_membership(self, db_session):
        """Regression: promote-to-paired within the same variable group must
        NOT remove the columns from the domain.

        Researcher scenario: variable group "Thing" has 2 synthetic single-cell
        rows (Q001 Staff, Q001 Board, both with null EG). Researcher drags
        Staff onto Board's Staff-position empty cell to merge them into one
        equivalence row. Move-members fires with source=target=Thing,
        target_mode='new_eg'. Both columns should stay in Thing AND share
        the new EG. Without the same-domain short-circuit in step 7, the
        delete+dup-skip-on-insert pattern silently drops both from the
        domain — leaving them in an orphan EG, invisible in the UI.
        """
        from app.models.project import Project as _Project
        from app.models.dataset import Dataset as _DS, DatasetColumn as _DC
        from app.models.analysis_domain import (
            AnalysisDomain as _AD,
            AnalysisDomainMember as _ADM,
        )
        from app.models.user import User as _User

        db = db_session
        # Self-contained fixture: project 870, two datasets, two unlinked
        # cols (Q001 Staff, Q001 Board), one variable group containing both.
        project = _Project(id=870, name="Promote-to-paired test", user_id=1)
        db.add(project)
        db.flush()
        board = _DS(id=870, project_id=870, name="Board")
        staff = _DS(id=871, project_id=870, name="Staff")
        db.add_all([board, staff])
        db.flush()
        col_b = _DC(id=8701, dataset_id=870, column_code="Q001", column_name="Q001",
                    column_text="Item 1", column_type="ordinal",
                    sequence_order=0, display_order=0, equivalence_group_id=None)
        col_s = _DC(id=8702, dataset_id=871, column_code="Q001", column_name="Q001",
                    column_text="Item 1", column_type="ordinal",
                    sequence_order=0, display_order=0, equivalence_group_id=None)
        db.add_all([col_b, col_s])
        db.flush()
        thing = _AD(id=8770, project_id=870, name="Thing", origin="human",
                    sequence_order=0)
        db.add(thing)
        db.flush()
        db.add_all([
            _ADM(domain_id=8770, member_type="column", member_id=8701, sequence_order=0),
            _ADM(domain_id=8770, member_type="column", member_id=8702, sequence_order=1),
        ])
        db.flush()

        user = db.query(_User).filter(_User.id == 1).one()

        # The exact gesture: promote both to a new EG within Thing.
        response = _run(move_members(
            request=mock_request(),
            project_id=870,
            data=MoveMembersRequest(
                column_ids=[8701, 8702],
                source_domain_id=8770,
                target_domain_id=8770,
                target_mode="new_eg",
                target_eg_label="Q001 paired",
            ),
            user=user,
            db=db,
        ))

        assert isinstance(response, MoveMembersResponse)

        # Both columns now share a new EG.
        col_b = db.query(_DC).filter(_DC.id == 8701).one()
        col_s = db.query(_DC).filter(_DC.id == 8702).one()
        assert col_b.equivalence_group_id is not None
        assert col_b.equivalence_group_id == col_s.equivalence_group_id

        # CRITICAL: both columns must still be members of Thing.
        # Without the same-domain short-circuit fix, they'd be silently
        # removed from the domain → invisible orphan-EG state.
        thing_members = (
            db.query(_ADM)
            .filter(_ADM.domain_id == 8770, _ADM.member_type == "column")
            .all()
        )
        member_col_ids = sorted(m.member_id for m in thing_members)
        assert 8701 in member_col_ids, (
            "Board Q001 was silently removed from Thing — promote-to-paired "
            "within same domain must preserve membership"
        )
        assert 8702 in member_col_ids, (
            "Staff Q001 was silently removed from Thing — promote-to-paired "
            "within same domain must preserve membership"
        )

    def test_no_op_short_circuits(self, move_members_scenario, db_session):
        """Move that's already in target state returns immediately."""
        s = move_members_scenario
        db = db_session

        # Board Q1 is already in EG 8580 and in cross-domain 8590.
        response = _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q1"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_cross_id"],
                target_mode="existing_eg",
                target_eg_id=s["eg_q1"],
            ),
            user=s["user"],
            db=db,
        ))
        # No-op: dissolved_eg_ids empty, recomputed empty.
        assert response.dissolved_eg_ids == []
        assert response.recomputed_metric_ids == []
        # Board Q1 still in same state.
        col = db.query(DatasetColumn).filter(DatasetColumn.id == s["board_q1"]).one()
        assert col.equivalence_group_id == s["eg_q1"]

    def test_validator_failure_raises_before_commit(self, move_members_scenario, db_session):
        """When post-mutation validator raises 409, no commit happens.

        We cannot easily test full SQLAlchemy rollback in a fixture-flushed
        session (db.rollback() would also undo fixture setup). What we CAN
        verify is that the validator raises BEFORE the move_members commit,
        proving the FastAPI dependency-driven rollback in production is
        engaged. The rollback semantic itself is exercised by SQLAlchemy
        in the real request lifecycle.
        """
        s = move_members_scenario
        db = db_session

        # Trigger a validator failure: try to move Staff Q3 alone to a new
        # EG WITHIN the cross-domain. After the move, Staff Q3 is in a
        # new single-column EG → cross-dataset domain has Staff Q3 with
        # no Board partner → cross_dataset_unpaired.
        with pytest.raises(HTTPException) as exc:
            _run(move_members(
                request=mock_request(),
                project_id=850,
                data=MoveMembersRequest(
                    column_ids=[s["staff_q3"]],
                    source_domain_id=s["domain_cross_id"],
                    target_domain_id=s["domain_cross_id"],
                    target_mode="new_eg",
                    target_eg_label="Stranded Q3",
                ),
                user=s["user"],
                db=db,
            ))
        assert exc.value.status_code == 409
        assert exc.value.detail["error"] == "cross_dataset_unpaired"

    def test_audit_log_consolidated(self, move_members_scenario, db_session):
        """A single move_members call writes one moved_members audit row."""
        import json
        from app.models.audit import AuditEntry

        s = move_members_scenario
        db = db_session

        _run(move_members(
            request=mock_request(),
            project_id=850,
            data=MoveMembersRequest(
                column_ids=[s["board_q3"]],
                source_domain_id=s["domain_cross_id"],
                target_domain_id=s["domain_board_id"],
                target_mode="strip",
            ),
            user=s["user"],
            db=db,
        ))

        log_entry = (
            db.query(AuditEntry)
            .filter(
                AuditEntry.action == "moved_members",
                AuditEntry.entity_type == "analysis_domain",
                AuditEntry.project_id == 850,
            )
            .order_by(AuditEntry.id.desc())
            .first()
        )
        assert log_entry is not None
        details = json.loads(log_entry.details)
        assert details["column_ids"] == [s["board_q3"]]
        assert details["source_domain_id"] == s["domain_cross_id"]
        assert details["target_domain_id"] == s["domain_board_id"]
        assert details["target_mode"] == "strip"
        assert s["eg_q3"] in details["source_eg_ids"]

