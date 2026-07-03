import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileInput, Check, ChevronRight, ChevronDown, CircleAlert, X, FileText, LoaderCircle, CircleCheck, CircleX, Ban, TriangleAlert } from 'lucide-react'
import { datasetsApi, type DatasetPreviewResponse, type DatasetColumnPreview, type DatasetColumnConfig } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { consumePendingImportFiles } from '@/lib/pending-import-files'
import { COLUMN_TYPES, TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'

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
  skip: 'Skip',
}

type Step = 'upload' | 'configure' | 'importing' | 'results'

interface FileConfig {
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
  error?: string
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

export default function DatasetImport() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const id = parseInt(projectId || '0')

  const [step, setStep] = useState<Step>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [fileConfigs, setFileConfigs] = useState<FileConfig[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  // Accordion state for configure step (multi-file)
  const [expandedFileIndex, setExpandedFileIndex] = useState<number>(0)

  // Import progress
  const [importProgress, setImportProgress] = useState<{
    current: number
    results: ImportResult[]
  }>({ current: 0, results: [] })
  const cancelledRef = useRef(false)

  const isMultiFile = files.length > 1

  // Pick up files staged by drag-drop on ProjectView empty tab
  useEffect(() => {
    const pending = consumePendingImportFiles('dataset')
    if (pending) handleFilesSelected(pending)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch existing datasets for name collision detection
  const { data: existingDatasets } = useQuery({
    queryKey: ['datasets', id],
    queryFn: () => datasetsApi.list(id),
    enabled: !!id,
  })

  const existingDatasetNames = useMemo(
    () => (existingDatasets?.datasets || []).map(d => d.name.toLowerCase()),
    [existingDatasets]
  )

  // Check for duplicate dataset names (existing + within batch)
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
    const csvFiles = selectedFiles.filter(f => /\.(csv|xlsx)$/.test(f.name.toLowerCase()))
    if (csvFiles.length === 0) return

    const newFiles = [...files, ...csvFiles].slice(0, MAX_FILES)
    const addedCount = newFiles.length - files.length
    if (addedCount < csvFiles.length) {
      setError(`File limit is ${MAX_FILES}. Only ${addedCount} file(s) added.`)
    }

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

  const handlePreviewAll = useCallback(async () => {
    setIsLoading(true)
    setError('')

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
          }
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : 'Failed to parse CSV'
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

    setFileConfigs(newConfigs)
    setIsLoading(false)

    // Check if all files failed
    const allFailed = newConfigs.every(c => c.previewError !== null)
    if (allFailed) {
      setError('All files failed to preview. Please check your CSV files.')
      return
    }

    if (errors.length > 0) {
      setError(`${errors.length} file(s) had preview errors. You can remove them and continue.`)
    }

    setStep('configure')
  }, [files, fileConfigs, id])

  // --- Worksheet change (#523, .xlsx only): re-preview ONE file on its new sheet ---

  const handleSheetChange = useCallback(async (fileIndex: number, sheetName: string) => {
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
        }
        return copy
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to preview worksheet')
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

  // --- Build column configs for import ---

  const buildColumnConfigs = useCallback((config: FileConfig): DatasetColumnConfig[] => {
    return config.previewColumns.map(col => {
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
        demographic_subtype: effectiveType === 'demographic'
          ? (config.subtypeOverrides[col.column_index] || col.suggested_demographic_subtype || null)
          : null,
      }
    })
  }, [])

  // --- Can proceed from configure step? ---

  const configureStepValid = useMemo(() => {
    return fileConfigs.every((config, i) => {
      if (config.previewError) return false // files with errors can't proceed
      if (!config.datasetName.trim()) return false
      if (nameDuplicates[i]) return false
      return true
    })
  }, [fileConfigs, nameDuplicates])

  // --- Import ---

  const handleImport = useCallback(async () => {
    setError('')

    if (files.length === 1) {
      // Single file: import directly, navigate to ProjectView
      setIsLoading(true)
      try {
        const config = fileConfigs[0]
        const result = await datasetsApi.import(id, files[0], {
          name: config.datasetName,
          description: config.datasetDescription || null,
          source: config.datasetSource || null,
          column_configs: buildColumnConfigs(config),
          sheet_name: config.sheetName,
        })
        queryClient.invalidateQueries({ queryKey: ['datasets', id] })
        queryClient.invalidateQueries({ queryKey: ['project', id] })

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
          }],
        })
        setStep('results')
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Import failed')
      } finally {
        setIsLoading(false)
      }
    } else {
      // Multi-file: go to importing step
      setStep('importing')
      handleBatchImport()
    }
  }, [files, fileConfigs, id, buildColumnConfigs, queryClient]) // eslint-disable-line react-hooks/exhaustive-deps -- handleBatchImport defined below; adding would cause TDZ error

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
        })
      } catch (err: unknown) {
        results.push({
          fileName: files[i].name,
          datasetName: config.datasetName,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }

      setImportProgress({ current: i + 1, results: [...results] })
    }

    // Invalidate queries
    queryClient.invalidateQueries({ queryKey: ['datasets', id] })
    queryClient.invalidateQueries({ queryKey: ['project', id] })

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

  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'configure', label: 'Configure' },
    ...(isMultiFile ? [{ key: 'importing' as Step, label: 'Import' }] : []),
    { key: 'results', label: 'Results' },
  ]

  const stepIndex = steps.findIndex(s => s.key === step)

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
          <span className="font-medium">{config.previewColumns.length} columns:</span>
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
            <span className="text-mm-text-muted ml-auto">{config.preview.total_rows} records</span>
          )}
        </div>

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
                const effectiveType = config.typeOverrides[col.column_index] || col.suggested_type
                const isAutoSkip = col.suggested_type === 'skip'
                const typeBadgeClass = TYPE_BADGE_CLASSES[effectiveType] || 'bg-mm-bg text-mm-text-muted'
                // #364: stray values not in the matched scale import as blank.
                // Only relevant while the column stays ordinal (the scale applies).
                const unmatchedScaleValues =
                  !isSkipped && effectiveType === 'ordinal'
                    ? col.suggested_scale_unmatched ?? []
                    : []
                return (
                  <div key={col.column_index}>
                  <label
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-mm-surface-hover transition-colors',
                      isSkipped && 'bg-mm-bg',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSkipped}
                      onChange={() => toggleSkip(fileIndex, col.column_index)}
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
                    {isSkipped ? (
                      <span className="text-xs px-2 py-0.5 rounded flex-shrink-0 bg-mm-bg text-mm-text-faint">
                        {isAutoSkip ? 'Platform metadata' : TYPE_LABELS[effectiveType] || effectiveType}
                      </span>
                    ) : (
                      <select
                        value={effectiveType}
                        onChange={(e) => {
                          e.stopPropagation()
                          setColumnType(fileIndex, col.column_index, e.target.value)
                        }}
                        onClick={(e) => e.stopPropagation()}
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
                        onChange={(e) => {
                          e.stopPropagation()
                          setSubtype(fileIndex, col.column_index, e.target.value)
                        }}
                        onClick={(e) => e.stopPropagation()}
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
                  </label>
                  {unmatchedScaleValues.length > 0 && (
                    <div
                      role="note"
                      className="flex items-start gap-1.5 px-4 pb-2 -mt-1 text-xs text-amber-700 dark:text-amber-400"
                    >
                      <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                      <span>
                        {unmatchedScaleValues.length} value
                        {unmatchedScaleValues.length === 1 ? '' : 's'} not in the
                        {col.suggested_scale_name ? ` “${col.suggested_scale_name}” ` : ' '}
                        scale will import blank:{' '}
                        {unmatchedScaleValues.slice(0, 3).map(v => `“${v}”`).join(', ')}
                        {unmatchedScaleValues.length > 3
                          ? `, +${unmatchedScaleValues.length - 3} more`
                          : ''}
                        . Likely typos — fix in the source CSV or change the column type.
                      </span>
                    </div>
                  )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Dataset Details */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Dataset Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm">Dataset Name *</Label>
              <Input
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
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm">Description</Label>
                <Textarea
                  value={config.datasetDescription}
                  onChange={(e) => updateFileConfig(fileIndex, 'datasetDescription', e.target.value)}
                  placeholder="Optional description..."
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Source</Label>
                <Input
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
          {columnCount} columns from {config.previewColumns.length} columns ({skipCount} skipped)
          {config.preview && <> &middot; {config.preview.total_rows} records</>}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Progress Steps */}
        <nav aria-label="Import progress" className="flex items-center justify-between mb-8">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center" aria-current={stepIndex === i ? 'step' : undefined}>
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
                  stepIndex === i
                    ? 'bg-[hsl(var(--mm-orange))] text-white'
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

        {error && (
          <div role="alert" className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded-lg flex items-start gap-2">
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
                Upload one or more CSV or Excel (.xlsx) files. Each file will be imported as a separate dataset.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="border-2 border-dashed rounded-lg p-12 text-center hover:border-[hsl(var(--mm-orange)/0.5)] transition-colors"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                role="button"
                tabIndex={0}
                aria-label="Drop zone for file upload, or press Enter to select files"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('dataset-file-input')?.click() } }}
              >
                <FileInput className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
                <p className="text-mm-text-secondary mb-4">
                  Drag and drop CSV or Excel file(s) here, or click to browse
                </p>
                <input
                  type="file"
                  accept=".csv,.xlsx"
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
                <label htmlFor="dataset-file-input">
                  <Button asChild disabled={isLoading} className="bg-[hsl(var(--mm-orange))] hover:opacity-90 text-white">
                    <span>{isLoading ? 'Processing...' : 'Select Files'}</span>
                  </Button>
                </label>
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
                    <label htmlFor="dataset-file-input-add" className="cursor-pointer">
                      <input
                        type="file"
                        accept=".csv,.xlsx"
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
                      <Button variant="outline" size="sm" asChild>
                        <span>Add More Files</span>
                      </Button>
                    </label>
                    <Button
                      onClick={handlePreviewAll}
                      disabled={files.length === 0 || isLoading}
                    >
                      {isLoading ? 'Analyzing...' : 'Next'}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 2: Configure */}
        {step === 'configure' && (
          <div className="space-y-6">
            {/* Single file: flat layout */}
            {!isMultiFile && fileConfigs[0] && (
              <>
                {renderConfigurePanel(fileConfigs[0], 0)}
                <div className="flex items-center justify-between pt-2">
                  <div /> {/* spacer */}
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setStep('upload')}>
                      Back
                    </Button>
                    <Button
                      onClick={handleImport}
                      disabled={!configureStepValid || isLoading}
                      className="bg-[hsl(var(--mm-orange))] hover:opacity-90 text-white"
                    >
                      {isLoading ? 'Importing...' : 'Import Dataset'}
                    </Button>
                  </div>
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
                          {!hasError && config.preview && (
                            <>
                              <span className="text-xs text-mm-text-muted flex-shrink-0">
                                {getColumnCount(config)} columns
                              </span>
                              <span className="text-xs text-mm-text-faint flex-shrink-0">
                                {config.preview.total_rows} records
                              </span>
                            </>
                          )}
                          {hasError ? (
                            <CircleX className="w-4 h-4 text-red-500 flex-shrink-0" />
                          ) : hasNameIssue ? (
                            <CircleAlert className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          ) : (
                            <CircleCheck className="w-4 h-4 text-green-500 flex-shrink-0" />
                          )}
                        </button>

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

                <div className="flex items-center justify-between pt-2">
                  <div /> {/* spacer */}
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setStep('upload')}>
                      Back
                    </Button>
                    <Button
                      onClick={handleImport}
                      disabled={!configureStepValid || isLoading}
                      className="bg-[hsl(var(--mm-orange))] hover:opacity-90 text-white"
                    >
                      {isLoading ? 'Importing...' : `Import ${files.length} Datasets`}
                    </Button>
                  </div>
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
                          {r.columnsCreated} columns, {r.recordsCreated} records
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
                  <div><strong>Records imported:</strong> {importProgress.results[0].recordsCreated}</div>
                  <div><strong>Values stored:</strong> {importProgress.results[0].valuesCreated}</div>
                  <RecognizedMissingNote
                    count={importProgress.results[0].recognizedMissingCount}
                    labels={importProgress.results[0].recognizedMissingLabels}
                    projectId={id}
                  />
                </div>
              )}

              {/* #407: surface the participant spine at import time */}
              <p className="text-xs text-mm-text-muted">
                Have interviews or focus groups too? Connect these records to
                people on the{' '}
                <Link to={`/projects/${id}/participants`} className="text-mm-blue-text hover:underline">
                  Participants page
                </Link>{' '}
                so each person is one identity across their data and their words.
              </p>

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
                            {r.columnsCreated} columns, {r.recordsCreated} records, {r.valuesCreated} values
                            <RecognizedMissingNote count={r.recognizedMissingCount} compact />
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
                <Button onClick={() => navigate(`/projects/${id}/datasets`)} className="bg-[hsl(var(--mm-orange))] hover:opacity-90 text-white">
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
