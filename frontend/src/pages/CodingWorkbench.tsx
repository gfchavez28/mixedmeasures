import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Eye, EyeOff, Pencil, Mic, Volume2, Trash2, RefreshCw, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext,
  DragOverlay,
  useSensors,
  useSensor,
  PointerSensor,
  pointerWithin,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  projectsApi,
  conversationsApi,
  segmentsApi,
  codesApi,
  categoriesApi,
  codingApi,
  notesApi,
  speakersApi,
  excerptsApi,
  type Segment,
  type Code,
  type Note,
  audioApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import SegmentProgressBar from '@/components/SegmentProgressBar'
import TranscriptPanel from '@/components/TranscriptPanel'
import { useSegmentSelection } from '@/hooks/useSegmentSelection'
import { useCodeChordShortcuts } from '@/hooks/useCodeChordShortcuts'
import CodePanel, { type CodePanelHandle } from '@/components/CodePanel'
import CollapsiblePanel from '@/components/CollapsiblePanel'
import ResizeHandle from '@/components/ResizeHandle'
import NotesPanel, { type NotesPanelHandle } from '@/components/NotesPanel'
import MemoPanel, { type MemoPanelHandle } from '@/components/MemoPanel'
import { useHistory } from '@/hooks/useHistory'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import FloatingCreateCode, { type FloatingCoords } from '@/components/FloatingCreateCode'
import FloatingCreateNote from '@/components/FloatingCreateNote'
import { coordsFromElement } from '@/lib/floating-utils'
import { getCodeColor } from '@/lib/utils'

type DragItemData =
  | { type: 'code'; code: Code; shortcutLabel: string }
  | { type: 'note'; note: Note }

const COLUMN_TOGGLE_COLORS = {
  timestamps: 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300',
  notes: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  codes: 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300',
} as const

export default function CodingWorkbench() {
  const { projectId, conversationId } = useParams<{ projectId: string; conversationId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { openCodebook, setBreadcrumbLabel } = useProjectLayout()
  const pid = parseInt(projectId || '0')
  const cid = parseInt(conversationId || '0')

  const [selectedSegments, setSelectedSegments] = useState<number[]>([])
  const [savedIndicator, setSavedIndicator] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const codePanelRef = useRef<CodePanelHandle>(null)
  const scrubberSlotRef = useRef<HTMLDivElement>(null)
  const playbackRef = useRef<{ togglePlayback: () => void } | null>(null)
  const audioFileInputRef = useRef<HTMLInputElement>(null)
  const [showRemoveAudioConfirm, setShowRemoveAudioConfirm] = useState(false)

  // Floating dialog state
  const [createCodeDialog, setCreateCodeDialog] = useState<{ position: FloatingCoords; segmentIds: number[] } | null>(null)
  const [createNoteDialog, setCreateNoteDialog] = useState<{ position: FloatingCoords; segmentId: number } | null>(null)
  const [createNotePending, setCreateNotePending] = useState(false)

  // Cleanup saved indicator timer on unmount
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  // Filter state (Item 14)
  const [speakerFilter, setSpeakerFilter] = useState<Set<string>>(new Set()) // empty = all speakers
  const [textFilter, setTextFilter] = useState('')
  const [quotedFilter, setQuotedFilter] = useState(false)

  // Transcript column visibility (persisted per project)
  const [columnVisibility, setColumnVisibility] = useState(() => {
    try {
      const stored = localStorage.getItem(`mm-transcript-columns-${pid}`)
      if (stored) return JSON.parse(stored) as { timestamps: boolean; notes: boolean; codes: boolean }
    } catch { /* ignore */ }
    return { timestamps: true, notes: true, codes: true }
  })
  useEffect(() => {
    localStorage.setItem(`mm-transcript-columns-${pid}`, JSON.stringify(columnVisibility))
  }, [columnVisibility, pid])
  const toggleColumn = useCallback((col: 'timestamps' | 'notes' | 'codes') => {
    setColumnVisibility(prev => ({ ...prev, [col]: !prev[col] }))
  }, [])

  // Panel state
  const [rightPanelWidth, setRightPanelWidth] = useState(320)
  const [panelStates, setPanelStates] = useState({
    codes: { collapsed: false },
    notes: { collapsed: true },
    memos: { collapsed: true },
  })

  // Keyboard navigation state
  const [focusedPanel, setFocusedPanel] = useState<'transcript' | 'codes' | 'notes' | 'memos'>('transcript')
  const notesPanelRef = useRef<NotesPanelHandle>(null)
  const memoPanelRef = useRef<MemoPanelHandle>(null)

  // Inline editing state (Issues 101 & 102)
  const [editingSegmentId, setEditingSegmentId] = useState<number | null>(null)
  const [editField, setEditField] = useState<'text' | 'speaker'>('text')

  // State for creating memo from code panel
  const [createMemoForCode, setCreateMemoForCode] = useState<{ id: number; name: string } | null>(null)

  // Shift/arrow selection is owned by useSegmentSelection (wired below).

  // Undo/Redo history (Item 28)
  const history = useHistory()

  // Fetch data
  const { data: project, isLoading: projectLoading, isError: projectError } = useQuery({
    queryKey: ['project', pid],
    queryFn: () => projectsApi.get(pid),
    enabled: !!pid,
  })

  const { data: conversation, isLoading: conversationLoading, isError: conversationError } = useQuery({
    queryKey: ['conversation', pid, cid],
    queryFn: () => conversationsApi.get(pid, cid),
    enabled: !!pid && !!cid,
  })

  const hasAudio = conversation?.has_audio === true

  // Audio upload mutation
  const uploadAudioMutation = useMutation({
    mutationFn: (file: File) => audioApi.upload(pid, cid, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', pid, cid] })
      queryClient.invalidateQueries({ queryKey: ['conversations', pid] })
      toast.success('Audio uploaded successfully')
    },
    onError: () => {
      toast.error('Failed to upload audio file')
    },
  })

  const deleteAudioMutation = useMutation({
    mutationFn: () => audioApi.remove(pid, cid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', pid, cid] })
      queryClient.invalidateQueries({ queryKey: ['conversations', pid] })
      toast.success('Audio removed')
    },
    onError: () => {
      toast.error('Failed to remove audio')
    },
  })

  const [offsetValue, setOffsetValue] = useState(0)
  useEffect(() => {
    setOffsetValue(conversation?.media_offset_seconds ?? 0)
  }, [conversation?.media_offset_seconds])

  const offsetMutation = useMutation({
    mutationFn: (val: number) => audioApi.updateOffset(pid, cid, val),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', pid, cid] })
    },
  })

  const adjustOffset = useCallback((delta: number) => {
    const newVal = Math.max(-300, Math.min(300, Math.round((offsetValue + delta) * 10) / 10))
    setOffsetValue(newVal)
    offsetMutation.mutate(newVal)
  }, [offsetValue, offsetMutation])

  const handleAudioFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Frontend size validation
    const MAX_SIZE = 500 * 1024 * 1024
    if (file.size > MAX_SIZE) {
      toast.error('Audio file exceeds 500MB limit')
      e.target.value = ''
      return
    }

    // Extension check (preliminary — backend validates by content)
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['mp3', 'm4a', 'wav'].includes(ext)) {
      toast.error('Accepted formats: MP3, M4A, WAV')
      e.target.value = ''
      return
    }

    uploadAudioMutation.mutate(file)
    e.target.value = '' // Reset for re-upload
  }, [uploadAudioMutation])

  // Set breadcrumb label to conversation name
  useEffect(() => {
    if (conversation?.name) setBreadcrumbLabel(conversation.name)
  }, [conversation?.name, setBreadcrumbLabel])

  const { data: segmentsData } = useQuery({
    queryKey: ['segments', cid],
    queryFn: () => segmentsApi.list(cid),
    enabled: !!cid,
  })

  const { data: codesData } = useQuery({
    queryKey: ['codes', pid],
    queryFn: () => codesApi.list(pid),
    enabled: !!pid,
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['categories', pid],
    queryFn: () => categoriesApi.list(pid),
    enabled: !!pid,
  })
  const categories = categoriesData?.categories || []

  const { data: progressData } = useQuery({
    queryKey: ['progress', cid],
    queryFn: () => codingApi.getProgress(cid),
    enabled: !!cid,
  })

  const { data: conversationsData } = useQuery({
    queryKey: ['conversations', pid],
    queryFn: () => conversationsApi.list(pid),
    enabled: !!pid,
  })

  // Warm the notes cache for NotesPanel (query key shared)
  useQuery({
    queryKey: ['notes', cid],
    queryFn: () => notesApi.listForConversation(cid),
    enabled: !!cid,
  })

  // Fetch speakers for inline editing (Issues 101 & 102)
  const { data: speakersData } = useQuery({
    queryKey: ['speakers', pid],
    queryFn: () => speakersApi.list(pid),
    enabled: !!pid,
  })

  const speakers = speakersData || []

  const allSegments = useMemo(() => segmentsData?.segments ?? [], [segmentsData?.segments])
  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const codeMap = useMemo(() => {
    const m = new Map<number, Code>()
    for (const c of codes) m.set(c.id, c)
    return m
  }, [codes])
  const handleInlineCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['segments', cid] })
    queryClient.invalidateQueries({ queryKey: ['progress', cid] })
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
  }, [queryClient, cid, pid])
  const progress = progressData?.progress_percent || 0
  const conversations = useMemo(() => conversationsData?.conversations ?? [], [conversationsData?.conversations])

  // Handle search navigation params: ?segment=ID&q=term (Issue 115)
  const searchNavApplied = useRef(false)
  useEffect(() => {
    if (searchNavApplied.current || allSegments.length === 0) return

    const targetSegmentId = searchParams.get('segment')
    const searchTerm = searchParams.get('q')

    if (targetSegmentId) {
      const segId = parseInt(targetSegmentId)
      // Verify segment exists in this conversation
      if (allSegments.some(s => s.id === segId)) {
        setSelectedSegments([segId])
        if (searchTerm) {
          setTextFilter(searchTerm)
        }
        searchNavApplied.current = true
        // Clear params from URL without re-render navigation
        setSearchParams({}, { replace: true })
      }
    }
  }, [allSegments, searchParams, setSearchParams])

  // Filter segments based on speaker filter and quoted filter (text search is now a popover overlay, not a filter)
  const segments = useMemo(() => {
    let result = allSegments
    if (speakerFilter.size > 0) {
      result = result.filter(s => speakerFilter.has(s.speaker_name || ''))
    }
    if (quotedFilter) {
      result = result.filter(s => s.excerpts.length > 0)
    }
    return result
  }, [allSegments, speakerFilter, quotedFilter])

  // Refs for always-fresh values in keyboard handler (Issue 123)
  // useEffect fires async after paint, so the handler closure can be stale
  // if the user presses a key between a click's state update and the effect re-registration.
  const selectedSegmentsRef = useRef(selectedSegments)
  selectedSegmentsRef.current = selectedSegments
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const allSegmentsRef = useRef(allSegments)
  allSegmentsRef.current = allSegments

  // (Stale shift-anchor defense now lives in useSegmentSelection's resolveAnchorIndex — #388 Q1.)

  // Create segment lookup map for O(1) access (performance optimization)
  const segmentMap = useMemo(() => {
    const map = new Map<number, Segment>()
    segments.forEach(seg => map.set(seg.id, seg))
    return map
  }, [segments])

  // All-segments map for group operations (unfiltered, Phase 8)
  const allSegmentsMap = useMemo(() => {
    const map = new Map<number, Segment>()
    allSegments.forEach(seg => map.set(seg.id, seg))
    return map
  }, [allSegments])

  // Get unique speakers from all segments (for filter UI)
  const uniqueSpeakers = useMemo(() => {
    const speakers = new Set<string>()
    allSegments.forEach(s => {
      if (s.speaker_name) speakers.add(s.speaker_name)
    })
    return Array.from(speakers).sort()
  }, [allSegments])

  // numeric_id + chord category maps now live inside useCodeChordShortcuts (derived from
  // `codes` via the shared buildShortcutCategories helper — #388 P2.4).

  // Drag-and-drop state (Issue 110)
  const [activeDragItem, setActiveDragItem] = useState<DragItemData | null>(null)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Chord state is owned by useCodeChordShortcuts (wired after the handlers below).

  // Find prev/next conversation (memoized)
  const { prevConversation, nextConversation, currentConvIndex } = useMemo(() => {
    const currentIndex = conversations.findIndex((c) => c.id === cid)
    return {
      prevConversation: currentIndex > 0 ? conversations[currentIndex - 1] : null,
      nextConversation: currentIndex < conversations.length - 1 ? conversations[currentIndex + 1] : null,
      currentConvIndex: currentIndex,
    }
  }, [conversations, cid])

  // Code mutations (apply/remove are handled via history.execute for undo support)
  const createCodeMutation = useMutation({
    mutationFn: (name: string) => codesApi.create(pid, { name }),
    onSuccess: async (newCode) => {
      await queryClient.invalidateQueries({ queryKey: ['codes', pid] })
      // If segments are selected, enter append workflow
      if (selectedSegments.length > 0) {
        expandPanelIfCollapsed('codes')
        setFocusedPanel('codes')
        codePanelRef.current?.focusCodeForApply(newCode.id)
      }
    },
  })

  const showSaved = useCallback(() => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSavedIndicator(true)
    savedTimerRef.current = setTimeout(() => {
      setSavedIndicator(false)
      savedTimerRef.current = null
    }, 2000)
  }, [])

  // ── Title editing ──

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const updateTitleMutation = useMutation({
    mutationFn: (name: string) => conversationsApi.update(pid, cid, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', pid, cid] })
      queryClient.invalidateQueries({ queryKey: ['conversations', pid] })
      setIsEditingTitle(false)
    },
    onError: () => toast.error('Failed to rename conversation'),
  })

  const startEditingTitle = useCallback(() => {
    if (!conversation) return
    setTitleDraft(conversation.name)
    setIsEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }, [conversation])

  const saveTitleEdit = useCallback(() => {
    const trimmed = titleDraft.trim()
    if (!trimmed || trimmed === conversation?.name) {
      setIsEditingTitle(false)
      return
    }
    updateTitleMutation.mutate(trimmed)
  }, [titleDraft, conversation?.name, updateTitleMutation])

  // Merge segments with undo support
  const handleMergeSegments = useCallback(
    (segmentIds: number[]) => {
      let mergedSegmentId: number | null = null
      history.execute({
        type: 'segment_merge',
        description: `Merge ${segmentIds.length} segments`,
        redo: async () => {
          const result = await segmentsApi.merge(cid, segmentIds)
          mergedSegmentId = result.merged_segment.id
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          queryClient.invalidateQueries({ queryKey: ['progress', cid] })
          setSelectedSegments([result.merged_segment.id])
        },
        undo: async () => {
          if (mergedSegmentId) {
            const result = await segmentsApi.unmerge(cid, mergedSegmentId)
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
            queryClient.invalidateQueries({ queryKey: ['progress', cid] })
            queryClient.invalidateQueries({ queryKey: ['codes', pid] })
            if (result.restored_segments.length > 0) {
              setSelectedSegments([result.restored_segments[0].id])
            }
          }
        },
      })
      showSaved()
    },
    [cid, pid, history, queryClient, showSaved]
  )

  // Unmerge segment with undo support
  const handleUnmergeSegment = useCallback(
    (segmentId: number) => {
      let restoredSegmentIds: number[] = []
      history.execute({
        type: 'segment_merge',
        description: 'Unmerge segment',
        redo: async () => {
          const result = await segmentsApi.unmerge(cid, segmentId)
          restoredSegmentIds = result.restored_segments.map(s => s.id)
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          queryClient.invalidateQueries({ queryKey: ['progress', cid] })
          queryClient.invalidateQueries({ queryKey: ['codes', pid] })
          if (result.restored_segments.length > 0) {
            setSelectedSegments([result.restored_segments[0].id])
          }
        },
        undo: async () => {
          if (restoredSegmentIds.length > 0) {
            const result = await segmentsApi.merge(cid, restoredSegmentIds)
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
            queryClient.invalidateQueries({ queryKey: ['progress', cid] })
            setSelectedSegments([result.merged_segment.id])
          }
        },
      })
      showSaved()
    },
    [cid, pid, history, queryClient, showSaved]
  )

  // Group segments with undo support (Phase 8)
  const handleGroupSegments = useCallback(
    (segmentIds: number[]) => {
      let createdGroupId: number | null = null
      history.execute({
        type: 'segment_group',
        description: `Group ${segmentIds.length} segments`,
        redo: async () => {
          const result = await segmentsApi.createGroup(cid, segmentIds)
          createdGroupId = result.id
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
        undo: async () => {
          if (createdGroupId) {
            await segmentsApi.deleteGroup(cid, createdGroupId)
          }
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
      })
      showSaved()
    },
    [cid, history, queryClient, showSaved]
  )

  // Ungroup segments with undo support (Phase 8)
  const handleUngroupSegments = useCallback(
    (groupId: number, memberSegmentIds: number[]) => {
      history.execute({
        type: 'segment_group',
        description: `Ungroup ${memberSegmentIds.length} segments`,
        redo: async () => {
          await segmentsApi.deleteGroup(cid, groupId)
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
        undo: async () => {
          await segmentsApi.createGroup(cid, memberSegmentIds)
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
      })
      showSaved()
    },
    [cid, history, queryClient, showSaved]
  )

  const invalidateAfterCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['segments', cid] })
    queryClient.invalidateQueries({ queryKey: ['progress', cid] })
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
  }, [queryClient, cid, pid])

  // #367: lightweight settle for the optimistic-code path — refresh the progress gauge
  // and code counts WITHOUT the expensive full-conversation segment refetch (that refetch
  // eager-loads speaker+applications+notes+excerpts per segment and was the ~1s badge lag).
  const settleAfterCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['progress', cid] })
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
  }, [queryClient, cid, pid])

  // Optimistically patch applied_codes on the cached segment list so the badge paints
  // immediately. Mirrors the backend exactly: single applyCode/removeCode fan out to all
  // visible segments sharing a group_id (coding.py:85,162); bulkCode touches only the
  // listed ids. `fanOutGroups` selects which behavior to replicate.
  const patchSegmentCodes = useCallback(
    (segmentIds: number[], codeId: number, action: 'apply' | 'remove', fanOutGroups: boolean) => {
      queryClient.setQueryData<{ segments: Segment[] } & Record<string, unknown>>(
        ['segments', cid],
        (old) => {
          if (!old?.segments) return old
          const targetIds = new Set(segmentIds)
          if (fanOutGroups) {
            const groupIds = new Set<number>()
            for (const s of old.segments) {
              if (s.group_id != null && targetIds.has(s.id)) groupIds.add(s.group_id)
            }
            if (groupIds.size) {
              for (const s of old.segments) {
                if (s.group_id != null && groupIds.has(s.group_id)) targetIds.add(s.id)
              }
            }
          }
          const segments = old.segments.map((s) => {
            if (!targetIds.has(s.id)) return s
            const has = s.applied_codes.includes(codeId)
            if (action === 'apply' && !has) return { ...s, applied_codes: [...s.applied_codes, codeId] }
            if (action === 'remove' && has) return { ...s, applied_codes: s.applied_codes.filter((c) => c !== codeId) }
            return s
          })
          return { ...old, segments }
        }
      )
    },
    [queryClient, cid]
  )

  // Run an atomic single-POST code change with an optimistic patch + snapshot rollback.
  // useHistory's execute() does NOT roll back on a thrown redo/undo — it only toasts and
  // skips the history entry — so we restore the snapshot here and re-throw to preserve both.
  const runOptimisticCode = useCallback(
    async (
      segmentIds: number[],
      codeId: number,
      action: 'apply' | 'remove',
      fanOutGroups: boolean,
      serverCall: () => Promise<unknown>,
    ) => {
      const snapshot = queryClient.getQueryData(['segments', cid])
      patchSegmentCodes(segmentIds, codeId, action, fanOutGroups)
      try {
        await serverCall()
        settleAfterCodeChange()
      } catch (e) {
        queryClient.setQueryData(['segments', cid], snapshot)
        throw e
      }
    },
    [queryClient, cid, patchSegmentCodes, settleAfterCodeChange]
  )

  // Toggle code on selected segments with history tracking
  const handleCodeToggle = useCallback(
    (code: Code) => {
      if (selectedSegments.length === 0) return

      // Check if all selected segments have this code (using segmentMap for O(1) lookup)
      const allHaveCode = selectedSegments.every((segId) => {
        const seg = segmentMap.get(segId)
        if (!seg) return false
        return seg.applied_codes?.includes(code.id) ?? false
      })

      const segmentIds = [...selectedSegments]
      const codeId = code.id
      const codeName = code.name

      if (selectedSegments.length === 1) {
        const segmentId = selectedSegments[0]
        if (allHaveCode) {
          // Execute with history tracking
          history.execute({
            type: 'code_remove',
            description: `Remove code "${codeName}"`,
            redo: () => runOptimisticCode([segmentId], codeId, 'remove', true, () => codingApi.removeCode(segmentId, codeId)),
            undo: () => runOptimisticCode([segmentId], codeId, 'apply', true, () => codingApi.applyCode(segmentId, codeId)),
          })
        } else {
          history.execute({
            type: 'code_apply',
            description: `Apply code "${codeName}"`,
            redo: () => runOptimisticCode([segmentId], codeId, 'apply', true, () => codingApi.applyCode(segmentId, codeId)),
            undo: () => runOptimisticCode([segmentId], codeId, 'remove', true, () => codingApi.removeCode(segmentId, codeId)),
          })
        }
      } else {
        const action = allHaveCode ? 'remove' : 'apply'
        const inverse = action === 'apply' ? 'remove' : 'apply'
        history.execute({
          type: allHaveCode ? 'code_remove' : 'code_apply',
          description: `${action === 'apply' ? 'Apply' : 'Remove'} code "${codeName}" from ${segmentIds.length} segments`,
          redo: () => runOptimisticCode(segmentIds, codeId, action, false, () => codingApi.bulkCode(segmentIds, codeId, action)),
          undo: () => runOptimisticCode(segmentIds, codeId, inverse, false, () => codingApi.bulkCode(segmentIds, codeId, inverse)),
        })
      }
      showSaved()
    },
    [selectedSegments, segmentMap, history, runOptimisticCode, showSaved]
  )

  // Handle toggling multiple codes at once (Item 47)
  const handleMultiCodeToggle = useCallback(
    (codesToToggle: Code[]) => {
      if (selectedSegments.length === 0 || codesToToggle.length === 0) return

      // Apply each code to each selected segment
      const segmentIds = [...selectedSegments]

      // Execute all code applications
      const codeNames = codesToToggle.map(c => c.name).join(', ')

      // Apply all codes in parallel (don't toggle). Multi-code = N independent POSTs, so a
      // partial failure can leave some codes applied server-side; snapshot rollback would wrongly
      // wipe them. On error we reconcile authoritatively via the full invalidation (incl. segments)
      // instead, accepting the one expensive refetch on the rare error path.
      const runMulti = async (action: 'apply' | 'remove') => {
        codesToToggle.forEach(code => patchSegmentCodes(segmentIds, code.id, action, false))
        try {
          await Promise.all(codesToToggle.map(code => codingApi.bulkCode(segmentIds, code.id, action)))
          settleAfterCodeChange()
        } catch (e) {
          invalidateAfterCodeChange()
          throw e
        }
      }
      history.execute({
        type: 'code_apply',
        description: `Apply codes "${codeNames}" to ${segmentIds.length} segment(s)`,
        redo: () => runMulti('apply'),
        undo: () => runMulti('remove'),
      })
      showSaved()
    },
    [selectedSegments, history, patchSegmentCodes, settleAfterCodeChange, invalidateAfterCodeChange, showSaved]
  )


  // Handle whole-segment excerpt toggle (quote icon click)
  const handleToggleQuote = useCallback(
    (segmentId: number) => {
      const segment = segmentMap.get(segmentId)
      if (!segment) return

      // Find whole-segment excerpt (offsets null)
      const wholeExcerpt = segment.excerpts.find(e => e.start_offset === null)

      if (wholeExcerpt) {
        // Delete whole-segment excerpt
        const excerptId = wholeExcerpt.id
        history.execute({
          type: 'quote_delete',
          description: 'Unquote segment',
          redo: async () => {
            await excerptsApi.delete(pid, excerptId)
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
          undo: async () => {
            await excerptsApi.create(pid, { segment_id: segmentId })
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
        })
      } else {
        // Create whole-segment excerpt
        history.execute({
          type: 'quote_create',
          description: 'Quote segment',
          redo: async () => {
            await excerptsApi.create(pid, { segment_id: segmentId })
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
          undo: async () => {
            // Find and delete the whole-segment excerpt we just created
            const freshSegments = queryClient.getQueryData<{ segments: Segment[] }>(['segments', cid])
            const freshSeg = freshSegments?.segments.find(s => s.id === segmentId)
            const freshExcerpt = freshSeg?.excerpts.find(e => e.start_offset === null)
            if (freshExcerpt) {
              await excerptsApi.delete(pid, freshExcerpt.id)
            }
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
        })
      }
      showSaved()
    },
    [pid, cid, segmentMap, history, queryClient, showSaved]
  )

  // Handle sub-segment excerpt creation
  const handleSaveExcerpt = useCallback(
    async (segmentId: number, startOffset: number, endOffset: number) => {
      let createdExcerptId: number | null = null
      await history.execute({
        type: 'quote_create',
        description: 'Save quote',
        redo: async () => {
          const response = await excerptsApi.create(pid, { segment_id: segmentId, start_offset: startOffset, end_offset: endOffset })
          createdExcerptId = response.id
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
        undo: async () => {
          const freshSegments = queryClient.getQueryData<{ segments: Segment[] }>(['segments', cid])
          const freshSeg = freshSegments?.segments.find(s => s.id === segmentId)
          const freshExcerpt = freshSeg?.excerpts.find(
            e => e.start_offset === startOffset && e.end_offset === endOffset
          )
          if (freshExcerpt) {
            await excerptsApi.delete(pid, freshExcerpt.id)
          }
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
      })
      showSaved()
      if (createdExcerptId !== null) {
        setPanelStates(prev => ({ ...prev, notes: { collapsed: false } }))
        notesPanelRef.current?.createForExcerpt(createdExcerptId, segmentId)
      }
    },
    [pid, cid, history, queryClient, showSaved]
  )

  // Handle excerpt deletion
  const handleDeleteExcerpt = useCallback(
    (excerptId: number) => {
      // Find which segment this excerpt belongs to for undo
      let excerptData: { segmentId: number; startOffset: number | null; endOffset: number | null } | null = null
      for (const seg of allSegments) {
        const exc = seg.excerpts.find(e => e.id === excerptId)
        if (exc) {
          excerptData = { segmentId: seg.id, startOffset: exc.start_offset, endOffset: exc.end_offset }
          break
        }
      }

      history.execute({
        type: 'quote_delete',
        description: 'Remove quote',
        redo: async () => {
          await excerptsApi.delete(pid, excerptId)
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
        undo: async () => {
          if (excerptData) {
            await excerptsApi.create(pid, {
              segment_id: excerptData.segmentId,
              start_offset: excerptData.startOffset ?? undefined,
              end_offset: excerptData.endOffset ?? undefined,
            })
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          }
        },
      })
      showSaved()
    },
    [pid, cid, allSegments, history, queryClient, showSaved]
  )

  // Handle adding a note to an existing excerpt (from context menu)
  const handleAddNoteToExcerpt = useCallback(
    (excerptId: number, segmentId: number) => {
      setPanelStates(prev => ({ ...prev, notes: { collapsed: false } }))
      notesPanelRef.current?.createForExcerpt(excerptId, segmentId)
    },
    []
  )

  // Handle bulk excerpt toggle for selected segments
  const handleBulkQuoteToggle = useCallback(
    () => {
      if (selectedSegments.length === 0) return

      // If all selected have whole-segment excerpts, unquote them; otherwise quote all
      const allExcerpted = selectedSegments.every(id => {
        const seg = segmentMap.get(id)
        return seg?.excerpts.some(e => e.start_offset === null) ?? false
      })
      const segmentIds = [...selectedSegments]

      if (allExcerpted) {
        // Collect excerpt IDs to delete
        const excerptIds: number[] = []
        for (const sid of segmentIds) {
          const seg = segmentMap.get(sid)
          const wholeExcerpt = seg?.excerpts.find(e => e.start_offset === null)
          if (wholeExcerpt) excerptIds.push(wholeExcerpt.id)
        }
        history.execute({
          type: 'quote_delete',
          description: `Unquote ${segmentIds.length} segments`,
          redo: async () => {
            for (const eid of excerptIds) {
              await excerptsApi.delete(pid, eid)
            }
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
          undo: async () => {
            await excerptsApi.bulkCreate(pid, segmentIds.map(sid => ({ segment_id: sid })))
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
        })
      } else {
        history.execute({
          type: 'quote_create',
          description: `Quote ${segmentIds.length} segments`,
          redo: async () => {
            await excerptsApi.bulkCreate(pid, segmentIds.map(sid => ({ segment_id: sid })))
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
          undo: async () => {
            // Fetch fresh state and delete the whole-segment excerpts
            const freshSegments = queryClient.getQueryData<{ segments: Segment[] }>(['segments', cid])
            if (freshSegments) {
              for (const sid of segmentIds) {
                const seg = freshSegments.segments.find(s => s.id === sid)
                const wholeExcerpt = seg?.excerpts.find(e => e.start_offset === null)
                if (wholeExcerpt) {
                  await excerptsApi.delete(pid, wholeExcerpt.id)
                }
              }
            }
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
          },
        })
      }
      showSaved()
    },
    [selectedSegments, segmentMap, history, queryClient, pid, cid, showSaved]
  )

  // Drag-and-drop handlers (Issue 110)
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as DragItemData | undefined
    if (data) setActiveDragItem(data)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    setActiveDragItem(null)

    if (!over) return

    const overId = String(over.id)
    const segmentIdMatch = overId.match(/^segment-(\d+)$/)
    if (!segmentIdMatch) return
    const targetSegmentId = parseInt(segmentIdMatch[1])

    const data = active.data.current as DragItemData | undefined
    if (!data) return

    if (data.type === 'code') {
      const code = data.code
      // Apply code to target segment (and all selected segments if multi-selected)
      const targetIds = selectedSegments.length > 1 && selectedSegments.includes(targetSegmentId)
        ? [...selectedSegments]
        : [targetSegmentId]

      // Check if already applied to all targets
      const allHaveCode = targetIds.every(id => {
        const seg = segmentMap.get(id)
        if (!seg) return false
        return seg.applied_codes?.includes(code.id) ?? false
      })
      if (allHaveCode) return

      const codeId = code.id
      const codeName = code.name

      if (targetIds.length === 1) {
        history.execute({
          type: 'code_apply',
          description: `Apply code "${codeName}" (drag)`,
          redo: () => runOptimisticCode([targetIds[0]], codeId, 'apply', true, () => codingApi.applyCode(targetIds[0], codeId)),
          undo: () => runOptimisticCode([targetIds[0]], codeId, 'remove', true, () => codingApi.removeCode(targetIds[0], codeId)),
        })
      } else {
        history.execute({
          type: 'code_apply',
          description: `Apply code "${codeName}" to ${targetIds.length} segments (drag)`,
          redo: () => runOptimisticCode(targetIds, codeId, 'apply', false, () => codingApi.bulkCode(targetIds, codeId, 'apply')),
          undo: () => runOptimisticCode(targetIds, codeId, 'remove', false, () => codingApi.bulkCode(targetIds, codeId, 'remove')),
        })
      }
      showSaved()
    } else if (data.type === 'note') {
      const note = data.note
      // Link note to segment
      notesApi.update(pid, note.id, { segment_id: targetSegmentId }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['notes', cid] })
        queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        showSaved()
      })
    }
  }, [selectedSegments, segmentMap, history, runOptimisticCode, showSaved, cid, queryClient, pid])

  const handleDragCancel = useCallback(() => {
    setActiveDragItem(null)
  }, [])

  // Handle inline segment editing with undo support (Issues 101 & 102)
  const handleSegmentEdit = useCallback(
    (segmentId: number, update: { text?: string; speaker_id?: number }) => {
      const segment = segmentMap.get(segmentId)
      if (!segment) return

      const oldText = segment.text
      const oldSpeakerId = segment.speaker_id

      const description = update.text !== undefined
        ? 'Edit segment text'
        : 'Change segment speaker'

      history.execute({
        type: 'segment_edit',
        description,
        redo: async () => {
          await segmentsApi.updateSegment(cid, segmentId, update)
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
        undo: async () => {
          const undoData: { text?: string; speaker_id?: number } = {}
          if (update.text !== undefined) undoData.text = oldText
          if (update.speaker_id !== undefined && oldSpeakerId !== null) undoData.speaker_id = oldSpeakerId
          await segmentsApi.updateSegment(cid, segmentId, undoData)
          queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        },
      })

      setEditingSegmentId(null)
      showSaved()
    },
    [cid, segmentMap, history, queryClient, showSaved]
  )

  const handleStartEdit = useCallback((segmentId: number, field: string) => {
    setEditingSegmentId(segmentId)
    setEditField(field as 'text' | 'speaker')
  }, [])

  const handleCancelEdit = useCallback(() => {
    setEditingSegmentId(null)
  }, [])

  const handleJumpToNextUncoded = useCallback(async () => {
    const result = await codingApi.getNextUncoded(
      cid,
      selectedSegmentsRef.current.length > 0 ? selectedSegmentsRef.current[0] : undefined
    )
    if (result.segment_id) {
      // Setting selection triggers auto-scroll in TranscriptPanel
      setSelectedSegments([result.segment_id])
    }
  }, [cid])

  // Get codes applied to selected segments (memoized for performance)
  const selectedCodesMap = useMemo(() => {
    const map = new Map<number, 'all' | 'some' | 'none'>()
    if (selectedSegments.length === 0) {
      codes.forEach((code) => map.set(code.id, 'none'))
      return map
    }

    // Get selected segments once
    const selectedSegs = selectedSegments.map(id => segmentMap.get(id)).filter(Boolean) as Segment[]

    codes.forEach((code) => {
      const appliedCount = selectedSegs.filter(seg => seg.applied_codes.includes(code.id)).length

      if (appliedCount === 0) {
        map.set(code.id, 'none')
      } else if (appliedCount === selectedSegments.length) {
        map.set(code.id, 'all')
      } else {
        map.set(code.id, 'some')
      }
    })
    return map
  }, [codes, selectedSegments, segmentMap])

  // Panel toggle helpers
  const togglePanel = useCallback((panel: keyof typeof panelStates) => {
    setPanelStates(prev => ({
      ...prev,
      [panel]: { collapsed: !prev[panel].collapsed }
    }))
  }, [])

  // Expand panel if collapsed
  const expandPanelIfCollapsed = useCallback((panel: keyof typeof panelStates) => {
    if (panelStates[panel].collapsed) {
      setPanelStates(prev => ({
        ...prev,
        [panel]: { collapsed: false }
      }))
    }
  }, [panelStates])

  // Navigate to next/prev panel in the right sidebar
  const navigateToNextPanel = useCallback((fromPanel: 'codes' | 'notes' | 'memos') => {
    if (fromPanel === 'codes') {
      expandPanelIfCollapsed('notes')
      setFocusedPanel('notes')
      requestAnimationFrame(() => notesPanelRef.current?.focus())
    } else if (fromPanel === 'notes') {
      expandPanelIfCollapsed('memos')
      setFocusedPanel('memos')
      requestAnimationFrame(() => memoPanelRef.current?.focus())
    }
    // memos is last, no next panel
  }, [expandPanelIfCollapsed])

  const navigateToPrevPanel = useCallback((fromPanel: 'codes' | 'notes' | 'memos') => {
    if (fromPanel === 'memos') {
      expandPanelIfCollapsed('notes')
      setFocusedPanel('notes')
      requestAnimationFrame(() => notesPanelRef.current?.focusLastItem())
    } else if (fromPanel === 'notes') {
      expandPanelIfCollapsed('codes')
      setFocusedPanel('codes')
      // Focus on last code when coming from Notes
      requestAnimationFrame(() => codePanelRef.current?.focusLastItem())
    }
    // codes is first in sidebar, left arrow goes to transcript
  }, [expandPanelIfCollapsed])

  // Split segments with undo support
  const handleSplitSegment = useCallback(
    (ranges: { segment_id: number; start_offset: number; end_offset: number }[]) => {
      let newSegmentIds: number[] = []
      const invalidateAfterSplitChange = () => {
        queryClient.invalidateQueries({ queryKey: ['segments', cid] })
        queryClient.invalidateQueries({ queryKey: ['progress', cid] })
        queryClient.invalidateQueries({ queryKey: ['codes', pid] })
        queryClient.invalidateQueries({ queryKey: ['notes', cid] })
      }
      history.execute({
        type: 'segment_split',
        description: 'Split segment',
        redo: async () => {
          const result = await segmentsApi.split(cid, ranges)
          newSegmentIds = result.new_segments.map(s => s.id)
          invalidateAfterSplitChange()
          const selectedSeg = result.new_segments[Math.floor(result.new_segments.length / 2)]
          if (selectedSeg) {
            setSelectedSegments([selectedSeg.id])
          }
        },
        undo: async () => {
          if (newSegmentIds.length > 0) {
            const result = await segmentsApi.unsplit(cid, newSegmentIds[0])
            invalidateAfterSplitChange()
            setSelectedSegments([result.restored_segment.id])
          }
        },
      })
      showSaved()
    },
    [cid, pid, history, queryClient, showSaved]
  )

  // Unsplit/rejoin — executed directly (not on undo stack).
  // Unsplit is conceptually the "undo" of a split; re-splitting would require
  // the original char offsets which aren't preserved after the backend deletes
  // the split-result segments.
  const handleUnsplitSegment = useCallback(
    async (segmentId: number) => {
      const result = await segmentsApi.unsplit(cid, segmentId)
      queryClient.invalidateQueries({ queryKey: ['segments', cid] })
      queryClient.invalidateQueries({ queryKey: ['progress', cid] })
      queryClient.invalidateQueries({ queryKey: ['codes', pid] })
      queryClient.invalidateQueries({ queryKey: ['notes', cid] })
      setSelectedSegments([result.restored_segment.id])
      showSaved()
    },
    [cid, pid, queryClient, showSaved]
  )

  // Handle clicking a note icon in the transcript (Item 66)
  const handleNoteClick = useCallback((noteId: number) => {
    expandPanelIfCollapsed('notes')
    setFocusedPanel('notes')
    requestAnimationFrame(() => notesPanelRef.current?.focusNote(noteId))
  }, [expandPanelIfCollapsed])

  // Context menu: apply/remove code on a specific segment
  const handleContextCodeApply = useCallback(
    (segmentId: number, codeId: number) => {
      const seg = segmentMap.get(segmentId) || allSegmentsMap.get(segmentId)
      if (!seg) return

      const hasCode = seg.applied_codes?.includes(codeId) ?? false
      const code = codes.find(c => c.id === codeId)
      const codeName = code?.name || 'code'

      if (hasCode) {
        history.execute({
          type: 'code_remove',
          description: `Remove code "${codeName}"`,
          redo: () => runOptimisticCode([segmentId], codeId, 'remove', true, () => codingApi.removeCode(segmentId, codeId)),
          undo: () => runOptimisticCode([segmentId], codeId, 'apply', true, () => codingApi.applyCode(segmentId, codeId)),
        })
      } else {
        history.execute({
          type: 'code_apply',
          description: `Apply code "${codeName}"`,
          redo: () => runOptimisticCode([segmentId], codeId, 'apply', true, () => codingApi.applyCode(segmentId, codeId)),
          undo: () => runOptimisticCode([segmentId], codeId, 'remove', true, () => codingApi.removeCode(segmentId, codeId)),
        })
      }
      showSaved()
    },
    [segmentMap, allSegmentsMap, codes, history, runOptimisticCode, showSaved]
  )

  // Context menu: open floating create code dialog
  const handleContextCreateCode = useCallback((coords: FloatingCoords) => {
    setCreateCodeDialog({ position: coords, segmentIds: [...selectedSegmentsRef.current] })
  }, [])

  // Context menu: open floating create note dialog
  const handleContextCreateNote = useCallback(
    (segmentId: number, coords: FloatingCoords) => {
      setCreateNoteDialog({ position: coords, segmentId })
    },
    []
  )

  // ── Keyboard shortcuts (selection + chord dispatch owned by shared hooks — #388 P2.4) ──

  const { handleArrowNav } = useSegmentSelection({
    items: segments,
    getId: (s) => s.id,
    selectedIds: selectedSegments,
    onSelectionChange: setSelectedSegments,
    enabled: editingSegmentId === null,
  })

  // 'g' — group adjacent (>=2) / ungroup (1); operates over unfiltered segments
  const handleGroupHotkey = useCallback(() => {
    const sel = selectedSegmentsRef.current
    if (sel.length >= 2) {
      const selectedSegs = allSegmentsRef.current
        .filter(s => sel.includes(s.id))
        .sort((a, b) => a.sequence_order - b.sequence_order)
      const allAdjacent = selectedSegs.every((s, i) =>
        i === 0 || s.sequence_order === selectedSegs[i - 1].sequence_order + 1
      )
      const noneGrouped = selectedSegs.every(s => s.group_id === null)
      const noneMerged = selectedSegs.every(s => !s.is_merged)
      if (allAdjacent && noneGrouped && noneMerged) {
        handleGroupSegments(selectedSegs.map(s => s.id))
      }
    } else if (sel.length === 1) {
      const seg = allSegmentsMap.get(sel[0])
      if (seg?.group_id) {
        const members = allSegmentsRef.current
          .filter(s => s.group_id === seg.group_id)
          .map(s => s.id)
        handleUngroupSegments(seg.group_id, members)
      }
    }
  }, [handleGroupSegments, handleUngroupSegments, allSegmentsMap])

  const { chordPrefix, pendingCategoryId } = useCodeChordShortcuts({
    codes,
    selectionCount: selectedSegments.length,
    isEditing: editingSegmentId !== null,
    arrowNavEnabled: focusedPanel === 'transcript',
    onToggleCode: handleCodeToggle,
    onJumpUncoded: handleJumpToNextUncoded,
    onToggleQuote: handleBulkQuoteToggle,
    onCreateCode: () => {
      const sel = selectedSegmentsRef.current
      if (sel.length === 0) return
      const coords = coordsFromElement(`segment-${sel[0]}`)
      setCreateCodeDialog({ position: coords, segmentIds: [...sel] })
    },
    onCreateNote: () => {
      const sel = selectedSegmentsRef.current
      if (sel.length === 0) return
      const coords = coordsFromElement(`segment-${sel[0]}`)
      setCreateNoteDialog({ position: coords, segmentId: sel[0] })
    },
    onEditOrRename: () => {
      const sel = selectedSegmentsRef.current
      if (focusedPanel === 'transcript' && sel.length === 1) {
        setEditingSegmentId(sel[0])
        setEditField('text')
      } else if (sel.length === 0) {
        startEditingTitle()
      }
    },
    onArrowNav: handleArrowNav,
    onArrowHorizontal: (dir) => {
      if (dir === 'right' && focusedPanel === 'transcript') {
        expandPanelIfCollapsed('codes')
        setFocusedPanel('codes')
        requestAnimationFrame(() => codePanelRef.current?.focus())
        return true
      }
      return false
    },
    extraKeys: {
      // Self-gate on transcript focus, return true to claim the key (#388 P3.1 boolean extraKeys).
      ' ': () => {
        if (focusedPanel !== 'transcript') return false
        playbackRef.current?.togglePlayback()
        return true
      },
      g: () => {
        if (focusedPanel !== 'transcript') return false
        handleGroupHotkey()
        return true
      },
    },
    clearSelection: () => setSelectedSegments([]),
    onEscapeFallback: () => {
      if (focusedPanel !== 'transcript') {
        const panelKey = focusedPanel as keyof typeof panelStates
        if (panelKey in panelStates) {
          togglePanel(panelKey)
          setFocusedPanel('transcript')
        }
      }
    },
    onUndo: () => { if (history.canUndo) history.undo() },
    onRedo: () => { if (history.canRedo) history.redo() },
  })

  const pendingCategoryName =
    pendingCategoryId !== null ? codes.find(c => c.category_id === pendingCategoryId)?.category_name : null

  if (projectLoading || conversationLoading) {
    return (
      <div className="flex items-center justify-center h-full text-mm-text-muted">
        Loading conversation…
      </div>
    )
  }

  if (projectError || conversationError) {
    return (
      <div className="p-8">
        <div role="alert" className="p-4 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded-lg text-sm text-center">
          Failed to load conversation. It may have been deleted, or there was a network error.
        </div>
      </div>
    )
  }

  if (!project || !conversation) {
    return null
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface flex-shrink-0">
        {/* Conversation Navigation */}
        {conversations.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              disabled={!prevConversation}
              onClick={() =>
                prevConversation && navigate(`/projects/${pid}/conversations/${prevConversation.id}`)
              }
              title={prevConversation ? `Previous: ${prevConversation.name}` : undefined}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>

            <Select
              value={String(cid)}
              onValueChange={v => navigate(`/projects/${pid}/conversations/${v}`)}
            >
              <SelectTrigger className="h-8 w-44 text-sm overflow-hidden" aria-label="Select conversation">
                <span className="truncate block text-left">{conversation?.name ?? 'Select'}</span>
              </SelectTrigger>
              <SelectContent>
                {conversations.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    <span className="truncate block">{c.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="icon"
              disabled={!nextConversation}
              onClick={() =>
                nextConversation && navigate(`/projects/${pid}/conversations/${nextConversation.id}`)
              }
              title={nextConversation ? `Next: ${nextConversation.name}` : undefined}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>

            <span className="text-xs text-muted-foreground font-mono tabular-nums">
              {currentConvIndex + 1} of {conversations.length}
            </span>
          </div>
        )}

        {/* Inline title editing */}
        {isEditingTitle ? (
          <Input
            ref={titleInputRef}
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); saveTitleEdit() }
              if (e.key === 'Escape') { e.preventDefault(); setIsEditingTitle(false) }
            }}
            onBlur={saveTitleEdit}
            className="h-7 text-sm font-medium max-w-[clamp(120px,40vw,600px)]"
            aria-label="Rename conversation"
            autoFocus
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={startEditingTitle}
                className="flex items-center gap-1.5 text-sm font-medium text-mm-text truncate max-w-[clamp(120px,40vw,600px)] group hover:text-mm-text-secondary transition-colors text-left"
              >
                <span className="truncate">{conversation?.name}</span>
                <Pencil className="w-3 h-3 text-mm-text-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <p>{conversation?.name}</p>
              <p className="text-[10px] opacity-70 mt-0.5">Click to rename</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Undo/Redo */}
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

        {/* Column visibility toggles */}
        <div className="flex items-center gap-1 border-l border-mm-border-subtle pl-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleColumn('timestamps')}
            aria-pressed={columnVisibility.timestamps}
            className={`text-xs gap-1 ${columnVisibility.timestamps ? COLUMN_TOGGLE_COLORS.timestamps : 'text-mm-text-faint'}`}
          >
            {columnVisibility.timestamps ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Time
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleColumn('notes')}
            aria-pressed={columnVisibility.notes}
            className={`text-xs gap-1 ${columnVisibility.notes ? COLUMN_TOGGLE_COLORS.notes : 'text-mm-text-faint'}`}
          >
            {columnVisibility.notes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Notes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleColumn('codes')}
            aria-pressed={columnVisibility.codes}
            className={`text-xs gap-1 ${columnVisibility.codes ? COLUMN_TOGGLE_COLORS.codes : 'text-mm-text-faint'}`}
          >
            {columnVisibility.codes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Codes
          </Button>
        </div>

        {/* Audio controls */}
        <div className="flex items-center gap-1 border-l border-mm-border-subtle pl-2">
          {/* Hidden file input for audio upload */}
          <input
            ref={audioFileInputRef}
            type="file"
            accept="audio/mpeg,audio/wav,audio/x-m4a,.mp3,.m4a,.wav"
            className="hidden"
            onChange={handleAudioFileSelect}
          />

          {hasAudio ? (
            <>
              <Popover>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-1 text-xs text-mm-text-secondary px-1 hover:text-mm-text cursor-pointer rounded transition-colors">
                    <Volume2 className="w-3.5 h-3.5 text-mm-green-text" />
                    {offsetValue !== 0 && (
                      <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                        {offsetValue > 0 ? '+' : ''}{offsetValue.toFixed(1)}s
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="start" className="w-64 p-3">
                  <div className="space-y-2">
                    <p className="text-xs font-medium">Audio Sync Offset</p>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => adjustOffset(-1)} aria-label="Decrease offset by 1 second">−1s</Button>
                      <Button variant="outline" size="sm" className="h-7 px-1.5 text-xs" onClick={() => adjustOffset(-0.1)} aria-label="Decrease offset by 0.1 seconds">−.1s</Button>
                      <Input
                        type="number"
                        step="0.1"
                        min="-300"
                        max="300"
                        value={offsetValue}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value)
                          if (!isNaN(val) && val >= -300 && val <= 300) {
                            setOffsetValue(val)
                            offsetMutation.mutate(val)
                          }
                        }}
                        className="h-7 w-20 text-center text-xs font-mono"
                      />
                      <Button variant="outline" size="sm" className="h-7 px-1.5 text-xs" onClick={() => adjustOffset(0.1)} aria-label="Increase offset by 0.1 seconds">+.1s</Button>
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => adjustOffset(1)} aria-label="Increase offset by 1 second">+1s</Button>
                    </div>
                    <p className="text-[11px] text-mm-text-muted">
                      If audio plays too early, decrease. If too late, increase.
                    </p>
                    {offsetValue !== 0 && (
                      <Button variant="ghost" size="sm" className="h-6 text-xs w-full" onClick={() => { setOffsetValue(0); offsetMutation.mutate(0) }}>
                        Reset to 0
                      </Button>
                    )}
                    <p className="text-[10px] text-mm-text-faint truncate">{conversation?.media_filename}</p>
                  </div>
                </PopoverContent>
              </Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => audioFileInputRef.current?.click()}
                    disabled={uploadAudioMutation.isPending}
                  >
                    <RefreshCw className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Replace audio</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-red-500 hover:text-red-600"
                    onClick={() => setShowRemoveAudioConfirm(true)}
                    disabled={deleteAudioMutation.isPending}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Remove audio</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => audioFileInputRef.current?.click()}
                  disabled={uploadAudioMutation.isPending}
                >
                  {uploadAudioMutation.isPending ? (
                    <><Mic className="w-3.5 h-3.5 animate-pulse" /> Uploading...</>
                  ) : (
                    <><Mic className="w-3.5 h-3.5" /> Attach Audio</>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Upload MP3, M4A, or WAV</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Scrubber slot — populated via portal from TranscriptPanel */}
        <div ref={scrubberSlotRef} className="flex items-center gap-2 border-l border-mm-border-subtle pl-3 min-w-56 overflow-visible [&:empty]:hidden" />

        <div className="flex-1" />

        {savedIndicator && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="w-4 h-4" />
            Saved
          </span>
        )}

        {/* Progress (#351: explicit "participant" qualifier so facilitator
          * segments not counting is no surprise to the analyst) */}
        <div
          className="flex items-center gap-2"
          role="progressbar"
          aria-label="Coding progress"
          aria-valuenow={progressData?.participant_coded ?? 0}
          aria-valuemin={0}
          aria-valuemax={progressData?.participant_segments ?? 0}
          aria-valuetext={
            `${progressData?.participant_coded ?? 0} of ${progressData?.participant_segments ?? 0} participant segments coded`
          }
        >
          <span
            className="text-sm text-mm-text-secondary font-mono tabular-nums"
            title="Facilitator segments are excluded from coding progress."
          >
            {progressData?.participant_coded || 0}/{progressData?.participant_segments || 0} participant segments coded
          </span>
          <SegmentProgressBar segments={allSegments} className="w-32" />
          <span className="text-sm font-medium font-mono tabular-nums">{progress}%</span>
        </div>

        {/* Codebook */}
        <Button variant="ghost" size="icon" onClick={openCodebook} title="Codebook">
          <BookOpen className="w-4 h-4" />
        </Button>
      </div>

      {/* Remove audio confirmation */}
      <ConfirmDialog
        open={showRemoveAudioConfirm}
        onOpenChange={setShowRemoveAudioConfirm}
        title="Remove Audio"
        description="Remove the audio file from this conversation? The transcript and coding are not affected."
        confirmLabel="Remove Audio"
        loading={deleteAudioMutation.isPending}
        loadingLabel="Removing..."
        onConfirm={() => {
          deleteAudioMutation.mutate(undefined, {
            onSuccess: () => setShowRemoveAudioConfirm(false),
          })
        }}
        destructive
      />

      {/* VBR audio notice */}
      {conversation?.media_is_vbr === true && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 dark:bg-amber-950/30 border-b text-xs text-amber-700 dark:text-amber-300">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          This audio file uses variable bitrate encoding. Playback seeking may be slightly imprecise.
        </div>
      )}

      {/* Main Content */}
      <DndContext
        sensors={dndSensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Transcript */}
        <div className="flex-1 flex flex-col border-r bg-mm-surface">
          <TranscriptPanel
            segments={segments}
            allSegments={allSegments}
            selectedSegments={selectedSegments}
            onSelectionChange={setSelectedSegments}
            conversationId={cid}
            codes={codes}
            uniqueSpeakers={uniqueSpeakers}
            speakerFilter={speakerFilter}
            onSpeakerFilterChange={setSpeakerFilter}
            textFilter={textFilter}
            onTextFilterChange={setTextFilter}
            onMergeSegments={handleMergeSegments}
            onUnmergeSegment={handleUnmergeSegment}
            onNoteClick={handleNoteClick}

            editingSegmentId={editingSegmentId}
            editField={editField}
            onStartEdit={handleStartEdit}
            onCancelEdit={handleCancelEdit}
            onSaveEdit={handleSegmentEdit}
            speakers={speakers}
            quotedFilter={quotedFilter}
            onQuotedFilterChange={setQuotedFilter}
            onToggleQuote={handleToggleQuote}
            onSaveExcerpt={handleSaveExcerpt}
            onDeleteExcerpt={handleDeleteExcerpt}
            onAddNoteToExcerpt={handleAddNoteToExcerpt}
            isDragActive={!!activeDragItem}
            onGroupSegments={handleGroupSegments}
            onUngroupSegments={handleUngroupSegments}
            onContextCodeApply={handleContextCodeApply}
            onContextCreateCode={handleContextCreateCode}
            onContextCreateNote={handleContextCreateNote}
            onSplitSegment={handleSplitSegment}
            onUnsplitSegment={handleUnsplitSegment}
            showTimestamps={columnVisibility.timestamps}
            showNotes={columnVisibility.notes}
            showCodes={columnVisibility.codes}
            projectId={pid}
            allCodes={codes}
            codeMap={codeMap}
            onCodeChange={handleInlineCodeChange}
            scrubberPortalRef={scrubberSlotRef}
            conversation={conversation}
            playbackRef={playbackRef}
          />
        </div>

        {/* Right Panel - Collapsible Sections with Resize Handle */}
        <div
          className="relative flex flex-col bg-mm-surface overflow-hidden"
          style={{ width: rightPanelWidth }}
        >
          <ResizeHandle
            onResize={(delta) => setRightPanelWidth(w => w + delta)}
            currentWidth={rightPanelWidth}
            minWidth={200}
            maxWidth={600}
          />

          {/* Codes Panel */}
          <CollapsiblePanel
            title="Codes"
            isCollapsed={panelStates.codes.collapsed}
            onToggle={() => togglePanel('codes')}
            className={panelStates.codes.collapsed ? '' : 'flex-[2] min-h-0'}
            headerExtra={
              <button
                onClick={(e) => { e.stopPropagation(); handleJumpToNextUncoded() }}
                className="text-[10px] text-mm-text-muted hover:text-mm-text-secondary transition-colors"
              >
                Jump to uncoded ⏭
              </button>
            }
          >
            <PageErrorBoundary>
              <CodePanel
                ref={codePanelRef}
                codes={codes}
                projectId={pid}
                selectedCodesMap={selectedCodesMap}
                onCodeToggle={handleCodeToggle}
                onMultiCodeToggle={handleMultiCodeToggle}
                onCreateCode={(name) => createCodeMutation.mutate(name)}
                onAddCodeMemo={(codeId, codeName) => {
                  // Expand memos panel and set up creation for this code
                  setPanelStates(prev => ({ ...prev, memos: { collapsed: false } }))
                  setFocusedPanel('memos')
                  setCreateMemoForCode({ id: codeId, name: codeName })
                }}
                disabled={selectedSegments.length === 0}
                isFocused={focusedPanel === 'codes'}
                onFocusChange={(focused) => setFocusedPanel(focused ? 'codes' : 'transcript')}
                onNavigateToTranscript={() => setFocusedPanel('transcript')}
                onNavigateToPrevPanel={() => {
                  // codes is first panel, go to transcript
                  setFocusedPanel('transcript')
                }}
                onNavigateToNextPanel={() => navigateToNextPanel('codes')}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

          {/* Notes Panel */}
          <CollapsiblePanel
            title="Notes"
            isCollapsed={panelStates.notes.collapsed}
            onToggle={() => togglePanel('notes')}
            className={panelStates.notes.collapsed ? '' : 'flex-1 min-h-0'}
          >
            <PageErrorBoundary>
              <NotesPanel
                ref={notesPanelRef}
                projectId={pid}
                conversationId={cid}
                selectedSegmentId={selectedSegments.length > 0 ? selectedSegments[0] : null}
                onJumpToSegment={(segmentId) => {
                  // Setting selection triggers auto-scroll in TranscriptPanel
                  setSelectedSegments([segmentId])
                }}
                isFocused={focusedPanel === 'notes'}
                onFocusChange={(focused) => setFocusedPanel(focused ? 'notes' : 'transcript')}
                onNavigateToTranscript={() => setFocusedPanel('transcript')}
                onNavigateToPrevPanel={() => navigateToPrevPanel('notes')}
                onNavigateToNextPanel={() => navigateToNextPanel('notes')}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

          {/* Memos Panel */}
          <CollapsiblePanel
            title="Memos"
            isCollapsed={panelStates.memos.collapsed}
            onToggle={() => togglePanel('memos')}
            className={panelStates.memos.collapsed ? '' : 'flex-1 min-h-0'}
          >
            <PageErrorBoundary>
              <MemoPanel
                ref={memoPanelRef}
                projectId={pid}
                conversationId={cid}
                codes={codes}
                conversations={conversations}
                createForCode={createMemoForCode}
                onCreateForCodeHandled={() => setCreateMemoForCode(null)}
                isFocused={focusedPanel === 'memos'}
                onFocusChange={(focused) => setFocusedPanel(focused ? 'memos' : 'transcript')}
                onNavigateToTranscript={() => setFocusedPanel('transcript')}
                onNavigateToPrevPanel={() => navigateToPrevPanel('memos')}
                onNavigateToNextPanel={() => navigateToNextPanel('memos')}
              />
            </PageErrorBoundary>
          </CollapsiblePanel>

        </div>
      </div>

      {/* Drag overlay ghost (Issue 110) */}
      <DragOverlay dropAnimation={null}>
        {activeDragItem?.type === 'code' && (
          <div
            className="h-6 px-2.5 rounded-full text-[11px] font-medium flex items-center justify-center shadow-lg max-w-[100px] truncate"
            style={{
              backgroundColor: getCodeColor(activeDragItem.code),
              color: '#ffffff',
            }}
          >
            {activeDragItem.code.name}
          </div>
        )}
        {activeDragItem?.type === 'note' && (
          <div className="relative w-7 h-7 bg-orange-200 rounded-sm flex items-center justify-center shadow-lg">
            <div className="absolute top-0 right-0 w-2 h-2 bg-orange-300 rounded-bl-sm" />
            <span className="text-xs font-medium text-orange-800">{activeDragItem.note.sequence_number}</span>
          </div>
        )}
      </DragOverlay>
      </DndContext>

      {/* Status bar */}
      <div className="px-4 py-1.5 border-t bg-mm-surface text-xs text-muted-foreground flex items-center gap-4 shrink-0">
        <span>Conversation</span>
        {selectedSegments.length > 0 && <span>{selectedSegments.length} selected</span>}
        <div className="flex-1" />
        <span className="opacity-60">0-9: code · s: quote · c: create code · n: note · j: next uncoded · g: group · Ctrl+Z/Y: undo/redo</span>
      </div>

      {/* Floating create code dialog */}
      {createCodeDialog && (
        <FloatingCreateCode
          position={createCodeDialog.position}
          projectId={pid}
          categories={categories}
          onCreated={async (code) => {
            const segmentIds = createCodeDialog.segmentIds
            setCreateCodeDialog(null)

            if (segmentIds.length === 0) return

            // Apply the new code to all selected segments in one undo entry
            history.execute({
              type: 'code_apply',
              description: `Apply code "${code.name}" to ${segmentIds.length} segment(s)`,
              redo: async () => {
                if (segmentIds.length === 1) {
                  await codingApi.applyCode(segmentIds[0], code.id)
                } else {
                  await codingApi.bulkCode(segmentIds, code.id, 'apply')
                }
                invalidateAfterCodeChange()
              },
              undo: async () => {
                if (segmentIds.length === 1) {
                  await codingApi.removeCode(segmentIds[0], code.id)
                } else {
                  await codingApi.bulkCode(segmentIds, code.id, 'remove')
                }
                invalidateAfterCodeChange()
              },
            })
            showSaved()
            toast.success(`Created "${code.name}" and applied to ${segmentIds.length} segment${segmentIds.length > 1 ? 's' : ''}`)
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
              const newNote = await notesApi.create(cid, { content, segment_id: createNoteDialog.segmentId })
              queryClient.invalidateQueries({ queryKey: ['notes', cid] })
              queryClient.invalidateQueries({ queryKey: ['segments', cid] })
              setCreateNoteDialog(null)
              expandPanelIfCollapsed('notes')
              setFocusedPanel('notes')
              requestAnimationFrame(() => notesPanelRef.current?.focusNote(newNote.id))
            } finally {
              setCreateNotePending(false)
            }
          }}
          onClose={() => setCreateNoteDialog(null)}
        />
      )}

      {/* Chord shortcut indicator */}
      {chordPrefix !== null && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-mm-surface border border-mm-border-medium rounded-lg px-4 py-2 shadow-lg z-50">
          <span className="text-sm font-mono text-mm-text">{chordPrefix}.</span>
          <span className="text-sm text-mm-text-muted ml-1">{pendingCategoryName || 'Category'} — press 1-9</span>
        </div>
      )}
    </div>
  )
}

