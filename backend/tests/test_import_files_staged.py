"""#1225 — an import's files land WITH its commit, and a failed import touches no file.

A `.mmproject` import used to extract every document and recording member straight onto
its final path, inside the database transaction. The database rolled back on a failure;
the files did not. Because SQLite reuses the ids of the newest rows (#1206), an
OVERWRITE of the newest project extracts onto the old project's own paths, and a MERGE
always writes into the target's own folder — so a damaged member or a full disk left the
kept project's recording EMPTY or CUT SHORT under a project that looked intact.

The fix stages every member in a hidden folder beside the data folders BEFORE anything is
written (which also reads every member once, so a damaged one is refused before the
safety copy), and moves the staged tree into place only when the session COMMITS.

Every test is written as the wanted behaviour; each has a control whose ids do not
coincide, so a pass on the control alone proves nothing.
"""
from __future__ import annotations

import errno
import io
import os
import time
import zipfile

import pytest

from app.models.conversation import Conversation
from app.models.project import Project
from app.services import project_portability as pp
from app.services.project_portability import export_project, import_project

OLD = b"LOCAL-RECORDING-v2 " * 4000       # what the researcher has on disk now
ARCHIVED = b"ARCHIVED-RECORDING-v1 " * 4000  # what the file carries
EXTRA = b"EXTRA-RECORDING " * 3000


@pytest.fixture
def backups(tmp_path, monkeypatch):
    folder = tmp_path / "backups"
    monkeypatch.setattr("app.services.project_portability.get_backup_dir", lambda: folder)
    return folder


def _dirs(tmp_path):
    return tmp_path / "data" / "documents", tmp_path / "data" / "media"


def _make(db, media, name, payload=ARCHIVED, doc_dir=None):
    p = Project(name=name, user_id=1)
    db.add(p)
    db.flush()
    c = Conversation(project_id=p.id, name="interview", media_filename="rec.mp3",
                     media_format="mp3", media_type="audio")
    db.add(c)
    db.flush()
    f = media / str(p.id) / str(c.id) / "original.mp3"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(payload)
    return p, c, f


def _archive(db, pid, docs, media, tmp_path, *, corrupt=False, include_media=True):
    raw = export_project(db, pid, docs, media, include_media=include_media).getvalue()
    src = zipfile.ZipFile(io.BytesIO(raw))
    out = io.BytesIO()
    # Rebuilt STORED so one byte of the recording can be flipped (a damaged download).
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for info in src.infolist():
            z.writestr(info.filename, src.read(info.filename))
    data = bytearray(out.getvalue())
    if corrupt:
        needle = corrupt if isinstance(corrupt, bytes) else b"ARCHIVED-RECORDING-v1 ARCH"
        i = data.find(needle)
        assert i > 0
        data[i + 5000] ^= 0xFF  # inside the recording member -> Bad CRC-32 at its end
    path = tmp_path / f"a-{pid}-{corrupt}-{include_media}.mmproject"
    path.write_bytes(bytes(data))
    return path


def _staging_left(tmp_path):
    return sorted(p.name for p in (tmp_path / "data").glob(".import-*"))


def _enospc_after(monkeypatch, n=1000):
    real = pp.shutil.copyfileobj

    def enospc(src, dst, length=0):
        if str(getattr(dst, "name", "")).endswith("original.mp3"):
            dst.write(src.read(n))
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(src, dst, length)

    monkeypatch.setattr(pp.shutil, "copyfileobj", enospc)


# ── A FAILED overwrite or merge leaves the kept project's files as they were ──────────

@pytest.mark.parametrize("newest", [True, False], ids=["target-is-newest", "CONTROL-not-newest"])
def test_a_damaged_recording_leaves_the_kept_recording(db_session, tmp_path, backups, newest):
    db = db_session
    docs, media = _dirs(tmp_path)
    target, conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path, corrupt=True)
    if not newest:
        _make(db, media, "Later project")  # the target's ids are no longer reused
        db.commit()
    f.write_bytes(OLD)
    tid, cid = target.id, conv.id

    with pytest.raises(ValueError, match="damaged"):
        import_project(db, archive, docs, media_dir=media, user_id=1,
                       import_mode="overwrite", target_project_id=tid)
    db.rollback()

    assert db.get(Project, tid).name == "Study"
    assert db.get(Conversation, cid).media_filename == "rec.mp3"
    assert f.read_bytes() == OLD, "the failed import replaced the recording on disk"
    assert _staging_left(tmp_path) == []


def test_a_damaged_member_is_refused_before_the_safety_copy(db_session, tmp_path, backups):
    """The member is read in full while it is staged, before the mode branch — so a
    damaged file is refused without the unrotated safety copy (#1150 a's rule, #919)."""
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, _f = _make(db, media, "Study")
    db.commit()
    overwrite_file = _archive(db, target.id, docs, media, tmp_path, corrupt=True)
    # A merge reads only the members of sources it will INSERT, so its damaged member
    # is the colleague's own new recording.
    merge_file = _with_new_source(db, target, docs, media, tmp_path, corrupt=b"EXTRA-RECORDING EX")
    for mode, archive in (("overwrite", overwrite_file), ("merge", merge_file)):
        with pytest.raises(ValueError, match="damaged"):
            import_project(db, archive, docs, media_dir=media, user_id=1,
                           import_mode=mode, target_project_id=target.id)
        db.rollback()
    assert not backups.exists() or list(backups.iterdir()) == []
    assert _staging_left(tmp_path) == []


@pytest.mark.parametrize("newest", [True, False], ids=["target-is-newest", "CONTROL-not-newest"])
def test_disk_full_mid_recording_leaves_the_kept_recording(
    db_session, tmp_path, backups, monkeypatch, newest,
):
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path)
    if not newest:
        _make(db, media, "Later project")
        db.commit()
    f.write_bytes(OLD)
    tid = target.id
    _enospc_after(monkeypatch)
    with pytest.raises(OSError):
        import_project(db, archive, docs, media_dir=media, user_id=1,
                       import_mode="overwrite", target_project_id=tid)
    db.rollback()
    assert db.get(Project, tid) is not None
    assert f.read_bytes() == OLD, "disk-full mid-import truncated the kept project's recording"
    assert _staging_left(tmp_path) == []


def test_MERGE_disk_full_mid_recording_leaves_the_targets_recording(
    db_session, tmp_path, backups, monkeypatch,
):
    """A merge writes into the SAME project id always — no id coincidence needed. With
    the merge skip, a matched recording is not even read; the new source's is."""
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, f = _make(db, media, "Study")
    _make(db, media, "Later project")  # the target is NOT the newest
    db.commit()
    archive = _with_new_source(db, target, docs, media, tmp_path)
    f.write_bytes(OLD)
    _enospc_after(monkeypatch)
    with pytest.raises(OSError):
        import_project(db, archive, docs, media_dir=media, user_id=1,
                       import_mode="merge", target_project_id=target.id)
    db.rollback()
    assert f.read_bytes() == OLD, "a failed MERGE truncated the target's own recording"
    assert _staging_left(tmp_path) == []


# ── A SUCCESSFUL import still writes the right files ─────────────────────────────────

@pytest.mark.parametrize("newest", [True, False], ids=["target-is-newest", "CONTROL-not-newest"])
def test_a_successful_overwrite_replaces_the_projects_files(db_session, tmp_path, backups, newest):
    db = db_session
    docs, media = _dirs(tmp_path)
    target, conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path)
    if not newest:
        _make(db, media, "Later project")
        db.commit()
    f.write_bytes(OLD)
    tid = target.id
    # A conversation added AFTER the export — the file does not carry it.
    extra = Conversation(project_id=tid, name="later", media_filename="x.mp3",
                         media_format="mp3", media_type="audio")
    db.add(extra)
    db.flush()
    extra_file = media / str(tid) / str(extra.id) / "original.mp3"
    extra_file.parent.mkdir(parents=True)
    extra_file.write_bytes(EXTRA)
    db.commit()

    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1,
                               import_mode="overwrite", target_project_id=tid)
    db.commit()

    (new_conv,) = db.query(Conversation).filter(Conversation.project_id == new_id).all()
    landed = media / str(new_id) / str(new_conv.id) / "original.mp3"
    assert landed.read_bytes() == ARCHIVED
    # Exactly the archive's files under the project — the replaced project's own folder,
    # and the recording of the conversation the file does not carry, are gone.
    files = sorted(p.relative_to(media) for p in media.rglob("*") if p.is_file())
    expected = {landed.relative_to(media)}
    if not newest:
        later = [p for p in files if p.parts[0] not in (str(new_id), str(tid))]
        expected |= set(later)
    assert set(files) == expected
    if new_id != tid:
        assert not (media / str(tid)).exists()
    assert _staging_left(tmp_path) == []


def test_files_land_only_when_the_import_commits(db_session, tmp_path, backups):
    """The property the fix rests on: until the commit, the final paths are untouched;
    a rollback leaves nothing behind."""
    db = db_session
    docs, media = _dirs(tmp_path)
    src, _c, _f = _make(db, media, "Source")
    db.commit()
    archive = _archive(db, src.id, docs, media, tmp_path)

    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1)
    assert not (media / str(new_id)).exists(), "a file landed before the commit"
    db.rollback()
    assert not (media / str(new_id)).exists()
    assert _staging_left(tmp_path) == []

    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1)
    db.commit()
    (conv,) = db.query(Conversation).filter(Conversation.project_id == new_id).all()
    assert (media / str(new_id) / str(conv.id) / "original.mp3").read_bytes() == ARCHIVED
    # The media-less check judged the STAGED file (the final path was still empty).
    assert conv.media_filename == "rec.mp3"
    assert _staging_left(tmp_path) == []


# ── The MERGE half: a matched source keeps the TARGET's bytes, like its fields ──────

def _with_new_source(db, target, docs, media, tmp_path, corrupt=False):
    """An archive of `target` carrying one MORE conversation (with a recording) than the
    target now has — a colleague's copy holding a source of their own."""
    newc = Conversation(project_id=target.id, name="colleague's", media_filename="n.mp3",
                        media_format="mp3", media_type="audio")
    db.add(newc)
    db.flush()
    nf = media / str(target.id) / str(newc.id) / "original.mp3"
    nf.parent.mkdir(parents=True)
    nf.write_bytes(EXTRA)
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path, corrupt=corrupt)
    db.delete(newc)
    db.commit()
    nf.unlink()
    nf.parent.rmdir()
    return archive


def test_a_successful_merge_keeps_the_targets_recording(db_session, tmp_path, backups):
    db = db_session
    docs, media = _dirs(tmp_path)
    target, conv, f = _make(db, media, "Study")
    _make(db, media, "Later project")
    db.commit()
    archive = _with_new_source(db, target, docs, media, tmp_path)
    f.write_bytes(OLD)  # the target re-attached its recording after sharing
    tid, cid = target.id, conv.id

    import_project(db, archive, docs, media_dir=media, user_id=1,
                   import_mode="merge", target_project_id=tid)
    db.commit()

    assert f.read_bytes() == OLD, "a merge replaced the target's recording with the copy's"
    assert db.get(Conversation, cid).media_filename == "rec.mp3"
    # …and the colleague's NEW source arrives with its recording.
    (added,) = db.query(Conversation).filter(
        Conversation.project_id == tid, Conversation.id != cid).all()
    assert added.media_filename == "n.mp3"
    assert (media / str(tid) / str(added.id) / "original.mp3").read_bytes() == EXTRA
    assert _staging_left(tmp_path) == []


def test_a_merge_does_not_read_a_matched_sources_recording(db_session, tmp_path, backups):
    """A merge keeps the target's bytes for a matched source, so it never reads (or
    stages — gigabytes, for a video project) the copy's: a damaged member there does
    not stop a merge that does not need it."""
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path, corrupt=True)  # the MATCHED one
    f.write_bytes(OLD)
    import_project(db, archive, docs, media_dir=media, user_id=1,
                   import_mode="merge", target_project_id=target.id)
    db.commit()
    assert f.read_bytes() == OLD
    assert _staging_left(tmp_path) == []


def test_the_INSERTED_set_decides_what_a_merge_places(db_session, tmp_path, backups, monkeypatch):
    """#714's rule for files: what lands is decided by what the merge INSERTED, never by
    the read-ahead's own guess. Played by a read-ahead that stages everything."""
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path)
    f.write_bytes(OLD)
    real = pp._stage_archive_files

    def stage_everything(db, zf, data, files, import_mode, target_project_id):
        return real(db, zf, data, files, "new", target_project_id)

    monkeypatch.setattr(pp, "_stage_archive_files", stage_everything)
    import_project(db, archive, docs, media_dir=media, user_id=1,
                   import_mode="merge", target_project_id=target.id)
    db.commit()
    assert f.read_bytes() == OLD
    assert _staging_left(tmp_path) == []


# ── Q6: a NEW import never adopts what a deleted project left on disk ───────────────

def test_a_new_import_does_not_adopt_a_deleted_projects_leftover_recording(
    db_session, tmp_path, backups,
):
    """Deletes commit first and remove the folder after, and a failure there is only
    logged (Windows holds open files; a process can die in between). SQLite then hands
    the deleted project's ids to the next project — and the media-less import's
    stat check used to find the leftover recording and KEEP the metadata, so the new
    interview played the deleted one's recording."""
    db = db_session
    docs, media = _dirs(tmp_path)
    b, _cb, _fb = _make(db, media, "B", payload=ARCHIVED)
    db.commit()
    archive = _archive(db, b.id, docs, media, tmp_path, include_media=False)
    a, ca, fa = _make(db, media, "A (deleted)", payload=OLD)
    db.commit()
    aid, caid = a.id, ca.id
    from app.services.project_deletion import delete_project_tree
    delete_project_tree(db, a)
    db.commit()
    assert fa.exists()  # the folder removal "failed"

    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1)
    db.commit()
    (conv,) = db.query(Conversation).filter(Conversation.project_id == new_id).all()
    # Precondition, asserted rather than skipped (a skip reports green): the ids repeat.
    assert (new_id, conv.id) == (aid, caid)
    assert conv.media_filename is None, (
        "the media-less import adopted the deleted project's recording"
    )
    assert not fa.exists()


# ── The failure SENTENCE (Q5): true once the files are staged ────────────────────────

@pytest.fixture
def app_db():
    """The app's own engine (StaticPool, `check_same_thread=False`), as the endpoint
    runs: it hands the session to worker threads, and the suite's per-test engine
    gives each thread its own empty in-memory database (`test_trackj_j3_roundtrip`'s
    fixture)."""
    from app.database import Base, SessionLocal, engine
    from app.models.user import User
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    db.add(User(id=1, username="testuser", password_hash="x", is_admin=True))
    db.flush()
    try:
        yield db
    finally:
        db.rollback()
        db.close()
        Base.metadata.drop_all(bind=engine)


def _endpoint(db, data: bytes, mode: str, target_id: int):
    import asyncio
    from starlette.datastructures import UploadFile
    from app.models.user import User
    from app.routers.project_portability import import_project_endpoint
    return asyncio.run(import_project_endpoint(
        file=UploadFile(filename="m.mmproject", file=io.BytesIO(data)),
        import_mode=mode, target_project_id=target_id, coder_mapping=None,
        code_mapping=None, db=db, user=db.get(User, 1),
    ))


def test_the_endpoint_names_a_damaged_file_and_says_nothing_changed(app_db, tmp_path, backups):
    from fastapi import HTTPException
    from app.config import get_documents_dir, get_media_dir
    db = app_db
    docs, media = get_documents_dir(), get_media_dir()
    target, _conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path, corrupt=True)
    f.write_bytes(OLD)
    with pytest.raises(HTTPException) as exc:
        _endpoint(db, archive.read_bytes(), "overwrite", target.id)
    assert exc.value.status_code == 400
    assert "damaged" in exc.value.detail and "Nothing was changed" in exc.value.detail
    assert f.read_bytes() == OLD


def test_the_endpoint_names_a_full_disk(app_db, tmp_path, backups, monkeypatch):
    from fastapi import HTTPException
    from app.config import get_documents_dir, get_media_dir
    db = app_db
    docs, media = get_documents_dir(), get_media_dir()
    target, _conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path)
    f.write_bytes(OLD)
    _enospc_after(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        _endpoint(db, archive.read_bytes(), "overwrite", target.id)
    assert exc.value.status_code == 507
    assert "Nothing was changed" in exc.value.detail
    assert f.read_bytes() == OLD


@pytest.mark.parametrize("mode, words", [
    ("merge", "The merge could not be completed, and nothing was changed."),
    ("overwrite", "Project import failed, and nothing was changed."),
])
def test_a_server_fault_says_nothing_changed_in_the_words_of_the_act(
    app_db, backups, monkeypatch, mode, words,
):
    """The Merge page shows the server's sentence first (#1232), so a merge's fault must not
    call itself an import."""
    from fastapi import HTTPException
    from app.config import get_media_dir
    from app.routers import project_portability as router

    def fails(*args, **kwargs):
        raise RuntimeError("an unexpected fault")

    db = app_db
    target, _conv, _f = _make(db, get_media_dir(), "Study")
    db.commit()
    monkeypatch.setattr(router, "import_project", fails)
    with pytest.raises(HTTPException) as exc:
        _endpoint(db, b"PK", mode, target.id)
    assert exc.value.status_code == 500
    assert exc.value.detail.startswith(words)


# ── Moving into place: across disks, and past a folder another program holds ─────────

def _refuse_replace(monkeypatch, refuse):
    """Route `os.replace` through `refuse(src, dst)`, which raises to refuse a move."""
    real = pp.os.replace

    def replace(src, dst):
        refuse(str(src), str(dst))
        return real(src, dst)

    monkeypatch.setattr(pp.os, "replace", replace)


def test_a_data_folder_on_another_disk_still_receives_the_files(
    db_session, tmp_path, backups, monkeypatch,
):
    """A `media/` that is a mount point, or a link to another disk, cannot take a rename
    from the staging folder beside it (EXDEV). The move copies and removes instead."""
    db = db_session
    docs, media = _dirs(tmp_path)
    src, _c, _f = _make(db, media, "Source")
    db.commit()
    archive = _archive(db, src.id, docs, media, tmp_path)
    crossed = []

    def another_disk(a, b):
        if (".import-" in a) != (".import-" in b):  # into or out of the staging folder
            crossed.append(a)
            raise OSError(errno.EXDEV, "Invalid cross-device link")

    _refuse_replace(monkeypatch, another_disk)
    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1)
    db.commit()
    assert crossed, "precondition: the move out of staging was refused as cross-device"
    (conv,) = db.query(Conversation).filter(Conversation.project_id == new_id).all()
    assert (media / str(new_id) / str(conv.id) / "original.mp3").read_bytes() == ARCHIVED
    assert _staging_left(tmp_path) == []


def test_a_folder_held_open_on_windows_is_retried_until_it_lets_go(
    db_session, tmp_path, backups, monkeypatch,
):
    """Windows refuses to rename a folder while a file in it is open — the player streaming
    the recording of the project being overwritten. Such an open usually ends in seconds."""
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, f = _make(db, media, "Study")
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path)
    f.write_bytes(OLD)
    held_folder = str(media / str(target.id))
    refusals = [2]

    def held_open(a, b):
        if a == held_folder and refusals[0]:
            refusals[0] -= 1
            raise PermissionError(errno.EACCES, "The process cannot access the file")

    monkeypatch.setattr(pp, "_RENAME_RETRY_DELAYS", (0, 0))
    _refuse_replace(monkeypatch, held_open)
    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1,
                               import_mode="overwrite", target_project_id=target.id)
    db.commit()
    assert new_id == target.id, "fixture: the id is reused, so its folder must be set aside"
    assert refusals == [0], "precondition: the folder was refused twice"
    (conv,) = db.query(Conversation).filter(Conversation.project_id == new_id).all()
    assert (media / str(new_id) / str(conv.id) / "original.mp3").read_bytes() == ARCHIVED
    assert _staging_left(tmp_path) == []


def test_a_replaced_folder_that_will_not_move_does_not_cost_the_imported_files(
    db_session, tmp_path, backups, monkeypatch,
):
    """An overwrite that gave the project a NEW id sets the old folder aside LAST, and only
    logs a refusal: a folder another program keeps open is left behind, and the import's
    own files still land."""
    db = db_session
    docs, media = _dirs(tmp_path)
    target, _conv, f = _make(db, media, "Study")
    _make(db, media, "Later project")  # the target is not the newest: the overwrite takes a new id
    db.commit()
    archive = _archive(db, target.id, docs, media, tmp_path)
    tid = target.id
    refused = []

    def held_open(a, b):
        if a == str(media / str(tid)):
            refused.append(a)
            raise PermissionError(errno.EACCES, "The process cannot access the file")

    _refuse_replace(monkeypatch, held_open)
    new_id, _ = import_project(db, archive, docs, media_dir=media, user_id=1,
                               import_mode="overwrite", target_project_id=tid)
    db.commit()
    assert new_id != tid, "fixture: the overwrite must take a new id"
    assert refused, "precondition: the replaced folder was refused"
    (conv,) = db.query(Conversation).filter(Conversation.project_id == new_id).all()
    assert (media / str(new_id) / str(conv.id) / "original.mp3").read_bytes() == ARCHIVED
    assert f.exists(), "the held folder is left whole (and logged), never half-removed"
    assert _staging_left(tmp_path) == []


# ── What a stopped import left: swept at startup, and only its own ──────────────────

def test_startup_sweeps_an_abandoned_import_and_nothing_else_beside_the_data(
    tmp_path, monkeypatch,
):
    """Entered at the pipeline's mouth (#747), the lifespan itself. A process killed during
    an import — or a placement that failed after the commit — leaves its staging beside
    `documents/` and `media/`; the restore keeps fixed-name staging in the same folder,
    which §8 of the backup rules leaves to the next restore."""
    from fastapi.testclient import TestClient
    from app import main as app_main

    data = tmp_path / "data"
    abandoned = data / f"{pp.IMPORT_STAGING_PREFIX}abc.partial"
    (abandoned / "media" / "in" / "7").mkdir(parents=True)
    (abandoned / "media" / "in" / "7" / "original.mp3").write_bytes(ARCHIVED)
    running = data / f"{pp.IMPORT_STAGING_PREFIX}def.partial"  # an import still running
    (running / "documents").mkdir(parents=True)
    restores = data / ".media_restore_stage_tmp"
    restores.mkdir(parents=True)
    hour_ago = time.time() - 2 * 3600
    for entry in (abandoned, restores):
        for root, dirs, files in os.walk(entry):
            for name in dirs + files:
                os.utime(os.path.join(root, name), (hour_ago, hour_ago))
        os.utime(entry, (hour_ago, hour_ago))
    monkeypatch.setattr(app_main, "get_backup_dir", lambda: tmp_path / "backups")
    monkeypatch.setattr(app_main, "get_media_dir", lambda: data / "media")
    monkeypatch.setattr(app_main, "get_documents_dir", lambda: data / "documents")

    with TestClient(app_main.app):
        pass

    assert not abandoned.exists(), "startup did not sweep an abandoned import's staging"
    assert running.exists(), "a staging folder written within the hour may be a running import"
    assert restores.exists(), "the restore's staging is not the import's to judge"
