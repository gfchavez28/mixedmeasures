import { useState, useMemo } from 'react'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import type { CodebookCooccurrenceResponse } from '@/lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

type SortField = 'nodeA' | 'nodeB' | 'weight' | 'categoryA' | 'categoryB'
type SortDir = 'asc' | 'desc'

interface TableRow {
  nodeA: string
  nodeB: string
  weight: number
  categoryA: string
  categoryB: string
}

interface CodebookNetworkTableProps {
  data: CodebookCooccurrenceResponse
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CodebookNetworkTable({ data }: CodebookNetworkTableProps) {
  const [sortField, setSortField] = useState<SortField>('weight')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const rows = useMemo<TableRow[]>(() => {
    const nodeMap = new Map(data.nodes.map(n => [n.id, n]))
    return data.edges.map(e => {
      const a = nodeMap.get(e.source)!
      const b = nodeMap.get(e.target)!
      return {
        nodeA: a.name,
        nodeB: b.name,
        weight: e.weight,
        categoryA: a.category_path.join(' › ') || '—',
        categoryB: b.category_path.join(' › ') || '—',
      }
    })
  }, [data])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortField]
      const bv = b[sortField]
      const cmp = typeof av === 'number'
        ? (av as number) - (bv as number)
        : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortField, sortDir])

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <span className="text-3xl mb-3" role="presentation">&#128279;</span>
        <p className="text-sm text-mm-text-secondary max-w-sm">
          No code co-occurrences found.
        </p>
      </div>
    )
  }

  return (
    <ScrollableTable>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-mm-border-subtle">
            <Th field="nodeA" label="Node A" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <Th field="nodeB" label="Node B" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <Th field="weight" label="Co-occurrences" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="text-right" />
            <Th field="categoryA" label="Node A Category" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <Th field="categoryB" label="Node B Category" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => (
            <tr key={`${row.nodeA}-${row.nodeB}`} className="border-b border-mm-border-subtle/50 hover:bg-mm-surface-hover">
              <td className="px-3 py-2 text-mm-text">{row.nodeA}</td>
              <td className="px-3 py-2 text-mm-text">{row.nodeB}</td>
              <td className="px-3 py-2 text-mm-text tabular-nums text-right">{row.weight}</td>
              <td className="px-3 py-2 text-mm-text-muted text-xs">{row.categoryA}</td>
              <td className="px-3 py-2 text-mm-text-muted text-xs">{row.categoryB}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
  )
}

// ── Table header cell ────────────────────────────────────────────────────────

function Th({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  className,
}: {
  field: SortField
  label: string
  sortField: SortField
  sortDir: SortDir
  onSort: (field: SortField) => void
  className?: string
}) {
  const isActive = sortField === field
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-medium text-mm-text-muted cursor-pointer select-none hover:text-mm-text ${className || ''}`}
      onClick={() => onSort(field)}
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {isActive && <span className="ml-1 text-mm-text-faint">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}
