import type { CrossTabulationResponse } from '@/lib/api'
import { ScrollableTable } from '@/components/ui/ScrollableTable'

interface CrossTabTableProps {
  data: CrossTabulationResponse | null
  loading: boolean
}

export default function CrossTabTable({ data, loading }: CrossTabTableProps) {
  if (loading) {
    return <div className="text-center py-8 text-mm-text-muted text-sm">Loading cross-tabulation...</div>
  }
  if (!data || data.matrix.length === 0) {
    return (
      <div className="text-center py-8 text-mm-text-muted text-sm">
        {data ? 'No coded comments found for this cross-tabulation.' : 'Select a cross-tab variable to see the matrix.'}
      </div>
    )
  }

  const { response_values, matrix, column_totals, total_coded_texts, cross_column_name } = data

  // Find max percentage for heatmap scaling
  let maxPct = 0
  for (const row of matrix) {
    for (const rv of response_values) {
      const pct = row.percentages[rv] || 0
      if (pct > maxPct) maxPct = pct
    }
  }

  const cellBg = (pct: number): React.CSSProperties => {
    if (pct === 0 || maxPct === 0) return {}
    const intensity = pct / maxPct
    const l = 95 - intensity * 60
    return { backgroundColor: `hsl(142, 50%, ${l}%)` }
  }

  return (
    <div className="border rounded-lg bg-mm-surface p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Cross-tabulation: {cross_column_name}</h3>
        <span className="text-xs text-mm-text-muted">{total_coded_texts} coded comment{total_coded_texts !== 1 ? 's' : ''}</span>
      </div>

      <ScrollableTable>
        <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }} aria-label={`Cross-tabulation of codes by ${cross_column_name}`}>
          <caption className="sr-only">
            Cross-tabulation of codes (rows) by {cross_column_name} (columns), with counts and percentages.
          </caption>
          <thead>
            <tr className="bg-mm-bg">
              <th scope="col" className="px-3 py-2 text-left font-medium border-b border-r min-w-[140px]">Code</th>
              {response_values.map(rv => (
                <th scope="col" key={rv} className="px-2 py-2 text-center font-medium border-b border-r text-xs whitespace-nowrap" title={rv}>
                  {rv.length > 15 ? rv.slice(0, 13) + '\u2026' : rv}
                </th>
              ))}
              <th scope="col" className="px-2 py-2 text-center font-medium border-b text-xs">Total</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map(row => (
              <tr key={row.code_id} className="border-b hover:bg-mm-surface-hover">
                <th scope="row" className="px-3 py-1.5 text-left font-normal border-r whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: row.code_color || '#6b7280' }}
                    />
                    {row.code_name}
                  </span>
                </th>
                {response_values.map(rv => {
                  const count = row.counts[rv] || 0
                  const pct = row.percentages[rv] || 0
                  return (
                    <td
                      key={rv}
                      className="px-2 py-1.5 text-center tabular-nums border-r text-xs"
                      style={cellBg(pct)}
                      aria-label={`${row.code_name}, ${rv}: ${count} (${pct.toFixed(1)}%)`}
                    >
                      {count > 0 ? (
                        <span>
                          <span className="font-medium">{count}</span>
                          <span className="text-mm-text-muted ml-0.5">({pct.toFixed(0)}%)</span>
                        </span>
                      ) : (
                        <span className="text-mm-border-medium">{'\u2013'}</span>
                      )}
                    </td>
                  )
                })}
                <td className="px-2 py-1.5 text-center tabular-nums font-medium text-xs">{row.row_total}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-mm-bg font-medium">
              <td className="px-3 py-1.5 border-t border-r text-xs">Column total</td>
              {response_values.map(rv => (
                <td key={rv} className="px-2 py-1.5 text-center tabular-nums border-t border-r text-xs">
                  {column_totals[rv] || 0}
                </td>
              ))}
              <td className="px-2 py-1.5 text-center tabular-nums border-t text-xs">{total_coded_texts}</td>
            </tr>
          </tfoot>
        </table>
      </ScrollableTable>

      <p className="text-xs text-mm-text-faint mt-2">
        Percentages are column-wise (% of comments in each response category that have this code).
      </p>
    </div>
  )
}
