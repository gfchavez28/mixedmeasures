/**
 * #1638 — every column `GET …/metrics/analysis-columns` names, per dataset, DEMOGRAPHIC ones
 * included.
 *
 * The server (`routers/metrics.py::get_analysis_columns`) routes a DEMOGRAPHIC column into the
 * separate `demographics` list and leaves it OUT of `datasets[].columns` — on purpose, so the
 * Descriptives variable picker never offers one (#1357 LIVE-07's open half). A NOMINAL column is
 * in both lists. A reader that must see every participant-linked variable — the joint display's
 * builder (its groups, *Also show* and survey variables) and the sentence naming a saved result's
 * unit — reads `datasets[].columns` alone and misses every demographic column: the builder
 * offered none while its help line promised them, and a display grouped by one reopened on
 * "Choose a variable…" (#1638). These two functions are that union, asked in one place.
 *
 * - A demographic item becomes an `AnalysisColumnItem` of type `'demographic'` carrying its
 *   `withheld_while_blind` mark (#1615 D279 — a band of a rating score can be retyped
 *   demographic). The fields the list does not carry take their empty values.
 * - Order: the server's dataset order; a dataset whose only analysable columns are demographic
 *   comes after, in the order the list meets it. Within a dataset, its own columns, then its
 *   demographic ones in the server's order (the list carries no position, so they cannot be
 *   interleaved exactly).
 */
import type {
  AnalysisColumnItem, AnalysisColumnsResponse, AnalysisDatasetGroup, AnalysisDemographicItem,
} from '@/lib/api/metrics'

function asColumn(d: AnalysisDemographicItem): AnalysisColumnItem {
  return {
    id: d.id,
    dataset_id: d.dataset_id,
    dataset_name: d.dataset_name,
    column_code: null,
    column_name: d.column_name,
    column_text: d.column_text,
    column_type: 'demographic',
    scale_labels: null,
    equivalence_group_id: null,
    domain_ids: [],
    withheld_while_blind: d.withheld_while_blind,
  }
}

/** Each dataset with every column the payload names for it, demographic ones included. */
export function datasetsWithDemographics(data: AnalysisColumnsResponse | undefined): AnalysisDatasetGroup[] {
  if (!data) return []
  const out = data.datasets.map(ds => ({ id: ds.id, name: ds.name, columns: [...ds.columns] }))
  const byId = new Map(out.map(ds => [ds.id, ds]))
  const listed = new Set(data.datasets.flatMap(ds => ds.columns.map(c => c.id)))
  // Tolerant of a payload that leaves the member out (a fixture, an older server).
  for (const d of data.demographics ?? []) {
    if (listed.has(d.id)) continue   // a nominal column: already in its dataset's own list
    listed.add(d.id)
    let ds = byId.get(d.dataset_id)
    if (!ds) {
      ds = { id: d.dataset_id, name: d.dataset_name, columns: [] }
      out.push(ds)
      byId.set(ds.id, ds)
    }
    ds.columns.push(asColumn(d))
  }
  return out
}

/** Every column the payload names, by id — demographic ones included. */
export function columnsWithDemographics(data: AnalysisColumnsResponse | undefined): Map<number, AnalysisColumnItem> {
  return new Map(datasetsWithDemographics(data).flatMap(ds => ds.columns).map(c => [c.id, c]))
}
