import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

/**
 * Every header edit in the Variables view is undoable.
 *
 * 🔴 **Parity, and the reason it is guarded structurally.** The Data view has
 * run name / label / type edits through `useHistory` since it shipped; this view
 * ran the identical mutations with a bare invalidate, so a rename was undoable
 * on one screen and not on the other — while the Decision-E arc was busy moving
 * researchers to the one where it was not. The defect was not in any single
 * call; it was that nothing said the calls had to be wrapped.
 *
 * A source scan rather than a mount: this page is ~1,700 lines behind six
 * queries, so a component test would exercise the harness more than the rule,
 * and the rule is about which CALL SHAPE is allowed — exactly what a scan can
 * see and a render cannot.
 */

const SRC = join(__dirname, 'RecodeWorkbench.tsx')

describe('the Variables view records header edits in the undo stack', () => {
  const src = stripComments(readFileSync(SRC, 'utf8'))

  it('read a real file (the scan is not looking at nothing)', () => {
    // A scan whose walk resolves to nothing passes by finding nothing (#729).
    expect(src.length).toBeGreaterThan(10_000)
    expect(src).toContain('useHistory')
  })

  it('routes all three header fields through executeHistory', () => {
    for (const action of ['column_name_edit', 'column_text_edit', 'column_type_change']) {
      expect(src, `${action} must be recorded in the undo stack`).toContain(action)
    }
  })

  it('has no bare header mutation — the shape that skipped the stack', () => {
    // `.mutate(` fires and forgets; a history action needs `mutateAsync` so
    // undo can await the reversal. This is the exact call that was there before.
    expect(src).not.toMatch(/updateHeaderMutation\.mutate\(/)
  })

  it('has no fire-and-forget type change', () => {
    // `recodeApi.bulkTypeUpdate(...).then(...)` was the pre-parity shape: it
    // applied the change and left nothing to reverse.
    expect(src).not.toMatch(/bulkTypeUpdate\([^)]*\)\s*\.then\(/)
  })

  it('offers the controls, named for a screen reader', () => {
    // `title` describes, it does not NAME (#559) — an icon-only button needs
    // both, and these are icon-only.
    expect(src).toMatch(/aria-label="Undo"/)
    expect(src).toMatch(/aria-label="Redo"/)
  })
})
