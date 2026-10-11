"""#1127 — a quotation mark that does not pair up is REFUSED, with its line, in every reader.

Python's `csv.reader` in its default mode reads a value that opens with a quotation
mark up to the NEXT quotation mark in the file, wherever that is. So a stray quote
on one line swallowed every record after it, up to the next quote, into one answer —
silently: the preview showed fewer records than the file had and nothing said why
(measured on the BES file, 2026-10-10: 1 to 42 records lost per planted quote).
Past 131,072 characters the swallowed value hit the field limit and #1083's sentence
fired; under it, nothing did.

`strict=True` refuses the shapes that cause it — a quoted value that is never closed
(``unexpected end of data``) and a closing quote followed by anything but a comma or
a line end (``',' expected after '"'``) — and `csv_error_sentence` names the line the
failing record STARTS on, which is the line holding the opening quote.

**Measured before choosing it (2026-10-11b):** over 635 comma-separated CSVs on the
developer's machine strict refused only data.table's deliberately malformed
`unescaped.csv`, which the lenient reader MISREADS; `csv.writer` output — every
adapter's — round-trips under strict (20,000 random rows). So it costs a sloppy file
a refusal with its line, where the lenient reader silently mangled it.

**The three readers.** `services/dataset_import.py::CsvRecords` (every dataset door),
`services/coding_import.py::parse_rows`, and the conversation (transcript) reader in
`services/csv_import.py`, which reads through `CsvRecords` since this batch and gained
four fixes with it (the BOM, a short row, a whitespace line, a too-long row).
"""

import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

from app.models.project import Project
from app.models.user import User
from app.services import coding_import as ci
from app.services.csv_import import import_csv_to_segments, preview_csv
from app.services.dataset_import import CsvReadError, CsvRecords


def _records(text: str) -> list[list[str]]:
    return list(CsvRecords(text))


def _run(coro):
    return asyncio.run(coro)


def _upload(text: str, name: str = "transcript.csv") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(text.encode("utf-8")))


# The shapes #1127 is about. Each is UNDER the field limit, so nothing fired before.
SHORT_UNCLOSED = 'a,b\n1,"abc\n2,3\n4,5\n'
STRAY_MID_FILE = 'a,b\n1,x\n2,"stray\n3,y\n4,"quoted, legitimately"\n5,z\n'
UNDOUBLED_INNER = 'a,b\n1,x\n2,"he said "hi" ok"\n3,y\n'
SPACE_AFTER_CLOSE = 'a,b\n1,"x" ,y\n'


class TestTheDatasetReaderRefuses:
    def test_a_SHORT_unclosed_quote_names_the_line_it_opens_on(self):
        """The case no test covered: under the field limit, the lenient reader read
        records 2 and 3 into record 1's answer and reached the end without a word."""
        with pytest.raises(CsvReadError) as exc:
            _records(SHORT_UNCLOSED)
        message = str(exc.value)
        assert message.startswith("Line 2 opens a value with a quotation mark that is never closed")
        assert "everything after it" in message

    def test_a_stray_quote_MID_FILE_names_its_own_line(self):
        """The common shape: the swallowing stops at the next quote in the file, which
        is usually the OPENING quote of a legitimate value — strict refuses there, and
        the line named is where the swallowed record STARTED, i.e. the stray quote's."""
        with pytest.raises(CsvReadError) as exc:
            _records(STRAY_MID_FILE)
        message = str(exc.value)
        assert message.startswith("Line 3 has a value that starts with a quotation mark")
        assert 'doubled ("")' in message

    def test_an_undoubled_quote_inside_a_value_is_refused(self):
        """The lenient reader stored `he said hi" ok"` — the quotes moved, silently."""
        with pytest.raises(CsvReadError, match=r"^Line 3 has a value that starts"):
            _records(UNDOUBLED_INNER)

    def test_a_space_after_a_closing_quote_is_refused(self):
        with pytest.raises(CsvReadError, match=r"^Line 2 has a value that starts"):
            _records(SPACE_AFTER_CLOSE)

    @pytest.mark.parametrize("text, expected", [
        ('a,b\n1,5" tall\n', [["1", '5" tall']]),                       # a bare quote mid-value
        ('a,b\n1,"say ""hi"""\n', [["1", 'say "hi"']]),                   # doubled quotes
        ('a,b\n1,"two\nlines"\n2,x\n', [["1", "two\nlines"], ["2", "x"]]),  # a quoted line break
        ('a,b\r\n1,"two\r\nlines"\r\n', [["1", "two\r\nlines"]]),         # CRLF
        ('a,b\n1,"last"', [["1", "last"]]),                                # no final newline
        ('a,b\n1,""\n', [["1", ""]]),                                      # an empty quoted value
    ])
    def test_a_well_formed_file_reads_as_before(self, text, expected):
        """The positive control: every shape `csv.writer` produces still reads."""
        assert _records(text) == expected


class TestASeparatorThatIsNotAComma:
    """Excel writes "CSV" with the region's list separator — a semicolon in much of
    Europe. A file whose values are QUOTED then trips the quote rule on its first
    line, and a sentence about quotation marks would send the researcher after the
    wrong fault."""

    @pytest.mark.parametrize("text, word", [
        ('"Name";"Age"\n"Ann";"5"\n', "semicolons"),
        ('Name;Age\n"Ann";"5"\n', "semicolons"),     # the header is fine, line 2 is not
        ('Name\tAge\n"Ann"\t5\n', "tabs"),
    ])
    def test_the_sentence_names_the_separator(self, text, word):
        with pytest.raises(CsvReadError) as exc:
            _records(text)
        message = str(exc.value)
        assert f"separate its values with {word}" in message
        assert "quotation mark" not in message

    def test_a_COMMA_file_whose_HEADING_holds_a_semicolon_keeps_the_quote_sentence(self):
        """The arm fires only for a first line with NO comma: a comma file may carry a
        semicolon in a heading ("Q3; follow-up") and in its answers, and its quote fault
        is a quote fault. (A first draft put the semicolon only in an ANSWER — which the
        arm never reads — and a mutant dropping the comma test survived it.)"""
        with pytest.raises(CsvReadError) as exc:
            _records('id,Q3; follow-up\n1,"x; y" z\n')
        assert "quotation mark" in str(exc.value)
        assert "semicolons" not in str(exc.value)


class TestTheCodingImportRefuses:
    def test_a_short_unclosed_quote_is_a_sentence_naming_its_line(self):
        with pytest.raises(ci.CodingImportError) as exc:
            ci.parse_rows('unit_id,coder,code\nseg-1,Alice,"Trust\nseg-2,Alice,Doubt\n')
        assert str(exc.value).startswith(
            "Line 2 opens a value with a quotation mark that is never closed"
        )

    def test_a_READ_refusal_names_the_PHYSICAL_line_a_text_editor_shows(self):
        """A quote fault is fixed in a text editor — a spreadsheet mis-reads the same
        file — so the read refusal names the line the record starts on, as the dataset
        doors do. (The problem LIST keeps spreadsheet rows; that is a different
        question, asked of a file that read.)"""
        text = 'unit_id,coder,code,text\nseg-1,Alice,Trust,"one\ntwo"\nseg-2,Alice,"Doubt\n'
        with pytest.raises(ci.CodingImportError) as exc:
            ci.parse_rows(text)
        assert str(exc.value).startswith("Line 4 ")


# ── The conversation (transcript) reader ────────────────────────────────────


class TestTheTranscriptReader:
    def test_a_stray_quote_is_refused_not_merged_into_one_turn(self):
        """Before: A's turn became `I said no\\nB,fine\\nC,really" ok`, B and C gone."""
        text = 'Speaker,Text\nA,"I said no\nB,fine\nC,"really" ok\nD,last\n'
        with pytest.raises(CsvReadError, match=r"^Line 2 "):
            preview_csv(text.encode())
        with pytest.raises(CsvReadError, match=r"^Line 2 "):
            import_csv_to_segments(text.encode(), {"speaker": "Speaker", "text": "Text"}, {})

    def test_a_byte_order_mark_is_not_part_of_the_first_heading(self):
        """Excel's "CSV UTF-8" starts with one, and `decode('utf-8')` keeps it — so in a
        batch mixing an Excel transcript with a plain one, file 2 had no column called
        what file 1 called "Speaker", and the wizard blocked on two names that look
        identical."""
        result = preview_csv("﻿Speaker,Text\nA,hi\n".encode("utf-8"))
        assert result.headers == ["Speaker", "Text"]
        assert result.detected_columns["speaker"] == "Speaker"

    def test_a_short_row_reads_as_empty_cells_not_a_500(self):
        """`csv.DictReader` padded a short row with None, and the preview's `.strip()`
        raised AttributeError — outside the endpoint's except, so a 500."""
        result = preview_csv(b"Speaker,Text,Start\nA,hello,0\nB,hi\n")
        assert result.total_rows == 2
        assert result.sample_rows[1] == {"Speaker": "B", "Text": "hi", "Start": ""}

    def test_a_line_of_spaces_is_not_a_turn(self):
        result = preview_csv(b"Speaker,Text\nA,hi\n   \nB,yo\n")
        assert result.total_rows == 2

    def test_an_unquoted_comma_is_REPORTED_at_the_preview_and_the_import(self):
        """The turn `Well, I think so, yes` imported as `Well`: the rest went under
        DictReader's `None` key and was dropped, silently. Reported, as the dataset
        doors report it (#985) — the import still reads the file as it says."""
        text = b"Speaker,Text\nA,Well, I think so, yes\nB,ok\n"
        result = preview_csv(text)
        assert result.overlong_records["count"] == 1
        assert result.overlong_records["examples"][0]["line"] == 2
        segments, warnings = import_csv_to_segments(
            text, {"speaker": "Speaker", "text": "Text"}, {},
        )
        assert [s.text for s in segments] == ["Well", "ok"]
        assert any(w.startswith("Line 2 has more values than the file has headings") for w in warnings)

    def test_a_duplicated_heading_reads_the_FIRST_column(self):
        """DictReader kept the LAST — the #973 (b') defect on the dataset side."""
        result = preview_csv(b"Speaker,Text,Text\nA,first,second\n")
        assert result.sample_rows[0]["Text"] == "first"

    def test_the_turn_numbers_are_unchanged(self):
        """`sequence_order` is the record's index, skipped empty turns included — the
        same numbering DictReader gave."""
        segments, _ = import_csv_to_segments(
            b"Speaker,Text\nA,one\nB,\nC,three\n", {"speaker": "Speaker", "text": "Text"}, {},
        )
        assert [(s.sequence_order, s.text) for s in segments] == [(0, "one"), (2, "three")]


@pytest.fixture
def project(db_session):
    db_session.add(Project(id=1127, name="Strict", user_id=1))
    db_session.flush()
    return db_session


class TestTheTranscriptEndpointsSayTheSentence:
    """Both conversation doors answered *"Unable to parse CSV file. Check the file
    format and try again."* to every file the reader refused — #1083's defect, never
    fixed on this side."""

    def test_the_preview(self, project):
        from app.routers.conversations import preview_csv_upload

        db = project
        with pytest.raises(HTTPException) as exc:
            _run(preview_csv_upload(
                project_id=1127, file=_upload(SHORT_UNCLOSED.replace("a,b", "Speaker,Text")),
                encoding="utf-8", user=db.get(User, 1), db=db,
            ))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Line 2 opens a value with a quotation mark")

    def test_the_import(self, project):
        import json

        from app.routers.conversations import import_csv

        db = project
        config = {
            "name": "T", "column_mapping": {"speaker": "Speaker", "text": "Text"},
            "speaker_mappings": [], "encoding": "utf-8",
        }
        with pytest.raises(HTTPException) as exc:
            _run(import_csv(
                project_id=1127, file=_upload(SHORT_UNCLOSED.replace("a,b", "Speaker,Text")),
                import_config=json.dumps(config), user=db.get(User, 1), db=db,
            ))
        assert exc.value.status_code == 400
        assert exc.value.detail.startswith("Line 2 opens a value with a quotation mark")
