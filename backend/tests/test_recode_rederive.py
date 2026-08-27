"""#584 step 2 — re-deriving a dependent from its source.

This writes stored numbers a researcher may already have reported, so the guards
here are about REFUSAL as much as about the copy: what it must not touch, and
what it must refuse outright rather than guess at.
"""
import json

import pytest

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetValue, DatasetRow
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.services.recode_rederive import (
    plan_rederive,
    apply_rederive,
    RederiveBlockedError,
    STATUS_READY,
    STATUS_NO_CHANGE,
    STATUS_BLOCKED,
)


def _project(db):
    db.add(Project(id=1, name="P", user_id=1)); db.flush()
    db.add(Dataset(id=1, project_id=1, name="D")); db.flush()


def _column(db, col_id):
    col = DatasetColumn(
        id=col_id, dataset_id=1, column_code=f"Q{col_id}", column_text=f"Q{col_id}",
        column_type="ordinal", sequence_order=col_id, display_order=col_id,
    )
    db.add(col); db.flush()
    return col


def _def(db, col, mapping, *, def_id, rtype=RecodeType.SCALE_MAP,
         source_id=None, primary=False, name=None):
    d = RecodeDefinition(
        id=def_id, column_id=col.id, name=name or f"def{def_id}",
        recode_type=rtype, output_type=OutputType.NUMERIC,
        mapping=json.dumps(mapping), is_primary=primary,
        source_definition_id=source_id, sequence_order=def_id,
    )
    db.add(d); db.flush()
    return d


class TestThePlan:
    def test_a_drifted_dependent_is_ready_and_names_what_moves(self, db_session):
        """The source moved from a 1..5 to a 1..7 scale; the copy still says 5."""
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col, {"Never": 1, "Always": 7}, def_id=1)
        _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
             rtype=RecodeType.REVERSE, source_id=1)

        plan = plan_rederive(db_session, src)
        assert len(plan) == 1
        assert plan[0].status == STATUS_READY
        # The evidence a confirm dialog needs: WHICH value moves, not just "1 change".
        assert plan[0].changed_keys == ["always"]

    def test_an_already_matching_dependent_is_a_no_op(self, db_session):
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col, {"Never": 1, "Always": 5}, def_id=1)
        _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
             rtype=RecodeType.REVERSE, source_id=1)

        plan = plan_rederive(db_session, src)
        assert plan[0].status == STATUS_NO_CHANGE
        assert plan[0].changed_keys == []

    def test_a_label_remapped_copy_is_BLOCKED_not_guessed_at(self, db_session):
        """🔴 The hazard. A crosswalk copy is remapped to the TARGET column's
        wording, so it shares NO key with the source. Copying the source's
        mapping onto it would write keys no cell carries — the definition would
        keep 'mapping' and NULL every cell on the next apply, silently.

        the internal design notes records exactly this for `copy_to`; the plan must refuse it.
        """
        _project(db_session)
        col_a = _column(db_session, 1)
        col_b = _column(db_session, 2)
        src = _def(db_session, col_a, {"Never": 1, "Always": 5}, def_id=1)
        _def(db_session, col_b, {"Jamais": 1, "Toujours": 5}, def_id=2,
             rtype=RecodeType.REVERSE, source_id=1, name="French copy")

        plan = plan_rederive(db_session, src)
        assert plan[0].status == STATUS_BLOCKED
        assert "no values in common" in plan[0].detail.lower() or \
               "shares no values" in plan[0].detail.lower()


class TestApplyRefusesRatherThanPartApplying:
    def test_a_blocked_member_aborts_the_WHOLE_batch(self, db_session):
        """⚠️ Skipping the blocked one would report success while leaving exactly
        the definition the researcher was trying to repair untouched — and the
        blocked case IS the crosswalk copy, the one most likely to be selected by
        someone who does not know it was remapped.
        """
        _project(db_session)
        col_a = _column(db_session, 1)
        col_b = _column(db_session, 2)
        src = _def(db_session, col_a, {"Never": 1, "Always": 7}, def_id=1)
        good = _def(db_session, col_a, {"Never": 1, "Always": 5}, def_id=2,
                    rtype=RecodeType.REVERSE, source_id=1)
        _def(db_session, col_b, {"Jamais": 1, "Toujours": 5}, def_id=3,
             rtype=RecodeType.REVERSE, source_id=1, name="French copy")

        with pytest.raises(RederiveBlockedError):
            apply_rederive(db_session, src, [2, 3])

        # The good one must be UNTOUCHED: an all-or-nothing promise that half-wrote
        # would be worse than no promise.
        assert json.loads(good.mapping)["Always"] == 5

    def test_an_id_that_is_not_a_dependent_is_refused(self, db_session):
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col, {"Never": 1, "Always": 7}, def_id=1)
        _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2)  # no source link

        with pytest.raises(RederiveBlockedError):
            apply_rederive(db_session, src, [2])


class TestTheCopy:
    def test_it_writes_the_sources_values_under_the_dependents_OWN_keys(self, db_session):
        """⚠️ `_comparable_keys` lower-cases for comparison only. Writing the
        lowered form back would silently rename every label to lowercase.
        """
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col, {"never": 1, "always": 7}, def_id=1)
        dep = _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
                   rtype=RecodeType.REVERSE, source_id=1)

        apply_rederive(db_session, src, [2])
        mapping = json.loads(dep.mapping)
        assert mapping == {"Never": 1, "Always": 7}, "keys must keep their own casing"

    def test_an_integral_code_stays_an_int(self, db_session):
        """A naive float write turns 7 into 7.0 in the stored JSON, and mapping
        values are compared and rendered as text downstream — the integer-aware
        trap `_fmt_code` exists for on the missing-values side.
        """
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col, {"Never": 1, "Always": 7}, def_id=1)
        dep = _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
                   rtype=RecodeType.REVERSE, source_id=1)

        apply_rederive(db_session, src, [2])
        assert '"Always": 7' in dep.mapping, dep.mapping
        assert "7.0" not in dep.mapping

    def test_re_deriving_twice_is_idempotent(self, db_session):
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col, {"Never": 1, "Always": 7}, def_id=1)
        dep = _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
                   rtype=RecodeType.REVERSE, source_id=1)

        first = apply_rederive(db_session, src, [2])
        second = apply_rederive(db_session, src, [2])
        assert first["updated"] == [2]
        # The second run finds nothing to do and says so, rather than erroring.
        assert second["updated"] == []
        assert second["skipped"] == [2]
        assert json.loads(dep.mapping)["Always"] == 7


class TestTheOffsetIsNeverWrittenByHand:
    """🔴 #600. A reverse definition stores FORWARD codes; the reflection offset
    is DERIVED at apply time by `effective_reverse_offset`, which EXCLUDES the
    null set. A re-derive that stored or recomputed an offset itself would
    reproduce #600 across every dependent at once — the exact defect that scored
    "Never" as 99 on every undeclared column.
    """

    def test_the_module_never_computes_min_plus_max(self):
        from pathlib import Path
        src = (
            Path(__file__).resolve().parents[1]
            / "app" / "services" / "recode_rederive.py"
        ).read_text(encoding="utf-8")
        # A hand-rolled reflection would need one of these; the module must have none.
        assert "reverse_offset" not in src.replace("effective_reverse_offset", "")
        assert "min(" not in src and "max(" not in src

    def test_a_null_set_key_is_copied_like_any_other_and_decides_nothing(self, db_session):
        """The N/A key rides along as a mapping entry; what it must NOT do is
        become a scale point. That decision lives in `effective_reverse_offset`,
        so this asserts the copy stays dumb.
        """
        _project(db_session)
        col = _column(db_session, 1)
        src = _def(db_session, col,
                   {"Never": 1, "Always": 7, "Prefer not to say": 99}, def_id=1)
        dep = _def(db_session, col,
                   {"Never": 1, "Always": 5, "Prefer not to say": 99}, def_id=2,
                   rtype=RecodeType.REVERSE, source_id=1)

        apply_rederive(db_session, src, [2])
        assert json.loads(dep.mapping)["Prefer not to say"] == 99


class TestAPrimaryDependentRecomputesItsColumn:
    def test_stored_scores_follow_the_new_mapping(self, db_session):
        """The mapping and `value_numeric` must not be separable: a mapping
        updated without its column recomputed leaves stored scores describing the
        OLD mapping — #767's shape, a stored result that no longer corresponds to
        what produced it.
        """
        _project(db_session)
        col = _column(db_session, 1)
        row = DatasetRow(id=1, dataset_id=1)
        db_session.add(row); db_session.flush()
        db_session.add(DatasetValue(
            id=1, row_id=1, column_id=col.id, value_text="Always", value_numeric=5,
        ))
        db_session.flush()

        src = _def(db_session, col, {"Never": 1, "Always": 7}, def_id=1)
        _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
             rtype=RecodeType.SCALE_MAP, source_id=1, primary=True)

        apply_rederive(db_session, src, [2])
        db_session.flush()
        val = db_session.get(DatasetValue, 1)
        assert val.value_numeric == 7, (
            "a primary dependent must recompute its column, or the stored score "
            "still describes the mapping that was just replaced"
        )


def test_the_plan_detail_reads_as_english_not_machine_text(db_session):
    """Found by driving it: the detail said "1 value(s)". This copy is read by a
    researcher deciding whether to change numbers they may have reported."""
    _project(db_session)
    col = _column(db_session, 1)
    src = _def(db_session, col, {"Never": 1, "Always": 7}, def_id=1)
    _def(db_session, col, {"Never": 1, "Always": 5}, def_id=2,
         rtype=RecodeType.REVERSE, source_id=1)

    detail = plan_rederive(db_session, src)[0].detail
    assert "1 value would be updated" in detail
    assert "value(s)" not in detail
