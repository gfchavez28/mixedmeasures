"""Row 45 (i) step 3 — the tool-maintained participant dataset.

Two halves, and both must be pinned or the design is only half true:

  * the SPINE is locked — the four refusals, and the sync that keeps the row set
    equal to the participant set;
  * the COLUMNS are open — a researcher can still add a variable and edit their
    own cell, which is the half a lock-only test suite would silently lose.

The load-bearing structural claim WAS that the tool's own columns need no new
guard because they carry `source = "managed"` and three endpoints already refuse
anything whose `source != "manual"`. `TestOpenColumns` asserts that half and it
still holds — **but it was never the whole population, and #926 is the other
half**: the four recode doors refuse `source == "computed"`, so a managed column
sailed through every one of them (measured live: a participant score column
retyped to `open_text` from the Data view, which persisted and survived a
refresh). `TestTheToolsOwnColumnsAreAlsoLocked` drives all five doors — the fifth
is `copy_to` — plus the positive control that keeps the fix from being widened
into one that refuses imported columns too.
"""

import ast
import json
import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

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
from app.models.recode import OutputType, RecodeDefinition, RecodeType
from app.routers.dataset import (
    append_preview,
    bulk_link_participants,
    delete_dataset,
    delete_manual_column,
    delete_row,
    link_by_column,
    link_participant,
    update_column_header,
    update_manual_column,
    update_value,
)
from app.routers.recode import (
    apply_value_labels_endpoint,
    bulk_type_update,
    copy_to,
    create_definition,
    set_missing_values,
)
from app.schemas.dataset import ColumnHeaderUpdate
from app.schemas.recode import (
    ApplyValueLabelsRequest,
    BulkTypeUpdateRequest,
    CopyToRequest,
    MissingValuesUpdate,
    RecodeDefinitionCreate,
    ValueLabelPair,
)
from app.services import participant_dataset as pd
from app.services.participant_dataset import (
    ACTION_APPEND,
    ACTION_DELETE_DATASET,
    ACTION_DELETE_ROW,
    ACTION_LINK_PARTICIPANTS,
    MANAGED_COLUMN_SOURCE,
    MANAGED_KIND_PARTICIPANTS,
    create_participant_dataset,
    get_participant_dataset,
    managed_dataset_refusal,
    sync_rows,
)


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project(db_session):
    db = db_session
    db.add(Project(id=1, name="PD audit", user_id=1))
    db.flush()
    for ident in ("E-01", "E-02", "E-03"):
        db.add(Participant(project_id=1, identifier=ident))
    db.flush()
    return db


def _user(db):
    return db.query(User).filter(User.id == 1).one()


def _identifiers(db, dataset):
    return sorted(
        r.row_identifier
        for r in db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id)
    )


class TestConstruction:
    def test_a_dataset_is_built_with_no_file(self, project):
        """🔴 The first `Dataset` constructed without an upload — until now
        `services/dataset_import.py` was the only constructor, which is why
        queue row 47 wants this path too."""
        dataset = create_participant_dataset(project, 1)
        assert dataset.managed_kind == MANAGED_KIND_PARTICIPANTS
        assert dataset.id is not None
        assert get_participant_dataset(project, 1) is dataset

    def test_it_starts_with_one_row_per_participant(self, project):
        dataset = create_participant_dataset(project, 1)
        assert _identifiers(project, dataset) == ["E-01", "E-02", "E-03"]

    def test_the_identifier_column_is_tool_owned_and_filled(self, project):
        dataset = create_participant_dataset(project, 1)
        column = (
            project.query(DatasetColumn)
            .filter(DatasetColumn.dataset_id == dataset.id).one()
        )
        assert column.column_type == ColumnType.IDENTIFIER
        assert column.source == MANAGED_COLUMN_SOURCE
        cells = sorted(
            v.value_text for v in project.query(DatasetValue).filter(
                DatasetValue.column_id == column.id)
        )
        assert cells == ["E-01", "E-02", "E-03"]

    def test_creating_twice_returns_the_same_dataset(self, project):
        first = create_participant_dataset(project, 1)
        assert create_participant_dataset(project, 1).id == first.id

    def test_a_second_one_is_refused_by_the_INDEX_not_by_a_service_check(self, project):
        """`uq_datasets_project_managed_kind` makes "at most one per project"
        structural, so a caller bypassing the service cannot create a twin."""
        from sqlalchemy.exc import IntegrityError
        create_participant_dataset(project, 1)
        project.add(Dataset(project_id=1, name="Twin",
                            managed_kind=MANAGED_KIND_PARTICIPANTS))
        with pytest.raises(IntegrityError):
            project.flush()
        project.rollback()

    def test_two_projects_may_each_have_one(self, project):
        """The index is partial and per project — not a global singleton."""
        project.add(Project(id=2, name="Other", user_id=1))
        project.flush()
        create_participant_dataset(project, 1)
        create_participant_dataset(project, 2)
        assert get_participant_dataset(project, 2) is not None

    def test_role_is_NOT_mirrored_into_a_column(self, project):
        """`_build_participant_group_map` reads `Participant.role` directly for
        `subtype == 'role'` and needs no dataset, so a column here would be a
        second source for one fact — free to disagree with the first."""
        project.query(Participant).filter(
            Participant.identifier == "E-01").one().role = "Clinical"
        project.flush()
        dataset = create_participant_dataset(project, 1)
        headings = [
            c.column_text for c in project.query(DatasetColumn).filter(
                DatasetColumn.dataset_id == dataset.id)
        ]
        assert headings == [pd.PARTICIPANT_IDENTIFIER_COLUMN]


class TestTheSyncReconciles:
    def test_a_new_participant_gets_a_row(self, project):
        dataset = create_participant_dataset(project, 1)
        project.add(Participant(project_id=1, identifier="E-04"))
        project.flush()
        report = sync_rows(project, dataset)
        assert (report.added, report.removed) == (1, 0)
        assert "E-04" in _identifiers(project, dataset)

    def test_a_deleted_participants_row_is_REAPED(self, project):
        """The withdrawal case. `withdrawal_redaction.py:299` deletes the
        participant outright and `DatasetRow.participant_id` is SET NULL, so
        without the reap the orphan row survives — and the refusals above make
        it permanently undeletable."""
        dataset = create_participant_dataset(project, 1)
        gone = project.query(Participant).filter(
            Participant.identifier == "E-02").one()
        project.delete(gone)
        project.flush()
        report = sync_rows(project, dataset)
        assert (report.added, report.removed) == (0, 1)
        assert _identifiers(project, dataset) == ["E-01", "E-03"]

    def test_an_already_orphaned_row_is_reaped(self, project):
        """Reached the other way: the FK nulled the link without the row going."""
        dataset = create_participant_dataset(project, 1)
        row = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == dataset.id).first()
        row.participant_id = None
        project.flush()
        assert sync_rows(project, dataset).removed == 1

    def test_an_edited_identifier_is_followed(self, project):
        """A participant's identifier is editable on the Participants page; the
        row label AND the cell follow it, or the table names people by a stale
        code."""
        dataset = create_participant_dataset(project, 1)
        project.query(Participant).filter(
            Participant.identifier == "E-01").one().identifier = "E-99"
        project.flush()
        report = sync_rows(project, dataset)
        assert report.relabelled == 1
        assert "E-99" in _identifiers(project, dataset)
        cells = {
            v.value_text for v in project.query(DatasetValue)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .filter(DatasetColumn.dataset_id == dataset.id)
        }
        assert "E-99" in cells and "E-01" not in cells

    def test_a_row_pointing_at_ANOTHER_projects_participant_is_reaped(self, project):
        """The reap's second arm. A deleted participant is caught by the first
        (the FK's SET NULL orphans the row), so this state needs a hand-edited
        database or a future bug — and the table must still hold only this
        project's people. The ORM version reaped it too (#1033 kept the rule)."""
        project.add(Project(id=2, name="Other", user_id=1))
        project.flush()
        stranger = Participant(project_id=2, identifier="X-01")
        project.add(stranger)
        project.flush()
        dataset = create_participant_dataset(project, 1)
        row = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == dataset.id).first()
        row.participant_id = stranger.id
        project.flush()
        report = sync_rows(project, dataset)
        assert report.removed == 1
        # …and the project's own participant gets a row back.
        assert report.added == 1

    def test_a_row_the_caller_already_HOLDS_reads_its_new_label(self, project):
        """#1033 made the sync set-based, so it writes AROUND the identity map.
        Under `autoflush=False` a held object — or a later query, which returns
        that same object — would keep the old label for the rest of the session
        unless the sync expires what it went around."""
        dataset = create_participant_dataset(project, 1)
        held = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == dataset.id,
            DatasetRow.row_identifier == "E-01",
        ).one()
        project.query(Participant).filter(
            Participant.identifier == "E-01").one().identifier = "E-99"
        project.flush()
        sync_rows(project, dataset)
        assert held.row_identifier == "E-99"

    def test_sync_is_idempotent(self, project):
        dataset = create_participant_dataset(project, 1)
        assert sync_rows(project, dataset).changed is False

    def test_it_refuses_a_dataset_it_does_not_maintain(self, project):
        """Fail closed: pointing the sync at an ordinary dataset would delete
        every row in it, since none has a participant."""
        ordinary = Dataset(project_id=1, name="Survey")
        project.add(ordinary)
        project.flush()
        with pytest.raises(ValueError, match="managed_kind"):
            sync_rows(project, ordinary)


class TestThePredicate:
    def test_an_ordinary_dataset_allows_everything(self, project):
        ordinary = Dataset(project_id=1, name="Survey")
        for action in pd.MANAGED_ACTIONS:
            assert managed_dataset_refusal(ordinary, action) is None

    def test_none_allows_everything(self):
        """Call sites ask unconditionally, so a missing dataset must not raise."""
        assert managed_dataset_refusal(None, ACTION_DELETE_ROW) is None

    def test_every_action_has_a_sentence_that_says_what_to_do_instead(self, project):
        dataset = create_participant_dataset(project, 1)
        for action in pd.MANAGED_ACTIONS:
            reason = managed_dataset_refusal(dataset, action)
            assert reason and len(reason) > 40, action
            # A refusal that only forbids teaches nothing.
            assert any(w in reason for w in ("can", "Import", "Remove", "add")), action

    def test_an_unknown_action_fails_closed(self, project):
        with pytest.raises(ValueError, match="unknown managed-dataset action"):
            managed_dataset_refusal(None, "rename")


class TestTheFourRefusalsAtTheDoor:
    """Each door, driven. A predicate nothing calls refuses nothing."""

    def _managed(self, db):
        return create_participant_dataset(db, 1)

    def test_deleting_the_dataset_is_refused(self, project):
        ds = self._managed(project)
        with pytest.raises(HTTPException) as exc:
            _run(delete_dataset(1, ds.id, _user(project), project))
        assert exc.value.status_code == 409
        assert "participants" in exc.value.detail.lower()

    def test_deleting_a_record_is_refused(self, project):
        ds = self._managed(project)
        row = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == ds.id).first()
        with pytest.raises(HTTPException) as exc:
            _run(delete_row(1, ds.id, row.id, _user(project), project))
        assert exc.value.status_code == 409

    def test_relinking_a_row_is_refused(self, project):
        """Not one of the four the decision NAMED — found by enumerating the
        router. Re-pointing a managed row at another participant breaks the
        one-row-per-person invariant the whole design rests on."""
        ds = self._managed(project)
        row = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == ds.id).first()
        with pytest.raises(HTTPException) as exc:
            _run(link_participant(1, ds.id, row.id, None, _user(project), project))
        assert exc.value.status_code == 409

    def test_bulk_relinking_is_refused(self, project):
        ds = self._managed(project)
        with pytest.raises(HTTPException) as exc:
            _run(bulk_link_participants(1, ds.id, None, _user(project), project))
        assert exc.value.status_code == 409

    def test_link_by_column_is_refused(self, project):
        ds = self._managed(project)
        with pytest.raises(HTTPException) as exc:
            _run(link_by_column(1, ds.id, None, _user(project), project))
        assert exc.value.status_code == 409

    def test_appending_a_file_is_refused(self, project):
        """Refused BEFORE the upload is parsed — the guard sits right after the
        ownership gate, so a researcher does not wait for a file to be read only
        to be told it could never have been used."""
        ds = self._managed(project)
        with pytest.raises(HTTPException) as exc:
            _run(append_preview(
                project_id=1, dataset_id=ds.id, file=None, encoding="utf-8",
                sheet_name=None, user=_user(project), db=project,
            ))
        assert exc.value.status_code == 409

    def test_an_ORDINARY_dataset_still_deletes(self, project):
        """The other side of every refusal above — a one-sided suite passes
        against a guard that refuses everything."""
        ordinary = Dataset(project_id=1, name="Survey")
        project.add(ordinary)
        project.flush()
        _run(delete_dataset(1, ordinary.id, _user(project), project))
        assert project.query(Dataset).filter(Dataset.id == ordinary.id).first() is None


class TestTheParticipantPanelsDoorsAreLockedToo:
    """#1157 — the participants router writes `DatasetRow.participant_id` at two
    doors the dataset router's gate never reached, and the Participants panel offered
    *Unlink* on this table. The unlink was a DELETE with a delay: the next refresh
    reaped the row and the cells typed into it (measured on a scratch install)."""

    def _managed_row(self, db):
        ds = create_participant_dataset(db, 1)
        row = db.query(DatasetRow).filter(
            DatasetRow.dataset_id == ds.id, DatasetRow.participant_id.isnot(None),
        ).order_by(DatasetRow.id).first()
        return ds, row

    def test_the_panels_unlink_is_refused_and_changes_nothing(self, project):
        from app.routers.participants import unlink_dataset_row
        from app.schemas.participant import UnlinkDatasetRowRequest

        ds, row = self._managed_row(project)
        owner = row.participant_id
        with pytest.raises(HTTPException) as exc:
            _run(unlink_dataset_row(
                1, owner, UnlinkDatasetRowRequest(row_id=row.id), _user(project), project,
            ))
        assert exc.value.status_code == 409
        assert exc.value.detail == managed_dataset_refusal(ds, pd.ACTION_LINK_PARTICIPANTS)
        project.expire_all()
        assert project.get(DatasetRow, row.id).participant_id == owner

    def test_the_panels_link_is_refused_with_the_tables_own_sentence(self, project):
        """The row is someone else's, so the old code refused this too — with
        "Row already linked". The DETAIL is what proves the new gate answered first."""
        from app.routers.participants import link_dataset_row
        from app.schemas.participant import LinkDatasetRowRequest

        ds, row = self._managed_row(project)
        newcomer = Participant(project_id=1, identifier="E-99")
        project.add(newcomer)
        project.flush()
        with pytest.raises(HTTPException) as exc:
            _run(link_dataset_row(
                1, newcomer.id, LinkDatasetRowRequest(dataset_id=ds.id, row_id=row.id),
                _user(project), project,
            ))
        assert exc.value.status_code == 409
        assert exc.value.detail == managed_dataset_refusal(ds, pd.ACTION_LINK_PARTICIPANTS)

    def test_an_ORDINARY_datasets_row_still_unlinks_and_links_back(self, project):
        """The positive control: a guard that refused every unlink passes both
        tests above."""
        from app.routers.participants import link_dataset_row, unlink_dataset_row
        from app.schemas.participant import LinkDatasetRowRequest, UnlinkDatasetRowRequest

        person = project.query(Participant).filter(Participant.identifier == "E-01").one()
        survey = Dataset(project_id=1, name="Survey")
        project.add(survey)
        project.flush()
        row = DatasetRow(dataset_id=survey.id, participant_id=person.id, row_identifier="R1")
        project.add(row)
        project.flush()

        _run(unlink_dataset_row(
            1, person.id, UnlinkDatasetRowRequest(row_id=row.id), _user(project), project,
        ))
        project.expire_all()
        assert project.get(DatasetRow, row.id).participant_id is None
        _run(link_dataset_row(
            1, person.id, LinkDatasetRowRequest(dataset_id=survey.id, row_id=row.id),
            _user(project), project,
        ))
        project.expire_all()
        assert project.get(DatasetRow, row.id).participant_id == person.id

    def test_the_payload_says_which_links_are_locked(self, project):
        """The panel shows the server's sentence instead of *Unlink*, so the payload
        must carry it — for the managed row only."""
        from app.routers.participants import _load_participant_with_relations, participant_to_response

        create_participant_dataset(project, 1)
        person = project.query(Participant).filter(Participant.identifier == "E-01").one()
        survey = Dataset(project_id=1, name="Survey")
        project.add(survey)
        project.flush()
        project.add(DatasetRow(dataset_id=survey.id, participant_id=person.id, row_identifier="R1"))
        project.flush()
        project.expire_all()

        response = participant_to_response(_load_participant_with_relations(project, person.id), project)
        by_dataset = {r.dataset_name: r.link_refusal for r in response.dataset_rows}
        assert by_dataset["Survey"] is None
        assert by_dataset["Participants"] == pd._REFUSALS[pd.ACTION_LINK_PARTICIPANTS]


class TestOpenColumns:
    """The half a lock-only suite would lose."""

    def test_a_researcher_may_add_a_variable_and_edit_its_cells(self, project):
        dataset = create_participant_dataset(project, 1)
        column = DatasetColumn(
            dataset_id=dataset.id, column_text="Tenure",
            column_type=ColumnType.NUMERIC, sequence_order=1, display_order=1,
            source="manual",
        )
        project.add(column)
        project.flush()
        row = project.query(DatasetRow).filter(
            DatasetRow.dataset_id == dataset.id).first()
        value = DatasetValue(row_id=row.id, column_id=column.id, value_text="4")
        project.add(value)
        project.flush()
        # The manual-only gates let this through — that is "open columns".
        assert managed_dataset_refusal(dataset, ACTION_DELETE_ROW) is not None
        _run(delete_manual_column(1, dataset.id, column.id, _user(project), project))
        assert project.query(DatasetColumn).filter(
            DatasetColumn.id == column.id).first() is None

    def test_the_tool_owned_column_is_readonly_through_the_EXISTING_gates(self, project):
        """🔴 The structural claim that saves three new guards: `source =
        "managed"` is not `"manual"`, and these three endpoints already refuse
        anything that is not. If a gate were relaxed, this fails."""
        dataset = create_participant_dataset(project, 1)
        column = project.query(DatasetColumn).filter(
            DatasetColumn.dataset_id == dataset.id).one()
        value = project.query(DatasetValue).filter(
            DatasetValue.column_id == column.id).first()

        for call in (
            lambda: update_value(1, dataset.id, value.id, None, _user(project), project),
            lambda: delete_manual_column(1, dataset.id, column.id, _user(project), project),
            lambda: update_manual_column(1, dataset.id, column.id, None, _user(project), project),
        ):
            with pytest.raises(HTTPException) as exc:
                _run(call())
            assert exc.value.status_code == 403, exc.value.detail


class TestTheToolsOwnColumnsAreAlsoLocked:
    """#926 — the FOUR doors the "no new guard needed" claim never covered.

    🔴 **The claim above (`TestOpenColumns` and this module's docstring) is TRUE
    and was NOT the whole population.** `update_manual_column`,
    `delete_manual_column` and `update_value` refuse `source != "manual"`; the
    four recode doors refuse `source == "computed"`, and `managed` is neither.
    Measured live on the pd_audit corpus: a participant score column was retyped
    to `open_text` from the Data view, it persisted, it SURVIVED a refresh, and
    the toolbar's *Code Text* button turned on.

    Every door is driven here, and `test_an_IMPORTED_column_can_still_be_retyped`
    is the positive control that makes the obvious wrong fix fail loudly.
    """

    def _managed_column(self, db):
        dataset = create_participant_dataset(db, 1)
        column = DatasetColumn(
            dataset_id=dataset.id, column_text="Fidelity (score)",
            column_type=ColumnType.NUMERIC, sequence_order=2, display_order=2,
            source=MANAGED_COLUMN_SOURCE,
            managed_spec='{"kind": "magnitude_score", "code_id": 1}',
        )
        db.add(column)
        db.flush()
        return dataset, column

    def test_the_type_cannot_be_changed(self, project):
        dataset, column = self._managed_column(project)
        with pytest.raises(HTTPException) as exc:
            bulk_type_update(
                1, dataset.id,
                BulkTypeUpdateRequest(column_ids=[column.id], column_type="open_text"),
                _user(project), project,
            )
        assert exc.value.status_code == 409
        assert exc.value.detail["column_ids"] == [column.id]
        assert project.query(DatasetColumn).filter(
            DatasetColumn.id == column.id).one().column_type == ColumnType.NUMERIC

    def test_a_bulk_type_change_refuses_the_WHOLE_request(self, project):
        """All-or-nothing, unlike `bulk_set_missing_values`' per-column outcomes.

        That endpoint's refusals judge one column's own DATA, so discarding the
        rest would be wrong. This one judges what a column IS, and a partial
        success would silently retype the ordinary columns in a selection the
        researcher made as a single act.
        """
        dataset, managed = self._managed_column(project)
        ordinary = DatasetColumn(
            dataset_id=dataset.id, column_text="Tenure",
            column_type=ColumnType.NUMERIC, sequence_order=3, display_order=3,
            source="manual",
        )
        project.add(ordinary)
        project.flush()
        with pytest.raises(HTTPException):
            bulk_type_update(
                1, dataset.id,
                BulkTypeUpdateRequest(
                    column_ids=[ordinary.id, managed.id], column_type="nominal"),
                _user(project), project,
            )
        assert project.query(DatasetColumn).filter(
            DatasetColumn.id == ordinary.id).one().column_type == ColumnType.NUMERIC

    def test_an_IMPORTED_column_can_still_be_retyped(self, project):
        """🔴 THE POSITIVE CONTROL, and the reason the predicate is
        `source == "managed"` rather than `source != "manual"`.

        Retyping an imported column is a shipped feature — the import wizard's
        per-column override and the Variables view's type control both depend on
        it. The obvious wider gate passes every test above and breaks this one.
        """
        dataset = create_participant_dataset(project, 1)
        imported = DatasetColumn(
            dataset_id=dataset.id, column_text="Q1",
            column_type=ColumnType.NOMINAL, sequence_order=4, display_order=4,
            source="imported",
        )
        project.add(imported)
        project.flush()
        bulk_type_update(
            1, dataset.id,
            BulkTypeUpdateRequest(column_ids=[imported.id], column_type="open_text"),
            _user(project), project,
        )
        assert project.query(DatasetColumn).filter(
            DatasetColumn.id == imported.id).one().column_type == ColumnType.OPEN_TEXT

    def test_value_labels_are_refused(self, project):
        dataset, column = self._managed_column(project)
        with pytest.raises(HTTPException) as exc:
            apply_value_labels_endpoint(
                1, dataset.id, column.id,
                ApplyValueLabelsRequest(labels=[ValueLabelPair(value=1, label="Low")]),
                _user(project), project,
            )
        assert exc.value.status_code == 409
        assert "maintained by the tool" in exc.value.detail

    def test_missing_values_are_refused(self, project):
        """An empty cell on a score column already MEANS "no usable rating"
        (row 45's NULL-is-not-zero rule), and the next refresh would overwrite
        whatever was declared."""
        dataset, column = self._managed_column(project)
        with pytest.raises(HTTPException) as exc:
            _run(set_missing_values(
                1, dataset.id, column.id,
                MissingValuesUpdate(rules=[]), _user(project), project,
            ))
        assert exc.value.status_code == 409

    def test_a_recode_definition_is_refused(self, project):
        dataset, column = self._managed_column(project)
        with pytest.raises(HTTPException) as exc:
            _run(create_definition(
                1, dataset.id, column.id,
                RecodeDefinitionCreate(
                    name="Bands", recode_type="scale_map", output_type="numeric",
                    mapping={"1": 1},
                ),
                _user(project), project,
            ))
        assert exc.value.status_code == 409

    def test_copy_to_SKIPS_a_managed_target_rather_than_refusing(self, project):
        """The fifth door, and the one the filed entry missed — `copy_to`
        writes a definition onto its targets and applies it when the target has
        no rule, reaching a managed column's cells without `create_definition`.

        ⚠️ Its contract is already per-target (`skipped_columns` rides the
        response), so one ineligible target must not discard the copy onto the
        others.
        """
        dataset, managed = self._managed_column(project)
        source = DatasetColumn(
            dataset_id=dataset.id, column_text="Source",
            column_type=ColumnType.ORDINAL, sequence_order=5, display_order=5,
            source="manual",
        )
        other = DatasetColumn(
            dataset_id=dataset.id, column_text="Other",
            column_type=ColumnType.ORDINAL, sequence_order=6, display_order=6,
            source="manual",
        )
        project.add_all([source, other])
        project.flush()
        definition = RecodeDefinition(
            column_id=source.id, name="Bands", recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC, mapping=json.dumps({"1": 1}),
        )
        project.add(definition)
        project.flush()

        result = _run(copy_to(
            1, dataset.id, source.id, definition.id,
            CopyToRequest(target_column_ids=[managed.id, other.id]),
            _user(project), project,
        ))
        assert managed.id in result.skipped_columns
        assert project.query(RecodeDefinition).filter(
            RecodeDefinition.column_id == managed.id).count() == 0
        # …and the ordinary target still got its copy.
        assert project.query(RecodeDefinition).filter(
            RecodeDefinition.column_id == other.id).count() == 1

    def test_the_predicate_allows_an_ordinary_column_and_fails_closed(self, project):
        ordinary = DatasetColumn(
            dataset_id=1, column_text="Q", column_type=ColumnType.NOMINAL,
            sequence_order=1, display_order=1, source="imported",
        )
        for action in pd.MANAGED_COLUMN_ACTIONS:
            assert pd.managed_column_refusal(ordinary, action) is None
            assert pd.managed_column_refusal(None, action) is None
        with pytest.raises(ValueError):
            pd.managed_column_refusal(ordinary, "rename")

    def test_renaming_a_managed_column_stays_ALLOWED(self, project):
        """"Locked spine, open columns" puts rename on the allowed side, and
        `managed_spec` exists so a rename cannot orphan the cells a refresh
        rewrites — the column is found by its spec, never by its name.

        ⚠️ This also refutes #924's stated premise that a researcher "cannot
        correct" a heading left stale by a code rename: `update_column_header`
        has no source gate, and this is the test that says so on purpose rather
        than by omission.
        """
        dataset, column = self._managed_column(project)
        _run(update_column_header(
            1, dataset.id, column.id,
            ColumnHeaderUpdate(column_name="PDG"), _user(project), project,
        ))
        assert project.query(DatasetColumn).filter(
            DatasetColumn.id == column.id).one().column_name == "PDG"


class TestPortability:
    """`.mmproject` carries the marker, and `CURRENT_FORMAT_VERSION` is
    deliberately NOT bumped (the row-46 precedent). An older build drops the
    column and imports an ORDINARY dataset holding the same rows and cells —
    that build's own status quo — and the sync is the repair on the way back."""

    def test_the_marker_survives_a_round_trip(self, project, tmp_path):
        import json
        import zipfile
        from app.services.project_portability import export_project, import_project

        dataset = create_participant_dataset(project, 1)
        project.commit()

        buf = export_project(project, 1, tmp_path)
        payload = json.loads(zipfile.ZipFile(buf).read("project.json"))
        exported = payload["datasets"]
        assert [d["managed_kind"] for d in exported] == [MANAGED_KIND_PARTICIPANTS], (
            "`managed_kind` must ride the export — the column set is reflected "
            "from the model, so its absence means the model changed"
        )

        path = tmp_path / "p.mmproject"
        path.write_bytes(buf.getvalue())
        new_pid, _ = import_project(project, path, tmp_path, user_id=1)
        project.commit()

        imported = get_participant_dataset(project, new_pid)
        assert imported is not None and imported.id != dataset.id
        assert _identifiers(project, imported) == ["E-01", "E-02", "E-03"], (
            "the rows must re-point at the IMPORTED participants, not the source's"
        )

    def test_this_row_needed_no_format_bump_and_the_reason_is_structural(self):
        """Pinned so a later reader does not 'tidy' this into a bump. The gate
        question is what an OLDER build does with a file it half-understands, and
        here the answer is: it gets a perfectly ordinary dataset — because the
        marker is NULLABLE, and every refusal keys on it being non-null, so a build
        that drops the column sees exactly the state it had before the column
        existed.

        🔴 **It used to assert `CURRENT_FORMAT_VERSION == 6`, and #958's bump to v7 —
        nothing whatever to do with managed datasets — turned it red.** That is a
        number pinned in two files going stale in the one nobody was looking at. The
        version has ONE pin, `test_project_portability.py::TestFormatVersionIsPinned`,
        which is also where a bump has to state what the new version MEANS; this test
        keeps the claim that is actually about THIS row.
        """
        from app.models.dataset import Dataset

        assert Dataset.__table__.columns["managed_kind"].nullable, (
            "the marker became required, so an older build dropping it no longer "
            "yields an ordinary dataset — the no-bump argument is gone"
        )


class TestEveryRowSetEndpointAsksTheGate:
    """The fail-closed scan. A machine-made dataset renders like a hand-made one
    and inherits every affordance it has, so the eighth row-set endpoint must
    fail HERE rather than in the field.

    Deliberately keyed on the PATH — what a route touches — rather than on a
    list of the seven that exist, per #515/#676: pin the relationship between
    the two sets, never the variant you just added.
    """

    SOURCE = Path(__file__).resolve().parents[1] / "app" / "routers" / "dataset.py"

    #: Endpoints whose path matches but which do not change the row set. Each
    #: needs a reason, and `test_the_allowlist_has_no_stale_entries` fails when
    #: one stops matching.
    #:
    #: EMPTY today, and measured rather than assumed: the reads that touch these
    #: paths (`get_row`, `get_row_position`, `get_linkable_rows`,
    #: `get_dataset_data`) are `@router.get`, which the method filter already
    #: excludes — the first draft allowlisted all four and the stale-entry test
    #: rejected them. ⚠️ An empty allowlist means `test_every_row_set_endpoint…`
    #: has an EMPTY expected result, which passes by finding nothing (#729) —
    #: the population check and the predicate falsifier below are what make it
    #: evidence.
    ALLOWLIST: dict[str, str] = {}

    def _row_set_endpoints(self) -> dict[str, bool]:
        """``{function name: does it call the gate}`` for every mutating route
        whose path touches the row set."""
        tree = ast.parse(self.SOURCE.read_text())
        found: dict[str, bool] = {}
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                if not (isinstance(dec, ast.Call)
                        and isinstance(dec.func, ast.Attribute)):
                    continue
                method = dec.func.attr
                path = dec.args[0].value if (
                    dec.args and isinstance(dec.args[0], ast.Constant)
                ) else ""
                if not isinstance(path, str):
                    continue
                touches_rows = (
                    "/rows" in path
                    or "append" in path
                    or "link" in path
                    or (path == "/{dataset_id}" and method == "delete")
                )
                if touches_rows and method in {"post", "patch", "delete", "put"}:
                    body = ast.dump(node)
                    found[node.name] = "_refuse_if_managed" in body
        return found

    def test_the_scan_finds_the_known_endpoints(self):
        """Population self-check (#729/#730): a walk that resolves to nothing
        passes an `all(...)` test by finding nothing."""
        found = self._row_set_endpoints()
        assert len(found) >= 8, (
            f"the route scan found {len(found)} row-set endpoints — it has gone "
            "blind; eight are known to exist (row 47's `create_row` is the "
            "eighth, and it arrived by FAILING this gate rather than by anyone "
            "remembering the seam existed)"
        )

    def test_the_predicate_actually_discriminates(self):
        """Falsifier: prove the matcher can say NO. A predicate that returns
        True for everything would pass the gate test trivially."""
        tree = ast.parse(self.SOURCE.read_text())
        names = {
            n.name for n in ast.walk(tree)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        matched = set(self._row_set_endpoints())
        assert names - matched, "the scan matched every function in the module"
        assert "update_dataset" not in matched, (
            "renaming a dataset does not touch the row set and must not be "
            "swept in — it is on the ALLOWED side of the decision"
        )

    def test_every_row_set_endpoint_asks_the_gate(self):
        found = self._row_set_endpoints()
        missing = sorted(
            name for name, gated in found.items()
            if not gated and name not in self.ALLOWLIST
        )
        assert not missing, (
            f"{missing} change a managed dataset's ROW SET without calling "
            "`_refuse_if_managed`. The rows of a participant dataset are DERIVED "
            "from `Participant`; add the call with the right action from "
            "`participant_dataset.MANAGED_ACTIONS`, or allowlist it here with a "
            "reason."
        )

    def test_the_allowlist_has_no_stale_entries(self):
        found = self._row_set_endpoints()
        stale = sorted(set(self.ALLOWLIST) - set(found))
        assert not stale, f"{stale} are allowlisted but no longer match the scan"


class TestEveryDoorThatRelinksARowAsksTheGate:
    """#1157 — the scan above reads `routers/dataset.py` ONLY, and the doors were not
    all there: `routers/participants.py`'s `link_dataset_row` / `unlink_dataset_row`
    write the same `DatasetRow.participant_id` and never asked. **Count the doors by
    what they WRITE, never by the file they live in.**

    So this walks EVERY router module and finds the route functions that write a
    dataset row's participant link — an assignment to `.participant_id` in a body
    that names `DatasetRow` (or the router's alias for it), or a call to the linking
    service — and requires each to ask the gate (`_refuse_if_managed` or
    `managed_dataset_refusal`).
    """

    #: Route functions that match but cannot touch a tool-maintained table, each
    #: with its reason; `test_the_allowlist_has_no_stale_entries` fails on a stale one.
    #: EMPTY, and measured rather than assumed: the first draft allowlisted
    #: `import_dataset` (a new dataset is never managed), and the stale-entry test
    #: refused it — the import links rows inside `dataset_import`, not in the router.
    #: Six doors match today and all six ask (append is the sixth).
    ALLOWLIST: dict[str, str] = {}

    GATE_CALLS = ("_refuse_if_managed", "managed_dataset_refusal")
    ROUTE_METHODS = {"post", "patch", "put", "delete"}

    def _relinking_routes(self, source: str, module: str) -> dict[str, bool]:
        tree = ast.parse(source)
        found: dict[str, bool] = {}
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            is_route = any(
                isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                and d.func.attr in self.ROUTE_METHODS
                for d in node.decorator_list
            )
            if not is_route:
                continue
            names = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}
            mentions_rows = any(n.startswith("DatasetRow") for n in names)
            writes_link = any(
                isinstance(t, ast.Attribute) and t.attr == "participant_id"
                for n in ast.walk(node) if isinstance(n, ast.Assign)
                for t in n.targets
            )
            calls_linker = any(
                isinstance(n, ast.Call)
                and getattr(n.func, "id", getattr(n.func, "attr", None)) == "link_rows_by_identifier_column"
                for n in ast.walk(node)
            )
            if (writes_link and mentions_rows) or calls_linker:
                calls = {
                    getattr(n.func, "id", getattr(n.func, "attr", None))
                    for n in ast.walk(node) if isinstance(n, ast.Call)
                }
                found[f"{module}::{node.name}"] = any(g in calls for g in self.GATE_CALLS)
        return found

    def _scan(self) -> dict[str, bool]:
        from tests.guard_support import app_files

        found: dict[str, bool] = {}
        for path in app_files(
            "routers", floor=30,
            sentinels=("routers/participants.py", "routers/dataset.py"),
        ):
            found.update(self._relinking_routes(path.read_text(encoding="utf-8"), path.stem))
        return found

    @staticmethod
    def _bare(name: str) -> str:
        return name.split("::", 1)[1]

    def test_the_scan_finds_the_known_doors(self):
        """Population self-check: the dataset router's three link doors, its append,
        and the participants router's two."""
        found = self._scan()
        for door in (
            "dataset::link_participant", "dataset::bulk_link_participants",
            "dataset::link_by_column", "participants::link_dataset_row",
            "participants::unlink_dataset_row",
        ):
            assert door in found, f"the scan no longer finds {door} — it has gone blind"

    def test_the_predicate_actually_discriminates(self):
        """Falsifier: a SPEAKER link is written in the conversations router, and it
        is not a dataset row."""
        planted = (
            "@router.post('/x')\n"
            "def link_speaker(db):\n"
            "    speaker.participant_id = 3\n"
            "@router.post('/y')\n"
            "def relink(db):\n"
            "    row = db.query(DatasetRow).first()\n"
            "    row.participant_id = None\n"
        )
        found = self._relinking_routes(planted, "planted")
        assert found == {"planted::relink": False}

    def test_every_door_that_relinks_a_row_asks_the_gate(self):
        missing = sorted(
            name for name, gated in self._scan().items()
            if not gated and self._bare(name) not in self.ALLOWLIST
        )
        assert not missing, (
            f"{missing} write a dataset row's participant link without asking "
            "whether the dataset maintains its own links. Call "
            "`managed_dataset_refusal(dataset, ACTION_LINK_PARTICIPANTS)` and refuse "
            "with 409, or allowlist it here with a reason."
        )

    def test_the_allowlist_has_no_stale_entries(self):
        bare = {self._bare(n) for n in self._scan()}
        stale = sorted(set(self.ALLOWLIST) - bare)
        assert not stale, f"{stale} are allowlisted but no longer match the scan"


# ── #928 — two adjacent columns headed "Participant" ─────────────────────────
#
# The grid renders `Record | Participant | Participant [identifier]`: the middle
# one is its own built-in participant-LINK column (the person's name), the third
# is this module's identifier column (the string they are matched by). Two
# headings, one word, on the surface a researcher reads to check who is in the
# study.


class TestTheIdentifierHeadingSaysWhatItIs:
    def test_a_new_table_does_not_reuse_the_grids_own_heading(self, project):
        dataset = create_participant_dataset(project, 1)
        column = pd._identifier_column(project, dataset)
        assert column.column_text == "Participant ID"
        # The assertion that matters is the INEQUALITY: the defect was one string
        # on two adjacent headers, so a future rename must keep them distinct.
        assert column.column_text != "Participant"

    def test_nothing_MATCHES_on_the_heading(self, project):
        """The entry's own caution, tested rather than reasoned about: renaming
        the column must not detach the sync from it. `_identifier_column` finds it
        by `source` + `column_type`."""
        dataset = create_participant_dataset(project, 1)
        column = pd._identifier_column(project, dataset)
        column.column_text = "Anything At All"
        project.flush()

        assert pd._identifier_column(project, dataset).id == column.id
        report = pd.sync_rows(project, dataset)
        assert report.removed == 0, "the sync still finds its own column"

    def test_a_table_built_before_the_rename_is_REPAIRED(self, project):
        """A fix that only changed the constant would leave every existing table
        showing the duplicate it was filed for."""
        dataset = create_participant_dataset(project, 1)
        column = pd._identifier_column(project, dataset)
        column.column_text = "Participant"  # what this module used to write
        project.flush()

        pd.sync_rows(project, dataset)

        assert column.column_text == "Participant ID"

    def test_a_researchers_OWN_rename_is_NEVER_clobbered(self, project):
        """POSITIVE CONTROL, and the reason the repair is keyed on a set of
        headings THIS module has written rather than on "not the current default".
        Renaming is on the allowed side of "locked spine, open columns" (#924)."""
        dataset = create_participant_dataset(project, 1)
        column = pd._identifier_column(project, dataset)
        column.column_text = "Employee number"
        project.flush()

        pd.sync_rows(project, dataset)

        assert column.column_text == "Employee number"
