import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import {
  BookOpen, Shuffle, Eye, EyeOff, Quote, Search, Download, BarChart3, Undo2, Redo2,
  ChevronLeft, ChevronRight, Check, Pencil,
} from 'lucide-react'
import { toast } from 'sonner'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  textCodingApi, codesApi, categoriesApi, excerptsApi, datasetsApi,
  type TextCodingViewConfig, type TextCodingColumn,
} from '@/lib/api'
import { useHistory } from '@/hooks/useHistory'
import TextCodingColumnPicker from '@/components/TextColumnPicker'
import ByTextTable from '@/components/ByTextTable'
import { useCodeChordShortcuts } from '@/hooks/useCodeChordShortcuts'
import ByRecordPanel from '@/components/ByRecordPanel'
import TextCodePanel from '@/components/TextCodePanel'
import TextNotesPanel from '@/components/TextNotesPanel'
import CollapsiblePanel from '@/components/CollapsiblePanel'
import ResizeHandle from '@/components/ResizeHandle'
import MemoPanel from '@/components/MemoPanel'
import CrossAnalysisPanel from '@/components/CrossAnalysisPanel'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import FloatingCreateCode, { type FloatingCoords } from '@/components/FloatingCreateCode'
import FloatingCreateNote from '@/components/FloatingCreateNote'
import { coordsFromElement } from '@/lib/floating-utils'

type ViewMode = 'by_text' | 'by_record'
type ActiveTab = 'coding' | 'analysis'

export default function TextCodingView() {
  const { projectId: pid } = useParams<{ projectId: string }>()
  const projectId = Number(pid)
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const { openCodebook } = useProjectLayout()

  // ── Persisted state (auto-saved to config) ────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('by_text')
  const [focalColumnIds, setFocalColumnIds] = useState<number[]>([])
  const [datasetFilterIds, setDatasetFilterIds] = useState<number[] | null>(null)
  const [randomSeed, setRandomSeed] = useState<number | null>(null)
  const [hideEmpty, setHideEmpty] = useState(true)
  const [contextVisible, setContextVisible] = useState({
    demographics: false,
    otherComments: false,
    nonComments: false,
  })

  // ── Transient state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('coding')
  const [searchInput, setSearchInput] = useState('')
  const [searchText, setSearchText] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [quotedOnly, setQuotedOnly] = useState(false)
  const [selectedValueIds, setSelectedValueIds] = useState<number[]>([])
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null)
  const [focusedPanel, setFocusedPanel] = useState<'main' | 'codes' | 'notes'>('main')
  const [announcement, setAnnouncement] = useState('')
  const [rightPanelWidth, setRightPanelWidth] = useState(288)
  const [panelStates, setPanelStates] = useState({
    codes: { collapsed: false },
    notes: { collapsed: true },
    memos: { collapsed: true },
  })
  const [activeColumnId, setActiveColumnId] = useState<number | null>(null)

  const history = useHistory()
  const configLoadedRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Queries ───────────────────────────────────────────────────────────

  const { data: columnsData } = useQuery({
    queryKey: ['text-columns', projectId],
    queryFn: () => textCodingApi.columns(projectId),
  })
  const textColumns = useMemo(() => columnsData?.columns ?? [], [columnsData?.columns])

  const { data: configData } = useQuery({
    queryKey: ['text-config', projectId],
    queryFn: () => textCodingApi.getConfig(projectId),
    staleTime: Infinity,
  })

  // Load config on first fetch
  useEffect(() => {
    if (configData && !configLoadedRef.current) {
      configLoadedRef.current = true
      setViewMode((configData.view_mode as ViewMode) || 'by_text')
      setHideEmpty(configData.hide_empty)
      setRandomSeed(configData.random_seed)
      if (configData.context_visibility && typeof configData.context_visibility === 'object') {
        setContextVisible(prev => ({ ...prev, ...configData.context_visibility }))
      }
      if (configData.dataset_filter_ids) {
        setDatasetFilterIds(configData.dataset_filter_ids)
      }

      // URL columns param overrides stored config
      const urlCols = searchParams.get('columns')
      if (urlCols) {
        const parsed = urlCols.split(',').map(Number).filter(n => !isNaN(n))
        if (parsed.length > 0) {
          setFocalColumnIds(parsed)
          return
        }
      }
      if (configData.focal_column_ids?.length) {
        setFocalColumnIds(configData.focal_column_ids)
      }
    }
  }, [configData, searchParams])

  // ── Comments query ────────────────────────────────────────────────────

  const columnIdsStr = focalColumnIds.join(',')

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ['text-data', projectId, columnIdsStr, datasetFilterIds, hideEmpty, searchText, randomSeed, quotedOnly],
    queryFn: () => textCodingApi.list(projectId, {
      column_ids: columnIdsStr,
      dataset_ids: datasetFilterIds?.join(','),
      hide_empty: hideEmpty,
      search: searchText || undefined,
      random_seed: randomSeed ?? undefined,
      quoted_only: quotedOnly,
    }),
    enabled: focalColumnIds.length > 0,
    placeholderData: keepPreviousData,
  })

  const comments = useMemo(() => commentsData?.texts ?? [], [commentsData?.texts])

  // ── Column banner state ─────────────────────────────────────────────

  // Sync active column when focal columns change
  useEffect(() => {
    if (focalColumnIds.length === 0) {
      setActiveColumnId(null)
      return
    }
    setActiveColumnId(prev => {
      if (prev === null || !focalColumnIds.includes(prev)) return focalColumnIds[0]
      return prev
    })
  }, [focalColumnIds])

  const columnLookup = useMemo(() => {
    const map = new Map<number, TextCodingColumn>()
    for (const col of textColumns) map.set(col.column_id, col)
    return map
  }, [textColumns])

  const activeColumn = activeColumnId ? columnLookup.get(activeColumnId) ?? null : null
  const activeColumnIndex = activeColumnId ? focalColumnIds.indexOf(activeColumnId) : -1

  const filteredComments = useMemo(() => {
    if (viewMode !== 'by_text' || !activeColumnId) return comments
    return comments.filter(c => c.column_id === activeColumnId)
  }, [comments, activeColumnId, viewMode])

  const goToColumn = useCallback((delta: number) => {
    const newIdx = activeColumnIndex + delta
    if (newIdx >= 0 && newIdx < focalColumnIds.length) {
      setActiveColumnId(focalColumnIds[newIdx])
      setSelectedValueIds([])
    }
  }, [activeColumnIndex, focalColumnIds])

  // ── Record navigation (By Record mode) ─────────────────────

  const records = useMemo(() => {
    const seen = new Map<number, (typeof comments)[0]>()
    for (const c of comments) {
      if (!seen.has(c.dataset_row_id)) seen.set(c.dataset_row_id, c)
    }
    return Array.from(seen.values())
  }, [comments])

  const currentRecordId = selectedRecordId ?? records[0]?.dataset_row_id ?? null
  const currentRecordIndex = records.findIndex(r => r.dataset_row_id === currentRecordId)

  const goToRecord = useCallback((delta: number) => {
    const newIdx = currentRecordIndex + delta
    if (newIdx >= 0 && newIdx < records.length) {
      setSelectedRecordId(records[newIdx].dataset_row_id)
      setSelectedValueIds([])
    }
  }, [currentRecordIndex, records])

  // ── Column name editing ─────────────────────────────────────────────

  const [isEditingColumnName, setIsEditingColumnName] = useState(false)
  const [columnNameDraft, setColumnNameDraft] = useState('')
  const columnNameInputRef = useRef<HTMLInputElement>(null)

  const updateColumnNameMutation = useMutation({
    mutationFn: (name: string) => {
      if (!activeColumn) throw new Error('No active column')
      return datasetsApi.updateColumnHeader(projectId, activeColumn.dataset_id, activeColumn.column_id, { column_name: name })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['text-columns', projectId] })
      queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
      setIsEditingColumnName(false)
      toast.success('Column renamed across all views')
    },
    onError: () => toast.error('Failed to rename column'),
  })

  const startEditingColumnName = useCallback(() => {
    if (!activeColumn) return
    setColumnNameDraft(activeColumn.column_name || activeColumn.column_text)
    setIsEditingColumnName(true)
    setTimeout(() => columnNameInputRef.current?.select(), 0)
  }, [activeColumn])

  const saveColumnNameEdit = useCallback(() => {
    const trimmed = columnNameDraft.trim()
    const currentName = activeColumn?.column_name || activeColumn?.column_text || ''
    if (!trimmed || trimmed === currentName) {
      setIsEditingColumnName(false)
      return
    }
    updateColumnNameMutation.mutate(trimmed)
  }, [columnNameDraft, activeColumn, updateColumnNameMutation])

  // ── Progress query ────────────────────────────────────────────────────

  const { data: progressData } = useQuery({
    queryKey: ['text-progress', projectId, columnIdsStr],
    queryFn: () => textCodingApi.progress(projectId, {
      column_ids: columnIdsStr || undefined,
    }),
    enabled: focalColumnIds.length > 0,
  })

  // ── Codes query ───────────────────────────────────────────────────────

  const { data: codesData } = useQuery({
    queryKey: ['codes', projectId],
    queryFn: () => codesApi.list(projectId),
  })
  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])

  const { data: categoriesData } = useQuery({
    queryKey: ['categories', projectId],
    queryFn: () => categoriesApi.list(projectId),
  })
  const categories = useMemo(() => categoriesData?.categories ?? [], [categoriesData?.categories])

  // Derive chord numbers from display_order position (digits 2-9 for first 8 categories)
  const chordNumberMap = useMemo(() => {
    const sorted = [...categories].sort((a, b) => a.display_order - b.display_order)
    const map = new Map<number, number>()
    sorted.forEach((cat, i) => {
      if (i < 8) map.set(cat.id, i + 2)
    })
    return map
  }, [categories])

  // The chord map now lives inside useCodeChordShortcuts (derived from `codes` via the
  // shared buildShortcutCategories helper — #388 P3.3). chordNumberMap is still used below
  // for the CodePanel labels.

  // ── Auto-save config ──────────────────────────────────────────────────

  const configMutation = useMutation({
    mutationFn: (data: Partial<TextCodingViewConfig>) =>
      textCodingApi.updateConfig(projectId, data),
  })

  useEffect(() => {
    if (!configLoadedRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      configMutation.mutate({
        view_mode: viewMode,
        focal_column_ids: focalColumnIds,
        dataset_filter_ids: datasetFilterIds ?? [],
        random_seed: randomSeed,
        hide_empty: hideEmpty,
        context_visibility: contextVisible,
      })
    }, 500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [viewMode, focalColumnIds, datasetFilterIds, randomSeed, hideEmpty, contextVisible]) // eslint-disable-line react-hooks/exhaustive-deps -- configMutation is a stable mutate call; adding it causes infinite loop

  // ── Code creation ───────────────────────────────────────────────────

  const createCodeMutation = useMutation({
    mutationFn: (name: string) => codesApi.create(projectId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      queryClient.invalidateQueries({ queryKey: ['categories', projectId] })
    },
  })

  // ── Code toggle handler ───────────────────────────────────────────────

  const handleCodeToggle = useCallback(async (codeId: number) => {
    if (selectedValueIds.length === 0) return
    const targets = selectedValueIds

    // Check if all selected already have the code
    const allHave = targets.every(dvId => {
      const c = comments.find(cm => cm.dataset_value_id === dvId)
      return c?.applied_code_ids.includes(codeId)
    })

    if (allHave) {
      // Remove from all
      await history.execute({
        type: 'text_code_remove',
        description: `Remove code from ${targets.length} text(s)`,
        redo: async () => {
          if (targets.length === 1) {
            await textCodingApi.removeCode(projectId, { dataset_value_id: targets[0], code_id: codeId })
          } else {
            await textCodingApi.bulkRemoveCode(projectId, { dataset_value_ids: targets, code_id: codeId })
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['text-progress', projectId] })
        },
        undo: async () => {
          if (targets.length === 1) {
            await textCodingApi.applyCode(projectId, { dataset_value_id: targets[0], code_id: codeId })
          } else {
            await textCodingApi.bulkCode(projectId, { dataset_value_ids: targets, code_id: codeId })
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['text-progress', projectId] })
        },
      })
    } else {
      // Apply to all (bulk)
      await history.execute({
        type: 'text_code_apply',
        description: `Apply code to ${targets.length} text(s)`,
        redo: async () => {
          if (targets.length === 1) {
            await textCodingApi.applyCode(projectId, { dataset_value_id: targets[0], code_id: codeId })
          } else {
            await textCodingApi.bulkCode(projectId, { dataset_value_ids: targets, code_id: codeId })
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['text-progress', projectId] })
        },
        undo: async () => {
          if (targets.length === 1) {
            await textCodingApi.removeCode(projectId, { dataset_value_id: targets[0], code_id: codeId })
          } else {
            await textCodingApi.bulkRemoveCode(projectId, { dataset_value_ids: targets, code_id: codeId })
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['text-progress', projectId] })
        },
      })
    }

    setAnnouncement(allHave ? 'Code removed' : 'Code applied')
    setSavedIndicator(true)
    setTimeout(() => setSavedIndicator(false), 1500)
  }, [selectedValueIds, comments, projectId, history, queryClient])

  // ── Quote toggle ───────────────────────────────────────────────────────

  const handleQuoteToggle = useCallback(async (dvId: number) => {
    const comment = comments.find(c => c.dataset_value_id === dvId)
    const isCurrentlyQuoted = comment?.is_quoted ?? false
    const currentExcerptId = comment?.excerpt_id ?? null

    if (isCurrentlyQuoted && currentExcerptId) {
      // Unquote: delete the excerpt
      let lastExcerptId: number = currentExcerptId
      await history.execute({
        type: 'quote_delete',
        description: 'Unquote comment',
        redo: async () => {
          await excerptsApi.delete(projectId, lastExcerptId)
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
          setAnnouncement('Comment unquoted')
        },
        undo: async () => {
          const excerpt = await excerptsApi.create(projectId, { dataset_value_id: dvId })
          lastExcerptId = excerpt.id
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        },
      })
    } else {
      // Quote: create an excerpt
      let createdExcerptId: number | null = null
      await history.execute({
        type: 'quote_create',
        description: 'Quote comment',
        redo: async () => {
          const excerpt = await excerptsApi.create(projectId, { dataset_value_id: dvId })
          createdExcerptId = excerpt.id
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
          setAnnouncement('Comment quoted')
        },
        undo: async () => {
          if (createdExcerptId) {
            await excerptsApi.delete(projectId, createdExcerptId)
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        },
      })
    }
  }, [projectId, comments, queryClient, history])

  // ── Bulk quote toggle ─────────────────────────────────────────────

  const handleBulkQuoteToggle = useCallback(async () => {
    if (selectedValueIds.length === 0) return

    const allQuoted = selectedValueIds.every(dvId => {
      const c = comments.find(cm => cm.dataset_value_id === dvId)
      return c?.is_quoted ?? false
    })
    const valueIds = [...selectedValueIds]

    if (allQuoted) {
      // Unquote all — collect current excerpt IDs
      const excerptIds: number[] = []
      for (const dvId of valueIds) {
        const c = comments.find(cm => cm.dataset_value_id === dvId)
        if (c?.excerpt_id) excerptIds.push(c.excerpt_id)
      }
      await history.execute({
        type: 'quote_delete',
        description: `Unquote ${valueIds.length} comments`,
        redo: async () => {
          for (const eid of excerptIds) {
            await excerptsApi.delete(projectId, eid)
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        },
        undo: async () => {
          await excerptsApi.bulkCreate(projectId, valueIds.map(dvId => ({ dataset_value_id: dvId })))
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        },
      })
    } else {
      // Quote all
      await history.execute({
        type: 'quote_create',
        description: `Quote ${valueIds.length} comments`,
        redo: async () => {
          await excerptsApi.bulkCreate(projectId, valueIds.map(dvId => ({ dataset_value_id: dvId })))
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        },
        undo: async () => {
          // Refetch to find new excerpt IDs
          const freshComments = queryClient.getQueryData<{ comments: typeof comments }>(['text-data', projectId])
          if (freshComments) {
            for (const dvId of valueIds) {
              const c = freshComments.comments?.find((cm) => cm.dataset_value_id === dvId)
              if (c?.excerpt_id) await excerptsApi.delete(projectId, c.excerpt_id)
            }
          }
          queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
          queryClient.invalidateQueries({ queryKey: ['excerpts-quoted', projectId] })
        },
      })
    }
    setAnnouncement(allQuoted ? 'Comments unquoted' : 'Comments quoted')
    setSavedIndicator(true)
    setTimeout(() => setSavedIndicator(false), 1500)
  }, [selectedValueIds, comments, projectId, history, queryClient])

  // ── Note deletion with undo ─────────────────────────────────────────

  const handleDeleteNote = useCallback(async (noteId: number, noteContent: string, datasetValueId: number) => {
    await history.execute({
      type: 'text_note_delete',
      description: 'Delete note',
      redo: async () => {
        await textCodingApi.deleteNote(projectId, noteId)
        queryClient.invalidateQueries({ queryKey: ['text-notes'] })
        queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
      },
      undo: async () => {
        await textCodingApi.createNote(projectId, {
          dataset_value_id: datasetValueId,
          content: noteContent,
        })
        queryClient.invalidateQueries({ queryKey: ['text-notes'] })
        queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
      },
    })
  }, [projectId, history, queryClient])

  // ── Jump to next uncoded ─────────────────────────────────────────────

  const handleJumpToNextUncoded = useCallback(() => {
    const searchPool = viewMode === 'by_text' ? filteredComments : comments
    const currentIdx = selectedValueIds.length > 0
      ? searchPool.findIndex(c => c.dataset_value_id === selectedValueIds[selectedValueIds.length - 1])
      : -1
    // Search forward, wrapping around
    for (let offset = 1; offset <= searchPool.length; offset++) {
      const idx = (currentIdx + offset) % searchPool.length
      if (searchPool[idx].applied_code_ids.length === 0) {
        setSelectedValueIds([searchPool[idx].dataset_value_id])
        setAnnouncement(`Jumped to uncoded comment ${idx + 1}`)
        return
      }
    }
    toast('All comments are coded')
  }, [viewMode, filteredComments, comments, selectedValueIds])

  // ── Keyboard shortcuts ────────────────────────────────────────────────

  // Chord state is owned by useCodeChordShortcuts (wired after the handlers below).
  const [savedIndicator, setSavedIndicator] = useState(false)

  // Floating dialog state
  const [createCodeDialog, setCreateCodeDialog] = useState<{ position: FloatingCoords; valueIds: number[] } | null>(null)
  const [createNoteDialog, setCreateNoteDialog] = useState<{ position: FloatingCoords; valueId: number } | null>(null)
  const [createNotePending, setCreateNotePending] = useState(false)

  // TextCodingView is the "misfit": it adopts only the chord + verbs layer of the shared
  // hook. ArrowUp/Down stay with ByTextTable; [ / ] cycling + analysis-tab suppression are
  // local concerns wired through extraKeys / the `enabled` flag (#388 P3.3).
  const { chordPrefix, pendingCategoryId } = useCodeChordShortcuts({
    enabled: activeTab === 'coding',
    codes,
    selectionCount: selectedValueIds.length,
    isEditing: false,
    arrowNavEnabled: false,
    onToggleCode: (code) => handleCodeToggle(code.id),
    onJumpUncoded: handleJumpToNextUncoded,
    onToggleQuote: handleBulkQuoteToggle,
    onCreateCode: () => {
      if (selectedValueIds.length === 0) return
      const coords = coordsFromElement(`text-${selectedValueIds[0]}`)
      setCreateCodeDialog({ position: coords, valueIds: [...selectedValueIds] })
    },
    onCreateNote: () => {
      if (selectedValueIds.length === 0) return
      const coords = coordsFromElement(`text-${selectedValueIds[0]}`)
      setCreateNoteDialog({ position: coords, valueId: selectedValueIds[0] })
    },
    onEditOrRename: () => {
      if (viewMode === 'by_text' && activeColumn) startEditingColumnName()
    },
    onArrowHorizontal: (dir) => {
      if (dir === 'right' && focusedPanel === 'main') { setFocusedPanel('codes'); return true }
      if (dir === 'left' && focusedPanel === 'codes') { setFocusedPanel('main'); return true }
      return false
    },
    extraKeys: {
      '[': () => {
        if (viewMode === 'by_text') { goToColumn(-1); return true }
        if (viewMode === 'by_record') { goToRecord(-1); return true }
        return false
      },
      ']': () => {
        if (viewMode === 'by_text') { goToColumn(1); return true }
        if (viewMode === 'by_record') { goToRecord(1); return true }
        return false
      },
    },
    onUndo: () => history.undo(),
    onRedo: () => history.redo(),
  })

  const pendingCategoryName =
    pendingCategoryId !== null ? codes.find(c => c.category_id === pendingCategoryId)?.category_name : null

  // ── Search debounce ──────────────────────────────────────────────────

  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setSearchText(value), 300)
  }, [])

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  // ── Randomize ─────────────────────────────────────────────────────────

  const handleRandomize = () => {
    if (randomSeed !== null) {
      setRandomSeed(null)
      setAnnouncement('Original order restored')
    } else {
      const seed = Math.floor(Math.random() * 99998) + 2  // Avoid 0 and 1 (degenerate sort)
      setRandomSeed(seed)
      setAnnouncement(`Randomized with seed ${seed}`)
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────

  const selectedComment = useMemo(() => {
    if (selectedValueIds.length !== 1) return null
    return comments.find(c => c.dataset_value_id === selectedValueIds[0]) ?? null
  }, [selectedValueIds, comments])

  const appliedCodeIds = useMemo(() => {
    if (selectedValueIds.length === 0) return []
    if (selectedValueIds.length === 1) {
      return selectedComment?.applied_code_ids ?? []
    }
    // Intersection of all selected
    const sets = selectedValueIds.map(dvId => {
      const c = comments.find(cm => cm.dataset_value_id === dvId)
      return new Set(c?.applied_code_ids ?? [])
    })
    if (sets.length === 0) return []
    const first = sets[0]
    return [...first].filter(id => sets.every(s => s.has(id)))
  }, [selectedValueIds, comments, selectedComment])

  // ── Progress display ──────────────────────────────────────────────────

  const overallComments = progressData?.overall_texts ?? { coded: 0, total: 0 }
  const overallRecords = progressData?.overall_records ?? { coded: 0, total: 0 }
  const commentPct = overallComments.total > 0 ? Math.round(overallComments.coded / overallComments.total * 100) : 0
  const recordPct = overallRecords.total > 0 ? Math.round(overallRecords.coded / overallRecords.total * 100) : 0

  // ── Render ────────────────────────────────────────────────────────────

  if (focalColumnIds.length === 0 && textColumns.length === 0) {
    return (
      <div className="h-full p-4">
        <div className="max-w-2xl mx-auto mt-8 text-center text-muted-foreground">
          <p>No text columns found in this project.</p>
          <p className="text-sm mt-2">Import a dataset with open-ended text columns to get started.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Screen reader announcements */}
      <div aria-live="polite" className="sr-only">{announcement}</div>

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface shrink-0">

        {/* ── Stable tab toggles (always at left edge) ── */}

        {/* Main tab toggle */}
        <div className="flex bg-mm-bg rounded p-0.5 shrink-0" role="tablist" aria-label="Main view">
          <button
            role="tab"
            id="cv-tab-coding"
            aria-controls="cv-panel-coding"
            aria-selected={activeTab === 'coding'}
            className={`px-3 py-1 text-xs rounded transition-colors ${activeTab === 'coding' ? 'bg-mm-surface shadow-xs font-medium' : 'text-muted-foreground'}`}
            onClick={() => { setActiveTab('coding'); setAnnouncement('Coding view active') }}
          >
            Coding
          </button>
          <button
            role="tab"
            id="cv-tab-analysis"
            aria-controls="cv-panel-analysis"
            aria-selected={activeTab === 'analysis'}
            className={`px-3 py-1 text-xs rounded transition-colors flex items-center gap-1 ${activeTab === 'analysis' ? 'bg-mm-surface shadow-xs font-medium' : 'text-muted-foreground'}`}
            onClick={() => { setActiveTab('analysis'); setAnnouncement('Cross-Analysis view active') }}
          >
            <BarChart3 className="w-3 h-3" />
            Cross-Analysis
          </button>
        </div>

        {/* View mode toggle (coding only) */}
        {activeTab === 'coding' && (
          <div className="flex bg-mm-bg rounded p-0.5 shrink-0" role="tablist" aria-label="View mode">
            <button
              role="tab"
              aria-selected={viewMode === 'by_text'}
              className={`px-3 py-1 text-xs rounded transition-colors ${viewMode === 'by_text' ? 'bg-mm-surface shadow-xs font-medium' : 'text-muted-foreground'}`}
              onClick={() => setViewMode('by_text')}
            >
              By Text
            </button>
            <button
              role="tab"
              aria-selected={viewMode === 'by_record'}
              className={`px-3 py-1 text-xs rounded transition-colors ${viewMode === 'by_record' ? 'bg-mm-surface shadow-xs font-medium' : 'text-muted-foreground'}`}
              onClick={() => {
                if (selectedValueIds.length > 0) {
                  const c = comments.find(cm => cm.dataset_value_id === selectedValueIds[0])
                  if (c) setSelectedRecordId(c.dataset_row_id)
                }
                setViewMode('by_record')
              }}
            >
              By Record
            </button>
          </div>
        )}

        {/* ── Separator between mode toggles and contextual controls ── */}
        <div className="w-px h-5 bg-mm-border-subtle mx-1 shrink-0" />

        {/* ── Variable navigation (changes per mode) ── */}

        {/* Column nav (By Text mode only) */}
        {activeColumn && viewMode === 'by_text' && activeTab === 'coding' && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToColumn(-1)}
              disabled={activeColumnIndex <= 0}
              aria-label="Previous column"
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>

            <Select
              value={String(activeColumnId)}
              onValueChange={v => { setActiveColumnId(Number(v)); setSelectedValueIds([]) }}
            >
              <SelectTrigger className="h-8 w-44 text-sm overflow-hidden" aria-label="Select text column to code">
                <span className="truncate block text-left">
                  {activeColumn?.column_name || activeColumn?.column_text || 'Select column'}
                </span>
              </SelectTrigger>
              <SelectContent>
                {focalColumnIds.map((colId, i) => {
                  const col = columnLookup.get(colId)
                  return (
                    <SelectItem key={colId} value={String(colId)}>
                      <span className="truncate block">{col?.column_name || col?.column_text || `Column ${i + 1}`}</span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToColumn(1)}
              disabled={activeColumnIndex >= focalColumnIds.length - 1}
              aria-label="Next column"
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>

            <span className="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
              {activeColumnIndex + 1} of {focalColumnIds.length}
            </span>
          </div>
        )}

        {/* Record nav (By Record mode only) */}
        {viewMode === 'by_record' && activeTab === 'coding' && records.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToRecord(-1)}
              disabled={currentRecordIndex <= 0}
              aria-label="Previous record"
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>

            <Select
              value={currentRecordId !== null ? String(currentRecordId) : undefined}
              onValueChange={v => { setSelectedRecordId(Number(v)); setSelectedValueIds([]) }}
            >
              <SelectTrigger className="h-8 w-48 text-sm overflow-hidden" aria-label="Select record">
                <span className="truncate block text-left">
                  {records[currentRecordIndex]?.row_identifier ||
                   records[currentRecordIndex]?.participant_name ||
                   `Record ${currentRecordIndex + 1}`}
                </span>
              </SelectTrigger>
              <SelectContent>
                {records.map((r, i) => (
                  <SelectItem key={r.dataset_row_id} value={String(r.dataset_row_id)}>
                    {r.row_identifier || r.participant_name || `Record ${i + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToRecord(1)}
              disabled={currentRecordIndex >= records.length - 1}
              aria-label="Next record"
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>

            <span className="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
              {currentRecordIndex + 1} of {records.length}
            </span>
          </div>
        )}

        {/* Inline column name editing (By Text mode) */}
        {activeColumn && viewMode === 'by_text' && activeTab === 'coding' && (
          isEditingColumnName ? (
            <Input
              ref={columnNameInputRef}
              value={columnNameDraft}
              onChange={e => setColumnNameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); saveColumnNameEdit() }
                if (e.key === 'Escape') { e.preventDefault(); setIsEditingColumnName(false) }
              }}
              onBlur={saveColumnNameEdit}
              className="h-7 text-sm font-medium max-w-[clamp(120px,40vw,600px)]"
              aria-label="Rename column"
              autoFocus
            />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={startEditingColumnName}
                  className="flex items-center gap-1.5 text-sm font-medium text-mm-text truncate max-w-[clamp(120px,40vw,600px)] group hover:text-mm-text-secondary transition-colors text-left"
                >
                  <span className="truncate">{activeColumn.column_name || activeColumn.column_text}</span>
                  <Pencil className="w-3 h-3 text-mm-text-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                <p>{activeColumn.column_name || activeColumn.column_text}</p>
                <p className="text-[10px] opacity-70 mt-0.5">Click to rename column</p>
              </TooltipContent>
            </Tooltip>
          )
        )}

        {/* Undo/Redo (coding only) */}
        {activeTab === 'coding' && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              disabled={!history.canUndo}
              onClick={() => history.undo()}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={!history.canRedo}
              onClick={() => history.redo()}
              title="Redo (Ctrl+Y)"
            >
              <Redo2 className="w-4 h-4" />
            </Button>
          </div>
        )}

        <div className="flex-1" />

        {savedIndicator && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="w-4 h-4" />
            Saved
          </span>
        )}

        {/* Progress gauges */}
        {progressData && (
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2" title={`${overallComments.coded} of ${overallComments.total} comments coded`}>
              <span className="text-muted-foreground">Comments:</span>
              <span className="font-medium">{overallComments.coded}/{overallComments.total}</span>
              <div className="w-16 h-1.5 bg-mm-border-subtle rounded-full overflow-hidden" role="progressbar" aria-valuenow={commentPct} aria-valuemin={0} aria-valuemax={100} aria-label={`Comments coded: ${commentPct}%`}>
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${commentPct}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2" title={`${overallRecords.coded} of ${overallRecords.total} records coded`}>
              <span className="text-muted-foreground">Records:</span>
              <span className="font-medium">{overallRecords.coded}/{overallRecords.total}</span>
              <div className="w-16 h-1.5 bg-mm-border-subtle rounded-full overflow-hidden" role="progressbar" aria-valuenow={recordPct} aria-valuemin={0} aria-valuemax={100} aria-label={`Records coded: ${recordPct}%`}>
                <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${recordPct}%` }} />
              </div>
            </div>
          </div>
        )}

        {/* Codebook */}
        <Button variant="ghost" size="icon" onClick={openCodebook} title="Codebook">
          <BookOpen className="w-4 h-4" />
        </Button>
      </div>

      {/* Toolbar — adapts to active tab */}
      {activeTab === 'coding' ? (
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface shrink-0 flex-wrap">
          <TextCodingColumnPicker
            columns={textColumns}
            selectedColumnIds={focalColumnIds}
            onSelectionChange={setFocalColumnIds}
            onSwitchToRecordView={() => setViewMode('by_record')}
          />

          {/* Context toggles (By Text only — By Record has built-in context sidebar) */}
          {viewMode === 'by_text' && (
            <>
              <div className="flex items-center gap-1 ml-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`text-xs gap-1 ${contextVisible.demographics ? 'bg-[hsl(var(--mm-ctx-demo))] text-[hsl(var(--mm-ctx-demo-text))]' : ''}`}
                  onClick={() => setContextVisible(p => ({ ...p, demographics: !p.demographics }))}
                  aria-pressed={contextVisible.demographics}
                >
                  {contextVisible.demographics ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  Demo
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`text-xs gap-1 ${contextVisible.otherComments ? 'bg-[hsl(var(--mm-ctx-comments))] text-[hsl(var(--mm-ctx-comments-text))]' : ''}`}
                  onClick={() => setContextVisible(p => ({ ...p, otherComments: !p.otherComments }))}
                  aria-pressed={contextVisible.otherComments}
                >
                  {contextVisible.otherComments ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  Comments
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`text-xs gap-1 ${contextVisible.nonComments ? 'bg-[hsl(var(--mm-ctx-responses))] text-[hsl(var(--mm-ctx-responses-text))]' : ''}`}
                  onClick={() => setContextVisible(p => ({ ...p, nonComments: !p.nonComments }))}
                  aria-pressed={contextVisible.nonComments}
                >
                  {contextVisible.nonComments ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  Responses
                </Button>
              </div>

              <div className="w-px h-5 bg-mm-border-subtle mx-1" />
            </>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={searchInput}
              onChange={e => handleSearchInput(e.target.value)}
              className="h-8 w-40 pl-8 text-sm border-orange-200 dark:border-orange-800 focus-visible:ring-orange-500"
              aria-label="Search comments"
            />
          </div>

          {/* Randomize */}
          <Button
            variant={randomSeed !== null ? 'secondary' : 'ghost'}
            size="sm"
            className="text-xs gap-1"
            onClick={handleRandomize}
          >
            <Shuffle className="w-3.5 h-3.5" />
            {randomSeed !== null ? `Seed ${randomSeed}` : 'Randomize'}
          </Button>

          {/* Hide empty */}
          <Button
            variant={hideEmpty ? 'secondary' : 'ghost'}
            size="sm"
            className="text-xs"
            onClick={() => setHideEmpty(!hideEmpty)}
          >
            {hideEmpty ? 'Hide empty' : 'Show all'}
          </Button>

          {/* Quoted only */}
          <Button
            variant={quotedOnly ? 'secondary' : 'ghost'}
            size="sm"
            className="text-xs gap-1"
            onClick={() => setQuotedOnly(!quotedOnly)}
            aria-label={quotedOnly ? 'Show all comments' : 'Show quoted only'}
            aria-pressed={quotedOnly}
          >
            <Quote className={`w-3.5 h-3.5 ${quotedOnly ? 'fill-amber-400 text-amber-400' : ''}`} />
          </Button>

          <div className="flex-1" />

          {/* Export */}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs gap-1"
            onClick={() => textCodingApi.exportCoded(projectId, {
              column_ids: columnIdsStr || undefined,
            })}
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface shrink-0">
          <TextCodingColumnPicker
            columns={textColumns}
            selectedColumnIds={focalColumnIds}
            onSelectionChange={setFocalColumnIds}
          />
          <span className="text-xs text-muted-foreground">
            {focalColumnIds.length} column{focalColumnIds.length !== 1 ? 's' : ''} selected
          </span>
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'analysis' ? (
          /* Cross-Analysis panel */
          <div className="flex-1 overflow-y-auto" role="tabpanel" id="cv-panel-analysis" aria-labelledby="cv-tab-analysis">
            {focalColumnIds.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Select one or more text columns to use cross-analysis.
              </div>
            ) : (
              <CrossAnalysisPanel
                projectId={projectId}
                focalColumnIds={focalColumnIds}
                textColumns={textColumns}
              />
            )}
          </div>
        ) : (
          <>
            {/* Content */}
            <div className="flex-1 overflow-hidden" role="tabpanel" id="cv-panel-coding" aria-labelledby="cv-tab-coding">
              {focalColumnIds.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  Select one or more text columns to begin coding.
                </div>
              ) : viewMode === 'by_text' ? (
                <div className="flex flex-col h-full">
                  <div className="flex-1 min-h-0">
                    <ByTextTable
                      comments={filteredComments}
                      loading={commentsLoading}
                      selectedValueIds={selectedValueIds}
                      onSelectionChange={setSelectedValueIds}
                      onQuoteToggle={handleQuoteToggle}
                      onContextCodeApply={(dvId, codeId) => {
                        setSelectedValueIds([dvId])
                        handleCodeToggle(codeId)
                      }}
                      onContextCreateCode={(coords) => {
                        setCreateCodeDialog({ position: coords, valueIds: [...selectedValueIds] })
                      }}
                      onContextCreateNote={(dvId, coords) => {
                        setCreateNoteDialog({ position: coords, valueId: dvId })
                      }}
                      contextVisible={contextVisible}
                      focalColumnIds={activeColumnId ? [activeColumnId] : focalColumnIds}
                      projectId={projectId}
                      codes={codes}
                      searchText={searchText}
                      onClearSearch={() => { setSearchInput(''); setSearchText('') }}
                    />
                  </div>
                </div>
              ) : (
                <ByRecordPanel
                  projectId={projectId}
                  comments={comments}
                  focalColumnIds={focalColumnIds}
                  selectedRecordId={selectedRecordId}
                  codes={codes}
                  selectedValueIds={selectedValueIds}
                  onSelectComment={(dvId) => setSelectedValueIds([dvId])}
                  onQuoteToggle={handleQuoteToggle}
                  onContextCodeApply={(dvId, codeId) => {
                    setSelectedValueIds([dvId])
                    handleCodeToggle(codeId)
                  }}
                  onContextCreateCode={(coords) => {
                    setCreateCodeDialog({ position: coords, valueIds: [...selectedValueIds] })
                  }}
                  onContextCreateNote={(dvId, coords) => {
                    setCreateNoteDialog({ position: coords, valueId: dvId })
                  }}
                />
              )}
            </div>

            {/* Right panels: CodePanel + NotesPanel + MemosPanel */}
            <div
              className="relative border-l bg-mm-surface flex flex-col shrink-0 overflow-hidden"
              style={{ width: rightPanelWidth }}
            >
              <ResizeHandle
                onResize={delta => setRightPanelWidth(w => Math.min(600, Math.max(200, w + delta)))}
                minWidth={200}
                maxWidth={600}
                currentWidth={rightPanelWidth}
              />
              <CollapsiblePanel
                title="Codes"
                isCollapsed={panelStates.codes.collapsed}
                onToggle={() => setPanelStates(p => ({ ...p, codes: { collapsed: !p.codes.collapsed } }))}
                headerExtra={
                  <button
                    onClick={(e) => { e.stopPropagation(); handleJumpToNextUncoded() }}
                    className="text-[10px] text-mm-text-muted hover:text-mm-text-secondary transition-colors"
                  >
                    Jump to uncoded ⏭
                  </button>
                }
                className={panelStates.codes.collapsed ? '' : 'flex-[2] min-h-0'}
              >
                <PageErrorBoundary>
                  <TextCodePanel
                    codes={codes}
                    categories={categories}
                    projectId={projectId}
                    appliedCodeIds={appliedCodeIds}
                    onToggleCode={handleCodeToggle}
                    onCreateCode={(name) => createCodeMutation.mutate(name)}
                    selectedCount={selectedValueIds.length}
                    isFocused={focusedPanel === 'codes'}
                    onFocusChange={(f) => f && setFocusedPanel('codes')}
                    chordNumberMap={chordNumberMap}
                  />
                </PageErrorBoundary>
              </CollapsiblePanel>
              <CollapsiblePanel
                title="Notes"
                isCollapsed={panelStates.notes.collapsed}
                onToggle={() => setPanelStates(p => ({ ...p, notes: { collapsed: !p.notes.collapsed } }))}
                className={panelStates.notes.collapsed ? '' : 'flex-1 min-h-0'}
              >
                <PageErrorBoundary>
                  <TextNotesPanel
                    projectId={projectId}
                    focalColumnIds={focalColumnIds}
                    selectedValueId={selectedValueIds.length === 1 ? selectedValueIds[0] : null}
                    onDeleteNote={handleDeleteNote}
                  />
                </PageErrorBoundary>
              </CollapsiblePanel>
              <CollapsiblePanel
                title="Memos"
                isCollapsed={panelStates.memos.collapsed}
                onToggle={() => setPanelStates(p => ({ ...p, memos: { collapsed: !p.memos.collapsed } }))}
                className={panelStates.memos.collapsed ? '' : 'flex-1 min-h-0'}
              >
                <PageErrorBoundary>
                  <MemoPanel
                    projectId={projectId}
                    entityType={null}
                    codes={codes}
                  />
                </PageErrorBoundary>
              </CollapsiblePanel>
            </div>
          </>
        )}
      </div>

      {/* Floating create code dialog */}
      {createCodeDialog && (
        <FloatingCreateCode
          position={createCodeDialog.position}
          projectId={projectId}
          categories={categories}
          onCreated={async (code) => {
            const valueIds = createCodeDialog.valueIds
            setCreateCodeDialog(null)

            if (valueIds.length === 0) return

            const invalidate = () => {
              queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
              queryClient.invalidateQueries({ queryKey: ['text-progress', projectId] })
              queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
            }

            // Apply the new code to all selected texts in one undo entry
            history.execute({
              type: 'text_code_apply',
              description: `Apply code "${code.name}" to ${valueIds.length} text(s)`,
              redo: async () => {
                if (valueIds.length === 1) {
                  await textCodingApi.applyCode(projectId, { dataset_value_id: valueIds[0], code_id: code.id })
                } else {
                  await textCodingApi.bulkCode(projectId, { dataset_value_ids: valueIds, code_id: code.id })
                }
                invalidate()
              },
              undo: async () => {
                if (valueIds.length === 1) {
                  await textCodingApi.removeCode(projectId, { dataset_value_id: valueIds[0], code_id: code.id })
                } else {
                  await textCodingApi.bulkRemoveCode(projectId, { dataset_value_ids: valueIds, code_id: code.id })
                }
                invalidate()
              },
            })
            toast.success(`Created "${code.name}" and applied to ${valueIds.length} comment${valueIds.length > 1 ? 's' : ''}`)
          }}
          onClose={() => setCreateCodeDialog(null)}
        />
      )}

      {/* Floating create note dialog */}
      {createNoteDialog && (
        <FloatingCreateNote
          position={createNoteDialog.position}
          isPending={createNotePending}
          onSubmit={async (content) => {
            setCreateNotePending(true)
            try {
              await textCodingApi.createNote(projectId, {
                dataset_value_id: createNoteDialog.valueId,
                content,
              })
              queryClient.invalidateQueries({ queryKey: ['text-notes'] })
              queryClient.invalidateQueries({ queryKey: ['text-data', projectId] })
              setCreateNoteDialog(null)
              setSelectedValueIds([createNoteDialog.valueId])
              setPanelStates(p => ({ ...p, notes: { collapsed: false } }))
              setFocusedPanel('notes')
            } finally {
              setCreateNotePending(false)
            }
          }}
          onClose={() => setCreateNoteDialog(null)}
        />
      )}

      {/* Chord indicator */}
      {chordPrefix !== null && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-mm-surface border border-mm-border-medium rounded-lg px-4 py-2 shadow-lg z-50">
          <span className="text-sm font-mono text-mm-text">{chordPrefix}.</span>
          <span className="text-sm text-mm-text-muted ml-1">{pendingCategoryName ? `${pendingCategoryName} — press 1-9` : 'press 1-9 for code'}</span>
        </div>
      )}

      {/* Status bar */}
      <div className="px-4 py-1.5 border-t bg-mm-surface text-xs text-muted-foreground flex items-center gap-4 shrink-0">
        <span>{activeTab === 'analysis' ? 'Cross-Analysis' : viewMode === 'by_text' ? 'By Text' : 'By Record'}</span>
        {activeTab === 'coding' && randomSeed !== null && <span>Randomized · seed {randomSeed}</span>}
        {activeTab === 'coding' && selectedValueIds.length > 0 && <span>{selectedValueIds.length} selected</span>}
        <div className="flex-1" />
        {activeTab === 'coding' && (
          <span className="opacity-60">0-9: code · s: quote · j: next uncoded · []: {viewMode === 'by_text' ? 'prev/next column' : 'prev/next record'} · Ctrl+Z/Y: undo/redo</span>
        )}
      </div>
    </div>
  )
}
