"""#1321 — a colleague's CODING COPY, round trip, on TWO installs, through the HTTP calls
the UI makes.

Every other merge test runs in ONE database: it exports a project, deletes rows from the
target and merges them back. That cannot see the door the external review found (DI-04):
on the colleague's install the file matches NO local project, so `/validate-import`
answers `existing_project: null`, the Dashboard offered only *Import* (`import_mode=new`),
and "new" re-mints the project's identity — after which the lead's merge is refused 400
with "Target project identity does not match the file".

So each install here is its OWN in-memory database behind the real app, selected per
request by swapping `get_db` (two TestClients, two cookie jars). The calls are the
Dashboard's (`validate-import`, `import-project`), the workbench's (`/segments/{id}/codes`,
`/excerpts`, `/notes`), and the Merge page's (`validate-import` + `import-project` with the
confirm step's default coder mapping, `lib/merge-coder-mapping.ts::defaultDecision`). The
copy import's `coder_mapping` is the dialog's D2 answer ("which of these people is you?",
`lib/coding-copy.ts`): absent for "None of them", one `match` onto the active coder otherwise.

⚠️ The two installs share the suite's MM_DATA_DIR / MM_BACKUP_DIR (conftest's temp pins):
a text-only project places no files, and the merge's safety copy is a NEW file per run.
"""
from __future__ import annotations

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app


class Install:
    """One install: its own database, its own cookie jar, its own CSRF token."""

    def __init__(self, label: str):
        self.label = label
        self.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(self.engine, "connect")
        def _fk(dbapi_conn, _):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, autocommit=False, autoflush=False)
        self.client = TestClient(app, raise_server_exceptions=False)
        self.csrf: str | None = None

    def _get_db(self):
        db = self.Session()
        try:
            yield db
        finally:
            db.close()

    def call(self, method: str, path: str, **kw):
        app.dependency_overrides[get_db] = self._get_db
        headers = kw.pop("headers", {})
        if self.csrf and method in ("POST", "PUT", "PATCH", "DELETE"):
            headers["X-CSRF-Token"] = self.csrf
        return self.client.request(method, path, headers=headers, **kw)

    def ok(self, method: str, path: str, **kw):
        r = self.call(method, path, **kw)
        assert r.status_code in (200, 201), f"{self.label} {method} {path}: {r.status_code} {r.text}"
        return r.json() if r.content and r.headers.get("content-type", "").startswith("application/json") else r.content

    def login(self):
        self.csrf = self.ok("GET", "/api/auth/status")["user"]["csrf_token"]

    def become(self, name: str) -> int:
        """Create a coder and switch to it — the TopRail's create + switch."""
        coder = self.ok("POST", "/api/auth/coders", json={"username": name})
        self.ok("POST", "/api/auth/switch-coder", json={"coder_id": coder["id"]})
        self.login()
        return coder["id"]

    def rows(self, sql: str, **params):
        with self.engine.connect() as c:
            return c.execute(text(sql), params).fetchall()

    def close(self):
        self.client.close()
        self.engine.dispose()


TURNS = [
    ("Interviewer", "Thanks for joining. How did you first hear about the clinic?"),
    ("P01", "A neighbour told me about it, and honestly I did not trust it at first."),
    ("Interviewer", "What changed your mind about it?"),
    ("P01", "The nurse explained the costs up front, which nobody had done before."),
    ("P01", "I still worry about the bills, but I trust the people there now."),
]


@pytest.fixture
def installs():
    a, b = Install("A"), Install("B")
    a.login()
    b.login()
    try:
        yield a, b
    finally:
        app.dependency_overrides.pop(get_db, None)
        a.close()
        b.close()


def _file(blob: bytes):
    return {"file": ("study.mmproject", blob, "application/octet-stream")}


def _interview(inst: Install, pid: int, turns: list[tuple[str, str]] = TURNS) -> int:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Speaker", "Text"])
    w.writerows(turns)
    speakers = sorted({s for s, _ in turns} - {"Interviewer"})
    cfg = {
        "name": "Interview 1",
        "column_mapping": {"speaker": "Speaker", "text": "Text"},
        "speaker_mappings": [
            {"original_label": "Interviewer", "normalized_name": "Interviewer", "is_facilitator": True},
            *({"original_label": s, "normalized_name": s} for s in speakers),
        ],
    }
    out = inst.ok("POST", f"/api/projects/{pid}/conversations/import",
                  data={"import_config": json.dumps(cfg)},
                  files={"file": ("i1.csv", buf.getvalue().encode(), "text/csv")})
    return out["conversation"]["id"]


def _segments(inst: Install, cid: int) -> list[dict]:
    segs = inst.ok("GET", f"/api/conversations/{cid}/segments")["segments"]
    return sorted(segs, key=lambda s: s["sequence_order"])


def _code(inst: Install, pid: int, name: str) -> int:
    for c in inst.ok("GET", f"/api/projects/{pid}/codes")["codes"]:
        if c["name"] == name:
            return c["id"]
    return inst.ok("POST", f"/api/projects/{pid}/codes", json={"name": name})["id"]


def _apply(inst: Install, sid: int, cid: int):
    inst.ok("POST", f"/api/segments/{sid}/codes/{cid}", json={})


def _export(inst: Install, pid: int) -> bytes:
    r = inst.call("GET", f"/api/projects/{pid}/export-project?include_media=false")
    assert r.status_code == 200, r.text
    return r.content


def _lead(a: Install) -> tuple[int, int, bytes]:
    """The lead's project: one interview, Trust on turn 2 and Cost on turn 4, exported."""
    pid = a.ok("POST", "/api/projects", json={"name": "Clinic study"})["id"]
    cid = _interview(a, pid)
    segs = _segments(a, cid)
    _apply(a, segs[1]["id"], _code(a, pid, "Trust"))
    _apply(a, segs[3]["id"], _code(a, pid, "Cost"))
    return pid, cid, _export(a, pid)


def _ui_merge(inst: Install, blob: bytes, name_only: str | None = None):
    """What the Dashboard + MergeProject send (D-2 'new' for any divergent code), with the
    confirm step's defaults as `lib/merge-coder-mapping.ts::defaultDecision` makes them
    since #1352 (D4): the SAME coder by identity is pre-selected, no local match is *Add as
    new coder*, and a coder who only shares a NAME starts unanswered — so a test reaching
    one must say what the researcher answers (`name_only`: "create" or "match")."""
    v = inst.ok("POST", "/api/projects/validate-import", files=_file(blob))
    target = v["existing_project"]
    assert target, "validate-import found no local copy, so the UI offers no Merge"
    mapping = {}
    for c in v["merge_coders"]:
        lm = c["local_match"]
        if lm and lm["basis"] == "name":
            assert name_only, f"{c['username']} matches a coder here by name only: answer it"
            decision = name_only
        else:
            decision = "match" if lm else "create"
        mapping[str(c["original_id"])] = (
            {"action": "match", "target_user_id": lm["id"]} if decision == "match"
            else {"action": "create"}
        )
    form = {"import_mode": "merge", "target_project_id": str(target["id"]),
            "coder_mapping": json.dumps(mapping)}
    if v.get("merge_codes_preview"):
        form["code_mapping"] = json.dumps({c["uuid"]: {"action": "new"} for c in v["merge_codes_preview"]})
    return inst.call("POST", "/api/projects/import-project", data=form, files=_file(blob))


def _coding_copy(b: Install, blob: bytes, coder_mapping: dict | None = None) -> int:
    data = {"import_mode": "copy_for_coding"}
    if coder_mapping is not None:
        data["coder_mapping"] = json.dumps(coder_mapping)
    r = b.call("POST", "/api/projects/import-project", data=data, files=_file(blob))
    assert r.status_code == 200, r.text
    return r.json()["project_id"]


def _who_is_you_listed(v: dict, me: int) -> list[str] | None:
    """The import dialog's D2 question, as `lib/coding-copy.ts` derives it from validate's
    `file_coders` (the brief's contract): the file's PEOPLE with codings whom this install
    does not know by identity — or None when it is skipped (nobody listed, or a file coder
    already IS you by identity). The server half of the contract is these fields."""
    listed = [
        c["username"] for c in v["file_coders"]
        if c["coder_type"] == "human" and c["file_app_count"] > 0
        and (c["local_match"] or {}).get("basis") != "identity"
    ]
    if not listed or any(
        (c["local_match"] or {}).get("basis") == "identity" and c["local_match"]["id"] == me
        for c in v["file_coders"]
    ):
        return None
    return listed


def _is_me(v: dict, username: str, me: int) -> dict:
    """The one `coder_mapping` entry the dialog sends for "<username> is me"."""
    (c,) = [c for c in v["file_coders"] if c["username"] == username]
    return {str(c["original_id"]): {"action": "match", "target_user_id": me}}


def _colleague_codes(b: Install, bpid: int) -> int:
    bcid = b.ok("GET", f"/api/projects/{bpid}/conversations")["conversations"][0]["id"]
    segs = _segments(b, bcid)
    trust, cost = _code(b, bpid, "Trust"), _code(b, bpid, "Cost")
    _apply(b, segs[1]["id"], trust)   # agrees with the lead
    _apply(b, segs[3]["id"], cost)    # agrees with the lead
    _apply(b, segs[4]["id"], trust)   # the lead left this turn uncoded
    b.ok("POST", f"/api/projects/{bpid}/excerpts",
         json={"segment_id": segs[4]["id"], "start_offset": 0, "end_offset": 23})
    b.ok("POST", f"/api/conversations/{bcid}/notes",
         json={"content": "colleague note", "segment_id": segs[3]["id"]})
    return bcid


def _codings_by_coder(inst: Install, pid: int) -> dict[str, int]:
    return dict(inst.rows(
        "SELECT u.username, COUNT(*) FROM code_applications ca "
        "JOIN users u ON u.id = ca.user_id JOIN codes c ON c.id = ca.code_id "
        "WHERE c.project_id = :pid AND ca.origin != 'consensus' GROUP BY u.username",
        pid=pid,
    ))


class TestTheColleaguesCopyComesBack:

    def test_validate_on_the_colleagues_install_finds_no_local_copy(self, installs):
        """The precondition of the whole issue: the colleague's install has never seen it."""
        a, b = installs
        a.become("Ana")
        _, _, blob = _lead(a)
        v = b.ok("POST", "/api/projects/validate-import", files=_file(blob))
        assert v["existing_project"] is None
        assert v["merge_coders"] is None

    def test_a_coding_copy_merges_back_with_its_coder_and_annotations(self, installs):
        a, b = installs
        a.become("Ana")
        b.become("Bea")
        a_pid, a_cid, blob = _lead(a)

        bpid = _coding_copy(b, blob)
        lead_uuid = a.rows("SELECT project_uuid FROM projects WHERE id = :p", p=a_pid)[0][0]
        assert b.rows("SELECT project_uuid FROM projects WHERE id = :p", p=bpid)[0][0] == lead_uuid
        _colleague_codes(b, bpid)

        r = _ui_merge(a, _export(b, bpid))
        assert r.status_code == 200, r.text
        report = r.json()["merge_report"]
        assert (report["sources_matched"], report["applications_added"], report["duplicates_skipped"]) == (1, 3, 2)
        assert _codings_by_coder(a, a_pid) == {"Ana": 2, "Bea": 3}
        assert a.rows("SELECT COUNT(*) FROM excerpt e JOIN segments s ON s.id = e.segment_id "
                      "WHERE s.conversation_id = :c", c=a_cid)[0][0] == 1
        assert a.rows("SELECT COUNT(*) FROM notes WHERE conversation_id = :c", c=a_cid)[0][0] == 1
        irr = a.ok("GET", f"/api/projects/{a_pid}/code-analysis/irr")
        assert irr["available"] is True, irr

    def test_the_same_copy_merged_twice_adds_nothing(self, installs):
        a, b = installs
        a.become("Ana")
        b.become("Bea")
        a_pid, a_cid, blob = _lead(a)
        bpid = _coding_copy(b, blob)
        _colleague_codes(b, bpid)
        back = _export(b, bpid)
        assert _ui_merge(a, back).status_code == 200
        first = _codings_by_coder(a, a_pid)
        r = _ui_merge(a, back)
        assert r.status_code == 200, r.text
        assert r.json()["merge_report"]["applications_added"] == 0
        assert _codings_by_coder(a, a_pid) == first
        assert a.rows("SELECT COUNT(*) FROM notes WHERE conversation_id = :c", c=a_cid)[0][0] == 1
        assert a.rows("SELECT COUNT(*) FROM users WHERE username LIKE 'Bea%'")[0][0] == 1

    def test_control_a_NEW_import_cannot_come_back(self, installs):
        """Today's only UI choice: the copy is re-minted and the merge is refused."""
        a, b = installs
        a.become("Ana")
        a_pid, _, blob = _lead(a)
        r = b.call("POST", "/api/projects/import-project", data={"import_mode": "new"}, files=_file(blob))
        assert r.status_code == 200, r.text
        back = _export(b, r.json()["project_id"])
        v = a.ok("POST", "/api/projects/validate-import", files=_file(back))
        assert v["existing_project"] is None
        r = a.call("POST", "/api/projects/import-project",
                   data={"import_mode": "merge", "target_project_id": str(a_pid)}, files=_file(back))
        assert r.status_code == 400
        assert "identity does not match" in r.json()["detail"]

    def test_a_second_newer_copy_merges_into_the_first(self, installs):
        """The colleague receives a newer export: a second coding copy is refused (it would
        be two projects with one identity), and the newer file MERGES into the copy."""
        a, b = installs
        a.become("Ana")
        b.become("Bea")
        a_pid, _, blob = _lead(a)
        bpid = _coding_copy(b, blob)
        _colleague_codes(b, bpid)
        _interview(a, a_pid)  # the lead adds a second interview
        newer = _export(a, a_pid)
        r = b.call("POST", "/api/projects/import-project",
                   data={"import_mode": "copy_for_coding"}, files=_file(newer))
        assert r.status_code == 400 and "merge the file into it" in r.json()["detail"]
        assert b.ok("POST", "/api/projects/validate-import", files=_file(newer))["existing_project"]["id"] == bpid
        r = _ui_merge(b, newer)
        assert r.status_code == 200, r.text
        assert len(b.ok("GET", f"/api/projects/{bpid}/conversations")["conversations"]) == 2
        r = _ui_merge(a, _export(b, bpid))
        assert r.status_code == 200, r.text
        assert _codings_by_coder(a, a_pid) == {"Ana": 2, "Bea": 3}


class TestWhatTheColleagueMustNotDo:
    """The merge back refuses a copy whose UNITS or WORDS moved — on EITHER side."""

    @pytest.mark.parametrize("side, act, kind", [
        ("colleague", "split", "segmentation"),
        ("colleague", "join", "segmentation"),
        ("colleague", "edit", "segment_text"),
        ("lead", "split", "segmentation"),
        ("lead", "edit", "segment_text"),
    ])
    def test_a_moved_unit_or_word_refuses_the_merge(self, installs, side, act, kind):
        a, b = installs
        a.become("Ana")
        b.become("Bea")
        a_pid, a_cid, blob = _lead(a)
        bpid = _coding_copy(b, blob)
        bcid = _colleague_codes(b, bpid)
        inst, cid = (b, bcid) if side == "colleague" else (a, a_cid)
        segs = _segments(inst, cid)
        if act == "split":
            inst.ok("POST", f"/api/conversations/{cid}/segments/split",
                    json={"ranges": [{"segment_id": segs[2]["id"], "start_offset": 0, "end_offset": 12}]})
        elif act == "join":
            inst.ok("POST", f"/api/conversations/{cid}/segments/merge",
                    json={"segment_ids": [segs[1]["id"], segs[2]["id"]]})
        else:
            inst.ok("PATCH", f"/api/conversations/{cid}/segments/{segs[2]['id']}",
                    json={"text": segs[2]["text"].replace("mind", "view")})
        r = _ui_merge(a, _export(b, bpid))
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["kind"] == kind

    @pytest.mark.parametrize("act", ["split", "join", "edit"])
    def test_undoing_it_in_the_copy_that_changed_clears_the_refusal(self, installs, act):
        """The import dialog says so (Rejoin, Unmerge, or putting the words back), so it is
        pinned here: the colleague's change is refused, undone on their copy, re-exported,
        and the same merge goes through (r1 measured 409 → 200 for each)."""
        a, b = installs
        a.become("Ana")
        b.become("Bea")
        a_pid, _, blob = _lead(a)
        bpid = _coding_copy(b, blob)
        bcid = _colleague_codes(b, bpid)
        seg = _segments(b, bcid)[2]
        base = f"/api/conversations/{bcid}/segments"
        if act == "split":
            new = b.ok("POST", f"{base}/split", json={"ranges": [
                {"segment_id": seg["id"], "start_offset": 0, "end_offset": 12}]})["new_segments"]
        elif act == "join":
            joined = b.ok("POST", f"{base}/merge",
                          json={"segment_ids": [_segments(b, bcid)[1]["id"], seg["id"]]})["merged_segment"]
        else:
            b.ok("PATCH", f"{base}/{seg['id']}", json={"text": seg["text"].replace("mind", "view")})
        assert _ui_merge(a, _export(b, bpid)).status_code == 409
        if act == "split":
            b.ok("POST", f"{base}/{new[0]['id']}/unsplit")       # the menu's *Rejoin*
        elif act == "join":
            b.ok("POST", f"{base}/{joined['id']}/unmerge")       # the menu's *Unmerge*
        else:
            b.ok("PATCH", f"{base}/{seg['id']}", json={"text": seg["text"]})
        r = _ui_merge(a, _export(b, bpid))
        assert r.status_code == 200, r.text
        assert _codings_by_coder(a, a_pid) == {"Ana": 2, "Bea": 3}

    def test_control_a_new_code_and_a_new_source_merge(self, installs):
        a, b = installs
        a.become("Ana")
        b.become("Bea")
        a_pid, _, blob = _lead(a)
        bpid = _coding_copy(b, blob)
        bcid = _colleague_codes(b, bpid)
        _apply(b, _segments(b, bcid)[2]["id"], _code(b, bpid, "Hope"))
        _interview(b, bpid)
        r = _ui_merge(a, _export(b, bpid))
        assert r.status_code == 200, r.text
        assert r.json()["merge_report"]["codes_created"] == 1
        assert len(a.ok("GET", f"/api/projects/{a_pid}/conversations")["conversations"]) == 2


class TestTheDoorItself:
    """Wanted behaviour the 1.5.8 build adds (each FAILS at 2fe78dc7)."""

    def test_an_unknown_import_mode_is_refused_before_anything_is_written(self, installs):
        """At HEAD the router passes any string through and the service's `else` treats it
        as "new" with PRESERVED entity uuids: the first such import succeeds as a project
        with a fresh identity and the file's entity uuids, and every later import of the
        file — a coding copy included — dies on the unique index as a 500."""
        a, b = installs
        _, _, blob = _lead(a)
        r = b.call("POST", "/api/projects/import-project",
                   data={"import_mode": "copy-for-coding"}, files=_file(blob))
        assert r.status_code == 400, r.text
        assert b.rows("SELECT COUNT(*) FROM projects")[0][0] == 0
        assert _coding_copy(b, blob)

    def test_validate_names_who_the_files_coders_land_on_without_a_local_copy(self, installs):
        """What the dialog's D2 question reads, before a coding copy is imported: the file's
        coders, and who each meets here. Both installs' first coder is "Researcher", so the
        lead's meets the colleague's own — by NAME only (`basis`, #1352), which never
        answers "is this you?": the question lists them."""
        a, b = installs
        _, _, blob = _lead(a)  # the lead codes as A's default "Researcher"
        v = b.ok("POST", "/api/projects/validate-import", files=_file(blob))
        assert v["existing_project"] is None
        landing = {c["username"]: c["local_match"] for c in v["file_coders"]}
        me = b.ok("GET", "/api/auth/status")["user"]
        assert landing == {"Researcher": {"id": me["id"], "username": "Researcher",
                                          "archived": False, "local_app_count": 0,
                                          "basis": "name"}}
        assert _who_is_you_listed(v, me["id"]) == ["Researcher"]

    def test_validate_says_it_is_you_when_the_file_coder_is_you(self, installs):
        """The skip rule's server half: the lead deletes the project and imports its own
        export again — the file's coder IS the active coder, by identity, so the dialog
        asks nothing (`lib/coding-copy.ts::shouldAskWhoYouAre`)."""
        a, _ = installs
        a_pid, _, blob = _lead(a)
        me = a.ok("GET", "/api/auth/status")["user"]["id"]
        a.ok("DELETE", f"/api/projects/{a_pid}")
        v = a.ok("POST", "/api/projects/validate-import", files=_file(blob))
        assert v["existing_project"] is None
        assert [(c["username"], c["local_match"]["basis"], c["local_match"]["id"])
                for c in v["file_coders"]] == [("Researcher", "identity", me)]
        assert _who_is_you_listed(v, me) is None
        bpid = _coding_copy(a, blob)
        assert _codings_by_coder(a, bpid) == {"Researcher": 2}

    def test_a_name_taken_here_reads_imported_not_coding_copy(self, installs):
        """*Import* keeps the identity by default now (D1) — a colleague's copy and your own
        project moved here alike — so a same-name project here suffixes it as a new import
        does, "(imported)". 2fe78dc7 said "(coding copy)"."""
        a, b = installs
        _, _, blob = _lead(a)
        b.ok("POST", "/api/projects", json={"name": "Clinic study"})
        bpid = _coding_copy(b, blob)
        assert b.rows("SELECT name FROM projects WHERE id = :p", p=bpid) == [("Clinic study (imported)",)]

    def test_a_file_from_before_the_uuid_spine_is_refused_as_a_coding_copy(self, installs, tmp_path):
        """A v1.0.x export carries `project_uuid` but no entity uuids. At HEAD it imports as a
        coding copy (200) whose entities take FRESH uuids from the column defaults; the merge
        back then lists every code — the two universal codes too — as divergent and answers
        500 (measured). The door must refuse it, in words that name the way out."""
        import zipfile
        from tests.archive_support import archive_extras, archive_payload, write_archive
        a, b = installs
        _, _, blob = _lead(a)
        zf = zipfile.ZipFile(io.BytesIO(blob))
        payload = archive_payload(zf)
        for key in ("conversations", "segments", "codes", "code_categories", "speakers"):
            for item in payload.get(key) or []:
                item.pop("uuid", None)
        old = write_archive(tmp_path / "v1.0.mmproject", json.loads(zf.read("manifest.json")),
                            payload, archive_extras(zf)).read_bytes()
        r = b.call("POST", "/api/projects/import-project",
                   data={"import_mode": "copy_for_coding"}, files=_file(old))
        assert r.status_code == 400, r.text
        assert "independent project" in r.json()["detail"]
        assert b.rows("SELECT COUNT(*) FROM projects")[0][0] == 0
        # control: the same file still imports as an independent project
        r = b.call("POST", "/api/projects/import-project", data={"import_mode": "new"}, files=_file(old))
        assert r.status_code == 200, r.text


class TestWhoIsYou:
    """D2 — "which of the file's people is you?", answered at the coding-copy import. Both
    installs code as their default "Researcher" (`auth.py`'s first coder): at 2fe78dc7 the
    copy import landed the lead's codings on the colleague's own coder by NAME, the
    colleague's agreeing codings became no-ops, and the merge back counted ONE coder."""

    def test_none_of_them_keeps_the_lead_a_coder_of_their_own(self, installs):
        """No answer (the dialog's "None of them" sends no mapping): the lead arrives as a
        separate coder, numbered because the name is taken here, and the round trip ends
        with TWO people and reliability available."""
        a, b = installs
        a_pid, _, blob = _lead(a)
        bpid = _coding_copy(b, blob)
        assert _codings_by_coder(b, bpid) == {"Researcher (2)": 2}
        _colleague_codes(b, bpid)
        assert _codings_by_coder(b, bpid) == {"Researcher (2)": 2, "Researcher": 3}
        r = _ui_merge(a, _export(b, bpid), name_only="create")
        assert r.status_code == 200, r.text
        # The lead's own coder comes back by IDENTITY; the colleague's "Researcher" is new.
        assert _codings_by_coder(a, a_pid) == {"Researcher": 2, "Researcher (2)": 3}
        assert a.ok("GET", f"/api/projects/{a_pid}/code-analysis/irr")["available"] is True

    def test_X_is_me_lands_Xs_codings_on_the_importing_coder(self, installs):
        """Your own project moved to a new computer: "Researcher is me" sends ONE `match`
        onto the active coder, and no second coder is made of you."""
        a, b = installs
        _, _, blob = _lead(a)
        me = b.ok("GET", "/api/auth/status")["user"]["id"]
        v = b.ok("POST", "/api/projects/validate-import", files=_file(blob))
        assert _who_is_you_listed(v, me) == ["Researcher"]
        bpid = _coding_copy(b, blob, coder_mapping=_is_me(v, "Researcher", me))
        assert _codings_by_coder(b, bpid) == {"Researcher": 2}
        assert b.rows("SELECT COUNT(*) FROM users WHERE coder_type = 'human'")[0][0] == 1
        assert b.rows("SELECT DISTINCT ca.user_id FROM code_applications ca JOIN codes c "
                      "ON c.id = ca.code_id WHERE c.project_id = :p", p=bpid) == [(me,)]

    def test_the_answer_reaches_only_the_person_chosen(self, installs):
        """Two people in the file: the one chosen lands on you, the other keeps a coder of
        their own (never by name, though a coder here shares it)."""
        a, b = installs
        a_pid, a_cid, _ = _lead(a)                     # "Researcher" codes turns 2 and 4
        a.become("Ana")
        _apply(a, _segments(a, a_cid)[4]["id"], _code(a, a_pid, "Trust"))
        blob = _export(a, a_pid)
        me = b.become("Ana")                           # a different Ana, on B
        v = b.ok("POST", "/api/projects/validate-import", files=_file(blob))
        assert sorted(_who_is_you_listed(v, me)) == ["Ana", "Researcher"]
        bpid = _coding_copy(b, blob, coder_mapping=_is_me(v, "Researcher", me))
        # Researcher's two codings are B-Ana's now; A's Ana is a coder of her own.
        assert _codings_by_coder(b, bpid) == {"Ana": 2, "Ana (2)": 1}


class TestTheWholeRoundTrip:

    def test_two_people_after_the_round_trip_with_a_withdrawal_and_a_re_quote(self, installs, monkeypatch):
        """The two-install drive the record asks for, end to end: both sides keep their
        default "Researcher"; the colleague answers "None of them"; while the copy is out the
        lead withdraws a participant the colleague then codes and quotes, and removes and
        re-makes a quote the copy carries (r3: a delete-then-re-create was a bare 500).
        After the merge back: TWO people, reliability available, the withdrawn person not
        back and her turn still blank, and one quote where the lead made one."""
        from types import SimpleNamespace
        from app.routers import participants as participants_router
        from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT
        # The withdrawal's full backup reads the settings' database FILE, and each install
        # here is an in-memory database — the backup is not what this test is about.
        monkeypatch.setattr(participants_router, "create_backup",
                            lambda *a, **k: SimpleNamespace(filename="pre_withdrawal_test.mmbackup"))
        a, b = installs
        turns = TURNS + [("P02", "My sister drove me there, and she found the waiting room hard.")]
        a_pid = a.ok("POST", "/api/projects", json={"name": "Clinic study"})["id"]
        a_cid = _interview(a, a_pid, turns)
        segs = _segments(a, a_cid)
        _apply(a, segs[1]["id"], _code(a, a_pid, "Trust"))
        _apply(a, segs[3]["id"], _code(a, a_pid, "Cost"))
        a.ok("POST", f"/api/projects/{a_pid}/excerpts", json={"segment_id": segs[1]["id"]})
        blob = _export(a, a_pid)

        # B — the dialog asks, and the colleague answers "None of them" (no mapping).
        me_b = b.ok("GET", "/api/auth/status")["user"]["id"]
        v = b.ok("POST", "/api/projects/validate-import", files=_file(blob))
        assert _who_is_you_listed(v, me_b) == ["Researcher"]
        bpid = _coding_copy(b, blob)
        bcid = _colleague_codes(b, bpid)
        her_turn = _segments(b, bcid)[5]
        _apply(b, her_turn["id"], _code(b, bpid, "Cost"))
        b.ok("POST", f"/api/projects/{bpid}/excerpts", json={"segment_id": her_turn["id"]})

        # A — meanwhile: P02 withdraws; the lead removes and re-makes the turn-2 quote.
        p02 = [p["id"] for p in a.ok("GET", f"/api/projects/{a_pid}/participants")["participants"]
               if p["identifier"] == "P02"]
        assert len(p02) == 1
        a.ok("POST", f"/api/projects/{a_pid}/participants/{p02[0]}/withdraw")
        (quote,) = a.rows("SELECT e.id FROM excerpt e WHERE e.segment_id = :s", s=segs[1]["id"])
        a.ok("DELETE", f"/api/projects/{a_pid}/excerpts/{quote[0]}")
        a.ok("POST", f"/api/projects/{a_pid}/excerpts", json={"segment_id": segs[1]["id"]})

        r = _ui_merge(a, _export(b, bpid), name_only="create")
        assert r.status_code == 200, r.text
        report = r.json()["merge_report"]
        # TWO people. The colleague's coding of her turn is KEPT, as the withdrawal keeps
        # codings (`withdrawal_redaction.py`'s table: the researcher's analysis).
        assert _codings_by_coder(a, a_pid) == {"Researcher": 2, "Researcher (2)": 4}
        assert a.ok("GET", f"/api/projects/{a_pid}/code-analysis/irr")["available"] is True
        assert report["withdrawn_participants_skipped"] == 1
        assert a.rows("SELECT COUNT(*) FROM participants WHERE identifier = 'P02'")[0][0] == 0
        assert a.rows("SELECT text FROM segments WHERE id = :s", s=segs[5]["id"]) == [(BLANKED_SEGMENT_TEXT,)]
        assert a.rows("SELECT COUNT(*) FROM excerpt WHERE segment_id = :s", s=segs[5]["id"])[0][0] == 0
        assert a.rows("SELECT COUNT(*) FROM excerpt WHERE segment_id = :s", s=segs[1]["id"])[0][0] == 1
        # …and the colleague's other quote and note arrived.
        assert a.rows("SELECT COUNT(*) FROM excerpt WHERE segment_id = :s", s=segs[4]["id"])[0][0] == 1
        assert a.rows("SELECT COUNT(*) FROM notes WHERE conversation_id = :c", c=a_cid)[0][0] == 1
