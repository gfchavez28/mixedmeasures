import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface ColorDotButtonProps extends React.HTMLAttributes<HTMLElement> {
  /** Dot fill color (any CSS color string, e.g. `#RRGGBB` or `transparent`). */
  color: string
  /**
   * Classes for the visible dot. Default `'w-3 h-3 rounded-full'` (12px). The
   * dot stays small; the hit area is always a 24×24 box regardless, so the
   * visible swatch never has to grow to satisfy the target-size minimum.
   */
  dotClassName?: string
  /**
   * Render as `<span role="button">` instead of `<button>`. Required when the
   * trigger is nested inside another `<button>` (nested native buttons are
   * invalid HTML) — e.g. the TextCodePanel code row. Preserves the existing
   * click-only semantics (no `tabIndex`); #437 is a target-size fix, not a
   * keyboard-focus retrofit of those nested controls.
   */
  asSpan?: boolean
}

/**
 * #437: a small color swatch that opens a picker, with a WCAG 2.5.8-compliant
 * 24×24 hit area. The padding around the dot is transparent, so the visible
 * swatch is unchanged — only the clickable/tappable target grows.
 *
 * Mirrors `DatasetDotButton`'s proven hit-zone pattern. forwardRef + prop
 * spreading let it drop in as a Radix `PopoverTrigger asChild` child (Radix
 * composes its own onClick/ref onto the forwarded element).
 */
export const ColorDotButton = forwardRef<HTMLElement, ColorDotButtonProps>(
  function ColorDotButton(
    { color, dotClassName = 'w-3 h-3 rounded-full', asSpan = false, className, ...rest },
    ref,
  ) {
    const hitArea = cn(
      'group flex-none inline-flex items-center justify-center w-6 h-6 rounded',
      'cursor-pointer transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus:outline-none',
      className,
    )
    const dot = (
      <span
        aria-hidden
        className={cn(
          dotClassName,
          'transition-shadow group-hover:ring-2 group-hover:ring-mm-border-medium',
        )}
        style={{ backgroundColor: color }}
      />
    )

    if (asSpan) {
      return (
        <span ref={ref as React.Ref<HTMLSpanElement>} role="button" className={hitArea} {...rest}>
          {dot}
        </span>
      )
    }
    return (
      <button ref={ref as React.Ref<HTMLButtonElement>} type="button" className={hitArea} {...rest}>
        {dot}
      </button>
    )
  },
)
