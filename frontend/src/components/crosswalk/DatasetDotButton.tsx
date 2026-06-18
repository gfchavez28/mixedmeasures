import { type ReactNode, useState } from 'react'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'

/**
 * DatasetDotButton — unified rendering for a dataset's visual identity dot.
 *
 * Three modes:
 *
 *   1. **Identity (read-only):** no `onToggleMute`, no `onColorChange`.
 *      Renders a static dot. Used on dataset page titles, list cards, etc.
 *
 *   2. **Toggleable:** `onToggleMute` provided. Click → toggle muted state
 *      across the crosswalk. Muted = hollow ring at low opacity (visible
 *      enough to find, dim enough to not distract). Used on crosswalk
 *      column headers + cells.
 *
 *   3. **Customizable:** `onColorChange` provided. Right-click → opens a
 *      ColorSwatchPicker popover. "Reset to auto color" button clears the
 *      stored override. Often combined with toggleable so a single dot
 *      gets click-to-mute AND right-click-to-recolor.
 *
 * Drag-conflict mitigation: the dot's onPointerDown stops propagation so
 * dropping it on a draggable cell doesn't accidentally start a drag.
 *
 * a11y: 24×24 hit zone via padding around the visible dot. Tooltip on
 * hover surfaces the current state + interaction hints. aria-label
 * announces the dataset name + state.
 */

interface DatasetDotButtonProps {
  datasetId: number
  datasetName: string
  /** The dataset's effective color (resolved via getDatasetAccent). Always
   * a valid `#RRGGBB` string. */
  color: string
  /** Whether the dot is currently muted (hidden via per-dataset toggle or
   * global `allMuted`). When true, renders as a hollow low-opacity ring. */
  muted?: boolean
  /** When provided, click toggles the dataset's per-dataset muted state.
   * Omit for identity-only dots (page titles, list cards). */
  onToggleMute?: () => void
  /** When provided, right-click opens the ColorSwatchPicker popover.
   * Omit for read-only dots (cells in the crosswalk — color picking
   * happens on the column header instead, since one-place-to-customize is
   * a clearer mental model than every cell having its own picker). */
  onColorChange?: (color: string | null) => void
  /** Stored color (for the "reset to auto" affordance). When the dataset
   * has no override set, the popover hides the reset button. */
  storedColor?: string | null
  /** Visible dot diameter. Default 10px. The hit zone always wraps a
   * 24×24 button regardless. Use `compact` for tight surfaces (cells). */
  size?: 'normal' | 'compact'
}

export function DatasetDotButton({
  datasetId: _datasetId,
  datasetName,
  color,
  muted = false,
  onToggleMute,
  onColorChange,
  storedColor,
  size = 'normal',
}: DatasetDotButtonProps) {
  const [colorPickerOpen, setColorPickerOpen] = useState(false)

  const interactive = !!onToggleMute || !!onColorChange
  const dotSize = size === 'compact' ? 'w-2 h-2' : 'w-2.5 h-2.5'

  const dotStyle = muted
    ? {
        backgroundColor: 'transparent',
        borderColor: color,
        opacity: 0.4,
      }
    : { backgroundColor: color }

  // The visible dot — either solid or hollow ring
  const dotVisual = (
    <span
      aria-hidden
      className={`flex-none inline-block rounded-full border ${dotSize} ${
        muted ? 'border' : 'border-transparent'
      }`}
      style={dotStyle}
    />
  )

  // Identity-only: no wrapping button, no interaction
  if (!interactive) {
    return dotVisual
  }

  // Tooltip wording reflects the actual gesture mapping per mode:
  //   - onToggleMute + onColorChange (crosswalk): left=mute, right=picker
  //   - onToggleMute only (cells): left=mute
  //   - onColorChange only (Datasets list precedent): left=picker
  let tooltip: string
  if (onToggleMute && onColorChange) {
    tooltip = muted
      ? `${datasetName} — click to show color · right-click to change color`
      : `${datasetName} — click to hide color · right-click to change color`
  } else if (onToggleMute) {
    tooltip = muted
      ? `${datasetName} — click to show color`
      : `${datasetName} — click to hide color`
  } else {
    tooltip = `${datasetName} — click to change color`
  }

  const ariaLabel = onToggleMute
    ? muted
      ? `Show ${datasetName} color`
      : `Hide ${datasetName} color`
    : `Change color for ${datasetName}`

  // Wrap the dot in a button with a 24×24 hit zone (padding) for a11y
  const button = (
    <button
      type="button"
      aria-label={ariaLabel}
      title={tooltip}
      // Stop drag activation when the dot lives inside a draggable cell.
      // Mirrors the TypeBadge pattern in Cell.tsx:276.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggleMute?.()
      }}
      className="flex-none inline-flex items-center justify-center w-6 h-6 rounded transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus:outline-none cursor-pointer"
      style={muted ? { opacity: 0.6 } : undefined}
    >
      {dotVisual}
    </button>
  )

  // No color customization — return the toggleable button alone
  if (!onColorChange) {
    return button
  }

  // Color customization. Two flow modes:
  //
  //   - When `onToggleMute` is ALSO provided (crosswalk surfaces): the
  //     button keeps its left-click = mute behavior. The popover is
  //     anchored to (not triggered by) the button via PopoverAnchor, so
  //     left-click ONLY toggles. Right-click opens the ContextMenu;
  //     the "Change color…" item programmatically opens the Popover.
  //
  //   - When `onToggleMute` is NOT provided (Datasets list, identity
  //     surfaces with picker): left-click on the dot opens the picker
  //     directly via PopoverTrigger — the Datasets list precedent.
  //
  // This keeps left-click and right-click as distinct gestures on
  // crosswalk dots (the user explicitly flagged the previous behavior of
  // "left click ALSO opens the picker" as confusing).
  const popoverContent = (
    <PopoverContent
      align="start"
      className="w-auto p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-mm-text-muted mb-2">
        Color for <span className="font-medium text-mm-text">{datasetName}</span>
      </div>
      <ColorSwatchPicker
        value={storedColor || color}
        onChange={(c) => {
          onColorChange(c)
          setColorPickerOpen(false)
        }}
      />
      {storedColor && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full text-xs"
          onClick={() => {
            onColorChange(null)
            setColorPickerOpen(false)
          }}
        >
          Reset to auto color
        </Button>
      )}
    </PopoverContent>
  )

  if (onToggleMute) {
    // Crosswalk mode: left-click toggles mute, right-click opens the
    // ContextMenu, "Change color…" opens the Popover. The button is
    // anchored (not triggered) so left-click does NOT auto-open the picker.
    return (
      <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <PopoverAnchor asChild>{button}</PopoverAnchor>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => setColorPickerOpen(true)}>
              Change color…
            </ContextMenuItem>
            {storedColor && (
              <ContextMenuItem onSelect={() => onColorChange(null)}>
                Reset to auto color
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
        {popoverContent}
      </Popover>
    )
  }

  // Identity-with-picker mode (Datasets list precedent): left-click opens
  // the Popover. Right-click also opens the ContextMenu for keyboard
  // a11y / discoverability.
  return (
    <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setColorPickerOpen(true)}>
            Change color…
          </ContextMenuItem>
          {storedColor && (
            <ContextMenuItem onSelect={() => onColorChange(null)}>
              Reset to auto color
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {popoverContent}
    </Popover>
  )
}

export interface DatasetDotChromeProps {
  /** Wraps a child icon in the eye-toggle visual treatment. Used for the
   * global "show/hide all dots" button in CrosswalkHeader. */
  active: boolean
  onClick: () => void
  ariaLabel: string
  title: string
  children: ReactNode
}

export function DatasetDotChrome({
  active,
  onClick,
  ariaLabel,
  title,
  children,
}: DatasetDotChromeProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      className={`p-1 rounded transition-colors focus-visible:ring-2 focus-visible:ring-ring focus:outline-none ${
        active
          ? 'text-mm-text-muted hover:text-mm-text hover:bg-mm-bg'
          : 'text-mm-text-faint hover:text-mm-text-muted hover:bg-mm-bg'
      }`}
    >
      {children}
    </button>
  )
}
