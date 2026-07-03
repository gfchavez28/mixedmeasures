"""Track J · J2-3 — CodeEquivalenceGroup model + the effective-code resolver.

The resolver (`build_effective_code_map` / `resolve_effective_code`) is the D3 /
J2-D single seam: agreement, consensus materialization, and IRR all read the
"effective code" through it. v1 = identity for ungrouped codes; the group's
canonical (or lowest member id) for grouped codes.
"""
from app.models.project import Project
from app.models.code import Code
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.services.coding_layers import build_effective_code_map, resolve_effective_code


def _code(db, code_id, project_id, numeric_id, name, group_id=None):
    db.add(Code(id=code_id, project_id=project_id, name=name, color="#111111",
                numeric_id=numeric_id, is_active=True, is_universal=False,
                code_equivalence_group_id=group_id))


def test_resolver_identity_when_ungrouped(db_session):
    db = db_session
    db.add(Project(id=10, name="P", user_id=1))
    db.flush()
    _code(db, 100, 10, 2, "A")
    _code(db, 101, 10, 3, "B")
    db.flush()
    m = build_effective_code_map(db, 10)
    assert m == {}, "no groups → empty map"
    assert resolve_effective_code(m, 100) == 100, "identity for ungrouped"
    assert resolve_effective_code(m, 999) == 999, "unknown code → identity default"


def test_resolver_lowest_member_when_canonical_null(db_session):
    """All members of a group with no canonical resolve to the lowest member id."""
    db = db_session
    db.add(Project(id=11, name="P", user_id=1))
    db.flush()
    db.add(CodeEquivalenceGroup(id=500, project_id=11, label="Positive-ish"))
    db.flush()
    _code(db, 110, 11, 2, "positive", group_id=500)
    _code(db, 111, 11, 3, "POSITIVE", group_id=500)
    _code(db, 112, 11, 4, "favorable", group_id=500)
    db.flush()
    m = build_effective_code_map(db, 11)
    assert {resolve_effective_code(m, c) for c in (110, 111, 112)} == {110}


def test_resolver_uses_canonical_when_set(db_session):
    db = db_session
    db.add(Project(id=12, name="P", user_id=1))
    db.flush()
    db.add(CodeEquivalenceGroup(id=501, project_id=12, label="G", canonical_code_id=1202))
    db.flush()
    _code(db, 1201, 12, 2, "a", group_id=501)
    _code(db, 1202, 12, 3, "canon", group_id=501)
    db.flush()
    m = build_effective_code_map(db, 12)
    assert resolve_effective_code(m, 1201) == 1202
    assert resolve_effective_code(m, 1202) == 1202


def test_resolver_falls_back_when_canonical_stale(db_session):
    """A canonical_code_id that is not a live member (e.g. the code was deleted)
    falls back to the lowest member — robust to a dangling canonical."""
    db = db_session
    db.add(Project(id=13, name="P", user_id=1))
    db.flush()
    db.add(CodeEquivalenceGroup(id=502, project_id=13, label="G", canonical_code_id=99999))
    db.flush()
    _code(db, 1301, 13, 2, "a", group_id=502)
    _code(db, 1302, 13, 3, "b", group_id=502)
    db.flush()
    m = build_effective_code_map(db, 13)
    assert {resolve_effective_code(m, c) for c in (1301, 1302)} == {1301}


def test_group_codes_relationship(db_session):
    """The group ↔ code relationship round-trips (both directions)."""
    db = db_session
    db.add(Project(id=14, name="P", user_id=1))
    db.flush()
    g = CodeEquivalenceGroup(id=503, project_id=14, label="G")
    db.add(g)
    db.flush()
    _code(db, 1401, 14, 2, "a", group_id=503)
    _code(db, 1402, 14, 3, "b", group_id=503)
    _code(db, 1403, 14, 4, "ungrouped")
    db.flush()
    assert {c.id for c in g.codes} == {1401, 1402}
    assert db.get(Code, 1401).code_equivalence_group is g
    assert db.get(Code, 1403).code_equivalence_group is None


# ── Slab 6 · CRUD router ──────────────────────────────────────────────────────

import asyncio

import pytest
from fastapi import HTTPException

from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.segment import Segment
from app.models.user import User
from app.routers.code_equivalence import (
    list_groups, create_group, update_group, delete_group,
    add_codes, remove_codes, merge_groups,
)
from app.schemas.code_equivalence import (
    CodeEquivalenceGroupCreate, CodeEquivalenceGroupUpdate,
    CodeEquivalenceGroupAddCodes, CodeEquivalenceGroupRemoveCodes,
)
from tests.conftest import mock_request


def _run(coro):
    return asyncio.run(coro)


def _project(db, pid=20):
    db.add(Project(id=pid, name="P", user_id=1))
    db.flush()
    return pid


def _user1(db):
    return db.get(User, 1)


def test_create_group_with_members(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2001, pid, 2, "Positive")
    _code(db, 2002, pid, 3, "POSITIVE")
    db.flush()
    resp = _run(create_group(
        project_id=pid,
        data=CodeEquivalenceGroupCreate(label="positive-ish", code_ids=[2001, 2002]),
        user=_user1(db), db=db,
    ))
    assert {m.id for m in resp.members} == {2001, 2002}
    assert db.get(Code, 2001).code_equivalence_group_id == resp.id
    assert resp.origin == "human"


def test_create_rejects_universal_code(db_session):
    db = db_session
    pid = _project(db)
    db.add(Code(id=2010, project_id=pid, name="Unclear", numeric_id=1,
                is_active=True, is_universal=True))
    db.flush()
    with pytest.raises(HTTPException) as ei:
        _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2010]),
                          user=_user1(db), db=db))
    assert ei.value.status_code == 400
    assert ei.value.detail["error"] == "universal_code"


def test_create_rejects_already_linked(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2020, pid, 2, "A")
    db.flush()
    _run(create_group(project_id=pid,
                      data=CodeEquivalenceGroupCreate(label="g1", code_ids=[2020]),
                      user=_user1(db), db=db))
    _code(db, 2021, pid, 3, "B")
    db.flush()
    with pytest.raises(HTTPException) as ei:
        _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g2", code_ids=[2020, 2021]),
                          user=_user1(db), db=db))
    assert ei.value.status_code == 409
    assert ei.value.detail["error"] == "already_linked"
    assert ei.value.detail["code_ids"] == [2020]


def test_create_rejects_canonical_not_member(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2030, pid, 2, "A")
    _code(db, 2031, pid, 3, "B")
    db.flush()
    with pytest.raises(HTTPException) as ei:
        _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2030], canonical_code_id=2031),
                          user=_user1(db), db=db))
    assert ei.value.status_code == 400


def test_add_codes_and_idempotent_readd(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2040, pid, 2, "A")
    _code(db, 2041, pid, 3, "B")
    db.flush()
    g = _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2040]),
                          user=_user1(db), db=db))
    resp = _run(add_codes(request=mock_request(), project_id=pid, group_id=g.id,
                          data=CodeEquivalenceGroupAddCodes(code_ids=[2041]),
                          user=_user1(db), db=db))
    assert {m.id for m in resp.members} == {2040, 2041}
    # Re-adding a code already in THIS group is idempotent (no 409).
    resp2 = _run(add_codes(request=mock_request(), project_id=pid, group_id=g.id,
                           data=CodeEquivalenceGroupAddCodes(code_ids=[2041]),
                           user=_user1(db), db=db))
    assert {m.id for m in resp2.members} == {2040, 2041}


def test_remove_codes_auto_dissolves_when_empty(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2050, pid, 2, "A")
    db.flush()
    g = _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2050]),
                          user=_user1(db), db=db))
    resp = _run(remove_codes(request=mock_request(), project_id=pid, group_id=g.id,
                             data=CodeEquivalenceGroupRemoveCodes(code_ids=[2050]),
                             user=_user1(db), db=db))
    assert resp.dissolved is True and resp.group is None
    assert db.get(CodeEquivalenceGroup, g.id) is None
    assert db.get(Code, 2050).code_equivalence_group_id is None


def test_remove_codes_nulls_canonical_when_removed(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2060, pid, 2, "A")
    _code(db, 2061, pid, 3, "B")
    db.flush()
    g = _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2060, 2061], canonical_code_id=2060),
                          user=_user1(db), db=db))
    resp = _run(remove_codes(request=mock_request(), project_id=pid, group_id=g.id,
                             data=CodeEquivalenceGroupRemoveCodes(code_ids=[2060]),
                             user=_user1(db), db=db))
    assert resp.dissolved is False
    assert db.get(CodeEquivalenceGroup, g.id).canonical_code_id is None
    assert {m.id for m in resp.group.members} == {2061}


def test_update_label_and_canonical(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2070, pid, 2, "A")
    _code(db, 2071, pid, 3, "B")
    db.flush()
    g = _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2070, 2071]),
                          user=_user1(db), db=db))
    resp = _run(update_group(project_id=pid, group_id=g.id,
                             data=CodeEquivalenceGroupUpdate(label="renamed", canonical_code_id=2071),
                             user=_user1(db), db=db))
    assert resp.label == "renamed" and resp.canonical_code_id == 2071
    # canonical must be a member
    with pytest.raises(HTTPException) as ei:
        _run(update_group(project_id=pid, group_id=g.id,
                          data=CodeEquivalenceGroupUpdate(canonical_code_id=999999),
                          user=_user1(db), db=db))
    assert ei.value.status_code == 400


def test_delete_group_unlinks_members(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2080, pid, 2, "A")
    db.flush()
    g = _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2080]),
                          user=_user1(db), db=db))
    _run(delete_group(project_id=pid, group_id=g.id, user=_user1(db), db=db))
    assert db.get(CodeEquivalenceGroup, g.id) is None
    assert db.get(Code, 2080).code_equivalence_group_id is None
    assert db.get(Code, 2080) is not None  # SET NULL, not delete


def test_merge_groups_moves_codes_and_deletes_source(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2090, pid, 2, "A")
    _code(db, 2091, pid, 3, "B")
    db.flush()
    target = _run(create_group(project_id=pid,
                               data=CodeEquivalenceGroupCreate(label="t", code_ids=[2090]),
                               user=_user1(db), db=db))
    source = _run(create_group(project_id=pid,
                               data=CodeEquivalenceGroupCreate(label="s", code_ids=[2091]),
                               user=_user1(db), db=db))
    resp = _run(merge_groups(request=mock_request(), project_id=pid,
                             group_id=target.id, other_group_id=source.id,
                             user=_user1(db), db=db))
    assert {m.id for m in resp.members} == {2090, 2091}
    assert db.get(CodeEquivalenceGroup, source.id) is None
    assert db.get(Code, 2091).code_equivalence_group_id == target.id


def test_merge_self_rejected(db_session):
    db = db_session
    pid = _project(db)
    _code(db, 2100, pid, 2, "A")
    db.flush()
    g = _run(create_group(project_id=pid,
                          data=CodeEquivalenceGroupCreate(label="g", code_ids=[2100]),
                          user=_user1(db), db=db))
    with pytest.raises(HTTPException) as ei:
        _run(merge_groups(request=mock_request(), project_id=pid,
                          group_id=g.id, other_group_id=g.id, user=_user1(db), db=db))
    assert ei.value.status_code == 400


# ── Slab 6 · consensus-stale wiring (gated on ≥2 roster coders) ────────────────


def _coded_segment(db, pid, sid, code_id):
    """Project + conversation + segment with `code_id` applied by coders 1 and 2."""
    db.add_all([
        Conversation(id=pid, project_id=pid, name="C"),
        Segment(id=sid, conversation_id=pid, sequence_order=0, text="hi"),
    ])
    db.flush()
    db.add_all([
        CodeApplication(code_id=code_id, user_id=1, segment_id=sid),
        CodeApplication(code_id=code_id, user_id=2, segment_id=sid),
    ])
    db.flush()


def test_create_group_marks_consensus_stale_when_multicoder(db_session):
    db = db_session
    pid = _project(db, pid=30)
    db.add(User(id=2, username="B", password_hash=None, coder_type="human"))
    db.flush()
    _code(db, 3001, pid, 2, "Positive")
    db.flush()
    _coded_segment(db, pid, 3000, 3001)

    _run(create_group(project_id=pid,
                      data=CodeEquivalenceGroupCreate(label="g", code_ids=[3001]),
                      user=_user1(db), db=db))

    markers = db.query(ConsensusStaleTarget).filter(
        ConsensusStaleTarget.project_id == pid,
        ConsensusStaleTarget.segment_id == 3000,
    ).all()
    assert len(markers) == 1, "the coded target was marked for consensus recompute"


def test_no_consensus_marking_single_coder(db_session):
    db = db_session
    pid = _project(db, pid=31)
    _code(db, 3101, pid, 2, "Positive")
    db.flush()
    db.add_all([
        Conversation(id=pid, project_id=pid, name="C"),
        Segment(id=3100, conversation_id=pid, sequence_order=0, text="hi"),
    ])
    db.flush()
    db.add(CodeApplication(code_id=3101, user_id=1, segment_id=3100))
    db.flush()

    _run(create_group(project_id=pid,
                      data=CodeEquivalenceGroupCreate(label="g", code_ids=[3101]),
                      user=_user1(db), db=db))

    assert db.query(ConsensusStaleTarget).count() == 0, "single coder → no consensus work"
