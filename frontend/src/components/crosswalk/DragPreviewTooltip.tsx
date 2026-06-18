/**
 * DragPreviewTooltip — the element rendered inside dnd-kit's DragOverlay
 * during a crosswalk drag. Visually a 1:1 match for the source cell so the
 * drag reads as "the cell follows the cursor" rather than "a tooltip about
 * the cell follows the cursor." Subtle elevation cues (shadow + slightly
 * thicker blue border) communicate "this is the lifted element" without
 * changing the cell's content shape.
 *
 * dnd-kit's DragOverlay sizes itself to the active draggable's bounding
 * box automatically — we don't set explicit width/height here.
 *
 * Respects prefers-reduced-motion: under reduced motion the lift transform
 * is skipped (motion-safe: prefix). dnd-kit's drop animation is suppressed
 * via `dropAnimation={null}` in useCrosswalkDnD.
 *
 * Keyboard mode (Phase 3.14 future): when the drag is initiated via the
 * KeyboardSensor, dnd-kit anchors the overlay to the focused drop target
 * automatically — no special handling needed at this layer.
 */

import type { CellData } from './crosswalk-types'
import { RotateCcw } from 'lucide-react'

interface DragPreviewTooltipProps {
  cell: CellData
  /** When the drag originated from a multi-select set (≥2), the count of
   * columns being moved. Renders as a small absolutely-positioned badge in
   * the top-right of the preview. The lead card visual stays — Finder /
   * Excel convention beats trying to render a stacked pile that dnd-kit's
   * DragOverlay would auto-size and clip. */
  multiSelectCount?: number
}

export function DragPreviewTooltip({ cell, multiSelectCount }: DragPreviewTooltipProps) {
  const showBadge = multiSelectCount != null && multiSelectCount >= 2
  return (
    <div
      aria-hidden="true"
      className="relative pointer-events-none flex items-start gap-2 rounded border-2 border-mm-blue bg-mm-surface px-3 py-2 min-h-[48px] shadow-lg motion-safe:scale-[1.02] motion-safe:transition-transform"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {cell.column_code && (
            <span className="font-mono text-[10px] text-mm-text-muted">{cell.column_code}</span>
          )}
          {cell.is_reverse_scored && (
            <span
              className="inline-flex items-center text-amber-600 dark:text-amber-400"
              aria-label="reverse-scored"
            >
              <RotateCcw className="w-3 h-3" />
            </span>
          )}
        </div>
        <div className="text-sm text-mm-text leading-snug truncate">{cell.column_text}</div>
      </div>
      <span
        className="flex-none text-[10px] text-mm-text-muted uppercase tracking-wide"
        title={`Column type: ${cell.column_type}`}
      >
        {cell.column_type}
      </span>
      {showBadge && (
        <span
          aria-label={`Moving ${multiSelectCount} columns`}
          className="absolute -top-2 -right-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-mm-blue text-white text-[10px] font-semibold leading-none shadow"
        >
          +{multiSelectCount - 1}
        </span>
      )}
    </div>
  )
}
