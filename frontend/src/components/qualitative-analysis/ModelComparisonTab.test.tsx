/**
 * #1030 — the Model comparison tab. The table used to sit inside the Reliability
 * tab, which needs two PEOPLE, so a lone researcher with an imported model layer —
 * the default install — never saw it.
 *
 * Two seams, each with its #624 lesson: the PREDICATE that offers the tab, and the
 * MOUNT (a table unit-tested in isolation can ship reachable from nowhere).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { isIrrTabVisible, isModelComparisonTabVisible } from '@/lib/qual-analysis-types'
import { MACHINE_AGREEMENT_BLIND_SCOPE } from '@/lib/machine-agreement-copy'

const seen = vi.hoisted(() => ({ humanIds: [] as Array<number | null> }))
vi.mock('./MachineAgreementTable', () => ({
  default: ({ humanId }: { humanId: number | null }) => {
    seen.humanIds.push(humanId)
    return <div data-testid="machine-agreement" />
  },
}))

import ModelComparisonTab from './ModelComparisonTab'

afterEach(() => { cleanup(); seen.humanIds.length = 0 })

describe('who is offered the tab', () => {
  it('ONE person and a model — the case the Reliability tab could never serve', () => {
    expect(isIrrTabVisible(false)).toBe(false)             // the old home: hidden
    expect(isModelComparisonTabVisible(true, true)).toBe(true)
  })
  it('no model has coded this project: not offered (it could only say "nothing")', () => {
    expect(isModelComparisonTabVisible(false, true)).toBe(false)
  })
  it('no person to compare with: not offered', () => {
    expect(isModelComparisonTabVisible(true, false)).toBe(false)
  })
})

describe('the mount', () => {
  it('not blind: every person is compared', () => {
    render(<ModelComparisonTab projectId={1} selfId={4} withholding={false} blind={false} />)
    expect(screen.getByTestId('machine-agreement')).toBeInTheDocument()
    expect(seen.humanIds).toEqual([null])
    expect(screen.queryByText(MACHINE_AGREEMENT_BLIND_SCOPE)).not.toBeInTheDocument()
  })

  it('BLIND: only the viewer is compared, and the tab says so', () => {
    render(<ModelComparisonTab projectId={1} selfId={4} withholding={true} blind={true} />)
    expect(seen.humanIds).toEqual([4])
    expect(screen.getByText(MACHINE_AGREEMENT_BLIND_SCOPE)).toBeInTheDocument()
  })

  it('withholding while the roster is unanswered: narrowed, but no claim yet (#964)', () => {
    render(<ModelComparisonTab projectId={1} selfId={4} withholding={true} blind={false} />)
    expect(seen.humanIds).toEqual([4])
    expect(screen.queryByText(MACHINE_AGREEMENT_BLIND_SCOPE)).not.toBeInTheDocument()
  })

  it('withholding with no known viewer asks for NOBODY rather than everybody', () => {
    render(<ModelComparisonTab projectId={1} selfId={null} withholding={true} blind={true} />)
    expect(screen.queryByTestId('machine-agreement')).not.toBeInTheDocument()
  })
})
