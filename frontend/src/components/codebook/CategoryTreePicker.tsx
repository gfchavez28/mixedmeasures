import { useMemo } from 'react'
import { Check } from 'lucide-react'
import type { CodebookCategoryNode, CodebookTreeResponse } from '@/lib/api'

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
  /** Called when user hovers a category row (for spotlight preview) */
  onHover?: (categoryId: number | null) => void
}

/** Flatten category tree into a depth-annotated list */
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

  return (
    <div role="tree" aria-label="Category picker" className="max-h-48 overflow-y-auto border border-mm-border-subtle rounded-md bg-mm-bg" onMouseLeave={() => onHover?.(null)}>
      {/* None option */}
      <button
        type="button"
        role="treeitem"
        aria-selected={value === null}
        aria-level={1}
        className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
          value === null
            ? 'bg-mm-blue/10 text-mm-blue-text'
            : 'text-mm-text-muted hover:bg-mm-surface-hover'
        }`}
        onClick={() => onChange(null)}
        onMouseEnter={() => onHover?.(null)}
      >
        <Check className={`w-3 h-3 shrink-0 ${value === null ? 'opacity-100' : 'opacity-0'}`} />
        <span className="italic">{noneLabel}</span>
      </button>

      {flatCategories.map(cat => {
        const excluded = excludeIds?.has(cat.id) ?? false
        // For maxDepth constraint: placing something under this cat means the item
        // would be at depth cat.depth + 1. Disable if that exceeds maxDepth.
        const depthDisabled = maxDepth !== undefined && cat.depth + 1 > maxDepth
        const disabled = excluded || depthDisabled

        return (
          <button
            key={cat.id}
            type="button"
            role="treeitem"
            aria-selected={value === cat.id}
            aria-level={cat.depth + 1}
            disabled={disabled}
            className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left transition-colors ${
              disabled
                ? 'opacity-30 cursor-not-allowed'
                : value === cat.id
                  ? 'bg-mm-blue/10 text-mm-blue-text'
                  : 'text-mm-text hover:bg-mm-surface-hover'
            }`}
            style={{ paddingLeft: `${10 + cat.depth * 16}px` }}
            onClick={() => { if (!disabled) onChange(cat.id) }}
            onMouseEnter={() => { if (!disabled) onHover?.(cat.id) }}
          >
            <Check className={`w-3 h-3 shrink-0 ${value === cat.id ? 'opacity-100' : 'opacity-0'}`} />
            {cat.color && (
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: cat.color }} />
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
