import { useMemo } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CanvasTheme, CanvasThemeRelationship } from '@/lib/api'

const REL_COLORS: Record<string, string> = {
  confirms: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
  contradicts: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400',
  extends: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
  influences: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
}

interface ConvergenceMatrixProps {
  themes: CanvasTheme[]
  open: boolean
  onClose: () => void
  onCellClick: (sourceThemeId: number, targetThemeId: number, existingRelId?: number) => void
  onScrollToTheme?: (themeId: number) => void
  view: 'writing' | 'spatial'
}

export default function ConvergenceMatrix({
  themes,
  open,
  onClose,
  onCellClick,
  onScrollToTheme,
  view,
}: ConvergenceMatrixProps) {
  const relMap = useMemo(() => {
    const map = new Map<string, CanvasThemeRelationship>()
    for (const theme of themes) {
      for (const rel of theme.relationships_out) {
        map.set(`${rel.source_theme_id}-${rel.target_theme_id}`, rel)
      }
    }
    return map
  }, [themes])

  if (!open || themes.length < 2) return null

  function truncName(name: string, max = 10) {
    return name.length > max ? name.slice(0, max) + '\u2026' : name
  }

  function renderCell(rowTheme: CanvasTheme, colTheme: CanvasTheme) {
    if (rowTheme.id === colTheme.id) {
      return (
        <td
          key={colTheme.id}
          className="h-9 min-w-[58px] border border-mm-border-subtle bg-mm-surface-secondary cursor-default rounded-sm"
        />
      )
    }

    const key = `${rowTheme.id}-${colTheme.id}`
    const reverseKey = `${colTheme.id}-${rowTheme.id}`
    const rel = relMap.get(key) ?? relMap.get(reverseKey)

    if (rel) {
      const colorClass = REL_COLORS[rel.relationship_type] ?? 'bg-gray-50 text-gray-600 dark:bg-gray-800/30'
      return (
        <td
          key={colTheme.id}
          role="button"
          tabIndex={0}
          className={cn(
            'h-9 min-w-[58px] border border-mm-border-subtle text-[9px] font-medium rounded-sm cursor-pointer text-center',
            colorClass,
          )}
          onClick={() => onCellClick(rowTheme.id, colTheme.id, rel.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCellClick(rowTheme.id, colTheme.id, rel.id) } }}
          aria-label={`${rowTheme.name} to ${colTheme.name}: ${rel.relationship_type}`}
        >
          {rel.relationship_type}
        </td>
      )
    }

    return (
      <td
        key={colTheme.id}
        role="button"
        tabIndex={0}
        className="h-9 min-w-[58px] border border-mm-border-subtle text-[9px] font-medium rounded-sm cursor-pointer hover:bg-mm-surface-secondary group/cell text-center"
        onClick={() => onCellClick(rowTheme.id, colTheme.id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCellClick(rowTheme.id, colTheme.id) } }}
        aria-label={`Create relationship between ${rowTheme.name} and ${colTheme.name}`}
      >
        <span className="hidden group-hover/cell:inline text-mm-text-faint text-sm">+</span>
      </td>
    )
  }

  return (
    <div data-convergence-matrix className="absolute top-14 right-4 w-[440px] z-[60] bg-white dark:bg-mm-surface border border-mm-border rounded-lg shadow-xl">
      {/* Header */}
      <div className="flex items-start justify-between px-4 pt-3 pb-2">
        <div>
          <h3 className="text-sm font-bold text-mm-text">Convergence Matrix</h3>
          <p className="text-[11px] text-mm-text-muted mt-0.5">Theme relationships at a glance</p>
          <p className="text-[10px] text-mm-text-faint italic mt-0.5">Click any cell to create or edit a relationship</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-surface-secondary transition-colors"
          aria-label="Close convergence matrix"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Table */}
      <div className="px-4 pb-4 overflow-auto max-h-[400px]">
        <table role="table" className="border-collapse text-[10px] w-full">
          <thead>
            <tr>
              <th className="px-1.5 py-1" />
              {themes.map(t => (
                <th
                  key={t.id}
                  role="columnheader"
                  className="px-1.5 py-1 text-center text-[10px] font-semibold text-mm-text-muted whitespace-nowrap"
                  title={t.name}
                >
                  {view === 'writing' && onScrollToTheme ? (
                    <button
                      type="button"
                      onClick={() => onScrollToTheme(t.id)}
                      className="hover:text-mm-text hover:underline transition-colors"
                    >
                      {truncName(t.name)}
                    </button>
                  ) : (
                    truncName(t.name)
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {themes.map(rowTheme => (
              <tr key={rowTheme.id}>
                <th
                  role="rowheader"
                  className="text-right pr-2.5 max-w-[90px] truncate text-[10px] font-semibold text-mm-text-muted"
                  title={rowTheme.name}
                >
                  {view === 'writing' && onScrollToTheme ? (
                    <button
                      type="button"
                      onClick={() => onScrollToTheme(rowTheme.id)}
                      className="hover:text-mm-text hover:underline transition-colors text-right"
                    >
                      {truncName(rowTheme.name)}
                    </button>
                  ) : (
                    truncName(rowTheme.name)
                  )}
                </th>
                {themes.map(colTheme => renderCell(rowTheme, colTheme))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
