import { useState, useCallback, useMemo, useRef, useEffect, useId } from 'react'
import { useParams, useNavigate, Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileInput, Check, ChevronRight, ChevronDown, CircleAlert, X, FileText, LoaderCircle, CircleCheck, CircleX, Ban, TriangleAlert, Tags } from 'lucide-react'
import { retryUnanswered, datasetsApi, type DatasetPreviewResponse, type DatasetColumnPreview, type DatasetColumnsResponse, type DatasetColumnConfig, type OverlongRecords, type ParticipantLinkReport } from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DatasetColumnChooser } from '@/components/DatasetColumnChooser'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { useElapsedSeconds } from '@/hooks/useElapsedSeconds'
import {
  ANNOUNCE_EVERY_SECONDS, elapsedNote, fillFraction, isOverEstimate, stillWorkingMessage,
} from '@/lib/elapsed-progress'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ValueLabelRows, buildValueLabelPayload, type ValueLabelRow } from '@/components/ValueLabelRows'
import { cn } from '@/lib/utils'
import { consumePendingImportFiles } from '@/lib/pending-import-files'
import { COLUMN_TYPES, TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import {
  DATASET_ACCEPT, DATASET_FORMAT_LABEL, isSupportedDatasetFile,
  describeDatasetUploadError, estimatedProcessingSeconds, SLOW_UPLOAD_THRESHOLD_BYTES,
} from '@/lib/dataset-import-formats'
import { checkImportFiles } from '@/lib/upload-limits'
import { useStepFocus } from '@/hooks/useStepFocus'
import { projectHadParticipants } from '@/lib/participant-snapshot'
import ParticipantLinkNote from '@/components/ParticipantLinkNote'
import { countLabel, formatBytes, plural } from '@/lib/format'
import UploadLimitNote from '@/components/UploadLimitNote'
import { openPickerFromZoneClick } from '@/lib/drop-zone'
import { OverlongRecordsNotice } from '@/components/OverlongRecordsNotice'

/** Human-readable labels for auto-detected column types. */
const TYPE_LABELS: Record<string, string> = {
  ordinal: 'Ordinal',
  nominal: 'Nominal',
  binary: 'Binary',
  multi_select: 'Multi-Select',
  numeric: 'Numeric',
  percentage: 'Percentage',
  open_text: 'Open Text',
  demographic: 'Demographic',
  identifier: 'Identifier',
  skip: 'Skip',
}

/** #973 (c): `choose-columns` is a RECOVERY step, reached only when a file is
 *  over the cell cap — not a stage every import passes through. */
type Step = 'upload' | 'choose-columns' | 'configure' | 'importing' | 'results'

export interface FileConfig {
  preview: DatasetPreviewResponse | null
  previewColumns: DatasetColumnPreview[]
  skippedIndices: Set<number>
  typeOverrides: Record<number, string>     // column_index -> column_type
  subtypeOverrides: Record<number, string>  // column_index -> subtype
  datasetName: string
  datasetDescription: string
  datasetSource: string
  previewError: string | null
  /** .xlsx only (#523): selected worksheet; null = first sheet. */
  sheetName: string | null
  /** #414 (DEC-6): link rows to participants by the identifier column. */
  linkParticipants: boolean
  /** #414: user-picked identifier column when several exist; null = auto
   *  (first identifier column). Compare with `??` — index 0 is valid. */
  linkColumnIndex: number | null
  /** #575: per-column authored value labels (code→label) for numbers-only scale
   *  columns. Keyed by column_index. Present ⇒ import as cells_are_codes. */
  valueLabels: Record<number, { type: 'ordinal' | 'nominal'; rows: ValueLabelRow[] }>
  /** #973 (c): set when the preview was refused by the CELL CAP and the cheap
   *  `/columns` call answered — the file's column list, so the researcher can
   *  choose a subset. Null for every file that previews normally. */
  columnChoice: DatasetColumnsResponse | null
  /** #973 (c): the chosen ORIGINAL column indices, once confirmed. 🔴 Sent to
   *  BOTH `preview` and `import`: the server narrows the file to this list, so
   *  every `column_index` in `previewColumns` is a position in the narrowed
   *  text and a different list at import time would move the researcher's type
   *  choices onto other columns. */
  sourceColumnIndices: number[] | null
}

interface ImportResult {
  fileName: string
  datasetName: string
  status: 'success' | 'error' | 'cancelled'
  datasetId?: number
  columnsCreated?: number
  recordsCreated?: number
  valuesCreated?: number
  recognizedMissingCount?: number
  recognizedMissingLabels?: string[]
  /** #575: total observed codes left unlabeled across cells-are-codes columns. */
  valueLabelUnlabeledCount?: number
  linkReport?: ParticipantLinkReport | null
  /** #985: records with more values than column headings, each linked to its row. */
  overlongRecords?: OverlongRecords
  error?: string
}

/** #414: identifier-typed, non-skipped columns of a file (the link candidates). */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function identifierColumns(config: FileConfig): DatasetColumnPreview[] {
  return config.previewColumns.filter(col => {
    if (config.skippedIndices.has(col.column_index)) return false
    const effectiveType = config.typeOverrides[col.column_index] || col.suggested_type
    return effectiveType === 'identifier'
  })
}

/** #414: the column_index the import will link by, or null when linking is off. */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper, unit-tested
export function effectiveLinkColumnIndex(config: FileConfig): number | null {
  if (!config.linkParticipants) return null
  const idCols = identifierColumns(config)
  if (idCols.length === 0) return null
  // A stale user pick (column retyped/skipped since) falls back to the first.
  if (config.linkColumnIndex != null && idCols.some(c => c.column_index === config.linkColumnIndex)) {
    return config.linkColumnIndex
  }
  return idCols[0].column_index
}

/**
 * #415: discloses that some imported values were recognized as missing (N/A /
 * refusal labels like "Prefer not to say") and are excluded from analysis the
 * same way blank cells are — so the handling isn't silent. Renders nothing
 * when there are none. `compact` is the inline per-dataset suffix used in the
 * multi-file list.
 */
function RecognizedMissingNote({
  count,
  labels,
  projectId,
  compact = false,
}: {
  count?: number
  labels?: string[]
  projectId?: string | number
  compact?: boolean
}) {
  if (!count || count <= 0) return null
  if (compact) {
    return (
      <span className="text-mm-text-faint">
        {' · '}{count.toLocaleString()} recognized as missing
      </span>
    )
  }
  const examples = (labels ?? []).slice(0, 3)
  const more = (labels?.length ?? 0) - examples.length
  const exampleText =
    examples.length > 0
      ? ` (${examples.join(', ')}${more > 0 ? `, +${more} more` : ''})`
      : ''
  return (
    <div className="pt-1 text-xs text-mm-text-muted">
      {count === 1 ? '1 value was' : `${count.toLocaleString()} values were`} recognized as
      missing{exampleText} and excluded from analysis, the same way blank cells are.
      Review them on the{' '}
      <Link
        to={`/projects/${projectId}/analysis?tab=data_quality`}
        className="text-mm-blue-text hover:underline"
      >
        Data Quality
      </Link>{' '}
      tab.
    </div>
  )
}

const MAX_FILES = 50
const PREVIEW_CONCURRENCY = 5

/** #575: per-column value-labels authoring in the import wizard — the cells are
 * numeric codes, so declare a code→label dictionary to substitute at import (the
 * wizard analog of a .sav import). Rendered as a sibling BELOW the column row, not
 * nested in its <label> (#560). Seeds the complete observed code set. */
function ColumnValueLabelsControl({
  col,
  authored,
  onChange,
}: {
  col: DatasetColumnPreview
  authored: { type: 'ordinal' | 'nominal'; rows: ValueLabelRow[] } | undefined
  onChange: (v: { type: 'ordinal' | 'nominal'; rows: ValueLabelRow[] } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const observedCodes = useMemo<number[]>(() => (
    col.distinct_numeric_values
      ?? Array.from(new Set(col.sample_values.map(v => Number(v)).filter(Number.isFinite))).sort((a, b) => a - b)
  ), [col.distinct_numeric_values, col.sample_values])
  const seedRows = useMemo<ValueLabelRow[]>(
    () => observedCodes.map(c => ({ code: String(c), label: '' })),
    [observedCodes],
  )

  const [type, setType] = useState<'ordinal' | 'nominal'>(authored?.type ?? 'ordinal')
  const [rows, setRows] = useState<ValueLabelRow[]>(authored?.rows ?? seedRows)

  // Reset the draft from the authored value (or the seed) each time it opens.
  useEffect(() => {
    if (open) {
      setType(authored?.type ?? 'ordinal')
      setRows(authored?.rows ?? seedRows)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const validation = useMemo(() => buildValueLabelPayload(rows), [rows])
  const undeclared = useMemo(() => {
    const labelled = new Set((validation.payload ?? []).map(p => p.value))
    return observedCodes.filter(c => !labelled.has(c))
  }, [validation.payload, observedCodes])

  const labelledCount = authored?.rows.filter(r => r.label.trim() !== '').length ?? 0

  return (
    <div className="px-4 pb-2 -mt-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 text-xs text-mm-blue-text gap-1">
            <Tags className="w-3 h-3" aria-hidden="true" />
            {authored ? `Value labels (${labelledCount})` : 'Add value labels…'}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-96 p-3" aria-label="Value labels for numeric codes">
          <p className="text-xs text-mm-text-muted mb-2">
            These cells are numeric codes. Give each code a label — charts and tables will show
            the label; means and other statistics keep using the code.
          </p>
          <ValueLabelRows
            rows={rows}
            onRowsChange={setRows}
            colType={type}
            onColTypeChange={setType}
            validation={validation}
            idPrefix="wizard-vl"
          />
          {undeclared.length > 0 && (
            <p role="note" className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {undeclared.length} observed code{undeclared.length === 1 ? '' : 's'} still unlabeled:{' '}
              {undeclared.slice(0, 6).join(', ')}{undeclared.length > 6 ? '…' : ''}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-2">
            {authored && (
              <Button variant="ghost" size="sm" onClick={() => { onChange(null); setOpen(false) }}>
                Remove
              </Button>
            )}
            <Button
              size="sm"
              disabled={!validation.ok}
              onClick={() => { onChange({ type, rows }); setOpen(false) }}
            >
              Apply labels
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export default function DatasetImport() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const id = parseInt(projectId || '0')
  // #905: the Dataset Details fields were named by their PLACEHOLDER — the
  // *Dataset Name* box announced as "e.g., Board Assessment Survey" — because
  // each visible <Label> beside them carried no htmlFor. Suffixed per file, since
  // `renderConfigurePanel` runs once per selected file.
  const detailsId = useId()

  const [step, setStep] = useState<Step>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [fileConfigs, setFileConfigs] = useState<FileConfig[]>([])
  const [isLoading, setIsLoading] = useState(false)
  /**
   * #1010 (i) — WHAT is loading. The estimate and the button's word were chosen by
   * STEP, but two previews run off the upload step (the column chooser's confirm
   * and the configure step's worksheet change), so a worksheet change on the
   * configure step read "Importing…" with the import's estimate while only a
   * preview ran. Set wherever `isLoading` goes true; read only while it is.
   */
  const [operation, setOperation] = useState<'preview' | 'import'>('preview')
  const [error, setError] = useState('')
  /**
   * #796 (a11y half): a large import is 30s+ of server work behind a button
   * whose label changes to 'Analyzing...'. A changed label announces only if
   * focus happens to be on that button, and NOTHING announces completion — so
   * a screen-reader user got silence for half a minute and no end signal.
   * This drives a polite live region instead, which is focus-independent.
   * ⚠️ Kept OUT of any control's accessible name on purpose (#770: a name that
   * changes while its element is the active descendant is re-read).
   */
  const [statusMessage, setStatusMessage] = useState('')

  // Accordion state for configure step (multi-file)
  const [expandedFileIndex, setExpandedFileIndex] = useState<number>(0)

  // Import progress
  const [importProgress, setImportProgress] = useState<{
    current: number
    results: ImportResult[]
  }>({ current: 0, results: [] })
  const cancelledRef = useRef(false)
  const datasetInputRef = useRef<HTMLInputElement>(null)
  const datasetAddMoreInputRef = useRef<HTMLInputElement>(null)

  const isMultiFile = files.length > 1

  // Pick up files staged by drag-drop on ProjectView empty tab
  useEffect(() => {
    const pending = consumePendingImportFiles('dataset')
    if (pending) handleFilesSelected(pending)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch existing datasets for name collision detection
  const existingDatasetsQuery = useQuery({
    queryKey: ['datasets', id],
    queryFn: () => datasetsApi.list(id),
    enabled: !!id,
    retry: retryUnanswered,
  })
  const existingDatasets = existingDatasetsQuery.data
  /**
   * #963 — whether the existing-dataset list is an ANSWER. Nothing on the server
   * refuses a duplicate dataset NAME (no unique index, no 409), so
   * `nameDuplicates` below is the only guard there is.
   *
   * 🔴 **The two non-ready states are treated DIFFERENTLY, deliberately.** While
   * it is LOADING the configure step waits — the wait resolves itself and the
   * researcher is still filling the form. After a FAILURE the step proceeds
   * anyway, with the note below saying the check could not run: blocking an
   * import because an unrelated list failed is worse than a duplicate name,
   * which costs a rename and destroys nothing.
   */
  const existingDatasetsLoad = useListLoad(existingDatasetsQuery)

  // #414: whether the project had participants BEFORE this import — drives
  // the results-step identity-pollution callout. Snapshotted into a ref at
  // import start (the import itself creates participants).
  /**
   * #963 — `undefined` means "we could not tell", never `false`.
   *
   * The identity-pollution callout is gated on the project having had
   * participants BEFORE the import; read from an unanswered list that gate was
   * `false`, so the callout was SUPPRESSED and the researcher was not told that
   * none of their IDs matched anyone already here. It now discloses unless we
   * KNOW the project was empty — the safe direction, and the sentence it prints
   * is true whenever nothing matched.
   */
  // 🔴 #1047 — filled at import START by `projectHadParticipants`, a count
  // (`lib/participant-snapshot.ts`). The page used to fetch the WHOLE
  // participant list for this one boolean.
  const hadParticipantsRef = useRef<boolean | undefined>(false)

  const existingDatasetNames = useMemo(
    () => (existingDatasets?.datasets || []).map(d => d.name.toLowerCase()),
    [existingDatasets]
  )

  // Check for duplicate dataset names (existing + within batch)
  /** #963 — shown when the duplicate-name check could not run at all. */
  const nameCheckFailed = existingDatasetsLoad.status === 'failed'

  const nameDuplicates = useMemo(() => {
    const result: Record<number, string> = {}
    const batchNames = fileConfigs.map(c => c.datasetName.trim().toLowerCase())

    for (let i = 0; i < batchNames.length; i++) {
      const name = batchNames[i]
      if (!name) continue
      if (existingDatasetNames.includes(name)) {
        result[i] = 'A dataset with this name already exists'
      } else {
        for (let j = 0; j < i; j++) {
          if (batchNames[j] === name) {
            result[i] = 'Duplicate name within this import batch'
            break
          }
        }
      }
    }
    return result
  }, [fileConfigs, existingDatasetNames])

  // --- File handling ---

  const handleFilesSelected = useCallback((selectedFiles: File[]) => {
    setError('')
    // #1007/#1012: refuse a wrong-type or over-limit file HERE, naming it — this
    // page used to drop a wrong-type file in silence.
    const { accepted: csvFiles, message } = checkImportFiles(selectedFiles, {
      isSupported: isSupportedDatasetFile, formatLabel: DATASET_FORMAT_LABEL, noun: 'dataset',
    })
    const messages: string[] = message ? [message] : []
    if (csvFiles.length === 0) { setError(messages.join(' ')); return }

    const newFiles = [...files, ...csvFiles].slice(0, MAX_FILES)
    const addedCount = newFiles.length - files.length
    if (addedCount < csvFiles.length) {
      messages.push(`File limit is ${MAX_FILES}. Only ${addedCount} file(s) added.`)
    }
    setError(messages.join(' '))

    setFiles(newFiles)

    // Extend configs for newly added files
    const newConfigs = [...fileConfigs]
    for (let i = files.length; i < newFiles.length; i++) {
      newConfigs.push({
        preview: null,
        previewColumns: [],
        skippedIndices: new Set(),
        typeOverrides: {},
        subtypeOverrides: {},
        datasetName: newFiles[i].name.replace(/\.[^/.]+$/, ''),
        datasetDescription: '',
        datasetSource: '',
        previewError: null,
        sheetName: null,
        linkParticipants: true,
        linkColumnIndex: null,
        valueLabels: {},
        columnChoice: null,
        sourceColumnIndices: null,
      })
    }
    setFileConfigs(newConfigs)
  }, [files, fileConfigs])

  const handleRemoveFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
    setFileConfigs(prev => prev.filter((_, i) => i !== index))
    if (expandedFileIndex === index) {
      setExpandedFileIndex(Math.max(0, index - 1))
    } else if (expandedFileIndex > index) {
      setExpandedFileIndex(prev => prev - 1)
    }
  }, [expandedFileIndex])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const droppedFiles = Array.from(e.dataTransfer.files)
      handleFilesSelected(droppedFiles)
    },
    [handleFilesSelected]
  )

  // --- Preview all files (triggered by "Next" on upload step) ---

  /**
   * Roughly how long the server will spend on the current selection, in seconds
   * — used ONLY to decide whether to warn. `estimatedProcessingSeconds` is
   * per-file and the wizard previews in batches of PREVIEW_CONCURRENCY, so the
   * honest wall-clock is the sum: the batch is bounded by its total work, not by
   * its slowest member.
   */
  const estimatedSeconds = useMemo(
    () => files.reduce((s, f) => s + estimatedProcessingSeconds(f.size, 'preview'), 0),
    [files],
  )
  /**
   * #796b: the IMPORT estimate is ~3x the preview one, because import also
   * writes ~3.1M rows. Quoting the preview number on the import button is what
   * made the wait feel unbounded.
   */
  const estimatedImportSeconds = useMemo(
    () => files.reduce((s, f) => s + estimatedProcessingSeconds(f.size, 'import'), 0),
    [files],
  )
  const hasSlowFile = useMemo(
    () => files.some(f => f.size > SLOW_UPLOAD_THRESHOLD_BYTES),
    [files],
  )

  const elapsed = useElapsedSeconds(isLoading)
  const activeEstimate = operation === 'import' ? estimatedImportSeconds : estimatedSeconds
  const progress = fillFraction(elapsed, activeEstimate)
  const overEstimate = isOverEstimate(elapsed, activeEstimate)

  /**
   * Announce at 30s intervals only. A live region that fires every tick would
   * make the page unusable with a screen reader; the fill is the continuous
   * signal for sighted users and this is the periodic one for everyone else.
   */
  const lastAnnouncedRef = useRef(0)
  useEffect(() => {
    if (!isLoading) { lastAnnouncedRef.current = 0; return }
    const bucket = Math.floor(elapsed / ANNOUNCE_EVERY_SECONDS)
    if (bucket > 0 && bucket !== lastAnnouncedRef.current) {
      lastAnnouncedRef.current = bucket
      setStatusMessage(stillWorkingMessage(elapsed, overEstimate))
    }
  }, [isLoading, elapsed, overEstimate])

  const handlePreviewAll = useCallback(async () => {
    // #1133 — Next stays focusable while it reads (`aria-disabled`), so this
    // guard is the refusal (#754: `aria-disabled` changes what a button says,
    // not what it does).
    if (isLoading) return
    setOperation('preview')
    setIsLoading(true)
    setError('')
    setStatusMessage(
      hasSlowFile
        ? `Reading ${files.length === 1 ? 'the file' : `${files.length} files`}. This is a large upload and may take around ${estimatedSeconds} seconds.`
        : `Reading ${files.length === 1 ? 'the file' : `${files.length} files`}…`,
    )

    const newConfigs = [...fileConfigs]
    const errors: string[] = []

    // Preview files in batches of PREVIEW_CONCURRENCY
    for (let batchStart = 0; batchStart < files.length; batchStart += PREVIEW_CONCURRENCY) {
      const batchEnd = Math.min(batchStart + PREVIEW_CONCURRENCY, files.length)
      const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

      const results = await Promise.allSettled(
        batchIndices.map(i => datasetsApi.preview(id, files[i], 'utf-8', fileConfigs[i]?.sheetName ?? undefined))
      )

      results.forEach((result, batchIdx) => {
        const fileIdx = batchIndices[batchIdx]
        if (result.status === 'fulfilled') {
          const preview = result.value
          // Seed skipped indices and demographic subtypes from auto-detection
          const autoSkipped = new Set<number>()
          const autoSubtypes: Record<number, string> = {}
          for (const col of preview.columns) {
            if (col.suggested_type === 'skip') {
              autoSkipped.add(col.column_index)
            }
            if (col.suggested_type === 'demographic' && col.suggested_demographic_subtype) {
              autoSubtypes[col.column_index] = col.suggested_demographic_subtype
            }
          }
          newConfigs[fileIdx] = {
            ...newConfigs[fileIdx],
            preview,
            previewColumns: preview.columns,
            skippedIndices: autoSkipped,
            typeOverrides: {},
            subtypeOverrides: autoSubtypes,
            previewError: null,
            // #973 (c): this preview covered the WHOLE file, so any selection
            // from an earlier attempt is void. ⚠️ Not clearing them is a real
            // bug and a reachable one: cancel out of the chooser, pick a
            // different WORKSHEET that fits, press Next — the preview succeeds
            // and a stale `columnChoice` would route a fitting file straight
            // back to the chooser, and a stale `sourceColumnIndices` would then
            // narrow the IMPORT to columns the preview never described.
            columnChoice: null,
            sourceColumnIndices: null,
          }
        } else {
          // #797: report the reason we HAVE. The old line reduced every failure
          // to a raw Error.message (a bare "signal timed out" for #796's abort)
          // and the all-failed branch below then replaced even that with a guess.
          const errMsg = describeDatasetUploadError(result.reason)
          newConfigs[fileIdx] = {
            ...newConfigs[fileIdx],
            preview: null,
            previewColumns: [],
            previewError: errMsg,
          }
          errors.push(`${files[fileIdx].name}: ${errMsg}`)
        }
      })
    }

    // #973 (c): a preview that FAILED may have failed because the file is over
    // the cell cap — which is recoverable, by importing fewer columns — or
    // because it cannot be read at all, which is not. 🔴 **The two are told
    // apart by a MEASUREMENT, never by matching the refusal's wording**: ask the
    // cheap `/columns` endpoint, which applies no cap, and compare the size it
    // reports against the limit it reports. A file it cannot read is genuinely
    // unreadable and keeps its original error.
    const failedIdx = newConfigs
      .map((c, i) => (c.previewError ? i : -1))
      .filter(i => i >= 0)
    if (failedIdx.length > 0) {
      setStatusMessage('Checking whether the file can be imported in part…')
      const described = await Promise.allSettled(
        failedIdx.map(i => datasetsApi.describeColumns(
          id, files[i], 'utf-8', fileConfigs[i]?.sheetName ?? undefined,
        )),
      )
      described.forEach((outcome, n) => {
        if (outcome.status !== 'fulfilled') return
        const summary = outcome.value
        // Only the CAP is recoverable here. An unknown row count (-1, which SPSS
        // may legally record — #539) cannot be compared, so it is not claimed as
        // a cap failure: the file keeps the error it actually got.
        if (summary.cells === null || summary.cells <= summary.max_cells) return
        const fileIdx = failedIdx[n]
        newConfigs[fileIdx] = { ...newConfigs[fileIdx], columnChoice: summary }
      })
    }

    setFileConfigs(newConfigs)
    setIsLoading(false)

    // #973 (c): a recoverable file takes the researcher to the chooser rather
    // than into the configure step with an error it cannot act on.
    const needsChoice = newConfigs.some(c => c.columnChoice !== null)
    if (needsChoice) {
      const first = newConfigs.findIndex(c => c.columnChoice !== null)
      setExpandedFileIndex(first)
      setStatusMessage(
        'This file is larger than one import can hold. Choose the columns you need.',
      )
      setStep('choose-columns')
      return
    }

    // Check if all files failed
    const allFailed = newConfigs.every(c => c.previewError !== null)
    if (allFailed) {
      // #797: two defects lived in the string this replaces — "Please check your
      // CSV files" asserted a diagnosis it had not established (in #796 the file
      // was valid and the CLIENT had aborted), and it named one of the three
      // formats this wizard accepts. Say what actually happened, per file.
      setError(
        files.length === 1
          ? (newConfigs[0].previewError as string)
          : `None of the ${files.length} files could be read. ${errors.join(' · ')}`,
      )
      // #1133 — nothing was imported (this is the READ, before configure), and
      // the reason is the alert this status sits beside, so it names no
      // direction ("see the message above" — the alert is after it in reading
      // order, and this line is screen-reader-only).
      setStatusMessage(files.length === 1 ? 'The file could not be read.' : 'None of the files could be read.')
      return
    }

    if (errors.length > 0) {
      setError(`${errors.length} file(s) had preview errors. You can remove them and continue.`)
      setStatusMessage(
        `${newConfigs.length - errors.length} of ${newConfigs.length} files read. ${errors.length} had errors.`,
      )
    } else {
      const cols = newConfigs.reduce((n, c) => n + (c.previewColumns?.length ?? 0), 0)
      setStatusMessage(
        `Ready to configure. ${cols} column${cols === 1 ? '' : 's'} found. Review the column types, then import.`,
      )
    }

    setStep('configure')
    // `hasSlowFile`/`estimatedSeconds` are derived from `files` and are read when
    // the announcement is composed — omitting them would close over a previous
    // selection's estimate and announce a stale duration after the user adds or
    // removes a file.
  }, [files, fileConfigs, id, hasSlowFile, estimatedSeconds, isLoading])

  // --- Worksheet change (#523, .xlsx only): re-preview ONE file on its new sheet ---

  const handleSheetChange = useCallback(async (fileIndex: number, sheetName: string) => {
    setOperation('preview')
    setIsLoading(true)
    try {
      const preview = await datasetsApi.preview(id, files[fileIndex], 'utf-8', sheetName)
      const autoSkipped = new Set<number>()
      const autoSubtypes: Record<number, string> = {}
      for (const col of preview.columns) {
        if (col.suggested_type === 'skip') autoSkipped.add(col.column_index)
        if (col.suggested_type === 'demographic' && col.suggested_demographic_subtype) {
          autoSubtypes[col.column_index] = col.suggested_demographic_subtype
        }
      }
      setFileConfigs(prev => {
        const copy = [...prev]
        copy[fileIndex] = {
          ...copy[fileIndex],
          preview,
          previewColumns: preview.columns,
          // A different sheet is different data — reseed the per-column choices.
          skippedIndices: autoSkipped,
          typeOverrides: {},
          subtypeOverrides: autoSubtypes,
          previewError: null,
          sheetName,
          linkColumnIndex: null,
          valueLabels: {},
        }
        return copy
      })
    } catch (e) {
      // #797's class: a timeout read as a bare "signal timed out". The upload
      // describer names the cause the way every other preview here does.
      setError(describeDatasetUploadError(e))
    } finally {
      setIsLoading(false)
    }
  }, [files, id])

  // --- Skip toggle ---

  const toggleSkip = useCallback((fileIndex: number, columnIndex: number) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      const config = { ...copy[fileIndex] }
      const newSkipped = new Set(config.skippedIndices)
      if (newSkipped.has(columnIndex)) {
        newSkipped.delete(columnIndex)
      } else {
        newSkipped.add(columnIndex)
      }
      config.skippedIndices = newSkipped
      copy[fileIndex] = config
      return copy
    })
  }, [])

  const setSubtype = useCallback((fileIndex: number, columnIndex: number, subtype: string) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      const config = { ...copy[fileIndex] }
      config.subtypeOverrides = { ...config.subtypeOverrides, [columnIndex]: subtype }
      copy[fileIndex] = config
      return copy
    })
  }, [])

  const setValueLabels = useCallback((
    fileIndex: number,
    columnIndex: number,
    value: { type: 'ordinal' | 'nominal'; rows: ValueLabelRow[] } | null,
  ) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      const config = { ...copy[fileIndex] }
      const vl = { ...config.valueLabels }
      if (value === null) delete vl[columnIndex]
      else vl[columnIndex] = value
      config.valueLabels = vl
      copy[fileIndex] = config
      return copy
    })
  }, [])

  const setColumnType = useCallback((fileIndex: number, columnIndex: number, newType: string) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      const config = { ...copy[fileIndex] }
      config.typeOverrides = { ...config.typeOverrides, [columnIndex]: newType }
      // Clear subtype if changing away from demographic
      if (newType !== 'demographic') {
        const { [columnIndex]: _, ...rest } = config.subtypeOverrides
        config.subtypeOverrides = rest
      }
      // #575: authored value labels apply only to ordinal/nominal — keep them
      // (retyped) when switching between those, drop them for any other type.
      if (config.valueLabels[columnIndex]) {
        if (newType === 'ordinal' || newType === 'nominal') {
          config.valueLabels = {
            ...config.valueLabels,
            [columnIndex]: { ...config.valueLabels[columnIndex], type: newType },
          }
        } else {
          const { [columnIndex]: _vl, ...restVL } = config.valueLabels
          config.valueLabels = restVL
        }
      }
      copy[fileIndex] = config
      return copy
    })
  }, [])

  // --- Update file config fields ---

  const updateFileConfig = useCallback((fileIndex: number, field: keyof FileConfig, value: string) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      copy[fileIndex] = { ...copy[fileIndex], [field]: value }
      return copy
    })
  }, [])

  // --- #414: participant-linking choices ---

  const setLinkParticipants = useCallback((fileIndex: number, enabled: boolean) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      copy[fileIndex] = { ...copy[fileIndex], linkParticipants: enabled }
      return copy
    })
  }, [])

  const setLinkColumnIndex = useCallback((fileIndex: number, columnIndex: number) => {
    setFileConfigs(prev => {
      const copy = [...prev]
      copy[fileIndex] = { ...copy[fileIndex], linkColumnIndex: columnIndex }
      return copy
    })
  }, [])

  // --- #973 (c): confirm a column selection and re-preview ---

  /** Tick or untick one column of the file currently being chosen. */
  const handleToggleSourceColumn = useCallback((fileIdx: number, columnIndex: number) => {
    setFileConfigs(prev => prev.map((c, i) => {
      if (i !== fileIdx || !c.columnChoice) return c
      const current = c.sourceColumnIndices
        ?? c.columnChoice.columns.map(col => col.column_index)
      const next = current.includes(columnIndex)
        ? current.filter(n => n !== columnIndex)
        : [...current, columnIndex].sort((a, b) => a - b)
      return { ...c, sourceColumnIndices: next }
    }))
  }, [])

  const handleSetSourceColumns = useCallback((fileIdx: number, indices: number[]) => {
    setFileConfigs(prev => prev.map((c, i) =>
      i === fileIdx ? { ...c, sourceColumnIndices: indices } : c))
  }, [])

  /**
   * Re-preview the chosen columns, then continue into the normal configure step.
   *
   * 🔴 The selection is STORED as well as sent, because the import has to send
   * the identical list: the server narrows the file to it, so `column_index`
   * throughout `previewColumns` is a position in the narrowed text.
   */
  const handleConfirmColumns = useCallback(async (fileIdx: number) => {
    const config = fileConfigs[fileIdx]
    const chosen = config?.sourceColumnIndices
    if (!config || !chosen || chosen.length === 0) return

    setOperation('preview')
    setIsLoading(true)
    setError('')
    setStatusMessage('Reading the selected columns…')
    try {
      const preview = await datasetsApi.preview(
        id, files[fileIdx], 'utf-8', config.sheetName ?? undefined, chosen,
      )
      const autoSkipped = new Set<number>()
      const autoSubtypes: Record<number, string> = {}
      for (const col of preview.columns) {
        if (col.suggested_type === 'skip') autoSkipped.add(col.column_index)
        if (col.suggested_type === 'demographic' && col.suggested_demographic_subtype) {
          autoSubtypes[col.column_index] = col.suggested_demographic_subtype
        }
      }
      setFileConfigs(prev => prev.map((c, i) => i === fileIdx ? {
        ...c,
        preview,
        previewColumns: preview.columns,
        skippedIndices: autoSkipped,
        typeOverrides: {},
        subtypeOverrides: autoSubtypes,
        previewError: null,
        columnChoice: null,
      } : c))
      // ⚠️ This wizard imports up to MAX_FILES at once, so MORE THAN ONE file
      // can be over the cap. Confirming one must hand over to the next rather
      // than jumping to configure and stranding it with a choice nobody is
      // shown — the step renders the first file that still has a `columnChoice`.
      const othersWaiting = fileConfigs.some(
        (c, i) => i !== fileIdx && c.columnChoice !== null,
      )
      if (othersWaiting) {
        setStatusMessage(
          `${preview.columns.length} column${preview.columns.length === 1 ? '' : 's'} selected. `
          + 'Another file also needs columns chosen.',
        )
        return
      }
      setStatusMessage(
        `Ready to configure. ${preview.columns.length} column${
          preview.columns.length === 1 ? '' : 's'} selected. Review the types, then import.`,
      )
      setStep('configure')
    } catch (err) {
      const msg = describeDatasetUploadError(err)
      setError(msg)
      setStatusMessage('The selected columns could not be read.')
    } finally {
      setIsLoading(false)
    }
  }, [fileConfigs, files, id])

  // --- Build column configs for import ---

  const buildColumnConfigs = useCallback((config: FileConfig): DatasetColumnConfig[] => {
    return config.previewColumns.map(col => {
      // #575: authored value labels drive both the scale metadata AND the column
      // type (ordinal/nominal) — a single source, so the type dropdown and the
      // editor's choice can't disagree. Only a VALID authored dict takes effect.
      const authored = config.valueLabels[col.column_index]
      const authoredPayload = authored && buildValueLabelPayload(authored.rows)
      if (authored && authoredPayload && authoredPayload.ok && authoredPayload.payload) {
        return {
          column_index: col.column_index,
          skip: config.skippedIndices.has(col.column_index),
          column_type: authored.type,
          column_text: col.suggested_column_text,
          column_code: col.suggested_column_code,
          column_name: col.suggested_column_name || null,
          group_code: col.suggested_group_code,
          group_label: null,
          scale_labels: authoredPayload.payload.map(p => p.label),
          scale_values: authoredPayload.payload.map(p => p.value),
          cells_are_codes: true,
          demographic_subtype: null,
        }
      }
      const effectiveType = config.typeOverrides[col.column_index] || col.suggested_type
      return {
        column_index: col.column_index,
        skip: config.skippedIndices.has(col.column_index),
        column_type: effectiveType,
        column_text: col.suggested_column_text,
        column_code: col.suggested_column_code,
        column_name: col.suggested_column_name || null,
        group_code: col.suggested_group_code,
        group_label: null,
        scale_labels: col.suggested_scale_labels,
        // #28: only .sav previews carry these; the backend falls back to a
        // positional 1..N encoding whenever they are absent or mismatched.
        scale_values: col.suggested_scale_values ?? null,
        demographic_subtype: effectiveType === 'demographic'
          ? (config.subtypeOverrides[col.column_index] || col.suggested_demographic_subtype || null)
          : null,
      }
    })
  }, [])

  // --- Can proceed from configure step? ---

  const configureStepValid = useMemo(() => {
    // #963 — wait for the name check while it is LOADING; proceed after a
    // FAILURE (see `existingDatasetsLoad`).
    if (existingDatasetsLoad.status === 'loading') return false
    return fileConfigs.every((config, i) => {
      if (config.previewError) return false // files with errors can't proceed
      if (!config.datasetName.trim()) return false
      if (nameDuplicates[i]) return false
      return true
    })
  }, [fileConfigs, nameDuplicates, existingDatasetsLoad.status])

  // --- Import ---

  const handleImport = useCallback(async () => {
    setError('')
    // Busy BEFORE the snapshot's request (#1047): the Import button is disabled
    // by `isLoading`, so a second press cannot start a second import while the
    // count is answered.
    setOperation('import')
    setIsLoading(true)
    hadParticipantsRef.current = await projectHadParticipants(queryClient, id)

    if (files.length === 1) {
      // Single file: import directly, navigate to ProjectView
      setStatusMessage(
        hasSlowFile
          ? `Importing. This is a large file and may take around ${estimatedImportSeconds} seconds.`
          : 'Importing…',
      )
      try {
        const config = fileConfigs[0]
        const result = await datasetsApi.import(id, files[0], {
          name: config.datasetName,
          description: config.datasetDescription || null,
          source: config.datasetSource || null,
          column_configs: buildColumnConfigs(config),
          sheet_name: config.sheetName,
          participant_link_column_index: effectiveLinkColumnIndex(config),
          // #973 (c): the SAME list the preview was narrowed by — see FileConfig.
          source_column_indices: config.sourceColumnIndices,
        })
        queryClient.invalidateQueries({ queryKey: ['datasets', id] })
        queryClient.invalidateQueries({ queryKey: ['project', id] })
        if (result.participant_link_report) {
          queryClient.invalidateQueries({ queryKey: ['participants', id] })
        }

        // Show single-file results inline
        setImportProgress({
          current: 1,
          results: [{
            fileName: files[0].name,
            datasetName: config.datasetName,
            status: 'success',
            datasetId: result.dataset_id,
            columnsCreated: result.columns_created,
            recordsCreated: result.rows_created,
            valuesCreated: result.values_created,
            recognizedMissingCount: result.recognized_missing_count,
            recognizedMissingLabels: result.recognized_missing_labels,
            valueLabelUnlabeledCount: Object.values(result.value_label_unlabeled ?? {}).reduce((a, v) => a + v.length, 0),
            linkReport: result.participant_link_report,
            overlongRecords: result.overlong_records,
          }],
        })
        // #1011: announce completion — failure already announced itself below,
        // success said nothing, so the region kept "Still working — 30 seconds…".
        setStatusMessage(
          `Import complete: “${config.datasetName}”, ${result.rows_created.toLocaleString()} records and ${countLabel(result.columns_created, 'column', 'columns')}.`,
        )
        setStep('results')
      } catch (err: unknown) {
        // #796/#797: the import re-runs the same parse the preview did, so it
        // can time out the same way — and 'Import failed' told the researcher
        // nothing about which of those it was.
        setError(describeDatasetUploadError(err))
        setStatusMessage('Import failed.')
      } finally {
        setIsLoading(false)
      }
    } else {
      // Multi-file: go to importing step
      setIsLoading(false)
      setStep('importing')
      handleBatchImport()
    }
    // `hasSlowFile`/`estimatedImportSeconds` added by hand: the disable below silences
    // exhaustive-deps for the WHOLE line, so a new capture here gets no warning.
    // Both derive from `files` via useMemo and `files` is already a dep, so the
    // closure cannot currently go stale — they are listed so it still cannot if
    // either memo's own deps widen later.
  }, [files, fileConfigs, id, buildColumnConfigs, queryClient, hasSlowFile, estimatedImportSeconds]) // eslint-disable-line react-hooks/exhaustive-deps -- handleBatchImport defined below; adding would cause TDZ error

  const handleBatchImport = useCallback(async () => {
    cancelledRef.current = false
    setImportProgress({ current: 0, results: [] })

    const results: ImportResult[] = []

    for (let i = 0; i < files.length; i++) {
      const config = fileConfigs[i]

      // Skip files with preview errors
      if (config.previewError) {
        results.push({
          fileName: files[i].name,
          datasetName: config.datasetName,
          status: 'error',
          error: `Preview error: ${config.previewError}`,
        })
        setImportProgress({ current: i + 1, results: [...results] })
        continue
      }

      if (cancelledRef.current) {
        results.push({
          fileName: files[i].name,
          datasetName: config.datasetName,
          status: 'cancelled',
        })
        setImportProgress({ current: i + 1, results: [...results] })
        continue
      }

      setImportProgress({ current: i, results: [...results] })

      try {
        const result = await datasetsApi.import(id, files[i], {
          name: config.datasetName,
          description: config.datasetDescription || null,
          source: config.datasetSource || null,
          column_configs: buildColumnConfigs(config),
          sheet_name: config.sheetName,
          participant_link_column_index: effectiveLinkColumnIndex(config),
          // #973 (c): the SAME list the preview was narrowed by — see FileConfig.
          source_column_indices: config.sourceColumnIndices,
        })
        results.push({
          fileName: files[i].name,
          datasetName: config.datasetName,
          status: 'success',
          datasetId: result.dataset_id,
          columnsCreated: result.columns_created,
          recordsCreated: result.rows_created,
          valuesCreated: result.values_created,
          recognizedMissingCount: result.recognized_missing_count,
          recognizedMissingLabels: result.recognized_missing_labels,
          valueLabelUnlabeledCount: Object.values(result.value_label_unlabeled ?? {}).reduce((a, v) => a + v.length, 0),
          linkReport: result.participant_link_report,
          overlongRecords: result.overlong_records,
        })
      } catch (err: unknown) {
        results.push({
          fileName: files[i].name,
          datasetName: config.datasetName,
          status: 'error',
          error: describeDatasetUploadError(err),
        })
      }

      setImportProgress({ current: i + 1, results: [...results] })
    }

    // Invalidate queries
    queryClient.invalidateQueries({ queryKey: ['datasets', id] })
    queryClient.invalidateQueries({ queryKey: ['project', id] })
    if (results.some(r => r.linkReport)) {
      queryClient.invalidateQueries({ queryKey: ['participants', id] })
    }

    // #1011: say it finished — the status region otherwise still holds the
    // last "Still working" line, which is what a reader hears on the results.
    const ok = results.filter(r => r.status === 'success').length
    setStatusMessage(
      ok === results.length
        ? `Import complete: ${ok} ${ok === 1 ? 'dataset' : 'datasets'} imported.`
        : `Import finished: ${ok} of ${results.length} datasets imported. See the results for the others.`,
    )
    setStep('results')
  }, [files, fileConfigs, id, buildColumnConfigs, queryClient])

  const handleReset = useCallback(() => {
    setStep('upload')
    setFiles([])
    setFileConfigs([])
    setExpandedFileIndex(0)
    setImportProgress({ current: 0, results: [] })
    setError('')
    cancelledRef.current = false
  }, [])

  // --- Step indicators ---

  // #1011: the column chooser is on the rail while it is part of this import —
  // it was absent, so the rail highlighted NO step while the chooser showed
  // (`findIndex` → -1) and the step heading had nothing to say.
  const usesColumnChooser =
    step === 'choose-columns' || fileConfigs.some(c => c.sourceColumnIndices != null)
  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    ...(usesColumnChooser ? [{ key: 'choose-columns' as Step, label: 'Choose columns' }] : []),
    { key: 'configure', label: 'Configure' },
    ...(isMultiFile ? [{ key: 'importing' as Step, label: 'Import' }] : []),
    { key: 'results', label: 'Results' },
  ]

  const stepIndex = steps.findIndex(s => s.key === step)
  const stepHeadingRef = useStepFocus(step)

  // --- Render helpers ---

  /** Type count summary for a single file config */
  const getTypeCounts = (config: FileConfig) => {
    const counts: Record<string, number> = {}
    for (const col of config.previewColumns) {
      const isSkipped = config.skippedIndices.has(col.column_index)
      const effectiveType = config.typeOverrides[col.column_index] || col.suggested_type
      const t = isSkipped ? 'skip' : effectiveType
      counts[t] = (counts[t] || 0) + 1
    }
    return counts
  }

  const getColumnCount = (config: FileConfig) =>
    config.previewColumns.filter(c => {
      const effectiveType = config.typeOverrides[c.column_index] || c.suggested_type
      return !config.skippedIndices.has(c.column_index) && effectiveType !== 'skip'
    }).length

  /** Render the configure panel body for a single file */
  const renderConfigurePanel = (config: FileConfig, fileIndex: number) => {
    if (config.previewError) {
      return (
        <div className="p-4 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 rounded-lg flex items-start gap-2">
          <CircleX className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Preview failed</p>
            <p className="text-sm mt-1">{config.previewError}</p>
          </div>
        </div>
      )
    }

    const typeCounts = getTypeCounts(config)
    const columnCount = getColumnCount(config)
    const skipCount = config.skippedIndices.size

    return (
      <div className="space-y-6">
        {/* Summary bar */}
        <div className="bg-mm-surface border rounded-lg px-4 py-3 flex flex-wrap gap-3 text-sm">
          <span className="font-medium">{countLabel(config.previewColumns.length, 'column', 'columns')}:</span>
          {Object.entries(typeCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <span
                key={type}
                className={cn(
                  'px-2 py-0.5 rounded',
                  type === 'skip' ? 'bg-mm-bg text-mm-text-muted' : 'bg-mm-blue/12 text-mm-blue-text',
                )}
              >
                {count} {type}
              </span>
            ))}
          {config.preview && (
            <span className="text-mm-text-muted ml-auto">{config.preview.total_rows.toLocaleString()} records</span>
          )}
        </div>

        {/* #985: rows whose values will land in the wrong columns — said BEFORE
            the import, where the researcher can still correct the file. */}
        <OverlongRecordsNotice report={config.preview?.overlong_records} stage="before" newDataset />

        {/* Worksheet picker (#523, .xlsx with multiple sheets only) */}
        {config.preview?.sheet_names && config.preview.sheet_names.length > 1 && (
          <div className="bg-mm-surface border rounded-lg px-4 py-3 flex items-center gap-3 text-sm">
            <label htmlFor={`sheet-picker-${fileIndex}`} className="font-medium">Worksheet</label>
            <select
              id={`sheet-picker-${fileIndex}`}
              value={config.sheetName ?? config.preview.sheet_names[0]}
              onChange={(e) => handleSheetChange(fileIndex, e.target.value)}
              disabled={isLoading}
              className="text-sm px-2 py-1 rounded border bg-mm-bg cursor-pointer"
            >
              {config.preview.sheet_names.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <span className="text-mm-text-muted">Only the selected worksheet is imported.</span>
          </div>
        )}

        {/* Skip Columns */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Skip Columns</CardTitle>
            <CardDescription>
              Check any columns to exclude from import. Metadata columns are auto-selected.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y max-h-[400px] overflow-y-auto">
              {config.previewColumns.map((col) => {
                const isSkipped = config.skippedIndices.has(col.column_index)
                // #575: authored value labels own the column type (ordinal/nominal).
                const authoredVL = config.valueLabels[col.column_index]
                const effectiveType: string = authoredVL?.type || config.typeOverrides[col.column_index] || col.suggested_type
                const isAutoSkip = col.suggested_type === 'skip'
                const typeBadgeClass = TYPE_BADGE_CLASSES[effectiveType] || 'bg-mm-bg text-mm-text-muted'
                // #364: values not in the matched scale keep their text but get
                // no number, so statistics leave them out. Since #1102 the server
                // reports only values NO known scale accounts for — so the note
                // states the consequence and never guesses the cause ("likely
                // typos" was wrong for the midpoint it used to name).
                // Only relevant while the column stays ordinal (the scale applies).
                const unmatchedScaleValues =
                  !isSkipped && effectiveType === 'ordinal'
                    ? col.suggested_scale_unmatched ?? []
                    : []
                return (
                  <div key={col.column_index}>
                  {/* #902: the row is a <div>, and the <label> wraps the checkbox
                      and the column name ONLY.
                      It used to wrap the whole row — checkbox, name, type select
                      and subtype select. A label binds to its FIRST labelable
                      descendant, so the selects got no name at all, and the
                      checkbox's name was computed from the label's whole subtree
                      and therefore INCLUDED the select's selected option text
                      (measured: `checkbox "Student_ID Identifier"`, changing
                      whenever the type changed). The `e.stopPropagation()` calls
                      on both selects existed only to stop a click inside the label
                      toggling the checkbox; un-nesting makes them dead, so they
                      are gone. */}
                  <div
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 hover:bg-mm-surface-hover transition-colors',
                      isSkipped && 'bg-mm-bg',
                    )}
                  >
                    <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSkipped}
                        onChange={() => toggleSkip(fileIndex, col.column_index)}
                        aria-label={`Skip ${col.suggested_column_text}`}
                        className="rounded border-mm-border-medium text-primary"
                      />
                      <span className={cn('flex-1 text-sm truncate', isSkipped && 'text-mm-text-faint line-through')}>
                        {col.suggested_column_text}
                        {col.suggested_column_code && (
                          <span className="text-mm-text-faint font-mono ml-2 text-xs">
                            {col.suggested_column_code}
                          </span>
                        )}
                      </span>
                    </label>
                    {isSkipped ? (
                      <span className="text-xs px-2 py-0.5 rounded flex-shrink-0 bg-mm-bg text-mm-text-faint">
                        {isAutoSkip ? 'Platform metadata' : TYPE_LABELS[effectiveType] || effectiveType}
                      </span>
                    ) : (
                      <select
                        value={effectiveType}
                        onChange={(e) => setColumnType(fileIndex, col.column_index, e.target.value)}
                        aria-label={`Column type for ${col.suggested_column_text}`}
                        className={cn(
                          'text-xs px-1.5 py-0.5 rounded font-medium border-none cursor-pointer flex-shrink-0',
                          typeBadgeClass,
                        )}
                      >
                        {COLUMN_TYPES.filter(t => t !== 'skip').map(t => (
                          <option key={t} value={t}>{TYPE_LABELS[t] || t}</option>
                        ))}
                      </select>
                    )}
                    {col.suggested_scale_name && !isSkipped && (
                      <span className="text-xs text-mm-text-faint flex-shrink-0">({col.suggested_scale_name})</span>
                    )}
                    {effectiveType === 'demographic' && !isSkipped && (
                      <select
                        value={config.subtypeOverrides[col.column_index] || ''}
                        onChange={(e) => setSubtype(fileIndex, col.column_index, e.target.value)}
                        aria-label={`Demographic subtype for ${col.suggested_column_text}`}
                        className="text-xs border border-mm-border-subtle rounded px-1.5 py-0.5 bg-mm-surface text-mm-text-secondary flex-shrink-0"
                      >
                        <option value="">Subtype...</option>
                        <option value="role">Role</option>
                        <option value="gender">Gender</option>
                        <option value="race">Race</option>
                        <option value="age">Age</option>
                        <option value="other">Other</option>
                      </select>
                    )}
                  </div>
                  {/* #575: value-labels authoring for a numbers-only scale column. */}
                  {col.all_numeric && !isSkipped && (
                    <ColumnValueLabelsControl
                      col={col}
                      authored={authoredVL}
                      onChange={(v) => setValueLabels(fileIndex, col.column_index, v)}
                    />
                  )}
                  {unmatchedScaleValues.length > 0 && (
                    <div
                      role="note"
                      className="flex items-start gap-1.5 px-4 pb-2 -mt-1 text-xs text-amber-700 dark:text-amber-400"
                    >
                      <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                      <span>
                        {unmatchedScaleValues.length === 1
                          ? '1 value is not'
                          : `${unmatchedScaleValues.length} values are not`} on the
                        {col.suggested_scale_name ? ` “${col.suggested_scale_name}” ` : ' '}
                        scale, so {unmatchedScaleValues.length === 1 ? 'it' : 'they'} will
                        import without a number and statistics will leave{' '}
                        {unmatchedScaleValues.length === 1 ? 'it' : 'them'} out:{' '}
                        {unmatchedScaleValues.slice(0, 3).map(v => `“${v}”`).join(', ')}
                        {unmatchedScaleValues.length > 3
                          ? `, +${unmatchedScaleValues.length - 3} more`
                          : ''}
                        . Correct {unmatchedScaleValues.length === 1 ? 'it' : 'them'} in
                        the file, or change the column type.
                      </span>
                    </div>
                  )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* #414 (DEC-6): participant linking — rendered only when the file has
            an identifier column (auto-detected or user-set above). */}
        {(() => {
          const idCols = identifierColumns(config)
          if (idCols.length === 0) return null
          const chosenIndex = config.linkColumnIndex != null && idCols.some(c => c.column_index === config.linkColumnIndex)
            ? config.linkColumnIndex
            : idCols[0].column_index
          return (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Participant Linking</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-start gap-2 text-sm">
                  <input
                    id={`link-participants-${fileIndex}`}
                    type="checkbox"
                    checked={config.linkParticipants}
                    onChange={(e) => setLinkParticipants(fileIndex, e.target.checked)}
                    className="mt-0.5 rounded border-mm-border-medium text-primary"
                  />
                  <span>
                    <label htmlFor={`link-participants-${fileIndex}`} className="cursor-pointer">
                      Link records to participants using{' '}
                      {idCols.length === 1 && <strong>{idCols[0].suggested_column_text}</strong>}
                    </label>
                    {idCols.length > 1 && (
                      <select
                        value={chosenIndex}
                        onChange={(e) => setLinkColumnIndex(fileIndex, parseInt(e.target.value))}
                        disabled={!config.linkParticipants}
                        aria-label="Identifier column to link by"
                        className="mx-1 h-7 text-sm border border-mm-border-medium rounded px-1 bg-mm-surface"
                      >
                        {idCols.map(c => (
                          <option key={c.column_index} value={c.column_index}>
                            {c.suggested_column_text}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                </div>
                <p className="text-xs text-mm-text-muted pl-6">
                  IDs matching an existing participant link to them; new IDs create
                  participants. Records with blank, N/A, or duplicated IDs stay
                  unlinked — you'll see a summary after import.
                </p>
              </CardContent>
            </Card>
          )
        })()}

        {/* Dataset Details */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Dataset Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${detailsId}-name-${fileIndex}`} className="text-sm">Dataset Name<span aria-hidden="true"> *</span></Label>
              <Input
                id={`${detailsId}-name-${fileIndex}`}
                aria-required="true"
                value={config.datasetName}
                onChange={(e) => updateFileConfig(fileIndex, 'datasetName', e.target.value)}
                placeholder="e.g., Board Assessment Survey"
                className={nameDuplicates[fileIndex] ? 'border-red-500' : ''}
              />
              {nameDuplicates[fileIndex] && (
                <p className="text-sm text-red-600 flex items-center gap-1">
                  <CircleAlert className="w-4 h-4" />
                  {nameDuplicates[fileIndex]}
                </p>
              )}
              {/* #963 — an absent warning must not read as "this name is free".
                  Beside the field, like the duplicate message it stands in for,
                  and not red: nothing is wrong with what was typed. */}
              {nameCheckFailed && (
                <p className="text-sm text-mm-text-muted flex items-center gap-1">
                  <CircleAlert className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                  Your existing datasets could not be loaded, so this name was not
                  checked against them. The import will still work.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor={`${detailsId}-desc-${fileIndex}`} className="text-sm">Description</Label>
                <Textarea
                  id={`${detailsId}-desc-${fileIndex}`}
                  value={config.datasetDescription}
                  onChange={(e) => updateFileConfig(fileIndex, 'datasetDescription', e.target.value)}
                  placeholder="Optional description..."
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${detailsId}-source-${fileIndex}`} className="text-sm">Source</Label>
                <Input
                  id={`${detailsId}-source-${fileIndex}`}
                  value={config.datasetSource}
                  onChange={(e) => updateFileConfig(fileIndex, 'datasetSource', e.target.value)}
                  placeholder="e.g., LimeSurvey"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Footer stats */}
        <div className="text-sm text-mm-text-muted">
          {countLabel(columnCount, 'column', 'columns')} from {countLabel(config.previewColumns.length, 'column', 'columns')} ({skipCount} skipped)
          {config.preview && <> &middot; {config.preview.total_rows} records</>}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* #796: the only non-visual signal for a 30s+ import. Polite, so it
            never interrupts; sr-only, because the same information is on screen
            for sighted users (the button label and the hint below it). */}
        <div role="status" aria-live="polite" className="sr-only">{statusMessage}</div>

        {/* Progress Steps */}
        <nav aria-label="Import progress" className="flex items-center justify-between mb-8">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center" aria-current={stepIndex === i ? 'step' : undefined}>
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
                  stepIndex === i
                    ? 'bg-mm-orange-fill text-mm-on-fill'
                    : stepIndex > i
                    ? 'bg-[hsl(var(--mm-orange)/0.15)] text-[hsl(var(--mm-orange-text))]'
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

        {/* #1011: the element focus lands on when the step changes — visually
            hidden, because the rail above already shows the step on screen. */}
        <h2 ref={stepHeadingRef} tabIndex={-1} className="sr-only">
          {stepIndex >= 0 ? `Step ${stepIndex + 1} of ${steps.length}: ${steps[stepIndex].label}` : ''}
        </h2>

        {error && (
          <div role="alert" className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 rounded-lg flex items-start gap-2">
            <CircleAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <Card>
            <CardHeader>
              <CardTitle>Upload data files</CardTitle>
              <CardDescription>
                Upload one or more {DATASET_FORMAT_LABEL} files. Each file will be imported as a separate dataset.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* #560a: plain div + guarded click-to-browse; the Button below is the
                  accessible control (real <button> — focusable, named, honors `disabled`).
                  See lib/drop-zone.ts for why role="button" must NOT come back. */}
              <div
                className="border-2 border-dashed rounded-lg p-12 text-center hover:border-[hsl(var(--mm-orange)/0.5)] transition-colors"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={(e) => openPickerFromZoneClick(e, () => datasetInputRef.current?.click())}
              >
                <FileInput className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
                <p className="text-mm-text-secondary mb-4">
                  Drag and drop {DATASET_FORMAT_LABEL} file(s) here, or click to browse
                </p>
                <UploadLimitNote noun="dataset files" className="-mt-2 mb-4" />
                <input
                  ref={datasetInputRef}
                  type="file"
                  accept={DATASET_ACCEPT}
                  multiple
                  onChange={(e) => {
                    const selected = e.target.files
                    if (selected && selected.length > 0) {
                      handleFilesSelected(Array.from(selected))
                    }
                    e.target.value = ''
                  }}
                  className="hidden"
                  id="dataset-file-input"
                />
                <Button
                  onClick={() => datasetInputRef.current?.click()}
                  disabled={isLoading}
                  className="bg-mm-orange-fill hover:opacity-90 text-mm-on-fill"
                >
                  {isLoading ? 'Processing...' : 'Select Files'}
                </Button>
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
                        {formatBytes(f.size)}
                      </span>
                      <button
                        onClick={() => handleRemoveFile(i)}
                        className="p-1 hover:bg-mm-surface-hover rounded"
                        aria-label={`Remove ${f.name}`}
                        title={`Remove ${f.name}`}
                      >
                        <X className="w-3 h-3 text-mm-text-muted" />
                      </button>
                    </div>
                  ))}

                  {files.length >= MAX_FILES && (
                    <p className="text-sm text-amber-600">Maximum of {MAX_FILES} files reached.</p>
                  )}

                  <div className="flex justify-between items-center pt-2">
                    <div>
                      <input
                        ref={datasetAddMoreInputRef}
                        type="file"
                        accept={DATASET_ACCEPT}
                        multiple
                        onChange={(e) => {
                          const selected = e.target.files
                          if (selected && selected.length > 0) {
                            handleFilesSelected(Array.from(selected))
                          }
                          e.target.value = ''
                        }}
                        className="hidden"
                        id="dataset-file-input-add"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => datasetAddMoreInputRef.current?.click()}
                      >
                        Add More Files
                      </Button>
                    </div>
                    <Button
                      onClick={handlePreviewAll}
                      // #1133 — busy is `aria-disabled` + the handler's guard,
                      // never `disabled`: Chrome blurs a focused button that
                      // becomes disabled, so a refused file's alert appeared
                      // with focus on <body> (#965's class; Batch 16 fixed
                      // Coding Import's two buttons the same way).
                      disabled={files.length === 0}
                      aria-disabled={isLoading || undefined}
                      aria-busy={isLoading || undefined}
                      className="relative overflow-hidden"
                    >
                      {isLoading && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 bg-white/30 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                          style={{ width: `${(progress * 100).toFixed(1)}%` }}
                        />
                      )}
                      <span className="relative">{isLoading ? 'Reading…' : 'Next'}</span>
                    </Button>
                  </div>
                  {/* #796 (usability half): a big workbook is ~30s+ of silent
                      server work. Saying so beforehand is what stops it reading
                      as a hang — the abort it replaces looked like a bad file. */}
                  {hasSlowFile && !isLoading && (
                    <p className="text-xs text-mm-text-muted text-right mt-2">
                      Large {files.length === 1 ? 'file' : 'files'} — reading{' '}
                      {files.length === 1 ? 'this' : 'these'} may take around {estimatedSeconds} seconds.
                    </p>
                  )}
                  {isLoading && (
                    <p className="text-xs text-mm-text-muted text-right mt-2">
                      {elapsedNote(elapsed, activeEstimate, overEstimate)}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 1b (#973 c): choose columns — reached ONLY when the cell cap
            refused this file, and skipped entirely by every import that fits. */}
        {step === 'choose-columns' && (() => {
          const fileIdx = fileConfigs.findIndex(c => c.columnChoice !== null)
          const config = fileConfigs[fileIdx]
          if (!config?.columnChoice) return null
          const all = config.columnChoice.columns.map(c => c.column_index)
          const selected = new Set(config.sourceColumnIndices ?? all)
          return (
            <Card>
              <CardContent className="pt-6">
                <DatasetColumnChooser
                  fileName={files[fileIdx]?.name ?? ''}
                  summary={config.columnChoice}
                  selected={selected}
                  busy={isLoading}
                  onToggle={col => handleToggleSourceColumn(fileIdx, col)}
                  onSelectAll={() => handleSetSourceColumns(fileIdx, all)}
                  onSelectNone={() => handleSetSourceColumns(fileIdx, [])}
                  onContinue={() => handleConfirmColumns(fileIdx)}
                  onCancel={() => { setStep('upload'); setError('') }}
                />
                {error && (
                  <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}
              </CardContent>
            </Card>
          )
        })()}

        {/* Step 2: Configure */}
        {step === 'configure' && (
          <div className="space-y-6">
            {/* Single file: flat layout */}
            {!isMultiFile && fileConfigs[0] && (
              <>
                {renderConfigurePanel(fileConfigs[0], 0)}
                {/* #796b: `justify-between` distributes ALL its children, so the
                    elapsed note below must NOT be a third child of this row —
                    adding one made the Back/Import pair jump from the right edge
                    to the centre the instant the import started. The row keeps
                    exactly two children; the note is a sibling of the ROW. */}
                <div className="pt-2">
                  <div className="flex items-center justify-between">
                  <div /> {/* spacer */}
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setStep('upload')}>
                      Back
                    </Button>
                    <Button
                      onClick={handleImport}
                      disabled={!configureStepValid || isLoading}
                      className="bg-mm-orange-fill hover:opacity-90 text-mm-on-fill relative overflow-hidden"
                    >
                      {isLoading && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 bg-white/30 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                          style={{ width: `${(progress * 100).toFixed(1)}%` }}
                        />
                      )}
                      <span className="relative">{isLoading ? (operation === 'import' ? 'Importing…' : 'Reading…') : 'Import Dataset'}</span>
                    </Button>
                  </div>
                  </div>
                  {/* #796b: the import is the SLOW phase (it writes every cell),
                      so it needs the elapsed note more than the preview did. */}
                  {isLoading && (
                    <p className="text-xs text-mm-text-muted text-right mt-2">
                      {elapsedNote(elapsed, activeEstimate, overEstimate)}
                    </p>
                  )}
                </div>
              </>
            )}

            {/* Multi-file: accordion layout */}
            {isMultiFile && (
              <>
                <div className="p-3 bg-mm-blue/12 text-mm-blue-text rounded-lg text-sm flex items-center gap-2">
                  <CircleAlert className="w-4 h-4 flex-shrink-0" />
                  Each file will be imported as a separate dataset. Configure skip columns and details for each.
                </div>

                <div className="space-y-2">
                  {files.map((f, i) => {
                    const config = fileConfigs[i]
                    if (!config) return null
                    const isExpanded = expandedFileIndex === i
                    const hasError = !!config.previewError
                    const hasNameIssue = !config.datasetName.trim() || !!nameDuplicates[i]
                    const hasOverlong = (config.preview?.overlong_records?.count ?? 0) > 0

                    return (
                      <div key={i} className="border rounded-lg overflow-hidden">
                        {/* Accordion header */}
                        <button
                          className={cn(
                            'w-full flex items-center gap-3 p-3 text-left hover:bg-mm-surface-hover transition-colors',
                            isExpanded && 'bg-mm-bg'
                          )}
                          onClick={() => setExpandedFileIndex(isExpanded ? -1 : i)}
                          aria-expanded={isExpanded}
                          aria-describedby={`file-status-${i}`}
                        >
                          <ChevronDown className={cn(
                            'w-4 h-4 text-mm-text-faint transition-transform',
                            !isExpanded && '-rotate-90'
                          )} />
                          <FileText className="w-4 h-4 text-mm-text-faint flex-shrink-0" />
                          <span className="flex-1 text-sm font-medium truncate">{f.name}</span>
                          {!hasError && config.preview && (
                            <>
                              <span className="text-xs text-mm-text-muted flex-shrink-0">
                                {countLabel(getColumnCount(config), 'column', 'columns')}
                              </span>
                              <span className="text-xs text-mm-text-faint flex-shrink-0">
                                {config.preview.total_rows.toLocaleString()} records
                              </span>
                            </>
                          )}
                          {/* The status was an icon alone — colour and shape, no
                              words — so a collapsed file's problem was invisible to
                              a screen reader, and #985's warning, which lives in the
                              collapsed body, to everyone. The icon now has a state
                              for it, and every state is said in words: as the
                              button's DESCRIPTION, never its name, because it
                              changes as the name field below is edited (#770). */}
                          {hasError ? (
                            <CircleX aria-hidden="true" className="w-4 h-4 text-red-500 flex-shrink-0" />
                          ) : hasNameIssue || hasOverlong ? (
                            <CircleAlert aria-hidden="true" className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          ) : (
                            <CircleCheck aria-hidden="true" className="w-4 h-4 text-green-500 flex-shrink-0" />
                          )}
                        </button>
                        <span id={`file-status-${i}`} hidden>
                          {hasError
                            ? 'Preview failed.'
                            : hasNameIssue
                              ? 'Needs a unique dataset name.'
                              : hasOverlong
                                ? 'Some rows have more values than there are column headings.'
                                : 'Ready to import.'}
                        </span>

                        {/* Accordion body */}
                        {isExpanded && (
                          <div className="p-4 border-t">
                            {renderConfigurePanel(config, i)}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* #796b: `justify-between` distributes ALL its children, so the
                    elapsed note below must NOT be a third child of this row —
                    adding one made the Back/Import pair jump from the right edge
                    to the centre the instant the import started. The row keeps
                    exactly two children; the note is a sibling of the ROW. */}
                <div className="pt-2">
                  <div className="flex items-center justify-between">
                  <div /> {/* spacer */}
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setStep('upload')}>
                      Back
                    </Button>
                    <Button
                      onClick={handleImport}
                      disabled={!configureStepValid || isLoading}
                      className="bg-mm-orange-fill hover:opacity-90 text-mm-on-fill relative overflow-hidden"
                    >
                      {isLoading && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 bg-white/30 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                          style={{ width: `${(progress * 100).toFixed(1)}%` }}
                        />
                      )}
                      <span className="relative">{isLoading ? (operation === 'import' ? 'Importing…' : 'Reading…') : `Import ${files.length} Datasets`}</span>
                    </Button>
                  </div>
                  </div>
                  {/* #796b: the import is the SLOW phase (it writes every cell),
                      so it needs the elapsed note more than the preview did. */}
                  {isLoading && (
                    <p className="text-xs text-mm-text-muted text-right mt-2">
                      {elapsedNote(elapsed, activeEstimate, overEstimate)}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 3: Importing (multi-file only) */}
        {step === 'importing' && (
          <Card>
            <CardHeader>
              <CardTitle>Importing Datasets</CardTitle>
              <CardDescription>
                Importing {files.length} datasets. This may take a moment.
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
                      <span className="truncate">{r.datasetName}</span>
                      {r.columnsCreated != null && (
                        <span className="text-mm-text-faint flex-shrink-0">
                          {countLabel(r.columnsCreated, 'column', 'columns')}, {countLabel(r.recordsCreated ?? 0, 'record', 'records')}
                        </span>
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

        {/* Step 4: Results */}
        {step === 'results' && (
          <Card>
            <CardHeader>
              <CardTitle>Import Complete</CardTitle>
              <CardDescription>
                {(() => {
                  const successCount = importProgress.results.filter(r => r.status === 'success').length
                  const total = importProgress.results.length
                  if (total === 1 && successCount === 1) return 'Dataset has been imported successfully'
                  return successCount === total
                    ? `All ${total} datasets imported successfully.`
                    : `${successCount} of ${total} datasets imported successfully.`
                })()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Single file result */}
              {!isMultiFile && importProgress.results[0]?.status === 'success' && (
                <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 rounded-lg space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium mb-3">
                    <Check className="w-5 h-5" />
                    Import successful
                  </div>
                  <div><strong>Dataset:</strong> {importProgress.results[0].datasetName}</div>
                  <div><strong>Columns created:</strong> {importProgress.results[0].columnsCreated}</div>
                  <div><strong>Records imported:</strong> {importProgress.results[0].recordsCreated?.toLocaleString()}</div>
                  <div><strong>Values stored:</strong> {importProgress.results[0].valuesCreated?.toLocaleString()}</div>
                  <RecognizedMissingNote
                    count={importProgress.results[0].recognizedMissingCount}
                    labels={importProgress.results[0].recognizedMissingLabels}
                    projectId={id}
                  />
                  <OverlongRecordsNotice
                    report={importProgress.results[0].overlongRecords}
                    stage="after"
                    newDataset
                    datasetPath={`/projects/${id}/datasets/${importProgress.results[0].datasetId}`}
                  />
                  {(importProgress.results[0].valueLabelUnlabeledCount ?? 0) > 0 && (
                    <div role="note" className="pt-1 text-xs text-amber-700 dark:text-amber-400">
                      {importProgress.results[0].valueLabelUnlabeledCount} observed code
                      {importProgress.results[0].valueLabelUnlabeledCount === 1 ? '' : 's'} had no
                      label and imported as plain numbers — add value labels for them from the
                      dataset's column menu.
                    </div>
                  )}
                  <ParticipantLinkNote
                    report={importProgress.results[0].linkReport}
                    projectId={id}
                    hadParticipants={hadParticipantsRef.current}
                  />
                </div>
              )}

              {/* #407/#414: surface the participant spine at import time —
                  when linking just ran, point at reviewing instead of connecting */}
              {importProgress.results.some(r => (r.linkReport?.linked ?? 0) > 0) ? (
                <p className="text-xs text-mm-text-muted">
                  Records were linked to participants, so each person is one identity
                  across their data and their words. Review them on the{' '}
                  <Link to={`/projects/${id}/participants`} className="text-mm-blue-text hover:underline">
                    Participants page
                  </Link>.
                </p>
              ) : (
                <p className="text-xs text-mm-text-muted">
                  Have interviews or focus groups too? Connect these records to
                  people on the{' '}
                  <Link to={`/projects/${id}/participants`} className="text-mm-blue-text hover:underline">
                    Participants page
                  </Link>{' '}
                  so each person is one identity across their data and their words.
                </p>
              )}

              {/* Multi-file results */}
              {isMultiFile && (
                <>
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

                  {/* Per-file result cards */}
                  <div className="space-y-2">
                    {importProgress.results.map((r, i) => (
                      <div
                        key={i}
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
                          <div className="font-medium truncate">{r.datasetName}</div>
                          <div className="text-xs text-mm-text-muted">{r.fileName}</div>
                        </div>
                        {r.columnsCreated != null && (
                          <span className="text-mm-text-muted flex-shrink-0 text-xs">
                            {countLabel(r.columnsCreated, 'column', 'columns')}, {plural(r.recordsCreated ?? 0, '1 record', `${(r.recordsCreated ?? 0).toLocaleString()} records`)}, {(r.valuesCreated ?? 0).toLocaleString()} values
                            <RecognizedMissingNote count={r.recognizedMissingCount} compact />
                            <OverlongRecordsNotice report={r.overlongRecords} stage="after" newDataset compact />
                            <ParticipantLinkNote report={r.linkReport} compact />
                          </span>
                        )}
                        {r.error && (
                          <span className="text-red-600 text-xs truncate max-w-[200px]" title={r.error}>
                            {r.error}
                          </span>
                        )}
                        {r.status === 'success' && r.datasetId && (
                          <Link
                            to={`/projects/${id}/datasets/${r.datasetId}`}
                            className="text-primary hover:underline text-xs flex-shrink-0"
                          >
                            Open
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={handleReset}>
                  Import More
                </Button>
                <Button onClick={() => navigate(`/projects/${id}/datasets`)} className="bg-mm-orange-fill hover:opacity-90 text-mm-on-fill">
                  {isMultiFile ? 'Return to Project' : 'Done'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
