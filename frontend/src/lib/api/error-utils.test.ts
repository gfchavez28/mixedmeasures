/**
 * #956/#957 — the two request-failure predicates a query's `retry` is built on.
 *
 * `isRequestTimeout` answers "did the client stop waiting?" and
 * `retryUnanswered` answers "is a second ask worth anything?". Both are
 * duck-typed, so the fixtures are deliberately a mix of real `DOMException`s,
 * a real `ApiError`, and plain objects shaped like them.
 */
import { describe, it, expect } from 'vitest'
import { ApiError } from './client'
import { isRequestTimeout, retryUnanswered } from './error-utils'

const timeout = () => new DOMException('signal timed out', 'TimeoutError')
const aborted = () => new DOMException('The operation was aborted.', 'AbortError')
const network = () => new TypeError('Failed to fetch')
const serverError = () => new ApiError(500, { detail: 'Internal Server Error' }, {})
const refusal = () => new ApiError(404, { detail: 'Project not found' }, {})

describe('isRequestTimeout', () => {
  it('is true for the client budget and for a hand-aborted signal', () => {
    expect(isRequestTimeout(timeout())).toBe(true)
    expect(isRequestTimeout(aborted())).toBe(true)
  })

  it('reads the NAME, so a plain Error shaped like one counts (callers test with those)', () => {
    expect(isRequestTimeout(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(true)
  })

  it('is false for everything that is not the client giving up', () => {
    expect(isRequestTimeout(network())).toBe(false)
    expect(isRequestTimeout(serverError())).toBe(false)
    expect(isRequestTimeout(new Error('TimeoutError'))).toBe(false) // the word in the MESSAGE is not the name
    expect(isRequestTimeout(null)).toBe(false)
    expect(isRequestTimeout(undefined)).toBe(false)
    expect(isRequestTimeout('TimeoutError')).toBe(false)
  })
})

describe('retryUnanswered', () => {
  it('retries a request that never got an answer — once', () => {
    expect(retryUnanswered(0, network())).toBe(true)
    expect(retryUnanswered(1, network())).toBe(false)
  })

  it('never retries a timeout: the server is still computing the first attempt', () => {
    expect(retryUnanswered(0, timeout())).toBe(false)
    expect(retryUnanswered(0, aborted())).toBe(false)
  })

  it('never retries a request the server ANSWERED, whatever the status', () => {
    expect(retryUnanswered(0, serverError())).toBe(false)
    expect(retryUnanswered(0, refusal())).toBe(false)
    // Duck-typed on `status`, like `isServerRefusal`.
    expect(retryUnanswered(0, { status: 503 })).toBe(false)
  })

  it('treats a failure with no recognisable shape as unanswered (the safe direction)', () => {
    expect(retryUnanswered(0, null)).toBe(true)
    expect(retryUnanswered(0, { status: '500' })).toBe(true)
  })
})
