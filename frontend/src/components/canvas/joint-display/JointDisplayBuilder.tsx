/**
 * The joint display's builder (D162–D172; mockup `4-builder.html`) — groups, sources,
 * constructs, and how it reads. Opened by `/joint` in a theme (insert) and by *Edit* on a
 * display (the same dialog over the stored display).
 *
 * ⚠️ The BODY mounts only while open (`list-load-state.md` §8): it owns the four list queries,
 * so a closed builder holds no observer, and its draft starts from `initial` each time.
 *
 * What the builder decides and what it leaves to the server:
 * - the groups are ONE categorical column, named by id (D166) — eligibility is the server's
 *   `grouping_column` gate, mirrored by `CATEGORICAL_GROUPING_TYPES`; whether a dataset's rows
 *   are people the display says once it computes (its group sizes and *without a group*);
 * - #1638: its variables are `lib/analysis-column-lists.ts::datasetsWithDemographics` — the
 *   payload lists a DEMOGRAPHIC column only under `demographics`, so `datasets[].columns` alone
 *   offered none (the commonest grouping a participant table carries) in all three pickers;
 * - a construct's survey variables come from ONE dataset (D205: the builder's rule — two
 *   datasets are two strands, slice 2);
 * - nothing here suggests a fit (D169.1) — the fit is written on the display, per row;
 * - #1615 D279: while blind the variable list is the VIEWER's (`useAnalysisScope`), which marks
 *   the rating scores (`withheld_while_blind`). A single-choice menu (the groups, *Also show*)
 *   keeps a marked option, disabled with `WITHHELD_OPTION_NOTE` — a choice made before going
 *   blind keeps its name; the survey variables' list hides them and says how many under its
 *   dataset (the Data view's sentence). The server is the guard: it refuses a score as the
 *   groups and leaves it out of a survey row and a quote's attribution.
 */
import { useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2, Search } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LoadState } from '@/components/LoadStatus'
import { useListLoad } from '@/hooks/useListLoad'
import { useAnalysisScope } from '@/hooks/useAnalysisScope'
import { codesApi, conversationsApi, documentsApi, materialsApi, metricsApi, observationsApi, textCodingApi } from '@/lib/api'
import type { AnalysisColumnItem } from '@/lib/api/metrics'
import { datasetsWithDemographics } from '@/lib/analysis-column-lists'
import { isWithheld, WITHHELD_OPTION_NOTE } from '@/lib/analysis-scope'
import { withheldRatingColumnsNotice } from '@/lib/blind-rating-columns'
import { CATEGORICAL_GROUPING_TYPES, VALUE_NUMERIC_TYPES } from '@/lib/dataset-constants'
import type { ListLoad } from '@/lib/list-status'
import {
  bindingOf, emptyDisplay, emptyRow, fitsNamingStrand, readDisplay, IMPLICIT_CODES_KEY, IMPLICIT_VARIABLES_KEY, strandOfKind, withBinding, withStrand,
  changeStrandDataset, constructsBindingStrandVariables,
  type JointDisplay, type JointDisplayRow, type JointDisplayStrand, type StrandKind,
} from '@/lib/joint-display'
import {
  emptyStrand, isImplicitPair, makeStrandsExplicit, moveStrand, removeStrand, rowBinding, strandPlacement, strandTag,
  strandsProblem,
} from '@/lib/joint-display-strands'
import { describeResult, isDisplayResult } from '@/lib/joint-display-results'
import { atOrBefore, landAfterPress, lastIn } from './focus-landing'
import {
  ATTRIBUTION_MODES, BINDING_LIMIT_TEXT, CONSTRUCT_LIMIT_TEXT, FIT_VOCABULARIES, IMPLICATION_CITATION, MAX_CONSTRUCTS,
  MAX_IDS_PER_BINDING, MAX_STRANDS_IN_BUILDER,
  OBSERVATIONS_FAILED_TITLE, QUESTIONS_FAILED_TITLE, STRAND_KIND_TERMS,
  STRAND_LIMIT_TEXT, STRAND_QUESTIONS_LIMIT_TEXT, STRAND_REMOVE_CONFIRM_TEXT, STRAND_REMOVE_KEEP_TEXT, TEXT_STRAND_QUESTIONS_LABEL, strandRemovalWarningText,
  STRAND_DATASET_CHANGE_TEXT, strandDatasetChangeWarningText, strandDatasetKeepText,
  ATTRIBUTION_OPTION_UNOFFERED_TEXT, attributionOptionIneligibleText,
  type AttributionMode,
} from '@/lib/joint-display-vocabulary'

interface BuilderProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  /** The display to edit; `null` builds a new one. */
  initial: JointDisplay | null
  /** Insert (new) or save (edit) — the caller writes the node. */
  onSubmit: (display: JointDisplay) => void
  mode: 'insert' | 'edit'
}

export default function JointDisplayBuilder({ open, onOpenChange, projectId, initial, onSubmit, mode }: BuilderProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-mm-border-subtle">
          <DialogTitle>{mode === 'insert' ? 'New joint display' : 'Edit joint display'}</DialogTitle>
          <DialogDescription>
            Each construct is one idea measured more than one way, compared across groups. The
            numbers stay live as coding and data change.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <BuilderBody
            projectId={projectId}
            initial={initial}
            mode={mode}
            onCancel={() => onOpenChange(false)}
            onSubmit={d => { onSubmit(d); onOpenChange(false) }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

const SURVEY_TYPES = new Set([...VALUE_NUMERIC_TYPES, ...CATEGORICAL_GROUPING_TYPES])
const GROUPING_TYPES = new Set(CATEGORICAL_GROUPING_TYPES)

function columnLabel(c: AnalysisColumnItem): string {
  return c.column_name || c.column_text || `Column ${c.id}`
}

/** #1615 D279 — a single-choice menu's option: a rating score stays, disabled, with the reason. */
function ColumnOption({ c, withType }: { c: AnalysisColumnItem; withType: boolean }) {
  const withheld = isWithheld(c)
  return (
    <option value={c.id} disabled={withheld}>
      {columnLabel(c)}{withType ? ` (${c.column_type})` : ''}{withheld ? ` — ${WITHHELD_OPTION_NOTE}` : ''}
    </option>
  )
}

type SourceChoice = 'all' | 'none' | 'chosen'

function sourceChoice(ids: (number | null)[] | null): SourceChoice {
  if (ids == null) return 'all'
  return ids.length === 0 ? 'none' : 'chosen'
}

function BuilderBody({
  projectId, initial, mode, onCancel, onSubmit,
}: {
  projectId: number
  initial: JointDisplay | null
  mode: 'insert' | 'edit'
  onCancel: () => void
  onSubmit: (d: JointDisplay) => void
}) {
  const [draft, setDraft] = useState<JointDisplay>(() => (initial ? readDisplay(initial) : emptyDisplay()))
  // Joint display slice 2: until the first strand edit (r2-1) a display is slice 1's implicit pair
  // and the builder shows slice 1's controls over these two keys; once explicit, `StrandsEditor`
  // adds, names, orders and removes strands and each construct binds through `RowStrandPickers`.
  const codesStrand = strandOfKind(draft, 'codes')
  const codesKey = codesStrand?.key ?? IMPLICIT_CODES_KEY
  const varsKey = strandOfKind(draft, 'variables')?.key ?? IMPLICIT_VARIABLES_KEY

  // Same keys and staleTime as the other readers, so an open analysis page makes these cache reads.
  // #1615 D279: the viewer's scope rides the key (the variable picker's), and the read waits for
  // the blind state to settle — while withholding with no self id it never asks (D96).
  const { coderScope, scopeKey, scopeReady } = useAnalysisScope(projectId)
  const columnsQuery = useQuery({
    queryKey: ['analysis-columns', projectId, scopeKey],
    queryFn: () => metricsApi.analysisColumns(projectId, coderScope),
    enabled: scopeReady,
    staleTime: 60_000,
  })
  const codesQuery = useQuery({ queryKey: ['codes', projectId], queryFn: () => codesApi.list(projectId) })
  const convsQuery = useQuery({ queryKey: ['conversations', projectId], queryFn: () => conversationsApi.list(projectId) })
  const docsQuery = useQuery({ queryKey: ['documents', projectId], queryFn: () => documentsApi.list(projectId) })
  // D165 — the saved results a construct can stand beside it (the chart embeds' and drawer's key).
  const materialsQuery = useQuery({ queryKey: ['materials-all', projectId], queryFn: () => materialsApi.listAllMaterials(projectId) })
  const load = useListLoad(columnsQuery, codesQuery, convsQuery, docsQuery, materialsQuery)
  // Joint display slice 2: the observations an observation strand reads — asked only once the
  // display has named strands, and NOT in the builder's load gate (a slice-1 display never needs it).
  // Sticky once the researcher edits a strand here: removing back to two unnamed strands must
  // not swap the strands editor for slice 1's controls mid-edit (the combine: r1's model always
  // holds strands, so "explicit" is a predicate, not r2's "has any strands").
  const [strandsEdited, setStrandsEdited] = useState(false)
  // #1644 review, r3-3: what the disabled *Add construct* is described by (above the early return).
  const constructLimitId = useId()
  const explicit = strandsEdited || !isImplicitPair(draft)
  const obsQuery = useQuery({
    queryKey: ['observations', projectId], queryFn: () => observationsApi.list(projectId), enabled: explicit,
  })
  // Joint display slice 2 (r6-9, #961's class): a FAILED read must not offer "Every one (0)" —
  // the list's state comes from the query (`listStatus`), with the house notice and its Retry.
  // Its gate is only the strands editor's (rendered only while `explicit`, the query's `enabled`).
  const obsLoad = useListLoad(obsQuery)
  // A survey comments strand's QUESTIONS (D305) are the project's open-text columns —
  // `analysis-columns` lists none (it serves the variable pickers), so the prototype's picker,
  // tested against a mock that did, offered "Nothing matches." on every real project (found by the
  // build's drive). Text Coding's own read, under its key; the same load state as the observations.
  const questionsQuery = useQuery({
    queryKey: ['text-columns', projectId], queryFn: () => textCodingApi.columns(projectId), enabled: explicit,
  })
  const questionsLoad = useListLoad(questionsQuery)
  const questions = useMemo(() => (questionsQuery.data?.columns ?? []).map(c => ({
    id: c.column_id, name: `${c.dataset_name} › ${c.column_name || c.column_text || `Column ${c.column_id}`}`,
  })), [questionsQuery.data])

  const datasets = useMemo(() => datasetsWithDemographics(columnsQuery.data), [columnsQuery.data])
  const allColumns = useMemo(() => datasets.flatMap(d => d.columns), [datasets])
  const codes = useMemo(
    () => (codesQuery.data?.codes ?? []).filter(c => c.is_active && !c.is_universal),
    [codesQuery.data],
  )
  const conversations = convsQuery.data?.conversations ?? []
  const documents = docsQuery.data ?? []
  // Offered with the unit each one counts, derived from its own settings (D165), never typed.
  const resultOptions = useMemo(() => {
    const columns = columnsQuery.data
    if (!columns) return []
    return (materialsQuery.data ?? []).filter(isDisplayResult).map(m => {
      const r = describeResult(m, columns)
      return { id: r.materialId, name: `${r.name} (${r.unit})` }
    })
  }, [materialsQuery.data, columnsQuery.data])

  if (load.status !== 'ready') {
    return (
      <div className="px-5 py-6">
        <LoadState load={load} loadingLabel="Loading variables, codes and sources…"
          failedTitle="The builder's lists could not be loaded" size="panel" />
      </div>
    )
  }

  const set = (patch: Partial<JointDisplay>) => setDraft(d => ({ ...d, ...patch }))
  const setRow = (key: string, patch: Partial<JointDisplayRow>) =>
    setDraft(d => ({ ...d, rows: d.rows.map(r => (r.key === key ? { ...r, ...patch } : r)) }))

  const groupingColumn = allColumns.find(c => c.id === draft.group_by_column_id) ?? null
  // #1653 (D346): the *Also show* variable the display holds but the list cannot offer — gone, or
  // retyped so it cannot form groups — shown as held; null when the held one is an offered option
  // (or none is held). Below the load gate, so an unanswered list is never read as "cannot be
  // shown". ⚠️ Not found in the list is NOT "gone": `analysis-columns` lists no open-text column.
  const heldAttribution = draft.attribution.column_id
  const heldAttributionColumn = heldAttribution == null ? undefined : allColumns.find(c => c.id === heldAttribution)
  const attributionHeldLabel = heldAttribution == null ? null
    : heldAttributionColumn == null ? ATTRIBUTION_OPTION_UNOFFERED_TEXT
      : GROUPING_TYPES.has(heldAttributionColumn.column_type) ? null
        : attributionOptionIneligibleText(columnLabel(heldAttributionColumn))
  const namedRows = draft.rows.filter(r => r.construct.trim())
  const problem = strandsProblem(draft)
  const canSubmit = draft.group_by_column_id != null && namedRows.length > 0 && problem == null
  const datasetOf = (id: number) => allColumns.find(c => c.id === id)?.dataset_id ?? null
  const setStrand = (key: string, patch: Partial<JointDisplayStrand>) =>
    setDraft(d => ({ ...d, strands: d.strands.map(s => (s.key === key ? { ...s, ...patch } : s)) }))
  /** r2-1: the first strand edit makes a slice-1 display's implicit pair explicit, keys kept. */
  const addStrand = (kind: StrandKind) => {
    setStrandsEdited(true)
    setDraft(d => { const x = makeStrandsExplicit(d, datasetOf); return { ...x, strands: [...x.strands, emptyStrand(kind)] } })
  }
  const setBinding = (rowKey: string, strandKey: string, patch: Partial<{ code_ids: (number | null)[]; column_ids: (number | null)[]; marked_formed: boolean }>) =>
    setDraft(d => ({ ...d, rows: d.rows.map(r => r.key !== rowKey ? r : {
      ...r, bindings: { ...r.bindings, [strandKey]: { ...rowBinding(d, r, d.strands.find(s => s.key === strandKey)!), ...patch } },
    }) }))
  const observations = (obsQuery.data ?? []).map(o => ({ id: o.id, name: o.name }))

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5 text-sm">
        <Section n={1} title="Title">
          <Input
            aria-label="Display title"
            placeholder="e.g. Teachers by gain group: what they reported, what they said"
            value={draft.title}
            onChange={e => set({ title: e.target.value })}
          />
        </Section>

        <Section n={2} title="Compare groups by">
          <select
            aria-label="Variable that forms the groups"
            className="w-full h-9 rounded-md border border-mm-border-medium bg-mm-surface px-2 text-sm text-mm-text"
            value={draft.group_by_column_id ?? ''}
            onChange={e => set({ group_by_column_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Choose a variable…</option>
            {datasets.map(ds => {
              const eligible = ds.columns.filter(c => GROUPING_TYPES.has(c.column_type))
              if (eligible.length === 0) return null
              return (
                <optgroup key={ds.id} label={ds.name}>
                  {eligible.map(c => <ColumnOption key={c.id} c={c} withType />)}
                </optgroup>
              )
            })}
          </select>
          <p className="mt-1 text-xs text-mm-text-muted">
            Any ordinal, nominal, binary or demographic variable of a dataset linked to
            participants. A continuous variable can be banded into groups with a recode first.
          </p>
          {groupingColumn && draft.group_by_column_id != null && (
            <p className="mt-1 text-xs text-mm-text-muted">
              Groups are the values of {columnLabel(groupingColumn)} in {groupingColumn.dataset_name}.
              The display says how many participants each holds once it computes.
            </p>
          )}
        </Section>

        {explicit ? (
          <Section n={3} title="Strands">
            <StrandsEditor draft={draft} datasets={datasets} conversations={conversations.map(c => ({ id: c.id, name: c.name }))}
              documents={documents.map(d => ({ id: d.id, name: d.name }))} observations={observations}
              observationsLoad={obsLoad} questions={questions} questionsLoad={questionsLoad} setStrand={setStrand}
              onChangeDataset={(key, datasetId) => setDraft(d => changeStrandDataset(d, key, datasetId))}
              onRemove={key => setDraft(d => removeStrand(d, key))}
              onMove={(key, by) => setDraft(d => moveStrand(d, key, by))} onAdd={addStrand} />
          </Section>
        ) : (
        <Section n={3} title="Sources for the codes">
          <SourcePicker
            kindLabel="Conversations"
            options={conversations.map(c => ({ id: c.id, name: c.name }))}
            value={codesStrand?.conversation_ids ?? null}
            onChange={v => set(withStrand(draft, codesKey, { conversation_ids: v }))}
          />
          <SourcePicker
            kindLabel="Documents"
            options={documents.map(d => ({ id: d.id, name: d.name }))}
            value={codesStrand?.document_ids ?? null}
            onChange={v => set(withStrand(draft, codesKey, { document_ids: v }))}
          />
          <p className="text-xs text-mm-text-muted">
            Codes count participants: speakers and documents linked to a participant. Interviewer
            turns are left out by speaker role.
          </p>
          <AddStrandButtons count={2} onAdd={addStrand} lead="Name the strands, or add another:" />
        </Section>
        )}

        <Section n={4} title="Constructs (rows)">
          <ul className="space-y-2">
            {draft.rows.map((row, i) => (
              <li key={row.key} className="rounded-md border border-mm-border-medium bg-mm-surface p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Construct ${i + 1} name`}
                    placeholder="Construct name, e.g. Training dosage"
                    data-construct-name
                    value={row.construct}
                    onChange={e => setRow(row.key, { construct: e.target.value })}
                  />
                  <Button
                    type="button" variant="ghost" size="icon"
                    aria-label={`Remove construct ${row.construct.trim() || i + 1}`}
                    disabled={draft.rows.length === 1}
                    onClick={e => {
                      // #1660 (D345): the row goes with its button — land on the construct now in
                      // its place, else the one before (the strand Remove's rule).
                      const land = landAfterPress(e.currentTarget,
                        scope => atOrBefore(scope, 'input[data-construct-name]', i))
                      set({ rows: draft.rows.filter(r => r.key !== row.key) })
                      land()
                    }}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden />
                  </Button>
                </div>
                {explicit ? (
                  <RowStrandPickers draft={draft} row={row} rowName={row.construct.trim() || `construct ${i + 1}`}
                    codes={codes.map(c => ({ id: c.id, name: c.name }))} datasets={datasets}
                    onChange={(strandKey, patch) => setBinding(row.key, strandKey, patch)} />
                ) : (
                <div className="flex flex-wrap gap-2">
                  <IdMultiPicker
                    label="Codes"
                    rowName={row.construct.trim() || `construct ${i + 1}`}
                    options={codes.map(c => ({ id: c.id, name: c.name }))}
                    value={bindingOf(row, codesKey).code_ids} max={MAX_IDS_PER_BINDING}
                    onChange={v => setRow(row.key, withBinding(row, codesKey, { code_ids: v }))}
                  />
                  <SurveyPicker
                    rowName={row.construct.trim() || `construct ${i + 1}`}
                    datasets={datasets}
                    value={bindingOf(row, varsKey).column_ids}
                    onChange={v => setRow(row.key, withBinding(row, varsKey, { column_ids: v }))}
                  />
                  {(resultOptions.length > 0 || row.result_material_ids.length > 0) && (
                    <IdMultiPicker
                      label="Results at another unit"
                      rowName={row.construct.trim() || `construct ${i + 1}`}
                      options={resultOptions}
                      value={row.result_material_ids}
                      onChange={v => setRow(row.key, { result_material_ids: v })}
                    />
                  )}
                </div>
                )}
                {explicit && (resultOptions.length > 0 || row.result_material_ids.length > 0) && (
                  <IdMultiPicker
                    label="Results at another unit"
                    rowName={row.construct.trim() || `construct ${i + 1}`}
                    options={resultOptions}
                    value={row.result_material_ids}
                    onChange={v => setRow(row.key, { result_material_ids: v })}
                  />
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mm-text-secondary">
                  {!explicit && (<>
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={bindingOf(row, varsKey).marked_formed}
                      onChange={e => setRow(row.key, withBinding(row, varsKey, { marked_formed: e.target.checked }))} />
                    The survey strand formed the groups
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={bindingOf(row, codesKey).marked_formed}
                      onChange={e => setRow(row.key, withBinding(row, codesKey, { marked_formed: e.target.checked }))} />
                    The coded strand formed the groups
                  </label>
                  </>)}
                  {row.result_material_ids.length > 0 && (
                    <label className="inline-flex items-center gap-1.5">
                      <input type="checkbox" checked={row.results_marked_formed}
                        onChange={e => setRow(row.key, { results_marked_formed: e.target.checked })} />
                      The result at another unit formed the groups
                    </label>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {/* #1644 review, r3-3: the server computes up to MAX_DISPLAY_ROWS constructs — a 101st
              made the whole display fail to compute (D317's class), so the builder stops and says why. */}
          <Button type="button" variant="outline" size="sm" className="mt-2"
            disabled={draft.rows.length >= MAX_CONSTRUCTS}
            aria-describedby={draft.rows.length >= MAX_CONSTRUCTS ? constructLimitId : undefined}
            onClick={e => {
              const land = focusLandingAfterAdd(e.currentTarget, 'input[data-construct-name]')
              set({ rows: [...draft.rows, emptyRow()] })
              land()
            }}>
            <Plus className="w-4 h-4 mr-1" aria-hidden />Add construct
          </Button>
          {draft.rows.length >= MAX_CONSTRUCTS && (
            <p id={constructLimitId} className="mt-1 text-xs text-mm-text-muted">{CONSTRUCT_LIMIT_TEXT}</p>
          )}
          <p className="mt-1 text-xs text-mm-text-muted">
            The app marks a strand that is the grouping variable, or computed from it, by itself.
            Tick a box only for a link it cannot see (e.g. teachers grouped by their school’s
            student results).
          </p>
          <p className="mt-1 text-xs text-mm-text-muted">
            A result at another unit is a saved comparison, cross-tabulation or summary whose rows are
            not these participants (e.g. students by school). It stands beside its construct, drawn
            once across the groups and never split by group.
          </p>
        </Section>

        <Section n={5} title="How it reads">
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-mm-text-secondary mb-1">Fit vocabulary</legend>
            {FIT_VOCABULARIES.map(v => (
              <label key={v.key} className="flex items-start gap-2">
                <input type="radio" name="fit-vocabulary" className="mt-1"
                  checked={draft.settings.fit_vocabulary === v.key}
                  onChange={() => set({ settings: { ...draft.settings, fit_vocabulary: v.key } })} />
                <span>
                  <span className="text-mm-text">{v.label}</span>
                  <span className="block text-xs text-mm-text-muted">{v.citation}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={draft.settings.implication}
              onChange={e => set({ settings: { ...draft.settings, implication: e.target.checked } })} />
            <span>
              <span className="text-mm-text">Implication column (for evaluations)</span>
              <span className="block text-xs text-mm-text-muted">{IMPLICATION_CITATION}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={draft.settings.newcombe}
              onChange={e => set({ settings: { ...draft.settings, newcombe: e.target.checked } })} />
            <span>
              <span className="text-mm-text">Show intervals on coded differences</span>
              <span className="block text-xs text-mm-text-muted">
                Off by default: coded passages come from a chosen sample, not one built for
                estimation. When on, the interval is unadjusted, over the participants in these groups.
              </span>
            </span>
          </label>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-mm-text-secondary mb-1">Quotes are attributed by</legend>
            {ATTRIBUTION_MODES.map(m => (
              <label key={m.key} className="flex items-center gap-2">
                <input type="radio" name="attribution"
                  checked={draft.attribution.label === m.key}
                  onChange={() => set({ attribution: { ...draft.attribution, label: m.key as AttributionMode } })} />
                {m.label}
              </label>
            ))}
            <label className="flex items-center gap-2 mt-1">
              <span className="text-xs text-mm-text-secondary">Also show</span>
              <select
                aria-label="Also show a participant variable beside each quote"
                className="h-8 rounded-md border border-mm-border-medium bg-mm-surface px-2 text-xs text-mm-text"
                value={draft.attribution.column_id ?? ''}
                onChange={e => set({ attribution: { ...draft.attribution, column_id: e.target.value ? Number(e.target.value) : null } })}
              >
                <option value="">Nothing more</option>
                {/* #1653 (D346): a held variable the list cannot offer (gone, or retyped) is shown
                    as held — the select read "Nothing more" over an id the display still held. */}
                {attributionHeldLabel != null && (
                  <option value={draft.attribution.column_id ?? ''} disabled>{attributionHeldLabel}</option>
                )}
                {datasets.map(ds => {
                  const eligible = ds.columns.filter(c => GROUPING_TYPES.has(c.column_type))
                  if (eligible.length === 0) return null
                  return (
                    <optgroup key={ds.id} label={ds.name}>
                      {eligible.map(c => <ColumnOption key={c.id} c={c} withType={false} />)}
                    </optgroup>
                  )
                })}
              </select>
            </label>
            {draft.attribution.column_id != null && (
              <p className="text-xs text-mm-orange-text">
                With few people per category, an identifier beside a category such as a school can
                identify someone.
              </p>
            )}
          </fieldset>
        </Section>
      </div>
      <DialogFooter className="px-5 py-3 border-t border-mm-border-subtle">
        {!canSubmit && (
          <p className="mr-auto text-xs text-mm-text-muted">
            {problem ?? 'Choose the variable that forms the groups and name at least one construct.'}
          </p>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit({ ...draft, rows: namedRows })}
        >
          {mode === 'insert' ? 'Insert joint display' : 'Save changes'}
        </Button>
      </DialogFooter>
    </>
  )
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`jd-builder-${n}`} className="space-y-2">
      <h3 id={`jd-builder-${n}`} className="text-xs font-semibold uppercase tracking-wide text-mm-text-muted">
        {n} · {title}
      </h3>
      {children}
    </section>
  )
}

interface Option { id: number; name: string }

function SourcePicker({
  kindLabel, options, value, onChange,
}: {
  kindLabel: string
  options: Option[]
  value: (number | null)[] | null
  onChange: (v: (number | null)[] | null) => void
}) {
  const choice = sourceChoice(value)
  const name = useId()
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-mm-text-secondary">{kindLabel}</legend>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name={name} checked={choice === 'all'} onChange={() => onChange(null)} />
          Every one ({options.length})
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name={name} checked={choice === 'none'} onChange={() => onChange([])} />
          None
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name={name} checked={choice === 'chosen'} disabled={options.length === 0}
            onChange={() => onChange(options.slice(0, 1).map(o => o.id))} />
          Chosen
        </label>
        {/* #1644 (r3-1): no `max` here, on purpose. The server's bound on a strand's sources
            (`MAX_SOURCES_PER_STRAND`, 10,000) is a SQL ceiling, not a choice: a chosen list costs no
            more than "Every one" (D12), and no list a person ticks reaches it. */}
        {choice === 'chosen' && (
          <IdMultiPicker label={kindLabel} rowName="the display" options={options}
            value={value ?? []} onChange={v => onChange(v)} />
        )}
      </div>
    </fieldset>
  )
}

/** A searchable checkbox list in a popover. Its BODY mounts only while open (§8). */
function IdMultiPicker({
  label, rowName, options, value, onChange, max, limitText = BINDING_LIMIT_TEXT,
}: {
  label: string
  rowName: string
  options: Option[]
  value: (number | null)[]
  onChange: (v: (number | null)[]) => void
  /** Q6 (round-2 combine): a construct's binding from one strand — the server's cap, said, not a 422. */
  max?: number
  /** What the list says at `max` — a construct's binding by default; a strand's questions say their own. */
  limitText?: string
}) {
  const [open, setOpen] = useState(false)
  const chosen = value.filter((x): x is number => x != null)
  const missing = value.length - chosen.length
  const names = chosen.map(id => options.find(o => o.id === id)?.name).filter(Boolean)
  // Names only when every chosen id is offered — a survey variable hidden while blind (#1615
  // D279) is still chosen, and two names under "3 chosen" would misstate the choice.
  const named = names.length === chosen.length && names.length <= 2
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`${label} for ${rowName}: ${chosen.length} chosen`}>
          {label}: {chosen.length === 0 ? 'none' : named ? names.join(', ') : `${chosen.length} chosen`}
          {missing > 0 && <span className="ml-1 text-mm-orange-text">· {missing} missing</span>}
        </Button>
      </PopoverTrigger>
      {/* z-[201]: above the builder's own dialog layer (z-[200], `components/ui/dialog.tsx`) —
          at the wrapper's z-50 the list sat UNDER the dialog and a click on a checkbox landed on
          the field beneath it (driven 2026-11-12e: it pressed *Add construct*). Select's z-[201]. */}
      <PopoverContent className="w-72 p-0 z-[201]" align="start" aria-label={`${label} for ${rowName}`}>
        {open && (
          <MultiPickerBody label={label} options={options} chosen={chosen} full={max != null && chosen.length >= max}
            limitText={limitText} onToggle={(id, on) => onChange(on ? [...value, id] : value.filter(x => x !== id))} />
        )}
      </PopoverContent>
    </Popover>
  )
}

function MultiPickerBody({
  label, options, chosen, full = false, limitText = BINDING_LIMIT_TEXT, onToggle,
}: {
  label: string
  options: Option[]
  chosen: number[]
  /** At the cap: nothing more is offered, and the list says why (a chosen one still clears). */
  full?: boolean
  limitText?: string
  onToggle: (id: number, on: boolean) => void
}) {
  const [q, setQ] = useState('')
  // A disabled checkbox is described by the sentence saying why (the round-2 combine's residual:
  // the reason sat above the list, tied to nothing a screen reader reads with the box).
  const limitId = useId()
  const shown = options.filter(o => o.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="flex flex-col max-h-72">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-mm-border-subtle">
        <Search className="w-3.5 h-3.5 text-mm-text-muted" aria-hidden />
        <input
          aria-label={`Filter ${label.toLowerCase()}`}
          className="flex-1 bg-transparent text-sm outline-none"
          placeholder="Filter…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>
      {full && <p id={limitId} className="px-3 py-1.5 text-xs text-mm-text-muted border-b border-mm-border-subtle">{limitText}</p>}
      <ul className="overflow-y-auto py-1" aria-label={label}>
        {shown.length === 0 && <li className="px-3 py-2 text-xs text-mm-text-muted">Nothing matches.</li>}
        {shown.map(o => {
          const blocked = full && !chosen.includes(o.id)
          return (
          <li key={o.id}>
            <label className="flex items-center gap-2 px-3 py-1 text-sm hover:bg-mm-surface-hover">
              <input type="checkbox" checked={chosen.includes(o.id)} disabled={blocked}
                aria-describedby={blocked ? limitId : undefined}
                onChange={e => onToggle(o.id, e.target.checked)} />
              <span className="truncate">{o.name}</span>
            </label>
          </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Survey variables of ONE dataset per construct (D205's builder rule). */
function SurveyPicker({
  rowName, datasets, value, onChange,
}: {
  rowName: string
  datasets: { id: number; name: string; columns: AnalysisColumnItem[] }[]
  value: (number | null)[]
  onChange: (v: (number | null)[]) => void
}) {
  const chosen = value.filter((x): x is number => x != null)
  const owner = datasets.find(ds => ds.columns.some(c => chosen.includes(c.id))) ?? null
  const [datasetId, setDatasetId] = useState<number | null>(owner?.id ?? null)
  const current = datasets.find(ds => ds.id === datasetId) ?? null
  const eligible = (current?.columns ?? []).filter(c => SURVEY_TYPES.has(c.column_type))
  // #1615 D279: a list hides the rating scores and says how many (the Data view's sentence).
  const options = eligible.filter(c => !isWithheld(c)).map(c => ({ id: c.id, name: columnLabel(c) }))
  const withheldNotice = withheldRatingColumnsNotice(eligible.length - options.length)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        aria-label={`Survey dataset for ${rowName}`}
        className="h-8 rounded-md border border-mm-border-medium bg-mm-surface px-2 text-xs text-mm-text"
        value={datasetId ?? ''}
        onChange={e => {
          const next = e.target.value ? Number(e.target.value) : null
          setDatasetId(next)
          // D205: one dataset per survey strand — a new dataset starts the strand over.
          if (next !== owner?.id) onChange([])
        }}
      >
        <option value="">No survey</option>
        {datasets.map(ds => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
      </select>
      {current && (
        <IdMultiPicker label="Survey variables" rowName={rowName} options={options} value={value} onChange={onChange} max={MAX_IDS_PER_BINDING} />
      )}
      {current && withheldNotice && (
        <span className="text-xs text-mm-text-muted" data-testid="builder-withheld-rating-scores">{withheldNotice}</span>
      )}
    </span>
  )
}

/**
 * #1407's class (the internal design notes, "A press that DISABLES its own button"): the
 * press that reaches a cap disables its own button — the 100th *Add construct*, the 4th *Add …
 * strand* — and Chrome blurs it: focus sat on `<body>` (driven 2026-11-15d). And a press that
 * UNMOUNTS its button — slice 1's *Add … strand*, the view giving way to the strands editor —
 * left focus on the dialog, where Radix's focus scope put it (#1660, D345: that counts as lost
 * too). Either way, land on the new item's name field, the control that acts next
 * (`focus-landing.ts::landAfterPress`). Below a cap the button keeps focus and nothing moves.
 */
function focusLandingAfterAdd(pressed: HTMLButtonElement, fieldSelector: string): () => void {
  return landAfterPress(pressed, scope => lastIn(scope, fieldSelector))
}

// ── Joint display slice 2: strands (r2-1) ─────────────────────────────────────────────

/** Four add buttons, one per kind (r2-1); none past `MAX_STRANDS_IN_BUILDER` (r2-4), which says why. */
function AddStrandButtons({ count, onAdd, lead }: { count: number; onAdd: (kind: StrandKind) => void; lead?: string }) {
  const full = count >= MAX_STRANDS_IN_BUILDER
  // #1644 review (r3, follow-up): at the cap each disabled button is DESCRIBED by the sentence
  // saying why (D317's residual, closed for the checkboxes and r3-3's *Add construct*).
  const limitId = useId()
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {lead && <span className="text-xs text-mm-text-secondary">{lead}</span>}
      {STRAND_KIND_TERMS.map(k => (
        <Button key={k.key} type="button" variant="outline" size="sm" disabled={full} title={k.definition}
          onClick={e => { const land = focusLandingAfterAdd(e.currentTarget, 'input[data-strand-name]'); onAdd(k.key); land() }}
          aria-describedby={full ? limitId : undefined}>
          <Plus className="w-3.5 h-3.5 mr-1" aria-hidden />{k.add}
        </Button>
      ))}
      {full && <span id={limitId} className="text-xs text-mm-text-muted">{STRAND_LIMIT_TEXT}</span>}
    </div>
  )
}

function StrandsEditor({
  draft, datasets, conversations, documents, observations, observationsLoad, questions, questionsLoad, setStrand,
  onChangeDataset, onRemove, onMove, onAdd,
}: {
  draft: JointDisplay
  datasets: { id: number; name: string; columns: AnalysisColumnItem[] }[]
  conversations: Option[]
  documents: Option[]
  observations: Option[]
  observationsLoad: ListLoad
  /** A survey comments strand's choices: every open-text question, "Dataset › Question". */
  questions: Option[]
  questionsLoad: ListLoad
  setStrand: (key: string, patch: Partial<JointDisplayStrand>) => void
  /** #1665 (D335): a survey strand's new dataset — the strand starts over in every construct. */
  onChangeDataset: (key: string, datasetId: number | null) => void
  onRemove: (key: string) => void
  onMove: (key: string, by: -1 | 1) => void
  onAdd: (kind: StrandKind) => void
}) {
  const n = draft.strands.length
  // r6-10: removing a strand drops every recorded fit over a pair naming it (r1-8) — ask first,
  // naming how many, when there are any; with none it goes at once, as before.
  const [confirming, setConfirming] = useState<string | null>(null)
  // Not `listRef`: this list is not a scroller, so it is not in #998's `ref={listRef}` census.
  const strandsRef = useRef<HTMLOListElement | null>(null)
  const warnId = useId()
  // #1665 (D335): a dataset change that would clear constructs' variables asks first; the select
  // keeps showing the strand's dataset until the change is confirmed.
  const [datasetConfirm, setDatasetConfirm] = useState<{ key: string; next: number | null } | null>(null)
  const datasetWarnId = useId()
  const focusDatasetSelect = (key: string) => requestAnimationFrame(() =>
    strandsRef.current?.querySelector<HTMLSelectElement>(`[data-strand-dataset="${CSS.escape(key)}"]`)?.focus())
  const remove = (key: string, index: number) => {
    setConfirming(null)
    onRemove(key)
    // The pressed control unmounts with its card: land on the strand now in its place (#955 b).
    requestAnimationFrame(() => {
      const names = strandsRef.current?.querySelectorAll<HTMLInputElement>('input[data-strand-name]')
      names?.[Math.min(index, names.length - 1)]?.focus()
    })
  }
  return (
    <>
      <ol ref={strandsRef} className="space-y-2">
        {draft.strands.map((s, i) => {
          const kind = STRAND_KIND_TERMS.find(k => k.key === s.kind)!
          // #1647 (D339): "Strand 1", and no control repeats the word ("Remove Strand 1").
          const name = s.label.trim() || `Strand ${i + 1}`
          return (
            <li key={s.key} className="rounded-md border border-mm-border-medium bg-mm-surface p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Input aria-label={`Strand ${i + 1} name`} placeholder="Strand name, e.g. Interviews" data-strand-name
                  value={s.label} onChange={e => setStrand(s.key, { label: e.target.value })} />
                <span className="shrink-0 text-xs text-mm-text-muted">{kind.label}</span>
                <Button type="button" variant="ghost" size="icon" aria-label={`Move ${name} up`} disabled={i === 0}
                  onClick={() => onMove(s.key, -1)}><ArrowUp className="w-4 h-4" aria-hidden /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Move ${name} down`} disabled={i === n - 1}
                  onClick={() => onMove(s.key, 1)}><ArrowDown className="w-4 h-4" aria-hidden /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} disabled={n <= 2} data-strand-remove={s.key}
                  onClick={() => (fitsNamingStrand(draft, s.key) > 0 ? setConfirming(s.key) : remove(s.key, i))}>
                  <Trash2 className="w-4 h-4" aria-hidden /></Button>
              </div>
              {confirming === s.key && (
                <div className="rounded-md border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-2">
                  <p id={warnId}>{strandRemovalWarningText(name, fitsNamingStrand(draft, s.key))}</p>
                  <div className="flex flex-wrap gap-2">
                    {/* The safe choice takes focus; Keep hands it back to the Remove button. */}
                    <Button type="button" size="sm" variant="outline" autoFocus aria-describedby={warnId}
                      onClick={() => { setConfirming(null); requestAnimationFrame(() => strandsRef.current?.querySelector<HTMLButtonElement>(`[data-strand-remove="${CSS.escape(s.key)}"]`)?.focus()) }}>
                      {STRAND_REMOVE_KEEP_TEXT}
                    </Button>
                    <Button type="button" size="sm" variant="destructive" aria-describedby={warnId} onClick={() => remove(s.key, i)}>
                      {STRAND_REMOVE_CONFIRM_TEXT}
                    </Button>
                  </div>
                </div>
              )}
              {s.kind === 'codes' && (
                <>
                  <SourcePicker kindLabel={`Conversations for ${name}`} options={conversations}
                    value={s.conversation_ids} onChange={v => setStrand(s.key, { conversation_ids: v })} />
                  <SourcePicker kindLabel={`Documents for ${name}`} options={documents}
                    value={s.document_ids} onChange={v => setStrand(s.key, { document_ids: v })} />
                </>
              )}
              {s.kind === 'variables' && (
                <select aria-label={`Dataset for ${name}`} data-strand-dataset={s.key}
                  className="h-8 rounded-md border border-mm-border-medium bg-mm-surface px-2 text-xs text-mm-text"
                  value={s.dataset_id ?? ''} onChange={e => {
                    const next = e.target.value ? Number(e.target.value) : null
                    if (next === s.dataset_id) return
                    // D205: a new dataset starts the strand over — asked first when constructs chose
                    // its variables (they would be left out, and could not be unticked).
                    if (constructsBindingStrandVariables(draft, s.key) > 0) setDatasetConfirm({ key: s.key, next })
                    else onChangeDataset(s.key, next)
                  }}>
                  <option value="">Choose a dataset…</option>
                  {datasets.map(ds => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                </select>
              )}
              {s.kind === 'variables' && datasetConfirm?.key === s.key && (
                <div className="rounded-md border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-2">
                  <p id={datasetWarnId}>{strandDatasetChangeWarningText(constructsBindingStrandVariables(draft, s.key))}</p>
                  <div className="flex flex-wrap gap-2">
                    {/* The safe choice takes focus; either choice hands it back to the select. */}
                    <Button type="button" size="sm" variant="outline" autoFocus aria-describedby={datasetWarnId}
                      onClick={() => { setDatasetConfirm(null); focusDatasetSelect(s.key) }}>
                      {strandDatasetKeepText(datasets.find(ds => ds.id === s.dataset_id)?.name ?? null)}
                    </Button>
                    <Button type="button" size="sm" variant="destructive" aria-describedby={datasetWarnId}
                      onClick={() => { onChangeDataset(s.key, datasetConfirm.next); setDatasetConfirm(null); focusDatasetSelect(s.key) }}>
                      {STRAND_DATASET_CHANGE_TEXT}
                    </Button>
                  </div>
                </div>
              )}
              {s.kind === 'text_codes' && (questionsLoad.status !== 'ready'
                ? <LoadState load={questionsLoad} loadingLabel="Loading the questions…"
                    failedTitle={QUESTIONS_FAILED_TITLE} size="panel" />
                : <IdMultiPicker label={TEXT_STRAND_QUESTIONS_LABEL} rowName={name} options={questions}
                    value={s.text_column_ids ?? []} onChange={v => setStrand(s.key, { text_column_ids: v })}
                    max={MAX_IDS_PER_BINDING} limitText={STRAND_QUESTIONS_LIMIT_TEXT} />)}
              {s.kind === 'observation_codes' && (observationsLoad.status !== 'ready'
                ? <LoadState load={observationsLoad} loadingLabel="Loading the observations…"
                    failedTitle={OBSERVATIONS_FAILED_TITLE} size="panel" />
                : <SourcePicker kindLabel={`Observations for ${name}`} options={observations}
                    value={s.observation_ids} onChange={v => setStrand(s.key, { observation_ids: v })} />)}
              <p className="text-xs text-mm-text-muted">{kind.definition}</p>
            </li>
          )
        })}
      </ol>
      <AddStrandButtons count={n} onAdd={onAdd} />
    </>
  )
}

/** A construct's bindings, one picker per strand, and the formed mark per per-group strand (D171). */
function RowStrandPickers({ draft, row, rowName, codes, datasets, onChange }: {
  draft: JointDisplay
  row: JointDisplayRow
  rowName: string
  codes: Option[]
  datasets: { id: number; name: string; columns: AnalysisColumnItem[] }[]
  onChange: (strandKey: string, patch: Partial<{ code_ids: (number | null)[]; column_ids: (number | null)[]; marked_formed: boolean }>) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        {draft.strands.map(s => {
          const tag = strandTag(draft, s)
          const b = rowBinding(draft, row, s)
          if (s.kind === 'variables') {
            const ds = datasets.find(d => d.id === s.dataset_id)
            const eligible = (ds?.columns ?? []).filter(c => SURVEY_TYPES.has(c.column_type))
            // #1615 D279: the list hides the rating scores and SAYS how many (the Data view's sentence).
            const options = eligible.filter(c => !isWithheld(c)).map(c => ({ id: c.id, name: columnLabel(c) }))
            const withheld = withheldRatingColumnsNotice(eligible.length - options.length)
            return (
              <span key={s.key} className="inline-flex flex-wrap items-center gap-2">
                <IdMultiPicker label={tag} rowName={rowName} options={options}
                  value={b.column_ids} onChange={v => onChange(s.key, { column_ids: v })} max={MAX_IDS_PER_BINDING} />
                {withheld && <span className="text-xs text-mm-text-muted">{withheld}</span>}
              </span>
            )
          }
          return <IdMultiPicker key={s.key} label={tag} rowName={rowName} options={codes}
            value={b.code_ids} onChange={v => onChange(s.key, { code_ids: v })} max={MAX_IDS_PER_BINDING} />
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-mm-text-secondary">
        {draft.strands.filter(s => strandPlacement(s.kind) === 'per_group').map(s => (
          <label key={s.key} className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={rowBinding(draft, row, s).marked_formed}
              onChange={e => onChange(s.key, { marked_formed: e.target.checked })} />
            {strandTag(draft, s)} formed the groups
          </label>
        ))}
      </div>
    </div>
  )
}
