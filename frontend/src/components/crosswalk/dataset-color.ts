/**
 * Per-dataset color palette for crosswalk visual identification.
 *
 * Used by `CrosswalkColumnHeaders` (header dot) and reserved for the deferred
 * #315 cell-side dataset accent (color-coded left border, etc.). Centralizing
 * the palette + index logic here means both surfaces stay in sync without
 * passing colors through the prop chain.
 *
 * Color choices avoid collisions with the crosswalk's existing semantic colors:
 *   - mm-blue (search highlight, drop-over ring) → no blue/sky/cyan
 *   - amber (conflict flash) → no amber/yellow
 *   - indigo (#6366f1, bracket-color fallback) → no indigo
 *   - The palette is chosen to be peripheral; bracket colors are user-picked
 *     and take more visual real estate, so dataset and bracket colors can
 *     occasionally coincide without confusion (different spatial zones).
 *
 * Stability invariant: a dataset's color is computed from its ID's position
 * in the *sorted full project dataset list*, NOT its position in the
 * currently-active (filtered) list. Toggling a dataset off and back on
 * keeps its color the same. Two datasets in different projects can share
 * a color — the palette is project-scoped, not global.
 */

const DATASET_COLOR_PALETTE = [
  '#10b981', // emerald-500
  '#14b8a6', // teal-500
  '#ec4899', // pink-500
  '#f97316', // orange-500
  '#d946ef', // fuchsia-500
  '#84cc16', // lime-500
] as const

/**
 * Resolve the accent color for a given dataset, stable across renders and
 * dataset toggle state.
 *
 * Priority:
 *   1. User-set `storedColor` (from `Dataset.color` — `#RRGGBB`). Wins
 *      whenever provided and well-formed.
 *   2. Auto-assigned palette color (position-indexed by sorted dataset ID).
 *      Stable across toggling so a dataset's identity color doesn't shift
 *      when the researcher hides + restores it.
 *
 * @param datasetId The dataset to color.
 * @param allDatasetIds Full list of project dataset IDs (filtered or not —
 *   the function sorts and takes a stable index). Pass `projectDatasets.map(d => d.dataset_id)`.
 * @param storedColor Optional user override. `#RRGGBB` hex; null/undefined
 *   falls back to the palette.
 * @returns A hex color string. If `datasetId` isn't in `allDatasetIds`
 *   AND no `storedColor` is set, returns the first palette color as a
 *   safe fallback.
 */
export function getDatasetAccent(
  datasetId: number,
  allDatasetIds: number[],
  storedColor?: string | null,
): string {
  if (storedColor && /^#[0-9a-fA-F]{6}$/.test(storedColor)) {
    return storedColor
  }
  const sorted = [...allDatasetIds].sort((a, b) => a - b)
  const idx = sorted.indexOf(datasetId)
  if (idx < 0) return DATASET_COLOR_PALETTE[0]
  return DATASET_COLOR_PALETTE[idx % DATASET_COLOR_PALETTE.length]
}

/** Exposed for tests + future cell-side accent (#315). */
export const DATASET_PALETTE_SIZE = DATASET_COLOR_PALETTE.length
