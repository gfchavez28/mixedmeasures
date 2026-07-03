import type {
  CrosswalkGrid,
  CellData,
  EmptyCellData,
} from '@/components/crosswalk/crosswalk-types'
import { toCsv } from './csv'

export interface CrosswalkCsvDataset {
  dataset_id: number
  dataset_name: string
}

function isCell(cell: CellData | EmptyCellData | undefined): cell is CellData {
  return !!cell && 'column_id' in cell
}

/**
 * #12d-a — serialize the crosswalk (variable-group harmonization table) to CSV.
 *
 * A wide matrix mirroring the on-screen layout: one row per equivalence /
 * unlinked row, one column per active dataset (in the given order, matching
 * the column headers), plus the variable group + its description. Each cell is
 * the dataset's column identifier in that harmonization row (code preferred,
 * else the full column text), or empty when that dataset has no matched column.
 *
 * Pure — consumes `buildGrid`'s output. The caller passes `datasets` in the
 * same order as the on-screen column headers so the CSV lines up.
 */
export function buildCrosswalkCsv(
  grid: CrosswalkGrid,
  datasets: CrosswalkCsvDataset[],
): string {
  const header = [
    'Variable group',
    'Group description',
    'Harmonization row',
    ...datasets.map((d) => d.dataset_name),
  ]

  const rows: string[][] = [header]

  for (const bracket of grid.brackets) {
    for (const row of bracket.rows) {
      const datasetCells = datasets.map((d) => {
        const cell = row.cells_by_dataset.get(d.dataset_id)
        return isCell(cell) ? cell.column_code || cell.column_text || '' : ''
      })
      rows.push([
        bracket.name,
        bracket.description ?? '',
        row.auto_label ?? '',
        ...datasetCells,
      ])
    }
  }

  return toCsv(rows)
}
