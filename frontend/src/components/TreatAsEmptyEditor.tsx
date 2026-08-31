/**
 * The project's non-response vocabulary — the UI half of `treat_as_empty`
 * (#816, 2026-08-31).
 *
 * ## Why this control sits inside the focal-column picker
 *
 * The setting is project-scoped and changes every denominator in the
 * qualitative stack (#519), which argued for putting it on a settings screen.
 * It is here instead, in the popover that renders `36/40 responded` for each
 * column, for one reason: **that is the number it changes.**
 *
 * #519 left an open question — *"if a researcher adds a string, the counts
 * move, and nothing currently says so"*. A warning would have been the obvious
 * answer and the wrong one; a marker that fires on every ordinary edit gets
 * dismissed (#707b). Putting the editor beside the counts and invalidating them
 * on save makes the disclosure the counts THEMSELVES. Nothing has to be
 * written, and nothing can go stale.
 *
 * ## The three states, and why the flag rides the wire
 *
 * `null` = the standard list · `[]` = only a genuinely blank cell counts ·
 * a list = REPLACE. Same shape as a column's `missing_values` declaration, and
 * reachable here without a tri-state radio: removing every value IS the empty
 * declaration, and "Use the standard list" sends `null`.
 *
 * 🔴 The effective list cannot say which state produced it — a project that
 * declares exactly the seven defaults looks identical to one that declared
 * nothing. `treat_as_empty_is_default` rides the payload for that reason;
 * comparing against a client-side copy of the defaults would be a mirror of a
 * backend constant, wrong the first time either moved.
 *
 * ## Accessibility notes
 *
 * Each remove button names ITS OWN value — N buttons called "Remove" say
 * nothing about which (#559/#785). The disclosure is a real `<button>` with
 * `aria-expanded` + `aria-controls`, and the add field has a real label rather
 * than a placeholder standing in for one.
 */
import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  /** The list IN EFFECT — the declaration, or the defaults. */
  values: string[]
  /** Whether those values are the built-in defaults (from the server). */
  isDefault: boolean
  /** `null` resets to the standard list; a list REPLACES it. */
  onChange: (next: string[] | null) => void
  isSaving?: boolean
}

export default function TreatAsEmptyEditor({
  values, isDefault, onChange, isSaving = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const panelId = useId()
  const inputId = useId()

  const trimmed = draft.trim()
  const isDuplicate = trimmed.length > 0 && values.includes(trimmed)

  const add = () => {
    if (!trimmed || isDuplicate) return
    onChange([...values, trimmed])
    setDraft('')
  }

  return (
    <div className="border-t">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full px-3 py-2 text-left hover:bg-accent"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="text-xs font-medium text-muted-foreground">
          What counts as no response
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {values.length === 0 ? 'blank only' : `${values.length} value${values.length === 1 ? '' : 's'}`}
        </span>
      </button>

      {open && (
        <div id={panelId} className="px-3 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {/* States the CONSEQUENCE, in the units shown directly above: the
                researcher is looking at "N/M responded" for every column while
                reading this. */}
            These answers are counted as no response, so they are excluded from
            the response counts above and from every text analysis.
          </p>

          {values.length === 0 ? (
            <p className="text-xs text-mm-text-muted italic">
              Only a genuinely empty cell counts as no response.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {values.map(value => (
                <li key={value}>
                  <span className="inline-flex items-center gap-1 rounded border border-mm-border-subtle bg-mm-bg pl-2 pr-1 py-0.5 text-xs">
                    <span className="font-mono">{value}</span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-accent focus-visible:opacity-100"
                      onClick={() => onChange(values.filter(v => v !== value))}
                      disabled={isSaving}
                      aria-label={`Remove "${value}" from non-responses`}
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1">
            <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
              Add an answer
            </label>
            <div className="flex gap-1">
              <input
                id={inputId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); add() }
                }}
                className="flex-1 min-w-0 h-8 text-sm border rounded px-2 bg-mm-surface text-mm-text border-mm-border-subtle"
                placeholder="Declined to answer"
                disabled={isSaving}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={add}
                disabled={isSaving || !trimmed || isDuplicate}
              >
                <Plus className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                Add
              </Button>
            </div>
            {/* ⚠️ Says WHY the button is off rather than leaving a disabled
                control unexplained. The duplicate case is the likely one: the
                value is right there in the list above, and typing it again
                otherwise reads as the control being broken. */}
            {isDuplicate && (
              <p className="text-xs text-mm-text-muted">
                &ldquo;{trimmed}&rdquo; is already counted as no response.
              </p>
            )}
          </div>

          {!isDefault && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onChange(null)}
              disabled={isSaving}
            >
              Use the standard list
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
