import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  PARTICIPANT_LIST_LIMIT, PARTICIPANT_SEARCH_LABEL, PARTICIPANT_SEARCH_PLACEHOLDER,
  noParticipantsMatch, searchParticipants, shownOfTotal,
} from '@/lib/participant-search'
import { Link } from 'react-router'
import { FOCUS_RING, SELECTED_ROW } from '@/lib/selection'
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Plus,
  Users,
  Pencil,
  Check,
  X,
  Trash2,
  UserMinus,
  CircleAlert,
  ChevronRight,
  Search,
  MessageSquare,
  Table2,
  FileText,
} from 'lucide-react'
import {
  participantsApi,
  datasetsApi,
  speakersApi,
  type Participant,
  type Dataset,
  type LinkableRow,
  type WithdrawalReport,
  isServerRefusal,
  retryUnanswered,
  serverDetailMessage,
} from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { useWithdrawnIdentifierConfirm } from '@/hooks/useWithdrawnIdentifierConfirm'
import { createConfirmingWithdrawn, WITHDRAWN_RENAME_WORDING } from '@/lib/withdrawn-identifier'
import { invalidateAfterParticipantLinkChange } from '@/lib/participant-link-cache'
import { forgetCachedProjectPages } from '@/lib/project-cache'
import { useMainContentLanding } from '@/hooks/useMainContentLanding'
import { LoadFailedNotice, LoadState } from '@/components/LoadStatus'
import { toast } from 'sonner'
import { DatasetRecordPicker } from '@/components/DatasetRecordPicker'
import { useProjectLayout } from '@/layouts/ProjectLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollableTable } from '@/components/ui/ScrollableTable'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { getSpeakerInitials, getInitialsBadgeColors, isOrphanedParticipant, isUnnamedLabel, UNNAMED_LABEL } from '@/lib/conversation-import-utils'
import { getContrastColor } from '@/lib/utils'
import {
  withdrawalLocations, describeDeleteConsequence, withdrawalHeadline, withdrawalDoneNote,
  WITHDRAWAL_SCOPE_NOTE,
  WITHDRAWAL_SECTION_FAILED_TITLE,
  bulkDeleteDescription,
  bulkDeleteRefusals,
  unlinkedRecordsNote,
  unplacedCanvasQuotesNote,
} from '@/lib/withdrawal-copy'
import WithdrawParticipantDialog from '@/components/WithdrawParticipantDialog'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { useBlindScope } from '@/hooks/useBlindScope'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  deleteConfirmTitle, participantNameWithId, type ParticipantNaming,
} from '@/lib/participant-naming'

/** A participant a confirmation acts on — its id and the row's names (#1139). */
type ConfirmTarget = ParticipantNaming & { id: number }

/** Taken from the row as the dialog opens: the names are fixed for its life. */
const confirmTarget = (p: Participant): ConfirmTarget =>
  ({ id: p.id, identifier: p.identifier, display_name: p.display_name })

/** Before any confirm has opened (its content is not rendered then). */
const NO_ONE: ParticipantNaming = { identifier: '', display_name: null }

/**
 * 🔴 #1152 — the report a CONFIRMATION reads (the withdrawal and the record delete).
 *
 * They read the key the detail panel reads, `['withdrawal-report', projectId, id]`,
 * and so showed whatever the panel had cached — 60 s fresh by the app default,
 * minutes old once the panel had been left open. Reproduced live: after a document was made
 * about a participant on the Documents page, the delete confirm said they had "no
 * linked transcript turns, responses or documents" (the delete clears that
 * document's subject, #1110) and the withdrawal's button enabled at once.
 *
 * The report reads ≥ 10 inputs, so no enumeration of the writers can keep a cache
 * of it true (`backend-invariants.md` §5b): the guarantee is on the READ side.
 *
 * - Its OWN key (the `'confirm'` tail), so nothing another surface cached can
 *   answer for it — and still under the prefix every invalidation names.
 * - `gcTime: 0`: the id goes `null` when the dialog closes, the old entry loses
 *   its only observer and is dropped, and the next opening asks again and says so.
 *   `staleTime: 0`: while it is OPEN, coming back to the window (or the network)
 *   asks again — the researcher may have changed the project elsewhere meanwhile.
 *   The pair is `useRemovalPlan`'s shape (#1175); each has its own test.
 * - ⚠️ `refetchOnMount: 'always'` on the SHARED key does NOT do this — this
 *   observer mounts with the page and only changes key (probe: 0 refetches either
 *   way, Batch 4 review §5).
 *
 * `enabled` only while a dialog is open; the dialogs read the load only while open,
 * so the disabled case (loading forever) is never shown.
 */
function useConfirmReport(projectId: number, participantId: number | null) {
  const query = useQuery({
    queryKey: ['withdrawal-report', projectId, participantId, 'confirm'],
    queryFn: () => participantsApi.withdrawalReport(projectId, participantId!),
    enabled: participantId !== null,
    staleTime: 0,
    gcTime: 0,
  })
  const load = useListLoad(query)
  return { report: query.data ?? null, load }
}

/**
 * 🔴 #1320 — after an act that rewrites canvas content on the server (a withdrawal; since
 * the joint display's slice 2, D314, a plain delete too: it removes the person from every
 * list of cases that don't fit), cached canvas content must never be served old. The theme
 * editor binds its content ONCE (`components/canvas/the internal design notes), so a Writing view handed
 * the old copy would edit it and autosave it straight back — here, a deleted person's entry
 * and the researcher's reason about them, under an id SQLite can give the next participant.
 * RESET, never invalidate: no data until the server's version arrives (`list-load-state.md`
 * §5's reset-vs-invalidate).
 */
function resetCanvasContent(queryClient: QueryClient, projectId: number) {
  void queryClient.resetQueries({ queryKey: ['canvas', projectId] })
  void queryClient.resetQueries({ queryKey: ['snapshot-detail', projectId] })
}

/**
 * #1088 — the table and the detail panel share a row only when there is room
 * for both. Measured at 640×360: the panel kept its 384px beside a table whose
 * narrowest form was 613px in a 593px column, so it was drawn OVER the Role and
 * Conversations columns, and its height cap (`100vh - 200px`) left it 160px.
 *
 * So the layout asks the CONTAINER (`@container/participants`), never the
 * viewport (#899: a scrollbar takes width no media query sees). Below 960px the
 * panel stacks under the table's scroll box at its natural height and the page
 * scrolls; from 960px it is a sticky column beside the table, bounded to the
 * same 70vh as the table box rather than to a guess about the window. The
 * classes are literal strings in ONE place so the two halves cannot drift.
 */
const DETAIL_LAYOUT =
  'flex flex-col gap-4 @min-[960px]/participants:flex-row @min-[960px]/participants:items-start'
const DETAIL_PANEL =
  'w-full shrink-0 bg-mm-surface rounded-lg border border-mm-border-subtle '
  + '@min-[960px]/participants:w-96 @min-[960px]/participants:sticky @min-[960px]/participants:top-4 '
  + '@min-[960px]/participants:max-h-[70vh] @min-[960px]/participants:overflow-y-auto'
/** The id the open row's `aria-controls` names. */
const DETAIL_PANEL_ID = 'participant-detail-panel'

/** #1606 — the withdrawal's done toast, capped to the window so a tall note scrolls
 *  inside it instead of growing past the top edge (the toaster is bottom-anchored with
 *  sonner's 24 px offset, so 3rem keeps both ends on screen). `items-start!`: sonner
 *  centres the toast's row (`align-items: center` at two attribute selectors, which a
 *  plain class cannot beat), and centred content overflows UPWARD where no scroll
 *  reaches — the capped toast hid its own title 75 px above its top edge (driven).
 *  A literal string, for Tailwind. jsdom computes no layout: driven at 640×360. */
const TOAST_FITS_WINDOW = 'max-h-[calc(100dvh-3rem)] overflow-y-auto items-start!'

/** The orphan filter's description, and the badge's — one sentence (#1110). */
const NO_LINKED_SOURCES_TITLE =
  'Not linked to any conversation, dataset record or document'

export default function ParticipantsPage() {
  const { projectId } = useProjectLayout()
  const queryClient = useQueryClient()

  const participantsListQuery = useQuery({
    queryKey: ['participants', projectId],
    queryFn: () => participantsApi.list(projectId),
    staleTime: 30_000,
    retry: retryUnanswered,
  })
  const participantsData = participantsListQuery.data
  const participantsLoad = useListLoad(participantsListQuery)
  const mainLanding = useMainContentLanding()

  const { data: datasetsData } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => datasetsApi.list(projectId),
    staleTime: 30_000,
  })

  // Memoised so it is the SAME array between renders — the search index in
  // `lib/participant-search.ts` is cached per array (#1052).
  const participants = useMemo(() => participantsData?.participants ?? [], [participantsData])
  const datasets = datasetsData?.datasets || []

  // Add participant form state
  const [isAddingParticipant, setIsAddingParticipant] = useState(false)
  const [newParticipantName, setNewParticipantName] = useState('')
  const [newParticipantRole, setNewParticipantRole] = useState('')
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false)

  // Selection + confirm state
  const [selectedParticipantId, setSelectedParticipantId] = useState<number | null>(null)
  const [deleteParticipant, setDeleteParticipant] = useState<ConfirmTarget | null>(null)
  // The person each confirm's TITLE names (#1139), kept after it closes: the
  // content fades out for 200 ms once `open` goes false, and a title built from
  // the cleared target read "Remove ’s data?" while it did.
  const [deleteShown, setDeleteShown] = useState<ConfirmTarget | null>(null)
  const [withdrawShown, setWithdrawShown] = useState<ConfirmTarget | null>(null)

  // Orphan filter + bulk-delete state
  const [showOrphansOnly, setShowOrphansOnly] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  /**
   * 🔴 #1091 — WHERE FOCUS GOES when the detail panel opens and closes.
   *
   * The panel renders after the whole table in the DOM, so a keyboard user who
   * opened row 17 of 30 was 65 Tab presses from it (measured, run before this
   * fix) — and at 200 rows, several hundred: linking a dataset record and the
   * withdrawal report were out of reach in practice. Closing it dropped focus to
   * `<body>`, back at the top of the page.
   *
   * - Opened from the KEYBOARD, the panel takes focus (its heading). Opened by a
   *   click it does not — the pointer is already where the reader is looking —
   *   but a stacked panel below the fold is scrolled into view.
   * - Closed while focus was INSIDE it (or already lost), focus returns to the
   *   row that opened it, whose Enter re-opens it; if that row is no longer
   *   shown, to the search box. Focus that is somewhere real is never moved.
   */
  const [panelTakesFocus, setPanelTakesFocus] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const focusRowAfterClose = useRef<number | null>(null)
  const openPanel = (participantId: number, viaKeyboard: boolean) => {
    setPanelTakesFocus(viaKeyboard)
    setSelectedParticipantId(participantId)
  }
  const closePanel = useCallback(() => {
    const active = document.activeElement
    const focusLost = !active || active === document.body
    if (selectedParticipantId !== null && (focusLost || panelRef.current?.contains(active))) {
      focusRowAfterClose.current = selectedParticipantId
    }
    setSelectedParticipantId(null)
  }, [selectedParticipantId])

  // Mutations
  // #1190 (D12) — an ID that belongs to someone who withdrew is refused with its own
  // 409, and the researcher is asked (the server's sentence) before the override is
  // sent. `null` = they declined: nothing was created, and the form stays as it was.
  const { ask: askWithdrawn, dialog: withdrawnDialog } = useWithdrawnIdentifierConfirm()
  const createParticipantMutation = useMutation({
    mutationFn: (data: { identifier: string; display_name?: string; role?: string }) =>
      createConfirmingWithdrawn(
        (confirm) => participantsApi.create(projectId, confirm ? { ...data, confirm_withdrawn: true } : data),
        askWithdrawn,
      ),
    onSuccess: (created) => {
      if (created === null) return
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setNewParticipantName('')
      setNewParticipantRole('')
      setDuplicateConfirmed(false)
      setIsAddingParticipant(false)
    },
  })

  const updateParticipantMutation = useMutation({
    // #1190 (D12) — a RENAME to a withdrawn person's ID is refused the same way and asks
    // the same question, in a rename's words; `null` = declined, nothing was renamed.
    mutationFn: ({ participantId, data }: { participantId: number; data: { identifier?: string; display_name?: string; role?: string } }) =>
      createConfirmingWithdrawn(
        (confirm) => participantsApi.update(
          projectId, participantId, confirm ? { ...data, confirm_withdrawn: true } : data),
        (sentence) => askWithdrawn(sentence, WITHDRAWN_RENAME_WORDING),
      ),
    onSuccess: (result, { participantId }) => {
      if (result === null) return
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      queryClient.invalidateQueries({ queryKey: ['speakers', projectId] })
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'segments' })
      // #1152 — the open panel and the withdrawal report both carry the name. A
      // rename refreshed the list alone: CONFIRMED live, the panel heading still
      // said "Jonas Berg" while the withdrawal confirm's title said "Remove Jonas
      // Bergström's data?" over a body naming "Jonas Berg".
      queryClient.invalidateQueries({ queryKey: ['participant-detail', participantId] })
      queryClient.invalidateQueries({ queryKey: ['withdrawal-report', projectId] })
    },
  })

  const deleteParticipantMutation = useMutation({
    mutationFn: (participantId: number) => participantsApi.delete(projectId, participantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setSelectedParticipantId(null)
    },
    // Joint display slice 2 (D314): a delete rewrites the canvas — it removes the person's
    // entries from every list of cases that don't fit — so the canvas is reset as after a
    // withdrawal. On SETTLED, for the withdrawal's reason (#1474).
    onSettled: () => resetCanvasContent(queryClient, projectId),
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((pid) => participantsApi.delete(projectId, pid))
      )
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      return { total: ids.length, failed: rejected.length, why: bulkDeleteRefusals(rejected.map(r => r.reason)) }
    },
    onSuccess: ({ total, failed, why }) => {
      if (failed > 0) {
        // #1667 (D343): the server's reasons, once each — a damaged canvas copy refuses every
        // delete in one sentence naming it. Capped to the window like the withdrawal's note.
        toast.error(`Deleted ${total - failed} of ${total}; ${failed} could not be removed.`,
          why ? { description: why, className: TOAST_FITS_WINDOW } : undefined)
      } else {
        toast.success(`Deleted ${total} participant${total === 1 ? '' : 's'}.`)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setSelectedIds(new Set())
      setSelectedParticipantId(null)
      resetCanvasContent(queryClient, projectId)  // D314, as the single delete
    },
  })

  /*
   * #702(2) — the delete confirm said "Speaker links will be removed."
   *
   * True, and it reads as tidy-up. What actually happens is that the transcript
   * survives verbatim, the speaker NAME survives independently of this record,
   * and the responses survive unlinked — so a researcher honouring a withdrawal
   * request had every reason to believe they were done. Worse, deleting the
   * record first DESTROYS the link used to find any of it.
   *
   * The confirm now names the surviving data. Fetched only while the dialog is
   * pending, and the copy has a safe count-free form for the moment before it
   * resolves — silence there would be the old behaviour by accident.
   */
  /**
   * #702(3) — the withdrawal, distinct from "delete the record".
   *
   * A separate action on purpose: deleting the record removes one row and leaves
   * everything else, which is the right behaviour for tidying up an orphan and
   * the WRONG behaviour for a withdrawal request. Conflating them is how a
   * researcher ends up believing a request was honoured.
   */
  const [withdrawParticipant, setWithdrawParticipant] = useState<ConfirmTarget | null>(null)

  const withdrawConfirm = useConfirmReport(projectId, withdrawParticipant?.id ?? null)

  const withdrawMutation = useMutation({
    mutationFn: (target: ConfirmTarget) =>
      participantsApi.withdraw(projectId, target.id),
    onSuccess: (res, target) => {
      const participantId = target.id
      // 🔴 #1474 — the act moved nearly every page in the project: it DELETED their
      // rows, responses and quotes, BLANKED their turns, rewrote the canvas copies,
      // deleted stored metric results and wrote a backup (`backend-invariants.md` §5).
      // A hand list of keys here missed nine readers of their answers and words
      // (the Data grid, Text Coding, Content › by code, frequencies, metrics, …), and
      // no list can be complete — `['segments', cid]`, `['notes', cid]` and
      // `['participant-detail', id]` carry no project id. So, as Merge does, every page
      // not on screen is FORGOTTEN and the queries on screen refetch: the list keeps
      // its rows while it asks again. The forget is in `onSettled`, below.
      // Their OWN panel and confirm are dropped HERE, on success only — IN ADDITION
      // to the forget, never instead of it (§1b: a by-id list misses the next key
      // shape). Still observed in this tick, they would otherwise be refetched,
      // asking the server about someone who no longer exists (three requests,
      // measured), and their detail kept for the next participant given their id
      // (#1248). `onSuccess` runs before `onSettled`, so they are gone before the
      // forget refreshes what is on screen. NOT after a failure: the person may
      // still exist and their panel and confirm stay open, and a removed query
      // under a mounted observer comes back EMPTY ("Loading…", the confirm
      // waiting again) where a refetch keeps the answer on screen.
      queryClient.removeQueries({ queryKey: ['participant-detail', participantId] })
      queryClient.removeQueries({ queryKey: ['withdrawal-report', projectId, participantId] })
      // #1139 — the person, as the dialog named them; it said "E-01 removed".
      toast.success(
        `${participantNameWithId(target)} removed. Backup saved as ${res.backup_filename}.`,
        {
          // #1320 — it now also names the backups, so it is held longer.
          description: withdrawalDoneNote(res),
          duration: 20000,
          // #1606 — with the other projects and the update copies the note can be taller
          // than a short window (458 px at 640×360, driven), and a bottom-anchored toast
          // grows UP past the top edge, taking the "… removed. Backup saved as …" line
          // with it. Capped to the window (sonner's 24 px offset at each end), it scrolls.
          className: TOAST_FITS_WINDOW,
        },
      )
      setWithdrawParticipant(null)
      // Their panel would otherwise ask for a participant that no longer exists
      // and say "Loading…" until the page was left.
      setSelectedParticipantId((open) => (open === participantId ? null : open))
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Could not remove this participant. Nothing was changed.')
    },
    // #1474 — on SETTLED, `mm-file-doors.md` §1b's reason: the request has no client
    // timeout (#1025), but a connection that drops AFTER the server committed (the
    // engine dying between commit and answer) arrives here as a failure, and the
    // act may have finished. After a real refusal the cost is first-visit loads.
    onSettled: () => {
      forgetCachedProjectPages(queryClient, { refreshActive: true })
      // A canvas no page shows was just removed; one still ON SCREEN (the act lands
      // whenever the request returns — no client timeout, #1025) was only invalidated
      // above, which keeps serving the old copy, so it is RESET too.
      resetCanvasContent(queryClient, projectId)
    },
  })

  const deleteConfirm = useConfirmReport(projectId, deleteParticipant?.id ?? null)
  const deleteLocations = deleteConfirm.report ? withdrawalLocations(deleteConfirm.report) : []

  const orphanCount = participants.filter(isOrphanedParticipant).length

  /**
   * #1052 — the table renders at most `shownLimit` rows, and search reaches the
   * rest. It rendered one row per participant, and a survey imported with
   * identifier linking makes one participant per record: MEASURED at 20,000
   * participants, 25.9 s to open and 640,162 DOM nodes; the BES file's 122,382
   * would be six times that, the renderer-out-of-memory shape of #1045. The
   * count line says the table stops early (#844's rule), and "Show more" widens
   * it on request. Search and ranking are `lib/participant-search.ts`, shared
   * with the two participant pickers.
   *
   * ⚠️ Select-all acts on the rows SHOWN, and says so when that is not all of
   * them: selecting thousands of rows nobody can see, for a bulk delete that
   * issues one request per participant, is not a gesture a checkbox should make.
   */
  const [search, setSearch] = useState('')
  const [shownLimit, setShownLimit] = useState(PARTICIPANT_LIST_LIMIT)
  const filterBase = useMemo(
    () => (showOrphansOnly ? participants.filter(isOrphanedParticipant) : participants),
    [participants, showOrphansOnly],
  )
  const visibleParticipants = useMemo(() => searchParticipants(filterBase, search), [filterBase, search])
  const renderedParticipants = useMemo(
    () => visibleParticipants.slice(0, shownLimit),
    [visibleParticipants, shownLimit],
  )
  const hiddenCount = visibleParticipants.length - renderedParticipants.length
  const tableNote = shownOfTotal(renderedParticipants.length, visibleParticipants.length, search.trim() !== '')
  const changeSearch = (value: string) => {
    setSearch(value)
    setShownLimit(PARTICIPANT_LIST_LIMIT)
  }

  // "Show more" unmounts itself when it reveals the last rows, which would drop
  // a keyboard user's focus to <body> (#955's class). Every press therefore
  // moves focus to the FIRST row it revealed — where reading continues anyway.
  const tableBodyRef = useRef<HTMLTableSectionElement>(null)
  const focusRowAfterReveal = useRef<number | null>(null)
  useEffect(() => {
    const index = focusRowAfterReveal.current
    if (index === null) return
    focusRowAfterReveal.current = null
    const row = tableBodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-participant-row]')[index]
    row?.focus()
  }, [shownLimit])
  const showMore = () => {
    focusRowAfterReveal.current = renderedParticipants.length
    setShownLimit((n) => n + PARTICIPANT_LIST_LIMIT)
  }

  // #1091 — the close half: back to the row that opened the panel.
  useEffect(() => {
    const id = focusRowAfterClose.current
    if (id === null || selectedParticipantId !== null) return
    focusRowAfterClose.current = null
    const row = tableBodyRef.current?.querySelector<HTMLElement>(`tr[data-participant-id="${id}"]`)
    ;(row ?? searchRef.current)?.focus()
  }, [selectedParticipantId])

  /**
   * 🔴 #1072 — THE selection every act reads: the checked rows that are SHOWN.
   *
   * `selectedIds` survives a search (so a row checked, hidden and shown again is
   * still checked), and it used to be what *Delete selected* deleted — so after
   * select-all on the first rows and a search that hid them, the bar still said
   * "20 selected" over one unchecked row and the delete removed twenty people
   * nobody could see: irreversible, and it makes a later withdrawal request
   * harder (`backend-invariants.md` §5). Deriving it here, rather than pruning the
   * state on each way a row can disappear (a search, a filter, a refresh after a
   * delete elsewhere), is what keeps it true of every one of them.
   */
  const selectedShownIds = useMemo(
    () => renderedParticipants.filter((p) => selectedIds.has(p.id)).map((p) => p.id),
    [renderedParticipants, selectedIds],
  )
  const selectedCount = selectedShownIds.length
  // The confirm NAMES who it deletes — a count alone ties the act to nothing a
  // reader can check against the table.
  const selectedNames = useMemo(() => {
    const labels = renderedParticipants
      .filter((p) => selectedIds.has(p.id))
      .map((p) => p.display_name || p.identifier)
    return labels.length <= 3
      ? labels.join(', ')
      : `${labels.slice(0, 3).join(', ')} and ${(labels.length - 3).toLocaleString()} more`
  }, [renderedParticipants, selectedIds])
  // #1110 — the documents a bulk delete leaves without a subject. The confirm
  // used to say only that "speaker or dataset-row links will be cleared".
  const selectedDocumentCount = useMemo(
    () => renderedParticipants
      .filter((p) => selectedIds.has(p.id))
      .reduce((n, p) => n + p.linked_documents.length, 0),
    [renderedParticipants, selectedIds],
  )

  const allVisibleSelected =
    renderedParticipants.length > 0 &&
    renderedParticipants.every((p) => selectedIds.has(p.id))
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        renderedParticipants.forEach((p) => next.delete(p.id))
        return next
      }
      return new Set([...prev, ...renderedParticipants.map((p) => p.id)])
    })
  }

  /**
   * #1090 — the filter row.
   *
   * - The two filter buttons render only when there is something to filter BY
   *   (an orphan exists) or the orphan filter is ON. Rendered whenever something
   *   was selected, a lone *All (N)* read as part of the selection bar, and
   *   pressing it — the filter already in force — cleared the selection.
   * - The filter stays on screen while it is ON, even at zero: deleting every
   *   unlinked participant through it used to remove the buttons and leave an
   *   empty table with no way back to *All* (measured, before this fix).
   * - Choosing a filter no longer clears the selection: since #1072 every act
   *   reads the checked rows that are SHOWN, so the clear bought nothing and cost
   *   the selection. Re-choosing the filter in force does nothing.
   * - Two acts unmount the control that was pressed — *Clear* (the bar goes with
   *   the selection) and *All* once no orphan is left (the buttons go) — so each
   *   hands focus to the control that stays: select-all, and the search box.
   */
  const filterAvailable = orphanCount > 0 || showOrphansOnly
  const selectAllRef = useRef<HTMLButtonElement>(null)
  const chooseFilter = (orphansOnly: boolean) => {
    if (orphansOnly === showOrphansOnly) return
    setShowOrphansOnly(orphansOnly)
    setShownLimit(PARTICIPANT_LIST_LIMIT)
    if (!orphansOnly && orphanCount === 0) searchRef.current?.focus()
  }
  const clearSelection = () => {
    setSelectedIds(new Set())
    selectAllRef.current?.focus()
  }

  /**
   * #963 — ONE gate for both non-ready states.
   *
   * The hand-written line this replaces covered only `isLoading`, and React
   * Query v5 reports that `false` once a failure has SETTLED — so a failed load
   * fell straight through to "No participants yet" with the import affordance
   * beside it. Driven on the running app: the page said that while the nav rail
   * next to it still showed the real count from another query.
   *
   * `LoadState` is also what gives this wait a `role="status"`, the shared
   * slow-load hint and, on a failure, a Retry (`components/LoadStatus.tsx`).
   */
  if (participantsLoad.status !== 'ready') {
    return (
      <div className="h-full overflow-auto p-8">
        <LoadState
          load={participantsLoad}
          loadingLabel="Loading participants…"
          failedTitle="Your participants could not be loaded."
          landingRef={mainLanding}
        />
      </div>
    )
  }

  const selectedParticipant = selectedParticipantId === null
    ? null
    : participants.find((p) => p.id === selectedParticipantId) ?? null

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        {/* Back link */}
        <Link
          to={`/projects/${projectId}/overview`}
          className="inline-flex items-center gap-1.5 text-sm text-mm-text-muted hover:text-mm-text transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Overview
        </Link>

        {/* Header + Add button */}
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-mm-text">
            Participants
            {/* #908's rule: the space is a text node in the HEADING's own child
                list — a margin is not a space, so the name computed as
                "Participants(250)" (a11y-name-sweep run 9). */}
            {participants.length > 0 && (
              <>{' '}<span className="text-mm-text-muted font-normal ml-1">({participants.length.toLocaleString()})</span></>
            )}
          </h1>
          <Button onClick={() => setIsAddingParticipant(true)} size="sm" className="shrink-0">
            <Plus className="w-4 h-4 mr-1.5" />
            Add Participant
          </Button>
        </div>

        {/* Add participant form */}
        {isAddingParticipant && (
          <div className="bg-mm-surface border border-mm-border-subtle rounded-lg p-4 space-y-4">
            <h3 className="font-medium text-mm-text">New Participant</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-mm-text-secondary mb-1 block">Name *</label>
                <Input
                  value={newParticipantName}
                  onChange={(e) => {
                    setNewParticipantName(e.target.value)
                    setDuplicateConfirmed(false)
                  }}
                  placeholder="Participant name"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm font-medium text-mm-text-secondary mb-1 block">Role</label>
                <Input
                  value={newParticipantRole}
                  onChange={(e) => setNewParticipantRole(e.target.value)}
                  placeholder="e.g. board, staff"
                />
              </div>
            </div>
            {/* Duplicate warning */}
            {(() => {
              const trimmed = newParticipantName.trim().toLowerCase()
              const match = trimmed && participants.find(
                p => (p.display_name || p.identifier).toLowerCase() === trimmed
              )
              if (match && !duplicateConfirmed) {
                const convNames = match.linked_speakers.flatMap(s => s.conversations.map(c => c.name))
                const uniqueConvs = [...new Set(convNames)]
                return (
                  <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg dark:bg-amber-950/30 dark:border-amber-800">
                    <CircleAlert className="w-4 h-4 flex-shrink-0 text-amber-600" />
                    <p className="text-sm text-amber-800 dark:text-amber-200 flex-1">
                      Matches existing participant "<strong>{match.display_name || match.identifier}</strong>"
                      {uniqueConvs.length > 0 && <> (in {uniqueConvs.join(', ')})</>}
                      . If this is a different person, use a different name or click proceed.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setDuplicateConfirmed(true)}
                    >
                      Different person, proceed
                    </Button>
                  </div>
                )
              }
              return null
            })()}
            {createParticipantMutation.isError && (
              <p className="text-sm text-red-600">
                {/* `serverDetailMessage`, never the raw `detail`: since #1190 a 409 can
                    carry an OBJECT detail, which React cannot render. */}
                {serverDetailMessage(createParticipantMutation.error) ?? 'Failed to create participant'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => {
                setIsAddingParticipant(false)
                setNewParticipantName('')
                setNewParticipantRole('')
                setDuplicateConfirmed(false)
              }}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const name = newParticipantName.trim()
                  const data: { identifier: string; display_name: string; role?: string } = {
                    identifier: name,
                    display_name: name,
                  }
                  if (newParticipantRole.trim()) data.role = newParticipantRole.trim()
                  // The busy guard (#754): `aria-disabled` below announces, this refuses.
                  if (createParticipantMutation.isPending) return
                  createParticipantMutation.mutate(data)
                }}
                disabled={
                  !newParticipantName.trim() ||
                  (!!newParticipantName.trim() && !!participants.find(
                    p => (p.display_name || p.identifier).toLowerCase() === newParticipantName.trim().toLowerCase()
                  ) && !duplicateConfirmed)
                }
                // #1190 (D12) — BUSY is `aria-disabled`, never `disabled` (#959/#965):
                // the withdrawn-ID confirm opens mid-request, and a blurred button
                // left it no opener to return focus to.
                aria-disabled={createParticipantMutation.isPending || undefined}
                aria-busy={createParticipantMutation.isPending || undefined}
              >
                {createParticipantMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {participants.length === 0 && !isAddingParticipant ? (
          <div className="text-center py-16 bg-mm-surface rounded-lg border border-mm-border-subtle">
            <Users className="w-12 h-12 mx-auto text-mm-text-faint mb-4" />
            <h3 className="text-lg font-medium text-mm-text mb-2">No participants yet</h3>
            <p className="text-mm-text-muted mb-4">
              When you import a conversation, a participant is created for each non-facilitator speaker. You can also add participants manually.
            </p>
            <Button onClick={() => setIsAddingParticipant(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Participant
            </Button>
          </div>
        ) : participants.length > 0 && (
          <div className="@container/participants space-y-3">
            {/* #1052 — what reaches a participant the bounded table does not
                show. Named for what it matches (#1008: a bare "Search…" was
                read as searching more than it did); the wording is shared
                with the two participant pickers (#1092). */}
            <div className="relative max-w-xs">
              <Search
                className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-mm-text-muted"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                value={search}
                onChange={(e) => changeSearch(e.target.value)}
                placeholder={PARTICIPANT_SEARCH_PLACEHOLDER}
                aria-label={PARTICIPANT_SEARCH_LABEL}
                className="pl-8 h-8 text-sm"
              />
            </div>
            {/* Orphan filter + bulk actions (#1090 — see `filterAvailable`). */}
            {(filterAvailable || selectedCount > 0) && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                {filterAvailable && (
                  <div className="flex items-center gap-1.5" role="group" aria-label="Show participants">
                    {/* a11y-name-sweep run 10: which filter is on was shown by
                        colour alone; `aria-pressed` says it to a screen reader. */}
                    <button
                      type="button"
                      onClick={() => chooseFilter(false)}
                      aria-pressed={!showOrphansOnly}
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                        !showOrphansOnly
                          ? 'bg-mm-text text-mm-bg border-mm-text'
                          : 'border-mm-border-subtle text-mm-text-muted hover:text-mm-text'
                      }`}
                    >
                      All ({participants.length.toLocaleString()})
                    </button>
                    <button
                      type="button"
                      onClick={() => chooseFilter(true)}
                      aria-pressed={showOrphansOnly}
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                        showOrphansOnly
                          ? 'bg-mm-text text-mm-bg border-mm-text'
                          : 'border-mm-border-subtle text-mm-text-muted hover:text-mm-text'
                      }`}
                      title={NO_LINKED_SOURCES_TITLE}
                    >
                      No linked sources ({orphanCount.toLocaleString()})
                    </button>
                  </div>
                )}
                {selectedCount > 0 && (
                  <div className="flex items-center gap-2 ml-auto">
                    <span className="text-sm text-mm-text-muted">{selectedCount.toLocaleString()} selected</span>
                    <Button size="sm" variant="ghost" onClick={clearSelection}>
                      Clear
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setBulkDeleteOpen(true)}
                      disabled={bulkDeleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 mr-1.5" />
                      {bulkDeleteMutation.isPending ? 'Deleting...' : 'Delete selected'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          <div className={DETAIL_LAYOUT}>
            {/* Table — #1088: it scrolls in its own box (the house rule for a
                table that can be wider than its column), so a long name or a
                narrow window scrolls the table, never the page. */}
            <div className="bg-mm-surface rounded-lg border border-mm-border-subtle min-w-0 flex-1 overflow-hidden">
              <ScrollableTable maxHeight="70vh">
              <table className="w-full">
                <caption className="sr-only">Participants with their role and what each is linked to: conversations, dataset records and documents.</caption>
                <thead className="bg-mm-bg sticky top-0 z-10">
                  <tr>
                    <th scope="col" className="px-3 py-3 w-10">
                      <Checkbox
                        ref={selectAllRef}
                        checked={allVisibleSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                        onCheckedChange={toggleSelectAll}
                        // #1165 — with no row shown it read "Select the 0
                        // participants shown" and did nothing. Natively disabled:
                        // a search that matches no one is a passing state, so it
                        // earns no tab stop (`mode-disabled.ts`'s transient arm).
                        disabled={renderedParticipants.length === 0}
                        // a11y-name-sweep run 10: "all" only when the table shows
                        // everyone. A search or the filter that leaves the rest
                        // unshown is not the page's cap (`hiddenCount`), and the
                        // box still selects only the rows on screen.
                        aria-label={renderedParticipants.length === 0
                          ? 'Select participants (none are shown)'
                          : renderedParticipants.length < participants.length
                            ? `Select the ${renderedParticipants.length.toLocaleString()} participant${renderedParticipants.length === 1 ? '' : 's'} shown`
                            : 'Select all participants'}
                      />
                    </th>
                    {/* A floor for the Name column: the names may wrap (a long
                        identifier must not hold the table wider than its box),
                        and without one the table squeezed "P004" onto two lines
                        beside an open panel (measured at 1280). */}
                    <th scope="col" className="px-3 py-3 text-left text-sm font-medium text-mm-text-secondary min-w-[9rem]">Name</th>
                    <th scope="col" className="px-3 py-3 text-left text-sm font-medium text-mm-text-secondary">Role</th>
                    <th scope="col" className="px-3 py-3 text-left text-sm font-medium text-mm-text-secondary">Linked to</th>
                    <th scope="col" className="px-3 py-3 text-right text-sm font-medium text-mm-text-secondary w-24">Actions</th>
                  </tr>
                </thead>
                <tbody ref={tableBodyRef} className="divide-y divide-mm-border-subtle">
                  {visibleParticipants.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-sm text-mm-text-muted">
                        {search.trim()
                          ? noParticipantsMatch(search)
                          : 'No participants without linked sources.'}
                      </td>
                    </tr>
                  )}
                  {renderedParticipants.map((participant) => (
                    <ParticipantRow
                      key={participant.id}
                      participant={participant}
                      checked={selectedIds.has(participant.id)}
                      onToggleChecked={() => setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(participant.id)) next.delete(participant.id)
                        else next.add(participant.id)
                        return next
                      })}
                      isSelected={selectedParticipantId === participant.id}
                      onSelect={(viaKeyboard) => {
                        if (selectedParticipantId === participant.id) closePanel()
                        else openPanel(participant.id, viaKeyboard)
                      }}
                      onUpdate={(data) => updateParticipantMutation.mutate({ participantId: participant.id, data })}
                      onWithdraw={() => {
                        const target = confirmTarget(participant)
                        setWithdrawParticipant(target)
                        setWithdrawShown(target)
                      }}
                      onDelete={() => {
                        const target = confirmTarget(participant)
                        setDeleteParticipant(target)
                        setDeleteShown(target)
                      }}
                    />
                  ))}
                </tbody>
              </table>
              </ScrollableTable>
              {/* #1052 — the table stops early, and says so. */}
              {tableNote && (
                <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-t border-mm-border-subtle">
                  <p className="text-sm text-mm-text-muted">
                    {tableNote}.{search.trim() ? '' : ' Search to find a particular person.'}
                  </p>
                  <Button size="sm" variant="outline" onClick={showMore}>
                    Show {Math.min(PARTICIPANT_LIST_LIMIT, hiddenCount).toLocaleString()} more
                  </Button>
                </div>
              )}
            </div>

            {/* Detail panel — keyed, so switching participants starts it afresh:
                a half-made link to one person's dataset record must not carry
                over to the next person's panel. */}
            {selectedParticipantId !== null && (
              <ParticipantDetailPanel
                key={selectedParticipantId}
                panelRef={panelRef}
                participantId={selectedParticipantId}
                fallbackName={selectedParticipant
                  ? (selectedParticipant.display_name || selectedParticipant.identifier)
                  : null}
                takeFocus={panelTakesFocus}
                projectId={projectId}
                datasets={datasets}
                onClose={closePanel}
              />
            )}
          </div>
          </div>
        )}
      </div>

      {/* Delete confirm.
          #1139 — capped at the window (a few more source lines put its title and
          buttons off a 640×360 window), titled with the person, and the list of
          what stays is in `details`: as `children` it sat OUTSIDE the accessible
          description, so a reader heard the sentence and then "Cancel" (#955 d).
          #1152 — the report is this opening's own (`useConfirmReport`); until it
          answers the sentence is the count-free form, the shared loading line
          says it is checking, and Delete refuses. */}
      <ConfirmDialog
        open={deleteParticipant !== null}
        onOpenChange={(open) => { if (!open) setDeleteParticipant(null) }}
        title={deleteConfirmTitle(deleteShown ?? NO_ONE)}
        description={describeDeleteConsequence(deleteConfirm.report)}
        details={deleteConfirm.report === null ? (
          <LoadState
            load={deleteConfirm.load}
            size="panel"
            loadingLabel="Checking what would be removed…"
            failedTitle="What would be removed could not be checked."
          />
        ) : deleteLocations.length > 0 ? (
          <div className="text-xs text-mm-text-secondary">
            <p className="text-mm-text-faint mb-1">
              Data that stays in the project:
            </p>
            <ul className="space-y-0.5">
              {deleteLocations.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : undefined}
        confirmLabel="Delete record"
        confirmWaiting={deleteConfirm.report === null}
        fitViewport
        onConfirm={() => {
          if (deleteParticipant !== null) {
            deleteParticipantMutation.mutate(deleteParticipant.id)
          }
          setDeleteParticipant(null)
        }}
        destructive
      />

      {/* #1190 (D12) — at PAGE level: *Add Participant*'s create and a row's rename both
          ask through it, and the rename's row closes its editor before the answer. */}
      {withdrawnDialog}

      {/* #702(3) — honour a withdrawal request. */}
      <WithdrawParticipantDialog
        open={withdrawParticipant !== null}
        participant={withdrawShown ?? NO_ONE}
        report={withdrawConfirm.report}
        reportLoad={withdrawConfirm.load}
        isPending={withdrawMutation.isPending}
        onCancel={() => setWithdrawParticipant(null)}
        onConfirm={() => {
          if (withdrawParticipant) withdrawMutation.mutate(withdrawParticipant)
        }}
      />

      {/* Bulk delete confirm — capped too (#1139): its names stop at three, but
          the sentence is long and the window may be short. */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => { if (!open) setBulkDeleteOpen(false) }}
        title={`Delete ${selectedCount} participant${selectedCount === 1 ? '' : 's'}`}
        description={bulkDeleteDescription(selectedCount, selectedNames, selectedDocumentCount)}
        confirmLabel="Delete"
        fitViewport
        onConfirm={() => {
          bulkDeleteMutation.mutate(selectedShownIds)
          setBulkDeleteOpen(false)
        }}
        destructive
      />
    </div>
  )
}

// ── Participant table row ──────────────────────────────────────────────

/** #1110 — everything a participant is linked to, in one cell. */
function linkedSources(participant: Participant) {
  return [
    ...[...new Set(participant.linked_speakers.flatMap(s => s.conversations.map(c => c.name)))]
      .map(name => ({ kind: 'Conversation', name, Icon: MessageSquare })),
    ...[...new Set(participant.dataset_rows.map(d => d.dataset_name))]
      .map(name => ({ kind: 'Dataset', name, Icon: Table2 })),
    ...participant.linked_documents
      .map(d => ({ kind: 'Document', name: d.name, Icon: FileText })),
  ]
}

function ParticipantRow({
  participant,
  onUpdate,
  onDelete,
  onWithdraw,
  isSelected,
  onSelect,
  checked = false,
  onToggleChecked,
}: {
  participant: Participant
  onUpdate: (data: { identifier?: string; display_name?: string; role?: string }) => void
  onDelete: () => void
  onWithdraw: () => void
  isSelected?: boolean
  /** `viaKeyboard` decides whether the opened panel takes focus (#1091). */
  onSelect?: (viaKeyboard: boolean) => void
  checked?: boolean
  onToggleChecked?: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(participant.display_name || participant.identifier)
  const [editRole, setEditRole] = useState(participant.role || '')

  const rawName = participant.display_name || participant.identifier
  const currentName = rawName
  // #396: unnamed participants (no name, or an imported "..." placeholder)
  // render a clear label instead of literal dots.
  const isUnnamed = isUnnamedLabel(rawName)
  const displayName = isUnnamed ? UNNAMED_LABEL : rawName

  const handleSave = () => {
    const data: { identifier?: string; display_name?: string; role?: string } = {}
    const trimmedName = editName.trim()
    if (trimmedName && trimmedName !== currentName) {
      data.display_name = trimmedName
      data.identifier = trimmedName
    }
    if (editRole.trim() !== (participant.role || '')) data.role = editRole.trim() || undefined
    if (Object.keys(data).length > 0) onUpdate(data)
    setIsEditing(false)
  }

  const handleCancel = () => {
    setEditName(currentName)
    setEditRole(participant.role || '')
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSave() }
    // Marked handled, so the open detail panel (which closes on an unhandled
    // Escape) stays open while an edit is cancelled (#1091).
    else if (e.key === 'Escape') { e.preventDefault(); handleCancel() }
  }

  const sources = linkedSources(participant)

  // #353: keyboard activation for the (now-expandable) row. Enter/Space
  // toggles the detail panel exactly like a click. The whole row stays a
  // semantic <tr> — only adds tabIndex + aria-expanded; no role override
  // that would break table semantics in screen readers.
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (isEditing) return  // don't intercept while inline-editing the name
    // Don't fire when focus is inside an interactive child (checkbox, button)
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect?.(true)
    }
  }

  return (
    <tr
      // #1052 — "Show more" moves focus to the first row it revealed.
      data-participant-row=""
      // #1091 — closing the detail panel returns focus to this row.
      data-participant-id={participant.id}
      className={`hover:bg-mm-surface-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${isSelected ? SELECTED_ROW : ''}`}
      onClick={() => onSelect?.(false)}
      // #353 — keyboard + screen-reader affordance for row expansion
      tabIndex={0}
      aria-expanded={isSelected}
      aria-controls={isSelected ? DETAIL_PANEL_ID : undefined}
      onKeyDown={handleRowKeyDown}
    >
      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleChecked?.()}
          aria-label={`Select ${displayName}`}
        />
      </td>
      <td className="px-3 py-3 text-sm text-mm-text">
        <div className="flex items-center gap-2">
          {/* #353: chevron affordance — rotates to indicate the detail
            * panel state. aria-hidden because the <tr>'s aria-expanded
            * carries the semantic. transition-transform so reduced-motion
            * users get the global media-query suppression. */}
          <ChevronRight
            className={`w-3.5 h-3.5 text-mm-text-muted shrink-0 transition-transform ${isSelected ? 'rotate-90' : ''}`}
            aria-hidden
          />
          {participant.linked_speakers.length > 0 && (() => {
            const s = participant.linked_speakers[0]
            return (
              <span
                className={`w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center ring-1 shrink-0 ${
                  s.color ? 'ring-black/10 dark:ring-white/20' : getInitialsBadgeColors(s.is_facilitator)
                }`}
                style={s.color ? { backgroundColor: s.color, color: getContrastColor(s.color) } : undefined}
                title={s.speaker_name}
                aria-hidden="true"
              >
                {getSpeakerInitials(currentName)}
              </span>
            )
          })()}
          {isEditing ? (
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={handleKeyDown} className="h-8 text-sm" autoFocus onClick={(e) => e.stopPropagation()} aria-label={`Name for ${rawName}`} />
          ) : (
            // #1088 — `anywhere`, not `break-word`: only `anywhere` lowers the
            // cell's MIN width, so a 30-character identifier with no space wraps
            // instead of holding the table 85px wider than its box at 640×360
            // (measured: the Name column held at 280px).
            <span className={`min-w-0 [overflow-wrap:anywhere] ${isUnnamed ? 'text-mm-text-faint italic' : ''}`}>{displayName}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-3 text-sm text-mm-text">
        {isEditing ? (
          <Input value={editRole} onChange={(e) => setEditRole(e.target.value)} onKeyDown={handleKeyDown} className="h-8 text-sm" placeholder="Role" onClick={(e) => e.stopPropagation()} aria-label={`Role for ${rawName}`} />
        ) : (
          <span className={participant.role ? '[overflow-wrap:anywhere]' : 'text-mm-text-faint italic'}>{participant.role || '-'}</span>
        )}
      </td>
      <td className="px-3 py-3 text-sm text-mm-text-secondary">
        {/* #1110 — conversations, dataset records AND documents. The page
            listed conversation names and a dataset count, and nothing about
            a document, so the subject of a workplan read as linked to
            nothing. The kind is an icon for the eye and a word for the ear. */}
        {sources.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
            {sources.map(({ kind, name, Icon }, i) => (
              <li key={`${kind}-${name}-${i}`} className="inline-flex items-center gap-1 min-w-0">
                <Icon className="w-3.5 h-3.5 shrink-0 text-mm-text-muted" aria-hidden="true" />
                <span className="sr-only">{`${kind}: `}</span>
                <span className="[overflow-wrap:anywhere]">{name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-mm-text-faint italic" title={NO_LINKED_SOURCES_TITLE}>No linked sources</span>
        )}
      </td>
      <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {isEditing ? (
            <>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleSave} aria-label="Save">
                <Check className="w-4 h-4 text-green-600" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={handleCancel} aria-label="Cancel">
                <X className="w-4 h-4 text-mm-text-muted" />
              </Button>
            </>
          ) : (
            <>
              {/*
                🔴 #891: each of these NAMES THE PARTICIPANT, because the row does not.
                Measured in Chrome's tree: 30 rows × these three, every one announcing the
                same words, and the Name cell is a plain <td> — so unlike the dataset grid
                (whose first cell is a `<th scope="row">`, which is what makes its 48
                identical "Link..." buttons legible) nothing here carries the row. The
                withdrawal button is irreversible and was one of thirty identically-named
                controls. #785's rule: the NAME must carry the row. `title` stays for the
                sighted hover; it is a last-resort naming route, not the name.
              */}
              <Button size="icon" variant="ghost" className="h-8 w-8 text-mm-text-secondary hover:text-mm-text" onClick={() => setIsEditing(true)} aria-label={`Edit ${rawName}`} title="Edit participant">
                <Pencil className="w-4 h-4" aria-hidden />
              </Button>
              {/*
                #702(3) — distinct from Delete on purpose. Delete removes the
                record and leaves everything else (right for tidying an orphan,
                wrong for a withdrawal request); this removes their data.
              */}
              <Button size="icon" variant="ghost" className="h-8 w-8 text-mm-text-faint hover:text-destructive" onClick={onWithdraw} aria-label={`Remove ${rawName}'s data (withdrawal request)`} title="Remove this participant's data (withdrawal request)">
                <UserMinus className="w-4 h-4" aria-hidden />
              </Button>
              {/* #1648: "…record only" stopped being exact when a delete also took the person
                  off a joint display's lists of cases that don't fit (D314); what stays true, and
                  what the name must keep beside the withdrawal button, is that their DATA stays. */}
              <Button size="icon" variant="ghost" className="h-8 w-8 text-mm-text-faint hover:text-destructive" onClick={onDelete} aria-label={`Delete ${rawName}'s participant record but keep their data`} title="Delete participant record but keep their data">
                <Trash2 className="w-4 h-4" aria-hidden />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Participant detail side panel ──────────────────────────────────────

function ParticipantDetailPanel({
  panelRef,
  participantId,
  fallbackName,
  takeFocus,
  projectId,
  datasets,
  onClose,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>
  participantId: number
  /** The list's name for them, so the heading exists before the detail loads. */
  fallbackName: string | null
  /** Opened from the keyboard — move focus into the panel (#1091). */
  takeFocus: boolean
  projectId: number
  datasets: Dataset[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [linkingDatasetId, setLinkingDatasetId] = useState<number | null>(null)
  /** #1053 — a refused link's sentence, shown in the picker (it used to be the
   *  app-wide "Something went wrong", hiding the server's reason). */
  const [linkError, setLinkError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const linkSelectRef = useRef<HTMLSelectElement>(null)

  // #1608 — while blind the profile leaves the participant table's rating columns out
  // (they combine every coder's ratings). The scope rides the key; the read waits for it.
  const { coderScope, scopeReady } = useBlindScope(projectId)
  const detailQuery = useQuery({
    queryKey: ['participant-detail', participantId, coderScope ?? 'every-coder'],
    enabled: scopeReady,
    queryFn: () => participantsApi.getDetail(projectId, participantId, coderScope),
    // #1152 — asked again on every OPEN. It is keyed per participant and this
    // panel mounts when it opens, so 'always' does fire here (unlike on the page's
    // confirm queries, which never remount); without it a panel re-opened inside
    // the 60 s staleTime showed what it cached before a door it never hears of
    // (a document's subject, a delete elsewhere) moved the person's links.
    refetchOnMount: 'always',
  })
  const detail = detailQuery.data
  /** #963 — a failed load said "Loading..." for as long as the panel was open. */
  const detailLoad = useListLoad(detailQuery)

  // #1091 — on open: the keyboard's focus comes here; a stacked panel (below
  // 960px it sits under the table box) is scrolled into view for the pointer.
  // A side-by-side panel is sticky and already in view, so it is left alone.
  useEffect(() => {
    if (takeFocus) {
      headingRef.current?.focus()
      return
    }
    const panel = panelRef.current
    if (panel && getComputedStyle(panel).position !== 'sticky') {
      panel.scrollIntoView?.({ block: 'nearest' })
    }
    // Once per participant: the panel is keyed on it, and both inputs are
    // fixed for the life of one panel.
  }, [takeFocus, panelRef])

  /**
   * #1130 — a link or an unlink unmounts the control that made it (the record
   * picker closes; the unlinked record's row goes), so a keyboard press left
   * focus on `<body>`. Land on the section's heading — but only when focus was
   * lost: focus that is somewhere real is never moved (#1091's rule).
   */
  const linkedHeadingRef = useRef<HTMLHeadingElement>(null)
  // 🔴 An EFFECT, run after the commit that removed the control — never a
  // guess about frames: driven live, a `requestAnimationFrame` landing raced
  // React's commit, saw the pressed control still there, and stood down.
  const [landingRequest, setLandingRequest] = useState(0)
  const landOnLinkedDatasets = () => setLandingRequest(n => n + 1)
  useEffect(() => {
    // Also runs on mount, harmlessly: the panel only opens from a row, so focus
    // is on that row or (by keyboard) on the h2 above, both real.
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    linkedHeadingRef.current?.focus()
  }, [landingRequest])

  // #1130 — the withdrawal summary below is a list of what is LINKED; a link or
  // an unlink that did not refresh it left it naming the old set. The set is
  // shared by every link door since #1054 (it also refreshes the record picker,
  // which offered the just-linked record again). Resolves once the detail has
  // refetched — when an unlinked record's row, and the Unlink that was focused,
  // actually go.
  const invalidateAfterLinkChange = () => invalidateAfterParticipantLinkChange(queryClient, projectId)

  // 🔴 The two acts lose focus at DIFFERENT moments, so each lands when its own
  // control goes: a link unmounts the picker at once, an unlink's row goes only
  // when the detail refetch lands. Driven live, a one-frame landing after an
  // unlink saw the Unlink still there, stood down, and focus then fell to <body>.
  const linkMutation = useMutation({
    mutationFn: ({ datasetId, row }: { datasetId: number; row: LinkableRow; datasetName: string }) =>
      participantsApi.linkDatasetRow(projectId, participantId, datasetId, row.row_id),
    onMutate: () => setLinkError(null),
    onSuccess: (_data, { row, datasetName }) => {
      void invalidateAfterLinkChange()
      setLinkingDatasetId(null)
      landOnLinkedDatasets()
      toast.success(`Linked ${row.row_identifier || `row ${row.row_id}`} in ${datasetName}`)
    },
    // #1053 §3.3 — the server's sentence (a record someone else took a moment
    // ago, a table the tool keeps), never the app-wide "Something went wrong".
    // The picker is refreshed, so a record that was taken now shows as taken.
    onError: (err, { datasetId }) => {
      setLinkError(
        (isServerRefusal(err) ? serverDetailMessage(err) : null)
          ?? 'The record could not be linked. Try again.',
      )
      void queryClient.invalidateQueries({ queryKey: ['linkable-rows', projectId, datasetId] })
    },
  })

  const unlinkMutation = useMutation({
    mutationFn: (rowId: number) =>
      participantsApi.unlinkDatasetRow(projectId, participantId, rowId),
    onSuccess: () => {
      void invalidateAfterLinkChange().then(landOnLinkedDatasets)
    },
  })

  /**
   * Close on Escape — but only an Escape nothing else took. A dialog opened from
   * the page (withdraw, delete) handles its own Escape and marks it, and closing
   * that dialog used to close this panel behind it as well (#784/#1041's
   * stand-down, measured before this fix).
   */
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const stopLinking = () => {
    setLinkingDatasetId(null)
    setLinkError(null)
    // The picker's own controls unmount; its opener stays.
    requestAnimationFrame(() => linkSelectRef.current?.focus())
  }

  const rawName = detail ? (detail.display_name || detail.identifier) : (fallbackName ?? '')
  const isUnnamed = isUnnamedLabel(rawName)  // #396
  const currentName = isUnnamed ? UNNAMED_LABEL : rawName

  return (
    <div
      ref={panelRef}
      id={DETAIL_PANEL_ID}
      className={DETAIL_PANEL}
      role="complementary"
      aria-label="Participant details"
    >
      {/* Header — the panel's heading is h2 under the page's h1, and the focus
          target when the keyboard opens it. */}
      <div className="p-4 border-b border-mm-border-subtle flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            ref={headingRef}
            tabIndex={-1}
            // A keyboard open lands here, so it shows where focus went (the
            // house ring; `outline-none` alone left the landing invisible).
            className={`font-medium text-sm truncate rounded-sm ${FOCUS_RING} ${isUnnamed ? 'text-mm-text-faint italic' : 'text-mm-text'}`}
            title={currentName}
          >
            {currentName}
          </h2>
          {detail && <p className="text-xs text-mm-text-faint">{detail.identifier}</p>}
          {detail?.role && (
            <p className="text-xs text-mm-text-secondary mt-0.5">
              {detail.role}
              {detail.role_auto_filled_from && (
                <span className="text-mm-text-faint ml-1">(from {detail.role_auto_filled_from})</span>
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center w-6 h-6 rounded shrink-0 text-mm-text-faint hover:text-mm-text-secondary"
          aria-label="Close participant details"
          title="Close"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {!detail ? (
        <LoadState
          load={detailLoad}
          loadingLabel="Loading participant…"
          failedTitle="This participant could not be loaded."
          size="panel"
        />
      ) : (
      <>
      {/* Speakers & Conversations */}
      {detail.linked_speakers.length > 0 && (
        <div className="p-4 border-b border-mm-border-subtle">
          <h3 className="text-xs font-medium text-mm-text-muted mb-2">Speakers</h3>
          <div className="space-y-2">
            {detail.linked_speakers.map(s => (
              <div key={s.speaker_id} className="flex items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={`w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center ring-1 shrink-0 cursor-pointer hover:ring-2 transition-all ${
                        s.color ? 'ring-black/10 dark:ring-white/20' : getInitialsBadgeColors(s.is_facilitator)
                      }`}
                      style={s.color ? { backgroundColor: s.color, color: getContrastColor(s.color) } : undefined}
                      // #1124 — its name was its initials ("P0").
                      aria-label={`Change ${s.speaker_name}'s color`}
                      title="Change color"
                    >
                      <span aria-hidden="true">{getSpeakerInitials(s.speaker_name)}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-3" align="start" aria-label="Speaker color">
                    <ColorSwatchPicker
                      value={s.color || ''}
                      onChange={(color: string) => {
                        speakersApi.updateColor(Number(projectId), s.speaker_id, color || null).then(() => {
                          queryClient.invalidateQueries({ queryKey: ['participant-detail', participantId] })
                          queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
                          queryClient.invalidateQueries({ queryKey: ['speakers', projectId] })
                        })
                      }}
                    />
                  </PopoverContent>
                </Popover>
                <div className="min-w-0">
                  <p className="text-xs text-mm-text">{s.speaker_name}</p>
                  {s.conversations.length > 0 && (
                    <p className="text-[10px] text-mm-text-faint truncate" title={s.conversations.map(c => c.name).join(', ')}>
                      {s.conversations.map((c, i) => (
                        <span key={c.id}>
                          {i > 0 && ', '}
                          <Link
                            to={`/projects/${projectId}/conversations/${c.id}`}
                            className="hover:text-mm-blue-text hover:underline"
                            title={`Open conversation "${c.name}"`}
                          >
                            {c.name}
                          </Link>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* #1110 — the documents this participant is the subject of. The panel
          listed speakers and dataset records and had no word for a document,
          so its subject looked linked to nothing at all. Changing the subject
          stays on the document ("Who is this document about?"). */}
      {detail.linked_documents.length > 0 && (
        <div className="p-4 border-b border-mm-border-subtle">
          <h3 className="text-xs font-medium text-mm-text-muted mb-2">Documents about them</h3>
          <ul className="space-y-1">
            {detail.linked_documents.map(d => (
              <li key={d.id}>
                <Link
                  to={`/projects/${projectId}/documents/${d.id}`}
                  className="group/doclink inline-flex items-center gap-1 min-w-0 text-xs text-mm-text hover:text-mm-blue-text"
                  title={`Open document "${d.name}"`}
                >
                  <FileText className="w-3 h-3 shrink-0 text-mm-text-muted" aria-hidden="true" />
                  <span className="truncate group-hover/doclink:underline">{d.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Linked datasets */}
      <div className="p-4 border-b border-mm-border-subtle">
        {/* #1130 — the landing after a link or an unlink (`tabIndex -1`, the
            house ring, like the panel's own heading). */}
        <h3
          ref={linkedHeadingRef}
          tabIndex={-1}
          className={`text-xs font-medium text-mm-text-muted mb-2 rounded-sm ${FOCUS_RING}`}
        >
          Linked Datasets
        </h3>
        {detail.dataset_rows.length === 0 ? (
          <p className="text-xs text-mm-text-faint italic">No linked datasets</p>
        ) : (
          <div className="space-y-3">
            {detail.dataset_rows.map(dr => {
              const demos = detail.linked_demographics.filter(d => d.dataset_id === dr.dataset_id)
              const record = dr.row_identifier ?? 'record'
              return (
                <div key={dr.id} className="bg-mm-bg rounded p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/projects/${projectId}/datasets/${dr.dataset_id}`}
                        className="group/dslink flex items-center gap-1 min-w-0 text-xs font-medium text-mm-text hover:text-mm-blue-text"
                        title={`Open dataset "${dr.dataset_name}"`}
                      >
                        <span className="truncate group-hover/dslink:underline">{dr.dataset_name}</span>
                      </Link>
                      <p className="text-[11px] text-mm-text-faint" title={dr.row_identifier ?? undefined}>{dr.row_identifier}</p>
                    </div>
                    {/* #1157 — the participant table keeps its own links: an
                        unlink there only made the next refresh delete the row and
                        every value typed into it. The server says so (and refuses);
                        the panel shows that sentence instead of the control. */}
                    {dr.link_refusal === null && (
                    <button
                      type="button"
                      onClick={() => {
                        if (unlinkMutation.isPending) return
                        unlinkMutation.mutate(dr.id)
                      }}
                      // #1124 — "Unlink" alone, once per dataset, said neither
                      // which record nor which dataset; and its 12px icon in
                      // `p-0.5` was a 16px target (WCAG 2.5.8 asks 24).
                      className="inline-flex items-center justify-center w-6 h-6 rounded flex-shrink-0 text-mm-text-faint hover:text-red-500 aria-disabled:opacity-50"
                      aria-label={`Unlink ${record} in ${dr.dataset_name}`}
                      title="Unlink"
                      // #1130 — busy is `aria-disabled` + the guard above, never
                      // `disabled`: Chrome blurs a focused button that becomes
                      // disabled (#959 §4).
                      aria-disabled={unlinkMutation.isPending || undefined}
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                    )}
                  </div>
                  {dr.link_refusal !== null && (
                    <p className="mt-1 text-[11px] text-mm-text-muted leading-snug">{dr.link_refusal}</p>
                  )}
                  {demos.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {demos.map(d => {
                        // #353: type-aware value formatting. Numerics +
                        // percentages use tabular-nums for right-aligned
                        // monospaced digits. Multi-select renders as
                        // comma-separated chips. Demographic/ordinal/nominal
                        // and unknown types fall back to plain text.
                        const label = d.demographic_subtype
                          ? d.demographic_subtype.charAt(0).toUpperCase() + d.demographic_subtype.slice(1)
                          : (d.column_text || '').slice(0, 50)
                        const isNumeric = d.column_type === 'numeric' || d.column_type === 'percentage'
                        return (
                          <p key={d.column_id} className="text-[11px] text-mm-text-muted">
                            <span className="font-medium">{label}:</span>{' '}
                            {d.value
                              ? <span className={isNumeric ? 'tabular-nums' : ''}>
                                  {d.value}{d.column_type === 'percentage' && /^\d/.test(d.value) ? '%' : ''}
                                </span>
                              : <span className="italic">empty</span>}
                          </p>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Link to dataset row */}
        {!linkingDatasetId ? (
          (() => {
            const linkedDatasetIds = new Set(detail.dataset_rows.map(dr => dr.dataset_id))
            // #1157 — never a table the tool keeps in step with the participants:
            // its records link themselves at the next refresh, and the server
            // refuses a hand-made link (found live: offered after an unlink).
            const availableDatasets = datasets.filter(ds => !linkedDatasetIds.has(ds.id) && !ds.managed_kind)
            return availableDatasets.length > 0 && (
              <div className="mt-2">
                <select
                  ref={linkSelectRef}
                  value=""
                  onChange={(e) => {
                    const dsId = parseInt(e.target.value)
                    if (dsId) setLinkingDatasetId(dsId)
                  }}
                  // #1124 — a `<select>` with no label has NO name; the option
                  // it shows is its value.
                  aria-label={`Link ${currentName} to a dataset record`}
                  className="w-full text-xs border border-mm-border-subtle rounded px-2 py-1.5 bg-mm-surface text-mm-text-secondary"
                >
                  <option value="">+ Link to dataset...</option>
                  {availableDatasets.map(ds => (
                    <option key={ds.id} value={ds.id}>{ds.name}</option>
                  ))}
                </select>
              </div>
            )
          })()
        ) : (
          <DatasetRecordPicker
            projectId={projectId}
            datasetId={linkingDatasetId}
            datasetName={datasets.find(d => d.id === linkingDatasetId)?.name ?? 'this dataset'}
            busy={linkMutation.isPending}
            linkError={linkError}
            onPick={(row) => linkMutation.mutate({
              datasetId: linkingDatasetId,
              row,
              datasetName: datasets.find(d => d.id === linkingDatasetId)?.name ?? 'this dataset',
            })}
            onClose={stopLinking}
          />
        )}
      </div>

      {/* Demographics summary — scoped to actual DEMOGRAPHIC-typed columns
        * post-#353. Pre-fix this was the only place linked-row values
        * surfaced (the array contained only demographic columns); post-fix
        * the per-dataset section above shows ALL non-text values, so this
        * rolls up just the demographic subset as a cross-dataset profile.
        * Hidden when no demographic-typed columns exist (no point showing
        * an empty rollup of "all the columns are repeated below"). */}
      {(() => {
        const demoOnly = detail.linked_demographics.filter(d => d.column_type === 'demographic')
        if (demoOnly.length === 0) return null
        return (
        <div className="p-4">
          <h3 className="text-xs font-medium text-mm-text-muted mb-1">Demographics</h3>
          <div className="space-y-0.5">
            {(() => {
              const bySubtype = new Map<string, Array<{ value: string | null; dataset: string }>>()
              for (const d of demoOnly) {
                const key = d.demographic_subtype || d.column_text
                const arr = bySubtype.get(key) || []
                arr.push({ value: d.value, dataset: d.dataset_name })
                bySubtype.set(key, arr)
              }
              return [...bySubtype.entries()].map(([subtype, entries]) => {
                const uniqueValues = [...new Set(entries.filter(e => e.value).map(e => e.value))]
                const label = subtype.charAt(0).toUpperCase() + subtype.slice(1)
                if (uniqueValues.length === 0) return null
                if (uniqueValues.length === 1) {
                  return (
                    <p key={subtype} className="text-xs text-mm-text-secondary">
                      <span className="font-medium">{label}:</span> {uniqueValues[0]}
                    </p>
                  )
                }
                return (
                  <p key={subtype} className="text-xs text-mm-text-secondary">
                    <span className="font-medium">{label}:</span>{' '}
                    {entries.filter(e => e.value).map((e, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        {e.value} <span className="text-mm-text-faint">({e.dataset})</span>
                      </span>
                    ))}
                  </p>
                )
              })
            })()}
          </div>
        </div>
        )
      })()}

      {/*
        * #702(2) — what a withdrawal would actually involve.
        *
        * Deleting a participant removes ONE row: both links are SET NULL, so
        * the transcript, the speaker name and the responses all survive. That
        * is the identity spine working as designed — but it means the app had
        * no answer to "what would I have to remove?", and deleting the record
        * first DESTROYS the link that answers it.
        *
        * It lives in the detail panel rather than as a per-row control so it
        * costs no extra tab stop per participant (#771), and so it is reachable
        * without going anywhere near the delete button.
        */}
      <WithdrawalSection projectId={projectId} participantId={participantId} />
      </>
      )}
    </div>
  )
}

/** #702(2) — read-only: it changes nothing and can destroy nothing. */
function WithdrawalSection({
  projectId, participantId,
}: { projectId: number; participantId: number }) {
  const query = useQuery({
    queryKey: ['withdrawal-report', projectId, participantId],
    queryFn: () => participantsApi.withdrawalReport(projectId, participantId),
    // #1152 — asked again each time the panel opens, like its detail above.
    refetchOnMount: 'always',
  })
  const load = useListLoad(query)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const report = query.data
  // #1667 (D342) — a report that could not be read is SAID, never a section that vanishes: a
  // damaged canvas copy refuses it (409, the copy named) for every participant, and the
  // section — its headline, its locations, the scope note — went with nothing in its place
  // (`list-load-state.md` §7). While it LOADS it stays silent: the panel's detail above already
  // carries the one loading line (§6, one region, one `role="status"`).
  if (report === undefined && load.status !== 'failed' && !load.retrying) return null

  return (
    <div className="p-4 border-t border-mm-border-subtle">
      {/* The SAME element in both branches, so a successful Retry lands here (#955 b). */}
      <h3 ref={headingRef} tabIndex={-1}
        className={`text-xs font-medium text-mm-text-secondary mb-1 rounded-sm ${FOCUS_RING}`}>
        If this person withdraws
      </h3>
      {report === undefined ? (
        <LoadFailedNotice title={WITHDRAWAL_SECTION_FAILED_TITLE} load={load} size="panel"
          landingRef={headingRef} />
      ) : (
        <WithdrawalSectionBody report={report} />
      )}
    </div>
  )
}

function WithdrawalSectionBody({ report }: { report: WithdrawalReport }) {
  const locations = withdrawalLocations(report)
  return (
    <>
      <p className="text-xs text-mm-text-faint leading-snug">
        {withdrawalHeadline(report)}
      </p>
      {locations.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {locations.map(line => (
            <li key={line} className="text-xs text-mm-text-secondary">{line}</li>
          ))}
        </ul>
      )}
      {report.speaker_names.length > 0 && (
        <p className="mt-2 text-xs text-mm-text-faint leading-snug">
          The transcript carries their name as{' '}
          {report.speaker_names.map(n => `"${n}"`).join(' / ')}, which survives
          independently of this record.
        </p>
      )}
      {/* #1190 (D14) — records that carry their ID but are linked to no one. */}
      {unlinkedRecordsNote(report) && (
        <p className="mt-2 text-xs text-mm-text-faint leading-snug">{unlinkedRecordsNote(report)}.</p>
      )}
      {/* #1546 (D158) — canvas quotes the withdrawal would leave, and where. */}
      {unplacedCanvasQuotesNote(report) && (
        <p className="mt-2 text-xs text-mm-text-faint leading-snug">{unplacedCanvasQuotesNote(report)}.</p>
      )}
      <p className="mt-2 text-[11px] text-mm-text-faint leading-snug">
        {WITHDRAWAL_SCOPE_NOTE}
      </p>
    </>
  )
}
