/**
 * #1203 — *Import Project* refuses a wrong file at selection, says the server's
 * reason when the check refuses one, and stays focusable while it checks.
 *
 * Before: no type or size check (a `notes.txt` and a 520 MB file were POSTed
 * whole), a generic "Invalid project file" toast over every refusal — including
 * the newer-version sentence — and `disabled={importValidating}`, which Chrome
 * blurs, so focus sat on <body> and the preview dialog's focus return had no
 * opener (#965 / #959). jsdom does not blur a disabled button, so the ATTRIBUTES
 * are asserted; the focus itself was driven live.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({ list: vi.fn(), validate: vi.fn(), importProject: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  projectsApi: { list: api.list, delete: vi.fn(), update: vi.fn(), create: vi.fn(), get: vi.fn() },
  projectPortabilityApi: { validateImport: api.validate, importProject: api.importProject },
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/lib/theme-context', () => ({ useTheme: () => ({ isDark: false, toggleTheme: () => {} }) }))
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ selectableCoders: [] }), resetCoderRoster: () => Promise.resolve(),
}))
vi.mock('@/hooks/useCoderSwitch', () => ({ useCoderSwitch: () => ({ requestSwitch: () => {}, dialog: null, switching: false }) }))
vi.mock('@/hooks/useCreateCoder', () => ({ useCreateCoder: () => ({ mutate: () => {} }) }))

import Dashboard from './Dashboard'

afterEach(() => {
  cleanup()
  Object.values(api).forEach(f => f.mockReset())
  toast.success.mockReset(); toast.error.mockReset()
})

const MiB = 1024 * 1024
/** The server's own sentence (`project_portability._read_manifest_and_check_format`). */
const NEWER = 'This file was created by a newer version of Mixed Measures (format version 8). '
  + 'Please update to import it.'

/** A file of a given size without allocating it. */
function file(name: string, size = 10) {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

/** Let a rejected or resolved request land. */
async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

async function renderDashboard() {
  api.list.mockResolvedValue({ projects: [] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('No projects yet')
  const button = screen.getByRole('button', { name: 'Import Project' })
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const pick = (f: File) => fireEvent.change(input, { target: { files: [f] } })
  return { button, input, pick }
}

describe('#1203 — a wrong file is refused before it is uploaded', () => {
  it('a text file: no request, the refusal in an alert, focus kept on the button', async () => {
    const { button, pick } = await renderDashboard()
    button.focus()
    pick(file('notes.txt'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“notes.txt” is not a Mixed Measures project file. Import Project takes a Mixed Measures '
      + 'project file (.mmproject), the kind Export Project saves.',
    )
    expect(api.validate).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
  })

  it('a backup is named as one and sent to Restore from a file', async () => {
    const { pick } = await renderDashboard()
    pick(file('auto_20261014_121245.mmbackup'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(/is a backup, not a project file\. To bring a backup back, use Restore from a file in Settings › Backup & Data\./)
    expect(api.validate).not.toHaveBeenCalled()
  })

  it('a 600 MB project file is refused with the 500 MB limit, nothing sent', async () => {
    const { pick } = await renderDashboard()
    pick(file('big.mmproject', 600 * MiB))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(/“big\.mmproject” is 600\.0 MB, over the 500 MB limit for a project file\./)
    expect(api.validate).not.toHaveBeenCalled()
  })

  it('the same refusal twice is announced twice — the alert is a NEW element', async () => {
    const { pick } = await renderDashboard()
    pick(file('notes.txt'))
    await flush()
    const first = screen.getByRole('alert')
    pick(file('notes.txt'))
    await flush()
    expect(screen.getByRole('alert')).not.toBe(first)
  })

  it('the next pick that passes clears the refusal and is checked', async () => {
    api.validate.mockReturnValue(new Promise(() => {}))
    const { pick } = await renderDashboard()
    pick(file('notes.txt'))
    await flush()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    const good = file('COPY.MMPROJECT')
    pick(good)
    await flush()
    expect(api.validate).toHaveBeenCalledWith(good)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('#1203 — a refused check says the server’s reason', () => {
  it('a file from a NEWER version: the server’s sentence verbatim, in the alert, no toast', async () => {
    api.validate.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 400, response: { status: 400, data: { detail: NEWER } },
    }))
    const { pick } = await renderDashboard()
    pick(file('from-1.6.mmproject'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(NEWER)
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('no answer at all: says so, and that nothing was imported', async () => {
    api.validate.mockRejectedValue(new TypeError('Failed to fetch'))
    const { pick } = await renderDashboard()
    pick(file('a.mmproject'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Mixed Measures did not answer while checking “a.mmproject”, so nothing was imported.',
    )
  })

  it('an answer with no reason: the file could not be read as a project file', async () => {
    api.validate.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 500, response: { status: 500, data: {} },
    }))
    const { pick } = await renderDashboard()
    pick(file('a.mmproject'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('“a.mmproject” could not be read as a project file.')
  })
})

describe('#1203 — Import Project stays focusable while it checks (#965)', () => {
  it('aria-disabled + aria-busy, NOT disabled; focus kept; a second pick checks nothing more', async () => {
    api.validate.mockReturnValue(new Promise(() => {}))
    const { button, input, pick } = await renderDashboard()
    button.focus()
    pick(file('a.mmproject'))
    await flush()

    const busy = screen.getByRole('button', { name: 'Validating...' })
    expect(busy).toBe(button)
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).not.toBeDisabled()
    expect(document.activeElement).toBe(busy)

    // The handler's own refusal: a REF, because its `useCallback` deps are `[]`.
    pick(file('b.mmproject'))
    await flush()
    expect(api.validate).toHaveBeenCalledTimes(1)

    // …and the button's: it does not reopen the picker.
    const opens = vi.spyOn(input, 'click')
    fireEvent.click(busy)
    expect(opens).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: at rest the button opens the picker', async () => {
    const { button, input } = await renderDashboard()
    const opens = vi.spyOn(input, 'click')
    fireEvent.click(button)
    expect(opens).toHaveBeenCalledTimes(1)
    expect(button).not.toHaveAttribute('aria-disabled')
  })
})
