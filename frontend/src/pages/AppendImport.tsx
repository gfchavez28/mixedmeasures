import { useState, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { FileInput, Check, ChevronRight, TriangleAlert, Link2, FileQuestion, CircleAlert } from 'lucide-react'
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
import { DATASET_ACCEPT, DATASET_FORMAT_LABEL, isSupportedDatasetFile, describeDatasetUploadError } from '@/lib/dataset-import-formats'
import { checkImportFiles } from '@/lib/upload-limits'
import { describeAppendDuplicates } from '@/lib/append-duplicates'
import { useStepFocus } from '@/hooks/useStepFocus'
import UploadLimitNote from '@/components/UploadLimitNote'
import { openPickerFromZoneClick } from '@/lib/drop-zone'
import { OverlongRecordsNotice } from '@/components/OverlongRecordsNotice'

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

  const appendInputRef = useRef<HTMLInputElement>(null)

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
    // #1007/#1012: type and size are known before any upload — refuse here. A
    // wrong-type file picked through "All files" used to reach the server and be
    // reported as an ENCODING problem.
    const { accepted, message } = checkImportFiles([selectedFile], {
      isSupported: isSupportedDatasetFile, formatLabel: DATASET_FORMAT_LABEL, noun: 'dataset',
    })
    if (accepted.length === 0) {
      setError(message)
      return
    }
    setFile(selectedFile)
    setError('')
    setIsLoading(true)

    try {
      const result = await datasetsApi.appendPreview(pid, did, selectedFile, encoding, sheet)
      setPreview(result)
      setSheetName(sheet ?? null)
      setStep('review')
    } catch (err: unknown) {
      // #796/#797: appendPreview is one of the four calls that now carry a
      // size-derived timeout, so it can fail by abort as well as by parse —
      // and the two need different words. The shared describer owns that.
      setError(describeDatasetUploadError(err))
    } finally {
      setIsLoading(false)
    }
  }, [pid, did, encoding])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      // #1012: hand every drop to the one check — a wrong-type file dropped
      // here used to be ignored in silence.
      const droppedFile = e.dataTransfer.files[0]
      if (droppedFile) handleFileSelect(droppedFile)
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
      setError(describeDatasetUploadError(err))
    },
  })

  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'review', label: 'Review' },
    { key: 'results', label: 'Results' },
  ]
  const stepIndex = steps.findIndex(s => s.key === step)
  const stepHeadingRef = useStepFocus(step)

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
                      ? 'bg-mm-orange-fill text-mm-on-fill'
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

        {/* #1011: where focus lands when the step changes (the pressed button
            unmounts, which used to drop focus to <body>). */}
        <h2 ref={stepHeadingRef} tabIndex={-1} className="sr-only">
          {stepIndex >= 0 ? `Step ${stepIndex + 1} of ${steps.length}: ${steps[stepIndex].label}` : ''}
        </h2>

        {/* Parity with its sibling wizard, `DatasetImport.tsx` (#972). This banner
            had no `role="alert"`, so a refusal — including the new cell-cap one,
            which can arrive after a long upload — was announced to nobody, while
            focus stayed on the button that triggered it. It also carried no dark
            variants, so it painted a bright box in a dark UI. Two surfaces of one
            wizard family, one of them silently behind: diff against the sibling. */}
        {error && (
          <div role="alert" className="mb-6 p-4 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 rounded-lg flex items-start gap-2">
            <CircleAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Upload a file to append</CardTitle>
                <CardDescription>
                  Upload a {DATASET_FORMAT_LABEL} file with the same column structure as the existing dataset.
                  Columns will be matched by column code or column text.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  {/* #892: the Label carries no `htmlFor`, so this trigger
                      announced as an unnamed combobox despite the visible text
                      above it. The name REPEATS that text verbatim (WCAG 2.5.3).
                      ⚠️ This comment used to add "and a <label> cannot name a
                      button anyway" — MEASURED FALSE (#889, sweep run 3): a
                      <button> IS a labelable element, so `<Label htmlFor>` + a
                      trigger `id` does name it, and that is the route #900–#905
                      use elsewhere. Both work; this one stays as shipped. */}
                  <Label className="text-sm">File Encoding</Label>
                  <Select value={encoding} onValueChange={setEncoding}>
                    <SelectTrigger className="w-48" aria-label="File Encoding">
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

                {/* #560a: plain div + guarded click-to-browse; the Button is the
                    accessible control. See lib/drop-zone.ts — role="button" must not
                    come back once a real button lives inside. */}
                <div
                  className="border-2 border-dashed rounded-lg p-12 text-center hover:border-[hsl(var(--mm-orange)/0.5)] transition-colors"
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                  onClick={(e) => openPickerFromZoneClick(e, () => appendInputRef.current?.click())}
                >
                  <FileInput className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
                  <p className="text-mm-text-secondary mb-4">
                    Drag and drop a {DATASET_FORMAT_LABEL} file here, or click to browse
                  </p>
                  <UploadLimitNote noun="dataset files" className="-mt-2 mb-4" />
                  <input
                    ref={appendInputRef}
                    type="file"
                    accept={DATASET_ACCEPT}
                    onChange={(e) => {
                      const selectedFile = e.target.files?.[0]
                      if (selectedFile) handleFileSelect(selectedFile)
                      // Reset so re-picking the SAME file fires onChange again — without
                      // this, retrying after an error/back-navigation silently no-ops.
                      e.target.value = ''
                    }}
                    className="hidden"
                    id="append-file-input"
                  />
                  <Button onClick={() => appendInputRef.current?.click()} disabled={isLoading}>
                    {isLoading ? 'Analyzing...' : 'Select File'}
                  </Button>
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
                  <strong>{preview.unmatched_csv_columns.length}</strong> unmatched file columns
                </span>
              )}
              {preview.unmatched_columns.length > 0 && (
                <span className="text-mm-text-muted">
                  {preview.unmatched_columns.length} columns without new data
                </span>
              )}
              {/* "CSV" was wrong for an .xlsx or .sav append (#1008's lesson,
                  on the one wizard it had not reached). */}
              <span className="text-mm-text-muted ml-auto">
                {preview.total_rows.toLocaleString()} records in the file
              </span>
            </div>

            {/* #985: rows whose values will land in the wrong columns. */}
            <OverlongRecordsNotice report={preview.overlong_records} stage="before" newDataset={false} />

            {/* Matched columns table */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Column Matches</CardTitle>
                <CardDescription>
                  File columns matched to existing columns
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
                    Unmatched File Columns ({preview.unmatched_csv_columns.length})
                  </CardTitle>
                  <CardDescription>
                    These file columns could not be matched to existing columns and will be ignored
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
              <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <TriangleAlert className="w-4 h-4 text-amber-600" />
                      <span>
                        {describeAppendDuplicates(preview)}
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
                    <caption className="sr-only">Preview of the rows to be appended.</caption>
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
                              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
                                {skipDuplicates ? 'skip' : 'duplicate'}
                              </span>
                            ) : (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">new</span>
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
              <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 rounded-lg space-y-2 text-sm">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium mb-3">
                  <Check className="w-5 h-5" />
                  Append successful
                </div>
                <div><strong>Rows added:</strong> {importResult.rows_created.toLocaleString()}</div>
                <div><strong>Values stored:</strong> {importResult.values_created.toLocaleString()}</div>
                {importResult.duplicates_skipped > 0 && (
                  <div><strong>Duplicates skipped:</strong> {importResult.duplicates_skipped.toLocaleString()}</div>
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

              {/* #985: each appended row that had extra values, linked to it. */}
              <OverlongRecordsNotice
                report={importResult.overlong_records}
                stage="after"
                newDataset={false}
                datasetPath={`/projects/${pid}/datasets/${did}`}
              />

              {/* #575: appended values that didn't map to a scale code land NULL. */}
              {importResult.unmapped_values && importResult.unmapped_values.length > 0 && (
                <div
                  role="note"
                  className="flex items-start gap-2 p-3 rounded-lg text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
                >
                  <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    {importResult.unmapped_values.length} value
                    {importResult.unmapped_values.length === 1 ? '' : 's'} didn't match a
                    labelled scale point and were stored without a numeric code:{' '}
                    {importResult.unmapped_values.slice(0, 5).map(v => `"${v}"`).join(', ')}
                    {importResult.unmapped_values.length > 5
                      ? `, +${importResult.unmapped_values.length - 5} more`
                      : ''}
                    . Add value labels for these codes, or check the source file for typos.
                  </span>
                </div>
              )}

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
      <span className="w-5 h-5 rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 flex items-center justify-center flex-shrink-0">
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
