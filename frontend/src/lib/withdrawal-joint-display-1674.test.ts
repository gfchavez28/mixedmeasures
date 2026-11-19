/**
 * #1674 (D356, D357) — what a withdrawal tells the researcher about a joint display: a pinned
 * quote of theirs is blanked WITH the line written beside it (the panel's scope note), and every
 * set of numbers saved beside a meta-inference is cleared (the confirm, then the done note — the
 * server counts both, `canvas_drift_stamps` / `canvas_drift_stamps_cleared`).
 */
import { describe, it, expect } from 'vitest'
import { driftStampsNote, withdrawalDoneNote, WITHDRAWAL_SCOPE_DETAILS, WITHDRAWAL_BACKUP_RESIDUAL } from './withdrawal-copy'

const done = (cleared: number) => ({
  documents_unlinked: 0, canvas_quotes_unplaced: 0, canvas_drift_stamps_cleared: cleared,
  other_projects_with_identifier: { projects: [], total: 0 },
  pre_update_copies: { count: 0, folder: '/b' },
})

describe('#1674 D357 — the drift stamps it clears', () => {
  it('the confirm says how many, and nothing when there are none', () => {
    expect(driftStampsNote({ canvas_drift_stamps: 0 })).toBeNull()
    expect(driftStampsNote({ canvas_drift_stamps: 1 }))
      .toBe('1 set of numbers saved beside a meta-inference in a joint display will be cleared.')
    expect(driftStampsNote({ canvas_drift_stamps: 3 }))
      .toBe('3 sets of numbers saved beside meta-inferences in joint displays will be cleared.')
  })
  it('the note after says it in the past, and still ends on the backups', () => {
    expect(withdrawalDoneNote(done(0))).not.toMatch(/sets? of numbers/)
    const note = withdrawalDoneNote(done(2))
    expect(note).toContain('2 sets of numbers saved beside meta-inferences in joint displays were cleared.')
    expect(note.endsWith(WITHDRAWAL_BACKUP_RESIDUAL)).toBe(true)
  })
})

describe('#1674 D356 — a pinned quote goes with its note', () => {
  it('the scope note says so (behind its Details since the notice rule, 2026-11-18)', () => {
    expect(WITHDRAWAL_SCOPE_DETAILS).toContain(
      'A quote of theirs pinned in a joint display is blanked with the note written beside it.')
  })
})
