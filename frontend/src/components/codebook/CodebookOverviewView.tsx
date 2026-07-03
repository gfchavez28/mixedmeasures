import { useEffect, useMemo, useRef, useState } from 'react'
import type { CodebookTreeResponse } from '@/lib/api'
import type { CodebookSizing } from '@/hooks/useCodebookState'
import { getContrastColor } from '@/lib/utils'
import {
  buildOverviewModel, layoutTreemap, type OverviewMeasure, type OverviewNode,
} from '@/lib/codebook-overview'

/**
 * #438 — read-only Codebook **Overview**: a squarified treemap of the codebook,
 * tile area = the toolbar "Size by" measure, color = category. Reuses the SAME
 * `filteredTreeData` the Tree renders (counts are inherently consistent). Tree
 * stays the editable structural view; this is proportion-at-a-glance only.
 */
interface Props {
  treeData: CodebookTreeResponse
  sizing: CodebookSizing
  selection: string | null
  onSelect: (sel: string | null) => void
  announce?: (msg: string) => void
}

const MEASURE: Record<CodebookSizing, OverviewMeasure> = { uniform: 'equal', seg: 'segments', src: 'sources' }
const MEASURE_LABEL: Record<OverviewMeasure, string> = { segments: 'segments', sources: 'sources', equal: 'codes (equal size)' }

const HEADER_H = 18
const PAD = 2

/** Approx label fit: bigger `px` → fewer chars before the ellipsis. */
function truncate(text: string, width: number, px = 6.6): string {
  const max = Math.floor((width - 8) / px)
  if (max <= 1) return ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * Readable label paint for a colored tile: a contrast-picked fill PLUS an
 * opposite-tone halo (drawn behind the glyphs via paint-order:stroke). The halo
 * keeps small labels legible on every palette hue — including the mid-tones
 * where plain dark text was too low-contrast (#438 polish) — in light and dark
 * mode alike (the tile colors are deliberately theme-independent).
 */
function paintFor(bg: string): { fill: string; halo: string } {
  const fill = getContrastColor(bg)
  return fill === '#ffffff'
    ? { fill, halo: 'rgba(0,0,0,0.42)' }
    : { fill, halo: 'rgba(255,255,255,0.72)' }
}

const HALO_STYLE = { paintOrder: 'stroke', strokeLinejoin: 'round', pointerEvents: 'none' } as const

export default function CodebookOverviewView({ treeData, sizing, selection, onSelect, announce }: Props) {
  const measure = MEASURE[sizing]
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect
      setSize({ w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const model = useMemo(() => buildOverviewModel(treeData, measure), [treeData, measure])

  // Lay out into the measured box (recomputed when data/measure/size change).
  const laidOut = useMemo(() => {
    if (size.w < 8 || size.h < 8) return null
    layoutTreemap(model.root, { x: 0, y: 0, w: size.w, h: size.h }, { headerH: HEADER_H, pad: PAD })
    return model.root
  }, [model, size])

  // Announce a summary for screen readers on (re)build.
  useEffect(() => {
    if (!announce) return
    announce(`Codebook overview: ${model.codeCount} codes shown by ${MEASURE_LABEL[measure]}` +
      (measure !== 'equal' && model.unusedCount > 0 ? `, ${model.unusedCount} unused codes not shown` : ''))
  }, [model, measure, announce])

  const tiles: OverviewNode[] = useMemo(() => {
    const out: OverviewNode[] = []
    const walk = (n: OverviewNode) => { if (n.kind === 'code') out.push(n); n.children?.forEach(walk) }
    if (laidOut) walk(laidOut)
    return out
  }, [laidOut])

  const cats: OverviewNode[] = useMemo(() => {
    const out: OverviewNode[] = []
    const walk = (n: OverviewNode) => { if (n.kind === 'category') out.push(n); n.children?.forEach(walk) }
    if (laidOut) walk(laidOut)
    return out
  }, [laidOut])

  const caption = measure === 'equal'
    ? `All ${model.codeCount} codes, equal size (structure).`
    : `${model.codeCount} coded codes by ${MEASURE_LABEL[measure]}.` +
      (model.unusedCount > 0 ? ` ${model.unusedCount} unused code${model.unusedCount === 1 ? '' : 's'} (0 ${measure}) not shown — see the Tree.` : '')

  const empty = model.root.children == null || model.root.children.length === 0

  return (
    <div className="h-full flex flex-col bg-mm-surface rounded-lg border border-mm-border-subtle overflow-hidden">
      <div className="shrink-0 px-3 py-1.5 text-[11px] text-mm-text-muted border-b border-mm-border-subtle bg-mm-blue/[0.06]">
        <span className="font-medium text-mm-text-secondary">Overview</span> — {caption} Click a tile to inspect.
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 relative">
        {empty ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <p className="text-sm text-mm-text-secondary max-w-xs">
              No coded codes to show in this view.{model.unusedCount > 0 && ` ${model.unusedCount} code${model.unusedCount === 1 ? ' is' : 's are'} unused — switch “Size by” to Equal, or use the Tree, to see the full structure.`}
            </p>
          </div>
        ) : laidOut && (
          <svg
            width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}
            role="group"
            aria-label={`Codebook overview treemap — ${model.codeCount} codes by ${MEASURE_LABEL[measure]}`}
          >
            {/* category borders + header bands */}
            {cats.map(cat => {
              const r = cat.rect!
              if (r.w < 6 || r.h < 6) return null
              const headLabel = truncate(cat.name, r.w - 4, 6.8)
              const p = paintFor(cat.color)
              return (
                <g key={cat.key} aria-hidden="true">
                  {/* faint category-color body so any empty trailing grid cell reads
                      as part of the group rather than a hole */}
                  <rect x={r.x} y={r.y + HEADER_H} width={Math.max(0, r.w)} height={Math.max(0, r.h - HEADER_H)}
                    fill={cat.color} opacity={0.12} />
                  <rect x={r.x + 0.5} y={r.y + 0.5} width={Math.max(0, r.w - 1)} height={Math.max(0, r.h - 1)}
                    fill="none" style={{ stroke: 'hsl(var(--mm-surface))' }} strokeWidth={2} rx={4} />
                  <rect x={r.x} y={r.y} width={r.w} height={Math.min(HEADER_H, r.h)} fill={cat.color} rx={4} opacity={0.95} />
                  {r.w > 36 && (
                    <text x={r.x + 6} y={r.y + 13} fontSize={12} fontWeight={700}
                      fill={p.fill} stroke={p.halo} strokeWidth={3} style={HALO_STYLE}>{headLabel}</text>
                  )}
                </g>
              )
            })}

            {/* code tiles */}
            {tiles.map(tile => {
              const r = tile.rect!
              if (r.w <= 0 || r.h <= 0) return null
              // Single-selection uses the colon form `code:<id>` (matches the Tree
              // + the peek panel); the dash form `code-<id>` is the multi-select key.
              const selValue = `code:${tile.code!.id}`
              const isSel = selection === selValue
              const p = paintFor(tile.color)
              const seg = tile.code?.segment_count ?? 0
              const src = tile.code?.source_count ?? 0
              const showName = r.h >= 16 && r.w >= 36
              const showSub = r.h >= 32 && r.w >= 44
              return (
                <g key={tile.key}
                  role="button" tabIndex={0}
                  aria-label={`${tile.name}: ${seg} segment${seg === 1 ? '' : 's'}, ${src} source${src === 1 ? '' : 's'}`}
                  aria-pressed={isSel}
                  onClick={() => onSelect(isSel ? null : selValue)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(isSel ? null : selValue) } }}
                  style={{ cursor: 'pointer' }}
                >
                  <title>{`${tile.name} — ${seg} seg · ${src} src`}</title>
                  <rect x={r.x + 0.5} y={r.y + 0.5} width={Math.max(0, r.w - 1)} height={Math.max(0, r.h - 1)}
                    fill={tile.color} style={{ stroke: 'hsl(var(--mm-surface))' }} strokeWidth={1} rx={3} />
                  {isSel && (
                    <rect x={r.x + 1.5} y={r.y + 1.5} width={Math.max(0, r.w - 3)} height={Math.max(0, r.h - 3)}
                      fill="none" style={{ stroke: 'hsl(var(--mm-blue))' }} strokeWidth={2.5} rx={3} />
                  )}
                  {showName && (
                    <text x={r.x + 6} y={r.y + 14} fontSize={12} fontWeight={600}
                      fill={p.fill} stroke={p.halo} strokeWidth={3} style={HALO_STYLE}>
                      {truncate(tile.name, r.w)}
                    </text>
                  )}
                  {showSub && (
                    <text x={r.x + 6} y={r.y + 28} fontSize={10} opacity={0.92}
                      fill={p.fill} stroke={p.halo} strokeWidth={2.5} style={HALO_STYLE}>
                      {measure === 'sources' ? `${src} src` : `${seg} seg`}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
      </div>

      {/* Screen-reader data table — the treemap itself isn't SR-navigable.
          Wrapped in a `sr-only` <div>, NOT applied to the <table>: `sr-only` on
          a table element leaks its <caption> visibly in some browsers (the table
          box isn't clipped); a block wrapper clips its contents reliably. */}
      <div className="sr-only">
        <table>
          <caption>Codebook overview — codes by {MEASURE_LABEL[measure]}</caption>
          <thead><tr><th>Code</th><th>Category</th><th>Segments</th><th>Sources</th></tr></thead>
          <tbody>
            {cats.flatMap(cat => (cat.children ?? []).filter(c => c.kind === 'code').map(c => (
              <tr key={c.key}>
                <td>{c.name}</td><td>{cat.name}</td>
                <td>{c.code?.segment_count ?? 0}</td><td>{c.code?.source_count ?? 0}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
