import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleAlert, CircleX, Loader2 } from 'lucide-react'
import {
  codeAnalysisApi, type Code, type IrrCodeResult, type IrrMagnitudeResult, type IrrThresholds,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { describeUndefined, undefinedTooltip } from '@/lib/stat-format'
import { ciCaveat, ciQualifier, ciUnavailableNote } from '@/lib/ci-label'
import { formatMagnitude } from '@/lib/magnitude'
import {
  alphaMetricLabel, describeAlphaMetric, describeReliabilityFacet, reliabilityFacetQualifier,
} from '@/lib/reliability-basis'
import {
  intervalAccessibleText, intervalVisualText, straddleNote, straddledThresholds,
  type ReliabilityInterval,
} from '@/lib/reliability-interval'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '@/components/ui/select'

/** Sentinel for "no source filter" — a Radix SelectItem may not have an empty value. */
const POOLED = '__pooled__'

/** Group heading per source kind, in the order the picker lists them. */
const KIND_LABEL: Record<string, string> = {
  conv: 'Conversations',
  doc: 'Documents',
  obs: 'Observations (agreed clips)',
  col: 'Text columns',
}

interface IrrMatrixProps {
  projectId: number
  /** Project code list — used only for an optional color swatch (the IRR payload has no color). */
  codes?: Code[]
}

const BAND_LABEL: Record<string, string> = {
  poor: 'poor', slight: 'slight', fair: 'fair', moderate: 'moderate',
  substantial: 'substantial', almost_perfect: 'almost perfect',
  unreliable: 'unreliable', tentative: 'tentative', reliable: 'reliable',
}
// Band → text color. ALWAYS paired with the band word in the UI (never color-only — #409).
const GOOD = 'text-emerald-600 dark:text-emerald-400'
const MID = 'text-amber-600 dark:text-amber-400'
const BAD = 'text-rose-600 dark:text-rose-400'
const BAND_CLASS: Record<string, string> = {
  poor: BAD, slight: BAD, unreliable: BAD,
  fair: MID, moderate: MID, tentative: MID,
  substantial: GOOD, almost_perfect: GOOD, reliable: GOOD,
}

const fmt = (v: number | null | undefined, dp = 2) => (v == null ? '—' : v.toFixed(dp))
const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const bandWord = (b: string | null) => (b ? BAND_LABEL[b] ?? b : '')
// Cutoffs print at their natural precision: 0.80 → "0.80", 0.667 → "0.667".
const fmtThresh = (v: number) => (Number.isInteger(v * 100) ? v.toFixed(2) : v.toFixed(3))
// Conventional Krippendorff (2004) α cutoffs — fallback only; the live payload's
// `interpretation_thresholds.alpha` is the source of truth (mirrors irr.py ALPHA_THRESHOLDS).
const ALPHA_FALLBACK = { tentative: 0.667, reliable: 0.8 }

/**
 * #43 rider (2026-09-01) — an interval that SPANS an interpretation cutoff has
 * not settled the band the point estimate names. The band word stays (it is
 * still what the estimate says); its status COLOUR is withdrawn, because green
 * "reliable" over [0.00, 1.00] asserts a certainty the interval denies.
 */
const unsettledBand = (ci?: ReliabilityInterval | null, thresholds?: Record<string, number>): boolean =>
  !!thresholds && straddledThresholds(ci, thresholds).length > 0

/** "κ=0.72 substantial" / "κ not computable" — null-safe phrase for the aria-label. */
function metricPhrase(
  label: string, value: number | null, band: string | null,
  reason?: string | null, ci?: ReliabilityInterval | null,
  thresholds?: Record<string, number>,
): string {
  // A browse-mode reader never hovers, so the reason must ride the name.
  if (value == null) return `${label} ${describeUndefined(reason) ?? 'not computable'}`
  const w = bandWord(band)
  // #43 — the interval belongs in the row summary too. A reader who only hears
  // "α=0.72 tentative" has the one number an interval exists to qualify.
  const interval = intervalAccessibleText(ci, ciQualifier(ci?.method))
  // An interval object with no bounds is a REFUSAL with a reason, not an
  // absence — the row must say so, or a reader hears a bare coefficient and
  // cannot tell it apart from one whose interval simply was not computed.
  const suffix = interval ? `, ${interval}` : (ci ? ', no confidence interval' : '')
  const unsettled = unsettledBand(ci, thresholds) ? ' (the interval spans a cutoff)' : ''
  return `${label}=${value.toFixed(2)}${w ? ` ${w}` : ''}${suffix}${unsettled}`
}

function rowAriaLabel(c: IrrCodeResult, showKappa: boolean, thresholds?: IrrThresholds): string {
  const parts = [`${c.code_name}:`]
  if (showKappa) parts.push(`${metricPhrase('κ', c.cohens_kappa, c.kappa_interpretation, c.undefined_reason, c.kappa_ci, thresholds?.kappa)};`)
  parts.push(`${metricPhrase('α', c.krippendorff_alpha, c.alpha_interpretation, c.undefined_reason, c.alpha_ci, thresholds?.alpha)};`)
  parts.push(`${fmtPct(c.percent_agreement)} agreement;`)
  parts.push(`prevalence ${fmt(c.prevalence)}`)
  return parts.join(' ')
}

/** `"−1 to 1"` — the declared range, spoken and shown the same way. */
function scaleRangeText(r: IrrMagnitudeResult): string {
  return `${formatMagnitude(r.scale.min)} to ${formatMagnitude(r.scale.max)}`
}

/** `"0 = none · 10 = strong"` for a tooltip; empty when the scale has no anchors. */
function anchorsText(r: IrrMagnitudeResult): string {
  return r.scale.anchors.map(a => `${formatMagnitude(a.value)} = ${a.label}`).join(' · ')
}

/**
 * #35 — the rating row's summary. Same shape as `rowAriaLabel`: the whole fact
 * in one string, because a browse-mode reader hears the row, not the cells.
 */
function ratingRowAriaLabel(r: IrrMagnitudeResult, alphaThresholds?: Record<string, number>): string {
  const parts = [`${r.code_name}:`]
  parts.push(`scale ${scaleRangeText(r)};`)
  parts.push(`${metricPhrase('α', r.krippendorff_alpha, r.alpha_interpretation, r.undefined_reason, r.alpha_ci, alphaThresholds)};`)
  parts.push(`${r.n_rated} of ${r.n_applications} applications rated;`)
  parts.push(
    r.mean_abs_difference == null
      ? 'no unit rated by two coders'
      : `coders differ by ${r.mean_abs_difference.toFixed(2)} on average`,
  )
  return parts.join(' ')
}

/** A value + its band word, band-colored (dual-encoded).
 *
 * #829 — an undefined statistic SAYS WHY. A code nobody applied in scope has no
 * variance to agree about, and the arithmetic returns κ = 1.0 ("almost
 * perfect") if you let it. The dash alone would trade a confident wrong number
 * for a silent one; the reason comes from `lib/stat-format.ts`, the same reader
 * every other undefined statistic uses, so the vocabulary stays single-sourced
 * (an unknown reason renders the neutral fallback rather than an invention).
 */
function BandValue({ value, band, reason, ci, thresholds }: {
  value: number | null
  band: string | null
  reason?: string | null
  /** #43 — rendered INSIDE this cell, on a second line. */
  ci?: ReliabilityInterval | null
  /** The cutoffs the band was read from; with `ci`, decides whether the band is settled. */
  thresholds?: Record<string, number>
}) {
  if (value == null) {
    return (
      <span className="text-mm-text-faint" title={undefinedTooltip(reason)}>
        —<span className="sr-only"> {undefinedTooltip(reason)}</span>
      </span>
    )
  }
  // #43 — the interval rides the EXISTING cell rather than taking two new
  // columns. This table already scrolls horizontally, and a 640×360 viewport
  // (what a 1280×720 window gives at 200% zoom) is where extra columns become
  // unreachable content rather than dense content (#717/#718). Stacked, the
  // bracket text is narrower than the band word already on the line above it.
  const visual = intervalVisualText(ci)
  const spoken = intervalAccessibleText(ci, ciQualifier(ci?.method))
  // The status colour is a claim; withdraw it when the interval does not back
  // it. The word stays and the withdrawal is ALSO said in text (never colour
  // alone, in either direction — #409), so the two encodings agree.
  const unsettled = unsettledBand(ci, thresholds)
  return (
    <span className="inline-flex flex-col items-end">
      <span
        className={cn('font-medium', band ? (unsettled ? 'text-mm-text-muted' : BAND_CLASS[band]) : undefined)}
        title={unsettled ? 'The interval spans an interpretation cutoff, so these data do not settle this band.' : undefined}
      >
        {value.toFixed(2)}
        {/* sr-only space so the cell's accessible text reads "0.00 unreliable", not
            "0.00unreliable" — ml-1 is visual-only margin and adds no spoken separator (#445). */}
        {band && <><span className="sr-only"> </span><span className="ml-1 text-xs font-normal text-mm-text-muted">{bandWord(band)}</span></>}
        {unsettled && <span className="sr-only"> (the interval spans a cutoff)</span>}
      </span>
      {visual ? (
        <span className="text-[11px] font-normal text-mm-text-faint leading-tight">
          {/* ⚠️ The bracket form is for the EYE only: a reader renders it as
              "left bracket … comma …", and an en dash as a minus sign — wrong on
              a coefficient that legitimately goes negative. The spoken form says
              "0.58 to 0.83" and names the level. */}
          <span aria-hidden="true">{visual}</span>
          <span className="sr-only"> {spoken}</span>
        </span>
      ) : ci ? (
        // A refusal, not an absence. The marker is compact because the SENTENCE
        // is rendered once below the table — one explanation per distinct
        // reason, rather than the same paragraph on every affected row.
        <span className="text-[11px] font-normal text-mm-text-faint leading-tight">
          <span aria-hidden="true">no interval</span>
          <span className="sr-only"> no confidence interval</span>
        </span>
      ) : null}
    </span>
  )
}

export default function IrrMatrix({ projectId, codes }: IrrMatrixProps) {
  // IRR is ALWAYS all-roster — never pass coder_ids (the CoderFilterPopover is a
  // visibility filter, not a "compare these raters" selector). See the build scope.
  // #829 — WHICH source this table is about. `null` = pooled, the old behaviour
  // and still the default: "is our codebook working overall" is a real question,
  // it was only ever wrong as the ONLY question.
  //
  // ⚠️ It is in the QUERY KEY. A scope that rides the request but not the key
  // serves the previous source's numbers from cache (#454's class).
  const [source, setSource] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['irr', projectId, null, source],
    queryFn: () => codeAnalysisApi.irr(projectId, source ? { source } : undefined),
    enabled: !!projectId,
    staleTime: 5 * 60_000, // IRR is O(units×codes), uncached server-side, rarely changes
    refetchOnWindowFocus: false,
  })

  const colorMap = useMemo(
    () => new Map((codes ?? []).map(c => [c.id, c.color])),
    [codes],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-mm-text-muted py-16 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        <span>Computing reliability…</span>
      </div>
    )
  }

  if (!data?.available) {
    return (
      <div className="text-center py-16">
        <p className="text-mm-text-muted">{data?.reason || 'Reliability is unavailable for this project.'}</p>
      </div>
    )
  }

  const showKappa = data.metric_label === 'kappa+alpha'
  const metricName = showKappa ? "Cohen's κ + Krippendorff's α" : "Krippendorff's α"
  // #35 — the stated facet, read off the payload. `null` for a payload that
  // predates the field, which renders exactly as it used to.
  const facetQualifier = reliabilityFacetQualifier(data.reliability_facet)
  const facetSentence = describeReliabilityFacet(data.reliability_facet)
  // #35 — one row per code that declares a rating scale. Absent on older
  // payloads and on projects with no scaled code; the section renders only
  // when there is something to say.
  const ratings = data.magnitude_per_code ?? []
  const ratingMetric = ratings[0]?.alpha_metric
  const categoricalMetric = data.per_code[0]?.alpha_metric
  const unratedApplications = ratings.reduce((n, r) => n + (r.n_applications - r.n_rated), 0)
  const ratedCodeApplications = ratings.reduce((n, r) => n + r.n_applications, 0)
  const overallBand = data.overall_alpha_interpretation
  const SummaryIcon = overallBand === 'reliable' ? CircleCheck : overallBand === 'tentative' ? CircleAlert : CircleX
  // #473: α interpretation cutoffs — from the payload (single source of truth with
  // the backend), falling back to the documented Krippendorff constants if absent.
  const aTentative = data.interpretation_thresholds?.alpha?.tentative ?? ALPHA_FALLBACK.tentative
  const aReliable = data.interpretation_thresholds?.alpha?.reliable ?? ALPHA_FALLBACK.reliable

  // #43 — the headline's interval, and whether it settles the band it claims.
  // The cutoffs come from the payload (single-sourced with the backend, #473),
  // so this reads the same thresholds the band words above were derived from.
  const overallVisual = intervalVisualText(data.overall_alpha_ci)
  // Every distinct reason an interval was refused anywhere in this table, in
  // first-appearance order. Explained ONCE below the table: the same paragraph
  // repeated on ten rows is a paragraph nobody reads, and the reasons are
  // properties of the METHOD, not of the individual row.
  const refusalNotes = [...new Set(
    data.per_code
      .flatMap(c => [c.kappa_ci, c.alpha_ci])
      .concat(ratings.map(r => r.alpha_ci))
      .concat(data.overall_alpha_ci ? [data.overall_alpha_ci] : [])
      .map(ci => ciUnavailableNote(ci?.unavailable_reason))
      .filter((note): note is string => note != null),
  )]
  const overallStraddle = straddleNote(
    data.overall_alpha_ci,
    data.interpretation_thresholds?.alpha,
    bandWord,
  )

  const sources = data.sources ?? []
  const scoped = sources.find(x => x.key === data.source) ?? null
  // Grouped by kind so a picker over four different entity types reads as one
  // list rather than a flat jumble of names.
  const byKind = sources.reduce<Record<string, typeof sources>>((acc, x) => {
    (acc[x.kind] ??= []).push(x)
    return acc
  }, {})

  return (
    <div className="flex flex-col gap-3">
      {/* #829 — the source picker. Gated on >1 option: with a single shared
          source there is nothing to scope, and an inert control beside the
          tab's own scope selector is just two things to read. */}
      {sources.length > 1 && (
        <div className="flex items-center gap-2">
          <Select
            value={source ?? POOLED}
            onValueChange={(v) => setSource(v === POOLED ? null : v)}
          >
            <SelectTrigger className="w-[280px] h-8 text-xs" aria-label="Reliability source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={POOLED}>All sources — pooled</SelectItem>
              {Object.entries(KIND_LABEL).map(([kind, heading]) =>
                byKind[kind]?.length ? (
                  <SelectGroup key={kind}>
                    <SelectLabel>{heading}</SelectLabel>
                    {byKind[kind].map(x => (
                      <SelectItem key={x.key} value={x.key}>{x.label}</SelectItem>
                    ))}
                  </SelectGroup>
                ) : null,
              )}
            </SelectContent>
          </Select>
          <span className="text-xs text-mm-text-muted">
            {scoped
              ? `Agreement on ${scoped.label} alone`
              : `Pooled across ${sources.length} sources`}
          </span>
        </div>
      )}

      {/* Header strip: overall α summary + what's being measured + the roster. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="inline-flex items-center gap-1.5 text-sm font-medium">
          <SummaryIcon
            className={cn('w-4 h-4', overallBand ? BAND_CLASS[overallBand] : 'text-mm-text-muted')}
            aria-hidden="true"
          />
          <span>
            Overall α {fmt(data.overall_alpha, 2)}
            {overallBand && <span className="text-mm-text-muted font-normal"> · {bandWord(overallBand)}</span>}
            {overallVisual && (
              <span className="text-mm-text-muted font-normal">
                {' '}
                <span aria-hidden="true">{overallVisual}</span>
                <span className="sr-only">
                  {intervalAccessibleText(data.overall_alpha_ci, ciQualifier(data.overall_alpha_ci?.method))}
                </span>
              </span>
            )}
          </span>
        </div>
        <span className="text-xs text-mm-text-muted">
          {metricName}{facetQualifier ? ` ${facetQualifier}` : ''}
        </span>
        <span className="text-xs text-mm-text-muted">
          {data.n_coders} coders: {data.coders.map(c => c.name).join(', ')}
        </span>
      </div>

      {/* 🔴 #43's payload. The band word treats a cutoff as settled; when the
          interval spans one, the honest reading is that these data cannot tell
          those bands apart — which is the whole reason to report an interval on
          a reliability coefficient. Rendered as visible content, not a tooltip:
          it qualifies the largest number on the screen. */}
      {overallStraddle && (
        <p className="text-xs text-amber-700 dark:text-amber-400 max-w-prose">
          {overallStraddle}
        </p>
      )}

      {/* #473: surface the α interpretation cutoffs + citation so the band words in
          the table are self-explanatory. Dual-encoded — the band word carries the
          meaning, color only reinforces it (#409). */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-mm-text-muted">
        <span className="font-medium text-mm-text-faint">α bands:</span>
        <span><span className={BAND_CLASS.reliable}>reliable</span> ≥ {fmtThresh(aReliable)}</span>
        <span><span className={BAND_CLASS.tentative}>tentative</span> {fmtThresh(aTentative)}–{fmtThresh(aReliable)}</span>
        <span><span className={BAND_CLASS.unreliable}>unreliable</span> &lt; {fmtThresh(aTentative)}</span>
        <span className="text-mm-text-faint">Krippendorff (2004)</span>
      </p>

      <div className="overflow-x-auto rounded-md border border-mm-surface-border bg-mm-surface">
        <table className="w-full text-sm border-collapse">
          <caption className="sr-only">
            Inter-rater reliability per code: agreement metrics across {data.n_coders} coders.
          </caption>
          <thead>
            <tr className="border-b text-left text-mm-text-muted">
              <th scope="col" className="px-3 py-2 font-medium">Code</th>
              <th scope="col" className="px-3 py-2 font-medium text-right" title="Units with ≥2 coders present">Units</th>
              <th scope="col" className="px-3 py-2 font-medium text-right">% agreement</th>
              <th scope="col" className="px-3 py-2 font-medium text-right" title="Base rate: fraction of judged cells coded with this code. Extreme prevalence (near 0 or 1) deflates κ.">Prevalence</th>
              {showKappa && <th scope="col" className="px-3 py-2 font-medium text-right">Cohen's κ</th>}
              <th scope="col" className="px-3 py-2 font-medium text-right">Krippendorff's α</th>
            </tr>
          </thead>
          <tbody>
            {data.per_code.map(c => {
              const color = colorMap.get(c.code_id)
              return (
                <tr key={c.code_id} className="border-b last:border-b-0" aria-label={rowAriaLabel(c, showKappa, data.interpretation_thresholds)}>
                  <th scope="row" className="px-3 py-2 font-normal text-left text-mm-text">
                    <span className="inline-flex items-center gap-1.5">
                      {color && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />}
                      {c.code_name}
                    </span>
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums text-mm-text-muted">{c.n_units}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(c.percent_agreement)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-mm-text-muted">{fmt(c.prevalence)}</td>
                  {showKappa && (
                    <td className="px-3 py-2 text-right tabular-nums"><BandValue value={c.cohens_kappa} band={c.kappa_interpretation} reason={c.undefined_reason} ci={c.kappa_ci} thresholds={data.interpretation_thresholds?.kappa} /></td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums"><BandValue value={c.krippendorff_alpha} band={c.alpha_interpretation} reason={c.undefined_reason} ci={c.alpha_ci} thresholds={data.interpretation_thresholds?.alpha} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* #35 — rating agreement, a SECOND table rather than more columns on the
          first. The main table is at capacity at 640×360 (#43 put the interval
          INSIDE the α cell for that reason), and a rating α is a different
          coefficient over a different unit set — its own header, its own
          explainer, one α per scaled code and never a pooled headline. */}
      {ratings.length > 0 && (
        <section aria-labelledby="irr-rating-heading" className="flex flex-col gap-2 mt-2">
          <h3 id="irr-rating-heading" className="text-sm font-medium">Rating agreement</h3>
          <p className="text-xs text-mm-text-muted max-w-prose">
            For codes with a declared rating scale: do coders give the same rating? One α per
            code, over the units two or more coders both applied <em>and</em> rated — each code
            is its own instrument, so these are never pooled into the overall α above.
            {ratingMetric ? ` ${describeAlphaMetric(ratingMetric)}` : ''}
          </p>
          {unratedApplications > 0 && (
            // Coverage, said once. A coefficient over a quarter of the
            // applications prints just as confidently as one over all of them —
            // the reason the optional-rating variant was rejected in the design
            // round — so the gap is stated where the number is.
            <p className="text-xs text-amber-700 dark:text-amber-400 max-w-prose">
              {unratedApplications} of {ratedCodeApplications} applications of these codes carry no
              rating, so each α is over the rated units only. Rate the rest to make it a statement
              about all of the coding.
            </p>
          )}
          <div className="overflow-x-auto rounded-md border border-mm-surface-border bg-mm-surface">
            <table className="w-full text-sm border-collapse">
              <caption className="sr-only">
                Rating agreement per code with a declared scale, across {data.n_coders} coders.
              </caption>
              <thead>
                <tr className="border-b text-left text-mm-text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">Code</th>
                  <th scope="col" className="px-3 py-2 font-medium" title="The declared rating scale">Scale</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right" title="Units two or more coders both applied and rated">Units</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right" title="Applications carrying a rating, out of every application of this code in scope">Rated</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right" title="How far apart two coders' ratings are on average, in the scale's own units">Mean difference</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">
                    Krippendorff's α{ratingMetric ? ` (${alphaMetricLabel(ratingMetric)})` : ''}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ratings.map(r => {
                  const color = colorMap.get(r.code_id)
                  const anchors = anchorsText(r)
                  return (
                    <tr key={r.code_id} className="border-b last:border-b-0" aria-label={ratingRowAriaLabel(r, data.interpretation_thresholds?.alpha)}>
                      <th scope="row" className="px-3 py-2 font-normal text-left text-mm-text">
                        <span className="inline-flex items-center gap-1.5">
                          {color && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />}
                          {r.code_name}
                        </span>
                      </th>
                      <td className="px-3 py-2 tabular-nums text-mm-text-muted whitespace-nowrap" title={anchors || undefined}>
                        {scaleRangeText(r)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-mm-text-muted">{r.n_units}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-mm-text-muted whitespace-nowrap">
                        {/* "12/13" for the eye; a slash is read as "slash" or
                            swallowed, so the spoken form says "of". */}
                        <span aria-hidden="true">{r.n_rated}/{r.n_applications}</span>
                        <span className="sr-only">{r.n_rated} of {r.n_applications}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(r.mean_abs_difference)}</td>
                      <td className="px-3 py-2 text-right tabular-nums"><BandValue value={r.krippendorff_alpha} band={r.alpha_interpretation} reason={r.undefined_reason} ci={r.alpha_ci} thresholds={data.interpretation_thresholds?.alpha} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="text-xs text-mm-text-faint max-w-prose space-y-1.5">
        {/* #35 — the facet and the metric, as standing properties of the
            method: said once, as visible content, from the payload's own
            vocabulary (`reliability-basis.ts`), never re-typed here. */}
        {facetSentence && <p>{facetSentence}</p>}
        <p>
          Krippendorff's α = 1 − D<sub>o</sub>/D<sub>e</sub> (observed ÷ expected disagreement):
          1 is perfect agreement, 0 is chance. α is reported for any number of coders; Cohen's κ
          only when exactly two coders coded a shared source.
          {categoricalMetric ? ` ${describeAlphaMetric(categoricalMetric)}` : ''}
        </p>
        <p>
          κ can be low even when % agreement is high if a code is rare or near-universal
          (prevalence near 0 or 1) — read κ, % agreement, and prevalence together.
        </p>
        <p>
          All roster coders are listed. For each source, only coders who coded in it count toward
          that source's α; a coder who never coded a source is treated as not having judged it,
          not as a disagreement.
        </p>
        {/* #43 — how the intervals were made. Visible content rather than a
            per-cell tooltip: these are standing properties of the METHOD, so
            saying them once beats repeating them on twenty rows a reader would
            learn to skip — and a tooltip is unreachable from the keyboard.
            The sentences come from `ci-label.ts`, the same source the metric
            charts read, so the vocabulary is never re-typed here. */}
        <p>
          Intervals are {(data.overall_alpha_ci?.level ?? 0.95) * 100}% confidence intervals.
          {' '}α: {ciCaveat('alpha_bootstrap_units')}
          {data.overall_alpha_ci?.n_resamples
            ? ` Based on ${data.overall_alpha_ci.n_resamples.toLocaleString()} resamples, drawn from a fixed starting point so the same data always gives the same interval.`
            : ''}
        </p>
        {showKappa && <p>κ: {ciCaveat('kappa_analytic_se')}</p>}
        {refusalNotes.map(note => <p key={note}>{note}</p>)}
      </div>
    </div>
  )
}
