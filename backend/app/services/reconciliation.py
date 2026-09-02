"""Reconciliation grid data (Track J · J2-5, M-1).

Pivots the multi-coder coding layers into per-unit rows for the reconciliation
view: what each coder applied, the LIVE-derived consensus, and a disagreement flag.

Two voter models, deliberately different (the subtlety that makes the grid correct):

- **Consensus column = TARGET-level voters** (the coders who coded THIS unit) via
  ``_decide_consensus`` — byte-identical to the materialized consensus layer (same
  DEC-D rule), just computed live so it's always fresh.
- **by_coder + has_disagreement = SOURCE-level engagement** (Option B): every coder
  who coded anywhere in the unit's source, with a blank set for one who reviewed the
  source but left this unit uncoded (explicit absence) — so the grid surfaces
  "Alice coded X, Bob reviewed the source but left this blank" as a disagreement.

Read-only: the grid reconciles by editing a coder's OWN layer through the normal
apply/remove endpoints (which mark consensus stale); the consensus column is always
server-derived here, never written from the grid. Reuses the shared Option-B gather
(``irr.gather_coder_applications``) + the consensus rule helpers so the consensus
column can never drift from the stored layer.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.document import Document
from ..models.observation import Observation
from ..models.segment import Segment
from ..models.user import User
from .coding_layers import build_effective_code_map, resolve_effective_code
from .consensus import (
    _decide_consensus,
    _decide_magnitude,
    _rating_values,
    has_disagreement,
    has_rating_disagreement,
    scales_for_project,
)
from .irr import gather_coder_applications
from .magnitude import read_scale

# Frontend source_type ←→ the gather's source-key tag. All four maps move together:
# an "obs" tag missing from _SOURCE_TYPE raised KeyError → 500, while the same
# missing key in _SOURCE_RANK degraded silently — two failure modes for one
# omission, in one file. _UNIT_TYPE deliberately stays 2-valued: a clip IS a
# Segment, so its unit key is ("seg", id) like any other.
_SOURCE_TAG = {"conversation": "conv", "document": "doc",
               "observation": "obs", "column": "col"}
_SOURCE_TYPE = {"conv": "conversation", "doc": "document",
                "obs": "observation", "col": "column"}
_UNIT_TYPE = {"seg": "segment", "val": "dataset_value"}
_SOURCE_RANK = {"conv": 0, "doc": 1, "obs": 2, "col": 3}

# The router validates against this so an unknown kind 400s instead of silently
# resolving to a sentinel that matches nothing.
RECONCILIATION_SOURCE_TYPES = frozenset(_SOURCE_TAG)

_UNAVAILABLE_REASON = (
    "Reconciliation needs at least 2 coders with coding on a shared source."
)


def _merge_conflicts(db: Session, project_id: int) -> dict[tuple, dict[int, dict[int, float]]]:
    """``{unit_key: {coder_id: {raw_code_id: the rating the merged copy carried}}}``
    for every application whose merge left an unresolved disagreement (#35).

    Keyed exactly like the shared gather's ``ratings`` so the same canonical
    filter applies. Scoped by the project's codes (bounded by the codebook, never
    by rows) and by the consensus filter — a consensus row is never merged.
    """
    from ..models.code_application import CodeApplication
    from .coding_layers import non_consensus_filter

    out: dict[tuple, dict[int, dict[int, float]]] = {}
    rows = (
        db.query(
            CodeApplication.segment_id, CodeApplication.dataset_value_id,
            CodeApplication.user_id, CodeApplication.code_id, CodeApplication.magnitude_conflict,
        )
        .join(Code, CodeApplication.code_id == Code.id)
        .filter(
            Code.project_id == project_id,
            CodeApplication.magnitude_conflict.isnot(None),
            non_consensus_filter(),
        )
        .all()
    )
    for seg_id, val_id, uid, code_id, incoming in rows:
        ukey = ("seg", seg_id) if seg_id is not None else ("val", val_id)
        out.setdefault(ukey, {}).setdefault(uid, {})[code_id] = incoming
    return out


def build_reconciliation(
    db: Session,
    project_id: int,
    *,
    source_type: str | None = None,
    source_id: int | None = None,
    disagreements_only: bool = False,
    coder_ids: list[int] | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Build one page of reconciliation rows. See module docstring for the voter
    models. ``available=False`` (mirrors IRR) when <2 roster coders share a source.
    """
    # `ratings` (#35) — each coder's magnitude per application, keyed by the RAW
    # code; the grid shows them beside the codes and derives the rating consensus
    # live, exactly as it derives the categorical one.
    coder_id_list, applied, unit_source, engaged, multi_sources, ratings = gather_coder_applications(
        db, project_id, coder_ids
    )
    coders = (
        [{"id": cid, "name": name}
         for cid, name in db.query(User.id, User.username)
         .filter(User.id.in_(coder_id_list)).all()]
        if coder_id_list else []
    )
    coders.sort(key=lambda c: c["id"])  # coder_id_list is sorted ascending

    if len(coder_id_list) < 2 or not multi_sources:
        return {
            "available": False,
            "reason": _UNAVAILABLE_REASON,
            "n_coders": len(coder_id_list),
            "coders": coders,
            "codes": [],
            "units": [],
            "total": 0,
            "has_more": False,
        }

    # Candidate units = every in-play unit of a multi-coder source, optionally
    # narrowed to one source.
    want_src: tuple | None = None
    if source_type and source_id is not None:
        tag = _SOURCE_TAG.get(source_type)
        want_src = (tag, source_id) if tag is not None else ("__none__", -1)
    unit_keys = [
        u for u, src in unit_source.items()
        if src in multi_sources and (want_src is None or src == want_src)
    ]

    # #35 — the declared instruments, and the equivalence map that says which
    # raw code is its group's canonical: a rating rides the grid ONLY under the
    # canonical id, because that is the id the chips are keyed by and the scale
    # they would render it against (`_rating_values` states the pooling rule).
    scales = scales_for_project(db, project_id)
    effective_map = build_effective_code_map(db, project_id) if scales else {}
    # #35 — the merge disagreement flags: applications whose merged copy carried
    # a DIFFERENT rating. Bounded by the number of unresolved conflicts, which is
    # small, so a dedicated query beats widening the shared gather's tuple again.
    conflicts = _merge_conflicts(db, project_id) if scales else {}

    def _canonical_ratings(unit_ratings: dict[int, dict[int, float | None]], coder_ids_here) -> dict:
        out: dict[int, dict[int, float]] = {}
        for cid in coder_ids_here:
            mine = {
                code_id: value
                for code_id, value in unit_ratings.get(cid, {}).items()
                if value is not None and code_id in scales
                and resolve_effective_code(effective_map, code_id) == code_id
            }
            if mine:
                out[cid] = mine
        return out

    # Per-unit records (no text/labels yet — those are batched for the page only).
    records = []
    for u in unit_keys:
        src = unit_source[u]
        engaged_coders = engaged[src]
        target_voters = applied.get(u, {})  # TARGET-level: who coded THIS unit
        # SOURCE-level projection: every engaged coder, blank set if uncoded here.
        projection = {cid: target_voters.get(cid, set()) for cid in engaged_coders}
        disagree = has_disagreement(projection)
        unit_ratings = ratings.get(u, {})
        canonical_ratings = _canonical_ratings(unit_ratings, engaged_coders)
        # A SECOND fact, never folded into the first: codes can agree while the
        # ratings on them do not, and the row must be able to say which.
        rating_disagree = has_rating_disagreement(canonical_ratings, scales)
        # And a THIRD: a coder's own two copies disagreed at a merge (the
        # target's rating was kept, the other value flagged). Adjudicated by
        # re-rating, so it belongs in the review set until then.
        unit_conflicts = _canonical_ratings(conflicts.get(u, {}), engaged_coders)
        merge_conflict = bool(unit_conflicts)
        if disagreements_only and not (disagree or rating_disagree or merge_conflict):
            continue
        decisions = _decide_consensus(target_voters)
        context: dict[str, dict] = {}
        for eff, rule, agree, voters in decisions:
            entry: dict = {"rule": rule, "agree": agree, "voters": voters}
            if eff in scales:
                rating = _decide_magnitude(_rating_values(unit_ratings, target_voters, eff), scales[eff])
                if rating is not None:
                    entry["magnitude"] = rating
            context[str(eff)] = entry
        records.append({
            "u": u,
            "src": src,
            "by_coder": {str(cid): sorted(target_voters.get(cid, set())) for cid in engaged_coders},
            "ratings_by_coder": {
                str(cid): {str(code_id): value for code_id, value in mine.items()}
                for cid, mine in canonical_ratings.items()
            },
            "rating_conflicts_by_coder": {
                str(cid): {str(code_id): value for code_id, value in mine.items()}
                for cid, mine in unit_conflicts.items()
            },
            "engaged": sorted(engaged_coders),
            "consensus": [eff for (eff, _r, _a, _v) in decisions],
            "consensus_context": context,
            "has_disagreement": disagree,
            "has_rating_disagreement": rating_disagree,
            "has_merge_conflict": merge_conflict,
        })

    # Deterministic read order: source group, then segment sequence / value id.
    seg_ids = [uid for r in records for (t, uid) in [r["u"]] if t == "seg"]
    seq = (
        dict(db.query(Segment.id, Segment.sequence_order).filter(Segment.id.in_(seg_ids)).all())
        if seg_ids else {}
    )

    def _sort_key(r):
        tag, uid = r["u"]
        src_t, src_id = r["src"]
        ordinal = seq.get(uid, 0) if tag == "seg" else uid
        return (_SOURCE_RANK.get(src_t, 9), src_id, ordinal, uid)

    records.sort(key=_sort_key)

    total = len(records)
    page = records[offset:offset + limit]
    has_more = offset + limit < total

    # Batch text + source labels + code legend for THE PAGE ONLY.
    page_seg = [uid for r in page for (t, uid) in [r["u"]] if t == "seg"]
    page_val = [uid for r in page for (t, uid) in [r["u"]] if t == "val"]
    # Times ride the SAME query as the text — a clip's identity is its range, and
    # fetching it separately would be a round-trip for data already in flight.
    seg_rows = (
        db.query(Segment.id, Segment.text, Segment.start_time, Segment.end_time)
        .filter(Segment.id.in_(page_seg)).all() if page_seg else []
    )
    seg_text = {sid: text for sid, text, _s, _e in seg_rows}
    seg_times = {sid: (start, end) for sid, _t, start, end in seg_rows}
    val_text = dict(db.query(DatasetValue.id, DatasetValue.value_text).filter(DatasetValue.id.in_(page_val)).all()) if page_val else {}

    page_convs = [sid for r in page for (t, sid) in [r["src"]] if t == "conv"]
    page_docs = [sid for r in page for (t, sid) in [r["src"]] if t == "doc"]
    page_obs = [sid for r in page for (t, sid) in [r["src"]] if t == "obs"]
    page_cols = [sid for r in page for (t, sid) in [r["src"]] if t == "col"]
    conv_names = dict(db.query(Conversation.id, Conversation.name).filter(Conversation.id.in_(page_convs)).all()) if page_convs else {}
    doc_names = dict(db.query(Document.id, Document.name).filter(Document.id.in_(page_docs)).all()) if page_docs else {}
    obs_names = dict(db.query(Observation.id, Observation.name).filter(Observation.id.in_(page_obs)).all()) if page_obs else {}
    col_labels: dict[int, str] = {}
    if page_cols:
        for col_id, col_name, col_text, ds_name in (
            db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text, Dataset.name)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(DatasetColumn.id.in_(page_cols)).all()
        ):
            label = col_name or (col_text[:60] if col_text else "")
            col_labels[col_id] = f"{ds_name} › {label}" if label else ds_name

    def _source_label(src) -> str:
        # Every kind gets an EXPLICIT branch. `col` used to be the fall-through
        # default, so a tag nobody had handled yet rendered a silently blank
        # source name instead of failing.
        t, sid = src
        if t == "conv":
            return conv_names.get(sid, "")
        if t == "doc":
            return doc_names.get(sid, "")
        if t == "obs":
            return obs_names.get(sid, "")
        if t == "col":
            return col_labels.get(sid, "")
        raise KeyError(f"unhandled source tag: {t!r}")

    # Code legend: the EFFECTIVE codes referenced on the page. Effective ids are real
    # canonical Code ids, so naming them directly gives the group's canonical label.
    page_codes: set[int] = set()
    for r in page:
        for codes in r["by_coder"].values():
            page_codes.update(codes)
        page_codes.update(r["consensus"])
    # #35 — the legend carries each code's declared SCALE, so a rating in a cell
    # renders against the instrument it was given on (a bare 7 says nothing).
    codes_legend = (
        [{"id": c.id, "name": c.name, "color": c.color, "scale": read_scale(c)}
         for c in db.query(Code).filter(Code.id.in_(page_codes)).all()]
        if page_codes else []
    )

    units = []
    for r in page:
        tag, uid = r["u"]
        src_t, src_id = r["src"]
        text = seg_text.get(uid) if tag == "seg" else val_text.get(uid)
        # A clip's identity to a researcher is its TIME RANGE — `Segment.text` on a
        # clip holds only its label, routinely empty. Conversation segments carry
        # times too, so these are not observation-only fields.
        start_time, end_time = seg_times.get(uid, (None, None)) if tag == "seg" else (None, None)
        units.append({
            "unit_type": _UNIT_TYPE[tag],
            "unit_id": uid,
            "source_type": _SOURCE_TYPE[src_t],
            "source_id": src_id,
            "source_label": _source_label(r["src"]),
            "text": text or "",
            "start_time": start_time,
            "end_time": end_time,
            "by_coder": r["by_coder"],
            "ratings_by_coder": r["ratings_by_coder"],
            "rating_conflicts_by_coder": r["rating_conflicts_by_coder"],
            "engaged": r["engaged"],
            "consensus": r["consensus"],
            "consensus_context": r["consensus_context"],
            "has_disagreement": r["has_disagreement"],
            "has_rating_disagreement": r["has_rating_disagreement"],
            "has_merge_conflict": r["has_merge_conflict"],
        })

    return {
        "available": True,
        "reason": None,
        "n_coders": len(coder_id_list),
        "coders": coders,
        "codes": codes_legend,
        "units": units,
        "total": total,
        "has_more": has_more,
    }
