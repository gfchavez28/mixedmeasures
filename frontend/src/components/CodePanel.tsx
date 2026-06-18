import { useState, useMemo, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Plus, Ellipsis, Pencil, Check, X, Power, PowerOff, StickyNote } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { type Code, codesApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn, getCodeColor } from '@/lib/utils'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'

export interface CodePanelHandle {
  focus: () => void
  focusInput: () => void
  focusLastItem: () => void
  focusCode: (codeId: number) => void
  focusCodeForApply: (codeId: number) => void
  getFocusedCodeIndex: () => number
  setFocusedCodeIndex: (index: number) => void
}

interface CodePanelProps {
  codes: Code[]
  projectId: number
  selectedCodesMap: Map<number, 'all' | 'some' | 'none'>
  onCodeToggle: (code: Code) => void
  onMultiCodeToggle?: (codes: Code[]) => void  // For batch applying multiple codes
  onCreateCode: (name: string) => void
  onAddCodeMemo?: (codeId: number, codeName: string) => void  // Opens memo panel for this code
  disabled: boolean
  categories?: { id: number; name: string; parent_id?: number | null }[]
  // Keyboard navigation props
  isFocused?: boolean
  onFocusChange?: (focused: boolean) => void
  onNavigateToTranscript?: () => void  // Left arrow
  onNavigateToPrevPanel?: () => void   // Up from search bar to Scratchpad (Item 58)
  onNavigateToNextPanel?: () => void   // Down from last code (Item 57)
}

const CodePanel = forwardRef<CodePanelHandle, CodePanelProps>(function CodePanel({
  codes,
  projectId,
  selectedCodesMap,
  onCodeToggle,
  onMultiCodeToggle,
  onCreateCode,
  onAddCodeMemo,
  disabled,
  categories: categoriesProp,
  isFocused = false,
  onFocusChange,
  onNavigateToTranscript,
  onNavigateToPrevPanel,
  onNavigateToNextPanel,
}, ref) {
  const [searchQuery, setSearchQuery] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [selectedCodeIndices, setSelectedCodeIndices] = useState<Set<number>>(new Set())
  const [pendingApplyCodeId, setPendingApplyCodeId] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const shiftAnchorRef = useRef<number | null>(null)
  const skipFocusResetRef = useRef(false) // Prevents onFocus from resetting after focusLastItem


  // Build abbreviated parent path map from categories prop
  const parentPathMap = useMemo(() => {
    const map = new Map<number, string>()
    if (!categoriesProp) return map
    const catById = new Map(categoriesProp.map(c => [c.id, c]))
    for (const cat of categoriesProp) {
      if (cat.parent_id != null) {
        const parent = catById.get(cat.parent_id)
        if (parent) {
          // Check for grandparent
          const gp = parent.parent_id != null ? catById.get(parent.parent_id) : undefined
          if (gp) {
            map.set(cat.id, `${gp.name} › … › ${cat.name}`)
          } else {
            map.set(cat.id, `${parent.name} › ${cat.name}`)
          }
        }
      }
    }
    return map
  }, [categoriesProp])

  // Build unique ordered category list from codes
  const categoryList = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; color: string | null }>()
    // codes are already ordered by backend (category display_order, then category_order)
    for (const code of codes) {
      if (code.category_id !== null && !code.is_universal && !seen.has(code.category_id)) {
        seen.set(code.category_id, {
          id: code.category_id,
          name: code.category_name || 'Unknown',
          color: code.category_color || null,
        })
      }
    }
    return Array.from(seen.values())
  }, [codes])

  // Filter and separate codes into groups
  const { universalCodes, categorizedGroups, uncategorizedCodes, allDisplayedCodes } = useMemo(() => {
    const isSearching = !!searchQuery.trim()
    let filtered = codes
    if (isSearching) {
      const query = searchQuery.toLowerCase()
      filtered = codes.filter(
        (code) =>
          code.name.toLowerCase().includes(query) ||
          (code.numeric_id !== null && code.numeric_id !== undefined &&
           code.numeric_id.toString().includes(query))
      )
    }

    const universal: Code[] = []
    const catGroups: { catId: number; catName: string; catColor: string | null; catIndex: number; codes: Code[] }[] = []
    const uncategorized: Code[] = []

    for (const code of filtered) {
      if (code.is_universal) {
        universal.push(code)
      } else if (code.category_id !== null && !isSearching) {
        let group = catGroups.find(g => g.catId === code.category_id)
        if (!group) {
          const catIdx = categoryList.findIndex(c => c.id === code.category_id)
          group = {
            catId: code.category_id,
            catName: code.category_name || 'Unknown',
            catColor: code.category_color || null,
            catIndex: catIdx,
            codes: [],
          }
          catGroups.push(group)
        }
        group.codes.push(code)
      } else {
        uncategorized.push(code)
      }
    }

    // Build flat array for keyboard navigation (category headers are skipped)
    const all: Code[] = [...universal]
    for (const g of catGroups) all.push(...g.codes)
    all.push(...uncategorized)

    return {
      universalCodes: universal,
      categorizedGroups: catGroups,
      uncategorizedCodes: uncategorized,
      allDisplayedCodes: all,
    }
  }, [codes, searchQuery, categoryList])

  // Check if search query exactly matches an existing code name (case-insensitive)
  const exactMatchExists = useMemo(() => {
    if (!searchQuery.trim()) return true // Empty query = can't create
    const query = searchQuery.trim().toLowerCase()
    return codes.some((code) => code.name.toLowerCase() === query)
  }, [codes, searchQuery])

  const handleCreateCode = useCallback(() => {
    if (searchQuery.trim() && !exactMatchExists) {
      onCreateCode(searchQuery.trim())
      setSearchQuery('')
    }
  }, [searchQuery, exactMatchExists, onCreateCode])

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      containerRef.current?.focus()
    },
    focusInput: () => {
      inputRef.current?.focus()
    },
    focusLastItem: () => {
      if (allDisplayedCodes.length > 0) {
        const lastIndex = allDisplayedCodes.length - 1
        skipFocusResetRef.current = true
        setFocusedIndex(lastIndex)
        setSelectedCodeIndices(new Set([lastIndex]))
      }
      containerRef.current?.focus()
    },
    focusCode: (codeId: number) => {
      // Find the code in the displayed list
      const index = allDisplayedCodes.findIndex(c => c.id === codeId)
      if (index >= 0) {
        skipFocusResetRef.current = true
        setFocusedIndex(index)
        setSelectedCodeIndices(new Set([index]))
        containerRef.current?.focus()
        // Scroll the code into view
        setTimeout(() => {
          const items = listRef.current?.querySelectorAll('[data-code-item]')
          items?.[index]?.scrollIntoView({ block: 'nearest' })
        }, 0)
      } else {
        // Code might be filtered out - clear filter and try again
        if (searchQuery) {
          setSearchQuery('')
          // After clearing, find and focus the code.
          // The 0ms timeout defers until React re-renders with the cleared filter.
          // `codes` is captured from the useCallback closure (in deps at line 223),
          // so it reflects the current value at call time — safe since the
          // timeout fires synchronously after the microtask queue drains.
          setTimeout(() => {
            const allCodes = [...codes.filter(c => c.is_universal), ...codes.filter(c => !c.is_universal)]
            const codeIndex = allCodes.findIndex(c => c.id === codeId)
            if (codeIndex >= 0) {
              skipFocusResetRef.current = true
              setFocusedIndex(codeIndex)
              setSelectedCodeIndices(new Set([codeIndex]))
              containerRef.current?.focus()
            }
          }, 0)
        }
      }
    },
    focusCodeForApply: (codeId: number) => {
      // Clear any search filter so the new code is visible
      setSearchQuery('')
      // Set pending state — useEffect will focus when the code appears in the list
      setPendingApplyCodeId(codeId)
    },
    getFocusedCodeIndex: () => focusedIndex,
    setFocusedCodeIndex: (index: number) => setFocusedIndex(index),
  }), [focusedIndex, allDisplayedCodes, codes, searchQuery])

  // Reference to the search input for focus management
  const inputRef = useRef<HTMLInputElement>(null)

  // Handle keyboard navigation when focused
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only handle if this panel is supposed to be focused (prevents stale focus issues)
    if (!isFocused) return

    // In input: Tab/Enter to create code
    if (e.target === e.currentTarget || !(e.target instanceof HTMLInputElement)) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+ArrowDown: Jump to last code
          const newIndex = allDisplayedCodes.length - 1
          setFocusedIndex(newIndex)
          setSelectedCodeIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        } else if (e.shiftKey) {
          // Shift+ArrowDown: Extend selection (Item 47)
          const newIndex = Math.min(focusedIndex + 1, allDisplayedCodes.length - 1)
          if (shiftAnchorRef.current === null) {
            shiftAnchorRef.current = focusedIndex >= 0 ? focusedIndex : 0
          }
          setFocusedIndex(newIndex)
          // Select range from anchor to current
          const startIdx = Math.min(shiftAnchorRef.current, newIndex)
          const endIdx = Math.max(shiftAnchorRef.current, newIndex)
          const newSet = new Set<number>()
          for (let i = startIdx; i <= endIdx; i++) newSet.add(i)
          setSelectedCodeIndices(newSet)
        } else if (allDisplayedCodes.length > 0 && focusedIndex >= allDisplayedCodes.length - 1) {
          // At last code - navigate to next panel (Item 57)
          onNavigateToNextPanel?.()
        } else if (allDisplayedCodes.length === 0) {
          // No codes - navigate to next panel
          onNavigateToNextPanel?.()
        } else {
          const newIndex = Math.min(focusedIndex + 1, allDisplayedCodes.length - 1)
          setFocusedIndex(newIndex)
          setSelectedCodeIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+ArrowUp: Jump to first code
          setFocusedIndex(0)
          setSelectedCodeIndices(new Set([0]))
          shiftAnchorRef.current = null
        } else if (e.shiftKey && focusedIndex > 0) {
          // Shift+ArrowUp: Extend selection (Item 47)
          const newIndex = focusedIndex - 1
          if (shiftAnchorRef.current === null) {
            shiftAnchorRef.current = focusedIndex
          }
          setFocusedIndex(newIndex)
          // Select range from anchor to current
          const startIdx = Math.min(shiftAnchorRef.current, newIndex)
          const endIdx = Math.max(shiftAnchorRef.current, newIndex)
          const newSet = new Set<number>()
          for (let i = startIdx; i <= endIdx; i++) newSet.add(i)
          setSelectedCodeIndices(newSet)
        } else if (focusedIndex <= 0) {
          // At top of list or no selection - move to search input
          setFocusedIndex(-1)
          setSelectedCodeIndices(new Set())
          shiftAnchorRef.current = null
          inputRef.current?.focus()
        } else {
          const newIndex = focusedIndex - 1
          setFocusedIndex(newIndex)
          setSelectedCodeIndices(new Set([newIndex]))
          shiftAnchorRef.current = null
        }
      } else if ((e.key === ' ' || e.key === 'Enter') && !disabled) {
        e.preventDefault()
        // Apply all selected codes (Item 47)
        if (selectedCodeIndices.size > 1 && onMultiCodeToggle) {
          const selectedCodes = Array.from(selectedCodeIndices)
            .map(idx => allDisplayedCodes[idx])
            .filter(code => code && code.is_active)
          if (selectedCodes.length > 0) {
            onMultiCodeToggle(selectedCodes)
          }
        } else if (focusedIndex >= 0 && focusedIndex < allDisplayedCodes.length) {
          const code = allDisplayedCodes[focusedIndex]
          if (code.is_active) {
            onCodeToggle(code)
          }
          // If this was a pending-apply code, clear state and return to input
          if (pendingApplyCodeId === code.id) {
            setPendingApplyCodeId(null)
            setTimeout(() => inputRef.current?.focus(), 0)
          }
        }
      } else if (e.key === 'Escape' && pendingApplyCodeId !== null) {
        // Cancel pending apply and return to input
        e.preventDefault()
        setPendingApplyCodeId(null)
        setTimeout(() => inputRef.current?.focus(), 0)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setFocusedIndex(-1)
        setSelectedCodeIndices(new Set())
        shiftAnchorRef.current = null
        // Navigate to transcript (Item 57)
        onNavigateToTranscript?.()
        containerRef.current?.blur()
      }
    }
  }, [isFocused, allDisplayedCodes, focusedIndex, selectedCodeIndices, disabled, onCodeToggle, onMultiCodeToggle, pendingApplyCodeId, onNavigateToTranscript, onNavigateToNextPanel])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === 'Tab' || e.key === 'Enter') && searchQuery.trim() && !exactMatchExists) {
      e.preventDefault()
      handleCreateCode()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex(0)
      // Move focus to the list
      containerRef.current?.focus()
    } else if (e.key === 'ArrowUp') {
      // Navigate to previous panel (Scratchpad) from search bar (Item 58)
      e.preventDefault()
      onNavigateToPrevPanel?.()
    }
  }, [searchQuery, exactMatchExists, handleCreateCode, onNavigateToPrevPanel])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-code-item]')
      items[focusedIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex])

  // Auto-focus pending-apply code when it appears in the displayed list
  /* eslint-disable react-hooks/set-state-in-effect -- sync focus to newly created code after apply */
  useEffect(() => {
    if (pendingApplyCodeId === null) return
    const index = allDisplayedCodes.findIndex(c => c.id === pendingApplyCodeId)
    if (index >= 0) {
      skipFocusResetRef.current = true
      setFocusedIndex(index)
      setSelectedCodeIndices(new Set([index]))
      containerRef.current?.focus()
      setTimeout(() => {
        const items = listRef.current?.querySelectorAll('[data-code-item]')
        items?.[index]?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }
  }, [allDisplayedCodes, pendingApplyCodeId])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Handle keyup for shift release (Item 47)
  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Shift') {
      // Selection is "locked" when shift is released
      shiftAnchorRef.current = null
    }
  }, [])


  return (
    <div
      ref={containerRef}
      className={cn(
        "h-full flex flex-col outline-none",
        isFocused && "ring-2 ring-inset ring-ring"
      )}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={() => {
        onFocusChange?.(true)
        // Reset focusedIndex when gaining focus, unless focusLastItem was just called
        if (skipFocusResetRef.current) {
          skipFocusResetRef.current = false
        } else {
          setFocusedIndex(-1)
          setSelectedCodeIndices(new Set())
          shiftAnchorRef.current = null
        }
      }}
      onBlur={(e) => {
        // Only blur if focus is leaving the container entirely
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          onFocusChange?.(false)
          setFocusedIndex(-1)
          setSelectedCodeIndices(new Set())
          shiftAnchorRef.current = null
          setPendingApplyCodeId(null)
        }
      }}
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-3 border-b">
        {/* Search/Add row */}
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-2.5 w-4 h-4 text-mm-text-faint" />
            <Input
              ref={inputRef}
              id="new-code-input"
              aria-label="Search or add codes"
              placeholder="Search or add codes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              className="pl-8 h-9"
            />
          </div>
          {selectedCodeIndices.size > 1 && (
            <span className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded self-center shrink-0">
              {selectedCodeIndices.size} sel
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={exactMatchExists || !searchQuery.trim()}
            onClick={handleCreateCode}
            title={exactMatchExists ? "Code already exists" : "Add new code (Tab or Enter)"}
          >
            <Plus className={cn("w-4 h-4", !exactMatchExists && searchQuery.trim() && "text-blue-600")} />
          </Button>
        </div>
        <div aria-live="polite">
          {searchQuery.trim() && !exactMatchExists && (
            <p className="text-xs text-blue-600 mt-1">
              <kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Tab</kbd>
              {' or '}
              <kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>
              {' to create \u201c'}{searchQuery.trim()}{'\u201d'}
            </p>
          )}
          {pendingApplyCodeId !== null && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 bg-blue-50 dark:bg-blue-950/30 p-1 rounded">
              <kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>
              {' to apply · '}
              <kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Esc</kbd>
              {' to cancel'}
            </p>
          )}
        </div>
      </div>

      {/* Code List */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {(() => {
          // Build a flat-index lookup: code.id → index in allDisplayedCodes
          const flatIndexMap = new Map<number, number>()
          allDisplayedCodes.forEach((c, i) => flatIndexMap.set(c.id, i))

          const renderCodeItem = (code: Code, shortcutLabel?: string) => {
            const fi = flatIndexMap.get(code.id) ?? -1
            return (
              <CodeItem
                key={code.id}
                code={code}
                projectId={projectId}
                state={selectedCodesMap.get(code.id) || 'none'}
                onToggle={() => onCodeToggle(code)}
                onAddMemo={onAddCodeMemo ? () => onAddCodeMemo(code.id, code.name) : undefined}
                disabled={disabled}
                isFocused={isFocused && focusedIndex === fi}
                isSelected={isFocused && selectedCodeIndices.has(fi)}
                isPendingApply={pendingApplyCodeId === code.id}
                shortcutLabel={shortcutLabel}
              />
            )
          }

          return (
            <>
              {/* Universal Codes */}
              {universalCodes.length > 0 && (
                <div className="border-b">
                  <div className="px-4 py-1.5 bg-blue-50 dark:bg-blue-950/30 text-xs font-medium text-blue-700 dark:text-blue-400">
                    Universal Codes
                  </div>
                  {universalCodes.map(code => renderCodeItem(code, String(code.numeric_id)))}
                </div>
              )}

              {/* Categorized Groups */}
              {categorizedGroups.map(group => {
                const shortcutPrefix = group.catIndex >= 0 && group.catIndex < 8 ? group.catIndex + 2 : null
                const parentPath = parentPathMap.get(group.catId)
                return (
                  <div key={group.catId} className="border-b">
                    <div
                      className="px-4 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-secondary flex items-center gap-2"
                      style={group.catColor ? { borderLeft: `3px solid ${group.catColor}` } : undefined}
                    >
                      {group.catColor && (
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: group.catColor }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        {parentPath && (
                          <span className="block text-[10px] text-mm-text-faint truncate">{parentPath}</span>
                        )}
                        <span>{group.catName}</span>
                      </div>
                      {shortcutPrefix !== null && (
                        <span className="font-mono text-mm-text-faint">[{shortcutPrefix}]</span>
                      )}
                    </div>
                    {group.codes.map((code, codeIdx) =>
                      renderCodeItem(
                        code,
                        shortcutPrefix !== null && codeIdx < 9
                          ? `${shortcutPrefix}.${codeIdx + 1}`
                          : undefined
                      )
                    )}
                  </div>
                )
              })}

              {/* Uncategorized Codes */}
              {uncategorizedCodes.length > 0 && (
                <div className="border-b">
                  {(categorizedGroups.length > 0 || universalCodes.length > 0) && (
                    <div className="px-4 py-1.5 bg-mm-bg text-xs font-medium text-mm-text-muted">
                      {categorizedGroups.length > 0 ? 'Uncategorized' : 'Project Codes'}
                    </div>
                  )}
                  {uncategorizedCodes.length > 0 && (
                    <div className="px-4 py-0.5 text-[10px] text-mm-text-faint">
                      {categorizedGroups.length > 0
                        ? 'Categorize for shortcuts'
                        : 'Tip: Organize into categories for keyboard shortcuts'}
                    </div>
                  )}
                  {uncategorizedCodes.map(code => renderCodeItem(code))}
                </div>
              )}

              {/* Empty state */}
              {allDisplayedCodes.length === 0 && (
                <div className="p-4 text-sm text-mm-text-muted text-center">
                  No codes yet. Create one above.
                </div>
              )}
            </>
          )
        })()}
      </div>

    </div>
  )
})

export default CodePanel

function CodeItem({
  code,
  projectId,
  state,
  onToggle,
  onAddMemo,
  disabled,
  isFocused = false,
  isSelected = false,
  isPendingApply = false,
  shortcutLabel,
}: {
  code: Code
  projectId: number
  state: 'all' | 'some' | 'none'
  onToggle: () => void
  onAddMemo?: () => void
  disabled: boolean
  isFocused?: boolean
  isSelected?: boolean
  isPendingApply?: boolean
  shortcutLabel?: string
}) {
  const queryClient = useQueryClient()
  const [menuOpen, setMenuOpen] = useState(false)
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [descriptionValue, setDescriptionValue] = useState(code.description || '')
  const [showDeactivateDialog, setShowDeactivateDialog] = useState(false)

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `code-${code.id}`,
    data: { type: 'code' as const, code, shortcutLabel: shortcutLabel || String(code.numeric_id) },
  })

  const updateMutation = useMutation({
    mutationFn: (description: string) =>
      codesApi.update(projectId, code.id, { description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      setIsEditingDescription(false)
      setMenuOpen(false)
    },
  })

  const toggleActiveMutation = useMutation({
    mutationFn: (isActive: boolean) =>
      codesApi.update(projectId, code.id, { is_active: isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      setShowDeactivateDialog(false)
      setMenuOpen(false)
    },
  })

  const updateColorMutation = useMutation({
    mutationFn: (color: string) =>
      codesApi.update(projectId, code.id, { color }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['codes', projectId] })
      setColorPickerOpen(false)
    },
  })

  const handleSaveDescription = () => {
    updateMutation.mutate(descriptionValue)
  }

  const handleCancelEdit = () => {
    setDescriptionValue(code.description || '')
    setIsEditingDescription(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveDescription()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
    e.stopPropagation() // Prevent keyboard navigation while editing
  }

  if (isEditingDescription) {
    return (
      <div
        data-code-item
        className="px-4 py-2 border-b border-mm-border-subtle bg-mm-bg"
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-medium">{code.name}</span>
          <span className="text-xs text-mm-text-muted">- Edit Description</span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={descriptionValue}
            onChange={(e) => setDescriptionValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-8 text-sm flex-1"
            placeholder="Add description..."
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              handleSaveDescription()
            }}
            disabled={updateMutation.isPending}
          >
            <Check className="w-4 h-4 text-green-600" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              handleCancelEdit()
            }}
          >
            <X className="w-4 h-4 text-mm-text-muted" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-code-item
      className={cn(
        'px-4 py-2 flex items-center gap-3 hover:bg-mm-surface-hover cursor-pointer border-b border-mm-border-subtle group',
        disabled && 'opacity-50',
        !code.is_active && 'opacity-50',
        isSelected && 'bg-blue-50 dark:bg-blue-900/30',
        isFocused && 'ring-2 ring-inset ring-blue-400 bg-blue-50 dark:bg-blue-950/30',
        isPendingApply && 'border-l-4 border-l-blue-500 bg-blue-50 dark:bg-blue-950/30',
        isDragging && 'opacity-40'
      )}
      onClick={() => !disabled && code.is_active && onToggle()}
    >
      <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
        <PopoverTrigger asChild>
          <button
            className="w-3 h-3 rounded-full flex-shrink-0 hover:ring-2 hover:ring-mm-border-medium transition-shadow"
            style={{ backgroundColor: getCodeColor(code) }}
            onClick={(e) => { e.stopPropagation(); setColorPickerOpen(true) }}
            title="Change color"
            aria-label={`Change color for ${code.name}`}
          />
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="start" onClick={(e) => e.stopPropagation()}>
          <ColorSwatchPicker
            value={code.color || ''}
            onChange={(color) => updateColorMutation.mutate(color)}
          />
        </PopoverContent>
      </Popover>
      <span className={cn("text-sm truncate flex-1 min-w-0", state !== 'none' && 'font-medium')}>{code.name}</span>
      {shortcutLabel && (
        <span className="text-xs text-mm-text-secondary font-mono shrink-0">{shortcutLabel}</span>
      )}
      {state !== 'none' && (
        <span className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          state === 'all' ? 'bg-blue-500' : 'bg-blue-300'
        )} />
      )}

      {/* More options menu */}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 hover:bg-mm-surface-hover rounded transition-opacity"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(true)
            }}
            aria-label={`Options for ${code.name}`}
          >
            <Ellipsis className="w-4 h-4 text-mm-text-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="end">
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-mm-surface-hover rounded"
            onClick={(e) => {
              e.stopPropagation()
              setDescriptionValue(code.description || '')
              setIsEditingDescription(true)
              setMenuOpen(false)
            }}
          >
            <Pencil className="w-4 h-4" />
            {code.description ? 'Edit Description' : 'Add Description'}
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-mm-surface-hover rounded"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              onAddMemo?.()
            }}
          >
            <StickyNote className="w-4 h-4" />
            Add Memo
          </button>
          {/* Don't show deactivate for universal codes */}
          {!code.is_universal && (
            <button
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-mm-surface-hover rounded",
                code.is_active ? "text-orange-600" : "text-green-600"
              )}
              onClick={(e) => {
                e.stopPropagation()
                if (code.is_active && code.usage_count > 0) {
                  // Show confirmation dialog for codes with associations
                  setShowDeactivateDialog(true)
                  setMenuOpen(false)
                } else {
                  // Toggle directly for inactive codes or codes with no associations
                  toggleActiveMutation.mutate(!code.is_active)
                }
              }}
            >
              {code.is_active ? (
                <>
                  <PowerOff className="w-4 h-4" />
                  Deactivate Code
                </>
              ) : (
                <>
                  <Power className="w-4 h-4" />
                  Reactivate Code
                </>
              )}
            </button>
          )}
        </PopoverContent>
      </Popover>

      {/* Deactivate confirmation dialog */}
      <Dialog open={showDeactivateDialog} onOpenChange={setShowDeactivateDialog}>
        <DialogContent onClick={(e: React.MouseEvent) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Deactivate "{code.name}"?</DialogTitle>
            <DialogDescription>
              This code is applied to {code.usage_count} segment{code.usage_count !== 1 ? 's' : ''}.
              Deactivating it will hide it from the code list, but existing associations will be preserved.
              You can reactivate it later from the codebook.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeactivateDialog(false)}
            >
              Cancel
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700"
              onClick={() => toggleActiveMutation.mutate(false)}
              disabled={toggleActiveMutation.isPending}
            >
              {toggleActiveMutation.isPending ? 'Deactivating...' : 'Deactivate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
