/**
 * useCrosswalkDomainShape — single-pass derivation of the four maps
 * CrosswalkView (and downstream consumers like useCrosswalkDnD) need
 * about each domain's column membership.
 *
 * Replaces 4 separate `useMemo` blocks in CrosswalkView (audit Batch C,
 * P4 step 2) that each iterated `domains[].members[]` independently.
 * One pass produces all four shapes with deps `[domains, columnsById]`.
 *
 * Returned shapes:
 *   - `domainMemberColumnIds: Set<number>`
 *       Every column id that is a member of any domain. Drives the Cell
 *       context-menu's "Remove from variable group" item AND the
 *       computeUnassignedColumns + visibleSuggestions exclusion (Path A
 *       synthetic single-cell rows are domain members with null EG, see
 *       #334).
 *   - `domainByColumnId: Map<number, number>`
 *       column_id → owning domain id. Used by the DnD hook to recognize
 *       cross-bracket gestures and route through `moveMembersMutation`.
 *   - `domainByEgId: Map<number, number>`
 *       equivalence_group_id → owning domain id. Used to resolve the
 *       target domain when dropping into an empty EG cell.
 *   - `bracketDatasetsByDomainId: Map<number, Set<number>>`
 *       domain id → set of dataset ids already represented. Used by DnD
 *       to pre-validate "+ Add variable row" drops against the #290
 *       cross-dataset pairing invariant.
 */

import { useMemo } from 'react'
import type { AnalysisDomainResponse } from '@/lib/api'
import type { ProjectColumnInfo } from './crosswalk-types'

export interface CrosswalkDomainShape {
  domainMemberColumnIds: Set<number>
  domainByColumnId: Map<number, number>
  domainByEgId: Map<number, number>
  bracketDatasetsByDomainId: Map<number, Set<number>>
}

export function useCrosswalkDomainShape(
  domains: AnalysisDomainResponse[],
  columnsById: Map<number, ProjectColumnInfo>,
): CrosswalkDomainShape {
  return useMemo(() => {
    const domainMemberColumnIds = new Set<number>()
    const domainByColumnId = new Map<number, number>()
    const domainByEgId = new Map<number, number>()
    const bracketDatasetsByDomainId = new Map<number, Set<number>>()

    for (const d of domains) {
      const datasets = new Set<number>()
      for (const m of d.members) {
        if (m.member_type !== 'column') continue
        const columnId = m.member_id
        domainMemberColumnIds.add(columnId)
        domainByColumnId.set(columnId, d.id)
        const col = columnsById.get(columnId)
        if (col == null) continue
        if (col.equivalence_group_id != null) {
          domainByEgId.set(col.equivalence_group_id, d.id)
        }
        datasets.add(col.dataset_id)
      }
      bracketDatasetsByDomainId.set(d.id, datasets)
    }

    return {
      domainMemberColumnIds,
      domainByColumnId,
      domainByEgId,
      bracketDatasetsByDomainId,
    }
  }, [domains, columnsById])
}
