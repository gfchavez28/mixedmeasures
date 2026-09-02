import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router'
import { FOCUS_RING, SELECTED_ROW, SELECTED_SEGMENT, SELECTED_TINT } from '@/lib/selection'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { toast } from 'sonner'
import { Star, WandSparkles, Copy, Plus, Trash2, ArrowUpDown, ChevronDown, ChevronRight, Link2, TriangleAlert, Undo2, Redo2 } from 'lucide-react'
import {
  datasetsApi,
  recodeApi,
  type DatasetColumn,
  type RecodeDefinition,
  type ValueFrequency,
  type RederivePlanItem,
} from '@/lib/api'
import { columnDisplayLabel, swapNameLabelValues } from '@/lib/dataset-column-label'
import RederiveDependentsDialog from '@/components/RederiveDependentsDialog'
import DeriveVariableDialog from '@/components/DeriveVariableDialog'
import AddVariableMenu from '@/components/AddVariableMenu'
import PickRuleToDeriveDialog from '@/components/PickRuleToDeriveDialog'
import ApplyRuleDialog from '@/components/ApplyRuleDialog'
import { variableViewPath } from '@/lib/dataset-routes'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, useDefaultLayout } from 'react-resizable-panels'
import { useCreateVariable } from '@/hooks/useCreateVariable'
import { useDeriveVariable } from '@/hooks/useDeriveVariable'
import { useDeleteVariable } from '@/hooks/useDeleteVariable'
import { DeleteVariableDialog } from '@/components/DeleteVariableDialog'
import { ValueFrequenciesPanel } from '@/components/ValueFrequenciesPanel'
import RekeyDefinitionsDialog from '@/components/RekeyDefinitionsDialog'
import { isSelectable as isRekeySelectable } from '@/lib/rekey-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { COLUMN_TYPES, TYPE_BADGE_CLASSES } from '@/lib/dataset-constants'
import { listboxKeyIntent } from '@/lib/listbox-keys'
import { TypeBadge } from '@/components/TypeBadge'
import { CopyToDialog } from '@/components/CopyToDialog'
import { CopyToEquivalentsDialog } from '@/components/CopyToEquivalentsDialog'
import { compareValueLabels } from '@/lib/chart-data'
import { reflectReverseValue, recodeMappingPayload } from '@/lib/recode-utils'
import RecodeRangeRows from '@/components/RecodeRangeRows'
import {
  buildRangePayload,
  rangesToRows,
  type RangeRow,
  type RecodeRange,
} from '@/lib/recode-ranges'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import type {
  RecodeDependentInfo,
  ManualColumnUpdate,
  ComputedColumnUpdate,
} from '@/lib/api/datasets'
import DatasetTabs from '@/components/DatasetTabs'
import VariablePropertiesGrid from '@/components/VariablePropertiesGrid'
import ColumnDictionaryEditor from '@/components/ColumnDictionaryEditor'
import { ColumnFormDialog } from '@/components/ColumnFormDialog'
import {
  VariableActions,
  ComputedVariablePanel,
  VariableRulesUnavailable,
} from '@/components/VariableActions'
import { variableRulesRefusal } from '@/lib/dataset-constants'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'
import { extractApiError } from '@/lib/api'
import { useHistory } from '@/hooks/useHistory'

// Column types where a numeric encoding (value_numeric) is meaningful — used to
// warn before a category_group primary clears it (#581).

/**
 * WHERE a seeded key set came from — the stated-basis idea (#690/#693) applied
 * to a draft mapping (#823h).
 *
 * The order a scale map is seeded in becomes the CODES the researcher accepts,
 * so "how was this ordered?" decides whether accepting the default is safe.
 * Priorities 1 and 2 carry an order somebody authored; priority 3 does not, and
 * for values that are not numbers it is alphabetical — which is a claim about
 * ordinality that the alphabet cannot supply.
 */
export type SeedBasis =
  | 'authored_rule'       // 1. the keys of an existing definition
  | 'declared_scale'      // 2. the column's declared scale_labels
  | 'observed_numeric'    // 3a. observed values, every one a number
  | 'observed_alphabetical' // 3b. observed values, ordered by the alphabet
  | 'none'

function seedLabels(
  existingDefinitions: RecodeDefinition[],
  selectedColumn: DatasetColumn | undefined,
  frequenciesData: { frequencies: ValueFrequency[] } | undefined,
): { labels: string[]; basis: SeedBasis } {
  // 1. Keys from first existing definition
  if (existingDefinitions.length > 0) {
    return { labels: Object.keys(existingDefinitions[0].mapping), basis: 'authored_rule' }
  }
  // 2. scale_labels from the column
  if (selectedColumn?.scale_labels && selectedColumn.scale_labels.length > 0) {
    return { labels: selectedColumn.scale_labels, basis: 'declared_scale' }
  }
  // 3. Non-NA frequency values, ordered by VALUE (#579). get_value_frequencies
  //    returns count-descending order; consuming that as a scale order assigned
  //    codes 1..N by response popularity (e.g. the modal answer got code 1).
  //    compareValueLabels is the #406 numeric-aware comparator. ONLY priority 3
  //    is sorted — priorities 1 & 2 already carry an authored/scale order that
  //    sorting would alphabetize.
  if (frequenciesData?.frequencies) {
    const vals = frequenciesData.frequencies
      .filter(f => !f.is_na)
      .map(f => f.value_text)
    if (vals.length > 0) {
      // ⚠️ `compareValueLabels` sorts anything that parses as a number
      // NUMERICALLY and everything else lexicographically — so this branch is
      // only meaningful as a scale order when every value is a number. With
      // text responses the result is the alphabet, and the alphabet knows
      // nothing about which end is "more" (#823h).
      const allNumeric = vals.every(v => v.trim() !== '' && Number.isFinite(Number(v)))
      return {
        labels: [...vals].sort(compareValueLabels),
        basis: allNumeric ? 'observed_numeric' : 'observed_alphabetical',
      }
    }
  }
  return { labels: [], basis: 'none' }
}

/** Labels for a draft mapping preview, in priority order. Exported for #579. */
// eslint-disable-next-line react-refresh/only-export-components
export function getLabels(
  existingDefinitions: RecodeDefinition[],
  selectedColumn: DatasetColumn | undefined,
  frequenciesData: { frequencies: ValueFrequency[] } | undefined,
): string[] {
  return seedLabels(existingDefinitions, selectedColumn, frequenciesData).labels
}

/** The same ladder, reporting only WHERE it stopped. Never a second ladder. */
// eslint-disable-next-line react-refresh/only-export-components
export function getSeedBasis(
  existingDefinitions: RecodeDefinition[],
  selectedColumn: DatasetColumn | undefined,
  frequenciesData: { frequencies: ValueFrequency[] } | undefined,
): SeedBasis {
  return seedLabels(existingDefinitions, selectedColumn, frequenciesData).basis
}

// ── Scale Map Editor ─────────────────────────────────────────────────────────

function ScaleMapEditor({
  mapping,
  excludeValues,
  onChange,
  rangeRows,
  onRangesChange,
  rangeBadRow,
  ownerLabel,
}: {
  mapping: Record<string, number | string>
  excludeValues: string[]
  onChange: (mapping: Record<string, number | string>, excludeValues: string[]) => void
  /** #823(d) — the band rows, alongside the per-response mapping above them. */
  rangeRows: RangeRow[]
  onRangesChange: (rows: RangeRow[]) => void
  rangeBadRow?: number
  /**
   * #823(f) — the rule this editor belongs to, for its controls' NAMES.
   *
   * ⚠️ Required, not optional: **several rule cards can be expanded at once**,
   * and each renders one of these editors. Without it a reader tabbing the page
   * meets two identically-named "Add a response" controls with nothing saying
   * which rule they act on — the #785 defect (N identical names) reappearing in
   * a surface that had never had names at all. A required prop is what makes a
   * new call site decide.
   */
  ownerLabel: string
}) {
  const [newLabel, setNewLabel] = useState('')
  const entries = Object.entries(mapping)

  const handleNumericChange = (label: string, value: string) => {
    const num = value === '' ? 0 : parseFloat(value)
    if (!isNaN(num)) {
      onChange({ ...mapping, [label]: num }, excludeValues)
    }
  }

  const handleExcludeToggle = (label: string) => {
    const isExcluded = excludeValues.includes(label)
    if (isExcluded) {
      onChange(mapping, excludeValues.filter(v => v !== label))
    } else {
      onChange(mapping, [...excludeValues, label])
    }
  }

  const handleFlip = () => {
    const numericEntries = entries.filter(([label]) => !excludeValues.includes(label))
    const values = numericEntries.map(([, v]) => Number(v))
    const max = Math.max(...values)
    const min = Math.min(...values)
    const flipped: Record<string, number | string> = {}
    for (const [label, val] of entries) {
      if (excludeValues.includes(label)) {
        flipped[label] = val
      } else {
        flipped[label] = max + min - Number(val)
      }
    }
    onChange(flipped, excludeValues)
  }

  const handleAddLabel = () => {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed in mapping) return
    const numericValues = entries.filter(([l]) => !excludeValues.includes(l)).map(([, v]) => Number(v))
    const nextVal = numericValues.length > 0 ? Math.max(...numericValues) + 1 : 1
    onChange({ ...mapping, [trimmed]: nextVal }, excludeValues)
    setNewLabel('')
  }

  const handleRemoveLabel = (label: string) => {
    const { [label]: _, ...rest } = mapping
    onChange(rest, excludeValues.filter(v => v !== label))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-mm-text-muted font-medium">Mapping</span>
        <Button variant="outline" size="sm" onClick={handleFlip} className="text-xs h-7">
          <ArrowUpDown className="w-3 h-3 mr-1" />
          Flip Values
        </Button>
      </div>
      <table className="w-full text-sm border-collapse">
        <caption className="sr-only">Scale mapping: each response label, its numeric value, and whether it is excluded.</caption>
        <thead>
          <tr className="text-xs text-mm-text-muted">
            <th scope="col" className="text-left py-1 pr-2">Label</th>
            <th scope="col" className="text-center py-1 px-2 w-20">Value</th>
            <th scope="col" className="text-center py-1 pl-2 w-16">Exclude</th>
            <th scope="col" className="w-8"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([label, val]) => {
            const isExcluded = excludeValues.includes(label)
            return (
              <tr key={label} className={`border-t ${isExcluded ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2 text-mm-text">{label}</td>
                <td className="py-1.5 px-2">
                  <Input
                    type="number"
                    value={isExcluded ? '' : val}
                    onChange={(e) => handleNumericChange(label, e.target.value)}
                    disabled={isExcluded}
                    aria-label={`Value for ${label}`}
                    className="h-7 text-center text-sm bg-mm-surface"
                  />
                </td>
                <td className="py-1.5 pl-2 text-center">
                  <Checkbox
                    checked={isExcluded}
                    onCheckedChange={() => handleExcludeToggle(label)}
                    aria-label={`Exclude ${label} from this rule`}
                  />
                </td>
                <td className="py-1.5 pl-1">
                  <button
                    onClick={() => handleRemoveLabel(label)}
                    className="text-mm-text-faint hover:text-red-500 transition-colors"
                    aria-label={`Remove ${label}`}
                    title={`Remove ${label}`}
                  >
                    <Trash2 className="w-3 h-3" aria-hidden />
                  </button>
                </td>
              </tr>
            )
          })}
          <tr className="border-t">
            <td colSpan={4} className="py-1.5">
              <div className="flex items-center gap-1">
                {/* #823(f) — a PLACEHOLDER is not a name. It satisfies axe
                    (which accepts it as a name source, so Lighthouse passed on
                    this field), but the first character typed erases it —
                    #559's "a tooltip is not a name" one control over. The name
                    carries the RULE because several cards can be expanded at
                    once, and two identical names are the #785 defect. */}
                <Input
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel() } }}
                  placeholder="Add label (e.g. Not Applicable)..."
                  aria-label={`Add a response to ${ownerLabel}`}
                  className="h-7 text-sm flex-grow bg-mm-surface"
                />
                {/* #854(c) — an icon-only button needs a NAME. lucide marks
                    its svg `aria-hidden` by default, so this had no accessible
                    name at all, and it renders DISABLED (the input starts
                    empty) — so a reader met a bare, unavailable "button".
                    ⚠️ The entry reported ONE; both rule editors carry the
                    identical block. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAddLabel}
                  disabled={!newLabel.trim() || newLabel.trim() in mapping}
                  className="h-7 px-2 text-xs shrink-0"
                  aria-label={`Add response to ${ownerLabel}`}
                >
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <RecodeRangeRows
        rows={rangeRows}
        onChange={onRangesChange}
        numericOutput={true}
        badRow={rangeBadRow}
      />
    </div>
  )
}

// ── Category Group Editor ────────────────────────────────────────────────────

function CategoryGroupEditor({
  mapping,
  excludeValues,
  onChange,
  rangeRows,
  onRangesChange,
  rangeBadRow,
  ownerLabel,
}: {
  mapping: Record<string, number | string>
  excludeValues: string[]
  onChange: (mapping: Record<string, number | string>, excludeValues: string[]) => void
  /** #823(d) — the band rows. This is the type #830(j) singled out: "Category
   *  Group — the rule type literally named for grouping — has the same shape"
   *  of one row per distinct value. */
  rangeRows: RangeRow[]
  onRangesChange: (rows: RangeRow[]) => void
  rangeBadRow?: number
  /** #823(f) — the rule this editor belongs to; see `ScaleMapEditor`. */
  ownerLabel: string
}) {
  const [newLabel, setNewLabel] = useState('')
  const entries = Object.entries(mapping)

  const handleGroupChange = (label: string, group: string) => {
    onChange({ ...mapping, [label]: group }, excludeValues)
  }

  const handleExcludeToggle = (label: string) => {
    const isExcluded = excludeValues.includes(label)
    if (isExcluded) {
      onChange(mapping, excludeValues.filter(v => v !== label))
    } else {
      onChange(mapping, [...excludeValues, label])
    }
  }

  const handleAddLabel = () => {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed in mapping) return
    onChange({ ...mapping, [trimmed]: '' }, excludeValues)
    setNewLabel('')
  }

  const handleRemoveLabel = (label: string) => {
    const { [label]: _, ...rest } = mapping
    onChange(rest, excludeValues.filter(v => v !== label))
  }

  // Collect existing group names for autocomplete
  const existingGroups = [...new Set(entries.map(([, v]) => String(v)).filter(Boolean))]

  return (
    <div>
      <span className="text-xs text-mm-text-muted font-medium block mb-2">Group Mapping</span>
      <table className="w-full text-sm border-collapse">
        <caption className="sr-only">Category grouping: each response label and the group it is recoded into.</caption>
        <thead>
          <tr className="text-xs text-mm-text-muted">
            <th scope="col" className="text-left py-1 pr-2">Label</th>
            <th scope="col" className="text-left py-1 px-2">Group</th>
            <th scope="col" className="text-center py-1 pl-2 w-16">Exclude</th>
            <th scope="col" className="w-8"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([label, val]) => {
            const isExcluded = excludeValues.includes(label)
            return (
              <tr key={label} className={`border-t ${isExcluded ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2 text-mm-text">{label}</td>
                <td className="py-1.5 px-2">
                  <Input
                    value={isExcluded ? '' : String(val)}
                    onChange={(e) => handleGroupChange(label, e.target.value)}
                    disabled={isExcluded}
                    aria-label={`Group for ${label}`}
                    className="h-7 text-sm bg-mm-surface"
                    list={`groups-${label}`}
                    placeholder="Group name..."
                  />
                  <datalist id={`groups-${label}`}>
                    {existingGroups.map(g => <option key={g} value={g} />)}
                  </datalist>
                </td>
                <td className="py-1.5 pl-2 text-center">
                  <Checkbox
                    checked={isExcluded}
                    onCheckedChange={() => handleExcludeToggle(label)}
                    aria-label={`Exclude ${label} from this rule`}
                  />
                </td>
                <td className="py-1.5 pl-1">
                  <button
                    onClick={() => handleRemoveLabel(label)}
                    className="text-mm-text-faint hover:text-red-500 transition-colors"
                    aria-label={`Remove ${label}`}
                    title={`Remove ${label}`}
                  >
                    <Trash2 className="w-3 h-3" aria-hidden />
                  </button>
                </td>
              </tr>
            )
          })}
          <tr className="border-t">
            <td colSpan={4} className="py-1.5">
              <div className="flex items-center gap-1">
                {/* #823(f) — a PLACEHOLDER is not a name. It satisfies axe
                    (which accepts it as a name source, so Lighthouse passed on
                    this field), but the first character typed erases it —
                    #559's "a tooltip is not a name" one control over. The name
                    carries the RULE because several cards can be expanded at
                    once, and two identical names are the #785 defect. */}
                <Input
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel() } }}
                  placeholder="Add label (e.g. Not Applicable)..."
                  aria-label={`Add a response to ${ownerLabel}`}
                  className="h-7 text-sm flex-grow bg-mm-surface"
                />
                {/* #854(c) — an icon-only button needs a NAME. lucide marks
                    its svg `aria-hidden` by default, so this had no accessible
                    name at all, and it renders DISABLED (the input starts
                    empty) — so a reader met a bare, unavailable "button".
                    ⚠️ The entry reported ONE; both rule editors carry the
                    identical block. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAddLabel}
                  disabled={!newLabel.trim() || newLabel.trim() in mapping}
                  className="h-7 px-2 text-xs shrink-0"
                  aria-label={`Add response to ${ownerLabel}`}
                >
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <RecodeRangeRows
        rows={rangeRows}
        onChange={onRangesChange}
        numericOutput={false}
        badRow={rangeBadRow}
      />
    </div>
  )
}

// ── Reverse Editor ───────────────────────────────────────────────────────────

/** Exported for #602's display-don't-derive test.
 *
 * No `react-refresh/only-export-components` disable needed, unlike `getLabels`
 * above: that rule objects to exporting a NON-component beside components, and
 * this IS one. The directive was there briefly and lint reported it as unused —
 * which is the check doing its job. */
export function ReverseEditor({
  sourceDefinitionId,
  definitions,
  mapping,
  serverOffset,
}: {
  sourceDefinitionId: number | null
  definitions: RecodeDefinition[]
  mapping: Record<string, number | string>
  /**
   * #602: the definition's own `reverse_offset` when this is a SAVED def. Omit
   * for a DRAFT — there is no saved row yet, so the offset comes from the
   * source, whose mapping the draft copies verbatim.
   */
  serverOffset?: number | null
}) {
  const sourceDef = definitions.find(d => d.id === sourceDefinitionId)

  if (!sourceDef) {
    return (
      <div role="alert" className="text-sm text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded p-3">
        Source definition not found or deleted.
      </div>
    )
  }

  // #578: the mapping now holds the source's FORWARD codes; the reversed SCORE
  // (what lands in value_numeric) is the reflection about the scale midpoint.
  // Show both so the researcher sees exactly what each response will score.
  //
  // #602: DISPLAY the server's offset, never re-derive it. A local
  // `min + max` cannot see the null set — the recognized-N/A rule and the
  // column's declaration both live server-side — so on a mapping containing a
  // missing key this preview said "Never → 99" while saving produced 5. For a
  // draft the number comes from the SOURCE's row, since the draft's mapping is
  // that source's mapping. `??` (not `||`) throughout: 0 is a real offset for a
  // symmetric scale, and `null` means "no numeric scale points", which
  // `reflectReverseValue` renders as no reflection at all.
  const offset = serverOffset ?? sourceDef.reverse_offset

  return (
    <div>
      <span className="text-xs text-mm-text-muted font-medium block mb-1">
        Reversed from: {sourceDef.name}
      </span>
      <p className="text-xs text-mm-text-faint mb-2">
        Scores are reflected about the scale midpoint (min + max − code), so the
        highest response scores lowest.
      </p>
      <table className="w-full text-sm border-collapse">
        <caption className="sr-only">Reverse scoring: each response label with its source code and reversed score.</caption>
        <thead>
          <tr className="text-xs text-mm-text-muted">
            <th scope="col" className="text-left py-1 pr-2">Label</th>
            <th scope="col" className="text-center py-1 px-2 w-24">Source code</th>
            <th scope="col" className="text-center py-1 px-2 w-24">Reversed score</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(mapping).map(([label, val]) => {
            const code = Number(val)
            // Same helper the grid's EditableCell uses, so the preview and the
            // cell can never disagree about one code's score.
            const reversed = Number.isFinite(code)
              ? reflectReverseValue(code, mapping, offset)
              : val
            return (
              <tr key={label} className="border-t">
                <td className="py-1.5 pr-2 text-mm-text">{label}</td>
                <td className="py-1.5 px-2 text-center text-mm-text-muted">{String(val)}</td>
                <td className="py-1.5 px-2 text-center text-mm-text font-medium">{String(reversed)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Definition Card ──────────────────────────────────────────────────────────

/**
 * One saved rule on a variable.
 *
 * Exported solely for `RecodeWorkbench.definitionCard.test.tsx` — the page it
 * lives in is ~1,700 lines behind six queries, and the rule under test (what
 * this row SAYS about whether it is in effect) is a property of the row.
 */
export function DefinitionCard({
  definition,
  allDefinitions,
  isExpanded,
  onToggleExpand,
  onSave,
  onDelete,
  onApply,
  onCopyTo,
  onRederive,
  onDerive,
  isSaving,
}: {
  definition: RecodeDefinition
  allDefinitions: RecodeDefinition[]
  isExpanded: boolean
  onToggleExpand: () => void
  onSave: (data: {
    name?: string
    mapping?: Record<string, number | string>
    exclude_values?: string[] | null
  }) => void
  onDelete: () => void
  onApply: () => void
  onCopyTo: () => void
  onRederive: () => void
  onDerive: () => void
  isSaving: boolean
}) {
  const [localName, setLocalName] = useState(definition.name)
  const [localMapping, setLocalMapping] = useState<Record<string, number | string>>(definition.mapping)
  const [localExcludes, setLocalExcludes] = useState<string[]>(definition.exclude_values || [])
  // #823(d) — the band rows, kept as STRINGS mid-edit like every other numeric
  // input in this file, and validated only on save.
  const [localRanges, setLocalRanges] = useState<RangeRow[]>(() => rangesToRows(definition.ranges))
  const [hasChanges, setHasChanges] = useState(false)

  // Reset local state when definition changes
  /* eslint-disable react-hooks/set-state-in-effect -- reset form fields on definition change */
  useEffect(() => {
    setLocalName(definition.name)
    setLocalMapping(definition.mapping)
    setLocalExcludes(definition.exclude_values || [])
    setLocalRanges(rangesToRows(definition.ranges))
    setHasChanges(false)
  }, [definition.id, definition.updated_at]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally reset only on id/timestamp change, not on every field
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleMappingChange = (mapping: Record<string, number | string>, excludes: string[]) => {
    setLocalMapping(mapping)
    setLocalExcludes(excludes)
    setHasChanges(true)
  }

  const handleRangesChange = (rows: RangeRow[]) => {
    setLocalRanges(rows)
    setHasChanges(true)
  }

  // Validated on every render so the Save button can refuse a malformed band
  // BEFORE the round trip — the researcher meets the message here rather than
  // as a 400. The backend re-validates regardless; this is the mirror, not the
  // authority.
  const rangeCheck = buildRangePayload(localRanges, definition.recode_type === 'scale_map')

  const handleSave = () => {
    const data: Record<string, unknown> = {}
    if (localName !== definition.name) data.name = localName
    // #818 — diff the STRIPPED mapping, not the local one. Ticking `Exclude`
    // changes only `localExcludes`, so an unstripped diff reports the mapping
    // unchanged, sends `exclude_values` alone, and leaves the stale code on the
    // server: the defect surviving its own fix.
    // #823(d) — the bands are the THIRD half and are computed here with the
    // other two, for #818's reason: a caller that diffs the mapping alone sees
    // no change when only a band moved.
    const payload = recodeMappingPayload(localMapping, localExcludes, rangeCheck.ranges)
    if (JSON.stringify(payload.mapping) !== JSON.stringify(definition.mapping)) data.mapping = payload.mapping
    if (JSON.stringify(payload.exclude_values) !== JSON.stringify(definition.exclude_values || [])) {
      data.exclude_values = payload.exclude_values.length > 0 ? payload.exclude_values : null
    }
    if (JSON.stringify(payload.ranges) !== JSON.stringify(definition.ranges ?? [])) {
      data.ranges = payload.ranges
    }
    if (Object.keys(data).length > 0) {
      onSave(data as {
        name?: string
        mapping?: Record<string, number | string>
        exclude_values?: string[] | null
        ranges?: RecodeRange[]
      })
    }
  }

  const recodeTypeBadge = {
    scale_map: { label: 'Scale Map', cls: 'bg-mm-blue/12 text-mm-blue-text' },
    category_group: { label: 'Category', cls: 'bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-300' },
    reverse: { label: 'Reverse', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' },
    // #857 — the fallback for an unknown recode type sits on the same recessed
    // card as the chip above and needs the same treatment, or a type this build
    // does not know renders as bare text with no chip at all.
  }[definition.recode_type] || { label: definition.recode_type, cls: 'border bg-mm-surface text-mm-text-muted' }

  return (
    // #857 — a RECESSED well, not a raised card. It was `bg-mm-surface`, which
    // read as raised only because the pane behind it was grey; once the pane
    // declares its own surface this card is white-on-white with a 1.54:1 border
    // and loses its extent. Recessing it also makes it consistent with
    // `NewDefinitionForm` below, which is the same kind of object and has always
    // been `bg-mm-bg` — the two now agree instead of contradicting each other.
    <div className="border rounded-lg bg-mm-bg">
      {/* 🔴 A REAL BUTTON, because this header is the ONLY route to the rule's
        * actions — Apply to this variable / Create as new variable / Copy to /
        * Re-derive / Delete all live inside the collapsed body (#823f).
        * Measured live: the header carried no role, no tab stop and no
        * `aria-expanded`, so every action on a saved recode rule was
        * mouse-only. A disclosure control is exactly what `<button>` is for,
        * and nothing inside this row is itself interactive — the badges and the
        * auto-detect wand are `<span title=…>` — so nesting is not a concern.
        * ⚠️ `text-left` and `w-full` are load-bearing: a button centres its
        * content and shrink-wraps by default, which would silently re-lay-out
        * the row. */}
      <button
        type="button"
        aria-expanded={isExpanded}
        className={`w-full text-left flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-mm-surface-hover ${FOCUS_RING}`}
        onClick={onToggleExpand}
      >
        {isExpanded ? <ChevronDown className="w-4 h-4 text-mm-text-faint" /> : <ChevronRight className="w-4 h-4 text-mm-text-faint" />}
        <span id={`rule-title-${definition.id}`} className="font-medium text-sm flex-grow">{definition.name}</span>
        <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${recodeTypeBadge.cls}`}>
          {recodeTypeBadge.label}
        </span>
        {/* 🔴 Decision C: "saved but not in effect" is a state with no analogue
            in SPSS, jamovi or JASP, and it was communicated by a bare STAR
            ICON with no accessible name — so a sighted user had to know the
            convention and a screen-reader user was told nothing at all. The
            LOAD-BEARING fact about a rule (does it do anything?) was the one
            fact the row did not state. Note the auto-detect wand beside it has
            carried a `title` all along: the less important flag was named and
            this one was not (#559's class). */}
        {definition.is_primary ? (
          <span
            // No `role="img"` here: this badge has VISIBLE TEXT, and that role
            // makes its children PRESENTATIONAL — the words would be suppressed
            // and only an aria-label announced. `ChartFigure.test.tsx`'s
            // whole-tree scan caught exactly that. The text IS the accessible
            // name; the icon is decorative (lucide hides it by default) and the
            // `title` carries the longer explanation, as it does on the sibling
            // state below.
            title="In effect — this rule drives the stored numbers"
            className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400"
          >
            <Star className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            In effect
          </span>
        ) : (
          <span
            // #857 — this chip was `bg-mm-bg`, the SAME value the card around it
            // now carries, so recessing the card would have erased it entirely.
            // Decision C added this state deliberately (it replaced a bare star
            // icon with no accessible name); a surface fill keeps it a chip.
            className="text-[11px] px-1.5 py-0.5 rounded border bg-mm-surface text-mm-text-muted"
            title="Saved, but not applied — this rule does not affect any chart, table or statistic until it is in effect."
          >
            Not applied
          </span>
        )}
        {definition.is_auto_detected && (
          <span title="Auto-detected"><WandSparkles className="w-3.5 h-3.5 text-mm-text-faint" /></span>
        )}
      </button>

      {isExpanded && (
        // #823(f) — the expanded card is a LABELLED REGION, and that is what
        // disambiguates its controls rather than lengthening their names.
        //
        // Several cards can be open at once, so the per-row controls collide:
        // measured live with two expanded, `Value for Depends` appeared twice
        // and `Value for Try to be helpful` three times. Folding the rule into
        // each name would read as "Value for Depends in Helpful 3-point
        // (Depends = middle)" on every one of up to 40 rows — the #785 problem
        // solved by creating a worse one. One group label carries the context
        // for every control inside it.
        //
        // ⚠️ Structure only. Whether a given screen reader ANNOUNCES the group
        // on entry is not something a DOM check can certify (the standing rule:
        // Lighthouse and the a11y tree certify structure, never audio), so this
        // is unverified by ear here.
        <div role="group" aria-labelledby={`rule-title-${definition.id}`} className="px-3 pb-3 border-t">
          {/* Name edit */}
          {/* 🔴 #823(f) — THE ONE LIGHTHOUSE `label` FAILURE ON THIS VIEW. The
              visible <label> was never associated: no `htmlFor`, no `id`, so
              axe reported "Form elements do not have associated labels" and a
              reader met a bare textbox holding the rule's name. Associating the
              EXISTING label is the right fix rather than an `aria-label` — the
              visible text stays the accessible name (WCAG 2.5.3), and clicking
              "Name" now focuses the field, which it never did.
              ⚠️ The id is per-DEFINITION because several cards can be expanded
              at once and ids must be unique in the document. */}
          <div className="mt-2 mb-3">
            <label htmlFor={`rule-name-${definition.id}`} className="text-xs text-mm-text-muted block mb-1">Name</label>
            <Input
              id={`rule-name-${definition.id}`}
              value={localName}
              onChange={(e) => { setLocalName(e.target.value); setHasChanges(true) }}
              className="h-8 text-sm bg-mm-surface"
            />
          </div>

          {/* Type-specific editor */}
          {definition.recode_type === 'scale_map' && (
            <ScaleMapEditor
              mapping={localMapping}
              excludeValues={localExcludes}
              onChange={handleMappingChange}
              rangeRows={localRanges}
              onRangesChange={handleRangesChange}
              rangeBadRow={rangeCheck.badRow}
              ownerLabel={definition.name}
            />
          )}
          {definition.recode_type === 'category_group' && (
            <CategoryGroupEditor
              mapping={localMapping}
              excludeValues={localExcludes}
              onChange={handleMappingChange}
              rangeRows={localRanges}
              onRangesChange={handleRangesChange}
              rangeBadRow={rangeCheck.badRow}
              ownerLabel={definition.name}
            />
          )}
          {definition.recode_type === 'reverse' && (
            <ReverseEditor
              sourceDefinitionId={definition.source_definition_id}
              definitions={allDefinitions}
              mapping={localMapping}
              // #602: this def is SAVED, so it has its own authoritative offset.
              serverOffset={definition.reverse_offset}
            />
          )}

          {/* Unmapped values warning */}
          {definition.unmapped_values.length > 0 && (
            <div className="mt-3 p-2 bg-amber-50 dark:bg-amber-950/30 rounded text-xs text-amber-700 dark:text-amber-300">
              <strong>Unmapped values:</strong> {definition.unmapped_values.join(', ')}
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {hasChanges && (
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving || !rangeCheck.ok}
                className="h-7 text-xs"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            )}
            {/* ⚠️ SAYS why Save is off. A disabled control with no explanation
                reads as broken, and the offending row already carries
                `aria-invalid` — this is the sentence that names the problem. */}
            {!rangeCheck.ok && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {rangeCheck.msg}
              </p>
            )}
            {/*
              🔴 Decision B, and the VISUAL WEIGHT is the decision, not decoration.
              The design note's whole diagnosis is that MM "derives a variable
              without creating one" — recoding in place is the surprising default,
              and B's accepted direction is that deriving should be the offered
              path. So this is the filled action and "Apply to this variable…",
              which rewrites this variable's stored numbers, is an outline one
              beside it. (That one was called "Set Primary" until §8 renamed it —
              the old name is quoted in `ApplyRuleDialog`'s header for history,
              and nowhere else.)

              ⚠️ Filled = CTA is one of the three roles `lib/selection.ts` allows
              (selection / CTA / status). This is not a re-tint of the kind §10.4
              indicted and Decision F removed.

              ⚠️ Safe to add here at 640×360: this row is `flex-wrap` (checked, not
              assumed), unlike the dataset toolbar whose non-wrapping row inside an
              `overflow-hidden` ancestor was Decision F's clipping defect.
            */}
            <Button size="sm" onClick={onDerive} className="h-7 text-xs">
              <Plus className="w-3 h-3 mr-1" />
              Create as new variable...
            </Button>
            {/* "Set Primary" named the IMPLEMENTATION (which rule drives
                `value_numeric`), not the act. Neither SPSS nor jamovi has a
                concept by that name. This says what it does to the researcher's
                data, and the ellipsis signals the confirm — applying rewrites
                every stored number in the variable and cannot be undone. */}
            {!definition.is_primary && (
              <Button variant="outline" size="sm" onClick={onApply} className="h-7 text-xs">
                <Star className="w-3 h-3 mr-1" />
                Apply to this variable...
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onCopyTo} className="h-7 text-xs">
              <Copy className="w-3 h-3 mr-1" />
              Copy to...
            </Button>
            {/*
              #584 step 2. Always offered rather than gated on a "has dependents"
              flag: the plan is fetched on open and says "nothing derives from
              this" when there is nothing, which costs one request and avoids a
              second source of truth about who depends on what. A dependent can
              also live on ANOTHER column, which this per-column list cannot see.
            */}
            <Button variant="outline" size="sm" onClick={onRederive} className="h-7 text-xs">
              <Link2 className="w-3 h-3 mr-1" />
              Re-derive...
            </Button>
            <Button variant="outline" size="sm" onClick={onDelete} className="h-7 text-xs text-red-600 hover:text-red-700">
              <Trash2 className="w-3 h-3 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── New Definition Form ──────────────────────────────────────────────────────

function NewDefinitionForm({
  existingDefinitions,
  onCreate,
  isCreating,
  selectedColumn,
  frequenciesData,
}: {
  existingDefinitions: RecodeDefinition[]
  onCreate: (data: {
    name: string
    recode_type: string
    output_type: string
    mapping: Record<string, number | string>
    exclude_values?: string[]
    source_definition_id?: number
  }) => void
  isCreating: boolean
  selectedColumn: DatasetColumn | undefined
  frequenciesData: { column_id: number; frequencies: ValueFrequency[]; total: number } | undefined
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<'scale_map' | 'category_group' | 'reverse'>('scale_map')
  const [sourceDefId, setSourceDefId] = useState<number | null>(null)
  const [draftMapping, setDraftMapping] = useState<Record<string, number | string>>({})
  const [draftExcludeValues, setDraftExcludeValues] = useState<string[]>([])
  // #823(d) — bands on a NEW rule, so a researcher can band without saving an
  // empty rule first and coming back to it.
  const [draftRanges, setDraftRanges] = useState<RangeRow[]>([])
  // Mirrors the saved editor: validate on render so Create can refuse a
  // malformed band before the round trip. A REVERSE never bands, so its check
  // is over an empty list and always passes.
  const draftRangeCheck = buildRangePayload(draftRanges, type === 'scale_map')

  const scaleMapDefs = existingDefinitions.filter(d => d.recode_type === 'scale_map')
  const labels = useMemo(
    () => getLabels(existingDefinitions, selectedColumn, frequenciesData),
    [existingDefinitions, selectedColumn, frequenciesData],
  )
  const seedBasis = useMemo(
    () => getSeedBasis(existingDefinitions, selectedColumn, frequenciesData),
    [existingDefinitions, selectedColumn, frequenciesData],
  )

  // #581: a new def with no existing primary becomes primary server-side
  // (recode.py:277). A category_group primary CLEARS value_numeric column-wide,
  // 🔴 The category-group numeric-clearing warning MOVED to `ApplyRuleDialog`
  // (2026-08-24). It was gated on `willBePrimary = no existing primary`, which
  // creating a rule can no longer make true — so left here it would have become
  // copy that never renders. It belongs where the clearing actually happens,
  // which is now the explicit apply confirm.

  // Rebuild draft mapping when type, source, or label inputs change
  /* eslint-disable react-hooks/set-state-in-effect -- rebuild draft mapping from recode type/source */
  useEffect(() => {
    if (type === 'scale_map') {
      setDraftMapping(Object.fromEntries(labels.map((l, i) => [l, i + 1])))
      setDraftExcludeValues([])
    } else if (type === 'category_group') {
      setDraftMapping(Object.fromEntries(labels.map(l => [l, ''])))
      setDraftExcludeValues([])
    } else if (type === 'reverse') {
      if (sourceDefId) {
        const sourceDef = existingDefinitions.find(d => d.id === sourceDefId)
        if (sourceDef) {
          // #578: store the source's FORWARD codes verbatim. The backend reflects
          // about the scale midpoint at APPLY time (services/recode.py::reverse_offset);
          // pre-flipping the codes here made it flip twice and cancel, so
          // value_numeric silently kept its forward (un-reversed) value while the
          // grid displayed the flipped one. The reflection is now shown only for
          // DISPLAY (ReverseEditor / EditableCell), never baked into the stored mapping.
          setDraftMapping({ ...sourceDef.mapping })
          setDraftExcludeValues(sourceDef.exclude_values || [])
        } else {
          setDraftMapping({})
          setDraftExcludeValues([])
        }
      } else {
        setDraftMapping({})
        setDraftExcludeValues([])
      }
    }
  }, [type, sourceDefId, existingDefinitions, selectedColumn, frequenciesData, labels])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleCreate = () => {
    if (!name.trim()) return

    const outputType = type === 'category_group' ? 'categorical' : 'numeric'

    onCreate({
      name: name.trim(),
      recode_type: type,
      output_type: outputType,
      // #818 — the same chokepoint as the edit path; an excluded response must
      // never be saved carrying the code it had before the tick.
      mapping: recodeMappingPayload(draftMapping, draftExcludeValues).mapping,
      ...(draftExcludeValues.length > 0 ? { exclude_values: draftExcludeValues } : {}),
      ...(draftRangeCheck.ranges.length > 0 ? { ranges: draftRangeCheck.ranges } : {}),
      ...(type === 'reverse' && sourceDefId ? { source_definition_id: sourceDefId } : {}),
    })
    setName('')
  }

  return (
    <div className="border rounded-lg p-3 bg-mm-bg">
      <div className="flex items-center gap-2 mb-2">
        <Plus className="w-4 h-4 text-mm-text-faint" />
        <span className="text-sm font-medium text-mm-text">New Definition</span>
      </div>
      <div className="space-y-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Definition name..."
          // #823(f) — the placeholder is erased by the first character typed,
          // so it cannot be this field's name. "Definition" matches the visible
          // heading above it, keeping the accessible name and the words on
          // screen in step.
          aria-label="Definition name"
          className="h-8 text-sm bg-mm-surface"
        />
        <div role="radiogroup" aria-label="Recode type" className="flex gap-2 flex-wrap">
          {(['scale_map', 'category_group', 'reverse'] as const).map(t => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={`px-2 py-1 rounded text-xs font-medium border ${
                type === t ? SELECTED_SEGMENT : 'bg-mm-surface border-mm-border-subtle text-mm-text-muted'
              }`}
            >
              {t === 'scale_map' ? 'Scale Map' : t === 'category_group' ? 'Category Group' : 'Reverse'}
            </button>
          ))}
        </div>
        {type === 'reverse' && scaleMapDefs.length > 0 && (
          <select
            aria-label="Source definition to reverse"
            value={sourceDefId || ''}
            onChange={e => setSourceDefId(e.target.value ? Number(e.target.value) : null)}
            className="w-full h-8 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle"
          >
            <option value="">Select source definition...</option>
            {scaleMapDefs.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        )}


        {/* Live draft preview */}
        {type === 'reverse' && scaleMapDefs.length === 0 ? (
          <div className="text-xs text-mm-text-faint bg-mm-surface rounded p-3 border border-dashed">
            No scale map definitions exist to reverse.
          </div>
        ) : type === 'reverse' && !sourceDefId ? (
          <div className="text-xs text-mm-text-faint bg-mm-surface rounded p-3 border border-dashed">
            Select a source definition above to preview.
          </div>
        ) : Object.keys(draftMapping).length > 0 ? (
          <div className="bg-mm-surface rounded border p-2">
            <span className="text-xs text-mm-text-muted font-medium block mb-1">Preview</span>
            {/*
              * #823(h): the codes below were assigned in ALPHABETICAL order,
              * and nothing else in this screen says so.
              *
              * Measured on GSS `fair`, a 3-point attitude item: the seed read
              * *Depends = 1, Would take advantage of you = 2, Would try to be
              * fair = 3* — the negative pole above the midpoint, so accepting
              * the default yields a scale whose middle is at one end and every
              * mean computed from it is meaningless.
              *
              * ⚠️ Shown ONLY for `observed_alphabetical`. A numeric seed is
              * ordered by value and an authored or declared one carries an
              * order somebody chose — warning about those would train the
              * researcher to dismiss the notice on the one seed that needs it.
              */}
            {type === 'scale_map' && seedBasis === 'observed_alphabetical' && (
              <p
                role="note"
                className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded px-2 py-1.5 mb-2"
              >
                These codes were numbered <strong>alphabetically</strong> — the order responses
                happen to fall in, not the order they mean. Check that the numbers run from one
                end of the scale to the other before saving.
              </p>
            )}
            {type === 'scale_map' && (
              <ScaleMapEditor
                mapping={draftMapping}
                excludeValues={draftExcludeValues}
                onChange={(mapping, excludes) => {
                  setDraftMapping(mapping)
                  setDraftExcludeValues(excludes)
                }}
                rangeRows={draftRanges}
                onRangesChange={setDraftRanges}
                rangeBadRow={draftRangeCheck.badRow}
                ownerLabel={name.trim() || 'the new rule'}
              />
            )}
            {type === 'category_group' && (
              <CategoryGroupEditor
                mapping={draftMapping}
                excludeValues={draftExcludeValues}
                onChange={(mapping, excludes) => {
                  setDraftMapping(mapping)
                  setDraftExcludeValues(excludes)
                }}
                rangeRows={draftRanges}
                onRangesChange={setDraftRanges}
                rangeBadRow={draftRangeCheck.badRow}
                ownerLabel={name.trim() || 'the new rule'}
              />
            )}
            {type === 'reverse' && (
              <ReverseEditor
                sourceDefinitionId={sourceDefId}
                definitions={existingDefinitions}
                mapping={draftMapping}
                // #602: no `serverOffset` — this is a DRAFT with no saved row.
                // The editor falls back to the SOURCE's offset, which is the
                // right number because the draft's mapping IS the source's.
              />
            )}
          </div>
        ) : labels.length === 0 && (type === 'scale_map' || type === 'category_group') ? (
          <div className="text-xs text-mm-text-muted bg-mm-surface rounded p-3 border border-dashed">
            No response values found. Use the input below to add labels manually.
          </div>
        ) : labels.length === 0 ? (
          <div className="text-xs text-mm-text-faint bg-mm-surface rounded p-3 border border-dashed">
            No labels available for preview. The mapping will be created empty.
          </div>
        ) : null}

        <Button
          size="sm"
          onClick={handleCreate}
          disabled={
            !name.trim() || isCreating
            || (type === 'reverse' && !sourceDefId)
            || !draftRangeCheck.ok
          }
          className="h-7 text-xs"
        >
          {isCreating ? 'Creating...' : 'Create'}
        </Button>
        {!draftRangeCheck.ok && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-1">
            {draftRangeCheck.msg}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function RecodeWorkbench() {
  const { projectId, datasetId } = useParams<{ projectId: string; datasetId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const pid = parseInt(projectId || '0')
  const did = parseInt(datasetId || '0')
  const { setBreadcrumbLabel } = useProjectLayout()
  const navigate = useNavigate()

  const queryClient = useQueryClient()

  /**
   * Undo/redo for this view's header edits — PARITY, not a new idea.
   *
   * 🔴 The Data view has run name / label / type edits through `useHistory`
   * since it shipped; this view ran the identical mutations with a bare
   * invalidate. So one screen offered undo on a rename and the other did not,
   * and this arc has been moving researchers to the one that did not. Found
   * while scoping the popover's retirement: MOVING the editor here would have
   * silently deleted undo, which is the kind of regression a "just relocate it"
   * framing hides.
   *
   * ⚠️ Deliberately scoped to the HEADER fields. Value labels and missing
   * declarations mutate stored cells and disclose what they did (#680); they
   * are not undoable on any surface, and inventing an undo for them here would
   * promise a reversal the backend does not implement.
   */
  const {
    execute: executeHistory, undo: historyUndo, redo: historyRedo, canUndo, canRedo,
  } = useHistory()


  // Resizable panel layout persistence — same shape as the two analysis views.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'variables-view-panels',
    storage: localStorage,
  })

  // Ref to stabilize setSearchParams (not referentially stable from useSearchParams)
  const setSearchParamsRef = useRef(setSearchParams)
  setSearchParamsRef.current = setSearchParams

  // Selected column
  const selectedColumnId = searchParams.get('column') ? parseInt(searchParams.get('column')!) : null
  const setSelectedColumn = useCallback((id: number | null) => {
    if (id) setSearchParamsRef.current({ column: String(id) })
    else setSearchParamsRef.current({})
  }, [])

  // UI state
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [expandedDefs, setExpandedDefs] = useState<Set<number>>(new Set())
  const [copyDialogDef, setCopyDialogDef] = useState<RecodeDefinition | null>(null)
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set())
  const [bulkType, setBulkType] = useState<string>('ordinal')
  const [showEquivalentsAfterCreate, setShowEquivalentsAfterCreate] = useState<RecodeDefinition | null>(null)
  const [showEquivalentsSync, setShowEquivalentsSync] = useState(false)

  // The two property FORMS the popover thinning moved here (design note E).
  // Both reuse `ColumnFormDialog` rather than growing a third editor for the
  // fields it already owns — a second implementation of one job is the
  // substrate debt §10.1 indicts, and this arc is retiring it, not adding to it.
  const [detailsColumn, setDetailsColumn] = useState<DatasetColumn | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [formulaColumn, setFormulaColumn] = useState<DatasetColumn | null>(null)
  const [formulaError, setFormulaError] = useState<string | null>(null)

  // Inline header editing
  const [headerEditing, setHeaderEditing] = useState<'name' | 'text' | null>(null)
  const [headerEditValue, setHeaderEditValue] = useState('')
  const headerInputRef = useRef<HTMLInputElement>(null)

  // Enter-to-advance refs
  const pendingEditField = useRef<'name' | 'text' | null>(null)
  const pendingTypeSelect = useRef(false)
  const typeSelectRef = useRef<HTMLSelectElement>(null)
  const isAdvancing = useRef(false)

  // Fetch columns
  const { data: columnsData } = useQuery({
    queryKey: ['dataset-columns', pid, did],
    queryFn: () => datasetsApi.listColumns(pid, did),
    enabled: !!pid && !!did,
  })
  const allColumns: DatasetColumn[] = useMemo(() => columnsData ?? [], [columnsData])

  // Fetch dataset
  const { data: dataset } = useQuery({
    queryKey: ['dataset', pid, did],
    queryFn: () => datasetsApi.get(pid, did),
    enabled: !!pid && !!did,
  })

  useEffect(() => {
    if (dataset?.name) setBreadcrumbLabel(dataset.name)
  }, [dataset?.name, setBreadcrumbLabel])

  // Fetch definitions for selected column
  const { data: definitions = [], isLoading: defsLoading } = useQuery({
    queryKey: ['recode-definitions', pid, did, selectedColumnId],
    queryFn: () => recodeApi.list(pid, did, selectedColumnId!),
    enabled: !!pid && !!did && !!selectedColumnId,
  })

  // Fetch frequencies for selected column
  const { data: frequenciesData } = useQuery({
    queryKey: ['column-frequencies', pid, did, selectedColumnId],
    queryFn: () => recodeApi.getFrequencies(pid, did, selectedColumnId!),
    enabled: !!pid && !!did && !!selectedColumnId,
  })

  /**
   * #584's death arm — which of this column's recodes the relabel killed.
   *
   * Fetched with the column rather than on demand, because unlike the re-derive
   * plan this one decides whether the researcher is TOLD anything at all. A
   * dead definition is silent by nature: it maps every cell to nothing and the
   * grid simply shows blanks, so the banner is the only place the state becomes
   * visible — and it has to be visible on a later visit, not only in the toast
   * that followed the relabel.
   *
   * The client's copy can go stale; that is safe because `apply_rekey`
   * recomputes the plan server-side and refuses anything the current state does
   * not still permit.
   */
  const { data: rekeyPlan } = useQuery({
    queryKey: ['rekey-plan', pid, did, selectedColumnId],
    queryFn: () => recodeApi.rekeyPlan(pid, did, selectedColumnId!),
    enabled: !!pid && !!did && !!selectedColumnId,
  })

  // Header edit mutation
  const updateHeaderMutation = useMutation({
    mutationFn: ({ columnId, data }: { columnId: number; data: { column_name?: string | null; column_text?: string | null } }) =>
      datasetsApi.updateColumnHeader(pid, did, columnId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
    },
  })

  const startHeaderEdit = useCallback((field: 'name' | 'text', currentValue: string) => {
    setHeaderEditing(field)
    setHeaderEditValue(currentValue)
  }, [])

  const commitHeaderEdit = useCallback(() => {
    if (!headerEditing || !selectedColumnId) return
    const trimmed = headerEditValue.trim()
    if (headerEditing === 'name') {
      const col = allColumns.find(q => q.id === selectedColumnId)
      const oldName = col?.column_name || ''
      if (trimmed !== oldName) {
        const columnId = selectedColumnId
        executeHistory({
          type: 'column_name_edit',
          description: `Rename variable to "${trimmed || '(empty)'}"`,
          redo: async () => {
            await updateHeaderMutation.mutateAsync({ columnId, data: { column_name: trimmed || null } })
          },
          undo: async () => {
            await updateHeaderMutation.mutateAsync({ columnId, data: { column_name: oldName || null } })
          },
        })
      }
    } else {
      const col = allColumns.find(q => q.id === selectedColumnId)
      if (trimmed && trimmed !== col?.column_text) {
        const columnId = selectedColumnId
        const oldText = col!.column_text
        executeHistory({
          type: 'column_text_edit',
          description: 'Update variable label',
          redo: async () => {
            await updateHeaderMutation.mutateAsync({ columnId, data: { column_text: trimmed } })
          },
          undo: async () => {
            await updateHeaderMutation.mutateAsync({ columnId, data: { column_text: oldText } })
          },
        })
      }
    }
    setHeaderEditing(null)
  }, [headerEditing, headerEditValue, selectedColumnId, allColumns, updateHeaderMutation, executeHistory])

  const cancelHeaderEdit = useCallback(() => {
    setHeaderEditing(null)
  }, [])

  // ── The five affordances the popover thinning moved here ──────────────────
  //
  // ⚠️ Undo parity is decided PER EDIT by what the Data view did, not by a
  // blanket rule: the swap and the formula rode `useHistory` there, so they ride
  // it here; the subtype and the manual-details save did not, so inventing an
  // undo for them would promise a reversal the other surface never offered.

  const subtypeMutation = useMutation({
    mutationFn: ({ columnId, subtype }: { columnId: number; subtype: string | null }) =>
      datasetsApi.updateColumnSubtype(pid, did, columnId, subtype),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
    },
    onError: (err: unknown) => toast.error(extractApiError(err, 'Failed to change subtype')),
  })

  const detailsMutation = useMutation({
    mutationFn: ({ columnId, data }: { columnId: number; data: ManualColumnUpdate }) =>
      datasetsApi.updateManualColumn(pid, did, columnId, data),
    onSuccess: () => {
      // A manual-column save writes scale metadata, so it IS a dictionary
      // change — route it through the single source rather than a hand list
      // (#608, whose own docstring names this view as a required consumer).
      invalidateColumnDictionary(queryClient, pid, did)
      setDetailsColumn(null)
      setDetailsError(null)
      toast.success('Variable updated')
    },
    onError: (err: unknown) => setDetailsError(extractApiError(err, 'Failed to update variable')),
  })

  const formulaMutation = useMutation({
    mutationFn: ({ columnId, data }: { columnId: number; data: ComputedColumnUpdate }) =>
      datasetsApi.updateComputedColumn(pid, did, columnId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      setFormulaColumn(null)
      setFormulaError(null)
      toast.success('Formula updated')
    },
    onError: (err: unknown) => setFormulaError(extractApiError(err, 'Failed to update formula')),
  })

  const recomputeMutation = useMutation({
    mutationFn: (columnId: number) => datasetsApi.recomputeColumn(pid, did, columnId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
    },
    onError: (err: unknown) => toast.error(extractApiError(err, 'Failed to recompute variable')),
  })

  const handleSubtypeChange = useCallback((columnId: number, subtype: string | null) => {
    subtypeMutation.mutate({ columnId, subtype })
  }, [subtypeMutation])

  const handleSwapNameLabel = useCallback((column: DatasetColumn) => {
    const swap = swapNameLabelValues(column)
    if (!swap) return
    const columnId = column.id
    const oldName = column.column_name ?? null
    const oldText = column.column_text
    executeHistory({
      type: 'column_swap_name_label',
      description: `Swap name and label for "${oldText}"`,
      redo: async () => {
        await updateHeaderMutation.mutateAsync({
          columnId, data: { column_name: swap.newName, column_text: swap.newText },
        })
      },
      undo: async () => {
        await updateHeaderMutation.mutateAsync({
          columnId, data: { column_name: oldName, column_text: oldText },
        })
      },
    })
  }, [executeHistory, updateHeaderMutation])

  const handleEditFormula = useCallback((column: DatasetColumn) => {
    setFormulaColumn(column)
    setFormulaError(null)
  }, [])

  const handleOpenDetails = useCallback((column: DatasetColumn) => {
    setDetailsColumn(column)
    setDetailsError(null)
  }, [])

  const handleRecompute = useCallback((column: DatasetColumn) => {
    recomputeMutation.mutate(column.id)
  }, [recomputeMutation])

  // Filtered columns by type filter (all types shown, including open-ended)
  const filteredColumns = useMemo(() => {
    if (typeFilter === 'all') return allColumns
    return allColumns.filter(q => q.column_type === typeFilter)
  }, [allColumns, typeFilter])

  const selectedColumn = allColumns.find(q => q.id === selectedColumnId)

  // Advance to the same header field on the next/previous column
  const advanceColumn = useCallback((direction: 1 | -1, editField: 'name' | 'text' | 'type') => {
    const currentIdx = filteredColumns.findIndex(q => q.id === selectedColumnId)
    if (currentIdx < 0) return
    const nextIdx = currentIdx + direction
    if (nextIdx < 0 || nextIdx >= filteredColumns.length) return

    if (editField === 'name' || editField === 'text') {
      pendingEditField.current = editField
    } else {
      pendingTypeSelect.current = true
    }
    setSelectedColumn(filteredColumns[nextIdx].id)

    // Scroll the new column into view in the left panel
    const nextId = filteredColumns[nextIdx].id
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-column-id="${nextId}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'nearest' })
    })
  }, [filteredColumns, selectedColumnId, setSelectedColumn])

  // Reset editing state when switching columns (or auto-enter edit if advancing)
  useEffect(() => {
    const field = pendingEditField.current
    pendingEditField.current = null

    if (field && selectedColumn) {
      const val = field === 'name'
        ? (selectedColumn.column_name || '')
        : selectedColumn.column_text

      setHeaderEditing(field)

      setHeaderEditValue(val)
    } else {

      setHeaderEditing(null)
    }

    if (pendingTypeSelect.current) {
      pendingTypeSelect.current = false
      requestAnimationFrame(() => {
        typeSelectRef.current?.focus()
      })
    }
  }, [selectedColumnId]) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally only on column change

  // Focus input when editing starts — no setState, just DOM focus
  useEffect(() => {
    if (headerEditing && headerInputRef.current) {
      headerInputRef.current.focus()
      headerInputRef.current.select()
    }
  }, [headerEditing])

  // Auto-select first column
  useEffect(() => {
    if (!selectedColumnId && allColumns.length > 0) {
      setSelectedColumn(allColumns[0].id)
    }
  }, [allColumns, selectedColumnId, setSelectedColumn])

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof recodeApi.create>[3]) =>
      recodeApi.create(pid, did, selectedColumnId!, data),
    onSuccess: (newDef) => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      // Crosswalk's ⟲ badge derives from ['reverse-columns', pid]; introducing
      // or modifying a recode def can change reverse-column membership.
      // setPrimaryMutation is intentionally NOT invalidated here — toggling
      // is_primary can't introduce or remove reverse defs.
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
      // Prompt to copy to equivalents if column is in an equivalence group
      if (selectedColumn?.equivalence_group_id && newDef.recode_type !== 'reverse') {
        setShowEquivalentsAfterCreate(newDef)
      }
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ defId, data }: { defId: number; data: Parameters<typeof recodeApi.update>[4] }) =>
      recodeApi.update(pid, did, selectedColumnId!, defId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (defId: number) =>
      recodeApi.delete(pid, did, selectedColumnId!, defId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
    },
  })

  /**
   * #584 — warn BEFORE deleting a definition something else was derived from.
   *
   * Deleting a source SET NULLs the link and orphans its dependents: the
   * reverse definition keeps its own frozen copy of the forward mapping, so it
   * goes on producing numbers, but nothing can ever tell it apart from one
   * authored by hand again — the #578 startup repair works from the source that
   * no longer exists.
   *
   * Fetched on demand rather than listed up front: a dependent may live on a
   * DIFFERENT column (the crosswalk copies a definition and records where it
   * came from), so the column's own definition list cannot see it.
   *
   * ⚠️ If the lookup itself fails we delete rather than block. The warning is an
   * advisory about a rare, recoverable state; refusing a destructive action the
   * researcher asked for because a secondary GET failed is the worse trade.
   */
  /**
   * #584 step 2 — re-derive dependents from this definition.
   *
   * The plan is fetched fresh on open and the server recomputes it again on
   * apply, so a stale plan left sitting in a dialog can never authorise a write
   * the current state forbids.
   */
  const [rederiveFor, setRederiveFor] = useState<RecodeDefinition | null>(null)
  const [rederivePlan, setRederivePlan] = useState<RederivePlanItem[] | null>(null)

  const openRederive = async (def: RecodeDefinition) => {
    setRederiveFor(def)
    setRederivePlan(null)
    try {
      setRederivePlan(await recodeApi.rederivePlan(pid, did, selectedColumnId!, def.id))
    } catch {
      toast.error('Could not check what derives from this definition.')
      setRederiveFor(null)
    }
  }

  /**
   * Decision B — derive a NEW variable from a rule.
   *
   * The flow moved to `hooks/useDeriveVariable` in Stage 3, when the Data
   * view's `Add ▾` gained the same act: two surfaces, one implementation.
   * ⚠️ `onCreated` NAVIGATES here and deliberately does not on the Data view —
   * there the new column simply appears in the grid the researcher is looking
   * at, while here they would otherwise be left on the source variable with the
   * thing they just made invisible.
   */
  const derive = useDeriveVariable(pid, did, (newColumnId) => setSelectedColumn(newColumnId))

  /**
   * #830f — the same asymmetry a third time, for the three kinds of new
   * variable. `onCreated` SELECTS the new variable here because this view has a
   * detail pane and the researcher would otherwise stay parked on whatever was
   * selected before, with the thing they just made invisible.
   */
  const createVariable = useCreateVariable(pid, did, (newColumnId) => setSelectedColumn(newColumnId))

  /**
   * #812 — the other half of that asymmetry. Same hook shape, same reason: one
   * implementation, and `onDeleted` is the only thing this surface decides for
   * itself. The Data view passes nothing (the column leaves the grid in front of
   * the researcher); here the detail panel is SHOWING the variable that just
   * stopped existing, so the selection has to move off it or the page renders a
   * header, a dictionary and a rule list for a row the server has dropped.
   *
   * ⚠️ It clears the selection rather than picking a neighbour, and the
   * auto-select effect above then lands on the first variable once the refetched
   * list arrives. That ordering is deliberate: choosing "the next one" here
   * would race the invalidation and could select the row that was just removed.
   *
   * ⚠️ `setSelectedColumn` writes the URL (`?column=`), so it takes a VALUE and
   * not an updater — `selectedColumnId` is derived from the search params, not
   * from React state.
   */
  const deleteVariable = useDeleteVariable(pid, did, (deletedId) => {
    if (selectedColumnId === deletedId) setSelectedColumn(null)
  })

  const rederiveMutation = useMutation({
    mutationFn: (definitionIds: number[]) =>
      recodeApi.rederive(pid, did, selectedColumnId!, rederiveFor!.id, definitionIds),
    onSuccess: (res) => {
      // A re-derive can change a DIFFERENT column's stored scores (a dependent
      // may live elsewhere), so this invalidates the dataset broadly rather than
      // the current column's keys.
      void queryClient.invalidateQueries({ queryKey: ['dataset', did] })
      void queryClient.invalidateQueries({ queryKey: ['recode-definitions'] })
      const n = res.updated.length
      toast.success(
        n === 0
          ? 'Everything already matched — nothing changed.'
          : `Re-derived ${n} definition${n === 1 ? '' : 's'} (${res.changed_values} value${res.changed_values === 1 ? '' : 's'} updated).`
      )
      setRederiveFor(null)
      setRederivePlan(null)
    },
    onError: (err: unknown) => {
      // The 409 body names WHICH definition blocked it and says nothing was
      // changed — surface it verbatim rather than a generic failure.
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Re-derive failed. Nothing was changed.')
    },
  })

  /**
   * #584's death arm — re-key this column's relabel-killed definitions.
   *
   * Column-scoped, so there is no per-definition "open for X": the operation is
   * "make this column's recodes match its current values again".
   */
  /**
   * The dictionary editor's region, so the grid's Values / Missing cells can
   * bring it into view. Scrolling rather than opening anything is the point:
   * the editor is always present for the selected variable, and the rules stay
   * visible beside it.
   */
  const dictionaryRef = useRef<HTMLDivElement>(null)
  const revealDictionary = useCallback(() => {
    // After the selection commits, so the ref points at the right variable's
    // region rather than the previous one's.
    queueMicrotask(() => {
      dictionaryRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [])
  const [rekeyOpen, setRekeyOpen] = useState(false)

  /** How many of the dead recodes can actually be repaired — decides whether the
   *  banner offers an action or explains that there isn't one. */
  const rekeyActionable = (rekeyPlan ?? []).filter(isRekeySelectable).length

  const rekeyMutation = useMutation({
    mutationFn: (definitionIds: number[]) =>
      recodeApi.rekey(pid, did, selectedColumnId!, definitionIds),
    onSuccess: (res) => {
      // A re-key only ever touches definitions ON THIS COLUMN, so unlike the
      // re-derive above this can invalidate narrowly.
      void queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      void queryClient.invalidateQueries({ queryKey: ['rekey-plan', pid, did, selectedColumnId] })
      void queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      const n = res.updated.length
      toast.success(
        `Updated ${n} recode${n === 1 ? '' : 's'} `
        + `(${res.renamed_keys} value${res.renamed_keys === 1 ? '' : 's'} renamed).`
      )
      setRekeyOpen(false)
    },
    onError: (err: unknown) => {
      // The 409 body names WHICH definition blocked it and says nothing was
      // changed — surface it verbatim rather than a generic failure.
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Could not update these recodes. Nothing was changed.')
    },
  })

  const [pendingDelete, setPendingDelete] = useState<
    { defId: number; name: string; dependents: RecodeDependentInfo[]; inEffect: boolean } | null
  >(null)

  const requestDelete = useCallback(async (def: { id: number; name: string; is_primary: boolean }) => {
    // 🔴 A rule IN EFFECT now confirms even with no dependents (2026-08-24).
    //
    // Deleting it used to do one of two silent things — promote another rule
    // and apply it, or wipe the column's numbers outright. Both are gone: the
    // numbers stay exactly as the rule left them. But that needs SAYING, because
    // the obvious reading of "delete the rule that transformed my variable" is
    // that the transformation is undone, and it is not — MM does not store what
    // the values were before.
    //
    // No initializer: the catch below RETURNS, so every path that reaches the
    // use has assigned it (`no-useless-assignment` flags the dead `[]`).
    let dependents: RecodeDependentInfo[]
    try {
      dependents = await recodeApi.dependents(pid, did, selectedColumnId!, def.id)
    } catch {
      dependents = []
    }
    if (dependents.length === 0 && !def.is_primary) {
      deleteMutation.mutate(def.id)
      return
    }
    setPendingDelete({
      defId: def.id, name: def.name, dependents, inEffect: def.is_primary,
    })
  }, [pid, did, selectedColumnId, deleteMutation])

  /** The rule awaiting an explicit apply confirm (design-note §8). */
  const [pendingApply, setPendingApply] = useState<RecodeDefinition | null>(null)

  const setPrimaryMutation = useMutation({
    mutationFn: (defId: number) =>
      recodeApi.setPrimary(pid, did, selectedColumnId!, defId),
    onSuccess: (res) => {
      // #794: a PARTIALLY stale rule promotes successfully and NULLs the cells
      // it could not map. That is defensible — an unmapped value has no code —
      // but it was entirely silent, and the researcher's next chart would drop
      // those respondents with no explanation. A totally stale one is refused
      // outright by the backend, which is why this only ever reports partials.
      const unmapped = res?.unmapped_values ?? []
      if (unmapped.length) {
        const shown = unmapped.slice(0, 4).join(', ')
        const more = unmapped.length > 4 ? ` +${unmapped.length - 4} more` : ''
        toast.warning(
          `"${res.name}" is now in effect, but it has no mapping for ${shown}${more} — ` +
          'those responses are now blank for every statistic. Add them to the mapping to include them.',
          { duration: 10_000 },
        )
      }
      queryClient.invalidateQueries({ queryKey: ['recode-definitions', pid, did, selectedColumnId] })
      queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
      setPendingApply(null)
    },
    onError: (e) => {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Could not apply this rule.')
      // The dialog stays OPEN on failure so the reason is read next to the
      // action that caused it, rather than dismissed into a toast.
    },
  })

  const copyToMutation = useMutation({
    mutationFn: ({ defId, targetIds }: { defId: number; targetIds: number[] }) =>
      recodeApi.copyTo(pid, did, selectedColumnId!, defId, targetIds),
    onSuccess: () => {
      setCopyDialogDef(null)
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
      queryClient.invalidateQueries({ queryKey: ['reverse-columns', pid] })
    },
  })

  const bulkTypeMutation = useMutation({
    mutationFn: () =>
      recodeApi.bulkTypeUpdate(pid, did, [...bulkSelected], bulkType),
    onSuccess: () => {
      setBulkSelected(new Set())
      queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
    },
  })

  const toggleExpanded = (defId: number) => {
    setExpandedDefs(prev => {
      const next = new Set(prev)
      if (next.has(defId)) next.delete(defId)
      else next.add(defId)
      return next
    })
  }

  /**
   * Arrow / Home / End inside the variable listbox (#823f).
   *
   * ⚠️ Attached to the LISTBOX, never to `window`. A global listener would have
   * to stand down for every input on the page — the trap `useCodeChordShortcuts`
   * exists to handle (#784/#789) — and there is no reason to take that on when
   * the keys only mean anything while focus is inside this list.
   *
   * ⚠️ Selection FOLLOWS FOCUS, and that is the point: this list is how a
   * researcher browses variables, and the panel beside it is the answer. A
   * focus-without-select variant would make every arrow press a no-op until
   * Enter, which is not how the mouse behaves either.
   */
  const focusOption = useCallback((columnId: number) => {
    // `tabIndex` is derived from state, so the node exists but is not focused
    // until we say so — after the render that moved the roving stop.
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-column-id="${columnId}"][role="option"]`,
      ) as HTMLElement | null
      el?.focus()
      el?.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  const handleColumnListKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Never steal a key from a control that owns it — the list holds only
    // options today, but a future inline control inside a row must keep its
    // own arrows (the `focusedElementOwnsKey` principle, applied locally).
    const target = e.target as HTMLElement
    if (target.getAttribute('role') !== 'option') return

    // ⚠️ The cursor is where FOCUS is, falling back to the selection — not the
    // selection alone. Ctrl+Arrow moves focus without selecting, so after one
    // the two have deliberately parted company, and a plain arrow must continue
    // from where the user is looking rather than jumping back.
    const focusedId = Number(target.getAttribute('data-column-id'))
    const cursorId = Number.isNaN(focusedId) ? selectedColumnId : focusedId
    const cursor = filteredColumns.findIndex(q => q.id === cursorId)

    const intent = listboxKeyIntent(
      e.key,
      { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey },
      cursor,
      filteredColumns.length,
    )
    if (intent.type === 'none') return
    e.preventDefault()

    if (intent.type === 'toggle') {
      // The keyboard's Ctrl-click. Selection is deliberately untouched, exactly
      // as `handleColumnClick`'s Ctrl branch leaves it. `cursor >= 0` is
      // guaranteed by the intent, so the row is resolved by INDEX rather than
      // by re-deriving the id.
      const toggleId = filteredColumns[cursor].id
      setBulkSelected(prev => {
        const next = new Set(prev)
        if (next.has(toggleId)) next.delete(toggleId)
        else next.add(toggleId)
        return next
      })
      return
    }

    const nextId = filteredColumns[intent.index].id
    if (intent.type === 'select') {
      setBulkSelected(new Set())
      setSelectedColumn(nextId)
    }
    focusOption(nextId)
  }, [filteredColumns, selectedColumnId, setSelectedColumn, focusOption])

  const handleColumnClick = (qId: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Multi-select toggle
      setBulkSelected(prev => {
        const next = new Set(prev)
        if (next.has(qId)) next.delete(qId)
        else next.add(qId)
        return next
      })
    } else if (e.shiftKey && selectedColumnId) {
      // Range select
      const startIdx = filteredColumns.findIndex(q => q.id === selectedColumnId)
      const endIdx = filteredColumns.findIndex(q => q.id === qId)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)]
        const range = filteredColumns.slice(lo, hi + 1).map(q => q.id)
        setBulkSelected(new Set(range))
      }
    } else {
      setBulkSelected(new Set())
      setSelectedColumn(qId)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-mm-surface flex-shrink-0">
        <DatasetTabs projectId={pid} datasetId={did} variableCount={allColumns.length} />
        <div className="w-px h-4 bg-mm-border" aria-hidden="true" />
        {dataset && <span className="text-sm text-mm-text-secondary">{dataset.name}</span>}
        <div className="flex-grow" />
        {(canUndo || canRedo) && (
          <>
            <Button variant="ghost" size="sm" onClick={() => historyUndo()}
                    disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
              <Undo2 className="w-4 h-4" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => historyRedo()}
                    disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
              <Redo2 className="w-4 h-4" aria-hidden="true" />
            </Button>
          </>
        )}
        {/* #830f — the SAME `Add ▾` the Data view renders, for the same reason
            Variable Groups left both toolbars together (below): these two views
            sit under ONE nav strip, so a create action on one and not the other
            makes two tabs of one workspace disagree about what belongs to a
            dataset.

            🔴 This view is where recode RULES are authored, and
            `PickRuleToDeriveDialog`'s empty state says so in as many words —
            so until now the flow sent researchers to the one screen that could
            not start it.

            ⚠️ ONE control added to a row of three. Measured at the 640×360 CSS
            viewport a 1280×720 window has at 200% zoom before shipping; jsdom
            computes no layout, so `DatasetToolbar.test.ts` can only proxy this
            with a count. */}
        <AddVariableMenu
          onAddVariable={() => createVariable.open('manual')}
          onAddComputed={() => createVariable.open('computed')}
          onAddRecoded={() => createVariable.open('recoded')}
          onAppendRecords={() => navigate(`/projects/${pid}/datasets/${did}/append`)}
        />

        {/* "Variable Groups" left BOTH views' toolbars together (Decision F).
            F's stated reason — the route carries no `:datasetId`, so it is
            project-scoped and does not belong to a dataset's action row — is
            just as true here, and these two views sit under ONE nav strip:
            removing it from Data and leaving it on Variables would make two
            tabs of one workspace disagree about what belongs to a dataset.
            Reachable from TopRail's Datasets menu and six other places. */}
      </div>

      {/* Body — design note E slab 2: the properties GRID is the primary surface
          (variables as rows, properties as columns), with the rule editor below
          it. A horizontal split cannot carry six property columns and the
          definitions editor at once; this keeps both full-width. */}
      {/* The split is DRAGGABLE and its size persists (2026-08-24).
          The grid was pinned at `38vh` with a hairline `border-b`: on a tall
          monitor it wasted the space, on a laptop it crowded the editors below,
          and nothing said the boundary could move. Analysis view and Qualitative
          Analysis view already own this pattern — same library, same
          `useDefaultLayout` persistence, same handle treatment — so this is the
          third instance of an established shape rather than a new one.
          ⚠️ `orientation="vertical"`: the other two split left/right. */}
      <PanelGroup
        orientation="vertical"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex-grow overflow-hidden"
      >
        <Panel id="properties" defaultSize="38" minSize="15" maxSize="75">
          {/* ⚠️ `maxHeight="100%"`, NOT a viewport unit. `ScrollableTable`
              clamps itself, so a `38vh` here would ignore the panel and dragging
              the handle would do nothing below the fold — the table would stay
              its old height inside a taller box. The PANEL owns the height now;
              the table fills it. */}
          <div className="h-full bg-mm-surface overflow-hidden">
            <VariablePropertiesGrid
              columns={filteredColumns}
              selectedColumnId={selectedColumnId}
              onSelectColumn={setSelectedColumn}
              onEditValues={col => { setSelectedColumn(col.id); revealDictionary() }}
              maxHeight="100%"
            />
          </div>
        </Panel>

        {/* The divider the developer asked to be able to see. Same treatment as
            the two existing handles, rotated: a real target band that responds
            to hover and drag, with the grip mark that says it moves. */}
        {/* ⚠️ A focusable control needs a NAME (#559). `react-resizable-panels`
            gives its Separator `role="separator"`, `tabIndex=0` and an
            `aria-valuenow`, but no label — so it announces as a bare
            "separator", on all three of this app's splitters. Measured live
            2026-08-24; the two older ones are named in the same commit rather
            than left as the drift this codebase keeps finding. */}
        <PanelResizeHandle
          aria-label="Resize the variable list and the editors below it"
          className="h-1.5 bg-mm-bg hover:bg-mm-blue/20 active:bg-mm-blue/30 transition-colors cursor-row-resize flex items-center justify-center border-y">
          <div className="h-0.5 w-8 rounded-full bg-mm-border-medium" />
        </PanelResizeHandle>

        <Panel id="editors" defaultSize="62" minSize="25">
        <div className="flex h-full overflow-hidden">
        {/* Left Panel: Question List */}
        <div className="w-[300px] border-r bg-mm-surface flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b">
            {/* #857 ride-along (#823f's naming arm, unshipped). Measured in
                Chrome's accessibility tree: this announced as a bare
                "combobox". Its only visible label is its own selected value,
                which names the CHOICE, never the control. */}
            <select
              aria-label="Filter variables by type"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="w-full h-8 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle"
            >
              <option value="all">All types</option>
              {COLUMN_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Bulk toolbar */}
          {bulkSelected.size > 0 && (
            <div className="px-3 py-2 border-b bg-mm-blue/12 flex items-center gap-2">
              <span className="text-xs text-mm-blue-text">{bulkSelected.size} selected</span>
              <select
                aria-label="Set the type of the selected variables"
                value={bulkType}
                onChange={e => setBulkType(e.target.value)}
                className="h-7 text-xs border rounded px-1 flex-grow bg-mm-surface text-mm-text border-mm-border-subtle"
              >
                {COLUMN_TYPES.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <Button
                size="sm"
                onClick={() => bulkTypeMutation.mutate()}
                disabled={bulkTypeMutation.isPending}
                className="h-7 text-xs"
              >
                Change
              </Button>
            </div>
          )}

          {/* 🔴 A LISTBOX, because this list is the ONLY way to choose which
            * variable you are working on — and it was unreachable by keyboard
            * (#823f). Measured live on the GSS corpus: 48 clickable `div`s with
            * no role and no tab stop. The properties grid beside it IS
            * navigable (roving tabindex, arrows move between gridcells) but
            * moving in it does NOT change the selected variable, so there was
            * no second route: a keyboard user could not reach the rule editor
            * for any variable but the one that happened to be selected.
            *
            * ⚠️ ONE tab stop, not 48 (#701b's rule): roving `tabIndex`, with
            * real arrow handling. Never flip the tab stops without the arrows.
            * ⚠️ NO `aria-setsize`/`aria-posinset` here, deliberately — the DOM
            * holds the whole set, and #758/#772 say not to add those by
            * analogy with the virtualised lists that need them.
            * ⚠️ Selection FOLLOWS FOCUS, which is right for a listbox that
            * drives a detail pane: arrowing is how you browse variables.
            *
            * 🔴 `aria-multiselectable` was a CLAIM THE KEYBOARD COULD NOT MEET
            * until 2026-08-26. Ctrl-click has always toggled a variable into the
            * bulk set that drives *Change type* above; nothing on the keyboard
            * did, so this attribute announced a capability only a mouse had.
            * **Ctrl+Arrow moves the cursor without selecting and Ctrl+Space
            * toggles it** — mapped in `lib/listbox-keys.ts`, which states why
            * Shift-range is deliberately not mirrored. */}
          <div
            className="flex-grow overflow-y-auto"
            role="listbox"
            aria-multiselectable="true"
            aria-label="Variables"
            onKeyDown={handleColumnListKeyDown}
          >
            {filteredColumns.map((q, idx) => {
              const isSelected = q.id === selectedColumnId
              const isBulk = bulkSelected.has(q.id)
              // The roving stop sits on the selected row; with none selected it
              // sits on the first, so the list is always enterable by Tab.
              const isTabStop = isSelected || (!selectedColumnId && idx === 0)
              return (
                <div
                  key={q.id}
                  data-column-id={q.id}
                  role="option"
                  aria-selected={isSelected || isBulk}
                  aria-current={isSelected ? 'true' : undefined}
                  tabIndex={isTabStop ? 0 : -1}
                  onClick={(e) => handleColumnClick(q.id, e)}
                  className={`px-3 py-2 border-b cursor-pointer text-sm ${FOCUS_RING} ${
                    isSelected ? SELECTED_ROW :
                    isBulk ? SELECTED_TINT :
                    'hover:bg-mm-surface-hover'
                  }`}
                >
                  {/* 🔴 #575's precedence, not a hand-rolled one. This read
                      `column_name || column_code || column_text`, putting the
                      MACHINE code ahead of the label — so on any dataset whose
                      columns carry no short name (an ordinary CSV or Excel
                      import: the header row lands in `column_text`) this list
                      showed `C003` while the properties grid above it, which
                      does route through the helper, showed the variable's name.
                      Two panels of one view, disagreeing about what a variable
                      is called, over an identifier that appears in no export,
                      chart or statistic. */}
                  <div className="flex items-center gap-1">
                    <span className="truncate flex-grow font-medium text-mm-text">
                      {columnDisplayLabel(q)}
                    </span>
                    <TypeBadge type={q.column_type} />
                  </div>
                  {/* The subtitle only earns its line when it SAYS something the
                      line above does not. It used to render whenever a name or
                      code existed, which on a name-less import meant every row
                      printed its label twice. */}
                  {columnDisplayLabel(q) !== q.column_text && (
                    <div className="text-xs text-mm-text-muted truncate mt-0.5">
                      {q.column_text.slice(0, 50)}{q.column_text.length > 50 ? '…' : ''}
                    </div>
                  )}
                  {/* The "N defs" badge and the auto-detect wand that sat here
                      read `q.recode_definitions` off `listColumns`, which has
                      never carried that field — verified live: neither had ever
                      rendered, on any dataset (the #795 half-landed-wire class).
                      The rule in effect is now a COLUMN of the properties grid
                      above, from `primary_recode`, which this payload DOES
                      carry. */}
                </div>
              )
            })}
          </div>
        </div>

        {/* Right Panel: Definition Editor */}
        {/* #857 — this pane declares a SURFACE, like the two regions beside it.
            It had none, so it fell through to the page: in light mode the page
            grey showed through, and in DARK mode it rendered as the DARKEST
            region on screen while the variable list and the properties grid
            above it were both elevated. One cause, both themes, opposite
            directions — which is why no token tweak could have fixed it.

            ⚠️ Inverting the ground inverts every raised/recessed relationship
            inside it. Elements that read as "raised" on the old grey ground
            (`bg-mm-surface`) had to become recessed wells (`bg-mm-bg`), or they
            turn white-on-white — see the saved-rule card. #810 fixed this view's
            TYPE hierarchy and correctly refused to add hue (#480); this is the
            SURFACE half it did not touch, and it is still not hue. */}
        <div className="flex-grow overflow-y-auto p-4 bg-mm-surface">
          {!selectedColumn ? (
            <div className="text-center text-mm-text-muted mt-12">
              Select a column from the left panel
            </div>
          ) : (
            <div className="max-w-2xl">
              {/* Question header */}
              <div className="mb-6">
                {headerEditing === 'name' ? (
                  <input
                    ref={headerInputRef}
                    value={headerEditValue}
                    onChange={(e) => setHeaderEditValue(e.target.value)}
                    onBlur={() => { if (!isAdvancing.current) commitHeaderEdit() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        isAdvancing.current = true
                        commitHeaderEdit()
                        advanceColumn(e.shiftKey ? -1 : 1, 'name')
                        queueMicrotask(() => { isAdvancing.current = false })
                      }
                      if (e.key === 'Escape') { e.preventDefault(); cancelHeaderEdit() }
                    }}
                    className="text-sm font-semibold text-mm-text-secondary mb-0.5 w-full border border-mm-blue/50 rounded px-1.5 py-0.5 bg-mm-surface outline-none focus:ring-1 focus:ring-ring"
                    placeholder="Short name (optional)"
                    maxLength={255}
                  />
                ) : (
                  <p
                    onClick={() => startHeaderEdit('name', selectedColumn.column_name || '')}
                    className="text-sm font-semibold text-mm-text-secondary mb-0.5 cursor-text hover:bg-mm-surface-hover rounded px-1.5 py-0.5 -mx-1.5 inline-block"
                    title={selectedColumn.column_name ? `${selectedColumn.column_name} (click to edit)` : 'Click to add a short label for this variable'}
                  >
                    {selectedColumn.column_name || <span className="text-mm-text-faint font-normal italic">Short name (optional)</span>}
                  </p>
                )}
                {headerEditing === 'text' ? (
                  <input
                    ref={headerInputRef}
                    value={headerEditValue}
                    onChange={(e) => setHeaderEditValue(e.target.value)}
                    onBlur={() => { if (!isAdvancing.current) commitHeaderEdit() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        isAdvancing.current = true
                        commitHeaderEdit()
                        advanceColumn(e.shiftKey ? -1 : 1, 'text')
                        queueMicrotask(() => { isAdvancing.current = false })
                      }
                      if (e.key === 'Escape') { e.preventDefault(); cancelHeaderEdit() }
                    }}
                    className="text-lg font-semibold text-mm-text w-full border border-mm-blue/50 rounded px-1.5 py-0.5 bg-mm-surface outline-none focus:ring-1 focus:ring-ring"
                    maxLength={500}
                  />
                ) : (
                  <h2
                    onClick={() => startHeaderEdit('text', selectedColumn.column_text)}
                    className="text-lg font-semibold text-mm-text cursor-text hover:bg-mm-surface-hover rounded px-1.5 py-0.5 -mx-1.5"
                    title={`${selectedColumn.column_text} (click to edit)`}
                  >
                    {selectedColumn.column_text}
                  </h2>
                )}
                <div className="flex items-center gap-2 mt-1">
                  {selectedColumn.column_code && (
                    <span className="text-sm text-mm-text-muted">{selectedColumn.column_code}</span>
                  )}
                  <select
                    ref={typeSelectRef}
                    aria-label="Variable type"
                    value={selectedColumn.column_type}
                    onChange={(e) => {
                      const newType = e.target.value
                      if (newType !== selectedColumn.column_type) {
                        const columnId = selectedColumn.id
                        const oldType = selectedColumn.column_type
                        const applyType = async (t: string) => {
                          await recodeApi.bulkTypeUpdate(pid, did, [columnId], t)
                          queryClient.invalidateQueries({ queryKey: ['dataset-columns', pid, did] })
                          queryClient.invalidateQueries({ queryKey: ['dataset-data', pid, did] })
                        }
                        executeHistory({
                          type: 'column_type_change',
                          description: `Change type to ${newType}`,
                          redo: () => applyType(newType),
                          undo: () => applyType(oldType),
                        })
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        advanceColumn(e.shiftKey ? -1 : 1, 'type')
                      }
                    }}
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium border-none cursor-pointer focus:ring-1 focus:ring-ring focus:outline-none ${
                      TYPE_BADGE_CLASSES[selectedColumn.column_type] || 'bg-mm-bg text-mm-text-muted'
                    }`}
                  >
                    {COLUMN_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {selectedColumn.scale_labels && (
                    <span className="text-xs text-mm-text-faint">
                      {selectedColumn.scale_points}-point
                    </span>
                  )}
                </div>
                {/*
                  Decision B provenance. Without this a derived variable is
                  indistinguishable from a hand-made manual column six months
                  later, which loses the distinction B exists to create.

                  🔴 The two fields degrade INDEPENDENTLY and both readings are
                  rendered. `derived_from_column_id` is nulled when the source is
                  deleted (ON DELETE SET NULL) while `derived_via` — a snapshot of
                  the rule's name — survives, so "derived by <rule>" stays sayable
                  with the source gone. Gating the whole block on BOTH being
                  present would throw that away, which is the shape a `&&` chain
                  falls into by default.

                  ⚠️ The source's NAME is resolved HERE, through
                  `columnDisplayLabel` — the single source for naming a column
                  (#575). The backend deliberately sends only the id.
                */}
                {selectedColumn.derived_via && (
                  <p className="mt-1.5 text-xs text-mm-text-muted">
                    Derived from{' '}
                    {(() => {
                      const src = selectedColumn.derived_from_column_id
                        ? allColumns.find(c => c.id === selectedColumn.derived_from_column_id)
                        : undefined
                      if (!src) {
                        return <span className="italic">a variable that has since been deleted</span>
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => setSelectedColumn(src.id)}
                          className="underline underline-offset-2 hover:text-mm-text focus:outline-none focus:ring-1 focus:ring-ring rounded"
                        >
                          {columnDisplayLabel(src)}
                        </button>
                      )
                    })()}
                    {' '}using <span className="font-medium">{selectedColumn.derived_via}</span>.
                  </p>
                )}
                {selectedColumn.equivalence_group_id && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/30 dark:text-indigo-300 text-xs">
                      <Link2 className="w-3 h-3" />
                      {selectedColumn.equivalence_group_label}
                    </span>
                    {definitions.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowEquivalentsSync(true)}
                        className="h-6 text-xs gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        Copy to Equivalents
                      </Button>
                    )}
                  </div>
                )}
                <VariableActions
                  column={selectedColumn}
                  onSubtypeChange={handleSubtypeChange}
                  onSwapNameLabel={handleSwapNameLabel}
                  onOpenDetails={handleOpenDetails}
                  onDelete={deleteVariable.request}
                />
              </div>

              {/* A computed variable's DEFINITION comes before what it
                  produced. Found by driving the page: with the panel below the
                  frequency table, the screen read "here are 25 difference
                  scores" and only then "here is the formula that made them",
                  which is backwards for the one variable kind whose values are
                  a consequence rather than a response. */}
              {selectedColumn.source === 'computed' && (
                <ComputedVariablePanel
                  column={selectedColumn}
                  onEditFormula={handleEditFormula}
                  onRecompute={handleRecompute}
                  isRecomputing={recomputeMutation.isPending}
                />
              )}

              {/* The variable's DICTIONARY, above its rules. Folded in from the
                  modal it used to be (design note E, slab 3): a dialog covered
                  the rules it was about to re-key, which is exactly why the
                  demote-your-primary side effect read as silent. Same component
                  for every entry point — a second editor for one job is the
                  substrate debt §10.1 indicts, and this one carries
                  #604/#606/#612/#613/#614 and the #793 guard. */}
              {/* 🔴 The gate asks TWO questions, and the second one was missing.
                  Folding the modal in (slab 3) dropped the `manual || imported`
                  block it used to live inside, so a COMPUTED variable was
                  offered a seeded value-label dictionary, a missing-value
                  tri-state and a rule editor — all three of which the backend
                  403s for `source == 'computed'`. Verified on the rendered
                  page, not inferred. Both questions now live in ONE predicate
                  (`variableRulesRefusal`) so no surface can ask only one. */}
              {variableRulesRefusal(selectedColumn) === null && (
                <div ref={dictionaryRef} className="mb-6 pb-6 border-b">
                  <ColumnDictionaryEditor
                    key={selectedColumn.id}
                    column={selectedColumn}
                    projectId={pid}
                    datasetId={did}
                  />
                </div>
              )}

              {/* Definitions — disabled for open-ended types */}
              {variableRulesRefusal(selectedColumn) !== null ? (
                <VariableRulesUnavailable
                  refusal={variableRulesRefusal(selectedColumn)!}
                  columnType={selectedColumn.column_type}
                />
              ) : (
                <>
                  {/*
                    #584's death arm. A definition whose keys no longer match
                    anything fails SILENTLY — it maps every cell to nothing and
                    the grid just shows blanks — so this banner is the only
                    place the state is visible. It says how many, because the
                    count is the part that surprises: relabelling a five-
                    definition column killed FOUR of them when measured.
                  */}
                  {rekeyPlan && rekeyPlan.length > 0 && (
                    <div
                      className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs"
                      role="note"
                    >
                      <TriangleAlert
                        className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-700 dark:text-amber-300"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-mm-text">
                          {rekeyPlan.length === 1
                            ? 'One recode on this column no longer matches any of its values.'
                            : `${rekeyPlan.length} recodes on this column no longer match any of its values.`}
                        </p>
                        <p className="text-mm-text-secondary mt-0.5">
                          This happens when a column&apos;s values are relabelled after
                          the recode was built. {rekeyPlan.length === 1 ? 'It produces' : 'They produce'}
                          {' '}no result until the values are updated.
                          {/*
                            🔴 Found by driving it. When NOTHING is translatable —
                            the ordinary outcome on a column that was already
                            labelled, because those recodes are keyed on the
                            PREVIOUS labels and nothing on disk maps those back to
                            a code — the old banner still offered "Update values…"
                            and the dialog then refused every row behind a
                            disabled button. An action that cannot act must not be
                            offered as one; say so here and let the button go and
                            SHOW the per-recode reasons instead.
                          */}
                          {rekeyActionable === 0 && (
                            <> None of them can be updated automatically, so they
                            need their values set by hand.</>
                          )}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs flex-shrink-0"
                        onClick={() => setRekeyOpen(true)}
                      >
                        {rekeyActionable === 0 ? 'See why…' : 'Update values…'}
                      </Button>
                    </div>
                  )}

                  <div className="mb-4">
                    {/* #810 — hierarchy, not hue. Every section on this page was
                        rendering at `text-xs uppercase muted`, the quietest
                        style in the system, so nothing said where to look; the
                        developer read that as "monochrome chrome". The fix is
                        NOT to re-tint (Decision F deliberately dropped the one
                        decorative colour here, and #480 allows hue only for
                        selection, CTA and status) — it is to give the page's own
                        sections the weight `ColumnDictionaryEditor` already uses
                        for its heading. Consistency with the newest component,
                        rather than a new visual language. */}
                    {/* ⚠️ "Recode rules", not "Recode Definitions": the
                        properties grid above calls the same object a **Rule**
                        ("Rule in effect"), and one page naming one thing two
                        ways is part of why the developer had to ask what "Rule
                        in effect" meant. The word "recode" is KEPT — whether
                        this object should be called a Transform instead is an
                        open design-note question with a documentation blast
                        radius, and it is the developer's call to make
                        deliberately, not a rename to fold into a layout pass. */}
                    <h3 className="text-sm font-semibold text-mm-text mb-2">
                      Recode rules ({definitions.length})
                    </h3>
                    <div className="space-y-2">
                      {defsLoading ? (
                        <div className="text-sm text-mm-text-faint">Loading definitions...</div>
                      ) : (
                        definitions.map(def => (
                          <DefinitionCard
                            key={def.id}
                            definition={def}
                            allDefinitions={definitions}
                            isExpanded={expandedDefs.has(def.id)}
                            onToggleExpand={() => toggleExpanded(def.id)}
                            onSave={(data) => updateMutation.mutate({ defId: def.id, data })}
                            onDelete={() => { void requestDelete(def) }}
                            onApply={() => setPendingApply(def)}
                            onCopyTo={() => setCopyDialogDef(def)}
                            onRederive={() => { void openRederive(def) }}
                            onDerive={() => { void derive.open({ columnId: selectedColumnId!, definition: def }) }}
                            isSaving={updateMutation.isPending}
                          />
                        ))
                      )}
                    </div>
                  </div>

                  {/* New definition form */}
                  <NewDefinitionForm
                    existingDefinitions={definitions}
                    onCreate={(data) => createMutation.mutate(data)}
                    isCreating={createMutation.isPending}
                    selectedColumn={selectedColumn}
                    frequenciesData={frequenciesData}
                  />
                </>
              )}

              {/* Reference material, BELOW the three jobs the developer named
                  (label values, declare missing, recode into a new variable).
                  It used to sit above all three, which on an ordinary survey
                  variable is what pushed them off the screen — position reads as
                  priority. ⚠️ `key` resets the fold per variable; see the
                  component. */}
              <ValueFrequenciesPanel key={selectedColumn.id} data={frequenciesData} />
            </div>
          )}
        </div>
        </div>
        </Panel>
      </PanelGroup>

      {/* Copy-to dialog (within same dataset) */}
      {copyDialogDef && (
        <CopyToDialog
          open={!!copyDialogDef}
          onClose={() => setCopyDialogDef(null)}
          columns={allColumns}
          currentColumnId={selectedColumnId!}
          definitionName={copyDialogDef.name}
          onCopy={(ids) => copyToMutation.mutate({ defId: copyDialogDef.id, targetIds: ids })}
          isCopying={copyToMutation.isPending}
        />
      )}

      {/*
        * #584 — deleting a source orphans what was derived from it.
        *
        * The wording states the CONSEQUENCE rather than the relationship: a
        * dependent keeps working (it carries its own copy of the mapping), so
        * "3 definitions depend on this" reads as harmless. What is actually
        * lost is the link back — after this, nothing can tell a derived
        * definition from a hand-authored one, including the startup repair.
        *
        * ⛔ No "delete them too" action, deliberately: those definitions may be
        * driving numbers a researcher has already reported.
        */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.dependents.length === 0
                ? `Delete "${pendingDelete?.name}"?`
                : pendingDelete?.dependents.length === 1
                  ? 'One definition was derived from this one'
                  : `${pendingDelete?.dependents.length} definitions were derived from this one`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/* The in-effect disclosure comes FIRST when it applies: it is
                  about the researcher's data, while the dependents note is
                  about other rules. */}
              {pendingDelete?.inEffect && (
                <span className="block mb-2">
                  <strong>&ldquo;{pendingDelete?.name}&rdquo; is currently in effect.</strong>{' '}
                  The numbers it produced will stay exactly as they are — deleting the rule
                  does not restore what applying it replaced, because those values are not
                  kept anywhere. The variable will simply no longer say which rule produced
                  its numbers.
                </span>
              )}
              {pendingDelete?.dependents.length === 0 ? null : (<>
              {pendingDelete?.dependents.map(d => `"${d.name}"`).join(', ')}
              {pendingDelete?.dependents.length === 1 ? ' was' : ' were'} built from
              {' '}"{pendingDelete?.name}". Deleting it does not change{' '}
              {pendingDelete?.dependents.length === 1 ? 'that definition' : 'those definitions'} —
              {pendingDelete?.dependents.length === 1 ? ' it keeps' : ' they keep'} the mapping
              {pendingDelete?.dependents.length === 1 ? ' it was' : ' they were'} given — but the
              record of where {pendingDelete?.dependents.length === 1 ? 'it' : 'they'} came from is
              lost, so nothing can re-derive or repair
              {pendingDelete?.dependents.length === 1 ? ' it' : ' them'} later.
              </>)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) deleteMutation.mutate(pendingDelete.defId)
                setPendingDelete(null)
              }}
            >
              Delete anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The two property forms the popover thinning moved here (design note E).
          Same `ColumnFormDialog` the Data view used — relocating the ENTRY
          POINT, never re-implementing the editor. */}
      <ColumnFormDialog
        open={!!detailsColumn}
        onOpenChange={(o) => { if (!o) { setDetailsColumn(null); setDetailsError(null) } }}
        onSubmit={(data) => {
          if (detailsColumn) {
            detailsMutation.mutate({ columnId: detailsColumn.id, data: data as ManualColumnUpdate })
          }
        }}
        isSubmitting={detailsMutation.isPending}
        submitError={detailsError}
        initial={detailsColumn}
        title="Variable details"
      />

      <ColumnFormDialog
        open={!!formulaColumn}
        onOpenChange={(o) => { if (!o) { setFormulaColumn(null); setFormulaError(null) } }}
        onSubmit={(data) => {
          if (!formulaColumn) return
          // Undo parity with the Data view, which has recorded this edit since
          // it shipped. The reversal restores the PREVIOUS expression, which is
          // the whole of what a formula edit changes.
          const columnId = formulaColumn.id
          const oldExpression = formulaColumn.expression || ''
          const newData = data as ComputedColumnUpdate
          executeHistory({
            type: 'computed_column_update',
            description: `Update formula for ${formulaColumn.column_text}`,
            redo: async () => { await formulaMutation.mutateAsync({ columnId, data: newData }) },
            undo: async () => {
              await formulaMutation.mutateAsync({ columnId, data: { expression: oldExpression } })
            },
          })
        }}
        isSubmitting={formulaMutation.isPending}
        submitError={formulaError}
        initial={formulaColumn}
        title="Computed variable details"
        mode="computed"
        projectId={pid}
        datasetId={did}
        availableColumns={allColumns}
      />

      {/* #584 step 2 — re-derive dependents from a source definition. */}
      <ApplyRuleDialog
        open={pendingApply !== null}
        definition={pendingApply}
        variableLabel={selectedColumn ? columnDisplayLabel(selectedColumn) : ''}
        columnType={selectedColumn?.column_type}
        isPending={setPrimaryMutation.isPending}
        onCancel={() => setPendingApply(null)}
        onConfirm={() => { if (pendingApply) setPrimaryMutation.mutate(pendingApply.id) }}
      />

      {/* #830f — the three kinds of new variable, from the shared hook. */}
      <ColumnFormDialog {...createVariable.manualDialogProps} title="Add Variable" />
      <ColumnFormDialog
        {...createVariable.computedDialogProps}
        title="Add Computed Variable"
        mode="computed"
        projectId={pid}
        datasetId={did}
        availableColumns={allColumns}
      />
      <PickRuleToDeriveDialog
        open={createVariable.isRecodedPickerOpen}
        columns={allColumns}
        variablesHref={variableViewPath(pid, did)}
        onOpenChange={(o) => { if (!o) createVariable.close() }}
        onPick={(columnId, definition) => {
          createVariable.close()
          void derive.open({ columnId, definition })
        }}
      />

      {/* 🔴 The source is the hook's `sourceColumnId`, NOT the page's selection.
          Those coincided while the only way in was a rule card on the selected
          variable; `Add ▾ → Recoded variable...` can pick ANY variable's rule,
          and reading the selection would then name the wrong variable in the
          confirm — on the one dialog whose whole job is to say what is about to
          be derived from what. The hook exposes `sourceColumnId` for exactly
          this, and the Data view has resolved it that way since Stage 3. */}
      <DeriveVariableDialog
        {...derive.dialogProps}
        sourceLabel={(() => {
          const src = allColumns.find(c => c.id === derive.sourceColumnId)
          return src ? columnDisplayLabel(src) : 'the source variable'
        })()}
      />

      {/* The SAME dialog the Data view renders, from the same hook (#812). */}
      <DeleteVariableDialog {...deleteVariable.dialogProps} />

      <RederiveDependentsDialog
        open={rederiveFor !== null}
        sourceName={rederiveFor?.name ?? ''}
        plan={rederivePlan}
        isPending={rederiveMutation.isPending}
        onCancel={() => { setRederiveFor(null); setRederivePlan(null) }}
        onConfirm={(ids) => rederiveMutation.mutate(ids)}
      />

      {/* #584's death arm — re-key this column's relabel-killed definitions. */}
      <RekeyDefinitionsDialog
        open={rekeyOpen}
        columnLabel={selectedColumn ? columnDisplayLabel(selectedColumn) : ''}
        plan={rekeyPlan ?? null}
        isPending={rekeyMutation.isPending}
        onCancel={() => setRekeyOpen(false)}
        onConfirm={(ids) => rekeyMutation.mutate(ids)}
      />

      {/* Copy to Equivalents — after creating a new definition */}
      {showEquivalentsAfterCreate && selectedColumn?.equivalence_group_id && (
        <CopyToEquivalentsDialog
          open={!!showEquivalentsAfterCreate}
          onClose={() => setShowEquivalentsAfterCreate(null)}
          sourceColumn={selectedColumn}
          definitions={[showEquivalentsAfterCreate]}
          equivalenceGroupId={selectedColumn.equivalence_group_id}
          projectId={pid}
          onCopyComplete={() => setShowEquivalentsAfterCreate(null)}
        />
      )}

      {/* Copy to Equivalents — sync all definitions */}
      {showEquivalentsSync && selectedColumn?.equivalence_group_id && (
        <CopyToEquivalentsDialog
          open={showEquivalentsSync}
          onClose={() => setShowEquivalentsSync(false)}
          sourceColumn={selectedColumn}
          definitions={definitions}
          equivalenceGroupId={selectedColumn.equivalence_group_id}
          projectId={pid}
          onCopyComplete={() => setShowEquivalentsSync(false)}
        />
      )}
    </div>
  )
}
