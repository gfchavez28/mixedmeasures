/**
 * #584's death arm — the confirm for re-keying definitions a relabel killed.
 *
 * ## What this is repairing, in the researcher's terms
 *
 * They gave a column value labels, so its cells now read "Strongly agree" where
 * they used to read "5". Any recode they had already built is keyed on "5" and
 * quietly stopped matching anything. This renames those keys.
 *
 * ## Why `blocked` rows have no checkbox
 *
 * 🔴 A blocked definition's old values cannot be matched to a code — most often
 * because it was keyed on a PREVIOUS set of labels, which the relabel overwrote
 * everywhere. There is nothing to translate through, the server 409s a batch
 * containing one, and a selectable control that always fails is a control that
 * lies about what it does. The row still shows WHICH values could not be
 * matched, because that is what makes fixing it by hand possible.
 */
import { useState, useEffect } from 'react'
import { TriangleAlert, Info, ArrowRight } from 'lucide-react'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import type { RekeyPlanItem } from '@/lib/api'
import { STATUS_BLOCKED, isSelectable } from '@/lib/rekey-status'

/** The three recode types, in the workbench's own wording. */
const RECODE_TYPE_LABEL: Record<string, string> = {
  scale_map: 'Scale Map',
  category_group: 'Category',
  reverse: 'Reverse',
}

interface Props {
  open: boolean
  columnLabel: string
  plan: RekeyPlanItem[] | null
  isPending: boolean
  onCancel: () => void
  onConfirm: (definitionIds: number[]) => void
}

export default function RekeyDefinitionsDialog({
  open, columnLabel, plan, isPending, onCancel, onConfirm,
}: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!plan) return
    // Seeding from an async prop is this effect's whole job — the plan is
    // fetched after the dialog opens, so there is no render-time value to
    // derive it from.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds from an async prop
    setSelected(new Set(plan.filter(isSelectable).map(p => p.definition_id)))
  }, [plan])

  const ready = (plan ?? []).filter(isSelectable)
  const blocked = (plan ?? []).filter(p => p.status === STATUS_BLOCKED)
  const chosen = [...selected]
  // 🔴 Conditional on the SELECTION, not on what is present — the warning has to
  // describe what this button is about to do. Only a PRIMARY definition writes
  // value_numeric; for every other one this renames keys and nothing else.
  // (The drift dialog shipped the unconditional form and contradicted itself on
  // screen, one line above a row saying the opposite.)
  const anySelectedPrimary = (plan ?? []).some(
    p => selected.has(p.definition_id) && p.is_primary
  )

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Update recodes for &ldquo;{columnLabel}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/*
              🔴 THREE branches, and the third was found by driving it. With
              nothing translatable the two-branch version still read "Renaming
              their values makes them work again" above rows that each say the
              opposite — a promise the disabled button could not keep. A
              description has to describe the state it is actually in.
            */}
            {plan !== null && plan.length > 0 && ready.length === 0
              ? 'These recodes were built against this column’s old values, so '
                + 'they currently match nothing — and their values cannot be '
                + 'matched to this column’s codes, so none of them can be '
                + 'repaired automatically. Here is what each one is missing.'
              : anySelectedPrimary
                ? 'These recodes were built against this column’s old values. '
                  + 'Renaming them changes stored scores, so anything already '
                  + 'exported or reported will no longer match.'
                : 'These recodes were built against this column’s old values, '
                  + 'so they currently match nothing. Renaming their values makes '
                  + 'them work again. None of the selected recodes is primary, so '
                  + 'no stored scores change.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {plan === null ? (
          <div className="text-xs text-mm-text-faint py-2">Checking recodes…</div>
        ) : plan.length === 0 ? (
          <div className="text-xs text-mm-text-faint py-2">
            Every recode on this column still matches its values.
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {plan.map(item => {
              const selectable = isSelectable(item)
              return (
                <div
                  key={item.definition_id}
                  className="flex items-start gap-2 px-2 py-1.5 rounded border border-mm-border-subtle text-xs"
                >
                  {selectable ? (
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(item.definition_id)}
                      aria-label={`Update ${item.name}`}
                      onCheckedChange={(v) => {
                        setSelected(prev => {
                          const next = new Set(prev)
                          if (v) next.add(item.definition_id)
                          else next.delete(item.definition_id)
                          return next
                        })
                      }}
                    />
                  ) : (
                    <span className="mt-0.5 w-4 flex-shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="font-medium text-mm-text flex items-center gap-1.5">
                      {item.name}
                      {/*
                        The TYPE, because a name is not always unique: relabelling
                        a column mints a fresh auto primary that can carry the
                        same generated name as the definition it demoted (seen on
                        the dev corpus — two "5-point scale" rows). A confirm has
                        to say which row it means.
                      */}
                      <span className="font-normal text-mm-text-faint">
                        {RECODE_TYPE_LABEL[item.recode_type] ?? item.recode_type}
                      </span>
                      {item.status === STATUS_BLOCKED && (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                          <TriangleAlert className="w-3 h-3" aria-hidden="true" />
                          Can&apos;t update automatically
                        </span>
                      )}
                    </div>
                    <div className="text-mm-text-secondary">{item.detail}</div>
                    {item.renames.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-mm-text-faint">
                        {item.renames.map(r => (
                          <li key={r.old} className="flex items-center gap-1">
                            <span>{r.old}</span>
                            <ArrowRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                            <span>{r.new}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {blocked.length > 0 && (
          <div
            className="flex items-start gap-1.5 px-2 py-1.5 rounded bg-mm-blue/12 border border-mm-blue/30 text-[11px] text-mm-blue-text"
            role="note"
          >
            <Info className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>
              {blocked.length === 1 ? 'One recode cannot' : `${blocked.length} recodes cannot`}
              {' '}be updated automatically and {blocked.length === 1 ? 'is' : 'are'} left
              alone. Open {blocked.length === 1 ? 'it' : 'them'} in the workbench and set
              the values by hand.
            </span>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending || chosen.length === 0 || ready.length === 0}
            onClick={() => onConfirm(chosen)}
          >
            {isPending
              ? 'Updating…'
              : `Update ${chosen.length} recode${chosen.length === 1 ? '' : 's'}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
