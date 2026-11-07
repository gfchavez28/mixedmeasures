/**
 * #1529 D94 (1.5.9) — an embed whose drawn coded shares changed says so.
 *
 * 1.5.9 withholds a universal row's share of the coded total (#1526 D79 on the summary table, #1529
 * D91 under *Per Category*, D92 leaves the row off a *Coded only* chart). No COUNT moves, so a
 * counts-only fingerprint saw nothing, and an embed placed under 1.5.8 kept quiet over a "150%" that
 * now reads "—". `fingerprintSourceFrequencies(…, {codedShare})` adds the universal rows when the
 * embed draws a coded share; `sourceFrequencyDrawsCodedShare` decides that per embed.
 */
import { describe, it, expect } from 'vitest'
import { fingerprintSourceFrequencies } from './figure-baseline'
import { extractQualComputeParams, sourceFrequencyDrawsCodedShare } from './inline-chart-params'

const payload = (unclearIsUniversal: boolean) => ({
  sources: [{
    source_type: 'document', source_id: 1, coded_segments: 3,
    code_counts: { '2': { count: 4 }, '3': { count: 3 } },
  }],
  totals: { coded_segments: 3 },
  codes: [{ id: 2, is_universal: unclearIsUniversal }, { id: 3, is_universal: false }],
})

describe('fingerprintSourceFrequencies with codedShare (#1529 D94)', () => {
  it('an embed drawing a coded share with a universal row hashes differently than before', () => {
    // `payload(false)` + `codedShare: false` IS the projection 1.5.8 stored as the baseline.
    const stored = fingerprintSourceFrequencies(payload(false), { codedShare: false })
    const now = fingerprintSourceFrequencies(payload(true), { codedShare: true })
    expect(now.hash).not.toBe(stored.hash)
    expect(now.headline).toBe(stored.headline)  // "3 coded": the marker says THAT, not a new headline
  })

  it('control — an embed that draws counts hashes exactly as before, universal row or not', () => {
    const stored = fingerprintSourceFrequencies(payload(false), { codedShare: false })
    expect(fingerprintSourceFrequencies(payload(true), { codedShare: false }).hash).toBe(stored.hash)
  })

  it('control — an embed drawing a coded share with NO universal row hashes exactly as before', () => {
    const stored = fingerprintSourceFrequencies(payload(false), { codedShare: false })
    expect(fingerprintSourceFrequencies(payload(false), { codedShare: true }).hash).toBe(stored.hash)
  })

  it('stays at its generation: no new epoch, a missing baseline is still not a change', () => {
    expect(fingerprintSourceFrequencies(payload(true), { codedShare: true }).epoch).toBe(0)
  })
})

describe('sourceFrequencyDrawsCodedShare (#1529 D94)', () => {
  const params = (chart_type: string, value_mode: string, denominator_mode: string, tab = 'descriptives') =>
    extractQualComputeParams({
      tab, code_mode: 'codes', code_ids: [2, 3], chart_type, value_mode, denominator_mode,
    })

  it('the summary table always draws one (*% of Coded*)', () => {
    expect(sourceFrequencyDrawsCodedShare(params('summary', 'count', 'total'))).toBe(true)
  })

  it('a heatmap, bar or stacked bar only under Proportion · Coded only', () => {
    for (const chart of ['heatmap', 'bar', 'stacked_bar']) {
      expect(sourceFrequencyDrawsCodedShare(params(chart, 'segment_proportion', 'coded'))).toBe(true)
      expect(sourceFrequencyDrawsCodedShare(params(chart, 'segment_proportion', 'total'))).toBe(false)
      expect(sourceFrequencyDrawsCodedShare(params(chart, 'count', 'coded'))).toBe(false)
      expect(sourceFrequencyDrawsCodedShare(params(chart, 'text_coverage', 'coded'))).toBe(false)
    }
  })

  it('no other kind draws one', () => {
    expect(sourceFrequencyDrawsCodedShare(params('saturation', 'segment_proportion', 'coded'))).toBe(false)
    expect(sourceFrequencyDrawsCodedShare(params('heatmap', 'segment_proportion', 'coded', 'relationships')))
      .toBe(false)
  })
})
