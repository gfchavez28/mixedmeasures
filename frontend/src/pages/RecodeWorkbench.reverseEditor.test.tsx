/**
 * #602 — the reverse editor DISPLAYS the server's reflection offset; it must
 * never re-derive one.
 *
 * The offset excludes the null set (#600), and this client can see neither the
 * recognized-N/A rule nor the column's missing declaration. A local `min + max`
 * over `{Never: 1, Always: 5, "Prefer not to say": 99}` is 100, so the preview
 * said "Never → 99" while the save (correctly) produced 5 — the #578
 * display-vs-storage drift, one screen over.
 *
 * Two call sites, and only one of them is a draft: the edit card renders a SAVED
 * definition (its own `reverse_offset`), the new-def panel renders a DRAFT whose
 * mapping is a verbatim copy of its `scale_map` source, so it takes the SOURCE's
 * offset. Both are pinned here.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ReverseEditor } from './RecodeWorkbench'
import type { RecodeDefinition } from '@/lib/api'

/** The #600 repro: raw min+max = 100; over the real scale points, 6. */
const POISON_MAP = { Never: 1, Always: 5, 'Prefer not to say': 99 }

const def = (over: Partial<RecodeDefinition> = {}): RecodeDefinition => ({
  id: 1,
  column_id: 1,
  name: '5-point scale',
  recode_type: 'scale_map',
  output_type: 'numeric',
  mapping: POISON_MAP,
  exclude_values: null,
  is_primary: true,
  is_auto_detected: true,
  source_definition_id: null,
  sequence_order: 0,
  created_at: '2026-01-01T00:00:00+00:00',
  updated_at: '2026-01-01T00:00:00+00:00',
  unmapped_values: [],
  ...over,
}) as RecodeDefinition

/** The "Reversed score" cell for a given response label. */
function scoreFor(label: string): string {
  const row = screen.getByRole('row', { name: new RegExp(`^${label}\\b`) })
  const cells = within(row).getAllByRole('cell')
  return cells[cells.length - 1].textContent ?? ''
}

afterEach(cleanup)

describe('ReverseEditor — #602', () => {
  it('a SAVED definition previews its own server offset', () => {
    render(
      <ReverseEditor
        sourceDefinitionId={1}
        definitions={[def()]}
        mapping={POISON_MAP}
        serverOffset={6}
      />,
    )
    expect(scoreFor('Never')).toBe('5')
    expect(scoreFor('Always')).toBe('1')
  })

  it('a DRAFT falls back to its SOURCE definition\'s offset', () => {
    // No `serverOffset` — there is no saved row yet. The source carries the
    // authoritative number for the very mapping the draft copied.
    render(
      <ReverseEditor
        sourceDefinitionId={1}
        definitions={[def({ reverse_offset: 6 })]}
        mapping={POISON_MAP}
      />,
    )
    expect(scoreFor('Never')).toBe('5')
  })

  it('does NOT re-derive min+max when the server has spoken', () => {
    // The whole SCORE column at once. A local derivation over this mapping uses
    // offset 100 and produces 99 / 95 / 1; the server's 6 produces 5 / 1 / -93.
    // (-93 is odd-looking and correct: apply NULLs that cell because the key is
    // in the null set, and the editor cannot see the null set — #602 says
    // explicitly not to mirror it client-side, so the score is simply computed
    // uniformly. The number to care about is Never = 5.)
    render(
      <ReverseEditor
        sourceDefinitionId={1}
        definitions={[def({ reverse_offset: 6 })]}
        mapping={POISON_MAP}
      />,
    )
    const scores = Object.keys(POISON_MAP).map(scoreFor)
    expect(scores).toEqual(['5', '1', '-93'])
    expect(scores).not.toContain('99')
  })

  it('renders a symmetric scale reflecting about ZERO, not as "no offset"', () => {
    // The falsy-zero trap: `serverOffset ?? …`, never `||`, because 0 is a real
    // offset for a -5..+5 scale.
    //
    // ⚠️ The mapping carries a null-set key ON PURPOSE. A bare -5..+5 derives to
    // min+max = 0 as well, so `||` reaches the same answer by accident and the
    // mutant SURVIVES — measured. With "Prefer not to say" present the raw
    // derivation is -5+99 = 94, which is nothing like 0, so the two paths are
    // finally distinguishable. (Same degenerate-fixture lesson as the backend's
    // partial-coverage guard in this batch.)
    const SYMMETRIC = { Lo: -5, Hi: 5, 'Prefer not to say': 99 }
    render(
      <ReverseEditor
        sourceDefinitionId={1}
        definitions={[def({ mapping: SYMMETRIC })]}
        mapping={SYMMETRIC}
        serverOffset={0}
      />,
    )
    expect(scoreFor('Lo')).toBe('5')
    expect(scoreFor('Hi')).toBe('-5')
  })

  it('still explains itself when the source definition is gone', () => {
    render(
      <ReverseEditor sourceDefinitionId={99} definitions={[def()]} mapping={POISON_MAP} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/not found or deleted/i)
  })
})
