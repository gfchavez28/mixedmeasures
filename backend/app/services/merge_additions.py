"""#1190 (D15) — what a merge would ADD that the target does not hold, for the Merge page's
Review step (`ImportValidationResult.merge_additions`, set by `/validate-import` only when
a merge is possible).

**Why.** A file-only entity is either the colleague's new work or something DELETED here
since their copy was made, and nothing records a plain delete until 1.5.9 (deletion
tombstones, D15's 1.5.9 half) — so an older copy brings a deleted source, record or quote
back silently. The preview cannot tell the two apart; it NAMES what a researcher would
recognise (sources, participants, datasets — each list capped at
`MERGE_ADDITIONS_NAME_CAP`, its total beside it) and COUNTS the rest.

🔴 **A withdrawn person is never named FROM THE FILE** — not in `participants`, not
anywhere: they are COUNTED in `withdrawn_participants`, with what the merge leaves out of
theirs in `withdrawn_items`. The preview reaches a browser and any screenshot of it.
The one list of names is `withdrawn_here` (#1470, D70/D71): people THIS project still holds
whom the file records as withdrawn, named by this project's own ID — the merge refuses over
them (`tombstones.withdrawn_but_held`, the function the merge itself calls), and the
researcher has to know whom to withdraw.

🔴 **It predicts the act, so it asks the merge's questions** (the export ceiling's rule: a
warning that predicts a refusal must be computed the way the refusal is):
- a uuid is "held" exactly where `project_portability._merge_uuid_match` would match it —
  SCOPED to the target for a model with a `project_id` (sources, participants, datasets,
  quotes, memos), by the GLOBAL unique index for one without (records, segments, notes);
- a participant unknown by uuid but whose identifier the target holds is matched (#1190's
  natural-key dedup), and a quote on a matched turn whose SHAPE a local quote already has
  is a duplicate;
- a matched participant table's records match on their PARTICIPANT (#921);
- what the withdrawal tombstones name — this install's and the file's — is left out, as
  the merge leaves it out.
⚠️ The two drift if either changes alone; `tests/test_merge_additions.py` runs the real
merge on its fixture and compares.

⚠️ **Every id-list lookup filters on the id list ALONE, in chunks, and scopes in Python**
(`sql-id-sets.md` §6: an id list joined back to `project_id` can be planned from the
project — 139.8 s per 5,000 ids on BES; and each chunk stays far below SQLite's 250,000
bind-parameter ceiling, §1). The target's own participants and sources are read by an
equality on the indexed `project_id`, which is a plain project read, not that shape.

DERIVED preview data (`backend-invariants.md` §6): the import never reads it.
"""

from __future__ import annotations

import json
import zipfile
from collections import Counter
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetRow
from ..models.document import Document
from ..models.excerpt import Excerpt
from ..models.memo import Memo
from ..models.note import Note
from ..models.observation import Observation
from ..models.participant import Participant
from ..models.segment import Segment
from . import tombstones as tomb
from .project_portability import _entity_rows

#: Names shown per list; the `*_count` beside each list is the true total.
MERGE_ADDITIONS_NAME_CAP = 20

#: Ids per lookup statement — the merge's own `_UUID_LOOKUP_CHUNK`.
_CHUNK = 5_000

_SOURCES = (
    ("conversations", Conversation, "conversation"),
    ("documents", Document, "document"),
    ("observations", Observation, "observation"),
)


def _chunks(values: list):
    for i in range(0, len(values), _CHUNK):
        yield values[i:i + _CHUNK]


def _held(db: Session, model, uuids, *, target_project_id: int | None) -> set[str]:
    """Which of ``uuids`` the merge would MATCH: filtered on the uuid list alone, then
    scoped to the target in Python when the model carries a ``project_id`` (exactly where
    ``_merge_uuid_match`` scopes)."""
    wanted = sorted({u for u in uuids if u})
    held: set[str] = set()
    scoped = target_project_id is not None
    cols = (model.uuid, model.project_id) if scoped else (model.uuid,)
    for chunk in _chunks(wanted):
        for row in db.execute(select(*cols).where(model.uuid.in_(chunk))):
            if not scoped or row[1] == target_project_id:
                held.add(row[0])
    return held


def _capped(names: list[str]) -> list[str]:
    return names[:MERGE_ADDITIONS_NAME_CAP]


def build_merge_additions_preview(db: Session, file_path: Path, target_project_id: int) -> dict:
    """The `MergeAdditions` payload for merging ``file_path`` into ``target_project_id``."""
    with zipfile.ZipFile(str(file_path)) as zf:
        data = json.loads(zf.read("project.json"))
        removed = tomb.union(
            tomb.load(db, (data.get("project") or {}).get("project_uuid")),
            tomb.from_file(data.get("tombstones")),
        )

        # ── Sources ────────────────────────────────────────────────────────
        sources: list[dict] = []
        source_count = 0
        for key, model, kind in _SOURCES:
            items = data.get(key) or []
            held = _held(db, model, (i.get("uuid") for i in items), target_project_id=target_project_id)
            for i in items:
                if i.get("uuid") not in held:
                    source_count += 1
                    sources.append({"kind": kind, "name": i.get("name") or ""})

        # ── Participants ───────────────────────────────────────────────────
        local_by_uuid: dict[str, int] = {}
        local_by_identifier: dict[str, int] = {}
        for pid, puuid, ident in db.execute(
            select(Participant.id, Participant.uuid, Participant.identifier)
            .where(Participant.project_id == target_project_id)
        ):
            if puuid:
                local_by_uuid[puuid] = pid
            local_by_identifier[ident] = pid
        withdrawn_people: set = set()
        local_participant: dict = {}          # file participant id -> local participant id
        new_people: list[str] = []
        for p in data.get("participants") or []:
            oid = p.get("_original_id")
            # The import's own predicate (`Tombstones.withdrawn_participant`): someone
            # re-instated under a withdrawn identifier (D12) is NOT withdrawn, and a
            # preview that disagreed with the merge about a person is the defect.
            if removed.withdrawn_participant(p.get("uuid"), p.get("identifier")):
                withdrawn_people.add(oid)   # 🔴 counted only — never appended to a name list
                continue
            local = local_by_uuid.get(p.get("uuid")) if p.get("uuid") else None
            if local is None:
                local = local_by_identifier.get(p.get("identifier"))
            if local is None:
                new_people.append(p.get("identifier") or "")
            else:
                local_participant[oid] = local

        withdrawn_items = sum(
            1 for sp in data.get("speakers") or [] if removed.has(tomb.SPEAKER, sp.get("uuid"))
        )

        # ── Datasets ───────────────────────────────────────────────────────
        local_managed = {
            kind: did for did, kind in db.execute(
                select(Dataset.id, Dataset.managed_kind).where(
                    Dataset.project_id == target_project_id, Dataset.managed_kind.isnot(None))
            )
        }
        file_datasets = data.get("datasets") or []
        held_datasets = _held(
            db, Dataset, (d.get("uuid") for d in file_datasets), target_project_id=target_project_id)
        dataset_name: dict = {}
        new_dataset_ids: list = []
        matched_managed: dict = {}            # file dataset id -> local managed dataset id
        for d in file_datasets:
            oid = d.get("_original_id")
            dataset_name[oid] = d.get("name") or ""
            kind = d.get("managed_kind")
            if kind and kind in local_managed:
                matched_managed[oid] = local_managed[kind]
            elif d.get("uuid") not in held_datasets:
                new_dataset_ids.append(oid)
        new_dataset_set = set(new_dataset_ids)
        managed_rows: set[tuple[int, int]] = set()
        if matched_managed:
            managed_rows = {
                (did, pid) for did, pid in db.execute(
                    select(DatasetRow.dataset_id, DatasetRow.participant_id).where(
                        DatasetRow.dataset_id.in_(sorted(set(matched_managed.values()))),
                        DatasetRow.participant_id.isnot(None))
                )
            }

        # ── Records (the one data-scaled pass: the `dataset_rows` member, read once) ──
        new_dataset_records: Counter = Counter()
        candidates: list[tuple] = []          # (uuid, file dataset id, file participant id)
        withdrawn_rows: set = set()
        for r in _entity_rows(zf, data, "dataset_rows"):
            if removed.has(tomb.DATASET_ROW, r.get("uuid")) or r.get("participant_id") in withdrawn_people:
                withdrawn_rows.add(r.get("_original_id"))
                continue
            if r.get("dataset_id") in new_dataset_set:
                new_dataset_records[r.get("dataset_id")] += 1
            else:
                candidates.append((r.get("uuid"), r.get("dataset_id"), r.get("participant_id")))
        withdrawn_items += len(withdrawn_rows)
        held_rows = _held(db, DatasetRow, (c[0] for c in candidates), target_project_id=None)
        added_records: Counter = Counter()
        for ruuid, fdid, fpid in candidates:
            if ruuid in held_rows:
                continue
            local_did = matched_managed.get(fdid)
            if local_did is not None and (local_did, local_participant.get(fpid)) in managed_rows:
                continue  # #921 — a participant table's record matches on its participant
            added_records[fdid] += 1

        # ── Quotes and notes ───────────────────────────────────────────────
        # The merge decides what is a withdrawn person's BEFORE it asks what the target
        # holds, and so does this: those are counted as left out whatever else is true.
        blanked = removed.uuids.get(tomb.SEGMENT_BLANKED, set())
        all_excerpts = data.get("excerpts") or []
        all_notes = data.get("notes") or []
        excerpts = [e for e in all_excerpts if not removed.has(tomb.EXCERPT, e.get("uuid"))]
        notes = [n for n in all_notes if not removed.has(tomb.NOTE, n.get("uuid"))]
        skipped = (len(all_excerpts) - len(excerpts)) + (len(all_notes) - len(notes))

        # The file's turns behind those quotes: which are blanked (a withdrawal's), and
        # which the target holds (where a same-shape quote is a duplicate).
        wanted_segments = {e.get("segment_id") for e in excerpts if e.get("segment_id") is not None}
        seg_uuid: dict = {}
        blanked_segments: set = set()
        if wanted_segments or blanked:
            for sg in _entity_rows(zf, data, "segments"):
                oid = sg.get("_original_id")
                if oid in wanted_segments:
                    seg_uuid[oid] = sg.get("uuid")
                if blanked and sg.get("uuid") in blanked:
                    blanked_segments.add(oid)
        # A value of a withdrawn record: its quotes and notes are left out with it.
        value_refs = {x.get("dataset_value_id") for x in excerpts + notes
                      if x.get("dataset_value_id") is not None}
        withdrawn_values: set = set()
        if value_refs and withdrawn_rows:
            for v in _entity_rows(zf, data, "dataset_values"):
                if v.get("_original_id") in value_refs and v.get("row_id") in withdrawn_rows:
                    withdrawn_values.add(v.get("_original_id"))

        kept_excerpts = []
        for e in excerpts:
            if e.get("segment_id") in blanked_segments or e.get("dataset_value_id") in withdrawn_values:
                skipped += 1
            else:
                kept_excerpts.append(e)
        held_excerpts = _held(
            db, Excerpt, (e.get("uuid") for e in kept_excerpts), target_project_id=target_project_id)
        kept_excerpts = [e for e in kept_excerpts if e.get("uuid") not in held_excerpts]
        local_seg: dict[str, int] = {}
        seg_uuids = sorted({u for u in seg_uuid.values() if u})
        for chunk in _chunks(seg_uuids):
            local_seg.update(db.execute(
                select(Segment.uuid, Segment.id).where(Segment.uuid.in_(chunk))).all())
        shapes: set[tuple] = set()
        for chunk in _chunks(sorted(set(local_seg.values()))):
            shapes.update(db.execute(
                select(Excerpt.segment_id, Excerpt.start_offset, Excerpt.end_offset,
                       Excerpt.start_time, Excerpt.end_time)
                .where(Excerpt.segment_id.in_(chunk))).all())
        quotes = 0
        for e in kept_excerpts:
            local_segment = local_seg.get(seg_uuid.get(e.get("segment_id")))
            if local_segment is not None and (
                local_segment, e.get("start_offset"), e.get("end_offset"),
                e.get("start_time"), e.get("end_time"),
            ) in shapes:
                continue  # the same quote, deleted and made again — a duplicate, not an addition
            quotes += 1

        kept_notes = []
        for n in notes:
            on_withdrawn_value = n.get("dataset_value_id") in withdrawn_values and not any(
                n.get(k) for k in ("conversation_id", "document_id", "observation_id"))
            if on_withdrawn_value:
                skipped += 1
            else:
                kept_notes.append(n)
        withdrawn_items += skipped
        held_notes = _held(db, Note, (n.get("uuid") for n in kept_notes), target_project_id=None)
        note_count = sum(1 for n in kept_notes if n.get("uuid") not in held_notes)

        memos = data.get("memos") or []
        held_memos = _held(db, Memo, (m.get("uuid") for m in memos), target_project_id=target_project_id)
        memo_count = sum(1 for m in memos if m.get("uuid") not in held_memos)

    return {
        "sources": _capped(sources),
        "source_count": source_count,
        "participants": _capped(new_people),
        "participant_count": len(new_people),
        "datasets": _capped([
            {"name": dataset_name[oid], "records": new_dataset_records[oid]} for oid in new_dataset_ids
        ]),
        "dataset_count": len(new_dataset_ids),
        # Not capped: one entry per dataset the target already has (bounded by the
        # project's dataset count), so the per-dataset breakdown always sums to the total.
        "records": [
            {"dataset": dataset_name.get(oid, ""), "count": c}
            for oid, c in sorted(added_records.items(), key=lambda kv: dataset_name.get(kv[0], ""))
        ],
        "record_count": sum(added_records.values()),
        "quotes": quotes,
        "notes": note_count,
        "memos": memo_count,
        "withdrawn_participants": len(withdrawn_people),
        "withdrawn_items": withdrawn_items,
        # #1470 (D70) — the merge's own refusal, predicted by the merge's own function.
        "withdrawn_here": tomb.withdrawn_but_held(db, target_project_id, removed),
    }
