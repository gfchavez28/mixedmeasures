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
import { columnDisplayLabel } from '@/lib/dataset-column-label'
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
 */
export function DeleteVariableDialog({
  column,
  isPending,
  onCancel,
  onConfirm,
}: {
  column: DeletableColumn | null
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const isDerived = Boolean((column as { derived_via?: string | null } | null)?.derived_via)
  const isComputed = column?.source === 'computed'

  // What the researcher can get back, in their terms. The third arm is the one
  // that earns the warning — nothing else in the project holds those values.
  const recovery = isDerived
    ? 'You can recreate it by running the same rule on its source variable again.'
    : isComputed
      ? 'You can recreate it from its formula.'
      : 'Its values are not stored anywhere else in this project.'

  return (
    <AlertDialog open={column !== null} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {column ? columnDisplayLabel(column) : 'this variable'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the variable, every response recorded against it, and
            any value labels, missing-value rules and recodes it carries. {recovery} This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700"
            onClick={onConfirm}
          >
            {isPending ? 'Deleting…' : 'Delete variable'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
