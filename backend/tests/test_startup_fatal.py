"""#716 — a fatal startup error's recovery instructions must reach the user.

The failure mode this guards is not a wrong value, it is a message that goes
nowhere: #692 raises text telling a researcher to free disk space and relaunch,
and in the packaged app the only visible symptom was "the local engine exited
unexpectedly". Everything below pins the contract that carries it out.

⚠️ What these tests CANNOT prove: that the dialog appears. The backend is a spawned
child only in the packaged build, so the last mile is a packaged-build check that
rides the next cut — the DEV ≠ SHIPPED rule. What is provable here is that the
marker is emitted, that it is one line, and that the family is defined structurally.
"""
import io
import re
from pathlib import Path

import pytest

from app.database import DatabaseUnreadableError, PreMigrationBackupError
from app.startup_errors import (
    MAX_FATAL_MESSAGE_CHARS,
    MM_FATAL_PREFIX,
    FatalStartupError,
    emit_fatal_startup,
    fatal_startup_message,
)


def _all_subclasses(cls: type) -> list[type]:
    """Every descendant, not just the direct children (#724).

    `type.__subclasses__()` is one level deep. A test that derives its coverage from it
    silently stops covering the moment someone subclasses a subclass.
    """
    out: list[type] = []
    for sub in cls.__subclasses__():
        out.append(sub)
        out.extend(_all_subclasses(sub))
    return out


class TestFamilyMembership:
    """The registry is the class hierarchy, not a list someone must remember.

    Pin the RELATIONSHIP, not the variants (#515 → #676): a list of "the two errors
    we know about" is the shape that goes stale the moment a third arrives.
    """

    def test_the_known_fatal_errors_are_members(self):
        assert issubclass(PreMigrationBackupError, FatalStartupError)
        assert issubclass(DatabaseUnreadableError, FatalStartupError)

    def test_every_member_speaks_for_itself(self):
        """Whatever subclasses join later, their own message is what the user sees.

        Derived from the class tree rather than enumerated, so a new member is covered
        on the day it is written and nobody has to find this file.

        ⚠️ **Recursively** (#724). `__subclasses__()` returns DIRECT children only, so a
        narrower error subclassing `PreMigrationBackupError` — the obvious way to add
        one — would have been silently uncovered. That is the same shape as the arity
        lesson this test exists to apply: pin the RELATIONSHIP, not the depth you
        happen to have today.
        """
        members = _all_subclasses(FatalStartupError)
        assert members, "the family should not be empty — did the base class move?"
        for cls in members:
            msg = fatal_startup_message(cls("free up disk space and relaunch"))
            assert msg == "free up disk space and relaunch", (
                f"{cls.__name__} must surface its OWN message verbatim — that is what "
                f"FatalStartupError membership promises"
            )

    def test_the_walk_reaches_grandchildren(self):
        """The guard for the guard (#724).

        The assertion on the last line is the point: it states exactly what the old
        one-level `__subclasses__()` scan could not see, so this cannot regress quietly
        back to it.
        """

        class _Intermediate(FatalStartupError):
            pass

        class _Narrower(_Intermediate):
            pass

        found = _all_subclasses(FatalStartupError)
        assert _Intermediate in found
        assert _Narrower in found, "a subclass of a subclass must still be covered"
        assert _Narrower not in FatalStartupError.__subclasses__()

    def test_a_member_stays_catchable_as_a_plain_exception(self):
        """The base was inserted under existing classes; nothing may have narrowed."""
        with pytest.raises(Exception):
            raise PreMigrationBackupError("boom")


class TestMessageShape:
    def test_a_family_message_is_passed_through_verbatim(self):
        text = (
            "Could not create the pre-migration backup at /b/mm.db: [Errno 28] No "
            "space left on device. No migration was applied and your data is "
            "untouched. Free up disk space (or fix permissions on /b) and relaunch."
        )
        assert fatal_startup_message(PreMigrationBackupError(text)) == text

    def test_an_unexpected_error_is_framed_as_unexpected_and_keeps_its_detail(self):
        msg = fatal_startup_message(PermissionError("[Errno 13] denied: '/data/docs'"))
        assert msg.startswith("Mixed Measures could not start. PermissionError:")
        # The path is what makes it actionable — a bare type name helps nobody.
        assert "/data/docs" in msg

    def test_an_unexpected_error_with_no_message_still_reads_as_a_sentence(self):
        assert fatal_startup_message(RuntimeError()) == "Mixed Measures could not start. RuntimeError."

    def test_the_message_is_always_ONE_line(self):
        """The reader is line-oriented, so an embedded newline truncates the message.

        A DB driver echoing a multi-line statement is the realistic source.
        """
        msg = fatal_startup_message(RuntimeError("first line\nsecond line\r\n\tthird"))
        assert "\n" not in msg and "\r" not in msg and "\t" not in msg
        assert "second line" in msg and "third" in msg

    def test_a_runaway_message_is_capped(self):
        msg = fatal_startup_message(PreMigrationBackupError("x" * 5000))
        assert len(msg) <= MAX_FATAL_MESSAGE_CHARS
        assert msg.endswith("…")


class TestEmission:
    def test_the_marker_line_is_written_and_flushed(self):
        buf = io.StringIO()
        emit_fatal_startup(PreMigrationBackupError("free up disk space"), stream=buf)
        out = buf.getvalue()
        assert MM_FATAL_PREFIX in out
        marked = [ln for ln in out.splitlines() if MM_FATAL_PREFIX in ln]
        assert marked == [f"{MM_FATAL_PREFIX}free up disk space"]

    def test_the_marker_starts_its_own_line(self):
        """A leading newline separates it from any partial line before it."""
        buf = io.StringIO()
        buf.write("Waiting for application startup.")
        emit_fatal_startup(RuntimeError("boom"), stream=buf)
        line = [ln for ln in buf.getvalue().splitlines() if MM_FATAL_PREFIX in ln][0]
        assert line.startswith(MM_FATAL_PREFIX)

    def test_a_missing_stderr_is_survivable(self):
        """PyInstaller's windowed mode sets `sys.stderr = None`.

        The spec says `console=True` today AND "flip to False later" in the same
        line, so this is a live concern, not a hypothetical one. Reporting must
        never be the thing that crashes.
        """
        import app.startup_errors as mod

        real, mod.sys.stderr = mod.sys.stderr, None
        try:
            emit_fatal_startup(RuntimeError("boom"))  # must not raise
        finally:
            mod.sys.stderr = real

    def test_a_broken_stream_never_masks_the_original_failure(self):
        class Exploding(io.StringIO):
            def write(self, _):  # noqa: D102
                raise OSError("pipe closed")

        emit_fatal_startup(PreMigrationBackupError("boom"), stream=Exploding())


class TestCrossLanguageContract:
    """The marker is hand-mirrored in two languages with NO codegen.

    That is the Seam B shape this repo already has a documented case of: each side's
    suite validates only its own half, so a drift in either constant leaves **both
    green** while the packaged app silently falls back to "the local engine exited
    unexpectedly" forever — and the only place that failure is visible is a packaged
    build. This is the one test that can see both sides at once.
    """

    def _reader_source(self, strip_comments: bool = False) -> str:
        js = Path(__file__).resolve().parents[2] / "electron" / "fatal-error.js"
        assert js.exists(), (
            f"expected the Electron reader at {js} — if it moved, this contract test "
            f"must follow it, not be deleted"
        )
        source = js.read_text(encoding="utf-8")
        if strip_comments:
            # ⚠️ This scan FAILED on its first run by matching its own documentation:
            # the docblock explaining why `String(chunk)` is banned contains
            # `String(chunk)`. Same trap as the three #717/#718 guards. Strip the prose
            # rather than weaken the assertion — a guard that flags the comment
            # explaining it is how guards get deleted.
            source = re.sub(r"/\*[\s\S]*?\*/", " ", source)
            source = re.sub(r"//[^\n]*", " ", source)
        return source

    def test_the_electron_reader_uses_the_same_marker(self):
        found = re.search(r"^const MM_FATAL_PREFIX = '([^']*)'", self._reader_source(), re.M)
        assert found, "MM_FATAL_PREFIX literal not found in electron/fatal-error.js"
        assert found.group(1) == MM_FATAL_PREFIX, (
            "the backend and the Electron reader disagree about the marker — the crash "
            "dialog would show the generic text for every fatal startup error"
        )

    def test_the_reader_decodes_utf8_rather_than_per_chunk(self):
        """#723: the reader must hold an incomplete multi-byte sequence back.

        Pinned here as well as in `electron/fatal-error.test.js` because the PRODUCER
        of the non-ASCII text is Python: this file's messages interpolate a filesystem
        path, and nothing on the backend side would otherwise notice that the reader
        had gone back to decoding each chunk on its own.
        """
        source = self._reader_source(strip_comments=True)
        assert "StringDecoder" in source, "the reader must decode with StringDecoder (#723)"
        assert "String(chunk)" not in source, (
            "per-chunk String() decoding is the #723 defect — a multi-byte character "
            "split across a pipe boundary becomes replacement characters"
        )


class TestNonAsciiSurvivesTheMarkerLine:
    """Why `PYTHONIOENCODING=utf-8` is pinned in the Electron spawn env.

    The message interpolates a real filesystem path, and a Windows profile directory
    is routinely non-ASCII. This does not raise — `sys.stderr` defaults to
    ``errors='backslashreplace'`` — which is worse than a crash, because the line
    still arrives and the path inside it is silently unusable.
    """

    PATH_MSG = "Could not create the pre-migration backup at C:\\Users\\李明\\backups."

    def _emit_through(self, encoding: str) -> str:
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding=encoding, errors="backslashreplace", newline="")
        emit_fatal_startup(PreMigrationBackupError(self.PATH_MSG), stream=stream)
        stream.flush()
        return raw.getvalue().decode(encoding, errors="replace")

    def test_a_utf8_stream_carries_the_path_intact(self):
        assert self.PATH_MSG in self._emit_through("utf-8")

    def test_a_legacy_windows_codepage_mangles_it_silently(self):
        """The failure mode the env var exists to prevent — pinned, not assumed."""
        out = self._emit_through("cp1252")
        assert MM_FATAL_PREFIX in out, "the line still arrives, which is what makes this quiet"
        assert "李明" not in out
        assert "\\u674e\\u660e" in out, (
            "expected backslashreplace escapes — if this changed, re-check whether "
            "PYTHONIOENCODING is still the right fix"
        )


class TestLifespanReportsBeforeItReraises:
    """The wiring, not just the helper: a startup failure must be REPORTED and RAISED.

    Reported so the user learns the cause; re-raised so uvicorn still refuses to
    serve. Swallowing it would be far worse than the bug being fixed — the app would
    come up on a database whose migration had been refused.
    """

    def test_a_startup_failure_is_marked_then_propagated(self, monkeypatch, capsys):
        import asyncio

        import app.main as app_main

        def boom():
            raise PreMigrationBackupError("Free up disk space and relaunch.")

        monkeypatch.setattr(app_main, "run_migrations", boom)

        async def drive():
            async with app_main.lifespan(app_main.app):
                pass  # pragma: no cover — startup must fail before the body runs

        with pytest.raises(PreMigrationBackupError):
            asyncio.run(drive())

        err = capsys.readouterr().err
        assert f"{MM_FATAL_PREFIX}Free up disk space and relaunch." in err
