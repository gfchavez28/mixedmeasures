import type { CodeSet, CodeSetMember } from '@/lib/api'
import type { AppliedCodeDetailLike, CodeApplicationIdentity } from '@/lib/coding-progress'

/**
 * Code sets on the client — the ONE derivation, in the shape of
 * `lib/rating-targets.ts::ratableCodes` and for the same reason (#824: the chord
 * space and the panel must never disagree about what a key does).
 *
 * Four coding surfaces consume this — `CodePanel` (conversation, document,
 * observation) and `TextCodePanel` — and shipping the enforcement on three of
 * four leaves one able to create the contradictory two-values-at-once state the
 * α table then has to count. The #868/#879 lesson: *enumerate the doors by what
 * the ACT is, never by the list a rule already names.*
 *
 * ## What does NOT change
 *
 * - **The chord system.** `lib/codeShortcuts.ts` derives the chord space from
 *   categories-that-have-codes; a set is orthogonal to filing, so a member's
 *   chord is whatever its category gives it. What changes is what the keypress
 *   DOES, which is `handleCodeToggle`'s business.
 * - **`isCodeAppliedByActiveCoder` and the chip chokepoints.** A chosen value IS
 *   applied, so it renders as an ordinary chip. What must change is the PANEL,
 *   where the choice is made.
 */

/** `code_sets.SET_NONE` — the value "none of these". Never a code id. */
export const SET_NONE = -1

/** Set id → the set, and code id → the set it belongs to. Built once per render. */
export interface CodeSetIndex {
  byId: Map<number, CodeSet>
  bySetOfCode: Map<number, CodeSet>
}

export function buildCodeSetIndex(sets: readonly CodeSet[] | undefined): CodeSetIndex {
  const byId = new Map<number, CodeSet>()
  const bySetOfCode = new Map<number, CodeSet>()
  for (const set of sets ?? []) {
    byId.set(set.id, set)
    for (const member of set.members) bySetOfCode.set(member.id, set)
  }
  return { byId, bySetOfCode }
}

/** The set a code belongs to, or null. */
export function codeSetOf(index: CodeSetIndex, codeId: number): CodeSet | null {
  return index.bySetOfCode.get(codeId) ?? null
}

/**
 * The value THIS coder currently holds in `set` on this target, or null.
 *
 * ⚠️ **Scoped to the active coder**, like every per-coder read on these
 * surfaces: a colleague's chip is visible and is not this coder's selection, and
 * treating it as one would show the radio group pre-answered by somebody else.
 *
 * ⚠️ **Returns the FIRST match rather than asserting one.** Holding two values
 * at once is a real state (a merge, legacy data, a set built over existing
 * coding), and a derivation that threw on it would take the panel down on
 * exactly the unit that needs fixing. `multipleSelectionIn` is how a caller asks
 * whether that has happened.
 */
export function selectionIn(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
): number | null {
  const members = new Set(set.members.map((m) => m.id))
  for (const app of applications ?? []) {
    if (app.user_id !== activeCoderId) continue
    if (members.has(app.code_id)) return app.code_id
  }
  return null
}

/** Every value this coder holds in `set` — more than one is a contradiction. */
export function selectionsIn(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
): number[] {
  const members = new Set(set.members.map((m) => m.id))
  const out: number[] = []
  for (const app of applications ?? []) {
    if (app.user_id !== activeCoderId) continue
    if (members.has(app.code_id) && !out.includes(app.code_id)) out.push(app.code_id)
  }
  return out
}

/** True when this coder holds two or more values of one set on this target. */
export function multipleSelectionIn(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
): boolean {
  return selectionsIn(set, applications, activeCoderId).length > 1
}

/**
 * The values a coder may CHOOSE, in the set's own order.
 *
 * ⚠️ **Inactive values are filtered out, and that is a server refusal mirrored,
 * not a preference.** The selection endpoints 400 an inactive code, so offering
 * it is the #806 shape — a control the server will refuse. Membership itself is
 * untouched by deactivation: the historical record needs it, and a past round's
 * α would otherwise become uncomputable.
 */
export function choosableValues(set: CodeSet): CodeSetMember[] {
  return set.members.filter((m) => m.is_active && !m.is_universal)
}

/**
 * One application as the strip reads it — the identity plus its RATING, because
 * undoing a swap has to put back the rating the old value carried (#1023).
 *
 * ⚠️ `magnitude` is REQUIRED for #868 (a)'s reason: a host projection that drops
 * it must fail to compile, not restore every value unrated.
 */
export type SelectionDetail = Pick<AppliedCodeDetailLike, 'code_id' | 'user_id' | 'magnitude'>

/**
 * The rating THIS coder holds on `codeId` on this target, or null — unrated,
 * not held, or no code at all.
 *
 * ⚠️ `?? null`, never `|| null`: 0 is a legal rating on any scale that includes it.
 */
export function heldRating(
  applications: readonly SelectionDetail[] | undefined,
  activeCoderId: number | null,
  codeId: number | null,
): number | null {
  if (codeId === null) return null
  const own = applications?.find((a) => a.user_id === activeCoderId && a.code_id === codeId)
  return own?.magnitude ?? null
}

/** What a press on `nextCodeId` should do to `set`, as data rather than a call. */
export interface SelectionPlan {
  setId: number
  /** The value to select, or null to clear. */
  codeId: number | null
  /** What was selected before — the inverse a history entry undoes to. */
  previousCodeId: number | null
}

/**
 * 🔴 **Returns a PLAN, not a mutation.** `CodeSetStrip` builds ONE `useHistory`
 * entry from it: the entry's `redo` calls the selection endpoint, its `undo`
 * calls the SAME endpoint with `previousCodeId`.
 *
 * 🔴 **The plan names no TARGET, so the entry must capture one (#1023).** The
 * passage is whatever was selected at the moment of the act; by the time an
 * undo runs the researcher has usually moved on, and an entry that asks "which
 * passage?" then answers with the wrong one.
 *
 * One entry and one call each way, which also satisfies the no-reentrancy rule
 * for free — `useHistory` serialises actions, and an action's `redo`/`undo` must
 * never call back into `execute`/`undo`/`redo` because it would await the chain
 * it is a link of, and deadlock.
 *
 * ⚠️ **Pressing the value already selected CLEARS it**, mirroring the toggle
 * these panels already have for ordinary codes — and on an exhaustive set that
 * is legal, because a coder may un-decide. ⚠️ But a radio group has no de-select
 * gesture, and re-pressing a radio is a no-op in every assistive technology's
 * model, so the group must ALSO offer a real, named "clear" control; this
 * function only says what a press means.
 */
export function selectionPlan(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
  nextCodeId: number,
): SelectionPlan {
  const previousCodeId = selectionIn(set, applications, activeCoderId)
  return {
    setId: set.id,
    codeId: previousCodeId === nextCodeId ? null : nextCodeId,
    previousCodeId,
  }
}
