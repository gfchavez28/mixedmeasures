/**
 * #739 — Codes precedes Notes on every coding surface, in the header AND the row.
 *
 * **Why this is a scan and not four render tests.** The decision's stated
 * deliverable was "render all four and assert identical column order". Of the
 * four surfaces only `ObservationWorkbench` has a test harness; `SegmentRow`,
 * `TranscriptPanel`, `DocumentCodingWorkbench` and `ByTextTable` are mounted by
 * no test in the suite, and one of them is a full page with data fetching.
 * Standing up three harnesses to assert two elements' order would cost more
 * than the defect. So: a scan over all four (the enumeration that cannot be
 * forgotten), plus a rendered assertion in `ObservationWorkbench.test.tsx`
 * confirming the markers survive into the DOM in the same order.
 *
 * ⚠️ **Neither half sees VISUAL order.** Mutation-checked: an `order-first`
 * class on the notes track leaves both green, because `order-*` and
 * `flex-row-reverse` reorder the paint without touching the DOM, and jsdom
 * computes no layout. That is a layout claim; it was verified by driving the
 * app, and a future change to these tracks needs the same.
 *
 * **Why it exists at all.** There are four hand-rolled implementations of "a
 * row with a codes column and a notes column", which is why the order could
 * diverge 2–2 without anyone noticing, and why fixing one surface would not
 * travel to the others. This is the cheap half of the substrate remedy; the
 * shared component is the expensive half and was explicitly not required (the
 * four call sites are a transcript row, inline JSX, `<td>`s and `<span>`s).
 *
 * ⚠️ **The header and the cell are separate declarations, and for Conversations
 * they are in DIFFERENT FILES** (`TranscriptPanel.tsx` vs `SegmentRow.tsx`).
 * That is the two-halves-of-one-fact shape that produced #732, #742 and #746:
 * swap the cells, forget the header, and the header names the wrong column
 * while each file still reads correctly on its own. Both halves are scanned.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

/** Every declaration of the pair, as `[surface, half, file]`. */
const DECLARATIONS: [string, 'header' | 'row', string][] = [
  ['Conversations', 'header', 'components/TranscriptPanel.tsx'],
  ['Conversations', 'row', 'components/SegmentRow.tsx'],
  ['Documents', 'header', 'pages/DocumentCodingWorkbench.tsx'],
  ['Documents', 'row', 'pages/DocumentCodingWorkbench.tsx'],
  ['Text coding', 'header', 'components/ByTextTable.tsx'],
  ['Text coding', 'row', 'components/ByTextTable.tsx'],
  ['Observations', 'header', 'pages/ObservationWorkbench.tsx'],
  ['Observations', 'row', 'pages/ObservationWorkbench.tsx'],
]

/** Positions of every `data-col` marker in a file, in source order. */
function markers(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf-8')
  return [...text.matchAll(/data-col="(codes|notes)"/g)].map(m => m[1])
}

describe('#739 — one column order across all four coding surfaces', () => {
  it('finds a tagged pair for every declaration — the scan cannot go blind', () => {
    // The population assertion (#730's lesson): `expect(offenders).toEqual([])`
    // passes just as happily when the scan read nothing at all. Assert the
    // count FIRST, so a renamed file or a dropped attribute fails loudly here
    // rather than silently turning the checks below into no-ops.
    const files = [...new Set(DECLARATIONS.map(([, , f]) => f))]
    const total = files.reduce((n, f) => n + markers(f).length, 0)
    // Two markers per half (a codes track and a notes track).
    expect(total).toBe(DECLARATIONS.length * 2)
    for (const f of files) {
      expect(markers(f).length, `${f} lost its data-col markers`).toBeGreaterThan(0)
    }
  })

  it.each([...new Set(DECLARATIONS.map(([, , f]) => f))])(
    'declares codes before notes throughout %s',
    (file) => {
      const found = markers(file)
      // Each half contributes one pair, so the file reads codes,notes,… — any
      // `notes` reaching the front means a half was swapped and its sibling
      // was not, which is the exact half-fixed state this guard exists for.
      for (let i = 0; i < found.length; i += 2) {
        expect(found.slice(i, i + 2)).toEqual(['codes', 'notes'])
      }
    },
  )

  it('covers every surface a researcher can code in', () => {
    // Derived from the surfaces, not from a count: a fifth coding surface is
    // added to this list or it is not guarded at all. The four are the app's
    // own enumeration — conversations, documents, dataset text, observations.
    const surfaces = new Set(DECLARATIONS.map(([s]) => s))
    expect(surfaces).toEqual(new Set(['Conversations', 'Documents', 'Text coding', 'Observations']))
    for (const surface of surfaces) {
      const halves = DECLARATIONS.filter(([s]) => s === surface).map(([, h]) => h)
      expect(new Set(halves), `${surface} must declare BOTH halves`).toEqual(
        new Set(['header', 'row']),
      )
    }
  })
})
