"""The types a variable may form groups by — one set, two languages (D166).

`lib/dataset-constants.ts::CATEGORICAL_GROUPING_TYPES` decides what the group-by and
cross-tab pickers OFFER; `models/dataset.py::CATEGORICAL_GROUPING_TYPES` decides what
the participant-grouped doors (the code-by-group comparison and the joint display,
grouping by a column id) ACCEPT. Hand-mirrored with no codegen, so this test is the
only thing connecting them: a type offered and refused is a control that 400s, and one
accepted and never offered is a door nobody can reach on purpose.
"""

import re
from pathlib import Path

from app.models.dataset import CATEGORICAL_GROUPING_TYPES, ColumnType

DATASET_CONSTANTS_TS = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "dataset-constants.ts"
)


def _client_set() -> set[str]:
    assert DATASET_CONSTANTS_TS.exists(), (
        f"{DATASET_CONSTANTS_TS} not found — the client half moved. Update this path "
        "rather than deleting the test."
    )
    source = DATASET_CONSTANTS_TS.read_text(encoding="utf-8")
    found = re.search(
        r"export const CATEGORICAL_GROUPING_TYPES[^=]*=\s*\[([^\]]*)\]", source)
    assert found, "could not find CATEGORICAL_GROUPING_TYPES in dataset-constants.ts"
    return set(re.findall(r"'([a-z_]+)'", found.group(1)))


def test_the_server_and_the_client_name_the_same_types():
    client = _client_set()
    # A population floor: a regex that matched an empty array would make the
    # equality below compare two empty sets the day the server's set were emptied.
    assert len(client) >= 4, sorted(client)
    assert {t.value for t in CATEGORICAL_GROUPING_TYPES} == client


def test_continuous_types_never_form_groups():
    """The decided boundary (2026-05-26): bin a continuous variable first."""
    assert ColumnType.NUMERIC not in CATEGORICAL_GROUPING_TYPES
    assert ColumnType.PERCENTAGE not in CATEGORICAL_GROUPING_TYPES
    assert ColumnType.OPEN_TEXT not in CATEGORICAL_GROUPING_TYPES
    assert ColumnType.IDENTIFIER not in CATEGORICAL_GROUPING_TYPES


def test_a_raw_string_matches_an_enum_member():
    """The str-enum property the other type sets rely on holds for this one."""
    assert "nominal" in CATEGORICAL_GROUPING_TYPES
