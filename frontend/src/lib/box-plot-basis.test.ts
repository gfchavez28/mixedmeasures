/**
 * #522b — the box plot states which conventions drew it.
 *
 * ⚠️ Written 2026-08-22, during the #792 statistics offload. `box-plot-basis.ts`
 * was the ONE stated-basis member with no frontend test, while every sibling
 * (`ci-label`, `aggregate-basis`, `split-basis`, `saturation-ordering`,
 * `assumption-basis`, `qq-basis`) had one. The backend contract test
 * (`test_box_summary.py::TestCrossLanguageContract`) reads this module's source
 * for drift in the CONSTANTS — it cannot see what `describeBoxBasis` does with
 * them, which is the half a reader actually meets.
 */
import { describe, it, expect } from 'vitest'
import {
  QUARTILE_METHOD_TYPE7,
  WHISKER_RULE_TUKEY,
  describeBoxBasis,
} from './box-plot-basis'

describe('describeBoxBasis', () => {
  it('says nothing when there is no basis', () => {
    // A payload predating the field. Silence, not an invented convention.
    expect(describeBoxBasis(null)).toBe('')
  })

  it('names both conventions the figure depends on', () => {
    const text = describeBoxBasis({
      quartile_method: QUARTILE_METHOD_TYPE7,
      whisker_rule: WHISKER_RULE_TUKEY,
    })
    expect(text).toContain('type 7')
    expect(text).toContain('1.5 × IQR')
    // Several quartile definitions exist and disagree on small samples, so the
    // reader needs to know WHICH — naming only the whisker rule is half a basis.
    expect(text).toMatch(/^Quartiles/)
  })

  /**
   * 🔴 The load-bearing case. A newer server sending a convention this build does
   * not know must NOT have it quietly described as type 7 — that is a false
   * statement about how the figure was drawn, and it is worse than saying
   * nothing, because the whole module exists to make the drawing reproducible.
   */
  it('reports an unknown convention verbatim rather than relabelling it', () => {
    const text = describeBoxBasis({
      quartile_method: 'type6_weibull',
      whisker_rule: 'min_max',
    })
    expect(text).toContain('type6_weibull')
    expect(text).toContain('min_max')
    expect(text).not.toContain('type 7')
    expect(text).not.toContain('1.5 × IQR')
  })

  it('does not let one known half vouch for an unknown other half', () => {
    // Mixed: a known quartile method with an unrecognised whisker rule. The known
    // half must not suppress the honest reporting of the unknown one.
    const text = describeBoxBasis({
      quartile_method: QUARTILE_METHOD_TYPE7,
      whisker_rule: 'two_sd',
    })
    expect(text).toContain('type 7')
    expect(text).toContain('two_sd')
    expect(text).not.toContain('1.5 × IQR')
  })
})
