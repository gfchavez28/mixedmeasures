import { describe, it, expect } from 'vitest'
import { NO_VALUE, formatStat, describeUndefined, undefinedTooltip } from './stat-format'

/**
 * #689 — the client half of "an undefined statistic is null with a reason".
 */
describe('formatStat', () => {
  it('renders a real measured zero, and only blanks what has no value', () => {
    // The whole point of the convention: `0.00` must keep meaning "measured
    // zero" now that "not computable" has its own rendering. A `value ? … : —`
    // shortcut here would re-create the defect the backend just removed.
    expect(formatStat(0)).toBe('0.00')
    expect(formatStat(-0)).toBe('0.00')
    expect(formatStat(0.004)).toBe('0.00')
    expect(formatStat(null)).toBe(NO_VALUE)
    expect(formatStat(undefined)).toBe(NO_VALUE)
  })

  it('blanks a non-finite number rather than printing Infinity', () => {
    // Defence in depth: the server no longer sends these, but a stale cached
    // payload or a future endpoint should not render "Infinity" at a user.
    expect(formatStat(Number.NaN)).toBe(NO_VALUE)
    expect(formatStat(Number.POSITIVE_INFINITY)).toBe(NO_VALUE)
  })

  it('honours the requested precision', () => {
    expect(formatStat(0.12345, 3)).toBe('0.123')
  })
})

describe('describeUndefined', () => {
  it('has a distinct sentence for every reason the server can send', () => {
    const reasons = ['insufficient_n', 'empty_group', 'no_variance', 'degenerate']
    const sentences = reasons.map(r => describeUndefined(r))
    expect(sentences.every(Boolean)).toBe(true)
    // Distinct, because they are distinct facts: "only one person answered"
    // and "everyone gave the same answer" lead to different next actions.
    expect(new Set(sentences).size).toBe(reasons.length)
  })

  it('returns null for an unknown code rather than inventing a sentence', () => {
    // A newer backend sending a reason this client does not know must degrade
    // to saying nothing, never to a confident wrong explanation.
    expect(describeUndefined('some_future_reason')).toBeNull()
    expect(describeUndefined(null)).toBeNull()
    expect(describeUndefined('')).toBeNull()
  })

  it('falls back to a neutral tooltip when the reason is unknown', () => {
    expect(undefinedTooltip('no_variance')).toContain('identical')
    expect(undefinedTooltip('some_future_reason')).toBe('Not computable for this data.')
  })
})
