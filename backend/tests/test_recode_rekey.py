"""#584's death arm — re-keying a definition a relabel killed.

The fixtures here are built by running the REAL relabel (`apply_value_labels`)
rather than by hand-writing the post-relabel state: the whole operation is a
translation between two things that service produces, so a hand-made "after"
state could agree with an implementation that misunderstands it.
"""
import json

import pytest

from app.models.project import Project
from app.models.dataset import (
    Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType,
)
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.services.value_labels import apply_value_labels
from app.services.recode import compute_value, _parse_mapping, _parse_exclude_values
from app.services.recode_dependents import dead_definitions_for_column
from app.services.recode_rekey import (
    plan_rekey,
    apply_rekey,
    RekeyBlockedError,
    STATUS_READY,
    STATUS_BLOCKED,
)

CODES = [(1.0, "Strongly disagree"), (2.0, "Disagree"), (3.0, "Neutral"),
         (4.0, "Agree"), (5.0, "Strongly agree")]


def _column(db, *, cells=("1", "2", "3", "4", "5")):
    db.add(Project(id=1, name="P", user_id=1)); db.flush()
    db.add(Dataset(id=1, project_id=1, name="D")); db.flush()
    col = DatasetColumn(
        id=1, dataset_id=1, column_code="Q1", column_text="Q1",
        column_type=ColumnType.ORDINAL, sequence_order=1, display_order=1,
    )
    db.add(col); db.flush()
    for i, cell in enumerate(cells, start=1):
        db.add(DatasetRow(id=i, dataset_id=1)); db.flush()
        db.add(DatasetValue(row_id=i, column_id=1, value_text=cell,
                            value_numeric=float(cell) if cell.isdigit() else None))
    db.flush()
    return col


def _def(db, col, mapping, *, def_id, rtype=RecodeType.SCALE_MAP,
         primary=False, name=None, excludes=None):
    d = RecodeDefinition(
        id=def_id, column_id=col.id, name=name or f"def{def_id}",
        recode_type=rtype,
        output_type=(OutputType.CATEGORICAL if rtype == RecodeType.CATEGORY_GROUP
                     else OutputType.NUMERIC),
        mapping=json.dumps(mapping), is_primary=primary,
        exclude_values=json.dumps(excludes) if excludes else None,
        sequence_order=def_id,
    )
    db.add(d); db.flush()
    return d


def _relabel(db, col, pairs=CODES):
    report = apply_value_labels(db, col, list(pairs))
    db.flush()
    return report


class TestThePlan:
    def test_a_definition_killed_by_the_relabel_is_ready_and_names_the_renames(
        self, db_session,
    ):
        """The measured case: a column of bare codes gains labels, and every
        definition keyed on the raw code text stops matching."""
        col = _column(db_session)
        _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5},
             def_id=2, rtype=RecodeType.REVERSE, name="reverse")
        report = _relabel(db_session, col)

        # Precondition: the relabel really did kill it (this is what makes the
        # rest of the test about the re-key rather than about nothing).
        assert [d["name"] for d in report["staled_definitions"]] == ["reverse"]

        plan = plan_rekey(db_session, col)
        assert len(plan) == 1
        assert plan[0].status == STATUS_READY
        assert [(r.old, r.new) for r in plan[0].renames] == [
            ("1", "Strongly disagree"), ("2", "Disagree"), ("3", "Neutral"),
            ("4", "Agree"), ("5", "Strongly agree"),
        ]

    def test_the_plan_only_covers_definitions_that_are_actually_dead(self, db_session):
        """A definition still mapping its cells must never be offered a re-key —
        renaming its keys would break the one thing that still works."""
        col = _column(db_session)
        _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}, def_id=2)
        _relabel(db_session, col)
        # The auto primary `apply_value_labels` maintains is keyed on the NEW
        # labels, so it is alive and must be absent from the plan.
        alive = [d for d in db_session.query(RecodeDefinition).all() if d.is_primary]
        assert alive and alive[0].id not in {p.definition_id for p in plan_rekey(db_session, col)}

    def test_a_definition_keyed_on_PREVIOUS_LABELS_is_blocked(self, db_session):
        """🔴 The irreducible case. Relabelling an already-labelled column leaves
        no path from an old label back to a code — the previous dictionary is
        overwritten in the metadata, the auto primary AND the cells."""
        col = _column(db_session)
        _relabel(db_session, col, [(1.0, "Never"), (2.0, "Rarely"), (3.0, "Sometimes"),
                                   (4.0, "Often"), (5.0, "Always")])
        _def(db_session, col,
             {"Never": 1, "Rarely": 2, "Sometimes": 3, "Often": 4, "Always": 5},
             def_id=2, rtype=RecodeType.REVERSE, name="on old labels")
        _relabel(db_session, col)  # every label changes at once

        plan = plan_rekey(db_session, col)
        assert [p.status for p in plan] == [STATUS_BLOCKED]
        assert plan[0].unresolved_keys == ["Never", "Rarely", "Sometimes",
                                           "Often", "Always"]
        assert "cannot be matched to a code" in plan[0].detail

    def test_a_PARTIAL_rename_kills_nothing_so_nothing_is_offered(self, db_session):
        """The measured bound on the blocked case above: `dead_definitions_for_column`
        requires ZERO overlap, so one renamed label leaves every definition alive."""
        col = _column(db_session)
        _relabel(db_session, col, [(1.0, "Never"), (2.0, "Rarely"), (3.0, "Sometimes"),
                                   (4.0, "Often"), (5.0, "Always")])
        _def(db_session, col,
             {"Never": 1, "Rarely": 2, "Sometimes": 3, "Often": 4, "Always": 5},
             def_id=2, rtype=RecodeType.REVERSE)
        _relabel(db_session, col, [(1.0, "Never"), (2.0, "Rarely"), (3.0, "Sometimes"),
                                   (4.0, "Frequently"), (5.0, "Always")])

        assert dead_definitions_for_column(db_session, col) == []
        assert plan_rekey(db_session, col) == []

    def test_one_unresolvable_key_blocks_the_whole_definition(self, db_session):
        """A part-translated mapping is the failure mode the split exists to
        avoid — and the plan must NAME the key so it can be fixed by hand."""
        col = _column(db_session)
        _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "Refused": 9},
             def_id=2)
        _relabel(db_session, col)

        plan = plan_rekey(db_session, col)
        assert plan[0].status == STATUS_BLOCKED
        assert plan[0].unresolved_keys == ["Refused"]
        assert plan[0].renames == []  # nothing offered, not "most of it"

    def test_two_keys_resolving_to_one_label_are_blocked_not_merged(self, db_session):
        """`{"1": …, "1.0": …}` both resolve to code 1. Writing both would keep
        whichever landed last and silently drop the other mapping entry."""
        col = _column(db_session)
        _def(db_session, col, {"1": 1, "1.0": 2}, def_id=2)
        _relabel(db_session, col)

        plan = plan_rekey(db_session, col)
        assert plan[0].status == STATUS_BLOCKED
        assert "merge them into one entry" in plan[0].detail

    def test_a_rekey_that_would_still_match_nothing_is_blocked(self, db_session):
        """🔴 The self-check. If the column's declared labels disagree with the
        text its cells carry, the rename resolves cleanly and achieves nothing —
        a no-op that would otherwise report success."""
        col = _column(db_session)
        _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}, def_id=2)
        _relabel(db_session, col)
        # Drift the metadata away from the cells without touching the cells.
        col.scale_labels = json.dumps(["A", "B", "C", "D", "E"])
        db_session.flush()

        plan = plan_rekey(db_session, col)
        assert plan[0].status == STATUS_BLOCKED
        assert "disagree" in plan[0].detail

    def test_a_column_with_no_dictionary_blocks_rather_than_guessing(self, db_session):
        col = _column(db_session, cells=("x", "y"))
        _def(db_session, col, {"1": 1, "2": 2}, def_id=2)
        plan = plan_rekey(db_session, col)
        assert plan[0].status == STATUS_BLOCKED
        assert "no value labels" in plan[0].detail


class TestApply:
    def test_a_rekeyed_definition_maps_its_cells_again(self, db_session):
        """The point of the whole feature, asserted on `compute_value` rather
        than on the stored mapping: the mapping is the mechanism, matching the
        data is the claim."""
        col = _column(db_session)
        d = _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5},
                 def_id=2, rtype=RecodeType.REVERSE)
        _relabel(db_session, col)
        assert compute_value("Strongly disagree", d) is None  # dead

        result = apply_rekey(db_session, col, [2])
        assert result["updated"] == [2]
        assert result["renamed_keys"] == 5
        db_session.refresh(d)
        # Reversed about min+max = 6, i.e. the definition works as authored.
        assert compute_value("Strongly disagree", d) == 5.0
        assert compute_value("Strongly agree", d) == 1.0
        assert dead_definitions_for_column(db_session, col) == []

    def test_values_are_copied_verbatim_and_only_keys_move(self, db_session):
        col = _column(db_session)
        d = _def(db_session, col, {"1": 1, "2": 1, "3": 2, "4": 3, "5": 3}, def_id=2)
        _relabel(db_session, col)
        apply_rekey(db_session, col, [2])
        db_session.refresh(d)
        assert _parse_mapping(d) == {
            "Strongly disagree": 1, "Disagree": 1, "Neutral": 2,
            "Agree": 3, "Strongly agree": 3,
        }

    def test_a_primary_definition_has_its_column_recomputed(self, db_session):
        """The mapping edit and the re-apply are inseparable — a mapping updated
        without its column recomputed leaves stored scores describing keys that
        no longer exist (#767's shape)."""
        col = _column(db_session)
        _relabel(db_session, col)
        # Promote a dead definition to primary — the #580 class this warns about.
        auto = db_session.query(RecodeDefinition).filter_by(is_primary=True).one()
        auto.is_primary = False
        d = _def(db_session, col, {"1": 5, "2": 4, "3": 3, "4": 2, "5": 1},
                 def_id=9, primary=True, name="flipped primary")
        db_session.flush()

        apply_rekey(db_session, col, [9])
        db_session.refresh(d)
        stored = {
            v.value_text: v.value_numeric
            for v in db_session.query(DatasetValue).filter_by(column_id=col.id).all()
        }
        assert stored["Strongly disagree"] == 5.0
        assert stored["Strongly agree"] == 1.0

    def test_exclude_values_are_rekeyed_with_the_mapping(self, db_session):
        """⚠️ Load-bearing, not tidiness: a code in BOTH channels was excluded
        before the relabel, and renaming only the mapping would start scoring a
        response the researcher deliberately dropped."""
        col = _column(db_session)
        d = _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5},
                 def_id=2, excludes=["3"])
        _relabel(db_session, col)
        apply_rekey(db_session, col, [2])
        db_session.refresh(d)

        assert _parse_exclude_values(d) == ["Neutral"]
        assert compute_value("Neutral", d) is None      # still excluded
        assert compute_value("Agree", d) == 4           # and the rest map

    def test_a_blocked_member_refuses_the_WHOLE_batch(self, db_session):
        """Skipping it would report success while leaving untouched precisely
        the definition the researcher was trying to repair."""
        col = _column(db_session)
        ok = _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}, def_id=2)
        _def(db_session, col, {"1": 1, "Refused": 9}, def_id=3, name="has a stray")
        _relabel(db_session, col)

        with pytest.raises(RekeyBlockedError) as exc:
            apply_rekey(db_session, col, [2, 3])
        assert "has a stray" in str(exc.value)
        db_session.refresh(ok)
        assert _parse_mapping(ok) == {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}

    def test_an_id_that_is_not_awaiting_a_rekey_is_refused(self, db_session):
        col = _column(db_session)
        _relabel(db_session, col)
        alive = db_session.query(RecodeDefinition).filter_by(is_primary=True).one()
        with pytest.raises(RekeyBlockedError):
            apply_rekey(db_session, col, [alive.id])

    def test_an_empty_request_writes_nothing(self, db_session):
        col = _column(db_session)
        _def(db_session, col, {"1": 1, "2": 2}, def_id=2)
        _relabel(db_session, col)
        assert apply_rekey(db_session, col, []) == {"updated": [], "renamed_keys": 0}


class TestTheEndpointsAreWired:
    """The service works; these ask whether the ROUTER reaches it.

    Unit-testing the service proves the function is right and says nothing about
    whether a request gets there — the #747 class, where a correctly-written
    post-pass was called ~50 lines before the data it needed existed and every
    direct-call guard stayed green.
    """

    def _user(self, db):
        from app.models.user import User
        return db.query(User).filter_by(id=1).one()

    def test_the_plan_endpoint_returns_the_dead_definitions(self, db_session):
        import asyncio
        from app.routers.recode import plan_column_rekey

        col = _column(db_session)
        _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}, def_id=2,
             name="reverse", rtype=RecodeType.REVERSE)
        _relabel(db_session, col)

        out = asyncio.run(plan_column_rekey(
            project_id=1, dataset_id=1, column_id=col.id,
            user=self._user(db_session), db=db_session,
        ))
        assert [r["name"] for r in out] == ["reverse"]
        assert out[0]["renames"][0] == {"old": "1", "new": "Strongly disagree"}

    def test_the_apply_endpoint_writes_and_audits(self, db_session):
        import asyncio
        from app.models.audit import AuditEntry
        from app.routers.recode import rekey_column_definitions
        from app.schemas.recode import RekeyRequest

        col = _column(db_session)
        d = _def(db_session, col, {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}, def_id=2)
        _relabel(db_session, col)

        out = asyncio.run(rekey_column_definitions(
            project_id=1, dataset_id=1, column_id=col.id,
            body=RekeyRequest(definition_ids=[2]),
            user=self._user(db_session), db=db_session,
        ))
        assert out["updated"] == [2] and out["renamed_keys"] == 5
        db_session.refresh(d)
        assert compute_value("Neutral", d) == 3

        entry = db_session.query(AuditEntry).filter_by(action="rekeyed").one()
        assert json.loads(entry.details)["renamed_keys"] == 5

    def test_a_blocked_definition_answers_409_not_500(self, db_session):
        import asyncio
        from fastapi import HTTPException
        from app.routers.recode import rekey_column_definitions
        from app.schemas.recode import RekeyRequest

        col = _column(db_session)
        _def(db_session, col, {"1": 1, "Refused": 9}, def_id=2)
        _relabel(db_session, col)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(rekey_column_definitions(
                project_id=1, dataset_id=1, column_id=col.id,
                body=RekeyRequest(definition_ids=[2]),
                user=self._user(db_session), db=db_session,
            ))
        assert exc.value.status_code == 409


class TestTheOffsetIsNeverHandRolled:
    def test_the_module_computes_no_reflection_offset(self):
        """A REVERSE definition's offset excludes the null set (#600) and is
        derived at apply time. A `min(`/`max(` in this module would mean it had
        been recomputed here, reproducing #600 across every re-keyed definition
        at once — the same source assertion the drift arm carries.
        """
        from pathlib import Path
        import app.services.recode_rekey as mod

        src = Path(mod.__file__).read_text()
        code = "\n".join(
            line for line in src.splitlines()
            if not line.lstrip().startswith("#")
        )
        # Strip the module docstring, which discusses the rule in prose.
        body = code.split('"""', 2)[-1]
        assert "min(" not in body and "max(" not in body
