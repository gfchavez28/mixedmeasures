import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ChevronRight,
  ArrowLeft,
  ExternalLink,
  FileText,
  MessageSquare,
  Search,
  X,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  segmentsApi,
  textCodingApi,
  documentsApi,
  type Code,
  type ConversationOption,
  type TextColumnInfo,
  type DocumentListItem,
} from '@/lib/api'
import { getSpeakerInitials } from '@/lib/conversation-import-utils'
import { getUnfocusedStyle } from '@/lib/utils'
import CodeChip from './CodeChip'
import InlineCodeActions from './InlineCodeActions'
import { highlightText } from './highlight-text'

interface ContentBySourceProps {
  projectId: number
  codes: Code[]
  allCodes?: Code[]
  conversations: ConversationOption[]
  textColumns: TextColumnInfo[]
  documents?: DocumentListItem[]
  selectedSourceId: string | null // 'c:123', 'cc:456', or 'd:789'
  onSourceSelect: (source: string | null) => void
  onCodeClick?: (codeId: number) => void
  source: 'all' | 'conversations' | 'text'
  excludeFacilitator?: boolean
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}

function parseSourceId(raw: string | null): { type: 'conversation' | 'comment_column' | 'document'; id: number } | null {
  if (!raw) return null
  if (raw.startsWith('c:')) return { type: 'conversation', id: Number(raw.slice(2)) }
  if (raw.startsWith('cc:')) return { type: 'comment_column', id: Number(raw.slice(3)) }
  if (raw.startsWith('d:')) return { type: 'document', id: Number(raw.slice(2)) }
  return null
}

export default function ContentBySource({
  projectId,
  codes,
  allCodes,
  conversations,
  textColumns,
  documents = [],
  selectedSourceId,
  onSourceSelect,
  onCodeClick,
  source,
  excludeFacilitator,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: ContentBySourceProps) {
  const [search, setSearch] = useState('')
  const parsedSource = useMemo(() => parseSourceId(selectedSourceId), [selectedSourceId])

  const codeMap = useMemo(() => {
    const m = new Map<number, Code>()
    for (const c of codes) m.set(c.id, c)
    return m
  }, [codes])

  // Group comment columns by dataset for the source list
  const textColumnsByDataset = useMemo(() => {
    const groups = new Map<string, { datasetName: string; columns: TextColumnInfo[] }>()
    for (const col of textColumns) {
      const key = col.dataset_name
      if (!groups.has(key)) groups.set(key, { datasetName: key, columns: [] })
      groups.get(key)!.columns.push(col)
    }
    return Array.from(groups.values())
  }, [textColumns])

  if (!parsedSource) {
    // Show source list for selection
    return (
      <div className="max-w-lg">
        <h3 className="text-sm font-semibold text-mm-text-secondary mb-3">Select a source to browse its content</h3>
        <div className="border rounded-lg divide-y bg-mm-surface">
          {/* Conversations section */}
          {source !== 'text' && conversations.length > 0 && (
            <div>
              <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                Conversations ({conversations.length})
              </div>
              {conversations.map(conv => (
                <button
                  key={conv.id}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-mm-surface-hover transition-colors"
                  onClick={() => onSourceSelect(`c:${conv.id}`)}
                >
                  <span className="text-sm flex-1 truncate">{conv.name}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-mm-text-faint" />
                </button>
              ))}
            </div>
          )}

          {/* Comment columns section */}
          {source !== 'conversations' && textColumnsByDataset.length > 0 && (
            <>
              {textColumnsByDataset.map(group => (
                <div key={group.datasetName}>
                  <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                    {group.datasetName} ({group.columns.length} column{group.columns.length !== 1 ? 's' : ''})
                  </div>
                  {group.columns.map(col => (
                    <button
                      key={col.column_id}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-mm-surface-hover transition-colors"
                      onClick={() => onSourceSelect(`cc:${col.column_id}`)}
                    >
                      <MessageSquare className="w-3.5 h-3.5 text-mm-text-faint flex-shrink-0" />
                      <span className="text-sm flex-1 truncate">
                        {col.column_name || col.column_text.slice(0, 60)}
                      </span>
                      <span className="text-xs text-mm-text-faint tabular-nums">
                        {col.coded_count} coded
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-mm-text-faint" />
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}

          {/* Documents section */}
          {source !== 'text' && documents.length > 0 && (
            <div>
              <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                Documents ({documents.length})
              </div>
              {documents.map(doc => (
                <button
                  key={doc.id}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-mm-surface-hover transition-colors"
                  onClick={() => onSourceSelect(`d:${doc.id}`)}
                >
                  <FileText className="w-3.5 h-3.5 text-mm-text-faint flex-shrink-0" />
                  <span className="text-sm flex-1 truncate">{doc.name}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-mm-text-faint" />
                </button>
              ))}
            </div>
          )}

          {/* Empty state */}
          {((source === 'conversations' && conversations.length === 0 && documents.length === 0) ||
            (source === 'text' && textColumns.length === 0) ||
            (source === 'all' && conversations.length === 0 && textColumns.length === 0 && documents.length === 0)) && (
            <div className="px-3 py-8 text-center text-mm-text-muted text-sm">
              No sources available with current filters.
            </div>
          )}
        </div>
      </div>
    )
  }

  // Source is selected — show content
  return (
    <div className="space-y-4">
      {/* Back link */}
      <div className="flex items-center gap-3">
        <button
          className="inline-flex items-center gap-1 text-sm text-mm-text-muted hover:text-mm-text"
          onClick={() => { onSourceSelect(null); setSearch('') }}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All sources
        </button>
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-muted" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search content…"
            className="pl-8 h-8 text-sm w-48"
          />
          {search && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-mm-text-muted hover:text-mm-text"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {parsedSource.type === 'conversation' ? (
        <ConversationReader
          projectId={projectId}
          conversationId={parsedSource.id}
          conversationName={conversations.find(c => c.id === parsedSource.id)?.name ?? 'Conversation'}
          codeMap={codeMap}
          allCodes={allCodes ?? codes}
          onCodeClick={onCodeClick}
          excludeFacilitator={excludeFacilitator}
          search={search}
          focusedCodeId={focusedCodeId}
          onFocusCode={onFocusCode}
          onCodeChange={onCodeChange}
        />
      ) : parsedSource.type === 'document' ? (
        <DocumentReader
          projectId={projectId}
          documentId={parsedSource.id}
          documentName={documents.find(d => d.id === parsedSource.id)?.name ?? 'Document'}
          codeMap={codeMap}
          allCodes={allCodes ?? codes}
          onCodeClick={onCodeClick}
          search={search}
          focusedCodeId={focusedCodeId}
          onFocusCode={onFocusCode}
          onCodeChange={onCodeChange}
        />
      ) : (
        <CommentColumnReader
          projectId={projectId}
          columnId={parsedSource.id}
          columnInfo={textColumns.find(c => c.column_id === parsedSource.id)}
          codeMap={codeMap}
          allCodes={allCodes ?? codes}
          onCodeClick={onCodeClick}
          search={search}
          focusedCodeId={focusedCodeId}
          onFocusCode={onFocusCode}
          onCodeChange={onCodeChange}
        />
      )}
    </div>
  )
}


// ── Conversation Reader ──────────────────────────────────────────────────

function ConversationReader({
  projectId,
  conversationId,
  conversationName,
  codeMap,
  allCodes,
  onCodeClick,
  excludeFacilitator,
  search,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: {
  projectId: number
  conversationId: number
  conversationName: string
  codeMap: Map<number, Code>
  allCodes: Code[]
  onCodeClick?: (codeId: number) => void
  excludeFacilitator?: boolean
  search?: string
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['conversation-segments-readonly', projectId, conversationId],
    queryFn: () => segmentsApi.list(conversationId),
    enabled: !!conversationId,
  })

  if (isLoading) return <div className="text-center py-8 text-mm-text-muted">Loading conversation...</div>
  if (!data) return <div className="text-center py-8 text-mm-text-muted">No data available.</div>

  const searchLower = (search ?? '').toLowerCase()
  let segments = excludeFacilitator ? data.segments.filter(s => !s.is_facilitator) : data.segments
  const totalCount = segments.length
  if (searchLower) segments = segments.filter(s => s.text.toLowerCase().includes(searchLower))

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{conversationName}</h3>
        <Link
          to={`/projects/${projectId}/conversations/${conversationId}`}
          className="text-sm text-mm-blue-text hover:underline flex items-center gap-1"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open in workspace
        </Link>
      </div>

      {searchLower && segments.length === 0 && (
        <div className="text-center py-8 text-mm-text-muted text-sm">No segments match your search.</div>
      )}

      <div className="border rounded-lg overflow-hidden divide-y divide-mm-border-subtle bg-mm-surface">
        {segments.map((seg, idx) => {
          const isFocused = focusedCodeId == null || seg.applied_codes.includes(focusedCodeId)
          return (
          <div
            key={seg.id}
            className={`flex items-start gap-3 px-4 py-3 ${
              seg.is_facilitator ? 'bg-mm-bg/50' : ''
            }`}
            style={getUnfocusedStyle(isFocused)}
          >
            {/* Gutter number */}
            <span className="text-[11px] text-mm-text-faint tabular-nums w-6 text-right flex-shrink-0 pt-0.5">
              {idx + 1}
            </span>

            {/* Speaker avatar */}
            <span
              className={`w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center ring-1 flex-shrink-0 mt-0.5 ${
                seg.is_facilitator
                  ? 'bg-purple-200 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300 ring-purple-300 dark:ring-purple-700 opacity-60'
                  : 'bg-orange-200 dark:bg-orange-900/50 text-orange-800 dark:text-orange-300 ring-orange-300 dark:ring-orange-700'
              }`}
              title={seg.speaker_name || 'Unknown'}
            >
              {getSpeakerInitials(seg.speaker_name)}
            </span>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-xs font-medium ${seg.is_facilitator ? 'text-mm-text-faint' : 'text-mm-text-secondary'}`}>
                  {seg.speaker_name || 'Unknown'}
                </span>
                {seg.is_facilitator && (
                  <span className="text-[10px] text-purple-500 dark:text-purple-400 font-medium">Facilitator</span>
                )}
              </div>
              <p className={`text-sm ${seg.is_facilitator ? 'text-mm-text-muted' : 'text-mm-text'}`}>
                {searchLower ? highlightText(seg.text, search ?? '') : seg.text}
              </p>
              {(seg.applied_codes.length > 0 || onCodeChange) && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {onCodeChange ? (
                    <InlineCodeActions
                      projectId={projectId}
                      itemType="segment"
                      itemId={seg.id}
                      appliedCodeIds={seg.applied_codes}
                      codeMap={codeMap}
                      allCodes={allCodes}
                      onCodeChange={onCodeChange}
                      onFocusCode={onFocusCode ?? onCodeClick}
                    />
                  ) : (
                    // Distinct codes only (read-only, no attribution): the bare
                    // array is per-coder, so dedupe to avoid duplicate keys/chips (#441).
                    [...new Set(seg.applied_codes)].map(cid => {
                      const code = codeMap.get(cid)
                      if (!code) return null
                      return (
                        <CodeChip
                          key={cid}
                          code={code}
                          size="xs"
                          onClick={onFocusCode ?? onCodeClick}
                        />
                      )
                    })
                  )}
                </div>
              )}
            </div>
          </div>
          )
        })}
      </div>

      <p className="text-xs text-mm-text-faint mt-2">
        {searchLower ? `${segments.length} match${segments.length !== 1 ? 'es' : ''} of ` : ''}
        {totalCount} segment{totalCount !== 1 ? 's' : ''}
        {' \u00B7 '}
        {data.coded_count ?? 0} coded
      </p>
    </div>
  )
}


// ── Document Reader ─────────────────────────────────────────────────────

function DocumentReader({
  projectId,
  documentId,
  documentName,
  codeMap,
  allCodes,
  onCodeClick,
  search,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: {
  projectId: number
  documentId: number
  documentName: string
  codeMap: Map<number, Code>
  allCodes: Code[]
  onCodeClick?: (codeId: number) => void
  search?: string
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['document-segments-readonly', projectId, documentId],
    queryFn: () => documentsApi.getDetail(projectId, documentId),
    enabled: !!documentId,
  })

  if (isLoading) return <div className="text-center py-8 text-mm-text-muted">Loading document...</div>
  if (!data) return <div className="text-center py-8 text-mm-text-muted">No data available.</div>

  const searchLower = (search ?? '').toLowerCase()
  const allSegments = data.segments.filter(s => !s.merged_into_id && !s.split_into_id)
  const totalCount = allSegments.length
  const segments = searchLower ? allSegments.filter(s => s.text.toLowerCase().includes(searchLower)) : allSegments
  const codedCount = allSegments.filter(s => s.codes.length > 0).length

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{documentName}</h3>
        <Link
          to={`/projects/${projectId}/documents/${documentId}`}
          className="text-sm text-mm-blue-text hover:underline flex items-center gap-1"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open in workspace
        </Link>
      </div>

      {searchLower && segments.length === 0 && (
        <div className="text-center py-8 text-mm-text-muted text-sm">No segments match your search.</div>
      )}

      <div className="border rounded-lg overflow-hidden divide-y divide-mm-border-subtle bg-mm-surface">
        {segments.map((seg) => {
          // Distinct codes (per-coder rows collapse): one chip per code (#441).
          const appliedCodeIds = [...new Set(seg.codes.map(c => c.id))]
          const isFocused = focusedCodeId == null || appliedCodeIds.includes(focusedCodeId)
          return (
            <div
              key={seg.id}
              className="flex items-start gap-3 px-4 py-3"
              style={getUnfocusedStyle(isFocused)}
            >
              <span className="text-[11px] text-mm-text-faint tabular-nums w-6 text-right flex-shrink-0 pt-0.5">
                {seg.heading_level ? `H${seg.heading_level}` : `\u00B6${seg.sequence_order + 1}`}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm text-mm-text ${seg.heading_level ? 'font-semibold' : ''}`}>
                  {searchLower ? highlightText(seg.text, search ?? '') : seg.text}
                </p>
                {(appliedCodeIds.length > 0 || onCodeChange) && (
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {onCodeChange ? (
                      <InlineCodeActions
                        projectId={projectId}
                        itemType="segment"
                        itemId={seg.id}
                        appliedCodeIds={appliedCodeIds}
                        codeMap={codeMap}
                        allCodes={allCodes}
                        onCodeChange={onCodeChange}
                        onFocusCode={onFocusCode ?? onCodeClick}
                      />
                    ) : (
                      appliedCodeIds.map(cid => {
                        const code = codeMap.get(cid)
                        if (!code) return null
                        return (
                          <CodeChip
                            key={cid}
                            code={code}
                            size="xs"
                            onClick={onFocusCode ?? onCodeClick}
                          />
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-mm-text-faint mt-2">
        {searchLower ? `${segments.length} match${segments.length !== 1 ? 'es' : ''} of ` : ''}
        {totalCount} segment{totalCount !== 1 ? 's' : ''}
        {' \u00B7 '}
        {codedCount} coded
      </p>
    </div>
  )
}


// ── Comment Column Reader ────────────────────────────────────────────────

function CommentColumnReader({
  projectId,
  columnId,
  columnInfo,
  codeMap,
  allCodes,
  onCodeClick,
  search,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: {
  projectId: number
  columnId: number
  columnInfo?: TextColumnInfo
  codeMap: Map<number, Code>
  allCodes: Code[]
  onCodeClick?: (codeId: number) => void
  search?: string
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['text-column-readonly', projectId, columnId],
    queryFn: () => textCodingApi.list(projectId, {
      column_ids: String(columnId),
    }),
    enabled: !!columnId,
  })

  if (isLoading) return <div className="text-center py-8 text-mm-text-muted">Loading texts...</div>
  if (!data) return <div className="text-center py-8 text-mm-text-muted">No data available.</div>

  const columnLabel = columnInfo
    ? (columnInfo.column_name || columnInfo.column_text.slice(0, 60))
    : 'Text Column'
  const datasetLabel = columnInfo?.dataset_name ?? ''

  const searchLower = (search ?? '').toLowerCase()
  const allComments = data.texts ?? []
  const comments = searchLower ? allComments.filter(c => (c.value_text || '').toLowerCase().includes(searchLower)) : allComments

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">{columnLabel}</h3>
          {datasetLabel && (
            <p className="text-sm text-mm-text-muted">{datasetLabel}</p>
          )}
        </div>
        <Link
          to={`/projects/${projectId}/datasets/text-coding`}
          className="text-sm text-mm-blue-text hover:underline flex items-center gap-1"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open in Text Coding
        </Link>
      </div>

      <div className="space-y-2">
        {comments.length === 0 ? (
          <div className="text-center py-8 text-mm-text-muted">
            {searchLower ? 'No comments match your search.' : 'No comments in this column.'}
          </div>
        ) : (
          comments.map(comment => {
            const isFocused = focusedCodeId == null || (comment.applied_code_ids ?? []).includes(focusedCodeId)
            return (
            <div
              key={comment.dataset_value_id}
              className="border rounded-lg overflow-hidden bg-mm-surface"
              style={{
                opacity: isFocused ? undefined : 0.35,
                filter: isFocused ? undefined : 'saturate(0.3)',
                transition: 'opacity 200ms, filter 200ms',
              }}
            >
              <div className="flex items-start gap-2 py-2.5 px-3 group">
                <MessageSquare className="w-4 h-4 text-mm-text-faint flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-mm-text-secondary">
                      {comment.row_identifier || comment.participant_name || `Row ${comment.dataset_row_id}`}
                    </span>
                  </div>
                  <p className="text-sm text-mm-text">
                    {searchLower && comment.value_text ? highlightText(comment.value_text, search ?? '') : (comment.value_text || '\u2013')}
                  </p>
                  {(comment.applied_code_ids?.length > 0 || onCodeChange) && (
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      {onCodeChange ? (
                        <InlineCodeActions
                          projectId={projectId}
                          itemType="text"
                          itemId={comment.dataset_value_id}
                          appliedCodeIds={comment.applied_code_ids ?? []}
                          codeMap={codeMap}
                          allCodes={allCodes}
                          onCodeChange={onCodeChange}
                          onFocusCode={onFocusCode ?? onCodeClick}
                        />
                      ) : (
                        comment.applied_code_ids.map((cid: number) => {
                          const code = codeMap.get(cid)
                          if (!code) return null
                          return (
                            <CodeChip
                              key={cid}
                              code={code}
                              size="xs"
                              onClick={onFocusCode ?? onCodeClick}
                            />
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            )
          })
        )}
      </div>

      <p className="text-xs text-mm-text-faint mt-2">
        {searchLower ? `${comments.length} match${comments.length !== 1 ? 'es' : ''} of ` : ''}
        {allComments.length} comment{allComments.length !== 1 ? 's' : ''}
        {columnInfo && ` \u00B7 ${columnInfo.coded_count} coded`}
      </p>
    </div>
  )
}
