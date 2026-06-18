import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { type CodeCategory } from '@/lib/api'
import { cn } from '@/lib/utils'

interface FlatCategoryPickerProps {
  categories: CodeCategory[]
  value: number | null
  onChange: (categoryId: number | null) => void
}

export default function FlatCategoryPicker({ categories, value, onChange }: FlatCategoryPickerProps) {
  // Compute depth from parent_id chains
  const categoriesWithDepth = useMemo(() => {
    // Build tree order: root categories first, then children
    const result: { category: CodeCategory; depth: number }[] = []
    const addWithChildren = (parentId: number | null | undefined, depth: number) => {
      const children = categories
        .filter(c => (c.parent_id ?? null) === (parentId ?? null))
        .sort((a, b) => a.display_order - b.display_order)
      for (const child of children) {
        result.push({ category: child, depth })
        addWithChildren(child.id, depth + 1)
      }
    }
    addWithChildren(null, 0)
    return result
  }, [categories])

  return (
    <div className="max-h-48 overflow-y-auto border rounded-md bg-mm-surface">
      <button
        type="button"
        className={cn(
          'w-full text-left px-2 py-1.5 text-sm hover:bg-mm-surface-hover flex items-center gap-2',
          value === null && 'font-medium'
        )}
        onClick={() => onChange(null)}
      >
        {value === null && <Check className="w-3 h-3 text-green-600 flex-shrink-0" />}
        <span className={cn(value === null ? '' : 'pl-5')}>No category</span>
      </button>
      {categoriesWithDepth.map(({ category, depth }) => (
        <button
          key={category.id}
          type="button"
          className={cn(
            'w-full text-left px-2 py-1.5 text-sm hover:bg-mm-surface-hover flex items-center gap-2'
          )}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => onChange(category.id)}
        >
          {value === category.id && <Check className="w-3 h-3 text-green-600 flex-shrink-0" />}
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: category.color || '#9ca3af' }}
          />
          <span className={cn('truncate', value === category.id ? 'font-medium' : '')}>
            {category.name}
          </span>
        </button>
      ))}
    </div>
  )
}
