import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { ColorDotButton } from '@/components/ColorDotButton'

import { type Code, type CodeCategory, codesApi } from '@/lib/api'
import { getCodeColor } from '@/lib/utils'

interface TextCodePanelProps {
  codes: Code[]
  categories: CodeCategory[]
  projectId: number
  appliedCodeIds: number[]
  onToggleCode: (codeId: number) => void
  onCreateCode?: (name: string) => void
  selectedCount: number
  isFocused: boolean
  onFocusChange: (focused: boolean) => void
  disabled?: boolean
  chordNumberMap: Map<number, number>
}

export default function TextCodePanel({
  codes,
  categories,
  projectId,
  appliedCodeIds,
  onToggleCode,
  onCreateCode,
  selectedCount,
  isFocused,
  onFocusChange,
  disabled = false,
  chordNumberMap,
}: TextCodePanelProps) {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [colorPickerCodeId, setColorPickerCodeId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const updateColorMutation = useMutation({
    mutationFn: ({ codeId, color }: { codeId: number; color: string }) =>
      codesApi.update(projectId, codeId, { color }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      setColorPickerCodeId(null)
    },
  })

  // Filter codes
  const activeCodes = useMemo(() => {
    let filtered = codes.filter(c => c.is_active)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(c => c.name.toLowerCase().includes(q))
    }
    return filtered
  }, [codes, searchQuery])

  // Group codes: universal → by category → uncategorized
  const groupedCodes = useMemo(() => {
    const universals = activeCodes.filter(c => c.is_universal)
    const categorized = new Map<number, Code[]>()
    const uncategorized: Code[] = []

    for (const code of activeCodes) {
      if (code.is_universal) continue
      if (code.category_id) {
        if (!categorized.has(code.category_id)) categorized.set(code.category_id, [])
        categorized.get(code.category_id)!.push(code)
      } else {
        uncategorized.push(code)
      }
    }

    // Sort within categories by category_order
    for (const [, list] of categorized) {
      list.sort((a, b) => (a.category_order ?? 0) - (b.category_order ?? 0))
    }

    return { universals, categorized, uncategorized }
  }, [activeCodes])

  // Flat list for keyboard navigation + index lookup
  const flatList = useMemo(() => {
    const items: Code[] = [
      ...groupedCodes.universals,
    ]
    for (const [, list] of groupedCodes.categorized) {
      items.push(...list)
    }
    items.push(...groupedCodes.uncategorized)
    return items
  }, [groupedCodes])

  const flatIndexMap = useMemo(() => {
    const map = new Map<number, number>()
    flatList.forEach((code, i) => map.set(code.id, i))
    return map
  }, [flatList])

  // Check if search query exactly matches an existing code name
  const exactMatchExists = useMemo(() => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.trim().toLowerCase()
    return codes.some(code => code.name.toLowerCase() === query)
  }, [codes, searchQuery])

  const handleCreateCode = useCallback(() => {
    if (searchQuery.trim() && !exactMatchExists && onCreateCode) {
      onCreateCode(searchQuery.trim())
      setSearchQuery('')
    }
  }, [searchQuery, exactMatchExists, onCreateCode])

  // Clamp focusedIndex when list shrinks (e.g., from search filtering)
  useEffect(() => {
    if (focusedIndex >= flatList.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp index when filtered list changes
      setFocusedIndex(flatList.length > 0 ? flatList.length - 1 : -1)
    }
  }, [flatList.length, focusedIndex])

  // Keyboard nav within panel
  useEffect(() => {
    if (!isFocused) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in the search input
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex(i => Math.min(i + 1, flatList.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex(i => Math.max(i - 1, 0))
      } else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0 && !disabled) {
        e.preventDefault()
        onToggleCode(flatList[focusedIndex].id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFocused, focusedIndex, flatList, onToggleCode, disabled])

  // Global 'n' shortcut to focus search input (consistent with CodingWorkbench)
  useEffect(() => {
    const handleNKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (e.key === 'n') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleNKey)
    return () => window.removeEventListener('keydown', handleNKey)
  }, [])

  // Build position-within-category map for shortcut labels (1-indexed, matching CodePanel)
  const codePositionMap = useMemo(() => {
    const map = new Map<number, number>()
    for (const [, catCodes] of groupedCodes.categorized) {
      catCodes.forEach((code, idx) => {
        if (idx < 9) map.set(code.id, idx + 1)
      })
    }
    return map
  }, [groupedCodes.categorized])

  const getShortcutLabel = (code: Code): string => {
    if (code.is_universal) {
      return code.numeric_id !== null ? String(code.numeric_id) : ''
    }
    if (code.category_id) {
      const chordNum = chordNumberMap.get(code.category_id)
      const position = codePositionMap.get(code.id)
      if (chordNum !== undefined && position !== undefined) {
        return `${chordNum}.${position}`
      }
    }
    return code.numeric_id !== null ? String(code.numeric_id) : ''
  }

  const renderCodeItem = (code: Code, index: number) => {
    const isApplied = appliedCodeIds.includes(code.id)
    const isFocusedItem = isFocused && focusedIndex === index
    const shortcut = getShortcutLabel(code)

    return (
      <button
        key={code.id}
        role="option"
        aria-selected={isApplied}
        aria-label={`${code.name}${shortcut ? ` ${shortcut}` : ''}${isApplied ? ', applied' : ''}`}
        className={`
          flex items-center gap-2 w-full px-2.5 py-1.5 text-sm text-left rounded transition-colors
          ${isApplied ? 'bg-mm-bg font-medium' : 'hover:bg-mm-surface-hover'}
          ${isFocusedItem ? 'ring-2 ring-mm-blue ring-inset' : ''}
          ${disabled ? 'opacity-50' : 'cursor-pointer'}
        `}
        onClick={() => !disabled && onToggleCode(code.id)}
        disabled={disabled}
        tabIndex={-1}
      >
        <Popover open={colorPickerCodeId === code.id} onOpenChange={(open) => setColorPickerCodeId(open ? code.id : null)}>
          <PopoverTrigger asChild>
            <ColorDotButton
              asSpan
              color={getCodeColor(code)}
              onClick={(e) => { e.stopPropagation(); setColorPickerCodeId(code.id) }}
              title="Change color"
              aria-label={`Change color for ${code.name}`}
            />
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="start" onClick={(e) => e.stopPropagation()}>
            <ColorSwatchPicker
              value={code.color || ''}
              onChange={(color) => updateColorMutation.mutate({ codeId: code.id, color })}
            />
          </PopoverContent>
        </Popover>
        <span className="flex-1 truncate">{code.name}</span>
        {shortcut && (
          <span className="text-[11px] text-muted-foreground font-mono shrink-0">{shortcut}</span>
        )}
        {isApplied && (
          <span className="w-1.5 h-1.5 rounded-full bg-mm-blue shrink-0" />
        )}
      </button>
    )
  }

  return (
    <div
      data-panel="codes"
      role="region"
      aria-label="Code panel"
      className={`flex flex-col h-full ${isFocused ? 'ring-1 ring-inset ring-mm-blue/40' : ''}`}
      onClick={() => onFocusChange(true)}
    >
      {selectedCount === 0 && (
        <div className="px-3 py-1">
          <span className="text-[11px] text-muted-foreground">Select a text</span>
        </div>
      )}

      <div className="px-2 py-1.5">
        <div className="flex gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Search or add codes..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if ((e.key === 'Tab' || e.key === 'Enter') && searchQuery.trim() && !exactMatchExists) {
                  e.preventDefault()
                  handleCreateCode()
                }
              }}
              className="h-7 pl-7 text-xs"
              aria-label="Search or add codes"
            />
          </div>
          {onCreateCode && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              disabled={exactMatchExists || !searchQuery.trim()}
              onClick={handleCreateCode}
              aria-label="Add code"
              // #518: empty query reads as a prompt, not "Code already exists".
              title={!searchQuery.trim() ? 'Type a name to add a code' : exactMatchExists ? 'Code already exists' : 'Add new code (Tab or Enter)'}
            >
              <Plus className={`w-3.5 h-3.5 ${!exactMatchExists && searchQuery.trim() ? 'text-green-600' : ''}`} />
            </Button>
          )}
        </div>
        {searchQuery.trim() && !exactMatchExists && onCreateCode && (
          <p className="text-[11px] text-green-600 mt-1 px-1"><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Tab</kbd>{' or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>{' to create "'}{searchQuery.trim()}{'"'}</p>
        )}
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-1 pb-2 max-h-[50vh]" role="listbox" aria-label="Available codes">
        {/* Universals */}
        {groupedCodes.universals.length > 0 && (
          <div className="mb-1">
            {groupedCodes.universals.map(code =>
              renderCodeItem(code, flatIndexMap.get(code.id) ?? 0)
            )}
          </div>
        )}

        {/* Categorized */}
        {Array.from(groupedCodes.categorized.entries()).map(([catId, catCodes]) => {
          const cat = categories.find(c => c.id === catId)
          return (
            <div key={catId} className="mb-1">
              <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-mm-text-faint">
                {cat?.color && (
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                )}
                {cat?.name || 'Category'}
                {chordNumberMap.has(catId) && (
                  <span className="font-mono text-mm-border-medium">[{chordNumberMap.get(catId)}]</span>
                )}
              </div>
              {catCodes.map(code =>
                renderCodeItem(code, flatIndexMap.get(code.id) ?? 0)
              )}
            </div>
          )
        })}

        {/* Uncategorized */}
        {groupedCodes.uncategorized.length > 0 && (
          <div className="mb-1">
            {(groupedCodes.categorized.size > 0 || groupedCodes.universals.length > 0) && (
              <div className="px-2.5 py-1 text-[11px] font-semibold text-mm-text-faint">
                Uncategorized
              </div>
            )}
            {groupedCodes.categorized.size > 0 && (
              <div className="px-2.5 py-0.5 text-[10px] text-mm-text-faint">
                Categorize for shortcuts
              </div>
            )}
            {groupedCodes.uncategorized.map(code =>
              renderCodeItem(code, flatIndexMap.get(code.id) ?? 0)
            )}
          </div>
        )}

        {flatList.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">
            {searchQuery ? 'No matching codes' : 'No codes yet'}
          </div>
        )}
      </div>
    </div>
  )
}
