"""#1536 (D116–D121, 1.5.9) — one participant filter, one reading, on every qualitative reader.

A passage counts under a participant (demographic) filter only when it reaches a selected
participant through its OWN kind's link — a turn by its speaker, a survey answer by its record,
a document by the person it is linked to (`Document.participant_id`). A passage linked to no one
counts under no filter, and a clip never does: an observation names no participant (D117).
`services/participant_filter.py` is the one statement of it (D118).

Before #1536 the counting screens narrowed turns and answers and counted EVERY document and clip
— "Group = Y" counted D3, a Group-X person's document — while the Quote Board dropped every
document quote and clip. Measured at `ef596e14` by the review
(the internal design notes, git-ignored).

ONE case table: `UNITS` is the fixture, and every expected value below is DERIVED from it by
`_kept` — an oracle written from the decision, never from the code it checks. Every reader is
asked over HTTP, as the page asks (TestClient; the conftest's `:memory:` engine).

Fixture (one coder — the signed-in user):
  Participants P1 (Group = X) and P2 (Group = Y); speakers Pat → P1, Sam → P2, Lee → no one,
  an interviewer. Documents D1 → P2, D2 → no one, D3 → P1. One observation, O1.
"""
import csv
import io
from collections import Counter

import pytest
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import (
    Code, CodeApplication, Conversation, Document, Excerpt, Observation, Participant, Segment, Speaker,
)
from app.models.code_category import CodeCategory
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services import participant_filter as pf
from tests.guard_support import app_files

C1, C2, D1, D2, D3, O1, T1, T2, P1, P2 = 101, 102, 201, 202, 203, 301, 401, 402, 501, 502
A, B, UNC = 601, 602, 603
CAT = 701  # A and B are filed under it; Unclear (universal) is its own row
DEMO = 403
NAMES = {A: "A", B: "B", UNC: "Unclear"}
TURN, ANSWER, DOC, CLIP = pf.TURN, pf.ANSWER, pf.DOCUMENT, pf.CLIP
CSV_KIND = {TURN: "conversation", DOC: "document", CLIP: "observation"}
SF_KIND = {TURN: "conversation", DOC: "document", CLIP: "observation", ANSWER: "text_column"}

# (unit id, kind, source id, participant reached by the kind's link — None for no one, codes, quoted)
UNITS = [
    (1001, TURN, C1, P1, (A, B), True),
    (1003, TURN, C1, P1, (UNC,), False),
    (1004, TURN, C1, P1, (), False),
    (1005, TURN, C2, P2, (A,), True),
    (1006, TURN, C2, None, (A,), True),     # Lee — a speaker linked to no one
    (2001, DOC, D1, P2, (A, B), True),
    (2002, DOC, D1, P2, (B,), False),
    (2003, DOC, D2, None, (A,), True),      # D2 — a document linked to no one
    (2004, DOC, D3, P1, (A,), True),
    (3001, CLIP, O1, None, (A, B), True),   # a clip: no participant link exists
    (3002, CLIP, O1, None, (UNC,), False),
    (4201, ANSWER, T1, P1, (A, B), True),
    (4202, ANSWER, T1, P2, (A,), True),
    (4204, ANSWER, T1, None, (A,), False),  # R3 — a record linked to no one
    (4203, ANSWER, T2, P1, (B,), False),
]
# Not in UNITS: the interviewer's turn 1002 (code A) — every screen sends exclude_facilitator.
SPEAKER = {1001: 1, 1003: 1, 1004: 1, 1005: 2, 1006: 4}
ROW = {4201: 4101, 4202: 4102, 4204: 4103, 4203: 4101}
ANSWER_TEXT = {4201: "a real answer", 4202: "another answer", 4204: "an unlinked answer",
               4203: "second question"}
GROUP = {P1: "X", P2: "Y"}
FILTERS = {"none": None, "X": [P1], "Y": [P2]}


def _kept(unit, pids) -> bool:
    """D116/D117, from the decision: the oracle every expectation below is derived from."""
    _uid, kind, _src, person, _codes, _quoted = unit
    if not pids:
        return True
    if kind == CLIP:
        return False
    return person in pids


def _units(pids, kinds=None, code=None):
    return [u for u in UNITS if _kept(u, pids)
            and (kinds is None or u[1] in kinds)
            and (code is None or code in u[4])]


@pytest.fixture(scope="module")
def site():
    Base.metadata.create_all(bind=engine)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            status = client.get("/api/auth/status").json()
            csrf, uid = status["user"]["csrf_token"], status["user"]["id"]
            pid = client.post("/api/projects", json={"name": "Participant filter 1536"},
                              headers={"X-CSRF-Token": csrf}).json()["id"]
            _seed(pid, uid)
            yield client, pid, csrf
    finally:
        Base.metadata.drop_all(bind=engine)


def _seed(pid: int, uid: int) -> None:
    db = SessionLocal()
    db.add(CodeCategory(id=CAT, project_id=pid, name="Cat"))
    db.flush()
    db.add_all([
        Code(id=UNC, project_id=pid, numeric_id=1, name="Unclear", is_universal=True, is_active=True),
        Code(id=A, project_id=pid, numeric_id=100, name="A", is_universal=False, is_active=True,
             category_id=CAT),
        Code(id=B, project_id=pid, numeric_id=101, name="B", is_universal=False, is_active=True,
             category_id=CAT),
        Participant(id=P1, project_id=pid, identifier="P-01"),
        Participant(id=P2, project_id=pid, identifier="P-02"),
    ])
    db.flush()
    db.add_all([
        Speaker(id=1, project_id=pid, name="Pat", is_facilitator=0, participant_id=P1),
        Speaker(id=2, project_id=pid, name="Sam", is_facilitator=0, participant_id=P2),
        Speaker(id=3, project_id=pid, name="Interviewer", is_facilitator=1),
        Speaker(id=4, project_id=pid, name="Lee", is_facilitator=0),
        Conversation(id=C1, project_id=pid, name="C1"),
        Conversation(id=C2, project_id=pid, name="C2"),
        Document(id=D1, project_id=pid, name="D1", source_filename="d1.txt", source_format="txt",
                 participant_id=P2),
        Document(id=D2, project_id=pid, name="D2", source_filename="d2.txt", source_format="txt"),
        Document(id=D3, project_id=pid, name="D3", source_filename="d3.txt", source_format="txt",
                 participant_id=P1),
        Observation(id=O1, project_id=pid, name="O1"),
        Dataset(id=4000, project_id=pid, name="Survey"),
    ])
    db.flush()
    db.add_all([
        DatasetColumn(id=T1, dataset_id=4000, column_code="Q0", column_name="Q0", column_text="Question 0",
                      column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0),
        DatasetColumn(id=T2, dataset_id=4000, column_code="Q1", column_name="Q1", column_text="Question 1",
                      column_type=ColumnType.OPEN_TEXT, sequence_order=1, display_order=1),
        DatasetColumn(id=DEMO, dataset_id=4000, column_code="G", column_name="Group", column_text="Group",
                      column_type=ColumnType.DEMOGRAPHIC, demographic_subtype="group",
                      sequence_order=2, display_order=2),
    ])
    db.flush()
    for rid, part in ((4101, P1), (4102, P2), (4103, None)):
        db.add(DatasetRow(id=rid, dataset_id=4000, participant_id=part))
    db.flush()
    db.add_all([
        DatasetValue(id=4301, row_id=4101, column_id=DEMO, value_text=GROUP[P1]),
        DatasetValue(id=4302, row_id=4102, column_id=DEMO, value_text=GROUP[P2]),
    ])
    seq = 0
    # The interviewer's turn, coded A — outside UNITS, left out by exclude_facilitator.
    db.add(Segment(id=1002, conversation_id=C1, speaker_id=3, sequence_order=99, text="unit 1002",
                   word_count=2, is_merge_result=False))
    db.flush()
    db.add(CodeApplication(segment_id=1002, code_id=A, user_id=uid, origin="human"))
    for uid_, kind, src, _person, codes, quoted in UNITS:
        if kind == ANSWER:
            db.add(DatasetValue(id=uid_, row_id=ROW[uid_], column_id=src, value_text=ANSWER_TEXT[uid_]))
            db.flush()
            for c in codes:
                db.add(CodeApplication(dataset_value_id=uid_, code_id=c, user_id=uid, origin="human"))
            if quoted:
                db.add(Excerpt(project_id=pid, dataset_value_id=uid_))
            continue
        parent = {TURN: dict(conversation_id=src, speaker_id=SPEAKER.get(uid_)),
                  DOC: dict(document_id=src),
                  CLIP: dict(observation_id=src, start_time=float(seq), end_time=float(seq) + 0.5)}[kind]
        db.add(Segment(id=uid_, sequence_order=seq, text=f"unit {uid_}", word_count=2,
                       is_merge_result=False, **parent))
        seq += 1
        db.flush()
        for c in codes:
            db.add(CodeApplication(segment_id=uid_, code_id=c, user_id=uid, origin="human"))
        if quoted:
            db.add(Excerpt(project_id=pid, segment_id=uid_))
    db.commit()
    db.close()


def _pid_param(pids) -> dict:
    return {"participant_ids": ",".join(map(str, pids))} if pids else {}


def _ok(r):
    assert r.status_code == 200, r.text[:400]
    return r.json()


# ── 0. The fixture is worth running ────────────────────────────────────────────

def test_the_fixture_separates_the_old_reading_from_the_new():
    """Under "Group = Y" the old reading kept every document and clip; the decided one keeps D1's
    passages only. If the two agreed here, every assertion below would certify nothing."""
    old = {u[0] for u in UNITS if u[1] in (DOC, CLIP)}
    new = {u[0] for u in _units(FILTERS["Y"], kinds=(DOC, CLIP))}
    assert new == {2001, 2002}
    assert old - new == {2003, 2004, 3001, 3002}


def test_the_filter_offers_the_two_groups(site):
    client, pid, _csrf = site
    filters = _ok(client.get(f"/api/projects/{pid}/code-analysis/demographic-filters"))["filters"]
    by_value = {v["value"]: v["participant_ids"] for f in filters for v in f["values"]}
    assert by_value == {"X": [P1], "Y": [P2]}


# ── 1. The sidebar's per-code counts (`/frequencies`) ──────────────────────────

def _non_universal(u) -> bool:
    return any(c != UNC for c in u[4])


@pytest.mark.parametrize("source", ["all", "conversations"])
@pytest.mark.parametrize("label", list(FILTERS))
def test_the_sidebar_counts(site, label, source):
    client, pid, _csrf = site
    pids = FILTERS[label]
    d = _ok(client.get(f"/api/projects/{pid}/code-analysis/frequencies",
                       params={"source": source, "layer_scope": "human", **_pid_param(pids)}))
    by_code = {e["code_id"]: e for e in d["frequencies"]}
    for code in (A, B):
        e = by_code[code]
        assert e["segment_count"] == len(_units(pids, (TURN, DOC, CLIP), code)), (label, code)
        assert e["document_count"] == len({u[2] for u in _units(pids, (DOC,), code)}), (label, code)
        assert e["observation_count"] == len({u[2] for u in _units(pids, (CLIP,), code)}), (label, code)
        want_texts = len(_units(pids, (ANSWER,), code)) if source == "all" else 0
        assert e["text_count"] == want_texts, (label, code)
    assert d["total_documents"] == len({u[2] for u in _units(pids, (DOC,)) if u[4]})
    assert d["total_observations"] == len({u[2] for u in _units(pids, (CLIP,)) if u[4]})
    assert d["total_coded_segments"] == len([u for u in _units(pids, (TURN, DOC, CLIP)) if _non_universal(u)])


# ── 2. The summary table and its charts (`/source-frequencies`) ─────────────────

@pytest.mark.parametrize("label", list(FILTERS))
def test_the_summary_table(site, label):
    client, pid, csrf = site
    pids = FILTERS[label]
    d = _ok(client.post(f"/api/projects/{pid}/code-analysis/source-frequencies",
                        json={"code_ids": [A, B, UNC], "participant_ids": pids},
                        headers={"X-CSRF-Token": csrf}))
    counts, totals, coded = Counter(), Counter(), Counter()
    for s in d["sources"]:
        totals[s["source_type"]] += s["total_segments"]
        coded[s["source_type"]] += s["coded_segments"]
        for cid, e in (s.get("code_counts") or {}).items():
            counts[(int(cid), s["source_type"])] += e["count"]
    for kind, sf_kind in SF_KIND.items():
        assert totals[sf_kind] == len(_units(pids, (kind,))), (label, kind)
        assert coded[sf_kind] == len([u for u in _units(pids, (kind,)) if _non_universal(u)]), (label, kind)
        for code in (A, B, UNC):
            assert counts[(code, sf_kind)] == len(_units(pids, (kind,), code)), (label, kind, code)
    # D117 on the table: under a filter an observation is not a row (its Obs. columns would print
    # "0.0%" for clips never counted); a conversation the filter leaves empty is still listed.
    listed = {(s["source_type"], s["source_id"]) for s in d["sources"]}
    assert (("observation", O1) in listed) == (pids is None), label
    assert d["totals"]["total_observations"] == (1 if pids is None else 0), label
    assert ("conversation", C1) in listed and ("conversation", C2) in listed, label


@pytest.mark.parametrize("label", list(FILTERS))
def test_the_summary_table_compared_by_group(site, label):
    """*Compare By → Group* (`_compute_source_groups`): each group holds the passages that reach
    its people — under "Group = Y" no X passage, and no clip ever (an observation has no group)."""
    client, pid, csrf = site
    pids = FILTERS[label]
    d = _ok(client.post(f"/api/projects/{pid}/code-analysis/source-frequencies",
                        json={"code_ids": [A, B, UNC], "participant_ids": pids, "group_by_subtype": "group"},
                        headers={"X-CSRF-Token": csrf}))
    got = Counter()
    for s in d["sources"]:
        for g, b in (s.get("groups") or {}).items():
            got[(g, s["source_type"])] += b["total_segments"]
    want = Counter((GROUP[u[3]], SF_KIND[u[1]]) for u in _units(pids) if u[3] in GROUP)
    assert +got == want, label


@pytest.mark.parametrize("label", list(FILTERS))
def test_the_summary_table_by_category(site, label):
    """*Per Category*: A and B fold into Cat — a unit counts once however many of them it holds."""
    client, pid, csrf = site
    pids = FILTERS[label]
    d = _ok(client.post(f"/api/projects/{pid}/code-analysis/source-frequencies",
                        json={"code_ids": [A, B, UNC], "participant_ids": pids, "aggregation": "category"},
                        headers={"X-CSRF-Token": csrf}))
    counts = Counter()
    for s in d["sources"]:
        for cid, e in (s.get("code_counts") or {}).items():
            counts[(int(cid), s["source_type"])] += e["count"]
    for kind, sf_kind in SF_KIND.items():
        want = len([u for u in _units(pids, (kind,)) if {A, B} & set(u[4])])
        assert counts[(CAT, sf_kind)] == want, (label, kind)


# ── 3. Co-occurrence, both levels ──────────────────────────────────────────────

def _matrix(d):
    ids = [c["id"] if isinstance(c, dict) else c for c in d["codes"]]
    return {(ids[i], ids[j]): d["matrix"][i][j] for i in range(len(ids)) for j in range(len(ids))}


MODE_KINDS = {"all": None, "conversations": (TURN, DOC, CLIP)}


@pytest.mark.parametrize("source", list(MODE_KINDS))
@pytest.mark.parametrize("label", list(FILTERS))
def test_cooccurrence_by_passage(site, label, source):
    client, pid, _csrf = site
    pids, kinds = FILTERS[label], MODE_KINDS[source]
    d = _ok(client.get(f"/api/projects/{pid}/code-analysis/cooccurrence",
                       params={"source": source, "level": "segment", "layer_scope": "human",
                               **_pid_param(pids)}))
    m = _matrix(d)
    assert d["n_units"] == len([u for u in _units(pids, kinds) if u[4]]), label
    assert m[(A, A)] == len(_units(pids, kinds, code=A)), label
    assert m[(A, B)] == len([u for u in _units(pids, kinds) if A in u[4] and B in u[4]]), label


@pytest.mark.parametrize("source", list(MODE_KINDS))
@pytest.mark.parametrize("label", list(FILTERS))
def test_cooccurrence_by_source(site, label, source):
    client, pid, _csrf = site
    pids, kinds = FILTERS[label], MODE_KINDS[source]
    d = _ok(client.get(f"/api/projects/{pid}/code-analysis/cooccurrence",
                       params={"source": source, "level": "source", "layer_scope": "human",
                               **_pid_param(pids)}))
    m = _matrix(d)
    codes_by_source: dict[int, set] = {}
    for u in _units(pids, kinds):
        if u[4]:
            codes_by_source.setdefault(u[2], set()).update(u[4])
    assert d["n_units"] == len(codes_by_source), label
    assert m[(A, A)] == sum(1 for cs in codes_by_source.values() if A in cs), label
    assert m[(A, B)] == sum(1 for cs in codes_by_source.values() if {A, B} <= cs), label


# ── 4. The Content tab ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("label", list(FILTERS))
def test_the_content_tab_passages(site, label):
    client, pid, _csrf = site
    pids = FILTERS[label]
    d = _ok(client.get(f"/api/projects/{pid}/code-analysis/codes/{A}/segments",
                       params={"source": "all", "exclude_facilitator": "true", "layer_scope": "human",
                               **_pid_param(pids)}))
    got = {key: sorted(s["id"] for g in d[key] for s in g["segments"])
           for key in ("conversations", "documents", "observations")}
    assert got == {
        "conversations": sorted(u[0] for u in _units(pids, (TURN,), A)),
        "documents": sorted(u[0] for u in _units(pids, (DOC,), A)),
        "observations": sorted(u[0] for u in _units(pids, (CLIP,), A)),
    }, label
    assert d["document_total"] == len(got["documents"])
    assert d["observation_total"] == len(got["observations"])


@pytest.mark.parametrize("label", list(FILTERS))
def test_the_content_tab_answers(site, label):
    client, pid, _csrf = site
    pids = FILTERS[label]
    d = _ok(client.get(f"/api/projects/{pid}/code-analysis/codes/{A}/texts", params=_pid_param(pids)))
    assert d["total_texts"] == len(_units(pids, (ANSWER,), A)), label


# ── 5. The Quote Board ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("label", list(FILTERS))
def test_the_quote_board(site, label):
    """Before #1536 its clause was the TURN link over an outer join, so every document quote and
    clip vanished under a filter — the filtered person's own document included."""
    client, pid, _csrf = site
    pids = FILTERS[label]
    d = _ok(client.get(f"/api/projects/{pid}/excerpts/starred",
                       params={"source": "all", "exclude_facilitator": "true", **_pid_param(pids)}))
    got = sorted((e["segment_id"] or e["dataset_value_id"]) for e in d["excerpts"])
    assert got == sorted(u[0] for u in _units(pids) if u[5]), label


# ── 6. The Segments CSV (#1535 D113: it follows the screens) ────────────────────

@pytest.mark.parametrize("label", list(FILTERS))
def test_the_segments_csv(site, label):
    client, pid, _csrf = site
    pids = FILTERS[label]
    r = client.get(f"/api/projects/{pid}/export/coded-segments",
                   params={"exclude_facilitator": "true", **_pid_param(pids)})
    assert r.status_code == 200, r.text[:300]
    rows = list(csv.DictReader(io.StringIO(r.text.lstrip("﻿"))))
    got = Counter((row["Code"], row["Source Type"]) for row in rows)
    want = Counter((NAMES[c], CSV_KIND[u[1]]) for u in _units(pids, (TURN, DOC, CLIP)) for c in u[4])
    assert got == want, label


# ── 7. The comparison — the reading the others now share (a control) ──────────

@pytest.mark.parametrize("label", list(FILTERS))
def test_the_comparison_already_read_it_this_way(site, label):
    client, pid, csrf = site
    pids = FILTERS[label]
    d = _ok(client.post(f"/api/projects/{pid}/code-analysis/demographic-comparison",
                        json={"code_ids": [A, B], "group_by_subtype": "group", "participant_ids": pids},
                        headers={"X-CSRF-Token": csrf}))
    want = Counter(GROUP[u[3]] for u in _units(pids) if u[1] != CLIP and u[3] in GROUP)
    assert {g: t["total_segments"] for g, t in d["group_totals"].items()} == dict(want), label
    assert d["scope"]["observations_left_out"] == 1


# ── 8. D118: one predicate, and the population found by a test ─────────────────

def _own_participant_links(src: str) -> list[str]:
    """Each `<x>.participant_id.in_(` in `src` — a participant link spelled outside the module.
    The predicate is tested on its own (the falsifier below) so a silent scan cannot pass."""
    import re
    return re.findall(r"\b(\w+)\.participant_id\.in_\(\s*(\w*part\w*ids)\b", src)


def test_the_scan_sees_a_link_spelled_by_hand():
    planted = "q = q.filter(Speaker.participant_id.in_(participant_ids))\n" \
              "q = q.filter(Document.participant_id.in_(parsed_part_ids))\n"
    assert [m[0] for m in _own_participant_links(planted)] == ["Speaker", "Document"]
    assert _own_participant_links("Participant.id.in_(participant_ids)") == []


def test_no_reader_spells_a_participant_filter_of_its_own():
    """Every function that reads `participant_ids` asks `services/participant_filter.py` — a
    second spelling is how documents and clips escaped the filter for a year."""
    offenders, callers = [], 0
    for path in app_files(floor=150, sentinels=("services/participant_filter.py",
                                                "services/code_analysis.py", "routers/excerpts.py")):
        src = path.read_text(encoding="utf-8")
        if path.name == "participant_filter.py":
            continue
        offenders += [f"{path.name}: {m[0]}.participant_id.in_({m[1]})" for m in _own_participant_links(src)]
        callers += src.count("narrow_to_participants(") + src.count("participant_clause(") \
            + src.count("segment_passage_clause(")
    assert offenders == [], (
        "These spell a participant filter by hand. Use services/participant_filter.py "
        "(narrow_to_participants / participant_clause / segment_passage_clause): " + "; ".join(offenders))
    # Population self-check: the readers DO call the predicate (a broken walk would also find no offender).
    assert callers >= 25, f"only {callers} predicate calls found — has the walk gone blind?"


def test_the_predicate():
    from app.models.speaker import Speaker
    assert pf.participant_clause(pf.TURN, None) is None
    assert pf.participant_clause(pf.DOCUMENT, []) is None
    assert pf.segment_passage_clause(None) is None
    assert str(pf.participant_clause(pf.CLIP, [P1])) in ("false", "0 = 1")
    assert str(pf.participant_clause(pf.TURN, [P1]).left) == str(Speaker.__table__.c.participant_id)
    with pytest.raises(ValueError):
        pf.participant_clause("memo", [P1])
