"""Declared missing values — the missing-ness predicate module (#592, slab 1).

This module owns the "is this cell's text a missing/non-response value?"
decision. Two layers:

- ``_is_na`` — the recognized-N/A DEFAULT rule set (an English prefix list,
  moved here verbatim from ``dataset_import`` in #592 slab 1; that module
  re-exports it so existing importers are unchanged until slab 2 migrates
  them). It applies whenever a column carries NO declaration
  (``DatasetColumn.missing_values`` NULL) — which is every column that exists
  today, so nothing changes at rest.
- ``DatasetColumn.missing_values`` — a per-column DECLARED rule list (JSON).
  A non-null declaration REPLACES the defaults entirely (the
  ``treat_as_empty`` precedent; #592 §I.7): a column declaring only ``99``
  makes "Prefer not to say" a substantive answer on that column, and an
  explicit empty list ``[]`` declares that NOTHING is missing.

Rule shapes (JSON-native dicts, validated by ``parse_missing_rules``):

- discrete: ``{"value": "99", "label": "Refused"}`` — ``label`` optional.
  ``value`` is stored as a string (the cell space is ``value_text``); strings
  are legal discrete values (.sav string user-missing, #541b). The predicate
  matches the cell against the CODE **or** the LABEL, because a
  labelled-missing cell holds the LABEL in ``value_text`` after substitution
  (#592 §I.2/§I.3 — the label channel is what keeps such cells reachable).
  Matching is stripped-exact, plus numeric equality when both sides parse
  ("99" matches "99.0").
- range: ``{"lo": -99, "hi": -1, "label": "Sentinel"}`` — numeric-only (SPSS
  parity, mirroring ``sav_import._in_missing_range``); ``lo``/``hi`` may each
  be null = unbounded (.sav LO/HI THRU), at least one bound required. A
  range's ``label`` is display metadata only — it is never matched against
  cells (labels substitute per-code; a range covers many codes). Ranges are
  evaluated in PYTHON over the cell text — never SQL CAST, which coerces
  non-numeric text to 0.0 and would swallow every text cell into any range
  containing 0 (#592 §I.8). A non-numeric cell never falls in a range.

The predicate keys on ``value_text`` ONLY — never ``value_numeric``, which is
the REFLECTED score under a reverse primary and cleared under category_group
(the #585 lesson; #592 §I.4).

Parsing is whole-or-nothing: a malformed declaration (bad JSON, any invalid
rule) falls back to None = "the defaults apply", with a warning — never a
silently partial rule set (fail-open aggregation is the #552-class trap).
Writes go through validated endpoints (slab 3/4); malformed-at-rest is a
corruption case, and resilient-with-a-log matches ``parse_treat_as_empty``.
"""
import json
import logging
import math

logger = logging.getLogger(__name__)


# -- The DEFAULT rule set (recognized N/A) -------------------------------------
# Moved verbatim from dataset_import.py (#592 slab 1). This English prefix
# list is the "lottery" #592 exists to replace with declarations — it stays
# the default so undeclared columns behave exactly as before.

_NA_PREFIXES = [
    "not applicable", "n/a", "don't know", "do not know",
    "i don't know", "no answer", "no response", "prefer not",
    "decline to", "unable to", "cannot assess", "not enough",
    "i don't have enough",
]


def _is_na(value: str) -> bool:
    """Check if a value is a Not Applicable / Don't Know response."""
    lower = value.strip().lower()
    if not lower:
        return False
    if lower in ("na", "n/a"):
        return True
    return any(lower.startswith(p) for p in _NA_PREFIXES)


# -- Declared rules ------------------------------------------------------------

def _as_float(text) -> float | None:
    """Parse a value as a float for numeric matching; None when not numeric.

    NaN is rejected (it equals nothing and poisons range comparisons)."""
    try:
        num = float(text)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(num) else num


def _fmt_code(num: float) -> str:
    """Display a numeric code the way the data shows it (99, not 99.0).

    ⚠️ Load-bearing for every place a rule's ``value`` is written INTO cells
    (un-declare reversion, label substitution): a naive ``str(99.0)`` would
    land ``"99.0"`` in ``value_text`` where the data says ``"99"``.
    """
    return str(int(num)) if float(num).is_integer() else str(num)


def _validate_rule(rule) -> dict | None:
    """Return a normalized copy of one rule, or None when invalid."""
    if not isinstance(rule, dict):
        return None
    has_value = rule.get("value") is not None
    has_bound = rule.get("lo") is not None or rule.get("hi") is not None
    if has_value == has_bound:  # exactly one form, never both / neither
        return None
    if has_value:
        value = str(rule["value"]).strip()
        if not value:
            return None
        out: dict = {"value": value}
    else:
        lo, hi = rule.get("lo"), rule.get("hi")
        for bound in (lo, hi):
            if bound is not None and (
                isinstance(bound, bool) or not isinstance(bound, (int, float))
                # #592 slab 5: NaN/±inf are floats and would pass the type check.
                # An inf bound is worse than useless — it persists, the predicate
                # honors it, and then `json.dumps` writes a bare `Infinity` that
                # starlette's allow_nan=False JSONResponse refuses, 500-ing
                # `GET /data` for the WHOLE dataset. NaN silently matches
                # nothing (`nan >= x` is always False), so a rule that looks
                # declared would be inert. pyreadstat emits ±inf for SPSS's
                # LOWEST/HIGHEST THRU; the .sav adapter normalizes those to None
                # (= unbounded, the shape's own spelling) before they reach here.
                # This is the fail-closed half, for hand-authored payloads.
                or not math.isfinite(bound)
            ):
                return None
        if lo is not None and hi is not None and lo > hi:
            return None
        if lo is not None and hi is not None and lo == hi:
            # #612: a degenerate range IS a discrete value — normalize it, the
            # way the .sav adapter already does. As a range its label was dead
            # metadata (ranges never label-match, so "99 = Refused" authored as
            # {lo:99, hi:99, label:"Refused"} silently never substituted and
            # never reverted); as a discrete rule the label is first-class.
            # Applied here so BOTH write paths and the READ path (via
            # parse_missing_rules) agree — a legacy on-disk range surfaces as
            # discrete without a migration. _fmt_code, never str(): a float
            # bound ("99.0") written into value_text on un-declare would
            # corrupt cells that say "99".
            out = {"value": _fmt_code(lo)}
        else:
            out = {"lo": lo, "hi": hi}
    label = rule.get("label")
    if label is not None:
        if not isinstance(label, str) or not label.strip():
            return None
        out["label"] = label.strip()
    return out


def parse_missing_rules(raw: str | None) -> list[dict] | None:
    """Parse a stored ``missing_values`` JSON declaration.

    None / empty string → None ("no declaration; the ``_is_na`` defaults
    apply" — no migration backfill, the ``treat_as_empty`` pattern). A stored
    ``"[]"`` is a real declaration: nothing is missing. Whole-or-nothing on
    invalid input (see module docstring).
    """
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        logger.warning("Malformed missing_values JSON ignored: %.80s", raw)
        return None
    if not isinstance(data, list):
        logger.warning("missing_values is not a list; ignored: %.80s", raw)
        return None
    rules = []
    for entry in data:
        rule = _validate_rule(entry)
        if rule is None:
            logger.warning(
                "Invalid missing_values rule; whole declaration ignored: %.80s",
                raw,
            )
            return None
        rules.append(rule)
    return rules


def _discrete_rule_match(text: str, num: float | None, rule: dict) -> bool:
    """One discrete rule vs one (stripped) cell text: code match (stripped-
    exact or numeric-equal) or label match. Shared by the predicate and the
    append substitution channel so they can never disagree."""
    if "value" not in rule:
        return False
    if text == rule["value"]:
        return True
    rule_num = _as_float(rule["value"])
    if num is not None and rule_num is not None and num == rule_num:
        return True
    label = rule.get("label")
    return label is not None and text == label


def is_declared_missing(value_text: str | None, rules: list[dict]) -> bool:
    """True when the cell's text matches a DECLARED rule (see module doc)."""
    if value_text is None:
        return False
    text = value_text.strip()
    if not text:
        return False
    num = _as_float(text)
    for rule in rules:
        if "value" in rule:
            if _discrete_rule_match(text, num, rule):
                return True
        else:
            if num is None:
                continue  # non-numeric text never falls in a numeric range
            lo, hi = rule.get("lo"), rule.get("hi")
            if (lo is None or num >= lo) and (hi is None or num <= hi):
                return True
    return False


def matched_missing_label(value_text: str | None, rules: list[dict] | None) -> str | None:
    """The declared LABEL of the labelled discrete rule this text matches, if
    any — the append substitution channel (#592 §I.2b): an appended raw code
    lands with the same display text existing labelled-missing cells carry,
    so the dedup fingerprint can match them."""
    if not rules or value_text is None:
        return None
    text = value_text.strip()
    if not text:
        return None
    num = _as_float(text)
    for rule in rules:
        if rule.get("label") and _discrete_rule_match(text, num, rule):
            return rule["label"]
    return None


def is_missing(value_text: str | None, rules: list[dict] | None) -> bool:
    """THE missing decision for a cell's text (#592).

    ``rules is None`` (no declaration) → the ``_is_na`` defaults; a declared
    rule list (possibly empty) REPLACES the defaults entirely (§I.7).

    None/blank text is never *missing-by-declaration* — blank is the separate
    "empty" concept (``treat_as_empty`` owns text-emptiness; the import
    pipeline stores no row for a blank cell).
    """
    if value_text is None:
        return False
    if rules is None:
        return _is_na(value_text)
    return is_declared_missing(value_text, rules)


# Far above any real declaration (SPSS allows 3 discrete values or a range
# plus one), well below abuse territory (#612 — sibling of #588's still-open
# "no cap on value labels").
MAX_MISSING_RULES = 50


def normalize_missing_rules_payload(items: list) -> list[dict]:
    """Validate + normalize a WRITE-path declaration payload (#612, #614).

    Shared by BOTH write schemas — ``MissingValuesUpdate`` (the PUT endpoint)
    and ``DatasetColumnConfig`` (the import config) — so the payload-internal
    #606 collision arms cannot be bypassed by the import path (#614). Raises
    ``ValueError`` with a user-facing message; the schemas surface it as 422.

    - each rule normalizes via ``_validate_rule`` (whole-or-nothing, the exact
      shape ``parse_missing_rules`` reads back; degenerate ranges → discrete);
    - EXACT duplicate rules are dropped silently (a re-sent config is not an
      error);
    - two rules for the SAME discrete value (exact or numeric-equal — the
      predicate matches numerically, so "99" and "99.0" are one value) are
      refused: substitution and recovery would be ambiguous;
    - the payload-internal #606 arms run here: duplicate labels among labelled
      discrete rules, and a label equal to a DIFFERENT rule's value. The
      DB-dependent arms (scale-metadata pairing, observed responses) CANNOT
      run at import-config time — no column exists yet — and stay in
      ``missing_declaration._assert_no_label_collisions``; that boundary is
      deliberate, not an oversight. Range labels are display-only and exempt.
    - capped at ``MAX_MISSING_RULES``.
    """
    normalized: list[dict] = []
    seen_exact: set[tuple] = set()
    for rule in items:
        out = _validate_rule(rule)
        if out is None:
            raise ValueError(
                f"Invalid missing-value rule: {rule!r}. A rule is either "
                '{"value": "99", "label"?} or {"lo": -99, "hi": -1, '
                '"label"?} (numeric bounds, at least one non-null, lo <= hi).'
            )
        key = tuple(sorted(out.items()))
        if key in seen_exact:
            continue
        seen_exact.add(key)
        normalized.append(out)

    if len(normalized) > MAX_MISSING_RULES:
        raise ValueError(
            f"Too many missing-value rules ({len(normalized)}); "
            f"the maximum is {MAX_MISSING_RULES}."
        )

    values = [(r["value"], _as_float(r["value"])) for r in normalized if "value" in r]
    for i, (text, num) in enumerate(values):
        for other_text, other_num in values[i + 1:]:
            if text == other_text or (
                num is not None and other_num is not None and num == other_num
            ):
                raise ValueError(
                    f'"{text}" is declared missing more than once — each value '
                    "may appear in one rule only."
                )

    labelled = [r for r in normalized if "value" in r and r.get("label")]
    seen_labels: set[str] = set()
    for rule in labelled:
        label = rule["label"]
        if label in seen_labels:
            raise ValueError(
                f'Two rules share the label "{label}" — every missing value '
                "needs its own label."
            )
        seen_labels.add(label)
        label_num = _as_float(label)
        for other_text, other_num in values:
            if other_text == rule["value"]:
                continue
            if label == other_text or (
                label_num is not None and other_num is not None
                and label_num == other_num
            ):
                raise ValueError(
                    f'"{label}" is itself declared as a missing value by '
                    f'another rule — give code {rule["value"]} a distinct label.'
                )
    return normalized


def column_missing_rules(column) -> list[dict] | None:
    """The parsed declaration off a DatasetColumn (None = defaults apply)."""
    return parse_missing_rules(getattr(column, "missing_values", None))


def is_missing_for_column(column, value_text: str | None) -> bool:
    """Column-aware entry point — what slab 2 wires into every read site."""
    return is_missing(value_text, column_missing_rules(column))
