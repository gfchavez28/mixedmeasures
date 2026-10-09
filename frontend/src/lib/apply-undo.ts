import { toast } from 'sonner'
import { codingApi, isServerRefusal, serverDetailMessage, textCodingApi } from '@/lib/api'
import type { SelectionDetail } from '@/lib/code-sets'

/**
 * Undoing an APPLY — the inverse is not "remove the code" (#1028).
 *
 * Applying a code can do two things the plain inverse did not see:
 *
 * 1. **REPLACE another code.** Applying a value of a code set removes this
 *    coder's other value of that set on the same passage — at every door, since
 *    #1028 made the rule the server's. The response names what went
 *    (`replaced_code_ids`), and the undo must put exactly that back. Removing
 *    the new value alone would leave the passage with NO value: on an exhaustive
 *    set, the state the interface says is impossible, produced by Ctrl+Z.
 * 2. **Land on a passage that already had it.** A multi-passage apply reaches
 *    every selected passage; the undo used to remove the code from ALL of them,
 *    including a passage that held it before the act — a coding the researcher
 *    made earlier, destroyed by undoing something else.
 *
 * So an apply entry CAPTURES, when it is built, which targets already held the
 * code and this coder's ratings there (`captureApply`), records what the server
 * replaced each time it runs (`replacedFrom*`), and undoes from the pair
 * (`planApplyUndo` → `runApplyUndo`). The four coding surfaces differ only in
 * the API adapter and in how they paint; the decision is made once, here.
 *
 * 🔴 **The restore re-applies the replaced code, which removes the new one in
 * the same request** — the server's swap is atomic, so a failure cannot leave
 * the passage empty between two calls. The rating goes back as a SECOND call, so
 * a scale changed in the meantime refuses only the rating: the value is back and
 * the coder is told which half did not land (#1023's rule for the strip).
 *
 * ⚠️ **Residual, stated: a passage that held TWO values of one set gets one
 * back.** No apply door creates a contradiction any more, which is the point.
 * Of the four other routes #1081 found, three are closed: a member grouped into
 * another set's value (the claimant list), an undo after the set changed (below,
 * `runApplyUndo`), and a code merge, which still makes one but SAYS so. Two
 * applies landing at once can still make one (#1081 d).
 * Where the coder already held the applied value beside another (a merge's
 * contradiction, resolved by the act), the undo leaves the value they re-affirmed.
 */

/** What an apply entry knows about its targets when it is BUILT. */
export interface ApplyCapture {
  codeId: number
  targets: readonly number[]
  /** Targets on which this coder already held `codeId` before the act. */
  alreadyHeld: ReadonlySet<number>
  /**
   * This coder's rating on every code they held, per target — what a replaced
   * code is re-rated with. `null` is unrated; `0` is a rating.
   */
  ratings: ReadonlyMap<number, ReadonlyMap<number, number | null>>
}

export function captureApply(
  codeId: number,
  targets: readonly number[],
  detailsFor: (targetId: number) => readonly SelectionDetail[] | undefined,
  activeCoderId: number | null,
): ApplyCapture {
  const alreadyHeld = new Set<number>()
  const ratings = new Map<number, Map<number, number | null>>()
  for (const target of targets) {
    const mine = new Map<number, number | null>()
    for (const d of detailsFor(target) ?? []) {
      if (d.user_id !== activeCoderId) continue
      // `?? null`, never `|| null`: a stored 0 is a rating.
      mine.set(d.code_id, d.magnitude ?? null)
    }
    if (mine.has(codeId)) alreadyHeld.add(target)
    ratings.set(target, mine)
  }
  return { codeId, targets: [...targets], alreadyHeld, ratings }
}

/** target → the codes the server replaced there. Absent = nothing replaced. */
export type Replaced = ReadonlyMap<number, readonly number[]>

/**
 * From a single apply's response.
 *
 * 🔴 **Per SEGMENT when the server says so (#1070).** A single apply fans out to
 * a segment group, and a group's siblings routinely hold different codings —
 * grouping does not unify them — so they lose different values. This used to
 * pin the merged list on the pressed segment, and the undo put back a value on
 * a sibling that never had it. `replaced_by_target` names each segment's own;
 * the merged list is the fallback for a target with no group (the text door).
 */
export function replacedFromSingle(
  targetId: number,
  response: {
    replaced_code_ids?: readonly number[]
    replaced_by_target?: readonly { segment_id: number; replaced_code_ids: readonly number[] }[]
  } | null | undefined,
): Replaced {
  if (response?.replaced_by_target) {
    const out = new Map<number, number[]>()
    for (const row of response.replaced_by_target) {
      if (row.replaced_code_ids.length > 0) out.set(row.segment_id, [...row.replaced_code_ids])
    }
    return out
  }
  const ids = response?.replaced_code_ids ?? []
  return ids.length > 0 ? new Map([[targetId, [...ids]]]) : new Map()
}

/** From a bulk apply's per-target results, for either target kind. */
export function replacedFromBulk(
  response: {
    results?: readonly {
      segment_id?: number | null
      dataset_value_id?: number | null
      replaced_code_ids?: readonly number[]
    }[]
  } | null | undefined,
): Replaced {
  const out = new Map<number, number[]>()
  for (const row of response?.results ?? []) {
    const target = row.segment_id ?? row.dataset_value_id
    if (target == null || !row.replaced_code_ids?.length) continue
    out.set(target, [...row.replaced_code_ids])
  }
  return out
}

/** Fold several responses' reports (the multi-code apply sends one per code). */
export function mergeReplaced(parts: readonly Replaced[]): Replaced {
  const out = new Map<number, number[]>()
  for (const part of parts) {
    for (const [target, ids] of part) out.set(target, [...(out.get(target) ?? []), ...ids])
  }
  return out
}

export interface ApplyUndoPlan {
  codeId: number
  /** Targets the apply put the code on and replaced nothing — remove it there. */
  removeFrom: number[]
  /** A replaced code to put back; re-applying it removes `codeId` atomically. */
  restore: { targetId: number; codeId: number; magnitude: number | null }[]
}

export function planApplyUndo(capture: ApplyCapture, replaced: Replaced): ApplyUndoPlan {
  const removeFrom: number[] = []
  const restore: ApplyUndoPlan['restore'] = []
  for (const target of capture.targets) {
    const lost = replaced.get(target) ?? []
    if (capture.alreadyHeld.has(target)) continue
    if (lost.length > 0) {
      // A contradiction gives ONE value back (see the module note).
      const codeId = lost[0]
      restore.push({ targetId: target, codeId, magnitude: capture.ratings.get(target)?.get(codeId) ?? null })
    } else {
      removeFrom.push(target)
    }
  }
  return { codeId: capture.codeId, removeFrom, restore }
}

/**
 * The calls an undo makes, per target kind. `single` means the inverse may go
 * through the one-target door, which FANS OUT to a segment group; the bulk door
 * acts on exactly the targets it is given.
 *
 * 🔴 **An inverse that fans out must capture what it fans out over (#1070).**
 * This flag used to follow the act's SHAPE — a single apply was undone through
 * the single door — which is exact only when the group's siblings held the same
 * codes. They routinely do not, so the conversation workbench now captures a
 * single act over the group's visible siblings and undoes it through the BULK
 * door, sibling by sibling (`single` = false). `single` stays for an ungrouped
 * target, where the two doors do the same thing.
 */
export interface ApplyUndoApi {
  remove(targetIds: number[], codeId: number): Promise<unknown>
  /**
   * Apply unrated — the server's swap removes the value being undone — and
   * return what it REPORTS it replaced, per target (#1081 c).
   */
  reapply(targetIds: number[], codeId: number): Promise<Replaced>
  rate(targetId: number, codeId: number, magnitude: number): Promise<unknown>
}

/** The segment surfaces' calls (conversation, document, observation). */
export function segmentUndoApi(single: boolean): ApplyUndoApi {
  return {
    remove: (ids, codeId) =>
      single ? codingApi.removeCode(ids[0], codeId) : codingApi.bulkCode(ids, codeId, 'remove'),
    reapply: async (ids, codeId) => single
      ? replacedFromSingle(ids[0], await codingApi.applyCode(ids[0], codeId))
      : replacedFromBulk(await codingApi.bulkCode(ids, codeId, 'apply')),
    rate: (id, codeId, magnitude) => codingApi.setMagnitude(id, codeId, magnitude),
  }
}

/** The Text Coding view's calls, body-keyed on the response. */
export function textUndoApi(projectId: number, single: boolean): ApplyUndoApi {
  return {
    remove: (ids, codeId) => single
      ? textCodingApi.removeCode(projectId, { dataset_value_id: ids[0], code_id: codeId })
      : textCodingApi.bulkRemoveCode(projectId, { dataset_value_ids: ids, code_id: codeId }),
    reapply: async (ids, codeId) => single
      ? replacedFromSingle(
        ids[0], await textCodingApi.applyCode(projectId, { dataset_value_id: ids[0], code_id: codeId }),
      )
      : replacedFromBulk(
        await textCodingApi.bulkCode(projectId, { dataset_value_ids: ids, code_id: codeId }),
      ),
    rate: (id, codeId, magnitude) =>
      textCodingApi.setMagnitude(projectId, { dataset_value_id: id, code_id: codeId, magnitude }),
  }
}

/**
 * Run the plan. A transient failure THROWS, so `useHistory` keeps the step for a
 * retry (re-applying and removing are both idempotent). A REFUSED rating does
 * not: the value is back, and the coder is told the rating is not.
 *
 * 🔴 **The restore re-applies the replaced code AND CHECKS THE SERVER'S REPORT
 * (#1081 c).** The swap removes the undone value only while the two are still
 * values of one set. If the set was deleted, or the replaced value left it,
 * between the act and the undo, the re-apply swaps nothing out and the passage
 * held BOTH — while the conversation page painted the plan and showed one. Where
 * the report does not name the undone value, it is removed explicitly, after the
 * value is back (never before: an exhaustive set must not pass through empty).
 */
export async function runApplyUndo(
  plan: ApplyUndoPlan,
  api: ApplyUndoApi,
  nameOf: (codeId: number) => string,
): Promise<void> {
  const byCode = new Map<number, number[]>()
  for (const r of plan.restore) byCode.set(r.codeId, [...(byCode.get(r.codeId) ?? []), r.targetId])
  const leftBehind: number[] = []
  for (const [codeId, targets] of byCode) {
    const replaced = await api.reapply(targets, codeId)
    for (const target of targets) {
      if (!(replaced.get(target) ?? []).includes(plan.codeId)) leftBehind.push(target)
    }
  }
  const removeFrom = [...plan.removeFrom, ...leftBehind]
  if (removeFrom.length > 0) await api.remove(removeFrom, plan.codeId)
  await restoreRatings(plan.restore, api, nameOf, 'The replaced values are back')
}

/**
 * Put ratings back, one call each, after the codes are back. A rating REFUSED by
 * the server (the scale changed since) finishes the undo with a warning; a
 * transient failure throws so the step stays.
 */
async function restoreRatings(
  entries: readonly { targetId: number; codeId: number; magnitude: number | null }[],
  api: ApplyUndoApi,
  nameOf: (codeId: number) => string,
  manyLead: string,
): Promise<void> {
  const refused: { codeId: number; magnitude: number; error: unknown }[] = []
  for (const r of entries) {
    // `!== null`, never truthiness: 0 is a rating.
    if (r.magnitude === null) continue
    try {
      await api.rate(r.targetId, r.codeId, r.magnitude)
    } catch (e) {
      if (!isServerRefusal(e)) throw e
      refused.push({ codeId: r.codeId, magnitude: r.magnitude, error: e })
    }
  }
  if (refused.length > 0) {
    const first = refused[0]
    toast.warning(
      refused.length === 1
        ? `“${nameOf(first.codeId)}” is back, but its rating (${first.magnitude}) could not be restored.`
        : `${manyLead}, but ${refused.length} of their ratings could not be restored.`,
      { description: serverDetailMessage(first.error) ?? undefined },
    )
  }
}

/**
 * Undoing a REMOVE that fanned out to a segment group (#1070).
 *
 * The single remove door removes this coder's code from every visible sibling,
 * and its old inverse — the single APPLY door, carrying the pressed segment's
 * rating — fanned out again: a sibling that never held the code gained it, and a
 * sibling rated differently took the pressed one's rating. So the entry captures,
 * when it is BUILT, which siblings held the code and each one's rating, and the
 * inverse re-applies to exactly those through the bulk door.
 *
 * ⚠️ **Ratings go back through the rating door, which fans out across the group
 * by design** ("a group is rated as one unit", `magnitude-coding.md` §7). Siblings
 * that held DIFFERENT ratings — possible only for codings made before the
 * segments were grouped — come back holding the last one restored. Stated, not
 * papered over: there is no door that rates one member of a group.
 */
export interface RemoveCapture {
  codeId: number
  /** The siblings on which this coder held the code, and their ratings. */
  held: { targetId: number; magnitude: number | null }[]
}

export function captureRemove(
  codeId: number,
  targets: readonly number[],
  detailsFor: (targetId: number) => readonly SelectionDetail[] | undefined,
  activeCoderId: number | null,
): RemoveCapture {
  const held: RemoveCapture['held'] = []
  for (const target of targets) {
    const mine = (detailsFor(target) ?? []).find(
      (d) => d.user_id === activeCoderId && d.code_id === codeId,
    )
    // `?? null`, never `|| null`: a stored 0 is a rating.
    if (mine) held.push({ targetId: target, magnitude: mine.magnitude ?? null })
  }
  return { codeId, held }
}

export async function runRemoveUndo(
  capture: RemoveCapture,
  api: ApplyUndoApi,
  nameOf: (codeId: number) => string,
): Promise<void> {
  if (capture.held.length === 0) return
  await api.reapply(capture.held.map((h) => h.targetId), capture.codeId)
  await restoreRatings(
    capture.held.map((h) => ({ targetId: h.targetId, codeId: capture.codeId, magnitude: h.magnitude })),
    api, nameOf, 'The code is back',
  )
}
