import { ArrowLeftRight, FunctionSquare, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DatasetColumn } from '@/lib/api'
import { variableDeleteEndpoint, type VariableRulesRefusal } from '@/lib/dataset-constants'
import { swapNameLabelValues, swapNameLabelWords } from '@/lib/dataset-column-label'

/**
 * The per-variable controls that used to live only in the Data view's column
 * header popover (design note Decision E — the popover thinning).
 *
 * 🔴 **Why this exists before the removal, and not after.** E4's planned slab
 * was to THIN the popover, and the pre-implementation review found it blocked:
 * five affordances — demographic subtype, swap name↔label, Column details,
 * Edit formula, Recompute — had no home on the Variables view, so removing them
 * would have deleted features rather than relocated them. Homes first, removal
 * second.
 *
 * ⚠️ **The five are NOT one class, and that decided what moves.** Four are
 * property FORMS — they change what the variable IS, which is this view's whole
 * subject. `Recompute` is a VERB acting on state the Data view RENDERS (the
 * amber pulse on a stale computed column, `DatasetGridComponents.tsx`), so
 * sending a researcher to another screen to act on what is in front of them
 * would be worse than the duplication. Forms move; the verb stays on both.
 *
 * ⚠️ **This component DISPLAYS and DELEGATES; it owns no mutation.** The page
 * owns them, because two of these edits ride the undo stack and `useHistory`
 * lives there (E4). Keeping the markup here is what lets it be tested without
 * mounting ~1,900 lines behind six queries — the `definitionCard` pattern.
 */

// ── Demographic subtype ──────────────────────────────────────────────────────

/** The subtypes `PATCH …/columns/{id}/subtype` accepts. `''` clears it. */
const DEMOGRAPHIC_SUBTYPES = [
  { value: 'role', label: 'Role' },
  { value: 'gender', label: 'Gender' },
  { value: 'race', label: 'Race' },
  { value: 'age', label: 'Age' },
  { value: 'other', label: 'Other' },
] as const

// ── The actions row ──────────────────────────────────────────────────────────

export function VariableActions({
  column,
  onSubtypeChange,
  onSwapNameLabel,
  onOpenDetails,
  onDelete,
}: {
  column: DatasetColumn
  onSubtypeChange: (columnId: number, subtype: string | null) => void
  onSwapNameLabel: (column: DatasetColumn) => void
  /** Manual columns only — see the gate below. */
  onOpenDetails: (column: DatasetColumn) => void
  /** Optional so a surface that has no delete flow wired simply doesn't offer
   *  it, rather than offering a button that does nothing (#812). */
  onDelete?: (column: DatasetColumn) => void
}) {
  const canSwap = swapNameLabelValues(column) !== null
  // #575: "Variable details" saves through the manual-only PATCH, which 403s on
  // an imported column. The popover had this gate and its two SIBLING surfaces
  // did not — the Data view's context menu offered it for `manual || imported`,
  // and the analysis ColumnPicker offered it with no source test at all, so it
  // failed for every column in a corpus with no manual ones. Both were thinned
  // rather than gated; this is now the single entry point, so the gate is here.
  const isManual = column.source === 'manual'

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      {column.column_type === 'demographic' && (
        <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
          <span>Subtype</span>
          {/* `|| null` and not `|| ''` — the endpoint distinguishes "no
              subtype" from a value, and an empty string would be stored as
              though it were one. */}
          <select
            value={column.demographic_subtype || ''}
            onChange={e => onSubtypeChange(column.id, e.target.value || null)}
            className="h-7 text-xs border border-mm-border-subtle rounded px-1.5 bg-mm-surface text-mm-text"
          >
            <option value="">No subtype</option>
            {DEMOGRAPHIC_SUBTYPES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      )}

      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1"
        disabled={!canSwap}
        onClick={() => onSwapNameLabel(column)}
        title="The short name is the machine identifier; the label is the question wording."
      >
        <ArrowLeftRight className="w-3 h-3" aria-hidden="true" />
        {swapNameLabelWords(column)}
      </Button>

      {isManual && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => onOpenDetails(column)}
        >
          <Settings2 className="w-3 h-3" aria-hidden="true" />
          Variable details...
        </Button>
      )}

      {/* #812 — the missing half of Decision B's asymmetry. This view can CREATE
          a variable (a derive, a computed column, a blank one) and had no way to
          remove one, so the first thing a researcher did after an experimental
          derive was leave the page they were working on.

          ⚠️ **Rendered only when something can actually delete it**, rather than
          greyed for everything else. The mode-disabled rule (#754) covers a
          control blocked by a state the researcher can CHANGE — an imported
          variable is not that: it is part of the file they brought in, there is
          no remedy on this screen, and 41 permanently-dead trash cans on an
          ordinary survey is noise that teaches nothing.

          ⚠️ **NOT on the properties grid's rows.** A per-row control costs a tab
          stop per row (#771/#785), and a destructive one is the worst thing to
          spend them on — Observations' keyboard tour of 13 clips meeting nothing
          but Delete is the measured precedent. */}
      {variableDeleteEndpoint(column) !== null && onDelete && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1 text-red-600 hover:text-red-700"
          onClick={() => onDelete(column)}
        >
          <Trash2 className="w-3 h-3" aria-hidden="true" />
          Delete variable…
        </Button>
      )}
    </div>
  )
}

// ── The computed-variable panel ──────────────────────────────────────────────

/**
 * A computed variable's definition IS its formula, and this is the only place
 * that says so.
 *
 * 🔴 **Found by DRIVING the page.** Before this, selecting a computed variable
 * here showed a seeded 25-row value-label editor, a missing-value tri-state and
 * a full rule editor — all three of which the backend 403s for
 * `source == 'computed'` — and said NOTHING about the formula or about the
 * column being stale. Three editors that cannot save, and the one fact that
 * defines the variable was absent.
 */
export function ComputedVariablePanel({
  column,
  onEditFormula,
  onRecompute,
  isRecomputing,
}: {
  column: DatasetColumn
  onEditFormula: (column: DatasetColumn) => void
  onRecompute: (column: DatasetColumn) => void
  isRecomputing: boolean
}) {
  return (
    <section className="mb-6" aria-labelledby="computed-variable-heading">
      {/* #810: one weight for every section lead on this view — matches
          `ColumnDictionaryEditor`'s heading and `ValueFrequenciesPanel`'s. */}
      <h3
        id="computed-variable-heading"
        className="text-sm font-semibold text-mm-text mb-2"
      >
        Formula
      </h3>
      <div className="border rounded-lg p-3 space-y-3">
        <code className="block text-xs font-mono text-mm-text break-all">
          {column.expression || <span className="text-mm-text-faint italic">No formula recorded</span>}
        </code>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onEditFormula(column)}
          >
            <FunctionSquare className="w-3 h-3" aria-hidden="true" />
            Edit formula...
          </Button>

          {/* The state, then the verb for it. A stale computed column is
              recomputable from the Data view too (that is where the amber
              pulse marking it lives) — this is parity, not the only way in. */}
          {column.stale ? (
            <>
              <span className="text-xs text-amber-600">
                Out of date — a variable it depends on has changed.
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={isRecomputing}
                onClick={() => onRecompute(column)}
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                {isRecomputing ? 'Recomputing...' : 'Recompute'}
              </Button>
            </>
          ) : (
            <span className="text-xs text-mm-text-faint">Up to date.</span>
          )}
        </div>
      </div>
    </section>
  )
}

// ── Why a variable carries no dictionary or rules ────────────────────────────

/**
 * The honest replacement for three editors that could not save.
 *
 * ⚠️ **The two refusals need different words.** A computed variable is defined
 * by its formula — labelling its output is meaningless, not merely disallowed.
 * An open-text or identifier column has no codes to label. Collapsing both into
 * "not available for this column" would teach the researcher nothing, and the
 * layer separation this whole arc is about is exactly what the first sentence
 * has to convey.
 */
export function VariableRulesUnavailable({
  refusal,
  columnType,
}: {
  refusal: VariableRulesRefusal
  columnType: string
}) {
  return (
    <div
      className="mb-4 p-4 rounded-lg border border-dashed border-mm-border-medium text-center"
      role="note"
    >
      {refusal === 'computed' ? (
        <>
          <p className="text-sm text-mm-text-faint">
            Value labels, missing-value rules and recodes apply to collected variables.
          </p>
          <p className="text-xs text-mm-text-faint mt-1">
            This variable is derived from its formula, so its values are recomputed rather
            than declared. Edit the formula above to change what it holds.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-mm-text-faint">
            Value labels, missing-value rules and recodes are not available for {columnType}{' '}
            variables.
          </p>
          <p className="text-xs text-mm-text-faint mt-1">
            Change the variable type above if this was misdetected.
          </p>
        </>
      )}
    </div>
  )
}
