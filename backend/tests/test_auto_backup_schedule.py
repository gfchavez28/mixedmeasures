"""#1186 — automatic backups on a DUE schedule, driven on a fake clock (no sleeping).

The loop used to sleep a whole interval before its first turn, from every launch, so a
session shorter than the interval took none — and on Windows, whose quit takes no
on-quit backup, short sessions took none at all. Now, after a settle, it takes one when
the newest automatic backup in the folder is an interval old, and reads the folder
again on every wake so *Backup now* postpones the next.

The function half (`next_automatic_backup_at`) and the loop half (`_auto_backup_loop`
with an injected `sleep`/`clock` and a stub turn that writes a file named at the fake
time) are tested separately; the status shares the function, so it is tested too.
"""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import app.main as app_main
from app.services import backup as backup_service
from app.services.backup import (
    AUTO_BACKUP_SETTLE_SECONDS,
    get_backup_status,
    next_automatic_backup_at,
)

NOW = datetime(2026, 10, 14, 12, 0, 0, tzinfo=timezone.utc)
H = timedelta(hours=1)
SETTLE = timedelta(seconds=AUTO_BACKUP_SETTLE_SECONDS)


def _put(folder: Path, kind: str, at: datetime, mtime: datetime | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / f"{kind}_{at.strftime('%Y%m%d_%H%M%S')}.mmbackup"
    p.write_bytes(b"PK")
    ts = (mtime or at).timestamp()
    os.utime(p, (ts, ts))
    return p


# ── the one function ────────────────────────────────────────────────────────


def test_no_automatic_backup_is_due_now(tmp_path):
    assert next_automatic_backup_at(tmp_path / "missing", 4, now=NOW) == NOW
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW


def test_a_fresh_one_is_due_an_interval_after_it_was_taken(tmp_path):
    _put(tmp_path, "auto", NOW - H)
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW + 3 * H


def test_an_overdue_one_is_due_now_never_in_the_past(tmp_path):
    _put(tmp_path, "auto", NOW - 30 * H)
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW


@pytest.mark.parametrize("kind", ["shutdown", "manual", "pre_restore", "pre_withdrawal"])
def test_only_automatic_backups_count(tmp_path, kind):
    """`shutdown` would let quit-and-relaunch starve the automatic set; `manual` keeps
    2 and `pre_restore` never rotates — none of them is the automatic window."""
    _put(tmp_path, "auto", NOW - 10 * H)
    _put(tmp_path, kind, NOW - 0.1 * H)
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW


def test_a_future_stamp_cannot_postpone(tmp_path):
    """A clamp on the SLEEP did not stop this: the loop re-reads the folder and finds
    the 2030 file every time it wakes."""
    _put(tmp_path, "auto", datetime(2030, 1, 1, tzinfo=timezone.utc))
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW
    _put(tmp_path, "auto", NOW - H)
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW + 3 * H


def test_a_copied_folder_is_judged_by_the_name_not_the_copy_time(tmp_path):
    """Every mtime = the copy (now); the newest automatic backup was TAKEN two days ago."""
    _put(tmp_path, "auto", NOW - 48 * H, mtime=NOW)
    assert next_automatic_backup_at(tmp_path, 4, now=NOW) == NOW


def test_off_means_none(tmp_path):
    _put(tmp_path, "auto", NOW - H)
    assert next_automatic_backup_at(tmp_path, 0, now=NOW) is None


def test_the_loops_own_wait_is_honoured(tmp_path):
    assert next_automatic_backup_at(tmp_path, 4, now=NOW, not_before=NOW + 0.08 * H) == NOW + 0.08 * H


# ── the loop, on a fake clock ───────────────────────────────────────────────


class _Stop(Exception):
    pass


class Harness:
    def __init__(self, tmp_path, monkeypatch, *, turn_result="ok", max_sleeps=8, start=NOW):
        self.now = start
        self.folder = tmp_path / "b"
        self.folder.mkdir(exist_ok=True)
        self.sleeps: list[float] = []
        self.turns: list[datetime] = []
        self.turn_result = turn_result
        self.max_sleeps = max_sleeps
        self.on_sleep = None
        monkeypatch.setattr(app_main.get_settings(), "auto_backup_interval_hours", 4)
        monkeypatch.setattr(app_main, "get_backup_dir", lambda: self.folder)
        monkeypatch.setattr(app_main, "_auto_backup_turn", self._turn)
        monkeypatch.setattr(backup_service, "_auto_backup_not_before", None)

    async def _turn(self, settings):
        self.turns.append(self.now)
        if self.turn_result == "ok":
            _put(self.folder, "auto", self.now)
            return 4 * 3600
        if self.turn_result == "busy":
            self.turn_result = "ok"
            return 300.0
        return 4 * 3600  # failed: nothing written

    async def _sleep(self, seconds):
        if len(self.sleeps) >= self.max_sleeps:
            raise _Stop
        assert seconds > 0, f"a hot loop: slept {seconds}"
        self.sleeps.append(seconds)
        self.now += timedelta(seconds=seconds)
        if self.on_sleep:
            self.on_sleep(self)

    def run(self):
        with pytest.raises(_Stop):
            asyncio.run(app_main._auto_backup_loop(sleep=self._sleep, clock=lambda: self.now))


def test_a_fresh_backup_at_launch_takes_nothing_at_the_settle(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, max_sleeps=2)
    _put(h.folder, "auto", NOW - H)
    h.run()
    assert h.sleeps == [SETTLE.total_seconds(), (3 * H - SETTLE).total_seconds()]
    assert h.turns == [NOW + 3 * H]  # when the fresh one is an interval old, not at the settle


def test_an_overdue_one_at_launch_takes_exactly_one_after_the_settle(tmp_path, monkeypatch):
    """The Windows case #1186 is about: a short session still takes its backup."""
    h = Harness(tmp_path, monkeypatch, max_sleeps=2)
    _put(h.folder, "auto", NOW - 9 * H)
    h.run()
    assert h.turns == [NOW + SETTLE, NOW + SETTLE + 4 * H]


def test_no_backup_yet_takes_one_after_the_settle(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, max_sleeps=1)
    h.run()
    assert h.turns == [NOW + SETTLE]


def test_backup_now_during_the_wait_postpones_the_next(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, max_sleeps=3)
    _put(h.folder, "auto", NOW - 2 * H)

    def backup_now_at_the_second_wake(hh):
        if len(hh.sleeps) == 2:  # an hour before it was due
            _put(hh.folder, "auto", hh.now - H)
    h.on_sleep = backup_now_at_the_second_wake
    h.run()
    # due at NOW+2h; the Backup now (taken at NOW+1h) moved it to NOW+5h
    assert h.sleeps == [SETTLE.total_seconds(), (2 * H - SETTLE).total_seconds(), 3 * 3600.0]
    assert h.turns == [NOW + 5 * H]


def test_a_failed_turn_waits_its_delay_and_never_spins(tmp_path, monkeypatch):
    """A failed backup writes nothing, so the folder still says "due" — re-read at once,
    a full disk would back up in a tight loop (#1043's 640 backups)."""
    h = Harness(tmp_path, monkeypatch, turn_result="fail", max_sleeps=4)
    h.run()
    assert len(h.turns) == 4 and h.sleeps[1:] == [4 * 3600] * 3


def test_a_busy_turn_is_retried_in_minutes_then_taken(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, turn_result="busy", max_sleeps=2)
    h.run()
    assert h.turns == [NOW + SETTLE, NOW + SETTLE + timedelta(seconds=300)]


def test_an_unreadable_folder_does_not_end_the_loop(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, max_sleeps=1)

    def broken(*a, **k):
        raise PermissionError("denied")
    monkeypatch.setattr(backup_service, "next_automatic_backup_at", broken)
    h.run()
    assert len(h.turns) == 1, "the folder could not be read and the turn never ran"


def test_ten_launches_in_an_hour_take_one(tmp_path, monkeypatch):
    """#920's failure, for a --reload storm or a relauncher: one per interval, never one
    per launch — which would replace the whole automatic window in five launches."""
    total = 0
    for i in range(10):
        h = Harness(tmp_path, monkeypatch, max_sleeps=1, start=NOW + timedelta(minutes=6 * i))
        if i == 0:
            _put(h.folder, "auto", NOW - 9 * H)
        h.run()  # each "launch" lives just past its settle
        total += len(h.turns)
    assert total == 1


def test_the_loop_publishes_its_wait_and_clears_it(tmp_path, monkeypatch):
    h = Harness(tmp_path, monkeypatch, max_sleeps=1)
    seen = []
    h.on_sleep = lambda hh: seen.append(backup_service._auto_backup_not_before)
    h.run()
    assert seen == [NOW + SETTLE]
    assert backup_service._auto_backup_not_before is None, "a stopped loop left its wait behind"


# ── the status states the same answer ───────────────────────────────────────


def test_the_status_says_one_is_due_and_a_manual_backup_does_not_postpone_it(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_service, "_auto_backup_not_before", None)
    assert get_backup_status(tmp_path / "none", interval_hours=4).next_backup_at is not None
    _put(tmp_path, "manual", datetime.now(timezone.utc) - 0.1 * H)
    nxt = datetime.fromisoformat(get_backup_status(tmp_path, interval_hours=4).next_backup_at)
    assert nxt <= datetime.now(timezone.utc) + timedelta(seconds=5), "a manual backup postponed the automatic one"


def test_the_status_says_the_settle_not_now(tmp_path, monkeypatch):
    """Overdue at launch, the backup comes at the end of the settle — "now" would be a
    promise the loop is not keeping."""
    real = datetime.now(timezone.utc)
    monkeypatch.setattr(backup_service, "_auto_backup_not_before", real + timedelta(minutes=2))
    s = get_backup_status(tmp_path, interval_hours=4)
    assert abs((datetime.fromisoformat(s.next_backup_at) - (real + timedelta(minutes=2))).total_seconds()) < 1
