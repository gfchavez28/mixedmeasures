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
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, ExternalLink } from 'lucide-react'
import { recodeApi, type DatasetColumn } from '@/lib/api'
import { blockingReversePrimary } from '@/lib/value-labels-guard'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
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

/**
 * Toast copy for values that became data again without a recoverable code
 * (#609d): capped at 5 + "+N more" (the AppendImport convention), count-aware
 * verb — the old string was unbounded and read "…values became data again but
 * has no code yet".
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure copy helper, unit-tested
export function describeRecoveredUnmapped(values: string[]): string {
  const shown = values.slice(0, 5).map(v => `"${v}"`).join(', ')
  const more = values.length > 5 ? ` +${values.length - 5} more` : ''
  return values.length === 1
    ? `${shown} became data again but has no code yet.`
    : `${shown}${more} became data again but have no codes yet.`
}

/** `null` = keep the column's current type (#592 C5) — the dialog must not
 *  force a type just because someone edited labels. Sent as omitted. */
type TypeChoice = 'ordinal' | 'nominal' | null

/** Above this many distinct observed values the column is continuous, not a
 *  scale, so seeding a blank-label row per value is noise. Mirrors the import
 *  preview's `dataset_import.VALUE_LABEL_SEED_MAX_CODES`. */
const SEED_MAX_CODES = 30

export function ValueLabelsDialog({
  column,
  open,
  projectId,
  datasetId,
  onClose,
}: {
  column: DatasetColumn
  open: boolean
  projectId: number
  datasetId: number
  onClose: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [missingRows, setMissingRows] = useState<MissingRow[]>([])
  const [missingMode, setMissingMode] = useState<MissingMode>('automatic')
  const [colType, setColType] = useState<TypeChoice>(null)
  const [saving, setSaving] = useState(false)

  // #585: relabelling a reverse-scored column would rewrite every response to
  // its opposite, so the backend refuses it. NARROWED (#592 §I.4): it blocks the
  // LABELS arm only. Missing rules key on the cell's TEXT, never on
  // value_numeric, so declaring "99 = Refused" on a reverse-scored column is
  // perfectly safe — and a blanket block would leave reverse-scored columns as
  // the only ones that can never receive a missing declaration.
  const labelsBlocked = useMemo(() => blockingReversePrimary(column), [column])

  // SAME key family as RecodeWorkbench/SubgroupFilterPanel — they call the
  // same endpoint, and a private `['frequencies', …]` copy meant invalidating
  // one cache left the other stale (#608).
  const { data: freqData, isLoading } = useQuery({
    queryKey: ['column-frequencies', projectId, datasetId, column.id],
    queryFn: () => recodeApi.getFrequencies(projectId, datasetId, column.id),
    enabled: open,
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
  useEffect(() => {
    if (!open) {
      seedPhase.current = 'idle'
      return
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
  }, [open, existing, freqData, column.missing_values, labelsBlocked])

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
    try {
      // Missing FIRST: it is the call that can be refused, and landing it before
      // the labels means a failure never leaves labels half-applied. The two
      // commute since 3b, so the order is a safety choice, not a correctness one.
      if (declaredChanged) {
        const res = await recodeApi.setMissingValues(
          projectId, datasetId, column.id, missingValidation.rules,
        )
        if (res.recovered_unmapped.length) {
          notes.push(describeRecoveredUnmapped(res.recovered_unmapped))
        }
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
      }

      if (notes.length) toast.warning(`Applied — ${notes.join(' ')}`)
      else toast.success('Column updated.')
      onClose()
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
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Value labels &amp; missing — {column.column_name || column.column_text}
          </DialogTitle>
          <DialogDescription>
            Give each numeric code a label, and say which responses aren’t real
            answers. Charts and tables show the label; statistics use the code and
            skip anything you declare missing.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 flex justify-center text-mm-text-muted">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <section aria-labelledby="vl-heading" data-testid="value-labels-section">
              <h3 id="vl-heading"
                  className="text-xs font-semibold text-mm-text-secondary mb-1">
                Value labels
              </h3>
              {labelsBlocked ? (
                // Rejection, not concealment — name the recode and the way out.
                <div
                  role="note"
                  data-testid="value-labels-reverse-block"
                  className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded p-2 border border-amber-200 dark:border-amber-900/50"
                >
                  <strong>{labelsBlocked.name}</strong> reverse-scores this column, so the
                  number stored for each response is a reflected score, not the
                  response&rsquo;s own code. Labelling here would give every response its{' '}
                  <em>opposite</em> label &mdash; &ldquo;Never&rdquo; would become
                  &ldquo;Always&rdquo;.
                  <span className="block mt-1.5">
                    To label it: remove the reverse recode (or make another definition
                    primary), apply the labels, then reverse-score it again.{' '}
                    <strong>Missing values below are unaffected</strong> &mdash; they key on the
                    response itself, not on the score.
                  </span>
                  <Button
                    variant="outline" size="sm" className="mt-2"
                    onClick={() => {
                      navigate(`/projects/${projectId}/datasets/${datasetId}/recode?column=${column.id}`)
                      onClose()
                    }}
                  >
                    Open Recode Workbench
                    <ExternalLink className="w-3 h-3 ml-1" aria-hidden="true" />
                  </Button>
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
              <h3 id="mv-heading"
                  className="text-xs font-semibold text-mm-text-secondary mb-1">
                Missing values
              </h3>
              <p className="text-xs text-mm-text-faint mb-1.5">
                These stay visible in the grid and are left out of every statistic.
              </p>
              <MissingValuesSection
                mode={missingMode}
                onModeChange={setMissingMode}
                rows={missingRows}
                onRowsChange={setMissingRows}
                validation={missingValidation}
              />
            </section>

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={!canApply || saving}>
                {saving ? 'Applying…' : 'Apply'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
