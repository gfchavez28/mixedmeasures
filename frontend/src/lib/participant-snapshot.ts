/**
 * "Did this project have participants?" — asked as ONE number (#1047).
 *
 * The dataset import wizard needs to know, at the moment an import starts,
 * whether the project already had participants: an import that links every
 * record to a NEW participant against an existing roster usually means the IDs
 * do not line up (#414's identity-pollution callout). It used to fetch the WHOLE
 * participant list for that and read `.length > 0` — 47 MB and 21 s after a
 * large linked import, with every other request held behind it. `GET
 * /projects/{id}` already carries `participant_count`.
 *
 * - **Fresh, never cached** (`staleTime: 0`): participants may have been added on
 *   another page a moment ago, and a cached "none" would suppress the callout —
 *   the unsafe direction.
 * - **A failure is `undefined`, never `false`** (#963): "we could not tell" must
 *   not read as "the project was empty".
 * - **It shares the `['project', id]` cache entry** the layout reads, so asking
 *   also refreshes it.
 */
import type { QueryClient } from '@tanstack/react-query'

import { projectsApi, retryUnanswered } from '@/lib/api'

export async function projectHadParticipants(
  queryClient: QueryClient,
  projectId: number,
): Promise<boolean | undefined> {
  try {
    const project = await queryClient.fetchQuery({
      queryKey: ['project', projectId],
      queryFn: () => projectsApi.get(projectId),
      staleTime: 0,
      retry: retryUnanswered,
    })
    return project.participant_count > 0
  } catch {
    return undefined
  }
}
