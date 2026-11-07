"""#1472 + #1391 (D73–D76, 1.5.9) — a withdrawal also remembers the NAMES the person was
known by, and the conversation import's speaker-label door says when it kept a speaker
unlinked. Written as the wanted behaviour: the gap tests fail on `d4cfdf36`.

- #1472: M01 ("Maria") withdrawn; a transcript labelled "Maria" re-created her.
- #1391: a label equal to her ID was left unlinked SILENTLY.

🔴 The D73 wall: the name kind is read ONLY by the speaker door. Linking by column, the
typed create and every `.mmproject` door ask the ID, where a common first name would skip
or refuse a different person's data — `TestTheNameKindIsReadOnlyByTheSpeakerDoor`.

Every removal and every import goes through its real HTTP door; the world is built through
the ORM (`test_merge_brings_back.build_world`).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from sqlalchemy import text

from app.database import SessionLocal
from app.models.dataset import ColumnType, Dataset, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.services import tombstones
from tests.archive_support import archive_payload
from tests.test_merge_brings_back import (  # noqa: F401 — the fixture
    _col, build_world, client, export, merge, ok,
)

WARNING_ONE = tombstones.withdrawn_speaker_warning(1)


def _q(sql, **params):
    db = SessionLocal()
    try:
        return db.execute(text(sql), params).fetchall()
    finally:
        db.close()


def _participants(pid):
    return sorted(r[0] for r in _q(
        "SELECT identifier FROM participants WHERE project_id=:p", p=pid))


def _speaker_links(pid):
    """{speaker name: the linked participant's identifier, or None}."""
    return dict(_q(
        "SELECT s.name, p.identifier FROM speakers s LEFT JOIN participants p "
        "ON p.id = s.participant_id WHERE s.project_id=:p", p=pid))


def _project_uuid(pid):
    return _q("SELECT project_uuid FROM projects WHERE id=:p", p=pid)[0][0]


def _name_rows(pid):
    return _q("SELECT identifier_hash FROM removal_tombstones WHERE project_uuid=:u "
              "AND entity_type='participant_name'", u=_project_uuid(pid))


def _withdraw(k, pid, participant_id):
    return ok(k.c.post(f"/api/projects/{pid}/participants/{participant_id}/withdraw",
                       headers=k.H))


def _import(k, pid, labels, *, name="Second interview", csv=None, facilitator="Interviewer",
            mapped=None):
    """A transcript through `POST …/conversations/import`: one turn per label, the
    facilitator first. `mapped` maps an original label to the name it is given
    (the Map Speakers step); default, each label keeps its own."""
    mapped = mapped or {}
    if csv is None:
        lines = ["Speaker,Text", f"{facilitator},Hello again."]
        lines += [f"{lab},NEWWORDS from {i}." for i, lab in enumerate(labels)]
        csv = "\n".join(lines) + "\n"
    config = {
        "name": name,
        "column_mapping": {"speaker": "Speaker", "text": "Text"},
        "speaker_mappings": [
            {"original_label": facilitator, "normalized_name": facilitator,
             "is_facilitator": True},
            *({"original_label": lab, "normalized_name": mapped.get(lab, lab)}
              for lab in labels),
        ],
    }
    return k.c.post(f"/api/projects/{pid}/conversations/import",
                    data={"import_config": json.dumps(config)},
                    files={"file": ("t.csv", csv.encode(), "text/csv")}, headers=k.H)


class TestTheSpeakerDoor:
    def test_a_transcript_naming_her_by_her_speaker_name_does_not_recreate_her(self, client):
        """#1472 — the gap: her ID is a code, her speaker label a name."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])         # identifier M01, speaker "Maria"
        r = _import(client, pid, ["Maria", "Noor"])
        assert r.status_code == 200, r.text
        assert "Maria" not in _participants(pid)
        links = _speaker_links(pid)
        assert links["Maria"] is None                    # the speaker is made, unlinked
        assert links["Noor"] == "Noor"                   # control: an ordinary label
        assert r.json()["warnings"] == [WARNING_ONE]

    def test_a_label_equal_to_her_ID_is_left_unlinked_and_SAID(self, client):
        """#1391 — the ID arm was already kept unlinked, but silently."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = _import(client, pid, [" M01 "], mapped={" M01 ": " M01 "})
        assert r.status_code == 200, r.text
        assert _participants(pid).count("M01") == 0
        assert r.json()["warnings"] == [WARNING_ONE]

    def test_an_EXISTING_unlinked_speaker_is_said_again(self, client):
        """A second transcript naming her reaches the door through the existing-speaker
        arm (the first import made the speaker); it is kept unlinked and said again."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        ok(_import(client, pid, ["Maria"]))
        r = _import(client, pid, ["Maria"], name="Third interview")
        assert r.status_code == 200, r.text
        assert r.json()["warnings"] == [WARNING_ONE]
        assert _speaker_links(pid)["Maria"] is None

    def test_two_labels_mapped_onto_one_remembered_name_are_ONE_speaker(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = _import(client, pid, ["MARIA_A", "MARIA_B"],
                    mapped={"MARIA_A": "Maria", "MARIA_B": "Maria"})
        assert r.status_code == 200, r.text
        assert r.json()["warnings"] == [WARNING_ONE]

    def test_the_warning_comes_FIRST_and_the_files_own_warnings_survive(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        csv = ("Speaker,Text,Start,End\nInterviewer,Hello.,00:00:10,00:00:20\n"
               "Maria,NEWWORDS here.,00:00:05,00:00:08\n")     # starts before row 1 ends
        r = client.c.post(
            f"/api/projects/{pid}/conversations/import",
            data={"import_config": json.dumps({
                "name": "Timed",
                "column_mapping": {"speaker": "Speaker", "text": "Text",
                                   "start_time": "Start", "end_time": "End"},
                "speaker_mappings": [
                    {"original_label": "Interviewer", "normalized_name": "Interviewer",
                     "is_facilitator": True},
                    {"original_label": "Maria", "normalized_name": "Maria"},
                ],
            })},
            files={"file": ("t.csv", csv.encode(), "text/csv")}, headers=client.H)
        assert r.status_code == 200, r.text
        warnings = r.json()["warnings"]
        assert warnings[0] == WARNING_ONE
        assert len(warnings) == 2 and "earlier than row" in warnings[1]

    def test_every_spelling_she_was_known_by_is_remembered(self, client):
        """D73's population: her display name, her speaker's name and import label, and
        her turn's original label — and the ID once, as the ID kind, not again as a name.
        One transcript naming her four ways: four speakers unlinked, one sentence."""
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        try:
            rosa = Participant(project_id=pid, identifier="R05", display_name="Rosa Diaz")
            db.add(rosa); db.flush()
            sp = Speaker(project_id=pid, name="Rosa", original_label="SPEAKER_03",
                         participant_id=rosa.id, color_index=7)
            db.add(sp); db.flush()
            (conv_id,) = db.execute(text(
                "SELECT id FROM conversations WHERE project_id=:p AND name='Focus group'"),
                {"p": pid}).fetchone()
            db.add(Segment(conversation_id=conv_id, speaker_id=sp.id, sequence_order=20,
                           text="ROSASAYS something.", word_count=2,
                           original_speaker_label="Rosa D."))
            db.commit()
            rosa_id = rosa.id
        finally:
            db.close()
        _withdraw(client, pid, rosa_id)
        assert len(_name_rows(pid)) == 4                 # the four spellings; not the ID
        r = _import(client, pid, ["Rosa Diaz", "Rosa", "SPEAKER_03", "Rosa D.", "Noor"])
        assert r.status_code == 200, r.text
        assert r.json()["warnings"] == [tombstones.withdrawn_speaker_warning(4)]
        links = _speaker_links(pid)
        assert [links[n] for n in ("Rosa Diaz", "Rosa", "SPEAKER_03", "Rosa D.")] == [None] * 4
        assert links["Noor"] == "Noor"
        assert not {"Rosa Diaz", "Rosa", "SPEAKER_03", "Rosa D."} & set(_participants(pid))

    def test_someone_with_her_ID_or_name_who_EXISTS_is_linked_not_kept_out(self, client):
        """The existing-participant match comes first: a person reinstated under her ID
        (D12, confirmed) and a person created by hand under one of her names are linked,
        with no warning — the second is D75's way to link someone else called Maria."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        ok(client.c.post(f"/api/projects/{pid}/participants",
                         json={"identifier": "M01", "confirm_withdrawn": True},
                         headers=client.H))
        created = client.c.post(f"/api/projects/{pid}/participants",
                                json={"identifier": "Maria"}, headers=client.H)
        assert created.status_code == 200, created.text       # a name is never refused there
        r = _import(client, pid, ["M01", "Maria"], mapped={"M01": "M01"})
        assert r.status_code == 200, r.text
        assert r.json()["warnings"] == []
        links = _speaker_links(pid)
        assert links["M01"] == "M01" and links["Maria"] == "Maria"


class TestTheWarning:
    def test_it_is_a_count_and_never_a_name(self):
        one, three = (tombstones.withdrawn_speaker_warning(n) for n in (1, 3))
        assert one.startswith("1 speaker was not linked to a participant,")
        assert three.startswith("3 speakers were not linked to participants,")
        for s in (one, three):
            assert "Map Speakers" in s and "delete this conversation" in s
            assert "brought those words back" in s


class TestTheRecordTravels:
    def test_an_export_carries_the_names_as_codes_and_a_Duplicate_keeps_them(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        items = archive_payload(export(client, pid))["tombstones"]
        names = [t for t in items if t["entity_type"] == "participant_name"]
        assert len(names) == 1 and names[0]["identifier_hash"]
        assert not any("Maria" in json.dumps(t) for t in items)    # a code, not the name
        pid2 = ok(client.c.post(f"/api/projects/{pid}/duplicate", headers=client.H))["project_id"]
        assert len(_name_rows(pid2)) == 1
        r = _import(client, pid2, ["Maria"])
        assert r.status_code == 200, r.text
        assert r.json()["warnings"] == [WARNING_ONE]
        assert "Maria" not in _participants(pid2)

    def test_a_merge_stores_the_files_names_under_the_target(self, client):
        """The union a merge builds carries the name kind like any other (`union`)."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        blob = export(client, pid)
        db = SessionLocal()
        try:
            db.execute(text("DELETE FROM removal_tombstones WHERE entity_type='participant_name'"))
            db.commit()
        finally:
            db.close()
        assert _name_rows(pid) == []
        r = merge(client, blob, pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert len(_name_rows(pid)) == 1

    def test_the_record_round_trips_through_write_and_load_with_its_kind(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        t = tombstones.Tombstones()
        t.add(tombstones.PARTICIPANT_NAME, None, tombstones.name_hash("Zed"))
        assert t                                         # a record of names is a record
        db = SessionLocal()
        try:
            assert tombstones.write(db, _project_uuid(pid), t) == 1
            db.commit()
            back = tombstones.load(db, _project_uuid(pid))
        finally:
            db.close()
        assert back.withdrawn_name("Zed") and back.withdrawn_speaker_label(" Zed ")
        assert not back.identifier_hashes
        assert tombstones.write(SessionLocal(), _project_uuid(pid), back) == 0   # idempotent


# ── 1.5.8's reader, frozen VERBATIM from the release an earlier commit
# (backend/app/services/tombstones.py), so a 1.5.9 file can be read the way the
# previous release reads it. Do not update it to match the current module.
_V158_PREFIX = "mm-withdrawn-identifier:v1:"
_V158_ENTITY_TYPES = frozenset({
    "participant", "speaker", "dataset_row", "excerpt", "note", "segment_blanked",
    "participant_reinstated",
})


def _v158_identifier_hash(identifier):
    key = identifier.strip() if identifier else ""
    if not key:
        return None
    return hashlib.sha256((_V158_PREFIX + key).encode("utf-8")).hexdigest()


@dataclass
class _V158Tombstones:
    uuids: dict = field(default_factory=dict)
    identifier_hashes: set = field(default_factory=set)

    def withdrawn_identifier(self, identifier):
        h = _v158_identifier_hash(identifier)
        return h is not None and h in self.identifier_hashes

    def add(self, entity_type, entity_uuid, ident_hash=None):
        if entity_uuid:
            self.uuids.setdefault(entity_type, set()).add(entity_uuid)
        if ident_hash:
            self.identifier_hashes.add(ident_hash)


def _v158_from_file(items):
    out = _V158Tombstones()
    for it in items or []:
        if it.get("entity_type") in _V158_ENTITY_TYPES:
            out.add(it["entity_type"], it.get("entity_uuid"), it.get("identifier_hash"))
    return out


class TestAnOlderBuildReadingTheFile:
    def test_1_5_8_ignores_the_name_kind_whole_and_still_reads_the_ID(self, client):
        """D73's travel claim: no format bump, because the previous release's `from_file`
        drops an unknown kind — its status quo (D10's precedent)."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        items = archive_payload(export(client, pid))["tombstones"]
        assert any(t["entity_type"] == "participant_name" for t in items)   # population
        old = _v158_from_file(items)
        assert old.identifier_hashes == {_v158_identifier_hash("M01")}
        assert old.withdrawn_identifier("M01")
        assert not old.withdrawn_identifier("Maria")


class TestTheNameKindIsReadOnlyByTheSpeakerDoor:
    """🔴 D73's wall. After M01 ("Maria") withdraws, "Maria" is a NAME the record
    remembers — and no reader of an ID may take it for one."""

    def test_the_ID_predicates_do_not_see_a_name(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        db = SessionLocal()
        try:
            t = tombstones.load(db, _project_uuid(pid))
            assert t.withdrawn_speaker_label("Maria")             # the door does
            assert t.withdrawn_name("Maria")
            assert not t.withdrawn_identifier("Maria")
            assert not t.withdrawn_participant(None, "Maria")
            assert not tombstones.is_withdrawn_identifier(db, _project_uuid(pid), "Maria")
            assert t.withdrawn_identifier("M01")                   # control
        finally:
            db.close()

    def test_a_typed_participant_named_like_her_is_not_refused(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = client.c.post(f"/api/projects/{pid}/participants",
                          json={"identifier": "Maria"}, headers=client.H)
        assert r.status_code == 200, r.text
        control = client.c.post(f"/api/projects/{pid}/participants",
                                json={"identifier": "M01"}, headers=client.H)
        assert control.status_code == 409, control.text

    def test_linking_by_column_creates_a_record_named_like_her(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        db = SessionLocal()
        try:
            ds = Dataset(project_id=pid, name="Wave 3"); db.add(ds); db.flush()
            idc = _col(ds, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
            for ident in ("Maria", "M01"):
                row = DatasetRow(dataset_id=ds.id, row_identifier=ident); db.add(row); db.flush()
                db.add(DatasetValue(row_id=row.id, column_id=idc.id, value_text=ident))
            db.commit(); ds_id, idc_id = ds.id, idc.id
        finally:
            db.close()
        _withdraw(client, pid, ids["P"]["M01"])
        rep = ok(client.c.post(f"/api/projects/{pid}/datasets/{ds_id}/link-by-column",
                               json={"column_id": idc_id}, headers=client.H))
        assert rep["skipped_withdrawn"] == 1              # control: her ID
        assert rep["created"] == 1
        assert "Maria" in _participants(pid)

    def test_a_project_holding_someone_named_like_her_still_copies_and_merges(self, client):
        """`_refuse_withdrawn_in_file` (Duplicate) and the merge's skip and #1470 refusal
        ask the ID: a participant whose ID is "Maria" is someone else to them."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        ok(client.c.post(f"/api/projects/{pid}/participants",
                         json={"identifier": "Maria"}, headers=client.H))
        d = client.c.post(f"/api/projects/{pid}/duplicate", headers=client.H)
        assert d.status_code == 200, d.text
        assert "Maria" in _participants(d.json()["project_id"])
        r = merge(client, export(client, pid), pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert r.json()["merge_report"]["withdrawn_participants_skipped"] == 0
        assert "Maria" in _participants(pid)
