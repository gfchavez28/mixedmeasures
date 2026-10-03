"""A machine coder's PROVENANCE — which model, reached how, under what settings
(queue row 49).

#989 gave the machine coder a layer: on the roster, attributed and filterable,
never selectable, never in a reliability aggregate. What it did NOT give it is an
identity. `models/user.py` carried `username · display_color · coder_type ·
archived · last_active_at` and nothing else, so *"GPT-4o"* named a coder and said
nothing about which GPT-4o, reached which way, at what temperature, under which
prompt.

🔴 **THIS IS THE FEATURE, NOT METADATA ON IT.** STRATEGY's five-question purpose
statement makes an imported machine layer a **question-3 (provenance)** capability
rather than a model-evaluation one, and a 2026 scoping review of LLM use in
qualitative research measured the gap it closes: **75% of studies report no model
parameter settings at all and 45% do not say whether the model was reached by API,
web or local deployment**, with human-vs-LLM agreement spanning 36%–99% precisely
because the configuration varies unrecorded (Kempny et al., *BMC Med Res
Methodol*). Rejectionists, reframers and the reporting reviews disagree about
almost everything and agree about this: a record of WHICH machine, under WHAT
configuration, and what a human did about it. No tool implements it.

## Identity, not metadata

🔴 **Two configurations of one model are TWO CODERS.** A prompt rewrite or a
temperature change produces a different interpreter, so folding both under one
roster row would pool two instruments into one layer — the #35 lesson ("Joy 0–100"
and "Anxiety −1…+1" are different instruments and must never share a
coefficient) reached from the coder side.

That is why the provenance is **frozen once the coder holds a coding**. A
researcher who has to change it has to create a second coder, which is the
correct answer rather than a limitation.

⚠️ **The lock is DERIVED, never stored** (`provenance_locked`): *does this coder
hold ≥1 `CodeApplication`?* A stored flag is one more thing that can go stale, and
row 45's freshness pair is the record of how expensive that is to get right —
eight input classes, no enumeration of write sites that closes them.

## The four fields, and each answers a measured reporting gap

- `model` — WHICH machine (the identity the roster name only gestures at).
- `access` — api · web · local · other. The 45% gap; `other` exists so a real
  deployment is never forced into a wrong bucket, which is how a vocabulary
  starts collecting lies.
- `parameters` — temperature, top_p, seed, … The 75% gap. A free dict rather than
  named columns, because decoding parameters differ by vendor and a fixed set
  would be wrong for the next one.
- `prompt` — the instrument itself, the thing a methods section has to quote.

## Strict IN, tolerant OUT

`normalize_provenance` REFUSES a malformed payload (a researcher gets the reason
and fixes it); `read_provenance` returns `None` for a stored blob it cannot parse,
rather than raising. That asymmetry is `parse_managed_spec`'s, for its reason: a
bad value written by some other build must not 500 every roster request, which is
the request the whole app makes on boot.
"""
from __future__ import annotations

import json
import math
from typing import Any

from sqlalchemy.orm import Session

# ── The access vocabulary ────────────────────────────────────────────────────
#
# Mirrored in `frontend/src/lib/machine-coder.ts` and pinned by
# `tests/test_machine_coder_contract.py`, which reads the `.ts`. A value this
# module allows and the client cannot label renders as a bare token on the one
# surface whose job is to say how the model was reached.

ACCESS_API = "api"
ACCESS_WEB = "web"
ACCESS_LOCAL = "local"
ACCESS_OTHER = "other"

#: Ordered — the client renders its picker from this order.
MACHINE_ACCESS_KINDS = (ACCESS_API, ACCESS_WEB, ACCESS_LOCAL, ACCESS_OTHER)

# Caps. Not arbitrary: `model` matches `User.username`'s String(255); the prompt
# is a research instrument and can legitimately be long, so it is bounded well
# above any real one rather than trimmed to a guess; the parameter dict is a
# handful of decoding settings, never a payload.
MAX_MODEL_LENGTH = 255
MAX_PROMPT_LENGTH = 20_000
MAX_PARAMETERS = 50
MAX_PARAMETER_KEY_LENGTH = 64
MAX_PARAMETER_VALUE_LENGTH = 500


class MachineCoderError(ValueError):
    """A refused provenance declaration. The router renders ``str(exc)`` (#871)."""


def _clean_text(value: Any, field: str, *, cap: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise MachineCoderError(f"{field} must be text.")
    text = value.strip()
    if not text:
        return None
    if len(text) > cap:
        raise MachineCoderError(
            f"{field} is longer than {cap:,} characters."
        )
    return text


def _clean_parameters(value: Any) -> dict[str, str] | None:
    """Decoding settings as `{name: printable value}`.

    🔴 **Every value is stored as TEXT, deliberately.** `temperature: 0` and
    `temperature: "0"` must not become two different records of one setting, and
    a methods section quotes what was set rather than a re-formatted float. The
    coercion happens once, here, so no consumer has to decide how to print one.

    ⚠️ `False` is a legal value and `0` is a legal value — the falsy-zero class
    (#35 §2, `magnitude`'s whole reason). Emptiness is decided on the STRING
    after coercion, never on the value's truthiness.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise MachineCoderError("Parameters must be a set of name/value pairs.")
    if len(value) > MAX_PARAMETERS:
        raise MachineCoderError(
            f"A machine coder carries at most {MAX_PARAMETERS} parameters."
        )
    out: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        if not isinstance(raw_key, str):
            raise MachineCoderError("Every parameter needs a name.")
        key = raw_key.strip()
        if not key:
            continue
        if len(key) > MAX_PARAMETER_KEY_LENGTH:
            raise MachineCoderError(
                f"Parameter name “{key[:20]}…” is longer than "
                f"{MAX_PARAMETER_KEY_LENGTH} characters."
            )
        if isinstance(raw_value, bool):
            text = "true" if raw_value else "false"
        elif isinstance(raw_value, (int, float)):
            # A bare `Infinity`/`NaN` is accepted by Python's json (the #625
            # door, verified by execution) and is not JSON-compliant on the way
            # back out — it would 500 the response that renders the roster.
            if not math.isfinite(raw_value):
                raise MachineCoderError(
                    f"Parameter “{key}” is not a finite number."
                )
            text = f"{raw_value:g}" if isinstance(raw_value, float) else str(raw_value)
        elif isinstance(raw_value, str):
            text = raw_value.strip()
        elif raw_value is None:
            continue
        else:
            raise MachineCoderError(
                f"Parameter “{key}” must be text, a number or true/false."
            )
        if not text:
            continue
        if len(text) > MAX_PARAMETER_VALUE_LENGTH:
            raise MachineCoderError(
                f"Parameter “{key}” is longer than "
                f"{MAX_PARAMETER_VALUE_LENGTH} characters."
            )
        out[key] = text
    return out or None


def normalize_provenance(payload: dict | None) -> dict | None:
    """Validate a provenance declaration, or raise `MachineCoderError`.

    Returns the canonical dict (only the keys that carry something), or `None`
    when nothing was declared — an undeclared provenance is honest and common,
    and refusing it would make a machine coder uncreatable until the researcher
    has their prompt to hand.

    🔴 **`model` is required as soon as ANYTHING is declared.** A temperature
    with no model names a setting of nothing, and the whole point of the record
    is which machine it describes.
    """
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise MachineCoderError("Provenance must be a set of fields.")

    model = _clean_text(payload.get("model"), "Model", cap=MAX_MODEL_LENGTH)
    prompt = _clean_text(payload.get("prompt"), "Prompt", cap=MAX_PROMPT_LENGTH)
    parameters = _clean_parameters(payload.get("parameters"))

    access_raw = payload.get("access")
    access: str | None = None
    if access_raw is not None:
        if not isinstance(access_raw, str) or access_raw not in MACHINE_ACCESS_KINDS:
            raise MachineCoderError(
                "How the model was reached must be one of: "
                + ", ".join(MACHINE_ACCESS_KINDS)
                + "."
            )
        access = access_raw

    if model is None and (access or prompt or parameters):
        raise MachineCoderError(
            "Name the model this describes — a setting with no model recorded "
            "against it says nothing about how the coding was produced."
        )
    if model is None:
        return None

    out: dict[str, Any] = {"model": model}
    if access is not None:
        out["access"] = access
    if prompt is not None:
        out["prompt"] = prompt
    if parameters is not None:
        out["parameters"] = parameters
    return out


def write_provenance(user: Any, provenance: dict | None) -> None:
    """Store a normalized provenance on a `User`. The ONE writer of the column."""
    user.machine_provenance = json.dumps(provenance) if provenance else None


def read_provenance(user: Any) -> dict | None:
    """The stored provenance, or `None` — tolerant, never raising.

    `parse_managed_spec`'s shape and its reason: a blob written by another build,
    or hand-edited, must read as "not declared" rather than raising inside
    `GET /auth/coders`, which every page loads.
    """
    return parse_stored_provenance(getattr(user, "machine_provenance", None))


def parse_stored_provenance(raw: Any) -> dict | None:
    """The column's stored form → the provenance dict, or `None`. `read_provenance`
    for a value that is not on a `User` — a coder entry in a `.mmproject`, which
    carries the column verbatim (#1034). ONE parser for both, so a file's coder and
    a local one are read the same way before they are compared."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("model"), str):
        return None
    return parsed


def same_configuration(a: dict | None, b: dict | None) -> bool:
    """Are these ONE machine configuration — the identity of a machine coder (#1034)?

    🔴 **Two configurations of one model are two coders**, so this decides whether a
    file's machine may land on a local one. Both sides are what `normalize_provenance`
    wrote (values are TEXT, empty fields absent), so dict equality is the comparison;
    key order is irrelevant to it.

    ⚠️ **Two UNRECORDED configurations are the same** — both `None`. The alternative
    duplicates a machine coder on every round trip of a project whose model was never
    documented (an overwrite, a coding copy, the colleague's merge of your own file),
    which is the common case today. A recorded configuration and an unrecorded one are
    NOT the same: nothing says the unrecorded one was that configuration.
    """
    return a == b


def locked_coder_ids(db: Session, user_ids: list[int]) -> set[int]:
    """Which of these coders already hold a coding — ONE query, never N.

    🔴 **DERIVED, never a stored flag.** Once a machine layer holds codings, its
    configuration IS the identity of that layer, and changing it afterwards would
    silently re-label work a different configuration produced. A researcher who
    needs a different configuration creates a second coder, which is what "two
    configurations of one model are two coders" means in practice.

    ⚠️ Batched because `GET /auth/coders` is on every page's critical path and a
    per-coder existence check would be one query per roster row. Bounded by the
    ROSTER, which is coders and never respondents, so a plain `.in_()` is safe
    here — the #842 ceiling is about collections that grow with the data.
    """
    from ..models.code_application import CodeApplication

    if not user_ids:
        return set()
    return {
        uid
        for (uid,) in db.query(CodeApplication.user_id)
        .filter(CodeApplication.user_id.in_(user_ids))
        .distinct()
        .all()
        if uid is not None
    }


def provenance_locked(db: Session, user_id: int) -> bool:
    """Has this ONE coder produced any coding yet? (`locked_coder_ids` for a list.)"""
    return user_id in locked_coder_ids(db, [user_id])


def describe_provenance(provenance: dict | None) -> str:
    """One line naming the configuration — for a picker, a chip, a merge preview.

    ⚠️ Deliberately NOT the prompt: a prompt is paragraphs and this has to fit
    beside a coder's name. The surfaces that show the prompt show it in full.
    """
    if not provenance:
        return "Configuration not recorded"
    parts = [provenance["model"]]
    access = provenance.get("access")
    if access:
        parts.append(f"via {access}")
    params = provenance.get("parameters") or {}
    if params:
        parts.append(", ".join(f"{k} {v}" for k, v in sorted(params.items())))
    return " · ".join(parts)
