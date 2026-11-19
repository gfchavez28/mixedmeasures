"""#1332 (1.5.9, D56): an answer is counted under the declared label it matches.

The import numbers a cell by comparing its text to the scale labels without case
or surrounding space, so "Strongly Agree" under a scale labelled "Strongly agree"
was stored with that label's code — while every reader that keys a CATEGORY on
the text counted it as a category of its own, after the scale: the frequency, the
cross-tab and the groups (the review's probe: `Strongly agree` 0, `Strongly Agree`
1, `strongly agree` 1). D56 of the git-ignored
the internal design notes: every such
reader asks `value_labels.answer_label_resolver`, whose rule is
`text_code_resolver`'s — the one the import numbers by. Stored cells are NOT
rewritten.

The plan named three loaders (the metric resolvers, the cross-tab, the grouping
loader); building found three more that form the same categories and would have
disagreed with them — the qualitative comparison's participant groups and its
filter (`code_analysis`), and the R script's text cells and factor levels.
`TestEveryCategoryReaderAsksTheResolver` holds all of them.
"""

import ast
import asyncio
import csv
import io
import json
import zipfile

import pytest

from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.export_r import _get_observed_values, export_r_data
from app.services import code_analysis
from app.services.comparisons import compute_group_comparison
from app.services.cross_tabulation import compute_cross_tabulation
from app.services.grouping import load_grouping_values
from app.services.metrics import compute_metric
from app.services.value_labels import answer_label_resolver
from tests.guard_support import APP_DIR, app_files

PID = 13320
AGREE, AGREE2, ORD, SEX, Y, FREE = (PID * 10 + k for k in range(1, 7))
SCALE = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"]
#: The answers as typed — each record's cell in AGREE, AGREE2 and ORD.
ANSWERS = ["Strongly agree", "Strongly Agree", "strongly agree", "Agree ", "agree",
           "Neutral", "Maybe", "Agree", "Disagree", "N/A"]
SEXES = ["Female", "female", "Male", "FEMALE", "Male", "male", "Female", "Male", "Male", "Female"]


def _col(cid, name, ctype, labels=None, **extra):
    return DatasetColumn(
        id=cid, dataset_id=PID, column_code=name, column_name=name, column_text=name,
        column_type=ctype, sequence_order=cid % 10, display_order=cid % 10,
        scale_labels=json.dumps(labels) if labels else None,
        scale_values=json.dumps(list(range(1, len(labels) + 1))) if labels else None,
        **extra)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=PID, name="Case variants", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    db.add_all([
        _col(AGREE, "agree", ColumnType.NOMINAL, SCALE),
        _col(AGREE2, "agree2", ColumnType.NOMINAL, SCALE),
        _col(ORD, "ord", ColumnType.ORDINAL, SCALE),
        _col(SEX, "sex", ColumnType.DEMOGRAPHIC, ["Female", "Male"],
             demographic_subtype="gender"),
        _col(Y, "y", ColumnType.NUMERIC),
        # A column with NO declared labels: its answers keep their spellings.
        _col(FREE, "free", ColumnType.NOMINAL),
    ])
    db.flush()
    vid = PID * 1000
    for r, (answer, sex) in enumerate(zip(ANSWERS, SEXES)):
        db.add(Participant(id=PID * 100 + r, project_id=PID, identifier=f"P{r}"))
        db.flush()
        db.add(DatasetRow(id=PID * 100 + r, dataset_id=PID, row_identifier=f"P{r}",
                          participant_id=PID * 100 + r))
        db.flush()
        code = next((i + 1.0 for i, s in enumerate(SCALE)
                     if s.lower() == answer.strip().lower()), None)
        cells = [(AGREE, answer, code), (AGREE2, answer, code), (ORD, answer, code),
                 (SEX, sex, None), (Y, str(r), float(r)),
                 (FREE, "yes" if r % 2 else "Yes", None)]
        for cid, text, num in cells:
            vid += 1
            db.add(DatasetValue(id=vid, row_id=PID * 100 + r, column_id=cid,
                                value_text=text, value_numeric=num))
    db.add(AnalysisDomain(id=PID, project_id=PID, name="Agreement"))
    db.flush()
    for i, cid in enumerate((AGREE, AGREE2)):
        db.add(AnalysisDomainMember(domain_id=PID, member_type="column", member_id=cid,
                                    sequence_order=i))
    db.flush()
    return db


def _freq(db, mid, source_type, source_id):
    md = MetricDefinition(id=mid, project_id=PID, name=f"f{mid}",
                          metric_type="frequency_distribution",
                          input_source_type=source_type, input_source_id=source_id,
                          config="{}", origin="human", stale=False)
    db.add(md)
    db.flush()
    return json.loads(compute_metric(db, md)[0].result_data)


class TestTheResolver:
    def test_a_variant_takes_its_label_and_anything_else_keeps_its_spelling(self):
        col = DatasetColumn(scale_labels=json.dumps(SCALE),
                            scale_values=json.dumps([1, 2, 3, 4, 5]))
        as_label = answer_label_resolver(col)
        assert as_label("Strongly Agree") == "Strongly agree"
        assert as_label("  strongly agree ") == "Strongly agree"
        assert as_label("Agree") == "Agree"
        assert as_label("Maybe") == "Maybe"
        assert as_label("4") == "4", "a bare code is not a label match"
        assert as_label(None) is None

    def test_a_folded_key_two_labels_share_names_neither(self):
        col = DatasetColumn(scale_labels=json.dumps(["Yes", "yes"]),
                            scale_values=json.dumps([1, 2]))
        assert answer_label_resolver(col)("YES") == "YES"

    def test_no_declared_labels_is_the_identity(self):
        assert answer_label_resolver(DatasetColumn())("Strongly Agree") == "Strongly Agree"


class TestTheThreeLoadersTheReviewNamed:
    def test_a_frequency_counts_variants_under_their_label(self, project):
        rd = _freq(project, PID + 1, "dataset_column", AGREE)
        assert rd["counts"]["Strongly agree"] == 3
        assert rd["counts"]["Agree"] == 3
        assert "Strongly Agree" not in rd["counts"] and "strongly agree" not in rd["counts"]
        assert rd["scale_order"] == SCALE + ["Maybe"], "the undeclared answer stays, after"
        assert sum(rd["counts"].values()) == 9, "N/A is still missing"

    def test_the_ordinal_frequency_now_agrees_with_its_own_numbers(self, project):
        rd = _freq(project, PID + 2, "dataset_column", ORD)
        assert rd["counts"]["Strongly agree"] == 3

    def test_a_variable_groups_pooled_frequency(self, project):
        rd = _freq(project, PID + 3, "dataset_domain", PID)
        assert rd["counts"]["Strongly agree"] == 6
        assert "Strongly Agree" not in rd["counts"]

    def test_an_answer_with_no_declared_label_keeps_its_spelling(self, project):
        rd = _freq(project, PID + 4, "dataset_column", FREE)
        assert rd["counts"] == {"Yes": 5, "yes": 5}

    def test_the_cross_tab(self, project):
        xt = compute_cross_tabulation(project, PID, AGREE, SEX)
        assert xt["row_values"] == SCALE + ["Maybe"]
        assert xt["col_values"] == ["Female", "Male"]
        row = xt["row_values"].index("Strongly agree")
        assert sum(c["count"] for c in xt["matrix"][row]) == 3
        # Records 0-2: "Female", "female", "Male" — the second is a Female.
        assert [c["count"] for c in xt["matrix"][row]] == [2, 1]

    def test_the_grouping_loader_and_the_comparison(self, project):
        groups = load_grouping_values(project, SEX, None)
        assert set(groups.values()) == {"Female", "Male"}
        cmp = compute_group_comparison(project, project_id=PID, column_ids=[Y],
                                       domain_ids=[], grouping_column_id=SEX,
                                       grouping_column_id_2=None, test_type="auto",
                                       include_effect_size_ci=False)
        assert cmp["groups"] == ["Female", "Male"]


class TestTheReadersBuildingFound:
    def test_the_qualitative_comparisons_participant_groups(self, project):
        groups = code_analysis._build_participant_group_map(project, PID, "gender", blind_scope=None)
        assert sorted(set(groups.values())) == ["Female", "Male"]
        assert sum(1 for g in groups.values() if g == "Female") == 5

    def test_and_the_same_column_named_by_id(self, project):
        """D166 — grouping by the column's id names its groups by the same rule."""
        by_id = code_analysis._build_participant_group_map(project, PID, column_id=SEX, blind_scope=None)
        assert by_id == code_analysis._build_participant_group_map(project, PID, "gender", blind_scope=None)

    def test_and_the_filter_offering_them(self, project):
        opts = code_analysis.get_demographic_filter_options(project, PID, blind_scope=None)
        gender = next(f for f in opts["filters"] if f["subtype"] == "gender")
        assert [v["value"] for v in gender["values"]] == ["Female", "Male"]
        assert gender["values"][0]["count"] == 5

    def test_the_r_scripts_cells_and_levels(self, project):
        db = project
        col = db.get(DatasetColumn, AGREE)
        assert _get_observed_values(db, col) == ["Agree", "Disagree", "Maybe",
                                                 "Neutral", "Strongly agree"]
        resp = export_r_data(project_id=PID, user=db.get(User, 1), db=db)

        async def body():
            return b"".join([c if isinstance(c, bytes) else c.encode()
                             async for c in resp.body_iterator])

        with zipfile.ZipFile(io.BytesIO(asyncio.run(body()))) as zf:
            name = next(n for n in zf.namelist() if n.endswith(".csv") and "irr" not in n)
            rows = list(csv.DictReader(io.StringIO(zf.read(name).decode("utf-8-sig"))))
        agree = [r["agree"] for r in rows]
        assert agree[:5] == ["Strongly agree"] * 3 + ["Agree"] * 2
        assert agree[6] == "Maybe" and agree[9] == "", "undeclared kept, missing blank"
        assert {r["sex"] for r in rows} == {"Female", "Male"}


def test_the_stored_cells_are_not_rewritten(project):
    _freq(project, PID + 5, "dataset_column", AGREE)
    compute_cross_tabulation(project, PID, AGREE, SEX)
    stored = [v.value_text for v in project.query(DatasetValue)
              .filter(DatasetValue.column_id == AGREE).order_by(DatasetValue.row_id)]
    assert stored == ANSWERS


# ── The readers, held to the resolver ──────────────────────────────────────────

#: Every function that forms a CATEGORY from an answer's text, and must ask the
#: resolver. A new reader of that kind joins this list; one that drops the call
#: fails here.
READERS = {
    ("services/metrics.py", "resolve_dataset_column"),
    ("services/metrics.py", "resolve_dataset_domain"),
    ("services/cross_tabulation.py", "compute_cross_tabulation"),
    ("services/grouping.py", "load_grouping_values_for_columns"),
    ("services/code_analysis.py", "_build_participant_group_map"),
    # D166 — the same groups for ONE column named by id (the comparison, the joint display).
    ("services/code_analysis.py", "_participant_groups_by_column"),
    ("services/code_analysis.py", "get_demographic_filter_options"),
    # The joint display's survey strand: a categorical variable's distribution (D167).
    ("services/joint_display.py", "_variable_strand"),
    # Joint display slice 2 (D173): a case's category, and a rule condition's category.
    ("services/joint_display_cases.py", "read_cases"),
    ("services/joint_display_cases.py", "_compile_rule"),
    ("routers/export_r.py", "_get_observed_values"),
    ("routers/export_r.py", "export_r_data"),  # `_text_cell`'s per-column labels
    # #1677 D364–D365: a numeric factor's stray code is a level labelled as the app names its
    # category, and an answer with no number is named as the app counts it.
    ("routers/export_r.py", "_observed_numeric_strays"),
    ("routers/export_r.py", "_observed_unnumbered_answers"),
}


def _callers(source: str, rel: str, name: str = "answer_label_resolver") -> set[tuple[str, str]]:
    """(file, innermost enclosing function) for every call of ``name``."""
    tree = ast.parse(source)
    found = set()

    def walk(node, func):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(child, child.name)
                continue
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) \
                    and child.func.id == name:
                found.add((rel, func))
            walk(child, func)

    walk(tree, "<module>")
    return found


class TestEveryCategoryReaderAsksTheResolver:
    def _scan(self):
        files = app_files(floor=150, sentinels=tuple(f for f, _ in READERS))
        found = set()
        for path in files:
            rel = path.relative_to(APP_DIR).as_posix()
            if rel == "services/value_labels.py":
                continue  # the definition
            found |= _callers(path.read_text(encoding="utf-8"), rel)
        return found

    def test_each_reader_asks_and_nothing_else_does_unlisted(self):
        found = self._scan()
        assert found == READERS, (
            f"missing: {sorted(READERS - found)}; unlisted: {sorted(found - READERS)}. "
            "A reader that forms a category from an answer's text asks "
            "value_labels.answer_label_resolver (#1332) — add it here with the call.")

    def test_every_listed_reader_exists(self):
        """The population check: a renamed reader is not silently 'clean'."""
        for rel, func in READERS:
            tree = ast.parse((APP_DIR / rel).read_text(encoding="utf-8"))
            names = {n.name for n in ast.walk(tree)
                     if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
            assert func in names, (rel, func)

    def test_the_scan_reports_a_reader_that_dropped_the_call(self):
        planted = (
            "def load_grouping_values_for_columns(db):\n"
            "    return {r: v for r, v in rows}\n"
            "def other(db):\n"
            "    as_label = answer_label_resolver(col)\n"
        )
        assert _callers(planted, "services/grouping.py") == {("services/grouping.py", "other")}
