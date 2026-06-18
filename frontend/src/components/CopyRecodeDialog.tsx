/**
 * CopyRecodeDialog — shared component for copying recode definitions
 * across questions within a group (equivalence or variable group).
 *
 * Originally extracted from the former EquivalenceManager CopyToGroupDialog.
 * Core logic: compatibility computation, label remapping, duplicate detection,
 * name conflict handling, is_primary management.
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { Check, TriangleAlert, ArrowRightLeft } from 'lucide-react'
import { recodeApi, type RecodeDefinition } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getCompatibility,
  remapMapping,
  remapExcludeValues,
  type CompatibilityType,
} from '@/lib/recode-utils'

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal column shape needed by CopyRecodeDialog */
export interface CopyRecodeColumn {
  id: number
  dataset_id: number
  dataset_name: string
  column_code: string | null
  column_text: string
  column_type: string
  scale_labels: string[] | null
  scale_points: number | null
  recode_definitions: Array<{ id: number; name: string; recode_type: string; is_primary: boolean }>
}

export interface CopyRecodeDialogProps {
  open: boolean
  onClose: () => void
  sourceColumn: CopyRecodeColumn
  sourceDefId: number
  targetColumns: CopyRecodeColumn[]
  projectId: number
  /** Query keys to invalidate after copying (e.g., ['equivalence-groups', pid]) */
  invalidateKeys?: unknown[][]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RECODE_TYPE_STYLES: Record<string, { label: string; cls: string }> = {
  scale_map: { label: 'Scale Map', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-300' },
  category_group: { label: 'Category', cls: 'bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-300' },
  reverse: { label: 'Reverse', cls: 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300' },
}

function mappingsEqual(a: Record<string, number | string>, b: Record<string, number | string>): boolean {
  const normalize = (m: Record<string, number | string>) =>
    JSON.stringify(Object.entries(m).sort(([k1], [k2]) => k1.localeCompare(k2)))
  return normalize(a) === normalize(b)
}

// ── Component ────────────────────────────────────────────────────────────────

export function CopyRecodeDialog({
  open,
  onClose,
  sourceColumn,
  sourceDefId,
  targetColumns,
  projectId,
  invalidateKeys,
}: CopyRecodeDialogProps) {
  const queryClient = useQueryClient()
  const [isCopying, setIsCopying] = useState(false)
  const [results, setResults] = useState<{ success: number; failed: number; renamed: number } | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<Set<number>>(new Set())

  // Fetch full definitions for the source question to get mapping data
  const { data: sourceFullDefs } = useQuery({
    queryKey: ['recode-definitions', projectId, sourceColumn.dataset_id, sourceColumn.id],
    queryFn: () => recodeApi.list(projectId, sourceColumn.dataset_id, sourceColumn.id),
    enabled: open,
  })

  const sourceDef = sourceFullDefs?.find(d => d.id === sourceDefId)

  // Source labels
  const sourceLabels = sourceColumn.scale_labels

  // Fetch full definitions for ALL target questions on dialog open (for duplicate detection)
  const [targetDefsMap, setTargetDefsMap] = useState<Map<number, RecodeDefinition[]>>(new Map())
  const [targetDefsLoaded, setTargetDefsLoaded] = useState(false)
  const [targetDefsFetchError, setTargetDefsFetchError] = useState(false)
  /* eslint-disable react-hooks/set-state-in-effect -- async fetch on dialog open with cancellation */
  useEffect(() => {
    if (!open || targetColumns.length === 0) return
    let cancelled = false
    setTargetDefsLoaded(false)
    setTargetDefsFetchError(false)
    const map = new Map<number, RecodeDefinition[]>()
    Promise.allSettled(
      targetColumns.map(async tq => {
        const defs = await recodeApi.list(projectId, tq.dataset_id, tq.id)
        map.set(tq.id, defs)
      })
    ).then((results) => {
      if (cancelled) return
      const anyFailed = results.some(r => r.status === 'rejected')
      setTargetDefsFetchError(anyFailed)
      setTargetDefsMap(map)
      setTargetDefsLoaded(true)
    })
    return () => { cancelled = true }
  }, [open, projectId, targetColumns])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Compatibility per target
  const targetCompat = useMemo(() => {
    const map = new Map<number, CompatibilityType>()
    for (const tq of targetColumns) {
      map.set(tq.id, getCompatibility(sourceLabels, tq.scale_labels, sourceColumn.scale_points, tq.scale_points))
    }
    return map
  }, [targetColumns, sourceLabels, sourceColumn.scale_points])

  // Detect which targets already have an identical definition (same name + same mapping)
  const alreadyCopiedSet = useMemo(() => {
    const set = new Set<number>()
    if (!sourceDef || !targetDefsLoaded) return set
    for (const tq of targetColumns) {
      const compat = targetCompat.get(tq.id)
      const existingDefs = targetDefsMap.get(tq.id) || []
      // Compute what the mapping would be if copied
      let expectedMapping = sourceDef.mapping
      if (compat === 'positional' && sourceLabels && tq.scale_labels) {
        expectedMapping = remapMapping(sourceDef.mapping, sourceLabels, tq.scale_labels)
      }
      // Check if any existing def matches name + mapping + type
      const duplicate = existingDefs.find(d =>
        d.name === sourceDef.name &&
        d.recode_type === sourceDef.recode_type &&
        mappingsEqual(d.mapping, expectedMapping)
      )
      if (duplicate) set.add(tq.id)
    }
    return set
  }, [sourceDef, targetDefsLoaded, targetDefsMap, targetColumns, targetCompat, sourceLabels])

  // Pre-select compatible targets on open, excluding already-copied ones
  /* eslint-disable react-hooks/set-state-in-effect -- reset selection when dialog opens with loaded data */
  useEffect(() => {
    if (!open || !sourceDef || !targetDefsLoaded) return
    const compatibleIds = targetColumns
      .filter(tq => !alreadyCopiedSet.has(tq.id))
      .map(tq => tq.id)
    setSelectedTargets(new Set(compatibleIds))
    setResults(null)
  }, [open, sourceDef?.id, targetDefsLoaded, alreadyCopiedSet.size]) // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleTarget = useCallback((id: number) => {
    setSelectedTargets(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleCopy = async () => {
    if (!sourceDef) return
    setIsCopying(true)
    setResults(null)
    let success = 0
    let failed = 0
    let renamed = 0

    // Re-fetch definitions for selected targets (to get latest state)
    const freshTargetDefs = new Map<number, RecodeDefinition[]>()
    const fetchPromises = targetColumns
      .filter(tq => selectedTargets.has(tq.id))
      .map(async tq => {
        const defs = await recodeApi.list(projectId, tq.dataset_id, tq.id)
        freshTargetDefs.set(tq.id, defs)
      })
    await Promise.allSettled(fetchPromises)

    // Copy to each selected target
    for (const tq of targetColumns.filter(t => selectedTargets.has(t.id))) {
      const compat = targetCompat.get(tq.id)
      const existingDefs = freshTargetDefs.get(tq.id) || []

      // Compute remapped mapping (positional remaps labels; exact/incompatible copies as-is)
      let mapping = { ...sourceDef.mapping }
      let excludeValues = sourceDef.exclude_values ? [...sourceDef.exclude_values] : undefined

      if (compat === 'positional' && sourceLabels && tq.scale_labels) {
        mapping = remapMapping(sourceDef.mapping, sourceLabels, tq.scale_labels)
        if (excludeValues) {
          excludeValues = remapExcludeValues(excludeValues, sourceLabels, tq.scale_labels)
        }
      }

      // Skip if target already has an identical definition (name + type + mapping)
      const alreadyExists = existingDefs.find(d =>
        d.name === sourceDef.name &&
        d.recode_type === sourceDef.recode_type &&
        mappingsEqual(d.mapping, mapping)
      )
      if (alreadyExists) continue

      // Handle name conflict: rename existing definition if same name (but different mapping)
      const conflicting = existingDefs.find(d => d.name === sourceDef.name)
      if (conflicting) {
        // Find unique rename suffix
        let suffix = 1
        const existingNames = new Set(existingDefs.map(d => d.name))
        while (existingNames.has(`${sourceDef.name} (${suffix})`)) suffix++
        try {
          await recodeApi.update(projectId, tq.dataset_id, tq.id, conflicting.id, {
            name: `${sourceDef.name} (${suffix})`,
          })
          renamed++
        } catch {
          failed++
          continue
        }
      }

      // Create the new definition
      try {
        const created = await recodeApi.create(projectId, tq.dataset_id, tq.id, {
          name: sourceDef.name,
          recode_type: sourceDef.recode_type,
          output_type: sourceDef.output_type,
          mapping,
          exclude_values: excludeValues?.length ? excludeValues : null,
        })

        // If source def is primary, set the new one as primary too
        if (sourceDef.is_primary) {
          await recodeApi.setPrimary(projectId, tq.dataset_id, tq.id, created.id)
        }

        success++
      } catch {
        failed++
      }
    }

    setResults({ success, failed, renamed })
    setIsCopying(false)

    // Invalidate caller-specified keys
    if (invalidateKeys) {
      for (const key of invalidateKeys) {
        queryClient.invalidateQueries({ queryKey: key })
      }
    }
    queryClient.invalidateQueries({ queryKey: ['dataset-columns'] })

    // Refresh target defs so "already copied" state updates
    const updatedMap = new Map<number, RecodeDefinition[]>()
    await Promise.allSettled(
      targetColumns.map(async tq => {
        const defs = await recodeApi.list(projectId, tq.dataset_id, tq.id)
        updatedMap.set(tq.id, defs)
      })
    )
    setTargetDefsMap(updatedMap)
  }

  const compatLabel: Record<CompatibilityType, { icon: React.ReactNode; text: string; cls: string }> = {
    exact: { icon: <Check className="w-3.5 h-3.5" />, text: 'Exact match', cls: 'text-green-600' },
    positional: { icon: <ArrowRightLeft className="w-3.5 h-3.5" />, text: 'Positional', cls: 'text-amber-600' },
    incompatible: { icon: <TriangleAlert className="w-3.5 h-3.5" />, text: 'Unverified', cls: 'text-amber-500' },
  }

  const defSummary = sourceDef
    ? `${sourceDef.name} (${RECODE_TYPE_STYLES[sourceDef.recode_type]?.label || sourceDef.recode_type})`
    : 'Loading...'

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Copy Definition to Group</DialogTitle>
        </DialogHeader>

        {/* Source info */}
        <div className="text-xs text-mm-text-muted space-y-1 mb-2">
          <div>
            Source: <span className="font-medium text-mm-text">{sourceColumn.column_code || sourceColumn.column_text.slice(0, 40)}</span>
            <span className="text-mm-text-faint ml-1">[{sourceColumn.dataset_name}]</span>
          </div>
          <div>Definition: <span className="font-medium text-mm-text">{defSummary}</span></div>
        </div>

        {!sourceDef || !targetDefsLoaded ? (
          <div className="py-6 text-center text-mm-text-faint text-sm">Loading definitions...</div>
        ) : (
          <>
            {targetDefsFetchError && (
              <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 mb-2">
                Some target definitions could not be loaded. Duplicate detection may be incomplete.
              </div>
            )}
            {/* Target questions */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="text-xs font-medium text-mm-text-muted uppercase mb-1.5">Target questions</div>
              {targetColumns.length === 0 ? (
                <div className="text-sm text-mm-text-faint p-3 text-center border rounded border-dashed">
                  No other questions in this group.
                </div>
              ) : (
                <div className="space-y-1">
                  {targetColumns.map(tq => {
                    const compat = targetCompat.get(tq.id) || 'incompatible'
                    const info = compatLabel[compat]
                    const isAlreadyCopied = alreadyCopiedSet.has(tq.id)
                    const existingNames = new Set(tq.recode_definitions.map(d => d.name))
                    const willConflict = !isAlreadyCopied && sourceDef != null && existingNames.has(sourceDef.name)

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
                          <>
                            <span className={`flex items-center gap-0.5 text-[11px] shrink-0 ${info.cls}`}>
                              {info.icon}
                              {info.text}
                            </span>
                            {willConflict && (
                              <span className="text-[11px] text-amber-500 shrink-0" title="Existing definition with same name will be renamed">rename</span>
                            )}
                          </>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Results */}
            {results && (
              <div className={`text-xs p-2 rounded mt-2 ${results.failed > 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                Copied to {results.success} question{results.success !== 1 ? 's' : ''} successfully.
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
                  disabled={selectedTargets.size === 0 || isCopying}
                >
                  {isCopying ? 'Copying...' : `Copy to ${selectedTargets.size} question${selectedTargets.size !== 1 ? 's' : ''}`}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
