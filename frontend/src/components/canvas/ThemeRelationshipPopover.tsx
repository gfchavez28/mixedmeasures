import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Link2, Plus, Pencil, Trash2, X, Check } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import type { CanvasTheme } from '@/lib/api'

const RELATIONSHIP_TYPES = [
  { value: 'confirms', label: 'Confirms' },
  { value: 'contradicts', label: 'Contradicts' },
  { value: 'extends', label: 'Extends' },
  { value: 'influences', label: 'Influences' },
  { value: 'reinforces', label: 'Reinforces' },
  { value: 'custom', label: 'Custom' },
]

type DirectionMode = 'a-to-b' | 'b-to-a' | 'bidirectional' | 'no-arrow'

const DIRECTION_OPTIONS: { value: DirectionMode; label: string }[] = [
  { value: 'a-to-b', label: 'A\u2192B' },
  { value: 'b-to-a', label: 'B\u2192A' },
  { value: 'bidirectional', label: 'A\u2194B' },
  { value: 'no-arrow', label: '\u2014' },
]

const LINE_STYLES = [
  { value: 'solid', dasharray: undefined },
  { value: 'dashed', dasharray: '6 3' },
  { value: 'dotted', dasharray: '2 2' },
]

const DEFAULT_LINE_COLOR = '#8b949e'

interface ThemeRelationshipPopoverProps {
  theme: CanvasTheme
  allThemes: CanvasTheme[]
  onCreateRelationship: (data: {
    source_theme_id: number
    target_theme_id: number
    relationship_type: string
    label?: string
    weight?: number
    is_bidirectional?: boolean
    line_style?: string
    line_color?: string
  }) => void
  onUpdateRelationship: (relId: number, data: {
    relationship_type?: string
    label?: string
    weight?: number
    is_bidirectional?: boolean
    line_style?: string
    line_color?: string
  }) => void
  onDeleteRelationship: (relId: number) => void
  onDismiss?: () => void
  defaultOpen?: boolean
  children?: React.ReactNode
  prefilledTargetId?: number | null
}

interface RelItem {
  id: number
  otherThemeName: string
  otherThemeColor: string | null
  direction: 'out' | 'in'
  relationship_type: string
  label: string | null
  weight: number
  is_bidirectional: boolean
  line_style: string | null
  line_color: string | null
  source_theme_id: number
  target_theme_id: number
}

export default function ThemeRelationshipPopover({
  theme,
  allThemes,
  onCreateRelationship,
  onUpdateRelationship,
  onDeleteRelationship,
  onDismiss,
  defaultOpen = false,
  children,
  prefilledTargetId,
}: ThemeRelationshipPopoverProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [formTargetId, setFormTargetId] = useState('')
  const [formType, setFormType] = useState('confirms')
  const [formLabel, setFormLabel] = useState('')
  const [formDirection, setFormDirection] = useState<DirectionMode>('a-to-b')
  const [formLineStyle, setFormLineStyle] = useState<string>('solid')
  const [formStraight, setFormStraight] = useState(false)
  const [formWeight, setFormWeight] = useState(50)
  const [formLineColor, setFormLineColor] = useState<string>(DEFAULT_LINE_COLOR)
  const [showColorPicker, setShowColorPicker] = useState(false)

  // Track whether we already handled a prefill so we don't re-trigger
  const prefillHandledRef = useRef<number | null>(null)

  const themeMap = useMemo(() => {
    const m = new Map<number, CanvasTheme>()
    for (const t of allThemes) m.set(t.id, t)
    return m
  }, [allThemes])

  const relationships: RelItem[] = useMemo(() => {
    const items: RelItem[] = []
    for (const r of (theme.relationships_out ?? [])) {
      const other = themeMap.get(r.target_theme_id)
      items.push({
        id: r.id,
        otherThemeName: other?.name ?? 'Unknown',
        otherThemeColor: other?.color ?? null,
        direction: 'out',
        relationship_type: r.relationship_type,
        label: r.label,
        weight: r.weight,
        is_bidirectional: r.is_bidirectional,
        line_style: r.line_style,
        line_color: r.line_color,
        source_theme_id: r.source_theme_id,
        target_theme_id: r.target_theme_id,
      })
    }
    for (const r of (theme.relationships_in ?? [])) {
      const other = themeMap.get(r.source_theme_id)
      items.push({
        id: r.id,
        otherThemeName: other?.name ?? 'Unknown',
        otherThemeColor: other?.color ?? null,
        direction: 'in',
        relationship_type: r.relationship_type,
        label: r.label,
        weight: r.weight,
        is_bidirectional: r.is_bidirectional,
        line_style: r.line_style,
        line_color: r.line_color,
        source_theme_id: r.source_theme_id,
        target_theme_id: r.target_theme_id,
      })
    }
    return items
  }, [theme.relationships_out, theme.relationships_in, themeMap])

  const otherThemes = useMemo(
    () => allThemes.filter(t => t.id !== theme.id),
    [allThemes, theme.id],
  )

  const resetForm = useCallback(() => {
    setFormTargetId('')
    setFormType('confirms')
    setFormLabel('')
    setFormDirection('a-to-b')
    setFormLineStyle('solid')
    setFormStraight(false)
    setFormWeight(50)
    setFormLineColor(DEFAULT_LINE_COLOR)
    setShowColorPicker(false)
    setAdding(false)
    setEditingId(null)
  }, [])

  // Handle prefilledTargetId: auto-populate and enter adding mode
  useEffect(() => {
    if (open && prefilledTargetId != null && prefillHandledRef.current !== prefilledTargetId) {
      prefillHandledRef.current = prefilledTargetId
      // eslint-disable-next-line react-hooks/set-state-in-effect -- populate form + enter adding mode from the prefill prop when the popover opens
      setFormTargetId(String(prefilledTargetId))
      setAdding(true)
    }
  }, [open, prefilledTargetId])

  // Reset prefill tracking when popover closes
  useEffect(() => {
    if (!open) {
      prefillHandledRef.current = null
    }
  }, [open])

  const handleSave = useCallback(() => {
    if (formType === 'custom' && !formLabel.trim()) return
    const effectiveStyle = formDirection === 'no-arrow'
      ? 'no-arrow'
      : formStraight ? `${formLineStyle}-straight` : formLineStyle
    if (editingId != null) {
      onUpdateRelationship(editingId, {
        relationship_type: formType,
        label: formLabel || undefined,
        weight: formWeight,
        is_bidirectional: formDirection === 'bidirectional',
        line_style: effectiveStyle,
        line_color: formLineColor,
      })
      resetForm()
    } else {
      const targetId = Number(formTargetId)
      if (!targetId) return

      // Determine source/target based on direction
      const swapped = formDirection === 'b-to-a'
      const sourceId = swapped ? targetId : theme.id
      const actualTargetId = swapped ? theme.id : targetId

      onCreateRelationship({
        source_theme_id: sourceId,
        target_theme_id: actualTargetId,
        relationship_type: formType,
        label: formLabel || undefined,
        weight: formWeight,
        is_bidirectional: formDirection === 'bidirectional',
        line_style: effectiveStyle,
        line_color: formLineColor,
      })
      resetForm()
    }
  }, [editingId, formTargetId, formType, formLabel, formDirection, formLineStyle, formStraight, formWeight, formLineColor, theme.id, onCreateRelationship, onUpdateRelationship, resetForm])

  const handleEdit = useCallback((rel: RelItem) => {
    setEditingId(rel.id)
    setFormType(rel.relationship_type)
    setFormLabel(rel.label ?? '')

    // Derive direction mode from stored values
    if (rel.is_bidirectional) {
      setFormDirection('bidirectional')
    } else if (rel.line_style === 'no-arrow') {
      setFormDirection('no-arrow')
    } else if (rel.direction === 'in') {
      setFormDirection('b-to-a')
    } else {
      setFormDirection('a-to-b')
    }

    const rawStyle = rel.line_style ?? 'solid'
    const hasStraight = rawStyle.includes('-straight')
    setFormStraight(hasStraight)
    setFormLineStyle(rawStyle === 'no-arrow' ? 'solid' : rawStyle.replace('-straight', ''))
    setFormWeight(rel.weight ?? 50)
    setFormLineColor(rel.line_color ?? DEFAULT_LINE_COLOR)
    setShowColorPicker(false)
    setAdding(true)
  }, [])

  const relationshipCount = relationships.length

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { resetForm(); onDismiss?.() } }}>
      <PopoverTrigger asChild>
        {children ?? <span className="absolute w-0 h-0" />}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-2 border-b border-mm-border-subtle">
          <p className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider">
            Relationships ({relationshipCount})
          </p>
        </div>

        {/* Existing relationships */}
        {relationships.length > 0 && (
          <div className="max-h-48 overflow-y-auto divide-y divide-mm-border-subtle">
            {relationships.map(rel => (
              <div key={rel.id} className="flex items-center gap-2 px-2 py-1.5 text-xs group/rel">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: rel.otherThemeColor ?? 'hsl(var(--mm-purple))' }}
                />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-mm-text truncate block">
                    {rel.is_bidirectional
                      ? '\u2194 '
                      : rel.direction === 'out'
                        ? '\u2192 '
                        : '\u2190 '}
                    {rel.otherThemeName}
                  </span>
                  <span className="text-mm-text-muted capitalize">
                    {rel.relationship_type === 'custom'
                      ? rel.label || 'Custom'
                      : rel.label
                        ? `${rel.relationship_type} \u00b7 ${rel.label}`
                        : rel.relationship_type}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover/rel:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleEdit(rel)}
                    className="p-0.5 rounded hover:bg-mm-bg transition-colors text-mm-text-muted hover:text-mm-text"
                    title="Edit"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => onDeleteRelationship(rel.id)}
                    className="p-0.5 rounded hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-mm-text-muted hover:text-red-500"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {relationships.length === 0 && !adding && (
          <div className="px-2 py-3 text-xs text-mm-text-faint text-center">
            No relationships yet
          </div>
        )}

        {/* Add/edit form */}
        {adding ? (
          <div className="p-2 border-t border-mm-border-subtle space-y-2">
            {/* Target (read-only when editing) */}
            {editingId == null && (
              <Select value={formTargetId} onValueChange={setFormTargetId}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder="Target theme..." />
                </SelectTrigger>
                <SelectContent>
                  {otherThemes.map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: t.color ?? 'hsl(var(--mm-purple))' }}
                        />
                        {t.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={formType} onValueChange={setFormType}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATIONSHIP_TYPES.map(rt => (
                  <SelectItem key={rt.value} value={rt.value}>{rt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <input
              type="text"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder={formType === 'custom' ? 'Connection label (required)' : 'Label (optional)'}
              className="w-full h-7 px-2 text-xs rounded border border-mm-border-subtle bg-transparent text-mm-text focus:outline-none focus:ring-1 focus:ring-mm-accent"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            />

            {/* Direction selector */}
            <div>
              <p className="text-[10px] text-mm-text-faint uppercase tracking-wider mb-1">Direction</p>
              <div className="flex gap-0.5">
                {DIRECTION_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFormDirection(opt.value)}
                    className={`h-6 flex-1 rounded text-[11px] font-medium transition-colors ${
                      formDirection === opt.value
                        ? 'bg-[hsl(var(--mm-purple))] text-white'
                        : 'bg-mm-bg-secondary text-mm-text-muted hover:text-mm-text hover:bg-mm-border-subtle'
                    }`}
                    aria-pressed={formDirection === opt.value}
                    title={
                      opt.value === 'a-to-b' ? 'Directed: source to target'
                        : opt.value === 'b-to-a' ? 'Directed: target to source'
                        : opt.value === 'bidirectional' ? 'Bidirectional'
                        : 'No arrow markers'
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Line shape (curved / straight) */}
            <div>
              <p className="text-[10px] text-mm-text-faint uppercase tracking-wider mb-1">Shape</p>
              <div className="flex gap-0.5">
                {([false, true] as const).map(straight => (
                  <button
                    key={straight ? 'straight' : 'curved'}
                    type="button"
                    onClick={() => setFormStraight(straight)}
                    className={`h-6 flex-1 rounded text-[11px] font-medium transition-colors ${
                      formStraight === straight
                        ? 'bg-[hsl(var(--mm-purple))] text-white'
                        : 'bg-mm-bg-secondary text-mm-text-muted hover:text-mm-text hover:bg-mm-border-subtle'
                    }`}
                    aria-pressed={formStraight === straight}
                    aria-label={straight ? 'Straight line' : 'Curved line'}
                  >
                    {straight ? 'Straight' : 'Curved'}
                  </button>
                ))}
              </div>
            </div>

            {/* Line style selector */}
            <div>
              <p className="text-[10px] text-mm-text-faint uppercase tracking-wider mb-1">Line style</p>
              <div className="flex gap-0.5">
                {LINE_STYLES.map(ls => (
                  <button
                    key={ls.value}
                    type="button"
                    onClick={() => setFormLineStyle(ls.value)}
                    className={`h-6 w-[40px] rounded flex items-center justify-center transition-colors ${
                      formLineStyle === ls.value
                        ? 'bg-[hsl(var(--mm-purple))] text-white'
                        : 'bg-mm-bg-secondary text-mm-text-muted hover:bg-mm-border-subtle'
                    }`}
                    aria-pressed={formLineStyle === ls.value}
                    aria-label={`${ls.value} line`}
                  >
                    <svg width="30" height="6" aria-hidden="true">
                      <line
                        x1="2" y1="3" x2="28" y2="3"
                        stroke={formLineStyle === ls.value ? 'white' : 'currentColor'}
                        strokeWidth="2"
                        strokeDasharray={ls.dasharray}
                      />
                    </svg>
                  </button>
                ))}
              </div>
            </div>

            {/* Line weight */}
            <div>
              <p className="text-[10px] text-mm-text-faint uppercase tracking-wider mb-1">Weight</p>
              <div className="flex gap-0.5">
                {([
                  { value: 17, label: 'Thin', width: 1 },
                  { value: 50, label: 'Medium', width: 2 },
                  { value: 83, label: 'Heavy', width: 3.5 },
                ] as const).map(wt => {
                  const isActive = (wt.value <= 33 && formWeight <= 33)
                    || (wt.value > 33 && wt.value <= 66 && formWeight > 33 && formWeight <= 66)
                    || (wt.value > 66 && formWeight > 66)
                  return (
                    <button
                      key={wt.value}
                      type="button"
                      onClick={() => setFormWeight(wt.value)}
                      className={`h-6 flex-1 rounded flex items-center justify-center transition-colors ${
                        isActive
                          ? 'bg-[hsl(var(--mm-purple))] text-white'
                          : 'bg-mm-bg-secondary text-mm-text-muted hover:bg-mm-border-subtle'
                      }`}
                      aria-pressed={isActive}
                      aria-label={`${wt.label} weight`}
                    >
                      <svg width="30" height="8" aria-hidden="true">
                        <line
                          x1="2" y1="4" x2="28" y2="4"
                          stroke={isActive ? 'white' : 'currentColor'}
                          strokeWidth={wt.width}
                        />
                      </svg>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Line color */}
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <p className="text-[10px] text-mm-text-faint uppercase tracking-wider">Color</p>
                <button
                  type="button"
                  onClick={() => setShowColorPicker(prev => !prev)}
                  className="w-4 h-4 rounded border border-mm-border-subtle shrink-0"
                  style={{ backgroundColor: formLineColor }}
                  aria-label="Toggle color picker"
                  aria-expanded={showColorPicker}
                />
              </div>
              {showColorPicker && (
                <ColorSwatchPicker value={formLineColor} onChange={(c) => { setFormLineColor(c); setShowColorPicker(false) }} />
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={handleSave}
                disabled={(editingId == null && !formTargetId) || (formType === 'custom' && !formLabel.trim())}
                className="flex-1 flex items-center justify-center gap-1 h-7 rounded text-xs font-medium text-white bg-[hsl(var(--mm-purple))] hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                <Check className="w-3 h-3" />
                {editingId != null ? 'Update' : 'Add'}
              </button>
              <button
                onClick={resetForm}
                className="h-7 px-2 rounded text-xs text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-2 border-t border-mm-border-subtle">
            <button
              onClick={() => setAdding(true)}
              className="w-full flex items-center justify-center gap-1 h-7 rounded text-xs font-medium text-mm-text-secondary hover:text-mm-text border border-mm-border-subtle hover:border-mm-border-medium transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add relationship
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Compact relationship badge for theme headers */
export function RelationshipBadge({
  count,
  onClick,
}: {
  count: number
  onClick?: () => void
}) {
  if (count === 0) return null
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-mm-bg-secondary text-mm-text-faint font-medium tabular-nums hover:bg-mm-border-subtle transition-colors"
      title={`${count} relationship${count !== 1 ? 's' : ''}`}
    >
      <Link2 className="w-2.5 h-2.5 inline mr-0.5" />
      {count}
    </button>
  )
}
