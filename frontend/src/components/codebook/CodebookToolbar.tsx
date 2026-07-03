import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Search, EyeOff, X, Plus, FileOutput, FileInput, BookOpen, SlidersHorizontal, ArrowUpRight } from 'lucide-react'
import type { CodebookState } from '@/hooks/useCodebookState'
import type { CodebookTreeResponse } from '@/lib/api'
import type { Diagnostics } from '@/lib/codebook-utils'
import SegmentedControl from '@/components/ui/segmented-control'
import FreezeCodebookButton from '@/components/codebook/FreezeCodebookButton'

// ── Constants ────────────────────────────────────────────────────────────────

const MODE_OPTIONS = [
  { value: 'tree' as const, label: 'Tree' },
  { value: 'overview' as const, label: 'Overview' },
]

const SIZING_OPTIONS = [
  { value: 'uniform' as const, label: 'Equal' },
  { value: 'seg' as const, label: 'By Segments' },
  { value: 'src' as const, label: 'By Sources' },
]

const FORMAT_OPTIONS = [
  { value: 'compact' as const, label: 'Compact' },
  { value: 'full' as const, label: 'Full' },
]

// ── Props ────────────────────────────────────────────────────────────────────

interface CodebookToolbarProps {
  cb: CodebookState
  searchMatchCount: number
  diagnostics: Diagnostics
  totalCodes: number
  totalCategories: number
  treeData: CodebookTreeResponse | undefined
  isEmpty: boolean
  hidePanelOpen: boolean
  onToggleHidePanel: () => void
  hiddenCount: number
  hiddenTooltip: string
  projectId: number
  onCreateCode: () => void
  onCreateCategory: () => void
  onTreeExport: () => void
  onOverviewExport: () => void
  onExportCodebook?: (format: 'native' | 'qdc') => void
  onImportCodebook?: (file: File) => void
  isExportingCodebook?: boolean
  /** Max segment count across all codes (from unfiltered data) for range slider bounds */
  dataSegMax: number
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CodebookToolbar({
  cb,
  searchMatchCount,
  isEmpty,
  hidePanelOpen,
  onToggleHidePanel,
  hiddenCount,
  hiddenTooltip,
  projectId,
  onCreateCode,
  onCreateCategory,
  onTreeExport,
  onOverviewExport,
  onExportCodebook,
  onImportCodebook,
  isExportingCodebook,
  treeData,
  dataSegMax,
}: CodebookToolbarProps) {
  const importFileRef = useRef<HTMLInputElement>(null)
  // Segment range popover state
  const [segPopoverOpen, setSegPopoverOpen] = useState(false)
  const segPopoverRef = useRef<HTMLDivElement>(null)
  const segButtonRef = useRef<HTMLButtonElement>(null)

  // Slider upper bound: max of data max, current maxSeg, and at least 10 for usability
  const sliderMax = Math.max(dataSegMax, cb.maxSeg ?? 0, 10)
  const isSegFiltered = cb.minSeg > 0 || cb.maxSeg !== null

  // Close popover on click-outside
  useEffect(() => {
    if (!segPopoverOpen) return
    const handler = (e: globalThis.MouseEvent) => {
      if (
        segPopoverRef.current && !segPopoverRef.current.contains(e.target as Node) &&
        segButtonRef.current && !segButtonRef.current.contains(e.target as Node)
      ) {
        setSegPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [segPopoverOpen])

  return (
    <div className="shrink-0">
      {/* ── Row 1: Primary controls ──────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-mm-border-subtle bg-mm-surface flex-wrap">
        {/* Left: Mode + hierarchy levels */}
        <SegmentedControl
          options={MODE_OPTIONS}
          value={cb.mode}
          onChange={cb.setMode}
          ariaLabel="View mode"
          idPrefix="cb-mode"
        />

        {/* Center: Search */}
        <div className="relative flex-1 min-w-[140px] max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint" />
          <input
            type="text"
            value={cb.search}
            onChange={e => cb.setSearch(e.target.value)}
            placeholder="Filter codes…"
            className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md border border-mm-border-subtle bg-mm-bg text-mm-text placeholder:text-mm-text-faint focus:outline-none focus:ring-1 focus:ring-mm-blue/50"
          />
          {cb.search && (
            <button
              onClick={() => cb.setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-mm-text-faint hover:text-mm-text-secondary"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {cb.search && searchMatchCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 px-1 py-0.5 rounded-full bg-mm-blue text-white text-[9px] font-bold leading-none">
              {searchMatchCount}
            </span>
          )}
        </div>

        {/* Right: Freeze + Create + Export + Sources */}
        <FreezeCodebookButton projectId={projectId} />
        <button
          onClick={onCreateCode}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium bg-mm-green/8 text-mm-green-text border border-mm-green/20 hover:bg-mm-green/15 transition-colors"
          aria-label="Create code"
        >
          <Plus className="w-3.5 h-3.5" />
          Code
        </button>
        <button
          onClick={onCreateCategory}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium bg-mm-green/8 text-mm-green-text border border-mm-green/20 hover:bg-mm-green/15 transition-colors"
          aria-label="Create category"
        >
          <Plus className="w-3.5 h-3.5" />
          Category
        </button>

        {treeData && !isEmpty && (
          <button
            onClick={cb.mode === 'tree' ? onTreeExport : onOverviewExport}
            className="p-1.5 rounded-md text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface transition-colors"
            title={`Export ${cb.mode} as PNG`}
            aria-label={`Export ${cb.mode} as PNG`}
          >
            <FileOutput className="w-4 h-4" />
          </button>
        )}

        {onExportCodebook && (
          <>
            <button
              onClick={() => onExportCodebook('native')}
              disabled={isExportingCodebook}
              className="p-1.5 rounded-md text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface transition-colors disabled:opacity-50"
              title="Export codebook (.mmcodebook)"
              aria-label="Export codebook as Mixed Measures format"
            >
              <BookOpen className="w-4 h-4" />
            </button>
          </>
        )}

        {onImportCodebook && (
          <>
            <input
              ref={importFileRef}
              type="file"
              accept=".mmcodebook,.qdc"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onImportCodebook(file)
                e.target.value = ''
              }}
            />
            <button
              onClick={() => importFileRef.current?.click()}
              className="p-1.5 rounded-md text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface transition-colors"
              title="Import codebook (.mmcodebook or .qdc)"
              aria-label="Import codebook"
            >
              <FileInput className="w-4 h-4" />
            </button>
          </>
        )}

        <button
          onClick={onToggleHidePanel}
          className={`relative p-1.5 rounded-md transition-colors ${
            hidePanelOpen
              ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
              : 'text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-surface'
          }`}
          aria-pressed={hidePanelOpen}
          aria-label="Toggle hide panel"
          title={hiddenTooltip || 'Hide codes and sources'}
        >
          <EyeOff className="w-4 h-4" />
          {hiddenCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] px-1 py-0.5 rounded-full bg-orange-200 dark:bg-orange-800/50 text-orange-800 dark:text-orange-200 text-[9px] font-bold leading-none text-center">
              {hiddenCount}
            </span>
          )}
        </button>
      </div>

      {/* ── Row 2: Secondary controls ────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-mm-border-subtle bg-mm-surface flex-wrap">
        {/* Left: Format controls (tree) */}
        {cb.mode === 'tree' && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-mm-text-muted">Categories</span>
              <SegmentedControl
                options={FORMAT_OPTIONS}
                value={cb.catFormat}
                onChange={cb.setCatFormat}
                ariaLabel="Category format"
                idPrefix="cb-cat-fmt"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-mm-text-muted">Codes</span>
              <SegmentedControl
                options={FORMAT_OPTIONS}
                value={cb.codeFormat}
                onChange={cb.setCodeFormat}
                ariaLabel="Code format"
                idPrefix="cb-code-fmt"
              />
            </div>
          </>
        )}

        {/* Center: Size by */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-mm-text-muted">Size by</span>
          <SegmentedControl
            options={SIZING_OPTIONS}
            value={cb.sizing}
            onChange={cb.setSizing}
            ariaLabel="Node sizing"
            idPrefix="cb-sizing"
          />
        </div>

        {/* Right: Segment count filter */}
        <div className="relative ml-auto">
          <button
            ref={segButtonRef}
            onClick={() => setSegPopoverOpen(p => !p)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
              isSegFiltered
                ? 'bg-mm-blue/10 text-mm-blue-text border border-mm-blue/20'
                : 'text-mm-text-muted hover:text-mm-text-secondary hover:bg-mm-bg border border-transparent'
            }`}
            title="Filter codes by segment count"
            aria-expanded={segPopoverOpen}
            aria-haspopup="dialog"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Segments{isSegFiltered ? `: ${cb.minSeg}\u2013${cb.maxSeg ?? '\u221e'}` : ''}</span>
          </button>
          {segPopoverOpen && (
            <div
              ref={segPopoverRef}
              className="absolute top-full right-0 mt-1.5 bg-mm-surface border border-mm-border-subtle rounded-lg shadow-lg p-3 z-50 w-64"
              role="dialog"
              aria-label="Filter codes by segment count"
            >
              <p className="text-[11px] text-mm-text-muted mb-3">Show codes applied to a specific range of segments</p>
              {/* Dual range slider */}
              <div className="relative h-6 flex items-center mb-3 px-1">
                {/* Track background */}
                <div className="absolute inset-x-1 h-1.5 rounded-full bg-mm-bg" />
                {/* Active range fill */}
                <div
                  className="absolute h-1.5 rounded-full bg-mm-blue/30"
                  style={{
                    left: `calc(${(cb.minSeg / sliderMax) * 100}% + 4px)`,
                    right: `calc(${(1 - (cb.maxSeg ?? sliderMax) / sliderMax) * 100}% + 4px)`,
                  }}
                />
                {/* Min thumb */}
                <input
                  type="range"
                  min={0}
                  max={sliderMax}
                  value={cb.minSeg}
                  onChange={e => {
                    const v = Number(e.target.value)
                    cb.setMinSeg(Math.min(v, (cb.maxSeg ?? sliderMax)))
                  }}
                  className="absolute inset-x-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-mm-blue [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-xs [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-mm-blue [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-xs [&::-moz-range-thumb]:cursor-pointer"
                  style={{ zIndex: cb.minSeg > sliderMax - 10 ? 2 : 1 }}
                  aria-label="Minimum segment count"
                />
                {/* Max thumb */}
                <input
                  type="range"
                  min={0}
                  max={sliderMax}
                  value={cb.maxSeg ?? sliderMax}
                  onChange={e => {
                    const v = Number(e.target.value)
                    if (v >= sliderMax) {
                      cb.setMaxSeg(null)
                    } else {
                      cb.setMaxSeg(Math.max(v, cb.minSeg))
                    }
                  }}
                  className="absolute inset-x-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-mm-blue [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow-xs [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-mm-blue [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:shadow-xs [&::-moz-range-thumb]:cursor-pointer"
                  style={{ zIndex: 2 }}
                  aria-label="Maximum segment count"
                />
              </div>
              {/* Numeric inputs */}
              <div className="flex items-center gap-2 text-xs">
                <div className="flex-1">
                  <label className="text-mm-text-faint text-[10px] mb-0.5 block">Min</label>
                  <input
                    type="number"
                    min={0}
                    max={sliderMax}
                    value={cb.minSeg}
                    onChange={e => cb.setMinSeg(Math.max(0, Number(e.target.value) || 0))}
                    className="w-full px-2 py-1 rounded border border-mm-border-subtle bg-mm-bg text-mm-text text-xs text-center"
                    aria-label="Minimum segments"
                  />
                </div>
                <span className="text-mm-text-faint mt-3.5">{'\u2013'}</span>
                <div className="flex-1">
                  <label className="text-mm-text-faint text-[10px] mb-0.5 block">Max</label>
                  <input
                    type="number"
                    min={0}
                    value={cb.maxSeg ?? ''}
                    onChange={e => {
                      const v = e.target.value
                      cb.setMaxSeg(v === '' ? null : Math.max(0, Number(v) || 0))
                    }}
                    placeholder={'\u221e'}
                    className="w-full px-2 py-1 rounded border border-mm-border-subtle bg-mm-bg text-mm-text text-xs text-center placeholder:text-mm-text-faint"
                    aria-label="Maximum segments"
                  />
                </div>
              </div>
              {/* Reset */}
              {isSegFiltered && (
                <button
                  className="mt-2 text-[10px] text-mm-text-faint hover:text-mm-text-muted transition-colors"
                  onClick={() => { cb.setMinSeg(0); cb.setMaxSeg(null) }}
                >
                  Reset filter
                </button>
              )}
            </div>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-mm-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={cb.inactive}
            onChange={e => cb.setInactive(e.target.checked)}
            className="rounded border-mm-border-subtle"
          />
          Inactive
        </label>

        {/* Cross-link to where code co-occurrence now lives (#483) */}
        <Link
          to={`/projects/${projectId}/analysis/qualitative?tab=relationships`}
          className="ml-auto flex items-center gap-1 text-xs text-mm-text-muted hover:text-mm-text-secondary transition-colors"
          title="View how codes co-occur, in Analysis → Relationships"
        >
          Code co-occurrence
          <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  )
}
