/**
 * #1011 — the seven import wizards take ONE step-focus behaviour.
 *
 * Before `hooks/useStepFocus`, #935 fixed Merge and #1005 fixed Coding Import, one
 * wizard at a time, and four others kept dropping focus to <body> at every step
 * change while two took focus on arrival. A wizard with a private copy is how that
 * happened, so this is a POPULATION check: each must call the hook, attach its ref
 * to a focusable heading, and carry no hand-written step-focus effect.
 *
 * The behaviour itself is proven in `hooks/useStepFocus.test.tsx` (under
 * StrictMode) and live-driven; this file only pins that every wizard REACHES it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

const WIZARDS = [
  'DatasetImport', 'ConversationImport', 'DocumentImport', 'ObservationImport',
  'AppendImport', 'MergeProject', 'CodingImport',
]

describe('every import wizard moves focus the same way (#1011)', () => {
  it('scans the whole family', () => {
    expect(WIZARDS).toHaveLength(7)
  })

  for (const name of WIZARDS) {
    const src = stripComments(readFileSync(join(SRC_DIR, `pages/${name}.tsx`), 'utf8'), `${name}.tsx`)
    it(`${name} takes useStepFocus and hands its ref to a focusable heading`, () => {
      const call = src.match(/const (\w+) = useStepFocus\(/)
      expect(call, `${name} does not call useStepFocus`).not.toBeNull()
      const ref = call![1]
      expect(src).toMatch(new RegExp(`ref=\\{${ref}\\}\\s+tabIndex=\\{-1\\}`))
    })

    it(`${name} carries no private step-focus effect`, () => {
      // The shape each hand-written copy had: a ref focused inside an effect
      // keyed on the step, e.g. `useEffect(() => { headingRef.current?.focus() }, [step])`.
      expect(src).not.toMatch(/\w+Ref\.current\?\.focus\(\)[\s;]*\}?,?\s*\[step\]\)/)
    })
  }

  it('the private-effect pattern catches the shape it is written for', () => {
    // Falsifier: without it, a rotted regex would report every wizard clean.
    const bad = /\w+Ref\.current\?\.focus\(\)[\s;]*\}?,?\s*\[step\]\)/
    expect(bad.test('useEffect(() => { headingRef.current?.focus() }, [step])')).toBe(true)
    expect(bad.test('    stepHeadingRef.current?.focus()\n  }, [step])')).toBe(true)
    expect(bad.test('const ref = useStepFocus(step)')).toBe(false)
  })
})
