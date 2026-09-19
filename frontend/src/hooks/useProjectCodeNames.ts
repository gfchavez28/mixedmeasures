import { useQuery } from '@tanstack/react-query'
import { codesApi, retryUnanswered, type Code } from '@/lib/api'
import { findCodeByName } from '@/lib/code-name'
import { listStatus, type ListStatus } from '@/lib/list-status'

/**
 * The project's code names, for the three create surfaces that had no duplicate
 * check at all (#963's last item): `CreateCodePanel` and `FloatingCreateCode`.
 *
 * ⚠️ A third, `codebook/CreateCodeDialog.tsx`, turned up in the same sweep and had
 * had **no importer since `c215d8ca`** replaced the modal dialogs with panels; it
 * and its orphaned sibling were deleted rather than fixed.
 *
 * 🔴 **A HOOK RATHER THAN A REQUIRED PROP, and the difference from #963 Tier 1 is
 * the point.** Tier 1 put `optionsLoad` on the shared primitive so each call site
 * had to DECIDE its load state. Here there is nothing to decide — every surface
 * wants the same list, including inactive codes — so a prop would only be four
 * chances to thread the wrong thing. What a caller still decides is what it does
 * with an unanswered list; see the note on `status` below.
 *
 * 🔴 **`includeInactive: true`, and the key matches `CodebookSlideOut`'s exactly**
 * (`['codes', projectId, 'all']`), so on the Codebook page React Query serves both
 * from one request. A deactivated code has NOT released its name — reactivating it
 * beside a twin gives two codes a chip cannot tell apart — and the server's refusal
 * counts inactive codes too, so a client list that omitted them would hint "free"
 * for a name the server then refuses.
 *
 * ⚠️ **The workbench panels are deliberately NOT migrated onto this.** They already
 * hold an active-only list for rendering and re-querying with a second scope would
 * be a request per workbench for a hint the server backstops anyway.
 */
export function useProjectCodeNames(projectId: number) {
  const query = useQuery({
    queryKey: ['codes', projectId, 'all'],
    queryFn: () => codesApi.list(projectId, true),
    enabled: !isNaN(projectId),
    retry: retryUnanswered,
  })

  const codes: Code[] = query.data?.codes ?? []
  const status: ListStatus = listStatus(query)

  return {
    codes,
    status,
    /**
     * The colliding code, or `undefined` — and `undefined` while the list is
     * UNANSWERED, which is a deliberate choice rather than an oversight.
     *
     * 🔴 **The hint is ADVISORY; the guard is the server.** `create_code` refuses
     * a duplicate with a 409 naming the existing code, so a surface does not need
     * to block its Create button while this list loads: the worst case is a round
     * trip and a message instead of an inline sentence. That is why these three
     * surfaces do not take §3's "no create affordance until ready" treatment — the
     * act no longer depends on this list at all.
     *
     * ⚠️ So a caller must gate the SENTENCE on a real match, never on the absence
     * of one: "no duplicate found" and "we have not looked" are the same value
     * here, and only the first may be said out loud.
     *
     * ⚠️ **An explicit `status === 'ready'` gate was written here and DELETED after
     * mutation-testing showed it could not fail** (#941's rule). `listStatus` is
     * `'ready'` exactly when `data !== undefined`, so in every non-ready state
     * `codes` is `[]` and the search returns `undefined` on its own. Re-adding the
     * gate would be a clause no test can hold; the property it was guarding is
     * stated above instead.
     */
    duplicateOf: (name: string): Code | undefined => findCodeByName(codes, name),
  }
}
