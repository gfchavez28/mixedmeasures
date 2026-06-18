"""Recode definition model for variable transformations."""

from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Enum,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum

from ..database import Base


class RecodeType(str, enum.Enum):
    SCALE_MAP = "scale_map"          # Label -> numeric mapping
    CATEGORY_GROUP = "category_group"  # Label -> group name mapping
    REVERSE = "reverse"              # Linked reverse of another definition


class OutputType(str, enum.Enum):
    NUMERIC = "numeric"
    CATEGORICAL = "categorical"


class RecodeDefinition(Base):
    """A recode definition for transforming column values."""
    __tablename__ = "recode_definitions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    column_id = Column(
        Integer,
        ForeignKey("dataset_columns.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = Column(String(255), nullable=False)
    recode_type = Column(
        Enum(RecodeType, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
    )
    output_type = Column(
        Enum(OutputType, values_callable=lambda x: [e.value for e in x]),
        nullable=False,
    )
    mapping = Column(Text, nullable=False)  # JSON: {"label": value, ...}
    exclude_values = Column(Text, nullable=True)  # JSON: ["N/A", ...] or null
    is_primary = Column(Boolean, default=False, nullable=False)
    is_auto_detected = Column(Boolean, default=False, nullable=False)
    source_definition_id = Column(
        Integer,
        ForeignKey("recode_definitions.id", ondelete="SET NULL"),
        nullable=True,
    )
    sequence_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    column = relationship("DatasetColumn", back_populates="recode_definitions")
    source_definition = relationship(
        "RecodeDefinition",
        remote_side=[id],
        uselist=False,
    )
