/**
 * Shared type definitions for Recharts callback props used across chart components.
 *
 * Recharts passes loosely-typed objects to custom tick, label, dot, and tooltip
 * renderers. These interfaces replace `any` while remaining assignment-compatible
 * with what recharts actually passes at runtime.
 *
 * For tick/label/dot callbacks: recharts' own exported types (XAxisTickContentProps,
 * YAxisTickContentProps, LabelProps, DotItemDotProps) have `x`/`y` as
 * `string | number | undefined`. Our callbacks always receive numbers in practice,
 * so we use `Record<string, unknown>` and destructure with `Number()` casts.
 */

// ── Dynamic chart data row ───────────────────────────────────────────────────

/**
 * A row in recharts chart data with dynamically-keyed fields.
 * Used for grouped charts where group values become keys, and for
 * internal metadata fields prefixed with `_`.
 */
export type ChartDataRow = Record<string, unknown>

// ── Recharts tooltip payload entry ───────────────────────────────────────────

/**
 * A single entry in the Recharts tooltip payload array.
 * Recharts' own Payload type has `payload?: any`, so we provide a
 * tighter contract for the fields our custom tooltips actually access.
 */
export interface RechartsPayloadEntry {
  name: string
  value: number | string
  fill?: string
  color?: string
  stroke?: string
  dataKey: string | number
  payload: ChartDataRow
  [key: string]: unknown
}

/** Props for custom tooltip components (replaces `{ active, payload, label }: any`) */
export interface RechartsTooltipProps {
  active?: boolean
  payload?: RechartsPayloadEntry[]
  label?: string | number
}
