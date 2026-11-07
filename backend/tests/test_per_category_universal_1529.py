"""#1529 (1.5.9, D91 + D93) — a universal code under *Per Category*.

Before 1.5.9 `get_source_frequencies`' category branch built every row with
`"is_universal": False`, so an uncategorised universal code — "Unclear" and "Unsubstantive/Artifact",
which a project's first conversation import seeds uncategorised — lost the flag the client's coded-share rule keys on (#1526 D79), and
the Descriptives summary table, its Canvas embed and the Frequencies CSV printed its share of a
coded total that leaves its units out (120% on the review's probe). And a universal code filed in a
real category (the one-code PATCH accepted it; a `.mmproject` file can carry it) made that category
count passages marked only "Unclear" — a theme's COUNT moved, 3 → 8.

D91: the category fold puts a universal code in its own pseudo-category whatever its
`category_id`, and that row says it is universal; the fold lives in ONE SQL expression
(`code_analysis._EFFECTIVE_CAT_ID`) and its one Python twin (`_effective_category_id`) — the
grouped arm carried a third, inline copy. D93: the one-code PATCH refuses a universal code's
category, as the bulk move does; clearing one stays allowed.

The client half (the share withheld, the note, the CSV, the charts' *Coded only* rule and the
Canvas fingerprint, D92/D94) is pinned in `frontend/src/components/qualitative-analysis/
qual-chart-data.universal-1529.test.ts` and its siblings.

Fixture — the 2026-11-04c review's probe (its git-ignored review kit):
D1 = {s1: A, s2: Unclear only, s3: B}; D2 = {s4: Unclear only, s5: Unsubstantive only,
s6: A + Unclear, s7: Unclear only, s8: Unclear only}; one open-text question, a1 A, a2 Unclear only,
a3 uncoded, a4 B. "A theme" is in the category "Experience"; "B theme" and both universal codes are
uncategorised. Both documents belong to one participant and each record to another, all with the
role "Staff", so the grouped arm (`group_by_subtype="role"`) has one group to fold. J-A: 3 coded
passages + 2 coded answers = 5 coded units; "Unclear" holds 6.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.models import Code, CodeApplication, CodeCategory, Participant, Project, User
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.segment import Segment
from app.routers import codes as codes_router
from app.schemas.code import CodeUpdate
from app.services import code_analysis as ca

PID = 1529
U0, U1, A, B = 15291, 15292, 15293, 15294   # Unsubstantive/Artifact, Unclear, A theme, B theme
CX = 15295                                   # the category "Experience" (holds A)
D1, D2 = 15296, 15297
T1, DS = 15298, 15310
PART = 15299                                 # the documents' participant
RECORD_PARTS = [15281, 15282, 15283, 15284]  # one per record (one row per participant per dataset)
SEGS = [  # (segment, document, order, [codes])
    (15301, D1, 0, [A]), (15302, D1, 1, [U1]), (15303, D1, 2, [B]),
    (15304, D2, 0, [U1]), (15305, D2, 1, [U0]), (15306, D2, 2, [A, U1]),
    (15307, D2, 3, [U1]), (15308, D2, 4, [U1]),
]
ANSWERS = [  # (record, value, text, [codes])
    (15311, 15321, "a real answer", [A]),
    (15312, 15322, "hard to read", [U1]),
    (15313, 15323, "uncoded answer", []),
    (15314, 15324, "another answer", [B]),
]
EVERY_SOURCE = dict(document_ids=[D1, D2], text_column_ids=[T1], conversation_ids=[],
                    observation_ids=[])


@pytest.fixture
def db(db_session):
    db = db_session
    db.add(Project(id=PID, name="1529", user_id=1))
    db.flush()
    db.add(CodeCategory(id=CX, project_id=PID, name="Experience", color="#3b82f6"))
    db.add_all([Participant(id=p, project_id=PID, identifier=f"P-{p}", role="Staff")
                for p in [PART, *RECORD_PARTS]])
    db.flush()
    db.add_all([
        Code(id=U0, project_id=PID, numeric_id=0, name="Unsubstantive/Artifact",
             is_universal=True, is_active=True),
        Code(id=U1, project_id=PID, numeric_id=1, name="Unclear", is_universal=True, is_active=True),
        Code(id=A, project_id=PID, numeric_id=100, name="A theme", category_id=CX,
             is_universal=False, is_active=True),
        Code(id=B, project_id=PID, numeric_id=101, name="B theme", is_universal=False, is_active=True),
    ])
    db.add_all([
        Document(id=D1, project_id=PID, name="D1", source_filename="d1.txt", source_format="txt",
                 participant_id=PART),
        Document(id=D2, project_id=PID, name="D2", source_filename="d2.txt", source_format="txt",
                 participant_id=PART),
    ])
    db.flush()
    for sid, did, order, _ in SEGS:
        db.add(Segment(id=sid, document_id=did, conversation_id=None, speaker_id=None,
                       sequence_order=order, text=f"paragraph {sid}", word_count=2,
                       is_merge_result=False))
    db.add(Dataset(id=DS, project_id=PID, name="Survey"))
    db.flush()
    db.add(DatasetColumn(id=T1, dataset_id=DS, column_code="Q1", column_name="Q1",
                         column_text="What did you think?", column_type=ColumnType.OPEN_TEXT,
                         sequence_order=0, display_order=0))
    db.flush()
    for (rec, vid, text, codes), part in zip(ANSWERS, RECORD_PARTS):
        db.add(DatasetRow(id=rec, dataset_id=DS, participant_id=part))
        db.flush()
        db.add(DatasetValue(id=vid, row_id=rec, column_id=T1, value_text=text))
        db.flush()
        for c in codes:
            db.add(CodeApplication(dataset_value_id=vid, code_id=c, user_id=1, origin="human"))
    for sid, _, _, codes in SEGS:
        for c in codes:
            db.add(CodeApplication(segment_id=sid, code_id=c, user_id=1, origin="human"))
    db.flush()
    return db


def _freqs(db, aggregation, **kw):
    return ca.get_source_frequencies(db, PID, aggregation=aggregation, **EVERY_SOURCE, **kw)


def _row(payload, row_id):
    return next(c for c in payload["codes"] if c["id"] == row_id)


def _counts(payload, row_id):
    """Per source, the row's count — what every client share is computed from."""
    return {s["source_label"]: (s["code_counts"] or {}).get(str(row_id), {}).get("count", 0)
            for s in payload["sources"]}


def _total(payload, row_id):
    return sum(_counts(payload, row_id).values())


def _file_unclear_in_experience(db):
    """The state the PATCH accepted before D93, and that a `.mmproject` file can still carry."""
    db.get(Code, U1).category_id = CX
    db.flush()
    db.expire_all()


# ── The fixture can tell the rules apart ─────────────────────────────────────

def test_the_fixture_can_tell_a_share_from_a_withheld_one(db):
    """Unclear's units outnumber the coded total, so any share of it reads over 100%."""
    payload = _freqs(db, "category")
    assert payload["totals"]["coded_segments"] == 5
    assert _total(payload, -U1) == 6


# ── D91: the row says it is universal ────────────────────────────────────────

def test_a_universal_codes_row_is_flagged_universal_under_per_category(db):
    payload = _freqs(db, "category")
    flags = {c["name"]: c["is_universal"] for c in payload["codes"]}
    assert flags == {"Unsubstantive/Artifact": True, "Unclear": True,
                     "Experience": False, "B theme": False}


def test_per_category_counts_a_universal_code_as_per_code_does(db):
    by_code, by_cat = _freqs(db, "code"), _freqs(db, "category")
    for code_id in (U0, U1):
        assert _row(by_cat, -code_id)["is_universal"] is _row(by_code, code_id)["is_universal"] is True
        assert _counts(by_cat, -code_id) == _counts(by_code, code_id)
        assert _row(by_cat, -code_id)["record_count"] == _row(by_code, code_id)["record_count"]


# ── D91: a universal code filed in a category is still its own row ───────────

def test_a_universal_code_filed_in_a_category_is_its_own_row(db):
    before = _freqs(db, "category")
    _file_unclear_in_experience(db)
    after = _freqs(db, "category")

    assert [c["id"] for c in after["codes"]] == [c["id"] for c in before["codes"]]
    assert _row(after, -U1)["is_universal"] is True
    for row_id in (CX, -U1, -U0, -B):
        assert _counts(after, row_id) == _counts(before, row_id)
        assert _row(after, row_id)["record_count"] == _row(before, row_id)["record_count"]
    # The theme counts its own code's units only — never a passage marked only "Unclear".
    assert _total(after, CX) == 3


def test_every_counted_key_is_a_row_of_the_payload(db):
    """The SQL fold and its Python twin agree: a count under a key no row has reads as zero."""
    _file_unclear_in_experience(db)
    payload = _freqs(db, "category")
    row_ids = {str(c["id"]) for c in payload["codes"]}
    counted = {k for s in payload["sources"] for k in (s["code_counts"] or {})}
    assert counted and counted <= row_ids


def test_the_grouped_arm_folds_a_filed_universal_code_out_too(db):
    """`_compute_source_groups` carried an inline copy of the fold; it takes the one fold now."""
    before = _freqs(db, "category", group_by_subtype="role")
    _file_unclear_in_experience(db)
    after = _freqs(db, "category", group_by_subtype="role")

    def grouped(payload, row_id):
        return {s["source_label"]: (s["groups"]["Staff"]["code_counts"] or {})
                .get(str(row_id), {}).get("count", 0)
                for s in payload["sources"] if s.get("groups")}

    assert grouped(before, CX)  # the arm ran: one group, every source
    for row_id in (CX, -U1):
        assert grouped(after, row_id) == grouped(before, row_id)
    assert sum(grouped(after, CX).values()) == 3


def test_the_fold_exists_once(db):
    """One SQL fold and one Python twin; no inline `sa_case` on `Code.category_id` beside them."""
    import inspect
    src = inspect.getsource(ca)
    assert src.count("Code.category_id.isnot(None)") == 1
    assert src.count("_effective_category_id(") == 2  # its definition and the category branch


# ── D93: the one-code PATCH ──────────────────────────────────────────────────

def _patch(db, code_id, category_id):
    user = db.query(User).filter(User.id == 1).one()
    return asyncio.run(codes_router.update_code(
        PID, code_id, CodeUpdate(category_id=category_id), user=user, db=db))


def test_the_patch_refuses_a_universal_codes_category(db):
    with pytest.raises(HTTPException) as exc:
        _patch(db, U1, CX)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Cannot move universal codes"
    db.expire_all()
    assert db.get(Code, U1).category_id is None


def test_the_patch_still_clears_a_universal_codes_category(db):
    _file_unclear_in_experience(db)
    assert _patch(db, U1, None).category_id is None


def test_the_patch_still_files_an_ordinary_code(db):
    assert _patch(db, B, CX).category_id == CX
