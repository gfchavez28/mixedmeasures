import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The panel rail's height rules at a SHORT viewport (#998).
 *
 * Four pages render this rail — the three coding workbenches and Text Coding —
 * and all four distribute the column's height with flex ratios. That is right
 * while there IS height to distribute and produces nothing usable when there is
 * not. MEASURED on the conversation workbench at the 640x360 CSS viewport a
 * 1280x720 window has at 200% zoom, all three panels expanded, a code set
 * rendered: the column is 134px, the panels get 67/34/34, and the Codes panel's
 * code list — the only flexible child inside it — is squeezed to **0px while
 * holding 1,563px**, with its own chrome (the code-set strip, the search row)
 * clipped by the column's `overflow-hidden`. Nothing could scroll to any of it.
 *
 * 🔴 **THE SHAPE THAT WORKS IS #894's, AND ITS RULE IS "CAP THE THING THAT
 * GROWS (THE LIST), NEVER THE SECTION, WHOSE CHROME IS FIXED".** Both
 * alternatives were built and measured on the live page before this landed:
 *
 * - **A content-derived floor alone (`min-height: auto` with no list cap) is
 *   REFUTED** — the panel then takes the list's full min-content and the column
 *   scrolls **1,852px**, i.e. the code list stops being its own scroller.
 * - **Capping the PANEL (`max-h-[320px]`) is REFUTED** — it bounds the growth
 *   and re-creates the starvation the moment the chrome is large: simulated
 *   against a two-code-set strip (246px), the list came back at **8px**. This
 *   is exactly the failure #894 names.
 *
 * So the floor is content-derived and the LIST is what carries the bound: the
 * panel is as tall as its own chrome plus a capped list, and the column scrolls.
 * Measured after, same state: panels 417/203/239, code list a full 200px,
 * nothing clipped — and under the simulated two-set strip the Codes panel grows
 * 417 -> 512 while the list stays 200. It is self-correcting in the one
 * direction a flat number is not.
 *
 * ⚠️ **`min-h-0` is load-bearing at a NORMAL viewport and stays** — it is what
 * keeps a panel a bounded box whose list scrolls internally. Measured at
 * 1280x720 with all three expanded, an unconditional floor made the column
 * scroll (900px of content in 550px), so the stated minimum window is left
 * exactly as it was. The pair lives in ONE constant so the two halves cannot be
 * separated (#721/#830a's rule).
 *
 * ⚠️ **480px is the house short-viewport breakpoint** (`LoadStatus.tsx`'s
 * `PAGE_PADDING`), reused rather than a second one invented.
 *
 * ⚠️ **jsdom computes no layout, so no unit test can see any of this** — the
 * guard pins TECHNIQUE only. Re-drive at 640x360 AND at 1280x720.
 */
export const PANEL_EXPANDED = 'min-h-0 [@media(max-height:480px)]:min-h-[auto]'

/**
 * The rail COLUMN, which must be able to scroll (#998).
 *
 * Three of the four rails were `overflow-hidden` and the document one declared
 * no overflow at all — so the over-subscribed state was either invisible or a
 * spill, and #894's rule is that an overlap reads as corrupted text where an
 * overflow is merely clipped. `overflow-x-hidden` keeps the horizontal answer
 * these columns already had.
 *
 * ⚠️ It is UNCONDITIONAL and that is safe because `PANEL_EXPANDED` keeps
 * `min-h-0` above the breakpoint: measured at 1280x720, the column's
 * `scrollHeight` equals its `clientHeight`, so this scrolls nothing there.
 * ⚠️ A scrolling column full of controls needs no `tabIndex` (#894) — the axe
 * scrollable-region-focusable rule applies only to regions with no focusable
 * content. Recorded so the absence is not "fixed".
 */
export const PANEL_RAIL_SCROLL = 'overflow-x-hidden overflow-y-auto'

/**
 * A rail panel's own growable list — the flexible child `PANEL_EXPANDED` bounds
 * itself against (#998).
 *
 * `50vh` rather than a fresh number: `TextCodePanel` already caps the sibling
 * code list at exactly that, and `TextNotesPanel` at `30vh`, so those two need
 * nothing here and are deliberately left alone. The four that did need it are
 * `CodePanel`, `NotesPanel`, `MemoPanel` and `ObservationWorkbench`'s own
 * `ObservationNotesPanel`.
 *
 * ⚠️ Conditional, unlike those two: unconditionally capping at half the viewport
 * would shorten these lists on a tall monitor, where nothing is wrong.
 */
export const PANEL_SCROLLER = 'flex-1 overflow-y-auto [@media(max-height:480px)]:max-h-[50vh]'

interface CollapsiblePanelProps {
  title: string
  isCollapsed: boolean
  onToggle: () => void
  children: React.ReactNode
  className?: string
  headerExtra?: React.ReactNode
}

export default function CollapsiblePanel({
  title,
  isCollapsed,
  onToggle,
  children,
  className,
  headerExtra,
}: CollapsiblePanelProps) {
  return (
    <div className={cn('flex flex-col min-h-[36px]', className)}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-mm-bg border-b">
        <button
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          className="flex items-center gap-2 hover:bg-mm-surface-hover transition-colors text-left rounded px-1 -ml-1"
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-mm-text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-mm-text-muted" />
          )}
          <span className="text-sm font-medium text-mm-text">{title}</span>
        </button>
        {headerExtra}
      </div>
      {!isCollapsed && (
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      )}
    </div>
  )
}
