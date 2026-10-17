/**
 * #1140 — which side of the swap a failed restore stopped on, read from the
 * server's `X-MM-Restore-Outcome` header (`routers/backup.py`). The dialog keeps
 * Restore and releases the page only on `not-started`; everything else is read as
 * "may have begun".
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { restoreFailureOutcome } from './backup'

const failure = (headers: Record<string, string>) => new ApiError(500, { detail: 'x' }, headers)

describe('restoreFailureOutcome', () => {
  it('reads not-started — nothing was changed', () => {
    expect(restoreFailureOutcome(failure({ 'x-mm-restore-outcome': 'not-started' })))
      .toEqual({ side: 'not-started', preRestoreTakenAt: null })
  })

  it('reads partway, with the pre-restore backup’s time when the server sent it', () => {
    expect(restoreFailureOutcome(failure({
      'x-mm-restore-outcome': 'partway',
      'x-mm-pre-restore-taken-at': '2026-10-14T12:12:45+00:00',
    }))).toEqual({ side: 'partway', preRestoreTakenAt: '2026-10-14T12:12:45+00:00' })
    expect(restoreFailureOutcome(failure({ 'x-mm-restore-outcome': 'partway' })))
      .toEqual({ side: 'partway', preRestoreTakenAt: null })
  })

  it('is UNKNOWN without the header, with a value it does not know, and with no answer at all', () => {
    for (const err of [
      failure({}),
      failure({ 'x-mm-restore-outcome': 'maybe' }),
      new TypeError('Failed to fetch'),
      null,
    ]) {
      expect(restoreFailureOutcome(err)).toEqual({ side: 'unknown', preRestoreTakenAt: null })
    }
  })

  it('ignores a taken-at that rides anything but a partway failure', () => {
    expect(restoreFailureOutcome(failure({
      'x-mm-restore-outcome': 'not-started',
      'x-mm-pre-restore-taken-at': '2026-10-14T12:12:45+00:00',
    })).preRestoreTakenAt).toBeNull()
  })

  it('reads the names client.ts actually builds — lower-case, from a real Headers', () => {
    // `request()` turns the response's `Headers` into a record by iterating it, and
    // iteration yields lower-case names whatever the server wrote (Fetch spec).
    const built: Record<string, string> = {}
    new Headers({ 'X-MM-Restore-Outcome': 'not-started' }).forEach((v, k) => { built[k] = v })
    expect(restoreFailureOutcome(failure(built)).side).toBe('not-started')
  })
})
