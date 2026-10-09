/**
 * The breadcrumb trail for a project route — pure, so the scratchpad's context
 * hint (#1002) can be derived from it and tested over every route without the
 * layout. Entity crumbs carry an EMPTY label here; the layout fills it from the
 * query cache or the page's own `setBreadcrumbLabel`.
 */
export interface BreadcrumbSegment {
  label: string
  to?: string
}

export function deriveBreadcrumbs(pathname: string, projectName: string | undefined, projectId: number): BreadcrumbSegment[] {
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
    // Matches the page's own <h1>; the capitalised slug read "Coding-import".
    'coding-import': 'Import codings',
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
    } else if (sub === 'ratings') {
      // #1002 — the trail ended at "Analysis" here, and a scratchpad note jotted
      // from this page now takes its origin from the trail.
      crumbs.push({ label: 'Ratings' })
    } else if (/^\d+$/.test(sub)) {
      // Entity ID — resolved by cache lookup or child setBreadcrumbLabel
      if (segments.length >= 3) {
        crumbs.push({ label: '', to: `${base}/${workspace}/${sub}` })
        const action = segments[2]
        // `recode` is retired (2026-08-23) — the route redirects — but an
        // in-flight render can still see it, and a stale crumb is worse than a
        // duplicated arm.
        if (action === 'variables' || action === 'recode') crumbs.push({ label: 'Variables' })
        else if (action === 'append') crumbs.push({ label: 'Append' })
      } else {
        crumbs.push({ label: '' })
      }
    }
  }

  return crumbs
}
