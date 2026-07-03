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
from ..models.segment import Segment
from ..models.user import User
from .consensus import _decide_consensus, has_disagreement
from .irr import gather_coder_applications

# Frontend source_type ←→ the gather's source-key tag.
_SOURCE_TAG = {"conversation": "conv", "document": "doc", "column": "col"}
_SOURCE_TYPE = {"conv": "conversation", "doc": "document", "col": "column"}
_UNIT_TYPE = {"seg": "segment", "val": "dataset_value"}
_SOURCE_RANK = {"conv": 0, "doc": 1, "col": 2}

_UNAVAILABLE_REASON = (
    "Reconciliation needs at least 2 coders with coding on a shared source."
)


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
    coder_id_list, applied, unit_source, engaged, multi_sources = gather_coder_applications(
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

    # Per-unit records (no text/labels yet — those are batched for the page only).
    records = []
    for u in unit_keys:
        src = unit_source[u]
        engaged_coders = engaged[src]
        target_voters = applied.get(u, {})  # TARGET-level: who coded THIS unit
        # SOURCE-level projection: every engaged coder, blank set if uncoded here.
        projection = {cid: target_voters.get(cid, set()) for cid in engaged_coders}
        disagree = has_disagreement(projection)
        if disagreements_only and not disagree:
            continue
        decisions = _decide_consensus(target_voters)
        records.append({
            "u": u,
            "src": src,
            "by_coder": {str(cid): sorted(target_voters.get(cid, set())) for cid in engaged_coders},
            "engaged": sorted(engaged_coders),
            "consensus": [eff for (eff, _r, _a, _v) in decisions],
            "consensus_context": {
                str(eff): {"rule": rule, "agree": agree, "voters": voters}
                for (eff, rule, agree, voters) in decisions
            },
            "has_disagreement": disagree,
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
    seg_text = dict(db.query(Segment.id, Segment.text).filter(Segment.id.in_(page_seg)).all()) if page_seg else {}
    val_text = dict(db.query(DatasetValue.id, DatasetValue.value_text).filter(DatasetValue.id.in_(page_val)).all()) if page_val else {}

    page_convs = [sid for r in page for (t, sid) in [r["src"]] if t == "conv"]
    page_docs = [sid for r in page for (t, sid) in [r["src"]] if t == "doc"]
    page_cols = [sid for r in page for (t, sid) in [r["src"]] if t == "col"]
    conv_names = dict(db.query(Conversation.id, Conversation.name).filter(Conversation.id.in_(page_convs)).all()) if page_convs else {}
    doc_names = dict(db.query(Document.id, Document.name).filter(Document.id.in_(page_docs)).all()) if page_docs else {}
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
        t, sid = src
        if t == "conv":
            return conv_names.get(sid, "")
        if t == "doc":
            return doc_names.get(sid, "")
        return col_labels.get(sid, "")

    # Code legend: the EFFECTIVE codes referenced on the page. Effective ids are real
    # canonical Code ids, so naming them directly gives the group's canonical label.
    page_codes: set[int] = set()
    for r in page:
        for codes in r["by_coder"].values():
            page_codes.update(codes)
        page_codes.update(r["consensus"])
    codes_legend = (
        [{"id": cid, "name": name, "color": color}
         for cid, name, color in db.query(Code.id, Code.name, Code.color).filter(Code.id.in_(page_codes)).all()]
        if page_codes else []
    )

    units = []
    for r in page:
        tag, uid = r["u"]
        src_t, src_id = r["src"]
        text = seg_text.get(uid) if tag == "seg" else val_text.get(uid)
        units.append({
            "unit_type": _UNIT_TYPE[tag],
            "unit_id": uid,
            "source_type": _SOURCE_TYPE[src_t],
            "source_id": src_id,
            "source_label": _source_label(r["src"]),
            "text": text or "",
            "by_coder": r["by_coder"],
            "engaged": r["engaged"],
            "consensus": r["consensus"],
            "consensus_context": r["consensus_context"],
            "has_disagreement": r["has_disagreement"],
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
