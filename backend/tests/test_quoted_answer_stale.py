"""#1368 D4 — a computed column of the shape `[col] == "text"` computed by an older version
arrives marked OUT OF DATE, by both doors an older value can come in by.

Since #1368 the evaluator reads `[q1] == "Agree"` as the cell's ANSWER; before, it
compared the quoted text with the spelling of the cell's number, so on a labelled column
the comparison was FALSE on every row. The stored values are the old evaluator's until
Recompute, and nothing recomputes by itself. So:

1. migration `b5d1f7a3c9e2` marks every such column already in a database — run here on
   a SCRATCH database built to the revision before it (`a7c3e9f1d2b4`), up and down;
2. its frozen TEXT test is a SUPERSET of the app's own detector
   (`computed_columns.compares_a_quoted_answer`) — over-marking is accepted (D4), missing
   one is not;
3. the `.mmproject` import marks the same for a file whose manifest states an earlier
   `app_version` — scoped to what the import WROTE (#714).
"""
import importlib.util
import json
import random
import uuid as _uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from sqlalchemy.orm import Session

from app import config
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.user import User
from app.services import computed_columns as cc
from app.services.computed_columns import compares_a_quoted_answer, evaluate_computed_column
from app.services.dataset_import import import_dataset_csv
from app.services.project_portability import export_project, import_project
from tests.archive_support import archive_extras, archive_payload, write_archive

REVISION = "b5d1f7a3c9e2"
BEFORE = "a7c3e9f1d2b4"
_SCRIPTS = config.resource_base() / "alembic"


def _load_revision():
    path = next((_SCRIPTS / "versions").glob(f"{REVISION}_*.py"))
    spec = importlib.util.spec_from_file_location(f"_rev_{REVISION}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MIGRATION = _load_revision()


# Formulas with the shape (each must be marked) and without it (each must not).
SHAPED = [
    '[q1] == "Agree"',
    '[q1] != "Agree"',
    '"Agree" == [q1]',
    '( [q1] ) == ( "Agree" )',
    '(("Agree"))!=(([q1]))',
    'IF([q1] == "Agree", 1, 0)',
    'NOT [q1] == "Agree"',
    'COALESCE([a], 0) + IF("x"==[b], 1, 2)',
    '[town]\t==\t"North"',
]
UNSHAPED = [
    '[q1] == 4',
    '[q1] * 2',
    '[q1] == [q7]',
    'IF([q1] > 3, 1, 0)',
    'IS_MISSING([q1])',
]
# The text test's accepted over-marks: no direct column-against-text comparison.
OVER_MARKED = ['[a] + [b] == "x"', '-[a] == "x"']


# ── 2. The frozen text test is a superset of the app's detector ───────────────────

@pytest.mark.parametrize("expr", SHAPED)
def test_both_detectors_find_the_shape(expr):
    assert compares_a_quoted_answer(expr)
    assert MIGRATION._compares_a_quoted_text(expr)


@pytest.mark.parametrize("expr", UNSHAPED)
def test_neither_detector_fires_without_it(expr):
    """The predicate falsifier: a detector that answers True for everything fails here."""
    assert not compares_a_quoted_answer(expr)
    assert not MIGRATION._compares_a_quoted_text(expr)


@pytest.mark.parametrize("expr", OVER_MARKED)
def test_the_text_test_over_marks_where_D4_accepts_it(expr):
    assert not compares_a_quoted_answer(expr)
    assert MIGRATION._compares_a_quoted_text(expr)


def _spaces(rng):
    return rng.choice(["", " ", "  ", "\t"])


def _expr(rng, depth):
    s = _spaces
    if depth == 0 or rng.random() < 0.25:
        out = rng.choice(['[q1]', '[Q 2]', '[a"b]', '"Agree"', '"a]"', '""', '4', '2.5'])
    else:
        kind = rng.choice(["bin", "bin", "bin", "neg", "not", "if", "fn"])
        a = _expr(rng, depth - 1)
        b = _expr(rng, depth - 1)
        if kind == "bin":
            op = rng.choice(["==", "!=", "==", "!=", "<", ">=", "+", "-", "*", "/", "AND", "OR"])
            out = f"{a}{s(rng)}{op}{s(rng)}{b}" if op not in ("AND", "OR") else f"{a} {op} {b}"
        elif kind == "neg":
            out = f"-{s(rng)}{a}"
        elif kind == "not":
            out = f"NOT {a}"
        elif kind == "if":
            out = f"IF({a},{s(rng)}{b},{s(rng)}{_expr(rng, depth - 1)})"
        else:
            out = f"COALESCE({s(rng)}{a},{s(rng)}{b})"
    for _ in range(rng.choice([0, 0, 1, 2])):
        out = f"({s(rng)}{out}{s(rng)})"
    return out


def test_every_formula_the_app_reads_differently_the_migration_marks():
    """The superset, over a generated corpus of formulas that PARSE.

    Population and discrimination self-checks: the corpus must hold formulas with the
    shape, formulas without it, and formulas only the text test marks — or a corpus
    that missed the shape entirely would pass this by finding nothing.
    """
    rng = random.Random(1368)
    parsed = shaped = over = neither = 0
    missed = []
    for _ in range(6000):
        expr = _expr(rng, 3)
        try:
            cc.parse(expr)
        except cc.ExpressionError:
            continue
        parsed += 1
        app_says = compares_a_quoted_answer(expr)
        text_says = MIGRATION._compares_a_quoted_text(expr)
        if app_says and not text_says:
            missed.append(expr)
        shaped += app_says
        over += text_says and not app_says
        neither += not (app_says or text_says)
    assert not missed, f"the migration would leave these out of date unmarked: {missed[:5]}"
    # measured with this seed: 5,372 parsed, 224 shaped, 134 over-marked, 5,014 neither
    assert parsed > 3000 and shaped > 150 and over > 50 and neither > 1000, (
        parsed, shaped, over, neither,
    )


# ── 1. The migration, on a scratch database built to the revision before it ───────

def _alembic(db: Path) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(_SCRIPTS))
    cfg.attributes["mm_database_path"] = str(db)
    return cfg


def _stale_by_text(engine) -> dict[str, bool]:
    with engine.connect() as conn:
        return {
            text: bool(stale) for text, stale in conn.execute(sa.text(
                "SELECT column_text, stale FROM dataset_columns"
            ))
        }


def test_the_migration_marks_the_shape_up_and_down(tmp_path):
    db = tmp_path / "scratch.db"
    cfg = _alembic(db)
    command.upgrade(cfg, BEFORE)

    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with Session(engine) as s:
            s.add(User(id=1, username="R", password_hash="x", is_admin=True))
            s.flush()
            p = Project(name="P", user_id=1)
            s.add(p)
            s.flush()
            # A Core insert, not `Dataset(...)`: the ORM names every column TODAY's model
            # declares, and the scratch database stands at `BEFORE` — a column a later
            # revision adds (`managed_rater_ids`, `f2a6c8d4b1e7`) is not there yet.
            ds_id = s.execute(
                sa.insert(Dataset.__table__).values(project_id=p.id, name="D")
            ).inserted_primary_key[0]
            n = 0

            def col(text, *, source="computed", expression=None, stale=False):
                nonlocal n
                n += 1
                s.add(DatasetColumn(
                    dataset_id=ds_id, column_code=f"c{n}", column_text=text,
                    column_type=ColumnType.NUMERIC, sequence_order=n, display_order=n,
                    source=source, expression=expression, stale=stale,
                ))

            for i, e in enumerate(SHAPED):
                col(f"shaped {i}", expression=e)
            for i, e in enumerate(UNSHAPED):
                col(f"unshaped {i}", expression=e)
            col("already stale", expression="[q1] * 2", stale=True)
            col("stale is NULL", expression="[q1] * 2", stale=None)
            col("imported", source="imported")
            # an expression on a column that is not computed is never evaluated
            col("not computed", source="manual", expression='[q1] == "Agree"')
            s.commit()

        before = _stale_by_text(engine)
        assert not any(v for k, v in before.items() if k != "already stale")

        command.upgrade(cfg, REVISION)
        after = _stale_by_text(engine)
        for i in range(len(SHAPED)):
            assert after[f"shaped {i}"] is True, SHAPED[i]
        for i in range(len(UNSHAPED)):
            assert after[f"unshaped {i}"] is False, UNSHAPED[i]
        assert after["already stale"] is True
        assert after["stale is NULL"] is False
        assert after["imported"] is False
        assert after["not computed"] is False
        with engine.connect() as conn:
            assert conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == REVISION

        # Down: a column recomputed under this revision holds the NEW rule's values,
        # which the older evaluator reads the old way — the same set is marked again.
        with engine.begin() as conn:
            conn.execute(sa.text("UPDATE dataset_columns SET stale = 0"))
        command.downgrade(cfg, BEFORE)
        down = _stale_by_text(engine)
        assert {k for k, v in down.items() if v} == {f"shaped {i}" for i in range(len(SHAPED))}
        with engine.connect() as conn:
            assert conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == BEFORE

        # and up again is clean
        command.upgrade(cfg, "head")
        assert _stale_by_text(engine) == down
    finally:
        engine.dispose()


# ── 3. The `.mmproject` import ─────────────────────────────────────────────────────

LIKERT = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"]
CONFIGS = [
    {"column_index": 0, "column_type": "ordinal", "column_text": "Q1", "column_code": "q1",
     "scale_labels": LIKERT},
    {"column_index": 1, "column_type": "nominal", "column_text": "Town", "column_code": "town"},
]
CSV = "Q1,Town\nAgree,North\nDisagree,South\nAgree,North\n"
FORMULAS = {
    "agrees": '[q1] == "Agree"',
    "if agrees": 'IF([q1] == "Agree", 1, 0)',
    "not north": '"North" != [town]',   # a text column: over-marked, as D4 accepts
    "doubled": "[q1] * 2",
    "is four": "[q1] == 4",
}
SHAPED_NAMES = {"agrees", "if agrees", "not north"}


def _project(db) -> int:
    p = Project(name="P", user_id=1, project_uuid=str(_uuid.uuid4()))
    db.add(p)
    db.flush()
    dsid = import_dataset_csv(db, p.id, "D", CONFIGS, CSV)["dataset_id"]
    for i, (name, expr) in enumerate(FORMULAS.items()):
        c = DatasetColumn(dataset_id=dsid, column_code=f"x{i}", column_text=name,
                          column_type=ColumnType.NUMERIC, sequence_order=50 + i,
                          display_order=50 + i, source="computed", expression=expr,
                          depends_on_column_ids="[]", stale=False)
        db.add(c)
        db.flush()
        evaluate_computed_column(db, c)
    db.flush()
    return p.id


def _file(db, pid, tmp_path: Path, app_version) -> Path:
    buf = export_project(db, pid, tmp_path / "docs")
    manifest = json.loads(__import__("zipfile").ZipFile(buf).read("manifest.json"))
    if app_version is None:
        manifest.pop("app_version", None)
    else:
        manifest["app_version"] = app_version
    dst = tmp_path / f"file-{app_version}.mmproject"
    return write_archive(dst, manifest, archive_payload(buf), archive_extras(buf))


def _stale_in(db, pid) -> dict[str, bool]:
    db.expire_all()
    return {
        c.column_text: bool(c.stale)
        for c in db.query(DatasetColumn).join(Dataset).filter(
            Dataset.project_id == pid, DatasetColumn.source == "computed",
        )
    }


@pytest.mark.parametrize("app_version", ["1.5.7", "1.4.2", "", None])
def test_an_older_file_arrives_with_its_shaped_columns_out_of_date(db_session, tmp_path, app_version):
    db = db_session
    f = _file(db, _project(db), tmp_path, app_version)
    new_pid, _ = import_project(db, f, tmp_path / "docs", user_id=1)
    db.flush()
    stale = _stale_in(db, new_pid)
    assert set(stale) == set(FORMULAS)
    assert {k for k, v in stale.items() if v} == SHAPED_NAMES


@pytest.mark.parametrize("app_version", [cc.QUOTED_ANSWER_RULE_VERSION, "1.5.10", "2.0.0"])
def test_a_file_from_this_rule_on_keeps_its_flags(db_session, tmp_path, app_version):
    """`1.5.10` is LATER than `1.5.8` — a string comparison says otherwise."""
    db = db_session
    f = _file(db, _project(db), tmp_path, app_version)
    new_pid, _ = import_project(db, f, tmp_path / "docs", user_id=1)
    db.flush()
    assert not any(_stale_in(db, new_pid).values())


def _drop_cell_of(db, pid, column_text) -> None:
    col = db.query(DatasetColumn).join(Dataset).filter(
        Dataset.project_id == pid, DatasetColumn.column_text == column_text,
    ).one()
    first = db.query(DatasetValue).filter(DatasetValue.column_id == col.id).order_by(
        DatasetValue.row_id,
    ).first()
    db.delete(first)
    db.flush()


def _merge(db, pid, f, tmp_path):
    import_project(db, f, tmp_path / "docs", user_id=1, import_mode="merge",
                   target_project_id=pid, report={})
    db.flush()


def test_a_merge_marks_a_matched_column_that_received_the_older_files_cells(db_session, tmp_path):
    """#714: on a merge the column is the TARGET's; it is marked only because cells the
    older evaluator stored were written into it."""
    db = db_session
    pid = _project(db)
    f = _file(db, pid, tmp_path, "1.5.7")
    _drop_cell_of(db, pid, "agrees")
    _merge(db, pid, f, tmp_path)
    stale = _stale_in(db, pid)
    assert stale["agrees"] is True
    # shaped, but matched and written nothing into: the target's own flag stands
    assert stale["if agrees"] is False and stale["not north"] is False
    assert db.query(DatasetRow).join(Dataset).filter(Dataset.project_id == pid).count() == 3


def test_a_merge_that_writes_no_cell_marks_nothing(db_session, tmp_path):
    db = db_session
    pid = _project(db)
    f = _file(db, pid, tmp_path, "1.5.7")
    _merge(db, pid, f, tmp_path)
    assert not any(_stale_in(db, pid).values())
