import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import ParticipantLinkNote from '@/components/ParticipantLinkNote'
import { Button } from '@/components/ui/button'
import LongWaitStatus from '@/components/LongWaitStatus'
import { datasetsApi, retryUnanswered, type ParticipantLinkReport } from '@/lib/api'
import { loadFailureReason } from '@/lib/list-status'
import { invalidateAfterParticipantLinkChange } from '@/lib/participant-link-cache'
import { projectHadParticipants } from '@/lib/participant-snapshot'
import {
  linkFailureSentence, linkNothingToDoSentence, linkPreviewDetails, linkPreviewSentence,
} from '@/lib/link-by-column-copy'

/** How a Link by column ended — rendered by the page, where it stays until dismissed. */
export type LinkByColumnOutcome =
  | { kind: 'linked'; columnLabel: string; report: ParticipantLinkReport; hadParticipants: boolean | undefined }
  | { kind: 'failed'; columnLabel: string; message: string }

/**
 * Link by column, asked before it is done (#1054 review D6 / §4 #4, #11).
 *
 * It used to fire on the menu click: no confirmation, no busy state, a 30 s client
 * limit on a request that commits in batches, and a toast that skipped the shared
 * link note. Now: the server's dry run says what WILL happen (`previewLinkByColumn`,
 * the same plan the act writes), the confirm names the count, the wait is said
 * while it runs, and the result goes to `onFinished` for the page to keep on screen.
 *
 * Mounted by the page only while a column is chosen, so the preview is asked fresh
 * each time and nothing of a previous run survives.
 */
export default function LinkByColumnDialog({
  projectId, datasetId, columnId, columnLabel, onClose, onFinished,
}: {
  projectId: number
  datasetId: number
  columnId: number
  columnLabel: string
  onClose: () => void
  onFinished: (outcome: LinkByColumnOutcome) => void
}) {
  const queryClient = useQueryClient()
  const previewQuery = useQuery({
    queryKey: ['link-by-column-preview', projectId, datasetId, columnId],
    queryFn: () => datasetsApi.previewLinkByColumn(projectId, datasetId, columnId),
    // A plan is a claim about the dataset NOW; never serve a cached one.
    staleTime: 0,
    gcTime: 0,
    retry: retryUnanswered,
  })
  const plan = previewQuery.data

  const linkMutation = useMutation({
    mutationFn: async () => {
      const hadParticipants = await projectHadParticipants(queryClient, projectId)
      const report = await datasetsApi.linkByColumn(projectId, datasetId, columnId)
      return { report, hadParticipants }
    },
    onSuccess: ({ report, hadParticipants }) => {
      onFinished({ kind: 'linked', columnLabel, report, hadParticipants })
    },
    onError: (err) => {
      onFinished({ kind: 'failed', columnLabel, message: linkFailureSentence(err) })
    },
    // Settled, not success: a link stopped part-way committed what it had done.
    onSettled: () => {
      void invalidateAfterParticipantLinkChange(queryClient, projectId)
      onClose()
    },
  })

  const busy = linkMutation.isPending
  let description: string
  let details: string[] = []
  let blocked: string | null = null
  let unavailable = false
  if (plan === undefined && previewQuery.isError) {
    description = `What linking by “${columnLabel}” would do could not be worked out. ${loadFailureReason(previewQuery.error)}`
    blocked = 'unavailable: the check did not finish'
  } else if (plan === undefined) {
    description = `Checking what linking by “${columnLabel}” would do…`
    unavailable = true
  } else if (plan.linked === 0) {
    description = linkNothingToDoSentence(plan)
    details = linkPreviewDetails(plan)
    blocked = 'unavailable: nothing to link'
  } else {
    description = linkPreviewSentence(plan, columnLabel)
    details = linkPreviewDetails(plan)
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Link records to participants?"
      description={description}
      details={details.length > 0 ? (
        <ul className="list-disc pl-5 space-y-1 text-sm">
          {details.map((d) => <li key={d}>{d}</li>)}
        </ul>
      ) : undefined}
      destructive={false}
      fitViewport
      confirmLabel={plan && plan.linked > 0 ? `Link ${plan.linked.toLocaleString()} ${plan.linked === 1 ? 'record' : 'records'}` : 'Link'}
      loadingLabel="Linking…"
      loading={busy}
      confirmBlockedReason={blocked}
      confirmUnavailable={unavailable}
      onConfirm={() => linkMutation.mutate()}
    >
      {busy && (
        <LongWaitStatus
          label="Linking records to participants…"
          firstAnnouncement="Linking records to participants. Keep Mixed Measures open until this finishes."
        >
          A large dataset takes a few seconds. Other work stays available meanwhile.
        </LongWaitStatus>
      )}
    </ConfirmDialog>
  )
}

/**
 * The result, kept on the page until dismissed (#1054 review §4 #7). It was a
 * toast, gone in seconds, that skipped the shared link note — no reasons for the
 * records left unlinked, and no warning when nothing matched the people already in
 * the project. A failure is an alert: "stopped part-way, run it again" is an
 * instruction, not news.
 */
export function LinkByColumnOutcomeNotice({
  outcome, projectId, onDismiss,
}: {
  outcome: LinkByColumnOutcome
  projectId: number
  onDismiss: () => void
}) {
  const failed = outcome.kind === 'failed'
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={`mb-3 rounded-md border p-3 text-sm flex items-start gap-3 ${
        failed
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-400'
          : 'border-mm-border-subtle bg-mm-surface'
      }`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {failed ? `Linking by “${outcome.columnLabel}” did not finish` : `Linked by “${outcome.columnLabel}”`}
        </p>
        {failed ? (
          <p>{outcome.message}</p>
        ) : (
          <ParticipantLinkNote
            report={outcome.report}
            projectId={projectId}
            hadParticipants={outcome.hadParticipants}
          />
        )}
      </div>
      <Button variant="ghost" size="sm" className="h-7 px-2 flex-shrink-0" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}
