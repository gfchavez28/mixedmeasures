import { LoadState } from '@/components/LoadStatus'
import type { ListLoad } from '@/lib/list-status'

/**
 * #1175 — the removal plan's non-ready states inside a delete confirmation:
 * "checking" while it loads, and after a failure that the check could not run,
 * with a Retry (`components/LoadStatus.tsx` owns both wordings and the slow hint).
 *
 * Rendered OUTSIDE the dialog's description, beside it: both notices carry their
 * own live role, and a Retry button inside the described element would be read
 * as part of the description.
 *
 * ⚠️ No `landingRef`: a successful Retry unmounts the focused button, and Radix's
 * focus trap moves focus to the dialog itself when a focused node is removed
 * (`@radix-ui/react-focus-scope`'s mutation observer) — so focus never falls to
 * `<body>` here, unlike a page-level notice.
 */
export function RemovalPlanStatus({ load }: { load: ListLoad }) {
  if (load.status === 'ready' && !load.retrying) return null
  return (
    <LoadState
      load={load}
      size="panel"
      loadingLabel="Checking what else this delete removes…"
      failedTitle="What else this delete removes could not be checked."
    />
  )
}
