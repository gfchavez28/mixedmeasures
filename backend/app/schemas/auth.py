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
