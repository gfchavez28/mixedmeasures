/**
 * #35 — MagnitudeScaleDialog: declaring a code's rating scale.
 *
 * The dialog's job is to build a well-formed declaration and hand it to the
 * server, which is the authority on whether it may be applied (it refuses a
 * narrowing that would strand ratings, naming the count). So the pins here are
 * about the DRAFT — what gets sent, what is refused before sending, what an
 * existing scale seeds — and about surfacing the server's own words verbatim.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const setMagnitudeScale = vi.fn()
// `serverDetailMessage` is the REAL parser, not a stub (#871): the thing under
// test here is which of the server's three detail shapes reaches the toast, and
// a stub would assert the mock instead. Pulled from its own module rather than
// `importActual` on the barrel, which would drag in the whole API client.
vi.mock('@/lib/api', async () => ({
  codesApi: { setMagnitudeScale: (...a: unknown[]) => setMagnitudeScale(...a) },
  serverDetailMessage: (
    await vi.importActual<typeof import('@/lib/api/error-utils')>('@/lib/api/error-utils')
  ).serverDetailMessage,
}))

const toastError = vi.fn()
const toastPlain = vi.fn()
vi.mock('sonner', () => ({
  toast: Object.assign((...a: unknown[]) => toastPlain(...a), { error: (...a: unknown[]) => toastError(...a) }),
}))

import MagnitudeScaleDialog from './MagnitudeScaleDialog'
import type { Code } from '@/lib/api'

afterEach(cleanup)
beforeEach(() => { setMagnitudeScale.mockReset(); toastError.mockReset(); toastPlain.mockReset() })

const PLAIN = {
  id: 5, name: 'Curriculum fidelity', color: null, is_active: true, is_universal: false,
  magnitude_scale: null,
} as unknown as Code

const SCALED = {
  ...PLAIN,
  magnitude_scale: {
    min: -1, max: 1, step: 0.5,
    anchors: [{ value: -1, label: 'strongly negative' }, { value: 1, label: 'strongly positive' }],
  },
} as unknown as Code

function setup(code: Code = PLAIN) {
  const onOpenChange = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <MagnitudeScaleDialog projectId={42} code={code} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { onOpenChange, invalidate }
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const save = () => screen.getByRole('button', { name: 'Save scale' })

describe('MagnitudeScaleDialog — the draft', () => {
  it('opens on a 0–10 step-1 draft for a code with no scale, and saves exactly that', async () => {
    setMagnitudeScale.mockResolvedValue({})
    const { onOpenChange, invalidate } = setup()
    expect(screen.getByRole('dialog', { name: /Rating scale — Curriculum fidelity/ })).toBeInTheDocument()
    expect(field('Minimum').value).toBe('0')
    expect(field('Maximum').value).toBe('10')
    expect(field('Step').value).toBe('1')
    expect(save()).toBeEnabled()

    fireEvent.click(save())
    await waitFor(() => expect(setMagnitudeScale).toHaveBeenCalledWith(42, 5, { min: 0, max: 10, step: 1, anchors: [] }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['codes', 42] })
    expect(toastPlain).toHaveBeenCalledWith('Rating scale set for "Curriculum fidelity"')
  })

  it('seeds every field from an existing scale and offers to remove it', async () => {
    setMagnitudeScale.mockResolvedValue({})
    setup(SCALED)
    expect(field('Minimum').value).toBe('-1')
    expect(field('Maximum').value).toBe('1')
    expect(field('Step').value).toBe('0.5')
    expect(field('Anchor 1 value').value).toBe('-1')
    expect(field('Anchor 1 label').value).toBe('strongly negative')
    expect(field('Anchor 2 label').value).toBe('strongly positive')

    fireEvent.click(screen.getByRole('button', { name: 'Remove scale' }))
    // Clearing sends null: the server KEEPS every rating (they stop being
    // interpretable until a scale returns) — the safe edit, offered openly.
    await waitFor(() => expect(setMagnitudeScale).toHaveBeenCalledWith(42, 5, null))
    expect(toastPlain).toHaveBeenCalledWith('Rating scale cleared for "Curriculum fidelity"')
  })

  it('does not offer removal when there is nothing to remove', () => {
    setup(PLAIN)
    expect(screen.queryByRole('button', { name: 'Remove scale' })).toBeNull()
  })

  it('refuses a range whose maximum is not above its minimum, in words, and disables Save', () => {
    setup()
    fireEvent.change(field('Maximum'), { target: { value: '0' } })
    expect(screen.getByText(/The maximum must be greater than the minimum/)).toBeInTheDocument()
    expect(save()).toBeDisabled()
    fireEvent.change(field('Maximum'), { target: { value: '5' } })
    expect(screen.queryByText(/The maximum must be greater than the minimum/)).toBeNull()
    expect(save()).toBeEnabled()
  })

  it('refuses a step larger than the range it divides', () => {
    setup()
    fireEvent.change(field('Step'), { target: { value: '11' } })
    expect(save()).toBeDisabled()
    fireEvent.change(field('Step'), { target: { value: '10' } })
    expect(save()).toBeEnabled()
  })

  it('warns while declaring when the scale is too dense for a row of buttons', () => {
    setup()
    expect(screen.queryByText(/more than 21 points/)).toBeNull()
    fireEvent.change(field('Maximum'), { target: { value: '100' } })
    // 0–100 step 1 is 101 ticks: the strip falls back to a number input, and the
    // researcher learns that HERE, not after the first coder meets it.
    expect(screen.getByText(/more than 21 points, so coders will type a number/)).toBeInTheDocument()
  })
})

describe('MagnitudeScaleDialog — anchors', () => {
  it('adds, labels and removes anchors; an unlabelled anchor is dropped from the payload', async () => {
    setMagnitudeScale.mockResolvedValue({})
    setup()
    expect(screen.getByText(/Labelling at least the two ends/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add anchor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add anchor' }))
    fireEvent.change(field('Anchor 1 value'), { target: { value: '0' } })
    fireEvent.change(field('Anchor 1 label'), { target: { value: '  not a factor ' } })
    fireEvent.change(field('Anchor 2 value'), { target: { value: '10' } })
    // Anchor 2 is left unlabelled: a value with no label is not an anchor.

    fireEvent.click(save())
    await waitFor(() => expect(setMagnitudeScale).toHaveBeenCalledWith(42, 5, {
      min: 0, max: 10, step: 1, anchors: [{ value: 0, label: 'not a factor' }],
    }))
  })

  it('a removed anchor is gone from the draft', async () => {
    setMagnitudeScale.mockResolvedValue({})
    setup(SCALED)
    fireEvent.click(screen.getByRole('button', { name: 'Remove anchor 1' }))
    expect(screen.queryByLabelText('Anchor 2 label')).toBeNull()
    expect(field('Anchor 1 label').value).toBe('strongly positive')
    fireEvent.click(save())
    await waitFor(() => expect(setMagnitudeScale).toHaveBeenCalledWith(42, 5, {
      min: -1, max: 1, step: 0.5, anchors: [{ value: 1, label: 'strongly positive' }],
    }))
  })

  it('names every anchor control so a screen reader can tell row 1 from row 2', () => {
    setup(SCALED)
    for (const n of [1, 2]) {
      expect(screen.getByLabelText(`Anchor ${n} value`)).toBeInTheDocument()
      expect(screen.getByLabelText(`Anchor ${n} label`)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Remove anchor ${n}` })).toBeInTheDocument()
    }
  })
})

describe('MagnitudeScaleDialog — the server is the authority', () => {
  it('surfaces a stranding refusal VERBATIM and stays open', async () => {
    setMagnitudeScale.mockRejectedValue({
      response: { data: { detail: 'Narrowing this scale would leave 3 ratings outside it.' } },
    })
    const { onOpenChange } = setup(SCALED)
    fireEvent.change(field('Maximum'), { target: { value: '0.5' } })
    fireEvent.click(save())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'Narrowing this scale would leave 3 ratings outside it.',
    ))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    // No client-side mirror of the stranding check exists, on purpose: the
    // client cannot see every rating, so the refusal must come from the server.
    expect(setMagnitudeScale).toHaveBeenCalledTimes(1)
  })

  it('falls back to a generic message only when the server sent no words', async () => {
    setMagnitudeScale.mockRejectedValue(new Error('network'))
    setup()
    fireEvent.click(save())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not save the rating scale'))
  })

  it('Cancel closes without saving', () => {
    const { onOpenChange } = setup()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(setMagnitudeScale).not.toHaveBeenCalled()
  })
})
