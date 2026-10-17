/**
 * ObservationImport — the confirm step (#638).
 *
 * The wizard used to create, attach AND cut in one click, so the clip count, the
 * cue-file warnings and the MAX_CLIPS refusal all arrived only after the clips
 * were written. `previewSegmentation` had shipped — endpoint, client method and
 * all — and was called by nothing; its only occurrence in `src/` was its own
 * definition.
 *
 * The load-bearing pins here are the ones a green suite would otherwise miss:
 * that reaching the confirm step writes NO clips, and that going back and
 * previewing again does not re-upload the recording.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const create = vi.fn()
const upload = vi.fn()
const previewSegmentation = vi.fn()
const cutSegmentation = vi.fn()
const getObservation = vi.fn()
const remove = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    observationsApi: {
      ...actual.observationsApi,
      create: (...a: unknown[]) => create(...a),
      previewSegmentation: (...a: unknown[]) => previewSegmentation(...a),
      cutSegmentation: (...a: unknown[]) => cutSegmentation(...a),
      get: (...a: unknown[]) => getObservation(...a),
      remove: (...a: unknown[]) => remove(...a),
    },
    mediaApi: { ...actual.mediaApi, upload: (...a: unknown[]) => upload(...a) },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, project: { id: 1, name: 'P' } }),
}))

vi.mock('@/lib/pending-import-files', () => ({
  consumePendingImportFiles: () => null,
}))

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import ObservationImport from './ObservationImport'
import { ApiError } from '@/lib/api/client'

const OBS = { id: 7, name: 'rec', has_media: true }

const PREVIEW = {
  total_segments: 12,
  segments: [
    { sequence_order: 0, start_time: 4.58, end_time: 9.43, label: 'Testing, testing' },
    { sequence_order: 1, start_time: 9.77, end_time: 16.04, label: 'A cloud test' },
  ],
  warnings: ['This looks like a transcript — the cues name speakers.'],
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}><ObservationImport /></QueryClientProvider>
    </MemoryRouter>,
  )
}

/** Walk step 1 → step 2 with a recording chosen. */
function chooseRecording(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], 'rec.mp4', { type: 'video/mp4' })
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

async function reachSetupWithCueFile(container: HTMLElement) {
  chooseRecording(container)
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('radio', { name: /From a cue file/ }))
  const inputs = container.querySelectorAll('input[type="file"]')
  const cueInput = inputs[inputs.length - 1] as HTMLInputElement
  fireEvent.change(cueInput, {
    target: { files: [new File(['WEBVTT'], 'cues.vtt', { type: 'text/vtt' })] },
  })
}

beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn(),
  })
  create.mockResolvedValue(OBS)
  upload.mockResolvedValue({})
  previewSegmentation.mockResolvedValue(PREVIEW)
  cutSegmentation.mockResolvedValue({
    observation: OBS, created: 12, warnings: [],
  })
  getObservation.mockResolvedValue(OBS)
  remove.mockResolvedValue({})
})

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('ObservationImport confirm step (#638)', () => {
  it('previews before cutting — and writes NO clips to get there', async () => {
    const { container } = renderPage()
    await reachSetupWithCueFile(container)

    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))

    await waitFor(() => expect(previewSegmentation).toHaveBeenCalledTimes(1))
    // The whole point: reaching the confirm step commits nothing.
    expect(cutSegmentation).not.toHaveBeenCalled()

    expect(await screen.findByText(/12 clips from this recording/)).toBeInTheDocument()
  })

  it('surfaces the cue-file warning while "import as a Conversation" is still a choice', async () => {
    const { container } = renderPage()
    await reachSetupWithCueFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))

    expect(await screen.findByText(/looks like a transcript/)).toBeInTheDocument()
    expect(cutSegmentation).not.toHaveBeenCalled()
  })

  it('never implies the shown clips are the whole cut', async () => {
    const { container } = renderPage()
    await reachSetupWithCueFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))

    // 12 total, 2 returned — `segments` is only a head.
    expect(await screen.findByText(/Showing the first 2 of 12/)).toBeInTheDocument()
  })

  it('cuts only on the explicit confirm', async () => {
    const { container } = renderPage()
    await reachSetupWithCueFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Cut 12 clips' }))
    await waitFor(() => expect(cutSegmentation).toHaveBeenCalledTimes(1))
  })

  it('going Back and previewing again does NOT re-upload the recording', async () => {
    const { container } = renderPage()
    await reachSetupWithCueFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))
    await screen.findByText(/12 clips from this recording/)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview clips' }))
    await waitFor(() => expect(previewSegmentation).toHaveBeenCalledTimes(2))

    // The expensive part happens ONCE. This is why `staged` exists.
    expect(create).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('"Start empty" has nothing to preview, so it commits straight through', async () => {
    const { container } = renderPage()
    chooseRecording(container)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    // 'none' is the default mode.
    fireEvent.click(screen.getByRole('button', { name: 'Create observation' }))

    await waitFor(() => expect(cutSegmentation).toHaveBeenCalledTimes(1))
    expect(previewSegmentation).not.toHaveBeenCalled()
  })

  it('a failed preview KEEPS the recording, so a retry costs no second upload', async () => {
    previewSegmentation.mockRejectedValueOnce(new Error('could not read the length'))
    const { container } = renderPage()
    await reachSetupWithCueFile(container)

    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))
    await waitFor(() => expect(previewSegmentation).toHaveBeenCalledTimes(1))

    // Still on setup, recording banked, and the observation NOT deleted.
    expect(screen.getByRole('button', { name: 'Preview clips' })).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))
    await waitFor(() => expect(previewSegmentation).toHaveBeenCalledTimes(2))
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

/** A promise the test settles by hand, so the busy window can be inspected. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe('a failed preview or cut is heard, and keeps focus (#1195)', () => {
  it('the refusal is an alert, and focus stays on the pressed button through the wait', async () => {
    const pending = deferred<never>()
    previewSegmentation.mockReturnValueOnce(pending.promise)
    const { container } = renderPage()
    await reachSetupWithCueFile(container)

    const button = screen.getByRole('button', { name: 'Preview clips' })
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(previewSegmentation).toHaveBeenCalledTimes(1))

    // Busy: still the SAME focused element — announced busy and unavailable,
    // never natively disabled (which blurs it to <body>).
    const busy = screen.getByRole('button', { name: 'Working out the clips…' })
    expect(busy).toBe(button)
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toBeDisabled()
    expect(document.activeElement).toBe(button)
    expect(document.activeElement).not.toBe(document.body)

    pending.reject(new ApiError(400, { detail: 'This recording has no length we can read.' }, {}))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This recording has no length we can read.')
    expect(screen.getByRole('button', { name: 'Preview clips' })).toBe(document.activeElement)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('a second press while it works sends nothing — and Back waits too', async () => {
    const pending = deferred<typeof PREVIEW>()
    previewSegmentation.mockReturnValueOnce(pending.promise)
    const { container } = renderPage()
    await reachSetupWithCueFile(container)

    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))
    await waitFor(() => expect(previewSegmentation).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Working out the clips…' }))
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(back)
    // The guard runs before any await in the handler; WAIT anyway, so a guard
    // that moved after one would still be caught (csv-reading.md §4).
    await settle()
    expect(previewSegmentation).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Starting clips')).toBeInTheDocument()

    pending.resolve(PREVIEW)
    expect(await screen.findByText(/12 clips from this recording/)).toBeInTheDocument()
  })

  it('the cut keeps focus while it works and a second press sends nothing', async () => {
    const pending = deferred<never>()
    cutSegmentation.mockReturnValueOnce(pending.promise)
    const { container } = renderPage()
    await reachSetupWithCueFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Preview clips' }))

    const cut = await screen.findByRole('button', { name: 'Cut 12 clips' })
    cut.focus()
    fireEvent.click(cut)
    await waitFor(() => expect(cutSegmentation).toHaveBeenCalledTimes(1))

    const busy = screen.getByRole('button', { name: 'Cutting clips…' })
    expect(busy).toBe(cut)
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).not.toBeDisabled()
    expect(document.activeElement).toBe(cut)
    fireEvent.click(busy)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await settle()
    expect(cutSegmentation).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Cutting clips…' })).toBeInTheDocument()
  })
})

describe('the rail shows only the steps this import takes (#1184)', () => {
  const railSteps = () => {
    const rail = screen.getByRole('navigation', { name: 'Import progress' })
    return within(rail).getAllByRole('listitem').map(li => ({
      label: li.textContent?.replace(/^\d/, '').replace(', completed', ''),
      state: li.getAttribute('data-step-state'),
    }))
  }

  it('"Start empty" never shows Confirm clips — so it can never read as done', async () => {
    const { container } = renderPage()
    chooseRecording(container)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(railSteps().map(s => s.label)).toEqual(['Upload', 'Set up clips', 'Results'])

    fireEvent.click(screen.getByRole('button', { name: 'Create observation' }))
    await screen.findByText(/"rec" is ready/)
    expect(railSteps()).toEqual([
      { label: 'Upload', state: 'done' },
      { label: 'Set up clips', state: 'done' },
      { label: 'Results', state: 'current' },
    ])
  })

  it('a mode that previews puts Confirm clips on the rail, while still on Set up', async () => {
    const { container } = renderPage()
    await reachSetupWithCueFile(container)
    expect(railSteps().map(s => s.label)).toEqual(['Upload', 'Set up clips', 'Confirm clips', 'Results'])
    expect(railSteps()[1].state).toBe('current')
  })
})

describe('the recording drop takes ONE recording and says so (#1161)', () => {
  const zone = () => screen.getByText(/Drag and drop a recording here/).closest('div') as HTMLElement
  const rec = (name: string) => new File(['x'], name, { type: '' })

  it('two recordings: the first is taken and the second is named', () => {
    renderPage()
    fireEvent.drop(zone(), { dataTransfer: { files: [rec('a.mp4'), rec('b.mov')] } })
    expect(screen.getByLabelText('Name')).toHaveValue('a')
    expect(toasts.error).toHaveBeenCalledWith('Only one recording can be added — “b.mov” was not added.')
  })

  it('a wrong file first is skipped to the recording after it, and named', () => {
    renderPage()
    fireEvent.drop(zone(), { dataTransfer: { files: [rec('notes.pdf'), rec('b.mov')] } })
    expect(screen.getByLabelText('Name')).toHaveValue('b')
    expect(toasts.error).toHaveBeenCalledWith(
      '“notes.pdf” is not a recording file. A recording can be MP3, M4A, WAV audio; MP4, MOV, WebM video.')
  })

  it('nothing a recording: nothing is taken, and the sentence names the file', () => {
    renderPage()
    fireEvent.drop(zone(), { dataTransfer: { files: [rec('notes.pdf')] } })
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/^“notes\.pdf” is not a recording file/))
  })

  it('one recording: taken, and nothing is said', () => {
    renderPage()
    fireEvent.drop(zone(), { dataTransfer: { files: [rec('a.mp4')] } })
    expect(screen.getByLabelText('Name')).toHaveValue('a')
    expect(toasts.error).not.toHaveBeenCalled()
  })
})
