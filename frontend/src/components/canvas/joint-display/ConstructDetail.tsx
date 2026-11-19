/**
 * An OPEN construct of the Compact view (D176; mockups `3-layout-c-compact.html`,
 * `5-cells.html`): its differences, quotes, fit and strand status, meta-inference and
 * implication. Every edit is one `onChange` — one `updateAttributes` transaction on the node,
 * so the editor's own history undoes it (D162's build note).
 *
 * The rules it keeps:
 * - **The fit is the researcher's** (D169.1): offered with its definitions, never suggested.
 * - **"Not measured" is the app's** (D169.2): a strand the row draws nothing from cannot be
 *   marked covered or silent; it says why, in the server's words (#1659).
 * - **The meta-inference records who and when, and stamps the row's numbers** (D170, D168.5):
 *   saving it stamps the baseline its drift line compares against; *Accept new numbers*
 *   re-stamps without touching the text.
 * - **While blind a colleague's authorship reads "a colleague"** (D170, #964).
 * - **A pin's attribution is derived at render** (D163.4), from the live facts the parent read.
 */
import { useId, useState, type MouseEvent } from 'react'
import { Pin, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { JointDisplayGroup, JointDisplayPinFact, JointDisplayRowResult, JointDisplayStrandResult } from '@/lib/api'
import {
  primaryFit, withPrimaryFit,
  codeDifferenceNote, effectNote, formatCodeDifference, formatEffect, rowDriftState, baselineScopeOf, IMPLICIT_CODES_KEY,
  type JointDisplay, type JointDisplayPin, type JointDisplayRow, type RecordedStrandStatus,
} from '@/lib/joint-display'
import {
  displayStrands, isImplicitPair, nextPair, pairNotApplicable, rowFits, rowStrands, strandTag, strandTagOf, writeFits,
} from '@/lib/joint-display-strands'
import {
  FORMED_BY_TEXT, FORMED_GROUPS_HELP, FORMED_GROUPS_NOTE, IMPLICATION_CITATION,
  META_INFERENCE_CITATION, META_INFERENCE_LEVELS, META_INFERENCE_TYPES,
  ADD_FIT_PAIR_TEXT, FIT_PAIR_HELP, PAIR_NOT_APPLICABLE_TEXT, PIN_ROLES, STRAND_STATUS_RECORDED,
  fitPairText, fitTerm, fitVocabulary, notMeasuredText, quotePoolText, type PinRole,
} from '@/lib/joint-display-vocabulary'
import { NO_VALUE } from '@/lib/stat-format'
import { besideSentence, observationBesideText } from '@/lib/joint-display-report'
import { boundResultIds } from '@/lib/joint-display-results'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { LoadingNotice } from '@/components/LoadStatus'
import { wholeQuoteLabel } from '@/lib/quote-runs'
import { formatWrittenDate, pinAttribution, stampBaseline, todayIso } from './display-helpers'
import { useKeptState } from './display-store'
import { atOrBefore, landAfterPress } from './focus-landing'
import type { DisplayResultsState } from './useDisplayResults'
import { useMisfitReads } from './useMisfitReads'
import type { DisplayCoderScope } from '@/lib/joint-display'
import { ruleSentence } from '@/lib/joint-display-misfit'
import { hasMisfit, misfitStatusText, ruleNamesFrom } from '@/lib/joint-display-cases'
import { loadFailureReason } from '@/lib/list-status'
import {
  CASE_GONE_TEXT, CASE_NAME_LOADING_TEXT, CASE_NAME_UNREAD_TEXT, CASE_OUTSIDE_GROUPS_TEXT, CASE_VIEW_OPEN_TEXT, CASES_NO_VIEWER_TEXT,
  MISFIT_ADDED_LABEL, MISFIT_COUNT_FAILED_TEXT, MISFIT_COUNT_LOADING_TEXT, MISFIT_HEADING, MISFIT_NONE_TEXT,
  MISFIT_REMOVED_LABEL, MISFIT_RULE_LABEL, caseViewOpenLabel,
  DRIFT_ACCEPT_CURRENT_TEXT, DRIFT_OTHER_SCOPE_TEXT, driftClearedText,
} from '@/lib/joint-display-vocabulary'

/** Whether the pins' live facts have answered — an unanswered list is never "this quote is gone". */
export type FactsState = 'ready' | 'loading' | 'failed'

interface ConstructDetailProps {
  id: string
  display: JointDisplay
  row: JointDisplayRow
  result: JointDisplayRowResult | null
  groups: JointDisplayGroup[]
  /** Joint display slice 2 (R6): each strand's display-level facts — an observation strand's
   *  observations and their segmentation, a survey comments strand's surveyed counts. */
  strandFacts?: JointDisplayStrandResult[]
  isEditable: boolean
  self: number | null
  withholding: boolean
  authorName: (id: number) => string | null
  facts: Map<number, JointDisplayPinFact>
  factsState: FactsState
  /** The display's saved results at another unit (D165) — this row's are drawn here. */
  results: DisplayResultsState
  /** Where this row's unsaved writing is kept, so a re-created view keeps it (`display-store.ts`). */
  draftKey: string
  onChange: (patch: Partial<JointDisplayRow>) => void
  /** Null where no dialog can be hosted (read-only, or no host) — then no pin control. */
  onPinRequest: ((group: string) => void) | null
  /** Joint display slice 2, round 2 (r5-1): the count read's context — the compute's own scope. */
  // #1703 (b) (D372): no grouping variable's name — the rule's group clause no longer reads it.
  cases: { projectId: number; scope: DisplayCoderScope | null; settled: boolean; noViewer: boolean }
  /** r5-2: opens the case view (hosted by the page, D213); null where no dialog can be hosted. */
  onCasesRequest: (() => void) | null
}

interface RowDraft { text: string; level: 'global' | 'specific' | null; type: string | null; implication: string }

export default function ConstructDetail({
  id, display, row, result, groups, strandFacts, isEditable, self, withholding, authorName, facts, factsState, results, draftKey,
  onChange, onPinRequest, cases, onCasesRequest,
}: ConstructDetailProps) {
  const vocabulary = fitVocabulary(display.settings.fit_vocabulary)
  const fieldId = useId()
  const meta = row.meta_inference
  const [draft, setDraft] = useKeptState<RowDraft>(draftKey, () => ({
    text: meta?.text ?? '', level: meta?.level ?? null, type: meta?.type ?? null, implication: row.implication,
  }))
  const { text, level, type, implication } = draft
  const setText = (v: string) => setDraft(d => ({ ...d, text: v }))
  const setLevel = (v: 'global' | 'specific' | null) => setDraft(d => ({ ...d, level: v }))
  const setType = (v: string | null) => setDraft(d => ({ ...d, type: v }))
  const setImplication = (v: string) => setDraft(d => ({ ...d, implication: v }))
  // #1672 D353–D354: the stamp is compared only within the viewer's own coder view, and a new
  // stamp records that view — the compute's own scope, never a second derivation.
  const viewerScope = baselineScopeOf(cases.scope)
  const drift = result ? rowDriftState(row.baseline, result, viewerScope, strandTagOf(display)) : { kind: 'none' as const }
  const restamp = result && viewerScope != null ? () => onChange({ baseline: stampBaseline(result, viewerScope) }) : null
  // #1689 (D375): *Accept the new numbers*, *Accept the current numbers* (each unmounts with its
  // note) and *Save meta-inference* (disables itself) take their own button away; the open
  // construct is in the node view, so focus fell to <body>. Each lands on the text box beside them.
  const metaTextId = `${fieldId}-meta-text`
  const landOnMetaText = (pressed: HTMLElement) => landAfterPress(pressed, () => document.getElementById(metaTextId))
  const restampPressed = restamp && ((e: MouseEvent<HTMLElement>) => {
    const land = landOnMetaText(e.currentTarget)
    restamp()
    land()
  })
  // Joint display slice 2: the row's strands in display order, each with its answer.
  const strands = rowStrands(display, result, strandFacts)
  const implicit = isImplicitPair(display)
  const itemName = (name: string, tag: string) => (implicit ? name : `${name} (${tag})`)
  const variableItems = strands.flatMap(rs => rs.result?.kind === 'variables' && !rs.notMeasured
    ? rs.result.variables.map(s => ({ s, tag: rs.tag, key: `${rs.strand.key}-v${s.column_id}` })) : [])
  // r4's open-text strand counts here too, and its pins are survey-answer quotes (r4's door) — so
  // the quote pool below is BOTH kinds' (#1646, D337), each item in its own unit and strand.
  const textItems = strands.flatMap(rs => rs.result?.kind === 'text_codes' && !rs.notMeasured
    ? rs.result.codes.map(s => ({ s, tag: rs.tag, key: `${rs.strand.key}-t${s.code_id}`, strandKey: rs.strand.key })) : [])
  const codeItems = strands.flatMap(rs => rs.result?.kind === 'codes' && !rs.notMeasured
    ? rs.result.codes.map(s => ({ s, tag: rs.tag, key: `${rs.strand.key}-c${s.code_id}`, strandKey: rs.strand.key })) : [])
  // #1646 (D337): a pin counts against ITS strand — one with no `strand` is a slice-1 pin, from
  // the implicit codes strand (whose key an explicit display keeps, r2-1).
  const pinStrand = (p: JointDisplayPin) => p.strand ?? IMPLICIT_CODES_KEY
  const pinnable = [
    ...codeItems.map(x => ({ ...x, unit: 'passages' as const })),
    ...textItems.map(x => ({ ...x, unit: 'answers' as const })),
  ]
  const formedItems = [...variableItems, ...codeItems, ...textItems].filter(x => x.s.formed_groups)
  const construct = row.construct || 'this construct'
  const dirty = text !== (meta?.text ?? '') || level !== (meta?.level ?? null) || type !== (meta?.type ?? null)

  const saveMeta = () => {
    // D214: a type rides either level (Younas et al. 2025's two axes); none without a level.
    const savedType = level != null ? type : null
    onChange({
      meta_inference: { text, author_id: self, written_at: todayIso(), level, type: savedType },
      // D168.5: the row's numbers are stamped when its meta-inference is saved (#1672 D353:
      // with the coder view they were read under).
      baseline: result && viewerScope != null ? stampBaseline(result, viewerScope) : row.baseline,
    })
    setDraft(d => ({ ...d, type: savedType }))
  }

  const byline = () => {
    if (!meta || !meta.text) return null
    const date = formatWrittenDate(meta.written_at)
    let who: string
    if (meta.author_id != null && meta.author_id === self) who = 'You'
    else if (withholding) who = 'A colleague'
    else if (meta.author_id == null) who = 'A coder not on this install'
    else who = authorName(meta.author_id) ?? 'A coder not on this install'
    return date ? `${who} · ${date}` : who
  }


  return (
    <div id={id} className="space-y-4 py-2 text-sm">
      {/* Differences (D172): descriptive, an interval on the survey's d; never on a formed strand. */}
      {result && (codeItems.length > 0 || variableItems.length > 0 || textItems.length > 0) && (
        <section aria-labelledby={`${fieldId}-diff`}>
          <h4 id={`${fieldId}-diff`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">
            Differences{groups.length === 2 ? ` · ${groups[0].key} − ${groups[1].key}` : ''}
          </h4>
          <ul className="space-y-0.5">
            {variableItems.map(({ s, tag, key }) => (
              <DifferenceLine key={key} name={itemName(s.name, tag)} value={formatEffect(s)} note={effectNote(s)} />
            ))}
            {[...codeItems, ...textItems].map(({ s, tag, key }) => (
              <DifferenceLine key={key} name={itemName(s.name, tag)} value={formatCodeDifference(s)} note={codeDifferenceNote(s)} />
            ))}
          </ul>
          {formedItems.length > 0 && (
            <div className="mt-2 rounded-md border border-mm-border-subtle bg-mm-surface px-3 py-2 text-xs text-mm-text-secondary">
              {formedItems.map(({ s, tag, key }) => (
                <p key={key}>
                  <span className="font-medium text-mm-text">{itemName(s.name, tag)}</span>{' '}
                  {FORMED_BY_TEXT[s.formed_groups!] ?? 'formed the groups'}. {FORMED_GROUPS_NOTE}
                </p>
              ))}
              <p className="mt-1">{FORMED_GROUPS_HELP}</p>
            </div>
          )}
        </section>
      )}

      {/* Quotes per group (D163) — under the counts, in a supporting role. */}
      <section aria-labelledby={`${fieldId}-quotes`}>
        <h4 id={`${fieldId}-quotes`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">Quotes</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map(g => {
            const pins = row.pins.filter(p => p.group === g.key)
            // Joint display slice 2: the pool is every pinnable strand's, each named with its strand
            // and counted in its unit; a pin is counted against its OWN strand (#1646, D337).
            const poolText = quotePoolText(pinnable.map(({ s, tag, strandKey, unit }) => ({
              name: itemName(s.name, tag), unit,
              n: s.cells.find(c => c.group === g.key)?.passages ?? 0,
              pinned: pins.filter(p => pinStrand(p) === strandKey).length,
            })))
            return (
              <div key={g.key} className="space-y-1.5" data-pin-group>
                <p className="text-xs font-medium text-mm-text-secondary">{g.key}{poolText ? ` · ${poolText}` : ''}</p>
                {pins.length === 0 && <p className="text-xs text-mm-text-muted">No quote pinned.</p>}
                {pins.map((p, i) => (
                  <PinCard
                    key={`${p.excerptId ?? 'gone'}-${i}`}
                    pin={p}
                    attribution={
                      factsState === 'ready'
                        ? pinAttribution(p, p.excerptId != null ? facts.get(p.excerptId) : undefined, display.attribution)
                        : factsState === 'failed' && p.excerptId != null ? 'Its attribution could not be read.' : ''
                    }
                    isEditable={isEditable}
                    onChange={next => onChange({ pins: row.pins.map(x => (x === p ? next : x)) })}
                    onRemove={pressed => {
                      // #1660 (D345): the card goes with its button, and no dialog is around it —
                      // focus fell to <body>. Land on the next pin's Unpin in this group, else the
                      // previous one's, else this group's *Pin a quote*. Read at the press: the
                      // group stays (keyed by its group), the card does not.
                      const groupEl = pressed.closest<HTMLElement>('[data-pin-group]')
                      const land = landAfterPress(pressed, () => groupEl == null ? null
                        : atOrBefore(groupEl, '[data-unpin]', i) ?? groupEl.querySelector<HTMLElement>('[data-pin-request]'))
                      onChange({ pins: row.pins.filter(x => x !== p) })
                      land()
                    }}
                  />
                ))}
                {/* #1646 (D337): any pinnable strand's code — a survey-only display pins an answer. */}
                {isEditable && onPinRequest && pinnable.length > 0 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onPinRequest(g.key)} data-pin-request
                    aria-label={`Pin a quote for ${g.key}, ${construct}`}>
                    <Pin className="w-3.5 h-3.5 mr-1" aria-hidden />Pin a quote
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Joint display slice 2 (r2-6): an observation strand, beside the groups — its sentence. */}
      {strands.some(rs => rs.placement === 'beside') && (
        <section aria-labelledby={`${fieldId}-beside`}>
          <h4 id={`${fieldId}-beside`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">
            Beside the groups
          </h4>
          {strands.filter(rs => rs.placement === 'beside').map(rs => (
            <p key={rs.strand.key} className="text-xs text-mm-text-secondary">
              {observationBesideText(row.construct.trim() || 'Untitled construct', rs.tag, rs)}
            </p>
          ))}
        </section>
      )}

      {/* A saved result at another unit (D165) — beside the construct, never in a group's cell. */}
      {row.result_material_ids.length > 0 && (
        <section aria-labelledby={`${fieldId}-other`}>
          <h4 id={`${fieldId}-other`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">
            At a different unit
          </h4>
          {results.status === 'loading' ? <LoadingNotice label="Loading the saved results…" size="panel" /> : (
            <div className="space-y-2">
              {boundResultIds(row.result_material_ids).map((rid, i) => (
                <ResultBlock key={rid ?? `gone-${i}`} construct={row.construct.trim() || 'Untitled construct'}
                  id={rid} results={results} formed={row.results_marked_formed} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Joint display slice 2, round 2 (r5-1): the row's cases that don't fit (D173) — the rule as
          a sentence, its count, the added and removed cases — and the case view's door. */}
      <MisfitSection construct={construct} display={display} row={row} strands={strands} cases={cases}
        inactiveCodes={result?.inactive_codes} fieldId={fieldId} onCasesRequest={onCasesRequest} />

      {/* Fit — the researcher's: one per NAMED pair of strands (D301, amending D169's one per row). */}
      <section aria-labelledby={`${fieldId}-fit`}>
        <h4 id={`${fieldId}-fit`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">Fit</h4>
        {/* Joint display slice 2 (r2-3, shape (ii)): a fit per NAMED pair — slice 1's one fit on a slice-1 display. */}
        {!implicit ? (
          <PairFits construct={construct} display={display} row={row} result={result} isEditable={isEditable}
            fieldId={fieldId} onChange={onChange} />
        ) : (<>
        {isEditable ? (
          <fieldset>
            <legend className="sr-only">Fit for {construct}</legend>
            <div className="space-y-1">
              {vocabulary.terms.map(t => (
                <label key={t.key} className="flex items-start gap-2">
                  <input type="radio" name={`${fieldId}-fit`} className="mt-1" checked={primaryFit(row) === t.key}
                    onChange={() => onChange(withPrimaryFit(display, row, t.key))} />
                  <span><span className="text-mm-text">{t.label}</span>{' '}
                    <span className="text-xs text-mm-text-muted">{t.definition}</span></span>
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input type="radio" name={`${fieldId}-fit`} checked={primaryFit(row) == null} onChange={() => onChange(withPrimaryFit(display, row, null))} />
                <span className="text-mm-text-muted">Not set</span>
              </label>
            </div>
            <p className="mt-1 text-xs text-mm-text-muted">{vocabulary.citation} The app never suggests a fit.</p>
          </fieldset>
        ) : (
          <p>{vocabulary.terms.find(t => t.key === primaryFit(row))?.label ?? 'Not set'}</p>
        )}
        </>)}
        <div className="mt-2 space-y-1">
          <p className="text-xs font-medium text-mm-text-secondary">Strand status in this construct</p>
          {strands.map(({ strand, tag: label, notMeasured, notMeasuredReason }) => {
            const kind = strand.key
            if (notMeasured) {
              // #1659: this strand's own reason — the shared sentence said "nothing … is bound"
              // for a row whose bound code was deleted or merged away.
              return <p key={kind} className="text-xs"><span className="text-mm-text-secondary">{label}: </span>{notMeasuredText(notMeasuredReason, strand.kind)}.</p>
            }
            const recorded: RecordedStrandStatus = row.status[kind] ?? 'covers'
            return (
              <fieldset key={kind} className="flex flex-wrap items-center gap-x-3 text-xs">
                <legend className="sr-only">{label} strand status for {construct}</legend>
                <span className="text-mm-text-secondary">{label}:</span>
                {isEditable ? STRAND_STATUS_RECORDED.map(t => (
                  <label key={t.key} className="inline-flex items-center gap-1" title={t.definition}>
                    <input type="radio" name={`${fieldId}-status-${kind}`} checked={recorded === t.key}
                      onChange={() => onChange({ status: { ...row.status, [kind]: t.key as RecordedStrandStatus } })} />
                    {t.label}
                  </label>
                )) : <span>{STRAND_STATUS_RECORDED.find(t => t.key === recorded)?.label}</span>}
              </fieldset>
            )
          })}
        </div>
      </section>

      {/* Meta-inference (D170) — typed, signed, stamped. */}
      <section aria-labelledby={`${fieldId}-meta`}>
        <h4 id={`${fieldId}-meta`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">Meta-inference</h4>
        {drift.kind === 'moved' && (
          <div role="status" className="mb-2 rounded-md border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <p className="font-medium">
              Numbers moved{drift.stampedAt ? ` since ${formatWrittenDate(drift.stampedAt)}` : ''}:
            </p>
            <ul className="list-disc pl-4">
              {drift.changes.map(c => (
                <li key={c.key}>{c.label}: {c.was ?? 'not shown'} → {c.now ?? 'not shown'}</li>
              ))}
            </ul>
            {isEditable && restampPressed && (
              <p className="mt-1">
                Check the text still says what the data says.{' '}
                {/* #1714 (a), D396: every per-construct control names its construct, its words first. */}
                <button type="button" className="underline font-medium" onClick={restampPressed}
                  aria-label={`Accept the new numbers for ${construct}`}>
                  Accept the new numbers
                </button>
              </p>
            )}
          </div>
        )}
        {(drift.kind === 'other_scope' || drift.kind === 'cleared') && (
          <div role="status" className="mb-2 rounded-md border border-mm-border-subtle bg-mm-surface-hover px-3 py-2 text-xs text-mm-text-secondary">
            <p>
              {drift.kind === 'cleared' ? driftClearedText(formatWrittenDate(drift.stampedAt)) : DRIFT_OTHER_SCOPE_TEXT}
              {isEditable && restampPressed && (
                <>
                  {' '}
                  <button type="button" className="underline font-medium" onClick={restampPressed}
                    aria-label={`${DRIFT_ACCEPT_CURRENT_TEXT} for ${construct}`}>
                    {DRIFT_ACCEPT_CURRENT_TEXT}
                  </button>
                </>
              )}
            </p>
          </div>
        )}
        {isEditable ? (
          <div className="space-y-2">
            <Textarea
              id={metaTextId}
              aria-label={`Meta-inference for ${construct}`}
              placeholder="What do the strands say together about this construct?"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={3}
            />
            <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <legend className="text-mm-text-secondary mr-1 float-left">
                {/* The space sits OUTSIDE the sr-only span: a name computation may trim a child's
                    own leading space, which ran "Type (optional)— …" together (#1713's shape). */}
                Type (optional) <span className="sr-only">— meta-inference for {construct}</span>
              </legend>
              {META_INFERENCE_LEVELS.map(t => (
                <label key={t.key} className="inline-flex items-center gap-1" title={t.definition}>
                  <input type="radio" name={`${fieldId}-level`} checked={level === t.key}
                    onChange={() => setLevel(t.key as 'global' | 'specific')} />{t.label}
                </label>
              ))}
              <label className="inline-flex items-center gap-1">
                <input type="radio" name={`${fieldId}-level`} checked={level == null} onChange={() => setLevel(null)} />None
              </label>
              {level != null && (
                <select
                  aria-label={`Kind of insight for ${construct}`}
                  className="h-7 rounded-md border border-mm-border-medium bg-mm-surface px-1.5 text-xs text-mm-text"
                  value={type ?? ''}
                  onChange={e => setType(e.target.value || null)}
                >
                  <option value="">Kind of insight…</option>
                  {META_INFERENCE_TYPES.map(t => <option key={t.key} value={t.key} title={t.definition}>{t.label}</option>)}
                </select>
              )}
            </fieldset>
            <p className="text-xs text-mm-text-muted">{META_INFERENCE_CITATION}</p>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" disabled={!dirty} aria-label={`Save meta-inference for ${construct}`} onClick={e => {
                const land = landOnMetaText(e.currentTarget)
                saveMeta()
                land()
              }}>Save meta-inference</Button>
              {byline() && <span className="text-xs text-mm-text-muted">{byline()}</span>}
            </div>
          </div>
        ) : (
          <div>
            <p className="whitespace-pre-wrap">{meta?.text || <span className="text-mm-text-muted">Not written.</span>}</p>
            {byline() && <p className="text-xs text-mm-text-muted">{byline()}</p>}
          </div>
        )}
      </section>

      {display.settings.implication && (
        <section aria-labelledby={`${fieldId}-impl`}>
          <h4 id={`${fieldId}-impl`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">Implication</h4>
          {isEditable ? (
            <Textarea
              aria-label={`Implication for ${construct}`}
              value={implication}
              rows={2}
              onChange={e => setImplication(e.target.value)}
              onBlur={() => { if (implication !== row.implication) onChange({ implication }) }}
            />
          ) : (
            <p className="whitespace-pre-wrap">{row.implication || <span className="text-mm-text-muted">Not written.</span>}</p>
          )}
          <p className="mt-1 text-xs text-mm-text-muted">{IMPLICATION_CITATION}</p>
        </section>
      )}
    </div>
  )
}

/** One bound result: the report's own sentence, then its table (the one a chart embed exports). */
function ResultBlock({ construct, id, results, formed }: {
  construct: string; id: number | null; results: DisplayResultsState; formed: boolean
}) {
  const text = besideSentence(construct, id, results.results, results.status === 'failed', formed, 'below')
  const r = id != null ? results.results.get(id) : undefined
  const tableState = id != null ? results.tables.get(id) : undefined
  return (
    <div className="space-y-1">
      <p className="text-xs text-mm-text-secondary">{text}</p>
      {r?.unit != null && tableState === 'loading' && <LoadingNotice label="Loading its table…" size="panel" />}
      {r?.unit != null && tableState === 'failed' && <p className="text-xs text-mm-text-muted">Its table could not be loaded.</p>}
      {r?.table && (
        <ScrollableTable>
          <table className="border-collapse text-[12px]">
            <caption className="sr-only">{r.name}</caption>
            <thead>
              <tr className="border-b border-mm-border-medium text-left text-mm-text-secondary">
                {r.table.headers.map((h, j) => <th key={j} scope="col" className="px-2 py-1 font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.table.rows.map((cells, j) => (
                <tr key={j} className="border-b border-mm-border-subtle">
                  {cells.map((c, k) => <td key={k} className="px-2 py-1 text-mm-text">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      )}
      {r?.table?.note && <p className="text-[11px] text-mm-text-muted">{r.table.note}</p>}
    </div>
  )
}

/**
 * r2-3 — the row's fits, one per NAMED pair (shape (ii); the literature's L1: every fit vocabulary
 * is defined over a pair, and none rolls pairs up). The researcher adds a pair, picks its two
 * strands and its fit; the app never suggests one, and never lists every pair by itself. A pair
 * where neither strand has evidence is DERIVED "not applicable" (r2-8), with no fit to choose.
 * A two-strand display has one pair and no pair controls — slice 1's look.
 */
function PairFits({ construct, display, row, result, isEditable, fieldId, onChange }: {
  construct: string
  display: JointDisplay
  row: JointDisplayRow
  result: JointDisplayRowResult | null
  isEditable: boolean
  fieldId: string
  onChange: (patch: Partial<JointDisplayRow>) => void
}) {
  const vocabulary = fitVocabulary(display.settings.fit_vocabulary)
  const fits = rowFits(display, row)
  const strands = displayStrands(display)
  const many = strands.length > 2
  const stored = fits.map(f => ({ strands: [f.pair[0].key, f.pair[1].key] as [string, string], fit: f.fit }))
  const write = (next: typeof stored) => onChange(writeFits(display, row, next))
  const next = isEditable ? nextPair(display, row) : null
  const cls = 'h-7 rounded-md border border-mm-border-medium bg-mm-surface px-1.5 text-xs text-mm-text'
  return (
    <div className="space-y-3" data-fits>
      {fits.map(({ pair, fit }, i) => {
        const name = fitPairText(strandTag(display, pair[0]), strandTag(display, pair[1]))
        const na = pairNotApplicable(display, row, result, pair)
        const setPair = (at: 0 | 1, key: string) => {
          const strandsNow = [...stored[i].strands] as [string, string]
          strandsNow[at] = key
          if (strandsNow[0] === strandsNow[1]) strandsNow[1 - at] = stored[i].strands[at]
          write(stored.map((f, j) => (j === i ? { ...f, strands: strandsNow } : f)))
        }
        // #1704 (a) (D383): a pair ANOTHER fit records is not offered — choosing it made two fits
        // of one pair, and `rowFits`' de-duplication then silently dropped the one being edited.
        const recordedElsewhere = (a: string, b: string) => stored.some((f, j) => j !== i
          && ((f.strands[0] === a && f.strands[1] === b) || (f.strands[0] === b && f.strands[1] === a)))
        // The first select's pick swaps the two when it names the second strand (`setPair`), so
        // that option keeps this fit's own pair and is always offered.
        const firstOptions = strands.filter(st => st.key === pair[1].key || !recordedElsewhere(st.key, pair[1].key))
        const secondOptions = strands.filter(st => st.key !== pair[0].key && !recordedElsewhere(pair[0].key, st.key))
        return (
          <div key={`${pair[0].key}|${pair[1].key}`} className="space-y-1" data-fit>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {isEditable && many ? (
                <>
                  <select aria-label={`First strand of fit ${i + 1} for ${construct}`} className={cls} value={pair[0].key}
                    onChange={e => setPair(0, e.target.value)}>
                    {firstOptions.map(st => <option key={st.key} value={st.key}>{strandTag(display, st)}</option>)}
                  </select>
                  <span aria-hidden className="text-mm-text-secondary">·</span>
                  <select aria-label={`Second strand of fit ${i + 1} for ${construct}`} className={cls} value={pair[1].key}
                    onChange={e => setPair(1, e.target.value)}>
                    {secondOptions.map(st => <option key={st.key} value={st.key}>{strandTag(display, st)}</option>)}
                  </select>
                </>
              ) : <span className="font-medium text-mm-text-secondary">{name}</span>}
              {isEditable && fits.length > 1 && (
                <button type="button" className="ml-auto text-mm-blue-text hover:underline"
                  aria-label={`Remove the ${name} fit for ${construct}`}
                  onClick={e => {
                    // #1660 (D345): the fit goes with its button (and at two fits both Remove
                    // buttons go) — land on the fit now in its place, else the one before.
                    const fitsEl = e.currentTarget.closest<HTMLElement>('[data-fits]')
                    const land = landAfterPress(e.currentTarget, () => fitControl(fitsEl, i))
                    write(stored.filter((_, j) => j !== i))
                    land()
                  }}>Remove</button>
              )}
            </div>
            {na ? <p className="text-xs text-mm-text-muted">{PAIR_NOT_APPLICABLE_TEXT}</p> : isEditable ? (
              <fieldset>
                <legend className="sr-only">Fit for {construct}: {name}</legend>
                <div className="space-y-1">
                  {vocabulary.terms.map(t => (
                    <label key={t.key} className="flex items-start gap-2">
                      <input type="radio" name={`${fieldId}-fit-${i}`} className="mt-1" checked={fit === t.key}
                        onChange={() => write(stored.map((f, j) => (j === i ? { ...f, fit: t.key } : f)))} />
                      <span><span className="text-mm-text">{t.label}</span>{' '}
                        <span className="text-xs text-mm-text-muted">{t.definition}</span></span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2">
                    <input type="radio" name={`${fieldId}-fit-${i}`} checked={fit == null}
                      onChange={() => write(stored.map((f, j) => (j === i ? { ...f, fit: null } : f)))} />
                    <span className="text-mm-text-muted">Not set</span>
                  </label>
                </div>
              </fieldset>
            ) : <p>{fitTerm(vocabulary, fit)?.label ?? 'Not set'}</p>}
          </div>
        )
      })}
      {next && (
        <Button type="button" variant="outline" size="sm" data-fit-add aria-label={`${ADD_FIT_PAIR_TEXT} for ${construct}`}
          onClick={e => {
            // #1660 (D345): adding the LAST pair unmounts this button (`nextPair` is then null) —
            // land on the new fit. Below that, the button stays and keeps focus.
            const fitsEl = e.currentTarget.closest<HTMLElement>('[data-fits]')
            const land = landAfterPress(e.currentTarget, () => fitControl(fitsEl, Number.MAX_SAFE_INTEGER))
            write([...stored, { strands: [next[0].key, next[1].key], fit: null }])
            land()
          }}>
          <Plus className="w-3.5 h-3.5 mr-1" aria-hidden />{ADD_FIT_PAIR_TEXT}
        </Button>
      )}
      {isEditable && <p className="text-xs text-mm-text-muted">{many ? `${FIT_PAIR_HELP} ` : ''}{vocabulary.citation} The app never suggests a fit.</p>}
    </div>
  )
}

/** A between-group number, or — when there is none — only the sentence saying why. */
function DifferenceLine({ name, value, note }: { name: string; value: string; note: string | null }) {
  return (
    <li>
      <span className="text-mm-text-secondary">{name}: </span>
      {value === NO_VALUE && note ? <span className="text-mm-text-muted">{note}</span> : (
        <>{value}{note && <span className="text-xs text-mm-text-muted"> — {note}</span>}</>
      )}
    </li>
  )
}

/**
 * #1660 (D345) — the control a fit's landing focuses: the fit at `index` (else the last before
 * it): its first strand select (several strands), else its chosen fit, else its first control;
 * with no fit to land on, the *Add a fit* button.
 */
function fitControl(fitsEl: HTMLElement | null, index: number): HTMLElement | null {
  if (fitsEl == null) return null
  const fit = atOrBefore(fitsEl, '[data-fit]', index)
  const control = fit?.querySelector<HTMLElement>('select')
    ?? fit?.querySelector<HTMLElement>('input:checked')
    ?? fit?.querySelector<HTMLElement>('input, button')
  return control ?? fitsEl.querySelector<HTMLElement>('[data-fit-add]')
}

function PinCard({
  pin, attribution, isEditable, onChange, onRemove,
}: {
  pin: JointDisplayPin
  attribution: string
  isEditable: boolean
  onChange: (next: JointDisplayPin) => void
  /** Handed the pressed button, so the removal can land focus (#1660, D345). */
  onRemove: (pressed: HTMLButtonElement) => void
}) {
  const [purpose, setPurpose] = useState(pin.purpose)
  const role = PIN_ROLES.find(r => r.key === pin.role)
  // #1714 (b), D397: each per-pin control names its quote (two pins in a group gave two of each,
  // named nothing); the picker's own *Pin “…”* is the shape. A pin with no words says "this quote".
  const words = wholeQuoteLabel(pin.displayText ?? '')
  const quoted = words ? `“${words}”` : 'this quote'
  return (
    <div className="rounded-md border border-mm-border-subtle bg-mm-surface px-3 py-2">
      <blockquote className="text-sm text-mm-text">“{pin.displayText}”</blockquote>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mm-text-muted">
        {attribution && <span>{attribution}</span>}
        {isEditable ? (
          <select
            aria-label={`Role of ${quoted}`}
            className="h-6 rounded border border-mm-border-medium bg-mm-surface px-1 text-xs text-mm-text"
            value={pin.role ?? ''}
            onChange={e => onChange({ ...pin, role: (e.target.value || null) as PinRole | null })}
          >
            <option value="">Role…</option>
            {PIN_ROLES.map(r => <option key={r.key} value={r.key} title={r.definition}>{r.label}</option>)}
          </select>
        ) : role && <span>{role.label}</span>}
        {isEditable && (
          <button type="button" onClick={e => onRemove(e.currentTarget)} aria-label={`Unpin ${quoted}`} data-unpin
            className="ml-auto p-0.5 rounded text-mm-text-faint hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30">
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
      </div>
      {pin.role === 'discrepant' && (isEditable ? (
        <input
          aria-label={`Why ${quoted} is here`}
          className="mt-1 w-full h-7 rounded border border-mm-border-medium bg-mm-surface px-2 text-xs text-mm-text"
          placeholder="Why it is here, in one line"
          value={purpose}
          onChange={e => setPurpose(e.target.value)}
          onBlur={() => { if (purpose !== pin.purpose) onChange({ ...pin, purpose }) }}
        />
      ) : pin.purpose && <p className="mt-1 text-xs text-mm-text-secondary">{pin.purpose}</p>)}
    </div>
  )
}

/**
 * r5-1 — the open construct's "Cases that don't fit": what the row's misfit says, read live
 * (the count under the display's own scope, `useMisfitReads`), and the button to the case view.
 * A canvas surface: a failed count is said, with no Retry (`list-load-state.md` §7).
 */
function MisfitSection({ construct, display, row, strands, cases, inactiveCodes, fieldId, onCasesRequest }: {
  construct: string
  display: JointDisplay
  row: JointDisplayRow
  strands: ReturnType<typeof rowStrands>
  cases: ConstructDetailProps['cases']
  /** #1664 (D333): the row's inactive bound codes, so a saved rule naming one names it. */
  inactiveCodes: { code_id: number; name: string }[] | undefined
  fieldId: string
  onCasesRequest: (() => void) | null
}) {
  const reads = useMisfitReads(cases.projectId, display, [row.key], cases.scope, cases.settled, cases.noViewer)
  const read = reads.get(row.key)
  const m = row.misfit
  const conditions = m?.rule?.conditions ?? []
  const names = ruleNamesFrom(display, {
    codes: strands.flatMap(rs => rs.result?.codes ?? []),
    variables: strands.flatMap(rs => rs.result?.variables ?? []),
    inactive: inactiveCodes,  // #1664 (D333): a rule naming one names it
  })
  const named = read?.status === 'ready' ? new Map(read.data.named_cases.map(c => [c.participant_id, c])) : null
  const who = (pid: number | null) => {
    if (pid == null) return CASE_GONE_TEXT
    if (!named) return read?.status === 'failed' || read?.status === 'no-viewer' ? CASE_NAME_UNREAD_TEXT : CASE_NAME_LOADING_TEXT
    const c = named.get(pid)
    return c ? `${c.label}${c.group == null ? ` (${CASE_OUTSIDE_GROUPS_TEXT})` : ''}` : CASE_GONE_TEXT
  }
  return (
    <section aria-labelledby={`${fieldId}-misfit`}>
      <h4 id={`${fieldId}-misfit`} className="text-[11px] font-bold uppercase tracking-wide text-mm-text-muted mb-1">{MISFIT_HEADING}</h4>
      {!hasMisfit(row) ? <p className="text-xs text-mm-text-muted">{MISFIT_NONE_TEXT}</p> : (
        <div className="space-y-1 text-xs">
          {conditions.length > 0 && (
            <p><span className="font-medium text-mm-text-secondary">{MISFIT_RULE_LABEL}: </span>{ruleSentence(conditions, names)}.</p>
          )}
          {conditions.length > 0 && read && (
            read.status === 'loading' ? <LoadingNotice label={MISFIT_COUNT_LOADING_TEXT} size="panel" />
              : read.status === 'failed' ? <p className="text-mm-text">{MISFIT_COUNT_FAILED_TEXT} {loadFailureReason(read.error)}</p>
                : read.status === 'no-viewer' ? <p className="text-mm-text-muted">{CASES_NO_VIEWER_TEXT}</p>
                  : read.status === 'ready' ? <p className="text-mm-text-secondary">{misfitStatusText(read.data, true)}</p> : null
          )}
          {(['added', 'removed'] as const).map(list => (m?.[list].length ?? 0) > 0 && (
            <div key={list}>
              <p className="font-medium text-mm-text-secondary">{list === 'added' ? MISFIT_ADDED_LABEL : MISFIT_REMOVED_LABEL}</p>
              <ul className="list-disc pl-4">
                {m![list].map((c, i) => <li key={`${c.participant_id ?? 'gone'}-${i}`}>{who(c.participant_id)} — {c.reason}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      {onCasesRequest && (
        <Button type="button" variant="outline" size="sm" className="mt-1.5" aria-label={caseViewOpenLabel(construct)} onClick={onCasesRequest}>
          {CASE_VIEW_OPEN_TEXT}
        </Button>
      )}
    </section>
  )
}
