/**
 * Settings › Backup & Data — the three buttons that start a backup-side request
 * (#1025).
 *
 * - **Busy is `aria-disabled` + a refusal, never `disabled`.** Chrome blurs a
 *   focused button that becomes `disabled`, so a keyboard user pressing Backup now
 *   landed on `<body>` for the whole wait — tens of seconds on a large project
 *   (Download Backup measured 42 s on a 546 MB database). jsdom does not blur, so
 *   the ATTRIBUTE is asserted; the focus itself was driven live.
 * - **A refusal says what to do.** The server's sentence (a locked database: "close
 *   it, then try again") reaches the toast; Download Backup used to print "Failed
 *   to create backup" whatever the server said.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({
  status: vi.fn(),
  create: vi.fn(),
  now: vi.fn(),
  validate: vi.fn(),
  validateLocal: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  backupApi: api,
  authApi: {},
  MAX_BACKUP_UPLOAD_BYTES: 500 * 1024 * 1024,
}))
// The history list is its own test's subject; here it is the OTHER door, so the
// mock keeps what the section hands it (#1162: which row's check is running).
const history = vi.hoisted(() => ({
  props: null as null | {
    onRestore: (b: { filename: string; created_at: string; size_bytes: number; backup_type: string }) => void
    restoreBusy?: boolean
    checkingFilename?: string | null
  },
}))
vi.mock('@/components/BackupHistorySection', () => ({
  default: (props: NonNullable<typeof history.props>) => { history.props = props; return null },
}))
vi.mock('@/components/SafetyCopiesSection', () => ({ default: () => null }))
vi.mock('@/components/RestoreBackupDialog', () => ({ default: () => null }))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { BackupSection } from './SettingsPage'

const BUSY = 'The backup was not taken: another program kept the database locked for the 19 seconds it waited. Nothing was saved. If another program has the Mixed Measures database open, close it, then try again.'

/** The shape `lib/api/client.ts` throws for a refused request. */
function refusal(detail: string) {
  return Object.assign(new Error(detail), { response: { status: 409, data: { detail } } })
}

/** A request the test finishes by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** TanStack starts a mutation's request a turn AFTER `mutate()`, so a call count
 * taken synchronously after a click cannot see a duplicate (09-24e). */
async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BackupSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.status.mockResolvedValue({
    last_backup_at: null, backup_count: 0, total_size_bytes: 0, is_stale: false, next_backup_at: null,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe.each([
  { label: 'Backup now', busyLabel: /Snapshotting/, call: api.now },
  { label: 'Download Backup', busyLabel: /Creating/, call: api.create },
])('$label while its request runs', ({ label, busyLabel, call }) => {
  it('stays focusable, says it is busy, and refuses a second press', async () => {
    const pending = deferred<never>()
    call.mockReturnValue(pending.promise)
    renderSection()
    const button = screen.getByRole('button', { name: label })
    button.focus()
    fireEvent.click(button)
    await flush()

    const busy = screen.getByRole('button', { name: busyLabel })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).not.toBeDisabled()
    expect(document.activeElement).toBe(busy)

    fireEvent.click(busy)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("shows the server's sentence when the backup is refused", async () => {
    call.mockRejectedValue(refusal(BUSY))
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(BUSY, expect.anything()))
    // And the button is live again, for the retry the sentence asks for.
    expect(screen.getByRole('button', { name: label })).not.toHaveAttribute('aria-disabled')
  })
})

it('Restore from a file stays focusable while the chosen file is checked', async () => {
  const pending = deferred<never>()
  api.validate.mockReturnValue(pending.promise)
  const { container } = renderSection()
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'b.mmbackup')] } })
  await flush()

  const busy = screen.getByRole('button', { name: /Validating/ })
  expect(busy).toHaveAttribute('aria-disabled', 'true')
  expect(busy).not.toBeDisabled()

  // …and its refusal: a press while the check runs does not open the file picker.
  const pick = vi.spyOn(input, 'click')
  fireEvent.click(busy)
  expect(pick).not.toHaveBeenCalled()
})

describe('#1043 — the section states THIS install’s automatic schedule', () => {
  const status = (hours: number | null, keep: number | null, extra: object = {}) => ({
    last_backup_at: '2026-10-04T12:00:00+00:00', backup_count: 1, total_size_bytes: 1,
    is_stale: false, next_backup_at: null,
    auto_backup_interval_hours: hours, auto_backup_max_count: keep, ...extra,
  })

  it('says the schedule the server reports, not the default', async () => {
    api.status.mockResolvedValue(status(2, 3))
    renderSection()
    expect(await screen.findByText(/taken at most every 2 hours while Mixed Measures is open/)).toBeInTheDocument()
    expect(screen.queryByText(/every 4 hours/)).not.toBeInTheDocument()
  })

  it('says automatic backups are off when the interval is 0', async () => {
    api.status.mockResolvedValue(status(0, 5))
    renderSection()
    expect(await screen.findByText(/Automatic backups are turned off on this installation/)).toBeInTheDocument()
    expect(screen.getByText(/Automatic backups are off/, { selector: 'p' })).toBeInTheDocument()
    expect(screen.queryByText(/hourly/)).not.toBeInTheDocument()
  })

  it('states no number before the server answers', () => {
    api.status.mockReturnValue(new Promise(() => {}))
    renderSection()
    // #961: and no "No backups yet" — that is an answer, and none has come.
    expect(screen.queryByText(/No backups yet/)).not.toBeInTheDocument()
    expect(screen.getByText(/backups are a separate safety snapshot/)).toBeInTheDocument()
    expect(screen.queryByText(/hourly/)).not.toBeInTheDocument()
  })
})

describe('#1162 — the wait shows on the control that was pressed', () => {
  const ROW = {
    filename: 'auto_20261014_121245.mmbackup', created_at: '2026-10-14T12:12:45+00:00',
    size_bytes: 1, backup_type: 'auto',
  }

  it('a history row’s check: the file button refuses but is NOT busy, and the row is told', async () => {
    api.validateLocal.mockReturnValue(new Promise(() => {}))
    renderSection()
    act(() => history.props!.onRestore(ROW))
    await flush()
    const file = screen.getByRole('button', { name: 'Restore from a file' })
    expect(file).toHaveAttribute('aria-disabled', 'true')
    expect(file).not.toHaveAttribute('aria-busy')
    expect(screen.queryByText(/Validating/)).not.toBeInTheDocument()
    expect(history.props!.restoreBusy).toBe(true)
    expect(history.props!.checkingFilename).toBe(ROW.filename)
  })

  it('an upload’s check: the file button is busy, and no row is', async () => {
    api.validate.mockReturnValue(new Promise(() => {}))
    const { container } = renderSection()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.mmbackup')] } })
    await flush()
    expect(screen.getByRole('button', { name: /Validating/ })).toHaveAttribute('aria-busy', 'true')
    expect(history.props!.restoreBusy).toBe(true)
    expect(history.props!.checkingFilename).toBeNull()
  })
})

describe('#1163 — Restore from a file refuses a wrong file before uploading it', () => {
  /** A file of a given size without allocating it. */
  const file = (name: string, size = 10) => {
    const f = new File(['x'], name)
    Object.defineProperty(f, 'size', { value: size })
    return f
  }
  const pick = (container: HTMLElement, f: File) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [f] } })
  }

  it('a 600 MB video is the wrong KIND of file — said under the button, nothing uploaded', async () => {
    const { container } = renderSection()
    const button = screen.getByRole('button', { name: 'Restore from a file' })
    button.focus()
    pick(container, file('interview.mp4', 600 * 1024 * 1024))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“interview.mp4” is not a backup file. Restore from a file takes a Mixed Measures backup (.mmbackup), the kind Download Backup saves.',
    )
    expect(api.validate).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  it('a project file is named as one, and pointed at Import Project', async () => {
    const { container } = renderSection()
    pick(container, file('Northgate.mmproject'))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(/“Northgate\.mmproject” is a project file, not a backup\. To bring it in, use Import Project on the Projects page\./)
    expect(api.validate).not.toHaveBeenCalled()
  })

  it('an oversize backup is refused with the limit spelled "500 MB" (#1164 g)', async () => {
    const { container } = renderSection()
    pick(container, file('big.mmbackup', 501 * 1024 * 1024))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(/over the 500 MB limit for a backup from another computer/)
    expect(api.validate).not.toHaveBeenCalled()
  })

  it('a backup in capitals is taken, and the last refusal is cleared', async () => {
    api.validate.mockReturnValue(new Promise(() => {}))
    const { container } = renderSection()
    pick(container, file('notes.txt'))
    await flush()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    const copy = file('COPY.MMBACKUP')
    pick(container, copy)
    await flush()
    expect(api.validate).toHaveBeenCalledWith(copy)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

it('#1164 (g) — the stated limit is "500 MB", as the server says it, never "500.0 MB"', () => {
  renderSection()
  const note = screen.getByText(/A backup from another computer can be up to/)
  expect(note).toHaveTextContent('can be up to 500 MB.')
  expect(note).not.toHaveTextContent('500.0')
})

describe('#1186 — when the next automatic backup is due', () => {
  const base = {
    backup_count: 1, total_size_bytes: 1, is_stale: false,
    auto_backup_interval_hours: 4, auto_backup_max_count: 5,
  }

  it('carries a DATE when it is not today — a bare time read a days-old projection as today', async () => {
    api.status.mockResolvedValue({
      ...base, last_backup_at: '2026-10-04T12:00:00+00:00', next_backup_at: '2030-01-02T15:00:00+00:00',
    })
    renderSection()
    const line = await screen.findByText(/Last backup:/)
    expect(line.textContent).toMatch(/Next automatic backup on .*2030.* at /)
  })

  it('with no backups yet, says when the first automatic one is due', async () => {
    api.status.mockResolvedValue({
      ...base, backup_count: 0, last_backup_at: null, next_backup_at: '2030-01-02T15:00:00+00:00',
    })
    renderSection()
    expect(await screen.findByText(/^No backups yet\. The first automatic backup is due on .*2030.*, or use Backup now to take one straight away\.$/))
      .toBeInTheDocument()
  })

  it('…and promises none when automatic backups are off', async () => {
    api.status.mockResolvedValue({
      ...base, backup_count: 0, last_backup_at: null, next_backup_at: null, auto_backup_interval_hours: 0,
    })
    renderSection()
    expect(await screen.findByText('No backups yet. Use Backup now to create your first snapshot.')).toBeInTheDocument()
  })
})

/**
 * #1199 — the freshness line's third answer. The server gives NO time when every
 * backup is dated more than an hour past this computer's clock (it used to report a
 * 2030 file as "Last backup: just now"). Backups exist — Backup history lists them
 * just below — so "No backups yet", keyed on the null time, was false.
 */
describe('#1199 — backups that are all dated ahead of this computer’s clock', () => {
  const ahead = { last_backup_at: null, total_size_bytes: 3, is_stale: true, auto_backup_max_count: 5 }

  it('says they exist, why no time is shown, and when the next one is due — never "No backups yet"', async () => {
    api.status.mockResolvedValue({
      ...ahead, backup_count: 3, next_backup_at: '2030-01-02T15:00:00+00:00', auto_backup_interval_hours: 4,
    })
    renderSection()
    const line = await screen.findByText(/^All 3 of your backups are dated later than this computer’s clock/)
    expect(line).toHaveTextContent(
      /^All 3 of your backups are dated later than this computer’s clock, so Mixed Measures cannot tell how recent they are — the clock may have been set back\. The next automatic backup is due on .*2030.*, or use Backup now to take one straight away\.$/,
    )
    expect(line).toHaveClass('text-amber-600')
    expect(screen.queryByText(/No backups yet/)).not.toBeInTheDocument()
  })

  it('one backup, automatic backups off: singular, and Backup now is the way on', async () => {
    api.status.mockResolvedValue({ ...ahead, backup_count: 1, next_backup_at: null, auto_backup_interval_hours: 0 })
    renderSection()
    expect(await screen.findByText(
      'Your only backup is dated later than this computer’s clock, so Mixed Measures cannot tell how recent '
      + 'it is — the clock may have been set back. Use Backup now to take one straight away.',
    )).toBeInTheDocument()
  })
})

it('#1164 (b) — the explanation says what Backup now does, in the server’s numbers', async () => {
  api.status.mockResolvedValue({
    last_backup_at: '2026-10-04T12:00:00+00:00', backup_count: 1, total_size_bytes: 1, is_stale: false,
    next_backup_at: null, auto_backup_interval_hours: 6, auto_backup_max_count: 3,
  })
  renderSection()
  await screen.findByText(/taken at most every 6 hours/)
  fireEvent.click(screen.getByRole('button', { name: /saved and backed up/ }))
  const popover = await screen.findByLabelText('Saved vs. backed up')
  expect(popover).toHaveTextContent(
    'It is kept with the automatic backups, so once there are 3 it replaces the oldest. The next automatic backup then comes 6 hours after it.',
  )
  expect(popover).not.toHaveTextContent(/extra fresh snapshot/)
  // Held to the room Radix measures, scrolling inside: 503 px tall at 640×360 ran
  // 334 px off the window (technique only — jsdom has no layout).
  expect(popover).toHaveClass('max-h-[var(--radix-popover-content-available-height)]', 'overflow-y-auto')
})

it('#908 — the backup count is separated by a real space, not only a margin', async () => {
  api.status.mockResolvedValue({
    last_backup_at: '2026-10-04T12:00:00+00:00', backup_count: 2, total_size_bytes: 2048,
    is_stale: false, next_backup_at: null, auto_backup_interval_hours: 0, auto_backup_max_count: 5,
  })
  renderSection()
  const line = await screen.findByText(/Last backup:/)
  expect(line.textContent).toMatch(/off \(2 backups, /)
})
