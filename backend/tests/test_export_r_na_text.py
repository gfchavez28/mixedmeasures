"""#1483 — a real answer spelled "NA" is read back as an answer, not as missing.

Every CSV the R export ships was read with readr's `na = c("", "NA")`, so the
TEXT `NA` became a missing value in R wherever the app keeps it as data:
measured at 02c97c77, a nominal *region* labelled `NA` (North America, Namibia)
under a declaration that says nothing is missing gave 4 of 10 NA in R while the
app counted 4 answers; a dataset named `NA` gave an all-NA `<prefix>_subset`
(mean NaN); an identifier, a record id and a participant id spelled `NA` became
NA in the join keys #533 exists to keep intact.

The reader may treat only a blank as missing because every WRITER blanks a
missing value itself and never writes the text `NA` for one —
`TestEveryWriterBlanksAMissingValue` holds them to that, across the data CSV
and the three agreement CSVs.
"""
import os

os.environ["MM_DATABASE_PATH"] = ":memory:"

import asyncio
import csv
import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_set import CodeSet
from app.models.conversation import Conversation
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.equivalence_group import EquivalenceGroup
from app.models.materials import Material, MaterialCollection
from app.models.metric import MetricDefinition
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services.metrics import compute_metric, create_scale_score_metric
from tests import r_support
from tests.test_export_r_score_names import _build, _run, _zip

# ── A single dataset: the plain `read_csv` line ───────────────────────────────


def _col(db, cid, dsid, code, ctype, order, **kw):
    db.add(DatasetColumn(id=cid, dataset_id=dsid, column_code=code, column_name=code,
                         column_text=code, column_type=ctype, sequence_order=order,
                         display_order=order, **kw))


def _single(db, pid, *, with_identifier=False):
    """`region`: nominal labelled ["NA", "EU"], nothing declared missing — 4 "NA",
    5 "EU", 1 blank. `site`: nominal declaring "99" missing — "NA" is an answer
    there too. `town`: undeclared, so the recognised-N/A defaults call "NA"
    missing (the app agrees — the two-sided arm)."""
    db.add(Project(id=pid, name=f"NA text {pid}", user_id=1))
    db.flush()
    dsid = pid * 10
    db.add(Dataset(id=dsid, project_id=pid, name="survey"))
    db.flush()
    base = pid * 100
    _col(db, base + 1, dsid, "region", "nominal", 0, scale_labels=json.dumps(["NA", "EU"]),
         scale_values=json.dumps([1, 2]), missing_values="[]")
    _col(db, base + 2, dsid, "site", "nominal", 1,
         missing_values=json.dumps([{"value": "99"}]))
    _col(db, base + 3, dsid, "town", "nominal", 2)
    if with_identifier:
        _col(db, base + 4, dsid, "pid", "identifier", 3)
    db.flush()
    region = ["NA"] * 4 + ["EU"] * 5 + [None]
    site = ["NA", "NA", "North", "North", "99", None, "North", "NA", "South", "South"]
    town = ["NA", "Leeds", "Leeds", "York", "York", "NA", "Leeds", "York", "Leeds", "York"]
    ident = ["NA", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", None]
    vid = pid * 10000
    for r in range(10):
        rid = pid * 1000 + r
        db.add(DatasetRow(id=rid, dataset_id=dsid, row_identifier="NA" if r == 0 else f"R{r}"))
        db.flush()
        cells = [(base + 1, region[r]), (base + 2, site[r]), (base + 3, town[r])]
        if with_identifier:
            cells.append((base + 4, ident[r]))
        for cid, text in cells:
            if text is None:
                continue
            vid += 1
            db.add(DatasetValue(id=vid, row_id=rid, column_id=cid, value_text=text))
    db.flush()
    return base


def _app_counts(db, pid, column_id):
    md = MetricDefinition(project_id=pid, name="f", metric_type="frequency_distribution",
                          input_source_type="dataset_column", input_source_id=column_id,
                          config="{}", origin="human")
    db.add(md)
    db.flush()
    counts = json.loads(compute_metric(db, md)[0].result_data)["counts"]
    db.delete(md)
    db.flush()
    return counts


_COUNTS = r'''
for (nm in c("region", "site", "town")) {
  v <- as.character(data[[nm]])
  emit(paste0(nm, "_na"), sum(is.na(v)))
  emit(paste0(nm, "_NAtext"), sum(v == "NA", na.rm = TRUE))
}
emit("record_NA", sum(data$record_id == "NA", na.rm = TRUE))
'''


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
@pytest.mark.parametrize("with_identifier", [False, True], ids=["plain", "identifier"])
def test_an_NA_answer_is_an_answer_in_r(db_session, with_identifier):
    """Both `read_csv` lines — the plain one and the one carrying an identifier's
    `col_types` — read `NA` as text; a blank and a declared or default-missing
    value are still NA (two-sided)."""
    db = db_session
    pid = 9781 if with_identifier else 9780
    base = _single(db, pid, with_identifier=with_identifier)
    app = {"region": _app_counts(db, pid, base + 1), "site": _app_counts(db, pid, base + 2),
           "town": _app_counts(db, pid, base + 3)}
    assert app["region"]["NA"] == 4 and app["site"]["NA"] == 3 and "NA" not in app["town"]

    tail = _COUNTS + ('emit("pid_na", sum(is.na(data$pid)))\n'
                      'emit("pid_NAtext", sum(data$pid == "NA", na.rm = TRUE))\n'
                      if with_identifier else "")
    out, script = _run(db, pid, tail)
    assert "col_types = cols(" in script          # text cells are read as text (b)
    # The answers the app counts are answers in R.
    assert out["region_NAtext"] == app["region"]["NA"] == 4
    assert out["site_NAtext"] == app["site"]["NA"] == 3
    assert out["record_NA"] == 1
    # Two-sided: what the app calls missing is still missing in R.
    assert out["region_na"] == 1          # the blank cell
    assert out["site_na"] == 2            # "99" (declared) and the blank
    assert out["town_na"] == 2            # "NA" under the defaults, both rows
    assert out["town_NAtext"] == 0
    if with_identifier:
        assert out["pid_NAtext"] == 1 and out["pid_na"] == 1   # the join key survives


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_the_plain_reader_with_no_text_column(db_session):
    """The `read_csv` line with no `col_types` (no text cell, no identifier):
    a record id spelled `NA` is still a record id."""
    db = db_session
    pid = 9783
    db.add(Project(id=pid, name=f"NA plain {pid}", user_id=1))
    db.flush()
    db.add(Dataset(id=pid * 10, project_id=pid, name="survey"))
    db.flush()
    _col(db, pid * 100 + 1, pid * 10, "q", "numeric", 0)
    db.flush()
    for r in range(3):
        db.add(DatasetRow(id=pid * 1000 + r, dataset_id=pid * 10,
                          row_identifier="NA" if r == 0 else f"R{r}"))
        db.flush()
        db.add(DatasetValue(id=pid * 10000 + r, row_id=pid * 1000 + r,
                            column_id=pid * 100 + 1, value_text=str(r), value_numeric=float(r)))
    db.flush()
    out, script = _run(db, pid, 'emit("record_NA", sum(data$record_id == "NA", na.rm = TRUE))\n')
    assert "col_types" not in script
    assert out["record_NA"] == 1


# ── (b) A text cell is read as text: readr's guess no longer decides ──────────


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_a_text_cell_is_not_reparsed_by_readr(db_session):
    """`factor()` matches its text levels against the cell, so a cell readr
    parsed as a number, a logical or a time matched nothing and became NA —
    measured at 02c97c77: a demographic `45,000` (the importer types `income`
    DEMOGRAPHIC itself), an all-`F` sex column and a nominal `1.0` were 100% NA.
    `ctrl` (Yes/No) is the control readr already left alone."""
    db = db_session
    pid = 9784
    db.add(Project(id=pid, name=f"guess {pid}", user_id=1))
    db.flush()
    db.add(Dataset(id=pid * 10, project_id=pid, name="survey"))
    db.flush()
    cols = {"income": ("demographic", ["45,000", "52,500", "38,000", "45,000"]),
            "sex": ("demographic", ["F", "F", "F", "F"]),
            "band": ("nominal", ["1.0", "2.0", "2.0", "1.0"]),
            "when": ("nominal", ["10:00", "11:30", "10:00", "12:00"]),
            "ctrl": ("nominal", ["Yes", "No", "Yes", "No"])}
    for k, (code, (ctype, _v)) in enumerate(cols.items()):
        _col(db, pid * 100 + k, pid * 10, code, ctype, k)
    db.flush()
    vid = pid * 10000
    for r in range(4):
        db.add(DatasetRow(id=pid * 1000 + r, dataset_id=pid * 10))
        db.flush()
        for k, (_code, (_t, vals)) in enumerate(cols.items()):
            vid += 1
            db.add(DatasetValue(id=vid, row_id=pid * 1000 + r, column_id=pid * 100 + k,
                                value_text=vals[r]))
    db.flush()
    out, _script = _run(db, pid, r'''
for (nm in c("income", "sex", "band", "when", "ctrl")) emit(paste0(nm, "_na"), sum(is.na(data[[nm]])))
emit("income_45", sum(as.character(data$income) == "45,000", na.rm = TRUE))
''')
    assert out == {"income_na": 0, "sex_na": 0, "band_na": 0, "when_na": 0, "ctrl_na": 0,
                   "income_45": 2}


# ── Two datasets: `dataset`, `participant_id` and the per-dataset subset ──────


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
def test_a_dataset_and_a_participant_named_NA(db_session):
    db = db_session
    pid = 9782
    cols, _d, _t = _build(db, pid, domains=[], extra_cols=["i1"], ds_name="NA",
                          second_ds_name="wave2")
    eg = EquivalenceGroup(id=pid * 10 + 3, project_id=pid, label="q")
    db.add(eg)
    db.flush()
    for code in ("i1", "other_q"):
        db.get(DatasetColumn, cols[code]).equivalence_group_id = eg.id
    dom = AnalysisDomain(id=pid * 10 + 4, project_id=pid, name="Scale", sequence_order=0)
    db.add(dom)
    db.flush()
    for k, code in enumerate(("i1", "other_q")):
        db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column",
                                    member_id=cols[code], sequence_order=k))
    db.flush()
    _m, ok = create_scale_score_metric(db, dom)
    assert ok
    db.add(Material(id=pid * 10 + 250, collection_id=pid * 10 + 7, material_type="summary_table",
                    config=json.dumps({"metric_type": "domain_aggregate", "domain_ids": [dom.id]}),
                    auto_name="agg", source_tab="descriptives", display_order=50))
    p = Participant(project_id=pid, identifier="NA", role="NA")
    db.add(p)
    db.flush()
    db.get(DatasetRow, pid * 1000).participant_id = p.id
    db.flush()
    i1_values = [v for (v,) in db.query(DatasetValue.value_numeric)
                 .filter(DatasetValue.column_id == cols["i1"]).all()]

    out, script = _run(db, pid, r'''
emit("ds_NA_rows", sum(data$dataset == "NA", na.rm = TRUE))
emit("subset_mean", mean(.mm_num(na_subset)[[1]], na.rm = TRUE))
emit("pid_NAtext", sum(data$participant_id == "NA", na.rm = TRUE))
emit("pid_na", sum(is.na(data$participant_id)))
emit("role_NAtext", sum(data$participant_role == "NA", na.rm = TRUE))
''')
    assert re.search(r'^na_subset <- data\[data\$dataset == "NA", ', script, re.M)
    assert out["ds_NA_rows"] == 30
    assert out["subset_mean"] == pytest.approx(sum(i1_values) / len(i1_values), abs=1e-9)
    assert out["pid_NAtext"] == 1 and out["role_NAtext"] == 1
    assert out["pid_na"] == 34            # the unlinked rows stay blank, and NA in R


# ── The precondition: every writer blanks a missing value ─────────────────────

CENSUS_PID = 9790


def _census_project(db):
    """Something missing in every column kind each of the four CSVs writes, and
    one planted REAL `NA` per user-text field, so the census can tell a planted
    answer from a writer that spelled a missing value `NA`.

    Agreement: three coders, two conversations — coders 1+2 engage the first,
    1+3 the second — so every matrix carries Option-B blanks (`None`) for the
    coder who never opened that source; one rated application is unrated; a
    three-member, non-exhaustive code set."""
    db.add(Project(id=CENSUS_PID, name="NA census", user_id=1))
    db.flush()
    dsid = CENSUS_PID * 10
    db.add(Dataset(id=dsid, project_id=CENSUS_PID, name="survey"))
    db.flush()
    base = CENSUS_PID * 100
    _col(db, base + 1, dsid, "region", "nominal", 0, scale_labels=json.dumps(["NA", "EU"]),
         scale_values=json.dumps([1, 2]), missing_values="[]")
    _col(db, base + 2, dsid, "town", "nominal", 1)
    _col(db, base + 3, dsid, "age", "demographic", 2)
    _col(db, base + 4, dsid, "q1", "ordinal", 3, scale_labels=json.dumps(["Low", "High"]),
         scale_values=json.dumps([1, 2]))
    _col(db, base + 5, dsid, "q2", "numeric", 4)
    _col(db, base + 6, dsid, "q3", "numeric", 5)
    _col(db, base + 7, dsid, "pid", "identifier", 6)
    db.flush()
    rows = [  # region, town, age, q1, q2, q3, pid
        ("NA", "NA", "34", 1.0, 3.0, 4.0, "NA"),
        ("EU", "York", "N/A", 2.0, None, None, None),
        (None, "Leeds", None, None, 5.0, 2.0, "P3"),
        ("EU", "York", "41", 2.0, 4.0, 5.0, "P4"),
    ]
    vid = CENSUS_PID * 10000
    for r, cells in enumerate(rows):
        rid = CENSUS_PID * 1000 + r
        db.add(DatasetRow(id=rid, dataset_id=dsid, row_identifier=f"R{r}"))
        db.flush()
        for k, v in enumerate(cells):
            if v is None:
                continue
            vid += 1
            num = v if isinstance(v, float) else None
            db.add(DatasetValue(id=vid, row_id=rid, column_id=base + 1 + k,
                                value_text=v if num is None else f"{v:g}", value_numeric=num))
    db.flush()
    p = Participant(project_id=CENSUS_PID, identifier="NA")
    db.add(p)
    db.flush()
    db.get(DatasetRow, CENSUS_PID * 1000).participant_id = p.id
    dom = AnalysisDomain(id=CENSUS_PID * 10 + 4, project_id=CENSUS_PID, name="Pair",
                         sequence_order=0)
    db.add(dom)
    db.flush()
    for k, cid in enumerate((base + 5, base + 6)):
        db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column", member_id=cid,
                                    sequence_order=k))
    db.flush()
    _m, ok = create_scale_score_metric(db, dom)
    assert ok
    db.add(MaterialCollection(id=CENSUS_PID * 10 + 7, project_id=CENSUS_PID, name="M"))

    db.add_all([User(id=2, username="Coder B", password_hash=None, coder_type="human"),
                User(id=3, username="Coder C", password_hash=None, coder_type="human")])
    db.add_all([Conversation(id=CENSUS_PID, project_id=CENSUS_PID, name="One"),
                Conversation(id=CENSUS_PID + 1, project_id=CENSUS_PID, name="Two")])
    db.flush()
    segs = [CENSUS_PID * 10 + i for i in range(6)]
    for i, sid in enumerate(segs):
        db.add(Segment(id=sid, conversation_id=CENSUS_PID + (i >= 4), sequence_order=i,
                       text=f"s{i}"))
    db.add(CodeSet(id=CENSUS_PID, project_id=CENSUS_PID, label="NA", exhaustive=False))
    db.flush()
    theme, rated = CENSUS_PID * 10 + 1, CENSUS_PID * 10 + 2
    m1, m2, m3 = (CENSUS_PID * 10 + 3 + k for k in range(3))
    db.add_all([
        Code(id=theme, project_id=CENSUS_PID, name="NA", numeric_id=2, is_active=True),
        Code(id=rated, project_id=CENSUS_PID, name="Rated", numeric_id=3, is_active=True,
             magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0),
        *[Code(id=c, project_id=CENSUS_PID, name=n, numeric_id=4 + k, is_active=True,
               code_set_id=CENSUS_PID)
          for k, (c, n) in enumerate(((m1, "For"), (m2, "Neutral"), (m3, "Against")))],
    ])
    db.flush()
    apps = [  # (code, coder, segment index, rating)
        (theme, 1, 0, None), (theme, 2, 0, None), (theme, 1, 1, None), (theme, 2, 2, None),
        (theme, 1, 4, None), (theme, 3, 4, None), (theme, 3, 5, None),
        (rated, 1, 0, 4.0), (rated, 2, 0, 5.0), (rated, 1, 1, 2.0), (rated, 2, 1, None),
        (rated, 1, 4, 3.0), (rated, 3, 4, 3.0),
        (m1, 1, 0, None), (m1, 2, 0, None), (m2, 1, 1, None), (m3, 2, 1, None),
        (m1, 1, 2, None), (m2, 1, 2, None), (m3, 3, 5, None),
    ]
    for code, coder, si, rating in apps:
        db.add(CodeApplication(code_id=code, user_id=coder, segment_id=segs[si],
                               magnitude=rating))
    db.flush()
    return base


def _csvs(db, pid):
    user = db.query(User).filter(User.id == 1).one()
    with zipfile.ZipFile(io.BytesIO(asyncio.run(_zip(pid, user, db)))) as zf:
        return {n: list(csv.reader(io.StringIO(zf.read(n).decode("utf-8-sig"))))
                for n in zf.namelist() if n.endswith(".csv")}


class TestEveryWriterBlanksAMissingValue:
    # The columns where the fixture planted a REAL `NA` — the only ones it may appear in.
    PLANTED = {"_data.csv": {"region", "pid", "participant_id"},
               "_irr.csv": {"code_name"},
               "_irr_magnitude.csv": set(),
               "_irr_code_sets.csv": {"set_label"}}
    # Columns whose missing branch the fixture reaches — each must hold a blank.
    BLANK = {"_data.csv": {"region", "town", "age", "q1", "q2", "q3", "pid",
                           "participant_id", "pair_score"},
             "_irr.csv": {"coder_2", "coder_3"},
             "_irr_magnitude.csv": {"coder_2", "coder_3"},
             "_irr_code_sets.csv": {"coder_2", "coder_3"}}

    def test_no_writer_spells_a_missing_value_NA(self, db_session):
        _census_project(db_session)
        files = _csvs(db_session, CENSUS_PID)
        by_suffix = {}
        for name, rows in files.items():
            suffix = next(s for s in self.PLANTED if name.endswith(s))
            by_suffix[suffix] = rows
        # Population: all four files, each with rows (a blind census passes by finding nothing).
        assert set(by_suffix) == set(self.PLANTED), sorted(files)
        for suffix, rows in by_suffix.items():
            header, body = rows[0], rows[1:]
            assert body, suffix
            for col in self.BLANK[suffix]:
                k = header.index(col)
                assert any(r[k] == "" for r in body), f"{suffix}:{col} has no blank — the fixture misses its branch"
            na_cols = {header[k] for r in body for k, v in enumerate(r) if v == "NA"}
            assert na_cols == self.PLANTED[suffix], (
                f"{suffix}: the text NA appears in {sorted(na_cols)}; only planted answers may "
                "carry it — a writer that spells a missing value NA makes `na = \"\"` read it as data")

    def test_every_reader_treats_only_a_blank_as_missing(self, db_session):
        _census_project(db_session)
        user = db_session.query(User).filter(User.id == 1).one()
        with zipfile.ZipFile(io.BytesIO(asyncio.run(_zip(CENSUS_PID, user, db_session)))) as zf:
            script = zf.read(next(n for n in zf.namelist() if n.endswith(".R"))).decode()
        readers = re.findall(r"read_csv\(.*", script)
        assert len(readers) == 4, readers           # data + three agreement files
        assert all('na = ""' in r for r in readers), readers
        assert "read.csv" not in script and 'c("", "NA")' not in script


@pytest.mark.skipif(not r_support.HAS_IRR, reason=r_support.SKIP_REASON_IRR)
def test_a_code_and_a_set_named_NA_keep_their_names_in_r(db_session):
    """The agreement readers: the printed line is the same either way (`sprintf`
    prints NA as `NA`), so the defect there was invisible — but the frame held
    a missing name. Sourcing the whole script and reading the frames back."""
    db = db_session
    _census_project(db)
    out, _script = _run(db, CENSUS_PID, r'''
emit("code_name_na", sum(is.na(irr_raw$code_name)))
emit("code_name_NA", sum(irr_raw$code_name == "NA", na.rm = TRUE))
emit("set_label_na", sum(is.na(irr_set_raw$set_label)))
emit("coder_blank", sum(is.na(irr_raw$coder_2)) + sum(is.na(irr_raw$coder_3)))
''')
    assert out["code_name_na"] == 0 and out["code_name_NA"] > 0
    assert out["set_label_na"] == 0
    assert out["coder_blank"] > 0                 # Option-B blanks are still NA
