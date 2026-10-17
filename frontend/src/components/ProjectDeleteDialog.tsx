import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import LongWaitStatus from '@/components/LongWaitStatus'
import { Button } from '@/components/ui/button'
import { projectsApi, type Project } from '@/lib/api'
import { deleteFailureSentence, projectContentsSentence } from '@/lib/project-lifecycle-copy'
import { forgetCachedProjectPages } from '@/lib/project-cache'

/**
 * Deleting a project, from the project list (#1035 review §4 #2, #3, #10).
 *
 * It said *"Are you sure you want to delete this project?"* — no name — over a
 * request with the client's 30 s limit, on a delete that took up to 11 minutes on a
 * large project before #1035 and still 11-24 s after. Past the limit the page said
 * "Something went wrong" while the server finished, and a second press queued a
 * second DELETE. Now: no client limit (`projectsApi.delete`), the project and what
 * it holds named, Archive offered as the reversible way to set it aside, the wait
 * said while it runs, and the list refetched however it ended.
 */
export default function ProjectDeleteDialog({
  project,
  onClose,
  onArchive,
}: {
  /** The project to delete; the dialog is open while it is set. */
  project: Project | null
  onClose: () => void
  onArchive: (project: Project) => void
}) {
  const queryClient = useQueryClient()
  const deleteMutation = useMutation({
    mutationFn: (target: Project) => projectsApi.delete(target.id),
    onSuccess: (_result, target) => {
      toast.success(`Deleted “${target.name}”`)
    },
    onError: (err, target) => {
      toast.error(deleteFailureSentence(err, target.name), { duration: 10_000 })
    },
    // Settled, not success: a delete the client stopped waiting for may still
    // have finished, and the list is how the researcher can tell.
    onSettled: () => {
      onClose()
      // #1206: ids are reused, so the next project created can take this one's
      // id and would open on its cached pages (measured: the deleted project's
      // name). Settled for the same reason as the list.
      forgetCachedProjectPages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const contents = project ? projectContentsSentence(project) : null
  const archivable = project?.status === 'active'

  return (
    <ConfirmDialog
      open={project !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Delete this project?"
      description={project ? `“${project.name}” and everything in it will be deleted. This cannot be undone.` : ''}
      details={contents || archivable ? (
        <>
          {contents && <p>{contents}</p>}
          {archivable && (
            <p>To set it aside instead, archive it — an archived project keeps everything and can be brought back.</p>
          )}
        </>
      ) : undefined}
      confirmLabel="Delete project"
      fitViewport
      loading={deleteMutation.isPending}
      loadingLabel="Deleting…"
      onConfirm={() => { if (project) deleteMutation.mutate(project) }}
    >
      {deleteMutation.isPending ? (
        <LongWaitStatus
          label={`Deleting “${project?.name ?? 'the project'}”…`}
          firstAnnouncement="Deleting the project. Keep Mixed Measures open until this finishes."
        >
          A large project takes a little while, and Mixed Measures waits until it is done.
        </LongWaitStatus>
      ) : project && archivable && (
        <div>
          <Button variant="outline" size="sm" onClick={() => { onArchive(project); onClose() }}>
            <Archive className="w-4 h-4 mr-1.5" aria-hidden="true" />
            Archive instead
          </Button>
        </div>
      )}
    </ConfirmDialog>
  )
}
