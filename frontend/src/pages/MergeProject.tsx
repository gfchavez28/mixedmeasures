import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  GitMerge, Check, ChevronRight, Users, TriangleAlert, Sparkles, Info,
  CircleAlert, LoaderCircle, ArrowLeft, FileInput, Link2, ArrowRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { projectPortabilityApi, codesApi, ApiError } from '@/lib/api'
import type {
  ImportValidationResult, MergeCoderPreview, MergeCodePreview, MergeReport,
  MergeDivergenceDetail, CoderMappingDecision, CodeMappingDecision, Code,
} from '@/lib/api'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { useCoders } from '@/hooks/useCoders'
import { coderColor, coderInitials } from '@/lib/coder-color'
import { getContrastColor, cn } from '@/lib/utils'
import { consumePendingMerge } from '@/lib/pending-merge'
import {
  defaultDecisions, decisionToValue, parseDecisionValue, buildCoderMapping, resultingCoderCount,
} from '@/lib/merge-coder-mapping'
import {
  defaultCodeDecisions, applyBulkCode, buildCodeMapping, codeDecisionSummary,
  bestCandidate, combinedLabel, buildMergePlan, MERGE_LINK_BAR,
  type LocalCodeLite, type MergeReviewRow,
} from '@/lib/merge-code-mapping'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '@/components/ui/select'

type Step = 'loading' | 'upload' | 'confirm' | 'reconcile' | 'review' | 'merging' | 'report' | 'diverged'

const codings = (n: number) => `${n.toLocaleString()} coding${n === 1 ? '' : 's'}`

// A dual-encoded coder chip (color + initials), mirroring CoderFilterPopover.
function CoderChip({ name, colorSeed }: { name: string; colorSeed: number }) {
  const bg = coderColor({ id: colorSeed, display_color: null })
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold leading-none px-1 text-[8px] flex-shrink-0"
      style={{ backgroundColor: bg, color: getContrastColor(bg), minWidth: '16px', height: '16px' }}
      aria-hidden="true"
    >
      {coderInitials(name)}
    </span>
  )
}

// A small code-color dot. `ring` cuts it out from a tinted background (the result column).
function Dot({ color, ring }: { color: string | null; ring?: boolean }) {
  return (
    <span
      className={cn('inline-block w-2.5 h-2.5 rounded-full flex-none', ring && 'ring-2 ring-white dark:ring-mm-surface')}
      style={{ backgroundColor: color ?? '#9ca3af' }}
      aria-hidden="true"
    />
  )
}

export default function MergeProject() {
  const { projectId } = useParams<{ projectId: string }>()
  const targetId = parseInt(projectId || '0')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { project } = useProjectLayout()
  const { coders } = useCoders()

  const [step, setStep] = useState<Step>('loading')
  const [file, setFile] = useState<File | null>(null)
  const [mergeCoders, setMergeCoders] = useState<MergeCoderPreview[]>([])
  const [decisions, setDecisions] = useState<Record<number, CoderMappingDecision>>({})
  const [renames, setRenames] = useState<Record<number, string>>({})
  const [codesPreview, setCodesPreview] = useState<MergeCodePreview[]>([])
  const [codeDecisions, setCodeDecisions] = useState<Record<string, CodeMappingDecision>>({})
  const [report, setReport] = useState<MergeReport | null>(null)
  const [divergence, setDivergence] = useState<MergeDivergenceDetail | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const resolvedRef = useRef(false)

  // The local codebook (active, non-universal) — drives the reconcile target picker + the
  // review provenance matrix. Same query key the rest of the app uses.
  const { data: codesData, isLoading: codesLoading } = useQuery({
    queryKey: ['codes', targetId],
    queryFn: () => codesApi.list(targetId),
    enabled: !!targetId,
  })
  const localCodes: LocalCodeLite[] = useMemo(
    () => (codesData?.codes ?? [])
      .filter((c: Code) => !c.is_universal && c.is_active)
      .map((c: Code) => ({ id: c.id, name: c.name, color: c.color })),
    [codesData],
  )

  const hasCodesToReconcile = codesPreview.length > 0

  // Seed both coder + code decisions from a freshly-arrived preview (smart defaults).
  const seedFromValidation = useCallback((v: ImportValidationResult, f: File) => {
    const cs = v.merge_coders ?? []
    const codes = v.merge_codes_preview ?? []
    setFile(f)
    setMergeCoders(cs)
    setDecisions(defaultDecisions(cs))
    setCodesPreview(codes)
    setCodeDecisions(defaultCodeDecisions(codes))
    setStep('confirm')
  }, [])

  // Consume the Dashboard handoff once and seed the flow from it. The run-once ref guard is
  // load-bearing: StrictMode double-invokes this effect, and the FIRST run already consumed
  // the one-shot handoff — without the guard the second run sees null and the `else` would
  // clobber a freshly-seeded 'confirm' back to 'upload'.
  useEffect(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    const pending = consumePendingMerge(targetId)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot handoff seed
    if (pending) seedFromValidation(pending.validation, pending.file)
    else setStep('upload')
  }, [targetId, seedFromValidation])

  // Upload fallback: validate a freshly-dropped file and require it to match THIS project.
  const handleUpload = useCallback(async (f: File) => {
    setUploadError(null)
    try {
      const v = await projectPortabilityApi.validateImport(f)
      if (v.existing_project?.id !== targetId) {
        setUploadError(
          v.existing_project
            ? `This file matches "${v.existing_project.name}", not this project. Open that project to merge.`
            : 'This file is a different project (no shared identity). Merge needs your own copy of the same project.',
        )
        return
      }
      seedFromValidation(v, f)
    } catch {
      setUploadError('That file could not be read as an .mmproject.')
    }
  }, [targetId, seedFromValidation])

  const setDecision = useCallback((originalId: number, value: string) => {
    setDecisions(prev => ({ ...prev, [originalId]: parseDecisionValue(value) }))
  }, [])
  const setCodeDecision = useCallback((uuid: string, d: CodeMappingDecision) => {
    setCodeDecisions(prev => ({ ...prev, [uuid]: d }))
  }, [])
  const localNameById = useMemo(
    () => Object.fromEntries(localCodes.map(c => [c.id, c.name])),
    [localCodes],
  )
  const onBulkCode = useCallback((action: 'new' | 'collapse' | 'link') => {
    setCodeDecisions(prev => applyBulkCode(action, codesPreview, prev, localNameById))
  }, [codesPreview, localNameById])

  const newCoderCount = useMemo(
    () => Object.values(decisions).filter(d => d.action === 'create').length,
    [decisions],
  )

  // Confirm coders → reconcile codes (if any are divergent) → review.
  const afterConfirm = useCallback(() => setStep(hasCodesToReconcile ? 'reconcile' : 'review'), [hasCodesToReconcile])

  const runMerge = useCallback(async () => {
    if (!file) return
    setStep('merging')
    try {
      const result = await projectPortabilityApi.importProject(file, {
        mode: 'merge',
        targetProjectId: targetId,
        coderMapping: buildCoderMapping(mergeCoders, decisions, renames),
        codeMapping: buildCodeMapping(codesPreview, codeDecisions),
      })
      // The merge changed codings, the roster, the codebook, and every analysis surface
      // for this project — invalidate the roster + anything keyed on this project id.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['coders'] })
      queryClient.invalidateQueries({
        predicate: q => Array.isArray(q.queryKey) && q.queryKey.includes(targetId),
      })
      setReport(result.merge_report)
      setStep('report')
      toast.success(`Merge complete — ${codings(result.merge_report?.applications_added ?? 0)} added.`)
    } catch (err) {
      const detail = err instanceof ApiError && err.status === 409
        ? (err.response.data as { detail?: MergeDivergenceDetail })?.detail
        : null
      if (detail) {
        // Segmentation divergence is only knowable at merge time → terminal refusal.
        setDivergence(detail)
        setStep('diverged')
      } else {
        toast.error('Merge failed. Your project was not changed.')
        setStep('review')
      }
    }
  }, [file, targetId, mergeCoders, decisions, renames, codesPreview, codeDecisions, queryClient])

  const title = project?.name ?? 'this project'
  const incomingLabel = mergeCoders.length === 1 ? mergeCoders[0].username : 'Incoming file'

  // Dynamic stepper: drop "Reconcile codes" when the codebook is shared-frozen.
  const showChoose = step === 'upload' || step === 'loading'
  const steps = [
    ...(showChoose ? ['Choose file'] : []),
    'Confirm coders',
    ...(hasCodesToReconcile ? ['Reconcile codes'] : []),
    'Review', 'Done',
  ]
  const labelForStep: Record<Step, string> = {
    loading: 'Choose file', upload: 'Choose file', confirm: 'Confirm coders',
    reconcile: 'Reconcile codes', review: 'Review', merging: 'Review',
    report: 'Done', diverged: 'Review',
  }
  const stepIndex = Math.max(0, steps.indexOf(labelForStep[step]))

  const reviewPlan = useMemo(
    () => buildMergePlan(localCodes, codesPreview, codeDecisions),
    [localCodes, codesPreview, codeDecisions],
  )

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center gap-2 mb-1 text-mm-text">
          <GitMerge className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-semibold">Merge coding into {title}</h1>
        </div>
        <p className="text-sm text-mm-text-muted mb-6">
          Add a colleague's codings to your copy of this project. Shared sources are matched
          by identity; only their codings and annotations are brought in.
        </p>

        {/* Progress steps */}
        <nav aria-label="Merge progress" className="flex items-center flex-wrap gap-y-2 mb-8">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center" aria-current={stepIndex === i ? 'step' : undefined}>
              <div className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-sm font-medium',
                stepIndex === i ? 'bg-primary text-white'
                  : stepIndex > i ? 'bg-primary/15 text-primary'
                  : 'bg-mm-border-subtle text-mm-text-secondary',
              )}>
                {stepIndex > i ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              <span className="ml-2 text-sm font-medium">{s}</span>
              {i < steps.length - 1 && <ChevronRight className="w-4 h-4 mx-3 text-mm-text-faint" />}
            </div>
          ))}
        </nav>

        {(step === 'loading' || ((step === 'reconcile' || step === 'review') && codesLoading)) && (
          <div className="flex items-center justify-center py-16 text-mm-text-muted">
            <LoaderCircle className="w-5 h-5 animate-spin" />
          </div>
        )}

        {step === 'upload' && (
          <Card>
            <CardContent className="py-8 text-center space-y-4">
              <FileInput className="w-10 h-10 mx-auto text-mm-text-faint" />
              <p className="text-sm text-mm-text-muted max-w-md mx-auto">
                Choose the colleague's <code>.mmproject</code> file. It must be a copy of
                <strong> {title}</strong> — merge lines codings up by shared identity.
              </p>
              {uploadError && (
                <div className="flex items-start gap-2 max-w-md mx-auto p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm text-left">
                  <CircleAlert className="w-4 h-4 flex-none mt-0.5" /><span>{uploadError}</span>
                </div>
              )}
              <input
                ref={uploadRef} type="file" accept=".mmproject" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }}
              />
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" onClick={() => navigate(`/projects/${targetId}/overview`)}>Cancel</Button>
                <Button onClick={() => uploadRef.current?.click()}>Choose file…</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 'confirm' && (
          <ConfirmStep
            title={title}
            mergeCoders={mergeCoders}
            coders={coders}
            decisions={decisions}
            renames={renames}
            newCoderCount={newCoderCount}
            continueLabel={hasCodesToReconcile ? 'Continue to codes' : 'Continue to review'}
            onDecision={setDecision}
            onRename={(id, v) => setRenames(prev => ({ ...prev, [id]: v }))}
            onToggleUnarchive={(id, on) => setDecisions(prev => {
              const d = prev[id]
              if (!d || d.action !== 'match') return prev
              return { ...prev, [id]: { ...d, unarchive: on } }
            })}
            onCancel={() => navigate(`/projects/${targetId}/overview`)}
            onContinue={afterConfirm}
          />
        )}

        {step === 'reconcile' && !codesLoading && (
          <ReconcileStep
            previews={codesPreview}
            localCodes={localCodes}
            decisions={codeDecisions}
            onSetDecision={setCodeDecision}
            onBulk={onBulkCode}
            onBack={() => setStep('confirm')}
            onContinue={() => setStep('review')}
          />
        )}

        {step === 'review' && !codesLoading && (
          <ReviewStep
            plan={reviewPlan}
            incomingLabel={incomingLabel}
            newCoderCount={newCoderCount}
            onBack={() => setStep(hasCodesToReconcile ? 'reconcile' : 'confirm')}
            onMerge={runMerge}
          />
        )}

        {step === 'merging' && (
          <div className="flex items-center justify-center gap-2 py-16 text-mm-text-muted">
            <LoaderCircle className="w-5 h-5 animate-spin" /> Merging…
          </div>
        )}

        {step === 'report' && report && (
          <ReportStep report={report} targetId={targetId} navigate={navigate} />
        )}

        {step === 'diverged' && divergence && (
          <DivergedStep divergence={divergence} onBack={() => navigate(`/projects/${targetId}/overview`)} />
        )}
      </div>
    </div>
  )
}

// ── Confirm-coders step ──────────────────────────────────────────────────

interface ConfirmStepProps {
  title: string
  mergeCoders: MergeCoderPreview[]
  coders: { id: number; username: string; display_color?: string | null }[]
  decisions: Record<number, CoderMappingDecision>
  renames: Record<number, string>
  newCoderCount: number
  continueLabel: string
  onDecision: (originalId: number, value: string) => void
  onRename: (originalId: number, value: string) => void
  onToggleUnarchive: (originalId: number, on: boolean) => void
  onCancel: () => void
  onContinue: () => void
}

function ConfirmStep(p: ConfirmStepProps) {
  if (p.mergeCoders.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center space-y-4">
          <p className="text-sm text-mm-text-muted">
            This file has no coder-attributed work to bring in. Codings will be added under
            their existing attribution.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" onClick={p.onCancel}>Cancel</Button>
            <Button onClick={p.onContinue}>{p.continueLabel}</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Distinct coders the merged-in work will span (#444): a new coder, or ≥2 file coders
  // mapped onto distinct existing coders, both preserve consensus/IRR. The prior check
  // looked only at new coders, so the "N file coders → N distinct existing" default was
  // wrongly flagged single-coder.
  const resultingCoders = resultingCoderCount(p.mergeCoders, p.decisions)

  return (
    <div className="space-y-4">
      <p className="text-sm text-mm-text">
        Match each coder in the file to a coder in {p.title}, or add them as a new coder.
        We've suggested matches by name — review before continuing.
      </p>

      <ScrollableTable maxHeight="60vh" className="rounded-md border border-mm-surface-border bg-mm-surface">
        <table className="w-full text-sm border-collapse">
          <caption className="sr-only">Map each coder in the file to a local coder or add as new</caption>
          <thead>
            <tr className="border-b text-left text-mm-text-muted">
              <th scope="col" className="px-3 py-2 font-medium">Coder in file</th>
              <th scope="col" className="px-3 py-2 font-medium">Bring in as</th>
            </tr>
          </thead>
          <tbody>
            {p.mergeCoders.map(c => {
              const d = p.decisions[c.original_id]
              const isCreate = d?.action === 'create'
              const matchedArchived =
                d?.action === 'match' && c.local_match?.id === d.target_user_id && c.local_match.archived
              const options = c.local_match && !p.coders.some(lc => lc.id === c.local_match!.id)
                ? [{ id: c.local_match.id, username: c.local_match.username, archived: c.local_match.archived }, ...p.coders]
                : p.coders
              return (
                <tr key={c.original_id} className="border-b last:border-b-0 align-top">
                  <th scope="row" className="px-3 py-3 font-normal text-left">
                    <div className="flex items-center gap-2">
                      <CoderChip name={c.username} colorSeed={c.original_id} />
                      <span className="font-medium text-mm-text">{c.username}</span>
                    </div>
                    <div className="mt-1 ml-7 text-xs text-mm-text-muted">{codings(c.file_app_count)}</div>
                    {c.local_match && (
                      <div className="mt-1 ml-7 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400" title={`A coder named "${c.local_match.username}" already exists here (${codings(c.local_match.local_app_count)}).`}>
                        <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />
                        Same name already here
                      </div>
                    )}
                  </th>
                  <td className="px-3 py-3">
                    <Select value={d ? decisionToValue(d) : ''} onValueChange={v => p.onDecision(c.original_id, v)}>
                      <SelectTrigger className="w-full max-w-xs">
                        <SelectValue placeholder="Choose…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="create">Add as new coder</SelectItem>
                        {options.map(lc => (
                          <SelectItem key={lc.id} value={`match:${lc.id}`}>
                            Map to {lc.username}{'archived' in lc && lc.archived ? ' (archived)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {isCreate && (
                      <div className="mt-2 space-y-1">
                        <div className="inline-flex items-center gap-1 text-xs text-mm-text-muted">
                          <Sparkles className="w-3 h-3" aria-hidden="true" /> Joins this project as a new coder
                        </div>
                        <Input
                          aria-label={`New coder name for ${c.username}`}
                          className="h-8 max-w-xs"
                          defaultValue={c.username}
                          onChange={e => p.onRename(c.original_id, e.target.value)}
                        />
                      </div>
                    )}

                    {matchedArchived && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-mm-text-muted cursor-pointer">
                        <Checkbox
                          checked={d?.action === 'match' ? !!d.unarchive : false}
                          onCheckedChange={on => p.onToggleUnarchive(c.original_id, on === true)}
                          aria-label={`Un-archive ${c.local_match?.username} on merge`}
                        />
                        Un-archive this coder (they're archived here)
                      </label>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollableTable>

      <div className="inline-flex items-center gap-1.5 text-xs text-mm-text-muted" title="Consensus + agreement (IRR) need at least two coders. Mapping every coder onto an existing one keeps this project single-coder.">
        <Info className="w-3.5 h-3.5 flex-none" aria-hidden="true" />
        {p.newCoderCount > 0
          ? `${p.newCoderCount} new coder${p.newCoderCount === 1 ? '' : 's'} — enables consensus + agreement (IRR).`
          : resultingCoders >= 2
            ? `Maps onto ${resultingCoders} existing coders — consensus + agreement (IRR) stay available.`
            : 'Mapping every coder onto one existing coder keeps this project single-coder (no agreement stats).'}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="outline" onClick={p.onCancel}>Cancel</Button>
        <Button onClick={p.onContinue}>{p.continueLabel} <ArrowRight className="w-4 h-4 ml-1.5" /></Button>
      </div>
    </div>
  )
}

// ── Reconcile-codes step (J3-2b) ─────────────────────────────────────────────

interface ReconcileStepProps {
  previews: MergeCodePreview[]
  localCodes: LocalCodeLite[]
  decisions: Record<string, CodeMappingDecision>
  onSetDecision: (uuid: string, d: CodeMappingDecision) => void
  onBulk: (action: 'new' | 'collapse' | 'link') => void
  onBack: () => void
  onContinue: () => void
}

function ReconcileStep(p: ReconcileStepProps) {
  const summary = codeDecisionSummary(p.decisions)
  const confidentCount = p.previews.filter(pr => bestCandidate(pr)?.confident).length

  // Resolve the target a collapse/link should default to when its action is chosen.
  const resolveTarget = (pr: MergeCodePreview, current?: CodeMappingDecision): number | undefined => {
    if (current && current.action !== 'new') return current.target_code_id
    return bestCandidate(pr)?.code_id ?? p.localCodes[0]?.id
  }
  const localName = (id: number) => p.localCodes.find(c => c.id === id)?.name ?? ''

  const setAction = (pr: MergeCodePreview, action: 'new' | 'collapse' | 'link') => {
    if (action === 'new') return p.onSetDecision(pr.uuid, { action: 'new' })
    const target = resolveTarget(pr, p.decisions[pr.uuid])
    if (target == null) return
    p.onSetDecision(pr.uuid, action === 'collapse'
      ? { action: 'collapse', target_code_id: target }
      : { action: 'link', target_code_id: target, combined_label: combinedLabel(localName(target), pr.name) })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-mm-text">
        {p.previews.length} code{p.previews.length === 1 ? '' : 's'} in the file {p.previews.length === 1 ? "isn't" : "aren't"} in
        your codebook. For each, add it as new, collapse it into one of yours, or link it
        (keep both, grouped). Default is <strong>Add as new</strong>.
      </p>

      {/* Bulk toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2 rounded-md border border-mm-surface-border bg-mm-surface-hover px-3 py-2">
        <span className="text-xs text-mm-text-muted">
          <strong className="text-mm-text">{p.previews.length}</strong> to decide
          {confidentCount > 0 && <> · <strong className="text-mm-text">{confidentCount}</strong> close name match{confidentCount === 1 ? '' : 'es'}</>}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => p.onBulk('new')}>Add all as new</Button>
          <Button variant="outline" size="sm" onClick={() => p.onBulk('collapse')}>Collapse exact matches</Button>
          <Button variant="outline" size="sm" onClick={() => p.onBulk('link')}>Link close matches</Button>
        </div>
      </div>

      <ScrollableTable maxHeight="56vh" className="rounded-md border border-mm-surface-border bg-mm-surface">
        <table className="w-full text-sm border-collapse">
          <caption className="sr-only">Reconcile each divergent code: add as new, collapse, or link</caption>
          <thead>
            <tr className="border-b text-left text-mm-text-muted">
              <th scope="col" className="px-3 py-2 font-medium w-1/2">Code from the file</th>
              <th scope="col" className="px-3 py-2 font-medium">What should happen to it</th>
            </tr>
          </thead>
          <tbody>
            {p.previews.map(pr => {
              const d = p.decisions[pr.uuid]
              const action = d?.action ?? 'new'
              const best = bestCandidate(pr)
              const pct = best ? Math.round(best.similarity * 100) : 0
              const target = d && d.action !== 'new' ? d.target_code_id : undefined
              // candidates first (ranked), then the rest of the codebook.
              const candIds = new Set(pr.candidates.map(c => c.code_id))
              const others = p.localCodes.filter(c => !candIds.has(c.id))
              return (
                <tr key={pr.uuid} className="border-b last:border-b-0 align-top">
                  {/* Code from file */}
                  <th scope="row" className="px-3 py-3 font-normal text-left">
                    <div className="flex items-start gap-2">
                      <Dot color={pr.color} />
                      <div>
                        <span className="font-medium text-mm-text">{pr.name}</span>
                        {pr.description && <div className="text-xs text-mm-text-muted mt-0.5 max-w-[42ch]">{pr.description}</div>}
                        <div className="text-xs text-mm-text-faint mt-1 font-mono">{codings(pr.file_app_count)}</div>
                        {best && best.confident ? (
                          <div className="mt-1.5 inline-flex items-start gap-1 text-xs text-primary">
                            <Sparkles className="w-3.5 h-3.5 flex-none mt-px" aria-hidden="true" />
                            <span>
                              {pct >= 99
                                ? <><strong>Exact name match</strong> — your “{best.name}”.</>
                                : <><strong>Close name match</strong> — your “{best.name}” ({pct}% of characters).</>}
                              {' '}Consider Collapse or Link.
                            </span>
                          </div>
                        ) : (
                          <div className="mt-1.5 text-xs text-mm-text-faint">No close name match — staying “new”.</div>
                        )}
                      </div>
                    </div>
                  </th>

                  {/* Decision: action toggle + target */}
                  <td className="px-3 py-3">
                    <div className="inline-flex rounded-md border border-mm-surface-border overflow-hidden" role="group" aria-label={`Action for ${pr.name}`}>
                      {(['new', 'collapse', 'link'] as const).map(a => (
                        <button
                          key={a}
                          type="button"
                          aria-pressed={action === a}
                          onClick={() => setAction(pr, a)}
                          className={cn(
                            'px-3 py-1.5 text-xs font-medium border-r border-mm-surface-border last:border-r-0',
                            action === a ? 'bg-primary text-white' : 'text-mm-text hover:bg-mm-surface-hover',
                          )}
                        >
                          {a === 'new' ? 'Add as new' : a === 'collapse' ? 'Collapse' : 'Link'}
                        </button>
                      ))}
                    </div>

                    {action !== 'new' && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-mm-text-muted">
                        <span>{action === 'collapse' ? 'into:' : 'with:'}</span>
                        <Select
                          value={target != null ? String(target) : ''}
                          onValueChange={v => {
                            const tid = parseInt(v)
                            p.onSetDecision(pr.uuid, action === 'collapse'
                              ? { action: 'collapse', target_code_id: tid }
                              : { action: 'link', target_code_id: tid, combined_label: combinedLabel(localName(tid), pr.name) })
                          }}
                        >
                          <SelectTrigger className="h-8 w-56"><SelectValue placeholder="Choose a code…" /></SelectTrigger>
                          <SelectContent>
                            {pr.candidates.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>Closest by name</SelectLabel>
                                {pr.candidates.map(c => (
                                  <SelectItem key={c.code_id} value={String(c.code_id)}>
                                    {c.name} · name {Math.round(c.similarity * 100)}%
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )}
                            {others.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>All your codes</SelectLabel>
                                {others.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                              </SelectGroup>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {action === 'link' && d?.action === 'link' && (
                      <div className="mt-2 space-y-1">
                        <label className="text-xs text-mm-text-muted" htmlFor={`label-${pr.uuid}`}>Group name (stats run on the group)</label>
                        <Input
                          id={`label-${pr.uuid}`}
                          className="h-8 w-72"
                          value={d.combined_label ?? ''}
                          onChange={e => p.onSetDecision(pr.uuid, { ...d, combined_label: e.target.value })}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollableTable>

      <p className="text-xs text-mm-text-muted">
        Match % compares the code <strong>names only</strong> (character similarity) — not how
        or where each code was applied. It's a hint for finding the same concept, never a claim
        that the coding agrees. Bulk Collapse acts on near-exact names (≥95%, since it removes a
        code); bulk Link on close names (≥{Math.round(MERGE_LINK_BAR * 100)}%).
      </p>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="outline" onClick={p.onBack}><ArrowLeft className="w-4 h-4 mr-1.5" /> Back</Button>
        <span className="text-xs text-mm-text-muted">
          {summary.newCount} new · {summary.collapsed} collapsed · {summary.linked} linked
        </span>
        <Button onClick={p.onContinue}>Continue to review <ArrowRight className="w-4 h-4 ml-1.5" /></Button>
      </div>
    </div>
  )
}

// ── Review step (J3-2b provenance matrix) ────────────────────────────────────

function MergeReviewCell({ side }: { side: MergeReviewRow['local'] | MergeReviewRow['incoming'] }) {
  if (!side) return <span className="text-mm-text-faint">—</span>
  const status = 'status' in side ? side.status : undefined
  return (
    <span className="inline-flex items-center gap-2">
      <Dot color={side.color} />
      <span className={cn(status === 'removed' && 'line-through text-mm-text-muted decoration-amber-600')}>{side.name}</span>
      {status === 'new' && <span className="text-[11px] font-semibold text-primary">✚ new</span>}
      {status === 'removed' && <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">folded in</span>}
    </span>
  )
}

function ReviewStep({ plan, incomingLabel, newCoderCount, onBack, onMerge }: {
  plan: MergeReviewRow[]
  incomingLabel: string
  newCoderCount: number
  onBack: () => void
  onMerge: () => void
}) {
  const changed = plan.filter(r => r.kind !== 'unchanged').length
  return (
    <div className="space-y-4">
      <p className="text-sm text-mm-text">
        Here's how your codebook will look after merging — read each row left to right.
        {changed > 0 ? ` ${changed} code${changed === 1 ? '' : 's'} change; ` : ' No codes change; '}
        {newCoderCount > 0
          ? `${newCoderCount} new coder${newCoderCount === 1 ? '' : 's'} turn on agreement stats.`
          : 'no new coders.'}
      </p>

      {/* How to read */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mm-text-muted">
        <span className="inline-flex items-center gap-1"><Link2 className="w-3.5 h-3.5 text-mm-blue" /> linked — kept both, grouped (stats run on the group)</span>
        <span className="inline-flex items-center gap-1"><span className="text-primary font-semibold">✚ new</span> added</span>
        <span className="inline-flex items-center gap-1"><span className="line-through decoration-amber-600">folded in</span> = removed, merged into another code</span>
      </div>

      <ScrollableTable maxHeight="56vh" className="rounded-md border border-mm-surface-border bg-mm-surface">
        <table className="w-full text-sm border-collapse">
          <caption className="sr-only">How each source code resolves into the merged codebook</caption>
          <thead>
            <tr className="border-b text-left text-mm-text-muted bg-mm-surface-hover">
              <th scope="col" className="px-3 py-2 font-medium w-[29%]">Your codebook</th>
              <th scope="col" className="px-3 py-2 font-medium w-[29%]">{incomingLabel}</th>
              <th scope="col" className="px-3 py-2 font-semibold text-primary border-l-2 border-primary bg-emerald-100/60 dark:bg-emerald-900/25">
                → Merged codebook
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.map((r, i) => (
              <tr key={i} className="border-b last:border-b-0 align-middle">
                <td className="px-3 py-2.5"><MergeReviewCell side={r.local} /></td>
                <td className="px-3 py-2.5"><MergeReviewCell side={r.incoming} /></td>
                <td className="px-3 py-2.5 border-l-2 border-primary bg-emerald-50/70 dark:bg-emerald-900/15">
                  {r.kind === 'link-group' ? (
                    <div>
                      <span className="inline-flex items-center gap-2 font-medium text-mm-blue-text">
                        <Dot color={r.finalColor} ring /> <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> {r.finalName}
                      </span>
                      <div className="text-[11px] text-mm-text-muted mt-0.5 ml-6">linked group · agreement runs here</div>
                    </div>
                  ) : r.kind === 'new' ? (
                    <div>
                      <span className="inline-flex items-center gap-2 font-medium text-primary"><Dot color={r.finalColor} ring /> {r.finalName}</span>
                      <div className="text-[11px] text-mm-text-muted mt-0.5 ml-[18px]">new code</div>
                    </div>
                  ) : r.kind === 'collapse-target' ? (
                    <div>
                      <span className="inline-flex items-center gap-2 font-medium text-mm-text"><Dot color={r.finalColor} ring /> {r.finalName}</span>
                      <div className="text-[11px] text-mm-text-muted mt-0.5 ml-[18px]">absorbed a duplicate</div>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-2 font-medium text-mm-text"><Dot color={r.finalColor} ring /> {r.finalName}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>

      <p className="text-xs text-mm-text-faint">A safety backup of your project is saved before merging.</p>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="outline" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-1.5" /> Back</Button>
        <Button onClick={onMerge}><GitMerge className="w-4 h-4 mr-1.5" /> Merge into my project</Button>
      </div>
    </div>
  )
}

// ── Report step ────────────────────────────────────────────────────────────

function ReportStep({ report, targetId, navigate }: {
  report: MergeReport; targetId: number; navigate: (to: string) => void
}) {
  const rows: [string, number][] = [
    ['Codings added', report.applications_added],
    ['Duplicate codings skipped', report.duplicates_skipped],
    ['Shared sources matched', report.sources_matched],
    ['Coders matched', report.coders_matched],
    ['New coders added', report.coders_created],
    ['Codes added', report.codes_created],
    ['Codes linked', report.codes_linked],
    ['Codes folded in', report.codes_collapsed],
  ]
  return (
    <Card>
      <CardContent className="py-6 space-y-4">
        <div className="flex items-center gap-2 text-mm-text">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
            <Check className="w-4 h-4" />
          </span>
          <h2 className="text-lg font-medium">Merge complete</h2>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-md">
          {rows.map(([label, n]) => (
            <div key={label} className="contents">
              <dt className="text-mm-text-muted">{label}</dt>
              <dd className="text-right font-medium text-mm-text tabular-nums">{n.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-mm-text-faint">A safety backup of your project was saved before merging.</p>
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={() => navigate(`/projects/${targetId}/analysis/qualitative`)}>
            <Users className="w-4 h-4 mr-1.5" /> Review coders &amp; agreement
          </Button>
          <Button variant="outline" onClick={() => navigate(`/projects/${targetId}/overview`)}>Done</Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Divergence-refusal step (segmentation; codebook is handled by reconcile) ──

function DivergedStep({ divergence, onBack }: { divergence: MergeDivergenceDetail; onBack: () => void }) {
  return (
    <Card>
      <CardContent className="py-6 space-y-4">
        <div className="flex items-center gap-2 text-mm-text">
          <TriangleAlert className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          <h2 className="text-lg font-medium">
            {divergence.kind === 'segmentation' ? "Can't merge yet — segmentation differs" : "Can't merge yet — codebooks differ"}
          </h2>
        </div>

        {divergence.kind === 'segmentation' ? (
          <>
            <p className="text-sm text-mm-text-muted">
              Merging needs the same segments on both sides so codings line up. These sources were split differently:
            </p>
            <ScrollableTable maxHeight="40vh" className="rounded-md border border-mm-surface-border bg-mm-surface">
              <table className="w-full text-sm border-collapse">
                <caption className="sr-only">Sources whose segmentation diverged</caption>
                <thead>
                  <tr className="border-b text-left text-mm-text-muted">
                    <th scope="col" className="px-3 py-2 font-medium">Source</th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">This project</th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">In the file</th>
                  </tr>
                </thead>
                <tbody>
                  {(divergence.diverged_sources ?? []).map((s, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <th scope="row" className="px-3 py-2 font-normal text-left">{s.name}</th>
                      <td className="px-3 py-2 text-right tabular-nums">{s.local_segments}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.file_segments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollableTable>
            <p className="text-sm text-mm-text-muted">
              Re-segment to match (or divide the work without re-splitting), then export the file again.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-mm-text-muted">
              The file has codes that aren't in your codebook and weren't reconciled. Go back and
              decide each one (add as new, collapse, or link), then merge again.
            </p>
            <ul className="text-sm text-mm-text list-disc pl-5 space-y-0.5">
              {(divergence.diverged_codes ?? []).map((name, i) => <li key={i}>{name}</li>)}
            </ul>
          </>
        )}

        <div className="flex items-center pt-1">
          <Button variant="outline" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-1.5" /> Back to project</Button>
        </div>
      </CardContent>
    </Card>
  )
}
