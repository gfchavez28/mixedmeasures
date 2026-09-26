import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileInput, Trash2, FileText, UserRound } from 'lucide-react'
import { documentsApi, type DocumentListItem, retryUnanswered} from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { useMainContentLanding } from '@/hooks/useMainContentLanding'
import { LoadState } from '@/components/LoadStatus'
import { setPendingImportFiles } from '@/lib/pending-import-files'
import { DOCUMENT_FORMAT_LABEL } from '@/lib/document-import-formats'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { sortSources } from '@/lib/source-list-sort'
import SourceListToolbar from '@/components/SourceListToolbar'
import { DATE_AND_NAME_SORTS, type SortChoice } from '@/lib/source-list-toolbar'
import { routeDroppedFiles } from '@/lib/import-routing'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import InlineEditableText from '@/components/InlineEditableText'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { toast } from 'sonner'
import DocumentSubjectDialog from '@/components/DocumentSubjectDialog'

const FORMAT_LABELS: Record<string, string> = {
  docx: 'DOCX',
  pdf: 'PDF',
  txt: 'TXT',
}

const MODE_LABELS: Record<string, string> = {
  paragraph: 'By Paragraph',
  sentence: 'By Sentence',
  heading: 'By Section',
  page: 'By Page',
  double_newline: 'By Blank Line',
}


const DOCUMENT_SORTS: SortChoice[] = [
  ...DATE_AND_NAME_SORTS,
  { key: 'progress', dir: 'desc', label: 'Most coded' },
  { key: 'progress', dir: 'asc', label: 'Least coded' },
]

export default function DocumentsListPage() {
  const { projectId, openCodebook } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const documentsQuery = useQuery({
    queryKey: ['documents', projectId],
    queryFn: () => documentsApi.list(projectId),
    enabled: !isNaN(projectId),
    retry: retryUnanswered,
  })
  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data])
  const documentsLoad = useListLoad(documentsQuery)
  const mainLanding = useMainContentLanding()

  const [sortBy, setSortBy] = useState<'name' | 'date' | 'progress'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [searchText, setSearchText] = useState('')
  /**
   * #932 — the card to hand focus back to once the list has re-rendered.
   *
   * Setting a subject closes a dialog that was opened from a context menu on a
   * card, and focus landed on `<body>`: the first Tab afterwards hit *Skip to
   * main content*, i.e. a keyboard user was returned to the top of the page on a
   * flow whose whole point is labelling several documents in a row.
   *
   * Deferred rather than focused in `onSuccess`, because the mutation
   * invalidates the list and the element that exists at that moment may not be
   * the one React keeps. The effect below waits for the render.
   *
   * ⚠️ A REF, not state: this is not something the page renders, and holding it
   * in state would mean a `setState` inside the effect — an extra render on
   * every focus restore, and the advisory the lint gate tracks.
   */
  const refocusDocumentIdRef = useRef<number | null>(null)

  const filteredAndSorted = useMemo(() => {
    let result = documents
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      result = result.filter(d => d.name.toLowerCase().includes(q))
    }
    // #932 — one comparator, with the `id` tie-break that keeps the rendered
    // order independent of the server's. Documents are served
    // `updated_at.desc()`, and a batch import gives every file ONE `created_at`,
    // so without it any edit moved the card to the top of the list.
    return sortSources(result, sortBy, sortDir, d => d.created_at)
  }, [documents, searchText, sortBy, sortDir])

  /**
   * #932 — return focus to the card a dialog was opened from.
   *
   * Keyed on the rendered list as well as the id: the mutation invalidates the
   * query, so the element may not be in the DOM at the moment the mutation
   * settles. Clearing the id only once the element is FOUND means a card that
   * has been filtered out of view (or deleted) leaves the state harmlessly set
   * rather than focusing something arbitrary.
   */
  useEffect(() => {
    const id = refocusDocumentIdRef.current
    if (id === null) return
    const card = window.document.querySelector<HTMLElement>(
      `[data-document-card="${id}"]`,
    )
    // Not rendered (filtered out of view, or deleted): leave the request
    // pending rather than focusing something arbitrary.
    if (!card) return
    card.focus()
    refocusDocumentIdRef.current = null
    // 🔴 **No dependency array, deliberately.** The first version watched the
    // sorted list, on the reasoning that the card re-renders after the refetch —
    // and a test driving the real gesture showed focus still landing on `<body>`:
    // React Query's structural sharing KEEPS the previous array reference when the
    // refetched payload is deeply equal, so the memo never recomputed and the
    // effect never ran. Restoring focus must not depend on the list changing
    // identity. This runs after every render and does nothing unless a restore is
    // pending, which is one null check.
  })

  const deleteMutation = useMutation({
    mutationFn: (documentId: number) => documentsApi.remove(projectId, documentId),
    onSuccess: () => {
      setDeleteDocumentId(null)
      queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const [deleteDocumentId, setDeleteDocumentId] = useState<number | null>(null)
  const [editingDocumentId, setEditingDocumentId] = useState<number | null>(null)
  // Row 46 — which document's subject is being edited, if any.
  const [subjectDocumentId, setSubjectDocumentId] = useState<number | null>(null)
  // Looked up from the LIVE list rather than stashed on open, so the dialog's
  // tick follows the row after a change instead of showing the pre-edit value.
  const subjectDocument = documents.find(d => d.id === subjectDocumentId) ?? null

  const updateMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      documentsApi.update(projectId, id, { name }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
      queryClient.invalidateQueries({ queryKey: ['document', projectId, variables.id] })
      queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    },
  })

  // Row 46 — the subject link. Kept separate from `updateMutation` because it
  // invalidates a different set: a subject change moves what the qualitative
  // analysis surfaces can group by, and it changes the PARTICIPANT's own
  // document list, neither of which a rename touches.
  const subjectMutation = useMutation({
    mutationFn: ({ id, participantId }: { id: number; participantId: number | null }) =>
      // ⚠️ `null` is sent deliberately — it is the unlink, not an omission.
      documentsApi.update(projectId, id, { participant_id: participantId }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
      queryClient.invalidateQueries({ queryKey: ['document', projectId, variables.id] })
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      // The document is now groupable (or no longer is) on the qual surfaces.
      queryClient.invalidateQueries({ queryKey: ['qual-source-frequencies', projectId] })
      // #932 — hand focus back to the card this was about, once it re-renders.
      refocusDocumentIdRef.current = variables.id
    },
    onError: () => toast.error('Could not change the subject of this document'),
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
      // #1008: route by what the file IS, like the Conversations list — a
      // transcript or recording dropped here used to vanish with no word.
      const route = routeDroppedFiles(Array.from(e.dataTransfer.files), 'document')
      if (route.kind === 'none') {
        toast.error(`Drop a document (${DOCUMENT_FORMAT_LABEL}) here.`)
        return
      }
      if (route.kind !== 'document') {
        toast.info(route.kind === 'observation'
          ? 'That looks like a recording — importing it as an Observation.'
          : 'That looks like a transcript — importing it as a Conversation.')
      }
      setPendingImportFiles(route.files, route.kind)
      navigate(`/projects/${projectId}/${route.kind}s/import`)
    },
  }), [projectId, navigate])

  /**
   * #963 — ONE gate for both non-ready states.
   *
   * The hand-written line this replaces covered only `isLoading`, and React
   * Query v5 reports that `false` once a failure has SETTLED — so a failed load
   * fell straight through to "No documents yet" with the import affordance
   * beside it. Driven on the running app: the page said that while the nav rail
   * next to it still showed the real count from another query.
   *
   * `LoadState` is also what gives this wait a `role="status"`, the shared
   * slow-load hint and, on a failure, a Retry (`components/LoadStatus.tsx`).
   */
  if (documentsLoad.status !== 'ready') {
    return (
      <div className="max-w-4xl mx-auto px-3.5 py-3.5">
        <LoadState
          load={documentsLoad}
          loadingLabel="Loading documents…"
          failedTitle="Your documents could not be loaded."
          landingRef={mainLanding}
        />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-3.5 py-3.5">
      <SourceListToolbar
        title="All Documents"
        count={documents.length}
        accent="purple"
        noun="documents"
        onOpenCodebook={openCodebook}
        showListControls={documents.length > 0}
        searchText={searchText}
        onSearchChange={setSearchText}
        sortChoices={DOCUMENT_SORTS}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={(key, dir) => { setSortBy(key); setSortDir(dir) }}
        onImport={() => navigate(`/projects/${projectId}/documents/import`)}
      />

      {/* Content */}
      {documents.length === 0 ? (
        <div
          className={`rounded-lg border bg-mm-surface p-12 text-center transition-colors ${
            isDragOver
              ? 'border-purple-500 border-2'
              : 'border-mm-surface-border'
          }`}
          {...dragHandlers()}
        >
          <div className="text-[32px] mb-4"><FileText className="w-8 h-8 mx-auto text-purple-400" aria-hidden="true" /></div>
          {isDragOver ? (
            <>
              <h2 className="text-lg font-semibold text-purple-600 dark:text-purple-400 mb-2">Drop files to import</h2>
              <p className="text-sm text-mm-text-muted">Release to start importing documents</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-mm-text mb-2">No documents yet</h2>
              <p className="text-sm text-mm-text-muted mb-6">
                Import a document to get started, or drag and drop files here — {DOCUMENT_FORMAT_LABEL}.
              </p>
              <button
                onClick={() => navigate(`/projects/${projectId}/documents/import`)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 transition-colors dark:bg-purple-700 dark:hover:bg-purple-600"
              >
                <FileInput className="w-4 h-4" />
                Import Documents
              </button>
            </>
          )}
        </div>
      ) : (
        filteredAndSorted.length === 0 ? (
          <div className="text-center py-12 text-mm-text-muted text-sm">
            No documents matching &lsquo;{searchText}&rsquo;
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" {...dragHandlers()}>
          {filteredAndSorted.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              projectId={projectId}
              onDelete={() => setDeleteDocumentId(doc.id)}
              isEditingName={editingDocumentId === doc.id}
              onRename={() => setEditingDocumentId(doc.id)}
              onUpdate={(name) => updateMutation.mutate({ id: doc.id, name })}
              onEditEnd={() => setEditingDocumentId(null)}
              onEditSubject={() => setSubjectDocumentId(doc.id)}
            />
          ))}
        </div>
        )
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteDocumentId !== null}
        onOpenChange={(open) => { if (!open) setDeleteDocumentId(null) }}
        title="Delete Document"
        description="Delete this document and all its segments, codes, and notes? This cannot be undone."
        confirmLabel="Delete"
        loading={deleteMutation.isPending}
        loadingLabel="Deleting..."
        onConfirm={() => {
          if (deleteDocumentId !== null) {
            deleteMutation.mutate(deleteDocumentId)
          }
        }}
      />

      {/* Row 46 — "this document is about…" */}
      <DocumentSubjectDialog
        open={subjectDocumentId !== null}
        projectId={projectId}
        documentName={subjectDocument?.name ?? ''}
        participantId={subjectDocument?.participant_id ?? null}
        onClose={() => setSubjectDocumentId(null)}
        onChoose={(participantId) => {
          if (subjectDocumentId !== null) {
            subjectMutation.mutate({ id: subjectDocumentId, participantId })
          }
        }}
      />
    </div>
  )
}


function DocumentCard({
  document: doc,
  projectId,
  onDelete,
  isEditingName,
  onRename,
  onUpdate,
  onEditEnd,
  onEditSubject,
}: {
  document: DocumentListItem
  projectId: number
  onDelete: () => void
  isEditingName: boolean
  onRename: () => void
  onUpdate: (name: string) => void
  onEditEnd: () => void
  /** Row 46 — opens the "who is this about?" dialog. */
  onEditSubject: () => void
}) {
  const progress = doc.segment_count > 0 ? doc.coded_segment_count / doc.segment_count : 0

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        {/* #932 — the card is addressable by the document it shows, so focus
            can be returned to it by IDENTITY after a dialog. A positional
            restore lands on a different document the moment the list reorders. */}
        <Link
          to={`/projects/${projectId}/documents/${doc.id}`}
          data-document-card={doc.id}
        >
          <div className="rounded-lg border border-mm-surface-border bg-mm-surface p-4 cursor-pointer hover:border-purple-300 dark:hover:border-purple-700 transition-colors group">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0 flex-1">
              <InlineEditableText
                value={doc.name}
                onSave={(val) => { onUpdate(val); onEditEnd() }}
                onEditEnd={onEditEnd}
                startEditing={isEditingName}
                className="text-sm font-medium"
                tag="h3"
              />
            </div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
              doc.source_format === 'pdf' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              : doc.source_format === 'docx' ? 'bg-mm-blue/12 text-mm-blue-text'
              : 'bg-mm-surface-hover text-mm-text-secondary'
            }`}>
              {FORMAT_LABELS[doc.source_format] || doc.source_format.toUpperCase()}
            </span>
          </div>

          <div className="text-xs text-mm-text-muted mb-2">
            {MODE_LABELS[doc.segmentation_mode] || doc.segmentation_mode}
          </div>

          {/* Row 46 — the subject, shown only when set. An "About: —" placeholder
            * on every unlinked document would be noise on the common case; the
            * capability is discoverable from the context menu, which is where
            * Rename and Delete already live. */}
          {doc.participant_label && (
            <div className="flex items-center gap-1 text-xs text-mm-text-secondary mb-2 min-w-0">
              <UserRound className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="truncate">About {doc.participant_label}</span>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-mm-text-muted">
            {/* Documents have no facilitator concept — bare "coded" stays
              * accurate and the count matches both numerator and denominator
              * semantics without qualification. */}
            <span>{doc.coded_segment_count}/{doc.segment_count} coded</span>
            <span>{new Date(doc.created_at).toLocaleDateString()}</span>
          </div>

          {/* Progress bar (a11y: explicit progressbar semantics per #351/#352) */}
          <div
            className="mt-2 h-1 bg-mm-border-subtle rounded-full overflow-hidden"
            role="progressbar"
            aria-label="Coding progress"
            aria-valuenow={doc.coded_segment_count}
            aria-valuemin={0}
            aria-valuemax={doc.segment_count}
            aria-valuetext={`${doc.coded_segment_count} of ${doc.segment_count} segments coded`}
          >
            <div
              className="h-full bg-purple-500 rounded-full transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
        </Link>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem onClick={onEditSubject}>
          <UserRound className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          {doc.participant_id === null ? 'Set subject…' : 'Change subject…'}
        </ContextMenuItem>
        <ContextMenuItem onClick={onDelete} className="text-red-600 dark:text-red-400">
          <Trash2 className="w-3.5 h-3.5 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
