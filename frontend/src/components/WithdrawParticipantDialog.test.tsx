/**
 * #702(3) — the withdrawal confirm.
 *
 * The assertions are about what the screen SAYS, because that is what a
 * researcher acts on and records. The one that matters most is the limitation:
 * this cannot find the person's name in other people's turns or in free text,
 * and a dialog that lets someone believe otherwise is worse than no feature.
 */
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import WithdrawParticipantDialog from './WithdrawParticipantDialog'
import { removedSummary, keptSummary } from '@/lib/withdrawal-copy'
import type { WithdrawalReport } from '@/lib/api'
import type { ListLoad } from '@/lib/list-status'
import { DIALOG_FITS_VIEWPORT } from '@/components/ConfirmDialog'

afterEach(cleanup)

const load = (status: ListLoad['status'], over: Partial<ListLoad> = {}): ListLoad => ({
  status, error: status === 'failed' ? new Error('boom') : null, retry: vi.fn(), retrying: false, ...over,
})
const P07 = { identifier: 'P07', display_name: null }

const report = (over: Partial<WithdrawalReport> = {}): WithdrawalReport => ({
  participant_id: 1, identifier: 'P07', display_name: 'Maria', role: null,
  has_demographics: true, speaker_names: ['Maria'], total_items: 20,
  unlinked_records_with_identifier: 0,
  conversations: [{
    conversation_id: 1, name: 'Focus group', segments: 3, combined_turns: 0,
    code_applications: 2, excerpts: 1, notes: 1,
  }],
  datasets: [{
    dataset_id: 1, name: 'Survey', rows: 1, responses: 12,
    code_applications: 0, excerpts: 0, notes: 0, memos: 1, row_scores: 2,
  }],
  documents: [],
  ...over,
})

function setup(r: WithdrawalReport | null = report(), reportLoad = load(r ? 'ready' : 'loading')) {
  const onConfirm = vi.fn()
  render(
    <WithdrawParticipantDialog
      open participant={P07} report={r} reportLoad={reportLoad} isPending={false}
      onCancel={vi.fn()} onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

describe('what the screen says will happen', () => {
  /**
   * An irreversible action taken on behalf of a real person's request. Showing
   * only "P-WITHDRAW" makes it easy to act on the wrong row, so the human name
   * appears when we have one.
   */
  it('names the person, not only their code', () => {
    expect(removedSummary(report()).join(' | ')).toMatch(/Maria/)
    expect(removedSummary(report({ display_name: null })).join(' | '))
      .toMatch(/including any name/)
  })

  it('names their words, their responses and their quotes as removed', () => {
    const lines = removedSummary(report()).join(' | ')
    expect(lines).toMatch(/3 conversation turns/)
    expect(lines).toMatch(/12 of their survey responses/)
    // Found by driving it: the naive template read "All 1 of their survey response".
    const one = removedSummary(report({
      datasets: [{ dataset_id: 1, name: 'S', rows: 1, responses: 1, code_applications: 0,
                   excerpts: 0, notes: 0, memos: 0, row_scores: 0 }],
    })).join(' | ')
    expect(one).toMatch(/Their one survey response/)
    expect(one).not.toMatch(/All 1 of/)
    expect(lines).toMatch(/1 quote/)
  })

  /**
   * The researcher has to know the turns remain, or the transcript looks broken
   * later and they cannot tell whether the operation half-failed.
   */
  it('explains that the turns stay as placeholders, and why', () => {
    const lines = keptSummary(report()).join(' | ')
    expect(lines).toMatch(/empty placeholders/)
    expect(lines).toMatch(/other participants/)
  })

  it('says the codes are kept and are the researcher’s own analysis', () => {
    expect(keptSummary(report()).join(' | ')).toMatch(/2 codes you applied/)
  })

  it('tells them to review their own notes and memos', () => {
    expect(keptSummary(report()).join(' | ')).toMatch(/review these yourself/)
  })

  /**
   * #1473 — a note or a code on an ANSWER is deleted with the answer
   * (`withdrawal_redaction.py`), so it is listed as removed. The kept list
   * counted those notes as "notes … you wrote — review these yourself", while
   * the withdrawal deleted them. A turn's note (1) and the record's memo (1) do
   * stay: the control, and the reason the kept count is 2, not 5.
   */
  it('lists the notes and codes on their answers as removed, not kept', () => {
    const r = report({
      datasets: [{ dataset_id: 1, name: 'Survey', rows: 1, responses: 12,
                   code_applications: 4, excerpts: 0, notes: 3, memos: 1, row_scores: 0 }],
    })
    const removed = removedSummary(r).join(' | ')
    expect(removed).toMatch(/3 notes you wrote on their survey responses/)
    expect(removed).toMatch(/4 codes applied to their survey responses/)
    expect(keptSummary(r).join(' | ')).toMatch(/(^| \| )2 notes and memos you wrote/)
    const one = removedSummary(report({
      datasets: [{ dataset_id: 1, name: 'Survey', rows: 1, responses: 1,
                   code_applications: 1, excerpts: 0, notes: 1, memos: 0, row_scores: 0 }],
    })).join(' | ')
    expect(one).toMatch(/The note you wrote on one of their survey responses/)
    expect(one).toMatch(/1 code applied to their survey responses/)
    // None on their answers: neither line (the same two phrases matched above).
    expect(removedSummary(report()).join(' | ')).not.toMatch(/you wrote on|applied to their survey/)
  })

  it('says nothing about turns or responses when there are none', () => {
    const empty = report({ conversations: [], datasets: [] })
    expect(removedSummary(empty)).toEqual([
      'Their participant record — Maria — including demographics',
    ])
    expect(keptSummary(empty)).toEqual([])
  })

  /**
   * #1123 — the withdrawal unlinks a document about them and KEEPS it, and the
   * confirm never said so: the report's document list was dropped by the
   * server's response schema, and nothing here read it either.
   */
  it('says a document about them stays, under "This will stay"', () => {
    setup(report({
      documents: [{ document_id: 3, name: 'Workplan P07', segments: 4,
                    code_applications: 1, excerpts: 0, notes: 0 }],
    }))
    const stay = screen.getByText('This will stay').parentElement!
    expect(stay).toHaveTextContent('The document “Workplan P07” stays, no longer linked to them')
    expect(screen.getByText('This will be removed').parentElement).not.toHaveTextContent(/Workplan/)
  })
})

describe('the limitation is on the screen', () => {
  /**
   * 🔴 The single most important assertion in this file. A researcher records
   * that they honoured a withdrawal; this is the part still left to them.
   */
  it('states plainly that it cannot finish the job on its own', () => {
    setup()
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent(/cannot finish the job on its own/i)
    expect(note).toHaveTextContent(/free-text/i)
    expect(note).toHaveTextContent(/other people said it/i)
  })

  it('does not claim to determine whether obligations are met', () => {
    setup()
    expect(screen.getByText(/cannot tell you whether this satisfies your obligations/i))
      .toBeInTheDocument()
  })

  it('says a backup is taken and that there is no per-person undo', () => {
    setup()
    expect(screen.getByText(/no per-person undo/i)).toBeInTheDocument()
  })
})

/**
 * #1131 (a11y-name-sweep run 11) — a reader opening the dialog hears its
 * DESCRIPTION, then the focused Cancel. Only the backup sentence was in it, so
 * what is removed, what stays and the warning above were on screen and silent.
 */
describe('#1131 — the dialog’s description carries the decision', () => {
  it('describes what is removed, what stays, and that it cannot finish the job', () => {
    setup(report({
      documents: [{ document_id: 3, name: 'Workplan P07', segments: 4,
                    code_applications: 1, excerpts: 0, notes: 0 }],
    }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(/no per-person undo/)
    expect(dialog).toHaveAccessibleDescription(/This will be removed/)
    expect(dialog).toHaveAccessibleDescription(/3 conversation turns/)
    expect(dialog).toHaveAccessibleDescription(/This will stay/)
    expect(dialog).toHaveAccessibleDescription(/The document “Workplan P07” stays/)
    expect(dialog).toHaveAccessibleDescription(/cannot finish the job on its own/)
    expect(dialog).toHaveAccessibleDescription(/cannot tell you whether this satisfies your obligations/)
  })

  /**
   * #1320 (D12) — what still holds the data is part of the decision, so it is
   * heard on open: inside the description, not beside it.
   */
  it('#1320: the description names every copy that still holds the data, and recordings', () => {
    setup()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(/A full backup is taken first\. That backup, your earlier backups/)
    expect(dialog).toHaveAccessibleDescription(/the safety copies kept before a merge or overwrite/)
    expect(dialog).toHaveAccessibleDescription(/any file already exported or shared still hold everything this removes/)
    expect(dialog).toHaveAccessibleDescription(/Automatic and On quit backups are replaced over time/)
    expect(dialog).toHaveAccessibleDescription(/Settings › Backup & Data/)
    expect(dialog).toHaveAccessibleDescription(/Recordings are not edited — their voice stays in the audio or video/)
  })

  it('#1320: a merged or split turn is named as removed whole, in the description', () => {
    setup(report({
      conversations: [{ conversation_id: 1, name: 'Focus group', segments: 3, combined_turns: 2,
                        code_applications: 2, excerpts: 1, notes: 1 }],
    }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(/2 merged or split turns holding theirs/)
    expect(dialog).toHaveAccessibleDescription(/Unmerge brings it back/)
  })

  it('while the report loads, the description says it is checking', () => {
    setup(null)
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/Checking what would be removed/)
  })

  it('one turn is "stays … as an empty placeholder", not "stay … placeholders"', () => {
    const one = keptSummary(report({
      conversations: [{ conversation_id: 1, name: 'F', segments: 1, combined_turns: 0, code_applications: 0, excerpts: 0, notes: 0 }],
    })).join(' | ')
    expect(one).toMatch(/Their 1 turn stays in place as an empty placeholder,/)
    expect(keptSummary(report()).join(' | ')).toMatch(/Their 3 turns stay in place as empty placeholders,/)
  })
})

/**
 * #1152 — the confirm waits for THIS opening's report. It enabled on whatever the
 * cache held; the page now hands it `null` until its own read answers. While it
 * waits it is `aria-disabled` + guarded (a native `disabled` would blur it when the
 * page's report goes back to loading as the dialog closes), its name unchanged.
 */
describe('the control', () => {
  it('waits for the report: unavailable, still focusable, named as ever — and a press does nothing', () => {
    const onConfirm = setup(null)
    const confirm = screen.getByRole('button', { name: 'Back up and remove' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).not.toBeDisabled()
    expect(confirm).not.toHaveAttribute('aria-busy')
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    // The dialog stays open: the guard prevented Radix's Close as well.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('POSITIVE CONTROL: once the report has arrived it is available and acts', () => {
    const onConfirm = setup()
    const confirm = screen.getByRole('button', { name: 'Back up and remove' })
    expect(confirm).not.toHaveAttribute('aria-disabled')
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('says it is checking through the shared loading line, inside the description', () => {
    setup(null, load('loading'))
    const dialog = screen.getByRole('alertdialog')
    // `LoadingNotice` — a `role="status"` line (and the slow-load hint after 10 s).
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking what would be removed…')
    expect(dialog).toHaveAccessibleDescription(/Checking what would be removed…/)
  })

  it('a report that could not be read says so, offers a Retry, and the confirm still refuses', () => {
    const failed = load('failed')
    const onConfirm = setup(null, failed)
    expect(screen.getByRole('alert')).toHaveTextContent('What would be removed could not be checked.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(failed.retry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Back up and remove' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

/**
 * #1139 — the dialog fits the window, and its title names the person clicked.
 * jsdom computes no layout: these pin the TECHNIQUE (the class, the call); the
 * sizes are measured live at 640×360.
 */
describe('#1139 — it fits the window and names the person', () => {
  it('is capped at the window and scrolls inside it (`DIALOG_FITS_VIEWPORT`)', () => {
    setup()
    const dialog = screen.getByRole('alertdialog')
    for (const c of DIALOG_FITS_VIEWPORT.split(' ')) expect(dialog).toHaveClass(c)
  })

  it('its list region gives up its own scroller on a short window, so ONE thing scrolls', () => {
    setup()
    const region = screen.getByText('This will be removed').closest('div')!.parentElement!
    expect(region).toHaveClass('max-h-72', 'overflow-y-auto')
    expect(region).toHaveClass('[@media(max-height:480px)]:max-h-none', '[@media(max-height:480px)]:overflow-visible')
  })

  it('the title names the person, with the identifier beside it', () => {
    render(
      <WithdrawParticipantDialog
        open participant={{ identifier: 'E-01', display_name: 'Amara Okafor' }}
        report={report()} reportLoad={load('ready')} isPending={false}
        onCancel={vi.fn()} onConfirm={vi.fn()}
      />,
    )
    expect(screen.getByRole('alertdialog', { name: 'Remove Amara Okafor’s data? (E-01)' })).toBeInTheDocument()
  })

  it('with no display name, the identifier once', () => {
    setup()
    expect(screen.getByRole('alertdialog', { name: 'Remove P07’s data?' })).toBeInTheDocument()
  })
})

/** The page's side of the contract: pressing the confirm starts the request, and
 * the page closes the dialog only on success. */
function Harness({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [pending, setPending] = useState(false)
  return (
    <WithdrawParticipantDialog
      open participant={P07} report={report()} reportLoad={load('ready')} isPending={pending}
      onCancel={onCancel}
      onConfirm={() => { onConfirm(); setPending(true) }}
    />
  )
}

describe('#1139 — the busy button is kept in view', () => {
  it('scrolls the confirm into view (nearest) when the work starts, and not before', () => {
    const spy = vi.fn()
    HTMLElement.prototype.scrollIntoView = spy
    try {
      render(<Harness onConfirm={vi.fn()} onCancel={vi.fn()} />)
      expect(spy).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Back up and remove' }))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
      const busy = screen.getByRole('button', { name: /Removing/ })
      expect(spy.mock.contexts[0]).toBe(busy)
      // …and stops short of the dialog's edge: `block: 'nearest'` ignores the
      // scroller's padding (flush at 307–343 in a box ending at 344, measured).
      expect(busy).toHaveClass('scroll-mb-6')
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})

describe('while the backup and the removal run (#1025)', () => {
  /**
   * `AlertDialogAction` is a Radix Close. Without `preventDefault()` the press
   * closed the dialog in the same click (the page's `onCancel`), so the busy
   * state never rendered and the person's row invited a second press.
   */
  it('stays open, says what is happening, and keeps the pressed button focusable', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    const confirm = screen.getByRole('button', { name: /Back up and remove/ })
    confirm.focus()
    fireEvent.click(confirm)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    const busy = screen.getByRole('button', { name: /Removing/ })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    // Chrome blurs a focused button that becomes `disabled`; jsdom does not, so
    // the attribute is what is asserted.
    expect(busy).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/Taking a backup, then removing/)
  })

  it('a second press does not start a second withdrawal', () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Back up and remove/ }))
    fireEvent.click(screen.getByRole('button', { name: /Removing/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('neither Cancel nor Escape closes it while the request runs', () => {
    const onCancel = vi.fn()
    render(<Harness onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /Back up and remove/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Cancel still closes it before anything has started', () => {
    // The POSITIVE control for the case above.
    const onCancel = vi.fn()
    render(<Harness onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
