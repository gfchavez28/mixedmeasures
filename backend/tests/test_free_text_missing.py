"""#1048 — a FREE-TEXT answer is a non-answer only when it IS a stock phrase.

**What was wrong, measured on the real BES file.** Importing
`BES_W30_most_important_issue.csv` reported *"172 values were recognized as
missing (Not enough Doctors and Nurses, Not enough Tory PMs to force through a
tough-on-Europe Brexit., …)"*. The recognized-N/A defaults are a PREFIX list —
right for a closed response set, where "Not enough information to say" is an
off-scale non-answer — and they were applied to open text too, where a sentence
can begin with the same words and be the answer. Of the 172, **142 were
substantive** ("Not enough housing", "Unable to trust government"); the rest
were "na", "N/A", "don't know" and "DO NOT KNOW". They left every count, the
Data Quality tab, and BOTH exports (R and Excel blank a missing cell).

**The decision (developer, 2026-09-27):** on a free-text column only an answer
that is ENTIRELY a stock phrase is a non-answer. Every other column keeps the
prefix rule. The rule is decided at READ time, so projects already imported are
corrected by the fix itself — nothing is stored differently.

**Also fixed here:** "Don’t know" typed with a typographic apostrophe (U+2019,
what a phone or a word processor writes) matched nothing on ANY column — three
BES answers, and any closed-response export written by such a tool.

**How the tests are built.** One fixture, two undeclared columns — free text and
nominal — holding answers on which the two rules DISAGREE, checked on every
surface that judges a cell. Two-sided per surface (the #592 rule): the free-text
column must KEEP what the nominal column drops, or a test cannot tell "type-aware"
from "the prefixes switched off everywhere".
"""

import ast
import asyncio
import csv
import io
import json
import types
import zipfile

import pytest
from openpyxl import load_workbook

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.models.project import Project
from app.models.user import User
from app.services import missing_values as mv
from app.services.data_quality import compute_missing_summary
from app.services.dataset_import import import_dataset_csv, preview_dataset_csv
from app.services.grouping import load_grouping_values
from app.services.metrics import resolve_dataset_column
from app.services.missing_values import (
    FREE_TEXT_DEFAULTS,
    column_missing_rules,
    describe_missing_rules,
    is_declaration,
    is_missing,
    missing_rules_for,
)
from app.services.recode import get_value_frequencies
from tests.guard_support import APP_DIR, app_files

#: A floor for a BAD ROOT, not a growth pin (#730); the sentinels are the
#: predicate owner and a site the scan exists to police.
_MIN_APP_FILES = 100
_SENTINELS = ("services/missing_values.py", "services/data_quality.py")

PID = 1048
TEXT_COL, NOMINAL_COL = 10481, 10482

# (free text, nominal) per record. Chosen where the two rules DISAGREE:
# R1/R5 are prefix matches that are real answers in free text; R3 is a stock
# phrase both rules drop; R4 is the typographic apostrophe NEITHER caught.
ROWS = [
    ("Not enough housing", "Not enough information"),
    ("Unable to trust government", "North"),
    ("N/A", "N/A"),
    ("Don’t know", "Don’t know"),
    ("fine", "Unable to say"),
]
# Which records each column's rule calls missing.
TEXT_MISSING = {3, 4}
NOMINAL_MISSING = {1, 3, 4, 5}


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=PID, name="Free text", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="survey"))
    db.flush()
    db.add(DatasetColumn(
        id=TEXT_COL, dataset_id=PID, column_code="mii", column_name="mii",
        column_text="Most important issue", column_type=ColumnType.OPEN_TEXT,
        sequence_order=0, display_order=0,
    ))
    db.add(DatasetColumn(
        id=NOMINAL_COL, dataset_id=PID, column_code="grp", column_name="grp",
        column_text="Group", column_type=ColumnType.NOMINAL,
        sequence_order=1, display_order=1,
    ))
    db.flush()
    for i, (text, nominal) in enumerate(ROWS, start=1):
        row = DatasetRow(id=PID * 10 + i, dataset_id=PID, row_identifier=f"R{i}")
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=row.id, column_id=TEXT_COL, value_text=text,
                            word_count=len(text.split())))
        db.add(DatasetValue(row_id=row.id, column_id=NOMINAL_COL, value_text=nominal))
    db.flush()
    return db


def _record(row_id: int) -> int:
    return row_id - PID * 10


# ── The rule itself ──────────────────────────────────────────────────────────


class TestTheTwoRules:
    @pytest.mark.parametrize("answer", [
        "N/A", "n/a", "NA", "na", "Na.", "Not applicable", "Don't know",
        "don’t know", "DO NOT KNOW", "I don't know.", "No answer", "no response",
        "Prefer not to say", "Decline to answer", "Unable to answer",
        "Cannot assess", "Not enough information", "  don't   know  ",
    ])
    def test_a_whole_stock_phrase_is_missing_on_free_text(self, answer):
        assert is_missing(answer, FREE_TEXT_DEFAULTS)

    @pytest.mark.parametrize("answer", [
        "Not enough housing", "Unable to trust government",
        "Don't know there are so many and all the MPs seem to do is in fighting",
        "I don't know if you've heard, but there's this COVID-19 thing",
        "Not enough doctors and nurses", "nation", "none", "(no answer)",
    ])
    def test_an_answer_that_only_begins_with_one_is_kept(self, answer):
        assert not is_missing(answer, FREE_TEXT_DEFAULTS)

    def test_the_prefix_rule_is_unchanged_for_every_other_column(self):
        """The two-sided half: the phrases free text now keeps are STILL missing
        on a closed column — a fix that switched the prefixes off would pass the
        test above and fail this one."""
        for answer in ("Not enough housing", "Unable to trust government",
                       "Prefer not to say anything"):
            assert is_missing(answer, None)

    @pytest.mark.parametrize("apostrophe", ["’", "‘", "ʼ", "`"])
    def test_a_typographic_apostrophe_is_an_apostrophe_on_every_column(self, apostrophe):
        answer = f"Don{apostrophe}t know"
        assert is_missing(answer, None)
        assert is_missing(answer, FREE_TEXT_DEFAULTS)

    def test_a_declaration_still_replaces_both(self):
        """REPLACE (#592 §I.7) is untouched: an empty declaration means nothing is
        missing, on a free-text column as anywhere."""
        assert not is_missing("N/A", [])
        assert is_missing("99", [{"value": "99"}])


class TestTheTwoListsAgree:
    """The free-text list is written out, so it is held to the prefix list by
    TESTS rather than by being derived from it."""

    def test_the_free_text_rule_is_strictly_narrower(self):
        """Everything free text calls missing, a closed column calls missing too —
        with the marks exports add. Otherwise one answer would be data in a
        nominal column and missing in a text one."""
        for phrase in mv._NA_WHOLE_ANSWERS:
            for form in (phrase, phrase.upper(), phrase + ".", phrase + "!",
                         phrase.replace("'", "’")):
                assert mv._is_na(form), f"{form!r} is missing on free text but not on a closed column"
                assert mv._is_na_whole_answer(form), form

    def test_no_prefix_drops_out_of_free_text_coverage(self):
        """Every prefix has a whole-answer completion, so no stock phrase stops
        being recognised on free text just because it was written as a fragment."""
        uncovered = [
            p for p in mv._NA_PREFIXES
            if not any(w.startswith(p) for w in mv._NA_WHOLE_ANSWERS)
        ]
        assert uncovered == []
        assert mv._NA_EXACT <= mv._NA_WHOLE_ANSWERS


class TestTheRulesForAColumn:
    def _col(self, column_type, missing_values=None):
        return DatasetColumn(column_type=column_type, missing_values=missing_values,
                             column_text="c", sequence_order=0, dataset_id=1)

    def test_the_type_picks_the_defaults(self):
        assert column_missing_rules(self._col(ColumnType.OPEN_TEXT)) is FREE_TEXT_DEFAULTS
        for t in (ColumnType.NOMINAL, ColumnType.ORDINAL, ColumnType.NUMERIC,
                  ColumnType.DEMOGRAPHIC, ColumnType.IDENTIFIER):
            assert column_missing_rules(self._col(t)) is None

    def test_the_string_form_of_the_type_works_too(self):
        """Import configs carry the type as its string value."""
        assert missing_rules_for(None, "open_text") is FREE_TEXT_DEFAULTS
        assert missing_rules_for(None, "nominal") is None
        assert missing_rules_for(None, None) is None

    def test_a_declaration_wins_whatever_the_type(self):
        """A column declared under another type and retyped keeps what was
        declared — the declaration is a statement about the data."""
        rules = [{"value": "99"}]
        col = self._col(ColumnType.OPEN_TEXT, json.dumps(rules))
        assert column_missing_rules(col) == rules
        assert is_declaration(column_missing_rules(col))
        assert not is_declaration(FREE_TEXT_DEFAULTS)
        assert not is_declaration(None)
        assert is_declaration([])

    def test_a_row_without_a_type_is_refused_not_guessed(self):
        """A query that forgot to select the type must fail, never fall back to
        the prefix rule — that is #1048 coming back on one surface, silently."""
        with pytest.raises(AttributeError):
            column_missing_rules(types.SimpleNamespace(missing_values=None))

    def test_the_marker_cannot_be_read_as_a_declaration(self):
        """Not iterable, so code treating it as a rule list fails loudly rather
        than reading "no rules" as "nothing is missing"."""
        with pytest.raises(TypeError):
            list(FREE_TEXT_DEFAULTS)
        assert mv.matched_missing_label("N/A", FREE_TEXT_DEFAULTS) is None

    def test_the_data_dictionary_names_the_narrower_rule(self):
        assert describe_missing_rules(FREE_TEXT_DEFAULTS) == "Automatic (whole answers only)"
        assert describe_missing_rules(None) == "Automatic"
        assert describe_missing_rules([]) == "Nothing missing"


# ── Every surface that judges a cell ─────────────────────────────────────────


class TestEverySurfaceJudgesByTheColumnsType:
    def test_data_quality(self, project):
        summary = compute_missing_summary(project, PID, [TEXT_COL, NOMINAL_COL])
        by_id = {v["column_id"]: v for v in summary["variables"]}
        assert by_id[TEXT_COL]["n_na"] == len(TEXT_MISSING)
        assert by_id[NOMINAL_COL]["n_na"] == len(NOMINAL_MISSING)

    def test_grouping(self, project):
        kept_text = {_record(r) for r in load_grouping_values(project, TEXT_COL, None)}
        kept_nominal = {_record(r) for r in load_grouping_values(project, NOMINAL_COL, None)}
        assert kept_text == {1, 2, 3, 4, 5} - TEXT_MISSING
        assert kept_nominal == {1, 2, 3, 4, 5} - NOMINAL_MISSING

    def test_metrics_resolver(self, project):
        for col_id, expected in ((TEXT_COL, TEXT_MISSING), (NOMINAL_COL, NOMINAL_MISSING)):
            metric = MetricDefinition(
                project_id=PID, name="m", metric_type="frequency_distribution",
                config="{}", input_source_type="dataset_column",
                input_source_id=col_id,
            )
            rows = resolve_dataset_column(metric, project)[None]
            assert {_record(r.row_id) for r in rows if r.missing} == expected

    def test_recode_frequencies(self, project):
        flagged = {f["value_text"] for f in get_value_frequencies(project, TEXT_COL) if f["is_na"]}
        assert flagged == {"N/A", "Don’t know"}

    def test_computed_column(self, project):
        """A formula reading the free-text column sees a real answer as text —
        `0`, not NULL — and a stock phrase as missing (NULL)."""
        from app.services.computed_columns import evaluate_computed_column

        comp = DatasetColumn(
            id=10489, dataset_id=PID, column_code="is_fine", column_text="is fine",
            column_type=ColumnType.NUMERIC, source="computed",
            expression='IF([mii] == "fine", 1, 0)', sequence_order=2, display_order=2,
        )
        project.add(comp)
        project.flush()
        evaluate_computed_column(project, comp)
        project.flush()
        got = {
            _record(v.row_id): v.value_numeric
            for v in project.query(DatasetValue).filter(DatasetValue.column_id == comp.id)
        }
        assert {r: got.get(r) for r in range(1, 6)} == {1: 0.0, 2: 0.0, 3: None, 4: None, 5: 1.0}

    def test_both_exports_blank_the_same_cells_and_say_why(self, project):
        from app.routers.export_excel import export_datasets_excel
        from app.routers.export_r import export_r_data

        user = project.query(User).filter(User.id == 1).one()

        async def collect(resp):
            return b"".join([c if isinstance(c, bytes) else c.encode()
                             async for c in resp.body_iterator])

        wb = load_workbook(io.BytesIO(_run(collect(
            export_datasets_excel(project_id=PID, user=user, db=project)))))
        grid = list(wb["survey"].iter_rows(values_only=True))
        headers = list(grid[0])
        excel = [dict(zip(headers, r)) for r in grid[1:]]

        raw = _run(collect(export_r_data(project_id=PID, user=user, db=project)))
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            name = next(n for n in zf.namelist() if n.endswith("_data.csv"))
            r_rows = list(csv.DictReader(io.StringIO(zf.read(name).decode("utf-8"))))

        for col, missing in (("mii", TEXT_MISSING), ("grp", NOMINAL_MISSING)):
            x_blank = {i for i, row in enumerate(excel, 1) if not (row.get(col) or "")}
            assert x_blank == missing, (col, x_blank)
        # The R data file carries the analysis columns (demographic + items) and
        # NO free text, so #1048 has nothing to blank there — asserted, so the day
        # it starts carrying free text this test asks which rule it blanks by.
        assert "mii" not in r_rows[0]
        r_blank = {i for i, row in enumerate(r_rows, 1) if not (row.get("grp") or "")}
        assert r_blank == NOMINAL_MISSING

        dictionary = next(ws for ws in wb.worksheets if "ictionary" in ws.title)
        rows = list(dictionary.iter_rows(values_only=True))
        missing_idx = rows[0].index(next(h for h in rows[0] if h and "issing" in str(h)))
        described = {r[1]: r[missing_idx] for r in rows[1:] if r and r[1] in ("mii", "grp")}
        assert described == {"mii": "Automatic (whole answers only)", "grp": "Automatic"}


# ── The import, which REPORTS what it treated as missing ─────────────────────


class TestTheImportReport:
    def test_the_report_counts_by_the_columns_type(self, db_session):
        db_session.add(Project(id=10480, name="Import", user_id=1))
        db_session.flush()
        text = "mii,grp\n" + "".join(f'"{a}","{b}"\n' for a, b in ROWS)
        result = import_dataset_csv(
            db=db_session, project_id=10480, name="d", file_contents=text,
            column_configs=[
                {"column_index": 0, "column_type": "open_text", "column_text": "mii"},
                {"column_index": 1, "column_type": "nominal", "column_text": "grp"},
            ],
        )
        db_session.flush()
        assert result["recognized_missing_count"] == len(TEXT_MISSING) + len(NOMINAL_MISSING)
        labels = set(result["recognized_missing_labels"])
        assert "Not enough information" in labels          # nominal: prefix
        assert "Not enough housing" not in labels          # free text: kept
        assert "Don’t know" in labels                      # the apostrophe

        text_col = (db_session.query(DatasetColumn)
                    .filter(DatasetColumn.column_text == "mii",
                            DatasetColumn.dataset_id == result["dataset_id"]).one())
        # The DECLARATION persisted is the config's (none) — never the defaults.
        assert text_col.missing_values is None

    def test_the_preview_counts_a_detected_text_column_by_the_whole_answer_rule(self):
        """`na_count` describes what the IMPORT will do with the column, so once
        the column is detected as free text it is counted by that rule."""
        answers = [f"Answer number {i} about the economy and housing" for i in range(40)]
        answers += ["Not enough housing", "Unable to trust government", "N/A", "Don’t know"]
        text = "comment,choice\n" + "".join(
            f'"{a}",{"Not enough information" if i % 2 else "Yes"}\n' for i, a in enumerate(answers))
        cols = {c["column_name"]: c for c in preview_dataset_csv(text)["columns"]}
        assert cols["comment"]["suggested_type"] == "open_text"
        assert cols["comment"]["na_count"] == 2
        assert cols["choice"]["suggested_type"] != "open_text"
        assert cols["choice"]["na_count"] == len(answers) // 2


def _mii_file(prefix: str, share: float, n: int = 200) -> str:
    """The audit's #1079 (a) fixture: `share` of `n` free-text answers begin with
    `prefix` (each DISTINCT), the rest are six short repeated labels."""
    import itertools
    topics = ["housing", "doctors", "jobs", "childcare", "police", "school money", "trains",
              "play areas", "carer support", "dentists"]
    places = ["in my town", "around here", "in the north", "for rural areas", "in London"]
    groups = ["for young people", "for pensioners", "for families", "for workers"]
    combos = [f"{t} {p} {g}" for t, p, g in itertools.product(topics, places, groups)]
    others = ["Immigration", "The economy", "Brexit", "Cost of living", "Europe",
              "The NHS is collapsing and nobody in government seems to care about it"]
    k = int(n * share)
    answers = [prefix + combos[i] for i in range(k)] + [others[i % len(others)] for i in range(n - k)]
    return "mii\n" + "".join(f'"{a}"\n' for a in answers)


class TestDetectionDoesNotJudgeFreeTextByThePrefixRule:
    """🔴 #1079 (a) — detection runs BEFORE a type exists, so it judged cells by
    the prefix rule: a free-text column mostly made of answers that BEGIN with a
    non-answer phrase had them removed first, and the rest looked like labels.
    Measured by the audit: NOMINAL, na_count 100 and 160 of 200 — the very
    answers #1048 set out to keep, dropped again by every read after import."""

    @pytest.mark.parametrize("share", [0.5, 0.8])
    def test_a_prefix_dominated_answer_column_is_FREE_TEXT_and_loses_nothing(self, share):
        col = preview_dataset_csv(_mii_file("Not enough ", share))["columns"][0]
        assert col["suggested_type"] == "open_text"
        assert col["na_count"] == 0

    def test_the_fixture_DISCRIMINATES_the_two_rules(self):
        """The same file judged by the prefix rule alone is what detection used to
        see — and it reads as labels. Without this, a fixture both rules call free
        text would pass against the unfixed code."""
        from app.services.dataset_import import SubstantiveValues, _detect_column_type, parse_header
        text = _mii_file("Not enough ", 0.5)
        cells = [line.strip('"') for line in text.splitlines()[1:]]
        prefix_kept = [c for c in cells if not mv.is_missing(c, None)]
        values = SubstantiveValues.from_cells(prefix_kept)
        assert _detect_column_type("mii", parse_header("mii"), values, 0)["suggested_type"] == "nominal"

    def test_the_control_prefix_is_unaffected(self):
        """"Too little" is no non-answer phrase, so nothing was ever removed — the
        audit's control, and the shape the fix brings "Not enough" level with."""
        col = preview_dataset_csv(_mii_file("Too little ", 0.5))["columns"][0]
        assert (col["suggested_type"], col["na_count"]) == ("open_text", 0)

    def test_a_CLOSED_scale_keeps_its_off_scale_non_answer_missing(self):
        """Escalation only: an Agree/Disagree item whose off-scale answer is "Not
        enough information to say" — which the prefix rule calls missing and the
        whole-answer rule does NOT (it is no stock phrase) — stays a scale with that
        answer missing. Detected under the whole-answer rule instead, the phrase
        would be back in the substantive set and reported as an UNMATCHED value, a
        suspected typo, on the wizard's review (measured; a mutant that swapped
        unconditionally survived until this assertion existed)."""
        values = ["Agree", "Disagree", "Neither agree nor disagree", "Strongly agree",
                  "Strongly disagree", "Not enough information to say"] * 10
        text = "q1\n" + "".join(f'"{v}"\n' for v in values)
        col = preview_dataset_csv(text)["columns"][0]
        assert col["suggested_type"] == "ordinal"
        assert col["na_count"] == 10
        assert "Not enough information to say" not in (col["suggested_scale_unmatched"] or [])

    def test_a_categorical_column_with_a_few_non_answers_stays_categorical(self):
        values = (["Yes", "No", "Sometimes"] * 20) + ["Unable to say", "Unable to answer"]
        text = "q2\n" + "".join(f'"{v}"\n' for v in values)
        col = preview_dataset_csv(text)["columns"][0]
        assert col["suggested_type"] == "nominal"
        assert col["na_count"] == 2


# ── The guard: rules are DERIVED, the declaration is only REPORTED ───────────


#: `parse_missing_rules` returns a column's DECLARATION and nothing else. These
#: sites report or replace the declaration itself, so the raw declaration is
#: what they want; every site that JUDGES a cell goes through
#: `column_missing_rules` / `missing_rules_for`, which add the defaults the
#: column's TYPE calls for (#1048).
DECLARATION_READERS = {
    # `_column_to_response` — the declaration on the wire, for the tri-state
    # editor (null = Automatic, [] = Nothing missing).
    "routers/dataset.py": 1,
    # The declare endpoint's and the bulk endpoint's responses.
    "routers/recode.py": 2,
    # The declaration being REPLACED, iterated for its labels. Both doors refuse
    # free-text columns before calling it, so its defaults are the prefixes.
    "services/missing_declaration.py": 1,
}


def _parse_calls() -> dict[str, int]:
    hits: dict[str, int] = {}
    for path in app_files(floor=_MIN_APP_FILES, sentinels=_SENTINELS):
        rel = path.relative_to(APP_DIR).as_posix()
        if rel == "services/missing_values.py":
            continue
        tree = ast.parse(path.read_text())
        n = sum(
            1 for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", getattr(node.func, "attr", None)) == "parse_missing_rules"
        )
        if n:
            hits[rel] = n
    return hits


class TestRulesAreDerivedNotParsed:
    def test_the_walk_sees_the_app(self):
        """Population self-check (#730): a scan that finds nothing passes."""
        files = app_files(floor=_MIN_APP_FILES, sentinels=_SENTINELS)
        assert (APP_DIR / "services" / "missing_values.py") in files

    def test_only_declaration_readers_parse_the_declaration(self):
        assert _parse_calls() == DECLARATION_READERS, (
            "A new `parse_missing_rules(...)` call outside the declaration readers: "
            "if it JUDGES cells, use `column_missing_rules(column)` or "
            "`missing_rules_for(declared, column_type)` — the raw declaration "
            "gives a free-text column the prefix rule #1048 took it off."
        )

    def test_the_scan_would_catch_one(self):
        """Predicate falsifier: the matcher fires on both call spellings."""
        tree = ast.parse("from x import parse_missing_rules as p\n"
                         "a = parse_missing_rules(c)\nb = mv.parse_missing_rules(c)\n")
        found = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and getattr(n.func, "id", getattr(n.func, "attr", None)) == "parse_missing_rules"]
        assert len(found) == 2
