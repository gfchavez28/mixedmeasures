/**
 * #825 — "Jump to uncoded" moves the VIEWPORT, on all three workbenches.
 *
 * **What it looked like when it did not.** With 12 of 36 notes coded, clicking
 * *Jump to uncoded ⏭* in the Text Coding view advanced
 * `aria-activedescendant` to `text-1382`, left `scrollTop` at 0, rendered no
 * row with `aria-selected="true"`, and `document.getElementById('text-1382')`
 * returned **null** — react-virtuoso had never rendered it. The button looked
 * like it did nothing; it had moved the selection invisibly, and the next chord
 * applied a code to a record the researcher could not see (`code_applications`
 * id 224 on `dataset_value` 1382, a note the code was wrong for).
 *
 * The cause was a missing WIRE, not a missing scroll: `ByTextTable` owned the
 * Virtuoso ref privately and was not a `forwardRef`, so the handler — which
 * lives in the parent — had nothing it could call. The other two workbenches
 * hold their own ref and had always scrolled.
 *
 * **Why this is a scan.** The defect is virtualisation-shaped and jsdom gives
 * Virtuoso no viewport, so it mounts every row: a render test would find the
 * target present and pass under the bug. The property that can be checked
 * statically is the one that was missing — *this handler reaches a scroller* —
 * and it is checked across all three surfaces so the next one cannot ship
 * without it (`feedback_parity_by_enumeration`; the two working siblings are
 * what made the third's absence legible).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

/**
 * Every surface with a jump-to-uncoded affordance, and HOW its jump reaches a
 * scroller.
 *
 * ⚠️ **There are two legitimate mechanisms, and the first draft of this guard
 * knew only one — it reported the conversation workbench, which the live pass
 * had measured as CORRECT (30 jumps, `scrollTop` 90 → 1647).** That surface
 * scrolls through `TranscriptPanel`'s auto-scroll-on-selection effect, and its
 * handler says so in a comment. So the property is *the jump reaches a
 * scroller*, and each surface declares which way — a scan that encodes one
 * implementation indicts the other.
 */
const WORKBENCHES: { file: string; via: 'handler' | 'selection-effect'; scroller?: string }[] = [
  // Setting the selection is enough: TranscriptPanel scrolls to the last
  // selected segment on every selection change (guarded by `skipAutoScroll`
  // for mouse clicks).
  { file: 'pages/CodingWorkbench.tsx', via: 'selection-effect', scroller: 'components/TranscriptPanel.tsx' },
  { file: 'pages/DocumentCodingWorkbench.tsx', via: 'handler' },
  // ⚠️ ByTextTable has NO auto-scroll effect — arrow nav scrolls through
  // `useSegmentSelection`'s callback and nothing else did. That is exactly why
  // the jump needed a wire of its own (#825).
  { file: 'pages/TextCodingView.tsx', via: 'handler' },
]

/** The handler's body: from its declaration to the `useCallback` dep array. */
function jumpHandler(file: string): string {
  const src = readFileSync(join(SRC, file), 'utf8')
  const start = src.indexOf('const handleJumpToNextUncoded')
  if (start === -1) return ''
  const end = src.indexOf('\n  }, [', start)
  return end === -1 ? '' : src.slice(start, end)
}

describe('#825 — the jump affordance scrolls its list', () => {
  it('finds a real handler on every workbench', () => {
    // Self-check: an empty slice would make every assertion below vacuous, and
    // both anchors are ordinary source text that a refactor can move.
    for (const { file } of WORKBENCHES) {
      const body = jumpHandler(file)
      expect(body.length, `${file}: no handleJumpToNextUncoded body found`).toBeGreaterThan(200)
      // It really is the jump handler and not some other block: it advances the
      // selection, and it says so when there is nothing left to jump to.
      expect(body, `${file}: slice does not look like the jump handler`)
        .toMatch(/are coded'\)/)
    }
  })

  it('every one of them reaches a scroller', () => {
    const silent: string[] = []
    for (const { file, via, scroller } of WORKBENCHES) {
      if (via === 'handler') {
        if (!/scrollToIndex/.test(jumpHandler(file))) silent.push(file)
      } else {
        // The surface it delegates to must still auto-scroll on selection.
        const src = readFileSync(join(SRC, scroller!), 'utf8')
        const effect = /useEffect\([\s\S]{0,900}?scrollToIndex[\s\S]{0,400}?\}, \[selectedSegments\]\)/.test(src)
        if (!effect) silent.push(`${file} → ${scroller}`)
      }
    }
    expect(
      silent,
      'A jump that only changes selection, on a surface that does not scroll to ' +
        'the selection, moves the active descendant to a row react-virtuoso has ' +
        'not rendered — invisible to the eye, invalid ARIA for a screen reader, ' +
        'and the next chord codes it (#825).',
    ).toEqual([])
  })

  it('ByTextTable exposes the scroller the page needs', () => {
    // The wire itself. The handler above lives in TextCodingView; without this
    // handle its `scrollToIndex` call could not compile, but the assertion
    // states the contract rather than relying on that.
    const table = readFileSync(join(SRC, 'components/ByTextTable.tsx'), 'utf8')
    expect(table).toMatch(/useImperativeHandle\(\s*ref/)
    expect(table).toMatch(/scrollToIndex:/)
    expect(table).toMatch(/export default forwardRef\(ByTextTable\)/)
    const view = readFileSync(join(SRC, 'pages/TextCodingView.tsx'), 'utf8')
    expect(view, 'the page must hold the handle it calls').toMatch(/ref=\{byTextRef\}/)
  })
})
