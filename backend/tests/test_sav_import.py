"""SPSS .sav import adapter (#28).

Fixture: ``tests/reference_data/spss_sample.sav`` — a real SPSS file written by
ReadStat, regenerable with ``scripts/make_sav_fixture.py`` (that script needs
pandas; the suite deliberately does not). Its shape:

    pid        string identifier, last row blank (system-missing)
    gender     nominal + labels {1: Male, 2: Female}
    satisfied  ordinal + 5-point labels, code 9 declared user-missing ("Refused")
    support    ordinal + ZERO-BASED labels {0: None … 3: A lot}
    score      measure='scale', continuous, one system-missing cell
    joined     date, one system-missing cell
"""

import csv
import io
import subprocess
import sys
from pathlib import Path

import pytest

from app.services.sav_import import (
    MAX_SAV_COLS,
    SavImportError,
    _in_missing_range,
    _ordered_scale_points,
    _sav_cell_to_str,
    is_sav_upload,
    sav_to_csv_text,
)

FIXTURE = Path(__file__).parent / "reference_data" / "spss_sample.sav"
PARTIAL_FIXTURE = Path(__file__).parent / "reference_data" / "spss_partial_labels.sav"
EDGE_FIXTURE = Path(__file__).parent / "reference_data" / "spss_edge_cases.sav"


@pytest.fixture(scope="module")
def sav_bytes() -> bytes:
    return FIXTURE.read_bytes()


@pytest.fixture(scope="module")
def converted(sav_bytes):
    text, meta = sav_to_csv_text(sav_bytes)
    rows = list(csv.reader(io.StringIO(text)))
    return rows, meta


@pytest.fixture(scope="module")
def partial_converted():
    text, meta = sav_to_csv_text(PARTIAL_FIXTURE.read_bytes())
    rows = list(csv.reader(io.StringIO(text)))
    return rows, meta


@pytest.fixture(scope="module")
def edge_converted():
    """#541 fixture — duplicate value labels + string user-missing values."""
    text, meta = sav_to_csv_text(EDGE_FIXTURE.read_bytes())
    rows = list(csv.reader(io.StringIO(text)))
    return rows, meta


def _col(rows, name):
    idx = rows[0].index(name)
    return [r[idx] for r in rows[1:]]


class TestUploadSniff:
    def test_accepts_real_sav(self, sav_bytes):
        assert is_sav_upload("survey.sav", sav_bytes)
        assert is_sav_upload("SURVEY.SAV", sav_bytes)  # case-insensitive extension

    def test_rejects_renamed_csv(self):
        """Extension alone must not route a CSV into ReadStat."""
        assert not is_sav_upload("survey.sav", b"col1,col2\n1,2\n")

    def test_rejects_sav_bytes_without_extension(self, sav_bytes):
        """Magic alone must not hijack an upload the user named .csv."""
        assert not is_sav_upload("survey.csv", sav_bytes)
        assert not is_sav_upload(None, sav_bytes)


class TestConversion:
    def test_header_is_spss_variable_names(self, converted):
        rows, _ = converted
        assert rows[0] == ["pid", "gender", "satisfied", "support", "score", "joined"]

    def test_value_labels_replace_codes(self, converted):
        rows, _ = converted
        assert _col(rows, "gender") == ["Male", "Female", "Female", "Male"]

    def test_system_missing_becomes_blank(self, converted):
        rows, _ = converted
        assert _col(rows, "score") == ["88", "71.5", "", "60"]
        assert _col(rows, "pid")[3] == ""
        assert _col(rows, "joined")[3] == ""

    def test_dates_render_iso(self, converted):
        rows, _ = converted
        assert _col(rows, "joined")[:3] == ["2026-07-09", "2020-01-01", "2024-12-31"]

    def test_integral_floats_lose_the_decimal(self, converted):
        """CSV parity with the .xlsx adapter: a typed 88 must not become '88.0'."""
        rows, _ = converted
        assert _col(rows, "score")[0] == "88"

    def test_empty_file_rejected(self):
        with pytest.raises(SavImportError):
            sav_to_csv_text(b"$FL2 not really an spss file")


class TestUserMissingIsNotAScalePoint:
    """The load-bearing bug this adapter exists to avoid.

    `missing_ranges` only populates when reading with user_missing=True, and that
    read renders code 9 as its label. A naive `apply_value_formats=True` adapter
    would import "Refused" as a valid 6th point of a 5-point scale.
    """

    def test_user_missing_cell_is_blank_not_refused(self, converted):
        rows, _ = converted
        satisfied = _col(rows, "satisfied")
        assert satisfied == ["Strongly agree", "Strongly disagree", "", "Neutral"]
        assert "Refused" not in satisfied

    def test_user_missing_label_excluded_from_scale_points(self, converted):
        _, meta = converted
        assert meta["satisfied"].ordered_labels == [
            "Strongly disagree",
            "Disagree",
            "Neutral",
            "Agree",
            "Strongly agree",
        ]
        assert meta["satisfied"].ordered_values == [1.0, 2.0, 3.0, 4.0, 5.0]

    def test_in_missing_range_covers_discrete_and_range_forms(self):
        assert _in_missing_range(9.0, [{"lo": 9.0, "hi": 9.0}])
        assert _in_missing_range(97, [{"lo": 96, "hi": 99}])
        assert not _in_missing_range(5.0, [{"lo": 9.0, "hi": 9.0}])
        assert not _in_missing_range(None, [{"lo": 9.0, "hi": 9.0}])
        assert not _in_missing_range("Refused", [{"lo": 9.0, "hi": 9.0}])  # no cross-type compare


class TestOrderedScalePoints:
    def test_ordinal_recovers_spss_order_not_alphabetical(self, converted):
        """The fidelity the CSV path cannot reach: SPSS knows the order."""
        _, meta = converted
        labels = meta["satisfied"].ordered_labels
        assert labels[0] == "Strongly disagree" and labels[-1] == "Strongly agree"
        assert labels != sorted(labels), "alphabetical order would be the CSV-path guess"

    def test_zero_based_codes_are_preserved(self, converted):
        """A 0..3 SPSS scale must not silently become 1..4 (means would shift)."""
        _, meta = converted
        assert meta["support"].ordered_values == [0.0, 1.0, 2.0, 3.0]
        assert meta["support"].ordered_labels == ["None", "A little", "Some", "A lot"]

    def test_is_labelled_ordinal_gate(self, converted):
        _, meta = converted
        assert meta["satisfied"].is_labelled_ordinal
        assert meta["support"].is_labelled_ordinal
        # nominal-with-labels must NOT be promoted — labels imply no order
        assert not meta["gender"].is_labelled_ordinal
        assert not meta["score"].is_labelled_ordinal

    def test_column_label_carries_question_text(self, converted):
        _, meta = converted
        assert meta["satisfied"].column_label == "Overall, I am satisfied with the program"
        assert meta["gender"].column_label is None

    def test_string_keyed_label_map_claims_no_order(self):
        """A string variable's labels have no numeric order to sort by."""
        assert _ordered_scale_points({"a": "Apple", "b": "Banana"}, []) == ([], [])


class TestCellStringification:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (None, ""),
            (float("nan"), ""),
            (3.0, "3"),
            (3.5, "3.5"),
            (True, "TRUE"),
            (False, "FALSE"),
            ("text", "text"),
        ],
    )
    def test_cells(self, value, expected):
        assert _sav_cell_to_str(value) == expected


class TestCaps:
    def test_column_cap_is_enforced(self, sav_bytes, monkeypatch):
        monkeypatch.setattr("app.services.sav_import.MAX_SAV_COLS", 2)
        with pytest.raises(SavImportError, match="variables"):
            sav_to_csv_text(sav_bytes)

    def test_row_cap_is_enforced(self, sav_bytes, monkeypatch):
        monkeypatch.setattr("app.services.sav_import.MAX_SAV_ROWS", 1)
        with pytest.raises(SavImportError, match="rows"):
            sav_to_csv_text(sav_bytes)

    def test_row_cap_binds_when_header_count_is_unknown(self, sav_bytes, monkeypatch):
        """#539: SPSS headers may legally record ncases = -1 ("unknown", written
        by streaming writers) — the cheap header check passes it, so the cap must
        ALSO bind at the full read (row_limit + re-check), or the file inflates
        unbounded into the dict-of-lists read."""
        import pyreadstat

        real_read_sav = pyreadstat.read_sav

        def unknown_header(src, **kwargs):
            data, meta = real_read_sav(src, **kwargs)
            if kwargs.get("metadataonly"):
                meta.number_rows = -1
            return data, meta

        monkeypatch.setattr(pyreadstat, "read_sav", unknown_header)
        monkeypatch.setattr("app.services.sav_import.MAX_SAV_ROWS", 1)
        with pytest.raises(SavImportError, match="rows"):
            sav_to_csv_text(sav_bytes)

    def test_caps_mirror_the_xlsx_adapter(self):
        from app.services.dataset_import import MAX_XLSX_COLS, MAX_XLSX_ROWS
        from app.services.sav_import import MAX_SAV_ROWS

        assert MAX_SAV_COLS == MAX_XLSX_COLS
        assert MAX_SAV_ROWS == MAX_XLSX_ROWS  # #555b — the docstring's claim, now enforced


class TestPreviewOverlay:
    """apply_sav_metadata: SPSS informs ordinal only (D1); MM infers the rest."""

    def _preview(self, sav_bytes):
        from app.services.dataset_import import preview_dataset_csv
        from app.services.sav_import import apply_sav_metadata

        text, meta = sav_to_csv_text(sav_bytes)
        result = preview_dataset_csv(text)
        apply_sav_metadata(result["columns"], meta)
        return {c["column_name"]: c for c in result["columns"]}

    def test_spss_ordinal_beats_the_known_scale_matcher(self, sav_bytes):
        """MM matches our 5-point scale to a 4-point library entry, losing
        'Neutral' (whose value_numeric would then be null). SPSS knows better."""
        cols = self._preview(sav_bytes)
        sat = cols["satisfied"]
        assert sat["suggested_type"] == "ordinal"
        assert sat["suggested_scale_labels"] == [
            "Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree",
        ]
        assert sat["suggested_scale_values"] == [1.0, 2.0, 3.0, 4.0, 5.0]

    def test_unmatched_scale_is_promoted_from_nominal(self, sav_bytes):
        """Without SPSS metadata, 'support' infers as alphabetical nominal."""
        cols = self._preview(sav_bytes)
        sup = cols["support"]
        assert sup["suggested_type"] == "ordinal"
        assert sup["suggested_scale_values"] == [0.0, 1.0, 2.0, 3.0]

    def test_guessed_scale_name_and_strays_are_cleared(self, sav_bytes):
        """The #364 stray list was computed against MM's guessed scale; once SPSS
        supplies the real one it describes nothing."""
        cols = self._preview(sav_bytes)
        assert cols["satisfied"]["suggested_scale_name"] is None
        assert cols["satisfied"]["suggested_scale_unmatched"] is None

    def test_nominal_with_labels_is_not_promoted(self, sav_bytes):
        """gender has value labels but measure='nominal' — labels imply no order."""
        cols = self._preview(sav_bytes)
        assert cols["gender"]["suggested_type"] != "ordinal"
        assert cols["gender"]["suggested_scale_values"] is None

    def test_spss_variable_label_becomes_column_text(self, sav_bytes):
        cols = self._preview(sav_bytes)
        assert cols["satisfied"]["suggested_column_text"] == (
            "Overall, I am satisfied with the program"
        )

    def test_variable_name_survives_the_label_override(self, sav_bytes):
        """Overwriting column_text with the label must not lose the variable name,
        or the column is only reachable as an auto-assigned code like 'C003'."""
        cols = self._preview(sav_bytes)
        assert cols["satisfied"]["suggested_column_name"] == "satisfied"
        assert cols["support"]["suggested_column_name"] == "support"  # no label
        assert cols["score"]["suggested_column_name"] == "score"

    def test_other_types_still_come_from_mm_inference(self, sav_bytes):
        cols = self._preview(sav_bytes)
        assert cols["pid"]["suggested_type"] == "identifier"  # #414 detection
        assert cols["score"]["suggested_type"] == "numeric"


class TestValueNumericEncoding:
    """D2: value_numeric preserves SPSS's own codes; CSV keeps positional 1..N."""

    def test_spss_codes_are_used_when_supplied(self):
        from app.services.dataset_import import _compute_value_numeric

        labels = ["None", "A little", "Some", "A lot"]
        values = [0.0, 1.0, 2.0, 3.0]
        got = [_compute_value_numeric(l, "ordinal", labels, values) for l in labels]
        assert got == [0.0, 1.0, 2.0, 3.0], "a 0-based scale must not become 1..4"

    def test_csv_path_is_byte_for_byte_unchanged(self):
        """scale_values=None (every non-.sav import) keeps the historical encoding."""
        from app.services.dataset_import import _compute_value_numeric

        labels = ["Poor", "Fair", "Good"]
        assert [_compute_value_numeric(l, "ordinal", labels, None) for l in labels] == [
            1.0, 2.0, 3.0,
        ]

    def test_length_mismatch_falls_back_rather_than_mis_encoding(self):
        from app.services.dataset_import import _compute_value_numeric

        labels = ["Poor", "Fair", "Good"]
        assert [
            _compute_value_numeric(l, "ordinal", labels, [10.0, 20.0]) for l in labels
        ] == [1.0, 2.0, 3.0]

    def test_na_still_wins_over_any_scale_code(self):
        from app.services.dataset_import import _compute_value_numeric

        labels = ["None", "N/A"]
        assert _compute_value_numeric("N/A", "ordinal", labels, [0.0, 9.0]) is None


class TestPartialLabelCoverage:
    """#536: SPSS ordinals whose labels don't cover the observed codes.

    Fixture ``spss_partial_labels.sav`` (see ``scripts/make_sav_fixture.py``):
    endpoint-anchored ``stress`` (labels on 1/7 only), fully-labelled ``agree``
    with an undeclared 9 and a non-integer 2.5, two-label 1..100 ``slider``,
    and ``mood`` (endpoint-anchored + 99 declared user-missing).
    """

    def test_endpoint_anchored_scale_promotes_at_full_width(self, partial_converted):
        _, meta = partial_converted
        stress = meta["stress"]
        assert stress.is_labelled_ordinal
        assert stress.ordered_values == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
        assert stress.ordered_labels == [
            "Not at all", "2", "3", "4", "5", "6", "Extremely",
        ]

    def test_interior_cells_match_their_synthesized_labels(self, partial_converted):
        """The CSV cell for an unlabelled code and its synthesized scale label
        must be the SAME string, or value_numeric still label-map-misses."""
        rows, meta = partial_converted
        cells = set(_col(rows, "stress"))
        assert cells == {"Not at all", "2", "3", "4", "5", "6", "Extremely"}
        assert set(meta["stress"].ordered_labels) == cells

    def test_synthesized_scale_encodes_every_response(self, partial_converted):
        """The bug being fixed: '4' on an endpoint-anchored 1..7 was None."""
        from app.services.dataset_import import _compute_value_numeric

        _, meta = partial_converted
        stress = meta["stress"]
        got = [
            _compute_value_numeric(
                label, "ordinal", stress.ordered_labels, stress.ordered_values
            )
            for label in stress.ordered_labels
        ]
        assert got == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]

    def test_strays_survive_as_warnings_not_silence(self, partial_converted):
        """agree: undeclared 9 (outside 1..5) and 2.5 (non-integer) stay strays —
        they import as missing, so the preview must SAY so (#364 restored)."""
        _, meta = partial_converted
        agree = meta["agree"]
        assert agree.ordered_values == [1.0, 2.0, 3.0, 4.0, 5.0]  # not widened
        assert agree.stray_values == ["2.5", "9"]

    def test_stray_warning_reaches_the_preview_overlay(self):
        from app.services.dataset_import import preview_dataset_csv
        from app.services.sav_import import apply_sav_metadata

        text, meta = sav_to_csv_text(PARTIAL_FIXTURE.read_bytes())
        result = preview_dataset_csv(text)
        apply_sav_metadata(result["columns"], meta)
        cols = {c["column_name"]: c for c in result["columns"]}
        assert cols["agree"]["suggested_scale_unmatched"] == ["2.5", "9"]
        assert cols["stress"]["suggested_scale_unmatched"] is None

    def test_wide_span_demotes_to_plain_numbers(self, partial_converted):
        """slider (1='Low', 100='High') is a continuous variable wearing two
        labels: no promotion, and NO label substitution — mixed text/number
        cells would corrupt the numeric inference downstream."""
        rows, meta = partial_converted
        assert not meta["slider"].is_labelled_ordinal
        assert meta["slider"].ordered_labels == []
        cells = _col(rows, "slider")
        assert "Low" not in cells and "High" not in cells
        assert cells[0] == "1" and cells[-1] == "100"

    def test_declared_missing_is_not_a_stray(self, partial_converted):
        """mood declares 99 user-missing: the cell blanks (existing rule), and 99
        must neither join the synthesized scale nor surface as a stray."""
        rows, meta = partial_converted
        mood = meta["mood"]
        assert mood.stray_values == []
        assert mood.ordered_values == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
        assert "" in _col(rows, "mood")

    def test_full_coverage_is_untouched(self, converted):
        """The original fixture's fully-covered scales reconcile to themselves."""
        _, meta = converted
        assert meta["satisfied"].ordered_values == [1.0, 2.0, 3.0, 4.0, 5.0]
        assert meta["satisfied"].stray_values == []
        assert meta["support"].ordered_values == [0.0, 1.0, 2.0, 3.0]

    def test_single_label_ordinal_suppresses_substitution_column_wide(self, partial_converted):
        """#555c: a lone anchor label (anxiety: only 1='Not at all' on a 1..7
        slider) is not a scale. Substituting it would leave mixed text/number
        cells — the exact shape the demote branch exists to prevent — so the
        column imports as plain numbers throughout, is never promoted, and the
        anchor stays on the meta record rather than in any cell."""
        rows, meta = partial_converted
        anx = meta["anxiety"]
        assert not anx.is_labelled_ordinal  # single label never promotes
        assert anx.ordered_labels == ["Not at all"]  # anchor survives in metadata
        cells = _col(rows, "anxiety")
        assert "Not at all" not in cells  # no substitution anywhere
        assert set(cells) == {"1", "2", "3", "4", "5", "6", "7"}

    def test_single_label_column_keeps_its_variable_label_in_the_preview(self):
        """#555c: suppression drops the CELL substitution only — the SPSS
        variable label (the question text) still overlays the preview."""
        from app.services.dataset_import import preview_dataset_csv
        from app.services.sav_import import apply_sav_metadata

        text, meta = sav_to_csv_text(PARTIAL_FIXTURE.read_bytes())
        result = preview_dataset_csv(text)
        apply_sav_metadata(result["columns"], meta)
        cols = {c["column_name"]: c for c in result["columns"]}
        assert cols["anxiety"]["suggested_column_text"] == "How anxious were you this week?"
        assert cols["anxiety"].get("suggested_type") != "ordinal"  # no promotion


class TestPreviewEndpointSeam:
    """The adapter only matters if `_upload_to_csv_text` routes .sav into it."""

    def test_preview_endpoint_accepts_sav(self, db_session, sav_bytes):
        import asyncio

        from starlette.datastructures import UploadFile as StarletteUploadFile

        from app.models.project import Project
        from app.models.user import User
        from app.routers.dataset import preview_dataset

        db = db_session
        db.add(Project(id=981, name="SAV", user_id=1))
        db.flush()
        user = db.get(User, 1)

        upload = StarletteUploadFile(filename="survey.sav", file=io.BytesIO(sav_bytes))
        resp = asyncio.run(
            preview_dataset(
                project_id=981, file=upload, encoding="utf-8", sheet_name=None, user=user, db=db,
            )
        )
        assert resp.sheet_names is None  # .sav has no worksheets
        assert resp.total_rows == 4
        assert [c.column_name for c in resp.columns] == [
            "pid", "gender", "satisfied", "support", "score", "joined",
        ]

    def test_corrupt_sav_surfaces_a_400(self, db_session):
        import asyncio

        from fastapi import HTTPException
        from starlette.datastructures import UploadFile as StarletteUploadFile

        from app.models.project import Project
        from app.models.user import User
        from app.routers.dataset import preview_dataset

        db = db_session
        db.add(Project(id=982, name="SAV2", user_id=1))
        db.flush()
        user = db.get(User, 1)

        bad = StarletteUploadFile(filename="broken.sav", file=io.BytesIO(b"$FL2garbage"))
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                preview_dataset(
                    project_id=982, file=bad, encoding="utf-8", sheet_name=None, user=user, db=db,
                )
            )
        assert exc.value.status_code == 400


class TestImportPersistsSpssCodes:
    """End-to-end: the codes must reach DatasetColumn.scale_values AND
    DatasetValue.value_numeric, or the whole slab-2 thread is decorative."""

    def _import(self, db, sav_bytes, project_id):
        import json

        from app.models.project import Project
        from app.services.dataset_import import import_dataset_csv, preview_dataset_csv
        from app.services.sav_import import apply_sav_metadata

        db.add(Project(id=project_id, name="SAV", user_id=1))
        db.flush()

        text, meta = sav_to_csv_text(sav_bytes)
        preview = preview_dataset_csv(text)
        apply_sav_metadata(preview["columns"], meta)

        configs = [
            {
                "column_index": c["column_index"],
                "column_type": c["suggested_type"],
                "column_text": c["suggested_column_text"],
                "column_name": c.get("suggested_column_name"),
                "scale_labels": c.get("suggested_scale_labels"),
                "scale_values": c.get("suggested_scale_values"),
            }
            for c in preview["columns"]
        ]
        result = import_dataset_csv(
            db=db, project_id=project_id, name="SPSS", column_configs=configs,
            file_contents=text,
        )
        db.flush()
        return result, json

    def test_zero_based_scale_survives_to_the_database(self, db_session, sav_bytes):
        import json

        from app.models.dataset import DatasetColumn, DatasetValue

        db = db_session
        self._import(db, sav_bytes, 990)

        support = db.query(DatasetColumn).filter_by(column_name="support").one()
        assert json.loads(support.scale_values) == [0.0, 1.0, 2.0, 3.0]
        assert json.loads(support.scale_labels) == ["None", "A little", "Some", "A lot"]
        # Compare the stored STRING: `[1,2,3] == [1.0,2.0,3.0]` is True in Python,
        # so a json.loads() comparison cannot catch a float/int representation drift
        # between the CSV and .sav paths. export_r emits these as R factor levels.
        assert support.scale_values == "[0, 1, 2, 3]"

        by_text = {
            v.value_text: v.value_numeric
            for v in db.query(DatasetValue).filter_by(column_id=support.id)
        }
        assert by_text == {"None": 0.0, "A little": 1.0, "Some": 2.0, "A lot": 3.0}

    def test_five_point_scale_keeps_neutral(self, db_session, sav_bytes):
        """MM's matcher would have dropped 'Neutral' and nulled its value_numeric."""
        from app.models.dataset import DatasetColumn, DatasetValue

        db = db_session
        self._import(db, sav_bytes, 991)

        sat = db.query(DatasetColumn).filter_by(column_name="satisfied").one()
        assert sat.scale_points == 5
        neutral = (
            db.query(DatasetValue)
            .filter_by(column_id=sat.id, value_text="Neutral")
            .one()
        )
        assert neutral.value_numeric == 3.0

    def test_primary_scale_map_recode_carries_the_spss_codes(self, db_session, sav_bytes):
        """value_numeric has a SECOND owner: the auto-created primary scale_map
        RecodeDefinition, which `append_import` and the recode workbench re-apply.
        If it disagrees with the import, the first append silently rewrites every
        value (0..3 -> 1..4). Found by mutation-testing the append path."""
        import json

        from app.models.dataset import DatasetColumn
        from app.models.recode import RecodeDefinition

        db = db_session
        self._import(db, sav_bytes, 993)

        support = db.query(DatasetColumn).filter_by(column_name="support").one()
        defn = (
            db.query(RecodeDefinition)
            .filter_by(column_id=support.id, is_primary=True)
            .one()
        )
        assert json.loads(defn.mapping) == {
            "None": 0, "A little": 1, "Some": 2, "A lot": 3,
        }

    def test_csv_ordinal_recode_keeps_positional_mapping(self, db_session):
        """The CSV path supplies no scale_values — mapping must stay 1..N."""
        import json

        from app.models.dataset import DatasetColumn
        from app.models.project import Project
        from app.models.recode import RecodeDefinition
        from app.services.dataset_import import import_dataset_csv

        db = db_session
        db.add(Project(id=994, name="CSV", user_id=1))
        db.flush()

        import_dataset_csv(
            db=db, project_id=994, name="CSV",
            column_configs=[{
                "column_index": 0, "column_type": "ordinal", "column_text": "q1",
                "column_name": "q1", "scale_labels": ["Poor", "Fair", "Good"],
            }],
            file_contents="q1\nPoor\nGood\n",
        )
        db.flush()

        col = db.query(DatasetColumn).filter_by(column_name="q1").one()
        defn = db.query(RecodeDefinition).filter_by(column_id=col.id).one()
        assert json.loads(defn.mapping) == {"Poor": 1, "Fair": 2, "Good": 3}
        assert col.scale_values == "[1, 2, 3]"  # string: ints, not 1.0/2.0/3.0

    def test_user_missing_row_stores_no_value(self, db_session, sav_bytes):
        """Row 3's 'Refused' blanked in the CSV, so no DatasetValue should exist."""
        from app.models.dataset import DatasetColumn, DatasetValue

        db = db_session
        self._import(db, sav_bytes, 992)

        sat = db.query(DatasetColumn).filter_by(column_name="satisfied").one()
        texts = [
            v.value_text for v in db.query(DatasetValue).filter_by(column_id=sat.id)
        ]
        assert "Refused" not in texts
        assert len(texts) == 3  # four rows, one user-missing


class TestAppendReusesTheStoredCodes:
    """An append into a .sav-imported ordinal column must encode identically.

    Otherwise the same label carries two different numbers inside one column —
    'None' = 0.0 from the import, 1.0 from the append — and every mean silently
    drifts. The append path reads scale_values off the stored column.
    """

    def test_append_encodes_with_the_columns_own_scale_values(self, db_session, sav_bytes):
        import asyncio
        import io as _io
        import json

        from starlette.datastructures import UploadFile as StarletteUploadFile

        from app.models.dataset import Dataset, DatasetColumn, DatasetValue
        from app.models.project import Project
        from app.models.user import User
        from app.routers.dataset import append_import
        from app.services.dataset_import import import_dataset_csv, preview_dataset_csv
        from app.services.sav_import import apply_sav_metadata

        db = db_session
        db.add(Project(id=995, name="SAV", user_id=1))
        db.flush()
        user = db.get(User, 1)

        text, meta = sav_to_csv_text(sav_bytes)
        preview = preview_dataset_csv(text)
        apply_sav_metadata(preview["columns"], meta)
        configs = [
            {
                "column_index": c["column_index"],
                "column_type": c["suggested_type"],
                "column_text": c["suggested_column_text"],
                "column_name": c.get("suggested_column_name"),
                "scale_labels": c.get("suggested_scale_labels"),
                "scale_values": c.get("suggested_scale_values"),
            }
            for c in preview["columns"]
        ]
        import_dataset_csv(
            db=db, project_id=995, name="SPSS", column_configs=configs, file_contents=text,
        )
        db.flush()

        ds = db.query(Dataset).filter_by(project_id=995).one()
        support = db.query(DatasetColumn).filter_by(column_name="support").one()
        assert json.loads(support.scale_values) == [0.0, 1.0, 2.0, 3.0]

        pre_existing = {
            v.id for v in db.query(DatasetValue).filter_by(column_id=support.id)
        }

        # Append a plain CSV row whose value is the ZERO-coded label. skip_duplicates
        # must be off: every `support` label already appears in the fixture, so the
        # default dedup would drop the row and the assertion below would silently
        # read the ORIGINAL import's value instead of the appended one.
        csv_bytes = b"support\nNone\n"
        upload = StarletteUploadFile(filename="more.csv", file=_io.BytesIO(csv_bytes))
        config = json.dumps(
            {
                "column_mapping": [{"csv_column_index": 0, "column_id": support.id}],
                "skip_duplicates": False,
            }
        )
        resp = asyncio.run(
            append_import(
                project_id=995, dataset_id=ds.id, file=upload, import_config=config,
                encoding="utf-8", user=user, db=db,
            )
        )
        db.flush()
        assert resp.rows_created == 1, "the append must actually create a row"

        appended = [
            v
            for v in db.query(DatasetValue).filter_by(column_id=support.id)
            if v.id not in pre_existing
        ]
        assert len(appended) == 1
        assert appended[0].value_text == "None"
        assert appended[0].value_numeric == 0.0, (
            "append must reuse the column's SPSS codes, not re-derive positional 1..N"
        )


class TestDuplicateValueLabels:
    """#541a — two codes sharing one label string (legal in SPSS, usually a
    copy-paste typo) must stay distinguishable. The CSV carries label TEXT as
    the cell value, so without disambiguation the label→numeric map collapses
    last-wins and rows silently swap codes."""

    def test_duplicated_labels_gain_code_suffixes(self, edge_converted):
        _, meta = edge_converted
        m = meta["flavor"]
        assert m.ordered_labels == ["Agree (1)", "Agree (2)", "Neutral", "Disagree"]
        assert m.ordered_values == [1.0, 2.0, 3.0, 4.0]
        # the invariant every label→value map downstream depends on
        assert len(set(m.ordered_labels)) == len(m.ordered_labels)

    def test_cell_text_matches_the_deduped_scale(self, edge_converted):
        rows, _ = edge_converted
        assert _col(rows, "flavor") == [
            "Agree (1)", "Agree (2)", "Neutral", "Disagree", "Agree (1)", "Agree (2)",
        ]

    def test_unique_labels_pass_through_unchanged(self, converted):
        """De-dup must be a no-op for the normal fully-distinct label map."""
        _, meta = converted
        assert meta["satisfied"].ordered_labels == [
            "Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree",
        ]

    def test_dedupe_suffix_collision_falls_back_to_suffixing_all(self):
        """Degenerate input: a literal label already occupies the suffixed name."""
        from app.services.sav_import import _dedupe_labels

        labels = {1.0: "Agree", 2.0: "Agree", 3.0: "Agree (1)"}
        deduped = _dedupe_labels(labels)
        assert len({str(v) for v in deduped.values()}) == len(deduped)


class TestStringUserMissing:
    """#541b — declared discrete missing VALUES on string variables (pyreadstat
    reports them as lo==hi string dicts) import as missing, not as data."""

    def test_string_missing_values_blank(self, edge_converted):
        rows, _ = edge_converted
        assert _col(rows, "region") == ["North", "South", "", "East", "", "West"]

    def test_in_missing_range_type_guards(self):
        str_ranges = [{"lo": "XX", "hi": "XX"}, {"lo": "SKIP", "hi": "SKIP"}]
        assert _in_missing_range("XX", str_ranges)
        assert _in_missing_range("SKIP", str_ranges)
        assert not _in_missing_range("North", str_ranges)
        # a numeric cell never matches a string range, and vice versa —
        # type-guarded on BOTH sides (mixed compare would raise in py3)
        assert not _in_missing_range(5, str_ranges)
        assert not _in_missing_range("9", [{"lo": 1, "hi": 9}])


def test_adapter_never_imports_pandas(tmp_path):
    """pandas is an installed statsmodels transitive; importing it costs tens of MB
    of RSS against a <256 MB target. pyreadstat's DEFAULT output_format is a
    DataFrame, so an omitted `output_format="dict"` on EITHER read silently pulls
    it in. Run in a subprocess — sys.modules is polluted by the rest of the suite.
    """
    script = f"""
import sys
from app.services.sav_import import sav_to_csv_text
sav_to_csv_text(open({str(FIXTURE)!r}, "rb").read())
assert "pandas" not in sys.modules, "pandas was imported by the .sav adapter"
print("clean")
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parent.parent,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "clean" in result.stdout
