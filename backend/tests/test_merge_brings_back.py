"""#1190 (merge half) — PROBE: what a merge of an export taken BEFORE a removal brings back.

Written as the WANTED behaviour where the review proposes one; the population
table in `test_population_table` is a MEASUREMENT (it records, it does not assert),
printed with -s.

Every removal goes through its real HTTP door; creation goes through the ORM.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.code import Code
from app.models.code_category import CodeCategory
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.excerpt import Excerpt
from app.models.memo import Memo
from app.models.note import Note
from app.models.observation import Observation
from app.models.participant import Participant
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.speaker import Speaker
from app.routers import participants as participants_router


@pytest.fixture
def client():
    Base.metadata.create_all(bind=engine)
    with pytest.MonkeyPatch.context() as mp, TestClient(app) as c:
        mp.setattr(participants_router, "create_backup",
                   lambda *a, **k: SimpleNamespace(filename="pre_withdrawal_probe.mmbackup"))
        status = c.get("/api/auth/status")
        assert status.status_code == 200, status.text
        H = {"X-CSRF-Token": status.json()["user"]["csrf_token"]}
        yield SimpleNamespace(c=c, H=H, user_id=status.json()["user"]["id"])
    db = SessionLocal()
    try:
        for table in ("audit_entries", "sessions", "projects", "users"):
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()
    finally:
        db.close()
    Base.metadata.drop_all(bind=engine)


def ok(resp):
    assert resp.status_code < 300, (
        resp.request.method, str(resp.request.url), resp.status_code, resp.text[:600])
    return resp.json() if resp.content else None


def _col(ds, code, ctype, seq, source="imported"):
    return DatasetColumn(dataset_id=ds.id, column_code=code, column_text=code, column_name=code,
                         column_type=ctype, sequence_order=seq, display_order=seq, source=source)


def build_world(k) -> dict:
    """One project holding one of everything a removal can reach."""
    c, H = k.c, k.H
    pid = ok(c.post("/api/projects", json={"name": "Probe"}, headers=H))["id"]
    db = SessionLocal()
    uid = k.user_id
    P = {}
    for ident, name in (("M01", "Maria"), ("S02", "Sam"), ("P07", "Pat"),
                        ("Q09", "Quinn"), ("U11", "Una")):
        p = Participant(project_id=pid, identifier=ident, display_name=name)
        db.add(p); db.flush(); P[ident] = p.id

    # ── conversations ──
    c1 = Conversation(project_id=pid, name="Focus group"); db.add(c1); db.flush()
    c2 = Conversation(project_id=pid, name="Deleted interview"); db.add(c2); db.flush()
    sp_m = Speaker(project_id=pid, name="Maria", participant_id=P["M01"], color_index=1)
    sp_s = Speaker(project_id=pid, name="Sam", participant_id=P["S02"], color_index=2)
    sp_i = Speaker(project_id=pid, name="Interviewer", is_facilitator=1, color_index=3)
    sp_q = Speaker(project_id=pid, name="Quinn", participant_id=P["Q09"], color_index=4)
    db.add_all([sp_m, sp_s, sp_i, sp_q]); db.flush()
    words = [(sp_i, "How are you?"), (sp_m, "MARIASAYS I have diabetes."),
             (sp_s, "SAMSAYS the clinic is far."), (sp_s, "SAMAGAIN another turn."),
             (sp_m, "MARIATWO more words."), (sp_s, "SAMTHREE last words.")]
    s = []
    for i, (sp, w) in enumerate(words):
        seg = Segment(conversation_id=c1.id, speaker_id=sp.id, sequence_order=i, text=w,
                      word_count=len(w.split()))
        db.add(seg); db.flush(); s.append(seg.id)
    c2seg = Segment(conversation_id=c2.id, speaker_id=sp_q.id, sequence_order=0,
                    text="QUINNSAYS deleted conversation words.", word_count=4)
    db.add(c2seg); db.flush()
    grp = SegmentGroup(conversation_id=c1.id); db.add(grp); db.flush()
    db.get(Segment, s[4]).group_id = grp.id
    db.get(Segment, s[5]).group_id = grp.id

    # ── documents ──
    d1 = Document(project_id=pid, name="Deleted doc", source_filename="d1.txt",
                  source_format="txt", segmentation_mode="paragraph")
    d2 = Document(project_id=pid, name="Una's workplan", source_filename="d2.txt",
                  source_format="txt", segmentation_mode="paragraph", participant_id=P["U11"])
    db.add_all([d1, d2]); db.flush()
    d1seg = Segment(document_id=d1.id, sequence_order=0, text="DOCWORDS deleted document.",
                    word_count=3)
    d2seg = Segment(document_id=d2.id, sequence_order=0, text="Una plans.", word_count=2)
    db.add_all([d1seg, d2seg]); db.flush()

    # ── observations (open) ──
    o1 = Observation(project_id=pid, name="Kept obs", media_duration_seconds=100.0)
    o2 = Observation(project_id=pid, name="Deleted obs", media_duration_seconds=100.0)
    db.add_all([o1, o2]); db.flush()
    clip_keep = Segment(observation_id=o1.id, sequence_order=0, text="clip A",
                        start_time=0.0, end_time=10.0)
    clip_del = Segment(observation_id=o1.id, sequence_order=1, text="clip B",
                       start_time=10.0, end_time=20.0)
    o2clip = Segment(observation_id=o2.id, sequence_order=0, text="clip C",
                     start_time=0.0, end_time=5.0)
    db.add_all([clip_keep, clip_del, o2clip]); db.flush()

    # ── codebook ──
    cat = CodeCategory(project_id=pid, name="Deleted category"); db.add(cat); db.flush()
    health = Code(project_id=pid, name="health", numeric_id=1)
    work = Code(project_id=pid, name="work", numeric_id=2, category_id=cat.id)
    old = Code(project_id=pid, name="oldcode", numeric_id=3)
    db.add_all([health, work, old]); db.flush()

    # ── datasets ──
    ds1 = Dataset(project_id=pid, name="Survey"); db.add(ds1); db.flush()
    q1 = _col(ds1, "Q1", ColumnType.OPEN_TEXT, 0)
    extra = _col(ds1, "Extra", ColumnType.OPEN_TEXT, 1, source="manual")
    db.add_all([q1, extra]); db.flush()
    rows = {}
    for ident, pkey in (("S02", "S02"), ("P07", "P07"), ("Q09", "Q09"), ("R99", None)):
        r = DatasetRow(dataset_id=ds1.id, participant_id=P[pkey] if pkey else None,
                       row_identifier=ident)
        db.add(r); db.flush(); rows[ident] = r.id
    vals = {}
    for ident, answer in (("S02", "Sam answer"), ("P07", "PATSAYS I have diabetes"),
                          ("Q09", "QUINNANSWER"), ("R99", "UNLINKEDANSWER")):
        v = DatasetValue(row_id=rows[ident], column_id=q1.id, value_text=answer)
        db.add(v); db.flush(); vals[ident] = v.id
    db.add(DatasetValue(row_id=rows["S02"], column_id=extra.id, value_text="EXTRACELL"))
    ds2 = Dataset(project_id=pid, name="Deleted dataset"); db.add(ds2); db.flush()
    q2 = _col(ds2, "Q2", ColumnType.OPEN_TEXT, 0); db.add(q2); db.flush()
    r2 = DatasetRow(dataset_id=ds2.id, row_identifier="X1"); db.add(r2); db.flush()
    db.add(DatasetValue(row_id=r2.id, column_id=q2.id, value_text="DS2ANSWER")); db.flush()

    # ── codings ──
    apps = [
        CodeApplication(segment_id=s[1], code_id=health.id, user_id=uid),   # uncoded later
        CodeApplication(segment_id=s[2], code_id=work.id, user_id=uid),     # kept
        CodeApplication(segment_id=s[3], code_id=old.id, user_id=uid),      # code merged away
        CodeApplication(segment_id=c2seg.id, code_id=health.id, user_id=uid),
        CodeApplication(segment_id=d1seg.id, code_id=health.id, user_id=uid),
        CodeApplication(segment_id=o2clip.id, code_id=health.id, user_id=uid),
        CodeApplication(segment_id=clip_del.id, code_id=health.id, user_id=uid),
        CodeApplication(dataset_value_id=vals["S02"], code_id=health.id, user_id=uid),  # uncoded
        CodeApplication(dataset_value_id=vals["P07"], code_id=health.id, user_id=uid),  # withdrawn
    ]
    db.add_all(apps); db.flush()

    # ── quotes, notes, memos ──
    e_whole = Excerpt(project_id=pid, segment_id=s[2])
    e_char = Excerpt(project_id=pid, segment_id=s[3], start_offset=0, end_offset=7)
    e_val = Excerpt(project_id=pid, dataset_value_id=vals["S02"])
    e_p07 = Excerpt(project_id=pid, dataset_value_id=vals["P07"])
    db.add_all([e_whole, e_char, e_val, e_p07]); db.flush()
    n_seg = Note(conversation_id=c1.id, segment_id=s[2], content="NOTESEG", sequence_number=1)
    n_val = Note(dataset_value_id=vals["S02"], content="NOTEVAL", sequence_number=1)
    n_arch = Note(conversation_id=c1.id, segment_id=s[3], content="NOTEARCH", sequence_number=2)
    db.add_all([n_seg, n_val, n_arch]); db.flush()
    m_code = Memo(project_id=pid, numeric_id=1, entity_type="code", entity_id=health.id,
                  title="MEMOCODE", content="memo")
    db.add(m_code); db.flush()
    db.commit()
    ids = dict(pid=pid, P=P, c1=c1.id, c2=c2.id, s=s, c2seg=c2seg.id, grp=grp.id,
               d1=d1.id, d2=d2.id, o1=o1.id, o2=o2.id, clip_del=clip_del.id,
               cat=cat.id, health=health.id, work=work.id, old=old.id, old_uuid=old.uuid,
               ds1=ds1.id, ds2=ds2.id, extra=extra.id, rows=rows, vals=vals,
               e_whole=e_whole.id, e_char=e_char.id, e_val=e_val.id, n_seg=n_seg.id,
               n_val=n_val.id, n_arch=n_arch.id, m_code=m_code.id)
    db.close()
    return ids


def export(k, pid) -> bytes:
    r = k.c.get(f"/api/projects/{pid}/export-project")
    assert r.status_code == 200, r.text[:300]
    return r.content


def validate(k, blob):
    return k.c.post("/api/projects/validate-import",
                    files={"file": ("e0.mmproject", blob, "application/zip")}, headers=k.H)


def merge(k, blob, pid, code_mapping=None):
    data = {"import_mode": "merge", "target_project_id": str(pid)}
    if code_mapping is not None:
        data["code_mapping"] = json.dumps(code_mapping)
    return k.c.post("/api/projects/import-project", data=data,
                    files={"file": ("e0.mmproject", blob, "application/zip")}, headers=k.H)


def inventory(pid) -> dict:
    """What is present now — by the words each thing carries, never by id."""
    db = SessionLocal()
    try:
        q = lambda sql, **p: db.execute(text(sql), {"p": pid, **p}).fetchall()  # noqa: E731
        return {
            "participants": sorted(r[0] for r in q(
                "SELECT identifier FROM participants WHERE project_id=:p")),
            "conversations": sorted(r[0] for r in q(
                "SELECT name FROM conversations WHERE project_id=:p")),
            "documents": sorted(r[0] for r in q("SELECT name FROM documents WHERE project_id=:p")),
            "observations": sorted(r[0] for r in q(
                "SELECT name FROM observations WHERE project_id=:p")),
            "clips": sorted(r[0] for r in q(
                "SELECT s.text FROM segments s JOIN observations o ON o.id=s.observation_id "
                "WHERE o.project_id=:p")),
            "datasets": sorted(r[0] for r in q("SELECT name FROM datasets WHERE project_id=:p")),
            "columns": sorted(r[0] for r in q(
                "SELECT c.column_code FROM dataset_columns c JOIN datasets d ON d.id=c.dataset_id "
                "WHERE d.project_id=:p")),
            "rows": sorted((r[0] or "") for r in q(
                "SELECT r.row_identifier FROM dataset_rows r JOIN datasets d ON d.id=r.dataset_id "
                "WHERE d.project_id=:p")),
            "answers": sorted(str(r[0]) for r in q(
                "SELECT v.value_text FROM dataset_values v JOIN dataset_rows r ON r.id=v.row_id "
                "JOIN datasets d ON d.id=r.dataset_id WHERE d.project_id=:p")),
            "codes": sorted(r[0] for r in q("SELECT name FROM codes WHERE project_id=:p")),
            "categories": sorted(r[0] for r in q(
                "SELECT name FROM code_categories WHERE project_id=:p")),
            "excerpts": q("SELECT count(*) FROM excerpt WHERE project_id=:p")[0][0],
            "notes": sorted(r[0] for r in q(
                "SELECT n.content FROM notes n WHERE n.is_archived=0 AND (n.conversation_id IN "
                "(SELECT id FROM conversations WHERE project_id=:p) OR n.dataset_value_id IN "
                "(SELECT v.id FROM dataset_values v JOIN dataset_rows r ON r.id=v.row_id JOIN "
                "datasets d ON d.id=r.dataset_id WHERE d.project_id=:p))")),
            "memos": sorted(r[0] for r in q("SELECT title FROM memos WHERE project_id=:p AND is_archived=0")),
            "segment_groups": q(
                "SELECT count(*) FROM segment_groups g JOIN conversations c ON c.id=g.conversation_id "
                "WHERE c.project_id=:p")[0][0],
            "applications": q(
                "SELECT count(*) FROM code_applications a JOIN codes c ON c.id=a.code_id "
                "WHERE c.project_id=:p AND a.origin != 'consensus'")[0][0],
            "segment_texts": sorted(r[0] for r in q(
                "SELECT s.text FROM segments s JOIN conversations c ON c.id=s.conversation_id "
                "WHERE c.project_id=:p")),
        }
    finally:
        db.close()


def remove_everything_plain(k, ids):
    """Scenario A: every plain removal + a DATASET-ONLY withdrawal (no turns, no text gate)."""
    c, H, pid = k.c, k.H, ids["pid"]
    s = ids["s"]
    done = {}
    done["excerpt (whole, turn)"] = c.delete(f"/api/projects/{pid}/excerpts/{ids['e_whole']}", headers=H)
    done["excerpt (char-range)"] = c.delete(f"/api/projects/{pid}/excerpts/{ids['e_char']}", headers=H)
    done["excerpt (response)"] = c.delete(f"/api/projects/{pid}/excerpts/{ids['e_val']}", headers=H)
    done["coding (turn)"] = c.delete(f"/api/segments/{s[1]}/codes/{ids['health']}", headers=H)
    done["coding (response)"] = c.delete(
        f"/api/projects/{pid}/text-coding/code",
        params={"dataset_value_id": ids["vals"]["S02"], "code_id": ids["health"]}, headers=H)
    done["note (turn, permanent)"] = c.delete(
        f"/api/projects/{pid}/notes/{ids['n_seg']}", params={"permanent": "true"}, headers=H)
    done["note (turn, archive)"] = c.delete(f"/api/projects/{pid}/notes/{ids['n_arch']}", headers=H)
    done["note (response, archive)"] = c.delete(
        f"/api/projects/{pid}/text-coding/notes/{ids['n_val']}", headers=H)
    done["memo (permanent)"] = c.delete(
        f"/api/projects/{pid}/memos/{ids['m_code']}", params={"permanent": "true"}, headers=H)
    done["participant (plain delete)"] = c.delete(
        f"/api/projects/{pid}/participants/{ids['P']['Q09']}", headers=H)
    done["withdrawal (dataset-only P07)"] = c.post(
        f"/api/projects/{pid}/participants/{ids['P']['P07']}/withdraw", headers=H)
    done["dataset row"] = c.delete(
        f"/api/projects/{pid}/datasets/{ids['ds1']}/rows/{ids['rows']['R99']}", headers=H)
    done["manual column"] = c.delete(
        f"/api/projects/{pid}/datasets/{ids['ds1']}/columns/{ids['extra']}/manual", headers=H)
    done["dataset"] = c.delete(f"/api/projects/{pid}/datasets/{ids['ds2']}", headers=H)
    done["conversation"] = c.delete(f"/api/projects/{pid}/conversations/{ids['c2']}", headers=H)
    done["document"] = c.delete(f"/api/projects/{pid}/documents/{ids['d1']}", headers=H)
    done["observation"] = c.delete(f"/api/projects/{pid}/observations/{ids['o2']}", headers=H)
    done["clip (open observation)"] = c.delete(
        f"/api/projects/{pid}/observations/{ids['o1']}/segments/{ids['clip_del']}", headers=H)
    done["category"] = c.delete(f"/api/projects/{pid}/categories/{ids['cat']}", headers=H)
    done["segment group (ungroup)"] = c.delete(
        f"/api/conversations/{ids['c1']}/segments/group/{ids['grp']}", headers=H)
    done["code (merged, delete_source)"] = c.post(
        f"/api/projects/{pid}/codes/{ids['old']}/merge/{ids['health']}",
        params={"delete_source": "true"}, headers=H)
    for name, r in done.items():
        assert r.status_code < 300, (name, r.status_code, r.text[:400])
    return done


# ── the population table (a MEASUREMENT) ────────────────────────────────────


def test_population_table(client):
    ids = build_world(client)
    pid = ids["pid"]
    e0 = export(client, pid)
    before = inventory(pid)
    remove_everything_plain(client, ids)
    after_removal = inventory(pid)

    v = validate(client, e0)
    print("\nVALIDATE:", v.status_code, sorted((v.json() or {}).keys()))
    print("  merge_codes_preview:", json.dumps(v.json().get("merge_codes_preview"))[:400])

    r1 = merge(client, e0, pid)
    print("MERGE (no code_mapping):", r1.status_code, json.dumps(r1.json())[:300])
    # The Reconcile step's default is D-2 = ALWAYS 'new'.
    r2 = merge(client, e0, pid, code_mapping={ids["old_uuid"]: {"action": "new"}})
    print("MERGE (oldcode -> new):", r2.status_code, json.dumps(r2.json())[:700])
    after_merge = inventory(pid)

    print("\n%-14s %-55s %-55s %s" % ("key", "before", "after removal", "after merge"))
    for key in before:
        print("%-14s %-55s %-55s %s" % (key, str(before[key])[:55],
                                        str(after_removal[key])[:55], str(after_merge[key])[:200]))
    assert r2.status_code == 200


def test_an_older_copy_merges_after_a_withdrawal_that_blanked_turns(client):
    """Scenario B, INVERTED at the build (#1190): at HEAD, once #1320 blanked Maria's
    turns, every copy made before the withdrawal answered 409 `segment_text` ("2 of 6"),
    forever. Now her blanked turns are exempt from the text gate, the merge keeps the
    target's blank, and the report counts what of hers the copy held."""
    ids = build_world(client)
    pid = ids["pid"]
    s = ids["s"]
    e0 = export(client, pid)
    ok(client.c.post(f"/api/projects/{pid}/participants/{ids['P']['M01']}/withdraw",
                     headers=client.H))
    r = merge(client, e0, pid, code_mapping={})
    assert r.status_code == 200, r.text
    report = r.json()["merge_report"]
    assert report["withdrawn_participants_skipped"] == 1
    db = SessionLocal()
    try:
        texts = [db.get(Segment, sid).text for sid in (s[1], s[4])]
        assert not any("MARIA" in t for t in texts), texts
        assert db.query(Participant).filter(
            Participant.project_id == pid, Participant.identifier == "M01").count() == 0
    finally:
        db.close()
    # Control — a post-withdrawal export merges too, and holds nothing of hers to skip.
    e1 = export(client, pid)
    r_ctrl = merge(client, e1, pid)
    assert r_ctrl.status_code == 200, r_ctrl.text
    assert r_ctrl.json()["merge_report"]["withdrawn_participants_skipped"] == 0


def test_collisions_after_recreate(client):
    """Scenario C: a removal, then a re-creation, then a merge of the older copy.

    At HEAD all four were a bare 500 (EXECUTED by r3 and the lead); since the build
    each answers 200 — the detailed assertions per case live in
    `test_withdrawal_tombstones.py::TestARecreationIsNotA500`."""
    ids = build_world(client)
    pid = ids["pid"]
    c, H = client.c, client.H
    e0 = export(client, pid)
    # (1) delete Quinn, then a NEW participant Q09 (link, conversation import, by hand)
    ok(c.delete(f"/api/projects/{pid}/participants/{ids['P']['Q09']}", headers=H))
    ok(c.post(f"/api/projects/{pid}/participants", json={"identifier": "Q09"}, headers=H))
    r = merge(client, e0, pid, code_mapping={})
    print("\nMERGE after delete + re-create Q09:", r.status_code, r.text[:400])
    results = {"participant": r.status_code}
    # (2) a whole quote deleted and re-made on the same turn
    ids2 = build_world(client)
    pid2 = ids2["pid"]
    e2 = export(client, pid2)
    ok(c.delete(f"/api/projects/{pid2}/excerpts/{ids2['e_whole']}", headers=H))
    ok(c.post(f"/api/projects/{pid2}/excerpts", json={"segment_id": ids2["s"][2]}, headers=H))
    r = merge(client, e2, pid2, code_mapping={})
    print("MERGE after a whole quote deleted + re-made:", r.status_code, r.text[:400])
    results["whole quote"] = r.status_code
    # (3) Sam's record deleted, then Sam linked to another record of the same dataset
    ids3 = build_world(client)
    pid3 = ids3["pid"]
    e3 = export(client, pid3)
    ok(c.delete(f"/api/projects/{pid3}/datasets/{ids3['ds1']}/rows/{ids3['rows']['S02']}",
                headers=H))
    db = SessionLocal()
    db.query(DatasetRow).filter(DatasetRow.id == ids3["rows"]["R99"]).update(
        {"participant_id": ids3["P"]["S02"]})
    db.commit(); db.close()
    r = merge(client, e3, pid3, code_mapping={})
    print("MERGE after a record deleted + the person re-linked:", r.status_code, r.text[:200])
    results["row per participant"] = r.status_code
    # (4) a char-range quote deleted and re-made on the same span
    ids4 = build_world(client)
    pid4 = ids4["pid"]
    e4 = export(client, pid4)
    ok(c.delete(f"/api/projects/{pid4}/excerpts/{ids4['e_char']}", headers=H))
    ok(c.post(f"/api/projects/{pid4}/excerpts",
              json={"segment_id": ids4["s"][3], "start_offset": 0, "end_offset": 7}, headers=H))
    r = merge(client, e4, pid4, code_mapping={})
    print("MERGE after a char-range quote deleted + re-made:", r.status_code, r.text[:200])
    results["char-range quote"] = r.status_code
    print("RESULTS:", results)
    assert results == {"participant": 200, "whole quote": 200, "row per participant": 200,
                       "char-range quote": 200}, results


def test_linking_recreates_a_withdrawn_identifier(client):
    """#1190 linking half: withdraw P07, then link a second (never-linked) dataset."""
    ids = build_world(client)
    pid = ids["pid"]
    c, H = client.c, client.H
    db = SessionLocal()
    ds3 = Dataset(project_id=pid, name="Wave 2"); db.add(ds3); db.flush()
    idc = _col(ds3, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
    ans = _col(ds3, "A", ColumnType.OPEN_TEXT, 1); db.add(ans); db.flush()
    r = DatasetRow(dataset_id=ds3.id, row_identifier="1"); db.add(r); db.flush()
    db.add(DatasetValue(row_id=r.id, column_id=idc.id, value_text="P07"))
    db.add(DatasetValue(row_id=r.id, column_id=ans.id, value_text="WAVE2 P07 answer"))
    db.commit(); ds3_id, idc_id = ds3.id, idc.id; db.close()
    ok(c.post(f"/api/projects/{pid}/participants/{ids['P']['P07']}/withdraw", headers=H))
    preview = ok(c.post(f"/api/projects/{pid}/datasets/{ds3_id}/link-by-column/preview",
                        json={"column_id": idc_id}, headers=H))
    print("\nLINK PREVIEW after withdrawing P07:", preview)
    rep = ok(c.post(f"/api/projects/{pid}/datasets/{ds3_id}/link-by-column",
                    json={"column_id": idc_id}, headers=H))
    print("LINK:", rep)
    db = SessionLocal()
    back = db.query(Participant).filter(Participant.project_id == pid,
                                        Participant.identifier == "P07").count()
    db.close()
    print("P07 participants after the link:", back)
    # At HEAD: preview `created: 1`, and P07 was minted again. The preview and the
    # act are one plan, so both say it.
    assert preview["created"] == 0 and preview["skipped_withdrawn"] == 1, preview
    assert rep["created"] == 0 and rep["skipped_withdrawn"] == 1, rep
    assert back == 0
