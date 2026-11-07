/**
 * The human-vs-machine table (queue row 49).
 *
 * The claim is as much about what this surface must NOT say. Three of the cases
 * below assert an absence, and each is paired with a positive control — a
 * negative assertion on a query that could never match is indistinguishable from
 * a pass (#770).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  MACHINE_AGREEMENT_NO_PROVENANCE,
  MACHINE_AGREEMENT_UNAVAILABLE,
} from '@/lib/machine-agreement-copy'

const machineAgreement = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { machineAgreement },
}))

import MachineAgreementTable from './MachineAgreementTable'

afterEach(() => { cleanup(); machineAgreement.mockReset() })

function renderTable(humanId: number | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MachineAgreementTable projectId={1} humanId={humanId} />
    </QueryClientProvider>,
  )
}

const ROW = {
  code_id: 5,
  code_name: 'Trust',
  n_units: 8,
  human_applied: 5,
  machine_applied: 5,
  both_applied: 4,
  percent_agreement: 0.75,
  kappa: 0.4667,
  kappa_interpretation: 'fair',
  prevalence: 0.625,
  undefined_reason: null as string | null,
}

const PAIR = {
  human_id: 1,
  human_name: 'Alice',
  machine_id: 9,
  machine_name: 'GPT-4o',
  machine_provenance: { model: 'gpt-4o-2024-08-06', access: 'api' as const },
  n_units: 8,
  per_code: [ROW],
}

describe('the table', () => {
  it('renders one row per code with BOTH coverage counts', async () => {
    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null, pairs: [PAIR],
    })
    renderTable()
    // 🔴 The coverage pair IS the disclosure: a κ over a corpus one side barely
    // reached is about coverage, and the coefficient cannot say so.
    const row = await screen.findByRole('rowheader', { name: /Trust/ })
    expect(row).toHaveAccessibleName(/Alice applied it to 5 of 8 units/)
    expect(row).toHaveAccessibleName(/GPT-4o to 5/)
    expect(row).toHaveAccessibleName(/both to 4/)
  })

  it('🔴 says the band as a WORD, never the wire key (a11y sweep, 2026-09-23)', async () => {
    // The fixture's `fair` is its own word, which is how a row name built from the
    // raw key shipped: only a multi-word band shows it. Chrome read the live table
    // as "Kappa 0.89, almost_perfect."
    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null,
      pairs: [{ ...PAIR, per_code: [{ ...ROW, kappa: 0.89, kappa_interpretation: 'almost_perfect' }] }],
    })
    renderTable()
    const row = await screen.findByRole('rowheader', { name: /Trust/ })
    expect(row).toHaveAccessibleName(/Kappa 0\.89, almost perfect\./)
    expect(row).not.toHaveAccessibleName(/_/)
  })

  it('names the model configuration', async () => {
    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null, pairs: [PAIR],
    })
    renderTable()
    expect(await screen.findByText(/gpt-4o-2024-08-06 · via API/)).toBeInTheDocument()
  })

  it('#1333 / #1334 — says what a unit is, from the payload, and nothing for an older one', async () => {
    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null, pairs: [PAIR], unit_basis: 'participant_passages',
    })
    const { unmount } = renderTable()
    const line = await screen.findByTestId('machine-agreement-unit-basis')
    expect(line).toHaveTextContent(/turns are left out, and a group of turns counts once/)
    unmount()

    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null, pairs: [PAIR],
    })
    renderTable()
    await screen.findByRole('rowheader', { name: /Trust/ })
    expect(screen.queryByTestId('machine-agreement-unit-basis')).not.toBeInTheDocument()
  })

  it('🔴 SAYS SO when no configuration was recorded', async () => {
    machineAgreement.mockResolvedValue({
      available: true,
      unavailable_reason: null,
      pairs: [{ ...PAIR, machine_provenance: null }],
    })
    renderTable()
    expect(
      await screen.findByText(MACHINE_AGREEMENT_NO_PROVENANCE),
    ).toBeInTheDocument()
  })

  it('🔴 shows the REASON, not 0.0, for an undefined coefficient', async () => {
    machineAgreement.mockResolvedValue({
      available: true,
      unavailable_reason: null,
      pairs: [{
        ...PAIR,
        per_code: [{ ...ROW, kappa: null, kappa_interpretation: null, undefined_reason: 'no_variance' }],
      }],
    })
    renderTable()
    // POSITIVE CONTROL first: the defined case renders a number, so the absence
    // below is about this row and not about the column never rendering.
    expect(await screen.findByText('no variation')).toBeInTheDocument()
    expect(screen.queryByText('0.00')).not.toBeInTheDocument()
  })

  it('carries NO pooled figure', async () => {
    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null, pairs: [PAIR],
    })
    const { container } = renderTable()
    await screen.findByRole('rowheader', { name: /Trust/ })
    // One coefficient per (person × machine × code) — the grain the claim is
    // about. A pooled "overall" would be read as "our agreement".
    expect(container.textContent).not.toMatch(/overall/i)
    expect(container.textContent).not.toMatch(/\balpha\b/i)
  })

  it('states what the numbers are NOT', async () => {
    machineAgreement.mockResolvedValue({
      available: true, unavailable_reason: null, pairs: [PAIR],
    })
    const { container } = renderTable()
    await screen.findByRole('rowheader', { name: /Trust/ })
    expect(container.textContent).toContain('not inter-rater reliability')
    expect(container.textContent).toContain('not evidence that the coding is correct')
  })
})

describe('#1505 (D43) — a κ over too few units keeps its number and loses its verdict', () => {
  // `Trust` (8 units) is under the payload's floor of 18; `Access` (40) is the
  // positive control for every absence asserted.
  const BELOW = { ...ROW, kappa_interpretation: null, verdict_withheld_reason: 'too_few_units' }
  const OVER = {
    ...ROW, code_id: 6, code_name: 'Access', n_units: 40, kappa: 0.81,
    kappa_interpretation: 'almost_perfect', verdict_withheld_reason: null,
  }
  const payload = (floor: number | null = 18) => ({
    available: true, unavailable_reason: null, verdict_min_units: floor,
    pairs: [{ ...PAIR, per_code: [BELOW, OVER] }],
  })

  it('says "too few to judge" in the row’s name with its count against the floor, and in the cell', async () => {
    machineAgreement.mockResolvedValue(payload())
    renderTable()
    const row = await screen.findByRole('rowheader', { name: /Trust/ })
    expect(row).toHaveAccessibleName(/Kappa 0\.47, too few to judge \(8 of the 18 units a verdict needs\)\.$/)
    const cell = screen.getByText('0.47').closest('td')!
    expect(cell.textContent).toBe('0.47 too few to judge')
    expect(cell).toHaveAttribute('title', '8 of the 18 units a verdict needs')

    const control = screen.getByRole('rowheader', { name: /Access/ })
    expect(control).toHaveAccessibleName(/Kappa 0\.81, almost perfect\.$/)
    expect(screen.getByText('0.81').closest('td')!.textContent).toBe('0.81')
  })

  it('explains the floor once below the pairs, in words that do not call it reliability', async () => {
    machineAgreement.mockResolvedValue({
      ...payload(),
      pairs: [
        { ...PAIR, per_code: [BELOW, OVER] },
        { ...PAIR, machine_id: 10, machine_name: 'Claude', per_code: [BELOW] },
      ],
    })
    renderTable()
    await screen.findAllByRole('rowheader', { name: /Trust/ })
    const notes = screen.getAllByTestId('machine-agreement-verdict-note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toHaveTextContent(/^Too few to judge: a coefficient over fewer than 18 units/)
    expect(notes[0].textContent).not.toMatch(/reliab/i)
  })

  it('takes the floor from the payload, and says nothing when no row is under it', async () => {
    machineAgreement.mockResolvedValue(payload(30))
    const { unmount } = renderTable()
    expect(await screen.findByRole('rowheader', { name: /Trust/ }))
      .toHaveAccessibleName(/8 of the 30 units a verdict needs/)
    expect(screen.getByTestId('machine-agreement-verdict-note')).toHaveTextContent('fewer than 30 units')
    unmount()

    machineAgreement.mockResolvedValue({ ...payload(), pairs: [{ ...PAIR, per_code: [OVER] }] })
    renderTable()
    await screen.findByRole('rowheader', { name: /Access/ })
    expect(screen.queryByTestId('machine-agreement-verdict-note')).not.toBeInTheDocument()
    expect(screen.queryByText(/too few to judge/)).not.toBeInTheDocument()
  })
})

describe('when there is nothing to show', () => {
  it('says which of the three states it is in', async () => {
    machineAgreement.mockResolvedValue({
      available: false, unavailable_reason: 'no_shared_source', pairs: [],
    })
    renderTable()
    expect(
      await screen.findByText(MACHINE_AGREEMENT_UNAVAILABLE.no_shared_source),
    ).toBeInTheDocument()
  })

  it('🔴 renders NOTHING for a reason this build does not know', async () => {
    // The stated-basis family's silence rule: a made-up sentence for an unknown
    // value is worse than none. A KNOWN reason always speaks — see above — so
    // this absence is about the unknown value and not about the branch.
    machineAgreement.mockResolvedValue({
      available: false, unavailable_reason: 'something_newer', pairs: [],
    })
    const { container } = renderTable()
    await waitFor(() => expect(machineAgreement).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('says so when the request fails, rather than falling silent', async () => {
    // Silence reads as "still thinking", which is worse than a wrong sentence
    // because nothing invites a retry (#963 Tier 3).
    machineAgreement.mockRejectedValue(new Error('network'))
    renderTable()
    expect(
      await screen.findByText(/could not be loaded/i),
    ).toBeInTheDocument()
  })
})

describe('#1030 — the person scope reaches the request', () => {
  it('no scope asks for every person', async () => {
    machineAgreement.mockResolvedValue({ available: false, unavailable_reason: 'no_shared_source', pairs: [] })
    renderTable(null)
    await waitFor(() => expect(machineAgreement).toHaveBeenCalledWith(1, null))
  })

  it('a scope (blind mode) asks the SERVER for that person alone', async () => {
    machineAgreement.mockResolvedValue({ available: false, unavailable_reason: 'no_shared_source', pairs: [] })
    renderTable(3)
    await waitFor(() => expect(machineAgreement).toHaveBeenCalledWith(1, 3))
  })

  it('the scope rides the query KEY: turning blind on re-asks rather than serving everyone from cache (#454)', async () => {
    machineAgreement.mockResolvedValue({ available: false, unavailable_reason: 'no_shared_source', pairs: [] })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (humanId: number | null) => (
      <QueryClientProvider client={client}>
        <MachineAgreementTable projectId={1} humanId={humanId} />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    await waitFor(() => expect(machineAgreement).toHaveBeenCalledWith(1, null))
    rerender(view(3))
    await waitFor(() => expect(machineAgreement).toHaveBeenCalledWith(1, 3))
  })
})
