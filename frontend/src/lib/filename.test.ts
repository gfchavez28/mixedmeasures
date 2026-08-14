import { describe, it, expect } from 'vitest'
import { safeFilename } from './filename'

/**
 * #734 — the client download-filename rule.
 *
 * The defect was an ASCII-only allow-list on the chart exports: the SERVER's
 * latin-1 `Content-Disposition` constraint (#408) applied to a client that has
 * none. `a.download` is a DOM string; a zip entry name is UTF-8.
 */
describe('safeFilename', () => {
  it('keeps non-Latin scripts instead of erasing them', () => {
    // Each of these reduced to '' or '_' under the old chart rule.
    expect(safeFilename('教育プログラム評価')).toBe('教育プログラム評価')
    expect(safeFilename('Αξιολόγηση')).toBe('Αξιολόγηση')
    expect(safeFilename('Оценка программы')).toBe('Оценка_программы')
    expect(safeFilename('تقييم البرنامج')).toBe('تقييم_البرنامج')
  })

  it('keeps accented Latin — the case most likely to hit a real user', () => {
    // The old rule silently produced 'valuation_Franaise'. Not exotic, and it
    // failed quietly: the file downloaded, just misnamed.
    expect(safeFilename('Évaluation Française')).toBe('Évaluation_Française')
  })

  it('never returns an empty name', () => {
    // `link.download = '.png'` is a nameless hidden file, and what a browser
    // does with it is not something this code should be relying on.
    expect(safeFilename('')).toBe('export')
    expect(safeFilename('...')).toBe('export')
    expect(safeFilename('///')).not.toBe('')
    expect(safeFilename('', { fallback: 'chart' })).toBe('chart')
  })

  it('replaces only what a filesystem actually refuses', () => {
    expect(safeFilename('Site A / Cohort 2')).toBe('Site_A___Cohort_2')
    expect(safeFilename('a:b|c*d?e"f<g>h')).toBe('a_b_c_d_e_f_g_h')
  })

  it('strips a leading dot and a trailing dot or space', () => {
    expect(safeFilename('.hidden')).toBe('hidden')
    expect(safeFilename('trailing.')).toBe('trailing')
    // Truncation can CREATE either, so the strip runs after the slice.
    expect(safeFilename('a'.repeat(79) + '.x', { maxLength: 80 })).toBe('a'.repeat(79))
  })

  it('strips control characters', () => {
    expect(safeFilename('nul\u0000 del\u007fbell\u0007')).toBe('nul_delbell')
  })

  it('honours the space convention each surface wants', () => {
    // Charts/ZIPs are snake-ish; canvas titles are prose and read better with
    // spaces, which are perfectly legal in a filename.
    expect(safeFilename('Program Evaluation', { spaces: 'underscore' })).toBe('Program_Evaluation')
    expect(safeFilename('Program Evaluation', { spaces: 'keep' })).toBe('Program Evaluation')
  })

  it('truncates long names', () => {
    expect(safeFilename('x'.repeat(200))).toHaveLength(80)
  })
})
