/**
 * Decision B — create a NEW variable from a recode rule, leaving the source alone.
 *
 * ## Why a dialog rather than a one-click button
 *
 * Three things must be settled before anything is written, and none of them has a
 * safe default the researcher would not want to see:
 *
 * 1. **The name.** A derived variable they cannot find is worse than none.
 * 2. **Whether the value labels come across.** §8 of the design note blocked this
 *    whole decision on that question. It is answerable — the dictionary re-pairs
 *    onto the new codes — but a reverse score's labels end up in a different
 *    order, and that is exactly the kind of thing a researcher should agree to
 *    rather than discover.
 * 3. **What the rule does NOT cover.** Unmapped responses are carried across with
 *    no code. #794's rule is that a partial match is disclosed, never prevented —
 *    and a disclosure that arrives only in a toast afterwards is one the
 *    researcher has already acted on.
 *
 * The plan is fetched from the server rather than computed here, and the endpoint
 * serving it calls the same function the create does. A preview computed by
 * different code from the operation is a preview that can be wrong (#795).
 */
import { useState, useEffect, useId } from 'react'
import { TriangleAlert, Info, ArrowRight } from 'lucide-react'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { DerivePlan } from '@/lib/api'

interface Props {
  open: boolean
  sourceLabel: string
  ruleName: string
  plan: DerivePlan | null
  isPending: boolean
  onCancel: () => void
  onConfirm: (name: string, carryLabels: boolean) => void
}

/** How many mapped pairs to show before summarising. A 500-code dictionary is
 *  legal (`MAX_VALUE_LABELS`), and this dialog must not become the unbounded
 *  table #809 filed against the Variables view one surface over. */
const PREVIEW_LIMIT = 6

export default function DeriveVariableDialog({
  open, sourceLabel, ruleName, plan, isPending, onCancel, onConfirm,
}: Props) {
  const [name, setName] = useState('')
  const [carryLabels, setCarryLabels] = useState(false)
  const nameId = useId()
  const carryId = useId()

  // The plan arrives async after the dialog opens, so there is no render-time
  // value to derive these from. Labels default ON when available: the researcher
  // almost always wants them, and the alternative — a derived variable of bare
  // numbers — is the SPSS `RECODE … INTO` defect the design note §4 names.
  useEffect(() => {
    if (!plan) return
    // One directive covers the effect body — a second is an ORPHAN, and this
    // project treats those as gate failures (#727: a plugin bump orphans
    // directives by relocating its findings, so an unused one is never noise).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds from an async prop
    setName(plan.suggested_name)
    setCarryLabels(plan.labels.available)
  }, [plan])

  const trimmed = name.trim()
  const shown = plan ? plan.mapped.slice(0, PREVIEW_LIMIT) : []
  const hidden = plan ? plan.mapped.length - shown.length : 0

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Create a new variable from &ldquo;{ruleName}&rdquo;</AlertDialogTitle>
          <AlertDialogDescription>
            {/*
              The reassurance IS the feature. The developer's original report was
              that MM "is trying to do the latter without creating a separate
              variable", so the sentence that matters most here is the one saying
              the original is left alone.
            */}
            The results are stored in a new variable. <strong>{sourceLabel}</strong> is
            left exactly as it is.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {plan === null ? (
          <div className="text-xs text-mm-text-faint py-2">Working out what this would produce…</div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={nameId} className="text-xs font-medium text-mm-text-muted">
                Name for the new variable
              </label>
              <Input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
              />
            </div>

            {shown.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-xs font-medium text-mm-text-muted">What it will contain</h3>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Each response in {sourceLabel} and the value the new variable will hold for it.
                    </caption>
                    <thead>
                      <tr className="bg-mm-bg text-xs text-mm-text-muted">
                        <th scope="col" className="text-left py-1.5 px-3">Response</th>
                        <th scope="col" className="text-left py-1.5 px-3">Becomes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map(([from, to]: [string, string]) => (
                        <tr key={from} className="border-t">
                          <td className="py-1 px-3">{from}</td>
                          <td className="py-1 px-3 font-medium">
                            {/* aria-hidden: the arrow is decoration, and the
                                column header already says "Becomes". */}
                            <ArrowRight className="w-3 h-3 inline mr-1.5 text-mm-text-faint" aria-hidden="true" />
                            {to}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {hidden > 0 && (
                  <p className="text-xs text-mm-text-faint">
                    …and {hidden} more {hidden === 1 ? 'response' : 'responses'}.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-start gap-2">
              <Checkbox
                id={carryId}
                checked={carryLabels}
                disabled={!plan.labels.available}
                onCheckedChange={(c) => setCarryLabels(c === true)}
                aria-describedby={plan.labels.available ? undefined : `${carryId}-why`}
              />
              <div className="space-y-0.5">
                <label
                  htmlFor={carryId}
                  className={`text-sm ${plan.labels.available ? '' : 'text-mm-text-faint'}`}
                >
                  Carry the value labels across
                </label>
                {/*
                  ⚠️ The REASON always renders when the box is off. Four different
                  states disable it and they send the researcher to four different
                  places — "there are no labels to carry" is a completely different
                  next step from "this rule merges responses, so the merged
                  categories need names you choose". A disabled control with no
                  reason reads as a broken tool.
                */}
                {!plan.labels.available && plan.labels.reason && (
                  <p id={`${carryId}-why`} className="text-xs text-mm-text-faint">
                    {plan.labels.reason}
                  </p>
                )}
                {plan.labels.available && (
                  <p className="text-xs text-mm-text-faint">
                    Re-paired onto the new values, so each response keeps its own label.
                  </p>
                )}
              </div>
            </div>

            {plan.unmapped_values.length > 0 && (
              <div className="flex items-start gap-2 p-2 rounded bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-700 dark:text-amber-300">
                <TriangleAlert className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden="true" />
                <p>
                  <strong>&ldquo;{ruleName}&rdquo; does not cover
                  {' '}{plan.unmapped_values.length === 1 ? 'one response' : `${plan.unmapped_values.length} responses`}:</strong>
                  {' '}{plan.unmapped_values.slice(0, 5).join(', ')}
                  {plan.unmapped_values.length > 5 && ` and ${plan.unmapped_values.length - 5} more`}.
                  {' '}They are copied across with no value, so nothing is lost — but they will not
                  be counted in analysis until the rule covers them.
                </p>
              </div>
            )}

            {plan.missing_values_carried.length > 0 && (
              <div className="flex items-start gap-2 p-2 rounded bg-mm-bg text-xs text-mm-text-muted">
                <Info className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden="true" />
                <p>
                  Missing responses ({plan.missing_values_carried.slice(0, 3).join(', ')}
                  {plan.missing_values_carried.length > 3 && ', …'}) come across as they are,
                  along with this variable&rsquo;s missing-value rules.
                </p>
              </div>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending || plan === null || trimmed.length === 0}
            onClick={(e) => {
              // Radix closes on action click; the mutation owns closing so a
              // failure can keep the dialog up with the error visible.
              e.preventDefault()
              onConfirm(trimmed, carryLabels)
            }}
          >
            {isPending ? 'Creating…' : 'Create variable'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
