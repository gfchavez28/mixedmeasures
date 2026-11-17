import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DELETE_REACHES_DISPLAYS_TEXT } from '@/lib/joint-display-vocabulary'
import { RemovalPlanStatus } from '@/components/RemovalPlanStatus'
import { useDatasetRemovalPlan } from '@/hooks/useRemovalPlan'

/**
 * The Datasets list's delete confirmation, with what else the delete removes
 * (#1175) — the dataset-level twin of `DeleteVariableDialog`, through the same
 * removal-plan gate (`lib/removal-plan.ts`).
 *
 * Its own component so the plan's query lives only while a dataset is being
 * deleted, and so it can be rendered without the list page around it.
 *
 * ⚠️ A dataset plan never carries `blocked_by` (that is a single variable's
 * computed dependents); its refusal is the cross-dataset pairing 409, said here
 * before the click with Delete held and the reason in its name.
 */
export function DeleteDatasetDialog({
  projectId,
  dataset,
  isPending,
  onCancel,
  onConfirm,
}: {
  projectId: number
  dataset: { id: number; name: string } | null
  isPending: boolean
  onCancel: () => void
  onConfirm: (datasetId: number) => void
}) {
  const plan = useDatasetRemovalPlan(projectId, dataset?.id ?? null)
  return (
    <ConfirmDialog
      open={dataset !== null}
      onOpenChange={(open) => { if (!open) onCancel() }}
      title="Delete Dataset"
      description={`Delete "${dataset?.name}"? All columns, rows, recodes, and associated data will be permanently removed. ${DELETE_REACHES_DISPLAYS_TEXT}`}
      details={dataset && plan.sentence ? <p>{plan.sentence}</p> : undefined}
      confirmLabel="Delete"
      loading={isPending}
      loadingLabel="Deleting..."
      confirmBlockedReason={plan.blockedReason}
      confirmUnavailable={plan.waiting}
      onConfirm={() => {
        if (dataset !== null) onConfirm(dataset.id)
      }}
      destructive
    >
      {/* Only while open — see `DeleteVariableDialog`. */}
      {dataset && <RemovalPlanStatus load={plan.load} />}
    </ConfirmDialog>
  )
}
