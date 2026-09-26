import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { ColorDotButton } from '@/components/ColorDotButton'

import { findCodeByName } from '@/lib/code-name'
import { type Code, type CodeCategory, codesApi } from '@/lib/api'
import { getCodeColor } from '@/lib/utils'
import { useCodeShortcutLabels } from '@/hooks/useCodeShortcutLabels'
import { categoryShortcutPrefixes } from '@/lib/codeShortcuts'
import { LoadState } from '@/components/LoadStatus'
import type { ListLoad } from '@/lib/list-status'
import { focusedElementOwnsKey } from '@/lib/keyboard-scope'

interface TextCodePanelProps {
  codes: Code[]
  /**
   * #961 — whether `codes` is an ANSWER. REQUIRED, so a new mount has to decide.
   * `codes` is `[]` before the list answers, which rendered "No codes yet" AND
   * emptied the duplicate-name check below — typing an existing code's name and
   * pressing Enter created a second code of that name (the server does not
   * refuse duplicate names).
   */
  codesLoad: ListLoad
  categories: CodeCategory[]
  projectId: number
  appliedCodeIds: number[]
  onToggleCode: (codeId: number) => void
  onCreateCode?: (name: string) => void
  selectedCount: number
  isFocused: boolean
  onFocusChange: (focused: boolean) => void
  disabled?: boolean
  /**
   * Row 48 — the code-set pickers, rendered above the code list. A slot for the
   * reason `CodePanel`'s carries one: the strip fetches its own sets and owns
   * its own mutation, and this panel's host keys its coding on the CELL rather
   * than a segment.
   */
  codeSets?: React.ReactNode
}

export default function TextCodePanel({
  codes,
  codesLoad,
  categories,
  projectId,
  appliedCodeIds,
  onToggleCode,
  onCreateCode,
  selectedCount,
  isFocused,
  onFocusChange,
  disabled = false,
  codeSets,
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

  // Check if search query exactly matches an existing code name.
  // #963 — shared comparison (`lib/code-name.ts`); the empty-query arm is this
  // panel's own can't-create rule and stays here.
  const exactMatchExists = useMemo(() => {
    if (!searchQuery.trim()) return true
    return !!findCodeByName(codes, searchQuery)
  }, [codes, searchQuery])

  // #961 — the check above is only a check once the list has answered.
  const codesKnown = codesLoad.status === 'ready'
  const canCreateTyped = codesKnown && !!searchQuery.trim() && !exactMatchExists && !!onCreateCode

  const handleCreateCode = useCallback(() => {
    if (canCreateTyped && onCreateCode) {
      onCreateCode(searchQuery.trim())
      setSearchQuery('')
    }
  }, [canCreateTyped, searchQuery, onCreateCode])

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
      // 🔴 #1041 — a WINDOW listener sees keys aimed at every control on the page,
      // so it stands down like the workbench layer (#784): a key a control already
      // handled, and an activation key on a real control. Without them Enter on a
      // code-set value applied the code highlighted in THIS list instead, and the
      // picker's arrows moved this list's highlight as well as its own focus. The
      // list's rows are `role="option"`, which owns no key, so the list is untouched.
      if (e.defaultPrevented || focusedElementOwnsKey(e.key, target)) return

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
      // A control that claimed the key (the code-set picker claims every
      // printable key while focused) keeps it — #1041.
      if (e.defaultPrevented) return
      if (e.key === 'n') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleNKey)
    return () => window.removeEventListener('keydown', handleNKey)
  }, [])

  // #824: the labels and the category prefixes come from the SAME source the
  // chord resolver reads. This panel used to derive both itself — a category
  // number handed down from `TextCodingView` (built from EVERY category by
  // `display_order`) and a position built from its own filtered grouping — so a
  // project with an empty category ordered first printed keys that fired a
  // DIFFERENT code, silently, on the surface where coding happens.
  //
  // ⚠️ Both take the UNFILTERED `codes` prop, never `activeCodes`: a search
  // narrows what is LISTED, not which keys exist, and dropping an inactive code
  // would renumber every position after it (the trap `CodePanel:127` names).
  const shortcutLabels = useCodeShortcutLabels(codes)
  const categoryPrefixes = useMemo(() => categoryShortcutPrefixes(codes), [codes])

  const renderCodeItem = (code: Code, index: number) => {
    const isApplied = appliedCodeIds.includes(code.id)
    const isFocusedItem = isFocused && focusedIndex === index
    // No entry = no reachable key. Printing `numeric_id` as a fallback is the
    // #664 anti-pattern: a two-digit id can never be typed, and once any
    // category exists digits 2-9 are the chord prefix space.
    const shortcut = shortcutLabels.get(code.id)

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
          <PopoverContent className="w-auto p-3" align="start" onClick={(e) => e.stopPropagation()} aria-label="Code color">
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

      {/* Row 48 — the variables, above the tag list (see `CodePanel`). */}
      {codeSets}

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
                // Tab is claimed ONLY when it creates — while the list is still
                // loading it must stay ordinary focus movement.
                if ((e.key === 'Tab' || e.key === 'Enter') && canCreateTyped) {
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
              disabled={!canCreateTyped}
              onClick={handleCreateCode}
              aria-label="Add code"
              // #518: empty query reads as a prompt, not "Code already exists".
              title={
                !codesKnown ? (codesLoad.status === 'failed' ? 'Codes could not be loaded' : 'Codes are still loading')
                  : !searchQuery.trim() ? 'Type a name to add a code'
                    : exactMatchExists ? 'Code already exists' : 'Add new code (Tab or Enter)'
              }
            >
              <Plus className={`w-3.5 h-3.5 ${canCreateTyped ? 'text-green-600' : ''}`} />
            </Button>
          )}
        </div>
        {canCreateTyped && (
          <p className="text-[11px] text-green-600 mt-1 px-1"><kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Tab</kbd>{' or '}<kbd className="px-1 py-0.5 bg-mm-bg border border-mm-border-medium rounded text-[10px] font-mono">Enter</kbd>{' to create "'}{searchQuery.trim()}{'"'}</p>
        )}
      </div>

      {/* #961 — the loading/failure notice sits OUTSIDE the listbox: a listbox
          may own options, and the failure notice carries a Retry button. */}
      {!codesKnown ? (
        <LoadState load={codesLoad} size="panel" loadingLabel="Loading codes…" failedTitle="Codes could not be loaded." />
      ) : (
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
                {categoryPrefixes.has(catId) && (
                  <span className="font-mono text-mm-text-faint">[{categoryPrefixes.get(catId)}]</span>
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
      )}
    </div>
  )
}
