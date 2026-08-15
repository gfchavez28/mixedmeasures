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
    """The marker line is UTF-8 **bytes** on the wire, whatever the stream's encoding.

    #762: `PYTHONIOENCODING=utf-8` in the Electron spawn env does NOT reach the frozen
    interpreter. Measured against the shipped v1.3.1 `mm-backend.exe` and reproduced in
    a minimal PyInstaller build — the variable is present in the child's `os.environ`
    and `sys.stderr.encoding` is `cp1252` anyway. So the emitter encodes the line
    itself; these assert the BYTES, because a string assertion cannot see the defect.
    """

    #: A character cp1252 CANNOT encode → backslashreplace escapes (visibly wrong).
    CJK_MSG = "Could not create the pre-migration backup at C:\\Users\\李明\\backups."
    #: A character cp1252 CAN encode → a lone 0xC9 byte. THIS is the one that shipped:
    #: it is not valid UTF-8, so the reader's StringDecoder yields U+FFFD and the path
    #: silently names nowhere. The suite had no Latin-1 case at all before #762.
    LATIN1_MSG = "Could not create the pre-migration backup at C:\\Users\\gchav\\Évaluation\\backups."

    def _emit_bytes(self, msg: str, encoding: str) -> bytes:
        """Emit through a stream whose TEXT layer uses `encoding` — as PyInstaller's does."""
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding=encoding, errors="backslashreplace", newline="")
        emit_fatal_startup(PreMigrationBackupError(msg), stream=stream)
        stream.flush()
        return raw.getvalue()

    @pytest.mark.parametrize("encoding", ["utf-8", "cp1252", "ascii"])
    @pytest.mark.parametrize("attr", ["CJK_MSG", "LATIN1_MSG"])
    def test_the_bytes_are_utf8_whatever_the_stream_encoding_is(self, encoding, attr):
        msg = getattr(self, attr)
        out = self._emit_bytes(msg, encoding)
        # Decoding as UTF-8 must round-trip the path exactly — no escapes, no U+FFFD.
        assert msg in out.decode("utf-8"), f"path did not survive a {encoding} stream"

    def test_the_latin1_case_is_a_raw_byte_not_an_escape(self):
        """Why the pre-#762 guard could not see this: the two failures differ.

        cp1252 CAN encode É, so there is no backslashreplace escape to notice — just
        one byte that is not UTF-8. Pinned so nobody "simplifies" the two cases into
        one and re-loses the half that shipped.
        """
        text_layer_bytes = self.LATIN1_MSG.encode("cp1252")
        assert b"\xc9" in text_layer_bytes and b"\\u" not in text_layer_bytes
        # ...and that is exactly what the emitter must NOT produce.
        assert b"\xc3\x89" in self._emit_bytes(self.LATIN1_MSG, "cp1252")

    def test_a_stream_with_no_byte_layer_still_gets_the_line(self):
        """A StringIO has no `.buffer`; the text write is the honest fallback."""
        buf = io.StringIO()
        emit_fatal_startup(PreMigrationBackupError(self.LATIN1_MSG), stream=buf)
        assert self.LATIN1_MSG in buf.getvalue()


class TestPathWhitespaceIsNotDestroyed:
    """`str.split()` with no argument eats 29 Unicode whitespace characters (#762).

    A folder name may legitimately contain a NO-BREAK SPACE. Collapsing it to a plain
    space makes the dialog name a directory that does not exist — the same class of
    silent unusability as the encoding half, reached from the other side.
    """

    @pytest.mark.parametrize(
        "char, name",
        [("\u00a0", "NO-BREAK SPACE"), ("\u2007", "FIGURE SPACE"), ("\u202f", "NARROW NBSP")],
    )
    def test_a_printable_space_in_a_path_survives(self, char, name):
        msg = f"Could not create the pre-migration backup at C:\\Users\\My{char}Project\\backups."
        assert char in fatal_startup_message(PreMigrationBackupError(msg)), (
            f"{name} was destroyed — the message now names a folder that does not exist"
        )

    @pytest.mark.parametrize("char", ["\n", "\r", "\t", "\x0b", "\x85", "\u2028"])
    def test_a_line_breaker_is_still_flattened(self, char):
        """The channel is line-oriented, so these must NOT survive — both directions."""
        msg = fatal_startup_message(RuntimeError(f"before{char}after"))
        assert char not in msg
        assert "before after" in msg


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
