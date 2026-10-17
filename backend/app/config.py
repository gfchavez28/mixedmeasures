from pydantic_settings import BaseSettings
from pydantic import ConfigDict, Field, AliasChoices, ValidationError
from functools import lru_cache
from pathlib import Path
import sys

from .startup_errors import FatalStartupError


class Settings(BaseSettings):
    model_config = ConfigDict(
        env_file=Path(__file__).parent.parent.parent / ".env",
        extra="ignore",
    )

    mm_database_path: str = "dev.db"
    # The bare-named fields below predate the `mm_`-prefix convention, so each accepts
    # BOTH the bare env var and the MM_-prefixed one via AliasChoices — without the MM_
    # alias, MM_ENABLE_API_DOCS=false was silently ignored and the packaged build
    # exposed /docs + /openapi.json (P2 finding), and the documented
    # MM_INACTIVITY_TIMEOUT_MINUTES never bound at all (an internal audit).
    # The MM_ alias is listed FIRST so it WINS when both are set: the Electron spawn
    # env's MM_ hardening must beat any stray bare-named var exported in the user's
    # shell (an internal audit — pydantic-settings resolves aliases in listed order).
    session_expire_hours: int = Field(
        default=24,
        validation_alias=AliasChoices("mm_session_expire_hours", "session_expire_hours"),
    )
    csrf_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("mm_csrf_enabled", "csrf_enabled"),
    )
    cookie_secure: bool = Field(  # Set to True in production with HTTPS
        default=False,
        validation_alias=AliasChoices("mm_cookie_secure", "cookie_secure"),
    )
    cors_origins: str = Field(
        default="http://localhost:5173,http://localhost:3000",
        validation_alias=AliasChoices("mm_cors_origins", "cors_origins"),
    )
    auto_backup_interval_hours: int = Field(
        default=4,
        validation_alias=AliasChoices("mm_auto_backup_interval_hours", "auto_backup_interval_hours"),
    )
    auto_backup_max_count: int = Field(
        default=5,
        validation_alias=AliasChoices("mm_auto_backup_max_count", "auto_backup_max_count"),
    )
    inactivity_timeout_minutes: int = Field(  # 0 = disabled. Set to 30 for shared environments.
        default=0,
        validation_alias=AliasChoices("mm_inactivity_timeout_minutes", "inactivity_timeout_minutes"),
    )
    enable_api_docs: bool = Field(  # Set to False in production to disable /docs and /redoc
        default=True,
        validation_alias=AliasChoices("mm_enable_api_docs", "enable_api_docs"),
    )
    mm_data_dir: str = "data"  # Parent of documents/ and media/ subdirs
    mm_backup_dir: str = "backups"  # Directory for .mmbackup and pre-migration backups
    mm_packaged: bool = False  # True in the Electron/PyInstaller build (loopback HTTP desktop app)
    # SQLCipher at-rest encryption (packaging P4). Default OFF: dev.db and the test suite stay
    # plaintext (no overhead, inspectable). ON only in packaged builds. The mm_-prefixed field
    # name binds MM_ENCRYPTION_ENABLED directly — no AliasChoices needed (unlike the bare-named
    # flags above). When ON, the key comes from the KeyProvider in database.py (Phase 1: env var
    # MM_ENCRYPTION_KEY; Phase 3: OS keychain). Encryption is force-disabled on a :memory: DB.
    mm_encryption_enabled: bool = False
    # Dormant multi-user auth surface (an internal audit, gated 2026-06-11). J0 removed the
    # login screen; /setup, /login, /logout, /change-password, and GET/POST /users have no
    # UI callers but stay in the codebase as the account substrate for Track J (coder
    # roster) and the eventual cloud build. Default OFF: they 404 unless explicitly
    # enabled, which also closes the /setup first-launch race (a local process racing the
    # first /status call could otherwise claim the admin account).
    mm_multiuser_auth_enabled: bool = False


class SettingsError(FatalStartupError):
    """An `MM_*` setting holds a value of the wrong kind (#1200). Shown verbatim in the
    packaged app's crash dialog, so it is written as the fix."""


#: What a setting must be, said for the two whose meaning a sentence can add (#1043's
#: words). Every other whole-number or true/false setting gets the generic clause.
_SETTING_HINTS = {
    "auto_backup_interval_hours": (
        "Set it to how many whole hours apart automatic backups are taken (the default "
        "is 4), or to 0 to turn them off"
    ),
    "auto_backup_max_count": (
        "Set it to how many automatic backups to keep (the default is 5, and it must be "
        "at least 1)"
    ),
}


def _field_and_variable(loc: str) -> tuple[str, str]:
    """The field an error is about, and the variable that supplied it.

    ⚠️ pydantic reports the FIRST alias whichever one was set (measured: a bare
    `AUTO_BACKUP_MAX_COUNT=five` is reported as `mm_auto_backup_max_count`), so the
    variable named is the one present in the environment, in alias order — the order
    pydantic-settings reads them in. A value from the `.env` file names the first.
    """
    import os

    environ = {k.lower() for k in os.environ}
    for field, info in Settings.model_fields.items():
        choices = list(getattr(info.validation_alias, "choices", None) or [field])
        if loc in choices or loc == field:
            present = [c for c in choices if c.lower() in environ]
            return field, (present[0] if present else choices[0]).upper()
    return loc, loc.upper()


def _setting_sentence(error: dict) -> str:
    """One sentence for one pydantic error: the variable as it was read, its value, and
    what it must be."""
    field, name = _field_and_variable(str(error["loc"][0]) if error.get("loc") else "")
    value = str(error.get("input", ""))
    shown = value if len(value) <= 40 else value[:39] + "…"
    kind = error.get("type", "")
    if kind.startswith("int"):
        what, fix = "a whole number", _SETTING_HINTS.get(field, "Set it to a whole number")
    elif kind.startswith("bool"):
        what, fix = "true or false", "Set it to true or false"
    else:
        what, fix = "a value Mixed Measures can read", "Correct it"
    said = f"is set to “{shown}”, which is not {what}" if value.strip() else f"is set but empty, and must be {what}"
    return f"{name} {said}. {fix}, or remove it."


def load_settings() -> Settings:
    """`Settings()`, with a value of the wrong kind refused in words (#1200).

    `get_settings()` first runs at IMPORT (`database.py`'s module-level `settings`),
    outside the lifespan's report, so a pydantic `ValidationError` there was a
    traceback — and in the packaged app, "the local engine exited unexpectedly". As a
    `FatalStartupError` its sentence reaches the crash dialog through `run_server.py`,
    and it is the last line of the traceback a server's log shows.
    """
    try:
        return Settings()
    except ValidationError as e:
        sentences = " ".join(_setting_sentence(err) for err in e.errors())
        raise SettingsError(f"{sentences} Then start Mixed Measures again.") from e


@lru_cache()
def get_settings() -> Settings:
    return load_settings()


def get_documents_dir() -> Path:
    """Return the documents storage directory."""
    return Path(get_settings().mm_data_dir) / "documents"


def get_media_dir() -> Path:
    """Return the media storage directory."""
    return Path(get_settings().mm_data_dir) / "media"


def get_backup_dir() -> Path:
    """Return the backup storage directory."""
    return Path(get_settings().mm_backup_dir)


def resource_base() -> Path:
    """Base directory for bundled read-only resources (the alembic tree, built SPA).

    Frozen (PyInstaller): the temporary extraction dir ``sys._MEIPASS``.
    Dev: the ``backend/`` directory (this file's grandparent).

    Writable paths (database / data / backups) are NOT rooted here — they come
    from the env-injected settings above so they land in a writable user-data
    dir, not the read-only bundle.
    """
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def dist_dir() -> Path:
    """Directory of the built frontend SPA, served same-origin by the backend.

    Frozen (PyInstaller): ``<_MEIPASS>/frontend_dist`` (the spec bundles
    ``../frontend/dist`` under that name).
    Dev: ``<repo>/frontend/dist`` (i.e. ``backend/../frontend/dist``) — only
    present after ``npm run build``; absent during normal Vite dev, so the
    SPA mount in ``main.py`` is guarded by ``dist_dir().exists()`` and dev is
    unaffected (Vite serves the SPA on :5173 then).
    """
    if getattr(sys, "frozen", False):
        return resource_base() / "frontend_dist"
    return resource_base().parent / "frontend" / "dist"
