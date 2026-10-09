import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, ChevronLeft, ChevronRight, Check, Undo2, Redo2, Eye, EyeOff, Pencil, Mic, Volume2, Trash2, RefreshCw, AlertCircle, Video, Tags, StickyNote, NotebookPen, PanelRightClose, PanelRightOpen, SkipForward } from 'lucide-react'
import { toast } from 'sonner'
import { validateMediaFile, MEDIA_ACCEPT, describeMediaUploadError } from '@/lib/media-constants'
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
  mediaApi,
  retryUnanswered,
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
import BlindModeToggle from '@/components/BlindModeToggle'
import CoderCountBadge from '@/components/CoderCountBadge'
import { useBlindMode } from '@/hooks/useBlindMode'
import TranscriptPanel, { type PlaybackHandle } from '@/components/TranscriptPanel'
import MagnitudeStrip from '@/components/MagnitudeStrip'
import { CodeSetStrip } from '@/components/CodeSetStrip'
import { liveRatingCode, ratableCodes } from '@/lib/rating-targets'
import { scaleSignature } from '@/lib/magnitude'
import { useCollapsibleColumn } from '@/hooks/useCollapsibleColumn'
import { useSegmentSelection } from '@/hooks/useSegmentSelection'
import { useCodeChordShortcuts } from '@/hooks/useCodeChordShortcuts'
import { codeKeyHint } from '@/lib/codeShortcuts'
import { useCoders, useMachineCoderIds } from '@/hooks/useCoders'
import { useCoderCoverage } from '@/hooks/useCoderCoverage'
import { isSegmentCodedVisible, computeCoverage, isCodeAppliedByActiveCoder } from '@/lib/coding-progress'
import { lensHidesAnyCoder } from '@/lib/coder-color'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
import { describeQuoteNotesStayed } from '@/lib/split-disclosure'
import { collectBulkOutcome, describeBulkFailure } from '@/lib/bulk-code-result'
import {
  captureApply, captureRemove, mergeReplaced, planApplyUndo, replacedFromBulk, replacedFromSingle,
  runApplyUndo, runRemoveUndo, segmentUndoApi, type ApplyCapture, type ApplyUndoPlan, type Replaced,
} from '@/lib/apply-undo'
import { useAuth } from '@/lib/auth-context'
import CodePanel, { type CodePanelHandle } from '@/components/CodePanel'
import { useListLoad } from '@/hooks/useListLoad'
import CollapsiblePanel, { PANEL_EXPANDED, PANEL_RAIL_SCROLL } from '@/components/CollapsiblePanel'
import NotesPanel, { type NotesPanelHandle } from '@/components/NotesPanel'
import MemoPanel, { type MemoPanelHandle } from '@/components/MemoPanel'
import { useHistory } from '@/hooks/useHistory'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import FloatingCreateCode, { type FloatingCoords } from '@/components/FloatingCreateCode'
import FloatingCreateNote from '@/components/FloatingCreateNote'
import { coordsFromElement, selectionPrefill } from '@/lib/floating-utils'

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

  // Coder roster lens (Track J · J1) — attribution badges + visibility filter only in multi-coder mode.
  const { coders, coderMap, multiCoder, multiHumanCoder } = useCoders()
  const { user } = useAuth()
  const [hiddenCoders, setHiddenCoders] = useState<Set<number>>(new Set())
  // #451: archived coders' chips are hidden by default; "view all coders" reveals them.
  const [showArchivedCoders, setShowArchivedCoders] = useState(false)
  // Blind mode (Track J · J2-5, DEC-G): while blind, force the per-coder lens to
  // all-but-self so colleagues' codes/coverage are hidden. effectiveHidden feeds
  // every consumer; the manual filter (hiddenCoders) is suppressed while blind.
  // #964: the lens keys on `withholding` (fail-closed while the roster is
  // unanswered); the wording below keys on `blind` (only once it is known).
  const { blind, withholding, blindLens, toggleReveal } = useBlindMode(pid)
  const effectiveHidden = withholding ? blindLens : hiddenCoders
  // #1029 — a model's labels never count toward the gauge, the progress bar or `j`.
  const machineCoderIds = useMachineCoderIds()
  // Group A (#457): who coded THIS conversation — drives the picklist "active here" markers.
  const coderCoverage = useCoderCoverage(
    pid, { conversationId: cid }, { enabled: multiCoder, rosterCoderIds: coders.map(c => c.id) },
  )

  const [selectedSegments, setSelectedSegments] = useState<number[]>([])
  const [savedIndicator, setSavedIndicator] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const codePanelRef = useRef<CodePanelHandle>(null)
  const scrubberSlotRef = useRef<HTMLDivElement>(null)
  const playbackRef = useRef<PlaybackHandle | null>(null)
  const audioFileInputRef = useRef<HTMLInputElement>(null)
  const [showRemoveAudioConfirm, setShowRemoveAudioConfirm] = useState(false)

  // Floating dialog state
  const [createCodeDialog, setCreateCodeDialog] = useState<{ position: FloatingCoords; segmentIds: number[]; initialName?: string } | null>(null)
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
  const [panelStates, setPanelStates] = useState({
    codes: { collapsed: false },
    notes: { collapsed: true },
    memos: { collapsed: true },
  })
  // #39: the whole Codes/Notes/Memos COLUMN folds to a slim icon rail,
  // returning its width to transcript/video. Distinct from per-panel collapse.
  const rightColumn = useCollapsibleColumn('conversation')

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
  // #1042: the stack is this coder's — a coder switch clears it.
  const history = useHistory(user?.id ?? null)

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

  // Any media file attached (audio or video) — gates the management toolbar
  // (offset popover, attach/remove). The player itself gates on media_type
  // inside TranscriptPanel/usePlayback.
  const hasMedia = conversation?.has_media === true

  // Audio upload mutation
  const uploadAudioMutation = useMutation({
    mutationFn: (file: File) => mediaApi.upload(pid, 'conversation', cid, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', pid, cid] })
      queryClient.invalidateQueries({ queryKey: ['conversations', pid] })
      toast.success('Recording uploaded')
    },
    onError: (err) => {
      toast.error(describeMediaUploadError(err))
    },
  })

  const deleteAudioMutation = useMutation({
    mutationFn: () => mediaApi.remove(pid, 'conversation', cid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', pid, cid] })
      queryClient.invalidateQueries({ queryKey: ['conversations', pid] })
      toast.success('Recording removed')
    },
    onError: () => {
      toast.error('Failed to remove recording')
    },
  })

  const [offsetValue, setOffsetValue] = useState(0)
  useEffect(() => {
    setOffsetValue(conversation?.media_offset_seconds ?? 0)
  }, [conversation?.media_offset_seconds])

  const offsetMutation = useMutation({
    mutationFn: (val: number) => mediaApi.updateOffset(pid, cid, val),
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

    const validation = validateMediaFile(file)
    if (!validation.ok) {
      toast.error(validation.error)
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

  const segmentsQuery = useQuery({
    queryKey: ['segments', cid],
    queryFn: () => segmentsApi.list(cid),
    enabled: !!cid,
    // #961's rule for a list that feeds a load state: a second silent ask only
    // doubles the wait before the failure notice, when the server already
    // answered. Measured: the client-wide `retry: 1` made this two requests.
    retry: retryUnanswered,
  })
  const segmentsData = segmentsQuery.data
  /**
   * #963 Tier 2 — whether the transcript is an ANSWER.
   *
   * The page gate above covers the project and the conversation, never the
   * segments, so everything derived from `allSegments` spoke for an empty array
   * while they loaded. MEASURED (dev corpus, conversation 9, `/segments` held
   * back 25 s by an in-page wrapper): the gauge announced
   * `aria-valuenow=0` / `aria-valuemax=0` / *"0 of 0 participant segments
   * coded"* and the transcript read *"No segments found"*; with the request
   * failed instead, both said the same thing PERMANENTLY.
   */
  const segmentsLoad = useListLoad(segmentsQuery)
  const segmentsKnown = segmentsLoad.status === 'ready'

  const codesQuery = useQuery({
    queryKey: ['codes', pid],
    queryFn: () => codesApi.list(pid),
    enabled: !!pid,
  })
  const codesData = codesQuery.data
  /** #961 — `codes` is `[]` before the list answers; the code panel's empty
   * state and its duplicate-name check must not read that as "no codes". */
  const codesLoad = useListLoad(codesQuery)

  const categoriesQuery = useQuery({
    queryKey: ['categories', pid],
    queryFn: () => categoriesApi.list(pid),
    enabled: !!pid,
    retry: retryUnanswered,
  })
  const categoriesData = categoriesQuery.data
  const categories = categoriesData?.categories || []
  /**
   * #963 — whether the category list is an ANSWER. `FloatingCreateCode`'s
   * picker creates a category from a typed name, and `create_category` refuses
   * no duplicate, so the list is the only duplicate guard there is.
   */
  const categoriesLoad = useListLoad(categoriesQuery)

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

  // Whether this conversation carries per-segment timestamps. Drives the Time
  // column default (#453): an imported transcript with no times shows no empty
  // column, and the (no-op) Time toggle is hidden. Independent of audio — playback
  // is driven by the media fields, so an audio conversation lacking per-segment times
  // correctly hides the blank column without affecting the player/scrubber.
  const hasTimestamps = useMemo(() => allSegments.some(s => s.start_time != null), [allSegments])
  const codes = useMemo(() => codesData?.codes ?? [], [codesData?.codes])
  const codeMap = useMemo(() => {
    const m = new Map<number, Code>()
    for (const c of codes) m.set(c.id, c)
    return m
  }, [codes])
  // Coverage is computed client-side from the in-memory segment list (Track J · J1
  // item 3c): the segments query already holds every segment, so this lets the
  // gauge reflect the per-coder visibility filter and break coverage down by coder
  // without a server round-trip. Participant segments only (facilitator excluded),
  // matching the prior server gauge. `codedVisible` collapses to the all-coder
  // total when no coder is hidden.
  const participantSegments = useMemo(() => allSegments.filter(s => !s.is_facilitator), [allSegments])
  const coverage = useMemo(
    () => computeCoverage(participantSegments, s => s.applied_code_details, effectiveHidden, machineCoderIds),
    [participantSegments, effectiveHidden, machineCoderIds],
  )
  // #1077 (c) — the participant turns still waiting for a PERSON, under the lens
  // the gauge uses. ONE set, read by `j` (below) and by the transcript's orange
  // "uncoded" ring, so the ring marks exactly the turns `j` walks to. The ring
  // used to test `applied_codes.length === 0` on the row itself, which counted a
  // model's labels and universal-only markers as coding and — while blind — left
  // a turn only a colleague had coded with neither chip NOR ring: the missing ring
  // said someone had coded it (measured live by the 2026-09-28 /ux-audit).
  const uncodedSegmentIds = useMemo(
    () => new Set(participantSegments
      .filter(s => !isSegmentCodedVisible(s.applied_code_details, effectiveHidden, machineCoderIds))
      .map(s => s.id)),
    [participantSegments, effectiveHidden, machineCoderIds],
  )
  const handleInlineCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['segments', cid] })
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
  }, [queryClient, cid, pid])
  // Clicking an applied-code chip on a segment pivots to that code in the
  // codes panel (#422a) — unfolding the column/panel first (#39 auto-restore;
  // inlined rather than expandPanelIfCollapsed, which is declared later).
  const handleFocusCode = useCallback((codeId: number) => {
    rightColumn.expand()
    setPanelStates(prev => (prev.codes.collapsed ? { ...prev, codes: { collapsed: false } } : prev))
    codePanelRef.current?.focusCode(codeId)
  }, [rightColumn])
  const progress = coverage.total > 0 ? Math.round((coverage.codedVisible / coverage.total) * 100) : 0
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
          invalidateDerivedCounts(queryClient, pid)  // #450: merge changes coverage counts
          setSelectedSegments([result.merged_segment.id])
        },
        undo: async () => {
          if (mergedSegmentId) {
            const result = await segmentsApi.unmerge(cid, mergedSegmentId)
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
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
          queryClient.invalidateQueries({ queryKey: ['codes', pid] })
          invalidateDerivedCounts(queryClient, pid)  // #450: unmerge changes coverage counts
          if (result.restored_segments.length > 0) {
            setSelectedSegments([result.restored_segments[0].id])
          }
        },
        undo: async () => {
          if (restoredSegmentIds.length > 0) {
            const result = await segmentsApi.merge(cid, restoredSegmentIds)
            queryClient.invalidateQueries({ queryKey: ['segments', cid] })
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
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
    invalidateDerivedCounts(queryClient, pid)  // #450: cross-surface counts
  }, [queryClient, cid, pid])

  // #367: lightweight settle for the optimistic-code path — refresh code counts
  // WITHOUT the expensive full-conversation segment refetch (that refetch eager-loads
  // speaker+applications+notes+excerpts per segment and was the ~1s badge lag). The
  // progress gauge no longer needs a settle: it's computed client-side from the
  // optimistically-patched segment cache (Track J · J1 item 3c).
  const settleAfterCodeChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['codes', pid] })
    invalidateDerivedCounts(queryClient, pid)  // #450: cross-surface counts
  }, [queryClient, pid])

  // Optimistically patch applied_codes on the cached segment list so the badge paints
  // immediately. Mirrors the backend exactly: single applyCode/removeCode fan out to all
  // visible segments sharing a group_id (coding.py:85,162); bulkCode touches only the
  // listed ids. `fanOutGroups` selects which behavior to replicate.
  //
  // Track J · J1 item 3c: also patch applied_code_details (the per-application coder
  // shape) so the client-side coverage gauge + per-coder breakdown move with the
  // optimistic apply instead of lagging until the server refetch. The apply is
  // server-stamped to the ACTIVE coder, so the optimistic detail uses user?.id.
  // Post-J2-0 the unique index is per (segment, code, coder) — a code can carry one
  // detail PER coder, so apply/remove below scope to the active coder's own detail
  // (INV-6/#446); they never touch a colleague's application.
  //
  // #868 (f): an APPLY may carry a rating — the undo of a removal re-applies with
  // the rating captured when the entry was built — and the settle after a code
  // change is deliberately light (it never refetches segments, #367), so the
  // optimistic detail must paint that rating or the chip reads "not rated" over a
  // rating the server holds. `magnitudeFor` answers per segment because a
  // multi-segment removal captured one value per segment.
  const patchSegmentCodes = useCallback(
    (
      segmentIds: number[],
      codeId: number,
      action: 'apply' | 'remove',
      fanOutGroups: boolean,
      magnitudeFor?: (segmentId: number) => number | null,
    ) => {
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
          const selfId = user?.id ?? null
          const segments = old.segments.map((s) => {
            if (!targetIds.has(s.id)) return s
            // Scope to the active coder's own application (INV-6/#446): toggling a
            // code a colleague already applied adds/keeps MY application without
            // disturbing theirs. applied_codes is per-application, so remove drops
            // exactly ONE entry (mine), never every coder's.
            const hasMine = s.applied_code_details.some((d) => d.code_id === codeId && d.user_id === selfId)
            if (action === 'apply' && !hasMine) return {
              ...s,
              applied_codes: [...s.applied_codes, codeId],
              applied_code_details: [...s.applied_code_details, {
                code_id: codeId,
                user_id: selfId,
                attribution: null,
                is_universal: codeMap.get(codeId)?.is_universal ?? false,
                // `?? null` — a captured rating of 0 is a rating (the falsy-zero class).
                magnitude: magnitudeFor?.(s.id) ?? null,
                magnitude_conflict: null,
              }],
            }
            if (action === 'remove' && hasMine) {
              const idx = s.applied_codes.indexOf(codeId)
              return {
                ...s,
                applied_codes: idx >= 0
                  ? [...s.applied_codes.slice(0, idx), ...s.applied_codes.slice(idx + 1)]
                  : s.applied_codes,
                applied_code_details: s.applied_code_details.filter(
                  (d) => !(d.code_id === codeId && d.user_id === selfId),
                ),
              }
            }
            return s
          })
          return { ...old, segments }
        }
      )
    },
    [queryClient, cid, user?.id, codeMap]
  )

  // Run an atomic single-POST code change with an optimistic patch + snapshot rollback.
  // useHistory's execute() does NOT roll back on a thrown redo/undo — it only toasts and
  // skips the history entry — so we restore the snapshot here and re-throw to preserve both.
  // `paint` is any optimistic patch of this page's cache; `runOptimisticCode` is the
  // one-code case, and the #1028 undo of an apply paints several codes at once.
  const runOptimisticPatch = useCallback(
    async <T,>(
      paint: () => void,
      action: 'apply' | 'remove',
      serverCall: () => Promise<T>,
    ): Promise<T> => {
      const snapshot = queryClient.getQueryData(['segments', cid])
      paint()
      try {
        const result = await serverCall()
        // #678: a bulk post reports a PARTIAL failure as a 200 body. The optimistic
        // patch above already painted every id, and `settleAfterCodeChange` is the
        // deliberately-light settle that does NOT refetch segments (#367), so a
        // skipped id would stay painted as coded — with attribution — forever.
        //
        // Reconcile by INVALIDATION rather than by un-patching the failed ids: a
        // failure means the server did not recognise those ids, so this cache is
        // untrustworthy for them (they may be gone entirely, in which case the row
        // itself is a phantom). Un-patching would also be wrong for an id the coder
        // had already coded before the batch — there the optimistic apply was a
        // no-op and reverting it would remove a legitimate chip. This mirrors the
        // multi-code path below, which has always reconciled this way for the same
        // reason. Single applyCode/removeCode responses carry no failed-id list, so
        // they fall through to the light settle exactly as before.
        const outcome = collectBulkOutcome(result as Parameters<typeof collectBulkOutcome>[0])
        if (outcome.hasFailures) {
          invalidateAfterCodeChange()
          toast.warning(describeBulkFailure(outcome, 'segment', action))
        } else {
          settleAfterCodeChange()
        }
        return result
      } catch (e) {
        queryClient.setQueryData(['segments', cid], snapshot)
        throw e
      }
    },
    [queryClient, cid, settleAfterCodeChange, invalidateAfterCodeChange]
  )

  const runOptimisticCode = useCallback(
    async (
      segmentIds: number[],
      codeId: number,
      action: 'apply' | 'remove',
      fanOutGroups: boolean,
      serverCall: () => Promise<unknown>,
      magnitudeFor?: (segmentId: number) => number | null,
    ): Promise<void> => {
      await runOptimisticPatch(
        () => patchSegmentCodes(segmentIds, codeId, action, fanOutGroups, magnitudeFor),
        action,
        serverCall,
      )
    },
    [runOptimisticPatch, patchSegmentCodes]
  )

  // ── #1028: an apply that REPLACED a value, and its undo ─────────────────────
  //
  // The server removes this coder's other value of a code set when a value of it
  // is applied, and says which (`lib/apply-undo.ts`). This page's settle never
  // refetches the segments (#367), so what it replaced is painted away from the
  // report — and the undo puts back exactly that, removing the code only where
  // the act put it.
  const segmentDetails = useCallback(
    (segmentId: number) =>
      (segmentMap.get(segmentId) ?? allSegmentsMap.get(segmentId))?.applied_code_details,
    [segmentMap, allSegmentsMap],
  )

  const paintReplaced = useCallback((replaced: Replaced, fanOutGroups: boolean) => {
    for (const [segmentId, codeIds] of replaced) {
      for (const codeId of codeIds) patchSegmentCodes([segmentId], codeId, 'remove', fanOutGroups)
    }
  }, [patchSegmentCodes])

  const paintUndoPlan = useCallback((plan: ApplyUndoPlan, fanOutGroups: boolean) => {
    if (plan.removeFrom.length > 0) patchSegmentCodes(plan.removeFrom, plan.codeId, 'remove', fanOutGroups)
    for (const r of plan.restore) {
      patchSegmentCodes([r.targetId], plan.codeId, 'remove', fanOutGroups)
      patchSegmentCodes([r.targetId], r.codeId, 'apply', fanOutGroups, () => r.magnitude)
    }
  }, [patchSegmentCodes])

  const codeName = useCallback((codeId: number) => codeMap.get(codeId)?.name ?? 'code', [codeMap])

  /**
   * Undo one or more applies from what each captured and what the server replaced.
   *
   * ⚠️ Several calls, so a failure part-way leaves a state no snapshot describes:
   * it REFETCHES rather than rolling the paint back (the multi-code path's rule),
   * and rethrows so `useHistory` keeps a transient failure for a retry.
   */
  const undoApplies = useCallback(
    async (applies: readonly { capture: ApplyCapture; replaced: Replaced }[], single: boolean) => {
      const plans = applies.map(({ capture, replaced }) => planApplyUndo(capture, replaced))
      plans.forEach(plan => paintUndoPlan(plan, single))
      try {
        for (const plan of plans) await runApplyUndo(plan, segmentUndoApi(single), codeName)
        settleAfterCodeChange()
      } catch (e) {
        invalidateAfterCodeChange()
        throw e
      }
    },
    [paintUndoPlan, codeName, settleAfterCodeChange, invalidateAfterCodeChange],
  )

  // ── #35 magnitude: rate at apply (variant A) ────────────────────────────────
  // Which application is awaiting a rating. Set after a single-segment APPLY of a
  // code that declares a scale; the strip below the transcript is the surface.
  const [ratingTarget, setRatingTarget] = useState<{ segmentId: number; code: Code } | null>(null)
  // #1112: the strip shows the LIVE code, so a scale saved while it is open
  // (and a rename) reaches it; the mount keys on the scale's signature so a
  // new step remounts it with a fresh cursor (`lib/rating-targets.ts`).
  const ratingCode = ratingTarget ? liveRatingCode(ratingTarget.code, codeMap) : null

  // Optimistically patch ONE coder's rating, mirroring the backend's group fan-out
  // exactly as `patchSegmentCodes` does for the code itself.
  //
  // ⚠️ Scoped to the active coder's own detail. A rating is that coder's judgement;
  // patching a colleague's would paint agreement that does not exist.
  const patchSegmentMagnitude = useCallback(
    (segmentId: number, codeId: number, value: number | null) => {
      queryClient.setQueryData<{ segments: Segment[] } & Record<string, unknown>>(
        ['segments', cid],
        (old) => {
          if (!old?.segments) return old
          const anchor = old.segments.find((s) => s.id === segmentId)
          const groupId = anchor?.group_id ?? null
          const selfId = user?.id ?? null
          const segments = old.segments.map((s) => {
            const inScope = s.id === segmentId || (groupId != null && s.group_id === groupId)
            if (!inScope) return s
            return {
              ...s,
              applied_code_details: s.applied_code_details.map((d) =>
                // Rating again IS the adjudication of a merge conflict (rules
                // §6d): the server clears the flag, so the optimistic paint
                // clears the `≠N` marker too instead of leaving it until a refetch.
                d.code_id === codeId && d.user_id === selfId
                  ? { ...d, magnitude: value, magnitude_conflict: null }
                  : d,
              ),
            }
          })
          return { ...old, segments }
        },
      )
    },
    [queryClient, cid, user?.id],
  )

  /**
   * Optimistic rating + one server call, bracketed by a CANCEL of the segments
   * query before and ONE refetch of it after — #881's recipe, which the document
   * and observation writers already follow (`magnitude-coding.md` §11).
   *
   * 🔴 #1059 — this page was EXEMPT on the premise that no segments refetch can be
   * in flight when a rating commits here (its apply door uses #367's LIGHT
   * settle). That stopped being true at row 48: a code-set strip choice settles by
   * refetching the whole segment list, and so do a dozen other acts on this page
   * (merge, split, group, quote, a segment edit). A rating given while one of those
   * is out was painted and then overwritten by a response that left the server
   * BEFORE the rating did — "not rated" over a rating the server holds. Cancelling
   * stops the overwrite; the refetch after the write is what makes the truth land
   * last (cancelling REVERTS to that fetch's start, so an act it would have
   * delivered blinks out until this refetch lands — #881's measured second half).
   * ⚠️ Still no `settleAfterCodeChange`: a rating changes no coded COUNT.
   */
  const runOptimisticMagnitude = useCallback(
    async (segmentId: number, codeId: number, value: number | null) => {
      const key = ['segments', cid]
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData(key)
      patchSegmentMagnitude(segmentId, codeId, value)
      try {
        await codingApi.setMagnitude(segmentId, codeId, value)
        queryClient.invalidateQueries({ queryKey: key })
      } catch (e) {
        queryClient.setQueryData(key, snapshot)
        throw e
      }
    },
    [queryClient, cid, patchSegmentMagnitude],
  )

  // The rating a given coder currently holds, read from the same cache the chips
  // render from — so the strip opens showing what is actually stored.
  const currentMagnitude = useCallback(
    (segmentId: number, codeId: number): number | null => {
      const seg = segmentMap.get(segmentId)
      const selfId = user?.id ?? null
      const detail = seg?.applied_code_details.find(
        (d) => d.code_id === codeId && d.user_id === selfId,
      )
      // `?? null` NOT `|| null` — a stored 0 is a real rating.
      return detail?.magnitude ?? null
    },
    [segmentMap, user?.id],
  )

  const commitMagnitude = useCallback(
    (value: number) => {
      const target = ratingTarget
      if (!target) return
      const previous = currentMagnitude(target.segmentId, target.code.id)
      setRatingTarget(null)
      // Undoable like every other coding mutation here. The inverse restores the
      // PREVIOUS value, which may legitimately be null (unrated) or 0.
      history.execute({
        type: 'code_apply',
        description: `Rate "${target.code.name}"`,
        redo: () => runOptimisticMagnitude(target.segmentId, target.code.id, value),
        undo: () => runOptimisticMagnitude(target.segmentId, target.code.id, previous),
      })
    },
    [ratingTarget, currentMagnitude, history, runOptimisticMagnitude],
  )

  /**
   * Open the rating strip for an application that ALREADY exists (#868 e/f).
   * Both the `r` verb and the context menu land here.
   */
  const openRatingFor = useCallback((segmentId: number, code: Code) => {
    if (!code.magnitude_scale) return
    setSelectedSegments([segmentId])
    setRatingTarget({ segmentId, code })
  }, [setSelectedSegments, setRatingTarget])

  /** The codes the ACTIVE coder may rate on one segment, in chip order. */
  const ratableCodesForSegment = useCallback((segmentId: number): Code[] => {
    const seg = segmentMap.get(segmentId)
    if (!seg) return []
    return ratableCodes(seg.applied_code_details, codeMap, user?.id ?? null)
  }, [segmentMap, codeMap, user?.id])

  /** The same question for the keyboard, which acts on a SINGLE selected segment. */
  const ratableForSelection = useCallback((): { segmentId: number; codes: Code[] } | null => {
    const selected = selectedSegmentsRef.current
    if (selected.length !== 1) return null
    return { segmentId: selected[0], codes: ratableCodesForSegment(selected[0]) }
  }, [ratableCodesForSegment])

  /**
   * The single-segment apply/remove pair, extracted so the chord toggle, the
   * context menu and the chip's own controls (#875) share ONE implementation —
   * including the #868 (f) rating capture and the strip-on-apply.
   */
  /**
   * #1070 — the segments ONE single-door act covers: this segment and its group's
   * visible siblings, the scope the server's `group_target_ids` fans out over and
   * `patchSegmentCodes` mirrors for the paint. From the UNFILTERED list: the
   * server fans out whatever the speaker filter shows.
   */
  const groupScope = useCallback((segmentId: number): number[] => {
    const groupId = allSegmentsMap.get(segmentId)?.group_id ?? null
    if (groupId == null) return [segmentId]
    return [segmentId, ...allSegments.filter(s => s.group_id === groupId && s.id !== segmentId).map(s => s.id)]
  }, [allSegments, allSegmentsMap])

  const removeSingle = useCallback((segmentId: number, codeId: number, codeName: string) => {
    const scope = groupScope(segmentId)
    if (scope.length === 1) {
      const previous = currentMagnitude(segmentId, codeId)
      history.execute({
        type: 'code_remove',
        description: `Remove code "${codeName}"`,
        redo: () => runOptimisticCode([segmentId], codeId, 'remove', true, () => codingApi.removeCode(segmentId, codeId)),
        undo: () => runOptimisticCode(
          [segmentId], codeId, 'apply', true,
          () => codingApi.applyCode(segmentId, codeId, undefined, previous),
          () => previous,
        ),
      })
      return
    }
    // 🔴 #1070 — on a GROUP the remove fans out, and its old inverse (the single
    // apply, carrying this segment's rating) fanned out again: a sibling that never
    // held the code gained it. Captured NOW per sibling; undone through the bulk
    // door onto exactly the siblings that held it, then each one re-rated.
    const capture = captureRemove(codeId, scope, segmentDetails, user?.id ?? null)
    history.execute({
      type: 'code_remove',
      description: `Remove code "${codeName}"`,
      redo: () => runOptimisticCode([segmentId], codeId, 'remove', true, () => codingApi.removeCode(segmentId, codeId)),
      undo: async () => {
        for (const h of capture.held) {
          patchSegmentCodes([h.targetId], codeId, 'apply', false, () => h.magnitude)
        }
        try {
          await runRemoveUndo(capture, segmentUndoApi(false), (id) => codeMap.get(id)?.name ?? 'code')
          settleAfterCodeChange()
        } catch (e) {
          // Several calls: a failure part-way leaves a state no snapshot describes.
          invalidateAfterCodeChange()
          throw e
        }
      },
    })
  }, [groupScope, currentMagnitude, history, runOptimisticCode, segmentDetails, user?.id, patchSegmentCodes, codeMap, settleAfterCodeChange, invalidateAfterCodeChange])

  const applySingle = useCallback((segmentId: number, code: Code) => {
    // #1028: captured NOW — the undo removes the code only if the act put it here,
    // and re-rates whatever the server reports it replaced.
    // 🔴 #1070: captured over the GROUP the act fans out to, and undone through
    // the bulk door sibling by sibling (`single` only when there is no group): the
    // siblings routinely differ, and an inverse that fans out must capture what it
    // fans out over.
    const scope = groupScope(segmentId)
    const capture = captureApply(code.id, scope, segmentDetails, user?.id ?? null)
    let replaced: Replaced = new Map()
    history.execute({
      type: 'code_apply',
      description: `Apply code "${code.name}"`,
      redo: async () => {
        const result = await runOptimisticPatch(
          () => patchSegmentCodes([segmentId], code.id, 'apply', true),
          'apply',
          () => codingApi.applyCode(segmentId, code.id),
        )
        // Per segment now (#1070), so the paint names each one's own.
        replaced = replacedFromSingle(segmentId, result)
        paintReplaced(replaced, false)
      },
      undo: () => undoApplies([{ capture, replaced }], scope.length === 1),
    })
    if (code.magnitude_scale) setRatingTarget({ segmentId, code })
  }, [groupScope, history, runOptimisticPatch, patchSegmentCodes, setRatingTarget, segmentDetails, user?.id, paintReplaced, undoApplies])

  /** The chip's own controls (#875) — they act on the row that owns the chip. */
  const handleChipRemove = useCallback((segmentId: number, codeId: number) => {
    const code = codeMap.get(codeId)
    removeSingle(segmentId, codeId, code?.name ?? 'code')
  }, [codeMap, removeSingle])

  const handleChipApply = useCallback((segmentId: number, codeId: number) => {
    const code = codeMap.get(codeId)
    if (code) applySingle(segmentId, code)
  }, [codeMap, applySingle])

  // Toggle code on selected segments with history tracking
  const handleCodeToggle = useCallback(
    (code: Code) => {
      if (selectedSegments.length === 0) return

      // Check if all selected segments have this code (using segmentMap for O(1) lookup)
      const allHaveCode = selectedSegments.every((segId) => {
        const seg = segmentMap.get(segId)
        if (!seg) return false
        // INV-6 (#446): "do I have it?", not "does anyone?" — so the toggle applies
        // my code when only a colleague has it, instead of taking the remove branch.
        return isCodeAppliedByActiveCoder(seg.applied_code_details, seg.applied_codes ?? [], code.id, user?.id ?? null)
      })

      const segmentIds = [...selectedSegments]
      const codeId = code.id
      const codeName = code.name

      if (selectedSegments.length === 1) {
        // ⚠️ Both arms delegate to the shared pair above, so the chip's controls
        // and the context menu cannot drift from the chord (#875). Removing has
        // nothing to rate; a multi-segment apply still opens no strip.
        if (allHaveCode) removeSingle(selectedSegments[0], codeId, codeName)
        else applySingle(selectedSegments[0], code)
      } else if (!allHaveCode) {
        // #1028: the undo removes the code only from segments the act put it on
        // (it used to strip it from a segment that already had it) and puts back
        // any code-set value the server reports it replaced.
        const capture = captureApply(codeId, segmentIds, segmentDetails, user?.id ?? null)
        let replaced: Replaced = new Map()
        history.execute({
          type: 'code_apply',
          description: `Apply code "${codeName}" to ${segmentIds.length} segments`,
          redo: async () => {
            const result = await runOptimisticPatch(
              () => patchSegmentCodes(segmentIds, codeId, 'apply', false),
              'apply',
              () => codingApi.bulkCode(segmentIds, codeId, 'apply'),
            )
            replaced = replacedFromBulk(result)
            paintReplaced(replaced, false)
          },
          undo: () => undoApplies([{ capture, replaced }], false),
        })
      } else {
        // #868 (f), the multi-segment arm: each segment's rating is captured
        // separately (they need not agree), and the inverse re-applies per
        // segment when any was rated — the bulk endpoint carries no rating.
        const captured = new Map(segmentIds.map(id => [id, currentMagnitude(id, codeId)] as const))
        const anyRated = [...captured.values()].some(v => v != null)
        history.execute({
          type: 'code_remove',
          description: `Remove code "${codeName}" from ${segmentIds.length} segments`,
          redo: () => runOptimisticCode(segmentIds, codeId, 'remove', false, () => codingApi.bulkCode(segmentIds, codeId, 'remove')),
          undo: () => runOptimisticCode(
            segmentIds, codeId, 'apply', false,
            () => anyRated
              ? Promise.all(segmentIds.map(id => codingApi.applyCode(id, codeId, undefined, captured.get(id) ?? null)))
              : codingApi.bulkCode(segmentIds, codeId, 'apply'),
            (id) => captured.get(id) ?? null,
          ),
        })
      }
      showSaved()
    },
    [selectedSegments, segmentMap, history, runOptimisticCode, runOptimisticPatch, patchSegmentCodes, showSaved, user?.id, currentMagnitude, applySingle, removeSingle, segmentDetails, paintReplaced, undoApplies]
  )

  // Handle toggling multiple codes at once (Item 47)
  const handleMultiCodeToggle = useCallback(
    (codesToToggle: Code[]) => {
      if (selectedSegments.length === 0 || codesToToggle.length === 0) return

      // Apply each code to each selected segment
      const segmentIds = [...selectedSegments]

      // Execute all code applications
      const codeNames = codesToToggle.map(c => c.name).join(', ')

      // #1028: captured per code, so the undo removes each only where it put it
      // and puts back any code-set value it replaced. (Two values of ONE set are
      // refused before this is reached — `CodePanel`, `conflictingSetValues`.)
      const captures = codesToToggle.map(code => captureApply(code.id, segmentIds, segmentDetails, user?.id ?? null))
      let replacedByCode: Replaced[] = codesToToggle.map(() => new Map())

      // Apply all codes in parallel (don't toggle). Multi-code = N independent POSTs, so a
      // partial failure can leave some codes applied server-side; snapshot rollback would wrongly
      // wipe them. On error we reconcile authoritatively via the full invalidation (incl. segments)
      // instead, accepting the one expensive refetch on the rare error path.
      const runApply = async () => {
        codesToToggle.forEach(code => patchSegmentCodes(segmentIds, code.id, 'apply', false))
        try {
          const results = await Promise.all(
            codesToToggle.map(code => codingApi.bulkCode(segmentIds, code.id, 'apply')),
          )
          replacedByCode = results.map(r => replacedFromBulk(r))
          paintReplaced(mergeReplaced(replacedByCode), false)
          // #678: same reconciliation as the thrown case below — a 200 carrying
          // skipped ids leaves the same stale paint a rejection would. Ids are
          // folded across the N per-code responses, so a segment that failed for
          // every code is reported once.
          const outcome = collectBulkOutcome(results)
          if (outcome.hasFailures) {
            invalidateAfterCodeChange()
            toast.warning(describeBulkFailure(outcome, 'segment', 'apply'))
          } else {
            settleAfterCodeChange()
          }
        } catch (e) {
          invalidateAfterCodeChange()
          throw e
        }
      }
      history.execute({
        type: 'code_apply',
        description: `Apply codes "${codeNames}" to ${segmentIds.length} segment(s)`,
        redo: runApply,
        undo: () => undoApplies(
          captures.map((capture, i) => ({ capture, replaced: replacedByCode[i] })), false,
        ),
      })
      showSaved()
    },
    [selectedSegments, history, patchSegmentCodes, settleAfterCodeChange, invalidateAfterCodeChange, showSaved, segmentDetails, user?.id, paintReplaced, undoApplies]
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

  // Jump to the next uncoded participant segment, client-side (Track J · J1 item 3c).
  // Coder-aware: a segment coded only by a HIDDEN coder counts as uncoded-for-me, so
  // `j` walks to it. Iterates the displayed (filtered) list so the selection-driven
  // auto-scroll always lands; skips facilitator segments (participants only) and uses
  // the non-universal definition (the prior server endpoint treated universal-only as
  // coded, disagreeing with the gauge — this also closes that gap). Refs keep the
  // keyboard closure fresh. #1077 (c): membership is `uncodedSegmentIds`, the set
  // the ring draws, so the two can never disagree about a turn.
  const handleJumpToNextUncoded = useCallback(() => {
    const pool = segmentsRef.current
    if (pool.length === 0) return
    const currentId = selectedSegmentsRef.current.length > 0 ? selectedSegmentsRef.current[0] : null
    const currentIdx = currentId != null ? pool.findIndex(s => s.id === currentId) : -1
    for (let offset = 1; offset <= pool.length; offset++) {
      const seg = pool[(currentIdx + offset) % pool.length]
      if (uncodedSegmentIds.has(seg.id)) {
        // Setting selection triggers auto-scroll in TranscriptPanel
        setSelectedSegments([seg.id])
        return
      }
    }
    toast('All participant segments are coded')
  }, [uncodedSegmentIds])

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
      // INV-6 (#446): count segments the ACTIVE coder applied this code to, so the
      // tri-state checkbox reflects my own coding, not any coder's.
      const appliedCount = selectedSegs.filter(seg => isCodeAppliedByActiveCoder(seg.applied_code_details, seg.applied_codes ?? [], code.id, user?.id ?? null)).length

      if (appliedCount === 0) {
        map.set(code.id, 'none')
      } else if (appliedCount === selectedSegments.length) {
        map.set(code.id, 'all')
      } else {
        map.set(code.id, 'some')
      }
    })
    return map
  }, [codes, selectedSegments, segmentMap, user?.id])

  // Panel toggle helpers
  const togglePanel = useCallback((panel: keyof typeof panelStates) => {
    setPanelStates(prev => ({
      ...prev,
      [panel]: { collapsed: !prev[panel].collapsed }
    }))
  }, [])

  // Expand panel if collapsed. Also the #39 auto-restore chokepoint: any
  // flow that brings a panel into view must first unfold the column, or a
  // collapsed column silently swallows the action.
  const expandPanelIfCollapsed = useCallback((panel: keyof typeof panelStates) => {
    rightColumn.expand()
    if (panelStates[panel].collapsed) {
      setPanelStates(prev => ({
        ...prev,
        [panel]: { collapsed: false }
      }))
    }
  }, [panelStates, rightColumn])

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
        queryClient.invalidateQueries({ queryKey: ['codes', pid] })
        queryClient.invalidateQueries({ queryKey: ['notes', cid] })
        invalidateDerivedCounts(queryClient, pid)  // #450: split/unsplit changes coverage counts
      }
      history.execute({
        type: 'segment_split',
        description: 'Split segment',
        redo: async () => {
          const result = await segmentsApi.split(cid, ranges)
          newSegmentIds = result.new_segments.map(s => s.id)
          // #712: the notes this split left on the original — say so now, because
          // the link is unrecoverable afterwards.
          const stayed = describeQuoteNotesStayed(result.quote_notes_stayed)
          if (stayed) toast.info(stayed)
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
      queryClient.invalidateQueries({ queryKey: ['codes', pid] })
      queryClient.invalidateQueries({ queryKey: ['notes', cid] })
      invalidateDerivedCounts(queryClient, pid)  // #450: unsplit changes coverage counts
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

  // Context menu: apply/remove code on a specific segment.
  //
  // ⚠️ Through the SHARED single pair (#875's rule), which this handler was a
  // private copy of — so it never opened the rating strip for a scaled code,
  // and it would have missed #1028's undo of a replaced code-set value.
  const handleContextCodeApply = useCallback(
    (segmentId: number, codeId: number) => {
      const seg = segmentMap.get(segmentId) || allSegmentsMap.get(segmentId)
      const code = codeMap.get(codeId)
      if (!seg || !code) return

      // INV-6 (#446): apply vs remove keys off the ACTIVE coder's own application.
      if (isCodeAppliedByActiveCoder(seg.applied_code_details, seg.applied_codes ?? [], codeId, user?.id ?? null)) {
        removeSingle(segmentId, codeId, code.name)
      } else {
        applySingle(segmentId, code)
      }
      showSaved()
    },
    [segmentMap, allSegmentsMap, codeMap, showSaved, user?.id, removeSingle, applySingle]
  )

  // Context menu: open floating create code dialog
  const handleContextCreateCode = useCallback((coords: FloatingCoords) => {
    setCreateCodeDialog({ position: coords, segmentIds: [...selectedSegmentsRef.current], initialName: selectionPrefill() })
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
      setCreateCodeDialog({ position: coords, segmentIds: [...sel], initialName: selectionPrefill() })
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
      // ⚠️ The media check is load-bearing, not defensive (#784): claiming Space on a
      // conversation with no recording swallowed the key and did nothing — the sibling
      // Observations handler has always had it, and these two must keep the same shape.
      ' ': () => {
        const p = playbackRef.current
        if (focusedPanel !== 'transcript' || !p?.hasPlayableMedia) return false
        p.togglePlayback()
        return true
      },
      g: () => {
        if (focusedPanel !== 'transcript') return false
        handleGroupHotkey()
        return true
      },
      // #868 (e/f) — `r` re-opens the rating strip for an application that
      // already exists, so a mis-keyed rating can be corrected and a code
      // applied by any other door can still be rated. Chosen over a per-chip
      // button because the chip row is packed and its targets are already under
      // the 24px floor (#647); the status bar carries the discovery.
      // ⚠️ Returns FALSE when there is nothing to rate, so the key falls through
      // rather than being silently swallowed. Opens the FIRST ratable code; the
      // context menu names each one when a segment carries two.
      r: () => {
        const target = ratableForSelection()
        if (!target || target.codes.length === 0) return false
        openRatingFor(target.segmentId, target.codes[0])
        return true
      },
    },
    clearSelection: () => setSelectedSegments([]),
    // Video theater/PiP exit — the overlay Escape layer (slab 4).
    onEscapeOverlay: () => playbackRef.current?.exitVideoOverlay() ?? false,
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
        <div role="alert" className="p-4 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 rounded-lg text-sm text-center">
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
      {/* #516: flex-wrap + the ml-auto tail group below — the toolbar previously
        * clipped its tail (Codebook at 1440, the blind pill at the 1280 minimum)
        * with no wrap/overflow strategy. */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-mm-surface flex-shrink-0 flex-wrap">
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
              aria-label="Previous conversation"
              title={prevConversation ? `Previous: ${prevConversation.name}` : undefined}
            >
              <ChevronLeft className="w-4 h-4" aria-hidden />
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
              aria-label="Next conversation"
              title={nextConversation ? `Next: ${nextConversation.name}` : undefined}
            >
              <ChevronRight className="w-4 h-4" aria-hidden />
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
            aria-label="Undo"
              title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!history.canRedo}
            onClick={() => history.redo()}
            aria-label="Redo"
              title="Redo (Ctrl+Y)"
          >
            <Redo2 className="w-4 h-4" />
          </Button>
        </div>

        {/* Column visibility toggles */}
        <div className="flex items-center gap-1 border-l border-mm-border-subtle pl-3">
          {hasTimestamps && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleColumn('timestamps')}
              aria-pressed={columnVisibility.timestamps}
              className={`text-xs gap-1 ${columnVisibility.timestamps ? COLUMN_TOGGLE_COLORS.timestamps : 'text-mm-text-faint'}`}
              title={columnVisibility.timestamps ? 'Hide the timestamp column' : "Show each segment's timestamp"}
            >
              {columnVisibility.timestamps ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              Time
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleColumn('notes')}
            aria-pressed={columnVisibility.notes}
            className={`text-xs gap-1 ${columnVisibility.notes ? COLUMN_TOGGLE_COLORS.notes : 'text-mm-text-faint'}`}
            title={columnVisibility.notes ? 'Hide the notes column' : "Show each segment's notes"}
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
            title={columnVisibility.codes ? 'Hide the applied-codes column' : "Show each segment's applied codes"}
          >
            {columnVisibility.codes ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            Codes
          </Button>
        </div>

        {/* Media controls */}
        <div className="flex items-center gap-1 border-l border-mm-border-subtle pl-2">
          {/* Hidden file input for media upload */}
          <input
            ref={audioFileInputRef}
            type="file"
            accept={MEDIA_ACCEPT}
            className="hidden"
            onChange={handleAudioFileSelect}
          />

          {hasMedia ? (
            <>
              <Popover>
                {/* #559: icon-only trigger — a Radix tooltip DESCRIBES a trigger but
                    never NAMES it, so this announced as a bare "button". The aria-label
                    carries the current offset too, since the visible chip only renders
                    when the offset is non-zero. */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <button
                        aria-label={
                          offsetValue !== 0
                            ? `Media sync offset: ${offsetValue > 0 ? '+' : ''}${offsetValue.toFixed(1)} seconds`
                            : 'Media sync offset'
                        }
                        className="flex items-center gap-1 text-xs text-mm-text-secondary px-1 hover:text-mm-text cursor-pointer rounded transition-colors"
                      >
                        {conversation?.media_type === 'video' ? (
                          <Video className="w-3.5 h-3.5 text-mm-green-text" aria-hidden />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5 text-mm-green-text" aria-hidden />
                        )}
                        {offsetValue !== 0 && (
                          <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                            {offsetValue > 0 ? '+' : ''}{offsetValue.toFixed(1)}s
                          </span>
                        )}
                      </button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Media sync offset</TooltipContent>
                </Tooltip>
                <PopoverContent side="bottom" align="start" className="w-64 p-3" aria-label="Recording sync offset">
                  <div className="space-y-2">
                    <p className="text-xs font-medium">{conversation?.media_type === 'video' ? 'Video' : 'Audio'} Sync Offset</p>
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
                      If the recording plays too early, decrease. If too late, increase.
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
                    aria-label="Replace recording"
                    onClick={() => audioFileInputRef.current?.click()}
                    disabled={uploadAudioMutation.isPending}
                  >
                    <RefreshCw className="w-3 h-3" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Replace recording</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-red-500 hover:text-red-600"
                    aria-label="Remove recording"
                    onClick={() => setShowRemoveAudioConfirm(true)}
                    disabled={deleteAudioMutation.isPending}
                  >
                    <Trash2 className="w-3 h-3" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Remove recording</TooltipContent>
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
                    <><Mic className="w-3.5 h-3.5" /> Attach Recording</>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Upload MP3, M4A, WAV audio or MP4, MOV, WebM video</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Scrubber slot — populated via portal from TranscriptPanel */}
        <div ref={scrubberSlotRef} className="flex items-center gap-2 border-l border-mm-border-subtle pl-3 min-w-56 overflow-visible [&:empty]:hidden" />

        {/* Tail group (#516): one ml-auto unit so at narrow widths it wraps to its
          * own right-aligned row instead of individual controls clipping off-screen. */}
        <div className="flex items-center gap-2 ml-auto">

        {savedIndicator && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="w-4 h-4" />
            Saved
          </span>
        )}

        {/* Progress (#351: explicit "participant" qualifier so facilitator
          * segments not counting is no surprise to the analyst). Computed
          * client-side (Track J · J1 item 3c) so it reflects the per-coder
          * filter; the count/bar/% all read `codedVisible`. */}
        {/* #963 Tier 2 — the gauge measures the transcript, so it says NOTHING
          * until the transcript is an answer. `ObservationWorkbench`'s shape,
          * for its reason: with no list in hand the region carries no
          * progressbar semantics AT ALL rather than announcing a fake 0% over
          * an `aria-valuemax` of 0, which is a degenerate range as well as a
          * false one.
          * ⚠️ While merely LOADING this slot is silent: `TranscriptPanel`
          * below already mounts a `role="status"` line reading "Loading
          * segments…", and a second copy is a duplicate on screen and a second
          * announcement. A FAILURE does get a word here, because the gauge slot
          * would otherwise sit blank beside a transcript-shaped hole. */}
        <div
          className="flex items-center gap-2"
          {...(segmentsKnown
            ? {
                role: 'progressbar' as const,
                'aria-label': 'Coding progress',
                'aria-valuenow': coverage.codedVisible,
                'aria-valuemin': 0,
                'aria-valuemax': coverage.total,
                'aria-valuetext': blind
                  // #503: not "by you" — archived colleagues' codings still count
                  // in gauges under blind (#451 CHIPS-ONLY rule + DEC-G roster-
                  // derived hidden set), so the value can exceed your own work.
                  ? `${coverage.codedVisible} of ${coverage.total} participant segments coded (colleagues hidden)`
                  : lensHidesAnyCoder(effectiveHidden)
                    ? `${coverage.codedVisible} of ${coverage.total} participant segments coded by visible coders`
                    : `${coverage.codedVisible} of ${coverage.total} participant segments coded`,
              }
            : {})}
        >
          {segmentsKnown ? (
            <>
              <span
                className="text-sm text-mm-text-secondary font-mono tabular-nums"
                title={blind
                  // #517: the conversations list shows ALL-coder coverage, so while
                  // blind the two numbers legitimately disagree — say so at the gauge.
                  ? "Colleagues' coding is hidden (blind coding) — this count reflects only coding visible to you. The conversations list and Overview show all coders' coverage. Facilitator segments are excluded."
                  : 'Facilitator segments are excluded from coding progress.'}
              >
                {coverage.codedVisible}/{coverage.total} participant segments coded
              </span>
              <SegmentProgressBar segments={allSegments} hiddenCoderIds={effectiveHidden} machineCoderIds={machineCoderIds} className="w-32" />
              <span className="text-sm font-medium font-mono tabular-nums">{progress}%</span>
            </>
          ) : segmentsLoad.status === 'failed' ? (
            <span className="text-sm text-mm-text-faint">Coding progress unavailable</span>
          ) : null}
        </div>

        {multiHumanCoder && <BlindModeToggle blind={blind} onToggle={toggleReveal} surface="workbench" />}
        <CoderCountBadge projectId={pid} conversationId={cid} enabled={multiCoder} withholding={withholding} />

        {/* Codebook */}
        <Button variant="ghost" size="icon" onClick={openCodebook} title="Codebook" aria-label="Codebook">
          <BookOpen className="w-4 h-4" />
        </Button>

        </div>{/* end tail group (#516) */}
      </div>

      {/* Remove audio confirmation */}
      <ConfirmDialog
        open={showRemoveAudioConfirm}
        onOpenChange={setShowRemoveAudioConfirm}
        title="Remove Recording"
        description="Remove the media file from this conversation? The transcript and coding are not affected."
        confirmLabel="Remove Recording"
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
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Transcript.
          * 🔴 `min-w-0` is load-bearing (#998): without it this column keeps its
          * min-content width — MEASURED 470px at a 640px viewport — and the
          * 320px panel rail beside it is pushed to x=470, i.e. 150px past the
          * right edge (226px in the state the a11y sweep filed), inside a parent
          * that is `overflow-hidden`, so there is NO scroll to reach it and two
          * of the three code-set values are simply off-screen. #937's rule:
          * the flexible child was present and doing its job, and the question is
          * what is INSIDE it. The document twin has carried `min-w-0` all along,
          * which is why that page measured on-screen and this one did not.
          *
          * ⚠️ `overflow-x-hidden` is the OTHER half of #937's pairing — "grant
          * the collapse AND clip the remainder". Granting it alone leaves the
          * transcript HEADER's fixed gutters (`w-[160px]` Codes + `w-[40px]`
          * Notes) extending to x=443 over a 320px column; the rows themselves
          * are already clipped by their own Virtuoso scroller, so the header is
          * the only spill, and the ONLY thing keeping it off the rail is that
          * the rail is an opaque later sibling. Paint order is not a guarantee.
          * MEASURED after: no vertical scrollbar appears (`scrollHeight` 134 =
          * `clientHeight`) and the rows' own horizontal scroller is unchanged
          * at 304/410. */}
        <div className="flex-1 min-w-0 overflow-x-hidden flex flex-col border-r bg-mm-surface">
          <TranscriptPanel
            segments={segments}
            allSegments={allSegments}
            selectedSegments={selectedSegments}
            onSelectionChange={setSelectedSegments}
            conversationId={cid}
            codes={codes}
            segmentsLoad={segmentsLoad}
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
            onGroupSegments={handleGroupSegments}
            onUngroupSegments={handleUngroupSegments}
            onContextCodeApply={handleContextCodeApply}
            onContextCreateCode={handleContextCreateCode}
            onContextCreateNote={handleContextCreateNote}
            onSplitSegment={handleSplitSegment}
            onUnsplitSegment={handleUnsplitSegment}
            showTimestamps={columnVisibility.timestamps && hasTimestamps}
            showNotes={columnVisibility.notes}
            showCodes={columnVisibility.codes}
            projectId={pid}
            allCodes={codes}
            codesStatus={codesLoad.status}
            codeMap={codeMap}
            onCodeChange={handleInlineCodeChange}
            onFocusCode={handleFocusCode}
            onChipRemove={handleChipRemove}
            onChipApply={handleChipApply}
            onRateCode={openRatingFor}
            ratableCodesFor={ratableCodesForSegment}
            coderMap={multiCoder ? coderMap : undefined}
            coders={coders}
            activeCoderId={user?.id ?? null}
            coderFilterHidden={effectiveHidden}
            uncodedSegmentIds={uncodedSegmentIds}
            onCoderFilterChange={setHiddenCoders}
            coderActiveIds={coderCoverage.isLoaded ? coderCoverage.activeCoderIds : undefined}
            coderExtra={coderCoverage.extraCoders}
            // #964: "View all — N archived" is a coder-filter choice; it must not
            // bring an archived colleague's chips back after re-blinding.
            coderShowArchived={showArchivedCoders && !withholding}
            onCoderShowArchivedChange={setShowArchivedCoders}
            hideCoderFilter={withholding}
            scrubberPortalRef={scrubberSlotRef}
            conversation={conversation}
            playbackRef={playbackRef}
          />
          {/*
            #35 — the rating strip, mounted BELOW the transcript rather than
            inside a row. Two reasons, both measured:

            (1) At the 640×360 viewport a 1280×720 window has at 200% zoom there
                is no room for a tick row inside the Codes column — a number plus
                its track costs ~22px and survives, a control does not.
            (2) The rows are virtualised, and react-virtuoso's `components` must
                keep a stable module-scope identity (#826): injecting a
                conditional child into a row risks the remount that drops DOM
                focus to `<body>`. Outside the scroller, that cannot happen.
          */}
          {ratingTarget && ratingCode?.magnitude_scale && (
            // py-1, not py-2: the vertical budget at 640×360 is 85px for the
            // whole control (measured on the document twin; same chrome here).
            <div className="border-t border-border bg-mm-surface px-3 py-1 shrink-0">
              <MagnitudeStrip
                // #870 (c): keyed on the TARGET, so applying a second scaled
                // code while the strip is open remounts it — the cursor and the
                // focus effect initialise once, and a swap on a live mount kept
                // the old cursor and left focus on the button that was clicked.
                key={`${ratingTarget.segmentId}-${ratingTarget.code.id}-${scaleSignature(ratingCode.magnitude_scale)}`}
                codeName={ratingCode.name}
                scale={ratingCode.magnitude_scale}
                value={currentMagnitude(ratingTarget.segmentId, ratingTarget.code.id)}
                onCommit={commitMagnitude}
                onSkip={() => setRatingTarget(null)}
              />
            </div>
          )}
        </div>

        {/* Right Panel - Collapsible Sections, fixed width (#565: the resizer
          * never worked and was removed; the rail below is the real-estate move).
          * #39: the whole column folds to a slim icon rail (width returns to
          * transcript/video); rail icons expand + focus their panel. */}
        {rightColumn.collapsed ? (
          <div
            role="toolbar"
            aria-orientation="vertical"
            aria-label="Panels (collapsed)"
            className="w-10 flex-shrink-0 flex flex-col items-center gap-1 py-2 bg-mm-surface"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={rightColumn.expand} aria-label="Expand panels">
                  <PanelRightOpen className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">Expand panels</TooltipContent>
            </Tooltip>
            <span className="w-5 h-px bg-mm-border-subtle my-1" />
            {([
              { key: 'codes' as const, label: 'Codes', Icon: Tags, focus: () => codePanelRef.current?.focus() },
              { key: 'notes' as const, label: 'Notes', Icon: StickyNote, focus: () => notesPanelRef.current?.focus() },
              { key: 'memos' as const, label: 'Memos', Icon: NotebookPen, focus: () => memoPanelRef.current?.focus() },
            ]).map(({ key, label, Icon, focus }) => (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    aria-label={`Open ${label}`}
                    onClick={() => {
                      expandPanelIfCollapsed(key)
                      setFocusedPanel(key)
                      requestAnimationFrame(() => focus())
                    }}
                  >
                    <Icon className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : (
        <div className={`relative flex flex-col bg-mm-surface ${PANEL_RAIL_SCROLL} w-80 shrink-0`}>
          {/* Codes Panel */}
          <CollapsiblePanel
            title="Codes"
            isCollapsed={panelStates.codes.collapsed}
            onToggle={() => togglePanel('codes')}
            className={panelStates.codes.collapsed ? '' : `flex-[2] ${PANEL_EXPANDED}`}
            headerExtra={
              <span className="flex items-center gap-1.5">
                {/* #963 — nothing to jump to until the transcript answers, and
                  * a control that cannot act must not be a control (#933). The
                  * TRANSIENT arm of `lib/mode-disabled.ts`: native `disabled`,
                  * earning no tab stop, because the state resolves itself. */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleJumpToNextUncoded() }}
                  disabled={!segmentsKnown}
                  className="inline-flex items-center gap-1 text-[10px] text-mm-text-muted hover:text-mm-text-secondary transition-colors disabled:opacity-50"
                >
                  Jump to uncoded
                  <SkipForward className="w-3 h-3" aria-hidden="true" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); rightColumn.collapse() }}
                  aria-label="Collapse panels"
                  title="Collapse panels — reclaim width for the transcript"
                  className="text-mm-text-muted hover:text-mm-text-secondary transition-colors"
                >
                  <PanelRightClose className="w-3.5 h-3.5" />
                </button>
              </span>
            }
          >
            <PageErrorBoundary>
              <CodePanel
                ref={codePanelRef}
                codes={codes}
                codesLoad={codesLoad}
                projectId={pid}
                selectedCodesMap={selectedCodesMap}
                onCodeToggle={handleCodeToggle}
                onMultiCodeToggle={handleMultiCodeToggle}
                onCreateCode={(name) => createCodeMutation.mutate(name)}
                onAddCodeMemo={(codeId, codeName) => {
                  // Expand memos panel and set up creation for this code
                  rightColumn.expand()
                  setPanelStates(prev => ({ ...prev, memos: { collapsed: false } }))
                  setFocusedPanel('memos')
                  setCreateMemoForCode({ id: codeId, name: codeName })
                }}
                disabled={selectedSegments.length === 0}
                codeSets={
                  /* Row 48 — SINGLE segment only, the rating strip's rule for
                     the rating strip's reason: a set answers "which one value
                     does THIS passage take?", and one choice standing for
                     several selected passages is a judgement the researcher was
                     never offered a way to make. */
                  <CodeSetStrip
                    projectId={pid}
                    target={
                      selectedSegments.length === 1
                        ? { kind: 'segment', segmentId: selectedSegments[0] }
                        : null
                    }
                    appliedCodeDetails={
                      selectedSegments.length === 1
                        ? segmentMap.get(selectedSegments[0])?.applied_code_details
                        : undefined
                    }
                    activeCoderId={user?.id ?? null}
                    codes={codes}
                    history={history}
                    onSettled={(saved) => {
                      if (saved) showSaved()
                      queryClient.invalidateQueries({ queryKey: ['segments', cid] })
                    }}
                    groupSiblings={
                      // #1070 — the group a choice fans out to, so its undo can give
                      // each member back its own value.
                      selectedSegments.length === 1
                        ? groupScope(selectedSegments[0]).slice(1).map((id) => ({
                          segmentId: id,
                          appliedCodeDetails: allSegmentsMap.get(id)?.applied_code_details,
                        }))
                        : undefined
                    }
                  />
                }
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
            className={panelStates.notes.collapsed ? '' : `flex-1 ${PANEL_EXPANDED}`}
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
            className={panelStates.memos.collapsed ? '' : `flex-1 ${PANEL_EXPANDED}`}
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
        )}
      </div>


      {/* Status bar */}
      <div className="px-4 py-1.5 border-t bg-mm-surface text-xs text-muted-foreground flex items-center gap-4 shrink-0">
        <span>Conversation</span>
        {selectedSegments.length > 0 && <span>{selectedSegments.length} selected</span>}
        <div className="flex-1" />
        <span className="opacity-60">{codeKeyHint(codes)} · s: quote · c: create code · n: note · r: rate · j: next uncoded · g: group · Ctrl+Z/Y: undo/redo</span>
      </div>

      {/* Floating create code dialog */}
      {createCodeDialog && (
        <FloatingCreateCode
          categoriesLoad={categoriesLoad}
          position={createCodeDialog.position}
          projectId={pid}
          initialName={createCodeDialog.initialName}
          categories={categories}
          onCreated={async (code) => {
            const segmentIds = createCodeDialog.segmentIds
            setCreateCodeDialog(null)

            if (segmentIds.length === 0) return

            // Apply the new code to all selected segments in one undo entry
            history.execute({
              type: 'code_apply',
              description: `Apply code "${code.name}" to ${segmentIds.length} segment(s)`,
              // #678: this path already refetches, so nothing goes stale — but the
              // success toast below names every selected segment, so a silently
              // skipped id would still be reported as coded. Warn on the shortfall.
              redo: async () => {
                if (segmentIds.length === 1) {
                  await codingApi.applyCode(segmentIds[0], code.id)
                } else {
                  const outcome = collectBulkOutcome(await codingApi.bulkCode(segmentIds, code.id, 'apply'))
                  if (outcome.hasFailures) toast.warning(describeBulkFailure(outcome, 'segment', 'apply'))
                }
                invalidateAfterCodeChange()
              },
              undo: async () => {
                if (segmentIds.length === 1) {
                  await codingApi.removeCode(segmentIds[0], code.id)
                } else {
                  const outcome = collectBulkOutcome(await codingApi.bulkCode(segmentIds, code.id, 'remove'))
                  if (outcome.hasFailures) toast.warning(describeBulkFailure(outcome, 'segment', 'remove'))
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

