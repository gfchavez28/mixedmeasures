import { useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FileInput, LoaderCircle, CircleCheck, TriangleAlert, Bot, User as UserIcon,
} from 'lucide-react'
import {
  codingImportApi, textCodingApi,
  type CodingImportCoderCandidate, type CodingImportDecision,
  type CodingImportPreview, type CodingImportResult, type CodingImportTarget,
  type TextCodingColumn,
} from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useCoders, resetCoderRoster } from '@/hooks/useCoders'
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
import { formatBytes } from '@/lib/format'
import { openPickerFromZoneClick } from '@/lib/drop-zone'
import {
  CODING_IMPORT_ACCEPT, CODING_IMPORT_FORMAT_LABEL,
  CODING_IMPORT_OPTIONAL_HEADERS, CODING_IMPORT_REQUIRED_HEADERS,
  isSupportedCodingImportFile,
} from '@/lib/coding-import-formats'
import { parseParameters, type MachineAccess } from '@/lib/machine-coder'
import MachineProvenanceFields from '@/components/MachineProvenanceFields'
import { invalidateDerivedCounts } from '@/lib/coding-cache'
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

/** A local decision before it becomes a `CodingImportDecision`. */
interface Draft {
  action: 'match' | 'create' | 'skip'
  targetUserId: number | null
  newUsername: string
  coderType: 'human' | 'ai'
  model: string
  access: MachineAccess | ''
  prompt: string
  parameters: string
}

function initialDraft(candidate: CodingImportCoderCandidate): Draft {
  return {
    // 🔴 A confident local match is PRE-SELECTED but never applied on its own —
    // the researcher still presses Import, which is what makes the mapping a
    // decision rather than a default (the merge's R3 rule).
    action: candidate.local_user_id != null ? 'match' : 'create',
    targetUserId: candidate.local_user_id,
    newUsername: candidate.name,
    coderType: 'human',
    model: '',
    access: '',
    prompt: '',
    parameters: '',
  }
}

function toDecision(draft: Draft): CodingImportDecision {
  if (draft.action === 'skip') return { action: 'skip' }
  if (draft.action === 'match') {
    return { action: 'match', target_user_id: draft.targetUserId }
  }
  const parameters = parseParameters(draft.parameters)
  const model = draft.model.trim()
  return {
    action: 'create',
    new_username: draft.newUsername.trim() || undefined,
    coder_type: draft.coderType,
    machine_provenance:
      draft.coderType === 'ai' && model
        ? {
          model,
          ...(draft.access ? { access: draft.access } : {}),
          ...(draft.prompt.trim() ? { prompt: draft.prompt.trim() } : {}),
          ...(Object.keys(parameters).length ? { parameters } : {}),
        }
        : null,
  }
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
  const { coders, status: coderStatus } = useCoders()

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [targetKind, setTargetKind] = useState<CodingImportTarget>('text_column')
  const [columnId, setColumnId] = useState<number | null>(null)
  const [matchColumnId, setMatchColumnId] = useState<number | null>(null)
  const [preview, setPreview] = useState<CodingImportPreview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
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

  const scope = useMemo(
    () => ({ targetKind, columnId, matchColumnId }),
    [targetKind, columnId, matchColumnId],
  )

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
  const projectOverview = `/projects/${projectId}/overview`

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
      // 🔴 An import changes counts across the project, so it invalidates through
      // the ONE place those keys live (#450) — never a hand-listed set.
      invalidateDerivedCounts(queryClient, projectId)
      // 🔴 And it may have CREATED coders, so the roster is RESET rather than
      // invalidated (#964): an invalidated query keeps serving the old list as an
      // ANSWER until the refetch lands, and a stale one-coder roster turns blind
      // mode off.
      await resetCoderRoster(queryClient)
    } catch (err) {
      toast.error(serverDetailMessage(err) ?? 'The import could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  function acceptFiles(picked: File[]) {
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
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true) },
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
              onClick={(e) => openPickerFromZoneClick(e, () => fileInputRef.current?.click())}
              {...dragHandlers}
            >
              <FileInput className="w-10 h-10 mx-auto text-mm-text-faint mb-3" />
              <p className="text-sm text-mm-text-muted mb-1">
                Drag and drop a {CODING_IMPORT_FORMAT_LABEL} file here, or click to browse
              </p>
              <p className="text-xs text-mm-text-faint mb-1">
                Columns: {CODING_IMPORT_REQUIRED_HEADERS.join(', ')}
                {' — optionally '}
                {CODING_IMPORT_OPTIONAL_HEADERS.join(' and ')}
              </p>
              <UploadLimitNote noun="coding files" className="mb-4" />
              <Button onClick={() => fileInputRef.current?.click()}>Select file</Button>
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
                    onChange={() => setTargetKind('segments')}
                  />
                  <span>
                    <span className="text-mm-text">A segment’s Unit ID</span>
                    <span className="block text-xs text-mm-text-muted">
                      For transcripts, documents and observation clips. The
                      <em> Unit ID</em> column of the coded-segments export.
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
                        value={columnId != null ? String(columnId) : undefined}
                        onValueChange={(v) => setColumnId(Number(v))}
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
                      >
                        <SelectTrigger id="match-column" className="w-full max-w-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="record">
                            Record IDs (R0001, R0002, …)
                          </SelectItem>
                          {columns.map((c: TextCodingColumn) => (
                            <SelectItem key={c.column_id} value={String(c.column_id)}>
                              Values of {c.column_name ?? c.column_text}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-mm-text-muted max-w-md">
                        Record IDs are the ones this app generates and exports.
                        Choose a column instead if your file uses your own
                        identifier — a post id, a respondent number.
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
          drafts={drafts}
          setDrafts={setDrafts}
          coders={coders}
          coderStatus={coderStatus}
          busy={busy}
          onBack={() => setStep('upload')}
          onImport={runImport}
        />
      )}

      {step === 'done' && result && (
        <DoneStep
          result={result}
          onOpenAnalysis={() => navigate(`/projects/${projectId}/analysis/qualitative`)}
          onFinish={() => navigate(projectOverview)}
        />
      )}
    </div>
  )
}

// ── The mapping step ────────────────────────────────────────────────────────

function MapStep({
  preview, drafts, setDrafts, coders, coderStatus, busy, onBack, onImport,
}: {
  preview: CodingImportPreview
  drafts: Record<string, Draft>
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>
  coders: { id: number; username: string; archived?: boolean }[]
  coderStatus: ReturnType<typeof listStatus>
  busy: boolean
  onBack: () => void
  onImport: () => void
}) {
  const update = (name: string, patch: Partial<Draft>) =>
    setDrafts(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }))
  // 🔴 Control ids and radio-group names come from `useId` + the row's INDEX,
  // never from the coder's name. That name is a string typed into a file: an id
  // containing spaces is invalid HTML (and breaks every `#id` selector), and a
  // name is not guaranteed to be id-safe at all.
  const baseId = useId()

  const matchedNothing = preview.units_matched === 0 && preview.rows_read > 0

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
            {/* 🔴 These two are how a file addressed with the WRONG key is
                visible before anything is written. Three units of five hundred
                is not a coding problem. */}
            <Stat label="Units matched" value={preview.units_matched} />
            <Stat label="Codes matched" value={preview.codes_matched} />
          </dl>
          {matchedNothing && (
            <p
              role="alert"
              className="text-sm rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 px-3 py-2 text-amber-900 dark:text-amber-100"
            >
              <TriangleAlert className="w-4 h-4 inline mr-1" />
              Nothing in this file matched a unit in your project. Check that the
              ids are the ones you chose on the previous step.
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
          {coderStatus !== 'ready' && (
            <p className="text-xs text-mm-text-muted">
              The coder list has not loaded, so existing coders cannot be offered
              yet. You can still create new ones.
            </p>
          )}
          {preview.coders.map((candidate, index) => {
            const draft = drafts[candidate.name]
            if (!draft) return null
            const rowId = `${baseId}-coder-${index}`
            return (
              <fieldset
                key={candidate.name}
                className="rounded-md border border-border p-3 space-y-3"
              >
                <legend className="px-1 text-sm font-medium text-mm-text">
                  {candidate.name}{' '}
                  <span className="font-normal text-mm-text-muted">
                    · {candidate.row_count} {candidate.row_count === 1 ? 'row' : 'rows'}
                  </span>
                </legend>

                <div className="flex flex-wrap gap-3 text-sm">
                  {(['match', 'create', 'skip'] as const).map(action => (
                    <label key={action} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`${rowId}-action`}
                        checked={draft.action === action}
                        disabled={action === 'match' && coderStatus !== 'ready'}
                        onChange={() => update(candidate.name, { action })}
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
                  <div className="space-y-1">
                    <Label htmlFor={`${rowId}-target`}>Which coder</Label>
                    <Select
                      value={draft.targetUserId != null ? String(draft.targetUserId) : undefined}
                      onValueChange={(v) => update(candidate.name, { targetUserId: Number(v) })}
                    >
                      {/* The note below says the coder already HOLDS codings (so a
                          machine's configuration is frozen) — the one fact this
                          choice turns on, so it is the trigger's description, as
                          the provenance fields' hints are (2026-09-23 sweep). */}
                      <SelectTrigger
                        id={`${rowId}-target`}
                        className="w-full max-w-sm"
                        aria-describedby={candidate.local_user_id != null ? `${rowId}-target-hint` : undefined}
                      >
                        <SelectValue placeholder="Choose a coder" />
                      </SelectTrigger>
                      <SelectContent>
                        {coders.map(c => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.username}{c.archived ? ' (archived)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {candidate.local_user_id != null && (
                      <p id={`${rowId}-target-hint`} className="text-xs text-mm-text-muted">
                        A coder called “{candidate.name}” already exists here with{' '}
                        {candidate.local_application_count} codings.
                        {candidate.local_machine_provenance && (
                          <> It is a machine coder running{' '}
                            {candidate.local_machine_provenance.model}.</>
                        )}
                      </p>
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
                          onChange={(e) => update(candidate.name, { newUsername: e.target.value })}
                        />
                      </div>
                      {/* A real group: "Kind" was a bare <span>, so the two radios
                          announced as "A person" / "A machine" with nothing saying
                          what was being chosen. */}
                      <fieldset className="space-y-1">
                        <legend className="text-sm font-medium text-mm-text">Kind</legend>
                        <div className="flex gap-3 text-sm pt-1.5">
                          <label className="flex items-center gap-1.5">
                            <input
                              type="radio"
                              name={`${rowId}-kind`}
                              checked={draft.coderType === 'human'}
                              onChange={() => update(candidate.name, { coderType: 'human' })}
                            />
                            <UserIcon className="w-3.5 h-3.5" aria-hidden="true" /> A person
                          </label>
                          <label className="flex items-center gap-1.5">
                            <input
                              type="radio"
                              name={`${rowId}-kind`}
                              checked={draft.coderType === 'ai'}
                              onChange={() => update(candidate.name, { coderType: 'ai' })}
                            />
                            <Bot className="w-3.5 h-3.5" aria-hidden="true" /> A machine
                          </label>
                        </div>
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
                          onChange={(patch) => update(candidate.name, patch)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </fieldset>
            )
          })}
        </CardContent>
      </Card>

      {preview.problems.length > 0 && (
        <ProblemsCard problems={preview.problems} counts={preview.reason_counts} />
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack} disabled={busy}>Back</Button>
        <Button onClick={onImport} disabled={busy || preview.will_apply === 0}>
          {busy && <LoaderCircle className="w-4 h-4 animate-spin" />}
          Import {preview.will_apply} {preview.will_apply === 1 ? 'coding' : 'codings'}
        </Button>
      </div>
    </div>
  )
}

function ProblemsCard({
  problems, counts, done = false,
}: {
  problems: { line: number; reason: string; detail: string }[]
  counts: Record<string, number>
  /** After the import the sentence is past tense — "will not be" on the result
      screen read as a warning about an act still to come (2026-09-23 sweep). */
  done?: boolean
}) {
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const one = problems.length === 1
  const verb = !done ? 'will not be imported' : one ? 'was not imported' : 'were not imported'
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {problems.length} {one ? 'row' : 'rows'} {verb}
        </CardTitle>
        <CardDescription>
          {summary.map(([reason, n]) => `${n} × ${reason.replace(/_/g, ' ')}`).join(' · ')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollableTable maxHeight="16rem">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Rows that {done ? 'were not' : 'will not be'} imported, with the reason for each
            </caption>
            <thead>
              <tr className="text-left text-xs text-mm-text-muted">
                <th scope="col" className="py-1 pr-3 font-medium">Line</th>
                <th scope="col" className="py-1 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p, i) => (
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
  result, onOpenAnalysis, onFinish,
}: {
  result: CodingImportResult
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
            {result.skipped > 0 && <Stat label="Rows skipped" value={result.skipped} />}
          </dl>
        </CardContent>
      </Card>
      {result.problems.length > 0 && (
        <ProblemsCard problems={result.problems} counts={{}} done />
      )}
      {/* MergeProject's finish: where the imported coding can be SEEN — codes,
          and on the Reliability tab the model comparison for a machine coder —
          then a plain exit. Qualitative Analysis reads transcript, document,
          clip AND text-column codings, so it is right for both import kinds. */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onOpenAnalysis}>Open Qualitative Analysis</Button>
        <Button variant="outline" onClick={onFinish}>Done</Button>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-mm-text-muted">{label}</dt>
      <dd className="text-lg tabular-nums text-mm-text">{value.toLocaleString()}</dd>
    </div>
  )
}
