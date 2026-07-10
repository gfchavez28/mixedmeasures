import { useCallback, useState } from 'react'

/**
 * Collapsible right-panel COLUMN state (#39, conversation half — V1 slab 4).
 *
 * Collapsing the Codes/Notes/Memos column returns its width to the
 * transcript/video area, leaving a slim icon rail. Distinct from the
 * per-panel CollapsiblePanel state: this folds the whole column.
 *
 * Persisted per workbench kind (localStorage), so the preference survives
 * navigation. The document/text workbench ports (#39's other half) reuse
 * this hook with their own keys.
 *
 * Consumers MUST route "bring a panel into view" flows through `expand()`
 * (focusCode / focusCodeForApply / memo-note creation) — a collapsed column
 * silently swallowing those actions is the failure mode this hook exists
 * to prevent.
 */
export function useCollapsibleColumn(workbenchKey: string) {
  const storageKey = `mm-right-column-collapsed-${workbenchKey}`
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  })

  const setCollapsed = useCallback(
    (value: boolean) => {
      setCollapsedState(value)
      try {
        localStorage.setItem(storageKey, value ? '1' : '0')
      } catch {
        // Private-mode / quota failures degrade to session-only state.
      }
    },
    [storageKey],
  )

  const collapse = useCallback(() => setCollapsed(true), [setCollapsed])
  const expand = useCallback(() => setCollapsed(false), [setCollapsed])
  const toggle = useCallback(
    () => setCollapsedState(prev => {
      try {
        localStorage.setItem(storageKey, prev ? '0' : '1')
      } catch {
        // session-only
      }
      return !prev
    }),
    [storageKey],
  )

  return { collapsed, collapse, expand, toggle }
}
