import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router'
import ParticipantLinkNote from './ParticipantLinkNote'
import type { ParticipantLinkReport } from '@/lib/api'

const report = (over: Partial<ParticipantLinkReport> = {}): ParticipantLinkReport => ({
  linked: 2, created: 2, matched: 0,
  skipped_missing: 0, skipped_duplicate: 0, skipped_conflict: 0,
  already_linked: 0, duplicate_values: [],
  ...over,
})

const show = (r: ParticipantLinkReport, hadParticipants: boolean | undefined) =>
  render(<MemoryRouter><ParticipantLinkNote report={r} projectId={1} hadParticipants={hadParticipants} /></MemoryRouter>)

afterEach(cleanup)

describe('ParticipantLinkNote — the Dataset Import’s note, now Append’s too (#1010)', () => {
  it('prints each part only when it is not zero — Append said "(2 new, 0 matched)"', () => {
    show(report(), false)
    expect(screen.getByText(/records linked/).parentElement).toHaveTextContent('Participants: 2 records linked (2 new)')
    expect(screen.queryByText(/0 matched/)).toBeNull()
  })

  it('says WHY each unlinked record was left, where Append lumped them together', () => {
    show(report({ linked: 1, created: 1, skipped_duplicate: 2, duplicate_values: ['P01'], skipped_missing: 1 }), false)
    expect(screen.getByText(/^Not linked:/)).toHaveTextContent(
      'Not linked: 2 with a duplicated ID (P01) · 1 with a blank or N/A ID.',
    )
  })

  it('warns when none matched the people ALREADY here — and only then', () => {
    show(report(), true)
    expect(screen.getByText(/None of these IDs matched the participants already in this project/))
      .toBeInTheDocument()
    cleanup()
    show(report(), false)   // an empty project: new participants are expected
    expect(screen.queryByText(/None of these IDs matched/)).toBeNull()
    cleanup()
    show(report(), undefined)   // the count never answered: the unsafe direction is silence (#963)
    expect(screen.getByText(/None of these IDs matched/)).toBeInTheDocument()
  })
})
