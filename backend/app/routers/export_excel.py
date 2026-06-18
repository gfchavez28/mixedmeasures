"""Excel export endpoints — split from export.py for maintainability."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import func
import io
import json
from datetime import datetime
from collections import defaultdict
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.conversation import Conversation
from ..models.segment import Segment
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.audit import AuditEntry
from ..models.speaker import Speaker
from ..models.note import Note
from ..models.memo import Memo
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.metric import MetricDefinition
from ..models.excerpt import Excerpt
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.equivalence_group import EquivalenceGroup
from ..services.recode import compute_value
from ..services.metrics import resolve_input_source_labels
from ..auth import get_current_user
from .helpers import _get_project_or_404, sanitize_content_disposition
from .export_helpers import (
    _build_category_tree_and_chains,
    build_code_conversation_matrix,
    build_code_cooccurrence_matrix,
    EXPORT_VALUE_PRECISION,
    excel_set_safe,
    local_wall_time,
)

router = APIRouter(tags=["export"])


@router.get("/excel")
async def export_study_excel(
    project_id: int,
    include_coded_data: bool = True,
    include_matrix: bool = True,
    include_cooccurrence: bool = True,
    include_codebook: bool = True,
    include_memos: bool = True,
    include_notes: bool = True,
    include_summaries: bool = True,
    include_audit: bool = True,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Export project data as Excel with up to 8 sheets: Coded Data, Code-Conversation Matrix,
    Code Co-occurrence, Codebook, Memos, Notes, Summaries, Audit Trail."""
    project = _get_project_or_404(db, project_id, user.id)

    wb = Workbook()
    worksheets = []

    # Header styling
    header_fill = PatternFill(start_color="4F81BD", end_color="4F81BD", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF")
    diagonal_fill = PatternFill(start_color="D9D9D9", end_color="D9D9D9", fill_type="solid")

    # Get all codes for this project (used by multiple sheets)
    codes = db.query(Code).filter(
        Code.project_id == project_id,
        Code.is_active == True
    ).order_by(Code.numeric_id).all()

    # Get all conversations (used by multiple sheets)
    conversations = db.query(Conversation).filter(
        Conversation.project_id == project_id
    ).order_by(Conversation.created_at).all()

    # Create lookup dicts for entity name resolution
    code_id_to_name = {c.id: c.name for c in codes}
    conversation_id_to_name = {c.id: c.name for c in conversations}

    # Pre-query all whole-segment excerpts for this project (whole-segment excerpt lookup)
    quoted_seg_ids = set(
        eid for (eid,) in db.query(Excerpt.segment_id).filter(
            Excerpt.project_id == project_id,
            Excerpt.segment_id.isnot(None),
            Excerpt.start_offset.is_(None),
        ).all()
    )

    # ==================== Sheet 1: Coded Data ====================
    if include_coded_data:
        ws_coded = wb.active
        ws_coded.title = "Coded Data"
        worksheets.append(ws_coded)

        coded_headers = [
            "Conversation", "Segment ID", "Sequence", "Speaker", "Is Facilitator",
            "Start Time", "End Time", "Text", "Quoted"
        ]
        coded_headers.extend([f"{c.numeric_id} - {c.name}" for c in codes])

        for col, header in enumerate(coded_headers, 1):
            cell = ws_coded.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center")

        # Bulk-load all visible segments across conversations (avoids N+1)
        conv_ids = [c.id for c in conversations]
        all_segments = db.query(Segment).options(
            selectinload(Segment.code_applications),
            joinedload(Segment.speaker),
        ).filter(
            Segment.conversation_id.in_(conv_ids),
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        ).order_by(Segment.conversation_id, Segment.sequence_order).all()

        segments_by_conv: dict[int, list[Segment]] = defaultdict(list)
        for seg in all_segments:
            segments_by_conv[seg.conversation_id].append(seg)

        row = 2
        for conversation in conversations:
            segments = segments_by_conv.get(conversation.id, [])

            for segment in segments:
                applied_code_ids = set(ca.code_id for ca in segment.code_applications)

                speaker_name = ""
                is_facilitator = ""
                if segment.speaker:
                    speaker_name = segment.speaker.name
                    is_facilitator = "Yes" if segment.speaker.is_facilitator else "No"

                start_time = f"{segment.start_time:.2f}" if segment.start_time is not None else ""
                end_time = f"{segment.end_time:.2f}" if segment.end_time is not None else ""

                excel_set_safe(ws_coded.cell(row=row, column=1), conversation.name)
                ws_coded.cell(row=row, column=2, value=segment.id)
                ws_coded.cell(row=row, column=3, value=segment.sequence_order)
                excel_set_safe(ws_coded.cell(row=row, column=4), speaker_name)
                ws_coded.cell(row=row, column=5, value=is_facilitator)
                ws_coded.cell(row=row, column=6, value=start_time)
                ws_coded.cell(row=row, column=7, value=end_time)
                excel_set_safe(ws_coded.cell(row=row, column=8), segment.text)
                ws_coded.cell(row=row, column=9, value="Yes" if segment.id in quoted_seg_ids else "")

                for col_offset, code in enumerate(codes):
                    value = "X" if code.id in applied_code_ids else ""
                    ws_coded.cell(row=row, column=10 + col_offset, value=value)

                row += 1
    else:
        # Remove the default sheet if not including coded data
        wb.remove(wb.active)

    # ==================== Sheet 2: Code-Conversation Matrix ====================
    if include_matrix and codes and conversations:
        ws_matrix = wb.create_sheet("Code-Conversation Matrix")
        worksheets.append(ws_matrix)

        matrix_data = build_code_conversation_matrix(db, project_id)

        # Header row: blank + conversation names + Total. Conversation names
        # are user-supplied; defang via excel_set_safe.
        matrix_headers = ["Code"] + [c.name for c in conversations] + ["Total"]
        for col, header in enumerate(matrix_headers, 1):
            cell = ws_matrix.cell(row=1, column=col)
            excel_set_safe(cell, header)
            cell.fill = header_fill
            cell.font = header_font

        for row_num, code in enumerate(codes, 2):
            # Leading "{numeric_id} - " makes formula-prefix risk negligible
            # (numeric_id is auto-increment positive int), but defang anyway
            # for consistency.
            excel_set_safe(ws_matrix.cell(row=row_num, column=1), f"{code.numeric_id} - {code.name}")
            row_total = 0
            for col_num, conversation in enumerate(conversations, 2):
                count = matrix_data.get((conversation.id, code.id), 0)
                ws_matrix.cell(row=row_num, column=col_num, value=count if count > 0 else "")
                row_total += count
            ws_matrix.cell(row=row_num, column=len(conversations) + 2, value=row_total)

    # ==================== Sheet 3: Code Co-occurrence ====================
    if include_cooccurrence and codes:
        ws_cooccur = wb.create_sheet("Code Co-occurrence")
        worksheets.append(ws_cooccur)

        cooccur_data = build_code_cooccurrence_matrix(db, project_id)

        # Header row: blank + code names
        cooccur_headers = [""] + [f"{c.numeric_id} - {c.name}" for c in codes]
        for col, header in enumerate(cooccur_headers, 1):
            cell = ws_cooccur.cell(row=1, column=col)
            excel_set_safe(cell, header)
            cell.fill = header_fill
            cell.font = header_font

        for row_num, code_row in enumerate(codes, 2):
            excel_set_safe(ws_cooccur.cell(row=row_num, column=1), f"{code_row.numeric_id} - {code_row.name}")
            for col_num, code_col in enumerate(codes, 2):
                count = cooccur_data.get((code_row.id, code_col.id), 0)
                cell = ws_cooccur.cell(row=row_num, column=col_num, value=count if count > 0 else "")
                # Highlight diagonal
                if code_row.id == code_col.id:
                    cell.fill = diagonal_fill

    # ==================== Sheet 4: Codebook ====================
    if include_codebook:
        ws_codebook = wb.create_sheet("Codebook")
        worksheets.append(ws_codebook)

        codebook_headers = ["ID", "Name", "Description", "Universal", "Active", "Usage Count", "Created", "Category", "Category Path", "Category Depth"]
        for col, header in enumerate(codebook_headers, 1):
            cell = ws_codebook.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font

        # Batch usage counts (avoid N+1)
        code_ids = [c.id for c in codes]
        usage_counts = {}
        if code_ids:
            usage_rows = db.query(
                CodeApplication.code_id, func.count(CodeApplication.id)
            ).filter(CodeApplication.code_id.in_(code_ids)).group_by(CodeApplication.code_id).all()
            usage_counts = dict(usage_rows)

        # Category chain lookup
        cb_chain_map, _, _ = _build_category_tree_and_chains(db, project_id)

        for row_num, code in enumerate(codes, 2):
            ws_codebook.cell(row=row_num, column=1, value=code.numeric_id)
            excel_set_safe(ws_codebook.cell(row=row_num, column=2), code.name)
            excel_set_safe(ws_codebook.cell(row=row_num, column=3), code.description or "")
            ws_codebook.cell(row=row_num, column=4, value="Yes" if code.is_universal else "No")
            ws_codebook.cell(row=row_num, column=5, value="Yes" if code.is_active else "No")
            ws_codebook.cell(row=row_num, column=6, value=usage_counts.get(code.id, 0))
            ws_codebook.cell(row=row_num, column=7, value=local_wall_time(code.created_at))
            # Category columns
            cat_chain = cb_chain_map.get(code.category_id, []) if code.category_id else []
            excel_set_safe(ws_codebook.cell(row=row_num, column=8), cat_chain[-1] if cat_chain else "")
            excel_set_safe(ws_codebook.cell(row=row_num, column=9), " › ".join(cat_chain) if cat_chain else "")
            ws_codebook.cell(row=row_num, column=10, value=len(cat_chain) - 1 if cat_chain else "")

    # ==================== Sheet 5: Memos ====================
    if include_memos:
        ws_memos = wb.create_sheet("Memos")
        worksheets.append(ws_memos)

        memo_headers = ["ID", "Content", "Link Type", "Link Name", "Created", "Updated"]
        for col, header in enumerate(memo_headers, 1):
            cell = ws_memos.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font

        memos = db.query(Memo).filter(
            Memo.project_id == project_id,
            Memo.is_archived == False
        ).order_by(Memo.created_at).all()

        for row_num, memo in enumerate(memos, 2):
            # Resolve entity name
            link_name = ""
            if memo.entity_type == "project":
                link_name = project.name
            elif memo.entity_type == "conversation":
                link_name = conversation_id_to_name.get(memo.entity_id, f"Conversation {memo.entity_id}")
            elif memo.entity_type == "code":
                link_name = code_id_to_name.get(memo.entity_id, f"Code {memo.entity_id}")
            elif memo.entity_type == "code_category":
                link_name = f"Category {memo.entity_id}"

            ws_memos.cell(row=row_num, column=1, value=f"M-{memo.numeric_id}")
            excel_set_safe(ws_memos.cell(row=row_num, column=2), memo.content)
            ws_memos.cell(row=row_num, column=3, value=memo.entity_type.capitalize())
            excel_set_safe(ws_memos.cell(row=row_num, column=4), link_name)
            ws_memos.cell(row=row_num, column=5, value=local_wall_time(memo.created_at))
            ws_memos.cell(row=row_num, column=6, value=local_wall_time(memo.updated_at))

    # ==================== Sheet 6: Notes ====================
    if include_notes:
        ws_notes = wb.create_sheet("Notes")
        worksheets.append(ws_notes)

        note_headers = ["ID", "Content", "Conversation", "Segment #", "Segment Text", "Created", "Updated"]
        for col, header in enumerate(note_headers, 1):
            cell = ws_notes.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font

        notes = db.query(Note).options(
            joinedload(Note.segment),
        ).join(Conversation).filter(
            Conversation.project_id == project_id,
            Note.is_archived == False
        ).order_by(Note.created_at).all()

        for row_num, note in enumerate(notes, 2):
            conversation_name = conversation_id_to_name.get(note.conversation_id, "")
            segment_num = ""
            segment_text = ""
            if note.segment:
                segment_num = note.segment.sequence_order
                # Truncate segment text to 200 chars
                segment_text = note.segment.text[:200] + "..." if len(note.segment.text) > 200 else note.segment.text

            ws_notes.cell(row=row_num, column=1, value=f"N-{note.sequence_number}")
            excel_set_safe(ws_notes.cell(row=row_num, column=2), note.content)
            excel_set_safe(ws_notes.cell(row=row_num, column=3), conversation_name)
            ws_notes.cell(row=row_num, column=4, value=segment_num)
            excel_set_safe(ws_notes.cell(row=row_num, column=5), segment_text)
            ws_notes.cell(row=row_num, column=6, value=note.created_at.strftime("%Y-%m-%d %H:%M"))
            ws_notes.cell(row=row_num, column=7, value=note.updated_at.strftime("%Y-%m-%d %H:%M"))

    # ==================== Sheet 7: Summaries ====================
    if include_summaries:
        ws_summaries = wb.create_sheet("Summaries")
        worksheets.append(ws_summaries)

        summary_headers = ["Conversation", "Subject ID", "Date", "Status", "Summary"]
        for col, header in enumerate(summary_headers, 1):
            cell = ws_summaries.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font

        for row_num, conversation in enumerate(conversations, 2):
            excel_set_safe(ws_summaries.cell(row=row_num, column=1), conversation.name)
            excel_set_safe(ws_summaries.cell(row=row_num, column=2), conversation.subject_id or "")
            ws_summaries.cell(row=row_num, column=3, value=conversation.conversation_date.strftime("%Y-%m-%d") if conversation.conversation_date else "")
            ws_summaries.cell(row=row_num, column=4, value=conversation.status.value if conversation.status else "")
            excel_set_safe(ws_summaries.cell(row=row_num, column=5), conversation.summary or "")

    # ==================== Sheet 8: Audit Trail ====================
    if include_audit:
        ws_audit = wb.create_sheet("Audit Trail")
        worksheets.append(ws_audit)

        audit_headers = ["Timestamp", "Action", "Entity Type", "Entity ID", "Details"]
        for col, header in enumerate(audit_headers, 1):
            cell = ws_audit.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font

        audit_entries = db.query(AuditEntry).filter(
            AuditEntry.project_id == project_id
        ).order_by(AuditEntry.timestamp.desc()).limit(1000).all()

        for row_num, entry in enumerate(audit_entries, 2):
            ws_audit.cell(row=row_num, column=1, value=entry.timestamp.strftime("%Y-%m-%d %H:%M:%S"))
            excel_set_safe(ws_audit.cell(row=row_num, column=2), entry.action)
            excel_set_safe(ws_audit.cell(row=row_num, column=3), entry.entity_type)
            ws_audit.cell(row=row_num, column=4, value=entry.entity_id)
            excel_set_safe(ws_audit.cell(row=row_num, column=5), entry.details or "")

    # Adjust column widths for all worksheets
    for ws in worksheets:
        for column in ws.columns:
            if not hasattr(column[0], 'column_letter'):
                continue
            max_length = 0
            column_letter = column[0].column_letter
            for cell in column:
                try:
                    if len(str(cell.value)) > max_length:
                        max_length = len(str(cell.value))
                except (TypeError, AttributeError):
                    pass
            adjusted_width = min(max_length + 2, 50)
            ws.column_dimensions[column_letter].width = adjusted_width

    # Save to bytes
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = f"{sanitize_content_disposition(project.name)}_export_{datetime.now().strftime('%Y%m%d')}.xlsx"

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.get("/datasets-excel")
async def export_datasets_excel(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Export all datasets as Excel with one sheet per dataset plus a Data Dictionary."""
    project = _get_project_or_404(db, project_id, user.id)

    # Get all datasets for this project
    datasets = db.query(Dataset).filter(
        Dataset.project_id == project_id
    ).order_by(Dataset.name).all()

    if not datasets:
        raise HTTPException(status_code=404, detail="No datasets found")

    wb = Workbook()

    # Styling
    header_fill = PatternFill(start_color="4F81BD", end_color="4F81BD", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF")
    recode_fill = PatternFill(start_color="D9D9D9", end_color="D9D9D9", fill_type="solid")
    recode_font = Font(bold=True)

    worksheets = []
    # Track data for Data Dictionary sheet
    dict_rows = []

    # Excel disallows / \ : * ? [ ] in sheet titles (and a 31-char cap).
    _SHEET_INVALID = ("/", "\\", ":", "*", "?", "[", "]")

    def _sanitize_sheet_title(name: str) -> str:
        cleaned = name
        for ch in _SHEET_INVALID:
            cleaned = cleaned.replace(ch, "_")
        cleaned = cleaned[:31] or "Sheet"
        return cleaned

    for ds_idx, dataset in enumerate(datasets):
        # Create sheet (use active for first, create for rest)
        if ds_idx == 0:
            ws = wb.active
        else:
            ws = wb.create_sheet()
        ws.title = _sanitize_sheet_title(dataset.name)
        worksheets.append(ws)

        # Load columns (skip SKIP type), ordered by sequence_order
        columns = [col for col in dataset.columns
                   if col.column_type != ColumnType.SKIP]

        # Build column layout: for each column, determine export columns
        # Each entry: (header_text, is_recode, column, recode_definition_or_None)
        col_defs = []
        # Leading columns
        col_defs.append(("Record", False, None, None))
        col_defs.append(("Participant", False, None, None))

        for column in columns:
            # Raw value column
            col_defs.append((column.column_code or f"C{column.sequence_order + 1:03d}",
                             False, column, None))

            # Primary recode column (value_numeric)
            primary_def = None
            non_primary_defs = []
            for rd in column.recode_definitions:
                if rd.is_primary:
                    primary_def = rd
                else:
                    non_primary_defs.append(rd)

            if primary_def:
                code = column.column_code or f"C{column.sequence_order + 1:03d}"
                col_defs.append((f"{code} [numeric]", True, column, primary_def))

            # Non-primary recode columns
            for rd in non_primary_defs:
                code = column.column_code or f"C{column.sequence_order + 1:03d}"
                col_defs.append((f"{code} [{rd.name}]", True, column, rd))

            # Collect data dictionary rows
            if not primary_def and not non_primary_defs:
                # No recodes — one row with empty recode columns
                scale_labels_str = ""
                if column.scale_labels:
                    try:
                        labels = json.loads(column.scale_labels)
                        scale_labels_str = ", ".join(str(l) for l in labels)
                    except (json.JSONDecodeError, TypeError):
                        scale_labels_str = column.scale_labels
                dict_rows.append({
                    "dataset": dataset.name,
                    "code": column.column_code or "",
                    "text": column.column_text,
                    "type": column.column_type.value,
                    "scale_labels": scale_labels_str,
                    "source": column.source or "imported",
                    "recode_name": "",
                    "recode_type": "",
                    "mapping": "",
                })
            else:
                all_defs = ([primary_def] if primary_def else []) + non_primary_defs
                for rd in all_defs:
                    scale_labels_str = ""
                    if column.scale_labels:
                        try:
                            labels = json.loads(column.scale_labels)
                            scale_labels_str = ", ".join(str(l) for l in labels)
                        except (json.JSONDecodeError, TypeError):
                            scale_labels_str = column.scale_labels
                    mapping_str = ""
                    if rd.mapping:
                        try:
                            m = json.loads(rd.mapping)
                            mapping_str = "; ".join(f"{k} -> {v}" for k, v in m.items())
                        except (json.JSONDecodeError, TypeError):
                            mapping_str = rd.mapping
                    dict_rows.append({
                        "dataset": dataset.name,
                        "code": column.column_code or "",
                        "text": column.column_text,
                        "type": column.column_type.value,
                        "scale_labels": scale_labels_str,
                        "source": column.source or "imported",
                        "recode_name": rd.name + (" (primary)" if rd.is_primary else ""),
                        "recode_type": rd.recode_type.value if hasattr(rd.recode_type, 'value') else str(rd.recode_type),
                        "mapping": mapping_str,
                    })

        # Write header row. Column codes flow into headers; defang.
        for col_idx, (header_text, is_recode, _, _) in enumerate(col_defs, 1):
            cell = ws.cell(row=1, column=col_idx)
            excel_set_safe(cell, header_text)
            if is_recode:
                cell.fill = recode_fill
                cell.font = recode_font
            else:
                cell.fill = header_fill
                cell.font = header_font
            cell.alignment = Alignment(horizontal="center")

        # Load responses with answers and participant
        responses = db.query(DatasetRow).filter(
            DatasetRow.dataset_id == dataset.id
        ).order_by(DatasetRow.id).all()

        # Build answer lookup: {(row_id, column_id): answer}
        answer_lookup = {}
        for response in responses:
            for answer in response.values:
                answer_lookup[(response.id, answer.column_id)] = answer

        # Write data rows
        for row_idx, response in enumerate(responses, 2):
            # Record
            excel_set_safe(ws.cell(row=row_idx, column=1), response.row_identifier or "")
            # Participant
            participant_name = ""
            if response.participant:
                participant_name = response.participant.display_name or response.participant.identifier or ""
            excel_set_safe(ws.cell(row=row_idx, column=2), participant_name)

            # Data columns
            col_idx = 3
            for header_text, is_recode, column, recode_def in col_defs[2:]:
                answer = answer_lookup.get((response.id, column.id))
                if answer is None:
                    ws.cell(row=row_idx, column=col_idx, value="")
                elif recode_def is None:
                    # Raw value column — value_text is respondent free-text.
                    excel_set_safe(ws.cell(row=row_idx, column=col_idx), answer.value_text or "")
                elif recode_def.is_primary:
                    # Primary recode: use stored value_numeric
                    val = answer.value_numeric
                    ws.cell(row=row_idx, column=col_idx, value=val if val is not None else "")
                else:
                    # Non-primary recode: compute on the fly
                    if answer.value_text:
                        computed = compute_value(answer.value_text, recode_def)
                        ws.cell(row=row_idx, column=col_idx, value=computed if computed is not None else "")
                    else:
                        ws.cell(row=row_idx, column=col_idx, value="")
                col_idx += 1

    # ==================== Data Dictionary sheet ====================
    ws_dict = wb.create_sheet("Data Dictionary")
    worksheets.append(ws_dict)

    dict_headers = ["Dataset", "Code", "Column label", "Type", "Scale Labels",
                     "Source", "Recode Name", "Recode Type", "Mapping"]
    for col_idx, header in enumerate(dict_headers, 1):
        cell = ws_dict.cell(row=1, column=col_idx, value=header)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    for row_idx, row_data in enumerate(dict_rows, 2):
        excel_set_safe(ws_dict.cell(row=row_idx, column=1), row_data["dataset"])
        excel_set_safe(ws_dict.cell(row=row_idx, column=2), row_data["code"])
        excel_set_safe(ws_dict.cell(row=row_idx, column=3), row_data["text"])
        ws_dict.cell(row=row_idx, column=4, value=row_data["type"])
        excel_set_safe(ws_dict.cell(row=row_idx, column=5), row_data["scale_labels"])
        ws_dict.cell(row=row_idx, column=6, value=row_data["source"])
        excel_set_safe(ws_dict.cell(row=row_idx, column=7), row_data["recode_name"])
        ws_dict.cell(row=row_idx, column=8, value=row_data["recode_type"])
        excel_set_safe(ws_dict.cell(row=row_idx, column=9), row_data["mapping"])

    # ==================== Computed Metrics Sheets ====================

    METRIC_TYPE_DISPLAY = {
        "frequency_distribution": "Frequency Distribution",
        "proportion": "Proportion (% Meeting Threshold)",
        "mean": "Mean",
        "domain_aggregate": "Domain Aggregate",
    }

    stale_fill = PatternFill(start_color="FFFFCC", end_color="FFFFCC", fill_type="solid")

    def safe_sheet_name(name: str) -> str:
        """Ensure sheet name is unique (max 31 chars) and doesn't collide with existing sheets."""
        name = name[:31]
        if name in wb.sheetnames:
            name = f"{name[:18]} (Computed)"[:31]
        return name

    # Load all metrics with results for this project
    all_metrics = (
        db.query(MetricDefinition)
        .options(joinedload(MetricDefinition.results))
        .filter(MetricDefinition.project_id == project_id)
        .order_by(MetricDefinition.sequence_order)
        .all()
    )

    metrics_with_results = [m for m in all_metrics if len(m.results) > 0]

    if metrics_with_results:
        # Batch resolve labels
        label_map = resolve_input_source_labels(db, metrics_with_results)

        # Build domain membership map: (member_type, member_id) → domain_name
        domain_members = (
            db.query(AnalysisDomainMember, AnalysisDomain.name)
            .join(AnalysisDomain)
            .filter(AnalysisDomain.project_id == project_id)
            .all()
        )
        domain_name_map = {
            (dm.member_type, dm.member_id): dname
            for dm, dname in domain_members
        }

        # Build column → equivalence_group_id map for indirection lookup
        metric_col_ids = [
            m.input_source_id for m in metrics_with_results
            if m.input_source_type == "dataset_column"
        ]
        col_equiv_map = {}
        if metric_col_ids:
            col_eq_rows = (
                db.query(DatasetColumn.id, DatasetColumn.equivalence_group_id)
                .filter(DatasetColumn.id.in_(metric_col_ids))
                .all()
            )
            col_equiv_map = {cid: eq_id for cid, eq_id in col_eq_rows if eq_id is not None}

        # Build domain name map for AnalysisDomain IDs (for dataset_domain metrics)
        domain_id_name_map = {}
        domain_ids = [m.input_source_id for m in metrics_with_results if m.input_source_type == "dataset_domain"]
        if domain_ids:
            domain_rows = (
                db.query(AnalysisDomain.id, AnalysisDomain.name)
                .filter(AnalysisDomain.id.in_(domain_ids))
                .all()
            )
            domain_id_name_map = {did: dname for did, dname in domain_rows}

        def resolve_domain_name(metric: MetricDefinition) -> str:
            """Resolve domain name for a metric."""
            if metric.input_source_type == "dataset_domain":
                return domain_id_name_map.get(metric.input_source_id, "")
            # dataset_column: check direct column membership
            dn = domain_name_map.get(("column", metric.input_source_id))
            if dn:
                return dn
            # Check via equivalence_group_id indirection
            eq_id = col_equiv_map.get(metric.input_source_id)
            if eq_id:
                dn = domain_name_map.get(("equivalence_group", eq_id))
                if dn:
                    return dn
            return ""

        # Partition metrics
        ungrouped = [m for m in metrics_with_results if m.grouping_column_id is None and m.grouping_column_id_2 is None and m.grouping_mode != "dataset"]
        grouped = [m for m in metrics_with_results if m.grouping_column_id is not None or m.grouping_column_id_2 is not None or m.grouping_mode == "dataset"]

        # ── Sheet: Metrics Summary (ungrouped only) ──
        if ungrouped:
            ws_summary = wb.create_sheet(safe_sheet_name("Metrics Summary"))
            worksheets.append(ws_summary)

            summary_headers = ["#", "Name", "Type", "Input Source", "Domain",
                               "Value", "Valid N", "Total N", "Stale", "Computed At"]
            for col_idx, header in enumerate(summary_headers, 1):
                cell = ws_summary.cell(row=1, column=col_idx, value=header)
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center")

            for row_idx, metric in enumerate(ungrouped, 2):
                result = metric.results[0]
                try:
                    rd = json.loads(result.result_data) if isinstance(result.result_data, str) else result.result_data
                except (json.JSONDecodeError, TypeError):
                    rd = {}

                source_label = label_map.get(
                    (metric.input_source_type, metric.input_source_id), ""
                )
                domain_name = resolve_domain_name(metric)

                # Value depends on metric type
                value = None
                if metric.metric_type == "proportion":
                    value = rd.get("percentage")
                elif metric.metric_type == "mean":
                    value = rd.get("mean")
                elif metric.metric_type == "domain_aggregate":
                    value = rd.get("aggregate_value")
                # frequency_distribution: leave blank

                ws_summary.cell(row=row_idx, column=1, value=row_idx - 1)
                # metric.name and domain_name flow from user-typed input; the
                # Tier-3 auto-create path also synthesizes f"{domain.name} Score"
                # so the risk is hot here.
                excel_set_safe(ws_summary.cell(row=row_idx, column=2), metric.name)
                ws_summary.cell(row=row_idx, column=3, value=METRIC_TYPE_DISPLAY.get(metric.metric_type, metric.metric_type))
                excel_set_safe(ws_summary.cell(row=row_idx, column=4), source_label)
                excel_set_safe(ws_summary.cell(row=row_idx, column=5), domain_name)
                if value is not None:
                    ws_summary.cell(row=row_idx, column=6, value=round(value, EXPORT_VALUE_PRECISION))
                ws_summary.cell(row=row_idx, column=7, value=result.valid_n)
                ws_summary.cell(row=row_idx, column=8, value=result.total_n)
                ws_summary.cell(row=row_idx, column=9, value="Yes" if metric.stale else "No")
                ws_summary.cell(
                    row=row_idx, column=10,
                    value=result.computed_at.strftime("%Y-%m-%d %H:%M") if result.computed_at else ""
                )

                if metric.stale:
                    for c in range(1, len(summary_headers) + 1):
                        ws_summary.cell(row=row_idx, column=c).fill = stale_fill

        # ── Sheet: Metrics Detail (freq dist sections + domain agg breakdowns) ──
        ungrouped_freq = [m for m in ungrouped if m.metric_type == "frequency_distribution"]
        ungrouped_domain_agg = [m for m in ungrouped if m.metric_type == "domain_aggregate"]

        if ungrouped_freq or ungrouped_domain_agg:
            ws_detail = wb.create_sheet(safe_sheet_name("Metrics Detail"))
            worksheets.append(ws_detail)
            detail_row = 1

            # Section A: Frequency Distributions
            if ungrouped_freq:
                # Section header
                ws_detail.cell(row=detail_row, column=1, value="FREQUENCY DISTRIBUTIONS")
                ws_detail.cell(row=detail_row, column=1).font = Font(bold=True, size=12)
                ws_detail.merge_cells(start_row=detail_row, start_column=1, end_row=detail_row, end_column=5)
                detail_row += 1

                # Column headers
                freq_headers = ["Metric", "Response Option", "Count", "Percentage", "Valid N"]
                for col_idx, header in enumerate(freq_headers, 1):
                    cell = ws_detail.cell(row=detail_row, column=col_idx, value=header)
                    cell.fill = header_fill
                    cell.font = header_font
                detail_row += 1

                for metric in ungrouped_freq:
                    result = metric.results[0]
                    try:
                        rd = json.loads(result.result_data) if isinstance(result.result_data, str) else result.result_data
                    except (json.JSONDecodeError, TypeError):
                        rd = {}

                    source_label = label_map.get(
                        (metric.input_source_type, metric.input_source_id), metric.name
                    )
                    distribution = rd.get("distribution", {})
                    valid_n = result.valid_n

                    first_row = True
                    for option, count in distribution.items():
                        excel_set_safe(
                            ws_detail.cell(row=detail_row, column=1),
                            source_label if first_row else "",
                        )
                        # `option` is a scale-label key, user-supplied.
                        excel_set_safe(ws_detail.cell(row=detail_row, column=2), option)
                        ws_detail.cell(row=detail_row, column=3, value=count)
                        pct = (count / valid_n * 100) if valid_n else 0
                        ws_detail.cell(row=detail_row, column=4,
                                       value=round(pct, EXPORT_VALUE_PRECISION))
                        if first_row:
                            ws_detail.cell(row=detail_row, column=5, value=valid_n)
                        first_row = False
                        detail_row += 1

                    if metric.stale:
                        for r in range(detail_row - len(distribution), detail_row):
                            for c in range(1, 6):
                                ws_detail.cell(row=r, column=c).fill = stale_fill

                    detail_row += 1  # blank row separator

            # Section B: Domain Aggregate Breakdowns
            if ungrouped_domain_agg:
                detail_row += 1
                ws_detail.cell(row=detail_row, column=1, value="DOMAIN AGGREGATE BREAKDOWNS")
                ws_detail.cell(row=detail_row, column=1).font = Font(bold=True, size=12)
                ws_detail.merge_cells(start_row=detail_row, start_column=1, end_row=detail_row, end_column=5)
                detail_row += 1

                agg_headers = ["Domain", "Item", "Item Mean", "Domain Score", "Valid N"]
                for col_idx, header in enumerate(agg_headers, 1):
                    cell = ws_detail.cell(row=detail_row, column=col_idx, value=header)
                    cell.fill = header_fill
                    cell.font = header_font
                detail_row += 1

                for metric in ungrouped_domain_agg:
                    result = metric.results[0]
                    try:
                        rd = json.loads(result.result_data) if isinstance(result.result_data, str) else result.result_data
                    except (json.JSONDecodeError, TypeError):
                        rd = {}

                    domain_name = resolve_domain_name(metric)
                    agg_value = rd.get("aggregate_value")
                    col_means = rd.get("column_means", {})

                    first_row = True
                    for item_name, item_mean in col_means.items():
                        excel_set_safe(
                            ws_detail.cell(row=detail_row, column=1),
                            domain_name if first_row else "",
                        )
                        # `item_name` is a column code/name, user-supplied.
                        excel_set_safe(ws_detail.cell(row=detail_row, column=2), item_name)
                        ws_detail.cell(row=detail_row, column=3,
                                       value=round(item_mean, EXPORT_VALUE_PRECISION) if item_mean is not None else "")
                        if first_row:
                            ws_detail.cell(row=detail_row, column=4,
                                           value=round(agg_value, EXPORT_VALUE_PRECISION) if agg_value is not None else "")
                            ws_detail.cell(row=detail_row, column=5, value=result.valid_n)
                        first_row = False
                        detail_row += 1

                    if metric.stale:
                        for r in range(detail_row - len(col_means), detail_row):
                            for c in range(1, 6):
                                ws_detail.cell(row=r, column=c).fill = stale_fill

                    detail_row += 1  # blank row separator

        # ── Sheet(s): Grouped metrics ──
        # Build grouping column name lookup
        grp_col_ids = set()
        for m in grouped:
            if m.grouping_column_id:
                grp_col_ids.add(m.grouping_column_id)
            if m.grouping_column_id_2:
                grp_col_ids.add(m.grouping_column_id_2)
        grp_col_name_map = {}
        if grp_col_ids:
            grp_col_rows = (
                db.query(DatasetColumn.id, DatasetColumn.column_code, DatasetColumn.column_name)
                .filter(DatasetColumn.id.in_(grp_col_ids))
                .all()
            )
            grp_col_name_map = {cid: (ccode or cname or f"Col {cid}") for cid, ccode, cname in grp_col_rows}

        if grouped:
            ws_grouped = wb.create_sheet(safe_sheet_name("Grouped Metrics"))
            worksheets.append(ws_grouped)

            group_headers = ["#", "Name", "Type", "Input Source", "Domain",
                             "Group By", "Group Value", "Value", "Valid N", "Total N", "Stale"]
            for col_idx, header in enumerate(group_headers, 1):
                cell = ws_grouped.cell(row=1, column=col_idx, value=header)
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center")

            group_row = 2
            for metric in grouped:
                source_label = label_map.get(
                    (metric.input_source_type, metric.input_source_id), metric.name
                )
                domain_name = resolve_domain_name(metric)

                # Build group-by label
                grp_parts = []
                if metric.grouping_mode == "dataset":
                    grp_parts.append("Dataset")
                if metric.grouping_column_id:
                    grp_parts.append(grp_col_name_map.get(metric.grouping_column_id, f"Col {metric.grouping_column_id}"))
                if metric.grouping_column_id_2:
                    grp_parts.append(grp_col_name_map.get(metric.grouping_column_id_2, f"Col {metric.grouping_column_id_2}"))
                grp_label = " × ".join(grp_parts) if grp_parts else ""

                for result in metric.results:
                    try:
                        rd = json.loads(result.result_data) if isinstance(result.result_data, str) else result.result_data
                    except (json.JSONDecodeError, TypeError):
                        rd = {}

                    value = None
                    if metric.metric_type == "proportion":
                        value = rd.get("percentage")
                    elif metric.metric_type == "mean":
                        value = rd.get("mean")
                    elif metric.metric_type == "domain_aggregate":
                        value = rd.get("aggregate_value")

                    ws_grouped.cell(row=group_row, column=1, value=group_row - 1)
                    excel_set_safe(ws_grouped.cell(row=group_row, column=2), metric.name)
                    ws_grouped.cell(row=group_row, column=3, value=METRIC_TYPE_DISPLAY.get(metric.metric_type, metric.metric_type))
                    excel_set_safe(ws_grouped.cell(row=group_row, column=4), source_label)
                    excel_set_safe(ws_grouped.cell(row=group_row, column=5), domain_name)
                    excel_set_safe(ws_grouped.cell(row=group_row, column=6), grp_label)
                    # group_value is the partition key, often a user-typed
                    # column-value label (e.g., a treatment-arm name).
                    excel_set_safe(ws_grouped.cell(row=group_row, column=7), result.group_value or "")
                    if value is not None:
                        ws_grouped.cell(row=group_row, column=8, value=round(value, EXPORT_VALUE_PRECISION))
                    ws_grouped.cell(row=group_row, column=9, value=result.valid_n)
                    ws_grouped.cell(row=group_row, column=10, value=result.total_n)
                    ws_grouped.cell(row=group_row, column=11, value="Yes" if metric.stale else "No")

                    if metric.stale:
                        for c in range(1, len(group_headers) + 1):
                            ws_grouped.cell(row=group_row, column=c).fill = stale_fill

                    group_row += 1

    # Adjust column widths for all worksheets
    for ws in worksheets:
        for column in ws.columns:
            # Skip merged cells (MergedCell has no column_letter)
            if not hasattr(column[0], 'column_letter'):
                continue
            max_length = 0
            column_letter = column[0].column_letter
            for cell in column:
                try:
                    if len(str(cell.value)) > max_length:
                        max_length = len(str(cell.value))
                except (TypeError, AttributeError, ValueError):
                    pass
            adjusted_width = min(max_length + 2, 50)
            ws.column_dimensions[column_letter].width = adjusted_width

    # Save to bytes
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = f"{sanitize_content_disposition(project.name)}_datasets_{datetime.now().strftime('%Y%m%d')}.xlsx"

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )
