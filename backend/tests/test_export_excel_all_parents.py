"""The study Excel export spans every source type (#620).

The gap these close is a fail-OPEN omission: sheets titled "Coded Data" and
"Notes" gathered through an INNER join on Conversation, so document segments
(live since documents shipped), observation clips, and every document /
observation / dataset-value note were absent from a workbook that presented
itself as the whole study. Same shape as #616, which fixed the coded-segments
CSV in slab 4c and did not touch the Excel side.

⚠️ Fixture discipline: the project below carries a conversation AND a document
AND an observation, each with its own coded segment, note and quote. A
conversation-only fixture passes under the OLD code and the new — it is exactly
what let this live so long. Every assertion here names a non-conversation row.
"""
import asyncio
import io

import pytest
from openpyxl import load_workbook

from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.document import Document
from app.models.excerpt import Excerpt
from app.models.memo import Memo
from app.models.note import Note
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User


def _run(coro):
    return asyncio.run(coro)


PID = 860


@pytest.fixture
def three_parent_project(db_session):
    """One project, one coded+noted+quoted unit per source type."""
    db = db_session
    db.add(Project(id=PID, name="Three Parents", user_id=1))
    db.add(Conversation(id=PID, project_id=PID, name="Interview A"))
    db.add(Document(id=PID, project_id=PID, name="Field Notes B",
                    source_filename="field_notes.docx", source_format="docx",
                    summary="A doc summary"))
    db.add(Observation(id=PID, project_id=PID, name="Playground C"))
    db.add(Code(id=PID, project_id=PID, name="Belonging", numeric_id=1,
                is_active=True, is_universal=False))
    db.flush()

    conv_seg = Segment(id=8601, conversation_id=PID, text="conversation turn text",
                       sequence_order=0)
    doc_seg = Segment(id=8602, document_id=PID, text="document paragraph text",
                      sequence_order=0)
    clip = Segment(id=8603, observation_id=PID, text="clip label",
                   start_time=10.0, end_time=20.0, sequence_order=0)
    db.add_all([conv_seg, doc_seg, clip])
    db.flush()

    for sid in (8601, 8602, 8603):
        db.add(CodeApplication(code_id=PID, user_id=1, segment_id=sid))
        db.add(Excerpt(project_id=PID, segment_id=sid))

    db.add(Note(id=8601, conversation_id=PID, segment_id=8601,
                content="a conversation note", sequence_number=1))
    db.add(Note(id=8602, document_id=PID, segment_id=8602,
                content="a document note", sequence_number=2))
    db.add(Note(id=8603, observation_id=PID, segment_id=8603,
                content="an observation note", sequence_number=3))
    db.flush()
    return db


def _sheets(db):
    """Render the workbook and read it back — the export is only correct if
    openpyxl can reopen what it wrote."""
    from app.routers.export_excel import export_study_excel
    from tests.test_export_formula_injection import _stream_to_bytes
    user = db.get(User, 1)
    response = _run(export_study_excel(project_id=PID, user=user, db=db))
    return load_workbook(io.BytesIO(_stream_to_bytes(response)))


def _rows(ws):
    header = [c.value for c in ws[1]]
    return header, [
        {header[i]: c.value for i, c in enumerate(row) if i < len(header)}
        for row in ws.iter_rows(min_row=2)
    ]


class TestCodedDataSheetSpansAllParents:
    def test_every_source_type_has_a_row_and_says_which_it_is(self, three_parent_project):
        wb = _sheets(three_parent_project)
        header, rows = _rows(wb["Coded Data"])

        assert header[:2] == ["Source Type", "Source"]
        by_kind = {r["Source Type"]: r for r in rows}
        assert set(by_kind) == {"conversation", "document", "observation"}
        assert by_kind["document"]["Source"] == "Field Notes B"
        assert by_kind["observation"]["Source"] == "Playground C"
        assert by_kind["document"]["Text"] == "document paragraph text"

    def test_the_code_column_marks_the_non_conversation_rows(self, three_parent_project):
        """The whole point: their CODINGS were missing, not just their names."""
        wb = _sheets(three_parent_project)
        header, rows = _rows(wb["Coded Data"])
        code_col = next(h for h in header if h and h.startswith("1 - "))
        marked = {r["Source Type"] for r in rows if r[code_col] == "X"}
        assert marked == {"conversation", "document", "observation"}

    def test_speaker_columns_stay_blank_rather_than_inventing_a_value(self, three_parent_project):
        wb = _sheets(three_parent_project)
        _, rows = _rows(wb["Coded Data"])
        for r in rows:
            if r["Source Type"] in ("document", "observation"):
                assert (r["Speaker"] or "") == ""
                assert (r["Is Facilitator"] or "") == ""

    def test_the_quoted_flag_now_reaches_non_conversation_units(self, three_parent_project):
        wb = _sheets(three_parent_project)
        _, rows = _rows(wb["Coded Data"])
        assert {r["Source Type"] for r in rows if r["Quoted"] == "Yes"} == {
            "conversation", "document", "observation"
        }


class TestNotesSheetSpansAllParents:
    def test_document_and_observation_notes_are_present_and_named(self, three_parent_project):
        wb = _sheets(three_parent_project)
        header, rows = _rows(wb["Notes"])

        assert "Source Type" in header and "Source" in header
        by_content = {r["Content"]: r for r in rows}
        assert set(by_content) == {
            "a conversation note", "a document note", "an observation note"
        }
        assert by_content["a document note"]["Source Type"] == "document"
        assert by_content["a document note"]["Source"] == "Field Notes B"
        assert by_content["an observation note"]["Source Type"] == "observation"
        assert by_content["an observation note"]["Source"] == "Playground C"


class TestQuotesSheet:
    def test_quotes_reach_excel_with_their_text_and_ranges(self, three_parent_project):
        """Before #620 an excerpt was a Yes/No flag; its TEXT was nowhere."""
        wb = _sheets(three_parent_project)
        assert "Quotes" in wb.sheetnames
        _, rows = _rows(wb["Quotes"])

        by_kind = {r["Source Type"]: r for r in rows}
        assert set(by_kind) == {"conversation", "document", "observation"}
        assert by_kind["document"]["Quote Text"] == "document paragraph text"
        # A whole-CLIP quote's identity is the clip's range — its label is
        # often blank, so the range is what makes the row usable.
        assert by_kind["observation"]["Start Time"] == "0:10.0"
        assert by_kind["observation"]["End Time"] == "0:20.0"
        assert by_kind["observation"]["Type"] == "whole-segment"


class TestMemoLinkNames:
    def test_a_document_memo_resolves_its_name_instead_of_a_blank(self, three_parent_project):
        """Link Type said "Document" while Link Name was empty (#620)."""
        db = three_parent_project
        db.add(Memo(project_id=PID, entity_type="document", entity_id=PID,
                    numeric_id=1, content="on the doc"))
        db.add(Memo(project_id=PID, entity_type="observation", entity_id=PID,
                    numeric_id=2, content="on the obs"))
        db.flush()

        wb = _sheets(db)
        _, rows = _rows(wb["Memos"])
        by_content = {r["Content"]: r for r in rows}
        assert by_content["on the doc"]["Link Name"] == "Field Notes B"
        assert by_content["on the obs"]["Link Name"] == "Playground C"

    def test_an_unmapped_entity_type_falls_back_rather_than_blanking(self, three_parent_project):
        db = three_parent_project
        db.add(Memo(project_id=PID, entity_type="dataset", entity_id=77,
                    numeric_id=3, content="on a dataset"))
        db.flush()

        wb = _sheets(db)
        _, rows = _rows(wb["Memos"])
        link = next(r["Link Name"] for r in rows if r["Content"] == "on a dataset")
        assert link == "Dataset 77"


class TestSummariesSheet:
    def test_a_document_summary_is_exported(self, three_parent_project):
        wb = _sheets(three_parent_project)
        header, rows = _rows(wb["Summaries"])
        assert header[0] == "Source Type"
        doc_rows = [r for r in rows if r["Source Type"] == "document"]
        assert len(doc_rows) == 1
        assert doc_rows[0]["Source"] == "Field Notes B"
        assert doc_rows[0]["Summary"] == "A doc summary"


class TestCodeSourceMatrixSheet:
    """#629 — the last sheet #620 left conversation-only.

    ⚠️ The shared `PID` is load-bearing here, not laziness: the conversation,
    the document and the observation all have id 860, which is legal because the
    three parents are independent sequences. A matrix keyed by bare source id
    collapses them into one column, and no conversation-only fixture can see it.
    """

    def test_every_source_type_gets_a_column_that_names_its_type(self, three_parent_project):
        wb = _sheets(three_parent_project)
        assert "Code-Source Matrix" in wb.sheetnames, (
            "the sheet was renamed from 'Code-Conversation Matrix' — it no "
            "longer describes only conversations"
        )
        header, rows = _rows(wb["Code-Source Matrix"])

        assert header[0] == "Code"
        assert header[-1] == "Total"
        # One column per source, each carrying its type so two same-named
        # sources of different kinds stay distinguishable.
        assert header[1:-1] == [
            "Interview A (conversation)",
            "Field Notes B (document)",
            "Playground C (observation)",
        ]

        assert len(rows) == 1
        row = rows[0]
        assert row["Code"] == "1 - Belonging"
        assert row["Interview A (conversation)"] == 1
        assert row["Field Notes B (document)"] == 1, "document segments reach the matrix"
        assert row["Playground C (observation)"] == 1, "observation clips reach the matrix"
        assert row["Total"] == 3, (
            "3 distinct coded units across 3 sources — a bare-id key would put "
            "all three in one column and the other two would read blank"
        )

    def test_the_code_column_stays_visible_when_the_axis_is_wide(self, three_parent_project):
        """Freeze panes: the axis got wider, so scrolling right must not strand
        the reader among unlabelled numbers."""
        wb = _sheets(three_parent_project)
        assert wb["Code-Source Matrix"].freeze_panes == "B2"

    def test_the_sheet_survives_a_project_with_no_conversations(self, db_session):
        """The gate was `include_matrix and codes and conversations`, so an
        observation-only project — however much coded material it held — got no
        matrix sheet at all, silently and with nothing saying why. Same shape as
        #626/#627 calling an observation-only project empty.
        """
        db = db_session
        db.add(Project(id=PID, name="Observation only", user_id=1))
        db.add(Observation(id=PID, project_id=PID, name="Playground C"))
        db.add(Code(id=PID, project_id=PID, name="Belonging", numeric_id=1,
                    is_active=True, is_universal=False))
        db.flush()
        db.add(Segment(id=8613, observation_id=PID, text="clip label",
                       start_time=1.0, end_time=2.0, sequence_order=0))
        db.flush()
        db.add(CodeApplication(code_id=PID, user_id=1, segment_id=8613))
        db.flush()

        wb = _sheets(db)
        assert "Code-Source Matrix" in wb.sheetnames, (
            "a project with zero conversations still has coded sources (#629)"
        )
        header, rows = _rows(wb["Code-Source Matrix"])
        assert header[1:-1] == ["Playground C (observation)"]
        assert rows[0]["Playground C (observation)"] == 1
