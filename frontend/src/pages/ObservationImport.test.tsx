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
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
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

import ObservationImport from './ObservationImport'

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
