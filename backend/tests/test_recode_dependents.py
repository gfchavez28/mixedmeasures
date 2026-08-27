"""#584 — who depends on a recode definition, and what a re-key kills.

The headline these pin is a POPULATION result, and it is the reason the module
has two functions rather than one. The filed entry says *"the dependents lookup
serves both [triggers]"*; measured, a relabel kills FOUR definitions on a
realistic column while the `source_definition_id` lookup finds ONE. Wiring
provenance to the re-key trigger would have reported "1 affected" — a count that
quietly shrinks, which reads exactly like a complete answer.
"""

import asyncio
import json

import pytest

from app.models.project import Project
from app.models.dataset import (
    Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType,
)
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.services.recode import compute_value
from app.services.recode_dependents import (
    DependentDefinition,
    dependents_of_definition,
    dead_definitions_for_column,
    newly_dead,
)
from app.services.value_labels import apply_value_labels


FORWARD = {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}
LABELS = [(1.0, "Never"), (2.0, "Rarely"), (3.0, "Sometimes"),
          (4.0, "Often"), (5.0, "Always")]


def _project(db):
    if db.query(Project).filter_by(id=1).first() is None:
        db.add(Project(id=1, name="P", user_id=1)); db.flush()
        db.add(Dataset(id=1, project_id=1, name="D")); db.flush()


def _column(db, seq=0, values=("1", "2", "3", "4", "5")):
    _project(db)
    c = DatasetColumn(dataset_id=1, column_text=f"Q{seq}", column_type=ColumnType.ORDINAL,
                      sequence_order=seq, display_order=seq)
    db.add(c); db.flush()
    for i, v in enumerate(values):
        r = DatasetRow(dataset_id=1, row_identifier=f"{seq}-{i}")
        db.add(r); db.flush()
        db.add(DatasetValue(row_id=r.id, column_id=c.id,
                            value_text=v, value_numeric=float(v) if v.isdigit() else None))
    db.flush()
    return c


def _defn(db, col, name, rtype, mapping, *, primary=False, source=None,
          auto=False, seq=0, output=OutputType.NUMERIC):
    d = RecodeDefinition(
        column_id=col.id, name=name, recode_type=rtype, output_type=output,
        mapping=json.dumps(mapping), is_primary=primary, is_auto_detected=auto,
        source_definition_id=source, sequence_order=seq,
    )
    db.add(d); db.flush()
    return d


def _populated(db):
    """A column carrying every definition shape a researcher can build."""
    col = _column(db)
    src = _defn(db, col, "auto", RecodeType.SCALE_MAP, FORWARD,
                primary=True, auto=True, seq=0)
    made = {
        "source": src,
        "reverse_linked": _defn(db, col, "rev-linked", RecodeType.REVERSE, FORWARD,
                                source=src.id, seq=1),
        "reverse_orphan": _defn(db, col, "rev-orphan", RecodeType.REVERSE, FORWARD, seq=2),
        "second_scale": _defn(db, col, "alt", RecodeType.SCALE_MAP,
                              {"1": 10, "2": 20, "3": 30, "4": 40, "5": 50}, seq=3),
        "category_group": _defn(db, col, "lo/hi", RecodeType.CATEGORY_GROUP,
                                {"1": "Low", "2": "Low", "3": "Mid", "4": "Hi", "5": "Hi"},
                                seq=4, output=OutputType.CATEGORICAL),
    }
    return col, made


class TestProvenanceLookup:
    """Trigger A — a source definition is edited or deleted."""

    def test_finds_the_definitions_that_name_it_as_source(self, db_session):
        col, made = _populated(db_session)
        found = dependents_of_definition(db_session, made["source"].id)
        assert [d.name for d in found] == ["rev-linked"]
        assert found[0].reason == "provenance"

    def test_finds_a_dependent_on_ANOTHER_column(self, db_session):
        """The crosswalk copies a definition and records where it came from, so
        a dependent is not necessarily a sibling. A `column_id` query — the
        obvious shortcut — would miss exactly this one."""
        col, made = _populated(db_session)
        other = _column(db_session, seq=7)
        _defn(db_session, other, "copied", RecodeType.REVERSE, FORWARD,
              source=made["source"].id, seq=0)
        found = dependents_of_definition(db_session, made["source"].id)
        assert sorted(d.name for d in found) == ["copied", "rev-linked"]
        assert {d.column_id for d in found} == {col.id, other.id}

    def test_nothing_links_to_a_standalone_definition(self, db_session):
        col, made = _populated(db_session)
        assert dependents_of_definition(db_session, made["second_scale"].id) == []

    def test_a_drifted_dependent_still_maps_every_cell(self, db_session):
        """Provenance drift is INVISIBLE, which is why it needs a lookup at all:
        editing the source leaves the dependent working and merely disagreeing."""
        col, made = _populated(db_session)
        made["source"].mapping = json.dumps({"1": 0, "2": 1, "3": 2, "4": 3, "5": 4})
        db_session.flush()
        rev = made["reverse_linked"]
        assert [compute_value(str(i), rev) for i in range(1, 6)] == [5.0, 4.0, 3.0, 2.0, 1.0]
        assert dead_definitions_for_column(db_session, col) == []


class TestReKeyLookup:
    """Trigger B — the column is relabelled under its definitions."""

    def test_a_healthy_column_reports_nothing(self, db_session):
        col, _ = _populated(db_session)
        assert dead_definitions_for_column(db_session, col) == []

    def test_relabelling_kills_FOUR_definitions_not_one(self, db_session):
        """🔴 The population result this module exists for.

        Provenance finds one; the re-key kills four. Asserted as the whole set
        rather than "the reverse one is in there", because the per-item form
        passes just as happily on an answer that is 75% short.
        """
        col, made = _populated(db_session)
        res = apply_value_labels(db_session, col, LABELS)

        staled = {d["name"] for d in res["staled_definitions"]}
        assert staled == {"rev-linked", "rev-orphan", "alt", "lo/hi"}
        assert all(d["reason"] == "unmapped" for d in res["staled_definitions"])

        # And the contrast that makes the two lookups non-interchangeable.
        provenance = dependents_of_definition(db_session, made["source"].id)
        assert len(provenance) == 1 < len(staled)

    def test_the_killed_definitions_really_map_nothing(self, db_session):
        """Not a proxy: run them over the cells that now exist."""
        col, made = _populated(db_session)
        apply_value_labels(db_session, col, LABELS)
        cells = [v.value_text for v in db_session.query(DatasetValue)
                 .filter(DatasetValue.column_id == col.id).all()]
        assert set(cells) == {"Never", "Rarely", "Sometimes", "Often", "Always"}
        for key in ("reverse_linked", "reverse_orphan", "second_scale", "category_group"):
            db_session.refresh(made[key])
            assert [compute_value(c, made[key]) for c in cells] == [None] * 5

    def test_the_rewritten_primary_survives(self, db_session):
        """`apply_value_labels` re-keys its own auto primary, so it must NOT be
        reported — a report that blames the operation for its own correct work
        is noise, and noise is how a real warning gets ignored."""
        col, made = _populated(db_session)
        res = apply_value_labels(db_session, col, LABELS)
        assert "auto" not in {d["name"] for d in res["staled_definitions"]}
        db_session.refresh(made["source"])
        assert [compute_value(c, made["source"])
                for c in ("Never", "Always")] == [1, 5]

    def test_an_already_dead_definition_is_not_blamed_on_the_relabel(self, db_session):
        """Blame discipline: only what THIS call broke."""
        col, made = _populated(db_session)
        _defn(db_session, col, "was-already-dead", RecodeType.SCALE_MAP,
              {"nope": 1, "never-matched": 2}, seq=9)
        res = apply_value_labels(db_session, col, LABELS)
        assert "was-already-dead" not in {d["name"] for d in res["staled_definitions"]}

    def test_case_differences_are_not_death(self, db_session):
        """`compute_value` looks up case-insensitively, so a case-only
        difference must not be reported as unmapped — that would be a warning
        about a definition that works."""
        col = _column(db_session, seq=3, values=("Yes", "No"))
        _defn(db_session, col, "shouty", RecodeType.SCALE_MAP, {"YES": 1, "NO": 0}, seq=0)
        assert dead_definitions_for_column(db_session, col) == []

    def test_an_empty_column_reports_nothing(self, db_session):
        """With no stored values nothing can match, so every definition would
        look dead. That is an artefact of having no data, not a finding."""
        col = _column(db_session, seq=4, values=())
        _defn(db_session, col, "orphan", RecodeType.SCALE_MAP, FORWARD, seq=0)
        assert dead_definitions_for_column(db_session, col) == []


class TestNewlyDead:
    def test_reports_only_the_difference(self, db_session):
        col, made = _populated(db_session)
        before = dead_definitions_for_column(db_session, col)
        apply_value_labels(db_session, col, LABELS)
        after = dead_definitions_for_column(db_session, col)
        assert before == []
        assert {d.name for d in newly_dead(before, after)} == {
            "rev-linked", "rev-orphan", "alt", "lo/hi"}

    def test_an_entry_present_in_both_is_excluded(self, db_session):
        col, made = _populated(db_session)
        dead = dead_definitions_for_column(db_session, col)  # empty here
        pre = [DependentDefinition(
            id=made["second_scale"].id, name="alt", recode_type="scale_map",
            column_id=col.id, is_primary=False, reason="unmapped",
        )]
        apply_value_labels(db_session, col, LABELS)
        after = dead_definitions_for_column(db_session, col)
        assert "alt" not in {d.name for d in newly_dead(pre, after)}
        assert dead == []


class TestNothingIsRepaired:
    def test_the_report_does_not_touch_the_definitions(self, db_session):
        """⛔ Reporting must never propagate: re-deriving changes stored numbers
        a researcher may already have reported (#710)."""
        col, made = _populated(db_session)
        before = {k: d.mapping for k, d in made.items()}
        apply_value_labels(db_session, col, LABELS)
        for key in ("reverse_linked", "reverse_orphan", "second_scale", "category_group"):
            db_session.refresh(made[key])
            assert made[key].mapping == before[key], f"{key} was silently rewritten"


def _run(coro):
    """Invoke an async router function synchronously — the project's direct-call
    pattern (`test_recode.py:_run`)."""
    return asyncio.run(coro)


class TestDependentsEndpoint:
    """The endpoint exists so the client can warn BEFORE the change.

    Its own endpoint rather than a field on the PATCH/DELETE response,
    deliberately: a warning that arrives with the result of the thing it was
    warning about is not a warning.
    """

    def test_lists_the_dependents_of_a_source(self, db_session):
        from app.models.user import User
        from app.routers.recode import list_definition_dependents

        col, made = _populated(db_session)
        user = db_session.query(User).filter_by(id=1).first()
        out = _run(list_definition_dependents(
            project_id=1, dataset_id=1, column_id=col.id,
            definition_id=made["source"].id, user=user, db=db_session,
        ))
        assert [d["name"] for d in out] == ["rev-linked"]
        assert out[0]["reason"] == "provenance"

    def test_is_empty_for_a_definition_nothing_depends_on(self, db_session):
        from app.models.user import User
        from app.routers.recode import list_definition_dependents

        col, made = _populated(db_session)
        user = db_session.query(User).filter_by(id=1).first()
        out = _run(list_definition_dependents(
            project_id=1, dataset_id=1, column_id=col.id,
            definition_id=made["category_group"].id, user=user, db=db_session,
        ))
        assert out == []

    def test_404s_for_a_definition_on_another_column(self, db_session):
        """The ownership chain still applies: `_get_definition_or_404` scopes
        the definition to the column named in the path, so a caller cannot read
        one column's dependents through another column's URL."""
        from fastapi import HTTPException
        from app.models.user import User
        from app.routers.recode import list_definition_dependents

        col, made = _populated(db_session)
        other = _column(db_session, seq=8)
        user = db_session.query(User).filter_by(id=1).first()
        with pytest.raises(HTTPException) as exc:
            _run(list_definition_dependents(
                project_id=1, dataset_id=1, column_id=other.id,
                definition_id=made["source"].id, user=user, db=db_session,
            ))
        assert exc.value.status_code == 404
