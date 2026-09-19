import { useEffect, useRef, useState, type Ref, type RefObject } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { loadFailureReason, type ListLoad } from '@/lib/list-status'

/**
 * #961 — the two things a surface says about a list it cannot show yet: that it
 * is LOADING, or that the load FAILED. Never that the list is empty; that claim
 * belongs to a `ready` list (`lib/list-status.ts`).
 *
 * Extracted from `IrrMatrix`'s private loading line (#957), which is the first
 * surface that had to say "this is taking a while" out loud, so the slow-load
 * hint has one wording and one delay.
 */

/** How long a loading line waits before saying the wait is expected (#957). */
export const SLOW_HINT_MS = 10_000

export type LoadStatusSize = 'page' | 'panel'

// ⚠️ The `page` padding collapses on a SHORT viewport. Measured at 640×360 (a
// 1280×720 window at 200% zoom) the Codebook page leaves 87 px for content, and
// `py-16` alone put the failure notice's Retry button below it. Height, not
// width, is what runs out, so this keys on `max-height`, not a width breakpoint.
const PAGE_PADDING = 'py-16 [@media(max-height:480px)]:py-3'

const LOADING_CLASS: Record<LoadStatusSize, string> = {
  page: `flex flex-col items-center gap-1 ${PAGE_PADDING} text-center text-mm-text-muted outline-none`,
  panel: 'flex flex-col items-center gap-0.5 px-3 py-4 text-center text-xs text-mm-text-muted outline-none',
}

const FAILED_CLASS: Record<LoadStatusSize, string> = {
  page: `flex flex-col items-center gap-3 ${PAGE_PADDING} text-center`,
  panel: 'flex flex-col items-center gap-2 px-3 py-4 text-center text-xs',
}

/**
 * A loading line that says, after `SLOW_HINT_MS`, that a long wait is normal —
 * a bare spinner for 19 s reads as a hang. Its own component so the timer
 * resets by UNMOUNTING, never by a state reset inside an effect.
 *
 * ⚠️ `role="status"`: the hint is a CHANGE to a live region and so is the part
 * a reader can be expected to hear. Whether the first line is announced when
 * the region mounts is reader-dependent and unverified (no screen-reader
 * passes). `tabIndex={-1}` makes it a legal focus landing for a caller that
 * needs one (`IrrMatrix` moves focus here after Retry).
 */
export function LoadingNotice({
  label,
  size = 'page',
  ref,
}: {
  label: string
  size?: LoadStatusSize
  ref?: Ref<HTMLDivElement>
}) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_HINT_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div ref={ref} tabIndex={-1} role="status" className={LOADING_CLASS[size]}>
      <span className="flex items-center gap-2">
        <Loader2 className={size === 'page' ? 'w-4 h-4 animate-spin' : 'w-3 h-3 animate-spin'} aria-hidden="true" />
        {label}
      </span>
      {slow && (
        <span className={size === 'page' ? 'text-xs' : 'text-[11px]'}>
          On a large project this can take a minute or more.
        </span>
      )}
    </div>
  )
}

/**
 * "This could not be loaded" — a statement about a request, with a Retry.
 *
 * ⚠️ **Retry is offered for a TIMEOUT too, unlike `IrrMatrix`.** There the
 * request is a computation whose duration is intrinsic (#820: a retry gets the
 * same budget and stops in the same place). The lists this serves answer in
 * well under the budget unless the server is busy, and a Retry is the only way
 * back that does not reload the page.
 *
 * ⚠️ **The button stays MOUNTED and FOCUSABLE while the retry runs** —
 * `aria-disabled`, never `disabled`, because Chrome blurs a focused element that
 * becomes disabled, and the click guard is the load-bearing half (#754). The
 * caller keeps this notice on screen through the retry by reading
 * `load.retrying` (`LoadState` does).
 *
 * ⚠️ **When the retry SUCCEEDS the notice unmounts and takes the focused button
 * with it** (#955 b: a focused control that unmounts needs a destination). Pass
 * `landingRef` — a container that stays mounted and carries `tabIndex={-1}` —
 * and focus moves there, but only after a Retry press, and only when focus was
 * actually lost, so a researcher who has moved elsewhere keeps their place.
 */
export function LoadFailedNotice({
  title,
  load,
  size = 'page',
  landingRef,
}: {
  title: string
  load: Pick<ListLoad, 'error' | 'retry' | 'retrying'>
  size?: LoadStatusSize
  landingRef?: RefObject<HTMLElement | null>
}) {
  const pressedRef = useRef(false)
  const landing = landingRef

  useEffect(() => () => {
    if (!pressedRef.current) return
    const active = document.activeElement
    const lost = active == null || active === document.body || !active.isConnected
    if (lost) landing?.current?.focus()
  }, [landing])

  return (
    <div className={FAILED_CLASS[size]}>
      <div role="alert" className="flex flex-col gap-1 max-w-prose">
        <p className={size === 'page' ? 'text-mm-text' : 'text-mm-text font-medium'}>{title}</p>
        <p className={size === 'page' ? 'text-sm text-mm-text-muted' : 'text-mm-text-muted'}>
          {loadFailureReason(load.error)} Nothing in your project has changed.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className={size === 'panel' ? 'h-7 text-xs' : undefined}
        aria-disabled={load.retrying || undefined}
        onClick={() => {
          if (load.retrying) return
          pressedRef.current = true
          load.retry()
        }}
      >
        {load.retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}

/**
 * The non-ready half of a list surface: `status === 'ready'` renders the list
 * (or its honest empty state), anything else renders this.
 *
 * A failure notice stays up while `retrying` even though the query has gone
 * back to `pending` underneath — the same element type in the same place, so
 * React keeps the instance and the focused Retry button with it.
 */
export function LoadState({
  load,
  loadingLabel,
  failedTitle,
  size = 'page',
  landingRef,
}: {
  load: ListLoad
  loadingLabel: string
  failedTitle: string
  size?: LoadStatusSize
  landingRef?: RefObject<HTMLElement | null>
}) {
  if (load.status === 'failed' || load.retrying) {
    return <LoadFailedNotice title={failedTitle} load={load} size={size} landingRef={landingRef} />
  }
  return <LoadingNotice label={loadingLabel} size={size} />
}
