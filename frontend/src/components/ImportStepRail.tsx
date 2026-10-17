import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AFTER_LAST_STEP, RAIL_COLLAPSED_LABEL, RAIL_DONE_TEXT, railPosition } from '@/lib/step-rail'

/**
 * The step bar at the top of every import wizard — ONE component for all seven
 * (#1184): Conversation, Dataset, Document, Append, Observation and Coding Import
 * ("Import progress") and Merge ("Merge progress").
 *
 * Each wizard used to build its own, and the seven had drifted five ways: a Check
 * on a done step in five and the number in two; nothing that told a reader a step
 * was DONE (lucide's Check is `aria-hidden`, so a completed step read as its bare
 * label); Document's raw `bg-purple-600 text-white` where the rest used the fill
 * tokens (#1009/#1016); two sizes; and a step not on a rail (`findIndex` → −1)
 * painted the whole rail as not started. And at 640×360 two of them ran off the
 * window (Conversation with several transcripts by 46 px, measured; Dataset with
 * the column chooser and several files by ~99, computed).
 *
 * - **The caller says where the import IS** (`current`), as Merge's `labelForStep`
 *   always did: each wizard maps EVERY internal step to a rail key, or to
 *   `AFTER_LAST_STEP` for a result screen past the last one. A total
 *   `Record<Step, …>` makes a forgotten step a compile error.
 * - **An `<ol>` of `<li>`s** inside the `<nav>`, so the list says "3 of 5" — the
 *   circle's number is `aria-hidden`, and a done step says so in words.
 * - 🔴 **Narrow windows: non-current labels collapse with `sr-only` below ONE
 *   container width, sized to the WIDEST rail (#899).** Measured in the page
 *   (13 px Plus Jakarta Sans 500): Merge's five steps are ~689 px at this size, so
 *   the threshold is 44 rem (704 px) — under the narrowest desktop container
 *   (Observation's 720). The cost, accepted: a short rail that would have fit also
 *   collapses between its own width and 704 px of container. The current step's
 *   label always shows. ⚠️ `@max-…:sr-only`, never `sr-only @min-…:not-sr-only`
 *   (#721: `not-sr-only` zeroes the label's margin). ⚠️ `sr-only` is
 *   `position:absolute`; the `@container` gives the `<nav>` layout containment, so
 *   the hidden labels resolve against it and cannot scroll the page (#1156).
 * - Sizes are the compact pair the Coding and Merge rails used (w-7, mx-3) — at
 *   w-8/mx-4 Merge is ~741 px, wider than Observation's 720-px container, so no
 *   threshold could keep every rail open on a desktop window.
 */

export type StepRailAccent = 'primary' | 'orange' | 'teal' | 'purple'

export interface StepRailStep<K extends string = string> {
  key: K
  label: string
}

const CURRENT: Record<StepRailAccent, string> = {
  primary: 'bg-primary text-primary-foreground',
  orange: 'bg-mm-orange-fill text-mm-on-fill',
  teal: 'bg-mm-teal-fill text-mm-on-fill',
  purple: 'bg-mm-purple-fill text-mm-on-fill',
}

const DONE: Record<StepRailAccent, string> = {
  primary: 'bg-primary/15 text-primary',
  orange: 'bg-mm-orange/15 text-mm-orange-text',
  teal: 'bg-mm-teal/15 text-mm-teal-text',
  purple: 'bg-mm-purple/15 text-mm-purple-text',
}

/**
 * Not yet reached — one recipe for all seven. Two rails used `bg-mm-bg
 * text-mm-text-faint`, a circle the colour of the page (1.00:1 against it); this
 * one reads 5.37:1 light / 7.60:1 dark for the number and still shows the circle.
 */
const FUTURE = 'bg-mm-border-subtle text-mm-text-secondary'

/** The chevron's margin tightens with the label collapse (`RAIL_COLLAPSED_LABEL`). */
const RAIL_COLLAPSED_CHEVRON = '@max-[44rem]/steps:mx-1'

export default function ImportStepRail<K extends string>({
  label,
  steps,
  current,
  accent,
  className,
}: {
  /** The landmark's name — "Import progress" or "Merge progress". */
  label: string
  steps: readonly StepRailStep<K>[]
  /** The rail key the wizard is on, or `AFTER_LAST_STEP`. */
  current: K | typeof AFTER_LAST_STEP
  accent: StepRailAccent
  className?: string
}) {
  const position = railPosition(steps, current)
  return (
    <nav aria-label={label} className={cn('@container/steps', className)}>
      <ol className="flex items-center justify-between">
        {steps.map((s, i) => {
          const state = i < position ? 'done' : i === position ? 'current' : 'future'
          return (
            <li
              key={s.key}
              className="flex items-center"
              aria-current={state === 'current' ? 'step' : undefined}
              data-step-state={state}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm font-medium',
                  state === 'current' ? CURRENT[accent] : state === 'done' ? DONE[accent] : FUTURE,
                )}
              >
                {state === 'done' ? <Check className="w-4 h-4" /> : i + 1}
              </span>
              <span
                className={cn(
                  'ml-2 text-sm font-medium whitespace-nowrap',
                  state !== 'current' && RAIL_COLLAPSED_LABEL,
                )}
              >
                {s.label}
              </span>
              {state === 'done' && <span className="sr-only">{RAIL_DONE_TEXT}</span>}
              {i < steps.length - 1 && (
                <ChevronRight
                  aria-hidden="true"
                  className={cn('w-4 h-4 mx-3 shrink-0 text-mm-text-faint', RAIL_COLLAPSED_CHEVRON)}
                />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
