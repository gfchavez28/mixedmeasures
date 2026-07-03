/**
 * #12d-a — buildCrosswalkCsv serializes the crosswalk as a wide harmonization
 * matrix. Covers: header = active datasets in order, code-preferred-over-text
 * cell values, text fallback, empty cells for unmatched datasets, comma
 * quoting, and CSV formula-injection defang (mirrors backend csv_safe).
 */

import { describe, it, expect } from 'vitest'
import { buildCrosswalkCsv } from './crosswalk-csv'
import type {
  CrosswalkGrid,
  CellData,
  EmptyCellData,
  RowData,
  BracketData,
} from '@/components/crosswalk/crosswalk-types'

function cell(p: { column_id: number; dataset_id: number; code?: string | null; text?: string }): CellData {
  return {
    column_id: p.column_id,
    dataset_id: p.dataset_id,
    dataset_name: `DS${p.dataset_id}`,
    column_code: p.code ?? null,
    column_text: p.text ?? '',
    column_type: 'ordinal',
    scale_points: null,
    scale_labels: null,
    is_reverse_scored: false,
    recode_def_count: 0,
    equivalence_group_id: null,
  }
}

function empty(dataset_id: number): EmptyCellData {
  return { dataset_id, dataset_name: `DS${dataset_id}` }
}

function egRow(auto_label: string, cells: Map<number, CellData | EmptyCellData>): RowData {
  return { kind: 'eg', equivalence_group_id: 1, has_scale_labels_mismatch: false, auto_label, cells_by_dataset: cells }
}

function unlinkedRow(auto_label: string, cells: Map<number, CellData | EmptyCellData>): RowData {
  return { kind: 'unlinked', member_id: 1, column_id: 99, auto_label, cells_by_dataset: cells }
}

function bracket(name: string, description: string | null, rows: RowData[]): BracketData {
  return {
    domain_id: 1,
    name,
    description,
    color: null,
    sequence_order: null,
    rows,
    is_cross_dataset: true,
    dataset_count: 2,
    scale_score_metric_id: null,
    scale_score_metric_state: 'missing',
  }
}

const DATASETS = [
  { dataset_id: 1, dataset_name: 'Wave 1' },
  { dataset_id: 2, dataset_name: 'Wave 2' },
]

const GRID: CrosswalkGrid = {
  brackets: [
    bracket('Well-being', 'Core construct', [
      egRow(
        'wellbeing_q1',
        new Map<number, CellData | EmptyCellData>([
          [1, cell({ column_id: 11, dataset_id: 1, code: 'WB1', text: 'I feel calm' })],
          // code null -> falls back to text; text has a comma -> must be quoted
          [2, cell({ column_id: 12, dataset_id: 2, code: null, text: 'Calm, relaxed' })],
        ]),
      ),
      unlinkedRow(
        'wb_extra',
        new Map<number, CellData | EmptyCellData>([
          [1, cell({ column_id: 13, dataset_id: 1, code: 'WB9' })],
          [2, empty(2)], // unmatched -> empty field
        ]),
      ),
    ]),
    bracket('Risk', null, [
      egRow(
        'risk1',
        new Map<number, CellData | EmptyCellData>([
          // formula-injection prefix must be defanged with a leading quote
          [1, cell({ column_id: 21, dataset_id: 1, code: '=SUM(A1)' })],
          [2, cell({ column_id: 22, dataset_id: 2, code: 'R1' })],
        ]),
      ),
    ]),
  ],
}

describe('buildCrosswalkCsv', () => {
  it('produces a header + one row per harmonization row, datasets in order', () => {
    const lines = buildCrosswalkCsv(GRID, DATASETS).split('\r\n')
    expect(lines[0]).toBe('Variable group,Group description,Harmonization row,Wave 1,Wave 2')
    expect(lines).toHaveLength(4) // header + 3 rows
  })

  it('prefers code, falls back to text, quotes commas, and leaves empties blank', () => {
    const lines = buildCrosswalkCsv(GRID, DATASETS).split('\r\n')
    expect(lines[1]).toBe('Well-being,Core construct,wellbeing_q1,WB1,"Calm, relaxed"')
    expect(lines[2]).toBe('Well-being,Core construct,wb_extra,WB9,')
  })

  it('defangs CSV formula injection and renders a null description as empty', () => {
    const lines = buildCrosswalkCsv(GRID, DATASETS).split('\r\n')
    expect(lines[3]).toBe("Risk,,risk1,'=SUM(A1),R1")
  })

  it('only includes the datasets passed (respects active-dataset filtering/order)', () => {
    const lines = buildCrosswalkCsv(GRID, [{ dataset_id: 2, dataset_name: 'Wave 2' }]).split('\r\n')
    expect(lines[0]).toBe('Variable group,Group description,Harmonization row,Wave 2')
    expect(lines[1]).toBe('Well-being,Core construct,wellbeing_q1,"Calm, relaxed"')
  })
})
