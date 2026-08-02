import { useState, useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Video, Volume2, FileInput, Trash2, Film, Lock } from 'lucide-react'

import { observationsApi } from '@/lib/api'
import type { Observation } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from '@/components/ui/context-menu'
import { formatBytes } from '@/lib/format'
import { formatTimestamp } from '@/lib/utils'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import { SOURCE_KIND_ONE_LINER } from '@/lib/source-kind-copy'

export default function ObservationsListPage() {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchText, setSearchText] = useState('')
  const [deleteId, setDeleteId] = useState<number | null>(null)

  const { data: observations = [], isLoading } = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
  })

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return observations
    return observations.filter(o => o.name.toLowerCase().includes(q))
  }, [observations, searchText])

  const deleteMutation = useMutation({
    mutationFn: (id: number) => observationsApi.remove(projectId, id),
    onSuccess: () => {
      setDeleteId(null)
      queryClient.invalidateQueries({ queryKey: ['observations', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      // The TopRail tab count reads this. (The conversations list omits it —
      // don't inherit that; its count badge goes stale after a delete.)
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      // Deleting an observation deletes its clips AND every code on them, which
      // staleizes the cross-surface derived counts (search, codebook tree, IRR,
      // coverage…). Not needed on CREATE — an empty observation carries no codes.
      invalidateDerivedCounts(queryClient, projectId)
      toast.success('Observation deleted')
    },
    onError: () => toast.error('Could not delete the observation.'),
  })

  const deleteTarget = observations.find(o => o.id === deleteId)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-mm-text">Observations</h1>
          <p className="text-sm text-mm-text-muted mt-1">
            A recording coded on its own timeline — mark the moments that matter.
          </p>
        </div>
        <Button onClick={() => navigate(`/projects/${projectId}/observations/import`)}>
          <FileInput className="w-4 h-4 mr-2" aria-hidden />
          Import observation
        </Button>
      </header>

      {observations.length > 0 && (
        <Input
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder="Search observations…"
          aria-label="Search observations"
          className="mb-4 max-w-sm"
        />
      )}

      {isLoading ? (
        <p className="text-sm text-mm-text-muted">Loading…</p>
      ) : observations.length === 0 ? (
        <EmptyState projectId={projectId} />
      ) : (
        <ul className="space-y-2">
          {filtered.map(obs => (
            <ObservationRow
              key={obs.id}
              observation={obs}
              projectId={projectId}
              onDelete={() => setDeleteId(obs.id)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open: boolean) => !open && setDeleteId(null)}
        title="Delete this observation?"
        description={
          deleteTarget
            ? `"${deleteTarget.name}" and its ${deleteTarget.segment_count} clip(s) will be deleted, `
              + 'along with every code applied to them. The recording is deleted too. '
              + 'This cannot be undone.'
            : ''
        }
        confirmLabel="Delete observation"
        onConfirm={() => deleteId != null && deleteMutation.mutate(deleteId)}
      />
    </div>
  )
}

function EmptyState({ projectId }: { projectId: number }) {
  return (
    <div className="border border-dashed border-mm-border rounded-lg p-10 text-center">
      <Film className="w-8 h-8 mx-auto text-mm-text-faint mb-3" aria-hidden />
      <h2 className="text-base font-medium text-mm-text">No observations yet</h2>
      {/* The dividing line, stated where the choice is actually made. A recording
        * can live in either place, and the difference is the unit of analysis. */}
      {/* The dividing line, in the words that own it — never re-typed. */}
      <p className="text-sm text-mm-text-muted mt-2 max-w-lg mx-auto">
        {SOURCE_KIND_ONE_LINER}
      </p>
      <Button asChild className="mt-5">
        <Link to={`/projects/${projectId}/observations/import`}>
          <FileInput className="w-4 h-4 mr-2" aria-hidden />
          Import an observation
        </Link>
      </Button>
    </div>
  )
}

function ObservationRow({
  observation: obs,
  projectId,
  onDelete,
}: {
  observation: Observation
  projectId: number
  onDelete: () => void
}) {
  const isFrozen = obs.segmentation_frozen_at !== null

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Link
            to={`/projects/${projectId}/observations/${obs.id}`}
            className="flex items-center gap-3 p-3 rounded-lg border border-mm-border bg-mm-surface hover:border-mm-border-strong transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-mm-text truncate">{obs.name}</span>

                {obs.has_media && (
                  /* #559: the facts live in the badge's accessible NAME, and it is
                   * deliberately NOT focusable — a tab stop per row would cost every
                   * keyboard user N stops to reach what browse mode already reads out.
                   * The tooltip is for sighted hover only; it describes, it never names. */
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="img"
                        aria-label={
                          `${obs.media_type === 'video' ? 'Video' : 'Audio'} recording: `
                          + `${obs.media_filename ?? 'attached'}`
                          + (obs.media_size_bytes != null
                            ? `, ${formatBytes(obs.media_size_bytes)}`
                            : '')
                        }
                        className="inline-flex shrink-0"
                      >
                        {obs.media_type === 'video' ? (
                          <Video className="w-3 h-3 text-mm-teal-text" aria-hidden />
                        ) : (
                          <Volume2 className="w-3 h-3 text-mm-teal-text" aria-hidden />
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {obs.media_filename}
                      {obs.media_size_bytes != null && <> · {formatBytes(obs.media_size_bytes)}</>}
                    </TooltipContent>
                  </Tooltip>
                )}

                {isFrozen && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="img"
                        aria-label="Clips are frozen — the team has agreed this clip set"
                        className="inline-flex shrink-0"
                      >
                        <Lock className="w-3 h-3 text-mm-text-muted" aria-hidden />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs max-w-xs">
                      Clips are frozen — every coder codes the same clips, so this
                      observation gets ordinary agreement scoring and reconciliation.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              <div className="text-xs text-mm-text-muted mt-1 flex items-center gap-2 flex-wrap">
                {/* Deliberately NOT an N-of-M progress bar: on an OPEN observation
                  * the coder chooses the denominator by marking clips, so N-of-M is
                  * circular (mark one clip, code it, read 100%). The honest number is
                  * % of TIMELINE covered (6a), and it is all-coder scope here — the
                  * blind workbench gauge shows only coding visible to you, so the
                  * title reconciles the two (#517). */}
                <span>
                  {obs.segment_count === 0
                    ? 'No clips yet'
                    : `${obs.segment_count} clip${obs.segment_count === 1 ? '' : 's'}`}
                </span>
                {obs.segment_count > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{obs.coded_segment_count} coded</span>
                  </>
                )}
                {obs.coverage_extent_seconds != null && obs.segment_count > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span
                      title={`All coders' coverage: ${formatTimestamp(Math.round(obs.covered_seconds))} of ${
                        obs.media_duration_seconds != null
                          ? 'the recording'
                          : 'the marked extent (recording length unknown)'
                      } covered by coding. While blind coding, the workbench gauge shows only coding visible to you.`}
                    >
                      {Math.round((obs.covered_seconds / obs.coverage_extent_seconds) * 100)}% covered
                      {/* The qualification belongs ON SCREEN, not only in the
                          title: a fallback denominator is the marked extent,
                          which the coding itself defines, so it reads ~100% and
                          means something quite different from a real percentage.
                          The workbench already says this in visible text; a
                          hover-only caveat is unreachable by touch. */}
                      {obs.media_duration_seconds == null && ' of marked extent'}
                    </span>
                  </>
                )}
                {obs.media_duration_seconds != null && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono tabular-nums">
                      {formatTimestamp(obs.media_duration_seconds)}
                    </span>
                  </>
                )}
                {!obs.has_media && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-amber-600 dark:text-amber-400">No recording</span>
                  </>
                )}
              </div>
            </div>
          </Link>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem onSelect={onDelete} className="text-red-600 dark:text-red-400">
            <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden />
            Delete observation
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
