"""Which passages a participant (demographic) filter keeps — ONE rule for every reader (#1536,
D116–D118, 1.5.9).

The analysis page's *Filters* turn chosen demographic values into a list of participant ids
(`QualFilterBar`), sent as ``participant_ids`` to every qualitative read. A passage counts under
that list only when it reaches one of those participants through ITS OWN KIND's link:

  turn      — its speaker's participant           ``Speaker.participant_id``
  answer    — its record's participant            ``DatasetRow.participant_id``
  document  — the person the document is about    ``Document.participant_id`` (row 46)
  clip      — nothing: an ``Observation`` names no participant (structural — the resolver's
              ``observation_clip``), so every clip is LEFT OUT while a filter is on (D117)

A passage linked to no one counts under no filter (``NULL IN (…)`` is false) — already true of
turns and answers before #1536. This is the reading the code-by-group comparison has had since
#1297/#1298 (1.5.9). Before #1536 the other readers applied the turn and answer links only, so
every document and every clip counted under every filter (a Group-X person's document under
"Group = Y"), and the Quote Board — the turn clause over an OUTER join to ``Speaker`` — dropped
every document quote and clip, including the filtered person's own document.

**No filter** is ``None`` OR an empty list: the readers' long-standing truthiness. The client
never sends an empty list (the page sends nothing when no value is chosen).

⚠️ **A new reader of ``participant_ids`` calls this module** —
``tests/test_participant_filter_1536.py`` fails a function in ``app/`` that takes the list and
spells a participant link of its own.

⚠️ The list is a bound ``.in_()``, exactly as the readers spelled it before — #960's population
(the internal design notes). This is now the one place to convert it.
"""

from sqlalchemy import false, or_

from ..models.dataset import DatasetRow
from ..models.document import Document
from ..models.speaker import Speaker

TURN = "turn"
ANSWER = "answer"
DOCUMENT = "document"
CLIP = "clip"
PASSAGE_KINDS = (TURN, ANSWER, DOCUMENT, CLIP)


def participant_clause(kind: str, participant_ids: list[int] | None):
    """The clause keeping ``kind``'s passages that reach ``participant_ids``; ``None`` = no filter.

    The caller's query must already join the kind's link table — ``Speaker`` for a turn,
    ``DatasetRow`` for an answer, ``Document`` for a document. A clip has none, so its clause is
    ``false()``: the query returns no clip.
    """
    if kind not in PASSAGE_KINDS:
        raise ValueError(f"unknown passage kind: {kind!r}")
    if not participant_ids:
        return None
    if kind == TURN:
        return Speaker.participant_id.in_(participant_ids)
    if kind == ANSWER:
        return DatasetRow.participant_id.in_(participant_ids)
    if kind == DOCUMENT:
        return Document.participant_id.in_(participant_ids)
    return false()


def narrow_to_participants(query, kind: str, participant_ids: list[int] | None):
    """``query`` narrowed to ``kind``'s passages that reach ``participant_ids`` (unchanged when
    there is no filter)."""
    clause = participant_clause(kind, participant_ids)
    return query if clause is None else query.filter(clause)


def segment_passage_clause(participant_ids: list[int] | None):
    """For a query over ``Segment`` rows of EVERY parent (the Quote Board, the Segments CSV): a turn
    by its speaker, a document passage by its document, a clip never. ``None`` = no filter.

    The query must OUTER-join ``Speaker`` (on ``Segment.speaker_id``) and ``Document`` (on
    ``Segment.document_id``) — an inner join would drop the kinds the other link serves. Each arm
    can match only its own kind with no parent test: a document passage and a clip have no
    speaker, and a turn and a clip no document, so the other arm's column is NULL there.
    """
    turn = participant_clause(TURN, participant_ids)
    if turn is None:
        return None
    return or_(turn, participant_clause(DOCUMENT, participant_ids))


# ── What a FILE says while the filter is on (#1545, 1.6.0) ───────────────────────────────────────
#
# A file the filter narrows says so on its scope line, as the coder and layer scope already did
# (#499/#512): two files exported with and without "Group = Y" had the same first line and the
# same name, and only the numbers differed. The words are the client's — the panel's rule line,
# `frontend/src/lib/participant-filter.ts::PARTICIPANT_FILTER_RULE`, and its twin builder
# `participantFilterScopeBit` — so a file and the screen say one thing.

#: The panel's rule line, word for word; `tests/test_participant_filter_files_1545.py` pins the
#: two languages equal.
PARTICIPANT_FILTER_RULE = (
    "Counts what is linked to the selected participants: interview turns by speaker, documents by "
    "the person each is linked to, and survey answers by record. Observations have no participant "
    "link, so their clips are left out."
)


def participant_filter_scope_bit(participant_ids: list[int] | None, label: str | None = None) -> str | None:
    """The scope line's participant part — ``participant filter: Group: Y (12 participants)`` —
    or ``None`` with no filter.

    ``label`` is the panel's description of the chosen values (`describeFilterValues`), sent by the
    client as ``participant_filter_label``. The server cannot derive it: a list of ids does not say
    which values produced it, and two variables can select the same people (D124). The COUNT is the
    server's own — the ids it filtered on — so a file carries a check on the label it was handed.
    Without a label (a filter from a link or a saved analysis keeps ids only) the count stands
    alone.
    """
    if not participant_ids:
        return None
    n = len(set(participant_ids))
    count = f"{n} participant" + ("" if n == 1 else "s")
    label = (label or "").strip()
    return f"participant filter: {label} ({count})" if label else f"participant filter: {count}"
