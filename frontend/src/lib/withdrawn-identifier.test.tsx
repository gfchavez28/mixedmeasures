/**
 * #1190 (D12) — the one helper every participant-create caller asks through, and the
 * dialog it asks with.
 *
 * The refusal is a 409 whose `detail` is `{ error: 'withdrawn_identifier', message }`
 * (the lead's contract with the server). Every other 409 — the duplicate identifier,
 * whose detail is a STRING — must reach the caller exactly as before, because the grid
 * turns it into "link to the existing participant".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import {
  createConfirmingWithdrawn, withdrawnIdentifierMessage, WITHDRAWN_FALLBACK_MESSAGE,
} from './withdrawn-identifier'
import { useWithdrawnIdentifierConfirm } from '@/hooks/useWithdrawnIdentifierConfirm'

afterEach(cleanup)

const SENTENCE = 'This ID belongs to a participant who withdrew from this project; '
  + 'creating it adds them back.'
const withdrawn = (message: unknown = SENTENCE) => Object.assign(new Error('409'), {
  status: 409, response: { status: 409, data: { detail: { error: 'withdrawn_identifier', message } } },
})
const duplicate = () => Object.assign(new Error('dup'), {
  status: 409, response: { status: 409, data: { detail: "Participant with identifier 'P07' already exists" } },
})

describe('withdrawnIdentifierMessage', () => {
  it('reads the server’s sentence off the withdrawn-identifier refusal', () => {
    expect(withdrawnIdentifierMessage(withdrawn())).toBe(SENTENCE)
  })

  it('is null for every OTHER 409 and for any other status', () => {
    expect(withdrawnIdentifierMessage(duplicate())).toBeNull()
    const other409 = { status: 409, response: { data: { detail: { error: 'merge_divergence', message: 'x' } } } }
    expect(withdrawnIdentifierMessage(other409)).toBeNull()
    const wrongStatus = { ...withdrawn(), status: 400, response: { status: 400, data: withdrawn().response.data } }
    expect(withdrawnIdentifierMessage(wrongStatus)).toBeNull()
    expect(withdrawnIdentifierMessage(new TypeError('Failed to fetch'))).toBeNull()
    expect(withdrawnIdentifierMessage(null)).toBeNull()
  })

  it('a named refusal with no sentence still asks, in a sentence of its own', () => {
    expect(withdrawnIdentifierMessage(withdrawn('  '))).toBe(WITHDRAWN_FALLBACK_MESSAGE)
    expect(withdrawnIdentifierMessage(withdrawn(null))).toBe(WITHDRAWN_FALLBACK_MESSAGE)
  })
})

describe('createConfirmingWithdrawn', () => {
  it('an ordinary create asks nothing and sends no override', async () => {
    const create = vi.fn(async () => 'made')
    const ask = vi.fn()
    expect(await createConfirmingWithdrawn(create, ask)).toBe('made')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('the refusal: asks with the server’s sentence, and "yes" retries WITH the override', async () => {
    const create = vi.fn().mockRejectedValueOnce(withdrawn()).mockResolvedValueOnce('made')
    const ask = vi.fn(async () => true)
    expect(await createConfirmingWithdrawn(create, ask)).toBe('made')
    expect(ask).toHaveBeenCalledWith(SENTENCE)
    expect(create.mock.calls).toEqual([[false], [true]])
  })

  it('"no" creates nothing and resolves null', async () => {
    const create = vi.fn().mockRejectedValueOnce(withdrawn())
    expect(await createConfirmingWithdrawn(create, async () => false)).toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('🔴 a duplicate 409 is rethrown untouched — never asked about, never retried', async () => {
    const dup = duplicate()
    const create = vi.fn().mockRejectedValue(dup)
    const ask = vi.fn(async () => true)
    await expect(createConfirmingWithdrawn(create, ask)).rejects.toBe(dup)
    expect(ask).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })
})

/** A caller shaped like the two real ones: a button that creates through the helper. */
function Caller({ create }: { create: (confirm: boolean) => Promise<string> }) {
  const { ask, dialog } = useWithdrawnIdentifierConfirm()
  const [result, setResult] = useState('')
  return (
    <>
      <button onClick={async () => setResult(String(await createConfirmingWithdrawn(create, ask)))}>
        Create
      </button>
      <output>{result}</output>
      {dialog}
    </>
  )
}

describe('useWithdrawnIdentifierConfirm — the dialog', () => {
  it('shows the server’s sentence; "Create anyway" sends the override', async () => {
    const create = vi.fn().mockRejectedValueOnce(withdrawn()).mockResolvedValueOnce('made')
    render(<Caller create={create} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Add a participant who withdrew?' })
    expect(dialog).toHaveAccessibleDescription(SENTENCE)
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('made'))
    expect(create.mock.calls).toEqual([[false], [true]])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('Cancel creates nothing, and focus goes back to the button pressed', async () => {
    const create = vi.fn().mockRejectedValueOnce(withdrawn())
    render(<Caller create={create} />)
    const opener = screen.getByRole('button', { name: 'Create' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('null'))
    expect(create).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('the confirm is not styled as a destructive act', async () => {
    render(<Caller create={vi.fn().mockRejectedValueOnce(withdrawn())} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const confirm = await screen.findByRole('button', { name: 'Create anyway' })
    expect(confirm.className).not.toMatch(/destructive/)
  })
})
