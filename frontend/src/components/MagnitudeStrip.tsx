import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  anchorLabelFor,
  describeMagnitude,
  formatMagnitude,

  isUnrated,
  tickValues,
  type Magnitude,
  type MagnitudeScale,
} from '@/lib/magnitude'
import { SELECTION_TEXT_FLOOR } from '@/lib/selection'

/**
 * The rating control for magnitude coding — variant A's "rate at apply" strip (#35).
 *
 * Renders the DECLARED INSTRUMENT (range + anchor labels) at the moment of
 * judgement, which is the one thing that makes ratings reproducible across coders.
 * A number entered against an unseen scale is MAXQDA's "fuzzy variable"; a number
 * entered under its anchors is an instrument reading.
 *
 * ## 🔴 Why this is a focusable CONTROL, and why that is the whole design
 *
 * The filed plan was to extend the coding chord to a third keystroke
 * (`category → code → magnitude`). **Reading `useCodeChordShortcuts` refuted it:**
 * `onToggleCode` is a TOGGLE returning `void`, so by the second keystroke the action
 * has committed and the pending prefix is cleared — a third digit starts a NEW
 * chord — and a toggle can REMOVE, in which case there is nothing to rate.
 *
 * Making the strip a focusable control instead needs **zero changes to that hook**,
 * which three workbenches share: it already bails entirely on `INPUT`/`TEXTAREA`/
 * `contenteditable`, on `isEditing`, and on `e.defaultPrevented`. That is the same
 * escape hatch its own docs name for the inline-edit layer.
 *
 * 🔴 **But the stand-down covers only keys the strip MARKS (#870 a).** The tick arm
 * is a `div role="radiogroup"` — none of the hook's input-guard tags — and
 * `focusedElementOwnsKey` covers activation keys only. So a digit that is not a
 * value on this scale (`7` on 0–5), or a letter verb (`n`, `c`, `s`), used to fall
 * through to the WINDOW handler with the segment still selected: `7` ARMED A CHORD
 * and the next digit applied a code from category 7; `n` opened a note. Every
 * printable key the focused strip receives is `preventDefault`ed now, matched or
 * not — the hook checks `defaultPrevented` first. Modifier chords (Ctrl+Z) are
 * deliberately NOT claimed: undo stays global while a rating is pending.
 *
 * 🔴 **Escape MUST be `preventDefault`ed here.** The hook's input guard has a
 * carve-out that still calls `onEscapeFallback()` for Escape inside a field, so an
 * un-prevented press would skip the rating AND dismiss a side panel — two layers
 * for one keystroke. Marking the event is what makes the hook's stand-down fire.
 *
 * 🔴 **The arrow cursor is announced through `aria-activedescendant` (#870 b).**
 * Focus stays on the container and the ticks are `tabIndex=-1` radios, so without
 * it the cursor was invisible to a screen reader — the live region speaks only the
 * COMMITTED value. The DOM holds the whole tick set, so there is deliberately no
 * `aria-setsize`/`aria-posinset` (#758/#772's boundary).
 *
 * ⚠️ **Mount it with a `key` on the target** (`${segmentId}-${codeId}`, #870 c):
 * the cursor and the focus effect initialise once, so a target swap on a live
 * mount would keep the old cursor and leave focus wherever the click put it.
 */

export interface MagnitudeStripProps {
  codeName: string
  scale: MagnitudeScale
  /** Current rating, or null when unrated. */
  value: Magnitude
  /** Commit a rating. */
  onCommit: (value: number) => void
  /** Leave unrated and dismiss (the explicit skip — Esc). */
  onSkip: () => void
  /** Take focus on mount. Default true: variant A opens this as the active surface. */
  autoFocus?: boolean
}

export default function MagnitudeStrip({
  codeName, scale, value, onCommit, onSkip, autoFocus = true,
}: MagnitudeStripProps) {
  const ticks = useMemo(() => tickValues(scale), [scale])
  const tickable = ticks.length > 0
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The cursor is where the user is LOOKING; the committed value is what is saved.
  // They part while arrowing, which is why this is not derived from `value`.
  const initialIndex = useMemo(() => {
    if (isUnrated(value)) return Math.floor(ticks.length / 2)
    const found = ticks.indexOf(value as number)
    return found >= 0 ? found : Math.floor(ticks.length / 2)
  }, [value, ticks])
  const [cursor, setCursor] = useState(initialIndex)
  // Stable per-mount ids for `aria-activedescendant` (#870 b) and the input hint.
  const domId = useId()
  const tickDomId = useCallback((i: number) => `${domId}-tick-${i}`, [domId])
  const hintId = `${domId}-hint`
  // The number-input arm's out-of-range message. Enter with a value outside the
  // scale used to be a silent no-op — the strip looked like it had refused to
  // save and said nothing about why.
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!autoFocus) return
    // Focusing is what stands the window-level chord layer down (see the header).
    if (tickable) containerRef.current?.focus()
    else inputRef.current?.focus()
  }, [autoFocus, tickable])

  const commitAt = useCallback((index: number) => {
    const v = ticks[index]
    if (v !== undefined) onCommit(v)
  }, [ticks, onCommit])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 🔴 Escape first, and always prevented — see the header note.
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onSkip()
      return
    }
    if (!tickable) return

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(ticks.length - 1, c + 1))
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (e.key === 'Home') { e.preventDefault(); setCursor(0); return }
    if (e.key === 'End') { e.preventDefault(); setCursor(ticks.length - 1); return }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commitAt(cursor)
      return
    }
    // The fast path, and the reason variant A is viable at 264 applications: a
    // digit is the VALUE, committed in one press.
    //
    // ⚠️ Mapped to the value, never to the tick INDEX. On a 0–10 scale index 8 is
    // value 7, and a coder typing "7" means seven. A scale whose values are not
    // single digits simply has no digit shortcut — honest, and `isTickable` keeps
    // that case rare.
    if (e.key.length === 1 && e.key >= '0' && e.key <= '9') {
      const asValue = Number(e.key)
      const idx = ticks.indexOf(asValue)
      if (idx >= 0) {
        e.preventDefault()
        setCursor(idx)
        commitAt(idx)
        return
      }
      // An unmatched digit falls through to the claim below: it is NOT a value
      // here, and it must not become a chord prefix at the window either.
    }
    // 🔴 #870 (a): every printable key the focused strip receives is CLAIMED, so
    // the window-level chord layer stands down on `defaultPrevented`. Without
    // this, `7` on a 0–5 scale armed chord 7 and `n` opened a note. Modifier
    // chords pass through on purpose — Ctrl+Z is still undo.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault()
  }, [tickable, ticks, cursor, commitAt, onSkip])

  const rangeLabel = `${formatMagnitude(scale.min)}–${formatMagnitude(scale.max)}`
  const lowAnchor = anchorLabelFor(scale.min, scale)
  const highAnchor = anchorLabelFor(scale.max, scale)

  return (
    <div
      // Padding is budgeted, not styled: at 640×360 the column has 85px for this
      // control, and py-2 here plus py-2 on the mount's wrapper put the anchors
      // line under the status bar. Measured after the trim: 84px, all three
      // lines visible. Widen either and re-measure at that viewport.
      className={`rounded-lg border border-mm-blue/50 bg-mm-bg px-2.5 py-1.5 ${SELECTION_TEXT_FLOOR}`}
      data-testid="magnitude-strip"
    >
      {/*
        ONE header line: the question, then the range and the named skip. The
        skip used to be its own line under the anchors — MEASURED at 640×360
        (a 1280×720 window at 200% zoom, #717) on the document workbench: the
        page chrome leaves the column 85px, the four-line strip needed 119px,
        and its last line sat under the status bar. Three lines fit above it.
        The skip is NAMED, not implied: variant A exists to avoid missing data,
        but a coder who cannot judge this segment must have an honest way out —
        and an unrated application stays a first-class state (null, never 0).
      */}
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-[11px] text-mm-text-secondary min-w-0 truncate">
          <span className="font-semibold text-mm-text">{codeName}</span>
          {' — how much?'}
        </span>
        <span className="text-[10px] text-mm-text-muted shrink-0 whitespace-nowrap">
          <span className="font-mono">{rangeLabel}</span>
          {' · '}
          <kbd className="font-mono">Esc</kbd> leave unrated
        </span>
      </div>

      {tickable ? (
        <div
          ref={containerRef}
          role="radiogroup"
          tabIndex={0}
          aria-label={`Rate ${codeName}, ${rangeLabel}`}
          // The cursor tick is the active descendant: a reader following the
          // group hears each tick as the arrows move (#870 b). No setsize /
          // posinset — the DOM holds the whole set.
          aria-activedescendant={tickDomId(cursor)}
          onKeyDown={onKeyDown}
          className="flex gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-mm-green rounded"
        >
          {ticks.map((tick, i) => {
            const selected = !isUnrated(value) && value === tick
            const isCursor = i === cursor
            const anchor = anchorLabelFor(tick, scale)
            return (
              <button
                key={tick}
                id={tickDomId(i)}
                type="button"
                role="radio"
                aria-checked={selected}
                // One tab stop for the group: the container holds it, the ticks
                // are reached with arrows (#701b's roving pattern).
                tabIndex={-1}
                aria-label={anchor ? `${formatMagnitude(tick)}, ${anchor}` : formatMagnitude(tick)}
                onClick={() => { setCursor(i); onCommit(tick) }}
                className={`flex-1 h-[18px] rounded-[3px] font-mono text-[9px] leading-[18px] text-center transition-colors ${
                  selected
                    ? 'bg-mm-blue text-white'
                    : 'bg-mm-border text-mm-text-muted hover:bg-mm-blue/30'
                } ${isCursor ? 'outline outline-1 outline-offset-1 outline-mm-green' : ''}`}
              >
                {formatMagnitude(tick)}
              </button>
            )
          })}
        </div>
      ) : (
        // A scale too fine to tick (0–100 by 1 is 101 targets, unhittable at
        // 640×360) gets a number input instead of a control nobody can use.
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          min={scale.min}
          max={scale.max}
          step={scale.step || 1}
          defaultValue={isUnrated(value) ? '' : String(value)}
          aria-label={`Rate ${codeName}, ${rangeLabel}`}
          aria-invalid={hint != null || undefined}
          aria-describedby={hint != null ? hintId : undefined}
          onChange={() => { if (hint != null) setHint(null) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onSkip(); return }
            if (e.key === 'Enter') {
              e.preventDefault()
              const n = Number((e.target as HTMLInputElement).value)
              if (Number.isFinite(n) && n >= scale.min && n <= scale.max) onCommit(n)
              // Say so, rather than refusing silently: the coder pressed Enter
              // and nothing happened, which reads as a broken save.
              else setHint(`Enter a value between ${formatMagnitude(scale.min)} and ${formatMagnitude(scale.max)}.`)
            }
          }}
          className="w-full h-7 rounded border border-mm-border bg-mm-surface px-2 text-[12px] font-mono"
        />
      )}
      {hint != null && (
        <p id={hintId} role="alert" className="mt-1 text-[10px] text-red-600 dark:text-red-400">
          {hint}
        </p>
      )}

      <div className="flex justify-between mt-0.5 text-[9.5px] text-mm-text-muted">
        <span>{lowAnchor ? `${formatMagnitude(scale.min)} · ${lowAnchor}` : ''}</span>
        <span>{highAnchor ? `${formatMagnitude(scale.max)} · ${highAnchor}` : ''}</span>
      </div>

      {/* The live region announces the COMMITTED state only. The cursor is
          announced by `aria-activedescendant` on the group (#870 b) — before that
          this comment claimed a reader "hears each tick as it is focused", which
          described focus movement that never happened. */}
      <span className="sr-only" aria-live="polite">
        {describeMagnitude(value, scale)}
      </span>
    </div>
  )
}
