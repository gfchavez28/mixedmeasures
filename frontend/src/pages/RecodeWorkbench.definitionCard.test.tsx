import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DefinitionCard } from './RecodeWorkbench'
import type { RecodeDefinition } from '@/lib/api'

/**
 * Decision C, option 2 — "saved but not in effect" is stated, for everyone.
 *
 * 🔴 That state has no analogue in SPSS, jamovi or JASP, and it was communicated
 * by a bare STAR ICON with no accessible name: a sighted user had to know the
 * convention, and a screen-reader user was told nothing at all. **The
 * load-bearing fact about a rule — does it do anything? — was the one fact the
 * row did not state.** The auto-detect wand beside it had carried a `title` all
 * along, so the less important flag was named and this one was not (#559).
 */

afterEach(cleanup)

const defn = (o: Partial<RecodeDefinition>): RecodeDefinition => ({
  id: 1,
  column_id: 1,
  name: 'A rule',
  recode_type: 'scale_map',
  output_type: 'numeric',
  mapping: { Never: 1, Always: 5 },
  exclude_values: null,
  is_primary: false,
  is_auto_detected: false,
  source_definition_id: null,
  sequence_order: 0,
  created_at: '2026-08-23T00:00:00Z',
  updated_at: '2026-08-23T00:00:00Z',
  unmapped_values: [],
  reverse_offset: null,
  ...o,
} as RecodeDefinition)

function renderCard(d: RecodeDefinition) {
  render(
    <DefinitionCard
      definition={d}
      allDefinitions={[d]}
      isExpanded={false}
      onToggleExpand={vi.fn()}
      onSave={vi.fn()}
      onDelete={vi.fn()}
      onApply={vi.fn()}
      onCopyTo={vi.fn()}
      onRederive={vi.fn()}
      onDerive={vi.fn()}
      isSaving={false}
    />,
  )
}

describe('DefinitionCard states what a rule actually does', () => {
  it('says a primary rule is IN EFFECT, with an accessible name', () => {
    renderCard(defn({ is_primary: true, name: 'Anxiety (inverted)' }))
    // Queried by TEXT, not by role: the badge deliberately carries no
    // `role="img"`, because that role suppresses its children and the words are
    // the point (#698's whole-tree scan enforces this).
    const badge = screen.getByText('In effect')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('title', expect.stringContaining('drives the stored numbers'))
  })

  it('says a non-primary rule is NOT APPLIED', () => {
    renderCard(defn({ is_primary: false }))
    expect(screen.getByText('Not applied')).toBeInTheDocument()
    expect(screen.queryByText('In effect')).not.toBeInTheDocument()
  })

  it('never shows both states at once', () => {
    renderCard(defn({ is_primary: true }))
    expect(screen.queryByText('Not applied')).not.toBeInTheDocument()
  })

  it('explains what "not applied" MEANS, rather than only naming it', () => {
    // The state has no analogue in the tools these researchers know, so the
    // label alone is a term of art. The explanation is what makes it legible.
    renderCard(defn({ is_primary: false }))
    expect(screen.getByText('Not applied'))
      .toHaveAttribute('title', expect.stringContaining('does not affect'))
  })

  // ⚠️ There is deliberately NO test that the star carries `aria-hidden`.
  // MEASURED: lucide-react sets it by default, so such a test asserts the
  // LIBRARY's behaviour and survives any mutation of ours — which is exactly
  // what it did. The explicit attribute stays for consistency with the rest of
  // the codebase; a guard over it would be belt-and-braces, and the house rule
  // is to delete those rather than let them certify nothing.
})
