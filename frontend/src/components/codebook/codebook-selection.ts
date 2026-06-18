import type { CodebookTreeResponse, CodebookCategoryNode, CodebookCodeNode } from '@/lib/api'

// ── Node ID parsing helpers ─────────────────────────────────────────────────

/** Parse a multi-select node ID (e.g. "code-42") to its numeric ID, or null if invalid. */
export function parseCodeNodeId(nodeId: string): number | null {
  if (!nodeId.startsWith('code-')) return null
  const n = Number(nodeId.slice(5))
  return Number.isFinite(n) ? n : null
}

/** Parse a category node ID (e.g. "cat-7") to its numeric ID, or null if invalid. */
export function parseCatNodeId(nodeId: string): number | null {
  if (!nodeId.startsWith('cat-')) return null
  const n = Number(nodeId.slice(4))
  return Number.isFinite(n) ? n : null
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelectionAnalysis {
  codes: { id: number; name: string; isUniversal: boolean; segmentCount: number; sourceCount: number; categoryId: number | null }[]
  categories: { id: number; name: string }[]
  movableCodes: number[]
  movableCategories: number[]
  targetCategory: { id: number; name: string } | null
  canMove: boolean
  canMerge: boolean
  canMergeCategories: boolean
  canGroupInto: boolean
  groupContext: 'codes' | 'categories' | 'mixed'
  moveLabel: string
  mergeLabel: string
  mergeCategoriesLabel: string
  summary: string
}

const EMPTY_ANALYSIS: SelectionAnalysis = {
  codes: [],
  categories: [],
  movableCodes: [],
  movableCategories: [],
  targetCategory: null,
  canMove: false,
  canMerge: false,
  canMergeCategories: false,
  canGroupInto: false,
  groupContext: 'codes',
  moveLabel: '',
  mergeLabel: '',
  mergeCategoriesLabel: '',
  summary: '',
}

export function analyzeSelection(
  multiSelect: Set<string>,
  treeData: CodebookTreeResponse | undefined,
): SelectionAnalysis {
  if (multiSelect.size === 0 || !treeData) return EMPTY_ANALYSIS

  // Build lookup maps
  const codeMap = new Map<number, CodebookCodeNode & { categoryId: number | null }>()
  const catMap = new Map<number, CodebookCategoryNode>()

  for (const c of treeData.universal_codes) codeMap.set(c.id, { ...c, categoryId: null })
  for (const c of treeData.uncategorized_codes) codeMap.set(c.id, { ...c, categoryId: null })

  function walkTree(nodes: CodebookCategoryNode[]) {
    for (const cat of nodes) {
      catMap.set(cat.id, cat)
      for (const code of cat.codes) codeMap.set(code.id, { ...code, categoryId: cat.id })
      walkTree(cat.children)
    }
  }
  walkTree(treeData.tree)

  // Classify selected items
  const codes: SelectionAnalysis['codes'] = []
  const categories: SelectionAnalysis['categories'] = []

  for (const nodeId of multiSelect) {
    const codeId = parseCodeNodeId(nodeId)
    if (codeId !== null) {
      const c = codeMap.get(codeId)
      if (c) {
        codes.push({
          id: c.id,
          name: c.name,
          isUniversal: c.is_universal,
          segmentCount: c.segment_count,
          sourceCount: c.source_count,
          categoryId: c.categoryId,
        })
      }
      continue
    }
    const catId = parseCatNodeId(nodeId)
    if (catId !== null) {
      const cat = catMap.get(catId)
      if (cat) categories.push({ id: cat.id, name: cat.name })
    }
  }

  const movableCodes = codes.filter(c => !c.isUniversal).map(c => c.id)
  const movableCategories = categories.map(c => c.id)
  const targetCategory = categories.length === 1 && codes.length > 0 && movableCodes.length > 0 ? categories[0] : null
  const canMove = movableCodes.length > 0 || movableCategories.length > 0
  const canMerge = movableCodes.length >= 2
  const canMergeCategories = categories.length >= 2
  const canGroupInto = (codes.filter(c => !c.isUniversal).length + categories.length) >= 2
  const groupContext: SelectionAnalysis['groupContext'] =
    codes.length > 0 && categories.length > 0 ? 'mixed'
    : categories.length > 0 ? 'categories'
    : 'codes'

  // Labels
  const codePart = codes.length > 0
    ? `${codes.length} code${codes.length !== 1 ? 's' : ''}`
    : ''
  const catPart = categories.length > 0
    ? `${categories.length} categor${categories.length !== 1 ? 'ies' : 'y'}`
    : ''
  const summary = [codePart, catPart].filter(Boolean).join(' + ')

  const moveLabel = targetCategory
    ? `Move to ${targetCategory.name}`
    : 'Move to\u2026'

  const mergeLabel = canMerge
    ? `Merge ${movableCodes.length} codes`
    : ''

  const mergeCategoriesLabel = canMergeCategories
    ? `Merge ${categories.length} categories`
    : ''

  return {
    codes,
    categories,
    movableCodes,
    movableCategories,
    targetCategory,
    canMove,
    canMerge,
    canMergeCategories,
    canGroupInto,
    groupContext,
    moveLabel,
    mergeLabel,
    mergeCategoriesLabel,
    summary,
  }
}

/** Collect all code node IDs belonging to a category (direct codes only) */
export function collectCategoryCodeIds(
  categoryId: number,
  treeData: CodebookTreeResponse,
): string[] {
  const ids: string[] = []
  function walk(nodes: CodebookCategoryNode[]) {
    for (const cat of nodes) {
      if (cat.id === categoryId) {
        for (const code of cat.codes) ids.push(`code-${code.id}`)
        return true
      }
      if (walk(cat.children)) return true
    }
    return false
  }
  walk(treeData.tree)
  return ids
}

/** Collect numeric IDs of ALL descendant codes in a category (recursive through subcategories) */
export function collectDescendantCodeNumericIds(
  categoryId: number,
  treeData: CodebookTreeResponse,
): number[] {
  const ids: number[] = []
  function findAndCollect(nodes: CodebookCategoryNode[]): boolean {
    for (const cat of nodes) {
      if (cat.id === categoryId) {
        collectAll(cat)
        return true
      }
      if (findAndCollect(cat.children)) return true
    }
    return false
  }
  function collectAll(cat: CodebookCategoryNode) {
    for (const code of cat.codes) ids.push(code.id)
    for (const child of cat.children) collectAll(child)
  }
  findAndCollect(treeData.tree)
  return ids
}
