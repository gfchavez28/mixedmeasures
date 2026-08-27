from sqlalchemy import Boolean, Column, Integer, String, DateTime, Text, Float, ForeignKey, Index, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy import text as _sa_text
from uuid import uuid4
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
    IDENTIFIER = "identifier"    # Participant/row identity code (#414) — links rows
    #                              to Participants; member of NO eligibility set
    #                              (not numeric, not scale, not text, not groupable)
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

# CROSSWALK_INELIGIBLE_TYPES — types that can never be an equivalence-group /
# analysis-domain member (#556b). An EXCLUSION set, unlike the two above, because
# what belongs in a variable group is "a measurement" — an open list — while what
# cannot is a short closed one:
#   SKIP       — discarded data; never analysed.
#   IDENTIFIER — holds row IDENTITY, not a measurement (#414). It carries no
#                `value_numeric`, so an identifier-only group's auto scale-score
#                400s (`non_numeric_domain` → a "failed" Σ badge) and an
#                identifier added to a numeric group contributes NULL silently.
# Consumed by the equivalence find-matches + suggest pools and the analysis-domain
# suggest pool (which excludes DEMOGRAPHIC on top of this — that one is a routing
# concern, not an ineligibility one, so it stays local). Frontend mirror:
# `lib/dataset-constants.ts::CROSSWALK_INELIGIBLE_TYPES`. New crosswalk-eligibility
# gates MUST import this, never re-inline a `!= "skip"` string check (invariant I-D).
CROSSWALK_INELIGIBLE_TYPES = frozenset({
    ColumnType.SKIP,
    ColumnType.IDENTIFIER,
})

# VALUE_LABEL_INELIGIBLE_TYPES — types a declared code→label dictionary must
# never be applied to (#589). An EXCLUSION set for the same reason as the one
# above: "which columns can carry value labels" is an open list, "which cannot"
# is a short closed one.
#   OPEN_TEXT  — free-form responses are not codes; substituting a label into
#                `value_text` would overwrite what the participant wrote.
#   IDENTIFIER — the value IS the identity, and participant linking (#414) runs
#                AFTER the import's value-label post-pass, so it would match on
#                cells already overwritten with labels.
# ⚠️ The two consumers are NOT interchangeable and both are required. The router
# (`recode.py::apply_value_labels_endpoint`) refuses early with a clean 400; the
# SERVICE (`value_labels.py::apply_value_labels`) refuses the operation, because
# the import path calls it directly via `cells_are_codes` and never passes a
# router at all — that gap was #589, and it is the #585 lesson restated: a guard
# at the router is not a guard on the operation.
#
# ⚠️ **Two sibling gates in `routers/recode.py` spell the SAME pair inline today
# and are deliberately NOT routed through this constant** — recode-definition
# creation (#414) and the missing-values declaration. They exclude the same two
# types for related but distinct reasons, and nothing has decided they must move
# together; merging them would assert an agreement no one has verified (the
# `VALUE_NUMERIC_TYPES` / `SCALE_SCORE_ELIGIBLE_TYPES` lesson, which differ by
# exactly one member ON PURPOSE). If a third type ever joins one of the three,
# that is the moment to decide whether they are one set or three.
VALUE_LABEL_INELIGIBLE_TYPES = frozenset({
    ColumnType.OPEN_TEXT,
    ColumnType.IDENTIFIER,
})


# NUMERIC_COERCIBLE_TYPES — a FOURTH set, and it answers a question the three
# above cannot (#823d, 2026-08-25).
#
# 🔴 **The question is not "is this column numeric?" but "may a FORMULA read a
# number out of its cell?"** `_compute_value_numeric` returns None for
# DEMOGRAPHIC, so every demographic cell carries `value_numeric = NULL` — and
# the importer assigns that type itself to `age`, `income`, `sex` and `race`.
# `IF([age] < 45, …)` therefore validated as *"Valid"*, previewed null for every
# row, and raised on save, on precisely the columns a researcher most wants to
# band.
#
# ⚠️ **DEMOGRAPHIC MUST NOT JOIN `VALUE_NUMERIC_TYPES`, and this set exists so
# nobody tries.** MEASURED: that set is read by `data_quality.py` (twice), the
# MCAR loader and `comparisons.py`. Because every demographic cell's
# `value_numeric` is NULL, adding the type there makes `_classify_value` return
# `na_unusable` for every non-empty cell — a class in `_ALWAYS_MISSING`, which
# the UI toggle cannot switch off — so the Data Quality tab would report ~100%
# missing on `age`, `sex` and `race`. That is #819 pointing the other way, one
# round after #819 shipped. It would also not FIX anything: computed columns
# read `value_numeric`, which stays NULL either way.
#
# ⚠️ So the coercion is at READ time, in the formula evaluator alone, and it is
# per CELL: a demographic cell whose text parses as a number is a number, one
# that does not is text, exactly as before. NOMINAL is deliberately absent — its
# `value_text` IS the label (#494) and its `_TXT` fallback is load-bearing for
# `==` comparisons.
NUMERIC_COERCIBLE_TYPES = frozenset({
    ColumnType.DEMOGRAPHIC,
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
    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    project = relationship("Project", back_populates="datasets")
    # ⚠️ #802: `passive_deletes=True` on every collection here that can be
    # UNBOUNDED. Without it SQLAlchemy's `delete-orphan` cascade LOADS every
    # child row into the session purely to delete it — MEASURED on a 75,699-row
    # dataset (3,103,659 values): the ORM delete was **abandoned at 664s and
    # 2,770 MB RSS**, still running, while `DELETE FROM datasets WHERE id=?`
    # took **22.0s** at constant memory with no orphans and a clean
    # `PRAGMA foreign_key_check`.
    #
    # Safe because both halves were verified, not assumed: every inbound FK in
    # this tree is `ON DELETE CASCADE` (12 checked; the only two exceptions are
    # `metric_definitions.grouping_column_id{,_2}`, deliberately SET NULL), and
    # `PRAGMA foreign_keys=ON` is set on every connection in `database.py` and
    # confirmed live. Nothing in the codebase de-associates via
    # `collection.remove()`, which is the one case `delete-orphan` still has to
    # handle itself.
    #
    # ⚠️ This also fixes PROJECT delete, which cascades through `Project.
    # datasets` into exactly the same relationships — a surgical fix in
    # `delete_dataset` alone would have left that path broken.
    columns = relationship("DatasetColumn", back_populates="dataset", cascade="all, delete-orphan", passive_deletes=True, order_by="DatasetColumn.display_order, DatasetColumn.sequence_order")
    rows = relationship("DatasetRow", back_populates="dataset", cascade="all, delete-orphan", passive_deletes=True)


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

    # #592: declared missing values — JSON rule list (discrete {"value","label"?}
    # and numeric-range {"lo","hi","label"?} forms; see services/missing_values.py
    # for the shapes + REPLACE semantics). NULL = no declaration = the
    # recognized-N/A defaults apply (the treat_as_empty pattern: no backfill).
    missing_values = Column(Text, nullable=True)

    source = Column(String(20), nullable=False, default="imported", server_default="imported")
    # "imported" (from CSV), "manual" (created in data view), or "computed" (formula-derived)

    # Computed column fields
    expression = Column(Text, nullable=True)
    depends_on_column_ids = Column(Text, nullable=True)  # JSON array of column IDs
    stale = Column(Boolean, nullable=True, default=False, server_default="0")

    # Decision B (2026-08-24) — provenance for a variable derived FROM another
    # by a recode rule. A derived column is `source="manual"`, never
    # `"computed"`: a computed column is refused value labels, missing rules AND
    # recode definitions by three separate endpoints whatever its type (#806),
    # and a derived variable you cannot label is useless.
    #
    # ⚠️ `derived_via` is the rule's NAME, snapshotted — NOT a FK to
    # `recode_definitions`. The column's cells were computed once and never
    # recompute, so a live link would keep resolving to the rule's CURRENT
    # mapping and quietly make the provenance claim false the moment that rule
    # is edited. See the migration for why `depends_on_column_ids` is not reused.
    derived_from_column_id = Column(
        Integer,
        ForeignKey("dataset_columns.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    derived_via = Column(String(255), nullable=True)

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

    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))

    # Relationships
    dataset = relationship("Dataset", back_populates="columns")
    equivalence_group = relationship("EquivalenceGroup", back_populates="columns")
    # #802 — a single column holds one value per row (75,699 on the GSS import).
    values = relationship("DatasetValue", back_populates="column", cascade="all, delete-orphan", passive_deletes=True)
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
    # Track J · J3-2-0: stable cross-instance identity for merge matching
    uuid = Column(String(36), unique=True, index=True, nullable=True, default=lambda: str(uuid4()))
    created_at = Column(DateTime, default=func.now(), nullable=False)

    # Relationships
    dataset = relationship("Dataset", back_populates="rows")
    participant = relationship("Participant", back_populates="dataset_rows")
    # #802 — bounded by column count per row, but unbounded in aggregate when
    # a dataset cascade walks every row.
    values = relationship("DatasetValue", back_populates="row", cascade="all, delete-orphan", passive_deletes=True)
    row_scores = relationship("RowScore", back_populates="dataset_row", cascade="all, delete-orphan", passive_deletes=True)

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
