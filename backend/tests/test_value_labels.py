"""#576/#577: declared value labels for numbers-only columns.

`apply_value_labels` substitutes a declared label into value_text (keeping the
code in value_numeric), sets scale metadata + a primary scale_map, so the column
becomes byte-identical to a labelled SPSS import. Declaring a zero-response level
is free. Observed-but-undeclared codes are surfaced, never destroyed.
"""
import asyncio
import json

import pytest

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from app.models.recode import RecodeDefinition, RecodeType, OutputType
from app.models.user import User
from app.services.recode import apply_definition_to_column
from app.services.value_labels import (
    apply_value_labels,
    code_identity_violation,
    ValueLabelsBlockedError,
)


# Multi-digit + a gap so a positional-vs-code confusion would surface
# (degenerate-fixture rule — 1..5 hides it).
SCALE = [(2, "Low"), (4, "Mid"), (6, "High"), (10, "Top")]


@pytest.fixture
def col(db_session):
    p = Project(id=1, name="P", user_id=1); db_session.add(p); db_session.flush()
    d = Dataset(id=1, project_id=1, name="D"); db_session.add(d); db_session.flush()
    c = DatasetColumn(id=1, dataset_id=1, column_code="Q1", column_text="Q1",
                      column_type=ColumnType.ORDINAL, sequence_order=0, display_order=0)
    db_session.add(c); db_session.flush()
    return db_session, c


def _seed(db, col, codes):
    for code in codes:
        r = DatasetRow(dataset_id=col.dataset_id); db.add(r); db.flush()
        db.add(DatasetValue(row_id=r.id, column_id=col.id,
                            value_text=str(code), value_numeric=float(code)))
    db.flush()


def _vals(db, col):
    return (db.query(DatasetValue).filter(DatasetValue.column_id == col.id)
            .order_by(DatasetValue.row_id).all())


def test_labels_substituted_into_value_text_codes_preserved(col):
    db, c = col
    _seed(db, c, [2, 4, 6, 10, 6])
    res = apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
    assert res["updated"] == 5
    assert res["unlabeled_codes"] == []
    rows = _vals(db, c)
    assert [v.value_text for v in rows] == ["Low", "Mid", "High", "Top", "High"]
    assert [v.value_numeric for v in rows] == [2.0, 4.0, 6.0, 10.0, 6.0]


def test_scale_metadata_and_primary_recode_set(col):
    db, c = col
    _seed(db, c, [2, 4, 6, 10])
    apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
    assert json.loads(c.scale_labels) == ["Low", "Mid", "High", "Top"]
    assert json.loads(c.scale_values) == [2, 4, 6, 10]      # ints, gapped, preserved
    assert c.scale_points == 4
    prim = db.query(RecodeDefinition).filter_by(column_id=c.id, is_primary=True).first()
    assert prim is not None and prim.recode_type == RecodeType.SCALE_MAP
    assert json.loads(prim.mapping) == {"Low": 2, "Mid": 4, "High": 6, "Top": 10}


def test_zero_response_level_is_declarable(col):
    # Data has no code 4, but "Mid" is declared — it must land in scale_labels (#577).
    db, c = col
    _seed(db, c, [2, 6, 10])
    apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
    assert "Mid" in json.loads(c.scale_labels)


def test_undeclared_observed_code_is_surfaced_not_destroyed(col):
    # Declare only 2/4/6; the data also has a 10 the researcher didn't label.
    db, c = col
    _seed(db, c, [2, 4, 10])
    res = apply_value_labels(db, c, SCALE[:3], ColumnType.ORDINAL)
    assert res["unlabeled_codes"] == [10.0]
    rows = _vals(db, c)
    # the 10 keeps its raw value + numeric code — nothing nulled
    assert rows[2].value_text == "10"
    assert rows[2].value_numeric == 10.0


def test_reapply_with_edited_label_updates_value_text(col):
    # Re-apply keys on value_numeric (the code), so editing a label re-substitutes
    # even though value_text is already a label, not a code.
    db, c = col
    _seed(db, c, [2, 4])
    apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
    edited = [(2, "Bottom"), (4, "Mid"), (6, "High"), (10, "Top")]
    apply_value_labels(db, c, edited, ColumnType.ORDINAL)
    rows = _vals(db, c)
    assert rows[0].value_text == "Bottom"     # relabeled from "Low"
    # the auto recode is reused, not duplicated
    assert db.query(RecodeDefinition).filter_by(column_id=c.id).count() == 1


def test_na_cells_untouched(col):
    db, c = col
    _seed(db, c, [2, 4])
    r = DatasetRow(dataset_id=c.dataset_id); db.add(r); db.flush()
    db.add(DatasetValue(row_id=r.id, column_id=c.id, value_text="N/A", value_numeric=None))
    db.flush()
    apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
    na = db.query(DatasetValue).filter_by(column_id=c.id, value_text="N/A").first()
    assert na is not None and na.value_numeric is None


def test_sets_column_type(col):
    db, c = col
    _seed(db, c, [2, 4])
    apply_value_labels(db, c, SCALE, ColumnType.NOMINAL)
    assert c.column_type == ColumnType.NOMINAL


# ── Shared cell-substitution primitives (retro / import / append single-source) ─

def test_substitute_code_matches_retro_rule():
    from app.services.value_labels import substitute_code
    m = {2.0: "Low", 4.0: "Mid", 6.0: "High", 10.0: "Top"}
    # declared code → (label, code)
    assert substitute_code("6", m) == ("High", 6.0)
    # undeclared numeric code → kept raw + numeric (NEVER nulled — retro parity)
    assert substitute_code("7", m) == ("7", 7.0)
    # non-numeric → (cell, None)
    assert substitute_code("N/A", m) == ("N/A", None)


def test_resolve_labelled_cell_label_then_code(col):
    # A value-labelled column resolves BOTH a label-format cell and a code-format
    # cell; the outcome for a code cell equals what apply_value_labels stores.
    from app.services.value_labels import resolve_labelled_cell
    labels = ["Low", "Mid", "High", "Top"]
    values = [2, 4, 6, 10]
    m = {2.0: "Low", 4.0: "Mid", 6.0: "High", 10.0: "Top"}
    # label-format cell (existing behavior)
    assert resolve_labelled_cell("High", "ordinal", labels, values, m) == ("High", 6.0)
    # code-format cell (append parity)
    assert resolve_labelled_cell("6", "ordinal", labels, values, m) == ("High", 6.0)
    # undeclared code kept numeric — same as the retro path's unlabeled handling
    db, c = col
    _seed(db, c, [7])
    apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)  # SCALE = 2/4/6/10, no 7
    retro = _vals(db, c)[0]
    resolved = resolve_labelled_cell("7", "ordinal", labels, values, m)
    assert (retro.value_text, retro.value_numeric) == resolved == ("7", 7.0)


# ── D3: import-wizard authoring (cells_are_codes) ────────────────────────────

class TestImportCellsAreCodes:
    """A numbers-only CSV imported with cells_are_codes must land byte-identical
    to a retro-labelled (or .sav) column — reusing apply_value_labels."""

    def _import(self, db, *, column_type="ordinal", labels=None, values=None,
                cells="2\n4\n6\n10\n"):
        from app.services.dataset_import import import_dataset_csv
        db.add(Project(id=575, name="P", user_id=1)); db.flush()
        res = import_dataset_csv(
            db=db, project_id=575, name="DS",
            column_configs=[{
                "column_index": 0, "column_type": column_type,
                "column_text": "anxiety", "column_name": "anxiety",
                "scale_labels": labels or ["Low", "Mid", "High", "Top"],
                "scale_values": values or [2, 4, 6, 10],
                "cells_are_codes": True,
            }],
            file_contents="anxiety\n" + cells,
        )
        db.flush()
        col = db.query(DatasetColumn).filter_by(dataset_id=res["dataset_id"]).one()
        return res, col

    def test_ordinal_substitutes_label_keeps_code_and_sets_metadata(self, db_session):
        res, c = self._import(db_session)
        rows = _vals(db_session, c)
        assert [v.value_text for v in rows] == ["Low", "Mid", "High", "Top"]
        assert [v.value_numeric for v in rows] == [2.0, 4.0, 6.0, 10.0]
        assert json.loads(c.scale_labels) == ["Low", "Mid", "High", "Top"]
        assert json.loads(c.scale_values) == [2, 4, 6, 10]
        prim = db_session.query(RecodeDefinition).filter_by(column_id=c.id, is_primary=True).first()
        assert prim is not None and prim.recode_type == RecodeType.SCALE_MAP

    def test_undeclared_code_kept_numeric_and_surfaced(self, db_session):
        # data has a 6 that isn't declared (only 2/4/10 labelled)
        res, c = self._import(
            db_session, labels=["Low", "Mid", "Top"], values=[2, 4, 10],
            cells="2\n4\n6\n10\n",
        )
        assert res["value_label_unlabeled"] == {0: [6.0]}
        v6 = [v for v in _vals(db_session, c) if v.value_numeric == 6.0][0]
        assert v6.value_text == "6"  # raw kept, not nulled

    def test_nominal_cells_are_codes_populate_value_numeric(self, db_session):
        # _compute_value_numeric returns None for nominal — apply_value_labels
        # recovers the code from value_text, so value_numeric is NOT NULL.
        res, c = self._import(db_session, column_type="nominal")
        assert [v.value_numeric for v in _vals(db_session, c)] == [2.0, 4.0, 6.0, 10.0]
        assert c.column_type == ColumnType.NOMINAL


# ── Endpoint-level guards ────────────────────────────────────────────────────

def _run(coro):
    return asyncio.run(coro)


def test_data_response_carries_scale_values(col):
    """#576: /data is the ONLY payload the value-labels editor reads.

    DatasetDataColumnResponse is built by splatting DatasetColumnResponse's
    model_dump(), and Pydantic's default extra='ignore' silently drops anything
    this schema doesn't declare. When scale_values was missing the editor's
    edit-mode pre-fill always missed and it re-seeded from the OBSERVED codes,
    silently dropping any declared zero-response level (#577's whole point).

    ⚠️ The construction below is a BARE SPLAT, matching `list_dataset_data`
    exactly. It passed `recode_definitions=[]` alongside until 2026-08-31, when
    #830f moved that field onto the base schema — which makes the second
    argument a DUPLICATE KEYWORD, i.e. a `TypeError`. Keeping the old shape here
    would have been a test constructing the payload differently from the
    endpoint it exists to protect, which is how the two drift.
    """
    from app.schemas.dataset import DatasetColumnResponse, DatasetDataColumnResponse
    base = DatasetColumnResponse(
        id=1, column_text="Q1", column_type="ordinal", sequence_order=0,
        scale_labels=["Low", "Top"], scale_values=[2.0, 10.0], scale_points=2,
    )
    out = DatasetDataColumnResponse(**base.model_dump())
    assert out.scale_values == [2.0, 10.0]
    assert "scale_values" in out.model_dump()


class TestReversePrimaryGuard:
    """#585: a REVERSE primary stores the REFLECTED score, not the response code.

    `_code_key` reads value_numeric as the code, so relabelling such a column
    keyed every cell on its MIRROR and rewrote value_text to the opposite
    response — destroying the participant's actual answer. Worse, it was
    self-consistent: value_text and value_numeric agreed with each other
    afterwards, so the grid looked right.

    SCALE's reflection offset is min+max = 2+10 = 12, so code 2 reflects to 10
    and 4 to 6 — both DECLARED codes. The corruption therefore yields plausible
    labels ("Low" → "Top"), never a crash. That is the shape a guard must catch.
    """

    def _reverse_primary(self, db, c, mapping):
        """The column's own forward scale_map + a REVERSE primary over it."""
        src = RecodeDefinition(
            column_id=c.id, name="Scale", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            is_primary=False, is_auto_detected=True, sequence_order=0,
        )
        db.add(src); db.flush()
        rev = RecodeDefinition(
            column_id=c.id, name="Reverse scored", recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            is_primary=True, is_auto_detected=False,
            source_definition_id=src.id, sequence_order=1,
        )
        db.add(rev); db.flush()
        return rev

    def test_refuses_and_writes_nothing(self, col):
        db, c = col
        _seed(db, c, [2, 4])
        # Reverse-score it: value_text keeps the raw code, value_numeric reflects.
        self._reverse_primary(db, c, {"2": 2, "4": 4, "6": 6, "10": 10})
        apply_definition_to_column(
            db, db.query(RecodeDefinition).filter_by(column_id=c.id, is_primary=True).first(),
        )
        db.flush()
        before_text = [v.value_text for v in _vals(db, c)]
        before_num = [v.value_numeric for v in _vals(db, c)]
        assert before_num == [10.0, 8.0]        # reflected about 12 — NOT the codes

        with pytest.raises(ValueLabelsBlockedError, match="Reverse scored"):
            apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)

        # Fail CLOSED: not one cell, and no scale metadata, may be touched.
        assert [v.value_text for v in _vals(db, c)] == before_text
        assert [v.value_numeric for v in _vals(db, c)] == before_num
        assert c.scale_labels is None

    def test_scale_map_primary_is_not_blocked(self, col):
        # value_numeric IS the mapping's code under a scale_map, so relabelling is
        # correct — blocking every primary would break the re-edit path.
        db, c = col
        _seed(db, c, [2, 4])
        db.add(RecodeDefinition(
            column_id=c.id, name="Scale", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"2": 2, "4": 4}),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        ))
        db.flush()
        res = apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
        assert res["updated"] == 2
        assert [v.value_text for v in _vals(db, c)] == ["Low", "Mid"]

    def test_category_group_primary_is_not_blocked(self, col):
        # category_group CLEARS value_numeric, so _code_key recovers the code by
        # parsing value_text — no mirror, nothing to guard.
        db, c = col
        _seed(db, c, [2, 4])
        db.add(RecodeDefinition(
            column_id=c.id, name="Bands", recode_type=RecodeType.CATEGORY_GROUP,
            output_type=OutputType.CATEGORICAL,
            mapping=json.dumps({"2": "Low band", "4": "High band"}),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        ))
        db.flush()
        res = apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
        assert res["updated"] == 2

    def test_non_primary_reverse_is_not_blocked(self, col):
        # A reverse that isn't primary doesn't drive value_numeric, so cells
        # relabel correctly. (Its own mapping keys go stale against the new
        # labels — that is #584, pre-existing and not made worse here.)
        db, c = col
        _seed(db, c, [2, 4])
        db.add(RecodeDefinition(
            column_id=c.id, name="Reverse (inactive)", recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"2": 2, "4": 4}),
            is_primary=False, is_auto_detected=False, sequence_order=0,
        ))
        db.flush()
        res = apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
        assert res["updated"] == 2
        assert [v.value_text for v in _vals(db, c)] == ["Low", "Mid"]


class TestCodeIdentityGuard:
    """#793: the guard is on the PROPERTY — "the primary's output equals the code".

    #585 scoped its guard to `RecodeType.REVERSE` on the premise that a
    `scale_map` leaves `value_numeric` == the code. True only of an IDENTITY code
    map: a FLIPPING or COLLAPSING map walks straight through it and relabels
    every response as a *different* response, self-consistently.

    ⚠️ **Every fixture below is chosen on the axis the fix generalises** — the
    DEFINITION-shaped test and the DATA-shaped test must give different answers
    on it, or the fixture certifies nothing (the degenerate-fixture rule). The
    two that matter most carry explicit DISCRIMINATION assertions: the
    label-keyed flip proves the filed shape-predicate is vacuous, and the
    nominal reverse proves the data check alone is not sufficient either.
    """

    def _seed_pairs(self, db, c, pairs):
        """Seed (value_text, value_numeric) directly — the shapes a recode leaves."""
        for text, num in pairs:
            r = DatasetRow(dataset_id=c.dataset_id); db.add(r); db.flush()
            db.add(DatasetValue(row_id=r.id, column_id=c.id,
                                value_text=text, value_numeric=num))
        db.flush()

    def _primary(self, db, c, name, mapping, rtype=RecodeType.SCALE_MAP):
        d = RecodeDefinition(
            column_id=c.id, name=name, recode_type=rtype,
            output_type=OutputType.NUMERIC, mapping=json.dumps(mapping),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        )
        db.add(d); db.flush()
        return d

    def _declare_scale(self, db, c, pairs):
        c.scale_labels = json.dumps([label for _, label in pairs])
        c.scale_values = json.dumps([code for code, _ in pairs])
        db.flush()

    def test_a_flipping_primary_is_refused_and_writes_nothing(self, col):
        # The dev-corpus shape (`Math Anxiety (inverted)`): value_text is the
        # response's own code, value_numeric is the flip's output.
        db, c = col
        self._seed_pairs(db, c, [("2", 10.0), ("4", 6.0)])
        self._primary(db, c, "Anxiety (inverted)", {"2": 10, "4": 6, "6": 4, "10": 2})

        with pytest.raises(ValueLabelsBlockedError, match=r"Anxiety \(inverted\)"):
            apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)

        # Fail CLOSED on every owner: cells, scale metadata, and the definition
        # list (no auto primary minted, nothing demoted).
        assert [(v.value_text, v.value_numeric) for v in _vals(db, c)] == [
            ("2", 10.0), ("4", 6.0)]
        assert c.scale_labels is None
        assert db.query(RecodeDefinition).filter_by(column_id=c.id).count() == 1
        assert db.query(RecodeDefinition).filter_by(column_id=c.id).one().is_primary

    def test_the_refusal_names_the_recode_and_both_codes(self, col):
        # The message is the whole remedy for a researcher — it has to say which
        # recode is in the way and what the disagreement actually is.
        db, c = col
        self._seed_pairs(db, c, [("2", 10.0)])
        self._primary(db, c, "Anxiety (inverted)", {"2": 10, "4": 6, "6": 4, "10": 2})
        with pytest.raises(ValueLabelsBlockedError) as exc:
            apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
        message = str(exc.value)
        assert "Anxiety (inverted)" in message
        assert "'2' is stored as 10, not 2" in message     # integer-formatted, not 10.0
        assert "Recode Workbench" in message

    def test_a_collapsing_primary_is_refused(self, col):
        # A banding map is not invertible, so this is the case whose damage
        # would NOT be recoverable. The first cell AGREES — one disagreement is
        # enough, and a fixture where every cell disagreed could not show that.
        db, c = col
        self._seed_pairs(db, c, [("2", 2.0), ("4", 2.0), ("6", 6.0)])
        self._primary(db, c, "Banded", {"2": 2, "4": 2, "6": 6, "10": 6})
        with pytest.raises(ValueLabelsBlockedError, match="Banded"):
            apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)

    def test_a_hand_flip_keyed_on_labels_is_refused(self, col):
        # The case #793's FILED predicate misses. Column already labelled, so a
        # hand-built primary is keyed on LABELS; metadata still holds the forward
        # dictionary, and value_numeric holds the flip.
        db, c = col
        self._declare_scale(db, c, SCALE)
        flip = {"Low": 10, "Mid": 6, "High": 4, "Top": 2}
        self._seed_pairs(db, c, [("Low", 10.0), ("Mid", 6.0)])
        self._primary(db, c, "Reversed by hand", flip)

        # DISCRIMINATION: "unsafe iff any NUMERIC key maps to a value other than
        # itself" is VACUOUS here — there is not one numeric key to judge. This
        # fixture is the entire reason the guard reads the data instead.
        def _numeric(key):
            try:
                float(key)
                return True
            except ValueError:
                return False
        assert not any(_numeric(k) for k in flip)

        with pytest.raises(ValueLabelsBlockedError, match="Reversed by hand"):
            apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)

    def test_the_reverse_guard_covers_what_the_data_check_cannot(self, col):
        # Why BOTH guards stay. `write_back_scale_metadata` runs for ORDINAL
        # columns only, so a reverse primary on a NOMINAL column leaves labelled
        # cells with no forward metadata to compare against — the data check has
        # nothing to resolve and passes it.
        db, c = col
        c.column_type = ColumnType.NOMINAL
        db.flush()
        self._seed_pairs(db, c, [("Low", 10.0), ("Mid", 6.0)])
        self._primary(db, c, "Reverse scored",
                      {"Low": 2, "Mid": 4, "High": 6, "Top": 10},
                      rtype=RecodeType.REVERSE)

        # DISCRIMINATION: the data-shaped guard, asked directly, finds nothing.
        assert code_identity_violation(c, [("Low", 10.0), ("Mid", 6.0)], None) is None

        # And the operation is refused anyway, by the definition-shaped guard.
        with pytest.raises(ValueLabelsBlockedError, match="Reverse scored"):
            apply_value_labels(db, c, SCALE, ColumnType.NOMINAL)

    def test_the_labelled_re_edit_path_is_untouched(self, col):
        # The path the internal design notes warns must keep working: keys are labels,
        # value_numeric IS the code, and editing one label must still apply.
        db, c = col
        self._declare_scale(db, c, SCALE)
        self._seed_pairs(db, c, [("Low", 2.0), ("Mid", 4.0)])
        self._primary(db, c, "Scale", {"Low": 2, "Mid": 4, "High": 6, "Top": 10})
        res = apply_value_labels(
            db, c, [(2, "Lowest"), (4, "Mid"), (6, "High"), (10, "Top")],
            ColumnType.ORDINAL,
        )
        assert res["updated"] == 2
        assert [v.value_text for v in _vals(db, c)] == ["Lowest", "Mid"]

    def test_a_zero_coded_label_is_resolved_not_skipped(self, col):
        # The falsy-zero trap, on a real `.sav` shape: D2 preserves SPSS's own
        # 0-based codes and #536 synthesizes an unlabelled point's label FROM its
        # code string — so `label_to_code["1"]` is 0.0. A
        # `label_to_code.get(text) or parse(text)` implementation resolves that
        # cell to 1.0, disagrees with the stored 0.0, and REFUSES a healthy
        # column. Membership must be tested with `in`.
        db, c = col
        zero_based = [(0, "1"), (1, "2"), (2, "3")]
        self._declare_scale(db, c, zero_based)
        self._seed_pairs(db, c, [("1", 0.0), ("2", 1.0)])
        res = apply_value_labels(db, c, zero_based, ColumnType.ORDINAL)
        assert res["updated"] == 2

    def test_a_declared_missing_cell_is_not_evidence(self, col):
        # `apply_value_labels` skips missing cells outright (#592 §I.3), so a
        # sentinel whose stored number disagrees is neither at risk nor grounds
        # to refuse. Without the skip, "99" vs 5.0 reads as a violation and the
        # whole column is blocked over a cell nothing would have touched.
        db, c = col
        c.missing_values = json.dumps([{"value": "99"}])
        db.flush()
        self._seed_pairs(db, c, [("2", 2.0), ("4", 4.0), ("99", 5.0)])
        res = apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
        assert res["updated"] == 2
        assert [v.value_text for v in _vals(db, c)] == ["Low", "Mid", "99"]


class TestEndpointGuards:
    def _user(self, db):
        return db.get(User, 1)

    def test_rejects_reverse_primary_with_actionable_400(self, col):
        from fastapi import HTTPException
        from app.routers.recode import apply_value_labels_endpoint
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        db, c = col
        _seed(db, c, [2, 4])
        db.add(RecodeDefinition(
            column_id=c.id, name="Reverse scored", recode_type=RecodeType.REVERSE,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"2": 2, "4": 4}),
            is_primary=True, is_auto_detected=False, sequence_order=0,
        ))
        db.flush()
        req = ApplyValueLabelsRequest(labels=[ValueLabelPair(value=2, label="Low")])
        with pytest.raises(HTTPException) as exc:
            apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db)
        assert exc.value.status_code == 400
        # The refusal must name the recode AND the way out, not just say "no".
        assert "Reverse scored" in exc.value.detail
        assert "Recode Workbench" in exc.value.detail

    def test_rejects_computed_column(self, col):
        from fastapi import HTTPException
        from app.routers.recode import apply_value_labels_endpoint
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        db, c = col
        c.source = "computed"; db.flush()
        req = ApplyValueLabelsRequest(labels=[ValueLabelPair(value=1, label="A")])
        with pytest.raises(HTTPException) as exc:
            apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db)
        assert exc.value.status_code == 403

    def test_rejects_open_text(self, col):
        from fastapi import HTTPException
        from app.routers.recode import apply_value_labels_endpoint
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        db, c = col
        c.column_type = ColumnType.OPEN_TEXT; db.flush()
        req = ApplyValueLabelsRequest(labels=[ValueLabelPair(value=1, label="A")])
        with pytest.raises(HTTPException) as exc:
            apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db)
        assert exc.value.status_code == 400

    def test_schema_rejects_duplicate_codes(self):
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        with pytest.raises(ValueError, match="Duplicate codes"):
            ApplyValueLabelsRequest(labels=[ValueLabelPair(value=1, label="A"),
                                            ValueLabelPair(value=1, label="B")])

    def test_schema_rejects_duplicate_labels(self):
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        with pytest.raises(ValueError, match="Duplicate labels"):
            ApplyValueLabelsRequest(labels=[ValueLabelPair(value=1, label="A"),
                                            ValueLabelPair(value=2, label="a")])

    def test_endpoint_applies_and_returns_response(self, col):
        # Happy path through the HTTP endpoint (auth + gate + schema + commit).
        from app.routers.recode import apply_value_labels_endpoint
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        db, c = col
        _seed(db, c, [2, 4, 6])   # includes a 6 not in the declared set below
        req = ApplyValueLabelsRequest(
            labels=[ValueLabelPair(value=2, label="Low"), ValueLabelPair(value=4, label="Mid")],
            column_type="ordinal",
        )
        res = apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db)
        assert res.column_id == c.id
        assert res.updated == 2
        assert res.unlabeled_codes == [6.0]
        rows = _vals(db, c)
        assert [v.value_text for v in rows] == ["Low", "Mid", "6"]
        assert json.loads(c.scale_labels) == ["Low", "Mid"]


class TestDefaultsMissingFilterOnUndeclaredColumns:
    """#605 — the C4 dictionary filter is column-aware like every other
    surface: the declaration when present, the recognized-N/A DEFAULTS when
    not. Pre-fix the filter was gated on `missing_rules is not None`, so an
    UNDECLARED column could label a code "Not applicable" — writing text every
    read surface calls missing while its numeric fed every mean (the #595
    text-vs-numeric split reintroduced at a write path, and a break in this
    module's own ".sav byte-identical" promise)."""

    def test_defaults_missing_label_skipped_and_reported(self, col):
        db, c = col
        _seed(db, c, [1, 9])
        res = apply_value_labels(
            db, c, [(1, "Never"), (9, "Not applicable")], None)
        assert res["missing_skipped"] == [9.0]
        rows = {v.value_text: v.value_numeric for v in _vals(db, c)}
        assert rows == {"Never": 1.0, "9": 9.0}, (
            "the code stays consistent DATA (§A4: numeric sentinels count "
            "unless declared) — never text-missing with a live numeric"
        )
        assert json.loads(c.scale_labels) == ["Never"], (
            "a defaults-missing label must not become a scale point (C4)"
        )

    def test_declared_nothing_keeps_the_pair(self, col):
        """Two-sided (REPLACE): a `[]` declaration makes 'Not applicable' a
        legitimate label — the pair must be KEPT, or the filter is just the
        defaults re-inlined."""
        db, c = col
        c.missing_values = "[]"
        _seed(db, c, [1, 9])
        res = apply_value_labels(
            db, c, [(1, "Never"), (9, "Not applicable")], None)
        assert res["missing_skipped"] == []
        rows = {v.value_text: v.value_numeric for v in _vals(db, c)}
        assert rows == {"Never": 1.0, "Not applicable": 9.0}
        assert json.loads(c.scale_labels) == ["Never", "Not applicable"]

    def test_all_pairs_missing_bails_without_touching_the_column(self, col):
        """Every pair filtered → applying would write EMPTY scale metadata and
        an empty-mapping primary over whatever the column has. Refuse to touch
        cells, metadata, or the primary; report only."""
        db, c = col
        _seed(db, c, [2, 4])
        apply_value_labels(db, c, SCALE, ColumnType.ORDINAL)
        pre_labels = c.scale_labels
        d = db.query(RecodeDefinition).filter_by(column_id=c.id).one()
        pre_mapping = d.mapping
        res = apply_value_labels(db, c, [(9, "Not applicable")], None)
        # #584: the bail path reports an EMPTY staled set — it touched no
        # cells, so it can have re-keyed nothing. Asserted as whole-dict
        # equality, deliberately: that is what caught the new key arriving.
        assert res == {"updated": 0, "unlabeled_codes": [],
                       "missing_skipped": [9.0], "staled_definitions": []}
        assert c.scale_labels == pre_labels, "metadata must survive the bail"
        assert db.query(RecodeDefinition).filter_by(
            column_id=c.id).one().mapping == pre_mapping


# ═══════════════════════════════════════════════════════════════════════════════
# #589 — the eligible-type rule lives on the OPERATION, not only at the router
# #588 — the dictionary has ONE ceiling, at all four write paths
# ═══════════════════════════════════════════════════════════════════════════════


class TestIneligibleColumnTypes:
    """A declared dictionary must never reach an open-text or identifier column.

    The retro endpoint has always answered 400 for these. The IMPORT path calls
    `apply_value_labels` directly via `cells_are_codes` and passes no router at
    all — so before #589 a config of `{"column_type": "open_text",
    "cells_are_codes": true}` substituted labels into free-form responses, wrote
    scale metadata and minted a primary scale_map. Reproduced by execution
    before the fix; the guard now sits next to the assumption it protects, the
    same placement `blocking_reverse_primary` uses (#585).
    """

    def _col(self, db, ctype):
        p = db.query(Project).filter_by(id=1).first()
        if p is None:
            db.add(Project(id=1, name="P", user_id=1)); db.flush()
            db.add(Dataset(id=1, project_id=1, name="D")); db.flush()
        c = DatasetColumn(dataset_id=1, column_code="X", column_text="X",
                          column_type=ctype, sequence_order=9, display_order=9)
        db.add(c); db.flush()
        return c

    @pytest.mark.parametrize("ctype", [ColumnType.OPEN_TEXT, ColumnType.IDENTIFIER])
    def test_service_refuses_an_ineligible_current_type(self, db_session, ctype):
        c = self._col(db_session, ctype)
        with pytest.raises(ValueLabelsBlockedError, match="cannot be applied"):
            apply_value_labels(db_session, c, [(1, "Yes")], None)

    @pytest.mark.parametrize("current, target", [
        (ColumnType.OPEN_TEXT, ColumnType.ORDINAL),   # arrive ineligible, ask to convert
        (ColumnType.ORDINAL, ColumnType.OPEN_TEXT),   # arrive fine, ask to become ineligible
    ])
    def test_neither_the_current_nor_the_target_type_may_be_ineligible(
        self, db_session, current, target
    ):
        """Checking only one of the two leaves a sidestep: the caller supplies
        the type it wants, so a one-sided guard is bypassed by naming the other."""
        c = self._col(db_session, current)
        with pytest.raises(ValueLabelsBlockedError):
            apply_value_labels(db_session, c, [(1, "Yes")], target)

    def test_an_eligible_column_is_unaffected(self, db_session):
        c = self._col(db_session, ColumnType.NOMINAL)
        _seed(db_session, c, [1])
        res = apply_value_labels(db_session, c, [(1, "Yes")], ColumnType.NOMINAL)
        assert res["updated"] == 1

    def test_the_import_path_is_refused_end_to_end(self, db_session):
        """The door the schema cannot close: `import_dataset_csv` takes raw
        dicts, so only the service guard stands between this config and a
        relabelled free-text column."""
        from app.services.dataset_import import import_dataset_csv
        db_session.add(Project(id=77, name="P77", user_id=1)); db_session.flush()
        cfgs = [{"column_index": 0, "skip": False, "column_type": "open_text",
                 "column_text": "note", "cells_are_codes": True,
                 "scale_labels": ["Yes", "No"], "scale_values": [1, 2]}]
        with pytest.raises(ValueLabelsBlockedError):
            import_dataset_csv(db_session, project_id=77, name="DS",
                               column_configs=cfgs, file_contents="note\n1\n2\n")

    def test_the_import_config_schema_refuses_it_earlier(self):
        """The edge arm: a clean 422 before any work, for the wizard."""
        from pydantic import ValidationError
        from app.schemas.dataset import DatasetColumnConfig
        for t in ("open_text", "identifier"):
            with pytest.raises(ValidationError, match="cells_are_codes"):
                DatasetColumnConfig(column_index=1, column_type=t, column_text="c",
                                    cells_are_codes=True, scale_labels=["Yes"],
                                    scale_values=[1])

    def test_a_skipped_column_is_not_judged(self):
        """A skipped column is discarded before any post-pass runs, so refusing
        it would reject a harmless (if pointless) config."""
        from app.schemas.dataset import DatasetColumnConfig
        cfg = DatasetColumnConfig(column_index=1, column_type="skip", column_text="c",
                                  skip=True, cells_are_codes=True)
        assert cfg.skip is True


class TestValueLabelCeiling:
    """#588 — one ceiling, shared by every schema that can write `scale_labels`.

    The filed entry named two write paths; there are four. A cap on one leaves
    the others open, which is why the bound is a shared validator rather than a
    `max_length=` on a single field.
    """

    def _labels(self, n):
        return [f"L{i}" for i in range(n)]

    def test_every_write_path_refuses_one_past_the_cap(self):
        from pydantic import ValidationError
        from app.schemas.dataset import (
            DatasetColumnConfig, ManualColumnCreate, ManualColumnUpdate,
        )
        from app.schemas.recode import ApplyValueLabelsRequest
        from app.services.value_labels import MAX_VALUE_LABELS

        over = MAX_VALUE_LABELS + 1
        builders = {
            "value-labels endpoint": lambda: ApplyValueLabelsRequest(
                labels=[{"value": float(i), "label": f"L{i}"} for i in range(over)]),
            "import config": lambda: DatasetColumnConfig(
                column_index=1, column_type="nominal", column_text="c",
                scale_labels=self._labels(over)),
            "manual column create": lambda: ManualColumnCreate(
                column_text="c", column_type="nominal", scale_labels=self._labels(over)),
            "manual column update": lambda: ManualColumnUpdate(
                scale_labels=self._labels(over)),
        }
        for name, build in builders.items():
            try:
                build()
            except ValidationError:
                continue
            pytest.fail(f"{name} accepted {over} labels — its door is still open")

    def test_a_real_codebook_at_the_cap_still_imports(self):
        """The other side of the bound, and the reason it is 500 rather than the
        preview-seed heuristic's 30: an SPSS nominal for occupation (~430 ISCO
        unit groups) or country (~250) legitimately carries hundreds, and `.sav`
        import feeds this same schema. Tightening the cap to the seed number
        would reject ordinary survey data — this assertion is what stops that."""
        from app.schemas.dataset import DatasetColumnConfig
        from app.services.value_labels import MAX_VALUE_LABELS
        cfg = DatasetColumnConfig(
            column_index=1, column_type="nominal", column_text="c",
            scale_labels=self._labels(MAX_VALUE_LABELS),
            scale_values=[float(i) for i in range(MAX_VALUE_LABELS)])
        assert len(cfg.scale_labels) == MAX_VALUE_LABELS
        assert MAX_VALUE_LABELS >= 250, (
            "the cap must admit a country/occupation codebook — see #588"
        )
