/**
 * a11y-name-sweep run 12 — a saved test's row buttons name the test they act on.
 * Measured in Chrome's tree with two saved tests: two "Compute test" and two
 * "Delete test", in no list and under no row header.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SRC_DIR } from '@/test-support/source-tree'
import { stripComments } from '@/lib/strip-comments'
import { savedTestLabel } from './saved-test-label'

describe('savedTestLabel', () => {
  it('is the row: the test type, then the group or metric it targets', () => {
    expect(savedTestLabel({ test_type: 'split_half', target_label: 'Wellbeing scale' }))
      .toBe('Split-Half Reliability — Wellbeing scale')
    expect(savedTestLabel({ test_type: 'cronbachs_alpha', target_label: null })).toBe("Cronbach's Alpha")
    expect(savedTestLabel({ test_type: 'something_new', target_label: 'X' })).toBe('something_new — X')
  })
})

describe('the Analysis view names each saved test row’s buttons by the test', () => {
  const src = stripComments(readFileSync(join(SRC_DIR, 'pages/AnalysisView.tsx'), 'utf8'))

  it('Compute and Delete carry savedTestLabel(test), never a fixed word', () => {
    expect(src).toContain('aria-label={`Compute ${savedTestLabel(test)}`}')
    expect(src).toContain('aria-label={`Delete ${savedTestLabel(test)}`}')
    expect(src).not.toMatch(/aria-label="(Compute|Delete) test"/)
  })

  it('the Add Statistical Test dialog names both target pickers through their visible label', () => {
    // A `<label htmlFor>` naming the SelectTrigger by id — a button is labelable.
    const labels = src.match(/<label htmlFor=\{testTargetId\}[^>]*>(Variable Group|Grouped Metric)<\/label>/g) ?? []
    expect(labels).toHaveLength(2)
    expect(src.match(/<SelectTrigger id=\{testTargetId\}/g) ?? []).toHaveLength(2)
  })
})
