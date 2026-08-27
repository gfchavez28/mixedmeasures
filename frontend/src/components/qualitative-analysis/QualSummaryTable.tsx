import { useMemo, useState } from 'react'
import { WORD_COUNT_NOTE } from '@/lib/word-count-basis'
import type { SourceFrequenciesResponse, SourceKind } from '@/lib/api'
import {
  shapeQualCodeSummary, shapeQualSourceSummary, presentSourceKinds, summaryKindTotals,
  sharePercent,
} from './qual-chart-data'
import type { QualSourceSummaryRow } from './qual-chart-data'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
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
 */
interface QualSummaryTableProps {
  data: SourceFrequenciesResponse
  onCodeClick?: (codeId: number) => void
  categoryMode?: boolean
}

/** A code (or, in category mode, a category) with its reach into each kind. */
interface EnrichedCodeRow {
  codeId: number
  codeName: string
  codeColor: string
  categoryName: string | null
  totalCount: number
  sourceCount: number
  totalSources: number
  textCoverage: number
  /** #745 — `null` = no coded segments in this selection, which is not 0%. */
  segmentPercentage: number | null
  conversationCount: number
  conversationPercentage: number | null
  participantCount: number
  participantPercentage: number | null
  documentCount: number
  documentPercentage: number | null
  observationCount: number
  observationPercentage: number | null
  textCount: number
  textPercentage: number | null
  recordCount: number
  recordPercentage: number | null
  isUniversal: boolean
}

/** The numeric fields of a row \u2014 the only ones a kind column may point at.
 *  Typing `field` this way (rather than `string`) means a mistyped field name
 *  is a compile error instead of a column that silently renders 0 / an em dash,
 *  and it removes the `as unknown as Record<string, number>` cast that made the
 *  old shape unable to notice. */
type NumericRowField = {
  [K in keyof EnrichedCodeRow]: EnrichedCodeRow[K] extends number | null ? K : never
}[keyof EnrichedCodeRow]

/** One numeric column of a source-kind group (#679). */
interface KindColumn {
  field: NumericRowField
  label: string
  /** Renders as a percentage; totals row shows an em dash for these. */
  pct?: boolean
  /** Totals-row value. Percentages have none. */
  total?: number
  /** Show an em dash instead of a literal 0 in the body. */
  dash?: boolean
}

/**
 * Cell text for a kind column, keeping the pre-#679 per-column conventions.
 *
 * \u26a0\ufe0f A percentage distinguishes `null` (no sources of this kind in the
 * selection, so the share is not computable) from a measured `0` \u2014 #689's
 * convention, and the reason this is not `v ? \u2026 : '\u2014'`. The `dash` convention
 * on COUNT columns is the opposite by design: there, 0 is deliberately drawn as
 * an em dash to keep a wide table readable.
 */
function formatKindCell(row: EnrichedCodeRow, col: KindColumn): string {
  const v = row[col.field]
  if (col.pct) return v == null ? '\u2014' : `${v.toFixed(1)}%`
  if (col.dash) return v ? String(v) : '\u2014'
  return String(v ?? 0)
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
type SortDir = 'asc' | 'desc'

/** The column each mode falls back to — on a mode switch, and when the sorted
 *  column stops being rendered. */
const DEFAULT_SORT_FIELD: Record<SummaryMode, string> = {
  codes: 'totalCount',
  sources: 'totalCodes',
}

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
}: QualSummaryTableProps) {
  const [mode, setMode] = useState<SummaryMode>('codes')
  const [sortField, setSortField] = useState<SortField>('totalCount')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const codeRows: EnrichedCodeRow[] = useMemo(() => {
    const kindTotals = summaryKindTotals(data)
    const universalById = new Map(data.codes.map(c => [c.id, c.is_universal]))
    // #679/#745/#749: every count AND every percentage on a row is computed
    // from `data`. The pairs cannot disagree because neither half can be
    // scoped differently from the other — there is only one scope.
    return shapeQualCodeSummary(data).map(row => ({
      ...row,
      conversationPercentage: sharePercent(row.conversationCount, kindTotals.conversation),
      documentPercentage: sharePercent(row.documentCount, kindTotals.document),
      observationPercentage: sharePercent(row.observationCount, kindTotals.observation),
      participantPercentage: sharePercent(row.participantCount, kindTotals.participant),
      textPercentage: sharePercent(row.textCount, kindTotals.text),
      recordPercentage: sharePercent(row.recordCount, kindTotals.record),
      isUniversal: universalById.get(row.codeId) ?? false,
    }))
  }, [data])

  const sourceRows = useMemo(() => shapeQualSourceSummary(data), [data])

  // #679: ONE list drives the header, the body and the totals row, so a source
  // kind cannot appear in one and be missing from another. The old shape was
  // two hard-coded booleans (`showConv` / `showComment`) with no `showDoc` and
  // no `showObs`, which is why documents rode in the conversation group and
  // observations had no columns at all.
  const kindColumns = useMemo(() => {
    const present = presentSourceKinds(data)
    // #749: each total is the denominator of the percentage beside it, from the
    // same payload as the counts above it. They used to be props sourced from
    // `code-frequencies`, where "conversations" meant conversations carrying
    // ANY coding — a different set from the one the counts were drawn out of.
    const kindTotals = summaryKindTotals(data)
    // A `Record<SourceKind, …>`, NOT an array: tsc fails here until a newly
    // added source kind is given its columns. The previous shape was an array
    // of `{ kind: string }` filtered with `present.has(g.kind as never)` — the
    // cast defeated the check in both directions, so kind #5 would have gone
    // missing exactly the way documents and observations did (#679). Iteration
    // order is the declaration order below.
    const cols: Record<SourceKind, KindColumn[]> = {
      conversation: [
        { field: 'conversationCount', label: 'Conv.', total: kindTotals.conversation },
        { field: 'conversationPercentage', label: '% Conv.', pct: true },
        // Participants hang off the conversation spine (documents and clips
        // have no speaker), so they belong to this group rather than standing
        // alone — the same reason the backend computes them from conv_data.
        { field: 'participantCount', label: 'Participants', total: kindTotals.participant, dash: true },
        { field: 'participantPercentage', label: '% Part.', pct: true },
      ],
      document: [
        { field: 'documentCount', label: 'Docs', total: kindTotals.document, dash: true },
        { field: 'documentPercentage', label: '% Docs', pct: true },
      ],
      observation: [
        { field: 'observationCount', label: 'Obs.', total: kindTotals.observation, dash: true },
        { field: 'observationPercentage', label: '% Obs.', pct: true },
      ],
      text_column: [
        { field: 'textCount', label: 'Texts', total: kindTotals.text, dash: true },
        { field: 'textPercentage', label: '% Texts', pct: true },
        { field: 'recordCount', label: 'Records', total: kindTotals.record, dash: true },
        { field: 'recordPercentage', label: '% Rec.', pct: true },
      ],
    }
    return {
      groups: (Object.keys(cols) as SourceKind[])
        .filter(kind => present.has(kind))
        .map(kind => ({ kind, cols: cols[kind] })),
      // Every kind field, present or not — the set the sort fallback below
      // needs in order to tell "sorted by a hidden column" from "sorted by a
      // column that is always there".
      allFields: new Set<string>(Object.values(cols).flat().map(c => c.field)),
    }
  }, [data])

  const kindGroups = kindColumns.groups
  const kindCols = kindGroups.flatMap(g => g.cols)

  /**
   * The field the table is ACTUALLY ordered by.
   *
   * Only kind columns can disappear (the selection changes), and when the
   * sorted one does, the rows keep their order while no header carries a sort
   * indicator — the table looks unsorted and isn't. Falling back to the mode's
   * default keeps the visible state and the real order the same thing.
   */
  const activeSortField =
    kindColumns.allFields.has(sortField) && !kindCols.some(c => c.field === sortField)
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

  const sortIndicator = (field: string) => {
    if (activeSortField !== field) return null
    return <span className="ml-1 text-mm-text-faint">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const sortedCodeRows = useMemo(
    () => sortRows<EnrichedCodeRow>(codeRows, activeSortField, sortDir),
    [codeRows, activeSortField, sortDir],
  )

  const sortedSourceRows = useMemo(
    () => sortRows<QualSourceSummaryRow>(sourceRows, activeSortField, sortDir),
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

      <div className="overflow-x-auto border rounded-lg">
        {mode === 'codes' ? (
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <caption className="sr-only">Code frequency summary.</caption>
            <thead>
              <tr>
                <Th field="codeName" label={categoryMode ? 'Category' : 'Code'} sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[140px]" />
                {!categoryMode && <Th field="categoryName" label="Category" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[100px]" />}
                <Th field="totalCount" label="Count" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <th
                  scope="col"
                  className="px-3 py-2 border-b font-medium select-none text-right"
                  aria-sort={activeSortField === 'segmentPercentage' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    {/* The info trigger sits OUTSIDE the sort button — nesting it
                        would make reading the explanation also re-sort the table. */}
                    <button type="button" className={SORT_BUTTON} onClick={() => handleSort('segmentPercentage')}>
                      % of Coded
                      {sortIndicator('segmentPercentage')}
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3 h-3 text-mm-text-faint" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        Percentage of coded segments (excludes segments with only universal codes)
                      </TooltipContent>
                    </Tooltip>
                  </span>
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 border-b font-medium select-none text-right"
                  aria-sort={activeSortField === 'textCoverage' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    <button type="button" className={SORT_BUTTON} onClick={() => handleSort('textCoverage')}>
                      % Words
                      {sortIndicator('textCoverage')}
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3 h-3 text-mm-text-faint" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        Proportion of total words in segments coded with this code.
                        {' '}{WORD_COUNT_NOTE}
                      </TooltipContent>
                    </Tooltip>
                  </span>
                </th>
                <Th field="sourceCount" label="Sources" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                {kindCols.map(c => (
                  <Th key={c.field} field={c.field} label={c.label} sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                ))}
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
                    {/* #745/#689: `null` (no coded segments in the selection)
                        is "\u2014"; a measured 0 is "0.0%". A falsy test collapses
                        the two and prints "\u2014" for a real zero. */}
                    {row.segmentPercentage === null
                      ? '\u2014'
                      : `${row.segmentPercentage.toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {(row.textCoverage * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 border-b text-right tabular-nums">
                    {row.sourceCount}/{row.totalSources}
                  </td>
                  {kindCols.map(c => (
                    <td key={c.field} className="px-3 py-2 border-b text-right tabular-nums">
                      {formatKindCell(row, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-mm-bg font-medium">
                <td className="px-3 py-2" colSpan={categoryMode ? 1 : 2}>Totals</td>
                {/* #745: the SELECTION's coded segments, from the same payload
                    as the column above it. This read `totalCoded` off the
                    frequencies payload, so a conversations-only selection put
                    "4" here \u2014 every observation clip in the project \u2014 over a
                    column of zeroes. */}
                <td className="px-3 py-2 text-right tabular-nums">{data.totals.coded_segments}</td>
                <td className="px-3 py-2 text-right">{'\u2014'}</td>
                <td className="px-3 py-2 text-right">{'\u2014'}</td>
                <td className="px-3 py-2 text-right">{'\u2014'}</td>
                {kindCols.map(c => (
                  <td key={c.field} className="px-3 py-2 text-right tabular-nums">
                    {c.pct ? '\u2014' : (c.total ?? '\u2014')}
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
                <Th field="sourceLabel" label="Source" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left min-w-[160px]" />
                <Th field="sourceType" label="Type" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-left" />
                <Th field="totalCodes" label="Total Codes" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="uniqueCodes" label="Unique Codes" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="codedSegments" label="Coded Segments" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="codesPerSegment" label="Codes/Segment" sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
                <Th field="avgSegmentLength" label="Avg Words" hint={WORD_COUNT_NOTE} sortField={activeSortField} sortDir={sortDir} onSort={handleSort} indicator={sortIndicator} className="text-right" />
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
      {kindGroups.some(g => g.kind === 'conversation') && data.totals.unlinked_speaker_count > 0 && (
        <p className="text-xs text-mm-text-faint mt-2">
          {data.totals.unlinked_speaker_count} coded speaker
          {data.totals.unlinked_speaker_count !== 1 ? 's are' : ' is'} not linked to a participant,
          so {data.totals.unlinked_speaker_count !== 1 ? 'they are' : 'it is'} excluded from the
          participant counts and percentages above.
        </p>
      )}
    </div>
  )
}

/**
 * The shared class list for a sort control.
 *
 * The control is a real `<button>`, not an `onClick` on the `<th>`. A clickable
 * cell is mouse-only — nothing to tab to, and Enter/Space do nothing — so this
 * table could not be sorted by keyboard at all (WCAG 2.1.1 Keyboard). The
 * `aria-sort` state stays on the `<th>`, where the column's sort state belongs;
 * the button carries the action, the accessible name and the focus ring. It is
 * inline-flex so the `<th>`'s own `text-left`/`text-right` still places it.
 */
const SORT_BUTTON =
  'inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-mm-surface-hover ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

// Sortable table header cell
function Th({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  indicator,
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
  indicator: (field: string) => React.ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 border-b font-medium select-none ${className}`}
      aria-sort={sortField === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
      title={hint}
    >
      <button type="button" className={SORT_BUTTON} onClick={() => onSort(field)}>
        {label}
        {indicator(field)}
      </button>
    </th>
  )
}
