import { Filter, ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { coderColor, coderInitials } from '@/lib/coder-color'
import { getContrastColor } from '@/lib/utils'
import type { Coder } from '@/lib/api'

interface CoderFilterPopoverProps {
  coders: Coder[]
  activeCoderId: number | null
  /** coder ids whose codes are hidden from view (empty = show all). */
  hidden: Set<number>
  onChange: (next: Set<number>) => void
  /**
   * Track J · Group A (#457) — coder ids with ≥1 coding in the CURRENT source.
   * When provided, the picklist marks who "coded here" and dims the rest, so you
   * can tell which of the roster actually worked this conversation/document/dataset.
   * Omit for multi-source surfaces (qualitative analysis / cross-analysis).
   */
  activeCoderIds?: Set<number>
  /**
   * Archived coders who coded the current source but are absent from the
   * (non-archived) roster — labeled "(archived)" so their codings are attributable
   * + filterable (the #451 surface).
   */
  extraCoders?: Coder[]
  /**
   * #451 — archived coders' chips are hidden by default; this "view all coders"
   * toggle reveals them (here + in the transcript). Controlled by the workbench so
   * the picklist and the chip visibility stay in sync. When false/absent, the
   * archived rows are collapsed out of the list.
   */
  showArchived?: boolean
  onShowArchivedChange?: (v: boolean) => void
}

/**
 * Track J · J1 per-coder visibility filter — a screen lens, mirroring the
 * speaker-filter popover. You can never hide your OWN codes (the active coder's
 * checkbox is disabled), so the row-level predicate (`isCoderVisible`) only needs
 * the `hidden` set. Dual-encoded coder chips (initials + color) accompany each name.
 */
export default function CoderFilterPopover({
  coders,
  activeCoderId,
  hidden,
  onChange,
  activeCoderIds,
  extraCoders,
  showArchived,
  onShowArchivedChange,
}: CoderFilterPopoverProps) {
  const perSource = activeCoderIds != null
  const extras = extraCoders ?? []
  const toggle = (id: number) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  const showAll = () => onChange(new Set())
  const justMe = () => onChange(new Set(coders.filter(c => c.id !== activeCoderId).map(c => c.id)))

  const rows = [
    ...coders.map(c => ({ coder: c, isSelf: c.id === activeCoderId, isExtra: false })),
    // Archived rows appear only once "view all coders" is on (#451).
    ...(showArchived ? extras.map(c => ({ coder: c, isSelf: false, isExtra: true })) : []),
  ]
  const activeRosterCount = perSource ? coders.filter(c => activeCoderIds!.has(c.id)).length : 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
            hidden.size > 0
              ? 'bg-mm-blue/12 text-mm-blue-text'
              : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
          }`}
          aria-label={hidden.size > 0 ? `Filter codes by coder (${hidden.size} hidden)` : 'Filter codes by coder'}
          title={hidden.size > 0 ? `${hidden.size} coder${hidden.size > 1 ? 's' : ''} hidden` : 'Filter codes by coder'}
        >
          <Filter className="w-3 h-3" />
          {hidden.size > 0 && <span>{hidden.size}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-2" align="start">
        <div className="text-xs text-mm-text-muted mb-1">Show codes by coder</div>
        {perSource && (
          <div className="text-[11px] text-mm-text-faint mb-2">
            {activeRosterCount} of {coders.length} coded here
            {extras.length > 0 && ` · +${extras.length} archived`}
          </div>
        )}
        <div className="flex gap-1 mb-2">
          <Button variant="ghost" size="sm" className="h-7 flex-1 text-xs" onClick={showAll}>Show all</Button>
          <Button variant="ghost" size="sm" className="h-7 flex-1 text-xs" onClick={justMe}>Just me</Button>
        </div>
        <div className="space-y-2 max-h-56 overflow-y-auto" role="group" aria-label="Coders to show">
          {rows.map(({ coder: c, isSelf, isExtra }) => {
            const visible = isSelf || !hidden.has(c.id)
            const badgeBg = coderColor(c)
            // Extras (archived-who-coded) are active here by definition.
            const activeHere = !perSource || isExtra || activeCoderIds!.has(c.id)
            const dim = perSource && !activeHere
            const hereSr = perSource ? (activeHere ? ' (coded here)' : ' (no codes in this source)') : ''
            return (
              <div key={`${isExtra ? 'x' : 'r'}-${c.id}`} className={`flex items-center gap-2 ${dim ? 'opacity-50' : ''}`}>
                <Checkbox
                  id={`coder-filter-${c.id}`}
                  checked={visible}
                  disabled={isSelf}
                  onCheckedChange={() => { if (!isSelf) toggle(c.id) }}
                  aria-label={
                    isSelf
                      ? `${c.username} (you — always shown)`
                      : `Show codes by ${c.username}${isExtra ? ' (archived)' : ''}${hereSr}`
                  }
                />
                <span
                  className="inline-flex items-center justify-center rounded-full font-semibold leading-none px-1 text-[8px] flex-shrink-0"
                  style={{ backgroundColor: badgeBg, color: getContrastColor(badgeBg), minWidth: '14px', height: '14px' }}
                  aria-hidden="true"
                >
                  {coderInitials(c.username)}
                </span>
                <Label htmlFor={`coder-filter-${c.id}`} className="text-sm cursor-pointer flex-1 truncate">
                  {c.username}
                  {isSelf && <span className="text-mm-text-muted"> (you)</span>}
                  {isExtra && <span className="text-mm-text-faint"> (archived)</span>}
                </Label>
                {perSource && activeHere && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-none"
                    title="Coded in this source"
                    aria-hidden="true"
                  />
                )}
              </div>
            )
          })}
        </div>
        {extras.length > 0 && onShowArchivedChange && (
          <button
            type="button"
            onClick={() => onShowArchivedChange(!showArchived)}
            aria-expanded={!!showArchived}
            className="mt-2 flex items-center gap-1 text-[11px] text-mm-text-muted hover:text-mm-text"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${showArchived ? 'rotate-180' : ''}`} />
            {showArchived ? 'Hide' : 'View all'} — {extras.length} archived
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
