/**
 * #35 — the reading half of a reliability coefficient's stated basis.
 *
 * The cross-language half (do the constants match `services/reliability_basis.py`,
 * are the exhaustiveness guards still there) is pinned from the PYTHON side by
 * `backend/tests/test_reliability_basis.py`, which reads the source file. This
 * file pins the READING behaviour: absent says nothing, unknown is named, known
 * is described.
 */
import { describe, it, expect } from 'vitest'
import {
  RELIABILITY_FACET_CODERS,
  RELIABILITY_FACET_ITEMS,
  alphaMetricLabel,
  describeAlphaMetric,
  describeReliabilityFacet,
  reliabilityFacetQualifier,
} from './reliability-basis'

describe('reliability facet', () => {
  it('qualifies the two facets with different words', () => {
    const coders = reliabilityFacetQualifier(RELIABILITY_FACET_CODERS)
    const items = reliabilityFacetQualifier(RELIABILITY_FACET_ITEMS)
    expect(coders).toBe('over coders')
    expect(items).toBe('across items')
    expect(coders).not.toBe(items)
  })

  it('says NOTHING for an absent facet — an older payload must not be relabelled', () => {
    expect(reliabilityFacetQualifier(null)).toBeNull()
    expect(reliabilityFacetQualifier(undefined)).toBeNull()
    expect(reliabilityFacetQualifier('')).toBeNull()
    expect(describeReliabilityFacet(null)).toBeNull()
  })

  it('names an unknown facet verbatim rather than dropping it — a newer server is still a fact', () => {
    expect(reliabilityFacetQualifier('occasions')).toBe('over occasions')
    expect(describeReliabilityFacet('occasions')).toBe('Reliability facet: occasions.')
  })

  it('describes the items facet by what it is NOT, since that is the confusion it exists to prevent', () => {
    const sentence = describeReliabilityFacet(RELIABILITY_FACET_ITEMS)!
    expect(sentence).toMatch(/items/)
    expect(sentence).toMatch(/nothing about agreement between people/)
    expect(describeReliabilityFacet(RELIABILITY_FACET_CODERS)).toMatch(/different coders/)
  })
})

describe('alpha metric', () => {
  it('labels a metric with its own word', () => {
    expect(alphaMetricLabel('interval')).toBe('interval')
    expect(alphaMetricLabel('nominal')).toBe('nominal')
    expect(alphaMetricLabel(null)).toBeNull()
  })

  it('explains every known metric, and the interval one names the declared scale', () => {
    for (const metric of ['nominal', 'ordinal', 'interval', 'ratio']) {
      expect(describeAlphaMetric(metric)).toEqual(expect.any(String))
    }
    expect(describeAlphaMetric('interval')).toMatch(/3 and a 4 disagree less than a 3 and a 9/)
    expect(describeAlphaMetric('nominal')).toMatch(/match or they do not/)
  })

  it('says nothing for an absent metric and names an unknown one', () => {
    expect(describeAlphaMetric(undefined)).toBeNull()
    expect(describeAlphaMetric('circular')).toBe('Scored on the circular metric.')
  })
})
