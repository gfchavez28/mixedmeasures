"""Every field a response schema declares is MENTIONED by client source — the detector for
#855's original twelve ("built but never consumed", the half-landed wire).

**The class.** `treat_as_empty` was fully built on the backend, declared on the client's
wire type, and reachable from no UI (#816); `scale_values`, `missing_values`,
`observation_count` and nine more each shipped with backend tests and a client that never
read them. Every one was found by a person noticing. The twelve cross-language contract
tests pin VOCABULARY where a consumer already exists; none can see a field with ZERO
consumers, which is the entire class.

**The probe, and why it is enough to start with.** Wire field names are shared verbatim
across the boundary (snake_case on both sides — `observation_count`, `speaker_color`), so
"does any client source contain this identifier?" is answerable with a token set. MEASURED
2026-09-04 over 270 response-shaped classes / **745 distinct field names**: **5** were
mentioned nowhere in `frontend/src`, and every one was explicable (below). That is a
population small enough to gate with an exemption table, and a new field nobody reads fails
the suite until its author either reads it or writes down why not — the failing signal the
class never had.

⚠️ **What this CANNOT see, stated so nobody reads more into a green run.** It is a NAME
reachability check. A generic name (`id`, `name`, `count`, `label`) passes on coincidence
wherever it appears, so an unconsumed field with a common name is invisible here — and so is
a whole ENDPOINT with no client caller whose fields all have common names (#882 is that
residue: four endpoints had no live client caller, and only their distinctively-named fields
showed up here). It catches the distinctive names, which every one of the twelve had.

**#882 was decided 2026-09-06**: `row-scores` and the dataset rows summary were DELETED
(routes + schemas + their exemptions here); the code-equivalence CRUD is kept as substrate
and the conversation `coding-progress` was already kept by design, so both keep an exemption.

⚠️ **"Response-shaped" is a NAME heuristic** (the suffix list below), because nothing in the
code marks a schema as a response versus a request. The population self-check asserts the
heuristic still admits the classes the class was found on.

⚠️ **The frontend tree must be PRESENT, and its absence FAILS rather than skips** (#642: a skip
reports green). Both repositories carry `frontend/src`; a checkout without it is a broken
checkout for this test's purposes.
"""
from __future__ import annotations

import importlib
import pkgutil
import re
from pathlib import Path

import pytest
from pydantic import BaseModel

BACKEND = Path(__file__).resolve().parents[1]
FRONTEND_SRC = BACKEND.parent / "frontend" / "src"

#: Suffixes that mark a schema as something the server SENDS. Request shapes end in
#: Create / Update / Request / Config / Input and are the client's to write, not to read.
RESPONSE_SUFFIX = re.compile(
    r"(Response|Result|Summary|Report|Info|Item|Row|Detail|Preview|Status|Manifest|Group|Segment|Entry|Context)$"
)

#: Fields the client is KNOWN not to read, each with the reason. An entry is a claim about
#: the world (feedback_exemption_is_a_hypothesis): the stale check below fails the moment a
#: client source starts mentioning the name, or the field stops existing.
EXEMPT: dict[str, str] = {
    # `GET /conversations/{id}/coding-progress` has had NO frontend caller since J1-3c and
    # is KEPT deliberately (`lib/api/coding.ts` says so; `test_coding_counts.py::
    # TestNextUncodedEndpointIsGone` pins the keeping). Its distinctive names surface here;
    # its common ones (`total_segments`, `coded_segments`) pass on coincidence — see #882.
    "participant_segments": "conversation coding-progress endpoint — caller-less by design (J1-3c)",
    "progress_percent": "conversation coding-progress endpoint — caller-less by design (J1-3c)",
    # The code-equivalence group CRUD (`routers/code_equivalence.py`) has no client module;
    # groups are created server-side by the merge reconcile's `link` action. → #882.
    # KEPT as substrate on the 2026-09-06 decision, like the multi-user auth endpoints
    # behind `MM_MULTIUSER_AUTH_ENABLED`.
    "canonical_code_id": "code-equivalence CRUD — no client module, kept as substrate (#882)",
    # `metric_name` (row-scores) and `value_count` (the dataset rows summary) were exempt
    # here until 2026-09-06, when #882 was decided and BOTH ENDPOINTS WERE DELETED along
    # with their schemas. ⚠️ Deleting a route is only half of it: `test_exemptions_are_not_stale`
    # fails on an exemption whose field no response schema declares any more, so the schema
    # and the entry have to go in the same commit as the route.
}

# Population floors. Well below the 2026-09-04 measurement (270 classes, 745 fields, 461
# client files) so ordinary change never trips them, while a walk that rots to nothing does.
MIN_CLASSES, MIN_FIELDS, MIN_CLIENT_FILES = 150, 500, 300

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _response_classes() -> set[type[BaseModel]]:
    import app.schemas as pkg

    out: set[type[BaseModel]] = set()
    for info in pkgutil.walk_packages(pkg.__path__, pkg.__name__ + "."):
        module = importlib.import_module(info.name)
        for obj in vars(module).values():
            if (
                isinstance(obj, type)
                and issubclass(obj, BaseModel)
                and obj is not BaseModel
                and obj.__module__.startswith("app.schemas")
                and RESPONSE_SUFFIX.search(obj.__name__)
            ):
                out.add(obj)
    return out


def _fields_by_name(classes: set[type[BaseModel]]) -> dict[str, set[str]]:
    fields: dict[str, set[str]] = {}
    for cls in classes:
        for name in cls.model_fields:
            fields.setdefault(name, set()).add(cls.__name__)
    return fields


def _client_identifiers() -> tuple[set[str], int]:
    """Every identifier token in non-test client source, plus the file count."""
    assert FRONTEND_SRC.is_dir(), (
        f"{FRONTEND_SRC} is missing — this test cannot skip (a skip reports green, #642); "
        "run it from a full checkout."
    )
    tokens: set[str] = set()
    n = 0
    for path in FRONTEND_SRC.rglob("*.ts*"):
        if ".test." in path.name or path.suffix not in (".ts", ".tsx"):
            continue
        n += 1
        tokens.update(IDENT.findall(path.read_text(encoding="utf-8", errors="replace")))
    return tokens, n


@pytest.fixture(scope="module")
def population():
    classes = _response_classes()
    fields = _fields_by_name(classes)
    tokens, n_files = _client_identifiers()
    return classes, fields, tokens, n_files


def test_the_probe_sees_a_real_population(population):
    """POPULATION (#730), per narrowing: the class heuristic, the field set, the client walk."""
    classes, fields, tokens, n_files = population
    assert len(classes) >= MIN_CLASSES, len(classes)
    assert len(fields) >= MIN_FIELDS, len(fields)
    assert n_files >= MIN_CLIENT_FILES, n_files
    names = {c.__name__ for c in classes}
    # The classes the class was found on must be admitted by the suffix heuristic.
    for headliner in ("MergeReport", "ProjectSummary", "DatasetDataColumnResponse",
                      "CodedSegmentWithContext", "TextCodingConfigResponse"):
        assert headliner in names, f"the response-shape heuristic no longer admits {headliner}"
    # …and the fields those instances were about are read by the client today.
    for read_today in ("observation_count", "magnitude_conflicts", "treat_as_empty", "scale_values"):
        assert read_today in tokens, read_today


def test_the_detector_fires_on_an_unread_name(population):
    """PREDICATE falsifier: a name no client source could contain is reported."""
    _, _, tokens, _ = population
    assert "a_field_no_client_source_mentions_zzz" not in tokens
    assert "observation_count" in tokens


def test_every_response_field_is_read_by_the_client_or_excused(population):
    _, fields, tokens, _ = population
    unread = {
        name: sorted(classes)
        for name, classes in fields.items()
        if name not in tokens and name not in EXEMPT
    }
    assert not unread, (
        "These response-schema fields are mentioned by NO client source — the server builds "
        "them and nothing reads them (#855's class, the half-landed wire):\n  "
        + "\n  ".join(f"{name}  ({', '.join(cls)})" for name, cls in sorted(unread.items()))
        + "\n\nEither wire the consumer, or add the name to EXEMPT with the reason nothing "
        "should read it (an endpoint kept without a client caller, an export-only field)."
    )


def test_exemptions_are_not_stale(population):
    """UNEXPECTED direction: an exemption for a name the client now reads, or for a field
    that no longer exists, is a blind spot with a reason attached."""
    _, fields, tokens, _ = population
    now_read = sorted(n for n in EXEMPT if n in tokens)
    assert not now_read, f"EXEMPT excuses fields the client now mentions — drop them: {now_read}"
    gone = sorted(n for n in EXEMPT if n not in fields)
    assert not gone, f"EXEMPT excuses fields no response schema declares any more — drop them: {gone}"
