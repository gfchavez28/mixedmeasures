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
from app.services.value_labels import apply_value_labels, ValueLabelsBlockedError


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
    """
    from app.schemas.dataset import DatasetColumnResponse, DatasetDataColumnResponse
    base = DatasetColumnResponse(
        id=1, column_text="Q1", column_type="ordinal", sequence_order=0,
        scale_labels=["Low", "Top"], scale_values=[2.0, 10.0], scale_points=2,
    )
    out = DatasetDataColumnResponse(**base.model_dump(), recode_definitions=[])
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
            _run(apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db))
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
            _run(apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db))
        assert exc.value.status_code == 403

    def test_rejects_open_text(self, col):
        from fastapi import HTTPException
        from app.routers.recode import apply_value_labels_endpoint
        from app.schemas.recode import ApplyValueLabelsRequest, ValueLabelPair
        db, c = col
        c.column_type = ColumnType.OPEN_TEXT; db.flush()
        req = ApplyValueLabelsRequest(labels=[ValueLabelPair(value=1, label="A")])
        with pytest.raises(HTTPException) as exc:
            _run(apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db))
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
        res = _run(apply_value_labels_endpoint(1, 1, c.id, req, user=self._user(db), db=db))
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
        assert res == {"updated": 0, "unlabeled_codes": [],
                       "missing_skipped": [9.0]}
        assert c.scale_labels == pre_labels, "metadata must survive the bail"
        assert db.query(RecodeDefinition).filter_by(
            column_id=c.id).one().mapping == pre_mapping
