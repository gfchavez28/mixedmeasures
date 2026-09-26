import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  codeSetsApi, codingApi, isServerRefusal, serverDetailMessage, textCodingApi,
  type CodeSet,
} from '@/lib/api'
import { CodeSetPicker } from '@/components/CodeSetPicker'
import type { HistoryAction } from '@/hooks/useHistory'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import {
  choosableValues, heldRating, multipleSelectionIn, selectionIn, selectionPlan,
  type SelectionDetail, type SelectionPlan,
} from '@/lib/code-sets'
import { listStatus } from '@/lib/list-status'

/** Which target the selection is written to. The two differ in nothing else. */
export type CodeSetTarget =
  | { kind: 'segment'; segmentId: number }
  | { kind: 'text'; datasetValueId: number }

/** The part of a host's `useHistory` the strip records into. */
export interface CodeSetHistory {
  execute: (action: HistoryAction) => Promise<void>
}

/**
 * One write, with EVERYTHING it acts on carried in the call (#1023).
 *
 * 🔴 **No field here may be read from props at the time the write runs.** An
 * undo runs after the researcher has moved on — another passage, another
 * source — so `target` and `refresh` are the ones current when the choice was
 * MADE. TanStack builds each mutation from the latest render's options, which
 * is exactly how `mutationFn` reading the `target` prop cleared the passage
 * selected at undo time instead of the one the choice was made on.
 */
interface SelectionWrite {
  target: CodeSetTarget
  setId: number
  codeId: number | null
  /**
   * A rating to put back on `codeId` after selecting it — passed only by an
   * UNDO, whose value may have carried one before the swap deleted it.
   */
  magnitude: number | null
  refresh: ((saved: boolean) => void) | undefined
}

async function writeSelection(
  projectId: number,
  { target, setId, codeId, magnitude }: SelectionWrite,
): Promise<{ ratingRefusal: unknown }> {
  if (target.kind === 'segment') {
    await codeSetsApi.selectOnSegment(target.segmentId, setId, codeId)
  } else {
    await codeSetsApi.selectOnText(projectId, setId, target.datasetValueId, codeId)
  }
  // `!== null`, never truthiness: 0 is a legal rating.
  if (codeId === null || magnitude === null) return { ratingRefusal: null }
  try {
    if (target.kind === 'segment') {
      await codingApi.setMagnitude(target.segmentId, codeId, magnitude)
    } else {
      await textCodingApi.setMagnitude(projectId, {
        dataset_value_id: target.datasetValueId, code_id: codeId, magnitude,
      })
    }
  } catch (e) {
    // A transient failure rethrows, so the history keeps the step for a retry
    // (re-selecting is idempotent). A REFUSAL is settled — the scale changed
    // since — and the value IS back, so the undo succeeded; the caller says
    // which half did not.
    if (!isServerRefusal(e)) throw e
    return { ratingRefusal: e }
  }
  return { ratingRefusal: null }
}

/** The undo stack's name for the act — the set and the value, never "a value". */
function describe(set: CodeSet, plan: SelectionPlan): string {
  if (plan.codeId === null) return `Clear “${set.label}”`
  const name = set.members.find((m) => m.id === plan.codeId)?.name ?? 'a value'
  return `Choose “${name}” for “${set.label}”`
}

/**
 * Every code set as a single-choice control, above the code list (row 48).
 *
 * Built by each of the FOUR coding surfaces and rendered through the SHARED
 * panels' `codeSets` slot — `CodePanel` (conversation, document, observation) and
 * `TextCodePanel`. Shipping on three of four would leave one surface able to
 * create the two-values-at-once state the α table then has to count and drop
 * (#868/#879's lesson: enumerate the doors by what the ACT is).
 *
 * ## The history entry is built HERE, not by the hosts (#1023)
 *
 * The four hosts carried four identical copies of it, and all four read the
 * passage at undo time through this component's `useMutation`. One builder is
 * what makes "the entry captures its target" true on every surface at once;
 * the hosts pass their stack and nothing else.
 *
 * ## What it does NOT claim while the list is loading
 *
 * The sets query is rendered only once it has ANSWERED (`listStatus`): before
 * that this renders nothing at all. Absence makes no claim, where an empty
 * strip would say "this project has no variables" — the #961 rule, and the
 * reason there is deliberately no loading line here (the panel below already
 * mounts one, and two copies are a duplicate on screen and a second
 * announcement).
 */
export function CodeSetStrip({
  projectId,
  target,
  appliedCodeDetails,
  activeCoderId,
  history,
  onSettled,
}: {
  projectId: number
  /** Null when nothing is selected — the strip then renders nothing. */
  target: CodeSetTarget | null
  appliedCodeDetails: readonly SelectionDetail[] | undefined
  activeCoderId: number | null
  /**
   * 🔴 The host's `useHistory`, or `null` on a surface with no stack. REQUIRED so
   * a new mount has to decide: a selection IS a coding mutation, so on a
   * workbench it must be undoable with the same Ctrl+Z as every other one.
   * With `null` the strip commits directly — the `InlineCodeActions` delegation
   * shape (#875/#876), not a fallback to be tidied away.
   */
  history: CodeSetHistory | null
  /**
   * The host's own cache refresh — each surface's payload is shaped differently.
   * Called after EVERY write, `saved` false on a failure (an undo can fail after
   * its first call landed, so the passage may still have changed). Captured when
   * the choice is made, so an undo after moving to another source refreshes the
   * source it changed.
   */
  onSettled?: (saved: boolean) => void
}) {
  const qc = useQueryClient()
  const setsQuery = useQuery({
    queryKey: ['code-sets', projectId],
    queryFn: () => codeSetsApi.list(projectId),
  })

  const mutation = useMutation({
    mutationFn: (write: SelectionWrite) => writeSelection(projectId, write),
    onSettled: (_result, error, write) => {
      // A selection changes what is coded, so it staleizes every derived count
      // — routed through the ONE chokepoint rather than a re-listed key set.
      invalidateDerivedCounts(qc, projectId)
      write.refresh?.(error == null)
    },
    // ⚠️ Declared so the app-wide default (`main.tsx`: "Something went wrong")
    // does NOT fire: the failure is reported once, by `useHistory` or by the
    // direct path below, in the server's words.
    onError: () => {},
  })

  if (!target) return null
  if (listStatus(setsQuery) !== 'ready') return null
  const sets = (setsQuery.data?.sets ?? []).filter((s) => choosableValues(s).length > 0)
  if (sets.length === 0) return null

  // The target of THIS render — the one a press made now acts on. Named, because
  // the whole of #1023 is the difference between this and the target at replay.
  const actTarget: CodeSetTarget = target
  const busy = mutation.isPending

  return (
    <div className="space-y-2 border-b border-border px-3 py-2">
      {sets.map((set) => {
        const selected = selectionIn(set, appliedCodeDetails, activeCoderId)
        // ⚠️ No `busy` check here: the picker ignores a press while `busy` (the
        // plan is computed from the details on screen, and a press while a write
        // is in flight would plan against a state about to change), and it is
        // this handler's only caller.
        const handle = (codeId: number | null) => {
          // ⚠️ A press on the CLEAR control is not a toggle, so it does not go
          // through `selectionPlan`'s press semantics (which turn a press on the
          // selected value into a clear). Building a plan against a sentinel and
          // then overriding it computes a nonsense intermediate; the two cases
          // are simply different acts.
          const plan: SelectionPlan =
            codeId === null
              ? { setId: set.id, codeId: null, previousCodeId: selected }
              : selectionPlan(set, appliedCodeDetails, activeCoderId, codeId)
          // 🔴 Captured NOW, with the target and the refresh: the swap deletes
          // the previous value's application, and its rating with it, so an undo
          // that re-selects the value must also re-rate it (#868 (f)'s rule for
          // a removal, reached through this door).
          const previousRating = heldRating(appliedCodeDetails, activeCoderId, plan.previousCodeId)
          const write = (value: number | null, magnitude: number | null) =>
            mutation.mutateAsync({
              target: actTarget, setId: set.id, codeId: value, magnitude, refresh: onSettled,
            })

          if (!history) {
            write(plan.codeId, null).catch((error) => {
              // The client shows the SERVER's reason and never invents one (#871).
              toast.error(serverDetailMessage(error) ?? 'Could not record that choice.')
            })
            return
          }
          // ⚠️ No toast on a failure here: `useHistory` shows the server's reason
          // for every failed step, and a second one from this component was the
          // same sentence twice.
          void history.execute({
            type: 'code_apply',
            description: describe(set, plan),
            redo: async () => { await write(plan.codeId, null) },
            undo: async () => {
              const { ratingRefusal } = await write(plan.previousCodeId, previousRating)
              if (ratingRefusal) {
                const name = set.members.find((m) => m.id === plan.previousCodeId)?.name
                toast.warning(
                  `“${name ?? 'The value'}” is back, but its rating (${previousRating}) could not be restored.`,
                  { description: serverDetailMessage(ratingRefusal) ?? undefined },
                )
              }
            },
          })
        }
        return (
          <CodeSetPicker
            key={set.id}
            set={set}
            selectedCodeId={selected}
            onSelect={handle}
            busy={busy}
            multipleSelected={multipleSelectionIn(set, appliedCodeDetails, activeCoderId)}
          />
        )
      })}
    </div>
  )
}
