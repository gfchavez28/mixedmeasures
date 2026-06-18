/**
 * ScaleLabelsMismatchIcon — gutter icon shown on EG rows where the cells'
 * scale_labels don't match (Phase 4.5 v2).
 *
 * Rendered in the row gutter when buildGrid::buildEgRow detects a mismatch
 * via normalizeScaleLabels. The tooltip surfaces the actual per-dataset
 * label diff so researchers can see WHICH datasets disagree and on what
 * (rather than a generic "labels differ" warning that gives them nothing
 * actionable).
 *
 * Tooltip format:
 *   Board: Strongly disagree, Disagree, Neutral, Agree, Strongly agree (5pt)
 *   Staff: Never, Rarely, Sometimes, Often, Always (5pt)
 *   Stakeholder: (no scale)
 *
 * Implementation note: only EG rows reach this component. Synthetic single-
 * cell rows (`kind:'unlinked'`) have one cell — no comparison possible —
 * and never set `has_scale_labels_mismatch`, so this component isn't
 * rendered for them.
 */

import { AlertTriangle } from 'lucide-react'

const MAX_LABEL_LIST_CHARS = 80

interface ScaleLabelsMismatchIconProps {
  /** Per-dataset scale labels for the row's populated cells. Cells with
   * null scale_labels render as "(no scale)" to make the absence explicit. */
  labelsByDataset: Array<{
    dataset_id: number
    dataset_name: string
    scale_labels: string[] | null
  }>
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function describeLabels(labels: string[] | null): string {
  if (!labels || labels.length === 0) return '(no scale)'
  const joined = labels.join(', ')
  return `${truncate(joined, MAX_LABEL_LIST_CHARS)} (${labels.length}pt)`
}

export function ScaleLabelsMismatchIcon({ labelsByDataset }: ScaleLabelsMismatchIconProps) {
  // Build a multi-line tooltip showing per-dataset labels. Newlines render
  // verbatim in title attributes across browsers — no extra wrapping logic.
  const tooltip = labelsByDataset
    .map((d) => `${d.dataset_name}: ${describeLabels(d.scale_labels)}`)
    .join('\n')

  return (
    <span
      className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center text-amber-600 dark:text-amber-400"
      title={`Scale labels differ across datasets:\n${tooltip}`}
      aria-label={`Scale labels mismatch warning. ${tooltip.replace(/\n/g, '. ')}`}
      data-testid="scale-labels-mismatch-icon"
    >
      <AlertTriangle className="w-3.5 h-3.5" />
    </span>
  )
}
