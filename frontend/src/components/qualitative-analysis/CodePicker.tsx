import { useState, useMemo, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Check, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { Code, CodeCategory, CodeFrequencyItem } from '@/lib/api'
import type { QualCodeMode, QualTab } from '@/lib/qual-analysis-types'
import { getCodeColor } from '@/lib/utils'

interface CodePickerProps {
  mode: QualCodeMode
  onModeChange: (mode: QualCodeMode) => void
  selectedCodeIds: Set<number>
  onSelectionChange: (ids: Set<number>) => void
  onViewCode: (codeId: number) => void
  codes: Code[]
  categories: CodeCategory[]
  frequencies?: CodeFrequencyItem[]
  source: 'all' | 'conversations' | 'text'
  activeTab?: QualTab
  projectId?: number
}

export default function CodePicker({
  mode,
  onModeChange,
  selectedCodeIds,
  onSelectionChange,
  onViewCode,
  codes,
  categories,
  frequencies,
  source,
  activeTab,
  projectId,
}: CodePickerProps) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set())
  const treeRef = useRef<HTMLDivElement>(null)

  // Build frequency map
  const freqMap = useMemo(() => {
    const m = new Map<number, number>()
    if (frequencies) {
      for (const f of frequencies) {
        const count = source === 'text'
          ? f.text_count
          : source === 'all'
            ? f.segment_count + f.text_count
            : f.segment_count
        m.set(f.code_id, count)
      }
    }
    return m
  }, [frequencies, source])

  // Active codes filtered by search
  const activeCodes = useMemo(() => {
    const lowerSearch = search.toLowerCase()
    return codes
      .filter(c => c.is_active)
      .filter(c => !search || c.name.toLowerCase().includes(lowerSearch))
  }, [codes, search])

  // Group codes by category (with nesting support)
  type CategoryGroup = { category: CodeCategory; codes: Code[]; children: CategoryGroup[] }

  const { groups, uncategorized } = useMemo(() => {
    const catMap = new Map<number, { category: CodeCategory; codes: Code[] }>()
    const uncat: Code[] = []

    for (const c of activeCodes) {
      if (c.category_id) {
        let entry = catMap.get(c.category_id)
        if (!entry) {
          const cat = categories.find(ct => ct.id === c.category_id)
          if (cat) {
            entry = { category: cat, codes: [] }
            catMap.set(c.category_id, entry)
          }
        }
        if (entry) entry.codes.push(c)
        else uncat.push(c)
      } else {
        uncat.push(c)
      }
    }

    // Build nested tree: root categories with children arrays
    const rootGroups: CategoryGroup[] = []
    const childMap = new Map<number, CategoryGroup[]>()

    // Sort all entries by display_order
    const sorted = Array.from(catMap.values()).sort(
      (a, b) => (a.category.display_order ?? 0) - (b.category.display_order ?? 0)
    )

    for (const entry of sorted) {
      const group: CategoryGroup = { ...entry, children: [] }
      const parentId = entry.category.parent_id
      if (parentId != null) {
        const siblings = childMap.get(parentId) || []
        siblings.push(group)
        childMap.set(parentId, siblings)
      } else {
        rootGroups.push(group)
      }
    }

    // Attach children to parents
    for (const root of rootGroups) {
      root.children = childMap.get(root.category.id) || []
    }
    // Handle orphan children (parent not in rootGroups, e.g. grandchild)
    for (const [parentId, children] of childMap) {
      const parentGroup = rootGroups.find(g => g.category.id === parentId)
      if (!parentGroup) {
        // Check if parent is a child of a root group
        for (const root of rootGroups) {
          const parentChild = root.children.find(c => c.category.id === parentId)
          if (parentChild) {
            parentChild.children = children
            break
          }
        }
      }
    }

    return { groups: rootGroups, uncategorized: uncat }
  }, [activeCodes, categories])

  // Search result count for aria-live
  const resultCount = activeCodes.length

  // Category-level selection state
  const getCategoryState = useCallback((catId: number): 'all' | 'some' | 'none' => {
    const catCodes = activeCodes.filter(c => c.category_id === catId)
    if (catCodes.length === 0) return 'none'
    const selected = catCodes.filter(c => selectedCodeIds.has(c.id))
    if (selected.length === catCodes.length) return 'all'
    if (selected.length > 0) return 'some'
    return 'none'
  }, [activeCodes, selectedCodeIds])

  // Toggle category checkbox
  const toggleCategory = useCallback((catId: number) => {
    const catCodes = activeCodes.filter(c => c.category_id === catId)
    const state = getCategoryState(catId)
    const next = new Set(selectedCodeIds)
    if (state === 'all') {
      // Deselect all in category
      for (const c of catCodes) next.delete(c.id)
    } else {
      // Select all in category
      for (const c of catCodes) next.add(c.id)
    }
    onSelectionChange(next)
  }, [activeCodes, getCategoryState, selectedCodeIds, onSelectionChange])

  // Toggle individual code
  const toggleCode = useCallback((codeId: number) => {
    const next = new Set(selectedCodeIds)
    if (next.has(codeId)) next.delete(codeId)
    else next.add(codeId)
    onSelectionChange(next)
  }, [selectedCodeIds, onSelectionChange])

  // Select / deselect all
  const allSelected = activeCodes.length > 0 && activeCodes.every(c => selectedCodeIds.has(c.id))
  const someSelected = !allSelected && activeCodes.some(c => selectedCodeIds.has(c.id))

  const toggleAll = useCallback(() => {
    if (allSelected) {
      // Deselect all visible
      const next = new Set(selectedCodeIds)
      for (const c of activeCodes) next.delete(c.id)
      onSelectionChange(next)
    } else {
      // Select all visible
      const next = new Set(selectedCodeIds)
      for (const c of activeCodes) next.add(c.id)
      onSelectionChange(next)
    }
  }, [allSelected, activeCodes, selectedCodeIds, onSelectionChange])

  // Expand/collapse category
  const toggleExpand = useCallback((catId: number) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(catId)) next.delete(catId)
      else next.add(catId)
      return next
    })
  }, [])

  // Keyboard navigation
  const handleTreeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = treeRef.current?.querySelectorAll('[role="treeitem"]')
    if (!items || items.length === 0) return

    const focused = document.activeElement as HTMLElement
    const idx = Array.from(items).indexOf(focused)
    if (idx === -1) return

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = items[Math.min(idx + 1, items.length - 1)] as HTMLElement
        next?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = items[Math.max(idx - 1, 0)] as HTMLElement
        prev?.focus()
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const catId = focused.dataset.categoryId
        if (catId) {
          setExpandedCategories(prev => new Set(prev).add(Number(catId)))
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const catId = focused.dataset.categoryId
        if (catId) {
          setExpandedCategories(prev => {
            const next = new Set(prev)
            next.delete(Number(catId))
            return next
          })
        }
        break
      }
      case ' ': {
        e.preventDefault()
        focused.click()
        break
      }
      case 'Home': {
        e.preventDefault()
        const first = items[0] as HTMLElement
        first?.focus()
        break
      }
      case 'End': {
        e.preventDefault()
        const last = items[items.length - 1] as HTMLElement
        last?.focus()
        break
      }
    }
  }, [])

  // Mode toggle keyboard nav
  const handleModeKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      onModeChange(mode === 'codes' ? 'categories' : 'codes')
    }
  }, [mode, onModeChange])

  const renderCheckbox = (checked: boolean, indeterminate?: boolean) => (
    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
      checked ? 'bg-mm-blue border-mm-blue' : indeterminate ? 'bg-mm-blue/50 border-mm-blue/70' : 'border-mm-border-medium'
    }`}>
      {checked && <Check className="w-3 h-3 text-white" />}
      {indeterminate && !checked && <span className="w-2 h-0.5 bg-white rounded-full" />}
    </span>
  )

  const renderCategoryGroup = (group: CategoryGroup, depth = 0) => {
    const cat = group.category
    const catCodes = group.codes
    const expanded = expandedCategories.has(cat.id)
    const catState = getCategoryState(cat.id)

    if (mode === 'categories') {
      return (
        <div key={cat.id} role="none" style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined}>
          <div
            role="treeitem"
            tabIndex={-1}
            data-category-id={cat.id}
            aria-checked={catState === 'all'}
            aria-expanded={expanded}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-mm-surface-hover cursor-pointer"
            onClick={() => toggleCategory(cat.id)}
          >
            {renderCheckbox(catState === 'all', catState === 'some')}
            {cat.color && (
              <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: cat.color }} />
            )}
            <span className="text-sm flex-1 truncate">{cat.name}</span>
            <span className="text-xs text-mm-text-faint tabular-nums">{cat.code_count}</span>
            <button
              className="p-0.5 hover:bg-mm-bg rounded"
              onClick={e => { e.stopPropagation(); toggleExpand(cat.id) }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded
                ? <ChevronDown className="w-3 h-3 text-mm-text-faint" />
                : <ChevronRight className="w-3 h-3 text-mm-text-faint" />
              }
            </button>
          </div>
          {expanded && (
            <div role="group" className="ml-6 space-y-0.5">
              {catCodes.map(code => (
                <div key={code.id} className="flex items-center gap-2 px-2 py-1 text-xs text-mm-text-muted">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: getCodeColor(code) }} />
                  <span className="truncate">{code.name}</span>
                  <span className="text-mm-text-faint tabular-nums ml-auto">{freqMap.get(code.id) ?? 0}</span>
                </div>
              ))}
              {group.children.map(child => renderCategoryGroup(child, depth + 1))}
            </div>
          )}
        </div>
      )
    }

    // Codes mode
    return (
      <div key={cat.id} role="none" style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined}>
        <div
          role="treeitem"
          tabIndex={-1}
          data-category-id={cat.id}
          aria-expanded={expanded}
          aria-checked={catState === 'all'}
          className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-mm-surface-hover rounded"
          onClick={() => { toggleCategory(cat.id) }}
        >
          {renderCheckbox(catState === 'all', catState === 'some')}
          {cat.color && (
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
          )}
          <span className="text-xs font-semibold text-mm-text-muted uppercase tracking-wide flex-1 truncate">{cat.name}</span>
          <button
            className="p-0.5 hover:bg-mm-bg rounded"
            onClick={e => { e.stopPropagation(); toggleExpand(cat.id) }}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded
              ? <ChevronDown className="w-3 h-3 text-mm-text-faint" />
              : <ChevronRight className="w-3 h-3 text-mm-text-faint" />
            }
          </button>
        </div>
        {expanded !== false && (
          <div role="group" className="ml-2 space-y-0.5">
            {catCodes.map(code => (
              <div
                key={code.id}
                role="treeitem"
                tabIndex={-1}
                aria-checked={selectedCodeIds.has(code.id)}
                className={`flex items-center gap-2 px-2 py-1 text-sm rounded cursor-pointer hover:bg-mm-surface-hover ${
                  code.is_universal ? 'opacity-60' : ''
                }`}
                onClick={() => toggleCode(code.id)}
              >
                {renderCheckbox(selectedCodeIds.has(code.id))}
                <span
                  className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: getCodeColor(code) }}
                />
                {activeTab === 'content' ? (
                  <button
                    className="truncate flex-1 text-left hover:underline"
                    onClick={e => { e.stopPropagation(); onViewCode(code.id) }}
                    title="View code content"
                  >
                    {code.name}
                  </button>
                ) : (
                  <span className="truncate flex-1 text-left">{code.name}</span>
                )}
                <span className="text-xs text-mm-text-faint tabular-nums">{freqMap.get(code.id) ?? 0}</span>
                {projectId && (
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 p-0.5 text-mm-text-faint hover:text-mm-blue-text"
                    onClick={e => { e.stopPropagation(); navigate(`/projects/${projectId}/analysis/codebook?sel=code:${code.id}`) }}
                    title="View in Codebook"
                    aria-label={`View ${code.name} in Codebook`}
                  >
                    <ExternalLink className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            {group.children.map(child => renderCategoryGroup(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Mode toggle */}
      <div className="px-3 pb-2 flex-shrink-0">
        <div
          className="flex rounded-md border bg-mm-bg p-0.5 mb-2"
          role="tablist"
          aria-label="Code view mode"
          onKeyDown={handleModeKeyDown}
        >
          {(['codes', 'categories'] as const).map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              tabIndex={mode === m ? 0 : -1}
              className={`flex-1 text-xs py-1 rounded-sm transition-colors ${
                mode === m
                  ? 'bg-mm-surface shadow-xs font-medium text-mm-text'
                  : 'text-mm-text-muted hover:text-mm-text-secondary'
              }`}
              onClick={() => onModeChange(m)}
            >
              {m === 'codes' ? 'Codes' : 'Categories'}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint" />
          <Input
            placeholder="Search codes..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
            aria-label="Search codes"
          />
        </div>
        <div aria-live="polite" className="sr-only">
          {search && `${resultCount} code${resultCount !== 1 ? 's' : ''} found`}
        </div>
      </div>

      {/* Tree */}
      <div
        ref={treeRef}
        role="tree"
        aria-label={mode === 'codes' ? 'Code selection' : 'Category selection'}
        className="flex-1 overflow-y-auto px-1 space-y-0.5"
        onKeyDown={handleTreeKeyDown}
      >
        {/* Select all */}
        {mode === 'codes' && activeCodes.length > 0 && (
          <div
            role="treeitem"
            tabIndex={0}
            aria-checked={allSelected}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-mm-surface-hover cursor-pointer border-b border-mm-border-subtle mb-1 pb-2"
            onClick={toggleAll}
          >
            {renderCheckbox(allSelected, someSelected)}
            <span className="text-sm font-medium">Select all</span>
            <span className="text-xs text-mm-text-faint tabular-nums ml-auto">{activeCodes.length}</span>
          </div>
        )}

        {/* Category groups */}
        {groups.map(group =>
          renderCategoryGroup(group)
        )}

        {/* Uncategorized codes */}
        {uncategorized.length > 0 && mode === 'codes' && (
          <div>
            {groups.length > 0 && (
              <div className="px-2 py-1">
                <span className="text-xs font-semibold text-mm-text-faint uppercase tracking-wide">Uncategorized</span>
              </div>
            )}
            {uncategorized.map(code => (
              <div
                key={code.id}
                role="treeitem"
                tabIndex={-1}
                aria-checked={selectedCodeIds.has(code.id)}
                className={`flex items-center gap-2 px-2 py-1 text-sm rounded cursor-pointer hover:bg-mm-surface-hover ${
                  code.is_universal ? 'opacity-60' : ''
                }`}
                onClick={() => toggleCode(code.id)}
              >
                {renderCheckbox(selectedCodeIds.has(code.id))}
                <span
                  className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: getCodeColor(code) }}
                />
                {activeTab === 'content' ? (
                  <button
                    className="truncate flex-1 text-left hover:underline"
                    onClick={e => { e.stopPropagation(); onViewCode(code.id) }}
                    title="View code content"
                  >
                    {code.name}
                  </button>
                ) : (
                  <span className="truncate flex-1 text-left">{code.name}</span>
                )}
                <span className="text-xs text-mm-text-faint tabular-nums">{freqMap.get(code.id) ?? 0}</span>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {activeCodes.length === 0 && (
          <p className="text-xs text-mm-text-faint text-center py-4">
            {search ? 'No codes match search.' : 'No codes created.'}
          </p>
        )}
      </div>
    </div>
  )
}
