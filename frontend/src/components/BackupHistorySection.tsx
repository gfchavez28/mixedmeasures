/**
 * #971 — Settings › Backup & Data › Backup history: the backups this copy of
 * Mixed Measures made, and what can be done with each one.
 *
 * 🔴 **This list is the fix, not a convenience.** `create_backup` has no size
 * limit; restore accepted only an UPLOAD, capped at 500 MB. So an instance could
 * reach a size where it wrote backups it could not read back through its own UI —
 * and the COMPLETE backup, the one a careful researcher takes by hand before
 * something risky, is the likeliest to exceed the cap, because the automatic ones
 * exclude video to stay small. Restoring from here sends nothing over the wire.
 *
 * 🔴 **It also makes the app's own recovery instruction followable.** When a
 * restore fails partway the server says the previous data was saved as a named
 * backup and to restore that — an instruction for which there was no mechanism,
 * at the single worst moment there is.
 *
 * ⚠️ **Restore is the PARENT's**, because the confirmation dialog is shared with
 * the upload door: one preview, one set of warnings, one confirmation, whichever
 * way the researcher came. This component owns only listing, download and delete.
 *
 * ⚠️ Nothing but the `auto` and `shutdown` rotations deletes anything on its own,
 * so without Delete the folder can only grow — and it is not reachable from a
 * file manager on the desktop build.
 */
import { useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, ChevronDown, ChevronUp, Download, LoaderCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { backupApi, type BackupInfo } from '@/lib/api'
import { serverDetailMessage } from '@/lib/api/error-utils'
import { formatBytes, formatRelativeTime } from '@/lib/format'
import { formatTakenAt } from '@/lib/safety-copies'
import { backupRowName, backupTitle, describeBackup, isLastOfItsKind } from '@/lib/backup-history'
import { useListLoad } from '@/hooks/useListLoad'
import { LoadState } from '@/components/LoadStatus'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'

export default function BackupHistorySection({
  onRestore,
  restoreBusy = false,
}: {
  /** Opens the shared restore preview + confirmation for this backup. */
  onRestore: (backup: BackupInfo) => void
  /** A restore or a preview is already running, from either door. */
  restoreBusy?: boolean
}) {
  const queryClient = useQueryClient()
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  // Set when a confirmation actually deleted something: the Delete button that
  // opened the dialog is gone with its row, so focus must land somewhere real.
  const returnFocusToToggle = useRef(false)

  const backupsQuery = useQuery({
    queryKey: ['backup-list'],
    queryFn: backupApi.list,
    staleTime: 60_000,
    enabled: open,
  })
  // ⚠️ **The disabled case is decided FIRST.** A query that is `enabled: false`
  // with nothing cached reads `loading` FOREVER — the trap #963's Tier 3 hit
  // three times in one round — so the status is only consulted inside the
  // `open` branch below, where the query is running.
  const load = useListLoad(backupsQuery)
  const backups = backupsQuery.data

  const deleteMutation = useMutation({
    mutationFn: (backup: BackupInfo) => backupApi.deleteArchive(backup.filename),
    onSuccess: (_data, backup) => {
      returnFocusToToggle.current = true
      toast.success(`Deleted the backup from ${formatTakenAt(backup.created_at)}`)
    },
    onError: (err: Error) => {
      // The server's sentence says WHY — already gone, or held open by another
      // program on Windows. A generic one would hide which.
      toast.error(serverDetailMessage(err) || 'The backup could not be deleted.')
    },
    onSettled: () => {
      setConfirmOpen(false)
      // Either way the folder may have changed, and the status line above counts
      // and sizes these files.
      queryClient.invalidateQueries({ queryKey: ['backup-list'] })
      queryClient.invalidateQueries({ queryKey: ['backup-status'] })
    },
  })

  const handleDownload = async (backup: BackupInfo) => {
    setDownloading(backup.filename)
    try {
      await backupApi.downloadArchive(backup.filename)
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="mt-3">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex items-center gap-1 text-left text-xs text-mm-text-muted hover:text-mm-text transition-colors"
      >
        {open ? (
          <ChevronUp className="w-3 h-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
        )}
        {/* ONE text node: a space inside a child span is trimmed out of the
            computed name (#954). */}
        {'Backup history'}
      </button>

      {open && (
        <div id={listId} className="mt-2">
          {load.status !== 'ready' ? (
            // It used to render NOTHING while loading and nothing at all if the
            // request failed. Silence reads as "still thinking", which is worse
            // than a wrong sentence because nothing invites a retry (#963 Tier 3).
            <LoadState
              load={load}
              loadingLabel="Loading your backups…"
              failedTitle="Your backups could not be listed."
              size="panel"
            />
          ) : (backups ?? []).length === 0 ? (
            <p className="text-xs text-mm-text-faint py-1">
              No backups yet. Use Backup now to create your first snapshot.
            </p>
          ) : (
            <>
              <p className="text-xs text-mm-text-secondary leading-relaxed mb-2">
                Restoring replaces everything in Mixed Measures with the contents of that
                backup. A copy of your current data is saved first, and appears in this list.
              </p>
              <ul aria-label="Backup history" className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {(backups ?? []).map(backup => {
                  const kind = describeBackup(backup)
                  const takenAt = formatTakenAt(backup.created_at)
                  // Every control's name identifies its ROW. A column of buttons
                  // all named "Restore" is unusable to a screen reader, and
                  // dangerous here: what distinguishes two backups is WHEN they
                  // were taken, so that is what the name carries — to the second,
                  // for the same reason the safety copies' names do (#919).
                  const rowName = backupRowName(backup, takenAt)
                  const isDownloading = downloading === backup.filename
                  return (
                    <li
                      key={backup.filename}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-mm-border-subtle bg-mm-bg px-2.5 py-2 text-xs"
                    >
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="font-medium text-mm-text">
                          {kind.label} · <span className="tabular-nums">{takenAt}</span>
                        </p>
                        <p className="text-mm-text-muted">
                          {kind.description} · {formatRelativeTime(backup.created_at)} ·{' '}
                          <span className="tabular-nums">{formatBytes(backup.size_bytes)}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => { if (!restoreBusy) onRestore(backup) }}
                          // `aria-disabled` + a click guard, never `disabled`:
                          // Chrome blurs a focused button that becomes disabled
                          // (#754/#959 §4), and a preview takes seconds on a
                          // large backup.
                          aria-disabled={restoreBusy || undefined}
                          aria-label={`Restore from ${rowName}`}
                        >
                          <ArchiveRestore className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                          Restore
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => handleDownload(backup)}
                          disabled={isDownloading}
                          aria-busy={isDownloading}
                          aria-label={`Download ${rowName}`}
                        >
                          {isDownloading ? (
                            <LoaderCircle className="w-3.5 h-3.5 mr-1 animate-spin" aria-hidden="true" />
                          ) : (
                            <Download className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                          )}
                          Download
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                          onClick={() => {
                            setDeleteTarget(backup)
                            setConfirmOpen(true)
                          }}
                          aria-label={`Delete ${rowName}`}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                          Delete
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this backup?"
        description={
          deleteTarget
            ? `The ${backupTitle(deleteTarget, formatTakenAt(deleteTarget.created_at))} ` +
              `(${formatBytes(deleteTarget.size_bytes)}). ` +
              'The file is removed from this computer and cannot be brought back.'
            : ''
        }
        confirmLabel="Delete backup"
        loadingLabel="Deleting…"
        loading={deleteMutation.isPending}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget) }}
        onCloseAutoFocus={(event) => {
          if (!returnFocusToToggle.current) return
          returnFocusToToggle.current = false
          event.preventDefault()
          toggleRef.current?.focus()
        }}
        // 🔴 `details`, never `children`: as children the warning is on screen and
        // SILENT — Chrome computes the dialog's description without it (#886's
        // class), on the one control here whose act cannot be undone.
        details={deleteTarget && isLastOfItsKind(deleteTarget, backups) ? (
          <div
            data-testid="backup-delete-warning"
            className="rounded border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2"
          >
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {/* #1132 — quoted: three of the five labels are phrases, so the
                  lower-cased form read "the only before a restore backup". */}
              This is the only “{describeBackup(deleteTarget).label}” backup you
              have. Deleting it leaves nothing to go back to from that point.
            </p>
          </div>
        ) : undefined}
      />
    </div>
  )
}
