"""#556 — the #414-family hardening corners (a, b, c).

Each of these is defense-in-depth for the identifier seam: none is a live bug on
a shipped path today, and each becomes one the first time a hand-edited file, a
script, or a second browser tab does the obvious thing.

  (a) Participant.identifier was never trimmed on create/update — a padded
      " P001 " is unreachable by the trim-then-exact linking seam FOREVER, and
      silently mints a twin participant.
  (b) Identifier columns were offered as equivalence/variable-group candidates —
      an identifier-only group's scale score 400s, and an identifier inside a
      numeric group contributes a NULL mean member.
  (c) The R-export name-uniqueness pool didn't seed the CSV's own fixed headers,
      so a column code slugifying to `record_id` emits a DUPLICATE header and
      detaches #533's col_character() spec from the join key.

(d) lives in the frontend (DatasetView linkMutation.onError toast).
"""
import asyncio
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    CROSSWALK_INELIGIBLE_TYPES,
    SCALE_SCORE_ELIGIBLE_TYPES,
    VALUE_NUMERIC_TYPES,
)
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.schemas.participant import ParticipantCreate, ParticipantUpdate


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def project(db_session):
    user = db_session.query(User).filter(User.id == 1).first()
    p = Project(name="P556", user_id=user.id)
    db_session.add(p)
    db_session.flush()
    return p


# ── (a) identifier trim / whitespace-only reject ────────────────────────────


def test_create_schema_trims_identifier():
    assert ParticipantCreate(identifier="  P001  ").identifier == "P001"


def test_update_schema_trims_identifier():
    assert ParticipantUpdate(identifier="\tP002\n").identifier == "P002"


def test_update_schema_leaves_identifier_unset_alone():
    """A PATCH that doesn't touch identifier must not invent one (exclude_unset)."""
    data = ParticipantUpdate(display_name="Ada")
    assert "identifier" not in data.model_dump(exclude_unset=True)


@pytest.mark.parametrize("blank", [" ", "   ", "\t", "\n", " \t\n "])
def test_whitespace_only_identifier_is_rejected(blank):
    """The ordering trap: min_length=1 passes ' ' (it's 1 char) — the after-validator
    is what rejects it. If the strip ever moves before/into the constraint, this
    is the test that notices."""
    with pytest.raises(ValidationError):
        ParticipantCreate(identifier=blank)
    with pytest.raises(ValidationError):
        ParticipantUpdate(identifier=blank)


def test_display_name_and_role_trim_blank_to_none():
    """display_name propagates to linked SPEAKER names — padding leaks into the
    transcript UI. Blank-after-strip normalizes to None (which is how
    `display_name or identifier` already treated it)."""
    p = ParticipantCreate(identifier="P1", display_name="  Ada  ", role="  ")
    assert p.display_name == "Ada"
    assert p.role is None


def test_padded_identifier_collides_with_existing_instead_of_twinning(db_session, project):
    """The bug this closes: POST " P001 " against an existing P001 used to store a
    SECOND participant whose identifier no linking pass can ever match. Now the
    trimmed value hits the duplicate check and 409s."""
    from app.routers.participants import create_participant

    db_session.add(Participant(project_id=project.id, identifier="P001"))
    db_session.flush()

    user = db_session.query(User).filter(User.id == 1).first()
    with pytest.raises(HTTPException) as exc:
        _run(create_participant(
            project.id, ParticipantCreate(identifier="  P001  "), user, db_session,
        ))
    assert exc.value.status_code == 409

    # And nothing was written.
    assert db_session.query(Participant).filter(
        Participant.project_id == project.id
    ).count() == 1


def test_create_stores_the_trimmed_identifier(db_session, project):
    from app.routers.participants import create_participant

    user = db_session.query(User).filter(User.id == 1).first()
    _run(create_participant(
        project.id, ParticipantCreate(identifier="  P009  "), user, db_session,
    ))
    stored = db_session.query(Participant).filter(
        Participant.project_id == project.id
    ).one()
    assert stored.identifier == "P009", "a padded identifier reached the DB"


# ── (b) identifier is not a crosswalk candidate ─────────────────────────────


def test_crosswalk_ineligible_types_membership():
    assert CROSSWALK_INELIGIBLE_TYPES == {ColumnType.SKIP, ColumnType.IDENTIFIER}


def test_crosswalk_ineligible_is_disjoint_from_the_numeric_sets():
    """An ineligible type must never also be analysable — if these ever overlap,
    one of the two decisions is wrong."""
    assert not (CROSSWALK_INELIGIBLE_TYPES & VALUE_NUMERIC_TYPES)
    assert not (CROSSWALK_INELIGIBLE_TYPES & SCALE_SCORE_ELIGIBLE_TYPES)
    # str-enum hash property (the frontend mirror compares raw strings)
    assert "identifier" in CROSSWALK_INELIGIBLE_TYPES
    assert "ordinal" not in CROSSWALK_INELIGIBLE_TYPES


def _two_datasets_with_an_identifier(db_session, project):
    """Two datasets that share a same-named identifier column AND a same-named
    ordinal column. The identifier pair is the trap: it matches on name harder
    than anything else in the project, so a name-similarity suggester ranks it
    FIRST unless it is excluded by type."""
    made = {}
    for tag in ("A", "B"):
        ds = Dataset(project_id=project.id, name=f"Wave {tag}", source="imported")
        db_session.add(ds)
        db_session.flush()
        ident = DatasetColumn(
            dataset_id=ds.id, column_text="Participant ID", column_code="PID",
            column_type=ColumnType.IDENTIFIER,
            sequence_order=0, display_order=0, source="imported",
        )
        ordinal = DatasetColumn(
            dataset_id=ds.id, column_text="Overall satisfaction", column_code="SAT",
            column_type=ColumnType.ORDINAL, scale_points=5,
            sequence_order=1, display_order=1, source="imported",
        )
        db_session.add_all([ident, ordinal])
        db_session.flush()
        made[tag] = {"dataset": ds, "identifier": ident, "ordinal": ordinal}
    return made


def test_eg_suggest_pool_excludes_identifier_columns(db_session, project):
    from app.routers.equivalence import suggest_groups

    made = _two_datasets_with_an_identifier(db_session, project)
    user = db_session.query(User).filter(User.id == 1).first()

    result = _run(suggest_groups(project.id, user, db_session))

    suggested_ids = {
        cid
        for s in result.suggestions
        for cid in [c.id for c in s.columns]
    }
    ident_ids = {made["A"]["identifier"].id, made["B"]["identifier"].id}
    assert not (suggested_ids & ident_ids), (
        "identifier columns were suggested as an equivalence group — they hold "
        "identity, not measurements, and the group's scale score would 400"
    )
    # The real pair is still found — the exclusion must be surgical, not a mute.
    assert {made["A"]["ordinal"].id, made["B"]["ordinal"].id} <= suggested_ids


def test_find_matches_pool_excludes_identifier_columns(db_session, project):
    from app.routers.equivalence import find_matches
    from app.schemas.equivalence import FindMatchesRequest

    made = _two_datasets_with_an_identifier(db_session, project)
    user = db_session.query(User).filter(User.id == 1).first()

    # Anchor on dataset A's identifier: single-dataset anchor => fuzzy explore
    # mode, so the fuzzy candidate pool is what's under test.
    result = _run(find_matches(
        project.id,
        FindMatchesRequest(column_ids=[made["A"]["identifier"].id], min_similarity=0.3),
        user,
        db_session,
    ))
    matched_ids = {m.target_column_id for m in result.matches}
    assert made["B"]["identifier"].id not in matched_ids, (
        "the other dataset's identifier column was offered as a fuzzy match "
        "candidate (it name-matches perfectly, which is exactly the trap)"
    )


def test_domain_suggest_pool_still_excludes_identifier(db_session, project):
    """analysis_domains already excluded identifier; it now reads the shared
    constant. Pin it so the refactor didn't lose the behavior."""
    from app.routers.analysis_domains import suggest_domains

    made = _two_datasets_with_an_identifier(db_session, project)
    user = db_session.query(User).filter(User.id == 1).first()

    result = _run(suggest_domains(project.id, user, db_session))
    suggested = {
        m.member_id
        for s in result.suggestions
        for m in s.members
        if m.member_type == "column"
    }
    assert made["A"]["identifier"].id not in suggested
    assert made["B"]["identifier"].id not in suggested


# ── (c) R export name-uniqueness pool seeds the fixed CSV headers ───────────


def test_r_export_column_named_record_id_does_not_collide_with_the_csv_header(
    db_session, project,
):
    """A hand-edited column code that slugifies to a FIXED header used to emit a
    duplicate CSV header; R then bound the col_character() spec to the wrong
    column and #533's leading-zeros guarantee silently died for the join key.
    """
    from app.routers.export_r import export_r_data

    ds = Dataset(project_id=project.id, name="W", source="imported")
    db_session.add(ds)
    db_session.flush()
    # The collision: an ORDINAL column whose code IS a fixed header name.
    db_session.add_all([
        DatasetColumn(
            dataset_id=ds.id, column_text="Trap", column_code="record_id",
            column_type=ColumnType.ORDINAL, scale_points=5,
            sequence_order=0, display_order=0, source="imported",
        ),
        DatasetColumn(
            dataset_id=ds.id, column_text="Also trap", column_code="participant_id",
            column_type=ColumnType.ORDINAL, scale_points=5,
            sequence_order=1, display_order=1, source="imported",
        ),
    ])
    db_session.flush()

    user = db_session.query(User).filter(User.id == 1).first()

    # StreamingResponse — drain its ASYNC body_iterator (test_export_r_roundtrip
    # pattern); a sync join raises "can only join an iterable".
    import io as _io
    import zipfile

    async def _zip_bytes():
        resp = await export_r_data(project_id=project.id, user=user, db=db_session)
        return b"".join([c async for c in resp.body_iterator])

    body = _run(_zip_bytes())
    with zipfile.ZipFile(_io.BytesIO(body)) as z:
        csv_name = next(n for n in z.namelist() if n.endswith("data.csv"))
        # utf-8-sig: the CSV carries a BOM for Excel.
        header = z.read(csv_name).decode("utf-8-sig").splitlines()[0].split(",")

    assert len(header) == len(set(header)), (
        f"duplicate column name in the exported CSV header: {header}"
    )
    assert "record_id" in header  # the fixed header kept its name...
    assert "record_id_2" in header  # ...and the colliding column was suffixed
    # participant_id is seeded even with no participants linked, so a column's R
    # name can't change identity depending on linkage state.
    assert "participant_id_2" in header
