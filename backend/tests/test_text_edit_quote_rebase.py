"""#1319 — editing a turn's or paragraph's text carries its char-range quotes.

Before this, both edit doors overwrote `Segment.text` and left every quote's
offsets alone, so a typo fix moved every later quote onto other words — measured
through the real endpoints: 'not helpful' became ' it was not' after a prefix
edit, '' (an empty CSV cell) after shortening the turn, and a document quote
'popular wit'. The document door wrote no audit row at all.

What is pinned here:

- **The planner** (`segment_operations.plan_text_edit_rebase`) on the review's
  probe table, `ASTRAL_CASES` before and inside a quote, a quote mid-word, the
  autojunk trap, and a 100,000-character paragraph under a time bound.
- **Both doors** over HTTP: the preview writes nothing, an unanswered flagged quote
  is a 409, a collision is a 409 rather than an IntegrityError, the document door
  writes an audit row with NO WORDS (D6), and the excerpt API, the Quote Board
  (`/starred`), the CSV export and the canvas re-derive agree after an edit.
- **Undo is exact**: the explicit `excerpt_offsets` restore puts every quote back on
  its pre-edit offsets where the planner alone would not, and a redo replays the
  act's own offsets.

Existing coverage before this file: none — no backend test hit either PATCH door.
"""
from __future__ import annotations

import csv
import io
import json
import random
import time

import pytest
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.audit import AuditEntry
from app.models.canvas import Canvas, CanvasTheme
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.excerpt import Excerpt, excerpt_text_from
from app.models.note import Note
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.services import segment_operations as ops
from app.services.canvas import refresh_theme_content
from app.services.segment_operations import (
    REBASE_EDGE,
    REBASE_GONE,
    REBASE_SILENT,
    REBASE_STRADDLE,
    TEXT_EDIT_TOKEN_CAP,
    plan_text_edit_rebase,
)
from tests.test_text_offsets import ASTRAL_CASES, TARGET


# ═══════════════════════════════════════════════════════════════════════════
# The planner — pure, no database
# ═══════════════════════════════════════════════════════════════════════════

def _plan_one(old: str, new: str, quote: str, occurrence: int = 0):
    start = -1
    for _ in range(occurrence + 1):
        start = old.index(quote, start + 1)
    q = plan_text_edit_rebase(old, new, [(1, start, start + len(quote))]).quotes[0]
    shown = new[q.new_start:q.new_end] if q.new_start is not None else None
    return q, shown


# (label, old, new, quote, outcome, the words the quote marks afterwards)
PROBE_TABLE = [
    ("typo in the quote's LAST word touches its end",
     "Honestly, it was not helpfull at all.", "Honestly, it was not helpful at all.",
     "not helpfull", REBASE_EDGE, "not helpful"),
    ("typo at the quote's FIRST character touches its start",
     "it was Not helpful", "it was not helpful", "Not helpful", REBASE_EDGE, "not helpful"),
    ("a typo inside the first word, away from the edge, is absorbed",
     "it was nott helpful", "it was not helpful", "nott helpful", REBASE_SILENT, "not helpful"),
    ("words inserted before the quote",
     "Honestly, it was not helpful at all.", "Honestly, I think it was not helpful at all.",
     "not helpful", REBASE_SILENT, "not helpful"),
    ("words deleted before the quote",
     "Um, honestly, it was not helpful at all.", "Honestly, it was not helpful at all.",
     "not helpful", REBASE_SILENT, "not helpful"),
    ("words inserted after the quote",
     "Honestly, it was not helpful at all.", "Honestly, it was not helpful at all, really.",
     "not helpful", REBASE_SILENT, "not helpful"),
    ("an insertion exactly AT the start stays outside",
     "it was not helpful", "it was really not helpful", "not helpful", REBASE_SILENT, "not helpful"),
    ("an insertion exactly AT the end stays outside",
     "it was not helpful", "it was not helpful really", "not helpful", REBASE_SILENT, "not helpful"),
    ("an insertion strictly inside is absorbed",
     "it was not helpful", "it was not very helpful", "not helpful", REBASE_SILENT, "not very helpful"),
    ("whitespace collapsed inside the quote",
     "it was not   helpful at all", "it was not helpful at all", "not   helpful", REBASE_SILENT, "not helpful"),
    ("whitespace collapsed before the quote",
     "it  was   not helpful", "it was not helpful", "not helpful", REBASE_SILENT, "not helpful"),
    ("two typos, one before the quote and one in its last word",
     "Honestlly, it was not helpfull at all.", "Honestly, it was not helpful at all.",
     "not helpfull", REBASE_EDGE, "not helpful"),
    ("'was not' -> 'wasn't' straddles the start (and is not cut mid-word)",
     "it was not helpful", "it wasn't helpful", "not helpful", REBASE_STRADDLE, "wasn't helpful"),
    ("a change crossing the end widens the quote over it",
     "Honestly, it was not helpful at all.", "Honestly, it was not helpfully done.",
     "it was not helpful", REBASE_STRADDLE, "it was not helpfully done"),
    ("a change inside touching the end",
     "Honestly, it was not helpful at all.", "Honestly, it was not helpful whatsoever.",
     "helpful at all", REBASE_EDGE, "helpful whatsoever"),
    ("the quote's own words replaced in place",
     "it was not helpful", "it was hardly useful", "not helpful", REBASE_EDGE, "hardly useful"),
    ("the quote's span deleted with the sentence around it",
     "It was not helpful. The staff were kind.", "The staff were kind.", "not helpful", REBASE_GONE, None),
    ("exactly the quote's words deleted",
     "It was not helpful really.", "It was really.", "not helpful ", REBASE_GONE, None),
    ("the turn shortened to 'No.'",
     "Honestly, it was not helpful at all.", "No.", "not helpful", REBASE_GONE, None),
    ("its words replaced as part of a larger change",
     "He said it was not helpful at all", "He said it was fine", "not helpful", REBASE_GONE, None),
    ("a quote edge mid-word, typo in that word",
     "the unhelpfull staff", "the unhelpful staff", "helpfull", REBASE_EDGE, "helpful"),
    ("a quote edge mid-word, the change elsewhere in the word",
     "the unhelpfull staff", "the unhelpful staff", "unhelp", REBASE_SILENT, "unhelp"),
    # #1477 — a change abutting an edge from OUTSIDE that glues a word character onto
    # it lengthens the edge word: it asks, proposing the quote over the whole new word.
    ("#1477 letters glued after the last word: no -> nothing",
     "He said no more", "He said nothing more", "said no", REBASE_EDGE, "said nothing"),
    ("#1477 letters glued before the first word: able -> unable",
     "They were able to help", "They were unable to help", "able to help", REBASE_EDGE,
     "unable to help"),
    ("#1477 one letter glued: cat -> cats",
     "I like cat videos", "I like cats videos", "like cat", REBASE_EDGE, "like cats"),
    ("#1477 a REPLACEMENT abutting the end glues a letter: cat. -> cats!",
     "I like cat. Videos", "I like cats! Videos", "like cat", REBASE_EDGE, "like cats"),
    ("#1477 a REPLACEMENT abutting the start glues letters: (able -> unable",
     "They were (able to help", "They were unable to help", "able to help", REBASE_EDGE,
     "unable to help"),
    ("#1477 an apostrophe is crossed to the letter: can -> can't",
     "I can do it", "I can't do it", "I can", REBASE_EDGE, "I can't"),
    ("#1477 a hyphen is crossed to the word: help -> help-desk",
     "call help now", "call help-desk now", "call help", REBASE_EDGE, "call help-desk"),
    ("#1477 both edges at once",
     "were able to help us", "were unable to helpful us", "able to help", REBASE_EDGE,
     "unable to helpful"),
    ("#1477 a one-character quote, glued after",
     "a b c", "a bx c", "b", REBASE_EDGE, "bx"),
    ("#1477 a one-character quote, glued before",
     "a b c", "a xb c", "b", REBASE_EDGE, "xb"),
    ("#1477 text with no spaces: a character glued after",
     "我喜欢猫。", "我喜欢猫咪。", "喜欢猫", REBASE_EDGE, "喜欢猫咪"),
    ("#1477 an astral modifier glued after",
     "she said \U0001F44D ok", "she said \U0001F44D\U0001F3FD ok", "said \U0001F44D", REBASE_EDGE,
     "said \U0001F44D\U0001F3FD"),
    ("#1477 a combining accent glued after",
     "un cafe noir", "un café noir", "un cafe", REBASE_EDGE, "un café"),
    # ...and what stays silent: punctuation alone adds no word.
    ("#1477 punctuation appended after the quote stays outside",
     "they did help", "they did help.", "did help", REBASE_SILENT, "did help"),
    ("#1477 punctuation prepended before the quote stays outside",
     "they did help", "they did (help", "help", REBASE_SILENT, "help"),
    ("#1477 a quote ending in punctuation, punctuation added",
     "he said no. More", "he said no.. More", "said no.", REBASE_SILENT, "said no."),
    ("#1477 a quote ending in punctuation, a word typed against it: a missing space",
     "he said no. More", "he said no.Then More", "said no.", REBASE_SILENT, "said no."),
    ("#1477 a quote starting with punctuation, a word typed against it",
     "it was (not) good", "it was so(not) good", "(not)", REBASE_SILENT, "(not)"),
    ("#1477 text with no spaces: punctuation appended",
     "我喜欢猫", "我喜欢猫。", "喜欢猫", REBASE_SILENT, "喜欢猫"),
]


@pytest.mark.parametrize(
    "label,old,new,quote,outcome,words", PROBE_TABLE, ids=[row[0] for row in PROBE_TABLE],
)
def test_the_probe_table(label, old, new, quote, outcome, words):
    q, shown = _plan_one(old, new, quote)
    assert q.outcome == outcome, label
    assert shown == words, label
    if outcome == REBASE_GONE:
        assert q.new_start is None and q.new_end is None


def test_a_change_far_from_any_quote_moves_nothing_it_should_not():
    """Positive control for the whole table: several quotes, one edit, each in its
    own relation to the change."""
    old = "Alpha one. Bravo two helpfull. Charlie three."
    new = "Alpha one. Bravo two helpful. Charlie three!"
    plan = plan_text_edit_rebase(old, new, [
        (1, 0, 9),                                   # 'Alpha one'
        (2, old.index("two helpfull"), old.index("two helpfull") + 12),
        (3, old.index("Charlie"), old.index("Charlie") + 13),  # 'Charlie three'
    ])
    got = {q.excerpt_id: (q.outcome, new[q.new_start:q.new_end]) for q in plan.quotes}
    assert got == {
        1: (REBASE_SILENT, "Alpha one"),
        2: (REBASE_EDGE, "two helpful"),
        3: (REBASE_SILENT, "Charlie three"),
    }


@pytest.mark.parametrize("label,text,is_astral", ASTRAL_CASES, ids=[c[0] for c in ASTRAL_CASES])
def test_astral_text_BEFORE_the_quote_is_counted_in_code_points(label, text, is_astral):
    """Removing the first word (an astral glyph in most cases) shifts the quote by
    that word's CODE POINTS. A UTF-16 count moves it by one too many per astral
    character — the #687 class, and the review measured exactly that ('pport group.')."""
    first_space = text.index(" ")
    second_space = text.index(" ", first_space + 1)
    new = text[:first_space] + text[second_space:]   # drop the glyph word
    q, shown = _plan_one(text, new, TARGET)
    assert (q.outcome, shown) == (REBASE_SILENT, TARGET)


@pytest.mark.parametrize("label,text,is_astral", ASTRAL_CASES, ids=[c[0] for c in ASTRAL_CASES])
def test_astral_text_INSIDE_the_quote_keeps_its_end(label, text, is_astral):
    """The quote spans the glyph word through the phrase; one edit before it and one
    in its interior. Its end must land on the phrase's last word."""
    first_space = text.index(" ")
    quote = text[first_space + 1:text.index(TARGET) + len(TARGET)]
    new = "Re " + text[first_space + 1:].replace("THIS", "THESE")
    q, shown = _plan_one(text, new, quote)
    assert q.outcome == REBASE_SILENT
    assert shown == quote.replace("THIS", "THESE")


def test_autojunk_would_lose_a_quote_made_of_common_words():
    """The DISCRIMINATION fixture for `autojunk=False` (tests/the internal design notes #707a).

    Edits at both ends put the whole paragraph in the diffed middle, and the quote
    is made only of words that repeat (> 1% of 300+ tokens). With autojunk those
    words cannot anchor a match, nothing matches, the middle becomes ONE change and
    the quote reads as gone. Without it the quote is followed silently.
    """
    body = "the cat " * 150
    old = "Start " + body + "End"
    new = "Begin " + body + "Finish"
    start = old.index("the cat the cat", 600)
    plan = plan_text_edit_rebase(old, new, [(1, start, start + len("the cat the cat"))])
    q = plan.quotes[0]
    assert (q.outcome, new[q.new_start:q.new_end]) == (REBASE_SILENT, "the cat the cat")
    assert plan.capped is False


def _pathological_paragraph(n_chars: int, seed: int) -> str:
    """A small vocabulary is the slow case for a token diff: every token repeats."""
    rng = random.Random(seed)
    words = ["the", "staff", "were", "not", "very", "helpful", "and", "we",
             "felt", "alone", "in", "that", "place", "honestly", "I", "think"]
    return " ".join(rng.choice(words) for _ in range(n_chars // 4))[:n_chars]


def test_a_100k_paragraph_is_planned_under_a_time_bound():
    """The schema allows 100,000 characters and both doors are `async def`, so the
    planner runs on the event loop. Two edits ~98,000 characters apart put the whole
    paragraph in the diffed middle; uncapped, a small-vocabulary middle that size
    takes seconds (measured 0.2-0.3 s at 20k, roughly quadratic).

    Over the cap the middle is ONE change: a quote inside it is OFFERED (flagged),
    never followed by a guess; a quote outside it is still followed.
    """
    old = _pathological_paragraph(100_000, seed=7)
    new = old[:1000] + "XX" + old[1001:99_000] + "YY" + old[99_001:]
    inside = (50_000, 50_020)
    outside = (10, 30)
    t0 = time.perf_counter()
    plan = plan_text_edit_rebase(old, new, [(1, *outside), (2, *inside)])
    elapsed = time.perf_counter() - t0
    assert plan.capped is True
    assert elapsed < 1.0, f"planning a 100k paragraph took {elapsed:.2f}s"
    by_id = {q.excerpt_id: q for q in plan.quotes}
    assert by_id[1].outcome == REBASE_SILENT
    assert new[by_id[1].new_start:by_id[1].new_end] == old[outside[0]:outside[1]]
    assert by_id[2].outcome in ops.REBASE_NEEDS_CONFIRM


def test_the_cap_is_not_reached_by_an_ordinary_long_turn():
    """Positive control for the cap: a 5,000-character turn with scattered typos is
    diffed word by word, not collapsed into one change."""
    old = _pathological_paragraph(5_000, seed=3)
    assert len(ops._EDIT_TOKEN.findall(old)) < TEXT_EDIT_TOKEN_CAP
    new = old[:100] + "Q" + old[101:4_000] + "Q" + old[4_001:]
    plan = plan_text_edit_rebase(old, new, [(1, 2_000, 2_010)])
    assert plan.capped is False
    assert plan.quotes[0].outcome == REBASE_SILENT


def _shifted_span(old: str, new: str, s: int, e: int) -> tuple[int, int]:
    """The span a quote keeps when the edit only SHIFTS it (the SILENT rule)."""
    runs, _ = ops._text_edit_runs(old, new)
    d = [(r, (r.new_end - r.new_start) - (r.old_end - r.old_start)) for r in runs]
    return (s + sum(x for r, x in d if r.old_end <= s),
            e + sum(x for r, x in d if r.old_end <= e and r.old_start < e))


def test_a_silent_outcome_never_moves_an_edge_into_a_word():
    """#1477's property, over random edits (the 2026-10-29 audit's F3 harness, extended).

    A SILENT quote whose edge sat between words before the edit must not sit inside a
    word after it — reading outward from the edge over non-space characters, no letter,
    digit, mark or symbol may have arrived. The one shape left silent ON PURPOSE is a
    word typed beyond punctuation that already followed the edge, unchanged
    ("no," -> "no,and"): a missing space, not a longer word.
    """
    import unicodedata

    def word(c):
        return not c.isspace() and not unicodedata.category(c).startswith("P")

    def chunk(text, i, step):
        out = []
        while 0 <= i < len(text) and not text[i].isspace():
            out.append(text[i])
            i += step
        return out  # outward order

    def glued(text, edge_char_at, i, step):
        return (0 <= edge_char_at < len(text) and word(text[edge_char_at])
                and any(word(c) for c in chunk(text, i, step)))

    def behind_same_punctuation(old, o, new, n, step):
        a, b = chunk(old, o, step), chunk(new, n, step)
        return bool(a and b and a[0] == b[0] and not word(a[0]))

    words = ["the", "staff", "were", "not", "helpful", "it's", "ok.", "no,", "猫", "(help)",
             "\U0001F642", "naïve", "50%"]
    inserts = ["", "x", "s", "un", "ly", "n't", ".", "!", "really ", " ", "咪", "́", "\U0001F600"]
    rng = random.Random(1477)
    silent = shapes = 0
    examples = []
    for _ in range(4000):
        old = "".join(rng.choice(words) + rng.choice([" ", " ", "  ", ", "])
                      for _ in range(rng.randrange(1, 10))).rstrip()
        a = rng.randrange(0, len(old) + 1)
        new = old[:a] + rng.choice(inserts) + old[min(len(old), a + rng.randrange(0, 6)):]
        if not new:
            continue
        quotes = [(k, s, rng.randrange(s + 1, len(old) + 1))
                  for k, s in enumerate(rng.randrange(0, len(old)) for _ in range(4))]
        for q in plan_text_edit_rebase(old, new, quotes).quotes:
            if q.outcome == REBASE_GONE:
                continue
            silent += q.outcome == REBASE_SILENT
            s, e = q.old_start, q.old_end

            def into_a_word(ns, ne):
                after = not glued(old, e - 1, e, 1) and glued(new, ne - 1, ne, 1)
                before = not glued(old, s, s - 1, -1) and glued(new, ns, ns - 1, -1)
                return (after and not behind_same_punctuation(old, e, new, ne, 1)) or (
                    before and not behind_same_punctuation(old, s - 1, new, ns - 1, -1))

            # The population: quotes whose edges, merely SHIFTED by the edit (what
            # SILENT does), would land inside a word — whatever the planner decided.
            shapes += into_a_word(*_shifted_span(old, new, s, e))
            if q.outcome == REBASE_SILENT and into_a_word(q.new_start, q.new_end):
                examples.append((old, new, old[s:e], new[q.new_start:q.new_end]))
    # Population self-checks: the walk saw many silent quotes, and the generator does
    # produce the glued shape (else zero violations would prove nothing).
    assert silent > 5000 and shapes > 100, (silent, shapes)
    assert examples == [], (len(examples), examples[:5])


def test_a_quote_already_out_of_range_is_left_where_it_is():
    """Past damage is out of #1319's scope: the edit neither repairs nor deletes it."""
    plan = plan_text_edit_rebase("No.", "No!", [(1, 7, 18)])
    q = plan.quotes[0]
    assert (q.outcome, q.new_start, q.new_end) == (REBASE_SILENT, 7, 18)


# ═══════════════════════════════════════════════════════════════════════════
# The two doors, over HTTP
# ═══════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _clean(request):
    """Empty every table but the coder and their session after each door test.

    The client is module-scoped (the app's startup costs ~0.9 s a test), so the
    session row behind its cookie must survive; everything a test made goes.
    """
    yield
    if "_migrated_db" not in request.fixturenames:
        return
    db = SessionLocal()
    try:
        for table in reversed(Base.metadata.sorted_tables):
            if table.name not in ("users", "sessions"):
                db.execute(table.delete())
        db.commit()
    finally:
        db.close()


@pytest.fixture(scope="module")
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    db = SessionLocal()
    try:
        for table in reversed(Base.metadata.sorted_tables):
            db.execute(table.delete())
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def project(client):
    csrf = client.get("/api/auth/status").json()["user"]["csrf_token"]
    resp = client.post("/api/projects", json={"name": "#1319"}, headers={"X-CSRF-Token": csrf})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"], {"X-CSRF-Token": csrf}


def _seed_conversation(pid: int, texts: list[str]) -> tuple[int, list[int]]:
    db = SessionLocal()
    try:
        conv = Conversation(project_id=pid, name="Interview")
        db.add(conv)
        db.flush()
        sp = Speaker(project_id=pid, name="P1", color_index=0)
        db.add(sp)
        db.flush()
        segs = [
            Segment(conversation_id=conv.id, speaker_id=sp.id, sequence_order=i,
                    text=t, word_count=len(t.split()))
            for i, t in enumerate(texts)
        ]
        db.add_all(segs)
        db.commit()
        return conv.id, [s.id for s in segs]
    finally:
        db.close()


def _seed_document(pid: int, texts: list[str]) -> tuple[int, list[int]]:
    db = SessionLocal()
    try:
        doc = Document(project_id=pid, name="Policy", source_filename="p.txt", source_format="txt")
        db.add(doc)
        db.flush()
        segs = [
            Segment(document_id=doc.id, sequence_order=i, text=t, word_count=len(t.split()))
            for i, t in enumerate(texts)
        ]
        db.add_all(segs)
        db.commit()
        return doc.id, [s.id for s in segs]
    finally:
        db.close()


def _quote(client, pid, headers, seg_id, text, phrase, occurrence=0) -> int:
    start = -1
    for _ in range(occurrence + 1):
        start = text.index(phrase, start + 1)
    resp = client.post(
        f"/api/projects/{pid}/excerpts",
        json={"segment_id": seg_id, "start_offset": start, "end_offset": start + len(phrase)},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _offsets(excerpt_id: int) -> tuple[int, int] | None:
    db = SessionLocal()
    try:
        ex = db.get(Excerpt, excerpt_id)
        return None if ex is None else (ex.start_offset, ex.end_offset)
    finally:
        db.close()


def _segment_text(seg_id: int) -> str:
    db = SessionLocal()
    try:
        return db.get(Segment, seg_id).text
    finally:
        db.close()


def _audit_rows(seg_id: int) -> list[AuditEntry]:
    db = SessionLocal()
    try:
        return db.query(AuditEntry).filter(
            AuditEntry.entity_type == "segment", AuditEntry.entity_id == seg_id,
        ).all()
    finally:
        db.close()


class ConvDoor:
    def __init__(self, client, pid, headers, cid):
        self.client, self.pid, self.headers, self.cid = client, pid, headers, cid

    def preview(self, seg_id, text):
        return self.client.post(
            f"/api/conversations/{self.cid}/segments/{seg_id}/edit-preview",
            json={"text": text}, headers=self.headers,
        )

    def save(self, seg_id, text, **fields):
        return self.client.patch(
            f"/api/conversations/{self.cid}/segments/{seg_id}",
            json={"text": text, **fields}, headers=self.headers,
        )


class DocDoor:
    def __init__(self, client, pid, headers, did):
        self.client, self.pid, self.headers, self.did = client, pid, headers, did

    def preview(self, seg_id, text):
        return self.client.post(
            f"/api/projects/{self.pid}/documents/{self.did}/segments/{seg_id}/edit-preview",
            json={"text": text}, headers=self.headers,
        )

    def save(self, seg_id, text, **fields):
        return self.client.patch(
            f"/api/projects/{self.pid}/documents/{self.did}/segments/{seg_id}",
            json={"text": text, **fields}, headers=self.headers,
        )


@pytest.fixture(params=["conversation", "document"])
def door(request, client, project):
    """Each door test runs on BOTH doors — they are one operation (#1319)."""
    pid, headers = project
    seed = _seed_conversation if request.param == "conversation" else _seed_document

    def make(texts):
        parent_id, seg_ids = seed(pid, texts)
        d = (ConvDoor if request.param == "conversation" else DocDoor)(client, pid, headers, parent_id)
        d.kind = request.param
        return d, seg_ids

    return make


TURN = "Honestly, it was not helpful at all."


def test_a_prefix_edit_carries_the_quote_and_every_reader_agrees(door, client, project):
    """The measured defect — 'not helpful' became ' it was not' — and the four
    readers that must say the same words afterwards."""
    pid, headers = project
    d, (sid,) = door([TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")

    resp = d.save(sid, "Honestly, I think it was not helpful at all.")
    assert resp.status_code == 200, resp.text
    report = resp.json()["quote_rebase"]
    assert [(q["excerpt_id"], q["outcome"], q["new_text"]) for q in report["quotes"]] == [
        (eid, "silent", "not helpful"),
    ]

    api = client.get(f"/api/projects/{pid}/excerpts/{eid}").json()["excerpt_text"]
    starred = next(
        x["text"] for x in client.get(f"/api/projects/{pid}/excerpts/starred").json()["excerpts"]
        if x["excerpt_id"] == eid
    )
    rows = list(csv.DictReader(io.StringIO(client.get(f"/api/projects/{pid}/excerpts/export").text)))
    exported = next(r["Excerpt Text"] for r in rows if r["Excerpt ID"] == str(eid))
    assert api == starred == exported == "not helpful"


def test_the_canvas_re_derive_reads_the_same_words(door, client, project):
    """`services/canvas.py::refresh_theme_content` went through its own slice; it now
    asks `excerpt_text_from`, so after an edit it agrees with the excerpt API."""
    pid, headers = project
    d, (sid,) = door([TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")
    assert d.save(sid, "Honestly, I think it was not helpful at all.").status_code == 200

    db = SessionLocal()
    try:
        canvas = Canvas(project_id=pid, name="C")
        db.add(canvas)
        db.flush()
        theme = CanvasTheme(canvas_id=canvas.id, name="T", content=json.dumps({
            "type": "doc", "content": [
                {"type": "excerpt-embed", "attrs": {"excerptId": eid, "displayText": "stale"}},
            ],
        }))
        db.add(theme)
        db.flush()
        refresh_theme_content(db, theme)
        content = json.loads(theme.content) if isinstance(theme.content, str) else theme.content
        shown = content["content"][0]["attrs"]["displayText"]
        seg = db.get(Segment, sid)
        ex = db.get(Excerpt, eid)
        assert shown == excerpt_text_from(seg.text, ex.start_offset, ex.end_offset, None)
        assert shown == "not helpful"
        db.rollback()
    finally:
        db.close()


def test_astral_removal_before_the_quote_through_the_door(door, client, project):
    pid, headers = project
    text = "I felt \U0001F600 so happy about the support group."
    d, (sid,) = door([text])
    eid = _quote(client, pid, headers, sid, text, "support group")
    assert d.save(sid, "I felt so happy about the support group.").status_code == 200
    assert client.get(f"/api/projects/{pid}/excerpts/{eid}").json()["excerpt_text"] == "support group"


def test_the_preview_writes_nothing_and_names_the_flagged_quotes(door, client, project):
    pid, headers = project
    d, (sid,) = door([TURN])
    gone = _quote(client, pid, headers, sid, TURN, "not helpful")
    before_rows = len(_audit_rows(sid))

    resp = d.preview(sid, "No.")
    assert resp.status_code == 200, resp.text
    plan = resp.json()
    assert plan["needs_confirmation"] is True
    assert [(q["excerpt_id"], q["outcome"], q["old_text"], q["new_text"]) for q in plan["quotes"]] == [
        (gone, "gone", "not helpful", None),
    ]
    assert _segment_text(sid) == TURN
    assert _offsets(gone) == (TURN.index("not helpful"), TURN.index("not helpful") + 11)
    assert len(_audit_rows(sid)) == before_rows


def test_an_unanswered_flagged_quote_is_refused_and_nothing_is_written(door, client, project):
    """The shortened turn the review measured: it used to save, leaving the quote
    reading '' (an empty CSV cell)."""
    pid, headers = project
    d, (sid,) = door([TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")

    resp = d.save(sid, "No.")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "quotes_need_confirmation"
    assert detail["unplaceable_excerpt_ids"] == [eid]
    assert _segment_text(sid) == TURN
    assert _offsets(eid) is not None


FLAGGED_EDITS = [
    ("edge", "it was not helpfull", "it was not helpful", "not helpfull"),
    ("straddle", "it was not helpful", "it wasn't helpful", "not helpful"),
    ("gone", TURN, "No.", "not helpful"),
]


@pytest.mark.parametrize("kind,old,new,phrase", FLAGGED_EDITS, ids=[k[0] for k in FLAGGED_EDITS])
def test_every_flagged_kind_needs_an_answer_before_it_is_saved(door, client, project, kind, old, new, phrase):
    """D5: an edit that touches a quote's edge, straddles it or deletes it is shown
    first. A save that answers for none of them changes nothing."""
    pid, headers = project
    d, (sid,) = door([old])
    eid = _quote(client, pid, headers, sid, old, phrase)
    [item] = d.preview(sid, new).json()["quotes"]
    assert item["outcome"] == kind
    resp = d.save(sid, new)
    assert resp.status_code == 409, resp.text
    assert _segment_text(sid) == old
    assert _offsets(eid) == (old.index(phrase), old.index(phrase) + len(phrase))


def test_a_remove_set_that_differs_from_the_plan_is_refused(door, client, project):
    """Naming a quote the plan follows silently is refused too: the server deletes
    exactly what the client was shown, no more and no less."""
    pid, headers = project
    text = "Alpha one. It was not helpful. Bravo two."
    d, (sid,) = door([text])
    gone = _quote(client, pid, headers, sid, text, "not helpful")
    silent = _quote(client, pid, headers, sid, text, "Bravo two")
    resp = d.save(sid, "Alpha one. Bravo two.", remove_excerpt_ids=[gone, silent])
    assert resp.status_code == 409
    assert _segment_text(sid) == text


def test_a_named_removal_deletes_the_quote_and_keeps_its_note(door, client, project):
    pid, headers = project
    d, (sid,) = door([TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")
    db = SessionLocal()
    try:
        seg = db.get(Segment, sid)
        note = Note(
            conversation_id=seg.conversation_id, document_id=seg.document_id,
            segment_id=sid, excerpt_id=eid, content="why", sequence_number=1,
        )
        db.add(note)
        db.commit()
        note_id = note.id
    finally:
        db.close()

    resp = d.save(sid, "No.", remove_excerpt_ids=[eid])
    assert resp.status_code == 200, resp.text
    [item] = resp.json()["quote_rebase"]["quotes"]
    assert (item["outcome"], item["removed"], item["has_note"]) == ("gone", True, True)
    assert _offsets(eid) is None
    db = SessionLocal()
    try:
        kept = db.get(Note, note_id)
        assert kept is not None and kept.excerpt_id is None
    finally:
        db.close()


def test_keep_as_shown_places_a_flagged_quote_at_the_span_it_was_shown(door, client, project):
    pid, headers = project
    text = "Honestly, it was not helpfull at all."
    d, (sid,) = door([text])
    eid = _quote(client, pid, headers, sid, text, "not helpfull")
    new = "Honestly, it was not helpful at all."
    [item] = d.preview(sid, new).json()["quotes"]
    assert (item["outcome"], item["new_text"]) == ("edge", "not helpful")

    resp = d.save(sid, new, excerpt_offsets=[
        {"excerpt_id": eid, "start_offset": item["new_start"], "end_offset": item["new_end"]},
    ])
    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/projects/{pid}/excerpts/{eid}").json()["excerpt_text"] == "not helpful"


def test_a_word_lengthened_at_the_edge_asks_and_keeps_the_whole_word(door, client, project):
    """#1477 through both doors: "said no" kept over "said nothing" was saved with no
    dialog. Now the preview asks, an unanswered save changes nothing, and keeping it
    as shown marks the whole new word."""
    pid, headers = project
    old, new = "He said no more about it.", "He said nothing more about it."
    d, (sid,) = door([old])
    eid = _quote(client, pid, headers, sid, old, "said no")
    plan = d.preview(sid, new).json()
    [item] = plan["quotes"]
    assert plan["needs_confirmation"] is True
    assert (item["outcome"], item["new_text"]) == ("edge", "said nothing")

    assert d.save(sid, new).status_code == 409
    assert _segment_text(sid) == old

    resp = d.save(sid, new, excerpt_offsets=[
        {"excerpt_id": eid, "start_offset": item["new_start"], "end_offset": item["new_end"]},
    ])
    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/projects/{pid}/excerpts/{eid}").json()["excerpt_text"] == "said nothing"


def _collision_fixture(door, client, project):
    """Two quotes that land on ONE span: 'not helpfull' (an edge quote) proposes
    'not helpful', where the second quote already sits — `ix_excerpt_segment_range`."""
    pid, headers = project
    text = "it was not helpfull at all"
    d, (sid,) = door([text])
    a = _quote(client, pid, headers, sid, text, "not helpfull")
    b = _quote(client, pid, headers, sid, text, "not helpful")
    return d, sid, a, b, "it was not helpful at all"


def test_a_collision_is_named_by_the_preview_and_refused_by_the_save(door, client, project):
    d, sid, a, b, new = _collision_fixture(door, client, project)
    plan = d.preview(sid, new).json()
    assert plan["collisions"] == [sorted([a, b])]
    item = next(q for q in plan["quotes"] if q["excerpt_id"] == a)

    resp = d.save(sid, new, excerpt_offsets=[
        {"excerpt_id": a, "start_offset": item["new_start"], "end_offset": item["new_end"]},
    ])
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["error"] == "quotes_collide"
    assert _segment_text(sid) == "it was not helpfull at all"


def test_removing_the_flagged_quote_resolves_a_collision(door, client, project):
    d, sid, a, b, new = _collision_fixture(door, client, project)
    resp = d.save(sid, new, remove_excerpt_ids=[a])
    assert resp.status_code == 200, resp.text
    assert _offsets(a) is None
    assert _offsets(b) == (7, 18)


def test_quotes_that_trade_places_do_not_collide_mid_write(door, client, project):
    """'alpha' moves onto 'bravo''s OLD span. SQLite checks the unique index per
    UPDATE, so writing the first quote before the second has moved would be an
    IntegrityError on a perfectly valid final state; the apply parks movers first."""
    pid, headers = project
    text = "alpha bravo charlie"
    d, (sid,) = door([text])
    a = _quote(client, pid, headers, sid, text, "alpha")
    b = _quote(client, pid, headers, sid, text, "bravo")
    resp = d.save(sid, "delta alpha bravo charlie")
    assert resp.status_code == 200, resp.text
    assert (_offsets(a), _offsets(b)) == ((6, 11), (12, 17))


def test_offsets_outside_the_new_text_are_a_400(door, client, project):
    pid, headers = project
    d, (sid,) = door([TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")
    resp = d.save(sid, TURN, excerpt_offsets=[
        {"excerpt_id": eid, "start_offset": 0, "end_offset": len(TURN) + 1},
    ])
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "excerpt_offsets_invalid"


def test_astral_explicit_offsets_are_bounded_in_code_points(door, client, project):
    """A UTF-16 length would accept an end one past the last code point here."""
    pid, headers = project
    text = "Reaction \U0001F600 then CODE THIS PHRASE"
    d, (sid,) = door([text])
    eid = _quote(client, pid, headers, sid, text, "CODE THIS PHRASE")
    resp = d.save(sid, text, excerpt_offsets=[
        {"excerpt_id": eid, "start_offset": 0, "end_offset": len(text) + 1},
    ])
    assert resp.status_code == 400
    ok = d.save(sid, text, excerpt_offsets=[
        {"excerpt_id": eid, "start_offset": 0, "end_offset": len(text)},
    ])
    assert ok.status_code == 200, ok.text


def test_an_offset_for_a_quote_no_longer_on_the_segment_is_ignored(door, client, project):
    pid, headers = project
    d, (sid,) = door([TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")
    resp = d.save(sid, "Honestly, I think it was not helpful at all.", excerpt_offsets=[
        {"excerpt_id": 999_999, "start_offset": 0, "end_offset": 3},
    ])
    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/projects/{pid}/excerpts/{eid}").json()["excerpt_text"] == "not helpful"


# ── Undo and redo (the #1023 shape: captured at the act) ─────────────────────

def _undo(d, sid, old_text, report):
    """What the client's undo sends: the old text, every kept quote on its captured
    pre-edit offsets. Removed quotes are re-created after, by the excerpt door."""
    return d.save(sid, old_text, excerpt_offsets=[
        {"excerpt_id": q["excerpt_id"], "start_offset": q["old_start"], "end_offset": q["old_end"]}
        for q in report["quotes"] if not q["removed"]
    ])


def _redo(d, sid, new_text, report, recreated_ids=()):
    return d.save(sid, new_text, remove_excerpt_ids=list(recreated_ids), excerpt_offsets=[
        {"excerpt_id": q["excerpt_id"], "start_offset": q["new_start"], "end_offset": q["new_end"]}
        for q in report["quotes"] if not q["removed"]
    ])


def test_undo_restores_exact_offsets_where_the_planner_alone_would_not(door, client, project):
    """Single run. The edit deletes the comma the quote ends on and the researcher
    keeps the quote as shown ('not helpful'). Reversing the edit by planning alone
    re-adds the comma AT the quote's end — punctuation glued at an edge stays outside
    — so the quote would come back one character short. The captured offsets put it
    back exactly.

    ⚠️ It was a LETTER ('helpfull' -> 'helpful') until #1477: re-adding a letter at
    the edge now glues a word on, which asks and proposes the whole word — the
    original span — so that fixture stopped discriminating."""
    pid, headers = project
    old = "Honestly, it was not helpful, at all."
    new = "Honestly, it was not helpful at all."
    d, (sid,) = door([old])
    eid = _quote(client, pid, headers, sid, old, "not helpful,")
    original = _offsets(eid)
    [item] = d.preview(sid, new).json()["quotes"]
    act = d.save(sid, new, excerpt_offsets=[
        {"excerpt_id": eid, "start_offset": item["new_start"], "end_offset": item["new_end"]},
    ])
    assert act.status_code == 200, act.text
    report = act.json()["quote_rebase"]

    # The discrimination: the planner alone would NOT restore it.
    [reverse] = d.preview(sid, old).json()["quotes"]
    assert (reverse["new_start"], reverse["new_end"]) != original

    assert _undo(d, sid, old, report).status_code == 200
    assert _segment_text(sid) == old
    assert _offsets(eid) == original


def test_undo_and_redo_over_a_multi_run_edit_with_a_removed_quote(door, client, project):
    """Several changes in one save, one quote per relation to them, one removed.
    Undo restores every survivor exactly and re-creates the removed one; redo
    replays the act's own offsets and removes the re-created quote again."""
    pid, headers = project
    old = "Um, alpha was fine. It was not helpful. The staff were kindd overall."
    new = "Alpha was fine. The staff were kind overall."
    d, (sid,) = door([old])
    q_alpha = _quote(client, pid, headers, sid, old, "alpha was fine")
    q_gone = _quote(client, pid, headers, sid, old, "not helpful")
    q_edge = _quote(client, pid, headers, sid, old, "staff were kindd")
    before = {e: _offsets(e) for e in (q_alpha, q_gone, q_edge)}

    plan = d.preview(sid, new).json()
    outcomes = {q["excerpt_id"]: q["outcome"] for q in plan["quotes"]}
    assert outcomes[q_gone] == "gone"
    assert outcomes[q_edge] == "edge"
    keep = [
        {"excerpt_id": q["excerpt_id"], "start_offset": q["new_start"], "end_offset": q["new_end"]}
        for q in plan["quotes"] if q["outcome"] in ("edge", "straddle")
    ]
    unplaceable = [q["excerpt_id"] for q in plan["quotes"] if q["outcome"] == "gone"]
    act = d.save(sid, new, excerpt_offsets=keep, remove_excerpt_ids=unplaceable)
    assert act.status_code == 200, act.text
    report = act.json()["quote_rebase"]
    after_act = {q["excerpt_id"]: (q["new_start"], q["new_end"]) for q in report["quotes"]}

    # Undo: text and survivors first, then the removed quote re-created.
    assert _undo(d, sid, old, report).status_code == 200
    recreated = _quote(client, pid, headers, sid, old, "not helpful")
    assert _segment_text(sid) == old
    assert _offsets(q_alpha) == before[q_alpha]
    assert _offsets(q_edge) == before[q_edge]
    assert _offsets(recreated) == before[q_gone]

    # Redo is deterministic: the act's own offsets, the re-created quote removed.
    redo = _redo(d, sid, new, report, recreated_ids=[recreated])
    assert redo.status_code == 200, redo.text
    assert _segment_text(sid) == new
    assert _offsets(recreated) is None
    for eid in (q_alpha, q_edge):
        assert _offsets(eid) == after_act[eid]


# ── Door-specific ────────────────────────────────────────────────────────────

def test_the_document_edit_writes_an_audit_row_with_no_words(client, project):
    """D6: lengths and the rebase report — never the text. The old words in an audit
    row would outlive a participant's withdrawal."""
    pid, headers = project
    text = "The new policy was not popular with staff."
    did, (sid,) = _seed_document(pid, [text])
    eid = _quote(client, pid, headers, sid, text, "not popular")
    d = DocDoor(client, pid, headers, did)
    new = "The policy was not popular with staff."
    assert d.save(sid, new).status_code == 200

    rows = [r for r in _audit_rows(sid) if r.action == "segment_updated"]
    assert len(rows) == 1
    details = json.loads(rows[0].details)
    assert details["old_length"] == len(text)
    assert details["new_length"] == len(new)
    assert details["quote_rebase"] == [{
        "excerpt_id": eid, "outcome": "silent",
        "old": [text.index("not popular"), text.index("not popular") + 11],
        "new": [new.index("not popular"), new.index("not popular") + 11],
        "removed": False, "explicit": False,
    }]
    for word in ("policy", "popular", "staff"):
        assert word not in rows[0].details


def test_the_conversation_audit_row_records_the_rebase(client, project):
    pid, headers = project
    cid, (sid,) = _seed_conversation(pid, [TURN])
    eid = _quote(client, pid, headers, sid, TURN, "not helpful")
    assert ConvDoor(client, pid, headers, cid).save(sid, "So, " + TURN).status_code == 200
    [row] = [r for r in _audit_rows(sid) if r.action == "segment_updated"]
    details = json.loads(row.details)
    assert [q["excerpt_id"] for q in details["quote_rebase"]] == [eid]
    assert details["quote_rebase"][0]["new"] == [TURN.index("not helpful") + 4, TURN.index("not helpful") + 15]


def test_the_document_plan_is_made_against_the_STORED_text(client, project):
    """The door strips the paragraph, so leading whitespace typed by the researcher
    is never saved — and a quote's offsets must be in the string that is."""
    pid, headers = project
    text = "The new policy was not popular with staff."
    did, (sid,) = _seed_document(pid, [text])
    eid = _quote(client, pid, headers, sid, text, "not popular")
    d = DocDoor(client, pid, headers, did)
    typed = "   The policy was not popular with staff.  "
    plan = d.preview(sid, typed).json()
    assert plan["text"] == typed.strip()
    assert d.save(sid, typed).status_code == 200
    assert client.get(f"/api/projects/{pid}/excerpts/{eid}").json()["excerpt_text"] == "not popular"


def test_a_speaker_only_change_still_works_and_reports_no_rebase(client, project):
    pid, headers = project
    cid, (sid,) = _seed_conversation(pid, [TURN])
    db = SessionLocal()
    try:
        other = Speaker(project_id=pid, name="P2", color_index=1)
        db.add(other)
        db.commit()
        other_id = other.id
    finally:
        db.close()
    resp = client.patch(
        f"/api/conversations/{cid}/segments/{sid}", json={"speaker_id": other_id}, headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["speaker_id"] == other_id
    assert resp.json()["quote_rebase"] is None


def test_quote_fields_without_text_are_a_422(client, project):
    pid, headers = project
    cid, (sid,) = _seed_conversation(pid, [TURN])
    resp = client.patch(
        f"/api/conversations/{cid}/segments/{sid}", json={"remove_excerpt_ids": [1]}, headers=headers,
    )
    assert resp.status_code == 422
