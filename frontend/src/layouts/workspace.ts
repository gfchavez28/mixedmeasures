// Workspace-tab detection for the TopRail. Kept out of ProjectLayout.tsx so the
// component file stays component-only (Fast Refresh) and this pure function is
// unit-testable in isolation.

export type Workspace = 'overview' | 'conversations' | 'datasets' | 'documents' | 'analysis' | 'none'

export function detectWorkspace(pathname: string): Workspace {
  if (pathname.includes('/conversations')) return 'conversations'
  if (pathname.includes('/datasets')) return 'datasets'
  if (pathname.includes('/documents')) return 'documents'
  if (pathname.includes('/analysis')) return 'analysis'
  // Standalone project routes belong to no workspace tab — they must not light
  // (and aria-current) the Overview tab (#428e).
  if (pathname.includes('/participants')) return 'none'
  if (pathname.includes('/memos-notes')) return 'none'
  return 'overview'
}
