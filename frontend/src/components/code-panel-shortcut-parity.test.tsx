/**
 * #824 — the two code panels advertise the SAME keys, and they are the
 * resolver's keys.
 *
 * **The defect this exists to catch.** `TextCodePanel` derived its chord
 * numbers from a map `TextCodingView` built out of EVERY category returned by
 * the categories endpoint, sorted by `display_order`. The chord RESOLVER
 * (`useCodeChordShortcuts`) derives from `buildShortcutCategories(codes)` —
 * only categories that HAVE codes, in first-appearance order. Those two agree
 * until an EMPTY category sorts before a populated one, and then the panel
 * prints a key that applies a DIFFERENT code, silently, on the surface where
 * coding happens. Measured on real data: one of five advertised prefixes was
 * right, by coincidence.
 *
 * ⚠️ **The fixture is the whole test.** A single-category project passes while
 * broken; so does a project with no empty categories. It needs an empty
 * category ordered FIRST plus at least two populated ones — which is why the
 * shape is asserted before anything is rendered.
 *
 * ⚠️ **It is a PARITY test on purpose** (`feedback_parity_by_enumeration`): the
 * conversation/document panel was correct the whole time, so diffing the two
 * siblings against one fixture is the diagnostic that would have found this
 * without anyone suspecting it. Both are then checked against
 * `buildShortcutCategories`, so "they agree with each other and are both wrong"
 * cannot pass.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { buildShortcutCategories } from '@/lib/codeShortcuts'
import TextCodePanel from './TextCodePanel'
import CodePanel from './CodePanel'

afterEach(cleanup)

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, codesApi: { update: vi.fn(), list: vi.fn() } }
})

type TestCode = {
  id: number
  name: string
  numeric_id: number | null
  is_universal: boolean
  is_active: boolean
  category_id: number | null
  category_name?: string | null
  category_order?: number
  color: string | null
  description?: string | null
}

/** id 90 is EMPTY and sorts FIRST by display_order — the whole point. */
const CATEGORIES = [
  { id: 90, name: 'Empty first', display_order: 1, parent_id: null, color: null },
  { id: 91, name: 'Implementation', display_order: 5, parent_id: null, color: null },
  { id: 92, name: 'Attitudes', display_order: 7, parent_id: null, color: null },
]

const CODES: TestCode[] = [
  { id: 1, name: 'Unsubstantive', numeric_id: 0, is_universal: true, is_active: true, category_id: null, color: null },
  { id: 2, name: 'Unclear', numeric_id: 1, is_universal: true, is_active: true, category_id: null, color: null },
  { id: 10, name: 'Pacing', numeric_id: 10, is_universal: false, is_active: true, category_id: 91, category_name: 'Implementation', category_order: 0, color: null },
  { id: 11, name: 'Materials use', numeric_id: 11, is_universal: false, is_active: true, category_id: 91, category_name: 'Implementation', category_order: 1, color: null },
  { id: 20, name: 'Enthusiasm', numeric_id: 20, is_universal: false, is_active: true, category_id: 92, category_name: 'Attitudes', category_order: 0, color: null },
  // Uncategorized with a two-digit id: the #664 rider. No key can reach it
  // (the chord machine only accumulates digits behind a category prefix), so
  // neither panel may print one.
  { id: 27, name: 'Loose code', numeric_id: 27, is_universal: false, is_active: true, category_id: null, color: null },
]

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

/** The row a code's name sits in, as flat text (name + whatever key is shown). */
function rowText(codeName: string): string {
  const nameEl = screen.getByText(codeName)
  const row = nameEl.closest('button') ?? nameEl.parentElement
  return row?.textContent ?? ''
}

function renderTextPanel() {
  return wrap(
    <TextCodePanel
      codes={CODES as never}
      categories={CATEGORIES as never}
      projectId={1}
      appliedCodeIds={[]}
      onToggleCode={() => {}}
      selectedCount={1}
      isFocused={false}
      onFocusChange={() => {}}
    />,
  )
}

function renderCodePanel() {
  return wrap(
    <CodePanel
      codes={CODES as never}
      projectId={1}
      selectedCodesMap={new Map()}
      onCodeToggle={() => {}}
      onCreateCode={() => {}}
      disabled={false}
      categories={CATEGORIES as never}
    />,
  )
}

describe('#824 — the advertised key is the key that fires', () => {
  it('the fixture can tell a correct panel from the broken one', () => {
    // The DISCRIMINATION assertion. `display_order` ordering and chord-space
    // ordering must disagree here, or every assertion below passes under the
    // defect. Category 90 is empty, so it takes a `display_order` slot and NO
    // chord prefix — which shifts everything after it by one.
    const chordOrder = buildShortcutCategories(CODES).map(c => c.categoryId)
    expect(chordOrder).toEqual([91, 92])
    const displayOrder = [...CATEGORIES].sort((a, b) => a.display_order - b.display_order).map(c => c.id)
    expect(displayOrder.indexOf(91) + 2).not.toBe(chordOrder.indexOf(91) + 2)
  })

  it('TextCodePanel prints the resolver’s chords, not display_order positions', () => {
    renderTextPanel()
    // Implementation is the FIRST populated category → prefix 2.
    expect(rowText('Pacing')).toContain('2.1')
    expect(rowText('Materials use')).toContain('2.2')
    // Attitudes is second → prefix 3. Pre-fix this printed `4.1` (its
    // display_order index+2), which fires nothing at all.
    expect(rowText('Enthusiasm')).toContain('3.1')
    expect(rowText('Enthusiasm')).not.toContain('4.1')
  })

  it('CodePanel prints the same keys for the same codes', () => {
    renderCodePanel()
    expect(rowText('Pacing')).toContain('2.1')
    expect(rowText('Materials use')).toContain('2.2')
    expect(rowText('Enthusiasm')).toContain('3.1')
  })

  it('a category header marks the prefix that actually reaches it', () => {
    renderTextPanel()
    expect(screen.getByText('[2]')).toBeInTheDocument()
    expect(screen.getByText('[3]')).toBeInTheDocument()
    // The empty category has no codes, so it occupies no chord digit — and it
    // renders no header at all, since the panel groups by code.
    expect(screen.queryByText('[4]')).not.toBeInTheDocument()
  })

  it('neither panel advertises a key that cannot be typed (#664)', () => {
    const { unmount } = renderTextPanel()
    expect(rowText('Loose code')).toBe('Loose code')
    unmount()
    renderCodePanel()
    expect(rowText('Loose code')).toBe('Loose code')
  })

  it('the universal row keeps its single digits', () => {
    renderTextPanel()
    expect(rowText('Unsubstantive')).toContain('0')
    expect(rowText('Unclear')).toContain('1')
  })
})
