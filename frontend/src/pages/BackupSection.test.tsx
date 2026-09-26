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
vi.mock('@/components/BackupHistorySection', () => ({ default: () => null }))
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
