import { useMemo, useState, type ReactNode } from 'react'
import { WORD_COUNT_NOTE } from '@/lib/word-count-basis'
import { UNIVERSAL_SHARE_CELL, UNIVERSAL_SHARE_NOTE } from '@/lib/universal-share'
import type { SourceFrequenciesResponse, SourceKind } from '@/lib/api'
import { shapeQualSourceSummary } from './qual-chart-data'
import type { QualSourceSummaryRow } from './qual-chart-data'
import {
  enrichCodeRows, KIND_FIELDS, sortSummaryRows, summaryCodeColumns, unlinkedSpeakerNote,
} from './qual-summary-columns'
import type { EnrichedCodeRow, SortDir, SummaryCell, SummaryColumn } from './qual-summary-columns'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { SortableColumnHeader, SortButton } from '@/components/ui/sortable-column-header'
import { columnSort } from '@/lib/column-sort'
import SegmentedControl from '@/components/ui/segmented-control'
import { Info } from 'lucide-react'

/**
 * #749 — this table takes EVERY number it renders from `data`, one payload.
 *
 * It used to accept a second set of props sourced from `code-frequencies`, for
 * the per-kind columns and their totals. That endpoint reads an unselected kind
 * as ALL of that kind, so half this table was scoped to the researcher's
 * selection and half to the whole project — and, in category mode, the join was
 * a code-keyed map looked up by CATEGORY id, which matches only where the two
 * independent id spaces happen to collide.
 *
 * #1528 D87 (1.5.9) — its code columns (header, cell, total) are declared ONCE in
 * `qual-summary-columns.ts`, which also writes the Frequencies CSV: the file is this
 * table's rows, so a column cannot be in one and missing from the other.
 */
interface QualSummaryTableProps {
  data: SourceFrequenciesResponse
  onCodeClick?: (codeId: number) => void
  categoryMode?: boolean
}

/**
 * #1526 D79 — a universal row's share of a coded total: the visible "—", and for a screen
 * reader the reason (IrrMatrix's shape). `UNIVERSAL_SHARE_NOTE` under the table says it in full.
 */
function WithheldShare() {
  return <>{'—'}<span className="sr-only"> {UNIVERSAL_SHARE_CELL}</span></>
}

/**
 * A cell's content. The text rules (#689: a share with no denominator is "\u2014", a measured
 * zero is "0.0%"; a dashed COUNT column draws 0 as "\u2014" to keep a wide table readable) live
 * with each column in `qual-summary-columns.ts`.
 */
function renderCell(cell: SummaryCell): ReactNode {
  return typeof cell === 'string' ? cell : <WithheldShare />
}

/** The table's own styling per column \u2014 presentation only; WHICH columns, in what order and
 *  with what content, is the shared list's. */
function headerClass(col: SummaryColumn): string {
  if (col.field === 'codeName') return 'text-left min-w-[140px]'
  if (col.field === 'categoryName') return 'text-left min-w-[100px]'
  return 'text-right'
}

function bodyClass(col: SummaryColumn): string {
  if (col.field === 'codeName') return 'px-3 py-2 border-b'
  if (col.field === 'categoryName') return 'px-3 py-2 border-b text-mm-text-muted'
  if (col.field === 'totalCount') return 'px-3 py-2 border-b text-right tabular-nums font-medium'
  return 'px-3 py-2 border-b text-right tabular-nums'
}

/** Display name per source kind \u2014 a `Record`, so a fifth kind cannot fall
 *  through to "Conversation" the way the old ternary chain's final `else`
 *  did (#679's defect shape, one column over). */
const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  conversation: 'Conversation',
  document: 'Document',
  observation: 'Observation',
  text_column: 'Comments',
}

type SummaryMode = 'codes' | 'sources'
type SortField = string

/** The column each mode falls back to — on a mode switch, and when the sorted
 *  column stops being rendered. */
const DEFAULT_SORT_FIELD: Record<SummaryMode, string> = {
  codes: 'totalCount',
  sources: 'totalCodes',
}

export default function QualSummaryTable({
  data,
  onCodeClick,
  categoryMode,
}: QualSummaryTableProps) {
  const [mode, setMode] = useState<SummaryMode>('codes')
  const [sortField, setSortField] = useState<SortField>('totalCount')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // #679/#745/#749/#1526: every count AND share on a row comes from `data` (`enrichCodeRows`).
  const codeRows: EnrichedCodeRow[] = useMemo(() => enrichCodeRows(data), [data])

  const sourceRows = useMemo(() => shapeQualSourceSummary(data), [data])

  // #679 → #1528 D87: ONE list drives the header, the body, the totals row — and the
  // Frequencies CSV — so a source kind cannot appear in one and be missing from another.
  const columns = useMemo(() => summaryCodeColumns(data, !!categoryMode), [data, categoryMode])
  const nameColumnCount = columns.filter(c => c.names).length
  const valueColumns = columns.filter(c => !c.names)

  /**
   * The field the table is ACTUALLY ordered by.
   *
   * Only kind columns can disappear (the selection changes), and when the
   * sorted one does, the rows keep their order while no header carries a sort
   * indicator — the table looks unsorted and isn't. Falling back to the mode's
   * default keeps the visible state and the real order the same thing.
   */
  const activeSortField =
    KIND_FIELDS.has(sortField) && !columns.some(c => c.field === sortField)
      ? DEFAULT_SORT_FIELD[mode]
      : sortField

  const handleSort = (field: string) => {
    if (activeSortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sortedCodeRows = useMemo(
    () => sortSummaryRows<EnrichedCodeRow>(codeRows, activeSortField, sortDir),
    [codeRows, activeSortField, sortDir],
  )

  const sortedSourceRows = useMemo(
    () => sortSummaryRows<QualSourceSummaryRow>(sourceRows, activeSortField, sortDir),
    [sourceRows, activeSortField, sortDir],
  )

  if (codeRows.length === 0 && sourceRows.length === 0) {
    return <div className="text-center py-16 text-mm-text-muted">No data available.</div>
  }


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
            setSortField(DEFAULT_SORT_FIELD[v])
            setSortDir('desc')
          }}
          ariaLabel="Summary table mode"
        />
      </div>

      {/* `relative` is load-bearing (#1156, `ScrollableTable`'s rule): this box must be the
          CONTAINING BLOCK of what it scrolls, or a cell's `sr-only` reason (#1526 D79 — an
          absolute span) escapes it. Measured at 640×360: without it the window scrolled
          sideways to 1,324 px over a 625-px viewport. */}
      <div className="relative overflow-x-auto border rounded-lg">
        {mode === 'codes' ? (
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <caption className="sr-only">Code frequency summary.</caption>
            <thead>
              <tr>
                {columns.map(c => (c.hint ? (
                  <th
                    key={c.field}
                    scope="col"
                    className="px-3 py-2 border-b font-medium select-none text-right"
                    aria-sort={columnSort(activeSortField === c.field, sortDir)}
                  >
                    <span className="inline-flex items-center gap-1 justify-end">
                      {/* The info trigger sits OUTSIDE the sort button — nesting it
                          would make reading the explanation also re-sort the table. */}
                      <SortButton
                        label={c.label}
                        sort={columnSort(activeSortField === c.field, sortDir)}
                        onSort={() => handleSort(c.field)}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="w-3 h-3 text-mm-text-faint" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs">
                          {c.hint}
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  </th>
                ) : (
                  <Th key={c.field} field={c.field} label={c.label} sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className={headerClass(c)} />
                )))}
              </tr>
            </thead>
            <tbody>
              {sortedCodeRows.map(row => (
                <tr
                  key={row.codeId}
                  className={`hover:bg-mm-surface-hover cursor-pointer transition-colors ${row.isUniversal ? 'opacity-60' : ''}`}
                  onClick={() => onCodeClick?.(row.codeId)}
                >
                  {columns.map(c => (c.field === 'codeName' ? (
                    <td key={c.field} className={bodyClass(c)}>
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                          style={{ backgroundColor: row.codeColor }}
                        />
                        <span className="truncate max-w-[200px]" title={row.codeName}>{row.codeName}</span>
                      </span>
                    </td>
                  ) : (
                    <td key={c.field} className={bodyClass(c)}>{renderCell(c.cell(row))}</td>
                  )))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-mm-bg font-medium">
                <td className="px-3 py-2" colSpan={nameColumnCount}>Totals</td>
                {/* #745: the Count total is the SELECTION's coded segments, from the same
                    payload as the column above it (`summaryCodeColumns`); each kind count's
                    total is the base its share beside it divides by. */}
                {valueColumns.map(c => (
                  <td key={c.field} className="px-3 py-2 text-right tabular-nums">
                    {c.total ?? '\u2014'}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        ) : (
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <caption className="sr-only">Source frequency summary.</caption>
            <thead>
              <tr>
                <Th field="sourceLabel" label="Source" sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-left min-w-[160px]" />
                <Th field="sourceType" label="Type" sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-left" />
                <Th field="totalCodes" label="Total Codes" sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-right" />
                <Th field="uniqueCodes" label="Unique Codes" sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-right" />
                <Th field="codedSegments" label="Coded Segments" sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-right" />
                <Th field="codesPerSegment" label="Codes/Segment" sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-right" />
                <Th field="avgSegmentLength" label="Avg Words" hint={WORD_COUNT_NOTE} sortField={activeSortField} sortDir={sortDir} onSort={handleSort}className="text-right" />
              </tr>
            </thead>
            <tbody>
              {sortedSourceRows.map(row => (
                // Composite key: ids come from INDEPENDENT sequences per source
                // type, so a clip Segment id can equal a conversation id (the
                // #454-family collision the Observations merge made likely).
                <tr key={`${row.sourceType}:${row.sourceId}`} className="hover:bg-mm-surface-hover transition-colors">
                  <td className="px-3 py-2 border-b">
                    <span className="truncate block max-w-[240px]" title={row.sourceLabel}>
                      {row.sourceLabel}
                    </span>
                  </td>
                  <td className="px-3 py-2 border-b text-mm-text-muted">
                    {SOURCE_KIND_LABEL[row.sourceType]}
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

      {/* #749: the count now comes from the same payload as the columns it
          qualifies. The wording is also corrected — an unlinked speaker is
          absent from BOTH the participant counts and their denominator (the
          queries require a non-null `participant_id`), so it was never
          "counted as Unknown". Saying so overstated the coverage of every
          participant percentage on the screen. */}
      {/* #1526 D79: said ONCE, and only when a universal row is on the table — the
          withheld cells' reason. Inside the component, so the PNG and the Canvas carry it. */}
      {mode === 'codes' && codeRows.some(r => r.isUniversal) && (
        <p className="text-xs text-mm-text-muted mt-2">{UNIVERSAL_SHARE_NOTE}</p>
      )}

      {/* #1528: the sentence is `unlinkedSpeakerNote`'s, which the Frequencies CSV writes too. */}
      {columns.some(c => c.kind === 'conversation') && data.totals.unlinked_speaker_count > 0 && (
        <p className="text-xs text-mm-text-faint mt-2">
          {unlinkedSpeakerNote(data.totals.unlinked_speaker_count)}
        </p>
      )}
    </div>
  )
}

/**
 * A sortable header cell — the shared `SortableColumnHeader` (#1465: this table
 * held the one correct copy of the shape, which the others now share).
 */
function Th({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  className = '',
  hint,
}: {
  field: string
  label: string
  /** #703 — a unit caveat for sighted hover; the column keeps its short name. */
  hint?: string
  sortField: string
  sortDir: SortDir
  onSort: (field: string) => void
  className?: string
}) {
  return (
    <SortableColumnHeader
      label={label}
      sort={columnSort(sortField === field, sortDir)}
      onSort={() => onSort(field)}
      className={`px-3 py-2 border-b font-medium select-none ${className}`}
      title={hint}
    />
  )
}
