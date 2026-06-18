/**
 * SuggestionGhostRow — visual ghost-bracket rendering for one DomainSuggestion.
 *
 * Three visual states drive ghost styling:
 *   - confident:  cross-dataset cluster with `members_paired` populated.
 *                 Amber accent. Shows pair-pill list grouped by EG.
 *   - unpaired:   cross-dataset cluster where auto-pair couldn't decide.
 *                 Greyed accent. "Manual pairing required after creation."
 *   - single:     single-dataset cluster (no pairing needed).
 *                 Green accent. Standard list of members.
 *
 * Per-row actions:
 *   - Accept   → fires onAccept(suggestion) which the parent handles via
 *                bulkCreateDomainsMutation with optional inline EGs.
 *   - Edit     → fires onEdit(suggestion) — opens a rename dialog (parent).
 *   - Dismiss  → fires onDismiss(index) — parent stores indices in a Set.
 *
 * a11y:
 *   - Wraps the ghost in role="region" with aria-label that describes the
 *     cluster + auto-pair confidence. Screen-reader users hear the proposed
 *     pairing before the action buttons.
 *   - Action buttons have aria-label tying them to the suggestion name.
 *
 * Visual rhythm: matches Bracket's `mb-5 flex items-stretch gap-[10px]`
 * outer pattern + 210px label gutter so ghost rows align with real brackets
 * in the grid.
 */

import { useMemo } from 'react'
import type { DomainSuggestion } from '@/lib/api/analysis-domains'
import { Button } from '@/components/ui/button'
import { Sparkles, Check, Pencil, X, AlertTriangle, Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getGhostState } from './ghost-state'

interface SuggestionGhostRowProps {
  suggestion: DomainSuggestion
  index: number
  isAccepting?: boolean
  onAccept: (suggestion: DomainSuggestion) => void
  onEdit?: (suggestion: DomainSuggestion, index: number) => void
  onDismiss: (index: number) => void
}

export function SuggestionGhostRow({
  suggestion,
  index,
  isAccepting = false,
  onAccept,
  onEdit,
  onDismiss,
}: SuggestionGhostRowProps) {
  const state = getGhostState(suggestion)

  const { members, members_paired } = suggestion

  // Group members by dataset for display.
  const byDataset = useMemo(() => {
    const map = new Map<number, { dataset_name: string; members: typeof members }>()
    for (const m of members) {
      const dsId = m.dataset_id ?? -1
      const dsName = m.dataset_name ?? `Dataset ${dsId}`
      if (!map.has(dsId)) {
        map.set(dsId, { dataset_name: dsName, members: [] })
      }
      map.get(dsId)!.members.push(m)
    }
    return Array.from(map.entries()).map(([dataset_id, info]) => ({
      dataset_id,
      ...info,
    }))
  }, [members])

  // Pair label lookup for confident state — for each column ID, which slot is it in?
  const pairSlotByColumnId = useMemo(() => {
    const map = new Map<number, number>()
    members_paired.forEach((slot, slotIdx) => {
      for (const colId of slot) {
        map.set(colId, slotIdx)
      }
    })
    return map
  }, [members_paired])

  const datasetCount = byDataset.length
  const memberCount = suggestion.members.length

  // a11y label
  const ariaLabel =
    state === 'confident'
      ? `Suggested variable group: ${suggestion.name} — ${memberCount} columns auto-paired across ${datasetCount} datasets`
      : state === 'unpaired'
        ? `Suggested variable group: ${suggestion.name} — ${memberCount} columns across ${datasetCount} datasets, pairing inconclusive`
        : `Suggested variable group: ${suggestion.name} — ${memberCount} columns in ${byDataset[0]?.dataset_name ?? 'one dataset'}`

  const accentClasses = {
    label: {
      confident: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100',
      unpaired: 'border-mm-border-medium bg-mm-bg text-mm-text-muted',
      single: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
    }[state],
    frame: {
      confident: 'border-amber-300 bg-amber-50/40 dark:border-amber-700 dark:bg-amber-950/20',
      unpaired: 'border-mm-border-medium bg-mm-bg/60',
      single: 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-700 dark:bg-emerald-950/20',
    }[state],
  }

  return (
    <section
      role="region"
      aria-label={ariaLabel}
      data-testid={`suggestion-ghost-${index}`}
      data-state={state}
      className="mb-5 flex items-stretch gap-[10px]"
    >
      {/* Label gutter — matches Bracket's 210px column */}
      <div
        className={cn(
          'w-[210px] flex-none flex flex-col px-3 py-3 rounded-l-md border-2 border-dashed',
          accentClasses.label,
        )}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <Sparkles className="w-3.5 h-3.5 flex-none" aria-hidden />
          <span className="text-xs font-medium truncate" title={suggestion.name}>
            {suggestion.name}
          </span>
        </div>
        <span className="text-[10px] text-mm-text-muted leading-snug">
          {memberCount} {memberCount === 1 ? 'column' : 'columns'} · {datasetCount}{' '}
          {datasetCount === 1 ? 'dataset' : 'datasets'}
        </span>
        {state === 'confident' && suggestion.pairing_reason && (
          <span
            className="text-[10px] text-mm-text-muted leading-snug mt-1 italic"
            title={`Pairing reason: ${suggestion.pairing_reason}`}
          >
            Auto-paired
          </span>
        )}
        {state === 'unpaired' && (
          <span className="inline-flex items-center gap-1 text-[10px] text-mm-text-muted leading-snug mt-1">
            <AlertTriangle className="w-3 h-3" aria-hidden />
            Pair manually
          </span>
        )}
      </div>

      {/* Frame — member preview + actions */}
      <div
        className={cn(
          'flex-1 min-w-0 flex flex-col px-4 py-3 rounded-r-md border-2 border-dashed',
          accentClasses.frame,
        )}
      >
        {/* Member preview — grouped by dataset */}
        <div className="flex flex-col gap-1.5 mb-3">
          {byDataset.map(ds => (
            <div key={ds.dataset_id} className="flex items-baseline gap-2">
              <span className="text-[11px] text-mm-text-muted font-medium w-24 flex-none truncate">
                {ds.dataset_name}
              </span>
              <span className="flex-1 min-w-0 flex flex-wrap gap-1.5">
                {ds.members.map(m => {
                  const slotIdx = pairSlotByColumnId.get(m.member_id)
                  return (
                    <span
                      key={m.member_id}
                      className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono',
                        state === 'confident' && slotIdx != null
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100'
                          : 'bg-mm-surface text-mm-text-secondary',
                      )}
                      title={m.label}
                    >
                      {state === 'confident' && slotIdx != null && (
                        <span
                          className="inline-flex items-center text-[9px] mr-1 opacity-70"
                          aria-label={`pair ${slotIdx + 1}`}
                        >
                          <Link2 className="w-2.5 h-2.5 mr-px" aria-hidden="true" />
                          {slotIdx + 1}
                        </span>
                      )}
                      <span className="truncate max-w-[140px]">{m.label || `#${m.member_id}`}</span>
                    </span>
                  )
                })}
              </span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          {onEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(suggestion, index)}
              disabled={isAccepting}
              aria-label={`Edit suggestion ${suggestion.name}`}
            >
              <Pencil className="w-3.5 h-3.5 mr-1" aria-hidden />
              Edit
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDismiss(index)}
            disabled={isAccepting}
            aria-label={`Dismiss suggestion ${suggestion.name}`}
          >
            <X className="w-3.5 h-3.5 mr-1" aria-hidden />
            Dismiss
          </Button>
          <Button
            variant={state === 'unpaired' ? 'outline' : 'default'}
            size="sm"
            onClick={() => onAccept(suggestion)}
            disabled={isAccepting}
            aria-label={`Accept suggestion ${suggestion.name}`}
          >
            <Check className="w-3.5 h-3.5 mr-1" aria-hidden />
            Accept
          </Button>
        </div>
      </div>
    </section>
  )
}
