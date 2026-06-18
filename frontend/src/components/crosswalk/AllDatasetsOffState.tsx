/**
 * Empty state when all dataset toggles in the header are off (§2 item 35).
 * Informational — not a blocker. The user toggles a dataset back on in the
 * header and the grid re-renders.
 */

export function AllDatasetsOffState() {
  return (
    <div
      data-testid="all-datasets-off-state"
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      <div className="max-w-md">
        <h2 className="text-lg font-semibold text-mm-text mb-2">
          No datasets selected
        </h2>
        <p className="text-sm text-mm-text-secondary">
          Toggle at least one dataset in the header to see the crosswalk.
        </p>
      </div>
    </div>
  )
}
