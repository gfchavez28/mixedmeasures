from sqlalchemy import Boolean, Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=True)  # passwordless roster coders (J1); default coder keeps a placeholder hash
    is_admin = Column(Boolean, default=False, nullable=False, server_default="0")
    created_at = Column(DateTime, default=func.now(), nullable=False)
    # Coder-roster fields (Track J · J1)
    display_color = Column(String(7), nullable=True)  # hex badge color (e.g. #3b82f6)
    coder_type = Column(String(20), nullable=False, default="human", server_default="human")  # reserve: human | ai (D14)
    archived = Column(Boolean, nullable=False, default=False, server_default="0")  # archive-not-delete
    last_active_at = Column(DateTime, nullable=True)  # most-recent coder switch; survives session expiry/restart (J1 revert fix)

    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")


class Session(Base):
    __tablename__ = "sessions"

    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    csrf_token = Column(String(64), nullable=False)
    last_activity_at = Column(DateTime, default=func.now(), nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    expires_at = Column(DateTime, nullable=False)
