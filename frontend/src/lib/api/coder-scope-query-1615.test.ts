/**
 * #1615 (the combine) — r2's callers hand the viewer's scope inside a POST's request object, and
 * r1's routes read it from the query string. Sent in the body, the route dropped it without a
 * word (caught by `request-contract.test.ts` on the combined tree: eight POSTs), so a blind
 * coder's quantitative reads would have computed over every coder. `liftCoderIds` moves it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.hoisted(() => vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} })))
vi.mock('./client', () => ({ default: { post: (...a: unknown[]) => post(...a), get: vi.fn() } }))

import { liftCoderIds } from './coder-scope-query'
import { metricsApi } from './metrics'
import { correlationsApi } from './correlations'
import { comparisonsApi } from './comparisons'
import { dataQualityApi } from './data-quality'

beforeEach(() => post.mockClear())

describe('liftCoderIds', () => {
  it('moves the scope out of the body into the query string', () => {
    const [body, params] = liftCoderIds({ column_ids: [1], coder_ids: [7] })
    expect(body).toEqual({ column_ids: [1] })
    expect(params).toEqual({ coder_ids: '7' })
  })

  it('every coder (absent, null or empty) sends no query parameter and an unchanged body', () => {
    const absent: { column_ids: number[]; coder_ids?: number[] | null } = { column_ids: [1] }
    expect(liftCoderIds(absent)).toEqual([{ column_ids: [1] }, undefined])
    expect(liftCoderIds({ column_ids: [1], coder_ids: null })).toEqual([{ column_ids: [1] }, undefined])
    expect(liftCoderIds({ column_ids: [1], coder_ids: [] })).toEqual([{ column_ids: [1] }, undefined])
  })
})

describe('the eight POST doors send the scope where their routes read it', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['quick-compute', () => metricsApi.quickCompute(1, { coder_ids: [7] } as never)],
    ['cross-tabulation', () => metricsApi.crossTabulation(1, { row_column_id: 2, col_column_id: 3, coder_ids: [7] })],
    ['correlation-matrix', () => correlationsApi.correlationMatrix(1, { column_ids: [2], domain_ids: [], correlation_type: 'pearson', bonferroni: false, coder_ids: [7] })],
    ['scatter-matrix', () => correlationsApi.scatterMatrix(1, { column_ids: [2], domain_ids: [], id_type: 'x', coder_ids: [7] })],
    ['group-comparison', () => comparisonsApi.groupComparison(1, { coder_ids: [7] } as never)],
    ['data-quality/summary', () => dataQualityApi.summary(1, { coder_ids: [7] } as never)],
    ['data-quality/patterns', () => dataQualityApi.patterns(1, { coder_ids: [7] } as never)],
    ['data-quality/mcar-test', () => dataQualityApi.mcarTest(1, { coder_ids: [7] } as never)],
  ]
  it.each(cases)('%s: the query carries coder_ids, the body does not', async (path, call) => {
    await call()
    const [url, body, config] = post.mock.calls[0] as [string, Record<string, unknown>, { params?: Record<string, string> }]
    expect(url).toContain(path)
    expect('coder_ids' in body).toBe(false)
    expect(config.params).toEqual({ coder_ids: '7' })
  })
})
