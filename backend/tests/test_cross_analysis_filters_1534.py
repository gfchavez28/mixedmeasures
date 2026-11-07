"""#1534 (1.5.9, D103–D108) — the Cross-analysis CSV holds the comparison the screen shows.

The client sent its filters as `filters=` to a route reading `filters_json` from the day the
feature was written (2026-02-19), and FastAPI drops an undeclared query parameter without a
word, so no release ever filtered the file (record:
the internal design notes, git-ignored).
The name is the client's half (D103) and the request-contract guard's (D110,
`lib/api/request-contract.test.ts` + `test_route_params_map.py`). This file pins the server's
half: the file equals the screen (D103's point), an unreadable list is refused (D104), the
description names the selection (D105), the bases are stated (D106), a focal dataset no
filter judges is left out of both sides and named (D107), and the unfiltered section says so
(D108).

Fixture — the review's, two survey datasets, codes A and B:
  Wave 1: region (nominal), age (numeric), q1 (open text), six records
    R1 North 25 "bus late" A        R4 South 55 "forms slow" B
    R2 North 40 "clinic far" A+B    R5 North 38 "fine" —
    R3 South 31 "nurse kind" B      R6 South 62 "parking" A
  Wave 2: region2 (nominal), q2 (open text), four records S1..S4 — A, A, A, —
    (S1/S2 North, S3/S4 South)
"""
import asyncio
import csv
import io
import json

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.routers.text_analysis import (
    RESPONSE_LENGTH_UNFILTERED_HEADING,
    export_cross_analysis,
    filtered_frequencies,
)
from app.schemas.text_analysis import FilteredFrequenciesRequest, SubgroupFilter

PID = 1534
REGION, AGE, Q1, REGION2, Q2 = 15340, 15341, 15342, 15343, 15344
CODE_A, CODE_B = 15350, 15351


def _rows(response) -> list[list[str]]:
    async def drain():
        out = []
        async for chunk in response.body_iterator:
            out.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
        return "".join(out)
    return list(csv.reader(io.StringIO(asyncio.run(drain()))))


@pytest.fixture
def two_waves(db_session):
    db = db_session
    db.add(Project(id=PID, name="Cross-analysis filters", user_id=1))
    db.flush()
    db.add_all([
        Code(id=CODE_A, project_id=PID, numeric_id=1, name="A theme", is_universal=False, is_active=True),
        Code(id=CODE_B, project_id=PID, numeric_id=2, name="B theme", is_universal=False, is_active=True),
        Dataset(id=PID, project_id=PID, name="Wave 1"),
        Dataset(id=PID + 1, project_id=PID, name="Wave 2"),
    ])
    db.flush()
    db.add_all([
        DatasetColumn(id=REGION, dataset_id=PID, column_code="region", column_name="region",
                      column_text="Region", column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0),
        DatasetColumn(id=AGE, dataset_id=PID, column_code="age", column_name="age",
                      column_text="Age", column_type=ColumnType.NUMERIC, sequence_order=1, display_order=1),
        DatasetColumn(id=Q1, dataset_id=PID, column_code="q1", column_name="q1",
                      column_text="What happened?", column_type=ColumnType.OPEN_TEXT, sequence_order=2, display_order=2),
        DatasetColumn(id=REGION2, dataset_id=PID + 1, column_code="region2", column_name="region2",
                      column_text="Region (wave 2)", column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0),
        DatasetColumn(id=Q2, dataset_id=PID + 1, column_code="q2", column_name="q2",
                      column_text="And now?", column_type=ColumnType.OPEN_TEXT, sequence_order=1, display_order=1),
    ])
    db.flush()
    vid = 153400
    for i, (reg, age, text, codes) in enumerate([
        ("North", 25, "bus late", [CODE_A]), ("North", 40, "clinic far", [CODE_A, CODE_B]),
        ("South", 31, "nurse kind", [CODE_B]), ("South", 55, "forms slow", [CODE_B]),
        ("North", 38, "fine", []), ("South", 62, "parking", [CODE_A]),
    ]):
        row = DatasetRow(id=15360 + i, dataset_id=PID, row_identifier=f"R{i + 1}")
        db.add(row)
        db.flush()
        db.add(DatasetValue(id=vid, row_id=row.id, column_id=REGION, value_text=reg))
        db.add(DatasetValue(id=vid + 1, row_id=row.id, column_id=AGE, value_text=str(age), value_numeric=age))
        db.add(DatasetValue(id=vid + 2, row_id=row.id, column_id=Q1, value_text=text))
        db.flush()
        for c in codes:
            db.add(CodeApplication(code_id=c, user_id=1, dataset_value_id=vid + 2))
        vid += 3
    for i, (reg, text, codes) in enumerate([
        ("North", "x one", [CODE_A]), ("North", "y two", [CODE_A]),
        ("South", "z three", [CODE_A]), ("South", "w four", []),
    ]):
        row = DatasetRow(id=15370 + i, dataset_id=PID + 1, row_identifier=f"S{i + 1}")
        db.add(row)
        db.flush()
        db.add(DatasetValue(id=vid, row_id=row.id, column_id=REGION2, value_text=reg))
        db.add(DatasetValue(id=vid + 1, row_id=row.id, column_id=Q2, value_text=text))
        db.flush()
        for c in codes:
            db.add(CodeApplication(code_id=c, user_id=1, dataset_value_id=vid + 1))
        vid += 2
    db.flush()
    return db


NORTH = [{"column_id": REGION, "operator": "in", "values": ["North"]}]


def _screen(db, columns, filters):
    return filtered_frequencies(
        project_id=PID,
        body=FilteredFrequenciesRequest(column_ids=columns, filters=[SubgroupFilter(**f) for f in filters]),
        db=db, user=_user(db),
    )


def _user(db):
    from app.models.user import User
    return db.get(User, 1)


def _file(db, columns, filters):
    return _rows(export_cross_analysis(
        project_id=PID, column_ids=",".join(map(str, columns)),
        filters_json=json.dumps(filters) if filters is not None else "[]",
        coder_ids=None, layer_scope=None, db=db, user=_user(db),
    ))


def _row(rows, first):
    found = [r for r in rows if r and r[0] == first]
    assert found, f"no {first!r} row in {rows}"
    return found[0]


def _counts(rows, code):
    return _row(rows, code)[1:]


# ── D103: the file is the comparison on screen ─────────────────────────────────

def test_the_fixture_can_tell_filtered_from_overall(two_waves):
    """DISCRIMINATION: on this fixture the filtered and overall shares differ, so a file
    that silently dropped the filters cannot pass the equality below."""
    screen = _screen(two_waves, [Q1], NORTH)
    a_filtered = next(f for f in screen.filtered.frequencies if f.code_name == "A theme")
    a_overall = next(f for f in screen.overall.frequencies if f.code_name == "A theme")
    assert (a_filtered.percentage, a_overall.percentage) == (66.7, 50.0)


def test_the_file_holds_the_comparison_the_screen_shows(two_waves):
    screen = _screen(two_waves, [Q1], NORTH)
    rows = _file(two_waves, [Q1], NORTH)
    assert _row(rows, "Code")[1:] == ["Filtered Count", "Filtered %", "Overall Count", "Overall %", "Difference (pp)"]
    overall = {f.code_name: f for f in screen.overall.frequencies}
    for f in screen.filtered.frequencies:
        o = overall[f.code_name]
        assert _counts(rows, f.code_name)[:4] == [
            str(f.count), f"{f.percentage}%", str(o.count), f"{o.percentage}%",
        ]


# ── D104: an unreadable list is refused, never read as "no filters" ────────────

@pytest.mark.parametrize("filters_json, says", [
    ("not json", "not valid JSON"),
    ('{"column_id": 1}', "must be a list"),
    (json.dumps([{"column_id": REGION, "operator": "gte", "value": "abc"}]), "could not be read"),
    (json.dumps([{"column_id": REGION, "operator": "in", "values": []}]), "no value selected"),
    (json.dumps([{"column_id": AGE, "operator": "gte"}]), "no number to compare with"),
    (json.dumps([{"column_id": REGION, "operator": "contains", "values": ["N"]}]), "Unknown operator"),
])
def test_the_file_refuses_a_list_it_cannot_read(two_waves, filters_json, says):
    with pytest.raises(HTTPException) as exc:
        export_cross_analysis(project_id=PID, column_ids=str(Q1), filters_json=filters_json,
                              coder_ids=None, layer_scope=None, db=two_waves, user=_user(two_waves))
    assert exc.value.status_code == 400
    assert says in exc.value.detail


@pytest.mark.parametrize("bad", [
    {"column_id": REGION, "operator": "in", "values": []},
    {"column_id": AGE, "operator": "lte"},
    {"column_id": REGION, "operator": "contains", "values": ["N"]},
])
def test_the_screen_refuses_the_same_lists(two_waves, bad):
    """Both routes refuse the same lists: `in []` used to match no record silently (0%)."""
    with pytest.raises(HTTPException) as exc:
        _screen(two_waves, [Q1], [bad])
    assert exc.value.status_code == 400


def test_no_filters_is_still_no_filters(two_waves):
    """Positive control: an EMPTY list is not unreadable."""
    rows = _file(two_waves, [Q1], [])
    assert _row(rows, "Filters") == ["Filters", "None"]
    assert _row(rows, "Code") == ["Code", "Count", "%"]


# ── D105: the description names what it selects ────────────────────────────────

@pytest.mark.parametrize("filters, described", [
    ([{"column_id": REGION, "operator": "in", "values": ["North", "South"]}], "region is one of North, South"),
    ([{"column_id": REGION, "operator": "equals", "values": ["North"]}], "region equals North"),
    ([{"column_id": AGE, "operator": "gte", "value": 40}], "age at least 40"),
    ([{"column_id": AGE, "operator": "lte", "value": 2.5}], "age at most 2.5"),
    ([{"column_id": AGE, "operator": "above_mean"}], "age above its mean (41.83)"),
    ([{"column_id": AGE, "operator": "below_mean"}], "age below its mean (41.83)"),
    (NORTH + [{"column_id": AGE, "operator": "gte", "value": 30}], "region is one of North; age at least 30"),
])
def test_the_description_names_the_selection(two_waves, filters, described):
    assert _row(_file(two_waves, [Q1], filters), "Filters") == ["Filters", described]
    assert _screen(two_waves, [Q1], filters).filter_description == described


def test_a_mean_over_no_numbers_says_so(two_waves):
    """The open-text column has no numbers: the filter matches nothing and says why."""
    rows = _file(two_waves, [Q1], [{"column_id": REGION, "operator": "above_mean"}])
    assert _row(rows, "Filters") == ["Filters", "region above its mean (no numeric answers)"]


# ── D106: the bases ────────────────────────────────────────────────────────────

def test_the_file_states_both_bases(two_waves):
    rows = _file(two_waves, [Q1], NORTH)
    i = rows.index(["Base", "Texts", "Records"])
    assert rows[i + 1:i + 3] == [["Filtered", "3", "3"], ["Overall", "6", "6"]]


def test_an_unfiltered_file_states_its_base(two_waves):
    rows = _file(two_waves, [Q1], [])
    i = rows.index(["Base", "Texts", "Records"])
    assert rows[i + 1] == ["All", "6", "6"]


# ── D107: a dataset no filter judges is not compared ───────────────────────────

def test_an_unjudged_dataset_is_left_out_of_both_sides_and_named(two_waves):
    """Before: 7 texts / 7 records "matched" region North (Wave 2's four counted in full),
    A 71.4% vs 60.0%. Now Wave 1 is compared alone and Wave 2 is named."""
    screen = _screen(two_waves, [Q1, Q2], NORTH)
    assert (screen.filtered.text_count, screen.filtered.row_count) == (3, 3)
    assert (screen.overall.text_count, screen.overall.row_count) == (6, 6)
    assert screen.filter_scope == {"filtered_datasets": ["Wave 1"], "unfiltered_datasets": ["Wave 2"]}
    rows = _file(two_waves, [Q1, Q2], NORTH)
    assert _row(rows, "Not compared") == ["Not compared", "Wave 2 (no filter applies to its records)"]
    i = rows.index(["Base", "Texts", "Records"])
    assert rows[i + 1:i + 3] == [["Filtered", "3", "3"], ["Overall", "6", "6"]]
    assert _counts(rows, "A theme")[:4] == ["2", "66.7%", "3", "50.0%"]


def test_a_filter_on_each_dataset_compares_both(two_waves):
    """Control: with a filter on each focal dataset, both are compared — the union of each
    dataset's matches, as before — and nothing is named."""
    both = NORTH + [{"column_id": REGION2, "operator": "in", "values": ["North"]}]
    screen = _screen(two_waves, [Q1, Q2], both)
    assert (screen.filtered.text_count, screen.overall.text_count) == (5, 10)
    assert screen.filter_scope["unfiltered_datasets"] == []
    rows = _file(two_waves, [Q1, Q2], both)
    assert not [r for r in rows if r and r[0] == "Not compared"]


def test_a_filter_judging_no_focal_dataset_compares_nothing(two_waves):
    """A Wave 1 filter left set after Wave 1's question was deselected: nothing is compared
    (zero texts, both sides) and Wave 2 is named — never every Wave 2 record "matching"."""
    screen = _screen(two_waves, [Q2], NORTH)
    assert (screen.filtered.text_count, screen.overall.text_count) == (0, 0)
    assert screen.filter_scope["unfiltered_datasets"] == ["Wave 2"]


# ── D108: what the filters do not reach ────────────────────────────────────────

def test_the_unfiltered_section_says_so_only_when_filters_apply(two_waves):
    filtered = _file(two_waves, [Q1], NORTH)
    assert [RESPONSE_LENGTH_UNFILTERED_HEADING] in filtered
    unfiltered = _file(two_waves, [Q1], [])
    assert ["Response Length by Code"] in unfiltered
    assert [RESPONSE_LENGTH_UNFILTERED_HEADING] not in unfiltered
    # The section is the same either way: it was never filtered.
    def section(rows):
        i = next(n for n, r in enumerate(rows) if r and r[0].startswith("Response Length by Code"))
        return rows[i + 1:]
    assert section(filtered) == section(unfiltered)


# ── Over HTTP: the name a route does not declare is dropped ────────────────────

def test_over_http_only_the_routes_name_filters_the_file():
    """Why D110 exists, measured through FastAPI's own query parsing (a direct call cannot
    see it): `filters_json` filters the file; the old client's `filters` is dropped without
    a word and the file says None. Both answer 200."""
    from app.database import Base, SessionLocal, engine
    from app.main import app

    Base.metadata.create_all(bind=engine)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            status = client.get("/api/auth/status").json()
            pid = client.post("/api/projects", json={"name": "HTTP 1534"},
                              headers={"X-CSRF-Token": status["user"]["csrf_token"]}).json()["id"]
            db = SessionLocal()
            ds = Dataset(project_id=pid, name="Wave")
            db.add(ds)
            db.flush()
            region = DatasetColumn(dataset_id=ds.id, column_code="r", column_name="r", column_text="r",
                                   column_type=ColumnType.NOMINAL, sequence_order=0, display_order=0)
            text = DatasetColumn(dataset_id=ds.id, column_code="t", column_name="t", column_text="t",
                                 column_type=ColumnType.OPEN_TEXT, sequence_order=1, display_order=1)
            db.add_all([region, text])
            db.flush()
            for i, reg in enumerate(["North", "South"]):
                row = DatasetRow(dataset_id=ds.id, row_identifier=f"H{i}")
                db.add(row)
                db.flush()
                db.add(DatasetValue(row_id=row.id, column_id=region.id, value_text=reg))
                db.add(DatasetValue(row_id=row.id, column_id=text.id, value_text=f"answer {i}"))
            db.commit()
            filters = json.dumps([{"column_id": region.id, "operator": "in", "values": ["North"]}])
            ids = (region.id, text.id)
            db.close()

            url = f"/api/projects/{pid}/text-analysis/export"
            right = client.get(url, params={"column_ids": str(ids[1]), "filters_json": filters})
            wrong = client.get(url, params={"column_ids": str(ids[1]), "filters": filters})
            assert right.status_code == wrong.status_code == 200
            assert "Filters,r is one of North" in right.text
            assert "Filters,None" in wrong.text
    finally:
        Base.metadata.drop_all(bind=engine)
