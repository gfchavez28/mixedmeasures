"""#1268 — a server fault says what the researcher can do, never "check the server logs".

A desktop user has no log to open: the backend logs to stderr only (`main.py`'s
`basicConfig`) and the shell forwards that to its own console (`electron/main.js`).
Each sentence here also says "nothing was changed", which is a CLAIM — so each is pinned
by a failure injected AFTER the work it would have to undo was done (the duplicate's copy
written and its recording staged, the codebook's codes added), and the state read back.

That no OTHER user-facing sentence sends anyone to a log is the job of
`test_no_log_instructions.py` (the backend's strings) and
`frontend/src/lib/no-log-instructions.test.ts` (the client's and the shell's).
"""

import asyncio
import errno
import io
import json
import os

import pytest
from fastapi import HTTPException, UploadFile

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.models import Code, Project
from app.models.user import User
from app.routers import project_portability as pp
from app.services.codebook_exchange import export_codebook_native
from app.services.media_storage import media_owner_segment
from tests.test_project_portability import populated_project  # noqa: F401 (fixture)


def _files_under(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


@pytest.fixture
def duplicate_setup(db_session, populated_project, tmp_path, monkeypatch):  # noqa: F811
    """The fixture project COMMITTED (a failure path's rollback must not take it too),
    with its observation's recording on disk so the copy has a file to stage."""
    project = populated_project["project"]
    obs = populated_project["observation"]
    docs, media = tmp_path / "documents", tmp_path / "media"
    docs.mkdir()
    recording = media / str(project.id) / media_owner_segment("observation", obs.id) / "original.mp4"
    recording.parent.mkdir(parents=True)
    recording.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    monkeypatch.setattr(pp, "_get_data_dirs", lambda: (docs, media))
    db_session.commit()
    user = db_session.query(User).filter(User.id == 1).one()
    return project.id, user, tmp_path


def _fail_after_the_copy(monkeypatch, root, exc):
    """`import_project` runs IN FULL — the copy's rows written, its files staged — and
    then the fault. Records what existed at that moment, so the test can show it had
    something to undo."""
    real_import = pp.import_project
    seen: dict = {}

    def import_then_fail(*args, **kwargs):
        new_id, _ = real_import(*args, **kwargs)
        seen["copy_id"] = new_id
        seen["staged"] = [p.name for p in root.iterdir() if p.name.startswith(".import-")]
        raise exc

    monkeypatch.setattr(pp, "import_project", import_then_fail)
    return seen


def test_a_duplicate_that_fails_after_the_copy_is_written_changes_nothing(
    db_session, duplicate_setup, monkeypatch,
):
    pid, user, root = duplicate_setup
    projects_before = db_session.query(Project).count()
    files_before = _files_under(root)
    seen = _fail_after_the_copy(monkeypatch, root, RuntimeError("injected after the copy"))

    with pytest.raises(HTTPException) as caught:
        pp.duplicate_project_endpoint(pid, db=db_session, user=user)

    assert caught.value.status_code == 500
    assert caught.value.detail == pp.DUPLICATE_FAILED
    # Precondition: there WAS something to undo — a copy in the transaction and its
    # recording staged on disk — or "nothing was changed" would be vacuously true.
    assert seen.get("copy_id") is not None
    assert seen["staged"], "the copy's recording was never staged, so this test proves nothing"
    # The claim.
    assert db_session.query(Project).count() == projects_before
    assert db_session.query(Project).filter(Project.id == seen["copy_id"]).first() is None
    assert _files_under(root) == files_before


def test_a_duplicate_that_runs_out_of_disk_says_so_and_changes_nothing(
    db_session, duplicate_setup, monkeypatch,
):
    pid, user, root = duplicate_setup
    projects_before = db_session.query(Project).count()
    files_before = _files_under(root)
    _fail_after_the_copy(monkeypatch, root, OSError(errno.ENOSPC, "No space left on device"))

    with pytest.raises(HTTPException) as caught:
        pp.duplicate_project_endpoint(pid, db=db_session, user=user)

    assert caught.value.status_code == 507
    assert caught.value.detail == pp.DUPLICATE_DISK_FULL
    assert db_session.query(Project).count() == projects_before
    assert _files_under(root) == files_before


def test_another_os_error_is_the_general_sentence_not_the_disk_one(
    db_session, duplicate_setup, monkeypatch,
):
    pid, user, root = duplicate_setup
    _fail_after_the_copy(monkeypatch, root, OSError(errno.EACCES, "Permission denied"))

    with pytest.raises(HTTPException) as caught:
        pp.duplicate_project_endpoint(pid, db=db_session, user=user)

    assert caught.value.status_code == 500
    assert caught.value.detail == pp.DUPLICATE_FAILED


@pytest.mark.parametrize("mode", ["new", "overwrite", "copy_for_coding", "merge"])
def test_every_import_mode_says_it_is_safe_to_try_again(mode):
    """`_import_failure` is what every mode of `/import-project` says on a fault it did not
    foresee — and what the Merge page shows since #1232. "Nothing was changed" there is
    #1225's staging (its own tests); this pins the words."""
    sentence = pp._import_failure(mode, disk_full=False)
    # The period after "changed" is `test_import_files_staged.py`'s pin (#1225) too.
    assert sentence.endswith("and nothing was changed. It is safe to try again.")
    assert "log" not in sentence.lower()
    assert sentence.startswith(
        "The merge could not be completed" if mode == "merge" else "Project import failed"
    )


def test_a_codebook_import_that_fails_after_adding_codes_changes_nothing(
    db_session, populated_project, monkeypatch,  # noqa: F811
):
    source = populated_project["project"]
    target = Project(name="Empty", status="active", user_id=1)
    db_session.add(target)
    db_session.commit()
    body = json.dumps(export_codebook_native(db_session, source.id)).encode()

    real_import = pp.import_codebook_native
    added: dict = {}

    def import_then_fail(db, project_id, data):
        counts = real_import(db, project_id, data)
        db.flush()
        added["codes"] = db.query(Code).filter(Code.project_id == project_id).count()
        raise RuntimeError("injected after the codes were added")

    monkeypatch.setattr(pp, "import_codebook_native", import_then_fail)
    user = db_session.query(User).filter(User.id == 1).one()

    with pytest.raises(HTTPException) as caught:
        asyncio.run(pp.import_codebook_endpoint(
            target.id,
            UploadFile(filename="codes.mmcodebook", file=io.BytesIO(body)),
            db=db_session, user=user,
        ))

    assert caught.value.status_code == 500
    assert caught.value.detail == (
        "Codebook import failed, and nothing was changed. It is safe to try again."
    )
    assert added["codes"] > 0, "no code was added before the fault, so this test proves nothing"
    assert db_session.query(Code).filter(Code.project_id == target.id).count() == 0
