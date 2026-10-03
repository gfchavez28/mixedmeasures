/**
 * #1111 — a click inside one of a code row's OVERLAYS never toggles the code.
 *
 * **The defect, reproduced live.** The code row is a `div` whose click toggles
 * the code on the selected segment, and the rating-scale dialog is mounted
 * inside it. React delivers a portal's events through its React ancestors, so
 * with a segment selected the dialog's clicks reached the row: a click on the
 * *Step* field REMOVED the code (and its rating), a click on *Save scale*
 * re-applied it unrated across the segment's group — and the re-apply opened the
 * rating strip from a stale cache, which is the "one save behind" lag the
 * developer reported. The Options menu guarded each item and not its own
 * padding: one click there removed the code (measured on the shipped code).
 *
 * ⚠️ **The Deactivate dialog's BACKDROP is in this population as a RULE, not a
 * reproduced defect.** In jsdom its click reaches the row; in Chrome the
 * backdrop unmounts on the press, so the release lands on whatever is beneath
 * (measured: the logo link). It is kept because the guard is about every portal,
 * and a backdrop that outlives its press — an exit animation — would reach it.
 *
 * **The fix is one test at the row** — a click whose target is not a DOM
 * descendant of the row is not a click on the row — so this file is a
 * POPULATION over the row's overlays, plus the positive control: a guard that
 * passed by making the row unclickable would pass every negative case.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Code } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'

const setMagnitudeScale = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codesApi: {
      list: vi.fn(), create: vi.fn(), update: vi.fn(), reorderInCategory: vi.fn(),
      setMagnitudeScale: (...a: unknown[]) => setMagnitudeScale(...a),
    },
    categoriesApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
    projectsApi: { get: vi.fn().mockResolvedValue({ id: 1, codebook_frozen_at: null }), setCodebookFreeze: vi.fn() },
  }
})
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import CodePanel from './CodePanel'

afterEach(() => { cleanup(); setMagnitudeScale.mockReset() })
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })

const POSITIVE = {
  id: 10, project_id: 1, numeric_id: 1, name: 'Positive', description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  // > 0, so *Deactivate Code* asks in a dialog rather than acting at once.
  usage_count: 2, category_id: null, category_name: null, category_color: null, category_order: null,
  magnitude_scale: { min: -1, max: 1, step: 0.5, anchors: [] },
} as unknown as Code
const READY: ListLoad = { status: 'ready', error: null, retry: vi.fn(), retrying: false }

/** The panel with a segment SELECTED — `disabled={false}` — the state the defect needs. */
function renderPanel() {
  const onCodeToggle = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CodePanel
          codes={[POSITIVE]} codesLoad={READY} projectId={1} selectedCodesMap={new Map()}
          onCodeToggle={onCodeToggle} onCreateCode={vi.fn()} disabled={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onCodeToggle }
}

function openMenuItem(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Options for Positive' }))
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('a code row\'s overlays never toggle the code (#1111)', () => {
  it('POSITIVE CONTROL: a click on the row itself still toggles it', () => {
    const { onCodeToggle } = renderPanel()
    fireEvent.click(screen.getByText('Positive'))
    expect(onCodeToggle).toHaveBeenCalledTimes(1)
  })

  it('clicks inside the rating-scale dialog — a field, then Save — change the scale and nothing else', async () => {
    setMagnitudeScale.mockResolvedValue({ ...POSITIVE })
    const { onCodeToggle } = renderPanel()
    openMenuItem('Edit rating scale')
    const step = await screen.findByLabelText('Step')
    fireEvent.click(step)                                   // was: the code REMOVED
    fireEvent.change(step, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save scale' }))   // was: re-applied
    await waitFor(() => expect(setMagnitudeScale).toHaveBeenCalledTimes(1))
    expect(onCodeToggle).not.toHaveBeenCalled()
  })

  it('a click on the Deactivate dialog\'s BACKDROP does not toggle the code (a rule here — see the header)', async () => {
    const { onCodeToggle } = renderPanel()
    openMenuItem('Deactivate Code')
    await screen.findByRole('dialog', { name: /Deactivate/ })
    const backdrop = document.querySelector('div.fixed.inset-0[data-state="open"]')
    expect(backdrop, 'the dialog renders a backdrop to click').not.toBeNull()
    fireEvent.click(backdrop!)
    expect(onCodeToggle).not.toHaveBeenCalled()
  })

  it('a click on the Options menu\'s own padding does not toggle the code (measured: it removed the code)', () => {
    const { onCodeToggle } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Options for Positive' }))
    fireEvent.click(screen.getByLabelText('Code actions'))
    expect(onCodeToggle).not.toHaveBeenCalled()
  })
})
