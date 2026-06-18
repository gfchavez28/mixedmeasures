"""Tests for #354 — codebook network endpoint surfaces the total
non-universal code count so the frontend can render "Showing N of M codes".

The cooccurrence endpoint silently drops codes with zero applications (after
the default `exclude_facilitator=True` filter). Tree shows all codes; network
shows only the subset with co-occurrence-eligible footprints. Without a total
denominator, the frontend can't explain the discrepancy. The fix adds
`total_codes_in_project` to `CodebookCooccurrenceResponse`.

Universe of M (denominator): non-universal codes that pass the `include_inactive`
filter. Matches the universe the network draws from, so M is directly
comparable to N.
"""
import asyncio
import pytest

from app.models.project import Project
from app.models.user import User
from app.models.code import Code
from app.routers.codebook import get_codebook_cooccurrence


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project_with_codes(db_session):
    """Create a project with: 2 universal codes (numeric_id 0, 1), 5 active
    non-universal codes, 2 inactive non-universal codes. No applications.

    Total non-universal: 7. Of those, 5 are active.
    Network universe with include_inactive=False: 5 codes.
    Network universe with include_inactive=True: 7 codes.
    All have seg_count=0, so nodes.length will be 0 in both cases.
    """
    db = db_session
    db.add(Project(id=800, name="Codebook counts test", user_id=1))
    db.flush()

    # Universal codes (numeric_id 0 and 1 are reserved per memory; is_universal=True flag).
    db.add_all([
        Code(id=8000, project_id=800, numeric_id=0, name="(uncoded)",
             is_universal=True, is_active=True),
        Code(id=8001, project_id=800, numeric_id=1, name="(double-coded)",
             is_universal=True, is_active=True),
    ])

    # 5 active non-universal codes.
    for i in range(5):
        db.add(Code(id=8100 + i, project_id=800, numeric_id=100 + i,
                    name=f"Active code {i}", is_universal=False, is_active=True))

    # 2 inactive non-universal codes.
    for i in range(2):
        db.add(Code(id=8200 + i, project_id=800, numeric_id=200 + i,
                    name=f"Inactive code {i}", is_universal=False, is_active=False))

    db.flush()
    user = db.query(User).filter(User.id == 1).one()
    return user


def test_response_includes_total_codes_in_project(project_with_codes, db_session):
    """The new field is present + populated."""
    user = project_with_codes
    resp = _run(get_codebook_cooccurrence(
        project_id=800,
        hierarchy_level=-1,
        conversation_ids=None,
        text_column_ids=None,
        exclude_facilitator=True,
        include_inactive=False,
        min_segments=None,
        max_segments=None,
        user=user,
        db=db_session,
    ))
    assert hasattr(resp, "total_codes_in_project")
    # 5 active non-universal codes (universals always excluded).
    assert resp.total_codes_in_project == 5


def test_total_count_excludes_universal_codes(project_with_codes, db_session):
    """Universal codes (the (uncoded)/(double-coded) reserved IDs) MUST be
    excluded from the M denominator. The network never renders them, so
    M directly compares to N without confusion."""
    user = project_with_codes
    resp = _run(get_codebook_cooccurrence(
        project_id=800,
        hierarchy_level=-1,
        conversation_ids=None,
        text_column_ids=None,
        exclude_facilitator=True,
        include_inactive=False,
        min_segments=None,
        max_segments=None,
        user=user,
        db=db_session,
    ))
    # If universals were counted, this would be 7 (5 active non-universal +
    # 2 universals). Must be 5.
    assert resp.total_codes_in_project == 5


def test_total_count_respects_include_inactive_param(project_with_codes, db_session):
    """When include_inactive=True, the inactive codes join the universe."""
    user = project_with_codes
    resp = _run(get_codebook_cooccurrence(
        project_id=800,
        hierarchy_level=-1,
        conversation_ids=None,
        text_column_ids=None,
        exclude_facilitator=True,
        include_inactive=True,
        min_segments=None,
        max_segments=None,
        user=user,
        db=db_session,
    ))
    # 5 active + 2 inactive non-universal = 7.
    assert resp.total_codes_in_project == 7


def test_total_count_zero_for_empty_project(db_session):
    """Empty project (no codes) returns 0, not None or missing."""
    db = db_session
    db.add(Project(id=801, name="Empty", user_id=1))
    db.flush()
    user = db.query(User).filter(User.id == 1).one()
    resp = _run(get_codebook_cooccurrence(
        project_id=801,
        hierarchy_level=-1,
        conversation_ids=None,
        text_column_ids=None,
        exclude_facilitator=True,
        include_inactive=False,
        min_segments=None,
        max_segments=None,
        user=user,
        db=db_session,
    ))
    assert resp.total_codes_in_project == 0
    assert resp.nodes == []
    assert resp.edges == []


def test_n_less_than_m_for_codes_without_applications(project_with_codes, db_session):
    """The whole point of #354: when N < M, the field surfaces the gap.

    All 5 codes in the fixture have zero applications → network drops all 5
    (nodes.length == 0) but total_codes_in_project == 5. The discrepancy
    (5 - 0 = 5 codes hidden) is exactly what the frontend "Showing N of M"
    message would surface."""
    user = project_with_codes
    resp = _run(get_codebook_cooccurrence(
        project_id=800,
        hierarchy_level=-1,
        conversation_ids=None,
        text_column_ids=None,
        exclude_facilitator=True,
        include_inactive=False,
        min_segments=None,
        max_segments=None,
        user=user,
        db=db_session,
    ))
    assert len(resp.nodes) == 0  # all codes dropped (seg_count == 0)
    assert resp.total_codes_in_project == 5  # but M still reflects the codebook
    # Gap = 5; this is what the frontend explains.
