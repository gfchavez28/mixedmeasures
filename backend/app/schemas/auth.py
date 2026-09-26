from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class SetupRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=8)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1)


class UserResponse(BaseModel):
    id: int
    username: str
    is_admin: bool = False
    csrf_token: str | None = None
    # Active coder's hex badge color (Track J · J1). Carried here so the active-user
    # object (auth-context / TopRail dot) renders the SAME color as the roster
    # (`CoderResponse`) and attribution badges — omitting it forced a palette-by-id
    # fallback that disagreed with the saved color (#452).
    display_color: str | None = None

    model_config = ConfigDict(from_attributes=True)


class AuthStatusResponse(BaseModel):
    needs_setup: bool
    authenticated: bool
    user: UserResponse | None = None
    inactivity_timeout_minutes: int = 0
    # At-rest encryption state for the Settings status row (D2: on/off only). The
    # keychain-vs-plaintext-fallback distinction lives in Electron and is surfaced
    # by its startup dialog; the backend only knows whether its engine is keyed.
    encryption_enabled: bool = False


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class UpdateProfileRequest(BaseModel):
    # Coder display name. min_length=1 (not 3 like SetupRequest) — this is a
    # friendly local-coder label, not a login credential.
    username: str = Field(..., min_length=1, max_length=50)
    display_color: str | None = Field(None, max_length=7)  # hex badge color (Track J · J1)


class MachineProvenance(BaseModel):
    """WHICH model produced these labels, reached how, under what settings (row 49).

    ⚠️ **Declared, never inferred.** Every field is optional on the wire and the
    SERVICE decides what a well-formed declaration is
    (`services/machine_coder.py::normalize_provenance`) — a router schema is not
    a guard on the operation (#589), and the `.mmproject` import reaches this
    column without passing any router.

    🔴 `model` is required as soon as anything else is present: a temperature
    with no model names a setting of nothing.
    """

    # ⚠️ `protected_namespaces=()` because the field IS called `model` on the
    # wire — that is the word a methods section uses — and Pydantic reserves the
    # `model_` prefix for its own API. `populate_by_name` lets the service and the
    # tests construct it by the Python name.
    model_config = ConfigDict(protected_namespaces=(), populate_by_name=True)

    #: The model identifier a methods section would quote (`gpt-4o-2024-08-06`).
    model_name: str | None = Field(None, alias="model", max_length=255)
    #: api · web · local · other — the access gap 45% of published studies leave open.
    access: Literal["api", "web", "local", "other"] | None = None
    #: The instrument itself.
    prompt: str | None = None
    #: Decoding settings, `{name: value}`. Free-form because they differ by vendor;
    #: every value is stored as TEXT so `0` and `"0"` are one record, not two.
    parameters: dict[str, str | int | float | bool] | None = None

    def as_payload(self) -> dict:
        """The dict `normalize_provenance` takes — `model_name` back to `model`."""
        return {
            "model": self.model_name,
            "access": self.access,
            "prompt": self.prompt,
            "parameters": self.parameters,
        }


class CoderResponse(BaseModel):
    """A roster coder (Track J · J1) — richer than UserResponse (carries color/type)."""
    id: int
    username: str
    display_color: str | None = None
    coder_type: str = "human"
    is_admin: bool = False
    archived: bool = False
    #: A MACHINE coder's configuration (row 49), or None — for a human, and for a
    #: machine whose configuration was never recorded. ⚠️ A DICT on the wire, not
    #: the stored JSON string: the column is an implementation detail and
    #: `read_provenance` is the one parser.
    machine_provenance: dict | None = None
    #: 🔴 Has this coder produced any coding? Once it has, its configuration IS the
    #: identity of that layer and `PATCH /auth/coders/{id}` refuses to change it —
    #: two configurations of one model are two coders. DERIVED per request, never
    #: stored. Always False for a human (the field is theirs to ignore).
    provenance_locked: bool = False

    model_config = ConfigDict(from_attributes=True)


class CreateCoderRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    display_color: str | None = Field(None, max_length=7)
    #: `human` (a person) or `ai` (a MACHINE coder — labels a model produced
    #: elsewhere, loaded in as a file; #989). Restricted to the ROSTER kinds:
    #: the two SYSTEM identities are find-or-created by `auth.py` and a second
    #: row of either would split the layer it owns.
    coder_type: Literal["human", "ai"] = "human"
    #: Row 49. Accepted only for a machine — declaring a model against a person is
    #: refused rather than ignored, because silently dropping it would leave the
    #: researcher believing it was recorded.
    machine_provenance: MachineProvenance | None = None


class UpdateCoderRequest(BaseModel):
    """Edit a MACHINE coder (#999, row 49's to decide — closed 2026-09-22).

    🔴 **This endpoint exists because a machine coder could not be renamed through
    ANY endpoint.** `PATCH /auth/me` renames the ACTIVE coder — the deliberate J1
    decision that only a coder edits their own name, with no edit-others endpoint
    — and `POST /auth/switch-coder` refuses a machine, so you cannot become one.
    A machine imported under a bad name was stuck with it, and the bulk import
    names machines from a CSV cell, so that stopped being hypothetical.

    ⚠️ It is restricted to machines on purpose. For PEOPLE the J1 rule stands: a
    rename is self-service, because a name is how a colleague is attributed and
    nobody else should be able to change it.

    ⚠️ Every field is `exclude_unset`-read: an omitted field is left alone, and an
    explicit `null` on `display_color` clears it (the `/auth/me` convention).
    """

    username: str | None = Field(None, min_length=1, max_length=50)
    display_color: str | None = Field(None, max_length=7)
    machine_provenance: MachineProvenance | None = None


class SwitchCoderRequest(BaseModel):
    coder_id: int
