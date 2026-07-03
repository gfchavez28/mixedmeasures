export interface FloatingCoords {
  x: number
  y: number
  anchorRect?: { top: number; bottom: number; left: number; right: number }
}

/** Build FloatingCoords from a DOM element's bounding rect, falling back to viewport center. */
export function coordsFromElement(elementId: string): FloatingCoords {
  const el = document.getElementById(elementId)
  if (el) {
    const rect = el.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    }
  }
  // Fallback: viewport center
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

export function computeFloatingPosition(
  coords: FloatingCoords,
  dialogWidth: number,
  dialogHeight: number,
) {
  const margin = 12
  const vw = window.innerWidth
  const vh = window.innerHeight

  let top: number
  if (coords.anchorRect) {
    // Prefer below the segment; fall back to above
    const roomBelow = vh - coords.anchorRect.bottom - margin
    if (roomBelow >= dialogHeight) {
      top = coords.anchorRect.bottom + margin
    } else {
      top = coords.anchorRect.top - dialogHeight - margin
    }
  } else {
    top = coords.y < vh / 2
      ? coords.y + margin
      : coords.y - dialogHeight - margin
  }

  // Horizontal: left of cursor when in right 40%, else right
  let left = coords.x > vw * 0.6
    ? coords.x - dialogWidth - margin
    : coords.x + margin

  // Clamp to viewport
  top = Math.max(margin, Math.min(top, vh - dialogHeight - margin))
  left = Math.max(margin, Math.min(left, vw - dialogWidth - margin))

  return { top, left }
}

/** In-vivo prefill (#526): the current text selection as a code-name candidate.
 * Whitespace-collapsed and capped; returns undefined when nothing useful is
 * selected. Capture at OPEN time — the selection may clear before submit. */
export function selectionPrefill(maxLen = 60): string | undefined {
  const raw = window.getSelection()?.toString() ?? ''
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen).trimEnd()}…` : collapsed
}
