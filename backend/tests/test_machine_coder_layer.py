"""The MACHINE coder layer (#989).

STRATEGY commits, verbatim, that *"the AI layer must be excludable from every
reliability aggregate exactly as `origin='consensus'` already is"*. Nothing
implemented that: `coder_type='ai'` was reserved, unreachable through the API,
reachable through a `.mmproject` import, and excluded from nothing.

These tests are that commitment, plus the traps the pre-implementation review
found. 🔴 **Several of them pass on an install with NO machine coder** — which is
the whole reason they are written as behaviour: `x NOT IN (<empty set>)` is TRUE,
so a wrong implementation stays green until the first machine coder exists.
"""
import pytest
from starlette.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.database import engine, SessionLocal, Base
from app.auth import (
    CODER_TYPE_HUMAN,
    CODER_TYPE_MACHINE,
    KNOWN_CODER_TYPES,
    RELIABILITY_CODER_TYPES,
    ROSTER_CODER_TYPES,
    SELECTABLE_CODER_TYPES,
    SYSTEM_CODER_TYPES,
    ensure_default_user,
    normalize_coder_type,
)
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import coding_layers
from app.services.consensus import consensus_enabled
from app.services.irr import gather_coder_applications


@pytest.fixture(scope="module")
def _migrated_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="module", autouse=True)
def _force_local_mode():
    from app.config import get_settings
    settings = get_settings()
    original = settings.mm_multiuser_auth_enabled
    settings.mm_multiuser_auth_enabled = False
    yield
    settings.mm_multiuser_auth_enabled = original


@pytest.fixture(autouse=True)
def _clean(_migrated_db):
    yield
    db = SessionLocal()
    try:
        for tbl in (
            "code_applications", "segments", "codes", "conversations",
            "audit_entries", "sessions", "projects", "users",
        ):
            db.execute(text(f"DELETE FROM {tbl}"))
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client(_migrated_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def db(_migrated_db):
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _bootstrap(client) -> str:
    """Auto-provision the default coder (sets the session cookie); return its CSRF token."""
    return client.get("/api/auth/status").json()["user"]["csrf_token"]


def _coder(db, name: str, kind: str) -> User:
    row = User(username=name, password_hash=None, coder_type=kind)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _corpus(db):
    """One project, one conversation, one segment, one code — the smallest thing a
    code application can hang from."""
    owner = ensure_default_user(db)
    project = Project(name="Machine layer", user_id=owner.id)
    db.add(project)
    db.commit()
    conv = Conversation(project_id=project.id, name="C1")
    db.add(conv)
    db.commit()
    seg = Segment(conversation_id=conv.id, text="a turn", sequence_order=1)
    code = Code(project_id=project.id, name="Stance", numeric_id=1)
    db.add_all([seg, code])
    db.commit()
    db.refresh(seg)
    db.refresh(code)
    return owner, project, seg, code


def _apply(db, seg, code, user_id, origin="human") -> CodeApplication:
    row = CodeApplication(
        segment_id=seg.id, code_id=code.id, user_id=user_id, origin=origin
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _ids_under(db, scope) -> set[int]:
    return {
        r.id
        for r in db.query(CodeApplication)
        .filter(coding_layers.layer_scope_filter(scope))
        .all()
    }


# ── The cross-language contract ──────────────────────────────────────────────


class TestTheClientMirror:
    """Python READS the TypeScript, the way every stated-basis member's contract
    test does. The two vocabularies are hand-mirrored with no codegen, and the
    failure is silent in both directions: a scope the client offers and the server
    does not know answers 422 on that request alone, and a machine kind the client
    does not recognise renders a model as a colleague."""

    @staticmethod
    def _client_source() -> str:
        from pathlib import Path
        path = (
            Path(__file__).resolve().parents[2]
            / "frontend" / "src" / "lib" / "coding-layers.ts"
        )
        assert path.exists(), f"the client mirror has moved or gone: {path}"
        return path.read_text(encoding="utf-8")

    def test_the_client_declares_the_same_layer_scopes(self):
        src = self._client_source()
        for scope in coding_layers.VALID_LAYER_SCOPES:
            assert f"'{scope}'" in src, f"client mirror is missing the {scope!r} layer"
        # …and does not invent one the routers' pattern would refuse.
        import re
        declared = re.search(
            r"export const LAYER_SCOPES: readonly LayerScope\[\] = \[([^\]]*)\]", src
        )
        assert declared, "could not find LAYER_SCOPES in the client mirror"
        client_scopes = tuple(
            v.strip().strip("'\"") for v in declared.group(1).split(",") if v.strip()
        )
        assert client_scopes == tuple(coding_layers.VALID_LAYER_SCOPES)

    def test_the_client_uses_the_same_stored_machine_value(self):
        src = self._client_source()
        assert f"export const MACHINE_CODER_TYPE = '{CODER_TYPE_MACHINE}'" in src


# ── The vocabulary ───────────────────────────────────────────────────────────


class TestTheVocabulary:
    def test_a_machine_is_on_the_roster_but_is_neither_selectable_nor_a_rater(self):
        assert CODER_TYPE_MACHINE in ROSTER_CODER_TYPES
        assert CODER_TYPE_MACHINE not in SELECTABLE_CODER_TYPES
        assert CODER_TYPE_MACHINE not in RELIABILITY_CODER_TYPES
        # …and it is NOT a system coder. System coders are hidden from the roster,
        # which would make a machine's codings UNATTRIBUTABLE rather than excluded —
        # the opposite of what this feature is for.
        assert CODER_TYPE_MACHINE not in SYSTEM_CODER_TYPES

    def test_no_known_kind_falls_outside_every_tuple(self):
        """A kind in neither tuple is invisible: off the roster, unselectable, in no
        layer, yet still holding codings and occupying the per-coder unique index."""
        for kind in KNOWN_CODER_TYPES:
            assert kind in SYSTEM_CODER_TYPES or kind in ROSTER_CODER_TYPES

    @pytest.mark.parametrize("value", ["ai", "human", "consensus", "unattributed"])
    def test_a_known_kind_survives_normalisation(self, value):
        assert normalize_coder_type(value) == value

    @pytest.mark.parametrize("value", ["robot", "", None, 7, "AI", "Ai"])
    def test_an_unknown_kind_fails_closed_onto_human(self, value):
        """The CASE variants matter: `coder_type` is compared exactly everywhere, so
        `"AI"` is not the machine kind and must not be smuggled in as one."""
        assert normalize_coder_type(value) == CODER_TYPE_HUMAN


# ── The identity gates ───────────────────────────────────────────────────────


class TestAMachineIsNotAnIdentity:
    def test_ensure_default_user_never_returns_a_machine(self, db):
        """The dangerous shape: every human archived, leaving a machine as the only
        non-system row. This filtered on SYSTEM_CODER_TYPES alone before #989, so the
        session would have been re-pointed at the model and every later application
        server-stamped with it."""
        ensure_default_user(db)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        for human in db.query(User).filter(User.coder_type == CODER_TYPE_HUMAN):
            human.archived = True
        db.commit()

        resolved = ensure_default_user(db)
        assert resolved.coder_type == CODER_TYPE_HUMAN
        assert resolved.id != machine.id

    def test_the_switcher_refuses_a_machine(self, client, db):
        csrf = _bootstrap(client)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        resp = client.post(
            "/api/auth/switch-coder",
            json={"coder_id": machine.id},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 404

    def test_the_switcher_still_accepts_a_human(self, client, db):
        """The positive control — a gate that refuses everything passes every negative
        assertion in this class."""
        csrf = _bootstrap(client)
        colleague = _coder(db, "Colleague", CODER_TYPE_HUMAN)
        resp = client.post(
            "/api/auth/switch-coder",
            json={"coder_id": colleague.id},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 200, resp.text

    def test_a_machine_coder_can_be_created_and_is_on_the_roster(self, client):
        csrf = _bootstrap(client)
        created = client.post(
            "/api/auth/coders",
            json={"username": "Claude-Coder", "coder_type": "ai"},
            headers={"X-CSRF-Token": csrf},
        )
        assert created.status_code == 200, created.text
        assert created.json()["coder_type"] == CODER_TYPE_MACHINE

        roster = {c["username"]: c["coder_type"] for c in client.get("/api/auth/coders").json()}
        assert roster["Claude-Coder"] == CODER_TYPE_MACHINE

    def test_create_still_defaults_to_human(self, client):
        """Every existing caller omits the field; none may start minting machines."""
        csrf = _bootstrap(client)
        created = client.post(
            "/api/auth/coders", json={"username": "Alex"}, headers={"X-CSRF-Token": csrf}
        )
        assert created.status_code == 200, created.text
        assert created.json()["coder_type"] == CODER_TYPE_HUMAN

    @pytest.mark.parametrize("kind", ["consensus", "unattributed", "robot"])
    def test_create_refuses_a_kind_that_is_not_a_roster_kind(self, client, kind):
        """A second `consensus` row would split the layer it owns; an unknown kind
        would be a coder in no layer. The schema refuses both at the door."""
        csrf = _bootstrap(client)
        resp = client.post(
            "/api/auth/coders",
            json={"username": f"X-{kind}", "coder_type": kind},
            headers={"X-CSRF-Token": csrf},
        )
        assert resp.status_code == 422


# ── The commitment: never in a reliability aggregate ─────────────────────────


class TestAMachineNeverEntersAReliabilityAggregate:
    def test_one_human_plus_one_machine_does_not_enable_consensus(self, db):
        """`consensus_enabled` gates ALL consensus work. One person plus one model is
        not two voters — counting it would make the model's labels a second opinion
        agreeing with the researcher."""
        ensure_default_user(db)
        _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        assert consensus_enabled(db) is False

    def test_two_humans_do_enable_consensus(self, db):
        """Positive control for the assertion above."""
        ensure_default_user(db)
        _coder(db, "Colleague", CODER_TYPE_HUMAN)
        assert consensus_enabled(db) is True

    def test_a_machine_does_not_change_a_two_human_answer(self, db):
        """The gate counts PEOPLE, so adding a machine to a real two-human roster
        leaves it at two rather than three."""
        ensure_default_user(db)
        _coder(db, "Colleague", CODER_TYPE_HUMAN)
        _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        assert consensus_enabled(db) is True

    def test_the_irr_rater_roster_excludes_a_machine(self, db):
        """`gather_coder_applications` returns its rater list first; a machine in it
        is pooled into the headline alpha with nothing to turn it off."""
        _owner, project, _seg, _code = _corpus(db)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        colleague = _coder(db, "Colleague", CODER_TYPE_HUMAN)

        coder_ids, *_rest = gather_coder_applications(db, project.id)
        assert machine.id not in coder_ids
        assert colleague.id in coder_ids

    def test_naming_a_machine_explicitly_does_not_get_it_in(self, db):
        """`coder_ids` is a caller-supplied NARROWING, so the roster query must still
        refuse: a caller cannot opt a machine into a coefficient."""
        _owner, project, _seg, _code = _corpus(db)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        colleague = _coder(db, "Colleague", CODER_TYPE_HUMAN)

        coder_ids, *_rest = gather_coder_applications(
            db, project.id, coder_ids=[machine.id, colleague.id]
        )
        assert machine.id not in coder_ids
        assert colleague.id in coder_ids


# ── The layer axis, and the NULL trap ────────────────────────────────────────


class TestTheLayerFilter:
    def test_the_scopes_and_the_router_pattern_agree(self):
        """The pattern is BUILT from the tuple. It was hardcoded at ten router sites,
        so a third value added by hand would have left whichever site was missed
        answering 422 for that value alone — one endpoint's worth of silent breakage
        with every other surface working."""
        assert coding_layers.LAYER_MACHINE in coding_layers.VALID_LAYER_SCOPES
        for scope in coding_layers.VALID_LAYER_SCOPES:
            assert scope in coding_layers.LAYER_SCOPE_PATTERN
        assert coding_layers.LAYER_SCOPE_PATTERN == "^(human|consensus|machine)$"

    def test_the_human_layer_excludes_a_machines_applications(self, db):
        owner, _project, seg, code = _corpus(db)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        mine = _apply(db, seg, code, owner.id)
        theirs = _apply(db, seg, code, machine.id)

        human = _ids_under(db, "human")
        assert mine.id in human
        assert theirs.id not in human

        machine_layer = _ids_under(db, "machine")
        assert theirs.id in machine_layer
        assert mine.id not in machine_layer

    def test_the_default_scope_is_the_human_layer(self, db):
        """`None` is what every caller that has not been told about layers passes."""
        owner, _project, seg, code = _corpus(db)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        mine = _apply(db, seg, code, owner.id)
        theirs = _apply(db, seg, code, machine.id)

        default = _ids_under(db, None)
        assert mine.id in default
        assert theirs.id not in default

    def test_an_UNATTRIBUTED_application_survives_the_human_layer(self, db):
        """🔴 THE TRAP, and it needs the machine to exist to be meaningful.

        `CodeApplication.user_id` is nullable (legacy pre-J1 rows, the merged
        "Unattributed" bucket) and SQL's `NULL NOT IN (1, 2)` evaluates to NULL —
        the row is DROPPED. A bare `notin_` passes every other test in this file,
        because `x NOT IN (<empty set>)` is TRUE, and starts silently deleting every
        unattributed coding from every count the moment a machine coder exists.
        """
        owner, _project, seg, code = _corpus(db)
        _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)
        orphan = _apply(db, seg, code, None)

        assert orphan.id in _ids_under(db, "human")
        # …and it is not a machine's, either — `IN` excluding NULL is right here.
        assert orphan.id not in _ids_under(db, "machine")

    def test_an_unattributed_application_survives_with_no_machine_on_the_roster(self, db):
        """The other half: the empty-subquery case, which is the one that lulls."""
        _owner, _project, seg, code = _corpus(db)
        orphan = _apply(db, seg, code, None)
        assert orphan.id in _ids_under(db, "human")

    def test_the_consensus_layer_is_unchanged(self, db):
        """#989 must not have moved the J2-B guard it sits beside."""
        owner, _project, seg, code = _corpus(db)
        derived = _apply(db, seg, code, owner.id, origin=coding_layers.CONSENSUS_ORIGIN)

        assert derived.id in _ids_under(db, "consensus")
        assert derived.id not in _ids_under(db, "human")
        assert derived.id not in _ids_under(db, "machine")

    def test_the_three_layers_PARTITION_every_application(self, db):
        """🔴 The property that makes "layer" a coherent word: no application may
        appear in two layers, and none may appear in none of them.

        This test exists because a planted mutant — dropping `non_consensus_filter()`
        from the MACHINE arm — survived every other test in this file. Reasoning about
        whether it could run gave the wrong answer twice over, so the state is
        CONSTRUCTED here instead: a consensus-origin row owned by a machine coder.

        Reachability, checked rather than assumed: the materialiser only ever writes
        consensus rows owned by the global consensus user, and the export excludes
        consensus rows entirely — but `_build_entity` copies `origin` verbatim, so a
        hand-edited `.mmproject` is a door to exactly this row. That is the same
        threat model `normalize_coder_type` is written for, which is why the guard
        stays rather than being deleted as belt-and-braces (#941 considered and
        rejected here, with the reason).
        """
        owner, project, seg, code = _corpus(db)
        machine = _coder(db, "GPT-Coder", CODER_TYPE_MACHINE)

        # ⚠️ A SECOND code is required, not tidiness: the four rows below would
        # otherwise be two pairs sharing `(segment_id, code_id, user_id)`, which is
        # `ix_code_applications_seg_code_user_unique`. The first draft of this test
        # did exactly that and failed against CORRECT code — and it then "killed" the
        # mutant it was written for, by failing for the wrong reason. Check the probe
        # before concluding anything about the guard.
        second = Code(project_id=project.id, name="Tone", numeric_id=2)
        db.add(second)
        db.commit()
        db.refresh(second)

        rows = [
            _apply(db, seg, code, owner.id),                                   # a person
            _apply(db, seg, code, machine.id),                                 # a machine
            _apply(db, seg, code, None),                                       # unattributed
            # The constructed case: consensus origin, machine owner.
            _apply(db, seg, second, machine.id, origin=coding_layers.CONSENSUS_ORIGIN),
        ]

        layers = {scope: _ids_under(db, scope) for scope in ("human", "consensus", "machine")}
        for row in rows:
            homes = [scope for scope, ids in layers.items() if row.id in ids]
            assert len(homes) == 1, (
                f"application {row.id} (origin={row.origin}, user={row.user_id}) "
                f"is in {homes or 'NO layer'}; every application belongs to exactly one"
            )
