/**
 * Accessible names for the TopRail's icon-bearing controls.
 *
 * Lives in `lib/` rather than beside the component for two reasons: the rail exports
 * a component, so co-locating a helper trips `react-refresh/only-export-components`;
 * and the copy is then pinnable without mounting the rail, which would drag in the
 * router, React Query and four badge components to assert one string.
 */

/**
 * The Jot button's accessible name, carrying the unsorted count when there is one.
 *
 * The amber count is rendered INSIDE the button, and `aria-label` REPLACES a
 * control's whole subtree — so in both rail layouts the number was visible to
 * sighted users and absent from the accessibility tree. Folding it into the name is
 * the fix.
 *
 * "unsorted" is the app's own word for this exact number (`ScratchpadPopover`
 * renders "{n} unsorted"), deliberately not a new term — a screen reader hearing a
 * different noun than the popover shows is the #503 class.
 *
 * Both branches return a name, so this is NOT the #559 conditional-name trap: that
 * one evaluated to `undefined` in an edge state and left the control announced as a
 * bare "button".
 */
export function jotAccessibleName(count: number | undefined): string {
  return (count ?? 0) > 0 ? `Jot a thought, ${count} unsorted` : 'Jot a thought'
}
