from sqlalchemy import Boolean, Column, Integer, String, DateTime, Text, Float, ForeignKey, Index, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy import text as _sa_text
import enum
from ..database import Base


class ColumnType(str, enum.Enum):
    ORDINAL = "ordinal"          # Likert and similar ordered scales
    NOMINAL = "nominal"          # Unordered categories
    BINARY = "binary"            # Yes/No
    MULTI_SELECT = "multi_select"  # Check-all-that-apply
    NUMERIC = "numeric"          # Continuous or count
    PERCENTAGE = "percentage"    # 0-100 percentage
    OPEN_TEXT = "open_text"      # Open-ended text response
    DEMOGRAPHIC = "demographic"  # Routes to participant attributes
    SKIP = "skip"                # Ignored column


# ── Column-type eligibility sets — single source of truth (invariant I-D, #399) ──
# TWO DISTINCT numeric concepts; do NOT merge them:
#   VALUE_NUMERIC_TYPES        — types whose `value_numeric` is reliably populated,
#                                i.e. usable as a numeric OPERAND (computed-column
#                                formulas; data-quality / MCAR). Binary (0/1) counts.
#   SCALE_SCORE_ELIGIBLE_TYPES — types eligible for scale-score AGGREGATION
#                                (domain_aggregate means). Binary is deliberately
#                                EXCLUDED: averaging yes/no into a Likert-style mean
#                                isn't meaningful, even though 0/1 is a valid operand.
# The ONLY difference between the two is BINARY. Both are frozensets of ColumnType
# members; because ColumnType is a (str, Enum), `hash(ColumnType.ORDINAL) ==
# hash("ordinal")`, so membership works for BOTH enum members AND raw string values.
# That lets string-comparing call sites (computed_columns, data_quality) and
# enum-comparing sites (metrics, equivalence_validators) share one definition.
VALUE_NUMERIC_TYPES = frozenset({
    ColumnType.ORDINAL,
    ColumnType.NUMERIC,
    ColumnType.PERCENTAGE,
    ColumnType.BINARY,
})

SCALE_SCORE_ELIGIBLE_TYPES = frozenset({
    ColumnType.ORDINAL,
    ColumnType.NUMERIC,
    ColumnType.PERCENTAGE,
})


class Dataset(Base):
    """A dataset within a project (e.g. 'Board 360 Assessment')."""
    __tablename__ = "datasets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    source = Column(String(100), nullable=True)  # e.g. "LimeSurvey", "Qualtrics", "Google Forms"
    rater_group = Column(String(100), nullable=True)  # e.g. "board", "staff", "self"
    import_config = Column(Text, nullable=True)  # JSON: preserved column mapping config for reference
    # User-customizable color override for the dataset's visual identity dot
    # (crosswalk column headers, cell dots, Datasets list, page titles, etc.).
    # Null → use the auto-assigned palette color from `dataset-color.ts`.
    color = Column(String(7), nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="datasets")
    columns = relationship("DatasetColumn", back_populates="dataset", cascade="all, delete-orphan", order_by="DatasetColumn.display_order, DatasetColumn.sequence_order")
    rows = relationship("DatasetRow", back_populates="dataset", cascade="all, delete-orphan")


class DatasetColumn(Base):
    """A single column within a dataset."""
    __tablename__ = "dataset_columns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    column_code = Column(String(50), nullable=True)  # e.g. "G01Q01" from LimeSurvey
    group_code = Column(String(50), nullable=True)  # e.g. "G01" -- parsed from header
    group_label = Column(String(255), nullable=True)  # e.g. "Vision & Strategy" -- user-assigned
    column_name = Column(String(255), nullable=True)  # Short human-friendly display name
    column_text = Column(Text, nullable=False)
    column_type = Column(Enum(ColumnType, values_callable=lambda x: [e.value for e in x]), nullable=False)
    sequence_order = Column(Integer, nullable=False)
    display_order = Column(Integer, nullable=True)  # User-adjustable column order (defaults to sequence_order)

    # Scale/format metadata (populated based on column_type)
    scale_labels = Column(Text, nullable=True)  # JSON array: ["Poor","Fair","Good","Very Good","Excellent"]
    scale_values = Column(Text, nullable=True)  # JSON array: [1, 2, 3, 4, 5]
    scale_points = Column(Integer, nullable=True)  # Number of scale points (3, 4, 5, 7, 10, etc.)
    numeric_min = Column(Float, nullable=True)
    numeric_max = Column(Float, nullable=True)
    numeric_format = Column(String(20), nullable=True)  # "integer", "decimal", "percentage", "currency"

    source = Column(String(20), nullable=False, default="imported", server_default="imported")
    # "imported" (from CSV), "manual" (created in data view), or "computed" (formula-derived)

    # Computed column fields
    expression = Column(Text, nullable=True)
    depends_on_column_ids = Column(Text, nullable=True)  # JSON array of column IDs
    stale = Column(Boolean, nullable=True, default=False, server_default="0")

    # Demographic subtype (role, race, gender, age, or custom)
    demographic_subtype = Column(String(40), nullable=True)

    # Cross-instrument equivalence (for 360-style comparisons)
    equivalence_group_id = Column(Integer, ForeignKey("equivalence_groups.id", ondelete="SET NULL"), nullable=True, index=True)

    # #353: per-column opt-out for the participant detail panel. Default True
    # so newly imported columns show up in linked participant profiles. The
    # broader "show all non-text columns" filter in routers/participants.py
    # respects this flag so researchers have immediate opt-out for sensitive
    # columns. Manageable from the DatasetView column-edit popover.
    show_in_participant_profile = Column(
        Boolean, nullable=False, default=True, server_default="1",
    )

    # Relationships
    dataset = relationship("Dataset", back_populates="columns")
    equivalence_group = relationship("EquivalenceGroup", back_populates="columns")
    values = relationship("DatasetValue", back_populates="column", cascade="all, delete-orphan")
    recode_definitions = relationship(
        "RecodeDefinition",
        back_populates="column",
        cascade="all, delete-orphan",
        order_by="RecodeDefinition.sequence_order",
    )

    __table_args__ = (
        Index("ix_dataset_columns_dataset_sequence", "dataset_id", "sequence_order"),
        Index("ix_dataset_columns_dataset_sequence_unique", "dataset_id", "sequence_order", unique=True),
        Index("ix_dataset_columns_dataset_display_order", "dataset_id", "display_order"),
        # 1:1 column-per-dataset within an equivalence group (see #289).
        # Partial unique index — only applies to columns that belong to a group.
        # Declared here in addition to the baseline migration so that tests using
        # Base.metadata.create_all() get the same enforcement as production DBs.
        Index(
            "ix_equivalence_unique_column_per_dataset",
            "equivalence_group_id",
            "dataset_id",
            unique=True,
            sqlite_where=_sa_text("equivalence_group_id IS NOT NULL"),
            postgresql_where=_sa_text("equivalence_group_id IS NOT NULL"),
        ),
    )


class DatasetRow(Base):
    """One row in a dataset."""
    __tablename__ = "dataset_rows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    participant_id = Column(Integer, ForeignKey("participants.id", ondelete="SET NULL"), nullable=True, index=True)
    row_identifier = Column(String(255), nullable=True)  # Original ID from CSV
    import_batch = Column(String(255), nullable=True)  # Batch identifier for append tracking
    submitted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    dataset = relationship("Dataset", back_populates="rows")
    participant = relationship("Participant", back_populates="dataset_rows")
    values = relationship("DatasetValue", back_populates="row", cascade="all, delete-orphan")
    row_scores = relationship("RowScore", back_populates="dataset_row", cascade="all, delete-orphan")

    __table_args__ = (
        # At most one row per participant per dataset. Partial unique index —
        # only applies to linked rows (participant_id NOT NULL). Declared here so
        # create_all() (tests) matches the production schema (migration-created
        # uq_dataset_rows_dataset_participant).
        Index(
            "uq_dataset_rows_dataset_participant",
            "dataset_id",
            "participant_id",
            unique=True,
            sqlite_where=_sa_text("participant_id IS NOT NULL"),
            postgresql_where=_sa_text("participant_id IS NOT NULL"),
        ),
    )


class DatasetValue(Base):
    """A single value at the intersection of a row and column within a dataset."""
    __tablename__ = "dataset_values"

    id = Column(Integer, primary_key=True, autoincrement=True)
    row_id = Column(Integer, ForeignKey("dataset_rows.id", ondelete="CASCADE"), nullable=False, index=True)
    column_id = Column(Integer, ForeignKey("dataset_columns.id", ondelete="CASCADE"), nullable=False, index=True)
    value_text = Column(Text, nullable=True)  # Raw answer: "Good", or paragraph text
    value_numeric = Column(Float, nullable=True)  # Numeric encoding: 3.0 for "Good" on a 5-point scale
    word_count = Column(Integer, nullable=True)  # Word count for open-ended columns

    # Relationships
    row = relationship("DatasetRow", back_populates="values")
    column = relationship("DatasetColumn", back_populates="values")
    code_applications = relationship("CodeApplication", back_populates="dataset_value",
                                      cascade="all, delete-orphan")
    attached_notes = relationship("Note", back_populates="dataset_value",
                                   cascade="all, delete-orphan")
    excerpts = relationship("Excerpt", back_populates="dataset_value",
                             cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_dataset_values_row_column", "row_id", "column_id", unique=True),
    )
