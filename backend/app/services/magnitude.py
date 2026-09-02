"""Magnitude coding — the declared instrument, and what a rating may be (#35).

A magnitude is a per-application RATING on a code: "how much does this segment have
this characteristic?", answered on a scale the researcher DECLARES up front
(min / max / step / anchor labels). The declaration is what separates this from
MAXQDA's `weight score`, whose own manual calls it a "fuzzy variable" that is
"not meant to give an exact numerical worth" — a number with no stated meaning can
be sorted but not analysed.

**This module is the ONE place three questions are answered**, because each has a
wrong answer that looks right:

1. *May this code carry a scale at all?*        `scale_refusal`
2. *Is this declaration well-formed?*           `normalize_scale`
3. *Is this value legal on that scale?*         `validate_value`

Every writer routes through them. A guard at the router is not a guard on the
operation (#589) — the same lesson that produced `value_labels.py`'s service-level
refusal — so the checks live here and the routers only make the refusal earlier
and cheaper.

## The rules that are easy to get wrong

🔴 **`magnitude` is NULLABLE and an unrated application is NOT a zero.** MAXQDA
default-stamps every coded segment with `0`, which makes *unrated* and *rated zero*
indistinguishable. On a −1…+1 scale zero is a real, meaningful neutral, so
conflating them destroys data rather than tidying it. Never introduce a non-null
default, and never shorten an emptiness check to `if not magnitude` — that is the
falsy-zero class this codebase has already been bitten by.

🔴 **A rating must be FINITE.** `nan`/`inf` cannot be serialized: starlette renders
with `allow_nan=False`, so one that reaches the wire raises at RESPONSE time — a 500
on a request that computed fine (#689/#566). JSON also accepts a bare `Infinity` on
the way IN (verified by execution, the #625 door), so the refusal is on the write
path, not only on the read.

🔴 **A scale that is narrowed must not strand values.** Editing `0..10` down to
`0..5` would leave every stored `8` outside its own instrument, and a
silently-clamped `8 → 5` is a fabricated rating. `scale_change_would_strand`
answers with the COUNT so the refusal can name it.

⚠️ **A universal code is refused a scale.** The 0/1 row (`Unsubstantive/Artifact`,
`Unclear`) marks artifacts, and every coded-count and reliability surface already
excludes it by construction (`coding_counts`, `non_consensus_filter`'s neighbours).
"How much is this unclear?" is not a measurement anyone would analyse, and offering
the editor would produce ratings that silently never reach a statistic.

⚠️ **The refusal returns a REASON, not a bool.** Two causes need different words on
screen — the mirror of `lib/dataset-constants.ts::variableRulesRefusal`, which
exists because a type-only gate offered three editors that all 403'd (#806).
"""

from __future__ import annotations

import json
import math
from typing import Any, Literal

# A declared scale carries at most this many anchor labels. Bounded for the same
# reason `MAX_VALUE_LABELS` is: the payload rides every code list response, and an
# unbounded list is a denial-of-service by paste. Generous enough for a 0–100 scale
# labelled every ten points, plus room.
MAX_MAGNITUDE_ANCHORS = 24

# Guardrails on the declaration itself. These are not opinions about good
# measurement — they only keep the instrument renderable and the arithmetic sane.
MAX_MAGNITUDE_BOUND = 1_000_000.0
MIN_MAGNITUDE_STEP = 1e-6

ScaleRefusal = Literal["universal", "inactive"]


class MagnitudeError(ValueError):
    """A magnitude declaration or value the tool refuses.

    A DISTINCT type, deliberately. `routers/coding.py` maps bare `ValueError` from
    its neighbours onto other statuses, and a shared type would report a refused
    rating as something else entirely — the `DatasetTooLargeError` lesson (#797),
    where a generic exception turned a size refusal into "check the file format".
    """


# ─────────────────────────── 1. may this code carry a scale? ───────────────────

def scale_refusal(code: Any) -> ScaleRefusal | None:
    """Why this code may not carry a magnitude scale, or None if it may.

    Returns a REASON rather than a bool so each caller can say the right thing;
    an inactive code and a universal one are refused for unrelated reasons and a
    single "not allowed" message would be wrong for one of them.
    """
    if getattr(code, "is_universal", False):
        return "universal"
    if not getattr(code, "is_active", True):
        return "inactive"
    return None


def has_scale(code: Any) -> bool:
    """True when this code carries a usable declared scale.

    ⚠️ Both bounds are required together. A half-declared scale (a min, no max) is
    not a lenient instrument — it is one with no range to normalise against, so
    every display that positions a value within its range would divide by nothing.
    `normalize_scale` cannot produce that state; this predicate is what stops a
    hand-edited database from reaching the renderers with it.
    """
    return code.magnitude_min is not None and code.magnitude_max is not None


# ─────────────────────────── 2. is the declaration well-formed? ────────────────

def _finite(value: Any, field: str) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise MagnitudeError(f"{field} must be a number")
    if not math.isfinite(out):
        raise MagnitudeError(f"{field} must be a finite number")
    if abs(out) > MAX_MAGNITUDE_BOUND:
        raise MagnitudeError(f"{field} must be between −{MAX_MAGNITUDE_BOUND:g} and {MAX_MAGNITUDE_BOUND:g}")
    return out


def normalize_scale(payload: dict | None) -> dict | None:
    """Validate a scale declaration and return it in storage shape, or None to clear.

    Shape in and out::

        {"min": 0, "max": 10, "step": 1,
         "anchors": [{"value": 0, "label": "none"}, {"value": 10, "label": "strong"}]}

    ⚠️ **`None` means CLEAR and must pass through untouched.** Normalising it to an
    empty dict would turn "this code no longer has a scale" into "this code has a
    scale with nothing in it" — the inverted instruction #816 documents for
    `treat_as_empty`, where collapsing `None` to `[]` reversed the researcher's
    meaning.

    ⚠️ Anchors are validated against the range they annotate. An anchor outside
    `min..max` labels a point the scale cannot express, which is #823(a)'s class
    one seam over: a declaration accepted with the same success message as one that
    does something.
    """
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise MagnitudeError("Scale must be an object")

    lo = _finite(payload.get("min"), "Minimum")
    hi = _finite(payload.get("max"), "Maximum")
    if lo >= hi:
        raise MagnitudeError("Maximum must be greater than minimum")

    raw_step = payload.get("step")
    step = 1.0 if raw_step is None else _finite(raw_step, "Step")
    if step < MIN_MAGNITUDE_STEP:
        raise MagnitudeError("Step must be a positive number")
    if step > (hi - lo):
        raise MagnitudeError("Step must not be larger than the range it divides")

    anchors_in = payload.get("anchors") or []
    if not isinstance(anchors_in, list):
        raise MagnitudeError("Anchors must be a list")
    if len(anchors_in) > MAX_MAGNITUDE_ANCHORS:
        raise MagnitudeError(f"At most {MAX_MAGNITUDE_ANCHORS} anchor labels")

    anchors: list[dict] = []
    seen: set[float] = set()
    for entry in anchors_in:
        if not isinstance(entry, dict):
            raise MagnitudeError("Each anchor must be an object")
        value = _finite(entry.get("value"), "Anchor value")
        if value < lo or value > hi:
            raise MagnitudeError(f"Anchor {value:g} is outside the scale's range")
        if value in seen:
            raise MagnitudeError(f"Two anchors both label {value:g}")
        seen.add(value)
        label = (entry.get("label") or "").strip()
        if not label:
            raise MagnitudeError("An anchor needs a label")
        if len(label) > 80:
            raise MagnitudeError("An anchor label is limited to 80 characters")
        anchors.append({"value": value, "label": label})

    anchors.sort(key=lambda a: a["value"])
    return {"min": lo, "max": hi, "step": step, "anchors": anchors}


def read_scale(code: Any) -> dict | None:
    """The code's declared scale, as a dict, or None.

    ⚠️ Re-checks the SHAPE on the way OUT, not only on the way in. A stored
    non-object (legacy data, a hand-edited database) would otherwise reach the
    renderers and raise on attribute access — a 500 on every coding surface in the
    project, which is exactly the failure `parse_treat_as_empty` guards against.
    """
    if not has_scale(code):
        return None
    raw = code.magnitude_labels
    anchors: list[dict] = []
    if raw:
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, list):
                anchors = [
                    a for a in parsed
                    if isinstance(a, dict) and isinstance(a.get("value"), (int, float))
                ]
        except (ValueError, TypeError):
            anchors = []
    return {
        "min": code.magnitude_min,
        "max": code.magnitude_max,
        "step": code.magnitude_step if code.magnitude_step else 1.0,
        "anchors": anchors,
    }


def write_scale(code: Any, scale: dict | None) -> None:
    """Persist a normalized scale onto the code (or clear it). Single writer."""
    if scale is None:
        code.magnitude_min = None
        code.magnitude_max = None
        code.magnitude_step = None
        code.magnitude_labels = None
        return
    code.magnitude_min = scale["min"]
    code.magnitude_max = scale["max"]
    code.magnitude_step = scale["step"]
    code.magnitude_labels = json.dumps(scale["anchors"]) if scale["anchors"] else None


# ─────────────────────────── 3. is this value legal? ───────────────────────────

def validate_value(code: Any, value: float | None) -> float | None:
    """Check a rating against its code's declared scale. Returns it, or raises.

    🔴 `None` is ALWAYS legal and always means *unrated* — never zero. It is the
    value an explicit skip stores, so it stays legal even on a scale whose range
    excludes zero. ⚠️ That includes an INACTIVE code: clearing a rating is
    recoverable and takes no judgement about the scale, so retiring a code never
    strands a rating a coder wants to withdraw.

    ⚠️ An inactive code is refused a NEW rating here, not only at `apply_code`
    (#869 g). `set_code_magnitude` never asked `is_active`, so a retired code could
    go on being rated through the one door that skipped the check — the refusal
    lives in this module precisely so every caller inherits it.
    """
    if value is None:
        return None

    refusal = scale_refusal(code)
    if refusal == "universal":
        raise MagnitudeError("Universal codes cannot carry a rating")
    if refusal == "inactive":
        raise MagnitudeError(
            f"“{code.name}” is inactive. Restore it before rating it."
        )

    if not has_scale(code):
        raise MagnitudeError(
            f"“{code.name}” has no rating scale. Declare one on the code before rating it."
        )

    out = _finite(value, "Rating")
    lo, hi = code.magnitude_min, code.magnitude_max
    if out < lo or out > hi:
        raise MagnitudeError(
            f"{out:g} is outside “{code.name}”'s scale ({lo:g} to {hi:g})"
        )
    return out


def scale_change_would_strand(applications_values: list[float], scale: dict | None) -> int:
    """How many existing ratings a proposed scale would put out of range.

    Clearing a scale strands nothing — the values are kept and simply stop being
    interpretable until a scale returns, which is recoverable. NARROWING one is the
    destructive case, and the caller refuses while naming this count. Clamping was
    considered and rejected: a clamped rating is a number no coder ever gave.
    """
    if scale is None:
        return 0
    lo, hi = scale["min"], scale["max"]
    return sum(1 for v in applications_values if v is not None and (v < lo or v > hi))


# ─────────────────────────── 4. what it announces ──────────────────────────────

def describe_value(code: Any, value: float | None) -> str:
    """The spoken form of a rating, for an accessible name.

    ⚠️ A fill bar announces NOTHING, and a bare “−0.5” is not a rating — it is a
    number whose scale the reader cannot see. The chip's visible track is decorative
    and `aria-hidden`; this string is what carries the fact, the same split #753
    settled for the coder-attribution badge.

    ⚠️ Says “not rated”, never “0”.
    """
    if value is None:
        return "not rated"
    scale = read_scale(code)
    if scale is None:
        return f"{_fmt(value)}"
    anchor = next((a for a in scale["anchors"] if a["value"] == value), None)
    base = f"{_fmt(value)} out of {_fmt(scale['max'])}"
    if scale["min"] != 0:
        base = f"{_fmt(value)} on a scale from {_fmt(scale['min'])} to {_fmt(scale['max'])}"
    return f"{base}, {anchor['label']}" if anchor else base


def _fmt(value: float) -> str:
    """Integer-aware formatting — a naive `str(10.0)` reads as “10.0 out of 10.0”.

    Same reason `_fmt_code` exists in `missing_values.py`: these strings are read
    aloud and pasted into methods sections.
    """
    if value == int(value):
        return str(int(value))
    return f"{value:g}"
