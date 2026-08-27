/**
 * The confirm for putting a recode rule INTO EFFECT on the variable it sits on
 * (design-note §8, 2026-08-24).
 *
 * ## Why this exists at all
 *
 * Applying a rule rewrites every stored number in the variable, and **there is
 * no undo** — the pre-transform codes are not stored anywhere, which is exactly
 * what Decision D exists to fix. Until now this was a bare "Set Primary" button
 * with no confirmation, and three OTHER paths reached the same state without
 * even a click (saving the first rule, deleting the rule in effect, copying a
 * rule onto an un-ruled variable). Two of those are closed; this is what is left
 * of the deliberate one.
 *
 * ## Why it was kept rather than removed
 *
 * The developer's case, and it is a good one: **transcription errors.** If the
 * initial coding of a variable was simply wrong, you want to correct the
 * variable, not carry a derived twin around forever. So in-place stays — named
 * honestly, warned, and never automatic.
 *
 * ## What this dialog must say, and why each part earns its place
 *
 * - **That it is not reversible.** The single most important sentence.
 * - **That there is a non-destructive alternative** — "Create as new variable"
 *   is right there on the same card, and a researcher reaching for this one may
 *   simply not have noticed it.
 * - **Which responses will be EMPTIED.** A rule that maps only some of the
 *   stored responses NULLs the rest. #794 established that a partial match is
 *   disclosed rather than prevented — but it disclosed AFTERWARDS, in a toast.
 *   Before is better, and the data is already on the card.
 * - **That a category group removes the numeric coding.** This warning used to
 *   live in the create form, gated on "this will become the primary" — a
 *   condition that can no longer be true at create time, so it would have
 *   become dead copy. It belongs here, where the thing it warns about happens.
 */
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { TriangleAlert } from 'lucide-react'
import type { RecodeDefinition } from '@/lib/api'

/** Types whose `value_numeric` carries a meaningful encoding — mirrors the set
 *  the create form used for the same warning. */
const NUMERIC_ENCODED_TYPES = new Set(['ordinal', 'numeric', 'percentage', 'binary'])

interface Props {
  open: boolean
  definition: RecodeDefinition | null
  variableLabel: string
  columnType: string | undefined
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function ApplyRuleDialog({
  open, definition, variableLabel, columnType, isPending, onCancel, onConfirm,
}: Props) {
  const unmapped = definition?.unmapped_values ?? []
  const clearsNumeric =
    definition?.recode_type === 'category_group' &&
    !!columnType &&
    NUMERIC_ENCODED_TYPES.has(columnType)

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Apply &ldquo;{definition?.name}&rdquo; to {variableLabel}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This replaces the number stored for every response in{' '}
            <strong>{variableLabel}</strong> with this rule&rsquo;s result. Charts, tables
            and statistics will use the new numbers from now on.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          {/* The sentence that matters most, and it is stated plainly rather
              than hedged: MM genuinely cannot restore the current values. */}
          <div className="flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden="true" />
            <p>
              <strong>This cannot be undone.</strong> The numbers currently stored are not
              kept anywhere, so removing the rule afterwards will not bring them back.
              To keep this variable as it is, use <strong>Create as new variable</strong> instead.
            </p>
          </div>

          {unmapped.length > 0 && (
            <div className="flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden="true" />
              <p>
                <strong>
                  {unmapped.length === 1 ? 'One response is' : `${unmapped.length} responses are`}
                  {' '}not covered by this rule:
                </strong>{' '}
                {unmapped.slice(0, 5).join(', ')}
                {unmapped.length > 5 && ` and ${unmapped.length - 5} more`}.
                {' '}Those cells will be left empty and excluded from every statistic.
              </p>
            </div>
          )}

          {clearsNumeric && (
            <div className="flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden="true" />
              <p>
                <strong>A category group produces names, not numbers.</strong> Applying it
                removes this variable&rsquo;s numeric coding, so means, correlations and
                scale scores will no longer be available for it. To keep the numbers
                <em> and</em> add readable labels, use a <strong>Scale Map</strong> instead.
              </p>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(e) => {
              // The mutation owns closing, so a failure keeps the dialog up
              // with the error visible rather than dismissing into a toast.
              e.preventDefault()
              onConfirm()
            }}
          >
            {isPending ? 'Applying…' : 'Apply to this variable'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
