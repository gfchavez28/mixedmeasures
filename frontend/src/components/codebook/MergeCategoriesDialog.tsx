import { useState, useMemo, useEffect } from 'react'
import type { CodebookTreeResponse, CodebookCategoryNode } from '@/lib/api'
import { COLOR_DEFAULT } from '@/lib/codebook-constants'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'

interface MergeCategoriesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  categoryIds: number[]
  treeData: CodebookTreeResponse
  onConfirm: (sourceIds: number[], targetId: number) => void
  isPending?: boolean
}

interface CategoryInfo {
  id: number
  name: string
  color: string | null
  codeCount: number
  totalCodeCount: number
  childCount: number
  parentName: string | null
  parentId: number | null
}

function buildCategoryLookup(
  categoryIds: number[],
  treeData: CodebookTreeResponse,
): CategoryInfo[] {
  const idSet = new Set(categoryIds)
  const results = new Map<number, CategoryInfo>()

  function walk(nodes: CodebookCategoryNode[], parentName: string | null) {
    for (const cat of nodes) {
      if (idSet.has(cat.id)) {
        results.set(cat.id, {
          id: cat.id,
          name: cat.name,
          color: cat.color,
          codeCount: cat.code_count,
          totalCodeCount: cat.total_code_count,
          childCount: cat.children.length,
          parentName,
          parentId: cat.parent_id,
        })
      }
      walk(cat.children, cat.name)
    }
  }
  walk(treeData.tree, null)

  // Sort by total_code_count descending (highest = default target)
  return Array.from(results.values()).sort((a, b) => b.totalCodeCount - a.totalCodeCount)
}

export default function MergeCategoriesDialog({
  open,
  onOpenChange,
  categoryIds,
  treeData,
  onConfirm,
  isPending,
}: MergeCategoriesDialogProps) {
  const categories = useMemo(
    () => buildCategoryLookup(categoryIds, treeData),
    [categoryIds, treeData],
  )

  const [targetId, setTargetId] = useState<number | null>(null)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form state when dialog opens
  useEffect(() => { if (open) setTargetId(null) }, [open, categoryIds])
  const effectiveTargetId = targetId ?? categories[0]?.id ?? null

  const target = categories.find(c => c.id === effectiveTargetId)
  const sources = categories.filter(c => c.id !== effectiveTargetId)

  // Compute totals that will move
  const totalCodes = sources.reduce((s, c) => s + c.codeCount, 0)
  const totalChildren = sources.reduce((s, c) => s + c.childCount, 0)

  // Check if categories span multiple parents
  const parentNames = new Set(categories.map(c => c.parentName ?? 'Root'))
  const crossParent = parentNames.size > 1

  if (categories.length < 2) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Merge {categories.length} categories</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p className="text-mm-text-muted">
                Select the category to keep. Codes and subcategories from all other categories will be moved into it, and source categories will be deleted.
              </p>

              {/* Target selector */}
              <div className="space-y-1" role="radiogroup" aria-label="Select target category">
                {categories.map(cat => {
                  const isTarget = cat.id === effectiveTargetId
                  const color = cat.color || COLOR_DEFAULT
                  return (
                    <button
                      key={cat.id}
                      role="radio"
                      aria-checked={isTarget}
                      onClick={() => setTargetId(cat.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors ${
                        isTarget
                          ? 'bg-mm-blue/10 ring-1 ring-mm-blue/30'
                          : 'hover:bg-mm-surface-hover'
                      }`}
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          isTarget ? 'border-mm-blue' : 'border-mm-border-medium'
                        }`}
                      >
                        {isTarget && <span className="w-1.5 h-1.5 rounded-full bg-mm-blue" />}
                      </span>
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                      <span className="flex-1 min-w-0">
                        <span className={`text-sm ${isTarget ? 'font-semibold text-mm-text' : 'text-mm-text-secondary'}`}>
                          {cat.name}
                        </span>
                        <span className="text-xs text-mm-text-faint ml-1.5 tabular-nums">
                          {cat.totalCodeCount} code{cat.totalCodeCount !== 1 ? 's' : ''}
                          {cat.childCount > 0 && ` \u00b7 ${cat.childCount} sub`}
                        </span>
                        {crossParent && (
                          <span className="block text-[10px] text-mm-text-faint mt-0.5">
                            in {cat.parentName ?? 'Root'}
                          </span>
                        )}
                      </span>
                      {isTarget && (
                        <span className="text-[10px] font-medium text-mm-blue-text uppercase shrink-0">Keep</span>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Summary */}
              {target && (
                <div className="rounded-md bg-mm-bg border border-mm-border-subtle p-2.5 text-xs text-mm-text-secondary" id="merge-cats-summary">
                  <p>
                    Merge <strong>{sources.length} categor{sources.length !== 1 ? 'ies' : 'y'}</strong> into <strong>{target.name}</strong>.
                    {totalCodes > 0 && <> {totalCodes} code{totalCodes !== 1 ? 's' : ''} will move to {target.name}.</>}
                    {totalChildren > 0 && <> {totalChildren} subcategor{totalChildren !== 1 ? 'ies' : 'y'} will be reparented.</>}
                  </p>
                  <p className="mt-1 text-mm-text-faint">
                    Source categor{sources.length !== 1 ? 'ies' : 'y'} will be deleted. Memos will be reassigned to {target.name}.
                  </p>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (effectiveTargetId !== null) {
                const srcIds = sources.map(s => s.id)
                onConfirm(srcIds, effectiveTargetId)
              }
            }}
            disabled={isPending || effectiveTargetId === null}
            aria-describedby="merge-cats-summary"
          >
            {isPending ? 'Merging\u2026' : 'Merge'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
