import { useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '@/lib/theme-context'
import { getCodeColor } from '@/lib/utils'
import { codeAnalysisApi, type CodeAnalysisFilterParams } from '@/lib/api'
import type { QualCooccurrenceLevel } from '@/lib/qual-analysis-types'
import { getHeatmapCellStyle } from './qual-chart-data'

interface QualCooccurrenceProps {
  projectId: number
  filterParams: CodeAnalysisFilterParams
  cooccurrenceLevel: QualCooccurrenceLevel
  showProportion: boolean
  colorPreset?: string
  labelFontSize?: number
  onDataLoad?: (info: { totalSegments: number; totalComments: number }) => void
}

export default function QualCooccurrence({
  projectId,
  filterParams,
  cooccurrenceLevel,
  showProportion,
  colorPreset = 'green',
  labelFontSize,
  onDataLoad,
}: QualCooccurrenceProps) {
  const { isDark } = useTheme()

  const params = useMemo(() => ({
    ...filterParams,
    level: cooccurrenceLevel,
  }), [filterParams, cooccurrenceLevel])

  const { data, isLoading } = useQuery({
    queryKey: [
      'code-cooccurrence', projectId,
      filterParams.exclude_facilitator,
      filterParams.conversation_ids,
      filterParams.participant_ids,
      filterParams.source,
      cooccurrenceLevel,
      filterParams.text_column_ids,
      filterParams.coder_ids,
      filterParams.layer_scope,
    ],
    queryFn: () => codeAnalysisApi.cooccurrence(projectId, params),
    enabled: !!projectId,
  })

  const unitLabel = useMemo(() => {
    if (cooccurrenceLevel === 'source') return 'source'
    if (filterParams.source === 'text') return 'text'
    if (filterParams.source === 'all') return 'unit'
    return 'segment'
  }, [cooccurrenceLevel, filterParams.source])

  // Compute proportion matrix (proportion of row)
  const proportionMatrix = useMemo(() => {
    if (!data || !showProportion) return null
    const { matrix } = data
    return matrix.map((row, i) => {
      const diag = matrix[i][i]
      if (diag === 0) return row.map(() => 0)
      return row.map((val, j) => (i === j ? 1 : val / diag))
    })
  }, [data, showProportion])

  useEffect(() => {
    if (data && onDataLoad) {
      onDataLoad({
        totalSegments: data.total_coded_segments ?? 0,
        totalComments: data.total_coded_texts ?? 0,
      })
    }
  }, [data, onDataLoad])

  if (isLoading) {
    return <div className="text-center py-8 text-mm-text-muted">Loading co-occurrence matrix...</div>
  }

  if (!data || data.codes.length === 0) {
    return (
      <div className="text-center py-16 text-mm-text-muted">
        <p>No coded {unitLabel}s found with current filters.</p>
      </div>
    )
  }

  const { codes, matrix, max_cooccurrence } = data

  const diagStyle: React.CSSProperties = { backgroundColor: isDark ? '#1e293b' : '#f3f4f6' }

  const cellStyle = (count: number, isDiag: boolean): React.CSSProperties => {
    if (isDiag) return diagStyle
    return getHeatmapCellStyle(count, max_cooccurrence, isDark, colorPreset)
  }

  const proportionCellStyle = (proportion: number, isDiag: boolean): React.CSSProperties => {
    if (isDiag) return diagStyle
    return getHeatmapCellStyle(proportion, 1, isDark, colorPreset)
  }

  return (
    <div>
      {/* Matrix */}
      <div className="overflow-x-auto border rounded-lg">
        <table style={{ borderCollapse: 'collapse', fontSize: labelFontSize ?? 12 }}>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-mm-bg px-2 py-1.5 border-b border-r min-w-[120px]" />
              {codes.map(c => (
                <th
                  scope="col"
                  key={c.id}
                  className="px-1 py-1.5 border-b border-r font-medium text-center"
                  style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)', minWidth: 32, maxWidth: 32, height: 120, overflow: 'hidden' }}
                  title={c.name}
                >
                  <span className={c.is_universal ? 'opacity-60' : ''}>
                    {c.name.length > 18 ? c.name.slice(0, 16) + '\u2026' : c.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map((rowCode, i) => (
              <tr key={rowCode.id}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 bg-mm-surface px-2 py-1 border-b border-r font-medium whitespace-nowrap ${rowCode.is_universal ? 'opacity-60' : ''}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: getCodeColor(rowCode) }}
                    />
                    {rowCode.name}
                  </span>
                </th>
                {codes.map((colCode, j) => {
                  const count = matrix[i][j]
                  const isDiag = i === j
                  const proportion = proportionMatrix?.[i]?.[j]

                  if (showProportion && proportionMatrix) {
                    const pVal = proportion ?? 0
                    return (
                      <td
                        key={`${rowCode.id}-${colCode.id}`}
                        className="px-1 py-1 border-b border-r text-center tabular-nums"
                        style={proportionCellStyle(pVal, isDiag)}
                        title={
                          isDiag
                            ? `${rowCode.name}: ${count} ${unitLabel}${count !== 1 ? 's' : ''}`
                            : `${rowCode.name} \u00D7 ${colCode.name}: ${(pVal * 100).toFixed(1)}% of ${rowCode.name} (${count}/${matrix[i][i]})`
                        }
                      >
                        {isDiag
                          ? count
                          : pVal > 0
                            ? `${(pVal * 100).toFixed(0)}%`
                            : '\u2013'
                        }
                      </td>
                    )
                  }

                  return (
                    <td
                      key={`${rowCode.id}-${colCode.id}`}
                      className="px-1 py-1 border-b border-r text-center tabular-nums"
                      style={cellStyle(count, isDiag)}
                      title={
                        isDiag
                          ? `${rowCode.name}: ${count} ${unitLabel}${count !== 1 ? 's' : ''}`
                          : `${rowCode.name} + ${colCode.name}: ${count} ${unitLabel}${count !== 1 ? 's' : ''}`
                      }
                    >
                      {count > 0 ? count : '\u2013'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Caption */}
      <p className="text-xs text-mm-text-faint mt-2">
        {cooccurrenceLevel === 'source'
          ? `Source-level co-occurrence: diagonal shows number of sources where each code appears. Off-diagonal shows number of sources where both codes appear.`
          : showProportion
            ? `Proportion view: each cell shows what percentage of the row code's occurrences co-occur with the column code.`
            : data.source === 'text'
              ? 'Diagonal shows total texts per code. Off-diagonal shows how often two codes co-occur on the same text.'
              : data.source === 'all'
                ? 'Diagonal shows total coded units (segments + texts) per code. Off-diagonal shows how often two codes co-occur on the same unit.'
                : 'Diagonal shows total segments per code. Off-diagonal shows how often two codes co-occur on the same segment.'
        }
        {!showProportion && max_cooccurrence > 0 && ` Max co-occurrence: ${max_cooccurrence}.`}
      </p>
    </div>
  )
}
