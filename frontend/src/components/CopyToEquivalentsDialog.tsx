import { useState, useMemo, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, TriangleAlert, ArrowRightLeft } from 'lucide-react'
import {
  recodeApi,
  equivalenceApi,
  type DatasetColumn,
  type RecodeDefinition,
  type EquivalenceGroupResponse,
  type EquivalenceGroupColumnInfo,
} from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { getCompatibility, remapMapping, remapExcludeValues, type CompatibilityType } from '@/lib/recode-utils'

// Compare two mappings for equivalence (sorted key-value pairs)
function mappingsEqual(a: Record<string, number | string>, b: Record<string, number | string>): boolean {
  const normalize = (m: Record<string, number | string>) =>
    JSON.stringify(Object.entries(m).sort(([k1], [k2]) => k1.localeCompare(k2)))
  return normalize(a) === normalize(b)
}

// ── Copy to Equivalents Dialog ───────────────────────────────────────────────

export function CopyToEquivalentsDialog({
  open,
  onClose,
  sourceColumn,
  definitions,
  equivalenceGroupId,
  projectId,
  onCopyComplete,
}: {
  open: boolean
  onClose: () => void
  sourceColumn: DatasetColumn
  definitions: RecodeDefinition[]
  equivalenceGroupId: number
  projectId: number
  onCopyComplete: () => void
}) {
  const [selectedDefs, setSelectedDefs] = useState<Set<number>>(new Set())
  const [selectedTargets, setSelectedTargets] = useState<Set<number>>(new Set())
  const [isCopying, setIsCopying] = useState(false)
  const [results, setResults] = useState<{ success: number; failed: number; renamed: number } | null>(null)
  const queryClient = useQueryClient()

  // Fetch equivalence groups for this project
  const { data: eqData } = useQuery({
    queryKey: ['equivalence-groups', projectId],
    queryFn: () => equivalenceApi.list(projectId),
    enabled: open,
  })

  const group = eqData?.groups.find((g: EquivalenceGroupResponse) => g.id === equivalenceGroupId)
  const targetColumns = useMemo(
    () => group?.columns.filter((q: EquivalenceGroupColumnInfo) => q.id !== sourceColumn.id) || [],
    [group?.columns, sourceColumn.id],
  )

  // Copyable defs: exclude 'reverse' type
  const copyableDefs = useMemo(() => definitions.filter(d => d.recode_type !== 'reverse'), [definitions])

  // Source labels: from scale_labels or first definition mapping keys
  const sourceLabels: string[] | null = sourceColumn.scale_labels ??
    (copyableDefs.length > 0 ? Object.keys(copyableDefs[0].mapping) : null)

  // Fetch full definitions for ALL target columns on dialog open (for duplicate detection)
  const [targetDefsMap, setTargetDefsMap] = useState<Map<number, RecodeDefinition[]>>(new Map())
  const [targetDefsLoaded, setTargetDefsLoaded] = useState(false)
  /* eslint-disable react-hooks/set-state-in-effect -- async fetch on dialog open with cancellation */
  useEffect(() => {
    if (!open || targetColumns.length === 0) return
    let cancelled = false
    setTargetDefsLoaded(false)
    const map = new Map<number, RecodeDefinition[]>()
    Promise.allSettled(
      targetColumns.map(async (tq: EquivalenceGroupColumnInfo) => {
        const defs = await recodeApi.list(projectId, tq.dataset_id, tq.id)
        map.set(tq.id, defs)
      })
    ).then(() => {
      if (cancelled) return
      setTargetDefsMap(map)
      setTargetDefsLoaded(true)
    })
    return () => { cancelled = true }
  }, [open, projectId, targetColumns])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Compute compatibility per target
  const targetCompat = useMemo(() => {
    const map = new Map<number, CompatibilityType>()
    for (const tq of targetColumns) {
      map.set(tq.id, getCompatibility(sourceLabels, tq.scale_labels, sourceColumn.scale_points, tq.scale_points))
    }
    return map
  }, [targetColumns, sourceLabels, sourceColumn.scale_points])

  // Detect which targets already have ALL selected definitions copied (same name + type + mapping)
  const alreadyCopiedSet = useMemo(() => {
    const set = new Set<number>()
    if (!targetDefsLoaded || copyableDefs.length === 0) return set
    const selectedCopyable = copyableDefs.filter(d => selectedDefs.has(d.id))
    if (selectedCopyable.length === 0) return set
    for (const tq of targetColumns) {
      const compat = targetCompat.get(tq.id)
      const existingDefs = targetDefsMap.get(tq.id) || []
      const allCopied = selectedCopyable.every(def => {
        let expectedMapping = def.mapping
        if (compat === 'positional' && sourceLabels && tq.scale_labels) {
          expectedMapping = remapMapping(def.mapping, sourceLabels, tq.scale_labels)
        }
        return existingDefs.some(d =>
          d.name === def.name &&
          d.recode_type === def.recode_type &&
          mappingsEqual(d.mapping, expectedMapping)
        )
      })
      if (allCopied) set.add(tq.id)
    }
    return set
  }, [targetDefsLoaded, targetDefsMap, targetColumns, targetCompat, sourceLabels, copyableDefs, selectedDefs])

  // Pre-select all copyable defs and eligible targets on open
  /* eslint-disable react-hooks/set-state-in-effect -- reset selection when dialog opens with loaded data */
  useEffect(() => {
    if (!open || !targetDefsLoaded) return
    setSelectedDefs(new Set(copyableDefs.map(d => d.id)))
    const eligibleIds = targetColumns
      .filter((tq: EquivalenceGroupColumnInfo) => !alreadyCopiedSet.has(tq.id))
      .map((tq: EquivalenceGroupColumnInfo) => tq.id)
    setSelectedTargets(new Set(eligibleIds))
    setResults(null)
  }, [open, equivalenceGroupId, targetDefsLoaded, alreadyCopiedSet.size]) // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleDef = (id: number) => {
    setSelectedDefs(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTarget = (id: number) => {
    setSelectedTargets(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopy = async () => {
    setIsCopying(true)
    setResults(null)
    let success = 0
    let failed = 0
    let renamed = 0

    // Re-fetch definitions for all selected targets to get latest state
    const freshTargetDefs = new Map<number, RecodeDefinition[]>()
    await Promise.allSettled(
      targetColumns
        .filter((t: EquivalenceGroupColumnInfo) => selectedTargets.has(t.id))
        .map(async (tq: EquivalenceGroupColumnInfo) => {
          const defs = await recodeApi.list(projectId, tq.dataset_id, tq.id)
          freshTargetDefs.set(tq.id, defs)
        })
    )

    for (const tq of targetColumns.filter((t: EquivalenceGroupColumnInfo) => selectedTargets.has(t.id))) {
      const compat = targetCompat.get(tq.id)
      const existingDefs = freshTargetDefs.get(tq.id) || []

      for (const def of copyableDefs.filter(d => selectedDefs.has(d.id))) {
        // Compute remapped mapping
        let mapping = { ...def.mapping }
        let excludeValues = def.exclude_values ? [...def.exclude_values] : undefined

        if (compat === 'positional' && sourceLabels && tq.scale_labels) {
          mapping = remapMapping(def.mapping, sourceLabels, tq.scale_labels)
          if (excludeValues) {
            excludeValues = remapExcludeValues(excludeValues, sourceLabels, tq.scale_labels)
          }
        }

        // Skip if target already has an identical definition (name + type + mapping)
        const alreadyExists = existingDefs.find(d =>
          d.name === def.name &&
          d.recode_type === def.recode_type &&
          mappingsEqual(d.mapping, mapping)
        )
        if (alreadyExists) continue

        // Handle name conflict: rename existing definition if same name (but different mapping)
        const conflicting = existingDefs.find(d => d.name === def.name)
        if (conflicting) {
          let suffix = 1
          const existingNames = new Set(existingDefs.map(d => d.name))
          while (existingNames.has(`${def.name} (${suffix})`)) suffix++
          try {
            await recodeApi.update(projectId, tq.dataset_id, tq.id, conflicting.id, {
              name: `${def.name} (${suffix})`,
            })
            renamed++
          } catch {
            failed++
            continue
          }
        }

        try {
          await recodeApi.create(projectId, tq.dataset_id, tq.id, {
            name: def.name,
            recode_type: def.recode_type,
            output_type: def.output_type,
            mapping,
            exclude_values: excludeValues?.length ? excludeValues : null,
          })
          success++
        } catch {
          failed++
        }
      }
    }

    setResults({ success, failed, renamed })
    setIsCopying(false)

    // Invalidate equivalence groups and dataset columns
    queryClient.invalidateQueries({ queryKey: ['equivalence-groups', projectId] })
    queryClient.invalidateQueries({ queryKey: ['dataset-columns'] })

    // Refresh target defs so "already copied" state updates
    const updatedMap = new Map<number, RecodeDefinition[]>()
    await Promise.allSettled(
      targetColumns.map(async (tq: EquivalenceGroupColumnInfo) => {
        const defs = await recodeApi.list(projectId, tq.dataset_id, tq.id)
        updatedMap.set(tq.id, defs)
      })
    )
    setTargetDefsMap(updatedMap)

    if (failed === 0) {
      onCopyComplete()
    }
  }

  const compatLabel: Record<CompatibilityType, { icon: React.ReactNode; text: string; cls: string }> = {
    exact: { icon: <Check className="w-3.5 h-3.5" />, text: 'Exact match', cls: 'text-green-600' },
    positional: { icon: <ArrowRightLeft className="w-3.5 h-3.5" />, text: 'Positional', cls: 'text-amber-600' },
    incompatible: { icon: <TriangleAlert className="w-3.5 h-3.5" />, text: 'Unverified', cls: 'text-amber-500' },
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Copy Recodes to Linked Variables</DialogTitle>
        </DialogHeader>

        {group && (
          <div className="text-xs text-mm-text-muted mb-1">
            Linked group: <span className="font-medium text-mm-text">{group.label}</span>
          </div>
        )}

        {/* Definitions to copy */}
        <div className="mb-3">
          <div className="text-xs font-medium text-mm-text-muted uppercase mb-1.5">Definitions to copy</div>
          <div className="space-y-1">
            {definitions.map(def => {
              const isReverse = def.recode_type === 'reverse'
              return (
                <label
                  key={def.id}
                  className={`flex items-center gap-2 p-1.5 rounded text-sm ${isReverse ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-mm-surface-hover'}`}
                >
                  <Checkbox
                    checked={selectedDefs.has(def.id)}
                    onCheckedChange={() => toggleDef(def.id)}
                    disabled={isReverse}
                    className="shrink-0"
                  />
                  <span className="flex-grow truncate">{def.name}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                    def.recode_type === 'scale_map' ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-300' :
                    def.recode_type === 'category_group' ? 'bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-300' :
                    'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300'
                  }`}>
                    {def.recode_type === 'scale_map' ? 'Scale Map' :
                     def.recode_type === 'category_group' ? 'Category' : 'Reverse'}
                  </span>
                  {isReverse && <span className="text-[11px] text-mm-text-faint">source-dependent</span>}
                </label>
              )
            })}
          </div>
        </div>

        {!targetDefsLoaded && targetColumns.length > 0 ? (
          <div className="py-4 text-center text-mm-text-faint text-sm">Loading target definitions...</div>
        ) : (
          <>
            {/* Target columns */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="text-xs font-medium text-mm-text-muted uppercase mb-1.5">Target variables</div>
              {targetColumns.length === 0 ? (
                <div className="text-sm text-mm-text-faint p-3 text-center border rounded border-dashed">
                  No other variables in this linked group.
                </div>
              ) : (
                <div className="space-y-1">
                  {targetColumns.map((tq: EquivalenceGroupColumnInfo) => {
                    const compat = targetCompat.get(tq.id) || 'incompatible'
                    const info = compatLabel[compat]
                    const isAlreadyCopied = alreadyCopiedSet.has(tq.id)

                    return (
                      <label
                        key={tq.id}
                        className={`flex items-center gap-2 p-1.5 rounded text-sm ${
                          isAlreadyCopied ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-mm-surface-hover'
                        }`}
                      >
                        <Checkbox
                          checked={selectedTargets.has(tq.id)}
                          onCheckedChange={() => toggleTarget(tq.id)}
                          disabled={isAlreadyCopied}
                          className="shrink-0"
                        />
                        <span className="flex-grow min-w-0 truncate">
                          {tq.column_code && (
                            <span className="font-mono text-xs text-mm-text-muted mr-1">{tq.column_code}:</span>
                          )}
                          {tq.column_text}
                        </span>
                        <span className="text-[11px] text-mm-text-faint shrink-0">[{tq.dataset_name}]</span>
                        {isAlreadyCopied ? (
                          <span className="flex items-center gap-0.5 text-[11px] text-green-600 shrink-0">
                            <Check className="w-3.5 h-3.5" />
                            Already copied
                          </span>
                        ) : (
                          <span className={`flex items-center gap-0.5 text-[11px] shrink-0 ${info.cls}`}>
                            {info.icon}
                            {info.text}
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Results */}
            {results && (
              <div className={`text-xs p-2 rounded mt-2 ${results.failed > 0 ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' : 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'}`}>
                Copied {results.success} definition{results.success !== 1 ? 's' : ''} successfully.
                {results.renamed > 0 && ` ${results.renamed} existing definition${results.renamed !== 1 ? 's' : ''} renamed.`}
                {results.failed > 0 && ` ${results.failed} failed.`}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="outline" onClick={onClose}>
                {results ? 'Done' : 'Cancel'}
              </Button>
              {!results && (
                <Button
                  onClick={handleCopy}
                  disabled={selectedDefs.size === 0 || selectedTargets.size === 0 || isCopying}
                >
                  {isCopying ? 'Copying...' : `Copy ${selectedDefs.size} def${selectedDefs.size !== 1 ? 's' : ''} to ${selectedTargets.size} column${selectedTargets.size !== 1 ? 's' : ''}`}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
