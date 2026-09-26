import secrets
from datetime import datetime, timedelta, timezone
import bcrypt
from fastapi import HTTPException, Request, Response, Depends
from sqlalchemy import case, exists
from sqlalchemy.orm import Session
from .database import get_db
from .models.audit import AuditEntry
from .models.user import User, Session as SessionModel
from .config import get_settings

settings = get_settings()

SESSION_COOKIE_NAME = "mm_session"
CSRF_HEADER_NAME = "X-CSRF-Token"

# Name the auto-provisioned local coder ships with (editable in Settings).
DEFAULT_CODER_NAME = "Researcher"

# Display name of the global "Unattributed" coder that legacy NULL-user code
# applications are re-homed onto (Track J · D7 backfill).
UNATTRIBUTED_CODER_NAME = "Unattributed"

# Display name of the global "Consensus" coder that owns the derived consensus
# layer (Track J · J2-3). Like Unattributed, it is a system identity: one global
# row that holds `origin='consensus'` code applications across all projects.
CONSENSUS_CODER_NAME = "Consensus"

# The audit action `POST /auth/switch-coder` writes when the session's coder CHANGES
# (entity_id = the coder switched TO). `ensure_default_user` reads it (#1027), so the
# writer and the reader share this one spelling.
CODER_SWITCHED_ACTION = "coder_switched"

# ── The coder vocabulary (Track J · D14; the machine kind decided #989) ──────
#
# FOUR values, answering THREE different questions. They are separate tuples
# rather than one enum because a call site asks one question, and collapsing
# them is how `'ai'` ended up on the selectable AND the voting side at once.
#
#   human        — a person. Selectable, on the roster, votes.
#   ai           — a MACHINE coder: labels produced by a model somewhere else
#                  and loaded in as a file (queue row 49). On the roster (so its
#                  codings are attributed, filterable and visible), NOT
#                  selectable, and it NEVER enters a reliability aggregate.
#   unattributed — legacy NULL-user applications (Track J · D7 backfill)
#   consensus    — the derived consensus layer (Track J · J2-3)
CODER_TYPE_HUMAN = "human"
CODER_TYPE_MACHINE = "ai"
CODER_TYPE_UNATTRIBUTED = "unattributed"
CODER_TYPE_CONSENSUS = "consensus"

# SYSTEM/derived identities — real data owners (they can hold code applications)
# but NOT roster coders. Hidden from the roster, the switcher and the
# multi-coder gate, and never auto-selected as the active coder.
SYSTEM_CODER_TYPES = (CODER_TYPE_UNATTRIBUTED, CODER_TYPE_CONSENSUS)

# On the ROSTER: their codings are attributed, filterable and displayed.
# `list_coders` returns exactly these, which is why the client's `multiCoder`
# is a claim about ATTRIBUTION UI and never about reliability (#989).
ROSTER_CODER_TYPES = (CODER_TYPE_HUMAN, CODER_TYPE_MACHINE)

# SELECTABLE: you can become this coder, and every later application is
# server-stamped with them. A machine is excluded because "code as the machine"
# is not an act a researcher performs — the labels arrive as a file.
SELECTABLE_CODER_TYPES = (CODER_TYPE_HUMAN,)

# 🔴 RELIABILITY: who may vote in consensus and enter an agreement coefficient.
# STRATEGY commits, verbatim, that "the AI layer must be excludable from every
# reliability aggregate exactly as `origin='consensus'` already is" — this tuple
# is that commitment, and `reliability_coder_clause()` below is its one reader.
#
# Deliberately a SECOND tuple with the same members as SELECTABLE_CODER_TYPES
# today: they answer different questions ("can I act as them" vs "does their
# judgement enter a statistic"), and a future kind — a trainee whose coding is
# real but excluded from the headline — separates them. One tuple serving two
# questions is the overloading shape #806 records.
RELIABILITY_CODER_TYPES = (CODER_TYPE_HUMAN,)

# Every value this build understands. `normalize_coder_type` fails CLOSED onto
# `human` for anything else: `.mmproject` import copies `coder_type` verbatim
# out of the archive, so a hand-edited file is the one door that can mint an
# unknown kind, and an unknown kind would sit outside every tuple above — off
# the roster, unselectable, and silently in no layer at all.
KNOWN_CODER_TYPES = SYSTEM_CODER_TYPES + ROSTER_CODER_TYPES


def normalize_coder_type(value: object) -> str:
    """Coerce an untrusted ``coder_type`` to a value this build understands.

    Fail-closed onto ``human``: an unrecognised kind is a coder nothing lists,
    nothing can select and no layer contains, so its codings would be invisible
    in every surface while still occupying the per-coder unique index.
    """
    return value if value in KNOWN_CODER_TYPES else CODER_TYPE_HUMAN


def selectable_coder_clause():
    """Clause: ``User`` rows a session may be re-pointed at (the switcher, the
    Settings roster picker, ``ensure_default_user``).

    Splat into a ``User`` query's ``.filter(...)``. Never hand-roll
    ``coder_type.notin_(SYSTEM_CODER_TYPES)`` for this question — that form
    admits a machine coder, and every application made afterwards would be
    stamped as the model.
    """
    return User.coder_type.in_(SELECTABLE_CODER_TYPES)


def reliability_coder_clause():
    """Clause: ``User`` rows whose codings may enter consensus or an agreement
    coefficient (#989).

    Requires a ``User`` in the query. The SIX voter/roster queries that used to
    spell this out as ``coder_type.notin_(SYSTEM_CODER_TYPES)`` all read it now
    — five of six getting a new exclusion is the failure mode #868 records, and
    a machine voting in consensus is the one that cannot be seen from a number.
    """
    return User.coder_type.in_(RELIABILITY_CODER_TYPES)


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def unique_username(db: Session, base: str) -> str:
    """Return ``base`` or, if taken, ``base (2)`` / ``base (3)`` / … — the first
    free username. ``User.username`` is globally UNIQUE; this is the single home
    for collision-suffixing (the consensus system coder and the Track J · J3-2
    merge coder-create path both use it instead of hand-rolling the loop)."""
    name = base
    suffix = 2
    while db.query(User).filter(User.username == name).first():
        name = f"{base} ({suffix})"
        suffix += 1
    return name


def ensure_default_user(db: Session) -> User:
    """Return the local coder, auto-provisioning one if the users table is empty.

    Mixed Measures is a local-first desktop tool with no login screen — a single
    auto-provisioned coder owns all local data. The placeholder password hash
    exists only because ``User.password_hash`` is NOT NULL; credentials are never
    used (the login endpoint is unreachable from the UI). When multiple coders
    exist, the most-recently-active NON-archived coder is returned
    (``last_active_at``, stamped on every switch) so a switched identity survives
    session expiry / restart instead of silently reverting to the lowest-id
    "Researcher" — the Track J · J1 misattribution fix. Falls back to id order
    when no coder has ever been switched to.

    🔴 **A coder's `last_active_at` counts only if someone switched to them HERE
    (#1027).** The value is a timestamp, and nothing in it says which install wrote
    it: a `.mmproject` created coders with the colleague's own `last_active_at`
    until #1027, so an install that imported a file before that fix can hold a
    colleague whose value is newer than any local switch — and a researcher who has
    never switched holds NULL, which sorts last. The `coder_switched` audit entry
    CAN vouch: it is written by `switch-coder` on this install and never travels in
    a project file (a `.mmbackup` restore brings the users and the audit log
    together, so they agree there too). Reading it here, rather than repairing the
    column, is what makes a file imported before the fix harmless without a data
    migration — and it holds for any future door that copies the column.
    ⚠️ The entry exists since the same day as `last_active_at` (J1, 2026-06-21,
    written 1.7 h earlier). The one stamp it does not accompany is re-selecting the
    coder you already are, which only the current default can do — it already
    ranks first, so ignoring that stamp changes no outcome.
    """
    switched_here = exists().where(
        AuditEntry.action == CODER_SWITCHED_ACTION,
        AuditEntry.entity_type == "user",
        AuditEntry.entity_id == User.id,
    )
    trusted_recency = case((switched_here, User.last_active_at), else_=None)
    user = (
        db.query(User)
        # Never auto-select a system coder (Unattributed / consensus) as the
        # active identity — they own data but are not selectable coders (D7) —
        # and never a MACHINE coder (#989): this runs with no session to fall
        # back on, so on an install whose humans are all archived it is the one
        # path that could silently make the model the active identity and stamp
        # every subsequent application with it.
        .filter(selectable_coder_clause())
        .order_by(
            User.archived.asc(),
            trusted_recency.desc().nullslast(),
            User.id,
        )
        .first()
    )
    if user:
        return user
    user = User(
        username=DEFAULT_CODER_NAME,
        password_hash=hash_password(secrets.token_hex(16)),
        is_admin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def get_or_create_consensus_user(db: Session) -> User:
    """Return the global "Consensus" system coder, creating it on first use.

    Track J · J2-3 (Slab 3). The consensus layer is materialized as ordinary
    ``CodeApplication`` rows (``origin='consensus'``) owned by ONE dedicated
    system coder. There is no ``project_id`` on ``User`` — this row is GLOBAL,
    one per database, and holds consensus applications across every project; the
    materializer (Slab 4) scopes a recompute to a single project's targets, never
    by coder alone.

    Mirrors the D7 Unattributed find-or-create: ``coder_type='consensus'`` (a
    ``SYSTEM_CODER_TYPES`` member, so it is already excluded from the roster, the
    switcher, the multi-coder gate, and ``ensure_default_user``), a NULL password
    hash (never selectable / no login), and a username collision-suffixed so a
    human coder literally named "Consensus" can't block creation. Idempotent:
    keyed on ``coder_type``, so repeated calls return the same row.

    Flushes but does NOT commit — the caller owns the transaction boundary so
    this composes inside the consensus materializer and the portability import
    without prematurely committing their partial work.
    """
    consensus = (
        db.query(User)
        .filter(User.coder_type == CODER_TYPE_CONSENSUS)
        .order_by(User.id)
        .first()
    )
    if consensus:
        return consensus

    name = unique_username(db, CONSENSUS_CODER_NAME)

    consensus = User(
        username=name,
        password_hash=None,
        is_admin=False,
        coder_type=CODER_TYPE_CONSENSUS,
        archived=False,
    )
    db.add(consensus)
    db.flush()
    db.refresh(consensus)
    return consensus


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def create_session(db: Session, user_id: int) -> tuple[str, str]:
    """Create a new session and return (session_id, csrf_token)."""
    session_id = secrets.token_hex(32)
    csrf_token = secrets.token_hex(32)
    expires_at = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=settings.session_expire_hours)

    session = SessionModel(
        id=session_id,
        user_id=user_id,
        csrf_token=csrf_token,
        expires_at=expires_at
    )
    db.add(session)
    db.commit()

    return session_id, csrf_token


def get_session(db: Session, session_id: str) -> SessionModel | None:
    """Get a valid session by ID."""
    session = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if session and session.expires_at > datetime.now(timezone.utc).replace(tzinfo=None):
        return session
    if session:
        db.delete(session)
        db.commit()
    return None


def invalidate_session(db: Session, session_id: str) -> None:
    """Delete a session."""
    db.query(SessionModel).filter(SessionModel.id == session_id).delete()
    db.commit()


def set_session_cookie(response: Response, session_id: str) -> None:
    """Set the session cookie on a response."""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=settings.session_expire_hours * 3600
    )


def clear_session_cookie(response: Response) -> None:
    """Clear the session cookie."""
    response.delete_cookie(key=SESSION_COOKIE_NAME)


async def get_current_user(
    request: Request,
    db: Session = Depends(get_db)
) -> User:
    """Dependency to get the current authenticated user."""
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    session = get_session(db, session_id)
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")

    # Inactivity timeout check
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if settings.inactivity_timeout_minutes > 0 and session.last_activity_at:
        deadline = session.last_activity_at + timedelta(minutes=settings.inactivity_timeout_minutes)
        if now > deadline:
            db.delete(session)
            db.commit()
            raise HTTPException(status_code=401, detail="Session expired due to inactivity")

    # CSRF validation for state-changing requests
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and settings.csrf_enabled:
        csrf_token = request.headers.get(CSRF_HEADER_NAME)
        if csrf_token != session.csrf_token:
            raise HTTPException(status_code=403, detail="Invalid CSRF token")

    user = db.query(User).filter(User.id == session.user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Update last_activity_at (throttled to avoid write on every request)
    if not session.last_activity_at or (now - session.last_activity_at).total_seconds() > 60:
        session.last_activity_at = now
        db.commit()

    return user


async def get_optional_user(
    request: Request,
    db: Session = Depends(get_db)
) -> User | None:
    """Dependency to get the current user if authenticated, or None."""
    try:
        return await get_current_user(request, db)
    except HTTPException:
        return None
