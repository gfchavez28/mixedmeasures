/**
 * The Timeline material, drawn inside a canvas embed (#652 slab 4).
 *
 * ⚠️ **This is the one qualitative type with NO endpoint.** The other eight map
 * a saved config onto one analysis request and mount a props-driven component.
 * The Timeline is computed client-side from the workbench clip payload, so the
 * embed has to assemble what `QualitativeAnalysisView` assembles: the project's
 * observations, its codes, its category order and the coder lens — then
 * `TimedAnalytics` fetches one clip list per observation itself.
 *
 * It therefore owns its queries rather than taking data props, following
 * `QualCooccurrence` (the other self-fetching child in `QualChartRouter`).
 * Putting them in `InlineChartRenderer` would make every QUANTITATIVE embed
 * declare four more `useQuery` calls it can never use.
 *
 * Query keys are deliberately the SAME as the analysis view's, so a canvas with
 * several Timeline embeds — or a researcher who arrives from the analysis view —
 * shares one cache entry per dataset instead of refetching per embed. The
 * fields read here are present under every variant of those keys (`is_active` is
 * re-filtered locally, so an include-inactive writer cannot widen the lanes).
 *
 * Three states are handled HERE rather than by mounting `TimedAnalytics`,
 * because its own copy names controls a canvas does not have — "pick one under
 * Sources", "switch the layer back to Coders". That is the same defect slab 0
 * fixed when it replaced "No data configured", and it is why this component
 * exists at all rather than being a case in the router.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { codesApi, categoriesApi, observationsApi } from '@/lib/api'
import { useCoders } from '@/hooks/useCoders'
import { useListLoad } from '@/hooks/useListLoad'
import { useBlindMode } from '@/hooks/useBlindMode'
import { useAuth } from '@/lib/auth-context'
import BlindScopeNotice from '@/components/qualitative-analysis/BlindScopeNotice'
import TimedAnalytics from '@/components/qualitative-analysis/TimedAnalytics'
import {
  resolveTimelineObservations,
  resolveTimelineCodes,
  resolveTimelineCoderLens,
} from './qual-timeline-params'
import type { QualComputeParams } from './inline-chart-params'

const REFERENCE_STALE_TIME = 5 * 60 * 1000

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm text-mm-text-faint py-4 text-center" role="status">
      {children}
    </div>
  )
}

export interface QualTimelineEmbedProps {
  projectId: number
  params: QualComputeParams
  /** Chart-label size from the material's saved formatting (#686). */
  labelFontSize?: number
}

export default function QualTimelineEmbed({ projectId, params, labelFontSize }: QualTimelineEmbedProps) {
  // ⚠️ A saved Timeline material CAN carry the consensus layer. The toolbar
  // disables the chart type under consensus but never changes `qa.chartType`,
  // and "Add to Materials" is gated on nothing (#684) — so switching the layer
  // with the Timeline active and saving produces exactly this config. The
  // Timeline reads the human coding layer (P-1), so drawing it here would put
  // human-layer numbers under a consensus material: the silent-wrong-layer case
  // DEC-6c-7 exists to refuse.
  //
  // Gated via `enabled` rather than an early return so hook order never depends
  // on the config (the `InlineChartRenderer` rule).
  const isConsensus = params.layerScope === 'consensus'
  const wanted = !isConsensus && !!projectId

  const observationsQuery = useQuery({
    queryKey: ['observations', projectId],
    queryFn: () => observationsApi.list(projectId),
    enabled: wanted,
    staleTime: REFERENCE_STALE_TIME,
  })
  const observationsData = observationsQuery.data
  /**
   * #963 — `TimedAnalytics` requires this so BOTH mounts decide what an
   * unanswered list means. Here it is always `ready` by the time the child
   * mounts: the gate below returns a loading notice first, and the empty case
   * is answered with copy that names controls a canvas has (the reason this
   * component handles those states itself). Passing a real one rather than a
   * literal keeps the claim true if that gate is ever moved.
   */
  const observationsLoad = useListLoad(observationsQuery)

  const codesQuery = useQuery({
    queryKey: ['codes', projectId],
    queryFn: () => codesApi.list(projectId),
    enabled: wanted,
    staleTime: REFERENCE_STALE_TIME,
  })
  const codesData = codesQuery.data

  const categoriesQuery = useQuery({
    queryKey: ['categories', projectId],
    queryFn: () => categoriesApi.list(projectId, true),
    enabled: wanted,
    staleTime: REFERENCE_STALE_TIME,
  })
  const categoriesData = categoriesQuery.data

  /**
   * #963 Tier 3 — the three reference lists this figure is DRAWN FROM, as one
   * load. The gate below used three `isLoading` flags, and `isLoading` is
   * `isPending && isFetching`: it goes false once a failure has settled, so the
   * component fell straight through to *"This project has no observations to
   * chart."* — a failed request reading, inside a written document, as the
   * observations having been deleted.
   *
   * ⚠️ The ROSTER is deliberately not in here. It decides whether the figure is
   * blind-scoped and whether it says so, and a failed roster must still DRAW
   * (under the fail-closed lens) rather than stall a canvas export — that
   * decision is #964's and is unchanged.
   */
  const referenceLoad = useListLoad(observationsQuery, codesQuery, categoriesQuery)

  const { coderMap, multiCoder: rosterMultiCoder, status: rosterStatus } = useCoders()
  // #964: the lens narrows on `withholding`, which fails CLOSED while the roster
  // is unanswered; `blind` alone read an unanswered roster as a one-person one.
  const { blind, withholding } = useBlindMode(projectId)
  const { user } = useAuth()

  const observations = useMemo(
    () => resolveTimelineObservations(params.request.observation_ids ?? [], observationsData ?? []),
    [params.request.observation_ids, observationsData],
  )
  const codes = useMemo(
    () => resolveTimelineCodes(params.request.code_ids ?? [], codesData?.codes ?? []),
    [params.request.code_ids, codesData?.codes],
  )
  const categories = useMemo(
    () => (categoriesData?.categories ?? []).map(c => ({ id: c.id, name: c.name })),
    [categoriesData?.categories],
  )

  const lens = useMemo(
    () => resolveTimelineCoderLens(params.request.coder_ids ?? null, withholding, user?.id ?? null, rosterMultiCoder),
    [params.request.coder_ids, withholding, user?.id, rosterMultiCoder],
  )

  if (isConsensus) {
    return (
      <Notice>
        This timeline was saved with the Consensus layer selected. The timeline reads the
        human coding layer, so there is nothing to draw.
      </Notice>
    )
  }

  // #964: the roster decides whether this figure is blind-scoped and whether it
  // says so, so it waits for the roster too. A FAILED roster does not wait (it
  // would spin forever and stall a canvas export); it draws under the fail-closed lens.
  if (referenceLoad.status === 'loading' || rosterStatus === 'loading') {
    // The exact wording `waitForChartsReady` polls for, alongside the spin class
    // — so a canvas export never rasterizes this state.
    return (
      <div className="flex items-center justify-center py-8 text-mm-text-faint text-sm gap-2" role="status">
        <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />
        Loading chart...
      </div>
    )
  }

  // #963 Tier 3 — a failed reference list is a statement about the REQUEST, and
  // it must not be told as a statement about the project. Kept as this file's
  // own `Notice` rather than `LoadState`: `LoadFailedNotice` offers a Retry,
  // and a canvas is a reading surface whose embeds redraw on their own when the
  // page is revisited — a button per embed on a document with several would be
  // noise where there is nothing to decide. The words are the ones
  // `InlineChartRenderer` already uses for every embed kind it gates itself.
  if (referenceLoad.status === 'failed') {
    return (
      <Notice>
        Chart unavailable — this project&rsquo;s observations, codes or categories could not be
        loaded. Nothing in your project has changed.
      </Notice>
    )
  }

  if (observations.length === 0) {
    // Two different facts, and the researcher can act on only one of them.
    return (
      <Notice>
        {(params.request.observation_ids?.length ?? 0) > 0
          ? 'The observations this timeline was built from are no longer in this project.'
          : 'This project has no observations to chart.'}
      </Notice>
    )
  }

  return (
    <div className="space-y-2">
      {/* #517 — a blind-scoped figure must SAY so. No reveal control: the canvas
          is a writing surface and breaking blindness belongs on the analysis
          surfaces, where it is logged. `BlindScopeNotice` renders nothing when
          `blind` is false. */}
      <BlindScopeNotice blind={lens.blinded}>
        {/* #964: narrowed without `blind` means the roster FAILED (a loading
            roster never reaches here) — "blind mode is on" is not known to be true. */}
        {blind
          ? 'Blind mode is on — this timeline shows only your own coding, and coder names are hidden.'
          : 'The coder list could not be loaded, so this timeline shows only your own coding.'}
      </BlindScopeNotice>
      <TimedAnalytics
        projectId={projectId}
        observations={observations}
        observationsLoad={observationsLoad}
        codes={codes}
        categories={categories}
        include={lens.include}
        multiCoder={lens.multiCoder}
        coderMap={coderMap}
        consensusScope={false}
        labelFontSize={labelFontSize}
        // A document is not an interactive analysis surface, so the control
        // stays hidden — but since #685 the mode IS recorded, so the figure now
        // renders the breakdown the researcher arranged instead of always
        // falling back to by-code.
        //
        // No blind guard here on purpose: `lens.multiCoder` is false while
        // blind, and `TimedAnalytics` derives the effective mode against it. A
        // second guard at this call site would be the unkillable kind this
        // module already removed one of.
        showTableModeToggle={false}
        tableMode={params.tableMode}
      />
    </div>
  )
}
