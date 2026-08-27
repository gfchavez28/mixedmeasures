/**
 * Step one of `Add ▾ → Recoded variable…`: choose the variable and the rule
 * (design-note §11 / Decision B Stage 3, 2026-08-24).
 *
 * ## Why this step exists at all — the difference from jamovi
 *
 * jamovi's `Add` offers **Data Variable / Computed Variable / Transformed
 * Variable**, and its Transformed kind lets you define the transform inline. MM
 * cannot: deriving needs a saved `RecodeDefinition`, which is authored in the
 * Variables view. So the menu item has to ASK which rule, and it has to cope
 * with the common case where the answer is "you haven't written one yet".
 *
 * ⚠️ **That case is the common one.** In the developer's own corpus 3 of 88
 * variables carry a rule. An empty state that says where rules are made is
 * therefore the main thing this dialog does, not an edge case bolted on.
 *
 * ## Why the variable list is filtered rather than shown-and-disabled
 *
 * The project's gated-entry-point rule says hiding a thing removes the surface
 * where its absence is discoverable — which is why identifier columns stay
 * VISIBLE in the crosswalk and are refused at assignment. It does not apply
 * here: a list of 88 variables with 3 selectable is noise, and the empty state
 * below carries the discoverability instead, naming where rules come from.
 *
 * ## Where the data comes from
 *
 * `GET …/data` returns EVERY column (only `rows` is paged, #800) with
 * `recode_definitions` joined-loaded — and it is the only payload that carries
 * them for all variables at once; `listColumns`, which the Variables view uses,
 * has never had the field. So this dialog needs no fetch of its own.
 */
import { useState, useMemo, useId } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { columnDisplayLabel } from '@/lib/dataset-column-label'
import type { DatasetColumn, RecodeDefinitionSummary } from '@/lib/api'

interface Props {
  open: boolean
  columns: DatasetColumn[]
  /** Where a researcher goes to write a rule — the empty state links here. */
  variablesHref: string
  onOpenChange: (open: boolean) => void
  onPick: (columnId: number, definition: Pick<RecodeDefinitionSummary, 'id' | 'name'>) => void
}

export default function PickRuleToDeriveDialog({
  open, columns, variablesHref, onOpenChange, onPick,
}: Props) {
  const [columnId, setColumnId] = useState<number | null>(null)
  const [definitionId, setDefinitionId] = useState<number | null>(null)
  const varId = useId()
  const ruleId = useId()

  const withRules = useMemo(
    () => columns.filter(c => (c.recode_definitions?.length ?? 0) > 0),
    [columns],
  )
  const chosen = withRules.find(c => c.id === columnId) ?? null
  const rules = chosen?.recode_definitions ?? []
  const chosenRule = rules.find(r => r.id === definitionId) ?? null

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) { setColumnId(null); setDefinitionId(null) }
      onOpenChange(o)
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New variable from a recode rule</DialogTitle>
          <DialogDescription>
            Choose a variable and one of its saved rules. The result is stored in a new
            variable and the original is left untouched.
          </DialogDescription>
        </DialogHeader>

        {withRules.length === 0 ? (
          /* The empty state IS the feature for most datasets — see the header
             comment. It names where rules come from rather than saying "none". */
          <p className="text-sm text-mm-text-muted py-2">
            No variable in this dataset has a saved recode rule yet. Rules are written in
            the{' '}
            <a href={variablesHref} className="underline underline-offset-2">Variables view</a>
            {' '}— open a variable there, add a rule, and it will appear here.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={varId} className="text-xs font-medium text-mm-text-muted">
                Variable
              </label>
              <select
                id={varId}
                value={columnId ?? ''}
                onChange={(e) => {
                  setColumnId(e.target.value ? Number(e.target.value) : null)
                  setDefinitionId(null)
                }}
                className="w-full h-9 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle"
              >
                <option value="">Select a variable...</option>
                {withRules.map(c => (
                  <option key={c.id} value={c.id}>{columnDisplayLabel(c)}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={ruleId} className="text-xs font-medium text-mm-text-muted">
                Rule
              </label>
              <select
                id={ruleId}
                value={definitionId ?? ''}
                disabled={!chosen}
                onChange={(e) => setDefinitionId(e.target.value ? Number(e.target.value) : null)}
                className="w-full h-9 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle disabled:opacity-50"
              >
                <option value="">
                  {chosen ? 'Select a rule...' : 'Choose a variable first'}
                </option>
                {rules.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}{r.is_primary ? ' — in effect' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!chosen || !chosenRule}
            onClick={() => {
              if (chosen && chosenRule) {
                onPick(chosen.id, { id: chosenRule.id, name: chosenRule.name })
                onOpenChange(false)
              }
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
