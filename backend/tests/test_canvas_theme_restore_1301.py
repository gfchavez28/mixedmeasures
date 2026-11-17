"""#1301 — undoing a canvas theme delete restores what the delete destroyed.

The undo used to re-create `{name, color}`: the writing, embeds, description, kind, place,
parent, links and nesting were lost (reproduced over HTTP, 2026-11-13g). Now the delete hands
out `theme_restore_record` and the undo sends it to `POST …/themes/restore`, one transaction.

Every case is act → (the canvas changes) → undo → READ the canvas back over HTTP, because the
property lives in what the page reads after the undo, not in what the service returned.
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import pytest
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.project import Project
from app.models.user import Session as UserSession, User
from app.services.audit import log_action


PROSE = {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "Three hours of my analysis."}]},
]}
QUOTE = {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "Before the quote."}]},
    {"type": "excerpt-embed", "attrs": {"excerptId": 7, "displayText": "WORDS OF A PERSON",
                                        "sourceContext": "Interview 3"}},
]}


@pytest.fixture(scope="module")
def http():
    Base.metadata.create_all(bind=engine)
    # The first request makes the local user (and its session) on the shared engine; a later
    # file's fixture that adds `User(id=1)` then fails UNIQUE (`test_code_application_import_
    # batching.py`, which sorts right after this file). Note who existed, remove the rest.
    db = SessionLocal()
    users_before = {uid for (uid,) in db.query(User.id)}
    db.close()
    with TestClient(app) as c:
        st = c.get("/api/auth/status").json()
        H = {"X-CSRF-Token": st["user"]["csrf_token"]}
        pid = c.post("/api/projects", json={"name": "Restore 1301"}, headers=H).json()["id"]
        yield c, H, pid
        # The app's engine is shared by every HTTP test in the run: leave nothing behind,
        # and no deletion record (`backend/tests/the internal design notes, #1546).
        from app.services.audit import forget_project_audit
        from app.services.project_deletion import delete_project_tree

        db = SessionLocal()
        delete_project_tree(db, db.get(Project, pid))
        forget_project_audit(db, pid)
        added = [uid for (uid,) in db.query(User.id) if uid not in users_before]
        if added:
            db.query(UserSession).filter(UserSession.user_id.in_(added)).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(added)).delete(synchronize_session=False)
        db.commit()
        db.close()


def _ok(r):
    assert r.status_code < 300, (r.request.method, r.request.url, r.status_code, r.text[:400])
    return r.json()


class _Canvas:
    def __init__(self, http, name):
        self.c, self.H, pid = http
        cid = _ok(self.c.post(f"/api/projects/{pid}/canvases", json={"name": name}, headers=self.H))["id"]
        self.pid, self.base = pid, f"/api/projects/{pid}/canvases/{cid}"

    def theme(self, **body):
        return _ok(self.c.post(f"{self.base}/themes", json=body, headers=self.H))

    def patch(self, tid, **body):
        return _ok(self.c.patch(f"{self.base}/themes/{tid}", json=body, headers=self.H))

    def link(self, src, tgt, **body):
        return _ok(self.c.post(f"{self.base}/theme-relationships", json={
            "source_theme_id": src, "target_theme_id": tgt, "relationship_type": "supports", **body,
        }, headers=self.H))

    def delete(self, tid):
        return self.c.delete(f"{self.base}/themes/{tid}", headers=self.H)

    def restore(self, record):
        return self.c.post(f"{self.base}/themes/restore", json=record, headers=self.H)

    def read(self):
        return _ok(self.c.get(self.base, headers=self.H))["themes"]

    def by_id(self, tid):
        return next((t for t in self.read() if t["id"] == tid), None)


FIELDS = ("name", "section_type", "description", "color", "viz_x", "viz_y", "parent_theme_id",
          "content", "searchable_text", "referenced_source_ids")


def _links(theme):
    return sorted((r["source_theme_id"], r["target_theme_id"], r["relationship_type"], r["label"],
                   r["is_bidirectional"], r["line_style"], r["line_color"])
                  for r in theme["relationships_out"] + theme["relationships_in"])


def test_the_undo_gives_back_a_nested_prose_section_whole(http):
    cv = _Canvas(http, "Whole")
    cv.theme(name="Intro", section_type="prose")
    parent = cv.theme(name="Trust", color="#10b981")
    other = cv.theme(name="Later")
    sec = cv.theme(name="Notes", section_type="prose", description="why", viz_x=12.5, viz_y=80.0,
                   parent_theme_id=parent["id"])
    cv.theme(name="Coda")  # so the section is NOT last: its place is a real position
    cv.patch(sec["id"], content=QUOTE)
    cv.link(sec["id"], other["id"], label="feeds", line_style="dashed", line_color="#123456")
    cv.link(other["id"], sec["id"], relationship_type="contradicts", is_bidirectional=True)
    before_order = [t["id"] for t in cv.read()]
    before = cv.by_id(sec["id"])

    deleted = _ok(cv.delete(sec["id"]))
    assert cv.by_id(sec["id"]) is None
    res = cv.restore(deleted["restore"])
    assert res.status_code == 201, res.text
    body = res.json()

    after = cv.by_id(body["theme"]["id"])
    assert after is not None
    assert {k: after[k] for k in FIELDS} == {k: before[k] for k in FIELDS}
    assert after["content"] == QUOTE  # the writing and the embed, not an empty shell
    assert _links(after) == _links(before)
    assert [t["id"] for t in cv.read()] == before_order  # its place
    assert body["not_restored"] == {"parent": False, "children": 0, "relationships": 0}


def test_the_undo_renests_the_children_and_keeps_the_old_id(http):
    cv = _Canvas(http, "Children")
    a = cv.theme(name="A")
    parent = cv.theme(name="Parent")
    kids = [cv.theme(name=f"Kid {i}", parent_theme_id=parent["id"]) for i in (1, 2)]
    # A later theme, so the parent's id is NOT the highest one (SQLite reuses only that).
    cv.theme(name="Z")
    cv.patch(a["id"], content={"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "mention", "attrs": {"id": str(parent["id"]), "label": "Parent"}}]}]})

    deleted = _ok(cv.delete(parent["id"]))
    assert all(cv.by_id(k["id"])["parent_theme_id"] is None for k in kids)  # the delete un-nests
    body = _ok(cv.restore(deleted["restore"]))

    # The SAME id: the `@Parent` mention in A and every history entry holding it still name it.
    assert body["theme"]["id"] == parent["id"]
    assert all(cv.by_id(k["id"])["parent_theme_id"] == parent["id"] for k in kids)
    assert body["not_restored"]["children"] == 0


def test_a_taken_id_gets_a_new_one_and_its_links_follow(http):
    cv = _Canvas(http, "Taken")
    a = cv.theme(name="A")
    b = cv.theme(name="B")
    last = cv.theme(name="Last")  # the highest id in the table
    cv.link(a["id"], last["id"])  # it is the TARGET of one link …
    cv.link(last["id"], b["id"])  # … and the SOURCE of another: both ends remap
    deleted = _ok(cv.delete(last["id"]))
    squatter = cv.theme(name="Created after the delete")
    assert squatter["id"] == last["id"], "precondition: SQLite reused the highest id"

    body = _ok(cv.restore(deleted["restore"]))
    new_id = body["theme"]["id"]
    assert new_id != last["id"]
    assert cv.by_id(squatter["id"])["name"] == "Created after the delete"  # untouched
    restored = cv.by_id(new_id)
    assert [(r["source_theme_id"], r["target_theme_id"]) for r in restored["relationships_in"]] \
        == [(a["id"], new_id)]
    assert [(r["source_theme_id"], r["target_theme_id"]) for r in restored["relationships_out"]] \
        == [(new_id, b["id"])]
    assert cv.by_id(a["id"])["relationships_out"][0]["target_theme_id"] == new_id
    assert cv.by_id(squatter["id"])["relationships_out"] == []  # nothing landed on the squatter


def test_what_the_canvas_no_longer_allows_is_reported_not_forced(http):
    cv = _Canvas(http, "Changed")
    parent = cv.theme(name="Parent")
    gone = cv.theme(name="Gone")
    sec = cv.theme(name="Sec", parent_theme_id=parent["id"])
    cv.link(sec["id"], gone["id"])
    deleted = _ok(cv.delete(sec["id"]))
    _ok(cv.delete(gone["id"]))     # its link's other end is deleted since
    _ok(cv.delete(parent["id"]))   # and so is its parent

    body = _ok(cv.restore(deleted["restore"]))
    assert body["not_restored"] == {"parent": True, "children": 0, "relationships": 1}
    back = cv.by_id(body["theme"]["id"])
    assert back["parent_theme_id"] is None and _links(back) == []

    cv2 = _Canvas(http, "Moved child")
    p = cv2.theme(name="P")
    elsewhere = cv2.theme(name="Elsewhere")
    kid = cv2.theme(name="Kid", parent_theme_id=p["id"])
    deleted = _ok(cv2.delete(p["id"]))
    cv2.patch(kid["id"], parent_theme_id=elsewhere["id"])  # the researcher re-homed it
    body = _ok(cv2.restore(deleted["restore"]))
    assert body["not_restored"]["children"] == 1
    assert cv2.by_id(kid["id"])["parent_theme_id"] == elsewhere["id"]  # left where they put it


def test_redo_then_undo_again_restores_the_same_writing(http):
    cv = _Canvas(http, "Cycle")
    t = cv.theme(name="T")
    cv.patch(t["id"], content=PROSE)
    first = _ok(cv.delete(t["id"]))
    back = _ok(cv.restore(first["restore"]))["theme"]
    second = _ok(cv.delete(back["id"]))  # redo — it hands out a fresh record
    again = _ok(cv.restore(second["restore"]))["theme"]
    assert cv.by_id(again["id"])["content"] == PROSE


def _withdrawn(pid):
    db = SessionLocal()
    log_action(db, action="withdrawn", entity_type="participant", entity_id=999, user_id=1,
               project_id=pid, details={"identifier": "P99"})
    db.commit()
    db.close()


def test_a_quote_cannot_come_back_after_a_withdrawal(http):
    """A deleted theme's record lives only in the page's history, where no withdrawal reaches."""
    cv = _Canvas(http, "Withdrawal")
    quoted = cv.theme(name="Quoted")
    cv.patch(quoted["id"], content=QUOTE)
    prose = cv.theme(name="Prose")
    cv.patch(prose["id"], content=PROSE)
    q_rec = _ok(cv.delete(quoted["id"]))["restore"]
    p_rec = _ok(cv.delete(prose["id"]))["restore"]
    _withdrawn(cv.pid)

    r = cv.restore(q_rec)
    assert r.status_code == 409, r.text
    assert r.json()["detail"].startswith("This section can no longer be brought back")
    assert all(t["name"] != "Quoted" for t in cv.read())
    # Control: a section holding no quote is exactly what the scrub would have left.
    assert cv.restore(p_rec).status_code == 201


def test_a_quote_deleted_after_the_withdrawal_comes_back(http):
    cv = _Canvas(http, "After")
    _withdrawn(cv.pid)
    t = cv.theme(name="Quoted later")
    cv.patch(t["id"], content=QUOTE)
    rec = _ok(cv.delete(t["id"]))["restore"]
    r = cv.restore(rec)
    assert r.status_code == 201, r.text
    assert cv.by_id(r.json()["theme"]["id"])["content"] == QUOTE


def test_the_gate_measures_from_THIS_delete_when_the_id_was_reused(http):
    """SQLite reuses the highest id, so "the newest delete of id N" can be a LATER theme's.

    delete A → withdrawal → create B (takes A's id) → delete B → undo (B back) → undo B's
    create (another delete of that id, logged AFTER the withdrawal) → undo A's delete: A's
    quote predates the withdrawal and must stay refused.
    """
    cv = _Canvas(http, "Reused id")
    a = cv.theme(name="A")  # the highest id in the table
    cv.patch(a["id"], content=QUOTE)
    rec_a = _ok(cv.delete(a["id"]))["restore"]
    _withdrawn(cv.pid)
    b = cv.theme(name="B")
    assert b["id"] == a["id"], "precondition: SQLite reused the highest id"
    rec_b = _ok(cv.delete(b["id"]))["restore"]
    assert _ok(cv.restore(rec_b))["theme"]["id"] == b["id"]
    _ok(cv.delete(b["id"]))  # the undo of B's create: a delete of the same id, after the withdrawal

    r = cv.restore(rec_a)
    assert r.status_code == 409, r.text
    assert all(t["name"] != "A" for t in cv.read())


def test_a_record_naming_another_entry_fails_closed(http):
    """The gate trusts `deleted_audit_id` only when it is this project's delete of this theme."""
    cv = _Canvas(http, "Foreign entry")
    t = cv.theme(name="T")
    cv.patch(t["id"], content=QUOTE)
    rec = _ok(cv.delete(t["id"]))["restore"]
    _withdrawn(cv.pid)
    assert cv.restore({**rec, "deleted_audit_id": 10**9}).status_code == 409  # after every withdrawal
    assert cv.restore({**rec, "deleted_audit_id": None}).status_code == 409   # absent
