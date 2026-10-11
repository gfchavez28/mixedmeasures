/**
 * #1175 — the words a delete confirmation adds about what ELSE the delete removes.
 *
 * Pure functions over the server's plan; the dialogs that render them are
 * covered in `DeleteVariableDialog.test.tsx` / `DeleteDatasetDialog.test.tsx`.
 */
import { describe, it, expect } from 'vitest'
import type { RemovalPlan } from '@/lib/api'
import { listNames } from '@/lib/format'
import { describeRemovalPlan, removalPlanGate, removalPlanRefusal } from './removal-plan'

const plan = (over: Partial<RemovalPlan> = {}): RemovalPlan => ({
  saved_metrics_removed: [],
  tests_removed: 0,
  groups_recalculated: [],
  groups_removed: [],
  refusal: null,
  blocked_by: [],
  ...over,
})
const g = (id: number, name: string) => ({ id, name })

describe('listNames', () => {
  it('joins one, two and three names as a sentence does', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['A'])).toBe('A')
    expect(listNames(['A', 'B'])).toBe('A and B')
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C')
  })

  it('names the first three and counts the rest, so a long list cannot grow the dialog', () => {
    expect(listNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
    expect(listNames(['A', 'B', 'C', 'D'], 2)).toBe('A, B and 2 more')
  })
})

describe('describeRemovalPlan', () => {
  it('says NOTHING for an empty plan — no paragraph, not "nothing else"', () => {
    expect(describeRemovalPlan(plan())).toBeNull()
  })

  it('the example sentence: statistics named, tests counted, groups named', () => {
    expect(describeRemovalPlan(plan({
      saved_metrics_removed: ['Wellbeing score'],
      tests_removed: 2,
      groups_recalculated: [g(1, 'Wellbeing')],
      groups_removed: [g(2, 'Lonely')],
    }))).toBe(
      'Also removes 1 saved statistic (Wellbeing score) and 2 saved tests that use it. '
      + '1 variable group (Wellbeing) will be recalculated; 1 (Lonely) will be removed.',
    )
  })

  it('singular and plural, and the verb agrees with everything named', () => {
    expect(describeRemovalPlan(plan({ tests_removed: 1 })))
      .toBe('Also removes 1 saved test that uses it.')
    expect(describeRemovalPlan(plan({ tests_removed: 3 })))
      .toBe('Also removes 3 saved tests that use it.')
    expect(describeRemovalPlan(plan({ saved_metrics_removed: ['A', 'B'] })))
      .toBe('Also removes 2 saved statistics (A and B) that use it.')
    expect(describeRemovalPlan(plan({ saved_metrics_removed: ['A'], tests_removed: 1 })))
      .toBe('Also removes 1 saved statistic (A) and 1 saved test that use it.')
  })

  it('each group arm on its own', () => {
    expect(describeRemovalPlan(plan({ groups_recalculated: [g(1, 'A'), g(2, 'B')] })))
      .toBe('2 variable groups (A and B) will be recalculated.')
    expect(describeRemovalPlan(plan({ groups_removed: [g(3, 'C')] })))
      .toBe('1 variable group (C) will be removed.')
  })

  it('truncates a long list of names', () => {
    expect(describeRemovalPlan(plan({ saved_metrics_removed: ['A', 'B', 'C', 'D', 'E', 'F'] })))
      .toBe('Also removes 6 saved statistics (A, B, C and 3 more) that use it.')
  })

  it('is ONE string (#1067 c: sibling fragments lose their space in Chrome)', () => {
    const s = describeRemovalPlan(plan({ tests_removed: 1, groups_removed: [g(1, 'A')] }))
    expect(typeof s).toBe('string')
    expect(s).toBe('Also removes 1 saved test that uses it. 1 variable group (A) will be removed.')
  })
})

describe('removalPlanRefusal', () => {
  it('none for a plan the delete would carry out', () => {
    expect(removalPlanRefusal(plan({ tests_removed: 4 }))).toBeNull()
  })

  it('a computed dependent: names it, says what to do, and gives the button its reason', () => {
    expect(removalPlanRefusal(plan({ blocked_by: ['C'] }))).toEqual({
      message: "Can't delete: the computed variable C uses it. Delete or edit C first.",
      reason: 'unavailable: the computed variable C uses it',
    })
    expect(removalPlanRefusal(plan({ blocked_by: ['C', 'D'] }))?.message)
      .toBe("Can't delete: the computed variables C and D use it. Delete or edit them first.")
  })

  it("the server's refusal is shown as written, never reworded", () => {
    const refusal = "Cannot complete this operation: it would leave the analysis domain 'W' unpaired."
    expect(removalPlanRefusal(plan({ refusal }))).toEqual({ message: refusal, reason: `unavailable: ${refusal}` })
  })
})

describe('removalPlanGate — decided on the LOAD status (#961)', () => {
  const full = plan({ tests_removed: 1 })

  it('loading: no sentence, and the confirm WAITS', () => {
    expect(removalPlanGate('loading', undefined)).toEqual({ sentence: null, blockedReason: null, waiting: true })
  })

  it('failed: no sentence, and the confirm PROCEEDS — a failed read does not hold the delete', () => {
    expect(removalPlanGate('failed', undefined)).toEqual({ sentence: null, blockedReason: null, waiting: false })
  })

  it('ready: the consequences (POSITIVE CONTROL)', () => {
    expect(removalPlanGate('ready', full))
      .toEqual({ sentence: 'Also removes 1 saved test that uses it.', blockedReason: null, waiting: false })
  })

  it('ready and refused: the refusal REPLACES the consequences, and blocks', () => {
    const gate = removalPlanGate('ready', plan({ tests_removed: 1, blocked_by: ['C'] }))
    expect(gate.sentence).toMatch(/^Can't delete/)
    expect(gate.blockedReason).toBe('unavailable: the computed variable C uses it')
  })
})
