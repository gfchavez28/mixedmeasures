/**
 * #1134 (a11y-name-sweep run 11) — the Quick jot's origin line.
 *
 * #1002 made the line read as one phrase ("From Documents › Workplan"); the run
 * found it attached to nothing. The text box takes focus as the popover opens,
 * so a reader heard "What are you noticing?" and never where the note would be
 * filed. It is the box's description now.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api', () => ({ scratchpadApi: { create: vi.fn() } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import ScratchpadPopover from './ScratchpadPopover'

afterEach(cleanup)

function renderJot(contextHint: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ScratchpadPopover
        projectId={1} contextHint={contextHint} unsortedCount={0}
        draft="" onDraftChange={vi.fn()} onClose={vi.fn()}
      />
    </QueryClientProvider>,
  )
  // By placeholder: Chrome names the box from it, jsdom's name computation does
  // not (measured), and the name is not what this file pins.
  return screen.getByPlaceholderText('What are you noticing?')
}

describe('#1134 — the Quick jot says where the note will be filed', () => {
  it('the text box is DESCRIBED by its origin line', () => {
    const box = renderJot('Documents › Amara Okafor — workplan 2024')
    expect(box).toHaveAccessibleDescription('From Documents › Amara Okafor — workplan 2024')
  })

  it('POSITIVE CONTROL: with no origin there is no description, and no dangling reference', () => {
    const box = renderJot('')
    expect(box).not.toHaveAttribute('aria-describedby')
    expect(box).toHaveAccessibleDescription('')
  })
})
