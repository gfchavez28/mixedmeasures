/**
 * #693 — the scale comparator, and the hole that made it silent.
 *
 * The detector existed as a private helper in `buildGrid`, and its CALLER
 * treated a null signature as "no mismatch". So a 1–5 instrument grouped with a
 * 1–7 instrument raised nothing whenever either side lacked labels — which is
 * the flagship case this issue is about.
 */
import { describe, it, expect } from 'vitest'
import { compareScales, scaleSignature, normalizeScaleLabels } from './scale-comparison'

const col = (points: number | null, labels: string[] | null) =>
  ({ scale_points: points, scale_labels: labels })

describe('scaleSignature', () => {
  it('prefers labels over the point count', () => {
    expect(scaleSignature(col(5, ['Low', 'High']))).toContain('labels:')
  })

  it('falls back to the point count when labels are absent', () => {
    expect(scaleSignature(col(7, null))).toBe('points:7')
  })

  it('is null when the column records no scale at all', () => {
    expect(scaleSignature(col(null, null))).toBeNull()
    expect(scaleSignature(col(null, []))).toBeNull()
  })

  it('treats a reversed encoding of the same labels as the same scale', () => {
    // 1=disagree…5=agree vs 5=disagree…1=agree is one scale, differently
    // numbered — sorting the normalized labels is what makes them compare equal.
    const forward = scaleSignature(col(5, ['Strongly disagree', 'Neutral', 'Strongly agree']))
    const reverse = scaleSignature(col(5, ['Strongly agree', 'Neutral', 'Strongly disagree']))
    expect(forward).toBe(reverse)
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(normalizeScaleLabels([' Agree ', 'DISAGREE'])).toBe(normalizeScaleLabels(['agree', 'disagree']))
  })
})

describe('compareScales', () => {
  it('reports a mismatch between differently-sized scales', () => {
    // The headline case: both are `ordinal`, so no type check can catch it.
    expect(compareScales([col(5, null), col(7, null)])).toBe('mismatch')
  })

  it('reports a mismatch at equal point counts with different labels', () => {
    expect(compareScales([
      col(5, ['Never', 'Rarely', 'Sometimes', 'Often', 'Always']),
      col(5, ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']),
    ])).toBe('mismatch')
  })

  it('reports a match when every known signature agrees', () => {
    expect(compareScales([col(5, null), col(5, null), col(5, null)])).toBe('match')
  })

  /**
   * The hole. `buildGrid`'s caller read a null signature as "nothing to
   * disagree with", so a group whose members record no scale reported clean —
   * indistinguishable, on screen, from a group that was actually checked.
   */
  it('reports UNKNOWN rather than match when fewer than two scales are recorded', () => {
    expect(compareScales([col(null, null), col(null, null)])).toBe('unknown')
    expect(compareScales([col(5, null), col(null, null)])).toBe('unknown')
    expect(compareScales([col(5, null)])).toBe('unknown')
    expect(compareScales([])).toBe('unknown')
  })

  it('still reports a mismatch when a third member records nothing', () => {
    // An unknown member does not rescue a demonstrated disagreement.
    expect(compareScales([col(5, null), col(7, null), col(null, null)])).toBe('mismatch')
  })

  it('does not treat a labelled and an unlabelled column as agreeing', () => {
    // Deliberate: the two give the researcher different actionable information,
    // so the signature shapes are textually distinct even at equal point counts.
    expect(compareScales([col(5, ['Low', 'High']), col(5, null)])).toBe('mismatch')
  })
})
