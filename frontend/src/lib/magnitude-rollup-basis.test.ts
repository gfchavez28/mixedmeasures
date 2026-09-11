import { describe, expect, it } from 'vitest'
import {
  MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
  MANAGED_SPEC_KIND_RATED_TARGETS,
  MANAGED_SPEC_KIND_SCORE,
  describeFreshness,
  describeManagedColumn,
  describeRefresh,
  describeRollupBasis,
  isManagedColumn,
} from './magnitude-rollup-basis'

describe('describeRollupBasis', () => {
  it('puts the known basis in words', () => {
    expect(describeRollupBasis(MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS))
      .toContain('per-passage ratings')
  })

  it('reports an UNKNOWN basis verbatim rather than going silent', () => {
    // The stated-basis family's standing failure: the client's fallback for an
    // unrecognised value is silence — right for a payload that predates the
    // field, invisible for one a NEWER server sends.
    expect(describeRollupBasis('median_of_target_ratings'))
      .toBe('computed as median_of_target_ratings')
  })

  it('renders nothing when there is no basis', () => {
    expect(describeRollupBasis(null)).toBeNull()
    expect(describeRollupBasis(undefined)).toBeNull()
    expect(describeRollupBasis('')).toBeNull()
  })
})

describe('describeManagedColumn', () => {
  it('names the score and states how it was made', () => {
    const words = describeManagedColumn({
      kind: MANAGED_SPEC_KIND_SCORE,
      code_id: 3,
      basis: MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS,
    })
    expect(words).toContain('rating score')
    expect(words).toContain('per-passage ratings')
  })

  it('names the n column without inventing a basis for it', () => {
    // A count is not an aggregate — it has no basis to state, and the server
    // deliberately writes none.
    const words = describeManagedColumn({
      kind: MANAGED_SPEC_KIND_RATED_TARGETS, code_id: 3,
    })
    expect(words).toContain('rated passages')
    expect(words).not.toContain('mean')
  })

  it('says a kind it does not know is tool-maintained, rather than nothing', () => {
    expect(describeManagedColumn({ kind: 'magnitude_spread', code_id: 3 }))
      .toContain('maintains')
  })

  it('returns null for an ordinary column', () => {
    expect(describeManagedColumn(null)).toBeNull()
    expect(describeManagedColumn({})).toBeNull()
  })
})

describe('isManagedColumn', () => {
  it('is false for an ordinary column and true for a tool-maintained one', () => {
    expect(isManagedColumn({})).toBe(false)
    expect(isManagedColumn({ managed_spec: null })).toBe(false)
    expect(isManagedColumn({ managed_spec: {} })).toBe(false)
    expect(isManagedColumn({ managed_spec: { kind: MANAGED_SPEC_KIND_SCORE } })).toBe(true)
  })
})

describe('describeFreshness', () => {
  const now = new Date('2026-09-08T12:00:00Z')

  it('states WHEN, and says so whether or not anything is known to have changed', () => {
    const fresh = describeFreshness(
      { managed_synced_at: '2026-09-08T11:58:00Z', managed_stale: false }, now,
    )
    expect(fresh).toEqual({ label: 'Computed 2 minutes ago', stale: false })
  })

  it('carries the stale flag when the server has one', () => {
    const stale = describeFreshness(
      { managed_synced_at: '2026-09-05T12:00:00Z', managed_stale: true }, now,
    )
    expect(stale).toEqual({ label: 'Computed 3 days ago', stale: true })
  })

  it('🔴 NEVER claims the scores are up to date', () => {
    // The property the whole freshness design rests on, asserted in the channel
    // it lives in (the function's OUTPUT, not the source text — two drafts of a
    // source scan for the phrase failed on this module's own explanatory prose,
    // which is #772's phantom class, and #888 already refuted turning a copy
    // rule into a static gate).
    //
    // `managed_stale === false` means "no trigger has told us otherwise", NOT
    // "this is current": MEASURED, eight input classes move a rating score and
    // no enumeration of write sites covers them all. So the un-stale label is
    // still a bare timestamp.
    for (const stale of [true, false, null, undefined]) {
      const out = describeFreshness(
        { managed_synced_at: '2026-09-08T11:00:00Z', managed_stale: stale }, now,
      )
      expect(out).not.toBeNull()
      const label = out!.label.toLowerCase()
      expect(label).not.toContain('up to date')
      expect(label).not.toContain('up-to-date')
      expect(label).not.toContain('current')
      expect(label).not.toContain('fresh')
      // ...and it always says WHEN, which is the half that can be trusted.
      expect(label).toContain('computed')
    }
  })

  it('treats a missing or unparseable timestamp as "never computed"', () => {
    // A different sentence from "computed a while ago" — the caller shows an
    // empty state, because a table that has never been refreshed has no numbers
    // rather than old ones.
    expect(describeFreshness({}, now)).toBeNull()
    expect(describeFreshness({ managed_synced_at: null }, now)).toBeNull()
    expect(describeFreshness({ managed_synced_at: 'not a date' }, now)).toBeNull()
  })

  it('does not go negative when the clock disagrees', () => {
    // The server writes UTC and the browser may be a few seconds behind it; a
    // "computed -1 minutes ago" label would read as corrupted.
    const out = describeFreshness(
      { managed_synced_at: '2026-09-08T12:00:30Z', managed_stale: false }, now,
    )
    expect(out?.label).toBe('Computed just now')
  })
})

describe('describeRefresh — #923, what the reap destroyed', () => {
  const base = {
    participants_scored: 9,
    participants_coded_unrated: 0,
    excluded_ratings: {},
  }

  it('says when a saved metric went with a reaped score variable', () => {
    // `columns_removed` cannot say this: a column is reaped whether or not
    // anything was built on it, and the chart disappearing is the part the
    // researcher did not ask for.
    const out = describeRefresh({ ...base, metrics_removed: 1 })
    expect(out).toContain('1 saved metric removed')
    expect(out).toContain('whose code is gone')
  })

  it('pluralises', () => {
    expect(describeRefresh({ ...base, metrics_removed: 3 }))
      .toContain('3 saved metrics removed')
  })

  it('says nothing when nothing was removed', () => {
    // The ordinary refresh is the common case; a clause reading "0 saved metrics
    // removed" would make every refresh look like a loss.
    expect(describeRefresh({ ...base, metrics_removed: 0 })).not.toContain('saved metric')
    expect(describeRefresh(base)).not.toContain('saved metric')
  })

  it('is absent rather than NaN on a payload that predates the field', () => {
    // A server one version behind sends no key at all.
    const out = describeRefresh(base)
    expect(out).toBe('Scored 9 participants.')
  })
})
