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
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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

  const { data, isLoading } = useQuery({
    queryKey: ['participants', projectId],
    queryFn: () => participantsApi.list(projectId),
    enabled: open,
  })

  const participants = useMemo(() => data?.participants ?? [], [data?.participants])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return participants
    return participants.filter(p =>
      participantLabel(p).toLowerCase().includes(term)
      || p.identifier.toLowerCase().includes(term)
      || (p.role || '').toLowerCase().includes(term),
    )
  }, [participants, search])

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
            placeholder="Search participants…"
            aria-label="Search participants"
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
          * is unverifiable in the suite — re-drive at 640×360 after touching it. */}
        <div className="max-h-[min(16rem,40vh)] min-h-0 overflow-y-auto -mx-1 px-1">
          <ul className="space-y-0.5">
            <li>
              <button
                type="button"
                onClick={() => choose(null)}
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

            {isLoading && (
              <li className="px-2 py-3 text-sm text-mm-text-muted">Loading participants…</li>
            )}

            {!isLoading && participants.length === 0 && (
              /* The empty state names where to fix it — the remedy is on another
               * screen and nothing on this one would say so. */
              <li className="px-2 py-3 text-sm text-mm-text-muted">
                This project has no participants yet. Add them on the Participants
                page, or import a dataset with an identifier column.
              </li>
            )}

            {!isLoading && participants.length > 0 && filtered.length === 0 && (
              <li className="px-2 py-3 text-sm text-mm-text-muted">
                No participant matches “{search.trim()}”.
              </li>
            )}

            {filtered.map(p => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => choose(p)}
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
      </DialogContent>
    </Dialog>
  )
}
