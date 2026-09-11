"""#898 — an audit entry added AFTER the commit is never written.

`services/audit.py::log_action` only `db.add`s the entry; it does not commit.
`database.py::get_db` only CLOSES the session — it never commits — so anything
still pending when a handler returns is discarded. An endpoint that commits and
*then* logs therefore records nothing, while looking in every way like it does.

Two tests, and they answer different questions:

  * the BEHAVIOURAL one drives `update_dataset` (the site that had it backwards)
    and asserts the entry survives the session being closed;
  * the POPULATION one derives the rule from the routers themselves, so the
    NEXT endpoint written this way fails here rather than in the field. It is
    the shape that matters, not the one site that was wrong.
"""

import ast
import asyncio

import pytest

from app.models.audit import AuditEntry
from app.models.dataset import Dataset
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import update_dataset
from app.schemas.dataset import DatasetUpdate
from tests.guard_support import app_files


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=1, name="P", user_id=1))
    db.flush()
    db.add(Dataset(id=1, project_id=1, name="Survey"))
    db.flush()
    db.commit()
    return db


class TestTheRenameIsActuallyAudited:
    def test_the_entry_survives_the_session_closing(self, project):
        db = project
        user = db.query(User).filter(User.id == 1).one()
        _run(update_dataset(
            project_id=1, dataset_id=1, data=DatasetUpdate(name="Renamed"),
            user=user, db=db,
        ))
        # `get_db` closes without committing, so a rollback here is what the
        # production session does to anything still pending on return.
        db.rollback()
        entries = db.query(AuditEntry).filter(
            AuditEntry.action == "dataset_updated").all()
        assert len(entries) == 1, (
            "the rename was not audited — `log_action` must run BEFORE "
            "`db.commit()`, because nothing commits after it (#898)"
        )
        assert entries[0].entity_id == 1
        assert db.get(Dataset, 1).name == "Renamed"


class TestNoEndpointLogsAfterItsLastCommit:
    """The population rule, derived from the routers rather than listed.

    ⚠️ A guard over source needs a self-check that it can still SEE its target
    (#729): a walk that resolves to nothing passes an `all(...)` by finding
    nothing. `test_the_scan_finds_endpoints_that_log` is that check.
    """

    def _sites(self) -> dict[str, list[int]]:
        """``{file::function: log_action lines after the last db.commit()}``."""
        offenders: dict[str, list[int]] = {}
        for path in app_files("routers", floor=20, sentinels=("routers/dataset.py",)):
            tree = ast.parse(path.read_text())
            for fn in ast.walk(tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                nodes = list(ast.walk(fn))
                commits = [
                    n.lineno for n in nodes
                    if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute) and n.func.attr == "commit"
                ]
                logs = [
                    n.lineno for n in nodes
                    if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Name) and n.func.id == "log_action"
                ]
                if not logs or not commits:
                    continue
                late = [ln for ln in logs if ln > max(commits)]
                if late:
                    offenders[f"{path.name}::{fn.name}"] = late
        return offenders

    def _logging_endpoints(self) -> int:
        total = 0
        for path in app_files("routers", floor=20):
            tree = ast.parse(path.read_text())
            total += sum(
                1 for n in ast.walk(tree)
                if isinstance(n, ast.Call)
                and isinstance(n.func, ast.Name) and n.func.id == "log_action"
            )
        return total

    def test_the_scan_finds_endpoints_that_log(self):
        """Population self-check: the walk must actually reach `log_action`."""
        assert self._logging_endpoints() > 50, (
            "the scan found almost no log_action calls — it has gone blind"
        )

    def test_no_log_action_runs_after_the_last_commit(self):
        offenders = self._sites()
        assert offenders == {}, (
            f"{sorted(offenders)} call `log_action` after their last "
            "`db.commit()`. `log_action` only adds the entry and `get_db` never "
            "commits, so the audit row is silently discarded (#898). Move the "
            "log above the commit."
        )
