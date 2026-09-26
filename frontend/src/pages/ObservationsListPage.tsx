import { useState, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Video, Volume2, FileInput, Trash2, Film, Lock } from 'lucide-react'

import { observationsApi, retryUnanswered} from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { useMainContentLanding } from '@/hooks/useMainContentLanding'
import { LoadState } from '@/components/LoadStatus'
import type { Observation } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from '@/components/ui/context-menu'
import { formatBytes } from '@/lib/format'
import { formatTimestamp } from '@/lib/utils'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import { SOURCE_KIND_ONE_LINER } from '@/lib/source-kind-copy'
import { sortSources, type SortDirection, type SourceSortKey } from '@/lib/source-list-sort'
import SourceListToolbar from '@/components/SourceListToolbar'
import { DATE_AND_NAME_SORTS, type SortChoice } from '@/lib/source-list-toolbar'
import { routeDroppedFiles } from '@/lib/import-routing'
import { setPendingImportFiles } from '@/lib/pending-import-files'
import { OBSERVATION_MEDIA_FORMAT_LABEL } from '@/lib/observation-import-formats'

/**
 * #1008 — timeline COVERAGE is this list's progress, never coded-of-marked: on an
 * open observation the coder marks the clips, so coded-of-marked is circular (mark
 * one, code it, read 100%). It is the figure the rows already display.
 */
const coverageOf = (o: Observation) =>
  o.coverage_extent_seconds ? o.covered_seconds / o.coverage_extent_seconds : 0

const OBSERVATION_SORTS: SortChoice[] = [
  ...DATE_AND_NAME_SORTS,
  { key: 'progress', dir: 'desc', label: 'Most covered' },
  { key: 'progress', dir: 'asc', label: 'Least covered' },
]

export default function ObservationsListPage() {
  const { projectId, openCodebook } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchText, setSearchText] = useState('')
  const [sortBy, setSortBy] = useState<SourceSortKey>('date')
  const [sortDir, setSortDir] = useState<SortDirection>('desc')
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const observationsQuery = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
    retry: retryUnanswered,
  })
  const observations = useMemo(() => observationsQuery.data ?? [], [observationsQuery.data])
  /** #963 — `EmptyState` below tells a researcher how to import their FIRST
   *  recording; after a failed load it told that to someone who has several. */
  const observationsLoad = useListLoad(observationsQuery)
  const mainLanding = useMainContentLanding()

  const filteredAndSorted = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    const shown = q ? observations.filter(o => o.name.toLowerCase().includes(q)) : observations
    return sortSources(shown, sortBy, sortDir, o => o.created_at, coverageOf)
  }, [observations, searchText, sortBy, sortDir])

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

  // #1008 — the drop its three siblings had. Routed by what the file IS, so a
  // transcript or document dropped here goes where it belongs, with a word.
  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current++; setIsDragOver(true) },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false) }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragOver(false)
      const route = routeDroppedFiles(Array.from(e.dataTransfer.files), 'observation')
      if (route.kind === 'none') {
        toast.error(`Drop a recording (${OBSERVATION_MEDIA_FORMAT_LABEL}) here.`)
        return
      }
      if (route.kind !== 'observation') {
        toast.info(route.kind === 'conversation'
          ? 'That looks like a transcript — importing it as a Conversation.'
          : 'That looks like a document — importing it as a Document.')
      }
      setPendingImportFiles(route.files, route.kind)
      navigate(`/projects/${projectId}/${route.kind}s/import`)
    },
  }

  const deleteTarget = observations.find(o => o.id === deleteId)

  if (observationsLoad.status !== 'ready') {
    return (
      <div className="max-w-4xl mx-auto px-3.5 py-3.5">
        <LoadState
          load={observationsLoad}
          loadingLabel="Loading observations…"
          failedTitle="Your observations could not be loaded."
          landingRef={mainLanding}
        />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-3.5 py-3.5">
      <SourceListToolbar
        title="All Observations"
        count={observations.length}
        accent="teal"
        noun="observations"
        onOpenCodebook={openCodebook}
        showListControls={observations.length > 0}
        searchText={searchText}
        onSearchChange={setSearchText}
        sortChoices={OBSERVATION_SORTS}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={(key, dir) => { setSortBy(key); setSortDir(dir) }}
        onImport={() => navigate(`/projects/${projectId}/observations/import`)}
      />

      {observations.length === 0 ? (
        <div
          className={`rounded-lg border bg-mm-surface p-12 text-center transition-colors ${
            isDragOver ? 'border-[hsl(var(--mm-teal))] border-2' : 'border-mm-surface-border'
          }`}
          {...dragHandlers}
        >
          <Film className="w-8 h-8 mx-auto mb-4 text-mm-text-faint" aria-hidden="true" />
          {isDragOver ? (
            <>
              <h2 className="text-lg font-semibold text-mm-teal-text mb-2">Drop a recording to import</h2>
              <p className="text-sm text-mm-text-muted">Release to start importing an observation</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-mm-text mb-2">No observations yet</h2>
              <p className="text-sm text-mm-text-muted mb-2">
                Import a recording to get started, or drag and drop one here — {OBSERVATION_MEDIA_FORMAT_LABEL}.
              </p>
              {/* The dividing line, in the words that own it — never re-typed. */}
              <p className="text-sm text-mm-text-muted mb-6 max-w-lg mx-auto">
                {SOURCE_KIND_ONE_LINER}
              </p>
              <Button asChild>
                <Link to={`/projects/${projectId}/observations/import`}>
                  <FileInput className="w-4 h-4 mr-2" aria-hidden />
                  Import an observation
                </Link>
              </Button>
            </>
          )}
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <div className="text-center py-12 text-mm-text-muted text-sm">
          No observations matching &lsquo;{searchText}&rsquo;
        </div>
      ) : (
        <ul className="space-y-2">
          {filteredAndSorted.map(obs => (
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
            className="flex items-center gap-3 p-3 rounded-lg border border-border bg-mm-surface hover:border-mm-teal/50 transition-colors"
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
