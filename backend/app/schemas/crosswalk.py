"""Schemas for the Tier 3 crosswalk's atomic move-members endpoint (Path A, #328).

The move-members endpoint atomically updates BOTH the equivalence-group link
(`DatasetColumn.equivalence_group_id`) AND analysis-domain membership
(`AnalysisDomainMember`) in one transaction. This replaces today's "drag
changes EG link only, domain membership stays — phantom cells across
brackets" semantics with "drag = full move, both layers update together."

The endpoint also supports drag-to-Unassigned (`target_domain_id=None`,
`target_mode='strip'`), promoting two single-dataset members into a paired
EG (`target_mode='new_eg'`), and multi-select moves (N column_ids in one
transaction).

See #328 and the internal design notes
for the full architecture.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .analysis_domain import AnalysisDomainResponse


class MoveMembersRequest(BaseModel):
    """Request body for `POST /projects/{pid}/crosswalk/move-members`.

    `target_mode` is the discriminator:
      * `existing_eg` — assign all `column_ids` to the existing EG `target_eg_id`.
      * `new_eg` — create a new EG with `target_eg_label`, attach all `column_ids`.
      * `strip` — set `equivalence_group_id = None` for all `column_ids` (synthetic
        single-cell rows in the target domain, or fully unassigned).
    """
    column_ids: list[int] = Field(..., min_length=1)
    source_domain_id: int | None = None
    target_domain_id: int | None = None
    target_mode: Literal["existing_eg", "new_eg", "strip"]
    target_eg_id: int | None = None
    target_eg_label: str | None = None

    @model_validator(mode="after")
    def _validate_target_mode_payload(self):
        if self.target_mode == "existing_eg":
            if self.target_eg_id is None:
                raise ValueError(
                    "target_eg_id is required when target_mode='existing_eg'"
                )
            if self.target_eg_label is not None:
                raise ValueError(
                    "target_eg_label must be None when target_mode='existing_eg'"
                )
        elif self.target_mode == "new_eg":
            if not self.target_eg_label or not self.target_eg_label.strip():
                raise ValueError(
                    "target_eg_label is required when target_mode='new_eg'"
                )
            if self.target_eg_id is not None:
                raise ValueError(
                    "target_eg_id must be None when target_mode='new_eg'"
                )
        elif self.target_mode == "strip":
            if self.target_eg_id is not None or self.target_eg_label is not None:
                raise ValueError(
                    "target_eg_id and target_eg_label must both be None when target_mode='strip'"
                )

        if self.source_domain_id is None and self.target_domain_id is None:
            raise ValueError(
                "At least one of source_domain_id or target_domain_id must be set"
            )
        return self


class MoveMembersResponse(BaseModel):
    """Response from move-members.

    `source_domain` and `target_domain` are loaded fresh after the transaction
    commits. Either may be None if the corresponding side wasn't part of the
    move (e.g., promoting unassigned columns has no source domain).

    `dissolved_eg_ids` lists any equivalence groups that became empty as a
    result of the move and were auto-deleted in the same transaction.

    `recomputed_metric_ids` mirrors the swap endpoint's reporting for the
    domain_aggregate metrics that were synchronously recomputed.
    """
    source_domain: AnalysisDomainResponse | None = None
    target_domain: AnalysisDomainResponse | None = None
    dissolved_eg_ids: list[int] = Field(default_factory=list)
    recomputed_metric_ids: list[int] = Field(default_factory=list)
