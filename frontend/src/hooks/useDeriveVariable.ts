/**
 * The derive-a-new-variable flow, owned in ONE place (design-note Decision B,
 * Stage 3 — 2026-08-24).
 *
 * ## Why a hook rather than a second copy
 *
 * Decision B put "Create as new variable…" on the Variables view's rule cards.
 * Stage 3 adds a second entry point — `Add ▾ → Recoded variable…` on the Data
 * view — because jamovi's `Add` offers **Data / Computed / Transformed** in one
 * menu and MM had built the third kind while listing only two (design note §11).
 *
 * Two surfaces, one act. Copying the plan fetch, the mutation and the dialog
 * state into `DatasetView` would be the substrate debt this whole arc has been
 * retiring — and the specific failure it invites is the one #807 found, where a
 * control existed on three surfaces and only one carried the right gate.
 *
 * ## What each surface still decides for itself
 *
 * `onCreated` — the Variables view NAVIGATES to the new variable (otherwise the
 * researcher is left on the source, with the thing they just made invisible);
 * the Data view does nothing, because the new column appears in the grid where
 * they are already looking. Same act, different "you are here".
 */
import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { recodeApi, type DerivePlan, type RecodeDefinition } from '@/lib/api'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'

/** The rule a derive is pending on, plus the column it belongs to.
 *  ⚠️ The column id is carried EXPLICITLY rather than read from a page's
 *  "selected column" state — the Data view has no such selection, and a hook
 *  that depended on one could only ever serve the page it was extracted from. */
export interface DeriveTarget {
  columnId: number
  definition: Pick<RecodeDefinition, 'id' | 'name'>
}

export function useDeriveVariable(
  projectId: number,
  datasetId: number,
  onCreated?: (newColumnId: number) => void,
) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<DeriveTarget | null>(null)
  const [plan, setPlan] = useState<DerivePlan | null>(null)

  const open = useCallback(async (next: DeriveTarget) => {
    setTarget(next)
    setPlan(null)
    try {
      setPlan(await recodeApi.derivePlan(
        projectId, datasetId, next.columnId, next.definition.id,
      ))
    } catch {
      toast.error('Could not work out what this rule would produce.')
      setTarget(null)
    }
  }, [projectId, datasetId])

  const close = useCallback(() => { setTarget(null); setPlan(null) }, [])

  const mutation = useMutation({
    mutationFn: (vars: { name: string; carryLabels: boolean }) =>
      recodeApi.deriveColumn(
        projectId, datasetId, target!.columnId, target!.definition.id,
        { column_text: vars.name, carry_labels: vars.carryLabels },
      ),
    onSuccess: (res) => {
      // `invalidateColumnDictionary` is the ONE place the key set a column
      // change staleizes lives (#608). A hand-listed set here is the #450 class,
      // and it has rotted once already.
      invalidateColumnDictionary(queryClient, projectId, datasetId)
      toast.success(
        res.unmapped_values.length > 0
          ? `Variable created (${res.values_written} values). `
            + `${res.unmapped_values.length} response${res.unmapped_values.length === 1 ? '' : 's'} `
            + 'had no value under this rule.'
          : `Variable created (${res.values_written} values).`
      )
      setTarget(null)
      setPlan(null)
      onCreated?.(res.created_column_id)
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Could not create the variable. Nothing was changed.')
    },
  })

  return {
    /** Props for `DeriveVariableDialog`, minus the two the surface names. */
    dialogProps: {
      open: target !== null,
      ruleName: target?.definition.name ?? '',
      plan,
      isPending: mutation.isPending,
      onCancel: close,
      onConfirm: (name: string, carryLabels: boolean) =>
        mutation.mutate({ name, carryLabels }),
    },
    open,
    isPending: mutation.isPending,
    /** The column the pending derive reads FROM — surfaces need it to label the
     *  dialog, and tracking it separately would be a second source of truth for
     *  a fact the hook already holds. */
    sourceColumnId: target?.columnId ?? null,
  }
}
