import secrets
from datetime import datetime, timedelta, timezone
import bcrypt
from fastapi import HTTPException, Request, Response, Depends
from sqlalchemy.orm import Session
from .database import get_db
from .models.user import User, Session as SessionModel
from .config import get_settings

settings = get_settings()

SESSION_COOKIE_NAME = "mm_session"
CSRF_HEADER_NAME = "X-CSRF-Token"

# Name the auto-provisioned local coder ships with (editable in Settings).
DEFAULT_CODER_NAME = "Researcher"


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def ensure_default_user(db: Session) -> User:
    """Return the local coder, auto-provisioning one if the users table is empty.

    Mixed Measures is a local-first desktop tool with no login screen — a single
    auto-provisioned coder owns all local data. The placeholder password hash
    exists only because ``User.password_hash`` is NOT NULL; credentials are never
    used (the login endpoint is unreachable from the UI). When multiple users
    exist (legacy DBs, tests), the lowest-id user is treated as the active coder.
    """
    user = db.query(User).order_by(User.id).first()
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
