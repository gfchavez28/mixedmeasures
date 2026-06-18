import { describe, it, expect } from 'vitest'
import {
  buildGrid,
  computeUnassignedColumns,
  computeProjectDatasets,
  computeDatasetColumnCounts,
  computeColumnIdsByDomain,
} from './buildGrid'
import type {
  AnalysisDomainResponse,
  ProjectColumnInfo,
  EquivalenceGroupResponse,
  EgRowData,
  UnlinkedRowData,
} from './crosswalk-types'

/**
 * Tests for the crosswalk's pure buildGrid function. Path A (#325) — every
 * domain member becomes a row. The discriminated union RowData distinguishes
 * EG-keyed rows from synthetic single-cell rows.
 */

// ─── Fixture helpers ────────────────────────────────────────────────────────

function col(
  id: number,
  dataset_id: number,
  dataset_name: string,
  code: string,
  text: string,
  options: Partial<ProjectColumnInfo> = {},
): ProjectColumnInfo {
  return {
    id,
    dataset_id,
    dataset_name,
    dataset_color: null,
    column_code: code,
    column_name: code,
    column_text: text,
    column_type: 'ordinal',
    scale_points: 5,
    scale_labels: null,
    recode_def_count: 0,
    equivalence_group_id: null,
    equivalence_group_label: null,
    ...options,
  }
}

function eg(id: number, label: string): EquivalenceGroupResponse {
  return {
    id,
    project_id: 1,
    label,
    description: null,
    origin: 'human',
    columns: [],
    created_at: '2026-04-10T12:00:00',
    updated_at: '2026-04-10T12:00:00',
  }
}

function domain(
  id: number,
  name: string,
  member_col_ids: number[],
  sequence_order: number | null = 0,
): AnalysisDomainResponse {
  return {
    id,
    project_id: 1,
    name,
    description: null,
    color: null,
    sequence_order,
    origin: 'human',
    member_count: member_col_ids.length,
    members: member_col_ids.map((col_id, idx) => ({
      id: 1000 + id * 100 + idx,
      member_type: 'column' as const,
      member_id: col_id,
      label: `col-${col_id}`,
      dataset_id: null,
      dataset_name: null,
      column_code: null,
      column_type: null,
      scale_points: null,
      scale_labels: null,
      equivalence_group_id: null,
    })),
    created_at: '2026-04-10T12:00:00',
    updated_at: '2026-04-10T12:00:00',
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildGrid', () => {
  it('returns empty slices for an empty project', () => {
    const grid = buildGrid({
      domains: [],
      allColumns: [],
      equivalenceGroups: [],
    })
    expect(grid.brackets).toEqual([])
  })

  it('builds a cross-dataset bracket with one EG-keyed row', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', { equivalence_group_id: 100 }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', { equivalence_group_id: 100 }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: egs,
    })

    expect(grid.brackets).toHaveLength(1)
    const bracket = grid.brackets[0]
    expect(bracket.name).toBe('Leadership')
    expect(bracket.is_cross_dataset).toBe(true)
    expect(bracket.rows).toHaveLength(1)

    const row = bracket.rows[0]
    expect(row.kind).toBe('eg')
    const egRow = row as EgRowData
    expect(egRow.equivalence_group_id).toBe(100)
    expect(egRow.auto_label).toBe('Leadership')
    expect(egRow.cells_by_dataset.size).toBe(2)

    const boardCell = egRow.cells_by_dataset.get(10)
    expect(boardCell).toBeDefined()
    expect((boardCell as { column_id: number }).column_id).toBe(1)
  })

  it('emits synthetic single-cell rows for null-EG domain members (Path A #325)', () => {
    // Single-dataset domain with one EG-keyed and one unlinked column. Both
    // render as rows now — no separate "Additional members" subsection.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'Communication'),  // null EG → synthetic row
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership (Board)', [1, 2])]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: egs,
    })

    expect(grid.brackets).toHaveLength(1)
    const bracket = grid.brackets[0]
    expect(bracket.is_cross_dataset).toBe(false)
    expect(bracket.rows).toHaveLength(2)

    expect(bracket.rows[0].kind).toBe('eg')
    expect(bracket.rows[1].kind).toBe('unlinked')

    const synthetic = bracket.rows[1] as UnlinkedRowData
    expect(synthetic.column_id).toBe(2)
    expect(synthetic.auto_label).toBe('Communication')
    expect(synthetic.cells_by_dataset.size).toBe(1)
    const onlyCell = synthetic.cells_by_dataset.get(10)
    expect((onlyCell as { column_id: number }).column_id).toBe(2)
  })

  it('renders a mixed bracket with EG rows and synthetic rows together', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Q1 text', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'Q2 text', { equivalence_group_id: 101 }),
      col(3, 10, 'Board', 'Q3', 'Q3 text'),  // synthetic row
    ]
    const egs = [eg(100, 'Q1'), eg(101, 'Q2')]
    const domains = [domain(1, 'Mixed', [1, 2, 3])]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: egs,
    })

    const bracket = grid.brackets[0]
    expect(bracket.rows).toHaveLength(3)
    expect(bracket.rows.map(r => r.kind)).toEqual(['eg', 'eg', 'unlinked'])
  })

  it('synthetic rows never report has_scale_labels_mismatch', () => {
    // Synthetic rows have only one cell — there's nothing to compare. The
    // type system also forbids reading has_scale_labels_mismatch from
    // UnlinkedRowData, but this test asserts the runtime contract.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Q1 text'),  // synthetic, scale_points=5
    ]
    const domains = [domain(1, 'Single-cell', [1])]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: [],
    })

    const row = grid.brackets[0].rows[0]
    expect(row.kind).toBe('unlinked')
    // The TypeScript discriminator already prevents this access, but
    // verify the row shape only contains the unlinked-row fields.
    expect(row).not.toHaveProperty('has_scale_labels_mismatch')
    expect(row).not.toHaveProperty('equivalence_group_id')
  })

  it('applies reverse-scored badge from the reverseScoredColumnIds set', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', { equivalence_group_id: 100 }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', { equivalence_group_id: 100 }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: egs,
      reverseScoredColumnIds: new Set([1]),
    })

    const row = grid.brackets[0].rows[0] as EgRowData
    const boardCell = row.cells_by_dataset.get(10) as { is_reverse_scored: boolean }
    const staffCell = row.cells_by_dataset.get(11) as { is_reverse_scored: boolean }
    expect(boardCell.is_reverse_scored).toBe(true)
    expect(staffCell.is_reverse_scored).toBe(false)
  })

  it('detects scale-points mismatch across an EG row (v1 fallback still works)', () => {
    // No scale_labels → scaleSignature falls back to `points:N`.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 7,
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: egs,
    })

    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(true)
  })

  // ─── Phase 4.5: scale_labels mismatch v2 ──────────────────────────────────

  it('reports no mismatch when scale_labels match across an EG row', () => {
    const labels = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree']
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: labels,
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: [...labels], // distinct array, same content
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({ domains, allColumns: columns, equivalenceGroups: egs })
    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(false)
  })

  it('reports mismatch on same point count but different label content (NEW v2 case)', () => {
    // The insidious case the v1 scale_points proxy missed: two 5pt scales
    // with different semantic labels (agree-disagree vs frequency).
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'],
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: ['Never', 'Rarely', 'Sometimes', 'Often', 'Always'],
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({ domains, allColumns: columns, equivalenceGroups: egs })
    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(true)
  })

  it('treats reverse-direction labels as equivalent (sorted comparison)', () => {
    // Same labels, different anchor direction (1=disagree…5=agree vs
    // 5=disagree…1=agree). Sorted comparison treats these as the same scale.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'],
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: ['Strongly agree', 'Agree', 'Neutral', 'Disagree', 'Strongly disagree'],
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({ domains, allColumns: columns, equivalenceGroups: egs })
    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(false)
  })

  it('reports no mismatch when both columns have null labels and matching point counts', () => {
    // Conservative: two columns with no labels but same point counts —
    // both signatures resolve to `points:5`, no mismatch.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({ domains, allColumns: columns, equivalenceGroups: egs })
    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(false)
  })

  it('reports no mismatch when both columns have null labels AND null point counts', () => {
    // Truly unknown — no signal either way. Conservative: don't flag.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: null,
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: null,
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({ domains, allColumns: columns, equivalenceGroups: egs })
    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(false)
  })

  it('reports mismatch when one column has labels and the other has only scale_points', () => {
    // Shape mismatch: signatures `labels:[...]` vs `points:5` are textually
    // different. Researcher gets a flag; can clear by adding labels to
    // both sides or removing from the unlabeled one.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'],
      }),
      col(2, 11, 'Staff', 'Q1', 'Leadership', {
        equivalence_group_id: 100,
        scale_points: 5,
        scale_labels: null,
      }),
    ]
    const egs = [eg(100, 'Q1')]
    const domains = [domain(1, 'Leadership', [1, 2])]

    const grid = buildGrid({ domains, allColumns: columns, equivalenceGroups: egs })
    const row = grid.brackets[0].rows[0] as EgRowData
    expect(row.has_scale_labels_mismatch).toBe(true)
  })

  it('sorts domains by sequence_order (nulls last) then by ID', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'Q1', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'Q2', { equivalence_group_id: 101 }),
      col(3, 10, 'Board', 'Q3', 'Q3', { equivalence_group_id: 102 }),
    ]
    const egs = [eg(100, 'Q1'), eg(101, 'Q2'), eg(102, 'Q3')]
    const domains = [
      domain(3, 'Third', [3], 2),
      domain(1, 'Second', [2], 1),
      domain(2, 'First', [1], 0),
    ]

    const grid = buildGrid({
      domains,
      allColumns: columns,
      equivalenceGroups: egs,
    })

    expect(grid.brackets.map(b => b.name)).toEqual(['First', 'Second', 'Third'])
  })

  // Layer 1 — bracket label rewrite drives the "N variables · M datasets"
  // surface from `dataset_count`, computed from the same set used to derive
  // `is_cross_dataset` (`datasetsInDomain.size`).

  it('exposes dataset_count = 1 for a single-dataset bracket', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'A'),
      col(2, 10, 'Board', 'Q2', 'B'),
    ]
    const grid = buildGrid({
      domains: [domain(1, 'Solo Board', [1, 2])],
      allColumns: columns,
      equivalenceGroups: [],
    })
    const bracket = grid.brackets[0]
    expect(bracket.dataset_count).toBe(1)
    expect(bracket.is_cross_dataset).toBe(false)
  })

  it('exposes dataset_count = N for an N-dataset bracket', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'A', { equivalence_group_id: 100 }),
      col(2, 11, 'Staff', 'Q1', 'A', { equivalence_group_id: 100 }),
      col(3, 12, 'Self', 'Q1', 'A', { equivalence_group_id: 100 }),
    ]
    const grid = buildGrid({
      domains: [domain(1, 'Wellness', [1, 2, 3])],
      allColumns: columns,
      equivalenceGroups: [eg(100, 'Q1')],
    })
    const bracket = grid.brackets[0]
    expect(bracket.dataset_count).toBe(3)
    expect(bracket.is_cross_dataset).toBe(true)
  })
})

describe('computeUnassignedColumns', () => {
  it('returns only columns without an equivalence_group_id', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'assigned', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'unassigned'),
      col(3, 11, 'Staff', 'Q1', 'unassigned'),
    ]
    const unassigned = computeUnassignedColumns(columns)
    expect(unassigned.map(c => c.id)).toEqual([2, 3])
  })

  it('excludes columns that are domain members even with null equivalence_group_id (#334)', () => {
    // A synthetic single-cell row column has null EG but IS a domain
    // member — it must NOT appear in the unassigned panel because it
    // already renders as a `cell-${id}` draggable in its bracket.
    const columns = [
      col(1, 10, 'Board', 'Q1', 'in EG', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'truly unassigned'),
      col(3, 11, 'Staff', 'Q1', 'synthetic row member'),
      col(4, 11, 'Staff', 'Q2', 'truly unassigned'),
    ]
    const domainMemberIds = new Set([1, 3]) // col 3 is a synthetic-row member
    const unassigned = computeUnassignedColumns(columns, domainMemberIds)
    expect(unassigned.map(c => c.id)).toEqual([2, 4])
  })

  it('treats omitted domainMemberColumnIds as empty (no exclusion)', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'a', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'b'),
    ]
    expect(computeUnassignedColumns(columns).map(c => c.id)).toEqual([2])
    expect(computeUnassignedColumns(columns, undefined).map(c => c.id)).toEqual([2])
  })
})

describe('computeProjectDatasets', () => {
  it('returns distinct datasets ordered by ID', () => {
    const columns = [
      col(1, 11, 'Staff', 'Q1', 'x'),
      col(2, 10, 'Board', 'Q1', 'x'),
      col(3, 10, 'Board', 'Q2', 'x'),
      col(4, 11, 'Staff', 'Q2', 'x'),
      col(5, 12, 'Stakeholder', 'Q1', 'x'),
    ]
    const datasets = computeProjectDatasets(columns)
    expect(datasets).toEqual([
      { dataset_id: 10, dataset_name: 'Board', dataset_color: null },
      { dataset_id: 11, dataset_name: 'Staff', dataset_color: null },
      { dataset_id: 12, dataset_name: 'Stakeholder', dataset_color: null },
    ])
  })
})

describe('computeDatasetColumnCounts', () => {
  it('returns total counts per dataset, filter-unaware', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'x', { equivalence_group_id: 100 }),
      col(2, 10, 'Board', 'Q2', 'x'),
      col(3, 10, 'Board', 'Q3', 'x', { equivalence_group_id: 101 }),
      col(4, 11, 'Staff', 'Q1', 'x', { equivalence_group_id: 100 }),
      col(5, 11, 'Staff', 'Q2', 'x'),
    ]
    const counts = computeDatasetColumnCounts(columns)
    expect(counts.get(10)).toBe(3)
    expect(counts.get(11)).toBe(2)
  })

  it('returns an empty map for an empty project', () => {
    expect(computeDatasetColumnCounts([]).size).toBe(0)
  })
})

// ─── computeColumnIdsByDomain ──────────────────────────────────────────────

describe('computeColumnIdsByDomain', () => {
  it('returns an empty map for an empty grid', () => {
    const result = computeColumnIdsByDomain({ brackets: [] })
    expect(result.size).toBe(0)
  })

  it('collects column IDs from EG-keyed rows', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'x', { equivalence_group_id: 100 }),
      col(2, 11, 'Staff', 'Q1', 'x', { equivalence_group_id: 100 }),
    ]
    const grid = buildGrid({
      domains: [domain(50, 'Leadership', [1, 2])],
      allColumns: columns,
      equivalenceGroups: [eg(100, 'leadership-row')],
    })
    const result = computeColumnIdsByDomain(grid)
    const ids = result.get(50)
    expect(ids).toBeDefined()
    expect(ids!.size).toBe(2)
    expect(ids!.has(1)).toBe(true)
    expect(ids!.has(2)).toBe(true)
  })

  it('collects column IDs from synthetic single-cell rows', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'x'),
      col(2, 10, 'Board', 'Q2', 'x'),
    ]
    const grid = buildGrid({
      domains: [domain(50, 'Solo', [1, 2])],
      allColumns: columns,
      equivalenceGroups: [],
    })
    const result = computeColumnIdsByDomain(grid)
    const ids = result.get(50)
    expect(ids).toBeDefined()
    expect(ids!.size).toBe(2)
    expect(ids!.has(1)).toBe(true)
    expect(ids!.has(2)).toBe(true)
  })

  it('handles mixed EG and unlinked rows in the same bracket', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'x', { equivalence_group_id: 100 }),
      col(2, 11, 'Staff', 'Q1', 'x', { equivalence_group_id: 100 }),
      col(3, 10, 'Board', 'Q3', 'x'),
    ]
    const grid = buildGrid({
      domains: [domain(50, 'Mixed', [1, 2, 3])],
      allColumns: columns,
      equivalenceGroups: [eg(100, 'paired-row')],
    })
    const result = computeColumnIdsByDomain(grid)
    const ids = result.get(50)
    expect(ids!.size).toBe(3)
    expect(ids!.has(1)).toBe(true)
    expect(ids!.has(2)).toBe(true)
    expect(ids!.has(3)).toBe(true)
  })

  it('keys per bracket — multi-domain projects produce one entry per domain', () => {
    const columns = [
      col(1, 10, 'Board', 'Q1', 'x'),
      col(2, 10, 'Board', 'Q2', 'x'),
    ]
    const grid = buildGrid({
      domains: [
        domain(50, 'A', [1], 0),
        domain(60, 'B', [2], 1),
      ],
      allColumns: columns,
      equivalenceGroups: [],
    })
    const result = computeColumnIdsByDomain(grid)
    expect(result.size).toBe(2)
    expect(result.get(50)!.has(1)).toBe(true)
    expect(result.get(60)!.has(2)).toBe(true)
    expect(result.get(50)!.has(2)).toBe(false)
  })
})
