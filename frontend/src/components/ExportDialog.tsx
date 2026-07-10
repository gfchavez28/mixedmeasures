import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { FileOutput, ChevronDown, ChevronRight, Package, BookOpen } from 'lucide-react'
import { exportApi, metricsApi, projectPortabilityApi, projectsApi } from '@/lib/api'
import type { ExportOptions } from '@/lib/api'
import { defaultIncludeMedia } from '@/lib/api/project-portability'
import { formatBytes } from '@/lib/format'
import { toast } from 'sonner'

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
}

interface ExportState {
  // Conversations
  fullExport: boolean
  csv: boolean
  codebookJson: boolean
  // Full Export sub-options
  codedData: boolean
  codeMatrix: boolean
  cooccurrence: boolean
  codebook: boolean
  memos: boolean
  notes: boolean
  summaries: boolean
  audit: boolean
  // Datasets
  datasetsExcel: boolean
  // Qualitative
  codeFrequencies: boolean
  codedSegments: boolean
  codeCooccurrence: boolean
  // Quantitative
  rowMatrix: boolean
  // Statistical Software
  rDataExport: boolean
}

const defaultState: ExportState = {
  fullExport: true,
  csv: true,
  codebookJson: true,
  codedData: true,
  codeMatrix: true,
  cooccurrence: true,
  codebook: true,
  memos: true,
  notes: true,
  summaries: true,
  audit: true,
  datasetsExcel: true,
  codeFrequencies: true,
  codedSegments: true,
  codeCooccurrence: true,
  rowMatrix: true,
  rDataExport: false,
}

const SUB_OPTION_KEYS: (keyof ExportState)[] = [
  'codedData', 'codeMatrix', 'cooccurrence', 'codebook',
  'memos', 'notes', 'summaries', 'audit',
]

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function ExportDialog({ open, onOpenChange, projectId }: ExportDialogProps) {
  const [state, setState] = useState<ExportState>(defaultState)

  // Slab 5: the .mmproject include-media decision needs the real footprint.
  // Default = include when the media total is small (≤1 GB), exclude above —
  // the user's explicit choice (includeMediaChoice) always wins.
  const { data: storage } = useQuery({
    queryKey: ['project-storage', projectId],
    queryFn: () => projectsApi.storage(projectId),
    enabled: open && !!projectId,
    staleTime: 60_000,
  })
  const [includeMediaChoice, setIncludeMediaChoice] = useState<boolean | null>(null)
  const includeMedia = includeMediaChoice ?? defaultIncludeMedia(storage?.media_bytes)
  const [subOptionsExpanded, setSubOptionsExpanded] = useState(false)
  const [exporting, setExporting] = useState(false)

  const toggle = useCallback((key: keyof ExportState) => {
    setState(prev => {
      const next = { ...prev, [key]: !prev[key] }
      // If toggling a sub-option off, keep fullExport checked if any sub-option is still on
      // If toggling a sub-option on, ensure fullExport is on
      if (SUB_OPTION_KEYS.includes(key)) {
        const anySubOn = SUB_OPTION_KEYS.some(k => k === key ? !prev[key] : prev[k])
        next.fullExport = anySubOn
      }
      // If toggling fullExport itself, toggle all sub-options
      if (key === 'fullExport') {
        const newVal = !prev.fullExport
        for (const k of SUB_OPTION_KEYS) {
          next[k] = newVal
        }
      }
      return next
    })
  }, [])

  const hasAnySelected = Object.values(state).some(v => v)

  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      // Conversations - Full Export
      if (state.fullExport) {
        const options: ExportOptions = {
          coded_data: state.codedData,
          matrix: state.codeMatrix,
          cooccurrence: state.cooccurrence,
          codebook: state.codebook,
          memos: state.memos,
          notes: state.notes,
          summaries: state.summaries,
          audit: state.audit,
        }
        exportApi.excelWithOptions(projectId, options)
        await delay(200)
      }

      // Conversations - CSV
      if (state.csv) {
        exportApi.csv(projectId)
        await delay(200)
      }

      // Conversations - Codebook JSON
      if (state.codebookJson) {
        try {
          const data = await exportApi.codebook(projectId)
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `codebook-project-${projectId}.json`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
        } catch (err) {
          console.warn('Codebook export failed:', err)
        }
        await delay(200)
      }

      // Datasets Excel
      if (state.datasetsExcel) {
        exportApi.datasetsExcel(projectId)
        await delay(200)
      }

      // Qualitative - Code Frequencies
      if (state.codeFrequencies) {
        exportApi.codeFrequencies(projectId)
        await delay(200)
      }

      // Qualitative - Coded Segments
      if (state.codedSegments) {
        exportApi.codedSegments(projectId)
        await delay(200)
      }

      // Qualitative - Code Co-occurrence
      if (state.codeCooccurrence) {
        exportApi.codeCooccurrence(projectId)
        await delay(200)
      }

      // Quantitative - Record Matrix
      if (state.rowMatrix) {
        metricsApi.rowMatrix(projectId, undefined, 'csv')
      }

      // Statistical Software - R Data Export
      if (state.rDataExport) {
        try {
          const blob = await exportApi.rData(projectId)
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `r_data_export.zip`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
        } catch (err: unknown) {
          const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          alert(typeof detail === 'string' ? detail : 'R Data Export failed')
        }
        await delay(200)
      }

      onOpenChange(false)
    } finally {
      setExporting(false)
    }
  }, [state, projectId, onOpenChange])

  // Determine indeterminate state for fullExport checkbox
  const allSubOn = SUB_OPTION_KEYS.every(k => state[k])
  const anySubOn = SUB_OPTION_KEYS.some(k => state[k])
  const fullExportChecked = allSubOn ? true : anySubOn ? 'indeterminate' as const : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-mm-text">
            <FileOutput className="h-5 w-5" />
            Export Project Data
          </DialogTitle>
          <DialogDescription>
            Select the data you want to export. Each selection will download as a separate file.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2 max-h-[60vh] overflow-y-auto">
          {/* Project Portability */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Project Portability
            </h3>
            <div className="space-y-3 ml-1">
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true)
                    try {
                      await projectPortabilityApi.exportProject(projectId, includeMedia)
                      toast.success('Project exported')
                    } catch {
                      toast.error('Project export failed')
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  <Package className="h-3.5 w-3.5" />
                  Export Project (.mmproject)
                </Button>
                <p className="text-xs text-mm-text-secondary mt-1 ml-0.5">
                  Self-contained archive with all project data and documents
                </p>
                {(storage?.media_bytes ?? 0) > 0 && (
                  <div className="flex items-start gap-2 mt-2 ml-0.5">
                    <Checkbox
                      id="export-include-media"
                      checked={includeMedia}
                      onCheckedChange={(v) => setIncludeMediaChoice(v === true)}
                    />
                    <div>
                      <Label htmlFor="export-include-media" className="text-xs font-normal cursor-pointer">
                        Include recordings &amp; media ({formatBytes(storage!.media_bytes)})
                      </Label>
                      {!includeMedia && (
                        <p className="text-[11px] text-mm-text-muted mt-0.5">
                          Recordings can be re-attached after import — transcripts and coding always travel.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true)
                    try {
                      await projectPortabilityApi.exportCodebook(projectId, 'native')
                      toast.success('Codebook exported')
                    } catch {
                      toast.error('Codebook export failed')
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Codebook (.mmcodebook)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={exporting}
                  onClick={async () => {
                    setExporting(true)
                    try {
                      await projectPortabilityApi.exportCodebook(projectId, 'qdc')
                      toast.success('QDC codebook exported')
                    } catch {
                      toast.error('QDC export failed')
                    } finally {
                      setExporting(false)
                    }
                  }}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  REFI-QDA (.qdc)
                </Button>
              </div>
              <p className="text-xs text-mm-text-secondary ml-0.5">
                Codebook formats for sharing codes with other MM instances or tools like ATLAS.ti, NVivo, MAXQDA
              </p>
            </div>
          </section>

          {/* Conversations */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Conversations
            </h3>
            <div className="space-y-2 ml-1">
              {/* Full Export with expandable sub-options */}
              <div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="fullExport"
                    checked={fullExportChecked}
                    onCheckedChange={() => toggle('fullExport')}
                  />
                  <Label
                    htmlFor="fullExport"
                    className="text-sm text-mm-text cursor-pointer select-none"
                  >
                    Full Export (Excel)
                  </Label>
                  <button
                    type="button"
                    onClick={() => setSubOptionsExpanded(prev => !prev)}
                    className="p-0.5 rounded hover:bg-mm-bg text-mm-text-secondary transition-colors"
                    aria-label={subOptionsExpanded ? 'Collapse sub-options' : 'Expand sub-options'}
                    aria-expanded={subOptionsExpanded}
                  >
                    {subOptionsExpanded
                      ? <ChevronDown className="h-3.5 w-3.5" />
                      : <ChevronRight className="h-3.5 w-3.5" />
                    }
                  </button>
                </div>
                {subOptionsExpanded && (
                  <div className="ml-6 mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {([
                      ['codedData', 'Coded data'],
                      ['codeMatrix', 'Code matrix'],
                      ['cooccurrence', 'Co-occurrence'],
                      ['codebook', 'Codebook'],
                      ['memos', 'Memos'],
                      ['notes', 'Notes'],
                      ['summaries', 'Summaries'],
                      ['audit', 'Audit'],
                    ] as [keyof ExportState, string][]).map(([key, label]) => (
                      <div key={key} className="flex items-center gap-2">
                        <Checkbox
                          id={key}
                          checked={state[key]}
                          onCheckedChange={() => toggle(key)}
                        />
                        <Label
                          htmlFor={key}
                          className="text-xs text-mm-text-secondary cursor-pointer select-none"
                        >
                          {label}
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="csv"
                  checked={state.csv}
                  onCheckedChange={() => toggle('csv')}
                />
                <Label
                  htmlFor="csv"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  CSV (segments)
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="codebookJson"
                  checked={state.codebookJson}
                  onCheckedChange={() => toggle('codebookJson')}
                />
                <Label
                  htmlFor="codebookJson"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Codebook (JSON)
                </Label>
              </div>
            </div>
          </section>

          {/* Datasets */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Datasets
            </h3>
            <div className="space-y-2 ml-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="datasetsExcel"
                  checked={state.datasetsExcel}
                  onCheckedChange={() => toggle('datasetsExcel')}
                />
                <Label
                  htmlFor="datasetsExcel"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Datasets Excel (with Data Dictionary)
                </Label>
              </div>
            </div>
          </section>

          {/* Qualitative */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Qualitative
            </h3>
            <div className="space-y-2 ml-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="codeFrequencies"
                  checked={state.codeFrequencies}
                  onCheckedChange={() => toggle('codeFrequencies')}
                />
                <Label
                  htmlFor="codeFrequencies"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Code Frequencies (CSV)
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="codedSegments"
                  checked={state.codedSegments}
                  onCheckedChange={() => toggle('codedSegments')}
                />
                <Label
                  htmlFor="codedSegments"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Coded Segments (CSV)
                </Label>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="codeCooccurrence"
                  checked={state.codeCooccurrence}
                  onCheckedChange={() => toggle('codeCooccurrence')}
                />
                <Label
                  htmlFor="codeCooccurrence"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Code Co-occurrence (CSV)
                </Label>
              </div>
            </div>
          </section>

          {/* Quantitative */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Quantitative
            </h3>
            <div className="space-y-2 ml-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="rowMatrix"
                  checked={state.rowMatrix}
                  onCheckedChange={() => toggle('rowMatrix')}
                />
                <Label
                  htmlFor="rowMatrix"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Record Matrix (CSV)
                </Label>
              </div>
            </div>
          </section>

          {/* Statistical Software */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Statistical Software
            </h3>
            <div className="space-y-1 ml-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="rDataExport"
                  checked={state.rDataExport}
                  onCheckedChange={() => toggle('rDataExport')}
                />
                <Label
                  htmlFor="rDataExport"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  R Data Export (.csv + .R setup script)
                </Label>
              </div>
              <p className="text-xs text-mm-text-secondary ml-6">
                Analysis-ready data with factor levels and variable labels for R/RStudio
              </p>
            </div>
          </section>
          {/* Canvas — canvases export individually from their own toolbar (#420:
              the old disabled "coming in next update" entry predated canvas
              export shipping; keep the section as a pointer, not a checkbox). */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Canvas
            </h3>
            <p className="text-xs text-mm-text-secondary ml-1">
              Canvases export individually — open a canvas and use its Export menu
              (Markdown, HTML, PDF, or Word).
            </p>
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={exporting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={!hasAnySelected || exporting}
            className="gap-2"
          >
            <FileOutput className="h-4 w-4" />
            {exporting ? 'Exporting...' : 'Export Selected'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ExportDialog
