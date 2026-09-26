/**
 * #1041 — the two code panels stand down for a key aimed at ANOTHER control.
 *
 * **The defect, measured live.** `CodePanel`'s container `onKeyDown` handled
 * Space and Enter for every descendant that was not an `<input>` and cancelled
 * them — so on the conversation, document and observation workbenches no
 * code-set value, no clear control, no colour dot and no Options button could
 * be operated from the keyboard (Enter arrived at the document already
 * `defaultPrevented`). `TextCodePanel` listens on `window`: Enter on a code-set
 * value applied the code highlighted in ITS list instead, its arrows moved that
 * list as well as the picker's focus, and `n` jumped to its search box.
 *
 * **The rule is the workbench layer's (#784), applied one level down:** stand
 * down for a key a control already handled, and for an activation key on a real
 * control. The code list itself is untouched — its container holds focus while
 * it is navigated (`CodePanel`) and its rows are `role="option"` (`TextCodePanel`),
 * neither of which owns a key — and each case below has that positive control,
 * because a stand-down that passes by breaking the list is the easy failure.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'
import type { Code, CodeSet, CodeSetMember } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), reorderInCategory: vi.fn() },
    categoriesApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
    projectsApi: { get: vi.fn().mockResolvedValue({ id: 1, codebook_frozen_at: null }), setCodebookFreeze: vi.fn() },
  }
})

import CodePanel from './CodePanel'
import TextCodePanel from './TextCodePanel'
import { CodeSetPicker } from './CodeSetPicker'

afterEach(cleanup)
// Both panels scroll the highlighted code into view; jsdom has no layout.
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })

const code =(id: number, name: string): Code => ({
  id, project_id: 1, numeric_id: id + 1, name, description: null, color: null,
  is_universal: false, is_active: true, created_at: '', updated_at: '',
  usage_count: 0, category_id: null, category_name: null, category_color: null, category_order: null,
})
const CODES = [code(10, 'Pacing'), code(11, 'Enthusiasm')]
const READY: ListLoad = { status: 'ready', error: null, retry: vi.fn(), retrying: false }

const member = (id: number, name: string): CodeSetMember => ({
  id, numeric_id: id, name, description: null, color: null, is_active: true, is_universal: false,
})
const STANCE: CodeSet = {
  id: 7, project_id: 1, label: 'Stance', description: null, exhaustive: false,
  members: [member(21, 'Positive'), member(22, 'Negative')],
  set_basis: 'inclusive_with_none', composition_warnings: [], created_at: '', updated_at: '',
}

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

/**
 * A key as Chrome delivers it — to the target, bubbling, cancelable — inside
 * `act`, so the state a key sets (the highlighted code) has committed before the
 * next key reads it. `fireEvent` returns false when a listener cancelled it.
 */
function keyOn(el: Element | Document, key: string): { defaultPrevented: boolean } {
  return { defaultPrevented: !fireEvent.keyDown(el, { key }) }
}

describe('CodePanel (conversation · document · observation)', () => {
  function renderPanel() {
    const onCodeToggle = vi.fn()
    const onNavigateToTranscript = vi.fn()
    const onSelect = vi.fn()
    wrap(
      <CodePanel
        codes={CODES} codesLoad={READY} projectId={1} selectedCodesMap={new Map()}
        onCodeToggle={onCodeToggle} onCreateCode={vi.fn()} disabled={false}
        isFocused onNavigateToTranscript={onNavigateToTranscript}
        codeSets={<CodeSetPicker set={STANCE} selectedCodeId={21} onSelect={onSelect} />}
      />,
    )
    // The container is the only tabIndex=0 element that holds the list.
    const container = screen.getByRole('radiogroup', { name: 'Stance' }).closest('[tabindex="0"]')!
    // Highlight the first code, so a panel that DOES take Enter has one to toggle.
    keyOn(container, 'ArrowDown')
    return { container, onCodeToggle, onNavigateToTranscript }
  }

  it('Enter and Space on a code-set value reach the value, not the list', () => {
    const { onCodeToggle } = renderPanel()
    const negative = screen.getByRole('radio', { name: 'Negative' })
    expect(keyOn(negative, 'Enter').defaultPrevented).toBe(false)
    expect(keyOn(negative, ' ').defaultPrevented).toBe(false)
    expect(onCodeToggle).not.toHaveBeenCalled()
  })

  it('…and on the clear control', () => {
    const { onCodeToggle } = renderPanel()
    const clear = screen.getByRole('button', { name: 'None of these for Stance' })
    expect(keyOn(clear, 'Enter').defaultPrevented).toBe(false)
    expect(keyOn(clear, ' ').defaultPrevented).toBe(false)
    expect(onCodeToggle).not.toHaveBeenCalled()
  })

  it('…and on a code’s colour dot and Options button — shipped, and just as dead', () => {
    renderPanel()
    for (const name of ['Change color for Pacing', 'Options for Pacing']) {
      const control = screen.getByRole('button', { name })
      expect(keyOn(control, 'Enter').defaultPrevented, name).toBe(false)
      expect(keyOn(control, ' ').defaultPrevented, name).toBe(false)
    }
  })

  it('an arrow the picker used does not ALSO move the list or leave the panel', () => {
    const { onNavigateToTranscript } = renderPanel()
    const positive = screen.getByRole('radio', { name: 'Positive' })
    keyOn(positive, 'ArrowLeft')
    expect(onNavigateToTranscript).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL — the list still applies on Enter and leaves on ArrowLeft', () => {
    const { container, onCodeToggle, onNavigateToTranscript } = renderPanel()
    expect(keyOn(container, 'Enter').defaultPrevented).toBe(true)
    expect(onCodeToggle).toHaveBeenCalledWith(CODES[0])
    keyOn(container, 'ArrowLeft')
    expect(onNavigateToTranscript).toHaveBeenCalled()
  })
})

describe('TextCodePanel (Text Coding) — a WINDOW listener', () => {
  function renderPanel() {
    const onToggleCode = vi.fn()
    wrap(
      <TextCodePanel
        codes={CODES} codesLoad={READY} categories={[]} projectId={1}
        appliedCodeIds={[]} onToggleCode={onToggleCode} onCreateCode={vi.fn()}
        selectedCount={1} isFocused onFocusChange={vi.fn()}
        codeSets={<CodeSetPicker set={STANCE} selectedCodeId={21} onSelect={vi.fn()} />}
      />,
    )
    // Highlight the first code: the list's own ArrowDown arrives from anywhere.
    keyOn(document.body, 'ArrowDown')
    return { onToggleCode }
  }

  it('Enter on a code-set value does NOT apply the code highlighted in the list', () => {
    const { onToggleCode } = renderPanel()
    const negative = screen.getByRole('radio', { name: 'Negative' })
    expect(keyOn(negative, 'Enter').defaultPrevented).toBe(false)
    expect(keyOn(negative, ' ').defaultPrevented).toBe(false)
    expect(onToggleCode).not.toHaveBeenCalled()
  })

  it('an arrow the picker used does not ALSO move the list’s highlight', () => {
    const { onToggleCode } = renderPanel()
    keyOn(screen.getByRole('radio', { name: 'Positive' }), 'ArrowDown')
    // Still on the first code: Enter from the page applies IT, not the second.
    keyOn(document.body, 'Enter')
    expect(onToggleCode).toHaveBeenCalledWith(CODES[0].id)
  })

  it('`n` inside the picker stays there instead of jumping to the search box', () => {
    renderPanel()
    const negative = screen.getByRole('radio', { name: 'Negative' })
    negative.focus()
    keyOn(negative, 'n')
    expect(negative).toHaveFocus()
  })

  it('POSITIVE CONTROL — Enter from the page applies the highlighted code; `n` finds the search', () => {
    const { onToggleCode } = renderPanel()
    expect(keyOn(document.body, 'Enter').defaultPrevented).toBe(true)
    expect(onToggleCode).toHaveBeenCalledWith(CODES[0].id)
    keyOn(document.body, 'n')
    expect(screen.getByRole('textbox', { name: 'Search or add codes' })).toHaveFocus()
  })
})
