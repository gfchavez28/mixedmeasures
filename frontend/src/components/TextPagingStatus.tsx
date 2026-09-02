import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface TextPagingStatusProps {
  /** Texts currently loaded — the prefix, not the selection. */
  loaded: number
  /** Texts the current filters select in total. */
  total: number
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
}

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
 */
export default function TextPagingStatus({
  loaded, total, hasMore, isLoadingMore, onLoadMore,
}: TextPagingStatusProps) {
  if (total === 0) return null

  const label = hasMore
    ? `Showing ${loaded.toLocaleString()} of ${total.toLocaleString()} responses`
    : `All ${total.toLocaleString()} response${total === 1 ? '' : 's'} loaded`

  return (
    <div className="flex items-center justify-center gap-3 border-t border-mm-border-subtle px-4 py-2">
      <span
        className="text-xs text-mm-text-secondary tabular-nums"
        aria-live="polite"
        // The count changes as pages arrive; the live region is what makes
        // that reach a reader who is not watching the scrollbar.
      >
        {label}
      </span>
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          onClick={onLoadMore}
          disabled={isLoadingMore}
          // Named with the remainder rather than a bare "Load more", so the
          // control states the size of what is still unread.
          aria-label={`Load more responses — ${(total - loaded).toLocaleString()} remaining`}
        >
          {isLoadingMore && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />}
          {isLoadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}
