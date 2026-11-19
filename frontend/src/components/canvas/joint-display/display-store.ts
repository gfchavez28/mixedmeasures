/**
 * What a joint display's node view must not lose when ProseMirror RE-CREATES it.
 *
 * 🔴 **The node view is re-created whenever a modal dialog opens anywhere on the Canvas** (driven
 * 2026-11-12e). Radix's dialog hides everything outside itself with `aria-hidden`, and the
 * `aria-hidden` package keeps every `[aria-live]` element VISIBLE — so it walks down to each live
 * region (the chart embeds carry several inside the editor) and sets `aria-hidden` on the
 * siblings along the way, which are ProseMirror's own paragraphs. ProseMirror reads those
 * attribute changes as DOM edits, redraws the range, and every node view in it is built anew:
 * a dialog the view owned unmounted in the same commit it mounted, and any local state went.
 * Neither library offers a switch, so the display is made indifferent to the re-creation:
 *
 * - its dialogs live OUTSIDE the node view (`DisplayDialogHost`, mounted by the Canvas page),
 *   and write back through `commitDisplay(displayKey, update)` to whichever view is live now —
 *   never through a captured `updateAttributes`, whose `getPos` belongs to a destroyed view;
 * - the rows a researcher has open, and an unsaved meta-inference draft, live HERE, keyed by the
 *   display's `displayKey` (D176's own key for per-person view state), for the page's lifetime.
 *
 * In memory only, on purpose: a draft is not saved until *Save meta-inference* stamps the row's
 * numbers (D168.5), and a reload is the researcher leaving the page.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { DisplayCoderScope, JointDisplay } from '@/lib/joint-display'

// ── The dialogs a node view asks the page to host (`DisplayDialogHost`) ──────────────

export type DisplayDialogRequest =
  | { kind: 'edit'; displayKey: string; display: JointDisplay }
  | {
      kind: 'pin'
      displayKey: string
      display: JointDisplay
      rowKey: string
      construct: string
      group: string
      /** Joint display slice 2 (r2-5): each code with the strand it is offered from. */
      codes: { id: number; name: string; strandKey?: string }[]
      /** Null = no scope (blind, no viewer — D361): no request is built. */
      scope: DisplayCoderScope | null
      pinnedExcerptIds: number[]
    }
  /** Joint display slice 2, round 2 (r5-2): a row's case view and its "cases that don't fit". */
  | {
      kind: 'cases'
      displayKey: string
      display: JointDisplay
      rowKey: string
      /** The compute's own scope (D175; null = none, D361), and D96's no-viewer case. */
      scope: DisplayCoderScope | null
      noViewer: boolean
    }

export const DialogsContext = createContext<((request: DisplayDialogRequest) => void) | null>(null)

/** How a joint display's node view opens a dialog — null where none can be hosted. */
export function useDisplayDialogs(): ((request: DisplayDialogRequest) => void) | null {
  return useContext(DialogsContext)
}

type Listener = () => void

const values = new Map<string, unknown>()
const listeners = new Map<string, Set<Listener>>()

function emit(key: string) {
  for (const l of listeners.get(key) ?? []) l()
}

function subscribe(key: string, l: Listener): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(l)
  return () => { set!.delete(l) }
}

/** A value kept for the page's lifetime under `key`, shared by every mount that asks for it. */
export function useKeptState<T>(key: string, initial: () => T): [T, (next: T | ((prev: T) => T)) => void] {
  const get = useCallback(() => {
    if (!values.has(key)) values.set(key, initial())
    return values.get(key) as T
    // `initial` is a seed read once per key — a new closure must not re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const value = useSyncExternalStore(useCallback(l => subscribe(key, l), [key]), get, get)
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const prev = (values.has(key) ? values.get(key) : initial()) as T
    values.set(key, typeof next === 'function' ? (next as (p: T) => T)(prev) : next)
    emit(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return [value, set]
}

/** Forget what was kept for a key (a draft once saved). */
export function forgetKept(key: string) {
  values.delete(key)
  emit(key)
}

// ── Writing back to the LIVE node view ───────────────────────────────────────────────

type DisplayUpdate = (current: JointDisplay) => JointDisplay
const appliers = new Map<string, (update: DisplayUpdate) => void>()

/**
 * The live editable view of `displayKey` registers how to apply an update to its node. The LAST
 * registration wins and an unregister removes only its own, so a re-created view takes over
 * from the one it replaces whatever order React runs their effects in.
 */
export function registerDisplayApplier(displayKey: string, apply: (update: DisplayUpdate) => void): () => void {
  appliers.set(displayKey, apply)
  return () => { if (appliers.get(displayKey) === apply) appliers.delete(displayKey) }
}

/** Apply `update` to the display as it is NOW. False when no editable view holds it. */
export function commitDisplay(displayKey: string, update: DisplayUpdate): boolean {
  const apply = appliers.get(displayKey)
  if (!apply) return false
  apply(update)
  return true
}
