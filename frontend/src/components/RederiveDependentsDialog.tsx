/**
 * #584 step 2 — the confirm for re-deriving dependents from their source.
 *
 * ## Why this is a dialog and not a toast button
 *
 * Re-deriving rewrites stored numbers a researcher may already have reported.
 * This project treats that as release-note-worthy when done deliberately (#710),
 * so the researcher sees WHICH definitions move and WHICH values change before
 * anything is written. A confirm that cannot name what it is about to change is
 * not informed consent.
 *
 * ## Why `blocked` is not a checkbox they can tick anyway
 *
 * 🔴 A blocked dependent shares no mapping values with the source — the
 * label-remapped crosswalk copy. Copying onto it would write keys no cell
 * carries and silently NULL the column on the next apply. The server refuses the
 * whole batch if one is included (409), so the UI must not offer it as a choice:
 * an unselectable row with a reason is honest, a selectable one that always
 * fails is not.
 */
import { useState, useEffect } from 'react'
import { TriangleAlert, Info, CircleCheck } from 'lucide-react'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import type { RederivePlanItem } from '@/lib/api'
import { STATUS_NO_CHANGE, STATUS_BLOCKED, isSelectable } from '@/lib/rederive-status'

interface Props {
  open: boolean
  sourceName: string
  plan: RederivePlanItem[] | null
  isPending: boolean
  onCancel: () => void
  onConfirm: (definitionIds: number[]) => void
}

export default function RederiveDependentsDialog({
  open, sourceName, plan, isPending, onCancel, onConfirm,
}: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Every ready row starts selected: the researcher opened this to re-derive,
  // and the blocked ones are excluded by construction rather than by them
  // noticing. Re-seeded whenever a fresh plan arrives.
  useEffect(() => {
    if (!plan) return
    // Resetting selection when a NEW plan arrives is the whole job of this
    // effect; the plan is fetched async after the dialog opens, so there is no
    // render-time value to derive it from.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds from an async prop
    setSelected(new Set(plan.filter(isSelectable).map(p => p.definition_id)))
  }, [plan])

  const ready = (plan ?? []).filter(isSelectable)
  const anySelectedPrimary = (plan ?? []).some(p => selected.has(p.definition_id) && p.is_primary)
  const blocked = (plan ?? []).filter(p => p.status === STATUS_BLOCKED)
  const chosen = [...selected]

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Re-derive from &ldquo;{sourceName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/*
              🔴 CONDITIONAL, and found by driving it. An unconditional "this
              changes stored scores" sat directly above a per-row detail reading
              "This definition is not primary, so no stored scores change" — the
              dialog contradicted itself on screen, and the researcher has no way
              to tell which claim is the real one. Only a PRIMARY dependent writes
              value_numeric; for the rest this edits the mapping and nothing else.
            */}
            {anySelectedPrimary
              ? 'This changes stored scores. Anything already exported or reported '
                + 'from these definitions will no longer match.'
              : 'This updates the mappings below to match the source. None of the '
                + 'selected definitions is primary, so no stored scores change.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {plan === null ? (
          <div className="text-xs text-mm-text-faint py-2">Checking dependents…</div>
        ) : plan.length === 0 ? (
          <div className="text-xs text-mm-text-faint py-2">
            Nothing derives from this definition.
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
                      aria-label={`Re-derive ${item.name}`}
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
                      {item.status === STATUS_BLOCKED && (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                          <TriangleAlert className="w-3 h-3" aria-hidden="true" />
                          Can&apos;t re-derive
                        </span>
                      )}
                      {item.status === STATUS_NO_CHANGE && (
                        <span className="inline-flex items-center gap-1 text-mm-text-faint">
                          <CircleCheck className="w-3 h-3" aria-hidden="true" />
                          Already matches
                        </span>
                      )}
                    </div>
                    <div className="text-mm-text-secondary">{item.detail}</div>
                    {item.changed_keys.length > 0 && (
                      <div className="text-mm-text-faint mt-0.5">
                        Values changing: {item.changed_keys.join(', ')}
                      </div>
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
              {blocked.length === 1 ? 'One definition cannot' : `${blocked.length} definitions cannot`}
              {' '}be re-derived from this source and {blocked.length === 1 ? 'is' : 'are'} left
              alone. Edit {blocked.length === 1 ? 'it' : 'them'} directly instead.
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
              ? 'Re-deriving…'
              : `Re-derive ${chosen.length} definition${chosen.length === 1 ? '' : 's'}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
