import { useState, useMemo, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FileInput, Trash2, Search, X, ArrowUpDown, FileText } from 'lucide-react'
import { documentsApi, type DocumentListItem } from '@/lib/api'
import { setPendingImportFiles } from '@/lib/pending-import-files'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import InlineEditableText from '@/components/InlineEditableText'
import { Input } from '@/components/ui/input'
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
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

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

const ALLOWED_EXTENSIONS = ['.docx', '.pdf', '.txt']

export default function DocumentsListPage() {
  const { projectId, openCodebook } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: documents = [], isLoading } = useQuery({
    queryKey: ['documents', projectId],
    queryFn: () => documentsApi.list(projectId),
    enabled: !isNaN(projectId),
  })

  const [sortBy, setSortBy] = useState<'name' | 'date' | 'progress'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [searchText, setSearchText] = useState('')

  const filteredAndSorted = useMemo(() => {
    let result = documents
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      result = result.filter(d => d.name.toLowerCase().includes(q))
    }
    const sorted = [...result].sort((a, b) => {
      let cmp = 0
      if (sortBy === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortBy === 'date') {
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      } else {
        const progA = a.segment_count > 0 ? a.coded_segment_count / a.segment_count : 0
        const progB = b.segment_count > 0 ? b.coded_segment_count / b.segment_count : 0
        cmp = progA - progB
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [documents, searchText, sortBy, sortDir])

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

  const updateMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      documentsApi.update(projectId, id, { name }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
      queryClient.invalidateQueries({ queryKey: ['document', projectId, variables.id] })
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
      const droppedFiles = Array.from(e.dataTransfer.files)
      const validFiles = droppedFiles.filter(f =>
        ALLOWED_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext))
      )
      if (validFiles.length === 0) return
      setPendingImportFiles(validFiles, 'document')
      navigate(`/projects/${projectId}/documents/import`)
    },
  }), [projectId, navigate])

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-3.5 py-3.5">
        <div className="text-center py-12 text-mm-text-muted">Loading documents...</div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-3.5 py-3.5">
      {/* Sub-nav row */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1">
          <button
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-purple-50 text-purple-700 border border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800/40"
          >
            All Documents
            {documents.length > 0 && (
              <span className="ml-1.5 opacity-60">{documents.length}</span>
            )}
          </button>
          <button
            onClick={openCodebook}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-mm-text-muted hover:text-mm-text transition-colors inline-flex items-center gap-1.5 border border-mm-surface-border hover:border-mm-text-muted"
          >
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
              <span className="ml-1 text-mm-text-faint text-[11px]">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="progress">Progress</SelectItem>
            </SelectContent>
          </Select>

          {/* Import */}
          <button
            onClick={() => navigate(`/projects/${projectId}/documents/import`)}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 transition-colors dark:bg-purple-700 dark:hover:bg-purple-600"
          >
            <FileInput className="w-3.5 h-3.5" />
            Import
          </button>
        </div>
      </div>

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
          <div className="text-[32px] mb-4"><FileText className="w-8 h-8 mx-auto text-purple-400" /></div>
          {isDragOver ? (
            <>
              <h2 className="text-lg font-semibold text-purple-600 dark:text-purple-400 mb-2">Drop files to import</h2>
              <p className="text-sm text-mm-text-muted">Release to start importing documents</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-mm-text mb-2">No documents yet</h2>
              <p className="text-sm text-mm-text-muted mb-6">
                Import DOCX, PDF, or TXT files to get started, or drag and drop files here.
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
}: {
  document: DocumentListItem
  projectId: number
  onDelete: () => void
  isEditingName: boolean
  onRename: () => void
  onUpdate: (name: string) => void
  onEditEnd: () => void
}) {
  const progress = doc.segment_count > 0 ? doc.coded_segment_count / doc.segment_count : 0

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <Link to={`/projects/${projectId}/documents/${doc.id}`}>
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

          <div className="flex items-center justify-between text-xs text-mm-text-muted">
            {/* Documents have no facilitator concept — bare "coded" stays
              * accurate and the count matches both numerator and denominator
              * semantics without qualification. */}
            <span>{doc.coded_segment_count}/{doc.segment_count} coded</span>
            <span>{new Date(doc.created_at).toLocaleDateString()}</span>
          </div>

          {/* Progress bar (a11y: explicit progressbar semantics per #351/#352) */}
          <div
            className="mt-2 h-1 bg-mm-border-light rounded-full overflow-hidden"
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
        <ContextMenuItem onClick={onDelete} className="text-red-600 dark:text-red-400">
          <Trash2 className="w-3.5 h-3.5 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
