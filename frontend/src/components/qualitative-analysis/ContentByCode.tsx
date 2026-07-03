import { useState, useMemo, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SELECTED_ROW } from '@/lib/selection'
import { Link } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Quote,
  ArrowLeft,
  Search,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import BlindScopeNotice from './BlindScopeNotice'
import {
  codeAnalysisApi,
  type Code,
  type CodeFrequencyItem,
  type CodeAnalysisFilterParams,
} from '@/lib/api'
import { getSpeakerInitials } from '@/lib/conversation-import-utils'
import { getCodeColor, getUnfocusedStyle } from '@/lib/utils'
import CodeChip from './CodeChip'
import InlineCodeActions from './InlineCodeActions'
import { highlightText } from './highlight-text'

interface ContentByCodeProps {
  projectId: number
  codes: Code[]
  allCodes?: Code[]
  frequencies?: CodeFrequencyItem[]
  selectedContentCodeId: number | null
  onCodeSelect: (codeId: number) => void
  filterParams: CodeAnalysisFilterParams
  source: 'all' | 'conversations' | 'text'
  /** Whether any conversations are selected in the Sources sidebar. When false, segments section is hidden. */
  hasConversations?: boolean
  /** Whether any comment columns are selected in the Sources sidebar. When false, comments section is hidden. */
  hasCommentColumns?: boolean
  /** Whether any documents are selected in the Sources sidebar. When false, documents section is hidden. */
  hasDocuments?: boolean
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
  /** Blind mode active (multi-coder, colleagues hidden). Drives the self-only
   *  notice on the selected-code detail so the all-coder codebook/search counts
   *  don't look broken when the drill-through shows fewer/no segments (#454). */
  blind?: boolean
  /** Flip blindness (reveal flow is confirmed + logged by BlindModeToggle). */
  onReveal?: (surface?: string) => void
}

export default function ContentByCode({
  projectId,
  codes,
  allCodes,
  frequencies,
  selectedContentCodeId,
  onCodeSelect,
  filterParams,
  source,
  hasConversations = true,
  hasCommentColumns = true,
  hasDocuments = false,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
  blind = false,
  onReveal,
}: ContentByCodeProps) {
  const [search, setSearch] = useState('')
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset search when selected code changes
  useEffect(() => { setSearch('') }, [selectedContentCodeId])
  const activeCodes = useMemo(() => codes.filter(c => c.is_active), [codes])

  // Build a code map for rendering code chips (uses allCodes so co-applied chips always render)
  const chipCodes = allCodes ?? codes
  const codeMap = useMemo(() => {
    const m = new Map<number, Code>()
    for (const c of chipCodes) m.set(c.id, c)
    return m
  }, [chipCodes])

  // Build a frequency map for count badges in the code list
  const freqMap = useMemo(() => {
    if (!frequencies) return new Map<number, number>()
    const m = new Map<number, number>()
    for (const f of frequencies) {
      const count = source === 'text'
        ? f.text_count
        : source === 'conversations'
          ? f.segment_count
          : f.segment_count + f.text_count
      m.set(f.code_id, count)
    }
    return m
  }, [frequencies, source])

  // Group codes by category for the list
  const groupedCodes = useMemo(() => {
    const categories = new Map<string, { name: string; codes: Code[] }>()
    const uncategorized: Code[] = []
    for (const code of activeCodes) {
      if (code.category_name) {
        const key = code.category_name
        if (!categories.has(key)) categories.set(key, { name: key, codes: [] })
        categories.get(key)!.codes.push(code)
      } else {
        uncategorized.push(code)
      }
    }
    return { categories: Array.from(categories.values()), uncategorized }
  }, [activeCodes])

  if (!selectedContentCodeId) {
    // Show code list for selection
    return (
      <div className="flex gap-6">
        <div className="w-full max-w-lg">
          <h3 className="text-sm font-semibold text-mm-text-secondary mb-3">Select a code to browse its content</h3>
          <div className="border rounded-lg divide-y bg-mm-surface">
            {groupedCodes.categories.map(cat => (
              <div key={cat.name}>
                <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                  {cat.name}
                </div>
                {cat.codes.map(code => (
                  <CodeListItem
                    key={code.id}
                    code={code}
                    count={freqMap.get(code.id) ?? 0}
                    isSelected={false}
                    onClick={() => onCodeSelect(code.id)}
                    source={source}
                  />
                ))}
              </div>
            ))}
            {groupedCodes.uncategorized.length > 0 && (
              <div>
                {groupedCodes.categories.length > 0 && (
                  <div className="px-3 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                    Uncategorized
                  </div>
                )}
                {groupedCodes.uncategorized.map(code => (
                  <CodeListItem
                    key={code.id}
                    code={code}
                    count={freqMap.get(code.id) ?? 0}
                    isSelected={false}
                    onClick={() => onCodeSelect(code.id)}
                    source={source}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Code is selected — show content
  const selectedCode = codeMap.get(selectedContentCodeId)

  // Derive counts from frequency data for the header
  const selectedFreq = frequencies?.find(f => f.code_id === selectedContentCodeId)
  const segCount = selectedFreq?.segment_count ?? 0
  const commentCount = selectedFreq?.text_count ?? 0

  const showSegments = source !== 'text' && hasConversations
  const showComments = source !== 'conversations' && hasCommentColumns
  const showDocuments = source !== 'text' && hasDocuments

  // Build count summary for header
  const countParts: string[] = []
  if (showSegments && segCount > 0) countParts.push(`${segCount} segment${segCount !== 1 ? 's' : ''}`)
  if (showComments && commentCount > 0) countParts.push(`${commentCount} text${commentCount !== 1 ? 's' : ''}`)

  return (
    <div className="space-y-4">
      {/* Back link + Search (right-aligned) */}
      <div className="flex items-center gap-3">
        <button
          className="inline-flex items-center gap-1 text-sm text-mm-text-muted hover:text-mm-text"
          onClick={() => onCodeSelect(0)}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All codes
        </button>
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-muted" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search segments and texts…"
            className="pl-8 h-8 text-sm w-56"
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

      {/* Code header with inline count */}
      {selectedCode && (
        <div className="flex items-center gap-2">
          <span
            className="w-4 h-4 rounded-sm flex-shrink-0"
            style={{ backgroundColor: getCodeColor(selectedCode) }}
          />
          <span className="font-semibold text-lg">{selectedCode.name}</span>
          {selectedCode.category_name && (
            <>
              <span className="text-mm-text-faint">·</span>
              <span className="text-sm text-mm-text-muted">{selectedCode.category_name}</span>
            </>
          )}
          {countParts.length > 0 && (
            <>
              <span className="text-mm-text-faint">·</span>
              <span className="text-sm text-mm-text-faint">{countParts.join(', ')}</span>
            </>
          )}
        </div>
      )}

      {/* Blind-mode self-only notice (#454, single-sourced via #517). The
          codebook/search counts are project-wide (all coders); while blind this
          view shows only YOUR coding, so without this the drill-through looks
          broken ("3 segments" → none). */}
      <BlindScopeNotice blind={blind} onReveal={onReveal}>
        Blind mode is on — showing only your own coding for this code. Project
        counts (codebook, search) include every coder.
      </BlindScopeNotice>

      {/* Conversation Segments section */}
      {showSegments && (
        <div>
          {source === 'all' && showComments && (
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs font-medium text-mm-text-muted uppercase tracking-wide">Conversation Segments</span>
              <div className="flex-1 border-b border-mm-border-subtle" />
            </div>
          )}
          <SegmentsSection
            projectId={projectId}
            codeId={selectedContentCodeId}
            codeMap={codeMap}
            allCodes={chipCodes}
            filterParams={filterParams}
            search={search}
            focusedCodeId={focusedCodeId}
            onFocusCode={onFocusCode}
            onCodeChange={onCodeChange}
          />
        </div>
      )}

      {/* Coded Comments section */}
      {showComments && (
        <div>
          {source === 'all' && showSegments && (
            <div className="flex items-center gap-3 mb-3 mt-2">
              <span className="text-xs font-medium text-mm-text-muted uppercase tracking-wide">Coded Texts</span>
              <div className="flex-1 border-b border-mm-border-subtle" />
            </div>
          )}
          <CommentsSection
            projectId={projectId}
            codeId={selectedContentCodeId}
            codeMap={codeMap}
            allCodes={chipCodes}
            participantIds={filterParams.participant_ids}
            textColumnIds={filterParams.text_column_ids}
            coderIds={filterParams.coder_ids}
            layerScope={filterParams.layer_scope}
            search={search}
            focusedCodeId={focusedCodeId}
            onFocusCode={onFocusCode}
            onCodeChange={onCodeChange}
          />
        </div>
      )}

      {/* Document Segments section */}
      {showDocuments && (
        <div>
          {(showSegments || showComments) && (
            <div className="flex items-center gap-3 mb-3 mt-2">
              <span className="text-xs font-medium text-mm-text-muted uppercase tracking-wide">Document Segments</span>
              <div className="flex-1 border-b border-mm-border-subtle" />
            </div>
          )}
          <DocumentSegmentsSection
            projectId={projectId}
            codeId={selectedContentCodeId}
            codeMap={codeMap}
            allCodes={chipCodes}
            filterParams={filterParams}
            search={search}
            focusedCodeId={focusedCodeId}
            onFocusCode={onFocusCode}
            onCodeChange={onCodeChange}
          />
        </div>
      )}

      {/* Code navigation bar at bottom */}
      <CodeNavBar
        codes={activeCodes}
        currentCodeId={selectedContentCodeId}
        onCodeSelect={onCodeSelect}
        freqMap={freqMap}
      />
    </div>
  )
}


// ── Code List Item ───────────────────────────────────────────────────────

function CodeListItem({
  code,
  count,
  isSelected,
  onClick,
  source,
}: {
  code: Code
  count: number
  isSelected: boolean
  onClick: () => void
  source: 'all' | 'conversations' | 'text'
}) {
  const unitLabel = source === 'text' ? 'text' : source === 'conversations' ? 'segment' : 'instance'

  return (
    <button
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-mm-surface-hover transition-colors ${
        isSelected ? SELECTED_ROW : ''
      }`}
      onClick={onClick}
    >
      <span
        className="w-3 h-3 rounded-sm flex-shrink-0"
        style={{ backgroundColor: getCodeColor(code) }}
      />
      <span className="flex-1 text-sm truncate">{code.name}</span>
      {count > 0 && (
        <span className="text-xs text-mm-text-faint tabular-nums">
          {count} {unitLabel}{count !== 1 ? 's' : ''}
        </span>
      )}
    </button>
  )
}


// ── Segments Section ─────────────────────────────────────────────────────

function SegmentsSection({
  projectId,
  codeId,
  codeMap,
  allCodes,
  filterParams,
  search,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: {
  projectId: number
  codeId: number
  codeMap: Map<number, Code>
  allCodes: Code[]
  filterParams: CodeAnalysisFilterParams
  search?: string
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}) {
  const [collapsedConvs, setCollapsedConvs] = useState<Set<number>>(new Set())
  const [loadedLimit, setLoadedLimit] = useState(200)

  /* eslint-disable react-hooks/set-state-in-effect -- reset pagination on code change */
  useEffect(() => {
    setLoadedLimit(200)
    setCollapsedConvs(new Set())
  }, [codeId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const { data, isLoading } = useQuery({
    queryKey: [
      'code-segments-context', projectId, codeId,
      filterParams.exclude_facilitator,
      filterParams.conversation_ids,
      filterParams.participant_ids,
      filterParams.text_column_ids,
      filterParams.document_ids,
      filterParams.coder_ids,
      filterParams.layer_scope,
      loadedLimit, 0,
    ],
    queryFn: () => codeAnalysisApi.segmentsWithContext(projectId, codeId, {
      ...filterParams,
      context_size: 1,
      limit: loadedLimit,
      offset: 0,
    }),
    enabled: !!codeId,
  })

  const toggleConv = useCallback((convId: number) => {
    setCollapsedConvs(prev => {
      const next = new Set(prev)
      if (next.has(convId)) next.delete(convId)
      else next.add(convId)
      return next
    })
  }, [])

  const searchLower = (search ?? '').toLowerCase()
  const filteredConversations = useMemo(() => {
    if (!data) return []
    if (!searchLower) return data.conversations
    return data.conversations.map(conv => ({
      ...conv,
      segments: conv.segments.filter(seg => seg.text.toLowerCase().includes(searchLower)),
    })).filter(conv => conv.segments.length > 0)
  }, [data, searchLower])

  if (isLoading) return <div className="text-center py-8 text-mm-text-muted">Loading segments...</div>
  if (!data) return <div className="text-center py-8 text-mm-text-muted">No data available.</div>

  const sortedConversations = [...filteredConversations].sort(
    (a, b) => b.segments.length - a.segments.length,
  )

  const matchCount = searchLower ? sortedConversations.reduce((n, c) => n + c.segments.length, 0) : null

  if (sortedConversations.length === 0) {
    return <div className="text-center py-8 text-mm-text-muted">
      {searchLower ? 'No segments match your search.' : 'No segments found for this code with current filters.'}
    </div>
  }

  return (
    <div className="space-y-2">
      {matchCount != null && (
        <p className="text-sm text-mm-text-faint">
          {matchCount} match{matchCount !== 1 ? 'es' : ''} of {data.total_segments} segment{data.total_segments !== 1 ? 's' : ''}
        </p>
      )}

      {sortedConversations.map(conv => {
        const collapsed = collapsedConvs.has(conv.conversation_id)
        return (
          <div key={conv.conversation_id} className="border rounded-lg overflow-hidden bg-mm-surface">
            <button
              className="w-full flex items-center justify-between px-4 py-2 bg-mm-bg hover:bg-mm-surface-hover transition-colors text-left"
              onClick={() => toggleConv(conv.conversation_id)}
              aria-expanded={!collapsed}
            >
              <span className="flex items-center gap-2">
                {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                <span className="font-medium text-sm">{conv.conversation_name}</span>
              </span>
              <span className="text-xs text-mm-text-muted">
                {conv.segments.length} segment{conv.segments.length !== 1 ? 's' : ''}
              </span>
            </button>
            {!collapsed && (
              <div className="px-3 py-2 space-y-3 border-t border-mm-border-subtle">
                {conv.segments.map(seg => {
                  const isFocused = focusedCodeId == null || seg.applied_code_ids.includes(focusedCodeId)
                  return (
                  <div
                    key={seg.id}
                    className="border border-mm-border-subtle rounded-md overflow-hidden bg-mm-surface"
                    style={getUnfocusedStyle(isFocused)}
                  >
                    {seg.preceding_context.map(ctx => (
                      <div key={ctx.id} className="bg-mm-bg/60 px-3 border-b border-mm-border-subtle">
                        <ContextLine
                          segment={ctx}
                          projectId={projectId}
                          conversationId={conv.conversation_id}
                        />
                      </div>
                    ))}
                    <div className="flex items-start gap-2 py-2.5 px-3 bg-mm-surface border-l-[3px] border-l-amber-400 group">
                      <span
                        className={`w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center ring-1 flex-shrink-0 mt-0.5 ${
                          seg.is_facilitator
                            ? 'bg-purple-200 dark:bg-purple-900/50 text-purple-800 dark:text-purple-300 ring-purple-300 dark:ring-purple-700'
                            : 'bg-orange-200 dark:bg-orange-900/50 text-orange-800 dark:text-orange-300 ring-orange-300 dark:ring-orange-700'
                        }`}
                        title={seg.speaker_name || 'Unknown'}
                      >
                        {getSpeakerInitials(seg.speaker_name)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{searchLower ? highlightText(seg.text, search ?? '') : seg.text}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {seg.is_quoted && (
                            <Quote className="w-3 h-3 text-amber-400 fill-amber-400" />
                          )}
                          {onCodeChange ? (
                            <InlineCodeActions
                              projectId={projectId}
                              itemType="segment"
                              itemId={seg.id}
                              appliedCodeIds={seg.applied_code_ids}
                              codeMap={codeMap}
                              allCodes={allCodes}
                              onCodeChange={onCodeChange}
                              excludeCodeId={codeId}
                              onFocusCode={onFocusCode}
                            />
                          ) : (
                            seg.applied_code_ids
                              .filter(cid => cid !== codeId)
                              .map(cid => {
                                const c = codeMap.get(cid)
                                if (!c) return null
                                return <CodeChip key={cid} code={c} size="xs" onClick={onFocusCode} />
                              })
                          )}
                          {seg.participant_name && (
                            <span className="text-[11px] text-mm-text-faint">{seg.participant_name}</span>
                          )}
                          <Link
                            to={`/projects/${projectId}/conversations/${conv.conversation_id}?segment=${seg.id}`}
                            className="text-[11px] text-mm-blue-text hover:underline opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center gap-0.5"
                          >
                            <ExternalLink className="w-3 h-3" />
                            View in conversation
                          </Link>
                        </div>
                      </div>
                    </div>
                    {seg.following_context.map(ctx => (
                      <div key={ctx.id} className="bg-mm-bg/60 px-3 border-t border-mm-border-subtle">
                        <ContextLine
                          segment={ctx}
                          projectId={projectId}
                          conversationId={conv.conversation_id}
                        />
                      </div>
                    ))}
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {data.has_more && (
        <div className="text-center py-3">
          <Button variant="outline" size="sm" onClick={() => setLoadedLimit(l => l + 200)}>
            Load more ({Math.max(0, data.total_segments - loadedLimit)} remaining)
          </Button>
        </div>
      )}
    </div>
  )
}


// ── Context Line ─────────────────────────────────────────────────────────

function ContextLine({
  segment,
  projectId,
  conversationId,
}: {
  segment: { id: number; speaker_name: string | null; is_facilitator: boolean; text: string; speaker_color_index: number }
  projectId: number
  conversationId: number
}) {
  return (
    <div className="flex items-start gap-2 py-0.5 pl-2 group/ctx">
      <span
        className={`w-5 h-5 rounded-full text-[9px] font-semibold flex items-center justify-center ring-1 flex-shrink-0 mt-0.5 opacity-50 ${
          segment.is_facilitator
            ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400 ring-purple-200 dark:ring-purple-700'
            : 'bg-orange-100 dark:bg-orange-900/50 text-orange-600 dark:text-orange-400 ring-orange-200 dark:ring-orange-700'
        }`}
        title={segment.speaker_name || 'Unknown'}
      >
        {getSpeakerInitials(segment.speaker_name)}
      </span>
      <p className="text-xs text-mm-text-faint flex-1">{segment.text}</p>
      <Link
        to={`/projects/${projectId}/conversations/${conversationId}?segment=${segment.id}`}
        className="text-[11px] text-mm-blue-text hover:underline opacity-0 group-hover/ctx:opacity-100 focus:opacity-100 transition-opacity flex-shrink-0"
      >
        <ExternalLink className="w-3 h-3" />
      </Link>
    </div>
  )
}


// ── Comments Section ─────────────────────────────────────────────────────

function CommentsSection({
  projectId,
  codeId,
  codeMap,
  allCodes,
  participantIds,
  textColumnIds,
  coderIds,
  layerScope,
  search,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: {
  projectId: number
  codeId: number
  codeMap: Map<number, Code>
  allCodes: Code[]
  participantIds?: string
  textColumnIds?: string
  coderIds?: string
  layerScope?: 'human' | 'consensus'
  search?: string
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}) {
  const [collapsedDatasets, setCollapsedDatasets] = useState<Set<number>>(new Set())
  const [loadedLimit, setLoadedLimit] = useState(200)

  /* eslint-disable react-hooks/set-state-in-effect -- reset pagination on code change */
  useEffect(() => {
    setLoadedLimit(200)
    setCollapsedDatasets(new Set())
  }, [codeId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const { data, isLoading } = useQuery({
    queryKey: ['code-texts-context', projectId, codeId, participantIds, textColumnIds, coderIds, layerScope, loadedLimit, 0],
    queryFn: () => codeAnalysisApi.textsWithContext(projectId, codeId, {
      participant_ids: participantIds,
      text_column_ids: textColumnIds,
      coder_ids: coderIds,
      layer_scope: layerScope,
      limit: loadedLimit,
      offset: 0,
    }),
    enabled: !!codeId,
  })

  const toggleDataset = useCallback((dsId: number) => {
    setCollapsedDatasets(prev => {
      const next = new Set(prev)
      if (next.has(dsId)) next.delete(dsId)
      else next.add(dsId)
      return next
    })
  }, [])

  const searchLower = (search ?? '').toLowerCase()
  const filteredDatasets = useMemo(() => {
    if (!data) return []
    if (!searchLower) return data.datasets
    return data.datasets.map(ds => ({
      ...ds,
      texts: ds.texts.filter(c => c.value_text.toLowerCase().includes(searchLower)),
    })).filter(ds => ds.texts.length > 0)
  }, [data, searchLower])

  if (isLoading) return <div className="text-center py-8 text-mm-text-muted">Loading texts...</div>
  if (!data) return <div className="text-center py-8 text-mm-text-muted">No data available.</div>

  const sortedDatasets = [...filteredDatasets].sort(
    (a, b) => b.texts.length - a.texts.length,
  )

  const matchCount = searchLower ? sortedDatasets.reduce((n, ds) => n + ds.texts.length, 0) : null

  if (sortedDatasets.length === 0) {
    return <div className="text-center py-8 text-mm-text-muted">
      {searchLower ? 'No texts match your search.' : 'No coded texts found for this code with current filters.'}
    </div>
  }

  return (
    <div className="space-y-2">
      {matchCount != null && (
        <p className="text-sm text-mm-text-faint">
          {matchCount} match{matchCount !== 1 ? 'es' : ''} of {data.total_texts} text{data.total_texts !== 1 ? 's' : ''}
        </p>
      )}

      {sortedDatasets.map(ds => {
        const collapsed = collapsedDatasets.has(ds.dataset_id)
        return (
          <div key={ds.dataset_id} className="border rounded-lg overflow-hidden bg-mm-surface">
            <button
              className="w-full flex items-center justify-between px-4 py-2 bg-mm-bg hover:bg-mm-surface-hover transition-colors text-left"
              onClick={() => toggleDataset(ds.dataset_id)}
              aria-expanded={!collapsed}
            >
              <span className="flex items-center gap-2">
                {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                <span className="font-medium text-sm">{ds.dataset_name}</span>
              </span>
              <span className="text-xs text-mm-text-muted">
                {ds.texts.length} comment{ds.texts.length !== 1 ? 's' : ''}
              </span>
            </button>
            {!collapsed && (
              <div className="px-3 py-2 space-y-3 border-t border-mm-border-subtle">
                {ds.texts.map(comment => {
                  const isFocused = focusedCodeId == null || comment.applied_code_ids.includes(focusedCodeId)
                  return (
                  <div
                    key={comment.dataset_value_id}
                    className="border border-mm-border-subtle rounded-md overflow-hidden bg-mm-surface"
                    style={getUnfocusedStyle(isFocused)}
                  >
                    <div className="flex items-start gap-2 py-2.5 px-3 bg-mm-surface border-l-[3px] border-l-amber-400 group">
                      <MessageSquare className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {comment.row_identifier && (
                            <span className="text-xs font-medium text-mm-text-secondary">
                              {comment.row_identifier}
                            </span>
                          )}
                          <span className="text-[11px] text-mm-text-faint">{comment.column_name}</span>
                        </div>
                        <p className="text-sm">{searchLower ? highlightText(comment.value_text, search ?? '') : comment.value_text}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {onCodeChange ? (
                            <InlineCodeActions
                              projectId={projectId}
                              itemType="text"
                              itemId={comment.dataset_value_id}
                              appliedCodeIds={comment.applied_code_ids}
                              codeMap={codeMap}
                              allCodes={allCodes}
                              onCodeChange={onCodeChange}
                              excludeCodeId={codeId}
                              onFocusCode={onFocusCode}
                            />
                          ) : (
                            comment.applied_code_ids
                              .filter(cid => cid !== codeId)
                              .map(cid => {
                                const c = codeMap.get(cid)
                                if (!c) return null
                                return <CodeChip key={cid} code={c} size="xs" onClick={onFocusCode} />
                              })
                          )}
                          <span className="text-[11px] text-mm-text-faint">
                            {comment.word_count} word{comment.word_count !== 1 ? 's' : ''}
                          </span>
                          <Link
                            to={`/projects/${projectId}/datasets/text-coding`}
                            className="text-[11px] text-mm-blue-text hover:underline opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center gap-0.5"
                          >
                            <ExternalLink className="w-3 h-3" />
                            View in Text Coding
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {data.has_more && (
        <div className="text-center py-3">
          <Button variant="outline" size="sm" onClick={() => setLoadedLimit(l => l + 200)}>
            Load more ({Math.max(0, data.total_texts - loadedLimit)} remaining)
          </Button>
        </div>
      )}
    </div>
  )
}


// ── Document Segments Section ────────────────────────────────────────────

function DocumentSegmentsSection({
  projectId,
  codeId,
  codeMap,
  allCodes,
  filterParams,
  search,
  focusedCodeId,
  onFocusCode,
  onCodeChange,
}: {
  projectId: number
  codeId: number
  codeMap: Map<number, Code>
  allCodes: Code[]
  filterParams: CodeAnalysisFilterParams
  search?: string
  focusedCodeId?: number | null
  onFocusCode?: (codeId: number) => void
  onCodeChange?: () => void
}) {
  const [collapsedDocs, setCollapsedDocs] = useState<Set<number>>(new Set())

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset collapsed state on code change
    setCollapsedDocs(new Set())
  }, [codeId])

  // Reuse the same segments query — the backend returns documents alongside conversations
  const { data, isLoading } = useQuery({
    queryKey: [
      'code-segments-context', projectId, codeId,
      filterParams.exclude_facilitator,
      filterParams.conversation_ids,
      filterParams.participant_ids,
      filterParams.text_column_ids,
      filterParams.document_ids,
      filterParams.coder_ids,
      filterParams.layer_scope,
      200, 0,
    ],
    queryFn: () => codeAnalysisApi.segmentsWithContext(projectId, codeId, {
      ...filterParams,
      context_size: 1,
      limit: 200,
      offset: 0,
    }),
    enabled: !!codeId,
  })

  const toggleDoc = useCallback((docId: number) => {
    setCollapsedDocs(prev => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
  }, [])

  const searchLower = (search ?? '').toLowerCase()
  const filteredDocuments = useMemo(() => {
    if (!data?.documents) return []
    if (!searchLower) return data.documents
    return data.documents.map(doc => ({
      ...doc,
      segments: doc.segments.filter(seg => seg.text.toLowerCase().includes(searchLower)),
    })).filter(doc => doc.segments.length > 0)
  }, [data, searchLower])

  if (isLoading) return <div className="text-center py-8 text-mm-text-muted">Loading document segments...</div>
  if (!data?.documents || data.documents.length === 0) {
    return <div className="text-center py-8 text-mm-text-muted">
      {searchLower ? 'No document segments match your search.' : 'No document segments found for this code with current filters.'}
    </div>
  }

  const sortedDocuments = [...filteredDocuments].sort(
    (a, b) => b.segments.length - a.segments.length,
  )

  if (sortedDocuments.length === 0) {
    return <div className="text-center py-8 text-mm-text-muted">No document segments match your search.</div>
  }

  return (
    <div className="space-y-2">
      {sortedDocuments.map(doc => {
        const collapsed = collapsedDocs.has(doc.document_id)
        return (
          <div key={doc.document_id} className="border rounded-lg overflow-hidden bg-mm-surface">
            <button
              className="w-full flex items-center justify-between px-4 py-2 bg-mm-bg hover:bg-mm-surface-hover transition-colors text-left"
              onClick={() => toggleDoc(doc.document_id)}
              aria-expanded={!collapsed}
            >
              <span className="flex items-center gap-2">
                {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                <span className="font-medium text-sm">{doc.document_name}</span>
              </span>
              <span className="text-xs text-mm-text-muted">
                {doc.segments.length} segment{doc.segments.length !== 1 ? 's' : ''}
              </span>
            </button>
            {!collapsed && (
              <div className="px-3 py-2 space-y-3 border-t border-mm-border-subtle">
                {doc.segments.map(seg => {
                  const isFocused = focusedCodeId == null || seg.applied_code_ids.includes(focusedCodeId)
                  return (
                    <div
                      key={seg.id}
                      className="border border-mm-border-subtle rounded-md overflow-hidden bg-mm-surface"
                      style={getUnfocusedStyle(isFocused)}
                    >
                      {seg.preceding_context.map(ctx => (
                        <div key={ctx.id} className="bg-mm-bg/60 px-3 py-1 border-b border-mm-border-subtle">
                          <p className="text-xs text-mm-text-faint">{ctx.text}</p>
                        </div>
                      ))}
                      <div className="flex items-start gap-2 py-2.5 px-3 bg-mm-surface border-l-[3px] border-l-purple-400 group">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm">{searchLower ? highlightText(seg.text, search ?? '') : seg.text}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {seg.is_quoted && (
                              <Quote className="w-3 h-3 text-amber-400 fill-amber-400" />
                            )}
                            {onCodeChange ? (
                              <InlineCodeActions
                                projectId={projectId}
                                itemType="segment"
                                itemId={seg.id}
                                appliedCodeIds={seg.applied_code_ids}
                                codeMap={codeMap}
                                allCodes={allCodes}
                                onCodeChange={onCodeChange}
                                excludeCodeId={codeId}
                                onFocusCode={onFocusCode}
                              />
                            ) : (
                              seg.applied_code_ids
                                .filter(cid => cid !== codeId)
                                .map(cid => {
                                  const c = codeMap.get(cid)
                                  if (!c) return null
                                  return <CodeChip key={cid} code={c} size="xs" onClick={onFocusCode} />
                                })
                            )}
                            <Link
                              to={`/projects/${projectId}/documents/${doc.document_id}`}
                              className="text-[11px] text-mm-blue-text hover:underline opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center gap-0.5"
                            >
                              <ExternalLink className="w-3 h-3" />
                              View in document
                            </Link>
                          </div>
                        </div>
                      </div>
                      {seg.following_context.map(ctx => (
                        <div key={ctx.id} className="bg-mm-bg/60 px-3 py-1 border-t border-mm-border-subtle">
                          <p className="text-xs text-mm-text-faint">{ctx.text}</p>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}


// ── Code Navigation Bar ──────────────────────────────────────────────────

function CodeNavBar({
  codes,
  currentCodeId,
  onCodeSelect,
  freqMap,
}: {
  codes: Code[]
  currentCodeId: number
  onCodeSelect: (codeId: number) => void
  freqMap: Map<number, number>
}) {
  const currentIndex = codes.findIndex(c => c.id === currentCodeId)
  const prevCode = currentIndex > 0 ? codes[currentIndex - 1] : null
  const nextCode = currentIndex < codes.length - 1 ? codes[currentIndex + 1] : null

  return (
    <div className="flex items-center justify-between border-t pt-4 mt-6">
      {prevCode ? (
        <button
          className="text-sm text-mm-text-secondary hover:text-mm-text flex items-center gap-1"
          onClick={() => onCodeSelect(prevCode.id)}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ backgroundColor: getCodeColor(prevCode) }}
          />
          {prevCode.name}
          {(freqMap.get(prevCode.id) ?? 0) > 0 && (
            <span className="text-mm-text-faint text-xs">({freqMap.get(prevCode.id)})</span>
          )}
        </button>
      ) : (
        <div />
      )}
      <span className="text-xs text-mm-text-faint">
        {currentIndex + 1} of {codes.length} codes
      </span>
      {nextCode ? (
        <button
          className="text-sm text-mm-text-secondary hover:text-mm-text flex items-center gap-1"
          onClick={() => onCodeSelect(nextCode.id)}
        >
          <span
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ backgroundColor: getCodeColor(nextCode) }}
          />
          {nextCode.name}
          {(freqMap.get(nextCode.id) ?? 0) > 0 && (
            <span className="text-mm-text-faint text-xs">({freqMap.get(nextCode.id)})</span>
          )}
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      ) : (
        <div />
      )}
    </div>
  )
}
