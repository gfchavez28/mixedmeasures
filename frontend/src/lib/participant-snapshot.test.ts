/**
 * #1047 — "did this project have participants?" is asked as a fresh COUNT.
 *
 * The QueryClient mirrors `main.tsx`'s defaults (`staleTime` 60 s, `retry` 1):
 * with React Query's own default of 0 the freshness case below passes whether
 * or not the function asks for a fresh answer, so it would certify nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { projectsApi, type Project } from '@/lib/api'
import { projectHadParticipants } from './participant-snapshot'

function appClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 1000 * 60, retry: 1, retryDelay: 0 } },
  })
}

function project(participant_count: number): Project {
  return { id: 7, participant_count } as Project
}

afterEach(() => vi.restoreAllMocks())

describe('projectHadParticipants', () => {
  it('is true when the project has participants', async () => {
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project(3))
    expect(await projectHadParticipants(appClient(), 7)).toBe(true)
  })

  it('is FALSE — not unknown — for a real zero', async () => {
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project(0))
    expect(await projectHadParticipants(appClient(), 7)).toBe(false)
  })

  it('is UNKNOWN when the question is not answered (#963: never read as empty)', async () => {
    const refusal = Object.assign(new Error('Request failed'), { response: { status: 500 } })
    vi.spyOn(projectsApi, 'get').mockRejectedValue(refusal)
    expect(await projectHadParticipants(appClient(), 7)).toBeUndefined()
  })

  it('asks the server even when a count is cached — a cached "none" would suppress the callout', async () => {
    const client = appClient()
    client.setQueryData(['project', 7], project(0))
    const get = vi.spyOn(projectsApi, 'get').mockResolvedValue(project(5))
    expect(await projectHadParticipants(client, 7)).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('refreshes the entry the project layout reads', async () => {
    const client = appClient()
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project(2))
    await projectHadParticipants(client, 7)
    expect(client.getQueryData<Project>(['project', 7])?.participant_count).toBe(2)
  })
})
