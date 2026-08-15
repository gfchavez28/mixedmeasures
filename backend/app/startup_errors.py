"""Fatal startup failures, and the one channel that carries them to the user (#716).

## The problem this solves

The startup migration is the only destructive path in the app, and #692 correctly
made a failed pre-migration backup REFUSE to migrate, raising a message written for
a human: *"Could not create the pre-migration backup at ⟨path⟩: ⟨reason⟩. No
migration was applied and your data is untouched. Free up disk space (or fix
permissions on ⟨dir⟩) and relaunch."*

That text went to stderr. In the packaged app the backend is a spawned child, so the
researcher saw only *"The local engine exited unexpectedly."* Every natural response
to that — reinstall, delete the data folder, restore an old copy — is worse than the
actual situation, which is that their data is fine and they need to free some disk.

## Why a prefix rather than the alternatives

Measured, not assumed: a lifespan failure exits **3** (not 1), and uvicorn logs the
exception as a multi-line traceback with absolute source paths through its own
`ERROR:` formatter. So:

- **Dumping raw stderr** into the dialog would show that traceback. Wrong for a user.
- **An exit-code table** invents a contract for two toolchains to drift apart on —
  this repo already has a documented case of each side validating its own half while
  both stayed green (arch-debt Seam B).
- A **marker prefix** carries exactly the text we authored, and nothing else.

## Membership is structural, not a list

`FatalStartupError` is the registry. A new member joins by SUBCLASSING, so it cannot
be added without the reporter noticing it — the #515/#676 lesson (pin the
relationship, never enumerate the variants you happen to know about).
"""
import sys
from typing import TextIO

#: The marker Electron scans stderr for. Deliberately unlike anything a library logs.
MM_FATAL_PREFIX = "MM-FATAL: "

#: Beyond this the dialog stops being readable. A pathological ``str(exc)`` (a driver
#: echoing a query, say) must not produce a wall of text the user cannot dismiss past.
MAX_FATAL_MESSAGE_CHARS = 800

#: Characters that would break the line-oriented channel (or render as garbage in a
#: dialog), mapped to a plain space. Deliberately NARROW — see `fatal_startup_message`.
_LINE_SAFE = str.maketrans(
    {
        **{c: " " for c in range(0x20)},  # C0 controls: \t \n \r \v \f and friends
        0x7F: " ",  # DEL
        0x85: " ",  # NEL — a line break to `str.split()`, invisible to a human
        0x2028: " ",  # LINE SEPARATOR
        0x2029: " ",  # PARAGRAPH SEPARATOR
    }
)


class FatalStartupError(Exception):
    """Startup cannot continue, and this exception's message is written FOR the user.

    Subclass this when the failure has a recovery step a researcher can actually take
    — the packaged app shows `str(exc)` **verbatim** in its crash dialog, so the
    message must read as guidance ("free up disk space and relaunch"), not as a
    diagnostic ("sqlite3.OperationalError: disk I/O error").

    Anything NOT deriving from this still gets a marker line, but framed honestly as
    an unexpected failure rather than as advice — see `fatal_startup_message`.
    """


def fatal_startup_message(exc: BaseException) -> str:
    """The single line of user-facing text for a startup failure.

    ONE line by construction: the Electron side is line-oriented, so an embedded
    newline would truncate the message at the split.

    ⚠️ This used to be `" ".join(text.split())`, and a bare `str.split()` collapses
    **29 Unicode whitespace characters**, not the handful that break the channel —
    including **U+00A0 NO-BREAK SPACE** and the U+2000–U+200A spaces, which are legal
    in a Windows folder name and arrive here inside a real path. A researcher whose
    project folder contains one saw it silently become a plain space, so the path in
    the dialog named a directory that does not exist. The reader splits on `\\r?\\n`,
    so the requirement is only "no line breaks"; `_LINE_SAFE` maps exactly the
    control/separator characters and leaves every printable space alone. Runs of
    ASCII space are then collapsed by splitting on `" "` **explicitly** — the
    argument-less form is the bug.

    A `FatalStartupError` speaks for itself. Anything else is framed as unexpected and
    keeps its type name and message: a bare "Mixed Measures could not start" helps
    nobody, and a one-line `str(exc)` is a diagnostic, not a stack trace — the thing
    worth keeping out of the dialog is the traceback, and that never reaches here.
    """
    if isinstance(exc, FatalStartupError):
        text = str(exc)
    else:
        detail = str(exc).strip()
        text = f"Mixed Measures could not start. {type(exc).__name__}"
        text = f"{text}: {detail}" if detail else f"{text}."

    text = " ".join(part for part in text.translate(_LINE_SAFE).split(" ") if part)
    if len(text) > MAX_FATAL_MESSAGE_CHARS:
        text = text[: MAX_FATAL_MESSAGE_CHARS - 1].rstrip() + "…"
    return text


def _write_marker_line(out: TextIO, line: str) -> None:
    """Put `line` on `out` as **UTF-8**, whatever `out`'s own text encoding is.

    ## Why this cannot be left to the interpreter (#762)

    `electron/backend-process.js` sets `PYTHONIOENCODING=utf-8` on the spawn env and
    a unit test proves the dict contains it. **The frozen backend ignores it.**
    Measured against the shipped v1.3.1 `mm-backend.exe` on Windows, and reproduced
    in a minimal PyInstaller build, with the variable confirmed present in the
    child's own `os.environ`::

        env_PYTHONIOENCODING = 'utf-8'   →   sys.stderr.encoding = 'cp1252'

    `PYTHONUTF8=1` and `PYTHONLEGACYWINDOWSSTDIO=1` are ignored too, and
    `sys.flags.utf8_mode` stays 0 — PyInstaller configures the interpreter's stdio
    itself, so no environment variable can fix this from the outside. The env pin is
    kept (it is still correct for an unfrozen backend) but it is NOT what makes the
    channel safe; this function is.

    ## Why the failure was invisible

    `sys.stderr` defaults to ``errors='backslashreplace'``, so the existing guard
    covers a character cp1252 **cannot** encode (`李明` → a literal ``\\u674e\\u660e``,
    ugly but obviously wrong). A Latin-1 character it **can** encode is worse: `É`
    goes out as the single byte ``0xC9``, which is not valid UTF-8, so the reader's
    `StringDecoder` yields U+FFFD and the path silently names nowhere. Both halves
    stayed green because each side validated its own encoding.

    We own both ends of this channel, so we encode it ourselves and hand bytes to the
    byte layer. `errors="backslashreplace"` covers the one string UTF-8 cannot encode:
    a lone surrogate, which Windows paths can carry via `surrogatepass`.

    ⚠️ `out.flush()` FIRST — the text layer may hold buffered output, and bytes
    written underneath it would otherwise land ahead of text queued before them.
    ⚠️ A stream with no `.buffer` (a `StringIO` under test) has no byte layer to use,
    so the text write is the honest fallback rather than a silent no-op.
    """
    buffer = getattr(out, "buffer", None)
    if buffer is None:
        out.write(line)
        out.flush()
        return
    out.flush()
    buffer.write(line.encode("utf-8", "backslashreplace"))
    buffer.flush()


def emit_fatal_startup(exc: BaseException, stream: TextIO | None = None) -> None:
    """Write the marker line to stderr. Never raises, never masks `exc`.

    Deliberately NOT routed through `logging`. A fatal message must not depend on the
    logging configuration being correct, and #631 is the reason that is not paranoia:
    alembic's `fileConfig` disabled all 31 `app.*` loggers on every boot for months,
    silencing exactly this class of caught-and-reported failure. A direct write also
    guarantees the marker reaches the line unprefixed by a formatter.

    The leading newline is for the human reading a terminal — it separates the fatal
    from whatever partial line preceded it. It is NOT what makes parsing correct; the
    reader searches for the marker anywhere in a line, so glued output still resolves.

    `stream` is an injection point for tests. When it is None we re-read `sys.stderr`
    at call time rather than binding it as a default, because **a PyInstaller windowed
    build has `sys.stderr = None`** — the spec still says `console=True` today, and
    its own comment says "flip to False later", so this guard is a live concern rather
    than a hypothetical one.
    """
    out = stream if stream is not None else sys.stderr
    if out is None:
        return
    try:
        _write_marker_line(out, f"\n{MM_FATAL_PREFIX}{fatal_startup_message(exc)}\n")
    except Exception:  # noqa: BLE001
        # This runs while `exc` is propagating. A failure to REPORT must never
        # replace the failure being reported — the user would lose the real cause
        # and gain a meaningless one.
        pass
