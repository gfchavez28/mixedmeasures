import { useMemo } from 'react'
import type { GroupStat } from '@/lib/api'
import { useChartColors } from '@/lib/theme-context'
import { mergeFormatting, resolveColorPalette, type ChartFormatting } from '@/lib/chart-data'
import { describeBoxBasis } from '@/lib/box-plot-basis'

/**
 * A box plot for the quantitative Comparisons panel (#522b).
 *
 * ## Why hand-drawn SVG rather than recharts
 *
 * recharts has no box-plot primitive, and every route to one is a composition
 * trick — a stacked invisible bar with `ErrorBar` whiskers, or a scatter with a
 * custom shape. the internal design notes's own rule is that framework gymnastics is a smell
 * that the approach is wrong, and a box plot is five straight lines and a rect:
 * drawing it directly is both shorter and exactly controllable. `CodebookTreeView`
 * is the existing precedent for a hand-drawn SVG chart in this codebase.
 *
 * ## Accessibility
 *
 * The SVG is `aria-hidden` and the accessible equivalent is the `sr-only` table
 * beside it — the pattern the Observations codeline already uses. A box plot's
 * content IS a five-number summary per group, so the table is not a lesser
 * substitute; it is the same information.
 *
 * ## What it does NOT do
 *
 * It does not invent numbers. Quartiles, whiskers and outliers all arrive from
 * the server (`GroupStat.box`), because the client never receives the raw values
 * — only the summary — so it could not compute them even if it wanted to. The
 * quartile method and whisker rule are printed beneath the chart rather than
 * assumed.
 */

export interface BoxPlotChartProps {
  groups: GroupStat[]
  /** Partial, merged with defaults — the sibling charts' convention. */
  formatting?: Partial<ChartFormatting>
  /** Axis label for the measured variable. */
  valueLabel?: string
  height?: number
}

const PAD = { top: 16, right: 16, bottom: 52, left: 56 }
/** Extra bottom room when group names have to be angled to fit. */
const ROTATED_PAD_BOTTOM = 96
/**
 * Rough advance width per character at a given font size. SVG has no cheap
 * synchronous text measurement, and a heuristic that errs toward rotating is the
 * right direction: an angled label is readable, an overlapping one is not.
 */
const CHAR_W = 0.58
const BOX_MAX_WIDTH = 64

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

export default function BoxPlotChart({
  groups, formatting: fmtProp, valueLabel, height = 360,
}: BoxPlotChartProps) {
  const colors = useChartColors()
  const formatting = mergeFormatting(fmtProp)
  const fill = resolveColorPalette(formatting.colorPalette)[0] ?? '#3b82f6'

  // Only groups the server gave a box for. An empty group has none, by design —
  // the same reason `mean` is null there (#689): there is nobody to summarise.
  const drawable = useMemo(() => groups.filter(g => g.box != null), [groups])

  const domain = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const g of drawable) {
      const b = g.box!
      for (const v of [b.whisker_low, b.whisker_high, b.min, b.max, ...b.outliers]) {
        if (v == null || !Number.isFinite(v)) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
    if (lo === hi) { lo -= 0.5; hi += 0.5 }      // a flat group still needs an axis
    const pad = (hi - lo) * 0.06
    return { lo: lo - pad, hi: hi + pad }
  }, [drawable])

  const basis = drawable[0]?.box ?? null

  if (drawable.length === 0 || !domain) {
    return (
      <p className="text-sm text-mm-text-muted py-8 text-center" role="status">
        No group has enough data to draw a box.
      </p>
    )
  }

  const width = 640
  const plotW = width - PAD.left - PAD.right
  const band = plotW / drawable.length
  // #522b — measured live at 9 groups: "Maple RidgeRoosevelt Washington" ran
  // together as one string. Angle the names when they cannot fit their band,
  // and fold n into the same line so there is only one thing to angle.
  const labelFor = (g: GroupStat) => `${g.group} (n=${g.n})`
  const widest = Math.max(...drawable.map(g => labelFor(g).length))
  const rotate = widest * formatting.labelFontSize * CHAR_W > band * 0.95
  const padBottom = rotate ? ROTATED_PAD_BOTTOM : PAD.bottom
  const plotH = height - PAD.top - padBottom
  const boxW = Math.min(BOX_MAX_WIDTH, band * 0.55)
  const y = (v: number) => PAD.top + plotH - ((v - domain.lo) / (domain.hi - domain.lo)) * plotH
  const ticks = niceTicks(domain.lo, domain.hi)

  const omitted = drawable.reduce((s, g) => s + (g.box!.outliers_omitted ?? 0), 0)

  return (
    <figure className="w-full">
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: height }}
      >
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={colors.grid} />
            <text
              x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle"
              fontSize={formatting.axisFontSize} fill={colors.text}
            >{fmtNum(t)}</text>
          </g>
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke={colors.axis} />

        {drawable.map((g, i) => {
          const b = g.box!
          const cx = PAD.left + band * i + band / 2
          const q1 = b.q1, q3 = b.q3, med = b.median
          const wl = b.whisker_low, wh = b.whisker_high
          if (q1 == null || q3 == null || med == null) return null
          const top = y(Math.max(q1, q3))
          const boxH = Math.max(1, Math.abs(y(q1) - y(q3)))
          return (
            <g key={g.group}>
              {wl != null && wh != null && (
                <>
                  <line x1={cx} x2={cx} y1={y(wh)} y2={y(q3)} stroke={colors.axis} />
                  <line x1={cx} x2={cx} y1={y(q1)} y2={y(wl)} stroke={colors.axis} />
                  <line x1={cx - boxW / 4} x2={cx + boxW / 4} y1={y(wh)} y2={y(wh)} stroke={colors.axis} />
                  <line x1={cx - boxW / 4} x2={cx + boxW / 4} y1={y(wl)} y2={y(wl)} stroke={colors.axis} />
                </>
              )}
              <rect
                x={cx - boxW / 2} y={top} width={boxW} height={boxH}
                fill={fill} fillOpacity={0.35} stroke={fill} strokeWidth={1.5}
              />
              {/* The median is the one line a reader looks for — it must not be
                  the same weight as the box outline. */}
              <line
                x1={cx - boxW / 2} x2={cx + boxW / 2} y1={y(med)} y2={y(med)}
                stroke={fill} strokeWidth={3}
              />
              {b.outliers.map((o, k) => (
                <circle key={k} cx={cx} cy={y(o)} r={2.5} fill="none" stroke={colors.textMuted} />
              ))}
              {rotate ? (
                <text
                  x={cx} y={PAD.top + plotH + 14}
                  textAnchor="end" transform={`rotate(-35 ${cx} ${PAD.top + plotH + 14})`}
                  fontSize={formatting.labelFontSize} fill={colors.text}
                >{labelFor(g)}</text>
              ) : (
                <>
                  <text
                    x={cx} y={PAD.top + plotH + 16} textAnchor="middle"
                    fontSize={formatting.labelFontSize} fill={colors.text}
                  >{g.group}</text>
                  <text
                    x={cx} y={PAD.top + plotH + 32} textAnchor="middle"
                    fontSize={Math.max(9, formatting.labelFontSize - 2)} fill={colors.textMuted}
                  >n = {g.n}</text>
                </>
              )}
            </g>
          )
        })}
      </svg>

      {/* The accessible equivalent — the same five numbers the shapes encode. */}
      <table className="sr-only">
        <caption>
          Box plot{valueLabel ? ` of ${valueLabel}` : ''} by group — five-number summary.
        </caption>
        <thead>
          <tr>
            <th scope="col">Group</th><th scope="col">n</th>
            <th scope="col">Minimum</th><th scope="col">Lower quartile</th>
            <th scope="col">Median</th><th scope="col">Upper quartile</th>
            <th scope="col">Maximum</th><th scope="col">Outliers</th>
          </tr>
        </thead>
        <tbody>
          {drawable.map(g => {
            const b = g.box!
            return (
              <tr key={g.group}>
                <th scope="row">{g.group}</th>
                <td>{g.n}</td>
                <td>{b.min ?? '—'}</td><td>{b.q1 ?? '—'}</td>
                <td>{b.median ?? '—'}</td><td>{b.q3 ?? '—'}</td>
                <td>{b.max ?? '—'}</td>
                <td>{b.outliers.length + (b.outliers_omitted ?? 0)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <figcaption className="text-xs text-mm-text-faint mt-1">
        {describeBoxBasis(basis)}
        {omitted > 0 && ` ${omitted} further outlier${omitted === 1 ? '' : 's'} not plotted.`}
      </figcaption>
    </figure>
  )
}
