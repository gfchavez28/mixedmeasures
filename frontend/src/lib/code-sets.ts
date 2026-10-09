import type { Code, CodeSet, CodeSetMember } from '@/lib/api'
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
 *   DOES — and since #1028 that is the SERVER's business (see below), not
 *   `handleCodeToggle`'s.
 * - **`isCodeAppliedByActiveCoder` and the chip chokepoints.** A chosen value IS
 *   applied, so it renders as an ordinary chip. What must change is the PANEL,
 *   where the choice is made.
 *
 * ## What a keypress on a value does (#1028)
 *
 * The SERVER decides it: applying any claimant of a set through any door
 * removes this coder's other claimants of that set, and the response says which
 * (`replaced_code_ids`). The surfaces therefore do not re-derive the swap; they
 * undo it from the server's report (`lib/apply-undo.ts`). What this module
 * answers is what a passage HOLDS — for the set's own control, and for the
 * multi-code apply, which must refuse two values of one set.
 */

/** `code_sets.SET_NONE` — the value "none of these". Never a code id. */
export const SET_NONE = -1

/** Set id → the set, and code id → the set an apply of it is a choice in. */
export interface CodeSetIndex {
  byId: Map<number, CodeSet>
  bySetOfCode: Map<number, CodeSet>
}

/**
 * ⚠️ **Indexed by CLAIMANT, never by membership** — a code grouped into a value
 * counts as that value (#1028 b), and a MEMBER grouped with a code outside its set
 * counts there, not in its own set (#1081 b): the server's claimant list says
 * which, and a code claims at most one set. This mirrors
 * `CodeSetIndex.set_claimed_by`, the set an apply of the code swaps in. It used
 * to index members first, so a multi-code apply of such a member and its own
 * set's value was refused as a conflict the server would never have made, while
 * the one it WOULD make passed.
 */
export function buildCodeSetIndex(sets: readonly CodeSet[] | undefined): CodeSetIndex {
  const byId = new Map<number, CodeSet>()
  const bySetOfCode = new Map<number, CodeSet>()
  for (const set of sets ?? []) {
    byId.set(set.id, set)
    for (const claimant of set.claimants) bySetOfCode.set(claimant.code_id, set)
  }
  return { byId, bySetOfCode }
}

/** The set an apply of this code is a choice in, or null. */
export function codeSetOf(index: CodeSetIndex, codeId: number): CodeSet | null {
  return index.bySetOfCode.get(codeId) ?? null
}

/**
 * The VALUE a code reads as in `set` — the member it counts as — or undefined
 * when it does not count there. A member reads as itself unless it is grouped;
 * a synonym grouped into a member reads as that member.
 */
export function valueIn(set: CodeSet, codeId: number): number | undefined {
  return set.claimants.find((c) => c.code_id === codeId)?.value_id
}

/**
 * The member that stands for an application on the set's control: a member
 * stands for itself, a synonym for the value it reads as.
 */
function standsFor(set: CodeSet, codeId: number, value: number): number {
  return set.members.some((m) => m.id === codeId) ? codeId : value
}

/**
 * The value THIS coder currently holds in `set` on this target, as the MEMBER
 * that stands for it, or null.
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
 *
 * ⚠️ **A synonym counts (#1028 b).** A coder who applied "Pos" (grouped into
 * "Positive") has chosen "Positive" as far as every statistic is concerned, so
 * the control shows it checked rather than showing the passage unanswered.
 */
export function selectionIn(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
): number | null {
  return selectionsIn(set, applications, activeCoderId)[0] ?? null
}

/**
 * Every value this coder holds in `set` — more than one is a contradiction.
 * Distinct by VALUE: a member and a synonym of it are one value, which is how
 * the α reads them.
 */
export function selectionsIn(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
): number[] {
  const out: number[] = []
  const values = new Set<number>()
  for (const app of applications ?? []) {
    if (app.user_id !== activeCoderId) continue
    const value = valueIn(set, app.code_id)
    if (value === undefined || values.has(value)) continue
    values.add(value)
    out.push(standsFor(set, app.code_id, value))
  }
  return out
}

/**
 * The CODE this coder holds in `set` — the raw application, which may be a
 * synonym — or null. What an undo re-selects: the control shows "Positive"
 * for a held "Pos", and putting back "Positive" instead would be a different
 * coding.
 */
export function heldCodeIn(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
): number | null {
  for (const app of applications ?? []) {
    if (app.user_id === activeCoderId && valueIn(set, app.code_id) !== undefined) {
      return app.code_id
    }
  }
  return null
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
  return set.members.filter(
    (m) => m.is_active && !m.is_universal && countsInSet(set, m.id),
  )
}

/**
 * Whether choosing this member counts as a value of `set` — false for a member
 * grouped with a code OUTSIDE the set, which reads as that code (#1081 b). The
 * set's endpoint refuses such a member, so offering it is the #806 shape; the
 * set's composition warning says why it is missing.
 */
function countsInSet(set: CodeSet, codeId: number): boolean {
  return set.claimants.some((c) => c.code_id === codeId)
}

/** The fields of a live code the set's control reads. */
export type LiveCode = Pick<Code, 'name' | 'is_active' | 'is_universal'>

/**
 * The set with each member's name and state read from the LIVE codes list
 * (#1038 b).
 *
 * The sets query is invalidated only by the sets panel, so renaming,
 * deactivating, deleting or merging a value anywhere else left the control
 * offering the old one until its 60 s stale window ran out — and the server then
 * refused the inactive value loudly. Every surface that renders the control
 * already holds the codes list, which every code edit DOES refresh, so the
 * member's attributes come from there and no edit site has to remember the set.
 *
 * ⚠️ **Pass the UNFILTERED list.** A member absent from it is read as not
 * choosable — right for a deleted or merged-away code, wrong for one a search box
 * hid. ⚠️ Membership itself still comes from the set: a value stays a member
 * when it is deactivated (the historical record needs it), and a held value that
 * cannot be offered is still what the clear control clears.
 */
export function withLiveMembers(
  set: CodeSet,
  live: ReadonlyMap<number, LiveCode> | undefined,
): CodeSet {
  if (!live) return set
  return {
    ...set,
    members: set.members.map((m) => {
      const code = live.get(m.id)
      if (!code) return { ...m, is_active: false }
      return { ...m, name: code.name, is_active: code.is_active, is_universal: code.is_universal }
    }),
  }
}

/** Two or more codes of ONE set in a single multi-code apply. */
export interface SetConflict {
  set: CodeSet
  codeIds: number[]
}

/**
 * The sets a multi-code apply would give two values at once (#1028).
 *
 * ⚠️ **Refused, not resolved.** Each code goes out as its own request, the
 * server keeps whichever lands last, and nothing about the gesture says which
 * one the researcher meant — so it is asked instead of guessed.
 */
export function conflictingSetValues(index: CodeSetIndex, codeIds: readonly number[]): SetConflict[] {
  const bySet = new Map<number, SetConflict>()
  for (const codeId of codeIds) {
    const set = codeSetOf(index, codeId)
    if (!set) continue
    const entry = bySet.get(set.id) ?? { set, codeIds: [] }
    if (!entry.codeIds.includes(codeId)) entry.codeIds.push(codeId)
    bySet.set(set.id, entry)
  }
  return [...bySet.values()].filter((c) => c.codeIds.length > 1)
}

/**
 * What a code MERGE left behind in a set (#1081 a): passages where one coder now
 * holds two values. Counted by the server, which is the one that knows; said
 * here, never resolved — which value the coder meant is theirs to choose.
 */
export function describeMergeContradictions(count: number, setLabel: string | null): string {
  const set = setLabel ? `“${setLabel}”` : 'a code set'
  const where = count === 1 ? '1 passage this merge touched' : `${count} passages this merge touched`
  const them = count === 1 ? 'it' : 'them'
  return `In ${where}, one coder now holds two values of ${set}. Its agreement figures leave ${them} out until that coder chooses one value.`
}

/** The sentence for a refused multi-code apply, naming the set and its values. */
export function describeSetConflict(
  conflicts: readonly SetConflict[],
  nameOf: (codeId: number) => string,
): string {
  const [first] = conflicts
  const names = first.codeIds.map((id) => `“${nameOf(id)}”`)
  const list = names.length === 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list} are values of “${first.set.label}”, and a passage takes only one — apply one of them.`
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
 * 🔴 **Null when the press changes nothing — a RADIO has no de-select gesture
 * (#1038 e).** Pressing the value already checked used to CLEAR it, a toggle
 * copied from the code list; re-pressing a radio is a no-op in every assistive
 * technology's model, and in the contradiction state the press wiped BOTH
 * values while its undo restored one. Clearing is the named control's act
 * (`nextCodeId = null`). ⚠️ In a contradiction a press is NOT a no-op: choosing
 * one of the two held values is how the coder resolves it.
 *
 * ⚠️ `previousCodeId` is the RAW held code (`heldCodeIn`) — what the undo puts
 * back — not the member the control shows for it.
 */
export function selectionPlan(
  set: CodeSet,
  applications: readonly CodeApplicationIdentity[] | undefined,
  activeCoderId: number | null,
  nextCodeId: number | null,
): SelectionPlan | null {
  const held = selectionsIn(set, applications, activeCoderId)
  if (nextCodeId === null ? held.length === 0 : held.length === 1 && held[0] === nextCodeId) {
    return null
  }
  return {
    setId: set.id,
    codeId: nextCodeId,
    previousCodeId: heldCodeIn(set, applications, activeCoderId),
  }
}
