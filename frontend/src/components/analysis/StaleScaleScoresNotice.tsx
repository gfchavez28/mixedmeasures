import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { OUT_OF_DATE_DOT_COLOR } from '@/components/OutOfDateDot'
import { useMainContentLanding } from '@/hooks/useMainContentLanding'
import { useRecomputeScaleScores } from '@/hooks/useRecomputeScaleScores'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import { staleScaleScoresSentence } from '@/lib/stale-scale-scores'

interface StaleScaleScoresNoticeProps {
  pid: number
  /** The ACTIVE view's `stale_domain_ids`, as the server sent them. */
  staleDomainIds: readonly number[]
  /** The page's variable-group list, for names. */
  domains: readonly { id: number; name: string }[] | undefined
}

/**
 * #1168 R7 — a Relationships & Comparisons result built from scale scores that
 * predate a change to their members' cells.
 *
 * The comparison and correlation endpoints READ the stored per-record scores
 * and never recompute inside a GET (DEC-C), so after an edit they served the
 * old numbers and said nothing. The server now names the groups; this says so
 * above the result and offers the recompute (`useRecomputeScaleScores`, shared
 * with `ComparisonUnavailable`).
 *
 * Absent when nothing is out of date — absence is no claim here, because the
 * caller renders this only beside a result the server has answered.
 */
export default function StaleScaleScoresNotice(props: StaleScaleScoresNoticeProps) {
  if (props.staleDomainIds.length === 0) return null
  return <NoticeBody {...props} />
}

/**
 * Its own component so a successful recompute UNMOUNTS it (the refetched result
 * says nothing is stale) and the cleanup below runs. That unmount takes the
 * focused button with it (#955 b), so focus lands on the layout's main content
 * — the app's one answer for a control that disappears (`useMainContentLanding`)
 * — but only after a press, and only when focus was actually lost.
 */
function NoticeBody({ pid, staleDomainIds, domains }: StaleScaleScoresNoticeProps) {
  const recompute = useRecomputeScaleScores(pid)
  const landing = useMainContentLanding()
  const pressedRef = useRef(false)

  useEffect(() => () => {
    if (!pressedRef.current) return
    const active = document.activeElement
    if (active == null || active === document.body || !active.isConnected) landing.current?.focus()
  }, [landing])

  const busy = recompute.isPending
  return (
    <div className="my-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs">
      {/* Decorative: the sentence says "Out of date" in words, and an
          `OutOfDateDot`'s name beside it would be read twice. */}
      <span aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${OUT_OF_DATE_DOT_COLOR}`} />
      <span className="min-w-0 flex-1">{staleScaleScoresSentence(staleDomainIds, domains)}</span>
      {/* Busy is `aria-disabled` + a guard, never `disabled`: Chrome blurs a
          focused button that becomes disabled (#959). */}
      <Button
        size="sm"
        variant="outline"
        className={`h-7 text-xs ${MODE_DISABLED_CLASS}`}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return
          pressedRef.current = true
          recompute.mutate(staleDomainIds)
        }}
      >
        {busy ? 'Recomputing…' : 'Recompute scale scores'}
      </Button>
    </div>
  )
}
