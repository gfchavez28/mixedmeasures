/**
 * The import fork (D16).
 *
 * These pin the two things that make it a panel rather than a gate: it is
 * reachable from both wizards without wiring, and it never BLOCKS — it informs.
 * Plus the one claim that must never come back: an Observation does not
 * categorically lack consensus/reconciliation (D18 struck that), and the copy
 * must not say so.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router'

import SourceKindPanel from './SourceKindPanel'
import { ESCAPE_HATCH_NOTE } from '@/lib/source-kind-copy'

afterEach(cleanup)

function renderPanel(current: 'conversation' | 'observation') {
  return render(
    <MemoryRouter>
      <SourceKindPanel current={current} projectId={7} />
    </MemoryRouter>,
  )
}

describe('SourceKindPanel', () => {
  it('always shows the one-liner without any interaction', () => {
    renderPanel('observation')
    expect(screen.getByText(/you code the transcript/i)).toBeInTheDocument()
    expect(screen.getByText(/you code the timeline/i)).toBeInTheDocument()
  })

  it('points at the OTHER wizard from each side', () => {
    const { unmount } = renderPanel('observation')
    expect(screen.getByRole('link', { name: /import it as a conversation/i }))
      .toHaveAttribute('href', '/projects/7/conversations/import')
    unmount()

    renderPanel('conversation')
    expect(screen.getByRole('link', { name: /import it as an observation/i }))
      .toHaveAttribute('href', '/projects/7/observations/import')
  })

  it('keeps the consequences behind a disclosure — it is not a nag', () => {
    renderPanel('observation')
    // Collapsed by default: the expert never opens it.
    expect(screen.queryByText(/no word search/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /which should i choose/i }))
    expect(screen.getByText(/no word search/i)).toBeInTheDocument()
  })

  it('surfaces the escape hatch — the sentence that makes the fork survivable', () => {
    renderPanel('observation')
    fireEvent.click(screen.getByRole('button', { name: /which should i choose/i }))
    expect(screen.getByText(ESCAPE_HATCH_NOTE)).toBeInTheDocument()
  })

  it('NEVER tells a researcher an Observation has no consensus or reconciliation', () => {
    // The single most dangerous sentence in the feature: it is what someone
    // decides on before coding for hours, and it is FALSE for a frozen clip set.
    renderPanel('observation')
    fireEvent.click(screen.getByRole('button', { name: /which should i choose/i }))
    const text = document.body.textContent?.toLowerCase() ?? ''
    expect(text).not.toContain('no consensus')
    expect(text).not.toContain('no reconciliation')
  })

  it('the disclosure is a labelled, expandable control', () => {
    renderPanel('conversation')
    const toggle = screen.getByRole('button', { name: /which should i choose/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})
