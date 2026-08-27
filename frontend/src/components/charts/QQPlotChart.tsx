import { useMemo } from 'react'
import type { QQSummary } from '@/lib/api'
import { useChartColors } from '@/lib/theme-context'
import { mergeFormatting, resolveColorPalette, type ChartFormatting } from '@/lib/chart-data'
import { undefinedTooltip } from '@/lib/stat-format'
import { describeQQBasis, qqAccessibleSummary } from '@/lib/qq-basis'

/**
 * A normal Q–Q plot of the model residuals, for the Comparisons panel (#525b).
 *
 * ## Why hand-drawn SVG
 *
 * Same reasoning as `BoxPlotChart`, which is the precedent this follows: a
 * scatter against a straight line is a handful of primitives, and recharts'
 * route to one is a composition trick. the internal design notes's rule is that framework
 * gymnastics signals the wrong approach.
 *
 * ## Accessibility — a table would NOT be the equivalent here
 *
 * `BoxPlotChart` pairs its `aria-hidden` SVG with an `sr-only` TABLE, and that
 * works because a box plot's content IS five numbers per group. A Q–Q plot's
 * content is the shape of a cloud of up to 500 points; a 500-row table is an
 * obstacle rather than an equivalent. The accessible equivalent is the numeric
 * summary — `ppcc`, the correlation between the residuals and their theoretical
 * quantiles, which is exactly "how straight is this line" as a number — plus
 * anything that structurally distorts the picture. `lib/qq-basis.ts` owns that
 * wording so the chart and its caption cannot drift apart.
 *
 * ## What it does NOT do
 *
 * It computes nothing. Points, the reference line and `ppcc` all arrive from
 * the server: the client never receives the raw values, and the plotting
 * positions are sample-size-dependent (R switches convention at n > 10), so a
 * client-side derivation would silently disagree with the tool's own numbers.
 * ⛔ It also does not render a verdict — #525(c) refused a recommendation
 * engine, and this chart exists precisely because it has no threshold to
 * misread.
 */

export interface QQPlotChartProps {
  qq: QQSummary | null | undefined
  formatting?: Partial<ChartFormatting>
  /** The measured variable, for the caption and the accessible summary. */
  valueLabel?: string
  height?: number
}

const PAD = { top: 16, right: 16, bottom: 44, left: 60 }

function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const scaled = raw / mag
  const step = (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * mag
  const first = Math.ceil(lo / step) * step
  const out: number[] = []
  for (let v = first; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

const fmtNum = (v: number): string => String(Math.round(v * 1000) / 1000)

export default function QQPlotChart({
  qq, formatting: fmtProp, valueLabel, height = 340,
}: QQPlotChartProps) {
  const colors = useChartColors()
  const formatting = mergeFormatting(fmtProp)
  const fill = resolveColorPalette(formatting.colorPalette)[0] ?? '#3b82f6'

  const domain = useMemo(() => {
    if (!qq || qq.points.length === 0) return null
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity
    for (const p of qq.points) {
      if (p.theoretical < xlo) xlo = p.theoretical
      if (p.theoretical > xhi) xhi = p.theoretical
      if (p.sample < ylo) ylo = p.sample
      if (p.sample > yhi) yhi = p.sample
    }
    // The reference line's endpoints must be inside the drawn area, or the line
    // that the points are judged against gets clipped exactly where a departure
    // would show.
    if (qq.line_slope != null && qq.line_intercept != null) {
      for (const x of [xlo, xhi]) {
        const y = qq.line_slope * x + qq.line_intercept
        if (y < ylo) ylo = y
        if (y > yhi) yhi = y
      }
    }
    if (!Number.isFinite(xlo) || !Number.isFinite(ylo)) return null
    // A zero-width/height domain would divide by zero in the scale below.
    if (yhi === ylo) { ylo -= 0.5; yhi += 0.5 }
    if (xhi === xlo) { xlo -= 0.5; xhi += 0.5 }

    // Breathing room on BOTH axes. Without it the extreme order statistics —
    // the tails, which are the whole point of the figure — are drawn flush
    // against the frame and read as clipped. Padded before the line's y-extent
    // is taken, so the reference line still spans the drawn width exactly.
    const padX = (xhi - xlo) * 0.04
    xlo -= padX; xhi += padX
    if (qq.line_slope != null && qq.line_intercept != null) {
      for (const x of [xlo, xhi]) {
        const y = qq.line_slope * x + qq.line_intercept
        if (y < ylo) ylo = y
        if (y > yhi) yhi = y
      }
    }
    const padY = (yhi - ylo) * 0.06
    return { xlo, xhi, ylo: ylo - padY, yhi: yhi + padY }
  }, [qq])

  if (!qq || qq.undefined_reason || !domain) {
    return (
      <div
        className="flex items-center justify-center text-xs text-mm-text-faint py-12"
        title={undefinedTooltip(qq?.undefined_reason)}
      >
        No Q–Q plot: not enough variation in the residuals to draw one.
      </div>
    )
  }

  const width = 720
  const plotW = width - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const x = (v: number) => PAD.left + ((v - domain.xlo) / (domain.xhi - domain.xlo)) * plotW
  const y = (v: number) => PAD.top + plotH - ((v - domain.ylo) / (domain.yhi - domain.ylo)) * plotH

  const yTicks = niceTicks(domain.ylo, domain.yhi)
  const xTicks = niceTicks(domain.xlo, domain.xhi)
  const summary = qqAccessibleSummary(qq)

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: height }}
        aria-hidden="true"
      >
        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line
              x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)}
              stroke={colors.grid} strokeWidth={1}
            />
            <text
              x={PAD.left - 8} y={y(t) + 4} textAnchor="end"
              fontSize={formatting.labelFontSize} fill={colors.textMuted}
            >{fmtNum(t)}</text>
          </g>
        ))}
        {xTicks.map(t => (
          <text
            key={`x${t}`} x={x(t)} y={PAD.top + plotH + 18} textAnchor="middle"
            fontSize={formatting.labelFontSize} fill={colors.textMuted}
          >{fmtNum(t)}</text>
        ))}

        {/* The reference line is drawn UNDER the points: it is what they are
            being compared against, not a series in its own right. */}
        {qq.line_slope != null && qq.line_intercept != null && (
          <line
            x1={x(domain.xlo)} y1={y(qq.line_slope * domain.xlo + qq.line_intercept)}
            x2={x(domain.xhi)} y2={y(qq.line_slope * domain.xhi + qq.line_intercept)}
            stroke={colors.reference} strokeWidth={1.5} strokeDasharray="4 3"
          />
        )}

        {qq.points.map((p, i) => (
          <circle
            key={i} cx={x(p.theoretical)} cy={y(p.sample)} r={2.4}
            fill={fill} fillOpacity={0.55} stroke={fill} strokeWidth={0.75}
          />
        ))}

        <text
          x={PAD.left + plotW / 2} y={height - 6} textAnchor="middle"
          fontSize={formatting.labelFontSize} fill={colors.text}
        >Theoretical normal quantiles</text>
        <text
          x={12} y={PAD.top + plotH / 2} textAnchor="middle"
          transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}
          fontSize={formatting.labelFontSize} fill={colors.text}
        >Residual</text>
      </svg>

      {/* The accessible equivalent. Deliberately a SUMMARY, not a coordinate
          table — see the component docstring. */}
      <p className="sr-only">
        {valueLabel ? `${valueLabel}. ` : ''}{summary}
      </p>

      <figcaption className="text-xs text-mm-text-faint mt-1">
        {qq.ppcc != null && (
          <span className="mr-2">
            Straightness (probability-plot correlation): {qq.ppcc.toFixed(4)}
          </span>
        )}
        {describeQQBasis(qq)}
        {' '}Residuals are each value minus its own group&rsquo;s mean, so this describes
        the comparison as a whole rather than any one group.
        {qq.points_omitted > 0 && ` ${qq.points_omitted} intermediate point${qq.points_omitted === 1 ? '' : 's'} not plotted (the extremes are always kept).`}
        {qq.singleton_group_count > 0 && ` ${qq.singleton_group_count} group${qq.singleton_group_count === 1 ? '' : 's'} of one contribute${qq.singleton_group_count === 1 ? 's a residual' : ' residuals'} of exactly zero by construction.`}
      </figcaption>
    </figure>
  )
}
