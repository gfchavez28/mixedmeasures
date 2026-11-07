from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy import func, or_
import io
import csv
from datetime import datetime, timezone
from collections import defaultdict

from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.observation import Observation
from ..models.segment import Segment
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.speaker import Speaker
from ..models.excerpt import Excerpt, segment_has_any_quote_filter
from ..models.participant import Participant
from ..services.code_analysis import (
    COOCCURRENCE_RULE, COOCCURRENCE_SOURCE_LEVEL_NOTE, get_code_cooccurrence,
)
from ..services.magnitude import read_scale as _read_magnitude_scale
from ..services.participant_filter import segment_passage_clause
from ..services.coding_layers import (
    CONSENSUS_ORIGIN,
    code_usage_count_expr,
    in_coder_scope,
    narrow_to_coders,
    non_consensus_filter,
    project_scoped_segments,
    visible_target_filter,
)
from ..auth import get_current_user
from ..schemas.common import utc_wire
from .helpers import (
    _get_project_or_404, coder_scope_filename_suffix, parse_int_list, parse_source_ids,
    sanitize_content_disposition,
)
from .export_helpers import (
    EXPORT_VALUE_PRECISION,
    _build_category_tree_and_chains,
    build_code_cooccurrence_matrix,
    csv_safe,
    file_scope_line,
    segment_source_pair,
)

router = APIRouter(prefix="/api/projects/{project_id}/export", tags=["export"])


@router.get("/csv")
async def export_study_csv(
    project_id: int,
    # #1530 D98 (1.5.9) — bare default (direct-call tests get real None). The
    # Export dialog sends the effective scope while blind; absent = every coder.
    coder_ids: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Export project data as a WIDE segment × code CSV — one row per segment,
    one 1/0 column per code.

    **This is not a duplicate of `/coded-segments`, and must not be retired in
    favour of it (#650).** The two are different shapes and neither derives from
    the other:

    * here — one row per SEGMENT, INCLUDING segments nobody coded, which emit a
      row of zeros. That is a case-by-variable matrix: each segment a case, each
      code a binary variable, loadable straight into SPSS/R/jamovi. **The zero
      rows are the denominator** — they are what makes "18% of segments were
      coded X" computable.
    * `/coded-segments` — one row per CODE APPLICATION. Its query root is
      `CodeApplication`, so an uncoded segment has no row to produce and the
      denominator is simply absent from the file.

    #650: three-parent scope. It filtered `Segment.conversation_id.in_(...)`
    until 2026-08-02, so document segments (silently, since documents shipped)
    and observation clips were missing from a file that showed no sign of being
    partial — the last member of the #616/#620/#629 family. The single
    `conversation_name` column is now the honest `source_type` + `source_name`
    pair, matching every other export.

    #1530 D95/D97 (1.5.9): with ``coder_ids`` a 1 is that coder's coding only —
    the workbench's chips, not every coder's union — and the file's NAME says
    whose (`coder_scope_filename_suffix`). Every segment keeps its row: the zero
    rows are still the denominator. No preamble line, because this file must load
    straight into SPSS/R/jamovi.
    """
    project = _get_project_or_404(db, project_id, user.id)
    scope = parse_int_list(coder_ids)

    output = io.StringIO()
    writer = csv.writer(output)

    # Get all codes
    codes = db.query(Code).filter(
        Code.project_id == project_id,
        Code.is_active == True
    ).order_by(Code.numeric_id).all()

    # Headers. Deliberately snake_case, unlike the Title Case of
    # /coded-segments: this file's OTHER column names are unchanged, so a script
    # reading `segment_id`, `text` or `code_3` keeps working and only the source
    # column moves. Unifying the casing would break every reference instead of
    # one.
    headers = [
        "source_type", "source_name", "segment_id", "sequence_order", "speaker",
        "is_facilitator", "start_time", "end_time", "text"
    ]
    headers.extend([f"code_{c.numeric_id}" for c in codes])
    writer.writerow(headers)

    # Every visible segment in the project, whatever its parent —
    # `project_scoped_segments` is the ONE three-parent scope (#616/#620/#629),
    # never a hand-rolled `or_`. Ordering mirrors the Excel Coded Data sheet so
    # the two renderings of this same matrix list rows identically.
    all_segments = project_scoped_segments(
        db.query(Segment).options(
            selectinload(Segment.code_applications),
            joinedload(Segment.speaker),
            joinedload(Segment.conversation),
            joinedload(Segment.document),
            joinedload(Segment.observation),
        ),
        project_id,
    ).filter(
        Segment.merged_into_id == None,
        Segment.split_into_id == None,
    ).order_by(
        func.coalesce(Conversation.name, Document.name, Observation.name),
        Segment.sequence_order,
    ).all()

    for segment in all_segments:
        # J2-B: human layer only. Consensus is a derived duplicate of codes
        # the coders already agreed on, so today it cannot flip a 1/0 cell —
        # but the filter keeps that true if the indicator ever becomes a
        # count or per-coder breakdown (#490 latent site).
        applied_code_ids = set(
            ca.code_id for ca in segment.code_applications
            if ca.origin != CONSENSUS_ORIGIN and in_coder_scope(ca.user_id, scope)
        )

        source_kind, source_name = segment_source_pair(segment)

        # Speaker and facilitator are conversation-only concepts. They go BLANK
        # on a speaker-less row rather than 0 — a document paragraph is not "a
        # non-facilitator", it is a unit the question does not apply to, and a 0
        # there would be counted as a real observation by any consumer that
        # tabulates the column.
        speaker_name = ""
        is_facilitator = ""
        if segment.speaker:
            speaker_name = segment.speaker.name
            is_facilitator = 1 if segment.speaker.is_facilitator else 0

        row = [
            source_kind,
            csv_safe(source_name),
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
    filename = (
        f"{sanitize_content_disposition(project.name)}_export_{datetime.now().strftime('%Y%m%d')}"
        f"{coder_scope_filename_suffix(db, scope)}.csv"
    )

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
            # #869 (d): the declared rating instrument travels with the code.
            "magnitude_scale": _read_magnitude_scale(code),
        }
        codebook["codes"].append(entry)

    return codebook




# #1528 D87 (1.5.9): there is no `GET /code-frequencies`. The Frequencies CSV is the Descriptives
# summary table's rows, written in the browser from `POST …/code-analysis/source-frequencies`
# (`frontend/src/components/qualitative-analysis/qual-summary-columns.ts::codeSummaryCsv`). This
# file read `get_code_frequencies` — the payload #749 moved the table off — so it wrote zeros
# from the Text source and counted outside the selection; it was deleted, not mended (#833).


@router.get("/coded-segments")
async def export_coded_segments_csv(
    project_id: int,
    code_ids: str | None = None,
    exclude_facilitator: bool = False,
    conversation_ids: str | None = None,
    participant_ids: str | None = None,
    # #1530 D98 (1.5.9) — appended, bare default. The analysis page's Segments
    # CSV sends its effective coder scope; the Export dialog sends it while blind.
    coder_ids: str | None = None,
    # #1535 D111 (1.5.9) — appended, bare default: the page's document and clip
    # selection. Each source list is read by `parse_source_ids` (absent = every
    # source of the kind, a present "" = none of it).
    document_ids: str | None = None,
    observation_ids: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export all coded segment data as CSV (one row per code application).

    🔴 **#1535 (1.5.9) — the analysis page's *Exports › Segments CSV* is the passages the
    page selected.** The page used to hand this route the `filterParams` it builds for
    `/frequencies`, whose "nothing of a kind selected = every source of it" is that
    endpoint's reading (#749), and the route had no document or clip parameter at all: one
    selected document or clip exported every coded passage in the project, an interview
    beside a document dropped the document, and a participant filter dropped every
    document passage and clip. Now (D111–D115, the git-ignored
    the internal design notes):

    - **Sources (D111):** ``conversation_ids`` / ``document_ids`` / ``observation_ids``,
      each through `parse_source_ids`. With none sent, every passage (the Export dialog's
      file, unchanged); with any sent, each kind says for itself — absent = every source
      of it, ``""`` = none. ``conversation_ids`` alone no longer means "turns only".
    - **Codes (D112):** ``code_ids``, as before; the page now sends its selection.
    - **Participants (D113):** as the screens apply the filter — an interview turn is
      kept when its speaker is one of them; a document passage and a clip are always kept
      (`get_source_frequencies` narrows only its turn arms). `test_coded_segments_selection_1535.py`
      holds the file equal to the summary table, so the day the screens' rule changes the
      test fails until this follows.
    - **Name (D115):** ``_selection`` before the extension (and before ``_coder-<name>``)
      whenever a parameter makes the file less than every coded passage: a source list,
      ``code_ids``, ``participant_ids`` or ``exclude_facilitator=true``.
    - Survey answers are never in this file (D114, the page's door says so): it is the
      coding import's segments-arm input, keyed by *Unit ID* (`coding-import.md` §2).

    #616: three-parent scope — documents' codings had been silently absent since
    documents shipped (and clips would have been too) because the query
    inner-joined Conversation. The rows now carry an honest Source Type + Source
    pair; the Speaker/Participant columns degrade to blank for speaker-less
    parents, and ``exclude_facilitator`` no-ops there (its filter keeps
    speaker-less rows by construction).

    🔴 **Interviewer turns are IN by default (#1075).** The default was True, and
    the Export dialog passes no parameters, so every coding on a facilitator turn
    was missing from the file — while the file's own promise (the coding import's
    *"that export imports as it is"*, row 49) and the wide `/csv` it pairs with
    (#650: *"same data, the other shape"*) both include them. A coding the
    researcher made is data, whoever spoke the turn; which turns were the
    interviewer's is now a COLUMN (`Is Facilitator`, appended), so an analysis
    that leaves them out can do so in the file. The parameter stays, as a filter.

    #1530 D95/D97 (1.5.9): with ``coder_ids`` the rows are those coders'
    applications and *Other Codes* names only their codes on the unit — a blind
    coder's own row listed a colleague's code there. The file says whose by its
    *Coder* column and its NAME, never a preamble line: the coding import reads
    line 1 as the header (`services/coding_import.py`), and this file is its
    input (row 49).
    """
    from sqlalchemy.orm import joinedload

    project = _get_project_or_404(db, project_id, user.id)
    scope = parse_int_list(coder_ids)

    # Build query for code applications across ALL THREE segment parents
    # (project_scoped_segments — never a hand-rolled third or_, #616).
    query = project_scoped_segments(
        db.query(CodeApplication)
        .join(Segment, CodeApplication.segment_id == Segment.id),
        project_id,
    )
    query = (
        query
        .join(Code, CodeApplication.code_id == Code.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .options(
            joinedload(CodeApplication.segment).joinedload(Segment.conversation),
            joinedload(CodeApplication.segment).joinedload(Segment.document),
            joinedload(CodeApplication.segment).joinedload(Segment.observation),
            joinedload(CodeApplication.segment).joinedload(Segment.speaker),
            joinedload(CodeApplication.code).joinedload(Code.category),
        )
        .filter(
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Code.is_active == True,
            # J2-B (#490): human layer only — consensus rows are derived
            # duplicates of the coders' agreed codes and exported rows must be
            # attributable to a real coder.
            non_consensus_filter(),
        )
    )
    query = narrow_to_coders(query, scope)

    if exclude_facilitator:
        # Keeps speaker-less rows (documents/clips) by construction — the
        # facilitator concept only exists on conversation segments.
        query = query.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    # #1535 D111 — the sources, by #1297's rule (`parse_source_ids`). Nothing sent: no
    # clause, so the Export dialog's query is the one it always was.
    source_kinds = (
        (Segment.conversation_id, parse_source_ids(conversation_ids)),
        (Segment.document_id, parse_source_ids(document_ids)),
        (Segment.observation_id, parse_source_ids(observation_ids)),
    )
    source_selected = any(ids is not None for _, ids in source_kinds)
    if source_selected:
        # Absent = every source of the kind; a present "" parses to [] and `.in_([])` is
        # SQLAlchemy's always-false empty IN — none of it.
        query = query.filter(or_(*(
            parent.isnot(None) if ids is None else parent.in_(ids)
            for parent, ids in source_kinds
        )))
    parsed_code_ids = parse_int_list(code_ids)
    if parsed_code_ids:
        query = query.filter(CodeApplication.code_id.in_(parsed_code_ids))
    parsed_part_ids = parse_int_list(participant_ids)
    if parsed_part_ids:
        # #1535 D113 — the screens' reading, which since #1536 (D116/D117) is ONE rule
        # (`services/participant_filter.py`): a turn by its speaker's participant, a document
        # passage by the participant the document is linked to, a clip never. Held equal to the
        # screens by `test_participant_filter_1536.py` and `test_coded_segments_selection_1535.py`.
        # `project_scoped_segments` (above) already outer-joins Document; Speaker is joined here.
        query = query.filter(segment_passage_clause(parsed_part_ids))
    # #1535 D115 — decided from the route's own parameters, so no client can forget it.
    narrowed = bool(source_selected or parsed_code_ids or parsed_part_ids or exclude_facilitator)

    query = query.order_by(
        Code.name,
        func.coalesce(Conversation.name, Document.name, Observation.name),
        Segment.sequence_order,
    )
    apps = query.all()

    # Batch-load quoted status (whole-segment excerpts) for segments
    seg_ids = set(a.segment_id for a in apps)
    csv_quoted_seg_ids: set[int] = set()
    if seg_ids:
        csv_quoted_seg_ids = set(
            eid for (eid,) in db.query(Excerpt.segment_id).filter(
                Excerpt.segment_id.in_(seg_ids),
                segment_has_any_quote_filter(),
            ).all()
        )

    # Batch-load other codes per segment for "Other Codes" column — distinct
    # names, human layer only (#490: the unfiltered application-grain list
    # repeated a name once per coder and could include consensus rows).
    other_codes_map: dict[int, list[str]] = defaultdict(list)
    if seg_ids:
        other_apps = narrow_to_coders(
            db.query(CodeApplication.segment_id, Code.name)
            .join(Code, CodeApplication.code_id == Code.id)
            .filter(
                CodeApplication.segment_id.in_(seg_ids),
                Code.is_active == True,
                non_consensus_filter(),
            ),
            scope,
        ).distinct().all()
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
    # #616: "Conversation" became the honest Source Type + Source pair — the
    # export now spans documents and observation clips, so the source column
    # must say WHAT it names. Conversation rows keep every value they had
    # (the old Conversation cell's value now lives in Source).
    # #623: "End Timestamp" joins the start one so a timed unit carries its
    # DURATION. Without it an observation clip exports a start and nothing else,
    # so rate/airtime/bout analyses can't be reconstructed outside the tool —
    # which matters while the timed-analytics surfaces are still being built.
    # Conversation/document rows leave it blank exactly as they do the start.
    # #35 — the RATING rides this export because this is the one coded-data
    # export at the application grain, which is the grain a rating lives at.
    # Three columns, APPENDED so every existing column keeps its position:
    # the value (integer-aware, so 7 not 7.0; blank when unrated OR when the
    # code declares no scale — a number with no instrument is not a rating),
    # the declared scale it was given on, and the anchor label for that value
    # if the scale names one. The merge-conflict flag is deliberately NOT
    # exported: it is workflow state awaiting adjudication, not data.
    from ..services.magnitude import _fmt as fmt_rating, read_scale

    scale_cache: dict[int, dict | None] = {}

    def _scale_for(code_obj):
        if code_obj.id not in scale_cache:
            scale_cache[code_obj.id] = read_scale(code_obj)
        return scale_cache[code_obj.id]

    # Queue row 49 — `Unit ID` is APPENDED (every existing column keeps its
    # position, #35's rule) and it is what makes this export an INPUT rather than
    # only a report.
    #
    # 🔴 Until it existed this file carried NO unit identifier of any kind, so a
    # researcher could not produce a file the bulk coding import's segment arm
    # would read: the import's whole `target_kind='segments'` path had no
    # producer. `Segment.uuid` rather than the primary key, because the uuid is
    # the J3-2 spine and is stable across `.mmproject` copies — a `.mmproject`
    # round trip renumbers ids, so a file keyed on one would silently address
    # other segments after a colleague's project came back.
    #
    # #1075 — `Is Facilitator` is APPENDED after it, for the same reason: now that
    # interviewer turns are in the file by default, the file must say which rows
    # they are. Its vocabulary is the Excel Coded Data sheet's (`export_excel.py`):
    # "Yes"/"No" on a turn with a speaker, BLANK where the question does not apply
    # (a document paragraph, a clip, a turn with no speaker) — a "No" there would
    # be counted as an observation by anything that tabulates the column.
    writer.writerow([
        "Code", "Category", "Coder", "Source Type", "Source", "Speaker", "Participant",
        "Participant Role", "Segment Text", "Other Codes", "Is Quoted", "Timestamp",
        "End Timestamp", "Rating", "Rating Scale", "Rating Anchor", "Unit ID",
        "Is Facilitator",
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

        source_kind, source_name = segment_source_pair(seg)

        other = [c for c in other_codes_map.get(seg.id, []) if c != code.name]

        scale = _scale_for(code)
        # `is not None`, never truthiness: a rating of 0 is a rating (#35 §2).
        rated = scale is not None and app.magnitude is not None
        rating_cell = fmt_rating(app.magnitude) if rated else ""
        scale_cell = f"{fmt_rating(scale['min'])} to {fmt_rating(scale['max'])}" if scale else ""
        anchor_cell = ""
        if rated:
            anchor = next((a for a in scale["anchors"] if a["value"] == app.magnitude), None)
            anchor_cell = anchor["label"] if anchor else ""

        writer.writerow([
            csv_safe(code.name),
            csv_safe(code.category.name if code.category else ""),
            csv_safe(coder_names.get(app.user_id, "")),
            source_kind,
            csv_safe(source_name),
            csv_safe(speaker_name),
            csv_safe(p_name),
            csv_safe(p_role),
            csv_safe(seg.text if seg else ""),
            csv_safe("; ".join(other)),
            "Yes" if seg and seg.id in csv_quoted_seg_ids else "",
            f"{seg.start_time:.2f}" if seg and seg.start_time is not None else "",
            f"{seg.end_time:.2f}" if seg and seg.end_time is not None else "",
            rating_cell,
            scale_cell,
            csv_safe(anchor_cell),
            # Not routed through `csv_safe`: a uuid is hex and hyphens, so it can
            # carry no formula prefix — but it is machine-generated rather than
            # user text, which is the property that makes that true. A
            # user-derived column added here WOULD need it.
            seg.uuid if seg else "",
            ("Yes" if speaker.is_facilitator else "No") if speaker else "",
        ])

    output.seek(0)
    filename = (
        f"{sanitize_content_disposition(project.name)}_coded_segments_{datetime.now().strftime('%Y%m%d')}"
        f"{'_selection' if narrowed else ''}{coder_scope_filename_suffix(db, scope)}.csv"
    )

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/code-cooccurrence")
def export_code_cooccurrence_csv(  # def, not async: #1527 D89 — test_endpoint_event_loop.py::MUST_BE_SYNC
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
    # Appended LAST (bare-default convention) — 4c: observation scoping.
    observation_ids: str | None = None,
    # #1527 D86 — the matrix the screen shows: its LEVEL and its question selection.
    # Until 1.5.9 this file was always the unit-level matrix over every question.
    level: str = "segment",
    text_column_ids: str | None = None,
    # #1545 (1.6.0): the panel's description of the chosen filter values, for the scope line —
    # the server cannot derive it from `participant_ids` (D124). Appended LAST (bare default).
    participant_filter_label: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export code co-occurrence matrix as CSV."""
    project = _get_project_or_404(db, project_id, user.id)
    if level not in ("segment", "source"):
        raise HTTPException(status_code=400, detail="level must be 'segment' or 'source'")

    parsed_coder_ids = parse_int_list(coder_ids)
    parsed_participant_ids = parse_int_list(participant_ids)
    # The screen's own dispatch and source reading (#1527 D84, D86): one function, so
    # the file and the figure cannot count differently.
    result = get_code_cooccurrence(
        db, project_id,
        code_ids=parse_int_list(code_ids),
        exclude_facilitator=exclude_facilitator,
        conversation_ids=parse_source_ids(conversation_ids),
        participant_ids=parsed_participant_ids,
        source=source,
        document_ids=parse_source_ids(document_ids),
        coder_ids=parsed_coder_ids,
        layer_scope=layer_scope,
        observation_ids=parse_source_ids(observation_ids),
        text_column_ids=parse_source_ids(text_column_ids),
        level=level,
    )

    output = io.StringIO()
    writer = csv.writer(output)

    # The file's first line says the rule its pairs were counted by (#1335, D47
    # — every file, scoped or not), and, when a coder/layer or participant filter
    # narrows the numbers, the scope too — otherwise the CSV reads as project-wide
    # (#499/#512; the participant filter #1545). One builder for every such file.
    scope = file_scope_line(
        db, coder_ids=parsed_coder_ids, layer_scope=layer_scope,
        participant_ids=parsed_participant_ids,
        participant_filter_label=participant_filter_label,
    )
    # #1527 D86: at the source level every cell is a number of SOURCES, and a file has no
    # caption to say so — the screen's caption does.
    rule = (
        f"{COOCCURRENCE_SOURCE_LEVEL_NOTE} {COOCCURRENCE_RULE}" if level == "source"
        else COOCCURRENCE_RULE
    )
    first_line = f"{scope} {rule}" if scope else rule
    writer.writerow([csv_safe(first_line)])

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
