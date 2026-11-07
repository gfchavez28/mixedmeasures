"""#1470 (D69–D72) — a withdrawal made in a COLLEAGUE'S copy, and D77 — an undo of a
result a later merge or split has hidden (1.5.9; the git-ignored
the internal design notes).

Written as the wanted behaviour: every refusal test here fails at `6b7f424b`, where the
merge stored the copy's record, kept the person's data, and left the project refusing
its own Duplicate with a remedy that could not work.

The world is `test_merge_brings_back.build_world` — M01 ("Maria") speaks two turns. The
colleague's withdrawal is made HERE and its record then removed, and the lead's project
re-created from the pre-withdrawal export as a coding copy under the same identity: one
install standing in for two, which is the only way a test can hold both sides.
"""

from __future__ import annotations

import os

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.config import get_backup_dir
from app.database import SessionLocal
from app.services import tombstones as tomb
from app.services.project_portability import UNAPPLIED_WITHDRAWAL_MESSAGE
from app.services.segment_operations import (
    UNDO_OF_HIDDEN_SEGMENT_MESSAGE, merge_segments, split_segment, unmerge_segment,
    unsplit_segment,
)
from app.schemas.segment import SegmentSplitRange
from tests.archive_support import archive_payload
from tests.test_merge_brings_back import (  # noqa: F401 — the fixture
    build_world, client, export, merge, ok, validate,
)
from tests.test_segment_operations import _setup_conversation
from tests.test_withdrawal_tombstones import _participants, _q, _withdraw

OLD_SENTENCE = (
    "This file holds data of a participant who withdrew from this project, so it cannot be "
    "imported here. Import a copy exported after the withdrawal."
)


def _maria_words(pid):
    return [t for (t,) in _q(
        "SELECT s.text FROM segments s JOIN conversations c ON c.id=s.conversation_id "
        "WHERE c.project_id=:p AND s.text LIKE 'MARIA%'", p=pid)]


def _tombstone_count(project_uuid):
    return _q("SELECT count(*) FROM removal_tombstones WHERE project_uuid=:u",
              u=project_uuid)[0][0]


def _uuid_of(pid):
    return _q("SELECT project_uuid FROM projects WHERE id=:p", p=pid)[0][0]


def _backups():
    return set(os.listdir(get_backup_dir())) if os.path.isdir(get_backup_dir()) else set()


def _lead_and_colleague_copy(k):
    """(lead project id, its M01 participant id, the colleague's export after THEY
    withdrew M01, the lead's own pre-withdrawal export). This install holds no record
    of that withdrawal."""
    ids = build_world(k)
    pid = ids["pid"]
    identity = _uuid_of(pid)
    e0 = export(k, pid)
    _withdraw(k, pid, ids["P"]["M01"])
    e1 = export(k, pid)
    db = SessionLocal()
    db.execute(text("DELETE FROM removal_tombstones")); db.commit(); db.close()
    ok(k.c.delete(f"/api/projects/{pid}", headers=k.H))
    r = k.c.post("/api/projects/import-project", data={"import_mode": "copy_for_coding"},
                 files={"file": ("e0.mmproject", e0, "application/zip")}, headers=k.H)
    assert r.status_code == 200, r.text
    lead = r.json()["project_id"]
    assert _uuid_of(lead) == identity      # a coding copy keeps the identity
    m01 = _q("SELECT id FROM participants WHERE project_id=:p AND identifier='M01'",
             p=lead)[0][0]
    # Preconditions: the lead holds her and her words, and no record of the withdrawal.
    assert len(_maria_words(lead)) == 2
    assert _tombstone_count(_uuid_of(lead)) == 0
    return lead, m01, e1, e0


class TestAMergeOfACopyThatWithdrewSomeoneHeldHere:
    def test_is_refused_and_changes_nothing(self, client):
        lead, m01, e1, _ = _lead_and_colleague_copy(client)
        backups = _backups()
        r = merge(client, e1, lead, code_mapping={})
        assert r.status_code == 409, r.text            # HEAD: 200, nothing skipped
        detail = r.json()["detail"]
        assert detail["error"] == "merge_divergence"
        assert detail["kind"] == tomb.WITHDRAWAL_DIVERGENCE_KIND == "withdrawal"
        assert detail["withdrawn_here"] == [{"participant_id": m01, "identifier": "M01"}]
        # Nothing changed: her data, no record stored, and no safety copy written.
        assert "M01" in _participants(lead)
        assert len(_maria_words(lead)) == 2
        assert _tombstone_count(_uuid_of(lead)) == 0
        assert _backups() == backups

    def test_the_preview_predicts_the_refusal(self, client):
        lead, m01, e1, _ = _lead_and_colleague_copy(client)
        v = validate(client, e1)
        assert v.status_code == 200, v.text
        assert v.json()["merge_additions"]["withdrawn_here"] == [
            {"participant_id": m01, "identifier": "M01"}]

    def test_withdrawing_here_first_lets_the_merge_through(self, client):
        """The remedy the refusal names is a real one — and the positive control: a
        refusal that fired on every merge of a copy carrying a record would pass the
        tests above."""
        lead, m01, e1, _ = _lead_and_colleague_copy(client)
        _withdraw(client, lead, m01)
        assert validate(client, e1).json()["merge_additions"]["withdrawn_here"] == []
        r = merge(client, e1, lead, code_mapping={})
        assert r.status_code == 200, r.text
        assert "M01" not in _participants(lead)
        assert _maria_words(lead) == []
        assert client.c.post(f"/api/projects/{lead}/duplicate", headers=client.H).status_code == 200

    def test_someone_reinstated_under_the_id_is_not_caught(self, client):
        """D12 — a NEW person the researcher confirmed under the withdrawn ID is nobody's
        withdrawal; the one predicate says so through the reinstatement marker."""
        lead, m01, e1, _ = _lead_and_colleague_copy(client)
        _withdraw(client, lead, m01)
        ok(client.c.post(f"/api/projects/{lead}/participants",
                         json={"identifier": "M01", "confirm_withdrawn": True},
                         headers=client.H))
        assert "M01" in _participants(lead)
        assert validate(client, e1).json()["merge_additions"]["withdrawn_here"] == []
        r = merge(client, e1, lead, code_mapping={})
        assert r.status_code == 200, r.text
        assert "M01" in _participants(lead)

    def test_a_record_naming_her_by_uuid_alone_still_finds_her(self, client):
        """A file's record is whatever the file says; one carrying her participant uuid
        and no ID hash still names her (the early return must not read it as empty)."""
        lead, m01, _, _ = _lead_and_colleague_copy(client)
        her_uuid = _q("SELECT uuid FROM participants WHERE id=:i", i=m01)[0][0]
        record = tomb.Tombstones()
        record.add(tomb.PARTICIPANT, her_uuid)
        db = SessionLocal()
        try:
            assert tomb.withdrawn_but_held(db, lead, record) == [
                {"participant_id": m01, "identifier": "M01"}]
            assert tomb.withdrawn_but_held(db, lead, tomb.Tombstones()) == []
        finally:
            db.close()

    def test_a_direct_caller_gets_the_sentence(self, client):
        lead, m01, e1, _ = _lead_and_colleague_copy(client)
        r = merge(client, e1, lead, code_mapping={})
        message = tomb.withdrawn_but_held_message(r.json()["detail"]["withdrawn_here"])
        assert "M01" in message and "Withdraw them in this project first" in message


def _make_unapplied(k):
    """The state a merge left on 1.5.8: the copy's record stored on the lead's project,
    her data still there."""
    lead, m01, e1, e0 = _lead_and_colleague_copy(k)
    db = SessionLocal()
    try:
        tomb.write(db, _uuid_of(lead), tomb.from_file(archive_payload(e1).get("tombstones")))
        db.commit()
    finally:
        db.close()
    assert _tombstone_count(_uuid_of(lead)) > 0
    assert "M01" in _participants(lead)
    return lead, m01, e1, e0


class TestAProjectAlreadyHoldingAnUnappliedWithdrawal:
    def test_duplicate_names_the_remedy_that_works(self, client):
        lead, _, _, _ = _make_unapplied(client)
        d = client.c.post(f"/api/projects/{lead}/duplicate", headers=client.H)
        assert d.status_code == 400
        assert d.json()["detail"] == UNAPPLIED_WITHDRAWAL_MESSAGE   # HEAD: OLD_SENTENCE

    def test_its_next_merge_is_refused_over_them(self, client):
        """Its own record now names someone it holds, so ANY copy's merge — an older one
        carrying no record at all — is refused with the remedy, not merged around her."""
        lead, m01, _, e0 = _make_unapplied(client)
        r = merge(client, e0, lead, code_mapping={})
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["withdrawn_here"] == [{"participant_id": m01, "identifier": "M01"}]

    def test_withdrawing_there_repairs_it(self, client):
        lead, m01, _, _ = _make_unapplied(client)
        _withdraw(client, lead, m01)
        assert _maria_words(lead) == []
        assert client.c.post(f"/api/projects/{lead}/duplicate", headers=client.H).status_code == 200

    def test_CONTROL_an_older_copy_keeps_the_old_sentence(self, client):
        """A copy made before a withdrawal applied HERE carries no record naming her, so
        its refusal is still "import a copy exported after the withdrawal"."""
        ids = build_world(client)
        pid = ids["pid"]
        e0 = export(client, pid)
        _withdraw(client, pid, ids["P"]["M01"])
        r = client.c.post("/api/projects/import-project", data={"import_mode": "new"},
                          files={"file": ("e0.mmproject", e0, "application/zip")},
                          headers=client.H)
        assert r.status_code == 400
        assert r.json()["detail"] == OLD_SENTENCE


class TestAnUndoOfAHiddenResultIsRefused:
    """D77 — the service is the one door (conversation, document and clip routes all
    call it), so the guard is pinned there."""

    def _args(self, project, user, conv):
        return dict(parent_type="conversation", parent_id=conv.id,
                    project_id=project.id, user_id=user.id)

    def test_unmerge_of_a_merge_result_merged_again(self, db_session):
        project, user, conv, _, segs = _setup_conversation(db_session)
        a = self._args(project, user, conv)
        m1, _ = merge_segments(db_session, segment_ids=[segs[1].id, segs[2].id], **a)
        m2, _ = merge_segments(db_session, segment_ids=[m1.id, segs[3].id], **a)
        with pytest.raises(HTTPException) as exc:
            unmerge_segment(db_session, segment_id=m1.id, **a)
        assert exc.value.status_code == 409
        assert exc.value.detail == UNDO_OF_HIDDEN_SEGMENT_MESSAGE
        # Control: in order, both undo.
        unmerge_segment(db_session, segment_id=m2.id, **a)
        restored, n = unmerge_segment(db_session, segment_id=m1.id, **a)
        assert n == 2

    def test_unsplit_of_a_split_child_merged_again(self, db_session):
        project, user, conv, _, segs = _setup_conversation(db_session)
        a = self._args(project, user, conv)
        parts, _ = split_segment(
            db_session, ranges=[SegmentSplitRange(segment_id=segs[0].id, start_offset=6,
                                                  end_offset=13)], **a)
        before, selected, after = parts
        m, _ = merge_segments(db_session, segment_ids=[selected.id, after.id], **a)
        with pytest.raises(HTTPException) as exc:
            unsplit_segment(db_session, segment_id=selected.id, **a)
        assert exc.value.status_code == 409
        # Control: undo the merge, then the split undoes.
        unmerge_segment(db_session, segment_id=m.id, **a)
        restored, _ = unsplit_segment(db_session, segment_id=selected.id, **a)
        assert restored.text == "First segment text."
