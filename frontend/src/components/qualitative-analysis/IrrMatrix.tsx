import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleAlert, CircleX, Loader2 } from 'lucide-react'
import { codeAnalysisApi, type Code, type IrrCodeResult } from '@/lib/api'
import { cn } from '@/lib/utils'

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

/** "κ=0.72 substantial" / "κ not computable" — null-safe phrase for the aria-label. */
function metricPhrase(label: string, value: number | null, band: string | null): string {
  if (value == null) return `${label} not computable`
  const w = bandWord(band)
  return `${label}=${value.toFixed(2)}${w ? ` ${w}` : ''}`
}

function rowAriaLabel(c: IrrCodeResult, showKappa: boolean): string {
  const parts = [`${c.code_name}:`]
  if (showKappa) parts.push(`${metricPhrase('κ', c.cohens_kappa, c.kappa_interpretation)};`)
  parts.push(`${metricPhrase('α', c.krippendorff_alpha, c.alpha_interpretation)};`)
  parts.push(`${fmtPct(c.percent_agreement)} agreement;`)
  parts.push(`prevalence ${fmt(c.prevalence)}`)
  return parts.join(' ')
}

/** A value + its band word, band-colored (dual-encoded). */
function BandValue({ value, band }: { value: number | null; band: string | null }) {
  if (value == null) return <span className="text-mm-text-faint">—</span>
  return (
    <span className={cn('font-medium', band ? BAND_CLASS[band] : undefined)}>
      {value.toFixed(2)}
      {/* sr-only space so the cell's accessible text reads "0.00 unreliable", not
          "0.00unreliable" — ml-1 is visual-only margin and adds no spoken separator (#445). */}
      {band && <><span className="sr-only"> </span><span className="ml-1 text-xs font-normal text-mm-text-muted">{bandWord(band)}</span></>}
    </span>
  )
}

export default function IrrMatrix({ projectId, codes }: IrrMatrixProps) {
  // IRR is ALWAYS all-roster — never pass coder_ids (the CoderFilterPopover is a
  // visibility filter, not a "compare these raters" selector). See the build scope.
  const { data, isLoading } = useQuery({
    queryKey: ['irr', projectId, null],
    queryFn: () => codeAnalysisApi.irr(projectId),
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
  const overallBand = data.overall_alpha_interpretation
  const SummaryIcon = overallBand === 'reliable' ? CircleCheck : overallBand === 'tentative' ? CircleAlert : CircleX
  // #473: α interpretation cutoffs — from the payload (single source of truth with
  // the backend), falling back to the documented Krippendorff constants if absent.
  const aTentative = data.interpretation_thresholds?.alpha?.tentative ?? ALPHA_FALLBACK.tentative
  const aReliable = data.interpretation_thresholds?.alpha?.reliable ?? ALPHA_FALLBACK.reliable

  return (
    <div className="flex flex-col gap-3">
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
          </span>
        </div>
        <span className="text-xs text-mm-text-muted">{metricName}</span>
        <span className="text-xs text-mm-text-muted">
          {data.n_coders} coders: {data.coders.map(c => c.name).join(', ')}
        </span>
      </div>

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
                <tr key={c.code_id} className="border-b last:border-b-0" aria-label={rowAriaLabel(c, showKappa)}>
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
                    <td className="px-3 py-2 text-right tabular-nums"><BandValue value={c.cohens_kappa} band={c.kappa_interpretation} /></td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums"><BandValue value={c.krippendorff_alpha} band={c.alpha_interpretation} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-mm-text-faint max-w-prose space-y-1.5">
        <p>
          Krippendorff's α = 1 − D<sub>o</sub>/D<sub>e</sub> (observed ÷ expected disagreement):
          1 is perfect agreement, 0 is chance. α is reported for any number of coders; Cohen's κ
          only when exactly two coders coded a shared source.
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
      </div>
    </div>
  )
}
