/**
 * "This document is about…" — the edit affordance for `Document.participant_id`
 * (row 46, 2026-09-07).
 *
 * ## Why documents needed this at all
 *
 * A conversation reaches the participant spine through its speakers and a survey
 * response through its dataset row. A document segment has no speaker, so until
 * this shipped nothing coded on a document could be compared by the subject's
 * attributes — the workplan-per-employee and application-per-organisation cases
 * both stopped here.
 *
 * ## Why a dialog rather than an inline picker on the card
 *
 * The card is wrapped in a `<Link>` to the workbench, so an interactive control
 * inside it fights the navigation (and nesting interactive content inside an
 * anchor is two tab stops for one control — the #830-era rule). The context menu
 * already owns Rename and Delete; this joins them.
 *
 * ## The two halves of the value
 *
 * `participant_id` is what the server stores and `participant_label` is the only
 * half that can be rendered, so both ride the payload together and this dialog
 * hands both back — a caller given one of them would have to fetch or guess the
 * other.
 *
 * ⚠️ **Clearing is a first-class action, not an absence.** `participant_id: null`
 * is a MEANINGFUL value on the PATCH (the backend distinguishes an omitted key
 * from an explicit null via `model_dump(exclude_unset=True)`), so the dialog
 * offers an explicit "Not about a specific subject" rather than expecting the
 * researcher to find some way to deselect.
 */
import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  NO_PARTICIPANTS_YET, PARTICIPANT_LIST_LIMIT, PARTICIPANT_SEARCH_LABEL, PARTICIPANT_SEARCH_PLACEHOLDER,
  noParticipantsMatch, pickerLimitNote, searchParticipants,
} from '@/lib/participant-search'
import { LoadState } from '@/components/LoadStatus'
import { useListLoad } from '@/hooks/useListLoad'
import { Check, Search, UserRound, X } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { participantsApi } from '@/lib/api'
import { SELECTED_ROW } from '@/lib/selection'
import type { Participant } from '@/lib/api/participants'

interface Props {
  open: boolean
  projectId: number
  documentName: string
  /** The subject currently on the document, or null. */
  participantId: number | null
  onClose: () => void
  /** Both halves — see the module docstring. `null` clears the link. */
  onChoose: (participantId: number | null, participantLabel: string | null) => void
}

/** The house convention for naming a participant, matching the backend's
 *  `display_name or identifier`. */
function participantLabel(p: Participant): string {
  return p.display_name || p.identifier
}

export default function DocumentSubjectDialog({
  open, projectId, documentName, participantId, onClose, onChoose,
}: Props) {
  const [search, setSearch] = useState('')

  const participantsQuery = useQuery({
    queryKey: ['participants', projectId],
    queryFn: () => participantsApi.list(projectId),
    enabled: open,
  })
  const data = participantsQuery.data

  const participants = useMemo(() => data?.participants ?? [], [data?.participants])
  /**
   * #963 Tier 3 — a settled failure fell through to *"This project has no
   * participants yet. Add them on the Participants page, or import a dataset
   * with an identifier column."* — a false claim AND an instruction to go do
   * work the researcher has already done, on a project that may hold hundreds.
   *
   * ⚠️ The query is `enabled: open`, which `listStatus` would read as `loading`
   * forever while the dialog is shut — harmless here only because Radix
   * unmounts the content, so nothing asks. The list is never spoken about from
   * outside this dialog.
   */
  const participantsLoad = useListLoad(participantsQuery)

  /**
   * #1045 — ranked and BOUNDED. A survey imported with identifier linking makes
   * one participant per record (122,382 on BES), and this dialog rendered one
   * button per participant. It now renders at most `PARTICIPANT_LIST_LIMIT` and
   * says so; search reaches the rest, exact matches first
   * (`lib/participant-search.ts`, shared with the dataset grid's link picker).
   * The bound also keeps the list cheap while the dialog is SHUT: these JSX
   * children are built on every render of the page that holds the dialog.
   */
  const searching = search.trim() !== ''
  const matches = useMemo(() => searchParticipants(participants, search), [participants, search])
  const shown = useMemo(() => matches.slice(0, PARTICIPANT_LIST_LIMIT), [matches])
  const limitNote = participantsLoad.status === 'ready'
    ? pickerLimitNote(shown.length, matches.length, searching)
    : null
  const limitNoteId = useId()

  /**
   * #1072 (b) — the CURRENT subject, pinned when the bounded list does not show
   * it. At 122,382 participants the one a document is about is usually past the
   * first `PARTICIPANT_LIST_LIMIT`, and the dialog then showed no check mark and
   * no name anywhere: nothing said who the document was already about. Pinned as
   * a row of the list (so it is chosen, re-chosen and announced like the others)
   * rather than as a line above it, which would cost the dialog height a 640×360
   * window does not have (see the list's own note).
   */
  const current = useMemo(
    () => (participantId == null ? null : participants.find((p) => p.id === participantId) ?? null),
    [participants, participantId],
  )
  const pinCurrent = current !== null && !shown.some((p) => p.id === current.id)

  const choose = (p: Participant | null) => {
    onChoose(p ? p.id : null, p ? participantLabel(p) : null)
    setSearch('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setSearch(''); onClose() } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Who is this document about?</DialogTitle>
          <DialogDescription>
            Linking “{documentName}” to a participant lets you compare its coding by
            that participant’s attributes — the same way conversations and survey
            responses already can.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          {/* Decorative: the input below carries the accessible name (#559). */}
          <Search
            className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-mm-text-muted"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={PARTICIPANT_SEARCH_PLACEHOLDER}
            aria-label={PARTICIPANT_SEARCH_LABEL}
            aria-describedby={limitNote ? limitNoteId : undefined}
            className="pl-8"
          />
        </div>

        {/* Height-bounded: a project can hold hundreds of participants, and this
          * dialog must still fit the 640×360 viewport a 1280×720 window has at
          * 200% zoom (#717/#718). `min-h-0` grants the collapse and the
          * `overflow-y-auto` on the SAME element is what makes it safe (#894).
          *
          * ⚠️ **The cap is viewport-relative because a FIXED one is not a fit.**
          * MEASURED at 640×360 with a plain `max-h-64`: the dialog came to 458px
          * in a 360px viewport, hanging 49px off each end — the list obeyed its
          * cap and the DIALOG still did not fit, because 202px of title,
          * description and search box sit above it. `min()` keeps the desktop
          * behaviour identical (40vh exceeds 16rem above ~640px tall) and yields
          * 144px at 360px, for a 346px dialog. jsdom computes no layout, so this
          * is unverifiable in the suite — re-drive at 640×360 after touching it.
          *
          * ⚠️ **#1045's limit note costs the list height on a SHORT viewport.**
          * MEASURED at 640×360 once the note shipped: 394px in a 360px viewport,
          * 17px off each end — the note's two lines and gap are ~48px the 346px
          * budget did not have. Below 480px tall the list gives them back
          * (24vh = 86px at 360, for a 336px dialog); taller windows are
          * unchanged. The short-viewport breakpoint is the house one
          * (`CollapsiblePanel`, `LoadStatus`). */}
        <div className="max-h-[min(16rem,40vh)] [@media(max-height:480px)]:max-h-[24vh] min-h-0 overflow-y-auto -mx-1 px-1">
          <ul className="space-y-0.5">
            <li>
              <button
                type="button"
                onClick={() => choose(null)}
                aria-current={participantId === null ? 'true' : undefined}
                className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 hover:bg-mm-surface-hover ${
                  participantId === null ? SELECTED_ROW : ''
                }`}
              >
                <X className="w-3.5 h-3.5 text-mm-text-muted" aria-hidden="true" />
                <span className="text-mm-text-secondary">Not about a specific subject</span>
                {participantId === null && (
                  <Check className="w-3.5 h-3.5 ml-auto text-mm-blue-text" aria-hidden="true" />
                )}
              </button>
            </li>

            {participantsLoad.status !== 'ready' && (
              <li>
                <LoadState
                  load={participantsLoad}
                  loadingLabel="Loading participants…"
                  failedTitle="The participant list could not be loaded."
                  size="panel"
                />
              </li>
            )}

            {participantsLoad.status === 'ready' && participants.length === 0 && (
              /* The empty state names where to fix it — the remedy is on another
               * screen and nothing on this one would say so. */
              <li className="px-2 py-3 text-sm text-mm-text-muted">
                {`${NO_PARTICIPANTS_YET} Add them on the Participants page, or import a dataset with an identifier column.`}
              </li>
            )}

            {participantsLoad.status === 'ready' && participants.length > 0 && matches.length === 0 && (
              <li className="px-2 py-3 text-sm text-mm-text-muted">
                {noParticipantsMatch(search)}
              </li>
            )}

            {participantsLoad.status === 'ready' && pinCurrent && current && (
              <li key={`current-${current.id}`}>
                <button
                  type="button"
                  onClick={() => choose(current)}
                  aria-current="true"
                  className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 hover:bg-mm-surface-hover ${SELECTED_ROW}`}
                >
                  <UserRound className="w-3.5 h-3.5 text-mm-text-muted shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{participantLabel(current)}</span>
                  <span className="text-xs text-mm-text-muted shrink-0">· current subject</span>
                  <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-mm-blue-text" aria-hidden="true" />
                </button>
              </li>
            )}

            {shown.map(p => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => choose(p)}
                  // #1072 (b): the state, not only the colour and an aria-hidden
                  // check mark — #1067 (f)'s rule for the grid's picker.
                  aria-current={participantId === p.id ? 'true' : undefined}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 hover:bg-mm-surface-hover ${
                    participantId === p.id ? SELECTED_ROW : ''
                  }`}
                >
                  <UserRound className="w-3.5 h-3.5 text-mm-text-muted shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{participantLabel(p)}</span>
                  {p.role && (
                    <span className="text-xs text-mm-text-muted shrink-0">· {p.role}</span>
                  )}
                  {participantId === p.id && (
                    <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-mm-blue-text" aria-hidden="true" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* #1045 — outside the scroller so it reads as a statement about the
            list rather than as one more entry in it; the search box carries it
            as its description. */}
        {limitNote && (
          <p id={limitNoteId} className="text-xs text-mm-text-muted">
            {limitNote}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
