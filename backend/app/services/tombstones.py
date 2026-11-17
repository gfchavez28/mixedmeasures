"""#1190 — the removal tombstones: write them at a withdrawal, read them wherever a
withdrawn person could come back (a `.mmproject` import of any mode, participant
linking, a conversation import's speaker linking).

🔴 **A tombstone is consulted by the identity it names, never by an id.** A merge
matches on uuid, so a removed entity is skipped by its uuid; a colleague's copy can
also hold a participant MINTED after the copy was made (they linked a wave), with a
new uuid and the same identifier, so a participant is also skipped by
`identifier_hash`. Linking has only the identifier.

⚠️ **The hash is not anonymisation.** An identifier is a short code or a speaker
name, and a dictionary recovers either from a SHA-256 in moments. It keeps the
identifier out of plain sight in the database and in a shared `.mmproject`, and
nothing more; the `withdrawn` audit entry keeps it in plain text by decision D9.

🔴 **Two match rules, one per kind (#1605, D227–D229).**
- **An ID** is the same ID in any canonically equivalent Unicode form, with capitals
  and inner spacing kept. `P01` and `p01` can be two people (DEC-2, #414), so a
  withdrawal is never stricter about an ID than linking is. Written composed (NFC),
  read in its composed, decomposed and as-written forms (`identifier_hashes_for`),
  so a row written before #1605 over a decomposed ID still answers.
- **A name** is compared FOLDED: spacing collapsed, capitals ignored, and so is how an
  accent is encoded (`fold_name`). It is never compared without its accents: `Maria`
  and `María` stay two names. Each name is written twice (D237): its as-written hash
  (v1) and its folded hash (v2), so the speaker door can tell an exact match from one
  found only by folding, and say so.
- Compatibility forms (NFKC: full-width letters, ligatures) look different on screen
  and stay different.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..models.removal_tombstone import RemovalTombstone
from .identifier_match import normalize_key

REASON_WITHDRAWAL = "withdrawal"
#: D12 — the researcher confirmed that a withdrawn identifier names someone again.
REASON_REINSTATED = "reinstated"

PARTICIPANT = "participant"
SPEAKER = "speaker"
DATASET_ROW = "dataset_row"
EXCERPT = "excerpt"
NOTE = "note"
#: Not removed — BLANKED (#1320 keeps the turn). Named so the merge's text gate can
#: tell a withdrawal's blank from an edit, and drop new quotes of her words.
SEGMENT_BLANKED = "segment_blanked"
#: D12 — NOT a removal: the uuid of a participant the researcher created (or renamed)
#: under a withdrawn identifier, having confirmed it names someone again. Without it
#: the identifier hash would skip that NEW person at every later merge and refuse
#: every coding copy of the project (`withdrawn_participant`). It travels in the
#: file's `tombstones` key with the rest, so a copy made after it agrees — and a
#: "new" import (Duplicate, an independent project), which re-mints every
#: participant's uuid, follows it through the re-mint with `rekey` (#1471).
PARTICIPANT_REINSTATED = "participant_reinstated"
#: #1472 (D73, 1.5.9) — a NAME the withdrawn person was known by in the project (her
#: display name, her speakers' names and labels, her turns' original labels — every
#: spelling `apply_withdrawal`'s `her_names` collects; since #1605 (D229) the ID's own
#: spelling too, FOLDED, because a participant made from a transcript has ID == name and
#: the name kind is the one that ignores capitals — `name_hashes_to_remember`). Read
#: ONLY by the conversation import's speaker-label door
#: (`withdrawn_speaker_label`): never by linking, a typed create or a merge, where a
#: common first name would skip or refuse a DIFFERENT person's data. A KIND of its own
#: with a hash prefix of its own, so no reader of an ID can take a name for one.
#: Travels in the file's `tombstones` key with no format bump: an older build's
#: `from_file` ignores an unknown kind whole, which is that build's status quo.
PARTICIPANT_NAME = "participant_name"

ENTITY_TYPES = frozenset({
    PARTICIPANT, SPEAKER, DATASET_ROW, EXCERPT, NOTE, SEGMENT_BLANKED,
    PARTICIPANT_REINSTATED, PARTICIPANT_NAME,
})

#: D12 — the 409's sentence when a researcher types a withdrawn identifier. It never
#: names the person, and never repeats the identifier (the researcher just typed it).
WITHDRAWN_IDENTIFIER_ERROR = "withdrawn_identifier"
WITHDRAWN_IDENTIFIER_MESSAGE = (
    "This identifier belonged to a participant who withdrew from this project; use it "
    "again only if it now names someone who has agreed to take part."
)


#: #1605 (D237) — how a speaker label matched the withdrawal record. EXACT: her ID in any
#: Unicode form, or one of her names as written (an accent encoded the other way is
#: invisible, so it is exact too). FOLDED: only once capitals or spacing were ignored.
SPEAKER_MATCH_EXACT = "exact"
SPEAKER_MATCH_FOLDED = "folded"


def withdrawn_speaker_warning(count: int, folded: int = 0) -> str:
    """#1391 / #1472 (D74, D75) — the conversation import's warning when the speaker
    door left speakers unlinked because the withdrawal record names their label.

    A COUNT, never the name (D12's never-repeat rule; the researcher has the
    transcript). It says what happened, the way to link someone else who shares a
    remembered name (there is no hand link for a speaker: the import's match is the
    only writer, so the remedy is a different name under Map Speakers), and that a
    transcript holding the withdrawn person's words brought those words back.

    #1605 (D237) — ``folded`` of the ``count`` matched ONLY once capitals or spacing
    were ignored (`SPEAKER_MATCH_FOLDED`); the sentence says so, as a clause, because a
    researcher reading "remembers that name" beside a label that is not quite her name
    would otherwise think the record was wrong. Never "accents": the fold does not make
    `Maria` and `María` one name."""
    one = count == 1
    if not folded:
        recalled = "that name or ID" if one else "those names or IDs"
    elif one:
        recalled = "that name or ID, written here with different capitals or spacing"
    elif folded == count:
        recalled = "those names or IDs, written here with different capitals or spacing"
    else:
        recalled = "those names or IDs (some written here with different capitals or spacing)"
    return (
        f"{count} speaker{'' if one else 's'} {'was' if one else 'were'} not linked to "
        f"{'a participant' if one else 'participants'}, because this project's record of "
        f"a withdrawal remembers {recalled}. "
        f"If {'the' if one else 'a'} speaker is someone else, delete this conversation and "
        "import it again with a different name for them under Map Speakers. If this "
        f"transcript holds {'the' if one else 'a'} withdrawn participant's words, importing "
        "it brought those words back; deleting the conversation removes them."
    )


_HASH_PREFIX = "mm-withdrawn-identifier:v1:"
#: #1472 (D73) — the NAME kind's prefix. Different from the identifier's on purpose:
#: the same text hashes to a different value under each, so a stored name can never
#: answer an identifier question, in memory or in the table (`is_withdrawn_identifier`
#: compares hashes and nothing else).
_NAME_HASH_PREFIX = "mm-withdrawn-name:v1:"
#: #1605 (D228) — a name's FOLDED hash (`fold_name`). Its own prefix, so a folded name
#: can never equal an as-written one, nor any ID: `is_withdrawn_identifier` compares
#: hashes and nothing else, and D73's wall holds at the table. The revision that
#: upgrades older withdrawals (`b8d4f2a6c0e9`) carries its own copy of this rule and
#: `identifier_key`'s, held equal by `test_withdrawal_record_upgrade_1605.py`.
_NAME_FOLD_PREFIX = "mm-withdrawn-name:v2:"


def _sha(prefix: str, key: str) -> str:
    return hashlib.sha256((prefix + key).encode("utf-8")).hexdigest()


def identifier_key(text: str | None) -> str:
    """#1605 (D227) — the form an ID is WRITTEN in: trimmed (`normalize_key`, the
    linking rule) and composed (NFC). Capitals and inner spacing are kept. `""` for
    nothing. Two texts are the same ID exactly when their keys are equal."""
    key = normalize_key(text)
    return unicodedata.normalize("NFC", key) if key else ""


def _forms(text: str | None) -> tuple[str, ...]:
    """The trimmed text composed, decomposed and as written — every form a hash may
    have been taken over (a row written before #1605 hashed the text as it came)."""
    key = normalize_key(text)
    if not key:
        return ()
    return tuple(dict.fromkeys((
        unicodedata.normalize("NFC", key), unicodedata.normalize("NFD", key), key,
    )))


def fold_name(text: str | None) -> str:
    """#1605 (D228) — a NAME's match key: inner whitespace collapsed, then Unicode's
    canonical caseless match, NFD(casefold(NFD(x))). So `MARÍA LÓPEZ`, `maría  lópez`
    and a decomposed `María López` are one name; `Maria` and `María` are not. Names
    only — an ID keeps its capitals (`identifier_key`)."""
    key = normalize_key(text)
    if not key:
        return ""
    return unicodedata.normalize(
        "NFD", unicodedata.normalize("NFD", " ".join(key.split())).casefold())


def identifier_hash(identifier: str | None) -> str | None:
    """The hash a withdrawal WRITES for an ID: over `identifier_key` (#1605, D227). For
    every ID already composed — every ASCII code — it is the hash 1.5.8 and 1.6.0 wrote."""
    key = identifier_key(identifier)
    return _sha(_HASH_PREFIX, key) if key else None


def identifier_hashes_for(identifier: str | None) -> frozenset[str]:
    """#1605 (D227) — every ID hash that names this text: its composed, decomposed and
    as-written forms. The ONE read of the ID kind (`Tombstones.withdrawn_identifier`,
    `is_withdrawn_identifier`), so every door that asks the ID follows it."""
    return frozenset(_sha(_HASH_PREFIX, f) for f in _forms(identifier))


def name_hash(name: str | None) -> str | None:
    """#1472 (D73) — a remembered NAME's as-written hash (v1): trimmed and, since #1605,
    composed, under the name kind's own prefix. An exact match."""
    key = identifier_key(name)
    return _sha(_NAME_HASH_PREFIX, key) if key else None


def folded_name_hash(name: str | None) -> str | None:
    """#1605 (D228) — a remembered NAME's folded hash (v2): `fold_name` under its own
    prefix. A match only once capitals or spacing are ignored."""
    key = fold_name(name)
    return _sha(_NAME_FOLD_PREFIX, key) if key else None


def exact_name_hashes_for(name: str | None) -> frozenset[str]:
    """The as-written (v1) name hashes of every form of this label, so a row written
    before #1605 over a decomposed name still answers it exactly."""
    return frozenset(_sha(_NAME_HASH_PREFIX, f) for f in _forms(name))


def name_hashes_to_remember(names, identifier: str | None) -> set[str]:
    """#1605 (D229, D237) — the name kind's hashes a withdrawal WRITES for the spellings
    she was known by: each one's folded hash — her ID's spelling included, since a
    participant made from a transcript has ID == name and only the name kind folds — and
    each one's as-written hash except the ID's, which the ID kind already answers exactly
    (D73's original reason, kept for the as-written half)."""
    ident = identifier_key(identifier)
    out: set[str] = set()
    for n in names:
        folded = folded_name_hash(n)
        if folded:
            out.add(folded)
        if identifier_key(n) != ident:
            exact = name_hash(n)
            if exact:
                out.add(exact)
    return out


@dataclass
class Tombstones:
    uuids: dict[str, set[str]] = field(default_factory=dict)
    identifier_hashes: set[str] = field(default_factory=set)
    #: #1472 (D73) — the `participant_name` kind's hashes. Never in
    #: `identifier_hashes`, which every reader of an ID asks.
    name_hashes: set[str] = field(default_factory=set)

    def has(self, entity_type: str, entity_uuid: str | None) -> bool:
        return bool(entity_uuid) and entity_uuid in self.uuids.get(entity_type, ())

    def withdrawn_identifier(self, identifier: str | None) -> bool:
        """Her ID, in any canonically equivalent form, capitals kept (#1605, D227)."""
        return not identifier_hashes_for(identifier).isdisjoint(self.identifier_hashes)

    def _name_match(self, name: str | None) -> str | None:
        """#1605 (D237) — `SPEAKER_MATCH_EXACT` when an as-written name hash answers
        (any form of the label, so a row from before #1605 still does), else
        `SPEAKER_MATCH_FOLDED` when only the folded one does, else None."""
        if not exact_name_hashes_for(name).isdisjoint(self.name_hashes):
            return SPEAKER_MATCH_EXACT
        folded = folded_name_hash(name)
        if folded is not None and folded in self.name_hashes:
            return SPEAKER_MATCH_FOLDED
        return None

    def withdrawn_name(self, name: str | None) -> bool:
        """#1472 (D73) — was this one of the names a withdrawn person was known by,
        as written or folded (#1605, D228)? Asked only through the speaker door."""
        return self._name_match(name) is not None

    def withdrawn_speaker_match(self, label: str | None) -> str | None:
        """#1472 / #1391 (D73, D74) — the speaker-label door's ONE question: does this
        label name a withdrawn person, by her ID (the one predicate, with no uuid —
        the door is about to create someone, so nobody can have been reinstated
        under it) or by a name the project knew her by? #1605 (D237): it answers HOW —
        `SPEAKER_MATCH_EXACT`, `SPEAKER_MATCH_FOLDED` — or None, so the import's warning
        can say when capitals or spacing were ignored.

        🔴 The ONLY reader of the name kind. Linking by column, the typed create and
        the merge ask `withdrawn_participant` / `withdrawn_identifier`, never this:
        a common first name there would skip or refuse a DIFFERENT person's data —
        silently, in a merge. At the speaker door the cost is said (the import's
        warning) and the remedy is a rename (D75)."""
        if self.withdrawn_participant(None, label):
            return SPEAKER_MATCH_EXACT
        return self._name_match(label)

    def withdrawn_speaker_label(self, label: str | None) -> bool:
        """`withdrawn_speaker_match`, as a yes or no."""
        return self.withdrawn_speaker_match(label) is not None

    def withdrawn_participant(self, entity_uuid: str | None, identifier: str | None) -> bool:
        """Is this participant (a file's row) a withdrawn person? By the uuid the
        withdrawal removed, or by the identifier — unless the researcher reinstated
        THIS participant under it (D12), which the uuid says."""
        if self.has(PARTICIPANT, entity_uuid):
            return True
        return self.withdrawn_identifier(identifier) and not self.has(
            PARTICIPANT_REINSTATED, entity_uuid)

    def __bool__(self) -> bool:
        return (bool(self.identifier_hashes) or bool(self.name_hashes)
                or any(self.uuids.values()))

    def add(self, entity_type: str, entity_uuid: str | None, ident_hash: str | None = None):
        if entity_uuid:
            self.uuids.setdefault(entity_type, set()).add(entity_uuid)
        if ident_hash:
            # #1472 (D73) — a hash is routed by its KIND: a name poured into
            # `identifier_hashes` would be written back as an ID row by `write`,
            # losing the kind for every later reader.
            (self.name_hashes if entity_type == PARTICIPANT_NAME
             else self.identifier_hashes).add(ident_hash)


def load(db: Session, project_uuid: str | None) -> Tombstones:
    out = Tombstones()
    if not project_uuid:
        return out
    for etype, euuid, ihash in db.query(
        RemovalTombstone.entity_type, RemovalTombstone.entity_uuid,
        RemovalTombstone.identifier_hash,
    ).filter(RemovalTombstone.project_uuid == project_uuid):
        out.add(etype, euuid, ihash)
    return out


def from_file(items: list[dict] | None) -> Tombstones:
    """A file's `tombstones` list. An unknown entity type is ignored, never trusted."""
    out = Tombstones()
    for it in items or []:
        if it.get("entity_type") in ENTITY_TYPES:
            out.add(it["entity_type"], it.get("entity_uuid"), it.get("identifier_hash"))
    return out


def union(a: Tombstones, b: Tombstones) -> Tombstones:
    out = Tombstones()
    for t in (a, b):
        for etype, us in t.uuids.items():
            for u in us:
                out.add(etype, u)
        out.identifier_hashes |= t.identifier_hashes
        out.name_hashes |= t.name_hashes
    return out


def rekey(t: Tombstones, entity_type: str, old_to_new: dict[str, str]) -> Tombstones:
    """#1471 — the same record with `entity_type`'s uuids followed through a re-mint
    (`old_to_new`: a file entity's uuid → the uuid the import gave it). A uuid the map
    does not name is kept as it was: it names nothing in the project the import made,
    so it stays inert."""
    out = union(t, Tombstones())
    have = out.uuids.get(entity_type)
    if have:
        out.uuids[entity_type] = {old_to_new.get(u, u) for u in have}
    return out


def write(db: Session, project_uuid: str, tombstones: Tombstones,
          reason: str = REASON_WITHDRAWAL) -> int:
    """Store every tombstone not already stored under this project identity."""
    have = load(db, project_uuid)
    n = 0
    for etype, us in tombstones.uuids.items():
        for u in sorted(us):
            if have.has(etype, u):
                continue
            db.add(RemovalTombstone(
                project_uuid=project_uuid, entity_type=etype, entity_uuid=u,
                reason=REASON_REINSTATED if etype == PARTICIPANT_REINSTATED else reason,
            ))
            n += 1
    for h in sorted(tombstones.identifier_hashes - have.identifier_hashes):
        db.add(RemovalTombstone(project_uuid=project_uuid, entity_type=PARTICIPANT,
                                identifier_hash=h, reason=reason))
        n += 1
    for h in sorted(tombstones.name_hashes - have.name_hashes):
        db.add(RemovalTombstone(project_uuid=project_uuid, entity_type=PARTICIPANT_NAME,
                                identifier_hash=h, reason=reason))
        n += 1
    if n:
        db.flush()
    return n


#: #1470 (D69) — the merge's refusal kind, as `MergeDivergenceError.payload["kind"]`.
WITHDRAWAL_DIVERGENCE_KIND = "withdrawal"


def withdrawn_but_held(db: Session, project_id: int, removed: Tombstones) -> list[dict]:
    """#1470 (D69–D71) — the participants ``project_id`` still holds that ``removed``
    names as withdrawn, as ``[{"participant_id", "identifier"}]`` ordered by ID.

    ``removed`` is a merge's union — this install's record for the file's identity and
    the file's own — so a withdrawal made in a COLLEAGUE'S copy reaches here: the copy
    no longer holds the person, the target does, and a merge that stored the record and
    went on left her data in place and every later Duplicate refused (#1470). The merge
    refuses on a non-empty answer, and the merge preview shows the same answer, so the
    two cannot disagree (`removal-tombstones.md` §6).

    🔴 **The one predicate, `Tombstones.withdrawn_participant`** — by uuid, or by ID
    unless that participant was reinstated (D12), so someone re-instated under a
    withdrawn ID is not reported here.

    D71 — each is named by THIS project's own ID for them: the target's record, which
    the Participants page already shows. Nothing the file says is returned.
    """
    if not removed.identifier_hashes and not removed.uuids.get(PARTICIPANT):
        return []
    from ..models.participant import Participant
    return [
        {"participant_id": pid, "identifier": ident}
        for pid, puuid, ident in db.query(
            Participant.id, Participant.uuid, Participant.identifier,
        ).filter(Participant.project_id == project_id)
        .order_by(Participant.identifier, Participant.id)
        if removed.withdrawn_participant(puuid, ident)
    ]


def withdrawn_but_held_message(held: list[dict]) -> str:
    """#1470 (D69) — the merge refusal's sentence (a direct caller's; the Merge page
    renders its own words from the payload's ``kind`` and ``withdrawn_here``)."""
    names = ", ".join(h["identifier"] for h in held[:5]) + ("…" if len(held) > 5 else "")
    return (
        f"The copy you are merging records that {len(held)} participant(s) withdrew, and "
        f"this project still holds their data: {names}. Withdraw them in this project "
        "first, then merge the copy again. Nothing was changed."
    )


def is_withdrawn_identifier(db: Session, project_uuid: str | None, identifier: str | None) -> bool:
    """The table's twin of `Tombstones.withdrawn_identifier` (#1605, D227): every form of
    the ID, so a typed composed ID meets a row written before #1605 over a decomposed one."""
    hs = identifier_hashes_for(identifier)
    if not hs or not project_uuid:
        return False
    return db.query(RemovalTombstone.id).filter(
        RemovalTombstone.project_uuid == project_uuid,
        RemovalTombstone.identifier_hash.in_(sorted(hs)),
    ).first() is not None


def _project_uuid(db: Session, project_id: int) -> str | None:
    from ..models.project import Project
    return db.query(Project.project_uuid).filter(Project.id == project_id).scalar()


def withdrawn_identifier_refusal(
    db: Session, project_id: int, identifier: str | None, *, confirmed: bool,
) -> dict | None:
    """D12 — the 409 detail for a researcher-typed identifier a withdrawal tombstoned,
    or None. The `MergeDivergenceDetail` precedent: `{error, message}`, so the client
    reads the sentence from `.message` and the kind from `.error`. `confirmed` is the
    researcher's explicit override (`confirm_withdrawn`), the only way past it."""
    if confirmed:
        return None
    if not is_withdrawn_identifier(db, _project_uuid(db, project_id), identifier):
        return None
    return {"error": WITHDRAWN_IDENTIFIER_ERROR, "message": WITHDRAWN_IDENTIFIER_MESSAGE}


def reinstate_if_withdrawn(db: Session, project_id: int, participant) -> bool:
    """D12 — after a confirmed create or rename: if `participant`'s identifier is a
    withdrawn one, record that THIS participant (its uuid) is not the person who
    withdrew. Linking, a conversation import and a typed create still refuse the
    identifier whenever no participant holds it; an import stops treating this one
    as her (`Tombstones.withdrawn_participant`). Returns whether it wrote."""
    project_uuid = _project_uuid(db, project_id)
    if not participant.uuid or not is_withdrawn_identifier(
        db, project_uuid, participant.identifier,
    ):
        return False
    marker = Tombstones()
    marker.add(PARTICIPANT_REINSTATED, participant.uuid)
    return write(db, project_uuid, marker) > 0
