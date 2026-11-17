"""What a joint display's pinned quotes are CHOSEN from and ATTRIBUTED by (D163, session B).

The display's numbers come from `joint_display.compute_joint_display`; its pins are quotes
(`POST …/excerpts/whole-passage`), carried on the node exactly as an `excerpt-embed`'s
attributes plus ``group`` and ``role`` (`joint_display_node.py`). Two reads serve them:

- **The suggestions (D209): one group's coded passages for one code.** D163's picker offers a
  group's OWN passages, so a quote cannot come from the wrong group. The group's members are
  read through the SAME map the numbers use (`code_analysis._participant_groups_by_column`,
  behind `grouping_column`'s eligibility gate), then the passages through the Content tab's own
  read (`code_analysis.get_segments_with_context`) narrowed to those people — interviewer turns
  out, the display's sources, the coder scope and layer, and the chips following the scope while
  blind (D102). Observations never: a clip links to no participant (D165), and the participant
  filter leaves every clip out by construction. ⚠️ The members are first narrowed to the people
  a SOURCE links — a speaker or a document — so the bound list is bounded by the project's
  speakers and documents, not by its participants (225,000 on D12, against 900 speakers): the
  participant filter binds its list (#960's open class, `sql-id-sets.md` §4).
- **The attribution facts (D210): what each pin's attribution is derived FROM, read live.**
  D163.4: a speaker's name or a site is never STORED on a pin — a new copy of a person's name is
  DI-03's class — so the display derives it at render from the live quote: the linked
  participant's identifier, the speaker's label, the source's name, and optionally the
  participant's value on one categorical column (e.g. School), named by `answer_label_resolver`
  through the same group map. The client chooses which to SHOW (the display's attribution
  setting); this read states the facts. A quote that is gone, or not this project's, is absent —
  which is what a withdrawal leaves (the scrub nulls a pin's `excerptId`).

Both endpoints are plain `def` (`routers/joint_display.py`): the group map is a read over every
cell of one column.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.document import Document
from ..models.excerpt import Excerpt, answer_source_name
from ..models.observation import Observation
from ..models.participant import Participant
from ..models.segment import Segment
from ..models.speaker import Speaker
from .code_analysis import (
    GroupingColumnError,
    _coder_filter,
    _participant_groups_by_column,
    get_segments_with_context,
    grouping_column,
)
from .coding_layers import project_scoped_segments
from .id_set import in_id_set
from .joint_display import code_strand_answer_columns
from .participant_scores import withheld_rating_columns_in_project
from .text_analysis import substantive_text_clause, treat_as_empty_for_project

#: How many pins one attribution read may name — a display's quotes, not a dump.
MAX_PIN_FACTS = 500


def _linked_participants(db: Session, project_id: int, *, conversations: bool,
                         documents: bool) -> set[int]:
    """The participants a speaker or a document of the project links — the code strand's people."""
    out: set[int] = set()
    if conversations:
        out.update(pid for (pid,) in db.query(Speaker.participant_id).filter(
            Speaker.project_id == project_id, Speaker.participant_id.isnot(None)))
    if documents:
        out.update(pid for (pid,) in db.query(Document.participant_id).filter(
            Document.project_id == project_id, Document.participant_id.isnot(None)))
    return out


def _nothing(code: Code) -> dict:
    """The passage list's answer when the group holds nobody the sources link."""
    return {
        "code_id": code.id,
        "code_name": code.name,
        "code_color": code.color,
        "category_name": code.category.name if code.category else None,
        "total_segments": 0,
        "conversation_total": 0,
        "document_total": 0,
        "observation_total": 0,
        "has_more": False,
        "conversations": [],
        "documents": [],
        "observations": [],
    }


def group_passages(
    db: Session,
    project_id: int,
    *,
    group_by_column_id: int,
    group: str,
    code_id: int,
    conversation_ids: list[int] | None,
    document_ids: list[int] | None,
    coder_ids: list[int] | None,
    layer_scope: str | None,
    chips_follow_coder_ids: bool,
    limit: int,
    offset: int,
    text_column_ids: list[int] | None = None,
) -> dict | None:
    """One group's passages coded ``code_id`` — the pin picker's suggestions (D209).

    None when the code is not this project's. Raises `GroupingColumnError` for a grouping
    column the display could not have computed with. A source list reads as the display's
    does: None = every source of the kind, ``[]`` = none (#1297's rule) — EXCEPT
    ``text_column_ids`` (slice 2, r4-1), where None and ``[]`` are both none
    (`joint_display.code_strand_answer_columns`).
    """
    code = db.query(Code).filter(Code.id == code_id, Code.project_id == project_id).first()
    if code is None:
        return None
    # #1615: the display's scope is the blind one (D175), so a rating-derived grouping refuses.
    column = grouping_column(db, project_id, group_by_column_id, blind_scope=coder_ids)
    members = {pid for pid, g in _participant_groups_by_column(db, column).items() if g == group}
    # Joint display slice 2 (r4-1): the group's coded ANSWERS in the display's columns —
    # through the one door the counts use, so a suggestion is a passage the numbers count.
    answer_columns, _ = code_strand_answer_columns(db, project_id, text_column_ids)
    answer_total, answers = _group_answers(
        db, project_id, members=members, code_id=code_id, columns=answer_columns,
        coder_ids=coder_ids, layer_scope=layer_scope, limit=limit, offset=offset)
    want_conversations = conversation_ids != []
    want_documents = document_ids != []
    ids = sorted(members & _linked_participants(
        db, project_id, conversations=want_conversations, documents=want_documents))
    # 🔴 An EMPTY participant list is "no filter" to the read below, so a group holding
    # nobody the sources link must answer here — never fall through with [].
    if not ids:
        return _with_answers(_nothing(code), answer_total, answers, limit=limit, offset=offset)
    result = get_segments_with_context(
        db,
        project_id,
        code_id=code_id,
        context_size=1,
        exclude_facilitator=True,
        conversation_ids=conversation_ids or None,
        participant_ids=ids,
        limit=limit,
        offset=offset,
        document_ids=document_ids or None,
        coder_ids=coder_ids,
        layer_scope=layer_scope,
        chips_follow_coder_ids=chips_follow_coder_ids,
    )
    if result is None:
        return None
    # A kind the display says NONE of: its arm is read (the read has no "none") and dropped.
    if not want_conversations:
        result["conversations"] = []
        result["conversation_total"] = 0
    if not want_documents:
        result["documents"] = []
        result["document_total"] = 0
    # The participant filter leaves every clip out; said here so the totals cannot disagree.
    result["observations"] = []
    result["observation_total"] = 0
    return _with_answers(result, answer_total, answers, limit=limit, offset=offset)


def _with_answers(result: dict, answer_total: int, answers: list[dict], *,
                  limit: int, offset: int) -> dict:
    """The passage list's totals with the answers in (slice 2, r4-1) — ONE place, both exits."""
    result["answer_total"] = answer_total
    result["answers"] = answers
    result["total_segments"] = (result["conversation_total"] + result["document_total"]
                                + answer_total)
    result["has_more"] = (offset + limit) < max(result["conversation_total"],
                                                result["document_total"], answer_total)
    return result


def _group_answers(
    db: Session,
    project_id: int,
    *,
    members: set[int],
    code_id: int,
    columns: list[int],
    coder_ids: list[int] | None,
    layer_scope: str | None,
    limit: int,
    offset: int,
) -> tuple[int, list[dict]]:
    """One group's coded open-text answers (slice 2, r4-1) — ``(total, this page)``.

    The gather's own answer scope (`code_analysis.gather_participant_codes`' ``_scope_text``):
    an OPEN_TEXT column of this project, a row linked to a participant, and a SUBSTANTIVE
    value — the project's `treat_as_empty` through `substantive_text_clause` (#519/#1526),
    so an "N/A" somebody coded is never suggested, as it is never counted. The coder scope
    and layer are the counts' (`_coder_filter`). Group membership is applied in PYTHON, never
    as an id list into SQL (`sql-id-sets.md` §6: a group can hold most of the project); the
    SQL is bounded by the code and at most `MAX_IDS_PER_STRAND` columns. Order: the answer's
    id (import order), so paging is stable.
    """
    if not columns or not members:
        return 0, []
    tae = treat_as_empty_for_project(db, project_id)
    query = (
        db.query(DatasetValue.id, DatasetRow.participant_id)
        .select_from(CodeApplication)
        .join(DatasetValue, CodeApplication.dataset_value_id == DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type == ColumnType.OPEN_TEXT,
            CodeApplication.code_id == code_id,
            DatasetValue.column_id.in_(columns),
            DatasetRow.participant_id.isnot(None),
            substantive_text_clause(tae),
        )
    )
    hits = sorted({(dv, pid) for dv, pid in _coder_filter(query, coder_ids, layer_scope).distinct()
                   if pid in members})
    page = hits[offset:offset + limit]
    if not page:
        return len(hits), []
    page_ids = [dv for dv, _ in page]
    detail = {
        dv: (text, cid, cname, ctext, dsname)
        for dv, text, cid, cname, ctext, dsname in db.query(
            DatasetValue.id, DatasetValue.value_text, DatasetColumn.id,
            DatasetColumn.column_name, DatasetColumn.column_text, Dataset.name,
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetValue.id.in_(page_ids))
    }
    people = {pid for _, pid in page}
    names = {pid: (dname or ident) for pid, dname, ident in db.query(
        Participant.id, Participant.display_name, Participant.identifier,
    ).filter(Participant.project_id == project_id, Participant.id.in_(sorted(people)))}
    # The WHOLE quote of an answer (offsets NULL) — the one `whole-passage` returns.
    quoted = {dv for (dv,) in db.query(Excerpt.dataset_value_id).filter(
        Excerpt.project_id == project_id, Excerpt.dataset_value_id.in_(page_ids),
        Excerpt.start_offset.is_(None))}
    out = []
    for dv, pid in page:
        text, cid, cname, ctext, dsname = detail[dv]
        out.append({
            "dataset_value_id": dv,
            "text": text or "",
            "column_id": cid,
            "source_name": answer_source_name(dsname, cname or ctext),
            "participant_id": pid,
            "participant_name": names.get(pid),
            "is_quoted": dv in quoted,
        })
    return len(hits), out


def attribution_column_withheld(db: Session, project_id: int, column_id: int | None,
                                coder_ids) -> bool:
    """#1615: is the attribution column one a blind reader must not see a value of?"""
    return column_id is not None and column_id in withheld_rating_columns_in_project(
        db, project_id, coder_ids)


#: #1653 (D346) — why the *Also show* variable (the attribution column) could not be read: it is
#: not in this project (deleted, or an import did not bring it), or it can no longer name a
#: participant's category (retyped). The pins keep who said it and where; only the value goes,
#: and `pin-facts` says why (`column_unusable`), as it says a withheld one (D286).
PIN_ATTRIBUTION_GONE = "gone"
PIN_ATTRIBUTION_INELIGIBLE = "ineligible"


def _attribution_column(
    db: Session, project_id: int, column_id: int | None, coder_ids,
) -> tuple[DatasetColumn | None, str | None, str | None]:
    """The attribution column to read values from, or why it cannot be — ``(column, reason,
    name)``. ``(None, None, None)`` for no column or a withheld one (D286 is said apart).

    `grouping_column` is the eligibility gate, so a column the comparison would refuse is
    refused here too; its 404 is "gone", its 400 "ineligible" (#1653, D346). Any other refusal
    is not this decision's, and propagates as before.
    """
    if column_id is None or attribution_column_withheld(db, project_id, column_id, coder_ids):
        return None, None, None
    try:
        return grouping_column(db, project_id, column_id, blind_scope=coder_ids), None, None
    except GroupingColumnError as exc:
        if exc.status_code == 404:
            return None, PIN_ATTRIBUTION_GONE, None
        if exc.status_code == 400:
            # A 400 means `grouping_column` FOUND the column in this project (its query is
            # project-scoped) and refused its type — so the name read needs no second gate.
            column = db.get(DatasetColumn, column_id)
            return None, PIN_ATTRIBUTION_INELIGIBLE, (column.column_name or column.column_text)
        raise


def attribution_column_unusable(
    db: Session, project_id: int, column_id: int | None, coder_ids,
) -> tuple[str | None, str | None]:
    """#1653 (D346): ``(reason, name)`` when the attribution column cannot be read — the reason
    `PIN_ATTRIBUTION_GONE` (no name: there is none to read) or `PIN_ATTRIBUTION_INELIGIBLE`
    (with the variable's name) — else ``(None, None)``."""
    _, reason, name = _attribution_column(db, project_id, column_id, coder_ids)
    return reason, name


#: Joint display slice 2 (r4-4, R8): what KIND of source a pinned quote comes from — the
#: client's `pinAttribution` labels a survey answer as one ("Survey answer (Dataset ›
#: Column)"), an inference a reader cannot make from a "Dataset › Column" name (L3).
PIN_SOURCE_CONVERSATION = "conversation"
PIN_SOURCE_DOCUMENT = "document"
PIN_SOURCE_OBSERVATION = "observation"
PIN_SOURCE_ANSWER = "answer"


def pin_facts(
    db: Session,
    project_id: int,
    *,
    excerpt_ids: list[int],
    column_id: int | None,
    coder_ids,
) -> list[dict]:
    """For each live quote of this project in ``excerpt_ids``: what its attribution is made of (D210).

    A quote not found (deleted, withdrawn, another project's) is absent.

    #1615: ``coder_ids`` is REQUIRED (the display's blind scope, D175). A column worked out
    from participant scores is NOT refused here — the rest of the attribution (who said it,
    where) is provenance and stays — its value is left out of every pin instead, and the
    caller says so (`attribution_column_withheld`).

    #1653 (D346): the same for a ``column_id`` that is gone or can no longer form groups — it
    raised `GroupingColumnError`, and the whole read failed, so every pin lost who said it and
    where with the value. The caller says why (`attribution_column_unusable`).
    """
    ids = sorted({i for i in excerpt_ids if isinstance(i, int) and not isinstance(i, bool)})
    if not ids:
        return []
    values: dict[int, str] = {}
    column, _, _ = _attribution_column(db, project_id, column_id, coder_ids)
    if column is not None:
        values = _participant_groups_by_column(db, column)
    rows = project_scoped_segments(
        db.query(
            Excerpt.id,
            Speaker.name,
            Speaker.participant_id,
            Document.participant_id,
            Conversation.name,
            Document.name,
            Observation.name,
        )
        .join(Segment, Excerpt.segment_id == Segment.id)
        .outerjoin(Speaker, Segment.speaker_id == Speaker.id),
        project_id,
    ).filter(in_id_set(Excerpt.id, ids)).all()
    # Joint display slice 2 (r4-3): a quote of an ANSWER — no segment, so the read above
    # cannot see it (D210's "absent" note). Its person is its row's participant, its source
    # "Dataset › Column" (the quote's own `source_name`), and it has no speaker. It rides the
    # document passage's slots below (a person with no speaker, a named source).
    answer_quotes: set[int] = set()
    for eid, row_pid, dsname, cname, ctext in (
        db.query(Excerpt.id, DatasetRow.participant_id, Dataset.name,
                 DatasetColumn.column_name, DatasetColumn.column_text)
        .join(DatasetValue, Excerpt.dataset_value_id == DatasetValue.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(Excerpt.project_id == project_id, Dataset.project_id == project_id,
                in_id_set(Excerpt.id, ids))
    ):
        rows.append((eid, None, None, row_pid, None, answer_source_name(dsname, cname or ctext),
                     None))
        answer_quotes.add(eid)
    people = {pid for _, _, sp, dp, *_ in rows for pid in (sp, dp) if pid is not None}
    identifiers = dict(
        db.query(Participant.id, Participant.identifier)
        .filter(Participant.project_id == project_id, in_id_set(Participant.id, people))
    ) if people else {}
    out = []
    for eid, speaker_name, speaker_pid, document_pid, conv_name, doc_name, obs_name in rows:
        participant_id = speaker_pid if speaker_pid is not None else document_pid
        if participant_id not in identifiers:
            participant_id = None
        out.append({
            "excerpt_id": eid,
            "participant_id": participant_id,
            "participant_identifier": identifiers.get(participant_id),
            "speaker_label": speaker_name,
            "source_name": conv_name or doc_name or obs_name or "",
            # R8 (r4-4): the source's kind — an answer rides the document slots above, so it
            # is decided by where its row came from, never by which name is set.
            "source_kind": (PIN_SOURCE_ANSWER if eid in answer_quotes
                            else PIN_SOURCE_CONVERSATION if conv_name is not None
                            else PIN_SOURCE_DOCUMENT if doc_name is not None
                            else PIN_SOURCE_OBSERVATION if obs_name is not None else None),
            "column_value": values.get(participant_id) if participant_id is not None else None,
        })
    out.sort(key=lambda f: f["excerpt_id"])
    return out
