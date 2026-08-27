import { describe, it, expect } from 'vitest'
import { placeDotLabels, visibleLabels, estimateLabelWidth } from './dumbbell-labels'

/** The row-level question, expressed on top of the per-label answer. */
const labelsCollide = (p: Parameters<typeof visibleLabels>[0], gap?: number) =>
  visibleLabels(p, gap).some(v => !v)

/**
 * #787 — the dumbbell's inline value labels.
 *
 * ⚠️ **The fixture below is the MEASURED repro, not an invented one.** Pre_Score by
 * Gender, four groups, rendered at x = 294 / 313 / 326 / 564 on one line — read off
 * the live chart, where the three clustered labels came out as `65.5665.7.4`. A
 * fixture with round made-up spacings would sit on one side of the threshold or the
 * other by luck; this one is the case a researcher actually hit.
 *
 * ⚠️ **#428(c)'s guard is what these tests must prove insufficient.** It suppressed
 * on `isJittered && dots > 5`. Here `jitterOffsets` are all zero — the dots are 19px
 * apart, past the 12px dot-collision threshold — and there are four dots, so BOTH
 * halves are false and the old rule allowed the collision through. If a future edit
 * reintroduces a dot-count or jitter proxy, `the measured repro` case fails.
 */

/** The live measurement: four labels, no jitter, one line. */
const REPRO = {
  texts: ['65.1', '66.5', '67.4', '84.0'],
  pixelXs: [294, 313, 326, 564],
  jitterOffsets: [0, 0, 0, 0],
  baseY: 68,
  dotRadius: 6,
  fontSize: 11,
}

describe('estimateLabelWidth', () => {
  /**
   * Calibration, not arithmetic: four-character labels measured 23–28px in the real
   * render via getBoundingClientRect. The estimate must land inside that band or the
   * collision test is answering a different question than the screen is.
   */
  it('lands inside the measured width band for a four-character label', () => {
    const w = estimateLabelWidth('66.5', 11)
    expect(w).toBeGreaterThanOrEqual(23)
    expect(w).toBeLessThanOrEqual(28)
  })

  it('scales with both text length and font size', () => {
    expect(estimateLabelWidth('66.5', 11)).toBeLessThan(estimateLabelWidth('100.0%', 11))
    expect(estimateLabelWidth('66.5', 11)).toBeLessThan(estimateLabelWidth('66.5', 16))
  })
})

describe('visibleLabels', () => {
  it('catches the measured repro that #428(c) let through', () => {
    expect(labelsCollide(placeDotLabels(REPRO))).toBe(true)
  })

  it('leaves well-separated labels alone', () => {
    expect(labelsCollide(placeDotLabels({ ...REPRO, pixelXs: [100, 300, 500, 700] }))).toBe(false)
  })

  it('is false for a single label, which cannot collide with anything', () => {
    expect(labelsCollide(placeDotLabels({
      ...REPRO, texts: ['66.5'], pixelXs: [313], jitterOffsets: [0],
    }))).toBe(false)
  })

  /**
   * ⚠️ The case an x-only test would get wrong. Jitter exists precisely to spread
   * overlapping dots onto different lines; two labels sharing an x-range but sitting
   * on different rows read fine. Suppressing them would be the opposite defect and
   * equally invisible — the chart would simply be missing numbers nobody asked it to
   * drop.
   */
  it('does NOT suppress labels that share an x-range but sit on different lines', () => {
    const placements = placeDotLabels({
      ...REPRO,
      texts: ['65.1', '66.5'],
      pixelXs: [300, 302],
      jitterOffsets: [-10, 10], // top dot labels above, bottom dot labels below
    })
    expect(placements[0].anchor).toBe('middle')
    expect(placements[1].anchor).toBe('middle')
    expect(labelsCollide(placements)).toBe(false)
  })

  /**
   * The decision boundary, pinned in both directions. Two centred four-character
   * labels at font size 11 occupy 26.4px each, so they need 26.4 + LABEL_GAP of
   * separation to read — the rule flips between 29 and 30px apart.
   *
   * ⚠️ A test that only asserts the FAR case passes under a rule that never
   * suppresses anything, and a test that only asserts the NEAR case passes under one
   * that always does. The boundary needs both sides or it pins nothing.
   */
  it('flips at the width of the labels themselves, not at any dot count', () => {
    const at = (gap: number) => labelsCollide(placeDotLabels({
      ...REPRO, texts: ['65.1', '66.5'], pixelXs: [300, 300 + gap], jitterOffsets: [0, 0],
    }))
    expect(at(29)).toBe(true)
    expect(at(30)).toBe(false)
  })

  /**
   * ⚠️ The dots in the repro are 19px apart — comfortably past the 12px at which
   * they would jitter. That is the whole gap #428(c)'s rule could not see: dot
   * geometry said "fine", label geometry said "unreadable", and only the dots were
   * ever consulted.
   */
  /**
   * 🔴 THE VISUAL CHECK'S OWN FINDING. Suppressing per ROW — #428(c)'s remedy, kept
   * verbatim through the first draft of this fix — silenced `84.0` as well, which
   * sits 238px from anything and is the most informative label on the chart. The
   * numbers said the fix worked; the rendered chart said it over-applied.
   */
  it('hides ONLY the labels that collide, keeping the one with room', () => {
    expect(visibleLabels(placeDotLabels(REPRO))).toEqual([false, false, false, true])
  })

  it('suppresses even when the DOTS are far enough apart not to jitter', () => {
    const dotsWouldJitter = Math.abs(REPRO.pixelXs[1] - REPRO.pixelXs[0]) < REPRO.dotRadius * 2
    expect(dotsWouldJitter).toBe(false)
    expect(labelsCollide(placeDotLabels(REPRO))).toBe(true)
  })
})

describe('placeDotLabels', () => {
  it('centres labels above the dots when nothing jittered', () => {
    const p = placeDotLabels(REPRO)
    expect(p.map(x => x.anchor)).toEqual(['middle', 'middle', 'middle', 'middle'])
    expect(p[0].x).toBe(294)
    expect(p[0].y).toBe(68 - 6 - 6)
  })

  it('spreads a jittered row: top above, bottom below, middle to the right', () => {
    const p = placeDotLabels({
      ...REPRO,
      texts: ['a', 'b', 'c'],
      pixelXs: [300, 300, 300],
      jitterOffsets: [-10, 0, 10],
    })
    expect(p[0].y).toBeLessThan(p[1].y)      // top label highest
    expect(p[2].y).toBeGreaterThan(p[1].y)   // bottom label lowest
    expect(p[1].anchor).toBe('start')        // middle pushed right of its dot
    expect(p[1].x).toBeGreaterThan(300)
  })

  /** The box is what the collision test reads; a wrong anchor makes it wrong. */
  it('derives the box from the anchor — centred labels straddle x, start labels begin at it', () => {
    const [centred] = placeDotLabels({ ...REPRO, texts: ['66.5'], pixelXs: [300], jitterOffsets: [0] })
    expect(centred.left).toBeLessThan(300)
    expect(centred.right).toBeGreaterThan(300)

    const jittered = placeDotLabels({
      ...REPRO, texts: ['a', 'b', 'c'], pixelXs: [300, 300, 300], jitterOffsets: [-10, 0, 10],
    })
    expect(jittered[1].left).toBe(jittered[1].x)
  })
})
