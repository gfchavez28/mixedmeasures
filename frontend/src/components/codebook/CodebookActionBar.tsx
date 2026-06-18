import { useEffect, useRef, useState } from 'react'
import { X, FolderInput, Merge, EyeOff, FolderPlus } from 'lucide-react'
import type { SelectionAnalysis } from './codebook-selection'

interface CodebookActionBarProps {
  analysis: SelectionAnalysis
  targetingMode: boolean
  onMove: () => void
  onDirectMove: () => void
  onMerge: () => void
  onMergeCategories: () => void
  onGroupInto: () => void
  onHide: () => void
  onClear: () => void
}

export default function CodebookActionBar({
  analysis,
  targetingMode,
  onMove,
  onDirectMove,
  onMerge,
  onMergeCategories,
  onGroupInto,
  onHide,
  onClear,
}: CodebookActionBarProps) {
  const [visible, setVisible] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  // Animate in on mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Targeting mode label
  const targetingItemCount = analysis.movableCodes.length + analysis.movableCategories.length
  const targetingLabel = analysis.movableCodes.length > 0 && analysis.movableCategories.length > 0
    ? `${targetingItemCount} items`
    : analysis.movableCategories.length > 0
    ? `${analysis.movableCategories.length} categor${analysis.movableCategories.length !== 1 ? 'ies' : 'y'}`
    : `${analysis.movableCodes.length} code${analysis.movableCodes.length !== 1 ? 's' : ''}`

  // Which merge to show: prefer categories if both qualify
  const showMergeCategories = analysis.canMergeCategories
  const showMergeCodes = analysis.canMerge && !showMergeCategories

  return (
    <div
      ref={barRef}
      data-exclude-export
      className={`absolute bottom-4 left-1/2 z-20 flex items-center gap-2 px-3 py-2 rounded-lg border border-mm-border-subtle bg-mm-surface/95 backdrop-blur-sm shadow-lg transition-all duration-150 ease-out ${
        visible ? 'opacity-100 -translate-x-1/2 translate-y-0' : 'opacity-0 -translate-x-1/2 translate-y-2'
      }`}
      role="toolbar"
      aria-label="Selection actions"
    >
      {targetingMode ? (
        <>
          <span className="text-xs text-mm-text-secondary whitespace-nowrap">
            Click a category to move {targetingLabel}
          </span>
          <button
            onClick={onClear}
            className="text-xs text-mm-text-faint hover:text-mm-text-secondary whitespace-nowrap"
          >
            Esc to cancel
          </button>
        </>
      ) : (
        <>
          {/* Selection summary */}
          <span className="text-xs text-mm-text-muted whitespace-nowrap">
            {analysis.summary}
          </span>

          <span className="w-px h-4 bg-mm-border-subtle" />

          {/* Move button */}
          {analysis.canMove && !analysis.targetCategory && (
            <button
              onClick={onMove}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-mm-text-secondary hover:bg-mm-surface-hover transition-colors whitespace-nowrap"
              title="Enter targeting mode to move items (M)"
            >
              <FolderInput className="w-3.5 h-3.5" />
              Move to...
              <kbd className="ml-1 px-1 py-0.5 rounded bg-mm-bg text-[9px] text-mm-text-faint border border-mm-border-subtle">M</kbd>
            </button>
          )}

          {analysis.canMove && analysis.targetCategory && (
            <button
              onClick={onDirectMove}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-mm-text-secondary hover:bg-mm-surface-hover transition-colors whitespace-nowrap"
              title={`Move codes to ${analysis.targetCategory.name}`}
            >
              <FolderInput className="w-3.5 h-3.5" />
              Move to {analysis.targetCategory.name.length > 16
                ? analysis.targetCategory.name.slice(0, 15) + '\u2026'
                : analysis.targetCategory.name}
            </button>
          )}

          {/* Merge button — codes or categories */}
          {showMergeCodes && (
            <button
              onClick={onMerge}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-mm-text-secondary hover:bg-mm-surface-hover transition-colors whitespace-nowrap"
              title="Merge selected codes (G)"
            >
              <Merge className="w-3.5 h-3.5" />
              Merge
              <kbd className="ml-1 px-1 py-0.5 rounded bg-mm-bg text-[9px] text-mm-text-faint border border-mm-border-subtle">G</kbd>
            </button>
          )}
          {showMergeCategories && (
            <button
              onClick={onMergeCategories}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-mm-text-secondary hover:bg-mm-surface-hover transition-colors whitespace-nowrap"
              title="Merge selected categories (G)"
            >
              <Merge className="w-3.5 h-3.5" />
              Merge
              <kbd className="ml-1 px-1 py-0.5 rounded bg-mm-bg text-[9px] text-mm-text-faint border border-mm-border-subtle">G</kbd>
            </button>
          )}

          {/* Group into new category */}
          {analysis.canGroupInto && (
            <button
              onClick={onGroupInto}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-mm-text-secondary hover:bg-mm-surface-hover transition-colors whitespace-nowrap"
              title="Group into new category (Shift+G)"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              Group
              <kbd className="ml-1 px-1 py-0.5 rounded bg-mm-bg text-[9px] text-mm-text-faint border border-mm-border-subtle">&#8679;G</kbd>
            </button>
          )}

          {/* Hide button (any non-universal code selection) */}
          {analysis.codes.length > 0 && !analysis.codes.every(c => c.isUniversal) && (
            <button
              onClick={onHide}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-mm-text-secondary hover:bg-mm-surface-hover transition-colors whitespace-nowrap"
              title="Hide from codebook (Del)"
            >
              <EyeOff className="w-3 h-3" />
              Hide
              <kbd className="ml-1 px-1 py-0.5 rounded bg-mm-bg text-[9px] text-mm-text-faint border border-mm-border-subtle">Del</kbd>
            </button>
          )}

          <span className="w-px h-4 bg-mm-border-subtle" />

          {/* Clear */}
          <button
            onClick={onClear}
            className="text-mm-text-faint hover:text-mm-text-secondary transition-colors p-0.5"
            aria-label="Clear selection"
            title="Clear selection"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  )
}
