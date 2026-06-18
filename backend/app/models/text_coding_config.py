from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base

# Default list of strings treated as empty/non-substantive responses
DEFAULT_TREAT_AS_EMPTY = ["N/A", "n/a", "NA", "No response", "None", "-", "."]


class TextCodingConfig(Base):
    """Persisted view state for Text Coding (one per project)."""
    __tablename__ = "text_coding_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"),
                        nullable=False, unique=True)
    view_mode = Column(String(20), nullable=False, default="by_text")
    focal_column_ids = Column(Text, nullable=True)
    dataset_filter_ids = Column(Text, nullable=True)
    random_seed = Column(Integer, nullable=True)
    context_visibility = Column(Text, nullable=True)
    hide_empty = Column(Integer, default=1, nullable=False)
    starred_value_ids = Column(Text, nullable=True)
    treat_as_empty = Column(Text, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    project = relationship("Project", back_populates="text_coding_config")
