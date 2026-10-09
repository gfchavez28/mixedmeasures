import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  PARTICIPANT_LIST_LIMIT, PARTICIPANT_SEARCH_LABEL, PARTICIPANT_SEARCH_PLACEHOLDER,
  noParticipantsMatch, searchParticipants, shownOfTotal,
} from '@/lib/participant-search'
import { Link } from 'react-router'
import { FOCUS_RING, SELECTED_ROW } from '@/lib/selection'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  ExternalLink,
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
  type Dataset, retryUnanswered} from '@/lib/api'
import { useListLoad } from '@/hooks/useListLoad'
import { useMainContentLanding } from '@/hooks/useMainContentLanding'
import { LoadState } from '@/components/LoadStatus'
import { toast } from 'sonner'
import { filterLinkableRows, linkableRowDetail } from '@/lib/linkable-rows'
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
  bulkDeleteDescription,
} from '@/lib/withdrawal-copy'
import WithdrawParticipantDialog from '@/components/WithdrawParticipantDialog'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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
  const [deleteParticipant, setDeleteParticipant] = useState<{ id: number; identifier: string } | null>(null)

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
  const createParticipantMutation = useMutation({
    mutationFn: (data: { identifier: string; display_name?: string; role?: string }) =>
      participantsApi.create(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setNewParticipantName('')
      setNewParticipantRole('')
      setDuplicateConfirmed(false)
      setIsAddingParticipant(false)
    },
  })

  const updateParticipantMutation = useMutation({
    mutationFn: ({ participantId, data }: { participantId: number; data: { identifier?: string; display_name?: string; role?: string } }) =>
      participantsApi.update(projectId, participantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      queryClient.invalidateQueries({ queryKey: ['speakers', projectId] })
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'segments' })
    },
  })

  const deleteParticipantMutation = useMutation({
    mutationFn: (participantId: number) => participantsApi.delete(projectId, participantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setSelectedParticipantId(null)
    },
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((pid) => participantsApi.delete(projectId, pid))
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      return { total: ids.length, failed }
    },
    onSuccess: ({ total, failed }) => {
      if (failed > 0) {
        toast.error(`Deleted ${total - failed} of ${total}; ${failed} could not be removed.`)
      } else {
        toast.success(`Deleted ${total} participant${total === 1 ? '' : 's'}.`)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      setSelectedIds(new Set())
      setSelectedParticipantId(null)
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
  const [withdrawParticipant, setWithdrawParticipant] = useState<
    { id: number; identifier: string } | null
  >(null)

  const { data: withdrawReport } = useQuery({
    queryKey: ['withdrawal-report', projectId, withdrawParticipant?.id],
    queryFn: () => participantsApi.withdrawalReport(projectId, withdrawParticipant!.id),
    enabled: withdrawParticipant !== null,
  })

  const withdrawMutation = useMutation({
    mutationFn: (participantId: number) =>
      participantsApi.withdraw(projectId, participantId),
    onSuccess: (res, participantId) => {
      void queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
      // Their turns and responses changed, so anything reading conversations or
      // datasets is now stale.
      void queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      void queryClient.invalidateQueries({ queryKey: ['dataset'] })
      // #1123 — and a document about them no longer says so.
      void queryClient.invalidateQueries({ queryKey: ['documents', projectId] })
      toast.success(
        `${res.identifier} removed. Backup saved as ${res.backup_filename}.`,
        {
          description: withdrawalDoneNote(res.documents_unlinked),
          duration: 12000,
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
  })

  const { data: pendingReport } = useQuery({
    queryKey: ['withdrawal-report', projectId, deleteParticipant?.id],
    queryFn: () => participantsApi.withdrawalReport(projectId, deleteParticipant!.id),
    enabled: deleteParticipant !== null,
  })

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
                {(createParticipantMutation.error as Error & { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed to create participant'}
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
                  createParticipantMutation.mutate(data)
                }}
                disabled={
                  !newParticipantName.trim() ||
                  createParticipantMutation.isPending ||
                  (!!newParticipantName.trim() && !!participants.find(
                    p => (p.display_name || p.identifier).toLowerCase() === newParticipantName.trim().toLowerCase()
                  ) && !duplicateConfirmed)
                }
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
                        // a11y-name-sweep run 10: "all" only when the table shows
                        // everyone. A search or the filter that leaves the rest
                        // unshown is not the page's cap (`hiddenCount`), and the
                        // box still selects only the rows on screen.
                        aria-label={renderedParticipants.length < participants.length
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
                      onWithdraw={() => setWithdrawParticipant({ id: participant.id, identifier: participant.identifier })}
                      onDelete={() => setDeleteParticipant({ id: participant.id, identifier: participant.identifier })}
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

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleteParticipant !== null}
        onOpenChange={(open) => { if (!open) setDeleteParticipant(null) }}
        title="Delete Participant"
        description={describeDeleteConsequence(pendingReport ?? null)}
        confirmLabel="Delete record"
        onConfirm={() => {
          if (deleteParticipant !== null) {
            deleteParticipantMutation.mutate(deleteParticipant.id)
          }
          setDeleteParticipant(null)
        }}
        destructive
      >
        {pendingReport && withdrawalLocations(pendingReport).length > 0 && (
          <div className="text-xs text-mm-text-secondary">
            <p className="text-mm-text-faint mb-1">
              Data that stays in the project:
            </p>
            <ul className="space-y-0.5">
              {withdrawalLocations(pendingReport).map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>

      {/* #702(3) — honour a withdrawal request. */}
      <WithdrawParticipantDialog
        open={withdrawParticipant !== null}
        identifier={withdrawParticipant?.identifier ?? ''}
        report={withdrawReport ?? null}
        isPending={withdrawMutation.isPending}
        onCancel={() => setWithdrawParticipant(null)}
        onConfirm={() => {
          if (withdrawParticipant) withdrawMutation.mutate(withdrawParticipant.id)
        }}
      />

      {/* Bulk delete confirm */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => { if (!open) setBulkDeleteOpen(false) }}
        title={`Delete ${selectedCount} participant${selectedCount === 1 ? '' : 's'}`}
        description={bulkDeleteDescription(selectedCount, selectedNames, selectedDocumentCount)}
        confirmLabel="Delete"
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
              <Button size="icon" variant="ghost" className="h-8 w-8 text-mm-text-faint hover:text-destructive" onClick={onDelete} aria-label={`Delete ${rawName}'s participant record only`} title="Delete participant record only">
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
  const [linkSearch, setLinkSearch] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const linkSelectRef = useRef<HTMLSelectElement>(null)

  const detailQuery = useQuery({
    queryKey: ['participant-detail', participantId],
    queryFn: () => participantsApi.getDetail(projectId, participantId),
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

  const linkableQuery = useQuery({
    queryKey: ['linkable-rows', projectId, linkingDatasetId],
    queryFn: () => datasetsApi.linkableRows(projectId, linkingDatasetId!),
    enabled: !!linkingDatasetId,
  })
  const linkableData = linkableQuery.data
  /**
   * #963 Tier 2 — *"No rows found"* over an unanswered list, in the one place a
   * researcher goes to link a participant to their dataset record.
   *
   * ⚠️ Fed by a query in this DETAIL component, so the page-level gate Tier 1
   * added does NOT cover it. The disabled case is decided by the render: this
   * whole block is inside the `linkingDatasetId` branch, which is the same flag
   * the query is `enabled` on.
   */
  const linkableLoad = useListLoad(linkableQuery)

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
  // an unlink that did not refresh it left it naming the old set.
  const invalidateAfterLinkChange = () => {
    queryClient.invalidateQueries({ queryKey: ['participants', projectId] })
    queryClient.invalidateQueries({ queryKey: ['withdrawal-report', projectId] })
    queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith?.('dataset') })
    // Resolves once the panel's own detail has refetched — when an unlinked
    // record's row, and the Unlink that was focused, actually go.
    return queryClient.invalidateQueries({ queryKey: ['participant-detail', participantId] })
  }

  // 🔴 The two acts lose focus at DIFFERENT moments, so each lands when its own
  // control goes: a link unmounts the picker at once, an unlink's row goes only
  // when the detail refetch lands. Driven live, a one-frame landing after an
  // unlink saw the Unlink still there, stood down, and focus then fell to <body>.
  const linkMutation = useMutation({
    mutationFn: ({ datasetId, rowId }: { datasetId: number; rowId: number }) =>
      participantsApi.linkDatasetRow(projectId, participantId, datasetId, rowId),
    onSuccess: () => {
      void invalidateAfterLinkChange()
      setLinkingDatasetId(null)
      setLinkSearch('')
      landOnLinkedDatasets()
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
    setLinkSearch('')
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
                          <a
                            href={`/projects/${projectId}/conversations/${c.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-mm-blue-text hover:underline"
                            title={`Open conversation "${c.name}" in new tab`}
                          >
                            {c.name}
                          </a>
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
                <a
                  href={`/projects/${projectId}/documents/${d.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group/doclink inline-flex items-center gap-1 min-w-0 text-xs text-mm-text hover:text-mm-blue-text"
                  title={`Open document "${d.name}" in new tab`}
                >
                  <FileText className="w-3 h-3 shrink-0 text-mm-text-muted" aria-hidden="true" />
                  <span className="truncate group-hover/doclink:underline">{d.name}</span>
                </a>
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
                      <a
                        href={`/projects/${projectId}/datasets/${dr.dataset_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group/dslink flex items-center gap-1 min-w-0 text-xs font-medium text-mm-text hover:text-mm-blue-text"
                        title={`Open dataset "${dr.dataset_name}" in new tab`}
                      >
                        <span className="truncate group-hover/dslink:underline">{dr.dataset_name}</span>
                        <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 opacity-0 group-hover/dslink:opacity-60" aria-hidden="true" />
                      </a>
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
        ) : (() => {
          const linkingName = datasets.find(d => d.id === linkingDatasetId)?.name ?? 'this dataset'
          const filteredRows = filterLinkableRows(linkableData?.rows || [], linkSearch)
          return (
          <div className="mt-2 border border-mm-border-subtle rounded bg-mm-surface">
            <div className="p-1.5 border-b border-mm-border-subtle flex items-center gap-1">
              <span className="text-[11px] text-mm-text-muted truncate max-w-[120px]" title={linkingName}>
                {linkingName}
              </span>
              <a
                href={`/projects/${projectId}/datasets/${linkingDatasetId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-6 h-6 rounded text-mm-text-faint hover:text-mm-blue-text flex-shrink-0"
                aria-label={`Open dataset "${linkingName}" in new tab`}
                title="Open dataset in new tab"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
              <div className="flex-1" />
              <button
                type="button"
                onClick={stopLinking}
                className="inline-flex items-center justify-center w-6 h-6 rounded text-mm-text-faint hover:text-mm-text-secondary flex-shrink-0"
                aria-label="Stop linking"
                title="Stop linking"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
            <div className="p-2 border-b border-mm-border-subtle">
              <input
                type="text"
                value={linkSearch}
                onChange={(e) => setLinkSearch(e.target.value)}
                // Escape leaves the PICKER, not the whole panel.
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); stopLinking() } }}
                placeholder="Search rows..."
                aria-label={`Search ${linkingName} records`}
                className="w-full text-xs border border-mm-border-subtle rounded px-2 py-1 bg-mm-surface text-mm-text"
                autoFocus
              />
            </div>
            <div className="max-h-48 overflow-y-auto divide-y divide-mm-border-subtle">
              {filteredRows.map(row => {
                const isLinked = !!row.linked_participant_name
                // #418: identifying values (Student_ID, names, School, …),
                // not just demographic-typed ones
                const demoText = linkableRowDetail(row)
                return (
                  <button
                    type="button"
                    key={row.row_id}
                    // #1130 — busy is `aria-disabled` + the guard, never
                    // `disabled` (#959 §4); a record someone else holds stays
                    // natively disabled, which is permanent, not a busy state.
                    disabled={isLinked}
                    aria-disabled={(!isLinked && linkMutation.isPending) || undefined}
                    onClick={() => {
                      if (linkMutation.isPending) return
                      linkMutation.mutate({ datasetId: linkingDatasetId!, rowId: row.row_id })
                    }}
                    className={`w-full text-left px-2 py-1.5 text-xs ${
                      isLinked
                        ? 'text-mm-text-faint bg-mm-bg cursor-not-allowed'
                        : 'hover:bg-mm-surface-hover cursor-pointer text-mm-text'
                    }`}
                  >
                    {/* #1130 — the parts are joined by TEXT spaces, not margins
                        alone: a margin is not a space, so the name read
                        "R001North(P001)" (#908's rule). And a taken record says
                        so in words, as the grid's picker does. */}
                    <span className="font-medium">{row.row_identifier || `Row ${row.row_id}`}</span>
                    {demoText && <>{' '}<span className="text-mm-text-faint">{demoText}</span></>}
                    {isLinked && (
                      <>
                        {' '}
                        {/* The words are ONE text node: a space at the edge of
                            an inline span is dropped by name computation
                            (measured in jsdom: "already linked toP009"). */}
                        <span className="text-mm-text-faint" aria-hidden="true">({row.linked_participant_name})</span>
                        <span className="sr-only">{`(already linked to ${row.linked_participant_name})`}</span>
                      </>
                    )}
                  </button>
                )
              })}
              {linkableLoad.status !== 'ready' ? (
                <LoadState
                  load={linkableLoad}
                  loadingLabel="Loading records…"
                  failedTitle="This dataset's records could not be loaded"
                  size="panel"
                />
              ) : filteredRows.length === 0 ? (
                /* Two different facts: an empty dataset and a search that
                   matched nothing. The old copy said the first of both. */
                <p className="text-xs text-mm-text-faint p-2 text-center">
                  {linkSearch ? 'No records match your search' : 'No records in this dataset'}
                </p>
              ) : null}
            </div>
          </div>
          )
        })()}
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
  const { data: report } = useQuery({
    queryKey: ['withdrawal-report', projectId, participantId],
    queryFn: () => participantsApi.withdrawalReport(projectId, participantId),
  })
  if (!report) return null

  const locations = withdrawalLocations(report)
  return (
    <div className="p-4 border-t border-mm-border-subtle">
      <h3 className="text-xs font-medium text-mm-text-secondary mb-1">
        If this person withdraws
      </h3>
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
      <p className="mt-2 text-[11px] text-mm-text-faint leading-snug">
        {WITHDRAWAL_SCOPE_NOTE}
      </p>
    </div>
  )
}
