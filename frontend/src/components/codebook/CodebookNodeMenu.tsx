import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { FolderInput, Merge, EyeOff, ExternalLink, Eye, CheckSquare, FolderPlus } from 'lucide-react'
import type { SelectionAnalysis } from './codebook-selection'
import type { CodebookTreeResponse, CodebookCategoryNode } from '@/lib/api'

interface CodebookNodeMenuProps {
  x: number
  y: number
  nodeId: string
  analysis: SelectionAnalysis
  treeData: CodebookTreeResponse
  onMove: () => void
  onDirectMove: () => void
  onMerge: () => void
  onMergeCategories: () => void
  onGroupInto: () => void
  onHide: () => void
  onHideCategoryDescendants: (catId: number) => void
  onSelectAllInCategory: (catId: number) => void
  onViewSegments: (codeId: number) => void
  onViewInPeek: (nodeId: string) => void
  onClose: () => void
}

interface MenuItem {
  key: string
  label: string
  icon: React.ReactNode
  action: () => void
  danger?: boolean
  disabled?: boolean
}

function getCategoryCodeCount(catId: number, treeData: CodebookTreeResponse): number {
  function walk(nodes: CodebookCategoryNode[]): number | null {
    for (const cat of nodes) {
      if (cat.id === catId) return cat.codes.length
      const found = walk(cat.children)
      if (found !== null) return found
    }
    return null
  }
  return walk(treeData.tree) ?? 0
}

function getCategoryName(catId: number, treeData: CodebookTreeResponse): string {
  function walk(nodes: CodebookCategoryNode[]): string | null {
    for (const cat of nodes) {
      if (cat.id === catId) return cat.name
      const found = walk(cat.children)
      if (found !== null) return found
    }
    return null
  }
  return walk(treeData.tree) ?? 'category'
}

export default function CodebookNodeMenu({
  x,
  y,
  nodeId,
  analysis,
  treeData,
  onMove,
  onDirectMove,
  onMerge,
  onMergeCategories,
  onGroupInto,
  onHide,
  onHideCategoryDescendants,
  onSelectAllInCategory,
  onViewSegments,
  onViewInPeek,
  onClose,
}: CodebookNodeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [focusedIdx, setFocusedIdx] = useState(0)
  const [position, setPosition] = useState({ x, y })

  const isCategory = nodeId.startsWith('cat-')
  const isCode = nodeId.startsWith('code-')
  const entityId = Number(nodeId.replace(/^(code|cat)-/, ''))

  // Find if this code has segments
  const codeSegCount = isCode
    ? analysis.codes.find(c => c.id === entityId)?.segmentCount ?? 0
    : 0

  // Build menu items
  const items = useMemo(() => {
    const result: MenuItem[] = []

    // Move actions
    if (analysis.canMove && analysis.targetCategory) {
      result.push({
        key: 'direct-move',
        label: `Move to ${analysis.targetCategory.name.length > 20 ? analysis.targetCategory.name.slice(0, 19) + '\u2026' : analysis.targetCategory.name}`,
        icon: <FolderInput className="w-3.5 h-3.5" />,
        action: () => { onDirectMove(); onClose() },
      })
    } else if (analysis.canMove) {
      result.push({
        key: 'move',
        label: 'Move to\u2026',
        icon: <FolderInput className="w-3.5 h-3.5" />,
        action: () => { onMove(); onClose() },
      })
    }

    // Merge codes
    if (analysis.canMerge && !analysis.canMergeCategories) {
      result.push({
        key: 'merge',
        label: `Merge ${analysis.movableCodes.length} codes`,
        icon: <Merge className="w-3.5 h-3.5" />,
        action: () => { onMerge(); onClose() },
      })
    }

    // Merge categories
    if (analysis.canMergeCategories) {
      result.push({
        key: 'merge-categories',
        label: `Merge ${analysis.categories.length} categories`,
        icon: <Merge className="w-3.5 h-3.5" />,
        action: () => { onMergeCategories(); onClose() },
      })
    }

    // Group into new category
    if (analysis.canGroupInto) {
      result.push({
        key: 'group-into',
        label: 'Group into new category',
        icon: <FolderPlus className="w-3.5 h-3.5" />,
        action: () => { onGroupInto(); onClose() },
      })
    }

    // Select all in category
    if (isCategory) {
      const count = getCategoryCodeCount(entityId, treeData)
      if (count > 0) {
        result.push({
          key: 'select-all',
          label: `Select all ${count} codes`,
          icon: <CheckSquare className="w-3.5 h-3.5" />,
          action: () => { onSelectAllInCategory(entityId); onClose() },
        })
      }
    }

    // Separator marker
    if (result.length > 0 && (isCode || analysis.codes.length > 0)) {
      result.push({ key: 'sep', label: '', icon: null, action: () => {}, disabled: true })
    }

    // Hide actions
    if (isCode && analysis.codes.length > 0 && !analysis.codes.every(c => c.isUniversal)) {
      result.push({
        key: 'hide',
        label: 'Hide from Codebook',
        icon: <EyeOff className="w-3.5 h-3.5" />,
        action: () => { onHide(); onClose() },
      })
    }

    if (isCategory) {
      const catName = getCategoryName(entityId, treeData)
      result.push({
        key: 'hide-category',
        label: `Hide all codes in ${catName.length > 16 ? catName.slice(0, 15) + '\u2026' : catName}`,
        icon: <EyeOff className="w-3.5 h-3.5" />,
        action: () => { onHideCategoryDescendants(entityId); onClose() },
      })
    }

    if (isCode && codeSegCount > 0) {
      result.push({
        key: 'view-segments',
        label: 'View segments',
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        action: () => { onViewSegments(entityId); onClose() },
      })
    }

    result.push({
      key: 'peek',
      label: 'View in Peek Panel',
      icon: <Eye className="w-3.5 h-3.5" />,
      action: () => { onViewInPeek(nodeId); onClose() },
    })

    return result
  }, [analysis, isCategory, isCode, entityId, codeSegCount, nodeId, treeData, onDirectMove, onMove, onMerge, onMergeCategories, onGroupInto, onSelectAllInCategory, onHide, onHideCategoryDescendants, onViewSegments, onViewInPeek, onClose])

  const actionItems = items.filter(i => !i.disabled)

  // Clamp position to viewport
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth - 8 ? x - rect.width : x
    const ny = y + rect.height > window.innerHeight - 8 ? y - rect.height : y
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp menu position to viewport bounds after DOM measurement
    setPosition({ x: Math.max(8, nx), y: Math.max(8, ny) })
  }, [x, y])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        setFocusedIdx(prev => {
          let next = prev + 1
          while (next < items.length && items[next].disabled) next++
          return next < items.length ? next : prev
        })
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setFocusedIdx(prev => {
          let next = prev - 1
          while (next >= 0 && items[next].disabled) next--
          return next >= 0 ? next : prev
        })
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const item = items[focusedIdx]
        if (item && !item.disabled) item.action()
        break
      }
      case 'Escape': {
        e.preventDefault()
        onClose()
        break
      }
      case 'Home': {
        e.preventDefault()
        const first = items.findIndex(i => !i.disabled)
        if (first >= 0) setFocusedIdx(first)
        break
      }
      case 'End': {
        e.preventDefault()
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i].disabled) { setFocusedIdx(i); break }
        }
        break
      }
    }
  }, [focusedIdx, items, onClose])

  // Auto-focus menu on mount
  useEffect(() => {
    menuRef.current?.focus()
  }, [])

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-exclude-export
      className="fixed z-50 min-w-[180px] py-1 rounded-lg border border-mm-border-subtle bg-mm-surface shadow-xl outline-none"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, idx) => {
        if (item.disabled && item.key === 'sep') {
          return <div key="sep" className="my-1 border-t border-mm-border-subtle" />
        }

        const isFocused = idx === focusedIdx
        return (
          <button
            key={item.key}
            role="menuitem"
            tabIndex={-1}
            onClick={item.action}
            disabled={item.disabled}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
              item.danger
                ? 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20'
                : 'text-mm-text-secondary hover:text-mm-text'
            } ${isFocused ? 'bg-mm-surface-hover' : 'hover:bg-mm-surface-hover'}`}
            onMouseEnter={() => setFocusedIdx(idx)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        )
      })}
      {actionItems.length === 0 && (
        <div className="px-3 py-2 text-xs text-mm-text-faint italic">No actions available</div>
      )}
    </div>
  )
}
