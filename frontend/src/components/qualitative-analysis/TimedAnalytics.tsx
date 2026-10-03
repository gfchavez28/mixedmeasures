import { useMemo } from 'react'
import type { QualTimelineTableMode } from '@/lib/qual-analysis-types'
import { useQueries } from '@tanstack/react-query'
import { observationsApi, type ObservationSegment } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'
import { useListLoad, type ListLoadQuery } from '@/hooks/useListLoad'
import { LoadState } from '@/components/LoadStatus'
import SegmentedControl from '@/components/ui/segmented-control'
import { coderColor, coderInitials } from '@/lib/coder-color'
import { formatTimecode } from '@/lib/utils'
import {
  buildCodelineLanes,
  computeTimedRows,
  computeTimedRowsByCoder,
  coveredTotalSeconds,
  detailVisible,
  formatTimedRate,
  formatTimedSeconds,
  formatTimedShare,
  timedExtent,
  type CodelineCategoryGroup,
  type TimedCodeRow,
  type TimedLens,
  type TimedCoderRow,
} from '@/lib/timed-analytics'

/**
 * Slab 6c — timed analytics for observations (plan §8q).
 *
 * One block per selected observation: the stacked codeline (Gantt-style, one
 * lane per selected code, category-grouped per D6) above the per-code summary
 * table. The codeline is aria-hidden (the occurrence-strip house rule) — THE
 * TABLE IS ITS ACCESSIBLE EQUIVALENT, so the two must always render together.
 *
 * All numbers are client-computed from the workbench clip payload, which is
 * the working layer by construction (P-1: no consensus rows) — the toolbar gates
 * this chart type off under the consensus layer scope. The lens (`TimedLens`)
 * mirrors the backend's `layer_scope_filter` then `_coder_filter` (see
 * lib/timed-analytics.ts) so these numbers agree with the neighboring
 * backend-computed charts — on the Coders layer a model's marks are left out,
 * on the Machine layer only a model's are drawn (#1077 b).
 */

export interface TimedObservationLite {
  id: number
  name: string
  media_duration_seconds: number | null
  segmentation_frozen_at: string | null
}

export interface TimedCodeLite {
  id: number
  name: string
  color?: string | null
  category_id?: number | null
  category_color?: string | null
}

export interface TimedCoderLite {
  id: number
  username: string
  display_color?: string | null
}

interface Props {
  projectId: number
  observations: TimedObservationLite[]
  /**
   * #963 Tier 2 — whether the OBSERVATIONS list is an answer.
   *
   * REQUIRED, so both mounts decide. The empty branch below is not merely a
   * false sentence but an INSTRUCTION — *"pick one under Sources"* — so over
   * an unanswered list it sends the researcher to redo a selection they may
   * already have made, and over a failed one it says so forever.
   */
  observationsLoad: ListLoad
  /** Selected codes, in sidebar order (already active-filtered by the caller). */
  codes: TimedCodeLite[]
  /** Category display order (backend CodeCategory order). */
  categories: { id: number; name: string }[]
  /**
   * Whose marks count: the layer, the machine coders it keys on, and the
   * effective coder include (blind forces self; null = no filter, #454).
   * REQUIRED as one object so no mount can pass an include set without the
   * machine coders (#1077 b).
   */
  lens: TimedLens
  multiCoder: boolean
  coderMap: ReadonlyMap<number, TimedCoderLite>
  /**
   * True when the analysis layer is CONSENSUS. The toolbar disables the chart
   * type there, but a timeline that was ALREADY active when the layer switched
   * would keep rendering human-layer numbers under a consensus banner — the
   * exact silent-wrong-layer case DEC-6c-7 refuses (live-drive find).
   */
  consensusScope?: boolean
  /**
   * Chart-label size from the material's `formatting` (#686). Every sibling
   * qualitative component honours it; this one hardcoded its sizes, so the
   * researcher's choice silently did nothing — on the analysis view as well as
   * on the canvas.
   *
   * The codeline deliberately uses TWO sizes (a recessive ruler under slightly
   * larger lane labels), so they scale RELATIVE to this rather than both
   * snapping to it — at the default of 12 the rendering is byte-identical to
   * what shipped in slab 6c.
   */
  labelFontSize?: number
  /**
   * Whether to offer the "By code / By code × coder" toggle (#652 slab 4).
   *
   * False on the canvas: a written document is not an interactive analysis
   * surface — the same reasoning that omits `ChartExportWrapper`'s per-chart
   * export buttons and the charts' click-through handlers from an embed. It
   * would also silently forget its position on every remount, because the mode
   * is per-observation local state that no material config records (#685).
   *
   * ⚠️ Deliberately NOT folded into `multiCoder`: that flag also drives the
   * mark's coder underline and — more importantly — the "airtime pools all
   * visible coders' marks" disclosure, which is a #503-class honesty line that
   * must survive on the canvas.
   */
  showTableModeToggle?: boolean
  /**
   * #685 — the table breakdown, now a per-CHART property so it survives a save.
   *
   * ⚠️ It is DERIVED against `multiCoder` in the component (see `effectiveMode`),
   * not guarded at the call sites. That placement is deliberate and falsifiable:
   * `TimedTable` renders by-coder rows on `mode` alone, and the toggle is already
   * gated on `multiCoder`, so a saved `'coder'` reaching a single-coder project —
   * or a BLIND canvas, where the lens sets `multiCoder: false` — would draw a
   * by-coder table with no control to change it. Kill the derivation and that
   * renders; a call-site guard would duplicate a rule this component can enforce
   * once. (`qual-timeline-params.ts` records a belt-and-braces guard REMOVED for
   * being unkillable — this is the same test applied in the other direction.)
   */
  tableMode?: QualTimelineTableMode
  onTableModeChange?: (mode: QualTimelineTableMode) => void
}

const TRACK_HEIGHT = 10
const TRACK_GAP = 2
/** Matches `DEFAULT_FORMATTING.labelFontSize`; the offsets below reproduce the
 *  original hardcoded 10px ruler / 11px lane labels at that value. */
const DEFAULT_LABEL_FONT_SIZE = 12

const codeColor = (c: TimedCodeLite): string => c.color || c.category_color || '#6b7280'

// Single-sourced in lib/timed-analytics so the canvas export's flattened table
// formats identically (#652 slab 4).
const pct = formatTimedShare
const rate = formatTimedRate
const secs = formatTimedSeconds

export default function TimedAnalytics({
  projectId, observations, observationsLoad, codes, categories, lens, multiCoder, coderMap,
  consensusScope = false, labelFontSize, showTableModeToggle = true,
  tableMode = 'code', onTableModeChange,
}: Props) {
  const clipQueries = useQueries({
    queries: observations.map(o => ({
      queryKey: ['observation-segments', projectId, o.id],
      queryFn: () => observationsApi.listSegments(projectId, o.id),
      enabled: !!projectId && !consensusScope,
    })),
  })

  if (consensusScope) {
    return (
      <div className="text-center py-16 text-mm-text-muted">
        The timeline cannot show the Consensus layer. Switch the layer to Coders or Machine to see it.
      </div>
    )
  }

  if (observationsLoad.status !== 'ready') {
    // #963 — before the list answers there is no "selected" to speak of.
    return (
      <LoadState
        load={observationsLoad}
        loadingLabel="Loading observations…"
        failedTitle="Your observations could not be loaded"
      />
    )
  }

  if (observations.length === 0) {
    return (
      <div className="text-center py-16 text-mm-text-muted">
        No observations selected — pick one under Sources.
      </div>
    )
  }

  return (
    <div className="space-y-6 p-3">
      {observations.map((obs, i) => (
        <ObservationTimedBlock
          key={obs.id}
          obs={obs}
          clips={clipQueries[i].data}
          // #963 Tier 3 — the WHOLE query, not an `isLoading` boolean: the
          // block derives its own `ListLoad` from it, so it can tell "this
          // observation has no clips" from "we were never told".
          clipQuery={clipQueries[i]}
          codes={codes}
          categories={categories}
          lens={lens}
          multiCoder={multiCoder}
          coderMap={coderMap}
          labelFontSize={labelFontSize}
          showTableModeToggle={showTableModeToggle}
          tableMode={tableMode}
          onTableModeChange={onTableModeChange}
        />
      ))}
    </div>
  )
}

function ObservationTimedBlock({
  obs, clips, clipQuery, codes, categories, lens, multiCoder, coderMap, labelFontSize,
  tableMode, onTableModeChange,
  showTableModeToggle,
}: {
  obs: TimedObservationLite
  clips: ObservationSegment[] | undefined
  clipQuery: ListLoadQuery
  codes: TimedCodeLite[]
  categories: { id: number; name: string }[]
  lens: TimedLens
  multiCoder: boolean
  coderMap: ReadonlyMap<number, TimedCoderLite>
  labelFontSize?: number
  showTableModeToggle?: boolean
  tableMode: QualTimelineTableMode
  onTableModeChange?: (mode: QualTimelineTableMode) => void
}) {
  // #685: by-coder is meaningless without more than one coder to break down by,
  // and `TimedTable` keys on `mode` alone — so the mode is derived here rather
  // than trusted from the config. Blind mode reaches this the same way, via the
  // canvas lens setting `multiCoder: false`.
  const effectiveMode: QualTimelineTableMode = multiCoder ? tableMode : 'code'

  const codeIds = useMemo(() => codes.map(c => c.id), [codes])
  const codeById = useMemo(() => new Map(codes.map(c => [c.id, c])), [codes])
  const codeToCategoryId = useMemo(
    () => new Map(codes.map(c => [c.id, c.category_id ?? null])),
    [codes],
  )

  const { extent, durationKnown } = timedExtent(obs.media_duration_seconds, clips ?? [])

  const rows = useMemo(
    () => computeTimedRows(clips ?? [], codeIds, lens, extent),
    [clips, codeIds, lens, extent],
  )
  const coderRows = useMemo(
    () => (effectiveMode === 'coder' ? computeTimedRowsByCoder(clips ?? [], codeIds, lens, extent) : []),
    [effectiveMode, clips, codeIds, lens, extent],
  )
  const groups = useMemo(
    () => buildCodelineLanes(clips ?? [], codeIds, lens, categories, codeToCategoryId),
    [clips, codeIds, lens, categories, codeToCategoryId],
  )

  // The anchor for the don't-sum disclosure — see `coveredTotalSeconds`, which
  // the canvas export reuses.
  const coveredTotal = useMemo(
    () => (clips ? coveredTotalSeconds(clips, codeIds, lens, extent) : null),
    [clips, codeIds, lens, extent],
  )

  const totalMarks = rows.reduce((s, r) => s + r.marks, 0)
  const totalPointMarks = rows.reduce((s, r) => s + r.pointMarks, 0)
  const visibleCoderCount = useMemo(() => {
    const seen = new Set<number | null>()
    for (const clip of clips ?? []) {
      for (const d of clip.applied_code_details) {
        if (detailVisible(d.user_id, lens)) seen.add(d.user_id)
      }
    }
    return seen.size
  }, [clips, lens])

  /**
   * #963 Tier 3 — MEASURED 2026-09-18 on three observations holding 4, 6 and 13
   * clips, with `/observations/{id}/segments` failing: at 2.5 s each block read
   * *"Loading clips…"*, and at 10 s each read the observation's name, its real
   * recording length, and **"No clips in this observation yet."**
   *
   * The duration is what makes it convincing — the figure plainly knows about
   * the recording, so the claim reads as a finding rather than as a fault. The
   * gate was `isLoading`, which is `isPending && isFetching` and therefore
   * false the moment a failure settles.
   *
   * ⚠️ One load PER OBSERVATION, never one over all of them: these are separate
   * requests, and a block that answered must not be blanked because its
   * neighbour failed (the Materials drawer's three-loads decision, Tier 2).
   */
  const clipLoad = useListLoad(clipQuery)
  if (clipLoad.status !== 'ready') {
    return (
      <LoadState
        load={clipLoad}
        loadingLabel="Loading clips…"
        failedTitle={`The clips for “${obs.name}” could not be loaded.`}
        size="panel"
      />
    )
  }

  return (
    <section aria-label={`Timed analytics for ${obs.name}`} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-mm-text">{obs.name}</h3>
        {extent != null && (
          <span
            className="text-xs text-mm-text-muted"
            title={durationKnown
              ? 'Recording length'
              // #622's rule: never present a fallback denominator as fact.
              : 'Recording length unknown — showing how far the clips reach'}
          >
            {formatTimecode(extent)}{durationKnown ? '' : ' marked'}
          </span>
        )}
        {multiCoder && showTableModeToggle && (
          <span className="ml-auto">
            <SegmentedControl
              options={[
                { value: 'code', label: 'By code' },
                { value: 'coder', label: 'By code × coder' },
              ]}
              value={effectiveMode}
              onChange={(v) => onTableModeChange?.(v as QualTimelineTableMode)}
              ariaLabel="Table breakdown"
              idPrefix={`timed-mode-${obs.id}`}
            />
          </span>
        )}
      </div>

      {(clips?.length ?? 0) === 0 ? (
        <p className="text-sm text-mm-text-muted rounded-md border border-mm-surface-border bg-mm-surface px-3 py-2">
          No clips in this observation yet.
        </p>
      ) : (
        <>
          {extent != null && (
            <Codeline
              groups={groups}
              extent={extent}
              codeById={codeById}
              multiCoder={multiCoder}
              coderMap={coderMap}
              labelFontSize={labelFontSize}
            />
          )}

          <TimedTable
            obsName={obs.name}
            mode={effectiveMode}
            rows={rows}
            coderRows={coderRows}
            codeById={codeById}
            coderMap={coderMap}
            coveredTotal={coveredTotal}
            extent={extent}
          />

          <p className="text-xs text-mm-text-faint max-w-3xl">
            Codes can overlap, so per-code airtimes don’t sum to the covered total.
            {!durationKnown && ' Recording length unknown — shares and rates use the marked extent.'}
            {totalPointMarks > 0 && ` ${totalPointMarks} instant mark${totalPointMarks === 1 ? '' : 's'} count toward frequency but have no duration.`}
            {multiCoder && visibleCoderCount > 1 && ' Airtime pools all visible coders’ marks — an interval two coders both marked counts once.'}
            {totalMarks === 0 && ' No visible marks for the selected codes here.'}
          </p>
        </>
      )}
    </section>
  )
}

/**
 * The stacked codeline. aria-hidden as a whole — the table below is the
 * accessible equivalent (the decorative-bar house rule, scaled up). Mark
 * titles remain for sighted hover. Identity is positional (each code has its
 * own labelled lane), so the code color on marks is redundant encoding, and
 * the coder underline is backed by the title + the by-coder table.
 */
function Codeline({
  groups, extent, codeById, multiCoder, coderMap, labelFontSize,
}: {
  groups: CodelineCategoryGroup[]
  extent: number
  codeById: ReadonlyMap<number, TimedCodeLite>
  multiCoder: boolean
  coderMap: ReadonlyMap<number, TimedCoderLite>
  labelFontSize?: number
}) {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const base = labelFontSize ?? DEFAULT_LABEL_FONT_SIZE
  const rulerSize = Math.max(6, base - 2)
  const laneSize = Math.max(6, base - 1)
  return (
    <div aria-hidden="true" className="select-none rounded-lg border border-mm-surface-border bg-mm-surface p-2">
      {/* Ruler — recessive, text tokens only. */}
      <div className="relative h-4 ml-[8.5rem] mr-1 text-mm-text-faint" style={{ fontSize: rulerSize }}>
        {ticks.map(t => (
          <span
            key={t}
            className="absolute -translate-x-1/2 last:translate-x-[-100%]"
            style={{ left: `${t * 100}%` }}
          >
            {formatTimecode(extent * t)}
          </span>
        ))}
      </div>
      {groups.map(group => (
        <div key={group.key}>
          {group.label && (
            <div className="font-medium text-mm-text-muted mt-1.5 mb-0.5 truncate" style={{ fontSize: laneSize }}>{group.label}</div>
          )}
          {group.lanes.map(lane => {
            const code = codeById.get(lane.codeId)
            return (
              <div key={lane.codeId} className="grid grid-cols-[8rem_1fr] items-center gap-2 mb-0.5">
                <span className="flex items-center gap-1.5 min-w-0" title={code?.name}>
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: code ? codeColor(code) : undefined }}
                  />
                  <span className="text-mm-text truncate" style={{ fontSize: laneSize }}>{code?.name ?? `Code ${lane.codeId}`}</span>
                </span>
                <div
                  className="relative rounded bg-mm-bg mr-1"
                  style={{ height: lane.trackCount * (TRACK_HEIGHT + TRACK_GAP) + TRACK_GAP }}
                >
                  {lane.marks.map((m, i) => {
                    const coder = m.userId != null ? coderMap.get(m.userId) : undefined
                    const label = `${code?.name ?? ''} · ${formatTimecode(m.start)}–${formatTimecode(m.end)}${coder ? ` · ${coder.username}` : ''}`
                    const top = TRACK_GAP + m.track * (TRACK_HEIGHT + TRACK_GAP)
                    if (m.end === m.start) {
                      // D7: a point event marks, it doesn't cover — an 8px pin.
                      return (
                        <span
                          key={i}
                          className="absolute w-2 h-2 rotate-45 -translate-x-1/2 ring-1 ring-mm-surface"
                          style={{ left: `${(m.start / extent) * 100}%`, top: top + 1, background: code ? codeColor(code) : undefined }}
                          title={label}
                        />
                      )
                    }
                    return (
                      <span
                        key={i}
                        className="absolute rounded-[3px] ring-1 ring-mm-surface"
                        style={{
                          left: `${(m.start / extent) * 100}%`,
                          width: `max(${((m.end - m.start) / extent) * 100}%, 3px)`,
                          top,
                          height: TRACK_HEIGHT,
                          background: code ? codeColor(code) : undefined,
                          // Coder identity as a 2px underline — backed by the
                          // title and the by-coder table (never color-alone).
                          borderBottom: multiCoder && coder ? `2px solid ${coderColor(coder)}` : undefined,
                        }}
                        title={label}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function TimedTable({
  obsName, mode, rows, coderRows, codeById, coderMap, coveredTotal, extent,
}: {
  obsName: string
  mode: 'code' | 'coder'
  rows: TimedCodeRow[]
  coderRows: TimedCoderRow[]
  codeById: ReadonlyMap<number, TimedCodeLite>
  coderMap: ReadonlyMap<number, TimedCoderLite>
  coveredTotal: number | null
  extent: number | null
}) {
  const byCoder = mode === 'coder'
  return (
    <div className="overflow-x-auto rounded-lg border border-mm-surface-border bg-mm-surface">
      <table className="w-full text-xs border-collapse">
        <caption className="sr-only">
          Timed analytics{byCoder ? ' by code and coder' : ''} for {obsName}
        </caption>
        <thead>
          <tr className="border-b text-left text-mm-text-muted">
            <th scope="col" className="px-3 py-2 font-medium">Code</th>
            {byCoder && <th scope="col" className="px-3 py-2 font-medium">Coder</th>}
            <th scope="col" className="px-3 py-2 font-medium text-right">Marks</th>
            <th scope="col" className="px-3 py-2 font-medium text-right">Airtime</th>
            <th scope="col" className="px-3 py-2 font-medium text-right">Share of session</th>
            <th scope="col" className="px-3 py-2 font-medium text-right">Rate</th>
            <th scope="col" className="px-3 py-2 font-medium text-right">Mean bout</th>
            <th scope="col" className="px-3 py-2 font-medium text-right">Median bout</th>
            <th scope="col" className="px-3 py-2 font-medium text-right">Longest bout</th>
          </tr>
        </thead>
        <tbody>
          {(byCoder ? coderRows : rows).map((row, i) => {
            const code = codeById.get(row.codeId)
            const userId = byCoder ? (row as TimedCoderRow).userId : undefined
            const coder = userId != null ? coderMap.get(userId) : undefined
            return (
              <tr key={i} className="border-b last:border-b-0">
                <th scope="row" className="px-3 py-1.5 font-normal text-left">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      aria-hidden="true"
                      style={{ background: code ? codeColor(code) : undefined }}
                    />
                    {code?.name ?? `Code ${row.codeId}`}
                  </span>
                </th>
                {byCoder && (
                  <td className="px-3 py-1.5">
                    {coder ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-semibold text-white shrink-0"
                          aria-hidden="true"
                          style={{ background: coderColor(coder) }}
                        >
                          {coderInitials(coder.username)}
                        </span>
                        {coder.username}
                      </span>
                    ) : (
                      <span className="text-mm-text-muted">
                        {userId != null ? `Coder #${userId}` : 'Unattributed'}
                      </span>
                    )}
                  </td>
                )}
                <td className="px-3 py-1.5 text-right tabular-nums">{row.marks}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{secs(row.airtimeSeconds)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{pct(row.airtimeFraction)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{rate(row.ratePerMinute)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{secs(row.meanBoutSeconds)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{secs(row.medianBoutSeconds)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{secs(row.maxBoutSeconds)}</td>
              </tr>
            )
          })}
        </tbody>
        {coveredTotal != null && extent != null && (
          <tfoot>
            <tr className="border-t text-mm-text-muted">
              <th scope="row" colSpan={byCoder ? 2 : 1} className="px-3 py-1.5 font-medium text-left">
                Covered by selected coding
              </th>
              <td className="px-3 py-1.5" />
              <td className="px-3 py-1.5 text-right tabular-nums font-medium">{secs(coveredTotal)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums font-medium">{pct(coveredTotal / extent)}</td>
              <td className="px-3 py-1.5" colSpan={4} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
