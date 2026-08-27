import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { formatStat } from '@/lib/stat-format'

/**
 * Per-item diagnostics for Cronbach's alpha (#707a).
 *
 * ## Why this component exists at all
 *
 * The backend has always returned `item_variances`, and nothing has ever
 * displayed it — the whole reliability result renders as a ONE-LINE STRING
 * (`formatTestResult`), which cannot carry a per-item table. So the honest
 * framing of #707(a) is not "add a computation": the computation had nowhere to
 * go, and shipping the numbers without a surface would have repeated the
 * half-landed-wire class this project has hit five times (#624/#626/#627/#630).
 *
 * `item_variances` was also a POSITIONAL list with nothing naming the items, so
 * even a surface could not have labelled its rows. The payload now carries the
 * label beside each number, produced together rather than derived apart — the
 * #745/#746 "two halves of one fact" rule.
 *
 * ## What the numbers mean, and why the flag is the point
 *
 * The corrected item-total correlation is the item against the sum of the OTHER
 * items. A NEGATIVE one is the signature of an item scored in the opposite
 * direction to the rest — the most common and most fixable scale-construction
 * error, and one the app already has the remedy for (a reverse recode). That is
 * why the flag gets a row treatment rather than being left for the reader to
 * infer from a minus sign in a table of decimals.
 *
 * Alpha-if-deleted answers "would the scale be more reliable without this
 * item?" — meaningful only when at least three items remain, so it is `null`
 * (rendered as an em dash, never `0.00`) on a two-item scale.
 */

export interface AlphaItem {
  key: string
  label: string
  variance: number
  item_total_r: number | null
  alpha_if_deleted: number | null
  possible_reverse_coding: boolean
}

interface Props {
  items: AlphaItem[]
  /** The scale's own alpha, so a row can be compared against it. */
  alpha: number
}

export default function AlphaItemDiagnostics({ items, alpha }: Props) {
  const [open, setOpen] = useState(false)
  if (!items?.length) return null

  const flagged = items.filter(i => i.possible_reverse_coding)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="alpha-item-diagnostics"
        className="flex items-center gap-1 text-xs text-mm-text-secondary hover:text-mm-text"
      >
        <Chevron className="w-3 h-3" aria-hidden />
        Item diagnostics
        {flagged.length > 0 && (
          // Surfaced on the COLLAPSED control too: a finding hidden behind a
          // disclosure nobody opens has not been reported. Dual-encoded (icon +
          // text), never colour alone.
          <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-3 h-3" aria-hidden />
            {flagged.length} item{flagged.length > 1 ? 's' : ''} may need reverse-coding
          </span>
        )}
      </button>

      {open && (
        <div id="alpha-item-diagnostics" className="mt-1.5 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <caption className="sr-only">
              Per-item diagnostics: corrected item-total correlation and
              Cronbach&apos;s alpha with each item removed. The scale&apos;s alpha is{' '}
              {formatStat(alpha)}.
            </caption>
            <thead>
              <tr className="text-mm-text-secondary">
                <th scope="col" className="text-left font-medium py-1 pr-2">Item</th>
                <th scope="col" className="text-right font-medium py-1 px-1" title="Corrected item-total correlation: this item against the sum of the others">
                  r&nbsp;(item&ndash;total)
                </th>
                <th scope="col" className="text-right font-medium py-1 pl-1" title="Cronbach's alpha for the scale with this item removed">
                  &alpha;&nbsp;if&nbsp;dropped
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.key} className="border-t border-mm-border-subtle">
                  <th scope="row" className="text-left font-normal py-1 pr-2 text-mm-text">
                    <span className="flex items-center gap-1">
                      {item.possible_reverse_coding && (
                        <AlertTriangle
                          className="w-3 h-3 text-amber-700 dark:text-amber-300 flex-shrink-0"
                          aria-hidden
                        />
                      )}
                      <span className="truncate" title={item.label}>{item.label}</span>
                    </span>
                  </th>
                  <td className="text-right py-1 px-1 font-mono tabular-nums">
                    {formatStat(item.item_total_r)}
                  </td>
                  <td className="text-right py-1 pl-1 font-mono tabular-nums">
                    {formatStat(item.alpha_if_deleted)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {flagged.length > 0 && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
              A negative item&ndash;total correlation usually means the item is
              scored in the opposite direction to the rest of the scale. A reverse
              recode in the Variables view will re-align it.
            </p>
          )}
          <p className="mt-1 text-xs text-mm-text-faint">
            &alpha; if dropped is blank on a two-item scale &mdash; removing an item
            would leave one, and alpha needs at least two.
          </p>
        </div>
      )}
    </div>
  )
}
