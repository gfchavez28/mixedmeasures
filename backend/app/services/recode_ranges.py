"""Range bands for a recode definition — #823(d), 2026-08-31.

Banding a continuous variable ("18–29 → Young") without typing one row per
distinct value. The authoring cost this removes is real and was measured twice:
**72 rows** for GSS `age`, **39 rows on a 48-row dataset** (#830(j)) — so it is
not a large-data problem, and *Category Group*, the rule type literally named for
grouping, had the identical shape.

## Where this sits in the match rule

A recode has always matched a cell by case-insensitive equality against
``mapping``'s keys. A range adds a SECOND channel, and the order is fixed:

1. **the null set** — declared-missing, recognized-N/A, or the definition's own
   ``exclude_values``. Unchanged, and it still runs FIRST (J-D1 / #594): a
   sentinel like ``-99`` on `age` must stay NULL even when a band covers it
   numerically. This is the reason the range channel could not simply be
   "another mapping".
2. **an explicit ``mapping`` key** — the specific beats the general, so a
   researcher who bands `0–120` and then maps `"99" → Refused` gets what they
   wrote.
3. **the first matching range**, in declared order.

⚠️ **`resolve_range_output` is the ONE implementation of step 3**, consumed by
both `compute_value` (per cell) and `plan_definition_over_column` (per distinct
value). #542b is the standing record of what a second copy costs here: the two
paths once disagreed about a stray non-numeric mapping value, so one cell got two
different numbers depending on which path computed it. The client mirrors this in
`lib/recode-ranges.ts` and is deliberately NOT authoritative.

## Parsing a cell

Through ``dataset_import._strip_numeric`` — THE cell-to-number rule — never a
local ``float()``. It is what makes a ``"1,200"`` parse the same way it does
everywhere else, and it already rejects the non-finite values #689 depends on.
A cell that does not parse simply does not match a range; it is not an error.
"""

import json
import logging

logger = logging.getLogger(__name__)

#: A band list is short by nature — a banding with more entries than this is
#: almost certainly a paste, and the per-value `mapping` is the right shape for
#: a long enumeration. Mirrors `MAX_MISSING_RULES`' reasoning, one concept over.
MAX_RECODE_RANGES = 50


class RangeBandError(ValueError):
    """A malformed band list. Raised at the WRITE path, never at apply time.

    ⚠️ Deliberately a `ValueError` subclass so the router's existing
    `except ValueError` arms keep working, and deliberately NOT raised from the
    read/apply path: `apply_definition_to_column` is on the STARTUP path via
    `repair_reverse_recode_mappings` (#794), so a raise there fires during boot
    on existing data. The read side degrades to "no bands" and logs.
    """


def _coerce_bound(raw, field: str):
    """A bound is a finite number or ``None`` (open end)."""
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise RangeBandError(f"Range {field} must be a number.")
    # `math.isfinite` rather than a bare comparison: a bare `Infinity` is not
    # JSON-compliant and would 500 the response that tried to return it (#689,
    # and the `.sav` ±inf trap in the missing-values importer).
    if value != value or value in (float("inf"), float("-inf")):
        raise RangeBandError(f"Range {field} must be a finite number.")
    return value


def normalize_ranges(raw, *, allow_output_text: bool = True) -> list[dict]:
    """Validate a band list on the way IN. Raises `RangeBandError`.

    Mirrors `services/missing_values._validate_rule`'s shape rules — at least one
    bound, bounds finite, ``lo <= hi`` — and adds the one that differs: the
    OUTPUT is required, because here it is the rule's result rather than display
    metadata.

    ``allow_output_text`` is False for a SCALE_MAP, whose output must be a
    number: a scale map writes `value_numeric`, and a band emitting a string
    there would land in `unmapped` at apply time with no explanation the
    researcher could act on.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RangeBandError("Ranges must be a list.")
    if len(raw) > MAX_RECODE_RANGES:
        raise RangeBandError(
            f"At most {MAX_RECODE_RANGES} ranges can be declared (received {len(raw)})."
        )

    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise RangeBandError("Each range must be an object.")
        lo = _coerce_bound(entry.get("lo"), "low bound")
        hi = _coerce_bound(entry.get("hi"), "high bound")
        if lo is None and hi is None:
            raise RangeBandError("A range needs a low or a high value.")
        if lo is not None and hi is not None and lo > hi:
            raise RangeBandError(f"Range {lo} to {hi} is backwards.")

        if "output" not in entry or entry["output"] is None or entry["output"] == "":
            raise RangeBandError("Every range needs a value to map to.")
        output = entry["output"]
        if isinstance(output, str) and not allow_output_text:
            try:
                output = float(output)
            except ValueError:
                raise RangeBandError(
                    f'A scale map\'s ranges must map to numbers — "{output}" is text. '
                    "Use a category group to band into named groups."
                )
        elif not isinstance(output, (str, int, float)):
            raise RangeBandError("A range's value must be a number or a name.")

        out.append({"lo": lo, "hi": hi, "output": output})
    return out


def parse_ranges(raw_json: str | None) -> list[dict]:
    """Read a stored band list. Never raises — the read path must not.

    ⚠️ Shape is re-checked on the way OUT, not only on the way in. A stored
    non-list (legacy data, a hand-edited database, a future field written by a
    newer build) would otherwise reach the matcher and raise mid-apply, on the
    STARTUP path. Degrading to "no bands" logs loudly and leaves the mapping
    channel working.
    """
    if not raw_json:
        return []
    try:
        parsed = json.loads(raw_json)
    except (json.JSONDecodeError, TypeError):
        logger.warning("Unparseable recode ranges JSON; ignoring: %r", raw_json[:120])
        return []
    if not isinstance(parsed, list):
        logger.warning("Recode ranges is not a list; ignoring: %r", parsed)
        return []

    out: list[dict] = []
    for entry in parsed:
        if not isinstance(entry, dict) or "output" not in entry:
            continue
        lo, hi = entry.get("lo"), entry.get("hi")
        if lo is not None and not isinstance(lo, (int, float)):
            continue
        if hi is not None and not isinstance(hi, (int, float)):
            continue
        if lo is None and hi is None:
            continue
        out.append({"lo": lo, "hi": hi, "output": entry["output"]})
    return out


def resolve_range_output(value_text: str, ranges: list[dict]):
    """The band a cell falls in, or ``None``.

    🔴 **THE range match, with exactly one implementation.** Both backend
    matchers call it — `compute_value` per cell and `plan_definition_over_column`
    per distinct value — because a cell must get the same number whichever path
    computed it (#542b).

    Bounds are INCLUSIVE at both ends, which is what a researcher writing
    "18 to 29" means. Adjacent bands are therefore the author's responsibility
    (18–29, 30–44), and overlap is resolved by ORDER: the first declared band
    that contains the value wins, so a narrow special case can be listed above a
    catch-all.
    """
    if not ranges or value_text is None:
        return None
    # Imported here rather than at module scope only to keep this module free of
    # the import-time cost of the adapter package; `dataset_import` does not
    # import this service, so a module-level import would also be safe.
    from .dataset_import import _strip_numeric

    number = _strip_numeric(value_text.strip())
    if number is None:
        return None
    for band in ranges:
        lo, hi = band.get("lo"), band.get("hi")
        if lo is not None and number < lo:
            continue
        if hi is not None and number > hi:
            continue
        return band["output"]
    return None
