import type { JSONContent } from '@tiptap/core'
import type { CanvasTheme } from '@/lib/api'

// ── Material summary extraction from Tiptap JSON ──────────────────────────

export interface MaterialSummary {
  excerptIds: number[]
  chartIds: number[]
  memoIds: number[]
  excerptCount: number
  chartCount: number
  memoCount: number
  calloutCount: number
  hasAnyTag: boolean
  previews: string[]
}

const EMPTY_SUMMARY: MaterialSummary = {
  excerptIds: [], chartIds: [], memoIds: [],
  excerptCount: 0, chartCount: 0, memoCount: 0, calloutCount: 0,
  hasAnyTag: false, previews: [],
}

/**
 * Walk a Tiptap JSON document and extract material metadata.
 * Used by SpatialCanvas (card summaries), OutlineSidebar (integration
 * indicators), MaterialsDrawer ("already on canvas"), and search.
 */
export function extractMaterialSummary(tiptapJson: Record<string, unknown> | null): MaterialSummary {
  if (!tiptapJson) return { ...EMPTY_SUMMARY }

  const excerptIds: number[] = []
  const chartIds: number[] = []
  const memoIds: number[] = []
  let calloutCount = 0
  let hasAnyTag = false
  const previews: string[] = []

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const type = n.type as string | undefined
    const attrs = (n.attrs ?? {}) as Record<string, unknown>

    if (type === 'excerpt-embed') {
      const id = attrs.excerptId as number | undefined
      if (id != null) excerptIds.push(id)
      const text = attrs.displayText as string | undefined
      if (text) previews.push(text.length > 60 ? text.slice(0, 60) + '...' : text)
      if (attrs.materialTag) hasAnyTag = true
    } else if (type === 'chart-embed') {
      const id = attrs.materialId as number | undefined
      if (id != null) chartIds.push(id)
      const title = attrs.title as string | undefined
      if (title) previews.push(title)
      if (attrs.materialTag) hasAnyTag = true
    } else if (type === 'memo-embed') {
      const id = attrs.memoId as number | undefined
      if (id != null) memoIds.push(id)
      const title = attrs.title as string | undefined
      if (title) previews.push(title)
      if (attrs.materialTag) hasAnyTag = true
    } else if (type === 'callout-stat') {
      calloutCount++
      if (attrs.materialTag) hasAnyTag = true
    }

    const content = n.content as unknown[] | undefined
    if (Array.isArray(content)) {
      for (const child of content) walk(child)
    }
  }

  walk(tiptapJson)

  return {
    excerptIds, chartIds, memoIds,
    excerptCount: excerptIds.length,
    chartCount: chartIds.length,
    memoCount: memoIds.length,
    calloutCount,
    hasAnyTag,
    previews,
  }
}

/**
 * Aggregate material summaries across all themes in a canvas.
 * Returns unified source ID sets for "already on canvas" checks,
 * plus per-theme summaries.
 */
export function extractAllMaterialSummaries(themes: CanvasTheme[]): {
  onCanvasExcerptIds: Set<number>
  onCanvasMaterialIds: Set<number>
  onCanvasMemoIds: Set<number>
  perTheme: Map<number, MaterialSummary>
} {
  const onCanvasExcerptIds = new Set<number>()
  const onCanvasMaterialIds = new Set<number>()
  const onCanvasMemoIds = new Set<number>()
  const perTheme = new Map<number, MaterialSummary>()

  for (const theme of themes) {
    const summary = extractMaterialSummary(theme.content)
    perTheme.set(theme.id, summary)
    for (const id of summary.excerptIds) onCanvasExcerptIds.add(id)
    for (const id of summary.chartIds) onCanvasMaterialIds.add(id)
    for (const id of summary.memoIds) onCanvasMemoIds.add(id)
  }

  return { onCanvasExcerptIds, onCanvasMaterialIds, onCanvasMemoIds, perTheme }
}

// ── Schema-aware content cleaner ────────────────────────────────────────────
//
// The canvas Writing editor (useCanvasEditor) disables several node types in
// StarterKit — notably `heading`, `codeBlock`, and the inline `code` mark.
// When a doc loaded into Tiptap contains those types, Tiptap's schema
// validator silently drops them, which has historically produced empty-
// looking themes for content that round-trips fine through Word export
// (which reads the raw JSON).
//
// `cleanCanvasContent` walks a Tiptap JSON document and transforms unsupported
// nodes into supported equivalents, preserving text content. Headings become
// bold paragraphs (visual emphasis preserved), code blocks become paragraphs,
// any other unknown node falls back to a plain-text paragraph. Disallowed
// marks (e.g. `code`) are stripped from text nodes.
//
// The function returns the cleaned doc + a list of unique transforms that
// occurred, so callers can surface a non-blocking notification AND trigger a
// self-healing save (so subsequent loads are silent).

export type ContentRewriteKind = 'bold-paragraph' | 'paragraph' | 'plain-text' | 'mark-dropped'

export interface ContentRewrite {
  /** Original node or mark type that the schema didn't support. */
  type: string
  /** What it was transformed into. */
  transformedTo: ContentRewriteKind
}

export interface CleanCanvasContentResult {
  cleaned: JSONContent | null
  /** De-duplicated list of (type, transformedTo) pairs. Empty if nothing changed. */
  rewrites: ContentRewrite[]
}

/**
 * Walk a Tiptap JSON document and transform any nodes/marks that aren't in
 * the supplied allowlists. Pure function — does not mutate the input.
 *
 * `allowedNodes` / `allowedMarks` are typically derived from a Tiptap schema
 * (e.g. `Object.keys(editor.schema.nodes)`); see `useCanvasEditor` for the
 * canonical call site.
 *
 * Always preserves the root `doc` node — only its descendants are subject to
 * transformation. Returns a stable shape so `JSON.stringify` round-trips
 * cleanly: undefined keys are stripped, arrays are fresh.
 */
export function cleanCanvasContent(
  content: JSONContent | Record<string, unknown> | null | undefined,
  allowedNodes: Set<string>,
  allowedMarks: Set<string>,
): CleanCanvasContentResult {
  if (!content || typeof content !== 'object') {
    return { cleaned: (content as JSONContent | null) ?? null, rewrites: [] }
  }

  const rewrites: ContentRewrite[] = []
  const seen = new Set<string>()
  const recordRewrite = (type: string, transformedTo: ContentRewriteKind) => {
    const key = `${type}→${transformedTo}`
    if (seen.has(key)) return
    seen.add(key)
    rewrites.push({ type, transformedTo })
  }

  function cleanMarks(marks: unknown): JSONContent['marks'] | undefined {
    if (!Array.isArray(marks)) return undefined
    const kept = marks.filter((m): m is { type: string } => {
      if (!m || typeof m !== 'object') return false
      const type = (m as { type?: string }).type
      if (typeof type !== 'string') return false
      if (allowedMarks.has(type)) return true
      recordRewrite(type, 'mark-dropped')
      return false
    })
    return kept.length > 0 ? (kept as JSONContent['marks']) : undefined
  }

  function extractText(node: JSONContent): string {
    if (node.type === 'text' && typeof node.text === 'string') return node.text
    if (!Array.isArray(node.content)) return ''
    return node.content.map(extractText).join('')
  }

  function buildNode(input: JSONContent): JSONContent {
    const out: JSONContent = { type: input.type }
    if (input.attrs && typeof input.attrs === 'object') out.attrs = input.attrs
    if (typeof input.text === 'string') out.text = input.text
    const marks = cleanMarks(input.marks)
    if (marks) out.marks = marks
    if (Array.isArray(input.content)) {
      const childResults: JSONContent[] = []
      for (const child of input.content) {
        if (!child || typeof child !== 'object') continue
        const result = transformNode(child as JSONContent)
        if (Array.isArray(result)) childResults.push(...result)
        else if (result) childResults.push(result)
      }
      out.content = childResults
    }
    return out
  }

  function transformNode(node: JSONContent): JSONContent | JSONContent[] | null {
    // Nodes without a type can't be transformed; drop defensively.
    if (typeof node.type !== 'string') return null

    // Always preserve doc; recurse into its content.
    if (node.type === 'doc') return buildNode(node)

    // Allowed type — pass through after cleaning children and marks.
    if (allowedNodes.has(node.type)) return buildNode(node)

    // ── Targeted transforms ───────────────────────────────────────────────

    // heading → paragraph with bold text marks (preserves emphasis)
    if (node.type === 'heading') {
      recordRewrite('heading', 'bold-paragraph')
      const built = buildNode({ ...node, type: 'paragraph' })
      built.attrs = undefined  // drop level attr
      delete (built as { attrs?: unknown }).attrs
      built.content = (built.content ?? []).map(child => {
        if (child.type !== 'text') return child
        const existingMarks = Array.isArray(child.marks) ? child.marks.filter(m => m.type !== 'bold') : []
        return { ...child, marks: [...existingMarks, { type: 'bold' }] }
      })
      return built
    }

    // codeBlock → paragraph (preserve text, no bold — code isn't emphasis)
    if (node.type === 'codeBlock') {
      recordRewrite('codeBlock', 'paragraph')
      const built = buildNode({ ...node, type: 'paragraph' })
      delete (built as { attrs?: unknown }).attrs
      return built
    }

    // ── Fallback: recover text into a paragraph ───────────────────────────
    recordRewrite(node.type, 'plain-text')
    const text = extractText(node)
    if (text) {
      return { type: 'paragraph', content: [{ type: 'text', text }] }
    }
    return null
  }

  const cleaned = transformNode(content as JSONContent)
  const result = Array.isArray(cleaned) ? cleaned[0] : cleaned
  return { cleaned: result, rewrites }
}

/** Human-readable summary of what was rewritten. Used in toast messages. */
export function describeRewrites(rewrites: ContentRewrite[]): string {
  if (rewrites.length === 0) return ''
  const parts: string[] = []
  const types = new Set(rewrites.map(r => r.type))
  if (types.has('heading')) parts.push('headings → bold paragraphs')
  if (types.has('codeBlock')) parts.push('code blocks → paragraphs')
  // Group remaining (non-heading, non-codeBlock) rewrites
  const otherNodeTypes = [...types].filter(t => t !== 'heading' && t !== 'codeBlock')
    .filter(t => rewrites.some(r => r.type === t && r.transformedTo !== 'mark-dropped'))
  if (otherNodeTypes.length > 0) parts.push('unsupported blocks → paragraphs')
  const droppedMarks = rewrites
    .filter(r => r.transformedTo === 'mark-dropped')
    .map(r => r.type)
  if (droppedMarks.length > 0) parts.push(`removed: ${droppedMarks.join(', ')}`)
  return parts.join('; ')
}

// ── Nesting depth computation ───────────────────────────────────────────────

export function computeNestingDepth(themes: CanvasTheme[]): Map<number, number> {
  const depthMap = new Map<number, number>()
  const themeMap = new Map(themes.map(t => [t.id, t]))
  for (const theme of themes) {
    let depth = 0
    let current = theme
    while (current.parent_theme_id != null) {
      depth++
      const parent = themeMap.get(current.parent_theme_id)
      if (!parent || depth > 10) break
      current = parent
    }
    depthMap.set(theme.id, depth)
  }
  return depthMap
}
