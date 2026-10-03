import { useQuery } from '@tanstack/react-query'
import { codeSetsApi } from '@/lib/api'

/**
 * The project's code sets — ONE query definition for every reader, so the
 * coding surfaces' strip and the code panel's multi-apply check (#1028) share a
 * key and a request instead of each spelling it.
 *
 * ⚠️ Only the sets panel invalidates it. A reader that shows a value's NAME or
 * STATE takes those from the live codes list instead (`withLiveMembers`,
 * #1038 b); membership is what this list is for.
 */
export function useCodeSets(projectId: number) {
  return useQuery({
    queryKey: ['code-sets', projectId],
    queryFn: () => codeSetsApi.list(projectId),
  })
}
