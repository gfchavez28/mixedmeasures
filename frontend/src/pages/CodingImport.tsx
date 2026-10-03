import { useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FileInput, LoaderCircle, CircleCheck, TriangleAlert, Bot, User as UserIcon, Download,
} from 'lucide-react'
import {
  authApi, codingImportApi, datasetsApi, textCodingApi,
  type Coder, type CodingImportCoderCandidate, type CodingImportPreview,
  type CodingImportProblem, type CodingImportResult, type CodingImportTarget,
  type TextCodingColumn,
} from '@/lib/api'
import { downloadBlob } from '@/lib/api/download'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { ALL_CODERS_QUERY_KEY, resetCoderRoster } from '@/hooks/useCoders'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { LoadState } from '@/components/LoadStatus'
import { useListLoad } from '@/hooks/useListLoad'
import { listStatus } from '@/lib/list-status'
import { cn } from '@/lib/utils'
import { formatBytes, plural } from '@/lib/format'
import { openPickerFromZoneClick } from '@/lib/drop-zone'
import {
  CODING_IMPORT_ACCEPT, CODING_IMPORT_FORMAT_LABEL, CODING_IMPORT_HEADER_ALIASES,
  CODING_IMPORT_OPTIONAL_HEADERS, CODING_IMPORT_REQUIRED_HEADERS,
  isSupportedCodingImportFile,
} from '@/lib/coding-import-formats'
import {
  CODER_NAME_MAX_LENGTH, coderOptionLabel, draftBlocker, initialDraft,
  matchKeyOptions, namesSharingACoder, toDecision, type CoderDraft,
} from '@/lib/coding-import-mapping'
import {
  PROBLEM_LIST_LIMIT, problemsCsv, problemsFilename, reasonSummary,
} from '@/lib/coding-import-report'
import { isMachineCoder } from '@/lib/coding-layers'
import MachineProvenanceFields from '@/components/MachineProvenanceFields'
import { invalidateAfterCodingImport } from '@/lib/coding-cache'
import { serverDetailMessage } from '@/lib/api/error-utils'
import { toast } from 'sonner'
import { checkImportFiles } from '@/lib/upload-limits'
import { useStepFocus } from '@/hooks/useStepFocus'
import UploadLimitNote from '@/components/UploadLimitNote'

/**
 * Bulk import of code applications (queue row 49).
 *
 * A FULL PAGE, not a dialog: this app has no multi-step dialog and every import
 * is a page (`MergeProject.tsx`'s reasoning, and the same shape).
 *
 * 🔴 **The coder mapping is the point of the middle step.** The server REFUSES an
 * unmapped name — the one place this import departs from the `.mmproject`
 * merge, which falls back to a silent name-match. A merge at least matches a uuid
 * spine; a CSV carries a string somebody typed, so a name that merely LOOKS like
 * a colleague's is the misattribution J3-2's confirm screen exists to prevent.
 */

type Step = 'upload' | 'map' | 'done'

interface Scope {
  targetKind: CodingImportTarget
  columnId: number | null
  matchColumnId: number | null
}

const STEP_HEADING = {
  upload: 'Step 1 of 3: choose the file',
  map: 'Step 2 of 3: check the file and say whose codings these are',
  done: 'Step 3 of 3: the import is finished',
} satisfies Record<Step, string>

export default function CodingImport() {
  const { projectId } = useProjectLayout()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [targetKind, setTargetKind] = useState<CodingImportTarget>('text_column')
  const [columnId, setColumnId] = useState<number | null>(null)
  const [matchColumnId, setMatchColumnId] = useState<number | null>(null)
  const [preview, setPreview] = useState<CodingImportPreview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, CoderDraft>>({})
  const [result, setResult] = useState<CodingImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /**
   * Where focus goes when the step changes — #935's rule, from MergeProject.
   *
   * Measured by the 2026-09-23 name sweep: *Check the file* and *Import N
   * codings* each unmount the button that was pressed, so focus fell to `<body>`
   * at both transitions, and with no toast on success a keyboard or reader user
   * heard nothing and was sent back to the top of the page. Not on MOUNT — the
   * page opening is not a step change, and stealing focus from the skip link on
   * arrival would be its own defect.
   *
   * ⚠️ Keyed on the step CHANGING, never on "is this the first run": StrictMode
   * runs a mount effect twice and a ref survives between the two, so a
   * first-run flag let the second run take focus on arrival — driven live, and
   * invisible to a test rendered without StrictMode.
   *
   * #1011: this was the reference the shared `useStepFocus` was lifted from —
   * all seven wizards now take the same behaviour from it.
   */
  const stepHeadingRef = useStepFocus(step)

  const columnsQuery = useQuery({
    queryKey: ['text-coding-columns', projectId],
    queryFn: () => textCodingApi.columns(projectId),
    enabled: !!projectId,
  })
  const columns = useMemo(() => columnsQuery.data?.columns ?? [], [columnsQuery.data])
  const columnsLoad = useListLoad(columnsQuery)

  // #1032 (b): the id column comes from the CODED column's dataset, in whatever
  // type holds an id — the project's column list (the shared key other pages
  // read), narrowed by `matchKeyOptions`.
  const projectColumnsQuery = useQuery({
    queryKey: ['project-columns', projectId],
    queryFn: () => datasetsApi.allColumns(projectId),
    enabled: !!projectId && targetKind === 'text_column',
  })
  const keyOptions = useMemo(
    () => matchKeyOptions(projectColumnsQuery.data?.columns ?? [], columnId),
    [projectColumnsQuery.data, columnId],
  )
  const codedDatasetId = columns.find(c => c.column_id === columnId)?.dataset_id ?? null

  // The roster WITH archived coders (#1031 c): a name in the file can match one,
  // and the picker must be able to show — and say — what it is.
  const rosterQuery = useQuery({
    queryKey: ALL_CODERS_QUERY_KEY,
    queryFn: () => authApi.listCoders(true),
    staleTime: 60_000,
  })
  const roster = useMemo(() => rosterQuery.data ?? [], [rosterQuery.data])
  const rosterStatus = listStatus(rosterQuery)

  // 🔴 The two calls must carry the same scope (`codingImportApi.run`'s note), so
  // every control that sets it is LOCKED while *Check the file* runs (#1038 h):
  // a change made during the check reached the import while the screen showed the
  // preview of the old scope. The mapping step has no scope controls, and Back
  // returns to a step that must be checked again — so the lock is the whole rule.
  const scope: Scope = { targetKind, columnId, matchColumnId }

  const canPreview =
    !!file && (targetKind === 'segments' || columnId != null) && !busy
  // Why "Check the file" is off, in words. A transient precondition keeps the
  // native `disabled` (#754's transient arm), so the button earns no tab stop —
  // which is exactly why the reason has to be ON SCREEN beside it.
  const previewBlocker = busy ? null
    : !file ? 'Choose a file to continue.'
      : targetKind === 'text_column' && columnId == null
        ? 'Choose which column these codings are on.'
        : null
  const blockerId = useId()
  const matchHintId = useId()
  const projectOverview = `/projects/${projectId}/overview`

  function chooseCodedColumn(value: string) {
    const next = Number(value)
    setColumnId(next)
    // A key column belongs to ONE dataset; the server refuses it for a column of
    // another, so a choice that no longer fits is cleared rather than sent.
    const nextDataset = columns.find(c => c.column_id === next)?.dataset_id
    if (nextDataset !== codedDatasetId) setMatchColumnId(null)
  }

  async function runPreview() {
    if (!file) return
    setBusy(true)
    try {
      const data = await codingImportApi.preview(projectId, file, scope)
      setPreview(data)
      setDrafts(Object.fromEntries(data.coders.map(c => [c.name, initialDraft(c)])))
      setStep('map')
    } catch (err) {
      toast.error(serverDetailMessage(err) ?? 'The file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!file || !preview) return
    setBusy(true)
    try {
      const decisions = Object.fromEntries(
        Object.entries(drafts).map(([name, draft]) => [name, toDecision(draft)]),
      )
      const data = await codingImportApi.run(projectId, file, scope, decisions)
      setResult(data)
      setStep('done')
      // 🔴 An import changes every coding surface of the project at once, so it
      // invalidates through the helper that says so (#1038 d) — never a
      // hand-listed set (#450).
      invalidateAfterCodingImport(queryClient, projectId)
      // 🔴 And it may have CREATED or UNARCHIVED coders, so the roster is RESET
      // rather than invalidated (#964): an invalidated query keeps serving the
      // old list as an ANSWER until the refetch lands, and a stale one-coder
      // roster turns blind mode off.
      await resetCoderRoster(queryClient)
    } catch (err) {
      toast.error(serverDetailMessage(err) ?? 'The import could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  function acceptFiles(picked: File[]) {
    if (busy) return
    // #1007/#1012: the one type-and-size check every wizard runs, naming the file.
    const { accepted, message } = checkImportFiles(picked, {
      isSupported: isSupportedCodingImportFile, formatLabel: CODING_IMPORT_FORMAT_LABEL, noun: 'coding',
    })
    const next = accepted[0]
    if (!next) {
      toast.error(message)
      return
    }
    setFile(next)
    setPreview(null)
    setResult(null)
  }

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (!busy) setIsDragOver(true) },
    onDragLeave: () => setIsDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      acceptFiles(Array.from(e.dataTransfer.files))
    },
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {/* 🔴 NO header Back button. It was `navigate(-1)` — the only history-
          relative exit in the app — so on the mapping step it sat above a SECOND
          "Back" that meant "previous step" while it meant "leave and discard the
          coder decisions", and opened from a link it left the app entirely. Every
          exit now names a fixed destination, MergeProject's shape. */}
      <h1 className="text-lg font-semibold text-mm-text">Import codings</h1>
      {/* The step's own heading and the element focus lands on (above). Visually
          hidden because each card already titles itself; what was missing was a
          place to move TO — and a level 2, since the cards' titles are level 3. */}
      <h2 ref={stepHeadingRef} tabIndex={-1} className="sr-only">
        {STEP_HEADING[step]}
      </h2>

      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle>Choose the file and what it is about</CardTitle>
            <CardDescription>
              One row per coding. Codings imported here are attributed to whoever
              you say they belong to — including a machine coder, whose labels a
              model produced elsewhere.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div
              className={cn(
                'rounded-lg border-2 border-dashed p-10 text-center transition-colors',
                isDragOver
                  ? 'border-mm-blue bg-mm-blue/10'
                  : 'border-mm-border-medium bg-mm-surface',
              )}
              onClick={(e) => {
                if (!busy) openPickerFromZoneClick(e, () => fileInputRef.current?.click())
              }}
              {...dragHandlers}
            >
              <FileInput className="w-10 h-10 mx-auto text-mm-text-faint mb-3" />
              <p className="text-sm text-mm-text-muted mb-1">
                Drag and drop a {CODING_IMPORT_FORMAT_LABEL} file here, or click to browse
              </p>
              <p className="text-xs text-mm-text-faint mb-1">
                Columns: {CODING_IMPORT_REQUIRED_HEADERS.join(', ')}
                {' — optionally '}
                {CODING_IMPORT_OPTIONAL_HEADERS.map(h => {
                  const alias = Object.entries(CODING_IMPORT_HEADER_ALIASES)
                    .find(([, target]) => target === h)?.[0]
                  return alias ? `${h} (or ${alias})` : h
                }).join(' and ')}
              </p>
              <UploadLimitNote noun="coding files" className="mb-4" />
              <Button onClick={() => fileInputRef.current?.click()} disabled={busy}>
                Select file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={CODING_IMPORT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) acceptFiles(Array.from(e.target.files))
                  e.target.value = ''
                }}
              />
              {file && (
                <p className="mt-4 text-sm text-mm-text">
                  {file.name}{' '}
                  <span className="text-mm-text-faint">{formatBytes(file.size)}</span>
                </p>
              )}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-mm-text mb-2">
                What does <code>unit_id</code> name?
              </legend>
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="target-kind"
                    className="mt-1"
                    checked={targetKind === 'text_column'}
                    disabled={busy}
                    onChange={() => setTargetKind('text_column')}
                  />
                  <span>
                    <span className="text-mm-text">A record in a dataset</span>
                    <span className="block text-xs text-mm-text-muted">
                      For open-text responses coded in Text Coding — survey answers,
                      social-media posts.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="target-kind"
                    className="mt-1"
                    checked={targetKind === 'segments'}
                    disabled={busy}
                    onChange={() => setTargetKind('segments')}
                  />
                  <span>
                    <span className="text-mm-text">A segment’s Unit ID</span>
                    <span className="block text-xs text-mm-text-muted">
                      For transcripts, documents and observation clips. The
                      <em> Unit ID</em> column of the coded-segments export — that
                      export imports as it is, ratings included.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>

            {targetKind === 'text_column' && (
              <div className="space-y-3">
                {/* ⚠️ The list decides which column can be coded, so the surface
                    WAITS for it rather than offering an empty picker — a claim
                    that rests on a list waits for the list (#961). */}
                {columnsLoad.status !== 'ready' ? (
                  <LoadState
                    load={columnsLoad}
                    loadingLabel="Loading text columns…"
                    failedTitle="The text columns could not be loaded."
                    size="panel"
                  />
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="coded-column">Which column are these codings on?</Label>
                      <Select
                        // `''`, never `undefined`: Radix shows the placeholder for
                        // both, and `undefined` made the Select switch from
                        // uncontrolled to controlled on the first choice (React
                        // warns, found by driving).
                        value={columnId != null ? String(columnId) : ''}
                        onValueChange={chooseCodedColumn}
                        disabled={busy}
                      >
                        <SelectTrigger id="coded-column" className="w-full max-w-md">
                          <SelectValue placeholder="Choose a text column" />
                        </SelectTrigger>
                        <SelectContent>
                          {columns.map((c: TextCodingColumn) => (
                            <SelectItem key={c.column_id} value={String(c.column_id)}>
                              {c.dataset_name} · {c.column_name ?? c.column_text}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="match-column">
                        What are the ids in your file? <span className="font-normal text-mm-text-muted">(optional)</span>
                      </Label>
                      <Select
                        value={matchColumnId != null ? String(matchColumnId) : 'record'}
                        onValueChange={(v) => setMatchColumnId(v === 'record' ? null : Number(v))}
                        disabled={busy || columnId == null}
                      >
                        <SelectTrigger
                          id="match-column"
                          className="w-full max-w-md"
                          aria-describedby={matchHintId}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="record">
                            Record IDs (R0001, R0002, …)
                          </SelectItem>
                          {keyOptions.map(o => (
                            <SelectItem key={o.id} value={String(o.id)}>
                              Values of {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p id={matchHintId} className="text-xs text-mm-text-muted max-w-md">
                        {columnId == null
                          ? 'Choose the column being coded first — the ids come from the same dataset.'
                          : keyOptions.length === 0 && projectColumnsQuery.isSuccess
                            ? 'Record IDs are the ones this app generates and exports. This dataset has no other column that could hold ids.'
                            : 'Record IDs are the ones this app generates and exports. Choose a column instead if your file uses your own identifier — a post id, a respondent number.'}
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={runPreview}
                disabled={!canPreview}
                className="gap-2"
                aria-describedby={previewBlocker ? blockerId : undefined}
              >
                {busy && <LoaderCircle className="w-4 h-4 animate-spin" />}
                Check the file
              </Button>
              <Button variant="outline" onClick={() => navigate(projectOverview)} disabled={busy}>
                Cancel
              </Button>
              {previewBlocker && (
                <p id={blockerId} className="text-xs text-mm-text-muted">{previewBlocker}</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'map' && preview && (
        <MapStep
          preview={preview}
          fileName={file?.name}
          drafts={drafts}
          setDrafts={setDrafts}
          roster={roster}
          rosterStatus={rosterStatus}
          busy={busy}
          onBack={() => setStep('upload')}
          onImport={runImport}
        />
      )}

      {step === 'done' && result && (
        <DoneStep
          result={result}
          fileName={file?.name}
          onOpenAnalysis={() => navigate(`/projects/${projectId}/analysis/qualitative`)}
          onFinish={() => navigate(projectOverview)}
        />
      )}
    </div>
  )
}

// ── The mapping step ────────────────────────────────────────────────────────

function MapStep({
  preview, fileName, drafts, setDrafts, roster, rosterStatus, busy, onBack, onImport,
}: {
  preview: CodingImportPreview
  fileName: string | undefined
  drafts: Record<string, CoderDraft>
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, CoderDraft>>>
  roster: Coder[]
  rosterStatus: ReturnType<typeof listStatus>
  busy: boolean
  onBack: () => void
  onImport: () => void
}) {
  const update = (name: string, patch: Partial<CoderDraft>) =>
    setDrafts(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }))
  // 🔴 Control ids and radio-group names come from `useId` + the row's INDEX,
  // never from the coder's name. That name is a string typed into a file: an id
  // containing spaces is invalid HTML (and breaks every `#id` selector), and a
  // name is not guaranteed to be id-safe at all.
  const baseId = useId()
  const importBlockerId = useId()

  const matchedNoUnit = preview.units_matched === 0 && preview.rows_read > 0
  const matchedNoCode = preview.codes_matched === 0 && preview.codes_in_file > 0
  const shared = namesSharingACoder(drafts)
  const blockers = preview.coders
    .map(c => (drafts[c.name] ? draftBlocker(c.name, drafts[c.name]) : null))
    .filter((b): b is string => b != null)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What this file resolves to</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Rows read" value={preview.rows_read} />
            <Stat label="Will be applied" value={preview.will_apply} />
            {/* 🔴 These two are how a file addressed with the WRONG key — or built
                against another codebook — is visible before anything is written,
                and each half is counted on its own (#1004): three ids of five
                hundred is not a coding problem, and it no longer reads as one. */}
            <Stat label="Ids found" value={preview.units_matched} of={preview.units_in_file} />
            <Stat label="Code names found" value={preview.codes_matched} of={preview.codes_in_file} />
          </dl>
          {matchedNoUnit && (
            <p
              role="alert"
              className="text-sm rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 px-3 py-2 text-amber-900 dark:text-amber-100"
            >
              <TriangleAlert className="w-4 h-4 inline mr-1" aria-hidden="true" />
              None of the ids in this file matched a unit in your project. Check that
              they are the ones you chose on the previous step.
            </p>
          )}
          {matchedNoCode && (
            <p
              role="alert"
              className="text-sm rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 px-3 py-2 text-amber-900 dark:text-amber-100"
            >
              <TriangleAlert className="w-4 h-4 inline mr-1" aria-hidden="true" />
              None of the code names in this file is a code in this project. Check
              that the file was built against this project’s codebook.
            </p>
          )}
          {preview.grouped_passages > 0 && (
            <p className="text-xs text-mm-text-muted">
              {preview.grouped_passages.toLocaleString()} more{' '}
              {preview.grouped_passages === 1 ? 'passage' : 'passages'} will be coded
              because {preview.grouped_passages === 1 ? 'it is' : 'they are'} grouped
              with a passage the file names — a group is coded as one unit.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Whose codings are these?</CardTitle>
          <CardDescription>
            Every name in the file needs an answer. Nothing is matched by name on
            your behalf — a name that looks like a colleague’s is not evidence
            that it is theirs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {rosterStatus !== 'ready' && (
            <p className="text-xs text-mm-text-muted">
              The coder list has not loaded, so existing coders cannot be offered
              yet. You can still create new ones.
            </p>
          )}
          {preview.coders.map((candidate, index) => {
            const draft = drafts[candidate.name]
            if (!draft) return null
            return (
              <CoderRow
                key={candidate.name}
                rowId={`${baseId}-coder-${index}`}
                candidate={candidate}
                draft={draft}
                roster={roster}
                rosterReady={rosterStatus === 'ready'}
                sharedWith={shared.get(candidate.name) ?? []}
                onChange={(patch) => update(candidate.name, patch)}
              />
            )
          })}
        </CardContent>
      </Card>

      {preview.problems.length > 0 && (
        <ProblemsCard
          problems={preview.problems}
          counts={preview.reason_counts}
          fileName={fileName}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
        <Button
          onClick={onImport}
          disabled={busy || preview.will_apply === 0 || blockers.length > 0}
          className="gap-2"
          aria-describedby={blockers.length > 0 ? importBlockerId : undefined}
        >
          {busy && <LoaderCircle className="w-4 h-4 animate-spin" />}
          Import {preview.will_apply.toLocaleString()} {preview.will_apply === 1 ? 'coding' : 'codings'}
        </Button>
        {blockers.length > 0 && (
          <ul id={importBlockerId} className="text-xs text-mm-text-muted space-y-0.5">
            {blockers.map(b => <li key={b}>{b}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}

function CoderRow({
  rowId, candidate, draft, roster, rosterReady, sharedWith, onChange,
}: {
  rowId: string
  candidate: CodingImportCoderCandidate
  draft: CoderDraft
  roster: Coder[]
  rosterReady: boolean
  sharedWith: string[]
  onChange: (patch: Partial<CoderDraft>) => void
}) {
  const chosen = draft.targetUserId != null
    ? roster.find(c => c.id === draft.targetUserId) ?? null
    : null
  const isNameMatch = draft.targetUserId != null && draft.targetUserId === candidate.local_user_id
  const hintId = `${rowId}-target-hint`
  const kindNoteId = `${rowId}-kind-note`
  // ONE string, never sentences as sibling JSX fragments: the space between two
  // of them was a text node of its own, and Chrome dropped it from the
  // accessibility tree when the second sentence arrived after the first had
  // rendered — the picker's description read "…your projects.“Model A” also
  // goes…" (a11y-name-sweep run 9, 2026-09-27).
  const hint = [
    isNameMatch
      ? `A coder called “${candidate.name}” already exists, with `
        + `${candidate.local_application_count.toLocaleString()} `
        + `${plural(candidate.local_application_count, 'coding', 'codings')} across your projects.`
      : null,
    chosen && isMachineCoder(chosen)
      ? `“${chosen.username}” is a model`
        + `${chosen.machine_provenance?.model ? ` (${chosen.machine_provenance.model})` : ''}: `
        + 'its codings are compared on the Model comparison tab and never enter reliability.'
      : null,
    sharedWith.length > 0
      ? `${sharedWith.map(n => `“${n}”`).join(' and ')} also ${sharedWith.length === 1 ? 'goes' : 'go'} `
        + 'to this coder — where the names disagree about a passage, neither row is imported.'
      : null,
  ].filter(Boolean).join(' ')

  return (
    <fieldset className="rounded-md border border-border p-3 space-y-3">
      <legend className="px-1 text-sm font-medium text-mm-text">
        {candidate.name}{' '}
        <span className="font-normal text-mm-text-muted">
          · {candidate.row_count.toLocaleString()} {candidate.row_count === 1 ? 'row' : 'rows'}
          {candidate.rows_to_apply < candidate.row_count && (
            candidate.rows_to_apply === 0
              ? ', none can be imported'
              : `, ${candidate.rows_to_apply.toLocaleString()} can be imported`
          )}
        </span>
      </legend>
      {candidate.rows_to_apply === 0 && (
        <p className="text-xs text-mm-text-muted">
          Every row for this name is listed below as not importable, so it is left out
          unless you choose otherwise.
        </p>
      )}

      <div className="flex flex-wrap gap-3 text-sm">
        {(['match', 'create', 'skip'] as const).map(action => (
          <label key={action} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${rowId}-action`}
              checked={draft.action === action}
              disabled={action === 'match' && !rosterReady}
              onChange={() => onChange({ action })}
            />
            <span>
              {action === 'match' ? 'An existing coder'
                : action === 'create' ? 'A new coder'
                  : 'Do not import these'}
            </span>
          </label>
        ))}
      </div>

      {draft.action === 'match' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor={`${rowId}-target`}>Which coder</Label>
            <Select
              value={draft.targetUserId != null ? String(draft.targetUserId) : ''}
              onValueChange={(v) => {
                const picked = roster.find(c => c.id === Number(v))
                // An archived pick is offered back to the roster, visibly — the
                // merge's shape (#1031 c).
                onChange({ targetUserId: Number(v), unarchive: !!picked?.archived })
              }}
            >
              {/* The note below says what the chosen coder IS — the facts this
                  choice turns on — so it is the trigger's description, as the
                  provenance fields' hints are (2026-09-23 sweep). */}
              <SelectTrigger id={`${rowId}-target`} className="w-full max-w-sm" aria-describedby={hintId}>
                <SelectValue placeholder="Choose a coder" />
              </SelectTrigger>
              <SelectContent>
                {roster.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {coderOptionLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={hintId} className="text-xs text-mm-text-muted">
              {hint}
            </p>
          </div>
          {chosen?.archived && (
            <div className="rounded-md bg-mm-surface p-2 space-y-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.unarchive}
                  aria-describedby={`${rowId}-archived-note`}
                  onChange={(e) => onChange({ unarchive: e.target.checked })}
                />
                <span>Bring “{chosen.username}” back from the archive</span>
              </label>
              <p id={`${rowId}-archived-note`} className="text-xs text-mm-text-muted pl-6">
                {draft.unarchive
                  ? 'They will be listed again, and their codings shown and counted.'
                  : 'They are archived: these codings will be hidden by default and left out of reliability and the model comparison.'}
              </p>
            </div>
          )}
        </div>
      )}

      {draft.action === 'create' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${rowId}-name`}>Name</Label>
              <Input
                id={`${rowId}-name`}
                value={draft.newUsername}
                maxLength={Math.max(CODER_NAME_MAX_LENGTH, draft.newUsername.length)}
                onChange={(e) => onChange({ newUsername: e.target.value })}
              />
            </div>
            {/* A real group: "Kind" was a bare <span>, so the two radios
                announced as "A person" / "A machine" with nothing saying
                what was being chosen. And NOTHING is pre-chosen (#1038 h): the
                kind cannot be changed afterwards, and it decides whether these
                codings enter reliability. */}
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium text-mm-text">Kind</legend>
              <div className="flex gap-3 text-sm pt-1.5">
                {/* The note below is each radio's DESCRIPTION: it is the one
                    place that says the choice is permanent and what it decides,
                    and a reader moving by form control never met it
                    (a11y-name-sweep run 9). */}
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${rowId}-kind`}
                    checked={draft.coderType === 'human'}
                    aria-describedby={kindNoteId}
                    onChange={() => onChange({ coderType: 'human' })}
                  />
                  <UserIcon className="w-3.5 h-3.5" aria-hidden="true" /> A person
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${rowId}-kind`}
                    checked={draft.coderType === 'ai'}
                    aria-describedby={kindNoteId}
                    onChange={() => onChange({ coderType: 'ai' })}
                  />
                  <Bot className="w-3.5 h-3.5" aria-hidden="true" /> A machine
                </label>
              </div>
              <p id={kindNoteId} className="text-xs text-mm-text-muted">
                A person’s codings count toward agreement; a machine’s are compared on
                the Model comparison tab and never do. This cannot be changed later.
              </p>
            </fieldset>
          </div>

          {/* 🔴 This is question 3 (provenance) reaching a screen: 75% of
              published LLM-coding studies report no parameter settings and
              45% do not say how the model was reached. Every field is
              OPTIONAL — an unrecorded configuration is honest and common. */}
          {draft.coderType === 'ai' && (
            <div className="rounded-md bg-mm-surface p-3 space-y-3">
              <p className="text-xs text-mm-text-muted">
                Recording what produced these labels is what makes them
                citable. Anyone reading your findings — including you,
                later — needs to know which model, reached how, under what
                instructions.
              </p>
              <MachineProvenanceFields
                idPrefix={rowId}
                values={draft}
                onChange={onChange}
              />
            </div>
          )}
        </div>
      )}
    </fieldset>
  )
}

function ProblemsCard({
  problems, counts, fileName, done = false,
}: {
  problems: CodingImportProblem[]
  counts: Record<string, number>
  fileName: string | undefined
  /** After the import the sentence is past tense — "will not be" on the result
      screen read as a warning about an act still to come (2026-09-23 sweep). */
  done?: boolean
}) {
  const one = problems.length === 1
  const verb = !done ? 'will not be imported' : one ? 'was not imported' : 'were not imported'
  // 🔴 Bounded: a wrong key refuses every row, and the table rendered all of them
  // (#1045's class). The whole list is a download away.
  const shown = problems.slice(0, PROBLEM_LIST_LIMIT)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {problems.length.toLocaleString()} {one ? 'row' : 'rows'} {verb}
        </CardTitle>
        <CardDescription>{reasonSummary(counts)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-mm-text-muted">
          {problems.length > shown.length && (
            <span>
              Showing the first {shown.length.toLocaleString()} of {problems.length.toLocaleString()}.
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => downloadBlob(
              new Blob([problemsCsv(problems)], { type: 'text/csv;charset=utf-8' }),
              problemsFilename(fileName),
            )}
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Download the list
          </Button>
        </div>
        <ScrollableTable maxHeight="16rem">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Rows that {done ? 'were not' : 'will not be'} imported, with the reason for each
              {problems.length > shown.length
                ? ` — the first ${shown.length.toLocaleString()} of ${problems.length.toLocaleString()}`
                : ''}
            </caption>
            <thead>
              <tr className="text-left text-xs text-mm-text-muted">
                <th scope="col" className="py-1 pr-3 font-medium">Line</th>
                <th scope="col" className="py-1 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1.5 pr-3 tabular-nums text-mm-text-muted align-top">{p.line}</td>
                  <td className="py-1.5 text-mm-text">{p.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      </CardContent>
    </Card>
  )
}

function DoneStep({
  result, fileName, onOpenAnalysis, onFinish,
}: {
  result: CodingImportResult
  fileName: string | undefined
  onOpenAnalysis: () => void
  onFinish: () => void
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleCheck className="w-5 h-5 text-mm-green" aria-hidden="true" />
            Import finished
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Codings added" value={result.applied} />
            {result.already_present > 0 && (
              <Stat label="Already there" value={result.already_present} />
            )}
            {result.selections > 0 && <Stat label="Set selections" value={result.selections} />}
            {result.replaced > 0 && <Stat label="Replaced" value={result.replaced} />}
            {result.ratings_set > 0 && <Stat label="Ratings set" value={result.ratings_set} />}
            {result.coders_created > 0 && (
              <Stat label="Coders created" value={result.coders_created} />
            )}
            {result.coders_unarchived > 0 && (
              <Stat label="Coders brought back" value={result.coders_unarchived} />
            )}
            {result.skipped > 0 && <Stat label="Rows skipped" value={result.skipped} />}
          </dl>
        </CardContent>
      </Card>
      {result.problems.length > 0 && (
        <ProblemsCard
          problems={result.problems}
          counts={result.reason_counts}
          fileName={fileName}
          done
        />
      )}
      {/* MergeProject's finish: where the imported coding can be SEEN — codes,
          and, for a machine coder, the Model comparison tab (#1030) —
          then a plain exit. Qualitative Analysis reads transcript, document,
          clip AND text-column codings, so it is right for both import kinds. */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onOpenAnalysis}>Open Qualitative Analysis</Button>
        <Button variant="outline" onClick={onFinish}>Done</Button>
      </div>
    </div>
  )
}

function Stat({ label, value, of }: { label: string; value: number; of?: number }) {
  return (
    <div>
      <dt className="text-xs text-mm-text-muted">{label}</dt>
      <dd className="text-lg tabular-nums text-mm-text">
        {value.toLocaleString()}
        {of != null && (
          <span className="text-sm text-mm-text-muted"> of {of.toLocaleString()}</span>
        )}
      </dd>
    </div>
  )
}
