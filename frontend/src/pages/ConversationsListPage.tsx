import { useState, useMemo, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileInput, Trash2, Pencil, Search, X, ArrowUpDown, Volume2, Video, Mic, BookOpen, MessageSquare, Film } from 'lucide-react'
import { toast } from 'sonner'
import { validateMediaFile, MEDIA_ACCEPT, describeMediaUploadError } from '@/lib/media-constants'
import { conversationsApi, mediaApi, observationsApi, type Conversation } from '@/lib/api'
import { setPendingImportFiles } from '@/lib/pending-import-files'
import { TRANSCRIPT_FORMAT_LABEL } from '@/lib/conversation-import-formats'
import { routeDroppedFiles } from '@/lib/import-routing'
import { DROPPED_RECORDING_TITLE, DROPPED_RECORDING_DETAIL } from '@/lib/source-kind-copy'
import { formatBytes } from '@/lib/format'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import InlineEditableText from '@/components/InlineEditableText'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

export default function ConversationsListPage() {
  const { projectId, openCodebook } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: conversationsData, isLoading } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => conversationsApi.list(projectId),
    enabled: !isNaN(projectId),
  })

  const conversations = useMemo(() => conversationsData?.conversations ?? [], [conversationsData?.conversations])

  const [sortBy, setSortBy] = useState<'name' | 'date' | 'progress'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [searchText, setSearchText] = useState('')

  const filteredAndSorted = useMemo(() => {
    let result = conversations
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.subject_id && c.subject_id.toLowerCase().includes(q))
      )
    }
    const sorted = [...result].sort((a, b) => {
      let cmp = 0
      if (sortBy === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortBy === 'date') {
        const dateA = new Date(a.conversation_date || a.created_at).getTime()
        const dateB = new Date(b.conversation_date || b.created_at).getTime()
        cmp = dateA - dateB
      } else {
        const progA = a.segment_count > 0 ? a.coded_segment_count / a.segment_count : 0
        const progB = b.segment_count > 0 ? b.coded_segment_count / b.segment_count : 0
        cmp = progA - progB
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [conversations, searchText, sortBy, sortDir])

  const deleteMutation = useMutation({
    mutationFn: (conversationId: number) => conversationsApi.delete(projectId, conversationId),
    onSuccess: () => {
      setDeleteConversationId(null)
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    },
  })

  const [deleteConversationId, setDeleteConversationId] = useState<number | null>(null)
  const [editingConversationId, setEditingConversationId] = useState<number | null>(null)

  // Audio management
  const audioFileInputRef = useRef<HTMLInputElement>(null)
  const [audioTargetConversationId, setAudioTargetConversationId] = useState<number | null>(null)
  const [removeAudioConversationId, setRemoveAudioConversationId] = useState<number | null>(null)

  const uploadAudioMutation = useMutation({
    mutationFn: ({ conversationId, file }: { conversationId: number; file: File }) =>
      mediaApi.upload(projectId, 'conversation', conversationId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      toast.success('Recording uploaded')
    },
    onError: (err) => {
      toast.error(describeMediaUploadError(err))
    },
  })

  const removeAudioMutation = useMutation({
    mutationFn: (conversationId: number) => mediaApi.remove(projectId, 'conversation', conversationId),
    onSuccess: () => {
      setRemoveAudioConversationId(null)
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      toast.success('Recording removed')
    },
    onError: () => {
      toast.error('Failed to remove recording')
    },
  })

  /**
   * D17 — "also code this as an Observation".
   *
   * Creates a NEW source and COPIES the recording server-side (never shares the
   * path: each owner rmtrees its own media dir on delete). It carries no codes —
   * this is not a migration, it is re-use of the file, which is why the affordance
   * never says "convert".
   *
   * A same-disk copy of a multi-GB file is another long await, so it obeys the
   * #543 rule: NEVER auto-navigate on success. A toast with an "Open" action works
   * whether or not the user is still on this page.
   */
  const [alsoObserveTarget, setAlsoObserveTarget] = useState<Conversation | null>(null)

  const alsoObserveMutation = useMutation({
    mutationFn: async (conversation: Conversation) => {
      const obs = await observationsApi.create(projectId, { name: conversation.name })
      return observationsApi.reuseConversationRecording(projectId, obs.id, conversation.id)
    },
    onSuccess: (obs) => {
      setAlsoObserveTarget(null)
      queryClient.invalidateQueries({ queryKey: ['observations', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success(`"${obs.name}" created as an Observation`, {
        description: 'The recording was re-used. No codes were carried over.',
        action: {
          label: 'Open',
          onClick: () => navigate(`/projects/${projectId}/observations/${obs.id}`),
        },
      })
    },
    onError: (err) => {
      setAlsoObserveTarget(null)
      toast.error(describeMediaUploadError(err))
    },
  })

  const handleAudioFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || audioTargetConversationId === null) return

    const validation = validateMediaFile(file)
    if (!validation.ok) {
      toast.error(validation.error)
      e.target.value = ''
      return
    }

    uploadAudioMutation.mutate({ conversationId: audioTargetConversationId, file })
    e.target.value = ''
    setAudioTargetConversationId(null)
  }, [audioTargetConversationId, uploadAudioMutation])

  const triggerAudioAttach = useCallback((conversationId: number) => {
    setAudioTargetConversationId(conversationId)
    audioFileInputRef.current?.click()
  }, [])

  const updateConversationMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      conversationsApi.update(projectId, id, { name }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      queryClient.invalidateQueries({ queryKey: ['conversation', projectId, variables.id] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    },
  })

  // Drag-and-drop
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const dragHandlers = useCallback(() => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current++
      setIsDragOver(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0
        setIsDragOver(false)
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragOver(false)
      // #552: the filter was once `.endsWith('.csv')` and silently refused the
      // VTT/SRT the wizard had accepted since #524. The decision now lives in ONE
      // pure, tested place — and it ROUTES rather than refusing: a recording
      // dropped here belongs in an Observation, and telling the user so beats the
      // silent `return` they used to get.
      const route = routeDroppedFiles(Array.from(e.dataTransfer.files), 'conversation')

      if (route.kind === 'conversation') {
        setPendingImportFiles(route.files, 'conversation')
        navigate(`/projects/${projectId}/conversations/import`)
        return
      }
      if (route.kind === 'observation') {
        setPendingImportFiles(route.files, 'observation')
        toast.info(DROPPED_RECORDING_TITLE, { description: DROPPED_RECORDING_DETAIL })
        navigate(`/projects/${projectId}/observations/import`)
        return
      }
      if (route.kind === 'document') {
        setPendingImportFiles(route.files, 'document')
        toast.info('That looks like a document — importing it as a Document.')
        navigate(`/projects/${projectId}/documents/import`)
        return
      }

      toast.error(`Drop a transcript (${TRANSCRIPT_FORMAT_LABEL}) or a recording here.`)
    },
  }), [projectId, navigate])

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-3.5 py-3.5">
        <div className="text-center py-12 text-mm-text-muted">Loading conversations...</div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-3.5 py-3.5">
      {/* Sub-nav row */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1">
          <button
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-[hsl(var(--mm-green)/0.08)] text-mm-green-text border border-[hsl(var(--mm-green)/0.25)]"
          >
            All Conversations
            {conversations.length > 0 && (
              <span className="ml-1.5 opacity-60">{conversations.length}</span>
            )}
          </button>
          <button
            onClick={openCodebook}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-mm-text-muted hover:text-mm-text transition-colors inline-flex items-center gap-1.5 border border-mm-surface-border hover:border-mm-text-muted"
          >
            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
            Codebook
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint pointer-events-none" />
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search..."
              className="w-44 h-8 pl-8 pr-7 text-sm"
            />
            {searchText && (
              <button
                onClick={() => setSearchText('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-mm-text-faint hover:text-mm-text transition-colors"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort */}
          <Select
            value={sortBy}
            onValueChange={(val) => {
              const v = val as 'name' | 'date' | 'progress'
              if (v === sortBy) {
                setSortDir(d => d === 'asc' ? 'desc' : 'asc')
              } else {
                setSortBy(v)
                setSortDir(v === 'name' ? 'asc' : 'desc')
              }
            }}
          >
            <SelectTrigger className="w-[120px] h-8 text-sm">
              <ArrowUpDown className="w-3.5 h-3.5 mr-1.5 shrink-0 text-mm-text-faint" />
              <SelectValue />
              <span className="ml-1 text-mm-text-faint text-[11px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="progress">Progress</SelectItem>
            </SelectContent>
          </Select>

          {/* Import */}
          <button
            onClick={() => navigate(`/projects/${projectId}/conversations/import`)}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-green))] hover:opacity-90 transition-opacity"
          >
            <FileInput className="w-3.5 h-3.5" />
            Import
          </button>
        </div>
      </div>

      {/* Content */}
      {conversations.length === 0 ? (
        /* Empty state with drag-and-drop */
        <div
          className={`rounded-lg border bg-mm-surface p-12 text-center transition-colors ${
            isDragOver
              ? 'border-[hsl(var(--mm-green))] border-2'
              : 'border-mm-surface-border'
          }`}
          {...dragHandlers()}
        >
          <MessageSquare className="w-8 h-8 mx-auto mb-4 text-mm-text-faint" aria-hidden="true" />
          {isDragOver ? (
            <>
              <h2 className="text-lg font-semibold text-[hsl(var(--mm-green))] mb-2">Drop transcript files to import</h2>
              <p className="text-sm text-mm-text-muted">Release to start importing conversations</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-mm-text mb-2">No conversations yet</h2>
              <p className="text-sm text-mm-text-muted mb-6">
                Import a transcript to get started, or drag and drop files here — {TRANSCRIPT_FORMAT_LABEL}.
              </p>
              <button
                onClick={() => navigate(`/projects/${projectId}/conversations/import`)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-[hsl(var(--mm-green))] hover:opacity-90 transition-opacity"
              >
                <FileInput className="w-4 h-4" />
                Import Conversation
              </button>
            </>
          )}
        </div>
      ) : (
        /* Conversation card grid */
        filteredAndSorted.length === 0 ? (
          <div className="text-center py-12 text-mm-text-muted text-sm">
            No conversations matching &lsquo;{searchText}&rsquo;
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredAndSorted.map((conversation) => (
            <ConversationCard
              key={conversation.id}
              conversation={conversation}
              projectId={projectId}
              onDelete={() => setDeleteConversationId(conversation.id)}
              isEditingName={editingConversationId === conversation.id}
              onRename={() => setEditingConversationId(conversation.id)}
              onUpdate={(name) => updateConversationMutation.mutate({ id: conversation.id, name })}
              onEditEnd={() => setEditingConversationId(null)}
              onAttachAudio={() => triggerAudioAttach(conversation.id)}
              onRemoveAudio={() => setRemoveAudioConversationId(conversation.id)}
              onAlsoObserve={() => setAlsoObserveTarget(conversation)}
            />
          ))}
        </div>
        )
      )}

      {/* Hidden file input for audio upload */}
      <input
        ref={audioFileInputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        className="hidden"
        onChange={handleAudioFileSelect}
      />

      {/* Remove audio confirmation */}
      <ConfirmDialog
        open={alsoObserveTarget !== null}
        onOpenChange={(open: boolean) => !open && setAlsoObserveTarget(null)}
        title="Also code this as an Observation?"
        description={
          alsoObserveTarget
            ? 'This creates a NEW source that re-uses the same recording — a second copy of the file '
              + `on disk${alsoObserveTarget.media_size_bytes != null ? ` (${formatBytes(alsoObserveTarget.media_size_bytes)})` : ''}. `
              + 'Your conversation and all its coding stay exactly as they are, and no codes are '
              + 'carried over. You’ll mark clips and code the timeline in the Observation.'
            : ''
        }
        // Additive, not destructive — the default red styling would read as a warning.
        destructive={false}
        confirmLabel="Create Observation"
        loading={alsoObserveMutation.isPending}
        loadingLabel="Copying recording…"
        onConfirm={() => alsoObserveTarget && alsoObserveMutation.mutate(alsoObserveTarget)}
      />

      <ConfirmDialog
        open={removeAudioConversationId !== null}
        onOpenChange={(open) => { if (!open) setRemoveAudioConversationId(null) }}
        title="Remove Recording"
        description="Remove the media file from this conversation? The transcript and coding are not affected."
        confirmLabel="Remove Recording"
        loading={removeAudioMutation.isPending}
        loadingLabel="Removing..."
        onConfirm={() => {
          if (removeAudioConversationId !== null) {
            removeAudioMutation.mutate(removeAudioConversationId)
          }
        }}
        destructive
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteConversationId !== null}
        onOpenChange={(open) => { if (!open) setDeleteConversationId(null) }}
        title="Delete Conversation"
        description="Delete this conversation and all its segments, codes, and notes? This cannot be undone."
        confirmLabel="Delete"
        loading={deleteMutation.isPending}
        loadingLabel="Deleting..."
        onConfirm={() => {
          if (deleteConversationId !== null) {
            deleteMutation.mutate(deleteConversationId)
          }
        }}
        destructive
      />
    </div>
  )
}

function ConversationCard({
  conversation,
  projectId,
  onDelete,
  isEditingName,
  onRename,
  onUpdate,
  onEditEnd,
  onAttachAudio,
  onRemoveAudio,
  onAlsoObserve,
}: {
  conversation: Conversation
  projectId: number
  onDelete: () => void
  isEditingName: boolean
  onRename: () => void
  onUpdate: (name: string) => void
  onEditEnd: () => void
  onAttachAudio: () => void
  onRemoveAudio: () => void
  onAlsoObserve: () => void
}) {
  const progress =
    conversation.segment_count > 0
      ? Math.round((conversation.coded_segment_count / conversation.segment_count) * 100)
      : 0

  const displayDate = conversation.conversation_date || conversation.created_at

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <Link to={`/projects/${projectId}/conversations/${conversation.id}`}>
          <div className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4 hover:border-[hsl(var(--mm-green)/0.5)] transition-colors cursor-pointer">
            {/* Top row: name + date */}
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <InlineEditableText
                  value={conversation.name}
                  onSave={onUpdate}
                  className="text-[14px] font-semibold text-mm-text truncate block"
                  inputClassName="text-[14px] font-semibold"
                  tag="h3"
                  startEditing={isEditingName}
                  onEditEnd={onEditEnd}
                />
                <div className="flex items-center gap-2 mt-1 text-[11px] text-mm-text-muted">
                  {conversation.speaker_count > 0 && (
                    <span>{conversation.speaker_count} speaker{conversation.speaker_count !== 1 ? 's' : ''}</span>
                  )}
                  {conversation.speaker_count > 0 && conversation.subject_id && (
                    <span className="text-mm-text-faint">·</span>
                  )}
                  {conversation.subject_id && (
                    <span>{conversation.subject_id}</span>
                  )}
                  {conversation.has_media && (
                    <>
                      {(conversation.speaker_count > 0 || conversation.subject_id) && (
                        <span className="text-mm-text-faint">·</span>
                      )}
                      {/* #559: the badge was a bare <svg> — no name, not focusable, so a
                          screen-reader user could not tell the conversation HAS a recording,
                          and the hover tooltip (its only carrier of filename/size) was
                          unreachable. The facts now live in the badge's own accessible name,
                          which is deliberately NOT made focusable: a tab stop per row would
                          cost every keyboard user N stops to read something the name already
                          announces in browse mode. Tooltip stays for sighted hover. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            role="img"
                            aria-label={
                              `${conversation.media_type === 'video' ? 'Video' : 'Audio'} recording: `
                              + `${conversation.media_filename ?? 'attached'}`
                              + (conversation.media_size_bytes != null
                                ? `, ${formatBytes(conversation.media_size_bytes)}`
                                : '')
                            }
                            className="inline-flex"
                          >
                            {conversation.media_type === 'video' ? (
                              <Video className="w-3 h-3 text-mm-green-text" aria-hidden />
                            ) : (
                              <Volume2 className="w-3 h-3 text-mm-green-text" aria-hidden />
                            )}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {conversation.media_filename}
                          {conversation.media_size_bytes != null && (
                            <> · {formatBytes(conversation.media_size_bytes)}</>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
              <span className="text-[11px] text-mm-text-muted shrink-0">
                {new Date(displayDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            </div>

            {/* Progress gauge + stats — #351/#352: participant-only counts.
              * a11y: progressbar role + valuetext for screen readers. */}
            <div
              className="flex items-center gap-2.5 mt-2"
              role="progressbar"
              aria-valuenow={conversation.coded_segment_count}
              aria-valuemin={0}
              aria-valuemax={conversation.segment_count}
              aria-valuetext={
                conversation.coded_segment_count === 0
                  ? `Not started, 0 of ${conversation.segment_count} participant segments coded`
                  : `${conversation.coded_segment_count} of ${conversation.segment_count} participant segments coded`
              }
              // #517: this count is ALL coders' coverage (the blind workbench gauge
              // shows only coding visible to you) — label the scope so the two
              // surfaces' different numbers read as scopes, not a bug.
              title="All coders' coverage. Facilitator segments are excluded from coding progress."
            >
              <div className="w-[80px] h-1.5 rounded-sm bg-mm-border-subtle shrink-0 overflow-hidden">
                <div
                  className={`h-full rounded-sm transition-all ${progress === 100 ? 'bg-[hsl(var(--mm-green))]' : 'bg-[hsl(var(--mm-orange))]'}`}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className={`text-[11px] ${progress === 100 ? 'text-mm-green-text' : 'text-mm-text-muted'}`}>
                {conversation.coded_segment_count === 0
                  ? 'Not started'
                  : `${conversation.coded_segment_count}/${conversation.segment_count} participant segments coded`}
                {conversation.code_count > 0 && ` · ${conversation.code_count} codes`}
              </span>
            </div>
          </div>
        </Link>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>
          <Pencil className="w-4 h-4 mr-2" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        {conversation.has_media ? (
          <>
            <ContextMenuItem onClick={onAttachAudio}>
              <Mic className="w-4 h-4 mr-2" />
              Replace Recording
            </ContextMenuItem>
            <ContextMenuItem onClick={onRemoveAudio} className="text-red-600">
              <Volume2 className="w-4 h-4 mr-2" />
              Remove Recording
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem onClick={onAttachAudio}>
            <Mic className="w-4 h-4 mr-2" />
            Attach Recording
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* D17 — the escape hatch. Never "convert": nothing moves. It re-uses the
          * FILE and carries no codes, and saying "convert" would imply the coding
          * comes with it.
          *
          * Disabled-with-a-reason rather than hidden, and the reason lives in the
          * accessible NAME, not a conditional title — a conditional title leaves a
          * control NAMELESS in exactly the disabled state, which is how the
          * workbench chevrons shipped unnamed (#559). */}
        <ContextMenuItem
          onClick={onAlsoObserve}
          disabled={!conversation.has_media}
          aria-label={
            conversation.has_media
              ? 'Also code this as an Observation'
              : 'Also code this as an Observation — unavailable: this conversation has no recording'
          }
        >
          <Film className="w-4 h-4 mr-2" aria-hidden />
          Also code this as an Observation
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete} className="text-red-600">
          <Trash2 className="w-4 h-4 mr-2" />
          Delete Conversation
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
