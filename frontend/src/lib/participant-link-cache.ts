import type { QueryClient } from '@tanstack/react-query'

/**
 * Everything a change to a participant link can move (#1054 review §4 #5) — ONE
 * set, for every door that links or unlinks: a dataset record's link, a
 * document's subject, and the speakers a conversation import links (#1152).
 *
 * The doors had grown one invalidation set each, and they disagreed: none
 * refreshed the record picker (`['linkable-rows', …]`), so after a link the
 * just-linked record was offered to the next participant for the picker's whole
 * 60 s staleTime and picking it answered 409; some skipped the open participant's
 * detail, the withdrawal summary (a list of what is linked, #1130 c), or the
 * project's participant count, which Link by column moves when it creates people.
 * #1152: the document-subject door and the conversation import refreshed the
 * participant LIST alone, so the panel and the withdrawal report went on saying
 * the person was linked to nothing (reproduced live).
 *
 * Returns the participant-detail refetch, which is when an unlinked record's row —
 * and the control that was focused on it — actually goes (`ParticipantsPage`'s
 * landing waits for it).
 *
 * The doors are found by what they CALL, not listed: `participant-link-cache.test.ts`
 * fails a file that calls a linking request without this.
 */
export function invalidateAfterParticipantLinkChange(
  queryClient: QueryClient,
  projectId: number,
): Promise<void> {
  queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
  queryClient.invalidateQueries({ queryKey: ['withdrawal-report', projectId] })
  queryClient.invalidateQueries({ queryKey: ['linkable-rows', projectId] })
  queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
  queryClient.invalidateQueries({ queryKey: ['projects'] })
  // What the qualitative surfaces can group by participant (#1152): the
  // document-subject door refreshed it by hand for exactly this reason, and
  // routing that door through here must not lose it.
  queryClient.invalidateQueries({ queryKey: ['qual-source-frequencies', projectId] })
  // Every dataset read: the grid's participant column, the record lists.
  queryClient.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('dataset'),
  })
  return queryClient.invalidateQueries({ queryKey: ['participant-detail'] })
}
