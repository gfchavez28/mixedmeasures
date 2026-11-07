"""Reconciliation grid data (Track J · J2-5, M-1).

Pivots the multi-coder coding layers into per-unit rows for the reconciliation
view: what each coder applied, the LIVE-derived consensus, and a disagreement flag.

Two voter models, deliberately different (the subtlety that makes the grid correct):

- **Consensus column = TARGET-level voters** (the coders who coded THIS unit) via
  ``consensus.decide_target`` — the SAME per-target decision the materialized
  layer is written from (the DEC-D rule plus the code-set decider), just computed
  live so it's always fresh.
- **by_coder + has_disagreement = SOURCE-level engagement** (Option B): every coder
  who coded anywhere in the unit's source, with a blank set for one who reviewed the
  source but left this unit uncoded (explicit absence) — so the grid surfaces
  "Alice coded X, Bob reviewed the source but left this blank" as a disagreement.

Read-only: the grid reconciles by editing a coder's OWN layer through the normal
apply/remove endpoints (which mark consensus stale); the consensus column is always
server-derived here, never written from the grid. Reuses the shared Option-B gather
(``irr.gather_coder_applications``) + the consensus rule helpers so the consensus
column can never drift from the stored layer.

🔴 **A segment GROUP is ONE row (#1334 unit 3, D35, 1.5.9)** — the unit the stored
layer decides since session A (`consensus.TARGET_GROUP`). Its row is ``unit_type:
"group"`` with the group's id; ``member_segment_ids`` lists its visible turns in
transcript order and ``anchor_segment_id`` (the first) is the turn the row's link
and own-cell actions address — remove and rate find the coder's row on any member
(D36), and an apply fans out. A coder whose turns carry two ratings of one code has
NO rating on the group (D22), so the grid SAYS so as a fifth review fact (D37,
``group_rating_conflicts_by_coder``) rather than letting the rating leave the median
in silence.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models.code import Code
# ⚠️ Conversation / Document / Observation / Dataset / DatasetColumn are no
# longer imported here: naming a source is `source_labels.label_sources`' job
# now, and leaving the imports behind would make this module look like it still
# queries those tables.
from ..models.dataset import DatasetValue
from ..models.segment import Segment
from ..models.user import User
from ..routers.helpers import visible_segment_filter
from .coding_layers import (
    build_effective_code_map,
    consensus_scoped_segments,
    non_consensus_filter,
    resolve_effective_code,
    visible_target_filter,
)
from .code_sets import (
    SET_MULTIPLE,
    build_code_set_index,
    comparable_choice,
    selection_for,
)
from .consensus import (
    _decide_magnitude,
    _rating_values,
    decide_target,
    has_disagreement,
    has_rating_disagreement,
    scales_for_project,
)
from .id_set import in_id_set
from .irr import gather_coder_applications
from .magnitude import read_scale
from .segment_groups import (
    GROUP_RATING_CONFLICT,
    UNIT_TAG_GROUP,
    merge_unit_rating,
    unit_key,
)
from .source_labels import label_sources

# Frontend source_type ←→ the gather's source-key tag. All four maps move together:
# an "obs" tag missing from _SOURCE_TYPE raised KeyError → 500, while the same
# missing key in _SOURCE_RANK degraded silently — two failure modes for one
# omission, in one file. A clip IS a Segment, so its unit key is ("seg", id) like
# any other; a segment GROUP is a unit kind of its own (#1334 unit 3, D35) — the
# gather's ("grp", id) — because its row names no single turn. ⚠️ The client's
# `ReconciliationUnit.unit_type` union mirrors these VALUES and the backend field
# is a plain `str`, so a kind missing there fails silently in the browser:
# `test_reconciliation_groups.py` reads the TypeScript and holds the two equal.
_SOURCE_TAG = {"conversation": "conv", "document": "doc",
               "observation": "obs", "column": "col"}
_SOURCE_TYPE = {"conv": "conversation", "doc": "document",
                "obs": "observation", "col": "column"}
_UNIT_TYPE = {"seg": "segment", "val": "dataset_value", UNIT_TAG_GROUP: "group"}
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
    filter applies — a grouped turn's flag on its GROUP (#1334 unit 3, D35), the
    grid's unit. Scoped by the project's codes (bounded by the codebook, never by
    rows), by the consensus filter — a consensus row is never merged — and to
    VISIBLE targets: a merged-away turn stays in its group, hidden, and a flag no
    one can reach must not put the group in the review set (#500). On a group, a
    coder's flags on two members are one fact; the first in transcript order is
    the one shown (rating again clears every member's, through the fan-out).
    """
    from ..models.code_application import CodeApplication

    out: dict[tuple, dict[int, dict[int, float]]] = {}
    rows = (
        db.query(
            CodeApplication.segment_id, Segment.group_id, CodeApplication.dataset_value_id,
            CodeApplication.user_id, CodeApplication.code_id, CodeApplication.magnitude_conflict,
        )
        .join(Code, CodeApplication.code_id == Code.id)
        .outerjoin(Segment, CodeApplication.segment_id == Segment.id)
        .filter(
            Code.project_id == project_id,
            CodeApplication.magnitude_conflict.isnot(None),
            non_consensus_filter(),
            visible_target_filter(),
        )
        .order_by(Segment.sequence_order, Segment.id, CodeApplication.id)
        .all()
    )
    for seg_id, group_id, val_id, uid, code_id, incoming in rows:
        ukey = unit_key(seg_id, group_id) if seg_id is not None else ("val", val_id)
        out.setdefault(ukey, {}).setdefault(uid, {}).setdefault(code_id, incoming)
    return out


def _group_rating_conflicts(
    db: Session, project_id: int,
) -> dict[tuple, dict[int, dict[int, list[float]]]]:
    """``{("grp", id): {user_id: {raw_code_id: [their ratings, ascending]}}}`` for
    every user who rated one code DIFFERENTLY on two visible turns of one group
    (#1334 unit 3, D37).

    The gather settles that state to no rating (D22 — never a number between the
    two), so the coder's rating leaves the group's median; this is the grid SAYING
    so, on the one screen built to adjudicate. Decided by the gather's own rule,
    `segment_groups.merge_unit_rating`, so "two ratings" here and "no rating" there
    cannot mean two things. ⚠️ Its OWN bounded query — rated applications on
    grouped turns, which are made by hand — never a seventh value on the shared
    gather's tuple (the `_merge_conflicts` precedent).

    The rows are the gather's grouped rows as far as a TURN decides them — the
    project, visible turns (a hidden member's rating would change the fold),
    facilitator turns included. WHO counts and WHICH codes are the caller's:
    `_canonical_ratings` keeps the gather's engaged coders (its voting roster: no
    machine, no archived coder, never the consensus user) and scaled canonical
    codes (a universal code cannot declare a scale), so filters for those here
    could never change the answer (#941).
    """
    from ..models.code_application import CodeApplication

    folded: dict[tuple[int, int, int], object] = {}
    seen: dict[tuple[int, int, int], set[float]] = {}
    rows = (
        consensus_scoped_segments(
            db.query(Segment.group_id, CodeApplication.user_id,
                     CodeApplication.code_id, CodeApplication.magnitude)
            .join(CodeApplication, CodeApplication.segment_id == Segment.id),
            project_id,
        )
        .filter(
            Segment.group_id.isnot(None),
            *visible_segment_filter(),
            # An unrated turn adds nothing to the fold, and a None among the
            # values would break the ascending list.
            CodeApplication.magnitude.isnot(None),
        )
        .all()
    )
    for group_id, uid, code_id, value in rows:
        key = (group_id, uid, code_id)
        folded[key] = merge_unit_rating(folded[key], value) if key in folded else value
        seen.setdefault(key, set()).add(value)
    out: dict[tuple, dict[int, dict[int, list[float]]]] = {}
    for (group_id, uid, code_id), state in folded.items():
        if state is GROUP_RATING_CONFLICT:
            out.setdefault((UNIT_TAG_GROUP, group_id), {}).setdefault(uid, {})[code_id] = sorted(
                seen[(group_id, uid, code_id)]
            )
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
    #
    # 🔴 #1333 / #1334 — the grid adjudicates the CONSENSUS LAYER, so its units are
    # the units that layer DECIDES: a segment group once (unit 3, D35 — the writer
    # decides a group as one ballot since session A, `consensus.TARGET_GROUP`), and
    # facilitator turns included, because the layer covers them and the analysis
    # view can show them, so a coded prompt is still coding to reconcile. The
    # agreement FIGURES drop prompts (`compute_irr`'s stated `unit_basis`), so
    # interviewer turns are what keep this row count from being the Units column.
    coder_id_list, applied, unit_source, engaged, multi_sources, ratings = gather_coder_applications(
        db, project_id, coder_ids,
        include_facilitator_turns=True, collapse_groups=True,
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
    # ⚠️ Read UNCONDITIONALLY since row 48: it used to be gated on `scales`
    # because only the rating path needed it, and the set index needs it too —
    # two callers, one query, rather than the same map built twice per request.
    effective_map = build_effective_code_map(db, project_id)
    # #35 — the merge disagreement flags: applications whose merged copy carried
    # a DIFFERENT rating. Bounded by the number of unresolved conflicts, which is
    # small, so a dedicated query beats widening the shared gather's tuple again.
    conflicts = _merge_conflicts(db, project_id) if scales else {}
    # D37 — a coder's two ratings of one code on one group: no rating there, SAID.
    group_conflicts = _group_rating_conflicts(db, project_id) if scales else {}

    # Row 48 — read ONCE per call, like `scales`: the index is per project, so
    # building it per unit would be a query per row of the grid.
    set_index = build_code_set_index(db, project_id, effective_map)

    def _canonical_ratings(unit_ratings: dict[int, dict], coder_ids_here) -> dict:
        """Each coder's ratings that ride the grid: on a SCALED code, under its
        CANONICAL id. The value is a rating, or (D37) a coder's list of the two or
        more ratings they gave one group — the same rule, so the two cannot reach
        the grid by different routes."""
        out: dict[int, dict] = {}
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

    def _set_selections(index, projection, engaged_coders) -> tuple[dict, bool]:
        """Each engaged coder's chosen value per set, and whether they differ.

        ⚠️ **A coder with NO selection on an EXHAUSTIVE set is left out**, not
        recorded as disagreeing: on that kind of set a blank is missing data, so
        counting it against a colleague's choice would flag every partially
        worked unit for review. On an INCLUSIVE set the blank is the value "none
        of these" and does count — the same rule `_decide_set_selection` votes
        by, so the badge and the consensus column cannot tell different stories.
        """
        out: dict[str, dict[str, int | None]] = {}
        disagree = False
        for resolved in index.sets:
            if not resolved.member_ids:
                continue
            per_coder: dict[str, int | None] = {}
            comparable: list[int] = []
            for cid in engaged_coders:
                value = selection_for(projection.get(cid, set()), resolved)
                if value == SET_MULTIPLE:
                    # A contradiction is not a value — and it always needs
                    # review, whatever the others chose.
                    disagree = True
                # The rule itself is `comparable_choice`'s (#1017), shared with
                # the α matrix and the consensus decider.
                cell = comparable_choice(value, resolved.exhaustive)
                per_coder[str(cid)] = cell
                if cell is not None:
                    comparable.append(cell)
            if len(set(comparable)) > 1:
                disagree = True
            out[str(resolved.id)] = per_coder
        return out, disagree

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
        # Row 48 — a FOURTH review fact, never folded into the other three: the
        # engaged coders chose different values of one code set. A set
        # disagreement and a code disagreement are different things to fix, so
        # the badge must be able to say which.
        set_choices_by_coder, set_disagree = _set_selections(
            set_index, projection, engaged_coders,
        )
        # #1334 unit 3 (D37) — a FIFTH, groups only: a coder rated one code
        # differently on two turns of this group, so they have NO rating on it
        # and it is missing from `ratings_by_coder` and the median. Never folded
        # into the merge fact, whose words name a merged copy — a false cause
        # here. Rating again fans out to every turn and settles it.
        unit_group_conflicts = _canonical_ratings(group_conflicts.get(u, {}), engaged_coders)
        group_rating_conflict = bool(unit_group_conflicts)
        if disagreements_only and not (
            disagree or rating_disagree or merge_conflict or set_disagree
            or group_rating_conflict
        ):
            continue
        # 🔴 The SAME decision the consensus WRITER makes — `decide_target`, the
        # one per-target decision all four consumers call (#1018). This grid
        # derives consensus live so it is always fresh, and a live re-derivation
        # that disagreed with the stored layer would put a different answer on
        # the screen whose job is adjudication.
        decisions = decide_target(target_voters, set_index)
        context: dict[str, dict] = {}
        for eff, rule, agree, voters, _code_set in decisions:
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
            "consensus": [d.code_id for d in decisions],
            "consensus_context": context,
            "has_disagreement": disagree,
            "has_rating_disagreement": rating_disagree,
            "has_merge_conflict": merge_conflict,
            # Row 48 — the fourth fact and the values behind it. The grid renders
            # a set as a SINGLE-CHOICE control rather than as chips: chips say
            # "these applied", while a set says "this one was chosen from these",
            # and rendering a selection as one chip among others loses the fact
            # that the other values were on offer and were rejected — which is
            # the whole content of the judgement being adjudicated.
            "set_selection_by_coder": set_choices_by_coder,
            "has_set_disagreement": set_disagree,
            "group_rating_conflicts_by_coder": {
                str(cid): {str(code_id): values for code_id, values in mine.items()}
                for cid, mine in unit_group_conflicts.items()
            },
            "has_group_rating_conflict": group_rating_conflict,
        })

    # Deterministic read order: source group, then segment sequence / value id.
    seg_ids = [uid for r in records for (t, uid) in [r["u"]] if t == "seg"]
    seq = (
        dict(db.query(Segment.id, Segment.sequence_order).filter(Segment.id.in_(seg_ids)).all())
        if seg_ids else {}
    )
    # D35 — a group sorts by its FIRST visible turn, and its row lists every visible
    # turn: the members the gather folded (visible, facilitator turns included), in
    # transcript order. Ids only here; text is read for the page below. `in_id_set`
    # because the group count grows with the project (`sql-id-sets.md` §4).
    grp_ids = [uid for r in records for (t, uid) in [r["u"]] if t == UNIT_TAG_GROUP]
    members: dict[int, list[int]] = {}
    first_seq: dict[int, int] = {}
    if grp_ids:
        for sid, gid, order in (
            db.query(Segment.id, Segment.group_id, Segment.sequence_order)
            .filter(in_id_set(Segment.group_id, grp_ids), *visible_segment_filter())
            .order_by(Segment.group_id, Segment.sequence_order, Segment.id)
        ):
            members.setdefault(gid, []).append(sid)
            first_seq.setdefault(gid, order)

    def _sort_key(r):
        tag, uid = r["u"]
        src_t, src_id = r["src"]
        if tag == "seg":
            ordinal, tiebreak = seq.get(uid, 0), uid
        elif tag == UNIT_TAG_GROUP:
            ordinal, tiebreak = first_seq.get(uid, 0), members.get(uid, [uid])[0]
        else:
            ordinal, tiebreak = uid, uid
        return (_SOURCE_RANK.get(src_t, 9), src_id, ordinal, tiebreak)

    records.sort(key=_sort_key)

    total = len(records)
    page = records[offset:offset + limit]
    has_more = offset + limit < total

    # Batch text + source labels + code legend for THE PAGE ONLY. A group's text is
    # its members' — the turns, never the group id, are what carry words.
    page_seg = [uid for r in page for (t, uid) in [r["u"]] if t == "seg"]
    page_seg += [
        sid for r in page for (t, uid) in [r["u"]] if t == UNIT_TAG_GROUP
        for sid in members.get(uid, ())
    ]
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

    # 🔴 ONE implementation of "what is this source called", shared with the
    # rating sweep's queue (#35 variant B). It was inline here, four `IN`
    # queries and an explicit-branch resolver, and the sweep needed the same
    # four — which is where a copy stops being a copy and becomes the substrate
    # debt the arch-debt synthesis names. `label_sources` keeps the property
    # this version was careful about: every tag has a branch and an unknown one
    # RAISES, because `col` as a fall-through default once rendered a silently
    # blank source name for a tag nobody had handled.
    source_labels = label_sources(db, {r["src"] for r in page})

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
        member_ids: list[int] = []
        if tag == UNIT_TAG_GROUP:
            # D35 — the row names the GROUP; the turns it acts through are listed.
            # One turn per line, in transcript order, so the cell reads as the
            # passage the coders coded.
            member_ids = members.get(uid, [])
            text = "\n".join(seg_text[sid] for sid in member_ids if seg_text.get(sid))
            start_time = seg_times[member_ids[0]][0] if member_ids else None
            end_time = seg_times[member_ids[-1]][1] if member_ids else None
            anchor = member_ids[0] if member_ids else None
        elif tag == "seg":
            text = seg_text.get(uid)
            # A clip's identity to a researcher is its TIME RANGE — `Segment.text` on
            # a clip holds only its label, routinely empty. Conversation segments
            # carry times too, so these are not observation-only fields.
            start_time, end_time = seg_times.get(uid, (None, None))
            anchor = uid
        else:
            text = val_text.get(uid)
            start_time = end_time = anchor = None
        units.append({
            "unit_type": _UNIT_TYPE[tag],
            "unit_id": uid,
            "anchor_segment_id": anchor,
            "member_segment_ids": member_ids,
            "source_type": _SOURCE_TYPE[src_t],
            "source_id": src_id,
            "source_label": source_labels[r["src"]],
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
            "set_selection_by_coder": r["set_selection_by_coder"],
            "has_set_disagreement": r["has_set_disagreement"],
            "group_rating_conflicts_by_coder": r["group_rating_conflicts_by_coder"],
            "has_group_rating_conflict": r["has_group_rating_conflict"],
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
