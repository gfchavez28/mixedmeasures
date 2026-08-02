/**
 * Shared recode utilities for cross-column definition compatibility and mapping.
 * Used by RecodeWorkbench (copy-to-equivalents) and the crosswalk's
 * cell context menu (copy-recode-to flow).
 */

export type CompatibilityType = 'exact' | 'positional' | 'incompatible'

/**
 * The numeric subset of a recode mapping's values — mirror of backend
 * `services/recode.py::mapping_numeric_values`. Non-numeric values (e.g. a
 * category_group's group-name strings, or a "not scored" sentinel) are skipped.
 */
export function mappingNumericValues(
  mapping: Record<string, number | string>,
): number[] {
  const out: number[] = []
  for (const v of Object.values(mapping)) {
    const n = Number(v)
    if (v !== '' && v !== null && Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * Reverse-scoring reflection offset `min + max` — mirror of backend
 * `services/recode.py::reverse_offset`. A REVERSE recode stores FORWARD codes;
 * the reversed score is `offset − code`, which is what the backend writes to
 * `value_numeric` at apply time. The display MUST reflect the same way or the
 * grid would show a different number than every analysis and export uses (#578).
 */
export function reverseOffset(values: number[]): number {
  if (values.length === 0) return 0
  return Math.min(...values) + Math.max(...values)
}

/**
 * Reflect a REVERSE recode's forward code about the scale midpoint (#578).
 *
 * `serverOffset` is the definition's `reverse_offset` from the wire and is THE
 * authority (#600): the backend computes it over the mapping's NON-null-set
 * values, because a key that is missing (recognized-N/A, declared, or excluded)
 * is not a scale point and must not set the reflection endpoint. This client
 * cannot derive that — it has neither the recognized-N/A rule nor the column's
 * missing declaration — so deriving it here would show a different number than
 * `value_numeric` holds, which is exactly the #578 drift.
 *
 * The local `mapping` fallback is for definitions fetched from an endpoint that
 * does not send the offset. It is the RAW min+max and is knowingly wrong for a
 * mapping containing a missing key — prefer passing `serverOffset` everywhere.
 */
export function reflectReverseValue(
  forwardCode: number,
  mapping: Record<string, number | string>,
  serverOffset?: number | null,
): number {
  if (serverOffset !== undefined && serverOffset !== null) {
    return serverOffset - forwardCode
  }
  const nums = mappingNumericValues(mapping)
  if (nums.length === 0) return forwardCode
  return reverseOffset(nums) - forwardCode
}

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
