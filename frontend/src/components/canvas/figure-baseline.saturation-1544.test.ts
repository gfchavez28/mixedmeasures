/**
 * #1544 — the saturation curve gains its FIRST fingerprint, at a new generation (3), in the
 * change that alters which sources it walks (canvas the internal design notes: "giving one a fingerprint
 * means raising the generation in the same change" — #1323 D12). Without it every saturation
 * embed placed before the fix would adopt the new curve silently.
 *
 * ⚠️ The generation is per PROJECTION: an embed of ANOTHER kind placed under generation 2
 * must still seed, not speak — the cost of the bump falls on saturation embeds only.
 */
import { describe, expect, it } from 'vitest'
import {
  CURRENT_FIGURE_EPOCH, figureDrift, figurePredatesBaseline, fingerprintCooccurrence,
  fingerprintSaturation,
} from './figure-baseline'

const curve = (steps: [number, number][], categories = false) => ({
  points: steps.map(([added, cumulative], i) => ({
    source_index: i, source_type: i % 2 ? 'document' : 'conversation',
    cumulative_unique_codes: cumulative, new_codes_this_source: added,
  })),
  total_unique_codes: steps.length ? steps[steps.length - 1][1] : 0,
  total_sources: steps.length,
  category_level: categories,
})

describe('a saturation embed has a fingerprint (#1544)', () => {
  it('an embed placed before the fix says its figures changed, and how', () => {
    // No `figureEpoch` (before the attribute), the comparison's (1), the co-occurrence's (2).
    for (const epoch of [undefined, 1, 2]) {
      const drift = figureDrift({ hash: null, epoch }, fingerprintSaturation(curve([[2, 2], [1, 3]])))
      expect(drift).toMatchObject({ changed: true, was: '', now: '2 sources, 3 codes' })
      expect(drift!.note).toMatch(/only the ones selected/)
      expect(drift!.note).not.toMatch(/\d\.\d/) // no version: the release number is undecided
    }
  })

  it('an embed placed under this generation seeds instead of speaking', () => {
    expect(CURRENT_FIGURE_EPOCH).toBe(3)
    expect(figurePredatesBaseline({ hash: null, epoch: CURRENT_FIGURE_EPOCH }, fingerprintSaturation(curve([[1, 1]]))))
      .toBe(false)
  })

  it('control: the bump does not make another kind’s generation-2 embed speak', () => {
    const cooc = fingerprintCooccurrence({ codes: [{ id: 1 }], matrix: [[3]], n_units: 3 })
    expect(figurePredatesBaseline({ hash: null, epoch: 2 }, cooc)).toBe(false)
  })

  it('a moved step or a moved total changes the hash; the headline reads like the summary line', () => {
    const base = fingerprintSaturation(curve([[2, 2], [1, 3]]))
    expect(fingerprintSaturation(curve([[2, 2], [0, 2]])).hash).not.toBe(base.hash)
    expect(fingerprintSaturation(curve([[2, 2], [1, 3], [0, 3]])).hash).not.toBe(base.hash)
    expect(fingerprintSaturation(curve([[2, 2], [1, 3]])).hash).toBe(base.hash)
    expect(fingerprintSaturation(curve([[1, 1]], true)).headline).toBe('1 source, 1 category')
    expect(fingerprintSaturation(curve([])).headline).toBe('0 sources, 0 codes')
  })
})
