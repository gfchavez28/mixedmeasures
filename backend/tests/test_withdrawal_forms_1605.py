"""#1605 (D227–D229, D237) — a withdrawn person's ID in another Unicode form, and her
names in other capitals, spacing or accent encoding, are recognised.

Before: the withdrawal record compared names and IDs as written, trimmed only. A
transcript writing her name `MARIA`, `maria` or with a double space — or the ID in the
decomposed accents some Mac and transcription tools write, identical on screen — made
her a participant again with no warning.

The rules (`services/tombstones.py`):
- an ID is the same ID in any canonically equivalent form, capitals kept (DEC-2: `P01`
  and `p01` can be two people) — every ID door: the speaker door's ID arm, link by
  column, the typed create, every `.mmproject` door, the report's D14 count;
- a name is compared folded (capitals, spacing, accent encoding; never accents
  themselves), at the speaker door only (D73's wall);
- the ID's own spelling is remembered as a folded name too (D229);
- the speaker door's warning says when a label matched only once capitals or spacing
  were ignored (D237).

Every withdrawal and import goes through its real HTTP door; the world is built through
the ORM (`test_merge_brings_back.build_world`). The upgrade of withdrawals made before
this release is `test_withdrawal_record_upgrade_1605.py`.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata

from app.database import SessionLocal
from app.models.dataset import ColumnType, Dataset, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.removal_tombstone import RemovalTombstone
from app.services import tombstones
from tests.test_merge_brings_back import _col, build_world, client, export, merge, ok  # noqa: F401
from tests.test_withdrawal_names_1472 import (
    _import, _name_rows, _participants, _project_uuid, _speaker_links, _withdraw,
)

NFC = unicodedata.normalize("NFC", "José Núñez")
NFD = unicodedata.normalize("NFD", "José Núñez")
#: é and ú composed, ñ decomposed — equal to neither NFC nor NFD as written.
MIXED = "José Núñez"
CLAUSE = "written here with different capitals or spacing"


def test_the_fixtures_forms_differ():
    """Discrimination: each fixture form is a different string from the others, and
    canonically equivalent to them — or no test here could tell the rules apart."""
    assert len({NFC, NFD, MIXED}) == 3
    assert {unicodedata.normalize("NFC", s) for s in (NFC, NFD, MIXED)} == {NFC}


def _participant(pid, identifier):
    db = SessionLocal()
    try:
        p = Participant(project_id=pid, identifier=identifier)
        db.add(p)
        db.commit()
        return p.id
    finally:
        db.close()


def _jose(client, pid):
    """A participant MADE from a transcript speaker, so her ID is her name."""
    ok(_import(client, pid, [NFC], name="First"))
    db = SessionLocal()
    try:
        return db.query(Participant).filter_by(project_id=pid, identifier=NFC).one().id
    finally:
        db.close()


def _create(client, pid, identifier):
    return client.c.post(f"/api/projects/{pid}/participants",
                         json={"identifier": identifier}, headers=client.H)


def _refused(r):
    return r.status_code == 409 and r.json()["detail"]["error"] == "withdrawn_identifier"


def _old_rows(pid, ident, names):
    """The record a withdrawal made before #1605 wrote: v1 hashes over the text as
    written (trimmed only), computed here independently of the module."""
    u = _project_uuid(pid)
    db = SessionLocal()
    try:
        db.add(RemovalTombstone(
            project_uuid=u, entity_type="participant", reason="withdrawal",
            identifier_hash=hashlib.sha256(
                ("mm-withdrawn-identifier:v1:" + ident.strip()).encode()).hexdigest()))
        for n in names:
            db.add(RemovalTombstone(
                project_uuid=u, entity_type="participant_name", reason="withdrawal",
                identifier_hash=hashlib.sha256(
                    ("mm-withdrawn-name:v1:" + n.strip()).encode()).hexdigest()))
        db.commit()
    finally:
        db.close()


class TestTheSpeakerDoor:
    def test_her_names_in_other_capitals_and_spacing_are_kept_out(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])            # ID M01, name "Maria"
        r = _import(client, pid, ["MARIA", "maria", "m01", "Noor"])
        assert r.status_code == 200, r.text
        links = _speaker_links(pid)
        assert [links[n] for n in ("MARIA", "maria", "m01")] == [None] * 3
        assert links["Noor"] == "Noor"                     # control
        assert r.json()["warnings"] == [tombstones.withdrawn_speaker_warning(3, 3)]

    def test_a_speaker_made_participant_in_another_form_or_capitals(self, client):
        """Her ID IS her name (a transcript made her) — the case D229 exists for."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, _jose(client, pid))
        r = _import(client, pid, [NFD, "JOSÉ NÚÑEZ", "josé  núñez"], name="Second")
        assert r.status_code == 200, r.text
        assert not any(unicodedata.normalize("NFC", p).casefold() == NFC.casefold()
                       for p in _participants(pid))
        # NFD is the same text encoded the other way: exact. The other two folded.
        assert r.json()["warnings"] == [tombstones.withdrawn_speaker_warning(3, 2)]

    def test_accents_are_never_ignored(self, client):
        """`Maria` withdrew; a speaker `María` is someone else's name, and is linked."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = _import(client, pid, ["María"])
        assert r.status_code == 200, r.text
        assert r.json()["warnings"] == []
        assert _speaker_links(pid)["María"] == "María"


class TestTheWarningSaysWhenCapitalsOrSpacingWereIgnored:
    """D237 — a clause when a label matched only folded; still a count, never a name."""

    def test_an_exact_match_keeps_todays_sentence(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = _import(client, pid, ["Maria"])
        (w,) = r.json()["warnings"]
        assert w == tombstones.withdrawn_speaker_warning(1) and CLAUSE not in w

    def test_a_folded_only_match_says_so_and_never_names_her(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = _import(client, pid, ["MARIA"])
        (w,) = r.json()["warnings"]
        assert w == tombstones.withdrawn_speaker_warning(1, 1) and CLAUSE in w
        assert "MARIA" not in w and "Maria" not in w and "M01" not in w

    def test_an_accent_encoded_the_other_way_is_exact(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, _jose(client, pid))
        r = _import(client, pid, [NFD], name="Second")
        assert r.json()["warnings"] == [tombstones.withdrawn_speaker_warning(1)]

    def test_one_exact_and_one_folded_take_the_some_form(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        r = _import(client, pid, ["Maria", "MARIA"])
        (w,) = r.json()["warnings"]
        assert w == tombstones.withdrawn_speaker_warning(2, 1)
        assert w.startswith("2 speakers were not linked") and "(some " + CLAUSE + ")" in w

    def test_the_sentences(self):
        plain = {n: tombstones.withdrawn_speaker_warning(n) for n in (1, 3)}
        assert tombstones.withdrawn_speaker_warning(1, 1) == plain[1].replace(
            "that name or ID.", f"that name or ID, {CLAUSE}.")
        assert tombstones.withdrawn_speaker_warning(3, 3) == plain[3].replace(
            "those names or IDs.", f"those names or IDs, {CLAUSE}.")
        assert tombstones.withdrawn_speaker_warning(3, 1) == plain[3].replace(
            "those names or IDs.", f"those names or IDs (some {CLAUSE}).")
        for count, folded in ((1, 1), (3, 3), (3, 1)):
            w = tombstones.withdrawn_speaker_warning(count, folded)
            assert w.split(",")[0] == plain[count].split(",")[0]   # the count is unchanged
            assert "accent" not in w


class TestTheIdDoors:
    def test_a_typed_ID_in_another_form_asks_first_and_capitals_stay_two_people(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, _jose(client, pid))
        assert _refused(_create(client, pid, NFD))
        _withdraw(client, pid, ids["P"]["M01"])
        r = _create(client, pid, "m01")
        assert r.status_code == 200, r.text                # DEC-2: capitals are kept

    def test_a_mixed_form_ID_withdrawn_now_answers_both_forms(self, client):
        """The WRITER composes (mutant M2: a dual-form reader alone hides a writer that
        hashes as written; only a form that is neither NFC nor NFD shows it)."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, _participant(pid, MIXED))
        assert _refused(_create(client, pid, NFC))
        assert _refused(_create(client, pid, NFD))

    def test_a_typed_ID_meets_a_record_written_before_1605_in_the_other_form(self, client):
        """The READER asks every form (mutant M7: one composed hash still catches a
        decomposed label against a NEW row; only an OLD decomposed row needs the rest)."""
        ids = build_world(client)
        pid = ids["pid"]
        _old_rows(pid, NFD, [])
        assert _refused(_create(client, pid, NFC))
        assert _refused(_create(client, pid, NFD))
        r = _create(client, pid, "JOSÉ NÚÑEZ")
        assert r.status_code == 200, r.text                # capitals: someone else

    def test_linking_by_column_skips_her_ID_in_another_form(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        jose = _jose(client, pid)
        db = SessionLocal()
        try:
            ds = Dataset(project_id=pid, name="Wave 3"); db.add(ds); db.flush()
            idc = _col(ds, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
            for ident in (NFD, "m01", "Zed"):
                row = DatasetRow(dataset_id=ds.id, row_identifier=ident); db.add(row); db.flush()
                db.add(DatasetValue(row_id=row.id, column_id=idc.id, value_text=ident))
            db.commit(); ds_id, idc_id = ds.id, idc.id
        finally:
            db.close()
        _withdraw(client, pid, jose)
        _withdraw(client, pid, ids["P"]["M01"])
        rep = ok(client.c.post(f"/api/projects/{pid}/datasets/{ds_id}/link-by-column",
                               json={"column_id": idc_id}, headers=client.H))
        assert rep["skipped_withdrawn"] == 1               # NFD José
        assert rep["created"] == 2                         # m01 (DEC-2) and Zed
        assert NFD not in _participants(pid)

    def test_a_merge_skips_her_minted_again_in_another_form(self, client, tmp_path):
        """A colleague's copy that minted her again (a new uuid) with a decomposed ID."""
        import io
        import uuid as _uuid
        import zipfile
        from tests.archive_support import archive_extras, archive_payload, write_archive
        ids = build_world(client)
        pid = ids["pid"]
        jose = _jose(client, pid)
        e0 = export(client, pid)
        _withdraw(client, pid, jose)
        payload = archive_payload(e0)
        manifest = json.loads(zipfile.ZipFile(io.BytesIO(e0)).read("manifest.json"))
        her = next(p for p in payload["participants"] if p["identifier"] == NFC)
        her["identifier"] = NFD
        her["uuid"] = str(_uuid.uuid4())
        doctored = write_archive(tmp_path / "copy.mmproject", manifest, payload,
                                 archive_extras(e0))
        r = merge(client, doctored.read_bytes(), pid, code_mapping={})
        assert r.status_code == 200, r.text
        assert NFD not in _participants(pid) and NFC not in _participants(pid)


class TestTheReportsCount:
    """D14 — unlinked records carrying her ID, by the record's own rule (#1605, D227)."""

    def test_a_record_holding_her_ID_in_the_other_form_is_counted(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        her = _participant(pid, NFC)
        db = SessionLocal()
        try:
            ds = Dataset(project_id=pid, name="Wave 4"); db.add(ds); db.flush()
            idc = _col(ds, "PID", ColumnType.IDENTIFIER, 0); db.add(idc); db.flush()
            # Mutant M9: `instr` over the composed form alone never reaches the NFD cell.
            for i, cell in enumerate((NFD, "JOSÉ NÚÑEZ")):
                row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i}")
                db.add(row); db.flush()
                db.add(DatasetValue(row_id=row.id, column_id=idc.id, value_text=cell))
            db.commit()
        finally:
            db.close()
        rep = ok(client.c.get(
            f"/api/projects/{pid}/participants/{her}/withdrawal-report", headers=client.H))
        assert rep["unlinked_records_with_identifier"] == 1    # NFD, not the capitals


class TestTheOldRecord:
    """A withdrawal made before #1605: v1 hashes over the text as written."""

    def test_an_old_decomposed_ID_answers_both_forms_and_old_names_stay_exact(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _old_rows(pid, NFD, ["Joe"])
        db = SessionLocal()
        try:
            t = tombstones.load(db, _project_uuid(pid))
            assert t.withdrawn_identifier(NFC) and t.withdrawn_identifier(NFD)
            assert t.withdrawn_speaker_match("Joe") == tombstones.SPEAKER_MATCH_EXACT
            assert not t.withdrawn_name("JOE")             # an old name: as written only
            assert not t.withdrawn_speaker_label("JOSÉ NÚÑEZ")   # until the upgrade
        finally:
            db.close()


class TestWhatAWithdrawalWrites:
    def test_each_name_as_written_and_folded_and_the_ID_folded(self, client):
        """D229 + D237, for M01 ("Maria"): "Maria" as written and folded, and "M01"
        folded only — its as-written spelling is the ID kind's already."""
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        assert {h for (h,) in _name_rows(pid)} == {
            tombstones.name_hash("Maria"), tombstones.folded_name_hash("Maria"),
            tombstones.folded_name_hash("M01"),
        }


class TestTheWall:
    def test_a_folded_name_still_answers_no_ID_question(self, client):
        ids = build_world(client)
        pid = ids["pid"]
        _withdraw(client, pid, ids["P"]["M01"])
        db = SessionLocal()
        try:
            t = tombstones.load(db, _project_uuid(pid))
            for label in ("MARIA", "maria", "m01"):
                assert t.withdrawn_speaker_match(label) == tombstones.SPEAKER_MATCH_FOLDED
                assert not t.withdrawn_participant(None, label)
                assert not tombstones.is_withdrawn_identifier(db, _project_uuid(pid), label)
        finally:
            db.close()
