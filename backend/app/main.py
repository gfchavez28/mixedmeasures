import asyncio
import logging
import os
import secrets
from pathlib import Path
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from .config import get_settings, get_documents_dir, get_media_dir, get_backup_dir, dist_dir

logger = logging.getLogger(__name__)
from .database import run_migrations, SessionLocal
from .models.user import Session as SessionModel
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse
from .routers import auth, projects, conversations, segments, codes, coding, notes, memos, export, search, participants, dataset, recode, equivalence, code_equivalence, analysis_domains, crosswalk, metrics, materials, code_analysis, statistical_tests, text_coding, text_analysis, excerpts, all_notes, correlations, comparisons, scratchpad, data_quality, quote_board, codebook, documents, backup, project_portability, canvas, audio


def cleanup_expired_sessions():
    """Delete expired sessions on startup to prevent accumulation."""
    db = SessionLocal()
    try:
        deleted = db.query(SessionModel).filter(
            SessionModel.expires_at <= datetime.now(timezone.utc).replace(tzinfo=None)
        ).delete(synchronize_session=False)
        db.commit()
        if deleted:
            logger.info("Cleaned up %d expired session(s)", deleted)
    except Exception:
        db.rollback()
    finally:
        db.close()


async def _auto_backup_loop():
    """Periodic auto-backup loop. Runs as a background task."""
    from .services.backup import create_backup, cleanup_old_backups
    settings = get_settings()
    interval = settings.auto_backup_interval_hours * 3600

    while True:
        await asyncio.sleep(interval)
        try:
            db_path = Path(settings.mm_database_path)
            docs_dir = get_documents_dir()
            media_dir = get_media_dir()
            backup_dir = get_backup_dir()

            if db_path.exists() and db_path.stat().st_size > 0:
                await asyncio.to_thread(
                    create_backup, db_path, docs_dir, media_dir, backup_dir, "auto"
                )
                await asyncio.to_thread(
                    cleanup_old_backups, backup_dir, "auto", settings.auto_backup_max_count
                )
                logger.info("Auto-backup completed")
        except Exception as e:
            logger.warning("Auto-backup failed: %s", e)


def _drain_consensus() -> int:
    """Drain a batch of consensus staleness markers in its own session/txn.

    Runs in a worker thread (its own ``SessionLocal``, never shared across
    threads). Caps the batch so a large backlog drains over several ticks instead
    of one long transaction.
    """
    from .services.consensus_staleness import sweep_stale_consensus
    db = SessionLocal()
    try:
        recomputed = sweep_stale_consensus(db, limit=500)
        db.commit()
        return recomputed
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def _consensus_sweep_loop():
    """Periodic consensus-recompute sweep (Track J · J2-3, Slab 5b).

    Bulk / cascade mutations mark targets stale; this drains them off the request
    path (DEC-C / ADJ-3: write-side, never recompute-on-read). A no-op when there
    are no markers (the common single-coder case). Single background writer, so a
    transient SQLite "database is locked" from a concurrent request write just
    retries next tick — the markers persist until a sweep succeeds.
    """
    interval = 30  # seconds
    while True:
        await asyncio.sleep(interval)
        try:
            recomputed = await asyncio.to_thread(_drain_consensus)
            if recomputed:
                logger.info("Consensus sweep recomputed %d stale target(s)", recomputed)
        except Exception as e:
            logger.warning("Consensus sweep failed: %s", e)


def _shutdown_backup():
    """Create a final backup on graceful shutdown."""
    from .services.backup import create_backup, cleanup_old_backups
    settings = get_settings()
    try:
        db_path = Path(settings.mm_database_path)
        docs_dir = get_documents_dir()
        media_dir = get_media_dir()
        backup_dir = get_backup_dir()

        if db_path.exists() and db_path.stat().st_size > 0:
            create_backup(db_path, docs_dir, media_dir, backup_dir, "auto")
            cleanup_old_backups(backup_dir, "auto", settings.auto_backup_max_count)
            logger.info("Shutdown backup completed")
    except Exception as e:
        logger.warning("Shutdown backup failed: %s", e)


def _check_production_safety():
    """Log warnings if settings look unsafe for a non-dev deployment."""
    settings = get_settings()
    db_path = settings.mm_database_path
    is_dev = db_path in ("dev.db", ":memory:") or db_path.startswith(":memory:")
    if is_dev:
        return

    # A packaged build running with at-rest encryption OFF is a security-relevant
    # state worth logging (e.g. the OS keychain was unavailable and the app fell
    # back to plaintext). This MUST be checked before the mm_packaged early-return
    # below, which otherwise suppresses every non-dev warning in the packaged app —
    # exactly the build where this warning matters.
    if settings.mm_packaged and not settings.mm_encryption_enabled:
        logger.warning(
            "SECURITY: packaged build is running with at-rest encryption DISABLED "
            "(database at %s is plaintext). Expected only when the OS keychain is "
            "unavailable; see the at-rest encryption note in SECURITY.md.", db_path,
        )

    # Packaged desktop app: loopback-only HTTP is correct (cookie_secure=False is
    # right for http://127.0.0.1, CORS is a no-op same-origin, docs are off via env).
    # The userData DB path is "non-dev", so without this exemption the three warnings
    # below would spam every launch and look alarming. See packaging plan §2.5.
    if settings.mm_packaged:
        return

    if not settings.cookie_secure:
        logger.warning(
            "SECURITY: cookie_secure=False with non-dev database (%s). "
            "Set MM_COOKIE_SECURE=true for production with HTTPS.", db_path,
        )
    if settings.enable_api_docs:
        logger.warning(
            "SECURITY: API docs enabled with non-dev database (%s). "
            "Set MM_ENABLE_API_DOCS=false for production.", db_path,
        )
    origins = settings.cors_origins.lower()
    if "localhost" in origins or "127.0.0.1" in origins:
        logger.warning(
            "SECURITY: CORS origins contain localhost with non-dev database (%s). "
            "Set MM_CORS_ORIGINS to your production domain.", db_path,
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    run_migrations()
    get_documents_dir().mkdir(parents=True, exist_ok=True)
    get_media_dir().mkdir(parents=True, exist_ok=True)
    get_backup_dir().mkdir(parents=True, exist_ok=True)
    cleanup_expired_sessions()
    _check_production_safety()

    # Start periodic auto-backup + consensus staleness sweep
    auto_backup_task = asyncio.create_task(_auto_backup_loop())
    consensus_sweep_task = asyncio.create_task(_consensus_sweep_loop())

    yield

    # Shutdown: cancel loops, create final backup
    auto_backup_task.cancel()
    consensus_sweep_task.cancel()
    for _task in (auto_backup_task, consensus_sweep_task):
        try:
            await _task
        except asyncio.CancelledError:
            pass
    _shutdown_backup()


_startup_settings = get_settings()
app = FastAPI(
    title="Mixed Measures",
    description="Mixed-methods research analysis platform",
    version="1.1.1",
    lifespan=lifespan,
    docs_url="/docs" if _startup_settings.enable_api_docs else None,
    redoc_url="/redoc" if _startup_settings.enable_api_docs else None,
    # openapi_url is independent of docs_url/redoc_url — leaving it at its default
    # serves the full schema at /openapi.json even with the UIs off. Disable it too
    # so packaged builds expose no API-introspection surface (P2 finding).
    openapi_url="/openapi.json" if _startup_settings.enable_api_docs else None,
)

# Rate limiting: return 429 with user-friendly message on limit exceeded
app.state.limiter = auth.limiter

async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many attempts. Please wait a minute before trying again."},
    )

app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
if _startup_settings.mm_database_path.startswith(":memory:"):
    auth.limiter.enabled = False

# CORS configuration
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HostValidationMiddleware(BaseHTTPMiddleware):
    """Reject requests whose Host header is not a loopback name (DNS-rebinding guard).

    A malicious web page can DNS-rebind its own domain to 127.0.0.1, making the
    victim's browser send requests that reach this server *as same-origin from the
    attacker page's perspective* — CORS never applies, responses are readable, and
    since /api/auth/status auto-provisions a session and returns the CSRF token in
    the body (J0), such a page would gain full API access. The browser preserves
    the ATTACKER'S hostname in the Host header, so refusing non-loopback Hosts
    closes the vector entirely. (Starlette's TrustedHostMiddleware can't wildcard
    ports — the packaged app binds a per-launch port — hence this custom check.)
    """

    def __init__(self, app, extra_allowed: frozenset[str] = frozenset()):
        super().__init__(app)
        self._allowed = frozenset({"127.0.0.1", "localhost", "[::1]"}) | extra_allowed

    async def dispatch(self, request: Request, call_next):
        host = request.headers.get("host", "")
        if host.startswith("["):  # bracketed IPv6 literal, e.g. [::1]:8000
            hostname = host.split("]", 1)[0] + "]"
        else:
            hostname = host.rsplit(":", 1)[0] if ":" in host else host
        if hostname.lower() not in self._allowed:
            return JSONResponse(status_code=400, content={"detail": "Invalid Host header"})
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Allow framing for original document viewer (PDF iframe in DocumentCodingWorkbench)
        if "/original" in request.url.path:
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
        else:
            response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        # CSP: restrict scripts/styles/fonts to same origin. Fonts are self-hosted
        # (src/assets/fonts via @font-face) — no Google CDN. 'unsafe-inline' in
        # style-src is for Tailwind/Radix inline styles (NOT fonts); it must stay.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "font-src 'self'; "
            "connect-src 'self'; "
            "media-src 'self' blob:; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self'"
        )
        return response


class LoopbackTokenMiddleware(BaseHTTPMiddleware):
    """Require a per-launch shared secret on every /api request (loopback-trust guard).

    The packaged backend binds a loopback TCP port that ANY local process or OS
    account on the machine can reach (and, without the Host check below, a
    DNS-rebinding web page). Because the server returns DECRYPTED data, that
    silently voids the at-rest-encryption promise on shared/lab machines while the
    app runs (an internal audit). Electron mints a random token per launch, hands it to
    this process via MM_LOOPBACK_TOKEN, and injects it as a header on every renderer
    request; a caller that can't present the token gets 403.

    Gated on the token being set: dev `uvicorn` and the test suite pass no token, so
    this is inert there (same pattern as the encryption/Host gates). Only /api is
    guarded — /health is the Electron startup probe (a main-process request that
    carries no header) and exposes no project data, and the SPA shell + assets are
    public app code, not data. Constant-time compare avoids a timing oracle.
    """

    def __init__(self, app, token: str = ""):
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next):
        if self._token and request.url.path.startswith("/api/"):
            supplied = request.headers.get("x-mm-loopback-token", "")
            if not secrets.compare_digest(supplied, self._token):
                return JSONResponse(status_code=403, content={"detail": "Forbidden"})
        return await call_next(request)


app.add_middleware(SecurityHeadersMiddleware)

# Per-launch loopback token (an internal audit): when Electron injects MM_LOOPBACK_TOKEN,
# every /api request must carry it as a header, so another local process or OS account
# on the machine can't reach the loopback port and pull the decrypted data the server
# returns (which would silently void at-rest encryption on shared machines). Inert when
# the env var is unset — dev `uvicorn` and the test suite set no token.
app.add_middleware(LoopbackTokenMiddleware, token=os.environ.get("MM_LOOPBACK_TOKEN", ""))

# Outermost middleware (added last = runs first), so a bad Host is rejected before
# anything else executes. "testserver" is allowed only on a :memory: database —
# the same test-mode signal that disables the rate limiter above — so the
# TestClient suite passes while real deployments accept loopback names only.
app.add_middleware(
    HostValidationMiddleware,
    extra_allowed=(
        frozenset({"testserver"})
        if _startup_settings.mm_database_path.startswith(":memory:")
        else frozenset()
    ),
)

# Include routers
app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(conversations.router)
app.include_router(segments.router)
app.include_router(codes.router)
app.include_router(codes.category_router)
app.include_router(coding.router)
app.include_router(notes.router)
app.include_router(memos.router)
app.include_router(export.router)
app.include_router(search.router)
app.include_router(participants.router)
app.include_router(dataset.router)
app.include_router(recode.router)
app.include_router(equivalence.router)
app.include_router(code_equivalence.router)
app.include_router(analysis_domains.router)
app.include_router(crosswalk.router)
app.include_router(metrics.router)
app.include_router(materials.router)
app.include_router(code_analysis.router)
app.include_router(statistical_tests.router)
app.include_router(text_coding.router)
app.include_router(text_analysis.router)
app.include_router(excerpts.router)
app.include_router(all_notes.router)
app.include_router(correlations.router)
app.include_router(comparisons.router)
app.include_router(scratchpad.router)
app.include_router(data_quality.router)
app.include_router(quote_board.router)
app.include_router(codebook.router)
app.include_router(documents.router)
app.include_router(backup.router)
app.include_router(project_portability.router)
app.include_router(canvas.router, prefix="/api/projects/{project_id}/canvases", tags=["canvases"])
app.include_router(canvas.image_router, prefix="/api/projects/{project_id}/canvas-images", tags=["canvas-images"])
app.include_router(audio.router, prefix="/api/projects/{project_id}/conversations/{conversation_id}/audio", tags=["audio"])


@app.get("/health")
async def health_check():
    import shutil
    from sqlalchemy import text

    checks: dict[str, str] = {}

    # DB connectivity
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        checks["database"] = "ok"
    except Exception as e:
        checks["database"] = f"error: {type(e).__name__}"

    # Disk space (warn below 100 MB free)
    try:
        settings = get_settings()
        usage = shutil.disk_usage(Path(settings.mm_data_dir))
        free_mb = usage.free / (1024 * 1024)
        checks["disk_free_mb"] = str(round(free_mb))
        if free_mb < 100:
            checks["disk"] = "low"
        else:
            checks["disk"] = "ok"
    except Exception as e:
        checks["disk"] = f"error: {type(e).__name__}"

    healthy = checks.get("database") == "ok" and checks.get("disk") != "low"
    status_code = 200 if healthy else 503
    from starlette.responses import JSONResponse
    return JSONResponse(
        {"status": "healthy" if healthy else "degraded", **checks},
        status_code=status_code,
    )


# ---------------------------------------------------------------------------
# Serve the built SPA same-origin (packaging plan §2.4).
#
# Registered LAST — after every router and /health — so it never shadows the
# API. Guarded by dist_dir().exists() so normal Vite dev (no build present) is
# untouched; only a packaged build or a local `npm run build` activates it.
# ---------------------------------------------------------------------------
_DIST_DIR = dist_dir()
if _DIST_DIR.exists():
    # Python's mimetypes consults the OS (the registry on Windows), where a
    # polluted .js Content Type (a well-documented PyInstaller-app failure class)
    # would have us serve the SPA bundle as text/plain — and Chromium's strict
    # module-MIME checking plus our X-Content-Type-Options: nosniff then refuse
    # to execute it, blanking the app. Register the types we ship explicitly so
    # serving never depends on host-machine state. (Delta-audit M9.)
    import mimetypes
    for _ext, _mime in {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon",
        ".wasm": "application/wasm",
    }.items():
        mimetypes.add_type(_mime, _ext)

    _assets_dir = _DIST_DIR / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        # Unmatched /api/* paths must 404 as the API, NOT fall through to the SPA.
        # Starlette has no prefix reservation: without this guard a typo'd GET API
        # call returns index.html (HTTP 200 HTML), breaking the client's JSON error
        # handling. (Packaging plan review finding — the catch-all swallows API 404s.)
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        # Real root-level static files (favicon, fonts, etc.) served as-is.
        # Resolve and confirm containment so an encoded `..` can't escape the
        # bundle (StaticFiles guards /assets itself; this manual branch must too).
        if full_path:
            try:
                candidate = (_DIST_DIR / full_path).resolve()
            except (ValueError, OSError):
                # e.g. an embedded NUL byte (GET /%00x) raises ValueError from
                # Path.resolve(); treat it as a client-side route, not a 500.
                candidate = None
            dist_root = _DIST_DIR.resolve()
            if candidate and candidate.is_file() and candidate.is_relative_to(dist_root):
                return FileResponse(candidate)

        # Everything else is a client-side (BrowserRouter) route → serve the SPA.
        # no-cache (revalidate, not no-store): with the now-STABLE per-install
        # port (an internal audit), the renderer's HTTP cache persists across
        # launches — an auto-update must never serve a stale app shell. Hashed
        # /assets remain immutable-by-name, so revalidating only index.html
        # costs one conditional request.
        return FileResponse(
            _DIST_DIR / "index.html",
            headers={"Cache-Control": "no-cache"},
        )
