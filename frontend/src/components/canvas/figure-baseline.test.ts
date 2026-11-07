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
import * as baseline from './figure-baseline'
import {
  CURRENT_FIGURE_EPOCH,
  fingerprintComparison,
  fingerprintCooccurrence,
  fingerprintMetrics,
  fingerprintQualComparison,
  fingerprintSourceFrequencies,
  figureDrift,
  figurePredatesBaseline,
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
    const off = { codedShare: false }
    expect(fingerprintSourceFrequencies(src(5), off).hash).not.toBe(fingerprintSourceFrequencies(src(4), off).hash)
  })

  it('survives a source with no coded segments at all', () => {
    // `code_counts` is nullable on the wire.
    expect(() => fingerprintSourceFrequencies({
      sources: [{ source_type: 'document', source_id: 2, coded_segments: 0, code_counts: null }],
      totals: { coded_segments: 0 },
    }, { codedShare: true })).not.toThrow()
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

describe('the qualitative comparison has a fingerprint (#1323 D12)', () => {
  type Q = Parameters<typeof fingerprintQualComparison>[0]
  const qual = (over: { pAdj?: number; share?: number | null; sig?: boolean; correction?: string } = {}): Q => ({
    groups: ['Board', 'Staff'],
    group_totals: { Board: { n: 6 }, Staff: { n: 6 } },
    codes: [
      {
        code_id: 1,
        by_group: {
          Board: { count: 6, proportion: 1, passages: 14 },
          Staff: { count: 0, proportion: 'share' in over ? over.share! : 0, passages: 0 },
        },
        delta_proportion: 1,
        delta_ci: { lower: 0.52, upper: 1 },
        test: { p_value: 0.0022, p_adjusted: over.pAdj ?? 0.0368, significant: over.sig ?? true,
                effect_size: null, can_reach_significance: true },
      },
      {
        code_id: 2,
        by_group: { Board: { count: 1, proportion: 1 / 6, passages: 1 }, Staff: { count: 0, proportion: 0, passages: 0 } },
        delta_proportion: 0.1667,
        delta_ci: { lower: -0.19, upper: 0.56 },
        test: { p_value: 1, p_adjusted: 1, significant: false, effect_size: null, can_reach_significance: false },
      },
    ],
    basis: { unit: 'participant', correction: over.correction ?? 'discrete_holm', family_size: 2 },
  })

  it('stays silent on a reordering of the codes', () => {
    const base = qual()
    expect(fingerprintQualComparison({ ...base, codes: [...base.codes].reverse() }).hash)
      .toBe(fingerprintQualComparison(base).hash)
  })

  it('sees a changed adjusted p, star and correction — what the 1.5.9 upgrade moves', () => {
    const base = fingerprintQualComparison(qual()).hash
    expect(fingerprintQualComparison(qual({ pAdj: 0.0866 })).hash).not.toBe(base)
    expect(fingerprintQualComparison(qual({ sig: false })).hash).not.toBe(base)
    expect(fingerprintQualComparison(qual({ correction: 'holm' })).hash).not.toBe(base)
  })

  it('tells a group with no share (—) from a real 0.0%', () => {
    expect(fingerprintQualComparison(qual({ share: null })).hash)
      .not.toBe(fingerprintQualComparison(qual({ share: 0 })).hash)
  })

  it('heads itself with how many codes carry a star, of how many tested', () => {
    expect(fingerprintQualComparison(qual()).headline).toBe('1 of 2 codes starred')
    const untested = { ...qual(), basis: { unit: 'passage', correction: 'discrete_holm', family_size: 0 } }
    expect(fingerprintQualComparison(untested).headline).toBe('')
  })
})

describe('an embed placed before its kind had a fingerprint speaks (#1323 D12)', () => {
  const qualFigure = fingerprintQualComparison({
    groups: ['Board', 'Staff'],
    group_totals: { Board: { n: 6 }, Staff: { n: 6 } },
    codes: [{
      code_id: 1,
      by_group: { Board: { count: 6, proportion: 1 }, Staff: { count: 0, proportion: 0 } },
      delta_proportion: 1,
      test: { p_value: 0.0022, p_adjusted: 0.0368, significant: true, effect_size: null },
    }],
    basis: { unit: 'participant', correction: 'discrete_holm', family_size: 40 },
  })

  it('says the figures changed, names how, and quotes what it shows now', () => {
    // An embed from before 1.5.9: no baseline, no `figureEpoch`.
    const drift = figureDrift({ hash: null }, qualFigure)
    expect(drift).toMatchObject({ changed: true, was: '', now: '1 of 40 codes starred', stampedAt: null })
    expect(drift!.note).toMatch(/counts participants, not passages/)
    // No version number: whether that release is 1.5.9 or 1.6.0 is undecided.
    expect(drift!.note).not.toMatch(/\d\.\d/)
  })

  it('stays silent for an embed placed under this generation (it seeds instead)', () => {
    expect(figureDrift({ hash: null, epoch: CURRENT_FIGURE_EPOCH }, qualFigure)).toBeNull()
    expect(figurePredatesBaseline({ hash: null, epoch: CURRENT_FIGURE_EPOCH }, qualFigure)).toBe(false)
  })

  it('control: an older kind with no baseline still says nothing (#808 unchanged)', () => {
    expect(figurePredatesBaseline({ hash: null }, fingerprintComparison(comparison()))).toBe(false)
    expect(figureDrift({ hash: null }, fingerprintComparison(comparison()))).toBeNull()
  })

  it('once reviewed, the hash decides — a matching one is silent', () => {
    expect(figureDrift({ hash: qualFigure.hash, epoch: null }, qualFigure)).toBeNull()
  })

  it('no projection is newer than the generation embeds are placed under', () => {
    // A POPULATION check: every fingerprint projection is listed here with a
    // fixture, so a new one cannot ship without deciding its generation.
    const epochs: Record<string, number> = {
      fingerprintComparison: fingerprintComparison(comparison()).epoch,
      fingerprintMetrics: fingerprintMetrics(metrics()).epoch,
      fingerprintSourceFrequencies: fingerprintSourceFrequencies({ sources: [], totals: null }, { codedShare: false }).epoch,
      fingerprintQualComparison: qualFigure.epoch,
      fingerprintCooccurrence: fingerprintCooccurrence(cooccurrence()).epoch,
    }
    const exported = Object.keys(baseline).filter(k => k.startsWith('fingerprint')).sort()
    expect(exported).toEqual(Object.keys(epochs).sort())
    expect(Math.max(...Object.values(epochs))).toBe(CURRENT_FIGURE_EPOCH)
  })
})

const cooccurrence = (ab = 3, n = 8) => ({
  codes: [{ id: 11 }, { id: 12 }],
  matrix: [[5, ab], [ab, 4]],
  n_units: n,
})

describe('a co-occurrence embed has a fingerprint (#1527 D90)', () => {
  it('an embed placed before 1.5.9 says its figures changed, and how', () => {
    // No baseline and no `figureEpoch` (every embed before the attribute), and one placed
    // under the comparison's generation (1) — both predate this kind's fingerprint.
    for (const epoch of [undefined, 1]) {
      const drift = figureDrift({ hash: null, epoch }, fingerprintCooccurrence(cooccurrence()))
      expect(drift).toMatchObject({ changed: true, was: '', now: 'N = 8' })
      expect(drift!.note).toMatch(/one coder applied both/)
      expect(drift!.note).not.toMatch(/\d\.\d/)
    }
  })

  it('an embed placed under this generation seeds instead of speaking', () => {
    const figure = fingerprintCooccurrence(cooccurrence())
    expect(figurePredatesBaseline({ hash: null, epoch: CURRENT_FIGURE_EPOCH }, figure)).toBe(false)
  })

  it('a moved pair or a moved N changes the hash; a reordering of the codes does not', () => {
    const base = fingerprintCooccurrence(cooccurrence())
    expect(fingerprintCooccurrence(cooccurrence(2)).hash).not.toBe(base.hash)
    expect(fingerprintCooccurrence(cooccurrence(3, 9)).hash).not.toBe(base.hash)
    const reordered = { codes: [{ id: 12 }, { id: 11 }], matrix: [[4, 3], [3, 5]], n_units: 8 }
    expect(fingerprintCooccurrence(reordered).hash).toBe(base.hash)
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
