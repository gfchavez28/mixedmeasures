/**
 * The Writing canvas's horizontal containment (joint display session C, D176.4) — a SOURCE pin,
 * because jsdom computes no layout. Both halves were found by driving, and each alone is wrong:
 *
 * - a section's collapse wrapper clips only VERTICALLY (`overflow-y-clip`), or a joint display's
 *   Report view is cut back to the 740px column it widens past; and it keeps `min-w-0`, because a
 *   grid item that is not a scroll container takes its content's min-content width as its minimum
 *   (a wide table stretched the whole column to 1,475px when it was missing);
 * - the scroll area clips the x axis (`overflow-x-hidden`) — the canvas's one horizontal
 *   containment once the sections stopped — or an embed's `sr-only` span that resolves against the
 *   embed (#1156's class) scrolls the canvas sideways at 640px with the outline open.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

const src = stripComments(readFileSync(join(__dirname, 'WritingCanvas.tsx'), 'utf8'))

describe('the Writing canvas clips sideways once, at its scroll area', () => {
  it('the scroll area: vertical scroll, horizontal clip, and the breakout’s marker', () => {
    expect(src).toMatch(/<div className="flex-1 overflow-y-auto overflow-x-hidden" data-canvas-scroll="">/)
  })

  it('a section’s collapse wrapper: vertical clip only, both minimums zeroed', () => {
    expect(src).toMatch(/<div className="overflow-x-visible overflow-y-clip min-h-0 min-w-0">/)
    expect(src).not.toMatch(/className="overflow-hidden min-h-0"/)
  })
})
