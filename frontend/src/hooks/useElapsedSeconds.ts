import { useEffect, useRef, useState } from 'react'

/**
 * Elapsed seconds while `active`, for a progress fill paced by an estimate (#796b).
 *
 * The developer's report: *"I wonder if a time estimate is enough. I'm more
 * familiar with a progress bar that fills as a signal that some processing is
 * happening."* They are right — a static "~100 seconds" plus a frozen button is
 * indistinguishable from a hang, which is exactly how the timeout presented.
 *
 * ⚠️ **What this deliberately does NOT do is claim a percentage it cannot
 * know.** The server reports no progress (one request, one response), so any
 * "62%" would be elapsed-over-estimate wearing a measurement's clothes. The fill
 * (`lib/elapsed-progress.ts::fillFraction`) is paced by the estimate but capped
 * below full and never claims completion; the text beside it says ELAPSED, which
 * is a fact, and admits when the estimate is exceeded.
 *
 * Moved out of `DatasetImport.tsx` when the merge page became its second user
 * (#1015).
 */
export function useElapsedSeconds(active: boolean): number {
  // Stores the last TICK timestamp, not a counter. Timestamp-based, never
  // accumulated: background tabs throttle intervals to ~1/s and an accumulating
  // counter drifts (the #564 clock rule).
  const [tickAt, setTickAt] = useState(0)
  const startedAtRef = useRef(0)
  useEffect(() => {
    if (!active) return
    // A ref write, deliberately — resetting STATE here would be a synchronous
    // setState inside an effect (the react-hooks/immutability warning), and the
    // stale-tick guard below makes the reset unnecessary anyway.
    startedAtRef.current = Date.now()
    const id = setInterval(() => setTickAt(Date.now()), 500)
    return () => clearInterval(id)
  }, [active])
  if (!active || startedAtRef.current === 0) return 0
  // A tick left over from a PREVIOUS run is older than this run's start, so it
  // reads as 0 rather than flashing the last run's elapsed time.
  return Math.max(0, tickAt - startedAtRef.current) / 1000
}
