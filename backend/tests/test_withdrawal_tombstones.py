"""#1190 — a withdrawal is REMEMBERED, so no older copy and no later link brings the
person back. Written as the wanted behaviour: each test fails on 2fe78dc7.

Every removal goes through its real HTTP door; the world is built through the ORM
(`test_merge_brings_back.build_world`).
"""

from __future__ import annotations

import io
import json
import uuid as _uuid

import pytest
from sqlalchemy import text

from app.database import Base, SessionLocal
from app.models.dataset import ColumnType, Dataset, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.participant import Participant
from app.models.segment import Segment
from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT
from tests.archive_support import archive_extras, archive_payload, write_archive
from tests.test_merge_brings_back import (  # noqa: F401 — the fixture
    _col, build_world, client, export, merge, ok,
)


def _q(sql, **params):
    db = SessionLocal()
    try:
        return db.execute(text(sql), params).fetchall()
    finally:
        db.close()


def _participants(pid):
    return sorted(r[0] for r in _q("SELECT identifier FROM participants WHERE project_id=:p", p=pid))


def _answers(pid):
    return sorted(str(r[0]) for r in _q(
        "SELECT v.value_text FROM dataset_values v JOIN dataset_rows r ON r.id=v.row_id "
        "JOIN datasets d ON d.id=r.dataset_id WHERE d.project_id=:p", p=pid))


def _withdraw(k, pid, participant_id):
    return ok(k.c.post(f"/api/projects/{pid}/participants/{participant_id}/withdraw",
                       headers=k.H))


class TestAMergeOfAnOlderCopy:
    def test_does_not_bring_a_dataset_only_participant_back(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["P07"])
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert "P07" not in _participants(pid)
        assert "PATSAYS I have diabetes" not in _answers(pid)
        # control — everyone else's data and the file's other work still arrive
        assert {"M01", "S02", "U11", "Q09"} <= set(_participants(pid))
        assert "Sam answer" in _answers(pid)
        report = r.json()["merge_report"]
        assert report["withdrawn_participants_skipped"] == 1
        assert report["withdrawn_items_skipped"] >= 2   # her record and her quote
        assert report["records_reinserted_unlinked"] == 0   # D13's control

    def test_a_turn_holding_withdrawal_no_longer_refuses_every_older_copy(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        s = ids["s"]
        ok(client.c.post(f"/api/projects/{pid}/excerpts", json={"segment_id": s[1]},
                         headers=client.H))
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text   # HEAD: 409 segment_text, forever
        assert "M01" not in _participants(pid)
        texts = {t for (t,) in _q("SELECT text FROM segments WHERE id IN (:a,:b)",
                                  a=s[1], b=s[4])}
        assert texts == {BLANKED_SEGMENT_TEXT}
        assert _q("SELECT count(*) FROM excerpt WHERE segment_id=:s", s=s[1])[0][0] == 0

    def test_a_real_text_edit_still_refuses(self, client):
        """Control: the exemption is the withdrawal's blank, not every difference."""
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])
        db = SessionLocal()
        db.get(Segment, ids["s"][2]).text = "SAMSAYS the clinic is near."
        db.commit(); db.close()
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 409 and r.json()["detail"]["kind"] == "segment_text"

    def test_a_new_quote_of_a_blanked_turn_in_the_copy_is_dropped(self, client):
        """The colleague quoted her AFTER the copy was made: no tombstone knows that
        quote's uuid, and its offsets point into words this project no longer has."""
        ids = build_world(client)
        pid = ids["pid"]
        s = ids["s"]
        q = ok(client.c.post(f"/api/projects/{pid}/excerpts",
                             json={"segment_id": s[4], "start_offset": 0, "end_offset": 9},
                             headers=client.H))
        e0 = export(client, pid)
        # stands in for "never existed here": deleted BEFORE the withdrawal, so the
        # withdrawal never saw it and wrote no tombstone for it
        ok(client.c.delete(f"/api/projects/{pid}/excerpts/{q['id']}", headers=client.H))
        _withdraw(client, pid, ids["P"]["M01"])
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert _q("SELECT count(*) FROM excerpt WHERE segment_id=:s", s=s[4])[0][0] == 0
        # control — a quote of someone else's turn in the same file still arrives
        assert _q("SELECT count(*) FROM excerpt WHERE segment_id=:s", s=s[2])[0][0] == 1

    def test_a_participant_minted_in_the_copy_is_refused_by_identifier(self, client, tmp_path):
        """A colleague who linked a wave after the copy holds HER under a NEW uuid."""
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["P07"])
        payload = archive_payload(e0)
        manifest = json.loads(__import__("zipfile").ZipFile(io.BytesIO(e0)).read("manifest.json"))
        her = next(p for p in payload["participants"] if p["identifier"] == "P07")
        her["uuid"] = str(_uuid.uuid4())                 # minted in the copy
        for row in payload["dataset_rows"]:
            if row.get("participant_id") == her["_original_id"]:
                row["uuid"] = str(_uuid.uuid4())         # her record, re-made there
        doctored = write_archive(tmp_path / "copy.mmproject", manifest, payload,
                                 archive_extras(e0))
        r = merge(client, doctored.read_bytes(), pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert "P07" not in _participants(pid)
        assert "PATSAYS I have diabetes" not in _answers(pid)


class TestEveryOtherDoor:
    def test_a_transcript_import_does_not_recreate_her_from_a_speaker_label(self, client):
        """`ensure_participant_for_speaker` — a conversation import's automatic create.
        It SKIPS (the speaker stays unlinked), never refuses: a 409 would fail a whole
        transcript over a link (the precedent tests call it directly, as here)."""
        from app.models.speaker import Speaker
        from app.routers.conversations import ensure_participant_for_speaker
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        p = Participant(project_id=pid, identifier="Maria Lopez"); db.add(p); db.commit()
        her_id = p.id
        db.close()
        _withdraw(client, pid, her_id)
        db = SessionLocal()
        try:
            again = Speaker(project_id=pid, name="Maria Lopez", color_index=5)
            other = Speaker(project_id=pid, name="Noor", color_index=6)
            db.add_all([again, other]); db.flush()
            ensure_participant_for_speaker(db, pid, again, " Maria Lopez ")
            ensure_participant_for_speaker(db, pid, other, "Noor")
            db.flush()
            assert again.participant_id is None
            assert other.participant_id is not None          # control
            assert db.query(Participant).filter(
                Participant.project_id == pid, Participant.identifier == "Maria Lopez",
            ).count() == 0
        finally:
            db.rollback(); db.close()

    def test_linking_does_not_recreate_a_withdrawn_identifier(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        ds3 = Dataset(project_id=pid, name="Wave 2"); db.add(ds3); db.flush()
        idc = _col(ds3, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
        for ident in ("P07", "N01"):
            r = DatasetRow(dataset_id=ds3.id, row_identifier=ident); db.add(r); db.flush()
            db.add(DatasetValue(row_id=r.id, column_id=idc.id, value_text=ident))
        db.commit(); ds3_id, idc_id = ds3.id, idc.id; db.close()
        _withdraw(client, pid, ids["P"]["P07"])
        rep = ok(client.c.post(f"/api/projects/{pid}/datasets/{ds3_id}/link-by-column",
                               json={"column_id": idc_id}, headers=client.H))
        assert rep["created"] == 1                       # control: N01 is created
        assert rep["skipped_withdrawn"] == 1
        assert "P07" not in _participants(pid)

    def test_a_link_preview_never_names_a_withdrawn_identifier(self, client):
        """`duplicate_values` is printed by the preview and the link note: a withdrawn
        identifier on two records is counted under `skipped_withdrawn`, never named.
        Control: an ordinary duplicate is still named, and a REINSTATED identifier
        (a living person holds it, D12) is an ordinary duplicate again."""
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        ds3 = Dataset(project_id=pid, name="Wave 2"); db.add(ds3); db.flush()
        idc = _col(ds3, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
        for ident in ("P07", "P07", "D1", "D1", "N01"):
            r = DatasetRow(dataset_id=ds3.id, row_identifier=ident); db.add(r); db.flush()
            db.add(DatasetValue(row_id=r.id, column_id=idc.id, value_text=ident))
        db.commit(); ds3_id, idc_id = ds3.id, idc.id; db.close()
        _withdraw(client, pid, ids["P"]["P07"])
        url = f"/api/projects/{pid}/datasets/{ds3_id}/link-by-column"
        for rep in (ok(client.c.post(f"{url}/preview", json={"column_id": idc_id},
                                     headers=client.H)),
                    ok(client.c.post(url, json={"column_id": idc_id}, headers=client.H))):
            assert "P07" not in json.dumps(rep), rep
            assert rep["duplicate_values"] == ["D1"]
            assert rep["skipped_duplicate"] == 2 and rep["skipped_withdrawn"] == 2, rep
        ok(client.c.post(f"/api/projects/{pid}/participants",
                         json={"identifier": "P07", "confirm_withdrawn": True}, headers=client.H))
        rep = ok(client.c.post(f"{url}/preview", json={"column_id": idc_id}, headers=client.H))
        assert rep["duplicate_values"] == ["D1", "P07"] and rep["skipped_withdrawn"] == 0, rep

    @pytest.mark.parametrize("who", ["P07", "M01"])
    def test_an_older_copy_imported_as_NEW_is_refused(self, client, who):
        """A "new" import INSERTS the file's rows: her turns would arrive with their
        words and her speaker with her name (measured on the first prototype: the
        participant was skipped and 'MARIASAYS' still landed)."""
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"][who])
        r = client.c.post("/api/projects/import-project", data={"import_mode": "new"},
                          files={"file": ("e0.mmproject", e0, "application/zip")},
                          headers=client.H)
        assert r.status_code == 400, r.text
        assert "withdrew" in r.json()["detail"]
        # control — a copy exported AFTER the withdrawal imports, and carries none of her
        e1 = export(client, pid)
        r = client.c.post("/api/projects/import-project", data={"import_mode": "new"},
                          files={"file": ("e1.mmproject", e1, "application/zip")},
                          headers=client.H)
        assert r.status_code == 200, r.text
        new_pid = r.json()["project_id"]
        assert "S02" in _participants(new_pid) and who not in _participants(new_pid)
        texts = [t for (t,) in _q(
            "SELECT s.text FROM segments s JOIN conversations c ON c.id=s.conversation_id "
            "WHERE c.project_id=:p", p=new_pid)] + _answers(new_pid)
        sentinel = {"M01": "MARIA", "P07": "PATSAYS"}[who]
        assert not any(sentinel in t for t in texts)

    def test_a_copy_made_after_the_withdrawal_carries_the_tombstones(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["P07"])
        payload = archive_payload(export(client, pid))
        kinds = {t["entity_type"] for t in payload.get("tombstones", [])}
        assert {"participant", "dataset_row", "excerpt"} <= kinds
        assert all("P07" not in json.dumps(t) for t in payload["tombstones"])


class TestTheTombstonesAreACensus:
    def test_every_uuid_a_withdrawal_removes_is_tombstoned(self, client):
        """Derived from the schema: every table with a `uuid` column, before and
        after. A new uuid'd entity a withdrawal deletes fails here, unlisted."""
        ids = build_world(client)
        pid = ids["pid"]
        s = ids["s"]
        ok(client.c.post(f"/api/projects/{pid}/excerpts", json={"segment_id": s[1]},
                         headers=client.H))
        uuid_tables = [t.name for t in Base.metadata.sorted_tables
                       if "uuid" in t.c and t.name != "projects"]
        assert len(uuid_tables) >= 14, uuid_tables       # population (J3-2 spine)

        def snapshot():
            return {(t, u) for t in uuid_tables
                    for (u,) in _q(f'SELECT uuid FROM "{t}" WHERE uuid IS NOT NULL')}

        before = snapshot()
        _withdraw(client, pid, ids["P"]["M01"])
        _withdraw(client, pid, ids["P"]["P07"])
        gone = before - snapshot()
        assert gone, "the withdrawals removed nothing — the census proves nothing"
        stones = {u for (u,) in _q("SELECT entity_uuid FROM removal_tombstones")}
        assert {u for _, u in gone} <= stones, sorted(gone)


class TestAMergeRefusesWhatTheWithdrawalNeverSaw:
    def _with_new_source(self, client, tmp_path, e0, speaker_name):
        payload = archive_payload(e0)
        zf = __import__("zipfile").ZipFile(io.BytesIO(e0))
        manifest = json.loads(zf.read("manifest.json"))
        conv = dict(payload["conversations"][0])
        conv.update(uuid=str(_uuid.uuid4()), _original_id=9999, name="Interview 2")
        sp = dict(next(x for x in payload["speakers"] if x["name"] == speaker_name))
        sp.update(uuid=str(_uuid.uuid4()), _original_id=9998)
        seg = dict(next(x for x in payload["segments"] if x.get("conversation_id")))
        seg.update(uuid=str(_uuid.uuid4()), _original_id=99997, conversation_id=9999,
                   speaker_id=9998, text="NEWSOURCE words said in a second interview.",
                   merged_into_id=None, split_into_id=None, group_id=None)
        payload["conversations"].append(conv)
        payload["speakers"].append(sp)
        payload["segments"] = list(payload["segments"]) + [seg]
        return write_archive(tmp_path / f"{speaker_name}.mmproject", manifest, payload,
                             archive_extras(e0)).read_bytes()

    def test_a_source_the_copy_added_with_her_turns_is_refused(self, client, tmp_path):
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])
        r = merge(client, self._with_new_source(client, tmp_path, e0, "Maria"), pid,
                  code_mapping={})
        assert r.status_code == 400, r.text
        assert not _q("SELECT 1 FROM segments WHERE text LIKE 'NEWSOURCE%'")
        # control — the same added source spoken by Sam merges
        r = merge(client, self._with_new_source(client, tmp_path, e0, "Sam"), pid,
                  code_mapping={})
        assert r.status_code == 200, r.text
        assert _q("SELECT 1 FROM segments WHERE text LIKE 'NEWSOURCE%'")


class TestTheTombstonesTravelAndCarryForward:
    def test_a_project_imported_from_a_later_copy_still_refuses_her(self, client):
        """Carry-forward: the tombstones are stored under the NEW project's identity."""
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        ds3 = Dataset(project_id=pid, name="Wave 2"); db.add(ds3); db.flush()
        idc = _col(ds3, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
        r = DatasetRow(dataset_id=ds3.id, row_identifier="1"); db.add(r); db.flush()
        db.add(DatasetValue(row_id=r.id, column_id=idc.id, value_text="P07"))
        db.commit(); db.close()
        _withdraw(client, pid, ids["P"]["P07"])
        e1 = export(client, pid)
        r = client.c.post("/api/projects/import-project", data={"import_mode": "new"},
                          files={"file": ("e1.mmproject", e1, "application/zip")},
                          headers=client.H)
        assert r.status_code == 200, r.text
        new_pid = r.json()["project_id"]
        (new_ds,) = _q("SELECT id FROM datasets WHERE project_id=:p AND name='Wave 2'", p=new_pid)[0]
        (new_col,) = _q("SELECT c.id FROM dataset_columns c WHERE c.dataset_id=:d", d=new_ds)[0]
        rep = ok(client.c.post(f"/api/projects/{new_pid}/datasets/{new_ds}/link-by-column",
                               json={"column_id": new_col}, headers=client.H))
        assert rep["skipped_withdrawn"] == 1 and rep["created"] == 0
        assert "P07" not in _participants(new_pid)

    def test_an_orphan_combined_speaker_the_withdrawal_deleted_stays_gone(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        s = ids["s"]
        url = f"/api/conversations/{ids['c1']}/segments"
        m = ok(client.c.post(f"{url}/merge", json={"segment_ids": [s[4], s[5]]},
                             headers=client.H))["merged_segment"]["id"]
        ok(client.c.post(f"{url}/{m}/unmerge", headers=client.H))
        names = [n for (n,) in _q("SELECT name FROM speakers WHERE project_id=:p", p=pid)]
        assert any("Maria" in n and "&" in n for n in names), names  # precondition
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text
        names = [n for (n,) in _q("SELECT name FROM speakers WHERE project_id=:p", p=pid)]
        assert not any("Maria" in n for n in names), names


class TestARecreationIsNotA500:
    """Deleted here, made again (new uuid, same natural key), then an older copy merged."""

    def test_a_participant_recreated_under_the_same_identifier(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        ok(client.c.delete(f"/api/projects/{pid}/participants/{ids['P']['Q09']}", headers=client.H))
        ok(client.c.post(f"/api/projects/{pid}/participants", json={"identifier": "Q09"},
                         headers=client.H))
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text   # HEAD: 500, UNIQUE participants.identifier
        assert _participants(pid).count("Q09") == 1

    @pytest.mark.parametrize("shape", [{}, {"start_offset": 0, "end_offset": 7}])
    def test_a_quote_unmade_and_made_again(self, client, shape):
        ids = build_world(client)
        pid = ids["pid"]
        seg = ids["s"][2] if not shape else ids["s"][3]
        old = ids["e_whole"] if not shape else ids["e_char"]
        e0 = export(client, pid)
        ok(client.c.delete(f"/api/projects/{pid}/excerpts/{old}", headers=client.H))
        ok(client.c.post(f"/api/projects/{pid}/excerpts", json={"segment_id": seg, **shape},
                         headers=client.H))
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text   # HEAD: 500, UNIQUE excerpt shape index
        assert _q("SELECT count(*) FROM excerpt WHERE segment_id=:s", s=seg)[0][0] == 1

    def test_a_record_deleted_then_its_person_linked_to_another(self, client):
        """D13 — the fourth 500 (`uq_dataset_rows_dataset_participant`): the old record
        comes back LINKED TO NOBODY, and the report says how many."""
        ids = build_world(client)
        pid = ids["pid"]
        sam, sam_row, r99 = ids["P"]["S02"], ids["rows"]["S02"], ids["rows"]["R99"]
        (old_uuid,) = _q("SELECT uuid FROM dataset_rows WHERE id=:r", r=sam_row)[0]
        e0 = export(client, pid)
        ok(client.c.delete(f"/api/projects/{pid}/datasets/{ids['ds1']}/rows/{sam_row}",
                           headers=client.H))
        db = SessionLocal()
        db.get(DatasetRow, r99).participant_id = sam
        db.commit(); db.close()
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text   # HEAD: 500
        assert r.json()["merge_report"]["records_reinserted_unlinked"] == 1
        assert _q("SELECT participant_id FROM dataset_rows WHERE uuid=:u", u=old_uuid) == [(None,)]
        assert _q("SELECT id FROM dataset_rows WHERE dataset_id=:d AND participant_id=:p",
                  d=ids["ds1"], p=sam) == [(r99,)]
        assert "Sam answer" in _answers(pid)      # the record's answers came back with it
        # control — merged again, nothing more is re-inserted (it is matched now)
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200 and r.json()["merge_report"]["records_reinserted_unlinked"] == 0


def _doctor(tmp_path, e0: bytes, name: str, edit) -> bytes:
    payload = archive_payload(e0)
    manifest = json.loads(__import__("zipfile").ZipFile(io.BytesIO(e0)).read("manifest.json"))
    edit(payload)
    return write_archive(tmp_path / f"{name}.mmproject", manifest, payload,
                         archive_extras(e0)).read_bytes()


def _drop_participant_row(ident):
    """The copy's holder DELETED her participant row (an ordinary delete only orphans:
    her speaker keeps her name, her turns their words)."""
    def edit(payload):
        her = next(p for p in payload["participants"] if p["identifier"] == ident)
        payload["participants"] = [p for p in payload["participants"] if p is not her]
        for key in ("speakers", "documents", "dataset_rows"):
            for item in payload.get(key, []):
                if item.get("participant_id") == her["_original_id"]:
                    item["participant_id"] = None
    return edit


def _add_source_spoken_by(speaker_name):
    def edit(payload):
        conv = dict(payload["conversations"][0])
        conv.update(uuid=str(_uuid.uuid4()), _original_id=9999, name="Interview 2")
        sp = next(x for x in payload["speakers"] if x["name"] == speaker_name)
        seg = dict(next(x for x in payload["segments"] if x.get("conversation_id")))
        seg.update(uuid=str(_uuid.uuid4()), _original_id=99997, conversation_id=9999,
                   speaker_id=sp["_original_id"], merged_into_id=None, split_into_id=None,
                   group_id=None, text="NEWSOURCE words said in a second interview.")
        payload["conversations"].append(conv)
        payload["segments"] = list(payload["segments"]) + [seg]
    return edit


class TestHerTurnsWithoutHerParticipantRow:
    """r3's M13: the refusal's blanked-turn arm is the ONLY thing that names her in a
    copy whose participant row is gone — so it is not redundant (#941), it was untested."""

    def test_an_import_as_new_is_refused(self, client, tmp_path):
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])
        blob = _doctor(tmp_path, e0, "no_row", _drop_participant_row("M01"))
        r = client.c.post("/api/projects/import-project", data={"import_mode": "new"},
                          files={"file": ("c.mmproject", blob, "application/zip")},
                          headers=client.H)
        assert r.status_code == 400, r.text
        assert "withdrew" in r.json()["detail"]
        assert not _q("SELECT 1 FROM segments WHERE text LIKE 'MARIA%'")

    def test_a_merge_adding_a_source_her_speaker_speaks_in_is_refused(self, client, tmp_path):
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])

        def both(who):
            def edit(payload):
                _drop_participant_row("M01")(payload)
                _add_source_spoken_by(who)(payload)
            return edit

        r = merge(client, _doctor(tmp_path, e0, "maria", both("Maria")), pid, code_mapping={})
        assert r.status_code == 400, r.text
        assert not _q("SELECT 1 FROM segments WHERE text LIKE 'NEWSOURCE%'")
        # control — the same copy with the new source spoken by Sam merges
        r = merge(client, _doctor(tmp_path, e0, "sam", both("Sam")), pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert _q("SELECT 1 FROM segments WHERE text LIKE 'NEWSOURCE%'")


class TestTypingAWithdrawnIdentifier:
    """D12 — a researcher-typed identifier a withdrawal tombstoned: 409 with a
    confirm-to-override, and an override that later imports believe."""

    @staticmethod
    def _create(k, pid, ident, **extra):
        return k.c.post(f"/api/projects/{pid}/participants",
                        json={"identifier": ident, **extra}, headers=k.H)

    def test_a_create_is_refused_until_confirmed(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["P07"])
        r = self._create(client, pid, " P07 ")            # trimmed, as linking matches
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert detail["error"] == "withdrawn_identifier"
        assert detail["message"] and not {"P07", "Pat"} & set(detail["message"].split())
        assert "P07" not in _participants(pid)
        assert self._create(client, pid, "N02").status_code == 200      # control
        r = self._create(client, pid, "P07", confirm_withdrawn=True)
        assert r.status_code == 200, r.text
        assert "P07" in _participants(pid)
        (kind,) = _q("SELECT entity_type FROM removal_tombstones WHERE reason='reinstated'")[0]
        assert kind == "participant_reinstated"

    def test_a_rename_to_it_is_the_same_question(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["P07"])
        url = f"/api/projects/{pid}/participants/{ids['P']['U11']}"
        r = client.c.patch(url, json={"identifier": "P07"}, headers=client.H)
        assert r.status_code == 409 and r.json()["detail"]["error"] == "withdrawn_identifier"
        assert "U11" in _participants(pid)
        r = client.c.patch(url, json={"identifier": "P07", "confirm_withdrawn": True},
                           headers=client.H)
        assert r.status_code == 200, r.text
        assert "P07" in _participants(pid) and "U11" not in _participants(pid)

    def test_the_reinstated_person_is_nobody_s_withdrawal_to_an_import(self, client):
        """Without the reinstated marker the identifier hash would skip the NEW person
        at every merge and refuse every copy of the project (Duplicate included)."""
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["P07"])
        ok(self._create(client, pid, "P07", confirm_withdrawn=True))
        e1 = export(client, pid)
        r = client.c.post("/api/projects/import-project", data={"import_mode": "new"},
                          files={"file": ("e1.mmproject", e1, "application/zip")},
                          headers=client.H)
        assert r.status_code == 200, r.text
        assert "P07" in _participants(r.json()["project_id"])
        r = merge(client, e1, pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert r.json()["merge_report"]["withdrawn_participants_skipped"] == 0
        # the person who withdrew is still refused, by her own uuid, from an older copy
        r = merge(client, e0, pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert r.json()["merge_report"]["withdrawn_participants_skipped"] == 1
        assert "PATSAYS I have diabetes" not in _answers(pid)
        assert _participants(pid).count("P07") == 1

    @staticmethod
    def _import_new(k, blob):
        return k.c.post("/api/projects/import-project", data={"import_mode": "new"},
                        files={"file": ("e.mmproject", blob, "application/zip")},
                        headers=k.H)

    @staticmethod
    def _uuid_of(pid, identifier):
        return _q("SELECT uuid FROM participants WHERE project_id=:p AND identifier=:i",
                  p=pid, i=identifier)[0][0]

    @staticmethod
    def _tombs(pid):
        (puuid,) = _q("SELECT project_uuid FROM projects WHERE id=:p", p=pid)[0]
        return _q("SELECT entity_type, entity_uuid, identifier_hash FROM removal_tombstones "
                  "WHERE project_uuid=:u", u=puuid)

    def test_the_reinstatement_follows_her_through_a_re_minting_import(self, client):
        """#1471 — a Duplicate (a "new" import) re-mints every participant's uuid; the
        marker must name the NEW one, or the copy reads her as withdrawn again: its own
        Duplicate refused, its export refused as "new", and a merge into it skipping her.
        Two hops, every re-minting door, and the merge."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["P07"])
        ok(self._create(client, pid, "P07", confirm_withdrawn=True))
        pid2 = ok(client.c.post(f"/api/projects/{pid}/duplicate", headers=client.H))["project_id"]
        assert self._uuid_of(pid2, "P07") != self._uuid_of(pid, "P07")      # re-minted
        marks = {u for t, u, _h in self._tombs(pid2) if t == "participant_reinstated"}
        assert self._uuid_of(pid2, "P07") in marks
        # hop two, by each re-minting door
        r = client.c.post(f"/api/projects/{pid2}/duplicate", headers=client.H)
        assert r.status_code == 200, r.text
        assert "P07" in _participants(r.json()["project_id"])
        r = self._import_new(client, export(client, pid2))
        assert r.status_code == 200, r.text
        assert "P07" in _participants(r.json()["project_id"])
        # …and a merge of its own copy back into it keeps her
        r = merge(client, export(client, pid2), pid2, code_mapping={})
        assert r.status_code == 200, r.text
        assert r.json()["merge_report"]["withdrawn_participants_skipped"] == 0

    def test_CONTROL_the_person_who_withdrew_is_still_kept_out_of_the_re_minted_copy(self, client):
        """The identifier hash is not a uuid, so the re-mint leaves it whole: the copy
        still refuses a typed P07 once nobody holds it."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["P07"])
        ok(self._create(client, pid, "P07", confirm_withdrawn=True))
        pid2 = ok(client.c.post(f"/api/projects/{pid}/duplicate", headers=client.H))["project_id"]
        assert any(h for t, _u, h in self._tombs(pid2) if t == "participant")
        (p07,) = _q("SELECT id FROM participants WHERE project_id=:p AND identifier='P07'", p=pid2)[0]
        ok(client.c.patch(f"/api/projects/{pid2}/participants/{p07}",
                          json={"identifier": "P08"}, headers=client.H))
        r = self._create(client, pid2, "P07")
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["error"] == "withdrawn_identifier"


class TestTheReportCountsUnlinkedRecordsCarryingHerIdentifier:
    """D14 — a count, by linking's own rule (an identifier-typed column, trim-then-
    exact, case-sensitive); never names, outside `total_items`, nothing deleted."""

    def test_the_count(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        url = f"/api/projects/{pid}/participants/{ids['P']['P07']}/withdrawal-report"
        before = ok(client.c.get(url, headers=client.H))
        assert before["unlinked_records_with_identifier"] == 0
        db = SessionLocal()
        ds = Dataset(project_id=pid, name="Wave 2"); db.add(ds); db.flush()
        idc = _col(ds, "PID", ColumnType.IDENTIFIER, 0)
        idc2 = _col(ds, "ALT", ColumnType.IDENTIFIER, 1)
        txt = _col(ds, "Said", ColumnType.OPEN_TEXT, 2)
        db.add_all([idc, idc2, txt]); db.flush()
        cases = [  # (identifier cell, second identifier cell, text cell, linked to)
            ("P07", "P07", None, None),      # counted ONCE across two columns
            (" P07 ", None, None, None),     # counted: linking trims
            ("p07", None, None, None),       # not: case-sensitive
            ("P077", None, None, None),      # not: a longer code
            ("P07", None, None, ids["P"]["S02"]),   # not: linked to someone
            ("X1", None, "P07", None),       # not: an answer, not an identifier
        ]
        for i, (a, b, t, who) in enumerate(cases):
            row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i}", participant_id=who)
            db.add(row); db.flush()
            for col, v in ((idc, a), (idc2, b), (txt, t)):
                if v is not None:
                    db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=v))
        db.commit(); ds_id = ds.id; db.close()
        after = ok(client.c.get(url, headers=client.H))
        assert after["unlinked_records_with_identifier"] == 2
        assert after["total_items"] == before["total_items"]
        assert "P07" not in json.dumps(after["datasets"])   # names nothing new
        _withdraw(client, pid, ids["P"]["P07"])
        assert _q("SELECT count(*) FROM dataset_rows WHERE dataset_id=:d", d=ds_id)[0][0] == 6


class TestNothingOfHersIsStrandedOrBroughtBack:
    """The record's top risk: a skipped parent strands a child. Every child of her
    record and her answers, the target's own and the copy's new ones."""

    def test_every_child_of_her_record(self, client, tmp_path):
        from app.models.code_application import CodeApplication
        from app.models.memo import Memo
        from app.models.note import Note
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        db.add(Memo(project_id=pid, numeric_id=2, entity_type="dataset_row",
                    entity_id=ids["rows"]["P07"], title="MEMOROW", content="kept"))
        db.add(Note(dataset_value_id=ids["vals"]["P07"], content="NOTEP07", sequence_number=1))
        db.commit(); db.close()
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["P07"])

        def copy_added(payload):
            row = next(r for r in payload["dataset_rows"] if r.get("row_identifier") == "P07")
            val = next(v for v in payload["dataset_values"] if v["row_id"] == row["_original_id"])
            app = dict(next(a for a in payload["code_applications"]
                            if a.get("dataset_value_id") == val["_original_id"]))
            app.update(code_id=next(c["_original_id"] for c in payload["codes"]
                                    if c["name"] == "work"), _original_id=7777)
            payload["code_applications"].append(app)
            payload["excerpts"].append({**next(e for e in payload["excerpts"]
                                              if e.get("dataset_value_id") == val["_original_id"]),
                                        "uuid": str(_uuid.uuid4()), "_original_id": 7778})
            payload["notes"].append({**next(n for n in payload["notes"]
                                           if n.get("dataset_value_id") == val["_original_id"]),
                                     "uuid": str(_uuid.uuid4()), "_original_id": 7779,
                                     "content": "COPYNOTE"})
            payload["memos"].append({**next(m for m in payload["memos"]
                                           if m["title"] == "MEMOROW"),
                                     "uuid": str(_uuid.uuid4()), "_original_id": 7780,
                                     "numeric_id": 99, "title": "COPYMEMO"})

        def counts():
            db = SessionLocal()
            try:
                return {
                    "codings": db.query(CodeApplication).filter(
                        CodeApplication.dataset_value_id.isnot(None)).count(),
                    "quotes": db.query(Excerpt).filter(Excerpt.dataset_value_id.isnot(None)).count(),
                    "notes": sorted(c for (c,) in db.query(Note.content).filter(
                        Note.dataset_value_id.isnot(None))),
                    "memos": sorted(t for (t,) in db.query(Memo.title).filter(
                        Memo.project_id == pid)),
                }
            finally:
                db.close()

        before = counts()
        assert "MEMOROW" in before["memos"]          # the withdrawal kept it (reported)
        assert "NOTEP07" not in before["notes"]      # …and deleted the note on her answer
        r = merge(client, _doctor(tmp_path, e0, "added", copy_added), pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert counts() == before
        rep = r.json()["merge_report"]
        assert rep["withdrawn_participants_skipped"] == 1
        # her record 1 · quotes 2 (hers, the copy's) · notes 2 · codings 2 · memo 1
        assert rep["withdrawn_items_skipped"] == 8, rep

    def test_a_note_on_a_dropped_quote_keeps_its_own_parent(self, client, tmp_path):
        """Excerpt → Note (`excerpt_id`): the copy quoted her blanked turn and wrote a
        note on the quote. The quote is dropped; the note is the researcher's prose on
        a turn, which the withdrawal itself KEEPS, so it lands on the turn with no
        quote — never on the file's raw excerpt id."""
        ids = build_world(client)
        pid = ids["pid"]
        s = ids["s"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])

        def copy_added(payload):
            q = {**next(e for e in payload["excerpts"] if e["_original_id"] == ids["e_char"]),
                 "uuid": str(_uuid.uuid4()), "_original_id": 7790, "segment_id": s[4]}
            n = {**next(x for x in payload["notes"] if x["_original_id"] == ids["n_seg"]),
                 "uuid": str(_uuid.uuid4()), "_original_id": 7791, "segment_id": s[4],
                 "excerpt_id": 7790, "content": "NOTEONNEWQUOTE"}
            payload["excerpts"].append(q)
            payload["notes"].append(n)

        r = merge(client, _doctor(tmp_path, e0, "noted", copy_added), pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert _q("SELECT count(*) FROM excerpt WHERE segment_id=:s", s=s[4])[0][0] == 0
        assert _q("SELECT segment_id, excerpt_id FROM notes WHERE content='NOTEONNEWQUOTE'") \
            == [(s[4], None)]
        assert r.json()["merge_report"]["withdrawn_items_skipped"] >= 1
