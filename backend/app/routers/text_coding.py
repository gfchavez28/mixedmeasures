"""Router for text coding — coding open-ended text responses."""

import hashlib
import json
import io
import csv
from datetime import datetime, timezone
from collections import defaultdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, case

from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.note import Note
from ..services.note_numbering import next_note_sequence
from ..models.text_coding_config import TextCodingConfig, is_empty_text, parse_treat_as_empty
from ..models.excerpt import Excerpt
from ..models.speaker import Speaker
from ..models.conversation import Conversation
from ..models.participant import Participant
from ..auth import get_current_user
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale
from ..services.coding_layers import non_consensus_filter
from ..services.text_analysis import substantive_text_clause
from .helpers import _get_project_or_404, parse_int_list, sanitize_csv_filename, TEXT_TYPES
from .export_helpers import csv_safe
from ..schemas.text_coding import (
    TextCodeRequest, BulkCodeRequest, BulkRemoveCodeRequest,
    TextNoteCreate, TextNoteUpdate,
    TextCodingConfigUpdate,
    TextsListResponse, TextResponse, RecordsListResponse, RecordResponse,
    RecordContextResponse, LinkedConversationResponse, ColumnValueResponse,
    NonTextValueResponse, TextValueResponse, ColumnPositionResponse,
    TextColumnsListResponse, TextColumnResponse,
    CodingProgressResponse, ColumnProgressResponse, CodingProgressByCoderItem,
    TextCodingConfigResponse,
    TextCodeResponse, BulkCodeResponse, BulkRemoveCodeResponse,
)
from ..schemas.common import AppliedCodeDetail
from ..schemas.note import NoteResponse

router = APIRouter(
    prefix="/api/projects/{project_id}/text-coding",
    tags=["text-coding"],
)



def _get_text_value_or_404(
    db: Session, project_id: int, dataset_value_id: int, user_id: int
) -> DatasetValue:
    """Load a text-column DatasetValue, folding the ownership gate in (REQUIRED ``user_id``).

    🔴 **This helper is a `GATE_TOKENS` entry and until #845 it did not gate (2026-08-30).**
    It took no ``user_id`` and never reached ``_get_project_or_404`` — it answered only the
    CHILD-ENTITY half (*"does this DatasetValue belong to this project, on a text
    column?"*). Mutation-confirmed at filing: deleting the real gate from ``apply_code``
    left both designated guards green (`test_ownership_gate_sweep.py` 6 passed,
    `test_multiuser_ownership_gate.py` 15 passed), because the AST scan sees a token name
    and is satisfied. Nothing was exploitable — all 16 endpoints in this router gate
    directly — but the next endpoint written here would have passed the fail-closed scan
    while gating nothing.

    ⚠️ **Do not add a default or a user-less overload.** The signature is what stops a new
    endpoint from forgetting, exactly as for ``_get_dataset_or_404`` /
    ``_get_column_or_404`` / ``_get_document_or_404`` / ``_get_observation_or_404``.
    ``tests/test_ownership_gate_sweep.py`` now derives that requirement from ``GATE_TOKENS``
    itself rather than from a hand-written list of three, so a future token cannot lie the
    way this one did.

    ⚠️ The callers' own ``_get_project_or_404`` calls are deliberately KEPT. They are a
    cheap indexed PK lookup, and they preserve the error ORDER a researcher sees: an
    unknown project 404s before this helper's 400 can claim the value "is not a text
    column in this project".
    """
    _get_project_or_404(db, project_id, user_id)
    dv = (
        db.query(DatasetValue)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetValue.id == dataset_value_id,
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .first()
    )
    if not dv:
        raise HTTPException(
            status_code=400,
            detail=f"DatasetValue {dataset_value_id} not found or not a text column in this project"
        )
    return dv


def _get_config(db: Session, project_id: int) -> TextCodingConfig:
    """Get or create TextCodingConfig for project."""
    config = db.query(TextCodingConfig).filter(
        TextCodingConfig.project_id == project_id
    ).first()
    if not config:
        config = TextCodingConfig(project_id=project_id)
        db.add(config)
        db.flush()
    return config


def _get_treat_as_empty(config: TextCodingConfig) -> list[str]:
    """Get treat_as_empty list from config or defaults."""
    return parse_treat_as_empty(config.treat_as_empty)


def _is_empty(value_text: str | None, treat_as_empty: list[str]) -> bool:
    """Check if a value is considered empty."""
    return is_empty_text(value_text, treat_as_empty)


# ── 1. GET /texts ───────────────────────────────────────────────────────────

# Paging (#844). Sized from the MEASURED cost: unpaginated, this endpoint
# returned **37.8 MB of JSON for 75,699 texts** on ONE open-text column (~500
# bytes per text) at ~239 MB transient against a <256 MB resident budget — on
# the ENTRY SCREEN of the Text Coding workspace, not an export. 200 texts is
# ~100 KB. `ByTextTable` is virtualised, so the page bounds the PAYLOAD; it was
# never a render bound.
#
# ⚠️ Raising MAX_TEXT_PAGE_SIZE re-opens the payload problem in proportion. It
# bounds what a caller may ASK for — and it is ALSO what keeps the three
# per-page join-backs below under SQLite's 250,000 bind-parameter ceiling
# (#842), which is why it is a hard `le=` and not a suggestion.
TEXT_PAGE_SIZE = 200
MAX_TEXT_PAGE_SIZE = 1_000


def _text_order_clauses(sort_by: str):
    """THE ordering for a page of texts — with a DETERMINISTIC final tiebreak.

    ⚠️ **The tiebreak is load-bearing, and it is new with paging.** Before #844
    the whole result set was materialised and sorted in Python, so rows that
    compared equal fell back to whatever order SQLite happened to return and
    nothing could observe it. Under LIMIT/OFFSET an unstable order is a
    CORRECTNESS bug: two equal-comparing rows can both land on page 1 and page
    2, or on neither, so a researcher paging through responses silently sees
    one twice and never sees another. And ties are the COMMON case here, not an
    edge case — `column_sequence_order` ties on every row of the same column.

    `coalesce(row_identifier, '')` mirrors the Python ``t.row_identifier or ""``
    this replaces: a NULL identifier sorts as the empty string, not last.
    """
    ident = func.coalesce(DatasetRow.row_identifier, "")
    seq = DatasetColumn.sequence_order
    if sort_by == "record_asc":
        keys = (ident.asc(), seq.asc())
    elif sort_by == "record_desc":
        keys = (ident.desc(), seq.desc())
    elif sort_by == "column_desc":
        keys = (seq.desc(), ident.desc())
    else:  # column_asc (default)
        keys = (seq.asc(), ident.asc())
    # ASC in every direction: this key exists to make the page boundary
    # reproducible, not to be part of the researcher's chosen sort.
    return (*keys, DatasetValue.id.asc())


@router.get("/texts", response_model=TextsListResponse)
def list_texts(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated DatasetColumn IDs"),
    dataset_ids: str | None = Query(None, description="Comma-separated Dataset IDs to filter"),
    hide_empty: bool = Query(True),
    record_id: int | None = Query(None, description="Single DatasetRow ID for record filter"),
    search: str | None = Query(None, description="Text search within value_text"),
    sort_by: str = Query("column_asc"),
    random_seed: int | None = Query(None),
    quoted_only: bool = Query(False),
    limit: Annotated[int, Query(ge=1, le=MAX_TEXT_PAGE_SIZE)] = TEXT_PAGE_SIZE,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One PAGE of codeable texts, plus whole-selection totals (#844).

    ⚠️ **`texts` is a PAGE; the five totals describe the SELECTION** — #800's
    rule, and the reason this endpoint reports them at all. A `texts.length`
    record count is a bug.

    ⚠️ **Declared `def`, not `async def` (#837).** The body contains no `await`,
    so as an `async def` every query ran ON the event loop — measured at 2.2–3.6
    s for one column and 6.8 s for three, during which the server answered
    nothing, including Electron's `/health` probe. Paging makes that fast, but
    the aggregate pass below still scans the selection, so the endpoint stays
    off the loop rather than relying on it being small.
    """
    _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)
    if not parsed_column_ids:
        raise HTTPException(status_code=400, detail="column_ids is required")
    parsed_dataset_ids = parse_int_list(dataset_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # ── The selection, expressed ONCE ───────────────────────────────────────
    # Both of these are correlated EXISTS clauses rather than joins, and that is
    # deliberate: joining `CodeApplication` multiplies a value's row by its
    # number of applications, which would silently inflate `total_texts` and
    # `non_empty_texts` in the aggregate pass below. An EXISTS cannot.
    quoted_exists = (
        db.query(Excerpt.id)
        .filter(
            Excerpt.project_id == project_id,
            Excerpt.dataset_value_id == DatasetValue.id,
        )
        .exists()
    )
    # "Coded" = ≥1 NON-universal, non-consensus application — invariant J-A
    # (#488), the same predicate `text_columns` and the coding gauge use. A bare
    # any-application check counts universal-only values and makes this endpoint
    # disagree with the gauge on the same screen.
    coded_exists = (
        db.query(CodeApplication.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .filter(
            CodeApplication.dataset_value_id == DatasetValue.id,
            Code.is_universal == False,
            # J2-B / P-1: the workbench shows the human/working layer only;
            # never let derived consensus rows inflate a coded count.
            non_consensus_filter(),
        )
        .exists()
    )

    filters = [
        Dataset.project_id == project_id,
        DatasetColumn.column_type.in_(TEXT_TYPES),
        DatasetColumn.id.in_(parsed_column_ids),
    ]
    if parsed_dataset_ids:
        filters.append(Dataset.id.in_(parsed_dataset_ids))
    if record_id:
        filters.append(DatasetRow.id == record_id)
    if search:
        escaped_search = search.replace("%", r"\%").replace("_", r"\_")
        filters.append(DatasetValue.value_text.ilike(f"%{escaped_search}%", escape="\\"))
    if hide_empty:
        # #840's shared SQL expression of `is_empty_text` — the SAME predicate
        # the Python `_is_empty` applied here before #844, pinned to it by
        # `TestSubstantiveTextClauseAgreement`. Moving it into SQL is what lets
        # a page and the totals be computed without materialising the
        # population; a third hand-rolled `!= val` chain here is exactly what
        # #840 removed.
        filters.append(substantive_text_clause(treat_as_empty))
    if quoted_only:
        filters.append(quoted_exists)

    def scoped(query):
        """Apply the joins + every active filter to a query over DatasetValue.

        The `Participant` outer join rides along even for the aggregate pass:
        it is an equality on Participant's PRIMARY KEY, so it can never
        multiply a row, and keeping ONE scoping helper is what stops the page
        and the totals from being computed over two different sets.
        """
        return (
            query
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
            .filter(*filters)
        )

    # ── The five totals: ONE aggregate pass over the whole selection ────────
    # ⚠️ Before #844 these were accumulated while scanning every row, which IS
    # what made the endpoint unbounded — and they were quietly computed over
    # THREE different sets: `non_empty_texts` counted before the `quoted_only`
    # filter, the three id-sets after it, and `total_texts` was just
    # `len(texts)`. All five now describe the same filtered selection.
    totals = scoped(
        db.query(
            func.count(DatasetValue.id),
            func.sum(case((substantive_text_clause(treat_as_empty), 1), else_=0)),
            func.count(func.distinct(DatasetRow.id)),
            func.sum(case((coded_exists, 1), else_=0)),
            func.count(func.distinct(case((coded_exists, DatasetRow.id)))),
        )
    ).one()
    # SUM over zero rows is NULL, not 0.
    total_texts = totals[0] or 0
    non_empty_texts = totals[1] or 0
    total_rows = totals[2] or 0
    coded_texts = totals[3] or 0
    coded_rows = totals[4] or 0

    # ── The page ────────────────────────────────────────────────────────────
    selected = (
        DatasetValue.id,
        DatasetValue.value_text,
        DatasetValue.row_id,
        DatasetColumn.id.label("col_id"),
        DatasetColumn.column_name,
        DatasetColumn.column_text,
        DatasetColumn.sequence_order,
        Dataset.id.label("ds_id"),
        Dataset.name.label("ds_name"),
        DatasetRow.id.label("row_id"),
        DatasetRow.row_identifier,
        DatasetRow.participant_id,
        Participant.display_name.label("participant_display_name"),
        Participant.identifier.label("participant_identifier_name"),
    )

    if random_seed is not None:
        # Deterministic shuffle: hash (seed, id) so the same seed always
        # reproduces the same order across sessions/platforms. A multiplicative
        # key (id * seed % p) is NOT a shuffle here — products never reach the
        # modulus for realistic ids, leaving the key monotone in id (#486).
        #
        # ⚠️ It MUST stay blake2b, and that is what forces the id-list shape
        # below: `random_seed` is PERSISTED in `TextCodingConfig`, so changing
        # the function would silently reorder a review order a researcher has
        # already worked through. It is not expressible in SQLite, so the IDS
        # alone are ordered in Python and the page is then fetched by id —
        # 75,699 ints is ~600 KB and no text, against the 37.8 MB the old
        # whole-population fetch cost.
        all_ids = [r[0] for r in scoped(db.query(DatasetValue.id)).all()]
        all_ids.sort(key=lambda i: (
            hashlib.blake2b(f"{random_seed}:{i}".encode(), digest_size=8).digest(), i
        ))
        page_ids = all_ids[offset:offset + limit]
        rows = (
            scoped(db.query(*selected)).filter(DatasetValue.id.in_(page_ids)).all()
            if page_ids else []
        )
        position = {dv_id: pos for pos, dv_id in enumerate(page_ids)}
        rows.sort(key=lambda r: position[r[0]])
    else:
        rows = (
            scoped(db.query(*selected))
            .order_by(*_text_order_clauses(sort_by))
            .limit(limit)
            .offset(offset)
            .all()
        )

    # ── Per-page enrichment ─────────────────────────────────────────────────
    # #842 history: these three join-backs used to scope to the whole selection.
    # A Python id list handed to `.in_()` renders ONE BIND PARAMETER PER ELEMENT
    # and SQLite's SQLITE_MAX_VARIABLE_NUMBER is exactly 250,000, so four
    # open-text questions on a 75,699-record survey (302,796 values) raised a raw
    # OperationalError; the fix was a derived `scalar_subquery`.
    #
    # ⚠️ **That subquery is deliberately GONE, and the reason it is now safe to
    # bind ids is the `le=MAX_TEXT_PAGE_SIZE` cap** — this list is at most 1,000
    # elements, three orders of magnitude under the ceiling. Keeping the
    # subquery would re-run the whole filtered scan three more times per
    # request. **Do not remove the cap and leave these as-is.**
    page_value_ids = [r[0] for r in rows]
    quoted_excerpts: dict[int, int] = {}
    code_apps: dict[int, list[int]] = {}
    code_details: dict[int, list[AppliedCodeDetail]] = {}
    note_counts: dict[int, int] = {}

    if page_value_ids:
        quoted_excerpts = dict(
            db.query(Excerpt.dataset_value_id, Excerpt.id)
            .filter(
                Excerpt.project_id == project_id,
                Excerpt.dataset_value_id.in_(page_value_ids),
            )
            .all()
        )

        # Join Code for is_universal so the enriched detail can drive the
        # coder-scoped isSegmentCoded predicate (Track J · J1). code_id FK is
        # non-null so the inner join drops nothing the bare-ID list had.
        ca_query = (
            db.query(
                CodeApplication.dataset_value_id,
                CodeApplication.code_id,
                CodeApplication.user_id,
                CodeApplication.attribution,
                Code.is_universal,
                # #35 — the rating rides the same projection rather than a second
                # query: this endpoint is page-bounded (#800) and one more column
                # costs nothing, while a lookup per detail would be an N+1.
                CodeApplication.magnitude,
                CodeApplication.magnitude_conflict,
            )
            .join(Code, Code.id == CodeApplication.code_id)
            .filter(
                CodeApplication.dataset_value_id.in_(page_value_ids),
                CodeApplication.dataset_value_id.isnot(None),
                non_consensus_filter(),
            )
            .all()
        )
        for dv_id, code_id, ca_user_id, attribution, is_universal, ca_magnitude, ca_magnitude_conflict in ca_query:
            code_apps.setdefault(dv_id, []).append(code_id)
            code_details.setdefault(dv_id, []).append(
                AppliedCodeDetail(
                    code_id=code_id,
                    user_id=ca_user_id,
                    attribution=attribution,
                    is_universal=bool(is_universal),
                    magnitude=ca_magnitude,
                    magnitude_conflict=ca_magnitude_conflict,
                )
            )

        nc_query = (
            db.query(Note.dataset_value_id, func.count(Note.id))
            .filter(
                Note.dataset_value_id.in_(page_value_ids),
                Note.is_archived == False,
            )
            .group_by(Note.dataset_value_id)
            .all()
        )
        note_counts = {dv_id: cnt for dv_id, cnt in nc_query}

    texts = []
    for r in rows:
        value_text = r.value_text
        dv_id = r[0]
        is_quoted = dv_id in quoted_excerpts
        applied_codes = code_apps.get(dv_id, [])
        nc = note_counts.get(dv_id, 0)
        word_count = len(value_text.split()) if value_text and value_text.strip() else 0

        texts.append(TextResponse(
            dataset_value_id=dv_id,
            dataset_id=r.ds_id,
            dataset_name=r.ds_name,
            dataset_row_id=r.row_id,
            row_identifier=r.row_identifier,
            participant_id=r.participant_id,
            participant_name=(r.participant_display_name or r.participant_identifier_name) if r.participant_id else None,
            column_id=r.col_id,
            column_name=r.column_name,
            column_text=r.column_text,
            column_sequence_order=r.sequence_order,
            value_text=value_text,
            word_count=word_count,
            is_quoted=is_quoted,
            excerpt_id=quoted_excerpts.get(dv_id),
            applied_code_ids=applied_codes,
            applied_code_details=code_details.get(dv_id, []),
            note_count=nc,
        ))

    # The ordering is the DATABASE's now (`_text_order_clauses`) or, for the
    # seeded shuffle, the id-list order restored above — never a re-sort here,
    # which could only ever reorder within the page and would contradict the
    # boundary the page was cut on.
    return TextsListResponse(
        texts=texts,
        total_texts=total_texts,
        non_empty_texts=non_empty_texts,
        coded_texts=coded_texts,
        total_rows=total_rows,
        coded_rows=coded_rows,
        has_more=offset + len(texts) < total_texts,
    )


# ── 2. GET /records ─────────────────────────────────────────────────────

@router.get("/records", response_model=RecordsListResponse)
async def list_records(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated DatasetColumn IDs"),
    dataset_ids: str | None = Query(None),
    hide_empty: bool = Query(True),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)
    if not parsed_column_ids:
        raise HTTPException(status_code=400, detail="column_ids is required")
    parsed_dataset_ids = parse_int_list(dataset_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Get all texts for these columns
    query = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetRow.id.label("row_id"),
            DatasetRow.row_identifier,
            DatasetRow.participant_id,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
            DatasetColumn.id.in_(parsed_column_ids),
        )
    )

    if parsed_dataset_ids:
        query = query.filter(Dataset.id.in_(parsed_dataset_ids))

    rows = query.all()

    # Get all code applications in one query
    value_ids = [r[0] for r in rows]
    coded_values = set()
    if value_ids:
        # grain-allow: existence guard (which values have ANY coding). A consensus
        # row only exists where humans coded the same target, so origin-filtering
        # this set is a no-op in steady state; left unfiltered intentionally.
        coded_dv_ids = (
            db.query(func.distinct(CodeApplication.dataset_value_id))
            .filter(CodeApplication.dataset_value_id.in_(value_ids))
            .all()
        )
        coded_values = {dv_id for (dv_id,) in coded_dv_ids}

    # Group by record (DatasetRow)
    record_data = {}
    for r in rows:
        is_empty = _is_empty(r.value_text, treat_as_empty)
        if hide_empty and is_empty:
            continue

        row_id = r.row_id
        if row_id not in record_data:
            record_data[row_id] = {
                "row_id": row_id,
                "row_identifier": r.row_identifier,
                "participant_id": r.participant_id,
                "ds_id": r.ds_id,
                "ds_name": r.ds_name,
                "text_count": 0,
                "coded_text_count": 0,
            }
        if not is_empty:
            record_data[row_id]["text_count"] += 1
            if r[0] in coded_values:
                record_data[row_id]["coded_text_count"] += 1

    # Get linked conversation IDs via Participant → Speaker → Conversation
    participant_ids = set(
        rd["participant_id"] for rd in record_data.values() if rd["participant_id"]
    )
    linked_convs = defaultdict(list)
    if participant_ids:
        from ..models.segment import Segment
        conv_links = (
            db.query(Speaker.participant_id, func.distinct(Segment.conversation_id))
            .join(Segment, Segment.speaker_id == Speaker.id)
            .filter(Speaker.participant_id.in_(participant_ids))
            .group_by(Speaker.participant_id, Segment.conversation_id)
            .all()
        )
        for pid, conv_id in conv_links:
            linked_convs[pid].append(conv_id)

    # Get participant names
    participant_names = {}
    if participant_ids:
        parts = db.query(Participant.id, Participant.display_name, Participant.identifier).filter(
            Participant.id.in_(participant_ids)
        ).all()
        participant_names = {p.id: p.display_name or p.identifier for p in parts}

    records = []
    for rd in record_data.values():
        pid = rd["participant_id"]
        records.append(RecordResponse(
            dataset_row_id=rd["row_id"],
            row_identifier=rd["row_identifier"],
            participant_id=pid,
            participant_name=participant_names.get(pid) if pid else None,
            dataset_id=rd["ds_id"],
            dataset_name=rd["ds_name"],
            text_count=rd["text_count"],
            coded_text_count=rd["coded_text_count"],
            linked_conversation_ids=linked_convs.get(pid, []) if pid else [],
        ))

    records.sort(key=lambda r: r.row_identifier or "")

    return RecordsListResponse(
        records=records,
        total=len(records),
    )


# ── 3. GET /record-context/{dataset_row_id} ─────────────────────────────

@router.get("/record-context/{dataset_row_id}", response_model=RecordContextResponse)
async def record_context(
    project_id: int,
    dataset_row_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)

    result = (
        db.query(DatasetRow, Dataset)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(DatasetRow.id == dataset_row_id, Dataset.project_id == project_id)
        .first()
    )
    if not result:
        raise HTTPException(status_code=404, detail="Record not found in this project")

    row, dataset = result

    # Get all columns for this dataset
    columns = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == row.dataset_id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )

    # Get all values for this row
    values = (
        db.query(DatasetValue)
        .filter(DatasetValue.row_id == dataset_row_id)
        .all()
    )
    value_map = {v.column_id: v.value_text for v in values}

    demographics = []
    texts = []
    other_columns = []
    column_positions = []

    for col in columns:
        val = value_map.get(col.id)
        col_name = col.column_name or (col.column_text[:50] if col.column_text else "")
        col_type = col.column_type.value if hasattr(col.column_type, 'value') else str(col.column_type)

        column_positions.append(ColumnPositionResponse(
            column_id=col.id,
            column_name=col_name,
            sequence_order=col.sequence_order,
            column_type=col_type,
        ))

        if col.column_type == ColumnType.DEMOGRAPHIC:
            demographics.append(ColumnValueResponse(
                column_id=col.id,
                column_name=col_name,
                value=val,
            ))
        elif col.column_type in TEXT_TYPES:
            texts.append(TextValueResponse(
                column_id=col.id,
                column_name=col_name,
                value=val,
                sequence_order=col.sequence_order,
            ))
        elif col.column_type != ColumnType.SKIP:
            other_columns.append(NonTextValueResponse(
                column_id=col.id,
                column_name=col_name,
                value=val,
                column_type=col_type,
                sequence_order=col.sequence_order,
            ))

    # Linked conversations
    linked_conversations = []
    if row.participant_id:
        from ..models.segment import Segment
        conv_rows = (
            db.query(Conversation.id, Conversation.name)
            .join(Segment, Segment.conversation_id == Conversation.id)
            .join(Speaker, Segment.speaker_id == Speaker.id)
            .filter(Speaker.participant_id == row.participant_id)
            .distinct()
            .all()
        )
        linked_conversations = [
            LinkedConversationResponse(id=cid, name=cname)
            for cid, cname in conv_rows
        ]

    return RecordContextResponse(
        row_identifier=row.row_identifier,
        participant_id=row.participant_id,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        linked_conversations=linked_conversations,
        demographics=demographics,
        texts=texts,
        other_columns=other_columns,
        column_positions=column_positions,
    )


# ── 4. GET /text-columns ─────────────────────────────────────────────────

@router.get("/text-columns", response_model=TextColumnsListResponse)
async def text_columns(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)

    cols = (
        db.query(
            DatasetColumn.id,
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            DatasetColumn.column_type,
            DatasetColumn.sequence_order,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
        )
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .order_by(Dataset.name, DatasetColumn.sequence_order)
        .all()
    )

    # Get row counts per column
    col_ids = [c[0] for c in cols]
    total_counts = {}
    non_empty_counts = {}
    if col_ids:
        # Records per column = the RECORDS IN ITS DATASET (#830d).
        #
        # 🔴 This counted `DatasetValue` rows until 2026-08-26, i.e. cells that
        # EXIST — and the import pipeline stores no row for a blank cell, so a
        # record that skipped the question contributed nothing to the
        # denominator. Measured on the Ferncrest corpus: `Observer_Notes` has 40
        # value rows in a 48-record dataset, so the picker read
        # "36/40 responded" — a 90% response rate where the true figure is
        # 36/48 = 75%. The denominator was the wrong POPULATION: "how many
        # people answered" is asked of the people, not of the answers.
        #
        # ⚠️ The NUMERATOR is untouched and stays single-sourced (#519) — it was
        # independently confirmed correct against the coding gauge on the same
        # screen. Only the base moved.
        ds_ids = {c.ds_id for c in cols}
        dataset_row_counts = dict(
            db.query(DatasetRow.dataset_id, func.count(DatasetRow.id))
            .filter(DatasetRow.dataset_id.in_(ds_ids))
            .group_by(DatasetRow.dataset_id)
            .all()
        )
        total_counts = {c[0]: dataset_row_counts.get(c.ds_id, 0) for c in cols}

        # Non-empty rows (also exclude treat_as_empty values)
        config = _get_config(db, project_id)
        treat_as_empty = _get_treat_as_empty(config)
        # #840 — the shared SQL expression of `is_empty_text`, not a local
        # `!= val` chain. The chain was untrimmed, so it kept " N/A " while the
        # Python rule dropped it: two implementations of one predicate that had
        # already drifted. Latent on every corpus measured (0 padded cells), but
        # this is the exact seam #519 exists to close.
        non_empty_q = (
            db.query(DatasetValue.column_id, func.count(DatasetValue.id))
            .filter(
                DatasetValue.column_id.in_(col_ids),
                substantive_text_clause(treat_as_empty),
            )
        )
        non_empty = non_empty_q.group_by(DatasetValue.column_id).all()
        non_empty_counts = {cid: cnt for cid, cnt in non_empty}

    # Coded rows per column — the J-A definition (#492): distinct NON-EMPTY
    # values carrying ≥1 NON-UNIVERSAL, non-consensus application. This is the
    # displayed "N coded" in TextColumnPicker; it previously counted universal-
    # only (and even empty/"N/A") values, disagreeing with the coding-progress
    # gauge on the same screen (7 vs 6 on the audit corpus) and breaking the
    # "N coded ⊆ y responded" reading of "x/y responded · N coded".
    coded_counts = {}
    if col_ids:
        coded_q = (
            db.query(DatasetValue.column_id, func.count(func.distinct(DatasetValue.id)))
            .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .filter(
                DatasetValue.column_id.in_(col_ids),
                Code.is_universal == False,
                non_consensus_filter(),
                substantive_text_clause(treat_as_empty),
            )
        )
        coded = coded_q.group_by(DatasetValue.column_id).all()
        coded_counts = {cid: cnt for cid, cnt in coded}

    columns = []
    for c in cols:
        col_type = c.column_type.value if hasattr(c.column_type, 'value') else str(c.column_type)
        columns.append(TextColumnResponse(
            column_id=c[0],
            dataset_id=c.ds_id,
            dataset_name=c.ds_name,
            column_name=c.column_name,
            column_text=c.column_text,
            column_type=col_type,
            sequence_order=c.sequence_order,
            total_rows=total_counts.get(c[0], 0),
            non_empty_rows=non_empty_counts.get(c[0], 0),
            coded_rows=coded_counts.get(c[0], 0),
        ))

    return TextColumnsListResponse(columns=columns)


# ── 5. POST /code ────────────────────────────────────────────────────────────

@router.post("/code", response_model=TextCodeResponse)
async def apply_code(
    project_id: int,
    data: TextCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    dv = _get_text_value_or_404(db, project_id, data.dataset_value_id, user.id)

    code = db.query(Code).filter(
        Code.id == data.code_id,
        Code.project_id == project_id,
        Code.is_active == True,
    ).first()
    if not code:
        raise HTTPException(status_code=400, detail="Code not found or inactive")

    # Check for duplicate by THIS coder (per-coder layer; #J2-1b).
    existing = db.query(CodeApplication).filter(
        CodeApplication.dataset_value_id == data.dataset_value_id,
        CodeApplication.code_id == data.code_id,
        CodeApplication.user_id == user.id,
    ).first()
    if existing:
        return TextCodeResponse(
            dataset_value_id=data.dataset_value_id,
            code_id=data.code_id,
            applied=True,
            created_at=existing.created_at,
        )

    ca = CodeApplication(
        segment_id=None,
        dataset_value_id=data.dataset_value_id,
        code_id=data.code_id,
        user_id=user.id,
        attribution=data.attribution,
    )
    db.add(ca)
    if consensus_enabled(db):
        mark_consensus_stale(db, project_id, dataset_value_ids=[data.dataset_value_id])
    db.commit()
    db.refresh(ca)

    return TextCodeResponse(
        dataset_value_id=data.dataset_value_id,
        code_id=data.code_id,
        applied=True,
        created_at=ca.created_at,
    )


# ── 6. DELETE /code ──────────────────────────────────────────────────────────

@router.delete("/code")
async def remove_code(
    project_id: int,
    dataset_value_id: int = Query(...),
    code_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_text_value_or_404(db, project_id, dataset_value_id, user.id)

    ca = db.query(CodeApplication).filter(
        CodeApplication.dataset_value_id == dataset_value_id,
        CodeApplication.code_id == code_id,
    ).first()
    if not ca:
        raise HTTPException(status_code=404, detail="Code application not found")

    db.delete(ca)
    if consensus_enabled(db):
        mark_consensus_stale(db, project_id, dataset_value_ids=[dataset_value_id])
    db.commit()

    return {"status": "ok", "dataset_value_id": dataset_value_id, "code_id": code_id}


# ── 7. POST /bulk-code ──────────────────────────────────────────────────────

@router.post("/bulk-code", response_model=BulkCodeResponse)
async def bulk_code(
    project_id: int,
    data: BulkCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    code = db.query(Code).filter(
        Code.id == data.code_id,
        Code.project_id == project_id,
        Code.is_active == True,
    ).first()
    if not code:
        raise HTTPException(status_code=400, detail="Code not found or inactive")

    # De-duplicate while preserving order — a repeated id would be processed
    # twice against a stale `existing` set (not updated in the loop) and insert a
    # second CodeApplication for the same (value, code, coder), which the
    # per-coder unique index rejects with an IntegrityError at commit. Same
    # latent shape as the segment sibling in coding.py.
    requested_ids = list(dict.fromkeys(data.dataset_value_ids))

    # Batch validate all dataset_value_ids in one query
    valid_dvs = (
        db.query(DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetValue.id.in_(requested_ids),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .all()
    )
    valid_ids = {dv_id for (dv_id,) in valid_dvs}

    # Get THIS coder's existing applications to skip duplicates (per-coder
    # dedup; #J2-1b — a second coder still gets their own layer rows).
    existing = set(
        dv_id for (dv_id,) in db.query(CodeApplication.dataset_value_id).filter(
            CodeApplication.dataset_value_id.in_(requested_ids),
            CodeApplication.code_id == data.code_id,
            CodeApplication.user_id == user.id,
        ).all()
    )

    results = []
    success_count = 0
    error_count = 0
    failed_dataset_value_ids: list[int] = []

    for dv_id in requested_ids:
        if dv_id not in valid_ids:
            results.append(TextCodeResponse(
                dataset_value_id=dv_id, code_id=data.code_id, applied=False
            ))
            error_count += 1
            failed_dataset_value_ids.append(dv_id)
            continue

        if dv_id in existing:
            results.append(TextCodeResponse(
                dataset_value_id=dv_id, code_id=data.code_id, applied=True
            ))
            success_count += 1
            continue

        ca = CodeApplication(
            segment_id=None,
            dataset_value_id=dv_id,
            code_id=data.code_id,
            user_id=user.id,
            attribution=data.attribution,
        )
        db.add(ca)
        results.append(TextCodeResponse(
            dataset_value_id=dv_id, code_id=data.code_id, applied=True
        ))
        success_count += 1

    if consensus_enabled(db) and valid_ids:
        mark_consensus_stale(db, project_id, dataset_value_ids=list(valid_ids))
    db.commit()

    return BulkCodeResponse(
        results=results,
        success_count=success_count,
        error_count=error_count,
        failed_dataset_value_ids=failed_dataset_value_ids,
    )


# ── 7b. POST /bulk-remove-code ─────────────────────────────────────────────

@router.post("/bulk-remove-code", response_model=BulkRemoveCodeResponse)
async def bulk_remove_code(
    project_id: int,
    data: BulkRemoveCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    code = db.query(Code).filter(
        Code.id == data.code_id,
        Code.project_id == project_id,
    ).first()
    if not code:
        raise HTTPException(status_code=400, detail="Code not found")

    # Validate dataset_value_ids belong to this project
    valid_dvs = (
        db.query(DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetValue.id.in_(data.dataset_value_ids),
            Dataset.project_id == project_id,
        )
        .all()
    )
    valid_ids = {dv_id for (dv_id,) in valid_dvs}

    # Scoped to THIS coder so a bulk-remove never nukes another coder's
    # applications (#J2-1b critical nuke site).
    deleted_count = (
        db.query(CodeApplication)
        .filter(
            CodeApplication.dataset_value_id.in_(valid_ids),
            CodeApplication.code_id == data.code_id,
            CodeApplication.user_id == user.id,
        )
        .delete(synchronize_session=False)
    )

    if consensus_enabled(db) and valid_ids:
        mark_consensus_stale(db, project_id, dataset_value_ids=list(valid_ids))
    db.commit()

    return BulkRemoveCodeResponse(
        deleted_count=deleted_count,
        code_id=data.code_id,
    )


# ── 8. POST /notes ──────────────────────────────────────────────────────────

@router.post("/notes", response_model=NoteResponse)
async def create_text_note(
    project_id: int,
    data: TextNoteCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_text_value_or_404(db, project_id, data.dataset_value_id, user.id)

    note = Note(
        conversation_id=None,
        dataset_value_id=data.dataset_value_id,
        content=data.content,
    )
    # #747: was a literal 0. `TextNotesPanel` shows no number, so this one was
    # invisible until the Memos & Notes page printed `N-0` beside it.
    note.sequence_number = next_note_sequence(db, note)
    db.add(note)
    db.commit()
    db.refresh(note)

    return NoteResponse.model_validate(note)


# ── 9. GET /notes ────────────────────────────────────────────────────────────

@router.get("/notes", response_model=list[NoteResponse])
async def list_text_notes(
    project_id: int,
    dataset_value_id: int | None = Query(None),
    column_ids: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    if dataset_value_id is not None:
        # Single-text mode (original behavior)
        _get_text_value_or_404(db, project_id, dataset_value_id, user.id)
        notes = (
            db.query(Note)
            .filter(
                Note.dataset_value_id == dataset_value_id,
                Note.is_archived == False,
            )
            .order_by(Note.id)
            .all()
        )
    elif column_ids is not None:
        # Column-scoped mode: return all notes for texts in the given columns
        col_id_list = [int(c) for c in column_ids.split(",") if c.strip()]
        if not col_id_list:
            return []
        notes = (
            db.query(Note)
            .join(DatasetValue, Note.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.id.in_(col_id_list),
                Note.is_archived == False,
            )
            .order_by(Note.id.desc())
            .all()
        )
    else:
        raise HTTPException(status_code=400, detail="Either dataset_value_id or column_ids is required")

    return [NoteResponse.model_validate(n) for n in notes]


# ── 10. PATCH/DELETE /notes/{note_id} ────────────────────────────────────────

@router.patch("/notes/{note_id}", response_model=NoteResponse)
async def update_text_note(
    project_id: int,
    note_id: int,
    data: TextNoteUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note or not note.dataset_value_id:
        raise HTTPException(status_code=404, detail="Text note not found")

    # Verify ownership: DatasetValue → DatasetColumn → Dataset → Project
    _get_text_value_or_404(db, project_id, note.dataset_value_id, user.id)

    if data.content is not None:
        note.content = data.content

    db.commit()
    db.refresh(note)
    return NoteResponse.model_validate(note)


@router.delete("/notes/{note_id}")
async def delete_text_note(
    project_id: int,
    note_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note or not note.dataset_value_id:
        raise HTTPException(status_code=404, detail="Text note not found")

    _get_text_value_or_404(db, project_id, note.dataset_value_id, user.id)

    note.is_archived = True
    db.commit()

    return {"status": "ok", "note_id": note_id}


# ── 11. GET/PATCH /config ───────────────────────────────────────────────────

@router.get("/config", response_model=TextCodingConfigResponse)
async def get_config_endpoint(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    config = _get_config(db, project_id)
    db.commit()

    return TextCodingConfigResponse(
        view_mode=config.view_mode or "by_text",
        focal_column_ids=json.loads(config.focal_column_ids) if config.focal_column_ids else [],
        dataset_filter_ids=json.loads(config.dataset_filter_ids) if config.dataset_filter_ids else None,
        random_seed=config.random_seed,
        context_visibility=json.loads(config.context_visibility) if config.context_visibility else {},
        hide_empty=bool(config.hide_empty),
        starred_value_ids=json.loads(config.starred_value_ids) if config.starred_value_ids else [],
        treat_as_empty=_get_treat_as_empty(config),
        treat_as_empty_is_default=config.treat_as_empty is None,
    )


@router.patch("/config", response_model=TextCodingConfigResponse)
async def update_config(
    project_id: int,
    data: TextCodingConfigUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    config = _get_config(db, project_id)

    provided = data.model_fields_set
    if "view_mode" in provided:
        config.view_mode = data.view_mode
    if "focal_column_ids" in provided:
        config.focal_column_ids = json.dumps(data.focal_column_ids) if data.focal_column_ids is not None else None
    if "dataset_filter_ids" in provided:
        config.dataset_filter_ids = json.dumps(data.dataset_filter_ids) if data.dataset_filter_ids is not None else None
    if "random_seed" in provided:
        config.random_seed = data.random_seed
    if "context_visibility" in provided:
        config.context_visibility = json.dumps(data.context_visibility) if data.context_visibility is not None else None
    if "hide_empty" in provided:
        config.hide_empty = 1 if data.hide_empty else 0
    if "starred_value_ids" in provided:
        config.starred_value_ids = json.dumps(data.starred_value_ids) if data.starred_value_ids is not None else None
    if "treat_as_empty" in provided:
        config.treat_as_empty = json.dumps(data.treat_as_empty) if data.treat_as_empty is not None else None

    db.commit()
    db.refresh(config)

    return TextCodingConfigResponse(
        view_mode=config.view_mode or "by_text",
        focal_column_ids=json.loads(config.focal_column_ids) if config.focal_column_ids else [],
        dataset_filter_ids=json.loads(config.dataset_filter_ids) if config.dataset_filter_ids else None,
        random_seed=config.random_seed,
        context_visibility=json.loads(config.context_visibility) if config.context_visibility else {},
        hide_empty=bool(config.hide_empty),
        starred_value_ids=json.loads(config.starred_value_ids) if config.starred_value_ids else [],
        treat_as_empty=_get_treat_as_empty(config),
        treat_as_empty_is_default=config.treat_as_empty is None,
    )


# ── 12. GET /coding-progress ────────────────────────────────────────────────

@router.get("/coding-progress", response_model=CodingProgressResponse)
async def coding_progress(
    project_id: int,
    column_ids: str | None = Query(None, description="Comma-separated column IDs (all text columns if omitted)"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # Scope coverage to ONE coder (blind mode self-only); omit = all coders. Appended
    # last (not mid-signature) so existing positional callers are unaffected, and a
    # BARE `None` default (not Query(None)) so direct-call tests that omit it get real
    # None — FastAPI still treats a scalar as a query param. (?coder_id=N over the wire.)
    coder_id: int | None = None,
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Get all text columns
    col_query = (
        db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
    )
    if parsed_column_ids:
        col_query = col_query.filter(DatasetColumn.id.in_(parsed_column_ids))
    cols = col_query.all()
    col_ids = [c[0] for c in cols]

    if not col_ids:
        return CodingProgressResponse(
            by_column=[],
            overall_texts={"coded": 0, "total": 0},
            overall_records={"coded": 0, "total": 0},
        )

    # Get non-empty values per column
    values = (
        db.query(DatasetValue.id, DatasetValue.column_id, DatasetValue.value_text, DatasetValue.row_id)
        .filter(DatasetValue.column_id.in_(col_ids))
        .all()
    )

    # Get coded value IDs (#400: a value counts as "coded" only when it carries
    # at least one NON-UNIVERSAL code application — a universal-only marker like
    # "Unclear" must not inflate coverage; this mirrors lib/coding-progress.ts).
    coded_value_ids = set()
    value_ids = [v[0] for v in values]
    if value_ids:
        coded_q = (
            db.query(func.distinct(CodeApplication.dataset_value_id))
            .join(Code, Code.id == CodeApplication.code_id)
            .filter(
                CodeApplication.dataset_value_id.in_(value_ids),
                Code.is_universal == False,
                non_consensus_filter(),
            )
        )
        # Blind mode (DEC-G): scope overall_* coverage to the requesting coder so the
        # gauge shows self-only and no colleague counts reach the wire.
        if coder_id is not None:
            coded_q = coded_q.filter(CodeApplication.user_id == coder_id)
        coded_value_ids = {dv_id for (dv_id,) in coded_q.all()}

    # Per-coder coverage breakdown (Track J · J1 item 4). Same non-universal
    # rule; only attributed applications (user_id IS NOT NULL) are counted.
    coder_value_ids: dict[int, set[int]] = defaultdict(set)
    if value_ids:
        coder_rows_q = (
            db.query(CodeApplication.user_id, CodeApplication.dataset_value_id)
            .join(Code, Code.id == CodeApplication.code_id)
            .filter(
                CodeApplication.dataset_value_id.in_(value_ids),
                Code.is_universal == False,
                CodeApplication.user_id.isnot(None),
                # Exclude the consensus user so it never appears as a phantom coder
                # in the per-coder coverage breakdown (J2-B / P-1).
                non_consensus_filter(),
            )
        )
        # Blind mode (DEC-G): restrict the by_coder breakdown to the requesting coder
        # too, so colleague counts are absent from the payload, not just the render.
        if coder_id is not None:
            coder_rows_q = coder_rows_q.filter(CodeApplication.user_id == coder_id)
        for uid, dv_id in coder_rows_q.all():
            coder_value_ids[uid].add(dv_id)

    # Build per-column stats
    by_column = []
    overall_total = 0
    overall_coded = 0
    all_record_ids = set()
    coded_record_ids = set()
    # value_id -> row_id for non-empty text values (drives per-coder record counts)
    non_empty_value_row: dict[int, int] = {}

    col_map = {c[0]: (c[1] or c[2][:50]) for c in cols}

    for col_id in col_ids:
        col_values = [v for v in values if v[1] == col_id]
        non_empty = [v for v in col_values if not _is_empty(v[2], treat_as_empty)]
        coded = [v for v in non_empty if v[0] in coded_value_ids]

        by_column.append(ColumnProgressResponse(
            column_id=col_id,
            column_name=col_map.get(col_id),
            coded=len(coded),
            total=len(non_empty),
        ))
        overall_total += len(non_empty)
        overall_coded += len(coded)

        for v in non_empty:
            all_record_ids.add(v[3])
            non_empty_value_row[v[0]] = v[3]
            if v[0] in coded_value_ids:
                coded_record_ids.add(v[3])

    # Resolve per-coder coverage against the non-empty value universe so a coder's
    # coded_texts/coded_records use the same denominators as overall_*.
    by_coder: list[CodingProgressByCoderItem] = []
    for uid in sorted(coder_value_ids):
        coded_texts_for_coder = [
            dv_id for dv_id in coder_value_ids[uid] if dv_id in non_empty_value_row
        ]
        coded_records_for_coder = {
            non_empty_value_row[dv_id] for dv_id in coded_texts_for_coder
        }
        by_coder.append(CodingProgressByCoderItem(
            user_id=uid,
            coded_texts=len(coded_texts_for_coder),
            coded_records=len(coded_records_for_coder),
        ))

    db.commit()

    return CodingProgressResponse(
        by_column=by_column,
        overall_texts={"coded": overall_coded, "total": overall_total},
        overall_records={"coded": len(coded_record_ids), "total": len(all_record_ids)},
        by_coder=by_coder,
    )


# ── 14. GET /export ──────────────────────────────────────────────────────────

@router.get("/export")
async def export_coded_texts(
    project_id: int,
    coded_only: bool = Query(False),
    column_ids: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Excerpt-based quoting (migrated from TextCodingConfig JSON)
    quoted_set = set(
        dv_id for (dv_id,) in
        db.query(Excerpt.dataset_value_id)
        .filter(Excerpt.project_id == project_id, Excerpt.dataset_value_id.isnot(None))
        .all()
    )

    # Get text values
    query = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetRow.row_identifier,
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.name.label("ds_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
    )

    if parsed_column_ids:
        query = query.filter(DatasetColumn.id.in_(parsed_column_ids))

    query = query.order_by(Dataset.name, DatasetColumn.sequence_order, DatasetRow.row_identifier)
    rows = query.all()

    # Get all code applications
    value_ids = [r[0] for r in rows]
    code_apps = defaultdict(list)
    if value_ids:
        cas = (
            db.query(CodeApplication.dataset_value_id, Code.name)
            .join(Code, CodeApplication.code_id == Code.id)
            # Human/working layer only + de-dup per coder: a code applied by N
            # coders is one name in the export, and the consensus canonical name
            # never leaks into this user-facing CSV (#448b / J2-B).
            .filter(CodeApplication.dataset_value_id.in_(value_ids), non_consensus_filter())
            .distinct()
            .all()
        )
        for dv_id, code_name in cas:
            code_apps[dv_id].append(code_name)

    # Get notes
    note_map = defaultdict(list)
    if value_ids:
        notes = (
            db.query(Note.dataset_value_id, Note.content)
            .filter(
                Note.dataset_value_id.in_(value_ids),
                Note.is_archived == False,
            )
            .order_by(Note.id)
            .all()
        )
        for dv_id, content in notes:
            note_map[dv_id].append(content)

    output = io.StringIO()
    writer = csv.writer(output)

    headers = [
        "Record ID", "Dataset", "Column Name", "Text",
        "Applied Codes", "Notes", "Word Count", "Is Quoted",
    ]
    if config.random_seed is not None:
        headers.append("Randomization Seed")
    writer.writerow(headers)

    for r in rows:
        dv_id = r[0]
        value_text = r.value_text
        is_empty = _is_empty(value_text, treat_as_empty)

        codes = code_apps.get(dv_id, [])
        if coded_only and not codes:
            continue

        if is_empty:
            continue

        word_count = len(value_text.split()) if value_text and value_text.strip() else 0
        col_name = r.column_name or (r.column_text[:50] if r.column_text else "")
        notes_text = "; ".join(note_map.get(dv_id, []))
        is_quoted = dv_id in quoted_set

        row_data = [
            csv_safe(r.row_identifier or ""),
            csv_safe(r.ds_name),
            csv_safe(col_name),
            csv_safe(value_text or ""),
            csv_safe("; ".join(codes)),
            csv_safe(notes_text),
            word_count,
            "Yes" if is_quoted else "No",
        ]
        if config.random_seed is not None:
            row_data.append(config.random_seed)
        writer.writerow(row_data)

    output.seek(0)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    filename = sanitize_csv_filename(f"{project.name}_coded_texts_{now.strftime('%Y%m%d')}.csv")

    db.commit()

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
