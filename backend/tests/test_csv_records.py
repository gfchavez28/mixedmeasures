"""#983 and #985 — ONE reader decides what a record is, and reports a too-long one.

**#983 — a blank line was a respondent to the import and not to the preview.**
The preview skipped it (`csv.DictReader` had, and the #973 rewrite kept the skip);
the import made an empty record of it; so the wizard promised N records and the
dataset held N + the blank lines. Now every reader iterates `CsvRecords`, and
the rule is decided once: in a file of two or more columns a blank LINE is not a
record (a respondent who answered nothing is written ``,,`` and still counts); in
a ONE-column file the two are the same bytes and a blank line is how a
spreadsheet writes an empty answer, so a blank line BETWEEN records is one there.
Trailing blank lines are never records.

**#985 — a row with MORE values than the header was imported silently.** One
unquoted comma inside an answer (``P2,too long, and rambling,3``) put a sentence
fragment in the score column and dropped the real score, and nothing said the
file was malformed. The data is still imported as the file says — refusing a
file for one bad row was ruled out — but `CsvRecords` REPORTS every such record
with its line and record number, the wizard shows it before the import, and the
import names the rows it became so the result screen can link to them.
"""

import asyncio
import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.models.user import User
from app.services.dataset_import import (
    OVERLONG_EXAMPLE_LIMIT,
    CsvRecords,
    describe_csv_text,
    import_dataset_csv,
    narrow_csv_columns,
    preview_dataset_csv,
    select_csv_columns,
)

MALFORMED = "pid,comment,score\nP1,fine,5\nP2,too long, and rambling,3\nP3,ok,4\n"


def _run(coro):
    return asyncio.run(coro)


def _records(text: str) -> list[list[str]]:
    return list(CsvRecords(text))


# ── What a record is ─────────────────────────────────────────────────────────


class TestWhatARecordIs:
    @pytest.mark.parametrize("text", [
        "a,b\n1,2\n\n3,4\n",          # between records
        "a,b\n\n1,2\n3,4\n",          # right after the header
        "a,b\n1,2\n3,4\n\n\n",        # trailing
        "a,b\r\n1,2\r\n\r\n3,4\r\n",  # CRLF
        # #1083 (c): a line of spaces or a tab is a blank line in a wide file —
        # between records and trailing alike. It read as a one-cell respondent.
        "a,b\n1,2\n   \n3,4\n",
        "a,b\n1,2\n3,4\n   \n",
        "a,b\n1,2\n3,4\n\t\n",
        "a,b\r\n1,2\r\n \t \r\n3,4\r\n",
    ])
    def test_a_blank_line_is_not_a_record_in_a_wide_file(self, text):
        assert _records(text) == [["1", "2"], ["3", "4"]]

    def test_a_record_of_SPACES_with_its_commas_still_counts(self):
        """The #1083 (c) rule reads a line with no delimiter; `   ,  ` is a
        respondent whose answers are blank, the same as `,`."""
        assert _records("a,b\n1,2\n   ,  \n") == [["1", "2"], ["   ", "  "]]

    def test_a_whitespace_answer_STAYS_a_record_in_a_one_column_file(self):
        """🔴 Deliberately NOT the wide-file rule. Narrowing a wide file to one
        column writes a whitespace answer as a bare line, and so do the `.xlsx`/`.sav`
        adapters — so reading it as blank would drop a real respondent when it is the
        last one. This pins the respondent the narrowing would otherwise lose."""
        wide = "a,b\n1,x\n   ,y\n"
        assert _records(wide) == [["1", "x"], ["   ", "y"]]
        narrowed = select_csv_columns(wide, [0])
        assert _records(narrowed) == [["1"], ["   "]]

    def test_a_record_with_every_answer_empty_still_counts(self):
        """``,`` is a respondent who answered nothing — distinct from a blank line."""
        assert _records("a,b\n1,2\n,\n3,4\n") == [["1", "2"], ["", ""], ["3", "4"]]

    def test_a_blank_line_between_records_is_an_empty_answer_in_a_one_column_file(self):
        """The only way a one-column CSV can write an empty answer — skipping it
        would shrink the base a response rate is computed on (#830d)."""
        assert _records("q\nyes\n\nno\n") == [["yes"], [""], ["no"]]
        assert _records("q\n\nyes\n") == [[""], ["yes"]]

    def test_trailing_blank_lines_are_never_records(self):
        assert _records("q\nyes\nno\n\n\n") == [["yes"], ["no"]]
        assert _records("q\nyes\n\n\nno\n\n") == [["yes"], [""], [""], ["no"]]

    def test_a_quoted_answer_spanning_lines_is_one_record(self):
        assert _records('a,b\n1,"two\n\nlines"\n3,4\n') == [["1", "two\n\nlines"], ["3", "4"]]

    def test_it_reads_once(self):
        records = CsvRecords("a\n1\n")
        list(records)
        with pytest.raises(RuntimeError):
            list(records)


# ── Every stage counts the same records ──────────────────────────────────────


FILES_WITH_BLANK_LINES = [
    "a,b\n1,2\n\n3,4\n\n",
    "a,b\n\n1,2\n,\n3,4\n",
    "q\nyes\n\nno\n\n",
    "q\n\nyes\n",
    "a,b\n1,2\n   \n3,4\n\t\n",     # #1083 (c)
    "q\nyes\n  \nno\n",             # one column: the spaces are an answer
]


@pytest.fixture
def project(db_session):
    db_session.add(Project(id=983, name="Records", user_id=1))
    db_session.flush()
    return db_session


def _configs(preview: dict) -> list[dict]:
    return [
        {"column_index": c["column_index"], "column_type": c["suggested_type"],
         "column_text": c["suggested_column_text"]}
        for c in preview["columns"]
    ]


class TestEveryStageAgrees:
    @pytest.mark.parametrize("text", FILES_WITH_BLANK_LINES)
    def test_describe_preview_narrowing_and_import_count_the_same_records(self, project, text):
        preview = preview_dataset_csv(text)
        narrowed = preview_dataset_csv(select_csv_columns(text, [0]))
        result = import_dataset_csv(
            db=project, project_id=983, name=f"d{hash(text)}",
            column_configs=_configs(preview), file_contents=text,
        )
        project.flush()
        stored = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == result["dataset_id"]).count()

        expected = len(_records(text))
        assert describe_csv_text(text)["row_count"] == expected
        assert preview["total_rows"] == expected
        assert narrowed["total_rows"] == expected
        assert result["rows_created"] == stored == expected

    def test_record_identifiers_have_no_gaps(self, project):
        result = import_dataset_csv(
            db=project, project_id=983, name="gaps",
            column_configs=[{"column_index": 0, "column_type": "nominal", "column_text": "a"},
                            {"column_index": 1, "column_type": "nominal", "column_text": "b"}],
            file_contents="a,b\nx,1\n\n\ny,2\n\nz,3\n",
        )
        project.flush()
        ids = sorted(r.row_identifier for r in project.query(DatasetRow).filter(
            DatasetRow.dataset_id == result["dataset_id"]))
        assert ids == ["R001", "R002", "R003"]


# ── #985: the too-long record ────────────────────────────────────────────────


class TestTheTooLongRecord:
    def test_it_is_reported_with_its_line_and_record(self):
        records = CsvRecords(MALFORMED)
        list(records)
        assert records.overlong.as_payload() == {
            "count": 1, "header_width": 3,
            "examples": [{"record": 2, "line": 3, "cells": 4, "row_id": None}],
        }

    def test_empty_surplus_is_an_export_artefact_not_a_fault(self):
        """``1,2,3,`` under a three-column header displaces nothing."""
        records = CsvRecords("a,b,c\n1,2,3,\n4,5,6,,\n")
        list(records)
        assert records.overlong.count == 0

    def test_a_short_record_is_not_reported(self):
        """The most common malformation there is, and it imports correctly."""
        records = CsvRecords("a,b,c\n1,2\n")
        list(records)
        assert records.overlong.count == 0

    def test_the_line_follows_blank_lines_and_multi_line_answers(self):
        text = 'a,b\n\n"one\ntwo",x\n\n3,4,EXTRA\n'
        records = CsvRecords(text)
        assert list(records) == [["one\ntwo", "x"], ["3", "4", "EXTRA"]]
        assert records.overlong.examples == [
            {"record": 2, "line": 6, "cells": 3, "row_id": None},
        ]

    def test_a_too_long_record_is_named_by_the_line_it_STARTS_on(self):
        """When the too-long record itself spans lines (a quoted answer holding a
        newline), its first line is where the researcher has to look — the reader
        has already consumed the last one by the time it reports. (A mutant naming
        the END line survived every single-line fixture.)"""
        records = CsvRecords('a,b\nx,y\n"one\ntwo\nthree",y,EXTRA\n')
        list(records)
        assert records.overlong.examples == [
            {"record": 2, "line": 3, "cells": 3, "row_id": None},
        ]

    def test_the_examples_are_bounded_and_the_count_is_not(self):
        text = "a,b\n" + "".join(f"{i},x,y\n" for i in range(25))
        records = CsvRecords(text)
        list(records)
        assert records.overlong.count == 25
        assert len(records.overlong.examples) == OVERLONG_EXAMPLE_LIMIT
        assert [e["record"] for e in records.overlong.examples] == list(range(1, 11))

    def test_the_preview_reports_it(self):
        assert preview_dataset_csv(MALFORMED)["overlong_records"]["count"] == 1

    def test_narrowing_keeps_the_originals_report(self):
        """The narrowed text is exactly as wide as the selection, so it CANNOT
        show a too-long record; the report comes out of the narrowing itself."""
        narrowed, overlong = narrow_csv_columns(MALFORMED, [0, 2])
        assert preview_dataset_csv(narrowed)["overlong_records"]["count"] == 0
        assert overlong.count == 1 and overlong.examples[0]["line"] == 3

    def test_the_import_names_the_row_each_one_became(self, project):
        result = import_dataset_csv(
            db=project, project_id=983, name="malformed",
            column_configs=[
                {"column_index": 0, "column_type": "identifier", "column_text": "pid"},
                {"column_index": 1, "column_type": "open_text", "column_text": "comment"},
                {"column_index": 2, "column_type": "nominal", "column_text": "score"},
            ],
            file_contents=MALFORMED,
        )
        project.flush()
        report = result["overlong_records"]
        assert report["count"] == 1
        row = project.get(DatasetRow, report["examples"][0]["row_id"])
        assert row.row_identifier == "R002"
        # The data is imported as the file says — the report is what changed.
        score = project.query(DatasetColumn).filter(
            DatasetColumn.dataset_id == result["dataset_id"],
            DatasetColumn.column_text == "score").one()
        stored = project.query(DatasetValue).filter(
            DatasetValue.column_id == score.id, DatasetValue.row_id == row.id).one()
        assert stored.value_text == "and rambling"

    def test_the_row_is_right_across_a_write_batch(self, project):
        """The import writes 2,000 records per batch; a record number computed
        from the batch's start is how a row id could land one batch off."""
        n = 2_005
        text = "a,b\n" + "".join(
            f"{i},{'x,EXTRA' if i == 2_003 else 'x'}\n" for i in range(1, n + 1))
        result = import_dataset_csv(
            db=project, project_id=983, name="batches",
            column_configs=[{"column_index": 0, "column_type": "numeric", "column_text": "a"},
                            {"column_index": 1, "column_type": "nominal", "column_text": "b"}],
            file_contents=text,
        )
        project.flush()
        example = result["overlong_records"]["examples"][0]
        assert example["record"] == 2_003
        assert project.get(DatasetRow, example["row_id"]).row_identifier == "R002003"

    def test_a_workbook_never_reports_one(self):
        """The .xlsx adapter writes every row to the header's width."""
        from openpyxl import Workbook
        from app.services.dataset_import import xlsx_to_csv_text

        wb = Workbook()
        ws = wb.active
        ws.append(["a", "b"])
        ws.append([1, 2])
        ws.append([3, 4, "stray"])
        buf = io.BytesIO()
        wb.save(buf)
        text, _ = xlsx_to_csv_text(buf.getvalue())
        records = CsvRecords(text)
        list(records)
        assert records.overlong.count == 0


# ── Through the endpoints: the wire, the narrowing, the append ───────────────


def _upload(text: str, name: str = "survey.csv") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(text.encode()))


def _user(db):
    return db.query(User).filter(User.id == 1).one()


class TestThroughTheEndpoints:
    def test_the_preview_endpoint_carries_the_report(self, project):
        from app.routers.dataset import preview_dataset

        resp = _run(preview_dataset(
            project_id=983, file=_upload(MALFORMED), encoding="utf-8",
            sheet_name=None, column_indices=None, user=_user(project), db=project,
        ))
        assert resp.overlong_records.count == 1
        assert resp.overlong_records.examples[0].line == 3

    def test_a_narrowed_preview_and_import_carry_the_originals_report(self, project):
        from app.routers.dataset import import_dataset, preview_dataset

        resp = _run(preview_dataset(
            project_id=983, file=_upload(MALFORMED), encoding="utf-8",
            sheet_name=None, column_indices="[0, 2]", user=_user(project), db=project,
        ))
        assert resp.overlong_records.count == 1

        config = {
            "name": "narrowed", "source_column_indices": [0, 2],
            "column_configs": [
                {"column_index": 0, "column_type": "identifier", "column_text": "pid"},
                {"column_index": 1, "column_type": "nominal", "column_text": "score"},
            ],
        }
        result = _run(import_dataset(
            project_id=983, file=_upload(MALFORMED), import_config=json.dumps(config),
            encoding="utf-8", user=_user(project), db=project,
        ))
        example = result.overlong_records.examples[0]
        assert result.overlong_records.count == 1
        assert project.get(DatasetRow, example.row_id).row_identifier == "R002"


@pytest.fixture
def dataset(project):
    ds = Dataset(project_id=983, name="Existing")
    project.add(ds)
    project.flush()
    for i, code in enumerate(("pid", "comment", "score")):
        project.add(DatasetColumn(
            dataset_id=ds.id, column_code=code, column_text=code,
            column_type=ColumnType.NOMINAL, sequence_order=i, source="imported",
        ))
    project.add(DatasetRow(dataset_id=ds.id, row_identifier="R001"))
    project.flush()
    return ds


def _mapping(db, ds) -> str:
    cols = (db.query(DatasetColumn).filter(DatasetColumn.dataset_id == ds.id)
            .order_by(DatasetColumn.sequence_order).all())
    return json.dumps({
        "column_mapping": [{"csv_column_index": i, "column_id": c.id} for i, c in enumerate(cols)],
        "skip_duplicates": False,
    })


class TestTheAppendReadsTheSameWay:
    def test_append_preview_and_import_count_and_report_alike(self, project, dataset):
        from app.routers.dataset import append_import, append_preview

        text = MALFORMED + "\n\nP4,late,6\n"
        preview = _run(append_preview(
            project_id=983, dataset_id=dataset.id, file=_upload(text), encoding="utf-8",
            sheet_name=None, user=_user(project), db=project,
        ))
        assert preview.total_rows == 4                    # the blank lines are not records
        assert preview.overlong_records.count == 1

        result = _run(append_import(
            project_id=983, dataset_id=dataset.id, file=_upload(text),
            import_config=_mapping(project, dataset), encoding="utf-8",
            user=_user(project), db=project,
        ))
        assert result.rows_created == 4
        example = result.overlong_records.examples[0]
        assert example.record == 2 and example.line == 3
        assert project.get(DatasetRow, example.row_id).dataset_id == dataset.id

    def test_a_file_with_no_records_is_refused_in_plain_words(self, project, dataset):
        from app.routers.dataset import append_preview

        with pytest.raises(HTTPException) as exc:
            _run(append_preview(
                project_id=983, dataset_id=dataset.id, file=_upload("pid,comment\n\n\n"),
                encoding="utf-8", sheet_name=None, user=_user(project), db=project,
            ))
        assert exc.value.status_code == 400
        assert exc.value.detail == "This file has no data rows."


# ── #1083: a file the reader refuses says where and why ──────────────────────


# An unclosed quote on line 3 swallows every line after it — the realistic shape, and
# the one where the line the record STARTS on (3) and the line the reader has reached
# when the value passes the limit (~26,000) differ.
LONG_QUOTE = 'pid,comment\nP1,fine\nP2,"oops\n' + "P3,x\n" * 30_000
MAC = "pid,comment\rP1,fine\rP2,ok\r"


class TestTheReaderSaysWhereAndWhy:
    def test_an_unclosed_quote_names_the_line_its_record_STARTS_on(self):
        from app.services.dataset_import import CsvReadError

        with pytest.raises(CsvReadError) as exc:
            _records(LONG_QUOTE)
        assert str(exc.value).startswith("Line 3 holds a value longer than 131,072 characters")
        assert "quotation mark" in str(exc.value)

    def test_the_line_follows_a_multi_line_answer(self):
        from app.services.dataset_import import CsvReadError

        text = 'pid,comment\nP1,"two\nlines"\nP2,"' + "x" * 140_000 + "\n"
        with pytest.raises(CsvReadError, match=r"^Line 4 "):
            _records(text)

    def test_old_MAC_line_endings_fail_at_the_header_and_say_so(self):
        from app.services.dataset_import import CsvReadError

        with pytest.raises(CsvReadError) as exc:
            CsvRecords(MAC)
        assert str(exc.value).startswith("Line 1 (the header) has a line break")
        assert "old Mac line endings" in str(exc.value)

    def test_it_is_still_a_csv_Error_AND_a_ValueError(self):
        """So every arm that caught either before still catches it — none of them
        can turn it into a 500."""
        import csv as _csv

        from app.services.dataset_import import CsvReadError

        assert issubclass(CsvReadError, _csv.Error)
        assert issubclass(CsvReadError, ValueError)


class TestEveryDoorSaysTheSentence:
    """🔴 #1083 (a): with a column SELECTION the narrowing ran before either
    endpoint's own `try`, and only `ColumnSelectionError` was caught there — so the
    file above answered 500 on the narrowed path and 400 on the other."""

    @pytest.mark.parametrize("selection", [None, "[0, 1]"])
    def test_the_preview_with_and_without_a_selection(self, project, selection):
        from app.routers.dataset import preview_dataset

        with pytest.raises(HTTPException) as exc:
            _run(preview_dataset(
                project_id=983, file=_upload(LONG_QUOTE), encoding="utf-8",
                sheet_name=None, column_indices=selection, user=_user(project), db=project,
            ))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Line 3 holds a value longer")

    def test_the_import_with_a_selection(self, project):
        from app.routers.dataset import import_dataset

        config = {
            "name": "narrowed", "source_column_indices": [0, 1],
            "column_configs": [
                {"column_index": 0, "column_type": "identifier", "column_text": "pid"},
                {"column_index": 1, "column_type": "open_text", "column_text": "comment"},
            ],
        }
        with pytest.raises(HTTPException) as exc:
            _run(import_dataset(
                project_id=983, file=_upload(MAC), import_config=json.dumps(config),
                encoding="utf-8", user=_user(project), db=project,
            ))
        assert exc.value.status_code == 400
        assert "old Mac line endings" in exc.value.detail

    def test_the_import_without_one(self, project):
        from app.routers.dataset import import_dataset

        config = {
            "name": "whole",
            "column_configs": [
                {"column_index": 0, "column_type": "identifier", "column_text": "pid"},
                {"column_index": 1, "column_type": "open_text", "column_text": "comment"},
            ],
        }
        with pytest.raises(HTTPException) as exc:
            _run(import_dataset(
                project_id=983, file=_upload(LONG_QUOTE), import_config=json.dumps(config),
                encoding="utf-8", user=_user(project), db=project,
            ))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Line 3 holds a value longer")

    def test_the_column_describer(self, project):
        from app.routers.dataset import describe_dataset_columns

        with pytest.raises(HTTPException) as exc:
            _run(describe_dataset_columns(
                project_id=983, file=_upload(MAC), encoding="utf-8", sheet_name=None,
                user=_user(project), db=project,
            ))
        assert exc.value.status_code == 400
        assert "old Mac line endings" in exc.value.detail

    def test_the_append_steps(self, project, dataset):
        from app.routers.dataset import append_preview

        with pytest.raises(HTTPException) as exc:
            _run(append_preview(
                project_id=983, dataset_id=dataset.id, file=_upload(LONG_QUOTE),
                encoding="utf-8", sheet_name=None, user=_user(project), db=project,
            ))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Line 3 holds a value longer")
