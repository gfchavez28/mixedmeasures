import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  WITHDRAWN_CONFIRM_LABEL, WITHDRAWN_CONFIRM_TITLE, type WithdrawnConfirmWording,
} from '@/lib/withdrawn-identifier'

const CREATE_WORDING: WithdrawnConfirmWording = {
  title: WITHDRAWN_CONFIRM_TITLE,
  confirmLabel: WITHDRAWN_CONFIRM_LABEL,
}

/**
 * #1190 (D12) — the confirm `lib/withdrawn-identifier.ts::createConfirmingWithdrawn`
 * asks through. Returns `ask` (pass it to the helper) and the `dialog` element (render it
 * where the create happens).
 *
 * - `components/ConfirmDialog` — the `components/ui` wrapper, so focus goes back to
 *   the control the create was pressed from (the internal design notes); a caller
 *   keeps that control FOCUSABLE while the request runs (`aria-disabled`, never
 *   `disabled`), or there is no opener to return to.
 * - The description is the SERVER's sentence, verbatim — it is the one that knows why.
 * - Not destructive: creating a participant destroys nothing, and red on the confirm
 *   would be a claim about the act (#912). The override is the decision, so it is
 *   named for what it does: "Create anyway".
 * - The message is KEPT after the dialog closes: its content fades out for 200 ms, and a
 *   description built from cleared state read empty while it did (#1139's title case).
 * - An unmount while asking answers "no", so the awaiting create never hangs.
 * - `ask(sentence, wording?)`: the title and confirm label name the act asked about —
 *   a create by default, a rename with `WITHDRAWN_RENAME_WORDING`. Kept after close for
 *   the message's reason.
 */
export function useWithdrawnIdentifierConfirm() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [wording, setWording] = useState<WithdrawnConfirmWording>(CREATE_WORDING)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const settle = useCallback((ok: boolean) => {
    const resolve = resolver.current
    resolver.current = null
    setOpen(false)
    resolve?.(ok)
  }, [])

  const ask = useCallback((sentence: string, asked: WithdrawnConfirmWording = CREATE_WORDING) =>
    new Promise<boolean>((resolve) => {
      resolver.current?.(false)
      resolver.current = resolve
      setMessage(sentence)
      setWording(asked)
      setOpen(true)
    }), [])

  useEffect(() => () => { resolver.current?.(false) }, [])

  const dialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) settle(false) }}
      title={wording.title}
      description={message}
      confirmLabel={wording.confirmLabel}
      destructive={false}
      onConfirm={() => settle(true)}
    />
  )
  return { ask, dialog }
}
