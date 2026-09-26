import { describe, expect, it } from 'vitest'
import type { CodeSet, CodeSetMember } from '@/lib/api'
import type { CodeApplicationIdentity } from '@/lib/coding-progress'
import {
  buildCodeSetIndex,
  choosableValues,
  codeSetOf,
  multipleSelectionIn,
  selectionIn,
  selectionPlan,
  selectionsIn,
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
  created_at: '',
  updated_at: '',
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

  it('CLEARS when the value already selected is pressed again', () => {
    const plan = selectionPlan(STANCE, [app(11, 2)], 2, 11)
    expect(plan.codeId).toBeNull()
    expect(plan.previousCodeId).toBe(11)
  })

  it('carries a null previous value on a first choice, which is a legal undo', () => {
    // The inverse of "choose Positive" is "clear", not "choose nothing known".
    const plan = selectionPlan(STANCE, [], 2, 47)
    expect(plan).toEqual({ setId: 7, codeId: 47, previousCodeId: null })
  })

  it('does not read a colleague’s value as the one being replaced', () => {
    const plan = selectionPlan(STANCE, [app(47, 3)], 2, 11)
    expect(plan.previousCodeId).toBeNull()
  })
})
