"""A machine coder's PROVENANCE — which model, reached how, at what settings (row 49).

Three layers: the normaliser's refusals, the derived lock, and the endpoints —
including `PATCH /auth/coders/{id}`, which closes #999 (a machine coder could not
be renamed through ANY endpoint).

⚠️ **Every endpoint here is a plain `def` except the three pre-existing `async`
ones**, so direct calls are NOT wrapped in `asyncio.run` — the #837 rider.
"""
import asyncio
import json

import pytest
from fastapi import HTTPException

from app.auth import CODER_TYPE_HUMAN, CODER_TYPE_MACHINE
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.auth import create_coder, list_coders, update_coder
from app.schemas.auth import CreateCoderRequest, MachineProvenance, UpdateCoderRequest
from app.services import machine_coder as mc


def _run(coro):
    return asyncio.run(coro)


def _machine(db, uid, name="GPT-4o", provenance=None):
    coder = User(
        id=uid, username=name, password_hash=None,
        coder_type=CODER_TYPE_MACHINE,
    )
    mc.write_provenance(coder, provenance)
    db.add(coder)
    db.flush()
    return coder


# ── 1. The normaliser ────────────────────────────────────────────────────────


class TestNormalizeProvenance:
    def test_nothing_declared_is_none_and_is_legal(self):
        """An unrecorded configuration is the state every other tool is
        permanently in. Refusing it would make a machine coder uncreatable until
        the researcher has their prompt to hand — at exactly the moment the
        import is most useful."""
        assert mc.normalize_provenance(None) is None
        assert mc.normalize_provenance({}) is None

    def test_a_setting_with_no_model_is_refused(self):
        """🔴 The load-bearing refusal: a temperature recorded against no model
        names a setting of nothing, and the whole record is about WHICH machine."""
        with pytest.raises(mc.MachineCoderError, match="Name the model"):
            mc.normalize_provenance({"parameters": {"temperature": 0.2}})
        with pytest.raises(mc.MachineCoderError, match="Name the model"):
            mc.normalize_provenance({"access": "api"})
        with pytest.raises(mc.MachineCoderError, match="Name the model"):
            mc.normalize_provenance({"prompt": "Code the stance."})

    def test_the_whole_record_round_trips(self):
        out = mc.normalize_provenance({
            "model": "  gpt-4o-2024-08-06 ",
            "access": "api",
            "prompt": "Label each post's stance.",
            "parameters": {"temperature": 0.0, "top_p": 1, "seed": "42"},
        })
        assert out == {
            "model": "gpt-4o-2024-08-06",
            "access": "api",
            "prompt": "Label each post's stance.",
            # 🔴 TEXT, so `0` and `"0"` are ONE record of one setting rather
            # than two. A methods section quotes what was set.
            "parameters": {"temperature": "0", "top_p": "1", "seed": "42"},
        }

    def test_a_parameter_of_ZERO_survives(self):
        """The falsy-zero class (#35 §2's whole reason, one seam over).
        `temperature 0` is the single most reportable decoding setting there is,
        and an emptiness check on the VALUE rather than on its rendered string
        would drop exactly it."""
        out = mc.normalize_provenance({"model": "m", "parameters": {"temperature": 0}})
        assert out["parameters"] == {"temperature": "0"}
        out = mc.normalize_provenance({"model": "m", "parameters": {"greedy": False}})
        assert out["parameters"] == {"greedy": "false"}

    def test_a_non_finite_parameter_is_refused(self):
        """Python's `json` accepts a bare `Infinity` (#625's door, verified by
        execution) and starlette cannot serialise one back out — it would 500 the
        request that renders the roster."""
        with pytest.raises(mc.MachineCoderError, match="finite"):
            mc.normalize_provenance({"model": "m", "parameters": {"t": float("inf")}})

    def test_an_unknown_access_kind_is_refused_by_name(self):
        with pytest.raises(mc.MachineCoderError, match="api, web, local, other"):
            mc.normalize_provenance({"model": "m", "access": "carrier pigeon"})

    def test_caps_are_enforced_and_say_which_field(self):
        with pytest.raises(mc.MachineCoderError, match="Prompt"):
            mc.normalize_provenance(
                {"model": "m", "prompt": "x" * (mc.MAX_PROMPT_LENGTH + 1)}
            )
        with pytest.raises(mc.MachineCoderError, match="at most"):
            mc.normalize_provenance({
                "model": "m",
                "parameters": {f"p{i}": "1" for i in range(mc.MAX_PARAMETERS + 1)},
            })


class TestReadProvenance:
    def test_a_blob_it_cannot_parse_reads_as_NOT_DECLARED(self, db_session):
        """🔴 Strict IN, tolerant OUT (`parse_managed_spec`'s asymmetry, and its
        reason). A value written by another build must not raise inside
        `GET /auth/coders`, which every page loads."""
        db = db_session
        coder = _machine(db, 90)
        for junk in ("not json", "[]", '{"no_model": 1}', '{"model": 5}'):
            coder.machine_provenance = junk
            assert mc.read_provenance(coder) is None

    def test_describe_names_the_configuration_and_NOT_the_prompt(self):
        """A prompt is paragraphs; this has to fit beside a coder's name."""
        line = mc.describe_provenance({
            "model": "gpt-4o", "access": "api",
            "prompt": "a" * 4000, "parameters": {"temperature": "0"},
        })
        assert line == "gpt-4o · via api · temperature 0"
        assert "aaaa" not in line
        assert mc.describe_provenance(None) == "Configuration not recorded"


# ── 2. The lock is DERIVED ───────────────────────────────────────────────────


class TestProvenanceLock:
    def test_it_is_derived_from_CODINGS_not_from_a_stored_flag(self, db_session):
        db = db_session
        db.add(Project(id=5, name="P", user_id=1))
        db.add(Conversation(id=5, project_id=5, name="C"))
        db.flush()
        db.add(Segment(id=50, conversation_id=5, sequence_order=0, text="x"))
        db.add(Code(id=500, project_id=5, numeric_id=9, name="Stance"))
        machine = _machine(db, 91, provenance={"model": "m"})
        db.flush()

        assert mc.provenance_locked(db, machine.id) is False
        db.add(CodeApplication(code_id=500, user_id=machine.id, segment_id=50))
        db.flush()
        assert mc.provenance_locked(db, machine.id) is True

    def test_the_batch_form_answers_for_a_whole_roster_in_one_query(self, db_session):
        db = db_session
        db.add(Project(id=6, name="P", user_id=1))
        db.add(Conversation(id=6, project_id=6, name="C"))
        db.flush()
        db.add(Segment(id=60, conversation_id=6, sequence_order=0, text="x"))
        db.add(Code(id=600, project_id=6, numeric_id=9, name="Stance"))
        a = _machine(db, 92, "A")
        b = _machine(db, 93, "B")
        db.flush()
        db.add(CodeApplication(code_id=600, user_id=a.id, segment_id=60))
        db.flush()
        assert mc.locked_coder_ids(db, [a.id, b.id]) == {a.id}
        # An empty ask is an empty answer and NOT a query — the roster endpoint
        # calls this on every page load.
        assert mc.locked_coder_ids(db, []) == set()


# ── 3. The endpoints ─────────────────────────────────────────────────────────


class TestCreateCoderCarriesProvenance:
    def test_a_machine_is_created_with_its_configuration(self, db_session):
        db = db_session
        user = db.get(User, 1)
        out = _run(create_coder(
            CreateCoderRequest(
                username="GPT-4o", coder_type="ai",
                machine_provenance=MachineProvenance(
                    model="gpt-4o-2024-08-06", access="api",
                    parameters={"temperature": 0},
                ),
            ),
            user=user, db=db,
        ))
        assert out.coder_type == CODER_TYPE_MACHINE
        assert out.machine_provenance == {
            "model": "gpt-4o-2024-08-06", "access": "api",
            "parameters": {"temperature": "0"},
        }
        # A coder that has coded nothing is honestly unlocked.
        assert out.provenance_locked is False

    def test_declaring_a_model_against_a_PERSON_is_refused_not_ignored(self, db_session):
        """🔴 Silently dropping it would leave the researcher believing the
        configuration was recorded — the one thing this field exists to stop."""
        db = db_session
        with pytest.raises(HTTPException) as exc:
            _run(create_coder(
                CreateCoderRequest(
                    username="Alice", coder_type="human",
                    machine_provenance=MachineProvenance(model="gpt-4o"),
                ),
                user=db.get(User, 1), db=db,
            ))
        assert exc.value.status_code == 400
        assert "machine coder" in str(exc.value.detail)

    def test_the_roster_carries_the_provenance_and_the_lock(self, db_session):
        db = db_session
        db.add(Project(id=7, name="P", user_id=1))
        db.add(Conversation(id=7, project_id=7, name="C"))
        db.flush()
        db.add(Segment(id=70, conversation_id=7, sequence_order=0, text="x"))
        db.add(Code(id=700, project_id=7, numeric_id=9, name="Stance"))
        machine = _machine(db, 94, "Claude", provenance={"model": "claude-x"})
        db.flush()
        db.add(CodeApplication(code_id=700, user_id=machine.id, segment_id=70))
        db.flush()

        roster = _run(list_coders(user=db.get(User, 1), db=db))
        row = next(c for c in roster if c.id == machine.id)
        assert row.machine_provenance == {"model": "claude-x"}
        assert row.provenance_locked is True
        # 🔴 The human's lock is False and is not a claim about their codings —
        # a person has no provenance to freeze.
        human = next(c for c in roster if c.id == 1)
        assert human.machine_provenance is None
        assert human.provenance_locked is False


class TestUpdateCoderClosesNine99:
    def test_a_machine_can_finally_be_RENAMED(self, db_session):
        """🔴 #999. Before this endpoint there was no door at all: `PATCH
        /auth/me` renames the ACTIVE coder and `switch-coder` refuses a machine,
        so a machine imported under a bad name was stuck with it. It had to be
        renamed in SQL during #989's own drive."""
        db = db_session
        machine = _machine(db, 95, "gpt4o-run3-FINAL")
        out = update_coder(
            machine.id, UpdateCoderRequest(username="GPT-4o (stance pass)"),
            user=db.get(User, 1), db=db,
        )
        assert out.username == "GPT-4o (stance pass)"

    def test_a_PERSON_is_refused_here_because_a_rename_is_self_service(self, db_session):
        """The J1 rule, not an oversight: a name is how a colleague is
        attributed, so nobody else changes it."""
        db = db_session
        db.add(User(id=96, username="Bob", password_hash=None, coder_type=CODER_TYPE_HUMAN))
        db.flush()
        with pytest.raises(HTTPException) as exc:
            update_coder(96, UpdateCoderRequest(username="Robert"),
                         user=db.get(User, 1), db=db)
        assert exc.value.status_code == 403
        assert "renames themselves" in str(exc.value.detail)

    def test_the_CONFIGURATION_freezes_once_the_coder_has_coded(self, db_session):
        """🔴 Two configurations of one model are two coders. Editing it
        afterwards would silently re-label work the previous configuration
        produced."""
        db = db_session
        db.add(Project(id=8, name="P", user_id=1))
        db.add(Conversation(id=8, project_id=8, name="C"))
        db.flush()
        db.add(Segment(id=80, conversation_id=8, sequence_order=0, text="x"))
        db.add(Code(id=800, project_id=8, numeric_id=9, name="Stance"))
        machine = _machine(db, 97, "M", provenance={"model": "m", "parameters": {"t": "0"}})
        db.flush()

        # Before any coding: editable.
        out = update_coder(
            machine.id,
            UpdateCoderRequest(machine_provenance=MachineProvenance(
                model="m", parameters={"temperature": 0.7})),
            user=db.get(User, 1), db=db,
        )
        assert out.machine_provenance["parameters"] == {"temperature": "0.7"}

        db.add(CodeApplication(code_id=800, user_id=machine.id, segment_id=80))
        db.flush()

        with pytest.raises(HTTPException) as exc:
            update_coder(
                machine.id,
                UpdateCoderRequest(machine_provenance=MachineProvenance(model="other")),
                user=db.get(User, 1), db=db,
            )
        assert exc.value.status_code == 409
        assert "two different coders" in str(exc.value.detail)

    def test_the_NAME_stays_editable_after_it_has_coded(self, db_session):
        """A label is not an identity. Correcting a typo must not require
        abandoning a layer — which is the whole of #999's complaint."""
        db = db_session
        db.add(Project(id=9, name="P", user_id=1))
        db.add(Conversation(id=9, project_id=9, name="C"))
        db.flush()
        db.add(Segment(id=90, conversation_id=9, sequence_order=0, text="x"))
        db.add(Code(id=900, project_id=9, numeric_id=9, name="Stance"))
        machine = _machine(db, 98, "gpt4o typo")
        db.flush()
        db.add(CodeApplication(code_id=900, user_id=machine.id, segment_id=90))
        db.flush()

        out = update_coder(machine.id, UpdateCoderRequest(username="GPT-4o"),
                           user=db.get(User, 1), db=db)
        assert out.username == "GPT-4o"
        assert out.provenance_locked is True

    def test_a_name_collision_is_a_409(self, db_session):
        db = db_session
        db.add(User(id=99, username="Taken", password_hash=None))
        _machine(db, 100, "Machine")
        db.flush()
        with pytest.raises(HTTPException) as exc:
            update_coder(100, UpdateCoderRequest(username="Taken"),
                         user=db.get(User, 1), db=db)
        assert exc.value.status_code == 409

    def test_an_omitted_field_is_left_alone_and_an_explicit_null_clears_the_colour(
        self, db_session,
    ):
        """The `/auth/me` convention: a plain `is not None` could never reset a
        colour, so the endpoint reads `model_fields_set`."""
        db = db_session
        machine = _machine(db, 101, "M", provenance={"model": "m"})
        machine.display_color = "#ff0000"
        db.flush()

        out = update_coder(machine.id, UpdateCoderRequest(username="M2"),
                           user=db.get(User, 1), db=db)
        assert out.display_color == "#ff0000"
        assert out.machine_provenance == {"model": "m"}

        out = update_coder(machine.id, UpdateCoderRequest(display_color=None),
                           user=db.get(User, 1), db=db)
        assert out.display_color is None
        assert out.machine_provenance == {"model": "m"}


class TestPortability:
    def test_the_column_travels_by_REFLECTION_so_no_export_code_names_it(self):
        """`.mmproject` serialises coders with `_serialize_all(coders,
        cols[User])`, so a new `User` column rides the archive with no change to
        the exporter — which is why this row needed no format bump. Pinned
        structurally: the model must DECLARE the column, since reflection is
        what carries it."""
        from app.models.user import User as UserModel
        assert "machine_provenance" in UserModel.__table__.columns

    def test_the_stored_shape_is_json_text(self, db_session):
        db = db_session
        coder = _machine(db, 102, "M", provenance={"model": "m", "access": "local"})
        assert json.loads(coder.machine_provenance)["access"] == "local"
