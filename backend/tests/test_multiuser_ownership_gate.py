"""#553 — behavioral proof that the ownership gate actually fires under multi-tenant auth.

`test_ownership_gate_sweep.py` proves every project-scoped endpoint *reaches* a
gate (a source scan). This file proves the gate *rejects*: with
`MM_MULTIUSER_AUTH_ENABLED` on, user B gets a 404 on user A's project — one
endpoint per router that was fixed, chosen for blast radius (reads that exfil,
mutations that rewrite, deletes that destroy).

And the other direction, which is the one that ships by default: with the flag
OFF (local-roster mode), the same calls SUCCEED — all coders share all projects
by design (Track J · J1). A fix that quietly broke that would break every
multi-coder install.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models.user import User
from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, ColumnType
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.segment import Segment
from app.models.excerpt import Excerpt
from app.models.code import Code


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def multiuser_on():
    """Flip the gate on the cached Settings singleton (test_auth_integration pattern)."""
    from app.config import get_settings
    settings = get_settings()
    original = settings.mm_multiuser_auth_enabled
    settings.mm_multiuser_auth_enabled = True
    yield
    settings.mm_multiuser_auth_enabled = original


@pytest.fixture()
def two_users(db_session):
    """User 1 (from the db_session fixture) owns the project; user 2 is the intruder.

    Returns (owner, intruder, project) plus a populated set of child entities so
    every gated endpoint below has something real to (fail to) touch.
    """
    owner = db_session.query(User).filter(User.id == 1).first()
    intruder = User(username="intruder", password_hash="x", is_admin=False)
    db_session.add(intruder)
    db_session.flush()

    project = Project(name="Owner's project", user_id=owner.id)
    db_session.add(project)
    db_session.flush()

    dataset = Dataset(project_id=project.id, name="D1", source="imported")
    db_session.add(dataset)
    db_session.flush()

    column = DatasetColumn(
        dataset_id=dataset.id,
        column_text="Q1",
        column_code="C001",
        column_type=ColumnType.ORDINAL,
        sequence_order=0,
        display_order=0,
        source="imported",
    )
    conversation = Conversation(project_id=project.id, name="C1")
    document = Document(
        project_id=project.id, name="Doc1",
        source_filename="d.txt", source_format="txt",
    )
    code = Code(project_id=project.id, name="Code1", numeric_id=1)
    db_session.add_all([column, conversation, document, code])
    db_session.flush()

    segment = Segment(conversation_id=conversation.id, sequence_order=0, text="hello")
    db_session.add(segment)
    db_session.flush()
    excerpt = Excerpt(project_id=project.id, segment_id=segment.id)
    db_session.add(excerpt)
    db_session.flush()

    return {
        "owner": owner,
        "intruder": intruder,
        "project": project,
        "dataset": dataset,
        "column": column,
        "conversation": conversation,
        "document": document,
        "code": code,
        "excerpt": excerpt,
    }


def _endpoint_calls(ctx, user):
    """The gated calls, one per router fixed in #553. Each is (label, thunk)."""
    from app.routers.dataset import get_dataset, delete_dataset
    from app.routers.recode import list_definitions
    from app.routers.documents import get_document
    from app.routers.codes import get_code
    from app.routers.conversations import get_conversation
    from app.routers.excerpts import get_excerpt

    pid = ctx["project"].id

    return {
        "dataset.get_dataset": lambda db: get_dataset(pid, ctx["dataset"].id, user, db),
        "dataset.delete_dataset": lambda db: delete_dataset(pid, ctx["dataset"].id, user, db),
        "recode.list_definitions": lambda db: list_definitions(
            pid, ctx["dataset"].id, ctx["column"].id, user, db
        ),
        "documents.get_document": lambda db: get_document(pid, ctx["document"].id, user, db),
        "codes.get_code": lambda db: get_code(pid, ctx["code"].id, user, db),
        "conversations.get_conversation": lambda db: get_conversation(
            pid, ctx["conversation"].id, user, db
        ),
        "excerpts.get_excerpt": lambda db: get_excerpt(pid, ctx["excerpt"].id, user, db),
    }


@pytest.mark.parametrize("label", [
    "dataset.get_dataset",
    "dataset.delete_dataset",
    "recode.list_definitions",
    "documents.get_document",
    "codes.get_code",
    "conversations.get_conversation",
    "excerpts.get_excerpt",
])
def test_foreign_user_is_404d_under_multiuser(db_session, two_users, multiuser_on, label):
    """The intruder holds a valid session but does not own the project → 404."""
    call = _endpoint_calls(two_users, two_users["intruder"])[label]
    with pytest.raises(HTTPException) as exc:
        _run(call(db_session))
    assert exc.value.status_code == 404, (
        f"{label} let a foreign user through with {exc.value.status_code}"
    )


@pytest.mark.parametrize("label", [
    "dataset.get_dataset",
    "recode.list_definitions",
    "documents.get_document",
    "codes.get_code",
    "conversations.get_conversation",
    "excerpts.get_excerpt",
])
def test_local_roster_mode_still_shares_projects(db_session, two_users, label):
    """Flag OFF (the shipped default): every coder reaches every project.

    This is the regression that would actually hurt users — the #553 fix must be
    behaviorally INERT on a single-machine multi-coder install.
    """
    call = _endpoint_calls(two_users, two_users["intruder"])[label]
    _run(call(db_session))  # no raise == shared, as designed


def test_owner_still_reaches_own_project_under_multiuser(db_session, two_users, multiuser_on):
    """Sanity: the gate rejects the intruder, not everyone."""
    call = _endpoint_calls(two_users, two_users["owner"])["dataset.get_dataset"]
    result = _run(call(db_session))
    assert result.id == two_users["dataset"].id


def test_codebook_import_is_gated(db_session, two_users, multiuser_on):
    """project_portability::import_codebook_endpoint had NO gate at all — a file
    holder could inject codes into any project. Covered separately because it
    takes an UploadFile, not plain ids."""
    import io
    from fastapi import UploadFile
    from app.routers.project_portability import import_codebook_endpoint

    payload = io.BytesIO(b'{"codes": [], "categories": []}')
    upload = UploadFile(filename="cb.mmcodebook", file=payload)

    with pytest.raises(HTTPException) as exc:
        _run(import_codebook_endpoint(
            two_users["project"].id, upload, db_session, two_users["intruder"],
        ))
    assert exc.value.status_code == 404
