import { describe, expect, it } from 'vitest'
import type { CodeSet, CodeSetMember } from '@/lib/api'
import type { CodeApplicationIdentity } from '@/lib/coding-progress'
import {
  buildCodeSetIndex,
  choosableValues,
  codeSetOf,
  conflictingSetValues,
  describeSetConflict,
  describeMergeContradictions,
  heldCodeIn,
  multipleSelectionIn,
  selectionIn,
  selectionPlan,
  selectionsIn,
  valueIn,
  withLiveMembers,
} from '@/lib/code-sets'

/**
 * ⚠️ Three values with NON-CONTIGUOUS ids, and the applications name several
 * coders. A two-value fixture cannot tell a set from the binary toggle it
 * replaces, and contiguous ids cannot reveal an implementation that indexes by
 * position rather than by id.
 */
const member = (id: number, name: string, over: Partial<CodeSetMember> = {}): CodeSetMember => ({
  id, numeric_id: id, name, description: null, color: null,
  is_active: true, is_universal: false, ...over,
})

const STANCE: CodeSet = {
  id: 7,
  project_id: 1,
  label: 'Stance',
  description: null,
  exhaustive: false,
  members: [member(11, 'Positive'), member(23, 'Negative'), member(47, 'Neutral')],
  set_basis: 'inclusive_with_none',
  composition_warnings: [],
  claimants: [
    { code_id: 11, value_id: 11 }, { code_id: 23, value_id: 23 }, { code_id: 47, value_id: 47 },
  ],
  created_at: '',
  updated_at: '',
}

/** "Pos" (id 90) is NOT a member, but is grouped into "Positive" (#1028 b). */
const WITH_SYNONYM: CodeSet = {
  ...STANCE,
  claimants: [...STANCE.claimants, { code_id: 90, value_id: 11 }],
}

const app = (codeId: number, userId: number | null): CodeApplicationIdentity =>
  ({ code_id: codeId, user_id: userId } as CodeApplicationIdentity)

describe('the index', () => {
  it('maps every member back to its set', () => {
    const index = buildCodeSetIndex([STANCE])
    expect(codeSetOf(index, 23)?.label).toBe('Stance')
    expect(codeSetOf(index, 999)).toBeNull()
  })

  it('is empty rather than undefined for a project with no sets', () => {
    const index = buildCodeSetIndex(undefined)
    expect(index.byId.size).toBe(0)
    expect(codeSetOf(index, 11)).toBeNull()
  })
})

describe('the active coder’s selection', () => {
  it('reads THIS coder’s value, never a colleague’s', () => {
    // ⚠️ The colleague's application is listed FIRST, so a derivation that
    // ignored `user_id` would return theirs and show the group pre-answered by
    // somebody else.
    const apps = [app(47, 3), app(11, 2)]
    expect(selectionIn(STANCE, apps, 2)).toBe(11)
    expect(selectionIn(STANCE, apps, 3)).toBe(47)
  })

  it('is null when this coder has chosen nothing', () => {
    expect(selectionIn(STANCE, [app(47, 3)], 2)).toBeNull()
    expect(selectionIn(STANCE, [], 2)).toBeNull()
    expect(selectionIn(STANCE, undefined, 2)).toBeNull()
  })

  it('ignores applications of codes outside the set', () => {
    expect(selectionIn(STANCE, [app(900, 2)], 2)).toBeNull()
  })

  it('does not treat an unattributed application as the active coder’s', () => {
    expect(selectionIn(STANCE, [app(11, null)], 2)).toBeNull()
  })
})

describe('the contradiction', () => {
  it('reports two values at once rather than silently picking one', () => {
    const apps = [app(11, 2), app(23, 2)]
    expect(selectionsIn(STANCE, apps, 2)).toEqual([11, 23])
    expect(multipleSelectionIn(STANCE, apps, 2)).toBe(true)
  })

  it('is not triggered by two COLLEAGUES holding different values', () => {
    // Two coders disagreeing is the ordinary case the whole feature measures.
    const apps = [app(11, 2), app(23, 3)]
    expect(multipleSelectionIn(STANCE, apps, 2)).toBe(false)
    expect(multipleSelectionIn(STANCE, apps, 3)).toBe(false)
  })
})

describe('what a coder may choose', () => {
  it('drops an inactive value, mirroring the server’s refusal', () => {
    const withArchived: CodeSet = {
      ...STANCE,
      members: [...STANCE.members, member(88, 'Mixed', { is_active: false })],
    }
    expect(choosableValues(withArchived).map((v) => v.id)).toEqual([11, 23, 47])
  })

  it('keeps the set’s own order', () => {
    expect(choosableValues(STANCE).map((v) => v.name)).toEqual([
      'Positive', 'Negative', 'Neutral',
    ])
  })
})

describe('the plan', () => {
  it('selects a new value and remembers the one it replaces', () => {
    const plan = selectionPlan(STANCE, [app(11, 2)], 2, 23)
    expect(plan).toEqual({ setId: 7, codeId: 23, previousCodeId: 11 })
  })

  it('is NOTHING when the checked value is pressed again — a radio has no de-select (#1038 e)', () => {
    expect(selectionPlan(STANCE, [app(11, 2)], 2, 11)).toBeNull()
  })

  it('is a CHOICE when that value is one of two held — the coder resolving a contradiction', () => {
    // The #1038 (e) defect's own state: the re-press used to CLEAR both values
    // here, and the undo gave one back.
    const plan = selectionPlan(STANCE, [app(11, 2), app(23, 2)], 2, 11)
    expect(plan).toEqual({ setId: 7, codeId: 11, previousCodeId: 11 })
  })

  it('clears through the named control, and clearing nothing is nothing', () => {
    expect(selectionPlan(STANCE, [app(23, 2)], 2, null))
      .toEqual({ setId: 7, codeId: null, previousCodeId: 23 })
    expect(selectionPlan(STANCE, [], 2, null)).toBeNull()
  })

  it('carries a null previous value on a first choice, which is a legal undo', () => {
    // The inverse of "choose Positive" is "clear", not "choose nothing known".
    const plan = selectionPlan(STANCE, [], 2, 47)
    expect(plan).toEqual({ setId: 7, codeId: 47, previousCodeId: null })
  })

  it('does not read a colleague’s value as the one being replaced', () => {
    const plan = selectionPlan(STANCE, [app(47, 3)], 2, 11)
    expect(plan?.previousCodeId).toBeNull()
  })

  it('remembers the RAW code held, so an undo puts back the synonym and not its value', () => {
    const plan = selectionPlan(WITH_SYNONYM, [app(90, 2)], 2, 23)
    expect(plan?.previousCodeId).toBe(90)
  })
})

describe('a synonym grouped INTO a value (#1028 b)', () => {
  it('reads as that value', () => {
    expect(valueIn(WITH_SYNONYM, 90)).toBe(11)
    expect(valueIn(WITH_SYNONYM, 900)).toBeUndefined()
  })

  it('shows its value as the coder’s selection, and holding both is ONE value', () => {
    expect(selectionIn(WITH_SYNONYM, [app(90, 2)], 2)).toBe(11)
    expect(heldCodeIn(WITH_SYNONYM, [app(90, 2)], 2)).toBe(90)
    expect(multipleSelectionIn(WITH_SYNONYM, [app(90, 2), app(11, 2)], 2)).toBe(false)
    expect(multipleSelectionIn(WITH_SYNONYM, [app(90, 2), app(23, 2)], 2)).toBe(true)
  })

  it('pressing its value is a no-op, as for the value itself', () => {
    expect(selectionPlan(WITH_SYNONYM, [app(90, 2)], 2, 11)).toBeNull()
  })

  it('a member grouped into ANOTHER set’s value counts THERE, and its own set does not offer it (#1081 b)', () => {
    // 90 is a MEMBER of Tone grouped into Stance's "Positive". It reads as
    // Positive, so the server lists it as a claimant of Stance and NOT of Tone.
    // The index used to map members first, so it answered Tone — where the code
    // counts as nothing — and the multi-code check refused the wrong pair.
    const TONE: CodeSet = {
      ...STANCE, id: 8, label: 'Tone', members: [member(90, 'Warm'), member(91, 'Cold')],
      claimants: [{ code_id: 91, value_id: 91 }],
    }
    for (const sets of [[WITH_SYNONYM, TONE], [TONE, WITH_SYNONYM]]) {
      expect(codeSetOf(buildCodeSetIndex(sets), 90)?.label).toBe('Stance')
    }
    const index = buildCodeSetIndex([TONE, WITH_SYNONYM])
    expect(conflictingSetValues(index, [90, 91])).toEqual([])        // two sets
    expect(conflictingSetValues(index, [90, 23])).toHaveLength(1)    // one set, two values
    // Its own set's control does not offer it: the server refuses it there.
    expect(choosableValues(TONE).map((v) => v.id)).toEqual([91])
  })
})

describe('what a code merge left behind (#1081 a)', () => {
  it('names the set, the count and what the agreement figures do with it', () => {
    expect(describeMergeContradictions(3, 'Stance')).toBe(
      'In 3 passages this merge touched, one coder now holds two values of “Stance”. '
      + 'Its agreement figures leave them out until that coder chooses one value.',
    )
    expect(describeMergeContradictions(1, 'Stance')).toMatch(/^In 1 passage this merge touched,.* leave it out/)
    expect(describeMergeContradictions(2, null)).toContain('two values of a code set')
  })
})

describe('live members (#1038 b)', () => {
  const live = (over: Record<number, Partial<{ name: string; is_active: boolean; is_universal: boolean }>>) =>
    new Map(STANCE.members.map((m) => [m.id, {
      name: m.name, is_active: true, is_universal: false, ...(over[m.id] ?? {}),
    }]))

  it('reads a renamed or deactivated value from the codes list, not the stale set', () => {
    const fresh = withLiveMembers(STANCE, live({ 11: { name: 'Favourable' }, 23: { is_active: false } }))
    expect(choosableValues(fresh).map((v) => v.name)).toEqual(['Favourable', 'Neutral'])
  })

  it('offers no value the codes list no longer has — deleted or merged away', () => {
    const map = live({})
    map.delete(47)
    expect(choosableValues(withLiveMembers(STANCE, map)).map((v) => v.id)).toEqual([11, 23])
  })

  it('keeps a deactivated value a MEMBER, so a coder holding it can still clear it', () => {
    const fresh = withLiveMembers(STANCE, live({ 23: { is_active: false } }))
    expect(fresh.members.map((m) => m.id)).toEqual([11, 23, 47])
    expect(selectionIn(fresh, [app(23, 2)], 2)).toBe(23)
  })
})

describe('a multi-code apply of two values of one set (#1028)', () => {
  it('is found, and names the set and both values', () => {
    const index = buildCodeSetIndex([WITH_SYNONYM])
    const conflicts = conflictingSetValues(index, [11, 500, 23])
    expect(conflicts.map((c) => c.codeIds)).toEqual([[11, 23]])
    const names: Record<number, string> = { 11: 'Positive', 23: 'Negative' }
    expect(describeSetConflict(conflicts, (id) => names[id]))
      .toBe('“Positive” and “Negative” are values of “Stance”, and a passage takes only one — apply one of them.')
  })

  it('counts a synonym as its set’s value', () => {
    expect(conflictingSetValues(buildCodeSetIndex([WITH_SYNONYM]), [90, 23])).toHaveLength(1)
  })

  it('lets one value per set through, and ordinary codes', () => {
    expect(conflictingSetValues(buildCodeSetIndex([WITH_SYNONYM]), [11, 500, 501])).toEqual([])
  })
})
