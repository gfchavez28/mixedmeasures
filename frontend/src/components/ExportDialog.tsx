import { useState, useCallback, useId } from 'react'
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
import { FileOutput, ChevronDown, ChevronRight, Package, BookOpen, EyeOff } from 'lucide-react'
import { exportApi, metricsApi, projectPortabilityApi, projectsApi, extractApiError } from '@/lib/api'
import type { ExportOptions } from '@/lib/api'
import { defaultIncludeMedia } from '@/lib/api/project-portability'
import { formatBytes } from '@/lib/format'
import { ceilingLevel, describeCeiling, hasCeilingToReport } from '@/lib/project-export-ceiling'
import { toast } from 'sonner'
import { toastProjectExportError } from '@/lib/project-export-error'
import { exportCodeFrequenciesCsv } from '@/lib/code-frequencies-export'
import { codeFrequenciesFileRequest } from '@/lib/qual-comparison'
import { frequencyFileScope } from '@/components/qualitative-analysis/qual-summary-columns'
import BlindModeToggle from '@/components/BlindModeToggle'
import { useBlindMode } from '@/hooks/useBlindMode'
import { useCoders } from '@/hooks/useCoders'
import { useAuth } from '@/lib/auth-context'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'

/** #1530 D96 (1.5.9) — what the dialog says while blind mode is on. */
export const EXPORT_BLIND_SENTENCE =
  "Blind mode is on — the files hold your own coding. The codebook's usage counts include every coder, as the Codebook page does."
/** …and once the coder has revealed: the same files, every coder's coding. */
export const EXPORT_REVEALED_SENTENCE = "Colleagues' work is revealed — the files hold every coder's coding."
/** Why *Export Selected* waits (D96): the scope depends on a roster that has not answered. */
export const EXPORT_WAITING_SENTENCE =
  'Checking who codes in this project before exporting — blind mode decides what the files hold.'

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  /** Names the files written in the browser (the Frequencies CSV), as the server names its own. */
  projectName: string | undefined
}

/** #1528 D87 — nothing selected: every code, every source of every kind, the human layer. */
const NO_SELECTION = { conversations: [], textColumns: [], documents: [], observations: [] }

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
  quotes: boolean
  /** #1534 D109 (1.5.9): the *Sources* sheet — was `summaries`, a name the route stopped reading in v1.5.2. */
  sources: boolean
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
  quotes: true,
  sources: true,
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
  'memos', 'notes', 'sources', 'audit',
]

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function ExportDialog({ open, onOpenChange, projectId, projectName }: ExportDialogProps) {
  const [state, setState] = useState<ExportState>(defaultState)

  // #1530 D95/D96 (1.5.9) — blind mode reaches the files. It is CLIENT state, so a file holds
  // only what its request asks for: while blind mode WITHHOLDS (the fail-closed act, #964 —
  // never the claim `blind`), every file carrying the human coding layer is asked for the
  // viewer's own coding, as the analysis page asks its charts (#499). The codebook's usage
  // counts stay every coder (#454 — the Codebook page shows them), and the .mmproject,
  // .mmcodebook/.qdc are not coding views (D95). The datasets workbook IS, through the
  // participant table's rating columns (#1608), and so is the record matrix (#1615 — a metric
  // over a rating score is a colleague's judgement): both take the scope.
  const { user } = useAuth()
  const { multiHumanCoder } = useCoders()
  const { blind, withholding, settled, toggleReveal } = useBlindMode(projectId)
  const self = user?.id ?? null
  const coderScope = withholding && self != null ? String(self) : undefined
  // The export does not start before the scope is known (D96): an unanswered roster is
  // withholding by default, so starting would narrow a single coder's files to her own rows
  // and drop the Unattributed ones. Fail closed on a missing self id too — withholding with no
  // one to scope to must not fall back to every coder.
  const waitingForScope = !settled || (withholding && self == null)
  const statusId = useId()

  // Slab 5: the .mmproject include-media decision needs the real footprint.
  // Default = include when the media total is small (≤1 GB), exclude above —
  // the user's explicit choice (includeMediaChoice) always wins.
  const { data: storage } = useQuery({
    queryKey: ['project-storage', projectId],
    queryFn: () => projectsApi.storage(projectId),
    enabled: open && !!projectId,
    staleTime: 60_000,
  })
  // #974: the limit that governs whether this export can happen at all — a
  // DIFFERENT question from the media footprint above, which blocks nothing.
  // A separate call deliberately: this one is a ~250 ms COUNT, and folding it
  // into `project-storage` would delay the include-media default that the
  // checkbox below is waiting on.
  const { data: exportCeiling } = useQuery({
    queryKey: ['project-export-ceiling', projectId],
    queryFn: () => projectsApi.exportCeiling(projectId),
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
    // D96: the button is `aria-disabled` while the scope is unknown, which changes what it
    // announces, not what it does (#754) — this refusal is the load-bearing half.
    if (waitingForScope) return
    setExporting(true)
    // #820: the downloads run in parallel (each is an independent request), but
    // the dialog now WAITS for them. It used to fire and forget, so "Exporting…"
    // cleared and the dialog closed while a 3-minute Excel export was still in
    // flight — and if that request then failed the researcher met a toast about
    // a dialog they had left. `downloadFromApi` never rejects, so collecting the
    // promises cannot turn one export's failure into another's.
    const pending: Promise<unknown>[] = []
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
          quotes: state.quotes,
          sources: state.sources,
          audit: state.audit,
        }
        // D97: its coding sheets narrow and a *Scope* sheet is appended (server-side).
        pending.push(exportApi.excelWithOptions(projectId, options, coderScope))
        await delay(200)
      }

      // Conversations - CSV
      if (state.csv) {
        pending.push(exportApi.csv(projectId, coderScope))
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
        // #1608 — the participant table's rating columns roll up every coder's ratings.
        pending.push(exportApi.datasetsExcel(projectId, coderScope))
        await delay(200)
      }

      // Qualitative - Code Frequencies
      if (state.codeFrequencies) {
        // #1528 D87: the Descriptives summary table's rows over the whole project — every
        // source of every kind (the old server file, asked with no parameters, held
        // conversations, documents and clips and no survey answer), interviewer turns out as
        // the table's default has them. Never rejects (`exportCodeFrequenciesCsv`).
        // #1530 D97: while blind, the viewer's own coding, said on the file's scope line as the
        // analysis page says it (`frequencyFileScope`). Unscoped, the request is unchanged.
        pending.push(exportCodeFrequenciesCsv(projectId, {
          request: codeFrequenciesFileRequest([], NO_SELECTION, 'all', {
            exclude_facilitator: true,
            ...(coderScope && self != null ? { coder_ids: [self] } : {}),
          }),
          categoryMode: false,
          scope: coderScope ? frequencyFileScope(null, [user?.username ?? `coder ${self}`]) : null,
          projectName,
        }))
        await delay(200)
      }

      // Qualitative - Coded Segments
      if (state.codedSegments) {
        // D97: rows AND *Other Codes* narrow; no preamble line (the coding import reads line 1).
        pending.push(exportApi.codedSegments(projectId, coderScope ? { coder_ids: coderScope } : undefined))
        await delay(200)
      }

      // Qualitative - Code Co-occurrence
      if (state.codeCooccurrence) {
        // #1527 D86: a project-wide file holds every kind. With no source the server's
        // `conversations` default left every survey answer out of it. #1530: its existing
        // `Scope:` line names the coder (#512).
        pending.push(exportApi.codeCooccurrence(projectId, {
          source: 'all', ...(coderScope ? { coder_ids: coderScope } : {}),
        }))
        await delay(200)
      }

      // Quantitative - Record Matrix
      if (state.rowMatrix) {
        // #1615: the viewer alone while blind — a metric over a rating score is left out, and
        // the file says so (the server's words).
        pending.push(Promise.resolve(metricsApi.rowMatrix(projectId, undefined, 'csv', coderScope)))
      }

      // Statistical Software - R Data Export
      if (state.rDataExport) {
        // #820: no hand-rolled anchor, no `alert()`. `exportApi.rData` routes
        // through `downloadFromApi` like every other export, so it carries the
        // export timeout, the server's Content-Disposition filename, and the
        // app's own toast for a failure.
        // D97: while blind the three agreement files and sections are left out (the
        // Reliability tab is hidden), and `setup.R` says so where they stood.
        pending.push(exportApi.rData(projectId, coderScope))
        await delay(200)
      }

      await Promise.all(pending)
      onOpenChange(false)
    } finally {
      setExporting(false)
    }
  // `projectName` is a dependency: the project loads after the layout first renders, and a
  // handler that captured the first render's `undefined` named the file without the project
  // (found by driving #1528). The scope is one too — a reveal must reach the next export.
  }, [state, projectId, projectName, onOpenChange, waitingForScope, coderScope, self, user?.username])

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
          {/* #1530 D96 — while blind, one sentence above the list and the same logged reveal
            * the workbenches offer (`surface="export"`). Kept mounted once revealed, saying
            * so, so the toggle holds focus across the reveal's confirm and the coder can
            * re-hide here. Inside the scroll region: at 640×360 the dialog has no fixed
            * height to spare. Multi-PERSON projects only — a machine is not a colleague (#989). */}
          {multiHumanCoder && (
            <div
              data-testid="export-blind-scope"
              className="flex items-start gap-2 rounded-md border border-mm-surface-border bg-mm-surface-hover/50 px-3 py-2 text-xs text-mm-text-muted"
            >
              {blind && <EyeOff className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden="true" />}
              <p className="flex-1 min-w-0">{blind ? EXPORT_BLIND_SENTENCE : EXPORT_REVEALED_SENTENCE}</p>
              <span className="flex-none">
                <BlindModeToggle blind={blind} onToggle={toggleReveal} surface="export" />
              </span>
            </div>
          )}

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
                    } catch (err) {
                      // #842: the server names the size limit and what it does NOT
                      // affect; a bare catch threw that away.
                      toastProjectExportError(err, 'Project export failed')
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
                {/* #974: state the share ceiling at the point of the act. Shown
                  * only once it is worth saying — a project at 3% of the limit
                  * does not need a number, and the same threshold decides it
                  * here and on the Overview because both read one helper. */}
                {hasCeilingToReport(exportCeiling) && ceilingLevel(exportCeiling) !== 'fine' && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1 ml-0.5">
                    {describeCeiling(exportCeiling).figure} — {describeCeiling(exportCeiling).consequence}
                  </p>
                )}
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
                    } catch (err) {
                      // #633: an empty codebook is refused with an actionable
                      // 400 — the schema requires at least one code.
                      toast.error(extractApiError(err, 'QDC export failed'))
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

          {/* Project-wide qualitative exports — NOT conversation-scoped. The
              heading said "Conversations" until #629, which was true when the
              workbook was conversation-only and stopped being true at #620:
              Coded Data, Notes, Quotes and now the Code-Source Matrix all span
              conversations, documents AND observation clips. A researcher
              reading the old heading had every reason to look elsewhere for
              their document coding. */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-mm-text-secondary mb-2">
              Full project
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
                      ['quotes', 'Quotes'],
                      ['sources', 'Sources'],
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
                {/* #650: this and "Coded Segments (CSV)" below are the two
                    shapes of the same data, and users kept having to guess.
                    This one is WIDE — a row per segment, a 1/0 column per code,
                    uncoded segments included — i.e. the case-by-variable matrix
                    you load into SPSS/R. The other is LONG (a row per code
                    application) and cannot contain an uncoded unit. Naming the
                    shape is the only way the choice is makeable from here. */}
                <Label
                  htmlFor="csv"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  CSV (segment × code matrix, wide)
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
                {/* "long" pairs with the wide matrix above (#650) — same data,
                    the other shape. One row per code application, so only coded
                    units appear. */}
                <Label
                  htmlFor="codedSegments"
                  className="text-sm text-mm-text cursor-pointer select-none"
                >
                  Coded Segments (CSV, long)
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

        <DialogFooter className="sm:justify-between">
          {/* #820: the wait is now real, so say how long it can be. Measured on
            * a 75,699-record survey: 86 s for the R export, 213 s for datasets
            * Excel. Silence at that length reads as a hang. */}
          <p id={statusId} aria-live="polite" className="text-xs text-mm-text-secondary sm:mr-auto">
            {exporting
              ? 'Working — a large project can take a few minutes. You can close this; '
                + 'the download still arrives.'
              : waitingForScope ? EXPORT_WAITING_SENTENCE : ''}
          </p>
          {/* #837: not disabled while exporting, and renamed because its
            * meaning changes. Measured on a 75,699-record survey, datasets-Excel
            * is 181 s of server work, and this button was disabled for all of it.
            *
            * ⚠️ The premise that motivated this was REFUTED and the correction is
            * why the fix is what it is: the researcher was NOT trapped.
            * `DialogContent` always renders a corner ✕ (`ui/dialog.tsx:46`) which
            * is never disabled, so there was always a way out. The real defect is
            * that two controls performing the identical action disagreed about
            * whether it was allowed — and the disabled one is the one that looks
            * like the answer.
            *
            * So it matches the ✕ in both respects, name included. Two controls,
            * one action, one name is consistent; "Cancel" is the word that would
            * be wrong, because closing does not stop the export. Safe to leave:
            * each export is an independent fetch that triggers its own download
            * and reports its own failure through `downloadFromApi`'s toast, and
            * this dialog is a persistent ProjectLayout overlay, so the `finally`
            * above still runs against a mounted component. */}
          <Button
            data-testid="export-dismiss"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {exporting ? 'Close' : 'Cancel'}
          </Button>
          {/* D96: while the scope is unknown the button WAITS — `aria-disabled` + the guard in
            * `handleExport`, never `disabled` (it would leave the tab order and say nothing),
            * described by the sentence above, which says why. A precondition still being read,
            * so its name does not change (`dialog-focus.md` §4's `confirmWaiting`). */}
          <Button
            onClick={handleExport}
            disabled={!hasAnySelected || exporting}
            aria-disabled={waitingForScope || undefined}
            aria-describedby={waitingForScope ? statusId : undefined}
            className={`gap-2 ${waitingForScope ? MODE_DISABLED_CLASS : ''}`}
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
