"""The joint display's live numbers (ROADMAP row 56; `services/joint_display.py`) and the reads
its pinned quotes are chosen from and attributed by (`services/joint_display_pins.py`)."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.dataset import DatasetColumn
from ..models.user import User
from ..schemas.joint_display import (
    JointDisplayCasesRequest,
    JointDisplayCasesResponse,
    JointDisplayComputeRequest,
    JointDisplayComputeResponse,
    JointDisplayPassagesRequest,
    JointDisplayPassagesResponse,
    JointDisplayPinFactsRequest,
    JointDisplayPinFactsResponse,
)
from ..services.code_analysis import GroupingColumnError
from ..services.joint_display import (
    GROUPING_GONE,
    IMPLICIT_CODES_KEY,
    IMPLICIT_VARIABLES_KEY,
    STRAND_KIND_CODES,
    STRAND_KIND_VARIABLES,
    BindingRequest,
    RowRequest,
    StrandRequest,
    compute_joint_display,
)
from ..services.joint_display_cases import CaseBinding, read_cases
from ..services.joint_display_pins import (
    attribution_column_unusable,
    attribution_column_withheld,
    group_passages,
    pin_facts,
)
from .helpers import _get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}/joint-display", tags=["joint-display"])


def _strand_requests(strands) -> list[StrandRequest]:
    """The request's strands as the services read them — ONE translation, used by the
    compute and the case read (joint display slice 2, r1-1; R10)."""
    return [
        StrandRequest(
            key=s.key, kind=s.kind,
            conversation_ids=None if s.conversation_ids is None else tuple(s.conversation_ids),
            document_ids=None if s.document_ids is None else tuple(s.document_ids),
            observation_ids=None if s.observation_ids is None else tuple(s.observation_ids),
            text_column_ids=None if s.text_column_ids is None else tuple(s.text_column_ids),
            dataset_id=s.dataset_id,
        )
        for s in strands
    ]


@router.post("/compute", response_model=JointDisplayComputeResponse)
def compute(  # def, not async: the comparison's gather — test_endpoint_event_loop.py::MUST_BE_SYNC
    project_id: int,
    body: JointDisplayComputeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Each row's code and survey strands per group, live (D165–D172). Reads only."""
    _get_project_or_404(db, project_id, user.id)
    try:
        return compute_joint_display(
            db, project_id,
            group_by_column_id=body.group_by_column_id,
            rows=[
                RowRequest(
                    key=r.key,
                    code_ids=tuple(r.code_ids),
                    column_ids=tuple(r.column_ids),
                    codes_marked_formed=r.codes_marked_formed,
                    variables_marked_formed=r.variables_marked_formed,
                    bindings=None if r.bindings is None else {
                        k: BindingRequest(code_ids=tuple(b.code_ids),
                                          column_ids=tuple(b.column_ids),
                                          marked_formed=b.marked_formed)
                        for k, b in r.bindings.items()},
                )
                for r in body.rows
            ],
            # Joint display slice 2 (r1-1): the strands, or None for slice 1's implicit pair.
            strands=None if body.strands is None else _strand_requests(body.strands),
            conversation_ids=body.conversation_ids,
            document_ids=body.document_ids,
            coder_ids=body.coder_ids,
            layer_scope=body.layer_scope,
            newcombe=body.newcombe,
        )
    except GroupingColumnError as exc:
        # #1639 (r1-5): a 404 here is the grouping variable gone (deleted, or a D202 import's
        # id) — said by the display in its own words, keyed on this code, never on the text.
        raise _grouping_refusal(exc)


def _grouping_refusal(exc: GroupingColumnError) -> HTTPException:
    """The grouping variable's refusal, for every read that groups by it (#1653, D347).

    A 404 is the variable gone, sent as `{"code": GROUPING_GONE, …}` so the display says it in
    its own sentence on every surface (D324 gave the compute that; the pin picker's passages and
    the case view's cases were the plain text). ⚠️ Only for a read whose column IS the grouping
    variable: `pin-facts`' column is the attribution variable, and is said apart (D346).
    """
    if exc.status_code == 404:
        return HTTPException(status_code=404, detail={"code": GROUPING_GONE, "message": str(exc)})
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.post("/passages", response_model=JointDisplayPassagesResponse)
def passages(  # def, not async: the group map reads every cell of a column — MUST_BE_SYNC
    project_id: int,
    body: JointDisplayPassagesRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One group's passages coded with one code — a pin's suggestions (D209). Reads only."""
    _get_project_or_404(db, project_id, user.id)
    try:
        result = group_passages(
            db, project_id,
            group_by_column_id=body.group_by_column_id,
            group=body.group,
            code_id=body.code_id,
            conversation_ids=body.conversation_ids,
            document_ids=body.document_ids,
            coder_ids=body.coder_ids,
            layer_scope=body.layer_scope,
            chips_follow_coder_ids=body.chips_follow_coder_ids,
            limit=body.limit,
            offset=body.offset,
            text_column_ids=body.text_column_ids,  # joint display slice 2, r4-1 (the pin's strand)
        )
    except GroupingColumnError as exc:
        raise _grouping_refusal(exc)  # #1653 (D347)
    if result is None:
        raise HTTPException(status_code=404, detail="Code not found in this project")
    return result


@router.post("/pin-facts", response_model=JointDisplayPinFactsResponse)
def pin_attribution_facts(  # def, not async: a column's group map — MUST_BE_SYNC
    project_id: int,
    body: JointDisplayPinFactsRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What each pinned quote's attribution is derived from, read live (D210). Reads only."""
    _get_project_or_404(db, project_id, user.id)
    try:
        # #1615: a rating-derived attribution column's value is left out while blind, and said
        # — with the column's name for the display's note (D286). A withheld id is by
        # construction one of THIS project's participant-table columns
        # (`withheld_rating_columns_in_project`), so the name read needs no second gate.
        withheld = attribution_column_withheld(db, project_id, body.column_id, body.coder_ids)
        column = db.get(DatasetColumn, body.column_id) if withheld else None
        # #1653 (D346): a gone or retyped attribution column leaves only its VALUE out — every
        # pin keeps who said it and where — and the answer says why (a 404 lost them all).
        unusable, unusable_name = attribution_column_unusable(
            db, project_id, body.column_id, body.coder_ids)
        return {"pins": pin_facts(db, project_id, excerpt_ids=body.excerpt_ids,
                                  column_id=body.column_id, coder_ids=body.coder_ids),
                "column_withheld": withheld,
                "column_name": (column.column_name or column.column_text) if column else unusable_name,
                "column_unusable": unusable}
    except GroupingColumnError as exc:
        # Not the grouping variable (D347's ⚠️): only a refusal D346 does not decide reaches here.
        raise HTTPException(status_code=exc.status_code, detail=str(exc))


@router.post("/cases", response_model=JointDisplayCasesResponse)
def case_rows(  # def, not async: the compute's gather, per code strand — MUST_BE_SYNC
    project_id: int,
    body: JointDisplayCasesRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One row of a display per case, and which cases its stated rule selects (joint
    display slice 2, D173; `services/joint_display_cases.py`). Reads only."""
    _get_project_or_404(db, project_id, user.id)
    if body.strands is None:  # slice 1's implicit pair (r1-2), as the compute reads it
        strands = [StrandRequest(
            IMPLICIT_CODES_KEY, STRAND_KIND_CODES,
            conversation_ids=None if body.conversation_ids is None else tuple(body.conversation_ids),
            document_ids=None if body.document_ids is None else tuple(body.document_ids)),
            StrandRequest(IMPLICIT_VARIABLES_KEY, STRAND_KIND_VARIABLES)]
    else:
        strands = _strand_requests(body.strands)
    try:
        return read_cases(
            db, project_id,
            group_by_column_id=body.group_by_column_id,
            strands=strands,
            bindings={k: CaseBinding(tuple(b.code_ids), tuple(b.column_ids))
                      for k, b in body.bindings.items()},
            coder_ids=body.coder_ids,
            layer_scope=body.layer_scope,
            rule=[c.model_dump() for c in body.rule.conditions] if body.rule else None,
            only=body.only,
            added_participant_ids=body.added_participant_ids,
            removed_participant_ids=body.removed_participant_ids,
            offset=body.offset,
            limit=body.limit,
        )
    except GroupingColumnError as exc:
        raise _grouping_refusal(exc)  # #1653 (D347)
