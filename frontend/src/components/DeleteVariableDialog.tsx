import { DELETE_REACHES_DISPLAYS_TEXT } from '@/lib/joint-display-vocabulary'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RemovalPlanStatus } from '@/components/RemovalPlanStatus'
import { useColumnRemovalPlan } from '@/hooks/useRemovalPlan'
import { columnDisplayLabel } from '@/lib/dataset-column-label'
import { MODE_DISABLED_CLASS, modeDisabledProps } from '@/lib/mode-disabled'
import type { DeletableColumn } from '@/hooks/useDeleteVariable'

/**
 * The one confirm for deleting a variable (#812), shared by the Data view's
 * three triggers and the Variables view's.
 *
 * ⚠️ **It names the variable through `columnDisplayLabel`, not `column_text`.**
 * The copy this replaces interpolated `column_text` directly, so on a variable
 * with a short name the dialog named a DIFFERENT string than the grid the
 * researcher was right-clicking — in the one place in the app where naming the
 * wrong thing loses data.
 *
 * 🔴 **The stakes line differs by what the variable IS, because they genuinely
 * differ.** ISSUES #812 asks whether the answer should differ for a derived
 * column (a snapshot regenerable in two clicks) versus a hand-typed manual one
 * (whose values exist nowhere else). It should — and saying so is cheaper and
 * more honest than gating the affordance differently per kind, which is how a
 * destructive verb ends up with three inconsistent gates.
 *
 * 🔴 **#1175 — and it says what ELSE goes.** The removal plan (`useRemovalPlan`)
 * names the saved statistics, tests and variable groups the delete removes or
 * recalculates, in the description so a reader hears it on open. A refusal the
 * delete would raise (a computed variable reads this one; a group left unpaired)
 * is said BEFORE the click, and Delete stays focusable with the reason in its
 * name (`lib/mode-disabled.ts`). While the plan loads, Delete waits.
 */
export function DeleteVariableDialog({
  projectId,
  datasetId,
  column,
  isPending,
  onCancel,
  onConfirm,
}: {
  projectId: number
  datasetId: number
  column: DeletableColumn | null
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const isDerived = Boolean((column as { derived_via?: string | null } | null)?.derived_via)
  const isComputed = column?.source === 'computed'
  const plan = useColumnRemovalPlan(projectId, datasetId, column?.id ?? null)

  // What the researcher can get back, in their terms. The third arm is the one
  // that earns the warning — nothing else in the project holds those values.
  const recovery = isDerived
    ? 'You can recreate it by running the same rule on its source variable again.'
    : isComputed
      ? 'You can recreate it from its formula.'
      : 'Its values are not stored anywhere else in this project.'

  const label = isPending ? 'Deleting…' : 'Delete variable'
  const confirm = modeDisabledProps<HTMLButtonElement>({
    label,
    blockedReason: plan.blockedReason,
    unavailable: plan.waiting,
    onActivate: onConfirm,
  })

  return (
    <AlertDialog open={column !== null} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {column ? columnDisplayLabel(column) : 'this variable'}?
          </AlertDialogTitle>
          {/* `asChild` onto a div so the plan's sentence is a second paragraph
              INSIDE the described element (#955 d: on screen and silent
              otherwise), as `ConfirmDialog`'s `details` does. */}
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This permanently removes the variable, every response recorded against it, and
                any value labels, missing-value rules and recodes it carries. {recovery} This
                cannot be undone. {DELETE_REACHES_DISPLAYS_TEXT}
              </p>
              {column && plan.sentence && <p>{plan.sentence}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Only while open: the closing animation keeps this mounted with the
            column gone, when the disabled query would read "checking" again. */}
        {column && <RemovalPlanStatus load={plan.load} />}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            {...confirm}
            className={`bg-red-600 hover:bg-red-700 ${MODE_DISABLED_CLASS}`}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
