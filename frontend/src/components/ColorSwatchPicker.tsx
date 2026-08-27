// Shared color palette and picker for categories and domains
import { useRef, useState } from 'react'
import { CATEGORY_COLORS } from '@/lib/chart-data'
import { colorName } from '@/lib/color-names'
export { CATEGORY_COLORS }

/**
 * The shared colour picker — ONE radiogroup, not sixteen toggle buttons (#788).
 *
 * 🔴 **It cost 16 tab stops, at ~27 mount points.** Every swatch was a separate
 * tabbable `toggle button`, so reaching anything past the palette meant sixteen
 * presses, and each announced its HEX (`Color #3b82f6`) — a string a
 * screen-reader user cannot tell from the next one. Heard on 2026-08-22 while
 * creating a category; the same component is mounted by the codebook panels, the
 * canvas, participants, settings, datasets, conversation import and crosswalk, so
 * the fix lands everywhere at once.
 *
 * ⚠️ **SELECTION DOES NOT FOLLOW FOCUS, and that is not the default reading of the
 * radiogroup pattern.** APG's usual radiogroup selects as you arrow. Here it must
 * not: two call sites CLOSE their popover in `onChange` (`SettingsPage`,
 * `ThemeRelationshipPopover`), so selection-on-arrow would shut the picker on the
 * first keypress and make it unusable by keyboard at exactly those sites. APG
 * documents this variant ("radio buttons not checked on focus") for precisely the
 * case where selection has consequences. Arrows move focus; Space/Enter commit.
 *
 * ⚠️ Space/Enter are handled by the native `<button>` firing `onClick` — NOT by the
 * keydown handler below. Adding them there would double-fire, and `role="radio"`
 * does not change a button's native activation.
 *
 * ⚠️ **`useListKeyboardNav` was considered and rejected.** It is a VIRTUAL-focus
 * helper (an index plus `data-focused`, no DOM focus), Down/Up only, and it clamps
 * at the ends. A radiogroup needs real DOM focus, a horizontal primary axis, and
 * wrapping. Adopting it would have been a shared rule taken into a consumer that
 * violates its premise — the #773 mistake.
 *
 * ⚠️ Swatches stay 28px (`w-7 h-7`), above the 24px target-size floor (#437).
 */
export function ColorSwatchPicker({
  value,
  onChange,
  label = 'Color',
}: {
  value: string
  onChange: (color: string) => void
  /** Names the group. Override where the page has several (e.g. "Line color"). */
  label?: string
}) {
  const selectedIndex = CATEGORY_COLORS.indexOf(value)
  // Null until the user arrows: the tabbable swatch is the CHECKED one (APG), and
  // falls back to the first so an unset picker is still reachable by Tab. Keeping
  // it null rather than seeding state means an externally-changed `value` moves the
  // tab stop with it, instead of stranding it on a swatch nobody chose.
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const activeIndex = focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0)
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const moveTo = (next: number) => {
    const i = (next + CATEGORY_COLORS.length) % CATEGORY_COLORS.length
    setFocusIndex(i)
    refs.current[i]?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      // Both axes: the swatches are a wrapping row, so which arrow "means next"
      // depends on where the wrap falls. Treating it as one sequence is honest and
      // matches what a reader expects of a radiogroup.
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault(); moveTo(activeIndex + 1); break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault(); moveTo(activeIndex - 1); break
      case 'Home':
        e.preventDefault(); moveTo(0); break
      case 'End':
        e.preventDefault(); moveTo(CATEGORY_COLORS.length - 1); break
    }
  }

  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5" onKeyDown={handleKeyDown}>
      {CATEGORY_COLORS.map((color, i) => (
        <button
          key={color}
          type="button"
          role="radio"
          ref={el => { refs.current[i] = el }}
          aria-label={colorName(color)}
          aria-checked={value === color}
          tabIndex={i === activeIndex ? 0 : -1}
          className={`w-7 h-7 rounded-md border-2 transition-all ${
            value === color ? 'border-mm-text scale-110 shadow-xs' : 'border-transparent hover:border-mm-border-medium'
          }`}
          style={{ backgroundColor: color }}
          onClick={() => { setFocusIndex(i); onChange(color) }}
        />
      ))}
    </div>
  )
}
