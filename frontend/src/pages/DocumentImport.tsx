import { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { FileInput, X, LoaderCircle, CircleCheck, CircleX, TriangleAlert, ChevronRight } from 'lucide-react'
import { documentsApi, type SegmentationPreviewResponse, type DocumentImportResultItem } from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import { consumePendingImportFiles } from '@/lib/pending-import-files'
import { DOCUMENT_ACCEPT, isSupportedDocumentFile } from '@/lib/document-import-formats'
import { openPickerFromZoneClick } from '@/lib/drop-zone'

type Step = 'upload' | 'segmentation' | 'importing' | 'results'

const MAX_FILES = 50

const SEGMENTATION_MODES = [
  { value: 'paragraph', label: 'By Paragraph', description: 'Each paragraph becomes a segment. Best for most documents.' },
  { value: 'sentence', label: 'By Sentence', description: 'Each sentence becomes a segment. Best for fine-grained content analysis.' },
  { value: 'heading', label: 'By Section', description: 'Content between headings becomes a segment. Best for structured reports.' },
  { value: 'page', label: 'By Page', description: 'Each page becomes a segment. Best for PDFs with unreliable paragraph detection.' },
  { value: 'double_newline', label: 'By Blank Line', description: 'Split on blank lines. Reliable fallback for any format.' },
] as const

const FORMAT_LABELS: Record<string, string> = {
  docx: 'DOCX',
  pdf: 'PDF',
  txt: 'TXT',
}

function getFormat(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return ext === 'docx' ? 'docx' : ext === 'pdf' ? 'pdf' : 'txt'
}

export default function DocumentImport() {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<Step>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [segmentationMode, setSegmentationMode] = useState('paragraph')
  const [documentNames, setDocumentNames] = useState<string[]>([])

  // Preview state
  const [preview, setPreview] = useState<SegmentationPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Import state
  const [importResults, setImportResults] = useState<DocumentImportResultItem[]>([])
  const [importProgress, setImportProgress] = useState(0)
  const [isImporting, setIsImporting] = useState(false)

  // Drag state
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const isMultiFile = files.length > 1

  const steps: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'segmentation', label: 'Configure' },
    ...(isMultiFile ? [{ key: 'importing' as Step, label: 'Import' }] : []),
    { key: 'results', label: 'Results' },
  ]

  const stepIndex = steps.findIndex(s => s.key === step)

  // Consume pending files on mount
  useEffect(() => {
    const pending = consumePendingImportFiles('document')
    if (pending && pending.length > 0) {
      const valid = pending.filter(f => isSupportedDocumentFile(f.name)).slice(0, MAX_FILES)
      if (valid.length > 0) {
        setFiles(valid)
        setDocumentNames(valid.map(f => f.name.replace(/\.[^/.]+$/, '')))
      }
    }
  }, [])

  // Load preview when mode changes or files change
  useEffect(() => {
    if (step !== 'segmentation' || files.length === 0) return

    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const result = await documentsApi.uploadPreview(projectId, files[0], segmentationMode)
        setPreview(result)
      } catch {
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 300)

    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    }
  }, [step, segmentationMode, files, projectId])

  const addFiles = useCallback((newFiles: File[]) => {
    const valid = newFiles.filter(f => isSupportedDocumentFile(f.name))
    setFiles(prev => {
      const combined = [...prev, ...valid].slice(0, MAX_FILES)
      setDocumentNames(names => {
        const newNames = valid.map(f => f.name.replace(/\.[^/.]+$/, ''))
        return [...names, ...newNames].slice(0, MAX_FILES)
      })
      return combined
    })
  }, [])

  const removeFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
    setDocumentNames(prev => prev.filter((_, i) => i !== index))
  }, [])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImport = useCallback(async () => {
    setStep('importing')
    setIsImporting(true)
    setImportResults([])

    const results: DocumentImportResultItem[] = []

    for (let i = 0; i < files.length; i++) {
      setImportProgress(((i) / files.length) * 100)
      try {
        const result = await documentsApi.importDocument(
          projectId,
          files[i],
          segmentationMode,
          documentNames[i] || undefined,
        )
        results.push(result)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Import failed'
        results.push({
          document_id: null,
          name: documentNames[i] || files[i].name,
          segment_count: 0,
          warnings: [],
          error: errMsg,
        })
      }
      setImportResults([...results])
    }

    setImportProgress(100)
    setIsImporting(false)
    setStep('results')

    queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-summary', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
  }, [files, segmentationMode, documentNames, projectId, queryClient])

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current++; setIsDragOver(true) },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false) }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragOver(false)
      addFiles(Array.from(e.dataTransfer.files))
    },
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Link
          to={`/projects/${projectId}/documents`}
          className="text-sm text-mm-text-muted hover:text-mm-text transition-colors"
        >
          Documents
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-mm-text-faint" />
        <span className="text-sm font-medium text-mm-text">Import</span>
      </div>

      {/* Step indicator */}
      <nav aria-label="Import progress" className="flex items-center justify-between mb-8">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center" aria-current={stepIndex === i ? 'step' : undefined}>
            <div className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium',
              stepIndex === i
                ? 'bg-purple-600 text-white'
                : stepIndex > i
                  ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                  : 'bg-mm-bg text-mm-text-faint'
            )}>
              {i + 1}
            </div>
            <span className="ml-2 text-sm font-medium">{s.label}</span>
            {i < steps.length - 1 && (
              <ChevronRight className="w-4 h-4 mx-4 text-mm-text-faint" />
            )}
          </div>
        ))}
      </nav>

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle>Upload Files</CardTitle>
            <CardDescription>Select DOCX, PDF, or TXT files to import (max {MAX_FILES}).</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                'rounded-lg border-2 border-dashed p-12 text-center transition-colors mb-4',
                isDragOver ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/10' : 'border-mm-border-medium bg-mm-surface'
              )}
              onClick={(e) => openPickerFromZoneClick(e, () => fileInputRef.current?.click())}
              {...dragHandlers}
            >
              <FileInput className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
              <p className="text-sm text-mm-text-muted mb-4">
                Drag and drop files here, or click to browse
              </p>
              <Button
                onClick={() => fileInputRef.current?.click()}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                Select Files
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={DOCUMENT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(Array.from(e.target.files))
                  e.target.value = ''
                }}
              />
            </div>

            {files.length > 0 && (
              <div className="space-y-1 mb-6">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 rounded-md bg-mm-bg text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase',
                        getFormat(f.name) === 'pdf' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        : getFormat(f.name) === 'docx' ? 'bg-mm-blue/12 text-mm-blue-text'
                        : 'bg-mm-surface-hover text-mm-text-secondary'
                      )}>
                        {FORMAT_LABELS[getFormat(f.name)] || 'TXT'}
                      </span>
                      <span className="truncate text-mm-text">{f.name}</span>
                      <span className="text-mm-text-faint shrink-0">{formatBytes(f.size)}</span>
                    </div>
                    <button
                      onClick={() => removeFile(i)}
                      className="text-mm-text-faint hover:text-mm-text transition-colors ml-2"
                      aria-label={`Remove ${f.name}`}
                      title={`Remove ${f.name}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                disabled={files.length === 0}
                onClick={() => setStep('segmentation')}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                Next
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Segmentation */}
      {step === 'segmentation' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Segmentation</CardTitle>
              <CardDescription>Choose how to split documents into codable segments.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[1fr,1fr] gap-6">
                {/* Left: mode selector */}
                <div className="space-y-2">
                  {SEGMENTATION_MODES.map((mode) => (
                    <label
                      key={mode.value}
                      className={cn(
                        'flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                        segmentationMode === mode.value
                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/10 dark:border-purple-700'
                          : 'border-mm-surface-border bg-mm-surface hover:border-mm-border-medium'
                      )}
                    >
                      <input
                        type="radio"
                        name="segmentation"
                        value={mode.value}
                        checked={segmentationMode === mode.value}
                        onChange={() => setSegmentationMode(mode.value)}
                        className="mt-0.5 accent-purple-600"
                      />
                      <div>
                        <div className="text-sm font-medium text-mm-text">{mode.label}</div>
                        <div className="text-xs text-mm-text-muted">{mode.description}</div>
                      </div>
                    </label>
                  ))}
                </div>

                {/* Right: preview */}
                <div className="rounded-lg border border-mm-surface-border bg-mm-surface p-4">
                  <h3 className="text-sm font-medium text-mm-text mb-3">
                    Preview{preview && !previewLoading ? ` (${preview.total_segments} segment${preview.total_segments !== 1 ? 's' : ''})` : ''}
                  </h3>
                  {previewLoading ? (
                    <div className="flex items-center gap-2 text-sm text-mm-text-muted py-4 justify-center">
                      <LoaderCircle className="w-4 h-4 animate-spin" />
                      Loading preview...
                    </div>
                  ) : preview ? (
                    <>
                      {preview.warnings.map((w, i) => (
                        <div key={i} className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 p-2 mb-2 text-xs text-amber-700 dark:text-amber-400">
                          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          {w}
                        </div>
                      ))}
                      <div className="space-y-1 max-h-64 overflow-y-auto">
                        {preview.segments.map((seg) => (
                          <div key={seg.sequence_order} className="flex gap-2 text-xs py-1.5 border-b border-mm-border-light last:border-0">
                            <span className="text-mm-text-faint font-mono shrink-0 w-6 text-right">
                              {seg.heading_level ? `H${seg.heading_level}` : `${seg.sequence_order + 1}`}
                            </span>
                            <span className={cn('text-mm-text', seg.heading_level && 'font-semibold')}>
                              {seg.text.length > 200 ? seg.text.slice(0, 200) + '\u2026' : seg.text}
                            </span>
                            {seg.page_number != null && (
                              <span className="text-mm-text-faint shrink-0">p.{seg.page_number}</span>
                            )}
                          </div>
                        ))}
                        {preview.total_segments > preview.segments.length && (
                          <div className="text-xs text-mm-text-faint text-center py-2">
                            ...and {preview.total_segments - preview.segments.length} more
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-mm-text-muted text-center py-4">No preview available.</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Document names */}
          <Card>
            <CardHeader>
              <CardTitle>Document Names</CardTitle>
              <CardDescription>Edit names for your imported documents.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className={cn(
                      'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0',
                      getFormat(f.name) === 'pdf' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : getFormat(f.name) === 'docx' ? 'bg-mm-blue/12 text-mm-blue-text'
                      : 'bg-mm-surface-hover text-mm-text-secondary'
                    )}>
                      {FORMAT_LABELS[getFormat(f.name)] || 'TXT'}
                    </span>
                    <Input
                      value={documentNames[i] || ''}
                      onChange={(e) => setDocumentNames(prev => {
                        const next = [...prev]
                        next[i] = e.target.value
                        return next
                      })}
                      className="h-8 text-sm flex-1"
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep('upload')}>Back</Button>
            <Button
              onClick={handleImport}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              Import {files.length} Document{files.length !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Importing */}
      {step === 'importing' && (
        <div>
          <h2 className="text-lg font-semibold text-mm-text mb-4">Importing...</h2>
          <Progress value={importProgress} className="mb-4" />
          <div className="space-y-1">
            {files.map((f, i) => {
              const result = importResults[i]
              return (
                <div key={i} className="flex items-center gap-2 text-sm py-1.5">
                  {result ? (
                    result.error ? (
                      <CircleX className="w-4 h-4 text-red-500 shrink-0" />
                    ) : (
                      <CircleCheck className="w-4 h-4 text-green-500 shrink-0" />
                    )
                  ) : i === importResults.length && isImporting ? (
                    <LoaderCircle className="w-4 h-4 animate-spin text-purple-500 shrink-0" />
                  ) : (
                    <div className="w-4 h-4 rounded-full border border-mm-border-medium shrink-0" />
                  )}
                  <span className="text-mm-text truncate">{documentNames[i] || f.name}</span>
                  {result && !result.error && (
                    <span className="text-mm-text-faint text-xs shrink-0">{result.segment_count} segments</span>
                  )}
                  {result?.error && (
                    <span className="text-red-500 text-xs shrink-0 truncate">{result.error}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Step 4: Results */}
      {step === 'results' && (
        <div>
          <h2 className="text-lg font-semibold text-mm-text mb-4">Import Complete</h2>

          <div className="space-y-2 mb-6">
            {importResults.map((result, i) => (
              <div key={i} className={`flex items-center justify-between p-3 rounded-lg border ${
                result.error
                  ? 'border-red-200 bg-red-50 dark:border-red-800/40 dark:bg-red-900/10'
                  : 'border-green-200 bg-green-50 dark:border-green-800/40 dark:bg-green-900/10'
              }`}>
                <div className="flex items-center gap-2 min-w-0">
                  {result.error ? (
                    <CircleX className="w-4 h-4 text-red-500 shrink-0" />
                  ) : (
                    <CircleCheck className="w-4 h-4 text-green-500 shrink-0" />
                  )}
                  <span className="text-sm font-medium text-mm-text truncate">{result.name}</span>
                  {!result.error && (
                    <span className="text-xs text-mm-text-muted shrink-0">{result.segment_count} segments</span>
                  )}
                  {result.error && (
                    <span className="text-xs text-red-600 dark:text-red-400 truncate">{result.error}</span>
                  )}
                </div>
                {result.document_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/projects/${projectId}/documents/${result.document_id}`)}
                    className="shrink-0"
                  >
                    Open
                  </Button>
                )}
              </div>
            ))}
          </div>

          {importResults.some(r => r.warnings.length > 0) && (
            <div className="mb-6">
              {importResults.filter(r => r.warnings.length > 0).map((r, i) => (
                <div key={i} className="mb-2">
                  {r.warnings.map((w, j) => (
                    <div key={j} className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 p-2 text-xs text-amber-700 dark:text-amber-400">
                      <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span><strong>{r.name}:</strong> {w}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={() => {
                setStep('upload')
                setFiles([])
                setDocumentNames([])
                setImportResults([])
                setImportProgress(0)
                setPreview(null)
              }}
            >
              Import More
            </Button>
            <Button
              onClick={() => navigate(`/projects/${projectId}/documents`)}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
