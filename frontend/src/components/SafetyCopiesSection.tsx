/**
 * #919 — Settings › Backup & Data: the safety copies taken before a merge or an
 * overwrite, with their sizes, a way to get each one back, and a way to delete it.
 *
 * Before this, every in-place import wrote a full copy of the project into the
 * backup folder and nothing listed, rotated or even located them: the recovery
 * instruction said "import that file" about a file in a folder the app never shows
 * (on the desktop build it is under the OS's per-user application data).
 *
 * ⚠️ **Download is the recovery path, not an extra.** A copy is a `.mmproject`, so
 * it comes back through Import Project, which needs the file on disk somewhere the
 * researcher can pick it. Without Download this list could only offer deletion.
 *
 * ⚠️ **Nothing here deletes on its own** — rotation is undecided (#919), because
 * five copies may be five different projects. The researcher sees each one and
 * chooses, and the confirmation says when a copy may be a project's only one.
 *
 * 🔴 **The list is BOUNDED (#978).** It used to render every copy: measured live
 * on the developer's own Settings page, 1,954 rows, 3,941 tab stops and 37,361
 * DOM nodes — so a keyboard user who opened this disclosure met ~3,900 controls
 * inside a 320px box before reaching anything below it. A `max-height` scroll box
 * is NOT a bound; it is what made the cost invisible until it was counted. The
 * server bounds the payload too, because each row's project name comes from that
 * copy's manifest and reading one means opening the zip.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Download, LoaderCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { backupApi, type SafetyCopyInfo } from '@/lib/api'
import { ApiError } from '@/lib/api/client'
import { formatBytes, plural } from '@/lib/format'
import { useListLoad } from '@/hooks/useListLoad'
import { LoadFailedNotice } from '@/components/LoadStatus'
import {
  SAFETY_COPIES_QUERY_KEY,
  SAFETY_COPY_ACT_LABEL,
  SAFETY_COPY_PAGE_SIZE,
  formatTakenAt,
  safetyCopyDeleteWarnings,
  safetyCopyTitle,
} from '@/lib/safety-copies'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'

export default function SafetyCopiesSection() {
  const queryClient = useQueryClient()
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // `0` asks the server for every copy. Part of the query key, so asking for all
  // of them is a new request rather than a cache write (#800's exact-vs-prefix
  // trap: `invalidateQueries` on the parent key still reaches both).
  const [pageSize, setPageSize] = useState<number>(SAFETY_COPY_PAGE_SIZE)
  // The copy being confirmed outlives `confirmOpen`, so the dialog keeps its
  // words while it animates closed instead of flashing an empty description.
  const [deleteTarget, setDeleteTarget] = useState<SafetyCopyInfo | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  // Set when a confirmation actually deleted something: the Delete button that
  // opened the dialog is gone with its row, so focus must land somewhere real.
  const returnFocusToToggle = useRef(false)

  const copiesQuery = useQuery({
    queryKey: [...SAFETY_COPIES_QUERY_KEY, pageSize],
    queryFn: () => backupApi.listSafetyCopies(pageSize),
    staleTime: 60_000,
    // #1038 (f): Show all changes the key, so with nothing to show while the new
    // key loaded the whole section returned null — the button the keyboard user
    // had just pressed unmounted and focus fell to <body>. The page already on
    // screen stays while the rest loads. That is not list-load-state §1's false
    // claim: its rows are the newest of the full answer, and the line above them
    // still says "Showing the 50 most recent of N" beside a busy button.
    placeholderData: keepPreviousData,
  })
  const load = useListLoad(copiesQuery)
  const page = copiesQuery.data
  const copies = page?.copies
  const showingAllLoads = pageSize === 0 && copiesQuery.isPlaceholderData

  // "Show all" unmounts itself once every copy is shown, which would drop a
  // keyboard user's focus to <body> (#955's class). Like the Participants page's
  // "Show more", the press moves focus to the FIRST copy it revealed — where
  // reading continues anyway — once that row exists.
  const listRef = useRef<HTMLUListElement>(null)
  const focusRowAfterReveal = useRef<number | null>(null)
  useEffect(() => {
    const index = focusRowAfterReveal.current
    if (index === null || copiesQuery.isPlaceholderData) return
    focusRowAfterReveal.current = null
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[]
    const row = rows[index] ?? rows[rows.length - 1]
    ;(row?.querySelector<HTMLButtonElement>('button') ?? toggleRef.current)?.focus()
  }, [copies, copiesQuery.isPlaceholderData])
  // No click guard while it loads: a second press asks for the key already
  // loading, which React Query treats as the same request (mutation-proven: a
  // guard here changed nothing, #941's first meaning).
  const showAll = () => {
    focusRowAfterReveal.current = copies?.length ?? 0
    setPageSize(0)
  }

  const deleteMutation = useMutation({
    mutationFn: (copy: SafetyCopyInfo) => backupApi.deleteSafetyCopy(copy.filename),
    onSuccess: (_data, copy) => {
      returnFocusToToggle.current = true
      toast.success(`Deleted the safety copy of ${safetyCopyTitle(copy)}`)
    },
    onError: (err: Error) => {
      // The server's sentence says WHY (gone already, or held open by another
      // program on Windows); a generic one would hide which.
      toast.error(err instanceof ApiError ? err.message : 'The safety copy could not be deleted.')
    },
    onSettled: () => {
      setConfirmOpen(false)
      // Either way the folder may have changed (a 404 means it was already gone).
      queryClient.invalidateQueries({ queryKey: SAFETY_COPIES_QUERY_KEY })
    },
  })

  const handleDownload = async (copy: SafetyCopyInfo) => {
    setDownloading(copy.filename)
    try {
      await backupApi.downloadSafetyCopy(copy.filename)
    } finally {
      setDownloading(null)
    }
  }

  // Silence would read as "there are none", which is the claim this list exists
  // to stop the app making. The shared notice, not a hand-written line: its
  // wording, its slow-load delay and its Retry are single-sourced (#961 §2), and
  // this section predates them.
  if (load.status === 'failed' || load.retrying) {
    return (
      <div className="mt-3">
        <LoadFailedNotice
          title="Safety copies could not be listed."
          load={load}
          size="panel"
        />
      </div>
    )
  }
  // Nothing to show until a merge or overwrite has written a copy — and nothing
  // while the list is still loading either. ⚠️ That silence is deliberate and is
  // NOT the #961 defect: ABSENCE makes no claim, where a "no safety copies" line
  // would (Tier 1's `AnalysisView` reasoning). Once the list is OPEN it stays
  // mounted when its last copy is deleted, so the toggle survives as the place
  // focus returns to.
  if (!page || !copies || (page.total_count === 0 && !open)) return null

  // Locale-grouped, and from the FOLDER's totals rather than the page's: the
  // trigger states the cost before it is paid, so a bounded list underneath must
  // not make that number smaller than the truth (#978).
  const summary =
    `${page.total_count.toLocaleString()} ${plural(page.total_count, 'copy', 'copies')}, ` +
    formatBytes(page.total_bytes)

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
        {`Safety copies from merges and overwrites (${summary})`}
      </button>

      {open && (
        <div id={listId} className="mt-2 space-y-2">
          <p className="text-xs text-mm-text-secondary leading-relaxed">
            Before a merge or an overwrite changes a project, Mixed Measures saves a full copy
            of it. These copies are never deleted automatically. To go back to one, download
            it and open it with Import Project on the Projects page.
          </p>
          {page.truncated && (
            // Said ABOVE the list, not below it: a researcher who reads to the
            // bottom of a 320px scroll box has already assumed the list is all
            // of them. `role="status"` because it changes when Show all runs.
            <p className="text-xs text-mm-text-muted" role="status">
              Showing the {copies.length.toLocaleString()} most recent of{' '}
              {page.total_count.toLocaleString()}.{' '}
              <button
                type="button"
                onClick={showAll}
                // `aria-disabled`, never `disabled`: Chrome blurs a focused button
                // that becomes disabled (#959 §4). Its refusal is that a second press
                // is the same request (see `showAll`).
                aria-disabled={showingAllLoads || undefined}
                aria-busy={showingAllLoads || undefined}
                className="underline underline-offset-2 hover:text-mm-text aria-busy:cursor-wait aria-busy:opacity-60"
              >
                Show all {page.total_count.toLocaleString()}
              </button>
              {/* Said beside the button, never in its name (#770: no transient
                  state in an accessible name); this paragraph is the status. */}
              {showingAllLoads && ' Loading the rest…'}
            </p>
          )}
          {copies.length === 0 ? (
            <p className="text-xs text-mm-text-faint">No safety copies remain.</p>
          ) : (
            <ul ref={listRef} aria-label="Safety copies" className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
              {copies.map(copy => {
                const title = safetyCopyTitle(copy)
                const takenAt = formatTakenAt(copy.taken_at)
                const isDownloading = downloading === copy.filename
                return (
                  <li
                    key={copy.filename}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-mm-border-subtle bg-mm-bg px-2.5 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="font-medium text-mm-text break-words">{title}</p>
                      <p className="text-mm-text-muted">
                        {SAFETY_COPY_ACT_LABEL[copy.act]} · {takenAt} ·{' '}
                        <span className="tabular-nums">{formatBytes(copy.size_bytes)}</span>
                      </p>
                      {copy.project_in_app === false && (
                        <p className="text-amber-700 dark:text-amber-400">No longer in Mixed Measures</p>
                      )}
                      {!copy.readable && (
                        <p className="text-amber-700 dark:text-amber-400">This file could not be read</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleDownload(copy)}
                        disabled={isDownloading}
                        aria-busy={isDownloading}
                        aria-label={`Download safety copy of ${title}, ${takenAt}`}
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
                          setDeleteTarget(copy)
                          setConfirmOpen(true)
                        }}
                        aria-label={`Delete safety copy of ${title}, ${takenAt}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                        Delete
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this safety copy?"
        description={
          deleteTarget
            ? `${safetyCopyTitle(deleteTarget)}, taken ${SAFETY_COPY_ACT_LABEL[deleteTarget.act].toLowerCase()} on ` +
              `${formatTakenAt(deleteTarget.taken_at)} (${formatBytes(deleteTarget.size_bytes)}). ` +
              'The file is removed from this computer and cannot be brought back.'
            : ''
        }
        confirmLabel="Delete copy"
        loadingLabel="Deleting…"
        loading={deleteMutation.isPending}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget) }}
        onCloseAutoFocus={(event) => {
          if (!returnFocusToToggle.current) return
          returnFocusToToggle.current = false
          event.preventDefault()
          toggleRef.current?.focus()
        }}
        // 🔴 `details`, never `children`: the warning must be part of the dialog's
        // accessible DESCRIPTION. As children it was on screen and silent — Chrome
        // computed the description without "may be the only copy of it anywhere"
        // (a11y-name-sweep run 6, #886's class), on the one control here whose act
        // cannot be undone.
        details={deleteTarget && safetyCopyDeleteWarnings(deleteTarget).length > 0 ? (
          <div
            data-testid="safety-copy-delete-warnings"
            className="rounded border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1"
          >
            {safetyCopyDeleteWarnings(deleteTarget).map(w => (
              <p key={w} className="text-xs text-amber-800 dark:text-amber-300">{w}</p>
            ))}
          </div>
        ) : undefined}
      />
    </div>
  )
}
