"""What "this unit" means when a segment belongs to a GROUP.

Extracted from `routers/coding.py` on 2026-09-22 (queue row 49), unchanged in
behaviour. A `SegmentGroup` exists so adjacent turns are coded as ONE unit — that
is the whole point of it — so a code, a rating and a code-set SELECTION each
reach every visible member.

🔴 **IT MOVED BECAUSE A SERVICE NEEDED IT AND A SERVICE MAY NOT IMPORT A ROUTER.**
The bulk coding import writes set selections, and the internal design notes
is explicit that `apply_selection` does NOT re-derive the group — *"the caller
passes the sibling ids … because that is where two derivations would drift."* So
the import must pass the same ids the workbench passes, and the only way to
guarantee that is for both to call one function. `routers/coding.py` re-exports
it under its old private name (the #578 pattern `recompute_primary_value_numeric`
established), so no call site changed.

⚠️ **The scope is VISIBLE siblings** — `merged_into_id IS NULL AND split_into_id
IS NULL`. It mirrors `apply_code`'s sibling loop and `_fan_out_rating`'s scope
exactly; a merged-away original's coding is UI-unreachable (#500), so writing to
one would create a row nothing can see or remove.

⚠️ **The segment itself is always in the result, even if the group query misses
it.** That is not defensive padding: a segment can be soft-deleted between the
read that loaded it and this query, and an act on a unit must never silently
address zero targets.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models.segment import Segment


def group_target_ids(db: Session, segment: Segment) -> list[int]:
    """This segment plus its VISIBLE group siblings — the targets one act covers."""
    if not segment.group_id:
        return [segment.id]
    ids = [
        r[0] for r in db.query(Segment.id).filter(
            Segment.group_id == segment.group_id,
            Segment.merged_into_id == None,  # noqa: E711
            Segment.split_into_id == None,  # noqa: E711
        ).all()
    ]
    if segment.id not in ids:
        ids.append(segment.id)
    return ids
