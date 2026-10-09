import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface TextPagingStatusProps {
  /** Rows currently loaded — the prefix, not the selection. */
  loaded: number
  /** Rows the current filters select in total. */
  total: number
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
  /**
   * What a row IS here, singular and plural (#969). Text Coding lists
   * `responses`; the Content tab's sections list passages, document segments
   * and clips — one component, so the four lines cannot drift apart.
   */
  noun?: { one: string; many: string }
  /**
   * The last *Load more* FAILED (`isFetchNextPageError`). A failed next page
   * keeps the pages already in hand, so the list reads `ready` and nothing said
   * it — the button simply re-enabled (#968's review). Said in the live count;
   * pressing the button again is the retry.
   */
  loadFailed?: boolean
  /**
   * The rows on screen belong to the PREVIOUS filter while the new one loads
   * (`isPlaceholderData`, #1038 i). The counts would be the old selection's, so
   * none is stated, and there is nothing to load more OF yet.
   */
  updating?: boolean
}

const RESPONSES = { one: 'response', many: 'responses' }

/**
 * #844 — says how much of the selection is on screen.
 *
 * ## Why this is part of the fix rather than decoration
 *
 * Paging the texts endpoint bounded a 37.8 MB payload, but it also made the
 * list SILENTLY PARTIAL. A researcher scrolling to the bottom of a coding
 * workspace and finding no more rows will reasonably conclude they have coded
 * everything — and in a tool whose whole claim is honest counts, a list that
 * ends early without saying so is a research-integrity defect, not a UI one.
 * The same reasoning is why `total_texts` rides every page of the response.
 *
 * ⚠️ **`loaded` is `comments.length` and `total` is `total_texts`; they are
 * different facts and must not be collapsed** — that collapse IS the #800 bug
 * this endpoint was paginated to avoid repeating.
 *
 * ⚠️ The counter is a polite live region: loading is user-initiated (a scroll
 * to the end, or the button), so the announcement answers an action the
 * researcher just took rather than interrupting them.
 *
 * 🔴 **The button is `aria-disabled` + a click guard while it runs, never
 * `disabled` (#968's review, #965's class).** Chrome blurs a focused button that
 * becomes disabled, so a keyboard press dropped focus to `<body>` mid-request.
 * And when the LAST page lands the button unmounts — focus would fall to
 * `<body>` again — so it moves to the count, which says what just happened.
 */
export default function TextPagingStatus({
  loaded, total, hasMore, isLoadingMore, onLoadMore,
  noun = RESPONSES, loadFailed = false, updating = false,
}: TextPagingStatusProps) {
  const labelRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Did the researcher press the button from the keyboard-or-pointer focus it
  // still holds? Only then is there focus to rescue when it unmounts.
  const pressedWithFocus = useRef(false)

  useEffect(() => {
    if (!hasMore && pressedWithFocus.current) {
      pressedWithFocus.current = false
      labelRef.current?.focus()
    }
  }, [hasMore])

  if (updating) {
    return (
      <div className="flex items-center justify-center gap-3 border-t border-mm-border-subtle px-4 py-2">
        <span className="text-xs text-mm-text-secondary" aria-live="polite">
          Updating for the new filter…
        </span>
      </div>
    )
  }
  if (total === 0) return null

  const word = (n: number) => (n === 1 ? noun.one : noun.many)
  const label = hasMore
    ? `Showing ${loaded.toLocaleString()} of ${total.toLocaleString()} ${noun.many}`
    : `All ${total.toLocaleString()} ${word(total)} loaded`

  return (
    <div className="flex items-center justify-center gap-3 border-t border-mm-border-subtle px-4 py-2">
      <span
        ref={labelRef}
        tabIndex={-1}
        className="text-xs text-mm-text-secondary tabular-nums outline-none"
        aria-live="polite"
        // The count changes as pages arrive; the live region is what makes
        // that reach a reader who is not watching the scrollbar.
      >
        {label}
        {loadFailed && !isLoadingMore && ` — the next ${noun.many} could not be loaded. Press Load more to try again.`}
      </span>
      {hasMore && (
        <Button
          ref={buttonRef}
          variant="outline"
          size="sm"
          onClick={() => {
            if (isLoadingMore) return
            pressedWithFocus.current = document.activeElement === buttonRef.current
            onLoadMore()
          }}
          aria-disabled={isLoadingMore || undefined}
          aria-busy={isLoadingMore || undefined}
          className={isLoadingMore ? 'opacity-60 cursor-progress' : undefined}
          // Named with the remainder rather than a bare "Load more", so the
          // control states the size of what is still unread. ⚠️ The name never
          // carries the state (#770) — a failure is said in the live count
          // beside it, and pressing again IS the retry.
          aria-label={`Load more ${noun.many} — ${(total - loaded).toLocaleString()} remaining`}
        >
          {isLoadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />}
          {isLoadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
