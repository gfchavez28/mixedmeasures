import { useEffect, useRef } from 'react'

/**
 * Where keyboard focus goes when a wizard's step changes — the ONE rule for all
 * seven import wizards (#1011, 2026-09-23).
 *
 * Attach the returned ref to the step's heading (`tabIndex={-1}`). Focus moves to
 * it whenever the step CHANGES to a non-transient step, and never when the page
 * first opens.
 *
 * Why it exists: each wizard advances by unmounting the button that was pressed,
 * so focus fell to `<body>` and a keyboard or reader user was returned to the top
 * of the page. #935 fixed Merge and #1005 fixed Coding Import, one wizard at a
 * time, and four others stayed broken; two of the fixed ones also took focus on
 * ARRIVAL, skipping the *Skip to main content* link. One hook, one behaviour.
 *
 * ⚠️ **Keyed on the step CHANGING, never on "is this the first run"** — StrictMode
 * runs a mount effect twice and a ref survives between the runs, so a first-run
 * flag takes focus on arrival (#1005's live-driven trap).
 *
 * ⚠️ **`transient` steps are spinners, not steps** (Merge's `loading`/`merging`):
 * focus never lands on one. And a page that OPENS on a transient step has not
 * arrived until it leaves it — Merge starts on `loading`, so its first real step
 * is the arrival and takes no focus.
 */
export function useStepFocus<S extends string>(step: S, transient: readonly S[] = []) {
  const ref = useRef<HTMLHeadingElement>(null)
  const previous = useRef<S>(step)
  const arrived = useRef(!transient.includes(step))

  useEffect(() => {
    if (previous.current === step) return
    previous.current = step
    if (transient.includes(step)) return
    if (!arrived.current) {
      arrived.current = true
      return
    }
    ref.current?.focus()
    // `transient` is a constant list per page; keying on it would re-run the
    // effect on every render for callers that pass an inline array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  return ref
}
