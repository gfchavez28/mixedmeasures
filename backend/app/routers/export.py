from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import func
import io
import csv
from datetime import datetime, timezone
from collections import defaultdict

from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.conversation import Conversation
from ..models.segment import Segment
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.speaker import Speaker
from ..models.excerpt import Excerpt
from ..models.participant import Participant
from ..services.code_analysis import get_code_frequencies, get_code_cooccurrence
from ..services.coding_layers import (
    CONSENSUS_ORIGIN,
    code_usage_count_expr,
    non_consensus_filter,
    visible_target_filter,
)
from ..auth import get_current_user
from ..schemas.common import utc_wire
from .helpers import _get_project_or_404, parse_int_list, sanitize_content_disposition
from .export_helpers import (
    EXPORT_VALUE_PRECISION,
    _build_category_tree_and_chains,
    build_code_conversation_matrix,
    build_code_cooccurrence_matrix,
    csv_safe,
)

router = APIRouter(prefix="/api/projects/{project_id}/export", tags=["export"])


@router.get("/csv")
async def export_study_csv(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Export project data as CSV with 1/0 for codes."""
    project = _get_project_or_404(db, project_id, user.id)

    output = io.StringIO()
    writer = csv.writer(output)

    # Get all codes
    codes = db.query(Code).filter(
        Code.project_id == project_id,
        Code.is_active == True
    ).order_by(Code.numeric_id).all()

    # Headers
    headers = [
        "conversation_name", "segment_id", "sequence_order", "speaker",
        "is_facilitator", "start_time", "end_time", "text"
    ]
    headers.extend([f"code_{c.numeric_id}" for c in codes])
    writer.writerow(headers)

    # Get all conversations and segments (bulk-load to avoid N+1)
    conversations = db.query(Conversation).filter(
        Conversation.project_id == project_id
    ).order_by(Conversation.created_at).all()

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

    for conversation in conversations:
        segments = segments_by_conv.get(conversation.id, [])

        for segment in segments:
            # J2-B: human layer only. Consensus is a derived duplicate of codes
            # the coders already agreed on, so today it cannot flip a 1/0 cell —
            # but the filter keeps that true if the indicator ever becomes a
            # count or per-coder breakdown (#490 latent site).
            applied_code_ids = set(
                ca.code_id for ca in segment.code_applications
                if ca.origin != CONSENSUS_ORIGIN
            )

            speaker_name = segment.speaker.name if segment.speaker else ""
            is_facilitator = 1 if segment.speaker and segment.speaker.is_facilitator else 0

            row = [
                csv_safe(conversation.name),
                segment.id,
                segment.sequence_order,
                csv_safe(speaker_name),
                is_facilitator,
                segment.start_time if segment.start_time is not None else "",
                segment.end_time if segment.end_time is not None else "",
                csv_safe(segment.text),
            ]

            # Add code columns (1/0)
            row.extend([1 if code.id in applied_code_ids else 0 for code in codes])
            writer.writerow(row)

    output.seek(0)
    filename = f"{sanitize_content_disposition(project.name)}_export_{datetime.now().strftime('%Y%m%d')}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.get("/codebook")
async def export_codebook(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Export just the codebook as JSON."""
    project = _get_project_or_404(db, project_id, user.id)

    codes = db.query(Code).filter(
        Code.project_id == project_id
    ).order_by(Code.numeric_id).all()

    # Build category data
    parent_chain_map, category_tree, _ = _build_category_tree_and_chains(db, project_id)

    codebook = {
        "project_name": project.name,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "categories": category_tree,
        "codes": []
    }

    # Batch usage counts (avoid N+1). Track J · J2: distinct targets, not raw
    # rows, excluding the consensus layer (single-sourced with the codes list).
    code_ids = [c.id for c in codes]
    usage_counts = {}
    if code_ids:
        usage_rows = db.query(
            CodeApplication.code_id, code_usage_count_expr()
        ).outerjoin(
            Segment, CodeApplication.segment_id == Segment.id
        ).filter(
            CodeApplication.code_id.in_(code_ids),
            non_consensus_filter(),
            visible_target_filter(),  # #500
        ).group_by(CodeApplication.code_id).all()
        usage_counts = dict(usage_rows)

    for code in codes:
        entry = {
            "numeric_id": code.numeric_id,
            "name": code.name,
            "description": code.description,
            "is_universal": code.is_universal,
            "is_active": code.is_active,
            "usage_count": usage_counts.get(code.id, 0),
            "created_at": utc_wire(code.created_at),
            "category_id": code.category_id,
            "category_name": code.category.name if code.category else None,
            "category_path": parent_chain_map.get(code.category_id, []) if code.category_id else [],
        }
        codebook["codes"].append(entry)

    return codebook




@router.get("/code-frequencies")
async def export_code_frequencies_csv(
    project_id: int,
    code_ids: str | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: str | None = None,
    participant_ids: str | None = None,
    # #499: the screen endpoint takes source/document_ids/coder_ids/layer_scope
    # (J2-5), so its "Export CSV" must accept and honor the SAME scope — the
    # old signature silently exported all-coder conversation numbers under an
    # active filter. Bare defaults (not Query(...)) so direct-call tests get
    # real None; appended after the existing params (positional stability).
    source: str = "conversations",
    document_ids: str | None = None,
    coder_ids: str | None = None,
    layer_scope: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export code frequency table as CSV."""
    project = _get_project_or_404(db, project_id, user.id)

    parsed_coder_ids = parse_int_list(coder_ids)
    result = get_code_frequencies(
        db, project_id,
        code_ids=parse_int_list(code_ids),
        exclude_facilitator=exclude_facilitator,
        conversation_ids=parse_int_list(conversation_ids),
        participant_ids=parse_int_list(participant_ids),
        source=source,
        document_ids=parse_int_list(document_ids),
        coder_ids=parsed_coder_ids,
        layer_scope=layer_scope,
    )

    output = io.StringIO()
    writer = csv.writer(output)
    # Scope claim: when a coder/layer filter narrows the numbers, say so in
    # the file itself — otherwise the CSV reads as project-wide.
    if parsed_coder_ids or layer_scope == "consensus":
        scope_bits = []
        if layer_scope == "consensus":
            scope_bits.append("consensus layer")
        if parsed_coder_ids:
            names = dict(
                db.query(User.id, User.username)
                .filter(User.id.in_(parsed_coder_ids))
                .all()
            )
            scope_bits.append(
                "coders: " + ", ".join(
                    names.get(cid, str(cid)) for cid in parsed_coder_ids
                )
            )
        writer.writerow([csv_safe(f"Scope: {'; '.join(scope_bits)}")])
    writer.writerow([
        "Code", "Category", "Segments", "% of Coded Segments",
        "Conversations", "% of Conversations", "Participants", "% of Participants",
    ])
    for f in result["frequencies"]:
        writer.writerow([
            csv_safe(f["code_name"]),
            csv_safe(f["category_name"] or ""),
            f["segment_count"],
            f"{f['segment_percentage']:.1f}%",
            f["conversation_count"],
            f"{f['conversation_percentage']:.1f}%",
            f["participant_count"],
            f"{f['participant_percentage']:.1f}%",
        ])

    output.seek(0)
    filename = f"{sanitize_content_disposition(project.name)}_code_frequencies_{datetime.now().strftime('%Y%m%d')}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/coded-segments")
async def export_coded_segments_csv(
    project_id: int,
    code_ids: str | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: str | None = None,
    participant_ids: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export all coded segment data as CSV (one row per code application)."""
    from sqlalchemy.orm import joinedload

    project = _get_project_or_404(db, project_id, user.id)

    # Build query for code applications with all needed joins
    query = (
        db.query(CodeApplication)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(Code, CodeApplication.code_id == Code.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .options(
            joinedload(CodeApplication.segment).joinedload(Segment.conversation),
            joinedload(CodeApplication.segment).joinedload(Segment.speaker),
            joinedload(CodeApplication.code).joinedload(Code.category),
        )
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Code.is_active == True,
            # J2-B (#490): human layer only — consensus rows are derived
            # duplicates of the coders' agreed codes and exported rows must be
            # attributable to a real coder.
            non_consensus_filter(),
        )
    )

    if exclude_facilitator:
        query = query.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    parsed_conv_ids = parse_int_list(conversation_ids)
    if parsed_conv_ids:
        query = query.filter(Segment.conversation_id.in_(parsed_conv_ids))
    parsed_code_ids = parse_int_list(code_ids)
    if parsed_code_ids:
        query = query.filter(CodeApplication.code_id.in_(parsed_code_ids))
    parsed_part_ids = parse_int_list(participant_ids)
    if parsed_part_ids:
        query = query.filter(Speaker.participant_id.in_(parsed_part_ids))

    query = query.order_by(Code.name, Conversation.name, Segment.sequence_order)
    apps = query.all()

    # Batch-load quoted status (whole-segment excerpts) for segments
    seg_ids = set(a.segment_id for a in apps)
    csv_quoted_seg_ids: set[int] = set()
    if seg_ids:
        csv_quoted_seg_ids = set(
            eid for (eid,) in db.query(Excerpt.segment_id).filter(
                Excerpt.segment_id.in_(seg_ids),
                Excerpt.start_offset.is_(None),
            ).all()
        )

    # Batch-load other codes per segment for "Other Codes" column — distinct
    # names, human layer only (#490: the unfiltered application-grain list
    # repeated a name once per coder and could include consensus rows).
    other_codes_map: dict[int, list[str]] = defaultdict(list)
    if seg_ids:
        other_apps = (
            db.query(CodeApplication.segment_id, Code.name)
            .join(Code, CodeApplication.code_id == Code.id)
            .filter(
                CodeApplication.segment_id.in_(seg_ids),
                Code.is_active == True,
                non_consensus_filter(),
            )
            .distinct()
            .all()
        )
        for sid, cname in other_apps:
            other_codes_map[sid].append(cname)

    # Batch-load coder usernames for the "Coder" column (#490: one row per
    # application is only a usable grain when the row says WHOSE application).
    coder_names: dict[int, str] = {}
    app_user_ids = set(a.user_id for a in apps if a.user_id is not None)
    if app_user_ids:
        coder_names = dict(
            db.query(User.id, User.username).filter(User.id.in_(app_user_ids)).all()
        )

    # Batch participant lookup via speaker
    from ..models.participant import Participant
    speaker_ids = set(a.segment.speaker_id for a in apps if a.segment and a.segment.speaker_id)
    speaker_participants = {}
    if speaker_ids:
        sp_rows = (
            db.query(Speaker.id, Participant.display_name, Participant.identifier, Participant.role)
            .outerjoin(Participant, Speaker.participant_id == Participant.id)
            .filter(Speaker.id.in_(speaker_ids))
            .all()
        )
        speaker_participants = {
            sid: (dname or ident, role)
            for sid, dname, ident, role in sp_rows
        }

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Code", "Category", "Coder", "Conversation", "Speaker", "Participant",
        "Participant Role", "Segment Text", "Other Codes", "Is Quoted", "Timestamp",
    ])

    for app in apps:
        seg = app.segment
        code = app.code
        speaker = seg.speaker if seg else None
        speaker_name = speaker.name if speaker else ""
        p_name, p_role = "", ""
        if speaker and speaker.id in speaker_participants:
            p_name, p_role = speaker_participants[speaker.id]
            p_name = p_name or ""
            p_role = p_role or ""

        other = [c for c in other_codes_map.get(seg.id, []) if c != code.name]

        writer.writerow([
            csv_safe(code.name),
            csv_safe(code.category.name if code.category else ""),
            csv_safe(coder_names.get(app.user_id, "")),
            csv_safe(seg.conversation.name if seg.conversation else ""),
            csv_safe(speaker_name),
            csv_safe(p_name),
            csv_safe(p_role),
            csv_safe(seg.text if seg else ""),
            csv_safe("; ".join(other)),
            "Yes" if seg and seg.id in csv_quoted_seg_ids else "",
            f"{seg.start_time:.2f}" if seg and seg.start_time is not None else "",
        ])

    output.seek(0)
    filename = f"{sanitize_content_disposition(project.name)}_coded_segments_{datetime.now().strftime('%Y%m%d')}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/code-cooccurrence")
async def export_code_cooccurrence_csv(
    project_id: int,
    code_ids: str | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: str | None = None,
    participant_ids: str | None = None,
    # #512 (the #499 sibling this fix missed): the on-screen matrix takes
    # source/document_ids/coder_ids/layer_scope, so its "Export CSV" must
    # accept and honor the SAME scope — the old signature silently exported
    # an all-coder conv+doc matrix under blind mode, a coder filter, the
    # consensus layer, or a text-source selection. Bare defaults (not
    # Query(...)) so direct-call tests get real None; appended after the
    # existing params (positional stability).
    source: str = "conversations",
    document_ids: str | None = None,
    coder_ids: str | None = None,
    layer_scope: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export code co-occurrence matrix as CSV."""
    project = _get_project_or_404(db, project_id, user.id)

    parsed_coder_ids = parse_int_list(coder_ids)
    result = get_code_cooccurrence(
        db, project_id,
        code_ids=parse_int_list(code_ids),
        exclude_facilitator=exclude_facilitator,
        conversation_ids=parse_int_list(conversation_ids),
        participant_ids=parse_int_list(participant_ids),
        source=source,
        document_ids=parse_int_list(document_ids),
        coder_ids=parsed_coder_ids,
        layer_scope=layer_scope,
    )

    output = io.StringIO()
    writer = csv.writer(output)

    # Scope claim: when a coder/layer filter narrows the numbers, say so in
    # the file itself — otherwise the CSV reads as project-wide (#499/#512).
    if parsed_coder_ids or layer_scope == "consensus":
        scope_bits = []
        if layer_scope == "consensus":
            scope_bits.append("consensus layer")
        if parsed_coder_ids:
            names = dict(
                db.query(User.id, User.username)
                .filter(User.id.in_(parsed_coder_ids))
                .all()
            )
            scope_bits.append(
                "coders: " + ", ".join(
                    names.get(cid, str(cid)) for cid in parsed_coder_ids
                )
            )
        writer.writerow([csv_safe(f"Scope: {'; '.join(scope_bits)}")])

    # Header row: empty cell + code names
    header = [""] + [csv_safe(c["name"]) for c in result["codes"]]
    writer.writerow(header)

    # Data rows
    for i, code_info in enumerate(result["codes"]):
        row = [csv_safe(code_info["name"])] + [str(v) for v in result["matrix"][i]]
        writer.writerow(row)

    output.seek(0)
    filename = f"{sanitize_content_disposition(project.name)}_code_cooccurrence_{datetime.now().strftime('%Y%m%d')}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Include sub-routers (Excel + R exports) ─────────────────────────────────
from .export_excel import router as excel_router
from .export_r import router as r_router

router.include_router(excel_router)
router.include_router(r_router)
