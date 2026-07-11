import React, { useState, useRef, useCallback, useEffect, isValidElement, cloneElement } from 'react'
import { Link, useNavigate, useLocation, matchPath } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Sun,
  Moon,
  ChevronRight,
  FileInput,
  Settings,
} from 'lucide-react'
import { ChevronDown, Clock, Users, UserPlus } from 'lucide-react'
// #409: chrome icons are lucide SVGs, not emoji — emoji render as tofu on
// systems without an emoji font (Linux/WSL) and as inconsistent OS art elsewhere.
import {
  Search,
  PenLine,
  StickyNote,
  FileOutput,
  MessageSquare,
  MessageSquareText,
  Table2,
  FileText,
  BarChart3,
  TrendingUp,
  BookOpen,
  Palette,
  Package,
  CircleDot,
  HelpCircle,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react'
import { backupApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { useTheme } from '@/lib/theme-context'
import { useAuth } from '@/lib/auth-context'
import MMLogo from '@/components/MMLogo'
import UpdateStatusBadge from '@/components/UpdateStatusBadge'
import { projectsApi } from '@/lib/api'
import type { Project, ProjectSummary } from '@/lib/api'
import { coderColor } from '@/lib/coder-color'
import { useCoders } from '@/hooks/useCoders'
import { readRevealed } from '@/hooks/useBlindMode'
import { useCoderCoverage } from '@/hooks/useCoderCoverage'
import { useCoderSwitch } from '@/hooks/useCoderSwitch'
import { useCreateCoder } from '@/hooks/useCreateCoder'
import type { BreadcrumbSegment } from '@/layouts/ProjectLayout'

interface TopRailProps {
  project: Project | undefined
  activeWorkspace: string
  isCompact: boolean
  breadcrumbs: BreadcrumbSegment[]
  onSearchOpen: () => void
  onMemosOpen: () => void
  onExportOpen: () => void
  onScratchpadToggle: () => void
  scratchpadCount?: number
}

interface WorkspaceTab {
  id: string
  label: string
  icon: LucideIcon
  path: string
  accent: string
  count?: number
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--mm-green)/0.5)] focus-visible:ring-offset-1'

// Tabs that have dropdown menus
const TABS_WITH_DROPDOWNS = new Set(['conversations', 'datasets', 'documents', 'analysis'])

export default function TopRail({
  project,
  activeWorkspace,
  isCompact,
  breadcrumbs,
  onSearchOpen,
  onMemosOpen,
  onExportOpen,
  onScratchpadToggle,
  scratchpadCount,
}: TopRailProps) {
  const { isDark, toggleTheme } = useTheme()
  const projectBase = project ? `/projects/${project.id}` : ''
  const projectId = project?.id

  // Query project summary for dropdown content (shares cache with OverviewPage)
  const { data: summary } = useQuery({
    queryKey: ['project-summary', projectId],
    queryFn: () => projectsApi.summary(projectId!),
    staleTime: 30_000,
    enabled: !!projectId,
  })

  const tabs: WorkspaceTab[] = [
    { id: 'overview', label: 'Overview', icon: CircleDot, path: 'overview', accent: 'text-mm-text' },
    { id: 'conversations', label: 'Conversations', icon: MessageSquare, path: 'conversations', accent: 'text-mm-green-text', count: project?.conversation_count },
    { id: 'datasets', label: 'Datasets', icon: Table2, path: 'datasets', accent: 'text-mm-orange-text', count: project?.dataset_count },
    { id: 'documents', label: 'Documents', icon: FileText, path: 'documents', accent: 'text-mm-purple-text', count: project?.document_count },
    { id: 'analysis', label: 'Analysis', icon: BarChart3, path: 'analysis', accent: 'text-mm-blue-text' },
  ]

  if (isCompact) {
    return (
      <nav
        role="navigation"
        aria-label="Project workspaces"
        className="bg-[hsl(var(--mm-chrome))] border-b border-white/[0.07] flex items-center h-11 px-3 gap-1 shrink-0"
      >
        <Link to="/" className={`shrink-0 rounded ${FOCUS_RING}`}>
          <MMLogo size={22} />
        </Link>
        <span className="text-white/20 mx-1">/</span>

        {/* Compact tabs */}
        <div className="flex items-center gap-0.5">
          {tabs.map(tab => {
            const isActive = tab.id === activeWorkspace
            const hasDropdown = TABS_WITH_DROPDOWNS.has(tab.id)
            const tabLink = (
              <Link
                to={`${projectBase}/${tab.path}`}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${FOCUS_RING} ${
                  isActive
                    ? `bg-[hsl(var(--mm-bg))] ${tab.accent} font-medium`
                    : 'text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))]'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                <tab.icon className="w-3 h-3" aria-hidden="true" />
                <span className="hidden sm:inline">{tab.label}</span>
              </Link>
            )

            if (hasDropdown && projectBase) {
              return (
                <TabDropdown key={tab.id} tabId={tab.id} projectBase={projectBase} summary={summary}>
                  {tabLink}
                </TabDropdown>
              )
            }

            return <span key={tab.id}>{tabLink}</span>
          })}
        </div>

        {/* Current item name from last breadcrumb (skip if empty/unresolved) */}
        {breadcrumbs.length > 1 && breadcrumbs[breadcrumbs.length - 1].label && (
          <>
            <ChevronRight className="w-3 h-3 text-white/20 mx-1 shrink-0" />
            <span className="text-[hsl(var(--mm-chrome-text))] text-xs truncate" title={breadcrumbs[breadcrumbs.length - 1].label}>
              {breadcrumbs[breadcrumbs.length - 1].label}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onSearchOpen}
            className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label="Search"
          >
            <Search className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={onScratchpadToggle}
            className={`relative p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label="Jot a thought"
          >
            <PenLine className="w-3.5 h-3.5" aria-hidden="true" />
            {(scratchpadCount ?? 0) > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold leading-none px-0.5">
                {scratchpadCount}
              </span>
            )}
          </button>
          <button
            onClick={onMemosOpen}
            className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label="Memos"
          >
            <StickyNote className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          {/* #407: compact-layout Participants entry (icon-only, like its peers) */}
          {projectBase && (
            <Link
              to={`${projectBase}/participants`}
              className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
              aria-label="Participants"
            >
              <Users className="w-3.5 h-3.5" aria-hidden="true" />
            </Link>
          )}
          <button
            onClick={toggleTheme}
            className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <UpdateStatusBadge />
          <BackupStatusBadge />
          <HelpMenu />
          <Link
            to="/settings"
            className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </Link>
          <UserMenu />
        </div>
      </nav>
    )
  }

  return (
    <nav
      role="navigation"
      aria-label="Project workspaces"
      className="bg-[hsl(var(--mm-chrome))] shrink-0"
    >
      {/* Row 1: Breadcrumbs + utilities */}
      <div className="flex items-center h-[38px] px-4 border-b border-white/[0.07]">
        <Link to="/" className={`shrink-0 rounded ${FOCUS_RING}`}>
          <MMLogo size={28} />
        </Link>
        <span className="text-white/20 mx-2">/</span>
        <Link
          to="/"
          className={`text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] text-sm transition-colors rounded ${FOCUS_RING}`}
        >
          Projects
        </Link>

        {breadcrumbs.filter(c => c.label).map((crumb) => (
          <span key={crumb.to || crumb.label} className="flex items-center">
            <span className="text-white/20 mx-2">/</span>
            {crumb.to ? (
              <Link
                to={crumb.to}
                className={`text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] text-sm transition-colors truncate max-w-[200px] rounded ${FOCUS_RING}`}
              >
                {crumb.label}
              </Link>
            ) : (
              <span className="text-[hsl(var(--mm-chrome-text))] text-sm font-medium truncate max-w-[200px]" title={crumb.label}>
                {crumb.label}
              </span>
            )}
          </span>
        ))}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onSearchOpen}
            className={`inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/[0.07] rounded-[5px] px-3 py-1 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.1] transition-colors ${FOCUS_RING}`}
            title="Search (Ctrl+K)"
          >
            {/* #394: no aria-label — let the accessible name come from the visible
                text ("Search Ctrl+K") so it can't mismatch (WCAG 2.5.3 label-in-name). */}
            <Search className="w-3 h-3" aria-hidden="true" />
            Search
            <kbd className="ml-1 text-[10px]">Ctrl+K</kbd>
          </button>
          {/* #407: the participant spine needs a global nav entry — it was
              reachable only from the Overview button or by URL. */}
          {projectBase && (
            <Link
              to={`${projectBase}/participants`}
              className={`inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/[0.07] rounded-[5px] px-3 py-1 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.1] transition-colors ${FOCUS_RING}`}
            >
              <Users className="w-3 h-3" aria-hidden="true" />
              Participants
            </Link>
          )}
          <button
            onClick={onMemosOpen}
            className={`inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/[0.07] rounded-[5px] px-3 py-1 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.1] transition-colors ${FOCUS_RING}`}
            aria-label="Memos"
          >
            <StickyNote className="w-3 h-3" aria-hidden="true" />
            Memos
          </button>
          <button
            onClick={onScratchpadToggle}
            className={`relative inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/[0.07] rounded-[5px] px-3 py-1 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.1] transition-colors ${FOCUS_RING}`}
            aria-label="Jot a thought"
          >
            <PenLine className="w-3 h-3" aria-hidden="true" />
            Jot
            {(scratchpadCount ?? 0) > 0 && (
              <span className="min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none px-1">
                {scratchpadCount}
              </span>
            )}
          </button>
          <button
            onClick={onExportOpen}
            className={`inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/[0.07] rounded-[5px] px-3 py-1 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.1] transition-colors ${FOCUS_RING}`}
            aria-label="Export"
          >
            <FileOutput className="w-3 h-3" aria-hidden="true" />
            Export
          </button>
          <button
            onClick={toggleTheme}
            className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <UpdateStatusBadge />
          <BackupStatusBadge />
          <HelpMenu />
          <Link
            to="/settings"
            className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
            aria-label="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </Link>
          <UserMenu />
        </div>
      </div>

      {/* Row 2: Workspace tabs */}
      <div className="flex items-end h-10 px-4 gap-1">
        {tabs.map(tab => {
          const isActive = tab.id === activeWorkspace
          const hasDropdown = TABS_WITH_DROPDOWNS.has(tab.id)
          const tabLink = (
            <Link
              to={`${projectBase}/${tab.path}`}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-t-lg text-sm transition-colors ${FOCUS_RING} ${
                isActive
                  ? `bg-[hsl(var(--mm-bg))] ${tab.accent} font-medium`
                  : 'text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))]'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <tab.icon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 && (
                <span className={`text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-full ${
                  isActive ? `bg-white/20 ${tab.accent}` : 'bg-white/10 text-[hsl(var(--mm-chrome-text-muted))]'
                }`}>
                  {tab.count}
                </span>
              )}
            </Link>
          )

          if (hasDropdown && projectBase) {
            return (
              <TabDropdown key={tab.id} tabId={tab.id} projectBase={projectBase} summary={summary}>
                {tabLink}
              </TabDropdown>
            )
          }

          return <span key={tab.id}>{tabLink}</span>
        })}
      </div>
    </nav>
  )
}


// ── Tab Dropdown ─────────────────────────────────────────────────────────────

const DROPDOWN_ITEM = 'flex items-center gap-2 w-full px-3 py-1.5 text-[13px] rounded-sm text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.08] transition-colors cursor-pointer text-left'
const DROPDOWN_SEPARATOR = 'my-1 border-t border-white/[0.07]' // used with role="separator"

function TabDropdown({
  tabId,
  projectBase,
  summary,
  children,
}: {
  tabId: string
  projectBase: string
  summary: ProjectSummary | undefined
  children: React.ReactNode
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const openTimerRef = useRef<number>(undefined)
  const closeTimerRef = useRef<number>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Check for pointer device support (hover-capable)
  const supportsHover = useRef(
    typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches
  )

  const handleEnter = useCallback(() => {
    if (!supportsHover.current) return
    clearTimeout(closeTimerRef.current)
    openTimerRef.current = window.setTimeout(() => setOpen(true), 200)
  }, [])

  const handleLeave = useCallback(() => {
    if (!supportsHover.current) return
    clearTimeout(openTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 300)
  }, [])

  // Close on Escape (scoped to container to avoid interfering with other listeners)
  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handleClick)
    }
  }, [open])

  // Focus first menu item when dropdown opens
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      first?.focus()
    })
  }, [open])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      clearTimeout(openTimerRef.current)
      clearTimeout(closeTimerRef.current)
    }
  }, [])

  const go = useCallback((path: string) => {
    setOpen(false)
    navigate(path)
  }, [navigate])

  // Keyboard navigation within the menu
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
    if (!items?.length) return

    const currentIndex = Array.from(items).indexOf(e.target as HTMLElement)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0
      items[next].focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1
      items[prev].focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0].focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1].focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }, [])

  // Inject aria-haspopup and aria-expanded onto the trigger element
  const trigger = isValidElement(children)
    ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-haspopup': 'menu' as const,
        'aria-expanded': open,
      })
    : children

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {trigger}
      {open && (
        <div
          ref={menuRef}
          className="absolute top-full left-0 z-[100] pt-0.5"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <div
            className="min-w-[200px] rounded-md border border-white/[0.12] bg-[hsl(var(--mm-chrome))] shadow-lg py-1"
            role="menu"
            aria-label={`${tabId} quick navigation`}
            onKeyDown={handleMenuKeyDown}
          >
            {tabId === 'conversations' && (
              <ConversationsDropdown projectBase={projectBase} summary={summary} go={go} />
            )}
            {tabId === 'datasets' && (
              <DatasetsDropdown projectBase={projectBase} summary={summary} go={go} />
            )}
            {tabId === 'documents' && (
              <DocumentsDropdown projectBase={projectBase} summary={summary} go={go} />
            )}
            {tabId === 'analysis' && (
              <AnalysisDropdown projectBase={projectBase} go={go} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ConversationsDropdown({
  projectBase,
  summary,
  go,
}: {
  projectBase: string
  summary: ProjectSummary | undefined
  go: (path: string) => void
}) {
  return (
    <>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/conversations`)}>
        <MessageSquare className="w-3 h-3" /> All Conversations
      </button>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/conversations/import`)}>
        <FileInput className="w-3 h-3" /> Import
      </button>
      {summary && summary.recent_conversations.length > 0 && (
        <>
          <div className={DROPDOWN_SEPARATOR} role="separator" />
          <div className="px-3 py-1 text-[11px] font-medium text-white/30 uppercase tracking-wider" role="presentation">
            Recent
          </div>
          {summary.recent_conversations.map(c => (
            <button
              key={c.id}
              role="menuitem"
              className={DROPDOWN_ITEM}
              onClick={() => go(`${projectBase}/conversations/${c.id}`)}
              /* #351/#352: counts now exclude facilitator turns. aria-label
               * carries the participant qualifier so screen readers don't
               * announce a bare ratio without context. */
              aria-label={`${c.name}: ${c.coded_segment_count} of ${c.segment_count} participant segments coded`}
              title="Facilitator segments are excluded from coding progress."
            >
              <span className="truncate flex-1">{c.name}</span>
              <span className="text-[11px] text-white/30 font-mono tabular-nums shrink-0">
                {c.coded_segment_count}/{c.segment_count}
              </span>
            </button>
          ))}
        </>
      )}
    </>
  )
}

function DatasetsDropdown({
  projectBase,
  summary,
  go,
}: {
  projectBase: string
  summary: ProjectSummary | undefined
  go: (path: string) => void
}) {
  return (
    <>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/datasets`)}>
        <Table2 className="w-3 h-3" /> All Datasets
      </button>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/datasets/import`)}>
        <FileInput className="w-3 h-3" /> Import
      </button>
      <div className={DROPDOWN_SEPARATOR} role="separator" />
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/datasets/variable-groups`)}>
        <Package className="w-3 h-3" /> Variable Groups
      </button>
      {summary && (summary.open_ended_columns ?? 0) > 0 && (
        <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/datasets/text-coding`)}>
          <MessageSquareText className="w-3 h-3" /> Code Text
        </button>
      )}
      {summary && summary.recent_datasets.length > 0 && (
        <>
          <div className={DROPDOWN_SEPARATOR} role="separator" />
          <div className="px-3 py-1 text-[11px] font-medium text-white/30 uppercase tracking-wider" role="presentation">
            Recent
          </div>
          {summary.recent_datasets.map(d => (
            <button
              key={d.id}
              role="menuitem"
              className={DROPDOWN_ITEM}
              onClick={() => go(`${projectBase}/datasets/${d.id}`)}
            >
              <span className="truncate flex-1">{d.name}</span>
              <span className="text-[11px] text-white/30 font-mono tabular-nums shrink-0">
                {d.row_count} rows
              </span>
            </button>
          ))}
        </>
      )}
    </>
  )
}

function DocumentsDropdown({
  projectBase,
  summary,
  go,
}: {
  projectBase: string
  summary: ProjectSummary | undefined
  go: (path: string) => void
}) {
  return (
    <>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/documents`)}>
        <FileText className="w-3 h-3" /> All Documents
      </button>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/documents/import`)}>
        <FileInput className="w-3 h-3" /> Import
      </button>
      {summary && summary.recent_documents && summary.recent_documents.length > 0 && (
        <>
          <div className={DROPDOWN_SEPARATOR} role="separator" />
          <div className="px-3 py-1 text-[11px] font-medium text-white/30 uppercase tracking-wider" role="presentation">
            Recent
          </div>
          {summary.recent_documents.map(d => (
            <button
              key={d.id}
              role="menuitem"
              className={DROPDOWN_ITEM}
              onClick={() => go(`${projectBase}/documents/${d.id}`)}
            >
              <span className="truncate flex-1">{d.name}</span>
              <span className="text-[11px] text-white/30 font-mono tabular-nums shrink-0">
                {d.coded_segment_count}/{d.segment_count}
              </span>
            </button>
          ))}
        </>
      )}
    </>
  )
}

function AnalysisDropdown({
  projectBase,
  go,
}: {
  projectBase: string
  go: (path: string) => void
}) {
  return (
    <>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/analysis/qualitative`)}>
        <Search className="w-3 h-3" /> Qualitative
      </button>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/analysis/quantitative`)}>
        <TrendingUp className="w-3 h-3" /> Quantitative
      </button>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/analysis/codebook`)}>
        <BookOpen className="w-3 h-3" /> Codebook
      </button>
      <button role="menuitem" className={DROPDOWN_ITEM} onClick={() => go(`${projectBase}/analysis/canvas`)}>
        <Palette className="w-3 h-3" /> Canvas
      </button>
    </>
  )
}


function HelpMenu() {
  // #411: the one global help affordance — a quiet popover, not a tour.
  // Content is in-app (the desktop posture must not depend on the network);
  // the worked-example pointer is the only outbound link.
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`p-2 rounded text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Help and getting started"
        title="Help & getting started"
      >
        <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Getting started"
          className="absolute right-0 top-full mt-1 w-80 rounded-md border border-white/[0.1] bg-[hsl(var(--mm-chrome))] shadow-lg z-50 p-3 text-left"
        >
          <div className="text-xs font-semibold text-[hsl(var(--mm-chrome-text))] mb-1.5">
            Getting started
          </div>
          <p className="text-[11px] leading-relaxed text-[hsl(var(--mm-chrome-text-muted))] mb-2">
            Mixed Measures keeps qualitative and quantitative work in one project.
            A typical flow:
          </p>
          <ol className="text-[11px] leading-relaxed text-[hsl(var(--mm-chrome-text-muted))] list-decimal pl-4 space-y-0.5 mb-2">
            <li>Import transcripts, documents, or survey CSVs from each workspace tab</li>
            <li>Build a codebook and code your conversations and documents</li>
            <li>Link speakers and dataset records to participants — one person, all their data</li>
            <li>Analyze: charts, statistics, and qualitative patterns</li>
            <li>Compose findings on the Canvas and export</li>
          </ol>
          <p className="text-[11px] leading-relaxed text-[hsl(var(--mm-chrome-text-muted))] mb-2">
            Prefer to explore first? Download the Ferncrest example project from{' '}
            <a
              href="https://mixedmeasures.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[hsl(var(--mm-chrome-text))] underline underline-offset-2 hover:opacity-80"
            >
              mixedmeasures.com
              <ExternalLink className="inline w-2.5 h-2.5 ml-0.5 align-baseline" aria-hidden="true" />
            </a>{' '}
            and open it with Import Project on the Projects page.
          </p>
          <p className="text-[11px] leading-relaxed text-[hsl(var(--mm-chrome-text-muted))] mb-2">
            Publishing with Mixed Measures? Copy a citation for the version you analyzed
            with from{' '}
            <Link
              to="/settings"
              onClick={() => setOpen(false)}
              className="text-[hsl(var(--mm-chrome-text))] underline underline-offset-2 hover:opacity-80"
            >
              Settings → About &amp; citation
            </Link>
            .
          </p>
          <p className="text-[11px] text-[hsl(var(--mm-chrome-text-muted))]">
            Press <kbd className="px-1 rounded bg-white/[0.08] text-[10px]">?</kbd> for keyboard
            shortcuts, <kbd className="px-1 rounded bg-white/[0.08] text-[10px]">Ctrl+K</kbd> to search.
          </p>
        </div>
      )}
    </div>
  )
}


function UserMenu() {
  // Track J · J1: a passwordless coder roster. The menu surfaces the active coder,
  // lets you switch to (or create) another, and links to Settings. Attribution /
  // who-coded-what reads the active coder; switching re-points it server-side.
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setCreating(false)
    setNewName('')
  }, [])

  const { coders, multiCoder } = useCoders()

  // #3 — per-source "coded here" markers in the switcher. The TopRail is global,
  // so this only scopes to a single conversation/document we can read from the
  // route (on Overview/Analysis there's no source). Dataset/text-coding is deferred:
  // its coverage keys on text columns, which aren't in the URL.
  const location = useLocation()
  const convMatch = matchPath('/projects/:projectId/conversations/:conversationId', location.pathname)
  const docMatch = matchPath('/projects/:projectId/documents/:documentId', location.pathname)
  const conversationId = convMatch && /^\d+$/.test(convMatch.params.conversationId ?? '')
    ? Number(convMatch.params.conversationId) : undefined
  const documentId = docMatch && /^\d+$/.test(docMatch.params.documentId ?? '')
    ? Number(docMatch.params.documentId) : undefined
  const projMatch = matchPath('/projects/:projectId/*', location.pathname)
  const sourceProjectId = projMatch ? Number(projMatch.params.projectId) : undefined
  const inSource = conversationId != null || documentId != null

  // Blind mode hides colleague coding-presence (DEC-G). Mirror the #457 picklist:
  // the whole coverage UI is hidden while blind and returns on reveal — never leak
  // which colleagues coded a source while you're coding independently. Read the
  // flag fresh each render (not a useBlindMode instance) so a reveal/blind toggle
  // in the workbench is reflected the next time this transient menu opens.
  const revealed = sourceProjectId != null && user ? readRevealed(sourceProjectId, user.id) : false
  const blind = multiCoder && !revealed
  const coverage = useCoderCoverage(
    sourceProjectId ?? 0,
    { conversationId, documentId },
    { enabled: open && inSource && multiCoder && !blind, rosterCoderIds: coders.map(c => c.id) },
  )
  const showCoverage = !blind && inSource && multiCoder && coverage.isLoaded
  const sourceNoun = conversationId != null ? 'this conversation' : 'this document'
  const rosterCodedCount = coders.filter(c => coverage.activeCoderIds.has(c.id)).length

  // #459/#460 — shared switch-with-confirm flow (also used by Settings + Dashboard).
  const { requestSwitch, dialog: switchDialog, switching } = useCoderSwitch({ onSwitched: closeMenu })

  // #530 — shared create flow (also used by Settings + the Dashboard switcher).
  const createMutation = useCreateCoder({
    onCreated: (coder) => {
      setNewName('')
      setCreating(false)
      // Creating a coder is already an explicit choice — skip the switch confirm.
      requestSwitch({ id: coder.id, username: coder.username }, { skipConfirm: true })
    },
  })

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, closeMenu])

  if (!user) return null

  const others = coders.filter(c => c.id !== user.id)
  const itemClass =
    'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] hover:bg-white/[0.06] transition-colors'

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => (open ? closeMenu() : setOpen(true))}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[hsl(var(--mm-chrome-text-muted))] hover:text-[hsl(var(--mm-chrome-text))] transition-colors ${FOCUS_RING}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${user.username} — Coder menu`}
      >
        <span
          className="w-2 h-2 rounded-full flex-none"
          style={{ backgroundColor: coderColor({ id: user.id, display_color: user.display_color }) }}
          aria-hidden="true"
        />
        <span className="max-w-[80px] truncate">{user.username}</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-56 rounded-md border border-white/[0.1] bg-[hsl(var(--mm-chrome))] shadow-lg z-50 py-1"
        >
          <div className="px-3 py-1.5 text-[10px] text-[hsl(var(--mm-chrome-text-muted))]">
            Coding as <span className="font-medium text-[hsl(var(--mm-chrome-text))]">{user.username}</span>
          </div>
          {others.length > 0 && (
            <>
              <div role="separator" className="my-1 border-t border-white/[0.07]" />
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[hsl(var(--mm-chrome-text-muted))]/70">
                Switch coder
              </div>
              {showCoverage && (
                <div className="px-3 pb-1 -mt-0.5 text-[10px] text-[hsl(var(--mm-chrome-text-muted))]/70">
                  {rosterCodedCount} of {coders.length} coded {sourceNoun}
                  {coverage.extraCoders.length > 0 && ` · +${coverage.extraCoders.length} archived`}
                </div>
              )}
              {others.map(c => (
                <button
                  key={c.id}
                  role="menuitem"
                  onClick={() => requestSwitch({ id: c.id, username: c.username })}
                  disabled={switching}
                  className={itemClass}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-none"
                    style={{ backgroundColor: coderColor(c) }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{c.username}</span>
                  {showCoverage && coverage.activeCoderIds.has(c.id) && (
                    <span
                      className="ml-auto text-[10px] text-emerald-400 whitespace-nowrap"
                      title={`${c.username} has coded ${sourceNoun}`}
                    >
                      coded here
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
          <div role="separator" className="my-1 border-t border-white/[0.07]" />
          {creating ? (
            <form
              onSubmit={e => {
                e.preventDefault()
                const n = newName.trim()
                if (n) createMutation.mutate(n)
              }}
              className="px-3 py-1.5"
            >
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="New coder name…"
                maxLength={50}
                aria-label="New coder name"
                className={`w-full rounded bg-white/[0.06] px-2 py-1 text-xs text-[hsl(var(--mm-chrome-text))] placeholder:text-[hsl(var(--mm-chrome-text-muted))]/60 outline-none ${FOCUS_RING}`}
              />
            </form>
          ) : (
            <button role="menuitem" onClick={() => setCreating(true)} className={itemClass}>
              <UserPlus className="w-3 h-3" />
              New coder
            </button>
          )}
          <div role="separator" className="my-1 border-t border-white/[0.07]" />
          <Link role="menuitem" to="/settings" onClick={closeMenu} className={itemClass}>
            <Settings className="w-3 h-3" />
            Coder settings
          </Link>
        </div>
      )}
      {switchDialog}
    </div>
  )
}


function _formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return ''
  }
}


function BackupStatusBadge() {
  // #357: replace the amber-only-when-stale dot with an always-visible
  // Clock icon. Gray when fresh, amber when stale (>24h preserved).
  // Tooltip carries the full freshness text so researchers don't have to
  // visit Settings to know how recent their last backup is.
  const { data } = useQuery({
    queryKey: ['backup-status'],
    queryFn: backupApi.status,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
  if (!data) return null

  let tooltipText: string
  if (!data.last_backup_at) {
    tooltipText = 'No backups yet'
  } else {
    const rel = formatRelativeTime(data.last_backup_at)
    const next = data.next_backup_at ? _formatTimeShort(data.next_backup_at) : null
    tooltipText = next
      ? `Last backup ${rel} · Next auto at ${next}`
      : `Last backup ${rel}`
  }

  const iconColorClass = data.is_stale
    ? 'text-amber-400'
    : 'text-[hsl(var(--mm-chrome-text-muted))]'

  return (
    <Link
      to="/settings"
      className={`p-2 rounded transition-colors ${FOCUS_RING}`}
      title={tooltipText}
      aria-label={tooltipText}
    >
      <Clock className={`w-3.5 h-3.5 ${iconColorClass}${data.is_stale ? ' animate-pulse' : ''}`} aria-hidden />
    </Link>
  )
}
