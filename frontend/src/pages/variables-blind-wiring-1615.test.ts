/**
 * #1615 (r4) — the two Variables-view requests that can carry a participant score's VALUES send
 * the viewer's scope while blind mode withholds, wait for the blind state to settle (fail
 * closed, D96), and key the answer by the scope (`multicoder.md`, *Blind-scope cache
 * correctness*). A SOURCE scan, stated as such: neither page is mounted here; the request
 * shape is pinned in `lib/api/variables-blind-scope-1615.test.ts`, the words in
 * `ValueFrequenciesPanel.blind-1615.test.tsx`, the server's answer in
 * `backend/tests/test_blind_rating_files_1615.py`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'

const src = (rel: string) => stripComments(readFileSync(`${__dirname}/../${rel}`, 'utf8'))

describe('the Variables view while blind (#1615)', () => {
  const page = src('pages/RecodeWorkbench.tsx')
  it('Observed values asks with the scope, keyed by it, once the blind state is ready', () => {
    expect(page).toContain('const { coderScope, scopeReady } = useBlindScope(pid)')
    expect(page).toContain("queryKey: ['column-frequencies', pid, did, selectedColumnId, coderScope ?? 'every-coder']")
    expect(page).toContain('recodeApi.getFrequencies(pid, did, selectedColumnId!, coderScope)')
    expect(page).toMatch(/enabled: !!pid && !!did && !!selectedColumnId && scopeReady,/)
  })
  const dialog = src('components/ColumnFormDialog.tsx')
  it('the computed-variable preview asks with the scope, only once the blind state is ready', () => {
    expect(dialog).toContain('useBlindScope(projectId ?? 0)')
    expect(dialog).toMatch(/if \(mode !== 'computed' \|\| !projectId \|\| !datasetId \|\| !scopeReady\) return/)
    expect(dialog).toMatch(/\}, coderScope\)\s*setPreview\(res\)/)
    expect(dialog).toContain('preview.values_withheld_while_blind')
  })
})
