"""The two column payloads must not drift — the #586 class, guarded.

## Why this exists

`DatasetDataColumnResponse` (the `/data` payload, which is the ONLY one the
column editors and the grid read) is built by **splatting**
`DatasetColumnResponse.model_dump()`. Pydantic's default `extra='ignore'` then
drops any field the sibling does not declare — **silently**, with no type error,
no warning, and a green suite.

That has now cost three separate defects on this one class:

| # | field | what the drop did |
|---|---|---|
| #577/#586 | `scale_values` | the value-labels editor's edit-mode pre-fill always missed, so it re-seeded from OBSERVED codes and dropped any declared zero-response level |
| #592 | `missing_values` | `/data` carried no declaration, so the editor could not show one |
| Decision B (2026-08-24) | `derived_from_column_id` / `derived_via` | the grid called a DERIVED variable a hand-typed one — the opposite of what it is |

Each was fixed by adding the field and moving on. This is the fourth prevention
rather than a fourth fix.

## Why an ALLOWLIST rather than "these fields must be present"

A named-field list only ever catches the field you already thought of, which is
the shape that let the same rule ship three times (the #771 → #785 lesson, one
layer down). Inverting it — *every* field must cross unless it is on a list with
a reason — means the NEXT field is caught by a test nobody has to remember to
update, and the allowlist entry is where the deliberate omission gets argued.
"""

import pytest

from app.schemas.dataset import DatasetColumnResponse, DatasetDataColumnResponse


#: Fields on the full column response the `/data` sibling deliberately omits.
#: An entry here is a CLAIM that no `/data` consumer needs the field — add one
#: only with the reason, and only after checking the frontend.
DELIBERATELY_NOT_ON_DATA = {
    # The grid renders columns in the order `/data` already sorts them, so the
    # raw ordinal has no consumer there; `DatasetView` reorders through the
    # dedicated PATCH, which reads the full response.
    "display_order",
    # `/data` consumers pick the active definition out of `recode_definitions`
    # themselves, so the summary would be a second way to say the same thing on
    # the one payload that does not need it.
    #
    # ⚠️ **This entry's REASON changed on 2026-08-31 (#830f) even though the
    # entry did not.** It used to read "the SUMMARY built for surfaces that do
    # NOT get the full list" — true only while `recode_definitions` rode `/data`
    # alone. Every column payload carries the full list now, so the surfaces are
    # no longer the distinction; the consumer's need is. The field still earns
    # its place on `DatasetColumnResponse` because it carries `remaps_codes`,
    # which is COMPUTED (`_mapping_remaps_codes`) and cannot be read off a
    # summary without re-implementing the shape test client-side.
    "primary_recode",
    # A participant-profile opt-out is edited and read on the participant
    # surfaces, never in the data grid.
    "show_in_participant_profile",
}


def test_every_column_field_reaches_the_data_payload_unless_excused():
    """The population assertion. A new field crosses by default."""
    full = set(DatasetColumnResponse.model_fields)
    data = set(DatasetDataColumnResponse.model_fields)

    missing = full - data - DELIBERATELY_NOT_ON_DATA
    assert not missing, (
        f"{sorted(missing)} is declared on DatasetColumnResponse but NOT on "
        "DatasetDataColumnResponse. `/data` is splat-constructed from the "
        "former and Pydantic's extra='ignore' will DROP it silently — the "
        "#586 class, which has already cost three defects on this class. "
        "Either declare it on the sibling, or add it to "
        "DELIBERATELY_NOT_ON_DATA with the reason no /data consumer needs it."
    )


def test_the_allowlist_has_no_stale_entries():
    """A field removed from the response must leave the allowlist too.

    Without this the allowlist rots into a list of names that mean nothing, and
    a future field reusing a retired name would be excused by accident.
    """
    full = set(DatasetColumnResponse.model_fields)
    stale = DELIBERATELY_NOT_ON_DATA - full
    assert not stale, (
        f"{sorted(stale)} is in DELIBERATELY_NOT_ON_DATA but no longer exists "
        "on DatasetColumnResponse — delete the entry."
    )


def test_the_scan_is_looking_at_something():
    """🔴 The population self-check.

    `assert not missing` passes by finding nothing — including when both
    `model_fields` reads have gone empty because the classes moved or were
    renamed. A floor makes the walk itself falsifiable, which is the difference
    between a guard and a green light (#730).
    """
    assert len(DatasetColumnResponse.model_fields) > 20
    assert len(DatasetDataColumnResponse.model_fields) > 15


@pytest.mark.parametrize("field", ["scale_values", "missing_values", "derived_via"])
def test_the_three_fields_this_rule_already_cost_us(field):
    """Each of these was a live defect. Pinned by name as well as by population.

    Belt-and-braces on purpose: the population test above is the one that
    catches the NEXT field, and these three are the ones a refactor is most
    likely to "tidy away" precisely because their presence looks redundant.
    """
    assert field in DatasetDataColumnResponse.model_fields
