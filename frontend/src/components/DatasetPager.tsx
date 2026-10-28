import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { offsetForRecordNumber } from '@/lib/dataset-record-focus'

interface DatasetPagerProps {
  /** The offset ASKED for — `DatasetView`'s state, which a press changes at once. */
  pageOffset: number
  /**
   * The offset of the page ON SCREEN (the fetched payload's, #800). It lags
   * `pageOffset` while a page loads, because the query keeps the previous page
   * as placeholder data.
   */
  shownOffset: number
  pageStart: number
  pageEnd: number
  totalRows: number
  pageSize: number
  isFetching: boolean
  onPageOffsetChange: (offset: number) => void
}

type PagerButton = 'previous' | 'next'

/**
 * #800/#835 — the Data grid's pager. Moved out of `DatasetView` for #1407 so its
 * focus behaviour has a render test: jsdom cannot mount that page.
 *
 * 🔴 **Busy is `aria-disabled` + each handler's own guard, never `disabled`
 * (#1407, the internal design notes).** Chrome blurs a focused button
 * that becomes `disabled`, so a keyboard press on *Previous*, *Next* or *Go* put
 * focus on `<body>` while the page loaded. Native `disabled` stays for the
 * PRECONDITIONS — first page, last page, nothing typed — #754's transient arm.
 *
 * 🔴 **A press that makes its OWN button unusable moves focus (#1407 D1).**
 * Reaching the first page disables *Previous*, reaching the last disables
 * *Next*, and an accepted jump clears the field and so disables *Go* (measured:
 * a keyboard press on *Go* left focus on `<body>`). Each lands on the control
 * that can act next — the OTHER pager button, or the record-number field. The
 * live *"Records 401–450 of 450"* line already says where the reader is.
 * ⚠️ Only after a press made WITH focus, and only while focus is still on that
 * button or lost: never on arrival, never after a jump to the first or last page,
 * never stealing from a control the researcher moved to (`TextPagingStatus`'s
 * precedent).
 */
export default function DatasetPager({
  pageOffset, shownOffset, pageStart, pageEnd, totalRows, pageSize, isFetching,
  onPageOffsetChange,
}: DatasetPagerProps) {
  const [jumpValue, setJumpValue] = useState('')
  const jumpInputRef = useRef<HTMLInputElement>(null)
  const goRef = useRef<HTMLButtonElement>(null)
  const previousRef = useRef<HTMLButtonElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  // The button pressed while it held focus, until the page it asked for is decided.
  const pressedRef = useRef<PagerButton | null>(null)
  const atFirstPage = pageOffset === 0
  const atLastPage = pageEnd >= totalRows

  useEffect(() => {
    const pressed = pressedRef.current
    if (pressed == null) return
    // Next's edge is read from the page ON SCREEN (`pageEnd`), so wait for the
    // page it asked for; Previous's is the asked-for offset, known at once.
    if (pressed === 'next' && shownOffset !== pageOffset) return
    pressedRef.current = null
    if (!(pressed === 'previous' ? atFirstPage : atLastPage)) return
    const [from, to] = pressed === 'previous'
      ? [previousRef.current, nextRef.current]
      : [nextRef.current, previousRef.current]
    const active = document.activeElement
    if (active && active !== from && active !== document.body) return
    to?.focus()
  }, [pageOffset, shownOffset, atFirstPage, atLastPage])

  const press = (button: PagerButton, target: number) => {
    if (isFetching || target === pageOffset) return
    const element = button === 'previous' ? previousRef.current : nextRef.current
    pressedRef.current = document.activeElement === element ? button : null
    onPageOffsetChange(target)
  }

  return (
    <nav
      className="flex items-center justify-between gap-3 mt-2 flex-shrink-0"
      aria-label="Record pages"
    >
      <p className="text-xs text-mm-text-muted" role="status" aria-live="polite">
        Records <strong className="font-mono tabular-nums">{pageStart.toLocaleString()}</strong>
        {'–'}
        <strong className="font-mono tabular-nums">{pageEnd.toLocaleString()}</strong>
        {' of '}
        <strong className="font-mono tabular-nums">{totalRows.toLocaleString()}</strong>
      </p>
      <div className="flex items-center gap-2">
        {/* #835: reaching record 10,000 was 50 clicks of Next.
          *
          * A `<form>` so Enter submits natively — the control is
          * useless if it needs a mouse to reach a button. The label is
          * `sr-only` rather than `hidden`, because `hidden` removes it
          * from the accessibility tree and leaves the input nameless
          * (#717/#718); the placeholder is NOT a name.
          *
          * ⚠️ No server round trip: a record NUMBER is an ordinal and
          * its page is division (`offsetForRecordNumber`). Only the
          * search deep link needs the resolver, because it knows a
          * primary key instead. */}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (isFetching) return
            const target = offsetForRecordNumber(Number(jumpValue), pageSize, totalRows)
            if (target == null) {
              toast.error(`Enter a record number between 1 and ${totalRows.toLocaleString()}.`)
              return
            }
            // Clearing the field disables Go, so a press ON Go would drop focus
            // to <body> (#1407): back to the field, where the next number goes.
            if (document.activeElement === goRef.current) jumpInputRef.current?.focus()
            pressedRef.current = null
            onPageOffsetChange(target)
            setJumpValue('')
          }}
        >
          <label htmlFor="dataset-jump-record" className="sr-only">
            Go to record number
          </label>
          <input
            ref={jumpInputRef}
            id="dataset-jump-record"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={jumpValue}
            onChange={(e) => setJumpValue(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="Go to #"
            className="w-[88px] h-8 text-xs px-2 rounded-md border border-border bg-mm-surface focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            ref={goRef}
            type="submit"
            variant="outline"
            size="sm"
            disabled={jumpValue === ''}
            aria-disabled={isFetching || undefined}
            aria-busy={isFetching || undefined}
            className="aria-busy:cursor-wait aria-busy:opacity-50"
          >
            Go
          </Button>
        </form>
        <Button
          ref={previousRef}
          variant="outline"
          size="sm"
          onClick={() => press('previous', Math.max(0, pageOffset - pageSize))}
          disabled={atFirstPage}
          aria-disabled={isFetching || undefined}
          aria-busy={isFetching || undefined}
          className="aria-busy:cursor-wait aria-busy:opacity-50"
        >
          Previous
        </Button>
        <Button
          ref={nextRef}
          variant="outline"
          size="sm"
          onClick={() => press('next', pageOffset + pageSize < totalRows ? pageOffset + pageSize : pageOffset)}
          disabled={atLastPage}
          aria-disabled={isFetching || undefined}
          aria-busy={isFetching || undefined}
          className="aria-busy:cursor-wait aria-busy:opacity-50"
        >
          Next
        </Button>
      </div>
    </nav>
  )
}
