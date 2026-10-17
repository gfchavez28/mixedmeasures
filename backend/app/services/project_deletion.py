"""Deleting a whole project (#1035).

Two callers: `routers/projects.py::delete_project` and the `.mmproject` OVERWRITE
import (`project_portability.import_project`, after its safety copy). Both used to
call `db.delete(project)`, and SQLAlchemy's `delete-orphan` cascade LOADED every
child as an ORM object purely to delete it — 50 cascade relationships reachable from
`Project`, 6 of them passive. Measured on the scale corpus (2026-10-13 review,
the internal design notes):

| | before | after (this module, 2026-10-13) |
|---|---|---|
| BES (1.38 M codings on cells) | 86.2 s · 3.24 GB | 11.8 s · 114 MB |
| BES, SQLCipher (what the desktop app ships) | ~72 s (the cascade alone) | 18.9 s |
| BES with every record linked to a participant | 216.3 s · 4.41 GB | 16.7 s · 114 MB |
| a 300-interview project (600 k codings) | 676.6 s · 6.49 GB | 19.1 s · 95 MB |
| GSS (3.63 M values) | 56.4 s · 1.06 GB | 24.1 s · 168 MB |

## The database deletes; this module only chooses the ORDER

Every `Project` collection is `passive_deletes=True` (`models/project.py`) and every
FK behind them is `ON DELETE CASCADE`, so `db.delete(project)` alone is CORRECT —
the schema removes everything. It is slow, though: a row deleted INSIDE SQLite's
nested cascade costs ~1.5x a direct `DELETE`, and SQLCipher roughly TRIPLES the
cascade (BES 25.5 → 71.8 s), which is what the desktop app ships. So the
data-scaled leaf tables go first, children before parents, each in ONE statement —
2-4x faster than the cascade, plaintext and SQLCipher alike. What remains (codes,
conversations, memos, canvases, …) is small and goes with the project row.

⚠️ **The statements are an optimisation, not the guarantee.** Removing one of them
leaves the result identical (the cascade still deletes those rows) and only slower;
`test_project_deletion.py` pins the order by statement sequence for that reason.

⚠️ **`synchronize_session=False` on every statement** — otherwise SQLAlchemy fetches
every matched id into Python first, which is the cost this module removes.

⚠️ **One transaction, and the CALLER commits.** The delete endpoint stays
`async def` (#837): as `def` it ran beside other writers, and with the write lock
held for 11-27 s another session's PATCH failed at SQLite's 5 s busy timeout, as did
a plain GET whose once-a-minute activity stamp was due (`auth.get_current_user`
commits on the event loop). On the loop, that GET WAITED and answered (10.4 s, 200,
during a 12.4 s BES delete over HTTP) — every request waits and none fails. Deleting in committed chunks needs a persisted "being
deleted" marker and a resumer — the 1.5.8 follow-up, not this module.
"""
from sqlalchemy import delete, inspect, select
from sqlalchemy.orm import Session

from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.conversation import Conversation
from ..models.dataset import Dataset, DatasetRow, DatasetValue
from ..models.document import Document
from ..models.metric import MetricDefinition
from ..models.observation import Observation
from ..models.project import Project
from ..models.row_score import RowScore
from ..models.segment import Segment

_NO_SYNC = {"synchronize_session": False}


def _leaf_first_statements(project_id: int):
    """The data-scaled tables, children before parents, each one statement.

    Subqueries, never id lists: no project-sized list is bound (#842's ceiling).
    """
    datasets = select(Dataset.id).where(Dataset.project_id == project_id)
    rows = select(DatasetRow.id).where(DatasetRow.dataset_id.in_(datasets))
    return [
        delete(CodeApplication).where(
            CodeApplication.code_id.in_(select(Code.id).where(Code.project_id == project_id))
        ),
        delete(RowScore).where(
            RowScore.metric_definition_id.in_(
                select(MetricDefinition.id).where(MetricDefinition.project_id == project_id)
            )
        ),
        delete(DatasetValue).where(DatasetValue.row_id.in_(rows)),
        delete(DatasetRow).where(DatasetRow.dataset_id.in_(datasets)),
        delete(Segment).where(Segment.conversation_id.in_(
            select(Conversation.id).where(Conversation.project_id == project_id))),
        delete(Segment).where(Segment.document_id.in_(
            select(Document.id).where(Document.project_id == project_id))),
        delete(Segment).where(Segment.observation_id.in_(
            select(Observation.id).where(Observation.project_id == project_id))),
    ]


def delete_project_tree(db: Session, project: Project) -> None:
    """Delete `project` and everything under it, loading no child. Flushes; does not commit."""
    # Pending writes land first: a pending row under the project, inserted AFTER the
    # statements below, would point at a row they deleted and fail its foreign key.
    db.flush()
    for stmt in _leaf_first_statements(project.id):
        db.execute(stmt, execution_options=_NO_SYNC)
    # A collection the caller happened to load (the overwrite import's safety export
    # can) would still be walked by the ORM's cascade, which would issue a second
    # DELETE for rows the statements already removed. Expiring the loaded ones lets
    # the database do it — and drops the session's strong references to those rows.
    loaded = [
        rel.key for rel in inspect(Project).relationships
        if rel.passive_deletes and rel.key not in inspect(project).unloaded
    ]
    if loaded:
        db.expire(project, loaded)
    db.delete(project)
    db.flush()
