import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildShortcutCategories, type ShortcutCodeInput } from '@/lib/codeShortcuts'

/**
 * Shared chord-dispatch keyboard layer for the coding workbenches (#388 Phase 1).
 *
 * Owns the `window` keydown listener and the numeric/chord state machine, delegating
 * every workbench-specific action to injected callbacks. Built to the Section-3 canon
 * of the refactor plan (the internal design notes):
 *   - chord prefix (digit 2-9) → code digit (1-9), resolved through the SHARED
 *     `buildShortcutCategories` helper so the keystroke can never desync from the
 *     visible label (`useCodeShortcutLabels`) — see plan §3a.
 *   - 1500ms clear-on-timeout (never auto-commits a code); a non-digit key cancels a
 *     pending chord immediately and then passes through to its normal action.
 *   - Escape unwinds ONE layer per press: pending-chord → media overlay (theater/PiP)
 *     → selection → fallback (panel).
 *     The inline-edit layer lives in the editing control's own handler, reached because
 *     this listener bails entirely while `isEditing` (plan G-B); don't add it here.
 *   - input guard skips INPUT/TEXTAREA/SELECT/contenteditable.
 *
 * Stability (plan G-A / G-G): the listener is bound ONCE (mount-only effect) and reads
 * all volatile inputs through `optionsRef`, reassigned every render. Do not move options
 * into the effect deps — that reintroduces the per-keystroke rebind storm and the
 * stale-closure trap this hook exists to remove.
 */

/** Pending-chord clear timeout. Long + forgiving because it never auto-commits. */
export const CHORD_TIMEOUT_MS = 1500

export interface UseCodeChordShortcutsOptions<T extends ShortcutCodeInput> {
  /** Full code list; the chord map + numeric_id map are derived from it internally. */
  codes: T[]
  /** Count of currently-selected coding targets. Gates the verbs + numeric/chord apply. */
  selectionCount: number
  /** True while an inline edit (segment text / title / value) is active → handler bails. */
  isEditing: boolean
  /** True when the item list owns arrow nav (Up/Down). When false, arrows are left alone. */
  arrowNavEnabled: boolean
  /** When explicitly false, the whole handler bails (e.g. TextCodingView's analysis tab). Default true. */
  enabled?: boolean

  /** Apply/remove the resolved code on the current selection. */
  onToggleCode: (code: T) => void
  /** `j` — jump to next uncoded (allowed with no selection). */
  onJumpUncoded?: () => void
  /** `s` — toggle quote/excerpt on the selection (selection-gated). */
  onToggleQuote?: () => void
  /** `c` — open the create-code flow for the selection (selection-gated). */
  onCreateCode?: () => void
  /** `n` — open the create-note flow for the selection (selection-gated). */
  onCreateNote?: () => void
  /** `F2` — callback decides edit-at-1 / rename-at-0 / no-op-at-2+ (no selection gate; fixes G-H). */
  onEditOrRename?: () => void

  /** Up/Down list navigation. `extend` = Shift (range), `jump` = Ctrl/Cmd (to far end). */
  onArrowNav?: (direction: 1 | -1, opts: { extend: boolean; jump: boolean }) => void
  /** Left/Right panel focus. Return true if handled → the hook preventDefaults. */
  onArrowHorizontal?: (direction: 'left' | 'right') => boolean

  /**
   * Workbench-specific keys (e.g. CodingWorkbench Space/`g`, TextCodingView `[`/`]`).
   * The hook calls the handler for a matching key (after the input/editing/enabled guards,
   * before the selection gate, so a handler may run with no selection); the handler does
   * ALL its own gating (focus, viewMode, …) and returns `true` if it acted — only then does
   * the hook `preventDefault` and stop. Returning `false` lets the key fall through.
   */
  extraKeys?: Record<string, () => boolean>

  /** Clear the current selection (Escape: list-focused layer). */
  clearSelection?: () => void
  /**
   * Escape layer for a temporary media overlay state (video theater / PiP —
   * V1 slab 4). Checked right after the pending-chord layer; return true if an
   * overlay was exited (the press is consumed), false to fall through to the
   * panel/selection layers.
   */
  onEscapeOverlay?: () => boolean
  /** Escape layer when a side panel is focused (dismiss it) and the final fallback. */
  onEscapeFallback?: () => void

  onUndo?: () => void
  onRedo?: () => void
}

export interface UseCodeChordShortcutsResult {
  /** The pending chord prefix digit (2-9), or null. Drives the chord indicator UI. */
  chordPrefix: number | null
  /** The category id the pending prefix targets, or null (for an optional named indicator). */
  pendingCategoryId: number | null
  /** Imperatively clear any pending chord (e.g. on external state changes). */
  clearChord: () => void
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

export function useCodeChordShortcuts<T extends ShortcutCodeInput>(
  options: UseCodeChordShortcutsOptions<T>
): UseCodeChordShortcutsResult {
  // Always-current snapshot of the volatile inputs (callbacks, counts, flags, codes).
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Chord-map structures derived from `codes` via the SHARED helper (plan §3a).
  // Recomputed only when the code list identity changes; mirrored into a ref so the
  // mount-only listener always reads the latest without being rebound.
  const structs = useMemo(() => {
    const categories = buildShortcutCategories(options.codes)
    const digitToCodes = new Map<number, Map<number, T>>()
    const digitToCategoryId = new Map<number, number>()
    categories.forEach((cat, i) => {
      const prefixDigit = i + 2 // chord prefixes occupy digits 2-9
      digitToCategoryId.set(prefixDigit, cat.categoryId)
      const inner = new Map<number, T>()
      cat.codes.forEach((code, j) => inner.set(j + 1, code)) // code digits 1-9
      digitToCodes.set(prefixDigit, inner)
    })
    const byNumericId = new Map<number, T>()
    for (const code of options.codes) {
      if (code.numeric_id != null) byNumericId.set(code.numeric_id, code)
    }
    return { digitToCodes, digitToCategoryId, byNumericId, hasCategories: categories.length > 0 }
  }, [options.codes])
  const structsRef = useRef(structs)
  structsRef.current = structs

  // Pending chord: state mirror drives re-render (indicator); ref is read inside the listener.
  const [chordPrefix, setChordPrefixState] = useState<number | null>(null)
  const chordPrefixRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearChord = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    chordPrefixRef.current = null
    setChordPrefixState(null)
  }, [])

  const armChord = useCallback((digit: number) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    chordPrefixRef.current = digit
    setChordPrefixState(digit)
    timerRef.current = setTimeout(() => {
      // Timeout NEVER applies a code — it only clears the pending prefix (canon decision 1).
      timerRef.current = null
      chordPrefixRef.current = null
      setChordPrefixState(null)
    }, CHORD_TIMEOUT_MS)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Modifier-only keydowns must not cancel a chord or do anything.
      if (MODIFIER_KEYS.has(e.key)) return

      const o = optionsRef.current
      const s = structsRef.current

      if (o.enabled === false) return

      // Input guard: never steal keystrokes from a text field / contenteditable.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        // Carve-out (plan H-E): Escape still dismisses a focused side panel even while
        // typing in that panel's own field (matches CodingWorkbench's prior behavior).
        if (e.key === 'Escape' && !o.arrowNavEnabled) o.onEscapeFallback?.()
        return
      }
      // While inline-editing, bail entirely so the editor's own handler owns the keys
      // (this is also the Escape "edit" layer — plan G-B).
      if (o.isEditing) return

      const isPlainDigit =
        e.key.length === 1 && e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey

      // ── Escape: layered unwind, one layer per press, focus-aware (plan H-D) ──
      // Side-panel-focused and list-focused are mutually exclusive, so this is
      // unambiguous: chord → (panel focused ⇒ dismiss it) → (list focused ⇒ clear selection).
      if (e.key === 'Escape') {
        if (chordPrefixRef.current !== null) { clearChord(); return }            // layer 1: chord
        if (o.onEscapeOverlay?.()) return                                        // layer 2: media overlay (theater/PiP)
        if (!o.arrowNavEnabled) { o.onEscapeFallback?.(); return }               // side panel → dismiss
        if (o.selectionCount > 0) { o.clearSelection?.(); return }               // list → clear selection
        return
      }

      // Any non-digit key cancels a pending chord, then passes through to its action.
      if (chordPrefixRef.current !== null && !isPlainDigit) clearChord()

      // ── Undo / redo ──
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault(); o.onUndo?.(); return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault(); o.onRedo?.(); return
      }

      // ── Arrow navigation ──
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Only claim the key (preventDefault) when the list actually owns nav — else
        // leave it for the focused panel's own roving nav / native scroll (plan G-E).
        if (o.arrowNavEnabled) {
          e.preventDefault()
          o.onArrowNav?.(e.key === 'ArrowDown' ? 1 : -1, {
            extend: e.shiftKey,
            jump: e.ctrlKey || e.metaKey,
          })
        }
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const handled = o.onArrowHorizontal?.(e.key === 'ArrowLeft' ? 'left' : 'right')
        if (handled) e.preventDefault()
        return
      }

      // ── Verbs that work with no selection ──
      if (e.key === 'j') { e.preventDefault(); o.onJumpUncoded?.(); return }
      if (e.key === 'F2') { e.preventDefault(); o.onEditOrRename?.(); return } // no selection gate (G-H)

      // ── Workbench-specific keys (plan H-B; before the selection gate) ──
      // Ungated: the handler self-gates and returns true if it acted (→ preventDefault + stop);
      // a false return lets the key fall through to the rest of the handler.
      if (o.extraKeys && e.key in o.extraKeys) {
        if (o.extraKeys[e.key]()) { e.preventDefault(); return }
      }

      // ── Everything below requires a selection ──
      if (o.selectionCount === 0) return

      if (e.key === 's') { e.preventDefault(); o.onToggleQuote?.(); return }
      if (e.key === 'c') { e.preventDefault(); o.onCreateCode?.(); return }
      if (e.key === 'n') { e.preventDefault(); o.onCreateNote?.(); return }

      // ── Numeric / chord code application ──
      if (isPlainDigit) {
        const digit = e.key.charCodeAt(0) - 48
        e.preventDefault()

        if (!s.hasCategories) {
          const code = s.byNumericId.get(digit)
          if (code) o.onToggleCode(code)
          return
        }

        if (chordPrefixRef.current === null) {
          if (digit === 0 || digit === 1) {
            // Universal row (0/1) resolves by numeric_id, not the chord space.
            const code = s.byNumericId.get(digit)
            if (code) o.onToggleCode(code)
          } else if (s.digitToCodes.has(digit)) {
            armChord(digit)
          }
          // digit 2-9 with no matching category → no-op
        } else {
          const prefix = chordPrefixRef.current
          clearChord()
          const code = s.digitToCodes.get(prefix)?.get(digit)
          if (code) o.onToggleCode(code)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [clearChord, armChord]) // both stable → listener binds once

  // Clear any pending timer on unmount.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const pendingCategoryId = chordPrefix !== null ? structs.digitToCategoryId.get(chordPrefix) ?? null : null

  return { chordPrefix, pendingCategoryId, clearChord }
}
