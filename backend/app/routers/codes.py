from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload, contains_eager
from sqlalchemy import func, nulls_last

from sqlalchemy.exc import IntegrityError
from ..database import get_db
from ..models.user import User
from ..models.code import Code
from ..models.code_category import CodeCategory
from ..models.code_application import CodeApplication
from ..models.segment import Segment
from ..schemas.code import (
    CodeCreate,
    CodeUpdate,
    CodeResponse,
    CodeListResponse,
    CodeCategoryCreate,
    CodeCategoryUpdate,
    CodeCategoryResponse,
    CodeCategoryWithCodesResponse,
    CategoryReorderRequest,
    CodeReorderInCategoryRequest,
    BulkMoveRequest,
    BulkMoveResponse,
    MergeCodesResponse,
    CategoryMergeRequest,
    CategoryMergeResponse,
    CategoryBulkMoveRequest,
    CategoryBulkMoveResponse,
    GroupIntoCategoryRequest,
)
from ..models.memo import Memo
from ..auth import get_current_user
from ..services.audit import log_action
from .helpers import _get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}/codes", tags=["codes"])


def code_to_response(code: Code, db: Session, usage_count: int | None = None) -> CodeResponse:
    """Convert Code model to response."""
    if usage_count is None:
        usage_count = db.query(func.count(CodeApplication.id)).filter(
            CodeApplication.code_id == code.id
        ).scalar() or 0

    return CodeResponse(
        id=code.id,
        project_id=code.project_id,
        numeric_id=code.numeric_id,
        name=code.name,
        description=code.description,
        color=code.color,
        is_universal=code.is_universal,
        is_active=code.is_active,
        created_at=code.created_at,
        updated_at=code.updated_at,
        usage_count=usage_count,
        category_id=code.category_id,
        category_name=code.category.name if code.category else None,
        category_color=code.category.color if code.category else None,
        category_order=code.category_order,
    )


@router.get("", response_model=CodeListResponse)
async def list_codes(
    project_id: int,
    include_inactive: bool = Query(False),
    category_id: int | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all codes in a project, ordered by: universal first, then categorized (by category display_order, then category_order), then uncategorized (by numeric_id)."""
    _get_project_or_404(db, project_id, user.id)

    query = db.query(Code).outerjoin(
        Code.category
    ).options(
        contains_eager(Code.category),
    ).filter(Code.project_id == project_id)

    if not include_inactive:
        query = query.filter(Code.is_active == True)

    if category_id:
        query = query.filter(Code.category_id == category_id)

    # Order: universal first (by numeric_id), then categorized (by category.display_order, then category_order), then uncategorized (by numeric_id)
    query = query.order_by(
        # Universal codes first (is_universal DESC so True=1 comes first)
        Code.is_universal.desc(),
        # Then by category display_order (NULL last = uncategorized at end)
        nulls_last(CodeCategory.display_order),
        # Within category, by category_order
        nulls_last(Code.category_order),
        # Final tiebreak by numeric_id
        Code.numeric_id,
    )

    codes = query.all()

    if not codes:
        return CodeListResponse(codes=[], total=0)

    # B2: Batch count usage instead of N+1
    code_ids = [c.id for c in codes]
    usage_counts = dict(
        db.query(CodeApplication.code_id, func.count(CodeApplication.id))
        .filter(CodeApplication.code_id.in_(code_ids))
        .group_by(CodeApplication.code_id)
        .all()
    )

    result = [
        code_to_response(code, db, usage_count=usage_counts.get(code.id, 0))
        for code in codes
    ]

    return CodeListResponse(codes=result, total=len(codes))


@router.post("", response_model=CodeResponse)
async def create_code(
    project_id: int,
    data: CodeCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new code."""
    _get_project_or_404(db, project_id, user.id)

    # Validate category if provided
    if data.category_id is not None:
        cat = db.query(CodeCategory).filter(
            CodeCategory.id == data.category_id,
            CodeCategory.project_id == project_id,
        ).first()
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")

    # B3: Retry on IntegrityError (race condition on numeric_id unique constraint)
    for attempt in range(3):
        try:
            # Get next numeric ID (skip 0 and 1 which are reserved for universal codes)
            max_numeric = db.query(func.max(Code.numeric_id)).filter(
                Code.project_id == project_id
            ).scalar() or 1

            next_numeric = max(max_numeric + 1, 2)

            # Auto-assign category_order
            category_order = None
            if data.category_id is not None:
                max_order = db.query(func.max(Code.category_order)).filter(
                    Code.project_id == project_id,
                    Code.category_id == data.category_id,
                ).scalar()
                category_order = (max_order or 0) + 1 if max_order is not None else 0

            code = Code(
                project_id=project_id,
                numeric_id=next_numeric,
                name=data.name,
                description=data.description,
                color=data.color,
                category_id=data.category_id,
                category_order=category_order,
            )
            db.add(code)
            db.flush()

            log_action(
                db,
                action="created",
                entity_type="code",
                entity_id=code.id,
                user_id=user.id,
                project_id=project_id,
                details={"name": code.name, "numeric_id": code.numeric_id}
            )
            db.commit()

            return code_to_response(code, db)
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise HTTPException(
                    status_code=409,
                    detail="Failed to assign unique code number after retries"
                )
            continue


@router.get("/{code_id}", response_model=CodeResponse)
async def get_code(
    project_id: int,
    code_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a code by ID."""
    code = db.query(Code).options(
        joinedload(Code.category),
    ).filter(
        Code.id == code_id,
        Code.project_id == project_id
    ).first()

    if not code:
        raise HTTPException(status_code=404, detail="Code not found")

    return code_to_response(code, db)


@router.patch("/{code_id}", response_model=CodeResponse)
async def update_code(
    project_id: int,
    code_id: int,
    data: CodeUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a code (never delete, use is_active=False to deactivate)."""
    code = db.query(Code).options(
        joinedload(Code.category),
    ).filter(
        Code.id == code_id,
        Code.project_id == project_id
    ).first()

    if not code:
        raise HTTPException(status_code=404, detail="Code not found")

    update_data = data.model_dump(exclude_unset=True)

    # Handle category change
    if "category_id" in update_data:
        new_cat_id = update_data["category_id"]
        if new_cat_id is not None:
            cat = db.query(CodeCategory).filter(
                CodeCategory.id == new_cat_id,
                CodeCategory.project_id == project_id,
            ).first()
            if not cat:
                raise HTTPException(status_code=404, detail="Category not found")
            # Auto-assign category_order at end
            max_order = db.query(func.max(Code.category_order)).filter(
                Code.project_id == project_id,
                Code.category_id == new_cat_id,
            ).scalar()
            code.category_order = (max_order + 1) if max_order is not None else 0
        else:
            code.category_order = None

    for field, value in update_data.items():
        setattr(code, field, value)

    log_action(
        db,
        action="updated",
        entity_type="code",
        entity_id=code.id,
        user_id=user.id,
        project_id=project_id,
        details=update_data
    )
    db.commit()
    db.refresh(code)

    return code_to_response(code, db)


@router.post("/reorder-in-category")
async def reorder_codes_in_category(
    project_id: int,
    data: CodeReorderInCategoryRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Bulk set category_order for codes within a given category."""
    _get_project_or_404(db, project_id, user.id)

    for order, code_id in enumerate(data.ordered_code_ids):
        db.query(Code).filter(
            Code.id == code_id,
            Code.project_id == project_id,
            Code.category_id == data.category_id,
        ).update({"category_order": order})

    db.commit()
    return {"status": "ok"}


@router.get("/{code_id}/segments")
async def get_code_segments(
    project_id: int,
    code_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get all segments that have this code applied, grouped by conversation."""
    code = db.query(Code).filter(
        Code.id == code_id,
        Code.project_id == project_id
    ).first()

    if not code:
        raise HTTPException(status_code=404, detail="Code not found")

    # Get all segments with this code — eager load to avoid N+1, exclude soft-deleted
    applications = db.query(CodeApplication).options(
        joinedload(CodeApplication.segment).joinedload(Segment.conversation),
        joinedload(CodeApplication.segment).joinedload(Segment.speaker),
    ).join(Segment).filter(
        CodeApplication.code_id == code_id,
        Segment.merged_into_id == None,
        Segment.split_into_id == None,
    ).all()

    # Group by conversation
    conversations = {}
    for app in applications:
        segment = app.segment
        if not segment:
            continue

        conversation_id = segment.conversation_id
        if conversation_id not in conversations:
            conversations[conversation_id] = {
                "conversation_id": conversation_id,
                "conversation_name": segment.conversation.name if segment.conversation else "Unknown",
                "segments": []
            }

        conversations[conversation_id]["segments"].append({
            "id": segment.id,
            "sequence_order": segment.sequence_order,
            "speaker_name": segment.speaker.name if segment.speaker else None,
            "text": segment.text,
            "start_time": segment.start_time
        })

    return {
        "code": code_to_response(code, db),
        "conversations": list(conversations.values())
    }


@router.post("/bulk-move", response_model=BulkMoveResponse)
async def bulk_move_codes(
    project_id: int,
    data: BulkMoveRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Move multiple codes to a target category in one operation."""
    _get_project_or_404(db, project_id, user.id)

    # Validate target category exists (if not null = uncategorized)
    if data.target_category_id is not None:
        cat = db.query(CodeCategory).filter(
            CodeCategory.id == data.target_category_id,
            CodeCategory.project_id == project_id,
        ).first()
        if not cat:
            raise HTTPException(status_code=404, detail="Target category not found")

    # Fetch codes and validate ownership + not universal
    codes = db.query(Code).filter(
        Code.id.in_(data.code_ids),
        Code.project_id == project_id,
    ).all()

    if len(codes) != len(data.code_ids):
        raise HTTPException(status_code=404, detail="One or more codes not found")

    if any(c.is_universal for c in codes):
        raise HTTPException(status_code=400, detail="Cannot move universal codes")

    # Get next category_order for target
    max_order = db.query(func.max(Code.category_order)).filter(
        Code.project_id == project_id,
        Code.category_id == data.target_category_id,
    ).scalar()
    next_order = (max_order + 1) if max_order is not None else 0

    for code in codes:
        code.category_id = data.target_category_id
        code.category_order = next_order
        next_order += 1

    log_action(
        db,
        action="bulk_moved",
        entity_type="code",
        entity_id=data.code_ids[0],
        user_id=user.id,
        project_id=project_id,
        details={"code_ids": data.code_ids, "target_category_id": data.target_category_id}
    )
    db.commit()

    return BulkMoveResponse(moved=len(codes))


@router.post("/{source_code_id}/merge/{target_code_id}", response_model=MergeCodesResponse)
async def merge_codes(
    project_id: int,
    source_code_id: int,
    target_code_id: int,
    delete_source: bool = Query(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Merge source code into target: reassign all applications, handle duplicates."""
    if source_code_id == target_code_id:
        raise HTTPException(status_code=400, detail="Cannot merge a code with itself")

    source = db.query(Code).filter(
        Code.id == source_code_id, Code.project_id == project_id
    ).first()
    target = db.query(Code).filter(
        Code.id == target_code_id, Code.project_id == project_id
    ).first()

    if not source or not target:
        raise HTTPException(status_code=404, detail="Code not found")
    if source.is_universal or target.is_universal:
        raise HTTPException(status_code=400, detail="Cannot merge universal codes")

    # Get all applications on the source code
    source_apps = db.query(CodeApplication).filter(
        CodeApplication.code_id == source_code_id
    ).all()

    # Build sets of existing target applications for fast dedup lookup
    target_seg_ids = set()
    target_dv_ids = set()
    for app in db.query(CodeApplication).filter(
        CodeApplication.code_id == target_code_id
    ).all():
        if app.segment_id is not None:
            target_seg_ids.add(app.segment_id)
        if app.dataset_value_id is not None:
            target_dv_ids.add(app.dataset_value_id)

    merged = 0
    skipped = 0

    for app in source_apps:
        is_duplicate = False
        if app.segment_id is not None and app.segment_id in target_seg_ids:
            is_duplicate = True
        if app.dataset_value_id is not None and app.dataset_value_id in target_dv_ids:
            is_duplicate = True

        if is_duplicate:
            db.delete(app)
            skipped += 1
        else:
            app.code_id = target_code_id
            merged += 1

    # Deactivate or delete source
    if delete_source:
        db.delete(source)
        source_action = "deleted"
    else:
        source.is_active = False
        source_action = "deactivated"

    log_action(
        db,
        action="merged",
        entity_type="code",
        entity_id=target_code_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "source_code_id": source_code_id,
            "source_name": source.name,
            "target_name": target.name,
            "merged": merged,
            "skipped": skipped,
            "source_action": source_action,
        }
    )
    db.commit()

    return MergeCodesResponse(merged=merged, skipped=skipped, source_action=source_action)


# Category routes
category_router = APIRouter(prefix="/api/projects/{project_id}/categories", tags=["categories"])


@category_router.get("")
async def list_categories(
    project_id: int,
    include_codes: bool = Query(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all code categories in a project. When include_codes=True, embed codes."""
    _get_project_or_404(db, project_id, user.id)

    categories = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).order_by(CodeCategory.display_order).all()

    if include_codes:
        # Batch load codes for all categories + usage counts
        all_codes = db.query(Code).filter(
            Code.project_id == project_id,
            Code.category_id != None,
            Code.is_active == True,
        ).order_by(Code.category_order, Code.numeric_id).all()

        code_ids = [c.id for c in all_codes]
        usage_counts = {}
        if code_ids:
            usage_counts = dict(
                db.query(CodeApplication.code_id, func.count(CodeApplication.id))
                .filter(CodeApplication.code_id.in_(code_ids))
                .group_by(CodeApplication.code_id)
                .all()
            )

        # Group codes by category
        codes_by_cat: dict[int, list[CodeResponse]] = {}
        for code in all_codes:
            cat_id = code.category_id
            if cat_id not in codes_by_cat:
                codes_by_cat[cat_id] = []
            codes_by_cat[cat_id].append(
                code_to_response(code, db, usage_count=usage_counts.get(code.id, 0))
            )

        result = []
        for cat in categories:
            result.append(CodeCategoryWithCodesResponse(
                id=cat.id,
                project_id=cat.project_id,
                name=cat.name,
                color=cat.color,
                display_order=cat.display_order,
                parent_id=cat.parent_id,
                created_at=cat.created_at,
                code_count=len(codes_by_cat.get(cat.id, [])),
                codes=codes_by_cat.get(cat.id, []),
            ))

        return {"categories": result, "total": len(result)}

    # Batch count codes per category
    cat_ids = [cat.id for cat in categories]
    code_counts = {}
    if cat_ids:
        code_counts = dict(
            db.query(Code.category_id, func.count(Code.id))
            .filter(Code.category_id.in_(cat_ids), Code.is_active == True)
            .group_by(Code.category_id)
            .all()
        )

    result = []
    for cat in categories:
        result.append(CodeCategoryResponse(
            id=cat.id,
            project_id=cat.project_id,
            name=cat.name,
            color=cat.color,
            display_order=cat.display_order,
            parent_id=cat.parent_id,
            created_at=cat.created_at,
            code_count=code_counts.get(cat.id, 0)
        ))

    return {"categories": result, "total": len(result)}


def _get_category_depth(db: Session, category_id: int) -> int:
    """Walk parent chain to compute depth (0 = root)."""
    depth = 0
    current_id = category_id
    visited = set()
    while current_id is not None:
        if current_id in visited:
            break
        visited.add(current_id)
        parent_id = db.query(CodeCategory.parent_id).filter(
            CodeCategory.id == current_id
        ).scalar()
        if parent_id is None:
            break
        depth += 1
        current_id = parent_id
    return depth



def _build_category_tree_info(db: Session, project_id: int) -> tuple[
    dict[int, CodeCategory],  # cat_map: id → CodeCategory
    dict[int, int],           # depth_map: id → depth (0=root)
    dict[int, int],           # subtree_height_map: id → max relative depth below
    dict[int, list[int]],     # children_map: id → [child_ids]
]:
    """Load all project categories in one query, compute depth/height maps in memory."""
    all_cats = db.query(CodeCategory).filter(
        CodeCategory.project_id == project_id
    ).all()
    cat_map = {c.id: c for c in all_cats}
    children_map: dict[int, list[int]] = {c.id: [] for c in all_cats}
    for c in all_cats:
        if c.parent_id is not None and c.parent_id in children_map:
            children_map[c.parent_id].append(c.id)

    # Compute depths by walking parent chains
    depth_map: dict[int, int] = {}
    for c in all_cats:
        if c.id in depth_map:
            continue
        chain = []
        cur = c
        while cur is not None and cur.id not in depth_map:
            chain.append(cur.id)
            cur = cat_map.get(cur.parent_id) if cur.parent_id else None
        base_depth = depth_map[cur.id] + 1 if cur and cur.id in depth_map else 0
        for i, cid in enumerate(reversed(chain)):
            depth_map[cid] = base_depth + i

    # Compute subtree heights bottom-up (post-order)
    subtree_height_map: dict[int, int] = {}

    def _height(cid: int) -> int:
        if cid in subtree_height_map:
            return subtree_height_map[cid]
        kids = children_map.get(cid, [])
        h = 0 if not kids else 1 + max(_height(k) for k in kids)
        subtree_height_map[cid] = h
        return h

    for c in all_cats:
        _height(c.id)

    return cat_map, depth_map, subtree_height_map, children_map


def _is_ancestor_of(ancestor_id: int, descendant_id: int, cat_map: dict[int, CodeCategory]) -> bool:
    """Check if ancestor_id is an ancestor of descendant_id by walking parent chain in memory."""
    current = cat_map.get(descendant_id)
    visited: set[int] = set()
    while current is not None:
        if current.parent_id is None:
            return False
        if current.parent_id == ancestor_id:
            return True
        if current.parent_id in visited:
            return False
        visited.add(current.parent_id)
        current = cat_map.get(current.parent_id)
    return False


@category_router.post("", response_model=CodeCategoryResponse)
async def create_category(
    project_id: int,
    data: CodeCategoryCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new code category."""
    _get_project_or_404(db, project_id, user.id)

    # Validate parent if provided
    if data.parent_id is not None:
        parent = db.query(CodeCategory).filter(
            CodeCategory.id == data.parent_id,
            CodeCategory.project_id == project_id,
        ).first()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent category not found")
        parent_depth = _get_category_depth(db, data.parent_id)
        if parent_depth + 1 > 3:
            raise HTTPException(status_code=400, detail="Maximum category nesting depth (3) exceeded")

    # Get next display order scoped to siblings with same parent_id
    max_order = db.query(func.max(CodeCategory.display_order)).filter(
        CodeCategory.project_id == project_id,
        CodeCategory.parent_id == data.parent_id,
    ).scalar() or 0

    category = CodeCategory(
        project_id=project_id,
        name=data.name,
        color=data.color,
        parent_id=data.parent_id,
        display_order=max_order + 1
    )
    db.add(category)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="code_category",
        entity_id=category.id,
        user_id=user.id,
        project_id=project_id,
        details={"name": category.name, "parent_id": data.parent_id}
    )
    db.commit()
    db.refresh(category)

    return CodeCategoryResponse(
        id=category.id,
        project_id=category.project_id,
        name=category.name,
        color=category.color,
        display_order=category.display_order,
        parent_id=category.parent_id,
        created_at=category.created_at,
        code_count=0
    )


@category_router.patch("/{category_id}", response_model=CodeCategoryResponse)
async def update_category(
    project_id: int,
    category_id: int,
    data: CodeCategoryUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a category."""
    category = db.query(CodeCategory).filter(
        CodeCategory.id == category_id,
        CodeCategory.project_id == project_id
    ).first()

    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    update_data = data.model_dump(exclude_unset=True)

    # Handle parent_id change with validation
    if "parent_id" in update_data:
        new_parent_id = update_data["parent_id"]
        if new_parent_id is not None:
            # Load all categories once for in-memory validation
            cat_map, depth_map, subtree_height_map, children_map = _build_category_tree_info(db, project_id)

            if new_parent_id not in cat_map:
                raise HTTPException(status_code=404, detail="Parent category not found")

            # Circular reference check: walk parent chain in memory
            if _is_ancestor_of(category_id, new_parent_id, cat_map):
                raise HTTPException(status_code=400, detail="Circular category reference")

            # Depth limit check
            proposed_depth = depth_map.get(new_parent_id, 0) + 1
            subtree_depth = subtree_height_map.get(category_id, 0)
            if proposed_depth + subtree_depth > 3:
                raise HTTPException(status_code=400, detail="Maximum category nesting depth (3) exceeded")

    for field, value in update_data.items():
        setattr(category, field, value)

    log_action(
        db,
        action="updated",
        entity_type="code_category",
        entity_id=category.id,
        user_id=user.id,
        project_id=project_id,
        details=update_data
    )
    db.commit()
    db.refresh(category)

    code_count = db.query(func.count(Code.id)).filter(
        Code.category_id == category.id,
        Code.is_active == True,
    ).scalar() or 0

    return CodeCategoryResponse(
        id=category.id,
        project_id=category.project_id,
        name=category.name,
        color=category.color,
        display_order=category.display_order,
        parent_id=category.parent_id,
        created_at=category.created_at,
        code_count=code_count
    )


@category_router.delete("/{category_id}")
async def delete_category(
    project_id: int,
    category_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete a category (codes remain, just lose category assignment)."""
    category = db.query(CodeCategory).filter(
        CodeCategory.id == category_id,
        CodeCategory.project_id == project_id
    ).first()

    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    cat_name = category.name

    # Clear category_order on affected codes (FK SET NULL handles category_id)
    db.query(Code).filter(Code.category_id == category_id).update(
        {"category_order": None}, synchronize_session="fetch"
    )

    log_action(
        db,
        action="deleted",
        entity_type="code_category",
        entity_id=category_id,
        user_id=user.id,
        project_id=project_id,
        details={"name": cat_name}
    )
    db.delete(category)
    db.commit()

    return {"status": "ok", "deleted_id": category_id}


@category_router.post("/reorder")
async def reorder_categories(
    project_id: int,
    data: CategoryReorderRequest,
    parent_id: int | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Bulk set display_order for sibling categories under the same parent."""
    _get_project_or_404(db, project_id, user.id)

    for order, cat_id in enumerate(data.ordered_ids):
        db.query(CodeCategory).filter(
            CodeCategory.id == cat_id,
            CodeCategory.project_id == project_id,
            CodeCategory.parent_id == parent_id,
        ).update({"display_order": order})

    db.commit()
    return {"status": "ok"}


@category_router.post("/merge", response_model=CategoryMergeResponse)
async def merge_categories(
    project_id: int,
    data: CategoryMergeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Merge source categories into target: move codes, reparent children, reassign memos, delete sources."""
    _get_project_or_404(db, project_id, user.id)

    cat_map, depth_map, subtree_height_map, children_map = _build_category_tree_info(db, project_id)

    # Validate target
    if data.target_id not in cat_map:
        raise HTTPException(status_code=404, detail="Target category not found")
    target = cat_map[data.target_id]

    # Validate sources
    if data.target_id in data.source_ids:
        raise HTTPException(status_code=400, detail="Target category cannot be one of the sources")
    source_ids_set = set(data.source_ids)
    missing = [sid for sid in data.source_ids if sid not in cat_map]
    if missing:
        raise HTTPException(status_code=404, detail=f"Source categories not found: {missing}")

    # Circular ref check: target must not be a descendant of any source
    for sid in data.source_ids:
        if _is_ancestor_of(sid, data.target_id, cat_map):
            raise HTTPException(
                status_code=400,
                detail=f"Target '{target.name}' is a descendant of source '{cat_map[sid].name}' — would create circular reference"
            )

    # Pre-validate depth constraints for ALL reparented children
    target_depth = depth_map[data.target_id]
    violations = []
    for sid in data.source_ids:
        for child_id in children_map.get(sid, []):
            if child_id in source_ids_set:
                continue  # child is also being merged, skip
            child_height = subtree_height_map.get(child_id, 0)
            new_depth = target_depth + 1 + child_height
            if new_depth > 3:
                violations.append(
                    f"'{cat_map[child_id].name}' (subtree height {child_height}) would reach depth {new_depth}"
                )
    if violations:
        raise HTTPException(
            status_code=422,
            detail=f"Merge would exceed max depth (3): {'; '.join(violations)}"
        )

    total_codes = 0
    total_reparented = 0
    total_memos = 0

    for sid in data.source_ids:
        source = cat_map[sid]

        # Move codes: preserve relative order, assign sequential category_order at target
        max_order = db.query(func.max(Code.category_order)).filter(
            Code.project_id == project_id,
            Code.category_id == data.target_id,
        ).scalar()
        next_order = (max_order + 1) if max_order is not None else 0

        source_codes = db.query(Code).filter(
            Code.category_id == sid,
        ).order_by(Code.category_order, Code.numeric_id).all()

        for code in source_codes:
            code.category_id = data.target_id
            code.category_order = next_order
            next_order += 1
        total_codes += len(source_codes)

        # Reparent child categories to target (skip children that are also sources)
        max_display = db.query(func.max(CodeCategory.display_order)).filter(
            CodeCategory.project_id == project_id,
            CodeCategory.parent_id == data.target_id,
        ).scalar()
        next_display = (max_display + 1) if max_display is not None else 0

        for child_id in children_map.get(sid, []):
            if child_id in source_ids_set:
                continue
            child_cat = db.query(CodeCategory).filter(CodeCategory.id == child_id).first()
            if child_cat:
                child_cat.parent_id = data.target_id
                child_cat.display_order = next_display
                next_display += 1
                total_reparented += 1

        # Reassign memos to target
        memo_count = db.query(Memo).filter(
            Memo.entity_type == "code_category",
            Memo.entity_id == sid,
        ).update({"entity_id": data.target_id}, synchronize_session="fetch")
        total_memos += memo_count

        # Delete source category
        db.query(CodeCategory).filter(CodeCategory.id == sid).delete(synchronize_session="fetch")

    log_action(
        db,
        action="category_merged",
        entity_type="code_category",
        entity_id=data.target_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "source_ids": data.source_ids,
            "source_names": [cat_map[sid].name for sid in data.source_ids],
            "target_name": target.name,
            "merged_codes": total_codes,
            "reparented_categories": total_reparented,
            "merged_memos": total_memos,
        }
    )
    db.commit()

    return CategoryMergeResponse(
        merged_codes=total_codes,
        reparented_categories=total_reparented,
        merged_memos=total_memos,
    )


@category_router.post("/bulk-move", response_model=CategoryBulkMoveResponse)
async def bulk_move_categories(
    project_id: int,
    data: CategoryBulkMoveRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Move multiple categories to a new parent (or root)."""
    _get_project_or_404(db, project_id, user.id)

    cat_map, depth_map, subtree_height_map, children_map = _build_category_tree_info(db, project_id)

    # Validate target parent
    if data.target_parent_id is not None:
        if data.target_parent_id not in cat_map:
            raise HTTPException(status_code=404, detail="Target parent category not found")
        if data.target_parent_id in data.category_ids:
            raise HTTPException(status_code=400, detail="Target parent cannot be one of the moved categories")

    # Validate all categories exist
    missing = [cid for cid in data.category_ids if cid not in cat_map]
    if missing:
        raise HTTPException(status_code=404, detail=f"Categories not found: {missing}")

    target_depth = depth_map[data.target_parent_id] + 1 if data.target_parent_id is not None else 0

    violations = []
    for cid in data.category_ids:
        # Circular ref: target must not be a descendant of this category
        if data.target_parent_id is not None and _is_ancestor_of(cid, data.target_parent_id, cat_map):
            violations.append(f"'{cat_map[cid].name}' is an ancestor of the target — would create circular reference")
            continue

        # Depth constraint
        height = subtree_height_map.get(cid, 0)
        if target_depth + height > 3:
            violations.append(
                f"'{cat_map[cid].name}' (subtree height {height}) would reach depth {target_depth + height}"
            )

    if violations:
        raise HTTPException(
            status_code=422,
            detail=f"Move would violate constraints: {'; '.join(violations)}"
        )

    # Assign sequential display_order at target
    max_display = db.query(func.max(CodeCategory.display_order)).filter(
        CodeCategory.project_id == project_id,
        CodeCategory.parent_id == data.target_parent_id,
    ).scalar()
    next_display = (max_display + 1) if max_display is not None else 0

    for cid in data.category_ids:
        cat = db.query(CodeCategory).filter(CodeCategory.id == cid).first()
        if cat:
            cat.parent_id = data.target_parent_id
            cat.display_order = next_display
            next_display += 1

    log_action(
        db,
        action="category_bulk_moved",
        entity_type="code_category",
        entity_id=data.category_ids[0],
        user_id=user.id,
        project_id=project_id,
        details={
            "category_ids": data.category_ids,
            "target_parent_id": data.target_parent_id,
        }
    )
    db.commit()

    return CategoryBulkMoveResponse(moved=len(data.category_ids))


@category_router.post("/group", response_model=CodeCategoryResponse)
async def group_into_category(
    project_id: int,
    data: GroupIntoCategoryRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new category and move specified categories/codes into it."""
    _get_project_or_404(db, project_id, user.id)

    if not data.category_ids and not data.code_ids:
        raise HTTPException(status_code=400, detail="At least one category or code must be specified")

    cat_map, depth_map, subtree_height_map, children_map = _build_category_tree_info(db, project_id)

    # Validate categories
    missing_cats = [cid for cid in data.category_ids if cid not in cat_map]
    if missing_cats:
        raise HTTPException(status_code=404, detail=f"Categories not found: {missing_cats}")

    # Validate codes
    codes = []
    if data.code_ids:
        codes = db.query(Code).filter(
            Code.id.in_(data.code_ids),
            Code.project_id == project_id,
        ).all()
        if len(codes) != len(data.code_ids):
            raise HTTPException(status_code=404, detail="One or more codes not found")
        universal = [c.name for c in codes if c.is_universal]
        if universal:
            raise HTTPException(status_code=400, detail=f"Cannot group universal codes: {', '.join(universal)}")

    # Determine insertion parent_id
    parent_id: int | None = None
    if data.category_ids:
        parent_ids = {cat_map[cid].parent_id for cid in data.category_ids}
        if len(parent_ids) == 1:
            parent_id = parent_ids.pop()  # same parent → insert as sibling
        else:
            parent_id = None  # mixed parents → root
    else:
        # Codes only
        cat_ids = {c.category_id for c in codes}
        if len(cat_ids) == 1 and None not in cat_ids:
            parent_id = cat_ids.pop()  # same category → sub-grouping
        else:
            parent_id = None  # mixed/uncategorized → root

    # Depth validation: new category at parent_id depth + 1
    new_cat_depth = (depth_map[parent_id] + 1) if parent_id is not None and parent_id in depth_map else 0

    violations = []
    for cid in data.category_ids:
        height = subtree_height_map.get(cid, 0)
        total = new_cat_depth + 1 + height
        if total > 3:
            violations.append(
                f"'{cat_map[cid].name}' (subtree height {height}) would reach depth {total}"
            )
    if violations:
        raise HTTPException(
            status_code=422,
            detail=f"Grouping would exceed max depth (3): {'; '.join(violations)}"
        )

    # Create new category
    max_display = db.query(func.max(CodeCategory.display_order)).filter(
        CodeCategory.project_id == project_id,
        CodeCategory.parent_id == parent_id,
    ).scalar()
    next_display = (max_display + 1) if max_display is not None else 0

    new_cat = CodeCategory(
        project_id=project_id,
        name=data.name,
        color=data.color,
        parent_id=parent_id,
        display_order=next_display,
    )
    db.add(new_cat)
    db.flush()  # get new_cat.id

    # Reparent categories into new category
    child_display = 0
    for cid in data.category_ids:
        cat = db.query(CodeCategory).filter(CodeCategory.id == cid).first()
        if cat:
            cat.parent_id = new_cat.id
            cat.display_order = child_display
            child_display += 1

    # Move codes into new category
    next_order = 0
    for code in codes:
        code.category_id = new_cat.id
        code.category_order = next_order
        next_order += 1

    log_action(
        db,
        action="category_grouped",
        entity_type="code_category",
        entity_id=new_cat.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "name": data.name,
            "category_ids": data.category_ids,
            "code_ids": data.code_ids,
            "parent_id": parent_id,
        }
    )
    db.commit()
    db.refresh(new_cat)

    code_count = db.query(func.count(Code.id)).filter(
        Code.category_id == new_cat.id,
        Code.is_active == True,
    ).scalar() or 0

    return CodeCategoryResponse(
        id=new_cat.id,
        project_id=new_cat.project_id,
        name=new_cat.name,
        color=new_cat.color,
        display_order=new_cat.display_order,
        parent_id=new_cat.parent_id,
        created_at=new_cat.created_at,
        code_count=code_count,
    )


