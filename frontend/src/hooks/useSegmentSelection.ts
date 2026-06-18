import { useRef, useCallback } from 'react'

/**
 * Shared segment/item selection logic for coding workbenches.
 * Handles click (plain, Shift, Ctrl/Cmd) and arrow navigation with
 * proper anchor/cursor tracking for Shift+Arrow range extension.
 */
export function useSegmentSelection<T>(options: {
  items: T[]
  getId: (item: T) => number
  selectedIds: number[]
  onSelectionChange: (ids: number[]) => void
  scrollToIndex?: (index: number) => void
  enabled?: boolean
}): {
  handleItemClick: (id: number, e: React.MouseEvent) => void
  handleArrowNav: (direction: 1 | -1, opts?: { extend?: boolean; jump?: boolean }) => void
} {
  const { items, getId, selectedIds, onSelectionChange, scrollToIndex, enabled = true } = options

  // Anchor = where the range selection started (set on plain click or Ctrl+click)
  // Cursor = the current end of the range (moves with Shift+Click and Shift+Arrow)
  const anchorRef = useRef<number | null>(null)
  const cursorRef = useRef<number | null>(null)

  // Resolve a valid range anchor (#388 Q1 fix). The stored anchorRef can go
  // stale when selectedIds changes by means other than this hook's handlers —
  // an Escape-clear, a programmatic "jump to next" select, or a click handled
  // elsewhere. Trust the stored anchor only while it still points at a
  // currently-selected item; otherwise derive a fresh anchor from the current
  // selection (or null when nothing is selected, so a shift gesture starts clean
  // instead of ranging from a stale index).
  const resolveAnchorIndex = useCallback((): number | null => {
    const a = anchorRef.current
    if (a !== null && a >= 0 && a < items.length && selectedIds.includes(getId(items[a]))) {
      return a
    }
    if (selectedIds.length === 0) return null
    const derived = items.findIndex(item => getId(item) === selectedIds[selectedIds.length - 1])
    return derived >= 0 ? derived : null
  }, [items, getId, selectedIds])

  const handleItemClick = useCallback((id: number, e: React.MouseEvent) => {
    if (!enabled) return

    const idx = items.findIndex(item => getId(item) === id)
    if (idx === -1) return

    const anchorIdx = e.shiftKey ? resolveAnchorIndex() : null
    if (e.shiftKey && anchorIdx !== null) {
      // Shift+click: select range from the (resolved) anchor to clicked item
      const start = Math.min(anchorIdx, idx)
      const end = Math.max(anchorIdx, idx)
      const rangeIds = items.slice(start, end + 1).map(getId)
      onSelectionChange(rangeIds)
      anchorRef.current = anchorIdx
      cursorRef.current = idx
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+click: toggle in/out
      if (selectedIds.includes(id)) {
        onSelectionChange(selectedIds.filter(sid => sid !== id))
      } else {
        onSelectionChange([...selectedIds, id])
      }
      anchorRef.current = idx
      cursorRef.current = idx
    } else {
      // Plain click: single select
      onSelectionChange([id])
      anchorRef.current = idx
      cursorRef.current = idx
    }

    if (scrollToIndex) scrollToIndex(idx)
  }, [items, getId, selectedIds, onSelectionChange, scrollToIndex, enabled, resolveAnchorIndex])

  const handleArrowNav = useCallback((direction: 1 | -1, opts: { extend?: boolean; jump?: boolean } = {}) => {
    if (!enabled || items.length === 0) return
    const { extend = false, jump = false } = opts
    const lastIndex = items.length - 1

    if (jump) {
      // Ctrl/Cmd+Arrow: jump to the far end; +Shift extends the range to it (#388 P2.1)
      const target = direction === 1 ? lastIndex : 0
      if (extend) {
        const anchor = resolveAnchorIndex() ?? 0
        anchorRef.current = anchor
        cursorRef.current = target
        const start = Math.min(anchor, target)
        const end = Math.max(anchor, target)
        onSelectionChange(items.slice(start, end + 1).map(getId))
      } else {
        onSelectionChange([getId(items[target])])
        anchorRef.current = target
        cursorRef.current = target
      }
      if (scrollToIndex) scrollToIndex(target)
      return
    }

    if (extend) {
      // Shift+Arrow: extend/shrink range from the (resolved) anchor (#388 Q1)
      const anchor = resolveAnchorIndex() ?? 0
      anchorRef.current = anchor

      // Validate the stored cursor the same way (#388 P2.1): when the selection was
      // changed outside this hook (e.g. a click handled by TranscriptPanel, which never
      // touches cursorRef), the old cursor is stale — fall back to the anchor so the
      // range extends from the current position, not a phantom one.
      const c = cursorRef.current
      const cursor = (c !== null && c >= 0 && c < items.length && selectedIds.includes(getId(items[c])))
        ? c
        : anchor
      const next = Math.max(0, Math.min(lastIndex, cursor + direction))
      cursorRef.current = next

      const start = Math.min(anchor, next)
      const end = Math.max(anchor, next)
      onSelectionChange(items.slice(start, end + 1).map(getId))

      if (scrollToIndex) scrollToIndex(next)
    } else {
      // Plain arrow: single move
      const currentId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null
      const curIdx = currentId !== null
        ? items.findIndex(item => getId(item) === currentId)
        : -1
      const next = direction === 1
        ? Math.min(lastIndex, curIdx + 1)
        : Math.max(0, curIdx - 1)

      if (next >= 0 && next < items.length) {
        const nextId = getId(items[next])
        onSelectionChange([nextId])
        anchorRef.current = next
        cursorRef.current = next
        if (scrollToIndex) scrollToIndex(next)
      }
    }
  }, [items, getId, selectedIds, onSelectionChange, scrollToIndex, enabled, resolveAnchorIndex])

  return { handleItemClick, handleArrowNav }
}
