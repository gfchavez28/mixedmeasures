"""Auto-metric cleanup service.

Removes stale auto-created MetricDefinitions that are no longer referenced
by any StatisticalTest and haven't been accessed recently.
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 7

# Throttle: track last cleanup time per project to avoid running on every request
_last_cleanup: dict[int, datetime] = {}
_CLEANUP_INTERVAL = timedelta(minutes=5)


def cleanup_auto_metrics(db: Session, project_id: int) -> int:
    """Delete unreferenced auto-created metrics older than retention period.

    Throttled to run at most once per 5 minutes per project.
    Returns count of deleted metrics (0 if skipped due to throttle).
    """
    # Throttle is safe under single-process asyncio. Timestamp is set before
    # cleanup queries, so worst case of concurrent access is idempotent
    # duplicate cleanup. Add a threading.Lock if multi-worker deployment.
    now = datetime.now(timezone.utc)
    last = _last_cleanup.get(project_id)
    if last and (now - last) < _CLEANUP_INTERVAL:
        return 0

    _last_cleanup[project_id] = now
    # SQLite stores naive datetimes, so strip tzinfo for DB comparison
    cutoff = now.replace(tzinfo=None) - timedelta(days=_RETENTION_DAYS)

    # Protect metrics targeted by statistical tests
    protected_ids: set[int] = set()
    test_targets = (
        db.query(StatisticalTest.target_id)
        .filter(
            StatisticalTest.target_type == "metric_definition",
            StatisticalTest.project_id == project_id,
        )
        .all()
    )
    for (target_id,) in test_targets:
        protected_ids.add(target_id)

    # Find candidates for deletion
    candidates = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.origin == "auto",
        )
        .all()
    )

    deleted = 0
    for metric in candidates:
        if metric.id in protected_ids:
            continue
        # Delete if last_accessed_at is old enough or null
        if metric.last_accessed_at is None or metric.last_accessed_at < cutoff:
            db.delete(metric)
            deleted += 1

    if deleted:
        db.flush()
        logger.info(
            "Cleaned up %d auto-created metrics for project %d",
            deleted, project_id,
        )

    return deleted
