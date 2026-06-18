/**
 * Regression tests for structured 409 error parsing on equivalence/domain mutations.
 *
 * Covers:
 * - `parseEquivalenceErrorDetail` extracts the structured detail when present.
 * - `toastEquivalenceError` routes each known error.error string to a tailored
 *   toast (title + description), falling back to a generic message otherwise.
 *
 * Specifically locks in #301's `column_already_linked` shape:
 *   {error: "column_already_linked", message, conflicts: [{column_code, current_group_label, ...}]}
 *
 * The toast text must surface the column code and current group label so the
 * researcher can navigate to the conflicting group without guessing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseEquivalenceErrorDetail, toastEquivalenceError } from './useCrosswalkMutations'
import { ApiError } from '@/lib/api/client'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

import { toast } from 'sonner'

function makeApiError(detail: unknown, status = 409): ApiError {
  // ApiError(status, data, headers) — see frontend/src/lib/api/client.ts.
  // The structured detail lives at response.data.detail.
  return new ApiError(status, { detail }, {})
}

describe('parseEquivalenceErrorDetail', () => {
  it('extracts a structured column_already_linked detail', () => {
    const err = makeApiError({
      error: 'column_already_linked',
      message: 'Column is already linked to a different equivalence group.',
      conflicts: [
        {
          column_id: 7001,
          column_code: 'Q1',
          current_group_id: 12,
          current_group_label: 'Vision',
        },
      ],
    })

    const detail = parseEquivalenceErrorDetail(err)
    expect(detail).not.toBeNull()
    expect(detail?.error).toBe('column_already_linked')
    expect(detail?.message).toContain('already linked')
  })

  it('returns null when the error is not an ApiError', () => {
    expect(parseEquivalenceErrorDetail(new Error('network'))).toBeNull()
  })

  it('returns null when detail is a plain string (not structured)', () => {
    const err = makeApiError('Something went wrong', 500)
    expect(parseEquivalenceErrorDetail(err)).toBeNull()
  })
})

describe('toastEquivalenceError — column_already_linked branch (#301)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a toast with the column code and current group label', () => {
    const err = makeApiError({
      error: 'column_already_linked',
      message: 'Column is already linked to a different equivalence group.',
      conflicts: [
        {
          column_id: 7001,
          column_code: 'Q1',
          current_group_id: 12,
          current_group_label: 'Vision',
        },
      ],
    })

    toastEquivalenceError(err, 'Failed to add column')

    expect(toast.error).toHaveBeenCalledOnce()
    const [title, options] = (toast.error as unknown as { mock: { calls: [string, { description?: string }][] } }).mock.calls[0]
    expect(title).toContain('Q1')
    expect(title).toContain('Vision')
    expect(options?.description).toContain('Unlink')
  })

  it('falls back gracefully when conflicts list is empty', () => {
    const err = makeApiError({
      error: 'column_already_linked',
      message: 'Column is already linked to a different equivalence group.',
      conflicts: [],
    })

    toastEquivalenceError(err, 'Failed to add column')

    expect(toast.error).toHaveBeenCalledOnce()
    const [title] = (toast.error as unknown as { mock: { calls: [string, { description?: string }][] } }).mock.calls[0]
    // Should still surface a usable message without crashing
    expect(title).toContain('This column')
    expect(title).toContain('another group')
  })

  it('falls back gracefully when current_group_label is null (deleted group race)', () => {
    const err = makeApiError({
      error: 'column_already_linked',
      message: 'Column is already linked to a different equivalence group.',
      conflicts: [
        {
          column_id: 7001,
          column_code: 'Q1',
          current_group_id: 12,
          current_group_label: null,
        },
      ],
    })

    toastEquivalenceError(err, 'Failed to add column')

    expect(toast.error).toHaveBeenCalledOnce()
    const [title] = (toast.error as unknown as { mock: { calls: [string, { description?: string }][] } }).mock.calls[0]
    expect(title).toContain('Q1')
    expect(title).toContain('another group')
  })
})
