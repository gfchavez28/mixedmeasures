"""Who may be in the database while a restore replaces it (#1024).

A restore swaps the database FILE underneath a running server. A connection opened
before the swap keeps the file it opened: on POSIX the rename leaves it on the old
inode, so after the restore it serves pre-restore data and writes into a file that no
longer has a name. EXECUTED 2026-09-24 (the audit's reproduction): a request made
after the restore read *"AFTER THE BACKUP"*, and the restored file on disk never
received its write — an edit lost after the researcher was told the restore had
succeeded. On Windows the same open connection holds the `-wal`, so the swap itself
fails halfway (reasoned, not run).

🔴 **Disposing the connection pool does not fix this in either order, on its own.**
Before the swap it closes the connections that exist; every request arriving DURING
the restore — which begins with a full pre-restore backup, seconds to minutes — opens
a new one against the old file. The 30-second consensus sweep alone opens one on every
install. So this module decides who may be in the database at all:

- every HTTP request that can reach it holds a SLOT for its whole life, response body
  included (`DatabaseGateMiddleware`), and is refused with a 503 while a restore runs;
- each background writer — the 4-hourly backup, the consensus sweep, the quit backup —
  takes a slot for its turn and SKIPS the turn while a restore runs;
- a restore takes the gate EXCLUSIVELY: it stops admitting, waits for the slots already
  held to be released, and only then may it dispose the pool and swap the file.

⚠️ **A restore arrives as a request, so it holds a slot itself** — which is right: its
own dependencies (the session lookup) read the database before its body runs, and a
second restore must wait for them too. `exclusive()` therefore waits for every slot
EXCEPT its caller's, which it learns from `_HOLDS_SLOT`. That is a context variable
set by the middleware, and it reaches the worker thread a sync endpoint runs in:
MEASURED 2026-09-24 on anyio 4.12.1 / Starlette 1.6.0, both `run_in_threadpool` and
`asyncio.to_thread` carry it. If a future runtime stopped carrying it, a restore would
wait for its own slot, time out, and refuse — loudly, with nothing changed.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

#: How long a restore waits for work already running — an import, an export, a
#: download, the 4-hourly backup — before it gives up. Nothing has been changed when
#: it gives up, and new requests are refused for the whole wait, which is why it is
#: bounded at all.
RESTORE_DRAIN_TIMEOUT_SECONDS = 60.0

#: The answer to a request that arrives while a restore is running.
RESTORING_MESSAGE = (
    "Mixed Measures is restoring a backup, so nothing can be read or saved until it "
    "finishes. Try again in a moment."
)

#: The answer when a restore could not start because other work would not finish.
BUSY_MESSAGE = (
    "The restore did not start because Mixed Measures is still finishing other work — "
    "an import, an export, a download or an automatic backup. Nothing was changed. "
    "Wait for that to finish, then restore again."
)

#: The answer to a second restore while one is running.
ALREADY_RESTORING_MESSAGE = (
    "A restore is already running. Nothing else was started; wait for it to finish."
)

#: Set by the middleware for the life of a request that holds a slot.
_HOLDS_SLOT: ContextVar[bool] = ContextVar("mm_db_gate_holds_slot", default=False)


class RestoreInProgress(RuntimeError):
    """Refused: a restore is replacing the database right now."""


class RestoreRefused(RuntimeError):
    """A restore could not take the gate, and nothing was changed.

    `reason` is `"already_restoring"` or `"busy"` — two different facts with two
    different remedies, so the router can say which — or `"restoring_elsewhere"`,
    raised by `backup.restore_from_backup` when ANOTHER PROCESS holds the restore
    lock (#1142): this gate is per process, and that lock is what spans them.
    """

    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason


class DatabaseGate:
    """A count of who is in the database, and a flag that stops admitting.

    One `threading.Condition` guards both. `try_enter` / `leave` hold its lock for a
    few instructions, so the middleware may call them from the event loop; only
    `exclusive` waits, and `Condition.wait` releases the lock while it does.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._active = 0
        self._restoring = False

    @property
    def restoring(self) -> bool:
        with self._cond:
            return self._restoring

    @property
    def active(self) -> int:
        with self._cond:
            return self._active

    def try_enter(self) -> bool:
        """Take a slot, or answer False while a restore is running."""
        with self._cond:
            if self._restoring:
                return False
            self._active += 1
            return True

    def leave(self) -> None:
        with self._cond:
            self._active -= 1
            self._cond.notify_all()

    @contextmanager
    def activity(self) -> Iterator[None]:
        """Hold a slot for a block, or raise `RestoreInProgress`."""
        if not self.try_enter():
            raise RestoreInProgress(RESTORING_MESSAGE)
        try:
            yield
        finally:
            self.leave()

    @contextmanager
    def exclusive(self, timeout: float | None = None) -> Iterator[None]:
        """Stop admitting, wait for every other slot to be released, then yield.

        Raises `RestoreRefused` without changing anything when a restore already
        holds the gate, or when the other slots are not released within `timeout`
        (default `RESTORE_DRAIN_TIMEOUT_SECONDS`, read at call time).
        """
        if timeout is None:
            timeout = RESTORE_DRAIN_TIMEOUT_SECONDS
        own = 1 if _HOLDS_SLOT.get() else 0
        with self._cond:
            if self._restoring:
                raise RestoreRefused(ALREADY_RESTORING_MESSAGE, "already_restoring")
            self._restoring = True
            if not self._cond.wait_for(lambda: self._active <= own, timeout):
                self._restoring = False
                self._cond.notify_all()
                raise RestoreRefused(BUSY_MESSAGE, "busy")
        try:
            yield
        finally:
            with self._cond:
                self._restoring = False
                self._cond.notify_all()


#: The one gate. A module global because the thing it guards — the engine in
#: `app.database` — is one too.
db_gate = DatabaseGate()


def touches_database(path: str) -> bool:
    """Every path whose handler can open a database connection.

    `/api/*`, and `/health`, which runs `SELECT 1` — outside `/api`, so a gate on the
    API prefix alone would leave it opening a connection mid-swap. The SPA shell and
    its assets read no database.
    """
    return path.startswith("/api/") or path == "/health"


class DatabaseGateMiddleware:
    """Hold a gate slot for each request that can reach the database (#1024).

    ⚠️ **A plain ASGI middleware, not `BaseHTTPMiddleware`**, because the slot must
    last until the RESPONSE BODY has been sent: `call_next` returns when the headers
    are ready, and a download is still streaming after that. `await self.app(...)`
    returns when the whole response is out, dependency teardown included.
    """

    def __init__(self, app: ASGIApp, gate: DatabaseGate = db_gate) -> None:
        self.app = app
        self.gate = gate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not touches_database(scope["path"]):
            await self.app(scope, receive, send)
            return
        if not self.gate.try_enter():
            response = JSONResponse(
                {"detail": RESTORING_MESSAGE},
                status_code=503,
                headers={"Retry-After": "5"},
            )
            await response(scope, receive, send)
            return
        token = _HOLDS_SLOT.set(True)
        try:
            await self.app(scope, receive, send)
        finally:
            _HOLDS_SLOT.reset(token)
            self.gate.leave()
