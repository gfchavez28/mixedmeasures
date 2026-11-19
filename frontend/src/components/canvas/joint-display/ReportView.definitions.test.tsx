/**
 * The notice rule (2026-11-18, rewrite D): the Report view shows the short note under its table and
 * keeps the full Definitions in a closed Details named by their title; every file prints them in
 * full after the display (`joint-display-report.test.ts`).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ReportView from './ReportView'
import type { JointDisplayReport } from '@/lib/joint-display-report'

afterEach(cleanup)

const REPORT: JointDisplayReport = {
  title: 'Side-by-side joint display by construct: T', message: null,
  headers: ['Construct', 'High (2 participants)'],
  rows: [{ kind: 'construct', rowKey: 'r1', construct: 'Training', cells: ['Coded: x 1 of 2.'] } as never],
  note: 'Groups: the participants with each value of Gain. Numbers as computed on 18 Nov 2026.',
  appendix: [],
  definitionsTitle: 'Definitions and cases that don’t fit',
  definitions: ['Fit, after Fetters (2013). Confirmation: they agree.', 'Cases that don’t fit — Training.'],
}

const view = (report: JointDisplayReport) =>
  render(<ReportView report={report} drifted={[]} isEditable onOpenConstruct={() => {}} />)

describe('ReportView — the note and its Definitions', () => {
  it('shows the note, and the Definitions in a closed Details named by their title', () => {
    const { container } = view(REPORT)
    expect(screen.getByText(REPORT.note)).toBeInTheDocument()
    const details = container.querySelector('details')!
    expect(details).not.toHaveAttribute('open')
    expect(details.querySelector('summary')).toHaveTextContent('Definitions and cases that don’t fit')
    for (const p of REPORT.definitions) expect(details).toHaveTextContent(p)
  })

  it('renders no Details when there are no Definitions (the control)', () => {
    const { container } = view({ ...REPORT, definitions: [], definitionsTitle: '' })
    expect(container.querySelector('details')).toBeNull()
  })
})
