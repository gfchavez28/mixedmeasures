/**
 * #961 — the Lens sidebar's per-code counts are not zero before they are counted.
 *
 * `frequencies` is undefined until the code-frequency query answers, and again
 * on every filter, source or blind-mode change (each is a new query key). The
 * picker printed `?? 0` beside every code for the length of the request — 8.4 s
 * on a large survey — so the sidebar said no code had ever been applied.
 *
 * A code an ANSWERED count does not list really has 0, so the zero must survive
 * there; that case is what makes this a test of the distinction rather than of
 * the counts going away.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { Code, CodeFrequencyItem } from '@/lib/api'
import CodePicker from './CodePicker'

afterEach(cleanup)

const code = (id: number, name: string): Code => ({
  id, project_id: 1, numeric_id: id + 1, name, description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
})
const CODES = [code(10, 'Pacing'), code(11, 'Enthusiasm')]

function renderPicker(frequencies: CodeFrequencyItem[] | undefined) {
  render(
    <MemoryRouter>
      <CodePicker
        mode="codes" onModeChange={vi.fn()} selectedCodeIds={new Set()} onSelectionChange={vi.fn()}
        onViewCode={vi.fn()} codes={CODES} categories={[]} frequencies={frequencies} source="all"
      />
    </MemoryRouter>,
  )
}

const rowOf = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement

describe('CodePicker counts (#961)', () => {
  it('before the count answers, no code shows a number', () => {
    renderPicker(undefined)
    for (const c of CODES) {
      expect(within(rowOf(c.name)).queryByText(/^\d+$/)).not.toBeInTheDocument()
    }
  })

  it('once it answers, a counted code shows its count and an UNLISTED code shows a real 0', () => {
    renderPicker([{ code_id: 10, segment_count: 3, text_count: 2 } as CodeFrequencyItem])
    expect(within(rowOf('Pacing')).getByText('5')).toBeInTheDocument()
    expect(within(rowOf('Enthusiasm')).getByText('0')).toBeInTheDocument()
  })
})
