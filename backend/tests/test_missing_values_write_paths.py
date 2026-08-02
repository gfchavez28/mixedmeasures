"""#592 slab 3 — the write-time invariant, column-aware at every writer.

A cell whose text is missing (by the column's declared rules, or the
recognized-N/A defaults when undeclared) carries ``value_numeric = NULL`` on
every path that writes it. The J-D1 null-set rule (locked): a declaration
ALONE decides for its column (per-def ``exclude_values`` ignored — REPLACE);
an undeclared column NULLs the defaults ∪ the def's excludes — which is what
closes Bug B/#594 (mapping "N/A" → 99 no longer feeds means), with
``[]``-declaration as the researcher's escape hatch.

Two-sided everywhere, as in the read-path suite: a one-sided test cannot tell
"declaration-aware" from "defaults hardcoded".
"""
import asyncio
import json

import pytest

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.models.user import User
from app.services.recode import (
    apply_definition_to_column,
    compute_value,
    write_back_scale_metadata,
)
from app.services.missing_values import parse_missing_rules

DECLARE_99 = json.dumps([{"value": "99", "label": "Refused"}])
DECLARE_NOTHING = "[]"


def _run(coro):
    return asyncio.run(coro)


def _seed(db, *, missing_values=None, column_type="ordinal",
          cells=("1", "N/A", "99"), col_id=10):
    db.add(Project(id=1, name="P", user_id=1))
    db.flush()
    db.add(Dataset(id=1, project_id=1, name="S"))
    db.flush()
    col = DatasetColumn(
        id=col_id, dataset_id=1, column_code=f"Q{col_id}", column_text=f"Q{col_id}",
        column_type=ColumnType(column_type), sequence_order=0,
        missing_values=missing_values,
    )
    db.add(col)
    db.flush()
    for i, vt in enumerate(cells):
        row = DatasetRow(id=100 + i, dataset_id=1)
        db.add(row)
        db.flush()
        db.add(DatasetValue(id=1000 + i, row_id=row.id, column_id=col.id,
                            value_text=vt))
    db.flush()
    return col


def _def(db, col, mapping, *, rtype=RecodeType.SCALE_MAP, excludes=None,
         primary=True):
    d = RecodeDefinition(
        column_id=col.id, name="def", recode_type=rtype,
        output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
        exclude_values=json.dumps(excludes) if excludes else None,
        is_primary=primary, sequence_order=0,
    )
    db.add(d)
    db.flush()
    return d


def _numeric_by_text(db, col_id):
    return {
        v.value_text: v.value_numeric
        for v in db.query(DatasetValue).filter(DatasetValue.column_id == col_id)
    }


class TestApplyDefinitionNullSet:
    def test_default_missing_nulls_even_when_mapped(self, db_session):
        """Bug B/#594 closed: an undeclared column's mapped "N/A" → 99 writes
        NULL, not 99.0, and the override is reported."""
        col = _seed(db_session, missing_values=None)
        d = _def(db_session, col, {"1": 1, "N/A": 99})
        report = apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["N/A"] is None, "mapped default-missing value fed value_numeric"
        assert out["1"] == 1.0
        assert report["missing_overridden"] == ["N/A"]

    def test_declared_nothing_keeps_mapped_na_as_data(self, db_session):
        """The REPLACE escape hatch: declaring [] makes the same mapping
        legitimate — "N/A" → 99 sticks."""
        col = _seed(db_session, missing_values=DECLARE_NOTHING)
        d = _def(db_session, col, {"1": 1, "N/A": 99})
        report = apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["N/A"] == 99.0
        assert report["missing_overridden"] == []

    def test_declaration_owns_the_null_set(self, db_session):
        """Declared column: its rules NULL "99" even when mapped, the per-def
        exclude channel is IGNORED (J-D1), and the defaults are replaced."""
        col = _seed(db_session, missing_values=DECLARE_99,
                    cells=("1", "99", "N/A", "Maybe"))
        d = _def(db_session, col, {"1": 1, "99": 99, "N/A": 5, "Maybe": 2},
                 excludes=["Maybe"])
        report = apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] is None, "declared-missing mapped value must NULL"
        assert out["N/A"] == 5.0, "REPLACE: defaults no longer apply"
        assert out["Maybe"] == 2.0, "J-D1: per-def excludes ignored when declared"
        assert report["missing_overridden"] == ["99"]

    @pytest.mark.parametrize("missing_values, cells_expown", [
        (None, {"1": 1.0, "N/A": None, "99": 99.0}),
        (DECLARE_NOTHING, {"1": 1.0, "N/A": 99.0, "99": 99.0}),
        (DECLARE_99, {"1": 1.0, "N/A": 5.0, "99": None}),
    ])
    def test_compute_value_parity_with_bulk(self, db_session, missing_values,
                                            cells_expown):
        """The #542b rule: the per-value and bulk paths must produce the same
        number for the same cell, across all three declaration states."""
        col = _seed(db_session, missing_values=missing_values,
                    cells=tuple(cells_expown.keys()))
        d = _def(db_session, col, {"1": 1, "N/A": 99 if missing_values == DECLARE_NOTHING else 5, "99": 99})
        apply_definition_to_column(db_session, d)
        bulk = _numeric_by_text(db_session, col.id)
        rules = parse_missing_rules(missing_values)
        for text, expected in cells_expown.items():
            assert bulk[text] == expected, f"bulk path: {text}"
            per_value = compute_value(text, d, missing_rules=rules)
            assert per_value == expected, f"per-value path: {text}"


class TestReverseMappingGuard:
    def test_reverse_intersecting_declaration_applies_cleanly(self, db_session):
        """The apply-side twin of the removed guard (#600). A reverse mapping
        containing a declared-missing value is no longer refused — the offset
        simply excludes it, which is what the researcher meant. Startup's
        repair_reverse_recode_mappings re-applies every primary, so a raise here
        would have broken boot on any project in this state."""
        col = _seed(db_session, missing_values=DECLARE_99, cells=("1", "5", "99"))
        d = _def(db_session, col, {"1": 1, "5": 5, "99": 99},
                 rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["1"] == 5.0 and out["5"] == 1.0, "offset must be 1+5, not 1+99"
        assert out["99"] is None

    def test_reverse_not_intersecting_applies(self, db_session):
        """The guard is narrow: a reverse mapping that does NOT contain the
        declared-missing value applies normally, and the declared "99" cells
        NULL (unmapped + missing)."""
        col = _seed(db_session, missing_values=DECLARE_99,
                    cells=("1", "5", "99"))
        d = _def(db_session, col, {"1": 1, "5": 5}, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["1"] == 5.0 and out["5"] == 1.0  # offset 6, unpoisoned
        assert out["99"] is None

    def test_undeclared_reverse_unchanged(self, db_session):
        """No declaration → no guard: legacy reverse defs keep their exact
        behavior (offset over the full mapping)."""
        col = _seed(db_session, missing_values=None, cells=("1", "5"))
        d = _def(db_session, col, {"1": 1, "5": 5}, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["1"] == 5.0 and out["5"] == 1.0



# The #600 repro's mapping: a real 1..5 scale plus a recognized-N/A label
# carrying the SPSS-convention sentinel. Reflecting about the sentinel gives
# 1+99=100; about the real scale points, 1+5=6.
POISON_MAP = {"Never": 1, "Always": 5, "Prefer not to say": 99}
POISON_CELLS = ("Never", "Always", "Prefer not to say")


class TestReverseOffsetExcludesNullSet:
    """#600: a null-set mapping key is not a scale point, so it must not set the
    reflection endpoint — it is excluded from the OUTPUT, so it cannot define
    the SCALE. Two-sided throughout: the same mapping poisoned vs clean, and the
    []-declaration escape hatch that makes the sentinel real data again.

    Fixtures deliberately use a 99 sentinel and multi-digit values — a mapping
    whose keys are all real scale points cannot tell a filtered offset from an
    unfiltered one (the degenerate-fixture rule)."""

    def test_undeclared_isna_key_does_not_set_the_offset(self, db_session):
        """The bug: on an UNDECLARED column (i.e. every column today) neither
        guard fires, and the recognized-N/A key silently stretched the scale —
        'Never' scored 99 instead of 5."""
        col = _seed(db_session, missing_values=None, cells=POISON_CELLS)
        d = _def(db_session, col, POISON_MAP, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["Never"] == 5.0, "must reflect about 1+5=6, not 1+99=100"
        assert out["Always"] == 1.0
        assert out["Prefer not to say"] is None

    def test_declared_nothing_missing_keeps_the_sentinel_as_a_scale_point(self, db_session):
        """The other side: `[]` declares NOTHING missing — the researcher's
        explicit 'it is data' escape hatch. 99 is then a real scale point and
        the offset legitimately IS 1+99=100. Without this arm the test above
        also passes with the null set hardcoded to something unrelated."""
        col = _seed(db_session, missing_values=DECLARE_NOTHING, cells=POISON_CELLS)
        d = _def(db_session, col, POISON_MAP, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["Never"] == 99.0
        assert out["Always"] == 95.0
        assert out["Prefer not to say"] == 1.0

    def test_exclude_values_key_does_not_set_the_offset(self, db_session):
        """The def's own exclude channel is part of the UNDECLARED null set
        (J-D1), so an excluded key must not set the endpoint either."""
        col = _seed(db_session, missing_values=None, cells=("Never", "Always", "Other"))
        d = _def(db_session, col, {"Never": 1, "Always": 5, "Other": 99},
                 rtype=RecodeType.REVERSE, excludes=["Other"])
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["Never"] == 5.0 and out["Always"] == 1.0
        assert out["Other"] is None

    def test_compute_value_matches_the_bulk_path(self, db_session):
        """#542b parity: one cell, one number, whichever path computes it.
        compute_value has no guard of its own, so before #600 it reflected about
        the poisoned offset even where the bulk path refused."""
        col = _seed(db_session, missing_values=None, cells=POISON_CELLS)
        d = _def(db_session, col, POISON_MAP, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        bulk = _numeric_by_text(db_session, col.id)
        rules = parse_missing_rules(col.missing_values)
        for text in POISON_MAP:
            assert compute_value(text, d, missing_rules=rules) == bulk[text], (
                f"per-value and bulk paths disagree on {text!r}"
            )

    def test_undeclare_to_defaults_lands_correct(self, db_session):
        """#601: un-declare skips the reverse guard by design — and with the
        offset filtered there is nothing left to guard. Walking []-declared
        (99 is data) → defaults (99 is missing) must simply re-reverse right."""
        from app.services.missing_declaration import apply_missing_declaration

        col = _seed(db_session, missing_values=DECLARE_NOTHING, cells=POISON_CELLS)
        d = _def(db_session, col, POISON_MAP, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        assert _numeric_by_text(db_session, col.id)["Never"] == 99.0  # 99 is data

        apply_missing_declaration(db_session, col, None)  # → the defaults
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["Never"] == 5.0 and out["Always"] == 1.0
        assert out["Prefer not to say"] is None

    def test_effective_offset_is_two_sided(self, db_session):
        """The helper itself: same mapping, null set present vs absent."""
        from app.services.recode import effective_reverse_offset
        assert effective_reverse_offset(POISON_MAP, set(), None) == 6.0    # defaults
        assert effective_reverse_offset(POISON_MAP, set(), []) == 100.0    # nothing missing

    def test_symmetric_scale_reflects_about_zero(self, db_session):
        """The falsy-zero trap: 0.0 is a REAL offset.

        A -5..+5 semantic differential (and a -3..+3 Likert) reflects about
        min+max = 0. A caller testing `if offset:` skips the reversal on exactly
        those scales while the bulk path still reverses — a #542b parity break.
        POISON_MAP has offset 6 and structurally cannot catch this, which is why
        this fixture exists (the degenerate-fixture rule: put the fixture where
        the two behaviors DISAGREE).

        Distinguished from "no scale points at all", which is None.
        """
        from app.services.recode import effective_reverse_offset
        sym = {"Disagree": -5, "Neutral": 0, "Agree": 5}
        assert effective_reverse_offset(sym, set(), None) == 0.0, "0.0 is a real offset"
        assert effective_reverse_offset({"a": "x"}, set(), None) is None, (
            "no numeric scale points must be None, never 0.0"
        )

        col = _seed(db_session, missing_values=None,
                    cells=("Disagree", "Neutral", "Agree"), col_id=30)
        d = _def(db_session, col, sym, rtype=RecodeType.REVERSE)
        apply_definition_to_column(db_session, d)
        bulk = _numeric_by_text(db_session, col.id)
        assert bulk == {"Disagree": 5.0, "Neutral": 0.0, "Agree": -5.0}
        for text in sym:
            assert compute_value(text, d, missing_rules=None) == bulk[text], (
                f"per-value and bulk paths disagree on {text!r} at offset 0"
            )

    def test_offset_rides_the_data_wire(self, db_session):
        """The client cannot derive this offset (it has neither the
        recognized-N/A rule nor the column's declaration), so it must arrive
        COMPUTED on /data or the grid drifts from value_numeric (#578).

        Exercises the real endpoint, not the helper: #586 was a field that
        existed on the schema and never reached the payload, so a builder that
        forgets `reverse_offset=` must fail here."""
        from app.routers.dataset import get_dataset_data

        col = _seed(db_session, missing_values=None, cells=POISON_CELLS)
        _def(db_session, col, POISON_MAP, rtype=RecodeType.REVERSE)
        user = db_session.query(User).first()
        resp = _run(get_dataset_data(1, 1, user=user, db=db_session))

        defs = [d for c in resp.columns for d in c.recode_definitions]
        assert len(defs) == 1, "expected the reverse definition on the payload"
        assert defs[0].reverse_offset == 6.0, (
            "the /data payload must carry the offset over the REAL scale points "
            "(1+5), not the raw min+max (1+99)"
        )


class TestManualEditNullSet:
    def _edit(self, db, col, raw):
        from app.routers.dataset import update_value
        from app.schemas.dataset import ValueUpdate
        row = DatasetRow(dataset_id=col.dataset_id)
        db.add(row)
        db.flush()
        v = DatasetValue(row_id=row.id, column_id=col.id)
        db.add(v)
        db.flush()
        user = db.get(User, 1)
        _run(update_value(1, 1, v.id, ValueUpdate(value_text=raw),
                          user=user, db=db))
        db.refresh(v)
        return v

    def test_declared_code_typed_into_cell_is_null(self, db_session):
        col = _seed(db_session, missing_values=DECLARE_99,
                    column_type="numeric", cells=())
        col.source = "manual"
        db_session.flush()
        assert self._edit(db_session, col, "99").value_numeric is None
        assert self._edit(db_session, col, "3").value_numeric == 3.0

    def test_declared_nothing_keeps_default_missing_as_data(self, db_session):
        """REPLACE at the manual-edit writer: a declared-[] column's "99"
        stays data — and with a primary mapping, so does a mapped "N/A"."""
        col = _seed(db_session, missing_values=DECLARE_NOTHING,
                    column_type="numeric", cells=())
        col.source = "manual"
        db_session.flush()
        assert self._edit(db_session, col, "99").value_numeric == 99.0
        _def(db_session, col, {"N/A": 7})
        assert self._edit(db_session, col, "N/A").value_numeric == 7.0


class TestC4WriteSide:
    def test_write_back_skips_missing_pairs(self, db_session):
        """C4: a missing-keyed mapping pair never enters scale_labels —
        declared arm and defaults arm."""
        col = _seed(db_session, missing_values=DECLARE_99)
        d = _def(db_session, col, {"1": 1, "99": 99})
        write_back_scale_metadata(db_session, d, col.id)
        assert json.loads(col.scale_labels) == ["1"]
        assert json.loads(col.scale_values) == [1]
        assert col.scale_points == 1

    def test_write_back_defaults_arm(self, db_session):
        col = _seed(db_session, missing_values=None)
        d = _def(db_session, col, {"Yes": 1, "N/A": 0})
        write_back_scale_metadata(db_session, d, col.id)
        assert json.loads(col.scale_labels) == ["Yes"]

    def test_write_back_declared_nothing_keeps_all_pairs(self, db_session):
        col = _seed(db_session, missing_values=DECLARE_NOTHING)
        d = _def(db_session, col, {"Yes": 1, "N/A": 0})
        write_back_scale_metadata(db_session, d, col.id)
        assert json.loads(col.scale_labels) == ["N/A", "Yes"]  # code order

    def test_factor_mapping_skips_missing_pairs(self, db_session):
        """C4 on the R export: a missing pair is not a factor level, from
        either priority — and priority-2 positional codes are assigned BEFORE
        the filter so neighbours' codes don't shift."""
        from app.routers.export_r import _get_factor_mapping
        col = _seed(db_session, missing_values=DECLARE_99)
        d = _def(db_session, col, {"1": 1, "2": 2, "99": 99})
        fm = _get_factor_mapping(col, d)
        assert fm == {"values": [1, 2], "labels": ["1", "2"]}

        # Priority 2 (no recode): scale metadata with a missing label.
        col.scale_labels = json.dumps(["1", "99", "2"])
        col.scale_values = None
        fm2 = _get_factor_mapping(col, None)
        assert fm2 == {"values": [1, 3], "labels": ["1", "2"]}, (
            "positional codes must not shift when the missing pair drops"
        )


class TestMissingDeclarationService:
    """#592 slab 3 — apply_missing_declaration (§J.4): guard → recover through
    the OLD rules → persist → NULL pass."""

    def _declare(self, db, col, rules):
        from app.services.missing_declaration import apply_missing_declaration
        return apply_missing_declaration(db, col, rules)

    def test_declare_nulls_matching_cells(self, db_session):
        col = _seed(db_session, column_type="numeric", cells=("3", "99"))
        for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id):
            v.value_numeric = float(v.value_text)
        db_session.flush()
        report = self._declare(db_session, col, [{"value": "99"}])
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] is None and out["3"] == 3.0
        assert report["nulled_rows"] == 1
        assert col.missing_values == json.dumps([{"value": "99"}])

    def test_undeclare_recovers_bare_codes(self, db_session):
        """Declare then un-declare round-trips value_numeric."""
        col = _seed(db_session, column_type="numeric", cells=("3", "99"))
        for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id):
            v.value_numeric = float(v.value_text)
        db_session.flush()
        self._declare(db_session, col, [{"value": "99"}])
        report = self._declare(db_session, col, None)  # back to the defaults
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] == 99.0, "un-declared code must recover its numeric"
        assert report["recovered_rows"] == 1
        assert col.missing_values is None

    def test_declare_replaces_defaults_and_reports_unmapped_text(self, db_session):
        """REPLACE: declaring only 99 makes a defaults-missing "N/A" cell
        substantive — its numeric can't be computed (non-numeric text), so it
        is reported, never silently left ambiguous."""
        col = _seed(db_session, column_type="numeric", cells=("3", "N/A"))
        report = self._declare(db_session, col, [{"value": "99"}])
        assert "N/A" in report["recovered_unmapped"]
        out = _numeric_by_text(db_session, col.id)
        assert out["N/A"] is None  # text-only, but now a SUBSTANTIVE value

    def test_undeclare_reverts_labelled_cells_to_raw_code(self, db_session):
        """J-D3 (locked): a labelled-missing cell ("Refused", vn NULL) is
        unreachable by code — un-declaring reverts it to the raw code text
        through the OLD rules' label channel."""
        col = _seed(db_session, column_type="numeric", cells=("Refused",),
                    missing_values=DECLARE_99)
        report = self._declare(db_session, col, None)
        v = db_session.query(DatasetValue).filter(
            DatasetValue.column_id == col.id).one()
        assert (v.value_text, v.value_numeric) == ("99", 99.0)
        assert report["recovered_rows"] == 1

    def test_degenerate_labelled_range_substitutes_and_reverts(self, db_session):
        """#612 — {lo:99, hi:99, label:"Refused"} normalizes to a DISCRETE
        rule at the schema, so its label substitutes at declare and reverts at
        un-declare exactly like the hand-authored discrete equivalent. The
        revert also pins _fmt_code: float bounds (99.0) must land "99" back in
        value_text, never "99.0"."""
        from app.services.missing_values import normalize_missing_rules_payload
        col = _seed(db_session, column_type="numeric", cells=("3", "99"))
        for v in db_session.query(DatasetValue).filter(DatasetValue.column_id == col.id):
            v.value_numeric = float(v.value_text)
        db_session.flush()

        rules = normalize_missing_rules_payload(
            [{"lo": 99.0, "hi": 99.0, "label": "Refused"}])
        assert rules == [{"value": "99", "label": "Refused"}]
        self._declare(db_session, col, rules)
        out = _numeric_by_text(db_session, col.id)
        assert out.get("Refused", "absent") is None, "label must substitute"
        assert "99" not in out

        self._declare(db_session, col, None)
        out = _numeric_by_text(db_session, col.id)
        assert out.get("99") == 99.0, 'revert must land "99", never "99.0"'
        assert "99.0" not in out and "Refused" not in out

    def test_recovered_rows_counts_each_row_once(self, db_session):
        """#612 — recovery processes CODE texts before LABEL texts. A label-arm
        recovery rewrites value_text INTO the raw code text, so with the label
        text processed first the later code-text UPDATE re-matched the rows it
        had just rewritten and recovered_rows double-counted (the distinct
        query is unordered, so the inflation was nondeterministic). The
        both-texts state is API-unreachable post-#606 but import-config
        reachable (#614) — seeded directly. Code "ZZ" sorts AFTER its label
        "Absent", so an unsorted pass hits the label arm first."""
        col = _seed(
            db_session, column_type="nominal", cells=("Absent", "Absent", "ZZ"),
            missing_values=json.dumps([{"value": "ZZ", "label": "Absent"}]),
        )
        report = self._declare(db_session, col, None)  # un-declare to defaults
        texts = [
            v.value_text for v in db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == col.id)
        ]
        assert texts == ["ZZ", "ZZ", "ZZ"]
        assert report["recovered_rows"] == 3, "each row counted exactly once"

    def test_narrowing_keeps_still_missing_code_null(self, db_session):
        """Old rules {99 = Refused} → new rules {99, no label}: the labelled
        cell reverts to "99" — which the NEW rules still mark missing, so the
        standard compute (column-aware since the writer pass) lands NULL, not
        99.0. The recovery-computes-under-NEW-rules ordering, pinned."""
        col = _seed(db_session, column_type="numeric", cells=("Refused",),
                    missing_values=DECLARE_99)
        report = self._declare(db_session, col, [{"value": "99"}])
        v = db_session.query(DatasetValue).filter(
            DatasetValue.column_id == col.id).one()
        assert (v.value_text, v.value_numeric) == ("99", None)
        assert "99" not in report["recovered_unmapped"]

    def test_scale_map_primary_recovery_reports_unmapped(self, db_session):
        """Un-declaring a code absent from the scale_map primary's mapping
        (missing pairs never live in mappings) leaves the cell text-only and
        REPORTS it — the #577 unmapped shape, never a silent guess."""
        col = _seed(db_session, cells=("1", "99"), missing_values=DECLARE_99)
        _def(db_session, col, {"1": 1})
        report = self._declare(db_session, col, None)
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] is None
        assert report["recovered_unmapped"] == ["99"]

    def test_declaring_over_a_reverse_mapping_is_allowed_and_correct(self, db_session):
        """#600/#601: the J-D2 guard is GONE. It refused this declaration to
        protect an offset that is now computed over non-null-set values, so it
        was blocking the researcher's correct action — declaring 99 missing on a
        column whose reverse recode happens to map 99 — to prevent a state that
        can no longer occur. Dropping it was only safe once the offset filter
        landed; the two guards were a matched pair (leaving the apply-side one
        while allowing the declaration would raise inside startup's
        repair_reverse_recode_mappings and break boot)."""
        col = _seed(db_session, cells=("1", "5", "99"))
        d = _def(db_session, col, {"1": 1, "5": 5, "99": 99},
                 rtype=RecodeType.REVERSE)
        self._declare(db_session, col, [{"value": "99"}])
        assert parse_missing_rules(col.missing_values) == [{"value": "99"}]
        apply_definition_to_column(db_session, d)
        out = _numeric_by_text(db_session, col.id)
        assert out["1"] == 5.0 and out["5"] == 1.0, "offset must be 1+5, not 1+99"
        assert out["99"] is None


class TestMissingValuesOnTheDataWire:
    """#586 class: the editor reads /data and nothing else.

    `DatasetDataColumnResponse` is splat-constructed from the base column
    response, and Pydantic's extra='ignore' drops any field the sibling does not
    declare — SILENTLY. That is exactly how `scale_values` never reached the
    dialog (#586: five empty rows, un-appliable). `missing_values` rides both
    schemas deliberately; this pins it so the slab-4 editor cannot lose its
    pre-fill the same way."""

    def test_declaration_reaches_the_data_payload(self, db_session):
        from app.routers.dataset import get_dataset_data

        col = _seed(db_session, missing_values=DECLARE_99, cells=("1", "5", "99"))
        user = db_session.query(User).first()
        resp = _run(get_dataset_data(1, 1, user=user, db=db_session))
        payload = next(c for c in resp.columns if c.id == col.id)
        assert payload.missing_values == [{"value": "99", "label": "Refused"}], (
            "the missing declaration must reach /data parsed, or the editor "
            "re-opens with the declared rows missing (#586)"
        )

    def test_undeclared_column_sends_null_not_an_empty_list(self, db_session):
        """`null` (defaults apply) and `[]` (nothing is missing) are DIFFERENT
        declarations — collapsing them on the wire would make the editor unable
        to tell "not decided" from "decided: nothing"."""
        from app.routers.dataset import get_dataset_data

        col = _seed(db_session, missing_values=None, cells=("1", "5"))
        user = db_session.query(User).first()
        resp = _run(get_dataset_data(1, 1, user=user, db=db_session))
        payload = next(c for c in resp.columns if c.id == col.id)
        assert payload.missing_values is None


class TestDeclareIsOrderIndependent:
    """#592 3b / plan §K.1 — declaring and labelling must commute.

    Slab 4 puts both gestures behind one Apply button, so it must call two
    endpoints in SOME order. Before 3b neither order was correct: declare→label
    left every cell reading "99" (the pair is filtered AND the cell skipped),
    and label→declare left "Refused" in scale_labels at rest, which
    compute_frequency_distribution zero-fills into a phantom bar forever.

    The fix gives the declare path the symmetric half of J-D3 (which already
    reverts "Refused"→"99" on un-declare): substitute the label IN, and strip
    the pair out of the scale. Both orders then land the same state, so the UI
    cannot get this wrong."""

    LABELS = [(1, "Never"), (5, "Always"), (99, "Refused")]

    def _declare(self, db, col, rules):
        from app.services.missing_declaration import apply_missing_declaration
        return apply_missing_declaration(db, col, rules)

    def _label(self, db, col):
        from app.services.value_labels import apply_value_labels
        return apply_value_labels(db, col, self.LABELS, target_type="ordinal")

    def _sibling_column(self, db, *, col_id, cells):
        """A second column in the SAME project/dataset — `_seed` re-creates
        Project id=1, so it cannot be called twice in one test."""
        col = DatasetColumn(
            id=col_id, dataset_id=1, column_code=f"Q{col_id}",
            column_text=f"Q{col_id}", column_type=ColumnType("ordinal"),
            sequence_order=1,
        )
        db.add(col)
        db.flush()
        for i, vt in enumerate(cells):
            row = DatasetRow(id=col_id * 100 + i, dataset_id=1)
            db.add(row)
            db.flush()
            db.add(DatasetValue(id=col_id * 1000 + i, row_id=row.id,
                                column_id=col.id, value_text=vt))
        db.flush()
        return col

    def _state(self, db, col):
        db.refresh(col)
        return {
            "cells": _numeric_by_text(db, col.id),
            "scale_labels": json.loads(col.scale_labels) if col.scale_labels else None,
            "scale_values": json.loads(col.scale_values) if col.scale_values else None,
            "missing_values": parse_missing_rules(col.missing_values),
        }

    def test_declare_then_label(self, db_session):
        col = _seed(db_session, cells=("1", "5", "99"), col_id=20)
        self._declare(db_session, col, parse_missing_rules(DECLARE_99))
        self._label(db_session, col)
        s = self._state(db_session, col)
        # The label reaches the grid — pre-3b this cell still read "99".
        assert s["cells"] == {"Never": 1.0, "Always": 5.0, "Refused": None}
        assert s["scale_labels"] == ["Never", "Always"]

    def test_label_then_declare(self, db_session):
        col = _seed(db_session, cells=("1", "5", "99"), col_id=21)
        self._label(db_session, col)
        out = self._declare(db_session, col, parse_missing_rules(DECLARE_99))
        s = self._state(db_session, col)
        assert s["cells"] == {"Never": 1.0, "Always": 5.0, "Refused": None}
        # C4 at rest — pre-3b "Refused" stayed a scale point and rendered a
        # zero-count bar in every frequency chart.
        assert s["scale_labels"] == ["Never", "Always"]
        assert s["scale_values"] == [1, 5]
        assert out["stripped_scale_points"] == 1

    def test_both_orders_converge(self, db_session):
        """The property slab 4 actually needs."""
        a = _seed(db_session, cells=("1", "5", "99"), col_id=22)
        self._declare(db_session, a, parse_missing_rules(DECLARE_99))
        self._label(db_session, a)
        state_a = self._state(db_session, a)

        b = self._sibling_column(db_session, col_id=23, cells=("1", "5", "99"))
        self._label(db_session, b)
        self._declare(db_session, b, parse_missing_rules(DECLARE_99))
        state_b = self._state(db_session, b)

        assert state_a == state_b, "declaring and labelling must commute"

    def test_unlabelled_rule_leaves_the_cell_text_alone(self, db_session):
        """A rule with no label has nothing to substitute — NULL only, never a
        rewrite to some invented text."""
        col = _seed(db_session, missing_values=None, cells=("1", "5", "99"), col_id=24)
        out = self._declare(db_session, col, [{"value": "99"}])
        assert out["labelled_rows"] == 0
        texts = {v.value_text for v in db_session.query(DatasetValue)
                 .filter(DatasetValue.column_id == col.id)}
        assert "99" in texts and "Refused" not in texts

    def test_undeclare_does_not_re_add_the_scale_point(self, db_session):
        """J-D3 symmetry: un-declare reverts the CELL to its raw code but does
        no scale-metadata surgery — the researcher re-adds it as a regular
        label via the value-labels dialog if that is what they meant."""
        col = _seed(db_session, cells=("1", "5", "99"), col_id=25)
        self._label(db_session, col)
        self._declare(db_session, col, parse_missing_rules(DECLARE_99))
        self._declare(db_session, col, None)
        s = self._state(db_session, col)
        assert s["scale_labels"] == ["Never", "Always"], "must not resurrect the level"
        texts = {v.value_text for v in db_session.query(DatasetValue)
                 .filter(DatasetValue.column_id == col.id)}
        assert "99" in texts, "the labelled cell reverts to its raw code (J-D3)"

    def test_declaration_covering_every_point_does_not_erase_the_scale(self, db_session):
        """A declaration that swallows the whole scale is a mis-declaration, not
        an instruction to destroy the metadata."""
        col = _seed(db_session, cells=("1", "5"), col_id=26)
        from app.services.value_labels import apply_value_labels
        apply_value_labels(db_session, col, [(1, "Never"), (5, "Always")],
                           target_type="ordinal")
        out = self._declare(db_session, col, [{"lo": 0, "hi": 100}])
        assert out["stripped_scale_points"] == 0
        assert json.loads(col.scale_labels) == ["Never", "Always"]


class TestMissingValuesEndpoint:
    def _put(self, db, col, rules):
        from app.routers.recode import set_missing_values
        from app.schemas.recode import MissingValuesUpdate
        user = db.get(User, 1)
        return _run(set_missing_values(
            1, 1, col.id, MissingValuesUpdate(rules=rules), user=user, db=db,
        ))

    def test_happy_path_marks_metrics_stale(self, db_session):
        from app.models.metric import MetricDefinition
        col = _seed(db_session, column_type="numeric", cells=("3", "99"))
        m = MetricDefinition(
            project_id=1, name="m", metric_type="mean",
            input_source_type="dataset_column", input_source_id=col.id,
            config="{}", stale=False,
        )
        db_session.add(m)
        db_session.flush()
        resp = self._put(db_session, col, [{"value": "99", "label": "Refused"}])
        assert resp.missing_values == [{"value": "99", "label": "Refused"}]
        assert resp.nulled_rows == 1
        db_session.refresh(m)
        assert m.stale is True, "declaring must staleize dependent metrics"

    def test_type_guards(self, db_session):
        from fastapi import HTTPException
        col = _seed(db_session, column_type="open_text", cells=())
        with pytest.raises(HTTPException) as ei:
            self._put(db_session, col, [{"value": "99"}])
        assert ei.value.status_code == 400

        col.column_type = ColumnType.NUMERIC
        col.source = "computed"
        db_session.flush()
        with pytest.raises(HTTPException) as ei:
            self._put(db_session, col, [{"value": "99"}])
        assert ei.value.status_code == 403

    def test_schema_rejects_invalid_rules(self):
        from pydantic import ValidationError
        from app.schemas.recode import MissingValuesUpdate
        with pytest.raises(ValidationError):
            MissingValuesUpdate(rules=[{"value": ""}])
        with pytest.raises(ValidationError):
            MissingValuesUpdate(rules=[{"lo": 5, "hi": 1}])
        assert MissingValuesUpdate(rules=None).rules is None
        assert MissingValuesUpdate(rules=[]).rules == []
        assert MissingValuesUpdate(rules=[{"value": 99}]).rules == [{"value": "99"}]


class TestDeclarationPortability:
    def test_declared_column_round_trips(self, db_session, tmp_path):
        """missing_values rides .mmproject by reflection — and the format is
        now v4, so an older (v<=3) build refuses the file cleanly instead of
        silently dropping a statistics-deciding declaration (§I.10)."""
        import zipfile
        from app.services.project_portability import (
            CURRENT_FORMAT_VERSION, export_project, import_project,
        )
        assert CURRENT_FORMAT_VERSION == 4

        _seed(db_session, column_type="numeric", cells=("3", "99"),
              missing_values=DECLARE_99)
        docs_dir = tmp_path / "docs"
        docs_dir.mkdir()
        buf = export_project(db_session, 1, docs_dir)

        out = tmp_path / "p.mmproject"
        out.write_bytes(buf.getvalue())
        with zipfile.ZipFile(out) as zf:
            manifest = json.loads(zf.read("manifest.json"))
        assert manifest["format_version"] == 4

        new_id, _ = import_project(db_session, out, docs_dir, user_id=1)
        imported = (
            db_session.query(DatasetColumn)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == new_id)
            .one()
        )
        assert imported.missing_values == DECLARE_99


class TestImportConfigThreading:
    """#592 §J.6: DatasetColumnConfig.missing_values persists on the column
    and governs the import cell loop, numeric metadata, and exclude seeding."""

    def _import(self, db, config_extra, cells=("3", "99", "N/A")):
        from app.services.dataset_import import import_dataset_csv
        db.add(Project(id=1, name="P", user_id=1))
        db.flush()
        cfg = {"column_index": 0, "column_type": "numeric", "column_text": "q",
               **config_extra}
        result = import_dataset_csv(
            db=db, project_id=1, name="DS", column_configs=[cfg],
            file_contents="q\n" + "\n".join(cells) + "\n",
        )
        col = db.query(DatasetColumn).one()
        return result, col

    def test_declared_rules_persist_and_null_cells(self, db_session):
        result, col = self._import(
            db_session, {"missing_values": [{"value": "99", "label": "Refused"}]},
            cells=("3", "99"))
        assert col.missing_values == DECLARE_99
        out = _numeric_by_text(db_session, col.id)
        # #607: the labelled rule substitutes at import (parity with the
        # declare endpoint, the append channel, and the .sav adapter).
        assert out["Refused"] is None and out["3"] == 3.0
        # #415 disclosure: the declared code counts as recognized-missing.
        assert result["recognized_missing_count"] == 1
        # numeric metadata excludes the declared sentinel
        assert col.numeric_max == 3.0

    def test_declared_nothing_keeps_default_missing_as_data(self, db_session):
        """REPLACE at import: [] persists (never folds into NULL — the
        falsy-zero rule), "99" imports as data and enters the numeric range,
        and a defaults-missing "N/A" is NOT counted as recognized-missing
        (it is substantive text on this column — which also, honestly, makes
        the numeric-range inference bail: the column now HAS text data)."""
        result, col = self._import(db_session, {"missing_values": []},
                                   cells=("3", "99"))
        assert col.missing_values == "[]"
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] == 99.0
        assert result["recognized_missing_count"] == 0
        assert col.numeric_max == 99.0

    def test_declared_nothing_na_not_counted_missing(self, db_session):
        """The "N/A"-as-data arm (mixed text honestly means no numeric range)."""
        result, col = self._import(db_session, {"missing_values": []},
                                   cells=("3", "N/A"))
        assert result["recognized_missing_count"] == 0
        out = _numeric_by_text(db_session, col.id)
        assert out["N/A"] is None  # non-numeric text — but SUBSTANTIVE data

    def test_undeclared_defaults_unchanged(self, db_session):
        result, col = self._import(db_session, {})
        assert col.missing_values is None
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] == 99.0 and out["N/A"] is None
        assert result["recognized_missing_count"] == 1  # "N/A" via defaults

    def test_exclude_seeding_is_rule_aware(self, db_session):
        """§J.2: the auto scale_map's exclude_values seeds from the EFFECTIVE
        rule — declared sentinel in, defaults-missing out under REPLACE."""
        from app.services.dataset_import import import_dataset_csv
        db_session.add(Project(id=1, name="P", user_id=1))
        db_session.flush()
        import_dataset_csv(
            db=db_session, project_id=1, name="DS",
            column_configs=[{
                "column_index": 0, "column_type": "ordinal", "column_text": "q",
                "scale_labels": ["Low", "High"],
                "missing_values": [{"value": "99"}],
            }],
            file_contents="q\nLow\nHigh\n99\nN/A\n",
        )
        d = db_session.query(RecodeDefinition).one()
        assert json.loads(d.exclude_values) == ["99"], (
            "declared sentinel seeds the exclude channel; the defaults-missing "
            "'N/A' does NOT (REPLACE)"
        )


class TestAppendMissingChannel:
    """#592 §I.2b: the append missing channel runs BEFORE label/code
    resolution AND before the dedup fingerprint."""

    def _setup(self, db, missing_values=DECLARE_99, existing=("Refused",)):
        col = _seed(db, column_type="numeric", cells=existing,
                    missing_values=missing_values)
        dataset = db.query(Dataset).one()
        return dataset, col, db.get(User, 1)

    def _append(self, db, dataset, col, cell, *, skip_duplicates=False):
        import io as _io
        from starlette.datastructures import UploadFile as StarletteUploadFile
        from app.routers.dataset import append_import
        upload = StarletteUploadFile(
            filename="more.csv", file=_io.BytesIO(f"q\n{cell}\n".encode()))
        config = json.dumps({
            "column_mapping": [{"csv_column_index": 0, "column_id": col.id}],
            "skip_duplicates": skip_duplicates,
        })
        user = db.get(User, 1)
        return _run(append_import(
            project_id=1, dataset_id=dataset.id, file=upload,
            import_config=config, encoding="utf-8", user=user, db=db,
        ))

    def test_appended_code_substitutes_to_missing_label(self, db_session):
        """An appended raw "99" lands as "Refused"/NULL — the text existing
        labelled-missing cells carry."""
        dataset, col, _ = self._setup(db_session)
        pre = {v.id for v in db_session.query(DatasetValue).filter_by(column_id=col.id)}
        self._append(db_session, dataset, col, "99")
        new = [v for v in db_session.query(DatasetValue).filter_by(column_id=col.id)
               if v.id not in pre]
        assert len(new) == 1
        assert (new[0].value_text, new[0].value_numeric) == ("Refused", None)

    def test_appended_code_dedups_against_labelled_missing_row(self, db_session):
        """The fingerprint parity point: "99" appended with skip_duplicates
        matches the existing "Refused" row."""
        dataset, col, _ = self._setup(db_session)
        resp = self._append(db_session, dataset, col, "99", skip_duplicates=True)
        assert resp.rows_created == 0 and resp.duplicates_skipped == 1

    def test_declared_nothing_appends_default_missing_as_data(self, db_session):
        """REPLACE on append: a declared-[] column's appended "99" keeps its
        number (and an "N/A" resolves as substantive text)."""
        dataset, col, _ = self._setup(db_session, missing_values=DECLARE_NOTHING,
                                      existing=("3",))
        self._append(db_session, dataset, col, "99")
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] == 99.0


class TestValueLabelsResurrection:
    """#592 §I.3 + C4 in apply_value_labels (the 4/4 fix)."""

    def test_relabel_does_not_resurrect_declared_missing(self, db_session):
        """A declared-missing bare-code cell ("99", vn NULL) survives a label
        re-apply un-resurrected — pre-fix, _code_key recovered the code from
        value_text and re-stamped value_numeric."""
        from app.services.value_labels import apply_value_labels
        col = _seed(db_session, column_type="ordinal",
                    cells=("1", "2", "99"), missing_values=DECLARE_99)
        # The declared state: "99" cells hold NULL numerics.
        for v in db_session.query(DatasetValue).filter_by(column_id=col.id):
            v.value_numeric = float(v.value_text) if v.value_text != "99" else None
        db_session.flush()

        result = apply_value_labels(
            db_session, col, [(1, "Low"), (2, "High")], ColumnType.ORDINAL)
        out = {
            v.value_text: v.value_numeric
            for v in db_session.query(DatasetValue).filter_by(column_id=col.id)
        }
        assert out["99"] is None, "label re-apply resurrected a declared-missing cell"
        assert out["Low"] == 1.0 and out["High"] == 2.0
        assert result["missing_skipped"] == []

    def test_missing_pair_never_enters_the_dictionary(self, db_session):
        """C4: a label pair for a declared-missing code is skipped and
        REPORTED — not a scale point, not a mapping entry, not a substitution."""
        from app.services.value_labels import apply_value_labels
        col = _seed(db_session, column_type="ordinal",
                    cells=("1", "99"), missing_values=DECLARE_99)
        result = apply_value_labels(
            db_session, col, [(1, "Low"), (99, "Refused")], ColumnType.ORDINAL)
        assert result["missing_skipped"] == [99.0]
        assert json.loads(col.scale_labels) == ["Low"]
        d = db_session.query(RecodeDefinition).filter_by(column_id=col.id).one()
        assert json.loads(d.mapping) == {"Low": 1}
        v99 = db_session.query(DatasetValue).filter_by(
            column_id=col.id, value_text="99").one()
        assert v99.value_numeric is None, "the missing cell must not be stamped"

    def test_defaults_missing_cells_never_relabelled(self, db_session):
        """Undeclared column: a defaults-missing cell is SKIPPED outright —
        even a #594-class stray numeric on it (vt "N/A", vn 1.0) must not key
        the cell into the dictionary and rewrite the text to "Low". The
        exclude channel still sees it."""
        from app.services.value_labels import apply_value_labels
        col = _seed(db_session, column_type="ordinal", cells=("1", "N/A"))
        na_cell = db_session.query(DatasetValue).filter_by(
            column_id=col.id, value_text="N/A").one()
        na_cell.value_numeric = 1.0  # stray numeric that HAS a label below
        db_session.flush()
        apply_value_labels(db_session, col, [(1, "Low")], ColumnType.ORDINAL)
        db_session.refresh(na_cell)
        assert na_cell.value_text == "N/A", (
            "a missing cell was keyed by its stray numeric and relabelled"
        )
        d = db_session.query(RecodeDefinition).filter_by(column_id=col.id).one()
        assert json.loads(d.exclude_values) == ["N/A"]

    def test_cells_are_codes_import_with_missing_rules_end_to_end(self, db_session):
        """The wizard shape slab 4 will drive: cells_are_codes + missing_values
        in ONE import config — the post-pass (apply_value_labels) must not
        resurrect what the cell loop NULLed."""
        from app.services.dataset_import import import_dataset_csv
        db_session.add(Project(id=1, name="P", user_id=1))
        db_session.flush()
        import_dataset_csv(
            db=db_session, project_id=1, name="DS",
            column_configs=[{
                "column_index": 0, "column_type": "ordinal", "column_text": "q",
                "cells_are_codes": True,
                "scale_labels": ["Low", "High"], "scale_values": [1, 2],
                "missing_values": [{"value": "99", "label": "Refused"}],
            }],
            file_contents="q\n1\n2\n99\n",
        )
        col = db_session.query(DatasetColumn).one()
        out = {
            v.value_text: v.value_numeric
            for v in db_session.query(DatasetValue).filter_by(column_id=col.id)
        }
        assert out == {"Low": 1.0, "High": 2.0, "Refused": None}, (
            "declared-missing code must stay NULL through the label post-pass, "
            "and its labelled rule substitutes at import like everywhere else "
            "(#607 — pre-fix this cell landed as raw '99')"
        )
        assert json.loads(col.scale_labels) == ["Low", "High"]


class TestImportMissingLabelParity:
    """#607 — the import cell loop substitutes a labelled missing rule's label,
    exactly as the declare endpoint, the append channel, and the .sav adapter
    do. Pre-fix, import stored the raw code while append substituted — the
    same code rendered two ways in one column, and the append dedup
    fingerprint missed precisely the rows it exists to match."""

    def _import(self, db, *, rules, cells="q\n1\n99\n"):
        from app.services.dataset_import import import_dataset_csv
        db.add(Project(id=1, name="P", user_id=1))
        db.flush()
        import_dataset_csv(
            db=db, project_id=1, name="DS",
            column_configs=[{
                "column_index": 0, "column_type": "numeric", "column_text": "q",
                "missing_values": rules,
            }],
            file_contents=cells,
        )
        from app.models.dataset import Dataset as _DS
        ds = db.query(_DS).filter_by(name="DS").one()
        col = db.query(DatasetColumn).filter_by(dataset_id=ds.id).one()
        return ds, col

    def test_import_substitutes_missing_label(self, db_session):
        _, col = self._import(
            db_session, rules=[{"value": "99", "label": "Refused"}],
        )
        out = _numeric_by_text(db_session, col.id)
        assert out == {"1": 1.0, "Refused": None}, (
            "an imported declared-missing code must land as its label + NULL — "
            "the same cell state the declare endpoint and append produce"
        )

    def test_unlabelled_rule_keeps_raw_text(self, db_session):
        """Two-sided: no label on the rule → nothing to substitute; the raw
        code stays (NULL numeric), and a declared-[] column keeps the code as
        DATA with raw text."""
        _, col = self._import(db_session, rules=[{"value": "99"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"1": 1.0, "99": None}

    def test_declared_nothing_imports_code_as_data(self, db_session):
        _, col = self._import(db_session, rules=[])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"1": 1.0, "99": 99.0}

    def test_append_dedup_matches_imported_missing_row(self, db_session):
        """The end-to-end fingerprint claim: append the same raw code with
        skip_duplicates — it must recognize the imported labelled-missing row
        as a duplicate (pre-#607 it could not: 'Refused' vs '99')."""
        import io as _io
        from starlette.datastructures import UploadFile as StarletteUploadFile
        from app.routers.dataset import append_import

        ds, col = self._import(
            db_session, rules=[{"value": "99", "label": "Refused"}],
        )
        user = db_session.query(User).first()
        upload = StarletteUploadFile(
            filename="more.csv", file=_io.BytesIO(b"q\n99\n"))
        config = json.dumps({
            "column_mapping": [{"csv_column_index": 0, "column_id": col.id}],
            "skip_duplicates": True,
        })
        resp = _run(append_import(
            project_id=1, dataset_id=ds.id, file=upload,
            import_config=config, encoding="utf-8", user=user, db=db_session,
        ))
        assert resp.rows_created == 0 and resp.duplicates_skipped == 1, (
            "the appended raw '99' resolves to 'Refused' (append channel) and "
            "must fingerprint-match the imported row, which now also reads "
            "'Refused' (#607)"
        )


class TestDeclareRealignsPrimary:
    """#603 — declare/un-declare re-applies a numeric primary.

    A declaration changes `effective_reverse_offset`'s input set, so on a
    REVERSE primary every ALREADY-STORED cell reflects about the wrong endpoint
    until the definition re-applies — the NULL/recovery passes touch only the
    declared/recovered cells' own rows ("Never" stayed 99.0 while a fresh
    compute said 5.0: same label, two numbers, at rest). The re-apply is
    `apply_definition_to_column` (NOT recompute_primary_value_numeric — the
    write-back would re-add the sentinel to scale_labels on un-declare,
    violating J-D3), behind a load-bearing flush (autoflush=False: the apply
    re-reads the declaration FROM THE DB)."""

    def _declare(self, db, col, rules):
        from app.services.missing_declaration import apply_missing_declaration
        return apply_missing_declaration(db, col, rules)

    def _reverse_col(self, db, *, missing_values=None):
        col = _seed(db, missing_values=missing_values,
                    cells=("Never", "Always", "99"))
        d = _def(db, col, {"Never": 1, "Always": 5, "99": 99},
                 rtype=RecodeType.REVERSE)
        apply_definition_to_column(db, d)
        return col, d

    def test_declare_realigns_every_reverse_cell(self, db_session):
        col, d = self._reverse_col(db_session)
        pre = _numeric_by_text(db_session, col.id)
        assert pre == {"Never": 99.0, "Always": 95.0, "99": 1.0}, (
            "precondition: undeclared numeric sentinel is a scale point (§A4)"
        )
        self._declare(db_session, col, [{"value": "99"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"Never": 5.0, "Always": 1.0, "99": None}, (
            "every stored cell must equal a fresh compute under the NEW rules "
            "— not just the declared cell's own rows (#603)"
        )
        # Storage == fresh compute, the invariant the bug broke.
        rules = parse_missing_rules(col.missing_values)
        for text in ("Never", "Always"):
            assert out[text] == compute_value(text, d, missing_rules=rules)

    def test_undeclare_realigns_back(self, db_session):
        col, d = self._reverse_col(
            db_session, missing_values=json.dumps([{"value": "99"}]),
        )
        assert _numeric_by_text(db_session, col.id) == {
            "Never": 5.0, "Always": 1.0, "99": None}
        self._declare(db_session, col, None)  # → the defaults
        out = _numeric_by_text(db_session, col.id)
        assert out == {"Never": 99.0, "Always": 95.0, "99": 1.0}, (
            "un-declare re-widens the offset (defaults: a numeric sentinel is "
            "data, §A4) — untouched cells must move too"
        )

    def test_declared_nothing_realigns_like_defaults(self, db_session):
        col, d = self._reverse_col(
            db_session, missing_values=json.dumps([{"value": "99"}]),
        )
        self._declare(db_session, col, [])  # explicit: NOTHING is missing
        out = _numeric_by_text(db_session, col.id)
        assert out == {"Never": 99.0, "Always": 95.0, "99": 1.0}

    def test_labelled_declare_substitutes_and_realigns(self, db_session):
        col, d = self._reverse_col(db_session)
        self._declare(db_session, col, [{"value": "99", "label": "Refused"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"Never": 5.0, "Always": 1.0, "Refused": None}

    def test_scale_map_primary_values_survive_reapply(self, db_session):
        col = _seed(db_session, cells=("1", "5", "99"))
        d = _def(db_session, col, {"1": 1, "5": 5, "99": 99})
        apply_definition_to_column(db_session, d)
        self._declare(db_session, col, [{"value": "99"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"1": 1.0, "5": 5.0, "99": None}, (
            "scale_map re-apply is an idempotent no-op for undeclared codes"
        )

    def test_category_group_recovery_stays_null(self, db_session):
        """#603 rider: recovery under a category_group primary must not smuggle
        a numeric onto an all-NULL column via a float-parsable group name."""
        col = _seed(db_session, cells=("1", "99"),
                    missing_values=json.dumps([{"value": "99"}]))
        d = _def(db_session, col, {"1": "1", "99": "2"},
                 rtype=RecodeType.CATEGORY_GROUP)
        from app.services.recode import clear_value_numeric
        clear_value_numeric(db_session, col.id)
        report = self._declare(db_session, col, None)  # un-declare: "99" recovers
        out = _numeric_by_text(db_session, col.id)
        assert out["99"] is None, (
            "category_group columns are all-NULL by clear semantics; the "
            "recovered cell must not get float(group_name)"
        )
        assert "99" not in report["recovered_unmapped"], (
            "text-only is this column's designed state, not an unmapped value"
        )


class TestMissingRuleCollisionGuard:
    """#606 — a labelled rule whose label collides with text that means
    something else is refused BEFORE any write. The predicate's label arm
    matches cells by TEXT, so `{99 = "Agree"}` on a column whose real code 2
    is labelled "Agree" NULLed every real "Agree" cell and un-declare rewrote
    them to "99" — answers destroyed, silently (the #585 shape). The two
    deliberate allows: the label→declare commute (metadata pairs the label
    with the SAME code) and the idempotent re-declare (identical pair in the
    OLD rules)."""

    def _declare(self, db, col, rules):
        from app.services.missing_declaration import apply_missing_declaration
        return apply_missing_declaration(db, col, rules)

    def _raises(self, db, col, rules):
        from app.services.missing_declaration import MissingRuleCollisionError
        with pytest.raises(MissingRuleCollisionError):
            self._declare(db, col, rules)

    def test_label_colliding_with_real_scale_label_refused(self, db_session):
        from app.services.value_labels import apply_value_labels
        col = _seed(db_session, cells=("1", "2", "2"))
        apply_value_labels(db_session, col,
                           [(1.0, "Disagree"), (2.0, "Agree")], None)
        self._raises(db_session, col, [{"value": "99", "label": "Agree"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"Disagree": 1.0, "Agree": 2.0}, (
            "refusal must land BEFORE any write — real responses untouched"
        )

    def test_commute_same_pair_still_allowed(self, db_session):
        from app.services.value_labels import apply_value_labels
        col = _seed(db_session, cells=("1", "99"))
        apply_value_labels(db_session, col,
                           [(1.0, "Never"), (99.0, "Refused")], None)
        self._declare(db_session, col, [{"value": "99", "label": "Refused"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"Never": 1.0, "Refused": None}, (
            "label→declare commute (slab 3b) must keep working under the guard"
        )

    def test_idempotent_redeclare_allowed(self, db_session):
        col = _seed(db_session, cells=("Refused", "1"),
                    missing_values=DECLARE_99)
        self._declare(db_session, col, [
            {"value": "99", "label": "Refused"}, {"value": "-1"},
        ])
        assert parse_missing_rules(col.missing_values) == [
            {"value": "99", "label": "Refused"}, {"value": "-1"},
        ]

    def test_changed_code_label_reuse_refused(self, db_session):
        col = _seed(db_session, cells=("Refused", "1"),
                    missing_values=json.dumps(
                        [{"value": "5", "label": "Refused"}]))
        self._raises(db_session, col, [{"value": "99", "label": "Refused"}])

    def test_duplicate_labels_refused(self, db_session):
        col = _seed(db_session, cells=("1",))
        self._raises(db_session, col, [
            {"value": "98", "label": "X"}, {"value": "99", "label": "X"},
        ])

    def test_label_equal_to_other_rule_value_refused(self, db_session):
        col = _seed(db_session, cells=("1",))
        self._raises(db_session, col, [
            {"value": "99", "label": "N/A"}, {"value": "N/A"},
        ])

    def test_observed_substantive_text_refused(self, db_session):
        col = _seed(db_session, column_type="numeric", cells=("Agree", "1"))
        self._raises(db_session, col, [{"value": "99", "label": "Agree"}])

    def test_self_labelled_code_allowed(self, db_session):
        col = _seed(db_session, column_type="numeric", cells=("99", "1"))
        for v in db_session.query(DatasetValue).filter_by(column_id=col.id):
            v.value_numeric = float(v.value_text)
        db_session.flush()
        self._declare(db_session, col, [{"value": "99", "label": "99"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"99": None, "1": 1.0}

    def test_noncolliding_label_applies(self, db_session):
        col = _seed(db_session, column_type="numeric", cells=("1", "99"))
        for v in db_session.query(DatasetValue).filter_by(column_id=col.id):
            v.value_numeric = float(v.value_text)
        db_session.flush()
        self._declare(db_session, col, [{"value": "99", "label": "Refused"}])
        out = _numeric_by_text(db_session, col.id)
        assert out == {"1": 1.0, "Refused": None}

    def test_endpoint_maps_collision_to_400(self, db_session):
        from fastapi import HTTPException
        from app.routers.recode import set_missing_values
        from app.schemas.recode import MissingValuesUpdate
        col = _seed(db_session, column_type="numeric", cells=("Agree", "1"))
        user = db_session.query(User).first()
        with pytest.raises(HTTPException) as exc:
            _run(set_missing_values(
                1, 1, col.id,
                MissingValuesUpdate(rules=[{"value": "99", "label": "Agree"}]),
                user=user, db=db_session,
            ))
        assert exc.value.status_code == 400
        assert "Agree" in exc.value.detail
