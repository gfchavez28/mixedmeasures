"""#1644 (r3-1) — a strand's CHOSEN sources are not refused at 500.

`MAX_SOURCES_PER_STRAND` was 500 and the builder's *Chosen* list had no cap, so a researcher who
chose 501 of D12's 900 conversations got "The joint display could not be computed. List should
have at most 500 items after validation, not 501" (driven in jsdom; the 422 through `TestClient`)
while *Every one* computed. Measured on D12, a chosen list costs no more than every one, so the
bound is now SQL's, not a choice's: one kind's list in ONE statement, under SQLite's compiled-in
default parameter limit (32,766) whatever a build sets.

Positive controls: a long list that names this project's conversation answers exactly as that
conversation alone (the ids beyond it are no source of this project), and a long list WITHOUT it
answers differently — so the list is really read.
"""
from __future__ import annotations

import sqlite3

import pytest

from app.models.user import User
from app.schemas import joint_display as wire
from app.schemas.joint_display import JointDisplayComputeRequest
from tests.test_joint_display import CONV, GROUP, ME, PID, PLAN, fx  # noqa: F401 — `fx` is a fixture

#: SQLite's compiled-in default `SQLITE_MAX_VARIABLE_NUMBER` (3.32+). Both builds measured here
#: raise it to 250,000; a build that kept the default must still take a full strand.
SQLITE_DEFAULT_VARIABLE_LIMIT = 32_766
FOREIGN = 50_000_000  # no row of any table has an id this high in the fixture


def _body(conversation_ids, document_ids=(), observation_ids=None):
    return JointDisplayComputeRequest(
        group_by_column_id=GROUP,
        strands=[{"key": "a", "kind": "codes", "conversation_ids": conversation_ids,
                  "document_ids": list(document_ids)},
                 {"key": "o", "kind": "observation_codes", "observation_ids": observation_ids}],
        rows=[{"key": "r", "bindings": {"a": {"code_ids": [PLAN]}}}])


def _cells(out):
    (code,) = out["rows"][0]["by_strand"]["a"]["codes"]
    return {c["group"]: (c["count"], c["n"]) for c in code["cells"]}


def _through_the_router(fx, body):
    from app.routers.joint_display import compute
    return compute(project_id=PID, body=body, user=fx.db.get(User, ME), db=fx.db)


@pytest.mark.parametrize("n", [501, 900])
@pytest.mark.parametrize("kind", ["conversation_ids", "document_ids", "observation_ids"])
def test_a_strand_may_choose_more_than_500_sources(kind, n):
    """The 501st (and D12's 900th) chosen source of any kind is a request the server takes."""
    ids = list(range(1, n + 1))
    strand = {"key": "a", "kind": "observation_codes" if kind == "observation_ids" else "codes", kind: ids}
    body = JointDisplayComputeRequest(group_by_column_id=1, strands=[strand])
    assert getattr(body.strands[0], kind) == ids


def test_the_bound_still_refuses_a_list_past_it():
    """A bound still stands (a request is never unbounded): one past it is refused."""
    too_many = list(range(1, wire.MAX_SOURCES_PER_STRAND + 2))
    with pytest.raises(ValueError):
        JointDisplayComputeRequest(group_by_column_id=1,
                                   strands=[{"key": "a", "kind": "codes", "conversation_ids": too_many}])


def test_a_long_chosen_list_reads_this_projects_sources_alone(fx):
    """600 chosen ids that are no conversation of this project change nothing; without the
    project's own conversation the same length answers differently (the list IS read)."""
    alone = _cells(_through_the_router(fx, _body([CONV])))
    assert alone["High"] == (3, 4)  # the strands test's own number, so the fixture is the one we think
    foreign = [FOREIGN + i for i in range(600)]
    assert _cells(_through_the_router(fx, _body([CONV, *foreign]))) == alone
    assert _cells(_through_the_router(fx, _body(foreign))) != alone


def test_a_full_strand_fits_under_sqlites_default_parameter_limit(fx):
    """Every source kind at the bound, through the compute, on a connection held to SQLite's
    DEFAULT limit — the request completes (a build that never raised the limit is safe)."""
    raw = fx.db.connection().connection.dbapi_connection
    raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, SQLITE_DEFAULT_VARIABLE_LIMIT)
    full = [CONV] + [FOREIGN + i for i in range(wire.MAX_SOURCES_PER_STRAND - 1)]
    out = _through_the_router(fx, _body(full, document_ids=full, observation_ids=full))
    assert _cells(out)["High"] == (3, 4)


def test_the_lowered_limit_really_refuses(fx):
    """DISCRIMINATION for the test above: under the same limit, one parameter past it raises —
    so the limit was applied, and the full strand passed under it on its own merits."""
    raw = fx.db.connection().connection.dbapi_connection
    raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, SQLITE_DEFAULT_VARIABLE_LIMIT)
    n = SQLITE_DEFAULT_VARIABLE_LIMIT + 1
    with pytest.raises(sqlite3.OperationalError, match="too many SQL variables"):
        raw.execute("SELECT 1 WHERE 1 IN (%s)" % ",".join("?" * n), list(range(n))).fetchall()
