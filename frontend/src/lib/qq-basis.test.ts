/**
 * #525b — the reading half of the Q–Q plot's stated basis.
 *
 * The Python side (`tests/test_qq_plot.py::TestCrossLanguageContract`) reads
 * this module's SOURCE for the constants; these tests cover the behaviour that
 * a string match cannot see — chiefly that an unknown convention is reported
 * verbatim rather than relabelled as a known one, which is the failure mode the
 * whole stated-basis family exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import {
  PLOTTING_POSITION_PPOINTS,
  REFERENCE_LINE_QUARTILE,
  describeQQBasis,
  describeStraightness,
  qqAccessibleSummary,
} from './qq-basis'

const basis = {
  plotting_position: PLOTTING_POSITION_PPOINTS,
  reference_line: REFERENCE_LINE_QUARTILE,
}

describe('describeQQBasis', () => {
  it('names the convention and the reference line', () => {
    const s = describeQQBasis(basis)
    expect(s).toContain('ppoints')
    expect(s).toContain('qqline')
  })

  it('states the n switch, because that is why the basis exists', () => {
    // R uses (i − 3/8)/(n + ¼) at n ≤ 10 and (i − ½)/n above it, so a caption
    // that omits the switch describes a convention the server does not use.
    expect(describeQQBasis(basis)).toContain('n ≤ 10')
  })

  it('reports an UNKNOWN convention verbatim instead of relabelling it', () => {
    // A newer server's method must never be described as ppoints(). This is the
    // arm that is correct-by-silence for old payloads and invisible for new ones.
    const s = describeQQBasis({
      plotting_position: 'weibull_i_over_n_plus_1',
      reference_line: 'ols_fit',
    })
    expect(s).toContain('weibull_i_over_n_plus_1')
    expect(s).toContain('ols_fit')
    expect(s).not.toContain('ppoints')
  })

  it('renders nothing at all for a missing basis', () => {
    expect(describeQQBasis(null)).toBe('')
  })
})

describe('describeStraightness', () => {
  it('describes the FIGURE and never recommends a test', () => {
    // #525(c) refused a recommendation engine. The bands say what the picture
    // looks like; they must not say what to do about it.
    for (const v of [0.999, 0.98, 0.8]) {
      const s = describeStraightness(v)!
      expect(s).not.toMatch(/non-?parametric|Mann|Wilcox|should|recommend/i)
    }
  })

  it('separates the bands', () => {
    expect(describeStraightness(0.995)).not.toBe(describeStraightness(0.98))
    expect(describeStraightness(0.98)).not.toBe(describeStraightness(0.8))
  })

  it('is null rather than invented when there is no correlation', () => {
    expect(describeStraightness(null)).toBeNull()
    expect(describeStraightness(NaN)).toBeNull()
  })
})

describe('qqAccessibleSummary', () => {
  const base = { n: 40, ppcc: 0.9942 }

  it('says what the PICTURE shows — the count and the shape', () => {
    const s = qqAccessibleSummary(base)
    expect(s).toContain('40')
    expect(s).toMatch(/close to the line/)
  })

  /**
   * 🔴 The invariant this module exists to hold, found by LISTENING to the
   * rendered page rather than by reading: a `<figcaption>` is ordinary
   * accessible text, so everything in it is already announced. An earlier draft
   * put the correlation and the thinning count in both channels and a screen
   * reader said each of them twice in consecutive sentences.
   */
  it('does NOT restate what the visible figcaption already carries', () => {
    const s = qqAccessibleSummary(base)
    expect(s).not.toContain('0.9942')
    expect(s).not.toMatch(/ppoints|qqline|quartile/i)
    expect(s).not.toMatch(/not plotted|by construction/i)
  })

  it('agrees in NUMBER between the singular and plural arms', () => {
    // Hand-written strings; a mismatch is the kind of thing only a reader hears.
    expect(qqAccessibleSummary({ n: 1, ppcc: null })).toMatch(/1 model residual\./)
    expect(qqAccessibleSummary({ n: 2, ppcc: null })).toMatch(/2 model residuals/)
  })

  it('omits the shape phrase rather than inventing one when ppcc is absent', () => {
    const s = qqAccessibleSummary({ n: 12, ppcc: null })
    expect(s).toMatch(/12 model residuals\./)
    expect(s).not.toMatch(/line/)
  })
})
