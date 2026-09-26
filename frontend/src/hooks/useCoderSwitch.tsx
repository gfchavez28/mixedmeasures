import { useCallback, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { authApi } from '@/lib/api'
import { isMachineCoder } from '@/lib/coding-layers'
import { useCoders } from '@/hooks/useCoders'
import { useAuth } from '@/lib/auth-context'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

/**
 * #459/#460 — one shared coder-switch flow reused by every switch surface (TopRail
 * UserMenu, Settings roster, Dashboard). Switching changes WHO you code as, app-wide
 * — the misattribution risk Track J fights — so it goes through a confirm with a
 * "don't ask again this session" opt-out (you switch often during reconciliation, so
 * it must be skippable). Suppression is module-level: it resets on a full reload,
 * which is the natural "this session" boundary for an SPA.
 */
let suppressConfirm = false

interface SwitchTarget {
  id: number
  username: string
  /** Present where the caller has it; absent callers are treated as human. */
  coder_type?: string
}

export function useCoderSwitch(opts?: { onSwitched?: () => void }) {
  const { user, refreshAuth } = useAuth()
  const { coderMap } = useCoders()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<SwitchTarget | null>(null)
  const [dontAsk, setDontAsk] = useState(false)
  const onSwitchedRef = useRef(opts?.onSwitched)
  onSwitchedRef.current = opts?.onSwitched

  const mutation = useMutation({
    mutationFn: (coderId: number) => authApi.switchCoder(coderId),
    onSuccess: async (coder) => {
      await refreshAuth()
      queryClient.invalidateQueries({ queryKey: ['coders'] })
      toast.success(`Coding as ${coder.username}`)
      onSwitchedRef.current?.()
    },
    onError: () => toast.error('Could not switch coder'),
  })
  const mutate = mutation.mutate

  /**
   * Switch to a coder. Re-selecting the active coder is a no-op (just close).
   * Pass `{ skipConfirm: true }` for flows where the choice is already explicit
   * (e.g. immediately after creating a new coder).
   */
  const requestSwitch = useCallback(
    (target: SwitchTarget, options?: { skipConfirm?: boolean }) => {
      if (target.id === user?.id) {
        onSwitchedRef.current?.()
        return
      }
      // 🔴 #989 — never switch to a MACHINE coder. `POST /auth/switch-coder`
      // refuses one with a 404, which surfaces as "Could not switch coder" about
      // a coder plainly visible in the list — and the confirm fires FIRST, so the
      // researcher approves an attribution change that then does not happen.
      // Driven live before the fix, from the TopRail menu.
      //
      // 🔴 IT RESOLVES AGAINST THE ROSTER rather than trusting `target`. Callers
      // pass what they have: the three switcher lists pass a roster `Coder`, but
      // `ReconciliationGrid.fixColleague` passes `{id, name}` built from the
      // reliability payload and carries no `coder_type` at all — so a guard that
      // only read the argument would have been dead code wearing a comment that
      // said otherwise. ⚠️ An unanswered roster resolves to nothing and is
      // treated as human: the server is the authority, and failing open here
      // costs the old confusing error in a rare race rather than blocking a
      // legitimate switch.
      const known = coderMap.get(target.id)
      if (isMachineCoder(known ?? target)) {
        toast.error(`${target.username} is a machine coder — you cannot code as one.`)
        return
      }
      if (options?.skipConfirm || suppressConfirm) {
        mutate(target.id)
        return
      }
      setDontAsk(false)
      setPending(target)
    },
    [user?.id, mutate, coderMap],
  )

  const confirm = useCallback(() => {
    if (!pending) return
    if (dontAsk) suppressConfirm = true
    mutate(pending.id)
    setPending(null)
  }, [pending, dontAsk, mutate])

  const dialog = (
    <ConfirmDialog
      open={pending != null}
      onOpenChange={(o) => { if (!o) setPending(null) }}
      title={`Code as ${pending?.username ?? ''}?`}
      description="This changes who your codings are attributed to, across the whole app, until you switch again."
      confirmLabel={`Code as ${pending?.username ?? ''}`}
      destructive={false}
      onConfirm={confirm}
    >
      <div className="flex items-center gap-2 py-1">
        <Checkbox
          id="coder-switch-dont-ask"
          checked={dontAsk}
          onCheckedChange={(v) => setDontAsk(v === true)}
        />
        <Label htmlFor="coder-switch-dont-ask" className="text-sm cursor-pointer">
          Don't ask again this session
        </Label>
      </div>
    </ConfirmDialog>
  )

  return { requestSwitch, dialog, switching: mutation.isPending }
}
