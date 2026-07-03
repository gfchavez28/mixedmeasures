import type { ComboOption } from '@/components/ui/creatable-combobox'

interface CategoryLike {
  id: number
  name: string
  color?: string | null
  parent_id?: number | null
  display_order?: number
}

/**
 * Flatten a code-category list into depth-ordered combobox options (#462) — root
 * categories first, each followed by its children, sorted by display_order within a
 * parent. Mirrors the tree ordering in FlatCategoryPicker so the two stay consistent.
 */
export function buildCategoryOptions(categories: CategoryLike[]): ComboOption[] {
  const result: ComboOption[] = []
  const add = (parentId: number | null, depth: number) => {
    const children = categories
      .filter(c => (c.parent_id ?? null) === parentId)
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    for (const c of children) {
      result.push({ value: c.id, label: c.name, color: c.color ?? null, depth })
      add(c.id, depth + 1)
    }
  }
  add(null, 0)
  return result
}
