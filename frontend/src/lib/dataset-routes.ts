/**
 * The dataset workspace's two views, and the ONE place their paths are built.
 *
 * A dataset has two views of the same thing, the split SPSS and jamovi both
 * teach: **Data** (records as rows) and **Variables** (the variables themselves
 * — name, label, type, value labels, missing values, recodes). They are
 * separate routes under one nav strip rather than in-page tabs, because
 * activating one NAVIGATES: the ARIA tab pattern would promise a tabpanel that
 * this surface does not have, and `TopRail` already establishes the house shape
 * (a `<nav>` of links carrying `aria-current="page"`).
 *
 * ⚠️ **Single-sourced because it was not.** The Variables view was reachable as
 * `…/recode?column=N` from FIVE call sites, each hand-rolling the template
 * literal: the grid's context menu, the column-editor popover, `ColumnPicker`,
 * `ValueLabelsDialog`'s #793 refusal, and the crosswalk type picker. Renaming
 * the route meant editing five string literals correctly or silently breaking a
 * deep link — the "N implementations of one job" shape the Phase 4 synthesis
 * names. New surfaces MUST call these helpers, never rebuild the path.
 */

/**
 * The Data view — records as rows. The dataset's default view.
 *
 * Pass `focus` to deep-link at one CELL: `rowId` is the row's primary key (the
 * grid resolves it to a page via `datasetsApi.rowPosition`, because a page
 * offset is an ordinal only the server can compute) and `columnId` scrolls that
 * column into view and selects the cell. That pair is what a universal-search
 * text hit carries (#834) — without it a hit could only reach the column, and
 * the record it actually found was discarded.
 */
export function dataViewPath(
  projectId: number | string,
  datasetId: number | string,
  focus?: { rowId?: number | string | null; columnId?: number | string | null },
): string {
  const base = `/projects/${projectId}/datasets/${datasetId}`
  const params = new URLSearchParams()
  // `!= null` on purpose, twice: id 0 is a legal id and the falsy-zero check is
  // a shape this codebase has been bitten by repeatedly.
  if (focus?.rowId != null) params.set('row', String(focus.rowId))
  if (focus?.columnId != null) params.set('column', String(focus.columnId))
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * The Variables view. Pass `columnId` to open it focused on one variable —
 * that is what every deep link into this surface wants, and the page reads it
 * from `?column=`.
 */
export function variableViewPath(
  projectId: number | string,
  datasetId: number | string,
  columnId?: number | string | null,
): string {
  const base = `/projects/${projectId}/datasets/${datasetId}/variables`
  return columnId == null ? base : `${base}?column=${columnId}`
}

/**
 * The pre-2026-08 path for the Variables view, kept as a redirect target only.
 *
 * ⚠️ Exported so the redirect's own test can name it without re-typing the
 * literal it exists to retire.
 */
export const LEGACY_RECODE_SEGMENT = 'recode'
