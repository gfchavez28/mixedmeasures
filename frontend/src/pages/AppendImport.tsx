import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { FileInput, Check, ChevronRight, TriangleAlert, Link2, FileQuestion } from 'lucide-react'
import {
  datasetsApi,
  type DatasetAppendPreviewResponse,
  type DatasetAppendResponse,
  type AppendMatchedColumn,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { DATASET_ACCEPT, DATASET_FORMAT_LABEL, isSupportedDatasetFile } from '@/lib/dataset-import-formats'

type Step = 'upload' | 'review' | 'results'

const ENCODINGS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'windows-1252', label: 'Windows-1252' },
  { value: 'iso-8859-1', label: 'ISO-8859-1' },
]

export default function AppendImport() {
  const { projectId, datasetId } = useParams<{ projectId: string; datasetId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pid = parseInt(projectId || '0')
  const did = parseInt(datasetId || '0')
  const { setBreadcrumbLabel } = useProjectLayout()

  const { data: dataset } = useQuery({
    queryKey: ['dataset', pid, did],
    queryFn: () => datasetsApi.get(pid, did),
    enabled: !!pid && !!did,
  })

  useEffect(() => {
    if (dataset?.name) setBreadcrumbLabel(dataset.name)
  }, [dataset?.name, setBreadcrumbLabel])

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [encoding, setEncoding] = useState('utf-8')
  // .xlsx only (#523): selected worksheet; null = first sheet.
  const [sheetName, setSheetName] = useState<string | null>(null)
  const [preview, setPreview] = useState<DatasetAppendPreviewResponse | null>(null)
  const [importResult, setImportResult] = useState<DatasetAppendResponse | null>(null)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [showAllRows, setShowAllRows] = useState(false)
  // #414 (DEC-7): link NEW rows by the dataset's identifier column when the
  // preview offers one (exactly one identifier column, matched by this file).
  const [linkParticipants, setLinkParticipants] = useState(true)

  const handleFileSelect = useCallback(async (selectedFile: File, sheet?: string) => {
    setFile(selectedFile)
    setError('')
    setIsLoading(true)

    try {
      const result = await datasetsApi.appendPreview(pid, did, selectedFile, encoding, sheet)
      setPreview(result)
      setSheetName(sheet ?? null)
      setStep('review')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(typeof detail === 'string' ? detail : (err instanceof Error ? err.message : 'Failed to preview file'))
    } finally {
      setIsLoading(false)
    }
  }, [pid, did, encoding])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const droppedFile = e.dataTransfer.files[0]
      if (droppedFile && isSupportedDatasetFile(droppedFile.name)) {
        handleFileSelect(droppedFile)
      }
    },
    [handleFileSelect],
  )

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file || !preview) throw new Error('No file or preview')
      return datasetsApi.appendImport(pid, did, file, {
        column_mapping: preview.matched_columns.map(mc => ({
          csv_column_index: mc.csv_column_index,
          column_id: mc.column_id,
        })),
        skip_duplicates: skipDuplicates,
        row_start_id: preview.next_row_id,
        sheet_name: sheetName,
        participant_link_column_id:
          preview.participant_link_column && linkParticipants
            ? preview.participant_link_column.column_id
            : null,
      }, encoding)
    },
    onSuccess: (result) => {
      setImportResult(result)
      setStep('results')
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['datasets', pid] })
      queryClient.invalidateQueries({ queryKey: ['dataset', pid, did] })
      if (result.participant_link_report) {
        queryClient.invalidateQueries({ queryKey: ['participants', pid] })
      }
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
      setError(typeof detail === 'string' ? detail : (err instanceof Error ? err.message : 'Import failed'))
    },
  })

  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'review', label: 'Review' },
    { key: 'results', label: 'Results' },
  ]

  const newRowCount = preview
    ? preview.total_rows - (skipDuplicates ? preview.duplicate_count : 0)
    : 0

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Progress Steps */}
        <nav aria-label="Import progress" className="flex items-center justify-between mb-8">
          {steps.map((s, i) => {
            const currentIndex = steps.findIndex((x) => x.key === step)
            return (
              <div key={s.key} className="flex items-center" aria-current={currentIndex === i ? 'step' : undefined}>
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
                    currentIndex === i
                      ? 'bg-[hsl(var(--mm-orange))] text-white'
                      : currentIndex > i
                      ? 'bg-[hsl(var(--mm-orange)/0.15)] text-[hsl(var(--mm-orange-text))]'
                      : 'bg-mm-border-subtle text-mm-text-secondary'
                  )}
                >
                  {currentIndex > i ? (
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
            )
          })}
        </nav>

        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-lg">{error}</div>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Upload CSV to Append</CardTitle>
                <CardDescription>
                  Upload a CSV file with the same column structure as the existing dataset.
                  Columns will be matched by column code or column text.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm">File Encoding</Label>
                  <Select value={encoding} onValueChange={setEncoding}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENCODINGS.map(enc => (
                        <SelectItem key={enc.value} value={enc.value}>
                          {enc.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div
                  className="border-2 border-dashed rounded-lg p-12 text-center hover:border-[hsl(var(--mm-orange)/0.5)] transition-colors"
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  role="button"
                  tabIndex={0}
                  aria-label="Drop zone for file upload, or press Enter to select files"
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('append-file-input')?.click() } }}
                >
                  <FileInput className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
                  <p className="text-mm-text-secondary mb-4">
                    Drag and drop a {DATASET_FORMAT_LABEL} file here, or click to browse
                  </p>
                  <input
                    type="file"
                    accept={DATASET_ACCEPT}
                    onChange={(e) => {
                      const selectedFile = e.target.files?.[0]
                      if (selectedFile) handleFileSelect(selectedFile)
                    }}
                    className="hidden"
                    id="append-file-input"
                  />
                  <label htmlFor="append-file-input">
                    <Button asChild disabled={isLoading}>
                      <span>{isLoading ? 'Analyzing...' : 'Select File'}</span>
                    </Button>
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 2: Review */}
        {step === 'review' && preview && (
          <div className="space-y-6">
            {/* Worksheet picker (#523, .xlsx with multiple sheets only) */}
            {preview.sheet_names && preview.sheet_names.length > 1 && file && (
              <div className="bg-mm-surface border rounded-lg px-4 py-3 flex items-center gap-3 text-sm">
                <label htmlFor="append-sheet-picker" className="font-medium">Worksheet</label>
                <select
                  id="append-sheet-picker"
                  value={sheetName ?? preview.sheet_names[0]}
                  onChange={(e) => handleFileSelect(file, e.target.value)}
                  disabled={isLoading}
                  className="text-sm px-2 py-1 rounded border bg-mm-bg cursor-pointer"
                >
                  {preview.sheet_names.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <span className="text-mm-text-muted">Only the selected worksheet is appended.</span>
              </div>
            )}

            {/* Column match summary */}
            <div className="bg-mm-surface border rounded-lg px-4 py-3 flex flex-wrap gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-green-600" />
                <strong>{preview.matched_columns.length}</strong> matched
              </span>
              {preview.unmatched_csv_columns.length > 0 && (
                <span className="flex items-center gap-1.5 text-amber-600">
                  <FileQuestion className="w-3.5 h-3.5" />
                  <strong>{preview.unmatched_csv_columns.length}</strong> unmatched CSV columns
                </span>
              )}
              {preview.unmatched_columns.length > 0 && (
                <span className="text-mm-text-muted">
                  {preview.unmatched_columns.length} columns without new data
                </span>
              )}
              <span className="text-mm-text-muted ml-auto">
                {preview.total_rows} rows in CSV
              </span>
            </div>

            {/* Matched columns table */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Column Matches</CardTitle>
                <CardDescription>
                  CSV columns matched to existing columns
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y max-h-[300px] overflow-y-auto">
                  {preview.matched_columns.map((mc) => (
                    <MatchedColumnRow key={mc.csv_column_index} col={mc} />
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Unmatched CSV columns (collapsible) */}
            {preview.unmatched_csv_columns.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base text-amber-600">
                    Unmatched CSV Columns ({preview.unmatched_csv_columns.length})
                  </CardTitle>
                  <CardDescription>
                    These CSV columns could not be matched to existing columns and will be ignored
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y max-h-[200px] overflow-y-auto">
                    {preview.unmatched_csv_columns.map((uc) => (
                      <div
                        key={uc.csv_column_index}
                        className="flex items-center gap-3 px-4 py-2 text-sm text-mm-text-muted"
                      >
                        <span className="font-mono text-xs bg-mm-bg px-1.5 py-0.5 rounded">
                          col {uc.csv_column_index}
                        </span>
                        <span className="truncate">{uc.csv_column_name}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Duplicates */}
            {preview.duplicate_count > 0 && (
              <Card className="border-amber-200 bg-amber-50/50">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <TriangleAlert className="w-4 h-4 text-amber-600" />
                      <span>
                        <strong>{preview.duplicate_count}</strong> of {preview.total_rows} rows match existing responses
                      </span>
                    </div>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={skipDuplicates}
                        onChange={(e) => setSkipDuplicates(e.target.checked)}
                        className="rounded border-mm-border-medium text-primary"
                      />
                      Skip duplicates
                    </label>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* #414 (DEC-7): participant linking for the new rows */}
            {preview.participant_link_column && (
              <Card>
                <CardContent className="py-4 space-y-1.5">
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={linkParticipants}
                      onChange={(e) => setLinkParticipants(e.target.checked)}
                      className="mt-0.5 rounded border-mm-border-medium text-primary"
                    />
                    <span>
                      Link new records to participants using{' '}
                      <strong>{preview.participant_link_column.column_text}</strong>
                    </span>
                  </label>
                  <p className="text-xs text-mm-text-muted pl-6">
                    IDs matching an existing participant link to them; new IDs create
                    participants. Records with blank, N/A, or duplicated IDs stay unlinked.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Preview rows */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Row Preview</CardTitle>
                    <CardDescription>
                      First {showAllRows ? preview.preview_rows.length : Math.min(5, preview.preview_rows.length)} rows
                    </CardDescription>
                  </div>
                  {preview.preview_rows.length > 5 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAllRows(!showAllRows)}
                    >
                      {showAllRows ? 'Show Less' : 'Show All'}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-mm-bg border-b">
                        <th className="px-3 py-2 text-left text-xs font-medium text-mm-text-muted">#</th>
                        {preview.matched_columns.slice(0, 6).map(mc => (
                          <th
                            key={mc.column_id}
                            className="px-3 py-2 text-left text-xs font-medium text-mm-text-muted max-w-[150px] truncate"
                          >
                            {mc.column_code || mc.column_text.slice(0, 20)}
                          </th>
                        ))}
                        {preview.matched_columns.length > 6 && (
                          <th className="px-3 py-2 text-xs text-mm-text-faint">
                            +{preview.matched_columns.length - 6}
                          </th>
                        )}
                        <th className="px-3 py-2 text-left text-xs font-medium text-mm-text-muted">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(showAllRows ? preview.preview_rows : preview.preview_rows.slice(0, 5)).map(row => (
                        <tr
                          key={row.csv_row_index}
                          className={cn(
                            row.is_duplicate && skipDuplicates && 'opacity-40',
                          )}
                        >
                          <td className="px-3 py-1.5 text-xs text-mm-text-faint">{row.csv_row_index + 1}</td>
                          {preview.matched_columns.slice(0, 6).map(mc => (
                            <td
                              key={mc.column_id}
                              className="px-3 py-1.5 max-w-[150px] truncate"
                            >
                              {row.values[String(mc.column_id)] || ''}
                            </td>
                          ))}
                          {preview.matched_columns.length > 6 && <td />}
                          <td className="px-3 py-1.5">
                            {row.is_duplicate ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                                {skipDuplicates ? 'skip' : 'duplicate'}
                              </span>
                            ) : (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">new</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-mm-text-muted">
                {newRowCount} new responses will be added (IDs: {preview.next_row_id} &ndash; R{String(parseInt(preview.next_row_id.slice(1)) + newRowCount - 1).padStart(preview.row_pad_width, '0')})
                {skipDuplicates && preview.duplicate_count > 0 && (
                  <span className="text-amber-600 ml-2">
                    ({preview.duplicate_count} duplicates skipped)
                  </span>
                )}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setStep('upload'); setPreview(null); setFile(null) }}>
                  Back
                </Button>
                <Button
                  onClick={() => {
                    setError('')
                    importMutation.mutate()
                  }}
                  disabled={importMutation.isPending || newRowCount === 0}
                >
                  {importMutation.isPending ? 'Importing...' : `Append ${newRowCount} Responses`}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Results */}
        {step === 'results' && importResult && (
          <Card>
            <CardHeader>
              <CardTitle>Append Complete</CardTitle>
              <CardDescription>New data has been added to the dataset</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-4 bg-emerald-50 rounded-lg space-y-2 text-sm">
                <div className="flex items-center gap-2 text-emerald-700 font-medium mb-3">
                  <Check className="w-5 h-5" />
                  Append successful
                </div>
                <div><strong>Rows added:</strong> {importResult.rows_created}</div>
                <div><strong>Values stored:</strong> {importResult.values_created}</div>
                {importResult.duplicates_skipped > 0 && (
                  <div><strong>Duplicates skipped:</strong> {importResult.duplicates_skipped}</div>
                )}
                {importResult.participant_link_report && (
                  <div>
                    <strong>Participants:</strong>{' '}
                    {importResult.participant_link_report.linked} linked
                    {importResult.participant_link_report.linked > 0 && (
                      <> ({importResult.participant_link_report.created} new, {importResult.participant_link_report.matched} matched)</>
                    )}
                    {(() => {
                      const r = importResult.participant_link_report
                      const skipped = r.skipped_missing + r.skipped_duplicate + r.skipped_conflict
                      return skipped > 0 ? (
                        <span className="text-mm-text-muted"> · {skipped} not linked (blank, duplicated, or already-linked IDs)</span>
                      ) : null
                    })()}
                  </div>
                )}
                <div className="text-xs text-mm-text-muted mt-2">Batch ID: {importResult.batch_id}</div>
              </div>

              <div className="flex justify-end pt-4 gap-2">
                <Button variant="outline" onClick={() => navigate(`/projects/${pid}/datasets/${did}`)}>
                  View Data
                </Button>
                <Button onClick={() => { setStep('upload'); setPreview(null); setFile(null); setImportResult(null) }}>
                  Append More
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}


function MatchedColumnRow({ col }: { col: AppendMatchedColumn }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="w-5 h-5 rounded-full bg-green-100 text-green-600 flex items-center justify-center flex-shrink-0">
        <Check className="w-3 h-3" />
      </span>
      <span className="flex-1 text-sm truncate">
        {col.column_text}
        {col.column_code && (
          <span className="text-mm-text-faint font-mono ml-2 text-xs">{col.column_code}</span>
        )}
      </span>
      <span className={cn(
        'text-xs px-2 py-0.5 rounded flex-shrink-0',
        col.match_method === 'code' ? 'bg-mm-blue/12 text-mm-blue-text' : 'bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-300',
      )}>
        by {col.match_method}
      </span>
      <span className="text-xs px-2 py-0.5 rounded bg-mm-bg text-mm-text-muted flex-shrink-0">
        {col.column_type}
      </span>
    </div>
  )
}
