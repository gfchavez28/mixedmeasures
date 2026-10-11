/**
 * #1175 — a delete confirmation's removal plan, asked when the dialog OPENS.
 *
 * Two hooks, one per endpoint, and one gate (`lib/removal-plan.ts::removalPlanGate`)
 * so both confirmations decide what they may say and do the same way.
 *
 * ⚠️ `staleTime: 0` + `gcTime: 0`: the plan describes the project at the moment
 * of the click, so an answer cached from an earlier opening must not be shown as
 * this one's. The key's id goes `null` when the dialog closes, which leaves the
 * old entry with no observer and drops it; reopening asks again and says so.
 *
 * ⚠️ `enabled` only while open. A disabled query with nothing cached reads
 * `loading` forever (`lib/list-status.ts`), so the dialogs read this only while
 * open.
 */
import { useQuery } from '@tanstack/react-query'
import { datasetsApi, type RemovalPlan } from '@/lib/api'
import { useListLoad, type ListLoadQuery } from '@/hooks/useListLoad'
import type { ListLoad } from '@/lib/list-status'
import { removalPlanGate, type RemovalPlanGate } from '@/lib/removal-plan'

export interface RemovalPlanState extends RemovalPlanGate {
  load: ListLoad
}

const FRESH = { staleTime: 0, gcTime: 0 } as const

function useGate(query: ListLoadQuery & { data: RemovalPlan | undefined }): RemovalPlanState {
  const load = useListLoad(query)
  return { load, ...removalPlanGate(load.status, query.data) }
}

export function useColumnRemovalPlan(
  projectId: number,
  datasetId: number,
  columnId: number | null,
): RemovalPlanState {
  const query = useQuery({
    queryKey: ['column-removal-plan', projectId, datasetId, columnId],
    queryFn: () => datasetsApi.getColumnRemovalPlan(projectId, datasetId, columnId!),
    enabled: columnId !== null,
    ...FRESH,
  })
  return useGate(query)
}

export function useDatasetRemovalPlan(
  projectId: number,
  datasetId: number | null,
): RemovalPlanState {
  const query = useQuery({
    queryKey: ['dataset-removal-plan', projectId, datasetId],
    queryFn: () => datasetsApi.getDatasetRemovalPlan(projectId, datasetId!),
    enabled: datasetId !== null,
    ...FRESH,
  })
  return useGate(query)
}
