import { useState, useMemo, useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { useDraggable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, AlertCircle, ArrowRightLeft, GripVertical, ChevronDown, ChevronRight, ChevronUp, Plus, Trash2, MessageSquareQuote, BarChart3, FileText } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import ThemeContextMenu from './ThemeContextMenu'
import type { CanvasDetail, CanvasTheme, PendingItem } from '@/lib/api'
import { canvasApi } from '@/lib/api'
import { extractMaterialSummary, computeNestingDepth } from './canvas-utils'
import type { ThemeMentionItem } from './ThemeMentionList'
import type { SlashCommand } from './extensions/slash-commands'
import ThemeEditor from './ThemeEditor'
import type { InsertNodeHandle } from './ThemeEditor'
import { toast } from 'sonner'

// ── Props ────────────────────────────────────────────────────────────────────

interface WritingCanvasProps {
  projectId: string
  canvas: CanvasDetail
  onCreateTheme: (data: { name: string; section_type?: 'theme' | 'prose'; color?: string; after_theme_id?: number }) => void
  onUpdateTheme: (themeId: number, data: { name?: string; section_type?: 'theme' | 'prose'; color?: string }) => void
  onDeleteTheme: (themeId: number) => void
  onReorderThemes: (themeIds: number[]) => void
  onOpenDrawer?: (section?: 'excerpts' | 'charts' | 'memos') => void
  focusedThemeId?: number | null
  onFocusTheme?: (themeId: number | null) => void
  pendingItems: PendingItem[]
  onRemovePendingItem: (itemId: number) => void
  onInsertPendingItem: (item: PendingItem) => void
  focusedEditorRef: MutableRefObject<{ themeId: number | null; insertNode: InsertNodeHandle | null } | null>
  themeInsertNodeRefs: Map<number, MutableRefObject<InsertNodeHandle | null>>
  showColorBars?: boolean
  onContentSaved?: () => void
}

// ── Pending item icons ──────────────────────────────────────────────────────

const PENDING_ICONS: Record<string, React.ReactNode> = {
  excerpt: <MessageSquareQuote className="w-3.5 h-3.5" />,
  material: <BarChart3 className="w-3.5 h-3.5" />,
  memo: <FileText className="w-3.5 h-3.5" />,
}

const PENDING_LABELS: Record<string, string> = {
  excerpt: 'Excerpt',
  material: 'Chart',
  memo: 'Memo',
}

// ── Main component ───────────────────────────────────────────────────────────

export default function WritingCanvas({
  projectId,
  canvas,
  onCreateTheme,
  onUpdateTheme,
  onDeleteTheme,
  onReorderThemes,
  onOpenDrawer,
  focusedThemeId,
  onFocusTheme,
  pendingItems,
  onRemovePendingItem,
  onInsertPendingItem,
  focusedEditorRef,
  themeInsertNodeRefs,
  showColorBars = true,
  onContentSaved,
}: WritingCanvasProps) {
  const themes = useMemo(
    () => [...canvas.themes].sort((a, b) => a.doc_order - b.doc_order),
    [canvas.themes],
  )
  const depthMap = useMemo(() => computeNestingDepth(themes), [themes])

  // @Theme mention items derived from theme-type sections only
  const mentionItems: ThemeMentionItem[] = useMemo(
    () => themes.filter(t => t.section_type === 'theme').map(t => ({ id: String(t.id), label: t.name, color: t.color ?? '#6366f1' })),
    [themes],
  )
  const handleMentionClick = useCallback((themeId: string) => {
    document.getElementById(`theme-${themeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const hasSections = themes.length > 0
  const hasPendingItems = pendingItems.length > 0

  // DnD section reordering
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleSectionDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = themes.findIndex(t => t.id === Number(active.id))
    const newIndex = themes.findIndex(t => t.id === Number(over.id))
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = arrayMove(themes, oldIndex, newIndex)
    onReorderThemes(reordered.map(t => t.id))
  }, [themes, onReorderThemes])

  // Track collapsed sections
  const [collapsedThemes, setCollapsedThemes] = useState<Set<number>>(new Set())
  const toggleThemeCollapse = useCallback((themeId: number) => {
    setCollapsedThemes(prev => {
      const next = new Set(prev)
      if (next.has(themeId)) next.delete(themeId)
      else next.add(themeId)
      return next
    })
  }, [])

  // Save status indicator
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current) }
  }, [])

  const showSaved = useCallback(() => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSaveStatus('saved')
    savedTimerRef.current = setTimeout(() => {
      setSaveStatus('idle')
      savedTimerRef.current = null
    }, 2000)
  }, [])

  const showError = useCallback(() => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSaveStatus('error')
    toast.error('Failed to save — your changes may not be persisted')
  }, [])

  // Dirty tracking for beforeunload
  const dirtyRef = useRef(false)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const handleContentChange = useCallback(() => { dirtyRef.current = true }, [])

  // Save section prose content via API
  const handleSaveThemeContent = useCallback((themeId: number, json: Record<string, unknown>) => {
    canvasApi.updateTheme(Number(projectId), canvas.id, themeId, { content: json })
      .then(() => { dirtyRef.current = false; showSaved(); onContentSaved?.() })
      .catch(() => { showError() })
  }, [projectId, canvas.id, showSaved, showError, onContentSaved])

  // Slash command handler for ThemeEditor (parent-handled commands)
  const handleThemeSlashCommand = useCallback((cmd: SlashCommand, themeId?: number) => {
    if (cmd.type === 'excerpt') { onOpenDrawer?.('excerpts'); return }
    if (cmd.type === 'chart') { onOpenDrawer?.('charts'); return }
    if (cmd.type === 'memo') { onOpenDrawer?.('memos'); return }
    if (cmd.type === 'heading') {
      onCreateTheme({ name: 'New theme', after_theme_id: themeId })
      return
    }
    if (cmd.type === 'section') {
      onCreateTheme({ name: 'New section', section_type: 'prose', after_theme_id: themeId })
      return
    }
    if (cmd.type === 'image') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        try {
          const { image_id } = await canvasApi.uploadImage(Number(projectId), file)
          const focused = focusedEditorRef.current
          if (focused?.insertNode) {
            focused.insertNode.insertImage({ imageId: image_id })
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Image upload failed')
        }
      }
      input.click()
      return
    }
  }, [onOpenDrawer, onCreateTheme, projectId, focusedEditorRef])

  // Theme move helpers
  const handleMoveTheme = useCallback((themeId: number, direction: 'up' | 'down') => {
    const idx = themes.findIndex(t => t.id === themeId)
    if (idx === -1) return
    const swap = direction === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= themes.length) return
    const ids = themes.map(t => t.id)
    ;[ids[idx], ids[swap]] = [ids[swap], ids[idx]]
    onReorderThemes(ids)
  }, [themes, onReorderThemes])

  // Focus management after section deletion
  const pendingFocusRef = useRef<number | null>(null)

  const handleDelete = useCallback((themeId: number) => {
    const idx = themes.findIndex(t => t.id === themeId)
    const target = idx > 0 ? themes[idx - 1].id : themes[idx + 1]?.id ?? null
    pendingFocusRef.current = target
    onDeleteTheme(themeId)
  }, [themes, onDeleteTheme])

  useEffect(() => {
    if (pendingFocusRef.current != null) {
      const el = document.querySelector(`#theme-${pendingFocusRef.current} [data-theme-heading] button`) as HTMLElement
      el?.focus()
      pendingFocusRef.current = null
    }
  }, [themes])

  // Material count for status bar
  const materialCount = useMemo(() => {
    let count = 0
    for (const t of themes) {
      const s = extractMaterialSummary(t.content)
      count += s.excerptCount + s.chartCount + s.memoCount + s.calloutCount
    }
    return count
  }, [themes])
  const themeCount = useMemo(() => themes.filter(t => t.section_type === 'theme').length, [themes])
  const proseCount = themes.length - themeCount

  // Helper to get/create insertNodeRef for a theme
  const getInsertNodeRef = useCallback((themeId: number): MutableRefObject<InsertNodeHandle | null> => {
    if (!themeInsertNodeRefs.has(themeId)) {
      themeInsertNodeRefs.set(themeId, { current: null })
    }
    return themeInsertNodeRefs.get(themeId)!
  }, [themeInsertNodeRefs])

  return (
    <div className={`flex-1 flex flex-col bg-white dark:bg-mm-surface${!showColorBars ? ' hide-material-colors' : ''}`} role="main" aria-label="Writing canvas">
      <div className="flex-1 overflow-auto">
      <div className="max-w-[740px] mx-auto px-8 py-10 min-h-[50vh]">
        {/* ── Focus mode exit bar ─────────────────────────────────────── */}
        {focusedThemeId != null && (
          <button
            type="button"
            onClick={() => onFocusTheme?.(null)}
            className="mb-4 w-full flex items-center justify-center gap-2 py-2 rounded-md border border-dashed border-mm-border text-xs text-mm-text-muted hover:text-mm-text hover:border-mm-border-medium transition-colors"
          >
            Focusing on one theme — click to show all
          </button>
        )}
        {/* ── All sections (prose + theme) in doc_order ─────────────────── */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}>
        <SortableContext items={themes.map(t => t.id)} strategy={verticalListSortingStrategy}>
        {themes.map((section, idx) => {
          const isCollapsed = collapsedThemes.has(section.id)
          const isTheme = section.section_type === 'theme'
          const isFocusedAway = focusedThemeId != null && isTheme && section.id !== focusedThemeId

          if (isFocusedAway) {
            const themeColor = section.color ?? '#6366f1'
            const summary = extractMaterialSummary(section.content)
            const materialCount = summary.excerptCount + summary.chartCount + summary.memoCount + summary.calloutCount
            return (
              <button
                key={section.id}
                id={`theme-${section.id}`}
                type="button"
                onClick={() => onFocusTheme?.(section.id)}
                className="w-full flex items-center gap-2 mb-2 py-1.5 rounded hover:bg-mm-bg/60 transition-colors text-left"
                style={{ paddingLeft: (depthMap.get(section.id) ?? 0) > 0 ? (depthMap.get(section.id)! * 24) : undefined }}
                aria-label={`Focus on ${section.name}`}
              >
                {showColorBars ? (
                  <div className="w-1 h-5 rounded-full shrink-0" style={{ backgroundColor: themeColor }} />
                ) : (
                  <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-mm-border" />
                )}
                <span className="text-sm text-mm-text-muted truncate">{section.name}</span>
                <span className="text-xs text-mm-text-faint tabular-nums shrink-0">{materialCount}</span>
              </button>
            )
          }

          const insertNodeRef = getInsertNodeRef(section.id)

          return (
            <ThemeSection
              key={section.id}
              theme={section}
              isCollapsed={isCollapsed}
              canMoveUp={idx > 0}
              canMoveDown={idx < themes.length - 1}
              isFirst={idx === 0}
              isLast={idx === themes.length - 1}
              isFocused={focusedThemeId === section.id}
              onToggleCollapse={() => toggleThemeCollapse(section.id)}
              onUpdateTheme={onUpdateTheme}
              onDeleteTheme={handleDelete}
              onMoveUp={() => handleMoveTheme(section.id, 'up')}
              onMoveDown={() => handleMoveTheme(section.id, 'down')}
              onFocusTheme={onFocusTheme}
              onSlashCommand={(cmd) => handleThemeSlashCommand(cmd, section.id)}
              onSaveThemeContent={handleSaveThemeContent}
              projectId={projectId}
              mentionItems={mentionItems}
              onMentionClick={handleMentionClick}
              insertNodeRef={insertNodeRef}
              onContentChange={handleContentChange}
              showColorBars={showColorBars}
              onEditorFocus={() => {
                focusedEditorRef.current = { themeId: section.id, insertNode: insertNodeRef.current }
              }}
              nestingDepth={depthMap.get(section.id) ?? 0}
            />
          )
        })}
        </SortableContext>
        </DndContext>

        {/* ── Add theme / Add section buttons ──────────────────────────── */}
        <div className="my-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onCreateTheme({ name: 'New theme' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-mm-text-muted hover:text-mm-text border border-dashed border-mm-border hover:border-mm-border-medium transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add theme
          </button>
          <button
            type="button"
            onClick={() => onCreateTheme({ name: 'New section', section_type: 'prose' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-mm-text-muted hover:text-mm-text border border-dashed border-mm-border hover:border-mm-border-medium transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add section
          </button>
        </div>

        {/* ── Unsorted section (pending items) ─────────────────────────── */}
        {hasPendingItems && (
          <UnsortedSection
            pendingItems={pendingItems}
            onInsertPendingItem={onInsertPendingItem}
            onRemovePendingItem={onRemovePendingItem}
          />
        )}
      </div>
      </div>

      {/* Fixed bottom status bar */}
      {hasSections && (
        <div className="shrink-0 border-t border-mm-border-subtle px-4 py-1.5 text-[11px] text-mm-text-faint tabular-nums flex items-center" role="status" aria-label="Canvas statistics">
          <span>
            {materialCount} material{materialCount !== 1 ? 's' : ''}
            {' · '}
            {themeCount} theme{themeCount !== 1 ? 's' : ''}
            {proseCount > 0 && ` · ${proseCount} section${proseCount !== 1 ? 's' : ''}`}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {saveStatus === 'saved' && (
              <span className="text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="w-3 h-3" />
                Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="text-red-500 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                Save failed
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Theme section component ──────────────────────────────────────────────────

interface ThemeSectionProps {
  theme: CanvasTheme
  isCollapsed: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  isFirst: boolean
  isLast: boolean
  isFocused: boolean
  onToggleCollapse: () => void
  onUpdateTheme: (themeId: number, data: { name?: string; section_type?: 'theme' | 'prose'; color?: string }) => void
  onDeleteTheme: (themeId: number) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onFocusTheme?: (id: number) => void
  onSlashCommand: (cmd: SlashCommand) => void
  onSaveThemeContent: (themeId: number, json: Record<string, unknown>) => void
  projectId: string
  mentionItems?: ThemeMentionItem[]
  onMentionClick?: (id: string) => void
  insertNodeRef: MutableRefObject<InsertNodeHandle | null>
  onEditorFocus: () => void
  onContentChange?: () => void
  showColorBars?: boolean
  nestingDepth?: number
}

function ThemeSection({
  theme,
  isCollapsed,
  canMoveUp,
  canMoveDown,
  isFirst,
  isLast,
  isFocused,
  onToggleCollapse,
  onUpdateTheme,
  onDeleteTheme,
  onMoveUp,
  onMoveDown,
  onFocusTheme,
  onSlashCommand,
  onSaveThemeContent,
  mentionItems,
  onMentionClick,
  insertNodeRef,
  onEditorFocus,
  onContentChange,
  showColorBars = true,
  nestingDepth = 0,
}: ThemeSectionProps) {
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(theme.name)
  const [prevName, setPrevName] = useState(theme.name)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync name from server. Done during render (adjust-state-on-prop-change)
  // rather than in an effect: when the server-provided name changes, resync the
  // editable value. Resyncs only when theme.name actually changes, so local
  // typing (which changes nameValue, not theme.name) is preserved. The
  // !editingName guard (#404) prevents a background refetch that changes
  // theme.name mid-edit from clobbering what the user is typing; prevName still
  // tracks unconditionally so the resync fires correctly once editing ends.
  if (theme.name !== prevName) {
    setPrevName(theme.name)
    if (!editingName) setNameValue(theme.name)
  }

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (editingName) inputRef.current?.select()
  }, [editingName])

  const handleNameSave = useCallback(() => {
    setEditingName(false)
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== theme.name) {
      onUpdateTheme(theme.id, { name: trimmed })
    } else {
      setNameValue(theme.name)
    }
  }, [nameValue, theme.id, theme.name, onUpdateTheme])

  const isTheme = theme.section_type === 'theme'
  const themeColor = isTheme ? (theme.color ?? '#6366f1') : '#d1d5db'

  const {
    attributes: sortableAttrs,
    listeners: sortableListeners,
    setNodeRef: setSortableRef,
    transform,
    transition: sortableTransition,
    isDragging,
  } = useSortable({ id: theme.id })

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition: sortableTransition,
    opacity: isDragging ? 0.5 : 1,
  }

  const showColor = showColorBars && isTheme

  return (
    <section
      ref={setSortableRef}
      style={{ ...sortableStyle, paddingLeft: nestingDepth > 0 ? nestingDepth * 24 : undefined }}
      id={`theme-${theme.id}`}
      aria-label={theme.name}
      className="mb-10 group/theme"
    >
      <div className="flex gap-2">
        {/* Gutter column — drag handle + color bar running full height */}
        <div className="flex flex-col items-center gap-1 pt-1 shrink-0">
          <button
            className="cursor-grab text-mm-text-faint hover:text-mm-text-muted touch-none opacity-0 group-hover/theme:opacity-100 focus:opacity-100 transition-opacity"
            {...sortableAttrs}
            {...sortableListeners}
            aria-label={`Drag to reorder ${theme.name}`}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <div
            className={`flex-1 rounded-full transition-all ${showColorBars ? (isTheme ? 'w-1' : 'w-0.5 bg-mm-border') : 'w-0'}`}
            style={showColorBars && isTheme ? { backgroundColor: themeColor } : undefined}
          />
        </div>

        {/* Content column — header + body share left edge */}
        <div className="flex-1 min-w-0">
          {/* Header row — right-click for context menu */}
          <ContextMenu>
          <ContextMenuTrigger asChild>
          <div className="flex items-center gap-2 mb-3" data-theme-heading>
            <button
              type="button"
              onClick={onToggleCollapse}
              className="shrink-0"
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${theme.name}`}
            >
              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-mm-text-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-mm-text-muted" />}
            </button>

            {/* Theme name */}
            {editingName ? (
              <input
                ref={inputRef}
                value={nameValue}
                onChange={e => setNameValue(e.target.value)}
                onBlur={handleNameSave}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleNameSave()
                  if (e.key === 'Escape') { setNameValue(theme.name); setEditingName(false) }
                }}
                className="text-lg font-bold text-mm-text bg-transparent border-b border-mm-border-medium outline-none flex-1 min-w-0"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="text-lg font-bold text-mm-text hover:text-mm-text-muted text-left flex-1 min-w-0 truncate transition-colors"
                title="Click to rename"
              >
                {theme.name}
              </button>
            )}

            {/* Color picker (themes only, when color bars visible) */}
            {showColor && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="w-4 h-4 rounded-full border border-mm-border shrink-0 opacity-0 group-hover/theme:opacity-100 focus:opacity-100 transition-opacity"
                    style={{ backgroundColor: themeColor }}
                    aria-label={`Change color for ${theme.name}`}
                  />
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <ColorSwatchPicker value={themeColor} onChange={color => onUpdateTheme(theme.id, { color })} />
                </PopoverContent>
              </Popover>
            )}

            {/* Actions (visible on hover) */}
            <div className="flex items-center gap-0.5 opacity-0 group-hover/theme:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
              <button
                type="button"
                onClick={onMoveUp}
                disabled={!canMoveUp}
                className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
                title="Move up"
                aria-label={`Move ${theme.name} up`}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={!canMoveDown}
                className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
                title="Move down"
                aria-label={`Move ${theme.name} down`}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onUpdateTheme(theme.id, { section_type: isTheme ? 'prose' : 'theme' })}
                className="p-1 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg transition-colors"
                title={isTheme ? 'Convert to section' : 'Convert to theme'}
                aria-label={isTheme ? 'Convert to section' : 'Convert to theme'}
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDeleteTheme(theme.id)}
                className="p-1 rounded text-mm-text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                title={`Delete ${isTheme ? 'theme' : 'section'} ${theme.name}`}
                aria-label={`Delete ${isTheme ? 'theme' : 'section'} ${theme.name}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          </ContextMenuTrigger>
          <ThemeContextMenu
            theme={theme}
            isFirst={isFirst}
            isLast={isLast}
            isCollapsed={isCollapsed}
            isTheme={isTheme}
            isFocused={isFocused}
            showColorBars={showColorBars}
            onRename={() => setEditingName(true)}
            onColorChange={color => onUpdateTheme(theme.id, { color })}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onConvert={() => onUpdateTheme(theme.id, { section_type: isTheme ? 'prose' : 'theme' })}
            onToggleCollapse={onToggleCollapse}
            onFocus={isTheme && onFocusTheme ? () => onFocusTheme(theme.id) : undefined}
            onDelete={() => onDeleteTheme(theme.id)}
          />
          </ContextMenu>

          {/* Body — prose editor with animated collapse */}
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-in-out"
            style={{ gridTemplateRows: isCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden min-h-0">
              <div className="text-[13.5px] leading-[1.75]">
                <ThemeEditor
                  content={theme.content}
                  ariaLabel={`Edit ${theme.section_type === 'prose' ? 'section' : 'theme'}: ${theme.name}`}
                  onUpdate={json => onSaveThemeContent(theme.id, json)}
                  onContentChange={onContentChange}
                  insertNodeRef={insertNodeRef}
                  onFocus={onEditorFocus}
                  onSlashCommand={onSlashCommand}
                  mentionItems={mentionItems}
                  onMentionClick={onMentionClick}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Unsorted section (pending items) ─────────────────────────────────────────

interface UnsortedSectionProps {
  pendingItems: PendingItem[]
  onInsertPendingItem: (item: PendingItem) => void
  onRemovePendingItem: (itemId: number) => void
}

function UnsortedSection({ pendingItems, onInsertPendingItem, onRemovePendingItem }: UnsortedSectionProps) {
  return (
    <section id="unsorted-section" aria-label="Unsorted materials awaiting placement" className="mt-8 pt-6 border-t-2 border-dashed border-mm-border">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-mm-text-muted">Unsorted</h3>
        <span className="text-xs text-mm-text-muted bg-mm-bg rounded-full px-2 py-0.5 tabular-nums">
          {pendingItems.length}
        </span>
      </div>

      <p className="text-xs text-mm-text-muted mb-3">
        Items sent from Analysis or Coding views appear here.
      </p>

      <div className="space-y-2 pl-2">
        {pendingItems.map(item => (
          <DraggablePendingItem key={item.id} item={item}>
            <button
              type="button"
              onClick={() => onInsertPendingItem(item)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left rounded-md px-3 py-2 bg-white dark:bg-mm-surface border border-mm-border hover:border-mm-border-medium transition-colors text-sm"
            >
              <span className="text-mm-text-muted shrink-0">
                {PENDING_ICONS[item.item_type] ?? <FileText className="w-3.5 h-3.5" />}
              </span>
              <span className="text-mm-text truncate">
                {PENDING_LABELS[item.item_type] ?? item.item_type} #{item.source_id}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onRemovePendingItem(item.id)}
              className="p-1 rounded text-mm-text-muted hover:text-red-500 transition-colors shrink-0"
              title="Dismiss"
              aria-label="Dismiss pending item"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </DraggablePendingItem>
        ))}
      </div>
    </section>
  )
}

// ── Draggable wrapper for pending items ──────────────────────────────────────

function DraggablePendingItem({ item, children }: { item: PendingItem; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pending-item-${item.id}`,
    data: { pendingItemId: item.id, itemType: item.item_type, sourceId: item.source_id },
  })
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-1 ${isDragging ? 'opacity-40' : ''}`}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}
