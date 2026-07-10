"""#414 slab 2 — the participant-linking service + the import hook.

`services/participant_linking.py::link_rows_by_identifier_column` is the ONE
place the match/create/trim/N-A/duplicate/conflict rules live (DEC-10) —
dataset import, append, and the retro link-by-column endpoint all call it.
These tests pin the scoping doc §3 semantics:

- match key = Participant.identifier, trim-then-exact, case-SENSITIVE (DEC-2)
- no match → create Participant(identifier=value, display_name=None) (DEC-3)
- duplicated values link NOTHING (DEC-4 — never pick an arbitrary row)
- blank / N-A / absent → skipped_missing (DEC-5)
- existing participant already linked in this dataset → skipped_conflict
- already-linked rows are never touched
- import hook: `participant_link_column_index` (index 0 is VALID — falsy-zero)
"""
import asyncio
import io
import json

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import append_import, append_preview, import_dataset, link_by_column
from app.schemas.dataset import LinkByColumnRequest
from app.services.dataset_import import import_dataset_csv
from app.services.participant_linking import link_rows_by_identifier_column


PROJECT_ID = 700


def _project(db) -> Project:
    project = Project(id=PROJECT_ID, name="Link Test", user_id=1)
    db.add(project)
    db.flush()
    return project


def _dataset_with_identifier(db, values: list[str | None], name: str = "Survey"):
    """Dataset + identifier column + one row per entry (None = no stored value)."""
    ds = Dataset(project_id=PROJECT_ID, name=name)
    db.add(ds)
    db.flush()
    id_col = DatasetColumn(
        dataset_id=ds.id,
        column_text="participant_id",
        column_type=ColumnType.IDENTIFIER,
        sequence_order=0,
    )
    db.add(id_col)
    db.flush()
    rows = []
    for i, value in enumerate(values):
        row = DatasetRow(
            dataset_id=ds.id, participant_id=None, row_identifier=f"R{i + 1:03d}",
        )
        db.add(row)
        db.flush()
        if value is not None:
            db.add(DatasetValue(row_id=row.id, column_id=id_col.id, value_text=value))
        rows.append(row)
    db.flush()
    return ds, id_col, rows


def _link(db, ds, col, **kw) -> dict:
    return link_rows_by_identifier_column(
        db, project_id=PROJECT_ID, dataset_id=ds.id, column_id=col.id, **kw,
    )


# ── Service semantics ──────────────────────────────────────────────────────────

def test_creates_participants_with_trimmed_identifier_and_no_display_name(db_session):
    db = db_session
    _project(db)
    ds, col, rows = _dataset_with_identifier(db, ["  P001  ", "P002"])
    report = _link(db, ds, col)

    assert report["linked"] == 2 and report["created"] == 2 and report["matched"] == 0
    participants = db.query(Participant).filter(Participant.project_id == PROJECT_ID).all()
    assert sorted(p.identifier for p in participants) == ["P001", "P002"]  # trimmed
    assert all(p.display_name is None for p in participants)  # DEC-3: a code is not a name
    assert all(p.uuid for p in participants)  # J3-2 merge identity stamped
    linked_ids = {r.participant_id for r in rows}
    assert None not in linked_ids and len(linked_ids) == 2


def test_matches_existing_participant_case_sensitively(db_session):
    db = db_session
    _project(db)
    existing = Participant(project_id=PROJECT_ID, identifier="P001", display_name="Maria")
    lower = Participant(project_id=PROJECT_ID, identifier="p002")
    db.add_all([existing, lower])
    db.flush()

    ds, col, rows = _dataset_with_identifier(db, ["P001", "P002"])
    report = _link(db, ds, col)

    # P001 matches (keeps its display_name); P002 ≠ p002 → creates a new one
    assert report["matched"] == 1 and report["created"] == 1
    assert rows[0].participant_id == existing.id
    assert existing.display_name == "Maria"
    assert rows[1].participant_id not in (existing.id, lower.id)


def test_blank_na_and_absent_values_skip_linking(db_session):
    db = db_session
    _project(db)
    # absent value / whitespace-only / recognized-N/A / refusal label
    ds, col, rows = _dataset_with_identifier(db, [None, "   ", "N/A", "Prefer not to say", "P010"])
    report = _link(db, ds, col)

    assert report["skipped_missing"] == 4
    assert report["linked"] == 1 and report["created"] == 1
    assert db.query(Participant).filter(Participant.project_id == PROJECT_ID).count() == 1


def test_duplicate_values_link_nothing(db_session):
    db = db_session
    _project(db)
    ds, col, rows = _dataset_with_identifier(db, ["P007", "P007", "P007", "P010"])
    report = _link(db, ds, col)

    assert report["skipped_duplicate"] == 3  # DEC-4: ALL P007 rows skipped
    assert report["duplicate_values"] == ["P007"]
    assert report["linked"] == 1
    assert rows[0].participant_id is None and rows[1].participant_id is None
    assert rows[3].participant_id is not None
    # No participant was created for the ambiguous value
    idents = {p.identifier for p in db.query(Participant).filter(Participant.project_id == PROJECT_ID)}
    assert idents == {"P010"}


def test_participant_already_linked_elsewhere_in_dataset_is_conflict(db_session):
    db = db_session
    _project(db)
    ds, col, rows = _dataset_with_identifier(db, ["P001"])
    taken = Participant(project_id=PROJECT_ID, identifier="P001")
    db.add(taken)
    db.flush()
    # P001's participant is already linked to a DIFFERENT row of this dataset
    other = DatasetRow(dataset_id=ds.id, participant_id=taken.id, row_identifier="R999")
    db.add(other)
    db.flush()

    report = _link(db, ds, col)
    assert report["skipped_conflict"] == 1 and report["linked"] == 0
    assert rows[0].participant_id is None


def test_already_linked_rows_are_never_touched(db_session):
    db = db_session
    _project(db)
    manual = Participant(project_id=PROJECT_ID, identifier="Maria Lopez")
    db.add(manual)
    db.flush()
    ds, col, rows = _dataset_with_identifier(db, ["P001", "P002"])
    rows[0].participant_id = manual.id  # a manual link is user intent
    db.flush()

    report = _link(db, ds, col)
    assert report["already_linked"] == 1
    assert rows[0].participant_id == manual.id  # untouched despite value "P001"
    assert report["linked"] == 1  # only the unlinked row


def test_role_auto_fills_from_demographic_role_column(db_session):
    db = db_session
    _project(db)
    ds, col, rows = _dataset_with_identifier(db, ["P001"])
    role_col = DatasetColumn(
        dataset_id=ds.id,
        column_text="Role",
        column_type=ColumnType.DEMOGRAPHIC,
        demographic_subtype="role",
        sequence_order=1,
    )
    db.add(role_col)
    db.flush()
    db.add(DatasetValue(row_id=rows[0].id, column_id=role_col.id, value_text="Teacher"))
    db.flush()

    _link(db, ds, col)
    participant = db.query(Participant).filter_by(project_id=PROJECT_ID, identifier="P001").one()
    assert participant.role == "Teacher"
    assert participant.role_auto_filled_from  # provenance stamped


def test_non_identifier_column_is_rejected(db_session):
    db = db_session
    _project(db)
    ds, col, rows = _dataset_with_identifier(db, ["P001"])
    text_col = DatasetColumn(
        dataset_id=ds.id, column_text="Comment",
        column_type=ColumnType.OPEN_TEXT, sequence_order=1,
    )
    db.add(text_col)
    db.flush()

    with pytest.raises(ValueError, match="identifier"):
        _link(db, ds, text_col)


def test_row_ids_scope_limits_candidates(db_session):
    db = db_session
    _project(db)
    ds, col, rows = _dataset_with_identifier(db, ["P001", "P002"])
    report = _link(db, ds, col, row_ids=[rows[0].id])

    assert report["linked"] == 1
    assert rows[0].participant_id is not None
    assert rows[1].participant_id is None  # out of scope, untouched


# ── Import hook ────────────────────────────────────────────────────────────────

CSV = "participant_id,score\nP001,15\nP002,27\nP003,31\n"
CONFIGS = [
    {"column_index": 0, "column_type": "identifier", "column_text": "participant_id"},
    {"column_index": 1, "column_type": "numeric", "column_text": "score"},
]


def test_import_links_by_identifier_column_index_zero(db_session):
    """Index 0 exercised deliberately — the falsy-zero trap (`is not None`)."""
    db = db_session
    _project(db)
    result = import_dataset_csv(
        db=db, project_id=PROJECT_ID, name="Wave 1",
        column_configs=CONFIGS, file_contents=CSV,
        participant_link_column_index=0,
    )
    report = result["participant_link_report"]
    assert report["created"] == 3 and report["linked"] == 3
    rows = db.query(DatasetRow).filter_by(dataset_id=result["dataset_id"]).all()
    assert all(r.participant_id is not None for r in rows)


def test_import_without_link_index_does_not_link(db_session):
    db = db_session
    _project(db)
    result = import_dataset_csv(
        db=db, project_id=PROJECT_ID, name="Wave 1",
        column_configs=CONFIGS, file_contents=CSV,
    )
    assert result["participant_link_report"] is None
    assert db.query(Participant).filter_by(project_id=PROJECT_ID).count() == 0


def test_import_rejects_non_identifier_or_skipped_link_column(db_session):
    """The router turns these ValueErrors into 400s (and rolls back); here we
    only pin that the service refuses BEFORE any linking runs."""
    db = db_session
    _project(db)
    with pytest.raises(ValueError, match="identifier column"):
        import_dataset_csv(
            db=db, project_id=PROJECT_ID, name="Bad",
            column_configs=CONFIGS, file_contents=CSV,
            participant_link_column_index=1,  # numeric column
        )
    with pytest.raises(ValueError, match="identifier column"):
        import_dataset_csv(
            db=db, project_id=PROJECT_ID, name="Bad2",
            column_configs=CONFIGS, file_contents=CSV,
            participant_link_column_index=5,  # no such column
        )
    assert db.query(Participant).filter_by(project_id=PROJECT_ID).count() == 0


def test_import_endpoint_carries_link_report_on_the_wire(db_session):
    """Response-layer check (wire-format lesson): the report rides the
    DatasetImportResponse, and stays None when linking wasn't requested."""
    db = db_session
    _project(db)
    user = db.get(User, 1)

    config = {
        "name": "Wire Wave",
        "column_configs": CONFIGS,
        "participant_link_column_index": 0,
    }
    upload = StarletteUploadFile(filename="wave.csv", file=io.BytesIO(CSV.encode()))
    resp = asyncio.run(import_dataset(
        project_id=PROJECT_ID, file=upload, import_config=json.dumps(config),
        encoding="utf-8", user=user, db=db,
    ))
    assert resp.participant_link_report is not None
    assert resp.participant_link_report.created == 3
    assert resp.participant_link_report.skipped_duplicate == 0

    config2 = {"name": "Wire Wave 2", "column_configs": CONFIGS}
    upload2 = StarletteUploadFile(filename="wave2.csv", file=io.BytesIO(CSV.encode()))
    resp2 = asyncio.run(import_dataset(
        project_id=PROJECT_ID, file=upload2, import_config=json.dumps(config2),
        encoding="utf-8", user=user, db=db,
    ))
    assert resp2.participant_link_report is None


# ── Append (DEC-7) ─────────────────────────────────────────────────────────────

def _score_column(db, ds, seq: int = 1) -> DatasetColumn:
    col = DatasetColumn(
        dataset_id=ds.id, column_text="score",
        column_type=ColumnType.NUMERIC, sequence_order=seq,
    )
    db.add(col)
    db.flush()
    return col


def _upload(csv_text: str, name: str = "more.csv") -> StarletteUploadFile:
    return StarletteUploadFile(filename=name, file=io.BytesIO(csv_text.encode()))


def test_append_preview_offers_link_column_when_matched(db_session):
    db = db_session
    _project(db)
    user = db.get(User, 1)
    ds, id_col, _ = _dataset_with_identifier(db, ["P001"])
    _score_column(db, ds)

    resp = asyncio.run(append_preview(
        project_id=PROJECT_ID, dataset_id=ds.id,
        file=_upload("participant_id,score\nP004,42\n"),
        encoding="utf-8", sheet_name=None, user=user, db=db,
    ))
    assert resp.participant_link_column is not None
    assert resp.participant_link_column.column_id == id_col.id

    # File without the identifier column → no offer (new rows would carry
    # no identifier values).
    resp2 = asyncio.run(append_preview(
        project_id=PROJECT_ID, dataset_id=ds.id,
        file=_upload("score\n42\n"),
        encoding="utf-8", sheet_name=None, user=user, db=db,
    ))
    assert resp2.participant_link_column is None


def test_append_import_links_new_rows_with_conflict_semantics(db_session):
    db = db_session
    _project(db)
    user = db.get(User, 1)
    ds, id_col, rows = _dataset_with_identifier(db, ["P001"])
    score_col = _score_column(db, ds)
    _link(db, ds, id_col)  # P001 participant now exists AND is linked
    db.commit()

    # Appended P001 row → its participant is already linked to the original
    # row → skipped_conflict. P004 → created + linked. (The score column keeps
    # the P001 row from fingerprint-deduping against the original.)
    config = {
        "column_mapping": [
            {"csv_column_index": 0, "column_id": id_col.id},
            {"csv_column_index": 1, "column_id": score_col.id},
        ],
        "participant_link_column_id": id_col.id,
    }
    resp = asyncio.run(append_import(
        project_id=PROJECT_ID, dataset_id=ds.id,
        file=_upload("participant_id,score\nP001,42\nP004,17\n"),
        import_config=json.dumps(config), encoding="utf-8", user=user, db=db,
    ))
    report = resp.participant_link_report
    assert report is not None
    assert report.created == 1 and report.skipped_conflict == 1
    assert report.linked == 1

    idents = {p.identifier for p in db.query(Participant).filter_by(project_id=PROJECT_ID)}
    assert idents == {"P001", "P004"}


def test_append_import_without_link_column_does_not_link(db_session):
    db = db_session
    _project(db)
    user = db.get(User, 1)
    ds, id_col, _ = _dataset_with_identifier(db, ["P001"])
    db.commit()

    config = {"column_mapping": [{"csv_column_index": 0, "column_id": id_col.id}]}
    resp = asyncio.run(append_import(
        project_id=PROJECT_ID, dataset_id=ds.id,
        file=_upload("participant_id\nP004\n"),
        import_config=json.dumps(config), encoding="utf-8", user=user, db=db,
    ))
    assert resp.participant_link_report is None
    assert db.query(Participant).filter_by(project_id=PROJECT_ID).count() == 0


def test_append_import_rejects_non_identifier_link_column(db_session):
    db = db_session
    _project(db)
    user = db.get(User, 1)
    ds, id_col, _ = _dataset_with_identifier(db, ["P001"])
    score_col = _score_column(db, ds)
    db.commit()

    config = {
        "column_mapping": [{"csv_column_index": 0, "column_id": id_col.id}],
        "participant_link_column_id": score_col.id,
    }
    with pytest.raises(HTTPException) as exc:
        asyncio.run(append_import(
            project_id=PROJECT_ID, dataset_id=ds.id,
            file=_upload("participant_id\nP004\n"),
            import_config=json.dumps(config), encoding="utf-8", user=user, db=db,
        ))
    assert exc.value.status_code == 400


# ── Retro link-by-column endpoint (DEC-8) ──────────────────────────────────────

def test_link_by_column_endpoint_links_only_unlinked_rows(db_session):
    db = db_session
    _project(db)
    user = db.get(User, 1)
    manual = Participant(project_id=PROJECT_ID, identifier="Maria Lopez")
    db.add(manual)
    db.flush()
    ds, id_col, rows = _dataset_with_identifier(db, ["P001", "P002"])
    rows[1].participant_id = manual.id  # pre-existing manual link
    db.flush()

    resp = asyncio.run(link_by_column(
        project_id=PROJECT_ID, dataset_id=ds.id,
        payload=LinkByColumnRequest(column_id=id_col.id), user=user, db=db,
    ))
    assert resp.linked == 1 and resp.created == 1
    assert resp.already_linked == 1
    assert rows[1].participant_id == manual.id  # manual link never overwritten
    assert rows[0].participant_id is not None


def test_link_by_column_endpoint_rejects_non_identifier(db_session):
    db = db_session
    _project(db)
    user = db.get(User, 1)
    ds, id_col, _ = _dataset_with_identifier(db, ["P001"])
    score_col = _score_column(db, ds)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(link_by_column(
            project_id=PROJECT_ID, dataset_id=ds.id,
            payload=LinkByColumnRequest(column_id=score_col.id), user=user, db=db,
        ))
    assert exc.value.status_code == 400


# ── Portability (DEC-11) ───────────────────────────────────────────────────────

def test_identifier_column_and_links_roundtrip_mmproject(db_session, tmp_path):
    """The identifier type + auto-created participants survive .mmproject
    export → import-as-new: column_type rides reflection as its value string,
    DatasetRow.participant_id remaps to the NEW project's participants, and
    participant uuids are FRESH-stamped (the unique-index collision trap).
    The manifest must carry format version 2 — an older build must refuse the
    file at the gate instead of crashing on ColumnType("identifier")."""
    import zipfile
    from pathlib import Path

    from app.services.project_portability import (
        CURRENT_FORMAT_VERSION,
        export_project,
        import_project,
    )

    db = db_session
    _project(db)
    ds, id_col, rows = _dataset_with_identifier(db, ["P001", "P002"])
    _link(db, ds, id_col)
    db.flush()

    buf = export_project(db, PROJECT_ID, Path("/nonexistent"))
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    assert manifest["format_version"] == CURRENT_FORMAT_VERSION == 2

    mm = tmp_path / "roundtrip.mmproject"
    mm.write_bytes(buf.getvalue())
    new_id, _ = import_project(db, mm, tmp_path / "docs", user_id=1)
    db.flush()

    new_ds = db.query(Dataset).filter_by(project_id=new_id).one()
    new_col = db.query(DatasetColumn).filter_by(dataset_id=new_ds.id).filter(
        DatasetColumn.column_type == ColumnType.IDENTIFIER
    ).one()
    assert new_col.column_type == ColumnType.IDENTIFIER

    new_rows = db.query(DatasetRow).filter_by(dataset_id=new_ds.id).all()
    assert new_rows and all(r.participant_id is not None for r in new_rows)
    linked_projects = {
        db.get(Participant, r.participant_id).project_id for r in new_rows
    }
    assert linked_projects == {new_id}  # remapped, not pointing at the source

    old_uuids = {p.uuid for p in db.query(Participant).filter_by(project_id=PROJECT_ID)}
    new_uuids = {p.uuid for p in db.query(Participant).filter_by(project_id=new_id)}
    assert old_uuids.isdisjoint(new_uuids)  # import-as-new fresh-stamps
