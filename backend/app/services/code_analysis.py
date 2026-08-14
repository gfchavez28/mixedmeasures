"""Service layer for cross-conversation qualitative code analysis.

Supports three source modes:
- "conversations" (default): segment-based code applications (conversations + documents)
- "comments": only dataset-value-based code applications (comment coding)
- "all": merged results from all sources
"""

from collections import defaultdict
from itertools import combinations
from sqlalchemy.orm import Session, contains_eager, joinedload
from sqlalchemy import func, literal, case as sa_case

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.code_category import CodeCategory
from ..models.segment import Segment
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.observation import Observation
from ..models.speaker import Speaker
from ..models.participant import Participant
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.excerpt import Excerpt, segment_has_any_quote_filter
from .coding_layers import LAYER_CONSENSUS, layer_origin_filter, non_consensus_filter
from .grouping import order_value_labels
from .missing_values import column_missing_rules, is_missing

# ── Rounding precision constants ─────────────────────────────────────────────
DISPLAY_PERCENTAGE_PRECISION = 1  # round(x, 1) for display percentages (e.g. 42.9%)

# The category fold used by `get_source_frequencies` when `aggregation="category"`.
# An uncategorised code becomes its own pseudo-category keyed on the NEGATIVE of
# its code id, which is what keeps the two id spaces from colliding inside one
# response. Declared once because several queries must agree on it exactly: a
# second copy that folded uncategorised codes differently would put a row's
# counts under a key no consumer looks up, and the row would silently read zero.
_EFFECTIVE_CAT_ID = sa_case(
    (Code.category_id.isnot(None), Code.category_id),
    else_=(-1 * Code.id),
)


def _get_universal_code_ids(db: Session, project_id: int) -> set[int]:
    return set(
        cid for (cid,) in db.query(Code.id).filter(
            Code.project_id == project_id, Code.is_universal == True,
        ).all()
    )


def _coder_filter(query, coder_ids: list[int] | None, layer_scope: str | None = None):
    """Track J · J1/J2 — scope a `CodeApplication` analysis query to a coder layer.

    Two responsibilities, both on `CodeApplication`, single-sourced HERE so every
    count/frequency/co-occurrence surface in this module is layer-correct:
      - **Layer selection (J2-C, Slab 7):** `layer_origin_filter(layer_scope)` —
        `layer_scope='consensus'` selects ONLY the derived consensus layer;
        otherwise (the `'human'` default) excludes consensus (the J2-B guard). The
        consensus layer is a single synthetic coder, so a `coder_ids` restriction
        is meaningless there and is skipped.
      - **J1 coder scope (human layer only):** `coder_ids` None/empty → all
        (non-consensus) coders; otherwise restrict to the selected coders.

    Apply ONLY to queries that count/join `CodeApplication` (frequency numerators,
    coded denominators, co-occurrence) — NEVER to the segment/participant-universe
    denominators (e.g. total participants who spoke) or the display "what codes are
    on this unit" queries (codes_by_seg / codes_by_dv), which must stay all-coder.
    The `~code_id.in_(universal_ids)` exclusion is orthogonal and stays put.
    """
    query = query.filter(layer_origin_filter(layer_scope))
    if layer_scope == LAYER_CONSENSUS:
        return query  # consensus is one synthetic coder — coder_ids is moot
    if coder_ids:
        return query.filter(CodeApplication.user_id.in_(coder_ids))
    return query


# ── Internal: conversation-based frequencies ─────────────────────────────────

def _get_conversation_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """Compute code frequency stats from conversation segments only."""
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.segment_id)).label("seg_count"),
            func.count(func.distinct(Segment.conversation_id)).label("conv_count"),
            func.count(func.distinct(Speaker.participant_id)).label("part_count"),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if exclude_facilitator:
        base = base.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conversation_ids:
        base = base.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        base = base.filter(Speaker.participant_id.in_(participant_ids))
    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))
    base = _coder_filter(base, coder_ids, layer_scope)

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2], row[3]) for row in freq_rows}

    # Totals
    universal_ids = _get_universal_code_ids(db, project_id)

    coded_seg_query = (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        coded_seg_query = coded_seg_query.filter(~CodeApplication.code_id.in_(universal_ids))
    if exclude_facilitator:
        coded_seg_query = coded_seg_query.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        coded_seg_query = coded_seg_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        coded_seg_query = coded_seg_query.filter(Speaker.participant_id.in_(participant_ids))
    coded_seg_query = _coder_filter(coded_seg_query, coder_ids, layer_scope)
    total_coded_segments = coded_seg_query.scalar() or 0

    total_conv_query = (
        db.query(func.count(func.distinct(Segment.conversation_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        total_conv_query = total_conv_query.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        total_conv_query = total_conv_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        total_conv_query = total_conv_query.filter(Speaker.participant_id.in_(participant_ids))
    total_conv_query = _coder_filter(total_conv_query, coder_ids, layer_scope)
    total_conversations = total_conv_query.scalar() or 0

    part_query = (
        db.query(func.count(func.distinct(Speaker.participant_id)))
        .join(Segment, Segment.speaker_id == Speaker.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .filter(
            Conversation.project_id == project_id,
            Speaker.participant_id != None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conversation_ids:
        part_query = part_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        part_query = part_query.filter(Speaker.participant_id.in_(participant_ids))
    total_participants = part_query.scalar() or 0

    unlinked_query = (
        db.query(func.count(func.distinct(Speaker.id)))
        .join(Segment, Segment.speaker_id == Speaker.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Conversation.project_id == project_id,
            Speaker.participant_id == None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conversation_ids:
        unlinked_query = unlinked_query.filter(Segment.conversation_id.in_(conversation_ids))
    unlinked_query = _coder_filter(unlinked_query, coder_ids, layer_scope)
    if participant_ids:
        unlinked_speaker_count = 0
    else:
        unlinked_speaker_count = unlinked_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_segments": total_coded_segments,
        "total_conversations": total_conversations,
        "total_participants": total_participants,
        "unlinked_speaker_count": unlinked_speaker_count,
    }


# ── Internal: comment-based frequencies ──────────────────────────────────────

def _get_comment_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """Compute code frequency stats from comment coding only."""
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.dataset_value_id)).label("text_count"),
            func.count(func.distinct(DatasetValue.row_id)).label("row_count"),
        )
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if participant_ids:
        base = base.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        base = base.filter(DatasetRow.participant_id.in_(participant_ids))

    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))
    base = _coder_filter(base, coder_ids, layer_scope)

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2]) for row in freq_rows}

    # Totals (must apply same participant filter as per-code queries)
    total_comment_query = (
        db.query(func.count(func.distinct(CodeApplication.dataset_value_id)))
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if participant_ids:
        total_comment_query = (
            total_comment_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    total_comment_query = _coder_filter(total_comment_query, coder_ids, layer_scope)
    total_coded_texts = total_comment_query.scalar() or 0

    total_records_query = (
        db.query(func.count(func.distinct(DatasetValue.row_id)))
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            CodeApplication.dataset_value_id.isnot(None),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if participant_ids:
        total_records_query = (
            total_records_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    total_records_query = _coder_filter(total_records_query, coder_ids, layer_scope)
    total_records = total_records_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_texts": total_coded_texts,
        "total_rows": total_records,
    }


# ── Internal: document-based frequencies ──────────────────────────────────

def _get_document_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """Compute code frequency stats from document segments only."""
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.segment_id)).label("seg_count"),
            func.count(func.distinct(Segment.document_id)).label("doc_count"),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if document_ids:
        base = base.filter(Segment.document_id.in_(document_ids))
    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))
    base = _coder_filter(base, coder_ids, layer_scope)

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2]) for row in freq_rows}

    # Totals
    universal_ids = _get_universal_code_ids(db, project_id)

    coded_seg_query = (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        coded_seg_query = coded_seg_query.filter(~CodeApplication.code_id.in_(universal_ids))
    if document_ids:
        coded_seg_query = coded_seg_query.filter(Segment.document_id.in_(document_ids))
    coded_seg_query = _coder_filter(coded_seg_query, coder_ids, layer_scope)
    total_coded_doc_segments = coded_seg_query.scalar() or 0

    total_doc_query = (
        db.query(func.count(func.distinct(Segment.document_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if document_ids:
        total_doc_query = total_doc_query.filter(Segment.document_id.in_(document_ids))
    total_doc_query = _coder_filter(total_doc_query, coder_ids, layer_scope)
    total_documents = total_doc_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_doc_segments": total_coded_doc_segments,
        "total_documents": total_documents,
    }


def _get_observation_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    observation_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """Compute code frequency stats from observation clips only (slab 4c).

    Mirrors ``_get_document_frequencies`` — clips have no speaker, so there is no
    facilitator/participant dimension; the same ``_coder_filter`` threading gives
    consensus-layer selection for free (a FROZEN observation's clips carry a
    consensus layer since D18).
    """
    base = (
        db.query(
            CodeApplication.code_id,
            func.count(func.distinct(CodeApplication.segment_id)).label("clip_count"),
            func.count(func.distinct(Segment.observation_id)).label("obs_count"),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if observation_ids:
        base = base.filter(Segment.observation_id.in_(observation_ids))
    if code_ids:
        base = base.filter(CodeApplication.code_id.in_(code_ids))
    base = _coder_filter(base, coder_ids, layer_scope)

    freq_rows = base.group_by(CodeApplication.code_id).all()
    freq_map = {row[0]: (row[1], row[2]) for row in freq_rows}

    # Totals
    universal_ids = _get_universal_code_ids(db, project_id)

    coded_clip_query = (
        db.query(func.count(func.distinct(CodeApplication.segment_id)))
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        coded_clip_query = coded_clip_query.filter(~CodeApplication.code_id.in_(universal_ids))
    if observation_ids:
        coded_clip_query = coded_clip_query.filter(Segment.observation_id.in_(observation_ids))
    coded_clip_query = _coder_filter(coded_clip_query, coder_ids, layer_scope)
    total_coded_clips = coded_clip_query.scalar() or 0

    total_obs_query = (
        db.query(func.count(func.distinct(Segment.observation_id)))
        .join(CodeApplication, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            CodeApplication.segment_id.isnot(None),
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if observation_ids:
        total_obs_query = total_obs_query.filter(Segment.observation_id.in_(observation_ids))
    total_obs_query = _coder_filter(total_obs_query, coder_ids, layer_scope)
    total_observations = total_obs_query.scalar() or 0

    return {
        "freq_map": freq_map,
        "total_coded_clips": total_coded_clips,
        "total_observations": total_observations,
    }


# ── Public: get_code_frequencies ─────────────────────────────────────────────

def get_code_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "conversations",
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> dict:
    """Compute code frequency statistics.

    source: "conversations" | "text" | "all" (legacy "comments" coerced to "text")
    When source is "conversations" or "all", document segments and observation
    clips are included (the segment-shaped sources travel together).

    ⚠️ **#749 — this reads an empty id list DIFFERENTLY from its sibling
    `get_source_frequencies` (below, ~line 2140). Read that one before changing
    this one.**

    Here (and in the four `_get_*_frequencies` helpers) the test is truthy —
    ``if <ids>:`` — so an empty or absent list means **ALL sources of that kind**.
    `get_source_frequencies` tests ``is not None``, where an empty list means
    **NONE of that kind**. The two live ~1,600 lines apart and neither said so,
    which is how #745 shipped: the summary table summed its Count over one
    payload and took its percentage from the other, and every code read
    ``Count 0`` beside ``25.0%``.

    ⚠️ **Do not "harmonise" this to ``is not None`` on its own.**
    `routers/helpers.py::parse_int_list` returns ``None`` for an absent param AND
    for an empty string, so no client can express "none of this kind" over the
    wire regardless; the only behaviour that would change is for in-process
    callers passing a literal ``[]``. It looks like a fix and closes nothing.

    ⚠️ **The resulting scope is a HYBRID, not "project-wide" — measured, not
    inferred.** Because the UI omits unselected kinds entirely, selecting one
    conversation in a 4-conversation project moved ``total_conversations`` 2 → 1
    while ``total_coded_segments`` only moved 21 → 20: conversations were
    restricted, observations were not. So these totals are neither the project
    nor the selection, and there is no honest one-line label for them. Closing
    that is a wire-contract decision recorded in ISSUES #749.
    """
    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    # Load code metadata
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids:
        all_codes = [c for c in all_codes if c.id in set(code_ids)]

    conv_data = None
    comment_data = None
    doc_data = None
    obs_data = None

    if source in ("conversations", "all"):
        conv_data = _get_conversation_frequencies(
            db, project_id,
            code_ids=code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=conversation_ids,
            participant_ids=participant_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        doc_data = _get_document_frequencies(
            db, project_id,
            code_ids=code_ids,
            document_ids=document_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        obs_data = _get_observation_frequencies(
            db, project_id,
            code_ids=code_ids,
            observation_ids=observation_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )

    if source in ("text", "all"):
        comment_data = _get_comment_frequencies(
            db, project_id,
            code_ids=code_ids,
            participant_ids=participant_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )

    # Build frequencies — coded clips fold into the segment total (a clip IS a
    # segment; a per-code count that omitted it would disagree with "N uses").
    total_coded_segments = (
        (conv_data["total_coded_segments"] if conv_data else 0)
        + (doc_data["total_coded_doc_segments"] if doc_data else 0)
        + (obs_data["total_coded_clips"] if obs_data else 0)
    )
    total_conversations = conv_data["total_conversations"] if conv_data else 0
    total_documents = doc_data["total_documents"] if doc_data else 0
    total_observations = obs_data["total_observations"] if obs_data else 0
    total_participants = conv_data["total_participants"] if conv_data else 0
    unlinked_speaker_count = conv_data["unlinked_speaker_count"] if conv_data else 0
    total_coded_texts = comment_data["total_coded_texts"] if comment_data else 0
    total_records = comment_data["total_rows"] if comment_data else 0

    frequencies = []
    for code in all_codes:
        entry = {
            "code_id": code.id,
            "code_name": code.name,
            "code_color": code.color,
            "is_universal": code.is_universal,
            "category_id": code.category_id,
            "category_name": code.category.name if code.category else None,
            "category_color": code.category.color if code.category else None,
        }

        if conv_data:
            seg_c, conv_c, part_c = conv_data["freq_map"].get(code.id, (0, 0, 0))
            doc_seg_c, doc_c = doc_data["freq_map"].get(code.id, (0, 0)) if doc_data else (0, 0)
            obs_clip_c, obs_c = obs_data["freq_map"].get(code.id, (0, 0)) if obs_data else (0, 0)
            combined_seg = seg_c + doc_seg_c + obs_clip_c
            entry["segment_count"] = combined_seg
            entry["segment_percentage"] = round(combined_seg / total_coded_segments * 100, DISPLAY_PERCENTAGE_PRECISION) if total_coded_segments else 0.0
            entry["conversation_count"] = conv_c
            entry["conversation_percentage"] = round(conv_c / total_conversations * 100, DISPLAY_PERCENTAGE_PRECISION) if total_conversations else 0.0
            entry["document_count"] = doc_c
            entry["document_percentage"] = round(doc_c / total_documents * 100, DISPLAY_PERCENTAGE_PRECISION) if total_documents else 0.0
            entry["observation_count"] = obs_c
            entry["observation_percentage"] = round(obs_c / total_observations * 100, DISPLAY_PERCENTAGE_PRECISION) if total_observations else 0.0
            entry["participant_count"] = part_c
            entry["participant_percentage"] = round(part_c / total_participants * 100, DISPLAY_PERCENTAGE_PRECISION) if total_participants else 0.0
        else:
            entry["segment_count"] = 0
            entry["segment_percentage"] = 0.0
            entry["conversation_count"] = 0
            entry["conversation_percentage"] = 0.0
            entry["document_count"] = 0
            entry["document_percentage"] = 0.0
            entry["observation_count"] = 0
            entry["observation_percentage"] = 0.0
            entry["participant_count"] = 0
            entry["participant_percentage"] = 0.0

        if comment_data:
            comment_c, row_c = comment_data["freq_map"].get(code.id, (0, 0))
            entry["text_count"] = comment_c
            entry["text_percentage"] = round(comment_c / total_coded_texts * 100, DISPLAY_PERCENTAGE_PRECISION) if total_coded_texts else 0.0
            entry["row_count"] = row_c
            entry["row_percentage"] = round(row_c / total_records * 100, DISPLAY_PERCENTAGE_PRECISION) if total_records else 0.0
        else:
            entry["text_count"] = 0
            entry["text_percentage"] = 0.0
            entry["row_count"] = 0
            entry["row_percentage"] = 0.0

        frequencies.append(entry)

    result = {
        "frequencies": frequencies,
        "total_coded_segments": total_coded_segments,
        "total_conversations": total_conversations,
        "total_documents": total_documents,
        "total_observations": total_observations,
        "total_participants": total_participants,
        "total_codes_active": len(frequencies),
        "unlinked_speaker_count": unlinked_speaker_count,
        "total_coded_texts": total_coded_texts,
        "total_rows": total_records,
        "source": source,
    }

    return result


def get_segments_with_context(
    db: Session,
    project_id: int,
    code_id: int,
    context_size: int = 1,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    limit: int = 200,
    offset: int = 0,
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> dict:
    """Get coded segments with surrounding context, grouped by conversation,
    document, and observation (D25 — once frequencies count clips, a Content
    tab that omits them is a defect-shaped split-brain).

    Returns focal segments (those with the given code applied) plus
    preceding/following context segments from the same parent.
    """
    code = (
        db.query(Code)
        .options(joinedload(Code.category))
        .filter(Code.id == code_id, Code.project_id == project_id)
        .first()
    )
    if not code:
        return None

    app_query = (
        db.query(CodeApplication.segment_id, Segment.conversation_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            CodeApplication.code_id == code_id,
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if exclude_facilitator:
        app_query = app_query.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conversation_ids:
        app_query = app_query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        app_query = app_query.filter(Speaker.participant_id.in_(participant_ids))
    app_query = _coder_filter(app_query, coder_ids, layer_scope)

    app_query = app_query.order_by(Segment.conversation_id, Segment.sequence_order)
    # #491: application grain → distinct-segment grain. A segment coded by two
    # coders is ONE reading unit — the raw rows listed (and counted) it once per
    # coder, so multi-coder segments rendered as duplicate cards and the header
    # total exceeded the rendered list. Dedup in Python (order-preserving) —
    # SQL DISTINCT would reject the ORDER BY on the unselected sequence_order.
    seen_seg_ids: set[int] = set()
    all_apps = [
        (sid, cid) for sid, cid in app_query.all()
        if not (sid in seen_seg_ids or seen_seg_ids.add(sid))
    ]

    total_segments = len(all_apps)
    paged_apps = all_apps[offset:offset + limit]
    has_more = (offset + limit) < total_segments

    # #618: NO early return on an empty conversation arm — the document and
    # observation gathers below must still run (a doc-only or clip-only code
    # used to render an EMPTY Content view while its frequency badge said N
    # uses). The conversation block is empty-safe: every lookup is `.in_()` on
    # an empty set or guarded, and `conversations` ends [].
    focal_by_conv: dict[int, list[int]] = defaultdict(list)
    focal_seg_ids = set()
    conv_ids_needed = set()
    for seg_id, conv_id in paged_apps:
        focal_by_conv[conv_id].append(seg_id)
        focal_seg_ids.add(seg_id)
        conv_ids_needed.add(conv_id)

    all_segments = (
        db.query(Segment)
        .filter(
            Segment.conversation_id.in_(conv_ids_needed),
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
        .order_by(Segment.conversation_id, Segment.sequence_order)
        .all()
    )

    segs_by_conv: dict[int, list] = defaultdict(list)
    seg_lookup: dict[int, object] = {}
    for seg in all_segments:
        segs_by_conv[seg.conversation_id].append(seg)
        seg_lookup[seg.id] = seg

    speaker_ids = set(seg.speaker_id for seg in all_segments if seg.speaker_id)
    speakers = {}
    if speaker_ids:
        speaker_rows = db.query(Speaker).filter(Speaker.id.in_(speaker_ids)).all()
        speakers = {s.id: s for s in speaker_rows}

    speaker_participant_ids = set(s.participant_id for s in speakers.values() if s.participant_id)
    participants = {}
    if speaker_participant_ids:
        part_rows = db.query(Participant).filter(Participant.id.in_(speaker_participant_ids)).all()
        participants = {p.id: p for p in part_rows}

    # Per-segment code chips: honor the selected layer (J2-C) and de-dup per
    # coder — without distinct, a code applied by N coders yields N entries
    # (consensus inflation + the #441 duplicate-key collision downstream).
    focal_codes = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(
            CodeApplication.segment_id.in_(focal_seg_ids),
            layer_origin_filter(layer_scope),
        )
        .distinct()
        .all()
    )
    codes_by_seg: dict[int, list[int]] = defaultdict(list)
    for seg_id, cid in focal_codes:
        codes_by_seg[seg_id].append(cid)

    # Quote flag: shape-agnostic (whole OR time-range — slab 5 D32); char-range
    # excerpts deliberately don't mark a segment quoted (pre-slab-5 behavior).
    quoted_seg_ids = set(
        eid for (eid,) in db.query(Excerpt.segment_id).filter(
            Excerpt.segment_id.in_(focal_seg_ids),
            segment_has_any_quote_filter(),
        ).all()
    )

    conv_rows = db.query(Conversation.id, Conversation.name).filter(
        Conversation.id.in_(conv_ids_needed)
    ).all()
    conv_names = {cid: cname for cid, cname in conv_rows}

    def seg_to_context(seg) -> dict:
        speaker = speakers.get(seg.speaker_id)
        return {
            "id": seg.id,
            "sequence_order": seg.sequence_order,
            "speaker_name": speaker.name if speaker else None,
            "speaker_color_index": speaker.color_index if speaker else 0,
            "speaker_color": speaker.color if speaker else None,
            "is_facilitator": bool(speaker.is_facilitator) if speaker else False,
            "text": seg.text,
            "start_time": seg.start_time,
        }

    def seg_to_focal(seg) -> dict:
        speaker = speakers.get(seg.speaker_id)
        participant = None
        if speaker and speaker.participant_id:
            participant = participants.get(speaker.participant_id)
        return {
            "id": seg.id,
            "sequence_order": seg.sequence_order,
            "speaker_name": speaker.name if speaker else None,
            "speaker_color_index": speaker.color_index if speaker else 0,
            "speaker_color": speaker.color if speaker else None,
            "is_facilitator": bool(speaker.is_facilitator) if speaker else False,
            "text": seg.text,
            "start_time": seg.start_time,
            "is_quoted": seg.id in quoted_seg_ids,
            "applied_code_ids": codes_by_seg.get(seg.id, []),
            "participant_id": participant.id if participant else None,
            "participant_name": (participant.display_name or participant.identifier) if participant else None,
        }

    conversations = []
    for conv_id in focal_by_conv:
        conv_segs = segs_by_conv.get(conv_id, [])
        seq_index = {seg.id: idx for idx, seg in enumerate(conv_segs)}

        focal_ids_in_conv = set(focal_by_conv[conv_id])
        context_indices = set()
        focal_indices = set()

        for seg_id in focal_ids_in_conv:
            idx = seq_index.get(seg_id)
            if idx is not None:
                focal_indices.add(idx)
                for ci in range(max(0, idx - context_size), idx):
                    context_indices.add(ci)
                for ci in range(idx + 1, min(len(conv_segs), idx + context_size + 1)):
                    context_indices.add(ci)

        context_indices -= focal_indices

        segments_out = []
        for seg_id in focal_by_conv[conv_id]:
            idx = seq_index.get(seg_id)
            if idx is None:
                continue
            seg = conv_segs[idx]

            preceding = []
            for ci in range(max(0, idx - context_size), idx):
                preceding.append(seg_to_context(conv_segs[ci]))

            following = []
            for ci in range(idx + 1, min(len(conv_segs), idx + context_size + 1)):
                following.append(seg_to_context(conv_segs[ci]))

            focal = seg_to_focal(seg)
            focal["preceding_context"] = preceding
            focal["following_context"] = following
            segments_out.append(focal)

        conversations.append({
            "conversation_id": conv_id,
            "conversation_name": conv_names.get(conv_id, "Unknown"),
            "segment_count": len(segments_out),
            "segments": segments_out,
        })

    # ── Document segments ──
    doc_app_query = (
        db.query(CodeApplication.segment_id, Segment.document_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            CodeApplication.code_id == code_id,
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if document_ids:
        doc_app_query = doc_app_query.filter(Segment.document_id.in_(document_ids))
    doc_app_query = _coder_filter(doc_app_query, coder_ids, layer_scope)
    doc_app_query = doc_app_query.order_by(Segment.document_id, Segment.sequence_order)
    # #491: distinct-segment grain (see the conversation branch above).
    seen_doc_seg_ids: set[int] = set()
    all_doc_apps = [
        (sid, did) for sid, did in doc_app_query.all()
        if not (sid in seen_doc_seg_ids or seen_doc_seg_ids.add(sid))
    ]

    doc_total_segments = len(all_doc_apps)
    # Apply offset/limit across all sources — document segments come after conversation segments
    # For simplicity, we'll return document results as a separate list without shared pagination
    doc_paged_apps = all_doc_apps[:limit]

    doc_focal_by_doc: dict[int, list[int]] = defaultdict(list)
    doc_focal_seg_ids = set()
    doc_ids_needed = set()
    for seg_id, did in doc_paged_apps:
        doc_focal_by_doc[did].append(seg_id)
        doc_focal_seg_ids.add(seg_id)
        doc_ids_needed.add(did)

    doc_results = []
    if doc_ids_needed:
        doc_all_segments = (
            db.query(Segment)
            .filter(
                Segment.document_id.in_(doc_ids_needed),
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
            .order_by(Segment.document_id, Segment.sequence_order)
            .all()
        )

        doc_segs_by_doc: dict[int, list] = defaultdict(list)
        for seg in doc_all_segments:
            doc_segs_by_doc[seg.document_id].append(seg)

        doc_focal_codes = (
            db.query(CodeApplication.segment_id, CodeApplication.code_id)
            .filter(
                CodeApplication.segment_id.in_(doc_focal_seg_ids),
                layer_origin_filter(layer_scope),
            )
            .distinct()
            .all()
        )
        doc_codes_by_seg: dict[int, list[int]] = defaultdict(list)
        for seg_id, cid in doc_focal_codes:
            doc_codes_by_seg[seg_id].append(cid)

        doc_quoted_seg_ids = set(
            eid for (eid,) in db.query(Excerpt.segment_id).filter(
                Excerpt.segment_id.in_(doc_focal_seg_ids),
                segment_has_any_quote_filter(),
            ).all()
        ) if doc_focal_seg_ids else set()

        doc_name_rows = db.query(Document.id, Document.name).filter(
            Document.id.in_(doc_ids_needed)
        ).all()
        doc_names = {did: dname for did, dname in doc_name_rows}

        def doc_seg_to_context(seg) -> dict:
            return {
                "id": seg.id,
                "sequence_order": seg.sequence_order,
                "speaker_name": None,
                "speaker_color_index": 0,
                "speaker_color": None,
                "is_facilitator": False,
                "text": seg.text,
                "start_time": None,
            }

        def doc_seg_to_focal(seg) -> dict:
            return {
                "id": seg.id,
                "sequence_order": seg.sequence_order,
                "speaker_name": None,
                "speaker_color_index": 0,
                "speaker_color": None,
                "is_facilitator": False,
                "text": seg.text,
                "start_time": None,
                "is_quoted": seg.id in doc_quoted_seg_ids,
                "applied_code_ids": doc_codes_by_seg.get(seg.id, []),
                "participant_id": None,
                "participant_name": None,
            }

        for did in doc_focal_by_doc:
            d_segs = doc_segs_by_doc.get(did, [])
            seq_index = {seg.id: idx for idx, seg in enumerate(d_segs)}

            segments_out = []
            for seg_id in doc_focal_by_doc[did]:
                idx = seq_index.get(seg_id)
                if idx is None:
                    continue
                seg = d_segs[idx]

                preceding = []
                for ci in range(max(0, idx - context_size), idx):
                    preceding.append(doc_seg_to_context(d_segs[ci]))

                following = []
                for ci in range(idx + 1, min(len(d_segs), idx + context_size + 1)):
                    following.append(doc_seg_to_context(d_segs[ci]))

                focal = doc_seg_to_focal(seg)
                focal["preceding_context"] = preceding
                focal["following_context"] = following
                segments_out.append(focal)

            doc_results.append({
                "document_id": did,
                "document_name": doc_names.get(did, "Unknown"),
                "segment_count": len(segments_out),
                "segments": segments_out,
            })

    # ── Observation clips (D25) ──
    obs_app_query = (
        db.query(CodeApplication.segment_id, Segment.observation_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            CodeApplication.code_id == code_id,
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if observation_ids:
        obs_app_query = obs_app_query.filter(Segment.observation_id.in_(observation_ids))
    obs_app_query = _coder_filter(obs_app_query, coder_ids, layer_scope)
    obs_app_query = obs_app_query.order_by(Segment.observation_id, Segment.sequence_order)
    # #491: distinct-segment grain (see the conversation branch above).
    seen_clip_ids: set[int] = set()
    all_obs_apps = [
        (sid, oid) for sid, oid in obs_app_query.all()
        if not (sid in seen_clip_ids or seen_clip_ids.add(sid))
    ]

    obs_total_clips = len(all_obs_apps)
    # Same simple-pagination posture as documents (no shared pagination).
    obs_paged_apps = all_obs_apps[:limit]

    obs_focal_by_obs: dict[int, list[int]] = defaultdict(list)
    obs_focal_seg_ids = set()
    obs_ids_needed = set()
    for seg_id, oid in obs_paged_apps:
        obs_focal_by_obs[oid].append(seg_id)
        obs_focal_seg_ids.add(seg_id)
        obs_ids_needed.add(oid)

    obs_results = []
    if obs_ids_needed:
        obs_all_segments = (
            db.query(Segment)
            .filter(
                Segment.observation_id.in_(obs_ids_needed),
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
            .order_by(Segment.observation_id, Segment.sequence_order)
            .all()
        )

        obs_segs_by_obs: dict[int, list] = defaultdict(list)
        for seg in obs_all_segments:
            obs_segs_by_obs[seg.observation_id].append(seg)

        obs_focal_codes = (
            db.query(CodeApplication.segment_id, CodeApplication.code_id)
            .filter(
                CodeApplication.segment_id.in_(obs_focal_seg_ids),
                layer_origin_filter(layer_scope),
            )
            .distinct()
            .all()
        )
        obs_codes_by_seg: dict[int, list[int]] = defaultdict(list)
        for seg_id, cid in obs_focal_codes:
            obs_codes_by_seg[seg_id].append(cid)

        # ONE query answers both "is this clip quoted?" and "where are its
        # sub-clip quotes?" (slab 5c). It already read these rows and threw the
        # ranges away; keeping them is what lets the card show a quote's range
        # without a second round-trip — and `list_quoted_excerpts`, the only
        # alternative source, has no observation_ids param to scope it with.
        obs_quoted_seg_ids: set[int] = set()
        obs_quote_ranges: dict[int, list[dict]] = {}
        if obs_focal_seg_ids:
            for sid, q_start, q_end in db.query(
                Excerpt.segment_id, Excerpt.start_time, Excerpt.end_time,
            ).filter(
                Excerpt.segment_id.in_(obs_focal_seg_ids),
                segment_has_any_quote_filter(),
            ).all():
                obs_quoted_seg_ids.add(sid)
                # A WHOLE-clip quote has no range of its own — it is the clip.
                # Only sub-clip time ranges get a row, so the card can say
                # "quoted 1:05.0–1:12.4" without lying about a whole-clip quote.
                if q_start is not None:
                    obs_quote_ranges.setdefault(sid, []).append(
                        {"start_time": q_start, "end_time": q_end}
                    )

        obs_name_rows = db.query(
            Observation.id, Observation.name, Observation.media_duration_seconds
        ).filter(
            Observation.id.in_(obs_ids_needed)
        ).all()
        obs_names = {oid: oname for oid, oname, _ in obs_name_rows}
        # The occurrence-strip denominator (slab 5, D31). Nullable — pre-#574
        # .mov/.webm rows hold NULL; the client degrades to max clip end.
        obs_durations = {oid: dur for oid, _, dur in obs_name_rows}

        def clip_to_context(seg) -> dict:
            return {
                "id": seg.id,
                "sequence_order": seg.sequence_order,
                "speaker_name": None,
                "speaker_color_index": 0,
                "speaker_color": None,
                "is_facilitator": False,
                "text": seg.text,  # the clip's LABEL ("" = unlabeled)
                "start_time": seg.start_time,
            }

        def clip_to_focal(seg) -> dict:
            return {
                "id": seg.id,
                "sequence_order": seg.sequence_order,
                "speaker_name": None,
                "speaker_color_index": 0,
                "speaker_color": None,
                "is_facilitator": False,
                "text": seg.text,  # the clip's LABEL ("" = unlabeled)
                "start_time": seg.start_time,
                "end_time": seg.end_time,  # clips only — the timecode RANGE
                "is_quoted": seg.id in obs_quoted_seg_ids,
                "quote_ranges": obs_quote_ranges.get(seg.id, []),
                "applied_code_ids": obs_codes_by_seg.get(seg.id, []),
                "participant_id": None,
                "participant_name": None,
            }

        for oid in obs_focal_by_obs:
            o_segs = obs_segs_by_obs.get(oid, [])
            seq_index = {seg.id: idx for idx, seg in enumerate(o_segs)}

            segments_out = []
            for seg_id in obs_focal_by_obs[oid]:
                idx = seq_index.get(seg_id)
                if idx is None:
                    continue
                seg = o_segs[idx]

                preceding = []
                for ci in range(max(0, idx - context_size), idx):
                    preceding.append(clip_to_context(o_segs[ci]))

                following = []
                for ci in range(idx + 1, min(len(o_segs), idx + context_size + 1)):
                    following.append(clip_to_context(o_segs[ci]))

                focal = clip_to_focal(seg)
                focal["preceding_context"] = preceding
                focal["following_context"] = following
                segments_out.append(focal)

            obs_results.append({
                "observation_id": oid,
                "observation_name": obs_names.get(oid, "Unknown"),
                "media_duration_seconds": obs_durations.get(oid),
                "segment_count": len(segments_out),
                "segments": segments_out,
            })

    return {
        "code_id": code.id,
        "code_name": code.name,
        "code_color": code.color,
        "category_name": code.category.name if code.category else None,
        # Clip-inclusive total (D25) — must agree with the frequencies count.
        "total_segments": total_segments + doc_total_segments + obs_total_clips,
        "has_more": has_more,
        "conversations": conversations,
        "documents": doc_results,
        "observations": obs_results,
    }


def get_demographic_filter_options(
    db: Session,
    project_id: int,
) -> dict:
    """Get available demographic filter options for a project.

    Returns demographic columns grouped by subtype, with distinct values
    and which participant IDs match each value. Also returns conversation list.
    """
    demo_cols = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
        )
        .all()
    )

    if not demo_cols:
        convs = (
            db.query(Conversation.id, Conversation.name)
            .filter(Conversation.project_id == project_id)
            .order_by(Conversation.name)
            .all()
        )
        return {
            "filters": [],
            "conversations": [{"id": c_id, "name": c_name} for c_id, c_name in convs],
        }

    linked_rows = (
        db.query(DatasetRow.id, DatasetRow.participant_id, DatasetRow.dataset_id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetRow.participant_id != None,
        )
        .all()
    )

    row_participant = {r.id: r.participant_id for r in linked_rows}
    row_dataset = {r.id: r.dataset_id for r in linked_rows}
    linked_row_ids = [r.id for r in linked_rows]

    demo_col_ids = [c.id for c in demo_cols]
    values = []
    if linked_row_ids and demo_col_ids:
        values = (
            db.query(
                DatasetValue.row_id,
                DatasetValue.column_id,
                DatasetValue.value_text,
            )
            .filter(
                DatasetValue.row_id.in_(linked_row_ids),
                DatasetValue.column_id.in_(demo_col_ids),
            )
            .all()
        )

    subtype_map: dict[str, dict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
    col_subtype = {c.id: (c.demographic_subtype or c.column_text) for c in demo_cols}
    col_dataset = {c.id: c.dataset_id for c in demo_cols}

    for row_id, col_id, val_text in values:
        if not val_text or not val_text.strip():
            continue
        subtype = col_subtype.get(col_id, "other")
        pid = row_participant.get(row_id)
        if pid is None:
            continue
        if col_dataset.get(col_id) != row_dataset.get(row_id):
            continue
        subtype_map[subtype][val_text.strip()].add(pid)

    participants_with_role = (
        db.query(Participant.id, Participant.role)
        .filter(
            Participant.project_id == project_id,
            Participant.role != None,
            Participant.role != "",
        )
        .all()
    )
    if participants_with_role:
        for pid, role in participants_with_role:
            subtype_map["role"][role].add(pid)

    filters = []
    subtype_order = sorted(subtype_map.keys(), key=lambda s: (0 if s == "role" else 1, s))
    for subtype in subtype_order:
        value_map = subtype_map[subtype]
        values_list = []
        # #496 / AC-4: filter dropdown values in numeric-aware order too.
        for val in order_value_labels(value_map.keys()):
            pids = sorted(value_map[val])
            values_list.append({
                "value": val,
                "participant_ids": pids,
                "count": len(pids),
            })
        filters.append({
            "subtype": subtype,
            "label": subtype.replace("_", " ").title(),
            "values": values_list,
        })

    convs = (
        db.query(Conversation.id, Conversation.name)
        .filter(Conversation.project_id == project_id)
        .order_by(Conversation.name)
        .all()
    )

    return {
        "filters": filters,
        "conversations": [{"id": c_id, "name": c_name} for c_id, c_name in convs],
    }


# ── Internal: conversation-based co-occurrence ───────────────────────────────

def _build_conversation_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from conversation segments."""
    query = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if exclude_facilitator:
        query = query.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        query = query.filter(Segment.conversation_id.in_(conversation_ids))
    if participant_ids:
        query = query.filter(Speaker.participant_id.in_(participant_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))
    query = _coder_filter(query, coder_ids, layer_scope)

    apps = query.all()

    segment_codes = defaultdict(set)
    for seg_id, code_id in apps:
        segment_codes[seg_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in segment_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(segment_codes)


def _build_comment_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from coded comments."""
    query = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if text_column_ids:
        query = query.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        query = query.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        query = query.filter(DatasetRow.participant_id.in_(participant_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))
    query = _coder_filter(query, coder_ids, layer_scope)

    apps = query.all()

    value_codes = defaultdict(set)
    for dv_id, code_id in apps:
        value_codes[dv_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in value_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(value_codes)


def _build_document_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from document segments."""
    query = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if document_ids:
        query = query.filter(Segment.document_id.in_(document_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))
    query = _coder_filter(query, coder_ids, layer_scope)

    apps = query.all()

    segment_codes = defaultdict(set)
    for seg_id, code_id in apps:
        segment_codes[seg_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in segment_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(segment_codes)


def _build_observation_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    observation_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> tuple[dict, int]:
    """Build co-occurrence matrix from observation clips (slab 4c — mirrors the
    document builder; a clip is a Segment, so the unit is the clip)."""
    query = (
        db.query(CodeApplication.segment_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )

    if observation_ids:
        query = query.filter(Segment.observation_id.in_(observation_ids))
    if code_ids:
        query = query.filter(CodeApplication.code_id.in_(code_ids))
    query = _coder_filter(query, coder_ids, layer_scope)

    apps = query.all()

    clip_codes = defaultdict(set)
    for seg_id, code_id in apps:
        clip_codes[seg_id].add(code_id)

    cooccur = defaultdict(int)
    for codes in clip_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(clip_codes)


def build_code_cooccurrence_matrix(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "conversations",
    text_column_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> tuple[dict, int, int, int, int]:
    """Returns (cooccur_dict, total_units, conv_total, text_total, doc_total).

    cooccur_dict: (code_id_a, code_id_b) -> count
    total_units: combined total across sources (incl. observation clips —
        clips ride the matrix + this total exactly the way documents do; there
        is deliberately no positional obs_total, matching the 5-tuple arity the
        export_helpers wrapper unpacks)
    conv_total: conversation segment count (0 if source != conversations/all)
    text_total: text-column count (0 if source != text/all)
    doc_total: document segment count (0 if source != conversations/all)
    """
    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    if source == "conversations":
        cooccur, conv_total = _build_conversation_cooccurrence(
            db, project_id, code_ids=code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=conversation_ids,
            participant_ids=participant_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        doc_cooccur, doc_total = _build_document_cooccurrence(
            db, project_id, code_ids=code_ids,
            document_ids=document_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        obs_cooccur, obs_total = _build_observation_cooccurrence(
            db, project_id, code_ids=code_ids,
            observation_ids=observation_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        # Merge conversation + document + observation
        merged = defaultdict(int)
        for k, v in cooccur.items():
            merged[k] += v
        for k, v in doc_cooccur.items():
            merged[k] += v
        for k, v in obs_cooccur.items():
            merged[k] += v
        return merged, conv_total + doc_total + obs_total, conv_total, 0, doc_total
    elif source == "text":
        cooccur, total = _build_comment_cooccurrence(
            db, project_id, code_ids=code_ids,
            participant_ids=participant_ids,
            text_column_ids=text_column_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        return cooccur, total, 0, total, 0
    else:  # "all"
        conv_cooccur, conv_total = _build_conversation_cooccurrence(
            db, project_id, code_ids=code_ids,
            exclude_facilitator=exclude_facilitator,
            conversation_ids=conversation_ids,
            participant_ids=participant_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        comment_cooccur, comment_total = _build_comment_cooccurrence(
            db, project_id, code_ids=code_ids,
            participant_ids=participant_ids,
            text_column_ids=text_column_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        doc_cooccur, doc_total = _build_document_cooccurrence(
            db, project_id, code_ids=code_ids,
            document_ids=document_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        obs_cooccur, obs_total = _build_observation_cooccurrence(
            db, project_id, code_ids=code_ids,
            observation_ids=observation_ids,
            coder_ids=coder_ids,
            layer_scope=layer_scope,
        )
        # Merge
        merged = defaultdict(int)
        for k, v in conv_cooccur.items():
            merged[k] += v
        for k, v in comment_cooccur.items():
            merged[k] += v
        for k, v in doc_cooccur.items():
            merged[k] += v
        for k, v in obs_cooccur.items():
            merged[k] += v
        return merged, conv_total + comment_total + doc_total + obs_total, conv_total, comment_total, doc_total


def get_coded_comments_with_context(
    db: Session,
    project_id: int,
    code_id: int,
    participant_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    limit: int = 200,
    offset: int = 0,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict | None:
    """Get coded texts for a specific code, grouped by dataset.

    Returns texts (DatasetValues) that have CodeApplications for the given code,
    including record info, dataset/column names, and all applied code IDs.
    """
    code = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.id == code_id, Code.project_id == project_id)
        .first()
    )
    if not code:
        return None

    # Find all dataset_value_ids with this code applied
    app_query = (
        db.query(CodeApplication.dataset_value_id)
        .filter(
            CodeApplication.dataset_value_id.isnot(None),
            CodeApplication.code_id == code_id,
        )
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )

    if text_column_ids:
        app_query = app_query.filter(DatasetValue.column_id.in_(text_column_ids))

    if participant_ids:
        app_query = (
            app_query
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(DatasetRow.participant_id.in_(participant_ids))
        )
    app_query = _coder_filter(app_query, coder_ids, layer_scope)

    # #491: application grain → distinct-value grain. The rendered list already
    # deduped, so the header total ("N comments") and the Load-more arithmetic
    # overcounted multi-coder values.
    seen_dv_ids: set[int] = set()
    all_dv_ids = [
        row[0] for row in app_query.order_by(CodeApplication.dataset_value_id).all()
        if not (row[0] in seen_dv_ids or seen_dv_ids.add(row[0]))
    ]
    total_texts = len(all_dv_ids)
    paged_dv_ids = all_dv_ids[offset:offset + limit]
    has_more = (offset + limit) < total_texts

    if not paged_dv_ids:
        return {
            "code_id": code.id,
            "code_name": code.name,
            "code_color": code.color,
            "category_name": code.category.name if code.category else None,
            "total_texts": total_texts,
            "has_more": has_more,
            "datasets": [],
        }

    # Load full DatasetValue + joins for paged IDs
    values = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetValue.row_id,
            DatasetColumn.id.label("col_id"),
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetValue.id.in_(paged_dv_ids))
        .all()
    )

    # Get row identifiers via DatasetRow → Participant
    row_ids = list({v.row_id for v in values if v.row_id})
    row_map: dict[int, str | None] = {}
    if row_ids:
        rows = (
            db.query(DatasetRow.id, DatasetRow.row_identifier, Participant.identifier, Participant.display_name)
            .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
            .filter(DatasetRow.id.in_(row_ids))
            .all()
        )
        for r_id, row_ident, p_ident, dname in rows:
            row_map[r_id] = dname or p_ident or row_ident

    # Get all code applications for these dataset_values — layer-scoped + per-coder
    # de-duped (see the conversation focal_codes note; #447 / #441 class).
    all_apps = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(
            CodeApplication.dataset_value_id.in_(paged_dv_ids),
            layer_origin_filter(layer_scope),
        )
        .distinct()
        .all()
    )
    codes_by_dv: dict[int, list[int]] = defaultdict(list)
    for dv_id, cid in all_apps:
        codes_by_dv[dv_id].append(cid)

    # Group by dataset
    ds_groups: dict[int, dict] = {}
    for v in values:
        text = v.value_text or ""
        word_count = len(text.split()) if text.strip() else 0
        col_display = v.column_name or v.column_text or f"Column {v.col_id}"

        if v.ds_id not in ds_groups:
            ds_groups[v.ds_id] = {
                "dataset_id": v.ds_id,
                "dataset_name": v.ds_name,
                "texts": [],
            }

        ds_groups[v.ds_id]["texts"].append({
            "dataset_value_id": v.id,
            "value_text": text,
            "word_count": word_count,
            "row_identifier": row_map.get(v.row_id),
            "dataset_name": v.ds_name,
            "column_name": col_display,
            "applied_code_ids": codes_by_dv.get(v.id, []),
        })

    datasets = []
    for ds in ds_groups.values():
        ds["text_count"] = len(ds["texts"])
        datasets.append(ds)

    return {
        "code_id": code.id,
        "code_name": code.name,
        "code_color": code.color,
        "category_name": code.category.name if code.category else None,
        "total_texts": total_texts,
        "has_more": has_more,
        "datasets": datasets,
    }


def _get_ordered_codes(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
) -> list:
    """Get active codes ordered by universal → numeric_id, optionally filtered."""
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids:
        code_id_set = set(code_ids)
        all_codes = [c for c in all_codes if c.id in code_id_set]
    return all_codes


def _build_cooccurrence_response(
    cooccur: dict,
    all_codes: list,
    total_coded_segments: int,
    total_coded_texts: int,
    source: str,
) -> dict:
    """Build the structured co-occurrence response from raw cooccurrence data and code list."""
    codes_info = []
    for c in all_codes:
        codes_info.append({
            "id": c.id,
            "name": c.name,
            "color": c.color,
            "category_name": c.category.name if c.category else None,
            "category_color": c.category.color if c.category else None,
            "is_universal": c.is_universal,
        })

    matrix = []
    max_cooccurrence = 0
    for i, row_code in enumerate(all_codes):
        row = []
        for j, col_code in enumerate(all_codes):
            count = cooccur.get((row_code.id, col_code.id), 0)
            row.append(count)
            if i != j and count > max_cooccurrence:
                max_cooccurrence = count
        matrix.append(row)

    return {
        "codes": codes_info,
        "matrix": matrix,
        "max_cooccurrence": max_cooccurrence,
        "total_coded_segments": total_coded_segments,
        "total_coded_texts": total_coded_texts,
        "source": source,
    }


def get_code_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "conversations",
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> dict:
    """Build a structured co-occurrence matrix with code metadata."""
    cooccur, _total, total_coded_segments, total_coded_texts, _doc_total = build_code_cooccurrence_matrix(
        db, project_id,
        code_ids=code_ids,
        exclude_facilitator=exclude_facilitator,
        conversation_ids=conversation_ids,
        participant_ids=participant_ids,
        source=source,
        document_ids=document_ids,
        coder_ids=coder_ids,
        layer_scope=layer_scope,
        observation_ids=observation_ids,
    )

    all_codes = _get_ordered_codes(db, project_id, code_ids)

    return _build_cooccurrence_response(
        cooccur, all_codes, total_coded_segments, total_coded_texts, source,
    )


# ── Participant → demographic group mapping ───────────────────────────────

def _build_participant_group_map(
    db: Session,
    project_id: int,
    subtype: str,
) -> dict[int, str]:
    """Map participant_id → demographic group value for the given subtype.

    Reuses the same linkage logic as get_demographic_filter_options().

    #598: dataset-sourced values apply the #384 missing rule — a "Decline to
    state" respondent must not form a comparison / Compare-By group here
    while every quantitative surface folds them into the missing bucket.
    Participant-keyed (not row-keyed), so this applies the rule in place
    rather than routing through ``grouping.load_grouping_values``. #592: the
    rule is column-aware (a declared ``missing_values`` list wins).
    """
    # Check participant.role first if subtype == "role".
    # Deliberately EXEMPT from the N/A rule: role is a curated participant
    # field the researcher typed, not a survey answer (#598).
    mapping: dict[int, str] = {}
    if subtype == "role":
        rows = (
            db.query(Participant.id, Participant.role)
            .filter(
                Participant.project_id == project_id,
                Participant.role != None,
                Participant.role != "",
            )
            .all()
        )
        for pid, role in rows:
            mapping[pid] = role

    # Overlay dataset-based demographics
    demo_cols = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
        )
        .all()
    )
    target_cols = [
        c for c in demo_cols
        if (c.demographic_subtype or c.column_text) == subtype
    ]
    if not target_cols:
        return mapping

    target_col_ids = [c.id for c in target_cols]
    col_dataset = {c.id: c.dataset_id for c in target_cols}
    # #592: column-aware missing rules (None = the _is_na defaults)
    rules_by_col = {c.id: column_missing_rules(c) for c in target_cols}

    linked_rows = (
        db.query(DatasetRow.id, DatasetRow.participant_id, DatasetRow.dataset_id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetRow.participant_id != None,
        )
        .all()
    )
    row_participant = {r.id: r.participant_id for r in linked_rows}
    row_dataset = {r.id: r.dataset_id for r in linked_rows}
    linked_row_ids = [r.id for r in linked_rows]

    if linked_row_ids and target_col_ids:
        values = (
            db.query(DatasetValue.row_id, DatasetValue.column_id, DatasetValue.value_text)
            .filter(
                DatasetValue.row_id.in_(linked_row_ids),
                DatasetValue.column_id.in_(target_col_ids),
            )
            .all()
        )
        for row_id, col_id, val_text in values:
            if not val_text or not val_text.strip():
                continue
            if is_missing(val_text, rules_by_col.get(col_id)):
                # missing never defines a group (#598; #592: column-aware)
                continue
            pid = row_participant.get(row_id)
            if pid is None:
                continue
            if col_dataset.get(col_id) != row_dataset.get(row_id):
                continue
            mapping[pid] = val_text.strip()

    return mapping


# ── Source Frequencies ────────────────────────────────────────────────────

def _compute_source_groups(
    db: Session,
    project_id: int,
    part_group_map: dict[int, str],
    effective_id_expr,
    universal_ids: set[int],
    exclude_facilitator: bool,
    conv_ids_filter: set[int] | None,
    text_column_ids: list[int] | None,
    participant_ids: list[int] | None,
    code_ids: list[int] | None,
    coder_ids: list[int] | None,
    layer_scope: str | None,
) -> tuple[dict, dict]:
    """Per-(source, demographic group) breakdowns for the Compare-By grouped
    bar chart (#498 — `sources[].groups` was hard-coded None while the UI
    offered the control, so a grouping request silently rendered ungrouped).

    A unit joins a group through its participant (conversation segments via
    Speaker.participant_id, text responses via DatasetRow.participant_id);
    units without a mapped participant belong to no group, and documents have
    no participant spine so document sources keep groups=None. Semantics
    mirror the flat per-source queries: totals = visible (non-empty) units,
    coded = distinct units with ≥1 non-universal application (human layer),
    code_counts = distinct units per code (or per effective category).
    """
    pids = list(part_group_map.keys())

    def _bucket():
        return {
            "code_counts": defaultdict(lambda: [0, 0]),
            "total_segments": 0,
            "total_word_count": 0,
            "coded_segments": 0,
        }

    conv_groups: dict[int, dict[str, dict]] = defaultdict(lambda: defaultdict(_bucket))
    col_groups: dict[int, dict[str, dict]] = defaultdict(lambda: defaultdict(_bucket))

    # ── conversation totals per (conversation, group) ──
    q = (
        db.query(
            Segment.conversation_id,
            Speaker.participant_id,
            func.count(Segment.id),
            func.coalesce(func.sum(Segment.word_count), 0),
        )
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Speaker.participant_id.in_(pids),
        )
    )
    if exclude_facilitator:
        q = q.filter(Speaker.is_facilitator == 0)
    if conv_ids_filter is not None:
        q = q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        q = q.filter(Speaker.participant_id.in_(participant_ids))
    for conv_id, pid, cnt, wc in q.group_by(
        Segment.conversation_id, Speaker.participant_id
    ).all():
        b = conv_groups[conv_id][part_group_map[pid]]
        b["total_segments"] += cnt
        b["total_word_count"] += int(wc)

    # ── conversation application rows (distinct) → code_counts + coded ──
    # DISTINCT drops the per-coder duplication AND same-category sibling codes
    # (code_id is deliberately NOT selected — the category branch's rule).
    app_q = (
        db.query(
            Segment.conversation_id,
            Speaker.participant_id,
            effective_id_expr.label("eff_id"),
            Segment.id,
            Segment.word_count,
            Code.is_universal,
        )
        .select_from(CodeApplication)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Speaker.participant_id.in_(pids),
        )
    )
    if exclude_facilitator:
        app_q = app_q.filter(Speaker.is_facilitator == 0)
    if conv_ids_filter is not None:
        app_q = app_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        app_q = app_q.filter(Speaker.participant_id.in_(participant_ids))
    if code_ids is not None:
        app_q = app_q.filter(CodeApplication.code_id.in_(code_ids))
    app_q = _coder_filter(app_q, coder_ids, layer_scope)  # + J2-B consensus exclusion
    coded_seen: set[tuple] = set()
    for conv_id, pid, eff_id, seg_id, wc, is_universal in app_q.distinct().all():
        group = part_group_map[pid]
        b = conv_groups[conv_id][group]
        cc = b["code_counts"][eff_id]
        cc[0] += 1
        cc[1] += int(wc or 0)
        if not is_universal and (conv_id, group, seg_id) not in coded_seen:
            coded_seen.add((conv_id, group, seg_id))
            b["coded_segments"] += 1

    # ── text-column totals per (column, group) ──
    col_q = (
        db.query(
            DatasetValue.column_id,
            DatasetRow.participant_id,
            func.count(DatasetValue.id),
            func.coalesce(func.sum(DatasetValue.word_count), 0),
        )
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            DatasetValue.value_text != None,
            DatasetValue.value_text != "",
            DatasetRow.participant_id.in_(pids),
        )
    )
    if text_column_ids is not None:
        col_q = col_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        col_q = col_q.filter(DatasetRow.participant_id.in_(participant_ids))
    for col_id, pid, cnt, wc in col_q.group_by(
        DatasetValue.column_id, DatasetRow.participant_id
    ).all():
        b = col_groups[col_id][part_group_map[pid]]
        b["total_segments"] += cnt
        b["total_word_count"] += int(wc)

    # ── text-column application rows (distinct) → code_counts + coded ──
    col_app_q = (
        db.query(
            DatasetValue.column_id,
            DatasetRow.participant_id,
            effective_id_expr.label("eff_id"),
            DatasetValue.id,
            DatasetValue.word_count,
            Code.is_universal,
        )
        .select_from(CodeApplication)
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            DatasetRow.participant_id.in_(pids),
        )
    )
    if text_column_ids is not None:
        col_app_q = col_app_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        col_app_q = col_app_q.filter(DatasetRow.participant_id.in_(participant_ids))
    if code_ids is not None:
        col_app_q = col_app_q.filter(CodeApplication.code_id.in_(code_ids))
    col_app_q = _coder_filter(col_app_q, coder_ids, layer_scope)
    col_coded_seen: set[tuple] = set()
    for col_id, pid, eff_id, dv_id, wc, is_universal in col_app_q.distinct().all():
        group = part_group_map[pid]
        b = col_groups[col_id][group]
        cc = b["code_counts"][eff_id]
        cc[0] += 1
        cc[1] += int(wc or 0)
        if not is_universal and (col_id, group, dv_id) not in col_coded_seen:
            col_coded_seen.add((col_id, group, dv_id))
            b["coded_segments"] += 1

    return conv_groups, col_groups


def _shape_groups(group_data: dict[str, dict] | None) -> dict | None:
    """Serialize a _compute_source_groups bucket into the SourceGroupData wire
    shape (code_counts keyed by str id, matching the flat code_counts)."""
    if not group_data:
        return None
    return {
        group: {
            "total_segments": b["total_segments"],
            "total_word_count": b["total_word_count"],
            "coded_segments": b["coded_segments"],
            "code_counts": {
                str(eff): {"count": v[0], "word_count": v[1]}
                for eff, v in b["code_counts"].items()
            },
        }
        for group, b in group_data.items()
    }


def get_source_frequencies(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    conversation_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    participant_ids: list[int] | None = None,
    group_by_subtype: str | None = None,
    aggregation: str = "code",
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> dict:
    """Compute per-source, per-code frequencies with word counts.

    ⚠️ **#749 — this reads an empty id list DIFFERENTLY from its sibling
    `get_code_frequencies` (above, ~line 462). Read that one before changing
    this one.**

    Here the test is ``is not None``, so an empty list means **NONE of that
    kind** — the UI sends ``[]`` for kinds the researcher did not select.
    `get_code_frequencies` uses a truthy ``if <ids>:``, where the same ``[]``
    means **ALL of that kind**. Both readings are load-bearing for their own
    callers; the bug was never the disagreement, it was that #745 built ONE
    number out of both payloads and printed it beside a number from the other
    ([[feedback_two_halves_of_one_fact]]).

    This side is the one that can express a scoped selection exactly, which is
    why the summary table now sources BOTH its count and its percentage here.
    """

    # Load code metadata
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids is not None:
        code_id_set = set(code_ids)
        all_codes = [c for c in all_codes if c.id in code_id_set]

    # Build participant→group mapping if grouping requested
    part_group_map: dict[int, str] | None = None
    if group_by_subtype:
        part_group_map = _build_participant_group_map(db, project_id, group_by_subtype)

    # ── Conversations ──
    conversations = (
        db.query(Conversation.id, Conversation.name, Conversation.created_at)
        .filter(Conversation.project_id == project_id)
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
        .all()
    )
    conv_map = {c.id: (c.name, idx) for idx, c in enumerate(conversations)}
    conv_ids_filter = set(conversation_ids) if conversation_ids is not None else None

    # Per-conversation totals (visible segments)
    conv_totals_q = (
        db.query(
            Segment.conversation_id,
            func.count(Segment.id),
            func.coalesce(func.sum(Segment.word_count), 0),
        )
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        conv_totals_q = conv_totals_q.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conv_ids_filter is not None:
        conv_totals_q = conv_totals_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        conv_totals_q = conv_totals_q.filter(Speaker.participant_id.in_(participant_ids))
    conv_totals_q = conv_totals_q.group_by(Segment.conversation_id)
    conv_totals = {r[0]: (r[1], int(r[2])) for r in conv_totals_q.all()}

    # Per-conversation coded segment count (excluding universal codes)
    universal_ids = _get_universal_code_ids(db, project_id)

    conv_coded_q = (
        db.query(
            Segment.conversation_id,
            func.count(func.distinct(CodeApplication.segment_id)),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        conv_coded_q = conv_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if exclude_facilitator:
        conv_coded_q = conv_coded_q.filter(
            (Speaker.is_facilitator == 0) | (Speaker.id == None)
        )
    if conv_ids_filter is not None:
        conv_coded_q = conv_coded_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        conv_coded_q = conv_coded_q.filter(Speaker.participant_id.in_(participant_ids))
    conv_coded_q = _coder_filter(conv_coded_q, coder_ids, layer_scope)
    conv_coded_q = conv_coded_q.group_by(Segment.conversation_id)
    conv_coded = {r[0]: r[1] for r in conv_coded_q.all()}

    # ── Per-code or per-category count queries ──
    if aggregation == "category":
        # Group codes by category; uncategorized codes become pseudo-categories
        cat_groups: dict[int, list[int]] = defaultdict(list)
        cat_meta: dict[int, dict] = {}
        for c in all_codes:
            eff_cat_id = c.category_id if c.category_id else -c.id
            cat_groups[eff_cat_id].append(c.id)
            if eff_cat_id not in cat_meta:
                if c.category_id and c.category:
                    cat_meta[eff_cat_id] = {"name": c.category.name, "color": c.category.color or c.color}
                else:
                    cat_meta[eff_cat_id] = {"name": c.name, "color": c.color}

        codes_info = [
            {
                "id": cat_id,
                "name": meta["name"],
                "color": meta["color"],
                "category_id": cat_id if cat_id > 0 else None,
                "category_name": meta["name"] if cat_id > 0 else None,
                "category_color": None,
                "is_universal": False,
                "numeric_id": idx,
            }
            for idx, (cat_id, meta) in enumerate(cat_meta.items())
        ]

        # Effective category ID expression for SQL — the module-level fold, so
        # the per-source counts below and the cross-source counts further down
        # key their rows identically.
        effective_cat_id = _EFFECTIVE_CAT_ID

        # Conversation category counts: DISTINCT segments per category per conversation
        conv_cat_subq = (
            db.query(
                Segment.conversation_id.label("conv_id"),
                effective_cat_id.label("eff_cat_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            conv_cat_subq = conv_cat_subq.filter(
                (Speaker.is_facilitator == 0) | (Speaker.id == None)
            )
        if conv_ids_filter is not None:
            conv_cat_subq = conv_cat_subq.filter(Segment.conversation_id.in_(conv_ids_filter))
        if participant_ids:
            conv_cat_subq = conv_cat_subq.filter(Speaker.participant_id.in_(participant_ids))
        if code_ids is not None:
            conv_cat_subq = conv_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        conv_cat_subq = _coder_filter(conv_cat_subq, coder_ids, layer_scope)
        conv_cat_subq = conv_cat_subq.distinct().subquery()

        conv_cat_agg = (
            db.query(
                conv_cat_subq.c.conv_id,
                conv_cat_subq.c.eff_cat_id,
                func.count(conv_cat_subq.c.seg_id),
                func.coalesce(func.sum(conv_cat_subq.c.wc), 0),
            )
            .group_by(conv_cat_subq.c.conv_id, conv_cat_subq.c.eff_cat_id)
            .all()
        )

        conv_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for conv_id, cat_id, cnt, wc in conv_cat_agg:
            conv_code_counts[conv_id][cat_id] = (cnt, int(wc))

        # Comment column category counts: DISTINCT responses per category per column
        col_cat_subq = (
            db.query(
                DatasetValue.column_id.label("col_id"),
                effective_cat_id.label("eff_cat_id"),
                DatasetValue.id.label("dv_id"),
                DatasetValue.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if text_column_ids is not None:
            col_cat_subq = col_cat_subq.filter(DatasetValue.column_id.in_(text_column_ids))
        if participant_ids:
            col_cat_subq = col_cat_subq.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            col_cat_subq = col_cat_subq.filter(DatasetRow.participant_id.in_(participant_ids))
        if code_ids is not None:
            col_cat_subq = col_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        col_cat_subq = _coder_filter(col_cat_subq, coder_ids, layer_scope)
        col_cat_subq = col_cat_subq.distinct().subquery()

        col_cat_agg = (
            db.query(
                col_cat_subq.c.col_id,
                col_cat_subq.c.eff_cat_id,
                func.count(col_cat_subq.c.dv_id),
                func.coalesce(func.sum(col_cat_subq.c.wc), 0),
            )
            .group_by(col_cat_subq.c.col_id, col_cat_subq.c.eff_cat_id)
            .all()
        )

        col_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for col_id, cat_id, cnt, wc in col_cat_agg:
            col_code_counts[col_id][cat_id] = (cnt, int(wc))

    else:
        # Default: per-code aggregation
        codes_info = [
            {
                "id": c.id,
                "name": c.name,
                "color": c.color,
                "category_id": c.category_id,
                "category_name": c.category.name if c.category else None,
                "category_color": c.category.color if c.category else None,
                "is_universal": c.is_universal,
                "numeric_id": c.numeric_id,
            }
            for c in all_codes
        ]

        # Per-conversation, per-code counts + word_count. Track J · J2: dedupe to
        # DISTINCT (conv, code, segment) in a subquery BEFORE counting/summing —
        # under per-coder layers two coders on one segment are two rows, which
        # would otherwise inflate BOTH the count AND the word_count sum. Mirrors
        # the category-mode subquery above. (_coder_filter applies the J2-B
        # consensus exclusion.)
        conv_code_subq = (
            db.query(
                Segment.conversation_id.label("conv_id"),
                CodeApplication.code_id.label("code_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            conv_code_subq = conv_code_subq.filter(
                (Speaker.is_facilitator == 0) | (Speaker.id == None)
            )
        if conv_ids_filter is not None:
            conv_code_subq = conv_code_subq.filter(Segment.conversation_id.in_(conv_ids_filter))
        if participant_ids:
            conv_code_subq = conv_code_subq.filter(Speaker.participant_id.in_(participant_ids))
        if code_ids is not None:
            conv_code_subq = conv_code_subq.filter(CodeApplication.code_id.in_(code_ids))
        conv_code_subq = _coder_filter(conv_code_subq, coder_ids, layer_scope)  # + J2-B consensus exclusion
        conv_code_subq = conv_code_subq.distinct().subquery()

        conv_code_agg = (
            db.query(
                conv_code_subq.c.conv_id,
                conv_code_subq.c.code_id,
                func.count(conv_code_subq.c.seg_id),
                func.coalesce(func.sum(conv_code_subq.c.wc), 0),
            )
            .group_by(conv_code_subq.c.conv_id, conv_code_subq.c.code_id)
            .all()
        )

        conv_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for conv_id, code_id, cnt, wc in conv_code_agg:
            conv_code_counts[conv_id][code_id] = (cnt, int(wc))

        # Per-column, per-code counts + word_count. Track J · J2: DISTINCT
        # (column, code, dataset_value) before count/sum — see the conversation
        # block above. Mirrors the category-mode column subquery.
        col_code_subq = (
            db.query(
                DatasetValue.column_id.label("col_id"),
                CodeApplication.code_id.label("code_id"),
                DatasetValue.id.label("dv_id"),
                DatasetValue.word_count.label("wc"),
            )
            .filter(CodeApplication.dataset_value_id.isnot(None))
            .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if text_column_ids is not None:
            col_code_subq = col_code_subq.filter(DatasetValue.column_id.in_(text_column_ids))
        if participant_ids:
            col_code_subq = col_code_subq.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            col_code_subq = col_code_subq.filter(DatasetRow.participant_id.in_(participant_ids))
        if code_ids is not None:
            col_code_subq = col_code_subq.filter(CodeApplication.code_id.in_(code_ids))
        col_code_subq = _coder_filter(col_code_subq, coder_ids, layer_scope)  # + J2-B consensus exclusion
        col_code_subq = col_code_subq.distinct().subquery()

        col_code_agg = (
            db.query(
                col_code_subq.c.col_id,
                col_code_subq.c.code_id,
                func.count(col_code_subq.c.dv_id),
                func.coalesce(func.sum(col_code_subq.c.wc), 0),
            )
            .group_by(col_code_subq.c.col_id, col_code_subq.c.code_id)
            .all()
        )

        col_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for col_id, code_id, cnt, wc in col_code_agg:
            col_code_counts[col_id][code_id] = (cnt, int(wc))

    # ── Cross-source distinct counts: participants and records (#749) ──
    #
    # These two grains CANNOT be derived from the per-source counts above, and
    # that is the whole reason they ride the payload instead of being summed on
    # the client: a participant speaks in several conversations and one record
    # can be coded in several text columns, so adding per-source counts
    # double-counts the same person and the same row. Everything else the
    # summary table renders IS a per-source roll-up and is derived client-side.
    #
    # `group_expr` is the same fold the per-source queries use, so a category
    # row's participant count is the participants who have ANY code in that
    # category — not the sum over its codes, which would double-count anyone
    # coded twice inside one category.
    group_expr = _EFFECTIVE_CAT_ID if aggregation == "category" else CodeApplication.code_id

    part_by_code_q = (
        db.query(group_expr.label("gid"), func.count(func.distinct(Speaker.participant_id)))
        .select_from(CodeApplication)
        .join(Code, Code.id == CodeApplication.code_id)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Speaker.participant_id != None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conv_ids_filter is not None:
        part_by_code_q = part_by_code_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        part_by_code_q = part_by_code_q.filter(Speaker.participant_id.in_(participant_ids))
    if code_ids is not None:
        part_by_code_q = part_by_code_q.filter(CodeApplication.code_id.in_(code_ids))
    part_by_code_q = _coder_filter(part_by_code_q, coder_ids, layer_scope)
    part_by_code = {r[0]: r[1] for r in part_by_code_q.group_by(group_expr).all()}

    rec_by_code_q = (
        db.query(group_expr.label("gid"), func.count(func.distinct(DatasetValue.row_id)))
        .select_from(CodeApplication)
        .join(Code, Code.id == CodeApplication.code_id)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            CodeApplication.dataset_value_id.isnot(None),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if text_column_ids is not None:
        rec_by_code_q = rec_by_code_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        rec_by_code_q = rec_by_code_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        rec_by_code_q = rec_by_code_q.filter(DatasetRow.participant_id.in_(participant_ids))
    if code_ids is not None:
        rec_by_code_q = rec_by_code_q.filter(CodeApplication.code_id.in_(code_ids))
    rec_by_code_q = _coder_filter(rec_by_code_q, coder_ids, layer_scope)
    rec_by_code = {r[0]: r[1] for r in rec_by_code_q.group_by(group_expr).all()}

    # Their denominators. Both are "how many of these exist in the SELECTION",
    # not "how many carry any coding" — the per-code numerator above is a subset
    # of exactly this set, which is what makes the percentage a share rather
    # than a ratio of two differently-scoped counts (the #745 shape).
    total_part_q = (
        db.query(func.count(func.distinct(Speaker.participant_id)))
        .select_from(Segment)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Speaker.participant_id != None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conv_ids_filter is not None:
        total_part_q = total_part_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    if participant_ids:
        total_part_q = total_part_q.filter(Speaker.participant_id.in_(participant_ids))
    total_participants = total_part_q.scalar() or 0

    # Speakers never linked to a participant. They are excluded from the
    # participant counts above (the `participant_id != None` filter), so the
    # table says how many are unaccounted for rather than silently absorbing
    # them. A participant filter makes the question moot — an unlinked speaker
    # cannot match a participant id — hence the 0.
    unlinked_q = (
        db.query(func.count(func.distinct(Speaker.id)))
        .select_from(CodeApplication)
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .join(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Speaker.participant_id == None,
            Speaker.is_facilitator == 0,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if conv_ids_filter is not None:
        unlinked_q = unlinked_q.filter(Segment.conversation_id.in_(conv_ids_filter))
    unlinked_q = _coder_filter(unlinked_q, coder_ids, layer_scope)
    unlinked_speaker_count = 0 if participant_ids else (unlinked_q.scalar() or 0)

    total_rec_q = (
        db.query(func.count(func.distinct(DatasetValue.row_id)))
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            DatasetValue.value_text != None,
            DatasetValue.value_text != "",
        )
    )
    if text_column_ids is not None:
        total_rec_q = total_rec_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        total_rec_q = total_rec_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        total_rec_q = total_rec_q.filter(DatasetRow.participant_id.in_(participant_ids))
    total_records = total_rec_q.scalar() or 0

    for _c in codes_info:
        _c["participant_count"] = part_by_code.get(_c["id"], 0)
        _c["record_count"] = rec_by_code.get(_c["id"], 0)

    # ── Documents ──
    documents = (
        db.query(Document.id, Document.name, Document.created_at)
        .filter(Document.project_id == project_id)
        .order_by(Document.created_at.asc(), Document.id.asc())
        .all()
    )
    doc_map = {d.id: (d.name, idx) for idx, d in enumerate(documents)}
    doc_ids_filter = set(document_ids) if document_ids is not None else None

    # Per-document totals (visible segments)
    doc_totals_q = (
        db.query(
            Segment.document_id,
            func.count(Segment.id),
            func.coalesce(func.sum(Segment.word_count), 0),
        )
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Segment.document_id.isnot(None),
        )
    )
    if doc_ids_filter is not None:
        doc_totals_q = doc_totals_q.filter(Segment.document_id.in_(doc_ids_filter))
    doc_totals_q = doc_totals_q.group_by(Segment.document_id)
    doc_totals = {r[0]: (r[1], int(r[2])) for r in doc_totals_q.all()}

    # Per-document coded segment count
    doc_coded_q = (
        db.query(
            Segment.document_id,
            func.count(func.distinct(CodeApplication.segment_id)),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        doc_coded_q = doc_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if doc_ids_filter is not None:
        doc_coded_q = doc_coded_q.filter(Segment.document_id.in_(doc_ids_filter))
    doc_coded_q = _coder_filter(doc_coded_q, coder_ids, layer_scope)
    doc_coded_q = doc_coded_q.group_by(Segment.document_id)
    doc_coded = {r[0]: r[1] for r in doc_coded_q.all()}

    # Per-document, per-code counts
    if aggregation == "category":
        doc_cat_subq = (
            db.query(
                Segment.document_id.label("doc_id"),
                effective_cat_id.label("eff_cat_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if doc_ids_filter is not None:
            doc_cat_subq = doc_cat_subq.filter(Segment.document_id.in_(doc_ids_filter))
        if code_ids is not None:
            doc_cat_subq = doc_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        doc_cat_subq = _coder_filter(doc_cat_subq, coder_ids, layer_scope)
        doc_cat_subq = doc_cat_subq.distinct().subquery()

        doc_cat_agg = (
            db.query(
                doc_cat_subq.c.doc_id,
                doc_cat_subq.c.eff_cat_id,
                func.count(doc_cat_subq.c.seg_id),
                func.coalesce(func.sum(doc_cat_subq.c.wc), 0),
            )
            .group_by(doc_cat_subq.c.doc_id, doc_cat_subq.c.eff_cat_id)
            .all()
        )

        doc_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for doc_id, cat_id, cnt, wc in doc_cat_agg:
            doc_code_counts[doc_id][cat_id] = (cnt, int(wc))
    else:
        # Track J · J2: DISTINCT (document, code, segment) before count/sum — see
        # the conversation block above. Mirrors the category-mode document subquery.
        doc_code_subq = (
            db.query(
                Segment.document_id.label("doc_id"),
                CodeApplication.code_id.label("code_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if doc_ids_filter is not None:
            doc_code_subq = doc_code_subq.filter(Segment.document_id.in_(doc_ids_filter))
        if code_ids is not None:
            doc_code_subq = doc_code_subq.filter(CodeApplication.code_id.in_(code_ids))
        doc_code_subq = _coder_filter(doc_code_subq, coder_ids, layer_scope)  # + J2-B consensus exclusion
        doc_code_subq = doc_code_subq.distinct().subquery()

        doc_code_agg = (
            db.query(
                doc_code_subq.c.doc_id,
                doc_code_subq.c.code_id,
                func.count(doc_code_subq.c.seg_id),
                func.coalesce(func.sum(doc_code_subq.c.wc), 0),
            )
            .group_by(doc_code_subq.c.doc_id, doc_code_subq.c.code_id)
            .all()
        )

        doc_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for doc_id, code_id, cnt, wc in doc_code_agg:
            doc_code_counts[doc_id][code_id] = (cnt, int(wc))

    # ── Observations (slab 4c — the document posture: no speaker/participant
    # spine, so no facilitator filter and groups stay None; a clip's
    # word_count is its LABEL's, deliberately, so word metrics stay honest) ──
    observations = (
        db.query(Observation.id, Observation.name, Observation.created_at)
        .filter(Observation.project_id == project_id)
        .order_by(Observation.created_at.asc(), Observation.id.asc())
        .all()
    )
    obs_map = {o.id: (o.name, idx) for idx, o in enumerate(observations)}
    obs_ids_filter = set(observation_ids) if observation_ids is not None else None

    # Per-observation totals (visible clips)
    obs_totals_q = (
        db.query(
            Segment.observation_id,
            func.count(Segment.id),
            func.coalesce(func.sum(Segment.word_count), 0),
        )
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            Segment.observation_id.isnot(None),
        )
    )
    if obs_ids_filter is not None:
        obs_totals_q = obs_totals_q.filter(Segment.observation_id.in_(obs_ids_filter))
    obs_totals_q = obs_totals_q.group_by(Segment.observation_id)
    obs_totals = {r[0]: (r[1], int(r[2])) for r in obs_totals_q.all()}

    # Per-observation coded clip count
    obs_coded_q = (
        db.query(
            Segment.observation_id,
            func.count(func.distinct(CodeApplication.segment_id)),
        )
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if universal_ids:
        obs_coded_q = obs_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if obs_ids_filter is not None:
        obs_coded_q = obs_coded_q.filter(Segment.observation_id.in_(obs_ids_filter))
    obs_coded_q = _coder_filter(obs_coded_q, coder_ids, layer_scope)
    obs_coded_q = obs_coded_q.group_by(Segment.observation_id)
    obs_coded = {r[0]: r[1] for r in obs_coded_q.all()}

    # Per-observation, per-code counts
    if aggregation == "category":
        obs_cat_subq = (
            db.query(
                Segment.observation_id.label("obs_id"),
                effective_cat_id.label("eff_cat_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .join(CodeApplication, CodeApplication.segment_id == Segment.id)
            .join(Code, Code.id == CodeApplication.code_id)
            .join(Observation, Segment.observation_id == Observation.id)
            .filter(
                Observation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if obs_ids_filter is not None:
            obs_cat_subq = obs_cat_subq.filter(Segment.observation_id.in_(obs_ids_filter))
        if code_ids is not None:
            obs_cat_subq = obs_cat_subq.filter(CodeApplication.code_id.in_(code_ids))
        obs_cat_subq = _coder_filter(obs_cat_subq, coder_ids, layer_scope)
        obs_cat_subq = obs_cat_subq.distinct().subquery()

        obs_cat_agg = (
            db.query(
                obs_cat_subq.c.obs_id,
                obs_cat_subq.c.eff_cat_id,
                func.count(obs_cat_subq.c.seg_id),
                func.coalesce(func.sum(obs_cat_subq.c.wc), 0),
            )
            .group_by(obs_cat_subq.c.obs_id, obs_cat_subq.c.eff_cat_id)
            .all()
        )

        obs_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for obs_id, cat_id, cnt, wc in obs_cat_agg:
            obs_code_counts[obs_id][cat_id] = (cnt, int(wc))
    else:
        # Track J · J2: DISTINCT (observation, code, segment) before count/sum.
        obs_code_subq = (
            db.query(
                Segment.observation_id.label("obs_id"),
                CodeApplication.code_id.label("code_id"),
                Segment.id.label("seg_id"),
                Segment.word_count.label("wc"),
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Observation, Segment.observation_id == Observation.id)
            .filter(
                Observation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if obs_ids_filter is not None:
            obs_code_subq = obs_code_subq.filter(Segment.observation_id.in_(obs_ids_filter))
        if code_ids is not None:
            obs_code_subq = obs_code_subq.filter(CodeApplication.code_id.in_(code_ids))
        obs_code_subq = _coder_filter(obs_code_subq, coder_ids, layer_scope)  # + J2-B consensus exclusion
        obs_code_subq = obs_code_subq.distinct().subquery()

        obs_code_agg = (
            db.query(
                obs_code_subq.c.obs_id,
                obs_code_subq.c.code_id,
                func.count(obs_code_subq.c.seg_id),
                func.coalesce(func.sum(obs_code_subq.c.wc), 0),
            )
            .group_by(obs_code_subq.c.obs_id, obs_code_subq.c.code_id)
            .all()
        )

        obs_code_counts: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
        for obs_id, code_id, cnt, wc in obs_code_agg:
            obs_code_counts[obs_id][code_id] = (cnt, int(wc))

    # Per-column totals
    col_totals_q = (
        db.query(
            DatasetValue.column_id,
            func.count(DatasetValue.id),
            func.coalesce(func.sum(DatasetValue.word_count), 0),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            DatasetValue.value_text != None,
            DatasetValue.value_text != "",
        )
    )
    if text_column_ids is not None:
        col_totals_q = col_totals_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        col_totals_q = col_totals_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        col_totals_q = col_totals_q.filter(DatasetRow.participant_id.in_(participant_ids))
    col_totals_q = col_totals_q.group_by(DatasetValue.column_id)
    col_totals = {r[0]: (r[1], int(r[2])) for r in col_totals_q.all()}

    # Per-column coded count
    col_coded_q = (
        db.query(
            DatasetValue.column_id,
            func.count(func.distinct(CodeApplication.dataset_value_id)),
        )
        .filter(CodeApplication.dataset_value_id.isnot(None))
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
    )
    if universal_ids:
        col_coded_q = col_coded_q.filter(~CodeApplication.code_id.in_(universal_ids))
    if text_column_ids is not None:
        col_coded_q = col_coded_q.filter(DatasetValue.column_id.in_(text_column_ids))
    if participant_ids:
        col_coded_q = col_coded_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        col_coded_q = col_coded_q.filter(DatasetRow.participant_id.in_(participant_ids))
    col_coded_q = _coder_filter(col_coded_q, coder_ids, layer_scope)
    col_coded_q = col_coded_q.group_by(DatasetValue.column_id)
    col_coded = {r[0]: r[1] for r in col_coded_q.all()}

    # Column metadata
    comment_cols = (
        db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text, Dataset.id.label("ds_id"), Dataset.name.label("ds_name"))
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
        .all()
    )
    col_meta = {c.id: c for c in comment_cols}

    # ── Assemble sources ──
    # ── Per-group breakdowns (#498) — only when a demographic mapping exists ──
    conv_groups: dict = {}
    col_groups: dict = {}
    if part_group_map:
        effective_id_expr = (
            sa_case(
                (Code.category_id.isnot(None), Code.category_id),
                else_=(-1 * Code.id),
            )
            if aggregation == "category"
            else Code.id
        )
        conv_groups, col_groups = _compute_source_groups(
            db,
            project_id,
            part_group_map,
            effective_id_expr,
            set(universal_ids),
            exclude_facilitator,
            conv_ids_filter,
            text_column_ids,
            participant_ids,
            code_ids,
            coder_ids,
            layer_scope,
        )

    sources = []
    total_segs = 0
    total_wc = 0
    total_coded = 0
    # `total_coded` pools segments and texts because several charts want one
    # "coded units" denominator. The summary table wants them apart: a % of
    # coded TEXTS computed over a denominator that also counted transcript
    # segments is the #745 shape with different nouns. Split here, at the one
    # place that knows which kind each source is, rather than asking the client
    # to re-derive it from `source_type`.
    total_coded_segments = 0
    total_coded_texts = 0
    conv_count = 0
    doc_count = 0
    obs_count = 0
    col_count = 0

    for conv_id, (conv_name, import_order) in conv_map.items():
        if conv_ids_filter is not None and conv_id not in conv_ids_filter:
            continue
        t_segs, t_wc = conv_totals.get(conv_id, (0, 0))
        coded = conv_coded.get(conv_id, 0)
        code_map = conv_code_counts.get(conv_id, {})

        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "conversation",
            "source_id": conv_id,
            "source_label": conv_name,
            "dataset_id": None,
            "dataset_name": None,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": import_order,
            # Flat counts stay populated even under grouping (#498): they are
            # the chart's fallback when no participants map to any group.
            "code_counts": cc,
            "groups": _shape_groups(conv_groups.get(conv_id)),
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        total_coded_segments += coded
        conv_count += 1

    for d_id, (doc_name, import_order) in doc_map.items():
        if doc_ids_filter is not None and d_id not in doc_ids_filter:
            continue
        t_segs, t_wc = doc_totals.get(d_id, (0, 0))
        coded = doc_coded.get(d_id, 0)
        code_map = doc_code_counts.get(d_id, {})

        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "document",
            "source_id": d_id,
            "source_label": doc_name,
            "dataset_id": None,
            "dataset_name": None,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": import_order,
            "code_counts": cc,
            # Documents have no participant spine — no demographic grouping.
            "groups": None,
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        total_coded_segments += coded
        doc_count += 1

    for o_id, (obs_name, import_order) in obs_map.items():
        if obs_ids_filter is not None and o_id not in obs_ids_filter:
            continue
        t_segs, t_wc = obs_totals.get(o_id, (0, 0))
        coded = obs_coded.get(o_id, 0)
        code_map = obs_code_counts.get(o_id, {})

        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "observation",
            "source_id": o_id,
            "source_label": obs_name,
            "dataset_id": None,
            "dataset_name": None,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": import_order,
            "code_counts": cc,
            # Observations have no participant spine — no demographic grouping
            # (the document posture; _compute_source_groups untouched).
            "groups": None,
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        total_coded_segments += coded
        obs_count += 1

    for col_id, meta in col_meta.items():
        if text_column_ids is not None and col_id not in text_column_ids:
            continue
        t_segs, t_wc = col_totals.get(col_id, (0, 0))
        coded = col_coded.get(col_id, 0)
        code_map = col_code_counts.get(col_id, {})

        label = meta.ds_name + " › " + (meta.column_name or meta.column_text[:60])
        cc = {
            str(c["id"]): {"count": code_map.get(c["id"], (0, 0))[0], "word_count": code_map.get(c["id"], (0, 0))[1]}
            for c in codes_info
            if c["id"] in code_map
        }

        sources.append({
            "source_type": "text_column",
            "source_id": col_id,
            "source_label": label,
            "dataset_id": meta.ds_id,
            "dataset_name": meta.ds_name,
            "total_segments": t_segs,
            "total_word_count": t_wc,
            "coded_segments": coded,
            "import_order": None,
            "code_counts": cc,
            "groups": _shape_groups(col_groups.get(col_id)),
        })
        total_segs += t_segs
        total_wc += t_wc
        total_coded += coded
        total_coded_texts += coded
        col_count += 1

    return {
        "codes": codes_info,
        "sources": sources,
        "totals": {
            "total_segments": total_segs,
            "total_word_count": total_wc,
            "coded_segments": total_coded,
            "total_sources": conv_count + doc_count + obs_count + col_count,
            "total_conversations": conv_count,
            "total_documents": doc_count,
            "total_observations": obs_count,
            "total_text_columns": col_count,
            # #749 — the summary table's remaining denominators. Every number it
            # renders now comes from this one response; it used to take its
            # per-kind columns from `get_code_frequencies`, which reads an
            # unselected kind as ALL of that kind, so a conversations-only
            # selection still counted every observation in the project.
            "coded_transcript_segments": total_coded_segments,
            "coded_texts": total_coded_texts,
            "total_participants": total_participants,
            "total_records": total_records,
            "unlinked_speaker_count": unlinked_speaker_count,
        },
        "group_by": group_by_subtype,
    }


# ── Source-Level Co-occurrence ────────────────────────────────────────────

def get_source_level_cooccurrence(
    db: Session,
    project_id: int,
    code_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    conversation_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    participant_ids: list[int] | None = None,
    source: str = "all",
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> tuple[dict, int]:
    """Build binary co-occurrence at source level (conversation, document, or column).

    Each source contributes at most 1 to each code pair.
    """
    # Backward-compat: legacy callers may still pass "comments"
    if source == "comments":
        source = "text"

    source_codes: dict[str, set[int]] = defaultdict(set)

    # Conversations
    if source in ("conversations", "all"):
        conv_q = (
            db.query(
                literal("conv").label("stype"),
                Segment.conversation_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if exclude_facilitator:
            conv_q = conv_q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conversation_ids:
            conv_q = conv_q.filter(Segment.conversation_id.in_(conversation_ids))
        if participant_ids:
            conv_q = conv_q.filter(Speaker.participant_id.in_(participant_ids))
        if code_ids:
            conv_q = conv_q.filter(CodeApplication.code_id.in_(code_ids))
        conv_q = _coder_filter(conv_q, coder_ids, layer_scope)
        for _, sid, cid in conv_q.all():
            source_codes[f"conv_{sid}"].add(cid)

        # Documents (segment-based, same source mode as conversations)
        doc_q = (
            db.query(
                literal("doc").label("stype"),
                Segment.document_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Document, Segment.document_id == Document.id)
            .filter(
                Document.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if document_ids:
            doc_q = doc_q.filter(Segment.document_id.in_(document_ids))
        if code_ids:
            doc_q = doc_q.filter(CodeApplication.code_id.in_(code_ids))
        doc_q = _coder_filter(doc_q, coder_ids, layer_scope)
        for _, sid, cid in doc_q.all():
            source_codes[f"doc_{sid}"].add(cid)

        # Observations (clip-based; the source unit is the OBSERVATION —
        # keyed obs_ per the established conv_/doc_/col_ convention)
        obs_q = (
            db.query(
                literal("obs").label("stype"),
                Segment.observation_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Observation, Segment.observation_id == Observation.id)
            .filter(
                Observation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
            )
        )
        if observation_ids:
            obs_q = obs_q.filter(Segment.observation_id.in_(observation_ids))
        if code_ids:
            obs_q = obs_q.filter(CodeApplication.code_id.in_(code_ids))
        obs_q = _coder_filter(obs_q, coder_ids, layer_scope)
        for _, sid, cid in obs_q.all():
            source_codes[f"obs_{sid}"].add(cid)

    # Text columns
    if source in ("text", "all"):
        col_q = (
            db.query(
                literal("col").label("stype"),
                DatasetValue.column_id.label("sid"),
                CodeApplication.code_id,
            )
            .filter(CodeApplication.dataset_value_id.isnot(None))
            .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
            )
        )
        if text_column_ids:
            col_q = col_q.filter(DatasetValue.column_id.in_(text_column_ids))
        if participant_ids:
            col_q = col_q.join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            col_q = col_q.filter(DatasetRow.participant_id.in_(participant_ids))
        if code_ids:
            col_q = col_q.filter(CodeApplication.code_id.in_(code_ids))
        col_q = _coder_filter(col_q, coder_ids, layer_scope)
        for _, sid, cid in col_q.all():
            source_codes[f"col_{sid}"].add(cid)

    cooccur: dict[tuple[int, int], int] = defaultdict(int)
    for codes in source_codes.values():
        for c in codes:
            cooccur[(c, c)] += 1
        for a, b in combinations(codes, 2):
            cooccur[(a, b)] += 1
            cooccur[(b, a)] += 1

    return cooccur, len(source_codes)


# ── Demographic Comparison ────────────────────────────────────────────────

def get_demographic_comparison(
    db: Session,
    project_id: int,
    group_by_subtype: str,
    code_ids: list[int] | None = None,
    conversation_ids: list[int] | None = None,
    text_column_ids: list[int] | None = None,
    exclude_facilitator: bool = True,
    participant_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """Compare code frequencies across demographic groups."""

    part_group = _build_participant_group_map(db, project_id, group_by_subtype)
    if not part_group:
        return {"groups": [], "group_totals": {}, "codes": []}

    # Filter to requested participants
    if participant_ids:
        part_group = {pid: g for pid, g in part_group.items() if pid in set(participant_ids)}

    # #496 / AC-4: numeric-aware label ordering — a plain sorted() put "10"
    # before "8" (the #406 class) in the comparison columns.
    groups = order_value_labels(set(part_group.values()))
    if len(groups) < 2:
        return {"groups": groups, "group_totals": {g: {"total_segments": 0, "total_word_count": 0} for g in groups}, "codes": []}

    # Group → participant IDs
    group_pids: dict[str, set[int]] = defaultdict(set)
    for pid, g in part_group.items():
        group_pids[g].add(pid)

    # Totals per group (conversation segments)
    group_seg_totals: dict[str, int] = defaultdict(int)
    group_wc_totals: dict[str, int] = defaultdict(int)

    for group, pids in group_pids.items():
        pid_list = list(pids)
        q = (
            db.query(
                func.count(Segment.id),
                func.coalesce(func.sum(Segment.word_count), 0),
            )
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
                Speaker.participant_id.in_(pid_list),
            )
        )
        if exclude_facilitator:
            q = q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conversation_ids:
            q = q.filter(Segment.conversation_id.in_(conversation_ids))
        result = q.first()
        group_seg_totals[group] = result[0] if result else 0
        group_wc_totals[group] = int(result[1]) if result else 0

    # Per-group, per-code counts
    group_code_counts: dict[str, dict[int, int]] = {g: defaultdict(int) for g in groups}

    for group, pids in group_pids.items():
        pid_list = list(pids)
        q = (
            # Track J · J2: distinct coded segments per code, not raw rows (a
            # segment coded by two coders is two rows). _coder_filter applies the
            # J2-B consensus exclusion.
            db.query(CodeApplication.code_id, func.count(func.distinct(CodeApplication.segment_id)))
            .filter(CodeApplication.segment_id.isnot(None))
            .join(Segment, CodeApplication.segment_id == Segment.id)
            .join(Conversation, Segment.conversation_id == Conversation.id)
            .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
            .filter(
                Conversation.project_id == project_id,
                Segment.merged_into_id == None,
                Segment.split_into_id == None,
                Speaker.participant_id.in_(pid_list),
            )
        )
        if exclude_facilitator:
            q = q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
        if conversation_ids:
            q = q.filter(Segment.conversation_id.in_(conversation_ids))
        if code_ids:
            q = q.filter(CodeApplication.code_id.in_(code_ids))
        q = _coder_filter(q, coder_ids, layer_scope)  # + J2-B consensus exclusion
        q = q.group_by(CodeApplication.code_id)

        for cid, cnt in q.all():
            group_code_counts[group][cid] = cnt

    # Load codes
    code_query = (
        db.query(Code)
        .outerjoin(CodeCategory, Code.category_id == CodeCategory.id)
        .options(contains_eager(Code.category))
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
    )
    all_codes = code_query.all()
    if code_ids:
        code_id_set = set(code_ids)
        all_codes = [c for c in all_codes if c.id in code_id_set]

    # Build comparison entries with statistical tests
    entries = []
    for code in all_codes:
        by_group = {}
        for g in groups:
            count = group_code_counts[g].get(code.id, 0)
            total = group_seg_totals[g]
            proportion = count / total if total > 0 else 0.0
            by_group[g] = {"count": count, "proportion": round(proportion, 4)}

        # Statistical test
        delta = None
        test_result = None

        if len(groups) == 2:
            g1, g2 = groups
            delta = round(by_group[g1]["proportion"] - by_group[g2]["proportion"], 4)
            # Fisher's exact test on 2x2 table
            a = by_group[g1]["count"]
            b = group_seg_totals[g1] - a
            c = by_group[g2]["count"]
            d = group_seg_totals[g2] - c
            if group_seg_totals[g1] > 0 and group_seg_totals[g2] > 0:
                try:
                    from scipy.stats import fisher_exact
                    _, p = fisher_exact([[a, b], [c, d]])
                    test_result = {
                        "method": "fisher_exact",
                        "statistic": None,
                        "p_value": round(p, 6),
                        "significant": p < 0.05,
                    }
                    # Odds ratio effect size
                    if b * c > 0:
                        odds_ratio = (a * d) / (b * c)
                        test_result["effect_size"] = round(odds_ratio, 4)
                        test_result["effect_size_label"] = "odds_ratio"
                except (ZeroDivisionError, ValueError, TypeError) as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "Fisher's exact test failed for code %s: %s", code.id, exc
                    )
        elif len(groups) >= 3:
            # Chi-square on kx2 table
            observed = []
            for g in groups:
                count = by_group[g]["count"]
                total = group_seg_totals[g]
                observed.append([count, total - count])
            # Check if any column totals are zero
            col_sums = [sum(row[i] for row in observed) for i in range(2)]
            if all(s > 0 for s in col_sums) and all(group_seg_totals[g] > 0 for g in groups):
                try:
                    from scipy.stats import chi2_contingency
                    import math
                    chi2, p, _, expected = chi2_contingency(observed)
                    # Check for small expected cells
                    method = "chi2"
                    if any(cell < 5 for row in expected for cell in row):
                        method = "chi2_small_expected"
                    test_result = {
                        "method": method,
                        "statistic": round(chi2, 4),
                        "p_value": round(p, 6),
                        "significant": p < 0.05,
                    }
                    # Cramér's V effect size (kx2 table: min dimension is 2, so k-1 = 1)
                    n_total = sum(group_seg_totals[g] for g in groups)
                    min_dim = min(len(observed), 2)  # rows=groups, cols=2 (coded/not)
                    if n_total > 0 and min_dim > 1:
                        cramers_v = math.sqrt(chi2 / (n_total * (min_dim - 1)))
                        test_result["effect_size"] = round(cramers_v, 4)
                        test_result["effect_size_label"] = "cramers_v"
                except (ZeroDivisionError, ValueError, TypeError) as exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "Chi-square test failed for code %s: %s", code.id, exc
                    )

        entries.append({
            "code_id": code.id,
            "code_name": code.name,
            "category_name": code.category.name if code.category else None,
            "by_group": by_group,
            "delta_proportion": delta,
            "test": test_result,
        })

    # Sort: by abs(delta) desc for 2 groups, by p-value asc for 3+
    if len(groups) == 2:
        entries.sort(key=lambda e: abs(e["delta_proportion"] or 0), reverse=True)
    else:
        entries.sort(key=lambda e: (e["test"]["p_value"] if e["test"] else 1.0))

    return {
        "groups": groups,
        "group_totals": {
            g: {"total_segments": group_seg_totals[g], "total_word_count": group_wc_totals[g]}
            for g in groups
        },
        "codes": entries,
    }


# ── Saturation ────────────────────────────────────────────────────────────

def get_saturation_data(
    db: Session,
    project_id: int,
    exclude_facilitator: bool = True,
    category_level: bool = False,
    conversation_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
    observation_ids: list[int] | None = None,
) -> dict:
    """Compute code saturation curve across conversations, documents, and
    observations in chronological (``created_at``) order — each source is one
    x-axis step, so a coded clip is invisible on the curve until its
    observation joins the interleave."""

    # Get conversations in chronological order
    conversations = (
        db.query(Conversation.id, Conversation.name, Conversation.created_at)
        .filter(Conversation.project_id == project_id)
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
        .all()
    )

    # Get documents in chronological order
    documents = (
        db.query(Document.id, Document.name, Document.created_at)
        .filter(Document.project_id == project_id)
        .order_by(Document.created_at.asc(), Document.id.asc())
        .all()
    )

    # Get observations in chronological order
    observations = (
        db.query(Observation.id, Observation.name, Observation.created_at)
        .filter(Observation.project_id == project_id)
        .order_by(Observation.created_at.asc(), Observation.id.asc())
        .all()
    )

    # Get all (conversation_id, code_id) pairs
    conv_q = (
        db.query(Segment.conversation_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Conversation, Segment.conversation_id == Conversation.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id)
        .filter(
            Conversation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if exclude_facilitator:
        conv_q = conv_q.filter((Speaker.is_facilitator == 0) | (Speaker.id == None))
    if conversation_ids:
        conv_q = conv_q.filter(Segment.conversation_id.in_(conversation_ids))
    conv_q = _coder_filter(conv_q, coder_ids, layer_scope)
    conv_code_pairs = conv_q.all()

    # Get all (document_id, code_id) pairs
    doc_q = (
        db.query(Segment.document_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Document, Segment.document_id == Document.id)
        .filter(
            Document.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if document_ids:
        doc_q = doc_q.filter(Segment.document_id.in_(document_ids))
    doc_q = _coder_filter(doc_q, coder_ids, layer_scope)
    doc_code_pairs = doc_q.all()

    # Get all (observation_id, code_id) pairs
    obs_q = (
        db.query(Segment.observation_id, CodeApplication.code_id)
        .filter(CodeApplication.segment_id.isnot(None))
        .join(Segment, CodeApplication.segment_id == Segment.id)
        .join(Observation, Segment.observation_id == Observation.id)
        .filter(
            Observation.project_id == project_id,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
        )
    )
    if observation_ids:
        obs_q = obs_q.filter(Segment.observation_id.in_(observation_ids))
    obs_q = _coder_filter(obs_q, coder_ids, layer_scope)
    obs_code_pairs = obs_q.all()

    # Build source → set of code_ids (or category_ids)
    source_items: dict[str, set] = defaultdict(set)

    if category_level:
        code_cats = dict(
            db.query(Code.id, Code.category_id)
            .filter(Code.project_id == project_id)
            .all()
        )
        cat_names = dict(
            db.query(CodeCategory.id, CodeCategory.name)
            .filter(CodeCategory.project_id == project_id)
            .all()
        )
        cat_names[-1] = "Uncategorized"

        for conv_id, code_id in conv_code_pairs:
            cat_id = code_cats.get(code_id) or -1
            source_items[f"conv_{conv_id}"].add(cat_id)
        for doc_id, code_id in doc_code_pairs:
            cat_id = code_cats.get(code_id) or -1
            source_items[f"doc_{doc_id}"].add(cat_id)
        for obs_id, code_id in obs_code_pairs:
            cat_id = code_cats.get(code_id) or -1
            source_items[f"obs_{obs_id}"].add(cat_id)

        item_names = cat_names
    else:
        # #508: no is_active filter — the pair queries above (correctly) count
        # inactive codes' applications, so the name map must cover them too or
        # the tooltip falls to the "Unknown (id)" placeholder.
        code_names = dict(
            db.query(Code.id, Code.name)
            .filter(Code.project_id == project_id)
            .all()
        )
        for conv_id, code_id in conv_code_pairs:
            source_items[f"conv_{conv_id}"].add(code_id)
        for doc_id, code_id in doc_code_pairs:
            source_items[f"doc_{doc_id}"].add(code_id)
        for obs_id, code_id in obs_code_pairs:
            source_items[f"obs_{obs_id}"].add(code_id)
        item_names = code_names

    # Interleave conversations, documents, and observations chronologically
    all_sources = []
    for c in conversations:
        if conversation_ids and c.id not in conversation_ids:
            continue
        all_sources.append(("conversation", c.id, c.name, c.created_at))
    for d in documents:
        if document_ids and d.id not in document_ids:
            continue
        all_sources.append(("document", d.id, d.name, d.created_at))
    for o in observations:
        if observation_ids and o.id not in observation_ids:
            continue
        all_sources.append(("observation", o.id, o.name, o.created_at))
    all_sources.sort(key=lambda x: (x[3], x[0], x[1]))

    # Build cumulative saturation curve. The key MAP (not a two-way ternary):
    # the old `conv if … else doc` shape would silently bucket a third source
    # kind as doc_{id} — the §8i "source-key ternary" trap.
    _KEY_PREFIX = {"conversation": "conv", "document": "doc", "observation": "obs"}
    seen: set = set()
    points = []
    for idx, (stype, sid, sname, _) in enumerate(all_sources):
        key = f"{_KEY_PREFIX[stype]}_{sid}"
        items = source_items.get(key, set())
        new_items = items - seen
        seen.update(new_items)
        new_names = [item_names.get(item_id, f"Unknown ({item_id})") for item_id in sorted(new_items)]

        points.append({
            "source_index": idx,
            "source_label": sname,
            "source_type": stype,
            "cumulative_unique_codes": len(seen),
            "new_codes_this_source": len(new_items),
            "new_code_names": new_names,
        })

    return {
        "points": points,
        "total_unique_codes": len(seen),
        "total_sources": len(all_sources),
        "category_level": category_level,
    }


# ── Comment Columns with Coding ──────────────────────────────────────────

def get_text_columns_with_coding(
    db: Session,
    project_id: int,
) -> list[dict]:
    """Get open-ended columns with their coded value counts (including 0)."""

    # Subquery: count distinct CODED VALUES per column. Track J · J2: distinct
    # dataset values (not application rows — two coders on one value are two
    # rows), excluding the consensus layer (J2-B) AND universal-only values
    # (#492 / invariant J-A — a lone "Unclear" must not make a value "coded";
    # this badge previously disagreed with the coding-progress gauge).
    coded_sub = (
        db.query(
            DatasetValue.column_id,
            func.count(func.distinct(CodeApplication.dataset_value_id)).label("coded_count"),
        )
        .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(Code, Code.id == CodeApplication.code_id)
        .filter(Code.is_universal == False, non_consensus_filter())
        .group_by(DatasetValue.column_id)
        .subquery()
    )

    results = (
        db.query(
            DatasetColumn.id.label("column_id"),
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.id.label("dataset_id"),
            Dataset.name.label("dataset_name"),
            func.coalesce(coded_sub.c.coded_count, 0).label("coded_count"),
        )
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .outerjoin(coded_sub, coded_sub.c.column_id == DatasetColumn.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT]),
        )
        .order_by(Dataset.name, DatasetColumn.display_order)
        .all()
    )

    return [
        {
            "column_id": r.column_id,
            "column_name": r.column_name,
            "column_text": r.column_text,
            "dataset_id": r.dataset_id,
            "dataset_name": r.dataset_name,
            "coded_count": r.coded_count,
        }
        for r in results
    ]
