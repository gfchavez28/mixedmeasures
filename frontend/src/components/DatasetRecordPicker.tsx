import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query'
import { Loader2, Table2, X } from 'lucide-react'
import { Link } from 'react-router'
import { datasetsApi, retryUnanswered, type LinkableRow } from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { LoadState } from '@/components/LoadStatus'
import { FOCUS_RING } from '@/lib/selection'
import {
  RECORD_PAGE_SIZE,
  RECORD_PICKER_MORE_FAILED,
  RECORD_PICKER_SEARCHING,
  RECORD_SEARCH_DEBOUNCE_MS,
  RECORD_SEARCH_MAX_LENGTH,
  RECORD_SEARCH_PLACEHOLDER,
  linkableRowDetail,
  linkableRowMatch,
  recordPickerCount,
  showMoreCount,
} from '@/lib/linkable-rows'

interface DatasetRecordPickerProps {
  projectId: number
  datasetId: number
  datasetName: string
  /** Link this record. The panel owns the act — its cache refresh and where focus lands. */
  onPick: (row: LinkableRow) => void
  /** A link is running: the records are busy, not disabled (#1130). */
  busy: boolean
  /** The server's sentence for a refused link, or null (#1053 §3.3). */
  linkError: string | null
  /** Leave the picker (Escape, or the X). */
  onClose: () => void
}

const RECORD_BUTTON = 'button[data-record]:not(:disabled)'

/**
 * #1053 — the participant panel's record picker, searching on the SERVER.
 *
 * It used to load every record of the dataset and filter them here, which never
 * finished on a large survey (70 s against a 30 s limit, then a retry). It asks
 * `GET …/linkable-rows?q=` for one ranked page instead, and *Show more* pages on.
 * Mounted only while linking (`list-load-state.md` §#1045): a closed picker
 * holds no query at all.
 *
 * - **The key keeps the `['linkable-rows', projectId]` prefix** — every link door
 *   refreshes through `lib/participant-link-cache.ts`, which invalidates that
 *   prefix, so a record just linked elsewhere is not offered again.
 * - **`keepPreviousData` only with the "old answer" treatment** (#1038 i): while
 *   a new term loads, the old rows stay but the list is `aria-busy` and dimmed,
 *   the count line says *Searching…*, and there is no *Show more* and no empty
 *   line — nothing claims the old answer is the new one.
 * - **The count line is the ONE `role="status"`** and the search box's
 *   description, so a reader hears how many matched after each search.
 * - **Keys:** ArrowDown from the box to the first record that can be linked,
 *   Up/Down between them, Up from the first back to the box; Escape leaves the
 *   picker (and is marked, so the panel behind it stays open — #1041). Space and
 *   Enter in the box are never claimed: they type and do nothing else.
 */
export function DatasetRecordPicker({
  projectId, datasetId, datasetName, onPick, busy, linkError, onClose,
}: DatasetRecordPickerProps) {
  const [term, setTerm] = useState('')
  const [asked, setAsked] = useState('')
  useEffect(() => {
    const next = term.trim()
    const timer = setTimeout(() => setAsked(next), RECORD_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term])

  const query = useInfiniteQuery({
    queryKey: ['linkable-rows', projectId, datasetId, asked],
    queryFn: ({ pageParam, signal }) => datasetsApi.linkableRows(
      projectId, datasetId, { q: asked, limit: RECORD_PAGE_SIZE, offset: pageParam }, signal,
    ),
    initialPageParam: 0,
    // The server states the total; a page is never inferred full from its length.
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0)
      return last.rows.length > 0 && loaded < last.total ? loaded : undefined
    },
    retry: retryUnanswered,
    placeholderData: keepPreviousData,
  })
  const load = useListLoad(query)
  const pages = query.data?.pages
  const rows = useMemo(() => pages?.flatMap(p => p.rows) ?? [], [pages])
  const total = pages?.[0]?.total ?? 0
  const refusal = pages?.[0]?.link_refusal ?? null
  const updating = query.isPlaceholderData
  const ready = load.status === 'ready'

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const countRef = useRef<HTMLParagraphElement>(null)
  const countId = useId()

  // *Show more* → focus the first record it revealed (or the count, when every
  // revealed record is taken), once the page lands.
  const revealFrom = useRef<number | null>(null)
  useEffect(() => {
    const from = revealFrom.current
    if (from === null || rows.length <= from) return
    revealFrom.current = null
    const revealed = rows.slice(from).find(r => r.linked_participant_id === null)
    const target = revealed
      ? listRef.current?.querySelector<HTMLButtonElement>(`button[data-record="${revealed.row_id}"]`)
      : null
    ;(target ?? countRef.current)?.focus()
  }, [rows])

  // A refused link: the record pressed was usually taken a moment ago, so the
  // refresh that follows disables it — and a focused control that becomes
  // disabled drops focus to <body> (#965's class, found driving this picker).
  // The sentence takes focus first, from a record or from nowhere; focus that is
  // anywhere else (the search box) stays put.
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (linkError === null) return
    const active = document.activeElement
    if (!active || active === document.body || listRef.current?.contains(active)) {
      errorRef.current?.focus()
    }
  }, [linkError])

  const enabledRecords = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(RECORD_BUTTON) ?? [])

  const leave = (e: KeyboardEvent) => {
    e.preventDefault()
    onClose()
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') return leave(e)
    if (e.key === 'ArrowDown') {
      const first = enabledRecords()[0]
      if (first) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') return leave(e)
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const records = enabledRecords()
    const at = records.indexOf(document.activeElement as HTMLButtonElement)
    if (at === -1) return
    e.preventDefault()
    if (e.key === 'ArrowDown') records[Math.min(at + 1, records.length - 1)].focus()
    else if (at === 0) searchRef.current?.focus()
    else records[at - 1].focus()
  }

  const showMore = () => {
    if (query.isFetchingNextPage) return
    revealFrom.current = rows.length
    void query.fetchNextPage()
  }

  const countLine = refusal !== null || !ready
    ? null
    : updating
      ? RECORD_PICKER_SEARCHING
      : [recordPickerCount(rows.length, total, asked, datasetName),
         query.isFetchNextPageError ? RECORD_PICKER_MORE_FAILED : null].filter(Boolean).join(' ')
  // `hasNextPage` alone decides: it is false while the old answer is shown (the
  // placeholder is not the query's data), which is what keeps *Show more* off then.
  const offerMore = ready && query.hasNextPage

  return (
    <div className="mt-2 border border-mm-border-subtle rounded bg-mm-surface">
      <div className="p-1.5 border-b border-mm-border-subtle flex items-center gap-1">
        <span className="text-[11px] text-mm-text-muted truncate max-w-[120px]" title={datasetName}>
          {datasetName}
        </span>
        {/* #1625 (D238/D239): an in-app link navigates in place — the packaged app
            opens no new window, so `target="_blank"` here did nothing. */}
        <Link
          to={`/projects/${projectId}/datasets/${datasetId}`}
          className="inline-flex items-center justify-center w-6 h-6 rounded text-mm-text-faint hover:text-mm-blue-text flex-shrink-0"
          aria-label={`Open dataset "${datasetName}"`}
          title="Open dataset"
          onClick={(e) => e.stopPropagation()}
        >
          <Table2 className="w-3 h-3" aria-hidden="true" />
        </Link>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center w-6 h-6 rounded text-mm-text-faint hover:text-mm-text-secondary flex-shrink-0"
          aria-label="Stop linking"
          title="Stop linking"
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>

      {refusal !== null ? (
        // #1157 — a table the tool keeps links its own records. The panel never
        // offers one; this arm is for a table that became one while open.
        <p className="text-xs text-mm-text-muted p-2 leading-snug">{refusal}</p>
      ) : (
        <>
          <div className="p-2 border-b border-mm-border-subtle space-y-1">
            <input
              ref={searchRef}
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onSearchKeyDown}
              maxLength={RECORD_SEARCH_MAX_LENGTH}
              placeholder={RECORD_SEARCH_PLACEHOLDER}
              aria-label={`Search ${datasetName} records`}
              aria-describedby={countLine !== null ? countId : undefined}
              className="w-full text-xs border border-mm-border-subtle rounded px-2 py-1 bg-mm-surface text-mm-text"
              autoFocus
            />
            {countLine !== null && (
              <p
                ref={countRef}
                id={countId}
                role="status"
                tabIndex={-1}
                className={`text-[11px] text-mm-text-muted leading-snug rounded-sm ${FOCUS_RING}`}
              >
                {countLine}
              </p>
            )}
          </div>
          {linkError !== null && (
            <p
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className={`text-xs text-mm-text p-2 border-b border-mm-border-subtle leading-snug ${FOCUS_RING}`}
            >
              {linkError}
            </p>
          )}
          <div
            ref={listRef}
            onKeyDown={onListKeyDown}
            aria-busy={updating || undefined}
            className={`max-h-48 overflow-y-auto divide-y divide-mm-border-subtle ${updating ? 'opacity-60' : ''}`}
          >
            {rows.map(row => {
              const isLinked = row.linked_participant_id !== null
              const detail = linkableRowDetail(row)
              const match = linkableRowMatch(row)
              return (
                <button
                  type="button"
                  key={row.row_id}
                  data-record={row.row_id}
                  // #1130 — busy is `aria-disabled` + the guard, never `disabled`
                  // (#959 §4); a record someone else holds stays natively
                  // disabled, which is permanent, not a busy state.
                  disabled={isLinked}
                  aria-disabled={(!isLinked && busy) || undefined}
                  onClick={() => {
                    if (busy) return
                    onPick(row)
                  }}
                  className={`w-full text-left px-2 py-1.5 text-xs ${
                    isLinked
                      ? 'text-mm-text-faint bg-mm-bg cursor-not-allowed'
                      : 'hover:bg-mm-surface-hover cursor-pointer text-mm-text'
                  }`}
                >
                  {/* #1130 — the parts are joined by TEXT spaces, not margins
                      alone: a margin is not a space (#908). */}
                  <span className="font-medium">{row.row_identifier || `Row ${row.row_id}`}</span>
                  {detail && <>{' '}<span className="text-mm-text-faint">{detail}</span></>}
                  {isLinked && (
                    <>
                      {' '}
                      {/* One text node: a space at the edge of an inline span is
                          dropped by name computation ("already linked toP009"). */}
                      <span className="text-mm-text-faint" aria-hidden="true">({row.linked_participant_name})</span>
                      <span className="sr-only">{`(already linked to ${row.linked_participant_name})`}</span>
                    </>
                  )}
                  {match && (
                    <>
                      {/* On its own line for the eye; in the name, the words that
                          say this part is WHERE the search matched — without them
                          a reader heard "…23 hrs1: .i: Inapplicable" (driven). */}
                      {/* The spaces are TEXT nodes: one at the edge of a span is
                          dropped by name computation ("Name 1matched in"). */}
                      {' '}<span className="sr-only">matched in</span>{' '}
                      <span className="block text-[11px] text-mm-text-muted break-words">{match}</span>
                    </>
                  )}
                </button>
              )
            })}
            {!ready && (
              <LoadState
                load={load}
                loadingLabel="Loading records…"
                failedTitle="This dataset's records could not be loaded"
                size="panel"
              />
            )}
            {offerMore && (
              <div className="p-1.5">
                {/* The name never carries the busy state (#770): it stays
                    "Show N more" while the page loads, which `aria-busy` says. */}
                <button
                  type="button"
                  onClick={showMore}
                  aria-disabled={query.isFetchingNextPage || undefined}
                  aria-busy={query.isFetchingNextPage || undefined}
                  className="w-full inline-flex items-center justify-center gap-1 text-xs text-mm-blue-text hover:underline py-1 aria-disabled:opacity-60 aria-disabled:cursor-progress"
                >
                  {query.isFetchingNextPage && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                  {`Show ${showMoreCount(rows.length, total).toLocaleString()} more`}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
