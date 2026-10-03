/**
 * #1023 — an undo or redo of a code-set choice acts on the passage the choice
 * was made on, whatever is selected when it runs.
 *
 * **The defect.** The four coding surfaces each built the history entry
 * themselves, and each entry replayed through this component's `useMutation`,
 * whose `mutationFn` read the `target` PROP. TanStack builds every mutation from
 * the LATEST render's options, so after the researcher moved on, Ctrl+Z cleared
 * the passage selected NOW and left the intended one standing — reproduced live:
 * the choice was made on segment 1 and the undo wrote segment 2.
 *
 * 🔴 **Every case here moves the target between the act and the replay.** A test
 * that undoes without first changing the selection cannot see this class
 * (the internal design notes); the audit's own scratch repro had exactly
 * this shape, and the harness below is it, with a REAL `useHistory`.
 *
 * Riders from the same entry, each on the same act: the RATING the swap deletes
 * comes back with the value it undoes to (#868 (f)'s rule, reached through this
 * door), the host's refresh is the one current at the act, a failure is reported
 * once, and the four hosts pass their stack rather than a copy of the builder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { CodeSet, CodeSetMember } from '@/lib/api'
import { ApiError } from '@/lib/api/client'
import type { SelectionDetail } from '@/lib/code-sets'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles } from '@/test-support/source-tree'

const api = vi.hoisted(() => ({
  listSets: vi.fn(),
  selectOnSegment: vi.fn(),
  selectOnText: vi.fn(),
  rateSegment: vi.fn(),
  rateText: vi.fn(),
  applySegment: vi.fn(),
  applyText: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codeSetsApi: {
      list: (...a: unknown[]) => api.listSets(...a),
      selectOnSegment: (...a: unknown[]) => api.selectOnSegment(...a),
      selectOnText: (...a: unknown[]) => api.selectOnText(...a),
    },
    codingApi: {
      setMagnitude: (...a: unknown[]) => api.rateSegment(...a),
      applyCode: (...a: unknown[]) => api.applySegment(...a),
    },
    textCodingApi: {
      setMagnitude: (...a: unknown[]) => api.rateText(...a),
      applyCode: (...a: unknown[]) => api.applyText(...a),
    },
  }
})

// `useHistory` toasts through the same module, so these count BOTH reporters.
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => api.toastError(...a),
    warning: (...a: unknown[]) => api.toastWarning(...a),
    success: vi.fn(),
  },
}))

import { CodeSetStrip, type CodeSetTarget } from './CodeSetStrip'
import { useHistory } from '@/hooks/useHistory'

const SELF = 5
const member = (id: number, name: string): CodeSetMember => ({
  id, numeric_id: id, name, description: null, color: null,
  is_active: true, is_universal: false,
})
// Non-contiguous ids, so an implementation keyed by position cannot pass.
const STANCE: CodeSet = {
  id: 7, project_id: 1, label: 'Stance', description: null, exhaustive: false,
  members: [member(11, 'Positive'), member(23, 'Negative'), member(47, 'Neutral')],
  set_basis: 'inclusive_with_none', composition_warnings: [],
  claimants: [11, 23, 47].map((id) => ({ code_id: id, value_id: id })),
  created_at: '', updated_at: '',
}

/** The host's live codes list — every value active, under its set name. */
const LIVE = STANCE.members.map(({ id, name }) => ({ id, name, is_active: true, is_universal: false }))

const held = (code_id: number, magnitude: number | null = null): SelectionDetail =>
  ({ code_id, user_id: SELF, magnitude })
const seg = (segmentId: number): CodeSetTarget => ({ kind: 'segment', segmentId })
const cell = (datasetValueId: number): CodeSetTarget => ({ kind: 'text', datasetValueId })
const keyOf = (t: CodeSetTarget) =>
  t.kind === 'segment' ? `s${t.segmentId}` : `c${t.datasetValueId}`

type Details = Record<string, SelectionDetail[]>

interface Exposed {
  history: ReturnType<typeof useHistory>
  setTarget: (t: CodeSetTarget | null) => void
  setDetails: (d: Details) => void
  /** A state setter: pass `() => fn` to store a function. */
  setOnSettled: (next: () => ((saved: boolean) => void) | undefined) => void
  setMounted: (m: boolean) => void
}
let ui!: Exposed

/** A host in miniature: its own stack, a selection that moves, a refresh. */
function Host(props: {
  target: CodeSetTarget | null
  details: Details
  onSettled?: (saved: boolean) => void
  withHistory: boolean
  codes?: typeof LIVE
}) {
  const history = useHistory()
  const [target, setTarget] = useState(props.target)
  const [details, setDetails] = useState(props.details)
  const [onSettled, setOnSettled] = useState(() => props.onSettled)
  const [mounted, setMounted] = useState(true)
  // After every commit — `useHistory` returns a new object each render, so this
  // runs every time — so `ui.history.canUndo` is the rendered value; `act`
  // flushes effects before it returns.
  useEffect(() => {
    ui = { history, setTarget, setDetails, setOnSettled, setMounted }
  }, [history])
  if (!mounted) return null
  return (
    <CodeSetStrip
      projectId={1}
      target={target}
      appliedCodeDetails={target ? details[keyOf(target)] : undefined}
      activeCoderId={SELF}
      codes={props.codes ?? LIVE}
      history={props.withHistory ? history : null}
      onSettled={onSettled}
    />
  )
}

async function mount(opts: {
  target: CodeSetTarget
  details?: Details
  onSettled?: (saved: boolean) => void
  withHistory?: boolean
  codes?: typeof LIVE
}) {
  // The app's own default (`main.tsx`), so a mutation that forgets to declare
  // `onError` shows up here as a second toast.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { onError: () => api.toastError('Something went wrong. Please try again.') },
    },
  })
  render(
    <QueryClientProvider client={qc}>
      <Host
        target={opts.target}
        details={opts.details ?? {}}
        onSettled={opts.onSettled}
        withHistory={opts.withHistory ?? true}
        codes={opts.codes}
      />
    </QueryClientProvider>,
  )
  await screen.findByRole('radiogroup', { name: 'Stance' })
}

/** TanStack starts a mutation's request a turn AFTER `mutate` (#1037's lesson). */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const press = async (name: string) => {
  fireEvent.click(screen.getByRole('radio', { name }))
  await flush()
}
const undo = () => act(async () => { await ui.history.undo() })
const redo = () => act(async () => { await ui.history.redo() })
const moveTo = (t: CodeSetTarget | null) => act(() => { ui.setTarget(t) })

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  api.listSets.mockResolvedValue({ sets: [STANCE] })
  api.selectOnSegment.mockResolvedValue({})
  api.selectOnText.mockResolvedValue({})
  api.rateSegment.mockResolvedValue({})
  api.rateText.mockResolvedValue({})
  api.applySegment.mockResolvedValue({})
  api.applyText.mockResolvedValue({})
})

describe('the entry acts on the passage the choice was MADE on (#1023)', () => {
  it('undo, after moving to another passage, writes the ORIGINAL passage', async () => {
    await mount({ target: seg(1), details: { s1: [held(11)], s2: [held(23)] } })
    await press('Negative')
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 23)

    await moveTo(seg(2))
    await undo()
    // The audit's observation was `(2, 7, null)`: segment 2's Negative cleared
    // and segment 1 left holding the choice.
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 11)
    expect(api.selectOnSegment.mock.calls.some(([id]) => id === 2)).toBe(false)
  })

  it('redo, after moving again, writes the original passage too', async () => {
    await mount({ target: seg(1), details: { s1: [held(11)] } })
    await press('Negative')
    await moveTo(seg(2))
    await undo()
    await moveTo(seg(3))
    await redo()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 23)
    expect(api.selectOnSegment.mock.calls.map(([id]) => id)).toEqual([1, 1, 1])
  })

  it('with SEVERAL passages selected (no target), the undo still has one', async () => {
    // It used to throw "no target" — a non-refusal, so the entry stayed on the
    // stack and every later Ctrl+Z failed on it: #874's parked pointer again.
    await mount({ target: seg(1), details: { s1: [held(11)] } })
    await press('Neutral')
    await moveTo(null)
    await undo()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 11)
    expect(ui.history.canRedo).toBe(true)
  })

  it('survives the strip unmounting (a collapsed panel, another source)', async () => {
    await mount({ target: seg(1), details: { s1: [held(11)] } })
    await press('Negative')
    await act(() => { ui.setMounted(false) })
    await undo()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 11)
  })

  it('the Text Coding arm keys on the CELL the choice was made on', async () => {
    await mount({ target: cell(101), details: { c101: [held(11)], c202: [held(47)] } })
    await press('Negative')
    expect(api.selectOnText).toHaveBeenLastCalledWith(1, 7, 101, 23)
    await moveTo(cell(202))
    await undo()
    expect(api.selectOnText).toHaveBeenLastCalledWith(1, 7, 101, 11)
    expect(api.selectOnSegment).not.toHaveBeenCalled()
  })

  it('refreshes the source the choice was made in, not the one open at undo time', async () => {
    // The workbenches stay mounted across prev/next-source navigation, so the
    // stack outlives the source; a refresh read at replay invalidated the NEW
    // source's cache and left the changed one stale.
    const atAct = vi.fn()
    const later = vi.fn()
    await mount({ target: seg(1), details: { s1: [held(11)] }, onSettled: atAct })
    await press('Negative')
    await waitFor(() => expect(atAct).toHaveBeenCalledWith(true))
    await act(() => { ui.setOnSettled(() => later) })
    await moveTo(seg(2))
    await undo()
    expect(atAct).toHaveBeenCalledTimes(2)
    expect(later).not.toHaveBeenCalled()
  })
})

describe('undo puts back the RATING the swap deleted (#1023, #868 f)', () => {
  it('re-rates the value it restores — and 0 is a rating', async () => {
    await mount({ target: seg(1), details: { s1: [held(11, 0)] } })
    await press('Negative')
    expect(api.rateSegment).not.toHaveBeenCalled()
    await moveTo(seg(2))
    await undo()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 11)
    expect(api.rateSegment).toHaveBeenCalledWith(1, 11, 0)
    // Selected FIRST, rated second: the rating endpoint edits an application,
    // so it must exist.
    const selects = api.selectOnSegment.mock.invocationCallOrder
    expect(selects[selects.length - 1]).toBeLessThan(api.rateSegment.mock.invocationCallOrder[0])
  })

  it('an undo of a CLEAR re-rates too', async () => {
    await mount({ target: seg(1), details: { s1: [held(11, 4)] } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'None of these for Stance' }))
    })
    await flush()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, null)
    await undo()
    expect(api.rateSegment).toHaveBeenCalledWith(1, 11, 4)
  })

  it('re-rates on the Text Coding arm through its own endpoint', async () => {
    await mount({ target: cell(101), details: { c101: [held(11, 2)] } })
    await press('Neutral')
    await moveTo(cell(202))
    await undo()
    expect(api.rateText).toHaveBeenCalledWith(1, { dataset_value_id: 101, code_id: 11, magnitude: 2 })
    expect(api.rateSegment).not.toHaveBeenCalled()
  })

  it('makes no rating call when the previous value was unrated, nor on a redo', async () => {
    await mount({ target: seg(1), details: { s1: [held(11, null)] } })
    await press('Negative')
    await undo()
    await redo()
    expect(api.rateSegment).not.toHaveBeenCalled()
  })

  it('ignores a COLLEAGUE’s rating on the same value', async () => {
    const colleague: SelectionDetail = { code_id: 11, user_id: 9, magnitude: 5 }
    await mount({ target: seg(1), details: { s1: [colleague, held(11, null)] } })
    await press('Negative')
    await undo()
    expect(api.rateSegment).not.toHaveBeenCalled()
  })

  it('a REFUSED re-rating still completes the undo, and says which half failed', async () => {
    // The value IS back; only the rating could not follow (its scale changed
    // since). Dropping the entry as "can no longer be reversed" would be false.
    api.rateSegment.mockRejectedValue(new ApiError(422, { detail: 'That rating is outside the scale.' }, {}))
    await mount({ target: seg(1), details: { s1: [held(11, 3)] } })
    await press('Negative')
    await undo()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 11)
    expect(api.toastWarning).toHaveBeenCalledTimes(1)
    expect(api.toastWarning.mock.calls[0][0]).toMatch(/“Positive” is back, but its rating \(3\) could not be restored/)
    expect(api.toastWarning.mock.calls[0][1]).toEqual({ description: 'That rating is outside the scale.' })
    expect(api.toastError).not.toHaveBeenCalled()
    expect(ui.history.canUndo).toBe(false)
    expect(ui.history.canRedo).toBe(true)
  })

  it('a TRANSIENT re-rating failure keeps the step for a retry', async () => {
    const settled = vi.fn()
    api.rateSegment.mockRejectedValue(new Error('network down'))
    await mount({ target: seg(1), details: { s1: [held(11, 3)] }, onSettled: settled })
    await press('Negative')
    await undo()
    expect(ui.history.canUndo).toBe(true)
    expect(api.toastWarning).not.toHaveBeenCalled()
    expect(api.toastError).toHaveBeenCalledTimes(1)
    // The select half landed, so the host still refreshes — told it failed.
    expect(settled).toHaveBeenLastCalledWith(false)
  })
})

describe('a failure is reported ONCE, in the server’s words', () => {
  const refusal = () =>
    new ApiError(400, { detail: 'That code is not a value of “Stance”.' }, {})

  it('on a workbench: by the history, not also by the strip or the app default', async () => {
    api.selectOnSegment.mockRejectedValue(refusal())
    await mount({ target: seg(1), details: { s1: [] } })
    await press('Negative')
    await waitFor(() => expect(api.toastError).toHaveBeenCalled())
    await flush()
    expect(api.toastError).toHaveBeenCalledTimes(1)
    expect(api.toastError).toHaveBeenCalledWith('That code is not a value of “Stance”.')
    expect(ui.history.canUndo).toBe(false)
  })

  it('with no stack (`history={null}`): by the strip, once', async () => {
    api.selectOnSegment.mockRejectedValue(refusal())
    await mount({ target: seg(1), details: { s1: [] }, withHistory: false })
    await press('Negative')
    await waitFor(() => expect(api.toastError).toHaveBeenCalled())
    await flush()
    expect(api.toastError).toHaveBeenCalledTimes(1)
    expect(api.toastError).toHaveBeenCalledWith('That code is not a value of “Stance”.')
  })

  it('with no stack, a success writes directly and records nothing', async () => {
    await mount({ target: seg(1), details: { s1: [] }, withHistory: false })
    await press('Positive')
    expect(api.selectOnSegment).toHaveBeenCalledWith(1, 7, 11)
    expect(ui.history.canUndo).toBe(false)
  })
})

describe('while a choice is being saved', () => {
  it('stays focused and ignores a second press (#1041)', async () => {
    let finish!: () => void
    api.selectOnSegment.mockImplementation(() => new Promise<void>((r) => { finish = r }))
    await mount({ target: seg(1), details: { s1: [] } })
    const negative = screen.getByRole('radio', { name: 'Negative' })
    negative.focus()
    fireEvent.click(negative)
    // The press queues behind the history chain, then TanStack starts the
    // request a turn later and batches the re-render — so wait for it.
    await waitFor(() => expect(negative).toHaveAttribute('aria-disabled', 'true'))
    expect(negative).not.toHaveAttribute('disabled')
    expect(negative).toHaveFocus()

    fireEvent.click(screen.getByRole('radio', { name: 'Neutral' }))
    await flush()
    expect(api.selectOnSegment).toHaveBeenCalledTimes(1)

    await act(async () => { finish() })
    await flush()
    expect(negative).not.toHaveAttribute('aria-disabled')
  })
})

describe('the hosts pass their STACK, not a copy of the builder', () => {
  function mounts(): { file: string; tag: string }[] {
    const out: { file: string; tag: string }[] = []
    for (const abs of sourceFiles({ root: 'pages', ext: 'tsx', floor: 10, recursive: false })) {
      const name = basename(abs)
      const src = stripComments(readFileSync(abs, 'utf-8'), name)
      for (const m of src.matchAll(/<CodeSetStrip\b[\s\S]*?\/>/g)) out.push({ file: name, tag: m[0] })
    }
    return out
  }

  it('finds the four coding surfaces it exists to check', () => {
    expect(mounts().map((m) => m.file).sort()).toEqual([
      'CodingWorkbench.tsx', 'DocumentCodingWorkbench.tsx', 'ObservationWorkbench.tsx',
      'TextCodingView.tsx',
    ])
  })

  it('every one passes its own useHistory — so every one can undo, and none rebuilds the entry', () => {
    for (const { file, tag } of mounts()) {
      expect(tag, `${file}: pass the page's stack`).toMatch(/\bhistory=\{history\}/)
      expect(tag, `${file}: the entry is built inside the strip (#1023)`).not.toMatch(/history\.execute|onCommit/)
    }
  })

  it('the scan can tell a null stack from the real one (falsifier)', () => {
    expect(/\bhistory=\{history\}/.test('<CodeSetStrip history={null} />')).toBe(false)
  })
})

describe('a RADIO has no de-select gesture (#1038 e)', () => {
  it('pressing the checked value writes nothing and records nothing', async () => {
    await mount({ target: seg(1), details: { s1: [held(11)] } })
    await press('Positive')
    expect(api.selectOnSegment).not.toHaveBeenCalled()
    expect(ui.history.canUndo).toBe(false)
  })

  it('in a contradiction, pressing one of the two values CHOOSES it — never clears both', async () => {
    await mount({ target: seg(1), details: { s1: [held(11), held(23)] } })
    await press('Positive')
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 11)
    expect(api.selectOnSegment).not.toHaveBeenCalledWith(1, 7, null)
  })

  it('clearing is the named control’s act', async () => {
    await mount({ target: seg(1), details: { s1: [held(47)] } })
    fireEvent.click(screen.getByRole('button', { name: 'None of these for Stance' }))
    await flush()
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, null)
  })
})

describe('a SYNONYM grouped into a value (#1028 b)', () => {
  const WITH_SYNONYM: CodeSet = {
    ...STANCE, claimants: [...STANCE.claimants, { code_id: 90, value_id: 11 }],
  }

  it('shows the value it counts as, checked', async () => {
    api.listSets.mockResolvedValue({ sets: [WITH_SYNONYM] })
    await mount({ target: seg(1), details: { s1: [held(90)] } })
    expect(screen.getByRole('radio', { name: 'Positive' })).toHaveAttribute('aria-checked', 'true')
  })

  it('an undo puts the SYNONYM back — through the ordinary apply, which the set’s endpoint refuses', async () => {
    api.listSets.mockResolvedValue({ sets: [WITH_SYNONYM] })
    await mount({ target: seg(1), details: { s1: [held(90, 0)] } })
    await press('Negative')
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(1, 7, 23)
    await undo()
    expect(api.applySegment).toHaveBeenCalledWith(1, 90)
    expect(api.selectOnSegment).not.toHaveBeenCalledWith(1, 7, 90)
    // …with its rating, and 0 is one.
    expect(api.rateSegment).toHaveBeenCalledWith(1, 90, 0)
  })
})

describe('the values come from the LIVE codes list (#1038 b)', () => {
  it('a value renamed elsewhere shows its new name; one deactivated is not offered', async () => {
    const codes = LIVE.map((c) =>
      c.id === 11 ? { ...c, name: 'Favourable' } : c.id === 23 ? { ...c, is_active: false } : c)
    await mount({ target: seg(1), details: { s1: [] }, codes })
    expect(screen.getByRole('radio', { name: 'Favourable' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Positive' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Negative' })).toBeNull()
  })

  it('a value deleted or merged away is not offered either', async () => {
    await mount({ target: seg(1), details: { s1: [] }, codes: LIVE.filter((c) => c.id !== 47) })
    expect(screen.queryByRole('radio', { name: 'Neutral' })).toBeNull()
  })
})
