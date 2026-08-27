/**
 * #702(3) — the withdrawal confirm.
 *
 * The assertions are about what the screen SAYS, because that is what a
 * researcher acts on and records. The one that matters most is the limitation:
 * this cannot find the person's name in other people's turns or in free text,
 * and a dialog that lets someone believe otherwise is worse than no feature.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
