"""Regression tests for category merge (folded-in audit, 2026-06-23).

`merge_categories` reassigns code.category_id / child.parent_id then deletes the
source category. With autoflush=False (production AND tests — database.py:183),
those reassignments are pending when the source row is deleted, so the DB-level
cascades fire against STALE links. `CodeCategory.parent_id` is ON DELETE CASCADE,
so a non-source child used to get cascade-deleted → the pending reparent UPDATE
matched 0 rows → StaleDataError (500). The #439 family. Fixed by flushing
reassignments before deleting sources. There were ZERO tests for this path.
"""
import asyncio

from app.models.project import Project
from app.models.code import Code
from app.models.code_category import CodeCategory
from app.models.user import User
from app.routers.codes import merge_categories
from app.schemas.code import CategoryMergeRequest


def _run(coro):
    return asyncio.run(coro)


def _setup(db, pid=600):
    db.add(Project(id=pid, name="P", user_id=1))
    db.flush()
    return pid


def test_merge_category_with_non_source_child_does_not_crash(db_session):
    """The confirmed bug: a source category with a non-merged child category.
    Pre-fix this raised StaleDataError (the child was cascade-deleted)."""
    db = db_session
    pid = _setup(db)
    target = CodeCategory(id=6001, project_id=pid, name="Target")
    source = CodeCategory(id=6002, project_id=pid, name="Source")
    db.add_all([target, source])
    db.flush()
    child = CodeCategory(id=6003, project_id=pid, name="Child", parent_id=source.id)
    db.add(child)
    db.flush()
    code = Code(id=6004, project_id=pid, numeric_id=5, name="C5", category_id=source.id)
    db.add(code)
    db.flush()

    _run(merge_categories(
        project_id=pid,
        data=CategoryMergeRequest(target_id=target.id, source_ids=[source.id]),
        user=db.get(User, 1), db=db,
    ))

    # Child survived and was reparented to target; code moved to target; source gone.
    assert db.get(CodeCategory, child.id) is not None
    assert db.get(CodeCategory, child.id).parent_id == target.id
    assert db.get(Code, code.id).category_id == target.id
    assert db.get(CodeCategory, source.id) is None


def test_merge_sibling_categories_moves_codes(db_session):
    """Basic sibling merge: codes move to target, source deleted."""
    db = db_session
    pid = _setup(db, pid=601)
    target = CodeCategory(id=6101, project_id=pid, name="Target")
    source = CodeCategory(id=6102, project_id=pid, name="Source")
    db.add_all([target, source])
    db.flush()
    c1 = Code(id=6103, project_id=pid, numeric_id=5, name="C5", category_id=source.id)
    c2 = Code(id=6104, project_id=pid, numeric_id=6, name="C6", category_id=source.id)
    db.add_all([c1, c2])
    db.flush()

    _run(merge_categories(
        project_id=pid,
        data=CategoryMergeRequest(target_id=target.id, source_ids=[source.id]),
        user=db.get(User, 1), db=db,
    ))

    assert db.get(Code, c1.id).category_id == target.id
    assert db.get(Code, c2.id).category_id == target.id
    assert db.get(CodeCategory, source.id) is None


def test_merge_parent_and_child_both_sources(db_session):
    """Edge case: a parent AND its child are both sources. The child is skipped
    during reparenting and deleted alongside the parent; both sources' codes land
    on the target (deferring deletes until after a flush handles this)."""
    db = db_session
    pid = _setup(db, pid=602)
    target = CodeCategory(id=6201, project_id=pid, name="Target")
    parent = CodeCategory(id=6202, project_id=pid, name="Parent")
    db.add_all([target, parent])
    db.flush()
    child = CodeCategory(id=6203, project_id=pid, name="Child", parent_id=parent.id)
    db.add(child)
    db.flush()
    pc = Code(id=6204, project_id=pid, numeric_id=5, name="ParentCode", category_id=parent.id)
    cc = Code(id=6205, project_id=pid, numeric_id=6, name="ChildCode", category_id=child.id)
    db.add_all([pc, cc])
    db.flush()
    # Capture ids as ints — both source rows are deleted by the merge, so reading
    # `.id` off the stale ORM instances afterward raises ObjectDeletedError.
    parent_id, child_id, target_id, pc_id, cc_id = (
        parent.id, child.id, target.id, pc.id, cc.id,
    )

    _run(merge_categories(
        project_id=pid,
        data=CategoryMergeRequest(target_id=target_id, source_ids=[parent_id, child_id]),
        user=db.get(User, 1), db=db,
    ))

    assert db.get(CodeCategory, parent_id) is None
    assert db.get(CodeCategory, child_id) is None
    assert db.get(Code, pc_id).category_id == target_id
    assert db.get(Code, cc_id).category_id == target_id
