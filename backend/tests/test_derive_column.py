"""Decision B — deriving a NEW variable from a recode rule.

The tests are grouped by the thing that would break, not by function, because the
findings this build came from are each a pair of behaviours that only work
together (the missing story), a shape that only one caller sees (portability's
self-reference), or a claim that only measurement can settle (the match rule
agreeing with the in-place apply).
"""

import json

import pytest

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.services.derive_column import (
    derive_column,
    plan_derived_column,
    DeriveColumnError,
)
from app.services.recode import apply_definition_to_column


LIKERT = ["Never", "Rarely", "Sometimes", "Often", "Always"]


@pytest.fixture
def test_project(db_session):
    project = Project(name="Derive Test Project", user_id=1)
    db_session.add(project)
    db_session.flush()
    return project


def _dataset(db, project):
    ds = Dataset(project_id=project.id, name="Wellbeing")
    db.add(ds)
    db.flush()
    return ds


def _column(db, ds, *, labelled=True, ctype=ColumnType.ORDINAL, missing=None):
    col = DatasetColumn(
        dataset_id=ds.id,
        column_text="Math anxiety",
        column_type=ctype,
        sequence_order=1,
        display_order=1,
        source="imported",
        missing_values=missing,
    )
    if labelled:
        col.scale_labels = json.dumps(LIKERT)
        col.scale_values = json.dumps([1, 2, 3, 4, 5])
        col.scale_points = 5
    db.add(col)
    db.flush()
    return col


def _rows(db, ds, col, cells):
    """One row per cell. Returns the created rows."""
    out = []
    for i, cell in enumerate(cells):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i}")
        db.add(row)
        db.flush()
        text, num = cell if isinstance(cell, tuple) else (cell, None)
        db.add(DatasetValue(row_id=row.id, column_id=col.id, value_text=text, value_numeric=num))
        out.append(row)
    db.flush()
    return out


def _reverse_def(db, col, name="Anxiety (reversed)"):
    d = RecodeDefinition(
        column_id=col.id,
        name=name,
        recode_type=RecodeType.REVERSE,
        output_type=OutputType.NUMERIC,
        mapping=json.dumps({lbl: i + 1 for i, lbl in enumerate(LIKERT)}),
        sequence_order=0,
    )
    db.add(d)
    db.flush()
    return d


class TestTheDerivedColumnIsUsable:
    """The point of Decision B: the result must be a variable you can work with."""

    def test_it_is_manual_not_computed_so_every_editor_stays_reachable(self, db_session, test_project):
        """🔴 #806's lesson, enforced.

        A computed column is refused value labels, missing rules AND recode
        definitions by three separate endpoints whatever its type. Creating a
        derived variable as `computed` would produce something that looks right
        and offers three editors that all 403 — which is precisely the defect the
        popover thinning found. The type is asserted here rather than left to the
        endpoint tests because it is the whole reason B does not reuse the
        computed-column path.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always", "Sometimes"])
        d = _reverse_def(db_session, col)

        new_col, _ = derive_column(db_session, col, d, "Anxiety R")

        assert new_col.source == "manual"
        assert new_col.expression is None, (
            "an expression would enrol this column in every computed-column "
            "recompute and topological sort — all three readers of "
            "depends_on_column_ids gate on `expression IS NOT NULL`"
        )
        assert new_col.depends_on_column_ids is None

    def test_the_source_is_left_completely_untouched(self, db_session, test_project):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col)

        before = [
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == col.id)
            .order_by(DatasetValue.id)
        ]
        derive_column(db_session, col, d, "Anxiety R")
        after = [
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == col.id)
            .order_by(DatasetValue.id)
        ]
        assert before == after
        assert db_session.query(RecodeDefinition).filter(
            RecodeDefinition.column_id == col.id
        ).count() == 1

    def test_bare_codes_satisfy_the_code_identity_rule(self, db_session, test_project):
        """The shape decision, pinned against the guard it was chosen to satisfy.

        Storing the OUTPUT as bare codes means value_text "5" with
        value_numeric 5.0 — so the code the text implies equals the stored
        number, and `apply_value_labels` accepts the column. Carrying the
        source's labels verbatim would have produced ("Never", 5.0): the #585
        state, un-labellable forever.
        """
        from app.services.value_labels import code_identity_violation

        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always", "Sometimes"])
        d = _reverse_def(db_session, col)

        new_col, _ = derive_column(db_session, col, d, "Anxiety R")
        db_session.flush()

        pairs = {
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        }
        assert pairs == {("5", 5.0), ("1", 1.0), ("3", 3.0)}
        # The guard reads the distinct (text, code) pairs — the same set
        # `apply_value_labels` already fetches, which is why it costs no extra
        # query there. `None` means "no cell's stored number disagrees with the
        # code its own text implies".
        assert code_identity_violation(new_col, sorted(pairs), None) is None


class TestItAgreesWithTheInPlaceRecode:
    """One cell, one number, whichever operation computes it (#542b)."""

    def test_derived_values_equal_what_setting_the_rule_primary_would_produce(
        self, db_session, test_project
    ):
        """🔴 The reason `plan_definition_over_column` was extracted.

        A derived column whose numbers disagreed with the same rule applied in
        place would be the #542b defect wearing a new hat — and nothing on
        screen would show it, because each result is internally consistent.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Rarely", "Sometimes", "Often", "Always"])
        d = _reverse_def(db_session, col)

        new_col, _ = derive_column(db_session, col, d, "Anxiety R")
        db_session.flush()
        derived = {
            v.row_id: v.value_numeric
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        }

        apply_definition_to_column(db_session, d)
        db_session.flush()
        in_place = {
            v.row_id: v.value_numeric
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id)
        }

        assert derived == in_place
        assert set(derived.values()) == {5.0, 4.0, 3.0, 2.0, 1.0}


class TestTheMissingStoryTravelsAsAPair:
    """Neither half works alone — see the module docstring in derive_column.py."""

    def test_a_declared_sentinel_survives_as_text_and_as_a_rule(self, db_session, test_project):
        """🔴 The finding that changed the build.

        Blanking null-set cells makes "Refused" and "never answered"
        indistinguishable (#596). Carrying the text through WITHOUT the
        declaration is worse: the `_is_na` defaults are an English prefix list,
        so a sentinel like GSS's `.n:` matches nothing and ~42% of cells
        silently become data feeding the means.
        """
        rules = json.dumps([{"value": ".n:", "label": "No answer"}])
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds, missing=rules)
        _rows(db_session, ds, col, ["Never", ".n:", "Always"])
        d = _reverse_def(db_session, col)

        new_col, report = derive_column(db_session, col, d, "Anxiety R")
        db_session.flush()

        assert new_col.missing_values == rules, "the declaration must come across"
        pairs = {
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        }
        assert (".n:", None) in pairs, "the sentinel's text is carried, not blanked"
        assert report["missing_values_carried"] == [".n:"]

        # And the two halves together mean the derived column AGREES about what
        # is missing — the property neither half delivers on its own.
        from app.services.missing_values import is_missing_for_column
        assert is_missing_for_column(new_col, ".n:") is True

    def test_an_undeclared_sentinel_would_have_been_the_silent_case(self, db_session, test_project):
        """The same data with NO declaration: `.n:` is not recognised by default.

        This is the control that gives the test above its meaning — it shows the
        default rules genuinely do not catch this sentinel, so carrying the
        declaration is load-bearing rather than belt-and-braces.
        """
        from app.services.missing_values import is_missing
        assert is_missing(".n:", None) is False


class TestUnmappedValuesAreDisclosedNotDeleted:
    def test_a_value_the_rule_does_not_cover_is_carried_through_and_reported(
        self, db_session, test_project
    ):
        """#794's rule: a partial match is disclosed, never prevented."""
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Strongly agree", "Always"])
        d = _reverse_def(db_session, col)

        new_col, report = derive_column(db_session, col, d, "Anxiety R")
        db_session.flush()

        assert report["unmapped_values"] == ["Strongly agree"]
        pairs = {
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        }
        assert ("Strongly agree", None) in pairs, "carried through, not deleted"

        # ⚠️ The value is deliberately NOT an N/A-shaped string. The first draft
        # used "Not applicable to me", which `_is_na` recognises by prefix — so it
        # took the null-set branch and never reached the unmapped one. The fixture
        # was wrong on the exact axis it existed to test.

    def test_a_totally_stale_rule_is_refused_rather_than_producing_an_empty_column(
        self, db_session, test_project
    ):
        """#794's dead-definition case, one operation over.

        Promoting a totally-stale definition used to 500. Deriving from one would
        silently produce a column of nothing, so it is refused at the door.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Strongly agree", "Strongly disagree"])
        d = _reverse_def(db_session, col)  # mapping keys are the LIKERT labels

        with pytest.raises(DeriveColumnError, match="does not match any response"):
            derive_column(db_session, col, d, "Anxiety R")


class TestTheLabelCarryPlan:
    """§8's blocking question, answered by re-pairing rather than copying."""

    def test_a_reverse_re_pairs_labels_onto_the_new_codes(self, db_session, test_project):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, LIKERT)
        d = _reverse_def(db_session, col)

        plan = plan_derived_column(db_session, col, d)
        assert plan.labels.available is True
        # "Never" was code 1 and scores 5 reversed, so 5 must carry "Never" —
        # NOT "Always", which is what copying the dictionary would produce.
        assert dict(plan.labels.pairs)[5.0] == "Never"
        assert dict(plan.labels.pairs)[1.0] == "Always"

    def test_applying_the_carried_dictionary_lands_the_sav_identical_state(
        self, db_session, test_project
    ):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, LIKERT)
        d = _reverse_def(db_session, col)

        new_col, report = derive_column(db_session, col, d, "Anxiety R", carry_labels=True)
        db_session.flush()

        assert report["labels_carried"] is True
        assert new_col.column_type == ColumnType.ORDINAL, "labels promote the type"
        pairs = {
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        }
        assert ("Never", 5.0) in pairs
        assert ("Always", 1.0) in pairs
        # Scale metadata ordered by CODE, so the reversed reading is on record.
        assert json.loads(new_col.scale_labels)[0] == "Always"
        assert json.loads(new_col.scale_values) == [1, 2, 3, 4, 5]

    def test_a_collapsing_rule_refuses_the_carry_and_says_why(self, db_session, test_project):
        """Merged categories need names a rule cannot invent.

        ⚠️ The REASON is asserted, not just the refusal. Four states make
        `available` False and they send the researcher to four different places;
        a disabled control with no reason reads as a broken tool.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, LIKERT)
        collapse = RecodeDefinition(
            column_id=col.id,
            name="Low vs high",
            recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps({
                "Never": 1, "Rarely": 1, "Sometimes": 1, "Often": 2, "Always": 2,
            }),
            sequence_order=1,
        )
        db_session.add(collapse)
        db_session.flush()

        plan = plan_derived_column(db_session, col, collapse)
        assert plan.labels.available is False
        assert "merges responses" in plan.labels.reason
        with pytest.raises(DeriveColumnError, match="merges responses"):
            derive_column(db_session, col, collapse, "Low vs high", carry_labels=True)

    def test_an_unlabelled_source_has_no_dictionary_to_carry(self, db_session, test_project):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds, labelled=False, ctype=ColumnType.NUMERIC)
        _rows(db_session, ds, col, ["1", "2", "3"])
        d = RecodeDefinition(
            column_id=col.id,
            name="Doubled",
            recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps({"1": 2, "2": 4, "3": 6}),
            sequence_order=0,
        )
        db_session.add(d)
        db_session.flush()

        plan = plan_derived_column(db_session, col, d)
        assert plan.labels.available is False
        assert "no value labels" in plan.labels.reason
        # …and the derive itself still works — a dictionary is optional.
        new_col, _ = derive_column(db_session, col, d, "Doubled")
        db_session.flush()
        assert {
            v.value_numeric
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        } == {2.0, 4.0, 6.0}


class TestCategoryGroupOutput:
    def test_a_category_group_produces_a_nominal_column_of_names(self, db_session, test_project):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always", "Sometimes"])
        grp = RecodeDefinition(
            column_id=col.id,
            name="Polarity",
            recode_type=RecodeType.CATEGORY_GROUP,
            output_type=OutputType.CATEGORICAL,
            mapping=json.dumps({"Never": "Low", "Sometimes": "Mid", "Always": "High"}),
            sequence_order=0,
        )
        db_session.add(grp)
        db_session.flush()

        new_col, report = derive_column(db_session, col, grp, "Polarity")
        db_session.flush()

        assert new_col.column_type == ColumnType.NOMINAL
        pairs = {
            (v.value_text, v.value_numeric)
            for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == new_col.id)
        }
        assert pairs == {("Low", None), ("Mid", None), ("High", None)}
        assert report["unmapped_values"] == []

    def test_its_output_is_already_a_name_so_no_dictionary_is_offered(
        self, db_session, test_project
    ):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        grp = RecodeDefinition(
            column_id=col.id, name="Polarity",
            recode_type=RecodeType.CATEGORY_GROUP, output_type=OutputType.CATEGORICAL,
            mapping=json.dumps({"Never": "Low", "Always": "High"}), sequence_order=0,
        )
        db_session.add(grp)
        db_session.flush()

        plan = plan_derived_column(db_session, col, grp)
        assert plan.labels.available is False
        assert "already a name" in plan.labels.reason


class TestProvenance:
    def test_it_records_the_source_column_and_a_snapshot_of_the_rule_name(
        self, db_session, test_project
    ):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col)

        new_col, _ = derive_column(db_session, col, d, "Anxiety R")
        assert new_col.derived_from_column_id == col.id
        assert new_col.derived_via == "Anxiety (reversed)"

    def test_renaming_the_rule_afterwards_does_not_rewrite_history(
        self, db_session, test_project
    ):
        """Why `derived_via` is a snapshot rather than a FK.

        The derived column's cells were computed once. A live link would keep
        resolving to the rule's CURRENT name and mapping, so editing the rule
        would silently make the provenance claim false.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col)
        new_col, _ = derive_column(db_session, col, d, "Anxiety R")

        d.name = "Something else entirely"
        db_session.flush()
        db_session.refresh(new_col)
        assert new_col.derived_via == "Anxiety (reversed)"

    def test_deleting_the_source_degrades_the_trail_instead_of_dangling(
        self, db_session, test_project
    ):
        """ON DELETE SET NULL — and `derived_via` survives it.

        Both readings stay meaningful: "derived by <rule>, source since deleted"
        is still worth saying, which is why the two fields degrade separately.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col)
        new_col, _ = derive_column(db_session, col, d, "Anxiety R")
        db_session.commit()

        db_session.delete(col)
        db_session.commit()
        db_session.refresh(new_col)

        assert new_col.derived_from_column_id is None
        assert new_col.derived_via == "Anxiety (reversed)"


class TestTheSuggestedName:
    """🔴 Every one of these came from driving the real dev corpus.

    The suite's own fixtures all used a rule name that did not contain its
    column's name, so it was structurally blind to the duplication below and
    would have stayed blind.
    """

    def test_a_rule_named_after_its_variable_does_not_repeat_it(self, db_session, test_project):
        """The observed defect: "Math_Anxiety (Math Anxiety (inverted))".

        Nested parentheses with the variable's name in twice — which is what a
        researcher gets on the exact column this feature exists for, because
        people name a recode after the variable it acts on.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        col.column_name = "Math_Anxiety"
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col, name="Math Anxiety (inverted)")

        plan = plan_derived_column(db_session, col, d)
        assert plan.suggested_name == "Math Anxiety (inverted)"

    def test_the_comparison_ignores_separators(self, db_session, test_project):
        """`Math_Anxiety` vs `Math Anxiety` — the same name to a researcher.

        A plain substring test misses this, and separators are exactly what
        varies between a machine short name and a human rule name.
        """
        from app.services.derive_column import _squash
        assert _squash("Math_Anxiety") in _squash("Math Anxiety (inverted)")

    def test_an_unrelated_rule_name_still_gets_the_variable_for_context(
        self, db_session, test_project
    ):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        col.column_name = "Math_Anxiety"
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col, name="Flip it")

        plan = plan_derived_column(db_session, col, d)
        assert plan.suggested_name == "Math_Anxiety (Flip it)"


class TestColumnPlacement:
    def test_derived_codes_get_their_own_namespace(self, db_session, test_project):
        """`D001`, not `M001`.

        `create_manual_column`'s max-scan filters on `LIKE 'M%'`, so a derived
        column carrying an M-code would silently enter its numbering — and the
        two would be indistinguishable in an export header.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col)

        first, _ = derive_column(db_session, col, d, "A")
        second, _ = derive_column(db_session, col, d, "B")
        assert first.column_code == "D001"
        assert second.column_code == "D002"

    def test_the_sequence_order_unique_index_is_respected(self, db_session, test_project):
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, ["Never", "Always"])
        d = _reverse_def(db_session, col)

        first, _ = derive_column(db_session, col, d, "A")
        second, _ = derive_column(db_session, col, d, "B")
        db_session.commit()  # the unique index bites here or not at all
        assert first.sequence_order != second.sequence_order


class TestScale:
    def test_values_are_written_by_one_statement_not_a_python_loop(
        self, db_session, test_project, monkeypatch
    ):
        """🔴 The #799/#796b lesson, pinned structurally.

        A per-row insert on the dev corpus's GSS import would be 75,699 round
        trips (#796b measured 374.8s for exactly that shape) and materialising
        the rows in Python is what #799 measured at +288 MB. Counting the
        INSERT statements is the only way to assert the shape — timing is
        machine-dependent and a row-count assertion passes either way.
        """
        ds = _dataset(db_session, test_project)
        col = _column(db_session, ds)
        _rows(db_session, ds, col, LIKERT * 8)  # 40 rows
        d = _reverse_def(db_session, col)

        inserts = []
        from sqlalchemy import event

        def _count(conn, cursor, statement, params, context, executemany):
            if statement.lstrip().upper().startswith("INSERT INTO DATASET_VALUES"):
                inserts.append(statement)

        event.listen(db_session.get_bind(), "before_cursor_execute", _count)
        try:
            _, report = derive_column(db_session, col, d, "Anxiety R")
            db_session.flush()
        finally:
            event.remove(db_session.get_bind(), "before_cursor_execute", _count)

        assert report["values_written"] == 40
        assert len(inserts) == 1, (
            f"expected ONE INSERT…SELECT for 40 values, got {len(inserts)} — "
            "a per-row or batched-executemany shape would not scale to 75,699"
        )
