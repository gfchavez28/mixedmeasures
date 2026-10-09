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
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import WithdrawParticipantDialog from './WithdrawParticipantDialog'
import { removedSummary, keptSummary } from '@/lib/withdrawal-copy'
import type { WithdrawalReport } from '@/lib/api'

afterEach(cleanup)

const report = (over: Partial<WithdrawalReport> = {}): WithdrawalReport => ({
  participant_id: 1, identifier: 'P07', display_name: 'Maria', role: null,
  has_demographics: true, speaker_names: ['Maria'], total_items: 20,
  conversations: [{
    conversation_id: 1, name: 'Focus group', segments: 3,
    code_applications: 2, excerpts: 1, notes: 1,
  }],
  datasets: [{
    dataset_id: 1, name: 'Survey', rows: 1, responses: 12,
    code_applications: 0, excerpts: 0, notes: 0, memos: 1, row_scores: 2,
  }],
  documents: [],
  ...over,
})

function setup(r: WithdrawalReport | null = report()) {
  const onConfirm = vi.fn()
  render(
    <WithdrawParticipantDialog
      open identifier="P07" report={r} isPending={false}
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

  it('while the report loads, the description says it is checking', () => {
    setup(null)
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/Checking what would be removed/)
  })

  it('one turn is "stays … as an empty placeholder", not "stay … placeholders"', () => {
    const one = keptSummary(report({
      conversations: [{ conversation_id: 1, name: 'F', segments: 1, code_applications: 0, excerpts: 0, notes: 0 }],
    })).join(' | ')
    expect(one).toMatch(/Their 1 turn stays in place as an empty placeholder,/)
    expect(keptSummary(report()).join(' | ')).toMatch(/Their 3 turns stay in place as empty placeholders,/)
  })
})

describe('the control', () => {
  it('waits for the report before enabling the action', () => {
    setup(null)
    expect(screen.getByRole('button', { name: /Back up and remove/ })).toBeDisabled()
  })

  it('enables once the report has arrived', () => {
    setup()
    expect(screen.getByRole('button', { name: /Back up and remove/ })).toBeEnabled()
  })
})

/** The page's side of the contract: pressing the confirm starts the request, and
 * the page closes the dialog only on success. */
function Harness({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [pending, setPending] = useState(false)
  return (
    <WithdrawParticipantDialog
      open identifier="P07" report={report()} isPending={pending}
      onCancel={onCancel}
      onConfirm={() => { onConfirm(); setPending(true) }}
    />
  )
}

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
