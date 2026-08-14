/**
 * #678 — the shared interpretation of a bulk-code response.
 *
 * The wording tests are not cosmetic: the sentence is the ONLY signal a coder
 * gets that a batch was trimmed (the post returns 200, so nothing throws and no
 * error toast fires), and it is what stops them re-running work that already
 * landed. Pin what it must say.
 */
import { describe, it, expect } from 'vitest'
import { collectBulkOutcome, describeBulkFailure } from './bulk-code-result'

describe('collectBulkOutcome', () => {
  it('reads the failed ids the server named, for either target shape', () => {
    expect(collectBulkOutcome({ success_count: 2, error_count: 1, failed_segment_ids: [9] }))
      .toMatchObject({ failedIds: [9], succeeded: 2, hasFailures: true })
    expect(collectBulkOutcome({ success_count: 0, error_count: 1, failed_dataset_value_ids: [4] }))
      .toMatchObject({ failedIds: [4], succeeded: 0, hasFailures: true })
  })

  it('reports no failures when the server skipped nothing', () => {
    const out = collectBulkOutcome({ success_count: 3, error_count: 0, failed_segment_ids: [] })
    expect(out.hasFailures).toBe(false)
    expect(out.failedIds).toEqual([])
  })

  it('counts an id once when it failed for several codes, but sums what landed', () => {
    // The multi-code paths fan out into one post PER CODE over the same targets,
    // so a segment that is gone fails in every response. The coder should be told
    // about one segment, not N.
    const out = collectBulkOutcome([
      { success_count: 2, error_count: 1, failed_segment_ids: [9] },
      { success_count: 2, error_count: 1, failed_segment_ids: [9] },
      { success_count: 1, error_count: 2, failed_segment_ids: [9, 10] },
    ])
    expect(out.failedIds).toEqual([9, 10])
    expect(out.succeeded).toBe(5)
  })

  it('treats a response without the failed-id field as no failures', () => {
    // Single applyCode/removeCode responses, and any pre-#678 server, carry no
    // such field — those callers must behave exactly as they did before rather
    // than inventing a warning.
    expect(collectBulkOutcome({ success_count: 1, error_count: 0 }).hasFailures).toBe(false)
    expect(collectBulkOutcome(null).hasFailures).toBe(false)
    expect(collectBulkOutcome([null, undefined]).hasFailures).toBe(false)
  })
})

describe('describeBulkFailure', () => {
  const outcome = (failed: number[], succeeded: number) => ({
    failedIds: failed, succeeded, hasFailures: failed.length > 0,
  })

  it('leads with the shortfall and names what still landed', () => {
    const msg = describeBulkFailure(outcome([9, 10], 8), 'segment', 'apply')
    expect(msg).toContain('2 segments could no longer be found')
    expect(msg).toContain('The other 8 were coded.')
  })

  it('says plainly when nothing landed', () => {
    const msg = describeBulkFailure(outcome([9], 0), 'segment', 'apply')
    expect(msg).toContain('Nothing was coded.')
    expect(msg).not.toContain('The other')
  })

  it('agrees in number for a single target', () => {
    const msg = describeBulkFailure(outcome([9], 1), 'clip', 'apply')
    expect(msg).toContain('1 clip could no longer be found')
    expect(msg).toContain('it may have been changed')
    expect(msg).toContain('The other 1 was coded.')
  })

  it('does not claim things were coded when the action was a removal', () => {
    const msg = describeBulkFailure(outcome([9], 3), 'segment', 'remove')
    expect(msg).toContain('The other 3 were updated.')
    expect(msg).not.toContain('coded')
  })

  it('is not phrased as the coder\'s error', () => {
    const msg = describeBulkFailure(outcome([9], 3), 'text', 'apply')
    expect(msg.toLowerCase()).not.toContain('error')
    expect(msg.toLowerCase()).not.toContain('failed')
  })
})
