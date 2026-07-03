import { useCallback, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ScatterPair } from '@/lib/api'
import { jitterOffset, formatPValue } from '@/lib/chart-data'
import { useFocusTrap } from '@/hooks/useFocusTrap'

interface ScatterPlotModalProps {
  pair: ScatterPair
  showRegLine: boolean
  showJitter: boolean
  onClose: () => void
}

export default function ScatterPlotModal({
  pair,
  showRegLine,
  showJitter,
  onClose,
}: ScatterPlotModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Focus trap: Tab wraps within modal, Escape closes, restore focus on unmount
  useFocusTrap(panelRef, onClose)

  // Auto-focus panel on mount
  useEffect(() => { requestAnimationFrame(() => panelRef.current?.focus()) }, [])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const size = 500
  const padding = 50
  const inner = size - padding * 2

  const xMin = Math.min(...pair.x)
  const xMax = Math.max(...pair.x)
  const yMin = Math.min(...pair.y)
  const yMax = Math.max(...pair.y)
  const xRange = xMax - xMin || 1
  const yRange = yMax - yMin || 1

  const scaleX = (v: number) => padding + ((v - xMin) / xRange) * inner
  const scaleY = (v: number) => size - padding - ((v - yMin) / yRange) * inner

  // Axis ticks
  const xTicks = generateTicks(xMin, xMax, 5)
  const yTicks = generateTicks(yMin, yMax, 5)

  const reg = pair.regression

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={`Scatter plot: ${pair.x_label} vs ${pair.y_label}`}
    >
      <div ref={panelRef} tabIndex={-1} className="bg-mm-surface rounded-lg shadow-lg border border-mm-surface-border p-6 max-w-[580px] outline-none">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-mm-text">{pair.x_label} vs {pair.y_label}</h3>
            <p className="text-xs text-mm-text-muted mt-0.5">
              n = {pair.n}
              {showRegLine && pair.n >= 3 && (
                <> &middot; r = {reg.r.toFixed(3)}, R&sup2; = {reg.r_squared.toFixed(3)}, {formatPValue(reg.p)}</>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-mm-surface-hover text-mm-text-muted"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* SVG scatter plot */}
        <svg width={size} height={size} className="block">
          {/* Background */}
          <rect width={size} height={size} className="fill-mm-bg" rx={4} />

          {/* Grid lines */}
          {xTicks.map(t => (
            <line key={`xg-${t}`} x1={scaleX(t)} y1={padding} x2={scaleX(t)} y2={size - padding} className="stroke-mm-border-subtle" strokeWidth={0.5} />
          ))}
          {yTicks.map(t => (
            <line key={`yg-${t}`} x1={padding} y1={scaleY(t)} x2={size - padding} y2={scaleY(t)} className="stroke-mm-border-subtle" strokeWidth={0.5} />
          ))}

          {/* Axes */}
          <line x1={padding} y1={size - padding} x2={size - padding} y2={size - padding} className="stroke-mm-text-faint" strokeWidth={1} />
          <line x1={padding} y1={padding} x2={padding} y2={size - padding} className="stroke-mm-text-faint" strokeWidth={1} />

          {/* X ticks */}
          {xTicks.map(t => (
            <g key={`xt-${t}`}>
              <line x1={scaleX(t)} y1={size - padding} x2={scaleX(t)} y2={size - padding + 4} className="stroke-mm-text-faint" />
              <text x={scaleX(t)} y={size - padding + 16} textAnchor="middle" className="fill-mm-text-muted" fontSize={10}>{formatTick(t)}</text>
            </g>
          ))}

          {/* Y ticks */}
          {yTicks.map(t => (
            <g key={`yt-${t}`}>
              <line x1={padding - 4} y1={scaleY(t)} x2={padding} y2={scaleY(t)} className="stroke-mm-text-faint" />
              <text x={padding - 8} y={scaleY(t) + 3} textAnchor="end" className="fill-mm-text-muted" fontSize={10}>{formatTick(t)}</text>
            </g>
          ))}

          {/* Axis labels */}
          <text x={size / 2} y={size - 6} textAnchor="middle" className="fill-mm-text-secondary" fontSize={11}>{truncLabel(pair.x_label, 50)}</text>
          <text x={14} y={size / 2} textAnchor="middle" className="fill-mm-text-secondary" fontSize={11} transform={`rotate(-90, 14, ${size / 2})`}>{truncLabel(pair.y_label, 50)}</text>

          {/* Regression line */}
          {showRegLine && pair.n >= 3 && (
            <line
              x1={scaleX(xMin)}
              y1={scaleY(reg.intercept + reg.slope * xMin)}
              x2={scaleX(xMax)}
              y2={scaleY(reg.intercept + reg.slope * xMax)}
              className="stroke-mm-text"
              strokeWidth={1.5}
              strokeDasharray="6,3"
              opacity={0.5}
            />
          )}

          {/* Data points */}
          {pair.x.map((xVal, i) => {
            const jx = showJitter ? jitterOffset(pair.record_ids[i]) * (xRange * 0.1) : 0
            const jy = showJitter ? jitterOffset(pair.record_ids[i] * 7) * (yRange * 0.1) : 0
            return (
              <circle
                key={i}
                cx={scaleX(xVal + jx)}
                cy={scaleY(pair.y[i] + jy)}
                r={3.5}
                className="fill-[hsl(var(--mm-accent))]"
                opacity={0.65}
              />
            )
          })}

          {/* Regression equation */}
          {showRegLine && pair.n >= 3 && (
            <text x={size - padding - 4} y={padding + 14} textAnchor="end" className="fill-mm-text-muted" fontSize={10} fontFamily="var(--font-mono, monospace)">
              y = {reg.slope.toFixed(2)}x {reg.intercept >= 0 ? '+' : '\u2212'} {Math.abs(reg.intercept).toFixed(2)}
            </text>
          )}
        </svg>
      </div>
    </div>
  )
}

function generateTicks(min: number, max: number, count: number): number[] {
  const range = max - min
  if (range === 0) return [min]
  const step = niceStep(range / count)
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6)
  }
  return ticks
}

function niceStep(rough: number): number {
  const exp = Math.floor(Math.log10(rough))
  const frac = rough / Math.pow(10, exp)
  let nice: number
  if (frac <= 1.5) nice = 1
  else if (frac <= 3.5) nice = 2
  else if (frac <= 7.5) nice = 5
  else nice = 10
  return nice * Math.pow(10, exp)
}

function formatTick(v: number): string {
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(1)
}

function truncLabel(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s
}
