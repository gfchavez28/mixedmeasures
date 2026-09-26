import type { ReactNode } from 'react'
import { ArrowUpDown, BookOpen, FileInput, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { SortDirection, SourceSortKey } from '@/lib/source-list-sort'
import { SOURCE_TAB_CLASS, type SortChoice } from '@/lib/source-list-toolbar'

/**
 * The toolbar every SOURCE list page shares — Conversations, Documents, Datasets,
 * Observations (#1008).
 *
 * Four hand-built copies had drifted: Observations had a page title instead of this
 * row, no sort and a bare search box; Datasets had neither search nor sort; only
 * Conversations gave Codebook its icon. The Page Inventory claimed all four matched,
 * which is how the drift outlived every UX audit. One component is the remedy.
 *
 * What it fixed on the way, each measured live on 2026-09-23:
 * - **The title is a HEADING, not a button.** "All Conversations" was a `<button>`
 *   with no action — a tab stop that did nothing — and the pages had no heading at
 *   all above their cards' `h3`s.
 * - **Direction is part of the CHOICE.** The old control flipped ↑/↓ when the
 *   current option was re-picked, but Radix `Select` fires no `onValueChange` for an
 *   unchanged value, so the direction could never change: oldest-first was
 *   unreachable. Each option now names its direction ("Oldest first").
 * - **The search says what it searches.** It filters by NAME only (the TopRail
 *   Search is the content search), and "Search..." implied otherwise.
 * - **The row WRAPS.** At a 640px viewport the Conversations row overflowed its
 *   container by 42px and pushed Import past the window edge; the Datasets row has
 *   more controls still. Two `flex-wrap` groups let it take a second line instead.
 */

export type SourceAccent = 'green' | 'purple' | 'orange' | 'teal'

/**
 * Per-section classes, written out whole so Tailwind emits them.
 *
 * The IMPORT fills are the `mm-*-fill` tokens, never the base accents: white on the
 * base green/orange/teal measured 3.05 / 2.60 / 2.82:1 (#1009). The fill tokens are
 * deepened in light mode and carry near-black text in dark mode (`text-mm-on-fill`),
 * so each clears 4.5:1 in both themes, hover included. That is also what lets
 * Observations take its own teal instead of the primary green it borrowed.
 */
const ACCENT: Record<SourceAccent, { title: string; importButton: string }> = {
  green: {
    title: 'bg-[hsl(var(--mm-green)/0.08)] text-mm-green-text border-[hsl(var(--mm-green)/0.25)]',
    importButton: 'text-mm-on-fill bg-mm-green-fill hover:opacity-90',
  },
  purple: {
    title: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800/40',
    importButton: 'text-white bg-purple-600 hover:bg-purple-700 dark:bg-purple-700 dark:hover:bg-purple-600',
  },
  orange: {
    title: 'bg-[hsl(var(--mm-orange)/0.08)] text-mm-orange-text border-[hsl(var(--mm-orange)/0.25)]',
    importButton: 'text-mm-on-fill bg-mm-orange-fill hover:opacity-90',
  },
  teal: {
    title: 'bg-[hsl(var(--mm-teal)/0.08)] text-mm-teal-text border-[hsl(var(--mm-teal)/0.25)]',
    importButton: 'text-mm-on-fill bg-mm-teal-fill hover:opacity-90',
  },
}

const choiceValue = (c: { key: SourceSortKey; dir: SortDirection }) => `${c.key}:${c.dir}`

export default function SourceListToolbar({
  title,
  count,
  accent,
  noun,
  onOpenCodebook,
  extraTabs,
  showListControls,
  searchText,
  onSearchChange,
  sortChoices,
  sortBy,
  sortDir,
  onSortChange,
  actions,
  onImport,
}: {
  /** "All Conversations" — the page's heading. */
  title: string
  count: number
  accent: SourceAccent
  /** Plural, lower case — "conversations". Names the search and sort controls. */
  noun: string
  onOpenCodebook: () => void
  /** Section-specific tabs after Codebook (Datasets: Variable Groups, Code Text). */
  extraTabs?: ReactNode
  /** Search and sort only mean something once there is a list to search or sort. */
  showListControls: boolean
  searchText: string
  onSearchChange: (text: string) => void
  sortChoices: SortChoice[]
  sortBy: SourceSortKey
  sortDir: SortDirection
  onSortChange: (key: SourceSortKey, dir: SortDirection) => void
  /** Section-specific actions before Import (Datasets: Participant table, Blank table). */
  actions?: ReactNode
  onImport: () => void
}) {
  const style = ACCENT[accent]
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-6">
      <div className="flex flex-wrap items-center gap-1">
        <h1 className={cn('px-3 py-1.5 rounded-md text-sm font-medium border', style.title)}>
          {title}
          {count > 0 && (
            // #908: the space sits in the HEADING's own child list, outside the
            // span — the accessible-name algorithm trims each text node before
            // joining, so a space inside the span computes "All Datasets1".
            <>{' '}<span className="ml-1.5 opacity-60">{count}</span></>
          )}
        </h1>
        <button type="button" onClick={onOpenCodebook} className={SOURCE_TAB_CLASS}>
          <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
          Codebook
        </button>
        {extraTabs}
      </div>
      {/* `ml-auto`: when this group wraps to its own line it stays on the right,
          where it sits on a page wide enough for one row. */}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {showListControls && (
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint pointer-events-none" aria-hidden="true" />
              <Input
                value={searchText}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search by name…"
                aria-label={`Search ${noun} by name`}
                className="w-44 h-8 pl-8 pr-7 text-sm"
              />
              {searchText && (
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-mm-text-faint hover:text-mm-text transition-colors"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            <Select
              value={choiceValue({ key: sortBy, dir: sortDir })}
              onValueChange={(v) => {
                const choice = sortChoices.find(c => choiceValue(c) === v)
                if (choice) onSortChange(choice.key, choice.dir)
              }}
            >
              {/* #892: `combobox` is not a name-from-content role, so the visible
                  choice is the trigger's VALUE and never its name. */}
              <SelectTrigger className="w-[150px] h-8 text-sm" aria-label={`Sort ${noun}`}>
                <ArrowUpDown className="w-3.5 h-3.5 mr-1.5 shrink-0 text-mm-text-faint" aria-hidden="true" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortChoices.map(c => (
                  <SelectItem key={choiceValue(c)} value={choiceValue(c)}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        {actions}
        <button
          type="button"
          onClick={onImport}
          className={cn('inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors', style.importButton)}
        >
          <FileInput className="w-3.5 h-3.5" aria-hidden="true" />
          Import
        </button>
      </div>
    </div>
  )
}
