import { useState, useRef, useEffect, useCallback, type RefObject } from 'react'

export interface SplitableSegment {
  id: number
  text: string
  sequence_order: number
  group_id?: number | null
}

export interface SplitRange {
  segment_id: number
  start_offset: number
  end_offset: number
}

export interface SplitSelection {
  ranges: SplitRange[]
  rect: { top: number; left: number }
}

/**
 * Shared text-split selection logic for coding workbenches.
 * Uses coordinate-based caret resolution (caretPositionFromPoint / caretRangeFromPoint)
 * to determine exact text positions from mouse coordinates.
 *
 * Also provides live drag-to-select: when the user clicks and drags across multiple
 * segments, the selection updates in real-time during the drag (not just on mouseup).
 */
export function useTextSplitSelection(
  containerRef: RefObject<HTMLElement | null>,
  segments: SplitableSegment[],
  onSplit: ((ranges: SplitRange[]) => void) | undefined,
  onSelectionChange?: (ids: number[]) => void,
  options?: { allSegments?: SplitableSegment[] }
): {
  splitSelection: SplitSelection | null
  handleSplit: () => void
  handleCancelSplit: () => void
  getTextSelectionForSegment: (segmentId: number) => { start: number; end: number } | null
  announcement: string | null
} {
  const [splitSelection, setSplitSelection] = useState<SplitSelection | null>(null)
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const splitDragAnchorRef = useRef<{ segmentId: number; offset: number } | null>(null)

  // Drag-to-select tracking refs
  const isDraggingRef = useRef(false)
  const dragAnchorSegIdRef = useRef<number | null>(null)
  const isMultiDragRef = useRef(false)
  const lastDragStartRef = useRef(-1)
  const lastDragEndRef = useRef(-1)

  // Use allSegments for adjacency validation when provided (handles filtered views)
  const adjacencySegments = options?.allSegments ?? segments

  // Clear split selection when segments change
  useEffect(() => {
    setSplitSelection(null)
  }, [segments])

  // Detect text selection for split using mousedown/mouseup coordinate tracking.
  useEffect(() => {
    if (!onSplit) return

    // Get caret position from mouse coordinates (cross-browser)
    const getCaretFromPoint = (x: number, y: number): { node: Node; offset: number } | null => {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y)
        if (pos) return { node: pos.offsetNode, offset: pos.offset }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((document as any).caretRangeFromPoint) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const range = (document as any).caretRangeFromPoint(x, y)
        if (range) return { node: range.startContainer, offset: range.startOffset }
      }
      return null
    }

    // Find the text element (data-segment-id) containing a DOM node.
    const findTextElement = (node: Node): { segmentId: number; textEl: HTMLElement } | null => {
      let el: Node | null = node
      while (el) {
        if (el instanceof HTMLElement && el.dataset.segmentId) {
          return { segmentId: parseInt(el.dataset.segmentId), textEl: el }
        }
        el = el.parentElement
      }
      // Fallback: walk up to segment row (id="segment-NNN"), then find text div within.
      el = node
      while (el) {
        if (el instanceof HTMLElement && el.id?.startsWith('segment-')) {
          const segId = parseInt(el.id.replace('segment-', ''))
          const textEl = el.querySelector('[data-segment-id]') as HTMLElement | null
          if (textEl && !isNaN(segId)) {
            return { segmentId: segId, textEl }
          }
        }
        el = el.parentElement
      }
      return null
    }

    // Find segment ID from any element within a segment row (broader than findTextElement)
    const findSegmentIdFromElement = (el: Element | null): number | null => {
      let node: Element | null = el
      while (node) {
        if (node instanceof HTMLElement) {
          if (node.dataset.segmentId) return parseInt(node.dataset.segmentId)
          if (node.id?.startsWith('segment-')) return parseInt(node.id.replace('segment-', ''))
        }
        node = node.parentElement
      }
      return null
    }

    // Find segment ID at a screen point
    const findSegmentIdAtPoint = (x: number, y: number): number | null => {
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      return findSegmentIdFromElement(el)
    }

    // Compute character offset of a caret position within a text element
    const computeCharOffset = (textEl: HTMLElement, node: Node, offset: number): number => {
      if (node === textEl) {
        return offset === 0 ? 0 : (textEl.textContent?.length ?? 0)
      }
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
      let charCount = 0
      let textNode: Text | null
      while ((textNode = walker.nextNode() as Text | null)) {
        if (textNode === node) {
          return charCount + offset
        }
        charCount += textNode.length
      }
      const cmp = node.compareDocumentPosition(textEl)
      if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) {
        return 0
      }
      return textEl.textContent?.length ?? 0
    }

    // Resolve a mouse position to a segment ID + character offset
    const resolvePosition = (clientX: number, clientY: number): { segmentId: number; offset: number } | null => {
      const caret = getCaretFromPoint(clientX, clientY)
      if (!caret) return null
      const textInfo = findTextElement(caret.node)
      if (!textInfo) return null
      const offset = computeCharOffset(textInfo.textEl, caret.node, caret.offset)
      return { segmentId: textInfo.segmentId, offset }
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const pos = resolvePosition(e.clientX, e.clientY)
      splitDragAnchorRef.current = pos

      // Also capture segment ID for drag-to-select (broader: works on badges, chips, etc.)
      const segId = pos?.segmentId ?? findSegmentIdFromElement(e.target as Element)
      isDraggingRef.current = true
      dragAnchorSegIdRef.current = segId
      isMultiDragRef.current = false
      lastDragStartRef.current = -1
      lastDragEndRef.current = -1
    }

    // Scroll listener: invalidate drag anchor if container scrolls during selection
    let scrollHandler: (() => void) | null = null
    const attachScrollListener = () => {
      const container = containerRef.current
      if (!container) return
      scrollHandler = () => {
        splitDragAnchorRef.current = null
        isDraggingRef.current = false
        dragAnchorSegIdRef.current = null
        isMultiDragRef.current = false
        container.style.userSelect = ''
      }
      container.addEventListener('scroll', scrollHandler, true)
    }
    const detachScrollListener = () => {
      const container = containerRef.current
      if (container && scrollHandler) {
        container.removeEventListener('scroll', scrollHandler, true)
      }
      scrollHandler = null
    }

    const handleMouseDownWithScroll = (e: MouseEvent) => {
      handleMouseDown(e)
      if (e.button === 0) attachScrollListener()
    }

    // Live drag-to-select: update selection in real-time as cursor moves across segments
    let moveFrameId: number | null = null
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || dragAnchorSegIdRef.current === null || !onSelectionChange) return
      if (moveFrameId !== null) return // rAF throttle

      const x = e.clientX
      const y = e.clientY
      moveFrameId = requestAnimationFrame(() => {
        moveFrameId = null
        const currentSegId = findSegmentIdAtPoint(x, y)
        if (currentSegId === null) return

        // Once cursor moves to a different segment, we're in multi-drag mode.
        // Suppress native text selection — user is selecting segments, not text.
        if (currentSegId !== dragAnchorSegIdRef.current && !isMultiDragRef.current) {
          isMultiDragRef.current = true
          window.getSelection()?.removeAllRanges()
          const container = containerRef.current
          if (container) container.style.userSelect = 'none'
        }

        if (!isMultiDragRef.current) return

        // Compute range from anchor to current
        const anchorIdx = segments.findIndex(s => s.id === dragAnchorSegIdRef.current)
        const currentIdx = segments.findIndex(s => s.id === currentSegId)
        if (anchorIdx < 0 || currentIdx < 0) return

        const start = Math.min(anchorIdx, currentIdx)
        const end = Math.max(anchorIdx, currentIdx)

        // Skip if range hasn't changed
        if (start === lastDragStartRef.current && end === lastDragEndRef.current) return
        lastDragStartRef.current = start
        lastDragEndRef.current = end

        const rangeIds = segments.slice(start, end + 1).map(s => s.id)
        onSelectionChange(rangeIds)
      })
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return
      detachScrollListener()

      // Restore native text selection if suppressed during multi-drag
      const container = containerRef.current
      if (container) container.style.userSelect = ''

      // Clear drag state
      isDraggingRef.current = false
      dragAnchorSegIdRef.current = null
      isMultiDragRef.current = false
      lastDragStartRef.current = -1
      lastDragEndRef.current = -1

      const clientX = e.clientX
      const clientY = e.clientY
      const anchor = splitDragAnchorRef.current
      splitDragAnchorRef.current = null

      requestAnimationFrame(() => {
        if (!anchor) {
          setSplitSelection(null)
          setAnnouncement(null)
          return
        }

        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          setSplitSelection(null)
          setAnnouncement(null)
          return
        }

        const endPos = resolvePosition(clientX, clientY)
        if (!endPos) {
          setSplitSelection(null)
          setAnnouncement(null)
          return
        }

        let startSegId = anchor.segmentId
        let startOffset = anchor.offset
        let endSegId = endPos.segmentId
        let endOffset = endPos.offset

        const selRange = sel.rangeCount ? sel.getRangeAt(0) : null
        const selRect = selRange?.getBoundingClientRect()
        const toolbarRect = selRect
          ? { top: selRect.top + window.scrollY, left: selRect.left + selRect.width / 2 - 30 }
          : { top: clientY + window.scrollY - 40, left: clientX - 30 }

        if (startSegId === endSegId) {
          // Single segment selection
          const seg = segments.find(s => s.id === startSegId)
          if (!seg) { setSplitSelection(null); return }

          if (startOffset > endOffset) {
            [startOffset, endOffset] = [endOffset, startOffset]
          }

          if (startOffset === endOffset) { setSplitSelection(null); return }

          // Bug fix #6: use boundary check instead of trim()
          const atStart = startOffset === 0
          const atEnd = endOffset >= seg.text.length
          if (atStart && atEnd) { setSplitSelection(null); return }

          setSplitSelection({
            ranges: [{ segment_id: startSegId, start_offset: startOffset, end_offset: endOffset }],
            rect: toolbarRect,
          })
          setAnnouncement('Text selected for split')
        } else {
          // Multi-segment selection
          let startIdx = segments.findIndex(s => s.id === startSegId)
          let endIdx = segments.findIndex(s => s.id === endSegId)
          if (startIdx < 0 || endIdx < 0) {
            setSplitSelection(null)
            return
          }

          if (startIdx > endIdx) {
            [startIdx, endIdx] = [endIdx, startIdx];
            [startOffset, endOffset] = [endOffset, startOffset]
            startSegId = segments[startIdx].id
            endSegId = segments[endIdx].id
          }

          if (endOffset === 0 && endIdx > startIdx) {
            endIdx--
            endSegId = segments[endIdx].id
            endOffset = segments[endIdx].text.length
          }

          // Bug fix #7: check group_id when multi collapses to single
          if (startIdx === endIdx) {
            const seg = segments[startIdx]
            if (seg.group_id) { setSplitSelection(null); return }
            const atStart = startOffset === 0
            const atEnd = endOffset >= seg.text.length
            if (atStart && atEnd) { setSplitSelection(null); return }
            if (atStart) { setSplitSelection(null); return }

            setSplitSelection({
              ranges: [{ segment_id: seg.id, start_offset: startOffset, end_offset: seg.text.length }],
              rect: toolbarRect,
            })
            setAnnouncement('Text selected for split')
            return
          }

          // Bug fix #2: use adjacencySegments (allSegments) for adjacency check
          let adjacent = true
          for (let i = startIdx; i < endIdx; i++) {
            const curSeq = segments[i].sequence_order
            const nextSeq = segments[i + 1].sequence_order
            // Find these segments in the full (unfiltered) list to validate true adjacency
            const curAllIdx = adjacencySegments.findIndex(s => s.id === segments[i].id)
            const nextAllIdx = adjacencySegments.findIndex(s => s.id === segments[i + 1].id)
            if (curAllIdx < 0 || nextAllIdx < 0) { adjacent = false; break }
            if (nextSeq !== curSeq + 1) {
              // Not sequence-adjacent — check if they're actually neighbors in the full list
              if (nextAllIdx !== curAllIdx + 1) { adjacent = false; break }
            }
          }
          if (!adjacent) { setSplitSelection(null); return }

          // Check no grouped segments
          for (let i = startIdx; i <= endIdx; i++) {
            if (segments[i].group_id) { setSplitSelection(null); return }
          }

          // Build ranges
          const ranges: SplitRange[] = []
          ranges.push({
            segment_id: startSegId,
            start_offset: startOffset,
            end_offset: segments[startIdx].text.length,
          })
          for (let i = startIdx + 1; i < endIdx; i++) {
            ranges.push({
              segment_id: segments[i].id,
              start_offset: 0,
              end_offset: segments[i].text.length,
            })
          }
          ranges.push({
            segment_id: endSegId,
            start_offset: 0,
            end_offset: endOffset,
          })

          setSplitSelection({ ranges, rect: toolbarRect })
          setAnnouncement(`Text selected for split across ${endIdx - startIdx + 1} segments`)

          // Auto-select the dragged segments
          if (onSelectionChange) {
            const draggedIds = segments.slice(startIdx, endIdx + 1).map(s => s.id)
            onSelectionChange(draggedIds)
          }
        }
      })
    }

    const container = containerRef.current
    if (!container) return

    container.addEventListener('mousedown', handleMouseDownWithScroll)
    container.addEventListener('mousemove', handleMouseMove)
    container.addEventListener('mouseup', handleMouseUp)
    return () => {
      container.removeEventListener('mousedown', handleMouseDownWithScroll)
      container.removeEventListener('mousemove', handleMouseMove)
      container.removeEventListener('mouseup', handleMouseUp)
      detachScrollListener()
      container.style.userSelect = ''
      if (moveFrameId !== null) cancelAnimationFrame(moveFrameId)
    }
  }, [onSplit, segments, adjacencySegments, onSelectionChange, containerRef])

  const handleSplit = useCallback(() => {
    if (!splitSelection || !onSplit) return
    onSplit(splitSelection.ranges)
    setSplitSelection(null)
    setAnnouncement('Segment split')
    window.getSelection()?.removeAllRanges()
  }, [splitSelection, onSplit])

  const handleCancelSplit = useCallback(() => {
    setSplitSelection(null)
    setAnnouncement('Split cancelled')
    window.getSelection()?.removeAllRanges()
  }, [])

  const getTextSelectionForSegment = useCallback((segmentId: number): { start: number; end: number } | null => {
    if (!splitSelection) return null
    const range = splitSelection.ranges.find(r => r.segment_id === segmentId)
    return range ? { start: range.start_offset, end: range.end_offset } : null
  }, [splitSelection])

  return {
    splitSelection,
    handleSplit,
    handleCancelSplit,
    getTextSelectionForSegment,
    announcement,
  }
}
