"""#1257 — a hostile M4A cannot hang the duration probe (tinytag CVE-2026-104266).

tinytag before 2.3.0 loops forever on an M4A whose `----` (freeform) atom holds a
sub-atom declaring size 0: it computes `size - 8 = -8` and seeks back onto the header
it just read. `_probe_duration` hands an `m4a` to tinytag whenever our own `moov/mvhd`
walker cannot read it, and two doors reach that: a recording attached through the media
routes, and the duration backfill that startup WAITS for on every launch — so one such
file could have stopped the app from starting at all.

The probe runs in a CHILD PROCESS with a timeout, because a regression here is an
infinite loop: in-process it would hang the suite instead of failing it. Verified both
ways when written: under tinytag 2.2.1 the child is killed by the timeout; under 2.3.2
it answers `None` at once.
"""
from __future__ import annotations

import os
import struct
import subprocess
import sys
from pathlib import Path

from app.services.media_duration import _mp4_duration

BACKEND = Path(__file__).resolve().parents[1]
TIMEOUT_SECONDS = 30


def _atom(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def _hostile_m4a(path: Path) -> Path:
    """`ftyp` + `moov/udta/meta/ilst/----` holding one sub-atom of declared size 0.
    No `mvhd`, so our walker answers None and the file goes on to tinytag."""
    freeform = _atom(b"----", struct.pack(">I", 0) + b"abcd")
    meta = _atom(b"meta", b"\x00\x00\x00\x00" + _atom(b"ilst", freeform))
    moov = _atom(b"moov", _atom(b"udta", meta))
    ftyp = _atom(b"ftyp", b"M4A " + b"\x00\x00\x00\x00" + b"M4A isom")
    path.write_bytes(ftyp + moov + b"\x00" * 64)
    return path


def test_a_hostile_m4a_returns_no_duration_instead_of_hanging(tmp_path):
    hostile = _hostile_m4a(tmp_path / "hostile.m4a")
    # Precondition, asserted rather than assumed: our own walker cannot read it, so
    # the probe reaches tinytag — the only path the advisory concerns.
    assert _mp4_duration(hostile) is None

    env = {
        **os.environ,
        "MM_DATABASE_PATH": ":memory:",
        "MM_DATA_DIR": str(tmp_path / "data"),
        "MM_BACKUP_DIR": str(tmp_path / "backups"),
    }
    code = (
        "import sys; from pathlib import Path; "
        "from app.services.media_duration import _extract_duration; "
        "print(_extract_duration(Path(sys.argv[1]), 'm4a'))"
    )
    try:
        done = subprocess.run(
            [sys.executable, "-c", code, str(hostile)],
            cwd=BACKEND, env=env, capture_output=True, text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise AssertionError(
            f"the duration probe did not return within {TIMEOUT_SECONDS} s on a hostile "
            "M4A — tinytag is below 2.3.0 (CVE-2026-104266, #1257)"
        ) from None
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "None"
