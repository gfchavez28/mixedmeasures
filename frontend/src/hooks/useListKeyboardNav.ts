import { useState, useRef, useCallback, useEffect, useMemo } from 'react'

interface UseListKeyboardNavOptions {
  /** Number of items in the list */
  itemCount: number
  /** Called when Enter or Space is pressed on a focused item */
  onSelect?: (index: number) => void
  /** Disable keyboard handling (e.g. when popover is closed). Default true. */
  enabled?: boolean
}

/**
 * Shared keyboard navigation for flat lists.
 *
 * Provides ArrowDown/Up navigation, Enter/Space selection, Escape reset,
 * scrollIntoView on focus change, and hover-sets-focus via getItemProps.
 *
 * For advanced behaviors (Shift+Arrow multi-select, cross-panel nav, tree
 * expand/collapse), consumers should compose: use focusedIndex/setFocusedIndex
 * from this hook but provide their own onKeyDown handler.
 */
export function useListKeyboardNav({
  itemCount,
  onSelect,
  enabled = true,
}: UseListKeyboardNavOptions) {
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  // Clamp focusedIndex when the list shrinks below it. Done during render (the
  // React-sanctioned "adjust state on prop change" pattern) rather than in an
  // effect: React re-renders immediately with the clamped value, so consumers
  // never see a frame with an out-of-range highlight, and there's no extra
  // paint. The condition is false after the update, so it terminates.
  if (focusedIndex >= itemCount) {
    setFocusedIndex(itemCount > 0 ? itemCount - 1 : -1)
  }

  // scrollIntoView on focus change
  useEffect(() => {
    if (focusedIndex < 0 || !containerRef.current) return
    const el = containerRef.current.querySelector('[data-focused="true"]') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!enabled || itemCount === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedIndex(prev => Math.min(prev + 1, itemCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex(prev => Math.max(prev - 1, 0))
    } else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0) {
      e.preventDefault()
      onSelect?.(focusedIndex)
    } else if (e.key === 'Escape') {
      setFocusedIndex(-1)
    }
  }, [enabled, itemCount, focusedIndex, onSelect])

  const handleBlur = useCallback(() => {
    setFocusedIndex(-1)
  }, [])

  const getItemProps = useCallback((index: number) => ({
    onMouseEnter: () => setFocusedIndex(index),
    'aria-selected': index === focusedIndex,
    'data-focused': index === focusedIndex,
  }), [focusedIndex])

  const listProps = useMemo(() => ({
    ref: containerRef,
    role: 'listbox' as const,
    tabIndex: 0,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
  }), [handleKeyDown, handleBlur])

  return { focusedIndex, setFocusedIndex, getItemProps, listProps, containerRef }
}
