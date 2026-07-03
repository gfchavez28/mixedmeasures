/**
 * #517 — the shared blind-scope banner: blind-scoped analysis surfaces must say
 * they're self-only instead of rendering an unexplained near-empty grid.
 * (Single-sources the #454 ContentByCode notice; Descriptives + Relationships
 * now render it too via QualitativeAnalysisView.)
 */
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import BlindScopeNotice from './BlindScopeNotice'

afterEach(cleanup)

it('renders the message and a reveal toggle while blind', () => {
  const onReveal = vi.fn()
  render(
    <BlindScopeNotice blind onReveal={onReveal}>
      Blind mode is on — these charts count only your own coding.
    </BlindScopeNotice>,
  )
  expect(screen.getByText(/count only your own coding/)).toBeInTheDocument()
  // The embedded BlindModeToggle is the reveal affordance (confirm-gated).
  expect(screen.getByRole('button', { name: /colleagues.*hidden/i })).toBeInTheDocument()
})

it('renders nothing when not blind', () => {
  const { container } = render(
    <BlindScopeNotice blind={false}>anything</BlindScopeNotice>,
  )
  expect(container).toBeEmptyDOMElement()
})

it('omits the toggle when no onReveal is provided', () => {
  render(<BlindScopeNotice blind>scope note</BlindScopeNotice>)
  expect(screen.getByText('scope note')).toBeInTheDocument()
  expect(screen.queryByRole('button')).toBeNull()
})
