"""Statistical test endpoints (Cronbach's alpha, t-test, ANOVA)."""

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..models.statistical_test import StatisticalTest
from ..models.metric import MetricDefinition
from ..models.analysis_domain import AnalysisDomain
from ..schemas.statistical_test import (
    StatisticalTestCreate,
    StatisticalTestUpdate,
    ComputeAllTestsRequest,
    StatisticalTestResponse,
    StatisticalTestListResponse,
    ComputeAllTestsResponse,
)
from ..services.statistical_tests import (
    compute_statistical_test,
    compute_all_tests_for_project,
    resolve_target_labels,
)
from ..services.audit import log_action
from .helpers import _get_project_or_404

router = APIRouter(
    prefix="/api/projects/{project_id}/statistical-tests",
    tags=["statistical-tests"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_test_or_404(
    db: Session, project_id: int, test_id: int,
) -> StatisticalTest:
    test = (
        db.query(StatisticalTest)
        .filter(
            StatisticalTest.id == test_id,
            StatisticalTest.project_id == project_id,
        )
        .first()
    )
    if not test:
        raise HTTPException(status_code=404, detail="Statistical test not found")
    return test


def _parse_json(text: str | None) -> dict | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _build_test_response(
    test: StatisticalTest,
    label_map: dict[tuple[str, int], str] | None = None,
) -> StatisticalTestResponse:
    target_label = None
    if label_map:
        target_label = label_map.get((test.target_type, test.target_id))

    return StatisticalTestResponse(
        id=test.id,
        project_id=test.project_id,
        test_type=test.test_type,
        config=_parse_json(test.config) or {},
        target_type=test.target_type,
        target_id=test.target_id,
        target_label=target_label,
        result_data=_parse_json(test.result_data),
        valid_n=test.valid_n,
        stale=test.stale,
        computed_at=test.computed_at,
        origin=test.origin,
        origin_context=test.origin_context,
        created_at=test.created_at,
        updated_at=test.updated_at,
    )


# ── Type/target compatibility ─────────────────────────────────────────────────

# alpha → analysis_domain; t-test/ANOVA → metric_definition
_TYPE_TARGET_MAP = {
    "cronbachs_alpha": "analysis_domain",
    "independent_t_test": "metric_definition",
    "one_way_anova": "metric_definition",
    "split_half": "analysis_domain",
}


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/", response_model=StatisticalTestListResponse)
async def list_tests(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all statistical tests for a project."""
    _get_project_or_404(db, project_id, user.id)

    tests = (
        db.query(StatisticalTest)
        .filter(StatisticalTest.project_id == project_id)
        .order_by(StatisticalTest.created_at)
        .all()
    )

    label_map = resolve_target_labels(db, tests)

    return StatisticalTestListResponse(
        tests=[_build_test_response(t, label_map) for t in tests],
        total=len(tests),
    )


@router.post("/", response_model=StatisticalTestResponse, status_code=201)
async def create_test(
    project_id: int,
    body: StatisticalTestCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new statistical test."""
    _get_project_or_404(db, project_id, user.id)

    # Validate type/target compatibility
    expected_target = _TYPE_TARGET_MAP.get(body.test_type)
    if expected_target and body.target_type != expected_target:
        raise HTTPException(
            status_code=400,
            detail=f"{body.test_type} requires target_type='{expected_target}', got '{body.target_type}'",
        )

    # Validate target exists
    if body.target_type == "analysis_domain":
        exists = db.query(AnalysisDomain.id).filter(
            AnalysisDomain.id == body.target_id,
            AnalysisDomain.project_id == project_id,
        ).first()
        if not exists:
            raise HTTPException(status_code=404, detail=f"Analysis domain {body.target_id} not found in project")
    elif body.target_type == "metric_definition":
        metric = db.query(MetricDefinition).filter(
            MetricDefinition.id == body.target_id,
            MetricDefinition.project_id == project_id,
        ).first()
        if not metric:
            raise HTTPException(status_code=404, detail=f"Metric definition {body.target_id} not found in project")
        # T-test and ANOVA require grouping
        if body.test_type in ("independent_t_test", "one_way_anova") and not metric.grouping_column_id and not metric.grouping_column_id_2 and metric.grouping_mode != "dataset":
            raise HTTPException(
                status_code=400,
                detail=f"{body.test_type} requires a metric with a grouping column set",
            )

    test = StatisticalTest(
        project_id=project_id,
        test_type=body.test_type,
        config=json.dumps(body.config),
        target_type=body.target_type,
        target_id=body.target_id,
        stale=True,
    )
    db.add(test)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="statistical_test",
        entity_id=test.id,
        user_id=user.id,
        project_id=project_id,
        details={"test_type": body.test_type, "target_type": body.target_type, "target_id": body.target_id},
    )
    db.commit()
    db.refresh(test)

    label_map = resolve_target_labels(db, [test])
    return _build_test_response(test, label_map)


@router.get("/{test_id}", response_model=StatisticalTestResponse)
async def get_test(
    project_id: int,
    test_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a single statistical test with result data."""
    _get_project_or_404(db, project_id, user.id)
    test = _get_test_or_404(db, project_id, test_id)

    label_map = resolve_target_labels(db, [test])
    return _build_test_response(test, label_map)


@router.patch("/{test_id}", response_model=StatisticalTestResponse)
async def update_test(
    project_id: int,
    test_id: int,
    body: StatisticalTestUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a statistical test config (marks stale)."""
    _get_project_or_404(db, project_id, user.id)
    test = _get_test_or_404(db, project_id, test_id)

    if body.config is not None:
        test.config = json.dumps(body.config)
        test.stale = True

    log_action(
        db,
        action="updated",
        entity_type="statistical_test",
        entity_id=test_id,
        user_id=user.id,
        project_id=project_id,
        details={"test_type": test.test_type},
    )
    db.commit()
    db.refresh(test)

    label_map = resolve_target_labels(db, [test])
    return _build_test_response(test, label_map)


@router.delete("/{test_id}")
async def delete_test(
    project_id: int,
    test_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a statistical test."""
    _get_project_or_404(db, project_id, user.id)
    test = _get_test_or_404(db, project_id, test_id)

    log_action(
        db,
        action="deleted",
        entity_type="statistical_test",
        entity_id=test_id,
        user_id=user.id,
        project_id=project_id,
        details={"test_type": test.test_type},
    )

    db.delete(test)
    db.commit()

    return {"status": "ok", "deleted_id": test_id}


@router.post("/{test_id}/compute", response_model=StatisticalTestResponse)
async def compute_single_test(
    project_id: int,
    test_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compute (or recompute) a single statistical test."""
    _get_project_or_404(db, project_id, user.id)
    test = _get_test_or_404(db, project_id, test_id)

    try:
        compute_statistical_test(db, test)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    log_action(
        db,
        action="computed",
        entity_type="statistical_test",
        entity_id=test.id,
        user_id=user.id,
        project_id=project_id,
        details={"test_type": test.test_type},
    )
    db.commit()
    db.refresh(test)

    label_map = resolve_target_labels(db, [test])
    return _build_test_response(test, label_map)


@router.post("/compute-all", response_model=ComputeAllTestsResponse)
async def compute_all_tests(
    project_id: int,
    body: ComputeAllTestsRequest = ComputeAllTestsRequest(),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compute all statistical tests for the project."""
    _get_project_or_404(db, project_id, user.id)

    result = compute_all_tests_for_project(db, project_id, stale_only=body.stale_only)

    log_action(
        db,
        action="computed_all",
        entity_type="statistical_test",
        entity_id=0,
        user_id=user.id,
        project_id=project_id,
        details={"computed": result["computed"], "errors": len(result["errors"])},
    )
    db.commit()

    return ComputeAllTestsResponse(**result)
