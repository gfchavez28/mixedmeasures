import { useAuth } from '@/lib/auth-context'
import { useBlindMode } from '@/hooks/useBlindMode'

/**
 * #1608 — the viewer's coder scope for a SERVER read that must follow blind mode:
 * her own id while `withholding`, `undefined` (every coder) otherwise.
 *
 * `scopeReady` is false until the blind state is `settled`, and stays false while
 * withholding with no self id — fail closed: a read with no one to scope to must not
 * fall back to every coder (the Export dialog's D96 rule). A query that sends the
 * scope puts it in its KEY and waits on `scopeReady`.
 *
 * One home for the rule the Data view and the Participants page's profile share
 * (both read the participant table's rating columns). Tests that mount either page
 * mock this hook instead of standing up an AuthProvider and a coder roster.
 */
export function useBlindScope(projectId: number): { coderScope: string | undefined; scopeReady: boolean } {
  const { user } = useAuth()
  const { withholding, settled } = useBlindMode(projectId)
  const self = user?.id ?? null
  return {
    coderScope: withholding && self != null ? String(self) : undefined,
    scopeReady: settled && !(withholding && self == null),
  }
}
