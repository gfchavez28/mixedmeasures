import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import SegmentedControl from '@/components/ui/segmented-control'
import FocusPill from '@/components/qualitative-analysis/FocusPill'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import MemosPanelContent from '@/components/MemosPanelContent'
import AllNotesPanel from '@/components/AllNotesPanel'
import ScratchpadSection from '@/components/ScratchpadSection'

type ViewMode = 'memos' | 'both' | 'notes'

const VIEW_TABS: { value: ViewMode; label: string }[] = [
  { value: 'memos', label: 'Memos' },
  { value: 'both', label: 'Both' },
  { value: 'notes', label: 'Notes' },
]

export default function MemosNotesPage() {
  const { projectId } = useProjectLayout()
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState('')
  const [isScratchpadExpanded, setIsScratchpadExpanded] = useState(false)
  const memosRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const announceRef = useRef<HTMLDivElement>(null)

  const rawView = searchParams.get('view')
  const view: ViewMode = rawView === 'memos' || rawView === 'both' || rawView === 'notes' ? rawView : 'memos'

  const setView = useCallback((v: ViewMode) => {
    setSearchParams({ view: v }, { replace: true })
  }, [setSearchParams])

  // Suppress panel flex animation on initial page load
  const [shouldAnimate, setShouldAnimate] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- enable animation after initial render
  useEffect(() => { setShouldAnimate(true) }, [])

  // Focus management on tab switch
  useEffect(() => {
    if (view === 'memos' || view === 'both') {
      memosRef.current?.focus()
    } else {
      notesRef.current?.focus()
    }
  }, [view])

  const searchPlaceholder = useMemo(() => {
    const parts: string[] = []
    if (isScratchpadExpanded) parts.push('scratchpad')
    if (view === 'memos' || view === 'both') parts.push('memos')
    if (view === 'notes' || view === 'both') parts.push('notes')
    if (parts.length <= 1) return `Search ${parts[0] || 'memos'}...`
    if (parts.length === 2) return `Search ${parts[0]} and ${parts[1]}...`
    return `Search ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}...`
  }, [view, isScratchpadExpanded])

  // --- Focus mode state ---
  const [focusedType, setFocusedType] = useState<string | null>(null)
  const [focusedEntityId, setFocusedEntityId] = useState<number | null>(null)
  const [focusedLabel, setFocusedLabel] = useState('')
  const [focusedColor, setFocusedColor] = useState('#6b7280')

  const handleFocus = useCallback((type: string, entityId: number | null, label: string, color: string) => {
    // Toggle off if clicking same focus target
    if (focusedType === type && focusedEntityId === entityId) {
      setFocusedType(null)
      setFocusedEntityId(null)
      return
    }
    setFocusedType(type)
    setFocusedEntityId(entityId)
    setFocusedLabel(label)
    setFocusedColor(color)
  }, [focusedType, focusedEntityId])

  const clearFocus = useCallback(() => {
    setFocusedType(null)
    setFocusedEntityId(null)
  }, [])

  // Escape key to clear focus
  useEffect(() => {
    if (!focusedType) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        clearFocus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [focusedType, clearFocus])

  // Announce focus changes
  useEffect(() => {
    if (announceRef.current) {
      announceRef.current.textContent = focusedType
        ? `Focused on ${focusedLabel}`
        : ''
    }
  }, [focusedType, focusedLabel])

  const panelTransition: React.CSSProperties = shouldAnimate ? {
    transitionProperty: 'flex-grow',
    transitionDuration: '250ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  } : {}

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b bg-mm-bg flex-shrink-0">
        <h1 className="text-sm font-semibold text-mm-text">Memos & Notes</h1>

        <SegmentedControl
          options={VIEW_TABS}
          value={view}
          onChange={setView}
          ariaLabel="View mode"
          idPrefix="mn-view"
        />

        {/* Focus pill */}
        {focusedType && (
          <FocusPill
            codeName={focusedLabel}
            codeColor={focusedColor}
            onClear={clearFocus}
          />
        )}

        {/* Unified search */}
        <div className="relative flex-1 max-w-xs ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8 h-8 text-sm bg-mm-surface"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-mm-text-muted hover:text-mm-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* SR announcements */}
      <div ref={announceRef} aria-live="polite" className="sr-only" />

      {/* Scratchpad triage section */}
      <ScratchpadSection
        projectId={projectId}
        search={searchInput}
        onExpandedChange={setIsScratchpadExpanded}
      />

      {/* Panel content */}
      <div className="flex-1 overflow-hidden flex flex-col md:flex-row bg-mm-surface">
        {/* Memos panel */}
        <div
          ref={memosRef}
          role="tabpanel"
          id="panel-memos"
          aria-labelledby="mn-view-memos"
          aria-hidden={view === 'notes'}
          tabIndex={-1}
          className={`flex flex-col overflow-hidden ${
            view === 'both' ? 'border-b md:border-b-0 md:border-r border-mm-border-medium' : ''
          }`}
          style={{
            flexGrow: view === 'notes' ? 0 : 1,
            flexShrink: 0,
            flexBasis: 0,
            minWidth: 0,
            minHeight: 0,
            ...panelTransition,
          }}
        >
          <MemosPanelContent
            projectId={projectId}
            search={searchInput}
            focusedType={focusedType}
            focusedEntityId={focusedEntityId}
            onFocus={handleFocus}
          />
        </div>

        {/* Notes panel */}
        <div
          ref={notesRef}
          role="tabpanel"
          id="panel-notes"
          aria-labelledby="mn-view-notes"
          aria-hidden={view === 'memos'}
          tabIndex={-1}
          className="flex flex-col overflow-hidden"
          style={{
            flexGrow: view === 'memos' ? 0 : 1,
            flexShrink: 0,
            flexBasis: 0,
            minWidth: 0,
            minHeight: 0,
            ...panelTransition,
          }}
        >
          <AllNotesPanel
            projectId={projectId}
            search={searchInput}
            focusedType={focusedType}
            focusedEntityId={focusedEntityId}
            onFocus={handleFocus}
          />
        </div>
      </div>
    </div>
  )
}
