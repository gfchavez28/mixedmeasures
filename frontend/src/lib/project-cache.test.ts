/**
 * #1206 — `forgetCachedProjectPages`, the cache half on its own. The doors that
 * call it are pinned by `pages/Dashboard.forget-cache.test.tsx`,
 * `pages/MergeProject.upload.test.tsx` and `MergeProject.run-failure.test.tsx`,
 * the source delete doors (#1226) by `pages/source-delete-forget-cache.*`, and the
 * withdrawal (#1474) by `pages/ParticipantsPage.withdrawal-cache.test.tsx`.
 *
 * ⚠️ The fixture's conversation id (31) is NOT the project id (9): a removal keyed
 * on the project id passes a fixture where the two coincide.
 */
import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { forgetCachedProjectPages } from './project-cache'

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  qc.setQueryData(['project', 9], { name: 'Old copy' })
  qc.setQueryData(['segments', 31], [{ id: 1, text: 'edited after the export' }])
  qc.setQueryData(['text-config', 9], { selected: [4] })
  return qc
}

/** Puts an observer on a query, as a mounted page would. */
function observe(qc: QueryClient, queryKey: unknown[], queryFn: () => Promise<unknown>) {
  const observer = new QueryObserver(qc, { queryKey, queryFn })
  return observer.subscribe(() => {})
}

describe('forgetCachedProjectPages', () => {
  it('removes every query no page is showing — an entity-first key included', () => {
    const qc = seeded()
    forgetCachedProjectPages(qc)
    expect(qc.getQueryData(['project', 9])).toBeUndefined()
    expect(qc.getQueryData(['segments', 31])).toBeUndefined()
    expect(qc.getQueryData(['text-config', 9])).toBeUndefined()
  })

  it('keeps the queries on screen (the project list) — the positive control', () => {
    const qc = seeded()
    qc.setQueryData(['projects'], { projects: [] })
    const unsubscribe = observe(qc, ['projects'], () => Promise.resolve({ projects: [] }))
    forgetCachedProjectPages(qc)
    expect(qc.getQueryData(['projects'])).toEqual({ projects: [] })
    expect(qc.getQueryData(['segments', 31])).toBeUndefined()
    unsubscribe()
  })

  it('refreshActive: the page on screen keeps its data and refetches; the rest is forgotten', async () => {
    const qc = seeded()
    let calls = 0
    qc.setQueryData(['codes', 9], { codes: ['before'] })
    const unsubscribe = observe(qc, ['codes', 9], () => { calls++; return Promise.resolve({ codes: ['after'] }) })
    const before = calls
    forgetCachedProjectPages(qc, { refreshActive: true })
    expect(qc.getQueryData(['segments', 31])).toBeUndefined()
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toBeGreaterThan(before)
    expect(qc.getQueryData(['codes', 9])).toEqual({ codes: ['after'] })
    unsubscribe()
  })

  it('without refreshActive, the page on screen is left alone (the project list needs no refetch)', async () => {
    const qc = seeded()
    let calls = 0
    qc.setQueryData(['projects'], { projects: [] })
    const unsubscribe = observe(qc, ['projects'], () => { calls++; return Promise.resolve({ projects: [] }) })
    const before = calls
    forgetCachedProjectPages(qc)
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toBe(before)
    unsubscribe()
  })
})
