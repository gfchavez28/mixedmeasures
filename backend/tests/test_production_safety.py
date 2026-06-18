"""Phase 5: _check_production_safety's at-rest-encryption warning.

The warning must fire for a PACKAGED build running unencrypted (the OS-keychain-
unavailable fallback) and must be placed BEFORE the mm_packaged early-return that
otherwise suppresses every non-dev warning — so this asserts both the firing and
the placement.

We patch ``app.main.logger.warning`` directly rather than use ``caplog``: app
startup elsewhere in the suite runs a logging ``dictConfig`` that can disable the
import-time ``app.main`` logger, which would make caplog capture order-dependent.
Patching the method is isolation-proof.
"""
import os

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app import config
from app import main as app_main


def _settings(**overrides):
    base = {"mm_database_path": "/data/mm.db"}  # non-dev path → past the is_dev guard
    base.update(overrides)
    return config.Settings(**base)


def _capture_warnings(monkeypatch):
    msgs: list[str] = []
    monkeypatch.setattr(
        app_main.logger, "warning",
        lambda msg, *args, **kw: msgs.append(msg % args if args else msg),
    )
    return msgs


def test_warns_when_packaged_and_unencrypted(monkeypatch):
    monkeypatch.setattr(
        app_main, "get_settings",
        lambda: _settings(mm_packaged=True, mm_encryption_enabled=False),
    )
    msgs = _capture_warnings(monkeypatch)
    app_main._check_production_safety()
    assert any("encryption DISABLED" in m for m in msgs)


def test_silent_when_packaged_and_encrypted(monkeypatch):
    monkeypatch.setattr(
        app_main, "get_settings",
        lambda: _settings(mm_packaged=True, mm_encryption_enabled=True),
    )
    msgs = _capture_warnings(monkeypatch)
    app_main._check_production_safety()
    assert not any("encryption DISABLED" in m for m in msgs)


def test_silent_for_dev_db(monkeypatch):
    """Dev DB returns early — no encryption warning even with encryption off."""
    monkeypatch.setattr(
        app_main, "get_settings",
        lambda: _settings(mm_database_path="dev.db", mm_encryption_enabled=False),
    )
    msgs = _capture_warnings(monkeypatch)
    app_main._check_production_safety()
    assert not any("encryption DISABLED" in m for m in msgs)
