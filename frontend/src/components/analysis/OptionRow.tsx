import { useId, type ElementType, type ReactNode } from 'react'

interface OptionRowProps {
  icon: ElementType
  label: string
  children: ReactNode
  fullWidth?: boolean
}

/**
 * One labelled row of a chart-options panel.
 *
 * 🔴 **The two branches name their contents DIFFERENTLY, and `fullWidth` is a
 * NAMING switch as much as a layout one (#900).**
 *
 * - The default branch renders a `<label>` wrapping `children`, so a single
 *   control inside it is named by implicit association — this is the FOURTH
 *   route by which a Radix `SelectTrigger` gets a name (#889 recorded three),
 *   and it is why *Color palette* and *Data labels* announce correctly while
 *   carrying no `aria-label`, no `aria-labelledby` and no `htmlFor`.
 * - The `fullWidth` branch cannot do that: it holds a GROUP of controls, and a
 *   `<label>` names only its first labelable descendant. It therefore renders a
 *   labelled `role="group"` — which names the SET, never the members. **Every
 *   control inside a `fullWidth` row must still name itself.**
 *
 * ⚠️ **The group label is load-bearing, not decoration.** *Exclude values* and
 * *Hide from chart* render the same `responseLabels`, so when both are shown a
 * reader meets two identically-named checkbox sets; the group name is the only
 * thing that separates them.
 *
 * ⚠️ **The default branch names exactly ONE control.** Passing it two is #906
 * (`Axis range`): the second is unnamed and the first's name absorbs the
 * second's value. Guard: `OptionRow.test.tsx`.
 */
export default function OptionRow({ icon: Icon, label, children, fullWidth }: OptionRowProps) {
  const labelId = useId()

  if (fullWidth) {
    return (
      <div className="space-y-1.5" role="group" aria-labelledby={labelId}>
        <div id={labelId} className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
          <Icon className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
          {label}
        </div>
        {children}
      </div>
    )
  }
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="flex items-center gap-1.5 text-xs text-mm-text-secondary shrink-0">
        <Icon className="w-3.5 h-3.5 text-mm-text-faint" />
        {label}
      </span>
      <div className="flex-1 min-w-0 max-w-[180px]">{children}</div>
    </label>
  )
}
