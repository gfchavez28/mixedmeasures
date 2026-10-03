"""Bulk import of code applications (queue row 49).

Two endpoints over ONE planner: `/import/preview` shows what the file resolves
to, `/import` applies it with the researcher's coder mapping. The plan is built
by the same function both times (#974's rule — a preview computed differently
from the act it predicts is a preview of something else), and the only thing the
second call adds is who each name in the file belongs to.

🔴 **WRITING ROWS ATTRIBUTED TO A CODER OTHER THAN THE CALLER IS A NEW
CAPABILITY, so the ownership gate is applied deliberately** — the boundary
`import-project` needed for `merge`/`overwrite`. Under `MM_MULTIUSER_AUTH_ENABLED`
a holder of somebody else's project id could otherwise write coding into it.

⚠️ **`async def` for the multipart read and NOTHING else.** The body awaits only
`read_upload_with_limit`; the planner and the writer are synchronous and take a
`Session`, so they cannot go to a threadpool — the same constraint
`import_dataset_csv` carries, and the reason `MAX_CODING_IMPORT_ROWS` is a hard
cap rather than a suggestion.

🔴 **SO THE CAP IS A BUDGET ON HOW LONG THE SERVER ANSWERS NOTHING, AND IT IS
MEASURED (2026-09-22, #1000): a FULL-CAP import — 200,000 codings, a 4.7 MB file,
200,000 segments in the corpus — is parse 0.74 s · plan 3.48 s · apply 2.72 s =
6.9 s.** That whole time runs ON the event loop, including Electron's `/health`
probe, which is #837's class. It is the same family as `import_dataset_csv`'s
accepted freeze and materially smaller than the 207.95 s #837 measured before the
exports were converted — but it is a real freeze, it is filed, and **anyone
raising `MAX_CODING_IMPORT_ROWS` is raising that number with it.** ⚠️ Peak RSS in
that run was 482 MB, in a process that also BUILT the corpus, so it is an upper
bound on the import's own cost and is deliberately not attributed
(`ru_maxrss` cannot tell HELD from ONCE-ALLOCATED).

🔴 **THAT FILE HAD NO CODE-SET VALUES, AND ONE THAT HAS THEM FROZE FOR ~53 s** (#1062,
found 2026-09-27d by timing HEAD on a heavier shape: 20,000 segment groups, three
fifths of the rows set values). Since Batch 6 the heavy shape is **9.2–9.4 s at
314 MB peak** (a separate process, `/usr/bin/time`), against HEAD's 52.5–55.1 s at
316 MB. Harness: the internal design notes (git-ignored).
"""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..schemas.coding_import import (
    CodingImportCoderCandidate,
    CodingImportCoderDecision,
    CodingImportPreviewResponse,
    CodingImportProblem,
    CodingImportResult,
)
from ..services import coding_import
from ..services.audit import log_action
from .helpers import _get_project_or_404, read_upload_with_limit

router = APIRouter(
    prefix="/api/projects/{project_id}/code-applications",
    tags=["coding-import"],
)


def _problem(p: coding_import.RowProblem) -> CodingImportProblem:
    return CodingImportProblem(line=p.line, reason=p.reason, detail=p.detail)


def _candidate(c: coding_import.CoderCandidate) -> CodingImportCoderCandidate:
    return CodingImportCoderCandidate(
        name=c.name,
        row_count=c.row_count,
        rows_to_apply=c.rows_to_apply,
        local_user_id=c.local_user_id,
        local_coder_type=c.local_coder_type,
        local_archived=c.local_archived,
        local_application_count=c.local_application_count,
        local_machine_provenance=c.local_machine_provenance,
    )


async def _plan_from_upload(
    db: Session,
    project_id: int,
    file: UploadFile,
    target_kind: str,
    column_id: int | None,
    match_column_id: int | None,
) -> coding_import.ImportPlan:
    """Read → parse → plan. The ONE path both endpoints take."""
    raw = await read_upload_with_limit(file)
    try:
        rows = coding_import.parse_rows(coding_import.decode_csv(raw))
        return coding_import.build_plan(
            db, project_id, rows,
            target_kind=target_kind,
            column_id=column_id,
            match_column_id=match_column_id,
        )
    except coding_import.CodingImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/import/preview", response_model=CodingImportPreviewResponse)
async def preview_coding_import(
    project_id: int,
    file: UploadFile = File(...),
    target_kind: str = Form(...),
    column_id: int | None = Form(None),
    match_column_id: int | None = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What would this file do? Read-only.

    ⚠️ **It writes nothing, including no coders.** A `create` decision mints a
    roster coder, and doing that during a preview would leave one behind every
    time a researcher looked at a file and changed their mind.
    """
    _get_project_or_404(db, project_id, user.id)
    plan = await _plan_from_upload(
        db, project_id, file, target_kind, column_id, match_column_id,
    )
    return CodingImportPreviewResponse(
        target_kind=plan.target_kind,
        column_id=plan.column_id,
        rows_read=plan.rows_read,
        will_apply=len(plan.applications),
        units_in_file=plan.units_in_file,
        units_matched=plan.units_matched,
        codes_in_file=plan.codes_in_file,
        codes_matched=plan.codes_matched,
        grouped_passages=plan.grouped_passages,
        coders=[_candidate(c) for c in plan.coders],
        problems=[_problem(p) for p in plan.problems],
        reason_counts=plan.reason_counts,
    )


@router.post("/import", response_model=CodingImportResult)
async def import_coding(
    project_id: int,
    file: UploadFile = File(...),
    target_kind: str = Form(...),
    column_id: int | None = Form(None),
    match_column_id: int | None = Form(None),
    coder_mapping: str = Form(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply the file.

    🔴 **`coder_mapping` is REQUIRED and every name in the file must appear in
    it.** The `.mmproject` merge falls back to a silent name-match when a decision
    is absent; this path does not, and that is the one deliberate divergence. A
    merge at least matches a uuid spine — a CSV carries a string somebody typed,
    so a name that merely LOOKS like a colleague's is exactly the silent
    misattribution J3-2's confirm screen exists to prevent.

    ⚠️ **A partial failure is this 200 body, never a throw** (#678). `problems`
    is the explicit failed set; it is never derived from what succeeded.
    """
    _get_project_or_404(db, project_id, user.id)

    try:
        raw_mapping = json.loads(coder_mapping) if coder_mapping else {}
    except ValueError:
        raise HTTPException(status_code=400, detail="The coder mapping is not valid JSON.")
    if not isinstance(raw_mapping, dict):
        raise HTTPException(
            status_code=400,
            detail="The coder mapping must be an object keyed by the name in the file.",
        )

    decisions: dict[str, coding_import.CoderDecision] = {}
    for name, entry in raw_mapping.items():
        try:
            parsed = CodingImportCoderDecision.model_validate(entry)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"The decision for “{name}” is not usable: {exc}",
            )
        decisions[name] = coding_import.CoderDecision(
            action=parsed.action,
            target_user_id=parsed.target_user_id,
            new_username=parsed.new_username,
            coder_type=parsed.coder_type,
            machine_provenance=(
                parsed.machine_provenance.as_payload()
                if parsed.machine_provenance is not None else None
            ),
            unarchive=parsed.unarchive,
        )

    plan = await _plan_from_upload(
        db, project_id, file, target_kind, column_id, match_column_id,
    )

    try:
        report = coding_import.apply_plan(db, project_id, plan, decisions)
    except coding_import.CodingImportError as exc:
        # Nothing has been committed, so a refusal here leaves the project
        # exactly as it was — including any coder the resolve pass had begun to
        # create, which is why the rollback is explicit rather than implied.
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))

    log_action(
        db,
        action="coding_imported",
        entity_type="code_application",
        user_id=user.id,
        project_id=project_id,
        details={
            "target_kind": plan.target_kind,
            "column_id": plan.column_id,
            "rows_read": report.rows_read,
            "applied": report.applied,
            "selections": report.selections,
            "skipped": report.skipped,
            "coders_created": report.coders_created,
            # Who was brought back from the archive, by id — a change to who
            # votes in consensus and whose codings show, so it is on the record.
            "unarchived_coder_ids": report.unarchived_coder_ids,
        },
    )
    db.commit()

    return CodingImportResult(
        rows_read=report.rows_read,
        applied=report.applied,
        already_present=report.already_present,
        selections=report.selections,
        replaced=report.replaced,
        ratings_set=report.ratings_set,
        coders_matched=report.coders_matched,
        coders_created=report.coders_created,
        coders_unarchived=report.coders_unarchived,
        skipped=report.skipped,
        problems=[_problem(p) for p in report.problems],
        reason_counts=coding_import.reason_counts(report.problems),
    )
