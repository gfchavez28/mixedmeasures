import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCodeSets } from '@/hooks/useCodeSets'
import { toast } from 'sonner'
import { useMemo } from 'react'
import {
  codeSetsApi, codingApi, isServerRefusal, serverDetailMessage, textCodingApi,
  type Code, type CodeSet,
} from '@/lib/api'
import { CodeSetPicker } from '@/components/CodeSetPicker'
import type { HistoryAction } from '@/hooks/useHistory'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import {
  choosableValues, heldRating, multipleSelectionIn, selectionIn, selectionPlan,
  withLiveMembers, type LiveCode, type SelectionDetail, type SelectionPlan,
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
  /**
   * `codeId` is a code OUTSIDE the set grouped into one of its values (#1028 b)
   * — only an undo puts one back. The set's endpoint refuses a non-member, so it
   * goes through the ordinary apply, whose swap is the same act.
   */
  synonym: boolean
  refresh: ((saved: boolean) => void) | undefined
}

async function writeSelection(
  projectId: number,
  { target, setId, codeId, magnitude, synonym }: SelectionWrite,
): Promise<{ ratingRefusal: unknown }> {
  if (synonym && codeId !== null) {
    if (target.kind === 'segment') await codingApi.applyCode(target.segmentId, codeId)
    else await textCodingApi.applyCode(projectId, { dataset_value_id: target.datasetValueId, code_id: codeId })
  } else if (target.kind === 'segment') {
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

/** One member of a segment group, as the undo of a choice on the group needs it. */
export interface GroupMember {
  segmentId: number
  appliedCodeDetails: readonly SelectionDetail[] | undefined
}

/** What a choice on a GROUPED segment changed on one member (#1070). */
interface MemberRestore {
  segmentId: number
  /** The member's value before the act, or null when it held none. */
  previous: number | null
  rating: number | null
}

/**
 * #1070 — undo a choice made on a segment GROUP, member by member.
 *
 * The selection endpoint fans out to the whole group, and the members routinely
 * held DIFFERENT values before (grouping does not unify codings), so re-selecting
 * the pressed segment's previous value — the one-target undo — gave every member
 * that value. Each member gets its OWN back through the bulk door, which acts on
 * exactly the segment it is given: re-applying the old value swaps the chosen one
 * off (the server's #1028 rule), and a member that held none has the chosen value
 * removed. Ratings go back afterwards; the rating door fans out across the group
 * by design, so members rated differently come back holding the last one restored.
 */
async function undoGroupChoice(
  restores: readonly MemberRestore[],
  chosen: number | null,
  nameOf: (codeId: number) => string,
): Promise<void> {
  for (const r of restores) {
    if (r.previous !== null) await codingApi.bulkCode([r.segmentId], r.previous, 'apply')
    else if (chosen !== null) await codingApi.bulkCode([r.segmentId], chosen, 'remove')
  }
  const refused: { codeId: number; error: unknown }[] = []
  for (const r of restores) {
    // `!== null`, never truthiness: 0 is a rating.
    if (r.previous === null || r.rating === null) continue
    try {
      await codingApi.setMagnitude(r.segmentId, r.previous, r.rating)
    } catch (e) {
      if (!isServerRefusal(e)) throw e
      refused.push({ codeId: r.previous, error: e })
    }
  }
  if (refused.length > 0) {
    toast.warning(
      refused.length === 1
        ? `“${nameOf(refused[0].codeId)}” is back, but its rating could not be restored.`
        : `The previous values are back, but ${refused.length} of their ratings could not be restored.`,
      { description: serverDetailMessage(refused[0].error) ?? undefined },
    )
  }
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
  codes,
  history,
  onSettled,
  groupSiblings,
}: {
  projectId: number
  /** Null when nothing is selected — the strip then renders nothing. */
  target: CodeSetTarget | null
  appliedCodeDetails: readonly SelectionDetail[] | undefined
  activeCoderId: number | null
  /**
   * 🔴 The host's UNFILTERED live codes list (#1038 b). Each value's name and
   * active state are read from it, because every code edit refreshes it and
   * only the sets panel refreshes the sets query — a value renamed or
   * deactivated elsewhere was offered under its old name, or refused by the
   * server, for up to a minute. REQUIRED, so a new mount has to supply it.
   */
  codes: readonly (Pick<Code, 'id'> & LiveCode)[]
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
  /**
   * 🔴 #1070 — the OTHER visible members of the target's segment GROUP, with
   * their codings. A choice on a grouped segment fans out to the whole group,
   * whose members can hold different values; with these the undo gives each one
   * back its own. Only the conversation workbench groups segments, so only it
   * passes them — a surface that ever groups targets must, or its undo reverts
   * every member to the pressed one's value.
   */
  groupSiblings?: readonly GroupMember[]
}) {
  const qc = useQueryClient()
  const setsQuery = useCodeSets(projectId)
  const liveCodes = useMemo(() => new Map(codes.map((c) => [c.id, c])), [codes])

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
  const sets = (setsQuery.data?.sets ?? [])
    .map((s) => withLiveMembers(s, liveCodes))
    .filter((s) => choosableValues(s).length > 0)
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
          // 🔴 Null when the press changes nothing: a RADIO has no de-select
          // gesture, so pressing the checked value is a no-op (#1038 e) — it
          // used to clear, and in a contradiction it wiped both values while the
          // undo restored one. Clearing is the named control's act (`null`).
          const plan = selectionPlan(set, appliedCodeDetails, activeCoderId, codeId)
          if (!plan) return
          // 🔴 Captured NOW, with the target and the refresh: the swap deletes
          // the previous value's application, and its rating with it, so an undo
          // that re-selects the value must also re-rate it (#868 (f)'s rule for
          // a removal, reached through this door).
          const previousRating = heldRating(appliedCodeDetails, activeCoderId, plan.previousCodeId)
          const isMember = (id: number | null) => id === null || set.members.some((m) => m.id === id)
          const write = (value: number | null, magnitude: number | null) =>
            mutation.mutateAsync({
              target: actTarget, setId: set.id, codeId: value, magnitude,
              synonym: !isMember(value), refresh: onSettled,
            })

          if (!history) {
            write(plan.codeId, null).catch((error) => {
              // The client shows the SERVER's reason and never invents one (#871).
              toast.error(serverDetailMessage(error) ?? 'Could not record that choice.')
            })
            return
          }
          const nameOf = (id: number) =>
            liveCodes.get(id)?.name ?? set.members.find((m) => m.id === id)?.name ?? 'The value'
          if (actTarget.kind === 'segment' && groupSiblings && groupSiblings.length > 0) {
            // 🔴 #1070 — captured NOW, per member of the group the act fans out
            // to: what each held before, and its rating there.
            const members: GroupMember[] = [
              { segmentId: actTarget.segmentId, appliedCodeDetails },
              ...groupSiblings,
            ]
            const restores: MemberRestore[] = members.flatMap((m) => {
              const own = selectionPlan(set, m.appliedCodeDetails, activeCoderId, codeId)
              if (!own) return []  // this member already held the choice: unchanged
              return [{
                segmentId: m.segmentId,
                previous: own.previousCodeId,
                rating: heldRating(m.appliedCodeDetails, activeCoderId, own.previousCodeId),
              }]
            })
            const refresh = onSettled
            void history.execute({
              type: 'code_apply',
              description: describe(set, plan),
              redo: async () => { await write(plan.codeId, null) },
              undo: async () => {
                let saved = false
                try {
                  await undoGroupChoice(restores, plan.codeId, nameOf)
                  saved = true
                } finally {
                  invalidateDerivedCounts(qc, projectId)
                  refresh?.(saved)
                }
              },
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
