from pydantic_settings import BaseSettings
from pydantic import ConfigDict, Field, AliasChoices
from functools import lru_cache
from pathlib import Path
import sys


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


@lru_cache()
def get_settings() -> Settings:
    return Settings()


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
