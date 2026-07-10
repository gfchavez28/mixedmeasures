"""Analysis domain endpoints for grouping columns into analytical constructs."""

import json
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session, joinedload

from ..auth import get_current_user
from .auth import limiter
from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..schemas.analysis_domain import (
    AnalysisDomainCreate,
    AnalysisDomainBulkCreate,
    AnalysisDomainUpdate,
    AnalysisDomainAddMembers,
    AnalysisDomainRemoveMembers,
    DomainMemberInput,
    DomainMemberInfo,
    DomainReorderRequest,
    DomainMemberReorderRequest,
    EquivalenceGroupCreateInline,
    AnalysisDomainResponse,
    AnalysisDomainListResponse,
    BulkDomainCreateResult,
    DomainSuggestedItem,
    DomainSuggestion,
    DomainSuggestResponse,
)
from ..models.metric import MetricDefinition
from ..models.equivalence_group import EquivalenceGroup
from ..services.equivalence_validators import (
    assert_columns_not_already_linked,
    assert_cross_dataset_members_are_paired,
    assert_domain_members_numeric_eligible,
)
from ..services.staleness import mark_metrics_stale
from ..services.audit import log_action

from .helpers import _get_project_or_404
from .equivalence import (
    _validate_columns_belong_to_project,
    _assert_columns_unique_per_dataset,
)

router = APIRouter(
    prefix="/api/projects/{project_id}/analysis-domains",
    tags=["analysis-domains"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_domain_or_404(db: Session, project_id: int, domain_id: int) -> AnalysisDomain:
    domain = (
        db.query(AnalysisDomain)
        .filter(
            AnalysisDomain.id == domain_id,
            AnalysisDomain.project_id == project_id,
        )
        .first()
    )
    if not domain:
        raise HTTPException(status_code=404, detail="Analysis domain not found")
    return domain


def _validate_members_in_project(
    db: Session, project_id: int, members: list[DomainMemberInput],
) -> None:
    """Validate that all member references belong to this project."""
    col_ids = [m.member_id for m in members if m.member_type == "column"]

    if col_ids:
        found = (
            db.query(DatasetColumn.id)
            .join(Dataset)
            .filter(
                DatasetColumn.id.in_(col_ids),
                Dataset.project_id == project_id,
            )
            .all()
        )
        found_ids = {r[0] for r in found}
        missing = set(col_ids) - found_ids
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Columns not found in project: {sorted(missing)}",
            )


# NOTE: the cross-dataset pairing validator (formerly the private
# `_assert_cross_dataset_members_are_paired` defined here) was extracted to
# `services/equivalence_validators.py` as public `assert_cross_dataset_members_are_paired`
# so router-side callers (`equivalence.py::swap_columns`,
# `crosswalk.py::move_members`, `equivalence.py::remove_columns`/
# `delete_group`/`merge_groups` for #298) can import from a single
# non-router location and avoid router → router import cycles.
# See the internal design notes


def _build_domain_responses(
    domains: list[AnalysisDomain], db: Session,
) -> list[AnalysisDomainResponse]:
    """Build response schemas for multiple domains with batch-loaded member references."""
    if not domains:
        return []

    # Collect all column member references across all domains
    all_col_ids: set[int] = set()
    for domain in domains:
        for m in domain.members:
            if m.member_type == "column":
                all_col_ids.add(m.member_id)

    # Batch load columns with dataset names
    col_map: dict[int, DatasetColumn] = {}
    if all_col_ids:
        columns = (
            db.query(DatasetColumn)
            .options(joinedload(DatasetColumn.dataset))
            .filter(DatasetColumn.id.in_(all_col_ids))
            .all()
        )
        for col in columns:
            col_map[col.id] = col

    # Build responses
    responses = []
    for domain in domains:
        resolved_members: list[DomainMemberInfo] = []
        for m in domain.members:
            if m.member_type == "column" and m.member_id in col_map:
                col = col_map[m.member_id]
                # Parse scale_labels from JSON text
                parsed_labels = None
                if col.scale_labels:
                    try:
                        parsed_labels = json.loads(col.scale_labels)
                    except (json.JSONDecodeError, TypeError):
                        pass
                resolved_members.append(DomainMemberInfo(
                    id=m.id,
                    member_type=m.member_type,
                    member_id=m.member_id,
                    label=col.column_text,
                    dataset_id=col.dataset_id,
                    dataset_name=col.dataset.name,
                    column_code=col.column_code,
                    column_type=col.column_type.value,
                    scale_points=col.scale_points,
                    scale_labels=parsed_labels,
                    equivalence_group_id=col.equivalence_group_id,
                ))
            # Skip orphaned members (referenced entity was deleted)

        responses.append(AnalysisDomainResponse(
            id=domain.id,
            project_id=domain.project_id,
            name=domain.name,
            description=domain.description,
            color=domain.color,
            sequence_order=domain.sequence_order,
            origin=domain.origin,
            member_count=len(resolved_members),
            members=resolved_members,
            created_at=domain.created_at,
            updated_at=domain.updated_at,
        ))

    return responses


# ── CRUD endpoints ───────────────────────────────────────────────────────────


@router.get("", response_model=AnalysisDomainListResponse)
async def list_domains(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all analysis domains for a project."""
    _get_project_or_404(db, project_id, user.id)

    domains = (
        db.query(AnalysisDomain)
        .filter(AnalysisDomain.project_id == project_id)
        .order_by(AnalysisDomain.sequence_order.asc().nulls_last(), AnalysisDomain.id)
        .all()
    )

    responses = _build_domain_responses(domains, db)
    return AnalysisDomainListResponse(domains=responses, total=len(responses))


@router.post("", response_model=AnalysisDomainResponse, status_code=201)
async def create_domain(
    project_id: int,
    data: AnalysisDomainCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create an analysis domain, optionally with initial members."""
    _get_project_or_404(db, project_id, user.id)

    if data.members:
        _validate_members_in_project(db, project_id, data.members)
        assert_cross_dataset_members_are_paired(
            db, [m.member_id for m in data.members],
        )

    # Auto-assign sequence_order = max + 1
    max_order = (
        db.query(sa_func.max(AnalysisDomain.sequence_order))
        .filter(AnalysisDomain.project_id == project_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    domain = AnalysisDomain(
        project_id=project_id,
        name=data.name,
        description=data.description,
        color=data.color,
        sequence_order=next_order,
    )
    db.add(domain)
    db.flush()

    # Add members
    for i, m in enumerate(data.members):
        member = AnalysisDomainMember(
            domain_id=domain.id,
            member_type=m.member_type,
            member_id=m.member_id,
            sequence_order=i,
        )
        db.add(member)

    log_action(
        db,
        action="created",
        entity_type="analysis_domain",
        entity_id=domain.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": domain.name, "member_count": len(data.members)},
    )
    db.commit()
    db.refresh(domain)

    return _build_domain_responses([domain], db)[0]


@router.post("/reorder")
async def reorder_domains(
    project_id: int,
    data: DomainReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Reorder analysis domains by updating sequence_order."""
    _get_project_or_404(db, project_id, user.id)

    for i, domain_id in enumerate(data.domain_ids):
        db.query(AnalysisDomain).filter(
            AnalysisDomain.id == domain_id,
            AnalysisDomain.project_id == project_id,
        ).update({"sequence_order": i}, synchronize_session="fetch")

    db.commit()
    return {"status": "ok"}


@router.patch("/{domain_id}", response_model=AnalysisDomainResponse)
async def update_domain(
    project_id: int,
    domain_id: int,
    data: AnalysisDomainUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a domain's name, description, or color."""
    _get_project_or_404(db, project_id, user.id)
    domain = _get_domain_or_404(db, project_id, domain_id)

    if data.name is not None:
        domain.name = data.name
    if data.description is not None:
        domain.description = data.description
    if data.color is not None:
        domain.color = data.color

    log_action(
        db,
        action="updated",
        entity_type="analysis_domain",
        entity_id=domain.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": domain.name},
    )
    db.commit()
    db.refresh(domain)

    return _build_domain_responses([domain], db)[0]


@router.delete("/{domain_id}")
async def delete_domain(
    project_id: int,
    domain_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an analysis domain. Members are cascade-deleted."""
    _get_project_or_404(db, project_id, user.id)
    domain = _get_domain_or_404(db, project_id, domain_id)

    name = domain.name

    # Clean up metric definitions referencing this domain
    db.query(MetricDefinition).filter(
        MetricDefinition.input_source_type == "dataset_domain",
        MetricDefinition.input_source_id == domain_id,
    ).delete(synchronize_session="fetch")

    # Orphan cleanup: delete statistical tests targeting this domain
    from ..models.statistical_test import StatisticalTest
    db.query(StatisticalTest).filter(
        StatisticalTest.target_type == "analysis_domain",
        StatisticalTest.target_id == domain_id,
    ).delete(synchronize_session="fetch")

    log_action(
        db,
        action="deleted",
        entity_type="analysis_domain",
        entity_id=domain_id,
        user_id=user.id,
        project_id=project_id,
        details={"name": name},
    )

    db.delete(domain)
    db.commit()

    return {"status": "ok", "deleted_id": domain_id}


# ── Member management endpoints ─────────────────────────────────────────────


@router.post("/{domain_id}/members", response_model=AnalysisDomainResponse)
@limiter.limit("60/minute")
async def add_members(
    request: Request,
    project_id: int,
    domain_id: int,
    data: AnalysisDomainAddMembers,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add members to a domain. Skips already-existing members (unique index).

    Rate-limited 60/min (audit P7) — per-action endpoint, may fan out from
    multi-select bulk-assign flows. Matches `swap_columns` precedent.
    """
    _get_project_or_404(db, project_id, user.id)
    domain = _get_domain_or_404(db, project_id, domain_id)
    _validate_members_in_project(db, project_id, data.members)

    # Enforce #290: the union of existing members + new additions must not
    # leave any cross-dataset column unpaired.
    existing_member_ids = [
        m.member_id for m in domain.members if m.member_type == "column"
    ]
    assert_cross_dataset_members_are_paired(
        db,
        [m.member_id for m in data.members if m.member_type == "column"],
        existing_member_ids=existing_member_ids,
    )

    # Get current max sequence_order for this domain
    max_order = (
        db.query(sa_func.max(AnalysisDomainMember.sequence_order))
        .filter(AnalysisDomainMember.domain_id == domain_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    # Check existing members to skip duplicates
    existing = (
        db.query(AnalysisDomainMember.member_type, AnalysisDomainMember.member_id)
        .filter(AnalysisDomainMember.domain_id == domain_id)
        .all()
    )
    existing_set = {(r[0], r[1]) for r in existing}

    added = 0
    for m in data.members:
        if (m.member_type, m.member_id) in existing_set:
            continue
        member = AnalysisDomainMember(
            domain_id=domain_id,
            member_type=m.member_type,
            member_id=m.member_id,
            sequence_order=next_order,
        )
        db.add(member)
        next_order += 1
        added += 1

    db.flush()
    mark_metrics_stale(db, project_id, domain_ids=[domain_id])

    log_action(
        db,
        action="members_added",
        entity_type="analysis_domain",
        entity_id=domain.id,
        user_id=user.id,
        project_id=project_id,
        details={"added": added},
    )
    db.commit()
    db.refresh(domain)

    return _build_domain_responses([domain], db)[0]


@router.post("/{domain_id}/members/remove", response_model=AnalysisDomainResponse)
@limiter.limit("60/minute")
async def remove_members(
    request: Request,
    project_id: int,
    domain_id: int,
    data: AnalysisDomainRemoveMembers,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove members from a domain.

    Rate-limited 60/min (audit P7) — per-action endpoint, may fan out from
    multi-select removal flows. Matches `add_members` precedent.
    """
    _get_project_or_404(db, project_id, user.id)
    domain = _get_domain_or_404(db, project_id, domain_id)

    for m in data.members:
        db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.domain_id == domain_id,
            AnalysisDomainMember.member_type == m.member_type,
            AnalysisDomainMember.member_id == m.member_id,
        ).delete(synchronize_session="fetch")

    db.flush()
    mark_metrics_stale(db, project_id, domain_ids=[domain_id])

    log_action(
        db,
        action="members_removed",
        entity_type="analysis_domain",
        entity_id=domain.id,
        user_id=user.id,
        project_id=project_id,
        details={"removed_count": len(data.members)},
    )
    db.commit()
    db.refresh(domain)

    return _build_domain_responses([domain], db)[0]


@router.post("/{domain_id}/members/reorder")
async def reorder_members(
    project_id: int,
    domain_id: int,
    data: DomainMemberReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Reorder members within a single analysis domain.

    Updates `sequence_order` on each `AnalysisDomainMember` to match its
    position in the submitted `member_ids` list. All current members of the
    domain must appear exactly once in the submission.

    Mirrors the pattern of `reorder_domains` above but at the member level
    inside a single domain. Used by the Tier 3 crosswalk's row drag-reorder
    within a bracket (`reorderRowsMutation` — see Phase 3.5 + §8 item 11).
    """
    _get_project_or_404(db, project_id, user.id)
    domain = _get_domain_or_404(db, project_id, domain_id)

    # Validate: all member_ids belong to this domain, no duplicates, and the
    # submission covers every current member.
    current_members = (
        db.query(AnalysisDomainMember)
        .filter(AnalysisDomainMember.domain_id == domain_id)
        .all()
    )
    current_ids = {m.id for m in current_members}
    submitted_ids = data.member_ids

    if len(set(submitted_ids)) != len(submitted_ids):
        raise HTTPException(
            status_code=400,
            detail="Duplicate member_ids in reorder submission",
        )

    submitted_set = set(submitted_ids)
    if submitted_set != current_ids:
        missing = current_ids - submitted_set
        extra = submitted_set - current_ids
        raise HTTPException(
            status_code=400,
            detail={
                "error": "member_set_mismatch",
                "message": (
                    "Reorder submission must include every current member of "
                    "the domain exactly once."
                ),
                "missing_member_ids": sorted(missing),
                "unknown_member_ids": sorted(extra),
            },
        )

    # Apply the new ordering
    for i, member_id in enumerate(submitted_ids):
        db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.id == member_id,
            AnalysisDomainMember.domain_id == domain_id,
        ).update({"sequence_order": i}, synchronize_session="fetch")

    log_action(
        db,
        action="members_reordered",
        entity_type="analysis_domain",
        entity_id=domain.id,
        user_id=user.id,
        project_id=project_id,
        details={"ordered_member_ids": submitted_ids},
    )
    db.commit()
    return {"status": "ok"}


@router.post("/{domain_id}/create-score-metric")
@limiter.limit("30/minute")
async def create_score_metric(
    request: Request,
    project_id: int,
    domain_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Idempotently create (or retry compute for) the ungrouped scale-score
    metric for a variable group.

    Returns `{metric: MetricDefinitionResponse, computed: bool}`. Always
    status 200 — idempotent by design. The `computed` field distinguishes
    "fresh scores" (True) from "metric exists but compute failed, retry
    later" (False).

    Called by the Tier 3 crosswalk's `createDomainMutation.onSuccess` chain
    (Phase 3.5) and by the "Create scale score manually" retry action in
    the Phase 3.5 graceful-degradation toast.
    """
    from ..services.metrics import create_scale_score_metric
    from .metrics import _build_metric_response

    _get_project_or_404(db, project_id, user.id)
    domain = _get_domain_or_404(db, project_id, domain_id)

    # Pre-validate at the router layer so 4xx errors carry structured detail
    # the frontend can pattern-match. The service function trusts these
    # pre-checks and relies on compute_metric's internal validators as
    # defense-in-depth. See Revision 5 for the design rationale.
    member_col_ids = [
        m.member_id for m in domain.members
        if m.member_type == "column"
    ]
    # #350: reject scale-score on all-non-numeric domains (silent valid_n=0
    # otherwise). Runs before the I2 pairing check so the more fundamental
    # type error fires first.
    assert_domain_members_numeric_eligible(db, member_col_ids)
    # #290: cross-dataset pairing.
    assert_cross_dataset_members_are_paired(db, member_col_ids)

    metric, computed = create_scale_score_metric(db, domain)

    log_action(
        db,
        action="auto_created" if computed else "auto_created_stale",
        entity_type="metric_definition",
        entity_id=metric.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "origin": "crosswalk_auto",
            "domain_id": domain_id,
            "name": metric.name,
            "computed": computed,
        },
    )
    db.commit()
    db.refresh(metric)

    return {
        "metric": _build_metric_response(metric, db),
        "computed": computed,
    }


# ── Suggest endpoint ────────────────────────────────────────────────────────


@router.get("/suggest", response_model=DomainSuggestResponse)
async def suggest_domains(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Auto-suggest variable groups from column codes, scale structures, and text similarity.

    Operates on DatasetColumn rows directly (no equivalence group dependency).
    Uses 3-pass algorithm: prefix match, scale-type clustering, keyword overlap.

    Phase 4: each suggestion also runs a within-cluster pairing pass for
    cross-dataset clusters (closes #297, #295). Pairing uses the same
    `SequenceMatcher.ratio()` metric as the find-matches endpoint
    (`equivalence.py::_normalize_text` + `difflib`) so behavior is consistent
    when researchers fall back to manual MappingDialog. Threshold 0.70.
    """
    import json as _json
    import re
    import unicodedata
    from collections import defaultdict
    from difflib import SequenceMatcher

    _get_project_or_404(db, project_id, user.id)

    # Load all non-skip, non-demographic columns
    columns = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(Dataset.project_id == project_id)
        .options(joinedload(DatasetColumn.dataset))
        .all()
    )
    columns = [
        c for c in columns
        if c.column_type.value not in ("skip", "demographic", "identifier")
    ]

    if len(columns) < 2:
        return DomainSuggestResponse(suggestions=[])

    # Build assigned column IDs set
    assigned_col_ids = set(
        r[0] for r in
        db.query(AnalysisDomainMember.member_id)
        .join(AnalysisDomain)
        .filter(
            AnalysisDomain.project_id == project_id,
            AnalysisDomainMember.member_type == "column",
        )
        .all()
    )

    unassigned = [c for c in columns if c.id not in assigned_col_ids]
    if len(unassigned) < 2:
        return DomainSuggestResponse(suggestions=[])

    # Text normalization helper
    _STOPWORDS = {
        "how", "would", "you", "rate", "the", "what", "is", "your", "do", "to",
        "of", "a", "an", "in", "for", "and", "or", "this", "that", "are", "with",
        "on", "satisfied", "agree", "strongly", "important", "very", "somewhat",
        "neither", "nor", "not",
    }

    def _normalize(text: str) -> str:
        text = text.strip().lower()
        text = "".join(
            c for c in unicodedata.normalize("NFD", text)
            if unicodedata.category(c) != "Mn"
        )
        text = re.sub(r"^\[.*?\]\s*", "", text)
        text = re.sub(r"\s+", " ", text)
        text = text.strip(".,;:!?-")
        return text

    def _tokenize(text: str) -> set[str]:
        words = set(re.findall(r"[a-z0-9]+", _normalize(text)))
        return words - _STOPWORDS

    suggestions: list[DomainSuggestion] = []
    used_col_ids: set[int] = set()
    seen_member_sets: set[frozenset[int]] = set()

    # Phase 4 pairing constants — match find-matches defaults so auto-pair
    # behavior is predictable when researchers cross-reference via MappingDialog.
    PAIRING_THRESHOLD = 0.70
    PAIRING_AMBIGUITY_TOLERANCE = 0.05

    def _make_item(col: DatasetColumn, reason: str | None = None) -> DomainSuggestedItem:
        return DomainSuggestedItem(
            member_type="column",
            member_id=col.id,
            label=col.column_text or "",
            dataset_id=col.dataset_id,
            dataset_name=col.dataset.name,
            column_type=col.column_type.value,
            reason=reason,
        )

    def _pair_cluster(
        cols: list[DatasetColumn],
    ) -> tuple[list[list[int]], bool, str | None]:
        """Within-cluster pairing pass for a cross-dataset cluster (#297/#295).

        Returns (members_paired, unpaired, pairing_reason).
        - Single-dataset cluster → ([], False, None) — no pairing needed.
        - Cross-dataset cluster with confident matches → (slots, False, "text_match:<avg>").
        - Cross-dataset cluster where matches are ambiguous or below threshold
          → ([], True, None) — frontend renders greyed and prompts manual pairing.

        Algorithm:
          1. Group columns by dataset_id.
          2. Compute SequenceMatcher.ratio() between every pair of cross-dataset
             columns (using the same _normalize_text helper as find-matches for
             predictability).
          3. Greedy max-weight matching: walk edges in descending similarity order,
             pair each column to its best available cross-dataset partner if
             similarity >= PAIRING_THRESHOLD.
          4. Bail rule: if a column's two best candidates are within
             PAIRING_AMBIGUITY_TOLERANCE of each other, abort the cluster
             (better to ask the user than confidently pair wrong).
          5. After matching, group paired columns into "pairing slots" — each
             slot is one EquivalenceGroup containing one column from each dataset
             that participates in that slot.
          6. If any column is unpaired in any participating dataset, return
             unpaired=True (we don't ship partial pairings — the user can either
             accept the whole cluster as unpaired or dismiss it).
        """
        by_dataset: dict[int, list[DatasetColumn]] = defaultdict(list)
        for c in cols:
            by_dataset[c.dataset_id].append(c)
        if len(by_dataset) < 2:
            return [], False, None  # single-dataset, no pairing needed

        # Use the same normalization as find-matches (equivalence.py::_normalize_text).
        # Replicated here to avoid a router-to-router import; behavior must match.
        def _norm_for_match(text: str) -> str:
            text = (text or "").strip().lower()
            text = "".join(
                c for c in unicodedata.normalize("NFD", text)
                if unicodedata.category(c) != "Mn"
            )
            text = re.sub(r"^\[.*?\]\s*", "", text)
            text = re.sub(r"\s+", " ", text)
            text = text.strip(".,;:!?-–—")
            return text

        # Build similarity matrix for all cross-dataset pairs.
        # edges: list of (similarity, col_a, col_b) where col_a.dataset_id != col_b.dataset_id
        edges: list[tuple[float, DatasetColumn, DatasetColumn]] = []
        all_cols = list(cols)
        for i in range(len(all_cols)):
            for j in range(i + 1, len(all_cols)):
                a, b = all_cols[i], all_cols[j]
                if a.dataset_id == b.dataset_id:
                    continue
                ratio = SequenceMatcher(
                    None,
                    _norm_for_match(a.column_text or ""),
                    _norm_for_match(b.column_text or ""),
                ).ratio()
                edges.append((ratio, a, b))

        if not edges:
            return [], False, None

        # Ambiguity bail: for each column, walk its candidates per OTHER dataset.
        # Within a single other-dataset, if the top two candidates are within
        # PAIRING_AMBIGUITY_TOLERANCE and both above threshold, the cluster
        # is ambiguous (we can't tell which sibling-dataset column to pair).
        # Top candidates across DIFFERENT other-datasets are NOT ambiguous —
        # those represent normal N-way pairing across 3+ datasets.
        per_col_per_other_ds: dict[int, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
        for ratio, a, b in edges:
            per_col_per_other_ds[a.id][b.dataset_id].append(ratio)
            per_col_per_other_ds[b.id][a.dataset_id].append(ratio)
        for col_id, by_other_ds in per_col_per_other_ds.items():
            for ds_id, ratios in by_other_ds.items():
                ratios.sort(reverse=True)
                if len(ratios) >= 2 and ratios[0] >= PAIRING_THRESHOLD:
                    if ratios[0] - ratios[1] < PAIRING_AMBIGUITY_TOLERANCE and ratios[1] >= PAIRING_THRESHOLD:
                        return [], True, None

        # Greedy maximum-weight matching: build "groups" by walking edges in
        # descending similarity order. Each column joins exactly one group.
        edges.sort(key=lambda e: e[0], reverse=True)
        group_of: dict[int, int] = {}  # col_id → group_index
        groups: list[dict[int, DatasetColumn]] = []  # each group: dataset_id → DatasetColumn
        chosen_ratios: list[float] = []

        for ratio, a, b in edges:
            if ratio < PAIRING_THRESHOLD:
                break
            ga = group_of.get(a.id)
            gb = group_of.get(b.id)
            if ga is None and gb is None:
                # New group
                idx = len(groups)
                groups.append({a.dataset_id: a, b.dataset_id: b})
                group_of[a.id] = idx
                group_of[b.id] = idx
                chosen_ratios.append(ratio)
            elif ga is not None and gb is None:
                # Extend a's group with b iff b's dataset isn't already represented
                if b.dataset_id not in groups[ga]:
                    groups[ga][b.dataset_id] = b
                    group_of[b.id] = ga
                    chosen_ratios.append(ratio)
            elif ga is None and gb is not None:
                if a.dataset_id not in groups[gb]:
                    groups[gb][a.dataset_id] = a
                    group_of[a.id] = gb
                    chosen_ratios.append(ratio)
            # If both are already in groups (same or different), skip — would
            # require merging which the strict-confidence rule disallows.

        # Verify every column in the cluster ended up in some group.
        # (The pairing only ships if no column is left unpaired.)
        all_paired = all(c.id in group_of for c in cols)
        if not all_paired:
            return [], True, None

        # Reject "groups" with only 1 column — those mean a column had no
        # confident cross-dataset partner. (Shouldn't happen given the
        # all_paired check, but defense-in-depth.)
        if any(len(g) < 2 for g in groups):
            return [], True, None

        members_paired = [
            sorted(g[ds_id].id for ds_id in g)
            for g in groups
        ]
        avg_ratio = sum(chosen_ratios) / len(chosen_ratios) if chosen_ratios else 0.0
        return members_paired, False, f"text_match:{avg_ratio:.2f}"

    def _add_suggestion(name: str, cols: list[DatasetColumn], reason: str) -> None:
        member_key = frozenset(c.id for c in cols)
        if member_key in seen_member_sets:
            return
        seen_member_sets.add(member_key)
        members_paired, unpaired, pairing_reason = _pair_cluster(cols)
        suggestions.append(DomainSuggestion(
            name=name,
            members=[_make_item(c, reason) for c in cols],
            members_paired=members_paired,
            unpaired=unpaired,
            pairing_reason=pairing_reason,
        ))
        used_col_ids.update(c.id for c in cols)

    # ── Pass 1: Prefix match ──
    prefix_map: dict[str, list[DatasetColumn]] = defaultdict(list)
    prefix_re = re.compile(r'^([A-Za-z]{2,5})[\s_\-]')
    for col in unassigned:
        if col.column_code:
            m = prefix_re.match(col.column_code)
            if m:
                prefix_map[m.group(1).upper()].append(col)

    for prefix, cols in prefix_map.items():
        cols = [c for c in cols if c.id not in used_col_ids]
        if len(cols) >= 2:
            _add_suggestion(prefix.title(), cols, f"Shared code prefix: {prefix}")

    # ── Pass 2: Scale-type clustering ──
    scale_map: dict[str, list[DatasetColumn]] = defaultdict(list)
    for col in unassigned:
        if col.id in used_col_ids:
            continue
        if col.scale_labels:
            try:
                labels = _json.loads(col.scale_labels) if isinstance(col.scale_labels, str) else col.scale_labels
                if isinstance(labels, list) and len(labels) >= 2:
                    norm_key = "|".join(sorted(str(l).lower() for l in labels))
                    scale_map[norm_key].append(col)
            except (ValueError, TypeError):
                pass

    for scale_key, cols in scale_map.items():
        cols = [c for c in cols if c.id not in used_col_ids]
        if len(cols) >= 3:
            # Generate name from common keywords in column_text
            all_tokens = [_tokenize(c.column_text or "") for c in cols]
            if all_tokens:
                common = set.intersection(*all_tokens) if len(all_tokens) > 1 else all_tokens[0]
                name = " ".join(sorted(common)[:3]).title() if common else f"Scale Group ({len(cols)} items)"
            else:
                name = f"Scale Group ({len(cols)} items)"
            if len(name) < 3:
                name = f"Scale Group ({len(cols)} items)"
            _add_suggestion(name, cols, "Shared scale structure")

    # ── Pass 3: Keyword overlap ──
    # Cluster columns whose normalized-token sets overlap by Jaccard >= 0.5.
    # Uses a union-find structure so cluster merging is order-independent and
    # safe (the previous implementation iterated keyword_groups while writing
    # to it, which is fragile in Python).
    remaining = [c for c in unassigned if c.id not in used_col_ids]
    if len(remaining) >= 2:
        col_tokens: dict[int, set[str]] = {}
        for col in remaining:
            tokens = _tokenize(col.column_text or "")
            if len(tokens) >= 2:
                col_tokens[col.id] = tokens

        col_by_id = {c.id: c for c in remaining}
        col_ids_list = list(col_tokens.keys())

        # Union-find on column IDs.
        parent: dict[int, int] = {cid: cid for cid in col_ids_list}

        def _find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]  # path compression
                x = parent[x]
            return x

        def _union(x: int, y: int) -> None:
            rx, ry = _find(x), _find(y)
            if rx != ry:
                parent[rx] = ry

        for i in range(len(col_ids_list)):
            for j in range(i + 1, len(col_ids_list)):
                id_a, id_b = col_ids_list[i], col_ids_list[j]
                tokens_a, tokens_b = col_tokens[id_a], col_tokens[id_b]
                overlap = tokens_a & tokens_b
                union = tokens_a | tokens_b
                if union and len(overlap) / len(union) >= 0.5:
                    _union(id_a, id_b)

        # Materialize clusters from the union-find roots.
        clusters: dict[int, list[int]] = defaultdict(list)
        for cid in col_ids_list:
            clusters[_find(cid)].append(cid)

        for member_ids in clusters.values():
            member_ids = [mid for mid in member_ids if mid not in used_col_ids]
            if len(member_ids) >= 2:
                cols = [col_by_id[mid] for mid in member_ids if mid in col_by_id]
                if len(cols) >= 2:
                    # Generate name from shared keywords
                    all_tokens = [col_tokens[c.id] for c in cols if c.id in col_tokens]
                    common = set.intersection(*all_tokens) if len(all_tokens) > 1 else set()
                    name = " ".join(sorted(common)[:3]).title() if common else "Related Items"
                    if len(name) < 3:
                        name = "Related Items"
                    _add_suggestion(name, cols, "Shared keywords in column text")

    return DomainSuggestResponse(suggestions=suggestions)


@router.post("/bulk", response_model=BulkDomainCreateResult, status_code=201)
@limiter.limit("30/minute")
async def bulk_create_domains(
    request: Request,
    project_id: int,
    data: AnalysisDomainBulkCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create multiple analysis domains at once (from suggestions).

    Rate-limited 30/min (audit P7) — bulk endpoint, one request per Suggest
    accept. Pre-release hardening against runaway frontend loops.

    Phase 4: each `AnalysisDomainCreate` may carry optional inline
    `equivalence_groups`. When present, they're created BEFORE the domain
    members are inserted so cross-dataset I2 (#290) is satisfied in one
    transaction. This is the path the Tier 3 Suggest accept flow uses to
    scaffold paired EGs alongside the domain that wraps them — closes
    #297 (auto-pair) and #295 (auto-create EGs from suggestions).

    Validation order matters:
      1. Members in project
      2. Inline EG columns in project + 1:1 per dataset (#289) + not hijacked (#301)
      3. Create EGs and assign columns (ORM relationship setter, mirrors
         create_group's pattern for #289 passive_deletes safety) + flush
      4. NOW validate I2 per domain — sees the fresh EG links
      5. Create domains + members + commit
    """
    _get_project_or_404(db, project_id, user.id)

    # ── Phase 1: validate members ────────────────────────────────────────────
    all_members: list[DomainMemberInput] = []
    for d in data.domains:
        all_members.extend(d.members)
    if all_members:
        _validate_members_in_project(db, project_id, all_members)

    # ── Phase 2: validate inline equivalence-group payloads ──────────────────
    has_inline_egs = any(d.equivalence_groups for d in data.domains)
    if has_inline_egs:
        # Collect every column ID referenced by any inline EG
        all_eg_col_ids: list[int] = []
        for d in data.domains:
            for eg in d.equivalence_groups:
                all_eg_col_ids.extend(eg.column_ids)
        # Single project-membership query for all referenced columns
        eg_cols_loaded = _validate_columns_belong_to_project(
            db, project_id, list(set(all_eg_col_ids)),
        )
        cols_by_id = {c.id: c for c in eg_cols_loaded}

        # Per-EG validators (#289 unique per dataset + #301 hijack guard)
        for d_data in data.domains:
            for eg_data in d_data.equivalence_groups:
                eg_cols = [cols_by_id[cid] for cid in eg_data.column_ids if cid in cols_by_id]
                # The columns being inline-paired here cannot already belong to
                # another EG — Suggest filters its candidates to unassigned
                # columns, but we re-check defensively (frontend cache may be
                # stale by the time the user clicks Accept).
                assert_columns_not_already_linked(
                    db, eg_cols, current_eg_id_to_ignore=None,
                )
                _assert_columns_unique_per_dataset(eg_cols)

        # Enforce: every inline EG column must also appear in the wrapping
        # domain's members list. Otherwise the caller is creating an EG that
        # exists outside its declared domain — confusing and not the
        # use-case we're shipping.
        for d_data in data.domains:
            domain_member_col_ids = {
                m.member_id for m in d_data.members if m.member_type == "column"
            }
            for eg_data in d_data.equivalence_groups:
                missing = set(eg_data.column_ids) - domain_member_col_ids
                if missing:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Inline equivalence-group columns must also be "
                            f"members of the wrapping domain. Domain "
                            f"'{d_data.name}' is missing: {sorted(missing)}"
                        ),
                    )

    # ── Phase 3: create domains + EGs + members in a single transaction ──────
    max_order = (
        db.query(sa_func.max(AnalysisDomain.sequence_order))
        .filter(AnalysisDomain.project_id == project_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    created_domains: list[AnalysisDomain] = []
    for d_data in data.domains:
        # Create inline EGs first so members reference fresh links
        for eg_data in d_data.equivalence_groups:
            eg = EquivalenceGroup(
                project_id=project_id,
                label=eg_data.label,
            )
            db.add(eg)
            db.flush()
            # Assign via ORM relationship setter (mirrors create_group:271-272
            # for #289 passive_deletes safety — see foot-gun).
            for cid in eg_data.column_ids:
                col = cols_by_id[cid]
                col.equivalence_group = eg
            log_action(
                db,
                action="created",
                entity_type="equivalence_group",
                entity_id=eg.id,
                user_id=user.id,
                project_id=project_id,
                details={"label": eg.label, "column_count": len(eg_data.column_ids)},
            )

    if has_inline_egs:
        # Flush so column.equivalence_group_id is queryable for the I2 check.
        db.flush()

    # NOW validate cross-dataset pairing — runs against the fresh EG links.
    if all_members:
        for d_data in data.domains:
            assert_cross_dataset_members_are_paired(
                db,
                [m.member_id for m in d_data.members if m.member_type == "column"],
            )

    for d_data in data.domains:
        domain = AnalysisDomain(
            project_id=project_id,
            name=d_data.name,
            description=d_data.description,
            color=d_data.color,
            sequence_order=next_order,
        )
        db.add(domain)
        db.flush()
        next_order += 1

        for i, m in enumerate(d_data.members):
            member = AnalysisDomainMember(
                domain_id=domain.id,
                member_type=m.member_type,
                member_id=m.member_id,
                sequence_order=i,
            )
            db.add(member)

        log_action(
            db,
            action="created",
            entity_type="analysis_domain",
            entity_id=domain.id,
            user_id=user.id,
            project_id=project_id,
            details={
                "name": domain.name,
                "member_count": len(d_data.members),
                "inline_eg_count": len(d_data.equivalence_groups),
            },
        )
        created_domains.append(domain)

    db.commit()

    responses = _build_domain_responses(created_domains, db)
    return BulkDomainCreateResult(created=len(responses), domains=responses)
