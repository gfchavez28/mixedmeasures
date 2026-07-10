import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileInput, Check, ChevronRight, ChevronDown, CircleAlert, X, FileText, Video, Volume2, LoaderCircle, CircleCheck, CircleX, Ban, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { conversationsApi, participantsApi, mediaApi, type Participant } from '@/lib/api'
import { validateMediaFile, MEDIA_ACCEPT, MEDIA_FORMAT_LABEL, describeMediaUploadError, isVideoFilename } from '@/lib/media-constants'
import { formatBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { cn, getContrastColor, hexToRowBg } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { ColorDotButton } from '@/components/ColorDotButton'
import { consumePendingImportFiles } from '@/lib/pending-import-files'
import {
  type PreviewData,
  type SpeakerMapping,
  COLUMN_COLORS,
  SPEAKER_COUNT_WARNING_THRESHOLD,
  getSpeakerColorClass,
  getSpeakerInitials,
  getInitialsBadgeColors,
  extractSpeakerMappings,
  isOrphanedParticipant,
  syncAutoNames,
} from '@/lib/conversation-import-utils'

type Step = 'upload' | 'columns' | 'speakers' | 'importing' | 'results'

interface ImportResult {
  fileName: string
  conversationName: string
  status: 'success' | 'error' | 'cancelled'
  conversationId?: number
  segmentCount?: number
  error?: string
  /** #356: import-time warnings (e.g. backward timestamps). Per-file, shown
   * as an amber card under the per-file success line in the results step. */
  warnings?: string[]
}

const MAX_FILES = 50

export default function ConversationImport() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const id = parseInt(projectId || '0')

  const [step, setStep] = useState<Step>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  // Slab 1: an optional recording to attach after a single-file transcript
  // import (uploaded in Slab 2). Kept even in multi-file mode (D-1), but only
  // uploaded when exactly one transcript is present.
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const recFileInputRef = useRef<HTMLInputElement>(null)
  // Slab 2: single-file import → media-attach phase (progress + partial-failure).
  const [attach, setAttach] = useState<{
    conversationId: number
    conversationName: string
    segmentCount: number | undefined
    fileName: string
    mediaName: string
    status: 'attaching' | 'failed'
    error?: string
    /** #356/#543: import-time warnings, carried so the failed-attach card and
     * the retry-success path can still route through the warnings display. */
    warnings?: string[]
  } | null>(null)

  // #543: attaches legitimately run minutes-to-hours, and react-router keeps
  // `navigate` live after unmount — a stale success must never yank the user
  // back, and a stale failure must fall back to a toast instead of silence.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true // StrictMode re-runs effects: reset after the dev-only unmount
    return () => { mountedRef.current = false }
  }, [])

  // First file's preview (used for column mapping UI)
  const [firstPreview, setFirstPreview] = useState<PreviewData | null>(null)

  // Shared column mapping (applies to all files)
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({})

  // Per-file state (indexed by file position)
  const [filePreviews, setFilePreviews] = useState<(PreviewData | null)[]>([])
  const [fileSpeakerMappings, setFileSpeakerMappings] = useState<SpeakerMapping[][]>([])
  const [fileConversationNames, setFileConversationNames] = useState<string[]>([])
  const [columnWarnings, setColumnWarnings] = useState<(string | null)[]>([])

  // Accordion state for speaker step
  const [expandedFileIndex, setExpandedFileIndex] = useState<number>(0)

  // Import progress
  const [importProgress, setImportProgress] = useState<{
    current: number
    results: ImportResult[]
  }>({ current: 0, results: [] })
  const cancelledRef = useRef(false)

  // Track whether user manually edited conversation names (per file index)
  const userEditedNames = useRef<Set<number>>(new Set())

  // Fetch existing conversations and participants
  const { data: existingConversations } = useQuery({
    queryKey: ['conversations', id],
    queryFn: () => conversationsApi.list(id),
    enabled: !!id,
  })

  const { data: existingParticipants } = useQuery({
    queryKey: ['participants', id],
    queryFn: () => participantsApi.list(id),
    enabled: !!id,
  })

  const isMultiFile = files.length > 1
  const recIsVideo = !!mediaFile && isVideoFilename(mediaFile.name)

  // Pick up files staged by drag-drop on ProjectView empty tab
  useEffect(() => {
    const pending = consumePendingImportFiles('conversation')
    if (pending) handleFilesSelected(pending)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Build a lookup of existing participant names for collision detection
  const participantsByName = useMemo(() => {
    const map = new Map<string, Participant>()
    for (const p of existingParticipants?.participants || []) {
      const name = (p.display_name || p.identifier).toLowerCase()
      if (!map.has(name)) map.set(name, p)
    }
    return map
  }, [existingParticipants])

  // Existing conversation names for duplicate detection
  const existingConvNames = useMemo(
    () => existingConversations?.conversations?.map(c => c.name) || [],
    [existingConversations]
  )

  // Build reverse mapping: column name -> mapping type
  const columnToType = useMemo(() => {
    const map: Record<string, string> = {}
    Object.entries(columnMapping).forEach(([type, col]) => {
      if (col) map[col] = type
    })
    return map
  }, [columnMapping])

  // Check for duplicate conversation names (against existing + within batch)
  const nameDuplicates = useMemo(() => {
    const allExisting = existingConvNames.map(n => n.toLowerCase())
    const result: Record<number, string> = {} // index -> reason
    const batchNames = fileConversationNames.map(n => n.trim().toLowerCase())

    for (let i = 0; i < batchNames.length; i++) {
      const name = batchNames[i]
      if (!name) continue
      if (allExisting.includes(name)) {
        result[i] = 'A conversation with this name already exists'
      } else {
        // Check within batch (earlier entries take priority)
        for (let j = 0; j < i; j++) {
          if (batchNames[j] === name) {
            result[i] = 'Duplicate name within this import batch'
            break
          }
        }
      }
    }
    return result
  }, [fileConversationNames, existingConvNames])

  // Per-file speaker validation
  const fileSpeakerValidation = useMemo(() => {
    return fileSpeakerMappings.map(mappings => {
      if (mappings.length === 0) return { valid: true, error: '' }
      // Facilitator is optional (e.g. interviews, oral arguments, dyadic
      // conversations have no facilitator). Only require at least one
      // non-facilitator speaker — an all-facilitator mapping is still blocked.
      const hasNonFac = mappings.some(m => !m.is_facilitator)
      if (!hasNonFac) return { valid: false, error: 'You must have at least one participant (non-facilitator).' }
      return { valid: true, error: '' }
    })
  }, [fileSpeakerMappings])

  // Can proceed from speakers step?
  const speakersStepValid = useMemo(() => {
    // All files need valid speakers
    const allSpeakersValid = fileSpeakerValidation.every(v => v.valid)
    // All files need non-empty, non-duplicate names
    const allNamesValid = fileConversationNames.every((n, i) => n.trim() && !nameDuplicates[i])
    return allSpeakersValid && allNamesValid
  }, [fileSpeakerValidation, fileConversationNames, nameDuplicates])

  // #410: participant-derived auto-names update the VISIBLE name field live on
  // the Speakers step (for files the user hasn't manually edited), instead of
  // silently overriding the displayed name at submit time. The field always
  // shows exactly the name that will be imported; the field wins.
  useEffect(() => {
    if (step !== 'speakers') return
    setFileConversationNames(prev =>
      syncAutoNames(prev, fileSpeakerMappings, existingConvNames, userEditedNames.current)
    )
  }, [step, fileSpeakerMappings, existingConvNames])

  // Detect speakers with matching normalized names across files (multi-file only)
  const sharedSpeakers = useMemo(() => {
    if (files.length <= 1) return []
    // Map: lowercase name -> { displayName, fileCount }
    const nameToFiles = new Map<string, { displayName: string; fileIndices: Set<number> }>()
    for (let i = 0; i < fileSpeakerMappings.length; i++) {
      for (const m of fileSpeakerMappings[i] || []) {
        const key = m.normalized_name.trim().toLowerCase()
        if (!key) continue
        const existing = nameToFiles.get(key)
        if (existing) {
          existing.fileIndices.add(i)
        } else {
          nameToFiles.set(key, { displayName: m.normalized_name.trim(), fileIndices: new Set([i]) })
        }
      }
    }
    return Array.from(nameToFiles.values())
      .filter(entry => entry.fileIndices.size > 1)
      .map(entry => ({ name: entry.displayName, fileCount: entry.fileIndices.size, fileIndices: [...entry.fileIndices] }))
  }, [files.length, fileSpeakerMappings])

  // Shared speaker lookup: lowercase name -> file indices
  const sharedSpeakerMap = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const s of sharedSpeakers) {
      map.set(s.name.toLowerCase(), s.fileIndices)
    }
    return map
  }, [sharedSpeakers])

  // Pending facilitator change for shared-speaker dialog
  const [pendingFacChange, setPendingFacChange] = useState<{
    speakerName: string
    fileIndex: number
    newValue: boolean
    sharedFileIndices: number[]
  } | null>(null)

  // --- File handling ---

  const previewFile = useCallback(async (file: File): Promise<PreviewData> => {
    return conversationsApi.preview(id, file)
  }, [id])

  const handleFilesSelected = useCallback(async (selectedFiles: File[]) => {
    setError('')

    // Transcript formats: CSV + VTT/SRT subtitles (#524 — Zoom/Teams exports)
    const csvFiles = selectedFiles.filter(f => /\.(csv|vtt|srt)$/.test(f.name.toLowerCase()))
    if (csvFiles.length === 0) return

    // Enforce max
    const newFiles = [...files, ...csvFiles].slice(0, MAX_FILES)
    const addedCount = newFiles.length - files.length
    if (addedCount < csvFiles.length) {
      setError(`File limit is ${MAX_FILES}. Only ${addedCount} file(s) added.`)
    }

    setFiles(newFiles)

    // Extend per-file state for newly added files
    for (let i = files.length; i < newFiles.length; i++) {
      setFilePreviews(prev => [...prev, null])
      setFileSpeakerMappings(prev => [...prev, []])
      setFileConversationNames(prev => [...prev, newFiles[i].name.replace(/\.[^/.]+$/, '')])
      setColumnWarnings(prev => [...prev, null])
    }
  }, [files])

  const handleRemoveFile = useCallback((index: number) => {
    const newFiles = files.filter((_, i) => i !== index)
    setFiles(newFiles)
    setFilePreviews(prev => prev.filter((_, i) => i !== index))
    setFileSpeakerMappings(prev => prev.filter((_, i) => i !== index))
    setFileConversationNames(prev => prev.filter((_, i) => i !== index))
    setColumnWarnings(prev => prev.filter((_, i) => i !== index))
    userEditedNames.current = new Set(
      [...userEditedNames.current]
        .filter(i2 => i2 !== index)
        .map(i2 => i2 > index ? i2 - 1 : i2)
    )

    // If we removed the first file and we're past upload, re-preview the new first
    if (index === 0 && newFiles.length > 0 && firstPreview) {
      setIsLoading(true)
      previewFile(newFiles[0])
        .then(result => {
          setFirstPreview(result)
          setColumnMapping(result.detected_columns)
          const speakerCol = result.detected_columns.speaker
          setFilePreviews(prev => {
            const copy = [...prev]
            copy[0] = result
            return copy
          })
          setFileSpeakerMappings(prev => {
            const copy = [...prev]
            copy[0] = extractSpeakerMappings(result, speakerCol)
            return copy
          })
        })
        .catch(() => setError('Failed to preview replacement file'))
        .finally(() => setIsLoading(false))
    }

    if (newFiles.length === 0) {
      setStep('upload')
      setFirstPreview(null)
      setColumnMapping({})
    }
  }, [files, previewFile, firstPreview])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const droppedFiles = Array.from(e.dataTransfer.files)
      handleFilesSelected(droppedFiles)
    },
    [handleFilesSelected]
  )

  // --- Recording (optional media) staging (Slab 1) ---

  const stageRecording = useCallback((file: File | undefined | null) => {
    if (!file) return
    const validation = validateMediaFile(file)
    if (!validation.ok) {
      setRecordingError(validation.error)
      setMediaFile(null)
      return
    }
    setRecordingError(null)
    setMediaFile(file)
  }, [])

  const handleRecordingSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-picked
    stageRecording(file)
  }, [stageRecording])

  const handleRecordingDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    stageRecording(e.dataTransfer.files?.[0])
  }, [stageRecording])

  // --- Column mapping ---

  const handleColumnMappingChange = useCallback((type: string, value: string) => {
    const colName = value === '__none__' ? '' : value

    const newMapping = { ...columnMapping }
    if (colName) {
      Object.keys(newMapping).forEach(key => {
        if (key !== type && newMapping[key] === colName) {
          newMapping[key] = ''
        }
      })
    }
    newMapping[type] = colName
    setColumnMapping(newMapping)

    // If speaker column changed on first file, update its speaker mappings
    if (type === 'speaker' && firstPreview) {
      if (colName) {
        setFileSpeakerMappings(prev => {
          const copy = [...prev]
          copy[0] = extractSpeakerMappings(firstPreview, colName)
          return copy
        })
      } else {
        setFileSpeakerMappings(prev => {
          const copy = [...prev]
          copy[0] = []
          return copy
        })
      }
    }
  }, [columnMapping, firstPreview])

  // Preview remaining files and check column compatibility
  const handleColumnsNext = useCallback(async () => {
    if (files.length <= 1) {
      setStep('speakers')
      return
    }

    setIsLoading(true)
    setError('')

    const speakerCol = columnMapping.speaker
    const textCol = columnMapping.text

    // Preview files in batches of 5
    const CONCURRENCY = 5
    const newPreviews = [...filePreviews]
    const newMappings = [...fileSpeakerMappings]
    const newWarnings = [...columnWarnings]
    const errors: string[] = []

    for (let batchStart = 1; batchStart < files.length; batchStart += CONCURRENCY) {
      const batchEnd = Math.min(batchStart + CONCURRENCY, files.length)
      const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

      const results = await Promise.allSettled(
        batchIndices.map(i => previewFile(files[i]))
      )

      results.forEach((result, batchIdx) => {
        const fileIdx = batchIndices[batchIdx]
        if (result.status === 'fulfilled') {
          const preview = result.value
          newPreviews[fileIdx] = preview

          // Check column compatibility
          const missingRequired: string[] = []
          if (speakerCol && !preview.headers.includes(speakerCol)) missingRequired.push(`Speaker ("${speakerCol}")`)
          if (textCol && !preview.headers.includes(textCol)) missingRequired.push(`Text ("${textCol}")`)

          if (missingRequired.length > 0) {
            newWarnings[fileIdx] = `Missing required columns: ${missingRequired.join(', ')}`
            errors.push(`${files[fileIdx].name}: missing ${missingRequired.join(', ')}`)
          } else {
            newWarnings[fileIdx] = null
            // Extract speakers
            newMappings[fileIdx] = extractSpeakerMappings(preview, speakerCol)
          }

          // Check optional columns
          const missingOptional: string[] = []
          if (columnMapping.start_time && !preview.headers.includes(columnMapping.start_time)) missingOptional.push('Start Time')
          if (columnMapping.end_time && !preview.headers.includes(columnMapping.end_time)) missingOptional.push('End Time')
          if (missingOptional.length > 0 && !newWarnings[fileIdx]) {
            newWarnings[fileIdx] = `Optional columns missing: ${missingOptional.join(', ')} (will be skipped)`
          }
        } else {
          newPreviews[fileIdx] = null
          const errMsg = result.reason instanceof Error ? result.reason.message : 'Failed to parse'
          newWarnings[fileIdx] = `Error: ${errMsg}`
          errors.push(`${files[fileIdx].name}: ${errMsg}`)
        }
      })
    }

    setFilePreviews(newPreviews)
    setFileSpeakerMappings(newMappings)
    setColumnWarnings(newWarnings)
    setIsLoading(false)

    // Block if any file has missing required columns
    const hasBlockingErrors = newWarnings.some((w, i) => i > 0 && w && w.startsWith('Missing required'))
    if (hasBlockingErrors) {
      setError(`Some files are incompatible with the selected column mapping. Remove them or adjust your mapping.`)
      return
    }

    setStep('speakers')
  }, [files, filePreviews, fileSpeakerMappings, columnWarnings, columnMapping, previewFile])

  // --- Speaker step continue ---

  const handleSpeakersContinue = useCallback(() => {
    const finalMappings = [...fileSpeakerMappings]
    // #410: the visible name field wins — auto-naming happens live on the
    // Speakers step (effect above), never as a post-submission override.
    const newNames = [...fileConversationNames]

    if (files.length === 1) {
      // Single file: import directly
      handleSingleImport(newNames[0], finalMappings[0])
    } else {
      setStep('importing')
      handleBatchImport(newNames, finalMappings)
    }
  }, [fileSpeakerMappings, files, fileConversationNames]) // eslint-disable-line react-hooks/exhaustive-deps -- handleBatchImport/handleSingleImport defined below; adding would cause TDZ error

  // --- Import ---

  const handleSingleImport = useCallback(async (name: string, speakers: SpeakerMapping[]) => {
    setIsLoading(true)
    setError('')
    try {
      const result = await conversationsApi.import(id, files[0], {
        name,
        column_mapping: columnMapping,
        speaker_mappings: speakers,
      })
      const { conversation, warnings } = result
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      queryClient.invalidateQueries({ queryKey: ['conversations', id] })
      queryClient.invalidateQueries({ queryKey: ['participants', id] })

      const finishTranscriptOnly = () => {
        if (!mountedRef.current) {
          // #543: the user left the wizard while this finished — never navigate
          // them from wherever they are now. Surface the outcome (and any
          // warnings, which have no post-hoc home) as a toast instead.
          toast.success(
            `Transcript "${name}" imported`,
            warnings && warnings.length > 0 ? { description: warnings.join(' · '), duration: 10_000 } : undefined,
          )
          return
        }
        // #356: if import surfaced warnings, route through the results step so
        // the researcher sees them before navigating. Silent success otherwise.
        if (warnings && warnings.length > 0) {
          setImportProgress({
            current: 1,
            results: [{
              fileName: files[0].name,
              conversationName: name,
              status: 'success',
              conversationId: conversation.id,
              segmentCount: conversation.segment_count,
              warnings,
            }],
          })
          setStep('results')
          setIsLoading(false)
        } else {
          navigate(`/projects/${id}/conversations/${conversation.id}`)
        }
      }

      // A staged recording (single-file only) → attach it to the just-created
      // conversation, then land in the workbench (the video pane confirms it).
      // The transcript import already committed, so a media failure NEVER loses
      // it (D-5): we surface a retryable results card instead of erroring out.
      if (mediaFile) {
        setAttach({
          conversationId: conversation.id,
          conversationName: name,
          segmentCount: conversation.segment_count,
          fileName: files[0].name,
          mediaName: mediaFile.name,
          status: 'attaching',
          warnings,
        })
        setStep('importing')
        setIsLoading(false)
        try {
          await mediaApi.upload(id, conversation.id, mediaFile)
          // #543(c): the pre-attach invalidation above cached has_media=false —
          // refresh the list + workbench detail now that the recording exists.
          queryClient.invalidateQueries({ queryKey: ['conversations', id] })
          queryClient.invalidateQueries({ queryKey: ['conversation', id, conversation.id] })
          if (!mountedRef.current) {
            toast.success(`Recording attached to "${name}"`)
            return
          }
          setAttach(null)
          finishTranscriptOnly() // navigates (or shows warnings) now that media is attached
        } catch (mediaErr: unknown) {
          const reason = describeMediaUploadError(mediaErr)
          if (!mountedRef.current) {
            // #543(a): the retry card is unreachable once the page is gone — a
            // toast is the only way this failure isn't silent. Most reasons
            // already end with a "…from the workbench" pointer — don't double it.
            toast.error(`Recording not attached to "${name}"`, {
              description: /workbench/i.test(reason) ? reason : `${reason} You can add it any time from the workbench.`,
              duration: 15_000,
            })
            return
          }
          setAttach(prev => prev && {
            ...prev,
            status: 'failed',
            error: reason,
          })
          setStep('results')
        }
        return
      }

      finishTranscriptOnly()
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Import failed'
      setError(errorMessage)
      setIsLoading(false)
    }
  }, [files, id, columnMapping, queryClient, navigate, mediaFile])

  // Retry a failed recording attach against the already-created conversation.
  const handleRetryAttach = useCallback(async () => {
    if (!attach || !mediaFile) return
    setAttach({ ...attach, status: 'attaching', error: undefined })
    setStep('importing')
    try {
      await mediaApi.upload(id, attach.conversationId, mediaFile)
      queryClient.invalidateQueries({ queryKey: ['conversations', id] })
      queryClient.invalidateQueries({ queryKey: ['conversation', id, attach.conversationId] })
      if (!mountedRef.current) {
        toast.success(`Recording attached to "${attach.conversationName}"`)
        return
      }
      // #356/#543(b): a retried attach must still show the import warnings —
      // navigating directly here was the corner that dropped them.
      if (attach.warnings && attach.warnings.length > 0) {
        setImportProgress({
          current: 1,
          results: [{
            fileName: attach.fileName,
            conversationName: attach.conversationName,
            status: 'success',
            conversationId: attach.conversationId,
            segmentCount: attach.segmentCount,
            warnings: attach.warnings,
          }],
        })
        setAttach(null)
        setStep('results')
      } else {
        navigate(`/projects/${id}/conversations/${attach.conversationId}`)
      }
    } catch (mediaErr: unknown) {
      const reason = describeMediaUploadError(mediaErr)
      if (!mountedRef.current) {
        toast.error(`Recording not attached to "${attach.conversationName}"`, {
          description: /workbench/i.test(reason) ? reason : `${reason} You can add it any time from the workbench.`,
          duration: 15_000,
        })
        return
      }
      setAttach(prev => prev && {
        ...prev,
        status: 'failed',
        error: reason,
      })
      setStep('results')
    }
  }, [attach, mediaFile, id, navigate, queryClient])

  const handleBatchImport = useCallback(async (names: string[], speakerSets: SpeakerMapping[][]) => {
    cancelledRef.current = false
    setImportProgress({ current: 0, results: [] })

    const results: ImportResult[] = []

    for (let i = 0; i < files.length; i++) {
      if (cancelledRef.current) {
        results.push({
          fileName: files[i].name,
          conversationName: names[i],
          status: 'cancelled',
        })
        continue
      }

      setImportProgress({ current: i + 1, results: [...results] })

      try {
        const result = await conversationsApi.import(id, files[i], {
          name: names[i],
          column_mapping: columnMapping,
          speaker_mappings: speakerSets[i],
        })
        const { conversation, warnings } = result
        results.push({
          fileName: files[i].name,
          conversationName: names[i],
          status: 'success',
          conversationId: conversation.id,
          segmentCount: conversation.segment_count,
          warnings: warnings && warnings.length > 0 ? warnings : undefined,
        })
      } catch (err: unknown) {
        results.push({
          fileName: files[i].name,
          conversationName: names[i],
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    setImportProgress({ current: files.length, results })

    // Invalidate queries
    queryClient.invalidateQueries({ queryKey: ['project', id] })
    queryClient.invalidateQueries({ queryKey: ['conversations', id] })
    queryClient.invalidateQueries({ queryKey: ['participants', id] })

    setStep('results')
  }, [files, id, columnMapping, queryClient])

  // --- Facilitator propagation handlers ---

  const applyFacilitatorToAll = useCallback(() => {
    if (!pendingFacChange) return
    const { speakerName, newValue, sharedFileIndices } = pendingFacChange
    const nameKey = speakerName.toLowerCase()
    setFileSpeakerMappings(prev => {
      const copy = [...prev]
      for (const fi of sharedFileIndices) {
        copy[fi] = (copy[fi] || []).map(m =>
          m.normalized_name.trim().toLowerCase() === nameKey
            ? { ...m, is_facilitator: newValue }
            : m
        )
      }
      return copy
    })
    setPendingFacChange(null)
  }, [pendingFacChange])

  const applyFacilitatorToOne = useCallback(() => {
    if (!pendingFacChange) return
    const { speakerName, fileIndex, newValue } = pendingFacChange
    const nameKey = speakerName.toLowerCase()
    setFileSpeakerMappings(prev => {
      const copy = [...prev]
      copy[fileIndex] = (copy[fileIndex] || []).map(m =>
        m.normalized_name.trim().toLowerCase() === nameKey
          ? { ...m, is_facilitator: newValue }
          : m
      )
      return copy
    })
    setPendingFacChange(null)
  }, [pendingFacChange])

  // --- Shared speaker color propagation (Issue 207) ---
  const handleSharedColorChange = useCallback((speakerName: string, color: string | null) => {
    const nameKey = speakerName.trim().toLowerCase()
    const sharedIndices = sharedSpeakerMap.get(nameKey)
    if (sharedIndices && sharedIndices.length > 1) {
      // Sync color to all files containing this speaker
      setFileSpeakerMappings(prev => {
        const copy = [...prev]
        for (const fi of sharedIndices) {
          copy[fi] = (copy[fi] || []).map(m =>
            m.normalized_name.trim().toLowerCase() === nameKey
              ? { ...m, color: color ?? undefined }
              : m
          )
        }
        return copy
      })
    }
  }, [sharedSpeakerMap])

  const handleReset = useCallback(() => {
    setStep('upload')
    setFiles([])
    setFirstPreview(null)
    setColumnMapping({})
    setFilePreviews([])
    setFileSpeakerMappings([])
    setFileConversationNames([])
    setColumnWarnings([])
    setExpandedFileIndex(0)
    setImportProgress({ current: 0, results: [] })
    setError('')
    setMediaFile(null)
    setRecordingError(null)
    cancelledRef.current = false
    userEditedNames.current = new Set()
  }, [])

  // --- Step indicators ---

  // A single-file import with a staged recording gains an "Import" step (the
  // attach-progress screen); "Results" stays multi-file-only (single-file only
  // lands there on media failure — a rare branch, not an always-reached step).
  const willAttachRecording = !isMultiFile && !!mediaFile
  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'columns', label: 'Columns' },
    { key: 'speakers', label: 'Speakers' },
    ...((isMultiFile || willAttachRecording) ? [{ key: 'importing' as Step, label: 'Import' }] : []),
    ...(isMultiFile ? [{ key: 'results' as Step, label: 'Results' }] : []),
  ]

  const stepIndex = steps.findIndex(s => s.key === step)

  // --- Render helpers ---

  const renderSpeakerList = (
    mappings: SpeakerMapping[],
    fileIndex: number,
    onChange: (updated: SpeakerMapping[]) => void,
    onFacilitatorToggle?: (speakerIndex: number, newValue: boolean) => void,
    onSharedColorChange?: (speakerName: string, color: string | null) => void
  ) => (
    <div className="space-y-3 max-h-96 overflow-y-auto">
      {mappings.length > SPEAKER_COUNT_WARNING_THRESHOLD && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 rounded-lg flex items-start gap-2 text-sm">
          <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Large number of speakers detected ({mappings.length})</p>
            <p className="mt-1">
              This column has many unique values. Please verify you selected the correct Speaker Column.
            </p>
          </div>
        </div>
      )}
      {mappings.map((mapping, i) => (
        <div
          key={`${fileIndex}-${mapping.original_label}`}
          className={cn(
            'p-3 border rounded-lg transition-colors space-y-2',
            mapping.color ? 'border-l-4' : getSpeakerColorClass(mapping.color_index, mapping.is_facilitator)
          )}
          style={mapping.color ? { borderLeftColor: mapping.color, backgroundColor: hexToRowBg(mapping.color, false) } : undefined}
        >
          <div className="flex items-center gap-4">
            <div
              className={cn(
                'w-8 h-8 rounded-full text-sm font-semibold flex items-center justify-center ring-1 flex-shrink-0',
                mapping.color ? 'ring-black/10 dark:ring-white/20' : getInitialsBadgeColors(mapping.is_facilitator)
              )}
              style={mapping.color ? { backgroundColor: mapping.color, color: getContrastColor(mapping.color) } : undefined}
              title="Speaker initials preview"
            >
              {getSpeakerInitials(mapping.normalized_name)}
            </div>
            <div className="flex-1">
              <Label className="text-xs text-mm-text-muted mb-1 block">
                Original: {mapping.original_label}
              </Label>
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-sm font-medium w-24 flex-shrink-0',
                  mapping.is_facilitator ? 'text-mm-text' : 'text-amber-700 dark:text-amber-400'
                )}>
                  {mapping.is_facilitator ? 'Facilitator:' : 'Participant:'}
                </span>
                <Input
                  value={mapping.normalized_name}
                  onChange={(e) => {
                    const updated = [...mappings]
                    updated[i] = { ...updated[i], normalized_name: e.target.value }
                    onChange(updated)
                  }}
                  placeholder={mapping.is_facilitator ? "Facilitator name" : "Participant name"}
                  className="flex-1 bg-mm-surface"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <ColorDotButton
                    color={mapping.color || 'transparent'}
                    dotClassName="w-5 h-5 rounded-full border-2 border-mm-border-medium"
                    title="Set speaker color"
                    aria-label="Set speaker color"
                  />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3" align="end">
                  <ColorSwatchPicker
                    value={mapping.color || ''}
                    onChange={(color) => {
                      const updated = [...mappings]
                      updated[i] = { ...updated[i], color }
                      onChange(updated)
                      onSharedColorChange?.(mapping.normalized_name, color)
                    }}
                  />
                  {mapping.color && (
                    <button
                      className="mt-2 text-xs text-mm-text-muted hover:text-mm-text w-full text-center"
                      onClick={() => {
                        const updated = [...mappings]
                        updated[i] = { ...updated[i], color: undefined }
                        onChange(updated)
                        onSharedColorChange?.(mapping.normalized_name, null)
                      }}
                    >
                      Reset to default
                    </button>
                  )}
                </PopoverContent>
              </Popover>
              <Checkbox
                id={`facilitator-${fileIndex}-${i}`}
                checked={mapping.is_facilitator}
                onCheckedChange={(checked) => {
                  if (onFacilitatorToggle) {
                    onFacilitatorToggle(i, !!checked)
                  } else {
                    const updated = [...mappings]
                    updated[i] = { ...updated[i], is_facilitator: !!checked }
                    onChange(updated)
                  }
                }}
              />
              <Label htmlFor={`facilitator-${fileIndex}-${i}`} className="text-sm">
                Facilitator
              </Label>
            </div>
          </div>
          {/* Name collision warning */}
          {!mapping.is_facilitator && (() => {
            const match = participantsByName.get(mapping.normalized_name.trim().toLowerCase())
            if (!match) return null
            const orphaned = isOrphanedParticipant(match)
            const sources = [
              ...new Set(match.linked_speakers.flatMap(s => s.conversations.map(c => c.name))),
              ...new Set(match.dataset_rows.map(d => d.dataset_name)),
            ]
            const matchName = match.display_name || match.identifier
            return (
              <div className={`flex items-center gap-2 ml-12 p-2 border rounded text-sm ${
                orphaned
                  ? 'bg-mm-surface-hover border-mm-border-subtle text-mm-text-secondary'
                  : 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
              }`}>
                <CircleAlert className="w-4 h-4 flex-shrink-0" />
                <span>
                  {orphaned ? (
                    <>
                      Matches an orphaned participant "<strong>{matchName}</strong>" — left over
                      from a deleted conversation or dataset (no live data). It will be reused;
                      rename above if this is a different person.
                    </>
                  ) : (
                    <>
                      Matches existing participant "<strong>{matchName}</strong>"
                      {sources.length > 0 && <> (in {sources.join(', ')})</>}
                      . If this is a different person, rename above.
                    </>
                  )}
                </span>
              </div>
            )
          })()}
        </div>
      ))}
    </div>
  )

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-4 py-6">
        {/* Progress Steps */}
        <nav aria-label="Import progress" className="flex items-center justify-between mb-8">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center" aria-current={stepIndex === i ? 'step' : undefined}>
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
                  stepIndex === i
                    ? 'bg-primary text-white'
                    : stepIndex > i
                    ? 'bg-primary/15 text-primary'
                    : 'bg-mm-border-subtle text-mm-text-secondary'
                )}
              >
                {stepIndex > i ? (
                  <Check className="w-4 h-4" />
                ) : (
                  i + 1
                )}
              </div>
              <span className="ml-2 text-sm font-medium">{s.label}</span>
              {i < steps.length - 1 && (
                <ChevronRight className="w-4 h-4 mx-4 text-mm-text-faint" />
              )}
            </div>
          ))}
        </nav>

        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded-lg flex items-start gap-2">
            <CircleAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <Card>
            <CardHeader>
              <CardTitle>Upload Transcripts</CardTitle>
              <CardDescription>
                Upload transcript CSVs, or VTT/SRT subtitle files exported from Zoom or Teams.
                Multiple files will share the same column mapping.
                {/* Video V1 slab 6 (§15.3): Zoom LOCAL recordings produce no
                    transcript — point that gap at free offline transcription
                    (aTrain et al. export SRT) instead of dead-ending. */}
                <br />
                Have a recording but no transcript? Free offline tools like aTrain
                export SRT files you can import here — speakers can be assigned
                after import.
                {/* #412: the most common real-world transcript is a Word/PDF file —
                    point that path at Documents instead of dead-ending here. */}
                <br />
                Have a Word or PDF transcript? Import it under{' '}
                <Link
                  to={`/projects/${projectId}/documents/import`}
                  className="underline underline-offset-2 hover:text-mm-text"
                >
                  Documents
                </Link>{' '}
                instead.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="border-2 border-dashed rounded-lg p-12 text-center hover:border-primary/50 transition-colors"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                role="button"
                tabIndex={0}
                aria-label="Drop zone for file upload, or press Enter to select files"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('file-input')?.click() } }}
              >
                <FileInput className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
                <p className="text-mm-text-secondary mb-4">
                  Drag and drop transcript file(s) here, or click to browse
                </p>
                <input
                  type="file"
                  accept=".csv,.vtt,.srt"
                  multiple
                  onChange={(e) => {
                    const selected = e.target.files
                    if (selected && selected.length > 0) {
                      handleFilesSelected(Array.from(selected))
                    }
                    // Reset input so same files can be re-selected
                    e.target.value = ''
                  }}
                  className="hidden"
                  id="file-input"
                />
                <label htmlFor="file-input">
                  <Button asChild disabled={isLoading}>
                    <span>{isLoading ? 'Processing...' : 'Select Files'}</span>
                  </Button>
                </label>
              </div>

              {/* Recording (optional) — attached after a single-file import (Slab 2).
                  Visible from the start (D-2) so the affordance is discoverable, but
                  the transcript is still required to proceed. */}
              <div className="mt-6">
                <div className="flex items-center gap-2 mb-2">
                  <Video className="w-4 h-4 text-primary" aria-hidden />
                  <span className="text-sm font-semibold text-mm-text">Recording</span>
                  <span className="text-xs font-medium text-mm-text-faint">(optional)</span>
                </div>

                {isMultiFile ? (
                  <div className="p-3 bg-mm-blue/12 text-mm-blue-text rounded-lg text-sm flex items-start gap-2">
                    <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
                    <span>
                      Recordings attach to single-transcript imports. Remove the extra file to add one.
                      {mediaFile ? ' Your selected recording is kept.' : ''}
                    </span>
                  </div>
                ) : mediaFile ? (
                  <div className="flex items-center gap-3 p-3 rounded-lg border border-primary/30 bg-primary/5 text-sm">
                    {recIsVideo ? (
                      <Video className="w-4 h-4 text-primary flex-shrink-0" aria-hidden />
                    ) : (
                      <Volume2 className="w-4 h-4 text-primary flex-shrink-0" aria-hidden />
                    )}
                    <span className="flex-1 truncate font-medium">{mediaFile.name}</span>
                    <span className="text-xs text-mm-text-faint flex-shrink-0">
                      {formatBytes(mediaFile.size)} · {recIsVideo ? 'video' : 'audio'}
                    </span>
                    <button
                      onClick={() => { setMediaFile(null); setRecordingError(null) }}
                      className="p-1 hover:bg-mm-surface-hover rounded"
                      aria-label="Remove recording"
                    >
                      <X className="w-3.5 h-3.5 text-mm-text-muted" />
                    </button>
                  </div>
                ) : (
                  <div
                    className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 transition-colors"
                    onDrop={handleRecordingDrop}
                    onDragOver={(e) => e.preventDefault()}
                    role="button"
                    tabIndex={0}
                    aria-label="Add a recording, or press Enter to select a file"
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); recFileInputRef.current?.click() } }}
                  >
                    <p className="text-sm text-mm-text-secondary mb-3">
                      Add the audio or video this transcript came from — {MEDIA_FORMAT_LABEL}.
                    </p>
                    <input
                      ref={recFileInputRef}
                      type="file"
                      accept={MEDIA_ACCEPT}
                      className="hidden"
                      id="recording-input"
                      onChange={handleRecordingSelect}
                    />
                    <label htmlFor="recording-input">
                      <Button variant="outline" size="sm" asChild>
                        <span>Select recording</span>
                      </Button>
                    </label>
                  </div>
                )}

                {/* Zoom golden-path hint */}
                {!isMultiFile && !mediaFile && (
                  <p className="mt-2 text-xs text-mm-text-muted">
                    Recording from Zoom? Add the MP4 here and the VTT transcript above — they import together.
                  </p>
                )}

                {/* Recording staged but no transcript yet — point at transcription, don't dead-end */}
                {!isMultiFile && mediaFile && files.length === 0 && (
                  <div role="alert" className="mt-2 p-3 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 rounded-lg text-sm flex items-start gap-2">
                    <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
                    <span>
                      A recording still needs a transcript to code against. Add a transcript above, or export
                      one with a free offline tool like aTrain (SRT) and import it here.
                    </span>
                  </div>
                )}

                {/* Validation error — hidden in multi-file mode, where the slot is
                    disabled and a stale rejection message would sit under the
                    disabled note as if it applied (#543d) */}
                {!isMultiFile && recordingError && (
                  <p role="alert" className="mt-2 text-sm text-red-600 flex items-center gap-1">
                    <CircleAlert className="w-4 h-4" aria-hidden />
                    {recordingError}
                  </p>
                )}
              </div>

              {/* File list */}
              {files.length > 0 && (
                <div className="mt-4 space-y-2">
                  <div className="text-sm font-medium text-mm-text">
                    {files.length} file{files.length !== 1 ? 's' : ''} selected
                  </div>
                  {files.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="flex items-center gap-2 p-2 bg-mm-bg rounded text-sm">
                      <FileText className="w-4 h-4 text-mm-text-faint flex-shrink-0" />
                      <span className="flex-1 truncate">{f.name}</span>
                      <span className="text-mm-text-faint flex-shrink-0">
                        {(f.size / 1024).toFixed(1)} KB
                      </span>
                      <button
                        onClick={() => handleRemoveFile(i)}
                        className="p-1 hover:bg-mm-surface-hover rounded"
                        title="Remove file"
                      >
                        <X className="w-3 h-3 text-mm-text-muted" />
                      </button>
                    </div>
                  ))}

                  {files.length >= MAX_FILES && (
                    <p className="text-sm text-amber-600">Maximum of {MAX_FILES} files reached.</p>
                  )}

                  <div className="flex justify-between items-center pt-2">
                    <label htmlFor="file-input-add" className="cursor-pointer">
                      <input
                        type="file"
                        accept=".csv,.vtt,.srt"
                        multiple
                        onChange={(e) => {
                          const selected = e.target.files
                          if (selected && selected.length > 0) {
                            handleFilesSelected(Array.from(selected))
                          }
                          e.target.value = ''
                        }}
                        className="hidden"
                        id="file-input-add"
                      />
                      <Button variant="outline" size="sm" asChild>
                        <span>Add More Files</span>
                      </Button>
                    </label>
                    <Button
                      onClick={async () => {
                        setIsLoading(true)
                        setError('')
                        try {
                          const result = await previewFile(files[0])
                          setFirstPreview(result)
                          setColumnMapping(result.detected_columns)
                          const speakerCol = result.detected_columns.speaker
                          setFilePreviews(prev => {
                            const copy = [...prev]
                            copy[0] = result
                            return copy
                          })
                          setFileSpeakerMappings(prev => {
                            const copy = [...prev]
                            copy[0] = extractSpeakerMappings(result, speakerCol)
                            return copy
                          })
                          setStep('columns')
                        } catch (err: unknown) {
                          setError(err instanceof Error ? err.message : 'Failed to parse CSV')
                        } finally {
                          setIsLoading(false)
                        }
                      }}
                      disabled={files.length === 0 || isLoading}
                    >
                      {isLoading ? 'Processing...' : 'Next'}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 2: Column Mapping */}
        {step === 'columns' && firstPreview && (
          <Card>
            <CardHeader>
              <CardTitle>Map Columns</CardTitle>
              <CardDescription>
                Specify which columns contain speaker names, text, and timestamps.
                Selected columns are highlighted in the preview below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isMultiFile && (
                <div className="p-3 bg-mm-blue/12 text-mm-blue-text rounded-lg text-sm flex items-center gap-2">
                  <CircleAlert className="w-4 h-4 flex-shrink-0" />
                  This column mapping will apply to all {files.length} files.
                  Files will be checked for compatibility when you continue.
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <span className={cn('px-2 py-0.5 rounded text-xs font-medium', COLUMN_COLORS.speaker.bg, COLUMN_COLORS.speaker.text)}>
                      Speaker Column *
                    </span>
                  </Label>
                  <Select
                    value={columnMapping.speaker || '__none__'}
                    onValueChange={(v) => handleColumnMappingChange('speaker', v)}
                  >
                    <SelectTrigger className={cn(columnMapping.speaker && COLUMN_COLORS.speaker.bg)}>
                      <SelectValue placeholder="Select column" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {firstPreview.headers.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <span className={cn('px-2 py-0.5 rounded text-xs font-medium', COLUMN_COLORS.text.bg, COLUMN_COLORS.text.text)}>
                      Text Column *
                    </span>
                  </Label>
                  <Select
                    value={columnMapping.text || '__none__'}
                    onValueChange={(v) => handleColumnMappingChange('text', v)}
                  >
                    <SelectTrigger className={cn(columnMapping.text && COLUMN_COLORS.text.bg)}>
                      <SelectValue placeholder="Select column" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {firstPreview.headers.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <span className={cn('px-2 py-0.5 rounded text-xs font-medium', COLUMN_COLORS.start_time.bg, COLUMN_COLORS.start_time.text)}>
                      Start Time
                    </span>
                  </Label>
                  <Select
                    value={columnMapping.start_time || '__none__'}
                    onValueChange={(v) => handleColumnMappingChange('start_time', v)}
                  >
                    <SelectTrigger className={cn(columnMapping.start_time && COLUMN_COLORS.start_time.bg)}>
                      <SelectValue placeholder="Select column (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {firstPreview.headers.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <span className={cn('px-2 py-0.5 rounded text-xs font-medium', COLUMN_COLORS.end_time.bg, COLUMN_COLORS.end_time.text)}>
                      End Time
                    </span>
                  </Label>
                  <Select
                    value={columnMapping.end_time || '__none__'}
                    onValueChange={(v) => handleColumnMappingChange('end_time', v)}
                  >
                    <SelectTrigger className={cn(columnMapping.end_time && COLUMN_COLORS.end_time.bg)}>
                      <SelectValue placeholder="Select column (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {firstPreview.headers.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="mt-6">
                <h4 className="font-medium mb-2">
                  Preview ({firstPreview.total_rows} rows{isMultiFile ? ` — ${files[0].name}` : ''})
                </h4>
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-sm">
                    <thead className="bg-mm-bg">
                      <tr>
                        {firstPreview.headers.map((h) => {
                          const mappingType = columnToType[h]
                          const colorConfig = mappingType ? COLUMN_COLORS[mappingType] : null
                          return (
                            <th
                              key={h}
                              className={cn(
                                'px-3 py-2 text-left font-medium',
                                colorConfig?.bg,
                                colorConfig?.text
                              )}
                            >
                              <div className="flex flex-col">
                                <span>{h}</span>
                                {colorConfig && (
                                  <span className="text-xs font-normal opacity-75">
                                    {colorConfig.label}
                                  </span>
                                )}
                              </div>
                            </th>
                          )
                        })}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {firstPreview.sample_rows.slice(0, 5).map((row, i) => (
                        <tr key={i}>
                          {firstPreview.headers.map((h) => {
                            const mappingType = columnToType[h]
                            const colorConfig = mappingType ? COLUMN_COLORS[mappingType] : null
                            return (
                              <td
                                key={h}
                                className={cn(
                                  'px-3 py-2 truncate max-w-xs',
                                  colorConfig?.bgLight
                                )}
                              >
                                {row[h]}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Column warnings for multi-file */}
              {isMultiFile && columnWarnings.some(w => w) && (
                <div className="space-y-2 mt-4">
                  <h4 className="font-medium text-sm text-mm-text">File compatibility</h4>
                  {columnWarnings.map((warning, i) => {
                    if (!warning || i === 0) return null
                    const isError = warning.startsWith('Missing required') || warning.startsWith('Error:')
                    return (
                      <div
                        key={i}
                        className={cn(
                          'flex items-center gap-2 p-2 rounded text-sm',
                          isError ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400' : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                        )}
                      >
                        {isError ? <CircleX className="w-4 h-4 flex-shrink-0" /> : <CircleAlert className="w-4 h-4 flex-shrink-0" />}
                        <span className="font-medium">{files[i].name}:</span>
                        <span>{warning}</span>
                        {isError && (
                          <button
                            onClick={() => handleRemoveFile(i)}
                            className="ml-auto text-red-600 hover:text-red-800 text-xs underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  Back
                </Button>
                <Button
                  onClick={handleColumnsNext}
                  disabled={!columnMapping.text || !columnMapping.speaker || isLoading}
                >
                  {isLoading ? 'Checking files...' : 'Continue'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Speakers */}
        {step === 'speakers' && (
          <Card>
            <CardHeader>
              <CardTitle>Map Speakers</CardTitle>
              <CardDescription>
                Identify/anonymize speakers and, if applicable, mark who is the
                facilitator (optional — excluded from analysis by default).
                {isMultiFile
                  ? ` Configure speakers for each of the ${files.length} files.`
                  : ' At least one participant (non-facilitator) is required.'}
                {/* #407: surface the participant spine at import time */}
                {' '}Speakers become participants — if you also have survey or
                assessment data, you can link them to their records on the{' '}
                <Link to={`/projects/${id}/participants`} className="text-mm-blue-text hover:underline">
                  Participants page
                </Link>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Shared speakers info banner (multi-file only) */}
              {isMultiFile && sharedSpeakers.length > 0 && (
                <div className="p-3 bg-mm-blue/12 text-mm-blue-text rounded-lg text-sm flex items-start gap-2">
                  <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">Shared speakers detected: </span>
                    {sharedSpeakers.map((s, i) => (
                      <span key={s.name}>
                        {i > 0 && ', '}
                        {s.name} ({s.fileCount} files)
                      </span>
                    ))}
                    <span className="block mt-1 text-mm-blue-text">
                      Speakers with the same name across files will be treated as the same person.
                      If they are different people, give them distinct names below.
                    </span>
                  </div>
                </div>
              )}

              {/* Single file: flat speaker list */}
              {!isMultiFile && (
                <>
                  {/* Conversation name */}
                  <div className="space-y-2">
                    <Label>Conversation Name *</Label>
                    <Input
                      value={fileConversationNames[0] || ''}
                      onChange={(e) => {
                        userEditedNames.current.add(0)
                        setFileConversationNames(prev => {
                          const copy = [...prev]
                          copy[0] = e.target.value
                          return copy
                        })
                      }}
                      placeholder="e.g., Participant 001"
                      className={nameDuplicates[0] ? 'border-red-500' : ''}
                    />
                    {nameDuplicates[0] && (
                      <p className="text-sm text-red-600 flex items-center gap-1">
                        <CircleAlert className="w-4 h-4" />
                        {nameDuplicates[0]}
                      </p>
                    )}
                  </div>

                  {fileSpeakerMappings[0]?.length === 0 ? (
                    <div className="p-4 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 rounded-lg flex items-center gap-2">
                      <CircleAlert className="w-5 h-5" />
                      <span>No speakers detected. Please select a Speaker Column in the previous step.</span>
                    </div>
                  ) : (
                    renderSpeakerList(fileSpeakerMappings[0] || [], 0, (updated) => {
                      setFileSpeakerMappings(prev => {
                        const copy = [...prev]
                        copy[0] = updated
                        return copy
                      })
                    })
                  )}

                  {fileSpeakerValidation[0] && !fileSpeakerValidation[0].valid && (
                    <div className="p-4 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded-lg flex items-center gap-2">
                      <CircleAlert className="w-5 h-5" />
                      <span>{fileSpeakerValidation[0].error}</span>
                    </div>
                  )}
                </>
              )}

              {/* Multi-file: accordion panels */}
              {isMultiFile && (
                <div className="space-y-2">
                  {files.map((f, i) => {
                    const isExpanded = expandedFileIndex === i
                    const validation = fileSpeakerValidation[i]
                    const warning = columnWarnings[i]
                    const hasWarning = warning && (warning.startsWith('Error:') || warning.startsWith('Missing required'))

                    return (
                      <div key={i} className="border rounded-lg overflow-hidden">
                        {/* Accordion header */}
                        <button
                          className={cn(
                            'w-full flex items-center gap-3 p-3 text-left hover:bg-mm-surface-hover transition-colors',
                            isExpanded && 'bg-mm-bg'
                          )}
                          onClick={() => setExpandedFileIndex(isExpanded ? -1 : i)}
                        >
                          <ChevronDown className={cn(
                            'w-4 h-4 text-mm-text-faint transition-transform',
                            !isExpanded && '-rotate-90'
                          )} />
                          <FileText className="w-4 h-4 text-mm-text-faint flex-shrink-0" />
                          <span className="flex-1 text-sm font-medium truncate">{f.name}</span>
                          <span className="text-xs text-mm-text-muted">
                            {(fileSpeakerMappings[i] || []).length} speakers
                          </span>
                          {hasWarning ? (
                            <CircleX className="w-4 h-4 text-red-500 flex-shrink-0" />
                          ) : validation && !validation.valid ? (
                            <CircleAlert className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          ) : nameDuplicates[i] ? (
                            <CircleAlert className="w-4 h-4 text-red-500 flex-shrink-0" />
                          ) : (
                            <CircleCheck className="w-4 h-4 text-green-500 flex-shrink-0" />
                          )}
                        </button>

                        {/* Accordion body */}
                        {isExpanded && (
                          <div className="p-4 border-t space-y-4">
                            {hasWarning && (
                              <div className="p-3 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 rounded text-sm">
                                {warning}
                              </div>
                            )}

                            {/* Conversation name */}
                            <div className="space-y-1">
                              <Label className="text-sm">Conversation Name *</Label>
                              <Input
                                value={fileConversationNames[i] || ''}
                                onChange={(e) => {
                                  userEditedNames.current.add(i)
                                  setFileConversationNames(prev => {
                                    const copy = [...prev]
                                    copy[i] = e.target.value
                                    return copy
                                  })
                                }}
                                placeholder={f.name.replace(/\.[^/.]+$/, '')}
                                className={nameDuplicates[i] ? 'border-red-500' : ''}
                              />
                              {nameDuplicates[i] && (
                                <p className="text-sm text-red-600 flex items-center gap-1">
                                  <CircleAlert className="w-4 h-4" />
                                  {nameDuplicates[i]}
                                </p>
                              )}
                            </div>

                            {/* Speaker list */}
                            {(fileSpeakerMappings[i] || []).length === 0 ? (
                              <div className="p-3 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 rounded text-sm flex items-center gap-2">
                                <CircleAlert className="w-4 h-4" />
                                No speakers detected for this file.
                              </div>
                            ) : (
                              renderSpeakerList(fileSpeakerMappings[i] || [], i, (updated) => {
                                setFileSpeakerMappings(prev => {
                                  const copy = [...prev]
                                  copy[i] = updated
                                  return copy
                                })
                              }, (speakerIndex, newValue) => {
                                const speaker = fileSpeakerMappings[i]?.[speakerIndex]
                                if (!speaker) return
                                const nameKey = speaker.normalized_name.trim().toLowerCase()
                                const sharedIndices = sharedSpeakerMap.get(nameKey)
                                if (sharedIndices && sharedIndices.length > 1) {
                                  setPendingFacChange({
                                    speakerName: speaker.normalized_name.trim(),
                                    fileIndex: i,
                                    newValue,
                                    sharedFileIndices: sharedIndices,
                                  })
                                } else {
                                  // Not shared — apply directly
                                  setFileSpeakerMappings(prev => {
                                    const copy = [...prev]
                                    copy[i] = (copy[i] || []).map((m, mi) =>
                                      mi === speakerIndex ? { ...m, is_facilitator: newValue } : m
                                    )
                                    return copy
                                  })
                                }
                              }, handleSharedColorChange)
                            )}

                            {validation && !validation.valid && (
                              <div className="p-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded flex items-center gap-2 text-sm">
                                <CircleAlert className="w-4 h-4" />
                                <span>{validation.error}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={() => setStep('columns')}>
                  Back
                </Button>
                <Button
                  onClick={handleSpeakersContinue}
                  disabled={!speakersStepValid || isLoading}
                >
                  {isLoading ? 'Importing...' : isMultiFile ? `Import ${files.length} Files` : 'Import'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Single-file: attaching the recording after import (Slab 2) */}
        {step === 'importing' && attach && (
          <Card>
            <CardHeader>
              <CardTitle>Importing</CardTitle>
              <CardDescription>Bringing in your transcript and attaching the recording.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40">
                <CircleCheck className="w-5 h-5 text-green-600 flex-shrink-0" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-green-800 dark:text-green-300">Transcript imported</div>
                  {attach.segmentCount != null && (
                    <div className="text-xs text-mm-text-muted">{attach.segmentCount} segments</div>
                  )}
                </div>
              </div>
              <div role="status" aria-live="polite" className="flex items-center gap-3 p-3 rounded-lg border">
                <LoaderCircle className="w-5 h-5 animate-spin text-primary flex-shrink-0" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">Attaching recording…</div>
                  <div className="text-xs text-mm-text-muted truncate">{attach.mediaName}</div>
                </div>
              </div>
              <p className="text-xs text-mm-text-faint">
                Large recordings can take a few minutes. Keep this tab open until it finishes.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Importing (multi-file only) */}
        {step === 'importing' && !attach && (
          <Card>
            <CardHeader>
              <CardTitle>Importing Conversations</CardTitle>
              <CardDescription>
                Importing {files.length} files. This may take a moment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>
                    {importProgress.current < files.length
                      ? `Importing ${importProgress.current + 1} of ${files.length}...`
                      : 'Finishing up...'}
                  </span>
                  <span>{Math.round((importProgress.current / files.length) * 100)}%</span>
                </div>
                <Progress value={(importProgress.current / files.length) * 100} />
              </div>

              {importProgress.current > 0 && importProgress.current <= files.length && (
                <div className="flex items-center gap-2 text-sm text-mm-text-secondary">
                  <LoaderCircle className="w-4 h-4 animate-spin" />
                  <span>{files[Math.min(importProgress.current, files.length) - 1]?.name}</span>
                </div>
              )}

              {/* Completed results so far */}
              {importProgress.results.length > 0 && (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {importProgress.results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm p-1.5">
                      {r.status === 'success' ? (
                        <CircleCheck className="w-4 h-4 text-green-500 flex-shrink-0" />
                      ) : r.status === 'error' ? (
                        <CircleX className="w-4 h-4 text-red-500 flex-shrink-0" />
                      ) : (
                        <Ban className="w-4 h-4 text-mm-text-faint flex-shrink-0" />
                      )}
                      <span className="truncate">{r.conversationName}</span>
                      {r.segmentCount != null && (
                        <span className="text-mm-text-faint flex-shrink-0">{r.segmentCount} segments</span>
                      )}
                      {r.error && (
                        <span className="text-red-500 text-xs truncate flex-shrink-0">{r.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end pt-2">
                <Button
                  variant="outline"
                  onClick={() => { cancelledRef.current = true }}
                  disabled={cancelledRef.current || importProgress.current >= files.length}
                >
                  Cancel Remaining
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Single-file: recording failed to attach — the import itself is safe (Slab 2) */}
        {step === 'results' && attach && attach.status === 'failed' && (
          <Card>
            <CardHeader>
              <CardTitle>Import complete — with one issue</CardTitle>
              <CardDescription>Your transcript imported. The recording couldn’t be attached this time.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40 text-sm">
                <CircleCheck className="w-5 h-5 text-green-600 flex-shrink-0" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">Transcript imported</div>
                  <div className="text-xs text-mm-text-muted truncate">
                    {attach.conversationName}{attach.segmentCount != null ? ` · ${attach.segmentCount} segments` : ''}
                  </div>
                </div>
              </div>
              <div role="alert" className="flex items-start gap-3 p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-sm">
                <CircleX className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">Recording not attached</div>
                  <div className="text-xs text-mm-text-muted">
                    {attach.mediaName}{attach.error ? ` — ${attach.error}` : ''}. You can add it any time from the workbench.
                  </div>
                </div>
              </div>
              {/* #356/#543(b): import warnings must survive the failed-attach corner too. */}
              {attach.warnings && attach.warnings.length > 0 && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3 rounded-lg border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 text-xs"
                >
                  <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="font-medium">
                      {attach.warnings.length === 1 ? 'Import warning' : `${attach.warnings.length} import warnings`}
                    </div>
                    <ul className="space-y-0.5 list-disc list-inside marker:text-amber-700 dark:marker:text-amber-300">
                      {attach.warnings.map((w, wi) => <li key={wi}>{w}</li>)}
                    </ul>
                  </div>
                </div>
              )}
              <div className="flex justify-between gap-2 pt-2">
                <Button variant="outline" onClick={() => navigate(`/projects/${id}/conversations/${attach.conversationId}`)}>
                  Open conversation
                </Button>
                <Button onClick={handleRetryAttach}>
                  Retry recording
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 5: Results (multi-file only) */}
        {step === 'results' && !attach && (
          <Card>
            <CardHeader>
              <CardTitle>Import Complete</CardTitle>
              <CardDescription>
                {(() => {
                  const successCount = importProgress.results.filter(r => r.status === 'success').length
                  const total = importProgress.results.length
                  return successCount === total
                    ? `All ${total} conversations imported successfully.`
                    : `${successCount} of ${total} conversations imported successfully.`
                })()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Success banner */}
              {(() => {
                const successCount = importProgress.results.filter(r => r.status === 'success').length
                const errorCount = importProgress.results.filter(r => r.status === 'error').length
                const cancelledCount = importProgress.results.filter(r => r.status === 'cancelled').length

                return (
                  <div className={cn(
                    'p-4 rounded-lg',
                    errorCount === 0 ? 'bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300' : 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                  )}>
                    <div className="flex items-center gap-2 font-medium">
                      {errorCount === 0 ? (
                        <CircleCheck className="w-5 h-5" />
                      ) : (
                        <CircleAlert className="w-5 h-5" />
                      )}
                      {successCount} imported
                      {errorCount > 0 && `, ${errorCount} failed`}
                      {cancelledCount > 0 && `, ${cancelledCount} cancelled`}
                    </div>
                  </div>
                )
              })()}

              {/* Per-file results */}
              <div className="space-y-2">
                {importProgress.results.map((r, i) => (
                  <div key={i} className="space-y-2">
                    <div
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-lg border text-sm',
                        r.status === 'success' ? 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800' :
                        r.status === 'error' ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800' :
                        'bg-mm-bg border-mm-border-subtle'
                      )}
                    >
                      {r.status === 'success' ? (
                        <CircleCheck className="w-5 h-5 text-green-600 flex-shrink-0" />
                      ) : r.status === 'error' ? (
                        <CircleX className="w-5 h-5 text-red-600 flex-shrink-0" />
                      ) : (
                        <Ban className="w-5 h-5 text-mm-text-faint flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{r.conversationName}</div>
                        <div className="text-xs text-mm-text-muted">{r.fileName}</div>
                      </div>
                      {r.segmentCount != null && (
                        <span className="text-mm-text-muted flex-shrink-0">{r.segmentCount} segments</span>
                      )}
                      {r.error && (
                        <span className="text-red-600 text-xs truncate max-w-[200px]" title={r.error}>
                          {r.error}
                        </span>
                      )}
                      {r.status === 'success' && r.conversationId && (
                        <Link
                          to={`/projects/${id}/conversations/${r.conversationId}`}
                          className="text-primary hover:underline text-xs flex-shrink-0"
                        >
                          Open
                        </Link>
                      )}
                    </div>
                    {/* #356: per-file import warnings (e.g. backward timestamps).
                      * Researcher-actionable — typically "fix in source CSV + re-import". */}
                    {r.warnings && r.warnings.length > 0 && (
                      <div
                        role="alert"
                        className="flex items-start gap-2.5 p-3 rounded-lg border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 text-xs ml-8"
                      >
                        <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="font-medium">
                            {r.warnings.length === 1 ? 'Import warning' : `${r.warnings.length} import warnings`}
                          </div>
                          <ul className="space-y-0.5 list-disc list-inside marker:text-amber-700 dark:marker:text-amber-300">
                            {r.warnings.map((w, wi) => <li key={wi}>{w}</li>)}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={handleReset}>
                  Import More
                </Button>
                <Button onClick={() => navigate(`/projects/${id}/conversations`)}>
                  Return to Project
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Shared speaker facilitator propagation dialog */}
      <AlertDialog open={pendingFacChange !== null} onOpenChange={(open) => { if (!open) setPendingFacChange(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to all conversations?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingFacChange?.speakerName}" appears in {pendingFacChange?.sharedFileIndices.length} conversations.
              Would you like to {pendingFacChange?.newValue ? 'mark' : 'unmark'} them as facilitator in all of them?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={applyFacilitatorToOne}>
              This File Only
            </AlertDialogCancel>
            <AlertDialogAction onClick={applyFacilitatorToAll}>
              Apply to All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
