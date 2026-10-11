"""#973 (b') — the import preview streams, and reads the file positionally.

`preview_dataset_csv` used to hold every cell of every column at once
(`col_all_values`) and peaked at 531 MB on a 36 MB file sitting exactly at
`MAX_DATASET_CELLS` — over the ~450 MB transient allowance, and not stopped by
the 50 MB byte cap. It now tallies distinct values as it reads, so peak scales
with a column's CARDINALITY rather than with its rows.

⚠️ **The tally is NOT what paid for that, and the entry said it would be.**
Measured: dedup alone took the cap case to 644 MB — WORSE — because the old
per-column sets were transient and these are all live at once. What paid for it
is `_csv_lines` replacing `io.StringIO(text)`, which stores UCS-4 at 4.00 bytes
per character. The tally earns its place on REAL corpora, where values repeat
(BES 283 → 160 MB), and on time (`is_missing` once per distinct value).

Two defects fell out of the same change, both reproduced before it and both
caused by this being the ONE reader of the CSV text keyed by header NAME while
every other reader (`_scan_source_rows`, `import_dataset_csv`'s write loop,
`append_preview`) is positional:

* a row with fewer cells than headers made `csv.DictReader` pad with ``None``,
  and ``None.strip()`` raised `AttributeError` — which `preview_dataset`'s
  ``except (ValueError, csv.Error, TypeError)`` does not catch, so an ordinary
  ragged CSV answered **500** while the importer accepted the same file;
* two columns sharing a header collapsed into one dict key, so both preview
  columns described the SECOND column's values and every value was tallied
  twice.

⚠️ **Blank lines were deliberately NOT decided here**, and were filed as #983
("is a blank line a respondent?" is a data question, not a memory one). #983
decided it: every reader goes through `CsvRecords`, and a blank line is a record
only in a one-column file — see `test_csv_records.py`.
"""
import ast
import csv
import io
import pathlib
import tracemalloc

import pytest

from app.models.dataset import DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.services import dataset_import as di
from app.services.dataset_import import (
    SubstantiveValues,
    _csv_lines,
    _is_identifier_column,
    import_dataset_csv,
    preview_dataset_csv,
)


def _by_index(result: dict) -> dict[int, dict]:
    return {c["column_index"]: c for c in result["columns"]}


# ── A ragged row is empty cells, not a crash ─────────────────────────────────


class TestARaggedRowIsEmptyCells:
    def test_a_short_row_does_not_raise(self):
        """The regression proper. Before the fix this raised AttributeError,
        which the preview endpoint does not catch — so the researcher met a
        500 on a file the importer would have accepted."""
        result = preview_dataset_csv("a,b,c\n1,2\n3,4,5\n")

        assert result["total_rows"] == 2
        third = _by_index(result)[2]
        assert third["empty_count"] == 1
        assert third["empty_percent"] == 50.0
        assert third["sample_values"] == ["5"]

    def test_a_row_with_no_cells_at_all_is_still_a_row(self):
        """``a,b\\n,\\n`` is a record of two blanks — distinct from the blank
        LINE case below, which has no commas and is skipped."""
        result = preview_dataset_csv("a,b\n,\n1,2\n")

        assert result["total_rows"] == 2
        assert _by_index(result)[0]["empty_count"] == 1

    def test_surplus_cells_beyond_the_header_are_dropped(self):
        """Unchanged: `DictReader` put them under its `restkey` and nothing
        read it. `zip` against the header list does the same."""
        result = preview_dataset_csv("a,b\n1,2,99\n")

        assert [c["sample_values"] for c in result["columns"]] == [["1"], ["2"]]

    def test_the_preview_agrees_with_what_the_import_stores(self, db_session):
        """The claim that makes the choice above correct rather than merely
        uncrashing: a short row's trailing cells are ABSENT, and absent is what
        the import writes for them (`if col_idx >= len(data_row): continue`).

        Entered at the pipeline's mouth — a preview and a real import of the
        SAME text — because the two used different readers, which is exactly
        the class a unit test of either one alone cannot see.
        """
        text = "pid,score,note\nP1,5,ok\nP2,6\nP3,7,fine\n"
        db_session.add(Project(id=9731, name="Ragged", user_id=1))
        db_session.flush()

        preview = preview_dataset_csv(text)
        configs = [
            {
                "column_index": c["column_index"],
                "column_type": c["suggested_type"],
                "column_text": c["suggested_column_text"],
            }
            for c in preview["columns"]
        ]
        import_dataset_csv(
            db=db_session, project_id=9731, name="Ragged",
            column_configs=configs, file_contents=text,
        )
        db_session.flush()

        note_col = (
            db_session.query(DatasetColumn)
            .filter(DatasetColumn.column_text == "note")
            .one()
        )
        stored = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == note_col.id)
            .count()
        )
        rows = (
            db_session.query(DatasetRow)
            .filter(DatasetRow.dataset_id == note_col.dataset_id)
            .count()
        )

        note_preview = _by_index(preview)[2]
        assert rows == preview["total_rows"] == 3
        # One row of three carried no `note` cell: the preview says one empty,
        # the import stores two values. Those are the same claim.
        assert note_preview["empty_count"] == 1
        assert stored == rows - note_preview["empty_count"] == 2


# ── Two columns with one header are still two columns ────────────────────────


class TestDuplicateHeadersDescribeTheirOwnColumn:
    def test_each_position_reports_its_own_values(self):
        """Before the fix both reported ``['22', '55']`` — the SECOND column's
        values — because the row dict kept only the last key."""
        result = preview_dataset_csv("age,age,b\n11,22,33\n44,55,66\n")
        cols = _by_index(result)

        assert cols[0]["sample_values"] == ["11", "44"]
        assert cols[1]["sample_values"] == ["22", "55"]
        assert cols[2]["sample_values"] == ["33", "66"]

    def test_the_empty_count_is_not_doubled(self):
        """The visible symptom: each row appended once PER duplicate header, so
        a duplicated column's counts were multiples of the row count and
        `empty_percent` could exceed 100."""
        result = preview_dataset_csv("age,age\n,5\n,6\n")
        cols = _by_index(result)

        assert cols[0]["empty_count"] == 2
        assert cols[0]["empty_percent"] == 100.0
        assert cols[1]["empty_count"] == 0
        for col in result["columns"]:
            assert 0.0 <= col["empty_percent"] <= 100.0


class TestBlankLinesAreStillSkipped:
    def test_a_blank_line_does_not_become_a_row(self):
        """In a file of two or more columns (#983 — `CsvRecords`; the import
        now agrees, see `test_csv_records.py`)."""
        assert preview_dataset_csv("a,b\n1,2\n\n3,4\n")["total_rows"] == 2

    def test_a_trailing_newline_is_not_a_row(self):
        assert preview_dataset_csv("a,b\n1,2\n")["total_rows"] == 1


# ── The line reader that replaced io.StringIO ────────────────────────────────


#: Every shape that could make a hand-rolled line splitter disagree with
#: `io.StringIO`. The multi-line quoted field is the one that matters most:
#: `csv.reader` pulls FURTHER lines from the iterator itself to finish a quoted
#: field, so a splitter that got terminators wrong would silently merge or split
#: records rather than raise.
AWKWARD_CSV = [
    "",
    "\n",
    "a,b\n",
    "a,b",                                    # no trailing newline
    "a,b\n1,2\n",
    "a,b\r\n1,2\r\n",                         # CRLF
    "a,b\n1,2",                               # last row unterminated
    "a,b\n\n1,2\n",                           # blank line between records
    "a,b\n1,2\n\n",                           # trailing blank line
    'a,b\n"line one\nline two",2\n',          # quoted field spanning lines
    'a,b\n"he said ""hi""",2\n',              # escaped quotes
    'a,b\n"trailing\r\nCRLF inside",2\n',     # CRLF inside a quoted field
    "a,b\n,\n",                               # all-empty record
    "a,b\n1,2,3\n",                           # surplus cell
    "a,b,c\n1,2\n",                           # short row
    "a\né中\U0001f600\n",            # latin-1 / BMP / astral
]


def _reader_calls_in(source: str) -> list[tuple[int, str, str, str, bool]]:
    """Every CSV reader built in ``source``: `csv.reader(X)`, `csv.DictReader(X)` and
    the shared `csv_reader(X)` (#1127), as (lineno, the callee building X, the dotted
    name of the def/class the call sits in — "" at module level, which reader, and
    whether it passes ``strict=True``)."""
    tree = ast.parse(source)
    out: list[tuple[int, str, str, str, bool]] = []

    def kind_of(func) -> str | None:
        if (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "csv"
            and func.attr in ("reader", "DictReader")
        ):
            return f"csv.{func.attr}"
        if isinstance(func, ast.Name) and func.id == "csv_reader":
            return "csv_reader"
        return None

    def visit(node, scope: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                visit(child, f"{scope}.{child.name}" if scope else child.name)
                continue
            if isinstance(child, ast.Call) and (kind := kind_of(child.func)):
                arg = child.args[0] if child.args else None
                name = ""
                if isinstance(arg, ast.Call):
                    f = arg.func
                    name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
                strict = any(
                    k.arg == "strict" and isinstance(k.value, ast.Constant) and k.value.value is True
                    for k in child.keywords
                )
                out.append((child.lineno, name, scope, kind, strict))
            visit(child, scope)

    visit(tree, "")
    return out


class TestOneReaderOfDatasetCsv:
    """Every read of imported CSV text goes through ONE strict reader, fed by
    `_csv_lines` — the dataset doors through `CsvRecords`, plus the coding import and
    (since #1127) the transcript import.

    Three properties, one scan. `_csv_lines` exists to drop a 4-bytes-per-character
    copy of the file (144 MB on a 36 MB upload), so a reader that bypasses it costs
    memory silently; since #983/#985 `CsvRecords` is what decides what a RECORD is and
    notices a too-long one; and since #1127 `dataset_import.csv_reader` is the ONE
    `csv.reader`, and it is STRICT — a reader built anywhere else in these modules is
    a lenient one, where a stray quotation mark swallows records silently. The
    transcript import had exactly that, a `csv.DictReader(io.StringIO(text))`, until
    #1127; the append steps had `csv.reader(io.StringIO(...))` until #983.

    ⚠️ **AST, not a source scan.** `_csv_lines`'s own docstring and several
    comments write `io.StringIO(text)` in PROSE to explain why not to use it; a
    regex would report those as violations (#772's phantom class).
    """

    APP = pathlib.Path(di.__file__).parent.parent
    MODULES = {
        "services/dataset_import.py": APP / "services" / "dataset_import.py",
        "routers/dataset.py": APP / "routers" / "dataset.py",
        "services/coding_import.py": APP / "services" / "coding_import.py",
        "services/csv_import.py": APP / "services" / "csv_import.py",
    }
    # Where `csv_reader` must be called — the population a blind scan would miss.
    EXPECTED_CALLERS = {
        ("services/dataset_import.py", "CsvRecords.__init__"),
        ("services/coding_import.py", "parse_rows"),
    }

    def _calls(self):
        return [
            (name, *call)
            for name, path in self.MODULES.items()
            for call in _reader_calls_in(path.read_text())
        ]

    def test_the_population_is_found(self):
        """A scan whose expected result is empty passes by finding nothing — so it
        names what it must see: the one reader, and each place that calls it."""
        calls = self._calls()
        found = {(m, scope, kind) for m, _ln, _n, scope, kind, _s in calls}
        assert ("services/dataset_import.py", "csv_reader", "csv.reader") in found, (
            f"the one csv.reader (in `csv_reader`) not found in {calls} — the scan has rotted"
        )
        callers = {(m, scope) for m, scope, kind in found if kind == "csv_reader"}
        assert self.EXPECTED_CALLERS <= callers, (
            f"csv_reader callers {callers} lack {self.EXPECTED_CALLERS - callers}"
        )

    def test_the_transcript_import_reads_through_CsvRecords(self):
        """It holds no reader of its own — it reads `CsvRecords`, which is how it gets
        the BOM strip, the record rule, the too-long report and the sentence."""
        tree = ast.parse(self.MODULES["services/csv_import.py"].read_text())
        assert any(
            isinstance(n, ast.Call) and getattr(n.func, "id", None) == "CsvRecords"
            for n in ast.walk(tree)
        )

    def test_every_reader_is_the_one(self):
        offenders = [
            c for c in self._calls()
            if c[4] != "csv_reader" and (c[0], c[3]) != ("services/dataset_import.py", "csv_reader")
        ]
        assert offenders == [], (
            f"a CSV reader outside `dataset_import.csv_reader`: {offenders}. Read "
            "imported CSV text through `csv_reader` (strict, #1127) — for dataset text "
            "through `CsvRecords`, which owns the record rule (#983) and the too-long "
            "report (#985)."
        )

    def test_the_one_reader_is_STRICT(self):
        """The behaviour is pinned in `test_csv_strict_reading.py`; this pins the
        argument, so a reader that loses it fails here with its line."""
        ones = [c for c in self._calls() if c[4] == "csv.reader"]
        assert ones and all(strict for *_rest, strict in ones), ones

    def test_no_reader_constructs_a_StringIO(self):
        offenders = [c for c in self._calls() if c[2] == "StringIO"]
        assert offenders == [], (
            f"a CSV reader over io.StringIO(...) at {offenders} — that buffer is UCS-4 "
            "at 4.00 B/char (144 MB on a 36 MB file). Use _csv_lines(text)."
        )

    def test_every_csv_reader_call_is_fed_by_csv_lines(self):
        offenders = [c for c in self._calls() if c[4] == "csv_reader" and c[2] != "_csv_lines"]
        assert offenders == [], offenders

    def test_the_scan_would_catch_one(self):
        """The predicate falsifiers: a matcher that never fires is a pass that
        means nothing, and the AST shapes above are easy to get subtly wrong."""
        planted = _reader_calls_in(
            "import csv, io\n"
            "def csv_reader(lines):\n"
            "    return csv.reader(lines, strict=True)\n"
            "class CsvRecords:\n"
            "    def __init__(self, t):\n"
            "        self.r = csv_reader(_csv_lines(t))\n"
            "def append_preview(t):\n"
            "    for r in csv.reader(io.StringIO(t)): pass\n"
            "def preview_csv(t):\n"
            "    return csv.DictReader(io.StringIO(t))\n"
        )
        assert [(n, s, k, strict) for _ln, n, s, k, strict in planted] == [
            ("", "csv_reader", "csv.reader", True),
            ("_csv_lines", "CsvRecords.__init__", "csv_reader", False),
            ("StringIO", "append_preview", "csv.reader", False),
            ("StringIO", "preview_csv", "csv.DictReader", False),
        ]


class TestCsvLinesMatchesStringIO:
    """`_csv_lines` exists to drop a 4-bytes-per-character copy of the file, so
    it has to be byte-identical to what it replaced, not merely plausible."""

    @pytest.mark.parametrize("text", AWKWARD_CSV)
    def test_the_reader_sees_the_same_rows(self, text):
        assert list(csv.reader(_csv_lines(text))) == list(
            csv.reader(io.StringIO(text))
        )

    @pytest.mark.parametrize("text", AWKWARD_CSV)
    def test_the_lines_themselves_are_identical(self, text):
        assert list(_csv_lines(text)) == list(io.StringIO(text))

    def test_it_does_not_copy_the_file(self):
        """The reason it exists. `io.StringIO` is 4.0 B/char; this is O(1) plus
        one line, so the bound is a small multiple of the longest line."""
        text = "a,b\n" + "".join(f"{i},{i}\n" for i in range(20_000))

        tracemalloc.start()
        try:
            consumed = sum(1 for _ in _csv_lines(text))
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert consumed == 20_001
        assert peak < 10_000, f"peak {peak:,}B — this is holding more than a line"


# ── The streaming property itself ────────────────────────────────────────────


class TestThePreviewDoesNotRetainEveryCell:
    """The memory claim, asserted structurally rather than by a peak figure.

    ⚠️ A threshold on RSS would be a flake; the discriminating property is that
    peak allocation tracks CARDINALITY, so a corpus with many rows and few
    distinct values must cost far less than its own text.
    """

    def test_peak_allocation_is_a_fraction_of_the_input(self):
        """20,000 records × 4 columns, 2–5 distinct values each.

        MEASURED on this exact fixture, old implementation vs new:
        **1,880,686 B (11.75× the text) → 27,713 B (0.17×)**. The bound below
        sits at 0.5×, which is ~3× above the measured value and ~23× below the
        behaviour it exists to catch.

        ⚠️ **The warm-up call is load-bearing, and its absence is what made the
        first version of this test nearly flake.** A cold call also allocates
        this module's compiled regexes and scale tables — ~126 KB, five times
        the figure being asserted — so a bound tight enough to be meaningful
        would have passed or failed on whether another test ran first.
        """
        rows = 20_000
        text = "a,b,c,d\n" + "".join(
            f"{i % 3},{i % 4},{i % 2},{i % 5}\n" for i in range(rows)
        )
        preview_dataset_csv("a,b\n1,2\n")  # warm the module's caches

        tracemalloc.start()
        try:
            result = preview_dataset_csv(text)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert result["total_rows"] == rows
        assert peak < len(text) / 2, (
            f"peak {peak:,}B for {len(text):,}B of text ({peak / len(text):.2f}x) — "
            "the preview is retaining cells rather than tallying distinct values"
        )

    def test_missing_ness_is_asked_once_per_distinct_value(self, monkeypatch):
        """`is_missing` is a pure function of (text, rules), so a column with
        20,000 cells and three kinds is three questions, not 20,000.

        This is also the guard on the tally being a DEDUPLICATED structure: a
        per-cell classification pass would answer correctly and cost 3.1M calls
        on the real GSS corpus.
        """
        calls: list[str] = []
        real = di.is_missing

        def counting(value, rules):
            calls.append(value)
            return real(value, rules)

        monkeypatch.setattr(di, "is_missing", counting)

        text = "a\n" + "".join(f"{i % 3}\n" for i in range(20_000))
        preview_dataset_csv(text)

        assert sorted(calls) == ["0", "1", "2"], calls


# ── The derived statistics still count cells ─────────────────────────────────


class TestTheDerivedStatisticsCountCells:
    """Every per-column figure used to be a walk over a CELL list and is now
    derived from a {value: occurrences} tally. Each one therefore has a
    plausible-wrong form — summing over KINDS, or dividing by `total_rows`
    instead of the non-empty count — so the fixture is built where all three
    answers DIFFER.

    ⚠️ Added because a mutant SURVIVED: `avg_text_length` summing over distinct
    values rather than cells passed the whole suite. Every existing fixture
    happened to be degenerate on that axis (one row per value, or values of
    equal length), which is the "put the fixture where old and new disagree"
    rule reached from the other direction.
    """

    # 7 records, the first with a blank `val`; "b" appears three times and "N/A"
    # twice, so kinds (3) and non-empty cells (6) are different numbers, and the
    # lengths 3/1/3 make a mean over kinds differ from a mean over cells.
    #
    # ⚠️ A SECOND COLUMN is what makes the blank record expressible: in a
    # one-column CSV a record whose only cell is blank and a blank LINE are the
    # same bytes (#983 reads them as a record there — `test_csv_records.py`), so
    # the second column keeps this fixture about the tally, not that rule.
    TEXT = (
        "val,other\n"
        ",x\naaa,x\nb,x\nb,x\nN/A,x\nb,x\nN/A,x\n"
    )

    @pytest.fixture
    def col(self):
        result = preview_dataset_csv(self.TEXT)
        assert result["total_rows"] == 7
        return result["columns"][0]

    def test_the_blank_is_counted_once_and_is_not_a_value(self, col):
        assert col["empty_count"] == 1
        assert col["empty_percent"] == 14.3
        assert "" not in col["sample_values"]

    def test_unique_count_is_kinds(self, col):
        assert col["unique_count"] == 3
        assert col["sample_values"] == ["aaa", "b", "N/A"]

    def test_avg_text_length_is_the_mean_over_CELLS(self, col):
        # cells: 3 + 1 + 1 + 3 + 1 + 3 = 12 over 6 non-empty  -> 2.0
        # over KINDS it would be (3 + 1 + 3) / 6             -> 1.2
        # over total_rows it would be 12 / 7                 -> 1.7
        assert col["avg_text_length"] == 2.0

    def test_na_count_is_cells_not_kinds(self, col):
        # "N/A" is recognised by the default N/A rules and appears TWICE.
        # A kind-based count would say 1.
        assert col["na_count"] == 2


# ── Cells and kinds are different numbers ────────────────────────────────────


class TestCellCountIsNotTheDistinctCount:
    """`SubstantiveValues` carries both because the detection heuristics divide
    one by the other. Collapsing them makes every uniqueness ratio 1.0, which
    reads every id-ish header as an identifier and sends every repeated-label
    column to open_text — so this fixture is chosen where the two DISAGREE.
    """

    def test_a_repeated_id_column_is_not_an_identifier(self):
        # 120 cells, 3 kinds: a ratio of 0.025, far under the threshold. Under
        # a collapsed count the ratio would be 1.0 and this would pass as an
        # identity column.
        values = ["A", "B", "C"] * 40
        assert not _is_identifier_column(
            "participant_id", None, SubstantiveValues.from_cells(values),
        )

    def test_a_unique_id_column_still_is_one(self):
        values = [f"P{i:03d}" for i in range(1, 41)]
        assert _is_identifier_column(
            "participant_id", None, SubstantiveValues.from_cells(values),
        )

    @pytest.mark.parametrize(
        "cells, distinct, count",
        [
            (["x", "y", "x"], ("x", "y"), 3),
            ([], (), 0),
            (["a"], ("a",), 1),
        ],
    )
    def test_from_cells_keeps_first_seen_order_and_the_cell_count(
        self, cells, distinct, count,
    ):
        values = SubstantiveValues.from_cells(cells)
        assert values.distinct == distinct
        assert values.unique == frozenset(distinct)
        assert values.cell_count == count
