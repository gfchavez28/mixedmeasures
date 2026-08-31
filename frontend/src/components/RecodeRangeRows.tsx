/**
 * Range-band rows for a recode rule — #823(d), 2026-08-31.
 *
 * ## Why this is a sibling of `MissingValueRows`, not a reuse of it
 *
 * The two look the same and mean different things, and the difference is one
 * field. A missing-values range's `label` is **optional display metadata** —
 * that editor's own docstring says ranges never label-match cells — while a
 * recode band's output **IS the rule's result**. Sharing the component would
 * mean a required field that is optional in half its call sites, which is how a
 * validator ends up with a mode flag deciding whether a value may be blank.
 *
 * What IS shared is the shape a researcher already knows from that editor three
 * inches up the same screen: `lo` / `to` / `hi`, blank for an open end, a
 * remove button per row, one `Add range` button.
 *
 * ## Why it is a second table rather than a row kind inside the mapping table
 *
 * The mapping table is one row per OBSERVED response and its columns are
 * Label / Value / Exclude / Actions. A band has no observed response, cannot be
 * excluded (an exclusion is keyed on a response's text), and needs two bound
 * inputs where the mapping has one label. Polymorphic columns are exactly what
 * `MissingValueRows` warns about — there, two row kinds share three columns and
 * "no single column header is true of both". Two tables, each with honest
 * headers, is the cheaper answer when the rows share nothing but a remove
 * button.
 *
 * ## Accessibility
 *
 * Every input names its own row and every remove button names its own row
 * (#559/#785 — N buttons called "Remove" say nothing about which). The table has
 * a real `<caption>`, and the overlap notice is a `<p>` tied to the table by
 * `aria-describedby` rather than a bare coloured strip.
 *
 * ⚠️ **A row is named by its ORDINAL, with its bounds as a parenthetical when it
 * has any (#863).** Naming it by bounds alone was the claim above failing on its
 * own terms: two identical bands got two identical names, and a blank row was
 * called *"any value"* — the wording for an UNBOUNDED band. `describeRow` owns
 * that, so the notice and the remove button cannot describe one row two ways.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  describeRow,
  rowOverlaps,
  type RangeRow,
} from '@/lib/recode-ranges'

/** Sentence-case the leading "range N …" when it opens the notice. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

interface Props {
  rows: RangeRow[]
  onChange: (rows: RangeRow[]) => void
  /** A scale map's bands must produce numbers; a category group's are names. */
  numericOutput: boolean
  /** The first failing row, from `buildRangePayload` — drives `aria-invalid`. */
  badRow?: number
  disabled?: boolean
}

export default function RecodeRangeRows({
  rows, onChange, numericOutput, badRow, disabled = false,
}: Props) {
  const captionId = useId()
  const overlapId = useId()
  const precedenceId = useId()

  const update = (i: number, patch: Partial<RangeRow>) => {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  // #863: ROW indices, from the helper that owns both the eligibility rule and
  // the mapping back. This used to filter here and print the filtered list's
  // indices as row numbers, so a blank row above a pair shifted the answer.
  const overlaps = rowOverlaps(rows)

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-mm-text-muted font-medium">Ranges</span>
      </div>

      {rows.length === 0 && (
        /* The empty state SAYS what the control is for. A researcher reaches
           this editor with 72 response rows above it; "Add range" alone does
           not explain that it is the way out of typing 72 group names. */
        <p className="text-xs text-mm-text-muted mb-2">
          Band a continuous variable — <em>18 to 29 → Under 30</em> — instead of
          giving every response its own row.
        </p>
      )}

      {/* 🔴 The PRECEDENCE rule, and it is persistent on purpose (#861).
          It used to live inside the empty state, so it disappeared the moment a
          row existed — i.e. it was absent exactly while the researcher was
          authoring bands and deciding what they do.

          ⚠️ It also names EXCLUSION now, which is the copy half of #861: an
          excluded response keeps its exclusion rather than taking the band's
          value, and before that fix the sentence was incomplete in precisely
          the way the defect was. One sentence, one source, both states — and
          it describes the table below via `aria-describedby`, so a reader
          entering the grid meets the rule rather than only the column names. */}
      <p id={precedenceId} className="text-xs text-mm-text-muted mb-2">
        Ranges are checked after the rows above, so a response you have already
        mapped — or excluded — keeps that.
      </p>

      {rows.length > 0 && (
        <table
          className="w-full text-sm border-collapse"
          aria-describedby={
            overlaps.length > 0 ? `${precedenceId} ${overlapId}` : precedenceId
          }
        >
          <caption id={captionId} className="sr-only">
            Range bands: a low and high bound, and the value every response in
            that band takes.
          </caption>
          <thead>
            <tr className="text-xs text-mm-text-muted">
              <th scope="col" className="text-left py-1 pr-2 w-1/3">From</th>
              <th scope="col" className="text-left py-1 px-2 w-1/3">To</th>
              <th scope="col" className="text-left py-1 px-2">
                {numericOutput ? 'Value' : 'Group'}
              </th>
              <th scope="col" className="w-8"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t">
                <td className="py-1 pr-2">
                  <Input
                    value={row.lo}
                    onChange={(e) => update(i, { lo: e.target.value })}
                    disabled={disabled}
                    placeholder="lowest"
                    inputMode="decimal"
                    className="h-8 text-sm bg-mm-surface"
                    aria-label={`Range ${i + 1} from`}
                    aria-invalid={badRow === i || undefined}
                  />
                </td>
                <td className="py-1 px-2">
                  <Input
                    value={row.hi}
                    onChange={(e) => update(i, { hi: e.target.value })}
                    disabled={disabled}
                    placeholder="highest"
                    inputMode="decimal"
                    className="h-8 text-sm bg-mm-surface"
                    aria-label={`Range ${i + 1} to`}
                    aria-invalid={badRow === i || undefined}
                  />
                </td>
                <td className="py-1 px-2">
                  <Input
                    value={row.output}
                    onChange={(e) => update(i, { output: e.target.value })}
                    disabled={disabled}
                    placeholder={numericOutput ? '1' : 'Under 30'}
                    className="h-8 text-sm bg-mm-surface"
                    aria-label={
                      numericOutput
                        ? `Value for range ${i + 1}`
                        : `Group name for range ${i + 1}`
                    }
                    aria-invalid={badRow === i || undefined}
                  />
                </td>
                <td className="py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-mm-text-muted hover:text-red-600"
                    onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                    disabled={disabled}
                    // #863: the ORDINAL first, the bounds only when the row has
                    // any. Two identical bands used to get two identical names,
                    // and a blank row was called "any value" — which is what an
                    // unbounded band means, not an empty one.
                    aria-label={`Remove ${describeRow(rows, i)}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ⚠️ DISCLOSURE, never a refusal. Overlap is legal and sometimes
          deliberate — a narrow band above a catch-all — and the matcher's
          first-match-wins rule makes the outcome well defined. Saying which row
          wins is more useful than blocking the save. */}
      {overlaps.length > 0 && (
        <p id={overlapId} className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {/* #863: each row is named by its ORDINAL AND its bounds, so the
              sentence carries its own evidence — if the indices were ever wrong
              again, the quoted bounds would visibly not match the row the
              researcher is looking at, instead of failing silently the way this
              did. */}
          {overlaps
            .map(([a, b]) => `${cap(describeRow(rows, a))} and ${describeRow(rows, b)} overlap`)
            .join('; ')}
          {' — '}a response in both takes the value of the one listed first.
        </p>
      )}

      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-7 text-xs"
        onClick={() => onChange([...rows, { lo: '', hi: '', output: '' }])}
        disabled={disabled}
      >
        <Plus className="w-3 h-3 mr-1" aria-hidden="true" />
        Add range
      </Button>
    </div>
  )
}
