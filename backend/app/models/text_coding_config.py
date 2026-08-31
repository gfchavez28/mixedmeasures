import json

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from ..database import Base

# Default list of strings treated as empty/non-substantive responses
DEFAULT_TREAT_AS_EMPTY = ["N/A", "n/a", "NA", "No response", "None", "-", "."]

#: A non-response vocabulary is SHORT — GSS, the largest corpus this has been
#: driven against, uses six sentinels across 41 variables. The cap exists to
#: bound a paste, not to constrain research; it sits between the sibling
#: declarations' 50 (`MAX_MISSING_RULES`) and 500 (`MAX_VALUE_LABELS`) for the
#: same reason each of those was chosen — this list is per PROJECT, not per
#: column, so it needs less room than a column's own dictionary.
MAX_TREAT_AS_EMPTY = 50


def normalize_treat_as_empty(values: list[str]) -> list[str]:
    """Clean a `treat_as_empty` list on the way IN. Raises `ValueError`.

    🔴 **A rule that can never fire is the defect this prevents (#823a's class,
    one seam over).** `is_empty_text` strips the CELL and compares the result
    against this list — so an entry carrying its own leading or trailing space
    matches NOTHING, silently, forever. The researcher sees "N/A" on screen
    either way. Stripping here is what makes the entry mean what it looks like.

    ⚠️ **Blank entries are DROPPED rather than refused.** A genuinely empty cell
    is already empty by `is_empty_text`'s first clause, so `""` in this list is
    a no-op that only reads as a rule; refusing it would turn a harmless
    trailing row in an editor into an error the researcher has to understand.

    ⚠️ **Order is preserved and duplicates drop the LATER copy**, so the list
    reads back the way it was authored.

    ⚠️ This does NOT decide the three states — that is the caller's. `None`
    (never reaching here) means "use the defaults"; `[]` — including a list that
    normalizes to empty — means "nothing but a blank cell is empty".
    """
    if not isinstance(values, list):
        raise ValueError("treat_as_empty must be a list of strings")

    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            raise ValueError("treat_as_empty must contain only strings")
        stripped = value.strip()
        if not stripped or stripped in seen:
            continue
        seen.add(stripped)
        cleaned.append(stripped)

    if len(cleaned) > MAX_TREAT_AS_EMPTY:
        raise ValueError(
            f"At most {MAX_TREAT_AS_EMPTY} non-response values can be declared "
            f"(received {len(cleaned)})."
        )
    return cleaned


def parse_treat_as_empty(raw: str | None) -> list[str]:
    """Parse a stored `treat_as_empty` JSON list, falling back to the defaults.

    Single source for the "which strings count as an empty text" decision (#519):
    the text-coding gauge, the text-analysis denominators, and the export all
    route through this + `is_empty_text` so their counts can never disagree.

    Three states, matching the missing-value declaration's shape: `NULL` = the
    defaults · `[]` = nothing but a blank cell counts · a list = REPLACE.
    ⚠️ `"[]"` is a truthy STRING, so an explicit empty declaration survives the
    falsy check above and does NOT collapse back to the defaults.

    ⚠️ **The shape is re-checked on the way OUT, not only on the way in.** A
    stored non-list (legacy junk, a hand-edited database) would otherwise reach
    `is_empty_text`'s `in` operator and raise `TypeError` — a 500 on every text
    surface in the project, from data nothing currently validates.
    """
    if raw:
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            parsed = None
        if isinstance(parsed, list):
            return [v for v in parsed if isinstance(v, str)]
    return DEFAULT_TREAT_AS_EMPTY


def is_empty_text(value_text: str | None, treat_as_empty: list[str]) -> bool:
    """True when a text value is blank or a recognized non-substantive string."""
    if not value_text or not value_text.strip():
        return True
    return value_text.strip() in treat_as_empty


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
