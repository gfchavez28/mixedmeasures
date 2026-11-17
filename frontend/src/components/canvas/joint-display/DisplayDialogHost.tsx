/**
 * The joint display's dialogs, hosted OUTSIDE its node view (`display-store.ts` says why: opening
 * any modal dialog on the Canvas makes ProseMirror re-create the node view, and a dialog the view
 * owned unmounted in the commit it mounted). The Canvas page mounts this around the Writing view;
 * a node view asks for a dialog through `useDisplayDialogs()` and the dialog writes back through
 * `commitDisplay`, to whichever view of that display is live when it submits.
 *
 * No host (the read-only Compare view) means no dialog: the node view then offers no control
 * that would open one — a read-only surface offers none anyway (#893).
 */
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { JointDisplayPin } from '@/lib/joint-display'
import { DISPLAY_NOT_LIVE_TEXT as NOT_LIVE } from '@/lib/joint-display-vocabulary'
import JointDisplayBuilder from './JointDisplayBuilder'
import PinPicker from './PinPicker'
import CaseView from './CaseView'
import { commitDisplay, DialogsContext, type DisplayDialogRequest } from './display-store'

export default function DisplayDialogHost({ projectId, children }: { projectId: number; children: ReactNode }) {
  const [request, setRequest] = useState<DisplayDialogRequest | null>(null)
  const close = (open: boolean) => { if (!open) setRequest(null) }

  const pin = (pinned: JointDisplayPin): 'added' | 'duplicate' | 'failed' => {
    if (request?.kind !== 'pin') return 'failed'
    const { rowKey, group } = request
    let outcome: 'added' | 'duplicate' = 'added'
    const live = commitDisplay(request.displayKey, d => {
      const row = d.rows.find(r => r.key === rowKey)
      if (!row) return d
      if (row.pins.some(p => p.group === group && p.excerptId != null && p.excerptId === pinned.excerptId)) {
        outcome = 'duplicate'
        return d
      }
      return { ...d, rows: d.rows.map(r => (r.key === rowKey ? { ...r, pins: [...r.pins, pinned] } : r)) }
    })
    if (!live) { toast.error(NOT_LIVE); return 'failed' }
    return outcome
  }

  return (
    <DialogsContext.Provider value={setRequest}>
      {children}
      {request?.kind === 'edit' && (
        <JointDisplayBuilder
          open
          onOpenChange={close}
          projectId={projectId}
          initial={request.display}
          mode="edit"
          onSubmit={next => { if (!commitDisplay(request.displayKey, () => next)) toast.error(NOT_LIVE) }}
        />
      )}
      {request?.kind === 'pin' && (
        <PinPicker
          open
          onOpenChange={close}
          projectId={projectId}
          display={request.display}
          construct={request.construct}
          group={request.group}
          codes={request.codes}
          scope={request.scope}
          onPin={pin}
        />
      )}
      {request?.kind === 'cases' && (
        <CaseView
          open
          onOpenChange={close}
          projectId={projectId}
          display={request.display}
          rowKey={request.rowKey}
          scope={request.scope}
          noViewer={request.noViewer}
          groupBy={request.groupBy}
          // r5: each edit of the row's misfit is ONE write to the live node (D213).
          onCommit={update => {
            const live = commitDisplay(request.displayKey, d => ({
              ...d, rows: d.rows.map(r => (r.key === request.rowKey ? { ...r, misfit: update(r.misfit) } : r)),
            }))
            if (!live) toast.error(NOT_LIVE)
            return live
          }}
        />
      )}
    </DialogsContext.Provider>
  )
}
