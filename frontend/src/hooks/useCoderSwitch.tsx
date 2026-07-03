import { useCallback, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { authApi } from '@/lib/api'
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
}

export function useCoderSwitch(opts?: { onSwitched?: () => void }) {
  const { user, refreshAuth } = useAuth()
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
      if (options?.skipConfirm || suppressConfirm) {
        mutate(target.id)
        return
      }
      setDontAsk(false)
      setPending(target)
    },
    [user?.id, mutate],
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
