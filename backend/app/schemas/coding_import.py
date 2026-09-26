"""Wire shapes for the bulk coding import (queue row 49).

⚠️ Every key a service writes must be declared here: under pytest every
`app.schemas` class runs with `extra='forbid'` (#855), so a field the service
emits and this file does not name is a `ValidationError` rather than a silent
drop — which is how `MergeReport.magnitude_conflicts` reached no client for a
release cycle.
"""
from pydantic import BaseModel, ConfigDict, Field

from .auth import MachineProvenance


class CodingImportProblem(BaseModel):
    """One row that was not applied, with the sentence the researcher reads."""

    #: The spreadsheet line, header counted — the number they will look at.
    line: int
    #: A member of `services/coding_import.py::IMPORT_REASONS`, for grouping.
    reason: str
    #: The whole fact. Each reason has a DIFFERENT remedy, so this is never a
    #: template filled from `reason` — it is written per row at the refusal.
    detail: str


class CodingImportCoderCandidate(BaseModel):
    """A coder named in the file, and what this install already has by that name.

    🔴 A CANDIDATE, never a decision. The researcher maps it; there is no silent
    name-match on this path (the `.mmproject` merge's fallback is deliberately
    not copied — a CSV carries a typed string, not a uuid spine).
    """

    name: str
    #: How many rows in the file are theirs — the number that says whether a
    #: mis-mapping matters.
    row_count: int
    local_user_id: int | None = None
    local_coder_type: str | None = None
    local_archived: bool = False
    #: That local coder's existing applications. The merge preview shows the same
    #: figure for the same reason: it is how two same-named coders are told apart.
    local_application_count: int = 0
    #: If the local match is a MACHINE coder, its recorded configuration — so a
    #: researcher can see they are about to add to a layer produced by a
    #: DIFFERENT model or prompt, which would pool two instruments into one.
    local_machine_provenance: dict | None = None


class CodingImportPreviewResponse(BaseModel):
    """What the file resolves to, computed by the SAME planner the import runs.

    #974's rule: a preview computed differently from the act it predicts is a
    preview of something else. `build_plan` has no second implementation.
    """

    target_kind: str
    column_id: int | None = None
    rows_read: int
    #: Rows that WOULD be applied, assuming every coder is mapped.
    will_apply: int
    #: Distinct units and codes the file actually reached. A file that matched
    #: three units of five hundred was built against the wrong key, and these two
    #: numbers are how that is visible before anything is written.
    units_matched: int
    codes_matched: int
    coders: list[CodingImportCoderCandidate]
    problems: list[CodingImportProblem]
    #: `{reason: count}` — the summary, so a long problem list is scannable.
    reason_counts: dict[str, int]


class CodingImportCoderDecision(BaseModel):
    """What to do with one name in the file."""

    model_config = ConfigDict(extra="forbid")

    action: str = Field(..., pattern="^(match|create|skip)$")
    #: `match` — an existing roster coder. A SYSTEM coder is refused at the
    #: service: "Unattributed" and "Consensus" own data and are not people.
    target_user_id: int | None = None
    #: `create` — the name to use; defaults to the file's spelling.
    new_username: str | None = Field(None, max_length=50)
    #: `create` — `human` or `ai`. A machine's codings are attributed and
    #: filterable and never enter a reliability aggregate (#989).
    coder_type: str = Field("human", pattern="^(human|ai)$")
    #: `create` + `ai` — which model, reached how, under what settings (row 49).
    #: Refused on a human rather than ignored: silently dropping it would leave
    #: the researcher believing the configuration was recorded.
    machine_provenance: MachineProvenance | None = None


class CodingImportResult(BaseModel):
    """What the import did. A partial failure is THIS, not a throw (#678)."""

    rows_read: int
    #: New applications written.
    applied: int
    #: Rows whose coder already had that code on that unit. Not an error.
    already_present: int
    #: Rows that went through the code-set swap rather than a plain apply.
    selections: int
    #: Applications a swap CLEARED — the previous value of a set on that unit.
    replaced: int
    ratings_set: int
    coders_matched: int
    coders_created: int
    skipped: int
    #: 🔴 The explicit failed set. Never derived from what succeeded — #678's
    #: rule, where `applied=False` means success on a remove and a skip on an
    #: apply, so a client reconciling on it reads every removal as a failure.
    problems: list[CodingImportProblem]
