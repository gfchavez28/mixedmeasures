/**
 * Column dictionary editor (#576/#577 value labels + #592 missing values).
 *
 * TWO SECTIONS, deliberately (#592 slab 4, plan §K.2 — this revises the
 * originally-locked "per-row missing checkbox" design):
 *
 *  - VALUE LABELS  — a code→label dictionary. Substitutes labels into the cells
 *    while keeping the numeric codes, so charts and tables read well and means,
 *    correlations and scale scores keep working on the codes.
 *  - MISSING VALUES — which responses are not real answers. They stay visible in
 *    the grid and are excluded from every statistic (SPSS user-missing).
 *
 * They are separate because they are separate questions, exactly as in SPSS's
 * Variable View (Values / Missing) and jamovi's setup panel:
 *  - A range (`-99 THRU -1` on a continuous `age`) is not a code with a label,
 *    so it has no row to tick a checkbox on. Nesting missing inside labels
 *    cannot express it at all.
 *  - Declaring a value missing must NOT decide what kind of variable this is
 *    (#592 C5). The type picker belongs to the labels section; the missing
 *    section never touches it.
 *
 * They also hit different endpoints, and the order is safe either way: since
 * slab 3b, declaring and labelling commute (declare substitutes a labelled
 * rule's label in and strips the code out of the scale; un-declare reverts).
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { describeRecoveredUnmapped, describeMissingValueChanges, describeStaledDefinitions, describeUnmatchedRules, bulkMissingOutcome } from '@/lib/missing-values-copy'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { recodeApi, datasetsApi, type DatasetColumn } from '@/lib/api'
import { valueLabelBlocker } from '@/lib/value-labels-guard'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'
import { VALUE_LABEL_SEED_MAX_CODES } from '@/lib/dataset-constants'
import { Button } from '@/components/ui/button'
import { compareValueLabels } from '@/lib/chart-data'
import {
  ValueLabelRows,
  buildValueLabelPayload,
  labelRowsTouched,
  type ValueLabelRow as Row,
} from '@/components/ValueLabelRows'
import {
  MissingValuesSection,
  buildMissingPayload,
  deriveMissingMode,
  missingRulesEqual,
  rulesToRows,
  type MissingMode,
  type MissingRow,
} from '@/components/MissingValueRows'

// Re-export so existing importers (and ValueLabelsDialog.test.tsx) keep working.
// eslint-disable-next-line react-refresh/only-export-components -- back-compat re-export
export { buildValueLabelPayload }
export type { ValueLabelValidation } from '@/components/ValueLabelRows'



/** `null` = keep the column's current type (#592 C5) — the dialog must not
 *  force a type just because someone edited labels. Sent as omitted. */
type TypeChoice = 'ordinal' | 'nominal' | null

/** Above this many distinct observed values the column is continuous, not a
 *  scale, so seeding a blank-label row per value is noise.
 *  ⚠️ Hoisted to `lib/dataset-constants.ts` (#809) — the frequency panel's
 *  collapse threshold asks the identical question, and two numbers answering it
 *  would drift. Re-aliased here so the seeding code below reads unchanged. */
const SEED_MAX_CODES = VALUE_LABEL_SEED_MAX_CODES

export default function ColumnDictionaryEditor({
  column,
  projectId,
  datasetId,
}: {
  column: DatasetColumn
  projectId: number
  datasetId: number
}) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Row[]>([])
  const [missingRows, setMissingRows] = useState<MissingRow[]>([])
  const [missingMode, setMissingMode] = useState<MissingMode>('automatic')
  /**
   * #798: apply this vocabulary to every other eligible column too.
   *
   * Real survey data carries ONE sentinel set across every variable — GSS marks
   * missing with five `.x:` codes across all 41 of its columns, ~42% of cells —
   * while this dialog is column-at-a-time. Declaring them by hand is 41 dialogs
   * x 5 rules. Off by default: applying to forty columns is not something to do
   * by accident.
   */
  const [applyToAll, setApplyToAll] = useState(false)

  /**
   * The columns a bulk apply would reach. Same eligibility the server enforces
   * (it SKIPS ineligible columns rather than refusing the request), mirrored
   * here only so the offer states an honest count — the server remains the
   * authority, and its per-column skips are surfaced in the result.
   */
  const { data: siblingColumns } = useQuery({
    queryKey: ['dataset-columns', projectId, datasetId],
    queryFn: () => datasetsApi.listColumns(projectId, datasetId),
    staleTime: 60_000,
  })
  const bulkTargetIds = useMemo(() => {
    const all = (siblingColumns as DatasetColumn[] | undefined) ?? []
    return all
      .filter(c =>
        c.source !== 'computed' &&
        c.column_type !== 'open_text' &&
        c.column_type !== 'identifier')
      .map(c => c.id)
  }, [siblingColumns])
  const [colType, setColType] = useState<TypeChoice>(null)
  const [saving, setSaving] = useState(false)

  // #585/#793: relabelling a column whose primary recode stores something other
  // than the response's own code would rewrite every response to a DIFFERENT
  // answer, so the backend refuses it. NARROWED (#592 §I.4): it blocks the
  // LABELS arm only. Missing rules key on the cell's TEXT, never on
  // value_numeric, so declaring "99 = Refused" on such a column is perfectly
  // safe — and a blanket block would leave exactly these columns as the only
  // ones that can never receive a missing declaration.
  const labelsBlocked = useMemo(() => valueLabelBlocker(column), [column])

  // SAME key family as RecodeWorkbench/SubgroupFilterPanel — they call the
  // same endpoint, and a private `['frequencies', …]` copy meant invalidating
  // one cache left the other stale (#608).
  const { data: freqData, isLoading } = useQuery({
    queryKey: ['column-frequencies', projectId, datasetId, column.id],
    queryFn: () => recodeApi.getFrequencies(projectId, datasetId, column.id),
  })

  const existing = useMemo(() => {
    const labels = column.scale_labels || []
    const values = column.scale_values || []
    if (labels.length && labels.length === values.length) {
      return labels.map((label, i) => ({ code: String(values[i]), label }))
    }
    return null
  }, [column.scale_labels, column.scale_values])

  // Seed on open. The two sections seed from their OWN sources: labels from the
  // scale dictionary (or the observed codes), missing from the declaration.
  // Reading declared rows out of `existing` could never work — a declared code
  // is stripped from the scale (C4) and filtered out of the frequencies by
  // `is_na`, so it is absent from both label sources by design.
  //
  // Seeding is a once-per-open handoff, NOT a subscription (#613): `freqData`
  // gets a new identity on every refetch (a >60s window refocus is enough), and
  // re-running the seed then would silently wipe whatever the researcher has
  // typed. The phase ref lets the label seed wait for the FIRST frequencies
  // response without ever re-seeding after it. Re-running the open-transition
  // seed itself is idempotent (StrictMode-safe — nothing is consumed).
  const seedPhase = useRef<'idle' | 'awaiting-freq' | 'done'>('idle')
  /**
   * 🔴 **The seed resets on the column's ID, NEVER on the `column` object.**
   *
   * Inline, "once per open" becomes "once per variable" — and `column` is a new
   * object identity on every `listColumns` refetch, which an Apply on this very
   * editor triggers. Keying the reset on the object would re-seed after every
   * save and after any background refetch, wiping whatever the researcher had
   * typed: #613 reintroduced by the move that was meant to be behaviour-neutral.
   */
  const seededFor = useRef<number | null>(null)
  useEffect(() => {
    if (seededFor.current !== column.id) {
      seededFor.current = column.id
      seedPhase.current = 'idle'
    }
    if (seedPhase.current === 'idle') {
      setMissingRows(rulesToRows(column.missing_values))
      setMissingMode(deriveMissingMode(column.missing_values))
      // Keep the current type unless the researcher picks one.
      setColType(null)
      // #604: when labels are blocked, never seed label rows — the blocked arm
      // hides the row editor, so seeded (non-empty) labels made `labelsTouched`
      // true with no way to clear them, and Apply stayed disabled on exactly
      // the missing-only case the narrowed #585 guard exists to allow.
      if (labelsBlocked) {
        setRows([])
        seedPhase.current = 'done'
        return
      }
      if (existing && existing.length) {
        setRows(existing)
        seedPhase.current = 'done'
        return
      }
      seedPhase.current = 'awaiting-freq'
    }
    if (seedPhase.current === 'awaiting-freq' && freqData) {
      const codes = freqData.frequencies
        .filter(f => !f.is_na && f.value_text.trim() !== '')
        .map(f => f.value_text.trim())
      const seen = new Set<string>()
      const unique = codes.filter(c => (seen.has(c) ? false : seen.add(c)))
      // Only seed when the observed values plausibly ARE a scale. A continuous
      // column (a test score, an age) has dozens of distinct values and seeding
      // one blank-label row per value is noise, not a starting point — the
      // researcher opened this to declare a missing value, not to name 42 codes.
      // Mirrors the import preview's VALUE_LABEL_SEED_MAX_CODES (30).
      if (unique.length > SEED_MAX_CODES) {
        setRows([])
      } else {
        unique.sort(compareValueLabels)
        setRows(unique.map(code => ({ code, label: '' })))
      }
      seedPhase.current = 'done'
    }
  }, [column.id, existing, freqData, column.missing_values, labelsBlocked])

  const validation = useMemo(() => buildValueLabelPayload(rows), [rows])
  const missingValidation = useMemo(
    () => buildMissingPayload(missingMode, missingRows),
    [missingMode, missingRows],
  )

  // "Touched" means the researcher typed a LABEL — never that a code exists.
  // Codes are SEEDED from the observed values, so keying on them made every
  // seeded column read as touched, which failed label validation ("Every code
  // needs a label") and disabled Apply — locking out the missing-only case that
  // is the whole reason these are two sections. Found by driving the dialog on a
  // real numeric column; both validators were green in isolation.
  //
  // #637: now imported rather than re-inlined. The identical mistake was still
  // live one component down, where the error announcement kept keying on
  // "a code exists" — so the alert fired on mount while Apply, correctly, stayed
  // enabled. One predicate, one meaning, both surfaces.
  const labelsTouched = labelRowsTouched(rows)
  const labelsUsable = !labelsBlocked && labelsTouched && validation.ok
  const canApply = missingValidation.ok && (!labelsTouched || labelsUsable)

  // Field-wise, not JSON.stringify — key order / float format on the wire must
  // never produce a phantom PUT (#609).
  const declaredChanged = useMemo(
    () => !missingRulesEqual(column.missing_values, missingValidation.rules),
    [column.missing_values, missingValidation.rules],
  )

  const save = async () => {
    if (!canApply) return
    setSaving(true)
    const notes: string[] = []
    let changes: string | null = null
    try {
      // Missing FIRST: it is the call that can be refused, and landing it before
      // the labels means a failure never leaves labels half-applied. The two
      // commute since 3b, so the order is a safety choice, not a correctness one.
      if (declaredChanged) {
        let res
        if (applyToAll && bulkTargetIds.length > 1) {
          const bulk = await recodeApi.bulkSetMissingValues(
            projectId, datasetId, bulkTargetIds, missingValidation.rules,
          )
          // 🔴 THE DISCLOSURE DESCRIBES THE OPERATION, NOT THIS COLUMN (#823b).
          // It used to pick this column's own row out of `applied` and report
          // that — so a bulk declaration across 41 GSS variables announced
          // "32276 cells no longer counted in analysis" when the true figure
          // was 1,099,939. A 34x understatement, on the largest silent data
          // mutation in the workflow.
          //
          // ⚠️ `nulled_rows` is the SERVER's own total (`nulled_rows_total`,
          // which had been on the wire and read by nobody). The other three
          // are summed here because the server sends no totals for them;
          // `ColumnDictionaryEditor.test.tsx` pins the client sum of
          // `applied[].nulled_rows` against the server's total, so the two
          // cannot drift into disagreeing about the same operation.
          res = bulkMissingOutcome(bulk, column.id, missingValidation.rules)
          notes.push(
            `Applied to ${bulk.applied.length} column${bulk.applied.length === 1 ? '' : 's'}.`,
          )
          for (const s of bulk.skipped) {
            notes.push(`${s.column_label}: ${s.reason}`)
          }
        } else {
          res = await recodeApi.setMissingValues(
            projectId, datasetId, column.id, missingValidation.rules,
          )
        }
        if (res.recovered_unmapped.length) {
          notes.push(describeRecoveredUnmapped(res.recovered_unmapped))
        }
        // #823(a): a rule that matched nothing is accepted with the same
        // "Column updated." as one that reclassified 30,000 cells. This is a
        // NOTE, not a change-disclosure — it names something the researcher
        // has to go and fix.
        const unmatched = describeUnmatchedRules(
          res.unmatched_rules,
          applyToAll && bulkTargetIds.length > 1 ? 'all-columns' : 'column',
        )
        if (unmatched) notes.push(unmatched)
        // #680: what the declaration DID to stored cells. Kept separate from
        // `notes` on purpose — those demand action, this is disclosure, and
        // folding them together would file a plain report under "warning".
        changes = describeMissingValueChanges(res)
      }
      if (labelsUsable && validation.payload) {
        const res = await recodeApi.applyValueLabels(
          projectId, datasetId, column.id,
          // C5: omit column_type entirely unless the researcher chose one.
          { labels: validation.payload, ...(colType ? { column_type: colType } : {}) },
        )
        if (res.unlabeled_codes?.length) {
          notes.push(`Codes ${res.unlabeled_codes.join(', ')} have no label yet.`)
        }
        if (res.missing_skipped?.length) {
          // Never absorb this silently — the researcher typed a label and it
          // did not land. "Treated as", not "declared": since #605 this also
          // fires when an UNDECLARED column's label matches the recognized
          // non-response defaults (e.g. "Not applicable").
          notes.push(
            `${res.missing_skipped.join(', ')} is treated as missing, so its label was not added to the scale.`,
          )
        }
        // #584: labelling re-keys every cell, so any recode still keyed on the
        // old codes now maps nothing. Copy lives in the shared module so it is
        // unit-tested and cannot be re-typed at a second call site.
        const staleNote = describeStaledDefinitions(res.staled_definitions ?? [])
        if (staleNote) notes.push(staleNote)
      }

      // #680: a silent data mutation is always disclosed. `notes` (action
      // needed) still decides the SEVERITY; `changes` only ever adds detail.
      // The longer duration is deliberate — this is a report about the
      // researcher's data, and the default 4s is not enough to read a sentence
      // and decide whether it was what they meant.
      if (notes.length) {
        toast.warning(`Applied — ${notes.join(' ')}${changes ? ` ${changes}` : ''}`, { duration: 10_000 })
      } else if (changes) {
        toast.success(`Column updated — ${changes}`, { duration: 8_000 })
      } else {
        toast.success('Column updated.')
      }
      // Nothing to close — re-seed so the editor shows what was actually
      // stored, which is also how the researcher SEES the demote (#584's
      // staled-definitions note lands in the toast, and the rules list below is
      // on screen throughout). That visibility is what makes Decision E subsume
      // Decision A.
      seedPhase.current = 'idle'
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail
      toast.error(detail || 'Could not update this column. Please try again.')
    } finally {
      // In `finally`, not after both calls (#608): a labels-arm failure after a
      // successful missing-arm declare must still refresh every reader — the
      // dialog stays open over a grid that would otherwise show pre-declare
      // data for the staleTime window.
      invalidateColumnDictionary(qc, projectId, datasetId)
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="cd-heading" data-testid="column-dictionary-editor">
      <h3 id="cd-heading" className="text-sm font-semibold text-mm-text">
        Value labels &amp; missing values
      </h3>
      <p className="text-xs text-mm-text-muted mt-0.5 mb-3">
        Give each numeric code a label, and say which responses aren’t real
        answers. Charts and tables show the label; statistics use the code and
        skip anything you declare missing.
      </p>

        {isLoading ? (
          <div className="py-8 flex justify-center text-mm-text-muted">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <section aria-labelledby="vl-heading" data-testid="value-labels-section">
              {/* h4, not h3 — this section is INSIDE the one `cd-heading`
                  labels, and three flat h3s made a reader navigating by heading
                  hear the container and its two children as siblings. The id is
                  unchanged: it is the `aria-labelledby` target. */}
              <h4 id="vl-heading"
                  className="text-xs font-semibold text-mm-text-secondary mb-1">
                Value labels
              </h4>
              {labelsBlocked ? (
                // Rejection, not concealment — name the recode and the way out.
                <div
                  role="note"
                  data-testid="value-labels-reverse-block"
                  className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded p-2 border border-amber-200 dark:border-amber-900/50"
                >
                  {labelsBlocked.kind === 'reverse' ? (
                    <>
                      <strong>{labelsBlocked.definition.name}</strong> reverse-scores this
                      column, so the number stored for each response is a reflected
                      score, not the response&rsquo;s own code. Labelling here would give
                      every response its <em>opposite</em> label &mdash;
                      &ldquo;Never&rdquo; would become &ldquo;Always&rdquo;.
                    </>
                  ) : (
                    <>
                      <strong>{labelsBlocked.definition.name}</strong> re-maps this
                      column&rsquo;s codes, so the number stored for each response is that
                      recode&rsquo;s result, not the response&rsquo;s own code. Labelling
                      here would record every participant as having given a{' '}
                      <em>different</em> answer &mdash; and the result would look
                      consistent afterwards, so nothing would appear wrong.
                    </>
                  )}
                  <span className="block mt-1.5">
                    To label it: remove{' '}
                    {labelsBlocked.kind === 'reverse' ? 'the reverse recode' : 'that recode'}{' '}
                    (or make another definition primary), apply the labels, then
                    re-apply it.{' '}
                    <strong>Missing values below are unaffected</strong> &mdash; they key on the
                    response itself, not on the score.
                  </span>
                  {/* No link out: the rules for this variable are listed on
                      this page, below. Sending the researcher somewhere to see
                      what is already on screen was an artefact of this editor
                      having been a modal. */}
                  <span className="block mt-1.5 font-medium">
                    Its recodes are listed below.
                  </span>
                </div>
              ) : (
                <ValueLabelRows
                  rows={rows}
                  onRowsChange={setRows}
                  // A null choice means "keep current type"; the toggle shows
                  // the column's own type until the researcher changes it.
                  colType={colType ?? (column.column_type === 'nominal' ? 'nominal' : 'ordinal')}
                  onColTypeChange={setColType}
                  validation={validation}
                  showTypeToggle={colType !== null || column.column_type === 'ordinal' || column.column_type === 'nominal'}
                  // #637: stay silent until a label is typed. Here labels are
                  // OPTIONAL — arriving for the missing-values section alone is a
                  // legitimate reason to be in this dialog — so an error about
                  // unlabelled seeded codes is not yet true. Once a label exists,
                  // `canApply` disables Apply for the same reason this shows, so
                  // the message and the blocked button always agree.
                  showError={labelsTouched}
                />
              )}
            </section>

            <section aria-labelledby="mv-heading" data-testid="missing-values-section">
              <h4 id="mv-heading"
                  className="text-xs font-semibold text-mm-text-secondary mb-1">
                Missing values
              </h4>
              <p className="text-xs text-mm-text-faint mb-1.5">
                These stay visible in the grid and are left out of every statistic.
              </p>
              <MissingValuesSection
                mode={missingMode}
                onModeChange={setMissingMode}
                rows={missingRows}
                onRowsChange={setMissingRows}
                validation={missingValidation}
                // #823(a): the picker's whole point is that the stored text
                // reaches the rule verbatim. `freqData` is ALREADY here — it
                // seeds the label rows — and shares its query key with the
                // Variables view's frequency panel, so this costs no request.
                observedValues={freqData?.frequencies ?? []}
              />
              {/* #798: one sentinel vocabulary across every variable is how real
                  survey data arrives — GSS's five `.x:` codes span all 41 of its
                  columns. Off by default: applying to forty columns at once is not
                  something to do by accident. */}
              {missingMode !== 'automatic' && bulkTargetIds.length > 1 && (
                <label className="flex items-start gap-2 mt-2 text-xs text-mm-text-secondary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={applyToAll}
                    onChange={e => setApplyToAll(e.target.checked)}
                  />
                  <span>
                    Also apply these missing values to the other{' '}
                    <strong className="font-mono tabular-nums">{bulkTargetIds.length - 1}</strong>{' '}
                    columns in this dataset. Any column where a label would be ambiguous is
                    skipped and named.
                  </span>
                </label>
              )}
            </section>

            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={!canApply || saving}>
                {saving ? 'Applying…' : 'Apply'}
              </Button>
            </div>
          </div>
        )}
    </section>
  )
}
