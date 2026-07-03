import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Outlet, useParams, useLocation, useOutletContext } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { projectsApi, scratchpadApi, type Project, type Conversation, type Dataset, type DatasetDataResponse, type DatasetList } from '@/lib/api'
import TopRail from '@/components/TopRail'
import { PageErrorBoundary } from '@/components/PageErrorBoundary'
import SearchPopover from '@/components/SearchPopover'
import CodebookSlideOut from '@/components/CodebookSlideOut'
import MemosSlideOut from '@/components/MemosSlideOut'
import ScratchpadPopover from '@/components/ScratchpadPopover'
import ExportDialog from '@/components/ExportDialog'
import KeyboardHelpDialog from '@/components/KeyboardHelpDialog'
import { detectWorkspace } from './workspace'
// Toaster moved to App.tsx

export interface BreadcrumbSegment {
  label: string
  to?: string
}

export interface ProjectLayoutContext {
  project: Project | undefined
  projectId: number
  isCompact: boolean
  openSearch: () => void
  openCodebook: () => void
  closeCodebook: () => void
  openMemos: () => void
  closeMemos: () => void
  isCodebookOpen: boolean
  isMemosOpen: boolean
  setBreadcrumbLabel: (label: string) => void
}

// eslint-disable-next-line react-refresh/only-export-components
export function useProjectLayout() {
  return useOutletContext<ProjectLayoutContext>()
}

function detectCompact(pathname: string): boolean {
  // Compact for immersive workspaces: conversation coding, dataset views,
  // text coding, codebook (spatial canvas needs maximum vertical space),
  // document coding
  return /\/conversations\/\d+/.test(pathname) ||
    /\/datasets\/\d+/.test(pathname) ||
    /\/datasets\/text-coding/.test(pathname) ||
    /\/documents\/\d+/.test(pathname) ||
    /\/analysis\/codebook/.test(pathname) ||
    /\/analysis\/canvas/.test(pathname)
}

function deriveBreadcrumbs(pathname: string, projectName: string | undefined, projectId: number): BreadcrumbSegment[] {
  const crumbs: BreadcrumbSegment[] = []
  const base = `/projects/${projectId}`

  // Always start with project name
  crumbs.push({ label: projectName || 'Project', to: `${base}/overview` })

  const relPath = pathname.replace(base, '').replace(/^\//, '')
  const segments = relPath.split('/').filter(Boolean)

  if (segments.length === 0 || segments[0] === 'overview') return crumbs

  // Special-case label map for hyphenated routes
  const SPECIAL_LABELS: Record<string, string> = {
    'memos-notes': 'Memos & Notes',
  }

  // Workspace-level breadcrumb
  const workspace = segments[0]
  const workspaceLabel = SPECIAL_LABELS[workspace] ?? (workspace.charAt(0).toUpperCase() + workspace.slice(1))

  if (segments.length === 1) {
    crumbs.push({ label: workspaceLabel })
  } else {
    crumbs.push({ label: workspaceLabel, to: `${base}/${workspace}` })
  }

  // Sub-segments
  if (segments.length >= 2) {
    const sub = segments[1]
    if (sub === 'import') {
      crumbs.push({ label: 'Import' })
    } else if (sub === 'variable-groups') {
      crumbs.push({ label: 'Variable Groups' })
    } else if (sub === 'text-coding') {
      crumbs.push({ label: 'Code Text' })
    } else if (sub === 'qualitative') {
      crumbs.push({ label: 'Qualitative' })
    } else if (sub === 'quantitative') {
      crumbs.push({ label: 'Quantitative' })
    } else if (sub === 'canvas') {
      crumbs.push({ label: 'Canvas' })
    } else if (sub === 'codebook') {
      crumbs.push({ label: 'Codebook' })
    } else if (/^\d+$/.test(sub)) {
      // Entity ID — resolved by cache lookup or child setBreadcrumbLabel
      if (segments.length >= 3) {
        crumbs.push({ label: '', to: `${base}/${workspace}/${sub}` })
        const action = segments[2]
        if (action === 'recode') crumbs.push({ label: 'Recode' })
        else if (action === 'append') crumbs.push({ label: 'Append' })
      } else {
        crumbs.push({ label: '' })
      }
    }
  }

  return crumbs
}

/** Synchronous cache lookup for entity names — avoids breadcrumb flash */
function resolveEntityName(
  workspace: string,
  entityId: number,
  projectId: number,
  queryClient: ReturnType<typeof useQueryClient>,
): string {
  if (workspace === 'conversations') {
    const conv = queryClient.getQueryData<Conversation>(['conversation', projectId, entityId])
    if (conv?.name) return conv.name
    const list = queryClient.getQueryData<{ conversations: Conversation[]; total: number }>(['conversations', projectId])
    return list?.conversations.find(c => c.id === entityId)?.name || ''
  }
  if (workspace === 'datasets') {
    const dsData = queryClient.getQueryData<DatasetDataResponse>(['dataset-data', projectId, entityId])
    if (dsData?.dataset?.name) return dsData.dataset.name
    const ds = queryClient.getQueryData<Dataset>(['dataset', projectId, entityId])
    if (ds?.name) return ds.name
    const list = queryClient.getQueryData<DatasetList>(['datasets', projectId])
    return list?.datasets.find(d => d.id === entityId)?.name || ''
  }
  if (workspace === 'documents') {
    const doc = queryClient.getQueryData<{ name: string }>(['document', projectId, entityId])
    if (doc?.name) return doc.name
    const docList = queryClient.getQueryData<{ id: number; name: string }[]>(['documents', projectId])
    return docList?.find(d => d.id === entityId)?.name || ''
  }
  return ''
}

export default function ProjectLayout() {
  const { projectId: pidStr } = useParams()
  const projectId = Number(pidStr)
  const location = useLocation()
  const queryClient = useQueryClient()

  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isCodebookOpen, setIsCodebookOpen] = useState(false)
  const [isMemosOpen, setIsMemosOpen] = useState(false)
  const [isExportOpen, setIsExportOpen] = useState(false)
  const [isKeyboardHelpOpen, setIsKeyboardHelpOpen] = useState(false)
  const [isScratchpadOpen, setIsScratchpadOpen] = useState(false)
  const [scratchpadDraft, setScratchpadDraft] = useState('')
  const [scratchpadContext, setScratchpadContext] = useState('')

  // Overlay z-index ordering: most recently opened overlay goes on top
  const overlayZCounter = useRef(50)
  const [codebookZ, setCodebookZ] = useState(50)
  const [memosZ, setMemosZ] = useState(50)
  const [scratchpadZ, setScratchpadZ] = useState(50)
  const bringToFront = useCallback((setter: React.Dispatch<React.SetStateAction<number>>) => {
    overlayZCounter.current += 1
    setter(overlayZCounter.current)
  }, [])

  const [breadcrumbLabel, setBreadcrumbLabelState] = useState('')

  // Reset breadcrumb label when pathname changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale breadcrumb on navigation
    setBreadcrumbLabelState('')
  }, [location.pathname])

  const setBreadcrumbLabel = useCallback((label: string) => {
    setBreadcrumbLabelState(label)
  }, [])

  const { data: project, error: projectError } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => projectsApi.get(projectId),
    enabled: !isNaN(projectId),
  })

  const activeWorkspace = detectWorkspace(location.pathname)
  const isCompact = detectCompact(location.pathname)

  // Derive memo context from current page
  const memoContext = useMemo(() => {
    const path = location.pathname
    // /conversations/:cid
    const convMatch = path.match(/\/conversations\/(\d+)/)
    if (convMatch) return { entityType: 'conversation', entityId: Number(convMatch[1]) }
    // /datasets/:did (numeric only, not /datasets/text-coding etc.)
    const dsMatch = path.match(/\/datasets\/(\d+)/)
    if (dsMatch) return { entityType: 'dataset', entityId: Number(dsMatch[1]) }
    // /analysis/quantitative
    if (path.includes('/analysis/quantitative')) return { entityType: 'analysis' as const, entityId: null }
    // /analysis/canvas
    const canvasMatch = path.match(/\/analysis\/canvas/)
    if (canvasMatch) return { entityType: 'canvas' as const, entityId: null }
    // Fallback: project
    return { entityType: 'project', entityId: projectId }
  }, [location.pathname, projectId])

  // Context hint for scratchpad — human-readable string from current page
  const contextHintLabel = useMemo(() => {
    const path = location.pathname
    const search = location.search
    if (/\/conversations\/\d+/.test(path)) return breadcrumbLabel ? `Conversation: ${breadcrumbLabel}` : 'Conversation'
    if (/\/datasets\/\d+/.test(path)) return breadcrumbLabel ? `Dataset: ${breadcrumbLabel}` : 'Dataset'
    if (path.includes('/datasets/text-coding')) return 'Code Text'
    if (path.includes('/analysis/quantitative')) {
      if (search.includes('tab=rc')) return 'Relationships & Comparisons'
      return 'Quantitative Analysis'
    }
    if (path.includes('/analysis/qualitative')) return 'Qualitative Analysis'
    if (path.includes('/analysis/canvas')) return breadcrumbLabel ? `Canvas: ${breadcrumbLabel}` : 'Canvas'
    if (path.includes('/memos-notes')) return 'Memos & Notes'
    return 'Project overview'
  }, [location.pathname, location.search, breadcrumbLabel])

  // Scratchpad count query (unresolved entries)
  const { data: scratchpadData } = useQuery({
    queryKey: ['scratchpad', projectId, false],
    queryFn: () => scratchpadApi.list(projectId, false),
    enabled: !isNaN(projectId),
  })
  const scratchpadCount = scratchpadData?.total ?? 0

  const breadcrumbs = useMemo(() => {
    const crumbs = deriveBreadcrumbs(location.pathname, project?.name, projectId)
    // Resolve empty entity placeholder from child state or query cache
    for (let i = crumbs.length - 1; i >= 0; i--) {
      if (crumbs[i].label === '') {
        const name = breadcrumbLabel || resolveEntityName(
          detectWorkspace(location.pathname),
          Number(location.pathname.match(/\/(conversations|datasets)\/(\d+)/)?.[2] || '0'),
          projectId,
          queryClient,
        )
        if (name) crumbs[i] = { ...crumbs[i], label: name }
        break
      }
    }
    return crumbs
  }, [location.pathname, project?.name, projectId, breadcrumbLabel, queryClient])

  const openSearch = useCallback(() => setIsSearchOpen(true), [])
  const openCodebook = useCallback(() => { bringToFront(setCodebookZ); setIsCodebookOpen(true) }, [bringToFront])
  const closeCodebook = useCallback(() => setIsCodebookOpen(false), [])
  const openMemos = useCallback(() => { bringToFront(setMemosZ); setIsMemosOpen(true) }, [bringToFront])
  const closeMemos = useCallback(() => setIsMemosOpen(false), [])

  // Global keyboard shortcuts: Cmd+K → search, ? → keyboard help
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setIsSearchOpen(prev => !prev)
      }
      if (e.key === '?') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return
        e.preventDefault()
        setIsKeyboardHelpOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const layoutContext = useMemo<ProjectLayoutContext>(() => ({
    project,
    projectId,
    isCompact,
    openSearch,
    openCodebook,
    closeCodebook,
    openMemos,
    closeMemos,
    isCodebookOpen,
    isMemosOpen,
    setBreadcrumbLabel,
  }), [project, projectId, isCompact, openSearch, openCodebook, closeCodebook, openMemos, closeMemos, isCodebookOpen, isMemosOpen, setBreadcrumbLabel])

  return (
    <div className="h-screen flex flex-col">
      <PageErrorBoundary>
        <TopRail
          project={project}
          activeWorkspace={activeWorkspace}
          isCompact={isCompact}
          breadcrumbs={breadcrumbs}
          onSearchOpen={openSearch}
          onMemosOpen={openMemos}
          onExportOpen={() => setIsExportOpen(true)}
          onScratchpadToggle={() => {
            setIsScratchpadOpen(prev => {
              if (!prev) {
                bringToFront(setScratchpadZ)
                setScratchpadContext(contextHintLabel)
              }
              return !prev
            })
          }}
          scratchpadCount={scratchpadCount}
        />
      </PageErrorBoundary>
      <div className="flex-1 overflow-auto" role="main">
        {projectError ? (
          <div role="alert" className="flex flex-col items-center justify-center h-full text-mm-text-faint text-sm gap-2 p-8">
            <span className="text-base font-medium text-mm-text-secondary">Failed to load project</span>
            <span className="text-xs text-mm-border-medium">
              {(projectError as Error).message || 'An unexpected error occurred'}
            </span>
          </div>
        ) : (
          <PageErrorBoundary>
            <Suspense fallback={
              <div className="flex items-center justify-center h-full">
                <div className="text-muted-foreground text-sm">Loading...</div>
              </div>
            }>
              <Outlet context={layoutContext} />
            </Suspense>
          </PageErrorBoundary>
        )}
      </div>

      <SearchPopover
        open={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        projectId={projectId}
        onOpenCodebook={openCodebook}
        onOpenMemos={openMemos}
      />

      <PageErrorBoundary>
        {isCodebookOpen && (
          <CodebookSlideOut projectId={projectId} onClose={closeCodebook} zIndex={codebookZ} />
        )}

        {isMemosOpen && (
          <MemosSlideOut
            projectId={projectId}
            onClose={closeMemos}
            defaultEntityType={memoContext.entityType}
            defaultEntityId={memoContext.entityId}
            zIndex={memosZ}
          />
        )}

        {isScratchpadOpen && (
          <ScratchpadPopover
            projectId={projectId}
            contextHint={scratchpadContext}
            unsortedCount={scratchpadCount}
            draft={scratchpadDraft}
            onDraftChange={setScratchpadDraft}
            onClose={() => setIsScratchpadOpen(false)}
            zIndex={scratchpadZ}
          />
        )}
      </PageErrorBoundary>

      <ExportDialog
        open={isExportOpen}
        onOpenChange={setIsExportOpen}
        projectId={projectId}
      />

      <KeyboardHelpDialog
        open={isKeyboardHelpOpen}
        onOpenChange={setIsKeyboardHelpOpen}
      />

      {/* Toaster moved to App.tsx so toasts work on Dashboard and during inactivity warnings */}
    </div>
  )
}
