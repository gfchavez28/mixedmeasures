import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ColumnFrequenciesResponse, ValueFrequency } from '@/lib/api'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { VALUE_LABEL_SEED_MAX_CODES } from '@/lib/dataset-constants'

/**
 * The Variables view's observed-value summary (#809).
 *
 * ## What was wrong
 *
 * It rendered every distinct value of the column in an unbounded `<table>`,
 * ABOVE the value-labels and missing-value editors — so on `id_` in a real GSS
 * import (4,510 distinct values) the two editors this view exists for sat
 * thousands of rows below the fold. Ten columns in the dev corpus exceed 50
 * distinct values. It also plainly broke the standing wide-table rule
 * (#383/#385): a table that can render taller than its container scrolls inside
 * a height-constrained box, and this one did not.
 *
 * ## Three decisions worth not re-litigating
 *
 * 🔴 **The cap is at the RENDER and must never move to the server.** The obvious
 * fix — `LIMIT` in `get_value_frequencies` — is refused, because that payload has
 * THREE consumers and only one of them is this table. `RecodeWorkbench`'s
 * `getLabels` seeds a NEW recode definition's key set from it (priority 3), and
 * `ColumnDictionaryEditor` seeds the value-label dictionary from it. A server
 * limit would silently seed an incomplete mapping — every value past the cut
 * simply absent from the rule, and the cells it would have matched left NULL.
 * That is a data defect wearing a performance fix's clothes. (`SubgroupFilterPanel`
 * is the third reader.)
 *
 * ⚠️ **The collapse keys on CARDINALITY, never on the column TYPE.** #809 asked
 * whether this should render at all for a `numeric` column, since the three
 * worst measured cases were numeric. But a numeric column holding a 1–5 Likert
 * is exactly where a frequency table earns its place, and a `nominal` column
 * with 94 distinct values is the noise case. Type is a proxy; the number of
 * distinct values is the property that actually decides — and scoping a rule by
 * type rather than by the property is the error that produced #793 (a guard
 * scoped by recode type) and #806 (a gate scoped by column type when `source`
 * was the question).
 *
 * ⚠️ **Nothing is truncated, so nothing needs a "showing N of M" disclosure.**
 * The whole distribution is present; the box scrolls. A silently truncated
 * frequency table would be worse than a long one — that is the no-silent-caps
 * rule — which is a second reason the bound is a scroll box and not a slice.
 */
export function ValueFrequenciesPanel({
  data,
}: {
  data: Pick<ColumnFrequenciesResponse, 'frequencies' | 'total'> | undefined
}) {
  const distinct = data?.frequencies.length ?? 0

  /**
   * `null` = the researcher has not decided; fall back to the cardinality rule.
   *
   * 🔴 **NOT `useState(distinct <= …)`, and this was FOUND BY DRIVING THE PAGE.**
   * That initialiser runs once, on mount — which happens while the frequencies
   * query is still in flight, so `data` is `undefined`, `distinct` is 0, and
   * `0 <= 30` fixes the panel OPEN before the real count exists. Measured live
   * on GSS `year` (35 distinct): it rendered expanded, i.e. the fold did not work
   * for a single variable it was written for. The early return below hides the
   * empty state but does not stop the hook from having already decided.
   *
   * Deriving instead of storing means there is nothing to race: before the
   * payload the component renders nothing anyway, and the moment it arrives the
   * rule applies to a real number.
   *
   * ⚠️ **Still `key={column.id}` at the call site** — the researcher's OWN choice
   * must not follow them to the next variable. And still not an effect: the
   * payload gets a fresh identity on every refetch (a >60s window refocus is
   * enough), and an effect recomputing this would slam the panel shut under
   * someone who had just opened it — the #613 shape one component over.
   */
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? distinct <= VALUE_LABEL_SEED_MAX_CODES
  const setOpen = (next: boolean) => setChoice(next)

  if (!data || distinct === 0) return null

  const pct = (f: ValueFrequency) =>
    data.total > 0 ? Math.round((f.count / data.total) * 100) : 0

  return (
    <section className="mb-6" aria-labelledby="value-frequencies-heading">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="value-frequencies-body"
        className="flex items-center gap-1.5 w-full text-left rounded hover:bg-mm-surface-hover px-1 -mx-1 py-0.5"
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-mm-text-faint flex-none" aria-hidden="true" />
          : <ChevronRight className="w-4 h-4 text-mm-text-faint flex-none" aria-hidden="true" />}
        <h3 id="value-frequencies-heading" className="text-sm font-semibold text-mm-text">
          Observed values
        </h3>
        {/* The count is the fact that makes the folded state informative rather
            than merely closed — "4,510 distinct values" tells the researcher why
            it is folded and what opening it costs. */}
        <span className="text-xs text-mm-text-muted">
          {distinct.toLocaleString()} distinct
        </span>
      </button>

      {open && (
        <div id="value-frequencies-body" className="mt-2">
          {/* #383/#385: bounded box, both axes, `data-scrollable-table` kept. */}
          <ScrollableTable maxHeight="20rem" className="border rounded-lg">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Observed values in this variable with how often each occurs.
              </caption>
              <thead>
                <tr className="bg-mm-bg text-xs text-mm-text-muted sticky top-0">
                  <th scope="col" className="text-left py-1.5 px-3">Value</th>
                  <th scope="col" className="text-right py-1.5 px-3 w-16">Count</th>
                  <th scope="col" className="text-right py-1.5 px-3 w-16">%</th>
                </tr>
              </thead>
              <tbody>
                {data.frequencies.map((f) => (
                  <tr
                    key={f.value_text}
                    className={`border-t ${f.is_na ? 'text-mm-text-faint italic' : ''}`}
                  >
                    <td className="py-1 px-3">{f.value_text}{f.is_na ? ' (N/A)' : ''}</td>
                    <td className="py-1 px-3 text-right tabular-nums">{f.count.toLocaleString()}</td>
                    <td className="py-1 px-3 text-right tabular-nums">{pct(f)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTable>
        </div>
      )}
    </section>
  )
}
