/**
 * Settings › Coder identity — what a roster change refreshes, and where focus goes.
 *
 * - **10-19 group C item 11 (#964's rule):** creating and unarchiving a coder ADD one,
 *   so the ACTIVE roster (`['coders']`, the one blind mode reads) is RESET, never
 *   invalidated. And the reset must not blank the list holding the pressed button:
 *   DRIVEN, a reset gated through `useCoders().multiCoder` unmounted the whole roster
 *   manager (and its open archived list) for the refetch and said "local-first".
 * - **#1387:** Archive / Unarchive are `aria-disabled` + a guard while busy (Chrome
 *   blurs a focused button that becomes `disabled`), and when the row moves lists the
 *   section heading takes focus — only when focus was lost, never on mount.
 * - **D16 (Batch 10):** the manager mounts on the archive-INCLUSIVE count (`allCoders.length
 *   > 1`) — it holds the only Unarchive buttons, so archived coders stay reachable once you
 *   are the one active coder left. The copy stays on two ACTIVE coders: an archived coder
 *   cannot be picked to code as.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

type C = { id: number; username: string; display_color: null; archived: boolean; coder_type: string }
const coder = (id: number, username: string, archived = false): C =>
  ({ id, username, display_color: null, archived, coder_type: 'human' })

// The server's state; each listCoders call answers from it at call time.
let roster: C[] = []
const answer = (includeArchived?: boolean) => roster.filter(c => includeArchived === true || !c.archived)
let activeGate: Promise<void> | null = null   // hold the ACTIVE roster's refetch open
let allGate: Promise<void> | null = null      // hold the archive-inclusive refetch open

const listCoders = vi.fn(async (includeArchived?: boolean) => {
  const gate = includeArchived === true ? allGate : activeGate
  if (gate) await gate
  return answer(includeArchived)
})
const archiveCoder = vi.fn()
const unarchiveCoder = vi.fn()
const createCoder = vi.fn()
const switchCoder = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  authApi: {
    listCoders: (a?: boolean) => listCoders(a),
    archiveCoder: (id: number) => archiveCoder(id),
    unarchiveCoder: (id: number) => unarchiveCoder(id),
    createCoder: (n: string) => createCoder(n),
    switchCoder: (id: number) => switchCoder(id),
    updateProfile: vi.fn(),
  },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Me' }, refreshAuth: vi.fn(async () => {}) }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

import { CoderIdentitySection } from './SettingsPage'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CoderIdentitySection />
    </QueryClientProvider>,
  )
  return qc
}

const heading = () => screen.getByRole('heading', { name: 'Coder identity' })

beforeEach(() => {
  vi.clearAllMocks()
  activeGate = null
  allGate = null
  roster = [coder(1, 'Me'), coder(2, 'Priya'), coder(3, 'Sam'), coder(4, 'Ola', true)]
})
afterEach(cleanup)

describe('#1387 — Archive / Unarchive while their request runs', () => {
  it('Archive stays focused and operable-looking: aria-disabled, never disabled, and a second press is refused', async () => {
    setup()
    const archive = await screen.findByRole('button', { name: 'Archive Priya' })
    const req = deferred()
    archiveCoder.mockReturnValue(req.promise.then(() => ({})))

    archive.focus()
    fireEvent.click(archive)
    await waitFor(() => expect(archive).toHaveAttribute('aria-disabled', 'true'))
    expect(archive).not.toBeDisabled()
    expect(document.activeElement).toBe(archive)
    fireEvent.click(archive)
    // A mutation calls its fn after microtasks — flush them, or a missing guard passes.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(archiveCoder).toHaveBeenCalledTimes(1)   // the guard is the load-bearing half (#754)
    await act(async () => { req.resolve() })
  })

  it('Unarchive is aria-disabled, never disabled, while it runs', async () => {
    setup()
    fireEvent.click(await screen.findByRole('button', { name: /Show archived/ }))
    const unarchive = screen.getByRole('button', { name: 'Unarchive Ola' })
    const req = deferred()
    unarchiveCoder.mockReturnValue(req.promise.then(() => ({})))
    unarchive.focus()
    fireEvent.click(unarchive)
    await waitFor(() => expect(unarchive).toHaveAttribute('aria-disabled', 'true'))
    expect(unarchive).not.toBeDisabled()
    fireEvent.click(unarchive)
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(unarchiveCoder).toHaveBeenCalledTimes(1)
    await act(async () => { req.resolve() })
  })

  it('when the archived row leaves the list, focus lands on the section heading', async () => {
    setup()
    const archive = await screen.findByRole('button', { name: 'Archive Priya' })
    archiveCoder.mockImplementation(async (id: number) => {
      roster = roster.map(c => (c.id === id ? { ...c, archived: true } : c))
      return {}
    })
    archive.focus()
    fireEvent.click(archive)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive Priya' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('D16 — archiving the LAST other coder keeps the manager (the way back), and focus lands on the heading', async () => {
    roster = [coder(1, 'Me'), coder(2, 'Priya')]
    setup()
    const archive = await screen.findByRole('button', { name: 'Archive Priya' })
    archiveCoder.mockImplementation(async (id: number) => {
      roster = roster.map(c => (c.id === id ? { ...c, archived: true } : c))
      return {}
    })
    archive.focus()
    fireEvent.click(archive)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive Priya' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(heading()))
    // Gated on two ACTIVE coders, the manager unmounted here and Priya could never
    // be unarchived again — the prototype's own test pinned that.
    expect(screen.getByText('Coders on this install')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show archived \(1\)/ }))
    expect(screen.getByRole('button', { name: 'Unarchive Priya' })).toBeInTheDocument()
  })

  it('control: focus the researcher moved somewhere real is never taken', async () => {
    setup()
    const archive = await screen.findByRole('button', { name: 'Archive Priya' })
    const req = deferred()
    archiveCoder.mockImplementation(async (id: number) => {
      await req.promise
      roster = roster.map(c => (c.id === id ? { ...c, archived: true } : c))
      return {}
    })
    archive.focus()
    fireEvent.click(archive)
    const nameField = screen.getByRole('textbox', { name: 'Coder name' })
    nameField.focus()
    await act(async () => { req.resolve() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive Priya' })).toBeNull())
    expect(document.activeElement).toBe(nameField)
  })

  it('control: the page opening does not put focus on the heading', async () => {
    setup()
    await screen.findByRole('button', { name: 'Archive Priya' })
    expect(document.activeElement).toBe(document.body)
  })
})

describe('group C item 11 — a roster change that ADDS a coder resets the active roster', () => {
  it('Unarchive RESETS ["coders"] (honestly unknown) while the manager — and its open archived list — stays mounted', async () => {
    const qc = setup()
    fireEvent.click(await screen.findByRole('button', { name: /Show archived/ }))
    await waitFor(() => expect(qc.getQueryData(['coders'])).toBeDefined())
    unarchiveCoder.mockImplementation(async (id: number) => {
      roster = roster.map(c => (c.id === id ? { ...c, archived: false } : c))
      return {}
    })
    const active = deferred()
    activeGate = active.promise
    const all = deferred()
    allGate = all.promise
    const unarchive = screen.getByRole('button', { name: 'Unarchive Ola' })
    unarchive.focus()
    fireEvent.click(unarchive)

    // The ACTIVE roster has no answer while it refetches: blind mode fails closed (#964).
    await waitFor(() => expect(qc.getQueryState(['coders'])?.status).toBe('pending'))
    expect(qc.getQueryData(['coders'])).toBeUndefined()
    // …and nothing on this screen blanked: the manager, the open archived list and the
    // pressed button are all still there (DRIVEN: gated on the reset roster they were not).
    expect(screen.getByText('Coders on this install')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unarchive Ola' })).toBeInTheDocument()
    expect(screen.queryByText(/local-first/)).toBeNull()

    await act(async () => { active.resolve(); all.resolve() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Ola' })).toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(heading()))
  })

  it('Archive only INVALIDATES (a stale roster still holding the colleague keeps blind mode on)', async () => {
    const qc = setup()
    await waitFor(() => expect(qc.getQueryData(['coders'])).toBeDefined())
    archiveCoder.mockResolvedValue({})
    activeGate = new Promise(() => {})
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Priya' }))
    await waitFor(() => expect(listCoders.mock.calls.filter(c => c[0] !== true).length).toBeGreaterThanOrEqual(2))
    expect(qc.getQueryData(['coders'])).toBeDefined()
  })

  it('Add coder RESETS ["coders"], and closing the form returns focus to "Add coder"', async () => {
    const qc = setup()
    await waitFor(() => expect(qc.getQueryData(['coders'])).toBeDefined())
    createCoder.mockImplementation(async (name: string) => {
      const c = coder(9, name)
      roster = [...roster, c]
      return c
    })
    switchCoder.mockImplementation(async () => coder(9, 'Kim'))
    activeGate = new Promise(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Add coder' }))
    const field = screen.getByRole('textbox', { name: 'New coder name' })
    fireEvent.change(field, { target: { value: 'Kim' } })
    field.focus()
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    await waitFor(() => expect(qc.getQueryState(['coders'])?.status).toBe('pending'))
    expect(qc.getQueryData(['coders'])).toBeUndefined()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add coder' })))
  })
})

describe('group C item 11 — the manager is decided by the archive-inclusive list', () => {
  it('stays mounted, with its list, while the ACTIVE roster has no answer', async () => {
    const qc = setup()
    await screen.findByRole('button', { name: 'Archive Priya' })
    activeGate = new Promise(() => {})
    await act(async () => { void qc.resetQueries({ queryKey: ['coders'], exact: true }) })
    await waitFor(() => expect(qc.getQueryState(['coders'])?.status).toBe('pending'))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })   // let the observers re-render
    expect(screen.queryByText(/local-first/)).toBeNull()
    const manager = screen.getByText('Coders on this install').parentElement as HTMLElement
    expect(within(manager).getByRole('button', { name: 'Archive Priya' })).toBeInTheDocument()
  })
})

describe('D16 — the manager counts archived coders; the copy counts active ones', () => {
  it('one active coder and one archived: the manager is there, Unarchive works, and the copy offers no pick', async () => {
    roster = [coder(1, 'Me'), coder(4, 'Ola', true)]
    setup()
    fireEvent.click(await screen.findByRole('button', { name: /Show archived \(1\)/ }))
    // The copy is about ACTIVE coders: there is nobody else to code as.
    expect(screen.getByText(/local-first/)).toBeInTheDocument()
    expect(screen.queryByText(/Pick a coder below/)).toBeNull()

    unarchiveCoder.mockImplementation(async (id: number) => {
      roster = roster.map(c => (c.id === id ? { ...c, archived: false } : c))
      return {}
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Ola' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Ola' })).toBeInTheDocument())
    // Two active coders again, so now there is someone to pick.
    expect(screen.getByText(/Pick a coder below/)).toBeInTheDocument()
    expect(screen.queryByText(/local-first/)).toBeNull()
  })

  it('control: one coder and nobody archived — no manager, once the list has answered', async () => {
    roster = [coder(1, 'Me')]
    const qc = setup()
    await waitFor(() => expect(qc.getQueryData(['coders', 'all'])).toEqual([coder(1, 'Me')]))
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(screen.queryByText('Coders on this install')).toBeNull()
    expect(screen.getByText(/local-first/)).toBeInTheDocument()
  })
})
