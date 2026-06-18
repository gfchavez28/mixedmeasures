"""Env-var alias binding for bare-named settings (an internal audit + L1).

Two regression classes:
1. M10 — every packaging-relevant bare-named field must ALSO bind its MM_-prefixed
   name (CLAUDE.md documents MM_INACTIVITY_TIMEOUT_MINUTES; before this fix it was
   silently ignored — the same class as the P2 live-Swagger bug).
2. L1 — when BOTH names are set, the MM_ name must WIN: the Electron spawn env's
   MM_ hardening must beat a stray bare-named var exported in the user's shell.
   (pydantic-settings resolves AliasChoices in listed order — MM_ is listed first.)

Settings() is constructed directly (not via the lru_cached get_settings) so each
test reads the monkeypatched environment fresh.
"""
import os

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.config import Settings

_ALIASED_FIELDS = [
    ("session_expire_hours", "SESSION_EXPIRE_HOURS", "7", 7),
    ("csrf_enabled", "CSRF_ENABLED", "false", False),
    ("cookie_secure", "COOKIE_SECURE", "true", True),
    ("cors_origins", "CORS_ORIGINS", "http://example.test", "http://example.test"),
    ("auto_backup_interval_hours", "AUTO_BACKUP_INTERVAL_HOURS", "9", 9),
    ("auto_backup_max_count", "AUTO_BACKUP_MAX_COUNT", "3", 3),
    ("inactivity_timeout_minutes", "INACTIVITY_TIMEOUT_MINUTES", "30", 30),
    ("enable_api_docs", "ENABLE_API_DOCS", "false", False),
]


def _clear(monkeypatch, bare):
    monkeypatch.delenv(bare, raising=False)
    monkeypatch.delenv(f"MM_{bare}", raising=False)


def test_mm_prefixed_names_bind(monkeypatch):
    """M10: the MM_ name alone must bind for every aliased field."""
    for field, bare, raw, expected in _ALIASED_FIELDS:
        _clear(monkeypatch, bare)
        monkeypatch.setenv(f"MM_{bare}", raw)
        assert getattr(Settings(), field) == expected, f"MM_{bare} did not bind to {field}"
        _clear(monkeypatch, bare)


def test_bare_names_still_bind(monkeypatch):
    """Back-compat: the bare name alone must keep binding (README documents it)."""
    for field, bare, raw, expected in _ALIASED_FIELDS:
        _clear(monkeypatch, bare)
        monkeypatch.setenv(bare, raw)
        assert getattr(Settings(), field) == expected, f"{bare} did not bind to {field}"
        _clear(monkeypatch, bare)


def test_mm_name_wins_when_both_set(monkeypatch):
    """L1: MM_ENABLE_API_DOCS=false (Electron hardening) must beat a stray
    ENABLE_API_DOCS=true from the user's shell — and the same ordering holds
    for the inactivity timeout."""
    monkeypatch.setenv("ENABLE_API_DOCS", "true")
    monkeypatch.setenv("MM_ENABLE_API_DOCS", "false")
    assert Settings().enable_api_docs is False

    monkeypatch.setenv("INACTIVITY_TIMEOUT_MINUTES", "5")
    monkeypatch.setenv("MM_INACTIVITY_TIMEOUT_MINUTES", "30")
    assert Settings().inactivity_timeout_minutes == 30
