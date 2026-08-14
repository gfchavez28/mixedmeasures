import { describe, it, expect } from 'vitest'
import { jotAccessibleName } from './rail-labels'

/**
 * The scratchpad count must reach a screen reader.
 *
 * Both rail layouts render the amber count INSIDE the Jot control, and `aria-label`
 * replaces a control's entire subtree — so the number was visible to sighted users
 * and absent from the accessibility tree. This pins the fix, and it pins it as a
 * pure function rather than by mounting the rail, which would drag in the router,
 * React Query and four badge components to assert one string.
 */
describe('jotAccessibleName', () => {
  it('names the control on its own when nothing is waiting', () => {
    expect(jotAccessibleName(0)).toBe('Jot a thought')
    expect(jotAccessibleName(undefined)).toBe('Jot a thought')
  })

  it('carries the count when there is one', () => {
    expect(jotAccessibleName(3)).toBe('Jot a thought, 3 unsorted')
    expect(jotAccessibleName(1)).toBe('Jot a thought, 1 unsorted')
  })

  /**
   * #559's trap was a CONDITIONAL name that evaluated to `undefined` in an edge
   * state, leaving the control announced as a bare "button". This one branches too,
   * so the property worth pinning is that every branch still yields a name.
   */
  it('always yields a non-empty name that starts with the control’s own label', () => {
    for (const n of [undefined, 0, 1, 2, 99, 1000]) {
      const name = jotAccessibleName(n)
      expect(name.startsWith('Jot a thought')).toBe(true)
      expect(name.trim().length).toBeGreaterThan(0)
    }
  })

  /**
   * "unsorted" is the word ScratchpadPopover already shows for this same number
   * ("{n} unsorted"). If that copy changes, these must move together — a screen
   * reader hearing a different noun than the popover shows is the #503 class.
   */
  it('uses the app’s own noun for the count', () => {
    expect(jotAccessibleName(5)).toContain('unsorted')
  })
})
