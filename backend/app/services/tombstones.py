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
"""

from __future__ import annotations

import hashlib
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

ENTITY_TYPES = frozenset({
    PARTICIPANT, SPEAKER, DATASET_ROW, EXCERPT, NOTE, SEGMENT_BLANKED,
    PARTICIPANT_REINSTATED,
})

#: D12 — the 409's sentence when a researcher types a withdrawn identifier. It never
#: names the person, and never repeats the identifier (the researcher just typed it).
WITHDRAWN_IDENTIFIER_ERROR = "withdrawn_identifier"
WITHDRAWN_IDENTIFIER_MESSAGE = (
    "This identifier belonged to a participant who withdrew from this project; use it "
    "again only if it now names someone who has agreed to take part."
)

_HASH_PREFIX = "mm-withdrawn-identifier:v1:"


def identifier_hash(identifier: str | None) -> str | None:
    """The one hash, over the one normalisation linking matches on."""
    key = normalize_key(identifier)
    if not key:
        return None
    return hashlib.sha256((_HASH_PREFIX + key).encode("utf-8")).hexdigest()


@dataclass
class Tombstones:
    uuids: dict[str, set[str]] = field(default_factory=dict)
    identifier_hashes: set[str] = field(default_factory=set)

    def has(self, entity_type: str, entity_uuid: str | None) -> bool:
        return bool(entity_uuid) and entity_uuid in self.uuids.get(entity_type, ())

    def withdrawn_identifier(self, identifier: str | None) -> bool:
        h = identifier_hash(identifier)
        return h is not None and h in self.identifier_hashes

    def withdrawn_participant(self, entity_uuid: str | None, identifier: str | None) -> bool:
        """Is this participant (a file's row) a withdrawn person? By the uuid the
        withdrawal removed, or by the identifier — unless the researcher reinstated
        THIS participant under it (D12), which the uuid says."""
        if self.has(PARTICIPANT, entity_uuid):
            return True
        return self.withdrawn_identifier(identifier) and not self.has(
            PARTICIPANT_REINSTATED, entity_uuid)

    def __bool__(self) -> bool:
        return bool(self.identifier_hashes) or any(self.uuids.values())

    def add(self, entity_type: str, entity_uuid: str | None, ident_hash: str | None = None):
        if entity_uuid:
            self.uuids.setdefault(entity_type, set()).add(entity_uuid)
        if ident_hash:
            self.identifier_hashes.add(ident_hash)


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
    if n:
        db.flush()
    return n


def is_withdrawn_identifier(db: Session, project_uuid: str | None, identifier: str | None) -> bool:
    h = identifier_hash(identifier)
    if h is None or not project_uuid:
        return False
    return db.query(RemovalTombstone.id).filter(
        RemovalTombstone.project_uuid == project_uuid,
        RemovalTombstone.identifier_hash == h,
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
