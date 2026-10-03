import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CodeSet } from '@/lib/api'
import { choosableValues } from '@/lib/code-sets'
import { SELECTED_CARD } from '@/lib/selection'
import { cn } from '@/lib/utils'

/**
 * One code set as a SINGLE-CHOICE control — the coding surfaces' row-48 door.
 *
 * 🔴 **`role="radio"` inside ONE `role="radiogroup"`**, the `ColorSwatchPicker`
 * pattern (#788) and `MagnitudeStrip`'s tickable arm. Independent toggles
 * announcing themselves as buttons in a list make the wrong claim about what the
 * control does: a screen-reader user would have no way to learn that choosing
 * one value CLEARS another, which is the entire content of the interaction.
 *
 * 🔴 **The group is NAMED by the set's label through `aria-labelledby`, pointing
 * at a real heading.** Radix's `Group` does not associate a sibling `Label`
 * (Decision F, #830c), and a picker that announces one flat list of values with
 * no variable name is a reader hearing "Positive, Negative, Neutral" with
 * nothing saying what question they answer.
 *
 * 🔴 **A "clear" control is REQUIRED on a non-exhaustive set and it is a REAL
 * control with a name** — never "press the selected one again". A radio group
 * has no de-select gesture and re-pressing a radio is a no-op in every assistive
 * technology's model, so the only keyboard-reachable way to say "none of these"
 * has to be its own button. On an EXHAUSTIVE set it is offered too, because a
 * coder may legitimately un-decide; what differs is the words, since on an
 * inclusive set clearing MEANS "none of these" and on an exhaustive one it means
 * "not yet decided".
 *
 * 🔴 **Names are CLAIMS about the act (#912).** A value's accessible name is the
 * value it selects — never "Apply Negative" on a control that also clears
 * "Positive".
 *
 * ⚠️ **It claims every printable key it receives while focused**, exactly as
 * `MagnitudeStrip` does (#870 a). A `role="radiogroup"` div is none of the chord
 * hook's input-guard tags and `focusedElementOwnsKey` covers activation keys
 * only, so an unmatched digit would otherwise reach the window handler and ARM A
 * CHORD on the still-selected segment.
 *
 * ⚠️ **Selection does not follow focus.** Committing fires a request that clears
 * another application, so arrowing through the values would write four times on
 * the way to the fifth. Arrows move focus; Space/Enter commit — the APG variant
 * for exactly the case where selection has consequences, and the same reading
 * `ColorSwatchPicker` documents.
 *
 * 🔴 **FOCUS SURVIVES A COMMIT (#1041).** While a choice saves the controls are
 * `aria-disabled` and click-guarded, NEVER natively `disabled`: Chrome blurs a
 * focused element that becomes disabled, and measured live every press — mouse
 * or keyboard — dropped focus to `<body>` about 300 ms later. The clear control
 * IS natively disabled once there is nothing to clear, so pressing it gives
 * focus a destination instead: the group's tab stop, where the next choice is
 * made.
 */
export function CodeSetPicker({
  set,
  selectedCodeId,
  onSelect,
  busy = false,
  multipleSelected = false,
  className,
}: {
  set: CodeSet
  /** The ACTIVE coder's current value, or null. */
  selectedCodeId: number | null
  /**
   * A value's press passes its id — also for the value already checked, which
   * the caller's plan turns into a no-op (#1038 e). `null` is the clear
   * control. The caller builds the history entry and calls the endpoint.
   */
  onSelect: (codeId: number | null) => void
  /** A choice is being saved: presses are ignored, and nothing loses focus. */
  busy?: boolean
  /**
   * This coder holds two values at once — a contradiction reachable from a
   * merge, legacy data, or a set built over existing coding. Shown rather than
   * silently resolved: picking one for them would fabricate a judgement.
   */
  multipleSelected?: boolean
  className?: string
}) {
  const headingId = useId()
  const noticeId = useId()
  const values = choosableValues(set)
  const selectedIndex = values.findIndex((v) => v.id === selectedCodeId)
  // Null until the user arrows: the tabbable value is the CHECKED one (APG) and
  // falls back to the first, so an unanswered set is still reachable by Tab.
  // Keeping it null rather than seeding state means an externally-changed
  // selection moves the tab stop with it instead of stranding it.
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const activeIndex = focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const clearRef = useRef<HTMLButtonElement | null>(null)
  // Set by a press on the clear control, so the move below answers THAT press
  // and never pulls focus when the value is cleared some other way (an undo).
  const clearPressedRef = useRef(false)

  // The clear control disables itself the moment its clear lands, which blurs it
  // to `<body>`. Only when focus is still on it, or already lost, is it moved.
  useEffect(() => {
    if (selectedCodeId !== null || !clearPressedRef.current) return
    clearPressedRef.current = false
    const active = document.activeElement
    if (active === clearRef.current || active === document.body || active === null) {
      refs.current[activeIndex]?.focus()
    }
  }, [selectedCodeId, activeIndex])

  const moveTo = (next: number) => {
    if (values.length === 0) return
    const i = (next + values.length) % values.length
    setFocusIndex(i)
    refs.current[i]?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault(); moveTo(activeIndex + 1); return
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault(); moveTo(activeIndex - 1); return
      case 'Home':
        e.preventDefault(); moveTo(0); return
      case 'End':
        e.preventDefault(); moveTo(values.length - 1); return
    }
    // ⚠️ Claim every UNMODIFIED printable key so it cannot escape to the window
    // handler and arm a code chord on the segment this picker is about (#870 a).
    // Modifier chords pass — Ctrl+Z stays undo.
    //
    // 🔴 EXCEPT SPACE (#1041). `' '` is one character long, so this claim used to
    // cancel it — and Space is how a radio and a button are activated: no value,
    // and not the clear control, could be chosen with it. `MagnitudeStrip` gets
    // away with the same claim only because it handles Space itself first; this
    // picker leaves activation to the buttons. The layers above stand down for
    // an activation key on a focused control, so Space cannot arm anything there.
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
    }
  }

  if (values.length === 0) return null

  const clearLabel = set.exhaustive
    ? `Clear ${set.label} — not yet decided`
    : `None of these for ${set.label}`

  return (
    // ⚠️ The keydown sits on the OUTER wrapper, not on the radiogroup, so the
    // printable-key claim covers the clear button too — it is a sibling of the
    // values, not one of them (see below).
    <div className={cn('space-y-1', className)} onKeyDown={handleKeyDown}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={headingId} className="text-xs font-medium text-muted-foreground">
          {set.label}
        </span>
        {/* The basis is a property of the SET, so it is stated where the set is
            answered rather than only beside its α — a coder deciding what a
            blank means needs it here. */}
        <span className="text-[10px] text-muted-foreground">
          {set.exhaustive ? 'one required' : 'or none'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
      {/* 🔴 The radiogroup owns ONLY radios. The clear button is a sibling, not
          a child: `role="radiogroup"` may own `radio` children (and groups), and
          a plain button inside one is invalid ARIA — a reader counting the
          group's options would either include it or drop it, and neither is
          what it is. It still sits in the same row, and in the same keydown
          scope, because to the coder it is one control. */}
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        aria-describedby={multipleSelected ? noticeId : undefined}
        className="flex flex-wrap gap-1"
      >
        {values.map((value, i) => {
          const checked = value.id === selectedCodeId
          return (
            <button
              key={value.id}
              type="button"
              role="radio"
              ref={(el) => { refs.current[i] = el }}
              // 🔴 `aria-checked` on EVERY value, not only the chosen one — an
              // omitted `false` is a MISSING state, not a false one.
              aria-checked={checked}
              // The name is the value it selects, and nothing else (#912).
              aria-label={value.name}
              tabIndex={i === activeIndex ? 0 : -1}
              // Never native `disabled` — see the docstring (#1041).
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return
                clearPressedRef.current = false
                // 🔴 A radio press SELECTS; it never clears (#1038 e). Pressing
                // the checked value is a no-op in every assistive technology's
                // model, and the caller's plan says so — in a contradiction the
                // same press is how the coder resolves it, so the decision
                // needs the whole passage, which this control does not have.
                onSelect(value.id)
              }}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                'min-h-[24px]',
                // 🔴 The ONE selection recipe (`lib/selection.ts`), never a
                // hand-rolled tint: selection is blue, a CTA is filled green and
                // status is semantic, and a fourth spelling of "chosen" is how
                // those three stop being distinguishable. It also carries
                // `SELECTION_TEXT_FLOOR`, without which dim text on the tint
                // measures 3.12:1 in dark mode.
                checked
                  ? `${SELECTED_CARD} font-medium`
                  : 'border-border bg-background hover:bg-muted',
                busy && 'cursor-wait opacity-50',
              )}
            >
              {value.name}
            </button>
          )
        })}
      </div>
      {/* 🔴 A radio group has NO de-select gesture and re-pressing a radio is a
          no-op in every assistive technology's model, so this is the only
          keyboard route to "none of these". It is a real control with a name,
          never "press the selected one again". */}
      <button
        ref={clearRef}
        type="button"
        aria-label={clearLabel}
        // Natively disabled only when there is NOTHING to clear — a state that
        // lasts, so it earns no tab stop. Pressing it is what gets it there, and
        // the effect above gives focus somewhere to go.
        disabled={selectedCodeId === null}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return
          clearPressedRef.current = true
          onSelect(null)
        }}
        className={cn(
          'inline-flex min-h-[24px] min-w-[24px] items-center gap-1 rounded-full',
          'border border-dashed border-border px-2 py-1 text-xs text-muted-foreground',
          'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40',
          busy && 'cursor-wait opacity-50',
        )}
      >
        <X className="h-3 w-3" aria-hidden="true" />
        {set.exhaustive ? 'Clear' : 'None'}
      </button>
      </div>
      {multipleSelected && (
        // ⚠️ NOT `role="alert"`. This is persistent STATE, not something that
        // just happened: an assertive live region would announce on every mount
        // and every re-render of a passage that has been in this condition since
        // a merge. It reaches a reader through the group's `aria-describedby`
        // instead, which is how a description is supposed to arrive.
        <p id={noticeId} className="text-[11px] text-amber-700 dark:text-amber-400">
          Two values of “{set.label}” are on this passage. Choose one — until then
          it is left out of this variable’s agreement figure.
        </p>
      )}
    </div>
  )
}
