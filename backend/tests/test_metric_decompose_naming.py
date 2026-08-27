"""#823(k) — a decomposed domain's metrics must be tellable apart.

**The filed report was wrong about what it saw, and building it as filed would
have destroyed data.** It read four rows named *"Mean: Trust scale A (Depends =
middle)"* (ids 69–72) as "duplicate metric definitions created by repeat visits"
and asked for de-duplication. Measured against the real corpus, they are the
domain aggregate plus its three DECOMPOSED per-item metrics — `fair A3`,
`helpful A3`, `trust A3` — four genuinely distinct computations that differ only
in `config`. Deleting three of them would have deleted real results.

`find_or_create_metric` already keys on `config`, so the reuse the report assumed
was missing has always worked. What was missing is that `_auto_name_metric` never
received `config`, so every sibling inherited the DOMAIN's name.
"""
import asyncio

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.user import User
from app.services.metrics import find_or_create_metric


def _run(coro):
    return asyncio.run(coro)


def _seed(db):
    p = Project(id=880, name="P", user_id=1); db.add(p); db.flush()
    d = Dataset(id=880, project_id=880, name="D"); db.add(d); db.flush()
    cols = []
    for i, nm in enumerate(("trust", "fair", "helpful")):
        c = DatasetColumn(
            dataset_id=d.id, column_code=f"Q{i}", column_name=nm,
            column_text=f"{nm} text", column_type=ColumnType.ORDINAL,
            sequence_order=i, display_order=i,
        )
        db.add(c); cols.append(c)
    db.flush()
    row = DatasetRow(dataset_id=d.id, row_identifier="R0001"); db.add(row); db.flush()
    for c in cols:
        db.add(DatasetValue(row_id=row.id, column_id=c.id, value_text="3", value_numeric=3))
    dom = AnalysisDomain(id=880, project_id=880, name="Trust scale A"); db.add(dom); db.flush()
    for i, c in enumerate(cols):
        db.add(AnalysisDomainMember(domain_id=dom.id, member_type="column", member_id=c.id, sequence_order=i))
    db.flush()
    return dom, cols


def _make(db, dom, config):
    metric, _is_new = find_or_create_metric(
        db, 880, source_type="dataset_domain", source_id=dom.id,
        metric_type="mean", config=config,
        grouping_column_id=None, grouping_column_id_2=None,
        exclude_values=None, grouping_mode=None,
    )
    return metric


def test_decomposed_siblings_do_not_share_one_name(db_session):
    """The regression. Without `config`, all four of these read identically."""
    dom, cols = _seed(db_session)

    aggregate = _make(db_session, dom, {})
    parts = [
        _make(db_session, dom, {"decompose_column_ids": [c.id], "decompose_label": c.column_name})
        for c in cols
    ]

    names = [aggregate.name] + [m.name for m in parts]
    assert len(set(names)) == 4, f"names collide: {names}"


def test_each_decomposed_metric_names_its_own_item(db_session):
    dom, cols = _seed(db_session)
    m = _make(db_session, dom, {"decompose_column_ids": [cols[1].id], "decompose_label": "fair"})
    assert "Trust scale A" in m.name, "the domain is still what the researcher selected"
    assert "fair" in m.name, "and the item is what this row actually computes"


def test_the_aggregate_itself_is_unchanged(db_session):
    """A config with no decompose label must name exactly as it always did."""
    dom, _cols = _seed(db_session)
    assert _make(db_session, dom, {}).name == "Mean: Trust scale A"


def test_they_are_four_distinct_metrics_not_duplicates(db_session):
    """🔴 The premise check — the thing the filed fix would have destroyed.

    Asserts the property that makes de-duplication WRONG: differing only in
    `config`, these resolve to four separate rows, and asking for the same
    config twice reuses one.
    """
    dom, cols = _seed(db_session)
    ids = {
        _make(db_session, dom, {}).id,
        *[
            _make(db_session, dom,
                  {"decompose_column_ids": [c.id], "decompose_label": c.column_name}).id
            for c in cols
        ],
    }
    assert len(ids) == 4, "decomposed metrics are distinct rows, not duplicates"

    # And the dedup this report assumed was missing does work: same config in,
    # same row back.
    again = _make(db_session, dom,
                  {"decompose_column_ids": [cols[0].id], "decompose_label": cols[0].column_name})
    assert again.id in ids
