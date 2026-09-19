"""Human labels for a coding SOURCE, batched for one page (#35 variant B).

A coded unit lives under one of four sources — a conversation, a document, an
observation, or a dataset column — and every cross-source surface has to print
the same name for it. `reconciliation.py` had the only implementation; the
rating sweep needed the second, which is the point at which a copy stops being
a copy and becomes substrate debt (the arch-debt synthesis' second class, whose
stated remedy is the single-source chokepoint rather than a third careful
duplicate).

🔴 **Every tag gets an EXPLICIT branch and an unknown one RAISES.** The version
this was extracted from records why: `col` used to be the fall-through default,
so a tag nobody had handled yet rendered a silently blank source name instead
of failing. A blank label on an adjudication surface reads as a source with no
name, not as a bug.

⚠️ **Keyed by `(tag, id)`, and the tags are the RECONCILIATION vocabulary**
(`conv` / `doc` / `obs` / `col`), not the segment-parent column names. They are
what both callers already speak, and translating at the boundary would put a
fifth mapping beside the four `reconciliation.py` keeps deliberately in step.

⚠️ **Batched per PAGE, never per row.** Four `IN` queries at most, each over the
ids actually on the page, so a surface showing fifty units costs four round
trips rather than fifty. ⚠️ The id lists are page-bounded by construction — do
not hand this a project-wide set, which is the `.in_()` bind ceiling #842
documents.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy.orm import Session

from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetColumn
from ..models.document import Document
from ..models.observation import Observation

#: The four source tags, shared with `reconciliation.py`'s maps.
SOURCE_TAGS = frozenset({"conv", "doc", "obs", "col"})

#: A column's label is the dataset's name and the column's, joined by this.
#: ⚠️ U+203A, matching the Notes sheet's vocabulary for the same locator.
_COLUMN_JOINER = " › "

#: A column heading long enough to swamp the row is trimmed for the label only.
_MAX_COLUMN_LABEL = 60


def label_sources(
    db: Session, keys: Iterable[tuple[str, int]]
) -> dict[tuple[str, int], str]:
    """`{(tag, id): label}` for one page's worth of source keys.

    A key whose row no longer exists maps to the empty string rather than
    being absent: a caller rendering a label must not have to distinguish
    "deleted since the page was built" from "I forgot to ask", and both are
    the same blank on screen.
    """
    wanted = set(keys)
    unknown = {tag for tag, _ in wanted} - SOURCE_TAGS
    if unknown:
        raise KeyError(f"unhandled source tag(s): {sorted(unknown)!r}")

    out: dict[tuple[str, int], str] = {key: "" for key in wanted}

    def _ids(tag: str) -> list[int]:
        return [sid for t, sid in wanted if t == tag]

    for tag, model in (
        ("conv", Conversation), ("doc", Document), ("obs", Observation),
    ):
        ids = _ids(tag)
        if not ids:
            continue
        for sid, name in db.query(model.id, model.name).filter(model.id.in_(ids)).all():
            out[(tag, sid)] = name or ""

    col_ids = _ids("col")
    if col_ids:
        rows = (
            db.query(
                DatasetColumn.id, DatasetColumn.column_name,
                DatasetColumn.column_text, Dataset.name,
            )
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(DatasetColumn.id.in_(col_ids))
            .all()
        )
        for col_id, col_name, col_text, ds_name in rows:
            label = col_name or (col_text[:_MAX_COLUMN_LABEL] if col_text else "")
            out[("col", col_id)] = (
                f"{ds_name}{_COLUMN_JOINER}{label}" if label else (ds_name or "")
            )

    return out
