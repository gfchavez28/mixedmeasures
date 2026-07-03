import { useMemo, useState } from 'react'
import type { SourceFrequenciesResponse, CodeFrequencyItem } from '@/lib/api'
import { shapeQualCodeSummary, shapeQualSourceSummary } from './qual-chart-data'
import type { QualSourceSummaryRow } from './qual-chart-data'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import SegmentedControl from '@/components/ui/segmented-control'
import { Info } from 'lucide-react'

interface QualSummaryTableProps {
  data: SourceFrequenciesResponse
  onCodeClick?: (codeId: number) => void
  categoryMode?: boolean
  frequencies?: CodeFrequencyItem[]
  source?: 'all' | 'conversations' | 'text'
  totalCoded?: number
  totalConversations?: number
  totalParticipants?: number
  unlinkedSpeakerCount?: number
  totalCodedComments?: number
  totalRecords?: number
}

/** Code summary row enriched with frequency data from the code-frequencies endpoint. */
interface EnrichedCodeRow {
  codeId: number
  codeName: string
  codeColor: string
  categoryName: string | null
  totalCount: number
  sourceCount: number
  totalSources: number
  conversationCount: number
  textCoverage: number
  segmentPercentage: number
  conversationPercentage: number
  participantCount: number
  participantPercentage: number
  commentCount: number
  commentPercentage: number
  recordCount: number
  recordPercentage: number
  isUniversal: boolean
}

type SummaryMode = 'codes' | 'sources'
type SortField = string
type SortDir = 'asc' | 'desc'

function getSortValue(row: Record<string, unknown>, field: string): string | number {
  const v = row[field]
  if (typeof v === 'string') return v
  if (typeof v === 'number') return v
  return 0
}

function sortRows<T>(rows: T[], field: string, dir: SortDir): T[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    const av = getSortValue(a as unknown as Record<string, unknown>, field)
    const bv = getSortValue(b as unknown as Record<string, unknown>, field)
    if (typeof av === 'string' && typeof bv === 'string') {
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    }
    return dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
  return sorted
}

export default function QualSummaryTable({
  data,
  onCodeClick,
  categoryMode,
  frequencies,
  source = 'all',
  totalCoded,
  totalConversations,
  totalParticipants,
  unlinkedSpeakerCount,
  totalCodedComments,
  totalRecords,
}: QualSummaryTableProps) {
  const [mode, setMode] = useState<SummaryMode>('codes')
  const [sortField, setSortField] = useState<SortField>('totalCount')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const codeRows: EnrichedCodeRow[] = useMemo(() => {
    const summaryRows = shapeQualCodeSummary(data)
    const freqMap = frequencies ? new Map(frequencies.map(f => [f.code_id, f])) : null
    return summaryRows.map(row => {
      const freq = freqMap?.get(row.codeId)
      return {
        ...row,
        segmentPercentage: freq?.segment_percentage ?? 0,
        conversationPercentage: freq?.conversation_percentage ?? 0,
        participantCount: freq?.participant_count ?? 0,
        participantPercentage: freq?.participant_percentage ?? 0,
        commentCount: freq?.text_count ?? 0,
        commentPercentage: freq?.text_percentage ?? 0,
        recordCount: freq?.row_count ?? 0,
        recordPercentage: freq?.row_percentage ?? 0,
        isUniversal: freq?.is_universal ?? false,
      }
    })
  }, [data, frequencies])

  const sourceRows = useMemo(() => shapeQualSourceSummary(data), [data])

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sortIndicator = (field: string) => {
    if (sortField !== field) return null
    return <span className="ml-1 text-mm-text-faint">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
  }

  const sortedCodeRows = useMemo(
    () => sortRows<EnrichedCodeRow>(codeRows, sortField, sortDir),
    [codeRows, sortField, sortDir],
  )

  const sortedSourceRows = useMemo(
    () => sortRows<QualSourceSummaryRow>(sourceRows, sortField, sortDir),
    [sourceRows, sortField, sortDir],
  )

  if (codeRows.length === 0 && sourceRows.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No data available.</div>
  }

  const showConv = source !== 'text'
  const showComment = source !== 'conversations'

  return (
    <div>
      {/* Mode toggle */}
      <div className="mb-3" style={{ maxWidth: 240 }}>
        <SegmentedControl<SummaryMode>
          options={[
            { value: 'codes', label: categoryMode ? 'Per Category' : 'Per Code' },
            { value: 'sources', label: 'Per Source' },
          ]}
          value={mode}
          onChange={(v: SummaryMode) => {
            setMode(v)
            setSortField(v === 'codes' ? 'totalCount' : 'totalCodes')
            setSortDir('desc')
          }}
          ariaLabel="Summary table mode"
        />
      </div>

      <div className="overflow-x-auto border rounded-lg">
        {mode === 'codes' ? (
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th field="codeName" label={categoryMode ? 'Category' : 'Code'} sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[140px]" />
                {!categoryMode && <Th field="categoryName" label="Category" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[100px]" />}
                <Th field="totalCount" label="Count" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <th
                  scope="col"
                  className="px-3 py-2 border-b font-medium cursor-pointer select-none hover:bg-mm-surface-hover transition-colors text-right"
                  onClick={() => handleSort('segmentPercentage')}
                  aria-sort={sortField === 'segmentPercentage' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    % of Coded
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3 h-3 text-mm-text-faint" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        Percentage of coded segments (excludes segments with only universal codes)
                      </TooltipContent>
                    </Tooltip>
                    {sortIndicator('segmentPercentage')}
                  </span>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 border-b font-medium cursor-pointer select-none hover:bg-mm-surface-hover transition-colors text-right"
                  onClick={() => handleSort('textCoverage')}
                  aria-sort={sortField === 'textCoverage' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    % Words
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3 h-3 text-mm-text-faint" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        Proportion of total words in segments coded with this code
                      </TooltipContent>
                    </Tooltip>
                    {sortIndicator('textCoverage')}
                  </span>
                </th>
                <Th field="sourceCount" label="Sources" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                {showConv && (
                  <>
                    <Th field="conversationCount" label="Conv." sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                    <Th field="conversationPercentage" label="% Conv." sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                    <Th field="participantCount" label="Participants" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                    <Th field="participantPercentage" label="% Part." sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                  </>
                )}
                {showComment && (
                  <>
                    <Th field="commentCount" label="Texts" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                    <Th field="commentPercentage" label="% Texts" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                    <Th field="recordCount" label="Records" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                    <Th field="recordPercentage" label="% Rec." sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sortedCodeRows.map(row => (
                <tr
                  key={row.codeId}
                  className={`hover:bg-mm-surface-hover cursor-pointer transition-colors ${row.isUniversal ? 'opacity-60' : ''}`}
                  onClick={() => onCodeClick?.(row.codeId)}
                >
                  <td className="px-3 py-2 border-b">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: row.codeColor }}
                      />
                      <span className="truncate max-w-[200px]" title={row.codeName}>{row.codeName}</span>
                    </span>
                  </td>
                  {!categoryMode && (
                    <td className="px-3 py-2 border-b text-mm-text-muted">
                      {row.categoryName ?? '\u2013'}
                    </td>
                  )}
                  <td className="px-3 py-2 border-b text-right tabular-nums font-medium">
                    {row.totalCount}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.segmentPercentage ? `${row.segmentPercentage.toFixed(1)}%` : '\u2014'}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {(row.textCoverage * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.sourceCount}/{row.totalSources}
                  </td>
                  {showConv && (
                    <>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.conversationCount}
                      </td>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.conversationPercentage ? `${row.conversationPercentage.toFixed(1)}%` : '\u2014'}
                      </td>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.participantCount || '\u2014'}
                      </td>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.participantPercentage ? `${row.participantPercentage.toFixed(1)}%` : '\u2014'}
                      </td>
                    </>
                  )}
                  {showComment && (
                    <>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.commentCount || '\u2014'}
                      </td>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.commentPercentage ? `${row.commentPercentage.toFixed(1)}%` : '\u2014'}
                      </td>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.recordCount || '\u2014'}
                      </td>
                      <td className="px-3 py-2 border-b text-right tabular-nums">
                        {row.recordPercentage ? `${row.recordPercentage.toFixed(1)}%` : '\u2014'}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-mm-bg font-medium">
                <td className="px-3 py-2" colSpan={categoryMode ? 1 : 2}>Totals</td>
                <td className="px-3 py-2 text-right tabular-nums">{totalCoded ?? '\u2014'}</td>
                <td className="px-3 py-2 text-right">{'\u2014'}</td>
                <td className="px-3 py-2 text-right">{'\u2014'}</td>
                <td className="px-3 py-2 text-right">{'\u2014'}</td>
                {showConv && (
                  <>
                    <td className="px-3 py-2 text-right tabular-nums">{totalConversations ?? '\u2014'}</td>
                    <td className="px-3 py-2 text-right">{'\u2014'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{totalParticipants ?? '\u2014'}</td>
                    <td className="px-3 py-2 text-right">{'\u2014'}</td>
                  </>
                )}
                {showComment && (
                  <>
                    <td className="px-3 py-2 text-right tabular-nums">{totalCodedComments ?? '\u2014'}</td>
                    <td className="px-3 py-2 text-right">{'\u2014'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{totalRecords ?? '\u2014'}</td>
                    <td className="px-3 py-2 text-right">{'\u2014'}</td>
                  </>
                )}
              </tr>
            </tfoot>
          </table>
        ) : (
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th field="sourceLabel" label="Source" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[160px]" />
                <Th field="sourceType" label="Type" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left" />
                <Th field="totalCodes" label="Total Codes" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="uniqueCodes" label="Unique Codes" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="codedSegments" label="Coded Segments" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="codesPerSegment" label="Codes/Segment" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="avgSegmentLength" label="Avg Words" sortField={sortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
              </tr>
            </thead>
            <tbody>
              {sortedSourceRows.map(row => (
                <tr key={row.sourceId} className="hover:bg-mm-surface-hover transition-colors">
                  <td className="px-3 py-2 border-b">
                    <span className="truncate block max-w-[240px]" title={row.sourceLabel}>
                      {row.sourceLabel}
                    </span>
                  </td>
                  <td className="px-3 py-2 border-b text-mm-text-muted capitalize">
                    {row.sourceType === 'text_column' ? 'Comments' : 'Conversation'}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums font-medium">
                    {row.totalCodes}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.uniqueCodes}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.codedSegments}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.codesPerSegment.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.avgSegmentLength.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showConv && (unlinkedSpeakerCount ?? 0) > 0 && (
        <p className="text-xs text-mm-text-faint mt-2">
          {unlinkedSpeakerCount} unlinked speaker{unlinkedSpeakerCount !== 1 ? 's' : ''} counted as "Unknown" for participant percentages.
        </p>
      )}
    </div>
  )
}

// Sortable table header cell
function Th({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  indicator,
  className = '',
}: {
  field: string
  label: string
  sortField: string
  sortDir: SortDir
  onSort: (field: string) => void
  indicator: (field: string) => React.ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 border-b font-medium cursor-pointer select-none hover:bg-mm-surface-hover transition-colors ${className}`}
      onClick={() => onSort(field)}
      aria-sort={sortField === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {label}
      {indicator(field)}
    </th>
  )
}
