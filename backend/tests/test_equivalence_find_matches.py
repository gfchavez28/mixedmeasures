"""Tests for the find_matches endpoint on the equivalence groups router.

This is the endpoint that powers the MappingDialog in Variable Groups. It has
two distinct intents:

  1. **Explore** — user selects anchors from ONE dataset and asks the system
     to suggest similar columns in OTHER datasets (fuzzy text matching).
  2. **Confirm** — user already selected anchors from MULTIPLE datasets and
     wants those explicit selections surfaced as guaranteed pairing candidates.

The original implementation only handled (1) and silently returned nothing
for (2), which bubbled up as a "cross-dataset pairing dialog never appears"
bug (#288). These tests lock in the fix.
"""
import asyncio
import pytest

from app.models.project import Project
from app.models.user import User
from app.models.dataset import Dataset, DatasetColumn
from app.models.equivalence_group import EquivalenceGroup
from app.routers.equivalence import find_matches
from app.schemas.equivalence import FindMatchesRequest


def _call_find_matches(project_id: int, column_ids: list[int], db, user: User,
                       min_similarity: float = 0.70):
    """Invoke the async router function synchronously for tests.

    find_matches is `async def` for FastAPI conventions but never actually
    awaits anything — it's pure ORM + Python logic. asyncio.run() is the
    simplest way to call it without spinning up a TestClient.
    """
    return asyncio.run(find_matches(
        project_id=project_id,
        data=FindMatchesRequest(column_ids=column_ids, min_similarity=min_similarity),
        user=user,
        db=db,
    ))


@pytest.fixture
def three_dataset_project(db_session):
    """Three datasets — Board, Staff, Stakeholder — with partially similar columns.

    Board and Staff share near-identical wording for Q1 ("Leadership Vision")
    and Q2 ("Leadership Communication"). Stakeholder deliberately reworrds the
    same constructs ("Strategic direction set by leaders" / "How well leaders
    communicate with external partners") so fuzzy matching will NOT find them
    at the default 0.70 threshold — this simulates the real 360 case where
    wording diverges across stakeholder instruments.
    """
    db = db_session
    project = Project(id=500, name="Find Matches Test", user_id=1)
    db.add(project)

    board = Dataset(id=500, project_id=500, name="Board")
    staff = Dataset(id=501, project_id=500, name="Staff")
    stakeholder = Dataset(id=502, project_id=500, name="Stakeholder")
    db.add_all([board, staff, stakeholder])

    cols = [
        # Board
        DatasetColumn(
            id=5001, dataset_id=500, column_code="Q1", column_name="Q1",
            column_text="Leadership Vision", column_type="ordinal",
            sequence_order=0, display_order=0,
        ),
        DatasetColumn(
            id=5002, dataset_id=500, column_code="Q2", column_name="Q2",
            column_text="Leadership Communication", column_type="ordinal",
            sequence_order=1, display_order=1,
        ),
        DatasetColumn(
            id=5003, dataset_id=500, column_code="Q3", column_name="Q3",
            column_text="Board satisfaction overall", column_type="ordinal",
            sequence_order=2, display_order=2,
        ),
        # Staff (near-identical wording to Board for Q1/Q2)
        DatasetColumn(
            id=5101, dataset_id=501, column_code="Q1", column_name="Q1",
            column_text="Leadership Vision", column_type="ordinal",
            sequence_order=0, display_order=0,
        ),
        DatasetColumn(
            id=5102, dataset_id=501, column_code="Q2", column_name="Q2",
            column_text="Leadership Communication", column_type="ordinal",
            sequence_order=1, display_order=1,
        ),
        DatasetColumn(
            id=5103, dataset_id=501, column_code="Q3", column_name="Q3",
            column_text="Job satisfaction overall", column_type="ordinal",
            sequence_order=2, display_order=2,
        ),
        # Stakeholder (deliberately-different wording for same constructs)
        DatasetColumn(
            id=5201, dataset_id=502, column_code="SQ1", column_name="SQ1",
            column_text="Strategic direction set by the organization",
            column_type="ordinal", sequence_order=0, display_order=0,
        ),
        DatasetColumn(
            id=5202, dataset_id=502, column_code="SQ2", column_name="SQ2",
            column_text="Outreach and engagement with external partners",
            column_type="ordinal", sequence_order=1, display_order=1,
        ),
    ]
    db.add_all(cols)
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return project, user


# ═════════════════════════════════════════════════════════════════════════════
# Explore intent — single-dataset anchor (current behavior preserved)
# ═════════════════════════════════════════════════════════════════════════════


def test_single_dataset_anchor_finds_fuzzy_match_in_other_dataset(three_dataset_project, db_session):
    """Classic explore: pick one anchor, get best fuzzy match per other dataset."""
    _, user = three_dataset_project

    resp = _call_find_matches(500, [5001], db_session, user)  # Board Q1 "Leadership Vision"

    # Should find Staff Q1 (identical text) but not Stakeholder SQ1 (too different)
    target_ids = {m.target_column_id for m in resp.matches}
    assert 5101 in target_ids, "Staff Q1 should match Board Q1 fuzzily"
    assert 5201 not in target_ids, "Stakeholder SQ1 should fall below 0.70 threshold"

    staff_match = next(m for m in resp.matches if m.target_column_id == 5101)
    assert staff_match.similarity >= 0.70
    assert staff_match.user_selected is False
    assert staff_match.anchor_column_id == 5001


def test_single_dataset_multiple_anchors_find_matches_per_anchor(three_dataset_project, db_session):
    """Two anchors from one dataset — each gets its own fuzzy matches in others."""
    _, user = three_dataset_project

    resp = _call_find_matches(500, [5001, 5002], db_session, user)  # Board Q1, Q2

    by_anchor = {}
    for m in resp.matches:
        by_anchor.setdefault(m.anchor_column_id, []).append(m.target_column_id)

    assert 5101 in by_anchor.get(5001, []), "Board Q1 should match Staff Q1"
    assert 5102 in by_anchor.get(5002, []), "Board Q2 should match Staff Q2"
    assert all(not m.user_selected for m in resp.matches)


# ═════════════════════════════════════════════════════════════════════════════
# Confirm intent — cross-dataset anchors (the bug from #288)
# ═════════════════════════════════════════════════════════════════════════════


def test_cross_dataset_anchors_surface_each_other_as_user_selected(three_dataset_project, db_session):
    """The #288 bug: picking anchors from two datasets should expose those anchors
    as guaranteed pair candidates, regardless of text similarity.

    Canonical pair ordering (#289 follow-up): each unordered pair is
    emitted exactly once, in the direction where anchor.id < target.id. Board
    Q1 (5001) < Stakeholder SQ1 (5201) so the pairing surfaces as
    (anchor=5001, target=5201). The reverse direction (anchor=5201,
    target=5001) is NOT emitted — this prevents bidirectional redundancy
    where the dialog would otherwise render the same pairing twice.

    Tier 2 (#300): when anchors span 2+ datasets the endpoint is
    in confirm mode, which emits ONLY user_selected candidates — no fuzzy
    exploration. This test additionally asserts no fuzzy emission."""
    _, user = three_dataset_project

    # Pick Board Q1 and Stakeholder SQ1 — text is dissimilar (< 0.70) but user
    # has explicitly chosen to pair them across datasets.
    resp = _call_find_matches(500, [5001, 5201], db_session, user)

    # Build the per-anchor candidate map
    by_anchor = {}
    for m in resp.matches:
        by_anchor.setdefault(m.anchor_column_id, []).append(m)

    # Board Q1 (lower id) should surface Stakeholder SQ1 as a user_selected candidate
    board_candidates = by_anchor.get(5001, [])
    stakeholder_for_board = [m for m in board_candidates if m.target_column_id == 5201]
    assert len(stakeholder_for_board) == 1, (
        f"Board Q1 should surface Stakeholder SQ1 (canonical direction); "
        f"got {[m.target_column_id for m in board_candidates]}"
    )
    assert stakeholder_for_board[0].user_selected is True
    # Similarity is the actual text similarity score (#299 fix), not hardcoded 1.0.
    # Board Q1 "Leadership Vision" vs Stakeholder SQ1 "Strategic direction set by
    # the organization" are dissimilar, so the score will be low.
    assert 0.0 <= stakeholder_for_board[0].similarity < 0.70

    # Stakeholder SQ1 (higher id) should NOT surface Board Q1 as a user_selected
    # candidate — canonical pair ordering means the pair only appears in the
    # lower-id anchor's section to avoid bidirectional duplicates.
    stakeholder_candidates = by_anchor.get(5201, [])
    board_for_stakeholder = [m for m in stakeholder_candidates if m.target_column_id == 5001]
    assert len(board_for_stakeholder) == 0, (
        "Canonical pair ordering should suppress the Stakeholder→Board "
        "direction because Board Q1's id is lower. The pairing is already "
        "represented in Board Q1's section."
    )

    # Tier 2: confirm mode suppresses fuzzy emission entirely. Every emitted
    # match must be user_selected — no fuzzy noise.
    assert all(m.user_selected for m in resp.matches), (
        f"Expected only user_selected matches in confirm mode, got mixed: "
        f"{[(m.anchor_column_id, m.target_column_id, m.user_selected) for m in resp.matches]}"
    )


def test_confirm_mode_suppresses_fuzzy_in_user_picked_datasets(three_dataset_project, db_session):
    """Tier 2 (#300): when source anchors span 2+ datasets, fuzzy
    emission is suppressed entirely. Replaces the pre-Tier 2 test that
    expected fuzzy alternatives in user-picked datasets.

    Scenario: user picks Board Q1 + Staff Q3 (the "wrong" Staff match).
    Pre-Tier 2, Staff Q1 would have surfaced as a fuzzy alternative for
    Board Q1 (near-identical text). Post-Tier 2, it does NOT — the user
    expressed their intent by picking Staff Q3, and confirm mode respects
    that by emitting only the user_selected pair."""
    _, user = three_dataset_project

    resp = _call_find_matches(500, [5001, 5103], db_session, user)

    # Every match must be user_selected (no fuzzy noise)
    assert all(m.user_selected for m in resp.matches), (
        f"Expected only user_selected matches in confirm mode, got: "
        f"{[(m.anchor_column_id, m.target_column_id, m.user_selected) for m in resp.matches]}"
    )

    # Staff Q1 (id=5101) is a fuzzy match for Board Q1 by text — verify it
    # does NOT appear in the response. Pre-Tier 2, this assertion would fail.
    staff_q1_matches = [m for m in resp.matches if m.target_column_id == 5101]
    assert staff_q1_matches == [], (
        f"Staff Q1 should not surface as a fuzzy alternative in confirm "
        f"mode; got: {staff_q1_matches}"
    )

    # The user_selected pair (Board Q1 → Staff Q3) should be present
    board_candidates = [m for m in resp.matches if m.anchor_column_id == 5001]
    staff_q3_matches = [m for m in board_candidates if m.target_column_id == 5103]
    assert len(staff_q3_matches) == 1, (
        f"Expected user_selected pair Board Q1 → Staff Q3; got "
        f"{[m.target_column_id for m in board_candidates]}"
    )
    assert staff_q3_matches[0].user_selected is True


def test_confirm_mode_suppresses_fuzzy_in_unpicked_datasets(three_dataset_project, db_session):
    """Tier 2 (#300): confirm mode suppresses fuzzy emission across
    ALL datasets, not just user-picked ones. Replaces the pre-Tier 2 test
    that expected fuzzy suggestions from unpicked datasets to continue.

    Adds a 4th Donors dataset with near-identical text for Board Q1.
    Pre-Tier 2, user picking Board + Staff would still get a fuzzy
    suggestion from Donors. Post-Tier 2, no fuzzy from any dataset."""
    _, user = three_dataset_project

    extra_ds = Dataset(id=503, project_id=500, name="Donors")
    db_session.add(extra_ds)
    db_session.add(DatasetColumn(
        id=5301, dataset_id=503, column_code="DQ1", column_name="DQ1",
        column_text="Leadership Vision",  # identical text
        column_type="ordinal", sequence_order=0, display_order=0,
    ))
    db_session.flush()

    # User picks from Board and Staff (confirm mode). Donors should NOT get
    # any fuzzy suggestions because fuzzy emission is suppressed in confirm
    # mode entirely.
    resp = _call_find_matches(500, [5001, 5101], db_session, user)

    donor_targets = [m for m in resp.matches if m.target_dataset_id == 503]
    assert donor_targets == [], (
        f"Confirm mode should suppress fuzzy emission across all datasets; "
        f"got Donors matches: {[m.target_column_id for m in donor_targets]}"
    )

    # Only user_selected matches should be present
    assert all(m.user_selected for m in resp.matches), (
        f"Expected only user_selected matches in confirm mode, got: "
        f"{[(m.anchor_column_id, m.target_column_id, m.user_selected) for m in resp.matches]}"
    )


def test_explore_mode_still_emits_fuzzy_for_single_dataset_source(three_dataset_project, db_session):
    """Tier 2 (#300): explore mode (single-dataset source) continues
    to emit fuzzy matches as before — the fix is narrowly scoped to confirm
    mode. This is a regression guard for the Tier 2 boundary.

    User picks only Board Q1. Staff Q1 (near-identical text) should surface
    as a fuzzy match. The returned matches should all have user_selected=False."""
    _, user = three_dataset_project

    resp = _call_find_matches(500, [5001], db_session, user)

    # Explore mode: every match is fuzzy (not user_selected)
    assert all(not m.user_selected for m in resp.matches), (
        f"Expected only fuzzy matches in explore mode, got user_selected: "
        f"{[(m.anchor_column_id, m.target_column_id, m.user_selected) for m in resp.matches]}"
    )

    # Staff Q1 (the near-identical text match) should surface
    staff_q1_matches = [m for m in resp.matches if m.target_column_id == 5101]
    assert len(staff_q1_matches) == 1, (
        f"Staff Q1 should surface as a fuzzy match in explore mode; got: "
        f"{[m.target_column_id for m in resp.matches]}"
    )
    assert staff_q1_matches[0].similarity >= 0.70


def test_confirm_mode_three_dataset_source_emits_all_pair_combos(three_dataset_project, db_session):
    """Tier 2 coverage: user picks 1 anchor from each of 3 datasets. Canonical
    pair ordering should emit every unordered pair exactly once, and fuzzy
    emission should be suppressed.

    Uses Board Q1 (5001), Staff Q1 (5101), Stakeholder SQ1 (5201). Expected
    pairs (all emitted from lower-ID side): Board Q1 → Staff Q1, Board Q1 →
    Stakeholder SQ1, Staff Q1 → Stakeholder SQ1. Three pairs total."""
    _, user = three_dataset_project

    resp = _call_find_matches(500, [5001, 5101, 5201], db_session, user)

    # All matches user_selected, no fuzzy
    assert all(m.user_selected for m in resp.matches), (
        f"Expected only user_selected matches in confirm mode, got: "
        f"{[(m.anchor_column_id, m.target_column_id, m.user_selected) for m in resp.matches]}"
    )

    # Collect unordered pairs
    pairs = {
        tuple(sorted([m.anchor_column_id, m.target_column_id]))
        for m in resp.matches
    }
    expected_pairs = {
        (5001, 5101),  # Board Q1 ↔ Staff Q1
        (5001, 5201),  # Board Q1 ↔ Stakeholder SQ1
        (5101, 5201),  # Staff Q1 ↔ Stakeholder SQ1
    }
    assert pairs == expected_pairs, (
        f"Expected 3 pair combos {expected_pairs}, got {pairs}"
    )

    # Each pair emitted exactly once
    assert len(resp.matches) == 3, (
        f"Expected 3 matches (one per pair, canonical ordering); got "
        f"{len(resp.matches)}: {[(m.anchor_column_id, m.target_column_id) for m in resp.matches]}"
    )


def test_multiple_anchors_in_same_target_dataset_all_surface(three_dataset_project, db_session):
    """User picks Board Q1 + Staff Q1 + Staff Q2. Under the #299 follow-up
    model, ALL user-selected candidates in the same target dataset surface
    — the previous per-dataset best-match collapse has been removed so
    users can pick a different pairing than the one the system would have
    suggested. The 1:1-per-equivalence-group rule is still enforced, but at
    confirmation time via the frontend scoped disable (one checked per
    anchor section per dataset) and at creation time via the backend
    router validator from #289.

    Fixture: Board Q1 and Staff Q1 share text "Leadership Vision"; Staff Q2
    is "Leadership Communication". Both surface for Board Q1 with accurate
    similarity scores — Staff Q1 should score very high (identical), Staff
    Q2 should score lower."""
    _, user = three_dataset_project

    resp = _call_find_matches(500, [5001, 5101, 5102], db_session, user)

    board_candidates = [m for m in resp.matches if m.anchor_column_id == 5001]
    staff_targets = sorted(
        [m for m in board_candidates if m.target_dataset_id == 501],
        key=lambda m: m.target_column_id,
    )
    assert len(staff_targets) == 2, (
        f"Both Staff candidates (5101, 5102) should surface for Board Q1 "
        f"now that the per-dataset collapse is removed; got "
        f"{[m.target_column_id for m in staff_targets]}"
    )
    assert {m.target_column_id for m in staff_targets} == {5101, 5102}
    # Both should be user_selected
    for m in staff_targets:
        assert m.user_selected is True
    # Staff Q1 (identical text) should score higher than Staff Q2
    staff_q1 = next(m for m in staff_targets if m.target_column_id == 5101)
    staff_q2 = next(m for m in staff_targets if m.target_column_id == 5102)
    assert staff_q1.similarity > staff_q2.similarity
    assert staff_q1.similarity >= 0.95, "Identical text should score near 1.0"


def test_canonical_pair_ordering_avoids_bidirectional_duplicates(three_dataset_project, db_session):
    """Regression guard for the bidirectional duplicates bug (#289
    follow-up). User picks 3 Board + 3 Staff anchors. Before canonical pair
    ordering, the response would contain 6 user-selected matches (each pair
    emitted from both directions). After canonical ordering (lower anchor id
    → higher id only), the response contains at most 3 — one per pair, all
    surfacing in the Board section (since Board ids < Staff ids).

    This is the 5+5 redundancy case from the user's bug report, exercised
    at 3+3 using the existing fixture."""
    _, user = three_dataset_project

    # 3 Board (5001, 5002, 5003) + 3 Staff (5101, 5102, 5103)
    resp = _call_find_matches(500, [5001, 5002, 5003, 5101, 5102, 5103], db_session, user)

    user_selected = [m for m in resp.matches if m.user_selected]

    # Each unordered pair should appear at most once
    pairs = {tuple(sorted([m.anchor_column_id, m.target_column_id])) for m in user_selected}
    assert len(user_selected) == len(pairs), (
        f"Canonical ordering should emit each pair exactly once, got "
        f"{len(user_selected)} matches for {len(pairs)} unordered pairs: "
        f"{[(m.anchor_column_id, m.target_column_id) for m in user_selected]}"
    )

    # Every emitted match should have anchor_id < target_id
    for m in user_selected:
        assert m.anchor_column_id < m.target_column_id, (
            f"Canonical direction violated: anchor={m.anchor_column_id}, "
            f"target={m.target_column_id}"
        )

    # And Staff anchor sections (higher ids) should have no user_selected
    # candidates — the pairings are all represented in Board sections.
    staff_user_selected = [m for m in user_selected if m.anchor_column_id in {5101, 5102, 5103}]
    assert staff_user_selected == [], (
        f"Staff anchor sections should have no user_selected candidates under "
        f"canonical ordering; got {staff_user_selected}"
    )


# ═════════════════════════════════════════════════════════════════════════════
# Already-linked equivalence groups
# ═════════════════════════════════════════════════════════════════════════════


def test_user_selected_candidate_reports_already_linked(three_dataset_project, db_session):
    """If the two user-picked anchors are already in the same equivalence group,
    already_linked should be true so the UI can show them as pre-existing."""
    _, user = three_dataset_project

    eq = EquivalenceGroup(id=6000, project_id=500, label="Vision")
    db_session.add(eq)
    db_session.flush()
    board_q1 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5001).one()
    staff_q1 = db_session.query(DatasetColumn).filter(DatasetColumn.id == 5101).one()
    board_q1.equivalence_group_id = 6000
    staff_q1.equivalence_group_id = 6000
    db_session.flush()

    resp = _call_find_matches(500, [5001, 5101], db_session, user)

    pair = next(
        (m for m in resp.matches if m.anchor_column_id == 5001 and m.target_column_id == 5101),
        None,
    )
    assert pair is not None
    assert pair.user_selected is True
    assert pair.already_linked is True


# ═════════════════════════════════════════════════════════════════════════════
# Regression guards
# ═════════════════════════════════════════════════════════════════════════════


def test_empty_anchor_list_returns_empty(three_dataset_project, db_session):
    _, user = three_dataset_project
    # FindMatchesRequest enforces min_length=1 via Pydantic, so we test the
    # "anchor IDs don't exist" path instead.
    resp = _call_find_matches(500, [99999], db_session, user)
    assert resp.matches == []


def test_skip_column_type_excluded_from_fuzzy(three_dataset_project, db_session):
    """Skip-typed columns should never appear in the match results."""
    _, user = three_dataset_project

    # Add a skip column in Staff with identical text to Board Q1
    db_session.add(DatasetColumn(
        id=5199, dataset_id=501, column_code="SK", column_name="SK",
        column_text="Leadership Vision", column_type="skip",
        sequence_order=3, display_order=3,
    ))
    db_session.flush()

    resp = _call_find_matches(500, [5001], db_session, user)
    target_ids = {m.target_column_id for m in resp.matches}
    assert 5199 not in target_ids, "Skip-typed columns must be excluded"
