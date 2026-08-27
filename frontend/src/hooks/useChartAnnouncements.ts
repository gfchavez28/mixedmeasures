/* NOTE: these are ARIA announcements driven by setState in response to data/config
 * changes, which is the pattern `react-hooks/set-state-in-effect` flags.
 *
 * A file-level `eslint-disable` used to live here. It became UNUSED when #786 routed
 * every write through `announce()` — the rule cannot see setState behind one call —
 * and `--report-unused-disable-directives` then reports the orphan, so it was left
 * as prose ending "restore it if the writes ever move back inline".
 *
 * #791 moved them back inline: the flush effect and the clear effect both set state
 * directly, and both now carry their own narrow directive with its own reason. Narrow
 * rather than file-level on purpose — a file-level disable would also silence the
 * next author's genuine mistake. */
import { useState, useEffect, useRef, type MutableRefObject } from 'react'
import type { ChartType } from '@/lib/chart-data'
import type { AnalysisDemographicItem } from '@/lib/api'

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  heatmap: 'Heatmap',
  horizontal_bar: 'Horizontal Bar',
  stacked_bar: 'Stacked Bar',
  vertical_bar: 'Vertical Bar',
  dumbbell: 'Dumbbell',
  table: 'Summary Table',
  line: 'Line Chart',
  frequency_table: 'Frequency Table',
  cross_tab: 'Cross-Tabulation',
  histogram: 'Histogram',
}

/**
 * The sentence for a chart-type change — ONE composition, read by the aria-live
 * announcement and by the visible banner (#786).
 *
 * ⚠️ Only ONE of those two channels may announce, or a screen reader says the same
 * fact twice in consecutive sentences — the defect caught by looking at the Q–Q
 * plot (#525b). The banner is therefore rendered WITHOUT `role="status"`: it is the
 * sighted half, and this hook's live region is the heard half.
 *
 * Returns `null` when there is nothing worth saying (no change, or no previous
 * type to compare against).
 */
export function describeChartTypeChange(
  prev: ChartType | null,
  next: ChartType | null,
  disabledReasons: Partial<Record<ChartType, string>> = {},
): string | null {
  if (!next) return null
  const nextLabel = CHART_TYPE_LABELS[next] || next.replace(/_/g, ' ')
  if (!prev || prev === next) return `Chart type changed to ${nextLabel}`

  // An AUTOMATIC change: the type we were showing is no longer applicable, and
  // the reason is already authored where the availability is decided — reuse it
  // rather than writing a second sentence that can drift from the picker's.
  const reason = disabledReasons[prev]
  if (!reason) return `Chart type changed to ${nextLabel}`
  const prevLabel = CHART_TYPE_LABELS[prev] || prev.replace(/_/g, ' ')
  return `${prevLabel} is no longer available — ${reason}. Showing ${nextLabel} instead.`
}

/**
 * The channels that can speak in one commit, in the order a composed sentence
 * reads them.
 *
 * 🔴 #791: the order here is EDITORIAL, and that is the whole point. Five effects
 * wrote one `announcement` state; when two fired in the same commit React batched
 * them and the last-DECLARED writer won — every time, because declaration order is
 * fixed. `Chart updated with N variables` therefore never reached the DOM at all,
 * and it is the one that tells a screen-reader user their chart finished computing.
 *
 * The event leads and its attributes follow: what happened to the chart, then what
 * the chart now is.
 */
const CHANNEL_ORDER = ['update', 'chartType', 'grouping', 'layout', 'scale'] as const

export type AnnouncementChannel = (typeof CHANNEL_ORDER)[number]

/**
 * Compose everything recorded in ONE commit into ONE sentence.
 *
 * ⚠️ A QUEUE was considered and rejected. These messages describe the same event at
 * the same moment, so reading them as separate utterances implies two things
 * happened — the consecutive-sentences defect the Q–Q plot pass caught by looking
 * (#525b). One commit, one composition, one utterance.
 *
 * Each part is normalised to end in a full stop, so the reader gets a sentence
 * boundary between facts and a part that already ends in one (the automatic
 * chart-type explanation, which ends `…instead.`) does not produce a doubled stop.
 */
export function composeAnnouncement(
  parts: Partial<Record<AnnouncementChannel, string>>,
): string {
  return CHANNEL_ORDER
    .map(channel => parts[channel])
    .filter((part): part is string => !!part)
    .map(part => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(' ')
}

export function useChartAnnouncements(deps: {
  isComputing: boolean
  /**
   * ⚠️ LAGS the user's selection — it counts the quick-compute results, which are
   * async. Do NOT use it to decide "is there a chart"; that is `hasChart` (#786).
   */
  metricCount: number
  /**
   * Is there a chart on screen AT ALL — the SYNCHRONOUS selection
   * (`hasAnySelection`), never the metric list.
   *
   * 🔴 #786: unchecking the last variable announced "Chart type changed to
   * Horizontal Bar" with nothing selected and nothing rendered. The cause is a
   * RACE, not a missing count: `continuousSelection` recomputes from
   * `selectedColumnIds` the instant the box clears, while `selectedMetrics` still
   * holds the stale result — so for one commit the derived default flips to
   * `horizontal_bar` and this hook faithfully reports a state no user ever saw.
   * Gating on `metricCount > 0` would NOT have caught it: that count is the stale
   * half of the race.
   */
  hasChart: boolean
  chartType: ChartType | null
  /**
   * `chartTypeInfo.disabledReasons` — why each type is unavailable for the
   * CURRENT selection. Used to explain an AUTOMATIC change: if the type we were
   * showing has since become unavailable, its reason is why the chart moved.
   */
  chartTypeDisabledReasons?: Partial<Record<ChartType, string>>
  groupingColumnId: number | null
  groupingColumnId2: number | null
  demographics: AnalysisDemographicItem[]
  divergingMode?: boolean
  axisTransform?: string
}): string {
  const [announcement, setAnnouncement] = useState('')
  const mountedRef = useRef(false)

  /**
   * Assigned during render (the `optionsRef` pattern) so every effect below reads
   * the CURRENT value without taking it as a dependency — adding it to the dep
   * arrays would re-fire the stateful grouping effect and announce "Grouping
   * removed" on every selection change.
   */
  const hasChartRef = useRef(deps.hasChart)
  hasChartRef.current = deps.hasChart

  /** Facts recorded by this commit's effects, awaiting the flush effect below. */
  const pendingRef = useRef<Partial<Record<AnnouncementChannel, string>>>({})

  /**
   * Every announcement here describes THE CHART. With no chart there is nothing
   * to describe, so this is one gate rather than five — and it suppresses only,
   * leaving each effect's own bookkeeping (notably `prevGroupingRef`) intact.
   *
   * #791 — a write RECORDS a fact for this commit instead of setting the state
   * directly, and the flush effect at the bottom composes whatever was recorded.
   * Recording per CHANNEL rather than appending to a list means the same fact
   * restated within one commit keeps its latest wording instead of being said
   * twice.
   */
  const announce = (channel: AnnouncementChannel, message: string) => {
    if (!hasChartRef.current) return
    pendingRef.current[channel] = message
  }

  // Skip all announcements on initial mount — delay so effects in the
  // same render cycle still see mountedRef.current === false
  useEffect(() => {
    const id = requestAnimationFrame(() => { mountedRef.current = true })
    return () => cancelAnimationFrame(id)
  }, [])

  // Announce on compute complete
  useEffect(() => {
    if (!mountedRef.current) return
    if (!deps.isComputing && deps.metricCount > 0) {
      const n = deps.metricCount
      announce('update', `Chart updated with ${n} ${n === 1 ? 'variable' : 'variables'}`)
    }
  }, [deps.isComputing, deps.metricCount])

  // Announce chart type change — with WHY, when the change was automatic (#786).
  // The previous type is tracked here rather than passed in: this hook already
  // sees every transition, and a caller-held ref would be a second source.
  const prevTypeRef = useRef<ChartType | null>(null)
  const reasonsRef = useRef(deps.chartTypeDisabledReasons)
  reasonsRef.current = deps.chartTypeDisabledReasons
  useEffect(() => {
    if (!mountedRef.current) return
    const prev = prevTypeRef.current
    prevTypeRef.current = deps.chartType
    const message = describeChartTypeChange(prev, deps.chartType, reasonsRef.current)
    if (message) announce('chartType', message)
  }, [deps.chartType])

  // Announce group by change (skip first render to avoid "Grouping removed" on mount)
  const prevGroupingRef = useRef<number | null | undefined>(undefined) as MutableRefObject<number | null | undefined>
  // Ref avoids putting the demographics array in useEffect deps (unstable identity).
  // Read inside the effect to get the latest value without re-triggering on every render.
  const demographicsRef = useRef(deps.demographics)
  useEffect(() => { demographicsRef.current = deps.demographics }, [deps.demographics])

  useEffect(() => {
    if (!mountedRef.current) return
    if (prevGroupingRef.current === undefined) {
      prevGroupingRef.current = deps.groupingColumnId
      return
    }
    prevGroupingRef.current = deps.groupingColumnId
    if (deps.groupingColumnId) {
      const demo1 = demographicsRef.current.find(d => d.id === deps.groupingColumnId)
      const label1 = demo1?.column_name || demo1?.column_text || 'variable'
      if (deps.groupingColumnId2) {
        const demo2 = demographicsRef.current.find(d => d.id === deps.groupingColumnId2)
        const label2 = demo2?.column_name || demo2?.column_text || 'variable'
        announce('grouping', `Group by: ${label1} \u00d7 ${label2} applied`)
      } else {
        announce('grouping', `Group by: ${label1} applied`)
      }
    } else {
      announce('grouping', 'Grouping removed')
    }
  }, [deps.groupingColumnId, deps.groupingColumnId2])

  // Announce diverging mode change
  useEffect(() => {
    if (!mountedRef.current) return
    if (deps.divergingMode != null) {
      announce('layout', deps.divergingMode ? 'Diverging layout applied' : 'Standard layout applied')
    }
  }, [deps.divergingMode])

  // Announce axis transform change
  useEffect(() => {
    if (!mountedRef.current) return
    if (deps.axisTransform) {
      announce('scale', deps.axisTransform === 'log' ? 'Log scale applied' : 'Linear scale applied')
    }
  }, [deps.axisTransform])

  /**
   * #791 — the region must not go on describing a chart that is gone.
   *
   * `announce` is already suppressed with no chart, so nothing can be pending
   * here; what this clears is what the LAST chart left behind. A reader
   * navigating to the region by hand was still finding "Chart type changed to
   * Histogram" after the selection had been emptied. Removing the text does not
   * re-announce (no reader speaks a removal), which is the intent.
   */
  useEffect(() => {
    if (deps.hasChart) return
    pendingRef.current = {}
    // The live region IS the external system this rule describes: its content must
    // follow the chart's existence, and there is no render-time value to derive it
    // from — the text was written by an earlier commit's effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ARIA live region
    setAnnouncement('')
  }, [deps.hasChart])

  /**
   * Declared LAST on purpose: React runs a commit's effects in declaration order,
   * so by the time this one runs every announcing effect above has recorded
   * whatever it had to say — which is exactly what the batching defect denied
   * them. No dependency array, because it must run in any commit that could have
   * recorded something.
   *
   * It sets state only when something is pending and empties the record first, so
   * the re-render it causes finds nothing and stops there.
   */
  // The empty-dep-list fix this rule suggests is the one thing that would break the
  // flush: it must run in EVERY commit that could have recorded a fact. The update
  // chain it warns about is closed by emptying the record before setting state, so
  // the re-render it causes finds nothing pending and stops.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- must run every commit
  useEffect(() => {
    const parts = pendingRef.current
    if (Object.keys(parts).length === 0) return
    pendingRef.current = {}
    setAnnouncement(composeAnnouncement(parts))
  })

  return announcement
}
