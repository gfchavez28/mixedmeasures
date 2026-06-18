import { useState, useMemo, useEffect } from 'react'
import type { CodebookTreeResponse, CodebookCategoryNode, CodebookCodeNode } from '@/lib/api'
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

interface MergeCodesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceCodeIds: number[]
  treeData: CodebookTreeResponse
  onConfirm: (sourceIds: number[], targetId: number) => void
  isPending?: boolean
}

interface CodeWithCategory {
  code: CodebookCodeNode
  categoryName: string | null
  categoryColor: string | null
}

function buildCodeLookup(
  codeIds: number[],
  treeData: CodebookTreeResponse,
): CodeWithCategory[] {
  const idSet = new Set(codeIds)
  const results = new Map<number, CodeWithCategory>()

  for (const c of treeData.universal_codes) {
    if (idSet.has(c.id)) results.set(c.id, { code: c, categoryName: null, categoryColor: null })
  }
  for (const c of treeData.uncategorized_codes) {
    if (idSet.has(c.id)) results.set(c.id, { code: c, categoryName: null, categoryColor: null })
  }

  function walk(nodes: CodebookCategoryNode[]) {
    for (const cat of nodes) {
      for (const code of cat.codes) {
        if (idSet.has(code.id)) {
          results.set(code.id, { code, categoryName: cat.name, categoryColor: cat.color })
        }
      }
      walk(cat.children)
    }
  }
  walk(treeData.tree)

  // Preserve order: highest segment_count first
  return Array.from(results.values()).sort((a, b) => b.code.segment_count - a.code.segment_count)
}

export default function MergeCodesDialog({
  open,
  onOpenChange,
  sourceCodeIds,
  treeData,
  onConfirm,
  isPending,
}: MergeCodesDialogProps) {
  const codes = useMemo(
    () => buildCodeLookup(sourceCodeIds, treeData),
    [sourceCodeIds, treeData],
  )

  // Default target: the code with the most segments (first in sorted list)
  const [targetId, setTargetId] = useState<number | null>(null)
  // Reset target when dialog opens or source codes change
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form state when dialog opens
  useEffect(() => { if (open) setTargetId(null) }, [open, sourceCodeIds])
  const effectiveTargetId = targetId ?? codes[0]?.code.id ?? null

  const target = codes.find(c => c.code.id === effectiveTargetId)
  const sources = codes.filter(c => c.code.id !== effectiveTargetId)

  const totalSourceSegments = sources.reduce((s, c) => s + c.code.segment_count, 0)
  const totalSourceSources = sources.reduce((s, c) => s + c.code.source_count, 0)

  // Check if codes span multiple categories
  const categoryNames = new Set(codes.map(c => c.categoryName ?? 'Uncategorized'))
  const crossCategory = categoryNames.size > 1

  if (codes.length < 2) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Merge {codes.length} codes</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p className="text-mm-text-muted">
                Select the code to keep. All other codes will have their applications merged into it and will be deactivated.
              </p>

              {/* Target selector */}
              <div className="space-y-1" role="radiogroup" aria-label="Select target code">
                {codes.map(({ code, categoryName, categoryColor }) => {
                  const isTarget = code.id === effectiveTargetId
                  const color = code.color || categoryColor || COLOR_DEFAULT
                  return (
                    <button
                      key={code.id}
                      role="radio"
                      aria-checked={isTarget}
                      onClick={() => setTargetId(code.id)}
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
                          {code.name}
                        </span>
                        <span className="text-xs text-mm-text-faint ml-1.5 tabular-nums">
                          {code.segment_count} seg {'\u00b7'} {code.source_count} src
                        </span>
                        {crossCategory && categoryName && (
                          <span className="block text-[10px] text-mm-text-faint mt-0.5">
                            in {categoryName}
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
                <div className="rounded-md bg-mm-bg border border-mm-border-subtle p-2.5 text-xs text-mm-text-secondary" id="merge-summary">
                  <p>
                    <strong>{sources.length} code{sources.length !== 1 ? 's' : ''}</strong> ({totalSourceSegments} segment{totalSourceSegments !== 1 ? 's' : ''}, {totalSourceSources} source{totalSourceSources !== 1 ? 's' : ''}) will be merged into{' '}
                    <strong>{target.code.name}</strong> ({target.code.segment_count} segment{target.code.segment_count !== 1 ? 's' : ''}).
                  </p>
                  <p className="mt-1 text-mm-text-faint">
                    Duplicate applications will be skipped. Source code{sources.length !== 1 ? 's' : ''} will be deactivated.
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
                const srcIds = sources.map(s => s.code.id)
                onConfirm(srcIds, effectiveTargetId)
              }
            }}
            disabled={isPending || effectiveTargetId === null}
            aria-describedby="merge-summary"
          >
            {isPending ? 'Merging\u2026' : 'Merge'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
