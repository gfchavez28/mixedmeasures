"""Queue row 47 — authoring a dataset by hand, and adding a record to one.

Before this, a `Dataset` could only arrive from a FILE and a `DatasetRow` only
from the importer or the append wizard, while a manual COLUMN could already be
added by hand. The asymmetry was the tell: the tool let a researcher add a
variable but not a record.

The motivating case is a lookup table that exists nowhere as a file — ten
departments and three columns, currently built in Excel and imported.
"""

import asyncio

import pytest
from fastapi import HTTPException

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import (
    create_dataset,
    create_manual_column,
    create_row,
    delete_dataset,
    get_dataset_data,
    list_columns,
    list_datasets,
    update_value,
)
from app.schemas.dataset import (
    DatasetCreate,
    DatasetUpdate,
    ManualColumnCreate,
    ValueUpdate,
)
from app.services.dataset_rows import (
    format_record_identifier,
    next_record_number,
    parse_record_identifier,
)
from app.services.participant_dataset import create_participant_dataset


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=1, name="Northgate", user_id=1))
    db.flush()
    db.commit()
    return db


def _user(db):
    return db.query(User).filter(User.id == 1).one()


def _make(db, name="Departments"):
    return _run(create_dataset(
        project_id=1, req=DatasetCreate(name=name), user=_user(db), db=db,
    ))


class TestCreatingABlankDataset:
    def test_it_is_born_with_no_columns_and_no_rows(self, project):
        """The decision: an empty table guesses nothing. A seeded identifier
        column would claim `ColumnType.IDENTIFIER`'s participant-linking
        semantics (#414) that a department lookup does not want."""
        resp = _make(project)
        assert resp.column_count == 0
        assert resp.row_count == 0
        assert project.query(DatasetColumn).filter(
            DatasetColumn.dataset_id == resp.id).count() == 0

    def test_it_is_an_ORDINARY_dataset_not_a_managed_one(self, project):
        """🔴 Row 47 must NOT inherit the participant table's refusals — it is
        `managed_kind` NULL, so it keeps every affordance."""
        resp = _make(project)
        assert resp.managed_kind is None
        ds = project.get(Dataset, resp.id)
        assert ds.managed_kind is None
        # The clearest proof that it kept them: delete is allowed.
        _run(delete_dataset(project_id=1, dataset_id=resp.id,
                            user=_user(project), db=project))
        assert project.get(Dataset, resp.id) is None

    def test_source_stays_null_because_nothing_was_imported(self, project):
        """`Dataset.source` is import PROVENANCE ("Qualtrics"), a different
        column from `DatasetColumn.source`."""
        assert _make(project).source is None

    def test_the_name_is_trimmed(self, project):
        resp = _run(create_dataset(
            project_id=1, req=DatasetCreate(name="  Sites  "),
            user=_user(project), db=project,
        ))
        assert resp.name == "Sites"

    def test_it_appears_in_the_dataset_list(self, project):
        _make(project)
        listing = _run(list_datasets(project_id=1, user=_user(project), db=project))
        assert [d.name for d in listing.datasets] == ["Departments"]
        assert listing.datasets[0].row_count == 0

    def test_a_blank_name_is_refused(self, project):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            DatasetCreate(name="")


class TestAnEmptyDatasetIsSafeToREAD:
    """🔴 Nothing in this codebase had ever seen a dataset with zero columns —
    every one arrived from a file with at least one. These are the surfaces a
    researcher reaches immediately after creating one."""

    def test_the_data_grid_endpoint_returns_an_empty_page(self, project):
        ds = _make(project)
        data = _run(get_dataset_data(
            project_id=1, dataset_id=ds.id, user=_user(project), db=project,
        ))
        assert data.rows == []
        assert data.columns == []
        assert data.total_rows == 0
        assert data.dataset.column_count == 0

    def test_the_columns_endpoint_returns_an_empty_list(self, project):
        ds = _make(project)
        assert _run(list_columns(
            project_id=1, dataset_id=ds.id, user=_user(project), db=project,
        )) == []


class TestAddingARecord:
    def test_it_creates_one_row_and_says_where_it_lands(self, project):
        ds = _make(project)
        created = _run(create_row(
            project_id=1, dataset_id=ds.id, user=_user(project), db=project,
        ))
        assert created.row_identifier == "R0001"
        assert created.index == 0
        assert created.offset == 0
        assert created.total_rows == 1
        assert project.query(DatasetRow).filter(
            DatasetRow.dataset_id == ds.id).count() == 1

    def test_records_are_numbered_in_sequence(self, project):
        ds = _make(project)
        ids = [
            _run(create_row(project_id=1, dataset_id=ds.id,
                            user=_user(project), db=project)).row_identifier
            for _ in range(3)
        ]
        assert ids == ["R0001", "R0002", "R0003"]

    def test_both_batch_fields_stay_NULL(self, project):
        """🔴 `submitted_at = now()` would sort a hand-added record BEFORE every
        undated imported one (`submitted_at ASC NULLS LAST`), silently
        reordering the grid and every `?row=` deep link. `import_batch` stays
        NULL because the record came from no batch — a "manual" sentinel there
        would be written by one path and read by none (#895's shape)."""
        ds = _make(project)
        created = _run(create_row(project_id=1, dataset_id=ds.id,
                                  user=_user(project), db=project))
        row = project.get(DatasetRow, created.row_id)
        assert row.submitted_at is None
        assert row.import_batch is None
        assert row.participant_id is None

    def test_a_new_record_sorts_LAST_even_beside_dated_imports(self, project):
        """The consequence of the rule above, asserted on the ordering itself.

        ⚠️ **The fixture MUST mix dated and undated rows.** A dated-only one is
        degenerate on this axis and passes under the defect: `now()` is later
        than any plausible import date, so a stamped record still lands last
        among dated rows. It is the UNDATED rows that expose it — `NULLS LAST`
        sorts them after every dated one, so a stamped record jumps ahead of
        them into the middle of the grid. (Proven: the first draft of this test
        used two dated rows and survived the mutant.)
        """
        from datetime import datetime
        ds = _make(project)
        project.add(DatasetRow(dataset_id=ds.id, row_identifier="R0001",
                               submitted_at=datetime(2026, 1, 1)))
        project.add(DatasetRow(dataset_id=ds.id, row_identifier="R0002",
                               submitted_at=datetime(2026, 6, 1)))
        project.add(DatasetRow(dataset_id=ds.id, row_identifier="R0003"))
        project.add(DatasetRow(dataset_id=ds.id, row_identifier="R0004"))
        project.flush()
        project.commit()

        created = _run(create_row(project_id=1, dataset_id=ds.id,
                                  user=_user(project), db=project))
        assert created.index == 4, (
            "the hand-added record must sort LAST — a stamped `submitted_at` "
            "would put it ahead of every undated imported row"
        )

    def test_the_record_is_TYPEABLE_the_moment_it_exists(self, project):
        """#897 from the other side: the record is useless without a cell for
        each hand-editable column, because the only cell writer is addressed by
        an existing `DatasetValue.id`."""
        ds = _make(project)
        _run(create_manual_column(
            project_id=1, dataset_id=ds.id,
            req=ManualColumnCreate(column_text="Department", column_type="open_text"),
            user=_user(project), db=project,
        ))
        column = project.query(DatasetColumn).filter(
            DatasetColumn.dataset_id == ds.id).one()

        created = _run(create_row(project_id=1, dataset_id=ds.id,
                                  user=_user(project), db=project))
        cell = project.query(DatasetValue).filter(
            DatasetValue.row_id == created.row_id,
            DatasetValue.column_id == column.id,
        ).first()
        assert cell is not None, "the new record has no cell to type into (#897)"

        saved = _run(update_value(
            project_id=1, dataset_id=ds.id, value_id=cell.id,
            req=ValueUpdate(value_text="Cardiology"),
            user=_user(project), db=project,
        ))
        assert saved.value_text == "Cardiology"

    def test_the_offset_is_the_page_the_grid_should_request(self, project):
        """A record does not land where the researcher is looking: with 250
        existing rows the new one is on page 2."""
        ds = _make(project)
        for i in range(250):
            project.add(DatasetRow(dataset_id=ds.id,
                                   row_identifier=format_record_identifier(i + 1, 4)))
        project.flush()
        project.commit()

        created = _run(create_row(project_id=1, dataset_id=ds.id, limit=200,
                                  user=_user(project), db=project))
        assert created.index == 250
        assert created.offset == 200
        assert created.limit == 200

    def test_it_is_refused_on_the_participant_table(self, project):
        """The fifth managed action. This endpoint's PATH matches the row-set
        route scan, so it could not ship without answering the predicate."""
        db = project
        db.add(Participant(project_id=1, identifier="E-01"))
        db.flush()
        managed = create_participant_dataset(db, 1)
        db.commit()

        with pytest.raises(HTTPException) as exc:
            _run(create_row(project_id=1, dataset_id=managed.id,
                            user=_user(db), db=db))
        assert exc.value.status_code == 409
        assert "Participants page" in exc.value.detail
        assert db.query(DatasetRow).filter(
            DatasetRow.dataset_id == managed.id).count() == 1, "no row was added"

    def test_another_users_project_is_a_404(self, project):
        db = project
        db.add(User(id=2, username="other", password_hash="x"))
        db.flush()
        db.add(Project(id=2, name="Theirs", user_id=2))
        db.flush()
        mine = _make(db)
        db.commit()
        with pytest.raises(HTTPException) as exc:
            _run(create_row(project_id=2, dataset_id=mine.id,
                            user=_user(db), db=db))
        assert exc.value.status_code == 404


class TestTheRecordIdentifierDerivation:
    """ONE derivation, shared with the append wizard (#542b's lesson)."""

    def test_it_follows_the_width_of_the_largest_existing_number(self, project):
        ds = _make(project)
        for rid in ("R001", "R002", "R120"):
            project.add(DatasetRow(dataset_id=ds.id, row_identifier=rid))
        project.flush()
        assert next_record_number(project, ds.id) == (121, 3)

    def test_identifiers_it_cannot_parse_are_skipped_not_an_error(self, project):
        """An imported dataset may identify records by a respondent code, and
        the participant table uses the participant's own identifier."""
        ds = _make(project)
        for rid in ("resp-77", "E-01", None):
            project.add(DatasetRow(dataset_id=ds.id, row_identifier=rid))
        project.flush()
        assert next_record_number(project, ds.id) == (1, 4)
        assert parse_record_identifier("resp-77") is None
        assert parse_record_identifier(None) is None

    def test_the_next_identifier_follows_the_MAXIMUM_not_the_count(self, project):
        """The property the extraction exists to guarantee.

        ⚠️ **The fixture is GAPPED on purpose.** A contiguous `R0001…R0120`
        cannot tell the real derivation from a naive `count + 1` — both answer
        `R0121`. Proven: the first draft of this test used exactly that fixture
        and a planted `count + 1` survived it. With rows deleted (or an import
        that skipped numbers) the two diverge, which is also the state a real
        dataset reaches the first time a record is removed.
        """
        ds = _make(project)
        for rid in ("R0001", "R0002", "R0120"):
            project.add(DatasetRow(dataset_id=ds.id, row_identifier=rid))
        project.flush()
        project.commit()
        created = _run(create_row(project_id=1, dataset_id=ds.id,
                                  user=_user(project), db=project))
        assert created.row_identifier == "R0121", (
            "the next identifier must follow the largest existing number, not "
            "the row count — otherwise it collides with an existing record"
        )

    def test_a_reused_number_would_COLLIDE_with_a_live_record(self, project):
        """Why the rule above matters rather than being tidy: `count + 1` on a
        dataset that has ever had a record deleted re-issues an identifier that
        is still in use, and two records then answer to one name."""
        ds = _make(project)
        for rid in ("R0001", "R0002", "R0003"):
            project.add(DatasetRow(dataset_id=ds.id, row_identifier=rid))
        project.flush()
        project.query(DatasetRow).filter(
            DatasetRow.dataset_id == ds.id,
            DatasetRow.row_identifier == "R0002",
        ).delete(synchronize_session=False)
        project.flush()
        project.commit()

        created = _run(create_row(project_id=1, dataset_id=ds.id,
                                  user=_user(project), db=project))
        existing = {
            r.row_identifier for r in project.query(DatasetRow).filter(
                DatasetRow.dataset_id == ds.id, DatasetRow.id != created.row_id)
        }
        assert created.row_identifier == "R0004"
        assert created.row_identifier not in existing


# ── #925 — a name that is only whitespace ────────────────────────────────────
#
# `min_length=1` is a CONSTRAINT, evaluated on the RAW input before any
# after-validator, so `"   "` satisfies it. The router then stripped AFTER
# validation and stored `""`; the RENAME path stripped nowhere at all and stored
# the padding. Reachable by API or script only — the *Blank table* dialog trims
# and disables its submit button, which is why the UI never surfaced it.


class TestNameHygiene:
    def test_a_padded_name_is_trimmed_before_it_is_stored(self, project):
        ds = _make(project, name="  Departments  ")
        stored = project.query(Dataset).filter(Dataset.id == ds.id).one()
        assert stored.name == "Departments"

    @pytest.mark.parametrize("blank", ["", " ", "   ", "\t", "\n", " \t\n "])
    def test_a_whitespace_only_name_is_REFUSED_not_stored_empty(self, blank):
        """The point of the fix: before it, every value here but `""` validated
        and became an unnamed dataset in the researcher's list."""
        with pytest.raises(ValueError):
            DatasetCreate(name=blank)

    def test_the_message_names_the_field(self):
        with pytest.raises(ValueError, match="name cannot be blank"):
            DatasetCreate(name="  ")

    def test_a_blank_description_normalizes_to_None(self):
        """Absence and emptiness are one fact; two representations mean every
        reader needs `or None` and one of them forgets."""
        assert DatasetCreate(name="D", description="   ").description is None
        assert DatasetCreate(name="D", description="  hi ").description == "hi"

    def test_the_RENAME_path_carries_the_same_rule(self):
        """The sibling the entry did not name, and the worse half: `update_dataset`
        `setattr`s straight from the schema, so a padded rename stored the padding
        rather than being stripped to empty."""
        assert DatasetUpdate(name="  Sites  ").name == "Sites"
        with pytest.raises(ValueError, match="name cannot be blank"):
            DatasetUpdate(name=" ")

    def test_a_rename_is_still_OPTIONAL_on_the_update_schema(self):
        """Positive control: the validator must not turn an omitted name into a
        refusal — `DatasetUpdate` is used for description- and colour-only edits."""
        assert DatasetUpdate(description="notes").name is None
        assert DatasetUpdate(color="#aabbcc").name is None
