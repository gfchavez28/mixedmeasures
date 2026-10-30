"""#1352 / #1246 — who the coders are across a colleague's coding-copy round trip.

Two INSTALLS are two independent in-memory databases, each provisioned as a fresh
install is (`ensure_default_user` → "Researcher"), so both first coders share the name
every install ships with — the case a single-database test cannot reach (one database
holds one "Researcher").

The colleague takes a CODING COPY of the lead's project, codes it, exports it; the lead
MERGES it back. Each test states the WANTED outcome; on 2fe78dc7 the starred ones fail.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.auth import ensure_default_user
from app.database import Base
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.irr import compute_irr
from app.services.project_portability import (
    build_merge_coder_preview,
    export_project,
    import_project,
)


# ── Two installs ─────────────────────────────────────────────────────────────────

def _install():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(eng, "connect")
    def _fk(dbapi_conn, _rec):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(bind=eng)
    return sessionmaker(bind=eng, autoflush=False, autocommit=False)()


def _export(db, pid, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(export_project(db, pid, path.parent / "docs").getvalue())
    return path


def _apply(db, seg_uuid, code_name, user_id, pid) -> bool:
    """The workbench's apply: a no-op when this coder already holds the code here."""
    seg = db.query(Segment).filter(Segment.uuid == seg_uuid).one()
    code = db.query(Code).filter(Code.project_id == pid, Code.name == code_name).one()
    held = db.query(CodeApplication).filter_by(segment_id=seg.id, code_id=code.id, user_id=user_id).first()
    if held is None:
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=user_id, origin="human"))
        db.flush()
    return held is None


def _codings(db, pid) -> dict[tuple[str, str], list[str]]:
    """{(segment uuid, coder name): sorted [code name]} — every human coding."""
    rows = (
        db.query(Segment.uuid, User.username, Code.name)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(User, User.id == CodeApplication.user_id)
        .join(Code, Code.id == CodeApplication.code_id)
        .join(Conversation, Conversation.id == Segment.conversation_id)
        .filter(Conversation.project_id == pid, CodeApplication.origin == "human")
        .all()
    )
    out: dict[tuple[str, str], list[str]] = {}
    for su, coder, code in rows:
        out.setdefault((su, coder), []).append(code)
    return {k: sorted(v) for k, v in out.items()}


def _lead(tmp: Path, *, local_colleague: str | None = None, lead_codes: bool = True):
    """Install A: the lead's default coder codes S1 with Alpha (unless `lead_codes` is
    False — then the file carries no coder of the lead's at all), then exports."""
    A = _install()
    lead = ensure_default_user(A)
    if local_colleague:
        # Someone ELSE on the lead's install who happens to share the colleague's name.
        A.add(User(username=local_colleague, password_hash=None, coder_type="human"))
        A.flush()
    p = Project(name="Team study", status="active", user_id=lead.id)
    A.add(p)
    A.flush()
    conv = Conversation(project_id=p.id, name="Interview 1", status="completed")
    A.add(conv)
    A.flush()
    s1 = Segment(conversation_id=conv.id, sequence_order=0, text="first turn")
    s2 = Segment(conversation_id=conv.id, sequence_order=1, text="second turn")
    A.add_all([s1, s2])
    A.flush()
    A.add_all([
        Code(project_id=p.id, numeric_id=0, name="Alpha", is_active=True),
        Code(project_id=p.id, numeric_id=1, name="Beta", is_active=True),
    ])
    A.flush()
    if lead_codes:
        _apply(A, s1.uuid, "Alpha", lead.id, p.id)
    A.commit()
    return A, lead, p, s1.uuid, s2.uuid, _export(A, p.id, tmp / "lead" / "team.mmproject")


def _colleague(tmp: Path, f: Path, *, rename_default_to: str | None = None):
    """Install B: a fresh install, which imports the lead's file as a CODING COPY."""
    B = _install()
    me = ensure_default_user(B)
    if rename_default_to:
        me.username = rename_default_to
        B.commit()
    pid, _ = import_project(B, f, tmp / "b-docs", user_id=me.id, import_mode="copy_for_coding")
    B.commit()
    return B, me, pid


def _round_trip(tmp, *, rename_default_to=None, local_colleague=None, colleague_codes=(),
                lead_codes=True):
    A, lead, p, s1, s2, f = _lead(tmp, local_colleague=local_colleague, lead_codes=lead_codes)
    B, me, bpid = _colleague(tmp, f, rename_default_to=rename_default_to)
    segs = {"S1": s1, "S2": s2}
    for seg, code in colleague_codes:
        _apply(B, segs[seg], code, me.id, bpid)
    B.commit()
    return A, lead, p, s1, s2, _export(B, bpid, tmp / "colleague" / "copy.mmproject")


def _confirm_step_defaults(preview) -> tuple[dict, list[str]]:
    """What the confirm step starts with — `lib/merge-coder-mapping.ts::defaultDecision`
    as the fix specifies it: the SAME coder (identity) is pre-selected; a coder who only
    shares a NAME starts unanswered (#1193's rule). Returns (decisions, unanswered names)."""
    decisions, unanswered = {}, []
    for c in preview:
        m = c["local_match"]
        if m and m.get("basis") == "identity":
            decisions[str(c["original_id"])] = {"action": "match", "target_user_id": m["id"]}
        elif m:
            unanswered.append(c["username"])
        else:
            decisions[str(c["original_id"])] = {"action": "create"}
    return decisions, unanswered


def _merge(A, lead, p, fb, tmp, mapping):
    report: dict = {}
    import_project(A, fb, tmp / "a-docs", user_id=lead.id, import_mode="merge",
                   target_project_id=p.id, coder_mapping=mapping, report=report)
    A.commit()
    return report


# ── 1. The coding copy, on the colleague's install ─────────────────────────────────

def test_the_leads_coding_does_not_land_on_the_colleagues_own_coder(tmp_path):  # ★
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B, me, bpid = _colleague(tmp_path, f)
    owners = {
        a.user_id for a in B.query(CodeApplication).join(Segment).filter(Segment.uuid == s1)
    }
    assert me.id not in owners
    lead_here = B.query(User).filter(User.id.in_(owners)).one()
    assert lead_here.uuid == lead.uuid          # the lead, recognisable on the way back
    assert lead_here.username == "Researcher (2)"


def test_the_colleague_can_code_a_passage_the_lead_coded(tmp_path):  # ★
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B, me, bpid = _colleague(tmp_path, f)
    assert _apply(B, s1, "Alpha", me.id, bpid), "the colleague's own Alpha is a coding of theirs"


def test_the_copy_does_not_become_the_colleagues_default_identity(tmp_path):
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B, me, bpid = _colleague(tmp_path, f)
    assert ensure_default_user(B).id == me.id


# ── 2. The round trip, merged back on the lead's install ───────────────────────────

def test_the_merge_back_brings_two_people_and_each_keeps_only_their_own(tmp_path):  # ★
    # The colleague DISAGREES on S1 (Beta, not Alpha) and codes S2.
    A, lead, p, s1, s2, fb = _round_trip(
        tmp_path, colleague_codes=[("S1", "Beta"), ("S2", "Beta")],
    )
    decisions, unanswered = _confirm_step_defaults(build_merge_coder_preview(A, fb))
    # The colleague shares the lead's name, so the step asks; the researcher answers
    # *Add as new coder* — the same answer #1193's card leads to.
    assert unanswered == ["Researcher"]
    preview = build_merge_coder_preview(A, fb)
    for c in preview:
        if c["username"] in unanswered:
            decisions[str(c["original_id"])] = {"action": "create"}
    _merge(A, lead, p, fb, tmp_path, decisions)
    got = _codings(A, p.id)
    colleague = [u.username for u in A.query(User).filter(User.id != lead.id, User.coder_type == "human")]
    assert colleague == ["Researcher (2)"]      # not "(3)": the lead's own name is not reserved
    assert got == {
        (s1, "Researcher"): ["Alpha"],
        (s1, "Researcher (2)"): ["Beta"],        # the lead's Alpha did NOT come back as theirs
        (s2, "Researcher (2)"): ["Beta"],
    }


def test_a_merge_with_no_decisions_still_keeps_two_people_apart(tmp_path):  # ★
    """The API's silent path (no `coder_mapping`): two known, different identities are
    two coders (D5)."""
    A, lead, p, s1, s2, fb = _round_trip(tmp_path, colleague_codes=[("S2", "Beta")])
    report = _merge(A, lead, p, fb, tmp_path, None)
    got = _codings(A, p.id)
    assert got == {(s1, "Researcher"): ["Alpha"], (s2, "Researcher (2)"): ["Beta"]}
    assert (report["coders_matched"], report["coders_created"]) == (1, 1)
    assert compute_irr(A, p.id)["n_coders"] == 2


def test_a_merge_with_no_decisions_keeps_a_namesake_apart_with_no_lead_in_the_file(tmp_path):
    """D5 on its own. Above, the lead's file coder claims the lead by identity, which
    already keeps the colleague off them (the claimed-coder rule). Here the lead coded
    nothing before sending the copy, so the file's only coder is the colleague — named
    "Researcher", the lead's name, with an identity of their own — and only D5 stands
    between them and the lead."""
    A, lead, p, s1, s2, fb = _round_trip(tmp_path, colleague_codes=[("S2", "Beta")], lead_codes=False)
    report = _merge(A, lead, p, fb, tmp_path, None)
    assert _codings(A, p.id) == {(s2, "Researcher (2)"): ["Beta"]}
    assert (report["coders_matched"], report["coders_created"]) == (0, 1)


def test_no_agreement_is_manufactured_from_the_leads_own_coding(tmp_path):  # ★
    """The colleague coded only S2. On HEAD the lead's S1 Alpha came back as the
    colleague's, and κ for Alpha read 1.0 — an agreement nobody made."""
    A, lead, p, s1, s2, fb = _round_trip(tmp_path, colleague_codes=[("S2", "Beta")])
    decisions, unanswered = _confirm_step_defaults(build_merge_coder_preview(A, fb))
    for c in build_merge_coder_preview(A, fb):
        if c["username"] in unanswered:
            decisions[str(c["original_id"])] = {"action": "create"}
    _merge(A, lead, p, fb, tmp_path, decisions)
    alpha = [c for c in compute_irr(A, p.id)["per_code"] if c["code_name"] == "Alpha"]
    assert not alpha or alpha[0]["cohens_kappa"] != 1.0
    assert (s1, "Researcher (2)") not in _codings(A, p.id)


def test_CONTROL_a_colleague_who_renamed_first_round_trips(tmp_path):
    """Passes on HEAD and must keep passing: names that differ were never the problem."""
    A, lead, p, s1, s2, fb = _round_trip(
        tmp_path, rename_default_to="Bob", colleague_codes=[("S1", "Alpha"), ("S2", "Beta")],
    )
    # R3's mapping (any proposed match taken) — the same on HEAD and after the fix.
    decisions = {
        str(c["original_id"]): (
            {"action": "match", "target_user_id": c["local_match"]["id"]} if c["local_match"]
            else {"action": "create"}
        )
        for c in build_merge_coder_preview(A, fb)
    }
    _merge(A, lead, p, fb, tmp_path, decisions)
    assert _codings(A, p.id) == {
        (s1, "Researcher"): ["Alpha"], (s1, "Bob"): ["Alpha"], (s2, "Bob"): ["Beta"],
    }


# ── 3. #1246 — the second merge of the same file ───────────────────────────────────

def test_a_second_merge_proposes_the_coder_the_first_one_created(tmp_path):  # ★
    """The 10-15e F3 shape: a local "Bob" is someone else, so the file's Bob was added
    as "Bob (2)". Merging the file again must propose Bob (2) — who holds the file's
    codings — never the local Bob."""
    A, lead, p, s1, s2, fb = _round_trip(
        tmp_path, rename_default_to="Bob", local_colleague="Bob",
        colleague_codes=[("S2", "Beta")],
    )
    first = build_merge_coder_preview(A, fb)
    mapping = {
        str(c["original_id"]): (
            {"action": "create"} if c["username"] == "Bob"
            else {"action": "match", "target_user_id": lead.id}
        )
        for c in first
    }
    _merge(A, lead, p, fb, tmp_path, mapping)
    bob2 = A.query(User).filter(User.username == "Bob (2)").one()

    second = {c["username"]: c for c in build_merge_coder_preview(A, fb)}
    assert second["Bob"]["local_match"]["id"] == bob2.id
    assert second["Bob"]["local_match"]["basis"] == "identity"
    decisions, unanswered = _confirm_step_defaults(list(second.values()))
    assert unanswered == []
    _merge(A, lead, p, fb, tmp_path, decisions)
    assert sorted(u.username for u in A.query(User).filter(User.coder_type == "human")) == [
        "Bob", "Bob (2)", "Researcher",
    ]
    assert _codings(A, p.id) == {(s1, "Researcher"): ["Alpha"], (s2, "Bob (2)"): ["Beta"]}


def test_the_confirm_step_is_told_the_name_a_new_coder_will_get(tmp_path):  # ★
    """#1246 F3: *Add as new coder* pre-filled "Bob" with no note while a local Bob held
    the name, and the server wrote "Bob (2)"."""
    A, lead, p, s1, s2, fb = _round_trip(
        tmp_path, rename_default_to="Bob", local_colleague="Bob", colleague_codes=[("S2", "Beta")],
    )
    by_name = {c["username"]: c for c in build_merge_coder_preview(A, fb)}
    assert by_name["Bob"].get("create_username") == "Bob (2)"


def test_an_explicit_create_over_the_same_coder_is_a_new_identity(tmp_path):
    """D7: *Add as new coder* is honoured even for a coder recognised by identity (the
    one way to separate two people a cloned database made one). The second coder gets an
    identity of its own — never NULL, never the first one's — so a THIRD merge proposes
    the first."""
    A, lead, p, s1, s2, fb = _round_trip(tmp_path, rename_default_to="Bob", colleague_codes=[("S2", "Beta")])
    mapping = {
        str(c["original_id"]): {"action": "create"} if c["username"] == "Bob"
        else {"action": "match", "target_user_id": lead.id}
        for c in build_merge_coder_preview(A, fb)
    }
    for _ in range(2):
        _merge(A, lead, p, fb, tmp_path, mapping)
    bobs = A.query(User).filter(User.username.like("Bob%")).order_by(User.id).all()
    assert [b.username for b in bobs] == ["Bob", "Bob (2)"]
    assert bobs[1].uuid and len(bobs[1].uuid) == 36
    assert bobs[0].uuid != bobs[1].uuid
    third = {c["username"]: c for c in build_merge_coder_preview(A, fb)}
    assert third["Bob"]["local_match"]["id"] == bobs[0].id


# ── 4. The doors that keep today's name rule ──────────────────────────────────────

def test_import_as_new_on_another_install_keeps_the_name_rule(tmp_path):
    """D6: a researcher moving their own project to a second machine as an independent
    project lands on their own "Researcher" there, as today. (The supervisor case — a
    colleague's project imported as NEW — is the recorded follow-up, not this batch.)"""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B = _install()
    me = ensure_default_user(B)
    bpid, _ = import_project(B, f, tmp_path / "b-docs", user_id=me.id, import_mode="new")
    B.commit()
    assert B.query(User).count() == 1
    assert {a.user_id for a in B.query(CodeApplication)} == {me.id}


def test_duplicate_on_the_same_install_lands_on_the_same_coder(tmp_path):
    """Duplicate Project is export + import-as-new on ONE install: the identity matches."""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    new_id, _ = import_project(A, f, tmp_path / "a-docs", user_id=lead.id, import_mode="new")
    A.commit()
    assert A.query(User).count() == 1
    assert {a.user_id for a in A.query(CodeApplication)} == {lead.id}


def test_two_file_coders_with_one_identity_are_refused(tmp_path):
    import json
    import zipfile
    A, lead, p, s1, s2, f = _round_trip(tmp_path, rename_default_to="Bob", colleague_codes=[("S2", "Beta")])
    forged = tmp_path / "forged.mmproject"
    with zipfile.ZipFile(f) as zin, zipfile.ZipFile(forged, "w") as zout:
        for name in zin.namelist():
            body = zin.read(name)
            if name == "project.json":
                doc = json.loads(body)
                doc["coders"][1]["uuid"] = doc["coders"][0]["uuid"]
                body = json.dumps(doc).encode()
            zout.writestr(name, body)
    with pytest.raises(ValueError, match="as the same coder"):
        _merge(A, lead, p, forged, tmp_path, None)


def test_a_coding_copy_keeps_the_unattributed_bucket_one_bucket(tmp_path):
    """The never-by-name rule is for PEOPLE (and models). "Unattributed" is a system
    bucket: a copy lands its legacy codings on the local one, as before."""
    A, lead, p, s1, s2, _ = _lead(tmp_path)
    un = User(username="Unattributed", password_hash=None, coder_type="unattributed")
    A.add(un)
    A.flush()
    seg = A.query(Segment).filter(Segment.uuid == s2).one()
    beta = A.query(Code).filter(Code.project_id == p.id, Code.name == "Beta").one()
    A.add(CodeApplication(segment_id=seg.id, code_id=beta.id, user_id=un.id, origin="human"))
    A.commit()
    f = _export(A, p.id, tmp_path / "lead" / "with-legacy.mmproject")
    B = _install()
    me = ensure_default_user(B)
    B.add(User(username="Unattributed", password_hash=None, coder_type="unattributed"))
    B.commit()
    import_project(B, f, tmp_path / "b-docs", user_id=me.id, import_mode="copy_for_coding")
    B.commit()
    assert B.query(User).filter(User.coder_type == "unattributed").count() == 1


def test_an_identity_is_not_trusted_across_a_changed_configuration(tmp_path):
    """A model's configuration IS its identity (#1034): the same `uuid` on a coder now run
    with another configuration is not the coder the file's codings were made by. Reached
    for real: the model's codings deleted (which unlocks it), then it is reconfigured."""
    from app.services import machine_coder
    A, lead, p, s1, s2, _ = _lead(tmp_path)
    gpt = User(username="GPT", password_hash=None, coder_type="ai")
    machine_coder.write_provenance(gpt, machine_coder.normalize_provenance({"model": "gpt-4o"}))
    A.add(gpt)
    A.flush()
    _apply(A, s2, "Beta", gpt.id, p.id)
    A.commit()
    f = _export(A, p.id, tmp_path / "lead" / "with-model.mmproject")
    A.query(CodeApplication).filter(CodeApplication.user_id == gpt.id).delete()
    machine_coder.write_provenance(gpt, machine_coder.normalize_provenance({"model": "gpt-4.1"}))
    A.commit()
    by_name = {c["username"]: c for c in build_merge_coder_preview(A, f)}
    assert by_name["GPT"]["local_match"] is None
    _merge(A, lead, p, f, tmp_path, None)
    holder = (
        A.query(User).join(CodeApplication, CodeApplication.user_id == User.id)
        .filter(User.coder_type == "ai").one()
    )
    assert holder.id != gpt.id and holder.username == "GPT (2)"


# ── 5. D2 — the coding copy asks which of the file's people is you ─────────────────
#
# The contract (BUILD_BRIEF, D2): the import dialog sends AT MOST ONE `coder_mapping`
# entry — the file person the researcher chose as themselves → `match` onto the active
# coder. "None of them" sends no mapping. Every file coder without an entry takes the
# no-answer rule: identity first, then — in a coding copy — never by name.

def _team_file(tmp: Path, *, with_model: bool = False):
    """Install A: the lead codes S1 (Alpha), a second person "Ana" codes S2 (Beta), and
    optionally a model "GPT" codes S2 (Alpha). Exported."""
    from app.services import machine_coder
    A = _install()
    lead = ensure_default_user(A)
    ana = User(username="Ana", password_hash=None, coder_type="human")
    A.add(ana)
    p = Project(name="Team study", status="active", user_id=lead.id)
    A.add(p)
    A.flush()
    conv = Conversation(project_id=p.id, name="Interview 1", status="completed")
    A.add(conv)
    A.flush()
    s1 = Segment(conversation_id=conv.id, sequence_order=0, text="first turn")
    s2 = Segment(conversation_id=conv.id, sequence_order=1, text="second turn")
    A.add_all([s1, s2])
    A.add_all([
        Code(project_id=p.id, numeric_id=0, name="Alpha", is_active=True),
        Code(project_id=p.id, numeric_id=1, name="Beta", is_active=True),
    ])
    A.flush()
    _apply(A, s1.uuid, "Alpha", lead.id, p.id)
    _apply(A, s2.uuid, "Beta", ana.id, p.id)
    if with_model:
        gpt = User(username="GPT", password_hash=None, coder_type="ai")
        machine_coder.write_provenance(gpt, machine_coder.normalize_provenance({"model": "gpt-4o"}))
        A.add(gpt)
        A.flush()
        _apply(A, s2.uuid, "Alpha", gpt.id, p.id)
    A.commit()
    return A, lead, ana, p, s1.uuid, s2.uuid, _export(A, p.id, tmp / "lead" / "team.mmproject")


def _oid(B, f: Path, username: str) -> int:
    """The file coder's id as the import dialog reads it: validate's `file_coders` is
    `build_merge_coder_preview` (`routers/project_portability.py`)."""
    return next(c["original_id"] for c in build_merge_coder_preview(B, f) if c["username"] == username)


def _copy(B, me, f: Path, tmp: Path, mapping: dict | None) -> int:
    pid, _ = import_project(B, f, tmp / "b-docs", user_id=me.id,
                            import_mode="copy_for_coding", coder_mapping=mapping)
    B.commit()
    return pid


def _humans(db) -> list[str]:
    return sorted(u.username for u in db.query(User).filter(User.coder_type == "human"))


def test_moving_my_own_project_to_a_fresh_install_and_choosing_myself_is_one_person(tmp_path):
    """The case that made D2 a question: r1's default (keep the identity) and r2's rule
    (never by name) together split a researcher moving their OWN project into
    "Researcher" and "Researcher (2)". The fresh install's first coder is a different
    identity with the same name, so the dialog asks; they choose themselves."""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B = _install()
    me = ensure_default_user(B)
    row = next(c for c in build_merge_coder_preview(B, f) if c["username"] == "Researcher")
    assert row["local_match"]["basis"] == "name"            # so the question is asked
    pid = _copy(B, me, f, tmp_path, {str(row["original_id"]): {
        "action": "match", "target_user_id": me.id}})
    assert _humans(B) == ["Researcher"]
    assert B.query(User).count() == 1
    assert _codings(B, pid) == {(s1, "Researcher"): ["Alpha"]}
    assert {a.user_id for a in B.query(CodeApplication)} == {me.id}


def test_none_of_them_makes_every_file_person_a_new_coder_numbered_if_taken(tmp_path):
    """"None of them" sends no mapping. Nobody lands by name — not the lead on my
    "Researcher", not the file's Ana on a DIFFERENT Ana who happens to be here."""
    A, lead, ana, p, s1, s2, f = _team_file(tmp_path)
    B = _install()
    me = ensure_default_user(B)
    local_ana = User(username="Ana", password_hash=None, coder_type="human")
    B.add(local_ana)
    B.commit()
    pid = _copy(B, me, f, tmp_path, None)
    assert _humans(B) == ["Ana", "Ana (2)", "Researcher", "Researcher (2)"]
    assert _codings(B, pid) == {(s1, "Researcher (2)"): ["Alpha"], (s2, "Ana (2)"): ["Beta"]}
    owners = {a.user_id for a in B.query(CodeApplication)}
    assert me.id not in owners and local_ana.id not in owners
    # Each new coder IS the file's person, recognisable on the way back.
    assert B.query(User).filter(User.username == "Ana (2)").one().uuid == ana.uuid
    assert B.query(User).filter(User.username == "Researcher (2)").one().uuid == lead.uuid


def test_one_answer_covers_one_person_and_the_rest_take_the_no_answer_rule(tmp_path):
    """"Researcher is me": that person's codings land on me; Ana has no entry and takes
    the no-answer rule — a new coder, numbered because a different Ana is here."""
    A, lead, ana, p, s1, s2, f = _team_file(tmp_path)
    B = _install()
    me = ensure_default_user(B)
    B.add(User(username="Ana", password_hash=None, coder_type="human"))
    B.commit()
    pid = _copy(B, me, f, tmp_path, {str(_oid(B, f, "Researcher")): {
        "action": "match", "target_user_id": me.id}})
    assert _humans(B) == ["Ana", "Ana (2)", "Researcher"]
    assert _codings(B, pid) == {(s1, "Researcher"): ["Alpha"], (s2, "Ana (2)"): ["Beta"]}


def test_a_coder_matched_by_identity_needs_no_answer(tmp_path):
    """The lead sends the colleague a SECOND project. The lead already arrived on this
    install with the first copy, so the preview says so (`basis: identity` — the dialog
    does not ask about them) and the import lands them there with no mapping at all."""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B, me, first_pid = _colleague(tmp_path, f)
    lead_here = B.query(User).filter(User.uuid == lead.uuid).one()
    assert lead_here.username == "Researcher (2)"

    p2 = Project(name="Second study", status="active", user_id=lead.id)
    A.add(p2)
    A.flush()
    conv = Conversation(project_id=p2.id, name="Interview 9", status="completed")
    A.add(conv)
    A.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text="another turn")
    A.add(seg)
    A.add(Code(project_id=p2.id, numeric_id=0, name="Gamma", is_active=True))
    A.flush()
    _apply(A, seg.uuid, "Gamma", lead.id, p2.id)
    A.commit()
    f2 = _export(A, p2.id, tmp_path / "lead" / "second.mmproject")

    row = next(c for c in build_merge_coder_preview(B, f2) if c["username"] == "Researcher")
    assert row["local_match"] == {
        "id": lead_here.id, "username": "Researcher (2)", "archived": False,
        "local_app_count": 1, "basis": "identity",
    }
    pid2 = _copy(B, me, f2, tmp_path, None)
    assert _humans(B) == ["Researcher", "Researcher (2)"]          # nobody new
    assert _codings(B, pid2) == {(seg.uuid, "Researcher (2)"): ["Gamma"]}


def test_my_own_export_comes_back_to_me_by_identity(tmp_path):
    """The dialog's other skip: a file coder whose `local_match` is `{basis: identity,
    id: <the active coder>}` — you are already identified. A researcher re-imports their
    own export after deleting the project: no question, and no second "Researcher"."""
    from app.services.project_deletion import delete_project_tree
    A, lead, p, s1, s2, f = _lead(tmp_path)
    delete_project_tree(A, p)
    A.commit()
    row = next(c for c in build_merge_coder_preview(A, f) if c["username"] == "Researcher")
    assert (row["local_match"]["basis"], row["local_match"]["id"]) == ("identity", lead.id)
    pid = _copy(A, lead, f, tmp_path, None)
    assert _humans(A) == ["Researcher"]
    assert _codings(A, pid) == {(s1, "Researcher"): ["Alpha"]}


@pytest.mark.parametrize("file_coder, local_kind", [
    ("GPT", "human"),         # a file MODEL answered as me, a person
    ("Researcher", "ai"),     # a file PERSON answered as a local model
])
def test_an_ineligible_match_is_refused_before_anything_is_written(
    tmp_path, monkeypatch, file_coder, local_kind,
):
    """The dialog lists only people, so this is a script or a stale screen — and the
    net is `_preflight_import_refusals` (#1150 a), the same predicate as the merge's
    (#1034): it raises before a project, a coder or a file is written."""
    from app.services import machine_coder
    from app.services import project_portability as pp
    A, lead, ana, p, s1, s2, f = _team_file(tmp_path, with_model=True)
    B = _install()
    me = ensure_default_user(B)
    target = me
    if local_kind == "ai":
        target = User(username="Local model", password_hash=None, coder_type="ai")
        machine_coder.write_provenance(target, machine_coder.normalize_provenance({"model": "gpt-4o"}))
        B.add(target)
    B.commit()
    users_before = B.query(User).count()

    refused_in_preflight: list[str] = []
    real = pp._preflight_import_refusals

    def spy(*args, **kwargs):
        try:
            return real(*args, **kwargs)
        except ValueError as exc:
            refused_in_preflight.append(str(exc))
            raise

    monkeypatch.setattr(pp, "_preflight_import_refusals", spy)
    staged: list[int] = []
    monkeypatch.setattr(pp, "_stage_archive_files", lambda *a, **k: staged.append(1))
    with pytest.raises(ValueError, match="cannot stand in for the other"):
        import_project(B, f, tmp_path / "b-docs", user_id=me.id, import_mode="copy_for_coding",
                       coder_mapping={str(_oid(B, f, file_coder)): {
                           "action": "match", "target_user_id": target.id}})
    assert len(refused_in_preflight) == 1
    assert staged == []
    # Nothing written, not even flushed into this session.
    assert B.query(Project).count() == 0
    assert B.query(User).count() == users_before
    assert not (tmp_path / "b-docs").exists() or not any((tmp_path / "b-docs").iterdir())


def _as_an_older_build_wrote_it(f: Path, out: Path) -> Path:
    """A 1.5.7 export: no coder `uuid` (D10: it rides v7 with no bump), in the document
    the import reads AND the one the preview reads."""
    import json
    import zipfile
    with zipfile.ZipFile(f) as zin, zipfile.ZipFile(out, "w") as zout:
        for name in zin.namelist():
            body = zin.read(name)
            if name in ("project.json", "merge_preview.json"):
                doc = json.loads(body)
                for c in doc.get("coders", []):
                    c.pop("uuid", None)
                body = json.dumps(doc).encode()
            zout.writestr(name, body)
    return out


def test_an_older_builds_file_imported_as_new_mints_an_identity(tmp_path):
    """A coder created from a file with no identity gets one of its own — never a NULL
    that every later import would treat as "no identity". (`new`, D6's door: a coding
    copy no longer creates such a coder, #1469.)"""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    old = _as_an_older_build_wrote_it(f, tmp_path / "old.mmproject")
    B = _install()
    me = ensure_default_user(B)
    me.username = "Bob"           # so D6's name rule does not land the lead on me
    B.commit()
    import_project(B, old, tmp_path / "b-docs", user_id=me.id, import_mode="new")
    B.commit()
    lead_here = B.query(User).filter(User.username == "Researcher").one()
    assert lead_here.uuid and lead_here.uuid not in (lead.uuid, me.uuid)


# ── 5b. #1469 — a coding copy of an older build's file ──────────────────────────────

def test_a_coding_copy_of_an_older_builds_file_is_refused_when_nobody_is_answered(
    tmp_path, monkeypatch,
):
    """The colleague's install on 1.5.8, the lead's file from 1.5.7, "None of them".
    The copy would mint the lead an identity the lead's install has never seen, rename
    them "Researcher (2)", and the merge back would count the lead's codings twice
    (the audit's F1 probe: α 0.375 "unreliable" between the lead and themselves).
    Refused in the pre-flight (#1150 a) — before a file is staged or a row written —
    with the way out."""
    from app.services import project_portability as pp
    A, lead, p, s1, s2, f = _lead(tmp_path)
    old = _as_an_older_build_wrote_it(f, tmp_path / "old.mmproject")
    B = _install()
    me = ensure_default_user(B)
    B.commit()
    staged: list[int] = []
    monkeypatch.setattr(pp, "_stage_archive_files", lambda *a, **k: staged.append(1))
    with pytest.raises(ValueError, match="did not record who its coders are") as exc:
        _copy(B, me, old, tmp_path, None)
    assert "“Researcher”" in str(exc.value)
    assert "independent project" in str(exc.value)
    assert staged == []
    B.rollback()
    assert B.query(Project).count() == 0
    assert _humans(B) == ["Researcher"]


def test_the_remedy_an_updated_export_round_trips_with_one_lead(tmp_path):
    """The sentence's way out: the lead updates and exports again — the file carries
    their identity, and the merge back holds the lead once (the F1 probe's assertion)."""
    A, lead, p, s1, s2, fb = _round_trip(tmp_path, colleague_codes=[("S2", "Beta")])
    decisions, unanswered = _confirm_step_defaults(build_merge_coder_preview(A, fb))
    for c in build_merge_coder_preview(A, fb):
        if c["username"] in unanswered:
            decisions[str(c["original_id"])] = {"action": "create"}
    _merge(A, lead, p, fb, tmp_path, decisions)
    got = _codings(A, p.id)
    assert [k for k in got if k[0] == s1] == [(s1, "Researcher")]


def test_CONTROL_answering_this_one_is_me_still_imports_an_older_builds_file(tmp_path):
    """A researcher moving their OWN 1.5.7 project to a new install answers D2 with
    themselves: nothing is minted for that coder, so nothing is refused. (Kills the
    mutant that drops the answered-match exemption.)"""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    old = _as_an_older_build_wrote_it(f, tmp_path / "old.mmproject")
    B = _install()
    me = ensure_default_user(B)
    B.commit()
    pid = _copy(B, me, old, tmp_path, {str(_oid(B, old, "Researcher")): {
        "action": "match", "target_user_id": me.id}})
    assert _humans(B) == ["Researcher"]
    assert _codings(B, pid) == {(s1, "Researcher"): ["Alpha"]}


def test_CONTROL_the_unattributed_bucket_of_an_older_builds_file_is_not_refused(tmp_path):
    """"Unattributed" is a system bucket, not a person a copy mints: an older file holding
    one, with its one person answered, imports. (Kills the mutant that drops the
    system-kind exemption.)"""
    A, lead, p, s1, s2, _ = _lead(tmp_path)
    un = User(username="Unattributed", password_hash=None, coder_type="unattributed")
    A.add(un)
    A.flush()
    seg = A.query(Segment).filter(Segment.uuid == s2).one()
    beta = A.query(Code).filter(Code.project_id == p.id, Code.name == "Beta").one()
    A.add(CodeApplication(segment_id=seg.id, code_id=beta.id, user_id=un.id, origin="human"))
    A.commit()
    f = _export(A, p.id, tmp_path / "lead" / "with-legacy.mmproject")
    old = _as_an_older_build_wrote_it(f, tmp_path / "old.mmproject")
    B = _install()
    me = ensure_default_user(B)
    B.commit()
    _copy(B, me, old, tmp_path, {str(_oid(B, old, "Researcher")): {
        "action": "match", "target_user_id": me.id}})
    assert B.query(User).filter(User.coder_type == "unattributed").count() == 1


# ── 6. D6 — "Import as an independent project" and overwrite keep today's name rule ──

def test_overwrite_keeps_the_name_rule(tmp_path):
    """D6: overwrite is a door for moving your own project — a file coder with a
    different identity and the same name lands on the local coder, as before."""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B = _install()
    me = ensure_default_user(B)
    bpid, _ = import_project(B, f, tmp_path / "b-docs", user_id=me.id, import_mode="copy_for_coding",
                             coder_mapping={str(_oid(B, f, "Researcher")): {
                                 "action": "match", "target_user_id": me.id}})
    B.commit()
    _apply(A, s2, "Beta", lead.id, p.id)
    A.commit()
    newer = _export(A, p.id, tmp_path / "lead" / "newer.mmproject")
    import_project(B, newer, tmp_path / "b-docs", user_id=me.id, import_mode="overwrite",
                   target_project_id=bpid)
    B.commit()
    assert _humans(B) == ["Researcher"]
    assert {a.user_id for a in B.query(CodeApplication)} == {me.id}


def test_import_as_new_creates_a_coder_with_the_files_identity(tmp_path):
    """`new` never fresh-stamps a coder (it fresh-stamps the PROJECT's entities): a
    coder it creates is the file's person, so a later merge recognises them."""
    A, lead, p, s1, s2, f = _lead(tmp_path)
    B = _install()
    me = ensure_default_user(B)
    me.username = "Bob"
    B.commit()
    import_project(B, f, tmp_path / "b-docs", user_id=me.id, import_mode="new")
    B.commit()
    assert B.query(User).filter(User.username == "Researcher").one().uuid == lead.uuid


def test_a_coder_claimed_by_identity_is_not_also_landed_on_by_name(tmp_path):
    """The colleague's file comes back as an INDEPENDENT project (D6's door). The lead's
    own file coder ("Researcher (2)" on the colleague's install) is the lead by identity;
    the colleague is named "Researcher" — the lead's name — and the name rule would land
    them on the lead TOO: two people one coder, and where both coded the same passage
    with the same code, the per-coder unique index refused the import (a 500)."""
    A, lead, p, s1, s2, fb = _round_trip(
        tmp_path, colleague_codes=[("S1", "Alpha"), ("S2", "Beta")],
    )
    new_pid, _ = import_project(A, fb, tmp_path / "a-docs", user_id=lead.id, import_mode="new")
    A.commit()
    seg_uuid = {
        s.sequence_order: s.uuid for s in A.query(Segment).join(Conversation)
        .filter(Conversation.project_id == new_pid)
    }
    assert _humans(A) == ["Researcher", "Researcher (2)"]
    assert _codings(A, new_pid) == {
        (seg_uuid[0], "Researcher"): ["Alpha"],
        (seg_uuid[0], "Researcher (2)"): ["Alpha"],
        (seg_uuid[1], "Researcher (2)"): ["Beta"],
    }
