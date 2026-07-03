from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address
from ..database import get_db
from ..models.user import User
from ..models.audit import AuditEntry
from ..schemas.auth import (
    SetupRequest,
    LoginRequest,
    UserResponse,
    AuthStatusResponse,
    ChangePasswordRequest,
    UpdateProfileRequest,
    CoderResponse,
    CreateCoderRequest,
    SwitchCoderRequest,
)
from ..auth import (
    hash_password,
    verify_password,
    create_session,
    get_session,
    invalidate_session,
    set_session_cookie,
    clear_session_cookie,
    get_current_user,
    ensure_default_user,
    SESSION_COOKIE_NAME,
    SYSTEM_CODER_TYPES,
)
import json

router = APIRouter(prefix="/api/auth", tags=["auth"])
limiter = Limiter(key_func=get_remote_address)


def require_multiuser_auth() -> None:
    """Gate for the dormant multi-user account endpoints (an internal audit).

    Post-J0 these have no UI callers; they 404 unless MM_MULTIUSER_AUTH_ENABLED
    is set so the surface is indistinguishable from absent. Kept (not deleted)
    as the substrate for Track J's coder roster and the eventual cloud build.
    """
    from ..config import get_settings
    if not get_settings().mm_multiuser_auth_enabled:
        raise HTTPException(status_code=404, detail="Not Found")


@router.get("/status", response_model=AuthStatusResponse)
async def get_auth_status(
    request: Request,
    response: Response,
    db: Session = Depends(get_db)
):
    """Resolve the active local coder, auto-provisioning + auto-logging-in when needed.

    Local-first: there is no login screen. A valid session cookie is honored when
    present (preserves any multi-user / test flows); otherwise a default coder is
    ensured and a session minted for it, so the app always opens straight into the
    workspace. ``needs_setup`` is therefore always False and ``authenticated``
    always True.
    """
    from ..config import get_settings
    _settings = get_settings()
    timeout = _settings.inactivity_timeout_minutes
    encryption_enabled = _settings.mm_encryption_enabled

    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if session_id:
        session = get_session(db, session_id)
        if session:
            user = db.query(User).filter(User.id == session.user_id).first()
            if user:
                return AuthStatusResponse(
                    needs_setup=False,
                    authenticated=True,
                    user=UserResponse(
                        id=user.id,
                        username=user.username,
                        is_admin=user.is_admin,
                        csrf_token=session.csrf_token,
                        display_color=user.display_color,
                    ),
                    inactivity_timeout_minutes=timeout,
                    encryption_enabled=encryption_enabled,
                )

    # No valid session → auto-provision + auto-login the local coder.
    user = ensure_default_user(db)
    new_session_id, csrf_token = create_session(db, user.id)
    set_session_cookie(response, new_session_id)
    return AuthStatusResponse(
        needs_setup=False,
        authenticated=True,
        user=UserResponse(
            id=user.id,
            username=user.username,
            is_admin=user.is_admin,
            csrf_token=csrf_token,
            display_color=user.display_color,
        ),
        inactivity_timeout_minutes=timeout,
        encryption_enabled=encryption_enabled,
    )


@router.post("/setup", response_model=UserResponse, dependencies=[Depends(require_multiuser_auth)])
async def setup_account(
    data: SetupRequest,
    response: Response,
    db: Session = Depends(get_db)
):
    """First-run account creation. Only works when no users exist."""
    user_count = db.query(User).count()
    if user_count > 0:
        raise HTTPException(
            status_code=400,
            detail="Setup already completed. Use login instead."
        )

    # Create user (first user is admin)
    user = User(
        username=data.username,
        password_hash=hash_password(data.password),
        is_admin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Create session
    session_id, csrf_token = create_session(db, user.id)
    set_session_cookie(response, session_id)

    # Audit log
    audit = AuditEntry(
        user_id=user.id,
        action="user_created",
        entity_type="user",
        entity_id=user.id,
        details=json.dumps({"username": user.username, "first_user": True})
    )
    db.add(audit)
    db.commit()

    return UserResponse(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        csrf_token=csrf_token,
    )


@router.post("/login", response_model=UserResponse, dependencies=[Depends(require_multiuser_auth)])
@limiter.limit("5/minute")
async def login(
    request: Request,
    data: LoginRequest,
    response: Response,
    db: Session = Depends(get_db)
):
    """Authenticate and create a session."""
    user = db.query(User).filter(User.username == data.username).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Create session
    session_id, csrf_token = create_session(db, user.id)
    set_session_cookie(response, session_id)

    # Audit log
    audit = AuditEntry(
        user_id=user.id,
        action="login",
        entity_type="user",
        entity_id=user.id
    )
    db.add(audit)
    db.commit()

    return UserResponse(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        csrf_token=csrf_token,
    )


@router.post("/logout", dependencies=[Depends(require_multiuser_auth)])
async def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db)
):
    """Invalidate the current session."""
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if session_id:
        session = get_session(db, session_id)
        if session:
            # Audit log
            audit = AuditEntry(
                user_id=session.user_id,
                action="logout",
                entity_type="user",
                entity_id=session.user_id
            )
            db.add(audit)
            db.commit()

        invalidate_session(db, session_id)

    clear_session_cookie(response)
    return {"status": "ok"}


@router.post("/change-password", dependencies=[Depends(require_multiuser_auth)])
async def change_password(
    data: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change the current user's password."""
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    user.password_hash = hash_password(data.new_password)

    # Audit log
    audit = AuditEntry(
        user_id=user.id,
        action="password_changed",
        entity_type="user",
        entity_id=user.id,
    )
    db.add(audit)
    db.commit()

    return {"status": "ok"}


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get current authenticated user info."""
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    session = get_session(db, session_id)

    return UserResponse(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        csrf_token=session.csrf_token if session else None,
        display_color=user.display_color,
    )


@router.patch("/me", response_model=UserResponse)
async def update_profile(
    data: UpdateProfileRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Rename the active coder (the local-first replacement for account editing)."""
    new_name = data.username.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Coder name cannot be empty")

    if new_name != user.username:
        existing = (
            db.query(User)
            .filter(User.username == new_name, User.id != user.id)
            .first()
        )
        if existing:
            raise HTTPException(status_code=409, detail=f"The name '{new_name}' is already taken")
        user.username = new_name
        audit = AuditEntry(
            user_id=user.id,
            action="coder_renamed",
            entity_type="user",
            entity_id=user.id,
            details=json.dumps({"username": new_name}),
        )
        db.add(audit)
        db.commit()
        db.refresh(user)

    # Update the badge color only when the field was explicitly provided, so an
    # explicit null clears it (the Settings "Use default color" reset) while an
    # omitted field leaves it untouched. (Plain `is not None` could never clear it.)
    if "display_color" in data.model_fields_set and data.display_color != user.display_color:
        user.display_color = data.display_color
        db.commit()
        db.refresh(user)

    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    session = get_session(db, session_id) if session_id else None
    return UserResponse(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        csrf_token=session.csrf_token if session else None,
        display_color=user.display_color,
    )


@router.get("/users", response_model=list[UserResponse], dependencies=[Depends(require_multiuser_auth)])
async def list_users(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all user accounts. Requires admin privileges."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    users = db.query(User).order_by(User.id).all()
    return [
        UserResponse(id=u.id, username=u.username, is_admin=u.is_admin)
        for u in users
    ]


@router.post("/users", response_model=UserResponse, dependencies=[Depends(require_multiuser_auth)])
async def create_user(
    data: SetupRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new user account. Requires admin privileges."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    existing = db.query(User).filter(User.username == data.username).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Username '{data.username}' already exists")

    new_user = User(
        username=data.username,
        password_hash=hash_password(data.password),
        is_admin=False,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    audit = AuditEntry(
        user_id=user.id,
        action="user_created",
        entity_type="user",
        entity_id=new_user.id,
        details=json.dumps({"username": data.username, "created_by": user.username}),
    )
    db.add(audit)
    db.commit()

    return UserResponse(
        id=new_user.id,
        username=new_user.username,
        is_admin=new_user.is_admin,
    )


# ── Coder roster (Track J · J1) — passwordless, ungated local-roster endpoints ──
# Distinct from the gated multi-user account endpoints above: these are always
# available and carry NO security claim (local-first). The active coder is a real
# `users` row; switching re-points the session so attribution is server-stamped
# (Option A). The gated /login + /users stay as the cloud-auth substrate.

@router.get("/coders", response_model=list[CoderResponse])
async def list_coders(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_archived: bool = False,
):
    """List the local coder roster.

    Default: non-archived, selectable coders only — the roster lens that drives the
    switcher, attribution badges, and the multi-coder gate (the frontend derives
    `multiCoder` from this list's length). `include_archived=true` additionally
    returns archived coders for the Settings roster manager (which lists + unarchives
    them). System coders (Unattributed / consensus) own data but are NEVER selectable,
    so they stay excluded in both modes.
    """
    q = db.query(User).filter(User.coder_type.notin_(SYSTEM_CODER_TYPES))
    if not include_archived:
        q = q.filter(User.archived == False)
    coders = q.order_by(User.id).all()
    return [CoderResponse.model_validate(c) for c in coders]


@router.post("/coders", response_model=CoderResponse)
async def create_coder(
    data: CreateCoderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a passwordless roster coder."""
    name = data.username.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Coder name cannot be empty")
    if db.query(User).filter(User.username == name).first():
        raise HTTPException(status_code=409, detail=f"The name '{name}' is already taken")
    coder = User(
        username=name,
        password_hash=None,          # passwordless local roster coder
        is_admin=False,
        display_color=data.display_color,
        coder_type="human",
    )
    db.add(coder)
    db.commit()
    db.refresh(coder)
    db.add(AuditEntry(
        user_id=user.id, action="coder_created", entity_type="user", entity_id=coder.id,
        details=json.dumps({"username": name}),
    ))
    db.commit()
    return CoderResponse.model_validate(coder)


@router.post("/switch-coder", response_model=CoderResponse)
async def switch_coder(
    data: SwitchCoderRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Make a coder the active identity for this session by re-pointing it (Option A).

    Every subsequent code application is server-stamped with the chosen coder.
    The CSRF token is per-session and unchanged, so the client keeps using it.
    """
    target = (
        db.query(User)
        .filter(
            User.id == data.coder_id,
            User.archived == False,
            User.coder_type.notin_(SYSTEM_CODER_TYPES),  # can't switch TO a system coder
        )
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Coder not found")
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    session = get_session(db, session_id) if session_id else None
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    # Stamp recency so the active coder survives session expiry / restart:
    # ensure_default_user prefers the most-recently-active coder (J1 revert fix).
    # Set even on a no-op re-select so re-affirming your identity refreshes it.
    target.last_active_at = datetime.now(timezone.utc).replace(tzinfo=None)
    if session.user_id != target.id:
        session.user_id = target.id
        db.add(AuditEntry(
            user_id=target.id, action="coder_switched", entity_type="user", entity_id=target.id,
            details=json.dumps({"from": user.id, "to": target.id}),
        ))
    db.commit()
    db.refresh(target)
    return CoderResponse.model_validate(target)


@router.post("/coders/{coder_id}/archive", response_model=CoderResponse)
async def archive_coder(
    coder_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Archive a roster coder (never hard-delete — preserves their attribution)."""
    if coder_id == user.id:
        raise HTTPException(status_code=400, detail="Switch to another coder before archiving this one")
    target = (
        db.query(User)
        # System coders (Unattributed / consensus) are not roster coders — they
        # can't be archived either (consistent with list_coders / switch-coder).
        .filter(User.id == coder_id, User.coder_type.notin_(SYSTEM_CODER_TYPES))
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Coder not found")
    if not target.archived:
        target.archived = True
        db.commit()
        db.add(AuditEntry(
            user_id=user.id, action="coder_archived", entity_type="user", entity_id=target.id,
        ))
        db.commit()
        db.refresh(target)
    return CoderResponse.model_validate(target)


@router.post("/coders/{coder_id}/unarchive", response_model=CoderResponse)
async def unarchive_coder(
    coder_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Restore an archived roster coder to the selectable roster.

    Usernames stay globally unique even while archived (create checks all users),
    so an unarchive can never collide — no rename needed.
    """
    target = (
        db.query(User)
        .filter(User.id == coder_id, User.coder_type.notin_(SYSTEM_CODER_TYPES))
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Coder not found")
    if target.archived:
        target.archived = False
        db.commit()
        db.add(AuditEntry(
            user_id=user.id, action="coder_unarchived", entity_type="user", entity_id=target.id,
        ))
        db.commit()
        db.refresh(target)
    return CoderResponse.model_validate(target)
