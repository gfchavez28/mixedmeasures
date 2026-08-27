/**
 * #808 — "the figures moved under the prose", and the three ways it could have
 * become noise instead.
 *
 * A marker that fires when nothing a reader can see has changed teaches the
 * researcher to dismiss it — the argument #707(b) makes about the warning
 * channel, one surface over. So the tests that matter here are the ones that
 * assert it stays SILENT: on a recompute that moved no number, on float noise,
 * and on a reordering. The positive case is the easy half.
 */
import { describe, it, expect } from 'vitest'
import {
  fingerprintComparison,
  fingerprintMetrics,
  fingerprintSourceFrequencies,
  figureDrift,
} from './figure-baseline'

const comparison = (mean = 2.31, stat = 690.88) => ({
  groups: ['Under 45', '45 and over'],
  rows: [{
    label: 'Trust A',
    group_stats: [
      { group: 'Under 45', n: 120, mean, sd: 0.5 },
      { group: '45 and over', n: 98, mean: 1.88, sd: 0.6 },
    ],
    test: { test_type: 'one_way_anova', statistic: stat, p: 0.0001 },
  }],
})

const metrics = (n = 218, pct = 47.1) => ([{
  id: 1,
  results: [{
    group_value: null,
    valid_n: n,
    // ⚠️ `computed_at` is exactly the kind of field a naive payload hash would
    // pick up: it moves on every recompute while no figure moves.
    result_data: { counts: { '1': 47, '2': 6 }, percentages: { '1': pct, '2': 6.3 } },
  }],
}])

describe('the fingerprint stays silent when nothing visible moved', () => {
  it('ignores float noise below the display precision', () => {
    const a = fingerprintComparison(comparison(2.31))
    const b = fingerprintComparison(comparison(2.3100000000000005))
    expect(b.hash).toBe(a.hash)
  })

  it('ignores a reordering that moves no number', () => {
    const base = comparison()
    const reordered = {
      groups: ['45 and over', 'Under 45'],
      rows: [{ ...base.rows[0], group_stats: [...base.rows[0].group_stats].reverse() }],
    }
    expect(fingerprintComparison(reordered).hash).toBe(fingerprintComparison(base).hash)
  })

  it('ignores key order inside a metric result', () => {
    const a = fingerprintMetrics([{ id: 1, results: [{ group_value: null, valid_n: 10, result_data: { b: 2, a: 1 } }] }])
    const b = fingerprintMetrics([{ id: 1, results: [{ group_value: null, valid_n: 10, result_data: { a: 1, b: 2 } }] }])
    expect(b.hash).toBe(a.hash)
  })
})

describe('the fingerprint fires when a figure moved', () => {
  it('sees a changed group mean', () => {
    expect(fingerprintComparison(comparison(2.40)).hash)
      .not.toBe(fingerprintComparison(comparison(2.31)).hash)
  })

  it('sees a changed test statistic', () => {
    expect(fingerprintComparison(comparison(2.31, 702.1)).hash)
      .not.toBe(fingerprintComparison(comparison(2.31, 690.88)).hash)
  })

  it('sees a changed percentage in a metric result', () => {
    expect(fingerprintMetrics(metrics(218, 48.9)).hash).not.toBe(fingerprintMetrics(metrics(218, 47.1)).hash)
  })

  it('sees a changed n even when the percentages hold', () => {
    // The n moving while the shares do not is a real, easily-missed change:
    // the prose may quote the sample size.
    expect(fingerprintMetrics(metrics(300)).hash).not.toBe(fingerprintMetrics(metrics(218)).hash)
  })

  it('sees a changed code count on a qualitative chart', () => {
    const src = (count: number) => ({
      sources: [{ source_type: 'observation', source_id: 1, coded_segments: 6, code_counts: { '65': { count } } }],
      totals: { coded_segments: 6 },
    })
    expect(fingerprintSourceFrequencies(src(5)).hash).not.toBe(fingerprintSourceFrequencies(src(4)).hash)
  })

  it('survives a source with no coded segments at all', () => {
    // `code_counts` is nullable on the wire.
    expect(() => fingerprintSourceFrequencies({
      sources: [{ source_type: 'document', source_id: 2, coded_segments: 0, code_counts: null }],
      totals: { coded_segments: 0 },
    })).not.toThrow()
  })
})

describe('the headline is the figure worth a before/after', () => {
  it('names the test statistic for a comparison', () => {
    expect(fingerprintComparison(comparison()).headline).toBe('F = 690.88')
  })

  it('reads at the DISPLAY precision, not the hash precision', () => {
    // Found by driving: the seeded headline read `F = 690.8795` beside a chart
    // printing `690.88`, so a before/after would have quoted a number the
    // researcher never saw.
    expect(fingerprintComparison(comparison(2.31, 690.8795)).headline).toBe('F = 690.88')
    // ...and the HASH still distinguishes them, which is why the two
    // precisions are deliberately different constants.
    expect(fingerprintComparison(comparison(2.31, 690.8795)).hash)
      .not.toBe(fingerprintComparison(comparison(2.31, 690.88)).hash)
  })

  it('is empty rather than invented when no test ran', () => {
    const noTest = { groups: ['A'], rows: [{ label: 'x', group_stats: [{ group: 'A', n: 1, mean: 1 }], test: null }] }
    expect(fingerprintComparison(noTest).headline).toBe('')
  })
})

describe('figureDrift — three states, one of which speaks', () => {
  const current = fingerprintComparison(comparison(2.40))

  it('says nothing without a baseline', () => {
    // Every embed inserted before this shipped. We cannot know what it showed
    // last week, so it makes no claim.
    expect(figureDrift({ hash: null }, current)).toBeNull()
  })

  it('says nothing when the baseline matches', () => {
    expect(figureDrift({ hash: current.hash, headline: current.headline }, current)).toBeNull()
  })

  it('says nothing before the figures have resolved', () => {
    expect(figureDrift({ hash: 'abc' }, null)).toBeNull()
  })

  it('names both figures when they differ', () => {
    const was = fingerprintComparison(comparison(2.31))
    const drift = figureDrift({ hash: was.hash, headline: was.headline, stampedAt: '2026-08-12' }, current)
    expect(drift).toMatchObject({ changed: true, was: 'F = 690.88', stampedAt: '2026-08-12' })
  })
})
