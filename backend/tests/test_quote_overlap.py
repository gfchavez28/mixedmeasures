"""#1324 — overlapping and nested char-range quotes are ALLOWED (decided 2026-10-31).

The defect was the conversation workbench's RENDERER (frontend: `lib/quote-runs.ts`).
The backend already accepted overlap and every backend reader slices one quote at a
time — so this file is a POLICY PIN plus the confirmations the review owed, not a fix:

- **The doors:** a nested, a crossing and a shared-edge range are each a 201, on a
  conversation turn AND a document paragraph, through the single and the bulk create;
  only an IDENTICAL range is refused (`ix_excerpt_segment_range`). Until 2026-10-31
  nothing said overlap was allowed, so its absence of a refusal read as an oversight;
  a change that refuses overlap must now fail here first, on purpose.
- **The readers:** the excerpt API and the CSV give each nested quote its own words.
- **The operations that move quotes treat each quote ALONE:** the text-edit planner
  (#1319) and the split carry (#695) are pure per-quote functions over a set — a
  seeded property over overlapping sets asserts the set's plan is the concatenation of
  the one-quote plans. Their only cross-quote rules are the unique index's: the edit's
  409 `quotes_collide` and the split's (start, end) dedup, both already pinned
  (`test_text_edit_quote_rebase.py`, `test_segment_operations.py`).
- **`.mmproject`:** nested and crossing quotes on astral text survive a round trip.
"""
from __future__ import annotations

import csv
import io
import random

import pytest

from app.models.conversation import Conversation
from app.models.excerpt import Excerpt
from app.models.project import Project
from app.models.segment import Segment
from app.services import project_portability as pp
from app.services.segment_operations import (
    _CarryRegion,
    _char_excerpt_carry_plan,
    plan_text_edit_rebase,
)
# The HTTP harness of the #1319 doors — imported, not copied (pytest registers
# imported fixtures; `_clean` is autouse there and here).
from tests.test_text_edit_quote_rebase import (  # noqa: F401
    _clean,
    _migrated_db,
    _seed_conversation,
    _seed_document,
    client,
    project,
)

TURN = "We rolled it out in March and nobody was ready."  # 47 code points
# The filed shapes: two crossing, one enclosing everything, one nested.
FILED = [(4, 23), (15, 34), (0, 47), (10, 14)]


def _create(client, pid, headers, seg_id, s, e):
    return client.post(
        f"/api/projects/{pid}/excerpts",
        json={"segment_id": seg_id, "start_offset": s, "end_offset": e},
        headers=headers,
    )


@pytest.mark.parametrize("parent", ["conversation", "document"])
def test_overlap_and_nesting_are_accepted_and_only_an_identical_range_is_refused(client, project, parent):
    pid, headers = project
    seed = _seed_conversation if parent == "conversation" else _seed_document
    _, (sid,) = seed(pid, [TURN])
    assert len(TURN) == 47
    for s, e in FILED + [(0, 12), (20, 47)]:  # + a shared start, a shared end
        resp = _create(client, pid, headers, sid, s, e)
        assert resp.status_code == 201, (s, e, resp.text)
        assert resp.json()["excerpt_text"] == TURN[s:e]
    resp = _create(client, pid, headers, sid, 4, 23)
    assert resp.status_code == 409, resp.text


def test_the_bulk_door_accepts_the_same_overlapping_set(client, project):
    pid, headers = project
    _, (sid,) = _seed_conversation(pid, [TURN])
    resp = client.post(
        f"/api/projects/{pid}/excerpts/bulk",
        json={"items": [{"segment_id": sid, "start_offset": s, "end_offset": e} for s, e in FILED]},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json() == {"created_count": 4, "skipped_count": 0}


def test_every_reader_gives_each_nested_quote_its_own_words(client, project):
    pid, headers = project
    _, (sid,) = _seed_conversation(pid, [TURN])
    for s, e in FILED:
        assert _create(client, pid, headers, sid, s, e).status_code == 201
    want = sorted(TURN[s:e] for s, e in FILED)

    listed = client.get(f"/api/projects/{pid}/excerpts", headers=headers).json()["excerpts"]
    assert sorted(x["excerpt_text"] for x in listed) == want

    resp = client.get(f"/api/projects/{pid}/excerpts/export", headers=headers)
    assert resp.status_code == 200, resp.text
    rows = list(csv.DictReader(io.StringIO(resp.text.lstrip("﻿"))))
    text_col = next(k for k in rows[0] if "text" in k.lower() and "excerpt" in k.lower())
    assert sorted(r[text_col] for r in rows) == want


# ═══════════════════════════════════════════════════════════════════════════
# The operations that move quotes treat each quote alone — seeded properties
# ═══════════════════════════════════════════════════════════════════════════

def _overlapping_set(rng: random.Random, n: int) -> list[tuple[int, int, int]]:
    """Distinct (start, end) pairs over a text of n code points, biased to nest/cross."""
    out: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int]] = set()
    for k in range(rng.randrange(2, 7)):
        if out and rng.random() < 0.6:
            _, bs, be = rng.choice(out)
            s = rng.randrange(bs, be)
            e = rng.randrange(s + 1, n + 1) if rng.random() < 0.5 else rng.randrange(s + 1, be + 1)
        else:
            s = rng.randrange(0, n)
            e = rng.randrange(s + 1, n + 1)
        if (s, e) not in seen:
            seen.add((s, e))
            out.append((100 + k, s, e))
    return out


def test_the_text_edit_planner_rebases_each_overlapping_quote_alone():
    words = ["we", "rolled", "it", "out", "in", "March", "nobody", "was", "ready.", "😀", "猫"]
    inserts = ["", "x", "un", "not ", ".", "😀"]
    rng = random.Random(1324)
    overlapping_sets = 0
    for _ in range(1500):
        old = " ".join(rng.choice(words) for _ in range(rng.randrange(3, 12)))
        a = rng.randrange(0, len(old) + 1)
        new = old[:a] + rng.choice(inserts) + old[min(len(old), a + rng.randrange(0, 6)):]
        if not new:
            continue
        quotes = _overlapping_set(rng, len(old))
        together = plan_text_edit_rebase(old, new, quotes).quotes
        alone = [plan_text_edit_rebase(old, new, [q]).quotes[0] for q in quotes]
        assert together == alone, (old, new, quotes)
        spans = sorted((s, e) for _, s, e in quotes)
        overlapping_sets += any(spans[i][0] < spans[i - 1][1] for i in range(1, len(spans)))
    assert overlapping_sets > 500, overlapping_sets  # population floor


def test_the_split_carry_places_each_overlapping_quote_alone():
    class Q:  # the carry plan reads only these three attributes and identity
        def __init__(self, s, e):
            self.segment_id, self.start_offset, self.end_offset = 1, s, e

    rng = random.Random(695)
    divided = 0
    for _ in range(1500):
        n = rng.randrange(5, 60)
        cut_a = rng.randrange(0, n)
        cut_b = rng.randrange(cut_a + 1, n + 1)
        regions = [_CarryRegion(1, lo, hi, idx, 0)
                   for idx, (lo, hi) in enumerate([(0, cut_a), (cut_a, cut_b), (cut_b, n)])
                   if hi > lo]
        qs = [Q(s, e) for _, s, e in _overlapping_set(rng, n)]
        together = _char_excerpt_carry_plan(qs, regions)
        alone = [row for q in qs for row in _char_excerpt_carry_plan([q], regions)]
        assert together == alone
        divided += sum(1 for q in qs if sum(1 for r in together if r[0] is q) > 1)
    assert divided > 300, divided  # population floor: quotes that straddle a cut


# ═══════════════════════════════════════════════════════════════════════════
# .mmproject — nested and crossing quotes on astral text survive a round trip
# ═══════════════════════════════════════════════════════════════════════════

def test_nested_and_crossing_quotes_survive_a_round_trip(db_session, tmp_path):
    import uuid as uuid_module

    text = "Reaction 😀 then CODE THIS PHRASE and 𠀀 more."
    spans = [(0, len(text)), (9, 27), (17, 33), (17, 21), (36, 37)]
    db = db_session
    proj = Project(name="#1324", user_id=1, project_uuid=str(uuid_module.uuid4()))
    db.add(proj)
    db.flush()
    conv = Conversation(project_id=proj.id, name="C")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, sequence_order=0, text=text, word_count=8)
    db.add(seg)
    db.flush()
    for s, e in spans:
        db.add(Excerpt(project_id=proj.id, segment_id=seg.id, start_offset=s, end_offset=e))
    db.flush()
    db.commit()

    archive = tmp_path / "nested.mmproject"
    archive.write_bytes(pp.export_project(db, proj.id, tmp_path / "docs").getvalue())
    new_pid, _ = pp.import_project(db, archive, tmp_path / "docs2", user_id=1)
    db.flush()

    imported = db.query(Excerpt).filter(Excerpt.project_id == new_pid).all()
    assert sorted((x.start_offset, x.end_offset) for x in imported) == sorted(spans)
    seg2 = db.query(Segment).filter(Segment.id == imported[0].segment_id).one()
    assert sorted(seg2.text[x.start_offset:x.end_offset] for x in imported) == sorted(
        text[s:e] for s, e in spans)
