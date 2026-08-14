"""#747 — a note's sequence number, decided in ONE place, for every parent.

**What was wrong.** Only `POST /conversations/{id}/notes` ever computed a number.
The other three writers — `observations.py`, `documents.py`, `text_coding.py` —
each stored the literal `0`, and `models/note.py` had promoted that to a
convention ("comment/document notes use `Note.id` for display ordering"). Three
of the four parents therefore shared one number, and every surface that shows it
invented its own answer: conversations printed the stored value, documents
renumbered positionally SERVER-side, observation clips renumbered positionally
CLIENT-side, and the two surfaces that quote it out of context printed the raw
zero — `export_excel.py` writing `N-0` for every non-conversation note, and the
Memos & Notes page rendering the same document note as "3" in its workbench and
"N-0" there.

**The rule now.** A note's number is `max + 1` among the notes sharing its
parent. It is STORED, not derived at read time, because the number leaves the
screen it was made on: it is an identifier column in the Excel export and a label
a researcher can cite. Derived positional numbering is stable only within one
rendering of one list — delete an earlier note and a citation silently points at
a different note — and adopting it everywhere would mean converting the one
surface whose numbers are real and already in use.

**Why the parent set is read from the CHECK constraint rather than listed.** This
defect IS the enumeration-debt shape: `Note` gained a fourth parent and one of
four writers was updated. `ck_note_at_least_one_parent` is the artifact a fifth
parent MUST be added to, so deriving from it means a new parent gets numbering
for free instead of getting another silent zero. Same technique as
`test_all_notes_arity.py`, moved into the runtime path.
"""
import re

from sqlalchemy import CheckConstraint, func
from sqlalchemy.orm import Session

from ..models.note import Note

_PARENT_CHECK = "ck_note_at_least_one_parent"


def declared_note_parents() -> tuple[str, ...]:
    """Parent FK column names, parsed from the at-least-one CHECK.

    Ordered for determinism (the constraint's own text order is not guaranteed to
    be stable across a schema edit). Raises if the constraint is gone — numbering
    silently falling back to "no parents" is how this defect started.
    """
    for c in Note.__table__.constraints:
        if isinstance(c, CheckConstraint) and c.name == _PARENT_CHECK:
            found = tuple(sorted(set(re.findall(r"(\w+_id)\s+IS NOT NULL", str(c.sqltext)))))
            if not found:
                raise RuntimeError(f"{_PARENT_CHECK} parsed to no parent columns")
            return found
    raise RuntimeError(
        f"{_PARENT_CHECK} is gone — note numbering derives the parent set from it, "
        "so a rename here must be made deliberately, not discovered by a zero."
    )


def note_parent_key(note: Note) -> dict[str, int]:
    """The parent column(s) actually set on `note`, as a filter dict.

    The CHECK is at-least-one rather than exactly-one, so this returns every
    parent that is set and callers scope by ALL of them — "the notes sharing this
    note's parents". For the four real writers exactly one is ever set, where that
    reduces to the obvious thing; it avoids inventing a tie-break rule that would
    be wrong the first time it mattered.
    """
    key = {col: getattr(note, col) for col in declared_note_parents()}
    return {col: val for col, val in key.items() if val is not None}


def next_note_sequence(db: Session, note: Note) -> int:
    """The next number for `note` among its parent's notes.

    ⚠️ Deliberately does NOT filter `is_archived`: archiving a note must not free
    its number for reuse, or two notes in one parent end up sharing a label and
    the older one's citation silently re-points.

    ⚠️ Production and tests run `autoflush=False`, so this cannot see notes added
    to the session but not yet flushed. Every caller is create-one-then-commit; a
    future batch writer must flush between notes (or number them itself).
    """
    parents = note_parent_key(note)
    if not parents:
        raise ValueError(
            "a note needs a parent before it can be numbered — this note would also "
            f"violate {_PARENT_CHECK} at flush"
        )
    q = db.query(func.max(Note.sequence_number))
    for col, val in parents.items():
        q = q.filter(getattr(Note, col) == val)
    return (q.scalar() or 0) + 1


def renumber_imported_notes(db: Session, inserted_note_ids: set[int]) -> int:
    """Give imported notes numbers that do not collide with the target's own.

    Runs for EVERY import, not just old archives, because the collision predates
    this fix: `sequence_number` rides the wire as a plain column, so merging two
    projects into one conversation brought two independent `1..n` runs into the
    same parent. Imported notes are appended AFTER the local maximum, keeping
    their source order (`sequence_number`, then `id`) so the file's own sequence
    survives as relative order.

    ⚠️ ``inserted_note_ids`` is REQUIRED and is the whole correctness argument
    (#714, and `_repair_pre_v5_excerpt_offsets` above it says the same thing for
    offsets). Under ``import_mode="merge"`` the note remap also points at rows
    that already existed locally; renumbering those would rewrite labels on the
    target's own data, which no import may do.

    Returns the number of notes renumbered (for the import report / tests).
    """
    if not inserted_note_ids:
        return 0

    inserted = db.query(Note).filter(Note.id.in_(inserted_note_ids)).all()
    if not inserted:
        return 0

    groups: dict[tuple, list[Note]] = {}
    for note in inserted:
        key = tuple(sorted(note_parent_key(note).items()))
        groups.setdefault(key, []).append(note)

    renumbered = 0
    for key, notes in groups.items():
        if not key:
            continue  # parentless: it cannot be stored at all, let the CHECK say so
        base_q = db.query(func.max(Note.sequence_number)).filter(
            ~Note.id.in_(inserted_note_ids)
        )
        for col, val in key:
            base_q = base_q.filter(getattr(Note, col) == val)
        nxt = (base_q.scalar() or 0) + 1
        for note in sorted(notes, key=lambda n: (n.sequence_number or 0, n.id)):
            if note.sequence_number != nxt:
                note.sequence_number = nxt
                renumbered += 1
            nxt += 1
    db.flush()
    return renumbered
