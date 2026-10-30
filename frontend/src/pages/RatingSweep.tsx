import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Gauge, SkipForward } from 'lucide-react'
import { toast } from 'sonner'

import MagnitudeStrip from '@/components/MagnitudeStrip'
import { Button } from '@/components/ui/button'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { codingApi } from '@/lib/api'
import { invalidateAfterRating } from '@/lib/coding-cache'
import type { RatingQueueCodeCount, RatingQueueEntry } from '@/lib/api/coding'
import { serverDetailMessage } from '@/lib/api/error-utils'
import { describeMagnitude, isUnrated } from '@/lib/magnitude'
import { commitRating, entryKey } from '@/lib/rating-commit'
import { SELECTED_CARD } from '@/lib/selection'

/**
 * The rating sweep — variant B of #35, queue row 45 (ii).
 *
 * Variant A rates at the moment of applying. This is the second pass: the same
 * `MagnitudeStrip`, on its own surface, over the applications that declare a
 * scale and carry no rating. They share ONE control and ONE instrument
 * renderer, which is why A was built standalone from day one.
 *
 * ## 🔴 One passage at a time, not a list
 *
 * A list of editable rows is the obvious shape and it is the wrong one here.
 * Ratings are only comparable when each is given against the instrument on
 * screen, so the surface shows ONE passage with its declared scale under it —
 * the same argument that puts the anchors in the strip rather than in a
 * tooltip. It also sidesteps a list's own defect: entries LEAVE the queue as
 * they are rated, so a list either reshuffles under the cursor or goes stale.
 *
 * ## 🔴 What this surface does NOT do, each for a stated reason
 *
 * - **No offset paging.** A work queue shrinks as it is worked; addressing into
 *   it by index skips the entries that shifted up. One batch is fetched, worked
 *   down, and refetched when exhausted (`services/rating_queue.py`).
 * - **No refetch after each write.** The entry is marked rated locally and the
 *   cursor advances; `invalidateAfterRating` marks the queue stale WITHOUT
 *   refetching it (#1425). ⚠️ **That does not mean nothing refetches it (#1456)**
 *   — a refocus once the answer is a minute old, a code edit in the codebook
 *   slide-out (`invalidateDerivedCounts`), *Load the next batch* and a filter
 *   change all re-read the queue, and a re-read answer has already dropped what
 *   this pass rated. So the WALK is a snapshot of the batch the coder asked for,
 *   and the counts subtract only ratings the current answer has not seen.
 * - **No `useHistory` / Ctrl+Z.** The correction affordance on a SEQUENCE is
 *   positional — *Previous* returns to the passage and shows what was recorded,
 *   so it can be changed or cleared in place. An undo stack over a queue whose
 *   entries leave as they are acted on would have to re-insert them, and the
 *   button that says "undo" would be doing something the screen does not show.
 * - **No colleague's rating anywhere** (the developer's design call,
 *   2026-09-12). The queue is own-applications-only at the server, so this
 *   surface is blind by construction rather than by a lens: there is no reveal
 *   to gate and nothing here consults `useBlindMode`. Seeing someone else's
 *   rating before giving yours destroys the independence a reliability
 *   coefficient needs — the rule already recorded for negotiated agreement.
 *
 * ⚠️ **Navigation cannot use a letter key.** The strip claims every unmodified
 * printable key it receives (#870 a), so `n`/`j`/`k` would be swallowed while
 * it has focus, and the arrows are its tick cursor. Advancing happens on commit
 * and on Esc; the pointer route is Tab-reachable buttons.
 */

/** How many entries one fetch brings back. Worked down, then refetched. */
const BATCH = 50

/** One stable empty walk, so the memos below do not recompute while loading. */
const NO_ENTRIES: RatingQueueEntry[] = []

/**
 * What this pass recorded for one entry: a rating, or `undefined` for skipped.
 *
 * ⚠️ `codeId` rides along so the counts can be decremented PER CODE without
 * parsing it back out of the entry key.
 */
type Outcome = { value: number | null; codeId: number } | undefined

export default function RatingSweep() {
  const { projectId } = useProjectLayout()
  const queryClient = useQueryClient()

  const [codeFilter, setCodeFilter] = useState<number | null>(null)
  const [cursor, setCursor] = useState(0)
  /** What this session recorded, per entry — the value, or null for skipped. */
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})

  const queryKey = ['rating-queue', projectId, codeFilter] as const
  const { data, isError, error, refetch, isFetching, isStale } = useQuery({
    queryKey,
    queryFn: () => codingApi.getRatingQueue(projectId, {
      codeId: codeFilter ?? undefined,
      limit: BATCH,
    }),
  })

  /**
   * 🔴 **#1456 — the batch being WALKED is a snapshot, taken when the coder asks
   * for one** (a filter, or *Load the next batch*), never the query's latest
   * answer. The server drops what this pass rated, so a re-read moved every
   * entry after a rated one up by one: `entries[cursor]` landed as many passages
   * further on as had been rated, and *Previous* addressed a different passage.
   * A background re-read now updates the COUNTS only.
   *
   * Taken while rendering, not in an effect: the snapshot is part of reading the
   * answer for a filter the coder chose (React's "adjust state when a prop
   * changes" pattern), and it is guarded so it runs once per filter.
   *
   * ⚠️ **Never from a STALE cached answer that is being re-read** — a rating on
   * a workbench marks this query stale (`invalidateAfterRating`), and a walk
   * taken from that cache would offer an already-rated passage for the whole
   * batch, where the old index-walk showed it only until the refetch landed.
   */
  const [walk, setWalk] = useState<{ filter: number | null; entries: RatingQueueEntry[] } | null>(null)
  const walking = walk !== null && walk.filter === codeFilter
  if (data && !walking && !(isFetching && isStale)) {
    setWalk({ filter: codeFilter, entries: data.entries })
  }
  const entries = walking ? walk.entries : NO_ENTRIES
  const current: RatingQueueEntry | undefined = entries[cursor]

  /**
   * Changing the filter restarts the walk — the old cursor addressed a
   * different list, and carrying it over lands on an unrelated passage.
   *
   * ⚠️ **Done in the HANDLER, not in an effect keyed on the filter.** The reset
   * is part of the act of changing the filter, not a synchronisation after the
   * fact; an effect that calls `setState` on a render triggered by another
   * `setState` is the cascading-render shape the React Compiler lint flags, and
   * the repo carries those warnings only where they are unavoidable.
   *
   * ⚠️ `outcomes` is deliberately NOT cleared: it is keyed per ENTRY, so what
   * the coder recorded survives a filter change and comes back correct if they
   * filter back.
   */
  /**
   * 🔴 #1480 — the filter the coder is on NOW, for an answer that lands late.
   * Written here and only here, because this handler is the only place the
   * filter changes (a ref written while rendering is what the React Compiler
   * lint refuses).
   */
  const filterRef = useRef<number | null>(null)
  const changeCodeFilter = useCallback((next: number | null) => {
    // The chip already selected changes nothing — it must not restart the walk
    // on a passage this pass has already rated.
    if (next === filterRef.current) return
    filterRef.current = next
    setCodeFilter(next)
    // 🔴 #1480 — the walk is re-TAKEN on a filter change, never resumed. Kept,
    // it survived a round trip whose middle answer never landed (All → a code
    // still loading → All) and came back at its first passage — one this pass
    // had rated. Cleared, the snapshot rule above takes it from this filter's
    // answer, or waits for a stale one's re-read (D8).
    setWalk(null)
    setCursor(0)
  }, [])

  const advance = useCallback(() => {
    setCursor(c => c + 1)
  }, [])

  /**
   * *Load the next batch* — the walk is replaced when the NEW answer lands, not
   * when the button is pressed: resetting the cursor first put the OLD batch's
   * first passage back on screen for the length of the request.
   */
  const loadNextBatch = useCallback(() => {
    const asked = codeFilter
    void refetch().then(result => {
      // 🔴 #1480 — `refetch()` resolves with the observer's CURRENT result
      // (TanStack 5.100.5, `queryObserver.js:168-175`): after a filter change
      // that is the NEW filter's answer, which this stored under the old one and
      // walked from its first passage. An answer for a filter the coder has
      // left is dropped; it is in the cache, and going back re-takes the walk.
      if (filterRef.current !== asked) return
      if (result.status !== 'success') return   // the page renders the failure
      setWalk({ filter: asked, entries: result.data.entries })
      setCursor(0)
    })
  }, [refetch, codeFilter])

  const rate = useMutation({
    mutationFn: ({ entry, value }: { entry: RatingQueueEntry; value: number | null }) =>
      commitRating(projectId, entry, value),
    onSuccess: (_res, { entry, value }) => {
      setOutcomes(o => ({ ...o, [entryKey(entry)]: { value, codeId: entry.code_id } }))
      // #1425 — what a rating moves elsewhere: the rating α, the grid, the
      // consensus count, the participant table's marker (`dataset-data` — this
      // line invalidated only the dataset LIST, which no screen reads it from),
      // and the four workbench lists (all inactive here). The queue is marked,
      // not refetched; the walk would not move if it were (#1456).
      invalidateAfterRating(queryClient, projectId, { lists: true })
      advance()
    },
    onError: (err) => {
      // A refused rating shows the SERVER's reason — the guidance the backend
      // writes ("Restore it before rating it") is the only useful sentence
      // available, and a generic failure toast throws it away (#871).
      toast.error(serverDetailMessage(err) ?? 'Could not save that rating.')
    },
  })

  const handleCommit = useCallback((value: number) => {
    if (!current) return
    rate.mutate({ entry: current, value })
  }, [current, rate])

  /**
   * Esc — leave this one unrated and move on.
   *
   * ⚠️ It writes NOTHING. The application is already unrated, so a `null` PATCH
   * would be a request that changes no state, and it would clear a merge
   * conflict flag as a side effect (rating again is the adjudication) — a
   * decision the coder did not make by pressing skip.
   */
  const handleSkip = useCallback(() => {
    if (!current) return
    setOutcomes(o => ({ ...o, [entryKey(current)]: undefined }))
    advance()
  }, [current, advance])

  /**
   * 🔴 The counts are the SERVER's, less what this pass has since rated.
   *
   * Nothing refetches after a write (see the header), so `data.total` is the
   * number as of the last load. Showing it raw read *"2 waiting · 1 rated in
   * this pass"* — two statements that cannot both be true — which is exactly
   * the kind of contradiction a progress indicator must not produce.
   *
   * ⚠️ A SKIP does not decrement: the application is still unrated, and the
   * entry really is still waiting. That asymmetry is the whole reason `rated`
   * is counted separately from "acted on".
   */
  const ratedByCode = useMemo(() => {
    const counts = new Map<number, number>()
    for (const o of Object.values(outcomes)) {
      if (o) counts.set(o.codeId, (counts.get(o.codeId) ?? 0) + 1)
    }
    return counts
  }, [outcomes])
  /**
   * 🔴 **The tally is subtracted in the SCOPE the server answered in (#979).**
   * `data.total` is the FILTERED queue once a code is chosen, while `outcomes`
   * spans every code this pass has touched — deliberately, so a rating survives
   * filtering away and back. Subtracting the whole tally from one code's total
   * understated the queue by whatever had been rated elsewhere: rate three on
   * A, switch to B with five outstanding, and the header read "2 waiting" over
   * five entries, contradicting B's own chip.
   */
  const ratedThisSession = [...ratedByCode.values()].reduce((a, b) => a + b, 0)
  /** What the header's "N rated in this pass" says — the pass, in the filter's scope. */
  const ratedInScope = codeFilter == null
    ? ratedThisSession
    : (ratedByCode.get(codeFilter) ?? 0)
  /**
   * 🔴 **#1456 — subtract only the ratings the server's answer has NOT seen.**
   * An entry the current answer LISTS was unrated when the server answered, so a
   * rating given to it since is still inside `total` and `per_code`; an entry it
   * does not list has already left both. Subtracting the whole pass tally from
   * an answer read AFTER some of it — every filter change, every next batch,
   * any refetch — took those ratings off twice ("Nothing waiting to be rated."
   * over a passage on screen). The answer's entries are in its own scope, so
   * this is also #979's rule kept by construction.
   */
  const unseenByCode = useMemo(() => {
    const listed = new Set((data?.entries ?? []).map(entryKey))
    const counts = new Map<number, number>()
    for (const [key, o] of Object.entries(outcomes)) {
      if (o && listed.has(key)) counts.set(o.codeId, (counts.get(o.codeId) ?? 0) + 1)
    }
    return counts
  }, [data, outcomes])
  const unseen = [...unseenByCode.values()].reduce((a, b) => a + b, 0)
  const total = Math.max(0, (data?.total ?? 0) - unseen)
  // No walk yet = loading: the first answer, or a stale one being re-read (above).
  const exhausted = walking && !current

  // ⚠️ Ordered and NAMED by the server. Deriving the names from `entries`
  // would label every code outside the current batch with a bare id.
  // Each count is decremented by what this pass rated on that code, for the
  // same reason `total` is; a chip reading 2 beside a queue of 1 is the same
  // contradiction one level down.
  const perCode = useMemo(
    () => (data?.per_code ?? [])
      .map(c => ({ ...c, outstanding: Math.max(0, c.outstanding - (unseenByCode.get(c.code_id) ?? 0)) }))
      // ⚠️ The SELECTED code keeps its chip at zero — it is what shows which
      // filter is active, and "0" here is a measured count rather than the
      // unanswered-list placeholder the count rule forbids.
      .filter(c => c.outstanding > 0 || c.code_id === codeFilter),
    [data, unseenByCode, codeFilter],
  )

  /**
   * The all-codes remainder. `per_code` is the payload's only UNFILTERED
   * quantity and counts the same buckets `total` does, so this is the grand
   * total without a second field or a second request — see the service's
   * `RatingQueue.per_code`.
   */
  const allTotal = useMemo(
    () => perCode.reduce((sum, c) => sum + c.outstanding, 0),
    [perCode],
  )

  if (isError) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-mm-text">
          {serverDetailMessage(error) ?? 'Could not load the rating queue.'}
        </p>
      </div>
    )
  }

  return (
    // 🔴 **The content column is bounded (#980).** Unconstrained, the strip
    // takes the whole window: 1816px wide at 1920, with "0 · not a factor" and
    // "10 · the main cause" ~1750px apart — an instrument whose two ends cannot
    // be read in one gaze, on the page built for reading instruments. The
    // strip's other three mounts sit inside a workbench column, which is why
    // this is the page that needed it and why the bound belongs HERE rather
    // than on `MagnitudeStrip` (where it would also narrow those three).
    // `max-w-4xl` matches `MergeProject`, the sibling full-page flow.
    // ⚠️ At 640×360 the container is 608px — below the cap, so the measured
    // height budget (84px, three lines above the status bar) is untouched.
    <div className="flex flex-col gap-4 p-4 md:p-6 min-h-0 w-full max-w-4xl mx-auto">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold text-mm-text flex items-center gap-2">
          <Gauge className="w-4 h-4 text-mm-blue" aria-hidden="true" />
          Rate coded passages
        </h1>
        {/* The count is the honest progress statement: a percentage would need
            a denominator that only means something once the sweep is over. */}
        <p className="text-xs text-mm-text-secondary" aria-live="polite">
          {!walking
            ? 'Loading…'
            : total === 0
              ? 'Nothing waiting to be rated.'
              : `${total} waiting${ratedInScope > 0 ? ` · ${ratedInScope} rated in this pass` : ''}`}
        </p>
      </header>

      {/* 🔴 Rendered while a filter is ACTIVE even with nothing left to list —
          the "All codes" chip inside it is the only way to clear the filter,
          so a row gated purely on having chips took the way out with it when
          the chosen code reached zero (#979). */}
      {(perCode.length > 0 || codeFilter != null) && (
        <CodeFilter
          perCode={perCode}
          value={codeFilter}
          onChange={changeCodeFilter}
          allTotal={allTotal}
        />
      )}

      {!walking && <p className="text-sm text-mm-text-secondary">Loading the queue…</p>}

      {exhausted && <Exhausted total={total}
                               // What is left OUTSIDE the current filter, so a
                               // finished code can say where the rest of the
                               // work is instead of reading as "all done".
                               elsewhere={Math.max(0, allTotal - total)}
                               filtered={codeFilter != null}
                               onRefetch={loadNextBatch}
                               busy={isFetching}
                               // A skip records its key too, so any key means the
                               // coder acted on a passage in this pass.
                               takeFocus={Object.keys(outcomes).length > 0} />}

      {current && (
        <Passage
          key={entryKey(current)}
          entry={current}
          recorded={outcomes[entryKey(current)]}
          position={cursor + 1}
          of={entries.length}
          busy={rate.isPending}
          onCommit={handleCommit}
          onSkip={handleSkip}
          onBack={cursor > 0 ? () => setCursor(c => c - 1) : undefined}
        />
      )}
    </div>
  )
}

function CodeFilter({
  perCode, value, onChange, allTotal,
}: {
  perCode: RatingQueueCodeCount[]
  value: number | null
  onChange: (v: number | null) => void
  allTotal: number
}) {
  return (
    <div>
      {/* Working ONE code at a time is what makes a run of ratings comparable:
          the same instrument, the same anchors, many passages. A mixed queue
          asks the coder to re-read a different scale every item. */}
      <h2 className="text-xs font-medium text-mm-text-secondary mb-1.5" id="rating-code-filter">
        Work through one code
      </h2>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="rating-code-filter">
        <FilterChip
          label="All codes"
          count={allTotal}
          selected={value === null}
          onClick={() => onChange(null)}
        />
        {perCode.map(({ code_id, code_name, outstanding }) => (
          <FilterChip
            key={code_id}
            label={code_name}
            count={outstanding}
            selected={value === code_id}
            onClick={() => onChange(code_id)}
          />
        ))}
      </div>
    </div>
  )
}

function FilterChip({
  label, count, selected, onClick,
}: { label: string; count: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
        selected
          ? 'border-mm-blue/40 bg-mm-blue/10 text-mm-blue-text'
          : 'border-mm-surface-border bg-mm-surface text-mm-text-secondary hover:bg-mm-bg'
      }`}
    >
      {label}
      {/* 🔴 The space is OUTSIDE the span, and #908's own remedy is not.
          MEASURED with `computeAccessibleName`: a space typed inside the span
          AND `<span>{' '}{count}</span>` both compute "Clarity12", because the
          algorithm trims each text node before joining. Only a space in the
          BUTTON's own child list survives. */}
      {' '}
      <span className="text-mm-text-muted">{count}</span>
    </button>
  )
}

/**
 * The end of a batch, or of the whole queue.
 *
 * 🔴 **It TAKES FOCUS when the coder's own act ended the batch** (a11y-name-sweep
 * run 6). The strip held focus, and committing or skipping the last passage
 * unmounts it — measured in Chrome, focus fell to `<body>`, so a keyboard user
 * was put back at the top of the page and a screen-reader user heard nothing
 * about the batch ending. Focus goes to *Load the next batch* when there is one
 * (its description is the sentence above it) and to the sentence itself when
 * there is not.
 *
 * ⚠️ **Only when focus has actually been LOST**, and only after an act this
 * pass: a first load that lands here must not pull focus into the page, and a
 * filter chip that emptied the list keeps the focus it has.
 */
function Exhausted({
  total, elsewhere, filtered, onRefetch, busy, takeFocus,
}: {
  total: number
  /** Outstanding acts on codes the current filter excludes. */
  elsewhere: number
  filtered: boolean
  onRefetch: () => void
  busy: boolean
  takeFocus: boolean
}) {
  const more = total > 0
  const messageId = useId()
  const messageRef = useRef<HTMLParagraphElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!takeFocus) return
    const active = document.activeElement
    if (active && active !== document.body) return
    ;(buttonRef.current ?? messageRef.current)?.focus()
  }, [takeFocus])
  return (
    <div className="rounded-lg border border-mm-surface-border bg-mm-surface p-6 text-center">
      <p id={messageId} ref={messageRef} tabIndex={-1} className="text-sm text-mm-text outline-none">
        {more
          ? `That batch is done — ${total} still waiting.`
          : filtered
            // A finished code is not a finished queue. Naming what is left
            // elsewhere is what makes the chip row above read as the next
            // step rather than as leftover furniture.
            ? elsewhere > 0
              ? `Nothing left to rate for this code — ${elsewhere} still waiting on other codes.`
              : 'Nothing left to rate for this code.'
            : 'Every coded passage that has a rating scale has been rated.'}
      </p>
      {!more && !filtered && (
        // The empty state names the precondition, because the commonest reason
        // this list is empty is that no code declares a scale yet — and that is
        // a different screen (the code's Options menu on a coding surface).
        <p className="mt-1.5 text-xs text-mm-text-secondary">
          A code only appears here once it declares a rating scale.
        </p>
      )}
      {more && (
        <Button ref={buttonRef} className="mt-3" onClick={onRefetch} disabled={busy} aria-describedby={messageId}>
          {busy ? 'Loading…' : 'Load the next batch'}
        </Button>
      )}
    </div>
  )
}

function Passage({
  entry, recorded, position, of, busy, onCommit, onSkip, onBack,
}: {
  entry: RatingQueueEntry
  recorded: Outcome
  position: number
  of: number
  busy: boolean
  onCommit: (v: number) => void
  onSkip: () => void
  onBack?: () => void
}) {
  const rated = recorded && !isUnrated(recorded.value)
  return (
    <section
      className={`rounded-lg border p-4 ${SELECTED_CARD}`}
      aria-labelledby="rating-passage-source"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
        <h2 id="rating-passage-source" className="text-sm font-medium text-mm-text min-w-0">
          <span className="truncate">{entry.source_label}</span>
          {entry.record_identifier && (
            <span className="text-mm-text-secondary font-normal"> · {entry.record_identifier}</span>
          )}
          {entry.start_time != null && (
            <span className="text-mm-text-secondary font-normal font-mono">
              {' · '}{formatClock(entry.start_time)}
              {entry.end_time != null ? `–${formatClock(entry.end_time)}` : ''}
            </span>
          )}
        </h2>
        <p className="text-[11px] text-mm-text-muted shrink-0">
          {position} of {of} in this batch
        </p>
      </div>

      {/* The passage itself. A clip's `text` is a LABEL and is routinely empty,
          so the time range in the heading above is its identity, not this. */}
      <blockquote className="text-sm text-mm-text whitespace-pre-wrap border-l-2 border-mm-surface-border pl-3 mb-1">
        {entry.text || <span className="text-mm-text-muted italic">No text on this clip.</span>}
      </blockquote>

      {entry.n_targets > 1 && (
        // A coded group is rated as ONE unit because it is coded as one, and
        // the coder cannot see the siblings from here — so the surface says how
        // far the rating reaches rather than letting it be a surprise.
        <p className="text-[11px] text-mm-text-secondary mb-2">
          This rating covers {entry.n_targets} grouped segments.
        </p>
      )}

      <div className="mt-3">
        <MagnitudeStrip
          // Keyed on the target so the cursor and focus initialise once per
          // passage (#870 c) — on this surface the target changes constantly,
          // which is the case that rule was written for.
          key={entryKey(entry)}
          codeName={entry.code_name}
          scale={entry.scale}
          value={recorded ? recorded.value : null}
          onCommit={onCommit}
          onSkip={onSkip}
          // 🔴 The sweep's mode: no cursor until one is chosen. With a cursor
          // parked mid-scale, Enter would stamp the midpoint — over a long
          // queue that is the default-stamping mistake arriving by keystroke.
          preselectMidpoint={false}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        {/* 🔴 Each name BEGINS with the word on the button (WCAG 2.5.3). The Skip
            label used to be "Leave unrated and go to the next passage", which
            does not contain "Skip" — so a voice-control user saying "click Skip"
            reached nothing (a11y-name-sweep run 6, measured in Chrome's tree;
            #907's rule). The explanation rides after the visible word. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={!onBack}
          aria-label="Previous passage"
        >
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Previous
        </Button>
        <p className="text-[11px] text-mm-text-secondary" aria-live="polite">
          {busy
            ? 'Saving…'
            : rated
              ? `Recorded ${describeMagnitude(recorded.value, entry.scale)}.`
              : recorded
                ? 'Left unrated.'
                : ''}
        </p>
        <Button variant="ghost" size="sm" onClick={onSkip} aria-label="Skip: leave unrated and go to the next passage">
          <SkipForward className="w-3.5 h-3.5" aria-hidden="true" /> Skip
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>
    </section>
  )
}

/** `m:ss`, for a clip's range in the heading. */
function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const m = Math.floor(whole / 60)
  const s = whole % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
