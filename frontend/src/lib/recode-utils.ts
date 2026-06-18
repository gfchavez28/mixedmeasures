/**
 * Shared recode utilities for cross-column definition compatibility and mapping.
 * Used by RecodeWorkbench (copy-to-equivalents) and the crosswalk's
 * cell context menu (copy-recode-to flow).
 */

export type CompatibilityType = 'exact' | 'positional' | 'incompatible'

export function getCompatibility(
  sourceLabels: string[] | null,
  targetLabels: string[] | null,
  sourcePoints?: number | null,
  targetPoints?: number | null,
): CompatibilityType {
  // Both have labels: compare directly
  if (sourceLabels && targetLabels) {
    if (sourceLabels.length !== targetLabels.length) return 'incompatible'
    const srcNorm = sourceLabels.map(l => l.toLowerCase())
    const tgtNorm = targetLabels.map(l => l.toLowerCase())
    if (JSON.stringify(srcNorm) === JSON.stringify(tgtNorm)) return 'exact'
    return 'positional'
  }
  // Both null: no labels to remap, treat as exact copy
  if (!sourceLabels && !targetLabels) return 'exact'
  // One has labels, one doesn't: fall back to scale_points comparison
  if (sourcePoints && targetPoints && sourcePoints === targetPoints) return 'positional'
  return 'incompatible'
}

export function remapMapping(
  mapping: Record<string, number | string>,
  sourceLabels: string[],
  targetLabels: string[],
): Record<string, number | string> {
  // Build source label → position map (case-insensitive)
  const srcIndex = new Map<string, number>()
  sourceLabels.forEach((l, i) => srcIndex.set(l.toLowerCase(), i))

  const result: Record<string, number | string> = {}
  for (const [srcKey, val] of Object.entries(mapping)) {
    const idx = srcIndex.get(srcKey.toLowerCase())
    if (idx !== undefined && idx < targetLabels.length) {
      result[targetLabels[idx]] = val
    } else {
      // Key not in source labels (e.g. extra mapping entry) — skip or keep with target label if possible
      result[srcKey] = val
    }
  }
  return result
}

export function remapExcludeValues(
  excludeValues: string[],
  sourceLabels: string[],
  targetLabels: string[],
): string[] {
  const srcIndex = new Map<string, number>()
  sourceLabels.forEach((l, i) => srcIndex.set(l.toLowerCase(), i))

  return excludeValues.map(val => {
    const idx = srcIndex.get(val.toLowerCase())
    if (idx !== undefined && idx < targetLabels.length) {
      return targetLabels[idx]
    }
    return val
  })
}
