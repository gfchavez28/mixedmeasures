"""#973 (c) — the two-stage preview: choose columns, then describe the choice.

Before this, an over-cap file was a DEAD END. Every reader on the dataset path
refuses before it has a column list — `.xlsx` on its declared dimensions before
reading a cell, `.sav` on its metadata, `preview_dataset_csv` by bailing
mid-stream — so the refusal told the researcher to "remove columns you do not
need" while giving them no way to see what the columns were, and no way to act
from inside the tool.

The shape:

* **`POST …/datasets/columns`** is the cheap first stage. Headers, a row count
  and five sample values per column, accumulating nothing. 🔴 **It is the one
  dataset endpoint that does not apply `MAX_DATASET_CELLS`** — it is the escape
  hatch FROM that refusal, so refusing there would close the way out.
* **`POST …/datasets/preview`** then takes `column_indices`, and the file is
  narrowed to them **at the format seam** (`_upload_to_csv_text`).

🔴 **Narrowing at the seam is the load-bearing choice, and everything else falls
out of it.** Downstream sees a file that IS the selection, so
`preview_dataset_csv` and `import_dataset_csv` are unchanged, every
`column_index` means the same thing on the preview and the import, and
`cell_count_error(rows, len(headers))` is already counting the selection — which
is #973 (a), obtained rather than built.

⚠️ **The contract the caller must keep: the SAME selection on both calls.** The
wizard's `column_index` values are positions in the narrowed text, so a different
list at import time applies the researcher's type choices to other columns.
`DatasetImportRequest.source_column_indices` carries it for that reason, and
`test_the_same_selection_round_trips` is what pins it.
"""
import asyncio
import io
import json

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.models.dataset import Dataset, DatasetColumn, DatasetValue
from app.models.project import Project
from app.routers.dataset import (
    _parse_column_selection,
    describe_dataset_columns,
    import_dataset,
    preview_dataset,
)
from app.schemas.dataset import DatasetImportRequest
from app.services.dataset_import import (
    MAX_DATASET_CELLS,
    describe_csv_text,
    select_csv_columns,
)


def _run(coro):
    return asyncio.run(coro)


def _upload(text: str, name: str = "survey.csv") -> StarletteUploadFile:
    return StarletteUploadFile(filename=name, file=io.BytesIO(text.encode()))


def _over_cap_csv(rows: int = 12_000, cols: int = 500) -> str:
    """6,000,000 cells in ~12 MB — over the cap, well inside the 50 MB upload cap.

    ⚠️ That combination is the whole point: the cell cap binds on ordinary survey
    data long before the byte cap does, because a cell of single-digit codes is
    two bytes.
    """
    header = ",".join(f"Q{i:03d}" for i in range(cols))
    body = "\n".join(
        ",".join(str((r + c) % 7) for c in range(cols)) for r in range(rows)
    )
    return f"{header}\n{body}\n"


@pytest.fixture
def project(db_session):
    db_session.add(Project(id=9730, name="Selection", user_id=1))
    db_session.flush()
    return 9730


@pytest.fixture
def user(db_session):
    from app.models.user import User

    return db_session.get(User, 1)


# ── The escape hatch ─────────────────────────────────────────────────────────


class TestTheCheapStageAnswersForAnOverCapFile:
    def test_preview_alone_is_still_a_refusal(self, db_session, project, user):
        """The state this exists to escape — and it must stay a refusal, because
        the cap is what protects the memory budget."""
        with pytest.raises(HTTPException) as exc:
            _run(preview_dataset(
                project_id=project, file=_upload(_over_cap_csv()), encoding="utf-8",
                sheet_name=None, column_indices=None, user=user, db=db_session,
            ))
        assert exc.value.status_code == 400
        assert "4,000,000" in exc.value.detail

    def test_columns_describes_the_same_file(self, db_session, project, user):
        result = _run(describe_dataset_columns(
            project_id=project, file=_upload(_over_cap_csv()), encoding="utf-8",
            sheet_name=None, user=user, db=db_session,
        ))

        assert len(result.columns) == 500
        assert result.total_rows == 12_000
        assert result.columns[0].column_name == "Q000"
        assert result.columns[499].column_index == 499
        # Sample values are what let a researcher tell Q014 from Q015 when the
        # names carry no meaning.
        assert len(result.columns[0].sample_values) == 5

    def test_it_states_the_size_and_the_limit_it_is_measured_against(
        self, db_session, project, user,
    ):
        """#974's rule: a disclosure that predicts a refusal must share the
        refusal's counter, and must not make the client carry a copy of the
        threshold."""
        result = _run(describe_dataset_columns(
            project_id=project, file=_upload(_over_cap_csv()), encoding="utf-8",
            sheet_name=None, user=user, db=db_session,
        ))

        assert result.cells == 12_000 * 500 == 6_000_000
        assert result.max_cells == MAX_DATASET_CELLS
        assert result.cells > result.max_cells


class TestPreviewWithASelection:
    def test_a_selection_under_the_cap_is_previewed(self, db_session, project, user):
        text = _over_cap_csv()
        pick = list(range(300))  # 12,000 x 300 = 3.6M, under the cap

        result = _run(preview_dataset(
            project_id=project, file=_upload(text), encoding="utf-8", sheet_name=None,
            column_indices=json.dumps(pick), user=user, db=db_session,
        ))

        assert result.total_rows == 12_000
        assert len(result.columns) == 300
        # `column_index` is a position in the NARROWED text, and the names prove
        # the narrowing kept the researcher's order.
        assert result.columns[0].column_name == "Q000"
        assert result.columns[299].column_name == "Q299"
        assert [c.column_index for c in result.columns] == list(range(300))

    def test_a_selection_still_over_the_cap_is_still_refused(
        self, db_session, project, user,
    ):
        """The cap is applied to the SELECTION, not waived by the presence of
        one. 12,000 x 400 = 4.8M is still over."""
        with pytest.raises(HTTPException) as exc:
            _run(preview_dataset(
                project_id=project, file=_upload(_over_cap_csv()), encoding="utf-8",
                sheet_name=None, column_indices=json.dumps(list(range(400))),
                user=user, db=db_session,
            ))
        assert exc.value.status_code == 400
        assert "4,000,000" in exc.value.detail

    def test_a_non_contiguous_selection_keeps_the_chosen_columns(
        self, db_session, project, user,
    ):
        """A researcher picks the variables they need, not a prefix — so the
        fixture must not be one (a contiguous slice passes under an
        implementation that ignores the indices and takes the first N)."""
        text = "a,b,c,d,e\n1,2,3,4,5\n6,7,8,9,10\n"

        result = _run(preview_dataset(
            project_id=project, file=_upload(text), encoding="utf-8", sheet_name=None,
            column_indices=json.dumps([4, 1]), user=user, db=db_session,
        ))

        assert [c.column_name for c in result.columns] == ["e", "b"]
        assert [c.sample_values for c in result.columns] == [["5", "10"], ["2", "7"]]


# ── The index contract between the two calls ─────────────────────────────────


class TestTheSameSelectionRoundTrips:
    """The claim that makes narrowing-at-the-seam safe: a preview and an import
    given the same selection agree about which column is which.

    Entered at the pipeline's mouth — both real endpoints over one file — because
    the failure mode is that the two paths disagree, which no unit test of either
    one alone can see.
    """

    def test_the_import_stores_the_previewed_columns(self, db_session, project, user):
        text = "pid,junk,score,waste,note\nP1,x,5,y,ok\nP2,x,6,y,fine\n"
        pick = [0, 2, 4]  # pid, score, note — skipping the two junk columns

        preview = _run(preview_dataset(
            project_id=project, file=_upload(text), encoding="utf-8", sheet_name=None,
            column_indices=json.dumps(pick), user=user, db=db_session,
        ))
        assert [c.column_name for c in preview.columns] == ["pid", "score", "note"]

        config = DatasetImportRequest(
            name="Narrowed",
            column_configs=[
                {
                    "column_index": c.column_index,
                    "column_type": c.suggested_type,
                    "column_text": c.column_name,
                }
                for c in preview.columns
            ],
            source_column_indices=pick,
        )
        _run(import_dataset(
            project_id=project, file=_upload(text),
            import_config=config.model_dump_json(), encoding="utf-8",
            user=user, db=db_session,
        ))
        db_session.flush()

        dataset = db_session.query(Dataset).filter(Dataset.name == "Narrowed").one()
        columns = (
            db_session.query(DatasetColumn)
            .filter(DatasetColumn.dataset_id == dataset.id)
            .order_by(DatasetColumn.sequence_order)
            .all()
        )
        assert [c.column_text for c in columns] == ["pid", "score", "note"]

        # The values landed under the column the wizard named, which is the
        # whole contract: a renumbering bug puts "5" under `note`.
        score = next(c for c in columns if c.column_text == "score")
        stored = sorted(
            v.value_text
            for v in db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == score.id)
            .all()
        )
        assert stored == ["5", "6"]

    def test_an_ordinary_import_sends_no_selection(self, db_session, project, user):
        """None means the whole file, which is every import that fits — the
        two-stage path must not become the common path."""
        text = "a,b\n1,2\n3,4\n"
        preview = _run(preview_dataset(
            project_id=project, file=_upload(text), encoding="utf-8", sheet_name=None,
            column_indices=None, user=user, db=db_session,
        ))
        assert [c.column_name for c in preview.columns] == ["a", "b"]


# ── The selection is validated, not trusted ──────────────────────────────────


class TestTheSelectionIsValidated:
    """It decides what the adapter READS, so a malformed one produces a narrowed
    file that does not match what the wizard believes it chose."""

    @pytest.mark.parametrize(
        "raw, fragment",
        [
            ('{"a": 1}', "list of integers"),
            ('["0"]', "list of integers"),
            ("[true]", "list of integers"),
            ("[0, -1]", "negative"),
            ("[0, 1, 0]", "repeat"),
            ("[]", "at least one column"),
            ("not json", "Invalid"),
        ],
    )
    def test_it_refuses(self, raw, fragment):
        with pytest.raises(HTTPException) as exc:
            _parse_column_selection(raw, field="column_indices")
        assert exc.value.status_code == 400
        assert fragment in exc.value.detail

    @pytest.mark.parametrize("raw", [None, ""])
    def test_absent_means_the_whole_file(self, raw):
        assert _parse_column_selection(raw) is None

    def test_order_is_the_callers(self):
        assert _parse_column_selection("[4, 1, 2]") == [4, 1, 2]


# ── The narrowing itself ─────────────────────────────────────────────────────


class TestSelectCsvColumns:
    def test_it_keeps_the_chosen_columns_in_order(self):
        assert select_csv_columns("a,b,c\n1,2,3\n", [2, 0]) == "c,a\n3,1\n"

    def test_records_are_re_emitted_not_lines(self):
        """#983: a blank line in a two-column file is not a record, so the
        narrowed text drops it — and has the SAME records as the original, which
        is what keeps the two stages agreeing about the row count. (It used to be
        re-emitted as a blank line, which a one-column result would then have
        had to call a record.)"""
        narrowed = select_csv_columns("a,b\n1,2\n\n3,4\n", [0])
        assert narrowed == "a\n1\n3\n"

    def test_an_empty_answer_survives_narrowing_to_one_column(self):
        """A record whose selected cell is empty is written `""` — csv.writer's
        spelling of one empty field — never as a blank line, so it stays a
        record once the text is one column wide."""
        narrowed = select_csv_columns("a,b\n1,x\n,y\n3,z\n", [0])
        assert narrowed == 'a\n1\n""\n3\n'
        assert describe_csv_text(narrowed)["row_count"] == 3

    def test_quoting_round_trips(self):
        """The narrowed text is re-serialised, so a value carrying a separator,
        a quote or a newline has to survive being written out again."""
        source = 'a,b,c\n1,"two\nlines",3\n4,"he said ""hi""",6\n'
        narrowed = select_csv_columns(source, [1, 2])
        import csv as _csv

        assert list(_csv.reader(io.StringIO(narrowed))) == [
            ["b", "c"], ["two\nlines", "3"], ['he said "hi"', "6"],
        ]

    def test_a_short_row_yields_empty_cells(self):
        assert select_csv_columns("a,b,c\n1\n", [1, 2]) == "b,c\n,\n"


class TestEveryFormatNarrowsAtItsOwnSource:
    """CSV is not the only door. `.xlsx` refuses on declared dimensions and
    `.sav` on its metadata — both BEFORE a column list exists — so a selection
    that only worked on CSV would leave the two formats a researcher is most
    likely to bring from SPSS or Excel still dead-ended.

    ⚠️ Each narrows while READING (openpyxl per row, pyreadstat via `usecols`),
    not afterwards: a post-hoc filter would first spend the memory the cap
    exists to refuse.
    """

    def _xlsx(self, rows, sheet_title="Sheet1"):
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = sheet_title
        for row in rows:
            ws.append(row)
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def test_xlsx_describes_without_reading_every_cell(self):
        from app.services.dataset_import import describe_xlsx

        described = describe_xlsx(
            self._xlsx([["Q1", "Q2", "Q3"], [1, 2, 3], [4, 5, 6], [7, 8, 9]])
        )
        assert described["headers"] == ["Q1", "Q2", "Q3"]
        assert described["row_count"] == 3
        assert described["samples"][0] == ["1", "4", "7"]
        assert described["sheet_names"] == ["Sheet1"]

    def test_xlsx_narrows(self):
        from app.services.dataset_import import xlsx_to_csv_text

        text, _sheets = xlsx_to_csv_text(
            self._xlsx([["Q1", "Q2", "Q3"], [1, 2, 3], [4, 5, 6]]), None, [2, 0],
        )
        assert text == "Q3,Q1\n3,1\n6,4\n"

    def test_xlsx_keeps_a_selected_column_whose_header_is_blank(self):
        """The trailing-blank-header trim is for phantom columns Excel reports at
        the end of a sheet. With a selection it must NOT run: the width IS the
        selection, and trimming it would return fewer columns than were asked
        for — every `column_index` the wizard holds would then be off by one."""
        from app.services.dataset_import import xlsx_to_csv_text

        text, _sheets = xlsx_to_csv_text(
            self._xlsx([["Q1", ""], [1, 2], [3, 4]]), None, [0, 1],
        )
        assert text.splitlines()[0] == "Q1,"
        assert text.splitlines()[1] == "1,2"

    def test_the_xlsx_cap_counts_the_SELECTION(self, monkeypatch):
        """The whole of (c) on this format, and it needs a lowered cap to reach:
        a workbook genuinely over 4,000,000 cells takes minutes to build.

        Under the real code the pre-read check uses `ws.max_column`, which is the
        SHEET's width — and counting that with a selection in hand would refuse
        the very file the selection exists to rescue.
        """
        from app.services import dataset_import as di

        monkeypatch.setattr(di, "MAX_DATASET_CELLS", 8)
        book = self._xlsx([["Q1", "Q2", "Q3"], [1, 2, 3], [4, 5, 6], [7, 8, 9]])

        # ⚠️ The PRE-READ check counts `ws.max_row`, which includes the header —
        # 4 x 3 = 12 here, not 9. It deliberately overcounts by a row so it only
        # ever refuses what is genuinely over; the authoritative check below it
        # runs on the trimmed dimensions (3 x 2 = 6).
        with pytest.raises(di.XlsxImportError) as exc:
            di.xlsx_to_csv_text(book)
        assert "limit" in str(exc.value)

        # 4 x 2 selected = 8, at the cap — and it converts.
        text, _sheets = di.xlsx_to_csv_text(book, None, [0, 2])
        assert text == "Q1,Q3\n1,3\n4,6\n7,9\n"

    def test_the_sav_cap_counts_the_SELECTION(self, monkeypatch):
        """`.sav` refuses from METADATA, before any data read — so the same
        question has to be asked of the same numbers on that arm."""
        from app.services import dataset_import as di
        from app.services import sav_import as si

        content = (
            __import__("pathlib").Path(__file__).parent
            / "reference_data" / "spss_sample.sav"
        ).read_bytes()
        # The fixture is 4 rows x 6 variables = 24 cells.
        monkeypatch.setattr(di, "MAX_DATASET_CELLS", 12)

        with pytest.raises(si.SavImportError):
            si.sav_to_csv_text(content)

        text, _meta = si.sav_to_csv_text(content, columns=[0, 2])
        assert text.splitlines()[0] == "pid,satisfied"

    def test_sav_describes_from_metadata_and_narrows_via_usecols(self):
        from app.services.sav_import import describe_sav, sav_to_csv_text

        content = (
            __import__("pathlib").Path(__file__).parent
            / "reference_data" / "spss_sample.sav"
        ).read_bytes()

        described = describe_sav(content)
        assert described["headers"][:2] == ["pid", "gender"]
        # SPSS answers from metadata alone, so it reads no rows and shows none.
        assert described["samples"] == [[] for _ in described["headers"]]

        text, meta = sav_to_csv_text(content, columns=[0, 2])
        assert text.splitlines()[0] == "pid,satisfied"
        # The per-column metadata narrows with it, which is what keeps
        # `apply_sav_metadata` (keyed on NAME) correct after a narrowing.
        assert sorted(meta) == ["pid", "satisfied"]


class TestAnUnknownColumnIsRefused:
    """All three adapters refuse the same way, and the reason is that they would
    otherwise DISAGREE: CSV and `.xlsx` can emit an empty column and keep the
    count, while `.sav` has no variable to read and would come back narrower than
    the selection — shifting every `column_index` the wizard holds.

    ⚠️ The router cannot do this check: it does not know the file's width until
    an adapter has read the header.
    """

    def test_csv(self):
        from app.services.dataset_import import select_csv_columns

        with pytest.raises(ValueError) as exc:
            select_csv_columns("a,b\n1,2\n", [0, 5])
        assert "column 6" in str(exc.value) and "2 columns" in str(exc.value)

    def test_xlsx(self):
        from app.services.dataset_import import XlsxImportError, xlsx_to_csv_text

        chooser = TestEveryFormatNarrowsAtItsOwnSource()
        with pytest.raises(XlsxImportError):
            xlsx_to_csv_text(chooser._xlsx([["Q1", "Q2"], [1, 2]]), None, [0, 9])

    def test_sav(self):
        from app.services.sav_import import SavImportError, sav_to_csv_text

        content = (
            __import__("pathlib").Path(__file__).parent
            / "reference_data" / "spss_sample.sav"
        ).read_bytes()
        with pytest.raises(SavImportError) as exc:
            sav_to_csv_text(content, columns=[0, 99])
        assert "column 100" in str(exc.value)

    def test_the_boundary_is_the_LAST_index_not_one_past_it(self):
        """⚠️ Added because a mutant SURVIVED: `i > width` instead of
        `i >= width` passed every other case here, because none of them sat ON
        the boundary — they were all far past it. A two-column file has valid
        indices 0 and 1, so index 2 is the first bad one and the only fixture
        that can tell the two comparisons apart."""
        from app.services.dataset_import import ColumnSelectionError, select_csv_columns

        # The last VALID index is accepted...
        assert select_csv_columns("a,b\n1,2\n", [1]) == "b\n2\n"
        # ...and the very next one is not.
        with pytest.raises(ColumnSelectionError):
            select_csv_columns("a,b\n1,2\n", [2])

    def test_the_refusal_reaches_the_researcher_verbatim(
        self, db_session, project, user,
    ):
        """#797's rule, and the reason `ColumnSelectionError` is its own type:
        the endpoint catches `(ValueError, csv.Error, TypeError)` and rewrites it
        to "Unable to parse CSV file. Check the file format" — wrong twice here,
        because the file parses and the fault is in the REQUEST."""
        with pytest.raises(HTTPException) as exc:
            _run(preview_dataset(
                project_id=project, file=_upload("a,b\n1,2\n"), encoding="utf-8",
                sheet_name=None, column_indices=json.dumps([0, 99]),
                user=user, db=db_session,
            ))
        assert exc.value.status_code == 400
        assert "column 100" in exc.value.detail
        assert "file format" not in exc.value.detail

    def test_a_short_ROW_is_still_just_an_empty_cell(self):
        """A ragged record is not a bad selection — the refusal is about the
        HEADER's width, never about one row's."""
        from app.services.dataset_import import select_csv_columns

        assert select_csv_columns("a,b,c\n1\n", [1, 2]) == "b,c\n,\n"


class TestDescribeCsvText:
    def test_it_counts_rows_and_samples_without_the_cap(self):
        """The property that makes it an escape hatch: it answers for a file
        `preview_dataset_csv` refuses."""
        described = describe_csv_text(_over_cap_csv(rows=12_000, cols=500))

        assert described["row_count"] == 12_000
        assert len(described["headers"]) == 500
        assert described["row_count"] * len(described["headers"]) > MAX_DATASET_CELLS

    def test_samples_are_bounded_by_construction(self):
        described = describe_csv_text("a\n" + "".join(f"{i}\n" for i in range(500)))
        assert described["row_count"] == 500
        assert described["samples"] == [["0", "1", "2", "3", "4"]]

    def test_blank_lines_are_not_records(self):
        """Agrees with `preview_dataset_csv`, so the two stages report the same
        size for the same file."""
        assert describe_csv_text("a,b\n1,2\n\n3,4\n")["row_count"] == 2
