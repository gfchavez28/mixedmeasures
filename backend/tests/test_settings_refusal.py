"""#1200 — a setting of the wrong kind is refused in words, through the startup channel.

`get_settings()` first runs at IMPORT (`database.py`'s module-level `settings`), so a
pydantic `ValidationError` there was a traceback — and in the packaged app the crash
dialog's generic "the local engine exited unexpectedly". The desktop app passes the
user's whole environment through (`main.js`: `baseEnv: process.env`), so every
setting Electron does not set itself is reachable from a desktop install.

The population is DERIVED from `Settings.model_fields` (every field that is not a
string can be malformed), never listed here.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import config
from app.config import Settings, SettingsError, load_settings
from app.startup_errors import FatalStartupError, MM_FATAL_PREFIX

BACKEND = Path(__file__).resolve().parent.parent


def _typed_fields():
    out = []
    for name, info in Settings.model_fields.items():
        if info.annotation in (int, bool):
            choices = list(getattr(info.validation_alias, "choices", None) or [name])
            out.append((name, info.annotation, [c.upper() for c in choices]))
    return out


@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name, _t, aliases in _typed_fields():
        for a in aliases:
            monkeypatch.delenv(a, raising=False)
    return monkeypatch


def test_the_population_is_every_typed_setting():
    """Population floor: a walk that found nothing would pass every test below."""
    assert len(_typed_fields()) >= 10


@pytest.mark.parametrize("name,kind,aliases", _typed_fields(), ids=[f[0] for f in _typed_fields()])
def test_every_typed_setting_is_refused_in_words_under_every_name(clean_env, name, kind, aliases):
    bad = "0.5" if kind is int else "maybe"
    for alias in aliases:
        clean_env.setenv(alias, bad)
        with pytest.raises(SettingsError) as exc:
            load_settings()
        clean_env.delenv(alias)
        msg = str(exc.value)
        # `startswith`, never `in`: the bare name is a SUBSTRING of the MM_ one, so `in`
        # passed a mutant that always named the MM_ alias (measured).
        assert msg.startswith(f"{alias} "), f"names {alias}, the variable actually set: {msg[:60]}"
        assert f"“{bad}”" in msg
        assert ("whole number" if kind is int else "true or false") in msg
        assert "start Mixed Measures again" in msg and "\n" not in msg


def test_a_well_formed_value_is_not_refused(clean_env):
    """The falsifier: the translation must not fire on a value pydantic accepts."""
    clean_env.setenv("MM_AUTO_BACKUP_INTERVAL_HOURS", "6")
    clean_env.setenv("MM_CSRF_ENABLED", "false")
    s = load_settings()
    assert s.auto_backup_interval_hours == 6 and s.csrf_enabled is False


def test_the_schedule_settings_say_what_they_mean(clean_env):
    clean_env.setenv("MM_AUTO_BACKUP_INTERVAL_HOURS", "0.5")
    with pytest.raises(SettingsError) as exc:
        load_settings()
    assert "whole hours apart" in str(exc.value) and "0 to turn them off" in str(exc.value)


def test_it_is_a_fatal_startup_error():
    assert issubclass(SettingsError, FatalStartupError)


def test_the_frozen_entry_reports_an_import_failure_on_the_marker_line(tmp_path):
    """Entered at the MOUTH (#747): `run_server.py`, the file PyInstaller freezes, in a
    child process — it dies importing the app, before uvicorn or any file is touched."""
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith("MM_") and k.lower() not in {"auto_backup_interval_hours"}}
    env.update(
        MM_DATABASE_PATH=str(tmp_path / "x.db"), MM_DATA_DIR=str(tmp_path / "data"),
        MM_BACKUP_DIR=str(tmp_path / "backups"), MM_AUTO_BACKUP_INTERVAL_HOURS="0.5",
        MM_PORT="1",
    )
    r = subprocess.run([sys.executable, "run_server.py"], cwd=BACKEND, env=env,
                       capture_output=True, timeout=120)
    assert r.returncode != 0
    lines = [l for l in r.stderr.decode("utf-8").splitlines() if MM_FATAL_PREFIX in l]
    assert len(lines) == 1, r.stderr.decode("utf-8")[-2000:]
    assert "MM_AUTO_BACKUP_INTERVAL_HOURS" in lines[0] and "whole number" in lines[0]
    assert list(tmp_path.iterdir()) == [], "it died before touching anything"
