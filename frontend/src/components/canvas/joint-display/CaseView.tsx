/**
 * Joint display slice 2, round 2 (r5) — the case-ordered view and "cases that don't fit" (D173):
 * one row per participant of the display's groups, the row's codes and variables per strand, the
 * researcher's RULE (sentence-shaped, one condition per line, AND only — r3-1, r3-10) and the
 * cases they ADD or REMOVE, each with a required reason (r3-9, r3-12).
 *
 * 🔴 **Hosted by the PAGE** (`DisplayDialogHost`, D213): a dialog the node view owned would
 * unmount the commit it mounted. Every edit is ONE `onCommit` — `commitDisplay` to the LIVE
 * view's `updateAttributes`, so the editor's history undoes it.
 * 🔴 **The app never decides misfit** (D173): no case is suggested, no threshold proposed; the
 * table reads the SAVED rule (a draft is never evaluated before it is saved).
 * 🔴 **Blind** (D175, #1615): the read takes the compute's own scope; a rule over a rating score
 * is not run and the server names the variable (r3-3) — said in the count's place.
 * ⚠️ **An unanswered read is never "0 cases"** (`list-load-state.md`): `useListLoad` + `LoadState`
 * for the table; the editor's headers and the case names are kept across reads because no key
 * narrows them (§1's #1467 exemption — the rule, page and list narrow the CASES, not who a
 * participant is or which codes and variables the row binds).
 * ⚠️ **Focus never falls to `<body>`**: nothing a press acts on unmounts or turns natively
 * `disabled` under it — busy and unavailable buttons are `aria-disabled` with a guard (#954),
 * and a press that ends a form lands on a control that stays (`frontend-a11y.md` #955 b).
 * ⚠️ **…and each one LOOKS unavailable — `MODE_DISABLED_CLASS`** (`lib/mode-disabled.ts`): the
 * Button's `disabled:` styles key on the native attribute, so without it an aria-disabled Save
 * rule stayed a solid primary button that did nothing (the 2026-11-16 drive, both themes).
 * Pinned for this folder by `joint-display-aria-disabled-look.test.ts`.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { LoadState } from '@/components/LoadStatus'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'
import { useListLoad } from '@/hooks/useListLoad'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import { jointDisplayApi, type JointDisplayCasesResponse, type JointDisplayInactiveCode } from '@/lib/api'
import type { DisplayCoderScope, JointDisplay, JointDisplayRow } from '@/lib/joint-display'
import { ruleSentence, type JointDisplayMisfit, type MisfitCondition } from '@/lib/joint-display-misfit'
import {
  CASE_PAGE_SIZE, MAX_LISTED_CASES, MAX_RULE_CONDITIONS, caseCodeText, caseListedText, caseRequest,
  caseValueText, codeStrandsOf, misfitStatusText, ruleNamesFrom, withCase, withReason, withRule, withoutCase,
  type CaseListName, type CaseListView,
} from '@/lib/joint-display-cases'
import { displayStrands, strandTag } from '@/lib/joint-display-strands'
import { NO_GROUPING_TEXT, isGroupingGone } from '@/lib/joint-display-report'
import * as W from '@/lib/joint-display-vocabulary'

export type MisfitUpdate = (current: JointDisplayMisfit | null) => JointDisplayMisfit | null

export interface CaseViewProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number
  display: JointDisplay
  rowKey: string
  /** The compute's own scope (D175) — never a second derivation. */
  scope: DisplayCoderScope
  /** Withholding with no viewer id (D96): no read. */
  noViewer: boolean
  /** The grouping variable's name, as the compute answered it — the rule's group clause. */
  groupBy: string
  /** Applies `update` to the LIVE row's misfit (`commitDisplay`); false when the display is gone. */
  onCommit: (update: MisfitUpdate) => boolean
}

export default function CaseView(props: CaseViewProps) {
  const row = props.display.rows.find(r => r.key === props.rowKey)
  const construct = row?.construct.trim() || 'Untitled construct'
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className={`sm:max-w-[920px] ${DIALOG_FITS_VIEWPORT} [@media(max-height:480px)]:p-4`}>
        <DialogHeader>
          <DialogTitle>{W.caseViewTitle(construct)}</DialogTitle>
          {/* r3-13 b, above the view — ONE joined string (#1067 c). */}
          <DialogDescription>{`${W.MISFIT_PRINCIPLE_TEXT} ${W.CASE_VIEW_DISCLOSURE_TEXT}`}</DialogDescription>
        </DialogHeader>
        {row ? <CaseViewBody {...props} row={row} /> : <p className="text-sm text-mm-text-muted">{NO_GROUPING_TEXT}</p>}
      </DialogContent>
    </Dialog>
  )
}

/** #1664 (D332–D334): `inactive` — the row's bound codes the codebook made inactive, out of the
 *  columns and the rule's menu (the server's `codes` already leaves them out), named in a saved
 *  rule's sentence and said above the table. */
type Heads = Pick<JointDisplayCasesResponse, 'groups' | 'codes' | 'variables'> & { inactive: JointDisplayInactiveCode[] }
type Pending = { action: 'add' | 'remove'; participantId: number; label: string; group: string }

function CaseViewBody({ projectId, display, row, rowKey, scope, noViewer, groupBy, onCommit }: CaseViewProps & { row: JointDisplayRow }) {
  const uid = useId()
  // The misfit as this dialog last WROTE it (each write also goes to the live node).
  const [misfit, setMisfit] = useState<JointDisplayMisfit | null>(row.misfit)
  const [only, setOnly] = useState<CaseListView>('all')
  const [offset, setOffset] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const addedHeading = useRef<HTMLHeadingElement>(null)
  const removedHeading = useRef<HTMLHeadingElement>(null)
  const listHeadings = { added: addedHeading, removed: removedHeading }
  // A press that ends a form or an entry lands on something that stays: the list's heading,
  // or the row's own action (the targets exist when pressed, so focus moves at once).
  const focusList = (list: CaseListName) => listHeadings[list].current?.focus()
  const actionRefs = useRef(new Map<number, HTMLButtonElement>())

  const live = useMemo<JointDisplay>(
    () => ({ ...display, rows: display.rows.map(r => (r.key === rowKey ? { ...r, misfit } : r)) }),
    [display, rowKey, misfit],
  )
  const request = useMemo(
    () => caseRequest(live, rowKey, scope, { only, offset, limit: CASE_PAGE_SIZE }),
    [live, rowKey, scope, only, offset],
  )
  const query = useQuery({
    // The request IS the key, so it carries the scope (#454); a literal root, so the coding
    // cache's census reads it (`coding-cache-population.test.ts`).
    queryKey: ['joint-display-cases', projectId, request],
    queryFn: () => jointDisplayApi.cases(projectId, request!),
    enabled: request != null && !noViewer,
  })
  const load = useListLoad(query)
  const data = query.data

  // Kept across reads — no key narrows them (the docstring's #1467 note). Taken from each NEW
  // answer during render (React's "information from previous renders" pattern), never an effect.
  const [seen, setSeen] = useState<JointDisplayCasesResponse | undefined>(undefined)
  const [heads, setHeads] = useState<Heads | null>(null)
  const [named, setNamed] = useState(new Map<number, { label: string; group: string | null }>())
  if (data && data !== seen) {
    setSeen(data)
    setHeads({ groups: data.groups, codes: data.codes, variables: data.variables, inactive: data.inactive_codes ?? [] })
    setNamed(prev => new Map([...prev, ...data.named_cases.map(c => [c.participant_id, { label: c.label, group: c.group }] as const)]))
  }

  const commit = (update: MisfitUpdate): boolean => {
    if (!onCommit(update)) return false
    setMisfit(m => update(m))
    return true
  }
  const conditions = misfit?.rule?.conditions ?? []
  const names = heads ? ruleNamesFrom(display, groupBy, heads) : null

  // ── The disabled cases first (`list-load-state.md` §7) ──
  if (noViewer) return <p className="text-sm text-mm-text">{W.CASES_NO_VIEWER_TEXT}</p>
  if (request == null) return <p className="text-sm text-mm-text">{NO_GROUPING_TEXT}</p>

  const ruleRan = data?.matched != null
  const status = data ? misfitStatusText(data, conditions.length > 0) : null
  const codeCols = codeStrandsOf(display).flatMap(s => (row.bindings[s.key]?.code_ids ?? [])
    .filter((id): id is number => id != null && (heads?.codes ?? []).some(c => c.code_id === id))
    .map(id => {
      const name = heads!.codes.find(c => c.code_id === id)!.name
      return { key: `${s.key}:c${id}`, strand: s, id, label: codeStrandsOf(display).length > 1 ? `${name} · ${strandTag(display, s)}` : name }
    }))
  const varStrands = displayStrands(display).filter(s => s.kind === 'variables')
  const varCols = varStrands.flatMap(s => (heads?.variables ?? [])
    .filter(v => (row.bindings[s.key]?.column_ids ?? []).includes(v.column_id) && (s.dataset_id == null || v.dataset_id === s.dataset_id))
    .map(v => ({ key: `${s.key}:v${v.column_id}`, strand: s, id: v.column_id, label: varStrands.length > 1 ? `${v.name} · ${strandTag(display, s)}` : v.name })))

  const listFull = (list: CaseListName) => (misfit?.[list].length ?? 0) >= MAX_LISTED_CASES
  const nameOf = (pid: number | null): string => {
    if (pid == null) return W.CASE_GONE_TEXT
    const n = named.get(pid)
    if (n) return n.label
    return data ? W.CASE_GONE_TEXT : W.CASE_NAME_LOADING_TEXT
  }

  return (
    <div className="min-w-0 space-y-4 text-sm">
      {/* #1664 (D334): which bound code is out of the case view and where its coding went —
          the Compact view's and the report's sentence. */}
      {(heads?.inactive.length ?? 0) > 0 && (
        <div className="space-y-1" data-testid="case-view-inactive-codes">
          {heads!.inactive.map(c => (
            <p key={`${c.strand_key}-${c.code_id}`} className="text-xs text-mm-orange-text">{W.inactiveCodeText(c)}</p>
          ))}
        </div>
      )}
      <RuleEditor
        saved={conditions}
        heads={heads}
        display={display}
        row={row}
        groupBy={groupBy}
        sentence={names && conditions.length ? ruleSentence(conditions, names) : null}
        onSave={next => { if (commit(m => withRule(m, next))) setOffset(0) }}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex items-center gap-3 text-xs">
          <legend className="sr-only">{W.CASES_SHOW_LEGEND}</legend>
          <span aria-hidden className="text-mm-text-secondary">{W.CASES_SHOW_LEGEND}:</span>
          {([['all', W.CASES_SHOW_ALL], ['list', W.CASES_SHOW_LIST]] as const).map(([k, label]) => (
            <label key={k} className="inline-flex items-center gap-1">
              <input type="radio" name={`${uid}-only`} checked={only === k} onChange={() => { setOnly(k); setOffset(0) }} />
              {label}
            </label>
          ))}
        </fieldset>
        {/* The count — a change the researcher's own save caused, so polite. */}
        <p role="status" className="text-xs text-mm-text-secondary">{status ?? ''}</p>
      </div>

      {pending && (
        <ReasonForm
          key={`${pending.action}:${pending.participantId}`}
          pending={pending}
          onCancel={() => { actionRefs.current.get(pending.participantId)?.focus(); setPending(null) }}
          onConfirm={reason => {
            const list: CaseListName = pending.action === 'add' ? 'added' : 'removed'
            if (withCase(misfit, list, pending.participantId, reason) === undefined) return false
            if (!commit(m => withCase(m, list, pending.participantId, reason) ?? m)) return false
            setNamed(prev => new Map(prev).set(pending.participantId, { label: pending.label, group: pending.group }))
            focusList(list)
            setPending(null)
            return true
          }}
        />
      )}

      <div className="space-y-2">
        {load.status === 'failed' && !load.retrying && isGroupingGone(load.error) ? (
          // #1653 (D347): the grouping variable went while the case view was open — the display's
          // own sentence, and no Retry: nothing a second request could change.
          <p role="alert" className="text-sm text-mm-text">{W.GROUPING_GONE_TEXT}</p>
        ) : load.status !== 'ready' ? (
          <LoadState load={load} size="panel" loadingLabel={W.CASES_LOADING_TEXT} failedTitle={W.CASES_FAILED_TEXT} />
        ) : data!.unavailable_reason || data!.total === 0 ? (
          <p className="text-mm-text-muted">{W.CASES_NO_GROUPS_TEXT}</p>
        ) : data!.listed === 0 ? (
          <p className="text-mm-text-muted">{W.CASES_EMPTY_LIST_TEXT}</p>
        ) : (
          <ScrollableTable maxHeight="55vh" tabIndex={0} role="region" aria-label={W.caseViewTitle(row.construct.trim() || 'Untitled construct')}>
            <table className="border-collapse text-[12px]">
              <caption className="sr-only">{W.caseViewTitle(row.construct.trim() || 'Untitled construct')}</caption>
              <thead>
                <tr className="border-b border-mm-border-medium text-left text-mm-text-secondary">
                  <th scope="col" className="px-2 py-1 font-semibold">{W.CASE_COLUMN_CASE}</th>
                  <th scope="col" className="px-2 py-1 font-semibold">{W.CASE_COLUMN_GROUP}</th>
                  {[...codeCols, ...varCols].map(c => <th key={c.key} scope="col" className="px-2 py-1 font-semibold">{c.label}</th>)}
                  <th scope="col" className="px-2 py-1 font-semibold">{W.CASE_COLUMN_LIST}</th>
                  <th scope="col" className="px-2 py-1 font-semibold"><span className="sr-only">{W.CASE_COLUMN_ACTION}</span></th>
                </tr>
              </thead>
              <tbody>
                {data!.cases.map(c => {
                  const action = c.removed || c.listed_by === 'added' ? null : c.listed_by === 'rule' ? 'remove' as const : 'add' as const
                  const full = action != null && listFull(action === 'add' ? 'added' : 'removed')
                  return (
                    <tr key={c.participant_id} className="border-b border-mm-border-subtle align-top">
                      <th scope="row" className="px-2 py-1 text-left font-medium text-mm-text whitespace-nowrap">{c.label}</th>
                      <td className="px-2 py-1 text-mm-text">{c.group}</td>
                      {codeCols.map(col => <td key={col.key} className="px-2 py-1 text-mm-text">{caseCodeText(c.facts[col.strand.key], col.id, col.strand.kind)}</td>)}
                      {varCols.map(col => <td key={col.key} className="px-2 py-1 text-mm-text">{caseValueText(c.facts[col.strand.key], col.id)}</td>)}
                      <td className="px-2 py-1 text-mm-text-secondary">{caseListedText(c, ruleRan)}</td>
                      <td className="px-2 py-1">
                        {action && (
                          <Button
                            ref={el => { if (el) actionRefs.current.set(c.participant_id, el); else actionRefs.current.delete(c.participant_id) }}
                            type="button" size="sm" variant="ghost" className={`h-6 px-2 text-xs ${MODE_DISABLED_CLASS}`}
                            aria-label={`${action === 'add' ? W.caseAddLabel(c.label) : W.caseRemoveLabel(c.label)}${full ? ` — ${W.caseListMaxText(MAX_LISTED_CASES)}` : ''}`}
                            aria-disabled={full || undefined}
                            onClick={() => { if (!full) setPending({ action, participantId: c.participant_id, label: c.label, group: c.group }) }}
                          >
                            {action === 'add' ? W.CASE_ADD_TEXT : W.CASE_REMOVE_TEXT}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </ScrollableTable>
        )}
        {data && data.added_outside > 0 && <p className="text-xs text-mm-text-muted">{W.addedOutsideText(data.added_outside)}</p>}
        {/* The pager stays mounted, so a press never drops focus while the next page loads. */}
        <Pager offset={offset} listed={load.status === 'ready' ? data!.listed : null} onPage={setOffset} />
      </div>

      <CaseLists
        misfit={misfit}
        nameOf={nameOf}
        groupOf={pid => (pid != null ? named.get(pid)?.group ?? null : null)}
        headings={listHeadings}
        onReason={(list, pid, reason) => commit(m => withReason(m, list, pid, reason) ?? m)}
        onUndo={(list, pid) => { if (commit(m => withoutCase(m, list, pid))) focusList(list) }}
      />
    </div>
  )
}

function Pager({ offset, listed, onPage }: { offset: number; listed: number | null; onPage: (o: number) => void }) {
  const canPrev = offset > 0
  const canNext = listed != null && offset + CASE_PAGE_SIZE < listed
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-mm-text-secondary">
      <span>{listed != null && listed > 0 ? W.casesRangeText(offset + 1, Math.min(offset + CASE_PAGE_SIZE, listed), listed) : ''}</span>
      <Button type="button" size="sm" variant="outline" className={`h-6 px-2 text-xs ${MODE_DISABLED_CLASS}`} aria-disabled={!canPrev || undefined}
        onClick={() => { if (canPrev) onPage(Math.max(0, offset - CASE_PAGE_SIZE)) }}>{W.CASES_PREVIOUS_TEXT}</Button>
      <Button type="button" size="sm" variant="outline" className={`h-6 px-2 text-xs ${MODE_DISABLED_CLASS}`} aria-disabled={!canNext || undefined}
        onClick={() => { if (canNext) onPage(offset + CASE_PAGE_SIZE) }}>{W.CASES_NEXT_TEXT}</Button>
    </div>
  )
}

/** r3-9 — the reason a case is added or removed: required, with r3-13 a's warning beside it. */
function ReasonForm({ pending, onCancel, onConfirm }: {
  pending: Pending; onCancel: () => void; onConfirm: (reason: string) => boolean
}) {
  const uid = useId()
  const [reason, setReason] = useState('')
  const [refused, setRefused] = useState(false)
  const title = pending.action === 'add' ? W.caseAddLabel(pending.label) : W.caseRemoveLabel(pending.label)
  return (
    <div role="group" aria-labelledby={`${uid}-t`} className="space-y-2 rounded-md border border-mm-border-medium bg-mm-surface-hover px-3 py-2">
      <h3 id={`${uid}-t`} className="text-xs font-semibold text-mm-text">{title}</h3>
      <Textarea
        autoFocus rows={2} value={reason}
        aria-label={W.caseReasonLabel(pending.action, pending.label)}
        aria-required
        aria-invalid={refused || undefined}
        aria-describedby={`${uid}-warn${refused ? ` ${uid}-err` : ''}`}
        onChange={e => { setReason(e.target.value); if (refused) setRefused(false) }}
      />
      <p id={`${uid}-warn`} className="text-[11px] text-mm-text-muted">{W.MISFIT_DISCLOSURE_TEXT}</p>
      {refused && <p id={`${uid}-err`} role="alert" className="text-xs text-mm-text">{W.MISFIT_REASON_REQUIRED_TEXT}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => { if (!onConfirm(reason)) setRefused(!reason.trim()) }}>
          {pending.action === 'add' ? W.CASE_ADD_CONFIRM_TEXT : W.CASE_REMOVE_CONFIRM_TEXT}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

/** r3-12 — both lists, each case with its reason (edited in place) and an Undo. */
function CaseLists({ misfit, nameOf, groupOf, headings, onReason, onUndo }: {
  misfit: JointDisplayMisfit | null
  nameOf: (pid: number | null) => string
  groupOf: (pid: number | null) => string | null
  headings: Record<CaseListName, React.RefObject<HTMLHeadingElement | null>>
  onReason: (list: CaseListName, pid: number | null, reason: string) => void
  onUndo: (list: CaseListName, pid: number | null) => void
}) {
  const any = (misfit?.added.length ?? 0) + (misfit?.removed.length ?? 0) > 0
  return (
    <div className="space-y-3">
      {any && <p className="text-[11px] text-mm-text-muted">{W.MISFIT_DISCLOSURE_TEXT}</p>}
      {(['added', 'removed'] as const).map(list => {
        const cases = misfit?.[list] ?? []
        return (
          <section key={list} aria-labelledby={`misfit-${list}`} className="space-y-1">
            <h3 id={`misfit-${list}`} ref={headings[list]} tabIndex={-1} className="text-xs font-semibold text-mm-text focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
              {list === 'added' ? W.MISFIT_ADDED_LABEL : W.MISFIT_REMOVED_LABEL} ({cases.length})
            </h3>
            {cases.length === 0 ? <p className="text-xs text-mm-text-muted">{W.CASE_LIST_NONE_TEXT}</p> : (
              <ul className="space-y-2">
                {cases.map((c, i) => (
                  <CaseEntry key={`${c.participant_id ?? `gone-${i}`}`} list={list} who={nameOf(c.participant_id)}
                    group={groupOf(c.participant_id)} reason={c.reason}
                    onReason={r => onReason(list, c.participant_id, r)} onUndo={() => onUndo(list, c.participant_id)} />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

function CaseEntry({ list, who, group, reason, onReason, onUndo }: {
  list: CaseListName; who: string; group: string | null; reason: string
  onReason: (reason: string) => void; onUndo: () => void
}) {
  const uid = useId()
  const [draft, setDraft] = useState(reason)
  const [kept, setKept] = useState(false)
  const action = list === 'added' ? 'add' as const : 'remove' as const
  return (
    <li className="flex flex-wrap items-start gap-2">
      <span className="min-w-[6rem] text-xs font-medium text-mm-text">{who}{group ? ` · ${group}` : ''}</span>
      <div className="flex-1 min-w-[12rem]">
        <Textarea
          rows={1} value={draft} className="text-xs min-h-0"
          aria-label={W.caseReasonLabel(action, who)}
          aria-required
          aria-describedby={kept ? `${uid}-kept` : undefined}
          onChange={e => { setDraft(e.target.value); setKept(false) }}
          onBlur={() => {
            if (!draft.trim()) { setDraft(reason); setKept(true); return }   // r3-9: never emptied
            if (draft.trim() !== reason) onReason(draft)
          }}
        />
        {kept && <p id={`${uid}-kept`} role="status" className="text-[11px] text-mm-text-muted">{W.MISFIT_REASON_KEPT_TEXT}</p>}
      </div>
      <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" aria-label={W.caseUndoLabel(action, who)} onClick={onUndo}>
        {action === 'add' ? W.CASE_UNDO_ADD_TEXT : W.CASE_UNDO_REMOVE_TEXT}
      </Button>
    </li>
  )
}

// ── The rule editor (r3-1, r3-4, r3-10) ──────────────────────────────────────────────

/** One line being edited. `what`: 'group' · `v:<column>` · `c:<strand>:<code>` · 'raw' (kept). */
interface Draft { what: string; group: string; op: string; value: string; present: boolean; raw?: MisfitCondition }

function toDraft(c: MisfitCondition): Draft {
  const blank = { group: '', op: '', value: '', present: true }
  if (c.kind === 'group') return { ...blank, what: 'group', group: c.group }
  if (c.kind === 'variable' && c.column_id != null) {
    return { ...blank, what: `v:${c.column_id}`, op: c.op, value: c.value == null ? '' : String(c.value) }
  }
  if (c.kind === 'code' && c.code_id != null) return { ...blank, what: `c:${c.strand_key}:${c.code_id}`, present: c.present }
  return { ...blank, what: 'raw', raw: c }   // unreadable or unresolved: kept as it is (R1)
}

/** The draft as conditions — the FINISHED lines only — and the 1-based lines that need a value
 *  (#1661: an unfinished line is one or the other, never both — it was both for a group line,
 *  which printed `Team is “”`). */
function fromDrafts(drafts: Draft[]): { conditions: MisfitCondition[]; missing: number[] } {
  const missing: number[] = []
  const conditions = drafts.map((d, i): MisfitCondition | null => {
    if (d.raw) return d.raw
    if (d.what === 'group') {
      if (!d.group) { missing.push(i + 1); return null }
      return { kind: 'group', group: d.group }
    }
    if (d.what.startsWith('v:')) {
      const column_id = Number(d.what.slice(2))
      if (d.op === W.SERVER_VOCABULARY.CASE_OP_MISSING) return { kind: 'variable', column_id, op: d.op, value: null }
      const numeric = (['lt', 'le', 'gt', 'ge', 'eq', 'ne'] as string[]).includes(d.op)
      const n = Number(d.value)
      if (!d.op || !d.value.trim() || (numeric && !Number.isFinite(n))) { missing.push(i + 1); return null }
      return { kind: 'variable', column_id, op: d.op, value: numeric ? n : d.value.trim() }
    }
    const [, strand_key, code] = d.what.split(':')
    return { kind: 'code', strand_key, code_id: Number(code), present: d.present }
  }).filter((c): c is MisfitCondition => c != null)
  return { conditions, missing }
}

function RuleEditor({ saved, heads, display, row, groupBy, sentence, onSave }: {
  saved: MisfitCondition[]
  heads: Heads | null
  display: JointDisplay
  row: JointDisplayRow
  groupBy: string
  /** The SAVED rule's sentence (r3-10), from the read's own names. */
  sentence: string | null
  onSave: (conditions: MisfitCondition[] | null) => void
}) {
  const uid = useId()
  const [drafts, setDrafts] = useState<Draft[]>(() => saved.map(toDraft))
  const [missing, setMissing] = useState<number[]>([])
  const addRef = useRef<HTMLButtonElement>(null)
  const firstRefs = useRef<(HTMLSelectElement | null)[]>([])
  // A new line's first field exists only after the render that adds it: asked for here, taken
  // by the effect after that commit. "Add a condition" always exists, so it is focused at once.
  const focusLineAfter = useRef<number | null>(null)
  useEffect(() => {
    if (focusLineAfter.current == null) return
    firstRefs.current[focusLineAfter.current]?.focus()
    focusLineAfter.current = null
  })
  const focusAdd = () => addRef.current?.focus()

  const codeStrands = codeStrandsOf(display)
  const codeOptions = heads ? codeStrands.flatMap(s => (row.bindings[s.key]?.code_ids ?? [])
    .filter((id): id is number => id != null && heads.codes.some(c => c.code_id === id))
    .map(id => ({ value: `c:${s.key}:${id}`, label: `${heads.codes.find(c => c.code_id === id)!.name}${codeStrands.length > 1 ? ` · ${strandTag(display, s)}` : ''}` }))) : []
  // #1664 (D333): the row's inactive bound codes, greyed with the reason (the withheld variables'
  // pattern) — a saved condition naming one shows it; a new condition cannot choose it.
  const inactiveOptions = (heads?.inactive ?? []).filter(c => codeStrands.some(s => s.key === c.strand_key))
    .map(c => ({ value: `c:${c.strand_key}:${c.code_id}`, label: `${c.name}${codeStrands.length > 1
      ? ` · ${strandTag(display, codeStrands.find(s => s.key === c.strand_key)!)}` : ''}${W.RULE_INACTIVE_OPTION_SUFFIX}` }))
  const varOptions = (heads?.variables ?? []).filter(v => v.operators.length > 0)
  const draftNames = heads ? ruleNamesFrom(display, groupBy, heads) : null
  const current = heads ? fromDrafts(drafts) : null
  // #1661: once the lines are drawn, the sentence is the DRAFT's — never the saved rule's, which
  // it fell back to whenever the draft held no finished line (the saved rule above an emptied list).
  const draftSentence = current && draftNames
    ? W.ruleDraftSentence(current.conditions.length ? ruleSentence(current.conditions, draftNames) : null, current.missing.length)
    : null
  const dirty = current != null && (current.missing.length > 0 || JSON.stringify(current.conditions) !== JSON.stringify(saved))
  const full = drafts.length >= MAX_RULE_CONDITIONS
  const set = (i: number, patch: Partial<Draft>) => setDrafts(ds => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const cls = 'h-7 rounded-md border border-mm-border-medium bg-mm-surface px-1.5 text-xs text-mm-text'

  return (
    <section aria-labelledby={`${uid}-h`} className="space-y-2">
      <h3 id={`${uid}-h`} className="text-xs font-semibold text-mm-text">{W.RULE_HEADING}</h3>
      {/* r3-10 — the rule as a sentence, above its lines: the draft's while editing (#1661: the
          saved rule's only before the lines are drawn — they need the read's names). */}
      <p className="text-mm-text">
        {(current ? draftSentence : sentence) ?? <span className="text-mm-text-muted">{W.RULE_EMPTY_TEXT}</span>}
      </p>
      {!heads ? null : (
        <>
          <ol className="space-y-1.5">
            {drafts.map((d, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="w-7 text-mm-text-secondary">{i === 0 ? '' : 'and'}</span>
                {d.raw ? (
                  <span className="text-mm-text-muted">{W.RULE_UNREADABLE_TEXT}</span>
                ) : (
                  <select ref={el => { firstRefs.current[i] = el }} aria-label={W.ruleFieldLabel(i + 1, 'what')} className={cls} value={d.what}
                    onChange={e => set(i, { what: e.target.value, group: '', op: '', value: '' })}>
                    <option value="group">{W.RULE_GROUP_OPTION}</option>
                    {varOptions.map(v => (
                      <option key={v.column_id} value={`v:${v.column_id}`} disabled={v.withheld}>
                        {v.name}{v.withheld ? W.RULE_WITHHELD_OPTION_SUFFIX : ''}
                      </option>
                    ))}
                    {codeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    {inactiveOptions.map(o => <option key={o.value} value={o.value} disabled>{o.label}</option>)}
                  </select>
                )}
                {!d.raw && d.what === 'group' && (
                  <>
                    <span className="text-mm-text-secondary">is</span>
                    <select aria-label={W.ruleFieldLabel(i + 1, 'group')} className={cls} value={d.group} onChange={e => set(i, { group: e.target.value })}>
                      <option value="">…</option>
                      {heads.groups.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </>
                )}
                {!d.raw && d.what.startsWith('v:') && (() => {
                  const v = heads.variables.find(x => x.column_id === Number(d.what.slice(2)))
                  return (
                    <>
                      <select aria-label={W.ruleFieldLabel(i + 1, 'comparison')} className={cls} value={d.op} onChange={e => set(i, { op: e.target.value })}>
                        <option value="">…</option>
                        {(v?.operators ?? []).map(op => <option key={op} value={op}>{W.CASE_OPERATOR_TEXT[op] ?? op}</option>)}
                      </select>
                      {d.op !== W.SERVER_VOCABULARY.CASE_OP_MISSING && (
                        <input aria-label={W.ruleFieldLabel(i + 1, 'value')} className={`${cls} w-28`} value={d.value}
                          inputMode={['lt', 'le', 'gt', 'ge', 'eq', 'ne'].includes(d.op) ? 'decimal' : undefined}
                          onChange={e => set(i, { value: e.target.value })} />
                      )}
                    </>
                  )
                })()}
                {!d.raw && d.what.startsWith('c:') && (
                  <select aria-label={W.ruleFieldLabel(i + 1, 'used')} className={cls} value={d.present ? 'yes' : 'no'}
                    onChange={e => set(i, { present: e.target.value === 'yes' })}>
                    <option value="yes">{W.RULE_CODE_PRESENT_TEXT}</option>
                    <option value="no">{W.RULE_CODE_ABSENT_TEXT}</option>
                  </select>
                )}
                <button type="button" className="text-mm-blue-text hover:underline" aria-label={W.ruleRemoveLabel(i + 1)}
                  onClick={() => { focusAdd(); setDrafts(ds => ds.filter((_, j) => j !== i)) }}>Remove</button>
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-mm-text-muted">{W.RULE_AND_TEXT}{full ? ` ${W.ruleMaxText(MAX_RULE_CONDITIONS)}` : ''}</p>
          {missing.length > 0 && <p role="alert" className="text-xs text-mm-text">{missing.map(W.ruleNeedsValueText).join(' ')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button ref={addRef} type="button" size="sm" variant="outline" className={MODE_DISABLED_CLASS} aria-disabled={full || undefined}
              aria-label={full ? `${W.RULE_ADD_CONDITION_TEXT} — ${W.ruleMaxText(MAX_RULE_CONDITIONS)}` : undefined}
              onClick={() => {
                if (full) return
                setDrafts(ds => [...ds, { what: 'group', group: '', op: '', value: '', present: true }])
                focusLineAfter.current = drafts.length
              }}>
              <Plus className="w-3.5 h-3.5 mr-1" aria-hidden />{W.RULE_ADD_CONDITION_TEXT}
            </Button>
            <Button type="button" size="sm" className={MODE_DISABLED_CLASS} aria-disabled={!dirty || undefined}
              onClick={() => {
                if (!dirty || !current) return
                if (current.missing.length) { setMissing(current.missing); return }
                setMissing([])
                onSave(current.conditions.length ? current.conditions : null)
              }}>{W.RULE_SAVE_TEXT}</Button>
            {dirty && (
              <Button type="button" size="sm" variant="ghost" onClick={() => { focusAdd(); setDrafts(saved.map(toDraft)); setMissing([]) }}>
                {W.RULE_DISCARD_TEXT}
              </Button>
            )}
            {saved.length > 0 && !dirty && (
              <Button type="button" size="sm" variant="ghost"
                onClick={() => { focusAdd(); setDrafts([]); setMissing([]); onSave(null) }}>{W.RULE_CLEAR_TEXT}</Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
