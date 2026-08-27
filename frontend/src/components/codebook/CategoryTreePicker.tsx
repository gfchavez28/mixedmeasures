import { useMemo, useRef } from 'react'
import { Check } from 'lucide-react'
import type { CodebookCategoryNode, CodebookTreeResponse } from '@/lib/api'
import { useTreeKeyboardNav } from '@/hooks/useTreeKeyboardNav'
import { modeDisabledProps } from '@/lib/mode-disabled'

interface FlatCategory {
  id: number
  name: string
  color: string | null
  depth: number
}

interface CategoryTreePickerProps {
  treeData: CodebookTreeResponse
  value: number | null
  onChange: (categoryId: number | null) => void
  excludeIds?: Set<number>
  noneLabel?: string
  /** If set, categories where placing a child would exceed maxDepth are disabled */
  maxDepth?: number
  /** Called when user hovers OR keyboard-focuses a category row (for spotlight preview) */
  onHover?: (categoryId: number | null) => void
}

/**
 * Flatten category tree into a depth-annotated list.
 *
 * Pre-order (the node, then its children), which is what makes the shared
 * `firstChildIndex` / `parentIndex` traversal in `useTreeKeyboardNav` correct
 * here — those rules are specified on a pre-order.
 */
function flattenTree(nodes: CodebookCategoryNode[]): FlatCategory[] {
  const result: FlatCategory[] = []
  function walk(cats: CodebookCategoryNode[]) {
    for (const cat of cats) {
      result.push({ id: cat.id, name: cat.name, color: cat.color, depth: cat.depth })
      walk(cat.children)
    }
  }
  walk(nodes)
  return result
}

/**
 * The category picker — #758.
 *
 * ## One tab stop, and the arrow keys that make that legal
 *
 * Every row used to be a plain focusable `<button>`, so a 30-category codebook
 * cost 30 tab stops between the name field and Save (measured: 7 of the
 * dialog's 26 stops were categories, on a project with six). It is now a roving
 * tabindex — one stop, on the row that is currently SELECTED so tabbing in
 * lands on your current category rather than on "no category".
 *
 * ⚠️ **Tab order and arrow keys are ONE feature** (#756). Setting
 * `tabIndex={-1}` without a key handler would have made the categories
 * unreachable by keyboard altogether — strictly worse than 30 stops.
 *
 * ⚠️ **The disabled rows had to change first, and this is the load-bearing
 * part.** A natively-`disabled` button cannot take focus, and the hook moves
 * the cursor with `.focus()` — which is a SILENT no-op on one. Arrowing down a
 * codebook whose depth-3 categories are disabled would simply stop dead, with
 * no event and no message. They are `aria-disabled` now (the #754 shape:
 * focusable, announced unavailable, the reason appended to the name, and the
 * click guarded), which is also what APG recommends for items inside a
 * composite widget: a disabled destination a researcher can find and be told
 * about beats one that silently is not there.
 *
 * ⚠️ **Deliberately NO `useTreeAriaPositions`.** `aria-setsize`/`aria-posinset`
 * are needed exactly when the DOM does NOT hold the whole set; this list is
 * fully rendered, and NVDA was heard deriving "1 of 7" … "7 of 7" from it
 * unaided (#758, 2026-08-17). Adding them by analogy with the other trees is
 * the cargo-culting that rule exists to stop. ⚠️ The heard evidence covers a
 * FLAT codebook only — no project in dev.db has nested categories — so whether
 * a reader derives per-group positions correctly once `aria-level` actually
 * varies is unverified, and is worth a listen on a nested fixture.
 */
export default function CategoryTreePicker({
  treeData,
  value,
  onChange,
  excludeIds,
  noneLabel = 'No category',
  maxDepth,
  onHover,
}: CategoryTreePickerProps) {
  const flatCategories = useMemo(() => flattenTree(treeData.tree), [treeData.tree])
  const treeRef = useRef<HTMLDivElement>(null)
  const handleKeyDown = useTreeKeyboardNav({ treeRef })

  /**
   * Which row owns the single tab stop.
   *
   * The selected one — but falling back to the always-present "none" row when
   * `value` names a category that is not in this list. Without that fallback a
   * stale value leaves NO row with `tabIndex={0}`, which is the resting-state
   * bug that made the codebook tree keyboard-unreachable by construction
   * (#701a): nothing focusable means no keydown means nothing ever becomes
   * focusable.
   */
  const tabStopId = useMemo(
    () => (value !== null && flatCategories.some(c => c.id === value) ? value : null),
    [value, flatCategories],
  )

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Category picker"
      className="max-h-48 overflow-y-auto border border-mm-border-subtle rounded-md bg-mm-bg"
      onKeyDown={handleKeyDown}
      onMouseLeave={() => onHover?.(null)}
      // Keyboard parity for the spotlight preview: focus previews the same way
      // hover does, and leaving the tree entirely clears it. Moving BETWEEN
      // rows keeps it, because the row being entered sets its own.
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHover?.(null) }}
    >
      {/* None option */}
      <button
        type="button"
        role="treeitem"
        aria-selected={value === null}
        aria-level={1}
        tabIndex={tabStopId === null ? 0 : -1}
        className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
          value === null
            ? 'bg-mm-blue/10 text-mm-blue-text'
            : 'text-mm-text-muted hover:bg-mm-surface-hover'
        }`}
        onClick={() => onChange(null)}
        onMouseEnter={() => onHover?.(null)}
        onFocus={() => onHover?.(null)}
      >
        <Check className={`w-3 h-3 shrink-0 ${value === null ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
        <span className="italic">{noneLabel}</span>
      </button>

      {flatCategories.map(cat => {
        const excluded = excludeIds?.has(cat.id) ?? false
        // For maxDepth constraint: placing something under this cat means the item
        // would be at depth cat.depth + 1. Disable if that exceeds maxDepth.
        const depthDisabled = maxDepth !== undefined && cat.depth + 1 > maxDepth
        const disabled = excluded || depthDisabled

        // Both reasons are STRUCTURAL — a property of the codebook, not a
        // transient precondition — so they earn the tab stop and the sentence.
        const blockedReason = excluded
          ? 'unavailable as a destination'
          : depthDisabled
            ? 'cannot contain sub-categories — maximum depth reached'
            : null

        return (
          <button
            key={cat.id}
            type="button"
            role="treeitem"
            aria-selected={value === cat.id}
            aria-level={cat.depth + 1}
            tabIndex={tabStopId === cat.id ? 0 : -1}
            {...modeDisabledProps<HTMLButtonElement>({
              label: cat.name,
              blockedReason,
              onActivate: () => onChange(cat.id),
            })}
            className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
              disabled
                ? 'opacity-50 cursor-not-allowed'
                : value === cat.id
                  ? 'bg-mm-blue/10 text-mm-blue-text'
                  : 'text-mm-text hover:bg-mm-surface-hover'
            }`}
            style={{ paddingLeft: `${10 + cat.depth * 16}px` }}
            onMouseEnter={() => { if (!disabled) onHover?.(cat.id) }}
            onFocus={() => { if (!disabled) onHover?.(cat.id) }}
          >
            <Check className={`w-3 h-3 shrink-0 ${value === cat.id ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
            {cat.color && (
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: cat.color }} aria-hidden />
            )}
            <span className="truncate">{cat.name}</span>
          </button>
        )
      })}

      {flatCategories.length === 0 && (
        <div className="px-2.5 py-2 text-xs text-mm-text-faint italic">No categories</div>
      )}
    </div>
  )
}
