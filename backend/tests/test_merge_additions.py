"""#1190 (D15) — `/validate-import`'s `merge_additions`: what a merge would ADD that the
target does not hold, shown on the Merge page's Review step before the merge runs.

A plain delete leaves no trace until 1.5.9, so an older copy brings a deleted source,
record or quote back silently; the preview names (or counts) what arrives so a researcher
can recognise it. Each removal below goes through its real HTTP door.

🔴 **The preview must PREDICT the merge** — `test_the_preview_predicts_the_merge` runs the
real merge on the same file and compares every count with what actually arrived. A
preview that disagrees with the act is the defect class (the export ceiling's rule).

🔴 **A withdrawn person is counted, never named** — the payload is searched for their
identifier and name.
"""

from __future__ import annotations

import inspect
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.code import Code
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.excerpt import Excerpt
from app.models.memo import Memo
from app.models.note import Note
from app.models.participant import Participant
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.routers import participants as participants_router
from app.routers.project_portability import validate_import_endpoint
from app.services import merge_additions as ma


@pytest.fixture
def client():
    Base.metadata.create_all(bind=engine)
    with pytest.MonkeyPatch.context() as mp, TestClient(app) as c:
        mp.setattr(participants_router, "create_backup",
                   lambda *a, **k: SimpleNamespace(filename="pre_withdrawal_test.mmbackup"))
        status = c.get("/api/auth/status")
        assert status.status_code == 200, status.text
        H = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
        yield SimpleNamespace(c=c, H=H, user_id=status.json()["user"]["id"])
    db = SessionLocal()
    try:
        for table in ("removal_tombstones", "audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()
    finally:
        db.close()
    Base.metadata.drop_all(bind=engine)


def ok(resp):
    assert resp.status_code < 300, (
        resp.request.method, str(resp.request.url), resp.status_code, resp.text[:600])
    return resp.json() if resp.content else None


def _col(ds, code, seq):
    return DatasetColumn(dataset_id=ds.id, column_code=code, column_text=code, column_name=code,
                         column_type=ColumnType.OPEN_TEXT, sequence_order=seq, display_order=seq,
                         source="imported")


def build_world(k) -> dict:
    pid = ok(k.c.post("/api/projects", json={"name": "Study"}, headers=k.H))["id"]
    db = SessionLocal()
    P = {}
    for ident, name in (("M01", "Maria"), ("S02", "Sam"), ("P07", "Pat"), ("Q09", "Quinn")):
        p = Participant(project_id=pid, identifier=ident, display_name=name)
        db.add(p); db.flush(); P[ident] = p.id
    c1 = Conversation(project_id=pid, name="Focus group")
    c2 = Conversation(project_id=pid, name="Deleted interview")
    c3 = Conversation(project_id=pid, name="Second deleted interview")
    db.add_all([c1, c2, c3]); db.flush()
    sp_m = Speaker(project_id=pid, name="Maria", participant_id=P["M01"], color_index=1)
    sp_i = Speaker(project_id=pid, name="Interviewer", is_facilitator=1, color_index=2)
    db.add_all([sp_m, sp_i]); db.flush()
    s = []
    for i, (sp, w) in enumerate([(sp_i, "How are you?"), (sp_m, "Fine, thanks.")]):
        seg = Segment(conversation_id=c1.id, speaker_id=sp.id, sequence_order=i, text=w,
                      word_count=len(w.split()))
        db.add(seg); db.flush(); s.append(seg.id)
    for conv in (c2, c3):
        db.add(Segment(conversation_id=conv.id, speaker_id=sp_i.id, sequence_order=0,
                       text="A question.", word_count=2))
    d1 = Document(project_id=pid, name="Deleted doc", source_filename="d1.txt",
                  source_format="txt", segmentation_mode="paragraph")
    db.add(d1); db.flush()
    db.add(Segment(document_id=d1.id, sequence_order=0, text="Doc words.", word_count=2))
    health = Code(project_id=pid, name="health", numeric_id=1)
    db.add(health); db.flush()

    ds1 = Dataset(project_id=pid, name="Survey"); db.add(ds1); db.flush()
    q1 = _col(ds1, "Q1", 0); db.add(q1); db.flush()
    rows, vals = {}, {}
    for ident in ("S02", "P07", "R99"):
        r = DatasetRow(dataset_id=ds1.id, row_identifier=ident,
                       participant_id=P.get(ident))
        db.add(r); db.flush(); rows[ident] = r.id
        v = DatasetValue(row_id=r.id, column_id=q1.id, value_text=f"{ident} answer")
        db.add(v); db.flush(); vals[ident] = v.id
    ds2 = Dataset(project_id=pid, name="Deleted dataset"); db.add(ds2); db.flush()
    q2 = _col(ds2, "Q2", 0); db.add(q2); db.flush()
    r2 = DatasetRow(dataset_id=ds2.id, row_identifier="X1"); db.add(r2); db.flush()
    db.add(DatasetValue(row_id=r2.id, column_id=q2.id, value_text="X1 answer"))

    e_whole = Excerpt(project_id=pid, segment_id=s[1])
    e_p07 = Excerpt(project_id=pid, dataset_value_id=vals["P07"])
    db.add_all([e_whole, e_p07]); db.flush()
    n_seg = Note(conversation_id=c1.id, segment_id=s[1], content="A note", sequence_number=1)
    db.add(n_seg); db.flush()
    memo = Memo(project_id=pid, numeric_id=1, entity_type="code", entity_id=health.id,
                title="A memo", content="memo")
    db.add(memo); db.flush()
    db.commit()
    ids = dict(pid=pid, P=P, c1=c1.id, c2=c2.id, c3=c3.id, s=s, d1=d1.id, ds1=ds1.id,
               ds2=ds2.id, rows=rows, e_whole=e_whole.id, n_seg=n_seg.id, memo=memo.id)
    db.close()
    return ids


def export(k, pid) -> bytes:
    r = k.c.get(f"/api/projects/{pid}/export-project")
    assert r.status_code == 200, r.text[:300]
    return r.content


def validate(k, blob) -> dict:
    return ok(k.c.post("/api/projects/validate-import",
                       files={"file": ("copy.mmproject", blob, "application/zip")}, headers=k.H))


def merge(k, blob, pid):
    return k.c.post("/api/projects/import-project",
                    data={"import_mode": "merge", "target_project_id": str(pid)},
                    files={"file": ("copy.mmproject", blob, "application/zip")}, headers=k.H)


def counts(pid) -> dict:
    db = SessionLocal()
    try:
        one = lambda sql: db.execute(text(sql), {"p": pid}).scalar()  # noqa: E731
        return {
            "sources": one("SELECT (SELECT count(*) FROM conversations WHERE project_id=:p)"
                           " + (SELECT count(*) FROM documents WHERE project_id=:p)"
                           " + (SELECT count(*) FROM observations WHERE project_id=:p)"),
            "participants": one("SELECT count(*) FROM participants WHERE project_id=:p"),
            "datasets": one("SELECT count(*) FROM datasets WHERE project_id=:p"),
            "rows": one("SELECT count(*) FROM dataset_rows r JOIN datasets d ON d.id=r.dataset_id"
                        " WHERE d.project_id=:p"),
            "quotes": one("SELECT count(*) FROM excerpt WHERE project_id=:p"),
            "notes": one("SELECT count(*) FROM notes n WHERE n.conversation_id IN"
                         " (SELECT id FROM conversations WHERE project_id=:p)"),
            "memos": one("SELECT count(*) FROM memos WHERE project_id=:p"),
        }
    finally:
        db.close()


def remove_things(k, ids):
    """Every plain delete the preview must name or count, plus one withdrawal (P07)."""
    c, H, pid = k.c, k.H, ids["pid"]
    ok(c.delete(f"/api/projects/{pid}/conversations/{ids['c2']}", headers=H))
    ok(c.delete(f"/api/projects/{pid}/documents/{ids['d1']}", headers=H))
    ok(c.delete(f"/api/projects/{pid}/datasets/{ids['ds2']}", headers=H))
    ok(c.delete(f"/api/projects/{pid}/datasets/{ids['ds1']}/rows/{ids['rows']['R99']}", headers=H))
    ok(c.delete(f"/api/projects/{pid}/participants/{ids['P']['Q09']}", headers=H))
    ok(c.delete(f"/api/projects/{pid}/excerpts/{ids['e_whole']}", headers=H))
    ok(c.delete(f"/api/projects/{pid}/notes/{ids['n_seg']}", params={"permanent": "true"}, headers=H))
    ok(c.delete(f"/api/projects/{pid}/memos/{ids['memo']}", params={"permanent": "true"}, headers=H))
    ok(c.post(f"/api/projects/{pid}/participants/{ids['P']['P07']}/withdraw", headers=H))


NOTHING = {
    "sources": [], "source_count": 0, "participants": [], "participant_count": 0,
    "datasets": [], "dataset_count": 0, "records": [], "record_count": 0,
    "quotes": 0, "notes": 0, "memos": 0, "withdrawn_participants": 0, "withdrawn_items": 0,
}


def test_a_current_copy_adds_nothing(client):
    """POSITIVE CONTROL for "held": a copy of the project as it is brings nothing new."""
    ids = build_world(client)
    v = validate(client, export(client, ids["pid"]))
    assert v["existing_project"]["id"] == ids["pid"]
    assert v["merge_additions"] == NOTHING


def test_it_names_what_was_deleted_here_and_counts_the_rest(client):
    ids = build_world(client)
    e0 = export(client, ids["pid"])
    remove_things(client, ids)
    got = validate(client, e0)["merge_additions"]
    assert got == {
        "sources": [{"kind": "conversation", "name": "Deleted interview"},
                    {"kind": "document", "name": "Deleted doc"}],
        "source_count": 2,
        "participants": ["Q09"], "participant_count": 1,
        "datasets": [{"name": "Deleted dataset", "records": 1}], "dataset_count": 1,
        "records": [{"dataset": "Survey", "count": 1}], "record_count": 1,
        "quotes": 1, "notes": 1, "memos": 1,
        # P07: her record, and the quote of her answer — left out, by count.
        "withdrawn_participants": 1, "withdrawn_items": 2,
    }


def test_a_withdrawn_person_is_counted_never_named(client):
    ids = build_world(client)
    e0 = export(client, ids["pid"])
    remove_things(client, ids)
    payload = json.dumps(validate(client, e0)["merge_additions"])
    assert "P07" not in payload and "Pat" not in payload
    # …while a deleted (not withdrawn) person IS named — the control that the
    # search above can see an identifier at all.
    assert "Q09" in payload


def _with_new_uuid(blob: bytes, identifier: str) -> bytes:
    """The file, with one participant under a uuid nothing has seen — a colleague who
    deleted and re-made the person, or linked a wave, after their copy was made."""
    import io
    import zipfile
    src, out = zipfile.ZipFile(io.BytesIO(blob)), io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            raw = src.read(info.filename)
            if info.filename == "project.json":
                data = json.loads(raw)
                for p in data["participants"]:
                    if p["identifier"] == identifier:
                        p["uuid"] = "00000000-0000-4000-8000-00000000c0de"
                raw = json.dumps(data).encode()
            dst.writestr(info, raw)
    return out.getvalue()


def test_a_withdrawn_identifier_under_a_new_uuid_is_still_never_named(client):
    """The tombstone names her by uuid AND by her identifier's hash; the second is the
    only thing that recognises her under a uuid minted after the withdrawal."""
    ids = build_world(client)
    e0 = _with_new_uuid(export(client, ids["pid"]), "P07")
    ok(client.c.post(f"/api/projects/{ids['pid']}/participants/{ids['P']['P07']}/withdraw",
                     headers=client.H))
    got = validate(client, e0)["merge_additions"]
    assert "P07" not in json.dumps(got)
    assert got["withdrawn_participants"] == 1
    assert got["participants"] == [] and got["participant_count"] == 0


def test_someone_reinstated_under_a_withdrawn_identifier_is_not_counted_as_withdrawn(client):
    """D12 × D15 — the two halves built apart, together. A confirmed re-use of a withdrawn
    identifier records `participant_reinstated`, and the import's one predicate
    (`Tombstones.withdrawn_participant`) then treats THAT participant as living. The
    preview asks the same predicate: by the identifier's hash alone it called them
    withdrawn, while the merge matched them."""
    ids = build_world(client)
    pid = ids["pid"]
    ok(client.c.post(f"/api/projects/{pid}/participants/{ids['P']['P07']}/withdraw",
                     headers=client.H))
    refused = client.c.post(f"/api/projects/{pid}/participants", json={"identifier": "P07"},
                            headers=client.H)
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["error"] == "withdrawn_identifier"
    ok(client.c.post(f"/api/projects/{pid}/participants",
                     json={"identifier": "P07", "confirm_withdrawn": True}, headers=client.H))

    blob = export(client, pid)
    preview = validate(client, blob)["merge_additions"]
    assert preview == NOTHING
    report = ok(merge(client, blob, pid))["merge_report"]
    assert report["withdrawn_participants_skipped"] == preview["withdrawn_participants"] == 0


def test_the_preview_predicts_the_merge(client):
    """Run the real merge on the same file: every count is what actually arrived."""
    ids = build_world(client)
    pid = ids["pid"]
    e0 = export(client, pid)
    remove_things(client, ids)
    preview = validate(client, e0)["merge_additions"]
    before = counts(pid)
    result = ok(merge(client, e0, pid))
    after = counts(pid)
    delta = {k: after[k] - before[k] for k in before}
    assert delta == {
        "sources": preview["source_count"],
        "participants": preview["participant_count"],
        "datasets": preview["dataset_count"],
        "rows": preview["record_count"] + sum(d["records"] for d in preview["datasets"]),
        "quotes": preview["quotes"],
        "notes": preview["notes"],
        "memos": preview["memos"],
    }
    report = result["merge_report"]
    assert report["withdrawn_participants_skipped"] == preview["withdrawn_participants"] == 1
    assert report["withdrawn_items_skipped"] == preview["withdrawn_items"]


def test_the_merges_natural_key_dedups_are_not_additions(client):
    """Deleted and made again: the merge matches the participant by identifier and the
    quote by its shape (#1190's dedups), so neither is announced as coming back."""
    ids = build_world(client)
    c, H, pid = client.c, client.H, ids["pid"]
    e0 = export(client, pid)
    ok(c.delete(f"/api/projects/{pid}/participants/{ids['P']['Q09']}", headers=H))
    ok(c.post(f"/api/projects/{pid}/participants", json={"identifier": "Q09"}, headers=H))
    ok(c.delete(f"/api/projects/{pid}/excerpts/{ids['e_whole']}", headers=H))
    ok(c.post(f"/api/projects/{pid}/excerpts", json={"segment_id": ids["s"][1]}, headers=H))
    got = validate(client, e0)["merge_additions"]
    assert got == NOTHING
    before = counts(pid)
    ok(merge(client, e0, pid))
    assert counts(pid) == before


def test_set_only_when_a_merge_is_possible(client):
    ids = build_world(client)
    e0 = export(client, ids["pid"])
    ok(client.c.delete(f"/api/projects/{ids['pid']}", headers=client.H))
    v = validate(client, e0)
    assert v["existing_project"] is None
    assert v["merge_additions"] is None


def test_names_are_capped_and_the_total_is_kept(client, monkeypatch):
    ids = build_world(client)
    pid = ids["pid"]
    e0 = export(client, pid)
    ok(client.c.delete(f"/api/projects/{pid}/conversations/{ids['c2']}", headers=client.H))
    ok(client.c.delete(f"/api/projects/{pid}/conversations/{ids['c3']}", headers=client.H))
    monkeypatch.setattr(ma, "MERGE_ADDITIONS_NAME_CAP", 1)
    got = validate(client, e0)["merge_additions"]
    assert got["source_count"] == 2
    assert len(got["sources"]) == 1


def test_chunked_lookups_give_the_same_answer(client, monkeypatch):
    """Every id-list lookup runs in chunks (`sql-id-sets.md` §1, §6); a chunk boundary
    between every id must not change a single count."""
    ids = build_world(client)
    e0 = export(client, ids["pid"])
    remove_things(client, ids)
    whole = validate(client, e0)["merge_additions"]
    monkeypatch.setattr(ma, "_CHUNK", 1)
    assert validate(client, e0)["merge_additions"] == whole


def test_the_pass_runs_off_the_event_loop():
    """1.3 s on BES's 122,382 records (2026-10-23) — on the loop it would hold every
    request, `/health` included (#1022). `validate_import_endpoint` stays `async` (it
    awaits the upload), so the preview is handed to the threadpool."""
    src = inspect.getsource(validate_import_endpoint)
    assert "await run_in_threadpool(\n                    build_merge_additions_preview" in src
    assert src.count("build_merge_additions_preview(") == 0
